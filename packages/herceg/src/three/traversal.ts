// The order a height field's cells are drawn in so that each is painted
// before any that can cover it, and where points fall in that order. Along
// the eye's direction a cell of a surface over a grid can only hide what
// lies farther along both grid axes, so ranking rows of cells, and cells in
// a row, from the far side is a correct painting order for one surface; a
// point goes with the cell it lies over, before it when the cell's surface
// lies between the point and the eye, else after it.

import type { View } from "./camera.ts";

/**
 * The order of a surface's cells from the far side, as ranks per column and
 * row of cells. A cell can only hide cells farther from the eye along both
 * axes, so drawing rows of cells from the farthest, each row's cells from
 * the farthest, paints every cell before any that can hide it. Points get
 * keys in the same order, placed before the cell they are over when the ray
 * from them to the eye passes through it, else after it.
 */
export class Traversal {
  readonly #columns: Order;
  readonly #rows: Order;
  readonly #view: View;
  readonly #eye: [number, number, number];
  readonly #u: Float64Array;
  readonly #v: Float64Array;

  constructor(u: Float64Array, v: Float64Array, view: View) {
    this.#view = view;
    this.#eye = view.eyePosition();
    this.#u = u;
    this.#v = v;
    this.#columns = new Order(u, this.#nearness(0));
    this.#rows = new Order(v, this.#nearness(1));
  }

  /** How near the eye a position along axis k is: greater is nearer. */
  #nearness(k: number): (position: number) => number {
    const view = this.#view;
    if (view.distance === Number.POSITIVE_INFINITY) {
      const e = view.eye[k]!;
      return (position) => e * position;
    }
    const eye = this.#eye[k]!;
    return (position) => -Math.abs(position - eye);
  }

  get #width(): number {
    return 2 * this.#columns.cells + 1;
  }

  cellKey(i: number, j: number): number {
    return ((2 * this.#rows.rank[j]! + 1) * this.#width + 2 * this.#columns.rank[i]! + 1) * 3 + 1;
  }

  /** The key of a point at normalized (x, y, z), with `w` the grid points' heights. */
  pointKey(x: number, y: number, z: number, w: Float64Array, nx: number): number {
    const i = this.#columns.cellAt(x);
    const j = this.#rows.cellAt(y);
    const column = i >= 0 ? 2 * this.#columns.rank[i]! + 1 : 2 * this.#columns.before(x);
    const row = j >= 0 ? 2 * this.#rows.rank[j]! + 1 : 2 * this.#rows.before(y);
    // Over a cell, the point goes before it when the cell hides it.
    const side = i >= 0 && j >= 0 && this.#hides(i, j, x, y, z, w, nx) ? 0 : 2;
    return (row * this.#width + column) * 3 + side;
  }

  /**
   * Whether the triangles of cell (i, j) cross the ray from the point at
   * normalized (x, y, z) to the eye, in the box's units, inside the box
   * (what lies outside it is cut away).
   */
  #hides(i: number, j: number, x: number, y: number, z: number, w: Float64Array, nx: number) {
    const view = this.#view;
    const [ha, hb, hc] = view.half;
    const a = j * nx + i;
    const ids = [a, a + 1, a + nx + 1, a + nx];
    // Grid points without a place in the box (NaN heights) are missing.
    const held = ids.filter((p) => !Number.isNaN(w[p]!));
    if (held.length < 3) return false;
    const corner = (p: number): [number, number, number] => {
      const column = p % nx;
      return [this.#u[column]! * ha, this.#v[(p - column) / nx]! * hb, w[p]! * hc];
    };
    const origin: [number, number, number] = [x * ha, y * hb, z * hc];
    // Toward the eye: its direction, or its place in perspective (reached at t = 1).
    const far = view.distance === Number.POSITIVE_INFINITY;
    const direction = far ? view.eye : view.eye.map((e, k) => e * view.distance - origin[k]!);
    const triangles =
      held.length === 4
        ? [
            [0, 1, 2],
            [0, 2, 3],
          ]
        : [[0, 1, 2]];
    const inside = (t: number) =>
      view.half.every((h, k) => Math.abs(origin[k]! + t * direction[k]!) <= h * (1 + 1e-9));
    return triangles.some(([p, q, r]) => {
      const t = crossing(
        origin,
        direction,
        corner(held[p!]!),
        corner(held[q!]!),
        corner(held[r!]!),
      );
      return t > 1e-9 && (far || t < 1) && inside(t);
    });
  }
}

/** Where the ray from `origin` along `direction` crosses triangle (a, b, c), in units of `direction`; NaN if it does not (Möller–Trumbore). */
export function crossing(
  origin: readonly number[],
  direction: readonly number[],
  a: readonly number[],
  b: readonly number[],
  c: readonly number[],
): number {
  const e1 = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
  const e2 = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
  const [dx, dy, dz] = direction as [number, number, number];
  const p = [dy * e2[2]! - dz * e2[1]!, dz * e2[0]! - dx * e2[2]!, dx * e2[1]! - dy * e2[0]!];
  const det = e1[0]! * p[0]! + e1[1]! * p[1]! + e1[2]! * p[2]!;
  if (Math.abs(det) < 1e-15) return Number.NaN;
  const s = [origin[0]! - a[0]!, origin[1]! - a[1]!, origin[2]! - a[2]!];
  const u = (s[0]! * p[0]! + s[1]! * p[1]! + s[2]! * p[2]!) / det;
  if (u < 0 || u > 1) return Number.NaN;
  const q = [
    s[1]! * e1[2]! - s[2]! * e1[1]!,
    s[2]! * e1[0]! - s[0]! * e1[2]!,
    s[0]! * e1[1]! - s[1]! * e1[0]!,
  ];
  const v = (dx * q[0]! + dy * q[1]! + dz * q[2]!) / det;
  if (v < 0 || u + v > 1) return Number.NaN;
  return (e2[0]! * q[0]! + e2[1]! * q[1]! + e2[2]! * q[2]!) / det;
}

/** The cells between neighboring positions along one axis, ranked from the farthest. */
class Order {
  readonly cells: number;
  /** Each cell's place from the farthest. */
  readonly rank: Uint32Array;
  readonly #positions: Float64Array;
  readonly #nearness: (position: number) => number;
  /** The cells' nearness, ascending. */
  readonly #sorted: Float64Array;
  readonly #ascending: boolean;
  /** The first and last positions with a place on the axis (log axes have none for nonpositive values). */
  readonly #first: number;
  readonly #last: number;

  constructor(positions: Float64Array, nearness: (position: number) => number) {
    const cells = Math.max(0, positions.length - 1);
    this.cells = cells;
    this.#positions = positions;
    this.#nearness = nearness;
    let first = 0;
    let last = positions.length - 1;
    while (first <= last && !Number.isFinite(positions[first]!)) first++;
    while (last >= first && !Number.isFinite(positions[last]!)) last--;
    this.#first = first;
    this.#last = last;
    this.#ascending = last <= first || positions[last]! >= positions[first]!;
    // Cells without a place are never drawn; ranked farthest, they keep the others' order.
    const near = Float64Array.from({ length: cells }, (_, i) => {
      const value = nearness((positions[i]! + positions[i + 1]!) / 2);
      return Number.isNaN(value) ? Number.NEGATIVE_INFINITY : value;
    });
    const order = Array.from({ length: cells }, (_, i) => i).sort(
      (a, b) => near[a]! - near[b]! || a - b,
    );
    this.rank = new Uint32Array(cells);
    order.forEach((cell, place) => {
      this.rank[cell] = place;
    });
    this.#sorted = Float64Array.from(order, (cell) => near[cell]!);
  }

  /** The cell holding `position`, or -1 outside them. */
  cellAt(position: number): number {
    const p = this.#positions;
    const first = this.#first;
    const last = this.#last;
    if (last - first < 1) return -1;
    const at = (i: number) => (this.#ascending ? p[i]! : -p[i]!);
    const x = this.#ascending ? position : -position;
    if (!(x >= at(first) && x <= at(last))) return -1;
    let lo = first;
    let hi = last - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (at(mid) <= x) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** How many cells are farther than `position`, outside the cells. */
  before(position: number): number {
    const near = this.#nearness(position);
    const sorted = this.#sorted;
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sorted[mid]! < near) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}
