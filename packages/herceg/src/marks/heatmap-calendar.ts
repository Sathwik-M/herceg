// Calendar heatmaps: the days of a time field laid out in a time zone, by
// week and weekday, or by month and day of the month.

import type { NumericArray } from "../data/column.ts";
import { fromWall, type TimeZone, toWall } from "../format/zone.ts";
import type { Weekday } from "../spec/spec.ts";
import { AxisCells, latticeEdges, latticeOf } from "./heatmap-cells.ts";
import type { BandList } from "./mark.ts";

const DAY = 86_400_000;
const WEEK = 7 * DAY;
/** In `getUTCDay` order. */
const WEEKDAYS: readonly Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export type CalendarLayout = "weeks" | "months";

/**
 * Where a calendar places its table's rows. "weeks": along x, a cell per
 * week holding a day, from the start of its week to the next week's start
 * in the zone (so x is a time axis, which zooms), and along y a band per
 * day of the week, in order from `weekStart`. "months": along y a band per
 * month from the first day's to the last's, each month in between too, in
 * order, and along x a band per day of the month, 1 to 31. Days without
 * rows, and dates a month does not have, are empty. Labels name Gregorian
 * days and months, as the placement counts them, in the locale's language.
 */
export interface Calendar {
  /** The weeks along x ("weeks"). */
  weeks: AxisCells | undefined;
  /** Each row's day, as the instant it starts ("weeks"), NaN for rows without one. */
  days: Float64Array | undefined;
  /** The bands along x ("months") and y. */
  bands: { x: BandList | undefined; y: BandList };
  /** Each row's band index along x ("months") and y, -1 for rows without a day. */
  rows: { x: Int32Array | undefined; y: Int32Array };
}

/** Places the days of `column`, a time field, in `zone` (see `Calendar`). */
export function placeCalendar(
  column: NumericArray,
  layout: CalendarLayout,
  weekStart: Weekday,
  zone: TimeZone,
  locale: string | undefined,
): Calendar {
  // Each distinct instant's day, as wall-clock midnight in the zone; rows share their instant's.
  const ids = new Map<number, number>();
  const instant = new Int32Array(column.length);
  const days: number[] = [];
  for (let i = 0; i < column.length; i++) {
    const t = column[i]!;
    if (!Number.isFinite(t)) {
      instant[i] = -1;
      continue;
    }
    let id = ids.get(t);
    if (id === undefined) {
      id = days.length;
      ids.set(t, id);
      days.push(Math.floor(toWall(zone, t) / DAY) * DAY);
    }
    instant[i] = id;
  }
  const format = (options: Intl.DateTimeFormatOptions, wall: number) =>
    new Intl.DateTimeFormat(locale, { ...options, calendar: "gregory", timeZone: "UTC" }).format(
      wall,
    );
  const byRow = (of: (day: number) => number) => {
    const per = Int32Array.from(days, of);
    return instant.map((id) => (id < 0 ? -1 : per[id]!));
  };

  if (layout === "months") {
    // Months counted from year 0, so consecutive months differ by one.
    const monthOf = (day: number) => {
      const date = new Date(day);
      return date.getUTCFullYear() * 12 + date.getUTCMonth();
    };
    let [first, last] = [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
    for (const day of days) {
      const m = monthOf(day);
      [first, last] = [Math.min(first, m), Math.max(last, m)];
    }
    const keys: string[] = [];
    const labels: string[] = [];
    for (let m = first; m <= last; m++) {
      // setUTCFullYear, unlike Date.UTC, keeps years 0 to 99 as they are.
      const start = new Date(0);
      const year = Math.floor(m / 12);
      start.setUTCFullYear(year, m - year * 12, 1);
      keys.push(`month:${m}`);
      labels.push(format({ year: "numeric", month: "short" }, start.getTime()));
    }
    const dayKeys = Array.from({ length: 31 }, (_, d) => `day:${d + 1}`);
    const dayLabels = Array.from({ length: 31 }, (_, d) =>
      format({ day: "numeric" }, Date.UTC(2000, 0, d + 1)),
    );
    return {
      weeks: undefined,
      days: undefined,
      bands: { x: { keys: dayKeys, labels: dayLabels }, y: { keys, labels } },
      rows: {
        x: byRow((day) => new Date(day).getUTCDate() - 1),
        y: byRow((day) => monthOf(day) - first),
      },
    };
  }

  // Weeks: each day's place in its week, and the week's start, as wall-clock midnights.
  const start = WEEKDAYS.indexOf(weekStart);
  const weekday = (day: number) => (new Date(day).getUTCDay() - start + 7) % 7;
  const starts = [...new Set(days.map((day) => day - weekday(day) * DAY))].sort((a, b) => a - b);
  const index = new Map(starts.map((wall, i) => [wall, i]));
  const order = Array.from({ length: 7 }, (_, i) => (start + i) % 7);
  const weekdays: BandList = {
    keys: order.map((d) => `weekday:${WEEKDAYS[d]}`),
    // 2023-01-01 was a Sunday.
    labels: order.map((d) => format({ weekday: "short" }, Date.UTC(2023, 0, 1 + d))),
  };
  // Weeks start and end at the zone's midnights, which a clock change moves:
  // they are a lattice only when every one of them lasts seven days.
  const lower = Float64Array.from(starts, (wall) => fromWall(zone, wall));
  const upper = Float64Array.from(starts, (wall) => fromWall(zone, wall + WEEK));
  const even = lower.every((t, i) => upper[i]! - t === WEEK);
  const centers = lower.map((t) => t + WEEK / 2);
  const lattice = even && lower.length > 0 ? latticeOf(centers, WEEK, true) : undefined;
  const [from, to] = lattice ? latticeEdges(lattice, lower.length) : [lower, upper];
  const cells = byRow((day) => index.get(day - weekday(day) * DAY)!);
  const instants = Float64Array.from(days, (day) => fromWall(zone, day));
  return {
    weeks: new AxisCells(lower, from, to, cells, lattice),
    days: Float64Array.from(instant, (id) => (id < 0 ? Number.NaN : instants[id]!)),
    bands: { x: undefined, y: weekdays },
    rows: { x: undefined, y: byRow(weekday) },
  };
}
