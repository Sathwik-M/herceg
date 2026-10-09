// Cutting shapes at the map's edges, in longitude and latitude, before they
// are projected. Edges are straight lines in longitude and latitude, as
// GeoJSON (RFC 7946) defines them, so cutting is plane clipping rather than
// spherical: longitudes are shifted by the central meridian, and each
// 360-degree window a ring reaches, [-180 + 360k, 180 + 360k], is cut out
// of it and moved back by 360k. With the central meridian at 0, rings of
// longitudes within ±180 need no cutting at all. Latitudes beyond the
// projection's limit (Mercator's) are cut off the same way.
//
// A cut follows the ring along the cutting line between where it leaves and
// where it comes back, pairing those crossings in order along the line, so
// a concave ring cut in several places becomes several rings, without
// zero-width connectors that a border would trace. Rings of a shape are cut
// one by one and filled together with the even-odd rule, so holes stay
// holes. Edges longer than a degree are divided, so that edges along the
// seam, the poles, or long parallels follow the projection's curves.

/** Receives cut rings, in degrees: longitudes from -180 to 180. */
export interface RingSink {
  start(): void;
  point(longitude: number, latitude: number): void;
  end(): void;
}

/** Edges longer than this many degrees are divided. */
const STEP = 1;

/**
 * Cuts rings for one map: its central meridian and latitude limit, in
 * degrees. It keeps scratch arrays between rings, so it is not reentrant.
 */
export class Clipper {
  readonly center: number;
  readonly limit: number;
  #ring: number[] = [];

  constructor(center: number, limit: number) {
    this.center = center;
    this.limit = limit;
  }

  /**
   * Cuts the ring of `count` points `coordinates[2 * from ...]` (longitude,
   * latitude pairs; a closing point equal to the first is optional) into
   * rings within the map, written to `sink`. Points that are not finite
   * are skipped.
   */
  ring(coordinates: ArrayLike<number>, from: number, count: number, sink: RingSink): void {
    const ring = this.#ring;
    ring.length = 0;
    let west = Infinity;
    let east = -Infinity;
    let south = Infinity;
    let north = -Infinity;
    for (let i = from; i < from + count; i++) {
      const lon = coordinates[i * 2]! - this.center;
      const lat = coordinates[i * 2 + 1]!;
      if (!(Number.isFinite(lon) && Number.isFinite(lat))) continue;
      ring.push(lon, lat);
      west = Math.min(west, lon);
      east = Math.max(east, lon);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
    }
    const n = ring.length;
    if (n >= 4 && ring[0] === ring[n - 2] && ring[1] === ring[n - 1]) ring.length = n - 2;
    if (ring.length < 6) return;
    let pieces = [ring];
    if (north > this.limit) pieces = cutAll(pieces, 1, this.limit, -1);
    if (south < -this.limit) pieces = cutAll(pieces, 1, -this.limit, 1);
    const first = Math.floor((west + 180) / 360);
    const last = Math.ceil((east + 180) / 360) - 1;
    // Rings span at most a turn (geometry columns check it), and the center
    // lies within ±180, so at most two windows near 0; anything else is not a
    // ring on this map.
    if (!(last - first <= 2 && Math.abs(first) <= 2 && Math.abs(last) <= 2)) return;
    for (let k = first; k <= last; k++) {
      let turn = pieces;
      if (first !== last) {
        turn = cutAll(turn, 0, -180 + 360 * k, 1);
        turn = cutAll(turn, 0, 180 + 360 * k, -1);
      }
      for (const piece of turn) if (piece.length >= 6) emit(piece, -360 * k, sink);
    }
  }

  /**
   * A point's longitude about the central meridian, from -180 to 180; NaN
   * when it is beyond the latitude limit or not finite.
   */
  longitude(longitude: number, latitude: number): number {
    if (!(Math.abs(latitude) <= this.limit && Number.isFinite(longitude))) return Number.NaN;
    // Exact remainders, before and after the shift, so that huge longitudes wrap too.
    const d = ((longitude % 360) - this.center) % 360;
    return d > 180 ? d - 360 : d < -180 ? d + 360 : d;
  }
}

function cutAll(rings: number[][], axis: 0 | 1, edge: number, side: 1 | -1): number[][] {
  const out: number[][] = [];
  for (const ring of rings) cut(ring, axis, edge, side, out);
  return out;
}

/**
 * The parts of a closed ring (x, y pairs without a closing point) where
 * coordinate `axis` (0 for x, 1 for y) is at least `edge` (`side` 1) or at
 * most it (`side` -1), added to `out`.
 */
export function cut(
  ring: readonly number[],
  axis: 0 | 1,
  edge: number,
  side: 1 | -1,
  out: number[][],
): void {
  const n = ring.length / 2;
  const inside = (i: number) => ring[i * 2 + axis]! * side >= edge * side;
  let start = -1;
  let all = true;
  for (let i = 0; i < n; i++) {
    if (inside(i)) continue;
    all = false;
    start = i;
    break;
  }
  if (all) {
    out.push(ring as number[]);
    return;
  }
  // Chains of the ring inside, each from where it enters to where it leaves.
  const chains: number[][] = [];
  let chain: number[] | undefined;
  for (let step = 1; step <= n; step++) {
    const p = (start + step - 1) % n;
    const c = (start + step) % n;
    const pIn = inside(p);
    const cIn = inside(c);
    if (pIn !== cIn) {
      const [x0, y0, x1, y1] = [ring[p * 2]!, ring[p * 2 + 1]!, ring[c * 2]!, ring[c * 2 + 1]!];
      const t = (edge - (axis === 0 ? x0 : y0)) / (axis === 0 ? x1 - x0 : y1 - y0);
      const crossing = axis === 0 ? [edge, y0 + (y1 - y0) * t] : [x0 + (x1 - x0) * t, edge];
      if (cIn) chain = crossing;
      else if (chain) {
        chain.push(crossing[0]!, crossing[1]!);
        chains.push(chain);
        chain = undefined;
      }
    }
    if (cIn && chain) chain.push(ring[c * 2]!, ring[c * 2 + 1]!);
  }
  // Chains lying on the line enclose nothing.
  const kept = chains.filter((points) => points.some((v, i) => i % 2 === axis && v !== edge));
  if (kept.length <= 1) {
    for (const chain of kept) out.push(chain);
    return;
  }
  // Along the line, crossings bound the stretches inside the ring in
  // pairs, in order; each stretch joins where one chain leaves to where
  // the next starts.
  const along = 1 - axis;
  const crossings = kept.flatMap((points, index) => [
    { at: points[along]!, index, enters: true },
    { at: points[points.length - 2 + along]!, index, enters: false },
  ]);
  crossings.sort((a, b) => a.at - b.at);
  const next = new Int32Array(kept.length).fill(-1);
  for (let i = 0; i + 1 < crossings.length; i += 2) {
    const [a, b] = [crossings[i]!, crossings[i + 1]!];
    // A ring that crosses itself pairs crossings that do not join; its
    // chains are kept in order around it instead.
    if (a.enters === b.enters) {
      out.push(kept.flat());
      return;
    }
    if (a.enters) next[b.index] = a.index;
    else next[a.index] = b.index;
  }
  const done = new Uint8Array(kept.length);
  for (let i = 0; i < kept.length; i++) {
    if (done[i]) continue;
    const joined: number[] = [];
    for (let k = i; k >= 0 && !done[k]; k = next[k]!) {
      done[k] = 1;
      // Point by point: a long chain has more points than a call takes arguments.
      for (const v of kept[k]!) joined.push(v);
    }
    out.push(joined);
  }
}

/** Writes a closed ring, moved by `shift` degrees of longitude, with long edges divided. */
function emit(points: readonly number[], shift: number, sink: RingSink): void {
  sink.start();
  const n = points.length;
  for (let i = 0; i < n; i += 2) {
    const x = points[i]! + shift;
    const y = points[i + 1]!;
    sink.point(x, y);
    const nx = points[(i + 2) % n]! + shift;
    const ny = points[(i + 3) % n]!;
    const steps = Math.ceil(Math.max(Math.abs(nx - x), Math.abs(ny - y)) / STEP);
    for (let s = 1; s < steps; s++)
      sink.point(x + ((nx - x) * s) / steps, y + ((ny - y) * s) / steps);
  }
  sink.end();
}
