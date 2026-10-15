import type { NumericArray } from "../data/column.ts";
import { scanExtent, type Table } from "../data/table.ts";
import type { Breaks, Mapping } from "../lod/m4.ts";
import type { RangeExtremes, RangeIndex } from "../lod/minmax-index.ts";
import type { TraceBuffers, TraceColumns, TraceSource } from "../lod/point-view.ts";
import type { Polyline } from "../lod/polyline.ts";
import type { SeriesFeatures } from "../model/features.ts";

/**
 * One drawable series: x and y columns, optionally restricted to a subset of
 * rows (one group of a long-format table). Positions 0..length-1 address
 * points; position k is row `rows[k]`, or row k when there is no subset.
 *
 * Column views are only valid for the table version they were read at.
 */
export interface Series {
  /** Unique within a chart; used for legend state and geometry identity. */
  key: string;
  /**
   * The identity key of what the series stands for (see model/identity.ts),
   * which its color and legend entry follow; the model sets it.
   */
  entry?: string | undefined;
  /** What its legend entry says, where not its `label`: a series colored by another field, that field's value. */
  entryLabel?: string | undefined;
  /**
   * The identity key of the value of the field splitting the mark's rows
   * that the series is, which marks dodging by that field place by.
   */
  partition?: string | undefined;
  /** Geometric rank in an inside-out stack, independent of legend order. */
  stackIndex?: number;
  label: string;
  color: string;
  x: NumericArray;
  /** Drawn position: the value, or the top of a stack or band. */
  y: NumericArray;
  /** Bottom of a stack or band, when the series has one. */
  y0: NumericArray | undefined;
  /** Left end of a horizontal stack (horizontal bars), when the series has one. */
  x0?: NumericArray | undefined;
  /** Values reported in tooltips (differs from `y` for stacks). */
  values: NumericArray;
  /** Visible position totals for normalized readings, shared across layers. */
  stackTotals?: NumericArray | undefined;
  /**
   * The table field `values` were read from, so indexes of that field can
   * serve `y` while it still is that column.
   */
  field?: string | undefined;
  /** The series is a band from `y0` to `y`; tooltips show both ends. */
  range: boolean;
  rows: Uint32Array | undefined;
  length: number;
  /** x is ascending over the series' points, enabling binary search and M4. */
  sorted: boolean;
  /**
   * For series of marks along y (lines and areas with `orient: "y"`): y is
   * ascending over the series' points, which they are traced and reduced by.
   */
  ySorted?: boolean | undefined;
  /** For `rows` grouped from a whole table as it streams. */
  stream?: SeriesStream | undefined;
  /**
   * For a layer of a stack drawn through edges of its own rather than
   * through its rows: series split by a field stack on the x positions of
   * all of them (see marks/union-stack.ts).
   */
  edges?: LayerEdges | undefined;
  /**
   * On a band axis holding only some of the chart's bands (a panel's own
   * categories), where its bands are: `x` or `y` then holds chart band
   * indices, which `placeAt` reads through this.
   */
  places?: { readonly x?: BandPlaces; readonly y?: BandPlaces } | undefined;
  /**
   * For some of a series' rows drawn apart (a highlight's selected and
   * dimmed rows), the series they are part of, which keeps what the mark
   * placed them by (see marks/dodge.ts).
   */
  whole?: Series | undefined;
  /** What the feature compiler resolved for the series: its paint, tracing, and markers. */
  features?: SeriesFeatures | undefined;
  /**
   * For a series of another's points copied in order (`traceSeries`), each
   * position's row of the table, which `rows` no longer says.
   */
  sources?: ArrayLike<number> | undefined;
}

/**
 * A stacked layer's edges at every position of its stack (along x, or along
 * y for areas along y), which it is drawn through: where the layer has no
 * row, it counts as zero or as interpolated (`StackGaps`). Views valid
 * until the stack's next update.
 */
export interface LayerEdges {
  order?: number;
  /** Positions, ascending; one is repeated for each of the rows a layer has there. */
  x: Float64Array;
  top: Float64Array;
  /** Undefined for the bottom layer, which stands on zero. */
  bottom: Float64Array | undefined;
  /** Min/max indexes of the edges, for long stacks. */
  indexes: { top: RangeIndex; bottom: RangeIndex | undefined } | undefined;
}

/**
 * Where chart bands are on an axis holding only some of them. Places keep
 * the chart's order: of two bands the axis holds, the earlier is placed first.
 */
export interface BandPlaces {
  /** The place of chart band `band` (at least 0), or -1 when the axis lacks it. */
  at(band: number): number;
  /** The chart band at place `place`, or -1 past the axis' bands. */
  band(place: number): number;
  /** Copies a trace through this panel's band positions, without rows hidden by breaks. */
  trace(s: TraceSource, buffers: TraceBuffers, breaks?: Breaks): TraceColumns;
}

/**
 * A long-format series' rows as their group follows a streaming table
 * (marks/split.ts): one key per group while it does, and how many rows the
 * group has lost from its front, so GPU uploads take appended points and
 * skip dropped ones. The group keeps min/max indexes of fields over its
 * rows, as tables keep them over whole columns, and brings the code that
 * reduces lines through rows as fast as along columns.
 */
export interface SeriesStream {
  readonly key: object;
  readonly dropped: number;
  /** Whether the group has a min/max index of `field`. */
  hasMinMaxIndex(field: string): boolean;
  /**
   * A min/max index of `field` over the series' positions (built on first
   * request), valid only for the table version the series was read at.
   */
  minMaxIndex(field: string): RangeIndex;
  /**
   * `m4` through the series' rows, column by column, on linear scales
   * without breaks (lod/m4-rows.ts); elsewhere it draws nothing and returns
   * false, for `m4` to reduce them.
   */
  m4(
    x: NumericArray,
    y: NumericArray,
    start: number,
    end: number,
    xMap: Mapping,
    yMap: Mapping,
    pixelRatio: number,
    out: Polyline,
    rows: Uint32Array | undefined,
    index?: RangeIndex,
  ): boolean;
}

export function rowOf(series: Series, position: number): number {
  return series.rows === undefined ? position : series.rows[position]!;
}

/** Where row `row` of `s` is placed along `axis`: its value, or its band's place (see `places`). */
export function placeAt(s: Series, axis: "x" | "y", row: number): number {
  const value = s[axis][row]!;
  const places = s.places?.[axis];
  return places && value >= 0 ? places.at(value) : value;
}

/**
 * The value tooltips and events report for row `row` of `s`: its value, or
 * where the series' values are its y categories (points along a category
 * y axis), the category's place, as positions along that axis are.
 */
export function valueAt(s: Series, row: number): number {
  return s.values === s.y ? placeAt(s, "y", row) : s.values[row]!;
}

/**
 * Whether two series place their points at the same positions along
 * `axis`, position by position: the same array read through the same rows
 * (fields of one table) and band places.
 */
export function samePositions(a: Series, b: Series, axis: "x" | "y"): boolean {
  if (a[axis] !== b[axis] || a.length !== b.length || a.places?.[axis] !== b.places?.[axis])
    return false;
  if (a.rows === b.rows) return true;
  if (!a.rows || !b.rows) return false;
  for (let i = 0; i < a.length; i++) if (a.rows[i] !== b.rows[i]) return false;
  return true;
}

export function xAt(series: Series, position: number): number {
  return series.x[rowOf(series, position)]!;
}

/** Splits rows by category code. Missing values (-1) belong to no group. */
export function rowsByCode(codes: Int32Array, groups: number, rows?: Uint32Array): Uint32Array[] {
  // Every row, or only `rows` (a row view's), in their order.
  const length = rows ? rows.length : codes.length;
  const rowAt = (k: number) => (rows ? rows[k]! : k);
  const counts = new Uint32Array(groups);
  for (let k = 0; k < length; k++) {
    const code = codes[rowAt(k)]!;
    if (code >= 0) counts[code]!++;
  }
  const out = Array.from(counts, (count) => new Uint32Array(count));
  counts.fill(0);
  for (let k = 0; k < length; k++) {
    const row = rowAt(k);
    const code = codes[row]!;
    if (code >= 0) out[code]![counts[code]!++] = row;
  }
  return out;
}

export function isSortedSubset(x: NumericArray, rows: Uint32Array): boolean {
  let previous = -Infinity;
  for (let k = 0; k < rows.length; k++) {
    const value = x[rows[k]!]!;
    if (!(value >= previous)) return false;
    previous = value;
  }
  return true;
}

/** First position whose x (or y, `axis`) is >= value (series sorted along it only). */
export function lowerPosition(series: Series, value: number, axis: "x" | "y" = "x"): number {
  const values = series[axis];
  let lo = 0;
  let hi = series.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[rowOf(series, mid)]! < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Positions to draw for an x domain: the points inside it plus one neighbor on
 * each side, so lines continue to the plot edge. Unsorted series draw all.
 */
export function visibleRange(series: Series, x0: number, x1: number): [number, number] {
  if (!series.sorted) return [0, series.length];
  const lo = Math.min(x0, x1);
  const hi = Math.max(x0, x1);
  const start = Math.max(0, lowerPosition(series, lo) - 1);
  let end = lowerPosition(series, hi);
  // Include points equal to hi, then one more.
  while (end < series.length && xAt(series, end) <= hi) end++;
  return [start, Math.min(series.length, end + 1)];
}

/** A value a scale can place: finite, and positive on log scales. */
function usable(value: number, log: boolean): boolean {
  return Number.isFinite(value) && (!log || value > 0);
}

/**
 * [min, max] of the y values a viewport [x0, x1] shows: points inside it,
 * plus, for sorted series, where segments cross its edges, so a line zoomed
 * in between two samples stays in view. With `log`, only positive values
 * count; with x `breaks`, only points they do not hide.
 */
export function yExtent(
  series: Series,
  x0: number,
  x1: number,
  y: Series["y"] = series.y,
  log = false,
  index?: RangeIndex,
  curved = false,
  breaks?: Breaks,
): [number, number] | undefined {
  const own = series.features?.extent;
  if (own) return own(series, x0, x1, y, log, index, curved, breaks);
  const lo = Math.min(x0, x1);
  const hi = Math.max(x0, x1);
  let [start, end] = visibleRange(series, x0, x1);
  // Sorted series (which never hold NaN x) are trimmed to the positions
  // inside [lo, hi], so their points need no x test.
  if (series.sorted) {
    while (start < end && xAt(series, start) < lo) start++;
    while (end > start && xAt(series, end - 1) > hi) end--;
  }
  // Sorted series with a min/max index of `y` (by position: of a whole
  // column, or of a long-format series' rows) take an index query; other
  // whole sorted columns, the common case, a plain scan.
  const linear = series.sorted && !log;
  const indexed = linear && index !== undefined && index.length === series.length;
  const extentOf = (a: number, b: number) =>
    indexed
      ? indexedExtent(index, series, y, a, b)
      : linear && series.rows === undefined
        ? scanExtent(y, a, b)
        : scanPositions(series, y, a, b, lo, hi, log, breaks);
  let inside: readonly [number, number] | undefined;
  if (breaks && series.sorted) {
    // Points inside breaks are not drawn: only the ranges between them count.
    const ranges = breaks.shown(series.x, start, end, series.rows);
    for (let r = 0; r < ranges.length; r += 2) {
      const extent = extentOf(ranges[r]!, ranges[r + 1]!);
      if (extent)
        inside = inside ? [Math.min(inside[0], extent[0]), Math.max(inside[1], extent[1])] : extent;
    }
  } else {
    inside = extentOf(start, end);
  }
  let [min, max] = inside ?? [Infinity, -Infinity];
  if (series.sorted) {
    for (const edge of [lo, hi]) {
      const value = curved
        ? outsideAt(series, y, edge, edge === lo, breaks)
        : interpolateAt(series, y, edge, breaks);
      if (!usable(value, log)) continue;
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  return min <= max ? [min, max] : undefined;
}

const extremes: RangeExtremes = { low: -1, high: -1, gap: false };

function indexedExtent(
  index: RangeIndex,
  series: Series,
  y: Series["y"],
  start: number,
  end: number,
): [number, number] | undefined {
  const { low, high } = index.query(y, start, end, extremes);
  return low < 0 ? undefined : [y[rowOf(series, low)]!, y[rowOf(series, high)]!];
}

/**
 * [min, max] of usable y values at positions [start, end) whose x is in
 * [lo, hi] and not hidden by `breaks`.
 */
function scanPositions(
  series: Series,
  y: Series["y"],
  start: number,
  end: number,
  lo: number,
  hi: number,
  log: boolean,
  breaks?: Breaks,
): [number, number] | undefined {
  let min = Infinity;
  let max = -Infinity;
  const { rows, x } = series;
  if (rows === undefined && !series.sorted && !log && !breaks) {
    // A whole unsorted column (scatter plots): one tight loop.
    for (let k = start; k < end; k++) {
      const at = x[k]!;
      if (!(at >= lo && at <= hi)) continue;
      const value = y[k]!;
      if (value < min && value > -Infinity) min = value;
      if (value > max && value < Infinity) max = value;
    }
    return min <= max ? [min, max] : undefined;
  }
  // Sorted series are given shown ranges; others are checked point by point.
  const hides = !series.sorted && breaks ? breaks : undefined;
  for (let k = start; k < end; k++) {
    const row = rowOf(series, k);
    if (!series.sorted) {
      const at = x[row]!;
      if (!(at >= lo && at <= hi) || hides?.hides(at)) continue;
    }
    const value = y[row]!;
    if (!usable(value, log)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return min <= max ? [min, max] : undefined;
}

/**
 * y where the segment spanning x = `at` crosses it, or NaN when no segment
 * does. With `breaks`, the segment joins the shown points either side,
 * straight in positions (time shown), as it is drawn.
 */
function interpolateAt(series: Series, y: Series["y"], at: number, breaks?: Breaks): number {
  let after = lowerPosition(series, at);
  let before = after - 1;
  if (breaks) {
    after = breaks.shownFrom(series.x, after, series.length, series.rows);
    before = breaks.shownBefore(series.x, before, series.rows);
  }
  if (before < 0 || after >= series.length) return Number.NaN;
  const a = rowOf(series, before);
  const b = rowOf(series, after);
  const place = (v: number) => (breaks ? breaks.collapse(v) : v);
  const xa = place(series.x[a]!);
  const xb = place(series.x[b]!);
  const ya = y[a]!;
  const yb = y[b]!;
  if (!(Number.isFinite(ya) && Number.isFinite(yb)) || xb === xa) return Number.NaN;
  return ya + ((yb - ya) * (place(at) - xa)) / (xb - xa);
}

/**
 * The value of the point just outside the range across the edge at `at`
 * (`lower`: the last before it; else the first after it). A monotone curve
 * from it to the next point stays between their values, so including it
 * bounds the part of that curve in view, on any scale, whether it is drawn
 * curved or straight.
 */
function outsideAt(
  series: Series,
  y: Series["y"],
  at: number,
  lower: boolean,
  breaks?: Breaks,
): number {
  const after = lowerPosition(series, at);
  let k = lower ? after - 1 : after;
  // The first point past `at`, not one equal to it.
  if (!lower) while (k < series.length && xAt(series, k) <= at) k++;
  // Hidden points are not drawn, so the curve runs to the shown ones beyond.
  if (breaks)
    k = lower
      ? breaks.shownBefore(series.x, k, series.rows)
      : breaks.shownFrom(series.x, k, series.length, series.rows);
  return k >= 0 && k < series.length ? y[rowOf(series, k)]! : Number.NaN;
}

/** [min, max] of x values a scale can place; with `log`, only positive ones. */
export function xExtent(series: Series, log = false): [number, number] | undefined {
  let min = Infinity;
  let max = -Infinity;
  if (series.sorted && series.length > 0 && !log) {
    // Sorted series: the ends, skipping non-finite values.
    for (let k = 0; k < series.length && min === Infinity; k++) {
      const x = xAt(series, k);
      if (Number.isFinite(x)) min = x;
    }
    for (let k = series.length - 1; k >= 0 && max === -Infinity; k--) {
      const x = xAt(series, k);
      if (Number.isFinite(x)) max = x;
    }
  } else if (series.rows === undefined && !log) {
    // A whole unsorted column, as in a scatter plot: a plain scan.
    return scanExtent(series.x, 0, series.length);
  } else {
    for (let k = 0; k < series.length; k++) {
      const x = xAt(series, k);
      if (!usable(x, log)) continue;
      if (x < min) min = x;
      if (x > max) max = x;
    }
  }
  return min <= max ? [min, max] : undefined;
}

/** Position of the point whose x is nearest `value`, or -1 for an empty series. */
export function nearestPosition(series: Series, value: number): number {
  if (series.length === 0) return -1;
  if (series.sorted) {
    const after = Math.min(lowerPosition(series, value), series.length - 1);
    const before = Math.max(0, after - 1);
    return Math.abs(xAt(series, before) - value) <= Math.abs(xAt(series, after) - value)
      ? before
      : after;
  }
  let best = -1;
  let bestDistance = Infinity;
  for (let k = 0; k < series.length; k++) {
    const distance = Math.abs(xAt(series, k) - value);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = k;
    }
  }
  return best;
}

/** Caches a computation until the table changes. */
export class TableCache<T> {
  #version = -1;
  #table: Table | undefined;
  #value: T | undefined;

  get(table: Table, compute: () => T): T {
    if (this.#table !== table || this.#version !== table.version || this.#value === undefined) {
      this.#value = compute();
      this.#table = table;
      this.#version = table.version;
    }
    return this.#value;
  }
}
