// Point size, opacity, color, and shape by field; color schemes and
// diverging ramps for points and heatmaps; their legends.
import { describe, expect, it } from "vitest";
import { table } from "../../src/data/table.ts";
import { SYMBOLS, type SymbolName, symbolPath, symbolReach } from "../../src/draw/symbols.ts";
import { estimateText } from "../../src/layout/text.ts";
import { heatmap } from "../../src/marks/heatmap.ts";
import { PointMark, point } from "../../src/marks/point.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { renderSvg } from "../../src/render/svg.ts";
import { SequentialScale } from "../../src/scale/color.ts";
import { rdbu, scheme, viridis } from "../../src/scale/schemes.ts";
import type { PointGeometry, RasterGeometry } from "../../src/scene/scene.ts";
import { loadSpec } from "../../src/spec/load.ts";
import type { ChartSpec } from "../../src/spec/spec.ts";
import { LIGHT } from "../../src/theme.ts";

/** A shape as legends draw it: at most 4.5 pixels in radius, reaching at most 6. */
const legendShape = (symbol: SymbolName) =>
  symbolPath(symbol, 0, 0, Math.min(4.5, 6 / symbolReach(symbol)));

function build(config: ChartConfig, width = 600, height = 300) {
  const model = new ChartModel({ locale: "en-US", timeZone: "UTC", ...config });
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

describe("point size by field", () => {
  it("sizes points by area within rRange, from zero", () => {
    const [g] = points({
      marks: [point(cities, { x: "x", y: "y", r: "pop", rRange: [2, 20] })],
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
    const mark = point(cities, { x: "x", y: "y", r: "pop", rRange: [1, 30] });
    expect(mark.inset).toEqual({ x: 30, y: 30 });
  });

  it("does not pick or report points it does not draw", () => {
    const { model } = build({ marks: [point(cities, { x: "x", y: "y", r: "pop" })] });
    // Row 3 (x 4) has no size; the nearest drawn point is x 3 or x 5.
    const inspection = model.inspect(model.xScale()!.map(4), model.yScale()!.map(2))!;
    expect(inspection.value).not.toBe(4);
  });

  it("shows a size key with round values", () => {
    const { scene } = build({ marks: [point(cities, { x: "x", y: "y", r: "pop" })] });
    expect(scene.glyphLegends).toHaveLength(1);
    const [key] = scene.glyphLegends;
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
      return build({
        marks: [point(t, { x: "x", y: "y", r: "s" })],
      }).scene.glyphLegends[0]!.entries.map((e) => e.label.text);
    };
    expect(keyOf([-10, -5, -1])).toEqual(["-8", "-6", "-2"]);
    expect(keyOf([-5, 0, 10])).toHaveLength(3);
    expect(keyOf([7, 7])).toEqual(["7"]);
  });

  it("validates sizes, opacities, and color options", () => {
    const make = (options: object) => () =>
      point(cities, { x: "x", y: "y", ...(options as { r?: number }) });
    expect(make({ r: "pop", rRange: [0, Number.POSITIVE_INFINITY] })).toThrow(/rRange/);
    expect(make({ r: "pop", rRange: [-1, 4] })).toThrow(/rRange/);
    expect(make({ r: 0 })).toThrow(/positive radius/);
    expect(make({ fillOpacity: 2 })).toThrow(/from 0 to 1/);
    expect(make({ color: "growth", colorMidpoint: Number.NaN })).toThrow(/finite/);
    expect(make({ color: "growth", colorDomain: [3, 1] })).toThrow(/ascending/);
    expect(make({ color: "growth", colorDomain: [0, 1], colorMidpoint: 5 })).toThrow(
      /outside its colorDomain/,
    );
    expect(() => heatmap(cities, { x: "x", y: "y", value: "pop", colorDomain: [1, 1] })).toThrow(
      /ascending/,
    );
  });

  it("draws bubbles whose centers are outside the x range but whose edges show", () => {
    // Points 0.05 apart with radii of 80 px: several left of the view reach into it.
    const xs = Float64Array.from({ length: 61 }, (_, i) => i * 0.05);
    const sorted = table({ x: xs, y: xs.map(() => 1), s: xs.map(() => 9) });
    const { model } = build({
      marks: [point(sorted, { x: "x", y: "y", r: "s", rRange: [2, 80] })],
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
      marks: [point(t, { x: "x", y: "y", r: "s", rRange: [0, 30] })],
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
    const legends = (marks: ChartConfig["marks"]) => build({ marks }).scene.colorLegends;
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
    for (const options of [{ r: "v" }, { fillOpacity: "v" }, { color: "v" }] as const) {
      const [g] = points({ marks: [point(t, { x: "x", y: "y", ...options })] });
      expect(g!.count, Object.keys(options)[0]).toBe(3);
    }
    const [g] = points({ marks: [point(t, { x: "x", y: "y", r: "v", rRange: [2, 12] })] });
    expect(Array.from(g!.radii!.subarray(0, 3))).toEqual([2, expect.closeTo(Math.sqrt(74), 3), 12]);
    const tiny = new SequentialScale([0, 1e-320], ["#000000", "#ffffff"]);
    expect([tiny.index(0), tiny.index(1e-320)]).toEqual([0, 254]);
    const wide = new SequentialScale([-1e308, 1e308], ["#000000", "#ffffff"], 0);
    expect([wide.index(-1e308), wide.index(0), wide.index(1e308)]).toEqual([0, 127, 254]);
    // The legend places the midpoint in the middle too.
    const legend = build({
      marks: [point(t, { x: "x", y: "y", color: "v", colorMidpoint: 0 })],
    }).scene.colorLegends[0]!;
    expect(legend.middle).toBeCloseTo(0.5);
    // Subnormal spans keep their resolution.
    const small = table({ x: [0, 1], y: [0, 1], v: [0, Number.MIN_VALUE] });
    for (const options of [{ r: "v" }, { fillOpacity: "v" }, { color: "v" }] as const) {
      const [g] = points({ marks: [point(small, { x: "x", y: "y", ...options })] });
      expect(g!.count, Object.keys(options)[0]).toBe(2);
    }
    const [sized] = points({ marks: [point(small, { x: "x", y: "y", r: "v", rRange: [2, 12] })] });
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
    const [sized] = points({ marks: [point(odd, { x: "x", y: "y", r: "" as never })] });
    expect(sized!.radii).toBeDefined();
    const [faded] = points({ marks: [point(odd, { x: "x", y: "y", fillOpacity: "" as never })] });
    expect(faded!.opacities).toBeDefined();
    const shaped = table({ x: [0, 1], y: [0, 1], "": ["a", "b"] });
    const [g] = points({ marks: [point(shaped, { x: "x", y: "y", symbol: "" as never })] });
    expect(Array.from(g!.symbols!.subarray(0, 2))).toEqual([0, 1]);
  });

  it("names encoded values in tooltips", () => {
    const { model } = build({
      marks: [point(cities, { x: "x", y: "y", r: "pop", color: "growth" })],
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
    expect(scene.colorLegends[0]).toMatchObject({
      stops: viridis,
      title: { text: "growth" },
      low: { text: "-2" },
      high: { text: "4" },
    });
    expect(scene.colorLegends[0]!.middle).toBeUndefined();
  });

  it("centers diverging colors on the midpoint, and places it in the legend", () => {
    const { scene } = build({
      marks: [point(cities, { x: "x", y: "y", color: "growth", colorMidpoint: 0 })],
    });
    const g = scene.panels[0]!.marks[0] as PointGeometry;
    // The theme's diverging ramp by default; 0 takes its neutral middle color.
    expect(scene.colorLegends[0]!.stops).toBe(LIGHT.diverging);
    expect(g.colors!.palette[g.colors!.index[2]!]).toBe("#f7f7f7");
    expect(scene.colorLegends[0]!.middle).toBeCloseTo(2 / 6);
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
    expect(scene.colorLegends).toEqual([]);
  });

  it("keeps series in the legend, in a neutral color", () => {
    const { scene } = build({
      marks: [point(cities, { x: "x", y: "y", series: "region", color: "growth" })],
    });
    const circle = symbolPath("circle", 0, 0, 4.5);
    expect(scene.legend.map((item) => [item.label, item.color, item.glyph])).toEqual([
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
    ).toThrow(/hex colors/);
    // Specs name schemes; marks built from specs outside loadSpec get no scheme table.
    const named = new PointMark(
      { type: "point", x: "x", y: "y", color: "growth", colors: "viridis" },
      cities as never,
    );
    expect(() => build({ marks: [named] })).toThrow(/must be resolved first/);
  });
});

describe("point symbols", () => {
  it("draws one shape, given by name", () => {
    const [g] = points({ marks: [point(cities, { x: "x", y: "y", symbol: "diamond" })] });
    expect(g!.symbol).toBe("diamond");
    expect(g!.symbols).toBeUndefined();
    expect(() => point(cities, { x: "x", y: "y", symbol: "hexagon" as never })).toThrow(
      /Unknown symbol "hexagon"/,
    );
  });

  it("gives each value of a category field a shape, with a shape key", () => {
    const { scene } = build({ marks: [point(cities, { x: "x", y: "y", symbol: "region" })] });
    const g = scene.panels[0]!.marks[0] as PointGeometry;
    expect(Array.from(g.symbols!.subarray(0, 5))).toEqual([0, 1, 0, 1, 2]);
    expect(scene.glyphLegends).toHaveLength(1);
    expect(scene.glyphLegends[0]!.entries.map((e) => [e.label.text, e.glyph])).toEqual(
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
    expect(scene.glyphLegends).toEqual([]);
    expect(scene.legend.map((item) => item.glyph)).toEqual(
      (["circle", "square", "triangle"] as const).map(legendShape),
    );
    const svg = renderSvg(scene);
    // Legend swatches are the series' shapes, not squares.
    expect(svg).not.toMatch(/<rect[^>]*width="10" height="10"/);
  });

  it("leaves room for how far pointed shapes reach", () => {
    const star = point(cities, { x: "x", y: "y", r: 10, symbol: "star" });
    expect(star.inset.y).toBeCloseTo(10 * symbolReach("star"));
    expect(symbolReach("star")).toBeGreaterThan(1.5);
    const shapes = point(cities, { x: "x", y: "y", r: 10, symbol: "region" });
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
      const entries = model.scene(estimateText).glyphLegends[0]!.entries;
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
    const g = raster({ marks: [heatmap(grid, { x: "x", y: "y", value: "v", colors: viridis })] });
    expect(rgb(g, 0)).toBe(viridis[0]);
    expect(rgb(g, 2)).toBe(viridis.at(-1));
  });

  it("maps the midpoint to the diverging ramp's middle", () => {
    const g = raster({
      marks: [heatmap(grid, { x: "x", y: "y", value: "v", colorMidpoint: 0 })],
    });
    expect(rgb(g, 0)).toBe(LIGHT.diverging[0]);
    expect(rgb(g, 1)).toBe("#f7f7f7");
    expect(rgb(g, 2)).toBe(LIGHT.diverging.at(-1));
  });

  it("clamps values outside a fixed color domain", () => {
    const g = raster({
      marks: [heatmap(grid, { x: "x", y: "y", value: "v", colors: rdbu, colorDomain: [0, 1] })],
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
      marks: [heatmap(positive, { x: "x", y: "y", value: "v", colorMidpoint: 0 })],
    });
    expect(scene.colorLegends[0]).toMatchObject({
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
    expect(scene.colorLegends[0]!.stops).toEqual(scheme("magma"));
  });

  it("names the schemes when one is unknown", () => {
    expect(() => loadSpec(spec("nope"))).toThrow(/Unknown color scheme "nope"; use one of viridis/);
  });

  it("validates ranges and encodings", () => {
    const bad = spec(["#000000", "#ffffff"]);
    (bad.marks[0] as { colorDomain?: unknown }).colorDomain = [3, 1];
    expect(() => loadSpec(bad)).toThrow(/colorDomain/);
    const sized = spec(undefined);
    (sized.marks[0] as { r?: unknown; rRange?: unknown }).r = "y";
    (sized.marks[0] as { rRange?: unknown }).rRange = [1, 8];
    expect(build(loadSpec(sized).config).scene.glyphLegends).toHaveLength(1);
  });
});
