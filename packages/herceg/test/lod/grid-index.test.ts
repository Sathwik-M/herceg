import { describe, expect, it } from "vitest";
import { GridIndex } from "../../src/lod/grid-index.ts";

function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

describe("GridIndex", () => {
  const bounds = { x: 0, y: 0, width: 400, height: 300 };

  it("returns the same nearest point as a full scan", () => {
    const next = seeded(3);
    const count = 5000;
    const coords = new Float32Array(count * 2).map(() => next() * 400);
    for (let i = 0; i < count; i++) coords[i * 2 + 1] = coords[i * 2 + 1]! * 0.75;
    const ids = Uint32Array.from({ length: count }, (_, i) => i * 10);
    const index = new GridIndex(coords, ids, count, bounds);
    for (let q = 0; q < 200; q++) {
      const x = next() * 440 - 20;
      const y = next() * 340 - 20;
      let best = -1;
      let bestDistance = Infinity;
      for (let i = 0; i < count; i++) {
        const d = Math.hypot(coords[i * 2]! - x, coords[i * 2 + 1]! - y);
        if (d < bestDistance) {
          bestDistance = d;
          best = i;
        }
      }
      const found = index.nearest(x, y)!;
      expect(found.distance).toBeCloseTo(bestDistance, 4);
      expect(found.id).toBe(ids[best]);
    }
  });

  it("respects a maximum distance", () => {
    const index = new GridIndex(new Float32Array([100, 100]), new Uint32Array([7]), 1, bounds);
    expect(index.nearest(110, 100, 5)).toBeUndefined();
    expect(index.nearest(110, 100, 20)).toEqual({ id: 7, distance: 10 });
  });

  it("handles an empty index", () => {
    expect(
      new GridIndex(new Float32Array(0), new Uint32Array(0), 0, bounds).nearest(5, 5),
    ).toBeUndefined();
  });
});
