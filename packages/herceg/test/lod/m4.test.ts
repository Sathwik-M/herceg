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
