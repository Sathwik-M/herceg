// Heatmaps with more cells than the plot has pixels: reduced rasters,
// picking through the cell index, and band axes with many categories.
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Schema, type Table, table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { type HeatmapOptions, heatmap } from "../../src/marks/heatmap.ts";
import { type ChartConfig, ChartModel, STATIC_RASTER_RATIO } from "../../src/model/model.ts";
import { renderToPDF } from "../../src/pdf.ts";
import { measurePdfText } from "../../src/render/pdf-fonts.ts";
import { renderToSVG } from "../../src/render/static.ts";
import { SequentialScale } from "../../src/scale/color.ts";
import type { RasterGeometry } from "../../src/scene/scene.ts";
import { loadSpec } from "../../src/spec/load.ts";

const GRAY = ["#000000", "#ffffff"];

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
  model.scene(estimateText).panels[0]!.marks[0] as RasterGeometry;

/** The RGBA bytes a value is painted with on a gray ramp over [0, 100]. */
function gray(value: number): number[] {
  const out = new Uint8ClampedArray(4);
  new SequentialScale([0, 100], GRAY).write(value, out, 0);
  return Array.from(out);
}

const pixel = (raster: RasterGeometry, column: number, row: number) =>
  Array.from(
    raster.pixels.subarray(
      (row * raster.columns + column) * 4,
      (row * raster.columns + column) * 4 + 4,
    ),
  );

/**
 * A grid of `columns` x `rows` cells, one row per cell in row-major order
 * with value `cellValue(c, r)` (undefined leaves the cell out).
 */
type Grid = Table<{ x: "category" | "number"; y: "category" | "number"; v: "number" }>;

function grid(
  columns: number,
  rows: number,
  cellValue: (c: number, r: number) => number | undefined,
  kind: "category" | "number" = "category",
): Grid {
  const x: (string | number)[] = [];
  const y: (string | number)[] = [];
  const v: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const value = cellValue(c, r);
      if (value === undefined) continue;
      x.push(kind === "category" ? `c${c}` : c);
      y.push(kind === "category" ? `r${r}` : r);
      v.push(value);
    }
  }
  const data =
    kind === "category"
      ? table({ x: x as string[], y: y as string[], v })
      : table({ x: Float64Array.from(x as number[]), y: Float64Array.from(y as number[]), v });
  return data as Grid;
}

/**
 * Builds the heatmap with a raster of `across` x `down` pixels at most, by
 * choosing the raster ratio from the plot's width and the chart's height.
 */
function reduced(
  data: Grid,
  across: number,
  down: number,
  options: Pick<HeatmapOptions<Schema>, "reduce" | "sampling"> = {},
) {
  const config: ChartConfig = {
    x: { show: false },
    y: { show: false },
    marks: [
      heatmap(data, {
        x: "x",
        y: "y",
        color: "v",
        colors: GRAY,
        colorDomain: [0, 100],
        ...options,
      }),
    ],
  };
  const { scene } = build(config);
  const plot = scene.panels[0]!.plot;
  // Just over `across` (`down`) raster pixels over the plot, which the raster rounds down.
  const ratio = (across + 0.5) / plot.width;
  const height = 300 - plot.height + (down + 0.5) / ratio;
  const { model } = build(config, 600, height, 1, ratio);
  return { model, raster: rasterOf(model) };
}

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

afterEach(() => vi.restoreAllMocks());

describe("reduced heatmaps", () => {
  it("colors each pixel by the mean of the values in its block of cells", () => {
    // 7 x 5 cells into 3 x 2 pixels: each cell goes to the pixel its start
    // edge lies in, so column blocks are {0, 1, 2}, {3, 4}, {5, 6} and row
    // blocks {0, 1, 2}, {3, 4} (categories run top to bottom).
    const cellValue = (c: number, r: number) => (c === 4 && r === 4 ? undefined : c * 10 + r);
    const { raster } = reduced(grid(7, 5, cellValue), 3, 2);
    expect([raster.columns, raster.rows]).toEqual([3, 2]);
    const blockMean = (cs: number[], rs: number[]) =>
      mean(cs.flatMap((c) => rs.map((r) => cellValue(c, r))).filter((v) => v !== undefined));
    const columnBlocks = [
      [0, 1, 2],
      [3, 4],
      [5, 6],
    ];
    const rowBlocks = [
      [0, 1, 2],
      [3, 4],
    ];
    rowBlocks.forEach((rs, line) => {
      columnBlocks.forEach((cs, column) => {
        expect(pixel(raster, column, line)).toEqual(gray(blockMean(cs, rs)));
      });
    });
    // The block missing cell (4, 4) averages the three it has.
    expect(blockMean([3, 4], [3, 4])).toBe((33 + 34 + 43) / 3);
  });

  it("leaves out missing values and leaves empty blocks transparent", () => {
    // Only the first column block has values: rows with NaN still make
    // their bands, but add nothing to a block.
    const cellValue = (c: number, r: number) => (c > 2 || (c === 0 && r === 0) ? Number.NaN : 50);
    const { raster } = reduced(grid(7, 5, cellValue), 3, 2);
    expect(pixel(raster, 0, 0)).toEqual(gray(50));
    expect(pixel(raster, 1, 0)).toEqual([0, 0, 0, 0]);
    expect(pixel(raster, 2, 1)).toEqual([0, 0, 0, 0]);
  });

  it("puts the first bands of numbers at the bottom", () => {
    // Rows 0..4 of numbers rise from the bottom: the top pixel row covers
    // rows 4, 3, 2 and the bottom one rows 1, 0.
    const cellValue = (_c: number, r: number) => r * 20;
    const { raster } = reduced(grid(4, 5, cellValue, "number"), 2, 2);
    expect([raster.columns, raster.rows]).toEqual([2, 2]);
    expect(pixel(raster, 0, 0)).toEqual(gray(mean([80, 60, 40])));
    expect(pixel(raster, 1, 1)).toEqual(gray(mean([20, 0])));
  });

  it("colors blocks by their greatest or least value on request", () => {
    const cellValue = (c: number, r: number) => (c * 7 + r * 13) % 100;
    const data = grid(7, 5, cellValue);
    const values = (cs: number[], rs: number[]) =>
      cs.flatMap((c) => rs.map((r) => cellValue(c, r)));
    const max = reduced(data, 3, 2, { sampling: { reduce: "max" } }).raster;
    const min = reduced(data, 3, 2, { sampling: { reduce: "min" } }).raster;
    expect(pixel(max, 1, 1)).toEqual(gray(Math.max(...values([3, 4], [3, 4]))));
    expect(pixel(min, 2, 0)).toEqual(gray(Math.min(...values([5, 6], [0, 1, 2]))));
    expect(() =>
      heatmap(data, { x: "x", y: "y", color: "v", sampling: { reduce: "median" as "mean" } }),
    ).toThrow(/heatmap sampling\.reduce: expected "mean", "max", or "min"; received "median"/);
    expect(() => heatmap(data, { x: "x", y: "y", color: "v", reduce: "median" as "mean" })).toThrow(
      /heatmap reduce: expected "last", "mean", "sum", "min", or "max"; received "median"/,
    );
  });

  it("reduces only the axis with more cells than pixels", () => {
    const { raster } = reduced(
      grid(9, 2, (c) => c * 10),
      3,
      50,
    );
    expect([raster.columns, raster.rows]).toEqual([3, 2]);
    // Cells 0-2 average to 10 in both rows.
    expect(pixel(raster, 0, 1)).toEqual(gray(10));
  });

  it("keeps one pixel per cell for grids within the plot's pixels", () => {
    const data = grid(40, 30, (c, r) => c + r);
    const config: ChartConfig = { marks: [heatmap(data, { x: "x", y: "y", color: "v" })] };
    // 40 columns on a plot of a few hundred device pixels, at any ratio.
    for (const ratio of [1, 2]) {
      const raster = build(config, 600, 300, ratio).scene.panels[0]!.marks[0] as RasterGeometry;
      expect([raster.columns, raster.rows]).toEqual([40, 30]);
    }
  });

  it("repaints only when the data, size, or theme change", () => {
    const data = grid(300, 200, (c, r) => c * r);
    const { model } = build({ marks: [heatmap(data, { x: "x", y: "y", color: "v" })] }, 300, 200);
    const write = vi.spyOn(SequentialScale.prototype, "write");
    const before = rasterOf(model);
    write.mockClear();
    const after = rasterOf(model);
    expect(write).not.toHaveBeenCalled();
    expect(after.pixels).toEqual(before.pixels);
    data.replace("v", 0, [1]);
    rasterOf(model);
    expect(write).toHaveBeenCalled();
    write.mockClear();
    model.setSize(340, 200, 1);
    rasterOf(model);
    expect(write).toHaveBeenCalled();
  });

  it("repaints a buffer another heatmap painted in its place", () => {
    const data = grid(300, 200, (c, r) => (c + r) % 100);
    const options = { x: "x", y: "y", color: "v", colorDomain: [0, 100] } as const;
    const gray = heatmap(data, { ...options, colors: GRAY });
    const red = heatmap(data, { ...options, colors: ["#000000", "#ff0000"] });
    const config = (mark: typeof gray): ChartConfig => ({ legend: false, marks: [mark] });
    const model = new ChartModel(config(gray));
    model.setSize(300, 200, 1);
    const first = Array.from(rasterOf(model).pixels);
    model.update(config(red));
    expect(Array.from(rasterOf(model).pixels)).not.toEqual(first);
    model.update(config(gray));
    expect(Array.from(rasterOf(model).pixels)).toEqual(first);
  });

  it("averages values near the largest doubles, beside tiny ones", () => {
    const huge = 1e308;
    // Six cells in two pixels: tiny values in one, huge ones that overflow a sum in the other.
    const values = [1e-20, 2e-20, 3e-20, huge, huge, -huge];
    const data = grid(6, 1, (c) => values[c]);
    const expectMean = (domain: [number, number], column: number, value: number) => {
      const model = new ChartModel({
        x: { show: false },
        y: { show: false },
        legend: false,
        marks: [heatmap(data, { x: "x", y: "y", color: "v", colors: GRAY, colorDomain: domain })],
      });
      model.setSize(600, 300, 1, 2.5 / model.scene(estimateText).panels[0]!.plot.width);
      const raster = rasterOf(model);
      expect(raster.columns).toBe(2);
      const expected = new Uint8ClampedArray(4);
      new SequentialScale(domain, GRAY).write(value, expected, 0);
      expect(pixel(raster, column, 0)).toEqual(Array.from(expected));
    };
    expectMean([0, 4e-20], 0, 2e-20);
    expectMean([-huge, huge], 1, huge / 3);
  });

  it("keeps one pixel per cell when the grid fits a fractional pixel ratio exactly", () => {
    const config = (columns: number): ChartConfig => ({
      x: { show: false },
      y: { show: false },
      legend: false,
      marks: [
        heatmap(
          grid(columns, 1, (c) => (c % 2 === 0 ? 100 : 0)),
          { x: "x", y: "y", color: "v", colors: GRAY, colorDomain: [0, 100] },
        ),
      ],
    });
    const width = build(config(10)).scene.panels[0]!.plot.width;
    for (const ratio of [1.25, 1.5, 1.75]) {
      const columns = width * ratio;
      expect(Number.isInteger(columns)).toBe(true);
      const raster = build(config(columns), 600, 300, ratio).scene.panels[0]!
        .marks[0] as RasterGeometry;
      expect(raster.columns).toBe(columns);
      expect(pixel(raster, 0, 0)).toEqual(gray(100));
    }
  });

  it("counts more values in a pixel than a float counts exactly", () => {
    // 2^24 + 2 rows of 1 in two cells drawn as one pixel: their mean is 1.
    const count = 2 ** 24 + 2;
    const x = new Uint8Array(count);
    x[count - 1] = 1;
    const data = table({ x, y: new Uint8Array(count), v: new Uint8Array(count).fill(1) });
    const model = new ChartModel({
      legend: false,
      marks: [heatmap(data, { x: "x", y: "y", color: "v", colors: GRAY, colorDomain: [0, 2] })],
    });
    model.setSize(600, 300, 1, 1 / 1000);
    const raster = rasterOf(model);
    expect(raster.columns).toBe(1);
    const expected = new Uint8ClampedArray(4);
    new SequentialScale([0, 2], GRAY).write(1, expected, 0);
    expect(pixel(raster, 0, 0)).toEqual(Array.from(expected));
  });

  it("reports the cell under the pointer, not the block's", () => {
    const cellValue = (c: number, r: number) => (c === 1 ? Number.NaN : c * 10 + r);
    const { model, raster } = reduced(grid(7, 5, cellValue), 3, 2);
    expect(raster.columns).toBe(3);
    const x = model.xScale()!;
    const y = model.yScale()!;
    expect(model.inspect(x.map(2), y.map(3))!.points[0]).toMatchObject({ label: "r3", value: 23 });
    expect(model.inspect(x.map(0), y.map(4))!.points[0]!.value).toBe(4);
    // Cell (1, 0) has no value, though its pixel shows its neighbors'.
    expect(pixel(raster, 0, 0)[3]).toBe(255);
    expect(model.inspect(x.map(1), y.map(0))).toBeUndefined();
  });

  it("draws and picks a sparse 4,000 x 4,000 grid", () => {
    const side = 4000;
    const count = 200_000;
    let state = 11;
    const next = () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
    // The diagonal puts every band on both axes; the rest are random cells.
    const c = Float64Array.from({ length: count }, (_, i) =>
      i < side ? i : Math.floor(next() * side),
    );
    const r = Float64Array.from({ length: count }, (_, i) =>
      i < side ? i : Math.floor(next() * side),
    );
    const v = Float64Array.from({ length: count }, (_, i) => i);
    const data = table({ c, r, v });
    const mark = heatmap(data, { x: "c", y: "r", color: "v" });
    const start = performance.now();
    const { model, scene } = build({ marks: [mark] }, 800, 400, 2);
    const raster = scene.panels[0]!.marks[0] as RasterGeometry;
    const plot = scene.panels[0]!.plot;
    expect(raster.columns).toBe(Math.floor(raster.width * 2));
    expect(raster.columns).toBeLessThanOrEqual(Math.floor(plot.width * 2));
    expect(raster.rows).toBeLessThanOrEqual(Math.floor(plot.height * 2));
    expect(raster.pixels.length).toBe(raster.columns * raster.rows * 4);
    const x = model.xScale()!;
    const y = model.yScale()!;
    // The last row in each picked cell is the one reported.
    const last = new Map<number, number>();
    for (let row = 0; row < count; row++) last.set(r[row]! * side + c[row]!, row);
    for (const row of [0, 1234, 3999, 50_000, 199_999]) {
      const inspection = model.inspect(x.map(c[row]!), y.map(r[row]!))!;
      expect(inspection.points[0]!.value).toBe(last.get(r[row]! * side + c[row]!));
    }
    expect(performance.now() - start).toBeLessThan(5000);
  });

  it("exports reduced heatmaps to SVG and PDF at two pixels per CSS pixel", () => {
    const data = grid(1200, 3, (c, r) => (c + r) % 100, "number");
    const options = {
      width: 400,
      height: 200,
      locale: "en-US",
      marks: [heatmap(data, { x: "x", y: "y", color: "v" })],
    };
    const svg = renderToSVG(options);
    const href = /<image [^>]*href="data:image\/png;base64,([^"]+)"/.exec(svg)![1]!;
    const png = Uint8Array.from(atob(href), (ch) => ch.charCodeAt(0));
    const view = new DataView(png.buffer);
    const [width, height] = [view.getUint32(16), view.getUint32(20)];
    const plotWidth = Number(/<image x="[\d.]+" y="[\d.]+" width="([\d.]+)"/.exec(svg)![1]);
    expect(width).toBe(Math.floor(plotWidth * 2));
    expect(height).toBe(3);
    // PDF layout measures text in the PDF's fonts, so its plot is its own.
    const model = new ChartModel(options);
    model.setSize(400, 200, 1, STATIC_RASTER_RATIO);
    model.scene(measurePdfText);
    const pdfWidth = Math.floor(model.panels()[0]!.plot.width * 2);
    const pdf = new TextDecoder("latin1").decode(renderToPDF(options));
    expect(pdf).toContain(`/Subtype /Image /Width ${pdfWidth} /Height`);
  });

  it("takes reduce and sampling from specs", () => {
    const data = { t: { columns: { x: [0, 1, 2, 3], y: [0, 0, 0, 0], v: [1, 9, 2, 8] } } };
    const { config } = loadSpec({
      data,
      marks: [
        { type: "heatmap", x: "x", y: "y", color: "v", reduce: "sum", sampling: { reduce: "max" } },
      ],
    });
    expect(config.marks[0]!.spec).toMatchObject({ reduce: "sum", sampling: { reduce: "max" } });
    expect(() =>
      loadSpec({
        data,
        marks: [{ type: "heatmap", x: "x", y: "y", color: "v", reduce: "median" as "max" }],
      }),
    ).toThrow(/reduce/);
    expect(() =>
      loadSpec({
        data,
        marks: [
          { type: "heatmap", x: "x", y: "y", color: "v", sampling: { reduce: "sum" as "max" } },
        ],
      }),
    ).toThrow(/sampling\.reduce/);
  });
});

describe("band axes with many categories", () => {
  const hosts = Array.from({ length: 10_000 }, (_, i) => `host-${String(i).padStart(5, "0")}`);

  it("thins labels and measures each one once", () => {
    const data = table({
      host: hosts,
      day: hosts.map((_, i) => `d${i % 7}`),
      v: hosts.map((_, i) => i),
    });
    let measured = 0;
    const measure = (text: string, font: string) => {
      measured++;
      return estimateText(text, font);
    };
    const model = new ChartModel({
      locale: "en-US",
      marks: [heatmap(data, { x: "host", y: "day", color: "v" })],
    });
    model.setSize(800, 400, 2);
    const start = performance.now();
    const scene = model.scene(measure);
    const first = measured;
    model.setSize(820, 400, 2);
    measured = 0;
    model.scene(measure);
    expect(performance.now() - start).toBeLessThan(1000);
    // Every label once for the widest, then only the shown ones.
    expect(first).toBeGreaterThanOrEqual(10_000);
    expect(measured).toBeLessThan(100);
    const ticks = scene.panels[0]!.axes.find((a) => a.orient === "bottom")!.ticks;
    const width = estimateText("host-00000", "12px sans-serif");
    expect(ticks.length).toBeLessThanOrEqual(Math.ceil(800 / width));
    expect(ticks.length).toBeGreaterThan(5);
    for (let i = 1; i < ticks.length; i++)
      expect(ticks[i]!.position - ticks[i - 1]!.position).toBeGreaterThan(width);
  });

  it("thins a category y axis to one label per line", () => {
    const data = table({
      host: hosts,
      day: hosts.map((_, i) => `d${i % 7}`),
      v: hosts.map((_, i) => i),
    });
    const { scene } = build(
      { marks: [heatmap(data, { x: "day", y: "host", color: "v" })] },
      600,
      400,
    );
    const ticks = scene.panels[0]!.axes.find((a) => a.orient === "left")!.ticks;
    expect(ticks.length).toBeGreaterThan(5);
    expect(ticks.length).toBeLessThan(40);
    expect(ticks[0]!.label).toBe("host-00000");
  });
});
