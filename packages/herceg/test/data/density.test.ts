import { describe, expect, it } from "vitest";
import { type Density, kde, silverman } from "../../src/data/density.ts";

/** The density at `x` by summing every value's kernel. */
function direct(values: readonly number[], bandwidth: number, x: number): number {
  let sum = 0;
  for (const v of values) sum += Math.exp(-0.5 * ((x - v) / bandwidth) ** 2);
  return sum / (values.length * bandwidth * Math.sqrt(2 * Math.PI));
}

const step = (density: Density) => (density.hi - density.lo) / (density.values.length - 1);

/** The area under the profile drawn through a density's points, between two values (trapezoids). */
function profileMass(density: Density, from: number, to: number): number {
  const { lo, values } = density;
  let sum = 0;
  for (let i = 1; i < values.length; i++) {
    const at = lo + (i - 0.5) * step(density);
    if (at >= from && at < to) sum += ((values[i - 1]! + values[i]!) / 2) * step(density);
  }
  return sum;
}

describe("silverman", () => {
  it("takes the smaller of the standard deviation and IQR / 1.34, as R's bw.nrd0 does", () => {
    // R: bw.nrd0(1:5) = 0.9 * min(sd 1.5811, IQR 2 / 1.34) * 5^-0.2
    expect(silverman([1, 2, 3, 4, 5])).toBeCloseTo(0.9 * (2 / 1.34) * 5 ** -0.2, 12);
    // A zero IQR falls back to the standard deviation.
    const spike = [0, 0, 0, 0, 0, 0, 0, 8];
    expect(silverman(spike)).toBeCloseTo(0.9 * Math.sqrt(8) * 8 ** -0.2, 12);
    // Tiny and huge values neither underflow nor overflow.
    expect(silverman([1e-200, 2e-200, 3e-200, 4e-200, 5e-200])).toBeCloseTo(
      0.9 * (2e-200 / 1.34) * 5 ** -0.2,
      212,
    );
    expect(Number.isFinite(silverman([0, 0, 0, 0, 0, 0, 0, 1e200]))).toBe(true);
    expect(silverman([0, 0, 0, 0, 0, 0, 0, 1e200])).toBeGreaterThan(0);
    expect(silverman([3, 3, 3])).toBe(0);
    expect(silverman([3])).toBe(0);
    expect(silverman([])).toBe(0);
  });
});

describe("kde", () => {
  it("spans two bandwidths past the values and integrates to their mass inside", () => {
    const density = kde([0], 1)!;
    expect([density.lo, density.hi]).toEqual([-2, 2]);
    const { values } = density;
    const step = (density.hi - density.lo) / (values.length - 1);
    let integral = 0;
    for (let i = 1; i < values.length; i++) integral += ((values[i - 1]! + values[i]!) / 2) * step;
    // A normal distribution has 95.45% of its mass within two deviations.
    expect(integral).toBeCloseTo(0.9545, 3);
    // The value falls between two estimation points, which share it.
    expect(Math.max(...values)).toBeCloseTo(1 / Math.sqrt(2 * Math.PI), 3);
  });

  it("matches the exact sum of kernels within a fraction of a percent of the peak", () => {
    let seed = 3;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const values = Array.from({ length: 5000 }, () => random() ** 3 * 50).sort((a, b) => a - b);
    const bandwidth = silverman(values);
    const density = kde(values, bandwidth)!;
    const step = (density.hi - density.lo) / (density.values.length - 1);
    const peak = Math.max(...density.values);
    for (let i = 0; i < density.values.length; i += 7) {
      const exact = direct(values, bandwidth, density.lo + i * step);
      expect(Math.abs(density.values[i]! - exact)).toBeLessThan(peak * 0.005);
    }
  });

  it("keeps mass where it is when the span is too wide for a third of a bandwidth", () => {
    // A thousand values in [0, 1) and one at 10,000: 512 points are about 20 apart,
    // over 200 bandwidths.
    const values = [...Array.from({ length: 1000 }, (_, i) => i / 1000), 10_000];
    const density = kde(values, silverman(values))!;
    expect(step(density)).toBeGreaterThan(100 * silverman(values));
    expect(profileMass(density, -Infinity, Infinity)).toBeCloseTo(1, 6);
    expect(profileMass(density, -Infinity, 1000)).toBeCloseTo(1000 / 1001, 6);
    // Clusters at the ends of the span keep their mass as well as one in the middle.
    const clusters = kde([0, 0, 0.5, 0.5, 1, 1], 1e-5)!;
    for (const [from, to] of [
      [-Infinity, 0.25],
      [0.25, 0.75],
      [0.75, Infinity],
    ] as const)
      expect(profileMass(clusters, from, to)).toBeCloseTo(1 / 3, 6);
  });

  it("scales with the values without overflowing", () => {
    /** Whether `b` is `a` for values `scale` times larger: the same shape, divided by `scale`. */
    const scaled = (a: Density, b: Density, scale: number) => {
      const peak = Math.max(...a.values);
      a.values.forEach((value, i) => {
        if (value > peak * 1e-9) expect((b.values[i]! * scale) / value).toBeCloseTo(1, 9);
      });
    };
    const small = Array.from({ length: 100 }, (_, i) => i / 99);
    scaled(
      kde(small, 0.1)!,
      kde(
        small.map((v) => v * 1e307),
        1e306,
      )!,
      1e307,
    );
    // The same on a grid too coarse for the kernel.
    const outlier = [...small, 1e4];
    scaled(
      kde(outlier, 1e-3)!,
      kde(
        outlier.map((v) => v * 1e300),
        1e297,
      )!,
      1e300,
    );
  });

  it("gives nothing without values, a positive bandwidth, or a finite span", () => {
    expect(kde([], 1)).toBeUndefined();
    expect(kde([1, 2], 0)).toBeUndefined();
    expect(kde([-1e308, 1e308], 1e307)).toBeUndefined();
    // A density too high for a double.
    expect(kde([0, 1e-320], 1e-320)).toBeUndefined();
  });
});
