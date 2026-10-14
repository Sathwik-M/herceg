// Range navigators in the model: the strip's layout, its overview of the
// marks over the whole x domain, the window, caching, breaks, refusals, and
// specs.
import { describe, expect, it } from "vitest";
import { time } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { area } from "../../src/marks/area.ts";
import { bar } from "../../src/marks/bar.ts";
import { candlestick } from "../../src/marks/candlestick.ts";
import { errorBar } from "../../src/marks/errorbar.ts";
import { line } from "../../src/marks/line.ts";
import { pie } from "../../src/marks/pie.ts";
import { point } from "../../src/marks/point.ts";
import { rule } from "../../src/marks/rule.ts";
import { describeChart } from "../../src/model/describe.ts";
import { facet } from "../../src/model/facet.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { NAVIGATOR_PANEL, Navigator, rangeNavigator } from "../../src/model/navigator.ts";
import { panels } from "../../src/model/panels.ts";
import { renderToPDF } from "../../src/pdf.ts";
import { renderToSVG } from "../../src/render/static.ts";
import { timeBreaks } from "../../src/scale/breaks.ts";
import type {
  LineGeometry,
  Panel,
  PointGeometry,
  Scene,
  ShapesGeometry,
  TextGeometry,
} from "../../src/scene/scene.ts";
import { loadSpec } from "../../src/spec/load.ts";
import type { ChartSpec } from "../../src/spec/spec.ts";
import { validateSpec } from "../../src/spec/validate.ts";
import { headersOf } from "../helpers/guides.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function build(config: ChartConfig, width = 600, height = 300) {
  const model = new ChartModel({ locale: "en-US", timeZone: "UTC", ...config });
  model.setSize(width, height, 1);
  return { model, scene: model.scene(estimateText) };
}

function waves(n: number, step = 1) {
  return table({
    t: Float64Array.from({ length: n }, (_, i) => i * step),
    a: Float64Array.from({ length: n }, (_, i) => Math.sin(i / 50) * 10 + 20),
    b: Float64Array.from({ length: n }, (_, i) => Math.cos(i / 80) * 5 + 10),
  });
}

const stripOf = (scene: Scene): Panel => {
  const strip = scene.panels.find(({ key }) => key === NAVIGATOR_PANEL);
  if (!strip) throw new Error("no strip");
  return strip;
};
const windowOf = (strip: Panel) =>
  strip.marks.find(({ key }) => key === "navigator-frame") as ShapesGeometry;

describe("a navigator's strip", () => {
  it("takes room under the x axis, below its title, across the plot's width", () => {
    const data = waves(200);
    const marks = [line(data, { x: "t", y: "a" })];
    const without = build({ marks, x: { title: "Time" } });
    const { model, scene } = build({ marks, x: { title: "Time" }, navigator: rangeNavigator() });
    const [plot] = model.panels();
    const before = without.model.panels()[0]!.plot;
    // 40 pixels of strip, 10 above it and 2 under it.
    expect(before.height - plot!.plot.height).toBe(52);
    expect(scene.panels).toHaveLength(2);
    const strip = stripOf(scene);
    expect(strip.plot).toEqual({
      x: plot!.plot.x,
      y: 300 - 2 - 40,
      width: plot!.plot.width,
      height: 40,
    });
    // The x title moves up with the axis, above the strip.
    const title = scene.panels[0]!.axes.find((axis) => axis.side === "bottom")!.title!;
    expect(title.y).toBeLessThan(strip.plot.y);
    expect(title.y).toBe(
      without.scene.panels[0]!.axes.find((a) => a.side === "bottom")!.title!.y - 52,
    );
    // The strip is not a panel the chart inspects, zooms, or reports.
    expect(model.panels()).toHaveLength(1);
    expect(model.inspect(strip.plot.x + 10, strip.plot.y + 10)).toBeUndefined();
  });

  it("takes at most a third of the plot's room, less to leave the plot 30 pixels, or stays out", () => {
    const data = waves(20);
    const marks = [line(data, { x: "t", y: "a" })];
    const tall = build({ marks, navigator: rangeNavigator({ height: 64 }) });
    expect(stripOf(tall.scene).plot.height).toBe(64);
    // A short chart's strip is shorter, and never covers the plot or its labels.
    for (const height of [160, 180, 200]) {
      const { model, scene } = build(
        { marks, title: "Short", x: { title: "Time" }, navigator: rangeNavigator() },
        600,
        height,
      );
      const plot = model.panels()[0]!.plot;
      const strip = stripOf(scene).plot;
      expect(strip.height).toBeGreaterThanOrEqual(16);
      expect(strip.height).toBeLessThanOrEqual(40);
      expect(plot.height).toBeGreaterThanOrEqual(30);
      const title = scene.panels[0]!.axes.find((axis) => axis.side === "bottom")!.title!;
      expect(plot.y + plot.height).toBeLessThan(title.y);
      expect(title.y).toBeLessThan(strip.y);
    }
    // A third would leave the plot less than 30 pixels: the strip is shorter.
    const short = build(
      { marks, title: "Short", x: { title: "Time" }, navigator: rangeNavigator() },
      600,
      140,
    );
    expect(short.model.panels()[0]!.plot.height).toBe(30);
    expect(stripOf(short.scene).plot.height).toBe(19);
    // Too short for both, the chart has no strip.
    const tiny = build(
      { marks, title: "Tiny", x: { title: "Time" }, navigator: rangeNavigator() },
      600,
      135,
    );
    expect(tiny.scene.panels.map(({ key }) => key)).toEqual([""]);
    expect(describeChart(tiny.model)).not.toContain("range navigator");
  });

  it("draws every line, area, bar, point, and candlestick mark, but no annotations", () => {
    const data = waves(100);
    const prices = table({ t: [0, 1, 2], o: [1, 2, 3], h: [2, 3, 4], l: [0, 1, 2], c: [2, 1, 4] });
    const { scene } = build({
      marks: [
        line(data, { x: "t", y: "a" }),
        area(data, { x: "t", y: "b" }),
        bar(data, { x: "t", y: "b" }),
        point(data, { x: "t", y: "a" }),
        candlestick(prices, { x: "t", open: "o", high: "h", low: "l", close: "c" }),
        rule({ y: 15 }),
      ],
      navigator: rangeNavigator(),
    });
    const kinds = stripOf(scene).marks.map(({ kind }) => kind);
    // Candlesticks are wicks and bodies, rising and falling ones apart.
    expect(kinds).toEqual([
      ...["line", "area", "rect", "point", "segments", "segments", "rect"],
      ...["shapes", "text"],
    ]);
  });

  it("draws only the marks it names, or none", () => {
    const data = waves(100);
    const marks = [
      line(data, { x: "t", y: "a", id: "a" }),
      line(data, { x: "t", y: "b", id: "b" }),
    ];
    const named = build({ marks, navigator: rangeNavigator({ marks: ["b"] }) }).scene;
    const lines = stripOf(named).marks.filter(({ kind }) => kind === "line");
    expect(lines.map(({ key }) => key)).toEqual([JSON.stringify(["b", "b"])]);
    const none = build({ marks, navigator: rangeNavigator({ marks: [] }) }).scene;
    expect(stripOf(none).marks.map(({ kind }) => kind)).toEqual(["shapes", "text"]);
  });

  it("reduces a million points to a few per pixel column of the strip", () => {
    const n = 1_000_000;
    const big = table({
      t: Float64Array.from({ length: n }, (_, i) => i),
      v: Float64Array.from({ length: n }, (_, i) => Math.sin(i / 1000) + Math.sin(i * 7.1)),
    });
    const { scene } = build({
      marks: [line(big, { x: "t", y: "v" })],
      navigator: rangeNavigator(),
    });
    const strip = stripOf(scene);
    const overview = strip.marks.find(({ kind }) => kind === "line") as LineGeometry;
    expect(overview.path.count).toBeGreaterThan(strip.plot.width);
    expect(overview.path.count).toBeLessThanOrEqual(4 * Math.ceil(strip.plot.width + 2));
  });

  it("samples points to one per pixel of the strip", () => {
    const n = 200_000;
    const cloud = table({
      x: Float64Array.from({ length: n }, (_, i) => (i * 7919) % 1000),
      y: Float64Array.from({ length: n }, (_, i) => (i * 104729) % 997),
    });
    const { scene } = build({
      marks: [point(cloud, { x: "x", y: "y" })],
      navigator: rangeNavigator(),
    });
    const strip = stripOf(scene);
    const sample = strip.marks.find(({ kind }) => kind === "point") as PointGeometry;
    expect(sample.count).toBeGreaterThan(1000);
    expect(sample.count).toBeLessThanOrEqual(
      Math.ceil(strip.plot.width) * Math.ceil(strip.plot.height),
    );
    // What it holds is bounded too, with room for the pool to grow into.
    const pixels = Math.ceil(strip.plot.width) * Math.ceil(strip.plot.height);
    expect(sample.coords.length).toBeLessThanOrEqual(1.5 * 2 * pixels);
  });

  it("draws into buffers of its own, and its overview stays as the view changes", () => {
    const data = waves(5000);
    const { model, scene } = build({
      marks: [line(data, { x: "t", y: "a" })],
      // No x labels to pass the plot's end, and fixed y labels: the margins,
      // and so the strip, stay where they are as the view changes.
      x: { show: false },
      y: { domain: [0, 40] },
      navigator: rangeNavigator(),
    });
    const main = scene.panels[0]!.marks[0] as LineGeometry;
    const overview = stripOf(scene).marks[0] as LineGeometry;
    expect(overview.path).not.toBe(main.path);
    const drawn = Float32Array.from(overview.path.coords.subarray(0, overview.path.count * 2));
    model.setViewport([1000, 2000]);
    const zoomed = model.scene(estimateText);
    // The same overview, unchanged by the plot drawing its own line again.
    expect(stripOf(zoomed).marks[0]).toBe(overview);
    expect(overview.path.coords.subarray(0, overview.path.count * 2)).toEqual(drawn);
    expect((zoomed.panels[0]!.marks[0] as LineGeometry).path).toBe(main.path);
    // New data draws it again.
    data.append({ t: [5000], a: [100], b: [0] });
    expect(stripOf(model.scene(estimateText)).marks[0]).not.toBe(overview);
  });

  it("shows the plot's x range as its window, fading what is outside", () => {
    const data = waves(1001);
    const { model, scene } = build({
      marks: [line(data, { x: "t", y: "a" })],
      navigator: rangeNavigator(),
    });
    const strip = stripOf(scene);
    // Unzoomed, the window is the whole strip: nothing is faded.
    expect(windowOf(strip).shapes.filter((s) => "d" in s && s.opacity < 1)).toHaveLength(0);
    model.setViewport([250, 500]);
    const zoomed = stripOf(model.scene(estimateText));
    const faded = windowOf(zoomed).shapes.filter((s) => "d" in s && s.opacity < 1);
    expect(faded).toHaveLength(2);
    const { x, width } = zoomed.plot;
    const at = (value: number) => x + (value / 1000) * width;
    const box = (d: string) => d.match(/-?[\d.]+/g)!.map(Number);
    expect(box((faded[0] as { d: string }).d)[2]).toBeCloseTo(at(250), 0);
    expect(box((faded[1] as { d: string }).d)[0]).toBeCloseTo(at(500), 0);
  });

  it("plans the whole x domain as the unzoomed plot does, and keeps it while zoomed", () => {
    const data = waves(997);
    const { model, scene } = build({
      marks: [line(data, { x: "t", y: "a" })],
      // No x labels to pass the plot's end, and fixed y labels: the margins,
      // and so the strip, stay where they are as the view changes.
      x: { show: false },
      y: { domain: [0, 40] },
      navigator: rangeNavigator(),
    });
    const unzoomed = model.panels()[0]!.x.domain;
    const labels = (strip: Panel) => (strip.marks.at(-1) as TextGeometry).labels;
    const before = labels(stripOf(scene));
    model.setViewport([100, 200]);
    const strip = stripOf(model.scene(estimateText));
    expect(labels(strip)).toEqual(before);
    expect(strip.grid.x).toEqual(stripOf(scene).grid.x);
    expect(unzoomed).toEqual([0, 996]);
  });

  it("widens to hold a view reaching past the data", () => {
    const data = waves(101);
    const { model } = build({
      marks: [line(data, { x: "t", y: "a" })],
      navigator: rangeNavigator(),
    });
    model.setViewport([50, 400]);
    const strip = stripOf(model.scene(estimateText));
    const { x, width } = strip.plot;
    const shapes = windowOf(strip).shapes.filter((s) => "d" in s && s.opacity < 1);
    // Only the part before 50 is faded: the window reaches the strip's end.
    expect(shapes).toHaveLength(1);
    const ends = (shapes[0] as { d: string }).d.match(/-?[\d.]+/g)!.map(Number);
    expect(ends[0]).toBe(x);
    expect(ends[2]).toBeCloseTo(x + (50 / 400) * width, 0);
  });

  it("measures y over the whole x domain, from zero for bars and areas", () => {
    const data = table({ t: [0, 1, 2, 3], v: [5, 8, 6, 7] });
    const { model } = build({
      marks: [bar(data, { x: "t", y: "v" })],
      navigator: rangeNavigator(),
    });
    model.setViewport([1.5, 3.5]);
    const strip = stripOf(model.scene(estimateText));
    const bars = strip.marks.find(({ kind }) => kind === "rect")!;
    const rects = bars as unknown as { rects: Float32Array; count: number };
    expect(rects.count).toBe(4);
    // The tallest bar, 8, reaches the top of the strip's room; zero is its bottom.
    const tops = Array.from({ length: 4 }, (_, i) => rects.rects[i * 4 + 1]!);
    expect(Math.min(...tops)).toBeCloseTo(strip.plot.y + 3, 0);
  });

  it("follows the x axis' breaks", () => {
    const start = Date.UTC(2025, 9, 6); // a Monday
    const t: number[] = [];
    for (let d = 0; d < 28; d++) {
      const day = new Date(start + d * DAY).getUTCDay();
      if (day !== 0 && day !== 6)
        for (let h = 0; h < 24; h += 6) t.push(start + d * DAY + h * HOUR);
    }
    const prices = table({ t: time(t), v: t.map((_, i) => i) });
    const { model, scene } = build({
      marks: [line(prices, { x: "t", y: "v" })],
      x: { breaks: timeBreaks([{ weekdays: ["sat", "sun"] }]) },
      navigator: rangeNavigator(),
    });
    const strip = stripOf(scene);
    const overview = strip.marks[0] as LineGeometry;
    // Weekends take no room: the line rises evenly across the strip.
    const xs = Array.from({ length: overview.path.count }, (_, i) => overview.path.coords[i * 2]!);
    const steps = xs.slice(1).map((x, i) => x - xs[i]!);
    expect(Math.max(...steps) / Math.min(...steps.filter((s) => s > 0))).toBeLessThan(1.5);
    // A window over a week of trading spans a fifth of a four-week strip.
    model.setViewport([start + 7 * DAY, start + 12 * DAY]);
    const faded = windowOf(stripOf(model.scene(estimateText))).shapes.filter(
      (s) => "d" in s && s.opacity < 1,
    ) as { d: string }[];
    const [left, right] = faded.map(({ d }) => d.match(/-?[\d.]+/g)!.map(Number));
    const shown = right![0]! - left![2]!;
    expect(shown / strip.plot.width).toBeGreaterThan(0.2);
    expect(shown / strip.plot.width).toBeLessThan(0.3);
  });

  it("has no labels without data, as the x axis has none", () => {
    const empty = table({ t: time([]), v: [] as number[] });
    const strip = stripOf(
      build({ marks: [line(empty, { x: "t", y: "v" })], navigator: rangeNavigator() }).scene,
    );
    expect(strip.grid.x).toEqual([]);
    expect(strip.marks.map(({ kind }) => kind)).toEqual(["line", "shapes"]);
  });

  it("labels its ticks once data arrives, whatever it draws", () => {
    const data = table({ t: [] as number[], v: [] as number[] });
    const { scene } = build({
      marks: [line(data, { x: "t", y: "v" })],
      x: { show: false, domain: [0, 1] },
      y: { show: false },
      navigator: rangeNavigator({ marks: [] }),
    });
    expect(stripOf(scene).grid.x.length).toBeGreaterThan(0);
    const unset = build({
      marks: [line(data, { x: "t", y: "v" })],
      x: { show: false },
      y: { show: false },
      navigator: rangeNavigator({ marks: [] }),
    });
    expect(stripOf(unset.scene).grid.x).toEqual([]);
    data.append({ t: [0, 1], v: [1, 2] });
    expect(stripOf(unset.model.scene(estimateText)).grid.x.length).toBeGreaterThan(0);
  });

  it("samples points on the strip's ends, on any axis, and none past them", () => {
    const edges = table({ x: [0, 1, 2], y: [1, 2, 3] });
    for (const x of [
      { domain: [0, 1] },
      { domain: [1, 0] },
      { type: "log", domain: [1, 2] },
    ] as const) {
      const { scene } = build({
        marks: [point(edges, { x: "x", y: "y" })],
        x,
        navigator: rangeNavigator(),
      });
      const sample = stripOf(scene).marks.find(({ kind }) => kind === "point") as PointGeometry;
      // Both points on the domain's ends; 2 lies past [0, 1], and 0 off a log axis.
      expect(sample.count).toBe(2);
    }
  });

  it("samples points on decimal domains' ends, which pixels may round past", () => {
    const ends = table({ x: [0.1, 3, 3.0001], y: [1, 2, 3] });
    const axes = [
      [{ domain: [0.1, 3] }, 500],
      [{ domain: [3, 0.1] }, 500],
      [{ type: "log", domain: [0.1, 3] }, 517],
    ] as const;
    for (const [x, width] of axes) {
      const { scene } = build(
        { marks: [point(ends, { x: "x", y: "y" })], x, navigator: rangeNavigator() },
        width,
      );
      const sample = stripOf(scene).marks.find(({ kind }) => kind === "point") as PointGeometry;
      // Both ends, and not the point just past the domain.
      expect(sample.count).toBe(2);
    }
  });

  it("leaves out labels a strip is too short for", () => {
    const data = waves(100);
    const { scene } = build({
      marks: [line(data, { x: "t", y: "a" })],
      theme: { style: { text: { fontSize: 24 } } },
      navigator: rangeNavigator({ height: 16 }),
    });
    const strip = stripOf(scene);
    expect(strip.grid.x.length).toBeGreaterThan(0);
    expect(strip.marks.some(({ kind }) => kind === "text")).toBe(false);
  });

  it("draws sampled points as the squares PDF export draws them", () => {
    const cloud = table({ x: [0, 1, 2], y: [0, 1, 4] });
    const { scene } = build({
      marks: [point(cloud, { x: "x", y: "y" })],
      navigator: rangeNavigator(),
    });
    const sample = stripOf(scene).marks.find(({ kind }) => kind === "point") as PointGeometry;
    expect(sample.symbol).toBe("square");
    // A square symbol of radius r is r·√π wide.
    expect(sample.radius * Math.sqrt(Math.PI)).toBeCloseTo(1.5, 9);
    expect(sample.draw.svg(sample, { theme: scene.theme, encodeRaster: undefined })).toContain(
      "h1.5v1.5h-1.5z",
    );
  });

  it("gives marks on the right axis a y scale of their own, and stacks areas as the plot does", () => {
    const data = table({
      t: [0, 1, 2, 3],
      a: [1, 2, 3, 4],
      b: [1000, 3000, 2000, 4000],
      c: [2, Number.NaN, 2, 2],
    });
    const { scene } = build({
      marks: [
        line(data, { x: "t", y: "a" }),
        line(data, { x: "t", y: "b", axis: "right" }),
        area(data, { x: "t", y: ["a", "c"], stack: true }),
      ],
      navigator: rangeNavigator(),
    });
    const strip = stripOf(scene);
    const [left, right] = strip.marks.filter(({ kind }) => kind === "line") as LineGeometry[];
    const ys = (g: LineGeometry) =>
      Array.from({ length: g.path.count }, (_, i) => g.path.coords[i * 2 + 1]!);
    // Each line spans much of the strip on its own scale: on one scale, the
    // thousands on the right would flatten the left's ones.
    expect(Math.max(...ys(right!)) - Math.min(...ys(right!))).toBeGreaterThan(
      strip.plot.height / 2,
    );
    expect(Math.max(...ys(left!)) - Math.min(...ys(left!))).toBeGreaterThan(strip.plot.height / 4);
    // The stacked areas' gap is drawn as the plot draws it: as many runs.
    const runs = (panel: Panel) =>
      panel.marks
        .filter(({ kind }) => kind === "area")
        .map((g) => (g as unknown as { upper: { starts: number[] } }).upper.starts.length);
    expect(runs(strip)).toEqual(runs(scene.panels[0]!));
  });

  it("draws in static SVG and PDF", () => {
    const data = waves(300);
    const options = {
      width: 500,
      height: 260,
      marks: [line(data, { x: "t", y: "a" })],
      navigator: rangeNavigator(),
      locale: "en-US",
    };
    const svg = renderToSVG(options);
    // The plot's line and the strip's, each clipped, and the strip's labels.
    expect(svg.match(/<clipPath /g)).toHaveLength(2);
    expect(svg).toContain('paint-order="stroke"');
    const pdf = new TextDecoder("latin1").decode(renderToPDF(options));
    expect(pdf).toMatch(/^%PDF-1\.4/);
  });
});

describe("a navigator's strip under panels", () => {
  function prices(n = 200) {
    return table({
      t: Float64Array.from({ length: n }, (_, i) => i),
      close: Float64Array.from({ length: n }, (_, i) => 100 + Math.sin(i / 20) * 5),
      volume: Float64Array.from({ length: n }, (_, i) => 1e6 + (i % 7) * 1e5),
    });
  }
  /** `n` rows in `values.length` facet panels, each value's rows offset by `step`. */
  function regions(values: readonly string[], n = 300, step = 100) {
    return table({
      t: Float64Array.from({ length: n }, (_, i) => i),
      v: Float64Array.from({ length: n }, (_, i) => (i % values.length) * step + Math.sin(i / 10)),
      k: Array.from({ length: n }, (_, i) => values[i % values.length]!),
    });
  }
  const linesOf = (panel: Panel) =>
    panel.marks.filter(({ kind }) => kind === "line") as LineGeometry[];
  const ysOf = (g: LineGeometry) =>
    Array.from({ length: g.path.count }, (_, i) => g.path.coords[i * 2 + 1]!);
  const xsOf = (g: LineGeometry) =>
    Array.from({ length: g.path.count }, (_, i) => g.path.coords[i * 2]!);
  const faded = (strip: Panel) =>
    windowOf(strip).shapes.filter((s) => "d" in s && s.opacity < 1) as { d: string }[];

  it("goes under stacked subplots, aligned with their plots, below the x labels and title", () => {
    const { model, scene } = build(
      {
        marks: [
          line(prices(), { x: "t", y: "close", panel: "price", id: "close" }),
          bar(prices(), { x: "t", y: "volume", panel: "volume", id: "volume" }),
        ],
        panels: panels([{ id: "price" }, { id: "volume" }], { rowHeights: [3, 1] }),
        x: { title: "Time" },
        navigator: rangeNavigator(),
      },
      600,
      400,
    );
    const [price, volume] = model.panels();
    expect(scene.panels.map(({ key }) => key)).toEqual(["price", "volume", NAVIGATOR_PANEL]);
    const strip = stripOf(scene);
    expect(strip.plot).toEqual({
      x: price!.plot.x,
      y: 400 - 2 - 40,
      width: price!.plot.width,
      height: 40,
    });
    expect(volume!.plot.x).toBe(price!.plot.x);
    const title = scene.panels[1]!.axes.find((axis) => axis.side === "bottom")!.title!;
    expect(volume!.plot.y + volume!.plot.height).toBeLessThan(title.y);
    expect(title.y).toBeLessThan(strip.plot.y);
    // The weighted rows keep their shares of what the strip leaves.
    expect(price!.plot.height / volume!.plot.height).toBeCloseTo(3, 5);
    expect(model.panels()).toHaveLength(2);
  });

  it("draws every panel's marks, each over the y scale of its own panel", () => {
    const { scene } = build({
      marks: [
        line(prices(), { x: "t", y: "close", panel: "price" }),
        bar(prices(), { x: "t", y: "volume", panel: "volume" }),
      ],
      panels: panels([{ id: "price" }, { id: "volume" }]),
      navigator: rangeNavigator(),
    });
    const strip = stripOf(scene);
    expect(strip.marks.map(({ kind }) => kind)).toEqual(["line", "rect", "shapes", "text"]);
    // Prices near 100 span the strip on their own scale, not flattened by
    // volumes in the millions; the tallest volume bar reaches its top.
    const [close] = linesOf(strip);
    const ys = ysOf(close!);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(strip.plot.height / 2);
    const bars = strip.marks.find(({ kind }) => kind === "rect") as unknown as {
      rects: Float32Array;
      count: number;
    };
    expect(bars.count).toBe(200);
    const tops = Array.from({ length: bars.count }, (_, i) => bars.rects[i * 4 + 1]!);
    expect(Math.min(...tops)).toBeCloseTo(strip.plot.y + 3, 0);
  });

  it("draws only the marks it names, whichever panel draws them", () => {
    const { scene } = build({
      marks: [
        line(prices(), { x: "t", y: "close", panel: "price", id: "close" }),
        bar(prices(), { x: "t", y: "volume", panel: "volume", id: "volume" }),
      ],
      panels: panels([{ id: "price" }, { id: "volume" }]),
      navigator: rangeNavigator({ marks: ["volume"] }),
    });
    expect(stripOf(scene).marks.map(({ kind }) => kind)).toEqual(["rect", "shapes", "text"]);
  });

  it("shows the x range every panel shares, from any panel, and keeps its overview meanwhile", () => {
    const { model, scene } = build({
      marks: [
        line(prices(), { x: "t", y: "close", panel: "price" }),
        bar(prices(), { x: "t", y: "volume", panel: "volume" }),
      ],
      // Fixed y labels and no x labels: the margins, and so the strip, stay.
      panels: panels([
        { id: "price", y: { domain: [90, 110] } },
        { id: "volume", y: { domain: [0, 2e6] } },
      ]),
      x: { show: false },
      navigator: rangeNavigator(),
    });
    const before = stripOf(scene);
    expect(faded(before)).toHaveLength(0);
    model.setViewport([50, 100], "volume");
    const zoomed = model.scene(estimateText);
    expect(model.panels().map(({ x }) => x.domain)).toEqual([
      [50, 100],
      [50, 100],
    ]);
    const strip = stripOf(zoomed);
    expect(faded(strip)).toHaveLength(2);
    // The same overview: zooming changed neither its data nor its scales.
    expect(strip.marks[0]).toBe(before.marks[0]);
    expect(strip.marks[1]).toBe(before.marks[1]);
  });

  it("spans columns of unequal widths, its window filling it unzoomed", () => {
    const data = prices(101);
    const { model, scene } = build(
      {
        marks: [
          bar(data, { x: "t", y: "volume", panel: "a" }),
          line(data, { x: "t", y: "close", panel: "b" }),
          point(data, { x: "t", y: "close", panel: "c" }),
        ],
        panels: panels([{ id: "a" }, { id: "b" }, { id: "c" }], {
          columns: 2,
          columnWidths: [1, 3],
        }),
        navigator: rangeNavigator(),
      },
      800,
      400,
    );
    const [a, b, c] = model.panels();
    const strip = stripOf(scene);
    expect(strip.plot.x).toBe(a!.plot.x);
    expect(strip.plot.x + strip.plot.width).toBe(b!.plot.x + b!.plot.width);
    expect(c!.plot.x).toBe(a!.plot.x);
    // The plots' x domain, rounded and padded for bars over the narrow
    // column, is the strip's: unzoomed, nothing is faded.
    expect(faded(strip)).toHaveLength(0);
    // Ticks for the strip's width, more than the narrow column has.
    const narrow = scene.panels[0]!.grid.x.length;
    expect(strip.grid.x.length).toBeGreaterThan(narrow);
    for (const at of strip.grid.x) {
      expect(at).toBeGreaterThanOrEqual(strip.plot.x);
      expect(at).toBeLessThanOrEqual(strip.plot.x + strip.plot.width);
    }
    // And the window shows a view where the plots show it.
    model.setViewport([25, 75]);
    const zoomed = stripOf(model.scene(estimateText));
    const [left, right] = faded(zoomed).map(({ d }) => d.match(/-?[\d.]+/g)!.map(Number));
    const rail = (value: number) =>
      zoomed.plot.x +
      ((value - a!.x.domain[0]) / (a!.x.domain[1] - a!.x.domain[0])) * zoomed.plot.width;
    expect(left![2]).toBeCloseTo(rail(25), 0);
    expect(right![0]).toBeCloseTo(rail(75), 0);
  });

  it("goes under wrapped facets, drawing each panel's part of a series apart", () => {
    const values = ["a", "b", "c", "d", "e"];
    const { model, scene } = build(
      {
        marks: [line(regions(values), { x: "t", y: "v" })],
        facet: facet("k", { columns: 3 }),
        navigator: rangeNavigator(),
      },
      600,
      400,
    );
    const views = model.panels();
    expect(views).toHaveLength(5);
    const strip = stripOf(scene);
    // Across the top row, which the short last row leaves wider.
    expect(strip.plot.x).toBe(views[0]!.plot.x);
    expect(strip.plot.x + strip.plot.width).toBe(views[2]!.plot.x + views[2]!.plot.width);
    // A line per panel, in buffers of its own, under keys of its own.
    const lines = linesOf(strip);
    expect(lines).toHaveLength(5);
    expect(new Set(lines.map(({ path }) => path)).size).toBe(5);
    expect(new Set(lines.map(({ key }) => key)).size).toBe(5);
    for (const g of linesOf(scene.panels[0]!))
      expect(lines.map(({ path }) => path)).not.toContain(g.path);
    // Never joined: each part runs left to right on its own.
    for (const g of lines) {
      const xs = xsOf(g);
      expect(xs.every((x, i) => i === 0 || x >= xs[i - 1]!)).toBe(true);
    }
    // Panels sharing y share it in the strip: each value's level apart.
    const middles = lines.map((g) => {
      const ys = ysOf(g);
      return (Math.max(...ys) + Math.min(...ys)) / 2;
    });
    expect(middles).toEqual([...middles].sort((p, q) => q - p));
    expect(middles[0]! - middles[4]!).toBeGreaterThan(strip.plot.height / 2);
  });

  it("gives facets with y scales of their own a y scale each, and draws a repeated mark once per scale", () => {
    const data = regions(["a", "b", "c"]);
    const own = stripOf(
      build(
        {
          marks: [line(data, { x: "t", y: "v" })],
          facet: facet("k"),
          y: { scope: "panel" },
          navigator: rangeNavigator(),
        },
        600,
        400,
      ).scene,
    );
    // Each panel's part spans much of the strip on its own scale.
    for (const g of linesOf(own)) {
      const ys = ysOf(g);
      expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(own.plot.height / 2);
    }
    const level = table({ t: [0, 299], v: [0, 0] });
    const marks = [
      line(data, { x: "t", y: "v" }),
      line(level, { x: "t", y: "v", facet: "repeat", id: "level" }),
    ];
    const strip = (scopes: Pick<ChartConfig, "y"> = {}) =>
      stripOf(
        build({ marks, facet: facet("k"), ...scopes, navigator: rangeNavigator() }, 600, 400).scene,
      );
    // Once over the one y scale the panels share, and once in each of theirs.
    expect(linesOf(strip())).toHaveLength(4);
    expect(linesOf(strip({ y: { scope: "panel" } }))).toHaveLength(6);
    expect(new Set(linesOf(strip({ y: { scope: "panel" } })).map(({ key }) => key)).size).toBe(6);
  });

  it("goes under a grid of facets, short of the row headers", () => {
    const n = 400;
    const data = table({
      t: Float64Array.from({ length: n }, (_, i) => i),
      v: Float64Array.from({ length: n }, (_, i) => Math.sin(i / 10)),
      r: Array.from({ length: n }, (_, i) => (i % 2 ? "east" : "west")),
      c: Array.from({ length: n }, (_, i) => (i % 4 < 2 ? "A" : "B")),
    });
    const { model, scene } = build(
      {
        marks: [line(data, { x: "t", y: "v" })],
        facet: facet({ row: "r", column: "c" }),
        navigator: rangeNavigator(),
      },
      600,
      400,
    );
    const views = model.panels();
    const strip = stripOf(scene);
    const right = Math.max(...views.map(({ plot }) => plot.x + plot.width));
    expect(strip.plot.x).toBe(Math.min(...views.map(({ plot }) => plot.x)));
    expect(strip.plot.x + strip.plot.width).toBe(right);
    const rowHeaders = headersOf(scene).filter(({ angle }) => angle === 90);
    expect(rowHeaders.length).toBeGreaterThan(0);
    for (const header of rowHeaders) expect(header.x).toBeGreaterThan(right);
    expect(linesOf(strip)).toHaveLength(4);
  });

  it("follows facet values that come and go", () => {
    const data = table({ t: [0, 1, 2, 3], v: [1, 2, 3, 4], k: ["a", "b", "a", "b"] });
    const { model, scene } = build({
      marks: [line(data, { x: "t", y: "v" })],
      facet: facet("k"),
      navigator: rangeNavigator(),
    });
    expect(linesOf(stripOf(scene))).toHaveLength(2);
    data.append({ t: [4, 5], v: [5, 6], k: ["c", "c"] });
    const grown = stripOf(model.scene(estimateText));
    expect(linesOf(grown)).toHaveLength(3);
    expect(grown.plot.width).toBeLessThan(stripOf(scene).plot.width + 1);
  });

  it("stacks areas within each facet panel, as the panels do", () => {
    const n = 40;
    const data = table({
      t: Float64Array.from({ length: n }, (_, i) => Math.floor(i / 2)),
      v: Float64Array.from({ length: n }, () => 1),
      w: Float64Array.from({ length: n }, () => 2),
      k: Array.from({ length: n }, (_, i) => (i % 2 ? "a" : "b")),
    });
    const { scene } = build({
      marks: [area(data, { x: "t", y: ["v", "w"], stack: true })],
      facet: facet("k"),
      navigator: rangeNavigator(),
    });
    const areas = stripOf(scene).marks.filter(({ kind }) => kind === "area");
    // Two stacked fields in each of two panels.
    expect(areas).toHaveLength(4);
  });

  it("leaves out series the legend hides, in every panel", () => {
    const data = table({
      t: [0, 1, 2, 3],
      v: [1, 2, 3, 4],
      w: [4, 3, 2, 1],
      k: ["a", "b", "a", "b"],
    });
    const { model } = build({
      marks: [line(data, { x: "t", y: "v" }), line(data, { x: "t", y: "w" })],
      facet: facet("k"),
      navigator: rangeNavigator(),
    });
    model.hidden.add(model.series()[1]!.key);
    const strip = stripOf(model.scene(estimateText));
    const drawn = linesOf(strip).filter(({ path }) => path.count > 0);
    expect(drawn).toHaveLength(2);
  });

  it("gives each side of a subplot's y axes a scale of its own", () => {
    const data = prices();
    const { scene } = build({
      marks: [
        line(data, { x: "t", y: "close", panel: "p" }),
        line(data, { x: "t", y: "volume", panel: "p", axis: "right" }),
        line(data, { x: "t", y: "close", panel: "q" }),
      ],
      panels: panels([{ id: "p" }, { id: "q" }]),
      navigator: rangeNavigator(),
    });
    const strip = stripOf(scene);
    const lines = linesOf(strip);
    expect(lines).toHaveLength(3);
    for (const g of lines) {
      const ys = ysOf(g);
      expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(strip.plot.height / 3);
    }
  });

  it("is shorter, or stays out, where rows of panels would get too short", () => {
    const data = prices(20);
    const marks = ["a", "b", "c", "d"].map((panel) => line(data, { x: "t", y: "close", panel }));
    const layout = panels(["a", "b", "c", "d"].map((id) => ({ id })));
    // Each row needs 20 pixels: 4 rows and a 40-pixel strip would not fit.
    for (const height of [215, 245, 260, 300]) {
      const { model, scene } = build(
        { marks, panels: layout, navigator: rangeNavigator() },
        600,
        height,
      );
      const without = build({ marks, panels: layout }, 600, height).model.panels();
      const rows = model.panels().map(({ plot }) => plot.height);
      expect(Math.min(...rows)).toBeGreaterThanOrEqual(20);
      const strip = scene.panels.find(({ key }) => key === NAVIGATOR_PANEL);
      if (strip) {
        expect(strip.plot.height).toBeGreaterThanOrEqual(16);
        expect(strip.plot.height).toBeLessThanOrEqual(40);
        expect(rows[0]).toBeLessThan(without[0]!.plot.height);
      } else expect(rows[0]).toBe(without[0]!.plot.height);
    }
    const strip = (height: number) =>
      build({ marks, panels: layout, navigator: rangeNavigator() }, 600, height).scene.panels.find(
        ({ key }) => key === NAVIGATOR_PANEL,
      )?.plot.height;
    expect(strip(215)).toBeUndefined();
    expect(strip(245)).toBe(19);
    expect(strip(300)).toBe(40);
  });

  it("leaves weighted rows what they need, to the pixel, and takes huge weights", () => {
    const data = prices(20);
    const marks = [
      line(data, { x: "t", y: "close", panel: "a" }),
      line(data, { x: "t", y: "close", panel: "b" }),
    ];
    const hidden = { x: { show: false }, y: { show: false }, legend: false } as const;
    const weighted = (rowHeights: number[], height: number) =>
      build(
        {
          marks,
          panels: panels([{ id: "a" }, { id: "b" }], { rowHeights }),
          ...hidden,
          navigator: rangeNavigator(),
        },
        600,
        height,
      );
    // The short row would be a rounding error under 20 pixels at the least height.
    for (let height = 195; height <= 215; height++) {
      const { model } = weighted([1, 6], height);
      expect(Math.min(...model.panels().map(({ plot }) => plot.height))).toBeGreaterThanOrEqual(20);
    }
    // Weights too large to add up are shares of the largest, as the rows' are.
    expect(stripOf(weighted([1e308, 1e308], 300).scene).plot.height).toBe(40);
  });

  it("has a key of its own when a panel or a facet value is called navigator", () => {
    const data = table({
      t: [0, 1, 2, 3],
      v: [1, 2, 3, 4],
      k: ["navigator", "b", "navigator", "b"],
    });
    const faceted = build({
      marks: [line(data, { x: "t", y: "v" })],
      facet: facet("k"),
      navigator: rangeNavigator(),
    }).scene;
    const keys = faceted.panels.map(({ key }) => key);
    expect(keys.slice(0, 2)).toEqual(["navigator", "b"]);
    expect(new Set(keys).size).toBe(3);
    expect(faceted.panels[2]!.marks.some(({ key }) => key === "navigator-frame")).toBe(true);
    const named = build({
      marks: [line(data, { x: "t", y: "v", panel: "navigator" })],
      panels: panels([{ id: "navigator" }]),
      navigator: rangeNavigator(),
    }).scene;
    expect(new Set(named.panels.map(({ key }) => key)).size).toBe(2);
  });

  it("draws in static SVG and PDF under every panel", () => {
    const data = prices();
    const options = {
      width: 500,
      height: 360,
      marks: [
        line(data, { x: "t", y: "close", panel: "price" }),
        bar(data, { x: "t", y: "volume", panel: "volume" }),
      ],
      panels: panels([{ id: "price" }, { id: "volume" }]),
      navigator: rangeNavigator(),
      locale: "en-US",
    };
    const svg = renderToSVG(options);
    // Each panel's data and the strip's, each clipped.
    expect(svg.match(/<clipPath /g)).toHaveLength(3);
    const description = /<desc[^>]*>(.*?)<\/desc>/.exec(svg)![1]!;
    expect(description).toContain("A range navigator shows the whole x range,");
    expect(description).toContain("it controls every panel&#39;s x range.");
    const pdf = new TextDecoder("latin1").decode(renderToPDF(options));
    expect(pdf).toMatch(/^%PDF-1\.4/);
    const alt = /\/Alt <FEFF([\dA-F]*)>/.exec(pdf)![1]!;
    expect(Buffer.from(alt, "hex").swap16().toString("utf16le")).toContain(
      "it controls every panel's x range.",
    );
  });
});

describe("a navigator's text alternative", () => {
  it("is absent without a navigator", () => {
    expect(
      describeChart(build({ marks: [line(waves(10), { x: "t", y: "a" })] }).model),
    ).not.toContain("range navigator");
  });

  it("formats the shown range as x tooltips do, and follows zoom and reset", () => {
    const { model } = build({
      marks: [line(waves(10), { x: "t", y: "a" })],
      x: { domain: [9, 0], format: { style: "unit", unit: "meter" } },
      navigator: rangeNavigator(),
    });
    const whole = "A range navigator shows the whole x range, with 0 m to 9 m in view.";
    expect(describeChart(model)).toContain(whole);
    model.setViewport([2, 5]);
    model.scene(estimateText);
    expect(describeChart(model)).toContain(
      "A range navigator shows the whole x range, with 2 m to 5 m in view.",
    );
    model.setViewport(null);
    model.scene(estimateText);
    expect(describeChart(model)).toContain(whole);
  });

  it.each(["UTC", "America/New_York"])(
    "formats time in %s, including a view over a break",
    (timeZone) => {
      const start = Date.UTC(2026, 0, 1);
      const data = table({ t: time([start, start + DAY, start + 2 * DAY]), v: [1, 2, 3] });
      const { model } = build({
        marks: [line(data, { x: "t", y: "v" })],
        timeZone,
        x: { breaks: timeBreaks([{ hours: ["06:00", "12:00"] }]) },
        navigator: rangeNavigator(),
      });
      model.setViewport([start + 3 * HOUR, start + 18 * HOUR]);
      model.scene(estimateText);
      const format = model.formatsOf().x;
      const from = format(start + 3 * HOUR);
      const to = format(start + 18 * HOUR);
      expect(from).toContain(timeZone === "UTC" ? "03:00" : "22:00");
      expect(describeChart(model)).toContain(
        `A range navigator shows the whole x range, with ${from} to ${to} in view.`,
      );
    },
  );

  it.each(["facets", "subplots"])("names the shared x control in %s", (layout) => {
    const data = table({ t: [0, 1, 2, 3], v: [1, 2, 3, 4], k: ["a", "b", "a", "b"] });
    const { model } = build(
      {
        marks:
          layout === "facets"
            ? [line(data, { x: "t", y: "v" })]
            : [
                line(data, { x: "t", y: "v", panel: "a" }),
                line(data, { x: "t", y: "v", panel: "b" }),
              ],
        ...(layout === "facets"
          ? { facet: facet("k") }
          : { panels: panels([{ id: "a" }, { id: "b" }]) }),
        navigator: rangeNavigator(),
      },
      600,
      400,
    );
    model.setViewport([1, 2]);
    model.scene(estimateText);
    expect(describeChart(model)).toContain(
      "A range navigator shows the whole x range, with 1 to 2 in view; it controls every panel's x range.",
    );
    const config = { ...model.config };
    delete config.navigator;
    model.update(config);
    model.scene(estimateText);
    expect(describeChart(model)).not.toContain("range navigator");
  });
});

describe("navigators refuse", () => {
  const data = waves(10);
  const fail = (config: Partial<ChartConfig>) => () =>
    build({
      marks: [line(data, { x: "t", y: "a" })],
      ...config,
      navigator: rangeNavigator(config.navigator?.toJSON()),
    });

  it("panels with x scales of their own, layout marks, category x axes, and marks along y", () => {
    const hosts = table({ t: [0, 1], v: [1, 2], host: ["a", "b"] });
    for (const x of ["panel", "row", "column"] as const) {
      const message = `navigator: needs one x scale shared by every panel, and x.scope is "${x}"; set x.scope to "chart" or drop navigator`;
      expect(() =>
        build({
          marks: [line(hosts, { x: "t", y: "v" })],
          facet: facet("host"),
          x: { scope: x },
          navigator: rangeNavigator(),
        }),
      ).toThrow(message);
      // Also with one panel, which more data would make several.
      expect(() =>
        build({
          marks: [line(hosts, { x: "t", y: "v", panel: "p" })],
          panels: panels([{ id: "p" }]),
          x: { scope: x },
          navigator: rangeNavigator(),
        }),
      ).toThrow(message);
    }
    expect(() =>
      build({
        marks: [line(hosts, { x: "t", y: "v" })],
        facet: facet("host"),
        x: { scope: "chart" },
        navigator: rangeNavigator(),
      }),
    ).not.toThrow();
    expect(() =>
      build({
        marks: [
          line(hosts, { x: "t", y: "v", panel: "p" }),
          pie(hosts, { category: "host", value: "v", panel: "q" }),
        ],
        panels: panels([{ id: "p" }, { id: "q" }]),
        navigator: rangeNavigator(),
      }),
    ).toThrow("pie: no x axis for a navigator; drop navigator");
    expect(() =>
      build({ marks: [pie(hosts, { category: "host", value: "v" })], navigator: rangeNavigator() }),
    ).toThrow("pie: no x axis for a navigator; drop navigator");
    expect(() =>
      build({ marks: [bar(hosts, { x: "host", y: "v" })], navigator: rangeNavigator() }),
    ).toThrow("navigator: needs a number or time x axis; bar x holds categories");
    expect(() =>
      build({ marks: [bar(hosts, { x: "v", y: "host" })], navigator: rangeNavigator() }),
    ).toThrow("navigator: moves along x, and bar marks place along y; drop navigator");
    expect(fail({})).not.toThrow();
  });

  it("marks it names that the chart lacks or it cannot draw", () => {
    const ranges = table({ t: [0, 1], lo: [0, 1], hi: [1, 2] });
    expect(() =>
      build({
        marks: [line(data, { x: "t", y: "a" })],
        navigator: rangeNavigator({ marks: ["x"] }),
      }),
    ).toThrow('navigator marks: no mark "x" in the chart');
    expect(() =>
      build({
        marks: [errorBar(ranges, { x: "t", y1: "lo", y2: "hi", id: "e" })],
        navigator: rangeNavigator({ marks: ["e"] }),
      }),
    ).toThrow(
      'navigator marks: draws line, area, point, bar, and candlestick marks, not errorbar "e"',
    );
  });

  it("heights below 16 pixels and marks listed twice", () => {
    expect(() => rangeNavigator({ height: 8 })).toThrow(
      "navigator height: expected at least 16 pixels; received 8",
    );
    expect(() => rangeNavigator({ height: Number.NaN })).toThrow("received NaN");
    expect(() => rangeNavigator({ marks: ["a", "a"] })).toThrow(
      'navigator marks: "a" is listed twice',
    );
  });

  it("also when an update adds what they cannot draw", () => {
    const hosts = table({ t: [0, 1], v: [1, 2], host: ["a", "b"] });
    const { model } = build({
      marks: [line(hosts, { x: "t", y: "v" })],
      navigator: rangeNavigator(),
    });
    expect(() =>
      model.update({ marks: [bar(hosts, { x: "host", y: "v" })], navigator: rangeNavigator() }),
    ).toThrow("bar x holds categories");
    expect(() =>
      model.update({
        marks: [line(hosts, { x: "t", y: "v" })],
        facet: facet("host"),
        x: { scope: "panel" },
        navigator: rangeNavigator(),
      }),
    ).toThrow('x.scope is "panel"');
  });
});

describe("navigator specs", () => {
  const data = { d: { columns: { t: [0, 1, 2], v: [1, 3, 2] } } };
  const marks: ChartSpec["marks"] = [{ type: "line", x: "t", y: "v", id: "v" }];

  it("may be turned off", () => {
    expect(() => loadSpec({ data, marks, navigator: false })).not.toThrow();
    expect(loadSpec({ data, marks, navigator: false }).config.navigator).toBeUndefined();
  });

  it("load as a Navigator, with their options", () => {
    const { config } = loadSpec({ data, marks, navigator: { height: 50, marks: ["v"] } });
    expect(config.navigator).toBeInstanceOf(Navigator);
    expect(config.navigator!.toJSON()).toEqual({ height: 50, marks: ["v"] });
    expect(loadSpec({ data, marks, navigator: true }).config.navigator!.toJSON()).toEqual({});
    const model = new ChartModel(config);
    model.setSize(400, 300, 1);
    expect(stripOf(model.scene(estimateText)).plot.height).toBe(50);
  });

  it("load under facets and subplots, and refuse x scales of their own", () => {
    const hosts = { d: { columns: { t: [0, 1, 2, 3], v: [1, 3, 2, 4], k: ["a", "b", "a", "b"] } } };
    const lines: ChartSpec["marks"] = [{ type: "line", x: "t", y: "v" }];
    const draw = (spec: Partial<ChartSpec>) => {
      const model = new ChartModel(loadSpec({ data: hosts, marks: lines, ...spec }).config);
      model.setSize(400, 300, 1);
      return model.scene(estimateText);
    };
    expect(stripOf(draw({ facet: { field: "k" }, navigator: true })).plot.height).toBe(40);
    expect(() =>
      draw({ facet: { field: "k" }, x: { scope: "column" }, navigator: { height: 30 } }),
    ).toThrow('x.scope is "column"');
  });

  it("are checked", () => {
    expect(() => validateSpec({ marks, navigator: { height: 10 } })).toThrow(
      "spec.navigator.height: expected a height of at least 16 pixels; received 10",
    );
    expect(() => validateSpec({ marks, navigator: { marks: ["v", "v"] } })).toThrow(
      'spec.navigator.marks[1]: expected a mark id not listed before; received "v"',
    );
    expect(() => validateSpec({ marks, navigator: "yes" })).toThrow(
      "spec.navigator: expected an object",
    );
  });
});
