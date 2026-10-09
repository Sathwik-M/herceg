import { describe, expect, it } from "vitest";
import { CellIndex } from "../../src/lod/cell-index.ts";

function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** The last position with a finite value in each cell, by a scan of `rows` (every row without). */
function lastPositions(
  x: Int32Array,
  y: Int32Array,
  values: Float64Array,
  columns: number,
  rows?: Uint32Array,
) {
  const last = new Map<number, number>();
  const length = rows ? rows.length : x.length;
  for (let k = 0; k < length; k++) {
    const row = rows ? rows[k]! : k;
    if (Number.isFinite(values[row]!) && x[row]! >= 0 && y[row]! >= 0)
      last.set(y[row]! * columns + x[row]!, k);
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
    const expected = lastPositions(x, y, values, columns);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < columns; c++)
        expect(index.find(c, r)).toBe(expected.get(r * columns + c) ?? -1);
    }
  });

  it("indexes a subset of rows by position, as a facet panel's are", () => {
    const next = seeded(7);
    const count = 2000;
    const [columns, rows] = [19, 11];
    const x = Int32Array.from({ length: count }, () => Math.floor(next() * columns));
    const y = Int32Array.from({ length: count }, () => Math.floor(next() * rows));
    const values = Float64Array.from({ length: count }, (_, i) => (i % 5 === 1 ? Number.NaN : i));
    // Every third row, in table order: cells shared with other rows find this subset's own.
    const subset = Uint32Array.from({ length: count / 3 }, (_, k) => k * 3 + 2);
    const index = new CellIndex(x, y, values, columns, rows, subset);
    const expected = lastPositions(x, y, values, columns, subset);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < columns; c++)
        expect(index.find(c, r)).toBe(expected.get(r * columns + c) ?? -1);
    }
    // Cells are visited in order, each at its last position.
    const visited: number[] = [];
    index.forEachCell((c, r, k) => {
      expect(expected.get(r * columns + c)).toBe(k);
      visited.push(r * columns + c);
    });
    expect(visited).toEqual([...expected.keys()].sort((a, b) => a - b));
    expect(index.order!.length).toBeLessThanOrEqual(subset.length);
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
    // A subset in cell order is its own index too, by position.
    const second = Uint32Array.of(5, 6, 9);
    const part = new CellIndex(x, y, Float64Array.from(x), columns, rows, second);
    expect(part.order).toBeUndefined();
    expect([part.find(0, 1), part.find(1, 1), part.find(4, 1), part.find(0, 0)]).toEqual([
      0, 1, 2, -1,
    ]);
  });

  it("sorts a few rows among many columns and rows by comparison, in the same order", () => {
    const next = seeded(3);
    const count = 500;
    const [columns, rows] = [40, 30];
    const x = Int32Array.from({ length: count }, () => Math.floor(next() * columns));
    const y = Int32Array.from({ length: count }, () => Math.floor(next() * rows));
    const values = Float64Array.from({ length: count }, (_, i) => (i % 9 === 4 ? Number.NaN : i));
    const dense = new CellIndex(x, y, values, columns, rows);
    // The same cells spread over a grid of a million columns and rows.
    const [wideX, wideY] = [x.map((c) => c * 25_000), y.map((r) => r * 33_333)];
    const sparse = new CellIndex(wideX, wideY, values, 1_000_000, 1_000_000);
    expect(Array.from(sparse.order!)).toEqual(Array.from(dense.order!));
    for (let k = 0; k < count; k++)
      expect(sparse.find(wideX[k]!, wideY[k]!)).toBe(dense.find(x[k]!, y[k]!));
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
    const empty = new CellIndex(
      Int32Array.of(2),
      Int32Array.of(1),
      Float64Array.of(5),
      3,
      2,
      new Uint32Array(0),
    );
    expect(empty.find(2, 1)).toBe(-1);
  });
});
