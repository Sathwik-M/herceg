// Shapes of a geometry set, projected and in pixels, kept per set so every
// mark and chart drawing the set shares them. Neither depends on the values
// that color the shapes, so recoloring reprojects nothing. A shape's plane
// box is kept per projection (4 numbers); its pixels per projection and fit:
// a resize projects again, at the new scale, rather than keeping every point
// in the plane as well. Maps zoomed or panned project at a scale of their
// own (`zoomedTransform`), translation apart within a grid, so panning
// projects nothing until the view has moved far.

import type { GeometrySet } from "../data/geometry.ts";
import {
  type PixelShape,
  type ProjectionPlan,
  pixelShapeOf,
  planeBox,
  type Transform,
} from "./project.ts";
import { anchorOf } from "./shape-index.ts";

/** Points closer than this many pixels to the last one kept are dropped. */
const TOLERANCE = 0.35;
/** Fits kept per set: a few charts, sizes, or zoom levels drawing the same shapes. */
const FITS = 4;
/** Zoomed maps project at a power of two to this root: each level magnifies at most 19% more. */
const LEVELS_PER_DOUBLING = 4;
/**
 * Zoomed maps' pixels are about an origin on a grid of this many pixels:
 * those near the view are within about this far of it, a sixtieth of a
 * pixel apart in Float32, and pans this far project again.
 */
const ORIGIN_STEP = 2 ** 18;
/** Pixels across its plane box each region is projected to, to find its anchor. */
const ANCHOR_SIZE = 1024;
/** Projections kept per set. */
const PROJECTIONS = 2;

interface Boxes {
  key: string;
  /** x0, y0, x1, y1 per geometry; NaN until measured. */
  boxes: Float64Array;
  /** x, y per geometry in the plane: a point inside it; NaN until found. */
  anchors?: Float64Array;
}

interface Pixels {
  key: string;
  shapes: Map<number, PixelShape>;
}

const boxCache = new WeakMap<GeometrySet, Boxes[]>();
const pixelCache = new WeakMap<GeometrySet, Pixels[]>();

/** The newest entry keyed `key` in a short most-recent-first list, made when missing. */
function recent<T extends { key: string }>(list: T[], key: string, keep: number, make: () => T): T {
  const at = list.findIndex((entry) => entry.key === key);
  const entry = at >= 0 ? list.splice(at, 1)[0]! : make();
  list.unshift(entry);
  list.length = Math.min(list.length, keep);
  return entry;
}

function boxesOf(set: GeometrySet, plan: ProjectionPlan): Boxes {
  let list = boxCache.get(set);
  if (!list) {
    list = [];
    boxCache.set(set, list);
  }
  return recent(list, plan.key, PROJECTIONS, () => ({
    key: plan.key,
    boxes: new Float64Array((set.geometryOffsets.length - 1) * 4).fill(Number.NaN),
  }));
}

/**
 * The plane box of the geometries `codes` names (codes below 0 name none),
 * or undefined when none of them has a point on the map.
 */
export function boxOfCodes(
  set: GeometrySet,
  codes: ArrayLike<number>,
  plan: ProjectionPlan,
): Float64Array | undefined {
  const { boxes } = boxesOf(set, plan);
  const union = new Float64Array([Infinity, Infinity, -Infinity, -Infinity]);
  for (let i = 0; i < codes.length; i++) {
    const g = codes[i]!;
    if (g < 0) continue;
    if (Number.isNaN(boxes[g * 4]!)) boxes.set(planeBox(set, g, plan), g * 4);
    union[0] = Math.min(union[0]!, boxes[g * 4]!);
    union[1] = Math.min(union[1]!, boxes[g * 4 + 1]!);
    union[2] = Math.max(union[2]!, boxes[g * 4 + 2]!);
    union[3] = Math.max(union[3]!, boxes[g * 4 + 3]!);
  }
  return union[0]! <= union[2]! ? union : undefined;
}

/** The plane box (x0, y0, x1, y1) of geometry `g` of `set`; empty when nothing of it is on the map. */
export function planeBoxOf(set: GeometrySet, g: number, plan: ProjectionPlan): Float64Array {
  const { boxes } = boxesOf(set, plan);
  if (Number.isNaN(boxes[g * 4]!)) boxes.set(planeBox(set, g, plan), g * 4);
  return boxes.subarray(g * 4, g * 4 + 4);
}

/**
 * A point inside geometry `g` of `set`, in the plane, as the keyboard's
 * tooltip anchors a region (see `anchorOf`) but found once per projection,
 * with the geometry projected to `ANCHOR_SIZE` pixels across its own plane
 * box: lassos select regions by it, so what they select does not change
 * with the map's zoom, and small regions far from the plane's origin are
 * as precise as large ones. NaN when nothing of it is on the map.
 */
export function planeAnchor(set: GeometrySet, g: number, plan: ProjectionPlan): [number, number] {
  const entry = boxesOf(set, plan);
  entry.anchors ??= new Float64Array((set.geometryOffsets.length - 1) * 2).fill(Number.NaN);
  const { anchors } = entry;
  if (Number.isNaN(anchors[g * 2]!)) {
    const [bx0, by0, bx1, by1] = planeBoxOf(set, g, plan);
    const span = Math.max(bx1! - bx0!, by1! - by0!);
    if (!(span >= 0)) return [Number.NaN, Number.NaN];
    const k = span > 0 ? ANCHOR_SIZE / span : 1;
    const t = { k, x0: -k * bx0!, y0: k * by1!, key: "" };
    const shape = pixelShapeOf(set, g, plan, t, 0);
    if (shape.rings.length >= 2) {
      const [x, y] = anchorOf(shape);
      anchors[g * 2] = (x - t.x0) / k;
      anchors[g * 2 + 1] = (t.y0 - y) / k;
    }
  }
  return [anchors[g * 2]!, anchors[g * 2 + 1]!];
}

/**
 * What a zoomed or panned map projects its shapes with when drawn with
 * `t` in `room`: the next scale up of a few per doubling, never coarser
 * than the scale drawn, with its origin on a grid of `ORIGIN_STEP` pixels
 * by the room's middle, so that pans and nearby scales reuse the pixels,
 * drawn moved and scaled down by at most a level (see
 * `PolygonGeometry.transform`), and the pixels near the view stay small,
 * as precise in Float32 as the fitted map's however small the map.
 */
export function zoomedTransform(
  t: Transform,
  room: { x: number; y: number; width: number; height: number },
): Transform {
  const level = 2 ** (Math.ceil(Math.log2(t.k) * LEVELS_PER_DOUBLING) / LEVELS_PER_DOUBLING);
  // The room's middle in the plane, then in the level's pixels.
  const x = (room.x + room.width / 2 - t.x0) / t.k;
  const y = (t.y0 - room.y - room.height / 2) / t.k;
  const x0 = -Math.round((level * x) / ORIGIN_STEP) * ORIGIN_STEP;
  const y0 = Math.round((level * y) / ORIGIN_STEP) * ORIGIN_STEP;
  return { k: level, x0, y0, key: `${level} ${x0} ${y0}` };
}

/** Geometry `g` of `set` in pixels, with the projection and fit given. */
export function pixelShape(
  set: GeometrySet,
  g: number,
  plan: ProjectionPlan,
  transform: Transform,
): PixelShape {
  let list = pixelCache.get(set);
  if (!list) {
    list = [];
    pixelCache.set(set, list);
  }
  const key = `${plan.key}|${transform.key}`;
  const { shapes } = recent(list, key, FITS, () => ({ key, shapes: new Map() }));
  let shape = shapes.get(g);
  if (!shape) {
    shape = pixelShapeOf(set, g, plan, transform, TOLERANCE);
    shapes.set(g, shape);
  }
  return shape;
}
