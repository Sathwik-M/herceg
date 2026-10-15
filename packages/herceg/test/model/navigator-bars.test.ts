import { describe, expect, it, vi } from "vitest";
import { encodedCategory } from "../../src/data/column.ts";
import { col } from "../../src/data/expr.ts";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { type BarMark, bar } from "../../src/marks/bar.ts";
import type { ChartMark, Frame } from "../../src/marks/mark.ts";
import { facet } from "../../src/model/facet.ts";
import { ChartModel } from "../../src/model/model.ts";
import { rangeNavigator } from "../../src/model/navigator.ts";
import { overviewBars } from "../../src/model/navigator-bars.ts";
import { staticCompilers } from "../../src/render/compilers.ts";
import { LinearScale, LogScale } from "../../src/scale/scale.ts";
import type { RectGeometry, TextGeometry } from "../../src/scene/scene.ts";
import { LIGHT } from "../../src/theme.ts";

/** Compare full bar geometry and the strip at the same scales and column width. */
function drawing(input: ChartMark, axes: Partial<Frame> = {}) {
  const mark = input as BarMark;
  const model = new ChartModel({ marks: [mark] }, undefined, ...staticCompilers());
  model.setSize(600, 300, 1);
  const drawing = vi.spyOn(mark, "geometry");
  model.scene(estimateText);
  const [series, source] = drawing.mock.calls[0]!;
  drawing.mockRestore();
  const frame: Frame = {
    ...source,
    x: new LinearScale([0, 10], [20, 30]),
    y: new LinearScale([-20, 20], [42, 8]),
    plot: { x: 20, y: 5, width: 10, height: 40 },
    theme: { ...source.theme, style: { ...source.theme.style, bar: { radius: 0 } } },
    keyed: false,
    floats: (_key, _stage, length) => new Float32Array(length),
    doubles: (_key, _stage, length) => new Float64Array(length),
    bytes: (_key, _stage, length) => new Uint8ClampedArray(length),
    ...axes,
  };
  const exactGeometry = mark.geometry(series, frame);
  const reducedGeometry = overviewBars(mark, series, frame, 0);
  const exact = exactGeometry.filter((g): g is RectGeometry => g.kind === "rect");
  const reduced = reducedGeometry.filter((g): g is RectGeometry => g.kind === "rect");
  return { exact, reduced, series, frame, exactGeometry, reducedGeometry };
}

function envelope(marks: RectGeometry[], columns: number, origin = 20) {
  const out = Array.from({ length: columns }, () => [Infinity, -Infinity]);
  for (const mark of marks) {
    for (let i = 0; i < mark.count; i++) {
      const r = mark.rects.subarray(i * 4, i * 4 + 4);
      if (!(r[2]! > 0 && r[3]! > 0)) continue;
      const first = Math.max(0, Math.floor(r[0]! - origin));
      const last = Math.min(columns, Math.ceil(r[0]! + r[2]! - origin));
      for (let column = first; column < last; column++) {
        out[column]![0] = Math.min(out[column]![0]!, r[1]!);
        out[column]![1] = Math.max(out[column]![1]!, r[1]! + r[3]!);
      }
    }
  }
  return out;
}

function sameEnvelope(exact: RectGeometry[], reduced: RectGeometry[], columns = 10) {
  const expected = envelope(exact, columns);
  const actual = envelope(reduced, columns);
  for (let c = 0; c < columns; c++) {
    for (let side = 0; side < 2; side++) {
      if (Number.isFinite(expected[c]![side]!))
        expect(actual[c]![side]).toBeCloseTo(expected[c]![side]!, 5);
      else expect(actual[c]![side]).toBe(expected[c]![side]);
    }
  }
}

describe("bar overviews", () => {
  it("preserves the exact positive and negative envelope in every column", () => {
    const data = table({
      t: Float64Array.from({ length: 80 }, (_, i) => (i + 0.5) / 8),
      v: Float64Array.from({ length: 80 }, (_, i) => ((i * 13) % 39) - 19),
    });
    for (const y of [new LinearScale([-20, 20], [42, 8]), new LinearScale([20, -20], [42, 8])]) {
      const { exact, reduced } = drawing(bar(data, { x: "t", y: "v" }), { y });
      expect(exact[0]!.count).toBe(80);
      expect(reduced[0]!.count).toBe(20);
      sameEnvelope(exact, reduced);
      expect(reduced[0]!.rects.length).toBe(80);
    }
  });

  it("uses winning colors with first-series/row ties in overlapping footprints", () => {
    const data = table({
      t: Array.from({ length: 40 }, (_, i) => (i + 0.5) / 4),
      v: Array.from({ length: 40 }, (_, i) => [10, 10, -5, -12][i % 4]!),
      color: Array.from({ length: 40 }, (_, i) => (i % 2 ? "blue" : "red")),
    });
    const { reduced, series } = drawing(
      bar(data, { x: "t", y: "v", series: "color", fillOpacity: 0.4 }),
    );
    expect(reduced.map((g) => [g.fill, g.count])).toEqual(series.map((s) => [s.color, 10]));
    expect(reduced.every((g) => g.fillOpacity === 0.4)).toBe(true);
    expect(reduced[0]!.rects[0]).toBe(20);
    expect(reduced[1]!.rects[0]).toBe(20);
    // The equal positive tips keep red (the first series), while blue's
    // negative bar reaches farther than red's, so each sign keeps its color.
    expect(reduced[0]!.rects[1]).toBeCloseTo(16.5);
    expect(reduced[1]!.rects[3]).toBeCloseTo(10.2);
  });

  it("draws each look's winners in its paint, and lets bars drawn without fill win nothing", () => {
    const data = table({
      t: Array.from({ length: 40 }, (_, i) => (i + 0.5) / 4),
      v: Array.from({ length: 40 }, (_, i) => 1 + (i % 4)),
      kind: Array.from({ length: 40 }, (_, i) => (i < 20 ? "a" : "b")),
    });
    const { reduced } = drawing(
      bar(data, {
        x: "t",
        y: "v",
        color: "kind",
        fillOpacity: 0.5,
        encode: {
          // biome-ignore lint/suspicious/noThenProperty: a condition's branch, as specs name it.
          opacity: { condition: { when: col("kind").eq("b"), then: 0, otherwise: 0.8 } },
        },
      }),
    );
    expect(reduced.map((g) => [g.fill, g.fillOpacity, g.count])).toEqual([
      [LIGHT.palette[0], 0.4, 5],
    ]);
    // Short bars show under tall ones nothing draws.
    const pairs = table({
      t: Array.from({ length: 40 }, (_, i) => (i + 0.5) / 4),
      tall: Array.from({ length: 40 }, () => 15),
      short: Array.from({ length: 40 }, () => 5),
    });
    const under = drawing(
      bar(pairs, {
        x: "t",
        y: ["tall", "short"],
        style: { by: { map: { tall: { opacity: 0 } } } },
      }),
    );
    expect(under.reduced.map((g) => [g.fill, g.count])).toEqual([[LIGHT.palette[1], 10]]);
    // Or a fill of no alpha.
    const clear = drawing(
      bar(pairs, {
        x: "t",
        y: ["tall", "short"],
        style: { by: { map: { tall: { fill: "#ff000000" } } } },
      }),
    );
    const short = clear.series.find((s) => s.key.includes("short"))!;
    expect(clear.reduced.map((g) => [g.fill, g.count])).toEqual([[short.color, 10]]);
  });

  it("draws looks in their paints where few bars draw, and in stacks", () => {
    // Five bars in forty rows: drawn exactly, as the mark draws them.
    const sparse = table({
      t: Array.from({ length: 40 }, (_, i) => (i + 0.5) / 4),
      v: Array.from({ length: 40 }, (_, i) => (i % 8 === 0 ? 5 : Number.NaN)),
      kind: Array.from({ length: 40 }, (_, i) => (i < 20 ? "a" : "b")),
    });
    const few = drawing(
      bar(sparse, {
        x: "t",
        y: "v",
        encode: {
          // biome-ignore lint/suspicious/noThenProperty: a condition's branch, as specs name it.
          opacity: { condition: { when: col("kind").eq("b"), then: 0, otherwise: 1 } },
        },
      }),
    );
    expect(few.reduced.map((g) => [g.fillOpacity, g.count])).toEqual([
      [1, 3],
      [0, 2],
    ]);
    // Outlines in the background's color, given only their width, and of unfilled bars.
    const outlined = drawing(bar(sparse, { x: "t", y: "v", strokeWidth: 2 }));
    expect(outlined.reduced[0]!.edge?.width).toBe(2);
    const hollow = drawing(bar(sparse, { x: "t", y: "v", fillOpacity: 0, stroke: "#000000" }));
    expect(hollow.reduced.map((g) => [g.count, g.edge?.stroke])).toEqual([[5, "#000000"]]);
    const layers = table({
      t: Array.from({ length: 40 }, (_, i) => (i + 0.5) / 4),
      a: Array.from({ length: 40 }, () => 5),
      b: Array.from({ length: 40 }, () => 3),
    });
    const stacked = drawing(
      bar(layers, {
        x: "t",
        y: ["a", "b"],
        stack: true,
        style: { by: { map: { a: { opacity: 0 }, b: { opacity: 0.4 } } } },
      }),
    );
    expect(stacked.reduced.map((g) => g.fillOpacity)).toEqual([0, 0.4]);
  });

  it("selects complete signed stacks instead of summing maxima from different rows", () => {
    const data = table({
      t: Float64Array.from({ length: 40 }, (_, i) => (i + 0.5) / 4),
      a: Float64Array.from({ length: 40 }, (_, i) => [9, 1, -2, -8][i % 4]!),
      b: Float64Array.from({ length: 40 }, (_, i) => [1, 8, -9, -1][i % 4]!),
    });
    const { exact, reduced } = drawing(bar(data, { x: "t", y: ["a", "b"], stack: true }));
    sameEnvelope(exact, reduced);
    expect(reduced.map((g) => g.count)).toEqual([20, 20]);
    // Positive winner has segments 9 + 1, negative winner -2 + -9.
    expect(reduced[0]!.rects[3]).toBeCloseTo(9 * 0.85);
    expect(reduced[1]!.rects[3]).toBeCloseTo(0.85);
    expect(reduced[0]!.rects[7]).toBeCloseTo(2 * 0.85);
    expect(reduced[1]!.rects[7]).toBeCloseTo(9 * 0.85);
  });

  it("bounds repeated-position stack segments and keeps their row colors", () => {
    const data = table({
      t: Array.from({ length: 80 }, (_, i) => Math.floor(i / 8) + 0.5),
      v: Array.from({ length: 80 }, (_, i) => (i % 2 ? -1 : 1)),
      color: Array.from({ length: 80 }, (_, i) => (i % 4 < 2 ? "red" : "blue")),
    });
    const { exact, reduced, series } = drawing(
      bar(data, { x: "t", y: "v", series: "color", stack: true }),
    );
    sameEnvelope(exact, reduced);
    expect(reduced.map((g) => g.fill)).toEqual(series.map((s) => s.color));
    expect(reduced.every((g) => g.count <= 20)).toBe(true);
  });

  it("keeps fewer than two bars per column exact, including widths, dodge, stacks, and labels", () => {
    const data = table({ t: [1, 3, 5, 7], a: [1, 4, -3, 2], b: [2, -1, 4, 1] });
    for (const stack of [false, true]) {
      const { exactGeometry, reducedGeometry } = drawing(
        bar(data, { x: "t", y: ["a", "b"], stack, labels: true }),
        { x: new LinearScale([0, 10], [20, 220]), plot: { x: 20, y: 5, width: 200, height: 40 } },
      );
      expect(reducedGeometry).toEqual(exactGeometry);
    }
  });

  it("keeps a few usable bars exact when most rows are missing", () => {
    const data = table({
      t: Float64Array.from({ length: 80 }, (_, i) => i / 8),
      v: Float64Array.from({ length: 80 }, (_, i) => (i % 20 ? Number.NaN : i)),
    });
    const { exact, reduced } = drawing(bar(data, { x: "t", y: "v" }));
    sameEnvelope(exact, reduced);
    expect(reduced[0]!.count).toBe(3); // The zero-height row paints nothing.
    expect(reduced[0]!.rects.length).toBe(12);
  });

  it("keeps labels on missing-heavy exact bars without replaying the source", () => {
    const data = table({
      t: new Float64Array(1200).fill(5),
      v: Float64Array.from({ length: 1200 }, (_, i) => (i < 20 ? 10 : Number.NaN)),
    });
    const mark = bar(data, { x: "t", y: "v", labels: true }) as BarMark;
    const { series, frame, exactGeometry } = drawing(mark, {
      x: new LinearScale([0, 10], [20, 220]),
      y: new LinearScale([0, 20], [42, 8]),
      plot: { x: 20, y: 5, width: 200, height: 40 },
    });
    const geometry = vi.spyOn(mark, "geometry");
    const result = overviewBars(mark, series, frame, 0);
    expect(geometry).toHaveBeenCalledTimes(1);
    expect(geometry.mock.calls[0]![0][0]!.length).toBe(20);
    const labels = (drawing: typeof result) =>
      drawing.filter((g): g is TextGeometry => g.kind === "text");
    expect(labels(result)).toEqual(labels(exactGeometry));
    expect(labels(result).some((g) => g.count > 0)).toBe(true);
    geometry.mockRestore();
  });

  it("bounds output and buffers even when every row has a different series color", () => {
    const data = table({
      t: Float64Array.from({ length: 80 }, (_, i) => (i + 0.5) / 8),
      v: Float64Array.from({ length: 80 }, (_, i) => (i % 2 ? -i - 1 : i + 1)),
      color: Array.from({ length: 80 }, (_, i) => String(i)),
    });
    for (const stack of [false, true]) {
      const { reduced, series } = drawing(bar(data, { x: "t", y: "v", series: "color", stack }));
      expect(reduced.reduce((n, g) => n + g.count, 0)).toBe(20);
      expect(reduced.reduce((n, g) => n + g.rects.length, 0)).toBe(80);
      for (const g of reduced) expect(g.fill).toBe(series.find((s) => s.key === g.key)!.color);
    }
  });

  it("uses the log-axis baseline and skips invalid values, hidden series, and reversed x", () => {
    const data = table({
      t: Float64Array.from({ length: 80 }, (_, i) => (i + 0.5) / 8),
      a: Float64Array.from({ length: 80 }, (_, i) => (i % 4 ? (i % 9) + 1 : -1)),
      b: new Float64Array(80).fill(15),
    });
    const { series } = drawing(bar(data, { x: "t", y: ["a", "b"] }));
    const { reduced, frame } = drawing(bar(data, { x: "t", y: ["a", "b"] }), {
      x: new LinearScale([10, 0], [20, 30]),
      y: new LogScale([1, 20], [42, 8]),
      hidden: new Set([series[1]!.key]),
    });
    expect(reduced).toHaveLength(1);
    expect(reduced[0]!.count).toBe(10);
    for (let i = 0; i < reduced[0]!.count; i++)
      expect(reduced[0]!.rects[i * 4 + 1]! + reduced[0]!.rects[i * 4 + 3]!).toBeCloseTo(
        frame.y.range[0],
        5,
      );
  });

  it("covers wide, dodged, and clipped footprints on normal and reversed x", () => {
    for (const width of [10, 200, 580.5]) {
      const count = Math.ceil(width) * 2 + 20;
      for (const stack of [false, true]) {
        for (const domain of [
          [0, 10],
          [10, 0],
        ] as const) {
          const data = table({
            t: Float64Array.from({ length: count }, (_, i) =>
              i % 3 === 0 ? -0.1 : i % 3 === 1 ? 5 : 10.1,
            ),
            a: new Float64Array(count).fill(1),
            b: new Float64Array(count).fill(2),
          });
          const { exact, reduced } = drawing(bar(data, { x: "t", y: ["a", "b"], stack }), {
            x: new LinearScale(domain, [20, 20 + width]),
            y: new LinearScale([-count * 3, count * 3], [42, 8]),
            plot: { x: 20, y: 5, width, height: 40 },
          });
          sameEnvelope(exact, reduced, Math.ceil(width));
          expect(reduced.every((g) => g.count <= Math.ceil(width) * 2)).toBe(true);
        }
      }
    }
  });

  it("counts only nonempty rectangles intersecting the strip", () => {
    for (const missing of [0, Number.NaN, 10]) {
      for (const at of [5, -0.1, 10.1]) {
        const data = table({
          t: Float64Array.from({ length: 1200 }, (_, i) =>
            i === 1199 ? at : missing === 10 ? 20 : 5,
          ),
          v: Float64Array.from({ length: 1200 }, (_, i) => (i === 1199 ? 10 : missing)),
        });
        const { exact, reduced } = drawing(bar(data, { x: "t", y: "v" }), {
          x: new LinearScale([0, 10], [20, 600]),
          plot: { x: 20, y: 5, width: 580, height: 40 },
        });
        sameEnvelope(exact, reduced, 580);
        expect(reduced[0]!.count).toBe(1);
        expect(reduced[0]!.rects[2]).toBe(64);
      }
    }
    for (const baseline of [0, 10]) {
      const data = table({
        t: new Float64Array(1200).fill(5),
        v: new Float64Array(1200).fill(baseline),
      });
      const axes = {
        y: baseline ? new LogScale([10, 100], [42, 8]) : new LinearScale([0, 100], [42, 8]),
      };
      const empty = drawing(bar(data, { x: "t", y: "v" }), axes);
      expect(empty.reduced[0]!.count).toBe(0);
      data.set("v", 1199, 100);
      const { exact, reduced } = drawing(bar(data, { x: "t", y: "v" }), axes);
      sameEnvelope(exact, reduced);
      expect(reduced[0]!.count).toBe(1);
      expect(reduced[0]!.rects[2]).toBe(64);
    }
  });

  it("keeps the same visible footprint while append and resize cross the density threshold", () => {
    const data = table({ t: new Float64Array(1159).fill(5), v: new Float64Array(1159).fill(10) });
    const model = new ChartModel({
      marks: [bar(data, { x: "t", y: "v" })],
      navigator: rangeNavigator(),
      x: { show: false, domain: [0, 10] },
      y: { show: false, domain: [0, 20] },
    });
    model.setSize(600, 300, 1);
    const strip = () => model.scene(estimateText).panels.find((p) => p.key === "navigator")!;
    const original = strip();
    const expected = envelope(
      original.marks.filter((g): g is RectGeometry => g.kind === "rect"),
      580,
      original.plot.x,
    );
    expect((original.marks[0] as RectGeometry).count).toBe(1159);
    for (let i = 0; i < 3; i++) {
      data.append({ t: [5], v: [10] });
      const dense = strip();
      expect(
        envelope(
          dense.marks.filter((g): g is RectGeometry => g.kind === "rect"),
          580,
          dense.plot.x,
        ),
      ).toEqual(expected);
      expect((dense.marks[0] as RectGeometry).count).toBe(64);
      model.setSize(601 + i, 300, 1);
      const resized = strip();
      expect((resized.marks[0] as RectGeometry).count).toBe(data.length);
      const rectangles = resized.marks[0] as RectGeometry;
      // The exact path paints repeated copies of one rectangle. Resizing
      // changes its placement by half a pixel, while retaining its width.
      expect(rectangles.rects[2]).toBe(64);
      model.setSize(600, 300, 1);
      const restored = strip();
      expect(
        envelope(
          restored.marks.filter((g): g is RectGeometry => g.kind === "rect"),
          580,
          restored.plot.x,
        ),
      ).toEqual(expected);
    }
  });

  it("walks a missing-heavy source once and retains only the exact usable rectangles", () => {
    const data = table({
      t: Float64Array.from({ length: 10000 }, (_, i) => i),
      v: Float64Array.from({ length: 10000 }, (_, i) => (i < 20 ? 1 : Number.NaN)),
    });
    const mark = bar(data, { x: "t", y: "v" }) as BarMark;
    const { series, frame } = drawing(mark, {
      x: new LinearScale([0, 10000], [20, 620]),
      plot: { x: 20, y: 5, width: 600, height: 40 },
    });
    const ends = vi.spyOn(mark, "ends");
    const geometry = vi.spyOn(mark, "geometry");
    const result = overviewBars(mark, series, frame, 0) as RectGeometry[];
    expect(ends).toHaveBeenCalledTimes(20);
    expect(geometry).not.toHaveBeenCalled();
    expect(result[0]!.count).toBe(20);
    expect(result[0]!.rects.length).toBe(80);
    ends.mockRestore();
    geometry.mockRestore();
  });

  it("preserves complete log stacks on reversed axes, including layer proportions", () => {
    const data = table({
      t: Float64Array.from({ length: 80 }, (_, i) => (i + 0.5) / 8),
      a: Float64Array.from({ length: 80 }, (_, i) => (i % 2 ? 9 : 2)),
      b: Float64Array.from({ length: 80 }, (_, i) => (i % 2 ? 1 : 8)),
    });
    for (const domain of [
      [1, 20],
      [20, 1],
    ] as const) {
      const { exact, reduced, series, frame } = drawing(
        bar(data, { x: "t", y: ["a", "b"], stack: true }),
        {
          x: new LinearScale([10, 0], [20, 30]),
          y: new LogScale(domain, [42, 8]),
        },
      );
      sameEnvelope(exact, reduced);
      expect(reduced.map((g) => g.fill)).toEqual(series.map((s) => s.color));
      // Equal totals select the first row in each column: 2 + 8, not 9 + 1.
      expect(reduced[0]!.rects[3]).toBeCloseTo(Math.abs(frame.y.map(2) - frame.y.range[0]), 5);
      expect(reduced[1]!.rects[3]).toBeCloseTo(Math.abs(frame.y.map(10) - frame.y.map(2)), 5);
    }
  });

  it("keeps fixed series-order ties stable under row reordering and defines reversed series order", () => {
    const data = table({
      t: Float64Array.from({ length: 80 }, (_, i) => (i + 0.5) / 8),
      v: new Float64Array(80).fill(10),
      color: encodedCategory(
        Int32Array.from({ length: 80 }, (_, i) => i % 2),
        ["red", "blue"],
      ),
    });
    const mark = bar(data, { x: "t", y: "v", series: "color" }) as BarMark;
    const { series, frame, reduced } = drawing(mark);
    expect(reduced.map((g) => g.fill)).toEqual([series[0]!.color]);
    const reordered = series.map((s) => ({
      ...s,
      whole: s,
      rows: s.rows!.slice().reverse(),
      sorted: false,
    }));
    expect(overviewBars(mark, reordered, frame, 0)).toEqual(reduced);
    const reversed = overviewBars(mark, [...series].reverse(), frame, 0) as RectGeometry[];
    expect(reversed.map((g) => g.fill)).toEqual([series[1]!.color]);
  });

  it.each([false, true])("refreshes streamed and reset signed stacks with facets=%s", (faceted) => {
    const columns = (count: number) => ({
      t: Float64Array.from({ length: count }, (_, i) => Math.floor(i / 2)),
      a: Float64Array.from({ length: count }, (_, i) => (i % 4 < 2 ? 3 : -2)),
      b: Float64Array.from({ length: count }, (_, i) => (i % 4 < 2 ? 2 : -4)),
      panel: Array.from({ length: count }, (_, i) => (i % 2 ? "one" : "two")),
    });
    const data = table(columns(5000));
    const config = () => ({
      marks: [bar(data, { x: "t", y: ["a", "b"], stack: true })],
      navigator: rangeNavigator(),
      ...(faceted && { facet: facet("panel") }),
      x: { show: false },
      y: { show: false, domain: [-20, 20] as const },
    });
    const model = new ChartModel(config());
    model.setSize(600, 400, 1);
    const strip = (owner: ChartModel) =>
      owner.scene(estimateText).panels.find((p) => p.key === "navigator")!;
    const snapshot = (owner: ChartModel) =>
      strip(owner)
        .marks.filter((g): g is RectGeometry => g.kind === "rect")
        .map((g) => ({ key: g.key, fill: g.fill, rects: g.rects.slice(0, g.count * 4) }));
    const assertFresh = () => {
      const fresh = new ChartModel(config());
      fresh.setSize(600, 400, 1);
      for (const key of model.hidden) fresh.hidden.add(key);
      expect(snapshot(model)).toEqual(snapshot(fresh));
    };
    const before = strip(model).marks[0];
    model.setViewport([500, 550]);
    expect(strip(model).marks[0]).toBe(before);
    data.set("a", 100, 15);
    assertFresh();
    data.append({ t: [2500, 2500], a: [4, -3], b: [5, -6], panel: ["one", "two"] });
    assertFresh();
    data.dropFirst(4);
    assertFresh();
    model.hidden.add(model.series()[0]!.key);
    assertFresh();
    model.hidden.clear();
    assertFresh();
    data.reset(columns(3000));
    assertFresh();
  });

  it("caches the reduced strip across drags and rebuilds for changed rows and width", () => {
    const data = table({
      t: Float64Array.from({ length: 5000 }, (_, i) => i),
      v: new Float64Array(5000).fill(1),
    });
    const model = new ChartModel({
      marks: [bar(data, { x: "t", y: "v" })],
      x: { show: false },
      y: { domain: [0, 10] },
      navigator: rangeNavigator(),
    });
    model.setSize(600, 300, 1);
    const strip = () => model.scene(estimateText).panels.find((p) => p.key === "navigator")!;
    const before = strip().marks[0] as RectGeometry;
    const rects = before.rects.slice();
    model.setViewport([1000, 1100]);
    expect(strip().marks[0]).toBe(before);
    expect(before.rects).toEqual(rects);
    data.set("v", 100, 8);
    expect(strip().marks[0]).not.toBe(before);
    model.setSize(300, 300, 1);
    const resized = strip();
    expect((resized.marks[0] as RectGeometry).count).toBeLessThanOrEqual(
      Math.ceil(resized.plot.width),
    );
  });
});
