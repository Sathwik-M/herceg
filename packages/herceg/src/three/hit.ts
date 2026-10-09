// Finding what the pointer is on in a 3D chart a GPU painter drew, from the
// layers' data rather than from faces: the pointer's ray through the box and
// a surface's grid of cells, and the points and segments near it on screen.

import type { Rect } from "../scene/scene.ts";

/**
 * The part of the ray `origin` + t * `direction` inside the box (each
 * normalized coordinate from -1 to 1), as [t0, t1]; undefined when it misses.
 */
export function rayInBox(
  origin: readonly number[],
  direction: readonly number[],
): [number, number] | undefined {
  let t0 = Number.NEGATIVE_INFINITY;
  let t1 = Number.POSITIVE_INFINITY;
  for (let k = 0; k < 3; k++) {
    const o = origin[k]!;
    const d = direction[k]!;
    if (d === 0) {
      if (Math.abs(o) > 1) return undefined;
      continue;
    }
    const a = (-1 - o) / d;
    const b = (1 - o) / d;
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
  }
  return t0 <= t1 ? [t0, t1] : undefined;
}

/**
 * The cells of a grid (columns between positions `u`, rows between `v`,
 * each monotone where finite) the ray crosses from t0 to t1, nearest first:
 * `visit(i, j)` is called for each until it returns true.
 */
export function walkGrid(
  u: Float64Array,
  v: Float64Array,
  origin: readonly number[],
  direction: readonly number[],
  t0: number,
  t1: number,
  visit: (i: number, j: number) => boolean,
): void {
  // Where the ray crosses a column's or a row's line, between t0 and t1.
  const crossings = [t0, t1];
  for (const [positions, k] of [
    [u, 0],
    [v, 1],
  ] as const) {
    const o = origin[k]!;
    const d = direction[k]!;
    if (d === 0) continue;
    for (let i = 0; i < positions.length; i++) {
      const t = (positions[i]! - o) / d;
      if (t > t0 && t < t1) crossings.push(t);
    }
  }
  crossings.sort((a, b) => a - b);
  for (let c = 0; c + 1 < crossings.length; c++) {
    const a = crossings[c]!;
    const b = crossings[c + 1]!;
    if (!(b > a)) continue;
    const t = (a + b) / 2;
    const i = cellAt(u, origin[0]! + t * direction[0]!);
    const j = cellAt(v, origin[1]! + t * direction[1]!);
    if (i >= 0 && j >= 0 && visit(i, j)) return;
  }
}

/** Whether the finite positions are strictly monotone, so cells between neighbors never overlap. */
export function monotone(positions: Float64Array): boolean {
  let sign = 0;
  let last = Number.NaN;
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i]!;
    if (!Number.isFinite(p)) {
      // Positions without a place (nonpositive values on log axes) come first.
      if (!Number.isNaN(last)) return false;
      continue;
    }
    if (!Number.isNaN(last)) {
      const step = Math.sign(p - last);
      if (step === 0 || (sign !== 0 && step !== sign)) return false;
      sign = step;
    }
    last = p;
  }
  return true;
}

/** The cell between finite positions `p[i]` and `p[i + 1]` holding `x`, or -1. */
function cellAt(p: Float64Array, x: number): number {
  let first = 0;
  const last = p.length - 1;
  while (first <= last && !Number.isFinite(p[first]!)) first++;
  if (last - first < 1 || !Number.isFinite(x)) return -1;
  const ascending = p[last]! >= p[first]!;
  const at = (i: number) => (ascending ? p[i]! : -p[i]!);
  const value = ascending ? x : -x;
  if (!(value >= at(first) && value <= at(last))) return -1;
  let lo = first;
  let hi = last - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (at(mid) <= value) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Grid cells, in pixels a side: at most, and at least where items are dense. */
const CELL = 24;
const SMALLEST_CELL = 6;

/** How a ScreenGrid's items are filed: by boxes they cover, or along segments. */
export interface Filer {
  box(item: number, x0: number, y0: number, x1: number, y1: number): void;
  /** In every cell within `reach` of the segment from (ax, ay) to (bx, by), once. */
  segment(item: number, ax: number, ay: number, bx: number, by: number, reach: number): void;
}

/** Pieces a segment is filed in at most, however long it is on screen. */
const PIECES = 512;

/**
 * Items on screen filed in a uniform grid by the boxes they cover (a point
 * by itself, a segment cell by cell along it), so the pointer finds those
 * near it without looking at every one.
 */
export class ScreenGrid {
  readonly #x0: number;
  readonly #y0: number;
  readonly #size: number;
  readonly #columns: number;
  readonly #rows: number;
  /** Items by cell: those of cell c from `#starts[c]` to `#starts[c + 1]`. */
  readonly #starts: Uint32Array;
  readonly #items: Uint32Array;

  /**
   * Files `count` items in `bounds`: `each` files every item through the
   * filer it is given, and is called twice (counting, then filing).
   */
  constructor(bounds: Rect, count: number, each: (filer: Filer) => void) {
    this.#x0 = bounds.x;
    this.#y0 = bounds.y;
    const area = Math.max(1, bounds.width * bounds.height);
    this.#size = Math.min(
      CELL,
      Math.max(SMALLEST_CELL, Math.ceil(2 * Math.sqrt(area / Math.max(1, count)))),
    );
    const columns = Math.max(1, Math.ceil(bounds.width / this.#size));
    const rows = Math.max(1, Math.ceil(bounds.height / this.#size));
    this.#columns = columns;
    this.#rows = rows;
    const counts = new Uint32Array(columns * rows + 1);
    each(this.#filer((_, cell) => counts[cell + 1]!++));
    for (let c = 0; c < columns * rows; c++) counts[c + 1]! += counts[c]!;
    const items = new Uint32Array(counts[columns * rows]!);
    const next = counts.slice(0, columns * rows);
    each(this.#filer((item, cell) => (items[next[cell]!++] = item)));
    this.#starts = counts;
    this.#items = items;
  }

  /** A filer handing `file` each item and cell it is filed in. */
  #filer(file: (item: number, cell: number) => void): Filer {
    const columns = this.#columns;
    const box = (item: number, x0: number, y0: number, x1: number, y1: number) => {
      const [c0, r0, c1, r1] = this.#cells(x0, y0, x1, y1);
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) file(item, r * columns + c);
    };
    return {
      box,
      segment: (item, ax, ay, bx, by, reach) => {
        const length = Math.hypot(bx - ax, by - ay);
        if (!Number.isFinite(length)) return;
        // Pieces a cell long; each fills the cells its box covers that the last one did not.
        const steps = Math.min(PIECES, Math.max(1, Math.ceil(length / this.#size)));
        let last = [1, 1, 0, 0];
        for (let step = 0; step < steps; step++) {
          const [x0, y0] = [ax + ((bx - ax) * step) / steps, ay + ((by - ay) * step) / steps];
          const [x1, y1] = [
            ax + ((bx - ax) * (step + 1)) / steps,
            ay + ((by - ay) * (step + 1)) / steps,
          ];
          const cells = this.#cells(
            Math.min(x0, x1) - reach,
            Math.min(y0, y1) - reach,
            Math.max(x0, x1) + reach,
            Math.max(y0, y1) + reach,
          );
          const [c0, r0, c1, r1] = cells;
          for (let r = r0; r <= r1; r++)
            for (let c = c0; c <= c1; c++)
              if (!(c >= last[0]! && c <= last[2]! && r >= last[1]! && r <= last[3]!))
                file(item, r * columns + c);
          last = cells;
        }
      },
    };
  }

  #cell(v: number, origin: number, n: number): number {
    return Math.min(n - 1, Math.max(0, Math.floor((v - origin) / this.#size)));
  }

  #cells(x0: number, y0: number, x1: number, y1: number): [number, number, number, number] {
    return [
      this.#cell(x0, this.#x0, this.#columns),
      this.#cell(y0, this.#y0, this.#rows),
      this.#cell(x1, this.#x0, this.#columns),
      this.#cell(y1, this.#y0, this.#rows),
    ];
  }

  /** Calls `visit` with the items filed within `reach` of (x, y), some more than once. */
  near(x: number, y: number, reach: number, visit: (item: number) => void): void {
    const [c0, r0, c1, r1] = this.#cells(x - reach, y - reach, x + reach, y + reach);
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        const cell = r * this.#columns + c;
        for (let k = this.#starts[cell]!; k < this.#starts[cell + 1]!; k++) visit(this.#items[k]!);
      }
  }
}
