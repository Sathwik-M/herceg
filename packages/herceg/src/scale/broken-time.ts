// A time scale that leaves out the breaks of a Calendar: linear over the
// time it shows, with ticks that never fall inside a break.

import { toWall } from "../format/zone.ts";
import type { Mapping } from "../lod/m4.ts";
import type { Calendar } from "./breaks.ts";
import { LinearScale } from "./scale.ts";
import {
  type CalendarScale,
  chooseInterval,
  floorTime,
  type TickContext,
  type TimeInterval,
  timeTicks,
} from "./time.ts";

/** Breaks at least this many intervals long are not walked for ticks, only checked for one. */
const LONG = 8;

/** Tick candidates in order, with the context of each and which moved out of a break. */
interface Candidates {
  ticks: number[];
  contexts: (TickContext | undefined)[];
  moved: Set<number>;
}

interface TickPlan {
  count: number;
  interval: TimeInterval;
  ticks: number[];
  contexts: (TickContext | undefined)[];
}

/**
 * The domain is in epoch milliseconds, as on any time axis; pixels are
 * linear in the time shown, a value's position (`Calendar.collapse`).
 * Values inside a break sit at its seam and are not drawn (`breaks.hides`);
 * `invert` at a seam gives the end of the break, the first value shown
 * after it.
 */
export class BrokenTimeScale implements CalendarScale {
  readonly type = "time" as const;
  readonly domain: readonly [number, number];
  readonly range: readonly [number, number];
  readonly breaks: Calendar;
  readonly #origin: number;
  readonly #offset: number;
  readonly #factor: number;
  /** The last tick plan, which `interval` and `tickContexts` describe. */
  #plan: TickPlan | undefined;

  constructor(
    domain: readonly [number, number],
    range: readonly [number, number],
    breaks: Calendar,
  ) {
    this.domain = domain;
    this.range = range;
    this.breaks = breaks;
    // The linear part, over positions, measured from the domain's start as LinearScale does.
    const shown = new LinearScale([breaks.collapse(domain[0]), breaks.collapse(domain[1])], range);
    this.#origin = shown.origin;
    this.#offset = shown.offset;
    this.#factor = shown.factor;
  }

  get zone(): string {
    return this.breaks.zone;
  }

  map(value: number): number {
    return this.#offset + (this.breaks.collapse(value) - this.#origin) * this.#factor;
  }

  invert(pixel: number): number {
    if (this.#factor === 0) return this.domain[0];
    return this.breaks.expand(this.#origin + (pixel - this.#offset) / this.#factor);
  }

  mapping(): Mapping {
    return {
      origin: this.#origin,
      offset: this.#offset,
      factor: this.#factor,
      log: false,
      breaks: this.breaks,
    };
  }

  /** Milliseconds of time shown across the domain. */
  get span(): number {
    const { breaks, domain } = this;
    return Math.abs(breaks.collapse(domain[1]) - breaks.collapse(domain[0]));
  }

  interval(count: number): TimeInterval {
    return this.#planFor(count).interval;
  }

  ticks(count: number): number[] {
    return this.#planFor(count).ticks;
  }

  tickContexts(ticks: readonly number[]): readonly (TickContext | undefined)[] | undefined {
    return this.#plan?.ticks === ticks ? this.#plan.contexts : undefined;
  }

  /**
   * Ticks for about `count` labels. The interval follows the time shown, so
   * a week of sessions gets hours rather than days. Calendar ticks inside a
   * break move to its end, where the session after it opens, labeled by the
   * day, month, or year that changes across the break; regular ticks too
   * close to a moved one give way. When breaks keep moving ticks (many
   * short sessions), coarser intervals are tried.
   */
  #planFor(count: number): TickPlan {
    if (this.#plan?.count === count) return this.#plan;
    const target = Math.max(1, count);
    // Coarser intervals come from longer spans, up to the domain's whole length.
    const longest = Math.abs(this.domain[1] - this.domain[0]);
    let span = this.span || 1;
    let plan: TickPlan;
    for (;;) {
      const interval = chooseInterval(span, target);
      plan = this.#thin(this.#candidates(interval), count, interval);
      if (plan.ticks.length <= 1.5 * target + 1 || span >= longest) break;
      span = Math.min(longest, span * 2);
    }
    this.#plan = plan;
    return plan;
  }

  /** Calendar ticks of `interval` in the domain, those in breaks moved to their ends. */
  #candidates(interval: TimeInterval): Candidates {
    const { breaks } = this;
    const zone = breaks.zone;
    const lo = Math.min(this.domain[0], this.domain[1]);
    const hi = Math.max(this.domain[0], this.domain[1]);
    const regular: number[] = [];
    // Moved ticks by the index of their break.
    const moved = new Map<number, TickContext | undefined>();
    const within = breaks.within(lo, hi);
    const { from, to } = within;
    const move = (i: number) => {
      if (!moved.has(i) && to[i]! >= lo && to[i]! <= hi)
        moved.set(i, this.#context(from[i]!, to[i]!));
    };
    // Breaks are walked by index from the one before; ticks come in order.
    let cursor = within.start;
    const piece = (a: number, b: number) => {
      if (!(b >= a)) return;
      for (const t of timeTicks(a, b, interval, zone)) {
        while (cursor < within.end && to[cursor]! <= t) cursor++;
        if (cursor < within.end && from[cursor]! <= t) move(cursor);
        else regular.push(t);
      }
    };
    // Long breaks split the domain into pieces, so a closure of years is not walked tick by tick.
    const long = LONG * interval.duration;
    let pieceStart = lo;
    for (let i = within.start; i < within.end; i++) {
      if (to[i]! - from[i]! < long) continue;
      piece(pieceStart, Math.min(from[i]!, hi));
      cursor = i + 1;
      // A tick inside: the latest boundary before the break's end is in it.
      if (floorTime(to[i]! - 1, interval, zone) >= from[i]!) move(i);
      pieceStart = to[i]!;
    }
    piece(pieceStart, hi);
    const contexts = new Map<number, TickContext | undefined>();
    for (const t of regular) contexts.set(t, undefined);
    // A moved tick on a regular one keeps the moved tick's context.
    for (const [i, context] of moved) contexts.set(to[i]!, context);
    const ticks = [...contexts.keys()].sort((a, b) => a - b);
    return {
      ticks,
      contexts: ticks.map((t) => contexts.get(t)),
      moved: new Set([...moved.keys()].map((i) => to[i]!)),
    };
  }

  /** The calendar field that changes across a break, from its last instant to its end. */
  #context(from: number, to: number): TickContext | undefined {
    const zone = this.breaks.zone;
    const before = new Date(toWall(zone, from - 1));
    const after = new Date(toWall(zone, to));
    if (before.getUTCFullYear() !== after.getUTCFullYear()) return "year";
    if (before.getUTCMonth() !== after.getUTCMonth()) return "month";
    if (before.getUTCDate() !== after.getUTCDate()) return "day";
    return undefined;
  }

  /**
   * Drops ticks less than half the room a label gets (the axis' length over
   * `count`) from the tick kept before them; a moved tick displaces a
   * regular one before it.
   */
  #thin(candidates: Candidates, count: number, interval: TimeInterval): TickPlan {
    const { moved } = candidates;
    const gap = Math.abs(this.range[1] - this.range[0]) / Math.max(1, count) / 2;
    const ticks: number[] = [];
    const contexts: (TickContext | undefined)[] = [];
    const pixels: number[] = [];
    candidates.ticks.forEach((t, i) => {
      const px = this.map(t);
      const n = ticks.length;
      if (n === 0 || Math.abs(px - pixels[n - 1]!) >= gap) {
        ticks.push(t);
        contexts.push(candidates.contexts[i]);
        pixels.push(px);
        return;
      }
      // Too close: a moved tick takes the place of a regular one, if it has room there.
      if (!moved.has(t) || moved.has(ticks[n - 1]!)) return;
      if (n >= 2 && Math.abs(px - pixels[n - 2]!) < gap) return;
      ticks[n - 1] = t;
      contexts[n - 1] = candidates.contexts[i];
      pixels[n - 1] = px;
    });
    return { count, interval, ticks, contexts };
  }
}
