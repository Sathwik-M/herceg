// Label formatting with Intl. Format options are plain Intl option objects so
// they serialize unchanged between TypeScript, JSON specs, and Python.

import { stepDecimals } from "../scale/ticks.ts";
import type { TickContext, TimeInterval, TimeUnit } from "../scale/time.ts";
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
  return cached(
    numberFormats,
    `${locale}|${JSON.stringify(options)}`,
    // Values that round to zero, and -0 itself, print without a minus sign.
    () => new Intl.NumberFormat(locale, { signDisplay: "negative", ...options }),
  ).format;
}

export function timeFormatter(options: TimeFormat, zone: TimeZone, locale?: string): Formatter {
  const full = { timeZone: zone === "local" ? undefined : zone, ...options };
  return cached(
    timeFormats,
    `${locale}|${JSON.stringify(full)}`,
    () => new Intl.DateTimeFormat(locale, full),
  ).format;
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

const MINUTE_FORMAT: TimeFormat = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
const SECOND_FORMAT: TimeFormat = { ...MINUTE_FORMAT, second: "2-digit" };

// Resolutions: fractional seconds, seconds, minutes, dates, months, years.
const FORMATS: TimeFormat[] = [
  { ...SECOND_FORMAT, fractionalSecondDigits: 3 },
  SECOND_FORMAT,
  MINUTE_FORMAT,
  { month: "short", day: "numeric" },
  { month: "short" },
  { year: "numeric" },
];

const RESOLUTION: Record<TimeUnit, number> = {
  millisecond: 0,
  second: 1,
  minute: 2,
  hour: 2,
  day: 3,
  week: 3,
  month: 4,
  year: 5,
};

/** Which label granularity a wall time is aligned to, coarsest first. */
function alignment(wall: number): number {
  if (wall % 1000) return 0;
  if (wall % 60_000) return 1;
  if (wall % 86_400_000) return 2;
  const date = new Date(wall);
  if (date.getUTCDate() !== 1) return 3;
  return date.getUTCMonth() ? 4 : 5;
}

/**
 * Labels for time ticks. Each tick is labeled by the finest calendar field it
 * is not aligned to, so midnight shows the date and January 1 shows the year,
 * the way people read time axes. A tick's context, when given, is a coarser
 * field it stands for (a session opening after a break over midnight shows
 * its date).
 */
export function timeTickLabels(
  ticks: readonly number[],
  interval: TimeInterval,
  zone: TimeZone,
  locale?: string,
  contexts?: readonly (TickContext | undefined)[],
): string[] {
  return ticks.map((t, i) => {
    // Never print finer than the interval or a moved tick's context.
    const resolution = Math.max(
      RESOLUTION[interval.unit],
      alignment(toWall(zone, t)),
      RESOLUTION[contexts?.[i] ?? "millisecond"],
    );
    return timeFormatter(FORMATS[resolution]!, zone, locale)(t);
  });
}

/** Full timestamp format for tooltips, precise to `unit`. */
export function timeValueFormatter(unit: TimeUnit, zone: TimeZone, locale?: string): Formatter {
  const resolution = RESOLUTION[unit];
  return timeFormatter(
    {
      ...FORMATS[3],
      year: "numeric",
      ...(resolution < 3 && FORMATS[resolution]),
    },
    zone,
    locale,
  );
}
