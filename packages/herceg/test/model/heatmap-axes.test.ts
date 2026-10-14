// Heatmaps over number and time fields: cells along number and time axes,
// their edges from the data, the image they paint, and zoom, tooltips, the
// keyboard, panels, and specs over them.
import { afterEach, describe, expect, it, vi } from "vitest";
import { time } from "../../src/data/column.ts";
import { count, derive } from "../../src/data/derive.ts";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { type HeatmapOptions, heatmap } from "../../src/marks/heatmap.ts";
import { placeCells } from "../../src/marks/heatmap-cells.ts";
import { rowOf } from "../../src/marks/series.ts";
import { describeChart } from "../../src/model/describe.ts";
import { facet } from "../../src/model/facet.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { panels } from "../../src/model/panels.ts";
import { clickedRows } from "../../src/model/selected-rows.ts";
import { timeBreaks } from "../../src/scale/breaks.ts";
import { SequentialScale } from "../../src/scale/color.ts";
import type { RasterGeometry } from "../../src/scene/scene.ts";
import { loadSpec } from "../../src/spec/load.ts";
import type { ChartSpec } from "../../src/spec/spec.ts";
import { validateSpec } from "../../src/spec/validate.ts";

const GRAY = ["#000000", "#ffffff"];
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function build(
  config: ChartConfig,
  width = 600,
  height = 300,
  pixelRatio = 1,
  raster = pixelRatio,
) {
  const model = new ChartModel({ locale: "en-US", timeZone: "UTC", legend: false, ...config });
  model.setSize(width, height, pixelRatio, raster);
  return { model, scene: model.scene(estimateText) };
}

const rasterOf = (model: ChartModel) =>
  model.scene(estimateText).panels[0]!.marks.find((m) => m.kind === "raster") as RasterGeometry;

/** The RGBA bytes a value is painted with on a gray ramp over [0, 100]. */
function gray(value: number): number[] {
  const out = new Uint8ClampedArray(4);
  new SequentialScale([0, 100], GRAY).write(value, out, 0);
  return Array.from(out);
}

const pixel = (raster: RasterGeometry, column: number, row = 0) =>
  Array.from(
    raster.pixels.subarray(
      (row * raster.columns + column) * 4,
      (row * raster.columns + column) * 4 + 4,
    ),
  );

/** A one-row heatmap without axes, gray over [0, 100]. */
function strip(
  x: number[],
  v: number[],
  options: Partial<HeatmapOptions<never>> = {},
  config: Partial<ChartConfig> = {},
): ChartConfig {
  const data = table({ x: Float64Array.from(x), y: new Float64Array(x.length), v });
  return {
    x: { show: false },
    y: { show: false },
    ...config,
    marks: [
      heatmap(data, {
        x: "x",
        y: "y",
        color: "v",
        colors: GRAY,
        colorDomain: [0, 100],
        ...(options as object),
      }),
    ],
  };
}

/** The chart drawn with an image of `pixels` across the plot, at most. */
function across(config: ChartConfig, pixels: number) {
  const plot = build(config).scene.panels[0]!.plot;
  return build(config, 600, 300, 1, pixels / plot.width);
}

afterEach(() => vi.restoreAllMocks());

describe("heatmap cells along number and time axes", () => {
  it("reach halfway to the values beside them, the ends as far out as in", () => {
    const cells = placeCells(Float64Array.from([3, 0, 1, 3, Number.NaN]), undefined, false);
    expect(Array.from(cells.values)).toEqual([0, 1, 3]);
    expect(Array.from(cells.lower)).toEqual([-0.5, 0.5, 2]);
    expect(Array.from(cells.upper)).toEqual([0.5, 2, 4]);
    expect(Array.from(cells.cells)).toEqual([2, 0, 1, 2, -1]);
    expect(cells.lattice).toBeUndefined();
    expect([cells.find(-0.5), cells.find(1.99), cells.find(2), cells.find(4)]).toEqual([
      0, 1, 2, 2,
    ]);
    expect([cells.find(-0.6), cells.find(4.1)]).toEqual([-1, -1]);
  });

  it("put evenly spaced values on a lattice, within a millionth of a cell", () => {
    const tenths = Float64Array.from({ length: 11 }, (_, i) => i * 0.1);
    const cells = placeCells(tenths, undefined, false);
    expect(cells.lattice).toMatchObject({ slots: undefined, size: 11 });
    expect(cells.lattice!.width).toBeCloseTo(0.1, 12);
    expect(cells.lower[0]).toBeCloseTo(-0.05, 12);
    expect(placeCells(Float64Array.from([0, 1, 2.001]), undefined, false).lattice).toBeUndefined();
  });

  it("are a step wide around their values, with gaps where values are further apart", () => {
    const cells = placeCells(Float64Array.from([0, 1, 3]), 1, false);
    expect(cells.lattice).toMatchObject({ start: -0.5, width: 1, size: 4 });
    expect(Array.from(cells.lattice!.slots!)).toEqual([0, 1, 3]);
    expect(Array.from(cells.lower)).toEqual([-0.5, 0.5, 2.5]);
    expect(Array.from(cells.upper)).toEqual([0.5, 1.5, 3.5]);
    expect(cells.find(2)).toBe(-1);
    // Off the step's lattice, cells stop halfway to a neighbor closer than a step.
    const close = placeCells(Float64Array.from([0, 0.4, 2]), 1, false);
    expect(close.lattice).toBeUndefined();
    expect(Array.from(close.lower)).toEqual([-0.5, 0.2, 1.5]);
    expect(Array.from(close.upper)).toEqual([0.2, 0.9, 2.5]);
  });

  it("share each boundary between neighbors, so no value falls between cells", () => {
    const tenths = placeCells(
      Float64Array.from({ length: 11 }, (_, i) => i * 0.1),
      undefined,
      false,
    );
    for (let i = 1; i < 11; i++) expect(tenths.upper[i - 1]).toBe(tenths.lower[i]);
    // 0.25 is cell 2's: the boundary is 0.25000000000000006, as 0.1 is not exact.
    expect(tenths.find(0.25)).toBe(2);
    expect(tenths.find(tenths.upper[2]!)).toBe(3);
    const uneven = placeCells(Float64Array.from([0.1, 0.3, 0.7, 1.3]), undefined, false);
    for (let i = 1; i < 4; i++) expect(uneven.upper[i - 1]).toBe(uneven.lower[i]);
    const data = table({
      x: Float64Array.from({ length: 11 }, (_, i) => i * 0.1),
      y: new Float64Array(11),
      v: [...Array(11).keys()],
    });
    const { model } = build({
      interaction: { zoom: "x" },
      marks: [heatmap(data, { x: "x", y: "y", color: "v" })],
    });
    model.setViewport([0.25, 0.35]);
    model.scene(estimateText);
    const plot = model.panels()[0]!.plot;
    expect(model.inspect(plot.x, model.yScale()!.map(0))!.points[0]!.value).toBe(2);
  });

  it("refuse steps too small to tell a cell's edges apart", () => {
    const at = Date.UTC(2026, 0, 1);
    const data = table({ t: time([at]), y: [0], v: [1] });
    expect(() =>
      build({ marks: [heatmap(data, { x: "t", y: "y", color: "v", xStep: 0.0001 })] }),
    ).toThrow(`heatmap xStep: 0.0001 is too small for values near ${at}`);
  });

  it("refuse values too close for doubles to give each a cell around it", () => {
    const big = 2 ** 53;
    expect(() =>
      placeCells(
        Float64Array.from([0, 2, 4, 6], (d) => big + d),
        undefined,
        false,
      ),
    ).toThrow(`heatmap: values near ${big} are too close to tell their cells apart`);
  });

  it("keep cells of values near the largest doubles finite", () => {
    for (const x of [
      [1e308, 1.7e308],
      [-1.7e308, -1e308],
    ]) {
      const { scene } = build(strip(x, [10, 20]));
      const raster = scene.panels[0]!.marks[0] as RasterGeometry;
      expect([raster.x, raster.y, raster.width, raster.height].every(Number.isFinite)).toBe(true);
      expect(raster.columns).toBeGreaterThan(0);
    }
  });

  it("give a lone value the room an axis gives a value alone", () => {
    const one = (v: number, step?: number, isTime = false) => {
      const cells = placeCells(Float64Array.from([v]), step, isTime);
      return [cells.lower[0], cells.upper[0]];
    };
    expect(one(5)).toEqual([4.5, 5.5]);
    expect(one(0)).toEqual([-1, 1]);
    expect(one(DAY, undefined, true)).toEqual([DAY - HOUR, DAY + HOUR]);
    expect(one(5, 2)).toEqual([4, 6]);
  });

  it("keep extreme values' edges finite", () => {
    const cells = placeCells(Float64Array.from([-1.7e308, 1.7e308]), undefined, false);
    expect([...cells.lower, ...cells.upper].every(Number.isFinite)).toBe(true);
    expect(cells.find(0)).toBeGreaterThanOrEqual(0);
  });

  it("follow the length of days across a clock change", () => {
    // Local midnights in New York around the start of daylight saving time
    // (March 8, 2026): the 8th is 23 hours long.
    const midnights = [
      Date.UTC(2026, 2, 7, 5),
      Date.UTC(2026, 2, 8, 5),
      Date.UTC(2026, 2, 9, 4),
      Date.UTC(2026, 2, 10, 4),
    ];
    const cells = placeCells(Float64Array.from(midnights), undefined, true);
    expect(cells.lattice).toBeUndefined();
    expect(cells.upper[1]! - cells.lower[1]!).toBe(23.5 * HOUR);
    for (const [i, t] of midnights.entries()) {
      expect(cells.find(t)).toBe(i);
      expect(cells.find(t + 11 * HOUR)).toBe(i);
    }
    // Through a chart in that zone: each local midnight's cell under the pointer.
    const data = table({ day: time(midnights), row: [0, 0, 0, 0], v: [1, 2, 3, 4] });
    const { model, scene } = build({
      timeZone: "America/New_York",
      marks: [heatmap(data, { x: "day", y: "row", color: "v" })],
    });
    expect(model.xScale()!.type).toBe("time");
    const raster = scene.panels[0]!.marks[0] as RasterGeometry;
    expect(raster.columns).toBe(Math.floor(scene.panels[0]!.plot.width));
    for (const [i, t] of midnights.entries())
      expect(model.inspect(model.xScale()!.map(t), model.yScale()!.map(0))!.points[0]!.value).toBe(
        i + 1,
      );
  });

  it("draw irregular cells at their edges, at the plot's resolution", () => {
    // x extent [-0.5, 4] over 450 pixels: edges at 0.5 and 2 fall at pixels 100 and 250.
    const { raster } = { raster: rasterOf(across(strip([0, 1, 3], [10, 20, 30]), 450).model) };
    expect([raster.columns, raster.rows]).toEqual([450, 1]);
    expect(pixel(raster, 0)).toEqual(gray(10));
    expect(pixel(raster, 99)).toEqual(gray(10));
    expect(pixel(raster, 100)).toEqual(gray(20));
    expect(pixel(raster, 249)).toEqual(gray(20));
    expect(pixel(raster, 250)).toEqual(gray(30));
    expect(pixel(raster, 449)).toEqual(gray(30));
  });

  it("weigh cells by the area they cover where a pixel holds several", () => {
    // Four pixels 1.125 wide over [-0.5, 4]: the first holds 1 of cell 0 and
    // 0.125 of cell 1, the second only cell 1, the third 0.25 of cell 1 and
    // 0.875 of cell 2.
    const raster = rasterOf(across(strip([0, 1, 3], [10, 20, 30]), 4).model);
    expect(raster.columns).toBe(4);
    expect(pixel(raster, 0)).toEqual(gray((10 + 20 * 0.125) / 1.125));
    expect(pixel(raster, 1)).toEqual(gray(20));
    expect(pixel(raster, 2)).toEqual(gray((20 * 0.25 + 30 * 0.875) / 1.125));
    expect(pixel(raster, 3)).toEqual(gray(30));
    // The hottest and coldest cells a pixel holds any of, with sampling.
    const sampled = (reduce: "max" | "min") =>
      rasterOf(across(strip([0, 1, 3], [10, 20, 30], { sampling: { reduce } }), 4).model);
    const [max, min] = [sampled("max"), sampled("min")];
    expect([pixel(max, 0), pixel(max, 2)]).toEqual([gray(20), gray(30)]);
    expect([pixel(min, 0), pixel(min, 2)]).toEqual([gray(10), gray(20)]);
  });

  it("combine the rows sharing a cell into one value, the same at every zoom", () => {
    // Cell 1 has rows of 20 and then 40; a row without a value erases nothing.
    const x = [0, 1, 1, 1, 3];
    const v = [10, 20, 40, Number.NaN, 30];
    const raster = rasterOf(across(strip(x, v), 4).model);
    expect(pixel(raster, 1)).toEqual(gray(40));
    // In a pixel shared with another cell, the cell counts once, by its value.
    expect(pixel(raster, 0)).toEqual(gray((10 + 40 * 0.125) / 1.125));
    const wide = rasterOf(across(strip(x, v), 450).model);
    expect([pixel(wide, 100), pixel(wide, 249)]).toEqual([gray(40), gray(40)]);
    for (const [reduce, value] of [
      ["last", 40],
      ["mean", 30],
      ["sum", 60],
      ["min", 20],
      ["max", 40],
    ] as const) {
      const config = strip(x, v, { reduce });
      const { model } = across(config, 450);
      const point = model.inspect(model.xScale()!.map(1), model.yScale()!.map(0))!.points[0]!;
      expect(point.value).toBe(value);
      // Its last row with a value is the cell's.
      expect(point.row).toBe(2);
      expect(pixel(rasterOf(model), 249)).toEqual(gray(value));
      expect(pixel(rasterOf(across(config, 4).model), 0)).toEqual(
        gray((10 + value * 0.125) / 1.125),
      );
    }
    // Sums widen the color scale to the fullest cell.
    const { scene } = across(
      strip(x, v, { reduce: "sum", colorDomain: undefined as never }, { legend: true }),
      450,
    );
    expect(scene.colorLegends[0]!.high.text).toBe("60");
  });

  it("reduce shared pixels the same whatever order the cells' rows come in", () => {
    // Cell 1's rows keep their order (40 last); the cells' rows interleave differently.
    const orders = [
      { x: [0, 1, 1, 3], v: [10, 20, 40, 30] },
      { x: [1, 0, 1, 3], v: [20, 10, 40, 30] },
      { x: [3, 1, 1, 0], v: [30, 20, 40, 10] },
    ];
    for (const reduce of ["mean", "max", "min"] as const) {
      const rasters = orders.map(({ x, v }) =>
        Array.from(rasterOf(across(strip(x, v, { sampling: { reduce } }), 4).model).pixels),
      );
      expect(rasters[1]).toEqual(rasters[0]);
      expect(rasters[2]).toEqual(rasters[0]);
    }
    // A shared pixel reads the cell's value, its last row, though an earlier row is hotter;
    // reduce: "max" makes the hottest row the cell's.
    const x = [0, 1, 1, 3];
    const v = [10, 90, 20, 30];
    const last = rasterOf(across(strip(x, v, { sampling: { reduce: "max" } }), 4).model);
    expect([pixel(last, 0), pixel(last, 1)]).toEqual([gray(20), gray(20)]);
    const hottest = strip(x, v, { reduce: "max", sampling: { reduce: "max" } });
    const max = rasterOf(across(hottest, 4).model);
    expect([pixel(max, 0), pixel(max, 1)]).toEqual([gray(90), gray(90)]);
  });

  it("color shared pixels of values at the largest doubles", () => {
    const max = Number.MAX_VALUE;
    for (const sign of [1, -1]) {
      const values = [max, max, max, max].map((v) => v * sign);
      for (const width of [100, 552, 600]) {
        const config = strip([0, 0, 1, 3], values, { colorDomain: [-max, max] });
        const raster = rasterOf(build(config, width, 300).model);
        const top = new Uint8ClampedArray(4);
        new SequentialScale([-max, max], GRAY).write(sign * max, top, 0);
        for (let c = 0; c < raster.columns; c++) expect(pixel(raster, c)).toEqual(Array.from(top));
      }
    }
  });

  it("paint each cell once however many rows repeat it", () => {
    // 100,000 rows over nine uneven cells, each covering thousands of pixels.
    const count = 100_000;
    const x = Float64Array.from({ length: count }, (_, i) => [0, 1, 3][i % 3]!);
    const y = Float64Array.from({ length: count }, (_, i) => [0, 1, 3][Math.floor(i / 3) % 3]!);
    const v = Float64Array.from({ length: count }, (_, i) => (i % 2 === 0 ? 10 : 30));
    const data = table({ x, y, v });
    const start = performance.now();
    const { scene } = build({
      marks: [heatmap(data, { x: "x", y: "y", color: "v", colors: GRAY, colorDomain: [0, 100] })],
    });
    expect(performance.now() - start).toBeLessThan(1000);
    const raster = scene.panels[0]!.marks[0] as RasterGeometry;
    expect(raster.columns).toBe(Math.floor(scene.panels[0]!.plot.width));
    // Inside cell (0, 0), at the bottom left, its last row: 99,999, of 30.
    expect(pixel(raster, 5, raster.rows - 5)).toEqual(gray(30));
  });

  it("keep gaps between stepped cells transparent and out of the pointer's reach", () => {
    const { model } = across(strip([0, 1, 3], [10, 20, 30], { xStep: 1 }), 450);
    const raster = rasterOf(model);
    // A lattice of four slots, the third empty.
    expect([raster.columns, raster.rows]).toEqual([4, 1]);
    expect(pixel(raster, 2)).toEqual([0, 0, 0, 0]);
    expect(pixel(raster, 3)).toEqual(gray(30));
    const at = (x: number) => model.inspect(model.xScale()!.map(x), model.yScale()!.map(0));
    expect(at(2)).toBeUndefined();
    expect(at(2.6)!.points[0]!.value).toBe(30);
    expect(model.xScale()!.domain).toEqual([-0.5, 3.5]);
  });

  it("draw at fractional pixel ratios without losing a pixel", () => {
    const config = strip([0, 1, 3], [10, 20, 30]);
    for (const ratio of [1.25, 1.5, 1.75]) {
      const { scene } = build(config, 600, 300, ratio);
      const raster = scene.panels[0]!.marks[0] as RasterGeometry;
      expect(raster.columns).toBe(Math.floor(scene.panels[0]!.plot.width * ratio + 1e-6));
      expect(pixel(raster, raster.columns - 1)).toEqual(gray(30));
    }
  });

  it("summarize what each chart sharing the mark draws", () => {
    // Friday to Monday; one chart leaves weekends out.
    const friday = Date.UTC(2026, 0, 2);
    const data = table({
      day: time([0, 1, 2, 3].map((d) => friday + d * DAY)),
      row: [0, 0, 0, 0],
      v: [10, 20, 300, 40],
    });
    const mark = heatmap(data, { x: "day", y: "row", color: "v" });
    const all = build({ marks: [mark] }).model;
    const before = describeChart(all);
    expect(before).toContain("4 cells in 4 columns");
    const weekdays = build({
      x: { breaks: timeBreaks([{ weekdays: ["sat", "sun"] }]) },
      marks: [mark],
    });
    expect(describeChart(weekdays.model)).toContain("2 cells in 2 columns");
    expect(describeChart(all)).toBe(before);
  });

  it("refuse log axes", () => {
    expect(() => build(strip([1, 2, 3], [1, 2, 3], {}, { x: { type: "log" } }))).toThrow(
      "heatmap: cells cannot go on a log x axis yet",
    );
  });

  it("leave out cells a time break hides, and close up around it", () => {
    // Daily cells, Friday to Monday, with weekends left out: Friday's and
    // Monday's cells meet at the seam, a day wide each in the time shown.
    const friday = Date.UTC(2026, 0, 2);
    const days = [0, 1, 2, 3].map((d) => friday + d * DAY);
    const data = table({ day: time(days), row: [0, 0, 0, 0], v: [10, 20, 30, 40] });
    const { model, scene } = build({
      x: { breaks: timeBreaks([{ weekdays: ["sat", "sun"] }]) },
      marks: [
        heatmap(data, { x: "day", y: "row", color: "v", colors: GRAY, colorDomain: [0, 100] }),
      ],
    });
    const raster = scene.panels[0]!.marks[0] as RasterGeometry;
    const values = new Set<string>();
    for (let c = 0; c < raster.columns; c++) values.add(pixel(raster, c).join());
    expect(values).toEqual(new Set([gray(10).join(), gray(40).join()]));
    const at = (t: number) => model.inspect(model.xScale()!.map(t), model.yScale()!.map(0));
    expect(at(days[0]!)!.points[0]!.value).toBe(10);
    expect(at(days[3]!)!.points[0]!.value).toBe(40);
    expect(at(days[0]! + 13 * HOUR)!.points[0]!.value).toBe(40);
    expect(model.xScale()!.domain).toEqual([friday - 12 * HOUR, days[3]! + 12 * HOUR]);
    expect(raster.columns).toBe(2);
    // Saturday's cell is not drawn, nor is it a stop for the keyboard.
    const series = model.panelSeries("")[0]!;
    const first = model.stepCell("", series.key, -1, 0, 0)!;
    const next = model.stepCell("", series.key, first, 1, 0)!;
    expect(series.values[rowOf(series, next)]).toBe(40);
  });
});

describe("heatmaps zoomed and panned", () => {
  const grid = (side: number) => {
    const x: number[] = [];
    const y: number[] = [];
    const v: number[] = [];
    for (let r = 0; r < side; r++)
      for (let c = 0; c < side; c++) {
        x.push(c);
        y.push(r);
        v.push(c * 10 + r);
      }
    return table({ x, y, v });
  };

  it("end automatic domains at the cells' edges", () => {
    const { model } = build({ marks: [heatmap(grid(10), { x: "x", y: "y", color: "v" })] });
    expect(model.xScale()!.domain).toEqual([-0.5, 9.5]);
    expect(model.yScale()!.domain).toEqual([-0.5, 9.5]);
    // Asked for, round ends still come.
    const nice = build({
      y: { nice: true },
      marks: [heatmap(grid(10), { x: "x", y: "y", color: "v" })],
    });
    expect(nice.model.yScale()!.domain).not.toEqual([-0.5, 9.5]);
  });

  it("repaint when the view moves, and only then", () => {
    const { model } = build({
      interaction: { zoom: "xy" },
      marks: [heatmap(grid(40), { x: "x", y: "y", color: "v" })],
    });
    const write = vi.spyOn(SequentialScale.prototype, "write");
    rasterOf(model);
    expect(write).not.toHaveBeenCalled();
    model.setViewport([10.5, 20.5]);
    const zoomed = rasterOf(model);
    expect(write).toHaveBeenCalled();
    // Ten columns in view, a pixel each.
    expect(zoomed.columns).toBe(10);
    write.mockClear();
    rasterOf(model);
    expect(write).not.toHaveBeenCalled();
    model.setYViewport({ y: [0, 5], yRight: null });
    rasterOf(model);
    expect(write).toHaveBeenCalled();
  });

  it("clip cells at the plot's edges", () => {
    const { model, scene } = build({
      interaction: { zoom: "x" },
      marks: [heatmap(grid(4), { x: "x", y: "y", color: "v" })],
    });
    const plot = scene.panels[0]!.plot;
    model.setViewport([0, 2]);
    const raster = rasterOf(model);
    // Cells 0, 1, and 2 show; 0 and 2 half of each, past the plot's edges.
    expect(raster.columns).toBe(3);
    expect(raster.x).toBeCloseTo(plot.x - plot.width / 4, 6);
    expect(raster.width).toBeCloseTo(plot.width * 1.5, 6);
    const x = model.xScale()!;
    const y = model.yScale()!;
    expect(model.inspect(plot.x + 1, y.map(0))!.points[0]!.value).toBe(0);
    expect(model.inspect(x.map(1.6), y.map(3))!.points[0]!.value).toBe(23);
  });

  it("draw only the plot's pixels deep in a zoom", () => {
    const { model } = build({
      interaction: { zoom: "x" },
      marks: [heatmap(grid(4), { x: "x", y: "y", color: "v" })],
    });
    model.setViewport([1.4, 1.41]);
    const zoomed = model.scene(estimateText).panels[0]!;
    const raster = zoomed.marks[0] as RasterGeometry;
    const plot = zoomed.plot;
    expect(raster.x).toBeCloseTo(plot.x, 6);
    expect(raster.width).toBeCloseTo(plot.width, 6);
    expect(raster.columns).toBe(Math.floor(plot.width));
    expect(pixel(raster, 0, 0)).toEqual(pixel(raster, raster.columns - 1, 0));
  });

  it("fit y to the columns x shows", () => {
    // Column 0 holds rows 0 to 9; column 9, rows 4 and 5.
    const x = [...Array(10).keys()].map(() => 0).concat([9, 9]);
    const y = [...Array(10).keys()].concat([4, 5]);
    const data = table({ x, y, v: y });
    const { model } = build({
      interaction: { zoom: "x" },
      marks: [heatmap(data, { x: "x", y: "y", color: "v" })],
    });
    expect(model.yScale()!.domain).toEqual([-0.5, 9.5]);
    model.setViewport([8.6, 10]);
    model.scene(estimateText);
    expect(model.yScale()!.domain).toEqual([3.5, 5.5]);
  });

  it("pans with the viewport, cells keeping their edges", () => {
    const { model } = build({
      interaction: { zoom: "x" },
      marks: [heatmap(grid(10), { x: "x", y: "y", color: "v" })],
    });
    // Cell c spans [c - 0.5, c + 0.5) wherever the view is.
    for (const [view, edge] of [
      [[2, 4], 3.5],
      [[2.25, 4.25], 3.5],
      [[5.5, 7.5], 6.5],
    ] as const) {
      model.setViewport(view);
      model.scene(estimateText);
      const x = model.xScale()!;
      const y = model.yScale()!;
      const value = (at: number) => model.inspect(x.map(at), y.map(0))?.points[0]?.value;
      expect([value(edge - 0.01), value(edge + 0.01)]).toEqual([
        (edge - 0.5) * 10,
        (edge + 0.5) * 10,
      ]);
    }
  });
});

describe("heatmap tooltips, keyboard, and summaries on number axes", () => {
  // Hours 0, 1, and 3 (2 missing) over two days; one cell without a value.
  const hours = table({
    hour: [0, 1, 3, 0, 1, 3],
    day: [0, 0, 0, 1, 1, 1],
    load: [1, 2, 3, 4, Number.NaN, 6],
  });

  it("name cells by their values", () => {
    const { model } = build({ marks: [heatmap(hours, { x: "hour", y: "day", color: "load" })] });
    const inspection = model.inspect(model.xScale()!.map(3), model.yScale()!.map(1))!;
    expect(inspection.label).toBe("3");
    expect(inspection.points[0]).toMatchObject({ label: "1", value: 6, row: 5 });
    expect(model.inspect(model.xScale()!.map(1), model.yScale()!.map(1))).toBeUndefined();
    expect(describeChart(model)).toContain(
      "load: 5 cells in 3 columns and 2 rows, lowest 1 at 0, 0, highest 6 at 3, 1.",
    );
  });

  it("step cell by cell in value order, over missing ones, and back on reversed axes", () => {
    for (const reversed of [false, true]) {
      const { model } = build({
        ...(reversed && { x: { domain: [4, -1] } }),
        marks: [heatmap(hours, { x: "hour", y: "day", color: "load" })],
      });
      const series = model.panelSeries("")[0]!;
      const value = (position: number | undefined) =>
        position === undefined ? undefined : series.values[rowOf(series, position)];
      const step = (position: number, columns: number, rows: number) =>
        model.stepCell("", series.key, position, columns, rows);
      // Entering: the top left cell, day 1 (rows rise), the reversed axis' hour 3.
      const first = step(-1, 0, 0)!;
      expect(value(first)).toBe(reversed ? 6 : 4);
      // Right: to the next cell on screen; hour 1 of day 1 has no value.
      const right = step(first, 1, 0)!;
      expect(value(right)).toBe(reversed ? 4 : 6);
      // Down to day 0.
      expect(value(step(right, 0, -1))).toBe(reversed ? 1 : 3);
    }
  });
});

describe("heatmap keyboard steps on sparse grids", () => {
  it("find the cell a scan of every cell would", () => {
    // 2,000 random cells of a 150 x 150 grid, some repeated.
    let state = 5;
    const next = () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
    const x = Array.from({ length: 2000 }, () => Math.floor(next() * 150));
    const y = Array.from({ length: 2000 }, () => Math.floor(next() * 150));
    const data = table({ x, y, v: x.map((_, i) => i) });
    for (const reversed of [false, true]) {
      const { model } = build({
        ...(reversed && { x: { domain: [200, -50] } }),
        marks: [heatmap(data, { x: "x", y: "y", color: "v", xStep: 1, yStep: 1 })],
      });
      const series = model.panelSeries("")[0]!;
      // The last row of each cell is the one drawn there.
      const last = new Map<string, number>();
      for (let row = 0; row < x.length; row++) last.set(`${x[row]},${y[row]}`, row);
      const cells = [...last.entries()].map(([key, row]) => {
        const [c, r] = key.split(",").map(Number) as [number, number];
        return { c: reversed ? -c : c, r, row };
      });
      // The scan's rule: the nearest cell ahead in the same row or column,
      // else the nearest ahead in another, nearest across.
      const expected = (row: number, dc: number, dr: number) => {
        const c0 = reversed ? -x[row]! : x[row]!;
        const r0 = y[row]!;
        let best: { rank: number[]; row: number } | undefined;
        for (const { c, r, row: other } of cells) {
          const offset = dc ? (c - c0) * dc : (r - r0) * dr;
          if (offset <= 0) continue;
          const across = Math.abs(dc ? r - r0 : c - c0);
          const rank = [across === 0 ? 0 : 1, offset, across];
          const better =
            !best ||
            rank[0]! < best.rank[0]! ||
            (rank[0] === best.rank[0] &&
              (rank[1]! < best.rank[1]! || (rank[1] === best.rank[1] && rank[2]! < best.rank[2]!)));
          if (better) best = { rank, row: other };
        }
        return best?.row;
      };
      const step = (row: number, dc: number, dr: number) => {
        const position = model.stepCell("", series.key, row, dc, dr);
        return position === undefined ? undefined : rowOf(series, position);
      };
      const corner = cells.reduce((a, b) => (b.r > a.r || (b.r === a.r && b.c < a.c) ? b : a));
      expect(rowOf(series, model.stepCell("", series.key, -1, 0, 0)!)).toBe(corner.row);
      for (const { row } of cells.slice(0, 300))
        for (const [dc, dr] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const)
          expect(step(row, dc, dr)).toBe(expected(row, dc, dr));
    }
  });
});

describe("heatmaps on number axes in panels", () => {
  const load = table({
    region: ["N", "N", "S", "S", "N", "S"],
    hour: [0, 1, 2, 3, 1, 3],
    host: ["p", "p", "p", "p", "q", "q"],
    cpu: [1, 2, 3, 4, 5, 6],
  });

  it("give facet panels' x scales the cells their rows hold", () => {
    const { model, scene } = build({
      marks: [heatmap(load, { x: "hour", y: "host", color: "cpu" })],
      facet: facet("region"),
      resolve: { x: "independent" },
    });
    const [n, s] = model.panels();
    expect(n!.x.domain).toEqual([-0.5, 1.5]);
    expect(s!.x.domain).toEqual([1.5, 3.5]);
    const rasters = scene.panels.map((p) => p.marks[0] as RasterGeometry);
    expect(rasters.map((r) => r.columns)).toEqual([2, 2]);
    const at = (panel: number, hour: number, host: number) => {
      const { x, y, key } = model.panels()[panel]!;
      return model.inspect(x.map(hour), y.map(host), undefined, key)?.points[0]?.value;
    };
    expect(at(0, 1, 1)).toBe(5);
    expect(at(1, 3, 1)).toBe(6);
    expect(at(1, 2, 1)).toBeUndefined();
  });

  it("sum each panel's rows in its cells, on one ramp over every panel's sums", () => {
    // Both panels have a cell at hour 0 of host p: 1 + 2 in one, 9 + 1 in the other.
    const shared = table({
      region: ["N", "N", "S", "S", "S"],
      hour: [0, 0, 0, 1, 0],
      host: ["p", "p", "p", "p", "p"],
      cpu: [1, 2, 9, 4, 1],
    });
    const { model, scene } = build({
      marks: [heatmap(shared, { x: "hour", y: "host", color: "cpu", reduce: "sum" })],
      facet: facet("region"),
      legend: true,
    });
    expect([scene.colorLegends[0]!.low.text, scene.colorLegends[0]!.high.text]).toEqual([
      "3",
      "10",
    ]);
    const at = (panel: number, hour: number) => {
      const { x, y, key } = model.panels()[panel]!;
      return model.inspect(x.map(hour), y.map(0), undefined, key)?.points[0]?.value;
    };
    // The panels combine their cells into one buffer, each at its own rows.
    expect([at(0, 0), at(1, 0), at(1, 1), at(0, 0)]).toEqual([3, 10, 4, 3]);
    const rasters = scene.panels.map((p) => p.marks[0] as RasterGeometry);
    expect(Array.from(rasters[1]!.pixels.subarray(0, 4))).not.toEqual(
      Array.from(rasters[0]!.pixels.subarray(0, 4)),
    );
    // Means of values near the largest doubles stay finite.
    const meanOf = (v: number[]) => {
      const huge = table({ x: v.map(() => 0), y: v.map(() => 0), v });
      const { model } = build({
        marks: [heatmap(huge, { x: "x", y: "y", color: "v", reduce: "mean" })],
      });
      return model.inspect(300, 150)?.points[0]?.value;
    };
    const max = Number.MAX_VALUE;
    expect(meanOf([1e308, 1e308])).toBe(1e308);
    expect(meanOf([max, max, max])).toBe(max);
    expect(meanOf(Array.from({ length: 11 }, () => -max))).toBe(-max);
    expect(meanOf([max, max, -max])! / (max / 3)).toBeCloseTo(1, 12);
  });

  it("share cells across panels sharing x, each drawing only its rows", () => {
    const { model } = build({
      marks: [heatmap(load, { x: "hour", y: "host", color: "cpu" })],
      facet: facet("region"),
    });
    for (const panel of model.panels()) expect(panel.x.domain).toEqual([-0.5, 3.5]);
    const n = model.panels()[0]!;
    expect(model.inspect(n.x.map(3), n.y.map(0), undefined, n.key)).toBeUndefined();
  });

  it("draw in subplots beside lines on x scales of their own", () => {
    const { model, scene } = build({
      panels: panels([{ id: "cells" }, { id: "line", x: { type: "linear" } }]),
      resolve: { x: "independent" },
      marks: [heatmap(load, { x: "hour", y: "host", color: "cpu", panel: "cells" })],
    });
    expect(scene.panels[0]!.marks[0]!.kind).toBe("raster");
    expect(model.panels()[0]!.x.domain).toEqual([-0.5, 3.5]);
  });
});

describe("heatmap specs", () => {
  const data = { t: { columns: { x: [0, 1, 3], y: [0, 0, 0], v: [1, 2, 3] } } };
  const spec = (mark: object): ChartSpec =>
    ({
      data,
      marks: [{ type: "heatmap", x: "x", y: "y", color: "v", ...mark }],
    }) as ChartSpec;
  const axisTypes = (s: ChartSpec) => {
    const { config } = loadSpec(s);
    const { model } = build(config);
    return [model.xScale()!.type, model.yScale()!.type];
  };

  it("place number and time fields on number and time axes, or in bands", () => {
    expect(axisTypes(spec({}))).toEqual(["linear", "linear"]);
    expect(axisTypes(spec({ xBanded: true }))).toEqual(["band", "linear"]);
    expect(axisTypes(spec({ xStep: 1 }))).toEqual(["linear", "linear"]);
  });

  it("check steps and bands", () => {
    expect(() => validateSpec(spec({ xBanded: true, yBanded: false }))).not.toThrow();
    expect(() => validateSpec(spec({ xStep: 0 }))).toThrow(/xStep/);
    expect(() => validateSpec(spec({ xStep: 1, xBanded: true }))).toThrow(/no xStep with xBanded/);
  });

  it("refuse steps on categories and with bands", () => {
    const cells = table({ c: ["a", "b"], n: [1, 2], v: [1, 2] });
    expect(() => heatmap(cells, { x: "c", y: "n", color: "v", xStep: 1 })).toThrow(
      /heatmap xStep: sizes cells along a number or time x axis; "c" holds categories, so drop xStep/,
    );
    expect(() =>
      heatmap(cells, { x: "n", y: "n", color: "v", yStep: 1, yBanded: true as false }),
    ).toThrow(/heatmap yStep: .*; drop it or yBanded/);
    expect(() => heatmap(cells, { x: "n", y: "n", color: "v", xStep: -1 })).toThrow(
      /heatmap xStep: expected a positive number; received -1/,
    );
    // Categories are banded, asked or not.
    expect(() => heatmap(cells, { x: "c", y: "n", color: "v", xBanded: true })).not.toThrow();
  });
});

describe("heatmap cells between edges", () => {
  // Bins of x by unequal edges and of y by a width, counted: what a 2D
  // histogram draws, built from transforms.
  const points = table({
    x: [0.5, 1, 1.5, 4, 9, 9.5, 2],
    y: [0, 1, 2, 8, 9, 9, 3],
  });
  const binned = derive(points)
    .bin("x", { bins: [0, 2, 10], as: "x0", end: "x1" })
    .bin("y", { bins: { step: 5 }, as: "y0", end: "y1" })
    .aggregate({ by: ["x0", "x1", "y0", "y1"], ops: { n: count() } })
    .table();

  it("span their edges, as bins do, and say them in tooltips", () => {
    const { model, scene } = build({
      marks: [heatmap(binned, { x1: "x0", x2: "x1", y1: "y0", y2: "y1", color: "n" })],
    });
    expect(model.xScale()!.domain).toEqual([0, 10]);
    expect(model.yScale()!.domain).toEqual([0, 10]);
    const raster = scene.panels[0]!.marks.find((m) => m.kind === "raster") as RasterGeometry;
    // Unequal cells are painted at the plot's resolution.
    expect(raster.columns).toBe(Math.floor(scene.panels[0]!.plot.width));
    const point = model.inspect(model.xScale()!.map(5), model.yScale()!.map(9))!.points[0]!;
    expect(point).toMatchObject({ label: "5 – 10", text: "2 – 10: 3", value: 3 });
    // Between the cells: nothing.
    expect(model.inspect(model.xScale()!.map(1), model.yScale()!.map(8))).toBeUndefined();
  });

  it("leave rows without a usable pair of edges out of cells, clicks, and sums", () => {
    // Row 1 has no right edge: it is in no cell, though it starts where row 0's does.
    const edges = table({ a: [0, 0, 1], b: [1, Number.NaN, 2], y: [0, 0, 0], v: [1, 2, 3] });
    const { model, scene } = build({
      marks: [heatmap(edges, { x1: "a", x2: "b", y: "y", color: "v", reduce: "sum" })],
      legend: true,
    });
    const [px, py] = [model.xScale()!.map(0.5), model.yScale()!.map(0)];
    expect(model.inspect(px, py)!.points[0]!.value).toBe(1);
    expect(Array.from(clickedRows(model, new Set([edges as never]), px, py)!.rows)).toEqual([0]);
    expect([scene.colorLegends[0]!.low.text, scene.colorLegends[0]!.high.text]).toEqual(["1", "3"]);
    // A row of no category has no band, so it adds to no sum either.
    const named = table({ x: ["a", null, "c"], y: ["b", "b", "b"], v: [1, 100, 3] });
    const banded = build({
      marks: [heatmap(named, { x: "x", y: "y", color: "v", reduce: "sum" })],
      legend: true,
    }).scene.colorLegends[0]!;
    expect([banded.low.text, banded.high.text]).toEqual(["1", "3"]);
  });

  it("lie on a lattice when they are one width apart", () => {
    const even = table({ a: [0, 10, 30], b: [10, 20, 40], y: [0, 0, 0], v: [1, 2, 3] });
    const { scene } = build({ marks: [heatmap(even, { x1: "a", x2: "b", y: "y", color: "v" })] });
    const raster = scene.panels[0]!.marks.find((m) => m.kind === "raster") as RasterGeometry;
    // One pixel per slot of the lattice: four, the third empty.
    expect(raster.columns).toBe(4);
  });

  it("refuse cells that overlap, starts with two ends, and other placements of the axis", () => {
    const cells = table({ a: [0, 1, 0], b: [2, 3, 5], y: [0, 0, 1], v: [1, 2, 3] });
    const draw = (options: Partial<HeatmapOptions<never>>) => () =>
      build({ marks: [heatmap(cells, { y: "y", color: "v", ...(options as object) } as never)] });
    expect(draw({ x1: "a", x2: "b" } as never)).toThrow(
      /heatmap x1: rows from 0 end at 2 and at 5; give each cell one x2/,
    );
    const overlapping = table({ a: [0, 1], b: [2, 3], y: [0, 0], v: [1, 2] });
    expect(() =>
      build({ marks: [heatmap(overlapping, { x1: "a", x2: "b", y: "y", color: "v" })] }),
    ).toThrow(/heatmap x1: the cells from 0 to 2 and from 1 to 3 overlap/);
    expect(() => heatmap(cells, { x: "a", x1: "a", x2: "b", y: "y", color: "v" } as never)).toThrow(
      /heatmap x1: x places cells at values, x1 and x2 between edges; give one form/,
    );
    expect(() => heatmap(cells, { x1: "a", y: "y", color: "v" } as never)).toThrow(
      /heatmap x2: missing; cells between edges need x1 and x2/,
    );
    expect(() =>
      heatmap(cells, { x1: "a", x2: "b", xStep: 1, y: "y", color: "v" } as never),
    ).toThrow(/heatmap xStep: cells between x1 and x2 take their edges from them; drop xStep/);
    const mixed = table({ a: [0], b: time([1]), y: [0], v: [1] });
    expect(() => heatmap(mixed, { x1: "a", x2: "b", y: "y", color: "v" })).toThrow(
      /heatmap x2: field "b" holds time values and x1's "a" number values; give edges of one kind/,
    );
  });

  it("load from specs", () => {
    const spec: ChartSpec = {
      data: { t: { columns: { a: [0, 2], b: [2, 10], c: [0, 0], d: [1, 1], v: [3, 4] } } },
      marks: [{ type: "heatmap", x1: "a", x2: "b", y1: "c", y2: "d", color: "v" }],
    };
    expect(() => validateSpec(spec)).not.toThrow();
    const { model } = build(loadSpec(spec).config);
    expect(model.xScale()!.domain).toEqual([0, 10]);
  });
});
