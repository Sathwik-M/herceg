// M4 through the rows of a long-format series: the column scan and index
// queries `m4` gives whole columns, reading each point through its row.
// Loaded with marks/split.ts, so charts without a series field carry none
// of it; it imports nothing from lod/m4.ts at run time, which would split
// that module out of the line chart's first chunk.

import type { NumericArray } from "../data/column.ts";
import type { Mapping } from "./m4.ts";
import type { RangeExtremes, RangeIndex } from "./minmax-index.ts";
import type { Polyline } from "./polyline.ts";

/**
 * `m4` over positions `[start, end)` of `rows` (x ascending through them),
 * with the same output, on linear scales without breaks: points are read
 * column by column as `m4` reads whole columns, rather than mapped one by
 * one, and dense ranges with a min/max `index` of the rows' values are
 * reduced by index queries. Elsewhere it draws nothing and returns false,
 * leaving the rows to `m4`.
 */
export function rowsM4(
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
): boolean {
  const xo = xMap.offset * pixelRatio;
  const xf = xMap.factor * pixelRatio;
  const xOrigin = xMap.origin;
  const finite = Number.isFinite(xo) && Number.isFinite(xf) && Number.isFinite(xOrigin);
  if (!rows || xMap.breaks || xMap.log || yMap.log || !(xf > 0 && finite)) return false;
  const columns = (x[rows[end - 1]!]! - x[rows[start]!]!) * xf;
  // Index queries cost about as much as scanning 200 points, through rows as along columns.
  if (index && index.gapShare < 0.1 && end - start > 200 * Math.max(1, columns)) {
    indexed(x, y, start, end, xMap, yMap, pixelRatio, out, rows, index);
  } else {
    scan(x, y, start, end, xMap, yMap, pixelRatio, out, rows);
  }
  return true;
}

/**
 * Column by column, as `m4Columns` (lod/m4.ts) scans whole columns: a
 * column's points are those whose x is below a threshold just left of its
 * right edge (checked with the exact column formula), and at or past it,
 * those the exact test puts in it.
 */
function scan(
  x: NumericArray,
  y: NumericArray,
  start: number,
  end: number,
  xMap: Mapping,
  yMap: Mapping,
  pixelRatio: number,
  out: Polyline,
  rows: Uint32Array,
): void {
  const xo = xMap.offset * pixelRatio;
  const xf = xMap.factor * pixelRatio;
  const xOrigin = xMap.origin;
  let k = start;
  while (k < end) {
    const first = k;
    const firstX = x[rows[k]!]!;
    let lowValue = y[rows[k]!]!;
    if (!(Number.isFinite(firstX) && Number.isFinite(lowValue))) {
      // A value the scale cannot place ends the run.
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
    for (k++; k < end; k++) {
      const row = rows[k]!;
      const xv = x[row]!;
      // Next column, or an x the scale cannot place (NaN fails `<`).
      if (!(xv < safe) && (!Number.isFinite(xv) || Math.floor(xo + (xv - xOrigin) * xf) !== c))
        break;
      const value = y[row]!;
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
    emitColumn(x, y, rows, first, low, high, k - 1, xMap, yMap, out);
  }
}

const extremes: RangeExtremes = { low: -1, high: -1, gap: false };

/**
 * Dense ranges, as `m4Indexed` (lod/m4.ts) reduces whole columns: each
 * column's end by binary search, its extremes by an index query; columns
 * with gaps are scanned.
 */
function indexed(
  x: NumericArray,
  y: NumericArray,
  start: number,
  end: number,
  xMap: Mapping,
  yMap: Mapping,
  pixelRatio: number,
  out: Polyline,
  rows: Uint32Array,
  index: RangeIndex,
): void {
  const xo = xMap.offset * pixelRatio;
  const xf = xMap.factor * pixelRatio;
  const xOrigin = xMap.origin;
  let k = start;
  while (k < end) {
    const firstX = x[rows[k]!]!;
    if (!(Number.isFinite(firstX) && Number.isFinite(y[rows[k]!]!))) {
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
      const xv = x[rows[mid]!]!;
      if (!Number.isFinite(xv) || Math.floor(xo + (xv - xOrigin) * xf) !== c) hi = mid;
      else lo = mid + 1;
    }
    index.query(y, k, lo, extremes);
    if (extremes.gap) {
      scan(x, y, k, lo, xMap, yMap, pixelRatio, out, rows);
    } else {
      emitColumn(x, y, rows, k, extremes.low, extremes.high, lo - 1, xMap, yMap, out);
    }
    k = lo;
  }
}

/** A column's first, lowest, highest, and last points, in order, as `emitColumn` in lod/m4.ts. */
function emitColumn(
  x: NumericArray,
  y: NumericArray,
  rows: Uint32Array,
  first: number,
  low: number,
  high: number,
  last: number,
  xMap: Mapping,
  yMap: Mapping,
  out: Polyline,
): void {
  const a = low < high ? low : high;
  const b = low < high ? high : low;
  emitPoint(x, y, rows[first]!, xMap, yMap, out);
  if (a !== first && a !== last) emitPoint(x, y, rows[a]!, xMap, yMap, out);
  if (b !== first && b !== last && b !== a) emitPoint(x, y, rows[b]!, xMap, yMap, out);
  if (last !== first) emitPoint(x, y, rows[last]!, xMap, yMap, out);
}

/** A row's point in pixels, mapped linearly as `mapValue` maps it. */
function emitPoint(
  x: NumericArray,
  y: NumericArray,
  row: number,
  xMap: Mapping,
  yMap: Mapping,
  out: Polyline,
): void {
  out.push(
    xMap.offset + (x[row]! - xMap.origin) * xMap.factor,
    yMap.offset + (y[row]! - yMap.origin) * yMap.factor,
  );
}
