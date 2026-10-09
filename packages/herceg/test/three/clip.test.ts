import { describe, expect, it } from "vitest";
import { cutSegment } from "../../src/three/clip.ts";

const cut = (a: number[], b: number[]) => {
  const out = new Float64Array(6);
  const ends: [boolean, boolean] = [false, false];
  return cutSegment(a, b, out)
    ? { out: [...out], ends: cutSegment(a, b, out, ends) && ends }
    : undefined;
};

describe("cutting segments at the box's walls", () => {
  it("keeps the part inside, and says which ends were cut", () => {
    expect(cut([0, 0, 0], [0.5, 0.5, 0])).toEqual({
      out: [0, 0, 0, 0.5, 0.5, 0],
      ends: [false, false],
    });
    expect(cut([0, 0, 0], [3, 0, 0])).toEqual({ out: [0, 0, 0, 1, 0, 0], ends: [false, true] });
    const across = cut([-3, 0.5, 0], [3, 0.5, 0.6])!.out;
    [-1, 0.5, 0.2, 1, 0.5, 0.4].forEach((value, k) => {
      expect(across[k]).toBeCloseTo(value, 12);
    });
    expect(cut([2, 2, 0], [3, 3, 0])).toBeUndefined();
    expect(cut([0, 2, 0], [0, 2, 1])).toBeUndefined();
  });

  it("places the part inside exactly however far past the box the ends are", () => {
    for (const far of [1e8, 1e16, 1e20, 1e40, 1e300]) {
      const part = cut([-far, 0.25, -0.5], [far, 0.75, 0.5])!.out;
      expect(part[0]).toBe(-1);
      expect(part[3]).toBe(1);
      // Across the box y and z hardly move: a box's width of 2 * far.
      for (const k of [1, 2, 4, 5]) expect(part[k]).toBeCloseTo([0, 0.5, 0, 0, 0.5, 0][k]!, 6);
    }
  });

  it("keeps corners where a segment crosses two walls at once, and never overflows", () => {
    // A diagonal through the box's corners.
    expect(cut([-3, -3, 0], [3, 3, 0])!.out).toEqual([-1, -1, 0, 1, 1, 0]);
    // From far out on two axes at once float64 cannot place the part inside: it is left out.
    expect(cut([-1e16, -1e16, 0], [1e16, 1e16, 0])).toBeUndefined();
    // From far out to just past the box, either way along.
    expect(cut([-1e20, 0, 0], [2, 0, 0])!.out).toEqual([-1, 0, 0, 1, 0, 0]);
    expect(cut([2, 0, 0], [-1e20, 0, 0])!.out).toEqual([1, 0, 0, -1, 0, 0]);
    expect(cut([-1e20, 0.5, 0], [0.5, 0.5, 0])).toEqual({
      out: [-1, 0.5, 0, 0.5, 0.5, 0],
      ends: [true, false],
    });
    // Far out on two axes to just past the box: its own crossings, or none, either way along.
    const close = (part: number[] | undefined, expected: number[]) =>
      expected.forEach((value, k) => {
        expect(part![k]).toBeCloseTo(value, 9);
      });
    close(cut([-1e20, -1e20, 0], [2, 3, 0])?.out, [-1, 0, 0, 0, 1, 0]);
    close(cut([2, 3, 0], [-1e20, -1e20, 0])?.out, [0, 1, 0, -1, 0, 0]);
    expect(cut([-1e20, -1e20, 0], [2, 5, 0])).toBeUndefined();
    expect(cut([2, 5, 0], [-1e20, -1e20, 0])).toBeUndefined();
    // Just off that diagonal, its crossings are its own; far out, they are left out.
    close(cut([-1e6, -1e6 + 0.5, 0], [1e6, 1e6 + 0.5, 0])?.out, [-1, -0.5, 0, 0.5, 1, 0]);
    expect(cut([-1e12, -1e12 + 0.5, 0], [1e12, 1e12 + 0.5, 0])).toBeUndefined();
    // Ends whose difference overflows a double.
    const huge = cut([-1.7e308, 0.5, 0], [1.7e308, 0.5, 0])!.out;
    expect(huge).toEqual([-1, 0.5, 0, 1, 0.5, 0]);
    for (const [a, b] of [
      [
        [-1.7e308, -1.7e308, 0],
        [1.7e308, 1.7e308, 0],
      ],
      [
        [-1e300, 3e299, -1e299],
        [1e300, -2e299, 4e299],
      ],
    ] as const) {
      const part = cut([...a], [...b]);
      if (part) for (const value of part.out) expect(Math.abs(value)).toBeLessThanOrEqual(1);
    }
  });
});
