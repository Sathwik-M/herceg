import type { FieldKind, NumericArray } from "../data/column.ts";
import type { RowView } from "../data/row-view.ts";
import type { Schema, Table } from "../data/table.ts";
import { formatNumber, timeTickLabels } from "../format/format.ts";
import type { TimeZone } from "../format/zone.ts";
import type { MeasureText } from "../layout/text.ts";
import type { Breaks } from "../lod/m4.ts";
import type { Polyline } from "../lod/polyline.ts";
import type { LegendPart } from "../model/legend.ts";
import type { PositionScale } from "../scale/scale.ts";
import { TIME_UNIT_MS, type TimeUnit } from "../scale/time.ts";
import type { Geometry, Rect } from "../scene/scene.ts";
import type { Frozen } from "../spec/spec.ts";
import type { Theme } from "../theme.ts";
import {
  isSortedSubset,
  rowsByCode,
  type Series,
  type SeriesStream,
  TableCache,
} from "./series.ts";
import type { SplitRows } from "./split.ts";

/**
 * Identifies a mark within a chart: its explicit `id`, or its index. Series
 * keys combine it with the series' source as JSON, so no pair of mark and
 * series names can produce the same key.
 */
export type MarkKey = string | number;

export function seriesKey(mark: MarkKey, source: string): string {
  return JSON.stringify([mark, source]);
}

/**
 * Color for a series key. A chart assigns each key a palette slot the first
 * time it appears and keeps it, so colors follow series, not their order.
 */
export type Palette = (seriesKey: string) => string;

/** The band axes' bands, in index order. */
export interface Bands {
  x?: BandList;
  y?: BandList;
}

/** Settings marks need to label categories made from numbers and times. */
export interface BandContext {
  zone: TimeZone;
  locale: string | undefined;
  theme: Theme;
}

/** Everything a mark needs to produce geometry for one frame. */
export interface Frame {
  x: PositionScale;
  y: PositionScale;
  plot: Rect;
  pixelRatio: number;
  /** Pixels per CSS pixel of images (heatmap rasters): the pixel ratio, or more for static output. */
  rasterRatio: number;
  theme: Theme;
  /** Locale for numbers the mark formats as text; undefined uses the runtime's. */
  locale: string | undefined;
  hidden: ReadonlySet<string>;
  /** The chart drawing this frame, for caches that count each chart's redraws. */
  owner: object;
  /** The owner's count of scenes drawn; the panels of one scene share it. */
  scene: number;
  /** Large point series may be left to a GPU painter as clouds. */
  clouds: boolean;
  /** Text widths for the chart's fonts, as its axes measure them. */
  measure: MeasureText;
  /**
   * A polyline buffer reused across frames, one per series key and stage
   * (for example "line", "upper", "upper-step").
   */
  polyline(seriesKey: string, stage: string): Polyline;
  /** A Float32Array of at least `length` items, reused across frames. */
  floats(seriesKey: string, stage: string, length: number): Float32Array;
  /** A Float64Array of at least `length` items, reused across frames. */
  doubles(seriesKey: string, stage: string, length: number): Float64Array;
  /** A byte array of at least `length` items, reused across frames. */
  bytes(seriesKey: string, stage: string, length: number): Uint8ClampedArray<ArrayBuffer>;
}

/** What a mark's summary sentence is written with. */
export interface SummaryContext {
  format: AxisFormat;
  locale: string | undefined;
  log: boolean;
}

/** How the chart formats single x and y values, as in tooltips. */
export interface AxisFormat {
  x: (value: number) => string;
  y: (value: number) => string;
  /** Other numbers, such as values of fields a mark encodes as size or color. */
  value: (value: number) => string;
}

/** A point found by a mark's own lookup: series, position in it, pixel distance. */
export interface Hit {
  series: Series;
  position: number;
  distance: number;
}

/** A continuous color scale a mark uses, for the chart's color legend. */
export interface ColorRamp {
  stops: readonly string[];
  domain: readonly [number, number];
  title: string;
  /** The value at the ramp's middle, for diverging ramps. */
  midpoint?: number | undefined;
}

/**
 * A legend of the point sizes or shapes a mark encodes by field: each glyph
 * is SVG path data centered on (0, 0), reaching `r` pixels from its center.
 */
export interface GlyphKey {
  title: string;
  /** What the glyphs vary in, for the chart's text alternative. */
  channel: "size" | "shape";
  /** For shapes, `shape` is the symbol's name. */
  entries: { label: string; glyph: string; r: number; shape?: string }[];
}

/**
 * What charts read from any mark's spec: its type and identity. Built-in
 * marks have portable specs (`MarkSpec`); custom marks only this.
 */
export interface MarkIdentity {
  readonly type: string;
  readonly id?: string | undefined;
  /** The y axis the mark's values are on; "left" when absent. */
  readonly axis?: "left" | "right" | undefined;
  /** "repeat" draws all of the mark's rows in every panel of a faceted chart. */
  readonly facet?: "repeat" | undefined;
  /** In a chart with panels, the panel the mark draws in, or "*" for every one. */
  readonly panel?: string | undefined;
}

/**
 * A mark draws one visual layer. It pairs a portable spec with the table it
 * reads (if any) and holds caches that depend only on the data, so the same
 * mark can be shown by several charts.
 */
export interface Mark<S extends MarkIdentity = MarkIdentity> {
  readonly spec: S;
  readonly table: Table | undefined;
  /** The view of `table` whose rows the mark shows, when it shows only some, in its order. */
  readonly view?: RowView | undefined;
  /**
   * Kind of the field on a position channel. "category" puts the axis on a
   * band scale; "time" makes it a time axis.
   */
  channelKind(axis: "x" | "y"): FieldKind | undefined;
  /** Bands this mark places on a band axis, in order. */
  bands?(axis: "x" | "y", context: BandContext): BandList | undefined;
  /** Gap between bands, as a fraction of each band's step. */
  readonly bandPadding?: number;
  /**
   * Pixels the mark's glyphs reach past their data position along each
   * axis, such as a point's radius. Automatic domains leave this much room
   * at the plot edges.
   */
  readonly inset?: { readonly x: number; readonly y: number };
  /**
   * How tooltips find this mark's data. "x", "y", and "point" choose the
   * chart's default mode (along x, along y, or nearest point) when the chart
   * does not set one; "cell" marks always report the cell under the pointer,
   * in every mode.
   */
  readonly tooltip: "x" | "y" | "point" | "cell";
  /**
   * The series' points summarize rows of the table (histogram bins, box
   * plot groups) rather than being its rows, so inspections name no row.
   */
  readonly summarizes?: boolean;
  /**
   * Resolves series for the current data. `key` prefixes series keys,
   * `palette` returns the color for a series key, `hidden` holds keys of
   * series the user hid, and `bands` gives the band axes' categories.
   */
  series(
    key: MarkKey,
    palette: Palette,
    hidden: ReadonlySet<string>,
    bands: Bands,
    context: BandContext,
  ): Series[];
  /** The axis whose domain includes zero, for marks drawn from a zero baseline. */
  readonly zero?: "x" | "y" | undefined;
  /**
   * x extent; with `log`, of positive values only. On a time axis with
   * `breaks`, room a mark leaves at the ends is time shown.
   */
  xExtent(
    series: readonly Series[],
    log: boolean,
    breaks?: Breaks,
  ): readonly [number, number] | undefined;
  /**
   * y extent of what the x range [x0, x1] shows; with `log`, of positive
   * values only; with x `breaks`, of points they do not hide.
   */
  yExtent(
    series: readonly Series[],
    x0: number,
    x1: number,
    log: boolean,
    breaks?: Breaks,
  ): readonly [number, number] | undefined;
  /**
   * The mark's part of the scene. `key` identifies the mark, for marks whose
   * geometry is not keyed by series (annotations).
   */
  geometry(series: readonly Series[], frame: Frame, key: MarkKey): Geometry[];
  /** Nearest point to a pixel, for marks with a faster lookup than the chart's generic search. */
  pick?(series: readonly Series[], px: number, py: number, frame: Frame): Hit | undefined;
  /**
   * Tooltip text for a row of a series, for marks that show more than one
   * value per point (candlesticks, histogram bins); `format` formats values
   * of the x axis and of the series' y axis.
   */
  pointText?(series: Series, row: number, format: AxisFormat): string;
  /** The color a row is drawn in, for marks coloring rows by a field rather than by series. */
  pointColor?(series: Series, row: number, theme: Theme): string;
  /**
   * The values a row's drawing covers along the axis its values are on,
   * for marks drawing more than their series value (box plots, from
   * whisker to whisker); inspection along y treats rows with any of it in
   * view as visible.
   */
  span?(series: Series, row: number): readonly [number, number];
  /**
   * Whether the mark draws a row, for marks reading more fields than their
   * series holds (candlesticks); inspection skips rows it does not draw.
   */
  shows?(series: Series, row: number, y: PositionScale): boolean;
  /**
   * For marks the keyboard reads cell by cell (heatmaps): the position of
   * the cell `columns` to the right and `rows` up from the one at
   * `position`, as `frame` draws them, or undefined when there is none; a
   * negative position asks for the first cell.
   */
  stepCell?(
    series: Series,
    position: number,
    columns: number,
    rows: number,
    frame: { x: PositionScale; y: PositionScale },
  ): number | undefined;
  /**
   * The text alternative's sentence for a series, over its parts in every
   * panel, for marks whose values say more than one number (candlesticks,
   * histograms). `context.log` says whether the series' y axis is logarithmic.
   */
  summarize?(parts: readonly Series[], name: string, context: SummaryContext): string;
  /**
   * A sentence describing what the mark shows, for marks without series
   * (annotations), which the chart's data summary would otherwise leave out.
   */
  describe?(format: AxisFormat, locale: string | undefined): string | undefined;
  /**
   * Pixels the mark draws past its data at the ends of its value axis (the
   * `zero` axis) that lie away from zero, such as bar labels; automatic
   * domains leave that much room.
   */
  headroom?(series: readonly Series[], context: BandContext): number;
  /**
   * How a series appears in the legend: by default, a square of its color.
   * `false` leaves it out, for marks whose series colors mean nothing (heatmaps).
   */
  legendEntry?(
    series: Series,
    theme: Theme,
  ): { color: string; glyph?: string; stroke?: string } | false;
  /**
   * Legends of the color scales, sizes, or shapes the mark encodes by field
   * (see legend-parts.ts); `format` writes numbers in the chart's locale.
   */
  legends?(
    series: readonly Series[],
    theme: Theme,
    format: (value: number) => string,
  ): LegendPart[];
}

/**
 * The kind of a channel several fields place values on: time when any of
 * them holds times, as an axis is a time axis when any mark's field is.
 */
export function valueKind(table: Table, fields: readonly string[]): "time" | "number" {
  return fields.some((field) => table.kind(field) === "time") ? "time" : "number";
}

export function requireField(
  table: Table,
  field: string,
  kinds: readonly FieldKind[],
  role: string,
): void {
  if (!table.has(field)) {
    throw new Error(
      `Unknown field "${field}" for ${role}; the table has ${table
        .fields()
        .map((f) => `"${f}"`)
        .join(", ")}`,
    );
  }
  const kind = table.kind(field);
  if (!kinds.includes(kind))
    throw new TypeError(`Field "${field}" is ${kind}; ${role} needs ${kinds.join(" or ")}`);
}

export const NUMERIC: readonly FieldKind[] = ["number", "time"];
export const CATEGORY: readonly FieldKind[] = ["category"];

/** One y column per series before colors and keys are assigned. */
export interface SeriesSource {
  id: string;
  label: string;
  y: string;
  rows: Uint32Array | undefined;
  /** x ascends over the source's rows. */
  sorted: boolean;
  /** For rows grouped from a whole table as it streams: see `Series.stream`. */
  stream?: SeriesStream | undefined;
}

/** What keeps long-format rows grouped as tables stream, loaded the first time a splitter needs it. */
let splitRows: Promise<typeof import("./split.ts")> | undefined;

/**
 * Splits a table into series sources: one per y field, or one per category of
 * the `series` field. Cached until the table changes. Without an x field (or
 * with a categorical one) sources are reported unsorted.
 */
export class SeriesSplitter {
  readonly table: Table<Schema>;
  readonly xField: string | undefined;
  readonly yFields: readonly string[];
  readonly seriesField: string | undefined;
  readonly label: string | undefined;
  /** The rows to split, when only a view's rows show. */
  readonly view: RowView | undefined;
  #cache = new TableCache<SeriesSource[]>();
  #revision = -1;
  /**
   * A whole table's rows by the series field, kept current as it streams;
   * until its code loads, rows are grouped again each change.
   */
  #groups: SplitRows | undefined;
  #loading = false;

  constructor(
    table: Table<Schema>,
    xField: string | undefined,
    yFields: readonly string[],
    seriesField: string | undefined,
    label: string | undefined,
    view?: RowView,
  ) {
    this.table = table;
    this.view = view;
    this.xField = xField;
    this.yFields = yFields;
    this.seriesField = seriesField;
    this.label = label;
    if (seriesField !== undefined && yFields.length > 1) {
      throw new Error("Use either several y fields or a series field, not both");
    }
    // Each y field is one series, identified by its name.
    const repeated = yFields.find((y, i) => yFields.indexOf(y) !== i);
    if (repeated !== undefined) throw new Error(`The y field "${repeated}" is listed twice`);
  }

  sources(): SeriesSource[] {
    // A view changes what shows without the table changing.
    const revision = this.view?.revision ?? -1;
    if (revision !== this.#revision) {
      this.#cache = new TableCache();
      this.#revision = revision;
    }
    return this.#cache.get(this.table, () => {
      const xField = this.xField;
      const field = this.seriesField;
      // A copy of a view's positions: the view rewrites its own when anyone
      // reads it after a change, while this scene's series and picks live on.
      const shown = this.view?.read().indices?.slice();
      if (field === undefined) {
        const x = xField === undefined ? undefined : this.table.numbers(xField as never);
        const sorted =
          x !== undefined &&
          (shown ? isSortedSubset(x, shown) : this.table.isSorted(xField as never));
        return this.yFields.map((y) => ({
          id: y,
          label: this.yFields.length === 1 ? (this.label ?? y) : y,
          y,
          rows: shown,
          sorted,
        }));
      }
      if (!shown && this.#groups) {
        return this.#groups.groups().map(({ name, rows, sorted, dropped, key }) => ({
          id: name,
          label: name,
          y: this.yFields[0]!,
          rows,
          sorted,
          stream: { key, dropped },
        }));
      }
      if (!shown && !this.#loading) {
        this.#loading = true;
        splitRows ??= import("./split.ts");
        splitRows.then(
          (loaded) => {
            this.#groups = new loaded.SplitRows(this.table, field, xField);
          },
          // Without it, rows are grouped again each change, as before it loaded.
          () => {},
        );
      }
      const x = xField === undefined ? undefined : this.table.numbers(xField as never);
      const { codes, dictionary } = this.table.categories(field as never);
      const groups = rowsByCode(codes, dictionary.length, shown);
      // Categories with no remaining rows (for example after a rolling
      // window moved past them) produce no series.
      return dictionary.flatMap((name, code) => {
        const rows = groups[code]!;
        if (rows.length === 0) return [];
        const sorted = x !== undefined && isSortedSubset(x, rows);
        return [{ id: name, label: name, y: this.yFields[0]!, rows, sorted }];
      });
    });
  }
}

/** Builds series from sources: keys, colors, column views. `x` holds each row's x position. */
export function buildSeries(
  table: Table<Schema>,
  sources: readonly SeriesSource[],
  x: NumericArray,
  key: MarkKey,
  palette: Palette,
  stroke: string | undefined,
): Series[] {
  return sources.map((source) => {
    const y = table.numbers(source.y as never);
    const id = seriesKey(key, source.id);
    return {
      key: id,
      label: source.label,
      color: stroke ?? palette(id),
      x,
      y,
      y0: undefined,
      values: y,
      field: source.y,
      range: false,
      rows: source.rows,
      stream: source.stream,
      length: source.rows?.length ?? y.length,
      sorted: source.sorted,
    };
  });
}

/**
 * The bands of one axis, in order. `keys` identify bands by raw value (a
 * category, or a number's full-precision text), so values whose display
 * labels coincide stay distinct; `labels` are what the axis shows.
 */
export interface BandList {
  keys: readonly string[];
  labels: readonly string[];
}

/** Ordered distinct values of a field as bands, with each row's band. */
interface Ordinal extends BandList {
  /** Band index of each row in `keys`, -1 for missing values. */
  own: Int32Array;
}

const ordinals = new WeakMap<Table, Map<string, { version: number; ordinal: Ordinal }>>();

/**
 * Bands for a field: category fields give their categories that occur in the
 * live rows (in dictionary order); number and time fields give their distinct
 * values in ascending order, labeled for display. Cached per table version.
 */
function ordinal(table: Table, field: string, context: BandContext): Ordinal {
  let byField = ordinals.get(table);
  if (!byField) {
    byField = new Map();
    ordinals.set(table, byField);
  }
  const key = `${field}|${context.zone}|${context.locale}`;
  const cached = byField.get(key);
  if (cached && cached.version === table.version) return cached.ordinal;
  const result =
    table.kind(field) === "category"
      ? categoryOrdinal(table, field)
      : valueOrdinal(table, field, context);
  byField.set(key, { version: table.version, ordinal: result });
  return result;
}

function categoryOrdinal(table: Table, field: string): Ordinal {
  const { codes, dictionary } = table.categories(field as never);
  const band = new Int32Array(dictionary.length).fill(-1);
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i]!;
    if (code >= 0) band[code] = 0;
  }
  const labels: string[] = [];
  for (let code = 0; code < dictionary.length; code++) {
    if (band[code] === 0) {
      band[code] = labels.length;
      labels.push(dictionary[code]!);
    }
  }
  const own = new Int32Array(codes.length);
  for (let i = 0; i < codes.length; i++) own[i] = codes[i]! >= 0 ? band[codes[i]!]! : -1;
  return { keys: labels.map((label) => `c:${label}`), labels, own };
}

function valueOrdinal(table: Table, field: string, context: BandContext): Ordinal {
  const values = table.numbers(field as never);
  // Number distinct values as they appear, then renumber them in ascending
  // order: grids have far fewer distinct values than rows.
  const ids = new Map<number, number>();
  const own = new Int32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (!Number.isFinite(v)) {
      own[i] = -1;
      continue;
    }
    let id = ids.get(v);
    if (id === undefined) {
      id = ids.size;
      ids.set(v, id);
    }
    own[i] = id;
  }
  const unique = Float64Array.from(ids.keys()).sort();
  const rank = new Int32Array(unique.length);
  for (let k = 0; k < unique.length; k++) rank[ids.get(unique[k]!)!] = k;
  for (let i = 0; i < own.length; i++) if (own[i]! >= 0) own[i] = rank[own[i]!]!;
  return {
    keys: Array.from(unique, (v) => `n:${v}`),
    labels: valueLabels(unique, table.kind(field) === "time", context),
    own,
  };
}

function valueLabels(values: Float64Array, isTime: boolean, context: BandContext): string[] {
  if (!isTime) return Array.from(values, (v) => formatNumber(v, context.locale));
  let spacing = Infinity;
  for (let i = 1; i < values.length; i++) spacing = Math.min(spacing, values[i]! - values[i - 1]!);
  const units: TimeUnit[] = ["year", "month", "day", "hour", "minute", "second"];
  const unit = units.find((u) => spacing >= TIME_UNIT_MS[u]) ?? "millisecond";
  const interval = { unit, step: 1, duration: TIME_UNIT_MS[unit] };
  return timeTickLabels(Array.from(values), interval, context.zone, context.locale);
}

/** Bands made from numbers or times, which run upward on a y axis; categories run downward. */
export function numericBands(list: BandList): boolean {
  return list.keys.length > 0 && list.keys.every((key) => key.startsWith("n:"));
}

/** The bands a field contributes to an axis. */
export function fieldBands(table: Table, field: string, context: BandContext): BandList {
  return ordinal(table, field, context);
}

// Keyed weakly by the axis' key list (one per chart while its bands are
// unchanged), so charts sharing a table do not evict each other's mappings.
const indexCache = new WeakMap<
  readonly string[],
  WeakMap<Table, Map<string, { version: number; indices: Int32Array }>>
>();

/**
 * Each row's band index on an axis whose band keys are `keys` (which may
 * include bands from other marks). Cached per table version and key list;
 * the chart keeps key lists stable while their contents do not change. The
 * array is shared with other callers and must not be modified.
 */
export function bandIndices(
  table: Table,
  field: string,
  keys: readonly string[],
  context: BandContext,
): Int32Array {
  let byTable = indexCache.get(keys);
  if (!byTable) {
    byTable = new WeakMap();
    indexCache.set(keys, byTable);
  }
  let byField = byTable.get(table);
  if (!byField) {
    byField = new Map();
    byTable.set(table, byField);
  }
  const cached = byField.get(field);
  if (cached && cached.version === table.version) return cached.indices;
  const own = ordinal(table, field, context);
  const position = new Map(keys.map((key, index) => [key, index]));
  const remap = Int32Array.from(own.keys, (key) => position.get(key) ?? -1);
  // When the field's bands lead the axis in their own order, as with one
  // mark on it, rows keep their own indices rather than a copy of them.
  let indices = own.own;
  if (!remap.every((to, from) => to === from)) {
    indices = new Int32Array(own.own.length);
    for (let i = 0; i < indices.length; i++)
      indices[i] = own.own[i]! >= 0 ? remap[own.own[i]!]! : -1;
  }
  byField.set(field, { version: table.version, indices });
  return indices;
}

/**
 * A frozen copy of a spec, all the way down, so it cannot change under the
 * mark's caches, nor freeze arrays and objects its caller still holds.
 * Specs are small plain objects; copying them is cheap.
 */
export function frozen<T>(spec: T): Frozen<T> {
  if (Array.isArray(spec)) return Object.freeze(spec.map(frozen)) as Frozen<T>;
  if (typeof spec !== "object" || spec === null) return spec as Frozen<T>;
  const copy = {};
  // Defined rather than assigned: a JSON key "__proto__" stays a key.
  for (const [key, value] of Object.entries(spec))
    Object.defineProperty(copy, key, { value: frozen(value), enumerable: true });
  return Object.freeze(copy) as Frozen<T>;
}
