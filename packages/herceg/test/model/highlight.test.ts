import { describe, expect, it } from "vitest";
import { type ColumnInput, time } from "../../src/data/column.ts";
import { col } from "../../src/data/expression.ts";
import { RowSet } from "../../src/data/row-set.ts";
import { selectionStore, selectRows, selectWhere } from "../../src/data/selection.ts";
import { type Table, table as typed } from "../../src/data/table.ts";

import { estimateText } from "../../src/layout/text.ts";
import { area } from "../../src/marks/area.ts";
import { bar } from "../../src/marks/bar.ts";
import { line } from "../../src/marks/line.ts";
import type { ChartMark } from "../../src/marks/mark.ts";
import { point } from "../../src/marks/point.ts";
import { DIM, Highlighter, membership } from "../../src/model/highlight.ts";
import { ChartModel } from "../../src/model/model.ts";
import { renderSvg } from "../../src/render/svg.ts";
import { timeBreaks } from "../../src/scale/breaks.ts";
import type {
  AreaGeometry,
  Geometry,
  LineGeometry,
  PointGeometry,
  RectGeometry,
} from "../../src/scene/scene.ts";

/** Tables as charts read them, whatever their fields. */
const table = (columns: Record<string, ColumnInput>, options?: { maxRows?: number }): Table =>
  typed(columns, options) as unknown as Table;

/** A chart highlighting what `channel` of a store of `source` selects. */
function highlighted(source: Table, marks: ChartMark[]) {
  const store = selectionStore(source);
  const highlighter = new Highlighter([{ table: source, store, channel: "focus" }]);
  const model = new ChartModel({ marks, locale: "en-US", timeZone: "UTC" });
  model.setSize(600, 400, 1);
  model.highlight = (mark, series, frame, key) =>
    highlighter.geometry(mark, series, frame, key) ?? mark.geometry(series, frame, key);
  const geometry = () => model.scene(estimateText).panels[0]!.marks;
  return { store, highlighter, model, geometry };
}

const ofKind = <G extends Geometry>(geometry: Geometry[], kind: string) =>
  geometry.filter((g) => g.kind === kind) as G[];

describe("highlighting", () => {
  it("draws every row as usual while the channel holds no selection", () => {
    const source = table({ x: [1, 2, 3], y: [1, 2, 3] });
    const { geometry } = highlighted(source, [point(source, { x: "x", y: "y" })]);
    const [points] = ofKind<PointGeometry>(geometry(), "point");
    expect(points!.count).toBe(3);
    expect(points!.fillOpacity).toBe(1);
  });

  it("dims the points not selected and draws the selected ones over them, each once", () => {
    const source = table({ x: [1, 2, 3, 4], y: [1, 2, 3, 4] });
    const { store, geometry } = highlighted(source, [point(source, { x: "x", y: "y" })]);
    store.set("focus", selectRows(new RowSet(source).addAll([1, 3])));
    const [dimmed, selected] = ofKind<PointGeometry>(geometry(), "point");
    expect([dimmed!.count, dimmed!.fillOpacity, dimmed!.opaque]).toEqual([2, DIM, false]);
    expect([selected!.count, selected!.fillOpacity]).toEqual([2, 1]);
    expect(Array.from(selected!.coords.subarray(0, 4))).toEqual(
      Array.from(geometryOfRows(source, [1, 3])),
    );
    // An empty selection dims everything.
    store.set("focus", selectRows(new RowSet(source)));
    const [all, none] = ofKind<PointGeometry>(geometry(), "point");
    expect([all!.count, none!.count]).toEqual([4, 0]);
  });

  it("leaves large point series on the GPU, as clouds of their unselected and selected rows", () => {
    const n = 100_000;
    const source = table({
      x: Float64Array.from({ length: n }, (_, i) => i),
      y: new Float64Array(n),
    });
    const { store, model } = highlighted(source, [point(source, { x: "x", y: "y" })]);
    store.set("focus", selectWhere(col("x").lt(10)));
    const marks = model.scene(estimateText, true).panels[0]!.marks as PointGeometry[];
    expect(marks.map((g) => [g.count, g.fillOpacity, g.cloud?.rows?.length])).toEqual([
      [n - 10, DIM, n - 10],
      [10, 1, 10],
    ]);
  });

  it("dims outlined points' rings too, and draws translucent clouds' points once", () => {
    const source = table({ x: [1, 2], y: [1, 2] });
    const ringed = point(source, { x: "x", y: "y", stroke: "#000000", strokeWidth: 2 });
    const { store, geometry } = highlighted(source, [ringed]);
    store.set("focus", selectRows(new RowSet(source).add(0)));
    const [dimmed, lit] = ofKind<PointGeometry>(geometry(), "point");
    expect(dimmed!.ring!.opacity).toBe(DIM);
    expect(lit!.ring!.opacity).toBeUndefined();
    const n = 100_000;
    const many = table({
      x: Float64Array.from({ length: n }, (_, i) => i),
      y: new Float64Array(n),
    });
    const translucent = highlighted(many, [point(many, { x: "x", y: "y", fillOpacity: 0.5 })]);
    translucent.store.set("focus", selectWhere(col("x").lt(10)));
    const clouds = translucent.model.scene(estimateText, true).panels[0]!.marks as PointGeometry[];
    expect(clouds.map((g) => [g.cloud?.rows?.length, g.fillOpacity])).toEqual([
      [n - 10, 0.5 * DIM],
      [10, 0.5],
    ]);
  });

  it("lets each cloud part's upload follow its rows as the table streams", () => {
    const n = 100_000;
    const source = table(
      { x: Float64Array.from({ length: n }, (_, i) => i), y: new Float64Array(n) },
      { maxRows: n },
    );
    const { store, model } = highlighted(source, [point(source, { x: "x", y: "y" })]);
    store.set("focus", selectWhere(["==", ["%", ["field", "x"], 2], 0]));
    const clouds = () =>
      (model.scene(estimateText, true).panels[0]!.marks as PointGeometry[]).map((g) => g.cloud!);
    const streams = () => clouds().map((cloud) => cloud.stream!);
    const before = clouds().map((cloud) => cloud.rows!.slice());
    const [off, on] = streams();
    // 1,000 rows appended drop 1,000 from the front: 500 of each part.
    source.append({
      x: Float64Array.from({ length: 1000 }, (_, i) => n + i),
      y: new Float64Array(1000),
    });
    const after = clouds().map((cloud) => cloud.rows!);
    const [off2, on2] = streams();
    expect([off2!.key, on2!.key]).toEqual([off!.key, on!.key]);
    expect([off2!.offset - off!.offset, on2!.offset - on!.offset]).toEqual([500, 500]);
    expect([off2!.modified, on2!.modified]).toEqual([off!.modified, on!.modified]);
    // What uploads keep is the same rows, now 1,000 positions earlier, with appended ones after.
    for (const [i, rows] of after.entries()) {
      const kept = Array.from(before[i]!.subarray(500), (row) => row - 1000);
      expect(Array.from(rows.subarray(0, kept.length))).toEqual(kept);
      expect(rows.length - kept.length).toBe(500);
    }
    // A new selection uploads the parts again, under keys of its own.
    store.set("focus", selectWhere(["<", ["field", "x"], 10]));
    const [off3] = streams();
    expect(off3!.key).not.toBe(off2!.key);
  });

  it("keeps grouped bars in their slots", () => {
    const sales = table({ region: ["N", "S"], a: [10, 20], b: [30, 5] });
    const mark = bar(sales, { x: "region", y: ["a", "b"] });
    const { store, geometry } = highlighted(sales, [mark]);
    const plain = ofKind<RectGeometry>(geometry(), "rect");
    store.set("focus", selectRows(new RowSet(sales).add(1)));
    const rects = ofKind<RectGeometry>(geometry(), "rect");
    // Unselected a and b, then selected a and b: each in the slot it had.
    expect(rects.map((r) => [r.count, r.fillOpacity])).toEqual([
      [1, DIM],
      [1, DIM],
      [1, 1],
      [1, 1],
    ]);
    const x = (r: RectGeometry) => Array.from(r.rects.subarray(0, r.count * 4));
    expect([...x(rects[0]!), ...x(rects[2]!)].sort()).toEqual(x(plain[0]!).sort());
    expect([...x(rects[1]!), ...x(rects[3]!)].sort()).toEqual(x(plain[1]!).sort());
  });

  it("dims a line and draws it again over its runs of selected rows, with dots for lone rows", () => {
    const source = table({ x: [0, 1, 2, 3, 4, 5], y: [1, 3, 2, 4, 3, 5] });
    const mark = line(source, { x: "x", y: "y", curve: "monotone" });
    const { store, geometry, model } = highlighted(source, [mark]);
    const [plain] = ofKind<LineGeometry>(geometry(), "line");
    store.set("focus", selectRows(new RowSet(source).addAll([1, 2, 4])));
    const drawn = geometry();
    const [base, runs] = ofKind<LineGeometry>(drawn, "line");
    // The same curve, its controls too: the selected part is drawn, not traced again.
    expect(Array.from(runs!.path.controls.subarray(0, 24))).toEqual(
      Array.from(plain!.path.controls.subarray(0, 24)),
    );
    expect(base!.path).toBe(runs!.path);
    // Clipped to the run of rows 1 and 2; row 4 stands alone, a dot.
    const svg = renderSvg(model.scene(estimateText), {});
    const [panel] = model.panels();
    const [a, b] = [panel!.x.map(1), panel!.x.map(2)];
    expect(svg).toContain(`<rect x="${a}" y="${panel!.plot.y}" width="${b - a}"`);
    const [dots] = ofKind<PointGeometry>(drawn, "point");
    expect(dots!.count).toBe(1);
    // The dimmed line draws at a fraction of its opacity.
    expect(svg).toContain(`opacity="${DIM}"`);
  });

  it("highlights a stack of a series field through its own edges", () => {
    // Layers at x positions of their own: the stack fills each at all four.
    const source = table({ x: [0, 1, 2, 3], y: [1, 2, 3, 4], g: ["a", "b", "a", "b"] });
    const mark = area(source, { x: "x", y: "y", series: "g", stack: true });
    const { store, geometry, model } = highlighted(source, [mark]);
    const plain = ofKind<AreaGeometry>(geometry(), "area");
    store.set("focus", selectWhere(true));
    const scene = model.scene(estimateText);
    const lit = (scene.panels[0]!.marks as AreaGeometry[]).filter((g) => g.fillOpacity === 0.85);
    const upper = (g: AreaGeometry) => Array.from(g.upper.coords.subarray(0, g.upper.count * 2));
    // Every row selected: each layer is drawn as it is, over the stack's whole width.
    expect(lit.map(upper)).toEqual(plain.map(upper));
    const [panel] = model.panels();
    const [left, right] = [panel!.x.map(0), panel!.x.map(3)];
    const whole = `<rect x="${left}" y="${panel!.plot.y}" width="${right - left}"`;
    for (const g of lit)
      expect(g.draw.svg(g, { theme: scene.theme, encodeRaster: undefined })).toContain(whole);
  });

  it("paints an area once: as it is within its selected runs, dimmed outside them", () => {
    const source = table({ x: [0, 1, 2, 3], y: [1, 3, 2, 4] });
    const { store, geometry, model } = highlighted(source, [area(source, { x: "x", y: "y" })]);
    const [plain] = ofKind<AreaGeometry>(geometry(), "area");
    store.set("focus", selectWhere(col("x").ge(1)));
    const [dimmed, selected] = ofKind<AreaGeometry>(geometry(), "area");
    expect(dimmed!.fillOpacity).toBeCloseTo(plain!.fillOpacity * DIM);
    expect(dimmed!.stroke).toBeNull();
    expect(selected!.fillOpacity).toBe(plain!.fillOpacity);
    // Clipped apart: the plot left of x = 1, and x = 1 to 3.
    const svg = renderSvg(model.scene(estimateText), {});
    const [panel] = model.panels();
    const { plot } = panel!;
    // Past the outline's round cap at x = 3, where the area ends.
    const [one, three] = [panel!.x.map(1), panel!.x.map(3) + plain!.strokeWidth / 2];
    expect(svg).toContain(`<rect x="${plot.x - 1}" y="${plot.y}" width="${one - plot.x + 1}"`);
    expect(svg).toContain(`<rect x="${one}" y="${plot.y}" width="${three - one}"`);
  });

  it("finds runs on reversed axes, and runs of rows at one x as values", () => {
    const source = table({ x: [0, 1, 2, 3, 4, 5], y: [1, 3, 2, 4, 3, 5] });
    const { store, model } = highlighted(source, [line(source, { x: "x", y: "y" })]);
    model.update({ marks: [line(source, { x: "x", y: "y" })], x: { domain: [5, 0] } });
    store.set("focus", selectRows(new RowSet(source).addAll([0, 1, 4, 5])));
    const scene = model.scene(estimateText);
    const svg = renderSvg(scene, {});
    const [panel] = model.panels();
    // Rows 0 and 5 end the line: their runs reach over its round caps.
    const cap = scene.theme.lineWidth / 2;
    const span = (a: number, b: number, end: number) => {
      const [pa, pb] = [panel!.x.map(a), panel!.x.map(b)];
      const pe = panel!.x.map(end);
      // The cap reaches away from the run, at its end that ends the line.
      const [lo, hi] = [Math.min(pa, pb), Math.max(pa, pb)];
      const [x0, x1] = pe === lo ? [lo - cap, hi] : [lo, hi + cap];
      return `<rect x="${x0}" y="${panel!.plot.y}" width="${x1 - x0}"`;
    };
    expect(svg).toContain(span(0, 1, 0));
    expect(svg).toContain(span(4, 5, 5));
    // A vertical run (two rows at x = 0) has no width to clip to: its values draw.
    const upright = table({ x: [0, 0, 1], y: [1, 2, 1] });
    const both = highlighted(upright, [line(upright, { x: "x", y: "y" })]);
    both.store.set("focus", selectRows(new RowSet(upright).addAll([0, 1])));
    const lines = ofKind<LineGeometry>(both.geometry(), "line");
    expect(lines.map((g) => g.path.count)).toEqual([3, 2]);
  });

  it("covers a line's round caps, and ends runs at rows the scales cannot place", () => {
    const source = table({ x: [0, 1, 2], y: [1, 3, 2] });
    const { store, model } = highlighted(source, [line(source, { x: "x", y: "y" })]);
    model.update({ marks: [line(source, { x: "x", y: "y" })], x: { domain: [-1, 3] } });
    store.set("focus", selectWhere(true));
    const rect = (from: number, to: number) => {
      const scene = model.scene(estimateText);
      const [panel] = model.panels();
      const cap = scene.theme.lineWidth / 2;
      const [a, b] = [panel!.x.map(from) - cap, panel!.x.map(to) + cap];
      return [renderSvg(scene, {}), `<rect x="${a}" y="${panel!.plot.y}" width="${b - a}"`];
    };
    // Every row selected: the whole line, caps and all, is drawn as it is.
    const [whole, all] = rect(0, 2);
    expect(whole).toContain(all);
    // On a log axis row 0 has no place: the line, and its run, start at row 1.
    const logged = table({ x: [-1, 1, 2], y: [1, 3, 2] });
    const log = highlighted(logged, [line(logged, { x: "x", y: "y" })]);
    log.model.update({ marks: [line(logged, { x: "x", y: "y" })], x: { type: "log" } });
    log.store.set("focus", selectWhere(true));
    const scene = log.model.scene(estimateText);
    const [panel] = log.model.panels();
    const cap = scene.theme.lineWidth / 2;
    const [a, b] = [panel!.x.map(1) - cap, panel!.x.map(2) + cap];
    expect(renderSvg(scene, {})).toContain(`<rect x="${a}" y="${panel!.plot.y}" width="${b - a}"`);
  });

  it("draws selected values where rows at one x are partly selected", () => {
    // Rows 1 to 3 at x = 1 rise as a vertical run; only row 1 of them is selected.
    const source = table({ x: [0, 1, 1, 1, 2], y: [1, 1, 2, 3, 3] });
    const { store, geometry } = highlighted(source, [line(source, { x: "x", y: "y" })]);
    const [plain] = ofKind<LineGeometry>(geometry(), "line");
    store.set("focus", selectRows(new RowSet(source).addAll([0, 1])));
    const lines = ofKind<LineGeometry>(geometry(), "line");
    // No span at x = 1 tells row 1 from rows 2 and 3: the selected rows' values draw.
    expect(lines.map((g) => g.path.count)).toEqual([plain!.path.count, 2]);
  });

  it("places rows as the marks draw them: stacked zeros, invalid neighbors, rows behind breaks", () => {
    // A stack on a log axis draws its zeros at the low end: the run goes on through x = 1.
    const stack = table({ x: [0, 1, 2, 3], y: [1, 0, 2, 3] });
    const stacked = highlighted(stack, [area(stack, { x: "x", y: "y", stack: true })]);
    stacked.model.update({
      marks: [area(stack, { x: "x", y: "y", stack: true })],
      y: { type: "log" },
    });
    stacked.store.set("focus", selectWhere(true));
    const scene = stacked.model.scene(estimateText);
    const [panel] = stacked.model.panels();
    const [a, b] = [panel!.x.map(0), panel!.x.map(3)];
    expect(renderSvg(scene, {})).toContain(`<rect x="${a}" y="${panel!.plot.y}" width="${b - a}"`);
    // Row 0 has no place on a log x axis: row 1, selected with it, is a dot.
    const signed = table({ x: [-1, 1, 2], y: [1, 3, 2] });
    const log = highlighted(signed, [line(signed, { x: "x", y: "y" })]);
    log.model.update({ marks: [line(signed, { x: "x", y: "y" })], x: { type: "log" } });
    log.store.set("focus", selectRows(new RowSet(signed).addAll([0, 1])));
    const [dot] = ofKind<PointGeometry>(log.geometry(), "point");
    expect(dot!.count).toBe(1);
    // Rows 3 and 4 at x = 1, after a missing value, draw a vertical run the span would light.
    const behind = table({ x: [0, 1, 1, 1, 1, 2], y: [1, 1, Number.NaN, 2, 3, 3] });
    const gap = highlighted(behind, [line(behind, { x: "x", y: "y" })]);
    gap.store.set("focus", selectRows(new RowSet(behind).addAll([0, 1])));
    const lines = ofKind<LineGeometry>(gap.geometry(), "line");
    expect(lines).toHaveLength(2);
    expect(lines[1]!.key.endsWith("\u0001on")).toBe(true);
  });

  it("follows stacks' layers through their edges, and lines across axis breaks", () => {
    const rect = (model: ChartModel, from: number, to: number, cap = 0) => {
      const [panel] = model.panels();
      const [a, b] = [panel!.x.map(from) - cap, panel!.x.map(to) + cap];
      return `<rect x="${a}" y="${panel!.plot.y}" width="${b - a}"`;
    };
    // A layer in x order leaves out its rows without an x, as the stack does.
    const odd = table({ x: [2, 0, Number.NaN, 1], y: [1, 2, 3, 4], g: ["a", "a", "a", "a"] });
    const layer = highlighted(odd, [area(odd, { x: "x", y: "y", series: "g", stack: true })]);
    layer.store.set("focus", selectRows(new RowSet(odd).addAll([1, 3])));
    expect(renderSvg(layer.model.scene(estimateText), {})).toContain(rect(layer.model, 0, 1));
    // Layer b's one row stands on a's value at x = 0 that a log axis cannot place;
    // the stack's edges draw b there all the same, and so it is highlighted.
    const held = table({ x: [0, 0, 0, 1], y: [-1, 2, 3, 2], g: ["a", "a", "b", "a"] });
    const marks = [area(held, { x: "x", y: "y", series: "g", stack: true })];
    const stack = highlighted(held, marks);
    stack.model.update({ marks, y: { type: "log" } });
    stack.store.set("focus", selectWhere(true));
    const lit = ofKind<AreaGeometry>(stack.geometry(), "area").filter(
      (g) => g.fillOpacity === 0.85,
    );
    expect(lit).toHaveLength(2);
    // Rows at t = 4, 5, and 6 are inside a break: the line joins t = 1 to 9, both selected.
    const times = table({ t: time([0, 1, 4, 5, 6, 9, 10]), v: [1, 2, 3, 4, 3, 2, 1] });
    const across = highlighted(times, [line(times, { x: "t", y: "v" })]);
    across.model.update({
      marks: [line(times, { x: "t", y: "v" })],
      x: { breaks: timeBreaks([{ from: 3, to: 8 }]) },
    });
    across.store.set("focus", selectRows(new RowSet(times).addAll([0, 1, 5, 6])));
    const scene = across.model.scene(estimateText);
    expect(renderSvg(scene, {})).toContain(rect(across.model, 0, 10, scene.theme.lineWidth / 2));
  });

  it("draws values over a dimmed series at the opacity that shows the color's own", () => {
    // One color over itself at a quarter of its alpha: what each drawing adds.
    const composite = (a: number, under: number) => a + under * (1 - a);
    const unsorted = table({ x: [0, 2, 1, 3], y: [1, 3, 2, 4] });
    const translucent = "rgba(255, 0, 0, 0.5)";
    const lines = highlighted(unsorted, [line(unsorted, { x: "x", y: "y", stroke: translucent })]);
    lines.store.set("focus", selectWhere(true));
    const svg = renderSvg(lines.model.scene(estimateText), {});
    const fractions = [...svg.matchAll(/<g opacity="([\d.]+)">/g)].map((m) => Number(m[1]));
    const [under, top] = [Math.min(...fractions), Math.max(...fractions)];
    expect(under).toBe(DIM);
    expect(composite(0.5 * top, 0.5 * under)).toBeCloseTo(0.5);
    // An area's fill, of a translucent color and opacity of its own.
    const areas = highlighted(unsorted, [
      area(unsorted, { x: "x", y: "y", fill: "#0000ff80", fillOpacity: 0.5 }),
    ]);
    areas.store.set("focus", selectWhere(true));
    const fills = ofKind<AreaGeometry>(areas.geometry(), "area").map((g) => g.fillOpacity);
    const alpha = 0x80 / 255;
    expect(composite(alpha * Math.max(...fills), alpha * Math.min(...fills))).toBeCloseTo(
      alpha * 0.5,
    );
  });

  it("follows a live condition as rows stream, testing only the rows appended", () => {
    const source = table({ x: [1, 2, 3], y: [1, 2, 3] }, { maxRows: 4 });
    const condition = selectWhere(col("x").ge(2));
    expect(Array.from(membership(source, condition))).toEqual([0, 1, 1]);
    source.append({ x: [0, 5], y: [0, 5] });
    // Row 1 (x = 1) dropped; 0 out, 5 in.
    expect(Array.from(membership(source, condition))).toEqual([1, 1, 0, 1]);
    source.reset({ x: [9], y: [9] });
    expect(Array.from(membership(source, condition))).toEqual([1]);
  });

  it("follows a row set changed in place, and shares memberships between charts", () => {
    const source = table({ x: [1, 2, 3], y: [1, 2, 3] });
    const set = new RowSet(source).add(0);
    const rows = selectRows(set);
    expect(Array.from(membership(source, rows))).toEqual([1, 0, 0]);
    set.add(1);
    expect(Array.from(membership(source, rows))).toEqual([1, 1, 0]);
    expect(membership(source, rows)).toBe(membership(source, rows));
  });

  it("keeps rows of a snapshot while rows are appended and dropped, and none after a reset", () => {
    const source = table({ x: [1, 2, 3], y: [1, 2, 3] }, { maxRows: 3 });
    const rows = selectRows(new RowSet(source).addAll([0, 2]));
    source.append({ x: [4], y: [4] });
    // x = 1 left with its row; x = 3, now row 1, stays; x = 4 was never selected.
    expect(Array.from(membership(source, rows))).toEqual([0, 1, 0]);
    source.reset({ x: [1, 3], y: [1, 3] });
    expect(Array.from(membership(source, rows))).toEqual([0, 0]);
  });

  it("draws every row again once a reset leaves a row set of earlier rows", () => {
    const source = table({ x: [1, 2], y: [1, 2] });
    const { store, geometry } = highlighted(source, [point(source, { x: "x", y: "y" })]);
    store.set("focus", selectRows(new RowSet(source).add(0)));
    expect(ofKind<PointGeometry>(geometry(), "point")).toHaveLength(2);
    source.reset({ x: [3, 4], y: [3, 4] });
    const [points] = ofKind<PointGeometry>(geometry(), "point");
    expect([points!.count, points!.fillOpacity]).toEqual([2, 1]);
  });

  it("holds a byte per row of the table it highlights", () => {
    const n = 100_000;
    const source = table({
      x: Float64Array.from({ length: n }, (_, i) => i),
      y: new Float64Array(n),
    });
    expect(membership(source, selectWhere(col("x").lt(10))).byteLength).toBe(n);
  });
});

/** Where the default point chart draws rows of `source` (its first panel's scales), as pixel pairs. */
function geometryOfRows(source: Table, rows: number[]): Float32Array {
  const model = new ChartModel({ marks: [point(source, { x: "x", y: "y" })], locale: "en-US" });
  model.setSize(600, 400, 1);
  model.scene(estimateText);
  const [panel] = model.panels();
  return Float32Array.from(
    rows.flatMap((row) => [
      panel!.x.map(source.value("x" as never, row) as number),
      panel!.y.map(source.value("y" as never, row) as number),
    ]),
  );
}
