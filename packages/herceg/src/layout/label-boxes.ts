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
    const b = this.#boxes;
    return this.#some(
      x0,
      y0,
      x1,
      y1,
      (at) =>
        at !== except * 4 && x0 < b[at + 2]! && x1 > b[at]! && y0 < b[at + 3]! && y1 > b[at + 1]!,
    );
  }

  /**
   * Whether the segment from (x0, y0) to (x1, y1) passes through a placed
   * box, other than the one added as number `except`.
   */
  crosses(x0: number, y0: number, x1: number, y1: number, except = -1): boolean {
    const b = this.#boxes;
    return this.#some(
      Math.min(x0, x1),
      Math.min(y0, y1),
      Math.max(x0, x1),
      Math.max(y0, y1),
      (at) =>
        at !== except * 4 &&
        segmentMeetsBox(x0, y0, x1, y1, b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!),
    );
  }

  /** Whether `meets` holds for a placed box that may overlap the area given, by its offset in `#boxes`. */
  #some(x0: number, y0: number, x1: number, y1: number, meets: (at: number) => boolean): boolean {
    for (const index of this.#loose) if (meets(index * 4)) return true;
    const range = cellRange(x0, y0, x1, y1);
    if (!range) {
      for (let at = 0; at < this.#boxes.length; at += 4) if (meets(at)) return true;
      return false;
    }
    // Queries run thousands of times a scene, so cells are walked, not listed.
    const [c0, r0, c1, r1] = range;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const list = this.#cells.get(cellKey(r, c));
        if (list) for (const index of list) if (meets(index * 4)) return true;
      }
    }
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
  const range = cellRange(x0, y0, x1, y1);
  if (!range) return undefined;
  const [c0, r0, c1, r1] = range;
  const cells: number[] = [];
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) cells.push(cellKey(r, c));
  return cells;
}

/** The first and last columns and rows of cells a box touches, as in `cellsOf`. */
function cellRange(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): readonly [number, number, number, number] | undefined {
  const c0 = Math.floor(x0 / CELL);
  const c1 = Math.floor(x1 / CELL);
  const r0 = Math.floor(y0 / CELL);
  const r1 = Math.floor(y1 / CELL);
  const onGrid = (n: number) => n > -REACH && n < REACH;
  if (!(onGrid(c0) && onGrid(c1) && onGrid(r0) && onGrid(r1))) return undefined;
  if ((c1 - c0 + 1) * (r1 - r0 + 1) > MAX_CELLS) return undefined;
  return [c0, r0, c1, r1];
}

function cellKey(row: number, column: number): number {
  return (row + REACH) * 2 * REACH + (column + REACH);
}

/**
 * Whether the segment from (x0, y0) to (x1, y1) passes through the inside of
 * the box from (bx0, by0) to (bx1, by1): the part of the segment the box's
 * sides clip it to is not empty (Liang-Barsky).
 */
export function segmentMeetsBox(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  bx0: number,
  by0: number,
  bx1: number,
  by1: number,
): boolean {
  let enter = 0;
  let leave = 1;
  // Keeps the part of the segment where p * t < q.
  const clip = (p: number, q: number) => {
    if (p === 0) return q > 0;
    const t = q / p;
    if (p < 0) enter = Math.max(enter, t);
    else leave = Math.min(leave, t);
    return enter < leave;
  };
  const dx = x1 - x0;
  const dy = y1 - y0;
  return clip(-dx, x0 - bx0) && clip(dx, bx1 - x0) && clip(-dy, y0 - by0) && clip(dy, by1 - y0);
}

/**
 * Whether the segments from (ax, ay) to (bx, by) and from (cx, cy) to
 * (dx, dy) cross or touch, collinear overlaps included.
 */
export function segmentsMeet(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): boolean {
  // Which side of the line through p and q the point r is on.
  const side = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) =>
    Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
  // Whether r, on the line through p and q, lies between them.
  const within = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) =>
    Math.min(px, qx) <= rx &&
    rx <= Math.max(px, qx) &&
    Math.min(py, qy) <= ry &&
    ry <= Math.max(py, qy);
  const d1 = side(cx, cy, dx, dy, ax, ay);
  const d2 = side(cx, cy, dx, dy, bx, by);
  const d3 = side(ax, ay, bx, by, cx, cy);
  const d4 = side(ax, ay, bx, by, dx, dy);
  if (d1 * d2 < 0 && d3 * d4 < 0) return true;
  return (
    (d1 === 0 && within(cx, cy, dx, dy, ax, ay)) ||
    (d2 === 0 && within(cx, cy, dx, dy, bx, by)) ||
    (d3 === 0 && within(ax, ay, bx, by, cx, cy)) ||
    (d4 === 0 && within(ax, ay, bx, by, dx, dy))
  );
}
