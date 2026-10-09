// Moving marks from the values a chart showed to changed ones (`animation:
// { values: true }`): bars, pie slices, points, and small lines and areas,
// with the axes when the change moves their domains. Charts load this module
// only when they ask for it. The data is current at once; what moves is a
// picture of the change. When a table's values change, the chart keeps a
// copy of what is on screen, matched by identity to the next scene's; frames
// between draw that scene with its marks, axes, and grid lines between the
// two. A change that moves the plot, the bands, or anything that cannot
// move with the axes, or that adds or drops rows, shows at once.

import type { TableChange } from "../data/table.ts";
import type { MarkKey } from "../marks/mark.ts";
import type { planAxis } from "../model/axis.ts";
import type { ChartConfig, ChartModel, DrawnPanel } from "../model/model.ts";
import type {
  ArcGeometry,
  AreaGeometry,
  AxisGeometry,
  Geometry,
  LineGeometry,
  Panel,
  PieSlice,
  PieSlices,
  PointGeometry,
  Rect,
  RectGeometry,
  RuleGeometry,
  Scene,
} from "../scene/scene.ts";
import type { AnimationSpec } from "../spec/spec.ts";
import { lastFrameTime } from "./scheduler.ts";
import {
  type AxesMotion,
  type Axis,
  after,
  axesAt,
  type Blend,
  before,
  blend,
  blendAt,
  motionOf,
  plannable,
  type ScaleMotion,
} from "./value-motion.ts";
import {
  copyPoints,
  type MovingPoints,
  movePoints,
  pointsAt,
  type ShownPoints,
} from "./value-points.ts";
import {
  copyRule,
  copyTrace,
  type Lines,
  type MovingRule,
  type MovingStack,
  type MovingTrace,
  moveRule,
  moveStack,
  moveTrace,
  ruleAt,
  type ShownRule,
  type ShownTrace,
  stackAt,
  traceAt,
} from "./value-traces.ts";

/**
 * Code of the chart's own that value transitions build with: axis plans,
 * polylines, and monotone curves. The chart passes it in, as this module
 * loads apart: bundlers such as esbuild move code that both import into
 * chunks of their own, which compress worse than the chart's bundle they
 * come from.
 */
export interface Builders extends Lines {
  planAxis: typeof planAxis;
}

/** How long a change takes without a `duration`, in milliseconds. */
const DURATION = 250;
/**
 * Charts whose frames take longer than this, in milliseconds, alone or with
 * every chart drawing beside them, show changes at once (as views do).
 */
const SLOW_FRAME = 10;
/**
 * Bars, slices, and rules at most in either scene of a change: more show
 * it at once. Each frame rebuilds their paths, which at this many takes
 * about a millisecond (docs/architecture.md). Marks bound each series' bars
 * alike (scene.ts MOVING_BARS, which this module does not import, so as to
 * share no chunk with the chart's bundle).
 */
export const MOVING_ITEMS = 2000;
/**
 * Points at most in either scene of a change: a frame of this many takes
 * less JavaScript than drawing the change at once, and the copies about 40
 * bytes a point (docs/architecture.md). Marks bound each series alike
 * (scene.ts MOVING_POINTS).
 */
export const MOVING_POINTS = 10_000;
/** Points of lines, areas, and other geometry at most in either scene of a change (docs/architecture.md). */
export const MOVING_VERTICES = 10_000;

/**
 * One series' bars as drawn, owned: per bar its position, and along,
 * thickness, root, tip; and which end is rounded (draw/rect.ts), if any is.
 */
interface ShownBars {
  kind: "bars";
  horizontal: boolean;
  count: number;
  at: Float64Array;
  parts: Float32Array;
  ends: Uint8ClampedArray | undefined;
}

/** A pie as drawn: its slices are made afresh for each scene, so they are kept as they are. */
interface ShownPie {
  items: readonly PieSlice[];
  ends: Float64Array;
  r: number;
  labeled: boolean;
}

/** What can move of one geometry as drawn: a series' bars, points, line, or area, or a rule. */
type ShownItem = ShownBars | ShownPoints | ShownTrace | ShownRule;

/** What a chart showed when its data changed: where a change of values starts. */
export interface Shown {
  /** When the change was made; it moves from then. */
  time: number;
  /** Milliseconds copying it took, which count toward the first frame. */
  cost: number;
  /** The panel's key, plot, and theme: a change moving any of them shows at once. */
  key: string;
  plot: Rect;
  theme: Scene["theme"];
  /** The scales and axes the marks were drawn with; undefined for a pie. */
  panel: DrawnPanel | undefined;
  /** The axes drawn: one that moves keeps its labels or its lack of them. */
  axes: readonly AxisGeometry[];
  /** Copies of what can move, by geometry key. */
  items: Map<string, ShownItem>;
  /**
   * Keys of the bars', points', lines', areas', and rules' geometry, copied
   * or not: a change that brings or takes away any shows at once.
   */
  keys: Set<string>;
  pie: ShownPie | undefined;
}

/**
 * One series' bars moving: per bar of both scenes, along, thickness, root,
 * and tip at each end, and the rounded end at each.
 */
interface MovingBars {
  /** The geometry's place among its panel's. */
  index: number;
  mark: RectGeometry;
  /** The scale bars' lengths are on: x for horizontal bars. */
  along: Axis;
  count: number;
  from: Float32Array;
  to: Float32Array;
  rounded: Uint8ClampedArray | undefined;
  rects: Float32Array;
  ends: Uint8ClampedArray | undefined;
}

/** A pie moving: the slices of both scenes in one order, with their widths and values at each end. */
interface MovingPie {
  items: readonly PieSlice[];
  from: Float64Array;
  to: Float64Array;
  /** Values at the start and end, which decide whose labels go when they do not all fit. */
  values: Float64Array;
  ends: Float64Array;
  r: readonly [number, number];
  labeled: boolean;
  draw: PieSlices["draw"];
}

/** A change of values playing. */
export interface Tween {
  start: number;
  duration: number;
  /** The scene of the new values, which the last frame shows as it is. */
  scene: Scene;
  /** How the panel's scales move: frames place marks and plan axes with them. */
  motions: Record<Axis, ScaleMotion>;
  /** The axes moving, when any scale does. */
  axes: AxesMotion | undefined;
  bars: MovingBars[];
  points: MovingPoints[];
  traces: MovingTrace[];
  /** Layers of monotone bands and stacks, which frames curve together. */
  stacks: MovingStack[];
  rules: MovingRule[];
  pie: MovingPie | undefined;
}

/**
 * Moves one chart's marks and axes to changed values. The chart says when
 * its data changes and when it built a scene, and draws what `step` gives.
 */
export class ValueAnimation {
  readonly #model: ChartModel;
  readonly #builders: Builders;
  readonly #reducedMotion: MediaQueryList | null;
  /** What the chart showed when its data first changed since its last scene. */
  #shown: Shown | undefined;
  /** Something since the last scene showed at once: changes until the next scene do too. */
  #blocked = false;
  /**
   * The options and hidden keys the last scene was built with: a change
   * made under others shows at once, as option and visibility changes do.
   */
  #drawn: { config: unknown; hidden: string } | undefined;
  /** Until then, changes show at once: the data changes too often to move. */
  #quiet = Number.NEGATIVE_INFINITY;
  #tween: Tween | undefined;
  /** The last scene the chart was given is a frame between two scenes, not one the model built. */
  #between = false;

  /** `drawn`: whether the chart's last scene shows its current options and hidden keys. */
  constructor(model: ChartModel, window: Window | null, drawn: boolean, builders: Builders) {
    this.#model = model;
    this.#builders = builders;
    this.#reducedMotion = window?.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
    if (drawn) this.#drawn = drawnWith(model);
  }

  get playing(): boolean {
    return this.#tween !== undefined;
  }

  /**
   * Hears of a change of the data, before the chart draws it: `change`,
   * or undefined for a row view's. The new values may move from `scene`,
   * the last frame, when the chart can show the motion (undefined when it
   * cannot: off screen, inspected, or moving its view); `frameTime` is how
   * long that frame took.
   */
  changed(scene: Scene | undefined, change: TableChange | undefined, frameTime: number): void {
    const now = performance.now();
    const { config } = this.#model;
    const duration = durationOf(config.animation);
    // Rows streaming in or out, and changes while values move or soon after,
    // show at once until the data has been still for a change's duration.
    const busy =
      this.#tween !== undefined ||
      now < this.#quiet ||
      !change ||
      change.appended > 0 ||
      change.dropped > 0;
    if (busy) this.#quiet = now + duration;
    this.#tween = undefined;
    const current = drawnWith(this.#model);
    if (
      busy ||
      !scene ||
      duration === 0 ||
      config !== this.#drawn?.config ||
      current.hidden !== this.#drawn.hidden ||
      config.interaction?.sync ||
      this.#reducedMotion?.matches ||
      frameTime > SLOW_FRAME ||
      lastFrameTime() > SLOW_FRAME
    ) {
      this.#shown = undefined;
      this.#blocked = true;
      return;
    }
    if (this.#blocked || this.#shown) return;
    this.#shown = snapshot(scene, this.#model.panels()[0], now);
    if (this.#shown) this.#shown.cost = performance.now() - now;
    else this.#blocked = true;
  }

  /**
   * The scene the chart draws next: a frame of a change playing, or else
   * the scene `build` makes, moving to it from what was shown if it can.
   */
  frame(build: () => Scene, frameTime: number): Scene {
    return this.step(frameTime) ?? this.start(build(), frameTime);
  }

  /**
   * The chart built `scene`: what to draw first, which moves to it from
   * what was shown when the data changed, if it can. `frameTime` is how
   * long the chart's last frame took.
   */
  start(scene: Scene, frameTime: number): Scene {
    const shown = this.#shown;
    this.#shown = undefined;
    this.#blocked = false;
    this.#between = false;
    this.#drawn = drawnWith(this.#model);
    // Copying what was shown counts toward this frame, as building the scene does.
    if (!shown || frameTime + shown.cost > SLOW_FRAME) return scene;
    const { config } = this.#model;
    const duration = durationOf(config.animation);
    const panel = this.#model.panels()[0];
    this.#tween = plan(shown, scene, panel, duration, this.#builders, sidesOf(config));
    return this.step(frameTime) ?? scene;
  }

  /**
   * The next frame of a change playing, its last the new scene; undefined
   * when none plays, or the chart was resized or its theme changed since,
   * which the chart then draws afresh.
   */
  step(frameTime: number): Scene | undefined {
    const tween = this.#tween;
    if (!tween) return undefined;
    const { scene } = tween;
    const model = this.#model;
    const elapsed = performance.now() - tween.start;
    const stale =
      scene.width !== model.width ||
      scene.height !== model.height ||
      scene.pixelRatio !== model.pixelRatio ||
      scene.theme !== model.theme;
    // Slow frames, and a page switching to reduced motion, end it at once.
    if (
      stale ||
      elapsed >= tween.duration ||
      frameTime > SLOW_FRAME ||
      lastFrameTime() > SLOW_FRAME ||
      this.#reducedMotion?.matches
    ) {
      this.#tween = undefined;
      this.#between = false;
      return stale ? undefined : scene;
    }
    this.#between = true;
    return frameAt(tween, elapsed);
  }

  /**
   * Ends a change playing and forgets what was shown, so the next scene
   * shows its values at once. Whether the chart shows a frame between two
   * scenes, which it should draw afresh before anything reads it: one of a
   * change playing, or of one a later change or option ended. Until the
   * next scene, no change moves from it.
   */
  settle(): boolean {
    const between = this.#between;
    if (between || this.#shown) this.#blocked = true;
    this.#tween = undefined;
    this.#shown = undefined;
    return between;
  }
}

/** The options and hidden keys a model draws with now. */
function drawnWith(model: ChartModel): { config: unknown; hidden: string } {
  return { config: model.config, hidden: JSON.stringify([...model.hidden]) };
}

/** Milliseconds a change of values takes; 0 when off or unusable. */
function durationOf(animation: boolean | AnimationSpec | undefined): number {
  if (typeof animation !== "object" || !animation.values) return 0;
  const duration = animation.duration ?? DURATION;
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

/** Which y scale places a geometry, by its key; "y" when it is not known to be on the right. */
type Sides = (key: string) => "y" | "yRight";

/** The y scale of each mark's geometry, by its key (see `ownerOf`). */
export function sidesOf(config: Pick<ChartConfig, "marks">): Sides {
  const right = new Set<MarkKey>();
  config.marks.forEach(({ spec }, i) => {
    if (spec.axis === "right") right.add(spec.id ?? i);
  });
  if (right.size === 0) return () => "y";
  return (key) => (right.has(ownerOf(key) as MarkKey) ? "yRight" : "y");
}

/**
 * The identity of the mark a geometry key belongs to: series keys are JSON
 * arrays starting with it (marks/mark.ts), and rules' keys its JSON before a
 * colon and the rule's row.
 */
function ownerOf(key: string): unknown {
  const json = key.startsWith("[") ? key : `[${key.slice(0, key.lastIndexOf(":"))}]`;
  try {
    return (JSON.parse(json) as unknown[])[0];
  } catch {
    return undefined;
  }
}

/** Whether a change that brings or takes away this geometry shows at once. */
function tracked(mark: Geometry): boolean {
  return (
    (mark.kind === "rect" && (mark as RectGeometry).bars !== undefined) ||
    mark.kind === "point" ||
    mark.kind === "line" ||
    mark.kind === "area" ||
    mark.kind === "rule"
  );
}

/** A copy of what can move of a geometry, if any can. */
function copyOf(mark: Geometry): ShownItem | undefined {
  switch (mark.kind) {
    case "rect":
      return (mark as RectGeometry).bars && barsOf(mark as RectGeometry);
    case "point":
      return copyPoints(mark as PointGeometry);
    case "line":
    case "area":
      return copyTrace(mark as LineGeometry | AreaGeometry);
    case "rule":
      return copyRule(mark as RuleGeometry);
    default:
      return undefined;
  }
}

/**
 * Copies of what `scene` shows that can move, with the panel whose scales
 * placed them; undefined when nothing can, or too much would.
 */
export function snapshot(
  scene: Scene,
  panel: DrawnPanel | undefined,
  time: number,
): Shown | undefined {
  const [drawn, ...others] = scene.panels;
  if (!drawn || others.length > 0 || !movable(drawn)) return undefined;
  const items = new Map<string, ShownItem>();
  const keys = new Set<string>();
  let pie: ShownPie | undefined;
  for (const mark of drawn.marks) {
    if (tracked(mark)) keys.add(mark.key);
    const item = copyOf(mark);
    if (item) items.set(mark.key, item);
    const slices = mark.kind === "arc" ? (mark as ArcGeometry).slices : undefined;
    if (slices)
      pie = { items: slices.items, ends: slices.ends, r: slices.r, labeled: slices.labeled };
  }
  const { key, plot, axes } = drawn;
  return { time, cost: 0, key, plot, theme: scene.theme, panel, axes, items, keys, pie };
}

/**
 * Whether a panel has something that can move (bars, slices, rules, points
 * that say which rows they show, or lines and areas traced whole), and not
 * too much to draw every frame: all its bars, slices, and rules, all its
 * points, and all else it draws, whether or not it moves. Clouds never move,
 * and nothing moves beside them.
 */
function movable(panel: Panel): boolean {
  let items = 0;
  let points = 0;
  let vertices = 0;
  // A pie with no slices yet can fill.
  let any = false;
  for (const mark of panel.marks) {
    if (mark.kind === "point") {
      const { cloud, items: rows, count } = mark as PointGeometry;
      if (cloud) return false;
      points += count;
      any ||= rows !== undefined;
    } else if (mark.kind === "rect") {
      items += (mark as RectGeometry).count;
      any ||= (mark as RectGeometry).bars !== undefined;
    } else if (mark.kind === "rule") {
      items++;
      any = true;
    } else if (mark.kind === "arc" && (mark as ArcGeometry).slices) {
      items += (mark as ArcGeometry).slices!.items.length;
      any = true;
    } else {
      vertices += mark.draw.size(mark);
      const edges =
        mark.kind === "line"
          ? [(mark as LineGeometry).path]
          : mark.kind === "area"
            ? [(mark as AreaGeometry).upper, (mark as AreaGeometry).lower]
            : [];
      any ||= edges.length > 0 && edges.every((edge) => !edge || edge.whole);
    }
  }
  return any && items <= MOVING_ITEMS && points <= MOVING_POINTS && vertices <= MOVING_VERTICES;
}

/** A copy of a bar geometry's bars: position, along, thickness, root, tip, rounded end. */
function barsOf(mark: RectGeometry): ShownBars {
  const { count, rects } = mark;
  const { horizontal, at, span } = mark.bars!;
  // Bars stand along x, unless horizontal.
  const along = horizontal ? 1 : 0;
  const parts = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    parts[i * 4] = rects[i * 4 + along]!;
    parts[i * 4 + 1] = rects[i * 4 + 2 + along]!;
    parts[i * 4 + 2] = span[i * 2]!;
    parts[i * 4 + 3] = span[i * 2 + 1]!;
  }
  const ends = mark.rounded?.ends.slice(0, count);
  return { kind: "bars", horizontal, count, at: at.slice(0, count), parts, ends };
}

/** How each scale of a panel moves between two scenes; undefined when one cannot. */
function motionsOf(
  shown: DrawnPanel | undefined,
  panel: DrawnPanel | undefined,
): Record<Axis, ScaleMotion> | undefined {
  const x = motionOf(shown?.x, panel?.x);
  const y = motionOf(shown?.y, panel?.y);
  const yRight = motionOf(shown?.yRight, panel?.yRight);
  return x && y && yRight && { x, y, yRight };
}

/**
 * How what was shown moves to `scene`, whose panel `panel` placed its
 * marks, over `duration` ms, with `sides` saying which y scale places each
 * geometry; undefined when it cannot (the plot or the bands changed, a
 * series came or went, a scale moved that something drawn cannot move
 * with, or retained slices changed order) or nothing moves.
 */
export function plan(
  shown: Shown,
  scene: Scene,
  panel: DrawnPanel | undefined,
  duration: number,
  builders: Builders,
  sides: Sides = () => "y",
): Tween | undefined {
  const [drawn, ...others] = scene.panels;
  if (!drawn || others.length > 0 || duration === 0 || !movable(drawn)) return undefined;
  // A panel of another facet value, or drawn elsewhere or otherwise, is another picture.
  const same = drawn.key === shown.key && scene.theme === shown.theme;
  const motions = motionsOf(shown.panel, panel);
  if (!same || !sameRect(drawn.plot, shown.plot) || !motions) return undefined;
  const scales = motions.x.moves || motions.y.moves || motions.yRight.moves;
  const axes = scales && {
    motions,
    before: shown.panel!.plans,
    after: panel!.plans,
    planAxis: builders.planAxis,
  };
  // Labels coming or going (as an axis gets something to label) would appear at the start.
  const labeled = (list: readonly AxisGeometry[]) =>
    list.map(({ orient, ticks }) => `${orient}${ticks.length > 0}`).join();
  if (axes && (!plannable(axes) || labeled(shown.axes) !== labeled(drawn.axes))) return undefined;
  const tween: Tween = {
    start: shown.time,
    duration,
    scene,
    motions,
    axes: axes || undefined,
    bars: [],
    points: [],
    traces: [],
    stacks: [],
    rules: [],
    pie: undefined,
  };
  const zero = (side: "y" | "yRight") =>
    [shown.panel?.[side]?.map(0) ?? Number.NaN, panel?.[side]?.map(0) ?? Number.NaN] as const;
  // A mark's areas move together or not at all: a stack's layers share edges.
  const areas = new Map<unknown, { moving: MovingTrace; moves: boolean }[]>();
  const still = new Set<unknown>();
  // Moving scales move the axes and grid lines, whatever marks do.
  let moves = scales;
  for (const [index, mark] of drawn.marks.entries()) {
    // Seams of time breaks (scale/breaks.ts names them) follow x alone: they
    // stay put while only y moves.
    if (mark.key === "time-break-seams") {
      if (motions.x.moves) return undefined;
      continue;
    }
    const item = shown.items.get(mark.key);
    const side = sides(mark.key);
    let moved: { moves: boolean } | undefined;
    if (item?.kind === "bars" && mark.kind === "rect" && (mark as RectGeometry).bars) {
      const bars = moveBars(index, item, mark as RectGeometry, motions, side);
      if (bars) tween.bars.push(bars.moving);
      moved = bars;
    } else if (item?.kind === "points" && mark.kind === "point") {
      const points = movePoints(index, item, mark as PointGeometry, side, motions.x, motions[side]);
      if (points) tween.points.push(points.moving);
      moved = points;
    } else if (item?.kind === "trace" && (mark.kind === "line" || mark.kind === "area")) {
      // Lines move along y only: points along x would need other rows.
      const trace = mark as LineGeometry | AreaGeometry;
      const scale = { side, motion: motions[side], zero: zero(side) };
      const moving = !motions.x.moves && moveTrace(index, item, trace, scale, builders);
      if (moving && mark.kind === "area") {
        const owner = ownerOf(mark.key);
        areas.set(owner, [...(areas.get(owner) ?? []), moving]);
        continue;
      }
      if (moving) tween.traces.push(moving.moving);
      moved = moving || undefined;
    } else if (item?.kind === "rule" && mark.kind === "rule") {
      const rule = moveRule(index, item, mark as RuleGeometry, side);
      if (rule) tween.rules.push(rule.moving);
      moved = rule;
    }
    if (moved) {
      moves ||= moved.moves;
      continue;
    }
    // What cannot move shows its new values, unless the axes move: it
    // would stand apart from them. Series that came have nothing to move from.
    if (scales || (tracked(mark) && !shown.keys.has(mark.key))) return undefined;
    if (mark.kind === "area") still.add(ownerOf(mark.key));
    const slices = mark.kind === "arc" ? (mark as ArcGeometry).slices : undefined;
    if (slices && shown.pie) {
      const moving = movePie(shown.pie, slices);
      if (!moving) return undefined;
      moves ||= moving.moves;
      tween.pie = moving.pie;
    }
  }
  for (const [owner, layers] of areas) {
    // Areas beside one that shows its new values do too.
    if (still.has(owner)) continue;
    const traces = layers.map(({ moving }) => moving);
    const curved = (traces[0]!.mark as AreaGeometry).curve !== undefined;
    const stack = curved ? moveStack(traces, builders) : undefined;
    if (curved && !stack) {
      if (scales) return undefined;
      continue;
    }
    if (stack) tween.stacks.push(stack);
    else tween.traces.push(...traces);
    moves ||= layers.some((layer) => layer.moves);
  }
  // Series that went have nothing to move to.
  const keys = new Set(drawn.marks.map(({ key }) => key));
  for (const key of shown.keys) if (!keys.has(key)) return undefined;
  return moves ? tween : undefined;
}

/**
 * How a series' bars move: matched by position, their lengths along the
 * scale `along` (as it moves), across a scale that must stay.
 */
function moveBars(
  index: number,
  shown: ShownBars,
  mark: RectGeometry,
  motions: Record<Axis, ScaleMotion>,
  side: "y" | "yRight",
): { moving: MovingBars; moves: boolean } | undefined {
  const next = barsOf(mark);
  if (next.horizontal !== shown.horizontal) return undefined;
  const along = next.horizontal ? "x" : side;
  const value = motions[along];
  // Bars whose positions move would need slots of their own.
  if (motions[next.horizontal ? side : "x"].moves) return undefined;
  const was = new Map<number, number>();
  for (let i = 0; i < shown.count; i++) {
    if (was.has(shown.at[i]!)) return undefined;
    was.set(shown.at[i]!, i);
  }
  const kept = new Set<number>();
  for (let j = 0; j < next.count; j++) {
    if (kept.has(next.at[j]!)) return undefined;
    kept.add(next.at[j]!);
  }
  let exits = 0;
  for (let i = 0; i < shown.count; i++) if (!kept.has(shown.at[i]!)) exits++;
  const count = next.count + exits;
  const from = new Float32Array(count * 4);
  const to = new Float32Array(count * 4);
  const rounded = next.ends && new Uint8ClampedArray(count * 2);
  // Bars of the new scene in its order, matched by position; new ones grow
  // from their root, where it was on the scale before. Bars that went shrink
  // to theirs, where it is after, drawn last.
  for (let j = 0; j < next.count; j++) {
    const target = next.parts.subarray(j * 4, j * 4 + 4);
    to.set(target, j * 4);
    const i = was.get(next.at[j]!);
    if (i === undefined) {
      from.set(target, j * 4);
      from[j * 4 + 2] = from[j * 4 + 3] = before(value, target[2]!);
    } else {
      from.set(shown.parts.subarray(i * 4, i * 4 + 4), j * 4);
    }
    if (rounded) {
      rounded[j * 2] = (i !== undefined && shown.ends?.[i]) || next.ends![j]!;
      rounded[j * 2 + 1] = next.ends![j]!;
    }
  }
  let k = next.count;
  for (let i = 0; i < shown.count; i++) {
    if (kept.has(shown.at[i]!)) continue;
    const source = shown.parts.subarray(i * 4, i * 4 + 4);
    from.set(source, k * 4);
    to.set(source, k * 4);
    to[k * 4 + 2] = to[k * 4 + 3] = after(value, source[2]!);
    if (rounded) rounded.fill(shown.ends?.[i] ?? 0, k * 2, k * 2 + 2);
    k++;
  }
  const moves = exits > 0 || value.moves || from.some((part, i) => part !== to[i]);
  const ends = rounded && new Uint8ClampedArray(count);
  const rects = new Float32Array(count * 4);
  return { moving: { index, mark, along, count, from, to, rounded, rects, ends }, moves };
}

function movePie(shown: ShownPie, next: PieSlices): { pie: MovingPie; moves: boolean } | undefined {
  const nextKeys = new Set(next.items.map(({ key }) => key));
  const shownKeys = new Set(shown.items.map(({ key }) => key));
  const items: PieSlice[] = [];
  const from: number[] = [];
  const to: number[] = [];
  const values: number[] = [];
  const width = (ends: Float64Array, k: number) => ends[k]! - (k > 0 ? ends[k - 1]! : 0);
  // Slices of both scenes in one order: those kept in theirs, with those
  // that went and came where they were and are. Between two kept slices,
  // ones that went come first.
  let i = 0;
  let j = 0;
  while (i < shown.items.length || j < next.items.length) {
    const old = shown.items[i];
    const now = next.items[j];
    if (old && !nextKeys.has(old.key)) {
      items.push(old);
      from.push(width(shown.ends, i));
      to.push(0);
      values.push(old.value, 0);
      i++;
    } else if (now && !shownKeys.has(now.key)) {
      items.push(now);
      from.push(0);
      to.push(width(next.ends, j));
      values.push(0, now.value);
      j++;
    } else if (old && now && old.key === now.key) {
      items.push(now);
      from.push(width(shown.ends, i));
      to.push(width(next.ends, j));
      values.push(old.value, now.value);
      i++;
      j++;
    } else {
      // Kept slices changed order (sorted by value): they would cross.
      return undefined;
    }
  }
  const moves =
    shown.r !== next.r ||
    items.length !== next.items.length ||
    from.some((width, k) => width !== to[k]);
  const pie: MovingPie = {
    items,
    from: Float64Array.from(from),
    to: Float64Array.from(to),
    values: Float64Array.from(values),
    ends: new Float64Array(items.length),
    r: [shown.r, next.r],
    labeled: next.items.length > 0 ? next.labeled : shown.labeled,
    draw: next.draw,
  };
  return { pie, moves };
}

/**
 * The scene `elapsed` ms into a change: the new one, with its marks on their
 * way, and the axes and grid lines of moving scales between.
 */
export function frameAt(tween: Tween, elapsed: number): Scene {
  const t = ease(Math.min(1, Math.max(0, elapsed / tween.duration)));
  const panel = tween.scene.panels[0]!;
  const { x, y, yRight } = tween.motions;
  const blends = { x: blendAt(x, t), y: blendAt(y, t), yRight: blendAt(yRight, t) };
  const marks = tween.pie ? pieAt(tween.pie, t) : panel.marks.slice();
  for (const bars of tween.bars) marks[bars.index] = barsAt(bars, t, blends[bars.along]);
  for (const points of tween.points)
    marks[points.index] = pointsAt(points, t, blends.x, blends[points.side]);
  for (const trace of tween.traces)
    marks[trace.index] = traceAt(trace, blends[trace.scale.side], panel.plot);
  for (const stack of tween.stacks) {
    const { layers } = stack;
    stackAt(stack, blends[layers[0]!.scale.side]).forEach((layer, j) => {
      marks[layers[j]!.index] = layer;
    });
  }
  for (const rule of tween.rules) marks[rule.index] = ruleAt(rule, blends[rule.along]);
  const guides = tween.axes && axesAt(panel, tween.axes, t);
  return { ...tween.scene, panels: [{ ...panel, ...guides, marks }] };
}

/** Starts quickly and settles without overshooting (cubic ease-out), as views move. */
function ease(t: number): number {
  return 1 - (1 - t) ** 3;
}

/** Bars at eased progress `t`, their roots and tips on the frame's scale `value`. */
function barsAt(moving: MovingBars, t: number, value: Blend): RectGeometry {
  const { mark, count, from, to, rounded, rects, ends } = moving;
  const horizontal = mark.bars!.horizontal;
  for (let i = 0; i < count; i++) {
    const at = i * 4;
    const along = from[at]! + (to[at]! - from[at]!) * t;
    const thickness = from[at + 1]! + (to[at + 1]! - from[at + 1]!) * t;
    // Roots and tips move rather than tops and heights: a bar changing sign
    // shrinks to its root and grows on the other side.
    const root = blend(value, from[at + 2]!, to[at + 2]!);
    const tip = blend(value, from[at + 3]!, to[at + 3]!);
    const low = Math.min(root, tip);
    const length = Math.abs(tip - root);
    rects[at] = horizontal ? low : along;
    rects[at + 1] = horizontal ? along : low;
    rects[at + 2] = horizontal ? length : thickness;
    rects[at + 3] = horizontal ? thickness : length;
    // The rounded end is at the tip: the new scene's once the tip has
    // passed to the side of the root it ends on, until then the old one's.
    if (ends) ends[i] = rounded![i * 2 + ((tip - root) * (to[at + 3]! - to[at + 2]!) > 0 ? 1 : 0)]!;
  }
  // A frame's bars are not the scene's: nothing moves from them.
  const corners = ends && { radius: mark.rounded!.radius, ends };
  return { ...mark, rects, count, rounded: corners, bars: undefined };
}

function pieAt(moving: MovingPie, t: number): Geometry[] {
  const { from, to, values, ends } = moving;
  // Widths move, so neighbors share their boundary throughout and the
  // slices of two pies always make a whole turn. Slices with no width yet
  // (or any more) are left out, with their labels.
  const items: PieSlice[] = [];
  let sum = 0;
  moving.items.forEach((item, k) => {
    const width = from[k]! + (to[k]! - from[k]!) * t;
    if (!(width > 0)) return;
    sum += width;
    ends[items.length] = sum;
    const value = values[k * 2]! + (values[k * 2 + 1]! - values[k * 2]!) * t;
    items.push({ ...item, value });
  });
  const [r0, r1] = moving.r;
  return moving.draw(items, ends.subarray(0, items.length), r0 + (r1 - r0) * t, moving.labeled);
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
