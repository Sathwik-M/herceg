import { describe, expect, it } from "vitest";
import { time } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { area } from "../../src/marks/area.ts";
import { line } from "../../src/marks/line.ts";
import { rule } from "../../src/marks/rule.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import type { AreaGeometry, LineGeometry, Scene } from "../../src/scene/scene.ts";

function sceneOf(
  config: ChartConfig,
  width = 600,
  height = 300,
): { model: ChartModel; scene: Scene } {
  const model = new ChartModel({ locale: "en-US", timeZone: "UTC", ...config });
  model.setSize(width, height, 1);
  return { model, scene: model.scene(estimateText) };
}

const yAxis = (scene: Scene) => scene.axes.find((axis) => axis.orient === "left")!;
const xAxis = (scene: Scene) => scene.axes.find((axis) => axis.orient === "bottom")!;
const lines = (scene: Scene) => scene.marks.filter((m): m is LineGeometry => m.kind === "line");

describe("ChartModel layout", () => {
  const data = table({ x: [0, 1, 2, 3, 4], a: [1, 3, 2, 5, 4], b: [2, 2, 3, 3, 9] });

  it("fits a nice y domain and lays out axes inside the chart", () => {
    const { scene } = sceneOf({ marks: [line(data, { x: "x", y: ["a", "b"] })] });
    expect(yAxis(scene).ticks.map((t) => t.label)).toEqual(["0", "2", "4", "6", "8", "10"]);
    expect(scene.plot.x).toBeGreaterThan(10);
    expect(scene.plot.x + scene.plot.width).toBeLessThanOrEqual(600);
    expect(scene.plot.y + scene.plot.height).toBeLessThan(300);
    // Ticks lie inside the plot.
    for (const tick of xAxis(scene).ticks) {
      expect(tick.position).toBeGreaterThanOrEqual(scene.plot.x - 0.01);
      expect(tick.position).toBeLessThanOrEqual(scene.plot.x + scene.plot.width + 0.01);
    }
  });

  it("shows a legend for two or more series only", () => {
    expect(
      sceneOf({ marks: [line(data, { x: "x", y: ["a", "b"] })] }).scene.legend.map((i) => i.label),
    ).toEqual(["a", "b"]);
    expect(sceneOf({ marks: [line(data, { x: "x", y: "a" })] }).scene.legend).toEqual([]);
    expect(
      sceneOf({ marks: [line(data, { x: "x", y: "a" })], legend: true }).scene.legend,
    ).toHaveLength(1);
  });

  it("assigns palette colors in order across marks", () => {
    const { scene } = sceneOf({
      marks: [
        line(data, { x: "x", y: "a" }),
        line(data, { x: "x", y: "b" }),
        line(data, { x: "x", y: "a", stroke: "red" }),
      ],
    });
    const [first, second, third] = lines(scene);
    expect(first!.stroke).not.toBe(second!.stroke);
    expect(third!.stroke).toBe("red");
  });

  it("uses a time axis for time fields", () => {
    const start = Date.UTC(2026, 0, 1);
    const t = table({
      t: time(Float64Array.from({ length: 25 }, (_, i) => start + i * 3_600_000)),
      v: new Float64Array(25),
    });
    const { scene } = sceneOf({ marks: [line(t, { x: "t", y: "v" })] });
    expect(xAxis(scene).ticks.map((tick) => tick.label)).toContain("Jan 2");
  });

  it("does not shrink the y label margin while the size is unchanged", () => {
    const live = table({ x: [0, 1], y: [0, 100_000] });
    const { model, scene } = sceneOf({ marks: [line(live, { x: "x", y: "y" })] });
    const wide = scene.plot.x;
    live.setColumn("y", [0, 1]);
    expect(model.scene(estimateText).plot.x).toBe(wide);
    model.setSize(500, 300);
    expect(model.scene(estimateText).plot.x).toBeLessThan(wide);
  });
});

describe("domains", () => {
  const data = table({ x: [0, 1, 2, 3, 4, 5], y: [10, 20, 30, 40, 50, 1000] });

  it("fits y to the visible x range when zoomed", () => {
    const { model } = sceneOf({ marks: [line(data, { x: "x", y: "y" })] });
    model.setViewport([0, 3]);
    const scene = model.scene(estimateText);
    const labels = yAxis(scene).ticks.map((t) => Number(t.label.replace(/,/g, "")));
    // Points just outside the range are drawn but do not stretch the domain.
    expect(Math.max(...labels)).toBeLessThan(100);
  });

  it("excludes hidden series from the domain and the scene", () => {
    const two = table({ x: [0, 1], a: [0, 1], b: [0, 1000] });
    const { model } = sceneOf({ marks: [line(two, { x: "x", y: ["a", "b"] })] });
    model.hidden.add('[0,"b"]');
    const scene = model.scene(estimateText);
    expect(lines(scene).map((l) => l.key)).toEqual(['[0,"a"]']);
    expect(Math.max(...yAxis(scene).ticks.map((t) => Number(t.label)))).toBeLessThanOrEqual(1);
    expect(scene.legend.find((item) => item.key === '[0,"b"]')?.hidden).toBe(true);
  });

  it("includes rules in the domain", () => {
    const { scene } = sceneOf({
      marks: [line(data, { x: "x", y: "y" }), rule({ y: 2000, label: "limit" })],
    });
    expect(
      Math.max(...yAxis(scene).ticks.map((t) => Number(t.label.replace(/,/g, "")))),
    ).toBeGreaterThanOrEqual(2000);
    expect(scene.marks.some((m) => m.kind === "rule" && m.label === "limit")).toBe(true);
  });

  it("respects explicit domains", () => {
    const { scene } = sceneOf({ marks: [line(data, { x: "x", y: "y" })], y: { domain: [0, 50] } });
    expect(yAxis(scene).ticks.at(-1)!.label).toBe("50");
  });

  it("supports log scales", () => {
    const growth = table({ x: [0, 1, 2, 3], y: [1, 10, 100, 1000] });
    const { scene } = sceneOf({ marks: [line(growth, { x: "x", y: "y" })], y: { type: "log" } });
    expect(yAxis(scene).ticks.map((t) => t.label)).toEqual(["1", "10", "100", "1,000"]);
    const [geometry] = lines(scene);
    const ys = Array.from(
      { length: geometry!.path.count },
      (_, i) => geometry!.path.coords[i * 2 + 1]!,
    );
    // Evenly spaced on a log scale.
    expect(ys[0]! - ys[1]!).toBeCloseTo(ys[1]! - ys[2]!, 1);
  });
});

describe("data edge cases", () => {
  it("renders empty tables without ticks", () => {
    const empty = table({ x: new Float64Array(0), y: new Float64Array(0) });
    const { scene } = sceneOf({ marks: [line(empty, { x: "x", y: "y" })] });
    expect(lines(scene)[0]!.path.count).toBe(0);
    expect(xAxis(scene).ticks).toEqual([]);
    expect(yAxis(scene).ticks).toEqual([]);
  });

  it("renders a single point", () => {
    const one = table({ x: [5], y: [7] });
    const { scene } = sceneOf({ marks: [line(one, { x: "x", y: "y" })] });
    expect(lines(scene)[0]!.path.count).toBe(1);
    expect(yAxis(scene).ticks.length).toBeGreaterThan(1);
  });

  it("leaves gaps for missing and infinite values", () => {
    const gaps = table({ x: [0, 1, 2, 3, 4], y: [1, Number.NaN, 3, Number.POSITIVE_INFINITY, 5] });
    const { scene } = sceneOf({ marks: [line(gaps, { x: "x", y: "y" })] });
    const path = lines(scene)[0]!.path;
    expect(path.count).toBe(3);
    expect(path.starts).toEqual([0, 1, 2]);
  });

  it("handles very large and very small magnitudes", () => {
    const big = table({ x: [0, 1], y: [1e15, 3e15] });
    expect(
      yAxis(sceneOf({ marks: [line(big, { x: "x", y: "y" })] }).scene).ticks.at(-1)!.label,
    ).toMatch(/T$/);
    const tiny = table({ x: [0, 1], y: [1e-9, 3e-9] });
    expect(
      yAxis(sceneOf({ marks: [line(tiny, { x: "x", y: "y" })] }).scene).ticks.length,
    ).toBeGreaterThan(1);
  });

  it("splits long-format rows by a series field without copying", () => {
    const long = table({
      t: [0, 0, 1, 1, 2, 2],
      host: ["a", "b", "a", "b", "a", "b"],
      v: [1, 10, 2, 20, 3, 30],
    });
    const { model, scene } = sceneOf({ marks: [line(long, { x: "t", y: "v", series: "host" })] });
    expect(lines(scene).map((l) => l.path.count)).toEqual([3, 3]);
    const series = model.series();
    expect(series.map((s) => s.label)).toEqual(["a", "b"]);
    expect(series[0]!.y).toBe(long.numbers("v"));
  });

  it("rejects unknown and mistyped fields", () => {
    const t = table({ x: [1], name: ["a"] });
    expect(() => line(t, { x: "x", y: "missing" as never })).toThrow(/Unknown field "missing"/);
    expect(() => line(t, { x: "x", y: "name" as never })).toThrow(/is category/);
  });
});

describe("areas", () => {
  const usage = table({
    t: [0, 1, 2],
    a: [1, 2, 3],
    b: [10, Number.NaN, 30],
    low: [0, 1, 2],
    high: [2, 3, 4],
  });
  const areas = (scene: Scene) => scene.marks.filter((m): m is AreaGeometry => m.kind === "area");

  it("includes zero and closes at the baseline", () => {
    const { scene } = sceneOf({
      marks: [area(table({ x: [0, 1], y: [5, 6] }), { x: "x", y: "y" })],
    });
    expect(yAxis(scene).ticks[0]!.label).toBe("0");
    const geometry = areas(scene)[0]!;
    expect(geometry.lower).toBeNull();
    expect(geometry.baseline).toBeCloseTo(scene.plot.y + scene.plot.height);
  });

  it("stacks layers and treats missing values as zero for layers above", () => {
    const { model } = sceneOf({ marks: [area(usage, { x: "t", y: ["a", "b"], stack: true })] });
    const [first, second] = model.series();
    expect(Array.from(second!.y)).toEqual([11, Number.NaN, 33]);
    expect(Array.from(second!.y0!)).toEqual(Array.from(first!.y));
    // Tooltips report the layer's own value.
    expect(Array.from(second!.values)).toEqual([10, Number.NaN, 30]);
  });

  it("drops hidden layers out of the stack", () => {
    const { model } = sceneOf({ marks: [area(usage, { x: "t", y: ["a", "b"], stack: true })] });
    model.hidden.add('[0,"a"]');
    model.scene(estimateText);
    expect(Array.from(model.series()[1]!.y)).toEqual([10, Number.NaN, 30]);
  });

  it("draws bands between two fields", () => {
    const { scene, model } = sceneOf({ marks: [area(usage, { x: "t", y1: "low", y2: "high" })] });
    expect(areas(scene)[0]!.lower).not.toBeNull();
    const inspection = model.inspect(scene.plot.x + scene.plot.width / 2, scene.plot.y + 10)!;
    expect(inspection.points[0]!.text).toBe("1 – 3");
  });

  it("refuses ambiguous configurations", () => {
    expect(() => area(usage, { x: "t", y: ["a"], series: "a" as never, stack: true })).toThrow();
  });
});

describe("inspect", () => {
  const data = table({ x: [0, 10, 20, 30], a: [1, 2, 3, 4], b: [4, 3, 2, 1] });

  it("reports every series at the nearest x", () => {
    const { model, scene } = sceneOf({ marks: [line(data, { x: "x", y: ["a", "b"] })] });
    const px = scene.plot.x + scene.plot.width * 0.36; // nearest to x = 10
    const inspection = model.inspect(px, scene.plot.y + 20)!;
    expect(inspection.value).toBe(10);
    expect(inspection.points.map((p) => [p.label, p.value])).toEqual([
      ["a", 2],
      ["b", 3],
    ]);
  });

  it("finds the single nearest point", () => {
    const { model, scene } = sceneOf({ marks: [line(data, { x: "x", y: ["a", "b"] })] });
    const target = model
      .inspect(scene.plot.x + 1, scene.plot.y + 1, "nearest-x")!
      .points.find((p) => p.label === "b")!;
    const inspection = model.inspect(target.px, target.py, "nearest")!;
    expect(inspection.points).toHaveLength(1);
    expect(inspection.points[0]!.label).toBe("b");
  });

  it("ignores positions outside the plot", () => {
    const { model } = sceneOf({ marks: [line(data, { x: "x", y: "a" })] });
    expect(model.inspect(1, 1)).toBeUndefined();
  });
});

describe("level of detail", () => {
  it("bounds drawn points by the plot width", () => {
    const n = 200_000;
    const big = table({
      x: Float64Array.from({ length: n }, (_, i) => i),
      y: Float64Array.from({ length: n }, (_, i) => Math.sin(i)),
    });
    const { scene } = sceneOf({ marks: [line(big, { x: "x", y: "y" })] });
    expect(scene.vertices).toBeLessThanOrEqual(4 * scene.plot.width + 8);
    expect(scene.vertices).toBeGreaterThan(scene.plot.width);
  });

  it("draws step lines", () => {
    const steps = table({ x: [0, 1, 2], y: [0, 1, 0] });
    const { scene } = sceneOf({ marks: [line(steps, { x: "x", y: "y", curve: "step-after" })] });
    expect(lines(scene)[0]!.path.count).toBe(5);
  });
});
