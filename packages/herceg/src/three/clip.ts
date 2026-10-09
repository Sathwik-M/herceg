// Cutting polygons and segments at the walls of a 3D chart's box.

/** Cuts a polygon (x, y, z per corner, normalized) to the box from -1 to 1 on each axis. */
export function clipToBox(points: number[]): number[] {
  let polygon = points;
  for (let axis = 0; axis < 3; axis++) {
    for (const sign of [-1, 1]) {
      const next: number[] = [];
      const n = polygon.length / 3;
      for (let k = 0; k < n; k++) {
        const a = k * 3;
        const b = ((k + 1) % n) * 3;
        const da = 1 - sign * polygon[a + axis]!;
        const db = 1 - sign * polygon[b + axis]!;
        if (da >= 0) next.push(polygon[a]!, polygon[a + 1]!, polygon[a + 2]!);
        if (da >= 0 !== db >= 0) {
          const t = da / (da - db);
          for (let c = 0; c < 3; c++)
            next.push(polygon[a + c]! + t * (polygon[b + c]! - polygon[a + c]!));
        }
      }
      polygon = next;
      if (polygon.length === 0) return polygon;
    }
  }
  return polygon;
}

/** How far from its place, in the box's units, a cut end may be: a small fraction of a pixel. */
const PLACED = 1e-4;

/**
 * Cuts the segment from `a` to `b` (x, y, z each, normalized, from `at` and
 * `bt` in their arrays) to the box: writes where its part inside starts and
 * ends to `out` (6 numbers, each from -1 to 1) and returns whether it has
 * one; whether each end was cut goes to `cut`. Crossings are measured from
 * the end nearer the box, so they keep their precision however far the
 * other end is (with both far out on two axes, a part float64 cannot place
 * is left out rather than drawn wrong). An end outside the box is cut at
 * the wall, of those it lies beyond, crossed last going in (first going out).
 */
export function cutSegment(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  out: Float64Array,
  cut?: [boolean, boolean],
  at = 0,
  bt = 0,
): boolean {
  const reach = (p: ArrayLike<number>, pt: number) =>
    Math.max(Math.abs(p[pt]!), Math.abs(p[pt + 1]!), Math.abs(p[pt + 2]!));
  const flip = reach(b, bt) < reach(a, at);
  const [o, ot, f, ft] = flip ? [b, bt, a, at] : [a, at, b, bt];
  // Coordinates whose differences overflow are worked on in quarters.
  let scale = 1;
  for (let k = 0; k < 3; k++) if (!Number.isFinite(f[ft + k]! - o[ot + k]!)) scale = 0.25;
  const wall = scale;
  const origin = [0, 1, 2].map((k) => o[ot + k]! * scale);
  const span = [0, 1, 2].map((k) => f[ft + k]! * scale - origin[k]!);
  // Per axis, the fractions of the way from the near end where it crosses in and out, and the walls.
  const crossIn = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  const crossOut = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const walls = [0, 0, 0, 0, 0, 0];
  let s0 = 0;
  let s1 = 1;
  for (let k = 0; k < 3; k++) {
    const p = origin[k]!;
    const d = span[k]!;
    if (!Number.isFinite(p) || !Number.isFinite(d)) return false;
    if (d === 0) {
      if (Math.abs(p) > wall * (1 + 1e-9)) return false;
      continue;
    }
    const near = d > 0 ? -wall : wall;
    crossIn[k] = (near - p) / d;
    crossOut[k] = (-near - p) / d;
    walls[k] = near;
    walls[k + 3] = -near;
    s0 = Math.max(s0, crossIn[k]!);
    s1 = Math.min(s1, crossOut[k]!);
  }
  if (!(s0 <= s1)) return false;
  // Writes the near end (0) or the far end (1) of the part inside to `out` at `to`.
  const end = (e: 0 | 1, to: number): boolean | undefined => {
    const p = (k: number) => (e === 0 ? origin[k]! : f[ft + k]! * scale);
    const crossing = e === 0 ? crossIn : crossOut;
    let axis = -1;
    for (let k = 0; k < 3; k++) {
      if (!(Math.abs(p(k)) > wall)) continue;
      if (axis < 0 || (e === 0 ? crossing[k]! > crossing[axis]! : crossing[k]! < crossing[axis]!))
        axis = k;
    }
    for (let k = 0; k < 3; k++) {
      let value = p(k);
      if (axis === k) value = walls[k + e * 3]!;
      else if (axis >= 0) {
        const along = crossing[axis]! * span[k]!;
        value = origin[k]! + along;
        // Terms this large that cancel leave too little of the result to draw.
        if (4 * Number.EPSILON * (Math.abs(origin[k]!) + Math.abs(along)) > PLACED * wall)
          return undefined;
      }
      if (!(Math.abs(value) <= wall * (1 + 1e-6))) return undefined;
      out[to + k] = Math.min(1, Math.max(-1, value / scale));
    }
    return axis >= 0;
  };
  const [first, second] = flip ? [3, 0] : [0, 3];
  const near = end(0, first);
  const far = end(1, second);
  if (near === undefined || far === undefined) return false;
  if (cut) {
    cut[flip ? 1 : 0] = near;
    cut[flip ? 0 : 1] = far;
  }
  return true;
}
