import { describe, expect, it } from "vitest";
import { CellIndex } from "../../src/lod/cell-index.ts";

function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** The last row with a finite value in each cell, by a scan. */
function lastRows(x: Int32Array, y: Int32Array, values: Float64Array, columns: number) {
  const last = new Map<number, number>();
  for (let row = 0; row < x.length; row++) {
    if (Number.isFinite(values[row]!) && x[row]! >= 0 && y[row]! >= 0)
      last.set(y[row]! * columns + x[row]!, row);
  }
  return last;
}

describe("CellIndex", () => {
  it("finds the last row with a value in a cell, for rows in any order", () => {
    const next = seeded(5);
    const count = 3000;
    const [columns, rows] = [37, 23];
    const x = Int32Array.from({ length: count }, () => Math.floor(next() * columns));
    const y = Int32Array.from({ length: count }, () => Math.floor(next() * rows));
    const values = Float64Array.from({ length: count }, (_, i) => (i % 7 === 3 ? Number.NaN : i));
    // Rows without a band, as for missing positions.
    x[10] = -1;
    y[11] = -1;
    const index = new CellIndex(x, y, values, columns, rows);
    const expected = lastRows(x, y, values, columns);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < columns; c++)
        expect(index.find(c, r)).toBe(expected.get(r * columns + c) ?? -1);
    }
  });

  it("indexes rows already in cell order without sorting them", () => {
    const [columns, rows] = [5, 4];
    const x = Int32Array.from({ length: columns * rows }, (_, i) => i % columns);
    const y = Int32Array.from({ length: columns * rows }, (_, i) => Math.floor(i / columns));
    const values = Float64Array.from(x, (_, i) => (i === 7 ? Number.NaN : i));
    const index = new CellIndex(x, y, values, columns, rows);
    expect(Array.from(index.order!)).toEqual(
      Array.from({ length: columns * rows }, (_, i) => i).filter((i) => i !== 7),
    );
    expect(index.find(2, 1)).toBe(-1);
    expect(index.find(3, 1)).toBe(8);
    expect(index.find(4, 3)).toBe(19);
    // With every row in the grid, in cell order, the table is the index.
    const complete = new CellIndex(x, y, Float64Array.from(x), columns, rows);
    expect(complete.order).toBeUndefined();
    for (let row = 0; row < x.length; row++) expect(complete.find(x[row]!, y[row]!)).toBe(row);
    expect(complete.find(5, 0)).toBe(-1);
  });

  it("takes memory for its rows, not for its cells", () => {
    const next = seeded(9);
    // 10^12 cells, 2,000 rows.
    const side = 1_000_000;
    const count = 2000;
    const x = Int32Array.from({ length: count }, () => Math.floor(next() * side));
    const y = Int32Array.from({ length: count }, () => Math.floor(next() * side));
    const values = Float64Array.from({ length: count }, (_, i) => i);
    const index = new CellIndex(x, y, values, side, side);
    expect(index.order!.byteLength).toBe(count * 4);
    for (const row of [0, 999, 1999]) expect(index.find(x[row]!, y[row]!)).toBe(row);
    expect(index.find(side - 1, side - 1)).toBe(-1);
  });

  it("finds nothing in an empty grid or outside it", () => {
    const none = new CellIndex(new Int32Array(0), new Int32Array(0), new Float64Array(0), 3, 3);
    expect(none.find(0, 0)).toBe(-1);
    const one = new CellIndex(Int32Array.of(2), Int32Array.of(1), Float64Array.of(5), 3, 2);
    expect(one.find(2, 1)).toBe(0);
    expect([one.find(1, 1), one.find(2, 0), one.find(0, 2)]).toEqual([-1, -1, -1]);
  });
});
