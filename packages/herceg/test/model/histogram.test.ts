// Histograms: counts of a field's values in round bins.
import { describe, expect, it } from "vitest";
import { time } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { histogram } from "../../src/marks/histogram.ts";
import { line } from "../../src/marks/line.ts";
import { describeChart } from "../../src/model/describe.ts";
import { facet } from "../../src/model/facet.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { renderToSVG } from "../../src/render/static.ts";
import type { Panel, RectGeometry } from "../../src/scene/scene.ts";
import { loadSpec } from "../../src/spec/load.ts";

function build(config: ChartConfig, width = 600, height = 300) {
  const model = new ChartModel({ locale: "en-US", timeZone: "UTC", ...config });
  model.setSize(width, height, 1);
  return { model, scene: model.scene(estimateText) };
}

const rects = (panel: Panel) => panel.marks.filter((m): m is RectGeometry => m.kind === "rect");
/** Bin centers and counts of each series, read from the model. */
const bars = (model: ChartModel) =>
  model.series().map((s) => ({
    centers: Array.from(s.x.subarray(0, s.length)),
    values: Array.from(s.values.subarray(0, s.length)),
  }));

describe("histograms", () => {
  it("count values in round bins, the last bin holding its right edge", () => {
    const values = table({ v: [0, 1, 4, 5, 9.99, 10, 10, Number.NaN, Infinity] });
    const { model } = build({ marks: [histogram(values, { x: "v", bins: 2 })] });
    const [only] = bars(model);
    // Edges 0, 5, 10: [0, 5) holds 0, 1, 4; [5, 10] holds 5, 9.99, 10, 10.
    expect(only!.centers).toEqual([2.5, 7.5]);
    expect(only!.values).toEqual([3, 4]);
    expect(model.yScale()!.domain[0]).toBe(0);
    expect(model.xScale()!.domain).toEqual([0, 10]);
  });

  it("take a bin width and start, and default to a count from the data size", () => {
    const values = table({ v: Array.from({ length: 1000 }, (_, i) => i) });
    const stepped = build({
      marks: [histogram(values, { x: "v", bins: { step: 100, start: -50 } })],
    });
    const [bins] = bars(stepped.model);
    expect(bins!.centers[0]).toBe(0);
    expect(bins!.values.reduce((a, b) => a + b)).toBe(1000);
    // Sturges: about log2(1000) + 1 = 11 bins, on round edges.
    const auto = build({ marks: [histogram(values, { x: "v" })] });
    const [counted] = bars(auto.model);
    expect(counted!.centers.length).toBeGreaterThanOrEqual(5);
    expect(counted!.centers.length).toBeLessThanOrEqual(20);
    expect(counted!.centers[1]! - counted!.centers[0]!).toBe(100);
  });

  it("bin times by calendar intervals and report bin ranges in tooltips", () => {
    const day = 86_400_000;
    const start = Date.UTC(2026, 0, 1);
    const at = table({
      t: time(Array.from({ length: 30 }, (_, i) => start + i * day + 3_600_000)),
    });
    const { scene, model } = build({ marks: [histogram(at, { x: "t", bins: 30 })] });
    const [days] = bars(model);
    expect(days!.centers[1]! - days!.centers[0]!).toBe(day);
    const hit = model.inspect(model.xScale()!.map(days!.centers[0]!), scene.panels[0]!.plot.y + 5)!;
    expect(hit.points[0]!.text).toMatch(/Jan 1.* – .*Jan 2.*: 1$/);
  });

  it("measure percent or density, overlay series translucently, or stack them", () => {
    const groups = table({ v: [1, 1, 2, 8, 9], g: ["a", "a", "a", "b", "b"] });
    const percent = build({
      marks: [histogram(groups, { x: "v", series: "g", bins: 2, normalize: "percent" })],
    });
    expect(bars(percent.model).map((b) => b.values)).toEqual([
      [100, 0],
      [0, 100],
    ]);
    expect(rects(percent.scene.panels[0]!).map((r) => r.fillOpacity)).toEqual([0.5, 0.5]);
    const density = build({
      marks: [histogram(groups, { x: "v", bins: 2, normalize: "density" })],
    });
    const [d] = bars(density.model);
    const width = d!.centers[1]! - d!.centers[0]!;
    expect(d!.values.reduce((sum, value) => sum + value * width, 0)).toBeCloseTo(1, 9);
    // Stacked: b sits on a; hiding a drops b to zero.
    const stacked = build({
      marks: [histogram(groups, { x: "v", series: "g", bins: 2, stack: true })],
    });
    const [a, b] = stacked.model.series();
    expect(Array.from(b!.y0!)).toEqual(Array.from(a!.values));
    stacked.model.hidden.add(a!.key);
    stacked.model.scene(estimateText);
    expect(Array.from(stacked.model.series()[1]!.y0!)).toEqual([0, 0]);
  });

  it("follow table changes, draw nothing without values, and draw one bin for one value", () => {
    const live = table({ v: [1, 2] });
    const { model } = build({ marks: [histogram(live, { x: "v", bins: 1 })] });
    live.append({ v: [3, 4] });
    model.scene(estimateText);
    expect(bars(model)[0]!.values.reduce((a, b) => a + b)).toBe(4);
    const empty = build({ marks: [histogram(table({ v: [] as number[] }), { x: "v" })] });
    expect(rects(empty.scene.panels[0]!)[0]!.count).toBe(0);
    const one = build({ marks: [histogram(table({ v: [7, 7] }), { x: "v" })] });
    expect(bars(one.model)[0]).toEqual({ centers: [7], values: [2] });
  });

  it("split or repeat in faceted charts, load from specs, and draw in static SVG", () => {
    const groups = table({ v: [1, 2, 3], g: ["a", "a", "b"] });
    // A line splits the rows into panels; a repeated histogram counts them all in each.
    const counted = (repeat: boolean) => {
      const { model } = build({
        marks: [
          histogram(groups, { x: "v", bins: 2, ...(repeat && { facet: "repeat" as const }) }),
          line(groups, { x: "v", y: "v" }),
        ],
        facet: facet("g"),
      });
      return model.panels().map((p) => [...model.panelSeries(p.key)[0]!.values]);
    };
    expect(counted(false)).toEqual([
      [1, 1],
      [0, 1],
    ]);
    expect(counted(true)).toEqual([
      [1, 2],
      [1, 2],
    ]);
    const { config } = loadSpec({
      data: { t: { columns: { v: [1, 2, 3] } } },
      marks: [{ type: "histogram", x: "v", bins: { step: 1 }, normalize: "percent" }],
    });
    expect(config.marks[0]!.spec.type).toBe("histogram");
    expect(() =>
      loadSpec({
        data: { t: { columns: { v: [1] } } },
        marks: [{ type: "histogram", x: "v", bins: 0 }],
      }),
    ).toThrow(/marks\[0\]\.bins: expected a whole number of at least 1/);
    expect(() => histogram(groups, { x: "v", bins: { step: -1 } })).toThrow(/positive/);
    const svg = renderToSVG({
      width: 300,
      height: 150,
      marks: [histogram(groups, { x: "v", bins: 3 })],
    });
    expect(svg).toMatch(/<path d="M[\d.]+ [\d.]+h/);
  });

  it("put values on decimal edges in the bins they start", () => {
    const tenths = table({ v: Array.from({ length: 11 }, (_, i) => i / 10) });
    const { model } = build({
      marks: [histogram(tenths, { x: "v", bins: { step: 0.1, start: 0 } })],
    });
    // Ten bins of one value each, the last also holding 1.
    expect(bars(model)[0]!.values).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 2]);
  });

  it("cover the repeated hour when daylight saving time ends", () => {
    const at = table({
      t: time([Date.UTC(2026, 10, 1, 5), Date.UTC(2026, 10, 1, 6), Date.UTC(2026, 10, 1, 6, 15)]),
    });
    const model = new ChartModel({
      locale: "en-US",
      timeZone: "America/New_York",
      marks: [histogram(at, { x: "t", bins: 3 })],
    });
    model.setSize(600, 300, 1);
    model.scene(estimateText);
    expect(bars(model)[0]!.values.reduce((a, b) => a + b)).toBe(3);
  });

  it("place values on decimal grids in the bins they start, however the grid is shifted", () => {
    const counts = (v: number[], bins: { step: number; start: number }) =>
      bars(build({ marks: [histogram(table({ v }), { x: "v", bins })] }).model)[0]!.values;
    expect(counts([0, 0.4, 0.8, 1.2, 1.6, 2], { step: 0.4, start: 0 })).toEqual([1, 1, 1, 1, 2]);
    expect(counts([0.05, 0.15, 0.25, 0.35], { step: 0.1, start: 0.05 })).toEqual([1, 1, 2]);
    expect(counts([-0.3, -0.2, -0.1, 0], { step: 0.1, start: -0.3 })).toEqual([1, 1, 2]);
    // The value just below an edge stays in the bin before it.
    expect(counts([0, 0.3 - 2 ** -54, 0.3, 0.35], { step: 0.1, start: 0 })).toEqual([1, 0, 1, 2]);
  });

  it("count extreme values in finite, increasing bins", () => {
    const binned = (v: number[], bins?: number) => {
      const options = bins === undefined ? { x: "v" as const } : { x: "v" as const, bins };
      const { model } = build({ marks: [histogram(table({ v }), options)] });
      const [s] = model.series();
      const centers = Array.from(s!.x.subarray(0, s!.length));
      return { total: bars(model)[0]!.values.reduce((a, b) => a + b, 0), centers };
    };
    for (const [v, bins] of [
      [[1e16, 1e16], undefined],
      [[0, Number.MIN_VALUE], undefined],
      [[-1e308, 1e308], undefined],
      [[1e16, 1e16 + 2], 1000],
      [[1.7e308, 1.7e308], undefined],
    ] as const) {
      const { total, centers } = binned([...v], bins);
      expect(total).toBe(2);
      expect(centers.every(Number.isFinite)).toBe(true);
      for (let i = 1; i < centers.length; i++) expect(centers[i]!).toBeGreaterThan(centers[i - 1]!);
    }
    // The bin limit holds for the bins built, not just the count asked for.
    expect(binned([0, 1.4], 1000).centers.length).toBeLessThanOrEqual(1000);
  });

  it("keep tooltips on their own chart's bins when charts in other zones share the mark", () => {
    const start = Date.UTC(2026, 0, 1);
    const at = table({ t: time(Array.from({ length: 48 }, (_, i) => start + i * 3_600_000)) });
    const mark = histogram(at, { x: "t", bins: 2 });
    const chart = (zone: string) => {
      const model = new ChartModel({ locale: "en-US", timeZone: zone, marks: [mark] });
      model.setSize(600, 300, 1);
      return { model, scene: model.scene(estimateText) };
    };
    const utc = chart("UTC");
    const text = () =>
      utc.model.inspect(
        utc.model.xScale()!.map(utc.model.series()[0]!.x[0]!),
        utc.scene.panels[0]!.plot.y + 5,
      )!.points[0]!.text;
    const before = text();
    chart("Asia/Kolkata");
    expect(text()).toBe(before);
  });

  it("let the keyboard reach bins another series fills on a log axis", () => {
    const groups = table({ v: [1, 8], g: ["a", "b"] });
    const { model } = build({
      marks: [histogram(groups, { x: "v", series: "g", bins: 2 })],
      y: { type: "log" },
    });
    const [a] = model.series();
    const hit = model.inspectPosition(a!.key, 1)!;
    expect(hit.points.map((p) => p.label)).toEqual(["b"]);
  });

  it("choose bins from the values present, and refuse a start that is not finite", () => {
    const edges = (v: number[]) =>
      bars(build({ marks: [histogram(table({ v }), { x: "v" })] }).model)[0]!.centers.length;
    const gaps = Array.from({ length: 100_000 }, () => Number.NaN);
    expect(edges([0, 1, 2, 3, ...gaps])).toBe(edges([0, 1, 2, 3]));
    expect(() =>
      histogram(table({ v: [1] }), { x: "v", bins: { step: 1, start: Number.NaN } }),
    ).toThrow(/start must be a finite number/);
  });

  it("describe the values, bins, range, and fullest bin", () => {
    const values = table({ v: [1, 2, 2, 3, 8] });
    const { model } = build({
      marks: [histogram(values, { x: "v", bins: { step: 5, start: 0 } })],
    });
    expect(describeChart(model)).toContain(
      "v: 5 values in 2 bins from 0 to 10; the fullest, 0 – 5, holds 4.",
    );
    // Counts whatever the bars measure, and values left out.
    const clipped = table({ v: [1, 2, 2, 3, 8, Number.NaN] });
    const percent = build({
      marks: [histogram(clipped, { x: "v", bins: { step: 5, start: 2 }, normalize: "percent" })],
    });
    expect(describeChart(percent.model)).toContain(
      "v: 4 values in 2 bins from 2 to 12; the fullest, 2 – 7, holds 3; 2 missing or outside the bins.",
    );
  });

  it("align computed starts to whole steps, and keep explicit grids for single values", () => {
    const counts = (v: number[], bins: number | { step: number; start?: number }) =>
      bars(build({ marks: [histogram(table({ v }), { x: "v", bins })] }).model)[0]!.values;
    expect(counts([0.65, 0.7, 0.8, 0.9, 1], { step: 0.1 })).toEqual([1, 1, 1, 2]);
    expect(counts([0.65, 0.7, 0.8, 0.9, 1], 4)).toEqual([1, 1, 1, 2]);
    // A single value below an explicit start is left out.
    expect(counts([1, 1], { step: 1, start: 10 })).toEqual([0]);
    expect(counts([1, 1], { step: 1 })).toEqual([2]);
  });

  it("keep explicit steps finite and bounded at the ends of the number range", () => {
    const binned = (v: number[], bins: { step: number; start?: number }) => {
      const { model } = build({ marks: [histogram(table({ v }), { x: "v", bins })] });
      const [s] = model.series();
      return { total: bars(model)[0]!.values.reduce((a, b) => a + b, 0), bins: s!.length };
    };
    expect(binned([-1e308, 1e308], { step: 1, start: -1e308 }).total).toBe(2);
    expect(binned([1e308, 1.1e308], { step: 0.1 }).total).toBe(2);
    const tiny = binned([0, 1e-320], { step: Number.MIN_VALUE });
    expect(tiny.total).toBe(2);
    expect(tiny.bins).toBeLessThanOrEqual(1000);
  });

  it("leave the keyboard without a tooltip where no series has a point", () => {
    const gap = table({ x: [0, 1, 2], y: [1, Number.NaN, 2] });
    const { model } = build({ marks: [line(gap, { x: "x", y: "y" })] });
    expect(model.inspectPosition(model.series()[0]!.key, 1)).toBeUndefined();
    const two = table({ x: [0, 1, 2], y: [1, Number.NaN, 2], z: [5, 6, 7] });
    const both = build({ marks: [line(two, { x: "x", y: ["y", "z"] })] }).model;
    expect(both.inspectPosition(both.series()[0]!.key, 1)!.points.map((p) => p.value)).toEqual([6]);
  });
});
