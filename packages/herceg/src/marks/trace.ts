// Turns series data into pixel polylines for the current frame: visible range,
// level-of-detail reduction, and curves.

import type { NumericArray } from "../data/column.ts";
import type { Table } from "../data/table.ts";
import { type Mapping, m4, mapValue, polylineAll } from "../lod/m4.ts";
import type { RangeExtremes, RangeIndex } from "../lod/minmax-index.ts";
import type { Polyline } from "../lod/polyline.ts";
import type { Curve } from "../spec/spec.ts";
import {
  MIN_CURVE_WIDTH,
  monotonePolyline,
  monotoneTangents,
  releaseScratch,
  stepPolyline,
} from "./curve.ts";
import type { Frame } from "./mark.ts";
import { rowOf, type Series, visibleRange } from "./series.ts";

/** Buffer stages; a series' buffers are keyed by stage and series key. */
export type Stage = "line" | "upper" | "lower";

/** Series of at least this many points read a min/max index once they are redrawn. */
/** Series this long or longer are reduced through min/max indexes where they have one. */
export const INDEXED_POINTS = 1 << 18;

/**
 * When a mark's large series read their table's min/max index for level of
 * detail and extents. An index the table already keeps is always used. A
 * new one is built when a chart redraws the mark and nothing replaced the
 * data wholesale since its previous draw: the data is being zoomed, panned,
 * or streamed, and the table keeps the index current from then on. Data
 * replaced every frame never pays for one.
 */
export class IndexUse {
  readonly #draws = new WeakMap<
    object,
    { count: number; version: number; previous: number; scene: number }
  >();

  /**
   * Counts a draw of `table` in the chart `owner`'s scene `scene`; call
   * before `index` in each draw. Panels drawing the mark in one scene count once.
   */
  drew(owner: object, scene: number, table: Table): void {
    const last = this.#draws.get(owner);
    if (last?.scene === scene) return;
    this.#draws.set(owner, {
      count: (last?.count ?? 0) + 1,
      version: table.version,
      previous: last?.version ?? -1,
      scene,
    });
  }

  /**
   * The index serving `s` (whole, sorted, large, and still reading its
   * field's column), or undefined. `owner` is the drawing chart, and
   * `linear` whether its scales are ones the index serves (log scales are
   * not); without both, only an index the table already keeps is served.
   */
  index(table: Table, s: Series, owner?: object, linear = false): RangeIndex | undefined {
    const field = s.field;
    if (field === undefined || s.rows !== undefined || !s.sorted || s.length < INDEXED_POINTS)
      return undefined;
    if (table.numbers(field as never) !== s.y) return undefined;
    if (table.hasMinMaxIndex(field as never)) return table.minMaxIndex(field as never);
    const draw = owner && linear && this.#draws.get(owner);
    if (!draw || draw.count < 2 || table.replacedVersion > draw.previous) return undefined;
    return table.minMaxIndex(field as never);
  }
}

function reduce(
  series: Series,
  y: NumericArray,
  start: number,
  end: number,
  frame: Frame,
  out: Polyline,
  index?: RangeIndex,
) {
  const xMap = frame.x.mapping();
  const yMap = frame.y.mapping();
  if (series.sorted) {
    m4(series.x, y, start, end, xMap, yMap, frame.pixelRatio, out, series.rows, index);
  } else {
    polylineAll(series.x, y, start, end, xMap, yMap, out, series.rows);
  }
}

/** Steps a traced edge, when the curve is a step. */
function stepped(
  path: Polyline,
  frame: Frame,
  key: string,
  stage: Stage,
  curve: Curve | undefined,
): Polyline {
  if (curve === undefined || curve === "linear" || curve === "monotone") return path;
  const out = frame.polyline(key, `${stage}-step`);
  stepPolyline(path, curve, out);
  return out;
}

/**
 * The visible rows widened to two distinct x values past each edge of the
 * view (when the data has them), so a monotone curve's tangents at the
 * view's edges are those it has unzoomed.
 */
export function curveRows(series: Series, frame: Frame): [number, number] {
  let [start, end] = visibleRange(series, frame.x.domain[0], frame.x.domain[1]);
  if (!series.sorted) return [start, end];
  const xAt = (k: number) => series.x[rowOf(series, k)]!;
  for (let distinct = 0; start > 0 && distinct < 2; start--) {
    if (xAt(start - 1) !== xAt(start)) distinct++;
  }
  for (let distinct = 0; end < series.length && distinct < 2; end++) {
    if (xAt(end) !== xAt(end - 1)) distinct++;
  }
  return [start, end];
}

/**
 * Traces one edge of a series (`y`, or a band edge) as a polyline in pixels.
 * `index`, a min/max index of `y`, speeds up dense ranges.
 */
export function tracePath(
  series: Series,
  y: NumericArray,
  frame: Frame,
  stage: Stage,
  curve: Curve | undefined,
  index?: RangeIndex,
): Polyline {
  const path = frame.polyline(series.key, stage);
  path.reset();
  const [start, end] =
    curve === "monotone"
      ? curveRows(series, frame)
      : visibleRange(series, frame.x.domain[0], frame.x.domain[1]);
  reduce(series, y, start, end, frame, path, index);
  if (curve !== "monotone") return stepped(path, frame, series.key, stage, curve);
  const curved = frame.polyline(series.key, `${stage}-curve`);
  monotonePolyline(path, curved);
  return curved;
}

function placeable(mapping: Mapping, value: number): boolean {
  return Number.isFinite(value) && (!mapping.log || value > 0);
}

/**
 * Traces both edges of a band (or stack layer) so their runs match: each run
 * covers positions where both edges have values, and the n-th run of the
 * upper edge pairs with the n-th run of the lower edge when the area is
 * closed. Tracing the edges independently would pair unrelated runs when the
 * edges have gaps in different places. With min/max indexes of both edges
 * (linear scales, a whole sorted series), a view without gaps is one run,
 * reduced through the indexes without visiting every row.
 */
export function traceBand(
  series: Series,
  top: NumericArray,
  bottom: NumericArray,
  frame: Frame,
  curve: Curve | undefined,
  indexes?: { top: RangeIndex; bottom: RangeIndex },
): { upper: Polyline; lower: Polyline } {
  const upper = frame.polyline(series.key, "upper");
  const lower = frame.polyline(series.key, "lower");
  upper.reset();
  lower.reset();
  const [start, end] = visibleRange(series, frame.x.domain[0], frame.x.domain[1]);
  const xMap = frame.x.mapping();
  const yMap = frame.y.mapping();
  if (
    indexes &&
    series.sorted &&
    series.rows === undefined &&
    !xMap.log &&
    !yMap.log &&
    start < end &&
    !gapIn(indexes.top, top, start, end) &&
    !gapIn(indexes.bottom, bottom, start, end)
  ) {
    reduce(series, top, start, end, frame, upper, indexes.top);
    reduce(series, bottom, start, end, frame, lower, indexes.bottom);
    return {
      upper: stepped(upper, frame, series.key, "upper", curve),
      lower: stepped(lower, frame, series.key, "lower", curve),
    };
  }
  let runStart = -1;
  for (let k = start; k <= end; k++) {
    let valid = false;
    if (k < end) {
      const row = rowOf(series, k);
      valid =
        placeable(xMap, series.x[row]!) &&
        placeable(yMap, top[row]!) &&
        placeable(yMap, bottom[row]!);
    }
    if (valid && runStart < 0) runStart = k;
    else if (!valid && runStart >= 0) {
      upper.break();
      lower.break();
      reduce(series, top, runStart, k, frame, upper);
      reduce(series, bottom, runStart, k, frame, lower);
      runStart = -1;
    }
  }
  return {
    upper: stepped(upper, frame, series.key, "upper", curve),
    lower: stepped(lower, frame, series.key, "lower", curve),
  };
}

const extremes: RangeExtremes = { low: -1, high: -1, gap: false };

/** Whether `values[from, to)` holds a value that is not finite, by its index. */
function gapIn(index: RangeIndex, values: NumericArray, from: number, to: number): boolean {
  return index.length !== values.length || index.query(values, from, to, extremes).gap;
}

/** A band, or a layer of a stack: its series, top, and bottom (zero when undefined). */
export interface Layer {
  series: Series;
  top: NumericArray;
  bottom: NumericArray | undefined;
}

/**
 * Reused scratch storage for curved layers, grown as needed. Buffers grown
 * past RETAINED entries for an unusually large chart are not kept.
 */
let layerFloats = new Float64Array(1024);
let keptScratch = new Int32Array(256);
const RETAINED = 1 << 16;

/**
 * Traces bands or stack layers as monotone curves through the rows `range`
 * (from `curveRows`). Each boundary between layers is one curve, shared by
 * the layers on either side: in a stack, a layer's top where its value is
 * missing is its base, as stacking counts it. Every boundary is sampled at
 * the same steps, and a segment where curving would let two boundaries
 * cross is straight for all of them, so layers never overlap. Sorted rows
 * are reduced jointly: each device-pixel column keeps its first and last
 * rows and every boundary's lowest and highest, so all boundaries share x
 * positions and each covers its full extent in the column. Edges are drawn
 * where a layer has its values.
 */
export function traceCurvedLayers(
  layers: readonly Layer[],
  frame: Frame,
  [start, end]: [number, number],
  stacked: boolean,
): { upper: Polyline; lower: Polyline }[] {
  if (layers.length === 0) return [];
  const count = layers.length + 1;
  const rows = keptRows(layers, frame, start, end, stacked);
  const n = rows.length;
  // x, then each boundary's positions, then each boundary's tangents, then steps.
  const size = n * (2 + 2 * count);
  if (layerFloats.length < size)
    layerFloats = new Float64Array(Math.max(size, 2 * layerFloats.length));
  const xs = layerFloats.subarray(0, n);
  const positions = Array.from({ length: count }, (_, b) =>
    layerFloats.subarray(n * (1 + b), n * (2 + b)),
  );
  const tangents = Array.from({ length: count }, (_, b) =>
    layerFloats.subarray(n * (1 + count + b), n * (2 + count + b)),
  );
  // 1 where a segment is curved, 0 where it is straight.
  const curves = layerFloats.subarray(n * (1 + 2 * count), n * (2 + 2 * count));
  const xMap = frame.x.mapping();
  const yMap = frame.y.mapping();
  const place = (mapping: Mapping, value: number) =>
    placeable(mapping, value) ? mapValue(mapping, value) : Number.NaN;
  const first = layers[0]!.series;
  for (let i = 0; i < n; i++) xs[i] = place(xMap, first.x[rowOf(first, rows[i]!)]!);
  // Boundary 0 is the lowest; boundary j + 1 is layer j's top.
  layers.forEach(({ series, top, bottom }, j) => {
    const below = positions[j]!;
    const above = positions[j + 1]!;
    for (let i = 0; i < n; i++) {
      const row = rowOf(series, rows[i]!);
      const base = place(yMap, bottom ? bottom[row]! : 0);
      if (j === 0) below[i] = base;
      const value = place(yMap, top[row]!);
      above[i] = stacked && Number.isNaN(value) ? base : value;
    }
  });
  for (let b = 0; b < count; b++) {
    const ys = positions[b]!;
    const ts = tangents[b]!;
    forEachRun(
      n,
      (i) => !Number.isNaN(xs[i]! + ys[i]!),
      (a, z) => monotoneTangents(xs, ys, a, z, ts),
    );
  }
  // Each segment is curved for every boundary, or (too narrow, or where two
  // boundaries could cross) straight for all of them.
  for (let i = 0; i < n - 1; i++) {
    let curved = Math.abs(xs[i + 1]! - xs[i]!) >= MIN_CURVE_WIDTH;
    for (let b = 1; b < count && curved; b++) {
      curved = !crosses(xs, positions[b - 1]!, tangents[b - 1]!, positions[b]!, tangents[b]!, i);
    }
    curves[i] = curved ? 1 : 0;
  }
  const edge = (out: Polyline, y: Float64Array, t: Float64Array, a: number, z: number) => {
    out.push(xs[a]!, y[a]!);
    for (let i = a; i < z - 1; i++) {
      const x0 = xs[i]!;
      const x1 = xs[i + 1]!;
      if (!curves[i]) {
        out.push(x1, y[i + 1]!);
        continue;
      }
      const third = (x1 - x0) / 3;
      out.curveTo(
        x0 + third,
        y[i]! + third * t[i]!,
        x1 - third,
        y[i + 1]! - third * t[i + 1]!,
        x1,
        y[i + 1]!,
      );
    }
  };
  const edges = layers.map(({ series, top }, j) => {
    const upper = frame.polyline(series.key, "upper");
    const lower = frame.polyline(series.key, "lower");
    upper.reset();
    lower.reset();
    const above = positions[j + 1]!;
    const below = positions[j]!;
    const drawn = (i: number) =>
      !Number.isNaN(xs[i]! + above[i]! + below[i]!) &&
      (!stacked || Number.isFinite(top[rowOf(series, rows[i]!)]!));
    forEachRun(n, drawn, (a, z) => {
      upper.break();
      lower.break();
      edge(upper, above, tangents[j + 1]!, a, z);
      edge(lower, below, tangents[j]!, a, z);
    });
    return { upper, lower };
  });
  if (layerFloats.length > RETAINED) layerFloats = new Float64Array(1024);
  releaseScratch();
  return edges;
}

/**
 * Positions of the rows a band or stack is traced through: every row of
 * unsorted series; for sorted ones, per device-pixel column, the first and
 * last rows and each boundary's lowest and highest. Rows where a layer has
 * no value are kept, so its edges break where they should.
 */
function keptRows(
  layers: readonly Layer[],
  frame: Frame,
  start: number,
  end: number,
  stacked: boolean,
): Int32Array {
  const series = layers[0]!.series;
  // Grown as rows are kept: dense data keeps few of its rows.
  let kept = keptScratch;
  const keep = (k: number) => {
    if (n === kept.length) {
      const grown = new Int32Array(2 * kept.length);
      grown.set(kept);
      kept = grown;
    }
    kept[n++] = k;
  };
  let n = 0;
  if (!series.sorted) {
    for (let k = start; k < end; k++) keep(k);
    if (kept.length <= RETAINED) keptScratch = kept;
    return kept.subarray(0, n);
  }
  const xMap = frame.x.mapping();
  const yMap = frame.y.mapping();
  const ratio = frame.pixelRatio;
  // Boundary values of position k: the bottom of the first layer, then each top.
  const value = (k: number, b: number) => {
    const layer = layers[Math.max(0, b - 1)]!;
    const row = rowOf(layer.series, k);
    if (b === 0) return layer.bottom ? layer.bottom[row]! : 0;
    const top = layer.top[row]!;
    return stacked && !Number.isFinite(top) ? (layer.bottom ? layer.bottom[row]! : 0) : top;
  };
  const count = layers.length + 1;
  const low = new Int32Array(count);
  const high = new Int32Array(count);
  // A column's candidates: first, last, and each boundary's extremes.
  const candidates = new Int32Array(2 + 2 * count);
  let column = Number.NaN;
  let firstK = -1;
  let lastK = -1;
  const flush = () => {
    if (firstK < 0) return;
    candidates[0] = firstK;
    candidates[1] = lastK;
    candidates.set(low, 2);
    candidates.set(high, 2 + count);
    candidates.sort();
    for (let c = 0; c < candidates.length; c++) {
      if (c === 0 || candidates[c] !== candidates[c - 1]) keep(candidates[c]!);
    }
    firstK = -1;
  };
  for (let k = start; k < end; k++) {
    const row = rowOf(series, k);
    const x = series.x[row]!;
    let missing = !placeable(xMap, x);
    for (let b = 0; b < count && !missing; b++) missing = !placeable(yMap, value(k, b));
    for (const layer of layers) missing ||= !Number.isFinite(layer.top[rowOf(layer.series, k)]!);
    if (missing) {
      // Rows without every value end the column and stay, breaking edges.
      flush();
      keep(k);
      continue;
    }
    const c = Math.floor(mapValue(xMap, x) * ratio);
    if (c !== column) {
      flush();
      column = c;
    }
    if (firstK < 0) {
      firstK = k;
      low.fill(k);
      high.fill(k);
    } else {
      for (let b = 0; b < count; b++) {
        const v = value(k, b);
        if (v < value(low[b]!, b)) low[b] = k;
        if (v > value(high[b]!, b)) high[b] = k;
      }
    }
    lastK = k;
  }
  flush();
  if (kept.length <= RETAINED) keptScratch = kept;
  return kept.subarray(0, n);
}

/**
 * Whether the curves of two boundaries could cross on segment k: the
 * difference of two cubics with the same x is a cubic whose Bezier
 * ordinates bound it, so it keeps its ends' sign when they all share it.
 */
function crosses(
  xs: Float64Array,
  y0: Float64Array,
  t0: Float64Array,
  y1: Float64Array,
  t1: Float64Array,
  k: number,
): boolean {
  if (Number.isNaN(y0[k]! + y0[k + 1]!)) return false;
  const third = (xs[k + 1]! - xs[k]!) / 3;
  const d0 = y1[k]! - y0[k]!;
  const d1 = y1[k + 1]! - y0[k + 1]!;
  const c0 = d0 + third * (t1[k]! - t0[k]!);
  const c1 = d1 - third * (t1[k + 1]! - t0[k + 1]!);
  // Boundaries that cross at the data cross as straight lines do.
  if (d0 * d1 < 0) return true;
  const sign = Math.sign(d0 + d1);
  // Boundaries meeting at both ends must not part between them.
  if (sign === 0) return Math.abs(c0) > 1e-9 || Math.abs(c1) > 1e-9;
  return Math.min(sign * c0, sign * c1) < 0;
}

/** Calls `run` with each maximal range [a, b) of indexes below `n` that `valid` accepts. */
function forEachRun(n: number, valid: (k: number) => boolean, run: (a: number, b: number) => void) {
  let a = -1;
  for (let k = 0; k <= n; k++) {
    const ok = k < n && valid(k);
    if (ok && a < 0) a = k;
    else if (!ok && a >= 0) {
      run(a, k);
      a = -1;
    }
  }
}

export function unionExtent(
  extents: readonly (readonly [number, number] | undefined)[],
): [number, number] | undefined {
  let min = Infinity;
  let max = -Infinity;
  for (const extent of extents) {
    if (!extent) continue;
    if (extent[0] < min) min = extent[0];
    if (extent[1] > max) max = extent[1];
  }
  return min <= max ? [min, max] : undefined;
}
