import { describe, expect, it } from "vitest";
import { category } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { line } from "../../src/marks/line.ts";
import { radar } from "../../src/marks/radar.ts";
import { describeChart } from "../../src/model/describe.ts";
import { type ChartConfig, ChartModel, type ItemInspection } from "../../src/model/model.ts";
import { renderToSVG } from "../../src/render/static.ts";
import type {
  LineGeometry,
  PointGeometry,
  Scene,
  ShapesGeometry,
  TextGeometry,
} from "../../src/scene/scene.ts";
import { loadSpec } from "../../src/spec/load.ts";

// Long: a row per player and skill. Bo's later speed replaces the first.
const scores = table({
  player: ["Ana", "Ana", "Ana", "Bo", "Bo", "Bo", "Bo"],
  skill: ["speed", "power", "range", "speed", "power", "range", "speed"],
  score: [8, 6, 4, 3, 9, 7, 5],
});
// Wide: a row per player, a field per skill.
const players = table({
  name: ["Ana", "Bo"],
  speed: [8, 5],
  power: [6, 9],
  range: [4, Number.NaN],
  stamina: [7, 2],
});

function build(config: ChartConfig, width = 400, height = 300) {
  const model = new ChartModel({ locale: "en-US", ...config });
  model.setSize(width, height, 1);
  return { model, scene: model.scene(estimateText) };
}

const marks = <G>(scene: Scene, kind: string) =>
  scene.panels[0]!.marks.filter((m) => m.kind === kind) as G[];
const outlines = (scene: Scene) =>
  marks<LineGeometry>(scene, "line").filter((m) => m.key !== "radar-grid");
const points = (mark: PointGeometry) =>
  Array.from({ length: mark.count }, (_, i) => [mark.coords[i * 2]!, mark.coords[i * 2 + 1]!]);
const runs = (mark: LineGeometry) =>
  mark.path.starts
    .map((start, run) => mark.path.runEnd(run) - start)
    .filter((length) => length > 0);
/** Every item's key, in keyboard order. */
function keys(model: ChartModel): string[] {
  const out: string[] = [];
  let key = model.stepItem(undefined, 1);
  while (key && !out.includes(key)) {
    out.push(key);
    key = model.stepItem(key, 1);
  }
  return out;
}

describe("radar", () => {
  it("draws a polygon per series over spokes clockwise from the top", () => {
    const { scene, model } = build({
      marks: [radar(scores, { category: "skill", value: "score", series: "player" })],
    });
    expect(scene.legend.map((entry) => entry.label)).toEqual(["Ana", "Bo"]);
    const [ana, bo] = marks<PointGeometry>(scene, "point");
    expect(ana!.fill).toBe(scene.legend[0]!.color);
    expect(bo!.fill).toBe(scene.legend[1]!.color);
    // speed points straight up from the center, power and range a third of a turn apart.
    const [speed, power, range] = points(ana!);
    const center = model.inspect(speed![0]!, speed![1]!) as ItemInspection;
    expect(center.points[0]!.text).toBe("speed: 8 (of 0 to 10)");
    const cy = speed![1]! + 0.8 * radiusOf(scene);
    const angle = ([x, y]: number[]) => Math.atan2(y! - cy, x! - speed![0]!);
    expect(angle(speed!)).toBeCloseTo(-Math.PI / 2, 5);
    expect(angle(power!)).toBeCloseTo(-Math.PI / 2 + (2 * Math.PI) / 3, 5);
    expect(angle(range!)).toBeCloseTo(-Math.PI / 2 + (4 * Math.PI) / 3, 5);
    // The last row for Bo's speed wins: 5, not 3.
    expect((model.inspect(...(points(bo!)[0] as [number, number])) as ItemInspection).value).toBe(
      5,
    );
    // Whole polygons are filled and closed.
    const fills = marks<ShapesGeometry>(scene, "shapes")[0]!;
    expect(fills.shapes).toHaveLength(2);
    expect(outlines(scene).map(runs)).toEqual([[4], [4]]);
  });

  it("takes a spoke per field, each row a polygon named by its series", () => {
    const { scene, model } = build({
      marks: [radar(players, { fields: ["speed", "power", "range", "stamina"], series: "name" })],
    });
    const labels = marks<TextGeometry>(scene, "text")
      .filter((m) => m.key.startsWith("radar-spokes"))
      .flatMap((m) => m.labels);
    expect(labels.sort()).toEqual(["power", "range", "speed", "stamina"]);
    expect(keys(model).map((key) => JSON.parse(key).slice(1).join("/"))).toEqual([
      "Ana/speed",
      "Ana/power",
      "Ana/range",
      "Ana/stamina",
      "Bo/speed",
      "Bo/power",
      "Bo/stamina",
    ]);
    expect(model.layoutSummary()).toBe(
      "Radar of speed, power, range, stamina: 2 series over 4 spokes, from 0 at the center to 10 at the rim. Highest: Bo's power 9. Lowest: Bo's stamina 2.",
    );
  });

  it("leaves out missing values, breaking the outline there and the fill", () => {
    const { scene } = build({
      marks: [radar(players, { fields: ["speed", "power", "range", "stamina"], series: "name" })],
    });
    // Bo has no range: no fill, and one stretch from stamina round to power.
    expect(marks<ShapesGeometry>(scene, "shapes")[0]!.shapes).toHaveLength(1);
    const [, bo] = outlines(scene);
    expect(runs(bo!)).toEqual([3]);
    expect(marks<PointGeometry>(scene, "point")[1]!.count).toBe(3);
    const gaps = table({
      k: ["a", "b", "c", "d", "e"],
      v: [1, Number.NaN, 3, Number.POSITIVE_INFINITY, 5],
    });
    const broken = outlines(build({ marks: [radar(gaps, { category: "k", value: "v" })] }).scene);
    // c alone between two gaps, then e round to a.
    expect(runs(broken[0]!)).toEqual([1, 2]);
  });

  it("rounds the default domain up from zero, or from the smallest negative value", () => {
    const text = (values: number[], domain?: [number, number]) => {
      const data = table({ k: ["a", "b", "c"], v: values });
      const { model } = build({
        marks: [radar(data, { category: "k", value: "v", ...(domain && { domain }) })],
      });
      return keys(model).map((key) => model.inspectItem(key)!.points[0]!.text);
    };
    expect(text([3, 7.5, 1])).toEqual([
      "a: 3 (of 0 to 8)",
      "b: 7.5 (of 0 to 8)",
      "c: 1 (of 0 to 8)",
    ]);
    expect(text([-3, 5, 1])[0]).toBe("a: -3 (of -4 to 6)");
    expect(text([2, 2, 2])[0]).toBe("a: 2 (of 0 to 2)");
    expect(text([3, 12, -1], [0, 10])).toEqual([
      "a: 3 (of 0 to 10)",
      "b: 12 (above the axis maximum of 10)",
      "c: -1 (below the axis minimum of 0)",
    ]);
  });

  it("clamps values outside the domain to the rim and the center", () => {
    const data = table({ k: ["a", "b", "c"], v: [20, -5, 5] });
    const { scene } = build({
      marks: [radar(data, { category: "k", value: "v", domain: [0, 10] })],
    });
    const [a, b, c] = points(marks<PointGeometry>(scene, "point")[0]!);
    const r = radiusOf(scene);
    const cx = b![0]!;
    const cy = b![1]!;
    // b sits at the center, a on the rim, c halfway.
    expect(Math.hypot(a![0]! - cx, a![1]! - cy)).toBeCloseTo(r, 4);
    expect(Math.hypot(c![0]! - cx, c![1]! - cy)).toBeCloseTo(r / 2, 4);
  });

  it("does not draw hidden series, and fits the domain to the others", () => {
    const { model } = build({
      marks: [radar(scores, { category: "skill", value: "score", series: "player" })],
    });
    const [ana, bo] = model.scene(estimateText).legend;
    model.hidden.add(bo!.key);
    const scene = model.scene(estimateText);
    expect(scene.legend.find((entry) => entry.label === "Bo")!.hidden).toBe(true);
    expect(marks<PointGeometry>(scene, "point").map((m) => m.fill)).toEqual([ana!.color]);
    expect(keys(model)).toHaveLength(3);
    expect(model.inspectItem(keys(model)[0]!)!.points[0]!.text).toBe("speed: 8 (of 0 to 8)");
    // One polygon has no legend.
    const one = build({ marks: [radar(scores, { category: "skill", value: "score" })] }).scene;
    expect(one.legend).toEqual([]);
  });

  it("finds the nearest value within reach of the pointer, and outlines it", () => {
    const { scene, model } = build({
      marks: [radar(scores, { category: "skill", value: "score", series: "player" })],
    });
    const [[x, y]] = points(marks<PointGeometry>(scene, "point")[0]!) as [[number, number]];
    const hit = model.inspect(x + 10, y + 5) as ItemInspection;
    expect([hit.axis, hit.label, hit.points[0]!.label, hit.value]).toEqual([
      "item",
      "score",
      "Ana",
      8,
    ]);
    expect(hit.outline).toMatch(/^M.*a.*a/);
    expect(model.inspect(x + 30, y - 30)).toBeUndefined();
  });

  it("shortens or leaves out spoke labels in a small chart, and keeps the radar", () => {
    const long = table({
      k: ["Ball control", "Passing accuracy", "Defensive awareness", "Shooting power", "Stamina"],
      v: [1, 2, 3, 4, 5],
    });
    const { scene } = build({ marks: [radar(long, { category: "k", value: "v" })] }, 240, 200);
    const labels = marks<TextGeometry>(scene, "text")
      .filter((m) => m.key.startsWith("radar-spokes"))
      .flatMap((m) => m.labels);
    expect(labels).toContain("Ball control");
    expect(labels.some((label) => label.endsWith("…"))).toBe(true);
    expect(radiusOf(scene)).toBeGreaterThan(50);
  });

  it("needs three to a hundred distinct spokes, and one form of data", () => {
    const two = table({ k: ["a", "b"], v: [1, 2] });
    expect(() => radar(two, { category: "k", value: "v" })).toThrow(
      "radar category: expected 3 to 100 spokes; received 2",
    );
    expect(() => radar(players, { fields: ["speed", "power"] as never, series: "name" })).toThrow(
      "radar fields: expected 3 to 100 spokes; received 2",
    );
    expect(() => radar(players, { fields: ["speed", "power", "speed"], series: "name" })).toThrow(
      'radar fields: "speed" repeats; list each field once',
    );
    // Hundreds of spokes are unreadable, and would cost memory per series.
    const many = table({
      k: Array.from({ length: 101 }, (_, i) => `k${i}`),
      v: new Float64Array(101),
    });
    expect(() => radar(many, { category: "k", value: "v" })).toThrow(
      "radar category: expected 3 to 100 spokes; received 101",
    );
    expect(() => radar(players, { fields: ["speed", "power", "name" as never] })).toThrow(
      'radar fields: field "name" holds category values; expected number',
    );
    expect(() => radar(scores, { category: "skill", value: "score", domain: [5, 5] })).toThrow(
      "domain",
    );
    expect(() => radar(scores, { category: "skill", value: "score", fillOpacity: 2 })).toThrow(
      "fillOpacity",
    );
    // An empty table is not a mistake yet: it draws nothing until rows arrive.
    const empty = table({ k: category([]), v: [] as number[] });
    const { scene, model } = build({ marks: [radar(empty, { category: "k", value: "v" })] });
    expect(scene.panels[0]!.marks).toEqual([]);
    expect(model.inspect(200, 150)).toBeUndefined();
    expect(describeChart(model)).toBe("Radar of v by k, with nothing to show.");
  });

  it("takes each series' last row of fields, with or without a series field", () => {
    const twice = table({ s: ["A", "A"], a: [1, 4], b: [2, 5], c: [3, 6] });
    const named = build({ marks: [radar(twice, { fields: ["a", "b", "c"], series: "s" })] });
    expect(keys(named.model).map((key) => named.model.inspectItem(key)!.value)).toEqual([4, 5, 6]);
    // Without a series, every row is one polygon: built that way or appended to.
    const unnamed = build({ marks: [radar(twice, { fields: ["a", "b", "c"] })] });
    expect(keys(unnamed.model).map((key) => unnamed.model.inspectItem(key)!.value)).toEqual([
      4, 5, 6,
    ]);
    const growing = table({ a: [1], b: [2], c: [3] });
    const { model } = build({ marks: [radar(growing, { fields: ["a", "b", "c"] })] });
    growing.append({ a: [7], b: [8], c: [9] });
    model.scene(estimateText);
    expect(keys(model).map((key) => model.inspectItem(key)!.value)).toEqual([7, 8, 9]);
  });

  it("keeps only the values rows give, and draws nothing past 100 spokes", () => {
    // 2,000 series of one value each over 100 spokes: a dense grid would hold 200,000.
    const n = 2000;
    const sparse = table({
      s: Array.from({ length: n }, (_, i) => `s${i}`),
      k: Array.from({ length: n }, (_, i) => `k${i % 100}`),
      v: new Float64Array(n).fill(1),
    });
    const bytes = () => process.memoryUsage().arrayBuffers;
    let before = bytes();
    const mark = radar(sparse, { category: "k", value: "v", series: "s" });
    // A few bytes per row, not a value for every series and spoke.
    expect(bytes() - before).toBeLessThan(200_000);
    const { model, scene } = build({ legend: false, marks: [mark] });
    expect(marks<PointGeometry>(scene, "point").reduce((sum, m) => sum + m.count, 0)).toBe(n);
    // Hidden series are not placed.
    for (let i = 1; i < n; i++) model.hidden.add(JSON.stringify([0, `s${i}`]));
    before = bytes();
    expect(marks<PointGeometry>(model.scene(estimateText), "point")).toHaveLength(1);
    expect(bytes() - before).toBeLessThan(200_000);
    // A table that streams past 100 spokes draws nothing, and says why.
    const growing = table({ k: ["a", "b", "c"], v: [1, 2, 3] });
    const streamed = build({ marks: [radar(growing, { category: "k", value: "v" })] }).model;
    growing.append({
      k: Array.from({ length: 98 }, (_, i) => `x${i}`),
      v: new Float64Array(98),
    });
    expect(streamed.scene(estimateText).panels[0]!.marks).toEqual([]);
    expect(streamed.layoutSummary()).toBe(
      "Radar of v by k, with 101 spokes: too many to draw (a radar draws at most 100).",
    );
  });

  it("places values at the extremes of a double without overflowing", () => {
    for (const [values, domain] of [
      [[-1e308, 0, 1e308], undefined],
      [
        [-1e308, 0, 1e308],
        [-1e308, 1e308],
      ],
      [[1e308, 1.6e308, 1.79e308], undefined],
      [[1e-323, 2e-323, 3e-323], undefined],
    ] as [number[], [number, number] | undefined][]) {
      const data = table({ k: ["a", "b", "c"], v: values });
      const mark = radar(data, { category: "k", value: "v", ...(domain && { domain }) });
      const { scene, model } = build({ marks: [mark] });
      const coords = marks<PointGeometry>(scene, "point").flatMap((m) => Array.from(m.coords));
      expect(coords).toHaveLength(6);
      expect(coords.every(Number.isFinite)).toBe(true);
      expect(model.layoutSummary()).not.toMatch(/NaN|Infinity/);
      expect(renderToSVG({ marks: [mark], width: 400, height: 300 })).not.toMatch(/NaN|Infinity/);
    }
  });

  it("lists every series for the legend, which hides it for one unless asked", () => {
    const data = table({ s: ["A", "B"], a: [1, 4], b: [2, 5], c: [3, 6] });
    const { model, scene } = build({
      legend: true,
      marks: [radar(data, { fields: ["a", "b", "c"], series: "s" })],
    });
    model.hidden.add(scene.legend[0]!.key);
    data.reset({ s: ["A"], a: [1], b: [2], c: [3] });
    // A, hidden, can still be shown again.
    expect(model.scene(estimateText).legend.map(({ label, hidden }) => [label, hidden])).toEqual([
      ["A", true],
    ]);
  });

  it("labels rings only where the labels fit, clear of each other and the spoke names", () => {
    const data = table({ a: [1], b: [2], c: [3] });
    for (const [width, height, fontSize, domain] of [
      [400, 300, 32, [0, 10]],
      [100, 100, 12, [0, 999999.9]],
      [120, 120, 12, [0, 99.123456789]],
    ] as [number, number, number, [number, number]][]) {
      const model = new ChartModel({
        locale: "en-US",
        theme: { fontSize },
        marks: [radar(data, { fields: ["a", "b", "c"], domain })],
      });
      model.setSize(width, height, 1);
      const scene = model.scene(estimateText);
      const font = `${fontSize}px ${scene.theme.font}`;
      const lineHeight = Math.round(fontSize * 1.25);
      const text = marks<TextGeometry>(scene, "text");
      const boxes = text.flatMap((m) =>
        m.labels.map((label, i) => {
          const w = estimateText(label, font);
          const x = m.coords[i * 2]!;
          const left = m.anchor === "start" ? x : m.anchor === "end" ? x - w : x - w / 2;
          const y = m.coords[i * 2 + 1]!;
          return [left, y - lineHeight / 2, left + w, y + lineHeight / 2] as const;
        }),
      );
      for (const [i, [left, top, right, bottom]] of boxes.entries()) {
        expect(left).toBeGreaterThanOrEqual(0);
        expect(right).toBeLessThanOrEqual(width);
        expect(top).toBeGreaterThanOrEqual(0);
        expect(bottom).toBeLessThanOrEqual(height);
        for (const [l, t, r, b] of boxes.slice(i + 1))
          expect(left < r && l < right && top < b && t < bottom).toBe(false);
      }
    }
  });

  it("refuses other marks, facets, and axis interaction", () => {
    const mark = radar(scores, { category: "skill", value: "score" });
    const series = table({ t: [1, 2], v: [1, 2] });
    expect(() => build({ marks: [mark, line(series, { x: "t", y: "v" })] })).toThrow(
      "has its chart to itself",
    );
    expect(() => build({ marks: [mark], interaction: { brush: "x" } })).toThrow(
      "radar brush: no axes to brush",
    );
  });

  it("summarizes one polygon by its spokes", () => {
    const { model } = build({ marks: [radar(scores, { category: "skill", value: "score" })] });
    // Without a series, every row is one polygon: the last per skill counts.
    expect(model.layoutSummary()).toBe(
      "Radar of score by skill: 3 spokes, from 0 at the center to 10 at the rim. Highest: power 9. Lowest: speed 5.",
    );
  });

  it("loads from specs, checks them, and renders to SVG and PDF", () => {
    const spec = {
      version: 1 as const,
      width: 400,
      height: 300,
      data: {
        t: {
          columns: {
            name: { type: "category" as const, codes: [0, 1], dictionary: ["a", "b"] },
            x: [1, 2],
            y: [3, 4],
            z: [5, 6],
          },
        },
      },
      marks: [
        { type: "radar" as const, fields: ["x", "y", "z"], series: "name", fillOpacity: 0.3 },
      ],
    };
    const { config } = loadSpec(spec, []);
    const svg = renderToSVG({ ...config, width: 400, height: 300 });
    expect(svg).toMatch(/fill-opacity="0.3"/);
    expect(svg).toContain(">x</text>");
    const bad = (mark: Record<string, unknown>) => () =>
      loadSpec({ ...spec, marks: [{ type: "radar", ...mark }] } as never, []);
    expect(bad({ fields: "x" })).toThrow("marks[0].fields: expected a list of field names");
    expect(bad({ fields: ["x", "y", "z"], domain: [1, 0] })).toThrow(
      "marks[0].domain: expected two finite numbers, ascending",
    );
    expect(bad({ fields: ["x", "y", "z"], points: "yes" })).toThrow("marks[0].points");
    expect(bad({ category: "name" })).toThrow("marks[0]: radar: needs category and value");
    expect(bad({ category: "name", value: "x", fields: ["x", "y", "z"] })).toThrow("not both");
  });
});

/** The radar's radius: its rim ring's distance from the top spoke's start. */
function radiusOf(scene: Scene): number {
  const grid = marks<LineGeometry>(scene, "line").find((m) => m.key === "radar-grid")!;
  const { path } = grid;
  // The last runs are the spokes, center to rim.
  const last = path.starts[path.starts.length - 1]!;
  const c = path.coords;
  return Math.hypot(c[last * 2 + 2]! - c[last * 2]!, c[last * 2 + 3]! - c[last * 2 + 1]!);
}
