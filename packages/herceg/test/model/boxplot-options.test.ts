import { describe, expect, it } from "vitest";
import { category, time } from "../../src/data/column.ts";
import { boxStats } from "../../src/data/quantile.ts";
import { table } from "../../src/data/table.ts";
import { areaPath } from "../../src/draw/area.ts";
import { loadSpec } from "../../src/from-spec.ts";
import { estimateText } from "../../src/layout/text.ts";
import { type BoxPlotMark, boxplot } from "../../src/marks/boxplot.ts";
import { point } from "../../src/marks/point.ts";
import { violin } from "../../src/marks/violin.ts";
import { describeChart } from "../../src/model/describe.ts";
import { facet } from "../../src/model/facet.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { renderToSVG } from "../../src/render/static.ts";
import type {
  AreaGeometry,
  PointGeometry,
  RectGeometry,
  SegmentGeometry,
} from "../../src/scene/scene.ts";
import { checkSpec, validateSpec } from "../../src/spec/validate.ts";
import legacyBoxes from "./fixtures/boxplot-legacy.json";

const fields = { low: "lo", q1: "p25", median: "p50", q3: "p75", high: "hi" } as const;
const statistics = () =>
  table({ group: ["a"], lo: [0], p25: [25], p50: [50], p75: [75], hi: [100], n: [100] });
function build(config: ChartConfig) {
  const model = new ChartModel({ locale: "en-US", ...config });
  model.setSize(600, 300, 1);
  const scene = model.scene(estimateText);
  return { model, scene, marks: scene.panels[0]!.marks };
}

describe("box plot options", () => {
  // Statistics and packed geometry captured from f7336eb, before these options.
  it.each(legacyBoxes)("preserves legacy statistics and geometry for $values", (legacy) => {
    const expected = Object.fromEntries(
      Object.entries(legacy.stats).map(([key, value]) => [key, value ?? Number.NaN]),
    );
    const data = table({ g: category(legacy.values.map(() => "a")), v: legacy.values });
    const compact = (marks: ReturnType<typeof build>["marks"]) =>
      marks
        .filter((mark) => ["rect", "segments", "point"].includes(mark.kind))
        .map((mark) => {
          const shape = mark as RectGeometry | SegmentGeometry | PointGeometry;
          return {
            kind: shape.kind,
            count: shape.count,
            coords: Array.from(
              ("rects" in shape ? shape.rects : shape.coords).subarray(
                0,
                shape.count * (shape.kind === "point" ? 2 : 4),
              ),
            ),
          };
        });
    for (const whiskers of [undefined, "tukey", 1.5] as const) {
      expect(boxStats(legacy.values, whiskers)).toEqual(expected);
      const options = whiskers === undefined ? {} : { whiskers };
      const { marks } = build({
        marks: [boxplot(data, { x: "g", y: "v", ...options })],
        y: { domain: [-1, 51], nice: false },
      });
      expect(compact(marks)).toEqual(legacy.geometry.boxplot);
    }
    const { marks } = build({
      marks: [violin(data, { x: "g", y: "v" })],
      y: { domain: [-1, 51], nice: false },
    });
    expect(compact(marks)).toEqual(legacy.geometry.violin);
  });

  it("preserves default fence arithmetic even for overflowing legacy reaches", () => {
    const values = [5e307, 5e307, 5e307, 1.79e308, 1.79e308, 1.79e308, 1.79e308];
    for (const whiskers of [undefined, "tukey", 1.5] as const)
      expect(boxStats(values, whiskers)).toEqual({
        count: 7,
        low: 5e307,
        q1: 5e307,
        median: 1.79e308,
        q3: 1.79e308,
        high: 1.79e308,
        outliers: [],
      });
  });

  it.each([false, true])(
    "places precomputed statistics at their value pixels (horizontal %s)",
    (horizontal) => {
      const data = statistics();
      const mark = boxplot(
        data,
        horizontal ? { y: "group", ...fields } : { x: "group", ...fields, axis: "right" },
      );
      const { model, marks } = build({ marks: [mark] });
      const panel = model.panels()[0]!;
      const scale = horizontal ? panel.x : panel.yRight!;
      const rect = marks.find((m) => m.kind === "rect") as RectGeometry;
      expect(rect.count).toBe(1);
      const [x, y, w, h] = rect.rects;
      expect(horizontal ? x : y).toBeCloseTo(Math.min(scale.map(25), scale.map(75)), 4);
      expect(horizontal ? w : h).toBeCloseTo(Math.abs(scale.map(25) - scale.map(75)), 4);
      const lines = marks.find((m) => m.kind === "segments") as SegmentGeometry;
      const at = (segment: number) => lines.coords[segment * 4 + (horizontal ? 0 : 1)]!;
      expect(at(4)).toBeCloseTo(scale.map(50), 4);
      expect(at(6)).toBeCloseTo(scale.map(0), 4);
      expect(at(8)).toBeCloseTo(scale.map(100), 4);
      expect((marks.find((m) => m.kind === "point") as PointGeometry).count).toBe(0);
      expect(scale.domain[0]).toBeLessThanOrEqual(0);
      expect(scale.domain[1]).toBeGreaterThanOrEqual(100);
      const stops = model.keyboardStops("");
      const read = model.inspectPosition(stops[0]!.key, 0)!;
      expect(read.points[0]).toMatchObject({
        value: 50,
        text: "median 50, quartiles 25 to 75, whiskers 0 to 100",
      });
      expect(read.points[0]!.row).toBeUndefined();
      expect(describeChart(model)).toContain("p50: 1 box, medians from 50 (a) to 50 (a)");
    },
  );

  it.each(["tukey", "range", 0, 1, 10] as const)(
    "uses the %s whisker rule in statistics and geometry",
    (whiskers) => {
      const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 40];
      const expected =
        whiskers === "range" || whiskers === 10
          ? [1, 40, 0]
          : whiskers === 0
            ? [3.25, 7.75, 6]
            : [1, 9, 1];
      const stats = boxStats(values, whiskers);
      expect([stats.low, stats.high, stats.outliers.length]).toEqual(expected);
      const { model, marks } = build({
        marks: [
          boxplot(table({ g: values.map(() => "a"), v: values }), { x: "g", y: "v", whiskers }),
        ],
      });
      const lines = marks.find((m) => m.kind === "segments") as SegmentGeometry;
      expect(lines.coords[6 * 4 + 1]).toBeCloseTo(model.yScale()!.map(expected[0]!), 4);
      expect(lines.coords[8 * 4 + 1]).toBeCloseTo(model.yScale()!.map(expected[1]!), 4);
      expect((marks.find((m) => m.kind === "point") as PointGeometry).count).toBe(expected[2]);
    },
  );

  it("keeps zero-multiple whiskers ordered with no observations inside the quartiles", () => {
    expect(boxStats([0, 10], 0)).toMatchObject({ low: 2.5, high: 7.5, outliers: [0, 10] });
    expect(boxStats([-1e308, 1e308], 0)).toMatchObject({
      low: -5e307,
      high: 5e307,
      outliers: [-1e308, 1e308],
    });
  });

  it("keeps small whisker multiples finite when IQR subtraction overflows", () => {
    const extreme = [-1.7e308, -1e308, -1e308, 0, 1e308, 1e308, 1.7e308];
    expect(boxStats(extreme, 0.1)).toMatchObject({
      low: -1e308,
      high: 1e308,
      outliers: [-1.7e308, 1.7e308],
    });
  });

  it("retains representable fences when a finite IQR times a finite multiplier overflows", () => {
    const values = [-1.7e308, 1e308, 1e308, 1e308, 1.7e308, 1.7e308, 1.7e308];
    expect(boxStats(values, 3)).toEqual({
      count: 7,
      low: 1e308,
      q1: 1e308,
      median: 1e308,
      q3: 1.7e308,
      high: 1.7e308,
      outliers: [-1.7e308],
    });
    // The symmetric case exercises cancellation at the upper fence too.
    expect(boxStats(values.map((value) => -value).reverse(), 3)).toMatchObject({
      low: -1.7e308,
      high: -1e308,
      outliers: [1.7e308],
    });
    const { model, marks } = build({
      marks: [
        boxplot(table({ g: values.map(() => "a"), v: values }), { x: "g", y: "v", whiskers: 3 }),
      ],
      y: { type: "log", domain: [1e307, 1.79e308], nice: false },
    });
    const lines = marks.find((mark) => mark.kind === "segments") as SegmentGeometry;
    expect(lines.count).toBe(9);
    expect(lines.coords[5 * 4 + 3]).toBeCloseTo(model.yScale()!.map(1e308), 4);
    expect(lines.coords[6 * 4 + 1]).toBeCloseTo(model.yScale()!.map(1e308), 4);
    expect((marks.find((mark) => mark.kind === "point") as PointGeometry).count).toBe(0);
    expect([...lines.coords.subarray(0, lines.count * 4)].every(Number.isFinite)).toBe(true);
  });

  it("divides an overflowing IQR before computing a finite notch interval", () => {
    const data = table({
      group: ["a"],
      lo: [-1e308],
      p25: [-1e308],
      p50: [0],
      p75: [1e308],
      hi: [1e308],
      n: [100],
    });
    const { model, marks } = build({
      marks: [boxplot(data, { y: "group", ...fields, count: "n", notch: true })],
      x: { domain: [-1e307, 1e307] },
    });
    const area = marks.find((m) => m.kind === "area") as AreaGeometry;
    expect(area.upper.count).toBe(5);
    expect(area.upper.coords[2]).toBeCloseTo(model.xScale()!.map(-3.14e307), 3);
    expect(area.upper.coords[6]).toBeCloseTo(model.xScale()!.map(3.14e307), 3);
  });

  it("retains a finite notch endpoint even when the half-width overflows", () => {
    const data = table({ group: ["a", "a", "a", "a"], v: [-1.7e308, -1.7e308, 1e308, 1e308] });
    const mark = boxplot(data, { x: "group", y: "v", notch: true }) as BoxPlotMark;
    const { model, marks } = build({
      marks: [mark],
      y: { type: "log", domain: [1e307, 1.79e308] },
    });
    const s = model.panelSeries("")[0]!;
    expect(mark.yExtent!([s], 0, 1, true)![1]).toBeCloseTo(1.7695e308, -294);
    const lines = marks.find((m) => m.kind === "segments") as SegmentGeometry;
    const endpoint = model.yScale()!.map(1.7695e308);
    expect(
      [...lines.coords.subarray(0, lines.count * 4)].some(
        (value, i) => i % 2 === 1 && Math.abs(value - endpoint) < 0.001,
      ),
    ).toBe(true);
  });

  it.each([false, true])(
    "infers precomputed time axes from every statistic except count (horizontal %s)",
    (horizontal) => {
      const day = 86_400_000;
      const start = Date.UTC(2026, 0, 1);
      const data = table({
        group: ["a"],
        lo: time([start]),
        p25: [start + day],
        p50: [start + 2 * day],
        p75: [start + 3 * day],
        hi: [start + 4 * day],
        n: [100],
      });
      const { model } = build({
        marks: [
          boxplot(
            data,
            horizontal
              ? { y: "group", ...fields, count: "n" }
              : { x: "group", ...fields, count: "n" },
          ),
        ],
      });
      expect((horizontal ? model.xScale() : model.yScale())!.type).toBe("time");
      expect(model.inspectPosition(model.keyboardStops("")[0]!.key, 0)!.points[0]!.text).toMatch(
        /median Jan 3/,
      );
    },
  );

  it("keeps notch paths finite when a log axis cannot place all vertices", () => {
    const { marks } = build({
      marks: [
        boxplot(
          table({ group: ["a"], lo: [0], p25: [1], p50: [2], p75: [100], hi: [101], n: [2] }),
          { x: "group", ...fields, count: "n", notch: true },
        ),
      ],
      y: { type: "log" },
    });
    const area = marks.find((m) => m.kind === "area") as AreaGeometry;
    expect(area.upper.count).toBe(0);
    expect(area.lower!.count).toBe(0);
    const lines = marks.find((m) => m.kind === "segments") as SegmentGeometry;
    expect(lines.count).toBeGreaterThan(0);
    expect([...lines.coords.subarray(0, lines.count * 4)].every(Number.isFinite)).toBe(true);
    expect(areaPath(area)).not.toMatch(/NaN|Infinity/);
  });

  it("picks drawable notch outlines when a log axis omits one notch endpoint", () => {
    const data = table({
      group: ["a", "a"],
      lo: [1, 3.5],
      p25: [1, 3.75],
      p50: [2, 4],
      p75: [3, 4.25],
      hi: [3, 4.5],
      n: [1, 100],
    });
    const { model, marks } = build({
      marks: [boxplot(data, { x: "group", ...fields, count: "n", notch: true })],
      y: { type: "log" },
    });
    const lines = marks.find((m) => m.kind === "segments") as SegmentGeometry;
    // Midpoint of the first box's finite median-to-upper-notch outline.
    const x = (lines.coords[0]! + lines.coords[2]!) / 2;
    const y = (lines.coords[1]! + lines.coords[3]!) / 2;
    expect(model.inspect(x, y, "nearest")!.points[0]!.value).toBe(2);
  });

  it("retains one precomputed box per row and repeats them across facets on request", () => {
    const data = table({
      panel: ["N", "S", "S"],
      group: ["a", "a", "a"],
      lo: [0, 10, 20],
      p25: [1, 11, 21],
      p50: [2, 12, 22],
      p75: [3, 13, 23],
      hi: [4, 14, 24],
    });
    const one = build({ marks: [boxplot(data, { x: "group", ...fields })] });
    expect(one.model.panelSeries("")[0]!.length).toBe(3);
    expect(describeChart(one.model)).toContain("3 boxes");
    const repeated = build({
      marks: [
        boxplot(data, { x: "group", ...fields, facet: "repeat" }),
        point(data, { x: "group", y: "p50" }),
      ],
      facet: facet("panel"),
    });
    expect(
      repeated.model.panels().map((p) => repeated.model.panelSeries(p.key)[0]!.length),
    ).toEqual([3, 3]);
  });

  it.each([false, true])(
    "draws notches as packed areas and a narrow median (horizontal %s)",
    (horizontal) => {
      const mark = boxplot(
        statistics(),
        horizontal
          ? { y: "group", ...fields, count: "n", notch: true }
          : { x: "group", ...fields, count: "n", notch: true },
      );
      const { model, marks } = build({ marks: [mark] });
      const panel = model.panels()[0]!;
      const value = horizontal ? panel.x : panel.y;
      const category = horizontal ? panel.y : panel.x;
      const area = marks.find((m) => m.kind === "area") as AreaGeometry;
      expect(area.upper.count).toBe(5);
      expect(area.lower!.count).toBe(5);
      const half = (1.57 * 50) / Math.sqrt(100);
      for (const [i, v] of [25, 50 - half, 50, 50 + half, 75].entries()) {
        expect(area.upper.coords[i * 2 + (horizontal ? 0 : 1)]).toBeCloseTo(value.map(v), 4);
        expect(area.lower!.coords[i * 2 + (horizontal ? 0 : 1)]).toBeCloseTo(value.map(v), 4);
      }
      const along = horizontal ? 1 : 0;
      const waist = Math.abs(area.upper.coords[4 + along]! - area.lower!.coords[4 + along]!);
      const width = Math.abs(area.upper.coords[along]! - area.lower!.coords[along]!);
      expect(waist).toBeCloseTo(width / 2, 4);
      expect(width).toBeCloseTo(category.bandwidth! * 0.7, 4);
      const lines = marks.find((m) => m.kind === "segments") as SegmentGeometry;
      expect(lines.count).toBe(15);
      expect(
        Math.abs(lines.coords[10 * 4 + along + 2]! - lines.coords[10 * 4 + along]!),
      ).toBeCloseTo(waist, 4);
      expect(renderToSVG({ width: 600, height: 300, marks: [mark], locale: "en-US" })).toContain(
        areaPath(area),
      );
      expect(model.inspectPosition(model.keyboardStops("")[0]!.key, 0)!.points[0]!.text).toContain(
        "100 values",
      );
    },
  );

  it("uses raw counts and includes unbounded notches in extents and picking", () => {
    const { model, marks } = build({
      marks: [boxplot(table({ g: ["a", "a"], v: [0, 100] }), { x: "g", y: "v", notch: true })],
    });
    const half = (1.57 * 50) / Math.sqrt(2);
    const scale = model.yScale()!;
    expect(scale.domain[0]).toBeLessThanOrEqual(50 - half);
    expect(scale.domain[1]).toBeGreaterThanOrEqual(50 + half);
    const area = marks.find((m) => m.kind === "area") as AreaGeometry;
    expect(area.upper.coords[3]).toBeCloseTo(scale.map(50 - half), 4);
    const hit = model.inspect(model.xScale()!.map(0), scale.map(50 + half), "nearest")!;
    expect(hit.points[0]!.value).toBe(50);
  });

  it("omits nonfinite boxes, validates ordering/count, and refreshes after table updates", () => {
    const data = table({
      g: ["a", "b"],
      lo: [0, 0],
      p25: [1, Number.NaN],
      p50: [2, 2],
      p75: [3, 3],
      hi: [4, 4],
      n: [10, 10],
    });
    const mark = boxplot(data, { x: "g", ...fields, count: "n" });
    const { model } = build({ marks: [mark] });
    expect(model.panelSeries("")[0]!.length).toBe(1);
    data.append({ g: ["c"], lo: [10], p25: [11], p50: [12], p75: [13], hi: [14], n: [20] });
    model.scene(estimateText);
    expect(model.panelSeries("")[0]!.length).toBe(2);
    for (const n of [0, -1, 0.5, Infinity, Number.NaN]) {
      const bad = table({ group: ["a"], lo: [0], p25: [1], p50: [2], p75: [3], hi: [4], n: [n] });
      expect(() =>
        build({ marks: [boxplot(bad, { x: "group", ...fields, count: "n", notch: true })] }),
      ).toThrow(/count at row 0.*positive/);
    }
    expect(() =>
      build({
        marks: [
          boxplot(table({ group: ["a"], lo: [30], p25: [25], p50: [50], p75: [75], hi: [100] }), {
            x: "group",
            ...fields,
          }),
        ],
      }),
    ).toThrow(/low <= q1/);
  });

  it.each([false, true])(
    "preserves facets, per-panel categories, legends, tooltips and keyboard reads (horizontal %s)",
    (horizontal) => {
      const data = table({
        panel: ["N", "N", "S", "S"],
        group: ["a", "b", "b", "c"],
        series: ["one", "two", "one", "two"],
        lo: [0, 10, 100, 200],
        p25: [1, 11, 101, 201],
        p50: [2, 12, 102, 202],
        p75: [3, 13, 103, 203],
        hi: [4, 14, 104, 204],
        n: [10, 20, 30, 40],
      });
      const mark = boxplot(
        data,
        horizontal
          ? { y: "group", ...fields, series: "series", count: "n" }
          : { x: "group", ...fields, series: "series", count: "n" },
      );
      const { model, scene } = build({
        marks: [mark],
        facet: facet("panel"),
        resolve: horizontal
          ? { y: "independent", x: "independent" }
          : { x: "independent", y: "independent" },
      });
      expect(model.panels().map((p) => (horizontal ? p.y : p.x).categories)).toEqual([
        ["a", "b"],
        ["b", "c"],
      ]);
      expect(scene.legend.map((entry) => entry.label)).toEqual(["one", "two"]);
      const stop = model.keyboardStops("S")[0]!;
      const read = model.inspectPosition(stop.key, 0, "S")!;
      expect(read.label).toBe("b");
      expect(read.points[0]).toMatchObject({
        label: "one",
        value: 102,
        text: "median 102, quartiles 101 to 103, whiskers 100 to 104, 30 values",
      });
      const p = model.panels()[1]!;
      const hit = model.inspect(
        horizontal ? p.x.map(102) : p.x.map(0),
        horizontal ? p.y.map(0) : p.y.map(102),
        "nearest",
        "S",
      )!;
      expect(hit.points[0]!.text).toBe(read.points[0]!.text);
      expect(describeChart(model)).toContain("one: 2 boxes, medians from 2 (a) to 102 (b)");
      expect((horizontal ? p.x : p.y).domain[1]).toBeGreaterThanOrEqual(204);
    },
  );
});

describe("box plot validation and compatibility", () => {
  const stats = { type: "boxplot", x: "group", ...fields } as const;
  it.each([
    [{ ...stats, y: "values" }, /both raw x\/y.*precomputed.*low/],
    [{ ...stats, whiskers: "tukey" }, /whiskers.*low and high/],
    [{ ...stats, notch: true }, /notch needs count/],
    [{ type: "boxplot", x: "group", q1: "p25" }, /needs low, median, q3, high/],
    [{ type: "boxplot", x: "group" }, /raw box plot needs x and y/],
    [{ ...stats, x: undefined }, /exactly one category field/],
    [{ type: "boxplot", x: "group", y: "values", whiskers: -1 }, /nonnegative/],
    [{ type: "boxplot", x: "group", y: "values", whiskers: Infinity }, /nonnegative/],
  ])("refuses invalid form %j in specs and direct calls", (spec, error) => {
    expect(() => validateSpec({ version: 6, marks: [spec] })).toThrow(error);
    const { type: _type, ...options } = spec;
    expect(() => boxplot(statistics(), options as never)).toThrow(error);
  });

  it("gates raw semantic changes while older readers already refuse precomputed input", () => {
    for (const version of [undefined, 1, 2, 3, 4, 5]) {
      for (const options of [
        { notch: true },
        { whiskers: "range" },
        { whiskers: 0 },
        { whiskers: 2 },
      ])
        expect(() =>
          validateSpec({ version, marks: [{ type: "boxplot", x: "group", y: "v", ...options }] }),
        ).toThrow(/version.*6/);
      for (const options of [{}, { notch: false }, { whiskers: "tukey" }, { whiskers: 1.5 }])
        expect(() =>
          validateSpec({ version, marks: [{ type: "boxplot", x: "group", y: "v", ...options }] }),
        ).not.toThrow();
      expect(checkSpec({ version, marks: [{ ...stats, count: "n", notch: true }] })).toEqual([]);
    }
    const loaded = loadSpec({
      version: 6,
      data: {
        data: {
          columns: { group: ["a"], lo: [0], p25: [25], p50: [50], p75: [75], hi: [100], n: [100] },
        },
      },
      marks: [{ ...stats, data: "data", count: "n", notch: true }],
    });
    expect(build(loaded.config).marks.some((m) => m.kind === "area")).toBe(true);
  });
});
