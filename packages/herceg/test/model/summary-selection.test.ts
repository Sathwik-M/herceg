// Marks summarizing rows draw a highlighted selection's rows against the
// whole (see `Mark.selectedGeometry`): histograms, box plots, boxen marks,
// violins, heatmaps, and 2D histograms; and layout marks draw each item's
// selected share.
import { describe, expect, it } from "vitest";
import { type ColumnInput, category } from "../../src/data/column.ts";
import { kde, partDensity } from "../../src/data/density.ts";
import { col } from "../../src/data/expr.ts";
import { boxStats } from "../../src/data/quantile.ts";
import { RowSet } from "../../src/data/row-set.ts";
import { selectionStore, selectRows, selectWhere } from "../../src/data/selection.ts";
import { type Table, table as typed } from "../../src/data/table.ts";
import { arcSweep, traceArcs } from "../../src/draw/arc.ts";
import { estimateText } from "../../src/layout/text.ts";
import { boxen } from "../../src/marks/boxen.ts";
import { boxplot } from "../../src/marks/boxplot.ts";
import { funnel } from "../../src/marks/funnel.ts";
import { heatmap } from "../../src/marks/heatmap.ts";
import { histogram } from "../../src/marks/histogram.ts";
import type { ChartMark } from "../../src/marks/mark.ts";
import { pie } from "../../src/marks/pie.ts";
import { sankey } from "../../src/marks/sankey.ts";
import { sunburst } from "../../src/marks/sunburst.ts";
import { treemap } from "../../src/marks/treemap.ts";
import { violin } from "../../src/marks/violin.ts";
import { facet } from "../../src/model/facet.ts";
import { DIM } from "../../src/model/highlight.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { rowSelection } from "../../src/model/row-selection.ts";
import { clickedRows } from "../../src/model/selected-rows.ts";
import type {
  ArcGeometry,
  AreaGeometry,
  Geometry,
  LineGeometry,
  RasterGeometry,
  RectGeometry,
  ShapesGeometry,
} from "../../src/scene/scene.ts";

/** Tables as charts read them, whatever their fields. */
const table = (columns: Record<string, ColumnInput>): Table => typed(columns) as unknown as Table;

/** A chart of `marks` highlighting what channel "focus" of a store of `source` holds. */
function highlighted(source: Table, marks: ChartMark[], config: Partial<ChartConfig> = {}) {
  const store = selectionStore(source);
  const selection = rowSelection({ store, channel: "focus" });
  const model = new ChartModel({
    marks,
    locale: "en-US",
    timeZone: "UTC",
    rowSelection: selection,
    ...config,
  });
  model.setSize(600, 400, 1);
  selection.highlight(model);
  const geometry = (panel = 0) => model.scene(estimateText).panels[panel]!.marks;
  const select = (rows: number[]) =>
    store.set("focus", selectRows(new RowSet(source).addAll(rows)));
  return { store, model, geometry, select };
}

const ofKind = <G extends Geometry>(geometry: Geometry[], kind: string) =>
  geometry.filter((g) => g.kind === kind) as G[];
const lit = (geometry: Geometry[]) => geometry.filter((g) => g.key.includes("\u0001on"));
const dimmed = (geometry: Geometry[]) => geometry.filter((g) => g.key.includes("\u0001off"));

/** Each rectangle's height (vertical bars) in pixels. */
const heights = (g: RectGeometry) =>
  Array.from({ length: g.count }, (_, i) => Math.round(g.rects[i * 4 + 3]! * 1000) / 1000);
/** Each rectangle's top in pixels. */
const tops = (g: RectGeometry) =>
  Array.from({ length: g.count }, (_, i) => Math.round(g.rects[i * 4 + 1]! * 1000) / 1000);

/**
 * The canvas alpha each geometry fills and strokes at, painted onto a
 * stand-in context, with whether it is a dimmed part.
 */
function paintedAlphas(geometry: Geometry[]): { dimmed: boolean; alpha: number }[] {
  const painted: { dimmed: boolean; alpha: number }[] = [];
  for (const g of geometry) {
    let alpha = 1;
    const record = () => painted.push({ dimmed: g.key.includes("\u0001off"), alpha });
    const context = new Proxy(
      {},
      {
        get: (_, name) =>
          name === "globalAlpha" ? alpha : name === "fill" || name === "stroke" ? record : () => {},
        set: (_, name, value) => {
          if (name === "globalAlpha") alpha = value as number;
          return true;
        },
      },
    );
    const options = { plot: { x: 0, y: 0, width: 600, height: 400 }, pixelRatio: 1, clouds: {} };
    (g.draw as { canvas: (c: unknown, g: Geometry, o: unknown) => void }).canvas(
      context,
      g,
      options,
    );
  }
  return painted;
}

/** The text tooltips give for the point at pixel (x, y), of the first mark there. */
const tooltip = (model: ChartModel, x: number, y: number) => model.inspect(x, y)?.points?.[0]?.text;

/** The area sector `i` of `g` paints, its arcs traced as polygons of many sides. */
function paintedArea(g: ArcGeometry, i: number): number {
  let area = 0;
  let path: number[] = [];
  const close = () => {
    for (let k = 0; k < path.length; k += 2) {
      const next = (k + 2) % path.length;
      area += path[k]! * path[next + 1]! - path[next]! * path[k + 1]!;
    }
    path = [];
  };
  const sink = {
    moveTo: (x: number, y: number) => {
      close();
      path.push(x, y);
    },
    lineTo: (x: number, y: number) => path.push(x, y),
    arc: (cx: number, cy: number, r: number, a0: number, a1: number, ccw = false) => {
      const sweep = arcSweep(a0, a1, ccw);
      for (let k = 0; k <= 4096; k++) {
        const a = a0 + ((ccw ? -sweep : sweep) * k) / 4096;
        path.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
      }
    },
    closePath: close,
    bezierCurveTo() {},
    rect() {},
  };
  traceArcs(sink, g, [i]);
  close();
  return Math.abs(area) / 2;
}

describe("histograms with a selection", () => {
  const values = table({ v: [1, 2, 2, 3, 3, 3, 4, 4, 4, 4], w: [1, 1, 1, 1, 1, 1, 2, 2, 2, 2] });
  const bins = [1, 2, 3, 4, 5];

  it("draw each bin's selected rows from its base, the rest of the bar dimmed above them", () => {
    const { geometry, select } = highlighted(values, [histogram(values, { x: "v", bins })]);
    const [plain] = ofKind<RectGeometry>(geometry(), "rect");
    // Of the bins of 1, 2, 3, and 4 rows: none of the first, one of each 2, all three 3s, two 4s.
    select([2, 3, 4, 5, 6, 7]);
    const [off] = dimmed(geometry()) as RectGeometry[];
    const [on] = lit(geometry()) as RectGeometry[];
    expect(off!.fillOpacity).toBe(DIM);
    expect(on!.fillOpacity).toBe(1);
    const unit = heights(plain!)[0]!;
    expect(heights(on!)).toEqual([1, 3, 2].map((rows) => rows * unit));
    expect(heights(off!)).toEqual([1, 1, 2].map((rows) => rows * unit));
    // A bin's selected part stands on its base, and the rest on top of it.
    expect(tops(off!)[2]! + heights(off!)[2]!).toBeCloseTo(tops(on!)[2]!, 3);
  });

  it("measure the selected part with the whole bar's normalization, so it lies inside it", () => {
    for (const normalize of ["probability", "percent", "density", "frequency"] as const) {
      const { geometry, select } = highlighted(values, [
        histogram(values, { x: "v", bins, normalize }),
      ]);
      const [plain] = ofKind<RectGeometry>(geometry(), "rect");
      select([6, 7]);
      const [on] = lit(geometry()) as RectGeometry[];
      // Two of the last bin's four rows: half of its bar.
      expect(heights(on!)).toEqual([heights(plain!)[3]! / 2]);
    }
  });

  it("take cumulative bins' share of the weight up to them, and weighted rows' share of the weight", () => {
    const cumulative = highlighted(values, [histogram(values, { x: "v", bins, cumulative: true })]);
    const [whole] = ofKind<RectGeometry>(cumulative.geometry(), "rect");
    cumulative.select([0, 9]);
    const [on] = lit(cumulative.geometry()) as RectGeometry[];
    // Up to each bin, 1 of 1, 1 of 3, 1 of 6, and 2 of 10 rows.
    expect(heights(on!)).toEqual(
      [1, 1 / 3, 1 / 6, 2 / 10].map(
        (share, b) => Math.round(heights(whole!)[b]! * share * 1000) / 1000,
      ),
    );
    const weighted = highlighted(values, [histogram(values, { x: "v", bins, weight: "w" })]);
    weighted.select([9]);
    const [plain] = ofKind<RectGeometry>(
      highlighted(values, [histogram(values, { x: "v", bins, weight: "w" })]).geometry(),
      "rect",
    );
    const [part] = lit(weighted.geometry()) as RectGeometry[];
    expect(heights(part!)).toEqual([heights(plain!)[3]! / 4]);
    const x = 4.5;
    const { model } = weighted;
    const px = model.panels()[0]!.x.map(x);
    expect(tooltip(model, px, 300)).toBe("4 – 5: 8; 1 of 4 rows selected, w 2 of 8");
  });

  it("put stacked series' selected parts on their own bases", () => {
    const groups = table({
      v: [1, 1, 2, 2, 1, 2],
      g: category(["a", "a", "a", "a", "b", "b"]),
    });
    const { geometry, select } = highlighted(groups, [
      histogram(groups, { x: "v", bins: [1, 2, 3], series: "g", stack: true }),
    ]);
    const plain = ofKind<RectGeometry>(geometry(), "rect");
    select([4]);
    const on = lit(geometry()) as RectGeometry[];
    // Series b's selected row in the first bin, from where b's bar starts: a's top.
    const [, b] = on;
    expect(b!.count).toBe(1);
    expect(tops(b!)[0]! + heights(b!)[0]!).toBeCloseTo(tops(plain[0]!)[0]!, 3);
    expect(heights(b!)[0]).toBeCloseTo(heights(plain[1]!)[0]!, 3);
  });

  it("split steps and polygons into a selected area and a dimmed one above it", () => {
    const { geometry, select } = highlighted(values, [
      histogram(values, { x: "v", bins, element: "step" }),
    ]);
    select([6]);
    const areas = ofKind<AreaGeometry>(geometry(), "area");
    expect(areas.map((g) => g.key.includes("\u0001on"))).toEqual([false, true]);
  });

  it("paint the dimmed parts of steps at a quarter of their opacity on a canvas too, and no empty selected part", () => {
    const { geometry, select } = highlighted(values, [
      histogram(values, { x: "v", bins, element: "step" }),
    ]);
    select([6]);
    const painted = paintedAlphas(geometry());
    // The dimmed fill and outline, then the selected ones: 0.75 and 1 of the step's own.
    expect(painted.filter(({ dimmed }) => dimmed).map(({ alpha }) => alpha)).toEqual([
      0.75 * DIM,
      DIM,
    ]);
    expect(painted.filter(({ dimmed }) => !dimmed).map(({ alpha }) => alpha)).toEqual([0.75, 1]);
    // With no row selected, nothing is drawn as selected: not even an outline along the base.
    const outlined = (parts: Geometry[]) =>
      ofKind<LineGeometry>(parts, "line").reduce((sum, g) => sum + g.path.count, 0);
    select([]);
    expect(outlined(lit(geometry()))).toBe(0);
    // With every row selected, nothing is dimmed.
    select([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(outlined(dimmed(geometry()))).toBe(0);
  });

  it("outline neither part across empty bins, whether every row or none is selected", () => {
    const gapped = table({
      // Bin 2 to 3 is empty, and so is series a's bin 1 to 2.
      v: [0.5, 3.5, 0.5, 1.5, 3.5],
      g: category(["a", "a", "b", "b", "b"]),
    });
    const outlined = (parts: Geometry[]) =>
      ofKind<LineGeometry>(parts, "line").reduce((sum, g) => sum + g.path.count, 0);
    for (const element of ["step", "poly"] as const)
      for (const horizontal of [false, true])
        for (const stack of [false, true]) {
          const field = horizontal ? { y: "v" } : { x: "v" };
          const { geometry, select } = highlighted(gapped, [
            histogram(gapped, {
              ...field,
              bins: [0, 1, 2, 3, 4],
              element,
              ...(stack && { series: "g", stack: true }),
            }),
          ]);
          const label = `${element}${horizontal ? ", horizontal" : ""}${stack ? ", stacked" : ""}`;
          select([0, 1, 2, 3, 4]);
          expect(outlined(dimmed(geometry())), label).toBe(0);
          expect(outlined(lit(geometry())), label).toBeGreaterThan(0);
          select([]);
          expect(outlined(lit(geometry())), label).toBe(0);
          expect(outlined(dimmed(geometry())), label).toBeGreaterThan(0);
        }
  });

  it("join a polygon's selected part to the bins beside it", () => {
    const two = table({ v: [0.5, 1.5] });
    const { geometry, select } = highlighted(two, [
      histogram(two, { x: "v", bins: [0, 1, 2], element: "poly" }),
    ]);
    select([0]);
    // From the first bin's center, selected, down to the second's, which is not.
    const [area] = ofKind<AreaGeometry>(lit(geometry()), "area");
    expect(area!.upper.count).toBe(2);
    const [line] = ofKind<LineGeometry>(lit(geometry()), "line");
    expect(line!.path.count).toBe(2);
    const [rest] = ofKind<AreaGeometry>(dimmed(geometry()), "area");
    expect(rest!.upper.count).toBe(2);
  });

  it("count each facet panel's selected rows in its own bars", () => {
    const panelled = table({
      v: [1, 1, 2, 1, 2, 2],
      p: category(["N", "N", "N", "S", "S", "S"]),
    });
    const { geometry, model, select } = highlighted(
      panelled,
      [histogram(panelled, { x: "v", bins: [1, 2, 3] })],
      { facet: facet("p") },
    );
    select([0, 3]);
    const [north] = lit(geometry(0)) as RectGeometry[];
    const [south] = lit(geometry(1)) as RectGeometry[];
    expect([north!.count, south!.count]).toEqual([1, 1]);
    const plot = model.panels()[1]!;
    const px = plot.x.map(1.5);
    expect(tooltip(model, px, plot.plot.y + plot.plot.height - 2)).toMatch(/1 of 1 row selected$/);
  });

  it("dim every bar for an empty selection, and dim none when every row is selected", () => {
    const { geometry, select } = highlighted(values, [histogram(values, { x: "v", bins })]);
    select([]);
    expect(lit(geometry()).every((g) => (g as RectGeometry).count === 0)).toBe(true);
    select([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(dimmed(geometry()).every((g) => (g as RectGeometry).count === 0)).toBe(true);
  });
});

describe("box plots, boxen marks, and violins with a selection", () => {
  const data = table({
    g: category(["a", "a", "a", "a", "a", "b", "b", "b", "b", "b"]),
    v: [1, 2, 3, 4, 10, 5, 6, 7, 8, 9],
  });

  it("draw the selected values' own box, narrower, over each whole box dimmed", () => {
    const { geometry, model, store } = highlighted(data, [boxplot(data, { x: "g", y: "v" })]);
    const [plain] = ofKind<RectGeometry>(geometry(), "rect");
    store.set("focus", selectWhere(col("v").le(6)));
    const [off] = ofKind<RectGeometry>(dimmed(geometry()), "rect");
    const [on] = ofKind<RectGeometry>(lit(geometry()), "rect");
    expect(off!.fillOpacity).toBeCloseTo(0.25 * DIM);
    expect(Array.from(off!.rects)).toEqual(Array.from(plain!.rects));
    // a's values 1 to 4 and b's 5 and 6, each box 0.6 as wide as the whole's.
    expect(on!.count).toBe(2);
    expect(on!.rects[2]).toBeCloseTo(plain!.rects[2]! * 0.6, 4);
    const y = model.panels()[0]!.y;
    const stats = boxStats([1, 2, 3, 4]);
    expect(on!.rects[1]).toBeCloseTo(y.map(stats.q3), 4);
    expect(on!.rects[1]! + on!.rects[3]!).toBeCloseTo(y.map(stats.q1), 4);
    const center = on!.rects[0]! + on!.rects[2]! / 2;
    expect(tooltip(model, center, y.map(3))).toBe(
      "median 3, quartiles 2 to 4, whiskers 1 to 4, 5 values, 1 outlier; 4 of 5 values selected, median 2.5, quartiles 1.75 to 3.25",
    );
  });

  it("dim precomputed boxes, one row each, unless the selection holds their row", () => {
    const stats = table({
      g: category(["a", "b"]),
      low: [1, 2],
      q1: [2, 3],
      median: [3, 4],
      q3: [4, 5],
      high: [5, 6],
    });
    const { geometry, select } = highlighted(stats, [
      boxplot(stats, { x: "g", low: "low", q1: "q1", median: "median", q3: "q3", high: "high" }),
    ]);
    select([1]);
    const [off] = ofKind<RectGeometry>(dimmed(geometry()), "rect");
    const [on] = ofKind<RectGeometry>(lit(geometry()), "rect");
    expect([off!.count, on!.count]).toEqual([1, 1]);
    expect(on!.rects[0]).toBeGreaterThan(off!.rects[0]!);
  });

  it("draw boxen marks' selected letter values, none for groups the selection holds no value of", () => {
    const { geometry, store } = highlighted(data, [boxen(data, { x: "g", y: "v" })]);
    store.set("focus", selectWhere(col("v").le(4)));
    const on = ofKind<RectGeometry>(lit(geometry()), "rect");
    // Only a's group has selected values; b draws no boxes.
    const boxes = on.reduce((sum, g) => sum + g.count, 0);
    expect(boxes).toBeGreaterThan(0);
    const centers = new Set(
      on.flatMap((g) =>
        Array.from({ length: g.count }, (_, i) =>
          Math.round(g.rects[i * 4]! + g.rects[i * 4 + 2]! / 2),
        ),
      ),
    );
    expect(centers.size).toBe(1);
  });

  it("draw a violin's selected values' density inside its outline, on its points and bandwidth", () => {
    const sorted = Float64Array.of(1, 2, 3, 4, 10);
    const whole = kde(sorted, 1)!;
    const part = partDensity(whole, 5, Float64Array.of(1, 2));
    for (let i = 0; i < part.length; i++)
      expect(part[i]!).toBeLessThanOrEqual(whole.values[i]! + 1e-12);
    const { geometry, store } = highlighted(data, [violin(data, { x: "g", y: "v", bandwidth: 1 })]);
    store.set("focus", selectWhere(col("v").le(2)));
    const [shape] = ofKind<AreaGeometry>(lit(geometry()), "area");
    const [outline] = ofKind<AreaGeometry>(dimmed(geometry()), "area");
    const widths = (g: AreaGeometry) => {
      const out: number[] = [];
      for (let i = 0; i < g.upper.count; i++)
        out.push(Math.abs(g.upper.coords[i * 2]! - g.lower!.coords[i * 2]!));
      return out;
    };
    // The selection's violin is narrower at its widest than the whole's.
    expect(Math.max(...widths(shape!))).toBeLessThan(Math.max(...widths(outline!)));
  });

  it("estimate all of a violin's values selected as the whole, far from zero too", () => {
    // Far from zero, the spacing of the points no longer follows from their ends.
    const sorted = Float64Array.from([0.1, 0.2, 0.35, 0.4, 0.9], (v) => 1e9 + v);
    const whole = kde(sorted, 0.05)!;
    expect(Array.from(partDensity(whole, 5, sorted))).toEqual(Array.from(whole.values));
  });

  it("summarize each facet panel's selected values in its own shapes", () => {
    const panelled = table({
      g: category(["a", "a", "a", "a"]),
      v: [1, 2, 3, 4],
      p: category(["N", "N", "S", "S"]),
    });
    const { geometry, store } = highlighted(panelled, [boxplot(panelled, { x: "g", y: "v" })], {
      facet: facet("p"),
    });
    store.set("focus", selectWhere(col("v").le(2)));
    const [north] = ofKind<RectGeometry>(lit(geometry(0)), "rect");
    const [south] = ofKind<RectGeometry>(lit(geometry(1)), "rect");
    expect([north!.count, south!.count]).toEqual([1, 0]);
  });
});

describe("heatmaps and 2D histograms with a selection", () => {
  it("draw the image dimmed and a square of each selected cell's color in it, covering its share", () => {
    const cells = table({
      x: category(["a", "b", "a", "b", "a"]),
      y: category(["p", "p", "q", "q", "q"]),
      v: [1, 2, 3, 4, 5],
    });
    const { geometry, select, model } = highlighted(cells, [
      heatmap(cells, { x: "x", y: "y", color: "v", reduce: "sum" }),
    ]);
    const [image] = ofKind<RasterGeometry>(geometry(), "raster");
    // Cell (a, q) holds rows 2 and 4; one of them is selected.
    select([1, 4]);
    const drawn = geometry();
    expect(ofKind<RasterGeometry>(drawn, "raster")).toHaveLength(1);
    expect((drawn[0]!.draw as { opacity?: number }).opacity).toBe(DIM);
    const squares = ofKind<RectGeometry>(drawn, "rect");
    const sides = squares
      .flatMap((g) =>
        Array.from({ length: g.count }, (_, i) => g.rects[i * 4 + 2]! * g.rects[i * 4 + 3]!),
      )
      .sort((a, b) => a - b);
    const cell = (image!.width / 2) * (image!.height / 2);
    expect(sides[0]).toBeCloseTo(cell / 2, 1);
    expect(sides[1]).toBeCloseTo(cell, 1);
    const x = model.panels()[0]!.x;
    const y = model.panels()[0]!.y;
    expect(tooltip(model, x.map(0), y.map(1))).toBe("8; 1 of 2 rows selected");
  });

  it("draw grids of cells too small for squares as an image of the cells holding selected rows", () => {
    const n = 300;
    const grid = table({
      x: Float64Array.from({ length: n * n }, (_, i) => i % n),
      y: Float64Array.from({ length: n * n }, (_, i) => Math.floor(i / n)),
      v: Float64Array.from({ length: n * n }, (_, i) => i),
    });
    const { geometry, store } = highlighted(grid, [heatmap(grid, { x: "x", y: "y", color: "v" })]);
    store.set("focus", selectWhere(col("x").lt(10)));
    const images = ofKind<RasterGeometry>(geometry(), "raster");
    expect(images.map((g) => g.key.endsWith("|selected"))).toEqual([false, true]);
    const [, selected] = images;
    // Columns of selected cells keep their color; the others are left out.
    const alpha = (column: number) => selected!.pixels[column * 4 + 3];
    expect([alpha(0), alpha(selected!.columns - 1)]).toEqual([255, 0]);
  });

  it("paint each facet panel's image of the cells holding selected rows from its own rows", () => {
    const n = 200;
    const grid = table({
      x: Float64Array.from({ length: 2 * n * n }, (_, i) => i % n),
      y: Float64Array.from({ length: 2 * n * n }, (_, i) => Math.floor(i / n) % n),
      v: Float64Array.from({ length: 2 * n * n }, (_, i) => i % 97),
      panel: category(Array.from({ length: 2 * n * n }, (_, i) => (i < n * n ? "N" : "S"))),
    });
    const { geometry, store } = highlighted(grid, [heatmap(grid, { x: "x", y: "y", color: "v" })], {
      facet: facet("panel"),
    });
    // The first ten columns of the north panel only.
    store.set("focus", selectWhere(col("x").lt(10).and(col("panel").eq("N"))));
    const image = (panel: number) =>
      ofKind<RasterGeometry>(geometry(panel), "raster").find((g) => g.key.endsWith("|selected"));
    const north = image(0)!;
    let opaque = 0;
    for (let i = 3; i < north.pixels.length; i += 4) opaque += north.pixels[i]! > 0 ? 1 : 0;
    expect(opaque).toBeGreaterThan(0);
    // A panel holding no selected row draws no image of them.
    expect(image(1)).toBeUndefined();
  });

  it("leave out cells whose sum overflows, as the image does", () => {
    const cells = table({
      x: category(["a", "a", "b"]),
      y: category(["p", "p", "p"]),
      v: [Number.MAX_VALUE, Number.MAX_VALUE, 1],
    });
    const { geometry, select, model } = highlighted(cells, [
      heatmap(cells, { x: "x", y: "y", color: "v", reduce: "sum" }),
    ]);
    select([0, 2]);
    const squares = ofKind<RectGeometry>(geometry(), "rect");
    expect(squares.reduce((sum, g) => sum + g.count, 0)).toBe(1);
    const { x, y } = model.panels()[0]!;
    expect(tooltip(model, x.map(1), y.map(0))).toBe("1; 1 of 1 row selected");
  });

  it("count each facet panel's cells of its own rows", () => {
    const cells = table({
      x: category(["a", "a", "b", "b"]),
      y: category(["p", "p", "p", "p"]),
      v: [1, 2, 3, 4],
      panel: category(["N", "S", "N", "S"]),
    });
    const { geometry, select, model } = highlighted(
      cells,
      [heatmap(cells, { x: "x", y: "y", color: "v" })],
      {
        facet: facet("panel"),
      },
    );
    select([0]);
    const squares = (panel: number) =>
      ofKind<RectGeometry>(geometry(panel), "rect").reduce((sum, g) => sum + g.count, 0);
    expect([squares(0), squares(1)]).toEqual([1, 0]);
    const south = model.panels()[1]!;
    expect(tooltip(model, south.x.map(0), south.y.map(0))).toBe("2; 0 of 1 row selected");
  });

  it("leave out 2D histogram cells whose measure overflows, as the image does", () => {
    const tiny = table({ x: [5e-201], y: [5e-201] });
    for (const normalize of ["density", "frequency"] as const) {
      const { geometry, select } = highlighted(tiny, [
        histogram(tiny, {
          x: "x",
          y: "y",
          bins: { x: [0, 1e-200], y: [0, 1e-200] },
          normalize,
          colorDomain: [0, 10],
        }),
      ]);
      select([0]);
      expect(ofKind<RectGeometry>(geometry(), "rect"), normalize).toEqual([]);
    }
  });

  it("count each 2D histogram cell's selected weight in its square, and say so in tooltips", () => {
    const pairs = table({ x: [0.5, 0.5, 1.5, 1.5], y: [0.5, 0.5, 0.5, 1.5] });
    const { geometry, select, model, store } = highlighted(pairs, [
      histogram(pairs, { x: "x", y: "y", bins: { x: [0, 1, 2], y: [0, 1, 2] } }),
    ]);
    select([0]);
    const squares = ofKind<RectGeometry>(geometry(), "rect");
    expect(squares.reduce((sum, g) => sum + g.count, 0)).toBe(1);
    const { x, y } = model.panels()[0]!;
    expect(tooltip(model, x.map(0.5), y.map(0.5))).toBe("2; 1 of 2 rows selected");
    // Cleared, the cell's tooltip says nothing of a selection, though its series is kept.
    store.set("focus", null);
    geometry();
    expect(tooltip(model, x.map(0.5), y.map(0.5))).toBe("2");
  });
});

describe("layout marks with a selection", () => {
  const sales = table({
    region: category(["N", "N", "S", "S"]),
    kind: category(["a", "b", "a", "b"]),
    revenue: [30, 10, 40, 20],
  });

  it("draw each pie slice's selected share out from its inner edge, covering that share of it", () => {
    const { geometry, select, model } = highlighted(sales, [
      pie(sales, { category: "region", value: "revenue", innerRadius: 0.5, labels: false }),
    ]);
    select([0]);
    const [off, on] = ofKind<ArcGeometry>(geometry(), "arc");
    expect([off!.key, off!.fillOpacity, on!.key]).toEqual(["pie-dimmed", DIM, "pie"]);
    // Slice S (60) first, none of it selected; then N (40), of which 30 are.
    expect(on!.arcs[3]).toBeCloseTo(on!.arcs[2]!, 6);
    const [selected, rest] = [paintedArea(on!, 1), paintedArea(off!, 1)];
    expect(selected / (selected + rest)).toBeCloseTo(30 / 40, 4);
    const item = model.items!.result()!.item(1);
    expect(item.text).toBe("40 (40%); 1 of 2 rows selected, revenue 30 of 40");
    const tables = new Set([sales]);
    expect(clickedRows(model, tables, item.px, item.py)?.rows).toEqual(Uint32Array.of(0, 1));
  });

  it("keep a thin slice's sides in its selected part, and share what the slice paints", () => {
    const thin = table({ kind: category(["a", "a", "b"]), weight: [1, 1, 998] });
    const { geometry, select } = highlighted(thin, [
      pie(thin, { category: "kind", value: "weight", labels: false }),
    ]);
    const [whole] = ofKind<ArcGeometry>(geometry(), "arc");
    select([0]);
    const [dim, lit] = ofKind<ArcGeometry>(geometry(), "arc");
    // The radii each sector's arcs are traced at: its rim, then where its sides meet.
    const radii = (g: ArcGeometry, i: number) => {
      const seen: number[] = [];
      const sink = { moveTo() {}, lineTo() {}, closePath() {}, bezierCurveTo() {}, rect() {} };
      traceArcs({ ...sink, arc: (_x: number, _y: number, r: number) => seen.push(r) }, g, [i]);
      return seen;
    };
    // Slice a (2 of 1,000), second: drawn out from where its sides meet, its
    // parts painting all of it, half of it selected.
    expect(radii(lit!, 1)[1]).toBeCloseTo(radii(whole!, 1)[1]!, 6);
    const [selected, rest] = [paintedArea(lit!, 1), paintedArea(dim!, 1)];
    expect(selected + rest).toBeCloseTo(paintedArea(whole!, 1), 3);
    expect(selected / (selected + rest)).toBeCloseTo(0.5, 4);
  });

  it("draw each funnel stage's selected share as a bar in its middle, the rest dimmed either side", () => {
    const { geometry, select, model } = highlighted(sales, [
      funnel(sales, { category: "kind", value: "revenue", labels: false }),
    ]);
    const [whole] = ofKind<RectGeometry>(geometry(), "rect");
    select([2]);
    const [sides, bars] = ofKind<RectGeometry>(geometry(), "rect");
    expect([sides!.key, sides!.count, bars!.key]).toEqual(["funnel-bars-dimmed", 4, "funnel-bars"]);
    // Stage a (70) is the widest: 40 of it is selected.
    expect(bars!.rects[2]! / whole!.rects[2]!).toBeCloseTo(40 / 70, 6);
    expect(bars!.rects[0]! + bars!.rects[2]! / 2).toBeCloseTo(
      whole!.rects[0]! + whole!.rects[2]! / 2,
      6,
    );
    const tables = new Set([sales]);
    const item = model.items!.result()!.item(0);
    expect(clickedRows(model, tables, item.px, item.py)?.rows).toEqual(Uint32Array.of(0, 2));
  });

  it("fill each treemap leaf's selected share from its left edge, and each sunburst node's out from its inner edge", () => {
    const tree = highlighted(sales, [
      treemap(sales, { path: ["region", "kind"], value: "revenue" }),
    ]);
    tree.select([0]);
    const leaves = ofKind<RectGeometry>(tree.geometry(), "rect").filter((g) =>
      g.key.startsWith("treemap-leaves"),
    );
    const litLeaf = leaves.find((g) => !g.key.endsWith("-dimmed") && g.count === 1)!;
    const restLeaf = leaves.find((g) => g.key.endsWith("-dimmed") && g.fill === litLeaf.fill)!;
    // Leaf N / a is wholly selected; its branch's other leaf not at all.
    expect(restLeaf.count).toBe(1);
    expect(litLeaf.rects[0]! + litLeaf.rects[2]!).not.toBeCloseTo(restLeaf.rects[0]!, 3);
    const sun = highlighted(sales, [
      sunburst(sales, { path: ["region", "kind"], value: "revenue" }),
    ]);
    sun.select([0]);
    const arcs = ofKind<ArcGeometry>(sun.geometry(), "arc");
    expect(arcs.map((g) => g.key)).toEqual([
      "sunburst-1-dimmed",
      "sunburst-1",
      "sunburst-2-dimmed",
      "sunburst-2",
    ]);
    // Region N (40), 30 of it selected: its ring's selected part covers 3/4 of it.
    const [faded, ring] = arcs;
    const rest = Array.from({ length: faded!.count }, (_, i) => i).find(
      (i) => faded!.arcs[i * 6 + 4] === ring!.arcs[4],
    )!;
    const selected = paintedArea(ring!, 0);
    expect(selected / (selected + paintedArea(faded!, rest))).toBeCloseTo(3 / 4, 4);
    // Drilled into N, the root in the middle draws its share out from its center.
    sun.model.items!.setDrillRoot(["N"]);
    const center = ofKind<ArcGeometry>(sun.geometry(), "arc").filter((g) =>
      g.key.startsWith("sunburst-root"),
    );
    expect(center.map((g) => g.key)).toEqual(["sunburst-root-dimmed", "sunburst-root"]);
    const [faint, disc] = center;
    expect((disc!.arcs[3]! / faint!.arcs[3]!) ** 2).toBeCloseTo(3 / 4, 3);
  });

  it("draw each Sankey link's selected share along its middle, dimming nodes none of whose links' rows are selected", () => {
    const flows = table({
      from: category(["a", "a", "b"]),
      to: category(["c", "c", "c"]),
      value: [1, 3, 2],
    });
    const { geometry, select, model } = highlighted(flows, [
      sankey(flows, { source: "from", target: "to", value: "value", labels: false }),
    ]);
    select([0]);
    const drawn = geometry();
    const [faint, links] = ofKind<ShapesGeometry>(drawn, "shapes");
    expect([faint!.key, links!.key, links!.shapes.length]).toEqual([
      "sankey-links-dimmed",
      "sankey-links",
      1,
    ]);
    expect(faint!.shapes).toHaveLength(4);
    const nodes = ofKind<RectGeometry>(drawn, "rect");
    expect(nodes.some((g) => g.key.endsWith("-dimmed") && g.count === 1)).toBe(true);
    const result = model.items!.result()!;
    const tables = new Set([flows]);
    const keys = Array.from({ length: result.count }, (_, i) => result.item(i).key);
    expect(result.rowsOf!(keys.find((key) => key === JSON.stringify([0, "c"]))!, flows)).toEqual([
      0, 1, 2,
    ]);
    const link = result.item(keys.indexOf(JSON.stringify([0, "a", "c"])));
    expect(link.text).toBe("4; 1 of 2 rows selected, value 1 of 4");
    expect(clickedRows(model, tables, link.px, link.py)?.rows).toEqual(Uint32Array.of(0, 1));
  });

  it("count a Sankey node's rows over the links it draws, leaving out those closing cycles", () => {
    const cycle = table({
      from: category(["a", "b", "b"]),
      to: category(["b", "a", "c"]),
      value: [10, 100, 20],
    });
    const { geometry, select, model } = highlighted(cycle, [
      sankey(cycle, { source: "from", target: "to", value: "value", labels: false }),
    ]);
    // The link back from b to a closes a cycle and is not drawn.
    select([1]);
    const nodes = ofKind<RectGeometry>(geometry(), "rect");
    expect(nodes.every((g) => g.key.endsWith("-dimmed"))).toBe(true);
    const result = model.items!.result()!;
    const b = Array.from({ length: result.count }, (_, i) => result.item(i)).find(
      (item) => item.key === JSON.stringify([0, "b"]),
    )!;
    expect(b.text).toBe("10 in, 20 out; 0 of 2 rows selected, value 0 of 10 in, 0 of 20 out");
    expect(result.rowsOf!(b.key, cycle)).toEqual([0, 2]);
  });
});
