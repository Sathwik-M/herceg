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

  /**
   * The last-drawn shape containing (x, y), or -1; with `above`, shapes it
   * marks 1 are drawn above the others (a highlighted selection).
   */
  find(x: number, y: number, above?: Uint8Array): number {
    const [c, r] = this.#cell(x, y);
    const cell = r * this.#columns + c;
    const n = this.#shapes.length;
    const rank = (s: number) => (above?.[s] === 1 ? n + s : s);
    let found = -1;
    const test = (s: number) => {
      if ((found < 0 || rank(s) > rank(found)) && contains(this.#shapes[s]!, x, y)) found = s;
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

/** Where a shape is drawn: its pixel (px, py) at (x + k px, y + k py), as `PolygonGeometry.transform` says. */
interface Move {
  k: number;
  x: number;
  y: number;
}

/** Scan lines across a shape's visible part where its keyboard anchor is looked for. */
const ANCHOR_LINES = 16;

/**
 * Whether any of a shape, moved by `move`, shows in `room`: an edge of it
 * crosses the room, or, with none crossing, the room is inside it (as its
 * middle is, holes and other polygons counted). Exact, unlike its box.
 */
export function showsIn(shape: PixelShape, move: Move | undefined, room: Rect): boolean {
  const { coords, rings } = shape;
  const [k, dx, dy] = move ? [move.k, move.x, move.y] : [1, 0, 0];
  // The room in the shape's own pixels.
  const left = (room.x - dx) / k;
  const top = (room.y - dy) / k;
  const right = left + room.width / k;
  const bottom = top + room.height / k;
  for (let r = 0; r + 1 < rings.length; r++) {
    let j = rings[r + 1]! - 1;
    for (let i = rings[r]!; i < rings[r + 1]!; j = i++) {
      const ax = coords[j * 2]!;
      const ay = coords[j * 2 + 1]!;
      const bx = coords[i * 2]!;
      const by = coords[i * 2 + 1]!;
      if (Math.max(ax, bx) < left || Math.min(ax, bx) > right) continue;
      if (Math.max(ay, by) < top || Math.min(ay, by) > bottom) continue;
      if (crossesBox(ax, ay, bx, by, left, top, right, bottom)) return true;
    }
  }
  return contains(shape, (left + right) / 2, (top + bottom) / 2);
}

/** Whether the segment from (ax, ay) to (bx, by), whose box meets the box given, crosses it. */
function crossesBox(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
): boolean {
  if (ax >= left && ax <= right && ay >= top && ay <= bottom) return true;
  // Else it crosses the box when the box's corners are not all on one side of it.
  const ex = bx - ax;
  const ey = by - ay;
  const a = ex * (top - ay) - ey * (left - ax);
  const b = ex * (top - ay) - ey * (right - ax);
  const c = ex * (bottom - ay) - ey * (right - ax);
  const d = ex * (bottom - ay) - ey * (left - ax);
  return Math.min(a, b, c, d) <= 0 && Math.max(a, b, c, d) >= 0;
}

/**
 * A point inside the part of a shape, moved by `move`, that shows in
 * `room`, for keyboard reading's tooltip when the whole shape's anchor is
 * out of sight: the middle of the widest stretch inside it along a few
 * lines across that part. Undefined when none is found.
 */
export function visibleAnchor(
  shape: PixelShape,
  move: Move | undefined,
  room: Rect,
): [number, number] | undefined {
  const { coords, rings } = shape;
  const [k, dx, dy] = move ? [move.k, move.x, move.y] : [1, 0, 0];
  // Each ring moved and cut to the room (Sutherland–Hodgman), which keeps
  // what the even-odd fill holds inside it.
  const cut: number[][] = [];
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let r = 0; r + 1 < rings.length; r++) {
    let ring: number[] = [];
    for (let i = rings[r]!; i < rings[r + 1]!; i++)
      ring.push(dx + k * coords[i * 2]!, dy + k * coords[i * 2 + 1]!);
    for (const [axis, edge, keep] of [
      [0, room.x, 1],
      [0, room.x + room.width, -1],
      [1, room.y, 1],
      [1, room.y + room.height, -1],
    ] as const)
      ring = cutRing(ring, axis, edge, keep);
    if (ring.length < 6) continue;
    cut.push(ring);
    for (let i = 0; i < ring.length; i += 2) {
      x0 = Math.min(x0, ring[i]!);
      x1 = Math.max(x1, ring[i]!);
      y0 = Math.min(y0, ring[i + 1]!);
      y1 = Math.max(y1, ring[i + 1]!);
    }
  }
  let best: [number, number] | undefined;
  let widest = 0;
  // The widest stretch inside the cut part along the line at height y.
  const scan = (y: number) => {
    const crossings: number[] = [];
    for (const ring of cut) {
      let j = ring.length - 2;
      for (let i = 0; i < ring.length; j = i, i += 2) {
        const yi = ring[i + 1]!;
        const yj = ring[j + 1]!;
        if (yi > y === yj > y) continue;
        crossings.push(ring[j]! + ((y - yj) * (ring[i]! - ring[j]!)) / (yi - yj));
      }
    }
    crossings.sort((a, b) => a - b);
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const width = crossings[i + 1]! - crossings[i]!;
      if (width > widest) [best, widest] = [[(crossings[i]! + crossings[i + 1]!) / 2, y], width];
    }
  };
  for (let line = 0; line < ANCHOR_LINES; line++)
    scan(y0 + ((line + 0.5) * (y1 - y0)) / ANCHOR_LINES);
  if (best) return best;
  // A part thinner than the lines are apart: between any two heights of
  // its points in a row, edges neither start nor end, so the line between
  // them crosses every stretch there is.
  const heights = [...new Set(cut.flatMap((ring) => ring.filter((_, i) => i % 2 === 1)))].sort(
    (a, b) => a - b,
  );
  for (let i = 0; i + 1 < heights.length; i++) scan((heights[i]! + heights[i + 1]!) / 2);
  return x0 <= x1 ? best : undefined;
}

/** A ring (x, y pairs) cut to the side of a line x = edge (axis 0) or y = edge (1) where `keep` times the distance is positive. */
function cutRing(ring: readonly number[], axis: 0 | 1, edge: number, keep: 1 | -1): number[] {
  const out: number[] = [];
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + n - 1) % n;
    const a = (ring[j * 2 + axis]! - edge) * keep;
    const b = (ring[i * 2 + axis]! - edge) * keep;
    if (a >= 0 !== b >= 0) {
      const t = a / (a - b);
      out.push(
        ring[j * 2]! + t * (ring[i * 2]! - ring[j * 2]!),
        ring[j * 2 + 1]! + t * (ring[i * 2 + 1]! - ring[j * 2 + 1]!),
      );
    }
    if (b >= 0) out.push(ring[i * 2]!, ring[i * 2 + 1]!);
  }
  return out;
}
