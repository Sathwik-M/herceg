// Moving a chart's axes gradually to a view asked for (the `animation`
// option). Charts load this module only when they animate.

import type { Breaks } from "../lod/m4.ts";
import type { ChartModel, PanelInfo, ViewDomains } from "../model/model.ts";
import type { PositionScale } from "../scale/scale.ts";
import type { AnimationSpec } from "../spec/spec.ts";
import { frameCount, lastFrameTime } from "./scheduler.ts";

/** How long `animation: true` takes, in milliseconds. */
const DURATION = 250;
/**
 * Charts whose frames would take longer than this, in milliseconds, alone or
 * with every chart moving or drawing beside them, jump to a new view rather
 * than move there.
 */
const SLOW_FRAME = 10;

/** Where a change of view starts: the ranges drawn before it, and which axes are logarithmic. */
export interface ViewStart {
  domains: ViewDomains;
  /** Log axes move evenly in log space. */
  log: { x: boolean; y: boolean; yRight: boolean };
  /** An x axis with breaks moves evenly in the time it shows. */
  breaks?: Breaks | undefined;
}

/** A change of view playing. */
export interface Transition extends ViewStart {
  /** The transitions asked for with it, which play together or not at all. */
  batch: Batch;
  /** Planned on its first frame, once every change asked for before it is in. */
  to: ViewDomains | undefined;
  start: number;
  duration: number;
}

/**
 * Transitions whose first frame is the same, such as an application moving
 * every chart of a dashboard: what each chart's first frame would take.
 */
interface Batch {
  frame: number;
  costs: Map<ViewAnimation, number>;
  /** Decided by the first member to draw, for all: charts move together or not at all. */
  jump?: boolean;
}

let batch: Batch | undefined;

/** The batch of transitions starting on the next frame, with `animation`'s cost in it. */
function joinBatch(animation: ViewAnimation, cost: number): Batch {
  const frame = frameCount();
  if (batch?.frame !== frame) batch = { frame, costs: new Map() };
  batch.costs.set(animation, cost);
  return batch;
}

function costOf(batch: Batch): number {
  let cost = 0;
  for (const each of batch.costs.values()) cost += each;
  return cost;
}

/**
 * Moves one chart's axes to the views asked for. The chart says where a
 * change starts, and calls `step` before drawing each frame.
 */
export class ViewAnimation {
  readonly #model: ChartModel;
  readonly #reducedMotion: MediaQueryList | null;
  #transition: Transition | undefined;

  constructor(model: ChartModel, window: Window | null) {
    this.#model = model;
    this.#reducedMotion = window?.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
  }

  get playing(): boolean {
    return this.#transition !== undefined;
  }

  /**
   * Moves from what `from`, a panel drawn before a change of view, shows to
   * the view now asked for, over the `animation` option's duration;
   * `frameTime` is how long the chart's last frame took. Whether it started.
   */
  start(
    from: PanelInfo,
    animation: boolean | AnimationSpec | undefined,
    frameTime: number,
  ): boolean {
    const duration = durationOf(animation);
    if (duration === 0 || this.#reducedMotion?.matches) return false;
    this.#transition = {
      ...startOf(from),
      // The first frame also plans the new view: about another frame's work.
      batch: joinBatch(this, 2 * frameTime),
      to: undefined,
      start: performance.now(),
      duration,
    };
    return true;
  }

  /**
   * Sets the ranges the frame about to be drawn shows, or ends the
   * transition; whether another frame follows. `plan` builds the scene of
   * the view asked for, which is never painted, and returns its panel.
   */
  step(plan: () => PanelInfo | undefined, frameTime: number): boolean {
    const transition = this.#transition;
    if (!transition) return false;
    if (!transition.to) {
      // Charts whose first frame together would be slow jump instead,
      // before planning where they would go.
      const { batch } = transition;
      batch.jump ??= costOf(batch) > SLOW_FRAME;
      if (batch.jump) return this.settle();
      this.#model.setTransitionDomains(null);
      const panel = plan();
      if (!panel) return this.settle();
      transition.to = domainsOf(panel);
    }
    const elapsed = performance.now() - transition.start;
    // Slow frames, of this chart or of every chart together, and a page
    // switching to reduced motion end it at once.
    if (
      elapsed >= transition.duration ||
      frameTime > SLOW_FRAME ||
      lastFrameTime() > SLOW_FRAME ||
      this.#reducedMotion?.matches
    )
      return this.settle();
    this.#model.setTransitionDomains(domainsAt(transition, transition.to, elapsed));
    return true;
  }

  /** Ends a transition playing, so the next scene shows the view asked for; false. */
  settle(): false {
    // A transition ended before its first frame costs that frame nothing.
    this.#transition?.batch.costs.delete(this);
    this.#transition = undefined;
    this.#model.setTransitionDomains(null);
    return false;
  }
}

/** Milliseconds an `animation` option takes; 0 when off or unusable. */
export function durationOf(animation: boolean | AnimationSpec | undefined): number {
  if (!animation) return 0;
  const duration = animation === true ? DURATION : (animation.duration ?? DURATION);
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

/** Where a change of view from what `panel` draws starts. */
function startOf(panel: PanelInfo): ViewStart {
  return {
    domains: domainsOf(panel),
    log: {
      x: panel.x.type === "log",
      y: panel.y.type === "log",
      yRight: panel.yRight?.type === "log",
    },
    breaks: panel.x.breaks,
  };
}

/** The ranges a panel draws, ascending; null for category axes. */
function domainsOf(panel: PanelInfo): ViewDomains {
  return {
    x: rangeOf(panel.x),
    y: rangeOf(panel.y),
    yRight: panel.yRight ? rangeOf(panel.yRight) : null,
  };
}

function rangeOf(scale: PositionScale): readonly [number, number] | null {
  if (scale.type === "band") return null;
  const [a, b] = scale.domain as readonly [number, number];
  return a <= b ? [a, b] : [b, a];
}

/** The ranges `elapsed` milliseconds into a transition. */
export function domainsAt(transition: Transition, to: ViewDomains, elapsed: number): ViewDomains {
  const t = ease(Math.min(1, Math.max(0, elapsed / transition.duration)));
  const { domains: from, log, breaks } = transition;
  return {
    x: between(from.x, to.x, t, log.x, breaks),
    y: between(from.y, to.y, t, log.y),
    yRight: between(from.yRight, to.yRight, t, log.yRight),
  };
}

/** Starts quickly and settles without overshooting (cubic ease-out). */
function ease(t: number): number {
  return 1 - (1 - t) ** 3;
}

function between(
  from: readonly [number, number] | null,
  to: readonly [number, number] | null,
  t: number,
  log: boolean,
  breaks?: Breaks,
): readonly [number, number] | null {
  if (!from || !to) return to;
  // A log axis whose ranges are not both positive cannot move through log space.
  if (log && !(from[0] > 0 && to[0] > 0)) return to;
  const lerp = (a: number, b: number) => {
    if (log) return 10 ** (Math.log10(a) + (Math.log10(b) - Math.log10(a)) * t);
    if (!breaks) return a + (b - a) * t;
    const start = breaks.collapse(a);
    return breaks.expand(start + (breaks.collapse(b) - start) * t);
  };
  return [lerp(from[0], to[0]), lerp(from[1], to[1])];
}
