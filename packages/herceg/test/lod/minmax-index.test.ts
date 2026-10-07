import { describe, expect, it, vi } from "vitest";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { type Mapping, m4 } from "../../src/lod/m4.ts";
import { MinMaxIndex, type RangeExtremes } from "../../src/lod/minmax-index.ts";
import { Polyline } from "../../src/lod/polyline.ts";
import { line } from "../../src/marks/line.ts";
import { ChartModel } from "../../src/model/model.ts";
import type { LineGeometry } from "../../src/scene/scene.ts";

function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** The first lowest and highest finite values of a range, by scanning. */
function scan(values: Float64Array, from: number, to: number): RangeExtremes {
  const out: RangeExtremes = { low: -1, high: -1, gap: false };
  for (let i = from; i < to; i++) {
    const v = values[i]!;
    if (!Number.isFinite(v)) {
      out.gap = true;
      continue;
    }
    if (out.low < 0 || v < values[out.low]!) out.low = i;
    if (out.high < 0 || v > values[out.high]!) out.high = i;
  }
  return out;
}

describe("MinMaxIndex", () => {
  it("answers range queries exactly like a scan", () => {
    const next = seeded(3);
    const n = 70_000;
    // Few distinct values, so ties test first-occurrence order.
    const values = Float64Array.from({ length: n }, () => {
      const r = next();
      return r < 0.001 ? Number.NaN : r < 0.0015 ? Number.POSITIVE_INFINITY : Math.floor(r * 50);
    });
    const index = new MinMaxIndex(values);
    const out: RangeExtremes = { low: -1, high: -1, gap: false };
    for (let q = 0; q < 2_000; q++) {
      const a = Math.floor(next() * n);
      const b = Math.floor(next() * n);
      const [from, to] = a <= b ? [a, b + 1] : [b, a + 1];
      expect({ ...index.query(values, from, to, out) }).toEqual(scan(values, from, to));
    }
    expect({ ...index.query(values, 0, n, out) }).toEqual(scan(values, 0, n));
    expect({ ...index.query(values, 5, 5, out) }).toEqual({ low: -1, high: -1, gap: false });
  });

  it("makes M4 read dense columns without changing its output", () => {
    const next = seeded(5);
    const n = 400_000;
    const x = Float64Array.from({ length: n }, (_, i) => 1_767_225_600_000 + i * 250);
    const y = Float64Array.from({ length: n }, (_, i) => {
      const r = next();
      return r < 0.0005 ? Number.NaN : Math.sin(i / 2000) * 50 + Math.floor(r * 20);
    });
    const index = new MinMaxIndex(y);
    const yMap: Mapping = { origin: 0, offset: 200, factor: -2, log: false };
    for (const [from, to] of [
      [0, n],
      [50_000, 250_000],
      [123_457, 131_000],
    ] as const) {
      const xMap: Mapping = {
        origin: x[from]!,
        offset: 30,
        factor: 300 / (x[to - 1]! - x[from]!),
        log: false,
      };
      const indexed = new Polyline();
      m4(x, y, from, to, xMap, yMap, 1, indexed, undefined, index);
      const rows = Uint32Array.from({ length: n }, (_, i) => i);
      const pointwise = new Polyline();
      m4(x, y, from, to, xMap, yMap, 1, pointwise, rows);
      expect(indexed.starts).toEqual(pointwise.starts);
      expect(Array.from(indexed.coords.subarray(0, indexed.count * 2))).toEqual(
        Array.from(pointwise.coords.subarray(0, pointwise.count * 2)),
      );
    }
  });
});

describe("incremental indexes", () => {
  it("take in appended values and updates like a fresh build", () => {
    const next = seeded(11);
    const n = 50_000;
    const values = Float64Array.from({ length: n }, () =>
      next() < 0.002 ? Number.NaN : Math.floor(next() * 100),
    );
    const index = new MinMaxIndex(values, 100);
    for (let length = 100; length < n; length += 1 + Math.floor(next() * 3000)) {
      index.extend(values, length);
    }
    index.extend(values, n);
    for (let k = 0; k < 50; k++) {
      const at = Math.floor(next() * n);
      values[at] = next() < 0.5 ? -1000 : 1000;
      index.update(values, at, at + 1);
    }
    const fresh = new MinMaxIndex(values);
    const out: RangeExtremes = { low: -1, high: -1, gap: false };
    for (let q = 0; q < 1_000; q++) {
      const a = Math.floor(next() * n);
      const b = Math.floor(next() * n);
      const [from, to] = a <= b ? [a, b + 1] : [b, a + 1];
      expect({ ...index.query(values, from, to, out) }).toEqual(scan(values, from, to));
    }
    expect(index.gapShare).toBeCloseTo(fresh.gapShare, 12);
  });
});

describe("incremental index boundaries", () => {
  it("summarize existing blocks when growth adds a level", () => {
    for (const size of [512, 4_096, 32_768, 262_144]) {
      const values = Float64Array.from({ length: size + 1 }, (_, i) =>
        i === 7 ? Number.NaN : (i * 7919) % 1000,
      );
      const index = new MinMaxIndex(values, size);
      index.extend(values, size + 1);
      const out: RangeExtremes = { low: -1, high: -1, gap: false };
      expect({ ...index.query(values, 0, size, out) }).toEqual(scan(values, 0, size));
      expect({ ...index.query(values, 0, size + 1, out) }).toEqual(scan(values, 0, size + 1));
    }
  });

  it("refuse queries through a view read before the table changed", () => {
    const data = table({ y: Float64Array.from({ length: 1_024 }, (_, i) => i) });
    const view = data.minMaxIndex("y");
    data.setColumn(
      "y",
      Float64Array.from({ length: 1_024 }, (_, i) => 1_023 - i),
    );
    const out: RangeExtremes = { low: -1, high: -1, gap: false };
    expect(() => view.query(data.numbers("y"), 0, 1_024, out)).toThrow(/before the table changed/);
    const fresh = data.minMaxIndex("y");
    expect({ ...fresh.query(data.numbers("y"), 0, 1_024, out) }).toEqual({
      low: 1_023,
      high: 0,
      gap: false,
    });
  });
});

describe("line indexes", () => {
  function chart(data: ReturnType<typeof stream>, y: "linear" | "log" = "linear") {
    // No x axis: labels at its ends would widen the margins of a streaming
    // chart, which keeps that room, and not those of the oracle drawn fresh.
    const model = new ChartModel({
      marks: [line(data, { x: "x", y: "y" })],
      x: { axis: false },
      y: { type: y },
    });
    model.setSize(600, 300, 1);
    return model;
  }
  function stream(n: number) {
    return table(
      {
        x: Float64Array.from({ length: n }, (_, i) => i),
        y: Float64Array.from({ length: n }, (_, i) => 2 + Math.sin(i / 100) + (i % 7)),
      },
      { maxRows: n },
    );
  }
  const path = (model: ChartModel) => {
    const { coords, count, starts } = (model.scene(estimateText).marks[0] as LineGeometry).path;
    return { starts: [...starts], coords: Array.from(coords.subarray(0, count * 2)) };
  };
  /**
   * The path a chart of a separate copy of the table's live rows draws on
   * its first draw, which reads no index: the oracle for indexed drawing.
   */
  const reference = (data: ReturnType<typeof stream>) => {
    const copy = table({ x: data.numbers("x").slice(), y: data.numbers("y").slice() });
    return path(chart(copy));
  };
  // Values in the same range as the initial ones, so axis labels (and with
  // them the plot, whose margin only grows while data streams) stay the same.
  const append = (data: ReturnType<typeof stream>, from: number, count: number) => {
    const x = Float64Array.from({ length: count }, (_, i) => from + i);
    data.append({ x, y: Float64Array.from(x, (v) => 2 + Math.sin(v / 37) + (v % 7)) });
  };

  it("are built once a chart redraws a large series, and stay current while it streams", () => {
    const n = 300_000;
    const data = stream(n);
    const model = chart(data);
    const query = vi.spyOn(MinMaxIndex.prototype, "query");
    try {
      model.scene(estimateText);
      // One draw builds nothing.
      expect(query.mock.calls.length).toBe(0);
      for (let tick = 0; tick < 6; tick++) {
        append(data, n + tick * 5_000, 5_000);
        const drawn = path(model);
        const before = query.mock.calls.length;
        const expected = reference(data);
        // The reference reads no index; the streaming chart does.
        expect(query.mock.calls.length).toBe(before);
        expect(drawn).toEqual(expected);
      }
      expect(query.mock.calls.length).toBeGreaterThan(0);
    } finally {
      query.mockRestore();
    }
  });

  it("are not rebuilt for data replaced before every draw", () => {
    const n = 300_000;
    const data = stream(n);
    const model = chart(data);
    model.scene(estimateText);
    const build = vi.spyOn(MinMaxIndex.prototype, "extend");
    try {
      for (let frame = 0; frame < 4; frame++) {
        data.setColumn(
          "y",
          Float64Array.from({ length: n }, (_, i) => Math.sin(i + frame)),
        );
        model.scene(estimateText);
      }
      expect(build.mock.calls.length).toBe(0);
      expect(data.hasMinMaxIndex("y")).toBe(false);
      // Unchanged data on the next draw is worth indexing again.
      model.scene(estimateText);
      expect(data.hasMinMaxIndex("y")).toBe(true);
    } finally {
      build.mockRestore();
    }
  });

  it("stay correct through compactions of a rolling window", () => {
    const n = 300_000;
    const data = stream(n);
    const model = chart(data);
    model.scene(estimateText);
    model.scene(estimateText);
    expect(data.hasMinMaxIndex("y")).toBe(true);
    // A window of n in 1.5 n of storage compacts every n / 2 appended rows.
    const rebuilds = vi.spyOn(MinMaxIndex.prototype, "extend");
    try {
      for (let tick = 0; tick < 12; tick++) {
        append(data, n + tick * 40_000, 40_000);
        expect(data.hasMinMaxIndex("y")).toBe(true);
        expect(path(model)).toEqual(reference(data));
      }
      // Several moves rebuilt the index from position 0.
      const full = rebuilds.mock.calls.filter(([, length]) => length === n);
      expect(full.length).toBeGreaterThanOrEqual(2);
    } finally {
      rebuilds.mockRestore();
    }
  });

  it("are not built for log scales, which reduce without them", () => {
    const data = stream(300_000);
    const model = chart(data, "log");
    for (let tick = 0; tick < 4; tick++) {
      append(data, 300_000 + tick * 1_000, 1_000);
      model.scene(estimateText);
    }
    expect(data.hasMinMaxIndex("y")).toBe(false);
  });
});
