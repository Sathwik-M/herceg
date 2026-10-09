// What a 3D chart draws in one scene, before and after ordering: the faces
// its layers wrote (surface cells and points, in screen pixels), their sort
// keys, the order they are drawn in, and the index the pointer finds them
// through. A chart keeps one of these and reuses its buffers frame to frame.

import { facesDrawing } from "../draw/faces.ts";
import type { FaceGeometry, FaceStyle, Rect } from "../scene/scene.ts";

/** A face is first sorted by its key (lower first), then by its depth (farther first). */
export class FaceBuffer {
  vertices = new Float32Array(1024);
  /** Per vertex: its depth (larger is nearer). */
  vertexDepth = new Float32Array(512);
  vertexCount = 0;
  corners = new Uint32Array(1024);
  cornerCount = 0;
  /** Per face: where its corners start; entry `count` ends the last face. */
  starts = new Uint32Array(257);
  style = new Uint16Array(256);
  key = new Uint32Array(256);
  depth = new Float32Array(256);
  /** Per face: what it is to the layer that wrote it (a row, a cell). */
  local = new Uint32Array(256);
  count = 0;
  readonly styles: FaceStyle[] = [];
  readonly #styleIndex = new Map<string, number>();
  // Drawing order, and the arrays of the geometry in that order.
  #order = new Uint32Array(0);
  #scratch = new Uint32Array(0);
  #sortKeys = new Uint32Array(0);
  #drawCorners = new Uint32Array(0);
  #drawStarts = new Uint32Array(0);
  #drawStyle = new Uint16Array(0);
  /** Faces in drawing order: each one's index among the faces written. */
  drawn = new Uint32Array(0);

  reset(): void {
    this.vertexCount = 0;
    this.cornerCount = 0;
    this.count = 0;
    this.styles.length = 0;
    this.#styleIndex.clear();
  }

  /** The index of a style, added on first use. */
  styleOf(fill: string, opacity: number, radius: number, stroke?: string, strokeWidth = 0): number {
    const id = `${fill}|${opacity}|${radius}|${stroke}|${strokeWidth}`;
    let index = this.#styleIndex.get(id);
    if (index === undefined) {
      index = this.styles.length;
      if (index > 0xffff) throw new RangeError("A 3D chart draws at most 65,536 styles");
      this.styles.push({ fill, opacity, radius, stroke, strokeWidth });
      this.#styleIndex.set(id, index);
    }
    return index;
  }

  /** Adds a vertex at screen (x, y) and `depth`; returns its index. */
  vertex(x: number, y: number, depth: number): number {
    const at = this.vertexCount;
    if ((at + 1) * 2 > this.vertices.length) this.vertices = grow(this.vertices, (at + 1) * 2);
    if (at + 1 > this.vertexDepth.length) this.vertexDepth = grow(this.vertexDepth, at + 1);
    this.vertices[at * 2] = x;
    this.vertices[at * 2 + 1] = y;
    this.vertexDepth[at] = depth;
    this.vertexCount = at + 1;
    return at;
  }

  /** Adds a corner (a vertex index) to the face being written. */
  corner(vertex: number): void {
    const at = this.cornerCount;
    if (at + 1 > this.corners.length) this.corners = grow(this.corners, at + 1);
    this.corners[at] = vertex;
    this.cornerCount = at + 1;
  }

  /** Ends a face whose corners were just added. */
  face(style: number, key: number, depth: number, local: number): void {
    const f = this.count;
    if (f + 1 > this.style.length) {
      const size = f + 1;
      this.style = grow(this.style, size);
      this.key = grow(this.key, size);
      this.depth = grow(this.depth, size);
      this.local = grow(this.local, size);
    }
    if (f + 2 > this.starts.length) this.starts = grow(this.starts, f + 2);
    this.style[f] = style;
    this.key[f] = key;
    this.depth[f] = depth;
    this.local[f] = local;
    this.starts[f + 1] = this.cornerCount;
    this.count = f + 1;
  }

  /** Starts a face; its corners follow. */
  begin(): void {
    this.starts[this.count] = this.cornerCount;
  }

  /**
   * Orders the faces, by key when `keyed` and then by depth, and returns
   * the geometry drawing them in that order.
   */
  geometry(key: string, keyed: boolean, bounds: Rect): FaceGeometry {
    const n = this.count;
    if (this.#order.length < n) {
      this.#order = new Uint32Array(Math.ceil(n * 1.25));
      this.#scratch = new Uint32Array(this.#order.length);
      this.#sortKeys = new Uint32Array(this.#order.length);
    }
    const order = this.#order;
    for (let f = 0; f < n; f++) order[f] = f;
    const keys = this.#sortKeys;
    for (let f = 0; f < n; f++) keys[f] = sortableFloat(this.depth[f]!);
    radixSort(order, n, keys, this.#scratch);
    if (keyed) {
      for (let f = 0; f < n; f++) keys[f] = this.key[f]!;
      radixSort(order, n, keys, this.#scratch);
    }
    const mark = this.#gather(key, order);
    return this.#placeDiscs(mark, order, keyed, bounds) ? this.#gather(key, order) : mark;
  }

  /** The geometry drawing the faces in `order`. */
  #gather(key: string, order: Uint32Array): FaceGeometry {
    const n = this.count;
    if (this.#drawStarts.length < n + 1) {
      this.#drawStarts = new Uint32Array(Math.ceil((n + 1) * 1.25));
      this.#drawStyle = new Uint16Array(this.#drawStarts.length);
      this.drawn = new Uint32Array(this.#drawStarts.length);
    }
    if (this.#drawCorners.length < this.cornerCount)
      this.#drawCorners = new Uint32Array(Math.ceil(this.cornerCount * 1.25));
    const corners = this.#drawCorners;
    const starts = this.#drawStarts;
    let at = 0;
    for (let k = 0; k < n; k++) {
      const f = order[k]!;
      starts[k] = at;
      for (let c = this.starts[f]!; c < this.starts[f + 1]!; c++) corners[at++] = this.corners[c]!;
      this.#drawStyle[k] = this.style[f]!;
      this.drawn[k] = f;
    }
    starts[n] = at;
    return {
      kind: "faces",
      draw: facesDrawing,
      key,
      vertices: this.vertices,
      corners,
      starts,
      count: n,
      style: this.#drawStyle,
      styles: this.styles,
    };
  }

  /**
   * Places each disc among the polygons it overlaps on screen, which ordering
   * by its center alone does not: after those behind it and before those in
   * front, so cells drawn after a disc do not cut its edge though they lie
   * behind it (seen from above), and nearer cells still do. A polygon
   * covering the disc's center is in front when drawn after it in a `keyed`
   * (exact) order; otherwise it is judged by its depth where it comes
   * closest to the center. Overlapping discs are drawn by depth, farther
   * first, unless that would draw one over a polygon in front of it.
   * Whether the order changed.
   */
  #placeDiscs(mark: FaceGeometry, order: Uint32Array, keyed: boolean, bounds: Rect): boolean {
    const n = mark.count;
    const { starts, corners, vertices, style, styles } = mark;
    let count = 0;
    for (let k = 0; k < n; k++) if (starts[k + 1]! - starts[k]! === 1) count++;
    if (count === 0 || count === n) return false;
    const discs = new Uint32Array(count);
    count = 0;
    for (let k = 0; k < n; k++) if (starts[k + 1]! - starts[k]! === 1) discs[count++] = k;
    const polygons = new FaceIndex(mark, bounds, "polygons");
    const neighbors = new FaceIndex(mark, bounds, "discs");
    let largest = 0;
    for (const s of styles) largest = Math.max(largest, s.radius);
    const faceDepth = this.depth;
    const near = new Float64Array(1);
    // Per drawing position of a disc, the slot it goes to: slot p is before
    // the polygon at position p and after those before it. -1 for polygons.
    const slot = new Int32Array(n).fill(-1);
    const front = new Int32Array(n);
    const keys = new Uint32Array(n);
    for (const k of discs) {
      const v = corners[starts[k]!]!;
      const x = vertices[v * 2]!;
      const y = vertices[v * 2 + 1]!;
      const r = styles[style[k]!]!.radius;
      const depth = faceDepth[order[k]!]!;
      // The last polygon behind and the first in front, over the center and elsewhere.
      let behind = -1;
      let ahead = n;
      let edgeBehind = -1;
      let edgeAhead = n;
      const found = polygons.overlapping(x - r, y - r, x + r, y + r);
      for (let f = 0; f < found; f++) {
        const q = polygons.found[f]!;
        const distance = nearest(mark, this.vertexDepth, q, x, y, r, near);
        if (distance > r * r) continue;
        const inFront = keyed && distance === 0 ? q > k : near[0]! > depth;
        if (distance === 0) {
          if (inFront) ahead = Math.min(ahead, q);
          else behind = Math.max(behind, q);
        } else if (inFront) edgeAhead = Math.min(edgeAhead, q);
        else edgeBehind = Math.max(edgeBehind, q);
      }
      // Over the center the order holds; at the edge, polygons in front come
      // before those behind; where they disagree, the disc stays where it was.
      if (behind >= ahead) {
        behind = k - 1;
        ahead = k;
      }
      ahead = Math.max(behind + 1, Math.min(ahead, edgeAhead));
      behind = Math.min(ahead - 1, Math.max(behind, edgeBehind));
      slot[k] = behind + 1;
      front[k] = ahead;
      keys[k] = sortableFloat(depth);
    }
    radixSort(discs, count, keys, this.#scratch);
    // Farther discs first: each goes no earlier than the farther ones it
    // overlaps. Cells whose placed discs all go no later are passed over,
    // and crowded cells are taken whole (as if every disc in them overlapped:
    // a later slot changes nothing but the order among discs), so discs
    // piled on one spot are not compared pair by pair.
    const placed = new Uint8Array(n);
    const latest = new Int32Array(neighbors.cells).fill(-1);
    for (const k of discs) {
      const v = corners[starts[k]!]!;
      const x = vertices[v * 2]!;
      const y = vertices[v * 2 + 1]!;
      const r = styles[style[k]!]!.radius;
      let at = slot[k]!;
      const reach = r + largest;
      const found = neighbors.overlapping(x - reach, y - reach, x + reach, y + reach, (cell) => {
        if (latest[cell]! <= at) return true;
        if (neighbors.filedIn(cell) <= CROWDED) return false;
        at = latest[cell]!;
        return true;
      });
      for (let f = 0; f < found; f++) {
        const q = neighbors.found[f]!;
        if (!placed[q] || slot[q]! <= at) continue;
        const w = corners[starts[q]!]!;
        const dx = vertices[w * 2]! - x;
        const dy = vertices[w * 2 + 1]! - y;
        const both = r + styles[style[q]!]!.radius;
        if (dx * dx + dy * dy < both * both) at = slot[q]!;
      }
      slot[k] = Math.min(at, front[k]!);
      placed[k] = 1;
      const cell = neighbors.cellAt(x, y);
      latest[cell] = Math.max(latest[cell]!, slot[k]!);
    }
    for (const k of discs) keys[k] = slot[k]!;
    radixSort(discs, count, keys, this.#scratch);
    // Polygons keep their order; each slot's discs, by depth, go before the polygon after it.
    const merged = new Uint32Array(n);
    let at = 0;
    let d = 0;
    for (let k = 0; k < n; k++) {
      if (slot[k]! >= 0) continue;
      while (d < count && slot[discs[d]!]! <= k) merged[at++] = order[discs[d++]!]!;
      merged[at++] = order[k]!;
    }
    while (d < count) merged[at++] = order[discs[d++]!]!;
    let changed = false;
    for (let k = 0; k < n && !changed; k++) changed = merged[k] !== order[k];
    order.set(merged);
    return changed;
  }
}

/**
 * The squared screen distance from (x, y) to polygon k of `mark` (0 inside
 * it), or Infinity when its box lies farther than `within`; the depth at
 * the nearest point, by the vertices' depths `z`, goes to `near[0]`.
 */
function nearest(
  mark: FaceGeometry,
  z: Float32Array,
  k: number,
  x: number,
  y: number,
  within: number,
  near: Float64Array,
): number {
  const { vertices: v, corners, starts } = mark;
  const start = starts[k]!;
  const end = starts[k + 1]!;
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (let c = start; c < end; c++) {
    const i = corners[c]!;
    x0 = Math.min(x0, v[i * 2]!);
    x1 = Math.max(x1, v[i * 2]!);
    y0 = Math.min(y0, v[i * 2 + 1]!);
    y1 = Math.max(y1, v[i * 2 + 1]!);
  }
  if (x < x0 - within || x > x1 + within || y < y0 - within || y > y1 + within)
    return Number.POSITIVE_INFINITY;
  const a = corners[start]!;
  const ax = v[a * 2]!;
  const ay = v[a * 2 + 1]!;
  let best = Number.POSITIVE_INFINITY;
  // Each triangle of the fan the polygon is filled as: inside it, or nearest one of its edges.
  for (let c = start + 1; c + 1 < end; c++) {
    const b = corners[c]!;
    const e = corners[c + 1]!;
    const bx = v[b * 2]!;
    const by = v[b * 2 + 1]!;
    const ex = v[e * 2]!;
    const ey = v[e * 2 + 1]!;
    const area = (by - ey) * (ax - ex) + (ex - bx) * (ay - ey);
    if (area !== 0) {
      const la = ((by - ey) * (x - ex) + (ex - bx) * (y - ey)) / area;
      const lb = ((ey - ay) * (x - ex) + (ax - ex) * (y - ey)) / area;
      const le = 1 - la - lb;
      if (la >= 0 && lb >= 0 && le >= 0) {
        near[0] = la * z[a]! + lb * z[b]! + le * z[e]!;
        return 0;
      }
    }
    best = toEdge(v, z, a, b, x, y, best, near);
    best = toEdge(v, z, b, e, x, y, best, near);
    best = toEdge(v, z, e, a, x, y, best, near);
  }
  return best;
}

/** The squared distance from (x, y) to edge (p, q) when below `best`, noting the depth there in `near[0]`; else `best`. */
function toEdge(
  v: Float32Array,
  z: Float32Array,
  p: number,
  q: number,
  x: number,
  y: number,
  best: number,
  near: Float64Array,
): number {
  const px = v[p * 2]!;
  const py = v[p * 2 + 1]!;
  const dx = v[q * 2]! - px;
  const dy = v[q * 2 + 1]! - py;
  const length = dx * dx + dy * dy;
  const t = length > 0 ? Math.min(1, Math.max(0, ((x - px) * dx + (y - py) * dy) / length)) : 0;
  const ox = px + t * dx - x;
  const oy = py + t * dy - y;
  const distance = ox * ox + oy * oy;
  if (distance >= best) return best;
  near[0] = z[p]! + t * (z[q]! - z[p]!);
  return distance;
}

function grow<T extends Float32Array | Uint32Array | Uint16Array>(array: T, needed: number): T {
  const next = new (array.constructor as new (length: number) => T)(
    Math.max(needed, Math.ceil(array.length * 1.5)),
  );
  next.set(array);
  return next;
}

/** A float's bits as an unsigned integer that sorts as the float does. */
const floatView = new Float32Array(1);
const bitsView = new Uint32Array(floatView.buffer);
function sortableFloat(value: number): number {
  floatView[0] = value;
  const bits = bitsView[0]!;
  return bits & 0x80000000 ? ~bits >>> 0 : (bits | 0x80000000) >>> 0;
}

const COUNTS = new Uint32Array(65537);

/**
 * Sorts `order[0, n)` by `keys` of its entries, ascending and stable: two
 * counting passes of 16 bits each.
 */
export function radixSort(order: Uint32Array, n: number, keys: Uint32Array, scratch: Uint32Array) {
  for (const shift of [0, 16]) {
    const counts = COUNTS;
    counts.fill(0);
    for (let k = 0; k < n; k++) counts[((keys[order[k]!]! >>> shift) & 0xffff) + 1]!++;
    for (let b = 0; b < 65536; b++) counts[b + 1]! += counts[b]!;
    for (let k = 0; k < n; k++) {
      const f = order[k]!;
      scratch[counts[(keys[f]! >>> shift) & 0xffff]!++] = f;
    }
    order.set(scratch.subarray(0, n));
  }
}

/** Discs in a cell beyond which placing discs takes the cell whole. */
const CROWDED = 16;

/** Pointer reach past a disc's edge, in pixels. */
const REACH = 3;
/** Grid cells of the lookup, in pixels a side: at most, and at least where faces are dense. */
const CELL = 24;
const SMALLEST_CELL = 6;
/** Faces covering more cells than this are kept in a list tested on every query. */
const WIDE = 64;

/**
 * Finds the face drawn last (frontmost) under a pixel, through a uniform
 * grid: polygons are filed in every cell their box covers, discs in the
 * cell of their center, and a query looks as far around as discs reach.
 * Discs are found within REACH pixels of their edge.
 */
export class FaceIndex {
  readonly #mark: FaceGeometry;
  readonly #x0: number;
  readonly #y0: number;
  readonly #columns: number;
  readonly #rows: number;
  readonly #size: number;
  /** Faces by cell, cell after cell: those of cell c from `#starts[c]` to `#starts[c + 1]`. */
  readonly #starts: Uint32Array;
  readonly #items: Uint32Array;
  readonly #wide: number[] = [];
  readonly #reach: number;
  /** Per face: the `overlapping` query that last found it. */
  #seen: Uint32Array | undefined;
  #query = 0;
  /** The faces the last `overlapping` query found, as many as it returned. */
  found = new Uint32Array(64);

  /** `filed` leaves out discs or polygons: the index finds only the others. */
  constructor(mark: FaceGeometry, bounds: Rect, filed: "all" | "polygons" | "discs" = "all") {
    this.#mark = mark;
    this.#x0 = bounds.x;
    this.#y0 = bounds.y;
    const { vertices: v, corners, starts, count } = mark;
    const files = (k: number) => {
      const size = starts[k + 1]! - starts[k]!;
      return size > 0 && (filed === "all" || (filed === "discs") === (size === 1));
    };
    let filing = 0;
    for (let k = 0; k < count; k++) if (files(k)) filing++;
    // Cells of a few faces each, on average.
    const area = Math.max(1, bounds.width * bounds.height);
    this.#size = Math.min(
      CELL,
      Math.max(SMALLEST_CELL, Math.ceil(2 * Math.sqrt(area / Math.max(1, filing)))),
    );
    const columns = Math.max(1, Math.ceil(bounds.width / this.#size));
    const rows = Math.max(1, Math.ceil(bounds.height / this.#size));
    this.#columns = columns;
    this.#rows = rows;
    let largest = 0;
    for (const style of mark.styles) largest = Math.max(largest, style.radius);
    // Polygons are filed in every cell their box covers; discs reach past theirs.
    this.#reach = filed === "polygons" ? 0 : largest + REACH;
    // Each face's cells, as first and last column and row; -1 for faces filed nowhere.
    const boxes = new Int32Array(count * 4).fill(-1);
    const counts = new Uint32Array(columns * rows + 1);
    for (let k = 0; k < count; k++) {
      const start = starts[k]!;
      const end = starts[k + 1]!;
      if (!files(k)) continue;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (let c = start; c < end; c++) {
        const i = corners[c]!;
        const x = v[i * 2]!;
        const y = v[i * 2 + 1]!;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
      const c0 = this.#cell(x0, this.#x0, columns);
      const r0 = this.#cell(y0, this.#y0, rows);
      const c1 = this.#cell(x1, this.#x0, columns);
      const r1 = this.#cell(y1, this.#y0, rows);
      if ((c1 - c0 + 1) * (r1 - r0 + 1) > WIDE) {
        this.#wide.push(k);
        continue;
      }
      boxes[k * 4] = c0;
      boxes[k * 4 + 1] = r0;
      boxes[k * 4 + 2] = c1;
      boxes[k * 4 + 3] = r1;
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) counts[r * columns + c + 1]!++;
    }
    for (let c = 0; c < columns * rows; c++) counts[c + 1]! += counts[c]!;
    const items = new Uint32Array(counts[columns * rows]!);
    const next = counts.slice(0, columns * rows);
    for (let k = 0; k < count; k++) {
      const c0 = boxes[k * 4]!;
      if (c0 < 0) continue;
      const r0 = boxes[k * 4 + 1]!;
      const c1 = boxes[k * 4 + 2]!;
      const r1 = boxes[k * 4 + 3]!;
      for (let r = r0; r <= r1; r++)
        for (let c = c0; c <= c1; c++) items[next[r * columns + c]!++] = k;
    }
    this.#starts = counts;
    this.#items = items;
  }

  #cell(v: number, origin: number, n: number): number {
    return Math.min(n - 1, Math.max(0, Math.floor((v - origin) / this.#size)));
  }

  /** How many cells the grid has. */
  get cells(): number {
    return this.#columns * this.#rows;
  }

  /** How many faces are filed in a cell. */
  filedIn(cell: number): number {
    return this.#starts[cell + 1]! - this.#starts[cell]!;
  }

  /** The cell of a point, which a disc centered there is filed in. */
  cellAt(x: number, y: number): number {
    return (
      this.#cell(y, this.#y0, this.#rows) * this.#columns + this.#cell(x, this.#x0, this.#columns)
    );
  }

  /**
   * Finds each face filed in the cells a box covers once (polygons whose box
   * meets them, discs centered in them), but in no cell `pass` is true of:
   * their drawing positions, in `found`. Returns how many.
   */
  overlapping(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    pass?: (cell: number) => boolean,
  ): number {
    const c0 = this.#cell(x0, this.#x0, this.#columns);
    const c1 = this.#cell(x1, this.#x0, this.#columns);
    const r0 = this.#cell(y0, this.#y0, this.#rows);
    const r1 = this.#cell(y1, this.#y0, this.#rows);
    this.#seen ??= new Uint32Array(this.#mark.count);
    const seen = this.#seen;
    const query = ++this.#query;
    let count = 0;
    const add = (face: number) => {
      if (seen[face] === query) return;
      seen[face] = query;
      if (count === this.found.length) this.found = grow(this.found, count + 1);
      this.found[count++] = face;
    };
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        const cell = r * this.#columns + c;
        if (pass?.(cell)) continue;
        for (let k = this.#starts[cell]!; k < this.#starts[cell + 1]!; k++) add(this.#items[k]!);
      }
    for (const face of this.#wide) add(face);
    return count;
  }

  /** The drawing position of the frontmost face at (x, y), or -1. */
  find(x: number, y: number): number {
    // Discs are filed by their centers: look as far as they reach.
    const c0 = this.#cell(x - this.#reach, this.#x0, this.#columns);
    const c1 = this.#cell(x + this.#reach, this.#x0, this.#columns);
    const r0 = this.#cell(y - this.#reach, this.#y0, this.#rows);
    const r1 = this.#cell(y + this.#reach, this.#y0, this.#rows);
    let found = -1;
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        const cell = r * this.#columns + c;
        for (let k = this.#starts[cell]!; k < this.#starts[cell + 1]!; k++) {
          const face = this.#items[k]!;
          if (face > found && this.#hits(face, x, y)) found = face;
        }
      }
    for (const face of this.#wide) if (face > found && this.#hits(face, x, y)) found = face;
    return found;
  }

  #hits(k: number, x: number, y: number): boolean {
    const mark = this.#mark;
    const { vertices: v, corners, starts } = mark;
    const start = starts[k]!;
    const end = starts[k + 1]!;
    const a = corners[start]!;
    if (end - start === 1) {
      const r = mark.styles[mark.style[k]!]!.radius + REACH;
      const dx = v[a * 2]! - x;
      const dy = v[a * 2 + 1]! - y;
      return dx * dx + dy * dy <= r * r;
    }
    // Inside any triangle of the fan the face is filled with.
    for (let c = start + 1; c + 1 < end; c++) {
      if (inTriangle(v, a, corners[c]!, corners[c + 1]!, x, y)) return true;
    }
    return false;
  }
}

function inTriangle(
  v: Float32Array,
  a: number,
  b: number,
  c: number,
  x: number,
  y: number,
): boolean {
  const side = (p: number, q: number) =>
    (v[q * 2]! - v[p * 2]!) * (y - v[p * 2 + 1]!) -
    (v[q * 2 + 1]! - v[p * 2 + 1]!) * (x - v[p * 2]!);
  const s1 = side(a, b);
  const s2 = side(b, c);
  const s3 = side(c, a);
  return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
}
