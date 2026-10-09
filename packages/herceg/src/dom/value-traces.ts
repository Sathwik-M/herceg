// Lines, areas, and rules moving to changed values (value-transition.ts).
// A line or an area moves only when both scenes trace it through the same
// x positions, with every row a point (no level of detail, missing value, or
// break), in the same runs: then each point moves along y. Curves are not
// interpolated: each frame curves its points again as the mark does, a
// line's alone and a band's or stack's edges together, so frames are
// monotone curves through the values between.

import type { Polyline } from "../lod/polyline.ts";
import type { monotonePolyline } from "../marks/curve.ts";
import type {
  AreaGeometry,
  CurveLayers,
  LineGeometry,
  Rect,
  RuleGeometry,
} from "../scene/scene.ts";
import { type Blend, blend, type ScaleMotion } from "./value-motion.ts";

/** What frames build polylines with: the chart's own code (see `Builders`). */
export interface Lines {
  Polyline: typeof Polyline;
  monotonePolyline: typeof monotonePolyline;
}

/** A polyline as drawn, owned: its points and runs, and whether it is curved. */
interface ShownPath {
  count: number;
  starts: readonly number[];
  coords: Float32Array;
  curved: boolean;
}

/** A line, or an area's edges (the lower one null when it is filled down to its baseline), as drawn. */
export interface ShownTrace {
  kind: "trace";
  upper: ShownPath;
  lower: ShownPath | null;
}

type Trace = LineGeometry | AreaGeometry;

function edgesOf(mark: Trace): [Polyline, Polyline | null] {
  return mark.kind === "line" ? [mark.path, null] : [mark.upper, mark.lower];
}

/** A copy of a line or area traced whole; undefined for one level of detail or gaps left points out of. */
export function copyTrace(mark: Trace): ShownTrace | undefined {
  return traceOf(mark, true);
}

/** A line or area traced whole, copied (`own`) or read in place for as long as the scene holds it. */
function traceOf(mark: Trace, own: boolean): ShownTrace | undefined {
  const [upper, lower] = edgesOf(mark);
  if (!upper.whole || (lower && !lower.whole)) return undefined;
  return { kind: "trace", upper: pathOf(upper, own), lower: lower && pathOf(lower, own) };
}

function pathOf(path: Polyline, own: boolean): ShownPath {
  const { count, starts, curved } = path;
  const coords = own ? path.coords.slice(0, count * 2) : path.coords.subarray(0, count * 2);
  return { count, starts: own ? starts.slice() : starts, coords, curved };
}

/**
 * A polyline moving along y: per point its x, and its y before and after.
 * A curve's points are placed in `points` and curved into `out` (by
 * `curve`); other polylines' points go straight into `out`.
 */
interface MovingPath {
  count: number;
  x: Float32Array;
  from: Float32Array;
  to: Float32Array;
  out: Polyline;
  points: Polyline | undefined;
  curve: typeof monotonePolyline | undefined;
}

/** The y scale a trace is on: which, how it moves, and where zero is on it before and after. */
export interface TraceScale {
  side: "y" | "yRight";
  motion: ScaleMotion;
  zero: readonly [number, number];
}

/** A line or area moving: its edges, on its y scale. */
export interface MovingTrace {
  /** The geometry's place among its panel's. */
  index: number;
  mark: Trace;
  scale: TraceScale;
  upper: MovingPath;
  lower: MovingPath | null;
}

/**
 * How `shown` moves to `mark`, the same series in the new scene, along its
 * y scale, the x scale staying; undefined unless both are traced whole
 * through the same x positions, in the same runs (rows at the same x are
 * the same rows of a line, whichever rows of the table they are). A layer
 * of a monotone band or stack (`mark.curve`) moves only with its
 * neighbors, in a `MovingStack`.
 */
export function moveTrace(
  index: number,
  shown: ShownTrace,
  mark: Trace,
  scale: TraceScale,
  lines: Lines,
): { moving: MovingTrace; moves: boolean } | undefined {
  const next = traceOf(mark, false);
  if (!next || !next.lower !== !shown.lower) return undefined;
  // Layers are curved together, not one by one.
  const layered = mark.kind === "area" && mark.curve !== undefined;
  const upper = movePath(shown.upper, next.upper, lines, layered);
  const lower = next.lower && movePath(shown.lower!, next.lower, lines, layered);
  if (!upper || lower === undefined) return undefined;
  const moves = scale.motion.moves || upper.moves || (lower?.moves ?? false);
  const moving = { index, mark, scale, upper: upper.path, lower: lower?.path ?? null };
  return { moving, moves };
}

function movePath(
  shown: ShownPath,
  next: ShownPath,
  { Polyline, monotonePolyline }: Lines,
  layered: boolean,
): { path: MovingPath; moves: boolean } | undefined {
  const { count } = next;
  if (
    shown.count !== count ||
    shown.starts.length !== next.starts.length ||
    shown.starts.some((start, i) => start !== next.starts[i])
  )
    return undefined;
  const x = new Float32Array(count);
  const from = new Float32Array(count);
  const to = new Float32Array(count);
  let moves = false;
  for (let i = 0; i < count; i++) {
    if (shown.coords[i * 2] !== next.coords[i * 2]) return undefined;
    x[i] = next.coords[i * 2]!;
    from[i] = shown.coords[i * 2 + 1]!;
    to[i] = next.coords[i * 2 + 1]!;
    moves ||= from[i] !== to[i];
  }
  const blank = (length: number) => {
    const line = new Polyline();
    line.coords = new Float32Array(length * 2);
    line.starts = next.starts.slice();
    line.count = length;
    return line;
  };
  // A monotone line or area (only those curve) is curved again through each frame's points.
  const curved = !layered && (shown.curved || next.curved);
  const out = curved ? new Polyline() : blank(count);
  const points = curved ? blank(count) : undefined;
  const curve = curved ? monotonePolyline : undefined;
  return { path: { count, x, from, to, out, points, curve }, moves };
}

/** The line or area at the frame's y scale; `plot` bounds an area's baseline. */
export function traceAt(moving: MovingTrace, y: Blend, plot: Rect): Trace {
  const { mark } = moving;
  const upper = pathAt(moving.upper, y);
  if (mark.kind === "line") return { ...mark, path: upper };
  const lower = moving.lower && pathAt(moving.lower, y);
  // An area filled to zero closes where zero is, inside the plot.
  const zero = blend(y, moving.scale.zero[0], moving.scale.zero[1]);
  const baseline = Number.isFinite(zero)
    ? Math.min(Math.max(zero, plot.y), plot.y + plot.height)
    : mark.baseline;
  return { ...mark, upper, lower, baseline };
}

function pathAt(path: MovingPath, y: Blend): Polyline {
  const { count, x, from, to, out, points, curve } = path;
  const coords = (points ?? out).coords;
  for (let i = 0; i < count; i++) {
    coords[i * 2] = x[i]!;
    coords[i * 2 + 1] = blend(y, from[i]!, to[i]!);
  }
  if (curve) curve(points!, out);
  return out;
}

/**
 * The layers of a monotone band or stack moving together, bottom to top:
 * their boundaries' positions each frame (the first layer's base, then each
 * layer's top), and what the mark curves them with, into `edges`.
 */
export interface MovingStack {
  layers: readonly MovingTrace[];
  curve: CurveLayers;
  xs: Float64Array;
  positions: Float64Array[];
  tangents: Float64Array[];
  curves: Float64Array;
  edges: { upper: Polyline; lower: Polyline }[];
}

/**
 * The layers one mark curves together, as they move; undefined unless they
 * share their x positions, as the mark curves them.
 */
export function moveStack(
  layers: readonly MovingTrace[],
  { Polyline }: Lines,
): MovingStack | undefined {
  const first = layers[0]!.upper;
  const n = first.count;
  const alike = (path: MovingPath | null) =>
    path !== null && path.count === n && path.x.every((x, i) => x === first.x[i]);
  if (!layers.every(({ upper, lower }) => alike(upper) && alike(lower))) return undefined;
  const floats = () => new Float64Array(n);
  const boundaries = layers.length + 1;
  return {
    layers,
    curve: (layers[0]!.mark as AreaGeometry).curve!,
    xs: Float64Array.from(first.x),
    positions: Array.from({ length: boundaries }, floats),
    tangents: Array.from({ length: boundaries }, floats),
    curves: floats(),
    edges: layers.map(() => ({ upper: new Polyline(), lower: new Polyline() })),
  };
}

/** A stack's layers at the frame's y scale, curved together: the edges two layers share stay one. */
export function stackAt(stack: MovingStack, y: Blend): AreaGeometry[] {
  const { layers, positions, edges } = stack;
  const place = (into: Float64Array, path: MovingPath) => {
    for (let i = 0; i < path.count; i++) into[i] = blend(y, path.from[i]!, path.to[i]!);
  };
  place(positions[0]!, layers[0]!.lower!);
  layers.forEach(({ upper }, j) => {
    place(positions[j + 1]!, upper);
  });
  stack.curve(stack.xs, positions, stack.tangents, stack.curves, edges, () => true);
  return layers.map(({ mark }, j) => ({ ...(mark as AreaGeometry), ...edges[j]! }));
}

/** A rule as drawn: its ends. */
export interface ShownRule {
  kind: "rule";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export function copyRule({ x1, y1, x2, y2 }: RuleGeometry): ShownRule {
  return { kind: "rule", x1, y1, x2, y2 };
}

/** A rule moving across the plot: its ends before and after. */
export interface MovingRule {
  index: number;
  mark: RuleGeometry;
  /** The scale it moves along: x for a vertical rule. */
  along: "x" | "y" | "yRight";
  from: ShownRule;
}

/**
 * How a horizontal or vertical rule moves to `mark`, along its scale (x,
 * or the y scale `side`); undefined for a rule that turned or moves along
 * both.
 */
export function moveRule(
  index: number,
  shown: ShownRule,
  mark: RuleGeometry,
  side: "y" | "yRight",
): { moving: MovingRule; moves: boolean } | undefined {
  const vertical = mark.x1 === mark.x2 && shown.x1 === shown.x2;
  const horizontal = mark.y1 === mark.y2 && shown.y1 === shown.y2;
  if (vertical === horizontal) return undefined;
  // Across the plot, its ends stay at the plot's edges.
  if (
    vertical
      ? shown.y1 !== mark.y1 || shown.y2 !== mark.y2
      : shown.x1 !== mark.x1 || shown.x2 !== mark.x2
  )
    return undefined;
  const moves = vertical ? shown.x1 !== mark.x1 : shown.y1 !== mark.y1;
  return { moving: { index, mark, along: vertical ? "x" : side, from: shown }, moves };
}

export function ruleAt({ mark, along, from }: MovingRule, scale: Blend): RuleGeometry {
  if (along === "x") {
    const x = blend(scale, from.x1, mark.x1);
    return { ...mark, x1: x, x2: x };
  }
  const y = blend(scale, from.y1, mark.y1);
  return { ...mark, y1: y, y2: y };
}
