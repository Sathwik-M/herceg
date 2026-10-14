import { describe, expect, it } from "vitest";
import { category } from "../../src/data/column.ts";
import { letterDepth, letterValues, normalQuantile } from "../../src/data/letter-values.ts";
import { table } from "../../src/data/table.ts";
import { loadSpec } from "../../src/from-spec.ts";
import { estimateText } from "../../src/layout/text.ts";
import { boxen } from "../../src/marks/boxen.ts";
import { boxplot } from "../../src/marks/boxplot.ts";
import { describeChart } from "../../src/model/describe.ts";
import { facet } from "../../src/model/facet.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { renderToSVG } from "../../src/render/static.ts";
import type { PointGeometry, RectGeometry } from "../../src/scene/scene.ts";

// A sample with far values, and Seaborn 0.13.2's LetterValues of it
// (python/tests check the express side against Seaborn itself).
const SAMPLE = [
  10.002, 10.597, 9.452, 8.219, 9.091, 8.017, 10.12, 12.68, 9.016, 8.759, 10.98, 10.714, 10.211,
  8.139, 9.941, 11.391, 7.312, 9.085, 6.198, 7.421, 6.317, 9.53, 7.465, 10.543, 10.314, 9.626,
  4.966, 8.923, 9.903, 10.227, 6.94, 9.044, 8.043, 8.382, 12.122, 8.385, 9.935, 11.769, 8.833,
  9.777, 10.221, 10.128, 7.55, 10.152, 12.718, 6.906, 11.719, 10.239, 8.717, 14.001, 11.525, 7.601,
  10.149, 11.153, 9.622, 11.366, 9.867, 11.334, 12.877, 8.649, 10.406, 9.073, 10.255, 7.626, 8.841,
  9.608, 11.798, 12.29, 7.353, 8.411, 11.294, 6.015, 9.074, 9.805, 12.514, 11.379, 9.346, 9.263,
  9.5, 13.047, 9.144, 9.393, 10.705, 9.758, 9.605, 7.772, 9.977, 9.113, 12.332, 11.306, 9.952,
  11.337, 9.32, 12.104, 9.989, 11.167, 30, 31, -8, 25,
];
const SEABORN = {
  tukey: { k: 3, values: [7.00975, 7.610375, 8.8145, 11.1565, 11.98925, 12.710875], fliers: 14 },
  trustworthy: {
    k: 4,
    values: [6.20915625, 7.00975, 7.610375, 8.8145, 11.1565, 11.98925, 12.710875, 13.9115625],
    fliers: 8,
  },
  full: {
    k: 7,
    values: [
      -8, 2.028390625, 5.539671875, 6.20915625, 7.00975, 7.610375, 8.8145, 11.1565, 11.98925,
      12.710875, 13.9115625, 27.265625, 30.2265625, 31,
    ],
    fliers: 0,
  },
} as const;

function build(config: ChartConfig) {
  const model = new ChartModel({ locale: "en-US", ...config });
  model.setSize(600, 300, 1);
  const scene = model.scene(estimateText);
  return { model, scene, marks: scene.panels[0]!.marks };
}

const sample = () => table({ g: category(SAMPLE.map(() => "a")), v: SAMPLE });

describe("letter values", () => {
  it("chooses Seaborn's depth for each rule, cutting logarithms toward zero", () => {
    // Seaborn's _compute_k for tukey, proportion (0.007), trustworthy (0.05), and full.
    const expected: Record<number, number[]> = {
      1: [1, 8, 1, 1],
      2: [1, 8, 1, 2],
      7: [1, 7, 1, 3],
      16: [1, 8, 2, 5],
      100: [3, 7, 4, 7],
      1023: [6, 8, 8, 10],
      1024: [7, 9, 8, 11],
      100000: [13, 8, 14, 17],
    };
    for (const [n, ks] of Object.entries(expected)) {
      const rules = ["tukey", "proportion", "trustworthy", "full"] as const;
      expect(rules.map((rule) => letterDepth(Number(n), rule, 0.007, 0.05))).toEqual(ks);
    }
    expect(letterDepth(1024, "proportion", 0.1, 0.05)).toBe(5);
    expect(letterDepth(1000, "trustworthy", 0.007, 0.2)).toBe(9);
    expect(letterDepth(50, 3, 0.007, 0.05)).toBe(3);
    // Alphas too small for 1 - alpha / 2 to differ from 1 still have a depth.
    expect(letterDepth(1000, "trustworthy", 0.007, 1e-20)).toBe(3);
    expect(letterDepth(1e6, "trustworthy", 0.007, 1e-20)).toBe(13);
    expect(letterDepth(1e6, "trustworthy", 0.007, Number.MIN_VALUE)).toBeGreaterThanOrEqual(1);
  });

  it("takes Seaborn's letter values and outliers", () => {
    const sorted = Float64Array.from(SAMPLE).sort();
    for (const [rule, { k, values }] of Object.entries(SEABORN)) {
      expect(letterDepth(SAMPLE.length, rule as "tukey", 0.007, 0.05)).toBe(k);
      const ours = letterValues(sorted, k, rule === "full");
      for (const [i, value] of values.entries()) expect(ours[i]).toBeCloseTo(value, 12);
    }
  });

  it("computes the normal quantile as Python's NormalDist does", () => {
    for (const [p, z] of [
      [0.975, 1.9599639845400534],
      [0.9, 1.2815515655446006],
      [0.5, 0],
      [0.6, 0.2533471031357998],
      [0.999, 3.090232306167813],
      [1 - 1e-12, 7.0344869100478356],
      [0.01, -2.3263478740408408],
    ] as const)
      expect(normalQuantile(p)).toBeCloseTo(z, 14);
  });
});

describe("boxen", () => {
  const rects = (marks: ReturnType<typeof build>["marks"]) =>
    marks.filter((mark): mark is RectGeometry => mark.kind === "rect");
  const dots = (marks: ReturnType<typeof build>["marks"]) =>
    marks.find((mark): mark is PointGeometry => mark.kind === "point")!;

  it("draws a level of boxes per letter value, lighter outward, and the outliers", () => {
    const { marks } = build({ marks: [boxen(sample(), { x: "g", y: "v" })] });
    const levels = rects(marks);
    // Tukey's 3 levels: the quartile box and two pairs of tail boxes.
    expect(levels.map((level) => level.count)).toEqual([2, 2, 1]);
    const opacities = levels.map((level) => level.fillOpacity);
    expect(opacities[2]).toBeCloseTo(0.7);
    expect(opacities[1]).toBeCloseTo(0.7 * 2 ** (-1 / 3));
    expect(opacities[0]).toBeCloseTo(0.7 * 2 ** (-2 / 3));
    // Exponential widths: each level out is half as wide.
    const widthOf = (level: RectGeometry) => level.rects[2]!;
    expect(widthOf(levels[1]!) / widthOf(levels[2]!)).toBeCloseTo(0.5);
    expect(widthOf(levels[0]!) / widthOf(levels[2]!)).toBeCloseTo(0.25);
    expect(dots(marks).count).toBe(SEABORN.tukey.fliers);
  });

  it("widens levels linearly or by their share of the values", () => {
    const widths = (widthMethod: "linear" | "area") => {
      const { marks } = build({ marks: [boxen(sample(), { x: "g", y: "v", widthMethod })] });
      const levels = rects(marks);
      return levels.map((level) => level.rects[2]! / levels[2]!.rects[2]!);
    };
    expect(widths("linear").map((w) => w * 3)).toEqual([1, 2, 3].map((w) => expect.closeTo(w)));
    // Area: 2^(exponent - tail) / height, relative to the widest.
    const v = SEABORN.tukey.values;
    const area = [2 ** -5 / (v[1] - v[0]), 2 ** -4 / (v[2] - v[1]), 2 ** -2 / (v[3] - v[2])];
    const widest = Math.max(...area);
    const ours = widths("area");
    // The lower tail boxes come first in each level.
    expect(ours[0]).toBeCloseTo(area[0]! / widest / (area[2]! / widest));
    expect(ours[1]).toBeCloseTo(area[1]! / widest / (area[2]! / widest));
  });

  it("hides outliers from drawing and the value axis, not from tooltips", () => {
    const shown = build({ marks: [boxen(sample(), { x: "g", y: "v" })] });
    const hidden = build({ marks: [boxen(sample(), { x: "g", y: "v", outliers: false })] });
    expect(dots(hidden.marks).count).toBe(0);
    const [low, high] = hidden.model.panels()[0]!.y.domain;
    expect(low).toBeGreaterThan(-8);
    expect(high).toBeLessThan(31);
    expect(shown.model.panels()[0]!.y.domain[1]).toBeGreaterThanOrEqual(31);
    const text = describeChart(hidden.model);
    expect(text).toContain("box");
  });

  it("loads from the portable spec, and refuses options it does not take", () => {
    const { config } = loadSpec({
      data: { rows: { columns: { g: ["a", "a", "b", "b"], v: [1, 2, 3, 4] } } },
      marks: [{ type: "boxen", x: "g", y: "v", depth: "full", widthMethod: "linear" }],
    } as never);
    expect(config.marks[0]!.spec.type).toBe("boxen");
    for (const [option, value, message] of [
      ["depth", 0, "marks[0].depth"],
      ["depth", "quartiles", "marks[0].depth"],
      ["outlierProportion", 1, "marks[0].outlierProportion"],
      ["widthMethod", "square", "marks[0].widthMethod"],
      ["whiskers", "tukey", "whiskers"],
    ] as const)
      expect(() =>
        loadSpec({
          data: { rows: { columns: { g: ["a"], v: [1] } } },
          marks: [{ type: "boxen", x: "g", y: "v", [option]: value }],
        } as never),
      ).toThrow(message);
    expect(() => boxen(sample(), { x: "g", y: "v", depth: 1.5 })).toThrow(
      /boxen depth: expected "tukey"/,
    );
  });

  it("summarizes each facet panel's rows, along either axis, and exports", () => {
    const data = table({
      g: category(SAMPLE.map((_, i) => (i % 2 ? "odd" : "even"))),
      side: category(SAMPLE.map((_, i) => (i % 3 ? "left" : "right"))),
      v: SAMPLE,
    });
    const { scene } = build({
      marks: [boxen(data, { x: "v", y: "g" })],
      facet: facet({ column: "side" }),
    });
    expect(scene.panels).toHaveLength(2);
    const svg = renderToSVG({
      marks: [boxen(data, { x: "g", y: "v", series: "side" })],
      title: "Letter values",
      width: 400,
      height: 240,
      locale: "en-US",
    });
    expect(svg).toContain("<svg");
    expect(svg).toContain("Letter values");
  });
});

describe("box plot outliers", () => {
  it("draws no dots and leaves them out of the axis, still counting them", () => {
    const shown = build({ marks: [boxplot(sample(), { x: "g", y: "v" })] });
    const hidden = build({ marks: [boxplot(sample(), { x: "g", y: "v", outliers: false })] });
    const points = (marks: ReturnType<typeof build>["marks"]) =>
      marks.find((mark): mark is PointGeometry => mark.kind === "point")!.count;
    expect(points(shown.marks)).toBeGreaterThan(0);
    expect(points(hidden.marks)).toBe(0);
    expect(hidden.model.panels()[0]!.y.domain[1]).toBeLessThan(31);
    expect(() =>
      boxplot(table({ g: category(["a"]), lo: [0], a: [1], m: [2], b: [3], hi: [4] }), {
        x: "g",
        low: "lo",
        q1: "a",
        median: "m",
        q3: "b",
        high: "hi",
        outliers: false,
      } as never),
    ).toThrow("boxplot outliers: precomputed boxes have none to draw; drop outliers");
  });
});
