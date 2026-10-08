// Custom marks: shapes drawn with the chart's scales.
import { describe, expect, it } from "vitest";
import { time } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { bar } from "../../src/marks/bar.ts";
import { custom } from "../../src/marks/custom.ts";
import { line } from "../../src/marks/line.ts";
import { describeChart } from "../../src/model/describe.ts";
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

/** Vertical wicks from low to high, one per row. */
const wicks = custom(prices, {
  x: "time",
  y: ["low", "high"],
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
  });

  it("check their fields and cannot be loaded from a spec", () => {
    expect(() => custom(prices, { x: "missing" as never, draw() {} })).toThrow(/Unknown field/);
    const spec = { marks: [{ type: "custom" }] } as unknown as ChartSpec;
    expect(() => loadSpec(spec)).toThrow(/marks\[0\]\.type/);
  });
});
