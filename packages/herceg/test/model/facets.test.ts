// Small multiples: one panel per value of a category field.
import { describe, expect, it } from "vitest";
import { category, time } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { bar } from "../../src/marks/bar.ts";
import { heatmap } from "../../src/marks/heatmap.ts";
import { histogram } from "../../src/marks/histogram.ts";
import { type LineMark, line } from "../../src/marks/line.ts";
import { point } from "../../src/marks/point.ts";
import { rule } from "../../src/marks/rule.ts";
import { describeChart } from "../../src/model/describe.ts";
import { facet } from "../../src/model/facet.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { renderToSVG } from "../../src/render/static.ts";
import type { LineGeometry, Panel, RectGeometry, Scene } from "../../src/scene/scene.ts";
import { loadSpec } from "../../src/spec/load.ts";

function build(config: ChartConfig, width = 600, height = 400) {
  const model = new ChartModel({ locale: "en-US", timeZone: "UTC", ...config });
  model.setSize(width, height, 1);
  return { model, scene: model.scene(estimateText) };
}

const lines = (panel: Panel) => panel.marks.filter((m): m is LineGeometry => m.kind === "line");
const axis = (panel: Panel, orient: string) => panel.axes.find((a) => a.orient === orient);
/** Pixel x and y of each point of a line. */
const points = (geometry: LineGeometry) => {
  const { coords, count } = geometry.path;
  return Array.from({ length: count }, (_, i) => [coords[i * 2]!, coords[i * 2 + 1]!]);
};

// Rows of three regions, interleaved, so each region's x is ascending while
// the whole column is not.
const sales = table({
  t: [0, 0, 0, 1, 1, 1, 2, 2, 2],
  units: [1, 10, 100, 2, 20, 200, 3, 30, 300],
  region: ["N", "S", "E", "N", "S", "E", "N", "S", "E"],
});

describe("facets", () => {
  it("draw a panel per value, in order of first appearance, on shared scales", () => {
    const { scene, model } = build({
      marks: [line(sales, { x: "t", y: "units" })],
      facet: facet("region"),
    });
    expect(scene.panels.map((p) => p.key)).toEqual(["N", "S", "E"]);
    expect(scene.headers.map((h) => h.text)).toEqual(["N", "S", "E"]);
    // One y domain for all panels, covering every region.
    expect(model.yScale()!.domain[1]).toBeGreaterThanOrEqual(300);
    // Each panel draws its region's rows: N is 1, 2, 3.
    const [n, s] = scene.panels;
    const y = (value: number, panel: Panel) => {
      const scale = model.yScale()!;
      return scale.map(value) - model.panels()[0]!.plot.y + panel.plot.y;
    };
    expect(points(lines(n!)[0]!).map(([, py]) => py)).toEqual(
      [1, 2, 3].map((v) => expect.closeTo(y(v, n!), 3)),
    );
    expect(points(lines(s!)[0]!).map(([, py]) => py)).toEqual(
      [10, 20, 30].map((v) => expect.closeTo(y(v, s!), 3)),
    );
    // The legend has the series once.
    expect(scene.legend).toHaveLength(0);
    expect(model.series()).toHaveLength(1);
  });

  it("lay panels out in a grid, labeling x under each column's lowest panel and y in the first column", () => {
    const { scene } = build({
      marks: [line(sales, { x: "t", y: "units" })],
      facet: facet("region", { columns: 2 }),
      x: { label: "week" },
      y: { label: "units" },
    });
    const [n, s, e] = scene.panels as [Panel, Panel, Panel];
    // N S / E: two columns, two rows, panels of equal size.
    expect(s.plot.x).toBeGreaterThan(n.plot.x + n.plot.width);
    expect(s.plot.y).toBe(n.plot.y);
    expect(e.plot.x).toBe(n.plot.x);
    expect(e.plot.y).toBeGreaterThan(n.plot.y + n.plot.height);
    expect(new Set(scene.panels.map((p) => `${p.plot.width}x${p.plot.height}`)).size).toBe(1);
    // x labels: under E (its column's lowest) and under S, above the empty cell.
    expect(axis(n, "bottom")).toBeUndefined();
    expect(axis(s, "bottom")!.ticks.length).toBeGreaterThan(0);
    expect(axis(e, "bottom")!.ticks.length).toBeGreaterThan(0);
    // y labels in the first column only.
    expect(axis(n, "left")).toBeDefined();
    expect(axis(e, "left")).toBeDefined();
    expect(axis(s, "left")).toBeUndefined();
    // Axis titles once each.
    const titles = scene.panels.flatMap((p) => p.axes.map((a) => a.title?.text).filter(Boolean));
    expect(titles.sort()).toEqual(["units", "week"]);
    // Panel headers sit above their plots.
    expect(scene.headers[0]!.y).toBeLessThan(n.plot.y);
  });

  it("repeat constant annotations and marks marked repeat in every panel", () => {
    const all = table({ t: [0, 2], level: [50, 50] });
    const { scene } = build({
      marks: [
        line(sales, { x: "t", y: "units" }),
        line(all, { x: "t", y: "level", facet: "repeat" }),
        rule({ y: 150, label: "target" }),
      ],
      facet: facet("region"),
    });
    for (const panel of scene.panels) {
      expect(lines(panel)).toHaveLength(2);
      expect(points(lines(panel)[1]!)).toHaveLength(2);
      expect(panel.marks.filter((m) => m.kind === "rule")).toHaveLength(1);
    }
  });

  it("leave out rows without a facet value, from drawing and from domains", () => {
    const partial = table({ t: [0, 1, 2], v: [1, 2, 1000], g: ["a", "a", null] });
    const { scene, model } = build({
      marks: [line(partial, { x: "t", y: "v" })],
      facet: facet("g"),
    });
    expect(scene.panels.map((p) => p.key)).toEqual(["a"]);
    expect(points(lines(scene.panels[0]!)[0]!)).toHaveLength(2);
    expect(model.yScale()!.domain[1]).toBeLessThan(100);
  });

  it("refuse marks they cannot split, and explain how to repeat them", () => {
    const panels = facet("region");
    const other = table({ t: [0], v: [1] });
    expect(() => build({ marks: [line(other, { x: "t", y: "v" })], facet: panels })).toThrow(
      /no field "region" to split into panels; give it facet: "repeat"/,
    );
    expect(() =>
      build({ marks: [line(sales, { x: "t", y: "units" })], facet: facet("units") }),
    ).toThrow(/Facet field "units" is number/);
    const cells = table({ x: ["a"], y: ["b"], v: [1], region: ["N"] });
    expect(() => build({ marks: [rule(cells, { y: "v" })], facet: panels })).toThrow(
      /rule mark over a table cannot be split into panels yet/,
    );
    expect(() =>
      build({ marks: [line(sales, { x: "t", y: "units", axis: "right" })], facet: panels }),
    ).toThrow(/cannot use the right axis yet/);
    expect(() =>
      build({
        marks: [line(sales, { x: "t", y: "units" })],
        facet: facet("region", { columns: 0 }),
      }),
    ).toThrow(/at least 1/);
    // Repeated, a rule is fine; heatmaps and histograms split.
    const repeated = rule(cells, { y: "v", facet: "repeat" });
    expect(() => build({ marks: [repeated], facet: panels })).not.toThrow();
    const split = heatmap(cells, { x: "x", y: "y", value: "v" });
    expect(() => build({ marks: [split], facet: panels })).not.toThrow();
    expect(() => build({ marks: [histogram(cells, { x: "v" })], facet: panels })).not.toThrow();
  });

  it("inspect the panel under the pointer, and report it", () => {
    const { scene, model } = build({
      marks: [line(sales, { x: "t", y: "units" })],
      facet: facet("region"),
    });
    const [, s] = scene.panels as [Panel, Panel];
    const x = model.panels()[1]!.x;
    const hit = model.inspect(x.map(1), s.plot.y + 10)!;
    expect(hit.panel).toBe("S");
    expect(hit.points.map((p) => p.text)).toEqual(["20"]);
    // Between panels, nothing.
    expect(model.inspect(s.plot.x - 4, s.plot.y + 10)).toBeUndefined();
    const keyed = model.inspectPosition(model.panelSeries("E")[0]!.key, 2, "E")!;
    expect(keyed.panel).toBe("E");
    expect(keyed.points[0]!.text).toBe("300");
  });

  it("give each panel its own buffers and keep panel subsets sorted", () => {
    // Each region's x ascends; the whole column does not.
    const grouped = table({
      t: [0, 1, 2, 0, 1, 2],
      v: [1, 2, 3, 4, 5, 6],
      g: ["a", "a", "a", "b", "b", "b"],
    });
    const { scene, model } = build({
      marks: [line(grouped, { x: "t", y: "v" })],
      facet: facet("g"),
    });
    const [a, b] = scene.panels.map((p) => lines(p)[0]!);
    expect(a!.path).not.toBe(b!.path);
    expect(points(a!)[0]![0]).not.toBeCloseTo(points(b!)[0]![0]!, 3);
    expect(model.series()[0]!.sorted).toBe(false);
    expect(model.panelSeries("a")[0]!.sorted).toBe(true);
  });

  it("keep grouped bars in their slots in panels missing a group", () => {
    const groups = table({
      q: ["Q1", "Q1", "Q1"],
      v: [1, 2, 3],
      kind: ["a", "b", "a"],
      region: ["N", "N", "S"],
    });
    const { scene } = build({
      marks: [bar(groups, { x: "q", y: "v", series: "kind" })],
      facet: facet("region"),
    });
    const left = (panel: Panel, series: number) => {
      const rects = panel.marks.filter((m): m is RectGeometry => m.kind === "rect");
      return rects[series]!.rects[0]! - panel.plot.x;
    };
    const [n, s] = scene.panels as [Panel, Panel];
    // "a" sits in the same slot in both panels, though S has no "b".
    expect(left(s, 0)).toBeCloseTo(left(n, 0), 3);
  });

  it("follow data as it streams, and draw in static SVG", () => {
    const live = table({ t: [0, 1], v: [1, 2], g: ["a", "a"] }, { maxRows: 4 });
    const { model } = build({ marks: [line(live, { x: "t", y: "v" })], facet: facet("g") });
    live.append({ t: [2, 3], v: [3, 4], g: ["b", "b"] });
    expect(model.scene(estimateText).panels.map((p) => p.key)).toEqual(["a", "b"]);
    live.append({ t: [4, 5], v: [5, 6], g: ["b", "c"] });
    const next = model.scene(estimateText);
    expect(next.panels.map((p) => p.key)).toEqual(["b", "c"]);
    // b holds rows 2 to 4 of the window, drawn and summarized.
    expect(points(lines(next.panels[0]!)[0]!)).toHaveLength(3);
    expect(describeChart(model)).toContain("v: 4 points, from 3 to 6, last 6.");
    const svg = renderToSVG({
      width: 400,
      height: 200,
      marks: [line(sales, { x: "t", y: "units" })],
      facet: facet("region"),
    });
    expect(svg.match(/<clipPath /g)).toHaveLength(3);
    expect(svg).toMatch(/font-weight="600" fill="[^"]+">S<\/text>/);
  });

  it("load from specs and describe their panels", () => {
    const { config } = loadSpec({
      data: { t: { columns: { t: [0, 1], v: [1, 2], g: ["a", "b"] } } },
      marks: [
        { type: "line", x: "t", y: "v" },
        { type: "rule", y: 1, facet: "repeat" },
      ],
      facet: { field: "g", columns: 2 },
    });
    expect(config.facet).toEqual({ field: "g", columns: 2 });
    expect(() =>
      loadSpec({
        data: { t: { columns: { t: [0], v: [1], g: ["a"] } } },
        marks: [{ type: "line", x: "t", y: "v" }],
        facet: { field: "g", columns: 1.5 },
      }),
    ).toThrow(/facet\.columns: expected a whole number of at least 1/);
    const model = new ChartModel({ ...config, locale: "en-US" });
    model.setSize(400, 200);
    model.scene(estimateText);
    expect(describeChart(model)).toContain("Panels by g: a, b.");
  });

  it("count a repeated mark's draws once per scene", () => {
    const n = 300_000;
    const big = table({
      x: Float64Array.from({ length: n }, (_, i) => i),
      y: Float64Array.from({ length: n }, (_, i) => Math.sin(i / 100)),
    });
    const { model } = build({
      marks: [line(sales, { x: "t", y: "units" }), line(big, { x: "x", y: "y", facet: "repeat" })],
      facet: facet("region"),
    });
    // One scene, three panels: still a first draw, which builds no index.
    expect(big.hasMinMaxIndex("y")).toBe(false);
    model.scene(estimateText);
    expect(big.hasMinMaxIndex("y")).toBe(true);
  });

  it("split a mark again when its x changes, checking sortedness anew", () => {
    const two = table({ a: [0, 1, 2], b: [2, 0, 1], v: [1, 2, 3], g: ["p", "p", "p"] });
    const panels = facet("g");
    const { model } = build({ marks: [line(two, { x: "a", y: "v" })], facet: panels });
    expect(model.panelSeries("p")[0]!.sorted).toBe(true);
    model.update({ locale: "en-US", marks: [line(two, { x: "b", y: "v" })], facet: panels });
    model.scene(estimateText);
    expect(model.panelSeries("p")[0]!.sorted).toBe(false);
    expect(model.xScale()!.domain).toEqual([0, 2]);
  });

  it("keep each panel's x scale on its plot, the same from one scene to the next", () => {
    const names = Array.from({ length: 7 }, (_, i) => `a rather long category ${i}`);
    const cats = table({
      c: [...names, ...names],
      v: Array.from({ length: 14 }, (_, i) => i + 1),
      g: Array.from({ length: 14 }, (_, i) => (i < 7 ? "p" : "q")),
    });
    const { model, scene } = build(
      { marks: [bar(cats, { x: "c", y: "v" })], facet: facet("g") },
      793,
    );
    const check = (panels: readonly Panel[]) =>
      panels.forEach((panel, i) => {
        const { range } = model.panels()[i]!.x;
        expect(range[0]).toBeCloseTo(panel.plot.x, 6);
        expect(range[1]).toBeCloseTo(panel.plot.x + panel.plot.width, 6);
      });
    check(scene.panels);
    const again = model.scene(estimateText);
    check(again.panels);
    expect(again.panels.map((p) => p.plot)).toEqual(scene.panels.map((p) => p.plot));
  });

  it("refuse grids of panels too small to draw", () => {
    const n = 50;
    const many = table({
      t: Array.from({ length: n }, () => 0),
      v: Array.from({ length: n }, () => 1),
      g: Array.from({ length: n }, (_, i) => `panel ${i}`),
    });
    expect(() =>
      build({ marks: [line(many, { x: "t", y: "v" })], facet: facet("g") }, 600, 300),
    ).toThrow(/50 panels in 7 rows of 8 do not fit a 600×300 chart/);
    expect(() =>
      build(
        { marks: [line(many, { x: "t", y: "v" })], facet: facet("g", { columns: 50 }) },
        600,
        300,
      ),
    ).toThrow(/50 panels in 1 rows of 50 do not fit/);
  });

  it("summarize and measure only the rows they draw, across panels", () => {
    const partial = table({
      t: [0, 1, 2, 3, 1000],
      v: [1, 5, 2, 4, 1000],
      g: ["a", "b", "a", "b", null],
    });
    const { model } = build({ marks: [line(partial, { x: "t", y: "v" })], facet: facet("g") });
    // The last value is the latest row's (b's 4), wherever its panel is.
    expect(describeChart(model)).toContain("v: 4 points, from 1 to 5, last 4.");
    expect(model.dataXExtent()).toEqual([0, 3]);
  });

  it("settle their layout in one scene, so the next draws the same or refuses the same", () => {
    const settled = (names: string[], keys: string[], width: number, height = 300) => {
      const cats = table({
        c: keys.flatMap(() => names),
        v: keys.flatMap(() => names.map(() => 1)),
        g: keys.flatMap((key) => names.map(() => key)),
      });
      const panels = keys.length > 1 ? facet("g") : undefined;
      const model = new ChartModel({ marks: [bar(cats, { x: "c", y: "v" })], facet: panels });
      model.setSize(width, height, 1);
      const outcome = () => {
        try {
          return model.scene(estimateText).panels.map((p) => p.plot);
        } catch (error) {
          return (error as Error).message;
        }
      };
      const first = outcome();
      expect(outcome()).toEqual(first);
      return first;
    };
    settled([`${"x".repeat(20)}0`], ["p", "q"], 278);
    settled([`${"x".repeat(30)}0`], ["p"], 200);
    settled(
      ["0", "1", "2"].map((i) => "x".repeat(15) + i),
      ["p", "q"],
      153,
      600,
    );
  });
});

describe("row and column facets", () => {
  // Two products in three regions, with no rows for South's B.
  const grid = table({
    t: [0, 1, 0, 1, 0, 1, 0, 1, 0, 1],
    units: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    region: ["N", "N", "N", "N", "S", "S", "E", "E", "E", "E"],
    product: ["A", "A", "B", "B", "A", "A", "A", "A", "B", "B"],
  });

  it("draw a panel per pair of values, rows by columns, including pairs without rows", () => {
    const { scene, model } = build({
      marks: [line(grid, { x: "t", y: "units" })],
      facet: facet({ row: "region", column: "product" }),
    });
    expect(model.panels().map(({ label }) => label)).toEqual([
      "N, A",
      "N, B",
      "S, A",
      "S, B",
      "E, A",
      "E, B",
    ]);
    // Keys name both values without ambiguity.
    expect(scene.panels[1]!.key).toBe(JSON.stringify(["N", "B"]));
    const [na, nb, sa, sb, ea] = scene.panels as Panel[];
    expect(nb!.plot.y).toBe(na!.plot.y);
    expect(nb!.plot.x).toBeGreaterThan(na!.plot.x + na!.plot.width);
    expect(sa!.plot.x).toBe(na!.plot.x);
    expect(ea!.plot.y).toBeGreaterThan(sa!.plot.y);
    // South has no B: its panel is there, empty.
    expect(lines(sb!).every((l) => l.path.count === 0)).toBe(true);
    expect(points(lines(nb!)[0]!)).toHaveLength(2);
    // Columns are headed once above the top row, rows once beside the last column.
    const top = scene.headers.filter((h) => h.angle === 0);
    expect(top.map((h) => h.text)).toEqual(["A", "B"]);
    expect(top[1]!.x).toBeCloseTo(nb!.plot.x + nb!.plot.width / 2);
    expect(top[0]!.y).toBeLessThan(na!.plot.y);
    const side = scene.headers.filter((h) => h.angle === 90);
    expect(side.map((h) => h.text)).toEqual(["N", "S", "E"]);
    expect(side[0]!.x).toBeGreaterThan(nb!.plot.x + nb!.plot.width);
    expect(side[0]!.x).toBeLessThan(600);
    // x labels under the bottom row only, y labels in the first column only.
    expect(scene.panels.map((p) => axis(p, "bottom") !== undefined)).toEqual([
      false,
      false,
      false,
      false,
      true,
      true,
    ]);
    expect(scene.panels.map((p) => axis(p, "left") !== undefined)).toEqual([
      true,
      false,
      true,
      false,
      true,
      false,
    ]);
    expect(describeChart(model)).toContain(
      "Panels by region in rows and product in columns: N, A; N, B; S, A; S, B; E, A; E, B.",
    );
  });

  it("make one row of columns, or one column of rows, from a single field", () => {
    const columns = build({
      marks: [line(grid, { x: "t", y: "units" })],
      facet: facet({ column: "product" }),
    }).scene;
    expect(columns.panels.map((p) => p.key)).toEqual(["A", "B"]);
    expect(columns.panels[1]!.plot.y).toBe(columns.panels[0]!.plot.y);
    expect(columns.headers.map((h) => [h.text, h.angle])).toEqual([
      ["A", 0],
      ["B", 0],
    ]);
    const rows = build({
      marks: [line(grid, { x: "t", y: "units" })],
      facet: facet({ row: "region" }),
    }).scene;
    expect(rows.panels.map((p) => p.key)).toEqual(["N", "S", "E"]);
    expect(rows.panels[1]!.plot.x).toBe(rows.panels[0]!.plot.x);
    expect(rows.headers.map((h) => h.angle)).toEqual([90, 90, 90]);
  });

  it("refuse facets without fields, with one field twice, or with both forms", () => {
    expect(() => facet({})).toThrow("needs a field, or a row or column field");
    expect(() => facet({ row: "region", column: "region" })).toThrow("must differ");
    const spec = (facet: unknown) => () =>
      loadSpec(
        {
          version: 1,
          data: { t: { columns: { x: [1], y: [1] } } },
          marks: [{ type: "line", x: "x", y: "y" }],
          facet: facet as never,
        },
        [],
      );
    expect(spec({ field: "a", row: "b" })).toThrow("not both");
    expect(spec({ columns: 2 })).toThrow("a field, or a row or column field");
    expect(spec({ row: "a", columns: 2 })).toThrow("facet.columns");
    expect(() => facet({ column: "c", columns: 2 } as never)).toThrow("not columns");
  });

  it("draw one empty panel without headers until values arrive, and again after they go", () => {
    const empty = table({
      t: new Float64Array(0),
      units: new Float64Array(0),
      region: category([]),
      product: category([]),
    });
    for (const grid of [
      { row: "region", column: "product" },
      { row: "region" },
      { column: "product" },
    ]) {
      const { scene, model } = build({
        marks: [line(empty, { x: "t", y: "units" })],
        facet: facet(grid),
      });
      expect(scene.panels).toHaveLength(1);
      expect(scene.headers).toEqual([]);
      expect(
        renderToSVG({
          marks: [line(empty, { x: "t", y: "units" })],
          facet: facet(grid),
          width: 300,
          height: 200,
        }),
      ).toContain("<svg");
      empty.append({ t: [0], units: [1], region: ["N"], product: ["A"] });
      expect(model.scene(estimateText).headers.length).toBeGreaterThan(0);
      empty.dropFirst(1);
      expect(model.scene(estimateText).headers).toEqual([]);
    }
  });

  it("refuse grids that cannot fit before listing their panels, naming the remedy", () => {
    const n = 300;
    const diagonal = table({
      t: Array.from({ length: n }, (_, i) => i),
      units: Array.from({ length: n }, (_, i) => i),
      region: Array.from({ length: n }, (_, i) => `r${i}`),
      product: Array.from({ length: n }, (_, i) => `p${i}`),
    });
    expect(() =>
      build({
        marks: [line(diagonal, { x: "t", y: "units" })],
        facet: facet({ row: "region", column: "product" }),
      }),
    ).toThrow(
      "90000 panels in 300 rows of 300 do not fit a 600×400 chart; make it larger or facet by fields with fewer values",
    );
  });

  it("load from specs and render headers in SVG", () => {
    const { config } = loadSpec(
      {
        version: 1,
        data: {
          t: {
            columns: {
              x: [0, 1, 0, 1],
              y: [1, 2, 3, 4],
              r: { type: "category", codes: [0, 0, 1, 1], dictionary: ["Up", "Down"] },
              c: { type: "category", codes: [0, 1, 0, 1], dictionary: ["Left", "Right"] },
            },
          },
        },
        marks: [{ type: "line", x: "x", y: "y" }],
        facet: { row: "r", column: "c" },
      },
      [],
    );
    const svg = renderToSVG({ ...config, width: 500, height: 300 });
    expect(svg).toContain(">Left</text>");
    expect(svg).toMatch(/<text [^>]*transform="rotate\(90 [^>]*>Up<\/text>/);
  });
});

describe("facet panels with y scales of their own", () => {
  // Two regions of very different sizes, in two products.
  const sales = table({
    t: [0, 1, 0, 1, 0, 1, 0, 1],
    units: [1, 2, 3, 4, 100, 200, 300, 400],
    region: ["small", "small", "small", "small", "large", "large", "large", "large"],
    product: ["A", "A", "B", "B", "A", "A", "B", "B"],
  });
  const marks = [line(sales, { x: "t", y: "units" })];
  const top = (model: ChartModel, i: number) => Math.max(...model.panels()[i]!.y.domain);
  const labeled = (scene: Scene) => scene.panels.map((p) => axis(p, "left") !== undefined);

  it("fit each panel's own data with independent scales, labeling every panel", () => {
    const { model, scene } = build({
      marks,
      facet: facet({ row: "region", column: "product" }),
      resolve: { y: "independent" },
    });
    expect([0, 1, 2, 3].map((i) => top(model, i))).toEqual([2, 4, 200, 400]);
    expect(labeled(scene)).toEqual([true, true, true, true]);
    // The gap between columns holds the second column's labels.
    const [a, b] = scene.panels as Panel[];
    expect(b!.plot.x - (a!.plot.x + a!.plot.width)).toBeGreaterThan(30);
  });

  it("share a scale along rows or columns", () => {
    const rows = build({
      marks,
      facet: facet({ row: "region", column: "product" }),
      resolve: { y: "rows" },
    });
    expect([0, 1, 2, 3].map((i) => top(rows.model, i))).toEqual([4, 4, 400, 400]);
    expect(labeled(rows.scene)).toEqual([true, false, true, false]);
    const columns = build({
      marks,
      facet: facet({ row: "region", column: "product" }),
      resolve: { y: "columns" },
    });
    expect([0, 1, 2, 3].map((i) => top(columns.model, i))).toEqual([200, 400, 200, 400]);
    expect(labeled(columns.scene)).toEqual([true, true, true, true]);
    // Without facets, there is nothing to resolve.
    const plain = build({ marks, resolve: { y: "independent" } });
    expect(top(plain.model, 0)).toBe(400);
  });

  it("let each group's own marks decide its zero, insets, and labels", () => {
    // Bars only in B: A's lines need not start at zero.
    const lines = table({ t: [0, 1, 0, 1], v: [100, 200, 5, 6], g: ["A", "A", "B", "B"] });
    const bars = table({ t: [0, 1], v: [5, 6], g: ["B", "B"] });
    const { model } = build({
      marks: [line(lines, { x: "t", y: "v" }), bar(bars, { x: "t", y: "v" })],
      facet: facet("g"),
      resolve: { y: "independent" },
    });
    expect(Math.min(...model.panels()[0]!.y.domain)).toBeGreaterThan(0);
    expect(Math.min(...model.panels()[1]!.y.domain)).toBe(0);
    // A panel without rows has no y labels, even on a fixed domain.
    const sparse = table({ t: [0, 1], v: [1, 2], r: ["N", "N"], c: ["A", "A"] });
    const sparseRows = table({ t: [0], v: [3], r: ["S"], c: ["B"] });
    const fixed = build({
      marks: [line(sparse, { x: "t", y: "v" }), line(sparseRows, { x: "t", y: "v" })],
      facet: facet({ row: "r", column: "c" }),
      resolve: { y: "independent" },
      y: { domain: [0, 10] },
    });
    const labels = fixed.scene.panels.map((p) => axis(p, "left")?.ticks.length ?? 0);
    expect(labels.map((n) => n > 0)).toEqual([true, false, false, true]);
  });

  it("let go of a y zoom when panels get y scales of their own", () => {
    const model = new ChartModel({ marks, facet: facet("region") });
    model.setYViewport({ y: [0, 50], yRight: null });
    expect(model.yViewport.y).toEqual([0, 50]);
    model.update({ marks, facet: facet("region"), resolve: { y: "independent" } });
    expect(model.yViewport).toEqual({ y: null, yRight: null });
    expect(() => model.setYViewport({ y: [0, 50], yRight: null })).toThrow("no one y viewport");
  });

  it("refuse y zoom, and need spec version 2", () => {
    expect(() =>
      build({
        marks,
        facet: facet("region"),
        resolve: { y: "independent" },
        interaction: { zoom: "xy" },
      }),
    ).toThrow("cannot zoom along y");
    const spec = (version: number | undefined) => () =>
      loadSpec(
        {
          ...(version !== undefined && { version: version as 1 }),
          data: { t: { columns: { x: [1, 2], y: [1, 2] } } },
          marks: [{ type: "line", x: "x", y: "y" }],
          resolve: { y: "independent" },
        },
        [],
      );
    expect(spec(1)).toThrow('spec.resolve: expected a spec with "version": 2 or later');
    expect(spec(undefined)).toThrow('spec.resolve: expected a spec with "version": 2 or later');
    expect(spec(2)).not.toThrow();
    expect(spec(7)).not.toThrow();
    expect(spec(8)).toThrow("reads versions 1 to 7");
  });
});

describe("facet panels with x scales of their own", () => {
  // Two sites measured over different times and magnitudes, two sensors each.
  const readings = table({
    t: [0, 10, 0, 10, 1000, 1100, 1000, 1100],
    v: [1, 2, 3, 4, 10, 20, 30, 40],
    site: ["A", "A", "A", "A", "B", "B", "B", "B"],
    sensor: ["p", "p", "q", "q", "p", "p", "q", "q"],
  });
  const marks = [line(readings, { x: "t", y: "v" })];
  const grid = facet({ row: "site", column: "sensor" });
  const xOf = (model: ChartModel) => model.panels().map((p) => [...p.x.domain]);
  const labeled = (scene: Scene) =>
    scene.panels.map((p) => (axis(p, "bottom")?.ticks.length ?? 0) > 0);
  const titles = (scene: Scene) =>
    scene.panels.flatMap((p) => (axis(p, "bottom")?.title ? [axis(p, "bottom")!.title!] : []));

  it("fit each panel's own x data, labeling every panel and titling each scale", () => {
    const { model, scene } = build({
      marks,
      facet: grid,
      resolve: { x: "independent" },
      x: { label: "Time" },
    });
    expect(xOf(model)).toEqual([
      [0, 10],
      [0, 10],
      [1000, 1100],
      [1000, 1100],
    ]);
    // Every panel's scale is its own, and labeled under it.
    expect(new Set(model.panels().map((p) => p.xGroup)).size).toBe(4);
    expect(labeled(scene)).toEqual([true, true, true, true]);
    expect(titles(scene)).toHaveLength(4);
    // The second row starts below the first row's x labels and titles.
    const [a, , c] = scene.panels as Panel[];
    const [title] = titles(scene);
    expect(title!.y).toBeGreaterThan(a!.plot.y + a!.plot.height + 10);
    expect(c!.plot.y).toBeGreaterThan(title!.y);
    // y is still shared.
    expect(new Set(model.panels().map((p) => p.y.domain.join()))).toHaveLength(1);
  });

  it("share an x scale along rows or columns", () => {
    const rows = build({ marks, facet: grid, resolve: { x: "rows" }, x: { label: "Time" } });
    expect(xOf(rows.model)).toEqual([
      [0, 10],
      [0, 10],
      [1000, 1100],
      [1000, 1100],
    ]);
    expect(labeled(rows.scene)).toEqual([true, true, true, true]);
    // One title per row, centered under it.
    const rowTitles = titles(rows.scene);
    expect(rowTitles).toHaveLength(2);
    const [a, b] = rows.scene.panels as Panel[];
    expect(rowTitles[0]!.x).toBeCloseTo((a!.plot.x + b!.plot.x + b!.plot.width) / 2, 5);
    const columns = build({ marks, facet: grid, resolve: { x: "columns" } });
    // Each column spans both sites; only the lowest panels have labels.
    expect(xOf(columns.model)).toEqual([
      [0, 1100],
      [0, 1100],
      [0, 1100],
      [0, 1100],
    ]);
    expect(labeled(columns.scene)).toEqual([false, false, true, true]);
    expect(new Set(columns.model.panels().map((p) => p.xGroup)).size).toBe(2);
  });

  it("label y fully in rows shortened by x labels and titles between them", () => {
    // Three sites by two kinds of reading: temp spans about -5..25, load 5..35.
    const sites = {
      t: [] as number[],
      v: [] as number[],
      site: [] as string[],
      kind: [] as string[],
    };
    for (const [s, site] of ["A", "B", "C"].entries())
      for (const [k, kind] of ["temp", "load"].entries())
        for (let i = 0; i < 30; i++) {
          sites.t.push(s * 1000 + i * (10 + 40 * s));
          sites.v.push(10 * (k + 1) + Math.cos(i / 4) * 5 * (s + 1));
          sites.site.push(site);
          sites.kind.push(kind);
        }
    const { model, scene } = build(
      {
        marks: [point(table(sites), { x: "t", y: "v" })],
        facet: facet({ row: "site", column: "kind" }),
        resolve: { x: "rows", y: "columns" },
        x: { label: "Seconds" },
      },
      640,
      480,
    );
    // Rows under 100 pixels tall plan two ticks each, at the rounded values.
    expect(model.panels()[0]!.plot.height).toBeLessThan(100);
    const yLabels = scene.panels.map((p) => axis(p, "left")!.ticks.map((t) => t.label));
    expect(yLabels).toEqual([
      ["-20", "0", "20", "40"],
      ["0", "20", "40"],
      ["-20", "0", "20", "40"],
      ["0", "20", "40"],
      ["-20", "0", "20", "40"],
      ["0", "20", "40"],
    ]);
  });

  it("keep scenes of shared x unchanged", () => {
    const plain = build({ marks, facet: grid, x: { label: "Time" } });
    const shared = build({ marks, facet: grid, x: { label: "Time" }, resolve: { x: "shared" } });
    expect(renderToSVG({ marks, facet: grid, width: 600, height: 400, idPrefix: "a" })).toBe(
      renderToSVG({
        marks,
        facet: grid,
        width: 600,
        height: 400,
        idPrefix: "a",
        resolve: { x: "shared" },
      }),
    );
    expect(shared.scene.panels.map((p) => p.plot)).toEqual(plain.scene.panels.map((p) => p.plot));
    expect(titles(plain.scene)).toHaveLength(1);
    expect(plain.model.panels().every((p) => p.xGroup === "")).toBe(true);
  });

  it("take explicit domains, log and time axes, and leave empty panels unlabeled", () => {
    const fixed = build({
      marks,
      facet: grid,
      resolve: { x: "independent" },
      x: { domain: [0, 50] },
    });
    expect(xOf(fixed.model).every(([a, b]) => a === 0 && b === 50)).toBe(true);
    const log = build({
      marks: [line(readings, { x: "t", y: "v" })],
      facet: facet("site"),
      resolve: { x: "independent" },
      x: { type: "log" },
    });
    // Log axes leave out zero: A's panel fits 10 alone.
    expect(log.model.panels()[0]!.x.type).toBe("log");
    expect(Math.min(...log.model.panels()[1]!.x.domain)).toBeGreaterThan(100);
    const day = Date.UTC(2026, 0, 1);
    const times = table({
      when: time([day, day + 3_600_000, day + 86_400_000 * 30, day + 86_400_000 * 31]),
      v: [1, 2, 3, 4],
      site: ["A", "A", "B", "B"],
    });
    const timed = build({
      marks: [line(times, { x: "when", y: "v" })],
      facet: facet("site"),
      resolve: { x: "independent" },
    });
    const [a, b] = timed.model.panels();
    expect(a!.x.type).toBe("time");
    expect(Math.max(...a!.x.domain) - Math.min(...a!.x.domain)).toBeLessThan(86_400_000);
    expect(Math.min(...b!.x.domain)).toBeGreaterThanOrEqual(day + 86_400_000 * 30);
    // A grid's pair without rows has nothing to label along x.
    const sparse = table({
      t: [0, 1, 5, 6],
      v: [1, 2, 3, 4],
      r: ["N", "N", "S", "S"],
      c: ["A", "A", "B", "B"],
    });
    const empty = build({
      marks: [line(sparse, { x: "t", y: "v" })],
      facet: facet({ row: "r", column: "c" }),
      resolve: { x: "independent" },
    });
    expect(labeled(empty.scene)).toEqual([true, false, false, true]);
    expect(empty.scene.panels.map((p) => axis(p, "bottom") !== undefined)).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });

  it("fit a shared y to what each panel shows of its own x", () => {
    // A at 1 then 100 over 0..10, B at 5 throughout 1000..1100.
    const data = table({
      t: [0, 5, 10, 1000, 1100],
      v: [1, 1, 100, 5, 5],
      site: ["A", "A", "A", "B", "B"],
    });
    const { model } = build({
      marks: [line(data, { x: "t", y: "v" })],
      facet: facet("site"),
      resolve: { x: "independent" },
    });
    const top = () => Math.max(...model.panels()[1]!.y.domain);
    expect(top()).toBeGreaterThanOrEqual(100);
    // Zooming A to where it is 1 shrinks the shared y of B's panel too,
    // while B's x stays where it was.
    const bx = [...model.panels()[1]!.x.domain];
    model.setViewport([0, 5], "A");
    model.scene(estimateText);
    expect(top()).toBeLessThan(10);
    expect([...model.panels()[1]!.x.domain]).toEqual(bx);
    expect(model.viewportOf("A")).toEqual([0, 5]);
    expect(model.viewportOf("B")).toBeNull();
  });

  it("keep a viewport per scale, and refuse ambiguous or unknown panels", () => {
    const streamed = table({
      t: [0, 10, 0, 10, 1000, 1100, 1000, 1100],
      v: [1, 2, 3, 4, 10, 20, 30, 40],
      site: ["A", "A", "A", "A", "B", "B", "B", "B"],
      sensor: ["p", "p", "q", "q", "p", "p", "q", "q"],
    });
    const { model } = build({
      marks: [line(streamed, { x: "t", y: "v" })],
      facet: grid,
      resolve: { x: "rows" },
    });
    const [a, b, c] = model.panels().map((p) => p.key);
    model.setViewport([2, 4], b);
    model.scene(estimateText);
    // A row shares its zoom; the other row fits its data.
    expect([...model.panels()[0]!.x.domain]).toEqual([2, 4]);
    expect(model.viewportOf(a)).toEqual([2, 4]);
    expect(model.viewportOf(c)).toBeNull();
    expect(() => model.setViewport([0, 1])).toThrow("need a panel");
    expect(() => model.viewport).toThrow("need a panel");
    expect(() => model.setViewport([0, 1], "nowhere")).toThrow('no panel "nowhere"');
    // Null without a panel fits every scale.
    model.setViewport([1000, 1050], c);
    model.setViewport(null);
    expect([model.viewportOf(a), model.viewportOf(c)]).toEqual([null, null]);
    // A scale whose panels change (another sensor appears) starts over.
    model.setViewport([2, 4], a);
    streamed.append({ t: [5], v: [9], site: ["A"], sensor: ["r"] });
    model.scene(estimateText);
    expect(model.viewportOf(a)).toBeNull();
  });

  it("load from specs of version 3 and check the resolution", () => {
    const spec =
      (resolve: unknown, version: 2 | 3 = 3) =>
      () =>
        loadSpec(
          {
            version,
            data: { t: { columns: { x: [1, 2], y: [1, 2], g: ["a", "b"] } } },
            marks: [{ type: "line", data: "t", x: "x", y: "y" }],
            facet: { field: "g" },
            resolve: resolve as { x: "rows" },
          },
          [],
        );
    expect(spec({ x: "independent" })).not.toThrow();
    expect(spec({ x: "each" })).toThrow("spec.resolve.x");
    // Readers of version 2 would draw shared x scales, so they must refuse it.
    expect(spec({ x: "independent" }, 2)).toThrow(
      'spec.resolve.x: expected a spec with "version": 3',
    );
    expect(spec({ y: "independent" }, 2)).not.toThrow();
    expect(() =>
      loadSpec(
        {
          data: { t: { columns: { x: [1, 2], y: [1, 2] } } },
          marks: [{ type: "line", x: "x", y: "y" }],
          resolve: { x: "independent" },
        },
        [],
      ),
    ).toThrow('spec.resolve: expected a spec with "version": 2 or later');
  });
});

describe("panel groups", () => {
  it("split groups by the groups of another axis, only where panels are in both", () => {
    const data = table({
      t: [0, 1, 2, 3],
      v: [1, 2, 3, 4],
      g: ["a", "b", "c", "d"],
    });
    const layout = facet("g", { columns: 2 });
    const marks = [line(data, { x: "t", y: "v" })];
    const model = new ChartModel({ marks, facet: layout });
    model.setSize(400, 300);
    model.scene(estimateText);
    const split = layout
      .splitter()
      .split(
        model.series().length ? [{ mark: marks[0] as LineMark, series: model.series() }] : [],
        () => {},
        model,
        {},
        { zone: "UTC", locale: undefined, theme: model.theme },
      );
    const byPanel = layout.groups("independent", split, 2, "x");
    expect(byPanel.keys).toEqual(['["a"]', '["b"]', '["c"]', '["d"]']);
    const byRow = layout.groups("rows", split, 2, "y");
    expect(byRow.keys).toEqual(['["a","b"]', '["c","d"]']);
    // Rows by panels: each row has its two panels, and no other pairs.
    const parts = layout.across(split, byRow.groupOf, byPanel.groupOf);
    expect(parts.map((row) => row.map(([h]) => h))).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });
});
