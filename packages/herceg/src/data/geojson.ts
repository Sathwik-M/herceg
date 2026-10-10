// GeoJSON to columns: a feature collection becomes a table with a row per
// feature, its shapes packed into one geometry column (or, for points, a
// longitude and a latitude column) and each property a column of its own.

import type { ColumnInput } from "./column.ts";
import { category } from "./column.ts";
import { geometry } from "./geometry.ts";
import { Table, type TableOptions } from "./table.ts";

/** The parts of GeoJSON (RFC 7946) a feature collection is read for. */
export interface FeatureCollection {
  type: "FeatureCollection";
  features: readonly Feature[];
}

export interface Feature {
  type: "Feature";
  id?: string | number;
  geometry: GeoJsonGeometry | null;
  properties: Record<string, unknown> | null;
}

export type GeoJsonGeometry =
  | { type: "Polygon"; coordinates: readonly (readonly (readonly number[])[])[] }
  | { type: "MultiPolygon"; coordinates: readonly (readonly (readonly (readonly number[])[])[])[] }
  | { type: "Point"; coordinates: readonly number[] }
  | { type: string; coordinates?: unknown };

export interface GeoJsonOptions extends TableOptions {
  /** The field of the features' shapes; "geometry" by default. */
  geometry?: string;
  /** The field of the features' ids, when they have them; "id" by default. */
  id?: string;
}

/**
 * A table of a feature collection's features. Polygons and multipolygons
 * become a geometry field (`geometry`), points a `longitude` and a
 * `latitude` field; features without a geometry have none. Feature ids
 * become a category field (`id`), and each property a field: numbers and
 * booleans a number field, strings a category field, a mix of the two a
 * category field of their text. Properties holding objects or arrays are
 * left out. A collection mixing polygons and points, or holding other kinds
 * of geometry, is refused with the feature at fault.
 *
 * ```ts
 * const countries = fromGeoJSON(await (await fetch("countries.geojson")).json());
 * geoshape(countries, { labelField: "name", color: "pop_est" });
 * ```
 */
export function fromGeoJSON(collection: FeatureCollection, options: GeoJsonOptions = {}): Table {
  if (collection?.type !== "FeatureCollection" || !Array.isArray(collection.features))
    throw new TypeError(
      'fromGeoJSON needs a GeoJSON FeatureCollection ({ type: "FeatureCollection", features })',
    );
  const { geometry: geometryField = "geometry", id: idField = "id", ...tableOptions } = options;
  const features = collection.features;
  // Polygons or points: the first feature with a geometry decides.
  let kind: "shapes" | "points" | undefined;
  features.forEach((feature, i) => {
    const type = feature?.geometry?.type;
    if (type === undefined || type === null) return;
    const found =
      type === "Polygon" || type === "MultiPolygon"
        ? "shapes"
        : type === "Point"
          ? "points"
          : undefined;
    if (!found)
      throw new TypeError(
        `Feature ${i} is a ${type}; fromGeoJSON reads polygons, multipolygons, or points`,
      );
    kind ??= found;
    if (found !== kind)
      throw new TypeError(
        `Feature ${i} is a ${type}, but earlier features are ${kind === "shapes" ? "polygons" : "points"}; split the collection by kind of geometry`,
      );
  });
  const columns: Record<string, ColumnInput> = Object.create(null);
  if (kind === "points") {
    const longitude = new Float64Array(features.length).fill(Number.NaN);
    const latitude = new Float64Array(features.length).fill(Number.NaN);
    features.forEach((feature, i) => {
      if (!feature.geometry) return;
      const [x, y] = position(feature.geometry.coordinates, `Feature ${i}`);
      longitude[i] = x;
      latitude[i] = y;
    });
    columns.longitude = longitude;
    columns.latitude = latitude;
  } else {
    columns[geometryField] = geometry(packShapes(features));
  }
  if (features.some((feature) => feature.id !== undefined && feature.id !== null)) {
    if (idField in columns) throw collision(idField);
    columns[idField] = category(features.map((f) => (f.id == null ? null : String(f.id))));
  }
  for (const [name, values] of properties(features)) {
    if (name in columns) throw collision(name);
    columns[name] = values;
  }
  return new Table(columns, tableOptions);
}

function collision(name: string): TypeError {
  return new TypeError(
    `A property is named "${name}" like the field fromGeoJSON makes for the features' ${name === "longitude" || name === "latitude" ? "points" : "shapes or ids"}; pass a different name in the options (geometry, id)`,
  );
}

/** A position's longitude and latitude; positions may carry an altitude, which is ignored. */
function position(value: unknown, where: string): [number, number] {
  if (
    !Array.isArray(value) ||
    value.length < 2 ||
    typeof value[0] !== "number" ||
    typeof value[1] !== "number" ||
    !Number.isFinite(value[0]) ||
    !Number.isFinite(value[1])
  )
    throw new TypeError(
      `${where} has a position that is not [longitude, latitude]: ${JSON.stringify(value)?.slice(0, 60)}`,
    );
  return [value[0], value[1]];
}

/** The polygons of every feature, packed; a feature without a geometry has none. */
function packShapes(features: readonly Feature[]) {
  const coordinates: number[] = [];
  const ringOffsets = [0];
  const polygonOffsets = [0];
  const geometryOffsets = [0];
  features.forEach((feature, i) => {
    const shape = feature?.geometry;
    if (shape) {
      const where = `Feature ${i}`;
      const polygons = shape.type === "Polygon" ? [shape.coordinates] : shape.coordinates;
      if (!Array.isArray(polygons)) throw new TypeError(`${where} has no coordinates`);
      for (const polygon of polygons as unknown[]) {
        if (!Array.isArray(polygon))
          throw new TypeError(`${where} has a polygon that is not a list of rings`);
        for (const ring of polygon as unknown[]) {
          if (!Array.isArray(ring))
            throw new TypeError(`${where} has a ring that is not a list of positions`);
          for (const point of ring) coordinates.push(...position(point, where));
          ringOffsets.push(coordinates.length / 2);
        }
        polygonOffsets.push(ringOffsets.length - 1);
      }
    }
    geometryOffsets.push(polygonOffsets.length - 1);
  });
  return {
    coordinates: Float64Array.from(coordinates),
    ringOffsets: Int32Array.from(ringOffsets),
    polygonOffsets: Int32Array.from(polygonOffsets),
    geometryOffsets: Int32Array.from(geometryOffsets),
  };
}

/** Each property as a column, in order of first appearance, typed by all of its values. */
function properties(features: readonly Feature[]): Map<string, ColumnInput> {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const feature of features) {
    for (const name of Object.keys(feature?.properties ?? {})) {
      if (seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
  }
  const out = new Map<string, ColumnInput>();
  for (const name of names) {
    const values = features.map((feature) => feature?.properties?.[name] ?? null);
    let numbers = true;
    let usable = true;
    for (const value of values) {
      if (value === null) continue;
      const type = typeof value;
      if (type !== "number" && type !== "boolean") numbers = false;
      if (type !== "number" && type !== "boolean" && type !== "string") usable = false;
    }
    if (!usable) continue;
    if (numbers)
      out.set(
        name,
        Float64Array.from(values, (v) => (v === null ? Number.NaN : Number(v))),
      );
    else out.set(name, category(values.map((v) => (v === null ? null : String(v)))));
  }
  return out;
}
