import { fromWall, type TimeZone, toWall } from "../format/zone.ts";
import { LinearScale, type PositionScale } from "./scale.ts";
import { tickStep } from "./ticks.ts";

export type TimeUnit =
  | "millisecond"
  | "second"
  | "minute"
  | "hour"
  | "day"
  | "week"
  | "month"
  | "year";

export interface TimeInterval {
  unit: TimeUnit;
  step: number;
  /** Approximate length in milliseconds, used to choose an interval. */
  duration: number;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

const UNIT_MS: Record<TimeUnit, number> = {
  millisecond: 1,
  second: SECOND,
  minute: MINUTE,
  hour: HOUR,
  day: DAY,
  week: WEEK,
  month: MONTH,
  year: YEAR,
};

const LADDER: [TimeUnit, number][] = [
  ["second", 1],
  ["second", 2],
  ["second", 5],
  ["second", 10],
  ["second", 15],
  ["second", 30],
  ["minute", 1],
  ["minute", 2],
  ["minute", 5],
  ["minute", 10],
  ["minute", 15],
  ["minute", 30],
  ["hour", 1],
  ["hour", 2],
  ["hour", 3],
  ["hour", 6],
  ["hour", 12],
  ["day", 1],
  ["day", 2],
  ["week", 1],
  ["month", 1],
  ["month", 3],
  ["month", 6],
  ["year", 1],
];

const INTERVALS: TimeInterval[] = LADDER.map(([unit, step]) => ({
  unit,
  step,
  duration: UNIT_MS[unit] * step,
}));

/** The calendar interval that gives about `count` ticks across `span` ms. */
export function chooseInterval(span: number, count: number): TimeInterval {
  const target = span / Math.max(1, count);
  if (target < SECOND) {
    const step = Math.max(1, tickStep(0, span, count));
    return { unit: "millisecond", step, duration: step };
  }
  for (let i = 0; i < INTERVALS.length - 1; i++) {
    const interval = INTERVALS[i]!;
    if (target < Math.sqrt(interval.duration * INTERVALS[i + 1]!.duration)) return interval;
  }
  // Multi-year spans: 1, 2, 5, 10, 20, ... years.
  const step = Math.max(1, tickStep(0, span / YEAR, count));
  return { unit: "year", step, duration: step * YEAR };
}

/** Floors a wall time to the start of its interval. */
function floorWall(wall: number, interval: TimeInterval): number {
  const { unit, step } = interval;
  if (unit === "millisecond" || unit === "second" || unit === "minute" || unit === "hour") {
    const size = UNIT_MS[unit] * step;
    // Hours step within the day so 3-hour ticks land on 0, 3, 6, ...
    if (unit === "hour") {
      const day = Math.floor(wall / DAY) * DAY;
      return day + Math.floor((wall - day) / size) * size;
    }
    return Math.floor(wall / size) * size;
  }
  const date = new Date(wall);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  if (unit === "day") {
    const dayOfMonth = date.getUTCDate();
    return Date.UTC(year, month, dayOfMonth - ((dayOfMonth - 1) % step));
  }
  if (unit === "week") {
    // Weeks start on Monday.
    const dayOfMonth = date.getUTCDate() - ((date.getUTCDay() + 6) % 7);
    return Date.UTC(year, month, dayOfMonth);
  }
  if (unit === "month") return Date.UTC(year, month - (month % step), 1);
  return Date.UTC(year - (year % step), 0, 1);
}

function addWall(wall: number, interval: TimeInterval, times: number): number {
  const { unit, step } = interval;
  const date = new Date(wall);
  switch (unit) {
    case "day":
    case "week": {
      const days = (unit === "week" ? 7 : 1) * step * times;
      return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days);
    }
    case "month":
      return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + step * times, 1);
    case "year":
      return Date.UTC(date.getUTCFullYear() + step * times, 0, 1);
    default:
      return wall + UNIT_MS[unit] * step * times;
  }
}

const SUB_DAY: readonly TimeUnit[] = ["millisecond", "second", "minute", "hour"];
/** Length of the unit that contains each sub-day unit, for step alignment. */
const PARENT_MS: Partial<Record<TimeUnit, number>> = {
  millisecond: SECOND,
  second: MINUTE,
  minute: HOUR,
  hour: DAY,
};

/** Ticks at calendar boundaries of `interval` in `zone`, within [start, stop]. */
export function timeTicks(
  start: number,
  stop: number,
  interval: TimeInterval,
  zone: TimeZone,
): number[] {
  const lo = Math.min(start, stop);
  const hi = Math.max(start, stop);
  if (!(Number.isFinite(lo) && Number.isFinite(hi))) return [];
  return SUB_DAY.includes(interval.unit)
    ? subDayTicks(lo, hi, interval, zone)
    : calendarTicks(lo, hi, interval, zone);
}

/**
 * Seconds, minutes, and hours last the same in every zone, so these ticks
 * step through absolute time one unit at a time and keep the instants whose
 * wall time is a multiple of the step. Across a DST change this skips wall
 * times that do not exist and keeps both occurrences of repeated ones, and
 * ticks never go backward.
 */
function subDayTicks(lo: number, hi: number, interval: TimeInterval, zone: TimeZone): number[] {
  const unit = UNIT_MS[interval.unit];
  const parent = PARENT_MS[interval.unit]!;
  const ticks: number[] = [];
  let wall = Math.floor(toWall(zone, lo) / unit) * unit;
  let t = fromWall(zone, wall);
  for (let guard = 0; t <= hi && guard < 100_000; guard++) {
    wall = toWall(zone, t);
    if (wall % unit !== 0) {
      // An offset change by a fraction of the unit: realign to the wall grid.
      t = fromWall(zone, Math.ceil(wall / unit) * unit);
      continue;
    }
    const withinParent = ((wall % parent) + parent) % parent;
    if (t >= lo && Math.round(withinParent / unit) % interval.step === 0) ticks.push(t);
    t += unit;
  }
  return ticks;
}

/** Days, weeks, months, and years: step through wall-clock calendar dates. */
function calendarTicks(lo: number, hi: number, interval: TimeInterval, zone: TimeZone): number[] {
  const ticks: number[] = [];
  const first = floorWall(toWall(zone, lo), interval);
  for (let i = 0; i < 10_000; i++) {
    const t = fromWall(zone, addWall(first, interval, i));
    if (t > hi) break;
    if (t >= lo && !(t <= (ticks[ticks.length - 1] ?? -Infinity))) ticks.push(t);
  }
  return ticks;
}

/** The calendar field a tick stands for when it is not its own instant's. */
export type TickContext = "day" | "month" | "year";

/** A scale of epoch milliseconds with calendar ticks in a time zone. */
export interface CalendarScale extends PositionScale {
  readonly type: "time";
  readonly zone: TimeZone;
  /** The calendar interval of `ticks(count)`. */
  interval(count: number): TimeInterval;
  /**
   * For each of the ticks `ticks(count)` returned, the calendar field it
   * labels when that is coarser than its own instant's: a tick moved out of
   * an axis break to the session it opens stands for the day (or month, or
   * year) that begins in the break.
   */
  tickContexts?(ticks: readonly number[]): readonly (TickContext | undefined)[] | undefined;
}

/** A linear scale over epoch milliseconds with calendar-aware ticks. */
export class TimeScale extends LinearScale implements CalendarScale {
  override readonly type = "time" as const;

  readonly zone: TimeZone;

  constructor(
    domain: readonly [number, number],
    range: readonly [number, number],
    zone: TimeZone = "local",
  ) {
    super(domain, range);
    this.zone = zone;
  }

  interval(count: number): TimeInterval {
    return chooseInterval(Math.abs(this.domain[1] - this.domain[0]), count);
  }

  override ticks(count: number): number[] {
    return timeTicks(this.domain[0], this.domain[1], this.interval(count), this.zone);
  }
}

/**
 * Extends a time domain to boundaries of the tick interval for `span`
 * milliseconds (by default the domain's; on an axis with breaks, the time it
 * shows).
 */
export function niceTimeDomain(
  start: number,
  stop: number,
  count: number,
  zone: TimeZone,
  span = stop - start,
): [number, number] {
  if (!(stop > start)) return [start, stop];
  const interval = chooseInterval(span, count);
  const lo = fromWall(zone, floorWall(toWall(zone, start), interval));
  let hiWall = floorWall(toWall(zone, stop), interval);
  if (fromWall(zone, hiWall) < stop) hiWall = addWall(hiWall, interval, 1);
  let hi = fromWall(zone, hiWall);
  // In a repeated hour (DST ending), a wall time names its earlier instant,
  // so a wall boundary may still fall before `stop`. Intervals shorter than
  // a day are fixed lengths of time: step in absolute time instead.
  const size = UNIT_MS[interval.unit] * interval.step;
  if (hi < stop && size < DAY) hi += Math.ceil((stop - hi) / size) * size;
  return [lo, Math.max(hi, stop)];
}

/** The latest boundary of `interval` in `zone` at or before `t`. */
export function floorTime(t: number, interval: TimeInterval, zone: TimeZone): number {
  return fromWall(zone, floorWall(toWall(zone, t), interval));
}

export const TIME_UNIT_MS = UNIT_MS;
