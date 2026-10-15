// Lines' features: colors by category through scales with fixed maps, looks
// by series, opacity, and markers (the feature compiler, model/features.ts).
import { describe, expect, it } from "vitest";
import { encodedCategory } from "../../src/data/column.ts";
import { col } from "../../src/data/expr.ts";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { line } from "../../src/marks/line.ts";
import { needsFeatures } from "../../src/model/features.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { panels } from "../../src/model/panels.ts";
import { staticCompilers } from "../../src/render/compilers.ts";
import { renderToSVG } from "../../src/render/static.ts";
import type { GuideItem, LineGeometry, PointGeometry, Scene } from "../../src/scene/scene.ts";
import { loadSpec } from "../../src/spec/load.ts";
import type { ChartSpec } from "../../src/spec/spec.ts";
import { LIGHT } from "../../src/theme.ts";
import { legendOf } from "../helpers/guides.ts";

function model(config: ChartConfig) {
  const made = new ChartModel(
    { locale: "en-US", timeZone: "UTC", ...config },
    undefined,
    ...staticCompilers(),
  );
  made.setSize(600, 300, 1);
  return made;
}

const build = (config: ChartConfig) => model(config).scene(estimateText);

const lines = (scene: Scene, panel = 0) =>
  scene.panels[panel]!.marks.filter((m): m is LineGeometry => m.kind === "line");
const strokes = (scene: Scene, panel = 0) => lines(scene, panel).map((g) => g.stroke);

const sites = table({
  t: [0, 1, 0, 1, 0, 1],
  v: [1, 2, 2, 3, 3, 4],
  site: ["Site B", "Site B", "Site A", "Site A", "Average", "Average"],
});
const palette = LIGHT.palette;

describe("colors by category", () => {
  it("are the short form `color` of encode.color, by a field through the chart's color scale", () => {
    const short = build({
      marks: [line(sites, { x: "t", y: "v", series: "site", color: "site" })],
    });
    const long = build({
      marks: [
        line(sites, { x: "t", y: "v", series: "site", encode: { color: { field: "site" } } }),
      ],
    });
    expect(strokes(short)).toEqual(strokes(long));
    // Values take the palette in their dictionary's order: here, first appearance.
    expect(strokes(short)).toEqual([palette[0], palette[1], palette[2]]);
  });

  it("take a scale's fixed colors, and the palette by their place in its domain otherwise", () => {
    const scene = build({
      scales: { color: { type: "ordinal", map: { "Site A": "#00ab41", Average: "#222222" } } },
      marks: [line(sites, { x: "t", y: "v", series: "site", color: "site" })],
    });
    expect(strokes(scene)).toEqual([palette[0], "#00ab41", "#222222"]);
    expect(legendOf(scene).map((e) => [e.label, e.color])).toEqual([
      ["Site B", palette[0]],
      ["Site A", "#00ab41"],
      ["Average", "#222222"],
    ]);
  });

  it("follow an explicit domain's order, and give values outside it the unknown color", () => {
    const scene = build({
      scales: {
        color: { type: "ordinal", domain: ["Site A", "Site B"], unknown: "#999999" },
      },
      marks: [line(sites, { x: "t", y: "v", series: "site", color: "site" })],
    });
    expect(strokes(scene)).toEqual([palette[1], palette[0], "#999999"]);
  });

  it("follow a dictionary's order, as pandas Categoricals and Arrow dictionaries give it", () => {
    const dictionary = ["Average", "Site A", "Site B"];
    const coded = table({
      t: [0, 1, 0, 1],
      v: [1, 2, 3, 4],
      site: encodedCategory(new Int32Array([2, 2, 1, 1]), dictionary),
    });
    const scene = build({
      marks: [line(coded, { x: "t", y: "v", series: "site", color: "site" })],
    });
    // Site A and Site B, colored by their places in the dictionary, not in the rows.
    expect(strokes(scene)).toEqual([palette[1], palette[2]]);
  });

  it("give a value one color across marks and panels that show different subsets", () => {
    const north = table({ t: [0, 1, 0, 1], v: [1, 2, 3, 4], site: ["A", "A", "B", "B"] });
    const south = table({ t: [0, 1, 0, 1], v: [1, 2, 3, 4], site: ["C", "C", "B", "B"] });
    const scene = build({
      panels: panels([{ id: "n" }, { id: "s" }], { columns: 2 }),
      marks: [
        line(north, { x: "t", y: "v", series: "site", color: "site", panel: "n" }),
        line(south, { x: "t", y: "v", series: "site", color: "site", panel: "s" }),
      ],
    });
    expect(strokes(scene, 0)).toEqual([palette[0], palette[1]]);
    expect(strokes(scene, 1)).toEqual([palette[2], palette[1]]);
  });

  it("keep their colors as values stream in, leave, and come back", () => {
    const stream = table({ t: [0], v: [1], site: ["A"] }, { maxRows: 2 });
    const chart = model({
      marks: [line(stream, { x: "t", y: "v", series: "site", color: "site" })],
    });
    const colorOf = (site: string) =>
      lines(chart.scene(estimateText)).find((g) => g.key === JSON.stringify([0, site]))?.stroke;
    expect(colorOf("A")).toBe(palette[0]);
    stream.append({ t: [1], v: [2], site: ["B"] });
    expect(colorOf("B")).toBe(palette[1]);
    stream.append({ t: [2, 3], v: [2, 3], site: ["C", "C"] });
    expect(colorOf("A")).toBeUndefined();
    expect(colorOf("C")).toBe(palette[2]);
    stream.append({ t: [4, 5], v: [2, 3], site: ["A", "A"] });
    expect(colorOf("A")).toBe(palette[0]);
  });

  it("leave lines without a color channel on the palette by series, as before", () => {
    const scene = build({
      scales: { color: { type: "ordinal", map: { "Site A": "#00ab41" } } },
      marks: [line(sites, { x: "t", y: "v", series: "site" })],
    });
    expect(strokes(scene)).toEqual([palette[0], palette[1], palette[2]]);
  });

  it("let a constant stroke win over the color channel", () => {
    const scene = build({
      marks: [line(sites, { x: "t", y: "v", series: "site", color: "site", stroke: "#123456" })],
    });
    expect(new Set(strokes(scene))).toEqual(new Set(["#123456"]));
  });

  it("take a color as the short form of a constant", () => {
    const scene = build({
      marks: [line(sites, { x: "t", y: "v", series: "site", color: "#abcdef" })],
    });
    expect(new Set(strokes(scene))).toEqual(new Set(["#abcdef"]));
    const named = build({
      marks: [line(sites, { x: "t", y: "v", series: "site", color: "tomato" })],
    });
    expect(new Set(strokes(named))).toEqual(new Set(["tomato"]));
  });

  it("refuse a string that is neither a field nor a color, or both", () => {
    expect(() =>
      build({ marks: [line(sites, { x: "t", y: "v", color: "stie" as never })] }),
    ).toThrow(
      'line (mark 0) color: "stie" is neither a field nor a color; the table has "t", "v", "site"',
    );
    const red = table({ t: [0], v: [1], red: ["x"] });
    expect(() => build({ marks: [line(red, { x: "t", y: "v", color: "red" })] })).toThrow(
      'line (mark 0) color: "red" names both a field and a color; give encode.color: { field: "red" } or { value: "red" }',
    );
  });

  it("refuse a field whose value changes within a series", () => {
    const mixed = table({ t: [0, 1], v: [1, 2], kind: ["a", "b"] });
    expect(() => build({ marks: [line(mixed, { x: "t", y: "v", color: "kind" })] })).toThrow(
      'line (mark 0) color: changes within series "v"; lines and areas take one value per series',
    );
  });

  it("refuse a scale whose outputs the channel cannot take", () => {
    expect(() =>
      build({
        scales: { color: { type: "ordinal", map: { "Site A": 3 } } },
        marks: [line(sites, { x: "t", y: "v", series: "site", color: "site" })],
      }),
    ).toThrow(
      'chart scales.color.map["Site A"] (read by line (mark 0) color): expected a color, such as "#3266d6"; received 3',
    );
  });

  it("refuse a color set twice, and scales of categories with other types", () => {
    expect(() =>
      build({
        marks: [
          line(sites, { x: "t", y: "v", color: "site", encode: { color: { field: "site" } } }),
        ],
      }),
    ).toThrow("line (mark 0) color: set as color and as encode.color; give one");
    expect(() =>
      build({
        scales: { sites: { type: "linear" } as never },
        marks: [line(sites, { x: "t", y: "v" })],
      }),
    ).toThrow(/chart scales\.sites: marks place values on x, y, and yRight/);
    expect(() =>
      build({
        marks: [
          line(sites, {
            x: "t",
            y: "v",
            series: "site",
            encode: { color: { field: "site", scale: "zones" } },
          }),
        ],
      }),
    ).toThrow('line (mark 0) encode.color.scale: the chart has no scale "zones"; add it to scales');
  });
});

describe("looks by series", () => {
  it("map a series' stroke, width, and dash over the mark's, by its name", () => {
    const scene = build({
      marks: [
        line(sites, {
          x: "t",
          y: "v",
          series: "site",
          strokeWidth: 1,
          style: { by: { map: { Average: { stroke: "#222222", strokeWidth: 3, dash: "--" } } } },
        }),
      ],
    });
    const [b, a, average] = lines(scene);
    expect([b!.strokeWidth, a!.strokeWidth, average!.strokeWidth]).toEqual([1, 1, 3]);
    expect(average!.stroke).toBe("#222222");
    expect(average!.dash).toEqual([3.7 * 3, 1.6 * 3]);
    expect(b!.dash).toBeUndefined();
    // The mapped color takes no palette slot: the others keep theirs.
    expect([b!.stroke, a!.stroke]).toEqual([palette[0], palette[1]]);
  });

  it("keep their palette colors under channels that are not colors", () => {
    const scene = build({
      marks: [
        line(sites, {
          x: "t",
          y: "v",
          series: "site",
          encode: {
            // biome-ignore lint/suspicious/noThenProperty: a condition's branch, as specs name it.
            opacity: { condition: { when: col("site").eq("Average"), then: 1, otherwise: 0.4 } },
          },
          style: { by: { field: "site", map: { Average: { strokeWidth: 3 } } } },
        }),
      ],
    });
    expect(strokes(scene)).toEqual(palette.slice(0, 3));
    expect(lines(scene).map((g) => g.strokeWidth)).toEqual([2, 2, 3]);
  });

  it("keep palette colors for the series a map by another field does not map", () => {
    const tagged = table({
      t: [0, 1, 0, 1, 0, 1],
      v: [1, 2, 2, 3, 3, 4],
      site: ["A", "A", "B", "B", "Avg", "Avg"],
      kind: ["site", "site", "site", "site", "mean", "mean"],
    });
    const scene = build({
      marks: [
        line(tagged, {
          x: "t",
          y: "v",
          series: "site",
          style: { by: { field: "kind", map: { mean: { stroke: "#222222", dash: "--" } } } },
        }),
      ],
    });
    expect(strokes(scene)).toEqual([palette[0], palette[1], "#222222"]);
  });

  it("keep a mapped series' color on later scenes", () => {
    const tagged = table({
      t: [0, 1, 0, 1],
      v: [1, 2, 3, 4],
      site: ["A", "A", "Avg", "Avg"],
      kind: ["s", "s", "m", "m"],
    });
    const made = model({
      marks: [
        line(tagged, {
          x: "t",
          y: "v",
          series: "site",
          style: { by: { field: "kind", map: { m: { stroke: "#222222" } } } },
        }),
      ],
    });
    made.scene(estimateText);
    expect(strokes(made.scene(estimateText)).at(-1)).toBe("#222222");
  });

  it("take a condition's dash arrays alike by their steps", () => {
    const scene = build({
      marks: [
        line(sites, {
          x: "t",
          y: "v",
          series: "site",
          encode: {
            dash: {
              // biome-ignore lint/suspicious/noThenProperty: a condition's branch, as specs name it.
              condition: { when: col("site").eq("Average"), then: [4, 2], otherwise: [] },
            },
          },
        }),
      ],
    });
    expect(lines(scene).map((g) => g.dash?.length ?? 0)).toEqual([0, 0, 2]);
  });

  it("map wide data's series by their value fields", () => {
    const wide = table({ t: [0, 1], mean: [1, 2], p95: [3, 4] });
    const scene = build({
      marks: [
        line(wide, {
          x: "t",
          y: ["mean", "p95"],
          label: "ignored",
          style: { by: { map: { p95: { dash: ":" } } } },
        }),
      ],
    });
    expect(lines(scene).map((g) => g.dash?.length ?? 0)).toEqual([0, 2]);
  });

  it("show in legends that draw the marks' looks: a series' dash, width, and markers", () => {
    const scene = build({
      legend: { swatches: "mark" },
      marks: [
        line(sites, {
          x: "t",
          y: "v",
          series: "site",
          style: {
            by: { map: { Average: { dash: "--", strokeWidth: 3, marker: { radius: 4 } } } },
          },
        }),
      ],
    });
    const average = legendOf(scene).find((e) => e.label === "Average")!;
    const [stroke, dot] = average.sample!.items as [GuideItem, GuideItem];
    if (stroke.type !== "segments" || dot.type !== "shape") throw new Error("a line and a dot");
    expect([stroke.paint.strokeWidth, stroke.paint.dash]).toEqual([3, [3.7 * 3, 1.6 * 3]]);
    // The marker stands on the middle of the line.
    expect(dot.at[0]).toBeCloseTo((stroke.coords[0]! + stroke.coords[2]!) / 2, 6);
    const plain = legendOf(scene).find((e) => e.label === "Site A")!;
    expect(plain.sample!.items).toHaveLength(1);
  });

  it("show markers in legends by their symbol and outline", () => {
    const scene = build({
      legend: { swatches: "mark" },
      marks: [
        line(sites, {
          x: "t",
          y: "v",
          markers: "x",
          style: { marker: { stroke: "#000000", radius: 5 } },
        }),
      ],
    });
    const [entry] = legendOf(scene);
    const dot = entry!.sample!.items[1]!;
    if (dot.type !== "shape") throw new Error("a symbol");
    // A polygon (an "x"), not the arcs of a circle, outlined as markers are.
    expect(dot.d).toMatch(/^M[^a]*Z$/);
    expect(dot.stroke).toBe("#000000");
  });

  it("draw opacity and stroke opacity in SVG, as one opacity of the line", () => {
    const svg = renderToSVG({
      width: 400,
      height: 200,
      marks: [line(sites, { x: "t", y: "v", series: "site", opacity: 0.5, strokeOpacity: 0.5 })],
    });
    expect(svg.match(/<g opacity="0\.25"><path/g)?.length).toBe(3);
  });
});

describe("markers", () => {
  const points = (scene: Scene) =>
    scene.panels[0]!.marks.filter((m): m is PointGeometry => m.kind === "point");

  it("stand at each observation in the line's color, a circle by default", () => {
    const scene = build({
      marks: [line(sites, { x: "t", y: "v", series: "site", markers: true })],
    });
    expect(points(scene).map((p) => [p.symbol, p.count, p.fill])).toEqual([
      ["circle", 2, palette[0]],
      ["circle", 2, palette[1]],
      ["circle", 2, palette[2]],
    ]);
  });

  it("stand on the vertices of lines along y", () => {
    const casts = table({ depth: [0, 10, 20], temperature: [20, 14, 9] });
    const scene = build({
      marks: [line(casts, { x: "temperature", y: "depth", orient: "y", markers: true })],
    });
    const [trace] = lines(scene);
    const [dots] = points(scene);
    expect(Array.from(dots!.coords.subarray(0, dots!.count * 2))).toEqual(
      Array.from(trace!.path.coords.subarray(0, trace!.path.count * 2)),
    );
  });

  it("take the shape named, the mark's marker style, and a series' own", () => {
    const scene = build({
      marks: [
        line(sites, {
          x: "t",
          y: "v",
          series: "site",
          markers: "square",
          style: {
            marker: { radius: 4, stroke: "#ffffff" },
            by: { map: { Average: { marker: { symbol: "x" } } } },
          },
        }),
      ],
    });
    expect(points(scene).map((p) => [p.symbol, p.radius, p.ring?.color])).toEqual([
      ["square", 4, "#ffffff"],
      ["square", 4, "#ffffff"],
      ["x", 4, "#ffffff"],
    ]);
  });

  it("stand at the observations level of detail keeps, never more than the line draws", () => {
    const n = 100_000;
    const dense = table({
      t: Float64Array.from({ length: n }, (_, i) => i),
      v: Float64Array.from({ length: n }, (_, i) => Math.sin(i / 50)),
    });
    const scene = build({ marks: [line(dense, { x: "t", y: "v", markers: true })] });
    const [g] = lines(scene);
    const [p] = points(scene);
    expect(g!.path.count).toBeLessThan(n / 10);
    expect(p!.count).toBe(g!.path.count);
  });
});

describe("what needs the feature compiler", () => {
  it("is a mark's channels, looks, markers, or continuity, and scales of categories", () => {
    const plain = line(sites, { x: "t", y: "v", series: "site", stroke: "#000000" });
    expect(needsFeatures({ marks: [plain] })).toBe(false);
    for (const options of [
      { color: "site" },
      { encode: { strokeWidth: { value: 2 } } },
      { style: { by: { map: {} } } },
      { markers: true },
      { opacity: 0.5 },
      { strokeOpacity: 0.5 },
      { continuity: { maxGap: 2 } },
      { where: ["==", 1, 1] },
    ])
      expect(
        needsFeatures({ marks: [line(sites, { x: "t", y: "v", ...options } as never)] }),
        JSON.stringify(options),
      ).toBe(true);
    expect(needsFeatures({ marks: [plain], scales: { site: { type: "ordinal" } } })).toBe(true);
  });

  it("is not a color in CSS syntax that names no field, which marks draw themselves", () => {
    const named = table({ t: [0, 1], v: [1, 2], "#c00": ["a", "b"] });
    for (const color of ["#c00000", "rgb(0, 0, 0)", "hsl(0 0% 0%)", "var(--accent)"]) {
      const mark = line(sites, { x: "t", y: "v", series: "site", color } as never);
      expect(needsFeatures({ marks: [mark] }), color).toBe(false);
    }
    const scene = new ChartModel({ marks: [line(sites, { x: "t", y: "v", color: "#c00000" })] });
    scene.setSize(400, 200, 1);
    expect(strokes(scene.scene(estimateText))).toEqual(["#c00000"]);
    // Names go through the compiler, which knows them, as do fields named like colors.
    expect(needsFeatures({ marks: [line(sites, { x: "t", y: "v", color: "red" })] })).toBe(true);
    const field = line(named, { x: "t", y: "v", color: "#c00" } as never);
    expect(needsFeatures({ marks: [field] })).toBe(true);
  });

  it("is the same from a spec", () => {
    const spec: ChartSpec = {
      data: { d: { columns: { t: [0, 1], v: [1, 2], site: ["a", "a"] } } },
      scales: { color: { type: "ordinal", map: { a: "#00ab41" } } },
      marks: [{ type: "line", x: "t", y: "v", series: "site", color: "site" }],
    };
    const loaded = loadSpec(spec);
    const scene = new ChartModel(loaded.config, undefined, ...staticCompilers());
    scene.setSize(400, 200, 1);
    expect(strokes(scene.scene(estimateText))).toEqual(["#00ab41"]);
  });
});
