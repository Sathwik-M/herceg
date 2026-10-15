// Error bars: intervals with caps, vertical or horizontal.
import { describe, expect, it } from "vitest";
import { time } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { bar } from "../../src/marks/bar.ts";
import { errorBar } from "../../src/marks/errorbar.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { renderToSVG } from "../../src/render/static.ts";
import type { Scene, SegmentGeometry } from "../../src/scene/scene.ts";
import { loadSpec } from "../../src/spec/load.ts";
import { positionOf } from "../helpers/keyboard.ts";

function build(config: ChartConfig, width = 600, height = 300) {
  const model = new ChartModel({ locale: "en-US", timeZone: "UTC", ...config });
  model.setSize(width, height, 1);
  return { model, scene: model.scene(estimateText) };
}

const segments = (scene: Scene) =>
  scene.panels[0]!.marks.filter((m): m is SegmentGeometry => m.kind === "segments");
const segment = (geometry: SegmentGeometry, i: number) =>
  Array.from(geometry.coords.subarray(i * 4, i * 4 + 4));

const stats = table({ group: ["a", "b", "c"], low: [1, 4, Number.NaN], high: [3, 9, 5] });

describe("error bars", () => {
  it("draw a stem and two caps per interval, skipping missing ends", () => {
    const { scene, model } = build({
      marks: [errorBar(stats, { x: "group", y1: "low", y2: "high" })],
    });
    const [bars] = segments(scene);
    expect(bars!.count).toBe(6);
    const x = model.xScale()!;
    const y = model.yScale()!;
    const [x1, y1, x2, y2] = segment(bars!, 0);
    expect([x1, x2]).toEqual([x.map(0), x.map(0)].map((v) => Math.fround(v)));
    expect(y1).toBeCloseTo(y.map(1), 3);
    expect(y2).toBeCloseTo(y.map(3), 3);
    const cap = segment(bars!, 1);
    expect(cap[2]! - cap[0]!).toBeCloseTo(8, 3);
    // Both ends count toward the y domain.
    expect(y.domain[0]).toBeLessThanOrEqual(1);
    expect(y.domain[1]).toBeGreaterThanOrEqual(9);
  });

  it("report both ends in tooltips", () => {
    const { scene, model } = build({
      marks: [errorBar(stats, { x: "group", y1: "low", y2: "high" })],
    });
    const inspection = model.inspect(model.xScale()!.map(1), scene.panels[0]!.plot.y + 10)!;
    expect(inspection.points.map((p) => p.text)).toEqual(["4 – 9"]);
  });

  it("lie along y with y, x1, and x2, and draw no caps at width 0", () => {
    const { scene, model } = build({
      marks: [errorBar(stats, { y: "group", x1: "low", x2: "high", cap: 0 })],
    });
    const [bars] = segments(scene);
    expect(bars!.count).toBe(2);
    const x = model.xScale()!;
    const [x1, y1, x2, y2] = segment(bars!, 1);
    expect(y1).toBeCloseTo(y2!, 3);
    expect(x1).toBeCloseTo(x.map(4), 3);
    expect(x2).toBeCloseTo(x.map(9), 3);
    expect(model.tooltipMode()).toBe("nearest-y");
    const inspection = model.inspect(scene.panels[0]!.plot.x + 5, model.yScale()!.map(1))!;
    expect(inspection.points.map((p) => p.text)).toEqual(["4 – 9"]);
  });

  it("split series by a category field, and need complete intervals", () => {
    const grouped = table({
      x: [1, 1, 2, 2],
      lo: [1, 2, 3, 4],
      hi: [2, 3, 4, 5],
      g: ["p", "q", "p", "q"],
    });
    const { scene } = build({
      marks: [errorBar(grouped, { x: "x", y1: "lo", y2: "hi", series: "g" })],
    });
    expect(segments(scene).map((s) => s.count)).toEqual([6, 6]);
    expect(() => errorBar(stats, { x: "group", y1: "low" } as never)).toThrow(/x with y1 and y2/);
  });

  it("refuse fields of another form rather than dropping them", () => {
    const t = table({ x: [0], a: [1], b: [2] });
    expect(() => errorBar(t, { x: "x", y1: "a", y2: "b", x1: "a" } as never)).toThrow(
      /errorbar x1: not with x, y1, y2; drop it/,
    );
    expect(() => errorBar(t, { x: "x", y: "a", yError: "b", y1: "a" } as never)).toThrow(
      /errorbar y1: not with x, y, yError; drop it/,
    );
  });

  it("take a center and a symmetric error", () => {
    const means = table({ g: ["a", "b"], mean: [5, 8], se: [1, -2] });
    const { scene, model } = build({
      marks: [errorBar(means, { x: "g", y: "mean", yError: "se" })],
    });
    const y = model.yScale()!;
    const stem = segment(segments(scene)[0]!, 3);
    expect(stem[1]).toBeCloseTo(y.map(6), 3);
    expect(stem[3]).toBeCloseTo(y.map(10), 3);
    expect(model.series()[0]!.label).toBe("mean ± se");
  });

  it("find intervals of unsorted horizontal series in every mode", () => {
    const spans = table({ y: [1, 2, 3], lo: [0, 0, 0], hi: [30, 10, 20] });
    for (const mode of ["nearest", "nearest-x"] as const) {
      const { model } = build({
        marks: [errorBar(spans, { y: "y", x1: "lo", x2: "hi" })],
        tooltip: { mode },
      });
      const hit = model.inspect(model.xScale()!.map(30), model.yScale()!.map(1))!;
      expect(hit.points[0]!.text).toBe("0 – 30");
    }
  });

  it("neither draw, report, nor count intervals missing an end", () => {
    const partial = table({ x: [1, 2], lo: [1, Number.NaN], hi: [2, 1_000_000] });
    const { scene, model } = build({ marks: [errorBar(partial, { x: "x", y1: "lo", y2: "hi" })] });
    expect(model.yScale()!.domain[1]).toBeLessThan(10);
    expect(segments(scene)[0]!.count).toBe(3);
    const at = model.inspect(model.xScale()!.map(2), scene.panels[0]!.plot.y + 10);
    expect(at?.points.map((p) => p.text)).not.toContain("NaN – 1,000,000");
    const log = table({ x: [1, 2], lo: [-1, 1], hi: [5, 10] });
    const logged = build({
      marks: [errorBar(log, { x: "x", y1: "lo", y2: "hi" })],
      y: { type: "log" },
    });
    const logAt = logged.model.inspect(
      logged.model.xScale()!.map(1),
      logged.scene.panels[0]!.plot.y + 10,
      "nearest-x",
    );
    // The interval at x = 1 cannot be placed; the tooltip moves to the nearest one drawn.
    expect(logAt?.value).toBe(2);
    expect(logAt?.points.map((p) => p.text)).toEqual(["1 – 10"]);
    // Keyboard navigation does not land on a row without a category.
    const missing = table({ g: ["a", null], lo: [1, 2], hi: [2, 3] });
    const { model: keyed } = build({ marks: [errorBar(missing, { x: "g", y1: "lo", y2: "hi" })] });
    expect(positionOf(keyed, keyed.series()[0]!.key, 1)).toBeUndefined();
  });

  it("count only intervals inside the x view, without joining them", () => {
    const spread = table({ x: [0, 10, 20], lo: [0, 1, 1000], hi: [1, 2, 2000] });
    const { model } = build({ marks: [errorBar(spread, { x: "x", y1: "lo", y2: "hi" })] });
    model.setViewport([9, 11]);
    model.scene(estimateText);
    expect(model.yScale()!.domain[1]).toBeLessThan(10);
  });

  it("put time ends on a time axis, with time tooltips", () => {
    const start = Date.UTC(2026, 0, 1);
    const windows = table({ g: ["a"], from: time([start]), to: time([start + 3_600_000]) });
    const { scene, model } = build({
      marks: [errorBar(windows, { x: "g", y1: "from", y2: "to" })],
    });
    expect(model.yScale()!.type).toBe("time");
    const text = model.inspect(model.xScale()!.map(0), scene.panels[0]!.plot.y + 10)!.points[0]!
      .text;
    expect(text).toMatch(/\d{2}:\d{2}.*–.*\d{2}:\d{2}/);
  });

  it("pad only the position axis for their caps", () => {
    const sales = table({ g: ["a", "b"], v: [10, 20], lo: [8, 18], hi: [12, 25] });
    const domain = (cap: number) =>
      build({
        marks: [
          bar(sales, { x: "g", y: "v" }),
          errorBar(sales, { x: "g", y1: "lo", y2: "hi", cap }),
        ],
      }).model.yScale()!.domain;
    expect(domain(80)).toEqual(domain(0));
  });

  it("pick the interval whose stem is under the pointer", () => {
    const stems = table({ x: [1, 2], lo: [0, 0], hi: [100, 1] });
    const { model } = build({
      marks: [errorBar(stems, { x: "x", y1: "lo", y2: "hi" })],
      tooltip: { mode: "nearest" },
    });
    const hit = model.inspect(model.xScale()!.map(1), model.yScale()!.map(1))!;
    expect(hit.points[0]!.text).toBe("0 – 100");
  });

  it("pick across series without stopping at a farther neighbor, ignoring clipped stems", () => {
    const a = table({ x: [1.2], lo: [0], hi: [10] });
    const b = table({ x: [1, 100], lo: [0, 0], hi: [10, 10] });
    const { model } = build({
      marks: [
        errorBar(a, { x: "x", y1: "lo", y2: "hi", label: "a" }),
        errorBar(b, { x: "x", y1: "lo", y2: "hi", label: "b" }),
      ],
      tooltip: { mode: "nearest" },
      x: { domain: [0, 2] },
    });
    const hit = model.inspect(model.xScale()!.map(1.01), model.yScale()!.map(5))!;
    expect(hit.points[0]!.label).toBe("b");
    const clipped = table({ x: [9, 15], lo: [0, 0], hi: [100, 1] });
    const view = build({
      marks: [errorBar(clipped, { x: "x", y1: "lo", y2: "hi", cap: 0 })],
      tooltip: { mode: "nearest" },
      x: { domain: [10, 20] },
    });
    // Near the top left of the plot, the clipped interval at x = 9 is not drawn.
    const at = view.model.inspect(
      view.model.xScale()!.map(10) + 1,
      view.scene.panels[0]!.plot.y + 2,
    )!;
    expect(at.points[0]!.text).toBe("0 – 1");
  });

  it("pick a cap under the pointer", () => {
    const capped = table({ x: [1, 1.6], lo: [0, 50], hi: [100, 90] });
    const { model } = build({
      marks: [errorBar(capped, { x: "x", y1: "lo", y2: "hi", cap: 80 })],
      tooltip: { mode: "nearest" },
      x: { domain: [0, 10] },
      y: { domain: [0, 100] },
    });
    const hit = model.inspect(model.xScale()!.map(1) + 35, model.yScale()!.map(100))!;
    expect(hit.points[0]!.text).toBe("0 – 100");
  });

  it("fit the x axis to visible horizontal series", () => {
    const two = table({ y: ["a", "b"], lo: [1, 1000], hi: [2, 2000], s: ["p", "q"] });
    const { model } = build({
      marks: [errorBar(two, { y: "y", x1: "lo", x2: "hi", series: "s" })],
    });
    model.hidden.add(model.series()[1]!.key);
    model.scene(estimateText);
    expect(model.xScale()!.domain[1]).toBeLessThan(10);
  });

  it("render as one path per series and load from specs", () => {
    const svg = renderToSVG({
      width: 300,
      height: 150,
      marks: [errorBar(stats, { x: "group", y1: "low", y2: "high", stroke: "#e34948" })],
    });
    expect(svg).toMatch(/<path d="(M[\d.]+ [\d.]+L[\d.]+ [\d.]+){6}" fill="none" stroke="#e34948"/);
    const { config } = loadSpec({
      data: { t: { columns: { g: ["a"], lo: [1], hi: [2] } } },
      marks: [{ type: "errorbar", x: "g", y1: "lo", y2: "hi" }],
    });
    expect(config.marks[0]!.spec.type).toBe("errorbar");
  });
});
