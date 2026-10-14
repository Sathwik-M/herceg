// 2D histograms: cells counting pairs of values in rectangular bins.
import { describe, expect, it } from "vitest";
import { time } from "../../src/data/column.ts";
import { compileExpression } from "../../src/data/expression.ts";
import { type Table, table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { histogram } from "../../src/marks/histogram.ts";
import { describeChart } from "../../src/model/describe.ts";
import { facet } from "../../src/model/facet.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { brushedRows, clickedRows } from "../../src/model/selected-rows.ts";
import { renderToSVG } from "../../src/render/static.ts";
import type { RasterGeometry } from "../../src/scene/scene.ts";
import { loadSpec } from "../../src/spec/load.ts";
import { rampsOf } from "../helpers/guides.ts";

function build(config: ChartConfig, width = 600, height = 400) {
  const model = new ChartModel({ locale: "en-US", timeZone: "UTC", ...config });
  model.setSize(width, height, 1);
  return { model, scene: model.scene(estimateText) };
}

/** Each drawn cell's center and measure, by series. */
const cells = (model: ChartModel) =>
  model
    .series()
    .map((s) => Array.from({ length: s.length }, (_, k) => [s.x[k]!, s.y[k]!, s.values[k]!]));

const pairs = table({
  x: [0, 1, 4, 5, 10, 10, 2, Number.NaN, 3],
  y: [0, 0, 1, 9, 10, 10, 6, 5, Number.NaN],
  w: [1, 2, 1, 1, 1, 0.5, -1, 1, 1],
});

describe("2D histograms", () => {
  it("count pairs in bins along each axis, the last bins holding their right edges", () => {
    const { model, scene } = build({
      marks: [histogram(pairs, { x: "x", y: "y", bins: { x: [0, 5, 10], y: 2 } })],
    });
    // y: about 2 round bins over 0 to 10, [0, 5) and [5, 10]; rows missing x or y are not counted.
    expect(cells(model)).toEqual([
      [
        [2.5, 2.5, 3],
        [2.5, 7.5, 1],
        [7.5, 7.5, 3],
      ],
    ]);
    // Empty cells are not drawn: one raster of the drawn ones.
    const raster = scene.panels[0]!.marks.filter((m): m is RasterGeometry => m.kind === "raster");
    expect(raster).toHaveLength(1);
    expect(model.xScale()!.domain).toEqual([0, 10]);
    expect(model.yScale()!.domain).toEqual([0, 10]);
    // A ramp from 0 to the fullest cell.
    expect(rampsOf(scene)).toHaveLength(1);
    expect(rampsOf(scene)[0]!.low.text).toBe("0");
    expect(rampsOf(scene)[0]!.high.text).toBe("3");
    expect(rampsOf(scene)[0]!.title.text).toBe("Count");
    // Without colors of their own, cells take the theme's ramp.
    const dark = build({
      theme: "dark",
      marks: [histogram(pairs, { x: "x", y: "y", bins: { x: [0, 5, 10], y: 2 } })],
    });
    expect(rampsOf(dark.scene)[0]!.stops).not.toEqual(rampsOf(scene)[0]!.stops);
  });

  it("weight rows, and measure probability, percent, frequency, or density per bin area", () => {
    const of = (normalize: "probability" | "percent" | "frequency" | "density") =>
      cells(
        build({
          marks: [
            histogram(pairs, {
              x: "x",
              y: "y",
              weight: "w",
              bins: { x: [0, 5, 10], y: [0, 5, 10] },
              normalize,
            }),
          ],
        }).model,
      )[0]!.map(([, , value]) => value);
    // Weights 1 + 2 + 1, and 1 + 1 + 0.5, count; a negative weight does not.
    expect(of("probability")).toEqual([4 / 6.5, 2.5 / 6.5]);
    expect(of("percent")).toEqual([(4 / 6.5) * 100, (2.5 / 6.5) * 100]);
    expect(of("frequency")).toEqual([4 / 25, 2.5 / 25]);
    // Density integrates to 1 over the bins' area.
    const density = of("density");
    expect(density.reduce((sum, value) => sum! + value! * 25, 0)).toBeCloseTo(1, 12);
  });

  it("report a cell's bins and measure, and select its rows when clicked", () => {
    const { model } = build({
      marks: [histogram(pairs, { x: "x", y: "y", bins: [0, 5, 10] })],
    });
    const [px, py] = [model.xScale()!.map(2), model.yScale()!.map(1)];
    const inspection = model.inspect(px, py)!;
    expect(inspection.points[0]).toMatchObject({
      label: "x 0 – 5, y 0 – 5",
      text: "3",
      value: 3,
      row: undefined,
    });
    expect(
      Array.from(clickedRows(model, new Set([pairs as unknown as Table]), px, py)!.rows),
    ).toEqual([0, 1, 2]);
    // Brushes along x, along y, or both select the rows whose values they cover.
    const brushed = (brush: Parameters<typeof brushedRows>[2]) => {
      const found = brushedRows(model, pairs as unknown as Table, brush, null);
      if (found?.kind !== "predicate") throw new Error("expected a condition");
      const at = compileExpression(found.expression, pairs).at;
      return Array.from({ length: pairs.length }, (_, row) => row).filter(
        (row) => at(row) === true,
      );
    };
    expect(brushed({ x: [0, 3], y: null, lasso: null })).toEqual([0, 1, 6, 8]);
    expect(brushed({ x: null, y: [0, 1], lasso: null })).toEqual([0, 1, 2]);
    expect(brushed({ x: [0, 3], y: [0, 1], lasso: null })).toEqual([0, 1]);
    // An empty cell reports nothing.
    expect(model.inspect(model.xScale()!.map(8), model.yScale()!.map(2))).toBeUndefined();
    // The keyboard reads cells row by row from the top left.
    const key = model.series()[0]!.key;
    const top = model.stepCell(model.panels()[0]!.key, key, -1, 0, 0);
    expect(model.inspectPosition(key, top!)!.points[0]!.label).toBe("x 0 – 5, y 5 – 10");
    expect(model.stepCell(model.panels()[0]!.key, key, top!, 1, 0)).toBe(2);
  });

  it("describe their values, bins, and fullest cell", () => {
    const { model } = build({ marks: [histogram(pairs, { x: "x", y: "y", bins: [0, 5, 10] })] });
    expect(describeChart(model)).toContain(
      "Count: 7 values in 3 cells of 2 by 2 bins of x from 0 to 10 and y from 0 to 10; the fullest, x 0 – 5 and y 0 – 5, holds 3; 2 missing x or y, or outside the bins",
    );
  });

  it("count each facet panel's rows in the bins of its axes' panels, on one color scale", () => {
    const data = table({
      x: [0, 1, 2, 10, 11, 12, 13],
      y: [0, 1, 2, 0, 1, 2, 3],
      group: ["a", "a", "a", "b", "b", "b", "b"],
    });
    const shared = build({
      marks: [histogram(data, { x: "x", y: "y", bins: 2 })],
      facet: facet("group"),
    });
    const panels = shared.model.panels();
    expect(panels).toHaveLength(2);
    // Bins along x from both panels' rows: they share the x scale.
    const counted = panels.map(({ key }) =>
      shared.model.panelSeries(key).map((s) => Array.from(s.values.subarray(0, s.length))),
    );
    expect(counted.flat(2).reduce((a, b) => a + b, 0)).toBe(7);
    // One ramp for both panels, to the fullest cell of either.
    expect(rampsOf(shared.scene)).toHaveLength(1);
  });

  it("bin times by calendar intervals, load from specs, and draw in static SVG", () => {
    const day = 86_400_000;
    const at = table({
      day: time(Array.from({ length: 30 }, (_, i) => Date.UTC(2026, 0, 1) + i * day)),
      v: Array.from({ length: 30 }, (_, i) => i % 7),
    });
    const { model } = build({ marks: [histogram(at, { x: "day", y: "v" })] });
    expect(model.series()[0]!.length).toBeGreaterThan(0);
    const loaded = loadSpec({
      data: { t: { columns: { x: [1, 2, 3, 4], y: [4, 3, 2, 1] } } },
      marks: [
        { type: "histogram", x: "x", y: "y", bins: { x: 2, y: [0, 2.5, 5] }, colors: "viridis" },
      ],
    });
    const svg = renderToSVG({ ...loaded.config, width: 300, height: 200 });
    expect(svg).toContain("<image");
    // Bins for each axis may leave either, or both, to its default.
    const defaults = loadSpec({
      data: { t: { columns: { x: [1, 2, 3, 4], y: [4, 3, 2, 1] } } },
      marks: [{ type: "histogram", x: "x", y: "y", bins: {} }],
    });
    expect(defaults.config.marks).toHaveLength(1);
  });

  it("refuse bar options, log axes, and time breaks", () => {
    expect(() =>
      // @ts-expect-error 2D histograms take no series
      histogram(pairs, { x: "x", y: "y", series: "w" }),
    ).toThrow(/histogram series: a 2D histogram of x and y counts one distribution/);
    const log = new ChartModel({
      marks: [histogram(pairs, { x: "x", y: "y" })],
      x: { type: "log" },
    });
    log.setSize(300, 200, 1);
    expect(() => log.scene(estimateText)).toThrow(/cells cannot go on a log x axis yet/);
  });
});
