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
    const without = build({ marks, x: { label: "Time" } });
    const { model, scene } = build({ marks, x: { label: "Time" }, navigator: rangeNavigator() });
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
    const title = scene.panels[0]!.axes.find((axis) => axis.orient === "bottom")!.title!;
    expect(title.y).toBeLessThan(strip.plot.y);
    expect(title.y).toBe(
      without.scene.panels[0]!.axes.find((a) => a.orient === "bottom")!.title!.y - 52,
    );
    // The strip is not a panel the chart inspects, zooms, or reports.
    expect(model.panels()).toHaveLength(1);
    expect(model.inspect(strip.plot.x + 10, strip.plot.y + 10)).toBeUndefined();
  });

  it("takes at most a third of the plot's room, leaving the plot 30 pixels, or stays out", () => {
    const data = waves(20);
    const marks = [line(data, { x: "t", y: "a" })];
    const tall = build({ marks, navigator: rangeNavigator({ height: 64 }) });
    expect(stripOf(tall.scene).plot.height).toBe(64);
    // A short chart's strip is shorter, and never covers the plot or its labels.
    for (const height of [160, 180, 200]) {
      const { model, scene } = build(
        { marks, title: "Short", x: { label: "Time" }, navigator: rangeNavigator() },
        600,
        height,
      );
      const plot = model.panels()[0]!.plot;
      const strip = stripOf(scene).plot;
      expect(strip.height).toBeGreaterThanOrEqual(16);
      expect(strip.height).toBeLessThanOrEqual(40);
      expect(plot.height).toBeGreaterThanOrEqual(30);
      const title = scene.panels[0]!.axes.find((axis) => axis.orient === "bottom")!.title!;
      expect(plot.y + plot.height).toBeLessThan(title.y);
      expect(title.y).toBeLessThan(strip.y);
    }
    // Too short for both, the chart has no strip.
    const tiny = build(
      { marks, title: "Tiny", x: { label: "Time" }, navigator: rangeNavigator() },
      600,
      140,
    );
    expect(tiny.scene.panels.map(({ key }) => key)).toEqual([""]);
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
      x: { axis: false },
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
      x: { axis: false },
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
      x: { axis: false, domain: [0, 1] },
      y: { axis: false },
      navigator: rangeNavigator({ marks: [] }),
    });
    expect(stripOf(scene).grid.x.length).toBeGreaterThan(0);
    const unset = build({
      marks: [line(data, { x: "t", y: "v" })],
      x: { axis: false },
      y: { axis: false },
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
      theme: { fontSize: 24 },
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

describe("navigators refuse", () => {
  const data = waves(10);
  const fail = (config: Partial<ChartConfig>) => () =>
    build({
      marks: [line(data, { x: "t", y: "a" })],
      ...config,
      navigator: rangeNavigator(config.navigator?.toJSON()),
    });

  it("facets, panels, layout marks, category x axes, and marks along y", () => {
    const hosts = table({ t: [0, 1], v: [1, 2], host: ["a", "b"] });
    expect(() =>
      build({
        marks: [line(hosts, { x: "t", y: "v" })],
        facet: facet("host"),
        navigator: rangeNavigator(),
      }),
    ).toThrow("Charts with facets cannot have a navigator yet");
    expect(() =>
      build({
        marks: [line(hosts, { x: "t", y: "v", panel: "p" })],
        panels: panels([{ id: "p" }]),
        navigator: rangeNavigator(),
      }),
    ).toThrow("Charts with panels cannot have a navigator yet");
    expect(() =>
      build({ marks: [pie(hosts, { category: "host", value: "v" })], navigator: rangeNavigator() }),
    ).toThrow("no x axis for a navigator");
    expect(() =>
      build({ marks: [bar(hosts, { x: "host", y: "v" })], navigator: rangeNavigator() }),
    ).toThrow("A navigator needs a number or time x axis; a bar mark has categories");
    expect(() =>
      build({ marks: [bar(hosts, { x: "v", y: "host" })], navigator: rangeNavigator() }),
    ).toThrow("a bar mark placed along y cannot have one");
    expect(fail({})).not.toThrow();
  });

  it("marks it names that the chart lacks or it cannot draw", () => {
    const ranges = table({ t: [0, 1], lo: [0, 1], hi: [1, 2] });
    expect(() =>
      build({
        marks: [line(data, { x: "t", y: "a" })],
        navigator: rangeNavigator({ marks: ["x"] }),
      }),
    ).toThrow('The navigator draws the mark "x", which the chart lacks');
    expect(() =>
      build({
        marks: [errorBar(ranges, { x: "t", y1: "lo", y2: "hi", id: "e" })],
        navigator: rangeNavigator({ marks: ["e"] }),
      }),
    ).toThrow('not the errorbar mark "e"');
  });

  it("heights below 16 pixels and marks listed twice", () => {
    expect(() => rangeNavigator({ height: 8 })).toThrow("at least 16 pixels");
    expect(() => rangeNavigator({ height: Number.NaN })).toThrow("at least 16 pixels");
    expect(() => rangeNavigator({ marks: ["a", "a"] })).toThrow('lists the mark "a" twice');
  });

  it("also when an update adds what they cannot draw", () => {
    const hosts = table({ t: [0, 1], v: [1, 2], host: ["a", "b"] });
    const { model } = build({
      marks: [line(hosts, { x: "t", y: "v" })],
      navigator: rangeNavigator(),
    });
    expect(() =>
      model.update({ marks: [bar(hosts, { x: "host", y: "v" })], navigator: rangeNavigator() }),
    ).toThrow("a bar mark has categories");
  });
});

describe("navigator specs", () => {
  const data = { d: { columns: { t: [0, 1, 2], v: [1, 3, 2] } } };
  const marks: ChartSpec["marks"] = [{ type: "line", x: "t", y: "v", id: "v" }];

  it("need version 4, unless they turn it off", () => {
    expect(() => loadSpec({ version: 3, data, marks, navigator: true })).toThrow(
      'spec.navigator: expected a spec with "version": 4',
    );
    expect(() => loadSpec({ data, marks, navigator: false })).not.toThrow();
    expect(loadSpec({ data, marks, navigator: false }).config.navigator).toBeUndefined();
  });

  it("load as a Navigator, with their options", () => {
    const { config } = loadSpec({
      version: 4,
      data,
      marks,
      navigator: { height: 50, marks: ["v"] },
    });
    expect(config.navigator).toBeInstanceOf(Navigator);
    expect(config.navigator!.toJSON()).toEqual({ height: 50, marks: ["v"] });
    expect(
      loadSpec({ version: 4, data, marks, navigator: true }).config.navigator!.toJSON(),
    ).toEqual({});
    const model = new ChartModel(config);
    model.setSize(400, 300, 1);
    expect(stripOf(model.scene(estimateText)).plot.height).toBe(50);
  });

  it("are checked", () => {
    expect(() => validateSpec({ version: 4, marks, navigator: { height: 10 } })).toThrow(
      "spec.navigator.height: expected a height of at least 16 pixels, got 10",
    );
    expect(() => validateSpec({ version: 4, marks, navigator: { marks: ["v", "v"] } })).toThrow(
      'spec.navigator.marks[1]: expected a mark id not listed before, got "v"',
    );
    expect(() => validateSpec({ version: 4, marks, navigator: "yes" })).toThrow(
      "spec.navigator: expected an object",
    );
  });
});
