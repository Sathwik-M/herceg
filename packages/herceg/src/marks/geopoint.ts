// Points of a map at longitudes and latitudes: places, or bubbles sized by
// a field. They are drawn as point marks draw (packed coordinates, radii,
// and color indexes per point), largest first so smaller ones stay on top,
// and the pointer finds the topmost point whose disc it is on.

import type { CategoryField, NumberField, Schema, Table } from "../data/table.ts";
import { pointDrawing } from "../draw/point.ts";
import { symbolPath } from "../draw/symbols.ts";
import { formatNumber } from "../format/format.ts";
import { extendExtent, type GeoExtent, type ProjectionPlan } from "../geo/project.ts";
import { ItemViews } from "../model/item-views.ts";
import type { LegendEntry } from "../model/legend.ts";
import type { ChartConfig } from "../model/model.ts";
import {
  checkColorScale,
  checkRamp,
  fraction,
  isOpaqueColor,
  rampOf,
  SequentialScale,
} from "../scale/color.ts";
import { linearTicks } from "../scale/ticks.ts";
import type { PointGeometry } from "../scene/scene.ts";
import type { Frozen, GeoPointSpec } from "../spec/spec.ts";
import { surface, type Theme } from "../theme.ts";
import { Appearance, categoryColors, categoryTones, colorKey } from "./appearance.ts";
import { type GeoLayer, joinLayers, type MapFrame } from "./geo.ts";
import {
  insidePolygon,
  type LayoutFrame,
  type LayoutItem,
  type LayoutMark,
  type LayoutResult,
} from "./layout-mark.ts";
import { definedFields } from "./line.ts";
import {
  type ChartMark,
  type ColorRamp,
  DIM,
  frozen,
  type GlyphKey,
  type MARK,
  requireField,
} from "./mark.ts";
import { rowsByCode } from "./series.ts";
import { checkTooltip, type MarkTooltip } from "./tooltip-fields.ts";

/**
 * A map point's size: a constant `radius`, or a number field `size` sized
 * by area within `radiusRange` (bubbles); not both.
 */
export type GeoPointSize<S extends Schema> =
  | {
      /** Radius in pixels; 4 by default. */
      radius?: number;
      size?: never;
      radiusRange?: never;
    }
  | {
      radius?: never;
      /** A number field sized by area within `radiusRange` (bubbles). */
      size?: NumberField<S>;
      /** Radii of the smallest and largest values of `size`. Default [2, 16]. */
      radiusRange?: readonly [number, number];
    };

export type GeoPointOptions<S extends Schema> = GeoPointStyle<S> & GeoPointSize<S>;

interface GeoPointStyle<S extends Schema> {
  /** Number field: each point's longitude, in degrees east. */
  longitude: NumberField<S>;
  /** Number field: each point's latitude, in degrees north. */
  latitude: NumberField<S>;
  /** Category field naming each point, for tooltips, keyboard reading, and the summary. */
  labelField?: CategoryField<S>;
  /** Category field: one colored set of points per value, with a legend. */
  series?: CategoryField<S>;
  /**
   * A number field colored on a continuous scale, with a color legend; or a
   * category field whose values take the theme's palette in order of
   * appearance, with a key of them (the `series` field keeps its series' colors).
   */
  color?: NumberField<S> | CategoryField<S>;
  /** Colors for a number `color`, low to high; the theme's ramp by default. */
  colors?: readonly string[];
  colorDomain?: readonly [number, number];
  colorMidpoint?: number;
  fill?: string;
  /** Default 0.8, so overlapping points and the regions under them show. */
  fillOpacity?: number;
  /** Color of the ring around each point; the chart's background by default. */
  stroke?: string;
  /** Width of the ring in pixels; default 1, 0 for none. */
  strokeWidth?: number;
  /** Legend and tooltip name of points without `series`. */
  label?: string;
  /** Fields of the row tooltips show besides the mark's values, such as counts that are not plotted. */
  tooltip?: MarkTooltip<S>;
  id?: string;
  /**
   * With the chart's `facet`, "repeat" draws all the layer's rows in every
   * panel (a base map) instead of splitting them by the facet field.
   */
  facet?: "repeat";
  /** With the chart's `panels`, the id of the panel of the map: layers naming one panel are one map. */
  panel?: string;
}

const RADIUS = 4;
const RADIUS_RANGE: readonly [number, number] = [2, 16];
const OPACITY = 0.8;
const RING = 1;
/** Pointer reach beyond a point's edge, in pixels. */
const REACH = 3;
/** Grid cells of the pointer lookup, in pixels a side. */
const CELL = 32;
const LEGEND_RADIUS = 4.5;

/** A layer's points as drawn: in drawing order, with where each lies and how large it is. */
interface Drawn {
  /** Per point in drawing order: its row, center, radius, and color. */
  rows: Uint32Array;
  coords: Float32Array;
  radii: Float32Array;
  colors: string[];
  /** Rows of the points drawn, ascending: the order the keyboard reads. */
  reading: Uint32Array;
}

export class GeoPointMark implements GeoLayer {
  declare readonly [MARK]: true;
  readonly layout = true;
  readonly views = ItemViews;
  readonly geo = true;
  readonly spec: Frozen<GeoPointSpec>;
  readonly table: Table;
  readonly measure: string;
  readonly reach: number;
  readonly #sizeField: string | undefined;
  /** A number `color`, colored on a continuous scale. */
  readonly #toneField: string | undefined;
  /** A category `color` other than the series field, its values in order of appearance. */
  readonly #colorField: Appearance | undefined;
  /** The radius of every point, or with a `size` field the largest. */
  readonly #largest: number;
  /** Plane positions per row (NaN off the map), for the table version and projection named by `key`. */
  #projected: { key: string; xy: Float64Array; box: Float64Array | undefined } | undefined;

  constructor(input: GeoPointSpec, table: Table) {
    this.spec = frozen(input);
    checkTooltip(table, this.spec.tooltip, "geopoint");
    // Read from the copy: the caller may change what it passed.
    const spec = this.spec;
    requireField(table, spec.longitude, ["number"], "geopoint longitude");
    requireField(table, spec.latitude, ["number"], "geopoint latitude");
    if (spec.labelField !== undefined)
      requireField(table, spec.labelField, ["category"], "geopoint labelField");
    if (spec.series !== undefined)
      requireField(table, spec.series, ["category"], "geopoint series");
    if (spec.radius !== undefined && spec.size !== undefined)
      throw new Error("geopoint radius: a constant radius or a size field, not both; drop one");
    if (spec.size !== undefined) requireField(table, spec.size, ["number"], "geopoint size");
    if (spec.radius !== undefined && !(spec.radius > 0 && Number.isFinite(spec.radius)))
      throw new RangeError(
        `geopoint radius: expected a positive number of pixels; received ${spec.radius}`,
      );
    if (spec.color !== undefined) {
      requireField(table, spec.color, ["number", "category"], "geopoint color");
      if (table.kind(spec.color) === "number") this.#toneField = spec.color;
      else if (
        spec.colors !== undefined ||
        spec.colorDomain !== undefined ||
        spec.colorMidpoint !== undefined
      )
        throw new Error(
          `geopoint colors: "${spec.color}" is a category field, colored by the theme's palette; drop colors, colorDomain, and colorMidpoint`,
        );
      else if (spec.color !== spec.series) this.#colorField = new Appearance(spec.color);
    }
    if (Array.isArray(spec.colors)) checkRamp(spec.colors, "geopoint colors");
    checkColorScale(spec.colorDomain, spec.colorMidpoint, "geopoint");
    const range = spec.radiusRange ?? RADIUS_RANGE;
    if (!(range[0] >= 0 && range[1] > range[0] && Number.isFinite(range[1])))
      throw new RangeError(
        `geopoint radiusRange: expected two finite radii, ascending; received [${range}]`,
      );
    if (spec.fillOpacity !== undefined && !(spec.fillOpacity >= 0 && spec.fillOpacity <= 1))
      throw new RangeError(
        `geopoint fillOpacity: expected a number from 0 to 1; received ${spec.fillOpacity}`,
      );
    if (
      spec.strokeWidth !== undefined &&
      !(spec.strokeWidth >= 0 && Number.isFinite(spec.strokeWidth))
    )
      throw new RangeError(
        `geopoint strokeWidth: expected 0 or more pixels; received ${spec.strokeWidth}`,
      );
    this.table = table;
    this.#sizeField = spec.size;
    this.measure = this.#sizeField ?? this.#toneField ?? spec.label ?? "Location";
    this.#largest = this.#sizeField !== undefined ? range[1] : (spec.radius ?? RADIUS);
    // Rings reach half their width past the points.
    this.reach = this.#largest + (spec.strokeWidth ?? RING) / 2;
  }

  join(
    marks: readonly LayoutMark[],
    config: ChartConfig,
    indices?: readonly number[],
    panel?: string,
  ): LayoutMark {
    return joinLayers(marks, config.projection, indices, panel);
  }

  /** Charts draw maps' layers through `join`; drawn alone, a layer takes the default projection. */
  draw(frame: LayoutFrame): LayoutResult {
    return joinLayers([this], undefined).draw(frame);
  }

  /** Each row's radius: by area within `radiusRange` from zero (or the least value, when some are negative). */
  #radius(): (row: number) => number {
    const field = this.#sizeField;
    if (field === undefined) {
      const r = this.spec.radius ?? RADIUS;
      return () => r;
    }
    const values = this.table.numbers(field as never);
    const extent = this.table.extent(field as never);
    const [lo, hi] = extent ? (extent[0] >= 0 ? [0, extent[1]] : extent) : [0, 0];
    const [r0, r1] = this.spec.radiusRange ?? RADIUS_RANGE;
    return (row) => {
      const value = values[row]!;
      if (!Number.isFinite(value)) return Number.NaN;
      const t = Math.min(1, Math.max(0, fraction(value, lo, hi)));
      return Math.sqrt(r0 * r0 + (r1 * r1 - r0 * r0) * t);
    };
  }

  #scale(theme: Theme): SequentialScale | undefined {
    const { spec } = this;
    if (this.#toneField === undefined) return undefined;
    const domain = spec.colorDomain ?? this.table.extent(this.#toneField as never);
    if (!domain) return undefined;
    const fallback = spec.colorMidpoint === undefined ? theme.sequential : theme.diverging;
    return new SequentialScale(domain, rampOf(spec.colors, fallback), spec.colorMidpoint);
  }

  /** The sets of points: one per category of `series` that rows hold, or one. */
  #groups(): { label: string; rows: Uint32Array | undefined; category: string | undefined }[] {
    const { spec, table } = this;
    if (spec.series === undefined)
      return [{ label: spec.label ?? "Points", rows: undefined, category: undefined }];
    const { codes, dictionary } = table.categories(spec.series as never);
    const rows = rowsByCode(codes, dictionary.length);
    return dictionary.flatMap((category, code) =>
      rows[code]!.length > 0 ? [{ label: category, rows: rows[code], category }] : [],
    );
  }

  /** Entries per series; with a `color` field coloring the points, in a neutral color. */
  legend(id: string | number, color: (key: string) => string, theme: Theme): LegendEntry[] {
    const glyph = symbolPath("circle", 0, 0, LEGEND_RADIUS);
    const muted = this.#toneField !== undefined || this.#colorField !== undefined;
    return this.#groups().map(({ label, category }) => {
      const key = groupKey(id, category);
      const fill = muted ? theme.muted : (this.spec.fill ?? color(key));
      return { key, label, color: fill, glyph };
    });
  }

  scales(theme: Theme, locale: string | undefined): [ColorRamp[], GlyphKey[]] {
    const ramps: ColorRamp[] = [];
    const keys: GlyphKey[] = [];
    const scale = this.#scale(theme);
    if (scale) {
      const { domain, midpoint } = scale;
      ramps.push({ stops: scale.legendStops(), domain, midpoint, title: this.spec.color! });
    }
    const field = this.#sizeField;
    const extent = field !== undefined && this.table.extent(field as never);
    if (extent) {
      // Round values nearest a quarter, half, and all of the way from the
      // smallest size's value (zero, or the least) to the largest's.
      const [lo, hi] = extent[0] >= 0 ? [0, extent[1]] : extent;
      const [r0, r1] = this.spec.radiusRange ?? RADIUS_RANGE;
      const radius = (value: number) =>
        Math.sqrt(
          r0 * r0 + (r1 * r1 - r0 * r0) * Math.min(1, Math.max(0, fraction(value, lo, hi))),
        );
      const ticks = linearTicks(extent[0], extent[1], 5).filter((v) => !(lo === 0 && v === 0));
      const nearest = (target: number) =>
        ticks.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a), extent[1]);
      const values = [...new Set([0.25, 0.5, 1].map((f) => nearest(lo + (hi - lo) * f)))];
      keys.push({
        title: field!,
        channel: "size",
        entries: values.map((value) => {
          const r = radius(value);
          return { label: formatNumber(value, locale), glyph: symbolPath("circle", 0, 0, r), r };
        }),
      });
    }
    if (this.#colorField) keys.push(colorKey(this.#colorField, this.table, theme));
    return [ramps, keys];
  }

  extent(into: GeoExtent, rows?: Uint32Array): void {
    const lon = this.table.numbers(this.spec.longitude as never);
    const lat = this.table.numbers(this.spec.latitude as never);
    for (const row of rows ?? lon.keys()) extendExtent(into, lon[row]!, lat[row]!);
  }

  /** Plane positions of every row, NaN for rows off the map, and their box. */
  #project(plan: ProjectionPlan): { xy: Float64Array; box: Float64Array | undefined } {
    const key = `${this.table.version} ${plan.key}`;
    if (this.#projected?.key === key) return this.#projected;
    const lon = this.table.numbers(this.spec.longitude as never);
    const lat = this.table.numbers(this.spec.latitude as never);
    const xy = new Float64Array(lon.length * 2).fill(Number.NaN);
    const box = new Float64Array([Infinity, Infinity, -Infinity, -Infinity]);
    const out = new Float64Array(2);
    const radians = Math.PI / 180;
    for (let row = 0; row < lon.length; row++) {
      const longitude = plan.clipper.longitude(lon[row]!, lat[row]!);
      if (Number.isNaN(longitude)) continue;
      plan.raw(longitude * radians, lat[row]! * radians, out);
      const [x, y] = [out[0]!, out[1]!];
      if (!(Number.isFinite(x) && Number.isFinite(y))) continue;
      xy[row * 2] = x;
      xy[row * 2 + 1] = y;
      box[0] = Math.min(box[0]!, x);
      box[1] = Math.min(box[1]!, y);
      box[2] = Math.max(box[2]!, x);
      box[3] = Math.max(box[3]!, y);
    }
    this.#projected = { key, xy, box: box[0]! <= box[2]! ? box : undefined };
    return this.#projected;
  }

  box(plan: ProjectionPlan, rows?: Uint32Array): Float64Array | undefined {
    const { xy, box } = this.#project(plan);
    if (!rows) return box;
    const of = new Float64Array([Infinity, Infinity, -Infinity, -Infinity]);
    for (const row of rows) {
      const x = xy[row * 2]!;
      const y = xy[row * 2 + 1]!;
      // Rows off the map have no place.
      if (Number.isNaN(x)) continue;
      of[0] = Math.min(of[0]!, x);
      of[1] = Math.min(of[1]!, y);
      of[2] = Math.max(of[2]!, x);
      of[3] = Math.max(of[3]!, y);
    }
    return of[0]! <= of[2]! ? of : undefined;
  }

  place(frame: MapFrame): LayoutResult {
    const { theme, hidden, plan, transform: t, bounds, id } = frame;
    const { spec, table } = this;
    const { xy } = this.#project(plan);
    const radiusOf = this.#radius();
    const scale = this.#scale(theme);
    const tones =
      this.#toneField === undefined ? undefined : table.numbers(this.#toneField as never);
    const ramp = scale && tones ? scale.colors() : undefined;
    // A category color's codes, each code's index into the theme's palette.
    const categories = this.#colorField && {
      codes: table.categories(this.#colorField.field as never).codes,
      tones: categoryTones(this.#colorField, table, theme),
    };
    const opacity = spec.fillOpacity ?? OPACITY;
    const ringWidth = spec.strokeWidth ?? RING;
    // Rings keep points apart from each other and from the regions under them.
    const ring =
      ringWidth > 0 ? { color: spec.stroke ?? surface(theme), width: ringWidth } : undefined;
    // Every point drawn, with its radius and its color's index into `ramp`
    // (with a number `color`), the theme's palette (a category one), or the
    // series' colors.
    let rows: number[] = [];
    const radii = new Float64Array(table.length);
    const tone = new Uint8Array(table.length);
    const fills: string[] = categories ? [...categoryColors(theme)] : [];
    // With a number `color` but no color value at all, no point has one to draw.
    const drawable = this.#toneField === undefined || scale !== undefined;
    // In a facet panel, its rows only.
    const inPanel = frame.rows && new Uint8Array(table.length);
    for (const row of frame.rows ?? []) inPanel![row] = 1;
    for (const group of drawable ? this.#groups() : []) {
      const key = groupKey(id, group.category);
      if (hidden.has(key)) continue;
      let fillIndex = -1;
      if (!categories) {
        const fill = spec.fill ?? frame.color(key);
        fillIndex = fills.indexOf(fill);
        if (fillIndex < 0) fillIndex = fills.push(fill) - 1;
      }
      const all = group.rows ?? Uint32Array.from({ length: table.length }, (_, i) => i);
      for (const row of all) {
        if (inPanel && !inPanel[row]) continue;
        const x = t.x0 + t.k * xy[row * 2]!;
        const y = t.y0 - t.k * xy[row * 2 + 1]!;
        const r = radiusOf(row);
        if (!(r > 0 && Number.isFinite(x) && Number.isFinite(y))) continue;
        const index = tones
          ? scale!.index(tones[row]!)
          : categories
            ? (categories.tones[categories.codes[row]!] ?? -1)
            : fillIndex;
        if (index < 0) continue;
        const reach = r + ringWidth / 2;
        if (x < bounds.x - reach || x > bounds.x + bounds.width + reach) continue;
        if (y < bounds.y - reach || y > bounds.y + bounds.height + reach) continue;
        rows.push(row);
        radii[row] = r;
        tone[row] = index;
      }
    }
    // Largest first across every series, so smaller points stay visible on top.
    if (this.#sizeField !== undefined) rows.sort((a, b) => radii[b]! - radii[a]! || a - b);
    // With the selection highlighted, the points it leaves out are drawn
    // first, dimmed, below the others, and the pointer finds those on top.
    const selected = frame.selected?.(table);
    if (selected) {
      const lit = rows.filter((row) => selected[row] === 1);
      rows = rows.filter((row) => selected[row] !== 1).concat(lit);
    }
    const count = rows.length;
    const coords = new Float32Array(count * 2);
    const pointRadii = new Float32Array(count);
    const palette = ramp ?? fills;
    // Bytes index the colors: a ramp's 255, or the series' (theme palettes are short).
    if (palette.length > 256)
      throw new RangeError(
        `geopoint series: expected at most 256 series; received ${palette.length}`,
      );
    const colorIndex = new Uint8ClampedArray(count);
    rows.forEach((row, i) => {
      coords[i * 2] = t.x0 + t.k * xy[row * 2]!;
      coords[i * 2 + 1] = t.y0 - t.k * xy[row * 2 + 1]!;
      pointRadii[i] = radii[row]!;
      colorIndex[i] = tone[row]!;
    });
    const sized = this.#sizeField !== undefined;
    const colored = palette.length > 1;
    const fill = palette[0] ?? theme.muted;
    // The points at `at` in drawing order (all of them by default), `dim` of the selection's left out.
    const points = (at?: readonly number[], dim = false): PointGeometry => {
      const pick = <T extends Float32Array | Uint8ClampedArray>(all: T, width: number): T => {
        if (!at) return all;
        const out = new (all.constructor as new (length: number) => T)(at.length * width);
        at.forEach((i, j) => {
          for (let c = 0; c < width; c++) out[j * width + c] = all[i * width + c]!;
        });
        return out;
      };
      const shown = dim ? opacity * DIM : opacity;
      return {
        kind: "point",
        draw: pointDrawing,
        key: `geopoint-${JSON.stringify(id)}${dim ? "-dimmed" : ""}`,
        fill,
        fillOpacity: shown,
        // Points of several sizes or colors are drawn one by one, in this order, as the pointer finds them.
        opaque: !sized && !colored && shown >= 1 && isOpaqueColor(fill),
        ring: ring && dim ? { ...ring, opacity: DIM } : ring,
        radius: this.#largest,
        symbol: "circle",
        coords: pick(coords, 2),
        count: at?.length ?? count,
        radii: sized ? pick(pointRadii, 1) : undefined,
        colors: colored
          ? {
              index: pick(colorIndex, 1),
              palette,
              ...(categories && { categorical: true as const }),
            }
          : undefined,
      };
    };
    const parts = selected && [[] as number[], [] as number[]];
    if (parts)
      rows.forEach((row, i) => {
        parts[selected[row]!]!.push(i);
      });
    const geometry = parts ? [points(parts[0], true), points(parts[1])] : [points()];
    const drawn: Drawn = {
      rows: Uint32Array.from(rows),
      coords,
      radii: pointRadii,
      colors: rows.map((row) => palette[tone[row]!]!),
      reading: Uint32Array.from(rows).sort(),
    };
    // Reading order (by row) to drawing order.
    const drawOrder = new Map(rows.map((row, i) => [row, i]));
    return this.#result(geometry, drawn, drawOrder, frame, ringWidth / 2);
  }

  #result(
    geometry: PointGeometry[],
    drawn: Drawn,
    drawOrder: Map<number, number>,
    frame: MapFrame,
    ring: number,
  ): LayoutResult {
    const { spec, table } = this;
    const { id, bounds, locale } = frame;
    const names =
      spec.labelField === undefined ? undefined : table.categories(spec.labelField as never);
    const lon = table.numbers(spec.longitude as never);
    const lat = table.numbers(spec.latitude as never);
    const sizes =
      this.#sizeField === undefined ? undefined : table.numbers(this.#sizeField as never);
    const tones =
      this.#toneField === undefined ? undefined : table.numbers(this.#toneField as never);
    const categories = this.#colorField && table.categories(this.#colorField.field as never);
    const format = (value: number) => formatNumber(value, locale);
    const nameOf = (row: number) => {
      const code = names ? names.codes[row]! : -1;
      return code >= 0 ? names!.dictionary[code]! : `${spec.label ?? "Point"} ${row + 1}`;
    };
    const measure = this.measure;
    const itemOf = (point: number): LayoutItem => {
      const row = drawn.rows[point]!;
      const parts: string[] = [];
      if (sizes) parts.push(format(sizes[row]!));
      if (tones) parts.push(sizes ? `${spec.color} ${format(tones[row]!)}` : format(tones[row]!));
      if (categories)
        parts.push(`${spec.color} ${categories.dictionary[categories.codes[row]!] ?? ""}`);
      if (parts.length === 0) parts.push(coordinates(lon[row]!, lat[row]!, locale));
      const [px, py, r] = [
        drawn.coords[point * 2]!,
        drawn.coords[point * 2 + 1]!,
        drawn.radii[point]!,
      ];
      return {
        key: JSON.stringify([id, row]),
        label: nameOf(row),
        color: drawn.colors[point]!,
        value: sizes ? sizes[row]! : tones ? tones[row]! : Number.NaN,
        text: parts.join(", "),
        px,
        py,
        outline: symbolPath("circle", px, py, r + 1.5),
        measure,
        row,
      };
    };
    let grid: PointGrid | undefined;
    /** The row an item key names, if the layer drew it. */
    const rowOf = (key: string): number | undefined => {
      let parts: unknown;
      try {
        parts = JSON.parse(key);
      } catch {
        return undefined;
      }
      if (!Array.isArray(parts) || parts.length !== 2 || parts[0] !== id) return undefined;
      const row = parts[1];
      return typeof row === "number" && drawOrder.has(row) ? row : undefined;
    };
    return {
      geometry,
      itemAt(px, py) {
        // Points at the room's edge reach past it, where they are not drawn.
        if (!(px >= bounds.x && px <= bounds.x + bounds.width)) return undefined;
        if (!(py >= bounds.y && py <= bounds.y + bounds.height)) return undefined;
        grid ??= new PointGrid(drawn.coords, drawn.radii, bounds);
        const point = grid.find(px, py, REACH + ring);
        return point < 0 ? undefined : itemOf(point);
      },
      count: drawn.reading.length,
      item: (index) => itemOf(drawOrder.get(drawn.reading[index]!)!),
      indexOf(key) {
        const row = rowOf(key);
        if (row === undefined) return -1;
        // Rows read in ascending order.
        let lo = 0;
        let hi = drawn.reading.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (drawn.reading[mid]! < row) lo = mid + 1;
          else hi = mid;
        }
        return lo;
      },
      rowsOf(key, of) {
        const row = of === table ? rowOf(key) : undefined;
        return row === undefined ? undefined : [row];
      },
      // A point is in a lasso when its center is; points not drawn are not selected.
      lassoed(polygon, of) {
        if (of !== table) return undefined;
        const found: number[] = [];
        drawn.rows.forEach((row, i) => {
          if (insidePolygon(polygon, drawn.coords[i * 2]!, drawn.coords[i * 2 + 1]!))
            found.push(row);
        });
        return found;
      },
      summary: () => {
        const count = drawn.reading.length;
        if (count === 0) return "Map with no points to show.";
        let text = `${plural(count, "point", "points")} on the map`;
        if (sizes) {
          let largest = drawn.reading[0]!;
          for (const row of drawn.reading) if (sizes[row]! > sizes[largest]!) largest = row;
          text += ` sized by ${this.#sizeField}; largest ${nameOf(largest)} (${format(sizes[largest]!)})`;
        }
        return `${text}.`;
      },
    };
  }
}

/**
 * A uniform grid of points' centers, finding the last-drawn point whose disc
 * (widened by a reach) holds a position.
 */
class PointGrid {
  readonly #coords: Float32Array;
  readonly #radii: Float32Array;
  readonly #x0: number;
  readonly #y0: number;
  readonly #columns: number;
  readonly #rows: number;
  readonly #starts: Uint32Array;
  readonly #items: Uint32Array;
  readonly #largest: number;

  constructor(
    coords: Float32Array,
    radii: Float32Array,
    bounds: { x: number; y: number; width: number; height: number },
  ) {
    this.#coords = coords;
    this.#radii = radii;
    this.#x0 = bounds.x;
    this.#y0 = bounds.y;
    this.#columns = Math.max(1, Math.ceil(bounds.width / CELL));
    this.#rows = Math.max(1, Math.ceil(bounds.height / CELL));
    const count = radii.length;
    const cells = this.#columns * this.#rows;
    this.#starts = new Uint32Array(cells + 1);
    const cellOf = new Uint32Array(count);
    let largest = 0;
    for (let i = 0; i < count; i++) {
      const [c, r] = this.#cell(coords[i * 2]!, coords[i * 2 + 1]!);
      cellOf[i] = r * this.#columns + c;
      this.#starts[cellOf[i]! + 1]!++;
      largest = Math.max(largest, radii[i]!);
    }
    for (let c = 0; c < cells; c++) this.#starts[c + 1]! += this.#starts[c]!;
    const next = this.#starts.slice(0, cells);
    this.#items = new Uint32Array(count);
    for (let i = 0; i < count; i++) this.#items[next[cellOf[i]!]!++] = i;
    this.#largest = largest;
  }

  #cell(x: number, y: number): [number, number] {
    const clamp = (v: number, n: number) => Math.min(n - 1, Math.max(0, Math.floor(v / CELL)));
    return [clamp(x - this.#x0, this.#columns), clamp(y - this.#y0, this.#rows)];
  }

  /** The highest-numbered (last-drawn) point within its radius plus `reach` of (x, y), or -1. */
  find(x: number, y: number, reach: number): number {
    const far = this.#largest + reach;
    const [c0, r0] = this.#cell(x - far, y - far);
    const [c1, r1] = this.#cell(x + far, y + far);
    let found = -1;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const cell = r * this.#columns + c;
        for (let k = this.#starts[cell]!; k < this.#starts[cell + 1]!; k++) {
          const i = this.#items[k]!;
          if (i <= found) continue;
          const d = Math.hypot(this.#coords[i * 2]! - x, this.#coords[i * 2 + 1]! - y);
          if (d <= this.#radii[i]! + reach) found = i;
        }
      }
    }
    return found;
  }
}

/** A position for people: "35.68° N, 139.69° E". */
function coordinates(longitude: number, latitude: number, locale: string | undefined): string {
  const f = (v: number) => formatNumber(Math.round(Math.abs(v) * 100) / 100, locale);
  return `${f(latitude)}° ${latitude < 0 ? "S" : "N"}, ${f(longitude)}° ${longitude < 0 ? "W" : "E"}`;
}

/** The legend and color key of a set of points; objects, so no item key (an array) is the same. */
function groupKey(id: string | number, series: string | undefined): string {
  return JSON.stringify({ mark: id, series });
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Points of a map at the longitudes and latitudes of two number fields,
 * sized, colored, and split into series as `point` marks are. The chart's
 * `projection` places them.
 *
 * ```ts
 * geopoint(cities, { longitude: "lon", latitude: "lat", size: "population", labelField: "city" })
 * ```
 */
export function geopoint<S extends Schema>(
  table: Table<S>,
  options: GeoPointOptions<S>,
): ChartMark<Frozen<GeoPointSpec>> {
  // A radius or a size, as the options' types allow; the mark refuses both from others.
  const spec = {
    type: "geopoint",
    longitude: options.longitude,
    latitude: options.latitude,
    ...definedFields(options, [
      "tooltip",
      "labelField",
      "series",
      "radius",
      "size",
      "color",
      "colorMidpoint",
      "fill",
      "fillOpacity",
      "stroke",
      "strokeWidth",
      "label",
      "id",
      "facet",
      "panel",
    ]),
    ...(options.radiusRange && {
      radiusRange: [options.radiusRange[0], options.radiusRange[1]] as const,
    }),
  } as unknown as GeoPointSpec;
  if (options.colors) spec.colors = [...options.colors];
  if (options.colorDomain) spec.colorDomain = [options.colorDomain[0], options.colorDomain[1]];
  if (table.name !== undefined) spec.data = table.name;
  // Field names were checked against S above; marks work on the erased schema.
  return new GeoPointMark(spec, table as unknown as Table);
}
