// Candlesticks: open-high-low-close candles, hollow when they rise.
import { describe, expect, it } from "vitest";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { candlestick } from "../../src/marks/candlestick.ts";
import { describeChart } from "../../src/model/describe.ts";
import { facet } from "../../src/model/facet.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { renderToSVG } from "../../src/render/static.ts";
import type { Panel, RectGeometry, SegmentGeometry } from "../../src/scene/scene.ts";
import { loadSpec } from "../../src/spec/load.ts";
import { LIGHT } from "../../src/theme.ts";

function build(config: ChartConfig, width = 600, height = 300) {
  const model = new ChartModel({ locale: "en-US", timeZone: "UTC", ...config });
  model.setSize(width, height, 1);
  return { model, scene: model.scene(estimateText) };
}

const parts = (panel: Panel) => ({
  rising: panel.marks.find((m) => m.key.endsWith("|rise")) as SegmentGeometry,
  falling: panel.marks.find((m) => m.key.endsWith("|fall")) as SegmentGeometry,
  bodies: panel.marks.find((m) => m.key.endsWith("|body")) as RectGeometry,
});

// Day 0 rises from 10 to 12, day 1 falls from 12 to 9, day 2 closes where it opened.
const prices = table({
  t: [0, 1, 2],
  o: [10, 12, 9],
  h: [13, 12.5, 9.5],
  l: [9, 8, 8.5],
  c: [12, 9, 9],
});
const ohlc = { x: "t", open: "o", high: "h", low: "l", close: "c" } as const;

describe("candlesticks", () => {
  it("draw rising candles hollow and falling ones filled, with wicks to high and low", () => {
    const { scene, model } = build({ marks: [candlestick(prices, ohlc)] });
    const { rising, falling, bodies } = parts(scene.panels[0]!);
    // Days 0 and 2 rise (a close at the open counts): four sides and two wicks each.
    expect(rising.count).toBe(12);
    expect(rising.stroke).toBe(LIGHT.rise);
    // Day 1 falls: one wick and one body.
    expect([falling.count, bodies.count]).toEqual([1, 1]);
    const y = model.yScale()!;
    const x = model.xScale()!;
    // Day 1's wick runs from its high to its low through its center.
    const wick = Array.from(falling.coords.subarray(0, 4));
    expect(wick[0]).toBeCloseTo(x.map(1), 3);
    expect(wick[1]).toBeCloseTo(y.map(12.5), 3);
    expect(wick[3]).toBeCloseTo(y.map(8), 3);
    expect(bodies.fill).toBe(LIGHT.fall);
    expect(bodies.rects[1]).toBeCloseTo(y.map(12), 3);
    expect(bodies.rects[3]).toBeCloseTo(y.map(9) - y.map(12), 3);
  });

  it("count every candle's low and high toward y, and leave half a slot at the x ends", () => {
    const { model } = build({ marks: [candlestick(prices, ohlc)] });
    const [y0, y1] = model.yScale()!.domain;
    expect(y0).toBeLessThanOrEqual(8);
    expect(y1).toBeGreaterThanOrEqual(13);
    const [x0, x1] = model.xScale()!.domain;
    expect(x0).toBeLessThanOrEqual(-0.5);
    expect(x1).toBeGreaterThanOrEqual(2.5);
  });

  it("report open, high, low, and close in tooltips", () => {
    const { scene, model } = build({ marks: [candlestick(prices, ohlc)] });
    const hit = model.inspect(model.xScale()!.map(1), scene.panels[0]!.plot.y + 10)!;
    expect(hit.points[0]!.text).toBe("open 12, high 12.5, low 8, close 9");
  });

  it("merge the candles of each pixel column when more are in view than pixels", () => {
    const n = 5000;
    const dense = table({
      t: Float64Array.from({ length: n }, (_, i) => i),
      o: Float64Array.from({ length: n }, (_, i) => 100 + Math.sin(i / 50) * 10),
      h: Float64Array.from({ length: n }, (_, i) => 112 + Math.sin(i / 50) * 10),
      l: Float64Array.from({ length: n }, (_, i) => 88 + Math.sin(i / 50) * 10),
      c: Float64Array.from({ length: n }, (_, i) => 100 + Math.sin((i + 1) / 50) * 10),
    });
    const { scene, model } = build({ marks: [candlestick(dense, ohlc)] });
    const panel = scene.panels[0]!;
    const { rising, falling } = parts(panel);
    const candles = rising.count / 6 + falling.count;
    expect(candles).toBeLessThanOrEqual(Math.ceil(panel.plot.width) + 1);
    expect(candles).toBeGreaterThan(panel.plot.width / 2);
    // Merged candles keep the extremes: the highest wick reaches the highest price.
    let top = Infinity;
    for (const segments of [rising, falling]) {
      for (let i = 0; i < segments.count * 4; i += 2) top = Math.min(top, segments.coords[i + 1]!);
    }
    expect(top).toBeCloseTo(model.yScale()!.map(Math.max(...dense.numbers("h"))), 1);
  });

  it("stand in bands on a category x, with colors from options", () => {
    const named = table({ d: ["Mon", "Tue"], o: [1, 3], h: [4, 4], l: [0, 1], c: [3, 2] });
    const { scene, model } = build({
      marks: [candlestick(named, { ...ohlc, x: "d", rise: "#000000", fall: "#ffffff" })],
    });
    const { rising, bodies } = parts(scene.panels[0]!);
    expect(model.xScale()!.type).toBe("band");
    expect(rising.stroke).toBe("#000000");
    expect(bodies.fill).toBe("#ffffff");
    const x = model.xScale()!;
    expect(bodies.rects[2]).toBeCloseTo(Math.abs(x.bandwidth!), 3);
  });

  it("split into panels, load from specs, and draw in static SVG", () => {
    const two = table({
      t: [0, 1, 0, 1],
      o: [1, 2, 3, 4],
      h: [2, 3, 4, 5],
      l: [0, 1, 2, 3],
      c: [2, 1, 4, 3],
      s: ["a", "a", "b", "b"],
    });
    const { scene } = build({ marks: [candlestick(two, ohlc)], facet: facet("s") });
    expect(scene.panels.map((p) => parts(p).bodies.count)).toEqual([1, 1]);
    const { config } = loadSpec({
      data: { p: { columns: { t: [0], o: [1], h: [2], l: [0], c: [2] } } },
      marks: [{ type: "candlestick", x: "t", open: "o", high: "h", low: "l", close: "c" }],
    });
    expect(config.marks[0]!.spec.type).toBe("candlestick");
    expect(() =>
      loadSpec({
        data: { p: { columns: { t: [0], o: [1] } } },
        marks: [{ type: "candlestick", x: "t", open: "o" } as never],
      }),
    ).toThrow(/marks\[0\]\.high/);
    const svg = renderToSVG({ width: 300, height: 150, marks: [candlestick(prices, ohlc)] });
    expect(svg).toContain(`fill="${LIGHT.fall}"`);
    expect(svg).toContain(`stroke="${LIGHT.rise}"`);
  });

  it("merge unsorted candles by column, opening with the earliest and closing with the latest", () => {
    // 2,000 rows at two x values, interleaved: one merged candle each.
    const n = 2000;
    const at = (i: number) => (i % 2 === 0 ? 0 : 1);
    const mixed = table({
      t: Float64Array.from({ length: n }, (_, i) => at(i)),
      o: Float64Array.from({ length: n }, (_, i) => 50 + (i % 7)),
      h: Float64Array.from({ length: n }, (_, i) => (i === 10 ? 90 : 60)),
      l: Float64Array.from({ length: n }, (_, i) => (i === 20 ? 10 : 40)),
      c: Float64Array.from({ length: n }, (_, i) => 50 - (i % 5)),
    });
    const { scene, model } = build({ marks: [candlestick(mixed, ohlc)] });
    const { rising, falling, bodies } = parts(scene.panels[0]!);
    expect(rising.count / 6 + falling.count).toBe(2);
    // x = 0: rows 0, 2, ..., 1998. Open of row 0 (50), close of row 1998
    // (50 - 1998 % 5 = 47): it falls, with the high of row 10 and the low of row 20.
    const y = model.yScale()!;
    expect(bodies.count).toBe(2);
    expect(bodies.rects[1]).toBeCloseTo(y.map(50), 3);
    expect(bodies.rects[1]! + bodies.rects[3]!).toBeCloseTo(y.map(47), 3);
    const wick = Array.from(falling.coords.subarray(0, 4));
    expect(wick[1]).toBeCloseTo(y.map(90), 3);
    expect(wick[3]).toBeCloseTo(y.map(10), 3);
  });

  it("leave out candles with a missing or unplaceable price, without dropping their neighbors", () => {
    const n = 2000;
    const prices2 = table({
      t: Float64Array.from({ length: n }, (_, i) => i),
      o: Float64Array.from({ length: n }, (_, i) => (i === 5 ? Number.NaN : 10)),
      h: Float64Array.from({ length: n }, () => 12),
      // A zero low cannot go on a log axis.
      l: Float64Array.from({ length: n }, (_, i) => (i === 500 ? 0 : 9)),
      c: Float64Array.from({ length: n }, () => 11),
    });
    const { scene, model } = build({ marks: [candlestick(prices2, ohlc)], y: { type: "log" } });
    const { rising } = parts(scene.panels[0]!);
    // Every column still draws, including the ones holding rows 5 and 500.
    expect(rising.count / 6).toBeGreaterThan(scene.panels[0]!.plot.width - 2);
    expect(model.yScale()!.domain[0]).toBeGreaterThan(0);
    // Tooltips skip the row without an open, to the nearest candle drawn.
    const small = table({ t: [0, 1], o: [Number.NaN, 2], h: [3, 3], l: [0, 1], c: [1, 2] });
    const shown = build({ marks: [candlestick(small, ohlc)] });
    for (const mode of ["nearest-x", "nearest"] as const) {
      const px = shown.model.xScale()!.map(0);
      const hit = shown.model.inspect(px, shown.scene.panels[0]!.plot.y + 5, mode)!;
      expect(hit.points.map((p) => p.text)).toEqual(["open 2, high 3, low 1, close 2"]);
    }
  });

  it("widen high and low to cover open and close, in drawing and extents", () => {
    const odd = table({ t: [0], o: [100], h: [13], l: [9], c: [12] });
    const { model } = build({ marks: [candlestick(odd, ohlc)] });
    expect(model.yScale()!.domain[1]).toBeGreaterThanOrEqual(100);
  });

  it("fit y to the candles centered in view when zoomed", () => {
    const spiky = table({
      t: [0, 1, 2],
      o: [10, 10, 10],
      h: [10000, 13, 13],
      l: [9, 9, 9],
      c: [11, 11, 11],
    });
    const { model } = build({ marks: [candlestick(spiky, ohlc)] });
    model.setViewport([0.9, 1.1]);
    model.scene(estimateText);
    expect(model.yScale()!.domain[1]).toBeLessThan(100);
  });

  it("keep merged candles inside the plot, in buffers bounded by its width", () => {
    const n = 100_000;
    const many = table({
      t: Float64Array.from({ length: n }, (_, i) => i / (n - 1)),
      o: new Float64Array(n).fill(2),
      h: new Float64Array(n).fill(3),
      l: new Float64Array(n).fill(0),
      c: new Float64Array(n).fill(1),
    });
    const { scene } = build({ marks: [candlestick(many, ohlc)], x: { domain: [0, 1] } });
    const panel = scene.panels[0]!;
    const { bodies, rising } = parts(panel);
    const right = panel.plot.x + panel.plot.width;
    for (let i = 0; i < bodies.count; i++) {
      expect(bodies.rects[i * 4]! + bodies.rects[i * 4 + 2]!).toBeLessThanOrEqual(right);
    }
    const columns = Math.ceil(panel.plot.width);
    expect(bodies.count).toBe(columns);
    expect(bodies.rects.length).toBeLessThanOrEqual(columns * 4 * 1.5 + 16);
    expect(rising.coords.length).toBeLessThanOrEqual(columns * 24 * 1.5 + 16);
  });

  it("draw near-dojis as lines and follow table changes", () => {
    const live = table({ t: [0, 1], o: [10, 10], h: [11, 11], l: [9, 9], c: [10, 9.999] });
    const { scene, model } = build({ marks: [candlestick(live, ohlc)] });
    const { rising, bodies } = parts(scene.panels[0]!);
    // An unchanged price rises with a flat body; a tiny fall is a 1 px body.
    expect(rising.coords[1]).toBeCloseTo(rising.coords[5]!, 3);
    expect(bodies.rects[3]).toBe(1);
    live.append({ t: [2], o: [10], h: [20], l: [5], c: [15] });
    const next = parts(model.scene(estimateText).panels[0]!);
    expect(next.rising.count).toBe(12);
    expect(model.yScale()!.domain[1]).toBeGreaterThanOrEqual(20);
  });

  it("describe candles, their range, and the latest one", () => {
    const { model } = build({ marks: [candlestick(prices, { ...ohlc, label: "ACME" })] });
    expect(describeChart(model)).toContain(
      "ACME: 3 candles, prices from 8 to 13; the last opened at 9, ranged from 8.5 to 9.5, and closed at 9.",
    );
  });

  it("refuse infinite prices, and report the widened high and low", () => {
    const odd = table({
      t: [0, 1, 2],
      o: [10, 10, 100],
      h: [-Infinity, 12, 13],
      l: [9, Infinity, 9],
      c: [11, 11, 12],
    });
    const { scene, model } = build({ marks: [candlestick(odd, ohlc)] });
    const { rising, falling } = parts(scene.panels[0]!);
    // Only the last row makes a candle (falling, from 100 to 12).
    expect([rising.count, falling.count]).toEqual([0, 1]);
    const hit = model.inspect(model.xScale()!.map(2), scene.panels[0]!.plot.y + 5)!;
    expect(hit.points[0]!.text).toBe("open 100, high 100, low 9, close 12");
  });

  it("fit y on a reversed x axis, and decide merging by the candles in view", () => {
    const three = table({
      t: [0, 1, 2],
      o: [10, 10, 10],
      h: [13, 13, 13],
      l: [9, 9, 9],
      c: [11, 11, 11],
    });
    const reversed = build({ marks: [candlestick(three, ohlc)], x: { domain: [2, 0] } }).model;
    expect(reversed.yScale()!.domain[0]).toBeLessThanOrEqual(9);
    expect(reversed.yScale()!.domain[1]).toBeGreaterThanOrEqual(13);
    // 1,000 unsorted rows zoomed to one candle: drawn at full slot width.
    const n = 1000;
    const shuffled = table({
      t: Float64Array.from({ length: n }, (_, i) => (i % 2 === 0 ? i : n - i)),
      o: new Float64Array(n).fill(2),
      h: new Float64Array(n).fill(3),
      l: new Float64Array(n).fill(1),
      c: new Float64Array(n).fill(2.5),
    });
    const { scene } = build({ marks: [candlestick(shuffled, ohlc)], x: { domain: [9.5, 10.5] } });
    const { rising } = parts(scene.panels[0]!);
    expect(rising.count).toBe(6);
    expect(rising.coords[2]! - rising.coords[0]!).toBeGreaterThan(10);
  });

  it("keep the last merged candle inside a plot of fractional width", () => {
    const n = 1000;
    const dense = table({
      t: Float64Array.from({ length: n }, (_, i) => i / (n - 1)),
      o: new Float64Array(n).fill(2),
      h: new Float64Array(n).fill(3),
      l: new Float64Array(n).fill(0),
      c: new Float64Array(n).fill(1),
    });
    const { scene } = build({ marks: [candlestick(dense, ohlc)], x: { domain: [0, 1] } }, 600.3);
    const panel = scene.panels[0]!;
    const { bodies } = parts(panel);
    const last = bodies.count - 1;
    expect(bodies.rects[last * 4]! + bodies.rects[last * 4 + 2]!).toBeLessThanOrEqual(
      panel.plot.x + panel.plot.width + 1e-3,
    );
  });

  it("summarize only the candles drawn", () => {
    const mixed = table({
      t: [0, 1, Number.NaN],
      o: [10, 20, 5],
      h: [12, 500, 6],
      l: [9, 0, 4],
      c: [11, 21, 5],
    });
    const { model } = build({ marks: [candlestick(mixed, ohlc)], y: { type: "log" } });
    // Row 1 cannot go on a log axis (low 0) and row 2 has no x.
    expect(describeChart(model)).toContain(
      "c: 1 candle, prices from 9 to 12; the last opened at 10, ranged from 9 to 12, and closed at 11.",
    );
  });
});
