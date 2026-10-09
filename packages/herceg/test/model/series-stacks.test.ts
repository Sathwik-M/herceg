// Stacks of series split by a field: areas stacked on the x positions of
// all their series, and bars stacked position by position, as charts draw,
// inspect, describe, split, and stream them.
import { describe, expect, it } from "vitest";
import { category, encodedCategory } from "../../src/data/column.ts";
import { type Schema, type Table, table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import type { Polyline } from "../../src/lod/polyline.ts";
import { area } from "../../src/marks/area.ts";
import { bar } from "../../src/marks/bar.ts";
import { describeChart } from "../../src/model/describe.ts";
import { facet } from "../../src/model/facet.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import type { AreaGeometry, RectGeometry, Scene } from "../../src/scene/scene.ts";
import { loadSpec } from "../../src/spec/load.ts";

function sceneOf(config: ChartConfig): { model: ChartModel; scene: Scene } {
  const model = new ChartModel({ locale: "en-US", ...config });
  model.setSize(600, 300, 1);
  return { model, scene: model.scene(estimateText) };
}

const areas = (scene: Scene, panel = 0) =>
  scene.panels[panel]!.marks.filter((m): m is AreaGeometry => m.kind === "area");

const points = (path: Polyline) =>
  Array.from({ length: path.count }, (_, i): [number, number] => [
    path.coords[i * 2]!,
    path.coords[i * 2 + 1]!,
  ]);

/** Requests per minute by status: 500 has no row at minute 1, 404 only one row. */
const requests = () =>
  table({
    minute: [0, 1, 2, 0, 2, 3, 1],
    count: [1, 2, 3, 10, 20, 30, 5],
    status: category(["200", "200", "200", "500", "500", "500", "404"]),
  });

const stacked = <S extends Schema>(data: Table<S>, options: Record<string, unknown> = {}) =>
  area(
    data as never,
    {
      x: "minute",
      y: "count",
      series: "status",
      stack: true,
      ...options,
    } as never,
  );

describe("areas stacked by a series field", () => {
  it("draw every layer on every minute any of them has, sharing their edges", () => {
    const { scene, model } = sceneOf({ marks: [stacked(requests())] });
    const [ok, error, missing] = areas(scene);
    const y = model.yScale()!;
    // The 500s are drawn flat at minute 1, where they have no row.
    expect(points(error!.lower!).map(([, py]) => y.invert(py))).toEqual([1, 2, 3, 0].map(near));
    expect(points(error!.upper).map(([, py]) => y.invert(py))).toEqual([11, 2, 23, 30].map(near));
    expect(points(error!.lower!)).toEqual(points(ok!.upper));
    expect(points(missing!.lower!)).toEqual(points(error!.upper));
    // The first layer stands on the baseline, with no lower edge of its own.
    expect(ok!.lower).toBeNull();
  });

  it("report each series' own rows, where they are drawn, in tooltips and the keyboard", () => {
    const { model } = sceneOf({ marks: [stacked(requests())] });
    const x = model.xScale()!;
    const y = model.yScale()!;
    const at = (minute: number) => model.inspect(x.map(minute), y.map(5))!;
    // Minute 1: the 404s and 200s have rows there; the 500s do not.
    expect(at(1).points.map((p) => [p.label, p.value, p.row])).toEqual([
      ["200", 2, 1],
      ["404", 5, 6],
    ]);
    expect(at(1).points[1]!.py).toBeCloseTo(y.map(7));
    // Each series is a keyboard stop of its own, reading the stack at its rows.
    expect(model.keyboardStops("").map((s) => s.label)).toEqual(["200", "500", "404"]);
    const error = model.series()[1]!;
    const third = model.inspectPosition(error.key, 2)!;
    expect(third.value).toBe(3);
    expect(third.points.map((p) => [p.label, p.value, p.py])).toEqual([["500", 30, y.map(30)]]);
  });

  it("read the other layers at the same one of their rows where an x has several", () => {
    // At x = 1, a steps from 2 to 4, b has 10 then 20, and c has one row,
    // which it holds at the second: no row of c is there to report.
    const data = table({
      x: [0, 1, 1, 0, 1, 1, 1],
      y: [1, 2, 4, 5, 10, 20, 7],
      s: category([..."aaabbbc"]),
    });
    const { model } = sceneOf({
      marks: [area(data, { x: "x", y: "y", series: "s", stack: true })],
    });
    const [a, b] = model.series();
    const read = (key: string, position: number) =>
      model.inspectPosition(key, position)!.points.map((p) => [p.label, p.row, p.value]);
    expect(read(b!.key, 2)).toEqual([
      ["a", 2, 4],
      ["b", 5, 20],
    ]);
    // Every point is reported where its layer is drawn at that occurrence.
    const y = model.yScale()!;
    expect(model.inspectPosition(b!.key, 2)!.points.map((p) => p.py)).toEqual([
      y.map(4),
      y.map(24),
    ]);
    expect(read(a!.key, 1)).toEqual([
      ["a", 1, 2],
      ["b", 4, 10],
      ["c", 6, 7],
    ]);
    // In any row order; and a missing row at the same occurrence is not
    // stood in for by a later one, as the stack draws nothing there.
    const shuffled = table({
      x: [1, 0, 1, 0, 1, 1],
      y: [2, 1, 4, 5, Number.NaN, 20],
      s: category([..."aaabbb"]),
    });
    const other = sceneOf({
      marks: [area(shuffled, { x: "x", y: "y", series: "s", stack: true })],
    }).model;
    const [first] = other.series();
    const shuffledRead = (position: number) =>
      other.inspectPosition(first!.key, position)!.points.map((p) => [p.label, p.row, p.value]);
    expect(shuffledRead(2)).toEqual([
      ["a", 2, 4],
      ["b", 5, 20],
    ]);
    expect(shuffledRead(0)).toEqual([["a", 0, 2]]);
    const shuffledY = other.yScale()!;
    expect(other.inspectPosition(first!.key, 2)!.points.map((p) => p.py)).toEqual([
      shuffledY.map(4),
      shuffledY.map(24),
    ]);
  });

  it("describe each series by its own rows", () => {
    const { model } = sceneOf({ marks: [stacked(requests())] });
    const text = describeChart(model);
    expect(text).toContain("500: 3 points, from 10 to 30, last 30");
    expect(text).toContain("404: 1 point, from 5 to 5, last 5");
  });

  it("let hidden series out of the stack, and out of the minutes it is on", () => {
    const { model } = sceneOf({ marks: [stacked(requests())] });
    const missing = () => model.series()[2]!;
    model.hidden.add(model.series()[1]!.key);
    model.scene(estimateText);
    expect(Array.from(missing().edges!.x)).toEqual([0, 1, 2]);
    expect(Array.from(missing().edges!.top)).toEqual([1, 7, 3]);
    model.hidden.add(model.series()[0]!.key);
    model.scene(estimateText);
    // Alone, the 404s stand on zero at their one minute.
    expect(missing().edges!.bottom).toBeUndefined();
    expect(Array.from(missing().edges!.top)).toEqual([5]);
  });

  it("interpolate a series between its rows with stackGaps", () => {
    const { model } = sceneOf({ marks: [stacked(requests(), { stackGaps: "interpolate" })] });
    expect(Array.from(model.series()[1]!.edges!.top)).toEqual([11, 17, 23, 30]);
  });

  it("fit the y axis to the edges, not only to the rows", () => {
    // b has no row at x = 1, where a peaks: b's top there is a's 100 plus
    // b's interpolated 50.
    const data = table({ x: [0, 1, 2, 0, 2], y: [1, 100, 1, 50, 50], s: category([..."aaabb"]) });
    const mark = area(data, { x: "x", y: "y", series: "s", stack: true, stackGaps: "interpolate" });
    const { model } = sceneOf({ marks: [mark] });
    expect(model.yScale()!.domain[1]).toBeGreaterThanOrEqual(150);
  });

  it("stand stacks on the low end of a reversed log axis", () => {
    const fields = table({ x: [0, 1], a: [0, 2], b: [5, 5] });
    for (const mark of [
      area(fields, { x: "x", y: ["a", "b"], stack: true }),
      stacked(requests()),
    ]) {
      const { scene, model } = sceneOf({ marks: [mark], y: { type: "log", domain: [100, 1] } });
      const low = model.yScale()!.map(1);
      const [first, second] = areas(scene);
      expect(first!.baseline).toBeCloseTo(low);
      // The second layer stands on the first's zero there, at the same end.
      expect(points(second!.lower!)[0]![1]).toBeCloseTo(low);
    }
  });

  it("draw layers standing on zero down to the bottom of a log axis", () => {
    const { scene } = sceneOf({ marks: [stacked(requests())], y: { type: "log" } });
    const [ok, error] = areas(scene);
    const bottom = scene.panels[0]!.plot.y + scene.panels[0]!.plot.height;
    // The 500s at minute 3 stand on the 200s' zero.
    expect(points(error!.lower!).at(-1)![1]).toBeCloseTo(bottom);
    expect(points(error!.upper)).toHaveLength(4);
    expect(points(ok!.upper)).toHaveLength(4);
    // Stacks of fields, too.
    const fields = table({ x: [0, 1, 2], a: [0, 2, 3], b: [5, 5, 5] });
    const wide = sceneOf({
      marks: [area(fields, { x: "x", y: ["a", "b"], stack: true })],
      y: { type: "log" },
    }).scene;
    expect(points(areas(wide)[1]!.lower!)[0]![1]).toBeCloseTo(bottom);
  });

  it("curve every layer's edges together", () => {
    const { scene } = sceneOf({ marks: [stacked(requests(), { curve: "monotone" })] });
    const [ok, error] = areas(scene);
    expect(error!.lower!.curved).toBe(true);
    expect(Array.from(error!.lower!.controls.subarray(0, 16))).toEqual(
      Array.from(ok!.upper.controls.subarray(0, 16)),
    );
  });

  it("stack each facet panel's layers apart", () => {
    const data = table({
      minute: [0, 1, 0, 1, 0, 2, 1],
      count: [1, 2, 10, 20, 3, 4, 5],
      status: category(["200", "200", "500", "500", "200", "500", "404"]),
      region: category(["eu", "eu", "eu", "eu", "us", "us", "us"]),
    });
    const { model } = sceneOf({ marks: [stacked(data)], facet: facet("region") });
    const [ok, error, missing] = model.series();
    const [eu, us] = [model.parts(error!)[0]!, model.parts(error!)[1]!];
    expect(Array.from(eu.edges!.x)).toEqual([0, 1]);
    expect(Array.from(eu.edges!.top)).toEqual([11, 22]);
    // In the us panel, the 500s stand on the 200s' 3 at minute 0 and on nothing at 1 and 2.
    expect(Array.from(us.edges!.x)).toEqual([0, 1, 2]);
    expect(Array.from(us.edges!.top)).toEqual([3, 0, 4]);
    expect(Array.from(model.parts(missing!)[1]!.edges!.top)).toEqual([3, 5, 4]);
    // Rows keep their tops whichever panel they are in.
    expect(Array.from(eu.y)).toEqual([1, 2, 11, 22, 3, 4, 5]);
    expect(model.parts(ok!)[0]!.y0).toBeUndefined();
    model.hidden.add(ok!.key);
    model.scene(estimateText);
    expect(Array.from(model.parts(model.series()[1]!)[0]!.edges!.top)).toEqual([10, 20]);
  });

  it("load from specs, which refuse stackGaps without a series stack", () => {
    const spec = (mark: Record<string, unknown>) =>
      ({
        data: { t: { columns: { x: [0, 1], y: [1, 2], s: ["a", "b"] } } },
        marks: [{ type: "area", x: "x", y: "y", ...mark }],
      }) as never;
    const { config } = loadSpec(spec({ series: "s", stack: true, stackGaps: "interpolate" }));
    expect(config.marks[0]!.spec).toMatchObject({ stack: true, stackGaps: "interpolate" });
    expect(() => loadSpec(spec({ series: "s", stackGaps: "zero" }))).toThrow(/stackGaps/);
    expect(() => loadSpec(spec({ stack: true, series: "s", stackGaps: "linear" }))).toThrow(
      /stackGaps/,
    );
    expect(() => area(requests(), { x: "minute", y: "count", stackGaps: "zero" } as never)).toThrow(
      /stackGaps/,
    );
  });
});

/** y values are read back through the scale, which rounds to pixels in single precision. */
function near(value: number) {
  return expect.closeTo(value, 4);
}

describe("stacks of series over streaming tables", () => {
  /** Two series at each minute, and a third at every other one. */
  function rows(from: number, count: number) {
    const out = { minute: [] as number[], count: [] as number[], status: [] as string[] };
    for (let m = from; m < from + count; m++) {
      for (const status of m % 2 ? ["200", "500"] : ["500", "200", "404"]) {
        out.minute.push(m);
        out.count.push(m % 7 === 3 && status === "500" ? Number.NaN : ((m * 5) % 11) - 2);
        out.status.push(status);
      }
    }
    return out;
  }

  /** The table's rows in a table of their own, categories in the same order. */
  const copy = <S extends Schema>(data: Table<S>) => {
    const { codes, dictionary } = data.categories("status" as never);
    return table({
      minute: Array.from(data.numbers("minute" as never)),
      count: Array.from(data.numbers("count" as never)),
      status: encodedCategory(codes.slice(), [...dictionary]),
    });
  };

  const drawn = (model: ChartModel) =>
    model.scene(estimateText).panels[0]!.marks.map((mark) => {
      if (mark.kind === "rect") {
        const { rects, count } = mark as RectGeometry;
        return Array.from(rects.subarray(0, count * 4));
      }
      const { upper, lower } = mark as AreaGeometry;
      return [points(upper), lower && points(lower)];
    });

  it("empty and fill again with their table", () => {
    const data = table(rows(0, 10), { maxRows: 30 });
    const model = sceneOf({ marks: [stacked(data)] }).model;
    data.dropFirst(data.length);
    model.scene(estimateText);
    expect(model.series()).toEqual([]);
    data.append(rows(50, 4));
    model.scene(estimateText);
    // Margins kept from before move the pixels: the stacks are compared.
    const stacks = (model: ChartModel) =>
      model.series().map((s) => [Array.from(s.y), Array.from(s.edges!.top)]);
    expect(stacks(model)).toEqual(stacks(sceneOf({ marks: [stacked(copy(data))] }).model));
    // Facets then stack panels of their own, and leave the whole table's stack.
    const regions = table({ ...rows(0, 6), region: category(Array(15).fill("eu")) });
    const mark = stacked(regions);
    const whole = sceneOf({ marks: [mark] }).model;
    const faceted = sceneOf({ marks: [mark], facet: facet("region") }).model;
    regions.dropFirst(regions.length);
    faceted.scene(estimateText);
    expect(faceted.series()).toEqual([]);
    regions.append({ ...rows(10, 2), region: Array(5).fill("eu") });
    faceted.scene(estimateText);
    const part = faceted.parts(faceted.series()[0]!)[0]!;
    expect(Array.from(part.edges!.x)).toEqual([10, 11]);
    expect(whole.scene(estimateText).panels[0]!.marks).toHaveLength(3);
    // Bars too.
    const sales = table({ ...rows(0, 6), region: category(Array(15).fill("eu")) });
    const bars = bar(sales, { x: "minute", y: "count", series: "status", stack: true });
    sceneOf({ marks: [bars] });
    const panels = sceneOf({ marks: [bars], facet: facet("region") }).model;
    sales.dropFirst(sales.length);
    panels.scene(estimateText);
    sales.append({ ...rows(10, 2), region: Array(5).fill("eu") });
    panels.scene(estimateText);
    // Minute 10: the 500s missing, 200s and 404s at 4 each; minute 11: 500s and 200s at -2.
    expect(Array.from(panels.parts(panels.series()[0]!)[0]!.y)).toEqual([Number.NaN, 4, 8, -4, -2]);
  });

  for (const [name, mark] of [
    ["areas", <S extends Schema>(data: Table<S>) => stacked(data)],
    [
      "interpolated areas",
      <S extends Schema>(data: Table<S>) => stacked(data, { stackGaps: "interpolate" }),
    ],
    [
      "bars",
      <S extends Schema>(data: Table<S>) =>
        bar(data as never, { x: "minute", y: "count", series: "status", stack: true } as never),
    ],
  ] as const) {
    it(`draw ${name} as a chart of the same rows does`, async () => {
      const data = table(rows(0, 40), { maxRows: 97 });
      const streaming = new ChartModel({ locale: "en-US", marks: [mark(data)] });
      streaming.setSize(600, 300, 1);
      streaming.scene(estimateText);
      // Rows are grouped as they stream once the grouping's code has loaded.
      await import("../../src/marks/split.ts");
      await new Promise((resolve) => setTimeout(resolve, 0));
      let next = 40;
      for (const count of [1, 1, 5, 30, 1, 80, 2]) {
        data.append(rows(next, count));
        next += count;
        const fresh = sceneOf({ marks: [mark(copy(data))] }).model;
        expect(drawn(streaming)).toEqual(drawn(fresh));
        const tops = (model: ChartModel) => model.series().map((s) => Array.from(s.y));
        expect(tops(streaming)).toEqual(tops(fresh));
        expect(streaming.series()[0]!.stream).toBeDefined();
      }
    });
  }

  for (const [name, mark] of [
    ["areas", <S extends Schema>(data: Table<S>) => stacked(data)],
    [
      "bars",
      <S extends Schema>(data: Table<S>) =>
        bar(data as never, { x: "minute", y: "count", series: "status", stack: true } as never),
    ],
  ] as const) {
    it(`keep two charts of one mark of ${name} with different hidden series apart`, () => {
      const data = table(rows(0, 20), { maxRows: 60 });
      const shared = mark(data);
      const one = sceneOf({ marks: [shared] }).model;
      const two = sceneOf({ marks: [shared] }).model;
      two.hidden.add(two.series()[0]!.key);
      /** Where the first chart's tooltip places each series at minute `m`. */
      const read = (model: ChartModel, m: number) =>
        model.inspect(model.xScale()!.map(m), model.yScale()!.map(1))?.points.map((p) => p.py);
      for (let m = 20; m < 30; m++) {
        data.append(rows(m, 1));
        const a = drawn(one);
        const b = drawn(two);
        const fresh = sceneOf({ marks: [mark(copy(data))] }).model;
        expect(a).toEqual(drawn(fresh));
        const hidden = sceneOf({ marks: [mark(copy(data))] }).model;
        hidden.hidden.add(hidden.series()[0]!.key);
        expect(b).toEqual(drawn(hidden));
        // The other chart's stack leaves the first chart's tooltips as drawn.
        expect(read(one, m - 3)).toEqual(read(fresh, m - 3));
      }
    });
  }
});
