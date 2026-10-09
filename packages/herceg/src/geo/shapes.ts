// Shapes of a geometry set, projected and in pixels, kept per set so every
// mark and chart drawing the set shares them. Neither depends on the values
// that color the shapes, so recoloring reprojects nothing. A shape's plane
// box is kept per projection (4 numbers); its pixels per projection and fit:
// a resize projects again, at the new scale, rather than keeping every point
// in the plane as well.

import type { GeometrySet } from "../data/geometry.ts";
import {
  type PixelShape,
  type ProjectionPlan,
  pixelShapeOf,
  planeBox,
  type Transform,
} from "./project.ts";

/** Points closer than this many pixels to the last one kept are dropped. */
const TOLERANCE = 0.35;
/** Fits kept per set: a few charts or sizes drawing the same shapes. */
const FITS = 3;
/** Projections kept per set. */
const PROJECTIONS = 2;

interface Boxes {
  key: string;
  /** x0, y0, x1, y1 per geometry; NaN until measured. */
  boxes: Float64Array;
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
