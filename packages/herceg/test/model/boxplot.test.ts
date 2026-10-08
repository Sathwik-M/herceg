import { describe, expect, it } from "vitest";
import { boxStats } from "../../src/data/quantile.ts";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { boxplot } from "../../src/marks/boxplot.ts";
import { describeChart } from "../../src/model/describe.ts";
import { facet } from "../../src/model/facet.ts";
import { type AxisInspection, type ChartConfig, ChartModel } from "../../src/model/model.ts";
import type { PointGeometry, RectGeometry, Scene, SegmentGeometry } from "../../src/scene/scene.ts";

describe("boxStats", () => {
  it("gives quartiles, and whiskers on the most extreme values within 1.5 IQR", () => {
    const stats = boxStats([1, 2, 3, 4, 5, 6, 7, 8, 9, 40]);
    expect([stats.q1, stats.median, stats.q3]).toEqual([3.25, 5.5, 7.75]);
    // Fences at -3.5 and 14.5: 9 is the highest value within; 40 is beyond.
    expect([stats.low, stats.high, stats.outliers]).toEqual([1, 9, [40]]);
    const one = boxStats([7]);
    expect([one.q1, one.median, one.q3, one.low, one.high, one.count]).toEqual([7, 7, 7, 7, 7, 1]);
    const none = boxStats([]);
    expect([none.count, Number.isNaN(none.median)]).toEqual([0, true]);
    // Opposite extremes differ by more than a double holds.
    const wide = boxStats([-1e308, 1e308]);
    expect([wide.q1, wide.median, wide.q3]).toEqual([-5e307, 0, 5e307]);
  });
});

const latency = table({
  region: ["n", "n", "n", "n", "n", "s", "s", "s", "s", "s", "s", "s", "s"],
  version: ["a", "a", "b", "b", "b", "a", "a", "a", "b", "b", "b", "b", "b"],
  ms: [10, 20, 30, 40, 50, 5, 6, 7, 8, 9, 10, 11, 100],
});

function build(config: ChartConfig, width = 600, height = 300) {
  const model = new ChartModel({ locale: "en-US", timeZone: "UTC", ...config });
  model.setSize(width, height, 1);
  return { model, scene: model.scene(estimateText) };
}

const geometry = <T>(scene: Scene, kind: string) =>
  scene.panels[0]!.marks.filter((m) => m.kind === kind) as T[];

describe("boxplot", () => {
  it("draws a box, its lines, and outliers per category, side by side by series", () => {
    const { scene, model } = build({
      marks: [boxplot(latency, { x: "region", y: "ms", series: "version" })],
    });
    expect(scene.legend.map((entry) => entry.label)).toEqual(["a", "b"]);
    const boxes = geometry<RectGeometry>(scene, "rect");
    expect(boxes.map((m) => m.count)).toEqual([2, 2]);
    expect(boxes[0]!.fillOpacity).toBe(0.25);
    expect(geometry<SegmentGeometry>(scene, "segments").map((m) => m.count)).toEqual([18, 18]);
    // s/b holds 8 to 11 and 100: 100 is beyond its whisker.
    expect(geometry<PointGeometry>(scene, "point").map((m) => m.count)).toEqual([0, 1]);
    // The y domain reaches the outlier.
    expect(model.yScale()!.domain[1]).toBeGreaterThanOrEqual(100);
    // The two series' boxes in a category sit side by side, not on top of each other.
    const [a, b] = boxes.map((m) => m.rects[0]!);
    expect(b).toBeGreaterThan(a! + boxes[0]!.rects[2]!);
  });

  it("reports a box's statistics in tooltips and summaries", () => {
    const { scene, model } = build({ marks: [boxplot(latency, { x: "region", y: "ms" })] });
    const box = geometry<RectGeometry>(scene, "rect")[0]!;
    const inspection = model.inspect(box.rects[0]! + 2, 100) as AxisInspection;
    expect(inspection.label).toBe("n");
    expect(inspection.points[0]!.text).toBe(
      "median 30, quartiles 20 to 40, whiskers 10 to 50, 5 values",
    );
    expect(describeChart(model)).toContain("ms: 2 boxes, medians from 8.5 (s) to 30 (n)");
  });

  it("lays boxes along y when the categories are on y", () => {
    const { scene, model } = build({ marks: [boxplot(latency, { x: "ms", y: "region" })] });
    expect(model.yScale()!.type).toBe("band");
    const [box] = geometry<RectGeometry>(scene, "rect");
    // Wider than tall: the box spans values along x.
    expect(box!.rects[2]!).toBeGreaterThan(box!.rects[3]!);
    expect(model.tooltipMode()).toBe("nearest-y");
  });

  it("draws what a log axis can place, and nothing of a box it cannot", () => {
    const skewed = table({ g: ["a", "a", "a", "a", "a", "a"], v: [-1, 1, 2, 3, 4, 100] });
    const { scene, model } = build({
      marks: [boxplot(skewed, { x: "g", y: "v" })],
      y: { type: "log" },
    });
    // The box (q1 1.25, q3 3.75) and its upper whisker show; the lower whisker,
    // reaching -1, does not.
    expect(geometry<RectGeometry>(scene, "rect")[0]!.count).toBe(1);
    expect(geometry<SegmentGeometry>(scene, "segments")[0]!.count).toBe(7);
    expect(geometry<PointGeometry>(scene, "point")[0]!.count).toBe(1);
    expect(model.yScale()!.domain[0]).toBeGreaterThan(0);
  });

  it("finds horizontal boxes in view by their whiskers, and grouped boxes where they are", () => {
    const wide = table({ g: ["a", "a", "a", "a", "a"], v: [0, 25, 50, 75, 100] });
    const { scene, model } = build({
      marks: [boxplot(wide, { x: "v", y: "g" })],
      x: { domain: [60, 90] },
    });
    const plot = scene.panels[0]!.plot;
    expect(model.inspect(plot.x + plot.width / 2, plot.y + plot.height / 2)).toBeDefined();
    // Two series with equal medians: "nearest" takes the box under the pointer.
    const pair = table({
      g: ["a", "a", "a", "a"],
      s: ["one", "one", "two", "two"],
      v: [1, 3, 1, 3],
    });
    const grouped = build({
      marks: [boxplot(pair, { x: "g", y: "v", series: "s" })],
      tooltip: { mode: "nearest" },
    });
    const [, second] = geometry<RectGeometry>(grouped.scene, "rect");
    const [bx, by, bw, bh] = Array.from(second!.rects.subarray(0, 4)) as number[];
    const hit = grouped.model.inspect(bx! + bw! / 2, by! + bh! / 2) as AxisInspection;
    expect(hit.points.map((p) => p.label)).toEqual(["two"]);
  });

  it("groups by a series field whatever its name, and repeats in facets", () => {
    const named = table({ g: ["a", "a"], "": ["one", "two"], v: [1, 10] });
    const { scene } = build({ marks: [boxplot(named, { x: "g", y: "v", series: "" })] });
    expect(geometry<RectGeometry>(scene, "rect")).toHaveLength(2);
    const faceted = table({ g: ["a", "b"], p: ["P", "Q"], v: [1, 2] });
    expect(() =>
      build({ marks: [boxplot(faceted, { x: "g", y: "v" })], facet: facet("p") }),
    ).toThrow("cannot be split into panels");
  });

  it("refuses data without a category axis", () => {
    const numbers = table({ a: [1, 2], b: [3, 4] });
    expect(() => boxplot(numbers, { x: "a" as never, y: "b" })).toThrow("category field on x or y");
  });
});
