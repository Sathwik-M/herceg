// Axis breaks: time a time axis leaves out (weekends, nights, holidays), so
// the sessions left sit side by side. `timeBreaks` turns portable rules into
// a TimeBreaks; a chart resolves them in its time zone into a Calendar of
// concrete intervals, which its x scale maps through. Charts load this module
// only through `timeBreaks` (or the spec loader), so others do not bundle it.

import type { NumericArray } from "../data/column.ts";
import { seamDrawing } from "../draw/seams.ts";
import { type TimeZone, toWall, zoneOffset } from "../format/zone.ts";
import type { Breaks, Mapping } from "../lod/m4.ts";
import { brokenM4 } from "../lod/m4-breaks.ts";
import type { RangeIndex } from "../lod/minmax-index.ts";
import type { Polyline } from "../lod/polyline.ts";
import type { Rect, SegmentGeometry } from "../scene/scene.ts";
import type { TimeBreakSpec, Weekday, XAxisSpec } from "../spec/spec.ts";
import { BrokenTimeScale } from "./broken-time.ts";
import type { PositionScale } from "./scale.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Offsets change on quarter-hour boundaries in every zone. */
const QUARTER = 15 * MINUTE;
/** Days in `getUTCDay` order. */
const WEEKDAYS: readonly Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
/** The least time resolved past what is asked for. */
const MARGIN = 28 * DAY;
/** At most this many intervals are resolved (24 bytes each, plus scratch while resolving). */
const MAX_INTERVALS = 250_000;

type Rule =
  | { kind: "weekdays"; days: readonly boolean[] }
  /** Milliseconds after midnight; `end` before `start` wraps past midnight. */
  | { kind: "hours"; start: number; end: number }
  /** Wall-clock midnights (calendar dates as UTC). */
  | { kind: "dates"; days: readonly number[] }
  | { kind: "range"; from: number; to: number };

function fail(path: string, expected: string, value: unknown): never {
  const shown = typeof value === "string" ? JSON.stringify(value) : String(value);
  throw new TypeError(`${path}: expected ${expected}, got ${shown}`);
}

/** "HH:MM" as milliseconds after midnight; "24:00" only as an end. */
function clock(value: unknown, path: string, end: boolean): number {
  const match = typeof value === "string" ? /^(\d{1,2}):(\d{2})$/.exec(value) : null;
  const hours = Number(match?.[1]);
  const minutes = Number(match?.[2]);
  const valid = match && minutes < 60 && (hours < 24 || (end && hours === 24 && minutes === 0));
  if (!valid) fail(path, `a time of day, "HH:MM"${end ? ' (or "24:00")' : ""}`, value);
  return hours * HOUR + minutes * MINUTE;
}

/** An ISO date, "YYYY-MM-DD", as its midnight in wall-clock milliseconds. */
function date(value: unknown, path: string): number {
  const match = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  const [year, month, day] = [Number(match?.[1]), Number(match?.[2]), Number(match?.[3])];
  // setUTCFullYear, unlike Date.UTC, does not read years 0 to 99 as 1900 to 1999.
  const check = new Date(0);
  check.setUTCFullYear(year, month - 1, day);
  // Dates roll over (February 30 is March 2); a real date reads back the same.
  const real =
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day;
  if (!match || !real) fail(path, 'a date, "YYYY-MM-DD"', value);
  return check.getTime();
}

function parseRule(spec: unknown, path: string): Rule {
  if (typeof spec !== "object" || spec === null || Array.isArray(spec))
    fail(path, "a break: { weekdays }, { hours }, { dates }, or { from, to }", spec);
  const rule = spec as Record<string, unknown>;
  const kinds = ["weekdays", "hours", "dates", "from"].filter((key) => rule[key] !== undefined);
  if (kinds.length !== 1 && !(kinds.length === 0 && rule.to !== undefined))
    throw new TypeError(
      `${path}: a break has one of weekdays, hours, dates, or from and to, not ${kinds.length === 0 ? "none" : kinds.join(" and ")}`,
    );
  if (rule.weekdays !== undefined) {
    const list = rule.weekdays;
    if (!Array.isArray(list) || list.length === 0) fail(`${path}.weekdays`, "a list of days", list);
    const days = WEEKDAYS.map(() => false);
    for (const [i, day] of list.entries()) {
      const index = WEEKDAYS.indexOf(day as Weekday);
      if (index < 0) fail(`${path}.weekdays[${i}]`, '"mon", "tue", ..., or "sun"', day);
      days[index] = true;
    }
    if (days.every(Boolean))
      throw new RangeError(`${path}.weekdays: every day of the week leaves no time to show`);
    return { kind: "weekdays", days };
  }
  if (rule.hours !== undefined) {
    const span = rule.hours;
    if (!Array.isArray(span) || span.length !== 2)
      fail(`${path}.hours`, 'two times of day, ["HH:MM", "HH:MM"]', span);
    const start = clock(span[0], `${path}.hours[0]`, false);
    const end = clock(span[1], `${path}.hours[1]`, true);
    if (start === end || (start === 0 && end === DAY))
      throw new RangeError(
        `${path}.hours: ${JSON.stringify(span)} leaves out ${start === end ? "no time, or every hour" : "every hour"}`,
      );
    return { kind: "hours", start, end: end === DAY ? 0 : end };
  }
  if (rule.dates !== undefined) {
    const list = rule.dates;
    if (!Array.isArray(list) || list.length === 0)
      fail(`${path}.dates`, 'a list of dates, "YYYY-MM-DD"', list);
    return { kind: "dates", days: list.map((d, i) => date(d, `${path}.dates[${i}]`)) };
  }
  const { from, to } = rule;
  const whole = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v);
  if (!whole(from)) fail(`${path}.from`, "whole epoch milliseconds", from);
  if (!whole(to)) fail(`${path}.to`, "whole epoch milliseconds", to);
  if (!((to as number) > (from as number)))
    throw new RangeError(`${path}: a break must end after it starts, not at ${to} from ${from}`);
  return { kind: "range", from: from as number, to: to as number };
}

/** Parses break rules, with errors that name the offending rule by `path`. */
function parseRules(rules: unknown, path: string): Rule[] {
  if (!Array.isArray(rules)) fail(path, "a list of breaks", rules);
  return rules.map((rule, i) => parseRule(rule, `${path}[${i}]`));
}

/** Checks the breaks of a spec's x axis; used by the spec validator. */
export function checkBreaks(rules: unknown, path: string): void {
  parseRules(rules, path);
}

/**
 * Time a time axis leaves out, for its `breaks`: weekends, the hours
 * outside trading sessions, holidays. Resolved in the chart's time zone.
 *
 * ```ts
 * x: {
 *   breaks: timeBreaks([
 *     { weekdays: ["sat", "sun"] },
 *     { hours: ["16:00", "09:30"] },
 *     { dates: ["2025-12-25"] },
 *   ]),
 * }
 * ```
 */
export function timeBreaks(rules: readonly TimeBreakSpec[]): TimeBreaks {
  return new TimeBreaks(rules);
}

export class TimeBreaks {
  /** Explains omitted time in the chart's accessible description. */
  readonly description = "The time axis leaves out breaks in time.";
  readonly #spec: TimeBreakSpec[];
  readonly #rules: readonly Rule[];
  /** Resolved per time zone, and kept: a chart rarely changes zones. */
  readonly #calendars = new Map<TimeZone, Calendar>();

  constructor(rules: readonly TimeBreakSpec[]) {
    this.#rules = parseRules(rules, "breaks");
    this.#spec = JSON.parse(JSON.stringify(rules));
  }

  /** The rules as a spec holds them; options compare and serialize by them. */
  toJSON(): TimeBreakSpec[] {
    return JSON.parse(JSON.stringify(this.#spec));
  }

  /** The breaks resolved in `zone`. */
  calendar(zone: TimeZone): Calendar {
    let calendar = this.#calendars.get(zone);
    if (!calendar) {
      calendar = new Calendar(this.#rules, zone);
      this.#calendars.set(zone, calendar);
    }
    return calendar;
  }
}

/** Midnight of the wall-clock day holding wall time `wall`. */
function dayOf(wall: number): number {
  return Math.floor(wall / DAY) * DAY;
}

/** Day of the week of a wall-clock midnight, in `getUTCDay` order (1970-01-01 was a Thursday). */
function weekday(day: number): number {
  return (((Math.round(day / DAY) + 4) % 7) + 7) % 7;
}

/** How often offsets are sampled for changes; no zone changes twice within it. */
const SAMPLE = 4 * DAY;

/**
 * The UTC offsets of `zone` around [lo, hi]: the instants where they change
 * and the offset from each on. Found by sampling every few days and a
 * binary search of quarter hours where two samples differ, so resolving
 * years of breaks asks the zone a few hundred times rather than for every
 * break.
 */
class Offsets {
  readonly #changes: number[] = [];
  readonly #offsets: number[];

  constructor(zone: TimeZone, lo: number, hi: number) {
    let t = lo - 2 * DAY;
    let offset = zoneOffset(zone, t);
    this.#offsets = [offset];
    while (t < hi + 2 * DAY) {
      const next = t + SAMPLE;
      const later = zoneOffset(zone, next);
      if (later !== offset) {
        // The first quarter hour with the later offset.
        let a = Math.floor(t / QUARTER);
        let b = Math.ceil(next / QUARTER);
        while (b - a > 1) {
          const mid = Math.floor((a + b) / 2);
          if (zoneOffset(zone, mid * QUARTER) === offset) a = mid;
          else b = mid;
        }
        this.#changes.push(b * QUARTER);
        this.#offsets.push(later);
        offset = later;
      }
      t = next;
    }
  }

  /** The index of the offset in effect at `t`: the number of changes at or before it. */
  #at(t: number): number {
    const changes = this.#changes;
    let lo = 0;
    let hi = changes.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (changes[mid]! <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Calls `push` with the spans of instants whose wall-clock time is in
   * [w1, w2). With one offset that is [w1, w2) less the offset. Across a
   * change it is up to two spans, one on each side of the change: a span
   * inside a repeated hour is two spans, and wall times a change skips take
   * no time. Spans last at most two days, so at most one change is near.
   */
  wallSpans(w1: number, w2: number, push: (from: number, to: number) => void): void {
    // Offsets are at most a day, so these instants are before and after the span.
    const before = this.#at(w1 - DAY);
    const after = this.#at(w2 + DAY);
    const early = this.#offsets[before]!;
    if (before === after) {
      push(w1 - early, w2 - early);
      return;
    }
    const late = this.#offsets[after]!;
    const change = this.#changes[before]!;
    const a = Math.min(w2 - early, change);
    if (w1 - early < a) push(w1 - early, a);
    const b = Math.max(w1 - late, change);
    if (b < w2 - late) push(b, w2 - late);
  }
}

/**
 * The rules' intervals within [lo, hi), cut to it, sorted, and merged where
 * they overlap or touch: as start and end instants.
 */
function resolve(rules: readonly Rule[], zone: TimeZone, lo: number, hi: number): number[] {
  const spans: number[] = [];
  const push = (from: number, to: number) => {
    const a = Math.max(from, lo);
    const b = Math.min(to, hi);
    if (a < b) spans.push(a, b);
  };
  // Rule intervals last at most two days, so days from one before to one after reach every one.
  const first = dayOf(toWall(zone, lo)) - DAY;
  const last = dayOf(toWall(zone, hi)) + DAY;
  const offsets = new Offsets(zone, lo, hi);
  const wallSpans = (w1: number, w2: number) => offsets.wallSpans(w1, w2, push);
  for (const rule of rules) {
    switch (rule.kind) {
      case "weekdays":
        for (let day = first; day <= last; day += DAY)
          if (rule.days[weekday(day)]) wallSpans(day, day + DAY);
        break;
      case "hours": {
        const { start, end } = rule;
        for (let day = first; day <= last; day += DAY)
          wallSpans(day + start, end > start ? day + end : day + DAY + end);
        break;
      }
      case "dates":
        for (const day of rule.days) if (day >= first && day <= last) wallSpans(day, day + DAY);
        break;
      case "range":
        push(rule.from, rule.to);
    }
  }
  const order = Array.from({ length: spans.length / 2 }, (_, i) => i);
  order.sort((a, b) => spans[2 * a]! - spans[2 * b]!);
  const merged: number[] = [];
  for (const i of order) {
    const from = spans[2 * i]!;
    const to = spans[2 * i + 1]!;
    const n = merged.length;
    if (n > 0 && from <= merged[n - 1]!) merged[n - 1] = Math.max(merged[n - 1]!, to);
    else merged.push(from, to);
  }
  return merged;
}

const EMPTY = new Float64Array(0);

/**
 * `lowerBound` searching outward from `lo` first, in steps that double: as
 * fast when the position is near `lo`, and at most twice as slow when not.
 */
function gallop(at: (k: number) => number, value: number, lo: number, hi: number): number {
  let step = 1;
  let bound = lo;
  while (bound < hi && at(bound) < value) {
    lo = bound + 1;
    bound += step;
    step *= 2;
  }
  return lowerBound(at, value, lo, Math.min(bound, hi));
}

/** The first of the positions [lo, hi), ascending by `at`, at least `value`; `hi` if none. */
function lowerBound(at: (k: number) => number, value: number, lo: number, hi: number): number {
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (at(mid) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Breaks resolved in a time zone: sorted, disjoint intervals [from, to) over
 * the span of time resolved so far, which grows when a value outside it is
 * asked about (never approximated). A value's position is the value less
 * the break time between the first span resolved and it, so growing the
 * span never moves a value, and scales built before keep their meaning.
 * Arrays are replaced, never changed, when the span grows.
 */
export class Calendar implements Breaks {
  readonly zone: TimeZone;
  readonly #rules: readonly Rule[];
  #lo = Number.NaN;
  #hi = Number.NaN;
  #from: Float64Array = EMPTY;
  #to: Float64Array = EMPTY;
  /**
   * Break time before each interval, from the first span's start; one more
   * entry for after the last. An interval's seam, the position of every
   * value in it, is its start less this.
   */
  #removed: Float64Array = Float64Array.of(0);
  /** The interval of the last lookup, tried first: sorted traversals find theirs at once. */
  #hint = 0;

  constructor(rules: readonly Rule[], zone: TimeZone) {
    this.#rules = rules;
    this.zone = zone;
  }

  /** Resolves the breaks over at least [lo, hi]. Non-finite ends are ignored. */
  cover(lo: number, hi: number): void {
    if (!(Number.isFinite(lo) && Number.isFinite(hi))) return;
    if (lo >= this.#lo && hi < this.#hi) return;
    this.#grow(Math.min(lo, hi), Math.max(lo, hi));
  }

  #grow(lo: number, hi: number): void {
    if (Number.isNaN(this.#lo)) {
      const margin = Math.max(MARGIN, (hi - lo) / 2);
      this.#set(lo - margin, hi + margin, [], 0);
      return;
    }
    const margin = Math.max(MARGIN, (this.#hi - this.#lo) / 2);
    const newLo = lo < this.#lo ? lo - margin : this.#lo;
    const newHi = hi >= this.#hi ? hi + margin : this.#hi;
    // Resolved so far, as pairs, between what is added before and after.
    const current: number[] = [];
    for (let i = 0; i < this.#from.length; i++) current.push(this.#from[i]!, this.#to[i]!);
    this.#set(newLo, newHi, current, this.#removed[0]!);
  }

  /**
   * Resolves [lo, hi) around the intervals `current` already resolved over
   * the old span, keeping their positions: `removed` is the break time
   * before the old span's start.
   */
  #set(lo: number, hi: number, current: number[], removed: number): void {
    const days = (hi - lo) / DAY;
    const daily = this.#rules.filter((r) => r.kind === "hours" || r.kind === "weekdays").length;
    if (days * daily > MAX_INTERVALS)
      throw new RangeError(
        `Axis breaks would need over ${MAX_INTERVALS} intervals to cover ${Math.round(days)} days; the data or the view reaches too far`,
      );
    const fresh = Number.isNaN(this.#lo);
    const before = fresh ? [] : resolve(this.#rules, this.zone, lo, this.#lo);
    const after = fresh
      ? resolve(this.#rules, this.zone, lo, hi)
      : resolve(this.#rules, this.zone, this.#hi, hi);
    // Break time added before the old span moves the start of the count back.
    let added = 0;
    for (let i = 0; i < before.length; i += 2) added += before[i + 1]! - before[i]!;
    const spans: number[] = [];
    for (const list of [before, current, after]) {
      for (let i = 0; i < list.length; i += 2) {
        const n = spans.length;
        // Intervals cut at the old span's ends join again.
        if (n > 0 && list[i]! <= spans[n - 1]!)
          spans[n - 1] = Math.max(spans[n - 1]!, list[i + 1]!);
        else spans.push(list[i]!, list[i + 1]!);
      }
    }
    const count = spans.length / 2;
    // Explicit spans and dates count too.
    if (count > MAX_INTERVALS)
      throw new RangeError(`Axis breaks resolve to over ${MAX_INTERVALS} intervals`);
    const from = new Float64Array(count);
    const to = new Float64Array(count);
    const cumulative = new Float64Array(count + 1);
    cumulative[0] = removed - added;
    for (let i = 0; i < count; i++) {
      from[i] = spans[2 * i]!;
      to[i] = spans[2 * i + 1]!;
      cumulative[i + 1] = cumulative[i]! + (to[i]! - from[i]!);
    }
    this.#lo = lo;
    this.#hi = hi;
    this.#from = from;
    this.#to = to;
    this.#removed = cumulative;
    this.#hint = 0;
  }

  /** The last interval starting at or before `t` (resolved), or -1. */
  #index(t: number): number {
    if (!(t >= this.#lo && t < this.#hi)) this.#grow(t, t);
    const from = this.#from;
    const n = from.length;
    const h = this.#hint;
    // Sorted traversals stay in an interval or move to the next.
    if (h < n && from[h]! <= t) {
      if (h + 1 === n || t < from[h + 1]!) return h;
      if (h + 2 === n || t < from[h + 2]!) {
        this.#hint = h + 1;
        return h + 1;
      }
    }
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (from[mid]! <= t) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) this.#hint = lo - 1;
    return lo - 1;
  }

  collapse(value: number): number {
    if (!Number.isFinite(value)) return value;
    const i = this.#index(value);
    if (i < 0) return value - this.#removed[0]!;
    if (value < this.#to[i]!) return this.#from[i]! - this.#removed[i]!;
    return value - this.#removed[i + 1]!;
  }

  expand(position: number): number {
    if (!Number.isFinite(position)) return position;
    for (;;) {
      const from = this.#from;
      const removed = this.#removed;
      // The first interval whose seam is past the position.
      let lo = 0;
      let hi = from.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (from[mid]! - removed[mid]! <= position) lo = mid + 1;
        else hi = mid;
      }
      // After interval lo - 1 (at its seam, its end), or before the first.
      const value = position + removed[lo]!;
      if (value >= this.#lo && value < this.#hi) return value;
      // Unresolved time may hold more breaks: resolve it and look again.
      this.#grow(value, value);
    }
  }

  hides(value: number): boolean {
    if (!Number.isFinite(value)) return false;
    const i = this.#index(value);
    return i >= 0 && value < this.#to[i]!;
  }

  /** The interval holding `value`, as [from, to), or undefined when it is shown. */
  around(value: number): [number, number] | undefined {
    if (!Number.isFinite(value)) return undefined;
    const i = this.#index(value);
    return i >= 0 && value < this.#to[i]! ? [this.#from[i]!, this.#to[i]!] : undefined;
  }

  /**
   * The intervals that reach into [lo, hi], resolved first: their starts and
   * ends, and the indexes [start, end) of those reaching in.
   */
  within(
    lo: number,
    hi: number,
  ): { from: Float64Array; to: Float64Array; start: number; end: number } {
    this.cover(lo, hi);
    const from = this.#from;
    const to = this.#to;
    let start = Math.max(0, this.#index(lo));
    if (start < to.length && to[start]! <= lo) start++;
    let end = this.#index(hi) + 1;
    if (end < start) end = start;
    return { from, to, start, end };
  }

  /** Time-break seams on the final panel scale, thinned in CSS pixels. */
  seams(
    scale: PositionScale,
    plot: Rect,
    options: NonNullable<XAxisSpec["seams"]>,
    color: string,
  ): SegmentGeometry | undefined {
    if (options === false) return undefined;
    const minSpacing = typeof options === "boolean" ? 40 : (options.minSpacing ?? 40);
    if (!(minSpacing > 0) || !Number.isFinite(minSpacing))
      throw new RangeError("x.seams.minSpacing must be finite and positive");
    const lo = Math.min(...scale.domain);
    const hi = Math.max(...scale.domain);
    const left = plot.x;
    const right = left + plot.width;
    const { to, start, end } = this.within(lo, hi);
    const coords: number[] = [];
    let previous = Infinity;
    for (let i = start; i < end; i++) {
      if (to[i]! > hi) continue;
      // Drawn on a pixel's center, so a 1-pixel line is crisp, and only
      // where both that and the seam are inside the plot: every renderer
      // draws these positions.
      const at = scale.map(to[i]!);
      const x = Math.round(at) + 0.5;
      const inside = at > left && at < right && x > left && x < right;
      if (inside && Math.abs(x - previous) >= minSpacing) {
        coords.push(x, plot.y, x, plot.y + plot.height);
        previous = x;
      }
    }
    if (coords.length === 0) return undefined;
    return {
      kind: "segments",
      // Value transitions (dom/value-transition.ts) know seams by this key.
      key: "time-break-seams",
      draw: seamDrawing,
      stroke: color,
      strokeWidth: 1,
      dash: [3, 3],
      coords: new Float32Array(coords),
      count: coords.length / 4,
    };
  }

  shownFrom(x: NumericArray, k: number, end: number, rows?: Uint32Array): number {
    const at = (i: number) => x[rows === undefined ? i : rows[i]!]!;
    while (k < end) {
      const around = this.around(at(k));
      if (!around) return k;
      k = lowerBound(at, around[1], k + 1, end);
    }
    return end;
  }

  shownBefore(x: NumericArray, k: number, rows?: Uint32Array): number {
    const at = (i: number) => x[rows === undefined ? i : rows[i]!]!;
    while (k >= 0) {
      const around = this.around(at(k));
      if (!around) return k;
      k = lowerBound(at, around[0], 0, k) - 1;
    }
    return -1;
  }

  reach(
    x: NumericArray,
    start: number,
    end: number,
    length: number,
    rows?: Uint32Array,
  ): [number, number] {
    const hidden = (k: number) => this.hides(x[rows === undefined ? k : rows[k]!]!);
    if (start < end && hidden(start)) start = Math.max(0, this.shownBefore(x, start, rows));
    if (start < end && hidden(end - 1))
      end = Math.min(length, this.shownFrom(x, end - 1, length, rows) + 1);
    return [start, end];
  }

  nearestShown(
    x: NumericArray,
    k: number,
    end: number,
    back: boolean,
    sorted: boolean,
    rows?: Uint32Array,
  ): number {
    const shownWay = (toward: boolean) => {
      if (sorted) return toward ? this.shownBefore(x, k, rows) : this.shownFrom(x, k, end, rows);
      const step = toward ? -1 : 1;
      for (let i = k; i >= 0 && i < end; i += step)
        if (!this.hides(x[rows === undefined ? i : rows[i]!]!)) return i;
      return -1;
    };
    const ahead = shownWay(back);
    if (ahead >= 0 && ahead < end) return ahead;
    const behind = shownWay(!back);
    return behind >= 0 && behind < end ? behind : -1;
  }

  /**
   * `domain` in positions, changed by `change`, and back in time: room at
   * the ends of an axis is time shown, which a break would swallow.
   * Unchanged when `change` keeps the positions.
   */
  inPositions(
    domain: [number, number],
    change: (positions: [number, number]) => [number, number],
  ): [number, number] {
    const positions: [number, number] = [this.collapse(domain[0]), this.collapse(domain[1])];
    const changed = change(positions);
    if (changed === positions) return domain;
    return [this.expand(changed[0]), this.expand(changed[1])];
  }

  /**
   * A domain that shows some time: one entirely inside a break (a view onto
   * a weekend) widens to the hour shown on either side of its seam, unless
   * it was `configured`, which is refused.
   */
  showing(domain: [number, number], configured: boolean): [number, number] {
    const seam = this.collapse(domain[0]);
    if (this.collapse(domain[1]) !== seam) return domain;
    if (configured)
      throw new RangeError(
        `The x domain [${domain[0]}, ${domain[1]}] lies inside an axis break and shows no time`,
      );
    const widened: [number, number] = [this.expand(seam - HOUR), this.expand(seam + HOUR)];
    return domain[0] > domain[1] ? [widened[1], widened[0]] : widened;
  }

  shown(x: NumericArray, start: number, end: number, rows?: Uint32Array): number[] {
    const ranges: number[] = [];
    if (end <= start) return ranges;
    const at = (k: number) => x[rows === undefined ? k : rows[k]!]!;
    const breaks = this.within(at(start), at(end - 1));
    // The start of the shown range so far, and the first position that may
    // be in a break still to come: breaks and positions both ascend, so
    // each search starts where the last ended.
    let k = start;
    let next = start;
    for (let i = breaks.start; i < breaks.end && next < end; i++) {
      next = gallop(at, breaks.from[i]!, next, end);
      // Most breaks hold no rows: then the shown range runs on.
      if (next >= end || at(next) >= breaks.to[i]!) continue;
      if (next > k) ranges.push(k, next);
      k = next = gallop(at, breaks.to[i]!, next, end);
    }
    if (k < end) ranges.push(k, end);
    return ranges;
  }

  m4(
    x: NumericArray,
    y: NumericArray,
    start: number,
    end: number,
    xMap: Mapping,
    yMap: Mapping,
    pixelRatio: number,
    out: Polyline,
    rows?: Uint32Array,
    index?: RangeIndex,
  ): void {
    brokenM4(this, x, y, start, end, xMap, yMap, pixelRatio, out, rows, index);
  }

  /** A time scale over `domain` that leaves the breaks out. */
  scale(domain: readonly [number, number], range: readonly [number, number]): PositionScale {
    this.cover(domain[0], domain[1]);
    return new BrokenTimeScale(domain, range, this);
  }
}
