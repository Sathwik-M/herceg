// Histograms, box plots, and violins split by facets: each panel summarizes
// its own rows, in bins of its x scale or on categories of its own.
import { describe, expect, it, vi } from "vitest";
import { category, encodedCategory, time } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { bar } from "../../src/marks/bar.ts";
import { boxplot } from "../../src/marks/boxplot.ts";
import { histogram } from "../../src/marks/histogram.ts";
import { point } from "../../src/marks/point.ts";
import type { Series } from "../../src/marks/series.ts";
import { violin } from "../../src/marks/violin.ts";
import { describeChart } from "../../src/model/describe.ts";
import { facet } from "../../src/model/facet.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { panels } from "../../src/model/panels.ts";
import { renderToSVG } from "../../src/render/static.ts";
import type { RectGeometry, Scene } from "../../src/scene/scene.ts";
import { loadSpec } from "../../src/spec/load.ts";
import type { ScaleResolution } from "../../src/spec/spec.ts";

function build(config: ChartConfig, width = 600, height = 400) {
  const model = new ChartModel({ locale: "en-US", timeZone: "UTC", ...config });
  model.setSize(width, height, 1);
  return { model, scene: model.scene(estimateText) };
}

/** Each series' bin centers and values in a panel, by series label; series without bars are []. */
function binsOf(model: ChartModel, panel: string): Record<string, { x: number[]; v: number[] }> {
  return Object.fromEntries(
    model.panelSeries(panel).map((s) => [s.label, { x: [...s.x], v: [...s.values] }]),
  );
}

/** The ends of a panel's bin edges: the extent of the bars it can draw. */
const edges = (model: ChartModel, panel: string) => model.panels().find((p) => p.key === panel)!.x;

describe("histograms split by facets", () => {
  // A's values are small and B's large. A row of A without a series value
  // (40) widens the bins as it does in one chart; a row without a facet
  // value (500) is drawn nowhere and widens nothing.
  const latency = () =>
    table({
      region: category(["A", "A", "A", "A", "B", "B", "B", null]),
      service: category(["s", "s", "t", null, "s", "s", "s", "t"]),
      ms: [1, 2, 3, 40, 11, 12, 19, 500],
    });
  const step = { step: 5 };

  it("count each panel's rows in one set of bins on a shared x", () => {
    const { model, scene } = build({
      marks: [histogram(latency(), { x: "ms", series: "service", bins: step })],
      facet: facet("region"),
    });
    const [a, b] = model.panels().map((p) => p.key);
    // Bins from 0 to 40 for every panel: rows in some panel, 500 left out.
    const centers = [2.5, 7.5, 12.5, 17.5, 22.5, 27.5, 32.5, 37.5];
    expect(binsOf(model, a!)).toEqual({
      s: { x: centers, v: [2, 0, 0, 0, 0, 0, 0, 0] },
      t: { x: centers, v: [1, 0, 0, 0, 0, 0, 0, 0] },
    });
    // B has no t: no bars for it there, rather than empty bins.
    expect(binsOf(model, b!)).toEqual({
      s: { x: centers, v: [0, 0, 2, 1, 0, 0, 0, 0] },
      t: { x: [], v: [] },
    });
    // One set of edges, shared: every panel's series read the same centers.
    const [sa] = model.panelSeries(a!);
    const [sb] = model.panelSeries(b!);
    expect(sa!.x).toBe(sb!.x);
    expect(model.panels().map((p) => p.x.domain)).toEqual([
      [0, 40],
      [0, 40],
    ]);
    // The legend lists the chart's series once, and y is shared by both panels.
    expect(scene.legend.map((entry) => entry.label)).toEqual(["s", "t"]);
    expect(model.panels()[0]!.y.domain).toEqual(model.panels()[1]!.y.domain);
  });

  it.each([
    ["independent", [0, 5], [10, 20]],
    ["shared", [0, 20], [0, 20]],
  ] as const)("choose bins from the rows of each x scale's panels (%s x)", (resolution, a, b) => {
    const data = table({
      region: category(["A", "A", "A", "B", "B", "B"]),
      ms: [1, 2, 3, 11, 12, 19],
    });
    const { model } = build({
      marks: [histogram(data, { x: "ms", bins: step })],
      facet: facet("region"),
      resolve: { x: resolution },
    });
    // From the first bin's left edge to the last one's right edge.
    const range = (panel: string) => {
      const [s] = model.panelSeries(panel);
      return [s!.x[0]! - 2.5, s!.x[s!.length - 1]! + 2.5];
    };
    expect(range("A")).toEqual(a);
    expect(range("B")).toEqual(b);
    expect(edges(model, "A").domain).toEqual(a);
    expect(edges(model, "B").domain).toEqual(b);
  });

  it("share bins along each row of panels resolved by rows", () => {
    const data = table({
      region: category(["A", "B", "C", "D"]),
      ms: [1, 9, 100, 140],
    });
    const { model } = build({
      marks: [histogram(data, { x: "ms", bins: { step: 10 } })],
      facet: facet("region", { columns: 2 }),
      resolve: { x: "rows" },
    });
    const first = (key: string) => model.panelSeries(key)[0]!.x;
    expect(first("A")).toBe(first("B"));
    expect(first("C")).toBe(first("D"));
    expect([...first("A")]).toEqual([5]);
    // 100 to 140, the last bin also holding its right edge.
    expect([...first("C")]).toEqual([105, 115, 125, 135]);
  });

  it("measure percent and density over each panel's own counts, and stack within each panel", () => {
    const data = latency();
    const percent = build({
      marks: [histogram(data, { x: "ms", series: "service", bins: step, normalize: "percent" })],
      facet: facet("region"),
    }).model;
    const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
    for (const panel of ["A", "B"])
      for (const s of percent.panelSeries(panel))
        if (s.length > 0) expect(sum([...s.values])).toBeCloseTo(100, 9);
    const density = build({
      marks: [histogram(data, { x: "ms", bins: step, normalize: "density" })],
      facet: facet("region"),
    }).model;
    for (const panel of ["A", "B"]) {
      const [s] = density.panelSeries(panel);
      expect(sum([...s!.values].map((value) => value * 5))).toBeCloseTo(1, 9);
    }
    // Stacked: in A, t sits on s; hiding s drops t to zero in every panel,
    // counting nothing again.
    const { model } = build({
      marks: [histogram(data, { x: "ms", series: "service", bins: step, stack: true })],
      facet: facet("region"),
    });
    const [s, t] = model.panelSeries("A") as [Series, Series];
    expect([...t.y0!]).toEqual([...s.values]);
    expect([...t.y].slice(0, 2)).toEqual([3, 0]);
    const counts = t.values;
    model.hidden.add(s.key);
    model.scene(estimateText);
    const [, after] = model.panelSeries("A") as [Series, Series];
    expect([...after.y0!].every((value) => value === 0)).toBe(true);
    expect([...after.values]).toEqual([...counts]);
  });

  it("report each panel's bins in tooltips, keyboard reads, and the text alternative", () => {
    const { model, scene } = build({
      marks: [histogram(latency(), { x: "ms", series: "service", bins: step })],
      facet: facet("region"),
      resolve: { x: "independent" },
    });
    const b = model.panels()[1]!;
    const inspection = model.inspect(b.x.map(12.5), scene.panels[1]!.plot.y + 5, "nearest-x", "B");
    expect(inspection).toMatchObject({ panel: "B", value: 12.5 });
    expect(inspection!.points.map((p) => [p.label, p.text, p.row])).toEqual([
      ["s", "10 – 15: 2", undefined],
    ]);
    // Series sharing bins share a keyboard stop, which reads both.
    const stops = model.keyboardStops("A");
    expect(stops.map((s) => s.label)).toEqual(["s"]);
    const read = model.inspectPosition(stops[0]!.key, 0, "A")!;
    expect(read.points.map((p) => [p.label, p.value])).toEqual([
      ["s", 2],
      ["t", 1],
    ]);
    expect(model.keyboardStops("B").map((s) => s.label)).toEqual(["s"]);
    // Every panel's counts; the fullest bar of any panel; the bins of both x scales.
    const text = describeChart(model);
    expect(text).toContain(
      "s: 5 values in the bins of 2 x scales from 0 to 40; the fullest, 0 – 5, holds 2.",
    );
    // A's bins reach its value without a series.
    expect(text).toContain("t: 1 value in 8 bins from 0 to 40; the fullest, 0 – 5, holds 1.");
  });

  it("count nothing again to redraw, and again when the table changes", () => {
    const data = latency();
    const { model } = build({
      marks: [histogram(data, { x: "ms", bins: step })],
      facet: facet("region"),
    });
    const before = model.panelSeries("B")[0]!;
    model.scene(estimateText);
    const again = model.panelSeries("B")[0]!;
    expect(again.x).toBe(before.x);
    expect(again.values).not.toBe(before.values);
    expect([...again.values]).toEqual([...before.values]);
    data.append({ region: ["B"], service: ["s"], ms: [13] });
    model.scene(estimateText);
    expect([...model.panelSeries("B")[0]!.values].slice(2, 4)).toEqual([3, 1]);
  });

  it("count every panel with one scratch array, however many values the series field has had", () => {
    // A series field whose dictionary is far larger than what is left of it.
    const size = 200_000;
    const dictionary = Array.from({ length: size }, (_, i) => `s${i}`);
    const data = table({
      region: category(Array.from({ length: 100 }, (_, i) => `r${i % 50}`)),
      service: encodedCategory(new Int32Array(100).fill(7), dictionary),
      ms: Array.from({ length: 100 }, (_, i) => i),
    });
    let large = 0;
    const Real = Int32Array;
    vi.stubGlobal(
      "Int32Array",
      class extends Real {
        constructor(...args: unknown[]) {
          super(...(args as [number]));
          if (this.length >= size) large++;
        }
      },
    );
    try {
      const { model } = build(
        {
          marks: [histogram(data, { x: "ms", series: "service", bins: step })],
          facet: facet("region"),
        },
        2000,
        1500,
      );
      expect(model.panels()).toHaveLength(50);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(large).toBe(1);
  });

  it("bin times by the chart's calendar in each panel", () => {
    const day = 86_400_000;
    const start = Date.UTC(2026, 0, 1);
    const data = table({
      region: category(["A", "A", "B", "B", "B"]),
      at: time([0, 1, 2, 2, 3].map((d) => start + d * day + 3_600_000)),
    });
    const { model, scene } = build({
      marks: [histogram(data, { x: "at", bins: 3 })],
      facet: facet("region"),
    });
    const [a] = model.panelSeries("A");
    expect(a!.x[1]! - a!.x[0]!).toBe(day);
    const hit = model.inspect(model.panels()[1]!.x.map(a!.x[2]!), scene.panels[1]!.plot.y + 5);
    expect(hit!.points[0]!.text).toMatch(/Jan 3.* – .*Jan 4.*: 2$/);
  });

  it("load from specs and render statically", () => {
    const spec = {
      version: 3 as const,
      data: {
        t: { columns: { region: ["A", "A", "B"], ms: [1, 2, 30] } },
      },
      marks: [{ type: "histogram" as const, data: "t", x: "ms", bins: { step: 10 } }],
      facet: { field: "region" },
      resolve: { x: "independent" as const },
    };
    const { config } = loadSpec(spec);
    const model = new ChartModel(config);
    model.setSize(600, 300, 1);
    model.scene(estimateText);
    expect(model.panels().map((p) => p.x.domain)).toEqual([
      [0, 10],
      [30, 40],
    ]);
    expect(renderToSVG({ ...config, width: 600, height: 300 })).toMatch(/<path d="M[\d.]+ [\d.]+h/);
  });
});

/** The value, label, and statistics text of the shape at a panel's category place, as the pointer finds them. */
function picked(model: ChartModel, panel: string, place: number, horizontal = false) {
  const view = model.panels().find((p) => p.key === panel)!;
  const [px, py] = horizontal
    ? [view.plot.x + view.plot.width / 2, view.y.map(place)]
    : [view.x.map(place), view.plot.y + view.plot.height / 2];
  const inspection = model.inspect(px, py, "nearest", panel);
  return inspection && { label: inspection.label, texts: inspection.points.map((p) => p.text) };
}

/** Where each box of a panel is centered along its category axis, by series key. */
function centers(scene: Scene, panel: number, horizontal = false): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const m of scene.panels[panel]!.marks) {
    if (m.kind !== "rect" || !m.key.endsWith("|box")) continue;
    const rect = m as RectGeometry;
    out[m.key.replace("|box", "")] = Array.from({ length: rect.count }, (_, k) => {
      const [x, y, w, h] = rect.rects.subarray(k * 4, k * 4 + 4) as unknown as number[];
      return Math.round(horizontal ? y! + h! / 2 : x! + w! / 2);
    });
  }
  return out;
}

describe("box plots and violins split by facets", () => {
  // N and S both have category b of series v1, with values far apart. N
  // has a and b, S b and c, so b is N's second category and S's first.
  const sales = () =>
    table({
      region: ["N", "S", "N", "S", "N", "S", "N", "S", "S"],
      product: ["a", "b", "a", "b", "a", "b", "b", "c", "b"],
      version: ["v1", "v1", "v1", "v1", "v1", "v1", "v1", "v2", "v2"],
      units: [1, 100, 2, 200, 3, 300, 10, 5, 7],
    });

  it("summarize each panel's rows apart, though panels share categories", () => {
    const { model } = build({
      marks: [boxplot(sales(), { x: "product", y: "units" })],
      facet: facet("region"),
    });
    expect(model.panels().map((p) => p.x.categories)).toEqual([
      ["a", "b", "c"],
      ["a", "b", "c"],
    ]);
    expect(picked(model, "N", 1)).toEqual({
      label: "b",
      texts: ["median 10, quartiles 10 to 10, whiskers 10 to 10, 1 value"],
    });
    expect(picked(model, "S", 1)).toEqual({
      label: "b",
      texts: ["median 150, quartiles 76.75 to 225, whiskers 7 to 300, 4 values"],
    });
    expect(describeChart(model)).toContain("units: 4 boxes, medians from 2 (a) to 150 (b).");
  });

  it.each(["independent", "columns"] as ScaleResolution[])(
    "place each panel's boxes on categories of its own (%s)",
    (resolution) => {
      const { model, scene } = build({
        marks: [boxplot(sales(), { x: "product", y: "units", series: "version" })],
        facet: facet("region"),
        resolve: { x: resolution },
      });
      expect(model.panels().map((p) => p.x.categories)).toEqual([
        ["a", "b"],
        ["b", "c"],
      ]);
      // Place 0 is a in N and b in S.
      expect(picked(model, "N", 1)!.label).toBe("b");
      expect(picked(model, "N", 1)!.texts[0]).toMatch(/^median 10,/);
      expect(picked(model, "S", 0)!.label).toBe("b");
      expect(picked(model, "S", 0)!.texts[0]).toMatch(/^median 200,/);
      // v2 is only in S, yet keeps its slot in N, as grouped bars do: N's
      // v1 boxes sit left of their categories' centers.
      const n = model.panels()[0]!;
      const v1 = '[0,"v1"]';
      expect(centers(scene, 0)[v1]).toEqual(
        [0, 1].map((i) => Math.round(n.x.map(i) - n.x.bandwidth! / 4)),
      );
      expect(centers(scene, 0)['[0,"v2"]']).toBeUndefined();
      expect(centers(scene, 1)['[0,"v2"]']).toHaveLength(2);
      // The keyboard reads each panel's own places.
      const stops = model.keyboardStops("S");
      expect(stops.map((s) => s.label)).toEqual(["v1", "v2"]);
      // v2's second box in S is c's, at S's second place.
      const read = model.inspectPosition(stops[1]!.key, 1, "S")!;
      expect(read).toMatchObject({ panel: "S", value: 1, label: "c" });
      expect(read.points.map((p) => [p.label, p.value, p.row])).toEqual([["v2", 5, undefined]]);
      expect(describeChart(model)).toContain("v1: 3 boxes, medians from 2 (a) to 200 (b).");
    },
  );

  it("list series as one chart does, keeping every series' slot in every panel", () => {
    // The first category has values of y only: one chart lists y first,
    // though x comes first in the series field.
    const data = table({
      region: ["P", "P", "P", "Q"],
      product: ["a", "a", "b", "b"],
      version: ["x", "y", "x", "x"],
      units: [Number.NaN, 1, 2, 3],
    });
    const one = build({ marks: [boxplot(data, { x: "product", y: "units", series: "version" })] });
    const split = build({
      marks: [boxplot(data, { x: "product", y: "units", series: "version" })],
      facet: facet("region"),
    });
    expect(one.scene.legend.map((entry) => entry.label)).toEqual(["y", "x"]);
    expect(split.scene.legend.map((entry) => entry.label)).toEqual(["y", "x"]);
    expect(split.model.panelSeries("Q").map((s) => [s.label, s.length])).toEqual([
      ["y", 0],
      ["x", 1],
    ]);
  });

  it("place horizontal boxes on y categories of each panel's own, in facets and subplots", () => {
    const { model, scene } = build({
      marks: [boxplot(sales(), { x: "units", y: "product" })],
      facet: facet("region"),
      resolve: { y: "independent" },
    });
    expect(model.panels().map((p) => p.y.categories)).toEqual([
      ["a", "b"],
      ["b", "c"],
    ]);
    expect(picked(model, "S", 0, true)!.label).toBe("b");
    expect(picked(model, "S", 0, true)!.texts[0]).toMatch(/^median 150,/);
    expect(Object.values(centers(scene, 1, true))[0]).toHaveLength(2);
    // Subplots draw whole marks, each on its own y categories by default.
    const data = sales();
    const sub = build({
      marks: [
        boxplot(data, { x: "units", y: "product", panel: "low" }),
        violin(data, { x: "units", y: "region", panel: "high" }),
      ],
      panels: panels([{ id: "low" }, { id: "high" }]),
    }).model;
    expect(sub.panels().map((p) => p.y.categories)).toEqual([
      ["a", "b", "c"],
      ["N", "S"],
    ]);
    expect(picked(sub, "high", 1, true)!.label).toBe("S");
  });

  it("split violins by panel, each with its own density", () => {
    const { model } = build({
      marks: [violin(sales(), { x: "product", y: "units" })],
      facet: facet("region"),
      resolve: { x: "independent" },
    });
    expect(picked(model, "N", 1)!.texts).toEqual([
      "median 10, quartiles 10 to 10, values from 10 to 10, 1 value",
    ]);
    expect(picked(model, "S", 0)!.texts).toEqual([
      "median 150, quartiles 76.75 to 225, values from 7 to 300, 4 values",
    ]);
    // Each panel's y domain is the chart's: it reaches S's density, not N's.
    expect(model.panels()[0]!.y.domain[1]).toBeGreaterThanOrEqual(300);
    expect(describeChart(model)).toContain("units: 4 violins, medians from 2 (a) to 150 (b).");
  });

  it("repeat whole in every panel with facet: repeat, each panel holding every category", () => {
    const data = sales();
    const { model } = build({
      marks: [
        boxplot(data, { x: "product", y: "units", facet: "repeat" }),
        point(data, { x: "product", y: "units" }),
      ],
      facet: facet("region"),
      resolve: { x: "independent" },
    });
    expect(model.panels().map((p) => p.x.categories)).toEqual([
      ["a", "b", "c"],
      ["a", "b", "c"],
    ]);
    // Every panel's boxes are the whole table's: b's are 7, 10, 100, 200, and 300.
    const [boxes] = model.keyboardStops("N");
    const read = model.inspectPosition(boxes!.key, 1, "N")!;
    expect(read.points[0]!.text).toMatch(/^median 100,/);
  });

  it("keep each chart's placement of a mark that charts share with other categories", () => {
    const data = sales();
    const boxes = boxplot(data, { x: "product", y: "units" });
    const goals = table({ product: ["c", "b", "a"], goal: [1, 2, 3] });
    // The second chart's axis lists c, b, a: the boxes' bands move.
    const first = build({ marks: [boxes] }).model;
    const second = build({ marks: [bar(goals, { x: "product", y: "goal" }), boxes] }).model;
    const placed = (model: ChartModel) => model.panelSeries("")[model === first ? 0 : 1]!.x;
    const before = placed(first);
    expect([...before]).toEqual([0, 1, 2]);
    expect([...placed(second)]).toEqual([2, 1, 0]);
    first.scene(estimateText);
    second.scene(estimateText);
    first.scene(estimateText);
    expect(placed(first)).toBe(before);
  });
});
