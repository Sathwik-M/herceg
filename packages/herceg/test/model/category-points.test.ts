// Points on category axes (strip and dot plots), in one panel and in panels
// with categories of their own.
import { describe, expect, it } from "vitest";
import { col } from "../../src/data/expr.ts";
import { rowView } from "../../src/data/row-view.ts";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { grid } from "../../src/layout.ts";
import { bar } from "../../src/marks/bar.ts";
import { point } from "../../src/marks/point.ts";
import { describeChart } from "../../src/model/describe.ts";
import { facet } from "../../src/model/facet.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { panels } from "../../src/model/panels.ts";
import { renderToSVG } from "../../src/render/static.ts";
import type { PointGeometry, Scene } from "../../src/scene/scene.ts";
import { loadSpec } from "../../src/spec/load.ts";
import { positionOf, stopsOf } from "../helpers/keyboard.ts";

function build(config: ChartConfig, width = 600, height = 400) {
  const model = new ChartModel({ locale: "en-US", timeZone: "UTC", ...config });
  model.setSize(width, height, 1);
  return { model, scene: model.scene(estimateText) };
}

// Products b, a, c, d across regions: N has b and d, S a and c, E c and d.
const sales = () =>
  table({
    region: ["N", "S", "E", "N", "S", "E", "N", "S"],
    product: ["b", "a", "c", "d", "c", "d", "b", "a"],
    units: [1, 2, 3, 4, 5, 6, 7, 8],
    price: [10, 20, 30, 40, 50, 60, 70, 80],
  });

/** The points a panel draws, read back through its scales: [x, y] with categories by name. */
function pointsOf(model: ChartModel, scene: Scene, panel = 0): (string | number)[][] {
  const { x, y } = model.panels()[panel]!;
  const read = (scale: typeof x, pixel: number) =>
    scale.type === "band"
      ? scale.categories![Math.round(scale.invert(pixel))]!
      : Math.round(scale.invert(pixel) * 1000) / 1000;
  return scene.panels[panel]!.marks.filter((m): m is PointGeometry => m.kind === "point").flatMap(
    (g) =>
      Array.from({ length: g.count }, (_, k) => [
        read(x, g.coords[k * 2]!),
        read(y, g.coords[k * 2 + 1]!),
      ]),
  );
}

const categories = (model: ChartModel, axis: "x" | "y" = "x") =>
  model.panels().map((panel) => panel[axis].categories);

describe("points on category axes", () => {
  it("place points at the centers of a category x axis' bands", () => {
    const { model, scene } = build({ marks: [point(sales(), { x: "product", y: "units" })] });
    const { x, y } = model.panels()[0]!;
    expect(x.type).toBe("band");
    expect(x.categories).toEqual(["b", "a", "c", "d"]);
    expect(pointsOf(model, scene)).toEqual([
      ["b", 1],
      ["a", 2],
      ["c", 3],
      ["d", 4],
      ["c", 5],
      ["d", 6],
      ["b", 7],
      ["a", 8],
    ]);
    const [g] = scene.panels[0]!.marks as PointGeometry[];
    expect(g!.coords[0]).toBeCloseTo(x.map(0), 3);
    // The nearest point names its category and value, and its row.
    const inspection = model.inspect(x.map(2), y.map(5), "nearest")!;
    expect(inspection).toMatchObject({ label: "c", value: 2 });
    expect(inspection.points.map((p) => [p.value, p.row, p.text])).toEqual([[5, 4, "5"]]);
  });

  it("place points along category y, reporting their category's place", () => {
    const { model, scene } = build({ marks: [point(sales(), { x: "units", y: "product" })] });
    const { x, y } = model.panels()[0]!;
    expect(y.categories).toEqual(["b", "a", "c", "d"]);
    // Categories run top to bottom.
    expect(y.map(0)).toBeLessThan(y.map(1));
    expect(pointsOf(model, scene).slice(0, 2)).toEqual([
      [1, "b"],
      [2, "a"],
    ]);
    const inspection = model.inspect(x.map(4), y.map(3), "nearest")!;
    expect(inspection.points.map((p) => [p.value, p.row, p.text])).toEqual([[3, 3, "d"]]);
    // x fits the values; y holds the categories.
    expect(x.domain[0]).toBeLessThanOrEqual(1);
    expect(describeChart(model)).toContain("product: 8 points in 4 categories, x from 1 to 8.");
  });

  it("place points on two category axes", () => {
    const data = table({ a: ["x", "y", "x"], b: ["p", "p", "q"] });
    const { model, scene } = build({ marks: [point(data, { x: "a", y: "b" })] });
    expect(pointsOf(model, scene)).toEqual([
      ["x", "p"],
      ["y", "p"],
      ["x", "q"],
    ]);
    expect(describeChart(model)).toContain("b: 3 points in 2 categories.");
  });

  it("overlay bars sharing their categories", () => {
    const data = sales();
    const goals = table({ product: ["a", "e"], goal: [3, 9] });
    const { model, scene } = build({
      marks: [bar(data, { x: "product", y: "units" }), point(goals, { x: "product", y: "goal" })],
    });
    expect(model.panels()[0]!.x.categories).toEqual(["b", "a", "c", "d", "e"]);
    expect(pointsOf(model, scene)).toEqual([
      ["a", 3],
      ["e", 9],
    ]);
    // y fits the bars and the points.
    expect(model.panels()[0]!.y.domain[1]).toBeGreaterThanOrEqual(9);
  });

  it("leave out rows without a category, from drawing and from domains", () => {
    const data = table({ product: ["a", null, "b"], units: [1, 1000, 2], price: [1, 1000, 2] });
    const { model, scene } = build({ marks: [point(data, { x: "product", y: "units" })] });
    expect(pointsOf(model, scene)).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
    expect(model.panels()[0]!.y.domain[1]).toBeLessThan(100);
    const across = build({ marks: [point(data, { x: "price", y: "product" })] });
    expect(across.model.panels()[0]!.x.domain[1]).toBeLessThan(100);
  });

  it("summarize only the points drawn", () => {
    // The row without a category, and the one missing its size, are not drawn.
    const data = table({
      product: ["a", null, "b", "c"],
      units: [1, 1000, 2, 3],
      size: [1, 1, 1, Number.NaN],
    });
    const strip = build({ marks: [point(data, { x: "product", y: "units", size: "size" })] });
    expect(describeChart(strip.model)).toContain("units: 2 points, from 1 to 2, last 2.");
    const across = build({ marks: [point(data, { x: "units", y: "product", size: "size" })] });
    expect(describeChart(across.model)).toContain(
      "product: 2 points in 2 categories, x from 1 to 2.",
    );
    // The last value is the last point drawn in a view's order, not the table's latest row.
    const ranked = table({ product: ["a", "b", "c", null], units: [10, 20, 30, 5] });
    const view = rowView(ranked, { sort: [{ field: "units", order: "descending" }] });
    const sorted = build({ marks: [point(view, { x: "product", y: "units" })] });
    expect(describeChart(sorted.model)).toContain("units: 3 points, from 10 to 30, last 10.");
  });

  it("draw on the CPU, never as GPU clouds", () => {
    const n = 100_001;
    const big = table({
      product: Array.from({ length: n }, (_, i) => `p${i % 10}`),
      units: Float64Array.from({ length: n }, (_, i) => i % 97),
    });
    const { model } = build({ marks: [point(big, { x: "product", y: "units" })] });
    const [g] = model.scene(estimateText, true).panels[0]!.marks as PointGeometry[];
    expect(g!.cloud).toBeUndefined();
    expect(g!.count).toBe(n);
    // Sampled by pixel, points in a band at one value are drawn once.
    const sampled = build({
      marks: [point(big, { x: "product", y: "units", sampling: "pixel" })],
    });
    const [few] = sampled.scene.panels[0]!.marks as PointGeometry[];
    expect(few!.count).toBe(10 * 97);
  });

  it("show a row view's points and their encodings in bands", () => {
    const data = sales();
    const view = rowView(data, { filter: col("units").gt(2) });
    const { model, scene } = build({
      marks: [point(view, { x: "product", y: "units", size: "price", color: "price" })],
    });
    const [g] = scene.panels[0]!.marks as PointGeometry[];
    expect(pointsOf(model, scene).map(([category]) => category)).toEqual([
      "c",
      "d",
      "c",
      "d",
      "b",
      "a",
    ]);
    expect(g!.radii!.subarray(0, g!.count)).toHaveLength(6);
    expect(g!.colors!.index.subarray(0, g!.count)).toHaveLength(6);
    const { x, y } = model.panels()[0]!;
    const inspection = model.inspect(x.map(0), y.map(7), "nearest")!;
    expect(inspection.points.map((p) => [p.row, p.text])).toEqual([[6, "7, price 70, price 70"]]);
  });

  it("load from specs", () => {
    const { config } = loadSpec({
      data: { t: { columns: { product: ["a", "b"], units: [1, 2] } } },
      marks: [{ type: "point", x: "product", y: "units" }],
    });
    const { model, scene } = build(config);
    expect(pointsOf(model, scene)).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
    const svg = renderToSVG({ ...config, width: 400, height: 200 });
    expect(svg).toContain(">a</text>");
  });

  it("keep size and opacity fields numeric, and color points by categories too", () => {
    const data = sales();
    for (const option of ["size", "fillOpacity"] as const)
      expect(() => point(data, { x: "product", y: "units", [option]: "region" })).toThrow(
        /holds category values/,
      );
    expect(() => point(data, { x: "product", y: "units", color: "region" })).not.toThrow();
  });
});

describe("points on categories of panels' own", () => {
  const config = (
    scopes: Pick<ChartConfig, "x" | "y"> = { x: { scope: "panel" } },
  ): ChartConfig => ({
    marks: [point(sales(), { x: "product", y: "units" })],
    facet: facet("region"),
    ...scopes,
  });

  it("place each panel's points at its own categories", () => {
    const { model, scene } = build(config());
    expect(categories(model)).toEqual([
      ["b", "d"],
      ["a", "c"],
      ["c", "d"],
    ]);
    expect(pointsOf(model, scene, 0)).toEqual([
      ["b", 1],
      ["d", 4],
      ["b", 7],
    ]);
    expect(pointsOf(model, scene, 1)).toEqual([
      ["a", 2],
      ["c", 5],
      ["a", 8],
    ]);
    // Place 1 is d in N and c in S: the pointer finds each panel's own.
    const [n, s] = model.panels();
    const near = (panel: typeof n, value: number) =>
      model.inspect(panel!.x.map(1), panel!.y.map(value), "nearest", panel!.key)!;
    expect(near(n, 4)).toMatchObject({ label: "d", value: 1 });
    expect(near(n, 4).points.map((p) => p.row)).toEqual([3]);
    expect(near(s, 5)).toMatchObject({ label: "c", value: 1 });
    expect(near(s, 5).points.map((p) => p.row)).toEqual([4]);
  });

  it("read each panel's points with the keyboard at their own categories", () => {
    const { model } = build(config());
    const [stop] = stopsOf(model, "E");
    const read = positionOf(model, stop!.key, 1, "E")!;
    expect(read).toMatchObject({ panel: "E", label: "d", value: 1 });
    expect(read.points.map((p) => [p.row, p.value])).toEqual([[5, 6]]);
  });

  it("place y categories per panel, reporting each panel's places", () => {
    const { model } = build({
      marks: [point(sales(), { x: "units", y: "product" })],
      facet: facet("region"),
      y: { scope: "panel" },
    });
    expect(categories(model, "y")).toEqual([
      ["b", "d"],
      ["a", "c"],
      ["c", "d"],
    ]);
    const s = model.panels()[1]!;
    const inspection = model.inspect(s.x.map(5), s.y.map(1), "nearest", "S")!;
    expect(inspection.points.map((p) => [p.value, p.text, p.row])).toEqual([[1, "c", 4]]);
    // The summary names categories by the chart's, whichever panel holds them.
    expect(describeChart(model)).toContain("product: 8 points in 4 categories, x from 1 to 8.");
  });

  it("place a repeated mark's points at each panel's places", () => {
    const goals = table({ product: ["c", "d"], goal: [9, 9] });
    const { model, scene } = build({
      marks: [
        point(sales(), { x: "product", y: "units" }),
        point(goals, { x: "product", y: "goal", facet: "repeat" }),
      ],
      facet: facet("region"),
      x: { scope: "panel" },
    });
    expect(categories(model)).toEqual([
      ["b", "c", "d"],
      ["a", "c", "d"],
      ["c", "d"],
    ]);
    for (const panel of [0, 1, 2])
      expect(pointsOf(model, scene, panel).filter(([, y]) => y === 9)).toEqual([
        ["c", 9],
        ["d", 9],
      ]);
  });

  it("follow streaming rows", () => {
    const data = table(
      { region: ["N", "S", "N"], product: ["a", "b", "c"], units: [1, 2, 3] },
      { maxRows: 4 },
    );
    const { model } = build({
      marks: [point(data, { x: "product", y: "units" })],
      facet: facet("region"),
      x: { scope: "panel" },
    });
    expect(categories(model)).toEqual([["a", "c"], ["b"]]);
    data.append({ region: ["S", "N"], product: ["d", "c"], units: [4, 5] });
    const scene = model.scene(estimateText);
    expect(model.panels().map((p) => p.key)).toEqual(["S", "N"]);
    expect(categories(model)).toEqual([["b", "d"], ["c"]]);
    expect(pointsOf(model, scene, 0)).toEqual([
      ["b", 2],
      ["d", 4],
    ]);
    expect(pointsOf(model, scene, 1)).toEqual([
      ["c", 3],
      ["c", 5],
    ]);
  });

  it("draw a mark shared by two charts as each resolves it", () => {
    const mark = point(sales(), { x: "product", y: "units" });
    const faceted = build({ marks: [mark], facet: facet("region"), x: { scope: "panel" } });
    const whole = build({ marks: [mark] });
    expect(pointsOf(whole.model, whole.scene)[1]).toEqual(["a", 2]);
    const again = faceted.model.scene(estimateText);
    expect(pointsOf(faceted.model, again, 2)).toEqual([
      ["c", 3],
      ["d", 6],
    ]);
  });

  it("give subplots categories of their own", () => {
    const fruit = table({ name: ["apple", "pear"], v: [3, 4] });
    const cars = table({ name: ["vw", "bmw", "audi"], v: [5, 6, 7] });
    const { model, scene } = build({
      marks: [
        point(fruit, { x: "v", y: "name", panel: "fruit" }),
        point(cars, { x: "v", y: "name", panel: "cars" }),
      ],
      panels: panels([{ id: "fruit" }, { id: "cars" }], grid({ columns: 2 })),
    });
    expect(categories(model, "y")).toEqual([
      ["apple", "pear"],
      ["vw", "bmw", "audi"],
    ]);
    expect(pointsOf(model, scene, 1)).toEqual([
      [5, "vw"],
      [6, "bmw"],
      [7, "audi"],
    ]);
  });

  it("refuse synced charts, as for bars", () => {
    expect(() => build({ ...config(), interaction: { sync: "board" } })).toThrow(
      'chart interaction.sync: panels with categories of their own (x.scope "panel") cannot sync yet',
    );
  });
});
