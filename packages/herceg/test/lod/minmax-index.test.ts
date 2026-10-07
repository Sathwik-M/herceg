import { describe, expect, it, vi } from "vitest";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { type Mapping, m4 } from "../../src/lod/m4.ts";
import { MinMaxIndex, type RangeExtremes } from "../../src/lod/minmax-index.ts";
import { Polyline } from "../../src/lod/polyline.ts";
import { line } from "../../src/marks/line.ts";
import { ChartModel } from "../../src/model/model.ts";

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

describe("line indexes", () => {
  it("are built on a chart's second draw of unchanged data, not for streaming", () => {
    const n = 300_000;
    const data = table({
      x: Float64Array.from({ length: n }, (_, i) => i),
      y: Float64Array.from({ length: n }, (_, i) => Math.sin(i / 100)),
    });
    const mark = line(data, { x: "x", y: "y" });
    const charts = [0, 1].map(() => {
      const model = new ChartModel({ marks: [mark] });
      model.setSize(600, 300, 1);
      return model;
    });
    const query = vi.spyOn(MinMaxIndex.prototype, "query");
    // Two charts sharing the mark, data changing before every draw.
    for (let i = 0; i < 4; i++) {
      data.set("y", 0, i);
      for (const model of charts) model.scene(estimateText);
    }
    expect(query).not.toHaveBeenCalled();
    // Unchanged data: the second draw builds the index, the third uses it.
    for (let i = 0; i < 3; i++) charts[0]!.scene(estimateText);
    expect(query).toHaveBeenCalled();
    query.mockRestore();
  });
});
