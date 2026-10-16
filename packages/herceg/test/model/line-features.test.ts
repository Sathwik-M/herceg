// Lines' features: colors by category through scales with fixed maps, looks
// by series, opacity, and markers (the feature compiler, model/features.ts).
import { describe, expect, it } from "vitest";
import { encodedCategory } from "../../src/data/column.ts";
import { derive } from "../../src/data/derive.ts";
import { col } from "../../src/data/expr.ts";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { grid } from "../../src/layout.ts";
import { area } from "../../src/marks/area.ts";
import { line } from "../../src/marks/line.ts";
import { needsFeatures } from "../../src/model/features.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { panels } from "../../src/model/panels.ts";
import { staticCompilers } from "../../src/render/compilers.ts";
import { renderToSVG } from "../../src/render/static.ts";
import type { GuideItem, LineGeometry, PointGeometry, Scene } from "../../src/scene/scene.ts";
import { type ChartError, errorInfo } from "../../src/spec/errors.ts";
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
    const marks = [line(coded, { x: "t", y: "v", series: "site", color: "site" })];
    // The series' order, the dictionary's, not the rows': the first color for the first drawn.
    expect(strokes(build({ marks }))).toEqual([palette[0], palette[1]]);
    // A declared color scale gives each value the place it has in the dictionary.
    const declared = build({ scales: { color: { type: "ordinal" } }, marks });
    expect(strokes(declared)).toEqual([palette[1], palette[2]]);
  });

  it("give a value one color across marks and panels that show different subsets", () => {
    const all = table({
      t: [0, 1, 0, 1, 0, 1],
      v: [1, 2, 3, 4, 5, 6],
      site: ["A", "A", "B", "B", "C", "C"],
      zone: ["n", "n", "both", "both", "s", "s"],
    });
    const north = derive(all).filter(col("zone").ne("s")).table();
    const south = derive(all).filter(col("zone").ne("n")).table();
    const scene = build({
      panels: panels([{ id: "n" }, { id: "s" }], grid({ columns: 2 })),
      marks: [
        line(north, { x: "t", y: "v", series: "site", color: "site", panel: "n" }),
        line(south, { x: "t", y: "v", series: "site", color: "site", panel: "s" }),
      ],
    });
    expect(strokes(scene, 0)).toEqual([palette[0], palette[1]]);
    expect(strokes(scene, 1)).toEqual([palette[1], palette[2]]);
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

  it("color series by a declared color scale, color channel or not", () => {
    const scene = build({
      scales: { color: { type: "ordinal", map: { "Site A": "#00ab41" } } },
      marks: [line(sites, { x: "t", y: "v", series: "site" })],
    });
    expect(strokes(scene)).toEqual([palette[0], "#00ab41", palette[2]]);
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
    const red = table({ t: [0, 1], v: [1, 2], red: ["x", "y"] });
    // Either reading would draw: the chart asks which.
    expect(() => build({ marks: [line(red, { x: "t", y: "v", color: "red" })] })).toThrow(
      'line (mark 0) color: "red" names both a field and a color; give encode.color: { field: "red" } or { value: "red" }',
    );
    const split = build({
      marks: [line(red, { x: "t", y: "v", series: "red", encode: { color: { field: "red" } } })],
    });
    expect(strokes(split)).toEqual([palette[0], palette[1]]);
    const constant = build({ marks: [line(red, { x: "t", y: "v", stroke: "red" })] });
    expect(strokes(constant)).toEqual(["red"]);
  });

  it("refuse a field whose value changes within a series, naming what splits it", () => {
    const mixed = table({
      t: [0, 1, 0, 1],
      v: [1, 2, 3, 4],
      kind: ["a", "b", "a", "a"],
      g: ["p", "p", "q", "q"],
    });
    // A color field splits the rows itself, unless series says otherwise.
    expect(() => build({ marks: [line(mixed, { x: "t", y: "v", color: "kind" })] })).not.toThrow();
    expect(() =>
      build({ marks: [line(mixed, { x: "t", y: "v", color: "kind", series: false })] }),
    ).toThrow(
      'line (mark 0) color: field "kind" changes within the line; lines take one color per series, so split them by a series field or give a constant color',
    );
    expect(() =>
      build({ marks: [line(mixed, { x: "t", y: "v", color: "kind", series: "g" })] }),
    ).toThrow(
      'line (mark 0) color: field "kind" changes within series "p" (by "g"); lines take one color per series, so split them by another field or give a constant color',
    );
    let thrown: unknown;
    try {
      build({ marks: [line(mixed, { x: "t", y: "v", color: "kind", series: "g" })] });
    } catch (error) {
      thrown = error;
    }
    expect(errorInfo(thrown as ChartError)).toEqual({
      code: "series-varies",
      message: expect.stringContaining('changes within series "p"'),
      phase: "validate",
      path: "marks[0].color",
      mark: 0,
    });
    // Placed at the paint that reads the field, where a style map's paint wins over it.
    const pathOf = (mark: ReturnType<typeof line> | ReturnType<typeof area>) => {
      try {
        build({ marks: [mark] });
      } catch (error) {
        return (error as ChartError).path;
      }
      return undefined;
    };
    const style = { by: { map: { p: { stroke: "#123456", fill: "#123456" } } } };
    expect([
      pathOf(
        line(mixed, { x: "t", y: "v", series: "g", encode: { stroke: { field: "kind" } }, style }),
      ),
      pathOf(
        area(mixed, { x: "t", y: "v", series: "g", encode: { fill: { field: "kind" } }, style }),
      ),
    ]).toEqual(["marks[0].encode.stroke", "marks[0].encode.fill"]);
  });

  it.each([false, true])(
    "check a streaming series' color over the rows appended alone (positions in bands: %s)",
    (banded) => {
      const n = 1000;
      const at = (i: number) => (banded ? `p${i % 50}` : i);
      const rows = table(
        {
          t: Array.from({ length: n }, (_, i) => at(i)) as never as number[],
          v: Array.from({ length: n }, () => 1),
          kind: Array.from({ length: n }, () => "a"),
          g: Array.from({ length: n }, () => "p"),
        },
        { maxRows: 2 * n },
      );
      // Counts the rows whose color is read, whatever order they draw in.
      let reads = 0;
      const categories = rows.categories.bind(rows);
      rows.categories = ((field: never) => {
        const found = categories(field);
        if (field !== "kind") return found;
        const codes = new Proxy(found.codes, {
          get: (target, key) => {
            if (typeof key === "string" && /^\d+$/.test(key)) reads++;
            return Reflect.get(target, key);
          },
        });
        return { ...found, codes };
      }) as typeof rows.categories;
      const chart = model({ marks: [line(rows, { x: "t", y: "v", series: "g", color: "kind" })] });
      chart.scene(estimateText);
      reads = 0;
      rows.append({ t: [at(n), at(n + 1)] as never, v: [1, 1], kind: ["a", "a"], g: ["p", "p"] });
      chart.scene(estimateText);
      expect(reads).toBe(2);
      rows.append({ t: [at(n + 2)] as never, v: [1], kind: ["b"], g: ["p"] });
      expect(() => chart.scene(estimateText)).toThrow('changes within series "p"');
    },
  );

  it("forget what was checked of series a rolling window leaves, colors missing or not", () => {
    const stream = table({ t: [0], v: [1], g: ["s0"], kind: ["a"] }, { maxRows: 2 });
    const chart = model({ marks: [line(stream, { x: "t", y: "v", series: "g", color: "kind" })] });
    chart.scene(estimateText);
    // What is kept of series' checks, by series key and the field checked.
    const sizes: number[] = [];
    const set = Map.prototype.set;
    Map.prototype.set = function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
      if (typeof key === "string" && key.endsWith("|kind")) sizes.push(this.size);
      return set.call(this, key, value);
    };
    try {
      for (let i = 1; i <= 200; i++) {
        stream.append({ t: [i], v: [1], g: [`s${i}`], kind: [null] });
        chart.scene(estimateText);
      }
    } finally {
      Map.prototype.set = set;
    }
    expect(sizes.length).toBeGreaterThan(100);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(3);
  });

  it.each(["line", "area"] as const)(
    "check appended rows as a chart of the same rows checks them, rows without a band left out (%s)",
    (type) => {
      const make = (rows: unknown) =>
        model({
          marks: [
            (type === "line" ? line : area)(rows as never, {
              x: "x",
              y: "v",
              series: false,
              color: "c",
            }),
          ],
        });
      const streamed = table({ x: ["a", null], v: [1, 2], c: ["eu", "us"] });
      const chart = make(streamed);
      chart.scene(estimateText);
      streamed.append({ x: [null], v: [3], c: ["us"] });
      expect(() => chart.scene(estimateText)).not.toThrow();
      const fresh = make(table({ x: ["a", null, null], v: [1, 2, 3], c: ["eu", "us", "us"] }));
      expect(() => fresh.scene(estimateText)).not.toThrow();
      // A row in a band of another color is refused, streamed as it is fresh.
      streamed.append({ x: ["b"], v: [4], c: ["us"] });
      expect(() => chart.scene(estimateText)).toThrow(`changes within the ${type}`);
    },
  );

  it("check rows a category axis draws out of order, and only rows still in the table", () => {
    const placed = table({ t: ["a", "b", "c"], v: [1, 2, 3], kind: ["k", "k", "k"] });
    const chart = model({
      marks: [line(placed, { x: "t", y: "v", color: "kind", series: false })],
    });
    chart.scene(estimateText);
    // Drawn at "a", before the rows checked: checked all the same.
    placed.append({ t: ["a"], v: [4], kind: ["m"] });
    expect(() => chart.scene(estimateText)).toThrow("changes within the line");
    // A value whose rows the window dropped says nothing of the rows after it.
    const rolling = table({ t: [0, 1], v: [1, 2], kind: ["a", null] }, { maxRows: 2 });
    const stream = model({
      marks: [line(rolling, { x: "t", y: "v", color: "kind", series: false })],
    });
    stream.scene(estimateText);
    rolling.append({ t: [2], v: [3], kind: ["b"] });
    expect(() => stream.scene(estimateText)).not.toThrow();
  });

  it("leave a color field alone where a stroke of the line's own wins", () => {
    const mixed = table({ t: [0, 1], v: [1, 2], g: ["a", "b"] });
    const scene = build({
      marks: [line(mixed, { x: "t", y: "v", color: "g", stroke: "#123456" })],
    });
    expect(strokes(scene)).toEqual(["#123456"]);
  });

  it("place errors after a mark's name, whatever its id holds", () => {
    let thrown: unknown;
    try {
      build({
        marks: [
          line(sites, {
            x: "t",
            y: "v",
            id: "cpu:load",
            encode: { color: { field: "zone" as never } },
          }),
        ],
      });
    } catch (error) {
      thrown = error;
    }
    expect(errorInfo(thrown as ChartError)).toMatchObject({
      code: "unknown-field",
      path: "marks[0].encode.color.field",
      mark: "cpu:load",
    });
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
    // Placed at the key, whatever it holds.
    const pathOf = (key: string) => {
      try {
        build({
          scales: { color: { type: "ordinal", map: { [key]: "nope" } } },
          marks: [line(sites, { x: "t", y: "v", series: "site", color: "site" })],
        });
      } catch (error) {
        return (error as ChartError).path;
      }
      return undefined;
    };
    for (const key of ["a:b", "x (read by y", 'q"t'])
      expect(pathOf(key)).toBe(`scales.color.map[${JSON.stringify(key)}]`);
    // And at the scale, whatever its name holds.
    const scaledPath = (name: string) => {
      try {
        build({
          scales: { [name]: { type: "ordinal", map: { "Site A": "nope" } } },
          marks: [
            line(sites, {
              x: "t",
              y: "v",
              series: "site",
              encode: { color: { field: "site", scale: name } },
            }),
          ],
        });
      } catch (error) {
        return (error as ChartError).path;
      }
      return undefined;
    };
    expect(scaledPath("regions")).toBe('scales.regions.map["Site A"]');
    for (const name of ["regions:v1", 'q"t', "a.b", "x (read by y"])
      expect(scaledPath(name)).toBe(`scales[${JSON.stringify(name)}].map["Site A"]`);
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
      { color: "site", series: false },
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
    // A color field the series are split by is the chart's to color.
    const colored = line(sites, { x: "t", y: "v", color: "site" });
    expect(needsFeatures({ marks: [colored] })).toBe(false);
    expect(
      needsFeatures({ marks: [line(sites, { x: "t", y: "v", series: "site", color: "site" })] }),
    ).toBe(false);
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
    // Names go through the compiler, which knows them; a field named like a
    // color is the field, which splits the series.
    expect(needsFeatures({ marks: [line(sites, { x: "t", y: "v", color: "red" })] })).toBe(true);
    const field = line(named, { x: "t", y: "v", color: "#c00" } as never);
    expect(needsFeatures({ marks: [field] })).toBe(false);
    const split = new ChartModel({ marks: [field] });
    split.setSize(400, 200, 1);
    expect(strokes(split.scene(estimateText))).toHaveLength(2);
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
