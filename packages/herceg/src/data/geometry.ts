// Geometry columns: polygons and multipolygons in longitude and latitude.
//
// Shapes are packed the way GeoArrow nests multipolygons: one array of
// coordinates and three arrays of offsets, with no object per vertex, ring,
// or shape. A geometry column holds, per row, a code into such a set (-1
// for none), as a category column holds codes into its dictionary, so a
// table moves, drops, filters, and copies 4 bytes per row and never the
// coordinates, and derived tables share their source's shapes.

import type { GeometryColumn } from "./column.ts";

/**
 * Polygons in longitude and latitude (degrees, WGS 84), packed. Geometry
 * `g` is the polygons `geometryOffsets[g]` to `geometryOffsets[g + 1]`;
 * polygon `p` the rings `polygonOffsets[p]` to `polygonOffsets[p + 1]`,
 * its exterior first, then its holes; ring `r` the coordinate pairs
 * `ringOffsets[r]` to `ringOffsets[r + 1]`. Edges are straight lines in
 * longitude and latitude, as GeoJSON defines them. A geometry with no
 * polygons is empty.
 *
 * The arrays are used in place and must not change afterwards.
 */
export interface GeometrySet {
  /** Longitude, latitude pairs. */
  readonly coordinates: Float64Array;
  /** Rings: offsets into coordinate pairs, one more than there are rings. */
  readonly ringOffsets: Int32Array;
  /** Polygons: offsets into rings, one more than there are polygons. */
  readonly polygonOffsets: Int32Array;
  /** Geometries: offsets into polygons, one more than there are geometries. */
  readonly geometryOffsets: Int32Array;
}

/** A geometry column as `table()` takes it (see `geometry`). */
export interface GeometryInput {
  readonly kind: "geometry";
  readonly set: GeometrySet;
  /** Each row's geometry; without it, row i holds geometry i. */
  readonly codes: Int32Array | undefined;
  /** Builds the column; tables call it, so a line chart need not bundle this module. */
  column(): GeometryColumn;
}

/**
 * A geometry column: each row's shape from `set`, by `codes` (-1 for none),
 * or row i's from geometry i. The set is checked once here: offsets that
 * start at 0, never decrease, and end at the next array's length, and
 * coordinates that are longitudes and latitudes.
 */
export function geometry(set: GeometrySet, codes?: Int32Array): GeometryInput {
  checkGeometry(set);
  return geometryOf(set, codes);
}

/** A geometry column over a set already checked, such as one a table holds. */
export function geometryOf(set: GeometrySet, codes?: Int32Array): GeometryInput {
  const count = set.geometryOffsets.length - 1;
  if (codes) checkCodes(codes, count);
  return {
    kind: "geometry",
    set,
    codes,
    column: () => ({
      kind: "geometry",
      buffer: codes ?? Int32Array.from({ length: count }, (_, i) => i),
      // Codes the caller passed are copied before the table writes to them.
      owned: !codes,
      set,
      check: (values) => checkCodes(values, count),
    }),
  };
}

/** Bytes of a set's arrays, which tables sharing it hold once. */
export function geometryBytes(set: GeometrySet): number {
  return (
    set.coordinates.byteLength +
    set.ringOffsets.byteLength +
    set.polygonOffsets.byteLength +
    set.geometryOffsets.byteLength
  );
}

/** Throws a RangeError unless every value is a whole number from -1 to `count` - 1. */
function checkCodes(values: ArrayLike<unknown>, count: number): void {
  for (let i = 0; i < values.length; i++) {
    const code = values[i];
    if (!(Number.isInteger(code) && (code as number) >= -1 && (code as number) < count))
      throw new RangeError(
        `Geometry code ${String(code)} at row ${i} is not a geometry of the set (0 to ${count - 1}, or -1 for none)`,
      );
  }
}

function checkOffsets(offsets: Int32Array, end: number, what: string, of: string): void {
  if (!(offsets instanceof Int32Array)) throw new TypeError(`${what} must be an Int32Array`);
  if (offsets.length === 0 || offsets[0] !== 0)
    throw new RangeError(`${what} must start at 0 and have one more entry than there are ${of}`);
  for (let i = 1; i < offsets.length; i++) {
    if (offsets[i]! < offsets[i - 1]!)
      throw new RangeError(`${what} decrease at entry ${i} (${offsets[i - 1]} to ${offsets[i]})`);
  }
  if (offsets[offsets.length - 1] !== end)
    throw new RangeError(`${what} end at ${offsets[offsets.length - 1]}, not at ${end}`);
}

/**
 * Checks a set's structure and coordinates. Longitudes may run past ±180
 * (shapes drawn across the antimeridian as one piece), but by no more than
 * a turn, and latitudes lie within ±90: coordinates beyond them are almost
 * always in a projected reference system rather than degrees.
 */
export function checkGeometry(set: GeometrySet): void {
  const { coordinates, ringOffsets, polygonOffsets, geometryOffsets } = set;
  if (!(coordinates instanceof Float64Array))
    throw new TypeError("Geometry coordinates must be a Float64Array");
  if (coordinates.length % 2 !== 0)
    throw new RangeError("Geometry coordinates must be longitude, latitude pairs");
  checkOffsets(ringOffsets, coordinates.length / 2, "Ring offsets", "rings");
  checkOffsets(polygonOffsets, ringOffsets.length - 1, "Polygon offsets", "polygons");
  checkOffsets(geometryOffsets, polygonOffsets.length - 1, "Geometry offsets", "geometries");
  for (let r = 0; r + 1 < ringOffsets.length; r++) {
    let west = Infinity;
    let east = -Infinity;
    for (let i = ringOffsets[r]!; i < ringOffsets[r + 1]!; i++) {
      const lon = coordinates[i * 2]!;
      const lat = coordinates[i * 2 + 1]!;
      if (!(Math.abs(lon) <= 540 && Math.abs(lat) <= 90))
        throw new RangeError(
          `Geometry coordinate ${i} (${lon}, ${lat}) is not a longitude and latitude in degrees; reproject the data to WGS 84 (EPSG:4326)`,
        );
      west = Math.min(west, lon);
      east = Math.max(east, lon);
    }
    if (east - west > 360)
      throw new RangeError(
        `Ring ${r} spans ${east - west} degrees of longitude; a ring spans at most 360`,
      );
  }
}
