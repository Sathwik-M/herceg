import type { NumericArray } from "../data/column.ts";

/**
 * The positions of a series of cells (a heatmap's rows, or a facet panel's
 * share of them) sorted by cell, so the position in a cell is found by
 * binary search. It holds at most one entry per position with a value
 * rather than one per cell: a sparse grid of millions of cells costs what
 * its rows do. Two stable counting sorts (by column, then by row) build it
 * in linear time, or a comparison sort for grids of far more columns and
 * rows than positions, and positions sharing a cell keep their order, so
 * the last of them is the one found, as it is the one drawn. A series whose
 * positions are all in the grid and already in cell order, as dense grids
 * written row by row are, is its own index.
 */
export class CellIndex {
  /** Each table row's cell column and cell row, as given. */
  readonly x: NumericArray;
  readonly y: NumericArray;
  readonly values: NumericArray;
  /** The table rows of the series' positions; undefined when position k is row k. */
  readonly rows: Uint32Array | undefined;
  readonly columns: number;
  readonly lines: number;
  /**
   * Positions with a value in the grid, ordered by cell row, then cell
   * column; undefined when that is every position, in order.
   */
  readonly order: Uint32Array | undefined;

  /**
   * Indexes the positions of a series over `rows` (every table row without
   * them) whose cell column `x[row]` and cell row `y[row]` lie in a grid of
   * `columns` x `lines` and whose `values[row]` is finite. Cell indices are
   * whole numbers (band indices, -1 for none); fractions would corrupt the
   * counting sorts.
   */
  constructor(
    x: NumericArray,
    y: NumericArray,
    values: NumericArray,
    columns: number,
    lines: number,
    rows?: Uint32Array,
  ) {
    this.x = x;
    this.y = y;
    this.values = values;
    this.columns = columns;
    this.lines = lines;
    this.rows = rows;
    // Cells and values by position: the columns themselves, or for a subset
    // of rows gathered from them (16 bytes per position while building), so
    // the loops below, over every row of large grids, read them directly.
    const cx = rows ? gather(x, rows, Int32Array) : x;
    const cy = rows ? gather(y, rows, Int32Array) : y;
    const cv = rows ? gather(values, rows, Float64Array) : values;
    const length = cx.length;
    // How many positions are in the grid, and whether they already come in
    // cell order. Both loops write the test out: a closure for it costs
    // large grids about a tenth more time.
    let count = 0;
    let sorted = true;
    let lastC = -1;
    let lastR = -1;
    for (let k = 0; k < length; k++) {
      const c = cx[k]!;
      const r = cy[k]!;
      if (!(c >= 0 && r >= 0 && c < columns && r < lines && Number.isFinite(cv[k]!))) continue;
      if (r < lastR || (r === lastR && c < lastC)) sorted = false;
      lastC = c;
      lastR = r;
      count++;
    }
    if (sorted && count === length) {
      this.order = undefined;
      return;
    }
    const found = new Uint32Array(count);
    for (let k = 0, i = 0; k < length; k++) {
      const c = cx[k]!;
      const r = cy[k]!;
      if (c >= 0 && r >= 0 && c < columns && r < lines && Number.isFinite(cv[k]!)) found[i++] = k;
    }
    if (!sorted) sortByCell(found, cx, cy, columns, lines);
    this.order = found;
  }

  /** How many positions the index holds. */
  get length(): number {
    return this.order ? this.order.length : this.rows ? this.rows.length : this.x.length;
  }

  /**
   * Calls `visit` with each cell's column, row, and the position drawn in
   * it (the last with a value), in cell order: by row, then column.
   */
  forEachCell(visit: (c: number, r: number, position: number) => void): void {
    this.forEachRun((c, r, _, to) => visit(c, r, this.positionAt(to - 1)));
  }

  /**
   * Calls `visit` with each cell's column and row and the entries
   * [from, to) of its positions (read with `positionAt`), in cell order:
   * a cell's positions are adjacent, in their own order.
   */
  forEachRun(visit: (c: number, r: number, from: number, to: number) => void): void {
    const { x, y, order, rows } = this;
    const length = this.length;
    // Rows are read inline: these loops run over every row of large grids.
    let k = order ? order[0]! : 0;
    let row = rows ? rows[k]! : k;
    for (let from = 0; from < length; ) {
      const c = x[row]!;
      const r = y[row]!;
      let to = from + 1;
      for (; to < length; to++) {
        k = order ? order[to]! : to;
        row = rows ? rows[k]! : k;
        if (x[row] !== c || y[row] !== r) break;
      }
      visit(c, r, from, to);
      from = to;
    }
  }

  /** The last position with a value in the cell at column `c`, row `r`; -1 for none. */
  find(c: number, r: number): number {
    const lo = this.#past(c, r);
    if (lo === 0) return -1;
    const k = this.positionAt(lo - 1);
    const row = this.rowOf(k);
    return this.x[row] === c && this.y[row] === r ? k : -1;
  }

  /**
   * The last position with a value in the nearest cell of row `r` past
   * column `c` (before it, unless `forward`), or -1 when the row has none
   * there: a binary search, however long the row.
   */
  beside(c: number, r: number, forward: boolean): number {
    const i = forward ? this.#past(c, r) : this.#past(c - 1, r) - 1;
    if (i < 0 || i >= this.length) return -1;
    const k = this.positionAt(i);
    const row = this.rowOf(k);
    if (this.y[row] !== r) return -1;
    // Before the cell, the entry is its cell's last; past it, its cell's first.
    return forward ? this.find(this.x[row]!, r) : k;
  }

  /**
   * The last position with a value in the first or last cell of the first
   * or last row, or -1 for an empty index.
   */
  corner(lastRow: boolean, lastColumn: boolean): number {
    const n = this.length;
    if (n === 0) return -1;
    const r = this.y[this.rowOf(this.positionAt(lastRow ? n - 1 : 0))]!;
    if (lastColumn) return this.positionAt(this.#past(Number.POSITIVE_INFINITY, r) - 1);
    const first = this.rowOf(this.positionAt(this.#past(Number.NEGATIVE_INFINITY, r)));
    return this.find(this.x[first]!, r);
  }

  /** The position of the entry at `i` in cell order. */
  positionAt(i: number): number {
    return this.order ? this.order[i]! : i;
  }

  /** The table row of position `k`. */
  rowOf(k: number): number {
    return this.rows ? this.rows[k]! : k;
  }

  /** How many entries come at or before cell (c, r), comparing by row, then column. */
  #past(c: number, r: number): number {
    const { x, y } = this;
    let lo = 0;
    let hi = this.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const row = this.rowOf(this.positionAt(mid));
      const at = y[row]!;
      if (at < r || (at === r && x[row]! <= c)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}

/**
 * Sorts `positions` by cell row, then column (`y[k]`, `x[k]` of position
 * k, in a grid of `columns` x `lines`), in place and stably: with two
 * counting sorts, whose counters take a grid's columns and rows, unless
 * they outnumber the positions several times over (a facet panel's few
 * rows among many categories), when a comparison sort takes no more.
 */
function sortByCell(
  positions: Uint32Array,
  x: NumericArray,
  y: NumericArray,
  columns: number,
  lines: number,
): void {
  const count = positions.length;
  if (columns + lines > SPARSE * count + 1024) {
    // Positions are distinct, so this order is total: ties keep theirs.
    positions.sort((a, b) => y[a]! - y[b]! || x[a]! - x[b]! || a - b);
    return;
  }
  const columnStarts = new Uint32Array(columns + 1);
  const rowStarts = new Uint32Array(lines + 1);
  for (let i = 0; i < count; i++) {
    const k = positions[i]!;
    columnStarts[x[k]! + 1]!++;
    rowStarts[y[k]! + 1]!++;
  }
  for (let c = 0; c < columns; c++) columnStarts[c + 1]! += columnStarts[c]!;
  for (let r = 0; r < lines; r++) rowStarts[r + 1]! += rowStarts[r]!;
  const byColumn = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const k = positions[i]!;
    byColumn[columnStarts[x[k]!]!++] = k;
  }
  // Every position is in byColumn now, so their array takes the result.
  for (let i = 0; i < count; i++) {
    const k = byColumn[i]!;
    positions[rowStarts[y[k]!]!++] = k;
  }
}

/** How many times a grid's columns and rows may outnumber its positions before they are sorted by comparison. */
const SPARSE = 4;

/** `column`'s values at `rows`, by position. */
function gather<T extends Int32Array | Float64Array>(
  column: NumericArray,
  rows: Uint32Array,
  Kind: new (length: number) => T,
): T {
  const out = new Kind(rows.length);
  for (let k = 0; k < rows.length; k++) out[k] = column[rows[k]!]!;
  return out;
}
