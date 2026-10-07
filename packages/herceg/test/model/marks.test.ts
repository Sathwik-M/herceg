// Bars, points, and heatmaps: geometry, band axes, picking, and legends.
import { describe, expect, it, vi } from "vitest";
import { time } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { bar } from "../../src/marks/bar.ts";
import { heatmap, MAX_CELLS } from "../../src/marks/heatmap.ts";
import { line } from "../../src/marks/line.ts";
import { type PointOptions, point } from "../../src/marks/point.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import type {
  PointGeometry,
  RasterGeometry,
  RectGeometry,
  Scene,
  TextGeometry,
} from "../../src/scene/scene.ts";

function build(config: ChartConfig, width = 600, height = 300) {
  const model = new ChartModel({ locale: "en-US", timeZone: "UTC", ...config });
  model.setSize(width, height, 1);
  return { model, scene: model.scene(estimateText) };
}

const rects = (scene: Scene) =>
  scene.panels[0]!.marks.filter((m): m is RectGeometry => m.kind === "rect");
const rect = (geometry: RectGeometry, i: number) =>
  Array.from(geometry.rects.subarray(i * 4, i * 4 + 4)) as [number, number, number, number];

describe("bar", () => {
  const sales = table({ region: ["N", "S", "E"], q1: [10, 20, 30], q2: [5, -10, 15] });

  it("groups series side by side within each category band", () => {
    const { scene, model } = build({ marks: [bar(sales, { x: "region", y: ["q1", "q2"] })] });
    const [q1, q2] = rects(scene);
    expect(q1!.count).toBe(3);
    const x = model.xScale()!;
    expect(x.type).toBe("band");
    expect(
      scene.panels[0]!.axes.find((a) => a.orient === "bottom")!.ticks.map((t) => t.label),
    ).toEqual(["N", "S", "E"]);
    // q2 sits right of q1 in every band, both inside the band.
    for (let i = 0; i < 3; i++) {
      const [x1, , w1] = rect(q1!, i);
      const [x2, , w2] = rect(q2!, i);
      expect(x2!).toBeGreaterThan(x1! + w1! - 0.01);
      expect(x1!).toBeGreaterThanOrEqual(x.start!(i) - 0.01);
      expect(x2! + w2!).toBeLessThanOrEqual(x.start!(i) + x.bandwidth! + 0.01);
    }
    // Negative values extend below the zero line.
    const zero = model.yScale()!.map(0);
    const [, ySouth, , hSouth] = rect(q2!, 1);
    expect(ySouth).toBeCloseTo(zero, 1);
    expect(hSouth!).toBeGreaterThan(0);
  });

  it("stacks positive and negative values separately", () => {
    const { model } = build({ marks: [bar(sales, { x: "region", y: ["q1", "q2"], stack: true })] });
    const [q1, q2] = model.series();
    expect(Array.from(q2!.y0!)).toEqual([10, 0, 30]);
    expect(Array.from(q2!.y)).toEqual([15, -10, 45]);
    expect(Array.from(q1!.y)).toEqual([10, 20, 30]);
  });

  it("uses the full band for each stacked layer", () => {
    const { scene } = build({ marks: [bar(sales, { x: "region", y: ["q1", "q2"], stack: true })] });
    const [q1, q2] = rects(scene);
    expect(rect(q1!, 0)[0]).toBeCloseTo(rect(q2!, 0)[0]!);
    expect(rect(q1!, 0)[2]).toBeCloseTo(rect(q2!, 0)[2]!);
  });

  it("centers bars on time values with room at both ends", () => {
    const start = Date.UTC(2026, 0, 1);
    const counts = table({ t: time([start, start + 60_000, start + 120_000]), n: [1, 2, 3] });
    const { scene, model } = build({ marks: [bar(counts, { x: "t", y: "n" })] });
    const [bars] = rects(scene);
    const x = model.xScale()!;
    const spacing = x.map(start + 60_000) - x.map(start);
    // 80% of the spacing, capped so sparse data does not draw giant bars.
    expect(rect(bars!, 0)[2]).toBeCloseTo(Math.min(64, spacing * 0.8), 1);
    expect(rect(bars!, 0)[0]!).toBeGreaterThanOrEqual(scene.panels[0]!.plot.x - 0.01);
    expect(rect(bars!, 2)[0]! + rect(bars!, 2)[2]!).toBeLessThanOrEqual(
      scene.panels[0]!.plot.x + scene.panels[0]!.plot.width + 0.01,
    );
  });

  it("regroups when a series is hidden", () => {
    const { model } = build({ marks: [bar(sales, { x: "region", y: ["q1", "q2"] })] });
    model.hidden.add(model.series()[1]!.key);
    const [only] = rects(model.scene(estimateText));
    expect(rect(only!, 0)[2]).toBeCloseTo(Math.abs(model.xScale()!.bandwidth!), 1);
  });

  it("reports every series in a category for tooltips", () => {
    const { scene, model } = build({ marks: [bar(sales, { x: "region", y: ["q1", "q2"] })] });
    const inspection = model.inspect(model.xScale()!.map(2), scene.panels[0]!.plot.y + 10)!;
    expect(inspection.label).toBe("E");
    expect(inspection.points.map((p) => p.value)).toEqual([30, 15]);
  });

  it("thins category labels that would overlap", () => {
    const many = table({
      name: Array.from({ length: 200 }, (_, i) => `category ${i}`),
      v: new Float64Array(200).fill(1),
    });
    const { scene } = build({ marks: [bar(many, { x: "name", y: "v" })] });
    const ticks = scene.panels[0]!.axes.find((a) => a.orient === "bottom")!.ticks;
    expect(ticks.length).toBeLessThan(20);
    for (let i = 1; i < ticks.length; i++) {
      const gap = ticks[i]!.position - ticks[i - 1]!.position;
      expect(gap).toBeGreaterThan(estimateText(ticks[i - 1]!.label, "12px sans-serif"));
    }
  });

  it("cannot share a categorical axis with numeric marks", () => {
    const mixed = table({ name: ["a"], x: [1], v: [1] });
    expect(() =>
      build({ marks: [bar(mixed, { x: "name", y: "v" }), line(mixed, { x: "x", y: "v" })] }),
    ).toThrow(/cannot share a categorical x axis/);
    expect(() =>
      build({ marks: [bar(mixed, { x: "name", y: "v" }), bar(mixed, { x: "x", y: "v" })] }),
    ).toThrow(/cannot share a categorical x axis/);
    expect(() =>
      build({
        marks: [
          heatmap(mixed, { x: "name", y: "x", value: "v" }),
          bar(mixed, { x: "name", y: "v" }),
        ],
      }),
    ).toThrow(/cannot share a categorical y axis/);
  });

  it("rejects a y field listed twice", () => {
    expect(() => bar(sales, { x: "region", y: ["q1", "q1"], stack: true })).toThrow(
      /"q1" is listed twice/,
    );
  });

  it("leaves rows without a category out of the y domain", () => {
    const partial = table({ x: ["a", null], v: [1, 1_000_000] });
    const { model } = build({ marks: [bar(partial, { x: "x", y: "v" })] });
    expect(model.yScale()!.domain[1]).toBeLessThan(10);
  });

  it("keeps log x domains finite at extreme magnitudes", () => {
    const wide = table({ x: [1e-200, 1e200], v: [1, 2] });
    const { model } = build({ x: { type: "log" }, marks: [bar(wide, { x: "x", y: "v" })] });
    const [lo, hi] = model.xScale()!.domain;
    expect(lo).toBeGreaterThan(0);
    expect(Number.isFinite(hi)).toBe(true);
  });

  it("shares stack arrays across series split by a category", () => {
    const long = table({ x: ["a", "a", "b", "b"], v: [1, 2, 3, 4], g: ["p", "q", "p", "q"] });
    const { model } = build({ marks: [bar(long, { x: "x", y: "v", series: "g", stack: true })] });
    const [p, q] = model.series();
    // Each row belongs to one series, so one table-sized array holds every top.
    expect(p!.y).toBe(q!.y);
    expect(Array.from(q!.y)).toEqual([1, 3, 3, 7]);
    expect(Array.from(q!.y0!)).toEqual([0, 1, 0, 3]);
  });

  it("pads log x domains in log space", () => {
    const counts = table({ x: [1, 10], v: [1, 2] });
    const { model, scene } = build({
      x: { type: "log" },
      marks: [bar(counts, { x: "x", y: "v" })],
    });
    const [lo, hi] = model.xScale()!.domain;
    expect(lo).toBeGreaterThan(0);
    expect(lo).toBeLessThan(1);
    expect(hi).toBeGreaterThan(10);
    expect(rects(scene)[0]!.count).toBe(2);
  });

  it("draws stacked bars on a log y axis from the bottom of the plot", () => {
    const { scene } = build({
      y: { type: "log" },
      marks: [bar(sales, { x: "region", y: "q1", stack: true })],
    });
    const [bars] = rects(scene);
    expect(bars!.count).toBe(3);
    const [, top, , height] = rect(bars!, 0);
    expect(top! + height!).toBeCloseTo(scene.panels[0]!.plot.y + scene.panels[0]!.plot.height, 1);
  });

  it("sizes numeric bars by the gap between neighbors of any series", () => {
    const interleaved = table({ x: [0, 1, 100, 101], v: [1, 1, 1, 1], g: ["a", "b", "a", "b"] });
    const { scene, model } = build({ marks: [bar(interleaved, { x: "x", y: "v", series: "g" })] });
    const x = model.xScale()!;
    const [a, b] = rects(scene);
    // Positions 0 and 1 are neighbors: their slot is 80% of that gap, split in two.
    const gap = x.map(1) - x.map(0);
    expect(rect(a!, 0)[2]).toBeCloseTo(((gap * 0.8) / 2) * 0.9, 1);
    expect(rect(b!, 1)[2]).toBeCloseTo(((gap * 0.8) / 2) * 0.9, 1);
  });
});

describe("bar labels", () => {
  const sales = table({ region: ["N", "S", "E"], q1: [10, 20, 30], q2: [5, -10, 15] });
  const texts = (scene: Scene) =>
    scene.panels[0]!.marks.filter((m): m is TextGeometry => m.kind === "text");

  it("write values past the ends of bars, below for negative ones", () => {
    const { scene, model } = build({ marks: [bar(sales, { x: "region", y: "q2", labels: true })] });
    const [label] = texts(scene);
    expect(label!.labels).toEqual(["5", "-10", "15"]);
    expect([label!.anchor, label!.halo]).toEqual(["middle", true]);
    const y = model.yScale()!;
    expect(label!.coords[1]).toBeLessThan(y.map(5));
    expect(label!.coords[3]).toBeGreaterThan(y.map(-10));
  });

  it("write values after horizontal bars, before negative ones, with Intl options", () => {
    const { scene } = build({
      marks: [bar(sales, { x: "q2", y: "region", labels: { minimumFractionDigits: 1 } })],
    });
    const [after, before] = texts(scene);
    expect([after!.anchor, after!.labels]).toEqual(["start", ["5.0", "15.0"]]);
    expect([before!.anchor, before!.labels]).toEqual(["end", ["-10.0"]]);
  });

  it("label stacked segments inside, in a contrasting color, when they fit", () => {
    const stacked = table({ region: ["N", "S"], a: [100, 100], b: [1, 50] });
    const { scene } = build({
      marks: [bar(stacked, { x: "region", y: ["a", "b"], stack: true, labels: true })],
      theme: { palette: ["#0d366b", "#cde2fb"] },
    });
    const [a, b] = texts(scene);
    expect(a!.labels).toEqual(["100", "100"]);
    expect([a!.fill, a!.halo]).toEqual(["#ffffff", false]);
    // The 1-high segment has no room for its label.
    expect(b!.labels).toEqual(["50"]);
    expect(b!.fill).toBe("#000000");
  });

  it("choose text by contrast with the fill as painted, and keep a halo for unknown colors", () => {
    const stacked = table({ region: ["N"], a: [100], b: [100], c: [100] });
    const marks = (fill: string, fillOpacity = 1) => [
      bar(stacked, {
        x: "region",
        y: ["a", "b", "c"],
        stack: true,
        labels: true,
        fill,
        fillOpacity,
      }),
    ];
    const first = (fill: string, opacity?: number) =>
      texts(build({ marks: marks(fill, opacity) }).scene)[0]!;
    // Bright green reads better with black text, whatever its channel sum.
    expect(first("#00ff00").fill).toBe("#000000");
    // Half-transparent navy over a light page is light.
    expect(first("#000080", 0.2).fill).toBe("#000000");
    expect(first("#000080").fill).toBe("#ffffff");
    const named = first("white");
    expect([named.fill, named.halo]).toEqual(["#0b0b0b", true]);
  });

  it("leave room for labels in automatic domains", () => {
    const tall = table({ x: ["a", "b"], v: [10, 20] });
    const { scene } = build({ marks: [bar(tall, { x: "x", y: "v", labels: true })] }, 300, 150);
    const [label] = texts(scene);
    expect(label!.labels).toEqual(["10", "20"]);
    expect(label!.coords[3]! - scene.theme.fontSize / 2).toBeGreaterThanOrEqual(
      scene.panels[0]!.plot.y,
    );
  });

  it("move labels that would leave the plot inside their bars", () => {
    const tall = table({ x: ["a", "b"], v: [10, 20] });
    const { scene } = build(
      { marks: [bar(tall, { x: "x", y: "v", labels: true })], y: { domain: [0, 20] } },
      300,
      150,
    );
    const labels = texts(scene);
    const inside = labels.find((l) => !l.halo)!;
    expect(inside.labels).toEqual(["20"]);
    for (const label of labels)
      for (let i = 0; i < label.count; i++)
        expect(label.coords[i * 2 + 1]! - scene.theme.fontSize / 2).toBeGreaterThanOrEqual(
          scene.panels[0]!.plot.y,
        );
  });

  it("leave out labels wider than their neighbors' spacing, and do not format them", () => {
    const dense = table({
      x: Array.from({ length: 24 }, (_, i) => `c${i}`),
      a: Array.from({ length: 24 }, () => 11),
      b: Array.from({ length: 24 }, () => 11),
    });
    const { scene } = build({ marks: [bar(dense, { x: "x", y: ["a", "b"], labels: true })] });
    expect(texts(scene)).toHaveLength(0);
    // `format` is a getter that every formatting call reads.
    const many = table({
      x: Float64Array.from({ length: 20_000 }, (_, i) => i),
      v: new Float64Array(20_000).fill(5),
    });
    const counting = bar(many, { x: "x", y: "v", labels: { maximumFractionDigits: 0 } });
    const prototype = Intl.NumberFormat.prototype as unknown as { readonly format: unknown };
    const format = vi.spyOn(prototype, "format", "get");
    try {
      build({ marks: [counting] });
      expect(format.mock.calls.length).toBeLessThan(50);
    } finally {
      format.mockRestore();
    }
  });

  it("measure wide digits as wide", () => {
    const stacked = table({ region: ["N"], a: [11111], b: [1] });
    const { scene } = build(
      {
        marks: [
          bar(stacked, {
            x: "region",
            y: ["a", "b"],
            stack: true,
            labels: { numberingSystem: "fullwide", useGrouping: false } as Intl.NumberFormatOptions,
          }),
        ],
      },
      120,
      300,
    );
    for (const label of texts(scene)) expect(label.labels).not.toContain("１１１１１");
  });

  it("keep the baseline where it is when labels need room", () => {
    const values = table({ x: [1, 2], v: [10, 20] });
    const zeroAt = (labels: boolean) => {
      const { model } = build({
        marks: [bar(values, { x: "x", y: "v", labels }), point(values, { x: "x", y: "v", r: 3 })],
      });
      return model.yScale()!.map(0);
    };
    expect(zeroAt(true)).toBeCloseTo(zeroAt(false), 6);
  });

  it("reserve no room for hidden bars", () => {
    const values = table({ x: [1, 2], v: [100, 50] });
    const marks = [bar(values, { x: "x", y: "v", labels: true }), line(values, { x: "x", y: "v" })];
    const plain = build({ marks: [line(values, { x: "x", y: "v" })] }).model.yScale()!.domain;
    const { model } = build({ marks });
    model.hidden.add(model.series()[0]!.key);
    model.scene(estimateText);
    expect(model.yScale()!.domain[1]).toBe(plain[1]);
  });

  it("space grouped labels by their own bars, and keep them inside the plot", () => {
    const wide = table({ x: [1, 2], a: [11111, 11111], b: [11111, 11111] });
    const grouped = build({ marks: [bar(wide, { x: "x", y: ["a", "b"], labels: true })] }, 200);
    expect(texts(grouped.scene)).toHaveLength(0);
    const narrow = table({ x: [1, 2], a: [5, 6], b: [7, 8] });
    const { scene } = build({
      marks: [bar(narrow, { x: "x", y: ["a", "b"], labels: true })],
      x: { domain: [1, 2] },
    });
    for (const label of texts(scene))
      for (let i = 0; i < label.count; i++) {
        const x = label.coords[i * 2]!;
        expect(x).toBeGreaterThanOrEqual(scene.panels[0]!.plot.x);
        expect(x).toBeLessThanOrEqual(scene.panels[0]!.plot.x + scene.panels[0]!.plot.width);
      }
  });

  it("center stacked labels in the visible part of a segment", () => {
    const stacked = table({ name: ["a"], v: [100], w: [10] });
    const { scene, model } = build({
      marks: [bar(stacked, { x: ["v", "w"], y: "name", stack: true, labels: true })],
      x: { domain: [50, 150] },
    });
    const [label] = texts(scene);
    const x = model.xScale()!;
    expect(label!.coords[0]).toBeCloseTo((x.map(50) + x.map(100)) / 2, 3);
  });

  it("read the alpha of CSS colors when choosing text", () => {
    const stacked = table({ region: ["N"], a: [100], b: [100], c: [100] });
    const marks = [
      bar(stacked, {
        x: "region",
        y: ["a", "b", "c"],
        stack: true,
        labels: true,
        fill: "rgba(0, 0, 128, 0.2)",
      }),
    ];
    expect(texts(build({ marks }).scene)[0]!.fill).toBe("#000000");
  });

  it("format values without a chart locale", () => {
    const model = new ChartModel({ marks: [bar(sales, { x: "region", y: "q1", labels: true })] });
    model.setSize(600, 300, 1);
    const [label] = texts(model.scene(estimateText));
    expect(label!.labels).toHaveLength(3);
  });
});

describe("horizontal bar", () => {
  const sales = table({ region: ["N", "S", "E"], q1: [10, 20, 30], q2: [5, -10, 15] });
  const left = (scene: Scene) => scene.panels[0]!.axes.find((a) => a.orient === "left")!;

  it("puts categories on y, top to bottom, and lengths on x from zero", () => {
    const { scene, model } = build({ marks: [bar(sales, { x: "q1", y: "region" })] });
    const x = model.xScale()!;
    expect(model.yScale()!.type).toBe("band");
    expect(left(scene).ticks.map((t) => t.label)).toEqual(["N", "S", "E"]);
    const [n, s] = left(scene).ticks;
    expect(n!.position).toBeLessThan(s!.position);
    const [q1] = rects(scene);
    for (let i = 0; i < 3; i++) {
      const [rx, ry, rw, rh] = rect(q1!, i);
      expect(rx).toBeCloseTo(x.map(0), 3);
      expect(rx + rw).toBeCloseTo(x.map(sales.numbers("q1")[i]!), 3);
      expect(ry + rh / 2).toBeCloseTo(left(scene).ticks[i]!.position, 3);
    }
    // The x axis measures lengths: it starts at zero, ends on a round tick, and has grid lines.
    expect(x.domain).toEqual([0, 30]);
    expect(scene.panels[0]!.grid.x.length).toBeGreaterThan(0);
    expect(scene.panels[0]!.grid.y).toEqual([]);
  });

  it("groups series top to bottom within each band", () => {
    const { scene } = build({ marks: [bar(sales, { x: ["q1", "q2"], y: "region" })] });
    const [q1, q2] = rects(scene);
    for (let i = 0; i < 3; i++) {
      const [, y1, , h1] = rect(q1!, i);
      const [, y2] = rect(q2!, i);
      expect(y1 + h1).toBeLessThanOrEqual(y2);
    }
  });

  it("stacks positive values rightward and negative values leftward", () => {
    const { scene, model } = build({
      marks: [bar(sales, { x: ["q1", "q2"], y: "region", stack: true })],
    });
    const x = model.xScale()!;
    const [q1, q2] = rects(scene);
    // N: q2 starts where q1 ends.
    expect(rect(q2!, 0)[0]).toBeCloseTo(rect(q1!, 0)[0]! + rect(q1!, 0)[2]!, 3);
    // S: q2 is negative, so it grows left from zero.
    const [sx, , sw] = rect(q2!, 1);
    expect(sx + sw).toBeCloseTo(x.map(0), 3);
    expect(sx).toBeCloseTo(x.map(-10), 3);
    expect(x.domain[0]).toBeLessThanOrEqual(-10);
    expect(x.domain[1]).toBeGreaterThanOrEqual(45);
  });

  it("reports every series in the band nearest the pointer", () => {
    const { scene, model } = build({ marks: [bar(sales, { x: ["q1", "q2"], y: "region" })] });
    expect(model.tooltipMode()).toBe("nearest-y");
    const s = left(scene).ticks[1]!.position;
    const inspection = model.inspect(scene.panels[0]!.plot.x + 5, s + 2)!;
    expect(inspection.axis).toBe("y");
    expect(inspection.label).toBe("S");
    expect(inspection.position).toBeCloseTo(s, 3);
    expect(inspection.points.map((p) => [p.label, p.text])).toEqual([
      ["q1", "20"],
      ["q2", "-10"],
    ]);
    const key = model.series()[1]!.key;
    const keyboard = model.inspectPosition(key, 2)!;
    expect([keyboard.axis, keyboard.label, keyboard.points.length]).toEqual(["y", "E", 2]);
  });

  it("reports stacked values, not stack ends", () => {
    const { scene, model } = build({
      marks: [bar(sales, { x: ["q1", "q2"], y: "region", stack: true })],
    });
    const n = left(scene).ticks[0]!.position;
    const inspection = model.inspect(scene.panels[0]!.plot.x + 5, n)!;
    expect(inspection.points.map((p) => p.text)).toEqual(["10", "5"]);
    // The marker sits at the end of each segment.
    expect(inspection.points[1]!.px).toBeCloseTo(model.xScale()!.map(15), 3);
  });

  it("grows bars from the left edge of a log x axis", () => {
    const positive = table({ name: ["a", "b"], v: [10, 1000] });
    const { scene } = build({
      marks: [bar(positive, { x: "v", y: "name" })],
      x: { type: "log" },
    });
    const [bars] = rects(scene);
    expect(rect(bars!, 0)[0]).toBeCloseTo(scene.panels[0]!.plot.x, 3);
    expect(rect(bars!, 1)[0]).toBeCloseTo(scene.panels[0]!.plot.x, 3);
  });

  it("shortens long category labels instead of squeezing the plot", () => {
    const long = table({ name: ["x".repeat(200), "short"], v: [1, 2] });
    const { scene } = build({ marks: [bar(long, { x: "v", y: "name" })] });
    const labels = left(scene).ticks.map((t) => t.label);
    expect(labels[0]!.endsWith("…")).toBe(true);
    expect(labels[1]).toBe("short");
    expect(estimateText(labels[0]!, "12px sans-serif")).toBeLessThanOrEqual(600 * 0.3);
    expect(scene.panels[0]!.plot.width).toBeGreaterThan(300);
  });

  it("leaves rows without a category out of the x domain", () => {
    const partial = table({ name: ["a", null], v: [1, 1_000_000] });
    const { model } = build({ marks: [bar(partial, { x: "v", y: "name" })] });
    expect(model.xScale()!.domain).toEqual([0, 1]);
  });

  it("fits the x domain to visible series", () => {
    const uneven = table({ name: ["a", "b"], small: [1, 2], large: [1000, 2000] });
    const { model } = build({ marks: [bar(uneven, { x: ["small", "large"], y: "name" })] });
    model.hidden.add(model.series()[1]!.key);
    model.scene(estimateText);
    expect(model.xScale()!.domain[1]).toBe(2);
  });

  it("reports only bars drawn in view", () => {
    const lengths = table({ name: ["a", "b"], v: [1, 10] });
    const { model } = build({ marks: [bar(lengths, { x: "v", y: "name" })] });
    model.setViewport([5, 8]);
    const scene = model.scene(estimateText);
    const y = model.yScale()!;
    // Bar a ends at 1, left of the view; bar b crosses the whole view.
    const a = model.inspect(scene.panels[0]!.plot.x + 5, y.map(0));
    expect(a?.label).toBe("b");
    const b = model.inspect(scene.panels[0]!.plot.x + 5, y.map(1))!;
    expect(b.points.map((p) => p.text)).toEqual(["10"]);
    // The nearest-point mode skips the clipped bar too.
    expect(model.inspect(scene.panels[0]!.plot.x + 1, y.map(0), "nearest")?.label).toBe("b");
  });

  it("does not report lengths a log axis cannot place", () => {
    const signed = table({ name: ["a", "b"], v: [-5, 10] });
    const { scene, model } = build({
      marks: [bar(signed, { x: "v", y: "name" })],
      x: { type: "log" },
    });
    const inspection = model.inspect(scene.panels[0]!.plot.x + 5, model.yScale()!.map(0));
    expect(inspection?.label).toBe("b");
    expect(inspection?.points.every((p) => Number.isFinite(p.px))).toBe(true);
  });

  it("finds the bar of a category whose first row is missing", () => {
    const repeated = table({ name: ["a", "a"], v: [Number.NaN, 10] });
    const { scene, model } = build({ marks: [bar(repeated, { x: "v", y: "name" })] });
    const inspection = model.inspect(scene.panels[0]!.plot.x + 5, model.yScale()!.map(0))!;
    expect(inspection.points.map((p) => p.text)).toEqual(["10"]);
    const vertical = build({ marks: [bar(repeated, { x: "name", y: "v" })] });
    const plot = vertical.scene.panels[0]!.plot;
    const column = vertical.model.inspect(vertical.model.xScale()!.map(0), plot.y + 5)!;
    expect(column.points.map((p) => p.text)).toEqual(["10"]);
    // A row a log axis cannot place is skipped the same way.
    const signed = table({ name: ["a", "a"], v: [-1, 10] });
    const log = build({ marks: [bar(signed, { x: "name", y: "v" })], y: { type: "log" } });
    const logColumn = log.model.inspect(
      log.model.xScale()!.map(0),
      log.scene.panels[0]!.plot.y + 5,
    )!;
    expect(logColumn.points.map((p) => p.text)).toEqual(["10"]);
  });

  it("places the cursor along y whatever the tooltip mode", () => {
    for (const mode of ["nearest-y", "nearest", "nearest-x"] as const) {
      const { model } = build({ marks: [bar(sales, { x: "q1", y: "region" })], tooltip: { mode } });
      expect(model.cursorAxis()).toBe("y");
    }
    expect(build({ marks: [bar(sales, { x: "region", y: "q1" })] }).model.cursorAxis()).toBe("x");
  });

  it("names the category in nearest-point tooltips", () => {
    const { scene, model } = build({
      marks: [bar(sales, { x: "q1", y: "region" })],
      tooltip: { mode: "nearest" },
    });
    const x = model.xScale()!;
    const inspection = model.inspect(x.map(20) - 2, left(scene).ticks[1]!.position)!;
    expect([inspection.axis, inspection.label]).toEqual(["y", "S"]);
    expect(inspection.points.map((p) => p.text)).toEqual(["20"]);
  });

  it("needs a category y for several x fields", () => {
    const options = { x: ["q1", "q2"], y: "q1" } as never;
    expect(() => bar(sales, options)).toThrow(/several x fields/);
  });
});

describe("point", () => {
  it("draws every point and picks the nearest through its index", () => {
    const pts = table({ x: [0, 1, 2, 3], y: [0, 1, 0, 1], kind: ["a", "b", "a", "b"] });
    const { scene, model } = build({ marks: [point(pts, { x: "x", y: "y", series: "kind" })] });
    const geometry = scene.panels[0]!.marks as PointGeometry[];
    expect(geometry.map((g) => g.count)).toEqual([2, 2]);
    expect(model.tooltipMode()).toBe("nearest");
    const target = model.xScale()!.map(2);
    const inspection = model.inspect(target + 2, model.yScale()!.map(0) - 1)!;
    expect(inspection.value).toBe(2);
    expect(inspection.points[0]!.label).toBe("a");
  });

  it("leaves room for whole points at the plot edges", () => {
    const pts = table({ x: [0, 10, 3], y: [0, 7, 7], kind: ["a", "a", "b"] });
    const { scene } = build({ marks: [point(pts, { x: "x", y: "y", series: "kind", r: 4 })] });
    const { plot } = scene.panels[0]!;
    for (const g of scene.panels[0]!.marks as PointGeometry[]) {
      for (let i = 0; i < g.count; i++) {
        const [px, py] = [g.coords[i * 2]!, g.coords[i * 2 + 1]!];
        expect(px - 4).toBeGreaterThanOrEqual(plot.x - 0.01);
        expect(px + 4).toBeLessThanOrEqual(plot.x + plot.width + 0.01);
        expect(py - 4).toBeGreaterThanOrEqual(plot.y - 0.01);
        expect(py + 4).toBeLessThanOrEqual(plot.y + plot.height + 0.01);
      }
    }
  });

  it("leaves large series to a GPU painter only when asked", () => {
    const n = 120_000;
    const big = table({
      x: Float64Array.from({ length: n }, (_, i) => i % 1000),
      y: Float64Array.from({ length: n }, (_, i) => i % 7),
    });
    const small = table({ x: [1, 2], y: [3, 4] });
    const model = new ChartModel({
      locale: "en-US",
      marks: [point(big, { x: "x", y: "y" }), point(small, { x: "x", y: "y", id: "small" })],
    });
    model.setSize(600, 300, 1);
    const [cloud, few] = model.scene(estimateText, true).panels[0]!.marks as PointGeometry[];
    expect(cloud!.cloud).toMatchObject({ start: 0, end: n, version: big.version });
    expect(cloud!.coords).toHaveLength(0);
    expect(cloud!.count).toBe(n);
    expect(few!.cloud).toBeUndefined();
    expect(few!.count).toBe(2);
    // Without clouds (static rendering, export), every point is placed.
    const [placed] = model.scene(estimateText).panels[0]!.marks as PointGeometry[];
    expect(placed!.cloud).toBeUndefined();
    expect(placed!.count).toBe(n);
  });

  it("samples opaque points per device pixel only when asked", () => {
    const n = 20_000;
    const dense = table({
      x: Float64Array.from({ length: n }, (_, i) => i % 10),
      y: Float64Array.from({ length: n }, (_, i) => i % 7),
    });
    const count = (options: Partial<PointOptions<{ x: "number"; y: "number" }>>) =>
      (
        build({ marks: [point(dense, { x: "x", y: "y", ...options })] }).scene.panels[0]!
          .marks[0] as PointGeometry
      ).count;
    expect(count({})).toBe(n);
    expect(count({ sampling: "pixel" })).toBe(70);
    // Overlapping translucent points darken, so sampling must keep them all,
    // whether the opacity comes from fillOpacity or from the color.
    expect(count({ sampling: "pixel", fillOpacity: 0.5 })).toBe(n);
    expect(count({ sampling: "pixel", fill: "rgba(0, 0, 0, 0.5)" })).toBe(n);
    expect(count({ sampling: "pixel", fill: "#123456" })).toBe(70);
  });

  it("picks from each chart's own index when charts share a mark", () => {
    const pts = table({ x: [0, 10], y: [0, 10] });
    const mark = point(pts, { x: "x", y: "y" });
    build({ marks: [mark] }, 600, 300);
    const { model } = build({ marks: [mark] }, 300, 150);
    const inspection = model.inspect(model.xScale()!.map(10), model.yScale()!.map(10))!;
    expect(inspection.value).toBe(10);
  });

  it("does not pick points clipped out of view", () => {
    const pts = table({ x: [-1, 1], y: [5, 5] });
    const { model } = build({ marks: [point(pts, { x: "x", y: "y" })] });
    model.setViewport([0, 10]);
    const scene = model.scene(estimateText);
    expect((scene.panels[0]!.marks[0] as PointGeometry).count).toBe(1);
    const inspection = model.inspect(scene.panels[0]!.plot.x, model.yScale()!.map(5))!;
    expect(inspection.value).toBe(1);
  });

  it("snaps nearest-x tooltips to points inside the x domain", () => {
    const pts = table({ x: [-1, 1], y: [5, 5] });
    const { model } = build({
      tooltip: { mode: "nearest-x" },
      marks: [point(pts, { x: "x", y: "y" })],
    });
    model.setViewport([0, 10]);
    const scene = model.scene(estimateText);
    expect(model.inspect(scene.panels[0]!.plot.x, scene.panels[0]!.plot.y + 5)!.value).toBe(1);
    // Sorted series too: the nearest x inside [2.5, 5] to 2.5 is 3, not 2.
    const steps = table({ x: [0, 1, 2, 3, 4, 5, 6], v: [0, 1, 2, 3, 4, 5, 6] });
    const lines = build({ marks: [line(steps, { x: "x", y: "v" })] }).model;
    lines.setViewport([2.5, 5]);
    const plot = lines.scene(estimateText).panels[0]!.plot;
    expect(lines.inspect(plot.x, plot.y + 5)!.value).toBe(3);
  });

  it("honors an explicit nearest-x tooltip mode", () => {
    const pts = table({ x: [0, 1, 2], y: [3, 4, 5] });
    const { model } = build({
      tooltip: { mode: "nearest-x" },
      marks: [point(pts, { x: "x", y: "y" })],
    });
    expect(model.tooltipMode()).toBe("nearest-x");
    // Far below the point, but at its x.
    const inspection = model.inspect(model.xScale()!.map(1), model.yScale()!.map(3))!;
    expect(inspection.value).toBe(1);
    expect(inspection.points[0]!.value).toBe(4);
  });
});

describe("heatmap", () => {
  const cells = table({
    col: ["a", "b", "a", "b"],
    row: ["low", "low", "high", "high"],
    v: [0, 1, 2, Number.NaN],
  });

  it("rasterizes category rows top to bottom, in step with the axis", () => {
    const { scene } = build({ marks: [heatmap(cells, { x: "col", y: "row", value: "v" })] });
    const raster = scene.panels[0]!.marks[0] as RasterGeometry;
    expect([raster.columns, raster.rows]).toEqual([2, 2]);
    const alpha = (c: number, r: number) => raster.pixels[(r * 2 + c) * 4 + 3];
    // "low" is the first category, so the top row; the missing cell (b, high) is transparent.
    const ticks = scene.panels[0]!.axes.find((a) => a.orient === "left")!.ticks;
    expect(ticks.map((t) => t.label)).toEqual(["low", "high"]);
    expect(ticks[0]!.position).toBeLessThan(raster.y + raster.height / 2);
    expect(alpha(1, 0)).toBe(255);
    expect(alpha(1, 1)).toBe(0);
    expect(raster.width).toBeCloseTo(scene.panels[0]!.plot.width, 0);
    expect(raster.height).toBeCloseTo(scene.panels[0]!.plot.height, 0);
  });

  it("rasterizes rows of numbers bottom to top, like a numeric axis", () => {
    const grid = table({ x: ["a", "a"], y: [1, 2], v: [Number.NaN, 5] });
    const { scene } = build({ marks: [heatmap(grid, { x: "x", y: "y", value: "v" })] });
    const raster = scene.panels[0]!.marks[0] as RasterGeometry;
    const ticks = scene.panels[0]!.axes.find((a) => a.orient === "left")!.ticks;
    expect(ticks.map((t) => t.label)).toEqual(["1", "2"]);
    expect(ticks[0]!.position).toBeGreaterThan(ticks[1]!.position);
    // y = 2 (the only value) is the top raster row.
    expect(raster.pixels[3]).toBe(255);
    expect(raster.pixels[7]).toBe(0);
  });

  it("uses distinct numbers as ordered columns", () => {
    const grid = table({ x: [3, 1, 2, 1], y: [0, 0, 0, 1], v: [1, 2, 3, 4] });
    const { scene } = build({ marks: [heatmap(grid, { x: "x", y: "y", value: "v" })] });
    expect(
      scene.panels[0]!.axes.find((a) => a.orient === "bottom")!.ticks.map((t) => t.label),
    ).toEqual(["1", "2", "3"]);
  });

  it("finds the cell under the pointer", () => {
    const { model } = build({ marks: [heatmap(cells, { x: "col", y: "row", value: "v" })] });
    const inspection = model.inspect(model.xScale()!.map(1), model.yScale()!.map(0))!;
    expect(inspection.label).toBe("b");
    expect(inspection.points[0]).toMatchObject({ label: "low", value: 1, text: "1" });
    expect(model.inspect(model.xScale()!.map(1), model.yScale()!.map(1))).toBeUndefined();
  });

  it("keeps numbers whose labels coincide in separate columns", () => {
    const close = table({ x: [1.001, 1.002], y: [0, 0], v: [1, 2] });
    const { scene } = build({ marks: [heatmap(close, { x: "x", y: "y", value: "v" })] });
    expect((scene.panels[0]!.marks[0] as RasterGeometry).columns).toBe(2);
  });

  it("finds cells after another mark changes the band order", () => {
    const later = table({ col: ["b", "c"], row: ["r", "r"], v: [1, 2] });
    const earlier = table({ col: ["a"], row: ["r"], v: [3] });
    const mark = heatmap(later, { x: "col", y: "row", value: "v" });
    const { model } = build({ marks: [mark] });
    expect(model.inspect(model.xScale()!.map(0), model.yScale()!.map(0))!.label).toBe("b");
    model.update({
      locale: "en-US",
      timeZone: "UTC",
      marks: [heatmap(earlier, { x: "col", y: "row", value: "v" }), mark],
    });
    model.scene(estimateText);
    const at = (column: number) =>
      model.inspect(model.xScale()!.map(column), model.yScale()!.map(0))!;
    expect(at(0).points.map((p) => p.value)).toEqual([3]);
    expect(at(1)).toMatchObject({ label: "b", points: [{ value: 1 }] });
  });

  it("reports the cell under the pointer even in nearest-x mode", () => {
    const column = table({ c: ["a", "a"], r: ["r1", "r2"], v: [Number.NaN, 10] });
    const { model } = build({
      tooltip: { mode: "nearest-x" },
      marks: [heatmap(column, { x: "c", y: "r", value: "v" })],
    });
    expect(model.tooltipMode()).toBe("nearest");
    const [px, py] = [model.xScale()!.map(0), model.yScale()!.map(1)];
    for (const mode of [undefined, "nearest-x", "nearest"] as const) {
      expect(model.inspect(px, py, mode)!.points).toMatchObject([{ label: "r2", value: 10 }]);
    }
  });

  it("reports the visible layer of overlapping heatmaps", () => {
    const below = table({ c: ["a", "b"], r: ["r", "r"], v: [1, 1] });
    const above = table({ c: ["a", "b"], r: ["r", "r"], v: [2, Number.NaN] });
    const { model } = build({
      marks: [
        heatmap(below, { x: "c", y: "r", value: "v" }),
        heatmap(above, { x: "c", y: "r", value: "v" }),
      ],
    });
    const at = (column: number) =>
      model.inspect(model.xScale()!.map(column), model.yScale()!.map(0))!.points[0]!.value;
    // The upper layer covers "a"; its missing "b" cell shows the layer below.
    expect(at(0)).toBe(2);
    expect(at(1)).toBe(1);
  });

  it("keeps an earlier value when a later row for the cell is missing", () => {
    const repeated = table({ c: ["a", "a"], r: ["r", "r"], v: [5, Number.NaN] });
    const { scene, model } = build({ marks: [heatmap(repeated, { x: "c", y: "r", value: "v" })] });
    expect((scene.panels[0]!.marks[0] as RasterGeometry).pixels[3]).toBe(255);
    expect(model.inspect(model.xScale()!.map(0), model.yScale()!.map(0))!.points[0]!.value).toBe(5);
  });

  it("rejects colors the raster cannot read", () => {
    expect(() =>
      heatmap(cells, { x: "col", y: "row", value: "v", colors: ["white", "red"] }),
    ).toThrow(/hex colors/);
    expect(() => build({ theme: { sequential: ["#fff", "#0008"] }, marks: [] })).toThrow(
      /hex colors/,
    );
  });

  it("refuses grids beyond the cell limit", () => {
    const side = Math.ceil(Math.sqrt(MAX_CELLS)) + 1;
    const diagonal = Float64Array.from({ length: side }, (_, i) => i);
    const sparse = table({ x: diagonal, y: diagonal, v: diagonal });
    expect(() => build({ marks: [heatmap(sparse, { x: "x", y: "y", value: "v" })] })).toThrow(
      /exceeds the limit/,
    );
  });

  it("shows a color legend instead of series entries", () => {
    const { scene } = build({
      marks: [heatmap(cells, { x: "col", y: "row", value: "v", label: "Load" })],
    });
    expect(scene.legend).toEqual([]);
    expect(scene.colorLegend).toMatchObject({
      title: { text: "Load" },
      low: { text: "0" },
      high: { text: "2" },
    });
  });
});
