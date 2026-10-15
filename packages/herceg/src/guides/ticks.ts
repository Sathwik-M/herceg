// Ticks and labels of axes whose settings ask for more than a count and
// Intl options: ticks every so often, at given values, or from a function,
// and labels written by a pattern or a function. Planned with the axis,
// never on pointer movement.

import type { Formatter } from "../format/format.ts";
import { numberPattern, timePattern } from "../format/patterns.ts";
import type { AxisBreaks, AxisContext, AxisType } from "../model/axis.ts";
import type { GuideKit } from "../model/guides.ts";
import type { PositionScale } from "../scale/scale.ts";
import type { CalendarScale, TimeInterval, TimeUnit } from "../scale/time.ts";
import type { Format, Ticks } from "./options.ts";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** A unit's length in milliseconds; a month's and a year's only roughly. */
const UNIT_MS: Record<TimeUnit, number> = {
  millisecond: 1,
  second: SECOND,
  minute: MINUTE,
  hour: HOUR,
  day: DAY,
  week: 7 * DAY,
  month: 30 * DAY,
  year: 365 * DAY,
};

/** A layer's ticks and their labels. */
export interface TickPlan {
  ticks: number[];
  labels: string[];
}

/** Where an axis' settings are, for messages: its ticks' and format's paths. */
export interface SettingPaths {
  ticks: string;
  format: string;
}

/** Plans the ticks and labels of `ticker` for about `count` ticks. */
export type Planner = (ticker: PositionScale, count: number) => TickPlan;

/** Ticks closer than this many pixels are thinned to every n-th. */
const DENSEST = 2;
/** The most values a list or a function may give. */
const MOST_VALUES = 10_000;

/**
 * How an axis of `scale` with `ticks` and `format` plans its ticks; labels
 * repeating the one before them are left out unless `duplicates` is "show".
 */
export function tickPlanner(
  kit: GuideKit,
  ticks: Ticks | undefined,
  format: Format | undefined,
  context: AxisContext,
  scale: string,
  paths: SettingPaths,
  duplicates: "hide" | "show" = "hide",
): Planner {
  const generate = generator(kit, ticks, context, scale, paths.ticks);
  const write = writer(kit, format, context, scale, paths.format);
  return (ticker, count) => {
    const values = generate?.(ticker, count);
    if (values) {
      const labels = write
        ? write.ticks(values)
        : defaultLabels(kit, values, ticker, context, generate);
      return { ticks: values, labels: duplicates === "show" ? labels : blankRepeats(labels) };
    }
    // Automatic ticks: a function writing them labels each, repeats left
    // out; other formats ask for fewer ticks where they cannot tell them
    // apart; with duplicates shown, each is labeled as written.
    let auto = ticker.ticks(count);
    if (!write) return { ticks: auto, labels: defaultLabels(kit, auto, ticker, context) };
    let labels = write.ticks(auto);
    if (duplicates === "show") return { ticks: auto, labels };
    if (write.callback) return { ticks: auto, labels: blankRepeats(labels) };
    let unique = new Set(labels);
    if (unique.size < labels.length) {
      const coarser = ticker.ticks((count * unique.size) / labels.length);
      if (coarser.length > 0) {
        auto = coarser;
        labels = write.ticks(auto);
        unique = new Set(labels);
      }
    }
    if (unique.size < labels.length) {
      const distinct = [...unique];
      auto = auto.filter((_, i) => unique.delete(labels[i]!));
      labels = distinct;
    }
    return { ticks: auto, labels };
  };
}

/** How many ticks `ticks` asks for, when it is a count. */
export function countOf(ticks: Ticks | undefined): number | undefined {
  return typeof ticks === "number" ? ticks : ticks && "count" in ticks ? ticks.count : undefined;
}

/** Labels equal to the one before them, left out. */
function blankRepeats(labels: string[]): string[] {
  return labels.map((label, i) => (i > 0 && label !== "" && label === labels[i - 1] ? "" : label));
}

/** Writes values as `format` says, for ticks and for single values; undefined for a format of none. */
export function writer(
  kit: GuideKit,
  format: Format | undefined,
  context: AxisContext,
  scale: string,
  path: string,
): { ticks: (values: number[]) => string[]; value: Formatter; callback: boolean } | undefined {
  if (format === undefined) return undefined;
  const { type, zone, locale } = context;
  const kind = type === "band" ? "linear" : type;
  if (typeof format === "function") {
    const base = { scale, type: kind, timeZone: zone, locale };
    const text = (written: unknown, value: number): string => {
      if (typeof written !== "string")
        throw new TypeError(
          `${path}: the function returned ${typeof written === "object" ? "an object" : String(written)} for ${value}; return a string ("" for no label)`,
        );
      return written;
    };
    return {
      callback: true,
      ticks: (values) =>
        values.map((value, index) =>
          text(format(value, { ...base, kind: "tick", index, values }), value),
        ),
      value: (value) => text(format(value, { ...base, kind: "value" }), value),
    };
  }
  let write: Formatter;
  if ("number" in format) {
    if (type === "time")
      throw new Error(
        `${path}.number: a time axis writes times; give { time: "%b %d" } or Intl date options`,
      );
    write = numberPattern(kit, format.number, locale, `${path}.number`);
  } else if ("time" in format) {
    if (type !== "time")
      throw new Error(
        `${path}.time: a ${type} axis writes numbers; give { number: ",.2f" } or Intl number options`,
      );
    write = timePattern(kit, format.time, zone, locale, `${path}.time`);
  } else
    write =
      type === "time"
        ? kit.timeFormatter(format as Intl.DateTimeFormatOptions, zone, locale)
        : kit.numberFormatter(format as Intl.NumberFormatOptions, locale);
  return { callback: false, ticks: (values) => values.map(write), value: write };
}

/**
 * Labels without a format: as automatic ticks are labeled, the interval of
 * time ticks the one they step by (or the closest two are apart), and
 * numbers given one by one as single values are written.
 */
function defaultLabels(
  kit: GuideKit,
  ticks: number[],
  ticker: PositionScale,
  context: AxisContext,
  generated?: Generate,
): string[] {
  const { type, zone, locale } = context;
  if (type === "time") {
    const interval =
      generated?.interval ??
      (generated ? spacing(kit, ticks, ticker) : (ticker as CalendarScale).interval(ticks.length));
    const contexts = generated ? undefined : (ticker as CalendarScale).tickContexts?.(ticks);
    return kit.timeTickLabels(ticks, interval, zone, locale, contexts);
  }
  if (generated && !generated.regular) return ticks.map((value) => kit.formatNumber(value, locale));
  return kit.numberTickLabels(ticks, locale);
}

/** The calendar interval nearest the closest two of `ticks`. */
function spacing(kit: GuideKit, ticks: readonly number[], ticker: PositionScale): TimeInterval {
  let gap = Infinity;
  for (let i = 1; i < ticks.length; i++) gap = Math.min(gap, ticks[i]! - ticks[i - 1]!);
  if (!Number.isFinite(gap)) gap = Math.abs(ticker.domain[1]! - ticker.domain[0]!) / 5;
  return kit.chooseInterval(gap, 1);
}

/** Generated ticks, with what labels them: the interval of calendar steps, and whether they step evenly. */
type Generate = ((ticker: PositionScale, count: number) => number[]) & {
  interval?: TimeInterval;
  regular?: boolean;
};

/** How ticks are generated; undefined for automatic ticks (a count, or none). */
function generator(
  kit: GuideKit,
  ticks: Ticks | undefined,
  context: AxisContext,
  scale: string,
  path: string,
): Generate | undefined {
  if (ticks === undefined || typeof ticks === "number" || "count" in ticks) return undefined;
  const { type, zone, locale, breaks } = context;
  const kind = type === "band" ? "linear" : type;
  if (typeof ticks === "function")
    return (ticker, count) => {
      const [lo, hi] = ascending(ticker);
      const out = ticks({
        scale,
        type: kind,
        domain: [lo, hi],
        pixels: pixelsOf(ticker),
        count,
        timeZone: zone,
        locale,
      });
      if (!Array.isArray(out))
        throw new TypeError(
          `${path}: the function returned ${String(out)}; return a list of values`,
        );
      return within(values(out, type, path), ticker, breaks);
    };
  if ("values" in ticks) {
    const given = values(ticks.values, type, `${path}.values`);
    return (ticker) => within(given, ticker, breaks);
  }
  const { every, anchor } = ticks;
  if (type === "log")
    throw new Error(`${path}.every: a log axis has no even steps; give ticks a count or values`);
  if (typeof every === "number") {
    if (type === "time")
      throw new Error(
        `${path}.every: a time axis steps by time; give an interval such as "6 hours", or { milliseconds: ${every} } for elapsed time`,
      );
    return stepper(positive(every, `${path}.every`), anchor ?? 0, breaks);
  }
  if (type !== "time")
    throw new Error(
      `${path}.every: ${JSON.stringify(every)} steps through time; a ${type} axis steps by a number`,
    );
  if (typeof every === "object" && "milliseconds" in every)
    return stepper(positive(every.milliseconds, `${path}.every.milliseconds`), anchor ?? 0, breaks);
  if (anchor !== undefined)
    throw new Error(
      `${path}.anchor: calendar steps start at calendar boundaries in the time zone; drop anchor, or step by { milliseconds }`,
    );
  const interval = calendarInterval(every, `${path}.every`);
  const generate: Generate = (ticker) => {
    const [lo, hi] = ascending(ticker);
    // Zoomed far out, a coarser step of the same boundaries keeps ticks apart.
    const gap = (hi - lo) / Math.max(1, pixelsOf(ticker) / DENSEST);
    const [unit, step] = sparser(interval.unit, interval.step, gap);
    return dropHidden(calendarTicks(kit, lo, hi, unit, step, zone), breaks);
  };
  generate.interval = interval;
  return generate;
}

/** Ticks `step` apart from `anchor`, thinned to keep them DENSEST pixels apart. */
function stepper(step: number, anchor: number, breaks: AxisBreaks | undefined): Generate {
  const generate: Generate = (ticker) => {
    const [lo, hi] = ascending(ticker);
    const first = Math.ceil((lo - anchor) / step - 1e-9);
    const last = Math.floor((hi - anchor) / step + 1e-9);
    const room = Math.max(1, pixelsOf(ticker) / DENSEST);
    const thin = Math.max(1, Math.ceil((last - first + 1) / room));
    // Counted from the first, so that steps too small for the numbers'
    // precision (1 near 1e16) cannot stall: equal values are left out.
    const start = Math.ceil(first / thin);
    const count = Math.min(Math.floor(last / thin) - start + 1, Math.ceil(room) + 1);
    const slack = (hi - lo) * 1e-9;
    const out: number[] = [];
    for (let j = 0; j < count; j++) {
      const raw = anchor + (start + j) * thin * step;
      // Tidied of float noise (0.30000000000000004), where tidying moves it by noise only.
      const tidy = Number(raw.toPrecision(15));
      const value = Math.abs(tidy - raw) <= Math.abs(step) * 1e-9 ? tidy : raw;
      if (value >= lo - slack && value <= hi + slack && value !== out.at(-1)) out.push(value);
    }
    return dropHidden(out, breaks);
  };
  generate.regular = true;
  return generate;
}

const UNITS: readonly TimeUnit[] = [
  "millisecond",
  "second",
  "minute",
  "hour",
  "day",
  "week",
  "month",
  "year",
];

/** A calendar interval from its readable form ("day", "6 hours") or `{ unit, step }`. */
export function calendarInterval(
  every: string | { unit: TimeUnit; step?: number },
  path: string,
): TimeInterval {
  let unit: string | undefined;
  let step = 1;
  if (typeof every === "string") {
    const match = /^(?:(\d+) )?([a-z]+?)s?$/.exec(every.trim());
    unit = match?.[2];
    if (match?.[1]) step = Number(match[1]);
  } else {
    unit = every.unit;
    step = every.step ?? 1;
  }
  if (!UNITS.includes(unit as TimeUnit) || !(Number.isInteger(step) && step >= 1))
    throw new Error(
      `${path}: ${JSON.stringify(every)} is not a time interval; write a unit ("hour", "day", "week", "month", "year"), a count and a unit ("6 hours", "15 minutes"), or { unit, step }`,
    );
  const known = unit as TimeUnit;
  return { unit: known, step, duration: UNIT_MS[known] * step };
}

const MONDAY = Date.UTC(1970, 0, 5);

/** How many of a unit its steps count within before starting again: a second's milliseconds, a day's hours. */
const WITHIN: Partial<Record<TimeUnit, number>> = {
  millisecond: 1000,
  second: 60,
  minute: 60,
  hour: 24,
  // Months differ in length; a step past 28 days leaves only their first.
  day: 28,
  month: 12,
};
const PARENT: Partial<Record<TimeUnit, TimeUnit>> = {
  millisecond: "second",
  second: "minute",
  minute: "hour",
  hour: "day",
  day: "month",
  month: "year",
};

/**
 * The least coarser step of `unit` whose ticks are at least `gap` apart,
 * all of them `step`'s boundaries too: a multiple of the step (dividing its
 * count within the larger unit, so steps stay even across it), or the
 * larger unit's starts. Weeks and years step by any multiple.
 */
function sparser(unit: TimeUnit, step: number, gap: number): [TimeUnit, number] {
  for (;;) {
    if (UNIT_MS[unit] * step >= gap) return [unit, step];
    const within = WITHIN[unit];
    let next = Math.ceil(gap / (UNIT_MS[unit] * step)) * step;
    if (within === undefined) return [unit, next];
    while (next < within && unit !== "day" && within % next !== 0) next += step;
    if (next < within) return [unit, next];
    unit = PARENT[unit]!;
    step = 1;
  }
}

/**
 * Calendar boundaries every `step` units within [lo, hi] in `zone`, at the
 * same places whatever the domain: steps within the larger unit (seconds
 * within the minute, hours within the day, days within the month, months
 * within the year), weeks counted from a Monday, and years from year 0.
 */
function calendarTicks(
  kit: GuideKit,
  lo: number,
  hi: number,
  unit: TimeUnit,
  step: number,
  zone: string,
): number[] {
  // Hours step through absolute time, keeping both of a repeated hour.
  if (step === 1 || unit === "hour")
    return kit.timeTicks(lo, hi, { unit, step, duration: UNIT_MS[unit] * step }, zone);
  if (unit === "millisecond" || unit === "second" || unit === "minute")
    return withinHours(kit, lo, hi, unit, step, zone);
  const out: number[] = [];
  const add = (wall: number) => {
    const t = kit.fromWall(zone, wall);
    if (t >= lo && t <= hi && !(t <= (out.at(-1) ?? -Infinity))) out.push(t);
  };
  const first = kit.toWall(zone, lo);
  const last = kit.toWall(zone, hi);
  if (unit === "week") {
    const size = step * UNIT_MS.week;
    for (let w = MONDAY + Math.floor((first - MONDAY) / size) * size; w <= last; w += size) add(w);
    return out;
  }
  if (unit === "year") {
    const year = (y: number) => new Date(0).setUTCFullYear(y, 0, 1);
    const from = new Date(first).getUTCFullYear();
    for (let y = Math.floor(from / step) * step; year(y) <= last; y += step) add(year(y));
    return out;
  }
  // Days within the month and months within the year, starting again at each of its starts.
  const parent = PARENT[unit]!;
  const startOf = (wall: number, by: number) => {
    const date = new Date(wall);
    if (parent === "month") return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + by, 1);
    if (parent === "year") return new Date(0).setUTCFullYear(date.getUTCFullYear() + by, 0, 1);
    const size = UNIT_MS[parent];
    return (Math.floor(wall / size) + by) * size;
  };
  for (let start = startOf(first, 0); start <= last; start = startOf(start, 1)) {
    const end = startOf(start, 1);
    for (let k = 0; ; k += step) {
      const wall =
        unit === "month"
          ? Date.UTC(new Date(start).getUTCFullYear(), k, 1)
          : start + k * UNIT_MS[unit];
      if (wall >= end) break;
      add(wall);
    }
  }
  return out;
}

/**
 * Steps of milliseconds, seconds, or minutes within the larger unit (a
 * second, a minute, an hour), through absolute time as the hours they fall
 * in pass: an hour repeated as clocks go back has its ticks twice, and one
 * skipped has none, as hours' own ticks do.
 */
function withinHours(
  kit: GuideKit,
  lo: number,
  hi: number,
  unit: TimeUnit,
  step: number,
  zone: string,
): number[] {
  const size = UNIT_MS[unit] * step;
  const parent = UNIT_MS[PARENT[unit]!];
  const out: number[] = [];
  // From the wall time's step at or before `lo`, in absolute time.
  let t = lo - ((((kit.toWall(zone, lo) % parent) + parent) % parent) % size);
  for (let guard = 0; t <= hi && guard < 100_000; guard++) {
    const within = ((kit.toWall(zone, t) % parent) + parent) % parent;
    if (within % UNIT_MS[unit] !== 0) {
      // An offset change by a fraction of the unit: on to the next step of the wall grid.
      t += size - (within % size);
      continue;
    }
    if (t >= lo && (within / UNIT_MS[unit]) % step === 0) out.push(t);
    // The next step, or the next start of the larger unit, where steps start again.
    t += Math.min(size - (within % size), parent - within);
  }
  return out;
}

/** A list of tick values as numbers: Dates in milliseconds; categories refused. */
function values(list: readonly unknown[], type: AxisType, path: string): number[] {
  if (list.length > MOST_VALUES)
    throw new RangeError(`${path}: ${list.length} values; give at most ${MOST_VALUES}`);
  return list.map((value, i) => {
    const n = value instanceof Date ? value.getTime() : value;
    if (typeof n !== "number" || !Number.isFinite(n))
      throw new TypeError(
        `${path}[${i}]: expected a finite number${type === "time" ? ", epoch milliseconds, or a Date" : ""}; received ${typeof n === "string" ? JSON.stringify(n) : String(n)}`,
      );
    if (type === "log" && !(n > 0))
      throw new RangeError(`${path}[${i}]: ${n} is not on a log axis; give values above 0`);
    return n;
  });
}

/** `values` inside the ticker's domain and outside breaks, ascending, each once. */
function within(
  given: readonly number[],
  ticker: PositionScale,
  breaks: AxisBreaks | undefined,
): number[] {
  const [lo, hi] = ascending(ticker);
  const slack = (hi - lo) * 1e-9;
  const inside = given.filter((v) => v >= lo - slack && v <= hi + slack).sort((a, b) => a - b);
  return dropHidden(
    inside.filter((v, i) => i === 0 || v !== inside[i - 1]),
    breaks,
  );
}

function dropHidden(ticks: number[], breaks: AxisBreaks | undefined): number[] {
  return breaks ? ticks.filter((t) => !breaks.hides(t)) : ticks;
}

function ascending(scale: PositionScale): [number, number] {
  const [a, b] = scale.domain as readonly [number, number];
  return a <= b ? [a, b] : [b, a];
}

function pixelsOf(scale: PositionScale): number {
  return Math.abs(scale.range[1]! - scale.range[0]!);
}

function positive(value: number, path: string): number {
  if (!(value > 0 && Number.isFinite(value)))
    throw new RangeError(`${path}: expected a positive number; received ${value}`);
  return value;
}
