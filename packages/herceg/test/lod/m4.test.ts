import { describe, expect, it } from "vitest";
import { type Mapping, m4, polylineAll } from "../../src/lod/m4.ts";
import { Polyline } from "../../src/lod/polyline.ts";

const identity: Mapping = { origin: 0, offset: 0, factor: 1, log: false };

function points(out: Polyline): [number, number][] {
  return Array.from({ length: out.count }, (_, i) => [out.coords[i * 2]!, out.coords[i * 2 + 1]!]);
}

function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

describe("m4", () => {
  it("matches point-by-point reduction exactly when scanning by column", () => {
    const next = seeded(11);
    const cases: { n: number; origin: number; step: number; width: number; from: number }[] = [
      { n: 50_000, origin: 0, step: 1, width: 800, from: 0 },
      // Epoch milliseconds, the whole range and a zoom far below one second.
      { n: 50_000, origin: 1_767_225_600_000, step: 1000, width: 640, from: 0 },
      { n: 20_000, origin: 1_767_225_600_000, step: 0.25, width: 500, from: 9_000 },
      // Repeated x values and steps that are not representable exactly.
      { n: 30_000, origin: -3.7, step: 0.1, width: 333, from: 0 },
    ];
    for (const { n, origin, step, width, from } of cases) {
      const x = new Float64Array(n);
      const y = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        // Every x value three times, so columns hold repeated x.
        x[i] = origin + Math.floor(i / 3) * step;
        const r = next();
        y[i] =
          r < 0.002
            ? Number.NaN
            : r < 0.003
              ? Number.POSITIVE_INFINITY
              : r < 0.004
                ? Number.NEGATIVE_INFINITY
                : Math.sin(i / 300) * 50 + next() * 10;
      }
      const lo = x[from]!;
      const hi = x[n - 1]!;
      const xMap: Mapping = { origin: lo, offset: 40, factor: width / (hi - lo), log: false };
      const yMap: Mapping = { origin: 0, offset: 200, factor: -2, log: false };
      const columns = new Polyline();
      m4(x, y, from, n, xMap, yMap, 2, columns);
      // Passing every row explicitly forces the point-by-point path.
      const identity = Uint32Array.from({ length: n }, (_, i) => i);
      const pointwise = new Polyline();
      m4(x, y, from, n, xMap, yMap, 2, pointwise, identity);
      expect(columns.count).toBe(pointwise.count);
      expect(columns.starts).toEqual(pointwise.starts);
      expect(Array.from(columns.coords.subarray(0, columns.count * 2))).toEqual(
        Array.from(pointwise.coords.subarray(0, pointwise.count * 2)),
      );
    }
  });

  it("matches point-by-point reduction at extreme magnitudes", () => {
    const compare = (xs: number[], ys: number[], xMap: Mapping, ratio: number) => {
      const x = Float64Array.from(xs);
      const y = Float64Array.from(ys);
      const columns = new Polyline();
      m4(x, y, 0, x.length, xMap, identity, ratio, columns);
      const pointwise = new Polyline();
      const rows = Uint32Array.from(xs, (_, i) => i);
      m4(x, y, 0, x.length, xMap, identity, ratio, pointwise, rows);
      expect(points(columns)).toEqual(points(pointwise));
      expect(columns.starts).toEqual(pointwise.starts);
    };
    // The right edge of the last column overflows; Infinity must break the run.
    const max = Number.MAX_VALUE;
    compare(
      [0, max, Infinity],
      [0, 1, 2],
      { origin: 0, offset: 40, factor: 760 / max, log: false },
      1,
    );
    // A finite x whose column overflows to Infinity, followed by Infinity.
    compare([1, max, Infinity], [1, 2, 3], { origin: 0, offset: 0, factor: 2, log: false }, 1);
    // A large pixel offset rounds the column edge.
    compare(
      [0, 0.9999985, 0.9999986, 0.9999987, 0.9999988, 1],
      [0, 10, 9, 8, 7, 0],
      { origin: 0, offset: 2 ** 34, factor: 1, log: false },
      1,
    );
    // A large origin cancels most of each x value's digits.
    const origin = 2 ** 52;
    compare(
      Array.from({ length: 200 }, (_, i) => origin + i),
      Array.from({ length: 200 }, (_, i) => Math.sin(i)),
      { origin: origin + 0.5, offset: 3, factor: 0.37, log: false },
      2,
    );
  });

  it("keeps sparse data unchanged", () => {
    const x = new Float64Array([0, 1, 2, 3]);
    const y = new Float64Array([5, 1, 4, 2]);
    const out = new Polyline();
    m4(x, y, 0, 4, identity, identity, 1, out);
    expect(points(out)).toEqual([
      [0, 5],
      [1, 1],
      [2, 4],
      [3, 2],
    ]);
  });

  it("keeps first, min, max, and last of each column in order", () => {
    // All points fall into column 0.
    const x = new Float64Array([0, 0.1, 0.2, 0.3, 0.4, 0.5]);
    const y = new Float64Array([3, 9, 4, 1, 5, 6]);
    const out = new Polyline();
    m4(x, y, 0, 6, identity, identity, 1, out);
    expect(points(out).map((p) => p[1])).toEqual([3, 9, 1, 6]);
  });

  it("preserves per-column extrema of dense random data", () => {
    const next = seeded(7);
    const n = 100_000;
    const x = new Float64Array(n);
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      x[i] = i;
      y[i] = Math.sin(i / 500) * 100 + next() * 40;
    }
    const xMap: Mapping = { origin: 0, offset: 10, factor: 800 / n, log: false };
    const yMap: Mapping = { origin: 0, offset: 300, factor: -1, log: false };
    const ratio = 2;
    const out = new Polyline();
    m4(x, y, 0, n, xMap, yMap, ratio, out);

    expect(out.count).toBeLessThanOrEqual(4 * 800 * ratio);
    const source = new Map<number, [number, number]>();
    for (let i = 0; i < n; i++) {
      const column = Math.floor((xMap.offset + x[i]! * xMap.factor) * ratio);
      const py = yMap.offset + y[i]! * yMap.factor;
      const range = source.get(column) ?? [Infinity, -Infinity];
      source.set(column, [Math.min(range[0], py), Math.max(range[1], py)]);
    }
    const reduced = new Map<number, [number, number]>();
    let previousX = -Infinity;
    for (const [px, py] of points(out)) {
      expect(px).toBeGreaterThanOrEqual(previousX);
      previousX = px;
      // Output is Float32; snap back to the source column with a tolerance.
      const column = Math.floor(px * ratio + 1e-4);
      const range = reduced.get(column) ?? [Infinity, -Infinity];
      reduced.set(column, [Math.min(range[0], py), Math.max(range[1], py)]);
    }
    expect(reduced.size).toBe(source.size);
    for (const [column, [lo, hi]] of source) {
      const range = reduced.get(column)!;
      expect(range[0]).toBeCloseTo(lo, 3);
      expect(range[1]).toBeCloseTo(hi, 3);
    }
  });

  it("breaks the line at missing values", () => {
    const x = new Float64Array([0, 1, 2, 3, 4]);
    const y = new Float64Array([1, 2, Number.NaN, 4, 5]);
    const out = new Polyline();
    m4(x, y, 0, 5, identity, identity, 1, out);
    expect(out.starts).toEqual([0, 2]);
    expect(out.count).toBe(4);
  });

  it("honors the index range", () => {
    const x = new Float64Array([0, 1, 2, 3, 4]);
    const y = new Float64Array([0, 1, 2, 3, 4]);
    const out = new Polyline();
    m4(x, y, 1, 3, identity, identity, 1, out);
    expect(points(out)).toEqual([
      [1, 1],
      [2, 2],
    ]);
  });
});

describe("m4 edge cases", () => {
  it("leaves gaps for values a log scale cannot place", () => {
    const x = new Float64Array([0, 1, 2, 3]);
    const y = new Float64Array([1, 0, -5, 10]);
    const out = new Polyline();
    m4(x, y, 0, 4, identity, { ...identity, log: true }, 1, out);
    expect(out.count).toBe(2);
    expect(out.starts).toEqual([0, 1]);
    for (let i = 0; i < out.count * 2; i++) expect(Number.isFinite(out.coords[i]!)).toBe(true);
  });

  it("emits extrema in traversal order for row subsets", () => {
    // Rows visited in descending order: position order differs from row order.
    const x = new Float64Array([0.9, 0.6, 0.3, 0]);
    const y = new Float64Array([4, 1, 9, 5]);
    const rows = new Uint32Array([3, 2, 1, 0]);
    const out = new Polyline();
    m4(x, y, 0, 4, identity, identity, 1, out, rows);
    expect(points(out).map((p) => p[1])).toEqual([5, 9, 1, 4]);
  });
});

describe("polylineAll", () => {
  it("keeps every point and breaks on missing x or y", () => {
    const x = new Float64Array([3, 1, Number.NaN, 2]);
    const y = new Float64Array([1, 2, 3, 4]);
    const out = new Polyline();
    polylineAll(x, y, 0, 4, identity, identity, out);
    expect(out.count).toBe(3);
    expect(out.starts).toEqual([0, 2]);
  });
});
