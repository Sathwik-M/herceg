// Regions of a map: each row's shape from a geometry field, filled by a
// number field on a continuous scale (a choropleth), by a category field
// with a palette color per value, or with one fill.

import type { FieldKind } from "../data/column.ts";
import type { CategoryField, GeometryField, NumberField, Schema, Table } from "../data/table.ts";
import { polygonPath, polygonsDrawing } from "../draw/polygons.ts";
import { formatNumber } from "../format/format.ts";
import type { GeoExtent, PixelShape } from "../geo/project.ts";
import { extendExtent } from "../geo/project.ts";
import { anchorOf, ShapeIndex } from "../geo/shape-index.ts";
import { boxOfCodes, pixelShape } from "../geo/shapes.ts";
import { ItemViews } from "../model/item-views.ts";
import type { LegendEntry } from "../model/legend.ts";
import type { ChartConfig } from "../model/model.ts";
import { checkColorScale, checkRamp, rampOf, SequentialScale } from "../scale/color.ts";
import type { PolygonGeometry } from "../scene/scene.ts";
import type { Frozen, GeoShapeSpec } from "../spec/spec.ts";
import { surface, type Theme } from "../theme.ts";
import { type GeoLayer, joinLayers, type MapFrame } from "./geo.ts";
import type { LayoutFrame, LayoutItem, LayoutMark, LayoutResult } from "./layout-mark.ts";
import { definedFields } from "./line.ts";
import {
  type ChartMark,
  type ColorRamp,
  frozen,
  type GlyphKey,
  type MARK,
  requireField,
} from "./mark.ts";

export interface GeoShapeOptions<S extends Schema> {
  /** The geometry field; the table's only one by default. */
  geometry?: GeometryField<S>;
  /** Category field naming each region, for tooltips, keyboard reading, and the summary. */
  name?: CategoryField<S>;
  /**
   * A number field colored on a continuous scale (a choropleth, with a
   * color legend), or a category field with a palette color per value
   * (with a legend whose entries gray their regions out).
   */
  color?: NumberField<S> | CategoryField<S>;
  /**
   * Colors for a number `color`, low to high, such as an imported scheme
   * (`viridis`, `rdbu`, ...). Defaults to the theme's sequential ramp, or
   * its diverging one with a midpoint.
   */
  colors?: readonly string[];
  /** The values at the ends of the color ramp; the field's extent by default. */
  colorDomain?: readonly [number, number];
  /** The value at the ramp's middle, for diverging ramps. */
  colorMidpoint?: number;
  /** The fill without `color`, and of regions without a value; the theme's grid color by default. */
  fill?: string;
  /** Default 1. */
  fillOpacity?: number;
  /** Border color; the chart's background by default. */
  stroke?: string;
  /** Border width in pixels; default 0.75, 0 for none. */
  strokeWidth?: number;
  /** What the regions are, in tooltips without `color`. */
  label?: string;
  id?: string;
}

const STROKE_WIDTH = 0.75;
/** Categories a summary lists before saying how many more there are. */
const LISTED = 8;

/** One draw's regions: the rows drawn, in order, and their shapes and fills. */
interface Drawn {
  rows: number[];
  shapes: PixelShape[];
  colorIndex: Uint32Array;
  colors: string[];
}

export class GeoShapeMark implements GeoLayer {
  declare readonly [MARK]: true;
  readonly layout = true;
  readonly views = ItemViews;
  readonly geo = true;
  readonly spec: Frozen<GeoShapeSpec>;
  readonly table: Table;
  readonly measure: string;
  readonly reach: number;
  /** The geometry field. */
  readonly field: string;
  /** How `color` colors regions: by number, by category, or not at all. */
  readonly #colorKind: FieldKind | undefined;

  constructor(input: GeoShapeSpec, table: Table) {
    this.spec = frozen(input);
    // Read from the copy: the caller may change what it passed.
    const spec = this.spec;
    const geometries = table.fields().filter((field) => table.kind(field) === "geometry");
    const field = spec.geometry ?? (geometries.length === 1 ? geometries[0] : undefined);
    if (field === undefined)
      throw new Error(
        geometries.length === 0
          ? "geoshape needs a table with a geometry field (see fromGeoJSON and geometry)"
          : `geoshape needs \`geometry\`: the table has ${geometries.map((f) => `"${f}"`).join(", ")}`,
      );
    requireField(table, field, ["geometry"], "geoshape geometry");
    if (spec.name !== undefined) requireField(table, spec.name, ["category"], "geoshape name");
    if (spec.color !== undefined)
      requireField(table, spec.color, ["number", "category"], "geoshape color");
    this.#colorKind = spec.color === undefined ? undefined : table.kind(spec.color);
    const numeric = this.#colorKind === "number";
    if (!numeric && (spec.colors || spec.colorDomain || spec.colorMidpoint !== undefined))
      throw new Error(
        "geoshape colors, colorDomain, and colorMidpoint are for a number color field",
      );
    if (Array.isArray(spec.colors)) checkRamp(spec.colors, "geoshape colors");
    checkColorScale(spec.colorDomain, spec.colorMidpoint, "Geoshape");
    if (spec.fillOpacity !== undefined && !(spec.fillOpacity >= 0 && spec.fillOpacity <= 1))
      throw new RangeError(`geoshape fillOpacity must be from 0 to 1, not ${spec.fillOpacity}`);
    const width = spec.strokeWidth ?? STROKE_WIDTH;
    if (!(width >= 0 && Number.isFinite(width)))
      throw new RangeError(`geoshape strokeWidth must be 0 or more pixels, not ${width}`);
    this.table = table;
    this.field = field;
    this.measure = spec.color ?? spec.label ?? "Region";
    this.reach = width / 2;
  }

  join(marks: readonly LayoutMark[], config: ChartConfig): LayoutMark {
    return joinLayers(marks, config.projection);
  }

  /** Charts draw maps' layers through `join`; drawn alone, a layer takes the default projection. */
  draw(frame: LayoutFrame): LayoutResult {
    return joinLayers([this], undefined).draw(frame);
  }

  /** The continuous scale of a number `color`, with the current data. */
  #scale(theme: Theme): SequentialScale | undefined {
    const { spec } = this;
    if (this.#colorKind !== "number") return undefined;
    const domain = spec.colorDomain ?? this.table.extent(spec.color as never);
    if (!domain) return undefined;
    const fallback = spec.colorMidpoint === undefined ? theme.sequential : theme.diverging;
    return new SequentialScale(domain, rampOf(spec.colors, fallback), spec.colorMidpoint);
  }

  /** The categories of a category `color` that rows hold, in dictionary order. */
  #categories(): string[] {
    if (this.#colorKind !== "category") return [];
    const { codes, dictionary } = this.table.categories(this.spec.color as never);
    const present = new Uint8Array(dictionary.length);
    for (const code of codes) if (code >= 0) present[code] = 1;
    return dictionary.filter((_, code) => present[code]);
  }

  legend(id: string | number, color: (key: string) => string): LegendEntry[] {
    return this.#categories().map((category) => {
      const key = categoryKey(id, category);
      return { key, label: category, color: color(key) };
    });
  }

  scales(theme: Theme): [ColorRamp[], GlyphKey[]] {
    const scale = this.#scale(theme);
    if (!scale) return [[], []];
    const { domain, midpoint } = scale;
    return [[{ stops: scale.legendStops(), domain, midpoint, title: this.spec.color! }], []];
  }

  extent(into: GeoExtent): void {
    const { codes, set } = this.table.geometries(this.field);
    const { coordinates, ringOffsets, polygonOffsets, geometryOffsets } = set;
    const seen = new Uint8Array(geometryOffsets.length - 1);
    for (const g of codes) {
      if (g < 0 || seen[g]) continue;
      seen[g] = 1;
      const first = ringOffsets[polygonOffsets[geometryOffsets[g]!]!]!;
      const last = ringOffsets[polygonOffsets[geometryOffsets[g + 1]!]!]!;
      for (let i = first; i < last; i++)
        extendExtent(into, coordinates[i * 2]!, coordinates[i * 2 + 1]!);
    }
  }

  box(plan: MapFrame["plan"]): Float64Array | undefined {
    const { codes, set } = this.table.geometries(this.field);
    return boxOfCodes(set, codes, plan);
  }

  place(frame: MapFrame): LayoutResult {
    const { theme, hidden, locale, plan, transform, bounds } = frame;
    const id = frame.id;
    const { spec, table } = this;
    const { codes, set } = table.geometries(this.field);
    const noData = spec.fill ?? theme.grid;
    const scale = this.#scale(theme);
    const values = this.#colorKind === "number" ? table.numbers(spec.color as never) : undefined;
    const categories =
      this.#colorKind === "category" ? table.categories(spec.color as never) : undefined;
    // Fill colors: the ramp's, or one per category, and the fill for no value.
    const colors: string[] = [noData];
    const ramp = scale && values ? scale.colors() : undefined;
    if (ramp) colors.push(...ramp);
    const categoryColor = categories
      ? Int32Array.from(categories.dictionary, (category) => {
          const key = categoryKey(id, category);
          if (hidden.has(key)) return 0;
          colors.push(frame.color(key));
          return colors.length - 1;
        })
      : undefined;
    const drawn: Drawn = { rows: [], shapes: [], colorIndex: new Uint32Array(0), colors };
    const fills: number[] = [];
    for (let row = 0; row < codes.length; row++) {
      const g = codes[row]!;
      if (g < 0) continue;
      const shape = pixelShape(set, g, plan, transform);
      const { box } = shape;
      // Shapes cut away, or wholly outside the room, are neither drawn nor read.
      if (shape.rings.length < 2 || box[2]! < bounds.x || box[0]! > bounds.x + bounds.width)
        continue;
      if (box[3]! < bounds.y || box[1]! > bounds.y + bounds.height) continue;
      let fill = 0;
      if (ramp) {
        const index = scale!.index(values![row]!);
        fill = index < 0 ? 0 : index + 1;
      } else if (categoryColor) {
        const code = categories!.codes[row]!;
        fill = code < 0 ? 0 : categoryColor[code]!;
      }
      drawn.rows.push(row);
      drawn.shapes.push(shape);
      fills.push(fill);
    }
    drawn.colorIndex = Uint32Array.from(fills);
    const geometry: PolygonGeometry = {
      kind: "polygons",
      draw: polygonsDrawing,
      key: `geoshape-${JSON.stringify(id)}`,
      shapes: drawn.shapes,
      colors,
      colorIndex: drawn.colorIndex,
      fillOpacity: spec.fillOpacity ?? 1,
      stroke: spec.stroke ?? surface(theme),
      strokeWidth: spec.strokeWidth ?? STROKE_WIDTH,
    };
    const names = spec.name === undefined ? undefined : table.categories(spec.name as never);
    const nameOf = (row: number) => {
      const code = names ? names.codes[row]! : -1;
      return code >= 0 ? names!.dictionary[code]! : `${spec.label ?? "Region"} ${row + 1}`;
    };
    const format = (value: number) => formatNumber(value, locale);
    const measure = this.measure;
    const item = (position: number): LayoutItem => {
      const row = drawn.rows[position]!;
      const shape = drawn.shapes[position]!;
      const value = values ? values[row]! : Number.NaN;
      let text = "";
      if (values) text = Number.isFinite(value) ? format(value) : "no data";
      else if (categories) {
        const code = categories.codes[row]!;
        text = code < 0 ? "no data" : categories.dictionary[code]!;
      }
      const [px, py] = anchorOf(shape);
      return {
        key: JSON.stringify([id, row]),
        label: nameOf(row),
        color: colors[drawn.colorIndex[position]!]!,
        value: Number.isFinite(value) ? value : Number.NaN,
        text,
        px,
        py,
        outline: polygonPath(shape),
        measure,
        row,
      };
    };
    let index: ShapeIndex | undefined;
    let place: Map<number, number> | undefined;
    return {
      geometry: [geometry],
      itemAt(px, py) {
        index ??= new ShapeIndex(drawn.shapes, bounds);
        const found = index.find(px, py);
        return found < 0 ? undefined : item(found);
      },
      count: drawn.rows.length,
      item,
      indexOf(key) {
        let parts: unknown;
        try {
          parts = JSON.parse(key);
        } catch {
          return -1;
        }
        if (!Array.isArray(parts) || parts.length !== 2 || parts[0] !== id) return -1;
        place ??= new Map(drawn.rows.map((row, position) => [row, position]));
        return place.get(parts[1]) ?? -1;
      },
      summary: () => this.#summary(drawn, nameOf, values, categories, format),
    };
  }

  #summary(
    drawn: Drawn,
    nameOf: (row: number) => string,
    values: ArrayLike<number> | undefined,
    categories: { codes: Int32Array; dictionary: readonly string[] } | undefined,
    format: (value: number) => string,
  ): string {
    const count = drawn.rows.length;
    const regions = plural(count, "region", "regions");
    if (count === 0) return "Map with no regions to show.";
    const field = this.spec.color;
    if (values) {
      let low = -1;
      let high = -1;
      let missing = 0;
      for (const row of drawn.rows) {
        const v = values[row]!;
        if (!Number.isFinite(v)) {
          missing++;
          continue;
        }
        if (low < 0 || v < values[low]!) low = row;
        if (high < 0 || v > values[high]!) high = row;
      }
      if (low < 0) return `Map of ${regions}, none with a value of ${field}.`;
      let text = `Map of ${regions} colored by ${field}, from ${format(values[low]!)} (${nameOf(low)}) to ${format(values[high]!)} (${nameOf(high)}).`;
      if (missing > 0) text += ` ${plural(missing, "region has", "regions have")} no value.`;
      return text;
    }
    if (categories) {
      const counts = new Map<string, number>();
      let missing = 0;
      for (const row of drawn.rows) {
        const code = categories.codes[row]!;
        if (code < 0) missing++;
        else {
          const category = categories.dictionary[code]!;
          counts.set(category, (counts.get(category) ?? 0) + 1);
        }
      }
      const listed = [...counts].slice(0, LISTED).map(([category, n]) => `${category} ${n}`);
      if (counts.size > LISTED) listed.push(`${counts.size - LISTED} more`);
      let text = `Map of ${regions} colored by ${field}: ${listed.join(", ")}.`;
      if (missing > 0) text += ` ${plural(missing, "region has", "regions have")} no value.`;
      return text;
    }
    return `Map of ${regions}.`;
  }
}

/** The legend and color key of a category of a layer; objects, so no item key (an array) is the same. */
function categoryKey(id: string | number, category: string): string {
  return JSON.stringify({ mark: id, category });
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Regions of a map, from a table with a geometry field (see `fromGeoJSON`),
 * filled by `color`: a number field on a continuous scale, or a category
 * field with a palette color per value. The chart's `projection` places them.
 *
 * ```ts
 * geoshape(countries, { name: "name", color: "gdp" })
 * ```
 */
export function geoshape<S extends Schema>(
  table: Table<S>,
  options: GeoShapeOptions<S> = {},
): ChartMark<Frozen<GeoShapeSpec>> {
  const spec: GeoShapeSpec = {
    type: "geoshape",
    ...definedFields(options, [
      "geometry",
      "name",
      "color",
      "colorMidpoint",
      "fill",
      "fillOpacity",
      "stroke",
      "strokeWidth",
      "label",
      "id",
    ]),
  };
  if (options.colors) spec.colors = [...options.colors];
  if (options.colorDomain) spec.colorDomain = [options.colorDomain[0], options.colorDomain[1]];
  if (table.name !== undefined) spec.data = table.name;
  // Field names were checked against S above; marks work on the erased schema.
  return new GeoShapeMark(spec, table as unknown as Table);
}
