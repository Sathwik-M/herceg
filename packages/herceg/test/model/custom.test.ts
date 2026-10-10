// Custom marks: shapes drawn with the chart's scales.
import { describe, expect, it } from "vitest";
import { time } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { bar } from "../../src/marks/bar.ts";
import { type CustomSeries, custom } from "../../src/marks/custom.ts";
import { line } from "../../src/marks/line.ts";
import { describeChart } from "../../src/model/describe.ts";
import { facet } from "../../src/model/facet.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { renderToSVG } from "../../src/render/static.ts";
import type { PathShape, ShapesGeometry, TextShape } from "../../src/scene/scene.ts";
import { loadSpec } from "../../src/spec/load.ts";
import type { ChartSpec } from "../../src/spec/spec.ts";

function build(config: ChartConfig, width = 600, height = 300) {
  const model = new ChartModel({ locale: "en-US", timeZone: "UTC", ...config });
  model.setSize(width, height, 1);
  return { model, scene: model.scene(estimateText) };
}

const start = Date.UTC(2026, 0, 1);
const day = 86_400_000;
const prices = table({
  time: time([start, start + day, start + 2 * day]),
  low: [10, 12, 9],
  high: [14, 15, 20],
});

/** Vertical wicks from low to high, one per row: one glyph from two fields, so no series. */
const wicks = custom(prices, {
  x: "time",
  y: ["low", "high"],
  series: false,
  description: "Daily price ranges.",
  draw({ table: t, x, y, line: segment }) {
    const at = t.numbers("time");
    const low = t.numbers("low");
    const high = t.numbers("high");
    for (let i = 0; i < at.length; i++)
      segment(x(at[i]!), y(low[i]!), x(at[i]!), y(high[i]!), { stroke: "#2a78d6" });
  },
});

describe("custom marks", () => {
  it("draw with the chart's scales, and their fields set the axes", () => {
    const { scene, model } = build({ marks: [wicks] });
    expect(model.xScale()!.type).toBe("time");
    const [lo, hi] = model.yScale()!.domain;
    expect(lo).toBeLessThanOrEqual(9);
    expect(hi).toBeGreaterThanOrEqual(20);
    const shapes = (scene.panels[0]!.marks[0] as ShapesGeometry).shapes as PathShape[];
    expect(shapes).toHaveLength(3);
    const x = model.xScale()!;
    const y = model.yScale()!;
    expect(shapes[2]!.d).toBe(
      `M${Math.round(x.map(start + 2 * day) * 10) / 10} ${Math.round(y.map(9) * 10) / 10}L${
        Math.round(x.map(start + 2 * day) * 10) / 10
      } ${Math.round(y.map(20) * 10) / 10}`,
    );
    expect([shapes[0]!.fill, shapes[0]!.stroke]).toEqual(["none", "#2a78d6"]);
  });

  it("place shapes on other marks' scales without a table", () => {
    const sales = table({ region: ["N", "S"], v: [1, 2] });
    let bandwidth = 0;
    const markers = custom({
      draw({ x, y, circle, text, bandwidth: band }) {
        bandwidth = band.x;
        circle(x(1), y(2), 4, { fill: "#e34948" });
        text(x(1), y(2) - 10, "top");
      },
    });
    const { scene } = build({ marks: [bar(sales, { x: "region", y: "v" }), markers] });
    expect(bandwidth).toBeGreaterThan(0);
    const shapes = (scene.panels[0]!.marks.find((m) => m.kind === "shapes") as ShapesGeometry)
      .shapes;
    expect((shapes[0] as PathShape).fill).toBe("#e34948");
    expect((shapes[1] as TextShape).text).toBe("top");
  });

  it("render in static SVG with the data, clipped, and escape what they are given", () => {
    const svg = renderToSVG({
      width: 400,
      height: 200,
      marks: [
        line(prices, { x: "time", y: "low" }),
        custom({
          draw({ rect, text, plot }) {
            rect(plot.x, plot.y, 10, 10, {
              fill: "#000",
              opacity: 0.5,
              stroke: "red",
              dash: [2, 2],
            });
            text(plot.x, plot.y, "a<b", { anchor: "start" });
          },
        }),
      ],
    });
    const clipped = svg.slice(svg.indexOf("<g clip-path"), svg.indexOf("</g>"));
    expect(clipped).toMatch(
      /<path d="M[\d.]+ [\d.]+h10v10h-10Z" fill="#000" stroke="red" stroke-width="1" stroke-dasharray="2 2" fill-opacity="0.5" stroke-opacity="0.5"\/>/,
    );
    // Text sits on the alphabetic baseline 0.35 font sizes below its middle, as on Canvas.
    expect(clipped).toMatch(
      /<text x="[\d.]+" y="[\d.]+" fill="#1c2333" text-anchor="start">a&#60;b<\/text>/,
    );
  });

  it("treat a stroke of none or no width as no stroke, and skip text without fill", () => {
    const { scene } = build({
      marks: [
        line(prices, { x: "time", y: "low" }),
        custom({
          draw({ path, text }) {
            path("M0 0L1 1", { stroke: "none" });
            path("M0 0L1 1", { stroke: "red", strokeWidth: 0, fill: "blue" });
            path("M0 0L1 1", { stroke: "red", opacity: 7 });
            text(0, 0, "hidden", { fill: "none" });
          },
        }),
      ],
    });
    const shapes = (scene.panels[0]!.marks.find((m) => m.kind === "shapes") as ShapesGeometry)
      .shapes;
    expect(shapes).toHaveLength(3);
    const [none, zero, opaque] = shapes as PathShape[];
    expect([none!.stroke, none!.fill]).toEqual([undefined, scene.theme.text]);
    expect([zero!.stroke, zero!.fill]).toEqual([undefined, "blue"]);
    expect([opaque!.stroke, opaque!.opacity]).toEqual(["red", 1]);
  });

  it("describe themselves in the text alternative when given a description", () => {
    const { model } = build({ marks: [wicks] });
    expect(describeChart(model)).toBe("Daily price ranges.");
    // Series are summarized before the description.
    const ranges = custom(prices, {
      x: "time",
      y: ["low", "high"],
      description: "Ranges.",
      draw() {},
    });
    expect(describeChart(build({ marks: [ranges] }).model)).toBe(
      "low: 3 points, from 9 to 12, last 9. high: 3 points, from 14 to 20, last 20. Ranges.",
    );
  });

  it("check their fields and cannot be loaded from a spec", () => {
    expect(() => custom(prices, { x: "missing" as never, draw() {} })).toThrow(
      /custom x: no field "missing"/,
    );
    const spec = { marks: [{ type: "custom" }] } as unknown as ChartSpec;
    expect(() => loadSpec(spec)).toThrow(/marks\[0\]\.type/);
  });
});

// CPU load of two hosts in long format, rows interleaved, in two regions.
const load = table({
  time: [0, 0, 1, 1, 2, 2],
  cpu: [10, 40, 20, 50, 30, 60],
  host: ["a", "b", "a", "b", "a", "b"],
  region: ["N", "S", "N", "S", "N", "S"],
});

/** A lollipop mark over `load` that records the series each panel's draw received. */
function lollipops(seen: (readonly CustomSeries[])[], options: { facet?: "repeat" } = {}) {
  return custom(load, {
    x: "time",
    y: "cpu",
    series: "host",
    ...options,
    draw({ series, x, y, line: stem, circle }) {
      seen.push(series);
      for (const s of series) {
        for (let k = 0; k < s.length; k++) {
          const row = s.rows ? s.rows[k]! : k;
          stem(x(s.x[row]!), y(0), x(s.x[row]!), y(s.y[row]!), { stroke: s.color });
          circle(x(s.x[row]!), y(s.y[row]!), 3, { fill: s.color });
        }
      }
    },
  });
}

/** The rows a series holds. */
const rowsOf = (s: CustomSeries) => Array.from({ length: s.length }, (_, k) => s.rows?.[k] ?? k);

describe("custom marks with series", () => {
  it("show y fields split by a series field, with a legend entry per series in its color", () => {
    const seen: (readonly CustomSeries[])[] = [];
    const { scene, model } = build({ marks: [lollipops(seen)] });
    expect(seen).toHaveLength(1);
    const [a, b] = seen[0]!;
    expect([a!.label, b!.label]).toEqual(["a", "b"]);
    expect(rowsOf(a!)).toEqual([0, 2, 4]);
    expect(rowsOf(b!)).toEqual([1, 3, 5]);
    expect(scene.legend.map(({ label, color }) => [label, color])).toEqual([
      ["a", a!.color],
      ["b", b!.color],
    ]);
    expect(a!.color).not.toBe(b!.color);
    // The axes fit the series' values.
    expect(model.yScale()!.domain[1]).toBeGreaterThanOrEqual(60);
    // Shapes are drawn in their series' color.
    const shapes = (scene.panels[0]!.marks[0] as ShapesGeometry).shapes as PathShape[];
    expect(shapes.filter((shape) => shape.stroke === a!.color)).toHaveLength(3);
  });

  it("report every series at the nearest x in tooltips, with their own text when given", () => {
    const mark = custom(load, {
      x: "time",
      y: "cpu",
      series: "host",
      pointText: (row, format, s) => `${format.y(s.y[row]!)}% on ${format.x(s.x[row]!)}`,
      draw() {},
    });
    const { model } = build({ marks: [mark] });
    const x = model.xScale()!;
    const y = model.yScale()!;
    const inspection = model.inspect(x.map(1.2), y.map(30), "nearest-x")!;
    expect(inspection.value).toBe(1);
    expect(inspection.points.map(({ label, text }) => [label, text])).toEqual([
      ["a", "20% on 1"],
      ["b", "50% on 1"],
    ]);
    expect(model.tooltipMode()).toBe("nearest-x");
    // Without pointText, the text is the y value, as for lines.
    const plain = build({ marks: [lollipops([])] }).model;
    const at = plain.inspect(plain.xScale()!.map(2), plain.yScale()!.map(60), "nearest")!;
    const point = at.points[0]!;
    expect([point.label, point.text]).toEqual(["b", "60"]);
  });

  it("let the keyboard step through their points", () => {
    const { model } = build({ marks: [lollipops([])] });
    const [a] = model.series();
    const inspection = model.inspectPosition(a!.key, 2)!;
    expect(inspection.value).toBe(2);
    expect(inspection.points.map(({ label, text }) => `${label}: ${text}`)).toEqual([
      "a: 30",
      "b: 60",
    ]);
  });

  it("leave series hidden through the legend out of what draw receives, and out of y", () => {
    const seen: (readonly CustomSeries[])[] = [];
    const { model } = build({ marks: [lollipops(seen)] });
    const [, b] = model.series();
    model.hidden.add(b!.key);
    const scene = model.scene(estimateText);
    expect(seen.at(-1)!.map((s) => s.label)).toEqual(["a"]);
    expect(scene.legend.map(({ label, hidden }) => [label, hidden])).toEqual([
      ["a", false],
      ["b", true],
    ]);
    const shapes = (scene.panels[0]!.marks[0] as ShapesGeometry).shapes as PathShape[];
    expect(shapes.some((shape) => shape.stroke === b!.color)).toBe(false);
    expect(model.yScale()!.domain[1]).toBeLessThan(60);
    const { x, y } = { x: model.xScale()!, y: model.yScale()! };
    expect(model.inspect(x.map(1), y.map(20))!.points.map((p) => p.label)).toEqual(["a"]);
  });

  it("split their rows into facet panels, drawing each panel's part of each series", () => {
    const seen: (readonly CustomSeries[])[] = [];
    const { model, scene } = build({ marks: [lollipops(seen)], facet: facet("region") });
    expect(scene.panels.map((p) => p.key)).toEqual(["N", "S"]);
    // Host a only has rows in N, host b only in S.
    expect(seen.map((series) => series.map((s) => [s.label, rowsOf(s)]))).toEqual([
      [
        ["a", [0, 2, 4]],
        ["b", []],
      ],
      [
        ["a", []],
        ["b", [1, 3, 5]],
      ],
    ]);
    const south = model.panels()[1]!;
    const inspection = model.inspect(south.x.map(0), south.plot.y + 10)!;
    expect([inspection.panel, inspection.points.map((p) => p.text)]).toEqual(["S", ["40"]]);
    // With facet: "repeat", every panel draws every row.
    seen.length = 0;
    build({
      marks: [line(load, { x: "time", y: "cpu" }), lollipops(seen, { facet: "repeat" })],
      facet: facet("region"),
    });
    expect(seen.map((series) => series.map((s) => s.length))).toEqual([
      [3, 3],
      [3, 3],
    ]);
  });

  it("summarize their series in the text alternative", () => {
    const { model } = build({ marks: [lollipops([])] });
    expect(describeChart(model)).toBe(
      "a: 3 points, from 10 to 30, last 30. b: 3 points, from 40 to 60, last 60.",
    );
  });

  it("name a single series by its label, and make one series per y field", () => {
    const single = custom(prices, { x: "time", y: "high", label: "High", draw() {} });
    expect(
      build({ marks: [single] })
        .model.series()
        .map((s) => s.label),
    ).toEqual(["High"]);
    const both = custom(prices, { x: "time", y: ["low", "high"], draw() {} });
    const { scene } = build({ marks: [both] });
    expect(scene.legend.map((item) => item.label)).toEqual(["low", "high"]);
  });

  it("keep shapes between their points in view when zoomed between them", () => {
    // A step from (0, 0) to (10, 100): flat at 0, then up at x = 10.
    const steps = table({ t: [0, 10], v: [0, 100] });
    const stepped = custom(steps, {
      x: "t",
      y: "v",
      draw({ series, x, y, path }) {
        for (const s of series) path(`M${x(s.x[0]!)} ${y(s.y[0]!)}H${x(s.x[1]!)}V${y(s.y[1]!)}`);
      },
    });
    const model = new ChartModel({ locale: "en-US", marks: [stepped] });
    model.setSize(600, 300, 1);
    model.setViewport([4, 6]);
    model.scene(estimateText);
    const [lo, hi] = model.yScale()!.domain;
    expect(lo).toBeLessThanOrEqual(0);
    expect(hi).toBeGreaterThanOrEqual(100);
  });

  it("show no series with series: false, their fields only setting the domains", () => {
    const { model, scene } = build({ marks: [wicks] });
    expect(model.series()).toEqual([]);
    expect(scene.legend).toEqual([]);
    expect(model.yScale()!.domain[1]).toBeGreaterThanOrEqual(20);
    expect(model.inspect(model.xScale()!.map(start), model.yScale()!.map(10))).toBeUndefined();
    expect(wicks.spec).toEqual({ type: "custom" });
  });

  it("show no series without one x field and y fields, as before", () => {
    const spans = table({ start: [0, 2], end: [1, 3], lane: [1, 2] });
    const seen: (readonly CustomSeries[])[] = [];
    const gantt = custom(spans, {
      x: ["start", "end"],
      y: "lane",
      draw({ series }) {
        seen.push(series);
      },
    });
    const { model, scene } = build({ marks: [gantt] });
    expect(model.series()).toEqual([]);
    expect(seen).toEqual([[]]);
    expect(scene.legend).toEqual([]);
    expect(model.xScale()!.domain).toEqual([0, 3]);
    expect(model.inspect(model.xScale()!.map(1), model.yScale()!.map(1))).toBeUndefined();
    // Without series there are no rows to split into panels.
    const regions = table({ t: [0, 1], v: [1, 2], region: ["N", "S"] });
    expect(() =>
      build({
        marks: [line(regions, { x: "t", y: "v" }), custom(regions, { x: "t", draw() {} })],
        facet: facet("region"),
      }),
    ).toThrow(/custom facet: without series, it cannot split into panels; give it facet: "repeat"/);
  });

  it("refuse series options they cannot show", () => {
    expect(() => custom(prices, { y: "low", label: "Low", draw() {} })).toThrow(
      /custom: series, label, and pointText need one x field, y fields/,
    );
    expect(() =>
      custom(prices, { x: "time", y: "low", series: false, pointText: () => "", draw() {} }),
    ).toThrow(/y fields, and no series: false/);
    expect(() =>
      custom(load, { x: "time", y: ["cpu", "time"], series: "host", draw() {} }),
    ).toThrow(/y: several fields or a series field, not both/);
    expect(() => custom(load, { x: "time", y: "cpu", series: "cpu" as never, draw() {} })).toThrow(
      /custom series: field "cpu" holds number values; expected category/,
    );
  });
});
