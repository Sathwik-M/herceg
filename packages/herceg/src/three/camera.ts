// Where a 3D chart is seen from, and how points of its box reach the
// screen. Each axis is normalized from -1 to 1 (z up); the box's sides then
// take the chart's `boxAspect`. The eye looks at the box's center from a
// direction given by an azimuth about the vertical axis and an elevation
// above the floor, and the box is projected orthographically or in
// perspective. It is fitted by a bound that holds at every angle, so it
// keeps its size as it turns.

import type { Rect } from "../scene/scene.ts";
import type { CameraSpec } from "../spec/spec.ts";

/** A camera with every setting given, angles in degrees. */
export interface Camera {
  /** About the vertical axis, counterclockwise from +x seen from above; from -180 to 180. */
  azimuth: number;
  /** Above the x-y plane, from -90 to 90. */
  elevation: number;
  /** 1 fits the box in the chart; larger values magnify. */
  zoom: number;
  perspective: boolean;
}

export const DEFAULT_CAMERA: Camera = {
  azimuth: -60,
  elevation: 25,
  zoom: 1,
  perspective: false,
};

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 10;

/**
 * The eye's distance from the box's center in perspective, in units of the
 * longest half side: far enough that the nearest corners grow by about half.
 */
const DISTANCE = 5;

/** Checks a camera's settings, naming `what` in errors. */
export function checkCamera(spec: CameraSpec, what = "camera"): void {
  const { azimuth, elevation, zoom, perspective } = spec;
  if (azimuth !== undefined && !Number.isFinite(azimuth))
    throw new RangeError(`${what}.azimuth must be a finite number of degrees, not ${azimuth}`);
  if (elevation !== undefined && !(elevation >= -90 && elevation <= 90))
    throw new RangeError(`${what}.elevation must be from -90 to 90 degrees, not ${elevation}`);
  if (zoom !== undefined && !(zoom >= MIN_ZOOM && zoom <= MAX_ZOOM))
    throw new RangeError(`${what}.zoom must be from ${MIN_ZOOM} to ${MAX_ZOOM}, not ${zoom}`);
  if (perspective !== undefined && typeof perspective !== "boolean")
    throw new TypeError(`${what}.perspective must be true or false, not ${perspective}`);
}

/**
 * A camera from `spec`, with what it leaves out taken from `base` (the
 * defaults), the azimuth brought into (-180, 180], and the elevation and
 * zoom into their ranges.
 */
export function resolveCamera(spec: CameraSpec | undefined, base: Camera = DEFAULT_CAMERA): Camera {
  return {
    azimuth: wrapDegrees(spec?.azimuth ?? base.azimuth),
    elevation: Math.min(90, Math.max(-90, spec?.elevation ?? base.elevation)),
    zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, spec?.zoom ?? base.zoom)),
    perspective: spec?.perspective ?? base.perspective,
  };
}

/** Degrees in (-180, 180]. */
export function wrapDegrees(degrees: number): number {
  const wrapped = ((((degrees + 180) % 360) + 360) % 360) - 180;
  return wrapped === -180 ? 180 : wrapped;
}

export function sameCamera(a: Camera, b: Camera): boolean {
  return (
    a.azimuth === b.azimuth &&
    a.elevation === b.elevation &&
    a.zoom === b.zoom &&
    a.perspective === b.perspective
  );
}

/** Checks a box aspect: three positive, finite lengths. */
export function checkBoxAspect(aspect: readonly number[]): void {
  if (aspect.length !== 3 || !aspect.every((side) => side > 0 && Number.isFinite(side)))
    throw new RangeError(`boxAspect must be three positive lengths, not ${aspect.join(", ")}`);
}

/**
 * Projects points of the box to the screen for one camera and room. Points
 * are given in normalized coordinates, each from -1 to 1. Screen x grows to
 * the right and y downward (CSS pixels); depth grows toward the eye, so
 * drawing in ascending depth paints far things first.
 */
export class View {
  readonly camera: Camera;
  /** Half the length of each side of the box, the longest 1. */
  readonly half: readonly [number, number, number];
  /** Unit vectors toward the eye, to the screen's right, and up it. */
  readonly eye: readonly [number, number, number];
  readonly right: readonly [number, number, number];
  readonly up: readonly [number, number, number];
  /** The eye's distance from the center in perspective; Infinity when orthographic. */
  readonly distance: number;
  /** Where the box's center lands. */
  readonly cx: number;
  readonly cy: number;
  /** Pixels per unit at the depth of the box's center. */
  readonly scale: number;
  /**
   * Screen and depth coefficients per normalized coordinate: right x, y; up
   * x, y, z; eye x, y, z (each times the box's half side on its axis).
   */
  readonly matrix: Float64Array;

  constructor(camera: Camera, room: Rect, aspect: readonly [number, number, number] = [1, 1, 1]) {
    this.camera = camera;
    const longest = Math.max(...aspect);
    const [a, b, c] = aspect.map((side) => side / longest) as [number, number, number];
    this.half = [a, b, c];
    const theta = (camera.azimuth * Math.PI) / 180;
    const phi = (camera.elevation * Math.PI) / 180;
    const [ct, st, cp, sp] = [Math.cos(theta), Math.sin(theta), Math.cos(phi), Math.sin(phi)];
    // The basis comes from the angles directly, so it is defined at the poles.
    this.eye = [cp * ct, cp * st, sp];
    this.right = [-st, ct, 0];
    this.up = [-sp * ct, -sp * st, cp];
    this.distance = camera.perspective ? DISTANCE : Number.POSITIVE_INFINITY;
    this.cx = room.x + room.width / 2;
    this.cy = room.y + room.height / 2;
    // At any angle the box reaches at most its floor's half diagonal across
    // and its half diagonal up and down; in perspective, at most the sphere
    // around it seen from the eye.
    const sphere = Math.hypot(a, b, c);
    const across = camera.perspective ? reach(sphere) : Math.hypot(a, b);
    const down = camera.perspective ? reach(sphere) : sphere;
    const fit = Math.min(room.width / 2 / across, room.height / 2 / down);
    this.scale = Math.max(0, fit) * camera.zoom;
    const [rx, ry] = this.right;
    const [ux, uy, uz] = this.up;
    const [ex, ey, ez] = this.eye;
    this.matrix = Float64Array.of(rx * a, ry * b, ux * a, uy * b, uz * c, ex * a, ey * b, ez * c);
  }

  /** How far toward the eye a point lies. */
  depth(x: number, y: number, z: number): number {
    const m = this.matrix;
    return x * m[5]! + y * m[6]! + z * m[7]!;
  }

  /**
   * Writes the screen position of the point at normalized (x, y, z) to
   * `out[at]` and `out[at + 1]` and returns its depth.
   */
  project(x: number, y: number, z: number, out: Float32Array | Float64Array, at: number): number {
    const m = this.matrix;
    const depth = x * m[5]! + y * m[6]! + z * m[7]!;
    const d = this.distance;
    const k = d === Number.POSITIVE_INFINITY ? this.scale : (this.scale * d) / (d - depth);
    out[at] = this.cx + (x * m[0]! + y * m[1]!) * k;
    out[at + 1] = this.cy - (x * m[2]! + y * m[3]! + z * m[4]!) * k;
    return depth;
  }

  /**
   * Where the eye is, in normalized coordinates: infinitely far along the
   * eye's direction when orthographic.
   */
  eyePosition(): [number, number, number] {
    const d = this.distance;
    const [ex, ey, ez] = this.eye;
    const [a, b, c] = this.half;
    return [(ex * d) / a, (ey * d) / b, (ez * d) / c];
  }
}

/** The radius on screen, at the center's depth, of a sphere of `radius` around the center seen from the eye. */
function reach(radius: number): number {
  return (radius * DISTANCE) / Math.sqrt(DISTANCE * DISTANCE - radius * radius);
}
