// Axis breaks: resolving rules in a time zone, positions with the breaks
// taken out, and the scale and ticks over them.
import { describe, expect, it } from "vitest";
import { timeTickLabels } from "../../src/format/format.ts";
import { planAxis } from "../../src/model/axis.ts";
import { timeBreaks } from "../../src/scale/breaks.ts";
import type { CalendarScale } from "../../src/scale/time.ts";
import type { TimeBreakSpec } from "../../src/spec/spec.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const utc = (...parts: number[]) => Date.UTC(parts[0]!, parts[1]! - 1, ...parts.slice(2));

const calendar = (rules: TimeBreakSpec[], zone = "UTC") => timeBreaks(rules).calendar(zone);

describe("time breaks", () => {
  it("leave out whole weekdays, from midnight to midnight", () => {
    const weekend = calendar([{ weekdays: ["sat", "sun"] }]);
    // 2025-10-10 is a Friday.
    const friday = utc(2025, 10, 10, 23);
    const saturday = utc(2025, 10, 11, 12);
    const monday = utc(2025, 10, 13);
    expect(weekend.hides(saturday)).toBe(true);
    expect(weekend.hides(monday)).toBe(false);
    expect(weekend.hides(monday - 1)).toBe(true);
    expect(weekend.hides(friday)).toBe(false);
    // Saturday and Sunday join into one break from Saturday to Monday.
    expect(weekend.around(saturday)).toEqual([utc(2025, 10, 11), monday]);
    expect(weekend.collapse(monday) - weekend.collapse(friday)).toBe(HOUR);
    // Every hidden value sits at the seam, and the seam reads as the break's end.
    expect(weekend.collapse(saturday)).toBe(weekend.collapse(monday));
    expect(weekend.expand(weekend.collapse(saturday))).toBe(monday);
  });

  it("leave out daily hours, wrapping past midnight, in the chart's zone", () => {
    const sessions = calendar(
      [{ weekdays: ["sat", "sun"] }, { hours: ["16:00", "09:30"] }],
      "America/New_York",
    );
    // Friday 15:00 to Monday 10:00 in New York (EDT, UTC-4) shows 1.5 hours.
    const friday = utc(2025, 10, 10, 19);
    const monday = utc(2025, 10, 13, 14);
    expect(sessions.collapse(monday) - sessions.collapse(friday)).toBe(1.5 * HOUR);
    expect(sessions.around(utc(2025, 10, 11))).toEqual([
      utc(2025, 10, 10, 20),
      utc(2025, 10, 13, 13, 30),
    ]);
    // The session is shown from its open to the minute before its close.
    expect(sessions.hides(utc(2025, 10, 14, 13, 30))).toBe(false);
    expect(sessions.hides(utc(2025, 10, 14, 19, 59))).toBe(false);
    expect(sessions.hides(utc(2025, 10, 14, 20))).toBe(true);
  });

  it("follow wall-clock time across daylight saving changes", () => {
    const nights = calendar([{ hours: ["16:00", "09:30"] }], "America/New_York");
    // Clocks spring forward on 2025-03-09: that night's break lasts an hour less.
    expect(nights.around(utc(2025, 3, 9, 3))).toEqual([
      utc(2025, 3, 8, 21),
      utc(2025, 3, 9, 13, 30),
    ]);
    // And fall back on 2025-11-02: an hour more.
    expect(nights.around(utc(2025, 11, 2, 3))).toEqual([
      utc(2025, 11, 1, 20),
      utc(2025, 11, 2, 14, 30),
    ]);
    // A span in the repeated hour is left out both times, and what is between them is shown.
    const repeated = calendar([{ hours: ["01:15", "01:45"] }], "America/New_York");
    expect(repeated.hides(utc(2025, 11, 2, 5, 30))).toBe(true); // 01:30 EDT
    expect(repeated.hides(utc(2025, 11, 2, 5, 50))).toBe(false); // 01:50 EDT
    expect(repeated.hides(utc(2025, 11, 2, 6, 5))).toBe(false); // 01:05 EST
    expect(repeated.hides(utc(2025, 11, 2, 6, 30))).toBe(true); // 01:30 EST
    // Wall times a change skips take no time.
    const skipped = calendar([{ hours: ["02:15", "02:45"] }], "America/New_York");
    expect(skipped.hides(utc(2025, 3, 9, 7, 30))).toBe(false); // 03:30 EDT
    expect(skipped.hides(utc(2025, 3, 10, 6, 30))).toBe(true); // 02:30 EDT the next day
  });

  it("follow half-hour offset changes", () => {
    // Lord Howe Island moves from UTC+11 to UTC+10:30 at 02:00 on 2025-04-06.
    const span = calendar([{ hours: ["01:45", "02:15"] }], "Australia/Lord_Howe");
    expect(span.hides(utc(2025, 4, 5, 14, 50))).toBe(true); // 01:50 +11
    expect(span.hides(utc(2025, 4, 5, 15, 5))).toBe(false); // 01:35 +10:30
    expect(span.hides(utc(2025, 4, 5, 15, 20))).toBe(true); // 01:50 +10:30
    expect(span.hides(utc(2025, 4, 5, 15, 50))).toBe(false); // 02:20 +10:30
  });

  it("leave out whole calendar dates and spans of instants", () => {
    const holidays = calendar(
      [{ dates: ["2025-12-25"] }, { from: utc(2026, 1, 2, 12), to: utc(2026, 1, 2, 13) }],
      "America/New_York",
    );
    expect(holidays.around(utc(2025, 12, 25, 12))).toEqual([
      utc(2025, 12, 25, 5),
      utc(2025, 12, 26, 5),
    ]);
    expect(holidays.hides(utc(2026, 1, 2, 12, 30))).toBe(true);
    expect(holidays.hides(utc(2026, 1, 2, 13))).toBe(false);
    // A date in a 23-hour day lasts 23 hours.
    const spring = calendar([{ dates: ["2025-03-09"] }], "America/New_York");
    const [from, to] = spring.around(utc(2025, 3, 9, 12))!;
    expect(to - from).toBe(23 * HOUR);
  });

  it("keep every position as the resolved span grows either way", () => {
    const rules: TimeBreakSpec[] = [{ weekdays: ["sat", "sun"] }, { hours: ["17:00", "08:00"] }];
    const grown = calendar(rules, "Europe/Berlin");
    const probe = [utc(2025, 6, 2, 9), utc(2025, 6, 6, 12, 34), utc(2025, 6, 9, 15)];
    const before = probe.map((t) => grown.collapse(t));
    // Asking far after and far before resolves more.
    grown.collapse(utc(2027, 1, 4, 9));
    grown.collapse(utc(2023, 1, 2, 9));
    expect(probe.map((t) => grown.collapse(t))).toEqual(before);
    // A calendar resolved over the whole span at once agrees on every distance.
    const whole = calendar(rules, "Europe/Berlin");
    whole.cover(utc(2023, 1, 1), utc(2027, 2, 1));
    const ends = [utc(2023, 1, 2, 9), utc(2025, 6, 6, 12, 34), utc(2027, 1, 4, 9)];
    const distance = (c: typeof whole) => ends.map((t) => c.collapse(t) - c.collapse(ends[0]!));
    expect(distance(grown)).toEqual(distance(whole));
    // Positions and values agree both ways on shown values.
    for (const t of ends) expect(grown.expand(grown.collapse(t))).toBe(t);
    for (const p of [0, 12_345_678, -98_765_432]) {
      const at = grown.collapse(utc(2025, 6, 6, 12)) + p;
      expect(grown.collapse(grown.expand(at))).toBe(at);
    }
  });

  it("find the shown ranges of sorted values", () => {
    const weekend = calendar([{ weekdays: ["sat", "sun"] }]);
    // Fri, Sat, Sat, Sun, Mon, Tue, Sat
    const x = Float64Array.from([10, 11, 11.5, 12, 13, 14, 18], (d) => utc(2025, 10, 0) + d * DAY);
    expect(weekend.shown(x, 0, x.length)).toEqual([0, 1, 4, 6]);
    expect(weekend.shown(x, 4, 6)).toEqual([4, 6]);
    expect(weekend.shown(x, 1, 4)).toEqual([]);
    // Row subsets read x through their rows.
    expect(weekend.shown(x, 0, 3, Uint32Array.from([0, 4, 5]))).toEqual([0, 3]);
  });

  it("refuse rules they cannot read, with the rule's path", () => {
    const refuse = (rule: unknown) => () => timeBreaks([rule as TimeBreakSpec]);
    expect(refuse({ weekdays: ["saturday"] })).toThrow('breaks[0].weekdays[0]: expected "mon"');
    expect(refuse({ weekdays: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] })).toThrow(
      "leaves no time to show",
    );
    expect(refuse({ hours: ["25:00", "09:00"] })).toThrow(
      'breaks[0].hours[0]: expected a time of day, "HH:MM"',
    );
    expect(refuse({ hours: ["24:00", "09:00"] })).toThrow("breaks[0].hours[0]");
    expect(refuse({ hours: ["09:00", "09:00"] })).toThrow("leaves out no time, or every hour");
    expect(refuse({ hours: ["00:00", "24:00"] })).toThrow("leaves out every hour");
    expect(refuse({ dates: ["2025-02-30"] })).toThrow(
      'breaks[0].dates[0]: expected a date, "YYYY-MM-DD"',
    );
    expect(refuse({ from: 10, to: 10 })).toThrow(
      "breaks[0].to: expected a time after from, 10; received 10",
    );
    expect(refuse({ from: 0.5, to: 10 })).toThrow("whole epoch milliseconds");
    expect(refuse({ weekdays: ["sat"], hours: ["16:00", "09:30"] })).toThrow(
      "breaks[0]: expected one of weekdays, hours, dates, or from and to; received weekdays and hours",
    );
    expect(refuse("weekends")).toThrow("expected a break");
    // "24:00" ends a span at midnight.
    expect(calendar([{ hours: ["16:00", "24:00"] }]).hides(utc(2025, 1, 1, 23, 59))).toBe(true);
  });

  it("refuse spans too long to resolve", () => {
    const nights = calendar([{ hours: ["16:00", "09:30"] }]);
    expect(() => nights.cover(utc(1000, 1, 1), utc(3000, 1, 1))).toThrow(RangeError);
  });

  it("serialize as their rules", () => {
    const rules: TimeBreakSpec[] = [{ weekdays: ["sat", "sun"] }, { hours: ["16:00", "09:30"] }];
    const breaks = timeBreaks(rules);
    expect(JSON.parse(JSON.stringify({ x: { breaks } }))).toEqual({ x: { breaks: rules } });
    // Changing the array afterward does not change the breaks.
    rules.push({ dates: ["2025-12-25"] });
    expect(breaks.toJSON()).toHaveLength(2);
  });
});

describe("time scales with breaks", () => {
  const weekend = () => calendar([{ weekdays: ["sat", "sun"] }]);

  it("map time shown linearly and invert to the end of a break at its seam", () => {
    const breaks = weekend();
    const friday = utc(2025, 10, 10);
    const tuesday = utc(2025, 10, 14);
    const scale = breaks.scale([friday, tuesday], [0, 200]);
    // Friday, Monday, and Tuesday shown: 100 pixels a day.
    expect(scale.map(friday)).toBe(0);
    expect(scale.map(utc(2025, 10, 13))).toBe(100);
    expect(scale.map(utc(2025, 10, 12, 6))).toBe(100);
    expect(scale.map(tuesday)).toBe(200);
    expect(scale.invert(100)).toBe(utc(2025, 10, 13));
    expect(scale.invert(50)).toBe(utc(2025, 10, 10, 12));
    expect(scale.invert(150)).toBe(utc(2025, 10, 13, 12));
    expect(scale.mapping().breaks).toBe(breaks);
    // Reversed ranges keep the same seams.
    const reversed = breaks.scale([friday, tuesday], [200, 0]);
    expect(reversed.map(utc(2025, 10, 13))).toBe(100);
    expect(reversed.invert(100)).toBe(utc(2025, 10, 13));
  });

  const plan = (domain: [number, number], rules: TimeBreakSpec[], count: number, zone = "UTC") =>
    planAxis(
      {
        type: "time",
        spec: undefined,
        zone,
        locale: "en-US",
        breaks: timeBreaks(rules).calendar(zone),
      },
      domain,
      [0, 100 * count],
      count,
    );

  it("move ticks out of breaks to the session after, labeled by the day or month that begins", () => {
    // 2025-11-01 is a Saturday: its month tick moves to Monday and reads as the month.
    const months = plan([utc(2025, 9, 1), utc(2025, 12, 31)], [{ weekdays: ["sat", "sun"] }], 4);
    expect(months.labels).toEqual(["Sep", "Oct", "Nov", "Dec"]);
    expect(months.ticks[2]).toBe(utc(2025, 11, 3));
    // Overnight sessions: days start at the open, and no tick is in a break.
    const rules: TimeBreakSpec[] = [{ weekdays: ["sat", "sun"] }, { hours: ["16:00", "09:30"] }];
    const zone = "America/New_York";
    const week = plan([utc(2025, 3, 5, 14, 30), utc(2025, 3, 14, 20)], rules, 8, zone);
    const breaks = timeBreaks(rules).calendar(zone);
    for (const t of week.ticks) expect(breaks.hides(t)).toBe(false);
    expect(week.labels).toContain("Mar 10");
    const open = week.ticks[week.labels.indexOf("Mar 10")]!;
    // Monday's open, 09:30 EDT after the change of the weekend.
    expect(open).toBe(utc(2025, 3, 10, 13, 30));
  });

  it("keep ticks few for many short sessions and long closures", () => {
    // A minute a day for a year: day ticks would put one at every open.
    const minute = plan([utc(2025, 1, 1), utc(2026, 1, 1)], [{ hours: ["00:01", "24:00"] }], 8);
    expect(minute.ticks.length).toBeLessThanOrEqual(13);
    expect(minute.ticks.length).toBeGreaterThanOrEqual(2);
    // Ten years closed between two weeks shown: the closure is not walked hour by hour.
    const closed = plan(
      [utc(2010, 1, 4), utc(2020, 1, 10)],
      [{ from: utc(2010, 1, 8), to: utc(2020, 1, 6) }],
      8,
    );
    expect(closed.labels).toContain("2020");
    expect(closed.ticks.every((t) => t < utc(2010, 1, 8) || t >= utc(2020, 1, 6))).toBe(true);
  });

  it("label with the interval of their own ticks", () => {
    const breaks = weekend();
    const scale = breaks.scale([utc(2025, 10, 6), utc(2025, 10, 24)], [0, 600]) as CalendarScale;
    const ticks = scale.ticks(6);
    const labels = timeTickLabels(
      ticks,
      scale.interval(6),
      "UTC",
      "en-US",
      scale.tickContexts?.(ticks),
    );
    expect(labels.length).toBe(ticks.length);
    expect(scale.tickContexts?.([...ticks])).toBeUndefined();
  });
});
