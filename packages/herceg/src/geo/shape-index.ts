// Finding the shape under the pointer: a uniform grid of the polygons'
// bounding boxes narrows the shapes to test, then an even-odd crossing test
// over all of a candidate's rings decides (so holes and the other polygons
// of a multipolygon count). Polygons whose box would cover very many cells
// (a continent across the map) are kept in a short list tested every time
// instead, so the grid's size follows the room, not the shapes' extents.

import type { Rect } from "../scene/scene.ts";
import type { PixelShape } from "./project.ts";

/** Grid cells are this many pixels a side. */
const CELL = 32;
/** Polygons covering more cells than this are tested on every query. */
const MAX_CELLS = 64;

export class ShapeIndex {
  readonly #shapes: readonly (PixelShape | undefined)[];
  readonly #x0: number;
  readonly #y0: number;
  readonly #columns: number;
  readonly #rows: number;
  /** Per cell, where its entries start in `#items`, and where the last cell's end. */
  readonly #starts: Uint32Array;
  /** Shape indexes, cell by cell. */
  readonly #items: Uint32Array;
  /** Shapes with a polygon too large to grid. */
  readonly #large: Uint32Array;

  /** Indexes `shapes` (in drawing order; undefined for shapes not drawn) within `bounds`. */
  constructor(shapes: readonly (PixelShape | undefined)[], bounds: Rect) {
    this.#shapes = shapes;
    this.#x0 = bounds.x;
    this.#y0 = bounds.y;
    this.#columns = Math.max(1, Math.ceil(bounds.width / CELL));
    this.#rows = Math.max(1, Math.ceil(bounds.height / CELL));
    const cells = this.#columns * this.#rows;
    const counts = new Uint32Array(cells + 1);
    const large = new Set<number>();
    // Two passes over the polygons' cells: count, then fill.
    const visit = (add: (cell: number, shape: number) => void) => {
      shapes.forEach((shape, s) => {
        if (!shape) return;
        const { partBoxes } = shape;
        for (let p = 0; p < partBoxes.length; p += 4) {
          const [c0, r0] = this.#cell(partBoxes[p]!, partBoxes[p + 1]!);
          const [c1, r1] = this.#cell(partBoxes[p + 2]!, partBoxes[p + 3]!);
          if ((c1 - c0 + 1) * (r1 - r0 + 1) > MAX_CELLS) {
            large.add(s);
            continue;
          }
          for (let r = r0; r <= r1; r++)
            for (let c = c0; c <= c1; c++) add(r * this.#columns + c, s);
        }
      });
    };
    visit((cell) => counts[cell + 1]!++);
    for (let c = 0; c < cells; c++) counts[c + 1]! += counts[c]!;
    const next = counts.slice(0, cells);
    const items = new Uint32Array(counts[cells]!);
    visit((cell, shape) => {
      items[next[cell]!++] = shape;
    });
    this.#starts = counts;
    this.#items = items;
    this.#large = Uint32Array.from(large);
  }

  #cell(x: number, y: number): [number, number] {
    const clamp = (v: number, n: number) => Math.min(n - 1, Math.max(0, Math.floor(v / CELL)));
    return [clamp(x - this.#x0, this.#columns), clamp(y - this.#y0, this.#rows)];
  }

  /** The last-drawn shape containing (x, y), or -1. */
  find(x: number, y: number): number {
    const [c, r] = this.#cell(x, y);
    const cell = r * this.#columns + c;
    let found = -1;
    const test = (s: number) => {
      if (s > found && contains(this.#shapes[s]!, x, y)) found = s;
    };
    for (let k = this.#starts[cell]!; k < this.#starts[cell + 1]!; k++) test(this.#items[k]!);
    for (const s of this.#large) test(s);
    return found;
  }

  /** Bytes held by the index, for memory accounting. */
  get byteLength(): number {
    return this.#starts.byteLength + this.#items.byteLength + this.#large.byteLength;
  }
}

/** Whether a point is inside a shape: an odd number of its rings' edges cross a ray from it. */
export function contains(shape: PixelShape, x: number, y: number): boolean {
  const { box, coords, rings } = shape;
  if (!(x >= box[0]! && x <= box[2]! && y >= box[1]! && y <= box[3]!)) return false;
  let inside = false;
  for (let r = 0; r + 1 < rings.length; r++) {
    const start = rings[r]!;
    const end = rings[r + 1]!;
    let j = end - 1;
    for (let i = start; i < end; j = i++) {
      const yi = coords[i * 2 + 1]!;
      const yj = coords[j * 2 + 1]!;
      if (yi > y === yj > y) continue;
      const xi = coords[i * 2]!;
      const xj = coords[j * 2]!;
      if (x < xj + ((y - yj) * (xi - xj)) / (yi - yj)) inside = !inside;
    }
  }
  return inside;
}

/**
 * A point inside a shape, for keyboard reading's tooltip: on the horizontal
 * line through the middle of its largest polygon's box, the middle of the
 * widest stretch inside the shape.
 */
export function anchorOf(shape: PixelShape): [number, number] {
  const { partBoxes, coords, rings, box } = shape;
  let best = 0;
  let area = -1;
  for (let p = 0; p < partBoxes.length; p += 4) {
    const a = (partBoxes[p + 2]! - partBoxes[p]!) * (partBoxes[p + 3]! - partBoxes[p + 1]!);
    if (a > area) [best, area] = [p, a];
  }
  const y = (partBoxes[best + 1]! + partBoxes[best + 3]!) / 2;
  const crossings: number[] = [];
  for (let r = 0; r + 1 < rings.length; r++) {
    let j = rings[r + 1]! - 1;
    for (let i = rings[r]!; i < rings[r + 1]!; j = i++) {
      const yi = coords[i * 2 + 1]!;
      const yj = coords[j * 2 + 1]!;
      if (yi > y === yj > y) continue;
      const xi = coords[i * 2]!;
      const xj = coords[j * 2]!;
      crossings.push(xj + ((y - yj) * (xi - xj)) / (yi - yj));
    }
  }
  crossings.sort((a, b) => a - b);
  let x = (box[0]! + box[2]!) / 2;
  let widest = -1;
  for (let i = 0; i + 1 < crossings.length; i += 2) {
    const width = crossings[i + 1]! - crossings[i]!;
    if (width > widest) [x, widest] = [(crossings[i]! + crossings[i + 1]!) / 2, width];
  }
  return [x, y];
}
