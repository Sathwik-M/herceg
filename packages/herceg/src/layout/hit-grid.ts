// Pixel candidates for network picking. Circles use their expanded boxes;
// links follow their routes across cell rows, so a diagonal does not fill its
// whole bounding rectangle. Exact distances and drawing order belong to
// the caller. Packed cell lists avoid an object per entry.

import type { Rect } from "../scene/scene.ts";

const CELL = 32;

export class HitGrid {
  readonly #bounds: Rect;
  readonly #columns: number;
  readonly #rows: number;
  readonly #starts: Uint32Array;
  readonly #items: Uint32Array;
  /** Reused in the two construction passes to insert an item only once per cell. */
  readonly #seen: Uint32Array;

  constructor(
    bounds: Rect,
    visit: (grid: HitGrid, add: (cell: number, item: number) => void) => void,
  ) {
    this.#bounds = bounds;
    this.#columns = Math.max(1, Math.ceil(bounds.width / CELL));
    this.#rows = Math.max(1, Math.ceil(bounds.height / CELL));
    const cells = this.#columns * this.#rows;
    this.#seen = new Uint32Array(cells);
    this.#starts = new Uint32Array(cells + 1);
    visit(this, (cell) => this.#starts[cell + 1]!++);
    for (let cell = 0; cell < cells; cell++) this.#starts[cell + 1]! += this.#starts[cell]!;
    const next = this.#starts.slice(0, cells);
    this.#items = new Uint32Array(this.#starts[cells]!);
    this.#seen.fill(0);
    visit(this, (cell, item) => {
      this.#items[next[cell]!++] = item;
    });
  }

  box(
    item: number,
    left: number,
    top: number,
    right: number,
    bottom: number,
    add: (cell: number, item: number) => void,
  ): void {
    const b = this.#bounds;
    if (right < b.x || left > b.x + b.width || bottom < b.y || top > b.y + b.height) return;
    const column = (x: number) =>
      Math.max(0, Math.min(this.#columns - 1, Math.floor((x - b.x) / CELL)));
    const row = (y: number) => Math.max(0, Math.min(this.#rows - 1, Math.floor((y - b.y) / CELL)));
    const c0 = column(left),
      c1 = column(right),
      r0 = row(top),
      r1 = row(bottom);
    for (let r = r0; r <= r1; r++) this.#insertRow(item, r, c0, c1, add);
  }

  #insertRow(
    item: number,
    row: number,
    first: number,
    last: number,
    add: (cell: number, item: number) => void,
  ): void {
    for (let column = first; column <= last; column++) {
      const cell = row * this.#columns + column;
      if (this.#seen[cell] === item + 1) continue;
      this.#seen[cell] = item + 1;
      add(cell, item);
    }
  }

  /** Index a segment's reach, clipping before row traversal to bound work when zoomed far in. */
  segment(
    item: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
    reach: number,
    add: (cell: number, item: number) => void,
  ): void {
    const b = this.#bounds;
    const dx = bx - ax,
      dy = by - ay;
    let start = 0,
      end = 1;
    for (const [p, q] of [
      [-dx, ax - b.x + reach],
      [dx, b.x + b.width + reach - ax],
      [-dy, ay - b.y + reach],
      [dy, b.y + b.height + reach - ay],
    ]) {
      if (p === 0) {
        if (q! < 0) return;
        continue;
      }
      const t = q! / p!;
      if (p! < 0) start = Math.max(start, t);
      else end = Math.min(end, t);
      if (start > end) return;
    }
    // In each crossed row, only the columns reached by the segment in
    // that row's expanded band can contain a hit. This also handles long
    // horizontal links without repeated subdivision into overlapping boxes.
    const y0 = ay + dy * start,
      y1 = ay + dy * end;
    const first = Math.max(0, Math.floor((Math.min(y0, y1) - reach - b.y) / CELL));
    const last = Math.min(this.#rows - 1, Math.floor((Math.max(y0, y1) + reach - b.y) / CELL));
    for (let row = first; row <= last; row++) {
      const top = b.y + row * CELL;
      let lo = start,
        hi = end;
      if (dy !== 0) {
        const a = (top - reach - ay) / dy;
        const z = (top + CELL + reach - ay) / dy;
        lo = Math.max(lo, Math.min(a, z));
        hi = Math.min(hi, Math.max(a, z));
      }
      if (lo > hi) continue;
      const x0 = ax + dx * lo,
        x1 = ax + dx * hi;
      const left = Math.min(x0, x1) - reach,
        right = Math.max(x0, x1) + reach;
      if (right < b.x || left > b.x + b.width) continue;
      const firstColumn = Math.max(0, Math.min(this.#columns - 1, Math.floor((left - b.x) / CELL)));
      const lastColumn = Math.max(0, Math.min(this.#columns - 1, Math.floor((right - b.x) / CELL)));
      this.#insertRow(item, row, firstColumn, lastColumn, add);
    }
  }

  at(x: number, y: number): Uint32Array {
    const b = this.#bounds;
    if (!(x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height))
      return this.#items.subarray(0, 0);
    const c = Math.min(this.#columns - 1, Math.floor((x - b.x) / CELL));
    const r = Math.min(this.#rows - 1, Math.floor((y - b.y) / CELL));
    const cell = r * this.#columns + c;
    return this.#items.subarray(this.#starts[cell], this.#starts[cell + 1]);
  }

  get byteLength(): number {
    return this.#starts.byteLength + this.#items.byteLength + this.#seen.byteLength;
  }
}
