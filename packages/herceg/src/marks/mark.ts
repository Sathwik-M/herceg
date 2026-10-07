import type { FieldKind, NumericArray } from "../data/column.ts";
import { lowerBound, type Schema, type Table } from "../data/table.ts";
import { formatNumber, timeTickLabels } from "../format/format.ts";
import type { TimeZone } from "../format/zone.ts";
import type { Polyline } from "../lod/polyline.ts";
import type { PositionScale } from "../scale/scale.ts";
import { TIME_UNIT_MS, type TimeUnit } from "../scale/time.ts";
import type { Geometry, Rect } from "../scene/scene.ts";
import type { MarkSpec } from "../spec/spec.ts";
import type { Theme } from "../theme.ts";
import { groupRows, isSortedSubset, type Series, TableCache } from "./series.ts";

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
  theme: Theme;
  /** Locale for numbers the mark formats as text; undefined uses the runtime's. */
  locale: string | undefined;
  hidden: ReadonlySet<string>;
  /** The chart drawing this frame, for caches that count each chart's redraws. */
  owner: object;
  /** Large point series may be left to a GPU painter as clouds. */
  clouds: boolean;
  /**
   * A polyline buffer reused across frames, one per series key and stage
   * (for example "line", "upper", "upper-step").
   */
  polyline(seriesKey: string, stage: string): Polyline;
  /** A Float32Array of at least `length` items, reused across frames. */
  floats(seriesKey: string, stage: string, length: number): Float32Array;
  /** A byte array of at least `length` items, reused across frames. */
  bytes(seriesKey: string, stage: string, length: number): Uint8ClampedArray<ArrayBuffer>;
}

/** How the chart formats single x and y values, as in tooltips. */
export interface AxisFormat {
  x: (value: number) => string;
  y: (value: number) => string;
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
}

/**
 * A mark draws one visual layer. It pairs a portable spec with the table it
 * reads (if any) and holds caches that depend only on the data, so the same
 * mark can be shown by several charts.
 */
export interface Mark<S extends MarkSpec = MarkSpec> {
  readonly spec: S;
  readonly table: Table | undefined;
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
   * Pixels the mark's glyphs reach past their data position, such as a
   * point's radius. Automatic domains leave this much room at the plot edges.
   */
  readonly inset?: number;
  /**
   * How tooltips find this mark's data. "x", "y", and "point" choose the
   * chart's default mode (along x, along y, or nearest point) when the chart
   * does not set one; "cell" marks always report the cell under the pointer,
   * in every mode.
   */
  readonly tooltip: "x" | "y" | "point" | "cell";
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
  /** x extent; with `log`, of positive values only. */
  xExtent(series: readonly Series[], log: boolean): readonly [number, number] | undefined;
  /** y extent of what the x range [x0, x1] shows; with `log`, of positive values only. */
  yExtent(
    series: readonly Series[],
    x0: number,
    x1: number,
    log: boolean,
  ): readonly [number, number] | undefined;
  /**
   * The mark's part of the scene. `key` identifies the mark, for marks whose
   * geometry is not keyed by series (annotations).
   */
  geometry(series: readonly Series[], frame: Frame, key: MarkKey): Geometry[];
  /** Nearest point to a pixel, for marks with a faster lookup than the chart's generic search. */
  pick?(series: readonly Series[], px: number, py: number, frame: Frame): Hit | undefined;
  /**
   * A sentence describing what the mark shows, for marks without series
   * (annotations), which the chart's data summary would otherwise leave out.
   */
  describe?(format: AxisFormat, locale: string | undefined): string | undefined;
  /** The continuous color scale the mark draws with, if any. */
  colorRamp?(series: readonly Series[], theme: Theme): ColorRamp | undefined;
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
}

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
  readonly #cache = new TableCache<SeriesSource[]>();

  constructor(
    table: Table<Schema>,
    xField: string | undefined,
    yFields: readonly string[],
    seriesField: string | undefined,
    label: string | undefined,
  ) {
    this.table = table;
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
    return this.#cache.get(this.table, () => {
      const xField = this.xField;
      const field = this.seriesField;
      if (field === undefined) {
        const sorted = xField !== undefined && this.table.isSorted(xField as never);
        return this.yFields.map((y) => ({
          id: y,
          label: this.yFields.length === 1 ? (this.label ?? y) : y,
          y,
          rows: undefined,
          sorted,
        }));
      }
      const x = xField === undefined ? undefined : this.table.numbers(xField as never);
      const { codes, dictionary } = this.table.categories(field as never);
      const groups = groupRows(codes, dictionary.length);
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
      range: false,
      rows: source.rows,
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
  // Collect distinct values first: grids have far fewer distinct values than rows.
  const distinct = new Set<number>();
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (Number.isFinite(v)) distinct.add(v);
  }
  const unique = Float64Array.from(distinct).sort();
  const own = new Int32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    own[i] = Number.isFinite(v) ? lowerBound(unique, v) : -1;
  }
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
 * the chart keeps key lists stable while their contents do not change.
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
  const indices = new Int32Array(own.own.length);
  for (let i = 0; i < indices.length; i++) indices[i] = own.own[i]! >= 0 ? remap[own.own[i]!]! : -1;
  byField.set(field, { version: table.version, indices });
  return indices;
}
