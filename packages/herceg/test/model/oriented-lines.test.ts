// Lines and areas over category axes (at their bands' centers, in band
// order, dodged like bars) and along y (`orient: "y"`, or a category y).
import { describe, expect, it } from "vitest";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import type { Polyline } from "../../src/lod/polyline.ts";
import { area } from "../../src/marks/area.ts";
import { bar } from "../../src/marks/bar.ts";
import { line } from "../../src/marks/line.ts";
import { point } from "../../src/marks/point.ts";
import { describeChart } from "../../src/model/describe.ts";
import { facet } from "../../src/model/facet.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import type {
  AreaGeometry,
  LineGeometry,
  PointGeometry,
  RectGeometry,
  Scene,
} from "../../src/scene/scene.ts";
import { validateSpec } from "../../src/spec/validate.ts";

function build(config: ChartConfig, width = 600, height = 300) {
  const model = new ChartModel({ locale: "en-US", timeZone: "UTC", ...config });
  model.setSize(width, height, 1);
  return { model, scene: model.scene(estimateText) };
}

const of = <G>(scene: Scene, kind: string, panel = 0) =>
  scene.panels[panel]!.marks.filter((m) => m.kind === kind) as unknown as G[];
const vertices = (path: Polyline) =>
  Array.from({ length: path.count }, (_, i) => [path.coords[i * 2]!, path.coords[i * 2 + 1]!]);
/** Points as drawn (single precision) match `expected` to a hundredth of a pixel. */
const near = (actual: number[][], expected: number[][]) =>
  expect(actual).toEqual(expected.map((pair) => pair.map((v) => expect.closeTo(v, 2))));
const barCenters = (bars: RectGeometry) =>
  Array.from({ length: bars.count }, (_, i) => bars.rects[i * 4]! + bars.rects[i * 4 + 2]! / 2);

const months = table({
  month: ["Mar", "Jan", "Feb", "Mar", "Jan", "Feb"],
  sales: [3, 1, 2, 30, 10, 20],
  target: [2.5, 1.5, 2, 25, 15, 18],
  region: ["N", "N", "N", "S", "S", "S"],
});

describe("lines over category axes", () => {
  it("run through their bands' centers in band order, on the bars' band scale", () => {
    const ordered = table({ month: ["Jan", "Feb", "Mar"], sales: [1, 2, 3] });
    const { model, scene } = build({
      marks: [
        bar(ordered, { x: "month", y: "sales" }),
        line(months, { x: "month", y: "target", series: "region" }),
      ],
    });
    const x = model.xScale()!;
    expect(x.type).toBe("band");
    expect(x.categories).toEqual(["Jan", "Feb", "Mar"]);
    const [bars] = of<RectGeometry>(scene, "rect");
    const [north] = of<LineGeometry>(scene, "line");
    const y = model.yScale()!;
    // Rows Mar, Jan, Feb are drawn Jan, Feb, Mar, at the bars' centers.
    near(
      vertices(north!.path),
      barCenters(bars!).map((cx, i) => [cx, y.map([1.5, 2, 2.5][i]!)]),
    );
    // Tooltips snap to a band and read every line there.
    const at = model.inspect(x.map(1), 150, "nearest-x")!;
    expect(at.label).toBe("Feb");
    expect(at.points.map(({ label, value }) => [label, value])).toEqual([
      ["sales", 2],
      ["N", 2],
      ["S", 18],
    ]);
    // The keyboard steps through the bands in order.
    const series = model.series().find((s) => s.label === "N")!;
    expect([0, 1, 2].map((k) => model.inspectPosition(series.key, k)!.label)).toEqual([
      "Jan",
      "Feb",
      "Mar",
    ]);
  });

  it("leave out rows without a category and break at missing values", () => {
    const data = table({
      month: ["Jan", null, "Feb", "Mar", "Apr"],
      v: [1, 9, 2, Number.NaN, 4],
    });
    const { model, scene } = build({ marks: [line(data, { x: "month", y: "v" })] });
    const [drawn] = of<LineGeometry>(scene, "line");
    expect(drawn!.path.starts).toEqual([0, 2]);
    expect(drawn!.path.count).toBe(3);
    expect(model.xScale()!.categories).toEqual(["Jan", "Feb", "Mar", "Apr"]);
    expect(describeChart(model)).toContain("v: 4 points, from 1 to 4");
  });

  it("dodge with grouped bars and dodged points of their legend group", () => {
    const marks = [
      bar(months, { x: "month", y: "sales", series: "region", legendGroup: "g" }),
      point(months, { x: "month", y: "sales", series: "region", dodge: true, legendGroup: "g" }),
      line(months, { x: "month", y: "sales", series: "region", dodge: true, legendGroup: "g" }),
    ];
    const { model, scene } = build({ marks });
    const bars = of<RectGeometry>(scene, "rect");
    const points = of<PointGeometry>(scene, "point");
    const lines = of<LineGeometry>(scene, "line");
    for (let s = 0; s < 2; s++) {
      const centers = barCenters(bars[s]!).sort((a, b) => a - b);
      const drawn = vertices(lines[s]!.path).map(([px]) => px!);
      expect(drawn).toEqual(centers.map((v) => expect.closeTo(v, 2)));
      const dots = Array.from({ length: 3 }, (_, i) => points[s]!.coords[i * 2]!).sort(
        (a, b) => a - b,
      );
      expect(dots).toEqual(centers.map((v) => expect.closeTo(v, 2)));
    }
    // Inspection reports a dodged line's point where it is drawn.
    const south = model
      .series()
      .find((s) => s.label === "S" && model.markOf(s)?.spec.type === "line")!;
    const read = model.inspectPosition(south.key, 0)!;
    const mine = read.points.find((p) => p.key === south.key)!;
    expect(mine.px).toBeCloseTo(vertices(lines[1]!.path)[0]![0]!, 3);
  });

  it("refuses dodge off a category axis or without series, and orients by axis kinds", () => {
    const data = table({ t: [1, 2], v: [1, 2], g: ["a", "b"] });
    expect(() => line(data, { x: "t", y: "v", series: "g", dodge: true })).toThrow(
      "line dodge: places series side by side in the bands of a category x; give a category field as x, or drop dodge",
    );
    expect(() => line(data, { x: "g", y: "v", dodge: true })).toThrow(
      "line dodge: places series side by side; give a series field",
    );
    expect(() => line(data, { x: ["v", "t"] as never, y: "t" })).toThrow(
      'line x: several fields are values along x of a mark along y; give orient: "y", or one x field',
    );
    expect(() => line(data, { x: "v", y: "t", orient: "z" as never })).toThrow(
      'line orient: expected "x" or "y"; received "z"',
    );
    expect(() => validateSpec({ marks: [{ type: "line", x: "v", y: "t", orient: "z" }] })).toThrow(
      /marks\[0\]\.orient: expected "x" or "y"; received "z"/,
    );
    // Numbers cannot share a category axis.
    expect(() =>
      build({ marks: [line(data, { x: "g", y: "v" }), line(data, { x: "t", y: "v" })] }),
    ).toThrow("line x: numbers cannot share a category axis");
  });

  it("fill and stack areas over categories", () => {
    const { model, scene } = build({
      marks: [area(months, { x: "month", y: "sales", series: "region", stack: true })],
    });
    expect(model.xScale()!.categories).toEqual(["Mar", "Jan", "Feb"]);
    const [north, south] = of<AreaGeometry>(scene, "area");
    const y = model.yScale()!;
    const x = model.xScale()!;
    // The south layer's top runs Mar, Jan, Feb at its stacked heights.
    near(
      vertices(south!.upper),
      [0, 1, 2].map((band, i) => [x.map(band), y.map([33, 11, 22][i]!)]),
    );
    near(
      vertices(north!.upper),
      [0, 1, 2].map((band, i) => [x.map(band), y.map([3, 1, 2][i]!)]),
    );
    // Long-format rows out of band order are stacked and read by band.
    const shuffled = table({
      month: ["Feb", "Jan", "Feb", "Jan"],
      v: [2, 1, 20, 10],
      g: ["a", "a", "b", "b"],
    });
    const stacked = build({
      marks: [
        bar(table({ month: ["Jan", "Feb"], v: [0, 0] }), { x: "month", y: "v" }),
        area(shuffled, { x: "month", y: "v", series: "g", stack: true }),
      ],
    });
    const top = stacked.model.series().find((s) => s.label === "b")!;
    expect([0, 1].map((k) => stacked.model.inspectPosition(top.key, k)!.label)).toEqual([
      "Jan",
      "Feb",
    ]);
    const [, upper] = of<AreaGeometry>(stacked.scene, "area");
    const sy = stacked.model.yScale()!;
    expect(vertices(upper!.upper).map(([, py]) => Math.round(py!))).toEqual(
      [11, 22].map((v) => Math.round(sy.map(v))),
    );
  });

  it("draw in facet panels holding their own categories", () => {
    const data = table({
      month: ["Jan", "Feb", "Mar", "Apr"],
      v: [1, 2, 3, 4],
      half: ["H1", "H1", "H2", "H2"],
    });
    const { model, scene } = build({
      marks: [line(data, { x: "month", y: "v" })],
      facet: facet("half"),
      x: { scope: "panel" },
    });
    const panels = model.panels();
    for (let p = 0; p < 2; p++) {
      const [drawn] = of<LineGeometry>(scene, "line", p);
      const x = panels[p]!.x;
      expect(vertices(drawn!.path).map(([px]) => Math.round(px!))).toEqual(
        [0, 1].map((band) => Math.round(x.map(band))),
      );
    }
  });

  it("reach the peaks of long stacks whose rows are reordered by band", () => {
    // Rows alternate categories, so the series reads them out of row order,
    // which the stack's indexes (by row) cannot serve.
    const n = 300_000;
    const data = table({
      c: Array.from({ length: n }, (_, i) => (i % 2 === 0 ? "A" : "B")),
      a: Float64Array.from({ length: n }, (_, i) => (i === 2 ? 1000 : 1)),
      b: new Float64Array(n).fill(1),
    });
    const { model } = build({ marks: [area(data, { x: "c", y: ["a", "b"], stack: true })] });
    expect(model.yScale()!.domain[1]).toBeGreaterThanOrEqual(1001);
  });

  it("trace long stacks in facet panels of their own categories through every row", () => {
    // Long enough for the stack to keep indexes, which a panel's copy of its
    // points (renumbered) cannot use: each category's peak in the second
    // panel still draws.
    const n = 300_000;
    const per = 1000;
    const data = table({
      c: Array.from({ length: n }, (_, i) => `c${Math.floor(i / per)}`),
      half: Array.from({ length: n }, (_, i) => (i < n / 2 ? "H1" : "H2")),
      a: Float64Array.from({ length: n }, (_, i) => (i >= n / 2 && i % per === per / 2 ? 1000 : 1)),
      b: new Float64Array(n).fill(1),
    });
    const { model, scene } = build({
      marks: [area(data, { x: "c", y: ["a", "b"], stack: true })],
      facet: facet("half"),
      x: { scope: "panel" },
    });
    const y = model.yScale()!;
    const highest = (p: number) => {
      const [bottom] = of<AreaGeometry>(scene, "area", p);
      return Math.min(...vertices(bottom!.upper).map(([, py]) => py!));
    };
    expect(highest(0)).toBeCloseTo(y.map(1), 1);
    expect(highest(1)).toBeCloseTo(y.map(1000), 1);
  });
});

describe("lines and areas along y", () => {
  const casts = table({
    depth: [0, 10, 20, 30, 40],
    temperature: [20, 18, 12, 8, 7],
    salinity: [35, 35.2, 35.5, 35.6, 35.6],
  });

  it("run along y, with values on x, read by y", () => {
    const { model, scene } = build({
      marks: [line(casts, { x: ["temperature", "salinity"], y: "depth", orient: "y" })],
    });
    const x = model.xScale()!;
    const y = model.yScale()!;
    expect(x.domain[0]).toBeLessThanOrEqual(7);
    const [temperature] = of<LineGeometry>(scene, "line");
    near(
      vertices(temperature!.path),
      [20, 18, 12, 8, 7].map((t, i) => [x.map(t), y.map(i * 10)]),
    );
    expect(model.tooltipMode()).toBe("nearest-y");
    const read = model.inspect(300, y.map(19))!;
    expect(read.axis).toBe("y");
    expect(read.label).toBe("20");
    expect(read.points.map(({ label, value }) => [label, value])).toEqual([
      ["temperature", 12],
      ["salinity", 35.5],
    ]);
    const s = model.series()[0]!;
    expect([0, 4].map((k) => model.inspectPosition(s.key, k)!.value)).toEqual([0, 40]);
  });

  it("reduce dense data along y to about four points per pixel row", () => {
    const n = 200_000;
    const depth = Float64Array.from({ length: n }, (_, i) => i);
    const value = Float64Array.from({ length: n }, (_, i) => Math.sin(i / 50));
    const { scene } = build(
      { marks: [line(table({ depth, value }), { x: "value", y: "depth", orient: "y" })] },
      600,
      300,
    );
    const [drawn] = of<LineGeometry>(scene, "line");
    expect(drawn!.path.count).toBeLessThanOrEqual(4 * 300 + 4);
    expect(drawn!.path.count).toBeGreaterThan(300);
  });

  it("lay along a category y without orient, as bars do", () => {
    const data = table({ day: ["thu", "fri", "sat"], tip: [2, 3, 4] });
    const { model, scene } = build({ marks: [line(data, { x: "tip", y: "day" })] });
    expect(model.yScale()!.type).toBe("band");
    const [drawn] = of<LineGeometry>(scene, "line");
    const y = model.yScale()!;
    expect(vertices(drawn!.path).map(([, py]) => Math.round(py!))).toEqual(
      [0, 1, 2].map((band) => Math.round(y.map(band))),
    );
    expect(() =>
      build({ marks: [line(data, { x: "tip", y: "day", axis: "right" as never })] }),
    ).toThrow("line axis: marks along y cannot use the right axis");
  });

  it("fill areas along y to zero on x, and draw bands between x1 and x2", () => {
    const { model, scene } = build({
      marks: [
        area(casts, { x: "temperature", y: "depth", orient: "y" }),
        area(casts, { y: "depth", x1: "temperature", x2: "salinity" }),
      ],
    });
    const x = model.xScale()!;
    const y = model.yScale()!;
    expect(x.domain[0]).toBe(0);
    const [filled, band] = of<AreaGeometry>(scene, "area");
    near(
      vertices(filled!.upper),
      [20, 18, 12, 8, 7].map((t, i) => [x.map(t), y.map(i * 10)]),
    );
    // Its lower edge runs along x = 0, from its first depth to its last.
    near(vertices(filled!.lower!), [
      [x.map(0), y.map(0)],
      [x.map(0), y.map(40)],
    ]);
    near(
      vertices(band!.lower!),
      [20, 18, 12, 8, 7].map((t, i) => [x.map(t), y.map(i * 10)]),
    );
    const read = model.inspect(300, y.map(10), "nearest-y")!;
    expect(read.points.map(({ text }) => text)).toEqual(["18", "18 – 35.2"]);
  });

  it("stack areas along y by a series field", () => {
    const data = table({
      depth: [0, 10, 0, 10],
      v: [1, 2, 3, 4],
      g: ["a", "a", "b", "b"],
    });
    const { model, scene } = build({
      marks: [area(data, { x: "v", y: "depth", series: "g", stack: true, orient: "y" })],
    });
    const x = model.xScale()!;
    const y = model.yScale()!;
    const [, upper] = of<AreaGeometry>(scene, "area");
    near(vertices(upper!.upper), [
      [x.map(4), y.map(0)],
      [x.map(6), y.map(10)],
    ]);
    near(vertices(upper!.lower!), [
      [x.map(1), y.map(0)],
      [x.map(2), y.map(10)],
    ]);
    expect(x.domain[1]).toBeGreaterThanOrEqual(6);
  });

  it("span their positions along y whatever x shows, and reach their stacks' edges on x", () => {
    const steep = table({ x: [0, 10], y: [0, 100] });
    const zoomed = new ChartModel({
      marks: [line(steep, { x: "x", y: "y", orient: "y" })],
      locale: "en-US",
      timeZone: "UTC",
    });
    zoomed.setSize(600, 300, 1);
    zoomed.setViewport([4, 6]);
    zoomed.scene(estimateText);
    expect(zoomed.yScale()!.domain).toEqual([0, 100]);
    // Interpolated gaps of a stack along y reach past any row's own top.
    const sparse = table({ depth: [1, 0, 2], v: [100, 100, 100], g: ["a", "b", "b"] });
    const { model, scene } = build({
      marks: [
        area(sparse, {
          x: "v",
          y: "depth",
          series: "g",
          stack: true,
          stackGaps: "interpolate",
          orient: "y",
        }),
      ],
    });
    const x = model.xScale()!;
    expect(Math.max(...x.domain)).toBeGreaterThanOrEqual(200);
    const [, upper] = of<AreaGeometry>(scene, "area");
    const reach = Math.max(...vertices(upper!.upper).map(([px]) => px!));
    expect(reach).toBeLessThanOrEqual(x.map(Math.max(...x.domain)) + 1e-3);
  });

  it("keep their stacks' edges in facet panels holding categories of their own", () => {
    const data = table({
      day: ["thu", "fri", "thu", "sat", "sun", "sat", "sun"],
      v: [1, 2, 3, 4, 5, 6, 7],
      g: ["a", "a", "b", "a", "a", "b", "b"],
      half: ["H1", "H1", "H1", "H2", "H2", "H2", "H2"],
    });
    const { model, scene } = build({
      marks: [area(data, { x: "v", y: "day", series: "g", stack: true })],
      facet: facet("half"),
      y: { scope: "panel" },
    });
    expect(model.panels().map((p) => p.y.categories)).toEqual([
      ["thu", "fri"],
      ["sat", "sun"],
    ]);
    for (const p of [0, 1]) {
      const areas = of<AreaGeometry>(scene, "area", p);
      expect(areas.every((g) => g.upper.count === 2)).toBe(true);
    }
  });

  it("reduce each facet panel's dense data along y, as along x", () => {
    // Each panel's positions ascend, though the whole table's do not.
    const n = 100_000;
    const data = table({
      depth: Float64Array.from({ length: 2 * n }, (_, i) => i % n),
      v: Float64Array.from({ length: 2 * n }, (_, i) => Math.sin(i / 7)),
      half: Array.from({ length: 2 * n }, (_, i) => (i < n ? "H1" : "H2")),
    });
    const { scene } = build({
      marks: [line(data, { x: "v", y: "depth", orient: "y" })],
      facet: facet("half"),
    });
    for (const p of [0, 1]) {
      const [drawn] = of<LineGeometry>(scene, "line", p);
      expect(drawn!.path.count).toBeLessThan(5000);
    }
  });

  it("stack along y in facet panels, x no longer ascending as values did", () => {
    // In each panel, b's values ascend but its tops do not.
    const data = table({
      depth: [0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2],
      v: [100, 100, 0, 1, 2, 3, 100, 100, 0, 1, 2, 3],
      g: [..."aaabbbaaabbb"],
      half: [..."HHHHHHKKKKKK"],
    });
    const { model } = build({
      marks: [area(data, { x: "v", y: "depth", series: "g", stack: true, orient: "y" })],
      facet: facet("half"),
    });
    const panel = model.panels()[0]!;
    const b = model.panelSeries(panel.key).find((s) => s.label === "b")!;
    expect(b.sorted).toBe(false);
    // The pointer on b's top at depth 2 finds it there.
    const found = model.inspect(panel.x.map(3), panel.y.map(2), "nearest")!;
    expect(found.points.map((p) => [p.label, p.value])).toContainEqual(["b", 3]);
  });

  it("pair a stack's layers by occurrence along y, as along x", () => {
    // At depth 0, a has 1 then 2, b 10 then 20, and c one row: beside a's
    // second, c has no row of that occurrence to report.
    const data = table({
      depth: [0, 0, 1, 0, 0, 1, 0, 1],
      v: [1, 2, 3, 10, 20, 30, 7, 8],
      g: ["a", "a", "a", "b", "b", "b", "c", "c"],
    });
    const { model } = build({
      marks: [area(data, { x: "v", y: "depth", series: "g", stack: true, orient: "y" })],
    });
    const [a] = model.series();
    const read = (position: number) =>
      model.inspectPosition(a!.key, position)!.points.map((p) => [p.label, p.row, p.value]);
    expect(read(1)).toEqual([
      ["a", 1, 2],
      ["b", 4, 20],
    ]);
    expect(read(0)).toEqual([
      ["a", 0, 1],
      ["b", 3, 10],
      ["c", 6, 7],
    ]);
  });

  it("refuses bands without the position field they run along", () => {
    expect(() => validateSpec({ marks: [{ type: "area", y1: "lo", y2: "hi" }] })).toThrow(
      /area x: a band between y1 and y2 runs along x; give an x field/,
    );
    expect(() => validateSpec({ marks: [{ type: "area", x1: "lo", x2: "hi" }] })).toThrow(
      /area y: a band between x1 and x2 runs along y; give a y field/,
    );
    expect(() =>
      validateSpec({ marks: [{ type: "area", x: ["a", "b"], y1: "lo", y2: "hi" }] }),
    ).toThrow(/area x: a band runs along one x field; give one field/);
    expect(() =>
      line(casts, { x: ["temperature", "temperature"], y: "depth", orient: "y" }),
    ).toThrow('line x: field "temperature" is listed twice; list it once');
  });
});
