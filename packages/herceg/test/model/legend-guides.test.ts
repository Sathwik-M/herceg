// Legends with settings and legends the guides list: columns and rows,
// titles, entries of your own, swatches as the marks look, one entry for
// the same value across marks, and legends of the scales they name.
import { describe, expect, it } from "vitest";
import { category } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { guideCompiler } from "../../src/guides/compile.ts";
import { legend } from "../../src/guides/options.ts";
import { estimateText } from "../../src/layout/text.ts";
import { area } from "../../src/marks/area.ts";
import { heatmap } from "../../src/marks/heatmap.ts";
import { line } from "../../src/marks/line.ts";
import { point } from "../../src/marks/point.ts";
import { region } from "../../src/marks/region.ts";
import { describeChart } from "../../src/model/describe.ts";
import { GUIDE_KIT } from "../../src/model/guides.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { panels } from "../../src/model/panels.ts";
import { renderSvg } from "../../src/render/svg.ts";
import {
  type CaptionGuide,
  guidesOf,
  type LegendItem,
  type RampItem,
  type RectItem,
  type Scene,
  type SegmentsItem,
  type ShapeItem,
  type TextItem,
} from "../../src/scene/scene.ts";

const guides = guideCompiler(GUIDE_KIT);

function build(config: ChartConfig, width = 640, height = 360) {
  const model = new ChartModel({ locale: "en-US", ...config }, undefined, guides);
  model.setSize(width, height, 1);
  return { model, scene: model.scene(estimateText) };
}

const sites = ["North", "South", "East", "West", "Central", "Coast"] as const;
const wide = table({
  t: [0, 1, 2],
  North: [0, 1, 2],
  South: [1, 2, 3],
  East: [2, 3, 4],
  West: [3, 4, 5],
  Central: [4, 5, 6],
  Coast: [5, 6, 7],
});
const lines = [line(wide, { x: "t", y: [...sites] })];
const entriesOf = (scene: Scene): LegendItem[] =>
  guidesOf(scene, "legend").flatMap((g) => [...g.entries]);
const captionText = (scene: Scene) =>
  guidesOf(scene, "caption")
    .flatMap((g: CaptionGuide) => g.items)
    .filter((item): item is TextItem => item.type === "text")
    .map((item) => item.text);

describe("legend layout", () => {
  it("keep the asked count of rows or columns in either order", () => {
    const four = [line(wide, { x: "t", y: [...sites].slice(0, 4) })];
    const shape = (legend: object) => {
      const entries = entriesOf(build({ marks: four, legend }).scene);
      return [new Set(entries.map((e) => e.x)).size, new Set(entries.map((e) => e.y)).size];
    };
    expect(shape({ rows: 3, order: "row" })[1]).toBe(3);
    expect(shape({ columns: 3, order: "column" })[0]).toBe(3);
    expect(shape({ columns: 3 })).toEqual([3, 2]);
  });

  it("fill a count of rows down each column, as many rows as asked", () => {
    const { scene } = build({
      marks: [line(wide, { x: "t", y: [...sites].slice(0, 4) })],
      legend: { rows: 3 },
    });
    const rows = new Set(entriesOf(scene).map((e) => e.y));
    expect(rows.size).toBe(3);
    const columns = new Set(entriesOf(scene).map((e) => e.x));
    expect(columns.size).toBe(2);
  });

  it("puts entries in columns, filled row by row, under the plots", () => {
    const { scene } = build({ marks: lines, legend: { place: { side: "bottom" }, columns: 3 } });
    const entries = entriesOf(scene);
    expect(entries.map((e) => e.label)).toEqual(sites);
    const xs = [...new Set(entries.map((e) => e.x))];
    const ys = [...new Set(entries.map((e) => e.y))];
    expect(xs.length).toBe(3);
    expect(ys.length).toBe(2);
    // Row by row: the second entry is in the first row's second column.
    expect(entries[1]!.y).toBe(entries[0]!.y);
    expect(entries[3]!.x).toBe(entries[0]!.x);
    expect(entries[0]!.y).toBeGreaterThan(scene.panels[0]!.plot.y + scene.panels[0]!.plot.height);
  });

  it("fills down each column, or into a number of rows", () => {
    const down = entriesOf(build({ marks: lines, legend: { columns: 3, order: "column" } }).scene);
    expect(down[1]!.x).toBe(down[0]!.x);
    expect(down[2]!.x).toBeGreaterThan(down[0]!.x);
    const rows = entriesOf(build({ marks: lines, legend: { rows: 3 } }).scene);
    expect(new Set(rows.map((e) => e.y)).size).toBe(3);
  });

  it("writes a title above the entries", () => {
    const { scene } = build({ marks: lines, legend: { title: "Sites", place: { side: "right" } } });
    expect(captionText(scene)).toEqual(["Sites"]);
    const title = guidesOf(scene, "caption")[0]!.items[0] as TextItem;
    expect(entriesOf(scene)[0]!.y).toBeGreaterThan(title.y);
  });

  it("keeps the default legend's look where settings change nothing", () => {
    const plain = build({ marks: lines });
    const placed = build({ marks: lines, legend: { place: { side: "top" } }, guides: [] });
    expect(renderSvg(placed.scene, { idPrefix: "a" })).toBe(
      renderSvg(plain.scene, { idPrefix: "a" }),
    );
  });
});

describe("swatches as the marks look", () => {
  const data = table({ t: [0, 1, 2], a: [1, 2, 3], b: [2, 3, 1], c: [3, 1, 2] });

  it("draw a dashed line, an area's fill, and a point's symbol", () => {
    const { scene } = build({
      marks: [
        line(data, { x: "t", y: "a", dash: "--", strokeWidth: 2 }),
        area(data, { x: "t", y: "b" }),
        point(data, { x: "t", y: "c" }),
      ],
      legend: { swatches: "mark" },
    });
    const [dashed, filled, symbol] = entriesOf(scene);
    const stroke = dashed!.sample!.items[0]!;
    expect(stroke.type).toBe("segments");
    expect(stroke.type === "segments" && stroke.paint.dash.length).toBe(2);
    const fill = filled!.sample!.items[0]!;
    expect(fill.type === "rect" && fill.opacity).toBe(0.25);
    expect(symbol!.sample!.items[0]!.type).toBe("shape");
  });
});

describe("one entry for the same value across marks", () => {
  const a = table({ t: [0, 1], site: ["North", "South"], v: [1, 2] });
  const b = table({ t: [0, 1], site: ["North", "South"], v: [3, 4] }, { origin: a });
  const subplots = (second = b) => ({
    panels: panels([{ id: "a" }, { id: "b" }], { columns: 2 }),
    marks: [
      line(a, { x: "t", y: "v", series: "site", panel: "a" }),
      area(second, { x: "t", y: "v", series: "site", panel: "b" }),
    ],
    legend: { swatches: "mark" as const },
  });

  it("lists each site once, toggling its series in every panel, with each mark's look", () => {
    const merged = build(subplots());
    const entries = entriesOf(merged.scene);
    expect(entries.map((e) => e.label)).toEqual(["North", "South"]);
    // The area's box under the line's stroke, in the site's one color.
    expect(entries[0]!.sample!.items.map((item) => item.type)).toEqual(["rect", "segments"]);
    merged.model.hidden.add(entries[0]!.key);
    const hidden = merged.model.scene(estimateText);
    expect(entriesOf(hidden)[0]!.hidden).toBe(true);
    expect(hidden.panels.map((panel) => panel.marks.length)).toEqual([1, 1]);
    // Tables that only share a field's name stay apart.
    const other = table({ t: [0, 1], site: ["North", "South"], v: [3, 4] });
    expect(entriesOf(build(subplots(other)).scene)).toHaveLength(4);
  });
});

describe("legends of the scales they name", () => {
  const data = table({ t: [0, 1, 2], a: [1, 2, 3], b: [3, 2, 1] });
  const marks = [
    line(data, { x: "t", y: "a", id: "first" }),
    line(data, { x: "t", y: "b", id: "second" }),
  ];

  it("show their scales, leaving the rest to the automatic legend", () => {
    const { scene } = build({
      marks,
      guides: [
        legend({ scales: [{ mark: "second", channel: "series" }], place: { side: "right" } }),
      ],
    });
    const [automatic, listed] = guidesOf(scene, "legend");
    expect(automatic!.entries.map((e) => e.label)).toEqual(["a"]);
    expect(listed!.entries.map((e) => e.label)).toEqual(["b"]);
    expect(listed!.entries[0]!.x).toBeGreaterThan(
      scene.panels[0]!.plot.x + scene.panels[0]!.plot.width,
    );
  });

  it("show everything when they name nothing, in place of the automatic legend", () => {
    const { scene } = build({ marks, guides: [legend({ place: { side: "bottom" }, columns: 2 })] });
    expect(guidesOf(scene, "legend").map((g) => g.entries.length)).toEqual([2]);
  });

  it("leave out marks with legend: false", () => {
    const { scene } = build({
      marks: [
        marks[0]!,
        line(data, { x: "t", y: "b", legend: false }),
        line(data, { x: "t", y: "a", label: "c" }),
      ],
    });
    expect(entriesOf(scene).map((e) => e.label)).toEqual(["a", "c"]);
  });

  it("show a chart of one series, which the automatic legend leaves out", () => {
    const one = [line(data, { x: "t", y: "a" })];
    expect(entriesOf(build({ marks: one }).scene)).toEqual([]);
    const { scene } = build({ marks: one, guides: [legend({ place: { side: "bottom" } })] });
    expect(entriesOf(scene).map((e) => e.label)).toEqual(["a"]);
    // Without the automatic legend, the listed ones still show the series.
    const off = build({ marks, legend: false, guides: [legend({ place: { side: "bottom" } })] });
    expect(entriesOf(off.scene).map((e) => e.label)).toEqual(["a", "b"]);
  });

  it("claim a scale marks share, which the automatic legend then leaves out", () => {
    const cells = table({ x: [0, 1, 0, 1], y: category(["a", "a", "b", "b"]), v: [1, 2, 3, 4] });
    const { scene } = build({
      marks: [
        heatmap(cells, { x: "x", y: "y", color: "v", id: "a" }),
        heatmap(cells, { x: "x", y: "y", color: "v", id: "b" }),
      ],
      guides: [legend({ scales: [{ mark: "b", channel: "color" }], place: { side: "bottom" } })],
    });
    const ramps = guidesOf(scene, "ramp");
    expect(ramps).toHaveLength(1);
    // Under the plot, where the listed legend is.
    const ramp = ramps[0]!.items.find((item): item is RampItem => item.type === "ramp")!;
    const plot = scene.panels[0]!.plot;
    expect(ramp.y).toBeGreaterThan(plot.y + plot.height);
  });

  it("keep a legend's id apart from another's place in the list", () => {
    const { scene } = build({
      marks,
      guides: [
        legend({ id: "1", title: "Named", place: { side: "bottom" } }),
        legend({ title: "Second", place: { side: "bottom" } }),
      ],
    });
    const titles = guidesOf(scene, "caption")
      .flatMap((g) => g.items)
      .filter((item): item is TextItem => item.type === "text");
    expect(titles.map((t) => t.text).sort()).toEqual(["Named", "Second"]);
    expect(titles[0]!.y).not.toBe(titles[1]!.y);
  });

  it("show a mark's key of sizes by its channel, whatever its field is called", () => {
    const sized = table({ t: [0, 1, 2], v: [1, 2, 3], "size|units": [1, 5, 9] });
    const { scene } = build({
      marks: [point(sized, { x: "t", y: "v", size: "size|units", id: "p" })],
      legend: false,
      guides: [legend({ scales: [{ mark: "p", channel: "size" }] })],
    });
    expect(guidesOf(scene, "key")).toHaveLength(1);
  });

  it("lay keys' entries out in the legend's grid", () => {
    const shapes = table({
      t: [0, 1, 2, 3, 4, 5],
      v: [1, 2, 3, 4, 5, 6],
      kind: category(["a", "b", "c", "d", "e", "f"]),
    });
    const { scene } = build({
      marks: [point(shapes, { x: "t", y: "v", symbol: "kind", id: "p" })],
      legend: { columns: 2 },
    });
    const key = guidesOf(scene, "key")[0]!;
    const rows = new Set(key.entries.map((e) => e.y));
    // Glyphs center on their own sizes: columns are a few pixels wide.
    const columns = new Set(key.entries.map((e) => Math.round(e.x / 10)));
    expect(rows.size).toBe(3);
    expect(columns.size).toBe(2);
  });

  it("refuse a mark id no mark has", () => {
    expect(() =>
      build({ marks, guides: [legend({ scales: [{ mark: "third", channel: "series" }] })] }),
    ).toThrow('chart guides[0].scales[0]: no mark has id "third"; give the mark id: "third"');
  });
});

describe("entries of your own", () => {
  const data = table({ t: [0, 1, 2], v: [1, 2, 3] });

  it("explain a swatch, or toggle the marks they target", () => {
    const { scene, model } = build({
      marks: [line(data, { x: "t", y: "v", id: "trend" })],
      legend: {
        entries: [
          { key: "band", label: "Maintenance", swatch: { type: "rect", fill: "#eeeeee" } },
          { key: "trend", label: "Trend", sample: { mark: "trend" }, targets: [{ mark: "trend" }] },
        ],
      },
    });
    // An entry that toggles nothing is drawn, not a button, and described.
    expect(captionText(scene)).toEqual(["Maintenance"]);
    expect(describeChart(model)).toContain("The legend: Maintenance.");
    const [trend] = entriesOf(scene);
    expect(trend!.label).toBe("Trend");
    expect(trend!.targets).toHaveLength(1);
  });

  it("draw circles of their size and outlined boxes", () => {
    const { scene } = build({
      marks: [line(data, { x: "t", y: "v" })],
      legend: {
        entries: [
          { key: "big", label: "Big", swatch: { type: "circle", fill: "#ff0000", size: 16 } },
          {
            key: "box",
            label: "Box",
            swatch: { type: "rect", fill: "#ffffff", stroke: "#000000" },
          },
        ],
      },
    });
    const items = guidesOf(scene, "caption").flatMap((g) => g.items);
    const shapes = items.filter((item): item is ShapeItem => item.type === "shape");
    expect(shapes).toHaveLength(2);
    expect(shapes[0]!.d).toContain("a8,8");
    expect(shapes[1]).toMatchObject({ fill: "#ffffff", stroke: "#000000" });
    // Labels clear the wider swatch.
    const big = items.find(
      (item): item is TextItem => item.type === "text" && item.text === "Big",
    )!;
    expect(big.x - shapes[0]!.at[0]).toBeGreaterThan(8);
  });

  it("draw a point mark's sample with its symbol, and fade hidden samples by their own opacity", () => {
    const points = table({ t: [0, 1], v: [1, 2] });
    const { scene, model } = build({
      marks: [
        point(points, { x: "t", y: "v", id: "p", symbol: "diamond" } as never),
        area(points, { x: "t", y: "v", id: "a" }),
      ],
      legend: {
        swatches: "mark",
        entries: [
          { key: "p", label: "Points", sample: { mark: "p" }, targets: [{ mark: "p" }] },
          { key: "a", label: "Area", sample: { mark: "a" }, targets: [{ mark: "a" }] },
        ],
      },
    });
    const [p, a] = entriesOf(scene);
    expect(p!.sample!.items[0]).toMatchObject({ type: "shape" });
    expect((p!.sample!.items[0] as ShapeItem).d).not.toContain("a");
    model.hidden.add(a!.targets?.[0] ?? a!.key);
    const hidden = guidesOf(model.scene(estimateText), "legend")[0]!.items.find(
      (item): item is RectItem => item.type === "rect",
    )!;
    expect(hidden.opacity).toBeCloseTo(0.25 * 0.4, 5);
  });

  it("draw annotations' samples as they look, and refuse to toggle them", () => {
    const zone = region({ x1: 0, x2: 1, fill: "#ff0000", id: "zone" });
    const { scene, model } = build({
      marks: [line(data, { x: "t", y: "v" }), zone],
      legend: { entries: [{ key: "z", label: "Maintenance", sample: { mark: "zone" } }] },
    });
    const box = guidesOf(scene, "caption")
      .flatMap((g) => g.items)
      .find((item): item is RectItem => item.type === "rect")!;
    expect(box).toMatchObject({ fill: "#ff0000", opacity: 0.15 });
    expect(describeChart(model)).toContain("The legend: Maintenance.");
    expect(() =>
      build({
        marks: [line(data, { x: "t", y: "v" }), zone],
        legend: { entries: [{ key: "z", label: "Maintenance", targets: [{ mark: "zone" }] }] },
      }),
    ).toThrow(
      'chart legend.entries[0].targets[0].mark: mark "zone" is an annotation, which has no series to hide and show; target marks with series, or drop the target',
    );
  });

  it("give rows the height of their tallest swatch", () => {
    const { scene } = build({
      marks: [line(data, { x: "t", y: "v" })],
      legend: {
        columns: 1,
        entries: [
          { key: "big", label: "Big", swatch: { type: "circle", fill: "#ff0000", size: 40 } },
          { key: "small", label: "Small", swatch: { type: "rect", fill: "#0000ff" } },
          {
            key: "thick",
            label: "Thick",
            swatch: { type: "line", stroke: "#000000", strokeWidth: 30 },
          },
        ],
      },
    });
    const items = guidesOf(scene, "caption").flatMap((g) => g.items);
    const thick = items.find((item): item is SegmentsItem => item.type === "segments")!;
    const big = items.find((item): item is ShapeItem => item.type === "shape")!;
    const small = items.find((item): item is RectItem => item.type === "rect")!;
    // Inside the chart, and rows apart by the circle's height at least.
    expect(big.at[1] - 20).toBeGreaterThanOrEqual(0);
    expect(small.y + 5 - big.at[1]).toBeGreaterThanOrEqual(40);
    expect(thick.coords[1]! - (small.y + 5)).toBeGreaterThanOrEqual(30);
  });
});
