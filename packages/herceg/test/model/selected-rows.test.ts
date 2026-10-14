import { describe, expect, it } from "vitest";
import type { ColumnInput } from "../../src/data/column.ts";
import { time } from "../../src/data/column.ts";
import { col, compileExpression, type Expression } from "../../src/data/expression.ts";
import { RowSet } from "../../src/data/row-set.ts";
import { rowView } from "../../src/data/row-view.ts";
import { type DataSelection, selectionStore, selectRows } from "../../src/data/selection.ts";
import { type Table, table as typed } from "../../src/data/table.ts";

import { estimateText } from "../../src/layout/text.ts";
import { area } from "../../src/marks/area.ts";
import { bar } from "../../src/marks/bar.ts";
import { boxplot } from "../../src/marks/boxplot.ts";
import { errorBar } from "../../src/marks/errorbar.ts";
import { heatmap } from "../../src/marks/heatmap.ts";
import { histogram } from "../../src/marks/histogram.ts";
import { line } from "../../src/marks/line.ts";
import { point } from "../../src/marks/point.ts";
import { rug } from "../../src/marks/rug.ts";
import { violin } from "../../src/marks/violin.ts";
import { facet } from "../../src/model/facet.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { rowSelection } from "../../src/model/row-selection.ts";
import {
  brushedRows,
  clickedRows,
  cursorRows,
  type Brushed as Selection,
} from "../../src/model/selected-rows.ts";
import type { AreaGeometry, PointGeometry, RectGeometry } from "../../src/scene/scene.ts";

/** Tables as charts read them, whatever their fields. */
const table = (columns: Record<string, ColumnInput>, options?: { maxRows?: number }): Table =>
  typed(columns, options) as unknown as Table;

function drawn(config: ChartConfig, width = 600, height = 400): ChartModel {
  const model = new ChartModel({ locale: "en-US", timeZone: "UTC", ...config });
  model.setSize(width, height, 1);
  model.scene(estimateText);
  return model;
}

/** The rows a selection holds now, ascending. */
function rowsOf(selection: DataSelection | undefined, source: Table): number[] {
  if (!selection) throw new Error("no selection");
  if (selection.kind === "rows") return Array.from(selection.rows.positions());
  const { at } = compileExpression(selection.expression, source);
  return Array.from({ length: source.length }, (_, row) => row).filter((row) => at(row) === true);
}

function expression(selection: DataSelection | undefined): Expression {
  if (selection?.kind !== "predicate") throw new Error(`not a condition: ${selection?.kind}`);
  return selection.expression;
}

const xRange = (x: readonly [number, number]): Selection => ({ x, y: null, lasso: null });
const yRange = (y: readonly [number, number]): Selection => ({ x: null, y, lasso: null });

/** The pixel of a value on the first panel's scales. */
function pixel(model: ChartModel, x: number, y: number): [number, number] {
  const [panel] = model.panels();
  return [panel!.x.map(x), panel!.y.map(y)];
}

describe("brushes as conditions", () => {
  it("read lines and areas along y by their positions on y and values on x", () => {
    const casts = table({
      depth: [0, 10, 20],
      temperature: [20, 18, 12],
      salinity: [35, 36, 37],
      lo: [19, 17, 11],
      hi: [21, 19, 13],
      zone: ["top", "mid", "deep"],
    });
    const lines = drawn({
      marks: [line(casts, { x: ["temperature", "salinity"], y: "depth", orient: "y" })],
    });
    expect(rowsOf(brushedRows(lines, casts, yRange([5, 15]), null), casts)).toEqual([1]);
    expect(rowsOf(brushedRows(lines, casts, xRange([11, 13]), null), casts)).toEqual([2]);
    const band = drawn({ marks: [area(casts, { x1: "lo", x2: "hi", y: "depth" })] });
    expect(rowsOf(brushedRows(band, casts, xRange([16.5, 17.5]), null), casts)).toEqual([1]);
    // On a category y, the brushed bands' categories.
    const zones = drawn({ marks: [line(casts, { x: "temperature", y: "zone" })] });
    expect(rowsOf(brushedRows(zones, casts, yRange([1, 1]), null), casts)).toEqual([1]);
  });

  const readings = table({
    t: time([0, 1000, 2000, 3000, 4000]),
    x: [1, 2, 3, 4, 5],
    a: [10, 20, 30, 40, 50],
    b: [5, 4, 3, 2, 1],
    host: ["p", "q", "p", "q", "p"],
  });

  it("bound a number field's values, and keep holding rows appended later", () => {
    const source = table({ x: [1, 2, 3, 4], y: [1, 2, 3, 4] });
    const model = drawn({ marks: [line(source, { x: "x", y: "y" })] });
    const selection = brushedRows(model, source, xRange([1.5, 3.5]), null);
    expect(expression(selection)).toEqual([
      "and",
      [">=", ["field", "x"], 1.5],
      ["<=", ["field", "x"], 3.5],
    ]);
    expect(rowsOf(selection, source)).toEqual([1, 2]);
    // A live condition: an appended row inside the range joins.
    source.append({ x: [3.2], y: [9] });
    expect(rowsOf(selection, source)).toEqual([1, 2, 4]);
  });

  it("bound times in epoch milliseconds", () => {
    const model = drawn({ marks: [line(readings, { x: "t", y: "a" })] });
    const selection = brushedRows(model, readings, xRange([500, 2500]), null);
    expect(expression(selection)).toEqual([
      "and",
      [">=", ["field", "t"], 500],
      ["<=", ["field", "t"], 2500],
    ]);
    expect(rowsOf(selection, readings)).toEqual([1, 2]);
  });

  it("bound both fields of a rectangle, on log axes in their own values", () => {
    const model = drawn({
      marks: [point(readings, { x: "x", y: "a" })],
      y: { type: "log" },
    });
    const selection = brushedRows(
      model,
      readings,
      { x: [1.5, 4.5], y: [15, 35], lasso: null },
      null,
    );
    expect(rowsOf(selection, readings)).toEqual([1, 2]);
  });

  it("list category labels, which hold after the dictionary is recoded", () => {
    const sales = table({ region: ["N", "S", "E", "W"], v: [1, 2, 3, 4] }, { maxRows: 4 });
    const model = drawn({ marks: [bar(sales, { x: "region", y: "v" })] });
    // Bands 1 to 2: S and E.
    const selection = brushedRows(model, sales, xRange([1, 2]), null);
    expect(expression(selection)).toEqual(["in", ["field", "region"], "S", "E"]);
    // A rolling window drops N, S, E, and W, so codes are renumbered; the labels still select.
    sales.append({ region: ["X", "Y", "E", "Z", "S"], v: [5, 6, 7, 8, 9] });
    expect(rowsOf(selection, sales)).toEqual([1, 3]);
    expect([sales.value("region", 1), sales.value("region", 3)]).toEqual(["E", "S"]);
  });

  it("list the numbers of banded number fields", () => {
    const cells = table({ x: [10, 20, 30, 10], y: ["a", "a", "b", "b"], v: [1, 2, 3, 4] });
    const model = drawn({ marks: [heatmap(cells, { x: "x", y: "y", color: "v", xBanded: true })] });
    const selection = brushedRows(model, cells, { x: [0, 1], y: [1, 1], lasso: null }, null);
    expect(expression(selection)).toEqual([
      "and",
      ["in", ["field", "x"], 10, 20],
      ["in", ["field", "y"], "b"],
    ]);
    expect(rowsOf(selection, cells)).toEqual([3]);
    // Along a number axis, cells whose values are in the range.
    const along = drawn({ marks: [heatmap(cells, { x: "x", y: "y", color: "v" })] });
    const ranged = brushedRows(along, cells, { x: [5, 22], y: [1, 1], lasso: null }, null);
    expect(expression(ranged)).toEqual([
      "and",
      ["and", [">=", ["field", "x"], 5], ["<=", ["field", "x"], 22]],
      ["in", ["field", "y"], "b"],
    ]);
    expect(rowsOf(ranged, cells)).toEqual([3]);
  });

  it("select the days a brush covers in a calendar, and a clicked day's rows", () => {
    // Monday the 5th (twice) to Wednesday the 7th, and Monday the 12th.
    const at = (day: number, hour = 0) => Date.UTC(2026, 0, day, hour);
    const days = table({ day: time([at(5), at(5, 6), at(6), at(7), at(12)]), n: [1, 2, 3, 4, 5] });
    const model = drawn({ marks: [heatmap(days, { date: "day", color: "n" })] });
    // The first week, Monday and Tuesday.
    const week = brushedRows(model, days, { x: [at(5), at(12) - 1], y: [0, 1], lasso: null }, null);
    expect(rowsOf(week, days)).toEqual([0, 1, 2]);
    const [px, py] = pixel(model, at(5, 12), 0);
    expect(Array.from(clickedRows(model, new Set([days]), px, py)!.rows)).toEqual([0, 1]);
    // A cell is at its center: the week's middle, Thursday the 8th at noon.
    const middle = brushedRows(model, days, { x: [at(8), at(9)], y: [0, 0], lasso: null }, null);
    expect(rowsOf(middle, days)).toEqual([0, 1]);
    const lasso = [
      [at(8), -0.4],
      [at(9), -0.4],
      [at(9), 0.4],
      [at(8), 0.4],
    ] as const;
    expect(rowsOf(brushedRows(model, days, { x: null, y: null, lasso }, null), days)).toEqual([
      0, 1,
    ]);
    const months = drawn({
      marks: [heatmap(days, { date: "day", color: "n", calendar: "months" })],
    });
    // Days 5 to 7 of January.
    const span = brushedRows(months, days, { x: [4, 6], y: [0, 0], lasso: null }, null);
    expect(rowsOf(span, days)).toEqual([0, 1, 2, 3]);
  });

  it("lasso heatmap cells at their centers, which their values need not be", () => {
    // Cells of 0, 1, and 3 span [-0.5, 0.5], [0.5, 2], and [2, 4].
    const cells = table({ x: [0, 1, 3], y: [0, 0, 0], v: [1, 2, 3] });
    const model = drawn({ marks: [heatmap(cells, { x: "x", y: "y", color: "v" })] });
    const around = (x0: number, x1: number) =>
      [
        [x0, -0.5],
        [x1, -0.5],
        [x1, 0.5],
        [x0, 0.5],
      ] as const;
    const lassoed = (x0: number, x1: number) =>
      rowsOf(brushedRows(model, cells, { x: null, y: null, lasso: around(x0, x1) }, null), cells);
    expect(lassoed(1.1, 1.4)).toEqual([1]);
    expect(lassoed(0.8, 1.1)).toEqual([]);
  });

  it("select a row when any shown field of a mark of several is in range", () => {
    const model = drawn({ marks: [line(readings, { x: "x", y: ["a", "b"] })] });
    // a holds 10 and 20 in range, b 3, 2, and 1.
    expect(rowsOf(brushedRows(model, readings, yRange([0.5, 25]), null), readings)).toEqual([
      0, 1, 2, 3, 4,
    ]);
    expect(rowsOf(brushedRows(model, readings, yRange([0.5, 3.5]), null), readings)).toEqual([
      2, 3, 4,
    ]);
    // Hidden through the legend, a field leaves the condition.
    model.hidden.add(JSON.stringify([0, "b"]));
    model.scene(estimateText);
    expect(rowsOf(brushedRows(model, readings, yRange([0.5, 25]), null), readings)).toEqual([0, 1]);
  });

  it("leave out series of a series field hidden through the legend", () => {
    const model = drawn({ marks: [point(readings, { x: "x", y: "a", series: "host" })] });
    model.hidden.add(JSON.stringify([0, "q"]));
    model.scene(estimateText);
    const selection = brushedRows(model, readings, xRange([0, 10]), null);
    expect(rowsOf(selection, readings)).toEqual([0, 2, 4]);
  });

  it("test spans for overlap", () => {
    const spans = table({ x: [1, 2, 3], low: [0, 10, 20], high: [30, 12, 25] });
    const model = drawn({ marks: [errorBar(spans, { x: "x", y1: "low", y2: "high" })] });
    // The first span crosses the range with both ends outside it.
    expect(rowsOf(brushedRows(model, spans, yRange([14, 18]), null), spans)).toEqual([0]);
    const banded = drawn({ marks: [area(spans, { x: "x", y1: "low", y2: "high" })] });
    expect(rowsOf(brushedRows(banded, spans, yRange([11, 21]), null), spans)).toEqual([0, 1, 2]);
  });

  it("join a row view's filter", () => {
    const view = rowView(readings, { filter: col("host").eq("p") });
    const model = drawn({ marks: [point(view, { x: "x", y: "a" })] });
    expect(rowsOf(brushedRows(model, readings, xRange([0, 10]), null), readings)).toEqual([
      0, 2, 4,
    ]);
  });

  it("read the right axis's values where the pixels are", () => {
    const model = drawn({
      marks: [
        line(readings, { x: "x", y: "a" }),
        line(readings, { x: "x", y: "b", axis: "right" }),
      ],
    });
    const [panel] = model.panels();
    // The pixels of a = 15 to 35 on the left axis, as values of the right.
    const range = [panel!.y.map(15), panel!.y.map(35)].map((p) => panel!.yRight!.invert(p));
    const [lo, hi] = [Math.min(...range), Math.max(...range)];
    const expected = [0, 1, 2, 3, 4].filter((row) => {
      const [a, b] = [readings.value("a", row) as number, readings.value("b", row) as number];
      return (a >= 15 && a <= 35) || (b >= lo && b <= hi);
    });
    expect(rowsOf(brushedRows(model, readings, yRange([15, 35]), null), readings)).toEqual(
      expected,
    );
  });

  it("read each panel's own right axis where the pixels are", () => {
    const regions = table({
      x: [0, 1, 0, 1],
      a: [20, 10, 20, 10],
      b: [1000, 2000, 10000, 20000],
      region: ["N", "N", "S", "S"],
    });
    const model = drawn({
      marks: [line(regions, { x: "x", y: "a" }), line(regions, { x: "x", y: "b", axis: "right" })],
      facet: facet("region"),
      resolve: { yRight: "independent" },
    });
    const expected = model.panels().flatMap((panel) => {
      const range = [panel.y.map(19), panel.y.map(21)].map((p) => panel.yRight!.invert(p));
      const [lo, hi] = [Math.min(...range), Math.max(...range)];
      return [0, 1, 2, 3].filter((row) => {
        if (regions.value("region", row) !== panel.key) return false;
        const [a, b] = [regions.value("a", row) as number, regions.value("b", row) as number];
        return (a >= 19 && a <= 21) || (b >= lo && b <= hi);
      });
    });
    const found = rowsOf(brushedRows(model, regions, yRange([19, 21]), null), regions);
    expect(found).toEqual(expected.sort());
    // Each panel's right axis is its own: b at 2,000 in N and 20,000 in S are both inside.
    expect(found).toEqual([0, 1, 2, 3]);
  });

  it("read a range of categories on the right axis over their whole slots", () => {
    const mixed = table({ x: [0, 1, 2, 3], kind: ["a", "b", "c", "a"], v: [0, 3, 0.5, 1.4] });
    const model = drawn({
      marks: [point(mixed, { x: "x", y: "kind" }), line(mixed, { x: "x", y: "v", axis: "right" })],
    });
    // Category b's slot, the middle third of the plot, holds v = 1.4 on the right axis.
    expect(rowsOf(brushedRows(model, mixed, yRange([1, 1]), null), mixed)).toEqual([1, 3]);
  });

  it("leave out rows of facet panels with x scales of their own the brush is not in", () => {
    const model = drawn({
      marks: [point(readings, { x: "x", y: "a" })],
      facet: facet("host"),
      resolve: { x: "independent" },
    });
    const owner = { x: model.panels().find(({ key }) => key === "q")!.xGroup, panels: ["q"] };
    const selection = brushedRows(model, readings, xRange([0, 10]), owner);
    expect(rowsOf(selection, readings)).toEqual([1, 3]);
    // Panels sharing x: a brush covers every panel, without a condition on them.
    const shared = drawn({ marks: [point(readings, { x: "x", y: "a" })], facet: facet("host") });
    expect(expression(brushedRows(shared, readings, xRange([0, 10]), null))).toEqual([
      "and",
      [">=", ["field", "x"], 0],
      ["<=", ["field", "x"], 10],
    ]);
  });

  it("give each table its own condition, and leave tables not drawn alone", () => {
    const other = table({ x: [1, 2, 3], y: [3, 2, 1] });
    const unused = table({ x: [1] });
    const model = drawn({
      marks: [line(readings, { x: "x", y: "a" }), point(other, { x: "x", y: "y" })],
    });
    expect(rowsOf(brushedRows(model, readings, xRange([1.5, 2.5]), null), readings)).toEqual([1]);
    expect(rowsOf(brushedRows(model, other, xRange([1.5, 2.5]), null), other)).toEqual([1]);
    expect(brushedRows(model, unused, xRange([0, 9]), null)).toBeUndefined();
  });

  it("bound a histogram's binned field, and a box plot's categories", () => {
    const values = table({ v: [1, 2, 3, 4, 5, 6], g: ["a", "a", "b", "b", "c", "c"] });
    const counted = drawn({ marks: [histogram(values, { x: "v", bins: 3 })] });
    expect(rowsOf(brushedRows(counted, values, xRange([2.5, 4.5]), null), values)).toEqual([2, 3]);
    const boxes = drawn({ marks: [boxplot(values, { x: "g", y: "v" })] });
    expect(expression(brushedRows(boxes, values, xRange([1, 2]), null))).toEqual([
      "in",
      ["field", "g"],
      "b",
      "c",
    ]);
  });

  it("select a restricted view's rows as rows, since its row set is no condition", () => {
    const view = rowView(readings);
    view.restrict(new RowSet(readings).addAll([1, 3]));
    const model = drawn({ marks: [point(view, { x: "x", y: "a" })] });
    const selection = brushedRows(model, readings, xRange([0, 10]), null);
    expect(selection?.kind).toBe("rows");
    expect(rowsOf(selection, readings)).toEqual([1, 3]);
  });

  it("select no rows of summaries by their statistics, even through select()", () => {
    const values = table({ v: [1, 2, 3, 4, 5, 6] });
    const counted = drawn({ marks: [histogram(values, { x: "v", bins: 3 })] });
    const outline = [
      [0, 0],
      [7, 0],
      [7, 9],
      [0, 9],
    ] as const;
    expect(
      brushedRows(counted, values, { x: [0, 7], y: [0, 9], lasso: outline }, null),
    ).toBeUndefined();
    expect(brushedRows(counted, values, yRange([0, 9]), null)).toBeUndefined();
  });

  it("select a stack's rows by where they are drawn, as rows", () => {
    const stacked = table({ x: [1, 2], a: [10, 10], b: [5, 30] });
    const model = drawn({ marks: [bar(stacked, { x: "x", y: ["a", "b"], stack: true })] });
    // Tops: a at 10 and 10, b at 15 and 40.
    const selection = brushedRows(model, stacked, yRange([12, 20]), null);
    expect(selection?.kind).toBe("rows");
    expect(rowsOf(selection, stacked)).toEqual([0]);
    // Along the positions alone, a stack keeps a condition.
    expect(brushedRows(model, stacked, xRange([0, 1.5]), null)?.kind).toBe("predicate");
  });
});

describe("lassos and clicks as rows", () => {
  const points = table({ x: [1, 2, 3, 4, 5], y: [1, 2, 3, 4, 5], g: ["a", "b", "a", "b", "a"] });

  it("select the rows whose point is inside a lasso, for the table's generation", () => {
    const model = drawn({ marks: [point(points, { x: "x", y: "y" })] });
    const outline = [
      [1.5, 1.5],
      [3.5, 1.5],
      [3.5, 3.5],
      [1.5, 3.5],
    ] as const;
    const selection = brushedRows(
      model,
      points,
      { x: [1.5, 3.5], y: [1.5, 3.5], lasso: outline },
      null,
    );
    expect(selection?.kind).toBe("rows");
    if (selection?.kind !== "rows") return;
    expect(Array.from(selection.rows.positions())).toEqual([1, 2]);
    expect(selection.rows.generation).toBe(points.generation);
  });

  it("select the point clicked, within a few pixels of it", () => {
    const model = drawn({ marks: [point(points, { x: "x", y: "y" })] });
    const [px, py] = pixel(model, 3, 3);
    expect(Array.from(clickedRows(model, new Set([points]), px + 3, py)!.rows)).toEqual([2]);
    expect(clickedRows(model, new Set([points]), px + 40, py + 40)).toBeUndefined();
    expect(clickedRows(model, new Set(), px, py)).toBeUndefined();
  });

  it("select only points drawn, each within its own size", () => {
    const sized = table({ x: [1, 2, 3], y: [1, 1, 1], r: [Number.NaN, 1, 100] });
    const model = drawn({
      marks: [point(sized, { x: "x", y: "y", size: "r", radiusRange: [2, 20] })],
    });
    const tables = new Set([sized]);
    // Row 0 has no size: it is not drawn, so neither clicked nor lassoed.
    const [x0, y0] = pixel(model, 1, 1);
    expect(clickedRows(model, tables, x0, y0)).toBeUndefined();
    const all = [
      [0, 0],
      [4, 0],
      [4, 2],
      [0, 2],
    ] as const;
    const lassoed = brushedRows(model, sized, { x: [0, 4], y: [0, 2], lasso: all }, null);
    expect(rowsOf(lassoed, sized)).toEqual([1, 2]);
    // The big point is clicked well away from its center; the small one is not.
    const [x2, y2] = pixel(model, 3, 1);
    expect(Array.from(clickedRows(model, tables, x2, y2 - 15)!.rows)).toEqual([2]);
    const [x1, y1] = pixel(model, 2, 1);
    expect(clickedRows(model, tables, x1, y1 - 15)).toBeUndefined();
  });

  it("select the bar clicked inside, among grouped bars", () => {
    const sales = table({ region: ["N", "S"], a: [10, 20], b: [30, 5] });
    const model = drawn({ marks: [bar(sales, { x: "region", y: ["a", "b"] })] });
    const [panel] = model.panels();
    const center = panel!.x.map(1);
    const low = panel!.y.map(2);
    // Bars of S: a on the left of its slot, b on the right.
    const left = clickedRows(model, new Set([sales]), center - 10, low);
    const right = clickedRows(model, new Set([sales]), center + 10, low);
    expect([left?.rows[0], right?.rows[0]]).toEqual([1, 1]);
    // Above S's short b bar there is nothing.
    expect(clickedRows(model, new Set([sales]), center + 10, panel!.y.map(15))).toBeUndefined();
  });

  it("select the rows a histogram bin counts, by its exact edges", () => {
    const values = table({ v: [0, 0.5, 1, 1.5, 2, 2, 3], g: ["a", "a", "a", "b", "b", "b", "b"] });
    const model = drawn({ marks: [histogram(values, { x: "v", bins: { step: 1 } })] });
    const [panel] = model.panels();
    // Bin [1, 2) counts 1 and 1.5, not 2.
    const found = clickedRows(model, new Set([values]), panel!.x.map(1.5), panel!.y.map(0.5));
    expect(Array.from(found!.rows)).toEqual([2, 3]);
    // The last bin, [2, 3], includes its right edge.
    const last = clickedRows(model, new Set([values]), panel!.x.map(2.5), panel!.y.map(0.5));
    expect(Array.from(last!.rows)).toEqual([4, 5, 6]);
  });

  it("select the rows of the bin under a histogram polygon, where it is drawn", () => {
    // Bins [0, 1) and [1, 2] count 10 and 1; the polygon runs between their centers.
    const values = table({ v: [...Array.from({ length: 10 }, () => 0.5), 1.5] });
    const model = drawn({
      marks: [histogram(values, { x: "v", bins: [0, 1, 2], element: "poly" })],
    });
    const [panel] = model.panels();
    const at = (x: number, y: number) =>
      clickedRows(model, new Set([values]), panel!.x.map(x), panel!.y.map(y));
    // Left of the first center is outside the polygon; under it past the
    // shared edge, the second bin's row.
    expect(at(0.25, 5)).toBeUndefined();
    expect(Array.from(at(1.1, 4)!.rows)).toEqual([10]);
    expect(Array.from(at(0.75, 4)!.rows)).toHaveLength(10);
    // Steps on a reversed log axis stand where bars do: on the plot's bottom.
    const tens = table({ v: Array.from({ length: 10 }, () => 0.5) });
    const steps = drawn({
      marks: [histogram(tens, { x: "v", bins: [0, 1], element: "step" })],
      y: { type: "log", domain: [100, 1] },
    });
    const [sp] = steps.panels();
    const step = (y: number) => clickedRows(steps, new Set([tens]), sp!.x.map(0.5), sp!.y.map(y));
    expect(Array.from(step(50)!.rows)).toHaveLength(10);
    expect(step(5)).toBeUndefined();
    const [outline] = steps.scene(estimateText).panels[0]!.marks as AreaGeometry[];
    expect(outline!.lower!.coords[1]).toBeCloseTo(sp!.y.map(100), 3);
    // Polygons on a log binned axis are read where drawn, through bins' centers.
    const logged = drawn({
      marks: [histogram(values, { x: "v", bins: [0, 1, 2], element: "poly" })],
      x: { type: "log", domain: [0.1, 2] },
    });
    const [lp] = logged.panels();
    const [series] = logged.panelSeries(lp!.key);
    expect(logged.inspectPosition(series!.key, 0)!.points[0]!.value).toBe(10);
  });

  it("select a histogram series' rows in its bin, and a facet panel's own rows", () => {
    const values = table({ v: [1, 1, 1, 1], g: ["a", "b", "a", "b"], f: ["x", "x", "y", "y"] });
    const model = drawn({
      marks: [histogram(values, { x: "v", bins: { step: 1 }, series: "g", stack: true })],
      facet: facet("f"),
    });
    const panel = model.panels().find(({ key }) => key === "y")!;
    // Stacked: a below, b above; one row of each in the panel.
    const top = clickedRows(model, new Set([values]), panel.x.map(1.5), panel.y.map(1.5));
    expect(Array.from(top!.rows)).toEqual([3]);
  });

  it("select dodged points, grouped bars, and dodged bins where they are drawn", () => {
    const tips = table({
      day: ["thu", "thu", "thu", "thu"],
      sex: ["f", "m", "f", "m"],
      v: [1, 1, 3, 3],
    });
    const tables = new Set([tips]);
    const at = (model: ChartModel, kind: string, s: number) => {
      const geometry = model.scene(estimateText).panels[0]!.marks.filter((m) => m.kind === kind);
      return geometry[s] as unknown as { coords: Float32Array; rects: Float32Array };
    };
    // Dodged points: m's stand right of center, where its first point is clicked.
    const dodged = drawn({
      marks: [point(tips, { x: "day", y: "v", series: "sex", dodge: true })],
    });
    const m = at(dodged, "point", 1).coords;
    expect(Array.from(clickedRows(dodged, tables, m[0]!, m[1]!)!.rows)).toEqual([1]);
    // A legend group's bar stands in the group's slot for its series.
    const onlyM = table({ day: ["thu"], sex: ["m"], v: [3] });
    const grouped = drawn({
      marks: [
        bar(onlyM, { x: "day", y: "v", series: "sex", legendGroup: "sex" }),
        point(tips, {
          x: "day",
          y: "v",
          series: "sex",
          dodge: true,
          legendGroup: "sex",
          radius: 1,
        }),
      ],
    });
    const [x, y, w] = Array.from(at(grouped, "rect", 0).rects);
    expect(Array.from(clickedRows(grouped, new Set([onlyM]), x! + w! / 2, y! + 2)!.rows)).toEqual([
      0,
    ]);
    // Dodged and horizontal bins, and a cumulative bin's rows up to its right edge.
    for (const horizontal of [false, true]) {
      const bins = drawn({
        marks: [
          histogram(tips, {
            ...(horizontal ? { y: "v" } : { x: "v" }),
            bins: [0, 2, 4],
            series: "sex",
            dodge: true,
            cumulative: true,
          } as never),
        ],
      });
      // m's second bin: its rows at or below 4.
      const [bx, by, bw, bh] = Array.from(at(bins, "rect", 1).rects.slice(4, 8));
      const found = clickedRows(bins, tables, bx! + bw! / 2, by! + bh! / 2);
      expect(Array.from(found!.rows)).toEqual([1, 3]);
    }
  });

  it("place dodged points and grouped bars alike while a selection highlights rows", () => {
    const tips = table({ day: ["thu", "thu"], sex: ["f", "m"], v: [1, 3] });
    const store = selectionStore(tips);
    store.set("c", selectRows(new RowSet(tips).add(0)));
    for (const mark of [
      point(tips, { x: "day", y: "v", series: "sex", dodge: true }),
      bar(tips, { x: "day", y: "v", series: "sex" }),
    ]) {
      const selection = rowSelection({ store, channel: "c" });
      const model = drawn({ marks: [mark], rowSelection: selection });
      const chart = { selection: null, select() {}, render() {}, root: new EventTarget() as never };
      selection.mount(
        undefined,
        model,
        chart,
        { emit() {} },
        () => {},
        () => null,
        {
          textContent: null,
        },
      );
      // m's row, unselected and dimmed, stands right of the band's center.
      const geometry = model.scene(estimateText).panels[0]!.marks;
      const m = geometry.find(
        (g) => g.key.includes('"m"') && ((g as { count?: number }).count ?? 0) > 0,
      )!;
      const [px, py] =
        mark.spec.type === "point"
          ? [(m as PointGeometry).coords[0]!, (m as PointGeometry).coords[1]!]
          : [
              (m as RectGeometry).rects[0]! + (m as RectGeometry).rects[2]! / 2,
              (m as RectGeometry).rects[1]! + 2,
            ];
      expect(model.inspect(px, py, "nearest")!.points[0]!.px).toBeCloseTo(px, 3);
      expect(Array.from(clickedRows(model, new Set([tips]), px, py)!.rows)).toEqual([1]);
    }
  });

  it("brush a horizontal histogram's rows along its binned y", () => {
    const values = table({ v: [0.5, 1.5, 2.5, 3.5] });
    const model = drawn({ marks: [histogram(values, { y: "v", bins: [0, 2, 4] })] });
    expect(rowsOf(brushedRows(model, values, yRange([0, 2]), null), values)).toEqual([0, 1]);
  });

  it("select a rug's tick, at the plot's edge", () => {
    const values = table({ v: [1, 2, 3] });
    const model = drawn({ marks: [rug(values, { x: "v" })] });
    const [panel] = model.panels();
    const bottom = panel!.plot.y + panel!.plot.height - 2;
    expect(
      Array.from(clickedRows(model, new Set([values]), panel!.x.map(2), bottom)!.rows),
    ).toEqual([1]);
    // Anywhere along a long tick.
    const long = drawn({ marks: [rug(values, { x: "v", length: 40 })] });
    const [tall] = long.panels();
    const end = tall!.plot.y + tall!.plot.height - 38;
    expect(Array.from(clickedRows(long, new Set([values]), tall!.x.map(2), end)!.rows)).toEqual([
      1,
    ]);
    // Along y, at the left edge; and the keyboard selects ticks whatever the unused axis.
    const sideways = drawn({ marks: [rug(values, { y: "v" })] });
    const [left] = sideways.panels();
    const tick = clickedRows(sideways, new Set([values]), left!.plot.x + 2, left!.y.map(2));
    expect(Array.from(tick!.rows)).toEqual([1]);
    const wide = drawn({ marks: [rug(values, { y: "v", length: 40 })] });
    const [far] = wide.panels();
    const reach = clickedRows(wide, new Set([values]), far!.plot.x + 38, far!.y.map(2));
    expect(Array.from(reach!.rows)).toEqual([1]);
    const negative = table({ v: [-1, 2] });
    const logged = drawn({ marks: [rug(negative, { x: "v" })], y: { type: "log" } });
    const [s] = logged.series();
    const key = { panel: logged.panels()[0]!.key, key: s!.key, position: 0 };
    expect(Array.from(cursorRows(logged, new Set([negative]), key)!.rows)).toEqual([0]);
  });

  it("select a box plot's group, leaving out rows without a value", () => {
    const values = table({ g: ["a", "b", "a", "b", "a"], v: [1, 2, 3, Number.NaN, 5] });
    const model = drawn({ marks: [boxplot(values, { x: "g", y: "v" })] });
    const [panel] = model.panels();
    const found = clickedRows(model, new Set([values]), panel!.x.map(1), panel!.y.map(2));
    expect(Array.from(found!.rows)).toEqual([1]);
    const violins = drawn({ marks: [violin(values, { x: "g", y: "v" })] });
    const [area] = violins.panels();
    const group = clickedRows(violins, new Set([values]), area!.x.map(0), area!.y.map(3));
    expect(Array.from(group!.rows)).toEqual([0, 2, 4]);
  });

  it("select the row of a precomputed box, even where boxes repeat a category", () => {
    const stats = table({
      g: ["a", "a", "b"],
      low: [0, 10, 0],
      q1: [1, 11, 1],
      median: [2, 12, 2],
      q3: [3, 13, 3],
      high: [4, 14, 4],
    });
    const model = drawn({
      marks: [
        boxplot(stats, { x: "g", low: "low", q1: "q1", median: "median", q3: "q3", high: "high" }),
      ],
    });
    const [panel] = model.panels();
    const found = clickedRows(model, new Set([stats]), panel!.x.map(0), panel!.y.map(12));
    expect(Array.from(found!.rows)).toEqual([1]);
  });

  it("select every row of a heatmap's cell", () => {
    const cells = table({ x: ["a", "a", "b"], y: ["p", "p", "p"], v: [1, 2, 3] });
    const model = drawn({ marks: [heatmap(cells, { x: "x", y: "y", color: "v" })] });
    const [panel] = model.panels();
    const found = clickedRows(model, new Set([cells]), panel!.x.map(0), panel!.y.map(0));
    expect(Array.from(found!.rows)).toEqual([0, 1]);
  });

  it("lasso heatmap cells at their centers, and never rows without a value", () => {
    const cells = table({ x: ["a", "b", "b"], y: ["p", "p", "p"], v: [1, Number.NaN, 2] });
    const model = drawn({ marks: [heatmap(cells, { x: "x", y: "y", color: "v" })] });
    const all = [
      [-0.5, -0.5],
      [1.5, -0.5],
      [1.5, 0.5],
      [-0.5, 0.5],
    ] as const;
    const lassoed = brushedRows(model, cells, { x: [0, 1], y: [0, 0], lasso: all }, null);
    expect(rowsOf(lassoed, cells)).toEqual([0, 2]);
    const [panel] = model.panels();
    const clicked = clickedRows(model, new Set([cells]), panel!.x.map(1), panel!.y.map(0));
    expect(Array.from(clicked!.rows)).toEqual([2]);
  });

  it("select the rows under the keyboard cursor", () => {
    const values = table({ v: [0, 0.5, 1.5], g: ["a", "a", "a"] });
    const model = drawn({ marks: [histogram(values, { x: "v", bins: { step: 1 } })] });
    const [s] = model.panelSeries("");
    const found = cursorRows(model, new Set([values]), { panel: "", key: s!.key, position: 0 });
    expect(Array.from(found!.rows)).toEqual([0, 1]);
    expect(cursorRows(model, new Set(), { panel: "", key: s!.key, position: 0 })).toBeUndefined();
    expect(
      cursorRows(model, new Set([values]), { panel: "", key: s!.key, position: 99 }),
    ).toBeUndefined();
    // A point a log axis cannot place is not drawn, so the cursor selects nothing there.
    const signed = table({ x: [-1, 1, 2], y: [1, 2, 3] });
    const logged = drawn({ marks: [point(signed, { x: "x", y: "y" })], x: { type: "log" } });
    const [p] = logged.panelSeries("");
    const at = (position: number) =>
      cursorRows(logged, new Set([signed]), { panel: "", key: p!.key, position });
    expect(at(0)).toBeUndefined();
    expect(Array.from(at(1)!.rows)).toEqual([1]);
    // A range with an end a log axis cannot place is not drawn: neither clicked nor reached by keys.
    const ranges = table({ x: [0, 1], low: [-1, 1], high: [3, 3] });
    const bars = drawn({
      marks: [errorBar(ranges, { x: "x", y1: "low", y2: "high" })],
      y: { type: "log" },
    });
    const [bp] = bars.panels();
    const [e] = bars.panelSeries("");
    expect(clickedRows(bars, new Set([ranges]), bp!.x.map(0), bp!.y.map(1))).toBeUndefined();
    const reached = (position: number) =>
      cursorRows(bars, new Set([ranges]), { panel: "", key: e!.key, position });
    expect(reached(0)).toBeUndefined();
    expect(Array.from(reached(1)!.rows)).toEqual([1]);
    // A stack of areas on a log axis: zeros drawn at its low end, layers on a base it cannot place not drawn.
    const parts = table({ x: [0, 1, 2], a: [1, 0, 2], b: [-1, 3, 3] });
    const stacks = (y: readonly string[]) =>
      drawn({
        marks: [area(parts, { x: "x", y: y as never, stack: true })],
        y: { type: "log", domain: [0.1, 10] },
      });
    const zeros = stacks(["a"]);
    const [zp] = zeros.panels();
    const zero = clickedRows(zeros, new Set([parts]), zp!.x.map(1), zp!.y.map(0.1));
    expect(Array.from(zero!.rows)).toEqual([1]);
    const lassoed = brushedRows(zeros, parts, { x: [0.5, 1.5], y: [0.1, 0.2], lasso: null }, null);
    expect(rowsOf(lassoed, parts)).toEqual([1]);
    // Along y, a stack's zeros are drawn at its log x axis' low end, and so selected.
    const along = drawn({
      marks: [area(parts, { x: "a", y: "x", stack: true, orient: "y" })],
      x: { type: "log", domain: [0.1, 10] },
    });
    const [ap] = along.panels();
    const across = clickedRows(along, new Set([parts]), ap!.x.map(0.1), ap!.y.map(1));
    expect(Array.from(across!.rows)).toEqual([1]);
    const brushed = brushedRows(along, parts, { x: [0.1, 0.2], y: [0.5, 1.5], lasso: null }, null);
    expect(rowsOf(brushed, parts)).toEqual([1]);
    const [as] = along.panelSeries("");
    expect(
      Array.from(
        cursorRows(along, new Set([parts]), { panel: "", key: as!.key, position: 1 })!.rows,
      ),
    ).toEqual([1]);
    const based = stacks(["b", "a"]);
    const [, upper] = based.panelSeries("");
    const onTop = (position: number) =>
      cursorRows(based, new Set([parts]), { panel: "", key: upper!.key, position });
    expect(onTop(0)).toBeUndefined();
    // A series hidden since the cursor reached it selects nothing.
    model.hidden.add(s!.key);
    model.scene(estimateText);
    expect(
      cursorRows(model, new Set([values]), { panel: "", key: s!.key, position: 0 }),
    ).toBeUndefined();
  });
});
