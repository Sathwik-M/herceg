// Calendar heatmaps: the days of a time field by week and weekday, or by
// month and day of the month, in the chart's time zone.
import { describe, expect, it } from "vitest";
import { time } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { heatmap } from "../../src/marks/heatmap.ts";
import { placeCalendar } from "../../src/marks/heatmap-calendar.ts";
import { rowOf } from "../../src/marks/series.ts";
import { describeChart } from "../../src/model/describe.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { timeBreaks } from "../../src/scale/breaks.ts";
import type { RasterGeometry } from "../../src/scene/scene.ts";
import { loadSpec } from "../../src/spec/load.ts";
import type { ChartSpec } from "../../src/spec/spec.ts";
import { validateSpec } from "../../src/spec/validate.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function build(config: ChartConfig, width = 600, height = 300) {
  const model = new ChartModel({ locale: "en-US", timeZone: "UTC", legend: false, ...config });
  model.setSize(width, height, 1);
  return { model, scene: model.scene(estimateText) };
}

/** Days from `first` (a UTC date), `count` of them, skipping `missing` (offsets), valued by offset. */
function days(first: number, count: number, missing: number[] = []) {
  const offsets = [...Array(count).keys()].filter((d) => !missing.includes(d));
  return table({ day: time(offsets.map((d) => first + d * DAY)), n: offsets });
}

/** The value of the cell under a pixel, if any. */
function valueAt(model: ChartModel, px: number, py: number) {
  return model.inspect(px, py)?.points[0]?.value;
}

const categories = (model: ChartModel) => model.yScale()!.categories;

describe("calendar heatmaps by week", () => {
  // Thursday, January 1, 2026, to Wednesday the 14th.
  const january = Date.UTC(2026, 0, 1);

  it("put each week in a column along time and each weekday in a row, Monday first", () => {
    const { model, scene } = build({
      marks: [heatmap(days(january, 14, [6]), { date: "day", color: "n" })],
    });
    expect(model.xScale()!.type).toBe("time");
    // Whole weeks from Monday, December 29, to Sunday, January 18.
    expect(model.xScale()!.domain).toEqual([Date.UTC(2025, 11, 29), Date.UTC(2026, 0, 19)]);
    expect(categories(model)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    const raster = scene.panels[0]!.marks[0] as RasterGeometry;
    // UTC weeks are a lattice: a pixel per week and weekday.
    expect([raster.columns, raster.rows]).toEqual([3, 7]);
    const x = model.xScale()!;
    const y = model.yScale()!;
    const at = (offset: number, weekday: number) =>
      valueAt(model, x.map(january + offset * DAY + 12 * HOUR), y.map(weekday));
    // January 1 is a Thursday, January 12 a Monday; the 7th has no row.
    expect(at(0, 3)).toBe(0);
    expect(at(11, 0)).toBe(11);
    expect(at(6, 2)).toBeUndefined();
    // Days before the first and after the last are empty.
    expect(valueAt(model, x.map(Date.UTC(2025, 11, 29, 12)), y.map(0))).toBeUndefined();
    const inspection = model.inspect(x.map(january + 12 * HOUR), y.map(3))!;
    expect(inspection.points[0]!.label).toBe("Thu");
    expect(describeChart(model)).toContain("n: 13 cells in 3 columns and 7 rows");
  });

  it("start weeks on the day asked for", () => {
    const { model } = build({
      marks: [heatmap(days(january, 14), { date: "day", color: "n", weekStart: "sun" })],
    });
    expect(categories(model)).toEqual(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
    expect(model.xScale()!.domain).toEqual([Date.UTC(2025, 11, 28), Date.UTC(2026, 0, 18)]);
  });

  it("follow the zone's midnights across a clock change", () => {
    // New York's clocks spring forward on Sunday, March 8, 2026.
    const midnights = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) =>
      d < 7 ? Date.UTC(2026, 2, 2 + d, 5) : Date.UTC(2026, 2, 2 + d, 4),
    );
    const placed = placeCalendar(
      Float64Array.from(midnights),
      "weeks",
      "mon",
      "America/New_York",
      "en-US",
    );
    const weeks = placed.weeks!;
    expect(weeks.lattice).toBeUndefined();
    // Monday the 2nd to Monday the 9th is an hour short of a week.
    expect([weeks.lower[0], weeks.upper[0], weeks.upper[1]]).toEqual([
      Date.UTC(2026, 2, 2, 5),
      Date.UTC(2026, 2, 9, 4),
      Date.UTC(2026, 2, 16, 4),
    ]);
    expect(Array.from(placed.rows.y)).toEqual([0, 1, 2, 3, 4, 5, 6, 0, 1, 2]);
    const data = table({ day: time(midnights), n: midnights.map((_, i) => i) });
    const { model } = build({
      timeZone: "America/New_York",
      marks: [heatmap(data, { date: "day", color: "n" })],
    });
    const x = model.xScale()!;
    const y = model.yScale()!;
    for (const [i, t] of midnights.entries())
      expect(valueAt(model, x.map(t + 12 * HOUR), y.map(i % 7))).toBe(i);
  });

  it("end every week at the zone's next week start, the last one too", () => {
    const weeks = (day: number) =>
      placeCalendar(Float64Array.from([day]), "weeks", "mon", "America/New_York", "en-US").weeks!;
    // Monday, March 2, 2026: the week's clocks spring forward on the 8th.
    const spring = weeks(Date.UTC(2026, 2, 2, 17));
    expect([spring.lower[0], spring.upper[0]]).toEqual([
      Date.UTC(2026, 2, 2, 5),
      Date.UTC(2026, 2, 9, 4),
    ]);
    expect(spring.lattice).toBeUndefined();
    // Tuesday, October 27: the week's clocks fall back on November 1.
    const autumn = weeks(Date.UTC(2026, 9, 27, 17));
    expect([autumn.lower[0], autumn.upper[0]]).toEqual([
      Date.UTC(2026, 9, 26, 4),
      Date.UTC(2026, 10, 2, 5),
    ]);
    // A week without a clock change is a lattice of one.
    expect(weeks(Date.UTC(2026, 0, 6, 17)).lattice).toBeDefined();
  });

  it("place each chart's days in its own zone when charts share the mark", () => {
    // 02:00 UTC on Monday the 5th and Tuesday the 6th: Sunday and Monday evenings in New York.
    const data = table({
      day: time([Date.UTC(2026, 0, 5, 2), Date.UTC(2026, 0, 6, 2)]),
      n: [1, 2],
    });
    const mark = heatmap(data, { date: "day", color: "n" });
    const utc = build({ marks: [mark] }).model;
    const before = describeChart(utc);
    build({ timeZone: "America/New_York", marks: [mark] });
    const x = utc.xScale()!;
    expect(valueAt(utc, x.map(Date.UTC(2026, 0, 5, 12)), utc.yScale()!.map(0))).toBe(1);
    expect(describeChart(utc)).toBe(before);
    expect(before).toContain("2 cells in 1 column");
  });

  it("place a leap day and show the last of the rows sharing a day", () => {
    const leap = Date.UTC(2024, 1, 29);
    const data = table({
      day: time([leap, leap + 3 * HOUR, leap + 6 * HOUR]),
      n: [1, 2, Number.NaN],
    });
    const { model } = build({ marks: [heatmap(data, { date: "day", color: "n" })] });
    // February 29, 2024 was a Thursday.
    const x = model.xScale()!;
    expect(valueAt(model, x.map(leap + 12 * HOUR), model.yScale()!.map(3))).toBe(2);
  });

  it("zoom along the weeks, and step week by week and day by day", () => {
    const { model } = build({
      interaction: { zoom: "x" },
      marks: [heatmap(days(january, 14), { date: "day", color: "n" })],
    });
    model.setViewport([Date.UTC(2026, 0, 5), Date.UTC(2026, 0, 12)]);
    model.scene(estimateText);
    expect(model.xScale()!.domain).toEqual([Date.UTC(2026, 0, 5), Date.UTC(2026, 0, 12)]);
    const series = model.panelSeries("")[0]!;
    const value = (position: number | undefined) => series.values[rowOf(series, position!)];
    const step = (position: number, columns: number, rows: number) =>
      model.stepCell("", series.key, position, columns, rows);
    // The top left cell: Monday of the first week holding a day, the 5th.
    const first = step(-1, 0, 0)!;
    expect(value(first)).toBe(4);
    expect(value(step(first, 1, 0))).toBe(11);
    // Rows of weekdays run down.
    expect(value(step(first, 0, -1))).toBe(5);
  });

  it("refuse time breaks", () => {
    expect(() =>
      build({
        x: { breaks: timeBreaks([{ weekdays: ["sat", "sun"] }]) },
        marks: [heatmap(days(january, 14), { date: "day", color: "n" })],
      }),
    ).toThrow("heatmap date: calendars cannot leave out time breaks");
  });
});

describe("calendar heatmaps by month", () => {
  it("put each month in a row and each day of the month in a column", () => {
    // January 30 to March 2, 2024, without February 10; then June 1.
    const first = Date.UTC(2024, 0, 30);
    const data = days(first, 33, [11]);
    data.append({ day: [Date.UTC(2024, 5, 1)], n: [99] });
    const { model, scene } = build({
      marks: [heatmap(data, { date: "day", color: "n", calendar: "months" })],
    });
    expect(model.xScale()!.categories).toEqual(Array.from({ length: 31 }, (_, d) => String(d + 1)));
    // Every month from the first day's to the last's, in order down the plot.
    expect(categories(model)).toEqual([
      "Jan 2024",
      "Feb 2024",
      "Mar 2024",
      "Apr 2024",
      "May 2024",
      "Jun 2024",
    ]);
    const raster = scene.panels[0]!.marks[0] as RasterGeometry;
    expect([raster.columns, raster.rows]).toEqual([31, 6]);
    const x = model.xScale()!;
    const y = model.yScale()!;
    const at = (day: number, month: number) => valueAt(model, x.map(day - 1), y.map(month));
    expect(at(30, 0)).toBe(0);
    // The leap day, the missing 10th, and dates February does not have.
    expect(at(29, 1)).toBe(30);
    expect(at(10, 1)).toBeUndefined();
    expect(at(30, 1)).toBeUndefined();
    expect(at(1, 5)).toBe(99);
    expect(at(1, 4)).toBeUndefined();
  });

  it("label Gregorian months and days in any locale", () => {
    const placed = placeCalendar(
      Float64Array.from([Date.UTC(2026, 0, 1)]),
      "months",
      "mon",
      "UTC",
      "fa-IR",
    );
    const gregorian = (options: Intl.DateTimeFormatOptions, at: number) =>
      new Intl.DateTimeFormat("fa-IR", { ...options, calendar: "gregory", timeZone: "UTC" }).format(
        at,
      );
    expect(placed.bands.y.labels).toEqual([
      gregorian({ year: "numeric", month: "short" }, Date.UTC(2026, 0, 1)),
    ]);
    expect(placed.bands.x!.labels[11]).toBe(gregorian({ day: "numeric" }, Date.UTC(2026, 0, 12)));
  });

  it("count months of early and negative years", () => {
    const at = (year: number, month: number) => {
      const date = new Date(0);
      date.setUTCFullYear(year, month, 15);
      return date.getTime();
    };
    const early = placeCalendar(
      Float64Array.from([at(99, 11), at(100, 0)]),
      "months",
      "mon",
      "UTC",
      "en-US",
    );
    expect(early.bands.y.labels).toEqual(["Dec 99", "Jan 100"]);
    const negative = placeCalendar(Float64Array.from([at(-1, 5)]), "months", "mon", "UTC", "en-US");
    expect(negative.bands.y.keys).toHaveLength(1);
    expect(Array.from(negative.rows.y)).toEqual([0]);
  });

  it("place days in the chart's zone", () => {
    // 03:00 UTC on March 1 is still February 28 in New York.
    const data = table({ day: time([Date.UTC(2026, 2, 1, 3)]), n: [5] });
    const { model } = build({
      timeZone: "America/New_York",
      marks: [heatmap(data, { date: "day", color: "n", calendar: "months" })],
    });
    expect(categories(model)).toEqual(["Feb 2026"]);
    expect(valueAt(model, model.xScale()!.map(27), model.yScale()!.map(0))).toBe(5);
  });
});

describe("calendar heatmap specs", () => {
  const data = {
    t: { columns: { day: { type: "time", values: ["2026-01-01", "2026-01-02"] }, n: [1, 2] } },
  };
  const spec = (mark: object): ChartSpec =>
    ({ data, marks: [{ type: "heatmap", color: "n", ...mark }] }) as unknown as ChartSpec;

  it("load from specs", () => {
    const { config } = loadSpec(spec({ date: "day", calendar: "months", weekStart: undefined }));
    const { model } = build(config);
    expect(model.yScale()!.categories).toEqual(["Jan 2026"]);
  });

  it("take a date or x and y, not both", () => {
    expect(() => validateSpec(spec({ date: "day", x: "day" }))).toThrow(
      "heatmap x: a calendar places its date itself; drop x",
    );
    expect(() => validateSpec(spec({ x: "day" }))).toThrow(
      "heatmap: needs x and y, or a date to lay out as a calendar",
    );
    expect(() => validateSpec(spec({ x: "day", y: "n", calendar: "weeks" }))).toThrow(
      "heatmap: calendar and weekStart are for heatmaps of a date",
    );
    expect(() => validateSpec(spec({ date: "day", calendar: "months", weekStart: "sun" }))).toThrow(
      "heatmap weekStart: for calendars of weeks",
    );
    expect(() => validateSpec(spec({ date: "day", calendar: "years" }))).toThrow(/calendar/);
    const numbers = table({ day: [1, 2], n: [1, 2], name: ["a", "b"] });
    expect(() => heatmap(numbers, { date: "day" as never, color: "n" })).toThrow(
      'heatmap date: field "day" holds number values; expected time; give Dates or time() values',
    );
    expect(() => heatmap(numbers, { date: "name" as never, color: "n" })).toThrow(
      'heatmap date: field "name" holds category values; expected time; give Dates or time() values',
    );
  });
});
