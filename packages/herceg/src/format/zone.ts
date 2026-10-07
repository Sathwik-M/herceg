// Time zone arithmetic. Times are epoch milliseconds; "wall" times are the
// same calendar fields expressed as if they were UTC, which lets calendar math
// use Date.UTC regardless of the zone.

/** "UTC", "local" (the runtime's zone), or an IANA zone such as "Europe/Belgrade". */
export type TimeZone = string;

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(zone: string): Intl.DateTimeFormat {
  let formatter = partsFormatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    partsFormatters.set(zone, formatter);
  }
  return formatter;
}

const QUARTER_HOUR = 900_000;
const offsets = new Map<string, number>();

/** Offset of `zone` from UTC at time `t`, in milliseconds. */
export function zoneOffset(zone: TimeZone, t: number): number {
  if (zone === "UTC") return 0;
  if (zone === "local") return -new Date(t).getTimezoneOffset() * 60_000;
  // Offset changes happen on quarter-hour boundaries, so one lookup per
  // quarter hour is exact. Tick generation asks for many nearby instants.
  const key = `${zone}|${Math.floor(t / QUARTER_HOUR)}`;
  let offset = offsets.get(key);
  if (offset === undefined) {
    offset = intlOffset(zone, Math.floor(t / QUARTER_HOUR) * QUARTER_HOUR);
    if (offsets.size > 10_000) offsets.clear();
    offsets.set(key, offset);
  }
  return offset;
}

function intlOffset(zone: string, t: number): number {
  const fields: Record<string, number> = {};
  for (const part of partsFormatter(zone).formatToParts(t)) {
    if (part.type !== "literal") fields[part.type] = Number(part.value);
  }
  const wall = Date.UTC(
    fields.year!,
    fields.month! - 1,
    fields.day!,
    fields.hour!,
    fields.minute!,
    fields.second!,
  );
  // `t` is a quarter-hour boundary, so it has no milliseconds to drop.
  return wall - t;
}

export function toWall(zone: TimeZone, t: number): number {
  return t + zoneOffset(zone, t);
}

const DAY = 86_400_000;

/**
 * Converts a wall time back to epoch ms. A wall time that occurs twice (when
 * clocks fall back) resolves to the earlier instant; one skipped by a jump
 * forward resolves to the instant after the jump, the way clocks read it.
 * Assumes offset transitions are more than a day apart.
 */
export function fromWall(zone: TimeZone, wall: number): number {
  if (zone === "UTC") return wall;
  const before = wall - zoneOffset(zone, wall - DAY);
  const after = wall - zoneOffset(zone, wall + DAY);
  const beforeValid = toWall(zone, before) === wall;
  const afterValid = toWall(zone, after) === wall;
  if (beforeValid && afterValid) return Math.min(before, after);
  if (afterValid) return after;
  // Valid with the earlier offset, or skipped: the earlier offset places a
  // skipped wall time after the jump.
  return before;
}
