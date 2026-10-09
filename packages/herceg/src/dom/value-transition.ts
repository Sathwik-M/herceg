// Moving bars and pie slices from the values a chart showed to changed ones
// (`animation: { values: true }`). Charts load this module only when they
// ask for it. The data is current at once; what moves is a picture of the
// change. When a table's values change, the chart keeps a copy of the bars
// and slices on screen, matched by identity to the next scene's; frames
// between draw that scene with them interpolated. A change that moves the
// axes or the plot, or that adds or drops rows, shows at once.

import type { TableChange } from "../data/table.ts";
import type { ChartModel, DrawnPanel } from "../model/model.ts";
import type { PositionScale } from "../scale/scale.ts";
import type {
  ArcGeometry,
  Geometry,
  Panel,
  PieSlice,
  PieSlices,
  Rect,
  RectGeometry,
  Scene,
} from "../scene/scene.ts";
import type { AnimationSpec } from "../spec/spec.ts";
import { lastFrameTime } from "./scheduler.ts";

/** How long a change takes without a `duration`, in milliseconds. */
const DURATION = 250;
/**
 * Charts whose frames take longer than this, in milliseconds, alone or with
 * every chart drawing beside them, show changes at once (as views do).
 */
const SLOW_FRAME = 10;
/**
 * Bars and slices at most in either scene of a change: more show it at
 * once. Each frame rebuilds their paths, which at this many takes about a
 * millisecond (docs/architecture.md).
 */
export const MOVING_ITEMS = 2000;

/**
 * One series' bars as drawn, owned: per bar its position, and along,
 * thickness, root, tip; and which end is rounded (draw/rect.ts), if any is.
 */
interface ShownBars {
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
  /** The scales the bars were drawn with; undefined for a pie. */
  panel: DrawnPanel | undefined;
  /** Bars by their geometry's key: one series each. */
  bars: Map<string, ShownBars>;
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
  bars: MovingBars[];
  pie: MovingPie | undefined;
}

/**
 * Moves one chart's bars and slices to changed values. The chart says when
 * its data changes and when it built a scene, and draws what `step` gives.
 */
export class ValueAnimation {
  readonly #model: ChartModel;
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
  constructor(model: ChartModel, window: Window | null, drawn: boolean) {
    this.#model = model;
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
    const duration = durationOf(this.#model.config.animation);
    this.#tween = plan(shown, scene, this.#model.panels()[0], duration);
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

/**
 * Copies of what `scene` shows that can move: its bars and pie slices, with
 * the panel whose scales placed them; undefined when nothing can, or too
 * much would.
 */
export function snapshot(
  scene: Scene,
  panel: DrawnPanel | undefined,
  time: number,
): Shown | undefined {
  const [drawn, ...others] = scene.panels;
  if (!drawn || others.length > 0 || !movable(drawn)) return undefined;
  const bars = new Map<string, ShownBars>();
  let pie: ShownPie | undefined;
  for (const mark of drawn.marks) {
    if (mark.kind === "rect" && (mark as RectGeometry).bars)
      bars.set(mark.key, barsOf(mark as RectGeometry));
    const slices = mark.kind === "arc" ? (mark as ArcGeometry).slices : undefined;
    if (slices)
      pie = { items: slices.items, ends: slices.ends, r: slices.r, labeled: slices.labeled };
  }
  const { key, plot } = drawn;
  return { time, cost: 0, key, plot, theme: scene.theme, panel, bars, pie };
}

/** Whether a panel has bars or slices that can move, and not too many. */
function movable(panel: Panel): boolean {
  let items = 0;
  let any = false;
  for (const mark of panel.marks) {
    const bars = mark.kind === "rect" ? (mark as RectGeometry) : undefined;
    const slices = mark.kind === "arc" ? (mark as ArcGeometry).slices : undefined;
    if (bars?.bars) items += bars.count;
    if (slices) items += slices.items.length;
    any ||= !!(bars?.bars || slices);
  }
  return any && items <= MOVING_ITEMS;
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
  return { horizontal, count, at: at.slice(0, count), parts, ends };
}

/**
 * How what was shown moves to `scene`, whose panel `panel` placed its
 * bars, over `duration` ms; undefined when it cannot (the plot or the
 * scales moved, a series came or went, or retained slices changed order)
 * or nothing moves.
 */
export function plan(
  shown: Shown,
  scene: Scene,
  panel: DrawnPanel | undefined,
  duration: number,
): Tween | undefined {
  const [drawn, ...others] = scene.panels;
  if (!drawn || others.length > 0 || duration === 0 || !movable(drawn)) return undefined;
  // A panel of another facet value, or drawn elsewhere or otherwise, is another picture.
  const same = drawn.key === shown.key && scene.theme === shown.theme;
  if (!same || !sameRect(drawn.plot, shown.plot) || !sameScales(shown.panel, panel))
    return undefined;
  const bars: MovingBars[] = [];
  let pie: MovingPie | undefined;
  let series = 0;
  let moves = false;
  for (const [index, mark] of drawn.marks.entries()) {
    if (mark.kind === "rect" && (mark as RectGeometry).bars) {
      // Series that came have nothing to move from.
      const from = shown.bars.get(mark.key);
      if (!from) return undefined;
      series++;
      const moving = moveBars(index, from, mark as RectGeometry);
      // Bars sharing a position in their series have no identity: they show their new values.
      if (!moving) continue;
      moves ||= moving.moves;
      bars.push(moving.bars);
    }
    const slices = mark.kind === "arc" ? (mark as ArcGeometry).slices : undefined;
    if (slices && shown.pie) {
      const moving = movePie(shown.pie, slices);
      if (!moving) return undefined;
      moves ||= moving.moves;
      pie = moving.pie;
    }
  }
  // Series that went have nothing to move to.
  if (series !== shown.bars.size || !moves) return undefined;
  return { start: shown.time, duration, scene, bars, pie };
}

function moveBars(
  index: number,
  shown: ShownBars,
  mark: RectGeometry,
): { bars: MovingBars; moves: boolean } | undefined {
  const next = barsOf(mark);
  if (next.horizontal !== shown.horizontal) return undefined;
  const before = new Map<number, number>();
  for (let i = 0; i < shown.count; i++) {
    if (before.has(shown.at[i]!)) return undefined;
    before.set(shown.at[i]!, i);
  }
  const after = new Set<number>();
  for (let j = 0; j < next.count; j++) {
    if (after.has(next.at[j]!)) return undefined;
    after.add(next.at[j]!);
  }
  let exits = 0;
  for (let i = 0; i < shown.count; i++) if (!after.has(shown.at[i]!)) exits++;
  const count = next.count + exits;
  const from = new Float32Array(count * 4);
  const to = new Float32Array(count * 4);
  const rounded = next.ends && new Uint8ClampedArray(count * 2);
  // Bars of the new scene in its order, matched by position; new ones grow
  // from their root. Bars that went shrink to theirs, drawn after.
  for (let j = 0; j < next.count; j++) {
    const target = next.parts.subarray(j * 4, j * 4 + 4);
    to.set(target, j * 4);
    const i = before.get(next.at[j]!);
    if (i === undefined) {
      from.set(target, j * 4);
      from[j * 4 + 3] = target[2]!;
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
    if (after.has(shown.at[i]!)) continue;
    const source = shown.parts.subarray(i * 4, i * 4 + 4);
    from.set(source, k * 4);
    to.set(source, k * 4);
    to[k * 4 + 3] = source[2]!;
    if (rounded) rounded.fill(shown.ends?.[i] ?? 0, k * 2, k * 2 + 2);
    k++;
  }
  const moves = exits > 0 || from.some((value, i) => value !== to[i]);
  const ends = rounded && new Uint8ClampedArray(count);
  const bars = { index, mark, count, from, to, rounded, rects: new Float32Array(count * 4), ends };
  return { bars, moves };
}

function movePie(shown: ShownPie, next: PieSlices): { pie: MovingPie; moves: boolean } | undefined {
  const after = new Set(next.items.map(({ key }) => key));
  const before = new Set(shown.items.map(({ key }) => key));
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
    if (old && !after.has(old.key)) {
      items.push(old);
      from.push(width(shown.ends, i));
      to.push(0);
      values.push(old.value, 0);
      i++;
    } else if (now && !before.has(now.key)) {
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

/** The scene `elapsed` ms into a change: the new one, with its bars and slices on their way. */
export function frameAt(tween: Tween, elapsed: number): Scene {
  const t = ease(Math.min(1, Math.max(0, elapsed / tween.duration)));
  const panel = tween.scene.panels[0]!;
  const marks = tween.pie ? pieAt(tween.pie, t) : panel.marks.slice();
  for (const bars of tween.bars) marks[bars.index] = barsAt(bars, t);
  return { ...tween.scene, panels: [{ ...panel, marks }] };
}

/** Starts quickly and settles without overshooting (cubic ease-out), as views move. */
function ease(t: number): number {
  return 1 - (1 - t) ** 3;
}

function barsAt(moving: MovingBars, t: number): RectGeometry {
  const { mark, count, from, to, rounded, rects, ends } = moving;
  const horizontal = mark.bars!.horizontal;
  for (let i = 0; i < count; i++) {
    const at = i * 4;
    const along = from[at]! + (to[at]! - from[at]!) * t;
    const thickness = from[at + 1]! + (to[at + 1]! - from[at + 1]!) * t;
    // Roots and tips move rather than tops and heights: a bar changing sign
    // shrinks to its root and grows on the other side.
    const root = from[at + 2]! + (to[at + 2]! - from[at + 2]!) * t;
    const tip = from[at + 3]! + (to[at + 3]! - from[at + 3]!) * t;
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

/** Whether two panels place values alike: their x, y, and right y scales map the same values to the same pixels. */
function sameScales(a: DrawnPanel | undefined, b: DrawnPanel | undefined): boolean {
  if (!a || !b) return a === b;
  return sameScale(a.x, b.x) && sameScale(a.y, b.y) && sameScale(a.yRight, b.yRight);
}

function sameScale(a: PositionScale | undefined, b: PositionScale | undefined): boolean {
  if (!a || !b) return a === b;
  const same = (p: readonly unknown[], q: readonly unknown[]) =>
    p.length === q.length && p.every((value, i) => value === q[i]);
  return (
    a.type === b.type &&
    same(a.domain, b.domain) &&
    same(a.range, b.range) &&
    a.bandwidth === b.bandwidth &&
    same(a.categories ?? [], b.categories ?? [])
  );
}
