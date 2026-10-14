// Heatmaps in facets and subplots: cells split by panel, on categories
// shared by every panel or resolved per panel, row, or column.
import { describe, expect, it } from "vitest";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { heatmap } from "../../src/marks/heatmap.ts";
import { point } from "../../src/marks/point.ts";
import { rowOf } from "../../src/marks/series.ts";
import { describeChart } from "../../src/model/describe.ts";
import { facet } from "../../src/model/facet.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { panels } from "../../src/model/panels.ts";
import { renderToSVG } from "../../src/render/static.ts";
import type { RasterGeometry, Scene } from "../../src/scene/scene.ts";
import { loadSpec } from "../../src/spec/load.ts";
import type { ScaleScope } from "../../src/spec/spec.ts";
import { rampsOf } from "../helpers/guides.ts";

function build(config: ChartConfig, width = 600, height = 400) {
  const model = new ChartModel({ locale: "en-US", timeZone: "UTC", ...config });
  model.setSize(width, height, 1);
  return { model, scene: model.scene(estimateText) };
}

// The chart's hours are b, a, c, d and hosts p, q. N's cells are (b, p),
// twice and once without a value, and (d, q); S's (a, q), (c, p), and (b, p)
// too; E's (c, p) and (d, p). Rows of a panel are not next to each other.
const load = () =>
  table({
    region: ["N", "S", "E", "N", "S", "N", "S", "N", "E"],
    hour: ["b", "a", "c", "d", "c", "b", "b", "b", "d"],
    host: ["p", "q", "p", "q", "p", "p", "p", "p", "p"],
    cpu: [1, 2, 3, 4, 5, 6, 7, Number.NaN, 9],
  });

/** Black to white over 0 to 10: a cell's gray level is its value. */
const gray = { colors: ["#000000", "#ffffff"], colorDomain: [0, 10] as const };
const fields = { x: "hour", y: "host", color: "cpu" } as const;

const categories = (model: ChartModel, axis: "x" | "y") =>
  model.panels().map((panel) => panel[axis].categories);

/** The value each painted cell of a panel shows, by its categories; one pixel per cell. */
function painted(model: ChartModel, scene: Scene, panel: number): Record<string, number> {
  const { x, y } = model.panels()[panel]!;
  const raster = scene.panels[panel]!.marks.find((m): m is RasterGeometry => m.kind === "raster");
  const out: Record<string, number> = {};
  if (!raster) return out;
  expect([raster.columns, raster.rows]).toEqual([x.categories!.length, y.categories!.length]);
  for (let r = 0; r < raster.rows; r++)
    for (let c = 0; c < raster.columns; c++) {
      const at = (r * raster.columns + c) * 4;
      if (raster.pixels[at + 3] === 0) continue;
      out[`${x.categories![c]} ${y.categories![r]}`] = Math.round((raster.pixels[at]! / 255) * 10);
    }
  return out;
}

/** The value and table row of the cell under each category pair of a panel, as the pointer finds them. */
function picked(model: ChartModel, panel: number, hour: string, host: string) {
  const { x, y, key } = model.panels()[panel]!;
  const inspection = model.inspect(
    x.map(x.categories!.indexOf(hour)),
    y.map(y.categories!.indexOf(host)),
    undefined,
    key,
  );
  const [point] = inspection?.points ?? [];
  return point && { value: point.value, row: point.row, label: point.label, at: inspection!.label };
}

describe("heatmaps split by facets", () => {
  it.each(["chart", "panel"] as const)(
    "keep each panel's cells apart, the last row with a value in each (%s categories)",
    (resolution) => {
      const { model, scene } = build({
        marks: [heatmap(load(), { ...fields, ...gray })],
        facet: facet("region"),
        x: { scope: resolution },
        y: { scope: resolution },
      });
      expect(model.panels().map((p) => p.key)).toEqual(["N", "S", "E"]);
      // N's (b, p) is 6, its later row without a value erasing nothing, and
      // S's (b, p), the same cell of the chart, is S's own 7.
      expect(painted(model, scene, 0)).toEqual({ "b p": 6, "d q": 4 });
      expect(painted(model, scene, 1)).toEqual({ "b p": 7, "c p": 5, "a q": 2 });
      expect(painted(model, scene, 2)).toEqual({ "c p": 3, "d p": 9 });
      expect(picked(model, 0, "b", "p")).toEqual({ value: 6, row: 5, label: "p", at: "b" });
      expect(picked(model, 1, "b", "p")).toEqual({ value: 7, row: 6, label: "p", at: "b" });
      expect(picked(model, 2, "d", "p")).toEqual({ value: 9, row: 8, label: "p", at: "d" });
      if (resolution === "chart") {
        expect(picked(model, 2, "a", "q")).toBeUndefined();
        for (const list of categories(model, "x")) expect(list).toEqual(["b", "a", "c", "d"]);
      }
    },
  );

  it("give each panel the categories its cells hold, at its own places", () => {
    const { model } = build({
      marks: [heatmap(load(), { ...fields, ...gray })],
      facet: facet("region"),
      y: { scope: "panel" },
      x: { scope: "panel" },
    });
    expect(categories(model, "x")).toEqual([
      ["b", "d"],
      ["b", "a", "c"],
      ["c", "d"],
    ]);
    expect(categories(model, "y")).toEqual([["p", "q"], ["p", "q"], ["p"]]);
    // Place 1 along x is d in N, a in S, and d in E.
    expect(picked(model, 0, "d", "q")).toMatchObject({ value: 4, row: 3 });
    expect(picked(model, 1, "a", "q")).toMatchObject({ value: 2, row: 1 });
    expect(picked(model, 0, "b", "q")).toBeUndefined();
    // Every panel labels its own categories.
    const scene = model.scene(estimateText);
    const ticks = (panel: number, orient: "bottom" | "left") =>
      scene.panels[panel]!.axes.find((a) => a.side === orient)?.ticks.map((t) => t.label);
    expect([0, 1, 2].map((i) => ticks(i, "bottom"))).toEqual([
      ["b", "d"],
      ["b", "a", "c"],
      ["c", "d"],
    ]);
    expect(ticks(2, "left")).toEqual(["p"]);
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
        ["b", "a", "c"],
        ["b", "c", "d"],
      ],
    ],
  ] as const)("share categories among the panels of a resolution: %s", (x, expected) => {
    const { model, scene } = build({
      marks: [heatmap(load(), { ...fields, ...gray })],
      facet: facet("region", { columns: 2 }),
      x: { scope: x as ScaleScope },
    });
    expect(categories(model, "x")).toEqual(expected);
    // S shares N's row (or E's column): its cells are its own.
    expect(painted(model, scene, 1)).toEqual({ "b p": 7, "c p": 5, "a q": 2 });
  });

  it("step through each panel's cells with the keyboard as drawn", () => {
    const { model } = build({
      marks: [heatmap(load(), { ...fields, ...gray })],
      facet: facet("region"),
      y: { scope: "panel" },
      x: { scope: "panel" },
    });
    const [stop] = model.keyboardStops("S");
    const key = stop!.key;
    const rowAt = (panel: string, position: number | undefined) =>
      position === undefined ? undefined : rowOf(model.panelSeries(panel)[0]!, position);
    // S draws (b, p) and (c, p) on its top row, (a, q) below them.
    const first = model.stepCell("S", key, -1, 0, 0);
    expect(rowAt("S", first)).toBe(6);
    const right = model.stepCell("S", key, first!, 1, 0);
    expect(rowAt("S", right)).toBe(4);
    // Down from c: the nearest cell of the next row, a.
    const down = model.stepCell("S", key, right!, 0, -1);
    expect(rowAt("S", down)).toBe(1);
    // A keyboard read names the cell's own categories and row.
    const read = model.inspectPosition(key, down!, "S")!;
    expect(read).toMatchObject({ panel: "S", label: "a" });
    expect(read.points.map((p) => [p.label, p.value, p.row])).toEqual([["q", 2, 1]]);
    // E has one row of cells: down leaves it.
    const e = model.stepCell("E", key, -1, 0, 0);
    expect(rowAt("E", e)).toBe(2);
    expect(model.stepCell("E", key, e!, 0, -1)).toBeUndefined();
  });

  it("summarize every panel's cells by the chart's categories", () => {
    const { model } = build({
      marks: [heatmap(load(), { ...fields, ...gray })],
      facet: facet("region"),
      y: { scope: "panel" },
      x: { scope: "panel" },
    });
    // a is S's place 1, which N's axis names d: the sentence names a.
    expect(describeChart(model)).toContain(
      "cpu: 7 cells in 4 columns and 2 rows, lowest 2 at a, q, highest 9 at d, p.",
    );
  });

  it("color cells by one scale across panels, from the whole table's values", () => {
    const data = table({
      region: ["N", "S", null],
      hour: ["a", "b", "c"],
      host: ["p", "p", "p"],
      cpu: [1, 2, 100],
    });
    const { model, scene } = build({
      marks: [heatmap(data, { x: "hour", y: "host", color: "cpu" })],
      facet: facet("region"),
      x: { scope: "panel" },
    });
    // The row without a region is drawn in no panel, but the mark's scale
    // is the same in every chart drawing it: its value counts.
    expect(model.legendEntries()).toEqual([]);
    const ramps = rampsOf(scene);
    expect(ramps.map((ramp) => [ramp.low.text, ramp.high.text])).toEqual([["1", "100"]]);
    expect(categories(model, "x")).toEqual([["a"], ["b"]]);
  });

  it("give empty panels of a grid no cells and no categories", () => {
    const { model, scene } = build({
      marks: [heatmap(load(), { ...fields, ...gray })],
      facet: facet({ row: "region", column: "host" }),
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
    // E has no q rows.
    expect(categories(model, "x")[5]).toEqual([]);
    expect(scene.panels[5]!.marks).toEqual([]);
    expect(painted(model, scene, 4)).toEqual({ "c p": 3, "d p": 9 });
  });

  it("follow streaming rows, repainting a panel whose rows or categories change", () => {
    const data = table(
      { region: ["N", "S", "N"], hour: ["a", "b", "c"], host: ["p", "p", "p"], cpu: [1, 2, 3] },
      { maxRows: 4 },
    );
    const { model, scene } = build({
      marks: [heatmap(data, { ...fields, ...gray })],
      facet: facet("region"),
      x: { scope: "panel" },
    });
    expect(painted(model, scene, 1)).toEqual({ "b p": 2 });
    data.append({ region: ["S"], hour: ["d"], host: ["p"], cpu: [4] });
    let next = model.scene(estimateText);
    expect(categories(model, "x")).toEqual([
      ["a", "c"],
      ["b", "d"],
    ]);
    expect(painted(model, next, 1)).toEqual({ "b p": 2, "d p": 4 });
    expect(picked(model, 1, "d", "p")).toMatchObject({ value: 4, row: 3 });
    // A value replaced in place keeps every category and repaints its cell.
    data.replace("cpu", 3, [8]);
    next = model.scene(estimateText);
    expect(painted(model, next, 1)).toEqual({ "b p": 2, "d p": 8 });
    // The front row dropped takes N's a.
    data.append({ region: ["N"], hour: ["c"], host: ["p"], cpu: [5] });
    next = model.scene(estimateText);
    expect(model.panels().map((p) => p.key)).toEqual(["S", "N"]);
    expect(painted(model, next, 1)).toEqual({ "c p": 5 });
    expect(picked(model, 1, "c", "p")).toMatchObject({ value: 5, row: 3 });
  });

  it("draw a mark shared by two charts in each as its chart splits it", () => {
    const mark = heatmap(load(), { ...fields, ...gray });
    const faceted = build({
      marks: [mark],
      facet: facet("region"),
      y: { scope: "panel" },
      x: { scope: "panel" },
    });
    const whole = build({ marks: [mark] });
    // The whole chart's (b, p) is the table's last value there: S's 7.
    expect(picked(whole.model, 0, "b", "p")).toMatchObject({ value: 7, row: 6 });
    expect(picked(faceted.model, 0, "b", "p")).toMatchObject({ value: 6, row: 5 });
    const again = faceted.model.scene(estimateText);
    expect(painted(faceted.model, again, 0)).toEqual({ "b p": 6, "d q": 4 });
    expect(painted(whole.model, whole.model.scene(estimateText), 0)).toMatchObject({
      "b p": 7,
      "d q": 4,
    });
  });

  it("read a repeated heatmap at each panel's own places", () => {
    // The repeated cells are a and c; a split point adds b, the chart's
    // first category, to N's, so a and c have other places in each panel.
    const grid = table({ hour: ["a", "c"], host: ["p", "p"], cpu: [1, 3] });
    const dots = table({ region: ["N", "S"], hour: ["b", null], host: ["p", "p"] });
    const { model, scene } = build({
      marks: [
        point(dots, { x: "hour", y: "host" }),
        heatmap(grid, { ...fields, ...gray, facet: "repeat" }),
      ],
      facet: facet("region"),
      x: { scope: "panel" },
    });
    expect(categories(model, "x")).toEqual([
      ["b", "a", "c"],
      ["a", "c"],
    ]);
    for (const panel of [0, 1]) {
      expect(painted(model, scene, panel)).toEqual({ "a p": 1, "c p": 3 });
      expect(picked(model, panel, "c", "p")).toMatchObject({ value: 3, row: 1 });
    }
    // One index serves both panels: the rows and their bands are the same,
    // N holding the chart's bands at their own places and S a and c (bands
    // 1 and 2) at 0 and 1.
    const [n, s] = ["N", "S"].map((key) => model.panelSeries(key)[1]!);
    expect(n!.x).toBe(s!.x);
    expect(n!.places).toBeUndefined();
    expect([0, 1, 2].map((band) => s!.places!.x!.at(band))).toEqual([-1, 0, 1]);
  });

  it("load from specs and render statically", () => {
    const spec = {
      data: {
        load: {
          columns: {
            region: ["N", "S", "N"],
            hour: ["b", "a", "d"],
            host: ["p", "q", "q"],
            cpu: [1, 2, 3],
          },
        },
      },
      marks: [{ type: "heatmap" as const, data: "load", x: "hour", y: "host", color: "cpu" }],
      facet: { field: "region" },
      x: { scope: "panel" as const },
      y: { scope: "panel" as const },
      width: 600,
      height: 300,
    };
    const { config } = loadSpec(spec, []);
    const { model } = build(config);
    expect(categories(model, "x")).toEqual([["b", "d"], ["a"]]);
    expect(categories(model, "y")).toEqual([["p", "q"], ["q"]]);
    const svg = renderToSVG({ ...config, width: 600, height: 300 });
    expect(svg.match(/<image /g)).toHaveLength(2);
    for (const label of ["a", "b", "d", "p", "q"]) expect(svg).toContain(`>${label}</text>`);
  });
});

describe("heatmaps in subplots", () => {
  it("give each subplot its own categories, by default along y", () => {
    const morning = table({ hour: ["6", "7"], host: ["p", "q"], cpu: [1, 2] });
    const evening = table({ hour: ["18", "19"], host: ["q", "r"], cpu: [3, 4] });
    const { model, scene } = build({
      marks: [
        heatmap(morning, { ...fields, ...gray, panel: "am" }),
        heatmap(evening, { ...fields, ...gray, panel: "pm" }),
      ],
      panels: panels([{ id: "am" }, { id: "pm" }], { columns: 2 }),
      x: { scope: "panel" },
    });
    expect(categories(model, "x")).toEqual([
      ["6", "7"],
      ["18", "19"],
    ]);
    expect(categories(model, "y")).toEqual([
      ["p", "q"],
      ["q", "r"],
    ]);
    expect(painted(model, scene, 1)).toEqual({ "18 q": 3, "19 r": 4 });
    expect(picked(model, 1, "19", "r")).toMatchObject({ value: 4, row: 1 });
  });

  it("read a heatmap drawn in every subplot at each one's places", () => {
    // The chart's hours are k (from the first mark, in b only), then m and n.
    const extra = table({ hour: ["k"], host: ["p"], cpu: [5] });
    const shared = table({ hour: ["m", "n"], host: ["p", "p"], cpu: [1, 2] });
    const { model, scene } = build({
      marks: [
        heatmap(extra, { ...fields, ...gray, panel: "b" }),
        heatmap(shared, { ...fields, ...gray, panel: "*" }),
      ],
      panels: panels([{ id: "a" }, { id: "b" }]),
      y: { scope: "chart" },
      x: { scope: "panel" },
    });
    expect(categories(model, "x")).toEqual([
      ["m", "n"],
      ["k", "m", "n"],
    ]);
    expect(painted(model, scene, 0)).toEqual({ "m p": 1, "n p": 2 });
    expect(picked(model, 0, "n", "p")).toMatchObject({ value: 2, row: 1 });
    expect(picked(model, 1, "n", "p")).toMatchObject({ value: 2, row: 1 });
    expect(picked(model, 1, "k", "p")).toMatchObject({ value: 5, row: 0 });
  });
});
