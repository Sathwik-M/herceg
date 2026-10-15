// Point size, opacity, color, and shape by field; color schemes and
// diverging ramps for points and heatmaps; their legends.
import { describe, expect, it } from "vitest";
import { encodedCategory } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { SYMBOLS, type SymbolName, symbolPath, symbolReach } from "../../src/draw/symbols.ts";
import { estimateText } from "../../src/layout/text.ts";
import { heatmap } from "../../src/marks/heatmap.ts";
import { line } from "../../src/marks/line.ts";
import { PointMark, point } from "../../src/marks/point.ts";
import { describeChart } from "../../src/model/describe.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { staticCompilers } from "../../src/render/compilers.ts";
import { renderSvg } from "../../src/render/svg.ts";
import { SequentialScale } from "../../src/scale/color.ts";
import { rdbu, scheme, viridis } from "../../src/scale/schemes.ts";
import type { LineGeometry, PointGeometry, RasterGeometry } from "../../src/scene/scene.ts";
import { loadSpec } from "../../src/spec/load.ts";
import type { ChartSpec } from "../../src/spec/spec.ts";
import { LIGHT } from "../../src/theme.ts";
import { keysOf, legendOf, rampsOf } from "../helpers/guides.ts";

/** A shape as legends draw it: at most 4.5 pixels in radius, reaching at most 6. */
const legendShape = (symbol: SymbolName) =>
  symbolPath(symbol, 0, 0, Math.min(4.5, 6 / symbolReach(symbol)));

function build(config: ChartConfig, width = 600, height = 300) {
  const model = new ChartModel(
    { locale: "en-US", timeZone: "UTC", ...config },
    undefined,
    ...staticCompilers(),
  );
  model.setSize(width, height, 1);
  return { model, scene: model.scene(estimateText) };
}

const points = (config: ChartConfig) =>
  build(config).scene.panels[0]!.marks.filter((m): m is PointGeometry => m.kind === "point");

const cities = table({
  x: [1, 2, 3, 4, 5],
  y: [5, 4, 3, 2, 1],
  pop: [0, 100, 400, Number.NaN, 25],
  growth: [-2, -1, 0, 1, 4],
  region: ["n", "s", "n", "s", "e"],
});

describe("legends of encodings", () => {
  it("show one legend for marks that encode the same way", () => {
    const sized = () => point(cities, { x: "x", y: "y", size: "pop" });
    const colored = () => point(cities, { x: "x", y: "y", color: "growth" });
    const { scene } = build({ marks: [sized(), sized(), colored(), colored()] });
    expect(keysOf(scene)).toHaveLength(1);
    expect(rampsOf(scene)).toHaveLength(1);
  });

  it("describe color scales before keys, as the legend shows them", () => {
    const { model } = build({
      marks: [
        point(cities, { x: "x", y: "y", size: "pop" }),
        point(cities, { x: "x", y: "y", color: "growth" }),
      ],
    });
    const [first, second] = model.legendSummaries();
    expect(first).toMatch(/^Color shows growth/);
    expect(second).toMatch(/^Size shows pop/);
  });

  it("build no keys when legends are off", () => {
    const { scene, model } = build({
      legend: false,
      marks: [point(cities, { x: "x", y: "y", size: "pop", color: "growth" })],
    });
    expect([keysOf(scene), rampsOf(scene), model.legendSummaries()]).toEqual([[], [], []]);
  });
});

describe("point size by field", () => {
  it("sizes points by area within radiusRange, from zero", () => {
    const [g] = points({
      marks: [point(cities, { x: "x", y: "y", size: "pop", radiusRange: [2, 20] })],
    });
    // The missing size is not drawn.
    expect(g!.count).toBe(4);
    const radii = Array.from(g!.radii!.subarray(0, 4));
    expect(radii[0]).toBeCloseTo(2);
    expect(radii[2]).toBeCloseTo(20);
    // Area grows linearly: 100 of 400 is a quarter of the way from 2² to 20².
    expect(radii[1]! ** 2).toBeCloseTo(4 + (400 - 4) / 4);
    expect(g!.radius).toBe(20);
  });

  it("leaves room for the largest radius at the plot edges", () => {
    const mark = point(cities, { x: "x", y: "y", size: "pop", radiusRange: [1, 30] }) as PointMark;
    expect(mark.inset).toEqual({ x: 30, y: 30 });
  });

  it("does not pick or report points it does not draw", () => {
    const { model } = build({ marks: [point(cities, { x: "x", y: "y", size: "pop" })] });
    // Row 3 (x 4) has no size; the nearest drawn point is x 3 or x 5.
    const inspection = model.inspect(model.xScale()!.map(4), model.yScale()!.map(2))!;
    expect(inspection.value).not.toBe(4);
    expect(describeChart(model)).toContain("y: 4 points, from 1 to 5, last 1.");
  });

  it("shows a size key with round values", () => {
    const { scene } = build({ marks: [point(cities, { x: "x", y: "y", size: "pop" })] });
    expect(keysOf(scene)).toHaveLength(1);
    const [key] = keysOf(scene);
    expect(key!.title.text).toBe("pop");
    expect(key!.entries.map((e) => e.label.text)).toEqual(["100", "200", "400"]);
    // Circles of growing radius, the largest 12 pixels.
    expect(key!.entries.map((e) => e.glyph)).toEqual(
      [100, 200, 400].map((v) => symbolPath("circle", 0, 0, Math.sqrt(4 + (140 * v) / 400))),
    );
    // The plot starts below the key's tallest row.
    const plot = scene.panels[0]!.plot;
    expect(plot.y).toBeGreaterThan(key!.entries[2]!.y + 12);
  });

  it("keys sizes across negative and mixed-sign values", () => {
    const keyOf = (values: number[]) => {
      const t = table({ x: values.map((_, i) => i), y: values, s: values });
      return keysOf(
        build({
          marks: [point(t, { x: "x", y: "y", size: "s" })],
        }).scene,
      )[0]!.entries.map((e) => e.label.text);
    };
    expect(keyOf([-10, -5, -1])).toEqual(["-8", "-6", "-2"]);
    expect(keyOf([-5, 0, 10])).toHaveLength(3);
    expect(keyOf([7, 7])).toEqual(["7"]);
  });

  it("validates sizes, opacities, and color options", () => {
    const make = (options: object) => () =>
      point(cities, { x: "x", y: "y", ...(options as { radius?: number }) });
    expect(make({ size: "pop", radiusRange: [0, Number.POSITIVE_INFINITY] })).toThrow(
      /radiusRange/,
    );
    expect(make({ size: "pop", radiusRange: [-1, 4] })).toThrow(/radiusRange/);
    expect(make({ radius: 0 })).toThrow(/point radius: expected a positive number.*; received 0/);
    expect(make({ radius: 3, size: "pop" })).toThrow(/a constant radius or a size field, not both/);
    expect(make({ fillOpacity: 2 })).toThrow(/from 0 to 1/);
    expect(make({ color: "growth", colorMidpoint: Number.NaN })).toThrow(/finite/);
    expect(make({ color: "growth", colorDomain: [3, 1] })).toThrow(/ascending/);
    expect(make({ color: "growth", colorDomain: [0, 1], colorMidpoint: 5 })).toThrow(
      /point colorMidpoint: 5 is outside colorDomain \[0,1\]/,
    );
    expect(() => heatmap(cities, { x: "x", y: "y", color: "pop", colorDomain: [1, 1] })).toThrow(
      /ascending/,
    );
  });

  it("draws bubbles whose centers are outside the x range but whose edges show", () => {
    // Points 0.05 apart with radii of 80 px: several left of the view reach into it.
    const xs = Float64Array.from({ length: 61 }, (_, i) => i * 0.05);
    const sorted = table({ x: xs, y: xs.map(() => 1), s: xs.map(() => 9) });
    const { model } = build({
      marks: [point(sorted, { x: "x", y: "y", size: "s", radiusRange: [2, 80] })],
    });
    model.setViewport([1, 2]);
    const scene = model.scene(estimateText);
    const { plot } = scene.panels[0]!;
    const g = scene.panels[0]!.marks[0] as PointGeometry;
    const left = Array.from({ length: g.count }, (_, i) => g.coords[i * 2]!).filter(
      (px) => px < plot.x,
    );
    const step = model.xScale()!.map(0.05) - model.xScale()!.map(0);
    expect(left.length).toBe(Math.floor(80 / step));
    expect(left.length).toBeGreaterThan(1);
  });

  it("does not pick bubbles that do not show", () => {
    // A small bubble at x 0, one sized to nothing at x 2, and a large one at x 10.
    const t = table({ x: [0, 2, 10], y: [5, 5, 5], s: [1, 0, 100] });
    const { model, scene } = build({
      y: { domain: [0, 10] },
      marks: [point(t, { x: "x", y: "y", size: "s", radiusRange: [0, 30] })],
    });
    const y = model.yScale()!.map(5);
    // Sized to nothing: neither drawn nor picked.
    const g = scene.panels[0]!.marks[0] as PointGeometry;
    expect(g.count).toBe(2);
    expect(model.inspect(model.xScale()!.map(2), y)?.value).not.toBe(2);
    // Zoomed so the small bubble's center is 10 px left of the plot: its
    // radius (3 px) cannot reach in, though the largest (30 px) could.
    const width = scene.panels[0]!.plot.width;
    model.setViewport([100 / (width + 10), 10]);
    const plot = model.scene(estimateText).panels[0]!.plot;
    expect(model.xScale()!.map(0)).toBeCloseTo(plot.x - 10, 0);
    expect(model.inspect(plot.x + 1, y)?.value).not.toBe(0);
  });

  it("keeps a legend for each color scale, and one for scales marks share", () => {
    const a = table({ x: [0, 1], y: [0, 1], c: [0, 1] });
    const b = table({ x: [0, 1], y: [1, 0], c: [100, 200] });
    const legends = (marks: ChartConfig["marks"]) => rampsOf(build({ marks }).scene);
    const two = legends([
      point(a, { x: "x", y: "y", color: "c" }),
      point(b, { x: "x", y: "y", color: "c" }),
    ]);
    expect(two.map((l) => [l.low.text, l.high.text])).toEqual([
      ["0", "1"],
      ["100", "200"],
    ]);
    // Different gradients in SVG.
    const svg = renderSvg(
      build({
        marks: [point(a, { x: "x", y: "y", color: "c" }), point(b, { x: "x", y: "y", color: "c" })],
      }).scene,
    );
    expect(svg).toContain('id="herceg-ramp-0"');
    expect(svg).toContain('id="herceg-ramp-1"');
    expect(
      legends([point(a, { x: "x", y: "y", color: "c" }), point(a, { x: "y", y: "x", color: "c" })]),
    ).toHaveLength(1);
  });

  it("encodes the most extreme finite values", () => {
    const huge = [-1e308, 0, 1e308];
    const t = table({ x: [0, 1, 2], y: [0, 1, 2], v: huge });
    for (const options of [{ size: "v" }, { fillOpacity: "v" }, { color: "v" }] as const) {
      const [g] = points({ marks: [point(t, { x: "x", y: "y", ...options })] });
      expect(g!.count, Object.keys(options)[0]).toBe(3);
    }
    const [g] = points({ marks: [point(t, { x: "x", y: "y", size: "v", radiusRange: [2, 12] })] });
    expect(Array.from(g!.radii!.subarray(0, 3))).toEqual([2, expect.closeTo(Math.sqrt(74), 3), 12]);
    const tiny = new SequentialScale([0, 1e-320], ["#000000", "#ffffff"]);
    expect([tiny.index(0), tiny.index(1e-320)]).toEqual([0, 254]);
    const wide = new SequentialScale([-1e308, 1e308], ["#000000", "#ffffff"], 0);
    expect([wide.index(-1e308), wide.index(0), wide.index(1e308)]).toEqual([0, 127, 254]);
    // The legend places the midpoint in the middle too.
    const legend = rampsOf(
      build({
        marks: [point(t, { x: "x", y: "y", color: "v", colorMidpoint: 0 })],
      }).scene,
    )[0]!;
    expect(legend.middle).toBeCloseTo(0.5);
    // Subnormal spans keep their resolution.
    const small = table({ x: [0, 1], y: [0, 1], v: [0, Number.MIN_VALUE] });
    for (const options of [{ size: "v" }, { fillOpacity: "v" }, { color: "v" }] as const) {
      const [g] = points({ marks: [point(small, { x: "x", y: "y", ...options })] });
      expect(g!.count, Object.keys(options)[0]).toBe(2);
    }
    const [sized] = points({
      marks: [point(small, { x: "x", y: "y", size: "v", radiusRange: [2, 12] })],
    });
    expect(Array.from(sized!.radii!.subarray(0, 2))).toEqual([2, 12]);
    const sub = new SequentialScale([0, Number.MIN_VALUE], ["#000000", "#ffffff"]);
    expect([sub.index(0), sub.index(Number.MIN_VALUE)]).toEqual([0, 254]);
  });

  it("colors tooltip swatches as the point is drawn", () => {
    const { model } = build({
      marks: [point(cities, { x: "x", y: "y", color: "growth", colors: ["#000000", "#ffffff"] })],
    });
    const at = (i: number) =>
      model.inspect(model.xScale()!.map(i + 1), model.yScale()!.map(5 - i))!;
    expect(at(0).points[0]!.color).toBe("#000000");
    expect(at(4).points[0]!.color).toBe("#ffffff");
  });

  it("encodes fields whatever their names, including empty ones", () => {
    const odd = table({ x: [0, 1], y: [0, 1], "": [1, 4] });
    const [sized] = points({ marks: [point(odd, { x: "x", y: "y", size: "" as never })] });
    expect(sized!.radii).toBeDefined();
    const [faded] = points({ marks: [point(odd, { x: "x", y: "y", fillOpacity: "" as never })] });
    expect(faded!.opacities).toBeDefined();
    const shaped = table({ x: [0, 1], y: [0, 1], "": ["a", "b"] });
    const [g] = points({ marks: [point(shaped, { x: "x", y: "y", symbol: "" as never })] });
    expect(Array.from(g!.symbols!.subarray(0, 2))).toEqual([0, 1]);
  });

  it("names encoded values in tooltips", () => {
    const { model } = build({
      marks: [point(cities, { x: "x", y: "y", size: "pop", color: "growth" })],
    });
    const inspection = model.inspect(model.xScale()!.map(2), model.yScale()!.map(4))!;
    expect(inspection.points[0]!.text).toBe("4, pop 100, growth -1");
  });
});

describe("point opacity by field", () => {
  it("maps values from a faint 0.15 to opaque, drawing each point on its own", () => {
    const [g] = points({ marks: [point(cities, { x: "x", y: "y", fillOpacity: "growth" })] });
    expect(g!.opaque).toBe(false);
    const opacities = Array.from(g!.opacities!.subarray(0, g!.count));
    expect(opacities[0]).toBeCloseTo(0.15);
    expect(opacities[4]).toBeCloseTo(1);
    const svg = renderSvg(
      build({ marks: [point(cities, { x: "x", y: "y", fillOpacity: "growth" })] }).scene,
    );
    expect(svg.match(/fill-opacity="/g)).toHaveLength(5);
  });
});

describe("point color by field", () => {
  it("colors points on a continuous scale with a color legend", () => {
    const { scene } = build({
      marks: [point(cities, { x: "x", y: "y", color: "growth", colors: viridis })],
    });
    const g = scene.panels[0]!.marks[0] as PointGeometry;
    const fill = (i: number) => g.colors!.palette[g.colors!.index[i]!];
    expect(fill(0)).toBe(viridis[0]);
    expect(fill(4)).toBe(viridis.at(-1));
    expect(rampsOf(scene)[0]).toMatchObject({
      stops: viridis,
      title: { text: "growth" },
      low: { text: "-2" },
      high: { text: "4" },
    });
    expect(rampsOf(scene)[0]!.middle).toBeUndefined();
  });

  it("centers diverging colors on the midpoint, and places it in the legend", () => {
    const { scene } = build({
      marks: [point(cities, { x: "x", y: "y", color: "growth", colorMidpoint: 0 })],
    });
    const g = scene.panels[0]!.marks[0] as PointGeometry;
    // The theme's diverging ramp by default; 0 takes its neutral middle color.
    expect(rampsOf(scene)[0]!.stops).toEqual(LIGHT.diverging);
    expect(g.colors!.palette[g.colors!.index[2]!]).toBe("#f7f7f7");
    expect(rampsOf(scene)[0]!.middle).toBeCloseTo(2 / 6);
    const svg = renderSvg(scene);
    expect(svg).toContain('offset="33.3%" stop-color="#f7f7f7"');
  });

  it("draws opaque colored points as one path per color, high values on top", () => {
    const { scene } = build({
      marks: [point(cities, { x: "x", y: "y", color: "growth", colors: ["#000000", "#ffffff"] })],
    });
    const svg = renderSvg(scene);
    const fills = [...svg.matchAll(/<path d="M[^"]*" fill="(#[0-9a-f]{6})"/g)].map((m) => m[1]);
    expect(fills[0]).toBe("#000000");
    expect(fills.at(-1)).toBe("#ffffff");
    expect(new Set(fills).size).toBe(fills.length);
  });

  it("draws nothing when no point has a color value", () => {
    const blank = table({ x: [1, 2], y: [3, 4], c: [Number.NaN, Number.NaN] });
    const { scene } = build({ marks: [point(blank, { x: "x", y: "y", color: "c" })] });
    expect(scene.panels[0]!.marks).toEqual([]);
    expect(rampsOf(scene)).toEqual([]);
  });

  it("keeps series in the legend, in a neutral color", () => {
    const { scene } = build({
      marks: [point(cities, { x: "x", y: "y", series: "region", color: "growth" })],
    });
    const circle = symbolPath("circle", 0, 0, 4.5);
    expect(legendOf(scene).map((item) => [item.label, item.color, item.glyph])).toEqual([
      ["n", LIGHT.muted, circle],
      ["s", LIGHT.muted, circle],
      ["e", LIGHT.muted, circle],
    ]);
  });

  it("does not leave encoded points to a GPU painter", () => {
    const n = 120_000;
    const big = table({
      x: Float64Array.from({ length: n }, (_, i) => i % 1000),
      y: Float64Array.from({ length: n }, (_, i) => i % 7),
    });
    const model = new ChartModel({
      locale: "en-US",
      marks: [point(big, { x: "x", y: "y", color: "y" })],
    });
    model.setSize(600, 300, 1);
    const [g] = model.scene(estimateText, true).panels[0]!.marks as PointGeometry[];
    expect(g!.cloud).toBeUndefined();
    expect(g!.count).toBe(n);
  });

  it("rejects colors it cannot interpolate, and names unresolved schemes", () => {
    expect(() =>
      point(cities, { x: "x", y: "y", color: "growth", colors: ["red", "blue"] }),
    ).toThrow(/point colors: expected "#rrggbb" colors; received "red"/);
    // Specs name schemes; marks built from specs outside loadSpec get no scheme table.
    const named = new PointMark(
      { type: "point", x: "x", y: "y", color: "growth", colors: "viridis" },
      cities as never,
    );
    expect(() => build({ marks: [named] })).toThrow(/colors: scheme "viridis" is unresolved/);
  });
});

describe("point color by category", () => {
  const colorOf = (g: PointGeometry, i: number) => g.colors!.palette[g.colors!.index[i]!];

  it("gives each value the color scale's next color, in the field's order, with a color key", () => {
    const { scene, model } = build({
      marks: [point(cities, { x: "x", y: "y", color: "region" })],
    });
    const [g] = scene.panels[0]!.marks as PointGeometry[];
    expect(g!.colors!.categorical).toBe(true);
    // n, s, n, s, e: the theme's first, second, first, second, and third colors.
    expect([0, 1, 2, 3, 4].map((i) => colorOf(g!, i))).toEqual(
      [0, 1, 0, 1, 2].map((i) => LIGHT.palette[i]),
    );
    const key = keysOf(scene)[0]!;
    expect(key.title.text).toBe("region");
    expect(key.entries.map((e) => [e.label.text, e.fill])).toEqual([
      ["n", LIGHT.palette[0]],
      ["s", LIGHT.palette[1]],
      ["e", LIGHT.palette[2]],
    ]);
    expect(rampsOf(scene)).toEqual([]);
    expect(model.legendSummaries()).toEqual(["Color shows region: n, s, e."]);
    const svg = renderSvg(scene);
    // Color keys' glyphs are their colors, opaque.
    expect(svg).toContain(
      `d="M-4.5 0a4.5 4.5 0 1 1 9 0a4.5 4.5 0 1 1 -9 0" fill="${LIGHT.palette[2]}"/>`,
    );
  });

  it("reads the category in tooltips, swatches in its color, and leaves rows without one out", () => {
    const sparse = table({ x: [1, 2, 3], y: [1, 2, 3], kind: ["a", null, "b"] });
    const { model, scene } = build({ marks: [point(sparse, { x: "x", y: "y", color: "kind" })] });
    const [g] = scene.panels[0]!.marks as PointGeometry[];
    expect(g!.count).toBe(2);
    const at = (i: number) => model.inspect(model.xScale()!.map(i), model.yScale()!.map(i));
    expect(at(1)!.points[0]).toMatchObject({ text: "1, kind a", color: LIGHT.palette[0] });
    expect(at(3)!.points[0]).toMatchObject({ text: "3, kind b", color: LIGHT.palette[1] });
    expect(at(2)?.points.some((p) => p.text.startsWith("2,"))).not.toBe(true);
    expect(describeChart(model)).toContain("y: 2 points, from 1 to 3, last 3.");
  });

  it("describes no data when no row has a category", () => {
    const none = table({ x: [1, 2], y: [1, 2], kind: [null, null] as (string | null)[] });
    const { model } = build({ marks: [point(none, { x: "x", y: "y", color: "kind" })] });
    expect(describeChart(model)).toContain("y: no data.");
  });

  it("keeps a series' colors when the series field is the color field", () => {
    const { scene } = build({
      marks: [point(cities, { x: "x", y: "y", series: "region", color: "region" })],
    });
    expect((scene.panels[0]!.marks as PointGeometry[]).every((g) => !g.colors)).toBe(true);
    expect(keysOf(scene)).toEqual([]);
    expect(legendOf(scene).map((item) => item.color)).toEqual(LIGHT.palette.slice(0, 3));
  });

  it("colors by category whatever the series, listing series in a neutral color", () => {
    const tagged = table({
      x: [1, 2, 3],
      y: [1, 2, 3],
      kind: ["p", "q", "p"],
      tag: ["a", "b", "b"],
    });
    const { scene } = build({
      marks: [point(tagged, { x: "x", y: "y", series: "kind", color: "tag" })],
    });
    expect(legendOf(scene).map((item) => [item.label, item.color])).toEqual([
      ["p", LIGHT.muted],
      ["q", LIGHT.muted],
    ]);
    expect(keysOf(scene)[0]!.entries.map((e) => e.label.text)).toEqual(["a", "b"]);
  });

  it("keeps a value's color as the table streams", () => {
    const stream = table({ x: [0], y: [0], kind: ["k0"] }, { maxRows: 2 });
    const { model } = build({ marks: [point(stream, { x: "x", y: "y", color: "kind" })] });
    const colors = new Map<string, string>();
    for (let i = 1; i < 40; i++) {
      stream.append({ x: [i], y: [i], kind: [`k${i}`] });
      for (const { label, fill } of keysOf(model.scene(estimateText))[0]!.entries) {
        if (colors.has(label.text)) expect(fill, label.text).toBe(colors.get(label.text));
        colors.set(label.text, fill!);
      }
    }
  });

  it("follows the field's dictionary (a pandas Categorical's order), not the rows'", () => {
    const flipped = table({
      x: [1, 2],
      y: [1, 2],
      kind: encodedCategory(new Int32Array([1, 0]), ["A", "B"]),
    });
    const { scene } = build({ marks: [point(flipped, { x: "x", y: "y", color: "kind" })] });
    expect(keysOf(scene)[0]!.entries.map((e) => [e.label.text, e.fill])).toEqual([
      ["A", LIGHT.palette[0]],
      ["B", LIGHT.palette[1]],
    ]);
  });

  it("give a value one color across marks and lines, through the chart's color scale", () => {
    const first = table({ x: [1, 2], y: [1, 2], kind: ["a", "b"] });
    const second = table({ x: [1, 2, 3], y: [1, 2, 3], kind: ["c", "a", "b"] });
    const { model, scene } = build({
      scales: { color: { type: "ordinal", map: { b: "#00ab41" } } },
      marks: [
        point(first, { x: "x", y: "y", color: "kind" }),
        point(second, { x: "x", y: "y", color: "kind" }),
        line(second, { x: "x", y: "y", series: "kind", color: "kind" }),
      ],
    });
    const fills = (s: typeof scene) =>
      keysOf(s).map((key) => key.entries.map((e) => [e.label.text, e.fill]));
    const a = LIGHT.palette[0];
    const c = LIGHT.palette[2];
    expect(fills(scene)).toEqual([
      [
        ["a", a],
        ["b", "#00ab41"],
      ],
      [
        ["a", a],
        ["b", "#00ab41"],
        ["c", c],
      ],
    ]);
    const lines = scene.panels[0]!.marks.filter((m): m is LineGeometry => m.kind === "line");
    expect(lines.map((l) => l.stroke)).toEqual([c, a, "#00ab41"]);
    // Without c, the second mark's a and b keep their colors, and the keys, now alike, merge.
    second.dropFirst(1);
    expect(fills(model.scene(estimateText))).toEqual([
      [
        ["a", a],
        ["b", "#00ab41"],
      ],
    ]);
  });

  it("take values outside an explicit domain in the scale's unknown color", () => {
    const { scene } = build({
      scales: { color: { type: "ordinal", domain: ["s", "n"], unknown: "#999999" } },
      marks: [point(cities, { x: "x", y: "y", color: "region" })],
    });
    expect(keysOf(scene)[0]!.entries.map((e) => [e.label.text, e.fill])).toEqual([
      ["s", LIGHT.palette[0]],
      ["n", LIGHT.palette[1]],
      ["e", "#999999"],
    ]);
  });

  it("cycles through at most 254 colors and the muted one, as the points and the key read them", () => {
    const palette = Array.from({ length: 300 }, (_, i) => `#${i.toString(16).padStart(6, "0")}`);
    const many = table({
      x: Array.from({ length: 260 }, (_, i) => i),
      y: Array.from({ length: 260 }, (_, i) => i),
      kind: Array.from({ length: 260 }, (_, i) => `k${i}`),
    });
    const { scene, model } = build({
      theme: { tokens: { palette: palette } },
      marks: [point(many, { x: "x", y: "y", color: "kind" })],
    });
    const [g] = scene.panels[0]!.marks as PointGeometry[];
    expect(g!.colors!.palette).toHaveLength(254);
    const fills = keysOf(scene)[0]!.entries.map((e) => e.fill);
    expect(fills[254]).toBe(palette[0]);
    const at = model.inspect(model.xScale()!.map(254), model.yScale()!.map(254))!;
    expect(at.points[0]!.color).toBe(palette[0]);
  });

  it("refuse a color scale whose unknown output is not a color", () => {
    expect(() =>
      build({
        scales: { color: { type: "ordinal", domain: ["n"], unknown: 3 } },
        marks: [point(cities, { x: "x", y: "y", color: "region" })],
      }),
    ).toThrow("chart scales.color.unknown (read by point (mark 0) color): expected a color");
  });

  it("keep each value's color slot as values come and go", () => {
    const palette = Array.from({ length: 300 }, (_, i) => `#${i.toString(16).padStart(6, "0")}`);
    const map = Object.fromEntries(palette.slice(0, 256).map((c, i) => [`k${i}`, c]));
    const stream = table({
      x: Array.from({ length: 256 }, (_, i) => i),
      y: Array.from({ length: 256 }, (_, i) => i),
      kind: Array.from({ length: 256 }, (_, i) => `k${i}`),
    });
    const { model } = build({
      scales: { color: { type: "ordinal", map } },
      marks: [point(stream, { x: "x", y: "y", color: "kind" })],
    });
    const colorOf = (label: string) =>
      keysOf(model.scene(estimateText))[0]!.entries.find((e) => e.label.text === label)!.fill;
    // Past 254 mapped colors, the rest take the muted color, and keep it.
    expect(colorOf("k255")).toBe(LIGHT.muted);
    stream.dropFirst(10);
    expect(colorOf("k255")).toBe(LIGHT.muted);
    expect(colorOf("k20")).toBe(palette[20]);
  });

  it("refuses ramp options for a category color", () => {
    for (const options of [{ colors: viridis }, { colorDomain: [0, 1] }, { colorMidpoint: 0 }])
      expect(() =>
        point(cities, { x: "x", y: "y", color: "region", ...(options as object) }),
      ).toThrow(/point colors: "region" is a category field/);
  });

  it("loads from specs and draws in static SVG", () => {
    const spec: ChartSpec = {
      data: { t: { columns: { x: [1, 2], y: [3, 4], c: ["p", "q"] } } },
      marks: [{ type: "point", x: "x", y: "y", color: "c" }],
    };
    const { scene } = build(loadSpec(spec).config);
    expect(keysOf(scene)[0]!.entries.map((e) => e.fill)).toEqual(LIGHT.palette.slice(0, 2));
  });
});

describe("point symbols", () => {
  it("draws one shape, given by name", () => {
    const [g] = points({ marks: [point(cities, { x: "x", y: "y", symbol: "diamond" })] });
    expect(g!.symbol).toBe("diamond");
    expect(g!.symbols).toBeUndefined();
    expect(() => point(cities, { x: "x", y: "y", symbol: "hexagon" as never })).toThrow(
      /point symbol: no shape or field "hexagon"/,
    );
  });

  it("refuses a name that is both a shape and a field, whatever the field holds", () => {
    const named = table({ x: [0], y: [0], square: ["a"], circle: [1] });
    expect(() => point(named, { x: "x", y: "y", symbol: "square" })).toThrow(
      /names both a shape and a field/,
    );
    expect(() => point(named, { x: "x", y: "y", symbol: "circle" })).toThrow(
      'point symbol: "circle" names both a shape and a field; give { field: "circle" } to encode the field',
    );
  });

  it("encode a field named like a shape when given as { field }, and write fields so", () => {
    const named = table({ x: [0, 1], y: [0, 1], square: ["a", "b"] });
    const mark = point(named, { x: "x", y: "y", symbol: { field: "square" } });
    expect(mark.spec.symbol).toEqual({ field: "square" });
    const [g] = points({ marks: [mark] });
    expect(Array.from(g!.symbols!.subarray(0, 2))).toEqual([0, 1]);
    expect(point(cities, { x: "x", y: "y", symbol: "region" }).spec.symbol).toEqual({
      field: "region",
    });
    expect(point(cities, { x: "x", y: "y", symbol: "star" }).spec.symbol).toBe("star");
    // Specs from elsewhere may name a field as a string where no shape has its name.
    const loaded = loadSpec({
      data: { t: { columns: { x: [0], y: [0], kind: ["a"] } } },
      marks: [
        { type: "point", x: "x", y: "y", symbol: "kind" },
        { type: "point", x: "x", y: "y", symbol: { field: "kind" } },
      ],
    });
    expect(points(loaded.config).every((p) => p.symbols !== undefined)).toBe(true);
    expect(() =>
      loadSpec({ marks: [{ type: "point", x: "x", y: "y", symbol: { name: "kind" } as never }] }),
    ).toThrow(/marks\[0\]\.symbol\.field: required/);
  });

  it("gives each value of a category field a shape, with a shape key", () => {
    const { scene } = build({ marks: [point(cities, { x: "x", y: "y", symbol: "region" })] });
    const g = scene.panels[0]!.marks[0] as PointGeometry;
    expect(Array.from(g.symbols!.subarray(0, 5))).toEqual([0, 1, 0, 1, 2]);
    expect(keysOf(scene)).toHaveLength(1);
    expect(keysOf(scene)[0]!.entries.map((e) => [e.label.text, e.glyph])).toEqual(
      [
        ["n", "circle"],
        ["s", "square"],
        ["e", "triangle"],
      ].map(([label, symbol]) => [label, legendShape(symbol as SymbolName)]),
    );
  });

  it("shows shapes in the series legend when the same field splits series", () => {
    const { scene } = build({
      marks: [point(cities, { x: "x", y: "y", series: "region", symbol: "region" })],
    });
    expect(keysOf(scene)).toEqual([]);
    expect(legendOf(scene).map((item) => item.glyph)).toEqual(
      (["circle", "square", "triangle"] as const).map(legendShape),
    );
    const svg = renderSvg(scene);
    // Legend swatches are the series' shapes, not squares.
    expect(svg).not.toMatch(/<rect[^>]*width="10" height="10"/);
  });

  it("leaves room for how far pointed shapes reach", () => {
    const star = point(cities, { x: "x", y: "y", radius: 10, symbol: "star" }) as PointMark;
    expect(star.inset.y).toBeCloseTo(10 * symbolReach("star"));
    expect(symbolReach("star")).toBeGreaterThan(1.5);
    const shapes = point(cities, { x: "x", y: "y", radius: 10, symbol: "region" }) as PointMark;
    expect(shapes.inset.y).toBeCloseTo(10 * Math.max(...SYMBOLS.map(symbolReach)));
    // The topmost star's tip stays inside the plot.
    const { scene } = build({ marks: [star] });
    const g = scene.panels[0]!.marks[0] as PointGeometry;
    const top = Math.min(...Array.from({ length: g.count }, (_, i) => g.coords[i * 2 + 1]!));
    expect(top - 10 * symbolReach("star")).toBeGreaterThanOrEqual(scene.panels[0]!.plot.y - 0.01);
  });

  it("winds every shape clockwise, so overlapping shapes in one path do not cancel", () => {
    for (const symbol of SYMBOLS) {
      if (symbol === "circle") {
        // Both arcs sweep clockwise (flag 1), as canvas arcs do.
        expect(symbolPath(symbol, 0, 0, 5)).toMatch(/^M-5 0a5 5 0 1 1 10 0a5 5 0 1 1 -10 0$/);
        continue;
      }
      const v = [...symbolPath(symbol, 0, 0, 10).matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map(
        (m) => [Number(m[1]), Number(m[2])],
      );
      let area = 0;
      for (let i = 0; i < v.length; i++) {
        const [x0, y0] = v[i]!;
        const [x1, y1] = v[(i + 1) % v.length]!;
        area += x0! * y1! - x1! * y0!;
      }
      // With y down, a positive shoelace sum is clockwise on screen.
      expect(area, symbol).toBeGreaterThan(0);
    }
  });

  it("keys only values the table holds, each keeping its shape as the table streams", () => {
    const stream = table({ x: [0], y: [0], kind: ["k0"] }, { maxRows: 2 });
    const model = new ChartModel({
      locale: "en-US",
      marks: [point(stream, { x: "x", y: "y", symbol: "kind" })],
    });
    model.setSize(600, 300, 1);
    const shapes = new Map<string, string>();
    // Enough values for the table to compact its dictionary several times.
    for (let i = 1; i < 200; i++) {
      stream.append({ x: [i], y: [i], kind: [`k${i}`] });
      const entries = keysOf(model.scene(estimateText))[0]!.entries;
      expect(entries.map((e) => e.label.text)).toEqual([`k${i - 1}`, `k${i}`]);
      for (const { label, glyph } of entries) {
        if (shapes.has(label.text)) expect(glyph, label.text).toBe(shapes.get(label.text));
        shapes.set(label.text, glyph);
      }
    }
    // Neighbors differ, as consecutive values take consecutive shapes.
    expect(shapes.get("k100")).not.toBe(shapes.get("k101"));
  });

  it("covers the same area with every shape", () => {
    for (const symbol of SYMBOLS) {
      if (symbol === "circle") continue;
      const d = symbolPath(symbol, 0, 0, 10);
      const v = [...d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => [
        Number(m[1]),
        Number(m[2]),
      ]);
      let area = 0;
      for (let i = 0; i < v.length; i++) {
        const [x0, y0] = v[i]!;
        const [x1, y1] = v[(i + 1) % v.length]!;
        area += x0! * y1! - x1! * y0!;
      }
      expect(Math.abs(area / 2)).toBeCloseTo(Math.PI * 100, -1);
    }
  });
});

describe("heatmap colors", () => {
  const grid = table({
    x: ["a", "b", "c"],
    y: ["r", "r", "r"],
    v: [-1, 0, 3],
  });
  const raster = (config: ChartConfig) => build(config).scene.panels[0]!.marks[0] as RasterGeometry;
  const rgb = (g: RasterGeometry, i: number) =>
    `#${Array.from(g.pixels.subarray(i * 4, i * 4 + 3), (c) => c.toString(16).padStart(2, "0")).join("")}`;

  it("uses a named scheme's colors", () => {
    const g = raster({ marks: [heatmap(grid, { x: "x", y: "y", color: "v", colors: viridis })] });
    expect(rgb(g, 0)).toBe(viridis[0]);
    expect(rgb(g, 2)).toBe(viridis.at(-1));
  });

  it("maps the midpoint to the diverging ramp's middle", () => {
    const g = raster({
      marks: [heatmap(grid, { x: "x", y: "y", color: "v", colorMidpoint: 0 })],
    });
    expect(rgb(g, 0)).toBe(LIGHT.diverging[0]);
    expect(rgb(g, 1)).toBe("#f7f7f7");
    expect(rgb(g, 2)).toBe(LIGHT.diverging.at(-1));
  });

  it("clamps values outside a fixed color domain", () => {
    const g = raster({
      marks: [heatmap(grid, { x: "x", y: "y", color: "v", colors: rdbu, colorDomain: [0, 1] })],
    });
    expect(rgb(g, 0)).toBe(rdbu[0]);
    expect(rgb(g, 2)).toBe(rdbu.at(-1));
  });
});

describe("sequential scale", () => {
  it("widens its domain to a midpoint outside it, for cells and legend alike", () => {
    const scale = new SequentialScale([0, 10], ["#000000", "#808080", "#ffffff"], 20);
    expect(scale.domain).toEqual([0, 20]);
    expect(scale.color(20)).toBe("#808080");
    // Values past the ends take the ends' colors.
    expect(scale.color(25)).toBe(scale.color(20));
    expect(scale.color(-5)).toBe("#000000");
    const positive = table({ x: ["a", "b"], y: ["r", "r"], v: [1, 4] });
    const { scene } = build({
      marks: [heatmap(positive, { x: "x", y: "y", color: "v", colorMidpoint: 0 })],
    });
    expect(rampsOf(scene)[0]).toMatchObject({
      low: { text: "0" },
      high: { text: "4" },
      middle: 0,
    });
  });

  it("adds the middle color to even ramps' legend stops, keeping them evenly spaced", () => {
    expect(new SequentialScale([0, 10], ["#000000", "#ffffff"], 1).legendStops()).toEqual([
      "#000000",
      "#808080",
      "#ffffff",
    ]);
    const four = new SequentialScale([0, 1], ["#000000", "#606060", "#a0a0a0", "#ffffff"], 0.5);
    const stops = four.legendStops();
    expect(stops).toHaveLength(7);
    expect(stops[2]).toBe("#606060");
    // The middle stop is the scale's color at the midpoint.
    expect(stops[3]).toBe(four.color(0.5));
    expect(new SequentialScale([0, 1], ["#000000", "#ffffff"]).legendStops()).toHaveLength(2);
  });

  it("maps each side of a midpoint onto its half of the ramp", () => {
    const scale = new SequentialScale([-1, 9], ["#000000", "#808080", "#ffffff"], 0);
    expect(scale.color(-1)).toBe("#000000");
    expect(scale.color(0)).toBe("#808080");
    expect(scale.color(9)).toBe("#ffffff");
    expect(scale.index(4.5)).toBe(Math.round(127 + 127 / 2));
  });
});

describe("color schemes in specs", () => {
  const spec = (colors: unknown): ChartSpec => ({
    data: { t: { columns: { x: [1, 2], y: [3, 4], c: [0, 1] } } },
    marks: [{ type: "point", data: "t", x: "x", y: "y", color: "c", colors } as never],
  });

  it("resolves scheme names when loading", () => {
    const { config } = loadSpec(spec("magma"));
    const { scene } = build(config);
    expect(rampsOf(scene)[0]!.stops).toEqual(scheme("magma"));
  });

  it("names the schemes when one is unknown", () => {
    expect(() => loadSpec(spec("nope"))).toThrow(/Unknown color scheme "nope"; use one of viridis/);
  });

  it("validates ranges and encodings", () => {
    const bad = spec(["#000000", "#ffffff"]);
    (bad.marks[0] as { colorDomain?: unknown }).colorDomain = [3, 1];
    expect(() => loadSpec(bad)).toThrow(/colorDomain/);
    const sized = spec(undefined);
    (sized.marks[0] as { size?: unknown }).size = "y";
    (sized.marks[0] as { radiusRange?: unknown }).radiusRange = [1, 8];
    expect(keysOf(build(loadSpec(sized).config).scene)).toHaveLength(1);
  });
});
