// Outlines and constant colors that similar marks share: point and area
// strokes, and one fill for every box plot or violin.
import { describe, expect, it } from "vitest";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { area } from "../../src/marks/area.ts";
import { boxplot } from "../../src/marks/boxplot.ts";
import { type PointMark, point } from "../../src/marks/point.ts";
import { violin } from "../../src/marks/violin.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { renderSvg } from "../../src/render/svg.ts";
import type {
  AreaGeometry,
  Geometry,
  PointGeometry,
  RectGeometry,
  Scene,
} from "../../src/scene/scene.ts";
import { loadSpec } from "../../src/spec/load.ts";
import { surface } from "../../src/theme.ts";
import { legendOf } from "../helpers/guides.ts";

function build(config: ChartConfig) {
  const model = new ChartModel({ locale: "en-US", timeZone: "UTC", ...config });
  model.setSize(600, 300, 1);
  return model.scene(estimateText);
}

const geometry = <T extends Geometry>(scene: Scene, kind: T["kind"]) =>
  scene.panels[0]!.marks.filter((m): m is T => m.kind === kind);

const values = table({
  x: [1, 2, 3, 4],
  a: [3, 5, 4, 6],
  b: [1, 2, 2, 3],
  group: ["n", "n", "s", "s"],
});

describe("point outlines", () => {
  it("rings points in the background color with only a width", () => {
    const scene = build({ marks: [point(values, { x: "x", y: "a", strokeWidth: 2 })] });
    const [g] = geometry<PointGeometry>(scene, "point");
    expect(g!.ring).toEqual({ color: surface(scene.theme), width: 2 });
    expect(renderSvg(scene)).toContain('stroke-width="2"');
  });

  it("rings points one pixel wide with only a color", () => {
    const mark = point(values, { x: "x", y: "a", radius: 4, stroke: "#123456" }) as PointMark;
    const [g] = geometry<PointGeometry>(build({ marks: [mark] }), "point");
    expect(g!.ring).toEqual({ color: "#123456", width: 1 });
    // The outline reaches half its width past each point.
    expect(mark.inset).toEqual({ x: 4.5, y: 4.5 });
  });

  it("draws no ring by default or at zero width", () => {
    for (const options of [{}, { stroke: "#000", strokeWidth: 0 }]) {
      const [g] = geometry<PointGeometry>(
        build({ marks: [point(values, { x: "x", y: "a", ...options })] }),
        "point",
      );
      expect(g!.ring).toBeUndefined();
    }
  });

  it("draws and picks points whose outline alone reaches into the plot", () => {
    const at = (strokeWidth: number) => {
      const model = new ChartModel({
        locale: "en-US",
        timeZone: "UTC",
        x: { domain: [1.05, 4], nice: false },
        marks: [point(values, { x: "x", y: "a", radius: 3, strokeWidth, symbol: "triangle" })],
      });
      model.setSize(600, 300, 1);
      const scene = model.scene(estimateText);
      const { plot } = scene.panels[0]!;
      const outside = plot.x - model.xScale()!.map(1);
      const py = model.yScale()!.map(3);
      return { scene, outside, hit: model.inspect(plot.x + 1, py, "nearest") };
    };
    const ringed = at(20);
    // The first point's center lies past the triangle's reach but within its outline's.
    expect(ringed.outside).toBeGreaterThan(3 * 1.6);
    expect(ringed.outside).toBeLessThan(10);
    expect(geometry<PointGeometry>(ringed.scene, "point")[0]!.count).toBe(4);
    expect(ringed.hit?.value).toBe(1);
    const plain = at(0);
    expect(geometry<PointGeometry>(plain.scene, "point")[0]!.count).toBe(3);
    expect(plain.hit?.value).not.toBe(1);
  });

  it("joins outline corners round in SVG", () => {
    const scene = build({
      marks: [point(values, { x: "x", y: "a", symbol: "star", stroke: "#000", strokeWidth: 3 })],
    });
    expect(renderSvg(scene)).toContain('stroke-linejoin="round"');
  });

  it("shows outlines of their own color in legends, so hollow points keep a swatch", () => {
    const hollow = point(values, {
      x: "x",
      y: "a",
      series: "group",
      fill: "transparent",
      stroke: "#000000",
    });
    const scene = build({ marks: [hollow] });
    expect(legendOf(scene).map((item) => item.stroke)).toEqual(["#000000", "#000000"]);
    expect(renderSvg(scene)).toMatch(
      /<path transform="[^"]*" d="[^"]*" fill="transparent" stroke="#000000"/,
    );
    // An outline in the background color only keeps points apart.
    const apart = build({
      marks: [point(values, { x: "x", y: "a", series: "group", strokeWidth: 2 })],
    });
    expect(legendOf(apart).map((item) => item.stroke)).toEqual([undefined, undefined]);
  });

  it("refuses negative and non-finite widths", () => {
    for (const strokeWidth of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => point(values, { x: "x", y: "a", strokeWidth })).toThrow(
        /point strokeWidth: expected 0 or more pixels; received/,
      );
    }
  });
});

describe("area outlines", () => {
  const outlines = (marks: ChartConfig["marks"]) =>
    geometry<AreaGeometry>(build({ marks }), "area").map((g) => [g.stroke, g.strokeWidth]);

  it("outlines a single area in its own color at the theme's line width", () => {
    const [[stroke, width]] = outlines([area(values, { x: "x", y: "a" })]) as [[string, number]];
    expect(stroke).toMatch(/^#/);
    expect(width).toBe(build({ marks: [] }).theme.style.line.strokeWidth);
  });

  it("sets the outline's color and width", () => {
    expect(outlines([area(values, { x: "x", y: "a", stroke: "#000", strokeWidth: 3 })])).toEqual([
      ["#000", 3],
    ]);
  });

  it("outlines stacked and band areas only when asked", () => {
    const stacked = { x: "x", y: ["a", "b"], stack: true } as const;
    const band = { x: "x", y1: "b", y2: "a" } as const;
    expect(outlines([area(values, stacked)]).map(([stroke]) => stroke)).toEqual([null, null]);
    expect(outlines([area(values, band)])).toEqual([[null, expect.any(Number)]]);
    expect(outlines([area(values, { ...stacked, stroke: "#000" })])).toEqual([
      ["#000", expect.any(Number)],
      ["#000", expect.any(Number)],
    ]);
    expect(outlines([area(values, { ...band, strokeWidth: 2 })])).toEqual([
      [expect.stringMatching(/^#/), 2],
    ]);
  });

  it("leaves the outline off when line is false or the width is zero", () => {
    expect(outlines([area(values, { x: "x", y: "a", stroke: "#000", line: false })])).toEqual([
      [null, expect.any(Number)],
    ]);
    expect(outlines([area(values, { x: "x", y: "a", strokeWidth: 0 })])).toEqual([[null, 0]]);
  });

  it("refuses negative widths", () => {
    expect(() => area(values, { x: "x", y: "a", strokeWidth: -2 })).toThrow(
      "area strokeWidth: expected 0 or more pixels; received -2",
    );
  });
});

describe("one fill for box plots and violins", () => {
  it("colors every box and violin with fill instead of the palette", () => {
    for (const make of [boxplot, violin]) {
      const scene = build({
        marks: [make(values, { x: "group", y: "a", series: "group", fill: "#2a9d8f" })],
      });
      const fills = scene.panels[0]!.marks.flatMap((m) =>
        m.kind === "rect" || m.kind === "area" ? [(m as RectGeometry | AreaGeometry).fill] : [],
      );
      expect(fills.length).toBeGreaterThan(0);
      expect(new Set(fills)).toEqual(new Set(["#2a9d8f"]));
    }
  });
});

describe("styling in specs", () => {
  it("loads and checks the new properties", () => {
    const columns = { x: [1, 2], y: [3, 4], c: ["a", "b"] };
    const spec = {
      data: { d: { columns } },
      marks: [
        { type: "point", data: "d", x: "x", y: "y", stroke: "#fff", strokeWidth: 1.5 },
        { type: "area", data: "d", x: "x", y: "y", stroke: "#000", strokeWidth: 2 },
        { type: "boxplot", data: "d", x: "c", y: "y", fill: "#2a9d8f" },
        { type: "violin", data: "d", x: "c", y: "y", fill: "#2a9d8f" },
      ],
    };
    const loaded = loadSpec(spec as never);
    expect(loaded.config.marks.map((mark) => mark.spec)).toEqual(
      spec.marks.map(({ data: _, ...mark }) => expect.objectContaining(mark)),
    );
    const bad = { ...spec, marks: [{ ...spec.marks[0], strokeWidth: -1 }] };
    expect(() => loadSpec(bad as never)).toThrow(/strokeWidth/);
    const wrong = { ...spec, marks: [{ ...spec.marks[2], fill: 3 }] };
    expect(() => loadSpec(wrong as never)).toThrow(/fill/);
  });
});
