import { describe, expect, it } from "vitest";
import { type Mapping, m4 } from "../../src/lod/m4.ts";
import { rowsM4 } from "../../src/lod/m4-rows.ts";
import type { RangeExtremes, RangeIndex } from "../../src/lod/minmax-index.ts";
import { Polyline } from "../../src/lod/polyline.ts";
import { RowsIndex } from "../../src/lod/rows-index.ts";
import { timeBreaks } from "../../src/scale/breaks.ts";

function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** The first lowest and highest finite values of rows `[from, to)` of a list, by scanning. */
function scan(values: Float64Array, rows: Uint32Array, from: number, to: number): RangeExtremes {
  const out: RangeExtremes = { low: -1, high: -1, gap: false };
  for (let k = from; k < to; k++) {
    const v = values[rows[k]!]!;
    if (!Number.isFinite(v)) {
      out.gap = true;
      continue;
    }
    if (out.low < 0 || v < values[rows[out.low]!]!) out.low = k;
    if (out.high < 0 || v > values[rows[out.high]!]!) out.high = k;
  }
  return out;
}

/** Few distinct values, so ties test first-occurrence order, with gaps of every kind. */
function values(n: number, next: () => number): Float64Array {
  return Float64Array.from({ length: n }, () => {
    const r = next();
    if (r < 0.001) return Number.NaN;
    if (r < 0.0013) return Number.POSITIVE_INFINITY;
    if (r < 0.0016) return Number.NEGATIVE_INFINITY;
    return Math.floor(r * 50);
  });
}

/** Ascending rows of `n`, about `share` of them. */
function subset(n: number, share: number, next: () => number): Uint32Array {
  const rows: number[] = [];
  for (let i = 0; i < n; i++) if (next() < share) rows.push(i);
  return Uint32Array.from(rows);
}

function expectScans(
  index: RowsIndex,
  y: Float64Array,
  rows: Uint32Array,
  next: () => number,
  queries = 200,
) {
  const out: RangeExtremes = { low: -1, high: -1, gap: false };
  const n = rows.length;
  expect({ ...index.query(y, rows, 0, n, out) }).toEqual(scan(y, rows, 0, n));
  for (let q = 0; q < queries; q++) {
    const a = Math.floor(next() * n);
    const b = Math.floor(next() * n);
    const [from, to] = a <= b ? [a, b + 1] : [b, a + 1];
    expect({ ...index.query(y, rows, from, to, out) }).toEqual(scan(y, rows, from, to));
  }
}

describe("RowsIndex", () => {
  it("answers range queries through rows exactly like a scan", () => {
    const next = seeded(3);
    const y = values(120_000, next);
    const rows = subset(y.length, 0.6, next);
    const index = new RowsIndex();
    index.update(y, rows, 0, rows.length);
    expect(index.length).toBe(rows.length);
    expectScans(index, y, rows, next, 2_000);
    const out: RangeExtremes = { low: -1, high: -1, gap: false };
    expect({ ...index.query(y, rows, 9, 9, out) }).toEqual({ low: -1, high: -1, gap: false });
  });

  it("stay exact as rows arrive and leave, across the blocks of every level", () => {
    const next = seeded(7);
    const y = values(1_800_000, next);
    // Every row of the source belongs to the list, so it can grow past 2^18.
    const all = Uint32Array.from({ length: y.length }, (_, i) => i);
    const index = new RowsIndex();
    let dropped = 0;
    let end = 0;
    const steps = [1, 63, 64, 65, 511, 512, 513, 4_095, 4_096, 4_097, 32_767, 32_768, 32_769];
    const large = [262_143, 262_144, 262_145];
    const check = () => {
      const rows = all.subarray(dropped, end);
      index.update(y, rows, dropped, rows.length);
      expectScans(index, y, rows, next, 40);
      const fresh = new RowsIndex();
      fresh.update(y, rows, dropped, rows.length);
      expect(index.gapShare).toBe(fresh.gapShare);
    };
    // Grow past every level, then move the window by every step, then shrink it.
    end = 900_000;
    check();
    for (const step of [...steps, ...large]) {
      end += step;
      check();
      dropped += step;
      check();
    }
    for (const step of [...large, ...steps].reverse()) {
      dropped += step;
      check();
    }
    expect(end).toBeLessThanOrEqual(y.length);
    expect(end - dropped).toBeLessThan(2_000);
  });

  it("follow a list read only now and then, as hidden series are", () => {
    const next = seeded(11);
    const y = values(200_000, next);
    const all = subset(y.length, 0.5, next);
    const index = new RowsIndex();
    let dropped = 0;
    let end = 5_000;
    for (let tick = 0; tick < 300; tick++) {
      end = Math.min(all.length, end + Math.floor(next() * 700));
      dropped = Math.min(end - 1, dropped + Math.floor(next() * 650));
      // Rows taken in and dropped between reads are never seen.
      if (next() < 0.3) continue;
      const rows = all.subarray(dropped, end);
      index.update(y, rows, dropped, rows.length);
      expectScans(index, y, rows, next, 10);
    }
  });

  it("start over for a list that does not continue the one covered", () => {
    const next = seeded(13);
    const y = values(50_000, next);
    const rows = subset(y.length, 0.7, next);
    const index = new RowsIndex();
    index.update(y, rows, 100, 20_000);
    // Rows back at the front, rows gone from the end, and nothing kept at all.
    for (const [dropped, count] of [
      [50, 20_000],
      [50, 10_000],
      [30_000, 4_000],
    ] as const) {
      const list = rows.subarray(0, count);
      index.update(y, list, dropped, count);
      expectScans(index, y, list, next, 50);
    }
  });

  it("keep storage to the blocks that hold rows", () => {
    const y = Float64Array.from({ length: 1_000_000 }, (_, i) => i % 1000);
    const all = Uint32Array.from({ length: y.length }, (_, i) => i);
    const index = new RowsIndex();
    index.update(y, all, 0, all.length);
    // About 9 bytes per 64 rows, 1.15 times that with every level.
    expect(index.byteLength).toBeLessThan(1.2 * (9 / 64) * all.length * 1.15);
    index.update(y, all.subarray(999_000), 999_000, 1_000);
    expect(index.byteLength).toBeLessThan(500);
  });
});

/** Points and runs of a polyline. */
function points(out: Polyline) {
  return { starts: [...out.starts], coords: Array.from(out.coords.subarray(0, out.count * 2)) };
}

/** A view of a RowsIndex over a list, as groups give them out. */
function view(y: Float64Array, rows: Uint32Array): RangeIndex {
  const index = new RowsIndex();
  index.update(y, rows, 0, rows.length);
  return {
    length: rows.length,
    gapShare: index.gapShare,
    query: (_values, from, to, out) => index.query(y, rows, from, to, out),
  };
}

describe("rowsM4", () => {
  // m4 reduces row subsets point by point: the reference.
  const pointwise = (
    x: Float64Array,
    y: Float64Array,
    rows: Uint32Array,
    xMap: Mapping,
    yMap: Mapping,
    ratio: number,
  ) => {
    const out = new Polyline();
    m4(x, y, 0, rows.length, xMap, yMap, ratio, out, rows);
    return points(out);
  };

  it("reduces rows as m4 does point by point, scanning or through an index", () => {
    const next = seeded(17);
    const cases = [
      { n: 60_000, origin: 0, step: 1, width: 800, ratio: 2 },
      // Epoch milliseconds, and steps that are not representable exactly.
      { n: 60_000, origin: 1_767_225_600_000, step: 1000, width: 640, ratio: 1 },
      { n: 40_000, origin: -3.7, step: 0.1, width: 333, ratio: 1.5 },
      // Dense enough for index queries: over 200 points a column.
      { n: 400_000, origin: 1_767_225_600_000, step: 250, width: 120, ratio: 1 },
    ];
    for (const { n, origin, step, width, ratio } of cases) {
      const x = new Float64Array(n);
      const y = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        // Every x value three times, so columns hold repeated x.
        x[i] = origin + Math.floor(i / 3) * step;
        const r = next();
        y[i] =
          r < 0.0005
            ? Number.NaN
            : r < 0.0007
              ? Number.POSITIVE_INFINITY
              : r < 0.0009
                ? Number.NEGATIVE_INFINITY
                : Math.floor(Math.sin(i / 300) * 50 + next() * 10);
      }
      // Two series' rows of interleaved long-format data.
      for (const rows of [subset(n, 0.5, next), subset(n, 0.95, next)]) {
        const lo = x[rows[0]!]!;
        const hi = x[rows[rows.length - 1]!]!;
        const xMap: Mapping = { origin: lo, offset: 40, factor: width / (hi - lo), log: false };
        const yMap: Mapping = { origin: 0, offset: 200, factor: -2, log: false };
        const expected = pointwise(x, y, rows, xMap, yMap, ratio);
        for (const index of [undefined, view(y, rows)]) {
          const out = new Polyline();
          expect(rowsM4(x, y, 0, rows.length, xMap, yMap, ratio, out, rows, index)).toBe(true);
          expect(points(out)).toEqual(expected);
        }
      }
    }
  });

  it("matches m4 at extreme magnitudes", () => {
    const x = Float64Array.from([1e15, 1e15 + 0.125, 1e15 + 0.25, 1e15 + 0.5, 1e15 + 1]);
    const y = Float64Array.from([1, 5, -3, 2, 4]);
    const rows = Uint32Array.from([0, 1, 2, 3, 4]);
    const yMap: Mapping = { origin: 0, offset: 0, factor: 1, log: false };
    for (const factor of [1e-3, 1, 3, 1e6]) {
      const xMap: Mapping = { origin: 1e15, offset: 0.3, factor, log: false };
      const out = new Polyline();
      rowsM4(x, y, 0, 5, xMap, yMap, 1, out, rows);
      expect(points(out)).toEqual(pointwise(x, y, rows, xMap, yMap, 1));
    }
  });

  it("leave log scales, breaks, and reversed axes to m4", () => {
    const x = Float64Array.from([1, 2, 3]);
    const y = Float64Array.from([1, 2, 3]);
    const rows = Uint32Array.from([0, 1, 2]);
    const linear: Mapping = { origin: 0, offset: 0, factor: 1, log: false };
    const breaks = timeBreaks([{ weekdays: ["sat", "sun"] }]).calendar("UTC");
    for (const [xMap, yMap] of [
      [{ ...linear, log: true }, linear],
      [linear, { ...linear, log: true }],
      [{ ...linear, factor: -1 }, linear],
      [{ ...linear, breaks }, linear],
    ] as const) {
      const out = new Polyline();
      expect(rowsM4(x, y, 0, 3, xMap, yMap, 1, out, rows)).toBe(false);
      expect(out.count).toBe(0);
    }
    expect(rowsM4(x, y, 0, 3, linear, linear, 1, new Polyline(), undefined)).toBe(false);
  });
});
