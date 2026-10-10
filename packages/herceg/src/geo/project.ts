// From a projection's spec to pixels: the projection a map uses, shapes
// projected into its plane, the transform that fits them into the plot, and
// shapes in pixels.

import type { GeometrySet } from "../data/geometry.ts";
import type { Rect } from "../scene/scene.ts";
import type { ProjectionName, ProjectionSpec } from "../spec/spec.ts";
import { Clipper } from "./clip.ts";
import {
  albers,
  equalEarth,
  equirectangular,
  MERCATOR_LIMIT,
  mercator,
  naturalEarth,
  type RawProjection,
} from "./projection.ts";

const RADIANS = Math.PI / 180;

/** Where a map's data lies, for projections that place themselves by it. */
export interface GeoExtent {
  /** Which 1-degree columns of longitude (0 to 359, from -180) hold data. */
  longitudes: Uint8Array;
  south: number;
  north: number;
}

export function emptyExtent(): GeoExtent {
  return { longitudes: new Uint8Array(360), south: Infinity, north: -Infinity };
}

/** Marks a longitude and latitude, in degrees, as holding data. */
export function extendExtent(extent: GeoExtent, longitude: number, latitude: number): void {
  if (!(Number.isFinite(longitude) && Number.isFinite(latitude))) return;
  const column = Math.floor(wrapLongitude(longitude) + 180) % 360;
  extent.longitudes[column] = 1;
  if (latitude < extent.south) extent.south = latitude;
  if (latitude > extent.north) extent.north = latitude;
}

/** A projection with its parameters settled, and the cutting that goes with it. */
export interface ProjectionPlan {
  readonly name: ProjectionName;
  readonly raw: RawProjection;
  readonly clipper: Clipper;
  /** Identifies the projection and its parameters, for caches. */
  readonly key: string;
}

const RAW: Record<Exclude<ProjectionName, "conic-equal-area">, RawProjection> = {
  "equal-earth": equalEarth,
  "natural-earth": naturalEarth,
  mercator,
  equirectangular,
};

/** A projection's spec as an object; a name alone takes the defaults. */
export function projectionSpec(spec: ProjectionName | ProjectionSpec | undefined): ProjectionSpec {
  return typeof spec === "string" ? { type: spec } : (spec ?? { type: "equal-earth" });
}

/**
 * Settles a projection's parameters. A conic projection without its own
 * central meridian or parallels takes them from `extent` (or the fitted
 * box): the middle of the longitudes the data covers, the widest gap
 * between them taken as the side away from the map, and parallels a sixth
 * of the latitudes in from each end.
 */
export function planProjection(spec: ProjectionSpec, extent: GeoExtent): ProjectionPlan {
  const name = spec.type;
  const conic = name === "conic-equal-area";
  const box = typeof spec.fit === "object" ? spec.fit : undefined;
  if (box) checkBox(box);
  if (!Number.isFinite(spec.centralMeridian ?? 0))
    throw new RangeError(`centralMeridian must be a finite longitude, not ${spec.centralMeridian}`);
  const parallels = spec.parallels;
  if (parallels && !parallels.every((p) => Math.abs(p) <= 90))
    throw new RangeError(`parallels must be latitudes, from -90 to 90, not ${parallels}`);
  let center = spec.centralMeridian ?? 0;
  if (conic && spec.centralMeridian === undefined) {
    if (box) {
      const [[west], [east]] = box;
      center = west + ((east - west + 360) % 360 || 360) / 2;
    } else center = middleLongitude(extent.longitudes);
  }
  center = wrapLongitude(center);
  const limit = name === "mercator" ? MERCATOR_LIMIT : 90;
  let raw = RAW[name as keyof typeof RAW];
  if (!raw && !conic) throw new RangeError(`Unknown projection ${JSON.stringify(name)}`);
  let standard: readonly [number, number] = [0, 0];
  if (conic) {
    const south = box ? Math.min(box[0][1], box[1][1]) : extent.south;
    const north = box ? Math.max(box[0][1], box[1][1]) : extent.north;
    standard =
      parallels ??
      (south <= north ? [south + (north - south) / 6, north - (north - south) / 6] : [29.5, 45.5]);
    raw = albers(standard[0] * RADIANS, standard[1] * RADIANS);
  }
  return {
    name,
    raw: raw!,
    clipper: new Clipper(center, limit),
    key: `${name} ${center} ${conic ? standard.join(" ") : ""}`,
  };
}

/** Refuses a fit box that is not longitudes and latitudes, from south to north, of some width. */
function checkBox([[west, south], [east, north]]: readonly [
  readonly number[],
  readonly number[],
]): void {
  const longitudes = [west, east].every((v) => Math.abs(v ?? Number.NaN) <= 540);
  const latitudes = [south, north].every((v) => Math.abs(v ?? Number.NaN) <= 90);
  if (!(longitudes && latitudes && south! < north! && west !== east))
    throw new RangeError(
      `A projection's fit box is [[west, south], [east, north]] in degrees, south below north and west apart from east, not ${JSON.stringify(
        [
          [west, south],
          [east, north],
        ],
      )}`,
    );
}

/**
 * A longitude brought into [-180, 180] by an exact remainder, so that even
 * a huge one ends there (subtracting a multiple of 360 would not).
 */
export function wrapLongitude(longitude: number): number {
  const d = longitude % 360;
  return d > 180 ? d - 360 : d < -180 ? d + 360 : d;
}

/** The middle of the longitudes that `columns` marks, across the widest gap between them. */
function middleLongitude(columns: Uint8Array): number {
  let filled = 0;
  for (const c of columns) filled += c;
  if (filled === 0 || filled === 360) return 0;
  // The widest run of empty columns, going round.
  let best = 0;
  let bestEnd = 0;
  let run = 0;
  for (let i = 0; i < 720; i++) {
    run = columns[i % 360] ? 0 : run + 1;
    if (run > best) {
      best = Math.min(run, 359);
      bestEnd = i % 360;
    }
  }
  // Data runs from the column after the gap round to the column before it.
  const start = bestEnd + 1;
  const span = 360 - best;
  return start + span / 2 - 180;
}

/**
 * The plane box (x0, y0, x1, y1) of geometry `g` of `set`, as the map
 * fits it: each ring cut at the map's edges, its edges divided at a degree,
 * and every point projected. Projected edges are curves, which the shapes
 * drawn follow however far they are zoomed: each ring's box reaches twice
 * as far past its points as the middle of any of its edges lies from the
 * edge's chord, so it holds them. Empty (Infinity, -Infinity) when nothing
 * of it is on the map.
 */
export function planeBox(set: GeometrySet, g: number, plan: ProjectionPlan): Float64Array {
  const { coordinates, ringOffsets, polygonOffsets, geometryOffsets } = set;
  const box = new Float64Array([Infinity, Infinity, -Infinity, -Infinity]);
  const out = new Float64Array(2);
  const { raw } = plan;
  // Each ring's box, added to the geometry's when the ring keeps three points.
  let points = 0;
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  // The ring's first and last points, in degrees and in the plane, and the
  // square of the furthest its edges' middles lie from their chords' middles.
  let lonF = 0;
  let latF = 0;
  let xF = 0;
  let yF = 0;
  let lonL = 0;
  let latL = 0;
  let xL = 0;
  let yL = 0;
  let bow2 = 0;
  const bowTo = (lon: number, lat: number, x: number, y: number) => {
    raw(((lonL + lon) / 2) * RADIANS, ((latL + lat) / 2) * RADIANS, out);
    const dx = out[0]! - (xL + x) / 2;
    const dy = out[1]! - (yL + y) / 2;
    const off2 = dx * dx + dy * dy;
    if (off2 > bow2) bow2 = off2;
  };
  const sink = {
    start() {
      points = 0;
      bow2 = 0;
      x0 = y0 = Infinity;
      x1 = y1 = -Infinity;
    },
    point(longitude: number, latitude: number) {
      raw(longitude * RADIANS, latitude * RADIANS, out);
      const x = out[0]!;
      const y = out[1]!;
      if (!(Number.isFinite(x) && Number.isFinite(y))) return;
      if (points === 0) {
        lonF = longitude;
        latF = latitude;
        xF = x;
        yF = y;
      } else bowTo(longitude, latitude, x, y);
      lonL = longitude;
      latL = latitude;
      xL = x;
      yL = y;
      points++;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    },
    end() {
      if (points < 3) return;
      bowTo(lonF, latF, xF, yF);
      const bow = Math.sqrt(bow2);
      const reach = Number.isFinite(bow) ? 2 * bow : 0;
      if (x0 - reach < box[0]!) box[0] = x0 - reach;
      if (y0 - reach < box[1]!) box[1] = y0 - reach;
      if (x1 + reach > box[2]!) box[2] = x1 + reach;
      if (y1 + reach > box[3]!) box[3] = y1 + reach;
    },
  };
  // A geometry's rings are those of its polygons, in order.
  const end = polygonOffsets[geometryOffsets[g + 1]!]!;
  for (let r = polygonOffsets[geometryOffsets[g]!]!; r < end; r++)
    plan.clipper.ring(coordinates, ringOffsets[r]!, ringOffsets[r + 1]! - ringOffsets[r]!, sink);
  return box;
}

/** Plane to pixels: x' = x0 + k x, y' = y0 - k y. */
export interface Transform {
  k: number;
  x0: number;
  y0: number;
  readonly key: string;
}

/**
 * The transform that fits the plane box `box` (x0, y0, x1, y1) inside
 * `room`, `inset` pixels in from its edges, centered. A box of no size
 * takes `span` plane units around its center.
 */
export function fitTransform(
  box: ArrayLike<number>,
  room: Rect,
  inset: number,
  span: number,
): Transform {
  let [x0, y0, x1, y1] = [box[0]!, box[1]!, box[2]!, box[3]!];
  if (!(x1 - x0 > 1e-12 || y1 - y0 > 1e-12)) {
    // A point, or no box at all: `span` around it, or around the origin.
    const finite = Number.isFinite(x0 + x1 + y0 + y1);
    const [cx, cy] = finite ? [(x0 + x1) / 2, (y0 + y1) / 2] : [0, 0];
    [x0, y0, x1, y1] = [cx - span / 2, cy - span / 2, cx + span / 2, cy + span / 2];
  }
  const width = Math.max(1, room.width - 2 * inset);
  const height = Math.max(1, room.height - 2 * inset);
  const k = Math.min(
    x1 - x0 > 0 ? width / (x1 - x0) : Infinity,
    y1 - y0 > 0 ? height / (y1 - y0) : Infinity,
  );
  const tx = room.x + room.width / 2 - (k * (x0 + x1)) / 2;
  const ty = room.y + room.height / 2 + (k * (y0 + y1)) / 2;
  return { k, x0: tx, y0: ty, key: `${k} ${tx} ${ty}` };
}

/** The plane box of the whole map: the outline of the projected sphere. */
export function worldBox(plan: ProjectionPlan): Float64Array {
  const { limit, center } = plan.clipper;
  // The edges of the map, as one ring around it, cut and divided as shapes are.
  const outline = Float64Array.from([
    center - 180,
    -limit,
    center + 180,
    -limit,
    center + 180,
    limit,
    center - 180,
    limit,
  ]);
  return boxOf(plan, outline);
}

/**
 * The plane box of a box in degrees, `[[west, south], [east, north]]`;
 * west may exceed east. Empty (Infinity, -Infinity) when the box lies
 * beyond the projection's latitudes.
 */
export function degreeBox(
  plan: ProjectionPlan,
  [[west, south], [east, north]]: readonly [readonly [number, number], readonly [number, number]],
): Float64Array {
  const e = east < west ? east + 360 : east;
  return boxOf(plan, Float64Array.from([west, south, e, south, e, north, west, north]));
}

function boxOf(plan: ProjectionPlan, ring: Float64Array): Float64Array {
  const set: GeometrySet = {
    coordinates: ring,
    ringOffsets: Int32Array.from([0, ring.length / 2]),
    polygonOffsets: Int32Array.from([0, 1]),
    geometryOffsets: Int32Array.from([0, 1]),
  };
  return planeBox(set, 0, plan);
}

/** A geometry in pixels: points, ring and polygon starts, and boxes. */
export interface PixelShape {
  coords: Float32Array;
  /** Where each ring starts, in points, and where the last ends. */
  rings: Uint32Array;
  /** Where each polygon's rings start, and where the last's end. */
  parts: Uint32Array;
  /** x0, y0, x1, y1 per polygon. */
  partBoxes: Float32Array;
  /** x0, y0, x1, y1 of the whole shape. */
  box: Float32Array;
  /** SVG path data, made when first needed. */
  path: string | undefined;
}

/** Pixels a projected edge may stray from the chord drawn for it. */
const PRECISION = 0.25;
/** Edges shorter than this many pixels are drawn straight: they cannot stray further. */
const SHORT = 2;
/** Halvings of one edge, at most. */
const DEPTH = 16;

/**
 * Geometry `g` of `set` in pixels: cut at the map's edges, projected with
 * the fit `t`, and each edge divided until the projected curve is within a
 * quarter pixel of what is drawn, as d3-geo resamples. Points within
 * `tolerance` pixels of the last one kept are then dropped, rings left with
 * fewer than three points are dropped, and so are the holes of a polygon
 * whose exterior is dropped.
 */
export function pixelShapeOf(
  set: GeometrySet,
  g: number,
  plan: ProjectionPlan,
  t: Transform,
  tolerance: number,
): PixelShape {
  const { coordinates, ringOffsets, polygonOffsets, geometryOffsets } = set;
  const { raw } = plan;
  const plane = new Float64Array(2);
  const out: number[] = [];
  const ringStarts: number[] = [0];
  const partStarts: number[] = [0];
  const partBoxes: number[] = [];
  const box = new Float32Array([Infinity, Infinity, -Infinity, -Infinity]);
  const squared = tolerance * tolerance;
  // The ring being written, in pixels, with its first and last points.
  const ring: number[] = [];
  let lon0 = 0;
  let lat0 = 0;
  let x0 = 0;
  let y0 = 0;
  let lonP = 0;
  let latP = 0;
  let xP = 0;
  let yP = 0;
  let x = 0;
  let y = 0;
  const project = (lon: number, lat: number) => {
    raw(lon * RADIANS, lat * RADIANS, plane);
    x = t.x0 + t.k * plane[0]!;
    y = t.y0 - t.k * plane[1]!;
    return Number.isFinite(x) && Number.isFinite(y);
  };
  // Points along the edge from (l1, p1) to (l2, p2), whose pixels are given, until it is straight.
  const divide = (
    l1: number,
    p1: number,
    x1: number,
    y1: number,
    l2: number,
    p2: number,
    x2: number,
    y2: number,
    depth: number,
  ): void => {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const length2 = dx * dx + dy * dy;
    if (depth >= DEPTH || length2 < SHORT * SHORT) return;
    const lm = (l1 + l2) / 2;
    const pm = (p1 + p2) / 2;
    if (!project(lm, pm)) return;
    const xm = x;
    const ym = y;
    // How far the midpoint lies from the chord, and how far along it.
    const off = Math.abs((xm - x1) * dy - (ym - y1) * dx) / Math.sqrt(length2);
    const along = ((xm - x1) * dx + (ym - y1) * dy) / length2;
    if (off <= PRECISION && Math.abs(along - 0.5) < 0.3) return;
    divide(l1, p1, x1, y1, lm, pm, xm, ym, depth + 1);
    ring.push(xm, ym);
    divide(lm, pm, xm, ym, l2, p2, x2, y2, depth + 1);
  };
  let count = 0;
  let exterior = true;
  let keptExterior = false;
  let pb = [Infinity, Infinity, -Infinity, -Infinity];
  const sink = {
    start() {
      ring.length = 0;
      count = 0;
    },
    point(lon: number, lat: number) {
      if (!project(lon, lat)) return;
      const px = x;
      const py = y;
      if (count > 0) divide(lonP, latP, xP, yP, lon, lat, px, py, 0);
      else {
        lon0 = lon;
        lat0 = lat;
        x0 = px;
        y0 = py;
      }
      ring.push(px, py);
      lonP = lon;
      latP = lat;
      xP = px;
      yP = py;
      count++;
    },
    end() {
      // Holes go with their exterior's pieces, which come first.
      if (count < 3 || (!exterior && !keptExterior)) return;
      divide(lonP, latP, xP, yP, lon0, lat0, x0, y0, 0);
      const begin = out.length / 2;
      let lx = Number.NaN;
      let ly = Number.NaN;
      for (let i = 0; i < ring.length; i += 2) {
        const rx = ring[i]!;
        const ry = ring[i + 1]!;
        const dx = rx - lx;
        const dy = ry - ly;
        if (dx * dx + dy * dy < squared) continue;
        out.push(rx, ry);
        lx = rx;
        ly = ry;
      }
      if (out.length / 2 - begin < 3) {
        out.length = begin * 2;
        return;
      }
      if (exterior) keptExterior = true;
      for (let i = begin * 2; i < out.length; i += 2) {
        pb[0] = Math.min(pb[0]!, out[i]!);
        pb[1] = Math.min(pb[1]!, out[i + 1]!);
        pb[2] = Math.max(pb[2]!, out[i]!);
        pb[3] = Math.max(pb[3]!, out[i + 1]!);
      }
      ringStarts.push(out.length / 2);
    },
  };
  for (let p = geometryOffsets[g]!; p < geometryOffsets[g + 1]!; p++) {
    const before = ringStarts.length;
    keptExterior = false;
    pb = [Infinity, Infinity, -Infinity, -Infinity];
    for (let r = polygonOffsets[p]!; r < polygonOffsets[p + 1]!; r++) {
      exterior = r === polygonOffsets[p];
      plan.clipper.ring(coordinates, ringOffsets[r]!, ringOffsets[r + 1]! - ringOffsets[r]!, sink);
    }
    if (ringStarts.length === before) continue;
    partStarts.push(ringStarts.length - 1);
    for (let i = 0; i < 4; i++) partBoxes.push(pb[i]!);
    box[0] = Math.min(box[0]!, pb[0]!);
    box[1] = Math.min(box[1]!, pb[1]!);
    box[2] = Math.max(box[2]!, pb[2]!);
    box[3] = Math.max(box[3]!, pb[3]!);
  }
  return {
    coords: Float32Array.from(out),
    rings: Uint32Array.from(ringStarts),
    parts: Uint32Array.from(partStarts),
    partBoxes: Float32Array.from(partBoxes),
    box,
    path: undefined,
  };
}
