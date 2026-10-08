import { describe, expect, it } from "vitest";
import { placePieLabels, spread } from "../../src/layout/pie-labels.ts";

describe("spread", () => {
  it("keeps positions that do not collide and pushes the rest apart within bounds", () => {
    expect(spread([10, 50, 90], 12, 0, 100)).toEqual([10, 50, 90]);
    expect(spread([50, 51, 52], 10, 0, 100)).toEqual([50, 60, 70]);
    expect(spread([95, 96, 97], 10, 0, 100)).toEqual([80, 90, 100]);
    expect(spread([-20, 5], 10, 0, 100)).toEqual([0, 10]);
  });
});

describe("placePieLabels", () => {
  it("puts labels on the side of their slice, in order, without overlaps", () => {
    const angles = [-0.2, 0, 0.1, 0.2, Math.PI - 0.1, Math.PI + 0.1];
    const placed = placePieLabels(
      angles.map((angle, i) => ({ angle, priority: i })),
      200,
      150,
      100,
      14,
      0,
      300,
    );
    expect(placed.map((p) => p.anchor)).toEqual(["start", "start", "start", "start", "end", "end"]);
    const right = placed.filter((p) => p.anchor === "start").map((p) => p.y);
    for (let i = 1; i < right.length; i++)
      expect(right[i]! - right[i - 1]!).toBeGreaterThanOrEqual(14);
    // Text starts past the pie's widest point, and the leader starts on the slice's edge.
    for (const p of placed) {
      expect(Math.abs(p.x - 200)).toBeGreaterThan(100);
      const [x, y] = p.line;
      expect(Math.hypot(x! - 200, y! - 150)).toBeCloseTo(100, 9);
    }
  });

  it("drops the smallest slices' labels when a side has no room", () => {
    const inputs = [0, 0.05, 0.1, 0.15].map((angle, i) => ({ angle, priority: [5, 1, 9, 3][i]! }));
    const placed = placePieLabels(inputs, 100, 50, 30, 20, 0, 60);
    expect(placed.map((p) => p.index)).toEqual([0, 2, 3]);
  });

  it("keeps leader lines outside the pie however far labels move", () => {
    // One big slice and many small ones near the top: their labels spread far.
    const fractions = [0.9, ...Array.from({ length: 10 }, () => 0.01)];
    let start = -Math.PI / 2;
    const inputs = fractions.map((f, i) => {
      const angle = start + f * Math.PI;
      start += f * 2 * Math.PI;
      return { angle, priority: f + i * 1e-6 };
    });
    const [cx, cy, r] = [200, 150, 100];
    for (const { line } of placePieLabels(inputs, cx, cy, r, 14, 0, 300)) {
      // Every segment past the first, sampled, is outside the circle.
      for (let k = 1; k < 4; k++) {
        const [x0, y0, x1, y1] = line.slice(k * 2, k * 2 + 4) as [number, number, number, number];
        for (let t = 0; t <= 1; t += 0.05) {
          const d = Math.hypot(x0 + (x1 - x0) * t - cx, y0 + (y1 - y0) * t - cy);
          expect(d).toBeGreaterThanOrEqual(r);
        }
      }
    }
  });
});
