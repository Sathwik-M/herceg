import { describe, expect, it } from "vitest";
import { HitGrid } from "../../src/layout/hit-grid.ts";

describe("network picking candidates", () => {
  it.each([32.1, 0.1])(
    "keeps segment candidates in a fractional final row of height %s",
    (height) => {
      const bounds = { x: 0, y: 0, width: 100, height };
      const y = height - 0.05;
      const grid = new HitGrid(bounds, (grid, add) => grid.segment(0, 0, y, 100, y, 4.5, add));
      expect([...grid.at(50, y)]).toEqual([0]);
      expect([...grid.at(100, height)]).toEqual([0]);
    },
  );

  it("matches a linear segment scan at fractional bounds and tolerance edges", () => {
    let seed = 71;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let trial = 0; trial < 25; trial++) {
      const bounds = {
        x: random() * 20 - 10,
        y: random() * 20 - 10,
        width: 32 * (trial % 5) + 0.1 + random() * 0.2,
        height: 32 * (trial % 7) + 0.1 + random() * 0.2,
      };
      const { x, y, width, height } = bounds;
      const reach = 4.5;
      const segments = Array.from({ length: 40 }, () => [
        x - 50 + random() * (width + 100),
        y - 50 + random() * (height + 100),
        x - 50 + random() * (width + 100),
        y - 50 + random() * (height + 100),
      ]);
      segments.push(
        [x - 100, y + height - 0.05, x + width + 100, y + height - 0.05],
        [x + width - 0.05, y - 100, x + width - 0.05, y + height + 100],
      );
      const grid = new HitGrid(bounds, (grid, add) =>
        segments.forEach(([ax, ay, bx, by], i) => {
          grid.segment(i, ax!, ay!, bx!, by!, reach, add);
        }),
      );
      const distance = (i: number, px: number, py: number) => {
        const [ax, ay, bx, by] = segments[i]! as [number, number, number, number];
        const dx = bx - ax,
          dy = by - ay;
        const t =
          dx * dx + dy * dy === 0
            ? 0
            : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
        return Math.hypot(px - ax - t * dx, py - ay - t * dy);
      };
      const queries = Array.from({ length: 200 }, () => [
        x + random() * width,
        y + random() * height,
      ]);
      for (const px of [x, x + width / 2, x + width])
        for (const py of [y, y + height - 0.05, y + height]) queries.push([px, py]);
      for (const [ax, ay, bx, by] of segments) {
        const dx = bx! - ax!,
          dy = by! - ay!,
          length = Math.hypot(dx, dy);
        if (!length) continue;
        for (const tolerance of [reach - 1e-6, reach, reach + 1e-6]) {
          const px = (ax! + bx!) / 2 - (dy / length) * tolerance;
          const py = (ay! + by!) / 2 + (dx / length) * tolerance;
          if (px >= x && px <= x + width && py >= y && py <= y + height) queries.push([px, py]);
        }
      }
      for (const [px, py] of queries as [number, number][]) {
        const candidates = [...grid.at(px, py)];
        expect(new Set(candidates).size).toBe(candidates.length);
        const scan = segments.flatMap((_, i) => (distance(i, px, py) <= reach ? [i] : []));
        expect(candidates.filter((i) => distance(i, px, py) <= reach)).toEqual(scan);
      }
    }
  });

  it("includes every segment within pointer reach, without duplicate candidates", () => {
    let seed = 43;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    // Includes zero-length, horizontal, vertical, very long and offscreen segments.
    const segments = Array.from({ length: 200 }, () =>
      Array.from({ length: 4 }, () => random() * 1000 - 300),
    );
    segments.push([200, 200, 200, 200], [-1e9, 50, 1e9, 50], [60, -1e9, 60, 1e9]);
    const bounds = { x: 10, y: 20, width: 400, height: 300 };
    const grid = new HitGrid(bounds, (grid, add) =>
      segments.forEach(([ax, ay, bx, by], i) => {
        grid.segment(i, ax!, ay!, bx!, by!, 7, add);
      }),
    );
    for (let query = 0; query < 1000; query++) {
      const x = 10 + random() * 400,
        y = 20 + random() * 300;
      const found = grid.at(x, y);
      expect(new Set(found).size).toBe(found.length);
      segments.forEach(([ax, ay, bx, by], i) => {
        const dx = bx! - ax!,
          dy = by! - ay!;
        const t =
          dx * dx + dy * dy === 0
            ? 0
            : Math.max(0, Math.min(1, ((x - ax!) * dx + (y - ay!) * dy) / (dx * dx + dy * dy)));
        if (Math.hypot(x - ax! - t * dx, y - ay! - t * dy) <= 7) expect(found).toContain(i);
      });
    }
    expect(grid.at(9, 30)).toHaveLength(0);
  });
});
