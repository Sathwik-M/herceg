// Contours of a field sampled on a rectilinear grid, by marching squares:
// the lines where the field crosses a threshold, and the rings bounding
// where it is at or above one. Values between samples are interpolated
// linearly along the grid's edges, in the grid's own coordinates (so
// unevenly spaced samples interpolate by distance), and a cell whose
// corners alternate above and below decides by the bilinear interpolant's
// value at its saddle (the asymptotic decider) whether the corners above
// connect through it. A cell with a corner that is not a value (NaN,
// infinities, or a point the grid lacks) is left out, so missing data
// leaves holes, never invented boundaries. Points are in grid units: a
// column index and a fraction of the way to the next, by a row index and a
// fraction; neighboring cells find a crossing by the edge it is on, never by
// comparing coordinates, so rings always close.

import type { NumericArray } from "../data/column.ts";

/** A field's samples: a value at every x crossed with every y. */
export interface ScalarGrid {
  /** Sample positions along x and y, strictly ascending. */
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  /** The value at xs[i], ys[j] at j * xs.length + i: rows of x, from the first y. */
  readonly values: NumericArray;
}

/** Lines or rings traced at one threshold, in grid units. */
export interface Traced {
  /** u, v per point: column and row positions, fractions between samples. */
  readonly points: Float32Array;
  /** Where each line or ring starts, in points; one more entry ends the last. */
  readonly starts: Uint32Array;
  /**
   * Each ring's signed area in square grid units: positive around what is
   * above the threshold (counterclockwise with y up), negative around a hole
   * in it; 0 for lines that do not close.
   */
  readonly areas: Float64Array;
  /** Each line's or ring's box in grid units: least u, least v, greatest u, greatest v. */
  readonly boxes: Float32Array;
  /** Each line's whether it closes on itself; rings always do. */
  readonly closed: Uint8Array;
}

/** Cells per side of the blocks traversal skips when a threshold misses them. */
const BLOCK = 16;

/**
 * What tracing a grid at any threshold shares: which cells have four
 * values, which of their sides end the field (the grid's edge, or a cell
 * without values beside them), and per block of cells the least and
 * greatest value and whether such a side is in it. Made once per grid.
 */
export class GridTracer {
  readonly grid: ScalarGrid;
  readonly #nx: number;
  readonly #ny: number;
  /** Per cell: 0 for none; else 1 plus a bit per side (bottom 2, right 4, top 8, left 16) ending the field. */
  readonly #cells: Uint8Array;
  readonly #blockMin: Float64Array;
  readonly #blockMax: Float64Array;
  readonly #blockEdges: Uint8Array;
  readonly #blocksX: number;
  /** Per node (grid point, then horizontal and vertical edge), the first segment leaving it, -1 for none. */
  #heads: Int32Array | undefined;

  constructor(grid: ScalarGrid) {
    this.grid = grid;
    const nx = grid.xs.length;
    const ny = grid.ys.length;
    this.#nx = nx;
    this.#ny = ny;
    const cx = Math.max(0, nx - 1);
    const cy = Math.max(0, ny - 1);
    const values = grid.values;
    const cells = new Uint8Array(cx * cy);
    for (let j = 0; j < cy; j++) {
      for (let i = 0; i < cx; i++) {
        const at = j * nx + i;
        if (
          Number.isFinite(values[at]!) &&
          Number.isFinite(values[at + 1]!) &&
          Number.isFinite(values[at + nx]!) &&
          Number.isFinite(values[at + nx + 1]!)
        )
          cells[j * cx + i] = 1;
      }
    }
    const has = (i: number, j: number) =>
      i >= 0 && j >= 0 && i < cx && j < cy && cells[j * cx + i] !== 0;
    for (let j = 0; j < cy; j++) {
      for (let i = 0; i < cx; i++) {
        const k = j * cx + i;
        if (!cells[k]) continue;
        let sides = 1;
        if (!has(i, j - 1)) sides |= 2;
        if (!has(i + 1, j)) sides |= 4;
        if (!has(i, j + 1)) sides |= 8;
        if (!has(i - 1, j)) sides |= 16;
        cells[k] = sides;
      }
    }
    this.#cells = cells;
    const bx = Math.ceil(cx / BLOCK);
    const by = Math.ceil(cy / BLOCK);
    this.#blocksX = bx;
    this.#blockMin = new Float64Array(bx * by).fill(Infinity);
    this.#blockMax = new Float64Array(bx * by).fill(-Infinity);
    this.#blockEdges = new Uint8Array(bx * by);
    for (let j = 0; j < cy; j++) {
      for (let i = 0; i < cx; i++) {
        const sides = cells[j * cx + i]!;
        if (!sides) continue;
        const b = Math.floor(j / BLOCK) * bx + Math.floor(i / BLOCK);
        if (sides > 1) this.#blockEdges[b] = 1;
        const at = j * nx + i;
        const [a, c, d, e] = [values[at]!, values[at + 1]!, values[at + nx]!, values[at + nx + 1]!];
        const low = Math.min(a, c, d, e);
        const high = Math.max(a, c, d, e);
        if (low < this.#blockMin[b]!) this.#blockMin[b] = low;
        if (high > this.#blockMax[b]!) this.#blockMax[b] = high;
      }
    }
  }

  /** Whether the grid has a cell of four values, which anything can be traced in. */
  get empty(): boolean {
    return this.#blockMin.every((v) => v === Infinity);
  }

  /**
   * The lines where the field crosses `threshold`, each oriented with the
   * values at or above it on its left: open where the field ends, closed
   * around a hill or a hollow.
   */
  lines(threshold: number): Traced {
    return this.#trace(threshold, false, false);
  }

  /**
   * The rings bounding where the field is at or above `threshold` (above
   * it, with `strict`): its lines, closed along the field's ends where the
   * values are above. Filled together by the even-odd rule, they cover
   * exactly that region; rings of a higher threshold lie inside, sharing no
   * crossing, so a band between two thresholds is the rings of both.
   */
  rings(threshold: number, strict = false): Traced {
    return this.#trace(threshold, strict, true);
  }

  #trace(t: number, strict: boolean, close: boolean): Traced {
    const nx = this.#nx;
    const ny = this.#ny;
    const cx = nx - 1;
    const cy = ny - 1;
    const values = this.grid.values;
    const segments = new Segments();
    // Node ids: grid points, then horizontal edges (i, j)-(i+1, j), then
    // vertical edges (i, j)-(i, j+1).
    const points = nx * ny;
    const horizontal = points;
    const vertical = points + Math.max(0, cx) * ny;
    const above = strict ? (v: number) => v > t : (v: number) => v >= t;
    const bx = this.#blocksX;
    const blocks = this.#blockMin.length;
    const corners = [0, 0, 0, 0];
    const up = [false, false, false, false];
    const crossing = [0, 0, 0, 0];
    for (let b = 0; b < blocks; b++) {
      const lo = this.#blockMin[b]!;
      const hi = this.#blockMax[b]!;
      if (lo === Infinity || !above(hi)) continue;
      // Wholly above: only the field's ends bound the region here.
      const whole = above(lo);
      if (whole && (!close || !this.#blockEdges[b])) continue;
      const i0 = (b % bx) * BLOCK;
      const j0 = Math.floor(b / bx) * BLOCK;
      const i1 = Math.min(cx, i0 + BLOCK);
      const j1 = Math.min(cy, j0 + BLOCK);
      for (let j = j0; j < j1; j++) {
        for (let i = i0; i < i1; i++) {
          const sides = this.#cells[j * cx + i]!;
          if (!sides || (whole && sides === 1)) continue;
          const at = j * nx + i;
          // Corners counterclockwise from the bottom left: (i, j), (i+1, j), (i+1, j+1), (i, j+1).
          corners[0] = at;
          corners[1] = at + 1;
          corners[2] = at + nx + 1;
          corners[3] = at + nx;
          let bits = 0;
          for (let k = 0; k < 4; k++) {
            up[k] = above(values[corners[k]!]!);
            if (up[k]) bits |= 1 << k;
          }
          // Edges counterclockwise: bottom, right, top, left.
          crossing[0] = horizontal + j * cx + i;
          crossing[1] = vertical + j * nx + i + 1;
          crossing[2] = horizontal + (j + 1) * cx + i;
          crossing[3] = vertical + j * nx + i;
          if (bits !== 0 && bits !== 15) {
            // Along the perimeter, a crossing leaves the region (above to
            // below) or enters it; a line runs from where it leaves to
            // where it enters, so the region is on its left.
            if (bits === 5 || bits === 10) {
              const joined = saddleAbove(
                values[at]!,
                values[at + 1]!,
                values[at + nx + 1]!,
                values[at + nx]!,
                t,
                strict,
              );
              for (let k = 0; k < 4; k++) {
                if (!up[k]) continue;
                // Leaving along edge k; joined corners meet the next entering crossing.
                segments.add(crossing[k]!, crossing[joined ? (k + 1) % 4 : (k + 3) % 4]!);
              }
            } else {
              let leaving = -1;
              let entering = -1;
              for (let k = 0; k < 4; k++) {
                const next = (k + 1) % 4;
                if (up[k] && !up[next]) leaving = k;
                else if (!up[k] && up[next]) entering = k;
              }
              segments.add(crossing[leaving]!, crossing[entering]!);
            }
          }
          if (!close || sides === 1) continue;
          // The field's ends close the region, along each side's part above.
          for (let k = 0; k < 4; k++) {
            if (!(sides & (2 << k))) continue;
            const next = (k + 1) % 4;
            if (up[k] && up[next]) segments.add(corners[k]!, corners[next]!);
            else if (up[k]) segments.add(corners[k]!, crossing[k]!);
            else if (up[next]) segments.add(crossing[k]!, corners[next]!);
          }
        }
      }
    }
    const nodes = vertical + nx * Math.max(0, cy);
    if (!this.#heads || this.#heads.length < nodes) this.#heads = new Int32Array(nodes).fill(-1);
    return stitch(segments, this.#heads, close, (node, out, at) => {
      if (node < horizontal) {
        out[at] = node % nx;
        out[at + 1] = Math.floor(node / nx);
        return;
      }
      const [edge, horizontalEdge] =
        node < vertical ? [node - horizontal, true] : [node - vertical, false];
      const [i, j] = horizontalEdge
        ? [edge % cx, Math.floor(edge / cx)]
        : [edge % nx, Math.floor(edge / nx)];
      const a = values[j * nx + i]!;
      const b = values[horizontalEdge ? j * nx + i + 1 : (j + 1) * nx + i]!;
      // Where the edge's values pass the threshold, from its first end.
      const f = Math.min(1, Math.max(0, fraction(t, a, b)));
      out[at] = horizontalEdge ? i + f : i;
      out[at + 1] = horizontalEdge ? j : j + f;
    });
  }
}

/**
 * How far from `a` to `b` the value `t` is. Differences of values a whole
 * range of doubles apart overflow; halves of them do not, though halving
 * loses the tiniest (subnormal) values, so they are taken only then.
 */
function fraction(t: number, a: number, b: number): number {
  const f = (t - a) / (b - a);
  return Number.isFinite(t - a) && Number.isFinite(b - a) ? f : (t / 2 - a / 2) / (b / 2 - a / 2);
}

/**
 * Whether the bilinear interpolant of a cell whose corners alternate above
 * and below threshold `t` is at or above it (above it, `strict`) at its
 * saddle, from the corners' values counterclockwise from the bottom left.
 * With d the corners' differences from the threshold, the saddle's value
 * less the threshold is (d0 d2 - d1 d3) / (d0 + d2 - d1 - d3), whose
 * denominator is positive when corners 0 and 2 are the high ones and
 * negative otherwise. Differences scaled to the largest keep the decision
 * the same however the field is shifted or scaled; halves of them are
 * taken only where the differences overflow, as for crossings.
 */
function saddleAbove(
  v0: number,
  v1: number,
  v2: number,
  v3: number,
  t: number,
  strict: boolean,
): boolean {
  let [d0, d1, d2, d3] = [v0 - t, v1 - t, v2 - t, v3 - t];
  if (!Number.isFinite(d0 + d1 + d2 + d3))
    [d0, d1, d2, d3] = [v0 / 2 - t / 2, v1 / 2 - t / 2, v2 / 2 - t / 2, v3 / 2 - t / 2];
  const largest = Math.max(Math.abs(d0), Math.abs(d1), Math.abs(d2), Math.abs(d3));
  [d0, d1, d2, d3] = [d0 / largest, d1 / largest, d2 / largest, d3 / largest];
  const numerator = (d0 * d2 - d1 * d3) * Math.sign(d0 + d2 - d1 - d3);
  return strict ? numerator > 0 : numerator >= 0;
}

/** Growable pairs of node ids: segments from one node to another. */
class Segments {
  from = new Int32Array(1024);
  to = new Int32Array(1024);
  count = 0;

  add(a: number, b: number): void {
    if (this.count === this.from.length) {
      const from = new Int32Array(this.count * 2);
      const to = new Int32Array(this.count * 2);
      from.set(this.from);
      to.set(this.to);
      [this.from, this.to] = [from, to];
    }
    this.from[this.count] = a;
    this.to[this.count] = b;
    this.count++;
  }
}

/**
 * Joins segments end to start into lines and rings, by their nodes:
 * `heads` (-1 for every node, as it is left again) indexes each node's
 * segments, and `place` writes a node's point. Lines start where no
 * segment ends; what is left closes on itself. Rings and lines of no
 * length or area (a sample exactly at the threshold) are left out.
 */
function stitch(
  segments: Segments,
  heads: Int32Array,
  rings: boolean,
  place: (node: number, out: Float32Array, at: number) => void,
): Traced {
  const { from, to, count } = segments;
  const next = new Int32Array(count);
  for (let s = 0; s < count; s++) {
    next[s] = heads[from[s]!]!;
    heads[from[s]!] = s;
  }
  const used = new Uint8Array(count);
  const out = new TracedBuilder();
  const take = (node: number): number => {
    for (let s = heads[node]!; s >= 0; s = next[s]!) if (!used[s]) return s;
    return -1;
  };
  const walk = (first: number) => {
    const start = from[first]!;
    out.begin();
    out.point(start, place);
    let closes = false;
    for (let s = first; s >= 0; ) {
      used[s] = 1;
      const node = to[s]!;
      out.point(node, place);
      if (node === start) {
        closes = true;
        break;
      }
      s = take(node);
    }
    out.end(closes);
  };
  if (!rings) {
    // Lines start at nodes no segment ends at.
    const ends = new Uint8Array(heads.length);
    for (let s = 0; s < count; s++) ends[to[s]!] = 1;
    for (let s = 0; s < count; s++) if (!used[s] && !ends[from[s]!]) walk(s);
  }
  for (let s = 0; s < count; s++) if (!used[s]) walk(s);
  for (let s = 0; s < count; s++) heads[from[s]!] = -1;
  return out.done();
}

/**
 * The rings bounding the band between two thresholds where their ring sets,
 * `lower` (around what is at or above the lower threshold) and `upper`,
 * share sides of cells: along the grid's ends and holes, both close where
 * the field is above both thresholds, and there the band has no boundary.
 * Rings of either set that run along no side of a cell bound the band as
 * they are. The others are `replaced`: taken apart into chains of
 * crossings and stretches of grid lines (the upper ones reversed, so the
 * band is on the left of every one), the stretches both sets cover
 * cancelled, and the rest joined again into `rings`, counterclockwise
 * around each piece of the band and clockwise around its holes. The band
 * filled even-odd is unchanged; its rings bound each piece of it apart.
 */
export function bandRings(
  lower: Traced,
  upper: Traced,
): { rings: Traced; replaced: [Uint8Array, Uint8Array] } {
  const replaced: [Uint8Array, Uint8Array] = [
    new Uint8Array(lower.areas.length),
    new Uint8Array(upper.areas.length),
  ];
  const pieces: Piece[] = [];
  // Stretches of grid lines, by line: from and to along it.
  const lines = new Map<string, number[]>();
  for (let k = 0; k < 2; k++) {
    const set = k === 0 ? lower : upper;
    const p = set.points;
    const step = k === 0 ? 1 : -1;
    for (let r = 0; r < set.areas.length; r++) {
      const [from, last] = [set.starts[r]!, set.starts[r + 1]! - 1];
      const n = last - from;
      // Segment s of the ring in the band's direction, from point a(s) to b(s).
      const a = (s: number) => (step > 0 ? from + s : last - s);
      const b = (s: number) => a(s) + step;
      const along = (s: number) =>
        onGridLine(p[a(s) * 2]!, p[a(s) * 2 + 1]!, p[b(s) * 2]!, p[b(s) * 2 + 1]!);
      // Most rings run along no grid line: a plain pass over their points says so.
      let sides = false;
      for (let q = from; q < last && !sides; q++)
        sides =
          (p[q * 2] === p[q * 2 + 2] && Number.isInteger(p[q * 2])) ||
          (p[q * 2 + 1] === p[q * 2 + 3] && Number.isInteger(p[q * 2 + 1]));
      if (!sides) continue;
      let first = 0;
      while (first < n && !along(first)) first++;
      replaced[k]![r] = 1;
      // From a stretch of grid line around the ring: chains of crossings
      // between stretches, split where the ring's points start again.
      let chain = -1;
      for (let i = 0; i < n; i++) {
        const s = (first + i) % n;
        if (s === 0 && chain >= 0) {
          // The ring's last segment ends at its first point, again.
          pieces.push({ points: p, from: chain, to: b(n - 1), step });
          chain = -1;
        }
        if (!along(s)) {
          if (chain < 0) chain = a(s);
          continue;
        }
        if (chain >= 0) pieces.push({ points: p, from: chain, to: a(s), step });
        chain = -1;
        const [au, av, bu, bv] = [p[a(s) * 2]!, p[a(s) * 2 + 1]!, p[b(s) * 2]!, p[b(s) * 2 + 1]!];
        if (au === bu && av === bv) continue;
        const horizontal = av === bv && Number.isInteger(av);
        const key = horizontal ? `h${av}` : `v${au}`;
        const list = lines.get(key);
        const stretch = horizontal ? [au, bu] : [av, bv];
        if (list) list.push(...stretch);
        else lines.set(key, stretch);
      }
      // A chain left open ends where the segment before the first stretch does.
      if (chain >= 0) pieces.push({ points: p, from: chain, to: b((first + n - 1) % n), step });
    }
  }
  // On each line, what the stretches cover in each direction cancels where
  // one goes each way; what is left goes as the cover does.
  for (const [key, list] of lines) {
    const at = Number(key.slice(1));
    const stops = [...new Set(list)].sort((x, y) => x - y);
    const stop = new Map(stops.map((value, i) => [value, i]));
    const cover = new Float64Array(stops.length);
    for (let q = 0; q < list.length; q += 2) {
      const [s0, s1] = [list[q]!, list[q + 1]!];
      const weight = s1 > s0 ? 1 : -1;
      for (let i = stop.get(Math.min(s0, s1))!; stops[i]! < Math.max(s0, s1); i++)
        cover[i]! += weight;
    }
    const emit = (s0: number, s1: number) =>
      pieces.push({
        points: Float32Array.from(key[0] === "h" ? [s0, at, s1, at] : [at, s0, at, s1]),
        from: 0,
        to: 1,
        step: 1,
      });
    for (let i = 0; i + 1 < stops.length; ) {
      const sign = Math.sign(cover[i]!);
      let j = i + 1;
      while (j + 1 < stops.length && Math.sign(cover[j]!) === sign) j++;
      if (sign > 0) emit(stops[i]!, stops[j]!);
      else if (sign < 0) emit(stops[j]!, stops[i]!);
      i = j;
    }
  }
  return { rings: joinPieces(pieces), replaced };
}

/** Points `from` to `to` of `points`, by `step`: a chain of a ring's points, or a stretch of grid line. */
interface Piece {
  points: Float32Array;
  from: number;
  to: number;
  step: 1 | -1;
}

/** Whether the segment from (au, av) to (bu, bv) lies along a grid line, as cells' sides do. */
function onGridLine(au: number, av: number, bu: number, bv: number): boolean {
  return (au === bu && Number.isInteger(au)) || (av === bv && Number.isInteger(av));
}

/** Joins pieces end to start into rings, by their end points. */
function joinPieces(pieces: Piece[]): Traced {
  const keyOf = ({ points }: Piece, at: number) => `${points[at * 2]} ${points[at * 2 + 1]}`;
  const starting = new Map<string, number[]>();
  pieces.forEach((piece, i) => {
    const key = keyOf(piece, piece.from);
    const list = starting.get(key);
    if (list) list.push(i);
    else starting.set(key, [i]);
  });
  const used = new Uint8Array(pieces.length);
  const out = new TracedBuilder();
  for (let first = 0; first < pieces.length; first++) {
    if (used[first]) continue;
    const start = keyOf(pieces[first]!, pieces[first]!.from);
    out.begin();
    const head = pieces[first]!;
    out.add(head.points[head.from * 2]!, head.points[head.from * 2 + 1]!);
    for (let i = first; i >= 0; ) {
      used[i] = 1;
      const { points, from, to, step } = pieces[i]!;
      // Each piece's first point is the last one's end.
      for (let c = 1; c <= (to - from) * step; c++)
        out.add(points[(from + c * step) * 2]!, points[(from + c * step) * 2 + 1]!);
      const end = keyOf(pieces[i]!, to);
      if (end === start) break;
      i = starting.get(end)?.find((t) => !used[t]) ?? -1;
      // A ring the pieces leave open closes on its first point.
      if (i < 0) out.add(head.points[head.from * 2]!, head.points[head.from * 2 + 1]!);
    }
    out.end(true);
  }
  return out.done();
}

/** Lines and rings, point by point, into growable arrays. */
class TracedBuilder {
  #points = new Float32Array(4096);
  #count = 0;
  #starts: number[] = [];
  #areas: number[] = [];
  #boxes: number[] = [];
  #closed: number[] = [];
  #begun = 0;

  begin(): void {
    this.#begun = this.#count;
  }

  point(node: number, place: (node: number, out: Float32Array, at: number) => void): void {
    this.#room();
    place(node, this.#points, this.#count * 2);
    this.#count++;
  }

  /** A point already in grid units. */
  add(u: number, v: number): void {
    this.#room();
    this.#points[this.#count * 2] = u;
    this.#points[this.#count * 2 + 1] = v;
    this.#count++;
  }

  #room(): void {
    if (this.#count * 2 + 2 > this.#points.length) {
      const grown = new Float32Array(this.#points.length * 2);
      grown.set(this.#points);
      this.#points = grown;
    }
  }

  end(closes: boolean): void {
    const from = this.#begun;
    const n = this.#count - from;
    const p = this.#points;
    let [minU, minV, maxU, maxV] = [Infinity, Infinity, -Infinity, -Infinity];
    let twice = 0;
    for (let k = 0; k < n; k++) {
      const u = p[(from + k) * 2]!;
      const v = p[(from + k) * 2 + 1]!;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
      if (k + 1 < n) twice += u * p[(from + k + 1) * 2 + 1]! - p[(from + k + 1) * 2]! * v;
    }
    const area = twice / 2;
    // A sample exactly at the threshold among lower ones traces a ring of
    // no area; a line of one place has no length.
    if (
      n < 2 ||
      (closes && Math.abs(area) < 1e-12) ||
      (!closes && maxU === minU && maxV === minV)
    ) {
      this.#count = from;
      return;
    }
    this.#starts.push(from);
    this.#areas.push(closes ? area : 0);
    this.#boxes.push(minU, minV, maxU, maxV);
    this.#closed.push(closes ? 1 : 0);
  }

  done(): Traced {
    return {
      points: this.#points.slice(0, this.#count * 2),
      starts: Uint32Array.from([...this.#starts, this.#count]),
      areas: Float64Array.from(this.#areas),
      boxes: Float32Array.from(this.#boxes),
      closed: Uint8Array.from(this.#closed),
    };
  }
}
