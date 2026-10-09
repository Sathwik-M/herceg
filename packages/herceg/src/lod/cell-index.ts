import type { NumericArray } from "../data/column.ts";

/**
 * The rows of a grid of cells (a heatmap's table) sorted by cell, so the row
 * in a cell is found by binary search. It holds at most one entry per row
 * with a value rather than one per cell: a sparse grid of millions of cells
 * costs what its rows do. Two stable counting sorts (by column, then by row)
 * build it in linear time, and rows sharing a cell keep their table order,
 * so the last of them is the one found, as it is the one drawn. A table
 * whose rows are all in the grid and already in cell order, as dense grids
 * written row by row are, is its own index.
 */
export class CellIndex {
  /** Each table row's cell column and cell row, as given. */
  readonly x: NumericArray;
  readonly y: NumericArray;
  readonly columns: number;
  readonly rows: number;
  /**
   * Table rows with a value in the grid, ordered by cell row, then cell
   * column; undefined when that is every row, in table order.
   */
  readonly order: Uint32Array | undefined;

  /**
   * Indexes the table rows whose cell column `x[row]` and cell row `y[row]`
   * lie in a grid of `columns` x `rows` and whose `values[row]` is finite.
   * Cell indices are whole numbers (band indices, -1 for none); fractions
   * would corrupt the counting sorts.
   */
  constructor(
    x: NumericArray,
    y: NumericArray,
    values: NumericArray,
    columns: number,
    rows: number,
  ) {
    this.columns = columns;
    this.rows = rows;
    this.x = x;
    this.y = y;
    const inGrid = (row: number) => {
      const c = x[row]!;
      const r = y[row]!;
      return c >= 0 && r >= 0 && c < columns && r < rows && Number.isFinite(values[row]!);
    };
    // How many rows are in the grid, and whether they already come in cell order.
    let count = 0;
    let sorted = true;
    let lastC = -1;
    let lastR = -1;
    for (let row = 0; row < x.length; row++) {
      if (!inGrid(row)) continue;
      const c = x[row]!;
      const r = y[row]!;
      if (r < lastR || (r === lastR && c < lastC)) sorted = false;
      lastC = c;
      lastR = r;
      count++;
    }
    if (sorted && count === x.length) {
      this.order = undefined;
      return;
    }
    const rowsFound = new Uint32Array(count);
    for (let row = 0, k = 0; row < x.length; row++) if (inGrid(row)) rowsFound[k++] = row;
    if (sorted) {
      this.order = rowsFound;
      return;
    }
    const columnStarts = new Uint32Array(columns + 1);
    const rowStarts = new Uint32Array(rows + 1);
    for (let k = 0; k < count; k++) {
      const row = rowsFound[k]!;
      columnStarts[x[row]! + 1]!++;
      rowStarts[y[row]! + 1]!++;
    }
    for (let c = 0; c < columns; c++) columnStarts[c + 1]! += columnStarts[c]!;
    for (let r = 0; r < rows; r++) rowStarts[r + 1]! += rowStarts[r]!;
    const byColumn = new Uint32Array(count);
    for (let k = 0; k < count; k++) {
      const row = rowsFound[k]!;
      byColumn[columnStarts[x[row]!]!++] = row;
    }
    // Every row found is in byColumn now, so their array takes the result.
    for (let k = 0; k < count; k++) {
      const row = byColumn[k]!;
      rowsFound[rowStarts[y[row]!]!++] = row;
    }
    this.order = rowsFound;
  }

  /** The last table row with a value in the cell at column `c`, row `r`; -1 for none. */
  find(c: number, r: number): number {
    const { x, y, order } = this;
    // The first entry past the cell, comparing by row, then column.
    let lo = 0;
    let hi = order ? order.length : x.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const row = order ? order[mid]! : mid;
      const at = y[row]!;
      if (at < r || (at === r && x[row]! <= c)) lo = mid + 1;
      else hi = mid;
    }
    if (lo === 0) return -1;
    const row = order ? order[lo - 1]! : lo - 1;
    return x[row] === c && y[row] === r ? row : -1;
  }
}
