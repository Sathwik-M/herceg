import type { NumericArray } from "../data/column.ts";
import { scanExtent, type Table } from "../data/table.ts";
import type { RangeExtremes, RangeIndex } from "../lod/minmax-index.ts";

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
}

export function rowOf(series: Series, position: number): number {
  return series.rows === undefined ? position : series.rows[position]!;
}

export function xAt(series: Series, position: number): number {
  return series.x[rowOf(series, position)]!;
}

/** Splits rows by category code. Missing values (-1) belong to no group. */
export function groupRows(codes: Int32Array, groups: number): Uint32Array[] {
  const counts = new Uint32Array(groups);
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i]!;
    if (code >= 0) counts[code]!++;
  }
  const out = Array.from(counts, (count) => new Uint32Array(count));
  counts.fill(0);
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i]!;
    if (code >= 0) out[code]![counts[code]!++] = i;
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

/** First position whose x is >= value (sorted series only). */
export function lowerPosition(series: Series, value: number): number {
  let lo = 0;
  let hi = series.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (xAt(series, mid) < value) lo = mid + 1;
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
 * count.
 */
export function yExtent(
  series: Series,
  x0: number,
  x1: number,
  y: Series["y"] = series.y,
  log = false,
  index?: RangeIndex,
): [number, number] | undefined {
  const lo = Math.min(x0, x1);
  const hi = Math.max(x0, x1);
  let [start, end] = visibleRange(series, x0, x1);
  // Sorted series (which never hold NaN x) are trimmed to the positions
  // inside [lo, hi], so their points need no x test.
  if (series.sorted) {
    while (start < end && xAt(series, start) < lo) start++;
    while (end > start && xAt(series, end - 1) > hi) end--;
  }
  // The common case, a whole sorted column, is a plain scan, or an index
  // query when the column has a min/max index.
  const whole = series.rows === undefined && series.sorted && !log;
  const inside = !whole
    ? scanPositions(series, y, start, end, lo, hi, log)
    : index && index.length === y.length
      ? indexedExtent(index, y, start, end)
      : scanExtent(y, start, end);
  let [min, max] = inside ?? [Infinity, -Infinity];
  if (series.sorted) {
    for (const edge of [lo, hi]) {
      const value = interpolateAt(series, y, edge);
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
  y: Series["y"],
  start: number,
  end: number,
): [number, number] | undefined {
  const { low, high } = index.query(y, start, end, extremes);
  return low < 0 ? undefined : [y[low]!, y[high]!];
}

/** [min, max] of usable y values at positions [start, end) whose x is in [lo, hi]. */
function scanPositions(
  series: Series,
  y: Series["y"],
  start: number,
  end: number,
  lo: number,
  hi: number,
  log: boolean,
): [number, number] | undefined {
  let min = Infinity;
  let max = -Infinity;
  const { rows, x } = series;
  if (rows === undefined && !series.sorted && !log) {
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
  for (let k = start; k < end; k++) {
    const row = rowOf(series, k);
    if (!series.sorted) {
      const at = x[row]!;
      if (!(at >= lo && at <= hi)) continue;
    }
    const value = y[row]!;
    if (!usable(value, log)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return min <= max ? [min, max] : undefined;
}

/** y where the segment spanning x = `at` crosses it, or NaN when no segment does. */
function interpolateAt(series: Series, y: Series["y"], at: number): number {
  const after = lowerPosition(series, at);
  if (after <= 0 || after >= series.length) return Number.NaN;
  const a = rowOf(series, after - 1);
  const b = rowOf(series, after);
  const xa = series.x[a]!;
  const xb = series.x[b]!;
  const ya = y[a]!;
  const yb = y[b]!;
  if (!(Number.isFinite(ya) && Number.isFinite(yb)) || xb === xa) return Number.NaN;
  return ya + ((yb - ya) * (at - xa)) / (xb - xa);
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

/**
 * Position of the point nearest `value` among those with x in [lo, hi], or
 * -1 when none is.
 */
export function nearestPositionWithin(
  series: Series,
  value: number,
  lo: number,
  hi: number,
): number {
  if (!series.sorted) {
    let best = -1;
    let bestDistance = Infinity;
    for (let k = 0; k < series.length; k++) {
      const x = xAt(series, k);
      if (!(x >= lo && x <= hi)) continue;
      const distance = Math.abs(x - value);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = k;
      }
    }
    return best;
  }
  let k = nearestPosition(series, value);
  if (k < 0) return -1;
  if (xAt(series, k) < lo) k = lowerPosition(series, lo);
  else if (xAt(series, k) > hi) {
    k = lowerPosition(series, hi);
    if (k >= series.length || xAt(series, k) > hi) k--;
  }
  const x = k >= 0 && k < series.length ? xAt(series, k) : Number.NaN;
  return x >= lo && x <= hi ? k : -1;
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
