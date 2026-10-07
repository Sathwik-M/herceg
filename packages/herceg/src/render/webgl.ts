// Draws point clouds (large point series) with WebGL2. The DOM runtime loads
// this module on demand, so charts without large point series never download
// it. One WebGL context serves every chart on the page: browsers allow only
// a few contexts, and dashboards can hold many charts. Each cloud is drawn
// into the shared, plot-sized canvas and copied into the chart's 2D canvas at
// its place in mark order.

import type { NumericArray } from "../data/column.ts";
import type { Mapping } from "../lod/m4.ts";
import type { CloudPainter, PointCloud, PointGeometry, Rect } from "../scene/scene.ts";

/** Marks missing values; uploaded values otherwise lie in [0, 1]. */
const MISSING = 3e38;
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
}

let shared: Painter | null | undefined;

/** The page's cloud painter, or undefined when WebGL2 is unavailable. */
export function cloudPainter(): CloudPainter | undefined {
  if (shared === undefined || (shared && !shared.usable)) shared = Painter.create();
  return shared ?? undefined;
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
  readonly #uploads = new Map<NumericArray, Upload>();
  /** Uploads each chart painted since its last `endFrame`. */
  readonly #painted = new Map<object, Set<Upload>>();
  #bytes = 0;
  #usable = true;

  static create(): Painter | null {
    const canvas =
      typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(1, 1)
        : globalThis.document?.createElement("canvas");
    const gl = canvas?.getContext("webgl2", {
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
    }) as WebGL2RenderingContext | null | undefined;
    if (!canvas || !gl) return null;
    const program = link(gl);
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
    canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      this.#usable = false;
      this.#uploads.clear();
      this.#painted.clear();
      this.#bytes = 0;
    });
  }

  get usable(): boolean {
    return this.#usable && !this.#gl.isContextLost();
  }

  get bytes(): number {
    return this.#bytes;
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
    const upload = this.#upload(cloud);
    upload.owners.add(owner);
    const painted = this.#painted.get(owner) ?? new Set<Upload>();
    this.#painted.set(owner, painted);
    painted.add(upload);

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
    const [ax, ay] = upload.axes;
    if (!(ax.finite && ay.finite)) return false;
    const error =
      Math.max(ax.span * Math.abs(cloud.xMap.factor), ay.span * Math.abs(cloud.yMap.factor)) *
      pixelRatio *
      RELATIVE_ERROR;
    if (!(error < 0.25)) return false;
    const x = axis(cloud.xMap, ax, plot.x, plot.width, false);
    const y = axis(cloud.yMap, ay, plot.y, plot.height, true);
    const safe = [x, y].every(
      (a) =>
        Math.abs(a.high) < UNIFORM_LIMIT &&
        Math.abs(a.scale) < UNIFORM_LIMIT &&
        Number.isFinite(a.offset),
    );
    if (!safe) return false;

    const width = Math.max(1, Math.round(plot.width * pixelRatio));
    const height = Math.max(1, Math.round(plot.height * pixelRatio));
    if (this.#canvas.width !== width || this.#canvas.height !== height) {
      this.#canvas.width = width;
      this.#canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
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
    gl.drawArrays(gl.POINTS, cloud.start, cloud.end - cloud.start);
    gl.bindVertexArray(null);
    context.drawImage(this.#canvas, plot.x, plot.y, plot.width, plot.height);
    return true;
  }

  endFrame(owner: object): void {
    const painted = this.#painted.get(owner);
    for (const [key, upload] of this.#uploads) {
      if (!upload.owners.has(owner) || painted?.has(upload)) continue;
      upload.owners.delete(owner);
      if (upload.owners.size === 0) this.#discard(key, upload);
    }
    this.#painted.delete(owner);
  }

  release(owner: object): void {
    this.#painted.delete(owner);
    this.endFrame(owner);
  }

  /** The cloud's columns on the GPU, uploaded again only when they changed. */
  #upload(cloud: PointCloud): Upload {
    const xLog = cloud.xMap.log;
    const yLog = cloud.yMap.log;
    const length = cloud.rows?.length ?? cloud.y.length;
    const key = cloud.rows ?? cloud.y;
    const cached = this.#uploads.get(key);
    if (
      cached &&
      cached.x === cloud.x &&
      cached.y === cloud.y &&
      cached.rows === cloud.rows &&
      cached.version === cloud.version &&
      cached.length === length &&
      cached.xLog === xLog &&
      cached.yLog === yLog
    ) {
      return cached;
    }
    const owners = cached?.owners ?? new Set<object>();
    if (cached) this.#discard(key, cached);

    // Values in the axis' units: log10 on log axes, NaN where unplaceable.
    const xs = axisValues(cloud.x, cloud.rows, length, xLog);
    const ys = axisValues(cloud.y, cloud.rows, length, yLog);
    // Normalizing each axis to [0, 1] over its data keeps every value, and
    // the sentinel for missing ones, within float32 range.
    const axes: [Normalized, Normalized] = [normalization(xs), normalization(ys)];
    // Each coordinate is a float32 and its float32 remainder: about 48 bits.
    const high = new Float32Array(length * 2).fill(MISSING);
    const low = new Float32Array(length * 2);
    const [ax, ay] = axes;
    for (let k = 0; k < length; k++) {
      const ux = (xs[k]! - ax.min) / ax.span;
      const uy = (ys[k]! - ay.min) / ay.span;
      // NaN fails this test, so missing values keep the sentinel.
      if (!(ux - ux === 0 && uy - uy === 0)) continue;
      const hx = Math.fround(ux);
      const hy = Math.fround(uy);
      high[k * 2] = hx;
      high[k * 2 + 1] = hy;
      low[k * 2] = ux - hx;
      low[k * 2 + 1] = uy - hy;
    }
    const gl = this.#gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buffers = [high, low].map((data, i) => {
      const buffer = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
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
    };
    this.#uploads.set(key, upload);
    this.#bytes += upload.bytes;
    return upload;
  }

  #discard(key: NumericArray, upload: Upload): void {
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

function link(gl: WebGL2RenderingContext): WebGLProgram | null {
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
  };
  const vertex = compile(gl.VERTEX_SHADER, VERTEX);
  const fragment = compile(gl.FRAGMENT_SHADER, FRAGMENT);
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
function rgba(context: CanvasRenderingContext2D, color: string): [number, number, number, number] {
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
