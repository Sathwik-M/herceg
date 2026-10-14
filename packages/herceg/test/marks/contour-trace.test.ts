// Marching squares: the topology and geometry of traced lines and rings.
import { describe, expect, it } from "vitest";
import {
  bandRings,
  GridTracer,
  type ScalarGrid,
  type Traced,
} from "../../src/marks/contour-trace.ts";

/** A grid of rows of values, the first row at the bottom, at positions 0, 1, 2, ... */
function grid(rows: number[][]): ScalarGrid {
  const ny = rows.length;
  const nx = rows[0]!.length;
  return {
    xs: Float64Array.from({ length: nx }, (_, i) => i),
    ys: Float64Array.from({ length: ny }, (_, j) => j),
    values: Float64Array.from(rows.flat()),
  };
}

const area = (traced: Traced) => traced.areas.reduce((sum, a) => sum + a, 0);
const count = (traced: Traced) => traced.areas.length;
/** The points of ring or line k, as [u, v] pairs. */
const pointsOf = (traced: Traced, k: number) =>
  Array.from({ length: traced.starts[k + 1]! - traced.starts[k]! }, (_, p) => [
    traced.points[(traced.starts[k]! + p) * 2]!,
    traced.points[(traced.starts[k]! + p) * 2 + 1]!,
  ]);

/** The area at or above `t` of one cell's bilinear field, cut by straight lines between edge crossings. */
function cellArea(v: [number, number, number, number], t: number): number {
  // Corners counterclockwise from the bottom left, the polygon of the region traced the same way.
  const corners: [number, number][] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  const polygon: [number, number][] = [];
  for (let k = 0; k < 4; k++) {
    const next = (k + 1) % 4;
    const [a, b] = [v[k]!, v[next]!];
    if (a >= t) polygon.push(corners[k]!);
    if (a >= t !== b >= t) {
      const f = (t - a) / (b - a);
      const [p, q] = [corners[k]!, corners[next]!];
      polygon.push([p[0] + f * (q[0] - p[0]), p[1] + f * (q[1] - p[1])]);
    }
  }
  let twice = 0;
  for (let k = 0; k < polygon.length; k++) {
    const [p, q] = [polygon[k]!, polygon[(k + 1) % polygon.length]!];
    twice += p[0] * q[1] - q[0] * p[1];
  }
  return twice / 2;
}

/** The triangle cut off a cell's corner `k` by the crossings on its two sides. */
function cornerTriangle(v: [number, number, number, number], k: number, t: number): number {
  const [a, b, c] = [v[k]!, v[(k + 1) % 4]!, v[(k + 3) % 4]!];
  // Along the side to the next corner, and back along the side from the one before.
  const along = (t - a) / (b - a);
  const back = (t - a) / (c - a);
  return (along * back) / 2;
}

describe("contour tracing", () => {
  it("traces each of the sixteen cases of a cell, closing rings along the field's ends", () => {
    for (let bits = 0; bits < 16; bits++) {
      const v = [0, 1, 2, 3].map((k) => (bits & (1 << k) ? 1 : 0)) as [
        number,
        number,
        number,
        number,
      ];
      // Saddles (5, 10) are decided by the center: 0.5 here, at the threshold, joins them.
      const field = grid([
        [v[0], v[1]],
        [v[3], v[2]],
      ]);
      const tracer = new GridTracer(field);
      const rings = tracer.rings(0.5);
      expect(area(rings)).toBeCloseTo(cellArea(v, 0.5), 6);
      if (bits === 0) expect(count(rings)).toBe(0);
      if (bits === 15) expect(pointsOf(rings, 0)).toHaveLength(5);
      const lines = tracer.lines(0.5);
      const crossings = [0, 1, 2, 3].filter((k) => v[k]! >= 0.5 !== v[(k + 1) % 4]! >= 0.5).length;
      expect(lines.areas.length).toBe(crossings / 2);
    }
  });

  it("decides saddles by the bilinear interpolant's value at the saddle", () => {
    // Corners 3 and 1 high at the bottom left and top right; the saddle's value is
    // (v0 v2 - v1 v3) / (v0 + v2 - v1 - v3).
    const joined = new GridTracer(
      grid([
        [3, 0],
        [0, 3],
      ]),
    );
    // Saddle at 1.5: at 1, the high corners join through it; at 2 they do not.
    expect(count(joined.rings(1))).toBe(1);
    expect(count(joined.rings(2))).toBe(2);
    expect(count(joined.lines(1))).toBe(2);
    expect(count(joined.lines(2))).toBe(2);
    // The saddle's value exactly at the threshold counts as at or above it.
    expect(count(joined.rings(1.5))).toBe(1);
    // Above it, strictly, it does not.
    expect(count(joined.rings(1.5, true))).toBe(2);
  });

  it("decide saddles and place crossings alike however the field is shifted or scaled", () => {
    const shifted = new GridTracer(
      grid([
        [3 + 1e10, 1e10],
        [1e10, 3 + 1e10],
      ]),
    );
    expect(count(shifted.rings(1 + 1e10))).toBe(1);
    expect(count(shifted.rings(2 + 1e10))).toBe(2);
    const tiny = new GridTracer(
      grid([
        [3e-200, 0],
        [0, 3e-200],
      ]),
    );
    expect(count(tiny.rings(1e-200))).toBe(1);
    expect(count(tiny.rings(2e-200))).toBe(2);
    // Values a whole range of doubles apart cross halfway between.
    const extreme = new GridTracer(
      grid([
        [-1e308, 1e308],
        [-1e308, 1e308],
      ]),
    );
    expect(pointsOf(extreme.lines(0), 0).map(([u]) => u)).toEqual([0.5, 0.5]);
    // And the tiniest doubles cross where larger ones do.
    const subnormal = new GridTracer(
      grid([
        [0, 3 * Number.MIN_VALUE],
        [0, 3 * Number.MIN_VALUE],
      ]),
    );
    expect(pointsOf(subnormal.lines(Number.MIN_VALUE), 0).map(([u]) => u)).toEqual([
      Math.fround(1 / 3),
      Math.fround(1 / 3),
    ]);
  });

  it("cover the field with rings of a threshold below every value, holes where values are missing", () => {
    const one = (missing: [number, number]) =>
      grid(
        Array.from({ length: 5 }, (_, j) =>
          Array.from({ length: 5 }, (_, i) =>
            i === missing[0] && j === missing[1] ? Number.NaN : 1,
          ),
        ),
      );
    // Sixteen cells less the four around the missing value: a ring with a hole, turning the other way.
    const inside = new GridTracer(one([2, 2])).rings(0);
    expect(area(inside)).toBeCloseTo(12, 5);
    expect(Array.from(inside.areas).sort()).toEqual([-4, 16]);
    // At the field's edge, the missing cells notch the ring instead.
    const edge = new GridTracer(one([0, 2])).rings(0);
    expect(Array.from(edge.areas)).toEqual([14]);
    // The lines of a field all above a threshold: none.
    expect(count(new GridTracer(one([2, 2])).lines(0))).toBe(0);
  });

  it("trace closed lines around a peak and open ones where the field ends", () => {
    const peak = grid([
      [0, 0, 0, 0],
      [0, 5, 5, 0],
      [0, 5, 5, 0],
      [0, 0, 0, 0],
    ]);
    const lines = new GridTracer(peak).lines(1);
    expect(count(lines)).toBe(1);
    expect(lines.closed[0]).toBe(1);
    // Oriented with the values above on the left: counterclockwise around the peak.
    expect(lines.areas[0]).toBeGreaterThan(0);
    const slope = grid([
      [0, 1, 2],
      [0, 1, 2],
    ]);
    const open = new GridTracer(slope).lines(1.5);
    expect(count(open)).toBe(1);
    expect(open.closed[0]).toBe(0);
    expect(pointsOf(open, 0)).toEqual([
      [1.5, 1],
      [1.5, 0],
    ]);
  });

  it("nest the rings of higher thresholds inside, so bands between them cover the field once", () => {
    // A smooth bump with a dent: bands of a hill, a ring around a hollow.
    const n = 24;
    const rows = Array.from({ length: n }, (_, j) =>
      Array.from({ length: n }, (_, i) => {
        const [x, y] = [(i - 11.5) / 6, (j - 11.5) / 6];
        const r = Math.hypot(x, y);
        return Math.exp(-r * r) - 0.6 * Math.exp(-((r * 3) ** 2)) + 0.05 * Math.sin(i * 1.7 + j);
      }),
    );
    const tracer = new GridTracer(grid(rows));
    const thresholds = [-1, -0.2, 0, 0.2, 0.4, 0.6, 2];
    const sets = thresholds.map((t, k) => tracer.rings(t, k === thresholds.length - 1));
    const total = (n - 1) * (n - 1);
    expect(area(sets[0]!)).toBeCloseTo(total, 4);
    let banded = 0;
    for (let k = 0; k + 1 < sets.length; k++) {
      const band = area(sets[k]!) - area(sets[k + 1]!);
      expect(band).toBeGreaterThanOrEqual(-1e-4);
      banded += band;
    }
    expect(banded).toBeCloseTo(total, 4);
    // The rings' area is the sum of each cell's, cut on its own, saddles as decided.
    const cellwise = (t: number) => {
      let sum = 0;
      for (let j = 0; j + 1 < n; j++)
        for (let i = 0; i + 1 < n; i++) {
          const v: [number, number, number, number] = [
            rows[j]![i]!,
            rows[j]![i + 1]!,
            rows[j + 1]![i + 1]!,
            rows[j + 1]![i]!,
          ];
          const up = v.map((x) => x >= t);
          const saddle = up[0] === up[2] && up[1] === up[3] && up[0] !== up[1];
          if (!saddle) {
            sum += cellArea(v, t);
            continue;
          }
          const center = (v[0] * v[2] - v[1] * v[3]) / (v[0] + v[2] - v[1] - v[3]);
          const corners = [0, 1, 2, 3].filter((k) => up[k] === center < t);
          const cut = corners.reduce((s, k) => s + cornerTriangle(v, k, t), 0);
          sum += center >= t ? 1 - cut : cut;
        }
      return sum;
    };
    for (const t of [-0.2, 0.2, 0.6]) expect(area(tracer.rings(t))).toBeCloseTo(cellwise(t), 4);
  });

  it("make a band's own rings where its thresholds' rings share the grid's ends", () => {
    const band = (rows: number[][], low: number, high: number, last = false) => {
      const tracer = new GridTracer(grid(rows));
      const [lower, upper] = [tracer.rings(low), tracer.rings(high, last)];
      return { lower, upper, ...bandRings(lower, upper) };
    };
    // Above both thresholds everywhere: the two rings are one, and the band has none.
    const above = band(
      [
        [5, 5],
        [5, 5],
      ],
      1,
      2,
    );
    expect(Array.from(above.replaced[0])).toEqual([1]);
    expect(Array.from(above.replaced[1])).toEqual([1]);
    expect(count(above.rings)).toBe(0);
    // Two low corners, apart: two pieces, their area what the thresholds' rings leave between them.
    const corners = band(
      [
        [0.2, 1],
        [1, 0.2],
      ],
      0,
      0.3,
    );
    expect(Array.from(corners.rings.areas).filter((a) => a > 0)).toHaveLength(2);
    expect(area(corners.rings)).toBeCloseTo(area(corners.lower) - area(corners.upper), 6);
    // A smooth bump: the band covers the same area however its rings are made.
    const n = 12;
    const bump = Array.from({ length: n }, (_, j) =>
      Array.from({ length: n }, (_, i) => Math.exp(-(((i - 5) / 3) ** 2) - ((j - 6) / 4) ** 2)),
    );
    const middle = band(bump, 0.1, 0.5);
    const kept = (set: Traced, out: Uint8Array) =>
      Array.from(set.areas).reduce((sum, a, r) => sum + (out[r] ? 0 : a), 0);
    const rebuilt =
      kept(middle.lower, middle.replaced[0]) -
      kept(middle.upper, middle.replaced[1]) +
      area(middle.rings);
    expect(rebuilt).toBeCloseTo(area(middle.lower) - area(middle.upper), 6);
  });

  it("place crossings by the edges' values, the same from either cell", () => {
    const field = grid([
      [0, 4, 0],
      [0, 4, 0],
    ]);
    const lines = new GridTracer(field).lines(1);
    // Two lines, a quarter of the way along the edges either side of the ridge.
    const us = [0, 1].flatMap((k) => pointsOf(lines, k).map(([u]) => u)).sort();
    expect(us).toEqual([0.25, 0.25, 1.75, 1.75]);
  });

  it("leave out rings of no area, as a lone sample at the threshold makes", () => {
    const field = grid([
      [0, 0, 0],
      [0, 1, 0],
      [0, 0, 0],
    ]);
    expect(count(new GridTracer(field).rings(1))).toBe(0);
    expect(count(new GridTracer(field).lines(1))).toBe(0);
    expect(new GridTracer(grid([[1]])).empty).toBe(true);
  });
});
