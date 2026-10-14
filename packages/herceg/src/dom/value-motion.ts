// How a change of values moves a chart's scales, for value transitions
// (value-transition.ts): each scale's domain from the one drawn before the
// change to the one drawn after it, and the axes and grid lines that follow.
// Every frame plans ticks for the domains between, as the scene plans them.

import type { MeasureText } from "../layout/text.ts";
import type { AxisPlan, planAxis } from "../model/axis.ts";
import type { axisGuide } from "../model/axis-guide.ts";
import type { PanelPlans } from "../model/model.ts";
import type { PositionScale } from "../scale/scale.ts";
import type { AxisGuide, Panel } from "../scene/scene.ts";

/** The scales of a panel: x, and the left and right y. */
export type Axis = "x" | "y" | "yRight";

/**
 * One scale's domain moving over an unchanged range. Values move evenly
 * along what the scale maps linearly (on log axes, their logarithms), so
 * pixels drawn before and after the change combine into the pixels of each
 * frame (`Blend`), whatever values they show.
 */
export interface ScaleMotion {
  /** Where the range starts, and its length, in pixels. */
  r0: number;
  extent: number;
  /** The domain's ends before and after, as mapped linearly: log10 of values on log axes. */
  from: readonly [number, number];
  to: readonly [number, number];
  log: boolean;
  /** Whether the domain changed; if not, pixels move from where they were to where they are. */
  moves: boolean;
}

/**
 * A scale as one frame draws it: something drawn at `p0` before a change
 * and at `p1` after it is drawn at `r0 + a (p0 - r0) + b (p1 - r0)`.
 */
export interface Blend {
  r0: number;
  a: number;
  b: number;
}

/** A frame's blends of a panel's scales. */
export type Blends = Record<Axis, Blend>;

/** A scale whose domain stays: band and broken time scales, and right axes neither scene has. */
const STILL: ScaleMotion = { r0: 0, extent: 1, from: [0, 1], to: [0, 1], log: false, moves: false };

/**
 * How a scale moves from `before` to `after`; undefined when it cannot
 * move between them: a scale coming or going, another type or range,
 * changed bands or breaks, or a domain turning around.
 */
export function motionOf(
  before: PositionScale | undefined,
  after: PositionScale | undefined,
): ScaleMotion | undefined {
  if (!before || !after) return before === after ? STILL : undefined;
  if (before.type !== after.type || !same(before.range, after.range)) return undefined;
  // Bands, and time with breaks left out, would need their own motions.
  if (before.type === "band" || before.breaks || after.breaks)
    return same(before.domain, after.domain) &&
      before.breaks === after.breaks &&
      before.bandwidth === after.bandwidth &&
      same(before.categories ?? [], after.categories ?? [])
      ? STILL
      : undefined;
  const log = before.type === "log";
  const from = linear(before.domain, log);
  const to = linear(after.domain, log);
  const [r0, r1] = after.range;
  const spans = (from[1] - from[0]) * (to[1] - to[0]);
  if (!(Number.isFinite(spans) && spans > 0) || r1 === r0) return undefined;
  const moves = from[0] !== to[0] || from[1] !== to[1];
  return { r0, extent: r1 - r0, from, to, log, moves };
}

function linear(domain: readonly [number, number], log: boolean): [number, number] {
  return log ? [Math.log10(domain[0]), Math.log10(domain[1])] : [domain[0], domain[1]];
}

function same(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/** The blend of a scale at eased progress `t`. */
export function blendAt(motion: ScaleMotion, t: number): Blend {
  if (!motion.moves) return { r0: 0, a: 1 - t, b: t };
  const { from, to } = motion;
  // Pixels from the range's start scale with the domain's span: a frame's
  // span is its ends' spans' mix, the same sign as both.
  const span = from[1] + (to[1] - from[1]) * t - (from[0] + (to[0] - from[0]) * t);
  return {
    r0: motion.r0,
    a: ((1 - t) * (from[1] - from[0])) / span,
    b: (t * (to[1] - to[0])) / span,
  };
}

export function blend(scale: Blend, p0: number, p1: number): number {
  return scale.r0 + scale.a * (p0 - scale.r0) + scale.b * (p1 - scale.r0);
}

/** Where a pixel drawn after the change would have been drawn before it: what grows from nothing starts there. */
export function before(motion: ScaleMotion, pixel: number): number {
  return motion.moves ? remap(pixel, motion.r0, motion.extent, motion.to, motion.from) : pixel;
}

/** Where a pixel drawn before the change is drawn after it: what shrinks to nothing ends there. */
export function after(motion: ScaleMotion, pixel: number): number {
  return motion.moves ? remap(pixel, motion.r0, motion.extent, motion.from, motion.to) : pixel;
}

function remap(
  pixel: number,
  r0: number,
  extent: number,
  from: readonly [number, number],
  to: readonly [number, number],
): number {
  const value = from[0] + ((pixel - r0) * (from[1] - from[0])) / extent;
  return r0 + ((value - to[0]) * extent) / (to[1] - to[0]);
}

/**
 * A panel's scales moving, and their plans before and after, from which
 * frames plan their axes with `planAxis` (the chart's, see `Builders`).
 */
export interface AxesMotion {
  motions: Record<Axis, ScaleMotion>;
  before: PanelPlans;
  after: PanelPlans;
  planAxis: typeof planAxis;
  /** Places an axis' items (passed in, as `planAxis` is, so this module's chunk holds no copy). */
  axisGuide: typeof axisGuide;
  /** Sizes the boxes of labels whose paints have them, as the chart measures. */
  measure: MeasureText;
}

/**
 * Whether frames can plan the axes of moving scales as the scenes did:
 * their plans of both scenes say how, with the same number of ticks, and
 * grid lines follow the same axis in both.
 */
export function plannable(motion: AxesMotion): boolean {
  const { motions, before, after } = motion;
  const follows = (plans: PanelPlans, axis: Axis) => plans.grid === plans[axis];
  return (["x", "y", "yRight"] as const).every((axis) => {
    const p = before[axis];
    const q = after[axis];
    if (follows(before, axis) !== follows(after, axis)) return false;
    if (!motions[axis].moves) return true;
    return (
      p?.context !== undefined &&
      q?.context !== undefined &&
      p.within !== undefined &&
      q.within !== undefined &&
      p.count === q.count &&
      p.context.type === q.context.type
    );
  });
}

/**
 * The axes and grid lines of `panel`, the scene moved to, at eased progress
 * `t`: those of moving scales with ticks planned for the domains between,
 * as the scene plans its own (the same tick count, chosen within the
 * domain before room was added for glyphs, and labeled together).
 */
export function axesAt(panel: Panel, motion: AxesMotion, t: number): Pick<Panel, "axes" | "grid"> {
  const { motions, after } = motion;
  const plans: Partial<Record<Axis, AxisPlan>> = {};
  const planOf = (axis: Axis): AxisPlan | undefined => {
    if (!motions[axis].moves) return undefined;
    plans[axis] ??= planAt(motion, axis, t);
    return plans[axis];
  };
  const axes = panel.axes.map((guide): AxisGuide => {
    const plan = planOf(guide.scale as Axis);
    // Axes without labels (with nothing to label) stay without.
    if (!plan || guide.ticks.length === 0) return guide;
    const ticks = plan.labels.map((label, i) => ({
      position: plan.scale.map(plan.ticks[i]!),
      label,
    }));
    // Placed as the scene placed the axis, with the ticks between.
    return motion.axisGuide(guide.key, guide.scale, guide, ticks, guide.title, motion.measure);
  });
  const lines = (plan: AxisPlan | undefined, drawn: number[]) =>
    plan && drawn.length > 0 ? plan.ticks.map((tick) => plan.scale.map(tick)) : drawn;
  const gridAxis =
    after.grid === after.y ? "y" : after.grid === after.yRight ? "yRight" : undefined;
  return {
    axes,
    grid: {
      ...panel.grid,
      x: lines(planOf("x"), panel.grid.x),
      y: gridAxis ? lines(planOf(gridAxis), panel.grid.y) : panel.grid.y,
    },
  };
}

/** A moving axis' plan at `t`: its domain, and the part ticks are chosen in, between the scenes'. */
function planAt(motion: AxesMotion, axis: Axis, t: number): AxisPlan {
  const { log } = motion.motions[axis];
  const before = motion.before[axis]!;
  const after = motion.after[axis]!;
  const between = (p: readonly [number, number], q: readonly [number, number]) => {
    const [a, b] = [linear(p, log), linear(q, log)];
    const ends = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] as const;
    return (log ? [10 ** ends[0], 10 ** ends[1]] : ends) as [number, number];
  };
  return motion.planAxis(
    after.context!,
    between(before.scale.domain, after.scale.domain),
    after.scale.range,
    after.count!,
    between(before.within!, after.within!),
  );
}
