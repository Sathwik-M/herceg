// Turns series data into pixel polylines for the current frame: visible range,
// level-of-detail reduction, and step curves.

import type { NumericArray } from "../data/column.ts";
import { type Mapping, m4, polylineAll } from "../lod/m4.ts";
import type { Polyline } from "../lod/polyline.ts";
import type { Curve } from "../spec/spec.ts";
import { stepPolyline } from "./curve.ts";
import type { Frame } from "./mark.ts";
import { rowOf, type Series, visibleRange } from "./series.ts";

/** Buffer stages; a series' buffers are keyed by stage and series key. */
export type Stage = "line" | "upper" | "lower";

function reduce(
  series: Series,
  y: NumericArray,
  start: number,
  end: number,
  frame: Frame,
  out: Polyline,
) {
  const xMap = frame.x.mapping();
  const yMap = frame.y.mapping();
  if (series.sorted) m4(series.x, y, start, end, xMap, yMap, frame.pixelRatio, out, series.rows);
  else polylineAll(series.x, y, start, end, xMap, yMap, out, series.rows);
}

function curved(
  path: Polyline,
  frame: Frame,
  key: string,
  stage: Stage,
  curve: Curve | undefined,
): Polyline {
  if (curve === undefined || curve === "linear") return path;
  const stepped = frame.polyline(key, `${stage}-step`);
  stepPolyline(path, curve, stepped);
  return stepped;
}

/** Traces one edge of a series (`y`, or a band edge) as a polyline in pixels. */
export function tracePath(
  series: Series,
  y: NumericArray,
  frame: Frame,
  stage: Stage,
  curve: Curve | undefined,
): Polyline {
  const path = frame.polyline(series.key, stage);
  path.reset();
  const [start, end] = visibleRange(series, frame.x.domain[0], frame.x.domain[1]);
  reduce(series, y, start, end, frame, path);
  return curved(path, frame, series.key, stage, curve);
}

function placeable(mapping: Mapping, value: number): boolean {
  return Number.isFinite(value) && (!mapping.log || value > 0);
}

/**
 * Traces both edges of a band (or stack layer) so their runs match: each run
 * covers positions where both edges have values, and the n-th run of the
 * upper edge pairs with the n-th run of the lower edge when the area is
 * closed. Tracing the edges independently would pair unrelated runs when the
 * edges have gaps in different places.
 */
export function traceBand(
  series: Series,
  top: NumericArray,
  bottom: NumericArray,
  frame: Frame,
  curve: Curve | undefined,
): { upper: Polyline; lower: Polyline } {
  const upper = frame.polyline(series.key, "upper");
  const lower = frame.polyline(series.key, "lower");
  upper.reset();
  lower.reset();
  const [start, end] = visibleRange(series, frame.x.domain[0], frame.x.domain[1]);
  const xMap = frame.x.mapping();
  const yMap = frame.y.mapping();
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
    upper: curved(upper, frame, series.key, "upper", curve),
    lower: curved(lower, frame, series.key, "lower", curve),
  };
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
