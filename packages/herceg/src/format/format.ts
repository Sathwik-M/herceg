// Label formatting with Intl. Format options are plain Intl option objects so
// they serialize unchanged between TypeScript, JSON specs, and Python.

import { stepDecimals } from "../scale/ticks.ts";
import { TIME_UNIT_MS, type TimeInterval, type TimeUnit } from "../scale/time.ts";
import { type TimeZone, toWall } from "./zone.ts";

export type NumberFormat = Intl.NumberFormatOptions;
export type TimeFormat = Intl.DateTimeFormatOptions;
export type Formatter = (value: number) => string;

const numberFormats = new Map<string, Intl.NumberFormat>();
const timeFormats = new Map<string, Intl.DateTimeFormat>();

function cached<T>(cache: Map<string, T>, key: string, create: () => T): T {
  let value = cache.get(key);
  if (value === undefined) {
    value = create();
    cache.set(key, value);
  }
  return value;
}

export function numberFormatter(options: NumberFormat, locale?: string): Formatter {
  const format = cached(
    numberFormats,
    `${locale}|${JSON.stringify(options)}`,
    () => new Intl.NumberFormat(locale, options),
  );
  return (value) => format.format(value);
}

function intlZone(zone: TimeZone): string | undefined {
  return zone === "local" ? undefined : zone;
}

export function timeFormatter(options: TimeFormat, zone: TimeZone, locale?: string): Formatter {
  const full = { timeZone: intlZone(zone), ...options };
  const format = cached(
    timeFormats,
    `${locale}|${JSON.stringify(full)}`,
    () => new Intl.DateTimeFormat(locale, full),
  );
  return (value) => format.format(value);
}

/**
 * Labels for numeric ticks: enough decimals to tell neighbors apart, and
 * compact notation ("2.5M") for large magnitudes.
 */
export function numberTickLabels(ticks: readonly number[], locale?: string): string[] {
  if (ticks.length === 0) return [];
  const step = ticks.length > 1 ? Math.abs(ticks[1]! - ticks[0]!) : Math.abs(ticks[0]!) || 1;
  const largest = Math.max(...ticks.map(Math.abs));
  if (largest >= 1e6) {
    // Compact notation rounds the scaled value ("2.5M"), so decimals depend on
    // the step relative to the thousands group of the largest tick.
    const group = 10 ** (3 * Math.floor(Math.log10(largest) / 3));
    const format = numberFormatter(
      { notation: "compact", maximumFractionDigits: stepDecimals(step / group) },
      locale,
    );
    return ticks.map(format);
  }
  const decimals = stepDecimals(step);
  if (decimals <= 12) {
    const fixed = numberFormatter(
      { minimumFractionDigits: decimals, maximumFractionDigits: decimals },
      locale,
    );
    const labels = ticks.map(fixed);
    if (new Set(labels).size === labels.length) return labels;
  }
  // Steps too small for fixed decimals: scientific notation with enough
  // digits to tell neighboring ticks apart.
  for (let digits = 2; digits <= 17; digits++) {
    const labels = ticks.map(
      numberFormatter({ notation: "scientific", maximumSignificantDigits: digits }, locale),
    );
    if (new Set(labels).size === labels.length) return labels;
  }
  return ticks.map(String);
}

/** Readable default for a single value, such as in a tooltip. */
export function formatNumber(value: number, locale?: string): string {
  if (!Number.isFinite(value)) return String(value);
  const options: NumberFormat =
    Math.abs(value) >= 1 || value === 0
      ? { maximumFractionDigits: 2 }
      : { maximumSignificantDigits: 3 };
  return numberFormatter(options, locale)(value);
}

const FORMATS: Record<"fraction" | "second" | "minute" | "day" | "month" | "year", TimeFormat> = {
  fraction: {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hourCycle: "h23",
  },
  second: { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" },
  minute: { hour: "2-digit", minute: "2-digit", hourCycle: "h23" },
  day: { month: "short", day: "numeric" },
  month: { month: "short" },
  year: { year: "numeric" },
};

/** Which label granularity a wall time is aligned to, coarsest first. */
function alignment(wall: number): keyof typeof FORMATS {
  const date = new Date(wall);
  if (date.getUTCMilliseconds() !== 0) return "fraction";
  if (date.getUTCSeconds() !== 0) return "second";
  if (date.getUTCMinutes() !== 0 || date.getUTCHours() !== 0) return "minute";
  if (date.getUTCDate() !== 1) return "day";
  if (date.getUTCMonth() !== 0) return "month";
  return "year";
}

/**
 * Labels for time ticks. Each tick is labeled by the finest calendar field it
 * is not aligned to, so midnight shows the date and January 1 shows the year,
 * the way people read time axes.
 */
export function timeTickLabels(
  ticks: readonly number[],
  interval: TimeInterval,
  zone: TimeZone,
  locale?: string,
): string[] {
  const finest: keyof typeof FORMATS =
    interval.unit === "millisecond"
      ? "fraction"
      : interval.unit === "second"
        ? "second"
        : interval.unit === "minute" || interval.unit === "hour"
          ? "minute"
          : interval.unit === "day" || interval.unit === "week"
            ? "day"
            : interval.unit === "month"
              ? "month"
              : "year";
  const order = Object.keys(FORMATS) as (keyof typeof FORMATS)[];
  return ticks.map((t) => {
    const aligned = alignment(toWall(zone, t));
    // Never print finer than the interval resolution.
    const key = order.indexOf(aligned) < order.indexOf(finest) ? finest : aligned;
    return timeFormatter(FORMATS[key], zone, locale)(t);
  });
}

/** Full timestamp format for tooltips, precise to `unit`. */
export function timeValueFormatter(unit: TimeUnit, zone: TimeZone, locale?: string): Formatter {
  const date: TimeFormat = { year: "numeric", month: "short", day: "numeric" };
  const precise =
    TIME_UNIT_MS[unit] >= TIME_UNIT_MS.day
      ? date
      : unit === "millisecond"
        ? { ...date, ...FORMATS.fraction }
        : unit === "second"
          ? { ...date, ...FORMATS.second }
          : { ...date, ...FORMATS.minute };
  return timeFormatter(precise, zone, locale);
}
