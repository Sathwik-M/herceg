/** Side of the grid cells boxes are filed under, in pixels: about a short label. */
const CELL = 64;
/** Boxes over more cells than this, or outside the grid, are checked one by one. */
const MAX_CELLS = 64;
/** Cell numbers on either side of zero that pack into a key: far more than any chart. */
const REACH = 0x80000;

/**
 * The boxes of labels placed so far, filed by grid cell, to tell quickly
 * whether a new label would cover one of them.
 */
export class LabelBoxes {
  readonly #boxes: number[] = [];
  readonly #cells = new Map<number, number[]>();
  /** Boxes too large for the grid, or beyond it. */
  readonly #loose: number[] = [];

  /**
   * Whether the box from (x0, y0) to (x1, y1) overlaps a placed one, other
   * than the one added as number `except`.
   */
  hits(x0: number, y0: number, x1: number, y1: number, except = -1): boolean {
    const meets = (index: number) => {
      const b = this.#boxes;
      const at = index * 4;
      return (
        index !== except && x0 < b[at + 2]! && x1 > b[at]! && y0 < b[at + 3]! && y1 > b[at + 1]!
      );
    };
    if (this.#loose.some(meets)) return true;
    const cells = cellsOf(x0, y0, x1, y1);
    if (!cells) {
      for (let index = 0; index < this.#boxes.length / 4; index++) if (meets(index)) return true;
      return false;
    }
    for (const cell of cells) if (this.#cells.get(cell)?.some(meets)) return true;
    return false;
  }

  /** Places a box; returns its number. */
  add(x0: number, y0: number, x1: number, y1: number): number {
    const index = this.#boxes.length / 4;
    this.#boxes.push(x0, y0, x1, y1);
    const cells = cellsOf(x0, y0, x1, y1);
    if (!cells) this.#loose.push(index);
    else {
      for (const cell of cells) {
        const list = this.#cells.get(cell);
        if (list) list.push(index);
        else this.#cells.set(cell, [index]);
      }
    }
    return index;
  }
}

/** The grid cells a box touches, or undefined when there are too many or it is off the grid. */
function cellsOf(x0: number, y0: number, x1: number, y1: number): number[] | undefined {
  const c0 = Math.floor(x0 / CELL);
  const c1 = Math.floor(x1 / CELL);
  const r0 = Math.floor(y0 / CELL);
  const r1 = Math.floor(y1 / CELL);
  const onGrid = (n: number) => n > -REACH && n < REACH;
  if (!(onGrid(c0) && onGrid(c1) && onGrid(r0) && onGrid(r1))) return undefined;
  if ((c1 - c0 + 1) * (r1 - r0 + 1) > MAX_CELLS) return undefined;
  const cells: number[] = [];
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) cells.push((r + REACH) * 2 * REACH + (c + REACH));
  }
  return cells;
}
