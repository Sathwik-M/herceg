import type { NumericArray } from "../data/column.ts";
import type { MinMaxIndex, RangeExtremes } from "./minmax-index.ts";
import type { Polyline } from "./polyline.ts";

/**
 * Maps a value to pixels: `offset + (v - origin) * factor`, where `v` is the
 * value or, for log scales, its base-10 logarithm.
 */
export interface Mapping {
  readonly origin: number;
  readonly offset: number;
  readonly factor: number;
  readonly log: boolean;
}

export function mapValue(mapping: Mapping, value: number): number {
  return (
    mapping.offset + ((mapping.log ? Math.log10(value) : value) - mapping.origin) * mapping.factor
  );
}

/** Values a mapping cannot place: non-finite, or not positive on a log scale. */
function unmappable(mapping: Mapping, value: number): boolean {
  return !Number.isFinite(value) || (mapping.log && value <= 0);
}

/**
 * Writes the line through `x[i], y[i]` for `i` in `[start, end)` into `out`,
 * in pixels, reduced with M4 aggregation: within each device-pixel column only
 * the first, minimum, maximum, and last points are kept, at their real
 * positions and in traversal order. A line through the reduced points covers
 * the same pixel columns over the same vertical extents as the full line
 * (Jugel et al., "M4", VLDB 2014), so output is bounded by 4 points per column
 * regardless of input size. Log scales are monotonic, so the extreme points
 * are the same before and after mapping; values a scale cannot place (NaN,
 * infinities, non-positive values on log scales) leave gaps.
 *
 * `x` must be ascending over the range. Non-finite y values end the current
 * run and leave a gap. `pixelRatio` sets the column width (1 / pixelRatio CSS
 * pixels). When `rows` is given, positions `start..end` index into it and the
 * point at position k is row `rows[k]`; this draws one group of a long-format
 * table without copying it. An `index` of `y` lets dense ranges skip the
 * scan: each column's extremes are read from it, unless gaps are so common
 * that most columns would be scanned anyway.
 */
export function m4(
  x: NumericArray,
  y: NumericArray,
  start: number,
  end: number,
  xMap: Mapping,
  yMap: Mapping,
  pixelRatio: number,
  out: Polyline,
  rows?: Uint32Array,
  index?: MinMaxIndex,
): void {
  if (rows === undefined && !xMap.log && !yMap.log && xMap.factor > 0) {
    // Index queries cost about as much as scanning 200 points.
    const columns = (x[end - 1]! - x[start]!) * xMap.factor * pixelRatio;
    if (index && index.gapShare < 0.1 && end - start > 200 * Math.max(1, columns)) {
      m4Indexed(x, y, start, end, xMap, yMap, pixelRatio, out, index);
    } else {
      m4Columns(x, y, start, end, xMap, yMap, pixelRatio, out);
    }
  } else {
    m4Points(x, y, start, end, xMap, yMap, pixelRatio, out, rows);
  }
}

/**
 * M4 for a whole column on linear scales, column by column: each pixel
 * column's points are found by comparing x with a threshold left of the
 * column's right edge instead of mapping every point, and its extremes by
 * plain comparisons. The threshold is checked with the exact column formula;
 * since the floating-point mapping never decreases, every x below it maps to
 * the same column, and points at or past it get the exact test. Output is
 * identical to `m4Points`, including gaps for values the scale cannot place.
 */
function m4Columns(
  x: NumericArray,
  y: NumericArray,
  start: number,
  end: number,
  xMap: Mapping,
  yMap: Mapping,
  pixelRatio: number,
  out: Polyline,
): void {
  const xo = xMap.offset * pixelRatio;
  const xf = xMap.factor * pixelRatio;
  const xOrigin = xMap.origin;
  if (!(Number.isFinite(xo) && Number.isFinite(xf) && Number.isFinite(xOrigin))) {
    m4Points(x, y, start, end, xMap, yMap, pixelRatio, out);
    return;
  }
  let k = start;
  while (k < end) {
    const first = k;
    const firstX = x[k]!;
    let lowValue = y[k]!;
    if (!(Number.isFinite(firstX) && Number.isFinite(lowValue))) {
      // A value the scale cannot place ends the run, as in `m4Points`.
      out.break();
      k++;
      continue;
    }
    const c = Math.floor(xo + (firstX - xOrigin) * xf);
    let highValue = lowValue;
    let low = k;
    let high = k;
    // A millionth of a column left of the edge, verified to map to c.
    const edge = xOrigin + (c + 1 - xo) / xf;
    let safe = edge - (1e-6 / xf + Math.abs(edge) * 1e-15);
    if (!(Math.floor(xo + (safe - xOrigin) * xf) === c)) safe = Number.NEGATIVE_INFINITY;
    k++;
    for (; k < end; k++) {
      const xv = x[k]!;
      // Next column, or an x the scale cannot place (NaN fails `<`).
      if (!(xv < safe) && (!Number.isFinite(xv) || Math.floor(xo + (xv - xOrigin) * xf) !== c))
        break;
      const value = y[k]!;
      // NaN fails both comparisons, so only then is it tested for.
      if (value < lowValue) {
        if (value === Number.NEGATIVE_INFINITY) break;
        low = k;
        lowValue = value;
      } else if (value > highValue) {
        if (value === Number.POSITIVE_INFINITY) break;
        high = k;
        highValue = value;
      } else if (Number.isNaN(value)) {
        break;
      }
    }
    // Points from k on start the next column, or are a gap that the outer
    // loop turns into a break.
    emitColumn(x, y, first, low, high, k - 1, xMap, yMap, out, undefined);
  }
}

const extremes: RangeExtremes = { low: -1, high: -1, gap: false };

/**
 * M4 for dense ranges with a min/max index of `y`: each column's end is found
 * by binary search (column membership only changes once along sorted x, by
 * the same exact test as `m4Columns`) and its extremes by an index query.
 * Columns with gaps are scanned by `m4Columns`. Output is identical to
 * `m4Points`.
 */
function m4Indexed(
  x: NumericArray,
  y: NumericArray,
  start: number,
  end: number,
  xMap: Mapping,
  yMap: Mapping,
  pixelRatio: number,
  out: Polyline,
  index: MinMaxIndex,
): void {
  const xo = xMap.offset * pixelRatio;
  const xf = xMap.factor * pixelRatio;
  const xOrigin = xMap.origin;
  if (!(Number.isFinite(xo) && Number.isFinite(xf) && Number.isFinite(xOrigin))) {
    m4Points(x, y, start, end, xMap, yMap, pixelRatio, out);
    return;
  }
  let k = start;
  while (k < end) {
    const firstX = x[k]!;
    if (!(Number.isFinite(firstX) && Number.isFinite(y[k]!))) {
      out.break();
      k++;
      continue;
    }
    const c = Math.floor(xo + (firstX - xOrigin) * xf);
    // First position past the column: x not finite, or mapped to another column.
    let lo = k + 1;
    let hi = end;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const xv = x[mid]!;
      if (!Number.isFinite(xv) || Math.floor(xo + (xv - xOrigin) * xf) !== c) hi = mid;
      else lo = mid + 1;
    }
    index.query(y, k, lo, extremes);
    if (extremes.gap) {
      m4Columns(x, y, k, lo, xMap, yMap, pixelRatio, out);
    } else {
      emitColumn(x, y, k, extremes.low, extremes.high, lo - 1, xMap, yMap, out, undefined);
    }
    k = lo;
  }
}

/** M4 point by point, for log scales, row subsets, and columns with gaps. */
function m4Points(
  x: NumericArray,
  y: NumericArray,
  start: number,
  end: number,
  xMap: Mapping,
  yMap: Mapping,
  pixelRatio: number,
  out: Polyline,
  rows?: Uint32Array,
): void {
  // Column math runs in device pixels.
  const xo = xMap.offset * pixelRatio;
  const xf = xMap.factor * pixelRatio;
  const xOrigin = xMap.origin;
  const xLog = xMap.log;
  let column = Number.NaN;
  // Positions (not rows) of the first, lowest, highest, and last points in
  // the open column, so emission follows traversal order.
  let first = -1;
  let low = -1;
  let high = -1;
  let last = -1;
  let lowValue = 0;
  let highValue = 0;

  for (let k = start; k < end; k++) {
    const i = rows === undefined ? k : rows[k]!;
    const value = y[i]!;
    const xv = x[i]!;
    if (unmappable(yMap, value) || unmappable(xMap, xv)) {
      if (first >= 0) emitColumn(x, y, first, low, high, last, xMap, yMap, out, rows);
      first = -1;
      column = Number.NaN;
      out.break();
      continue;
    }
    const c = Math.floor(xo + ((xLog ? Math.log10(xv) : xv) - xOrigin) * xf);
    if (c !== column) {
      if (first >= 0) emitColumn(x, y, first, low, high, last, xMap, yMap, out, rows);
      column = c;
      first = low = high = last = k;
      lowValue = highValue = value;
      continue;
    }
    last = k;
    if (value < lowValue) {
      low = k;
      lowValue = value;
    } else if (value > highValue) {
      high = k;
      highValue = value;
    }
  }
  if (first >= 0) emitColumn(x, y, first, low, high, last, xMap, yMap, out, rows);
}

function emitColumn(
  x: NumericArray,
  y: NumericArray,
  first: number,
  low: number,
  high: number,
  last: number,
  xMap: Mapping,
  yMap: Mapping,
  out: Polyline,
  rows: Uint32Array | undefined,
) {
  const a = low < high ? low : high;
  const b = low < high ? high : low;
  emitPoint(x, y, first, xMap, yMap, out, rows);
  if (a !== first && a !== last) emitPoint(x, y, a, xMap, yMap, out, rows);
  if (b !== first && b !== last && b !== a) emitPoint(x, y, b, xMap, yMap, out, rows);
  if (last !== first) emitPoint(x, y, last, xMap, yMap, out, rows);
}

function emitPoint(
  x: NumericArray,
  y: NumericArray,
  position: number,
  xMap: Mapping,
  yMap: Mapping,
  out: Polyline,
  rows: Uint32Array | undefined,
): void {
  const row = rows === undefined ? position : rows[position]!;
  out.push(mapValue(xMap, x[row]!), mapValue(yMap, y[row]!));
}

/** Writes every point without reduction, for unsorted x. */
export function polylineAll(
  x: NumericArray,
  y: NumericArray,
  start: number,
  end: number,
  xMap: Mapping,
  yMap: Mapping,
  out: Polyline,
  rows?: Uint32Array,
): void {
  for (let k = start; k < end; k++) {
    const i = rows === undefined ? k : rows[k]!;
    const xv = x[i]!;
    const yv = y[i]!;
    if (unmappable(xMap, xv) || unmappable(yMap, yv)) {
      out.break();
      continue;
    }
    out.push(mapValue(xMap, xv), mapValue(yMap, yv));
  }
}
