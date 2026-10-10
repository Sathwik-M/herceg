import { describe, expect, it } from "vitest";
import { time } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { HistogramMark, histogram } from "../../src/marks/histogram.ts";
import { describeChart } from "../../src/model/describe.ts";
import { facet } from "../../src/model/facet.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { panels } from "../../src/model/panels.ts";
import type { RectGeometry } from "../../src/scene/scene.ts";
import type { ScaleResolution } from "../../src/spec/spec.ts";
import legacy from "./fixtures/histogram-legacy.json";

function build(config: ChartConfig) {
  const model = new ChartModel({ locale: "en-US", timeZone: "UTC", ...config });
  model.setSize(600, 300, 1);
  const scene = model.scene(estimateText);
  return { model, scene };
}
const values = (model: ChartModel) => model.series().map((s) => [...s.values]);
const rectangles = (scene: ReturnType<typeof build>["scene"]) =>
  scene.panels[0]!.marks.filter((m): m is RectGeometry => m.kind === "rect");

// Adjacent IEEE 754 values, including edges whose next value differs from a rounded decimal.
function next(value: number, direction: -1 | 1) {
  const data = new DataView(new ArrayBuffer(8));
  data.setFloat64(0, value);
  data.setBigUint64(0, data.getBigUint64(0) + BigInt(direction));
  return data.getFloat64(0);
}

describe("histogram options", () => {
  it.each(legacy)(
    "preserves legacy values, geometry, domains, and summaries ($options.normalize, $options.stack)",
    (fixture) => {
      const data = table({ ...fixture.data, v: fixture.data.v.map((v) => v ?? Number.NaN) });
      const { model, scene } = build({
        marks: [
          histogram(data, {
            bins: fixture.options.bins,
            ...(fixture.options.stack ? { stack: true } : {}),
            x: "v",
            series: "g",
            ...(fixture.options.normalize
              ? { normalize: fixture.options.normalize as "percent" | "density" }
              : {}),
          }),
        ],
      });
      expect(
        model.series().map((s) => ({
          x: [...s.x],
          y: [...s.y],
          y0: s.y0 ? [...s.y0] : null,
          values: [...s.values],
        })),
      ).toEqual(fixture.series);
      expect(
        rectangles(scene).map((m) => ({
          rects: [...m.rects.slice(0, m.count * 4)],
          count: m.count,
          opacity: m.fillOpacity,
        })),
      ).toEqual(fixture.geometry);
      expect(model.xScale()!.domain).toEqual(fixture.x);
      expect(model.yScale()!.domain).toEqual(fixture.y);
      expect(describeChart(model)).toBe(fixture.summary);
    },
  );

  it("uses exact uneven edges, includes the last edge, and excludes nonfinite/outside values", () => {
    const edges = [0, 1, 2, 10] as const;
    const data = table({
      v: [-1, 0, next(1, -1), 1, 2, 10, next(10, 1), Number.NaN, Infinity, -Infinity],
    });
    const { model } = build({ marks: [histogram(data, { x: "v", bins: edges })] });
    expect(values(model)).toEqual([[2, 1, 2]]);
    expect([...model.series()[0]!.x]).toEqual([0.5, 1.5, 6]);
    expect(model.xScale()!.domain).toEqual([0, 10]);
    expect(describeChart(model)).toContain("5 missing or outside the bins");
  });

  it.each([0.3, 0.1 + 2 * 0.1])("preserves decimal edge %s and one ULP on each side", (edge) => {
    const data = table({ v: [next(edge, -1), edge, next(edge, 1), 0.3] });
    const { model } = build({ marks: [histogram(data, { x: "v", bins: [0.1, 0.2, edge, 0.4] })] });
    expect(values(model)).toEqual([[0, edge === 0.3 ? 1 : 2, edge === 0.3 ? 3 : 2]]);
  });

  it("does not coarsen, extend, or mutate explicit edges, even with no finite values", () => {
    const edges = [0.1, 0.2, 0.1 + 2 * 0.1, 0.4];
    const mark = histogram(table({ v: [Number.NaN] }), { x: "v", bins: edges });
    edges[1] = 0.25;
    const { model } = build({ marks: [mark] });
    expect([...model.series()[0]!.x]).toEqual([
      0.15 + 2 ** -55,
      (0.2 + (0.1 + 2 * 0.1)) / 2,
      (0.1 + 2 * 0.1 + 0.4) / 2,
    ]);
    expect(values(model)).toEqual([[0, 0, 0]]);
    expect(mark.spec.bins).toEqual([0.1, 0.2, 0.1 + 2 * 0.1, 0.4]);
    const many = Array.from({ length: 1001 }, (_, i) => i / 1000);
    expect(
      build({ marks: [histogram(table({ v: [0, 1] }), { x: "v", bins: many })] }).model.series()[0]!
        .length,
    ).toBe(1000);
  });

  it.each(
    [
      [],
      [1],
      [0, 0],
      [2, 1],
      [0, Number.NaN],
      [0, Infinity],
      Array.from({ length: 1002 }, (_, i) => i),
    ].map((bins) => ({ bins })),
  )("refuses invalid explicit edges $bins", ({ bins }) => {
    expect(() => histogram(table({ v: [1] }), { x: "v", bins })).toThrow(RangeError);
    expect(() => histogram(table({ v: [1] }), { x: "v", bins })).toThrow(/edges|increasing|finite/);
  });

  it.each([false, true])(
    "bins time fields in exact epoch-millisecond edges (horizontal %s)",
    (horizontal) => {
      const start = Date.UTC(2026, 0, 1);
      const edges = [start, start + 86_400_000, start + 3 * 86_400_000];
      const mark = histogram(table({ t: time([start, edges[1]!, edges[2]!]) }), {
        ...(horizontal ? { y: "t" } : { x: "t" }),
        bins: edges,
      });
      const { model } = build({ marks: [mark] });
      expect(values(model)).toEqual([[1, 2]]);
      expect((horizontal ? model.yScale() : model.xScale())!.type).toBe("time");
      const hit = model.inspectPosition(model.keyboardStops("")[0]!.key, 0)!;
      expect(hit.axis).toBe(horizontal ? "y" : "x");
      expect(hit.points[0]!.text).toMatch(/Jan 1.* – .*Jan 2.*: 1$/);
      expect(describeChart(model)).toMatch(/from .*Jan 1.* to .*Jan 4/);
    },
  );

  it("swaps geometry, extents, inspection, keyboard stops, and summaries for y", () => {
    const data = table({ v: [0, 1, 2, 3, 4], g: ["a", "a", "b", "b", "b"] });
    const { model, scene } = build({
      marks: [histogram(data, { y: "v", bins: [0, 2, 4], series: "g", stack: true })],
    });
    const [a, b] = model.series();
    expect([...a!.y]).toEqual([1, 3]);
    expect([...b!.x0!]).toEqual([2, 0]);
    expect([...b!.x]).toEqual([2, 3]);
    expect(a!.sorted).toBe(false);
    expect(model.xScale()!.domain[0]).toBe(0);
    expect(model.yScale()!.domain).toEqual([0, 4]);
    expect(model.tooltipMode()).toBe("nearest-y");
    expect(model.cursorAxis()).toBe("y");
    expect(model.keyboardStops("")).toHaveLength(1);
    const hit = model.inspect(model.xScale()!.map(1), model.yScale()!.map(1))!;
    expect(hit.axis).toBe("y");
    expect(hit.points.map((p) => p.text)).toEqual(["0 – 2: 2", "0 – 2: 0"]);
    expect(hit.points.every((p) => p.row === undefined)).toBe(true);
    expect(model.inspectPosition(a!.key, 1)!.points.map((p) => p.value)).toEqual([0, 3]);
    const rect = rectangles(scene)[0]!.rects;
    expect(rect[0]).toBeCloseTo(model.xScale()!.map(0), 4);
    expect(rect[2]).toBeCloseTo(model.xScale()!.map(2) - model.xScale()!.map(0), 4);
    expect(rect[1]).toBeCloseTo(model.yScale()!.map(2) + 0.5, 4);
    expect(rect[3]).toBeCloseTo(Math.abs(model.yScale()!.map(2) - model.yScale()!.map(0)) - 1, 4);
    expect(describeChart(model)).toContain("a: 2 values in 2 bins from 0 to 4");
  });

  it.each([false, true])(
    "handles logarithmic measure axes and keyboard anchors (horizontal %s)",
    (horizontal) => {
      const mark = histogram(table({ v: [1, 8], g: ["a", "b"] }), {
        ...(horizontal ? { y: "v" } : { x: "v" }),
        series: "g",
        bins: [0, 5, 10],
      });
      const { model, scene } = build({
        marks: [mark],
        ...(horizontal ? { x: { type: "log" as const } } : { y: { type: "log" as const } }),
      });
      expect(
        rectangles(scene).every((r) => [...r.rects.slice(0, r.count * 4)].every(Number.isFinite)),
      ).toBe(true);
      expect(model.inspectPosition(model.series()[0]!.key, 1)!.points.map((p) => p.label)).toEqual([
        "b",
      ]);
    },
  );

  it.each(["count", "probability", "percent", "density"] as const)(
    "accumulates %s before stacking and common normalization",
    (normalize) => {
      const data = table({ v: [0, 1, 3, 4, 9], g: ["a", "a", "a", "b", "b"] });
      const { model } = build({
        marks: [
          histogram(data, {
            y: "v",
            bins: [0, 2, 10],
            series: "g",
            normalize,
            cumulative: true,
            stack: true,
            commonNorm: true,
          }),
        ],
      });
      const scale = normalize === "percent" ? 100 : 1;
      if (normalize === "count")
        expect(values(model)).toEqual([
          [2, 3],
          [0, 2],
        ]);
      else {
        expect(values(model)[0]![0]).toBeCloseTo(0.4 * scale);
        expect(values(model)[0]![1]).toBeCloseTo(0.6 * scale);
        expect(values(model)[1]![1]).toBeCloseTo(0.4 * scale);
      }
      expect([...model.series()[1]!.x0!]).toEqual(values(model)[0]);
      expect(model.inspectPosition(model.series()[0]!.key, 1)!.points[0]!.text).toMatch(
        /^0 – 10: cumulative /,
      );
      expect(describeChart(model)).toContain("bars are cumulative from 0");
    },
  );

  it("normalizes probability and weights finite observations before filtering explicit bins, including hidden series", () => {
    const data = table({
      v: [0, 1, 3, 100, Number.NaN, Infinity, 3, 3],
      g: ["a", "a", "a", "a", "a", "a", "b", "b"],
    });
    for (const normalize of ["probability", "percent", "density"] as const) {
      const { model } = build({
        marks: [
          histogram(data, { x: "v", bins: [0, 2, 4], series: "g", normalize, commonNorm: true }),
        ],
      });
      const factor = normalize === "percent" ? 100 : normalize === "density" ? 0.5 : 1;
      expect(values(model)[0]![0]).toBeCloseTo((((2 / 3) * 4) / 6) * factor);
      expect(values(model)[0]![1]).toBeCloseTo((((1 / 3) * 4) / 6) * factor);
      expect(values(model)[1]![1]).toBeCloseTo((2 / 6) * factor);
      const before = values(model);
      model.hidden.add(model.series()[1]!.key);
      model.scene(estimateText);
      expect(values(model)).toEqual(before);
    }
    const probability = build({
      marks: [histogram(data, { x: "v", bins: [0, 2, 4], normalize: "probability" })],
    });
    expect(values(probability.model)).toEqual([[2 / 5, 3 / 5]]);
  });

  it("uses zero for empty normalized series and cumulative density with overflowing bin width", () => {
    const data = table({ v: [Number.NaN, 100], g: ["a", "b"] });
    const { model } = build({
      marks: [
        histogram(data, {
          x: "v",
          bins: [0, 1, 2],
          series: "g",
          normalize: "density",
          commonNorm: true,
          cumulative: true,
        }),
      ],
    });
    expect(values(model)).toEqual([
      [0, 0],
      [0, 0],
    ]);
    const wide = build({
      marks: [
        histogram(table({ v: [-1e308, 1e308] }), {
          x: "v",
          bins: [-1e308, 1e308],
          normalize: "density",
          cumulative: true,
        }),
      ],
    });
    expect(values(wide.model)).toEqual([[1]]);
  });

  it.each([false, true])(
    "dodges opaque visible series within each bin and regroups when hidden (horizontal %s)",
    (horizontal) => {
      const data = table({ v: [1, 1, 3, 3], g: ["a", "b", "a", "b"] });
      const mark = histogram(data, {
        ...(horizontal ? { y: "v" } : { x: "v" }),
        bins: [0, 2, 4],
        series: "g",
        dodge: true,
      });
      const { model, scene } = build({ marks: [mark] });
      const [a, b] = rectangles(scene);
      expect(a!.fillOpacity).toBe(1);
      expect(b!.fillOpacity).toBe(1);
      const position = horizontal ? 1 : 0;
      const width = horizontal ? 3 : 2;
      expect(b!.rects[position]!).toBeCloseTo(a!.rects[position]! + a!.rects[width]!, 4);
      expect(model.inspectPosition(model.series()[0]!.key, 0)!.points).toHaveLength(2);
      const before = a!.rects[width]!;
      model.hidden.add(model.series()[1]!.key);
      const regrouped = rectangles(model.scene(estimateText));
      expect(regrouped).toHaveLength(1);
      expect(regrouped[0]!.rects[width]!).toBeCloseTo(before * 2, 4);
    },
  );

  it.each(["shared", "independent", "rows", "columns"] as ScaleResolution[])(
    "chooses facet bins per y group (%s) independently of x grouping",
    (resolution) => {
      const data = table({
        v: [0, 2, 100, 102, 20, 22, 120, 122],
        r: ["a", "a", "a", "a", "b", "b", "b", "b"],
        c: ["a", "a", "b", "b", "a", "a", "b", "b"],
      });
      const { model } = build({
        marks: [histogram(data, { y: "v", bins: { step: 10 } })],
        facet: facet({ row: "r", column: "c" }),
        resolve: { x: "independent", y: resolution },
      });
      const centers = model.panels().map((p) => [...model.panelSeries(p.key)[0]!.y]);
      if (resolution === "shared")
        expect(centers.every((c) => JSON.stringify(c) === JSON.stringify(centers[0]))).toBe(true);
      if (resolution === "rows") {
        expect(centers[0]).toEqual(centers[1]);
        expect(centers[2]).toEqual(centers[3]);
        expect(centers[0]).not.toEqual(centers[2]);
      }
      if (resolution === "columns") {
        expect(centers[0]).toEqual(centers[2]);
        expect(centers[1]).toEqual(centers[3]);
        expect(centers[0]).not.toEqual(centers[1]);
      }
      if (resolution === "independent")
        expect(new Set(centers.map((c) => JSON.stringify(c))).size).toBe(4);
    },
  );

  it("shares exact edges across facets, keeps commonNorm panel-local, and keeps absent dodge series' room", () => {
    const data = table({
      v: [1, 1, 3, 3, 3],
      g: ["a", "b", "a", "a", "a"],
      f: ["p", "p", "q", "q", "q"],
    });
    const { model, scene } = build({
      marks: [
        histogram(data, {
          y: "v",
          bins: [0, 2, 4],
          series: "g",
          commonNorm: true,
          normalize: "probability",
          dodge: true,
        }),
      ],
      facet: facet("f"),
      resolve: { y: "independent" },
    });
    expect(model.panelSeries("p").map((s) => [...s.values])).toEqual([
      [0.5, 0],
      [0.5, 0],
    ]);
    expect(model.panelSeries("q").map((s) => [...s.values])).toEqual([[0, 1], []]);
    const first = scene.panels[0]!.marks.find((m) => m.kind === "rect") as RectGeometry;
    const second = scene.panels[1]!.marks.find((m) => m.kind === "rect") as RectGeometry;
    // As grouped bars do, a series without rows in a panel keeps its share of each bin.
    expect(second.rects[3]!).toBeCloseTo(first.rects[3]!, 4);
    model.hidden.add(model.series().find((s) => s.label === "b")!.key);
    model.scene(estimateText);
    expect([...model.panelSeries("p")[0]!.values]).toEqual([0.5, 0]);
  });

  it.each(["shared", "independent", "rows", "columns"] as ScaleResolution[])(
    "renders horizontal histograms in subplots with %s y scales",
    (resolution) => {
      const data = table({ v: [0, 1, 2] });
      const { model } = build({
        marks: [histogram(data, { y: "v", bins: [0, 1, 3], panel: "*" })],
        panels: panels([{ id: "p" }, { id: "q" }], { columns: 2 }),
        resolve: { y: resolution },
      });
      for (const panel of model.panels()) {
        expect([...model.panelSeries(panel.key)[0]!.y]).toEqual([0.5, 2]);
        expect(panel.y.domain).toEqual([0, 3]);
      }
    },
  );
  it("does not inspect a horizontal bin whose edges cannot be drawn on a log y scale", () => {
    const { model, scene } = build({
      marks: [histogram(table({ v: [0.5, 2, 4] }), { y: "v", bins: [0, 1, 3, 5] })],
      y: { type: "log" },
    });
    expect(rectangles(scene)[0]!.count).toBe(2);
    expect(model.yScale()!.domain[0]).toBeGreaterThan(0);
    expect(model.inspectPosition(model.series()[0]!.key, 0)).toBeUndefined();
    expect(model.inspectPosition(model.series()[0]!.key, 1)!.points[0]!.text).toBe("1 – 3: 1");
  });

  it("refuses untyped invalid orientation and layout forms at construction", () => {
    const data = table({ v: [1] });
    for (const [spec, error] of [
      [{ type: "histogram" }, /exactly one field/],
      [{ type: "histogram", x: "v", y: "v" }, /exactly one field/],
      [{ type: "histogram", y: "v", axis: "right" }, /right axis/],
      [{ type: "histogram", x: "v", dodge: true, stack: true }, /dodge and stack/],
      [{ type: "histogram", x: "v", commonNorm: 1 }, /boolean/],
      [{ type: "histogram", x: "v", cumulative: "yes" }, /boolean/],
      [{ type: "histogram", x: "v", dodge: "yes" }, /boolean/],
      [{ type: "histogram", x: "v", normalize: "fraction" }, /normalize/],
    ] as const) {
      // @ts-expect-error these inputs also fail at compile time
      expect(() => new HistogramMark(spec, data)).toThrow(error);
    }
  });

  it("accumulates integer counts before division so the last probability is exactly one", () => {
    const { model } = build({
      marks: [
        histogram(table({ v: Array.from({ length: 10 }, (_, i) => i) }), {
          x: "v",
          bins: Array.from({ length: 11 }, (_, i) => i),
          normalize: "density",
          cumulative: true,
        }),
      ],
    });
    expect(values(model)[0]![9]).toBe(1);
  });
  it("starts horizontal lengths at the low value of a reversed logarithmic x axis", () => {
    const { model, scene } = build({
      marks: [histogram(table({ v: [1, 1, 3] }), { y: "v", bins: [0, 2, 4] })],
      x: { type: "log", domain: [10, 0.1] },
    });
    const x = model.xScale()!;
    const rect = rectangles(scene)[0]!.rects;
    expect(rect[0]).toBeCloseTo(x.map(2), 4);
    expect(rect[0]! + rect[2]!).toBeCloseTo(x.map(0.1), 4);
  });

  it.each([false, true])(
    "keeps representable density when finite explicit edges have an overflowing span (horizontal %s)",
    (horizontal) => {
      const { model } = build({
        marks: [
          histogram(table({ v: [0] }), {
            ...(horizontal ? { y: "v" } : { x: "v" }),
            bins: [-1e308, 1e308],
            normalize: "density",
          }),
        ],
      });
      expect(values(model)[0]![0]).toBe(5e-309);
    },
  );
});
