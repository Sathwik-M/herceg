// Curves through a polyline's points in pixels: steps, and smooth monotone
// cubics, whose segments the polyline keeps as Bezier control points for
// renderers to draw as curves (SVG `C`, canvas `bezierCurveTo`, PDF `c`).

import type { Polyline } from "../lod/polyline.ts";

/**
 * Rewrites `source` as a step line into `out`. "step-after" holds each value
 * until the next x, "step-before" jumps at the previous x, and "step" changes
 * value halfway between points.
 */
export function stepPolyline(
  source: Polyline,
  curve: "step" | "step-before" | "step-after",
  out: Polyline,
): void {
  out.reset();
  const c = source.coords;
  for (let run = 0; run < source.starts.length; run++) {
    out.break();
    const start = source.starts[run]!;
    const end = source.runEnd(run);
    for (let i = start; i < end; i++) {
      const x = c[i * 2]!;
      const y = c[i * 2 + 1]!;
      if (i > start) {
        const px = c[i * 2 - 2]!;
        const py = c[i * 2 - 1]!;
        if (curve === "step-after") out.push(x, py);
        else if (curve === "step-before") out.push(px, y);
        else {
          const mid = (px + x) / 2;
          out.push(mid, py);
          out.push(mid, y);
        }
      }
      out.push(x, y);
    }
  }
}

/**
 * Segments narrower than this, in CSS pixels, stay straight: a curve
 * between points this close differs from the straight line by less than
 * the distance between them.
 */
export const MIN_CURVE_WIDTH = 2;

/** Reused scratch storage, grown as needed: curves are computed one at a time. */
let floats = new Float64Array(256);
let ints = new Int32Array(256);
/** Scratch grown past this many entries for an unusually large curve is not kept. */
const RETAINED = 1 << 16;

function floatScratch(n: number): Float64Array {
  if (floats.length < n) floats = new Float64Array(Math.max(n, floats.length * 2));
  return floats;
}

function intScratch(n: number): Int32Array {
  if (ints.length < n) ints = new Int32Array(Math.max(n, ints.length * 2));
  return ints;
}

/** Lets go of scratch storage a large curve grew; call once a curve is traced. */
export function releaseScratch(): void {
  if (floats.length > RETAINED) floats = new Float64Array(256);
  if (ints.length > RETAINED) ints = new Int32Array(256);
}

/**
 * Monotone cubic tangents (dy/dx) of points [start, end), written to `out`
 * at the same indexes: Steffen's method, as d3's curveMonotoneX. A tangent is
 * zero at a local extreme and limited elsewhere, so the curve never passes
 * a point's value between two points. Repeated points take the tangent of
 * the point they repeat and leave their neighbors' tangents unchanged.
 */
export function monotoneTangents(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  start: number,
  end: number,
  out: Float64Array,
): void {
  // Indexes of distinct points: each differs from the one before it.
  const distinct = intScratch(end - start);
  let n = 0;
  for (let i = start; i < end; i++) {
    const last = n > 0 ? distinct[n - 1]! : -1;
    if (last < 0 || x[i] !== x[last] || y[i] !== y[last]) distinct[n++] = i;
  }
  const at = (j: number) => distinct[j]!;
  if (n === 1) out[at(0)] = 0;
  if (n === 2) {
    const h = x[at(1)]! - x[at(0)]!;
    out[at(0)] = out[at(1)] = h ? (y[at(1)]! - y[at(0)]!) / h : 0;
  } else if (n > 2) {
    for (let j = 1; j < n - 1; j++) out[at(j)] = interior(x, y, at(j - 1), at(j), at(j + 1));
    out[at(0)] = endTangent(x, y, at(0), at(1), out[at(1)]!);
    out[at(n - 1)] = endTangent(x, y, at(n - 2), at(n - 1), out[at(n - 2)]!);
  }
  // Repeated points copy the tangent of the point they repeat.
  for (let j = 0; j < n; j++) out.fill(out[at(j)]!, at(j) + 1, j + 1 < n ? at(j + 1) : end);
}

/**
 * Adds the segment from (x0, y0) to (x1, y1) with tangents t0 and t1 to
 * `out`: a cubic whose control points lie a third of the way along x from
 * each end, on its tangent, so the curve stays a function of x; straight
 * when narrower than MIN_CURVE_WIDTH.
 */
export function pushSegment(
  out: Polyline,
  x0: number,
  y0: number,
  t0: number,
  x1: number,
  y1: number,
  t1: number,
): void {
  if (!(Math.abs(x1 - x0) >= MIN_CURVE_WIDTH)) {
    out.push(x1, y1);
    return;
  }
  const third = (x1 - x0) / 3;
  out.curveTo(x0 + third, y0 + third * t0, x1 - third, y1 - third * t1, x1, y1);
}

/**
 * Rewrites each run of `source` as a monotone curve into `out`, curving
 * segments at least MIN_CURVE_WIDTH wide; level of detail leaves dense
 * data with narrow segments, which stay straight.
 */
export function monotonePolyline(source: Polyline, out: Polyline): void {
  out.reset();
  const c = source.coords;
  for (let run = 0; run < source.starts.length; run++) {
    out.break();
    const start = source.starts[run]!;
    const n = source.runEnd(run) - start;
    // x, y, and tangents side by side in one scratch buffer.
    const f = floatScratch(3 * n);
    const x = f.subarray(0, n);
    const y = f.subarray(n, 2 * n);
    const t = f.subarray(2 * n, 3 * n);
    for (let i = 0; i < n; i++) {
      x[i] = c[(start + i) * 2]!;
      y[i] = c[(start + i) * 2 + 1]!;
    }
    monotoneTangents(x, y, 0, n, t);
    if (n > 0) out.push(x[0]!, y[0]!);
    for (let i = 0; i < n - 1; i++)
      pushSegment(out, x[i]!, y[i]!, t[i]!, x[i + 1]!, y[i + 1]!, t[i + 1]!);
  }
  releaseScratch();
}

/** Tangent at point b between a and c: zero at extremes, else limited so the curve cannot overshoot. */
function interior(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  a: number,
  b: number,
  c: number,
): number {
  const h0 = x[b]! - x[a]!;
  const h1 = x[c]! - x[b]!;
  const s0 = (y[b]! - y[a]!) / (h0 || (h1 < 0 ? -0 : 0));
  const s1 = (y[c]! - y[b]!) / (h1 || (h0 < 0 ? -0 : 0));
  const p = (s0 * h1 + s1 * h0) / (h0 + h1);
  return (
    (Math.sign(s0) + Math.sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(p)) || 0
  );
}

/** Tangent at the end of a run, from its segment's slope and the neighbor's tangent. */
function endTangent(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  a: number,
  b: number,
  neighbor: number,
): number {
  const h = x[b]! - x[a]!;
  return h ? ((3 * (y[b]! - y[a]!)) / h - neighbor) / 2 : neighbor;
}
