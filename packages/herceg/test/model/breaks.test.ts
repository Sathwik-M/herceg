// Charts on time axes with breaks: domains, hidden data, extents, inspection,
// specs, and OHLC bars.
import { describe, expect, it } from "vitest";
import { time } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { area } from "../../src/marks/area.ts";
import { bar } from "../../src/marks/bar.ts";
import { candlestick } from "../../src/marks/candlestick.ts";
import { line } from "../../src/marks/line.ts";
import { point } from "../../src/marks/point.ts";
import { describeChart } from "../../src/model/describe.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { panels } from "../../src/model/panels.ts";
import { renderToSVG } from "../../src/render/static.ts";
import { timeBreaks } from "../../src/scale/breaks.ts";
import type {
  AreaGeometry,
  LineGeometry,
  RectGeometry,
  SegmentGeometry,
} from "../../src/scene/scene.ts";
import { loadSpec } from "../../src/spec/load.ts";
import type { ChartSpec } from "../../src/spec/spec.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const utc = (...parts: number[]) => Date.UTC(parts[0]!, parts[1]! - 1, ...parts.slice(2));

function build(config: ChartConfig, width = 600, height = 300) {
  const model = new ChartModel({ locale: "en-US", timeZone: "UTC", ...config });
  model.setSize(width, height, 1);
  return { model, scene: model.scene(estimateText) };
}

/** Weekdays from 2025-10-06 (a Monday), with prices rising a point a day. */
function weekdays(count: number, extra: number[] = []) {
  const days: number[] = [];
  for (let d = utc(2025, 10, 6); days.length < count; d += DAY) {
    const day = new Date(d).getUTCDay();
    if (day !== 0 && day !== 6) days.push(d);
  }
  const t = [...days, ...extra].sort((a, b) => a - b);
  const close = t.map((_, i) => 100 + i);
  return table({
    t: time(t),
    o: close.map((c) => c - 0.5),
    h: close.map((c) => c + 1),
    l: close.map((c) => c - 1),
    c: close,
  });
}

const fields = { x: "t", open: "o", high: "h", low: "l", close: "c" } as const;
const weekend = () => timeBreaks([{ weekdays: ["sat", "sun"] }]);

describe("charts with time axis breaks", () => {
  it("draw weekdays side by side, with half a slot of room at the ends", () => {
    const prices = weekdays(10);
    const { model } = build({ marks: [candlestick(prices, fields)], x: { breaks: weekend() } });
    const x = model.xScale()!;
    const days = Array.from(prices.numbers("t" as never));
    const gaps = days.slice(1).map((d, i) => x.map(d) - x.map(days[i]!));
    // Friday to Monday is a day apart like any other.
    for (const gap of gaps) expect(gap).toBeCloseTo(gaps[0]!, 6);
    // The room before Monday's candle is in the Friday before, not lost in the weekend.
    expect(x.map(days[0]!) - x.range[0]).toBeCloseTo(gaps[0]! / 2, 6);
    expect(x.domain[0]).toBe(utc(2025, 10, 3, 12));
    expect(x.range[1] - x.map(days[days.length - 1]!)).toBeCloseTo(gaps[0]! / 2, 6);
  });

  it("leave out data inside breaks, from drawing and from y", () => {
    // A Saturday row with an outlying price.
    const saturday = utc(2025, 10, 11, 12);
    const prices = weekdays(10, [saturday]);
    const rows = prices.numbers("t" as never);
    const at = Array.from(rows).indexOf(saturday);
    for (const [field, value] of [
      ["h", 500],
      ["c", 300],
      ["o", 300],
      ["l", 299],
    ] as const)
      prices.set(field, at, value);
    const { model, scene } = build({
      marks: [candlestick(prices, fields)],
      x: { breaks: weekend() },
    });
    const [, top] = model.yScale()!.domain;
    expect(top).toBeLessThan(200);
    const segments = scene.panels[0]!.marks.filter(
      (m) => m.kind === "segments",
    ) as SegmentGeometry[];
    // Ten rising candles, six segments each.
    expect(segments.reduce((sum, m) => sum + m.count, 0)).toBe(60);
    // The line through the closes joins Friday and Monday, skipping Saturday.
    const lines = build({ marks: [line(prices, { x: "t", y: "c" })], x: { breaks: weekend() } });
    const path = (lines.scene.panels[0]!.marks[0] as LineGeometry).path;
    expect(path.count).toBe(10);
    expect(path.starts).toEqual([0]);
    expect(lines.model.yScale()!.domain[1]).toBeLessThan(200);
  });

  it("fit y to a segment across a break as drawn, straight in time shown", () => {
    // Friday at 100, Monday at 200: halfway in time shown is noon-ish Friday + 12h of Monday.
    const data = table({ t: time([utc(2025, 10, 10), utc(2025, 10, 13)]), v: [100, 200] });
    const { model } = build({ marks: [line(data, { x: "t", y: "v" })], x: { breaks: weekend() } });
    // A view from Friday 18:00 to Monday 06:00: a quarter to three quarters of the segment.
    model.setViewport([utc(2025, 10, 10, 18), utc(2025, 10, 13, 6)]);
    model.scene(estimateText);
    const [lo, hi] = model.yScale()!.domain;
    expect(lo).toBeLessThanOrEqual(175);
    expect(lo).toBeGreaterThan(150);
    expect(hi).toBeGreaterThanOrEqual(225 - 25);
    expect(hi).toBeLessThan(250);
  });

  it("inspect the point nearest on screen, jumping over hidden rows", () => {
    // Hourly points around the clock: Friday's last shown hour, then 48 hidden
    // hours, then Monday.
    const t: number[] = [];
    for (let h = 0; h < 24 * 9; h++) t.push(utc(2025, 10, 6) + h * HOUR);
    const data = table({ t: time(t), v: t.map((_, i) => i) });
    const { model, scene } = build({
      marks: [line(data, { x: "t", y: "v" })],
      x: { breaks: weekend() },
    });
    const x = model.xScale()!;
    const { plot } = scene.panels[0]!;
    // A pointer just after the seam is nearest Monday 00:00 on screen.
    const seam = x.map(utc(2025, 10, 13));
    const hit = model.inspect(seam + 0.2, plot.y + 10)!;
    expect(hit.axis === "x" && hit.value).toBe(utc(2025, 10, 13));
    // Friday's last point is an hour of time shown before the seam.
    const hour = x.map(utc(2025, 10, 14, 1)) - x.map(utc(2025, 10, 14));
    const before = model.inspect(seam - 0.8 * hour, plot.y + 10)!;
    expect(before.axis === "x" && before.value).toBe(utc(2025, 10, 10, 23));
    // Hidden rows are never inspected, even more than a thousand in a row.
    const many: number[] = [];
    for (let m = 0; m < 5 * 1440; m++) many.push(utc(2025, 10, 10, 23) + m * 60_000);
    const minutes = table({ t: time(many), v: many.map(() => 1) });
    minutes.set("v", 1, Number.NaN);
    const chart = build({ marks: [line(minutes, { x: "t", y: "v" })], x: { breaks: weekend() } });
    const at = chart.model.xScale()!.map(utc(2025, 10, 11));
    const found = chart.model.inspect(at, chart.scene.panels[0]!.plot.y + 5)!;
    expect(found.axis === "x" && chart.model.xScale()!.breaks!.hides(found.value)).toBe(false);
  });

  it("refuse breaks on axes that are not time, and fixed domains inside a break", () => {
    const numbers = table({ x: [1, 2], y: [1, 2] });
    expect(() =>
      build({ marks: [line(numbers, { x: "x", y: "y" })], x: { breaks: weekend() } }),
    ).toThrow("Axis breaks need a time x axis, not a linear one");
    const prices = weekdays(5);
    expect(() =>
      build({
        marks: [candlestick(prices, fields)],
        x: { breaks: weekend(), domain: [utc(2025, 10, 11), utc(2025, 10, 12)] },
      }),
    ).toThrow("inside an axis break");
    // A view onto a weekend shows the hour either side of it.
    const { model } = build({ marks: [candlestick(prices, fields)], x: { breaks: weekend() } });
    model.setViewport([utc(2025, 10, 11, 1), utc(2025, 10, 12, 1)]);
    model.scene(estimateText);
    expect(model.xScale()!.domain).toEqual([utc(2025, 10, 10, 23), utc(2025, 10, 13, 1)]);
  });

  it("share their breaks across panels, and stream", () => {
    const prices = weekdays(10);
    const volume = bar(prices, { x: "t", y: "c", panel: "volume" });
    const config: ChartConfig = {
      marks: [candlestick(prices, { ...fields, panel: "price" }), volume],
      panels: panels([{ id: "price" }, { id: "volume" }]),
      x: { breaks: weekend() },
    };
    const { model } = build(config);
    const [price, below] = model.panels();
    expect(price!.x.map(utc(2025, 10, 13))).toBeCloseTo(below!.x.map(utc(2025, 10, 13)), 9);
    // Appending far ahead resolves more breaks; the days already drawn stay put.
    const before = price!.x.map(utc(2025, 10, 13)) - price!.x.map(utc(2025, 10, 10));
    prices.append({ t: [utc(2026, 3, 2)], o: [1], h: [2], l: [0], c: [1] } as never);
    model.scene(estimateText);
    const x = model.panels()[0]!.x;
    expect(x.domain[1]).toBeGreaterThan(utc(2026, 3, 2));
    const after = x.map(utc(2025, 10, 13)) - x.map(utc(2025, 10, 10));
    // A day shown in each, at the new scale.
    expect(after / (x.map(utc(2025, 10, 14)) - x.map(utc(2025, 10, 13)))).toBeCloseTo(1, 9);
    expect(before).toBeGreaterThan(after);
  });

  it("leave the time out of every time x scale of their own, not of number scales", () => {
    const prices = weekdays(10);
    const buckets = table({ ms: [1, 2, 3], count: [5, 6, 7] });
    const { model } = build({
      marks: [
        candlestick(prices, { ...fields, panel: "series" }),
        bar(buckets, { x: "ms", y: "count", panel: "spread" }),
      ],
      panels: panels([{ id: "series" }, { id: "spread" }]),
      resolve: { x: "independent" },
      x: { breaks: weekend() },
    });
    const [series, spread] = model.panels();
    expect(series!.x.breaks).toBeDefined();
    expect(spread!.x.breaks).toBeUndefined();
    const x = series!.x;
    expect(x.map(utc(2025, 10, 13)) - x.map(utc(2025, 10, 10))).toBeCloseTo(
      x.map(utc(2025, 10, 10)) - x.map(utc(2025, 10, 9)),
      6,
    );
  });

  it("place points on the CPU and leave out hidden ones", () => {
    const data = table({
      t: time([utc(2025, 10, 10), utc(2025, 10, 11), utc(2025, 10, 13)]),
      v: [1, 2, 3],
    });
    const { scene } = build({ marks: [point(data, { x: "t", y: "v" })], x: { breaks: weekend() } });
    const points = scene.panels[0]!.marks[0]!;
    expect((points as unknown as { count: number }).count).toBe(2);
  });
});

describe("lines and bands across breaks at the view's edges", () => {
  // Epoch milliseconds 0 to 10 with [3, 8) left out: 4, 5, and 6 are hidden.
  const gap = () => timeBreaks([{ from: 3, to: 8 }]);
  const linePoints = (config: ChartConfig) => {
    const { scene } = build(config);
    return (scene.panels[0]!.marks[0] as LineGeometry).path.count;
  };

  it("draw the segment between shown points when the view's neighbors are hidden", () => {
    const data = table({ t: time([0, 4, 5, 6, 10]), v: [0, 4, 5, 6, 10] });
    const view = (domain: [number, number], reversed = false) => {
      const { model, scene } = build({
        marks: [line(data, { x: "t", y: "v" })],
        x: { breaks: gap(), ...(reversed ? { domain: [10, 0] as [number, number] } : {}) },
      });
      model.setViewport(domain);
      return (
        (model.scene(estimateText).panels[0]!.marks[0] as LineGeometry).path.count + 0 * scene.width
      );
    };
    // Views inside the segment from 0 to 10, which passes the break.
    expect(view([5, 9])).toBe(2);
    expect(view([1, 2])).toBe(2);
    expect(view([5, 9], true)).toBe(2);
    // Rows of a series of a long-format table do too.
    const grouped = table({
      t: time([0, 0, 4, 5, 6, 10, 10]),
      v: [0, 1, 4, 5, 6, 10, 11],
      g: ["a", "b", "a", "a", "a", "a", "b"],
    });
    const { model } = build({
      marks: [line(grouped, { x: "t", y: "v", series: "g" })],
      x: { breaks: gap() },
    });
    model.setViewport([5, 9]);
    const counts = model
      .scene(estimateText)
      .panels[0]!.marks.map((m) => (m as LineGeometry).path.count);
    expect(counts).toEqual([2, 2]);
    // Monotone curves reach two shown points past each edge.
    const curved = table({ t: time([-5, 0, 4, 5, 6, 10, 15]), v: [1, 0, 4, 5, 6, 10, 2] });
    const chart = build({
      marks: [line(curved, { x: "t", y: "v", curve: "monotone" })],
      x: { breaks: gap() },
    });
    chart.model.setViewport([5, 9]);
    const path = (chart.model.scene(estimateText).panels[0]!.marks[0] as LineGeometry).path;
    expect(path.count).toBe(4);
    expect(linePoints({ marks: [line(curved, { x: "t", y: "v" })], x: { breaks: gap() } })).toBe(4);
  });

  it("keep bands whole across missing values inside breaks, but not outside them", () => {
    const band = (hi: number[], x = [0, 4, 10]) => {
      const data = table({ t: time(x), lo: [0, 0, 0], hi });
      const { scene } = build({
        marks: [area(data, { x: "t", y1: "lo", y2: "hi" })],
        x: { breaks: gap() },
      });
      return scene.panels[0]!.marks[0] as AreaGeometry;
    };
    const across = band([1, Number.NaN, 2]);
    expect(across.upper.starts).toEqual([0]);
    expect(across.upper.count).toBe(2);
    const outside = band([1, Number.NaN, 2], [0, 1, 10]);
    expect(outside.upper.starts.length).toBe(2);
  });

  it("leave hidden rows out of unsorted monotone bands", () => {
    const data = table({ t: time([0, 10, 4]), lo: [0, 0, 0], hi: [1, 2, 100] });
    const { scene, model } = build({
      marks: [area(data, { x: "t", y1: "lo", y2: "hi", curve: "monotone" })],
      x: { breaks: gap() },
    });
    const { upper } = scene.panels[0]!.marks[0] as AreaGeometry;
    expect(upper.count).toBe(2);
    const top = model.yScale()!.map(100);
    for (let i = 0; i < upper.count; i++) expect(upper.coords[i * 2 + 1]).not.toBeCloseTo(top, 0);
  });
});

describe("rules of breaks at their limits", () => {
  it("cap explicit spans as recurring ones are capped", () => {
    const many = Array.from({ length: 250_001 }, (_, i) => ({ from: i * 10, to: i * 10 + 5 }));
    expect(() => timeBreaks(many).calendar("UTC").cover(0, 2_500_010)).toThrow(RangeError);
  });

  it("read dates of the first century as written", () => {
    const early = timeBreaks([{ dates: ["0099-01-01"] }]).calendar("UTC");
    const jan1 = new Date(0);
    jan1.setUTCFullYear(99, 0, 1);
    expect(early.hides(jan1.getTime() + 3_600_000)).toBe(true);
    expect(early.hides(Date.UTC(1999, 0, 1, 1))).toBe(false);
  });

  it("find the nearest point without visiting every hidden row", () => {
    const t: number[] = [];
    // Friday's last minute, then 10,000 times in the weekend, then Monday.
    t.push(utc(2025, 10, 10, 23, 59));
    for (let m = 0; m < 10_000; m++) t.push(utc(2025, 10, 11) + m * 17_000);
    t.push(utc(2025, 10, 13), utc(2025, 10, 13, 0, 1));
    const data = table({ t: time(t), v: t.map((_, i) => i % 7) });
    const breaks = weekend();
    const { model, scene } = build({
      tooltip: { mode: "nearest" },
      marks: [line(data, { x: "t", y: "v" })],
      x: { breaks },
    });
    const calendar = breaks.calendar("UTC");
    let calls = 0;
    const collapse = calendar.collapse.bind(calendar);
    calendar.collapse = (value: number) => {
      calls++;
      return collapse(value);
    };
    const x = model.xScale()!;
    const hit = model.inspect(x.map(utc(2025, 10, 13)), scene.panels[0]!.plot.y + 5)!;
    expect(hit).toBeDefined();
    expect(calls).toBeLessThan(500);
  });
});

describe("breaks with more than one x scale, and nearest points", () => {
  it("load breaks for a panel's own time axis among number axes", () => {
    const { config } = loadSpec({
      version: 3,
      data: {
        prices: {
          columns: { t: { type: "time", values: ["2025-10-10", "2025-10-13"] }, v: [1, 2] },
        },
        buckets: { columns: { ms: [1, 2], n: [3, 4] } },
      },
      marks: [
        { type: "line", data: "prices", x: "t", y: "v", panel: "series" },
        { type: "line", data: "buckets", x: "ms", y: "n", panel: "spread" },
      ],
      panels: [{ id: "series", x: { type: "time" } }, { id: "spread" }],
      resolve: { x: "independent" },
      x: { type: "linear", breaks: [{ weekdays: ["sat", "sun"] }] },
      timeZone: "UTC",
    });
    const { model } = build(config);
    const [series, spread] = model.panels();
    expect(series!.x.breaks).toBeDefined();
    expect(spread!.x.breaks).toBeUndefined();
  });

  it("find the nearest point on screen, whichever side of the pointer's time it is", () => {
    const near = table({ t: time([80]), v: [0] });
    const far = table({ t: time([0, 100]), v: [0, 0] });
    const { model, scene } = build({
      tooltip: { mode: "nearest" },
      marks: [line(near, { x: "t", y: "v" }), line(far, { x: "t", y: "v" })],
      x: { breaks: timeBreaks([{ from: 1, to: 49 }]), domain: [0, 100] },
      y: { domain: [-1, 1] },
    });
    const x = model.xScale()!;
    const y = model.yScale()!;
    // 60 is 12 of time shown from 0 and 20 from 80.
    const hit = model.inspect(x.map(60), y.map(0))!;
    expect(hit.axis === "x" && hit.value).toBe(0);
    expect(scene.panels).toHaveLength(1);
  });

  it("resolve calendar dates of the first century in named zones", () => {
    const noon = new Date(0);
    noon.setUTCFullYear(99, 0, 1);
    noon.setUTCHours(12);
    for (const zone of ["UTC", "Etc/UTC", "Europe/London", "America/New_York"]) {
      const early = timeBreaks([{ dates: ["0099-01-01"] }]).calendar(zone);
      expect(early.hides(noon.getTime())).toBe(true);
    }
  });
});

describe("specs with time axis breaks", () => {
  const spec = (version: 2 | 3, x: NonNullable<ChartSpec["x"]>): ChartSpec => ({
    version,
    data: {
      p: { columns: { t: { type: "time", values: ["2025-10-10", "2025-10-13"] }, v: [1, 2] } },
    },
    marks: [{ type: "line", x: "t", y: "v" }],
    x,
    timeZone: "UTC",
  });

  it("load breaks in version 3 and draw them", () => {
    const { config } = loadSpec(spec(3, { breaks: [{ weekdays: ["sat", "sun"] }] }));
    expect(JSON.parse(JSON.stringify(config.x))).toEqual({
      breaks: [{ weekdays: ["sat", "sun"] }],
    });
    const { model } = build(config);
    const x = model.xScale()!;
    expect(x.map(utc(2025, 10, 13)) - x.map(utc(2025, 10, 10))).toBeCloseTo(
      x.range[1] - x.range[0],
      6,
    );
    const svg = renderToSVG({ ...config, width: 400, height: 200 });
    expect(svg).toContain("<svg");
  });

  it("refuse breaks that older readers would ignore, on y, or that they cannot read", () => {
    expect(() => loadSpec(spec(2, { breaks: [{ weekdays: ["sat"] }] }))).toThrow(
      'spec.x.breaks: expected a spec with "version": 3',
    );
    expect(() => loadSpec({ ...spec(3, {}), y: { breaks: [] } as never })).toThrow(
      "spec.y.breaks: expected breaks on the chart's x axis only",
    );
    // Breaks on a number axis load, and the chart refuses them.
    const numbers = loadSpec(spec(3, { type: "linear", breaks: [{ weekdays: ["sat"] }] }));
    expect(() => build(numbers.config)).toThrow("Axis breaks need a time x axis");
    expect(() => loadSpec(spec(3, { breaks: [{ hours: ["9:30"] }] as never }))).toThrow(
      "spec.x.breaks[0].hours",
    );
  });
});

describe("OHLC bars", () => {
  const prices = table({
    t: [0, 1, 2],
    o: [10, 12, 9],
    h: [13, 12.5, 9.5],
    l: [9, 8, 8.5],
    c: [12, 9, 9],
  });

  it("draw a line from low to high with the open left and the close right, by direction", () => {
    const { scene, model } = build({
      marks: [candlestick(prices, { ...fields, variant: "ohlc" })],
    });
    const marks = scene.panels[0]!.marks;
    const rising = marks.find((m) => m.key.endsWith("|rise")) as SegmentGeometry;
    const falling = marks.find((m) => m.key.endsWith("|fall")) as SegmentGeometry;
    expect(marks.find((m) => m.key.endsWith("|body")) as RectGeometry | undefined).toBeUndefined();
    // Days 0 and 2 rise (a close at the open counts); day 1 falls.
    expect([rising.count, falling.count]).toEqual([6, 3]);
    const x = model.xScale()!;
    const y = model.yScale()!;
    const [stem, open, close] = [0, 1, 2].map((i) =>
      Array.from(falling.coords.subarray(i * 4, i * 4 + 4)),
    );
    expect(stem![0]).toBeCloseTo(x.map(1), 3);
    expect(stem![1]).toBeCloseTo(y.map(12.5), 3);
    expect(stem![3]).toBeCloseTo(y.map(8), 3);
    // The open ticks left of the stem, the close right.
    expect(open![0]).toBeLessThan(x.map(1));
    expect(open![2]).toBeCloseTo(x.map(1), 3);
    expect(open![1]).toBeCloseTo(y.map(12), 3);
    expect(close![0]).toBeCloseTo(x.map(1), 3);
    expect(close![2]).toBeGreaterThan(x.map(1));
    expect(close![3]).toBeCloseTo(y.map(9), 3);
    expect(describeChart(model)).toContain("3 OHLC bars");
  });

  it("load from specs", () => {
    const { config } = loadSpec({
      data: { p: { columns: { t: [0, 1], o: [1, 2], h: [3, 3], l: [0, 1], c: [2, 1] } } },
      marks: [{ type: "candlestick", ...fields, variant: "ohlc" }],
    });
    const { scene } = build(config);
    expect(scene.panels[0]!.marks.some((m) => m.key.endsWith("|body"))).toBe(false);
    expect(() =>
      loadSpec({
        data: { p: { columns: { t: [0], o: [1], h: [1], l: [1], c: [1] } } },
        marks: [{ type: "candlestick", ...fields, variant: "bars" as never }],
      }),
    ).toThrow('marks[0].variant: expected "candlestick" or "ohlc"');
  });
});
