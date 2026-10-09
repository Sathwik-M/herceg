import { describe, expect, it } from "vitest";
import { LabelBoxes } from "../../src/layout/label-boxes.ts";

describe("label boxes", () => {
  it("find overlaps across grid cells, on either side of zero", () => {
    const boxes = new LabelBoxes();
    boxes.add(10, 10, 200, 30);
    boxes.add(-50, -20, -10, -5);
    // A box spanning several cells is found from any of them.
    expect(boxes.hits(150, 25, 160, 40)).toBe(true);
    expect(boxes.hits(-30, -10, -20, 0)).toBe(true);
    // Touching edges do not overlap.
    expect(boxes.hits(200, 10, 260, 30)).toBe(false);
    expect(boxes.hits(10, 30, 200, 50)).toBe(false);
    expect(boxes.hits(300, 300, 340, 320)).toBe(false);
  });

  it("handle boxes far off the grid or larger than it", () => {
    const boxes = new LabelBoxes();
    boxes.add(1e12, 0, 1e12 + 40, 14);
    boxes.add(-5e6, -5e6, 5e6, 5e6);
    // The huge box covers everything; the far one is found where it is.
    expect(boxes.hits(10, 10, 20, 20)).toBe(true);
    const far = new LabelBoxes();
    far.add(1e12, 0, 1e12 + 40, 14);
    expect(far.hits(1e12, 5, 1e12 + 10, 10)).toBe(true);
    expect(far.hits(0, 0, 10, 10)).toBe(false);
    expect(far.hits(0, 0, 10, 10, 0)).toBe(false);
  });

  it("stay quick with many labels", () => {
    const boxes = new LabelBoxes();
    let placed = 0;
    for (let i = 0; i < 20_000; i++) {
      const x = (i * 37) % 1000;
      const y = (i * 91) % 600;
      if (boxes.hits(x, y, x + 40, y + 14)) continue;
      boxes.add(x, y, x + 40, y + 14);
      placed++;
    }
    expect(placed).toBeGreaterThan(100);
    expect(placed).toBeLessThan(1500);
  });
});
