import { describe, expect, it } from "vitest";
import { LabelBoxes, segmentMeetsBox, segmentsMeet } from "../../src/layout/label-boxes.ts";

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

  it("tell segments that pass through a box from those that miss or only touch it", () => {
    const box = [10, 10, 20, 20] as const;
    expect(segmentMeetsBox(0, 15, 30, 15, ...box)).toBe(true);
    expect(segmentMeetsBox(0, 0, 30, 30, ...box)).toBe(true);
    // Ending inside counts; ending at a side, running along one, or missing does not.
    expect(segmentMeetsBox(0, 15, 12, 15, ...box)).toBe(true);
    expect(segmentMeetsBox(0, 15, 10, 15, ...box)).toBe(false);
    expect(segmentMeetsBox(0, 10, 30, 10, ...box)).toBe(false);
    expect(segmentMeetsBox(0, 0, 30, 5, ...box)).toBe(false);
    expect(segmentMeetsBox(0, 21, 9, 30, ...box)).toBe(false);
    // A diagonal past a corner, whose bounds overlap the box's.
    expect(segmentMeetsBox(5, 18, 18, 31, ...box)).toBe(false);
    const boxes = new LabelBoxes();
    boxes.add(...box);
    boxes.add(500, 500, 540, 514);
    expect(boxes.crosses(0, 15, 600, 15)).toBe(true);
    expect(boxes.crosses(0, 30, 600, 30)).toBe(false);
    expect(boxes.crosses(400, 400, 520, 520)).toBe(true);
  });

  it("tell segments that cross, touch, or overlap from separate ones", () => {
    // Crossing, and either order of ends.
    expect(segmentsMeet(0, 0, 10, 10, 0, 10, 10, 0)).toBe(true);
    expect(segmentsMeet(10, 10, 0, 0, 10, 0, 0, 10)).toBe(true);
    // An end on the other segment, and shared ends.
    expect(segmentsMeet(0, 0, 10, 0, 5, 0, 5, 5)).toBe(true);
    expect(segmentsMeet(0, 0, 10, 0, 10, 0, 10, 5)).toBe(true);
    // Collinear and overlapping, or collinear with a gap.
    expect(segmentsMeet(0, 0, 10, 0, 5, 0, 15, 0)).toBe(true);
    expect(segmentsMeet(0, 0, 10, 0, 11, 0, 15, 0)).toBe(false);
    // Parallel, and apart though their lines would cross.
    expect(segmentsMeet(0, 0, 10, 0, 0, 1, 10, 1)).toBe(false);
    expect(segmentsMeet(0, 0, 4, 4, 10, 0, 6, 4)).toBe(false);
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
