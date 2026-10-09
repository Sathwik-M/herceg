import { describe, expect, it } from "vitest";
import { Clipper, cut } from "../../src/geo/clip.ts";
import { MERCATOR_LIMIT } from "../../src/geo/projection.ts";

/** Every ring a clipper writes, as flat longitude, latitude lists. */
function rings(clipper: Clipper, ...input: number[][]): number[][] {
  const out: number[][] = [];
  let current: number[] = [];
  const sink = {
    start: () => {
      current = [];
    },
    point: (lon: number, lat: number) => current.push(lon, lat),
    end: () => out.push(current),
  };
  for (const ring of input) clipper.ring(ring, 0, ring.length / 2, sink);
  return out;
}

function extent(ring: readonly number[], axis: 0 | 1): [number, number] {
  const values = ring.filter((_, i) => i % 2 === axis);
  return [Math.min(...values), Math.max(...values)];
}

/** Twice the signed area of a ring. */
function area(ring: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i += 2) {
    const j = (i + 2) % ring.length;
    sum += ring[i]! * ring[j + 1]! - ring[j]! * ring[i + 1]!;
  }
  return sum / 2;
}

/** Even-odd: whether a point is inside a set of rings. */
function inside(set: readonly number[][], x: number, y: number): boolean {
  let odd = false;
  for (const ring of set) {
    for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
      const [xi, yi, xj, yj] = [ring[i]!, ring[i + 1]!, ring[j]!, ring[j + 1]!];
      if (yi > y !== yj > y && x < xj + ((y - yj) * (xi - xj)) / (yi - yj)) odd = !odd;
    }
  }
  return odd;
}

describe("cut", () => {
  it("keeps a ring inside and drops one outside", () => {
    const square = [0, 0, 2, 0, 2, 2, 0, 2];
    const out: number[][] = [];
    cut(square, 0, -1, 1, out);
    expect(out).toEqual([square]);
    cut(square, 0, 5, 1, out);
    expect(out).toHaveLength(1);
  });

  it("splits a concave ring into separate rings, without connectors along the line", () => {
    // A U opening upward, cut above y = 2: its two arms.
    const u = [0, 0, 3, 0, 3, 3, 2, 3, 2, 1, 1, 1, 1, 3, 0, 3];
    const out: number[][] = [];
    cut(u, 1, 2, 1, out);
    expect(out).toHaveLength(2);
    const arms = out.map((ring) => extent(ring, 0)).sort((a, b) => a[0] - b[0]);
    expect(arms).toEqual([
      [0, 1],
      [2, 3],
    ]);
    for (const ring of out) expect(Math.abs(area(ring))).toBeCloseTo(1, 12);
  });

  it("joins the pieces of a ring that leaves and comes back on the same side", () => {
    // A C opening right, cut left of x = 2: one ring around the C's back.
    const c = [3, 0, 3, 1, 1, 1, 1, 2, 3, 2, 3, 3, 0, 3, 0, 0];
    const out: number[][] = [];
    cut(c, 0, 2, -1, out);
    expect(out).toHaveLength(1);
    expect(Math.abs(area(out[0]!))).toBeCloseTo(5, 12);
  });

  it("does not throw on a ring that crosses itself", () => {
    const bow = [0, 0, 2, 2, 2, 0, 0, 2];
    const out: number[][] = [];
    expect(() => cut(bow, 0, 1, 1, out)).not.toThrow();
  });
});

describe("Clipper", () => {
  it("leaves rings within the map as they are, without their closing point", () => {
    const ring = [10, 10, 10.5, 10, 10.5, 10.5, 10, 10.5, 10, 10];
    expect(rings(new Clipper(0, 90), ring)).toEqual([ring.slice(0, -2)]);
  });

  it("reads edges as straight in longitude and latitude: a wide ring stays wide", () => {
    // RFC 7946: an edge from -170 to 170 runs the long way, not across the antimeridian.
    const [wide] = rings(new Clipper(0, 90), [-170, 0, 170, 0, 170, 1, -170, 1]);
    expect(extent(wide!, 0)).toEqual([-170, 170]);
  });

  it("cuts a ring at the seam opposite the central meridian and moves the pieces", () => {
    // Longitudes -40 to -20 with the center at 150: the seam is at -30.
    const out = rings(new Clipper(150, 90), [-40, 0, -20, 0, -20, 1, -40, 1]);
    expect(out).toHaveLength(2);
    const spans = out.map((ring) => extent(ring, 0)).sort((a, b) => a[0] - b[0]);
    expect(spans[0]![0]).toBeCloseTo(-180, 12);
    expect(spans[0]![1]).toBeCloseTo(-170, 12);
    expect(spans[1]![0]).toBeCloseTo(170, 12);
    expect(spans[1]![1]).toBeCloseTo(180, 12);
  });

  it("cuts holes across the seam so that they stay holes", () => {
    const outer = [-40, -10, -20, -10, -20, 10, -40, 10];
    const hole = [-34, -4, -34, 4, -26, 4, -26, -4];
    const out = rings(new Clipper(150, 90), outer, hole);
    expect(out).toHaveLength(4);
    // Shifted by the center, -30 is the map's edge: -35 lands at 175, -25 at -175.
    expect(inside(out, 172, 8)).toBe(true);
    expect(inside(out, 177, 0)).toBe(false);
    expect(inside(out, -177, 0)).toBe(false);
    expect(inside(out, -172, 0)).toBe(true);
  });

  it("cuts rings at the latitude limit", () => {
    const [ring] = rings(new Clipper(0, MERCATOR_LIMIT), [0, -89, 10, -89, 10, 89, 0, 89]);
    expect(extent(ring!, 1)[0]).toBeCloseTo(-MERCATOR_LIMIT, 12);
    expect(extent(ring!, 1)[1]).toBeCloseTo(MERCATOR_LIMIT, 12);
  });

  it("divides edges longer than a degree", () => {
    const [ring] = rings(new Clipper(0, 90), [0, 0, 10, 0, 10, 0.5, 0, 0.5]);
    // Ten points along each long edge, one along each short one.
    expect(ring!.length / 2).toBe(22);
    expect(ring!.slice(0, 6)).toEqual([0, 0, 1, 0, 2, 0]);
  });

  it("skips points that are not finite and rings left with fewer than three", () => {
    const clipper = new Clipper(0, 90);
    expect(rings(clipper, [0, 0, Number.NaN, 1, 1, 1, 0, 1])).toHaveLength(1);
    expect(rings(clipper, [0, 0, Number.NaN, 1, 1, 1])).toHaveLength(0);
  });

  it("cuts rings of many points into several without overflowing a call's arguments", () => {
    // A comb across the seam: a long run of points, then teeth crossing it.
    const ring: number[] = [];
    for (let i = 0; i <= 200_000; i++) ring.push(-40 + (i / 200_000) * 20, 0);
    for (let tooth = 0; tooth < 5; tooth++) {
      const x = -21 - tooth * 4;
      ring.push(x, 10, x - 1, 10, x - 1, 5, x - 2, 5);
    }
    ring.push(-40, 10);
    expect(() => rings(new Clipper(150, 90), ring)).not.toThrow();
  });

  it("leaves out rings wider than the map can hold", () => {
    expect(rings(new Clipper(0, 90), [0, 0, 1e9, 0, 1e9, 1, 0, 1])).toHaveLength(0);
  });

  it("wraps a point's longitude about the central meridian", () => {
    // Huge longitudes wrap before the shift, so the center's offset survives.
    expect(new Clipper(176, 90).longitude(3e100, 0)).toBe(0);
    const clipper = new Clipper(150, MERCATOR_LIMIT);
    expect(clipper.longitude(-170, 0)).toBe(40);
    expect(clipper.longitude(-40, 0)).toBe(170);
    expect(clipper.longitude(160, 89)).toBeNaN();
    expect(clipper.longitude(Number.NaN, 0)).toBeNaN();
  });
});
