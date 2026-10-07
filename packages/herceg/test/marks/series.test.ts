import { describe, expect, it } from "vitest";
import { type Series, yExtent } from "../../src/marks/series.ts";

function series(x: number[], y: number[], options: Partial<Series> = {}): Series {
  const values = Float64Array.from(y);
  return {
    key: "s",
    label: "s",
    color: "#000",
    x: Float64Array.from(x),
    y: values,
    y0: undefined,
    values,
    range: false,
    rows: undefined,
    length: x.length,
    sorted: true,
    ...options,
  };
}

describe("yExtent", () => {
  it("ignores missing and infinite values in a whole sorted column", () => {
    const s = series([0, 1, 2, 3, 4], [5, Number.NaN, Number.POSITIVE_INFINITY, -2, 7]);
    expect(yExtent(s, 0, 4)).toEqual([-2, 7]);
  });

  it("covers points inside the range and where segments cross its edges", () => {
    const s = series([0, 10, 20, 30], [0, 100, 0, 100]);
    // Inside [5, 15] only x = 10; the edges cut the segments at y = 50.
    expect(yExtent(s, 5, 15)).toEqual([50, 100]);
    expect(yExtent(s, 15, 5)).toEqual([50, 100]);
  });

  it("only counts positive values on log scales", () => {
    const s = series([0, 1, 2], [-1, 0, 10]);
    expect(yExtent(s, 0, 2, s.y, true)).toEqual([10, 10]);
  });

  it("tests x for unsorted series and row subsets", () => {
    const unsorted = series([3, 0, 2, 9], [1, 50, 2, 99], { sorted: false });
    expect(yExtent(unsorted, 0, 3)).toEqual([1, 50]);
    const subset = series([0, 1, 2, 3], [9, 1, 8, 2], {
      rows: Uint32Array.from([1, 3]),
      length: 2,
    });
    expect(yExtent(subset, 0, 3)).toEqual([1, 2]);
  });
});
