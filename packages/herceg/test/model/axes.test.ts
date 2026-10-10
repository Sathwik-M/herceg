// A second y axis on the right for marks with `axis: "right"`.
import { describe, expect, it, vi } from "vitest";
import { encodedCategory } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { bar } from "../../src/marks/bar.ts";
import { custom } from "../../src/marks/custom.ts";
import { line } from "../../src/marks/line.ts";
import { point } from "../../src/marks/point.ts";
import { rule } from "../../src/marks/rule.ts";
import { type TextMark, text } from "../../src/marks/text.ts";
import { describeChart } from "../../src/model/describe.ts";
import { type AxisInspection, type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { renderToSVG } from "../../src/render/static.ts";
import type { LineGeometry, RuleGeometry, Scene } from "../../src/scene/scene.ts";
import { loadSpec } from "../../src/spec/load.ts";
import type { ChartSpec } from "../../src/spec/spec.ts";

function build(config: ChartConfig, width = 600, height = 300) {
  const model = new ChartModel({ locale: "en-US", timeZone: "UTC", ...config });
  model.setSize(width, height, 1);
  return { model, scene: model.scene(estimateText) };
}

const axis = (scene: Scene, orient: "left" | "right") =>
  scene.panels[0]!.axes.find((a) => a.orient === orient);

const traffic = table({
  t: [0, 1, 2, 3],
  latency: [12, 18, 9, 15],
  requests: [1200, 4800, 3100, 2600],
});

describe("right y axis", () => {
  it("gives marks on the right their own scale, labels, and margin", () => {
    const { scene, model } = build({
      marks: [
        line(traffic, { x: "t", y: "latency" }),
        line(traffic, { x: "t", y: "requests", axis: "right" }),
      ],
      yRight: { title: "req/s" },
    });
    const left = model.yScale()!;
    const right = model.yRightScale()!;
    expect(left.domain[1]).toBeLessThan(100);
    expect(right.domain[1]).toBeGreaterThanOrEqual(4800);
    const rightAxis = axis(scene, "right")!;
    expect(rightAxis.offset).toBe(scene.panels[0]!.plot.x + scene.panels[0]!.plot.width);
    expect(rightAxis.ticks.map((t) => t.label)).toContain("4,000");
    expect(rightAxis.title?.text).toBe("req/s");
    // The right series is drawn with the right scale.
    const [, requests] = scene.panels[0]!.marks as LineGeometry[];
    expect(requests!.path.coords[1]).toBeCloseTo(right.map(1200), 3);
    // Grid lines follow the left axis.
    expect(scene.panels[0]!.grid.y).toEqual(axis(scene, "left")!.ticks.map((t) => t.position));
  });

  it("formats each series' tooltip values by its own axis", () => {
    const { scene, model } = build({
      marks: [
        line(traffic, { x: "t", y: "latency" }),
        line(traffic, { x: "t", y: "requests", axis: "right" }),
      ],
      yRight: { format: { notation: "compact" } },
    });
    const inspection = model.inspect(model.xScale()!.map(1), scene.panels[0]!.plot.y + 10)!;
    expect(inspection.points.map((p) => p.text)).toEqual(["18", "4.8K"]);
    expect(inspection.points[1]!.py).toBeCloseTo(model.yRightScale()!.map(4800), 3);
  });

  it("leave the left axis out and draw grid lines for the right one when every mark is there", () => {
    const { scene, model } = build({
      marks: [line(traffic, { x: "t", y: "requests", axis: "right" })],
    });
    expect(axis(scene, "left")).toBeUndefined();
    expect(scene.panels[0]!.grid.y.length).toBeGreaterThan(0);
    expect(scene.panels[0]!.grid.y[0]).toBeCloseTo(axis(scene, "right")!.ticks[0]!.position, 3);
    expect(model.yRightScale()!.domain[1]).toBeGreaterThanOrEqual(4800);
  });

  it("place annotations on the right axis and count them toward it", () => {
    const { scene, model } = build({
      marks: [
        line(traffic, { x: "t", y: "latency" }),
        line(traffic, { x: "t", y: "requests", axis: "right" }),
        rule({ y: 9000, label: "capacity", axis: "right" }),
      ],
    });
    expect(model.yRightScale()!.domain[1]).toBeGreaterThanOrEqual(9000);
    expect(model.yScale()!.domain[1]).toBeLessThan(100);
    const capacity = scene.panels[0]!.marks.find((m): m is RuleGeometry => m.kind === "rule")!;
    expect(capacity.y1).toBeCloseTo(model.yRightScale()!.map(9000), 3);
  });

  it("fit the right axis to its visible series", () => {
    const { model } = build({
      marks: [
        line(traffic, { x: "t", y: "latency" }),
        line(traffic, { x: "t", y: ["requests", "latency"], axis: "right" }),
      ],
    });
    model.hidden.add(model.series()[1]!.key);
    model.scene(estimateText);
    expect(model.yRightScale()!.domain[1]).toBeLessThan(100);
  });

  it("stay in place while their series are hidden", () => {
    const { model } = build({
      marks: [
        line(traffic, { x: "t", y: "latency" }),
        line(traffic, { x: "t", y: "requests", axis: "right" }),
      ],
    });
    for (const keys of [[0], [1], [0, 1]]) {
      model.hidden.clear();
      for (const i of keys) model.hidden.add(model.series()[i]!.key);
      const orients = model.scene(estimateText).panels[0]!.axes.map((a) => a.orient);
      expect(orients).toEqual(["bottom", "left", "right"]);
    }
  });

  it("need marks with y values, so vertical rules add no axis", () => {
    const { scene } = build({
      marks: [line(traffic, { x: "t", y: "latency" }), rule({ x: 2, axis: "right" })],
    });
    expect(scene.panels[0]!.axes.map((a) => a.orient)).toEqual(["bottom", "left"]);
  });

  it("widen the right margin at once and narrow it only on resize", () => {
    const live = table({ t: [0, 1], v: [1, 2] });
    const { model, scene } = build({
      marks: [line(live, { x: "t", y: "v", axis: "right" })],
    });
    const margin = (s: Scene) => s.width - s.panels[0]!.plot.x - s.panels[0]!.plot.width;
    const narrow = margin(scene);
    live.reset({ t: [0, 1], v: [1, 2_000_000] });
    const wide = margin(model.scene(estimateText));
    expect(wide).toBeGreaterThan(narrow);
    live.reset({ t: [0, 1], v: [1, 2] });
    expect(margin(model.scene(estimateText))).toBe(wide);
    model.setSize(500, 300, 1);
    expect(margin(model.scene(estimateText))).toBe(narrow);
  });

  it("refuse categories and marks placed along y", () => {
    const sales = table({ region: ["N", "S"], v: [1, 2] });
    // Types refuse this too; untyped callers and specs get an error.
    const sideways = { x: "v", y: "region", axis: "right" } as never;
    expect(() => build({ marks: [bar(sales, sideways)] })).toThrow(
      /bar axis: marks along y cannot use the right axis/,
    );
  });

  it("render in static SVG and load from specs", () => {
    const svg = renderToSVG({
      width: 400,
      height: 200,
      marks: [
        line(traffic, { x: "t", y: "latency" }),
        line(traffic, { x: "t", y: "requests", axis: "right" }),
      ],
      yRight: { title: "req/s" },
    });
    expect(svg).toMatch(/text-anchor="start" dominant-baseline="middle">4,000<\/text>/);
    expect(svg).toMatch(/transform="rotate\(90 /);
    const spec: ChartSpec = {
      data: { t: { columns: { x: [0, 1], a: [1, 2], b: [100, 200] } } },
      marks: [
        { type: "line", x: "x", y: "a" },
        { type: "line", x: "x", y: "b", axis: "right" },
      ],
      yRight: { title: "b" },
    };
    expect(loadSpec(spec).config.yRight).toEqual({ title: "b" });
    const bad = { ...spec, marks: [{ type: "line", x: "x", y: "b", axis: "middle" }] };
    expect(() => loadSpec(bad as never)).toThrow(/marks\[0\]\.axis: expected "left" or "right"/);
  });

  it("snap nearest-y within one axis", () => {
    const pair = table({ t: [0, 1, 2], a: [0, 4, 10], b: [5, 500, 1000] });
    const { model } = build({
      marks: [line(pair, { x: "t", y: "a" }), line(pair, { x: "t", y: "b", axis: "right" })],
      y: { domain: [0, 10] },
      yRight: { domain: [0, 1000] },
      tooltip: { mode: "nearest-y" },
    });
    const left = model.yScale()!;
    // b is 5 on the right axis, far below the pointer; only left values count.
    const hit = model.inspect(model.xScale()!.map(1), left.map(5)) as AxisInspection;
    expect(hit.points.map((p) => p.text)).toEqual(["4"]);
    expect(hit.position).toBeCloseTo(left.map(4), 3);
    // With every series on the right, the right axis is the one followed.
    const only = build({
      marks: [line(pair, { x: "t", y: "b", axis: "right" })],
      tooltip: { mode: "nearest-y" },
    }).model;
    const right = only.yRightScale()!;
    const along = only.inspect(only.xScale()!.map(1), right.map(500)) as AxisInspection;
    expect(along.points.map((p) => p.text)).toEqual(["500"]);
    expect(along.position).toBeCloseTo(right.map(500), 3);
  });

  it("label x and the right axis when a category left axis has no bands", () => {
    const empty = table({ region: encodedCategory(new Int32Array(0), []), v: [] as number[] });
    const { scene } = build({
      marks: [
        bar(empty, { x: "v", y: "region" }),
        line(traffic, { x: "t", y: "requests", axis: "right" }),
      ],
    });
    expect(axis(scene, "right")!.ticks.length).toBeGreaterThan(0);
    expect(scene.panels[0]!.axes.find((a) => a.orient === "bottom")!.ticks.length).toBeGreaterThan(
      0,
    );
    expect(axis(scene, "left")!.ticks).toEqual([]);
  });

  it("describe values with their own axis' format and name each series' axis", () => {
    const { model } = build({
      marks: [
        line(traffic, { x: "t", y: "latency" }),
        line(traffic, { x: "t", y: "requests", axis: "right" }),
        rule({ y: 5, axis: "right" }),
      ],
      y: { title: "ms", format: { style: "currency", currency: "USD" } },
      yRight: { format: { style: "unit", unit: "meter" } },
    });
    const text = describeChart(model);
    expect(text).toContain("Rule: y 5 m.");
    expect(text).toContain("latency (left axis, ms): 4 points");
    expect(text).toContain("requests (right axis): 4 points");
    // With one axis, series are not labeled by side.
    const single = build({ marks: [line(traffic, { x: "t", y: "latency" })] }).model;
    expect(describeChart(single)).toContain("latency: 4 points");
  });

  it("keep room x labels took at the right edge until a resize", () => {
    const live = table({ t: [0, 100_000_000], v: [1, 2] });
    const { model, scene } = build({ marks: [line(live, { x: "t", y: "v" })] });
    const margin = (s: Scene) => s.width - s.panels[0]!.plot.x - s.panels[0]!.plot.width;
    const wide = margin(scene);
    expect(wide).toBeGreaterThan(12);
    live.reset({ t: [0, 1], v: [1, 2] });
    expect(margin(model.scene(estimateText))).toBe(wide);
    model.setSize(500, 300, 1);
    expect(margin(model.scene(estimateText))).toBeLessThan(wide);
  });

  it("let custom marks draw with the right axis' scale", () => {
    let mapped = Number.NaN;
    let overlay = Number.NaN;
    const { model } = build({
      marks: [
        line(traffic, { x: "t", y: "latency" }),
        custom(traffic, {
          x: "t",
          y: "requests",
          axis: "right",
          draw: ({ y }) => {
            mapped = y(4800);
          },
        }),
        custom({
          axis: "right",
          draw: ({ y }) => {
            overlay = y(1200);
          },
        }),
      ],
    });
    const right = model.yRightScale()!;
    expect(right.domain[1]).toBeGreaterThanOrEqual(4800);
    expect(mapped).toBeCloseTo(right.map(4800), 3);
    expect(overlay).toBeCloseTo(right.map(1200), 3);
  });

  it("need marks, not just a configured domain", () => {
    const { scene } = build({
      marks: [line(traffic, { x: "t", y: "latency" })],
      yRight: { domain: [100, 200], type: "log" },
    });
    expect(axis(scene, "right")).toBeUndefined();
  });

  it("depend on marks, not on the view or the data in it", () => {
    const notes = table({ t: [1], v: [500], name: ["peak"] });
    const note = text(notes, { x: "t", y: "v", textField: "name", axis: "right" });
    const { model } = build({
      marks: [line(traffic, { x: "t", y: "latency" }), note],
      y: { domain: [0, 50], format: { style: "currency", currency: "USD" } },
      yRight: { domain: [0, 1000], format: { style: "unit", unit: "meter" } },
    });
    model.setViewport([1.5, 2]);
    const extents = vi.spyOn(note as TextMark, "yExtent");
    const scene = model.scene(estimateText);
    // The note is out of view, but still the right axis' mark.
    expect(axis(scene, "right")).toBeDefined();
    expect(describeChart(model)).toContain("y 500 m");
    // With fixed domains, the note's rows are not scanned.
    expect(extents).not.toHaveBeenCalled();
  });

  it("give edge labels bounded room that does not grow on redraws", () => {
    const long = table({ c: ["A moderately long category"], v: [1] });
    const { model, scene } = build({ marks: [bar(long, { x: "c", y: "v" })] }, 100, 100);
    const margin = (s: Scene) => s.width - s.panels[0]!.plot.x - s.panels[0]!.plot.width;
    const first = margin(scene);
    expect(first).toBeLessThanOrEqual(25);
    for (let i = 0; i < 3; i++) expect(margin(model.scene(estimateText))).toBe(first);
  });

  it("inspect right series by keyboard, by nearest point, and along y", () => {
    const { scene, model } = build({
      marks: [
        line(traffic, { x: "t", y: "latency" }),
        line(traffic, { x: "t", y: "requests", axis: "right" }),
      ],
      yRight: { format: { notation: "compact" } },
    });
    const x = model.xScale()!;
    const right = model.yRightScale()!;
    const requests = model.series()[1]!;
    const keyed = model.inspectPosition(requests.key, 1)!;
    const point = keyed.points.find((p) => p.key === requests.key)!;
    expect(point.text).toBe("4.8K");
    expect(point.py).toBeCloseTo(right.map(4800), 3);
    const near = model.inspect(x.map(1), right.map(4800), "nearest")!;
    expect(near.points.map((p) => p.label)).toEqual(["requests"]);
    // With the left series hidden, nearest-y follows the right axis and
    // labels the value with its format.
    model.hidden.add(model.series()[0]!.key);
    model.scene(estimateText);
    const along = model.inspect(scene.panels[0]!.plot.x + 5, right.map(3100), "nearest-y")!;
    expect(along.label).toBe("3.1K");
    expect(along.points.map((p) => p.text)).toEqual(["3.1K"]);
  });
});

describe("ticks on axes widened for glyphs", () => {
  it("fall on the rounded values, however short the axis", () => {
    // Points from -5 to 25 round to -20..40 at two ticks' height; widened
    // for the points' radius, that span would step by 50 and keep only 0.
    const spread = table({ t: [0, 1, 2, 3], v: [-5, 25, 10, 0] });
    const labels = (height: number) => {
      const { scene, model } = build({ marks: [point(spread, { x: "t", y: "v" })] }, 400, height);
      return { plot: model.panels()[0]!.plot.height, ticks: axis(scene, "left")!.ticks };
    };
    const short = labels(130);
    expect(short.plot).toBeLessThan(101);
    expect(short.ticks.map((t) => t.label)).toEqual(["-20", "0", "20", "40"]);
  });
});
