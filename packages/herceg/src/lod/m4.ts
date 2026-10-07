import type { NumericArray } from "../data/column.ts";
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
 * table without copying it.
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
  const row = (k: number) => (rows === undefined ? k : rows[k]!);
  const push = (k: number) => out.push(mapValue(xMap, x[row(k)]!), mapValue(yMap, y[row(k)]!));
  const a = low < high ? low : high;
  const b = low < high ? high : low;
  push(first);
  if (a !== first && a !== last) push(a);
  if (b !== first && b !== last && b !== a) push(b);
  if (last !== first) push(last);
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
