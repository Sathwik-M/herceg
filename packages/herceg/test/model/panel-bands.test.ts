// Categories resolved per panel: facets and subplots whose category axes
// hold only the categories each panel, row, or column of panels draws.
import { describe, expect, it } from "vitest";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { bar } from "../../src/marks/bar.ts";
import { candlestick } from "../../src/marks/candlestick.ts";
import { errorBar } from "../../src/marks/errorbar.ts";
import { rule } from "../../src/marks/rule.ts";
import { facet } from "../../src/model/facet.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { panels } from "../../src/model/panels.ts";
import { renderToSVG } from "../../src/render/static.ts";
import type { RectGeometry, Scene, SegmentGeometry } from "../../src/scene/scene.ts";
import { loadSpec } from "../../src/spec/load.ts";
import type { ScaleScope } from "../../src/spec/spec.ts";
import { positionOf, stopsOf } from "../helpers/keyboard.ts";

function build(config: ChartConfig, width = 600, height = 400) {
  const model = new ChartModel({ locale: "en-US", timeZone: "UTC", ...config });
  model.setSize(width, height, 1);
  return { model, scene: model.scene(estimateText) };
}

// Panels hold different products, so a product's band index differs from
// panel to panel and one index names different products: N has b and d, S
// a and c, E c and d, in the chart's order b, a, c, d. Rows of a panel are
// not next to each other.
const sales = () =>
  table({
    region: ["N", "S", "E", "N", "S", "E", "N", "S"],
    product: ["b", "a", "c", "d", "c", "d", "b", "a"],
    kind: ["p", "p", "q", "q", "p", "q", "q", "q"],
    units: [1, 2, 3, 4, 5, 6, 7, -8],
  });

interface Bar {
  key: string;
  category: string;
  from: number;
  to: number;
}

/** Each bar a panel draws: its series, category, and value ends, read back through the panel's scales. */
function barsOf(model: ChartModel, scene: Scene, panel: number, horizontal = false): Bar[] {
  const { x, y } = model.panels()[panel]!;
  const [along, across] = horizontal ? [y, x] : [x, y];
  // Rounded, and without -0.
  const round = (value: number) => Math.round(value * 1000) / 1000 + 0;
  return scene.panels[panel]!.marks.filter((m): m is RectGeometry => m.kind === "rect").flatMap(
    (rect) =>
      Array.from({ length: rect.count }, (_, k) => {
        const [left, top, width, height] = rect.rects.subarray(k * 4, k * 4 + 4) as unknown as [
          number,
          number,
          number,
          number,
        ];
        const center = horizontal ? top + height / 2 : left + width / 2;
        const ends = horizontal ? [left, left + width] : [top + height, top];
        const [a, b] = ends.map((pixel) => round(across.invert(pixel))) as [number, number];
        return {
          key: rect.key,
          category: along.categories![Math.round(along.invert(center))]!,
          from: Math.min(a, b),
          to: Math.max(a, b),
        };
      }),
  );
}

/** Rows of error bars a panel's region, product, and ends; each panel holds two products. */
const intervals = () =>
  table({
    region: ["N", "S", "E", "N", "S", "E"],
    product: ["b", "a", "c", "d", "c", "d"],
    low: [1, 2, 3, 4, 5, 6],
    high: [2, 3, 4, 5, 6, 7],
  });

/** Each error bar's category and ends a panel draws, read from its stem (the first of its segments). */
function stemsOf(model: ChartModel, scene: Scene, panel: number, horizontal = false) {
  const { x, y } = model.panels()[panel]!;
  const [along, across] = horizontal ? [y, x] : [x, y];
  const segments = scene.panels[panel]!.marks.filter(
    (m): m is SegmentGeometry => m.kind === "segments",
  );
  return segments.flatMap((m) =>
    Array.from({ length: m.count / 3 }, (_, k) => {
      const [x1, y1, x2, y2] = m.coords.subarray(k * 12, k * 12 + 4) as unknown as number[];
      const [at, from, to] = horizontal ? [y1!, x1!, x2!] : [x1!, y1!, y2!];
      const ends = [across.invert(from), across.invert(to)].map((v) => Math.round(v * 1e6) / 1e6);
      return [
        along.categories![Math.round(along.invert(at))],
        Math.min(...ends),
        Math.max(...ends),
      ];
    }),
  );
}

const categories = (model: ChartModel, axis: "x" | "y" = "x") =>
  model.panels().map((panel) => panel[axis].categories);

const ticks = (scene: Scene, panel: number, orient: "bottom" | "left") =>
  scene.panels[panel]!.axes.find((a) => a.side === orient)?.ticks.map((t) => t.label);

describe("categories resolved per panel", () => {
  it("give each panel the categories its rows hold, in the chart's order", () => {
    const { model, scene } = build({
      marks: [bar(sales(), { x: "product", y: "units" })],
      facet: facet("region"),
      x: { scope: "panel" },
    });
    expect(categories(model)).toEqual([
      ["b", "d"],
      ["a", "c"],
      ["c", "d"],
    ]);
    // Every panel labels its own categories, and draws each bar at its own.
    expect([0, 1, 2].map((i) => ticks(scene, i, "bottom"))).toEqual([
      ["b", "d"],
      ["a", "c"],
      ["c", "d"],
    ]);
    expect(barsOf(model, scene, 2)).toEqual([
      { key: '[0,"units"]', category: "c", from: 0, to: 3 },
      { key: '[0,"units"]', category: "d", from: 0, to: 6 },
    ]);
    expect(barsOf(model, scene, 1).map((b) => [b.category, b.to])).toEqual([
      ["a", 2],
      ["c", 5],
      ["a", 0],
    ]);
    expect(barsOf(model, scene, 1)[2]!.from).toBe(-8);
    // Panels are as wide as each other whatever they hold, so bands of
    // panels with as many categories are as wide too.
    const [n, , e] = model.panels();
    expect(n!.x.bandwidth).toBeCloseTo(e!.x.bandwidth!, 6);
  });

  it("keep shared categories as before: every panel has all of them", () => {
    const { model, scene } = build({
      marks: [bar(sales(), { x: "product", y: "units" })],
      facet: facet("region"),
    });
    const lists = categories(model);
    expect(lists[0]).toEqual(["b", "a", "c", "d"]);
    // One list for every panel, as before.
    expect(lists.every((list) => list === lists[0])).toBe(true);
    expect(barsOf(model, scene, 2).map((b) => b.category)).toEqual(["c", "d"]);
    expect(model.panels().map((p) => p.xGroup)).toEqual(["", "", ""]);
  });

  it.each([
    [
      "row",
      [
        ["b", "a", "c", "d"],
        ["b", "a", "c", "d"],
        ["c", "d"],
      ],
    ],
    [
      "column",
      [
        ["b", "c", "d"],
        ["a", "c"],
        ["b", "c", "d"],
      ],
    ],
    [
      "panel",
      [
        ["b", "d"],
        ["a", "c"],
        ["c", "d"],
      ],
    ],
  ] as const)("share categories among the panels of a resolution: %s", (x, expected) => {
    const { model, scene } = build({
      marks: [bar(sales(), { x: "product", y: "units" })],
      facet: facet("region", { columns: 2 }),
      x: { scope: x as ScaleScope },
    });
    expect(categories(model)).toEqual(expected);
    // Panels sharing a scale share one list, and only they do.
    const panels = model.panels();
    for (const a of panels)
      for (const b of panels) expect(a.x.categories === b.x.categories).toBe(a.xGroup === b.xGroup);
    for (const [i, list] of expected.entries())
      for (const b of barsOf(model, scene, i)) expect(list).toContain(b.category);
  });

  it("report each panel's category, value, and source row in tooltips and keyboard reads", () => {
    const data = sales();
    const { model, scene } = build({
      marks: [bar(data, { x: "product", y: "units" })],
      facet: facet("region"),
      x: { scope: "panel" },
    });
    // E's first band is c (row 2), which is S's second.
    const e = scene.panels[2]!;
    const { x } = model.panels()[2]!;
    const inspection = model.inspect(x.map(0), e.plot.y + e.plot.height - 1, "nearest-x");
    expect(inspection).toMatchObject({ panel: "E", value: 0, label: "c" });
    expect(inspection!.points.map((p) => [p.row, p.value])).toEqual([[2, 3]]);
    expect(data.value("product" as never, 2)).toBe("c");
    // Pointed at by the nearest point, and read by the keyboard, alike.
    const nearest = model.inspect(x.map(1), e.plot.y + e.plot.height / 2, "nearest");
    expect(nearest).toMatchObject({ value: 1, label: "d" });
    expect(nearest!.points.map((p) => p.row)).toEqual([5]);
    const [stop] = stopsOf(model, "S");
    const read = positionOf(model, stop!.key, 1, "S");
    expect(read).toMatchObject({ panel: "S", value: 1, label: "c" });
    expect(read!.points.map((p) => p.row)).toEqual([4]);
    // Values are formatted as the panel's axis names its bands.
    expect(model.formatsOf(undefined, "N").x(1)).toBe("d");
    expect(model.formatsOf(undefined, "S").x(1)).toBe("c");
  });

  it("place horizontal bars on y categories of each panel's own", () => {
    const { model, scene } = build({
      marks: [bar(sales(), { x: "units", y: "product", series: "kind", stack: true })],
      facet: facet("region"),
      y: { scope: "panel" },
    });
    expect(categories(model, "y")).toEqual([
      ["b", "d"],
      ["a", "c"],
      ["c", "d"],
    ]);
    // Every panel labels its own categories.
    expect([0, 1, 2].map((i) => ticks(scene, i, "left"))).toEqual([
      ["b", "d"],
      ["a", "c"],
      ["c", "d"],
    ]);
    expect(barsOf(model, scene, 0, true)).toEqual([
      { key: '[0,"p"]', category: "b", from: 0, to: 1 },
      { key: '[0,"q"]', category: "d", from: 0, to: 4 },
      { key: '[0,"q"]', category: "b", from: 1, to: 8 },
    ]);
    const s = scene.panels[1]!;
    const { y } = model.panels()[1]!;
    const inspection = model.inspect(s.plot.x + 5, y.map(0), "nearest-y");
    expect(inspection).toMatchObject({ axis: "y", value: 0, label: "a", panel: "S" });
    expect(inspection!.points.map((p) => [p.row, p.value])).toEqual([
      [1, 2],
      [7, -8],
    ]);
  });

  it.each(["chart", "panel"] as const)(
    "stack bars within their panel, by category and sign (%s categories)",
    (x) => {
      const { model, scene } = build({
        marks: [bar(sales(), { x: "product", y: "units", series: "kind", stack: true })],
        facet: facet("region"),
        x: { scope: x },
      });
      const stacks = [0, 1, 2].map((i) =>
        barsOf(model, scene, i).map(({ key, category, from, to }) => [key, category, from, to]),
      );
      expect(stacks).toEqual([
        [
          ['[0,"p"]', "b", 0, 1],
          ['[0,"q"]', "d", 0, 4],
          ['[0,"q"]', "b", 1, 8],
        ],
        [
          ['[0,"p"]', "a", 0, 2],
          ['[0,"p"]', "c", 0, 5],
          // Negative values stack down from zero on their own.
          ['[0,"q"]', "a", -8, 0],
        ],
        // E's c does not stack on S's.
        [
          ['[0,"q"]', "c", 0, 3],
          ['[0,"q"]', "d", 0, 6],
        ],
      ]);
      // Tooltips report values, not stack ends.
      const { x: scale } = model.panels()[0]!;
      const inspection = model.inspect(scale.map(0), scene.panels[0]!.plot.y + 5, "nearest-x");
      expect(inspection!.points.map((p) => [p.label, p.value])).toEqual([
        ["p", 1],
        ["q", 7],
      ]);
    },
  );

  it.each(["chart", "panel"] as const)(
    "inspect horizontal stacks by their ends, which need not ascend as lengths do (%s)",
    (y) => {
      // One panel: its categories are the chart's, at their own places.
      const data = table({ region: ["N", "N"], category: ["A", "B"], u: [100, 1], v: [1, 2] });
      const { model } = build({
        marks: [bar(data, { x: ["u", "v"], y: "category", stack: true })],
        facet: facet("region"),
        y: { scope: y },
      });
      const { x, y: scale } = model.panels()[0]!;
      for (const mode of ["nearest", "nearest-x"] as const) {
        const inspection = model.inspect(x.map(101), scale.map(0), mode);
        expect(inspection!.points.map((p) => p.label)).toContain("v");
      }
    },
  );

  it("stack duplicate rows of a category on each other, and each field of wide data", () => {
    const wide = table({
      region: ["N", "N", "S"],
      product: ["a", "a", "a"],
      x: [1, 2, 3],
      y: [10, 20, 30],
    });
    const { model, scene } = build({
      marks: [bar(wide, { x: "product", y: ["x", "y"], stack: true })],
      facet: facet("region"),
      x: { scope: "panel" },
    });
    expect(barsOf(model, scene, 0).map((b) => [b.key, b.from, b.to])).toEqual([
      ['[0,"x"]', 0, 1],
      ['[0,"x"]', 1, 3],
      ['[0,"y"]', 3, 13],
      ['[0,"y"]', 13, 33],
    ]);
    expect(barsOf(model, scene, 1).map((b) => [b.key, b.from, b.to])).toEqual([
      ['[0,"x"]', 0, 3],
      ['[0,"y"]', 3, 33],
    ]);
  });

  it("slot grouped bars by the chart's series, and keep categories when series hide", () => {
    const config: ChartConfig = {
      marks: [bar(sales(), { x: "product", y: "units", series: "kind" })],
      facet: facet("region"),
      x: { scope: "panel" },
    };
    const { model, scene } = build(config);
    // N's d has only q, which keeps its slot to the right of p's.
    const rects = (s: Scene, panel: number) =>
      s.panels[panel]!.marks.filter((m): m is RectGeometry => m.kind === "rect");
    const [p, q] = rects(scene, 0);
    const { x } = model.panels()[0]!;
    expect(p!.rects[0]! + p!.rects[2]! / 2).toBeLessThan(x.map(0));
    expect(q!.rects[0]! + q!.rects[2]! / 2).toBeGreaterThan(x.map(1));
    // Hiding p gives q whole slots in every panel, and moves no category.
    model.hidden.add('[0,"p"]');
    const hidden = model.scene(estimateText);
    expect(categories(model)).toEqual([
      ["b", "d"],
      ["a", "c"],
      ["c", "d"],
    ]);
    const [shown] = rects(hidden, 0).filter((r) => r.key === '[0,"q"]');
    expect(shown!.rects[0]! + shown!.rects[2]! / 2).toBeCloseTo(x.map(1), 3);
    // The legend lists each series once.
    expect(model.legendEntries().map((e) => e.label)).toEqual(["p", "q"]);
  });

  it("stack hidden series as zero, keeping their categories", () => {
    const { model } = build({
      marks: [bar(sales(), { x: "product", y: "units", series: "kind", stack: true })],
      facet: facet("region"),
      x: { scope: "panel" },
    });
    model.hidden.add('[0,"p"]');
    const scene = model.scene(estimateText);
    expect(categories(model)[0]).toEqual(["b", "d"]);
    expect(barsOf(model, scene, 0).map((b) => [b.category, b.from, b.to])).toEqual([
      ["d", 0, 4],
      ["b", 0, 7],
    ]);
  });

  it("give empty panels of a grid empty category axes", () => {
    const { model, scene } = build({
      marks: [bar(sales(), { x: "product", y: "units" })],
      facet: facet({ row: "region", column: "kind" }),
      x: { scope: "panel" },
    });
    expect(model.panels().map((p) => p.key)).toEqual([
      '["N","p"]',
      '["N","q"]',
      '["S","p"]',
      '["S","q"]',
      '["E","p"]',
      '["E","q"]',
    ]);
    // N's q rows hold d, then b, which keep the chart's order.
    expect(categories(model)).toEqual([["b"], ["b", "d"], ["a", "c"], ["a"], [], ["c", "d"]]);
    // E has no p rows: no bands, no labels, no bars.
    expect(ticks(scene, 4, "bottom")).toEqual([]);
    expect(barsOf(model, scene, 4)).toEqual([]);
  });

  it("count a repeated mark's categories in every panel", () => {
    const targets = table({ product: ["a", "e"], goal: [3, 3] });
    const { model, scene } = build({
      marks: [
        bar(sales(), { x: "product", y: "units" }),
        bar(targets, { x: "product", y: "goal", facet: "repeat" }),
        rule({ y: 4 }),
      ],
      facet: facet("region"),
      x: { scope: "panel" },
    });
    expect(categories(model)).toEqual([
      ["b", "a", "d", "e"],
      ["a", "c", "e"],
      ["a", "c", "d", "e"],
    ]);
    // The repeated bars stand at each panel's own a and e.
    for (const i of [0, 1, 2]) {
      const goals = barsOf(model, scene, i).filter((b) => b.key === '[1,"goal"]');
      expect(goals.map((b) => [b.category, b.to])).toEqual([
        ["a", 3],
        ["e", 3],
      ]);
    }
  });

  it("place categories of marks over tables with different dictionaries alike", () => {
    const first = table({ region: ["N", "S"], product: ["c", "a"], v: [1, 2] });
    const second = table({ region: ["S", "N", "N"], product: ["a", "c", "z"], v: [3, 4, 5] });
    const { model, scene } = build({
      marks: [bar(first, { x: "product", y: "v" }), bar(second, { x: "product", y: "v" })],
      facet: facet("region"),
      x: { scope: "panel" },
    });
    expect(categories(model)).toEqual([["c", "z"], ["a"]]);
    expect(barsOf(model, scene, 0).map((b) => [b.key, b.category, b.to])).toEqual([
      ['[0,"v"]', "c", 1],
      ['[1,"v"]', "c", 4],
      ['[1,"v"]', "z", 5],
    ]);
  });

  it("leave out rows without a category or a facet value", () => {
    const partial = table({
      region: ["N", "N", null, "S"],
      product: ["a", null, "b", "c"],
      v: [1, 2, 3, 4],
    });
    const { model, scene } = build({
      marks: [bar(partial, { x: "product", y: "v" })],
      facet: facet("region"),
      x: { scope: "panel" },
    });
    // b's only row has no region: no panel shows it.
    expect(categories(model)).toEqual([["a"], ["c"]]);
    expect(barsOf(model, scene, 0).map((b) => b.category)).toEqual(["a"]);
  });

  it("read rows through the chart's band indices and panels' places, not copies", () => {
    const data = table({
      region: ["N", "S", "E", "N", "S", "E", "N", "S"],
      product: ["b", "a", "c", "d", "c", "d", "b", "a"],
      units: [1, 2, 3, 4, 5, 6, 7, 8],
      cost: [8, 7, 6, 5, 4, 3, 2, 1],
    });
    const { model } = build({
      marks: [bar(data, { x: "product", y: ["units", "cost"] })],
      facet: facet("region"),
      x: { scope: "panel" },
    });
    const [base] = model.series();
    for (const { key } of model.panels()) {
      const [units, cost] = model.panelSeries(key);
      // The chart's band index of every row, which every panel shares.
      expect(units!.x).toBe(base!.x);
      // The panel's bands, found by chart band: N's b (0) and d (3).
      if (key === "N")
        expect([0, 1, 2, 3].map((band) => units!.places!.x!.at(band))).toEqual([0, -1, -1, 1]);
      // Fields of one table share their rows in each panel, and their places.
      expect(cost!.rows).toBe(units!.rows);
      expect(cost!.places).toBe(units!.places);
    }
  });

  it("find the places of panels holding few of many categories", () => {
    // 12 panels of two categories each, 24 in the chart: each panel searches its two.
    const region = Array.from({ length: 48 }, (_, i) => `r${i % 12}`);
    const product = Array.from(
      { length: 48 },
      (_, i) => `p${(i % 12) * 2 + (i % 24 < 12 ? 0 : 1)}`,
    );
    const units = Array.from({ length: 48 }, (_, i) => i + 1);
    const { model, scene } = build(
      {
        marks: [bar(table({ region, product, units }), { x: "product", y: "units" })],
        facet: facet("region", { columns: 4 }),
        x: { scope: "panel" },
      },
      900,
      600,
    );
    expect(categories(model)[5]).toEqual(["p10", "p11"]);
    // Rows 5 and 17 hold p10 and p11; row 0 p0, of another panel.
    const part = model.panelSeries("r5")[0]!;
    const band = (row: number) => part.x[row]!;
    expect([5, 17, 0].map((row) => part.places!.x!.at(band(row)))).toEqual([0, 1, -1]);
    // Rows 5 and 29 are p10, 17 and 41 p11: two bars each, stacked or not.
    expect(barsOf(model, scene, 5).map((b) => [b.category, b.to])).toEqual([
      ["p10", 6],
      ["p11", 18],
      ["p10", 30],
      ["p11", 42],
    ]);
  });

  it("search the places of a panel whose few categories lie far apart among the chart's", () => {
    // A holds the chart's first and last of 5,002 categories; B those between.
    const count = 5002;
    const product = Array.from({ length: count }, (_, i) => `c${i}`);
    const region = product.map((_, i) => (i === 0 || i === count - 1 ? "A" : "B"));
    const units = product.map((_, i) => i);
    const { model, scene } = build({
      marks: [bar(table({ region, product, units }), { x: "product", y: "units" })],
      facet: facet("region"),
      x: { scope: "panel" },
    });
    expect(categories(model)[0]).toEqual(["c0", `c${count - 1}`]);
    expect(categories(model)[1]).toHaveLength(count - 2);
    const places = model.panelSeries("A")[0]!.places!.x!;
    expect([0, 1, count - 2, count - 1, count].map((band) => places.at(band))).toEqual([
      0, -1, -1, 1, -1,
    ]);
    expect(barsOf(model, scene, 0).map((b) => [b.category, b.to])).toEqual([
      ["c0", 0],
      [`c${count - 1}`, count - 1],
    ]);
  });

  it("follow streaming rows: a panel's categories change alone, and its scale with them", () => {
    const data = table(
      { region: ["N", "S", "N"], product: ["a", "b", "c"], units: [1, 2, 3] },
      { maxRows: 4 },
    );
    const { model } = build({
      marks: [bar(data, { x: "product", y: "units" })],
      facet: facet("region"),
      x: { scope: "panel" },
    });
    const panel = (key: string) => model.panels().find((p) => p.key === key)!;
    expect(categories(model)).toEqual([["a", "c"], ["b"]]);
    const [n, s] = [panel("N"), panel("S")];
    data.append({ region: ["S"], product: ["d"], units: [4] });
    model.scene(estimateText);
    expect(categories(model)).toEqual([
      ["a", "c"],
      ["b", "d"],
    ]);
    // N's categories, and so its scale's name, stay; S's change.
    expect(panel("N").x.categories).toBe(n.x.categories);
    expect(panel("N").xGroup).toBe(n.xGroup);
    expect(panel("S").xGroup).not.toBe(s.xGroup);
    // A row dropped from the front takes N's a with it (and S comes first).
    data.append({ region: ["S"], product: ["b"], units: [5] });
    model.scene(estimateText);
    expect(model.panels().map((p) => p.key)).toEqual(["S", "N"]);
    expect(categories(model)).toEqual([["b", "d"], ["c"]]);
    // Values changing in place move no category.
    const before = panel("S");
    data.replace("units", 0, [9]);
    model.scene(estimateText);
    expect(panel("S").xGroup).toBe(before.xGroup);
    expect(panel("S").x.categories).toBe(before.x.categories);
    // N leaving the data (and S taking its place) leaves S's scale as it was.
    data.append({ region: ["S", "S"], product: ["d", "b"], units: [6, 7] });
    model.scene(estimateText);
    expect(model.panels().map((p) => p.key)).toEqual(["S"]);
    expect(panel("S").xGroup).toBe(before.xGroup);
    expect(panel("S").x.categories).toBe(before.x.categories);
  });

  it("keep a row of panels' categories while another row leaves", () => {
    const data = table(
      {
        region: ["E", "N", "N", "S"],
        kind: ["p", "p", "q", "q"],
        product: ["z", "a", "b", "c"],
        units: [1, 2, 3, 4],
      },
      { maxRows: 4 },
    );
    const { model } = build(
      {
        marks: [bar(data, { x: "product", y: "units" })],
        facet: facet({ row: "region", column: "kind" }),
        x: { scope: "row" },
      },
      600,
      500,
    );
    const panel = (key: string) => model.panels().find((p) => p.key === key)!;
    const before = panel('["N","p"]');
    expect(before.x.categories).toEqual(["a", "b"]);
    // E's row of panels goes with its only row; N's row keeps its scale.
    data.append({ region: ["N"], kind: ["p"], product: ["a"], units: [5] });
    model.scene(estimateText);
    expect(model.panels().map((p) => p.key)).toEqual([
      '["N","p"]',
      '["N","q"]',
      '["S","p"]',
      '["S","q"]',
    ]);
    expect(panel('["N","p"]').xGroup).toBe(before.xGroup);
    expect(panel('["N","p"]').x.categories).toBe(before.x.categories);
  });

  it("draw a mark shared by two charts in each as its chart resolves it", () => {
    const mark = bar(sales(), { x: "product", y: "units", series: "kind", stack: true });
    const faceted = build({ marks: [mark], facet: facet("region"), x: { scope: "panel" } });
    const whole = build({ marks: [mark] });
    expect(categories(faceted.model)[2]).toEqual(["c", "d"]);
    expect(categories(whole.model)[0]).toEqual(["b", "a", "c", "d"]);
    // The whole chart stacks every c; E's panel only its own.
    const c = (model: ChartModel, scene: Scene, panel: number) =>
      barsOf(model, scene, panel).filter((b) => b.category === "c");
    expect(c(whole.model, whole.scene, 0).map((b) => [b.from, b.to])).toEqual([
      [0, 5],
      [5, 8],
    ]);
    // Drawn again after the other chart, the faceted one is unchanged.
    const again = faceted.model.scene(estimateText);
    expect(c(faceted.model, again, 2).map((b) => [b.from, b.to])).toEqual([[0, 3]]);
  });

  it("give subplots categories of their own", () => {
    const fruit = table({ name: ["apple", "pear"], v: [3, 4] });
    const cars = table({ name: ["vw", "bmw", "audi"], v: [5, 6, 7] });
    const layout = panels([{ id: "fruit" }, { id: "cars" }], { columns: 2 });
    const { model, scene } = build({
      marks: [
        bar(fruit, { x: "name", y: "v", panel: "fruit" }),
        bar(cars, { x: "name", y: "v", panel: "cars" }),
      ],
      panels: layout,
      x: { scope: "panel" },
    });
    expect(categories(model)).toEqual([
      ["apple", "pear"],
      ["vw", "bmw", "audi"],
    ]);
    expect(barsOf(model, scene, 1).map((b) => [b.category, b.to])).toEqual([
      ["vw", 5],
      ["bmw", 6],
      ["audi", 7],
    ]);
    // Horizontal bars in subplots have y categories of their own by default.
    const horizontal = build({
      marks: [
        bar(fruit, { x: "v", y: "name", panel: "fruit" }),
        bar(cars, { x: "v", y: "name", panel: "cars" }),
        rule({ x: 2, panel: "*" }),
      ],
      panels: layout,
    });
    expect(categories(horizontal.model, "y")).toEqual([
      ["apple", "pear"],
      ["vw", "bmw", "audi"],
    ]);
    // Shared, every panel shows them all, as before.
    const shared = build({
      marks: [
        bar(fruit, { x: "v", y: "name", panel: "fruit" }),
        bar(cars, { x: "v", y: "name", panel: "cars" }),
      ],
      panels: layout,
      y: { scope: "chart" },
    });
    expect(categories(shared.model, "y")[0]).toEqual(["apple", "pear", "vw", "bmw", "audi"]);
  });

  it("count a mark drawn in every subplot in each", () => {
    const fruit = table({ name: ["apple", "pear"], v: [3, 4] });
    const all = table({ name: ["pear", "kiwi"], v: [1, 1] });
    const { model, scene } = build({
      marks: [
        bar(fruit, { x: "name", y: "v", panel: "a" }),
        bar(all, { x: "name", y: "v", panel: "*" }),
      ],
      panels: panels([{ id: "a" }, { id: "b" }]),
      x: { scope: "panel" },
    });
    expect(categories(model)).toEqual([
      ["apple", "pear", "kiwi"],
      ["pear", "kiwi"],
    ]);
    expect(barsOf(model, scene, 1).map((b) => b.category)).toEqual(["pear", "kiwi"]);
  });

  it("place error bars on each panel's own categories, vertical and horizontal", () => {
    const { model, scene } = build({
      marks: [errorBar(intervals(), { x: "product", y1: "low", y2: "high" })],
      facet: facet("region"),
      x: { scope: "panel" },
    });
    expect(categories(model)).toEqual([
      ["b", "d"],
      ["a", "c"],
      ["c", "d"],
    ]);
    expect([0, 1, 2].map((i) => stemsOf(model, scene, i))).toEqual([
      [
        ["b", 1, 2],
        ["d", 4, 5],
      ],
      [
        ["a", 2, 3],
        ["c", 5, 6],
      ],
      [
        ["c", 3, 4],
        ["d", 6, 7],
      ],
    ]);
    // The pointer finds the interval it is on, and the keyboard reads it by its own category.
    const s = model.panels()[1]!;
    const hit = model.inspect(s.x.map(1), s.y.map(5.5), "nearest", "S")!;
    expect(hit.points.map(({ row, text }) => [row, text])).toEqual([[4, "5 – 6"]]);
    const [stop] = stopsOf(model, "S");
    expect(positionOf(model, stop!.key, 1, "S")!.label).toBe("c");

    // Horizontal ones, in subplots, whose y categories are their own by default.
    const two = build({
      marks: [
        errorBar(intervals(), { y: "product", x1: "low", x2: "high", panel: "a" }),
        errorBar(table({ product: ["d"], low: [0], high: [9] }), {
          y: "product",
          x1: "low",
          x2: "high",
          panel: "b",
        }),
      ],
      panels: panels([{ id: "a" }, { id: "b" }]),
    });
    expect(categories(two.model, "y")).toEqual([["b", "a", "c", "d"], ["d"]]);
    expect(stemsOf(two.model, two.scene, 1, true)).toEqual([["d", 0, 9]]);
    const b = two.model.panels()[1]!;
    expect(two.model.inspect(b.x.map(4), b.y.map(0), "nearest", "b")!.points[0]!.text).toBe(
      "0 – 9",
    );
  });

  it("place candlesticks on each panel's own categories", () => {
    const prices = table({
      region: ["N", "S", "N", "S"],
      day: ["mon", "tue", "wed", "wed"],
      open: [1, 5, 3, 2],
      high: [4, 6, 5, 3],
      low: [0, 2, 1, 1],
      close: [3, 4, 2, 2.5],
    });
    const { model, scene } = build({
      marks: [
        candlestick(prices, {
          x: "day",
          open: "open",
          high: "high",
          low: "low",
          close: "close",
          variant: "ohlc",
        }),
      ],
      facet: facet("region"),
      x: { scope: "panel" },
    });
    expect(categories(model)).toEqual([
      ["mon", "wed"],
      ["tue", "wed"],
    ]);
    // Each bar's line from high to low stands at its own category.
    const lines = (panel: number) => {
      const { x, y } = model.panels()[panel]!;
      const segments = scene.panels[panel]!.marks.filter(
        (m): m is SegmentGeometry => m.kind === "segments",
      );
      return segments.flatMap((m) =>
        Array.from({ length: m.count / 3 }, (_, k) => {
          const [x1, y1, , y2] = m.coords.subarray(k * 12, k * 12 + 4);
          return [x.categories![Math.round(x.invert(x1!))], y.invert(y1!), y.invert(y2!)];
        }),
      );
    };
    expect(lines(0).map(([day]) => day)).toEqual(["mon", "wed"]);
    expect(lines(1).map(([day]) => day)).toEqual(["wed", "tue"]);
    const [stop] = stopsOf(model, "S");
    const read = positionOf(model, stop!.key, 1, "S")!;
    expect([read.label, read.points[0]!.text]).toEqual(["wed", "open 2, high 3, low 1, close 2.5"]);
  });

  it("refuse what panels cannot do with categories of their own yet", () => {
    const data = sales();
    expect(() =>
      build({
        marks: [bar(data, { x: "product", y: "units" })],
        facet: facet("region"),
        x: { scope: "panel" },
        interaction: { sync: "dashboard" },
      }),
    ).toThrow(
      'chart interaction.sync: panels with categories of their own (x.scope "panel") cannot sync yet',
    );
    expect(() =>
      build({
        marks: [bar(data, { x: "units", y: "product" })],
        facet: facet("region"),
        y: { scope: "column" },
        interaction: { brush: "xy" },
      }),
    ).toThrow("brush along x only");
    // Shared, as before, these are fine; brushing x categories per panel too.
    expect(() =>
      build({
        marks: [bar(data, { x: "product", y: "units" })],
        facet: facet("region"),
        x: { scope: "panel" },
        interaction: { brush: "x" },
      }),
    ).not.toThrow();
  });

  it("load from specs and render statically", () => {
    const spec = {
      data: {
        sales: {
          columns: {
            region: ["N", "S", "E", "N"],
            product: ["b", "a", "c", "d"],
            units: [1, 2, 3, 4],
          },
        },
      },
      marks: [{ type: "bar" as const, data: "sales", x: "product", y: "units", stack: true }],
      facet: { field: "region" },
      x: { scope: "panel" as const },
      width: 600,
      height: 300,
    };
    const { config } = loadSpec(spec, []);
    const { model } = build(config);
    expect(categories(model)).toEqual([["b", "d"], ["a"], ["c"]]);
    const svg = renderToSVG({ ...config, width: 600, height: 300 });
    for (const label of ["b", "d", "a", "c"]) expect(svg).toContain(`>${label}</text>`);
  });
});
