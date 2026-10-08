import { describe, expect, it } from "vitest";
import { time } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import type { Polyline } from "../../src/lod/polyline.ts";
import { area } from "../../src/marks/area.ts";
import { line } from "../../src/marks/line.ts";
import { rule } from "../../src/marks/rule.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { renderToSVG } from "../../src/render/static.ts";
import type { AreaGeometry, LineGeometry, RuleGeometry, Scene } from "../../src/scene/scene.ts";

/** The y of a polyline at pixel x, by linear interpolation, if it spans x. */
function yAt(path: Polyline, x: number): number | undefined {
  const c = path.coords;
  const k = path.controls;
  for (let run = 0; run < path.starts.length; run++) {
    for (let i = path.starts[run]!; i < path.runEnd(run) - 1; i++) {
      const [x0, x1] = [c[i * 2]!, c[i * 2 + 2]!];
      if (!(x0 <= x && x <= x1 && x1 > x0)) continue;
      const t = (x - x0) / (x1 - x0);
      const [y0, y1] = [c[i * 2 + 1]!, c[i * 2 + 3]!];
      // A curved segment's control points sit at thirds of x, so x is linear in t.
      if (!path.curved || Number.isNaN(k[(i + 1) * 4]!)) return y0 + t * (y1 - y0);
      const [ay, by] = [k[(i + 1) * 4 + 1]!, k[(i + 1) * 4 + 3]!];
      const u = 1 - t;
      return u * u * u * y0 + 3 * u * u * t * ay + 3 * u * t * t * by + t * t * t * y1;
    }
  }
  return undefined;
}

/** Points of a drawn path sampled every pixel across its x range. */
function sample(path: Polyline): [number, number][] {
  const xs = Array.from({ length: path.count }, (_, i) => path.coords[i * 2]!);
  const out: [number, number][] = [];
  for (let x = Math.min(...xs); x <= Math.max(...xs); x += 1) {
    const y = yAt(path, x);
    if (y !== undefined) out.push([x, y]);
  }
  return out;
}

/** A monotone line's value at x, read from its drawn path. */
function curveAt(
  xs: number[],
  ys: number[],
  at: number,
  viewport?: [number, number],
  width = 600,
  domain: [number, number] = [0, 200],
): number {
  const model = new ChartModel({
    locale: "en-US",
    y: { domain },
    marks: [line(table({ x: xs, y: ys }), { x: "x", y: "y", curve: "monotone" })],
  });
  model.setSize(width, 300, 1);
  if (viewport) model.setViewport(viewport);
  const path = lines(model.scene(estimateText))[0]!.path;
  return model.yScale()!.invert(yAt(path, model.xScale()!.map(at))!);
}

function sceneOf(
  config: ChartConfig,
  width = 600,
  height = 300,
): { model: ChartModel; scene: Scene } {
  const model = new ChartModel({ locale: "en-US", timeZone: "UTC", ...config });
  model.setSize(width, height, 1);
  return { model, scene: model.scene(estimateText) };
}

const yAxis = (scene: Scene) => scene.panels[0]!.axes.find((axis) => axis.orient === "left")!;
const xAxis = (scene: Scene) => scene.panels[0]!.axes.find((axis) => axis.orient === "bottom")!;
const lines = (scene: Scene) =>
  scene.panels[0]!.marks.filter((m): m is LineGeometry => m.kind === "line");

describe("ChartModel layout", () => {
  const data = table({ x: [0, 1, 2, 3, 4], a: [1, 3, 2, 5, 4], b: [2, 2, 3, 3, 9] });

  it("fits a nice y domain and lays out axes inside the chart", () => {
    const { scene } = sceneOf({ marks: [line(data, { x: "x", y: ["a", "b"] })] });
    expect(yAxis(scene).ticks.map((t) => t.label)).toEqual(["0", "2", "4", "6", "8", "10"]);
    expect(scene.panels[0]!.plot.x).toBeGreaterThan(10);
    expect(scene.panels[0]!.plot.x + scene.panels[0]!.plot.width).toBeLessThanOrEqual(600);
    expect(scene.panels[0]!.plot.y + scene.panels[0]!.plot.height).toBeLessThan(300);
    // Ticks lie inside the plot.
    for (const tick of xAxis(scene).ticks) {
      expect(tick.position).toBeGreaterThanOrEqual(scene.panels[0]!.plot.x - 0.01);
      expect(tick.position).toBeLessThanOrEqual(
        scene.panels[0]!.plot.x + scene.panels[0]!.plot.width + 0.01,
      );
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
    const wide = scene.panels[0]!.plot.x;
    live.setColumn("y", [0, 1]);
    expect(model.scene(estimateText).panels[0]!.plot.x).toBe(wide);
    model.setSize(500, 300);
    expect(model.scene(estimateText).panels[0]!.plot.x).toBeLessThan(wide);
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

  it("keeps reversed axes reversed when zoomed", () => {
    const { model } = sceneOf({
      x: { domain: [5, 0] },
      y: { domain: [1000, 0] },
      yRight: { domain: [0, 100] },
      marks: [line(data, { x: "x", y: "y" }), line(data, { x: "x", y: "y", axis: "right" })],
    });
    model.setViewport([1, 4]);
    model.setYViewport({ y: [800, 200], yRight: [20, 80] });
    model.scene(estimateText);
    expect(model.viewport).toEqual([1, 4]);
    expect(model.yViewport).toEqual({ y: [200, 800], yRight: [20, 80] });
    expect(model.xScale()!.domain).toEqual([4, 1]);
    expect(model.yScale()!.domain).toEqual([800, 200]);
    expect(model.yRightScale()!.domain).toEqual([20, 80]);
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
    const rules = scene.panels[0]!.marks.filter((m): m is RuleGeometry => m.kind === "rule");
    expect(rules.some((m) => m.label === "limit")).toBe(true);
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
  const areas = (scene: Scene) =>
    scene.panels[0]!.marks.filter((m): m is AreaGeometry => m.kind === "area");

  it("includes zero and closes at the baseline", () => {
    const { scene } = sceneOf({
      marks: [area(table({ x: [0, 1], y: [5, 6] }), { x: "x", y: "y" })],
    });
    expect(yAxis(scene).ticks[0]!.label).toBe("0");
    const geometry = areas(scene)[0]!;
    expect(geometry.lower).toBeNull();
    expect(geometry.baseline).toBeCloseTo(scene.panels[0]!.plot.y + scene.panels[0]!.plot.height);
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
    const inspection = model.inspect(
      scene.panels[0]!.plot.x + scene.panels[0]!.plot.width / 2,
      scene.panels[0]!.plot.y + 10,
    )!;
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
    const px = scene.panels[0]!.plot.x + scene.panels[0]!.plot.width * 0.36; // nearest to x = 10
    const inspection = model.inspect(px, scene.panels[0]!.plot.y + 20)!;
    expect(inspection.value).toBe(10);
    expect(inspection.points.map((p) => [p.label, p.value])).toEqual([
      ["a", 2],
      ["b", 3],
    ]);
  });

  it("finds the single nearest point", () => {
    const { model, scene } = sceneOf({ marks: [line(data, { x: "x", y: ["a", "b"] })] });
    const target = model
      .inspect(scene.panels[0]!.plot.x + 1, scene.panels[0]!.plot.y + 1, "nearest-x")!
      .points.find((p) => p.label === "b")!;
    const inspection = model.inspect(target.px, target.py, "nearest")!;
    expect(inspection.points).toHaveLength(1);
    expect(inspection.points[0]!.label).toBe("b");
  });

  it("ignores positions outside the plot", () => {
    const { model } = sceneOf({ marks: [line(data, { x: "x", y: "a" })] });
    expect(model.inspect(1, 1)).toBeUndefined();
  });

  it("snap along x to the nearest point drawn, skipping missing values", () => {
    const at = (x: number[], v: number[], value: number, config: Partial<ChartConfig> = {}) => {
      const { model, scene } = sceneOf({
        marks: [line(table({ x, v }), { x: "x", y: "v" })],
        ...config,
      });
      const hit = model.inspect(model.xScale()!.map(value), scene.panels[0]!.plot.y + 5);
      return hit && [hit.value, hit.points.map((p) => p.value)];
    };
    const gap = Number.NaN;
    // Measured from the pointer: at 6, 10 is nearer than 0.
    expect(at([0, 5, 10], [1, gap, 2], 6)).toEqual([10, [2]]);
    // Unsorted rows: at 5, 9 is nearer than 0.
    expect(at([9, 5, 0], [1, gap, 2], 5)).toEqual([9, [1]]);
    expect(at([1, 20, 5, -10, 9], [1, 1, gap, 1, 1], 5, { x: { domain: [0, 10] } })).toEqual([
      1,
      [1],
    ]);
    // Of several points at one x, the one drawn.
    expect(at([0, 1, 1, 2], [1, gap, 2, 3], 1)).toEqual([1, [2]]);
    // In the middle of a long gap, nothing is near enough.
    const n = 5000;
    const xs = Array.from({ length: n }, (_, i) => i);
    const vs = xs.map((i) => (i === 0 || i === n - 1 ? 1 : gap));
    expect(at(xs, vs, n / 2)).toBeUndefined();
    expect(at(xs, vs, 3)).toEqual([0, [1]]);
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
    expect(scene.vertices).toBeLessThanOrEqual(4 * scene.panels[0]!.plot.width + 8);
    expect(scene.vertices).toBeGreaterThan(scene.panels[0]!.plot.width);
  });

  it("draws step lines", () => {
    const steps = table({ x: [0, 1, 2], y: [0, 1, 0] });
    const { scene } = sceneOf({ marks: [line(steps, { x: "x", y: "y", curve: "step-after" })] });
    expect(lines(scene)[0]!.path.count).toBe(5);
  });

  it("draws monotone curves through every point without overshooting", () => {
    const data = table({ x: [0, 1, 2, 3, 4, 5], y: [5, 5, 1, 2, 2, 4] });
    const { scene, model } = sceneOf({
      marks: [line(data, { x: "x", y: "y", curve: "monotone" })],
    });
    const { path } = lines(scene)[0]!;
    const x = model.xScale()!;
    const y = model.yScale()!;
    // Curved segments, as cubic curves between the data's points.
    expect(path.curved).toBe(true);
    expect(path.count).toBe(6);
    for (let i = 0; i <= 5; i++)
      expect(yAt(path, x.map(i))!).toBeCloseTo(y.map([5, 5, 1, 2, 2, 4][i]!), 3);
    const points = sample(path);
    // Within the data's range, and flat where the data is flat.
    for (const [px, py] of points) {
      expect(py).toBeGreaterThanOrEqual(y.map(5) - 1e-3);
      expect(py).toBeLessThanOrEqual(y.map(1) + 1e-3);
      if (px <= x.map(1)) expect(py).toBeCloseTo(y.map(5), 3);
      if (px >= x.map(3) && px <= x.map(4)) expect(py).toBeCloseTo(y.map(2), 3);
    }
  });

  it("curves both edges of bands so they never cross, and keeps gaps", () => {
    const data = table({
      x: [0, 1, 2, 3, 4, 5],
      lo: [0, 1, 1, Number.NaN, 2, 0],
      hi: [0.01, 1.01, 2.01, 2, 4, 1],
    });
    const { scene } = sceneOf({
      marks: [area(data, { x: "x", y1: "lo", y2: "hi", curve: "monotone" })],
    });
    const { upper, lower } = scene.panels[0]!.marks[0] as AreaGeometry;
    expect(upper.starts).toHaveLength(2);
    expect(lower!.starts).toHaveLength(2);
    // On screen the upper edge is never below the lower one, sampled along the curves.
    const samples = sample(upper);
    expect(samples.length).toBeGreaterThan(100);
    for (const [x, y] of samples) {
      const at = yAt(lower!, x);
      if (at !== undefined) expect(y).toBeLessThanOrEqual(at + 1e-3);
    }
  });

  it("shares each curved stack boundary between the layers on either side", () => {
    const data = table({ x: [0, 1, 2, 3], a: [0, 1, 0, 1], b: [1, 1, Number.NaN, 1] });
    const { scene } = sceneOf({
      marks: [area(data, { x: "x", y: ["a", "b"], stack: true, curve: "monotone" })],
    });
    const [first, second] = scene.panels[0]!.marks as AreaGeometry[];
    // The second layer's base follows the first layer's top wherever both are drawn.
    let compared = 0;
    for (const [x, y] of sample(second!.lower!)) {
      const at = yAt(first!.upper, x);
      if (at === undefined) continue;
      expect(y).toBeCloseTo(at, 3);
      compared++;
    }
    expect(compared).toBeGreaterThan(50);
    // Layers stay ordered.
    for (const [x, y] of sample(second!.upper)) {
      const at = yAt(second!.lower!, x);
      if (at !== undefined) expect(y).toBeLessThanOrEqual(at + 1e-3);
    }
  });

  it("keeps curves the same when zoomed, and ignores repeated points", () => {
    expect(curveAt([0, 1, 2, 3], [0, 100, 0, 100], 0.5, [0.25, 0.75])).toBeCloseTo(
      curveAt([0, 1, 2, 3], [0, 100, 0, 100], 0.5),
      0,
    );
    expect(curveAt([0, 1, 1, 2], [0, 100, 100, 200], 0.5)).toBeCloseTo(
      curveAt([0, 1, 2], [0, 100, 200], 0.5),
      1,
    );
    expect(curveAt([0, 1, 2], [0, 100, 200], 0.5)).toBeCloseTo(50, 0);
    // Repeated points at the edge of the view still see the next distinct one.
    const xs = [0, 1, 1, 1, 2, 3];
    const ys = [0, 100, 100, 100, 0, 100];
    expect(curveAt(xs, ys, 0.5, [0.25, 0.75])).toBeCloseTo(curveAt(xs, ys, 0.5), 0);
  });

  it("curves sparse stretches of irregular data whatever the plot size", () => {
    const xs = [...Array.from({ length: 199 }, (_, i) => i * 0.001), 1, 2, 3];
    const ys = [...xs.slice(0, 199).map(() => 0), 100, 0, 100];
    const narrow = curveAt(xs, ys, 1.25, undefined, 403);
    expect(curveAt(xs, ys, 1.25, undefined, 404)).toBeCloseTo(narrow, 0);
    // Curved, not straight: a straight line passes through 75 there.
    expect(narrow).toBeCloseTo(100 * (1 - (3 * 0.25 ** 2 - 2 * 0.25 ** 3)), 0);
  });

  it("keeps curved upper edges within their data, and stacks on log axes consistent", () => {
    const band = table({ x: [0, 1, 2], lo: [0, 1, 2], hi: [3, 3, 2] });
    const { scene, model } = sceneOf({
      marks: [area(band, { x: "x", y1: "lo", y2: "hi", curve: "monotone" })],
    });
    const { upper } = scene.panels[0]!.marks[0] as AreaGeometry;
    const top = model.yScale()!.map(3);
    for (let i = 0; i < upper.count; i++)
      expect(upper.coords[i * 2 + 1]!).toBeGreaterThanOrEqual(top - 1e-3);
    const logs = table({ x: [0, 1, 2, 3], a: [1, 10, 1, 10], b: [10, 10, 10, 10] });
    const stacked = sceneOf({
      y: { type: "log", domain: [1, 100] },
      marks: [area(logs, { x: "x", y: ["a", "b"], stack: true, curve: "monotone" })],
    }).scene;
    const [first, second] = stacked.panels[0]!.marks as AreaGeometry[];
    for (let i = 0; i < second!.lower!.count; i++) {
      const at = yAt(first!.upper, second!.lower!.coords[i * 2]!);
      if (at !== undefined) expect(second!.lower!.coords[i * 2 + 1]!).toBeCloseTo(at, 3);
    }
  });

  it("handles hidden layers, zoomed limits, density, and huge segments", () => {
    // Every layer hidden, then one shown again.
    const stack = table({ x: [0, 1, 2], a: [1, 2, 1], b: [2, 1, 2] });
    const { model } = sceneOf({
      marks: [area(stack, { x: "x", y: ["a", "b"], stack: true, curve: "monotone" })],
    });
    const keys = (model.scene(estimateText).panels[0]!.marks as AreaGeometry[]).map((g) => g.key);
    for (const key of keys) model.hidden.add(key);
    expect(model.scene(estimateText).panels[0]!.marks).toEqual([]);
    model.hidden.delete(keys[1]!);
    expect(model.scene(estimateText).panels[0]!.marks).toHaveLength(1);

    // Automatic y limits hold what is drawn between zoomed edges: a curve,
    // a band drawn straight where its curves could cross, and a log x axis.
    const inPlot = (model: ChartModel) => {
      const zoomed = model.scene(estimateText);
      const { plot } = zoomed.panels[0]!;
      const drawn = (zoomed.panels[0]!.marks as (LineGeometry | AreaGeometry)[]).flatMap((g) =>
        g.kind === "line" ? [g.path] : [g.upper, ...(g.lower ? [g.lower] : [])],
      );
      for (const path of drawn) {
        for (const [px, py] of sample(path)) {
          if (px < plot.x || px > plot.x + plot.width) continue;
          expect(py).toBeGreaterThanOrEqual(plot.y - 0.5);
          expect(py).toBeLessThanOrEqual(plot.y + plot.height + 0.5);
        }
      }
    };
    const wave = sceneOf({
      marks: [
        line(table({ x: [0, 1, 2, 3], y: [0, 100, 0, 100] }), {
          x: "x",
          y: "y",
          curve: "monotone",
        }),
      ],
    }).model;
    wave.setViewport([0.25, 0.75]);
    inPlot(wave);
    const crossing = table({ x: [0, 1, 2, 3], lo: [9, 11, 67, 85], hi: [14, 13, 67, 89] });
    const crossed = sceneOf({
      marks: [area(crossing, { x: "x", y1: "lo", y2: "hi", curve: "monotone" })],
    }).model;
    crossed.setViewport([1.3, 1.4]);
    inPlot(crossed);
    const logs = sceneOf({
      x: { type: "log" },
      marks: [
        line(table({ x: [1, 10, 100, 1000], y: [0, 100, 0, 100] }), {
          x: "x",
          y: "y",
          curve: "monotone",
        }),
      ],
    }).model;
    logs.setViewport([2, 3]);
    inPlot(logs);

    // A band whose dense stretch is followed by a sparse one curves the
    // sparse stretch at any width.
    const dense = Array.from({ length: 800 }, (_, i) => i * 0.0001);
    const xs = [...dense, 1, 2, 3];
    const band = table({ x: xs, lo: xs.map(() => 0), hi: [...dense.map(() => 0), 100, 0, 100] });
    const bandAt = (width: number) => {
      const m = new ChartModel({
        locale: "en-US",
        y: { domain: [0, 200] },
        marks: [area(band, { x: "x", y1: "lo", y2: "hi", curve: "monotone" })],
      });
      m.setSize(width, 300, 1);
      const { upper } = m.scene(estimateText).panels[0]!.marks[0] as AreaGeometry;
      return m.yScale()!.invert(yAt(upper, m.xScale()!.map(1.25))!);
    };
    expect(bandAt(444)).toBeCloseTo(bandAt(445), 0);
    expect(bandAt(444)).toBeCloseTo(100 * (1 - (3 * 0.25 ** 2 - 2 * 0.25 ** 3)), 0);

    // A segment far larger than the plot is flattened accurately where it shows.
    // The segment from x 0 to 1: tangent −1.5e8 at its start (an end), 0 at the minimum.
    const s = 0.9996;
    const hermite = (2 * s ** 3 - 3 * s ** 2 + 1) * 1e8 + (s ** 3 - 2 * s ** 2 + s) * -1.5e8;
    expect(curveAt([0, 1, 2], [1e8, 0, 1e8], s, [0.9995, 1.0005], 600, [0, 100])).toBeCloseTo(
      hermite,
      0,
    );
  });

  it("draws curves natively in SVG and PDF, straight where points are close", () => {
    // Curved segments, then a dense stretch (0.001 apart) that stays straight.
    const xs = [0, 1, 2, 3, 3.001, 3.002, 4];
    const data = table({ x: xs, lo: xs.map(() => 0), hi: [1, 3, 2, 3, 3.1, 3, 1] });
    const options = {
      width: 400,
      height: 200,
      locale: "en-US",
      marks: [
        line(data, { x: "x", y: "hi", curve: "monotone" }),
        area(data, { x: "x", y1: "lo", y2: "hi", curve: "monotone" }),
      ],
    };
    const svg = renderToSVG(options);
    const paths = [...svg.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]!);
    const curved = paths.filter((d) => d.includes("C"));
    expect(curved.length).toBeGreaterThanOrEqual(2);
    // Curves and lines mix in one path; the band's outline closes back along its lower edge.
    expect(curved.some((d) => /C[^Z]*L[^Z]*C/.test(d))).toBe(true);
  });

  it("draws dense or straight data without extra points", () => {
    const n = 40_000;
    const noisy = table({
      x: Float64Array.from({ length: n }, (_, i) => i),
      y: Float64Array.from({ length: n }, (_, i) => Math.sin(i) * 100),
    });
    const dense = sceneOf({ marks: [line(noisy, { x: "x", y: "y", curve: "monotone" })] }).scene;
    expect(dense.vertices).toBeLessThanOrEqual(4 * dense.panels[0]!.plot.width + 8);
    const straight = table({ x: [0, 1, 2, 3], y: [0, 10, 20, 30] });
    const { scene } = sceneOf({ marks: [line(straight, { x: "x", y: "y", curve: "monotone" })] });
    expect(lines(scene)[0]!.path.count).toBe(4);
  });
});
