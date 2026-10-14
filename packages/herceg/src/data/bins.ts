// Bins along one axis, as histograms and the `bin` transform take them
// (`BinSpec`): about how many round bins, a width and where they start, or
// their edges. Both find a value's bin the same way: from its left edge up
// to its right one, the last bin holding its right edge too, as NumPy's do.

import { niceDomain, tickStep } from "../scale/ticks.ts";
import type { BinSpec } from "../spec/spec.ts";

/** Most bins along an axis; explicit edges past it are refused rather than coarsened. */
export const MAX_BINS = 1000;

/** The finite values binned: the least, the greatest, and how many there are. */
export interface BinRange {
  readonly min: number;
  readonly max: number;
  readonly finite: number;
}

/** A range of no values, to start from. */
export const NO_RANGE: BinRange = { min: Infinity, max: -Infinity, finite: 0 };

/**
 * Throws unless `bins` is a bin definition: a whole number of at least 1,
 * `{ step, start }` with a positive finite step, or 2 to 1,001 finite,
 * increasing edges. `path` names it in errors.
 */
export function checkBins(bins: unknown, path: string): void {
  if (typeof bins === "number") {
    if (!(Number.isInteger(bins) && bins >= 1))
      throw new RangeError(`${path}: expected a whole number of at least 1; received ${bins}`);
    return;
  }
  if (Array.isArray(bins)) {
    requireEdges(bins, path);
    return;
  }
  if (typeof bins !== "object" || bins === null)
    throw new TypeError(
      `${path}: expected a bin count, { step, start }, or edges; received ${JSON.stringify(bins)}`,
    );
  const { step, start } = bins as { step?: unknown; start?: unknown };
  if (typeof step !== "number" || !(step > 0 && Number.isFinite(step)))
    throw new RangeError(`${path}.step: expected a positive number; received ${String(step)}`);
  if (start !== undefined && (typeof start !== "number" || !Number.isFinite(start)))
    throw new RangeError(`${path}.start: expected a finite number; received ${String(start)}`);
}

/** Checks supplied edges without changing their precision or their range. */
export function requireEdges(edges: readonly unknown[], path: string): void {
  if (edges.length < 2 || edges.length > MAX_BINS + 1)
    throw new RangeError(`${path}: expected 2 to ${MAX_BINS + 1} edges; received ${edges.length}`);
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    if (typeof edge !== "number" || !Number.isFinite(edge))
      throw new RangeError(`${path}[${i}]: expected a finite number; received ${String(edge)}`);
    if (i > 0 && !(edge > (edges[i - 1] as number)))
      throw new RangeError(
        `${path}[${i}]: expected a number above ${edges[i - 1]}, the edge before; received ${edge}`,
      );
  }
}

/** `range` widened by the finite values at `rows` (every row without them). */
export function finiteRange(
  values: ArrayLike<number>,
  rows: Uint32Array | undefined,
  range: BinRange = NO_RANGE,
): BinRange {
  let { min, max, finite } = range;
  // A whole column, the one chart's case, in a loop of its own.
  if (!rows) {
    for (let row = 0; row < values.length; row++) {
      const value = values[row]!;
      if (!Number.isFinite(value)) continue;
      finite++;
      if (value < min) min = value;
      if (value > max) max = value;
    }
    return { min, max, finite };
  }
  for (let k = 0; k < rows.length; k++) {
    const value = values[rows[k]!]!;
    if (!Number.isFinite(value)) continue;
    finite++;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { min, max, finite };
}

/**
 * Bin edges for `bins` covering `range`: explicit edges as given; fixed
 * widths from the start (values below an explicit one are outside); or about
 * a count of round bins, `count` by default (multiples of 1, 2, or 5 times a
 * power of ten, or what `calendar` gives for times), coarser when round ones
 * would pass MAX_BINS, evenly spaced when they cannot be represented. None
 * for no values.
 */
export function binEdges(
  bins: BinSpec | undefined,
  range: BinRange,
  count: number,
  calendar?: (min: number, max: number, count: number) => number[],
): Float64Array {
  if (Array.isArray(bins)) return Float64Array.from(bins as readonly number[]);
  const { min, max, finite } = range;
  if (finite === 0) return NO_BINS;
  if (typeof bins === "object")
    return Float64Array.from(fixedEdges(min, max, bins as { step: number; start?: number }));
  // One value, or values all alike: one bin around them.
  if (min === max) return Float64Array.from(around(min, calendar ? 1_800_000 : 0.5));
  const target = Math.min(MAX_BINS, (bins as number | undefined) ?? count);
  for (let n = target; n >= 1; n = Math.floor(n / 2)) {
    const edges = calendar ? calendar(min, max, n) : roundEdges(min, max, n);
    if (valid(edges, min, max)) return Float64Array.from(edges);
  }
  return Float64Array.from(evenEdges(min, max, target));
}

export const NO_BINS = new Float64Array(0);

/** Edges usable for counting: finite, increasing, at most MAX_BINS bins, and covering [min, max]. */
function valid(edges: readonly number[], min: number, max: number): boolean {
  if (edges.length < 2 || edges.length - 1 > MAX_BINS) return false;
  if (!(edges[0]! <= min && edges[edges.length - 1]! >= max)) return false;
  for (let i = 0; i < edges.length; i++) {
    if (!Number.isFinite(edges[i]!) || (i > 0 && !(edges[i]! > edges[i - 1]!))) return false;
  }
  return true;
}

/** About `count` bins on multiples of a round step (1, 2, or 5 times a power of ten). */
function roundEdges(min: number, max: number, count: number): number[] {
  const [lo, hi] = niceDomain(min, max, count);
  // Round steps have one significant digit; reading them back from it undoes
  // the rounding of powers of ten (0.00009999999999999999 for 0.0001).
  const step = Number(tickStep(lo, hi, count).toPrecision(1));
  const bins = Math.round((hi - lo) / step);
  return bins >= 1 && bins <= MAX_BINS ? multiples(Math.round(lo / step), step, bins) : [];
}

/**
 * Edges of fixed width `step` from `start`, or by default from the multiple
 * of `step` at or below the minimum, through the maximum. Values below an
 * explicit start fall outside the bins.
 */
function fixedEdges(min: number, max: number, bins: { step: number; start?: number }): number[] {
  const first = Math.floor(min / bins.step);
  // A start too far out for multiples of the step begins at the minimum.
  const aligned = bins.start === undefined && Number.isFinite(first * bins.step);
  const start = bins.start ?? (aligned ? first * bins.step : min);
  const from = Math.max(min, start);
  const span = max - start;
  // Steps too fine for the range widen to keep the bin count bounded.
  const step = Number.isFinite(span) ? Math.max(bins.step, span / (MAX_BINS - 1)) : bins.step;
  const count = Number.isFinite(span) ? Math.ceil(span / step - 1e-9) : MAX_BINS;
  const bounded = Math.min(MAX_BINS - 1, Math.max(1, count));
  // The last edge must reach the maximum; it may land exactly on it.
  const build = (n: number) =>
    aligned && step === bins.step ? multiples(first, step, n) : offsets(start, step, n);
  let edges = build(bounded);
  if (edges[edges.length - 1]! < max) edges = build(bounded + 1);
  if (valid(edges, from, max)) return edges;
  if (from > max) return [start, start + bins.step];
  const even = evenEdges(from, max, bounded);
  return valid(even, from, max) ? even : around(from, 0.5);
}

/**
 * The edges `index * step` for `count` bins from `first`. On a decimal step
 * (few decimals) they are integers divided by a power of ten, so the edge
 * at 0.3 is exactly 0.3 and the value 0.3 falls in the bin it starts.
 */
function multiples(first: number, step: number, count: number): number[] {
  const digits = decimals(step);
  if (digits > 0 && digits <= 15) {
    const scale = 10 ** digits;
    const unit = Math.round(step * scale);
    if (Number.isSafeInteger(first * unit) && Number.isSafeInteger((first + count) * unit)) {
      return Array.from({ length: count + 1 }, (_, i) => ((first + i) * unit) / scale);
    }
  }
  return Array.from({ length: count + 1 }, (_, i) => (first + i) * step);
}

/**
 * `start + i * step` for `count` bins; on a decimal grid (start and step
 * with few decimals), integers divided by a power of ten as in `multiples`.
 */
function offsets(start: number, step: number, count: number): number[] {
  const digits = Math.max(decimals(start), decimals(step));
  if (digits <= 15) {
    const scale = 10 ** digits;
    const first = Math.round(start * scale);
    const unit = Math.round(step * scale);
    if (unit > 0 && Number.isSafeInteger(first) && Number.isSafeInteger(first + count * unit)) {
      return Array.from({ length: count + 1 }, (_, i) => (first + i * unit) / scale);
    }
  }
  return Array.from({ length: count + 1 }, (_, i) => start + i * step);
}

/** Decimal places in a number's shortest representation. */
function decimals(value: number): number {
  const [mantissa, exponent] = String(Math.abs(value)).split("e");
  const places = mantissa!.split(".")[1]?.length ?? 0;
  return Math.max(0, places - Number(exponent ?? 0));
}

/**
 * `count` equal bins from `min` to `max` by interpolation, which neither
 * overflows nor accumulates error; neighbors closer than the precision of
 * the values merge.
 */
function evenEdges(min: number, max: number, count: number): number[] {
  const edges: number[] = [min];
  for (let i = 1; i <= count; i++) {
    const t = i / count;
    const edge = i === count ? max : min * (1 - t) + max * t;
    if (edge > edges[edges.length - 1]!) edges.push(edge);
  }
  return edges.length >= 2 ? edges : around(min, 0.5);
}

/** One bin around `value`, at least `half` to each side and wide enough to represent. */
function around(value: number, half: number): number[] {
  const width = Math.max(half, Math.abs(value) * 2 ** -40);
  const lo = value - width;
  const hi = value + width;
  // At the ends of the number range the bin keeps the value as its edge.
  return [Number.isFinite(lo) ? lo : value, Number.isFinite(hi) ? hi : value];
}

/** The center of each bin; halves first, so centers of edges near the number range's ends stay finite. */
export function centersOf(edges: Float64Array): Float64Array {
  const bins = Math.max(0, edges.length - 1);
  const centers = new Float64Array(bins);
  for (let i = 0; i < bins; i++) centers[i] = edges[i]! / 2 + edges[i + 1]! / 2;
  return centers;
}

/**
 * The width of edges a `step` apart (all but calendar bins and explicit
 * edges), so that a value's bin is found by division, not search; 0 when
 * they are not. Counting loops call the two lookups directly rather than
 * through a closure choosing one, which costs them about a tenth more time.
 */
export function evenStep(edges: Float64Array): number {
  const bins = edges.length - 1;
  if (bins < 1) return 0;
  const step = (edges[bins]! - edges[0]!) / bins;
  const even = edges.every((edge, i) => Math.abs(edge - (edges[0]! + i * step)) <= step * 1e-9);
  return even && step > 0 ? step : 0;
}

/** `binOf` for edges a `step` apart: the bin by division, corrected for rounding at edges. */
export function evenBinOf(edges: Float64Array, step: number, value: number): number {
  const bins = edges.length - 1;
  if (!(value >= edges[0]! && value <= edges[bins]!)) return -1;
  let bin = Math.min(bins - 1, Math.floor((value - edges[0]!) / step));
  if (value < edges[bin]!) bin--;
  else if (bin < bins - 1 && value >= edges[bin + 1]!) bin++;
  return bin;
}

/**
 * The bin holding `value`: the last edge at or below it, with the final
 * bin also holding its right edge; -1 outside the edges or for a missing value.
 */
export function binOf(edges: ArrayLike<number>, value: number): number {
  const bins = edges.length - 1;
  if (!(value >= edges[0]! && value <= edges[bins]!)) return -1;
  let lo = 0;
  let hi = bins;
  while (hi - lo > 1) {
    const middle = (lo + hi) >> 1;
    if (value >= edges[middle]!) lo = middle;
    else hi = middle;
  }
  return lo;
}
