import { describe, expect, it } from "vitest";
import { ArcPath, type ArcSink, inSector, traceSector } from "../../src/draw/arc.ts";

/** A sink that records calls, flattening arcs into points every 0.01 radians. */
function recorder() {
  const points: [number, number][] = [];
  const calls: string[] = [];
  const sink: ArcSink = {
    moveTo: (x, y) => {
      calls.push("M");
      points.push([x, y]);
    },
    lineTo: (x, y) => {
      calls.push("L");
      points.push([x, y]);
    },
    bezierCurveTo: () => calls.push("C"),
    closePath: () => calls.push("Z"),
    rect: () => calls.push("R"),
    arc: (cx, cy, r, a0, a1, ccw) => {
      calls.push(ccw ? "a" : "A");
      const steps = Math.max(1, Math.ceil(Math.abs(a1 - a0) / 0.01));
      for (let i = 0; i <= steps; i++) {
        const a = a0 + ((a1 - a0) * i) / steps;
        points.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
      }
    },
  };
  return { sink, points, calls };
}

/** Distance from (x, y) to the line through the origin at `angle`. */
const offLine = ([x, y]: [number, number], angle: number) =>
  Math.abs(x * Math.sin(angle) - y * Math.cos(angle));

describe("traceSector", () => {
  it("traces a donut slice: outer arc clockwise, inner arc back", () => {
    const { sink, points, calls } = recorder();
    traceSector(sink, 0, 0, 50, 100, 0, Math.PI / 2, 0);
    expect(calls).toEqual(["M", "A", "a", "Z"]);
    for (const [x, y] of points) {
      expect([50, 100].some((r) => Math.abs(Math.hypot(x, y) - r) < 1e-9)).toBe(true);
      expect(x).toBeGreaterThanOrEqual(-1e-9);
      expect(y).toBeGreaterThanOrEqual(-1e-9);
    }
  });

  it("moves sides inward by half the gap, parallel to themselves", () => {
    const { sink, points } = recorder();
    const [a0, a1] = [0.3, 1.4];
    traceSector(sink, 0, 0, 0, 100, a0, a1, 4);
    // The first and last points of the outer arc lie 2 px off the slice's edges.
    const outer = points.filter(([x, y]) => Math.abs(Math.hypot(x, y) - 100) < 1e-9);
    expect(offLine(outer[0]!, a0)).toBeCloseTo(2, 9);
    expect(offLine(outer.at(-1)!, a1)).toBeCloseTo(2, 9);
    // The slice's point sits where both moved sides meet: 2 px off each.
    const tip = points.at(-1)!;
    expect(offLine(tip, a0)).toBeCloseTo(2, 9);
    expect(offLine(tip, a1)).toBeCloseTo(2, 9);
  });

  it("draws whole rings as two circles, and thin slices with a smaller gap", () => {
    const ring = recorder();
    traceSector(ring.sink, 0, 0, 40, 80, 0, 2 * Math.PI, 2);
    expect(ring.calls).toEqual(["M", "A", "Z", "M", "a", "Z"]);
    // A slice 1 px wide at its rim keeps a third of that from its neighbors.
    const thin = recorder();
    traceSector(thin.sink, 0, 0, 0, 100, 0, 0.01, 4);
    expect(thin.calls).toEqual(["M", "A", "a", "Z"]);
    expect(offLine(thin.points[0]!, 0)).toBeCloseTo(1 / 6, 9);
  });

  it("tells points in a sector as drawn from those in its gaps, hole, and point", () => {
    const [a0, a1] = [0, Math.PI / 2];
    const at = (radius: number, angle: number) =>
      inSector(radius * Math.cos(angle), radius * Math.sin(angle), 0, 0, 20, 100, a0, a1, 4);
    expect(at(60, Math.PI / 4)).toBe(true);
    expect(at(10, Math.PI / 4)).toBe(false);
    expect(at(101, Math.PI / 4)).toBe(false);
    // 1 px from a side is in the 2 px half gap.
    expect(at(60, Math.asin(1 / 60))).toBe(false);
    expect(at(60, Math.asin(3 / 60))).toBe(true);
    // Over half a turn, points across the center from a side are inside.
    expect(inSector(-50, 1, 0, 0, 0, 100, 0, 1.5 * Math.PI, 4)).toBe(true);
  });
});

describe("ArcPath", () => {
  it("continue the path with a line to their start, and split over half a turn", () => {
    const path = new ArcPath();
    path.moveTo(0, 0);
    path.arc(0, 0, 10, 0, Math.PI * 1.5);
    expect(path.d).toBe("M0 0L10 0A10 10 0 0 1 -7.1 7.1A10 10 0 0 1 0 -10");
    const ring = new ArcPath();
    traceSector(ring, 50, 50, 0, 20, 0, 2 * Math.PI, 0);
    expect(ring.d).toBe("M70 50A20 20 0 0 1 30 50A20 20 0 0 1 70 50Z");
  });
});
