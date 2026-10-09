// M4 on a time axis with breaks: pixel columns follow positions with the
// breaks taken out, and points inside a break are left out without breaking
// the line. Loaded with scale/breaks.ts, only by charts with breaks.

import type { NumericArray } from "../data/column.ts";
import { type Breaks, emitColumn, type Mapping, unmappable } from "./m4.ts";
import type { RangeExtremes, RangeIndex } from "./minmax-index.ts";
import type { Polyline } from "./polyline.ts";

const extremes: RangeExtremes = { low: -1, high: -1, gap: false };

/**
 * Writes the line through the shown points among positions [start, end) of
 * ascending `x`, reduced as `m4` reduces it: per device-pixel column, the
 * first, lowest, highest, and last points, in order. A column is the floor
 * of `xo + (collapse(x) - origin) * xf`, the same arithmetic for every
 * point, so the result does not depend on the path taken. A column may
 * gather points from both sides of a break; its points are emitted once.
 *
 * Whole columns of linear data take the fast paths of `m4`: the points of a
 * column are found by comparing x with a threshold (a position left of the
 * column's edge, taken back to a value and checked with the exact column
 * formula) or, with a min/max index of dense data, by binary search and an
 * index query. Other data goes point by point.
 */
export function brokenM4(
  breaks: Breaks,
  x: NumericArray,
  y: NumericArray,
  start: number,
  end: number,
  xMap: Mapping,
  yMap: Mapping,
  pixelRatio: number,
  out: Polyline,
  rows?: Uint32Array,
  index?: RangeIndex,
): void {
  const xo = xMap.offset * pixelRatio;
  const xf = xMap.factor * pixelRatio;
  const xOrigin = xMap.origin;
  const columnOf = (value: number) => Math.floor(xo + (breaks.collapse(value) - xOrigin) * xf);
  const ranges = breaks.shown(x, start, end, rows);
  // Fast paths read whole columns of linear data.
  const fast = rows === undefined && !yMap.log && xf > 0 && Number.isFinite(xo + xf + xOrigin);
  let dense = false;
  if (fast && index && index.gapShare < 0.1 && end - start > 0) {
    // Index queries cost about as much as scanning 200 points.
    const columns = (breaks.collapse(x[end - 1]!) - breaks.collapse(x[start]!)) * xf;
    dense = end - start > 200 * Math.max(1, columns);
  }
  // The open column: its pixel column and the positions of its first,
  // lowest, highest, and last points.
  let column = Number.NaN;
  let first = -1;
  let low = -1;
  let high = -1;
  let last = -1;
  let lowValue = 0;
  let highValue = 0;
  const flush = () => {
    if (first >= 0) emitColumn(x, y, first, low, high, last, xMap, yMap, out, rows);
    first = -1;
    column = Number.NaN;
  };
  for (let r = 0; r < ranges.length; r += 2) {
    const rangeEnd = ranges[r + 1]!;
    let k = ranges[r]!;
    while (k < rangeEnd) {
      const row = rows === undefined ? k : rows[k]!;
      const xv = x[row]!;
      const value = y[row]!;
      if (unmappable(yMap, value) || !Number.isFinite(xv)) {
        // A missing value breaks the line, as it does without breaks.
        flush();
        out.break();
        k++;
        continue;
      }
      const c = columnOf(xv);
      if (c !== column) {
        flush();
        column = c;
        first = low = high = last = k;
        lowValue = highValue = value;
      } else {
        last = k;
        if (value < lowValue) {
          low = k;
          lowValue = value;
        } else if (value > highValue) {
          high = k;
          highValue = value;
        }
      }
      k++;
      if (!fast) continue;
      // The column's right edge, as a value.
      const edge = xOrigin + (c + 1 - xo) / xf;
      if (dense) {
        // The column's end: a binary search of x for its edge, corrected to
        // the exact column formula (which never decreases along x), then
        // its extremes by an index query.
        const next = breaks.expand(edge);
        let lo = k;
        let hi = rangeEnd;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (x[mid]! < next) lo = mid + 1;
          else hi = mid;
        }
        const inColumn = (at: number) => Number.isFinite(at) && columnOf(at) === c;
        while (lo > k && !inColumn(x[lo - 1]!)) lo--;
        while (lo < rangeEnd && inColumn(x[lo]!)) lo++;
        if (lo === k) continue;
        index!.query(y, k, lo, extremes);
        // Columns with gaps are scanned, which stops at each gap.
        if (!extremes.gap) {
          if (y[extremes.low]! < lowValue) {
            low = extremes.low;
            lowValue = y[low]!;
          }
          if (y[extremes.high]! > highValue) {
            high = extremes.high;
            highValue = y[high]!;
          }
          last = lo - 1;
          k = lo;
          continue;
        }
      }
      // A millionth of a column left of the column's edge, as a value,
      // checked to be in the column: every x below it is too.
      let safe = breaks.expand(edge - (1e-6 / xf + Math.abs(edge) * 1e-15));
      if (columnOf(safe) !== c) safe = Number.NEGATIVE_INFINITY;
      const before = k;
      for (; k < rangeEnd; k++) {
        const at = x[k]!;
        if (!(at < safe) && (!Number.isFinite(at) || columnOf(at) !== c)) break;
        const v = y[k]!;
        // NaN fails both comparisons, so only then is it tested for; the
        // outer loop breaks the line at it, and at infinities.
        if (v < lowValue) {
          if (v === Number.NEGATIVE_INFINITY) break;
          low = k;
          lowValue = v;
        } else if (v > highValue) {
          if (v === Number.POSITIVE_INFINITY) break;
          high = k;
          highValue = v;
        } else if (Number.isNaN(v)) {
          break;
        }
      }
      if (k > before) last = k - 1;
    }
  }
  flush();
}
