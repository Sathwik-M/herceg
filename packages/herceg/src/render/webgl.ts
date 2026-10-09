// Draws point clouds (large point series) with WebGL2. The DOM runtime loads
// this module on demand, so charts without large point series never download
// it. One WebGL context serves every chart on the page: browsers allow only
// a few contexts, and dashboards can hold many charts. Each cloud is drawn
// into the shared, plot-sized canvas and copied into the chart's 2D canvas at
// its place in mark order. 3D charts' clouds are drawn by render/webgl3d.ts,
// through the same context.

import type { NumericArray } from "../data/column.ts";
import type { Mapping } from "../lod/m4.ts";
import type {
  CloudPainter,
  FaceGeometry,
  PointCloud,
  PointGeometry,
  Rect,
} from "../scene/scene.ts";

/** Marks missing values; uploaded values otherwise lie in [0, 1]. */
export const MISSING = 3e38;
/** Uniforms beyond this magnitude lose too much precision in float32. */
const UNIFORM_LIMIT = 1e30;

const VERTEX = `#version 300 es
in vec2 high;
in vec2 low;
// The view origin in the data's normalized units, split like the data.
uniform vec2 shiftHigh;
uniform vec2 shiftLow;
uniform vec2 scale;
uniform vec2 offset;
uniform float size;
void main() {
  if (high.x > 1e30) {
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }
  // Subtracting the large parts first keeps precision deep in a zoom.
  vec2 value = (high - shiftHigh) + (low - shiftLow);
  gl_Position = vec4(value * scale + offset, 0.0, 1.0);
  gl_PointSize = size;
}`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform vec4 color;
uniform float size;
uniform float radius;
out vec4 fragment;
void main() {
  float distance = length(gl_PointCoord - 0.5) * size;
  fragment = color * clamp(radius + 0.5 - distance, 0.0, 1.0);
}`;

/** How one axis was normalized: uploaded u = (v - min) / span, v in log10 units on log axes. */
interface Normalized {
  min: number;
  span: number;
  /** False when the data's range overflows; such clouds are placed on the CPU. */
  finite: boolean;
}

/**
 * Relative error of a position after normalization and the float32
 * high/low split (about 48 bits, with margin). Clouds whose error at the
 * current zoom would exceed a quarter pixel are placed on the CPU instead.
 */
const RELATIVE_ERROR = 2 ** -46;
/** Room for appended points in streams' buffers, as a multiple of the points uploaded. */
const STREAM_GROWTH = 1.5;
/** Streams' normalized range reaches this share of their data's span past each end, for points to come. */
const STREAM_HEADROOM = 0.5;

interface Upload {
  x: NumericArray;
  y: NumericArray;
  rows: Uint32Array | undefined;
  version: number;
  length: number;
  xLog: boolean;
  yLog: boolean;
  axes: [Normalized, Normalized];
  vao: WebGLVertexArrayObject;
  buffers: WebGLBuffer[];
  bytes: number;
  /** Charts that painted this upload; it is released when none remain. */
  owners: Set<object>;
  /**
   * For streams: the row identity and table `modifiedVersion` of what is
   * uploaded, where its first point sits in the buffers, and how many points
   * they hold.
   */
  stream?: {
    offset: number;
    modified: number;
    start: number;
    capacity: number;
    /** Whether points were dropped since the normalization was chosen, so their range may be wider than needed. */
    dropped: boolean;
  };
}

/** What the page's painter lends the 3D painter (render/webgl3d.ts). */
export interface Gpu {
  readonly gl: WebGL2RenderingContext;
  /** The plot-sized canvas clouds are drawn into, then copied from. */
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  readonly maxPointSize: number;
  /** Sizes the canvas and the viewport to `plot` at `pixelRatio`; its device size. */
  fit(plot: Rect, pixelRatio: number): [number, number];
}

/** Draws 3D charts' clouds through the page's painter (render/webgl3d.ts). */
export interface DeepClouds {
  paint(
    context: CanvasRenderingContext2D,
    mark: FaceGeometry,
    plot: Rect,
    pixelRatio: number,
    owner: object,
  ): boolean;
  endFrame(owner: object): void;
  release(owner: object): void;
  readonly bytes: number;
}

let shared: Painter | null | undefined;

/** The page's cloud painter, or undefined when WebGL2 is unavailable. */
export function cloudPainter(): CloudPainter | undefined {
  if (shared === undefined || (shared && !shared.usable)) shared = Painter.create();
  return shared ?? undefined;
}

/**
 * The page's cloud painter, drawing 3D clouds too once render/webgl3d.ts
 * has loaded; undefined when WebGL2 is unavailable.
 */
export async function deepPainter(): Promise<CloudPainter | undefined> {
  const { deepClouds } = await import("./webgl3d.ts");
  const painter = cloudPainter() as Painter | undefined;
  painter?.deepen(deepClouds);
  return painter;
}

class Painter implements CloudPainter {
  readonly #canvas: HTMLCanvasElement | OffscreenCanvas;
  readonly #gl: WebGL2RenderingContext;
  readonly #program: WebGLProgram;
  readonly #uniforms: Record<string, WebGLUniformLocation | null>;
  readonly #maxPointSize: number;
  /**
   * Uploads by series: its rows for long-format series (which share one y
   * column), otherwise its y column.
   */
  readonly #uploads = new Map<object, Upload>();
  readonly #gpu: Gpu;
  /** The 3D clouds' painter, once a 3D chart loaded it; null when it cannot draw. */
  #deep: DeepClouds | null | undefined;
  /** Uploads each chart painted since its last `endFrame`. */
  readonly #painted = new Map<object, Set<Upload>>();
  #bytes = 0;
  #usable = true;

  static create(): Painter | null {
    const canvas =
      typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(1, 1)
        : globalThis.document?.createElement("canvas");
    // A depth buffer for 3D clouds; 2D clouds leave it off.
    const gl = canvas?.getContext("webgl2", {
      premultipliedAlpha: true,
      antialias: false,
      depth: true,
      stencil: false,
    }) as WebGL2RenderingContext | null | undefined;
    if (!canvas || !gl) return null;
    const program = link(gl, VERTEX, FRAGMENT);
    return program ? new Painter(canvas, gl, program) : null;
  }

  constructor(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    gl: WebGL2RenderingContext,
    program: WebGLProgram,
  ) {
    this.#canvas = canvas;
    this.#gl = gl;
    this.#program = program;
    this.#maxPointSize = (gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array)[1]!;
    const names = ["shiftHigh", "shiftLow", "scale", "offset", "size", "radius", "color"];
    this.#uniforms = Object.fromEntries(
      names.map((name) => [name, gl.getUniformLocation(program, name)]),
    );
    this.#gpu = {
      gl,
      canvas,
      maxPointSize: this.#maxPointSize,
      fit: (plot, pixelRatio) => {
        const width = Math.max(1, Math.round(plot.width * pixelRatio));
        const height = Math.max(1, Math.round(plot.height * pixelRatio));
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }
        gl.viewport(0, 0, width, height);
        return [width, height];
      },
    };
    canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      this.#usable = false;
      this.#uploads.clear();
      this.#deep = undefined;
      this.#painted.clear();
      this.#bytes = 0;
    });
  }

  get usable(): boolean {
    return this.#usable && !this.#gl.isContextLost();
  }

  get bytes(): number {
    return this.#bytes + (this.#deep?.bytes ?? 0);
  }

  /** Draws 3D clouds with the painter `create` makes, unless one was made. */
  deepen(create: (gpu: Gpu) => DeepClouds | null): void {
    if (this.#deep === undefined && this.usable) this.#deep = create(this.#gpu);
  }

  paint3d(
    context: CanvasRenderingContext2D,
    mark: FaceGeometry,
    plot: Rect,
    pixelRatio: number,
    owner: object,
  ): boolean {
    return this.usable && (this.#deep?.paint(context, mark, plot, pixelRatio, owner) ?? false);
  }

  paint(
    context: CanvasRenderingContext2D,
    mark: PointGeometry,
    plot: Rect,
    pixelRatio: number,
    owner: object,
  ): boolean {
    const cloud = mark.cloud;
    if (!cloud || !this.usable) return false;
    const radius = mark.radius * pixelRatio;
    // Sprites larger than the device allows would be cut off.
    const size = 2 * radius + 2;
    if (size > this.#maxPointSize) return false;
    if (cloud.end <= cloud.start) return true;
    const gl = this.#gl;
    let upload = this.#upload(cloud);
    // A stream's range may still reach points it has dropped (an outlier
    // gone), costing precision; one fresh upload fits it to what is left.
    if (!this.#placeable(upload, cloud, pixelRatio) && upload.stream?.dropped) {
      upload = this.#upload(cloud, true);
    }
    upload.owners.add(owner);
    this.#paintedBy(owner).add(upload);

    // Clip space from the scales' mappings: pixel = offset + (v - origin) * factor,
    // with v = min + u * span for the uploaded u.
    const axis = (
      map: Mapping,
      normalized: Normalized,
      start: number,
      length: number,
      flip: boolean,
    ) => {
      const shift = (map.origin - normalized.min) / normalized.span;
      const high = Math.fround(shift);
      const sign = flip ? -1 : 1;
      return {
        high,
        low: shift - high,
        scale: (sign * normalized.span * map.factor * 2) / length,
        offset: sign * (((map.offset - start) * 2) / length - 1),
      };
    };
    if (!this.#placeable(upload, cloud, pixelRatio)) return false;
    const [ax, ay] = upload.axes;
    const x = axis(cloud.xMap, ax, plot.x, plot.width, false);
    const y = axis(cloud.yMap, ay, plot.y, plot.height, true);
    const safe = [x, y].every(
      (a) =>
        Math.abs(a.high) < UNIFORM_LIMIT &&
        Math.abs(a.scale) < UNIFORM_LIMIT &&
        Number.isFinite(a.offset),
    );
    if (!safe) return false;

    this.#gpu.fit(plot, pixelRatio);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.#program);
    gl.bindVertexArray(upload.vao);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const u = this.#uniforms;
    gl.uniform2f(u.shiftHigh!, x.high, y.high);
    gl.uniform2f(u.shiftLow!, x.low, y.low);
    gl.uniform2f(u.scale!, x.scale, y.scale);
    gl.uniform2f(u.offset!, x.offset, y.offset);
    gl.uniform1f(u.size!, size);
    gl.uniform1f(u.radius!, radius);
    const [r, g, b, a] = rgba(context, mark.fill);
    const alpha = a * mark.fillOpacity;
    gl.uniform4f(u.color!, r * alpha, g * alpha, b * alpha, alpha);
    const first = (upload.stream?.start ?? 0) + cloud.start;
    gl.drawArrays(gl.POINTS, first, cloud.end - cloud.start);
    gl.bindVertexArray(null);
    context.drawImage(this.#canvas, plot.x, plot.y, plot.width, plot.height);
    return true;
  }

  #paintedBy(owner: object): Set<Upload> {
    let painted = this.#painted.get(owner);
    if (!painted) {
      painted = new Set();
      this.#painted.set(owner, painted);
    }
    return painted;
  }

  endFrame(owner: object): void {
    const painted = this.#painted.get(owner);
    for (const [key, upload] of this.#uploads) {
      if (!upload.owners.has(owner) || painted?.has(upload)) continue;
      upload.owners.delete(owner);
      if (upload.owners.size === 0) this.#discard(key, upload);
    }
    this.#painted.delete(owner);
    this.#deep?.endFrame(owner);
  }

  release(owner: object): void {
    this.#painted.delete(owner);
    this.#deep?.release(owner);
    this.endFrame(owner);
  }

  /** Whether the GPU can place an upload's points within a quarter pixel at the cloud's zoom. */
  #placeable(upload: Upload, cloud: PointCloud, pixelRatio: number): boolean {
    const [ax, ay] = upload.axes;
    if (!(ax.finite && ay.finite)) return false;
    const error =
      Math.max(ax.span * Math.abs(cloud.xMap.factor), ay.span * Math.abs(cloud.yMap.factor)) *
      pixelRatio *
      RELATIVE_ERROR;
    return error < 0.25;
  }

  /**
   * The cloud's columns on the GPU, uploaded again only when they changed
   * (or always, `fresh`); streams take appended points and drop the first
   * ones in place.
   */
  #upload(cloud: PointCloud, fresh = false): Upload {
    const xLog = cloud.xMap.log;
    const yLog = cloud.yMap.log;
    const length = cloud.rows?.length ?? cloud.y.length;
    const key = cloud.stream?.key ?? cloud.rows ?? cloud.y;
    const cached = this.#uploads.get(key);
    if (cached && cached.xLog === xLog && cached.yLog === yLog) {
      const current =
        cached.x === cloud.x &&
        cached.y === cloud.y &&
        cached.rows === cloud.rows &&
        cached.version === cloud.version &&
        cached.length === length;
      if (!fresh && (current || (cloud.stream && this.#follow(cached, cloud)))) return cached;
    }
    const owners = cached?.owners ?? new Set<object>();
    if (cached) this.#discard(key, cached);

    // Values in the axis' units: log10 on log axes, NaN where unplaceable.
    const xs = axisValues(cloud.x, cloud.rows, length, xLog);
    const ys = axisValues(cloud.y, cloud.rows, length, yLog);
    // Normalizing each axis to [0, 1] over its data keeps every value, and
    // the sentinel for missing ones, within float32 range. A stream seen
    // changing gets room in its buffers and range for points to come; until
    // then its upload is as small as any.
    const stream = cloud.stream;
    const growing = stream !== undefined && cached?.stream !== undefined;
    const axes: [Normalized, Normalized] = growing
      ? [padded(normalization(xs)), padded(normalization(ys))]
      : [normalization(xs), normalization(ys)];
    const capacity = growing ? Math.max(1024, Math.ceil(length * STREAM_GROWTH)) : length;
    const high = new Float32Array(capacity * 2).fill(MISSING);
    const low = new Float32Array(capacity * 2);
    encode(xs, ys, false, false, 0, length, axes, high, low);
    const gl = this.#gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buffers = [high, low].map((data, i) => {
      const buffer = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, stream ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
      const location = gl.getAttribLocation(this.#program, i === 0 ? "high" : "low");
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
      return buffer;
    });
    gl.bindVertexArray(null);
    const upload: Upload = {
      x: cloud.x,
      y: cloud.y,
      rows: cloud.rows,
      version: cloud.version,
      length,
      xLog,
      yLog,
      axes,
      vao,
      buffers,
      bytes: high.byteLength + low.byteLength,
      owners,
      ...(stream && {
        stream: {
          offset: stream.offset,
          modified: stream.modified,
          start: 0,
          capacity,
          dropped: false,
        },
      }),
    };
    this.#uploads.set(key, upload);
    this.#bytes += upload.bytes;
    return upload;
  }

  /**
   * Brings a stream's upload up to date when rows were only appended and
   * dropped from the front since: the first points are skipped and new ones
   * written after the last, when they fit the buffers and the normalized
   * range. Whether it could.
   */
  #follow(upload: Upload, cloud: PointCloud): boolean {
    const held = upload.stream;
    const stream = cloud.stream!;
    if (!held || held.modified !== stream.modified) return false;
    const length = cloud.rows?.length ?? cloud.y.length;
    const dropped = stream.offset - held.offset;
    const kept = upload.length - dropped;
    if (dropped < 0 || kept < 0 || length < kept) return false;
    const start = held.start + dropped;
    if (start + length > held.capacity) return false;
    // A window that shrank far below its buffers gives the room back.
    if (held.capacity > 1024 && length * 4 < held.capacity) return false;
    if (length > kept) {
      const count = length - kept;
      const high = new Float32Array(count * 2).fill(MISSING);
      const low = new Float32Array(count * 2);
      // A series' new points are its last rows, gathered; whole columns' are their last values.
      const tail = cloud.rows?.subarray(kept, length);
      const fits = encode(
        tail ? axisValues(cloud.x, tail, count, false) : cloud.x,
        tail ? axisValues(cloud.y, tail, count, false) : cloud.y,
        upload.xLog,
        upload.yLog,
        tail ? 0 : kept,
        tail ? count : length,
        upload.axes,
        high,
        low,
      );
      if (!fits) return false;
      const gl = this.#gl;
      for (const [i, data] of [high, low].entries()) {
        gl.bindBuffer(gl.ARRAY_BUFFER, upload.buffers[i]!);
        gl.bufferSubData(gl.ARRAY_BUFFER, (start + kept) * 8, data);
      }
    }
    held.start = start;
    held.offset = stream.offset;
    held.dropped ||= dropped > 0;
    upload.length = length;
    upload.version = cloud.version;
    upload.x = cloud.x;
    upload.y = cloud.y;
    upload.rows = cloud.rows;
    return true;
  }

  #discard(key: object, upload: Upload): void {
    const gl = this.#gl;
    for (const buffer of upload.buffers) gl.deleteBuffer(buffer);
    gl.deleteVertexArray(upload.vao);
    this.#uploads.delete(key);
    this.#bytes -= upload.bytes;
    for (const painted of this.#painted.values()) painted.delete(upload);
  }
}

/**
 * A cloud axis's values by position: the column itself for whole columns on
 * linear axes, otherwise gathered rows or log10 values (NaN when not positive).
 */
function axisValues(
  column: NumericArray,
  rows: Uint32Array | undefined,
  length: number,
  log: boolean,
): NumericArray {
  if (!rows && !log) return column;
  const out = new Float64Array(length);
  for (let k = 0; k < length; k++) {
    const v = column[rows ? rows[k]! : k]!;
    out[k] = log ? (v > 0 ? Math.log10(v) : Number.NaN) : v;
  }
  return out;
}

/**
 * Writes points `[from, to)` as normalized float32 pairs and their
 * remainders into `high` and `low` from position 0, taking log10 of values
 * on log axes (`xLog`, `yLog`; values already in axis units pass false).
 * Missing values keep the sentinel. Whether every placeable point fell
 * inside the normalized range.
 */
function encode(
  xs: NumericArray,
  ys: NumericArray,
  xLog: boolean,
  yLog: boolean,
  from: number,
  to: number,
  [ax, ay]: readonly [Normalized, Normalized],
  high: Float32Array,
  low: Float32Array,
): boolean {
  let fits = true;
  for (let k = from; k < to; k++) {
    const vx = xLog ? (xs[k]! > 0 ? Math.log10(xs[k]!) : Number.NaN) : xs[k]!;
    const vy = yLog ? (ys[k]! > 0 ? Math.log10(ys[k]!) : Number.NaN) : ys[k]!;
    // Missing values keep the sentinel.
    if (!(vx - vx === 0 && vy - vy === 0)) continue;
    const ux = (vx - ax.min) / ax.span;
    const uy = (vy - ay.min) / ay.span;
    // A placeable value whose normalized position overflows cannot be drawn
    // with this normalization.
    if (!(ux - ux === 0 && uy - uy === 0)) {
      fits = false;
      continue;
    }
    if (ux < 0 || ux > 1 || uy < 0 || uy > 1) fits = false;
    const at = (k - from) * 2;
    const hx = Math.fround(ux);
    const hy = Math.fround(uy);
    high[at] = hx;
    high[at + 1] = hy;
    low[at] = ux - hx;
    low[at + 1] = uy - hy;
  }
  return fits;
}

/** A normalization widened past each end of the data, for values still to come. */
function padded(normalized: Normalized): Normalized {
  if (!normalized.finite) return normalized;
  const pad = normalized.span * STREAM_HEADROOM;
  const span = normalized.span + 2 * pad;
  return Number.isFinite(span) ? { min: normalized.min - pad, span, finite: true } : normalized;
}

/** The finite range of values, as an origin and a nonzero span. */
function normalization(values: NumericArray): Normalized {
  let min = Infinity;
  let max = -Infinity;
  for (let k = 0; k < values.length; k++) {
    const v = values[k]!;
    if (v < min && v > -Infinity) min = v;
    if (v > max && v < Infinity) max = v;
  }
  if (!(min <= max)) return { min: 0, span: 1, finite: true };
  const span = max - min;
  if (!Number.isFinite(span)) return { min, span: 1, finite: false };
  return { min, span: span > 0 ? span : 1, finite: true };
}

export function link(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): WebGLProgram | null {
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
  };
  const vertex = compile(gl.VERTEX_SHADER, vertexSource);
  const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
  if (!vertex || !fragment) return null;
  const program = gl.createProgram()!;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  return gl.getProgramParameter(program, gl.LINK_STATUS) ? program : null;
}

const colors = new Map<string, [number, number, number, number]>();
type Swatch = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
let swatch: Swatch | null | undefined;

/**
 * A CSS color as sRGB RGBA in [0, 1], found by painting one pixel, so every
 * syntax the browser accepts (color(), oklch(), named colors) converts the
 * same way Canvas would. `currentColor` resolves against the chart's canvas.
 */
export function rgba(
  context: CanvasRenderingContext2D,
  color: string,
): [number, number, number, number] {
  const resolved =
    color.toLowerCase() === "currentcolor" && "ownerDocument" in context.canvas
      ? getComputedStyle(context.canvas).color
      : color;
  const cached = colors.get(resolved);
  if (cached) return cached;
  if (swatch === undefined) {
    const canvas =
      typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(1, 1)
        : document.createElement("canvas");
    swatch = canvas.getContext("2d", { willReadFrequently: true }) as Swatch | null;
  }
  if (!swatch) return [0, 0, 0, 1];
  swatch.clearRect(0, 0, 1, 1);
  swatch.fillStyle = "#000";
  swatch.fillStyle = resolved;
  swatch.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = swatch.getImageData(0, 0, 1, 1).data;
  const value: [number, number, number, number] = [r! / 255, g! / 255, b! / 255, a! / 255];
  if (colors.size > 256) colors.clear();
  colors.set(resolved, value);
  return value;
}
