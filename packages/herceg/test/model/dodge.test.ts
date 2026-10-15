// Points and error bars in the bands of a category axis: dodged series side
// by side as grouped bars are, and jittered points spread across their band.
import { describe, expect, it } from "vitest";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { bar } from "../../src/marks/bar.ts";
import { boxplot } from "../../src/marks/boxplot.ts";
import { jitterOf } from "../../src/marks/dodge.ts";
import { errorBar } from "../../src/marks/errorbar.ts";
import { histogram } from "../../src/marks/histogram.ts";
import { legendKey } from "../../src/marks/mark.ts";
import { point } from "../../src/marks/point.ts";
import { facet } from "../../src/model/facet.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { panels } from "../../src/model/panels.ts";
import type { PointGeometry, RectGeometry, Scene, SegmentGeometry } from "../../src/scene/scene.ts";
import { validateSpec } from "../../src/spec/validate.ts";
import { positionOf } from "../helpers/keyboard.ts";

function build(config: ChartConfig) {
  const model = new ChartModel({ locale: "en-US", timeZone: "UTC", ...config });
  model.setSize(600, 300, 1);
  return model;
}

const of = <G>(scene: Scene, kind: string, panel = 0) =>
  scene.panels[panel]!.marks.filter((m) => m.kind === kind) as unknown as G[];
const centers = (bars: RectGeometry) =>
  Array.from({ length: bars.count }, (_, i) => bars.rects[i * 4]! + bars.rects[i * 4 + 2]! / 2);
const stems = (segments: SegmentGeometry) =>
  // Each interval is a stem and two caps; stems come first.
  Array.from({ length: segments.count / 3 }, (_, i) => segments.coords[i * 12]!);
const xs = (points: PointGeometry) =>
  Array.from({ length: points.count }, (_, i) => points.coords[i * 2]!);

const summary = table({
  day: ["thu", "thu", "thu", "fri", "fri", "fri"],
  sex: ["f", "m", "x", "f", "m", "x"],
  mean: [2, 3, 4, 5, 6, 7],
  low: [1, 2, 3, 4, 5, 6],
  high: [3, 4, 5, 6, 7, 8],
});

describe("dodge", () => {
  it("stands error bars and points on their grouped bars", () => {
    const model = build({
      marks: [
        bar(summary, { x: "day", y: "mean", series: "sex" }),
        errorBar(summary, { x: "day", y1: "low", y2: "high", series: "sex", dodge: true }),
        point(summary, { x: "day", y: "mean", series: "sex", dodge: true }),
      ],
    });
    const scene = model.scene(estimateText);
    const bars = of<RectGeometry>(scene, "rect");
    const intervals = of<SegmentGeometry>(scene, "segments");
    const points = of<PointGeometry>(scene, "point");
    for (let s = 0; s < 3; s++) {
      const expected = centers(bars[s]!);
      expect(stems(intervals[s]!).map((v) => Math.round(v * 100))).toEqual(
        expected.map((v) => Math.round(v * 100)),
      );
      expect(xs(points[s]!).map((v) => Math.round(v * 100))).toEqual(
        expected.map((v) => Math.round(v * 100)),
      );
    }
    // Inspection reports each point where it is drawn, and picks it there.
    const [first] = xs(points[2]!);
    const y = model.yScale()!.map(4);
    const found = model.inspect(first!, y, "nearest")!;
    expect(found.points.map(({ label, value }) => [label, value])).toEqual([["x", 4]]);
    expect(found.points[0]!.px).toBeCloseTo(first!, 3);
  });

  it("regroups around series hidden with their legend group, as bars do", () => {
    const model = build({
      marks: [
        bar(summary, { x: "day", y: "mean", series: "sex", legendGroup: "sex" }),
        errorBar(summary, {
          x: "day",
          y1: "low",
          y2: "high",
          series: "sex",
          dodge: true,
          legendGroup: "sex",
        }),
      ],
    });
    model.hidden.add(legendKey("sex", "m"));
    const scene = model.scene(estimateText);
    const bars = of<RectGeometry>(scene, "rect");
    const intervals = of<SegmentGeometry>(scene, "segments");
    expect(bars).toHaveLength(2);
    expect(intervals).toHaveLength(2);
    for (let s = 0; s < 2; s++)
      expect(stems(intervals[s]!).map(Math.round)).toEqual(centers(bars[s]!).map(Math.round));
  });

  it("works along y", () => {
    const model = build({
      marks: [
        bar(summary, { x: "mean", y: "day", series: "sex" }),
        errorBar(summary, { y: "day", x1: "low", x2: "high", series: "sex", dodge: true }),
      ],
    });
    const scene = model.scene(estimateText);
    const bars = of<RectGeometry>(scene, "rect");
    const intervals = of<SegmentGeometry>(scene, "segments");
    const middle = (b: RectGeometry, i: number) => b.rects[i * 4 + 1]! + b.rects[i * 4 + 3]! / 2;
    for (let s = 0; s < 3; s++)
      expect(Math.round(intervals[s]!.coords[1]!)).toBe(Math.round(middle(bars[s]!, 0)));
  });

  it("dodges each panel's series", () => {
    const rows = table({
      day: ["thu", "thu", "fri", "fri"],
      sex: ["f", "m", "f", "m"],
      mean: [1, 2, 3, 4],
      site: ["a", "a", "b", "b"],
    });
    const model = build({
      marks: [
        bar(rows, { x: "day", y: "mean", series: "sex" }),
        point(rows, { x: "day", y: "mean", series: "sex", dodge: true }),
      ],
      facet: facet("site"),
    });
    const scene = model.scene(estimateText);
    for (const panel of [0, 1]) {
      const bars = of<RectGeometry>(scene, "rect", panel).filter((b) => b.count > 0);
      const points = of<PointGeometry>(scene, "point", panel).filter((p) => p.count > 0);
      expect(points.map((p) => Math.round(xs(p)[0]!))).toEqual(
        bars.map((b) => Math.round(centers(b)[0]!)),
      );
    }
  });

  it("needs a series field and one category position", () => {
    const rows = table({ day: ["thu"], sex: ["f"], v: [1], n: [2] });
    expect(() => point(rows, { x: "day", y: "v", dodge: true })).toThrow(/series field/);
    expect(() => point(rows, { x: "n", y: "v", series: "sex", dodge: true })).toThrow(
      /one category position/,
    );
    expect(() => point(rows, { x: "day", y: "sex", series: "sex", dodge: true })).toThrow(
      /one category position/,
    );
    expect(() => errorBar(rows, { x: "n", y1: "v", y2: "v", series: "sex", dodge: true })).toThrow(
      /category positions/,
    );
    expect(() => errorBar(rows, { x: "day", y1: "v", y2: "v", dodge: true })).toThrow(
      /series field/,
    );
  });
});

describe("jitter", () => {
  const strip = table({
    day: Array.from({ length: 200 }, (_, i) => (i % 2 ? "thu" : "fri")),
    tip: Array.from({ length: 200 }, (_, i) => (i % 17) / 2),
  });

  it("spreads points over a share of their band, by row and seed", () => {
    const model = build({
      marks: [point(strip, { x: "day", y: "tip", jitter: { width: 0.5, seed: 3 } })],
    });
    const scene = model.scene(estimateText);
    const [points] = of<PointGeometry>(scene, "point");
    const x = model.xScale()!;
    const band = Math.abs(x.bandwidth!);
    const offsets = xs(points!).map((px, i) => px - x.map(i % 2 ? 1 : 0));
    // Rows are drawn in order: row i at its band's center plus its jitter.
    offsets.forEach((offset, i) => {
      expect(offset).toBeCloseTo((jitterOf(i, 3) - 0.5) * 0.5 * band, 3);
    });
    expect(Math.max(...offsets.map(Math.abs))).toBeLessThanOrEqual(band / 4);
    expect(Math.max(...offsets) - Math.min(...offsets)).toBeGreaterThan(band / 3);
    // The same rows land in the same places, frame after frame.
    expect(xs(of<PointGeometry>(model.scene(estimateText), "point")[0]!)).toEqual(xs(points!));
  });

  it("keeps a row's place as rows stream in and out", () => {
    const live = table({ day: ["thu", "fri", "thu"], tip: [1, 2, 3] }, { maxRows: 3 });
    const model = build({ marks: [point(live, { x: "day", y: "tip", jitter: { width: 1 } })] });
    const before = xs(of<PointGeometry>(model.scene(estimateText), "point")[0]!);
    live.append({ day: ["fri"], tip: [4] });
    const after = xs(of<PointGeometry>(model.scene(estimateText), "point")[0]!);
    // Rows 1 and 2 moved to the front; their points did not move.
    expect(after.slice(0, 2)).toEqual(before.slice(1));
  });

  it("stays within a dodged series' share, and reports where points are drawn", () => {
    const rows = table({
      day: Array.from({ length: 40 }, (_, i) => (i < 20 ? "thu" : "fri")),
      sex: Array.from({ length: 40 }, (_, i) => (i % 2 ? "f" : "m")),
      tip: Array.from({ length: 40 }, (_, i) => i),
    });
    const model = build({
      marks: [
        bar(rows, { x: "day", y: "tip", series: "sex" }),
        point(rows, { x: "day", y: "tip", series: "sex", dodge: true, jitter: { width: 1 } }),
      ],
    });
    const scene = model.scene(estimateText);
    const bars = of<RectGeometry>(scene, "rect");
    const points = of<PointGeometry>(scene, "point");
    points.forEach((p, s) => {
      const lo = Math.min(
        ...Array.from({ length: bars[s]!.count }, (_, i) => bars[s]!.rects[i * 4]!),
      );
      const share = Math.abs(model.xScale()!.bandwidth!) / 2;
      for (const px of xs(p)) {
        const band = px < 300 ? 0 : 1;
        const center = model.xScale()!.map(band) - share / 2 + s * share;
        expect(Math.abs(px - center)).toBeLessThanOrEqual(share / 2 + 1e-3);
      }
      expect(lo).toBeGreaterThan(0);
    });
    const [first] = xs(points[1]!);
    const y = model.yScale()!;
    const at = points[1]!.coords[1]!;
    const found = model.inspect(first!, at, "nearest")!;
    expect(found.points[0]!.px).toBeCloseTo(first!, 3);
    expect(found.points[0]!.value).toBeCloseTo(y.invert(at), 4);
  });

  it("needs one category position and a width from 0 to 1", () => {
    const rows = table({ day: ["thu"], v: [1], n: [2] });
    expect(() => point(rows, { x: "n", y: "v", jitter: { width: 0.5 } })).toThrow(
      /one category position/,
    );
    expect(() => point(rows, { x: "day", y: "v", jitter: { width: 2 } })).toThrow(/from 0 to 1/);
    expect(() => point(rows, { x: "day", y: "v", jitter: { width: 0.5, seed: 0.5 } })).toThrow(
      /whole number/,
    );
  });
});

describe("dodge and jitter in specs", () => {
  const spec = (mark: Record<string, unknown>) => ({
    data: { d: { columns: { day: ["thu"], sex: ["f"], v: [1] } } },
    marks: [{ type: "point", x: "day", y: "v", series: "sex", ...mark }],
  });

  it("load", () => {
    expect(() =>
      validateSpec(spec({ dodge: true, jitter: { width: 0.2, seed: 4 } })),
    ).not.toThrow();
  });

  it("check their values", () => {
    expect(() => validateSpec(spec({ jitter: { width: 2 } }))).toThrow(/jitter\.width/);
    expect(() => validateSpec(spec({ jitter: { seed: 1 } }))).toThrow(/jitter.*width/);
    expect(() => validateSpec(spec({ jitter: { width: 0.2, seed: 1.5 } }))).toThrow(
      /jitter\.seed.*whole number/,
    );
  });
});

describe("dodge across marks and panels", () => {
  it("places repeated marks by each panel's own bands", () => {
    const rows = table({ day: ["thu", "fri"], sex: ["f", "m"], v: [1, 2] });
    const model = build({
      marks: [point(rows, { x: "day", y: "v", series: "sex", dodge: true, panel: "*" })],
      panels: panels([{ id: "wide" }, { id: "narrow" }], { columns: 2, columnWidths: [3, 1] }),
    });
    const scene = model.scene(estimateText);
    for (const [index, panel] of [
      [0, "wide"],
      [1, "narrow"],
    ] as const) {
      const [f] = of<PointGeometry>(scene, "point", index);
      const [px, py] = [f!.coords[0]!, f!.coords[1]!];
      const found = model.inspect(px, py, "nearest", panel)!;
      expect(found.points[0]!.px).toBeCloseTo(px, 3);
    }
  });

  it("stands a legend group's marks on the group's series, whatever each mark has", () => {
    const bars = table({ day: ["thu", "thu"], sex: ["f", "m"], v: [2, 3] });
    // Intervals for one sex only, in another dictionary order.
    const intervals = table({ day: ["thu"], sex: ["m"], lo: [2], hi: [4] });
    const model = build({
      marks: [
        bar(bars, { x: "day", y: "v", series: "sex", legendGroup: "sex" }),
        errorBar(intervals, {
          x: "day",
          y1: "lo",
          y2: "hi",
          series: "sex",
          dodge: true,
          legendGroup: "sex",
        }),
      ],
    });
    const scene = model.scene(estimateText);
    const [, m] = of<RectGeometry>(scene, "rect");
    const [stem] = of<SegmentGeometry>(scene, "segments");
    expect(Math.round(stems(stem!)[0]!)).toBe(Math.round(centers(m!)[0]!));
    // Hiding f gives m the whole band in both marks.
    model.hidden.add(legendKey("sex", "f"));
    const after = model.scene(estimateText);
    const [onlyM] = of<RectGeometry>(after, "rect");
    const [stemM] = of<SegmentGeometry>(after, "segments");
    expect(Math.round(stems(stemM!)[0]!)).toBe(Math.round(centers(onlyM!)[0]!));
  });

  it("stands box plots of a legend group in the group's slots", () => {
    const tips = table({ day: ["thu", "thu", "thu"], sex: ["m", "m", "m"], v: [1, 2, 3] });
    const both = table({ day: ["thu", "thu"], sex: ["f", "m"], v: [2, 2] });
    const model = build({
      marks: [
        boxplot(tips, { x: "day", y: "v", series: "sex", legendGroup: "sex" }),
        point(both, { x: "day", y: "v", series: "sex", dodge: true, legendGroup: "sex" }),
      ],
    });
    const scene = model.scene(estimateText);
    const [box] = of<RectGeometry>(scene, "rect");
    // The box's outliers come first.
    const [f, m] = of<PointGeometry>(scene, "point").slice(-2);
    expect(centers(box!)[0]).toBeCloseTo(xs(m!)[0]!, 3);
    expect(xs(f!)[0]).not.toBeCloseTo(xs(m!)[0]!, 0);
  });

  it("reports side-by-side boxes where they are drawn, either way up and in each panel", () => {
    const tips = table({
      day: ["thu", "thu", "thu", "thu", "thu", "thu"],
      sex: ["f", "f", "f", "m", "m", "m"],
      v: [1, 2, 3, 4, 5, 6],
    });
    for (const horizontal of [false, true]) {
      const model = build({
        marks: [
          boxplot(tips, {
            ...(horizontal ? { x: "v", y: "day" } : { x: "day", y: "v" }),
            series: "sex",
            panel: "*",
          } as never),
        ],
        panels: panels([{ id: "wide" }, { id: "narrow" }], { columns: 2, columnWidths: [3, 1] }),
      });
      const scene = model.scene(estimateText);
      for (const [index, panel] of [
        [0, "wide"],
        [1, "narrow"],
      ] as const) {
        of<RectGeometry>(scene, "rect", index).forEach((box, s) => {
          const [x, y, w, h] = [box.rects[0]!, box.rects[1]!, box.rects[2]!, box.rects[3]!];
          const center = horizontal ? y + h / 2 : x + w / 2;
          const found = model.inspect(x + w / 2, y + h / 2, "nearest", panel)!.points[0]!;
          expect(found.label).toBe(s ? "m" : "f");
          expect(horizontal ? found.py : found.px).toBeCloseTo(center, 3);
        });
      }
    }
  });

  it("reports grouped bars where they are drawn, either way up and in each panel", () => {
    const rows = table({
      day: ["thu", "thu", "fri", "fri"],
      sex: ["f", "m", "f", "m"],
      v: [2, 3, 4, 5],
    });
    for (const horizontal of [false, true]) {
      const model = build({
        marks: [
          bar(rows, {
            ...(horizontal ? { x: "v", y: "day" } : { x: "day", y: "v" }),
            series: "sex",
            panel: "*",
          } as never),
        ],
        panels: panels([{ id: "wide" }, { id: "narrow" }], { columns: 2, columnWidths: [3, 1] }),
      });
      const scene = model.scene(estimateText);
      for (const [index, panel] of [
        [0, "wide"],
        [1, "narrow"],
      ] as const) {
        of<RectGeometry>(scene, "rect", index).forEach((bars, s) => {
          const [x, y, w, h] = [bars.rects[0]!, bars.rects[1]!, bars.rects[2]!, bars.rects[3]!];
          const center = horizontal ? y + h / 2 : x + w / 2;
          const tip = horizontal ? [x + w, center] : [center, y];
          const found = model.inspect(tip[0]!, tip[1]!, "nearest", panel)!.points[0]!;
          expect(found.label).toBe(s ? "m" : "f");
          expect(horizontal ? found.py : found.px).toBeCloseTo(center, 3);
        });
      }
    }
  });

  it("reports a legend group's bar in the group's slot", () => {
    const tips = table({ day: ["thu"], sex: ["m"], v: [3] });
    const both = table({ day: ["thu", "thu"], sex: ["f", "m"], v: [1, 1] });
    const model = build({
      marks: [
        bar(tips, { x: "day", y: "v", series: "sex", legendGroup: "sex" }),
        point(both, { x: "day", y: "v", series: "sex", dodge: true, legendGroup: "sex" }),
      ],
    });
    const [m] = of<RectGeometry>(model.scene(estimateText), "rect");
    const center = m!.rects[0]! + m!.rects[2]! / 2;
    const found = model.inspect(center, m!.rects[1]!, "nearest")!.points[0]!;
    expect(found.label).toBe("m");
    expect(found.px).toBeCloseTo(center, 3);
  });

  it("inspects dodged histogram bars where they are drawn", () => {
    const rows = table({ v: [1, 1, 3, 1, 1, 3], g: ["a", "a", "a", "b", "b", "b"] });
    const model = build({
      marks: [histogram(rows, { x: "v", bins: [0, 2, 4], series: "g", dodge: true })],
    });
    const scene = model.scene(estimateText);
    const bars = of<RectGeometry>(scene, "rect");
    for (const [s, label] of [
      [0, "a"],
      [1, "b"],
    ] as const) {
      const [x, y, w] = [bars[s]!.rects[0]!, bars[s]!.rects[1]!, bars[s]!.rects[2]!];
      const found = model.inspect(x + w / 2, y + 2, "nearest")!;
      expect(found.points.map((p) => p.label)).toEqual([label]);
      expect(found.points[0]!.px).toBeCloseTo(x + w / 2, 3);
    }
  });

  it("reads no dodged bin a log axis cannot draw", () => {
    const rows = table({ v: [2, 6, 2, 6], g: ["a", "a", "b", "b"] });
    const model = build({
      marks: [histogram(rows, { x: "v", bins: [-1, 4, 8], series: "g", dodge: true })],
      x: { type: "log" },
    });
    const scene = model.scene(estimateText);
    // Only the second bin is drawn, a bar per series.
    expect(of<RectGeometry>(scene, "rect").map((bars) => bars.count)).toEqual([1, 1]);
    const [a] = model.series();
    expect(positionOf(model, a!.key, 0)).toBeUndefined();
    const second = positionOf(model, a!.key, 1)!.points;
    expect(second.every((p) => Number.isFinite(p.px))).toBe(true);
  });

  it("finds a dodged bar past a nearby point of another mark", () => {
    const rows = table({ v: [1, 1, 3, 1, 1, 3], g: ["a", "a", "a", "b", "b", "b"] });
    const bars = histogram(rows, { x: "v", bins: [0, 2, 4], series: "g", dodge: true, label: "h" });
    const near = (x: number) =>
      build({ marks: [point(table({ x: [x], y: [2] }), { x: "x", y: "y", label: "p" }), bars] });
    const first = near(1);
    const [a] = of<RectGeometry>(first.scene(estimateText), "rect");
    const [left, top, width] = [a!.rects[0]!, a!.rects[1]!, a!.rects[2]!];
    // A point a pixel and a half from bar a's anchor, which is its share's top center.
    const model = near(first.xScale()!.invert(left + width / 2 + 1.5));
    model.scene(estimateText);
    const found = model.inspect(left + width / 2, top, "nearest")!;
    expect(found.points[0]!.label).toBe("a");
  });
});
