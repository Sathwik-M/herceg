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

/** Stacks this long or longer keep min/max indexes of their layers (see stack.ts). */
export const INDEXED_POINTS = 1 << 18;
/**
 * Series this long or longer are reduced, and their extents read, through
 * min/max indexes: whole columns their table's, long-format series their
 * group's. Below it a scan is about as fast. An index takes about 0.16
 * bytes a row; five whole columns of 200,000 rows zoom in about 1.2 ms
 * instead of 2.2 ms with one (Node, interleaved runs).
 */
const INDEXED_ROWS = 1 << 12;

/**
 * When a mark's large series read min/max indexes for level of detail and
 * extents: whole columns their table's, long-format series their group's
 * (see `SeriesStream`). An index already kept is always used. A new one is
 * built when a chart redraws the mark and nothing replaced the data since
 * its previous draw (wholesale, for tables; at all, for groups, which any
 * change to values in place groups again): the data is being zoomed,
 * panned, or streamed, and the index is kept current from then on. Data
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
   * The index serving `s` (sorted, large, still reading its field's column,
   * and a whole column or a long-format group as it follows the table), or
   * undefined. `owner` is the drawing chart, and `linear` whether its
   * scales are ones the index serves (log scales are not); without both,
   * only an index already kept is served.
   */
  index(table: Table, s: Series, owner?: object, linear = false): RangeIndex | undefined {
    const field = s.field;
    const whole = s.rows === undefined;
    const source = whole ? table : s.stream;
    if (!source || field === undefined || !s.sorted) return undefined;
    if (s.length < INDEXED_ROWS) return undefined;
    if (table.numbers(field as never) !== s.y) return undefined;
    if (source.hasMinMaxIndex(field as never)) return source.minMaxIndex(field as never);
    const draw = owner && linear && this.#draws.get(owner);
    const replaced = whole ? table.replacedVersion : table.modifiedVersion;
    if (!draw || draw.count < 2 || replaced > draw.previous) return undefined;
    return source.minMaxIndex(field as never);
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
  const { x, rows } = series;
  if (!series.sorted) {
    polylineAll(x, y, start, end, xMap, yMap, out, rows);
  } else if (!series.stream?.m4(x, y, start, end, xMap, yMap, frame.pixelRatio, out, rows, index)) {
    // Long-format series following their table reduce through their rows where they can.
    m4(x, y, start, end, xMap, yMap, frame.pixelRatio, out, rows, index);
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
 * The rows a line through the view runs through: those in it and one
 * neighbor past each edge, so it reaches the plot's edges. On an axis with
 * breaks, a neighbor is the nearest shown row, past any hidden ones.
 */
export function drawnRange(series: Series, frame: Frame): [number, number] {
  const [start, end] = visibleRange(series, frame.x.domain[0], frame.x.domain[1]);
  const breaks = frame.x.breaks;
  if (!breaks || !series.sorted) return [start, end];
  return breaks.reach(series.x, start, end, series.length, series.rows);
}

/**
 * The drawn rows widened to two distinct x values past each edge of the
 * view (when the data has them; on an axis with breaks, of shown rows), so
 * a monotone curve's tangents at the view's edges are those it has unzoomed.
 */
export function curveRows(series: Series, frame: Frame): [number, number] {
  let [start, end] = drawnRange(series, frame);
  if (!series.sorted) return [start, end];
  const { x, rows, length } = series;
  const breaks = frame.x.breaks;
  const xAt = (k: number) => x[rowOf(series, k)]!;
  const before = (k: number) => (breaks ? breaks.shownBefore(x, k, rows) : k);
  const after = (k: number) => (breaks ? breaks.shownFrom(x, k, length, rows) : k);
  for (let distinct = 0; start > 0 && distinct < 2; ) {
    const k = before(start - 1);
    if (k < 0) break;
    if (xAt(k) !== xAt(start)) distinct++;
    start = k;
  }
  for (let distinct = 0; end < length && distinct < 2; ) {
    const k = after(end);
    if (k >= length) break;
    if (xAt(k) !== xAt(end - 1)) distinct++;
    end = k + 1;
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
  const [start, end] = curve === "monotone" ? curveRows(series, frame) : drawnRange(series, frame);
  reduce(series, y, start, end, frame, path, index);
  const traced =
    curve === "monotone"
      ? frame.polyline(series.key, `${stage}-curve`)
      : stepped(path, frame, series.key, stage, curve);
  if (curve === "monotone") monotonePolyline(path, traced);
  traced.whole = path.count === end - start;
  return traced;
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
  const [start, end] = drawnRange(series, frame);
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
  } else {
    let runStart = -1;
    const breaks = xMap.breaks;
    for (let k = start; k <= end; k++) {
      let valid = false;
      if (k < end) {
        const row = rowOf(series, k);
        // Rows inside an axis break are left out without ending a run.
        if (breaks?.hides(series.x[row]!)) continue;
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
  }
  const whole = upper.count === end - start && lower.count === end - start;
  const edges = {
    upper: stepped(upper, frame, series.key, "upper", curve),
    lower: stepped(lower, frame, series.key, "lower", curve),
  };
  edges.upper.whole = edges.lower.whole = whole;
  return edges;
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
 * Reused scratch storage for curved layers, allocated when first needed (a
 * chart without curved areas never does) and grown as needed. Buffers grown
 * past RETAINED entries for an unusually large chart are not kept.
 */
let layerFloats = new Float64Array(0);
let keptScratch = new Int32Array(0);
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
  const edges = layers.map(({ series }) => ({
    upper: frame.polyline(series.key, "upper"),
    lower: frame.polyline(series.key, "lower"),
  }));
  // A stack's layer is drawn where it has its value.
  const drawn = (j: number, i: number) => {
    const { series, top } = layers[j]!;
    return !stacked || Number.isFinite(top[rowOf(series, rows[i]!)]!);
  };
  curveLayers(xs, positions, tangents, curves, edges, drawn);
  for (const { upper, lower } of edges)
    upper.whole = lower.whole = n === end - start && upper.count === n;
  if (layerFloats.length > RETAINED) layerFloats = new Float64Array(0);
  return edges;
}

/**
 * Curves layers' edges through x positions `xs` and their boundaries'
 * `positions` (boundary 0 the lowest, boundary j + 1 layer j's top; NaN
 * where one has none), into each layer's `edges`: monotone tangents per
 * boundary, written to `tangents`; each segment curved for every boundary,
 * or (too narrow, or where two boundaries could cross) straight for all of
 * them, as `curves` records (1 or 0); and each layer's edges drawn over the
 * runs where it has both boundaries and `drawn(layer, i)` holds. Value
 * transitions curve the layers between two scenes with it too.
 */
export function curveLayers(
  xs: Float64Array,
  positions: readonly Float64Array[],
  tangents: readonly Float64Array[],
  curves: Float64Array,
  edges: readonly { upper: Polyline; lower: Polyline }[],
  drawn: (layer: number, i: number) => boolean,
): void {
  const n = xs.length;
  const count = positions.length;
  for (let b = 0; b < count; b++) {
    const ys = positions[b]!;
    const ts = tangents[b]!;
    forEachRun(
      n,
      (i) => !Number.isNaN(xs[i]! + ys[i]!),
      (a, z) => monotoneTangents(xs, ys, a, z, ts),
    );
  }
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
  edges.forEach(({ upper, lower }, j) => {
    upper.reset();
    lower.reset();
    const above = positions[j + 1]!;
    const below = positions[j]!;
    const shown = (i: number) => !Number.isNaN(xs[i]! + above[i]! + below[i]!) && drawn(j, i);
    forEachRun(n, shown, (a, z) => {
      upper.break();
      lower.break();
      edge(upper, above, tangents[j + 1]!, a, z);
      edge(lower, below, tangents[j]!, a, z);
    });
  });
  releaseScratch();
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
      const grown = new Int32Array(Math.max(256, 2 * kept.length));
      grown.set(kept);
      kept = grown;
    }
    kept[n++] = k;
  };
  let n = 0;
  const breaks = frame.x.breaks;
  if (!series.sorted) {
    // Rows inside an axis break are left out.
    for (let k = start; k < end; k++) if (!breaks?.hides(series.x[rowOf(series, k)]!)) keep(k);
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
    // Rows inside an axis break are left out; the edges join across them.
    if (breaks?.hides(x)) continue;
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
