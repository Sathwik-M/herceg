// Draws 3D charts' point clouds with WebGL2, with a depth test, so nearer
// points cover farther ones whatever order they come in. The page's cloud
// painter (render/webgl.ts) loads this module when a 3D chart needs it and
// lends it its context, so 2D charts never download it.

import type { NumericArray } from "../data/column.ts";
import type { Mapping } from "../lod/m4.ts";
import type { CloudLayer3D, FaceGeometry, Rect } from "../scene/scene.ts";
import { type DeepClouds, type Gpu, link, MISSING, rgba } from "./webgl.ts";

// Each value in the box's units as the axes mapped it when uploaded (log10
// units on log axes), placed in the box as they map it now and projected by
// the view. Points outside the box, missing values (the sentinel), and rows
// not drawn (style 255) are moved off the screen. Square sprites' corners
// are discarded, so they never hide what is behind them in the depth buffer.
const VERTEX_3D = `#version 300 es
in vec3 value;
in float style;
uniform vec3 factor;
uniform vec3 shift;
uniform vec2 right;
uniform vec3 up;
uniform vec3 toward;
uniform vec2 center;
uniform vec2 plot;
uniform float scale;
uniform float distance;
uniform float size;
uniform sampler2D palette;
out vec4 color;
void main() {
  vec3 u = value * factor + shift;
  if (style > 254.5 || any(greaterThan(abs(u), vec3(1.000001)))) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }
  float depth = dot(u, toward);
  float k = distance > 0.0 ? scale * distance / (distance - depth) : scale;
  vec2 p = center + vec2(dot(u.xy, right), -dot(u, up)) * k;
  gl_Position = vec4(p.x / plot.x * 2.0 - 1.0, 1.0 - p.y / plot.y * 2.0, -depth * 0.5, 1.0);
  gl_PointSize = size;
  color = texelFetch(palette, ivec2(int(style), 0), 0);
}`;

const FRAGMENT_3D = `#version 300 es
precision highp float;
in vec4 color;
uniform float size;
uniform float radius;
out vec4 fragment;
void main() {
  if (length(gl_PointCoord - 0.5) * size > radius + 0.5) discard;
  fragment = color;
}`;

/**
 * A 3D layer's columns on the GPU, as float32: each value (log10 units on
 * log axes) less its axis' origin, times its factor. The origins are the
 * centers of the axes' domains when uploaded, so values of any magnitude in
 * the box come out near [-1, 1] and keep their precision.
 */
interface Values3D {
  x: NumericArray;
  y: NumericArray;
  z: NumericArray;
  version: number;
  logs: string;
  origins: [number, number, number];
  factors: [number, number, number];
  length: number;
  buffer: WebGLBuffer;
  bytes: number;
  owners: Set<object>;
}

/** A 3D layer's color index per row on the GPU. */
interface Styles3D {
  buffer: WebGLBuffer;
  bytes: number;
  owners: Set<object>;
}

/** Float32 keeps 24 bits; positions in the box may be off by this share of their distance from the origin. */
const FLOAT32_ERROR = 2 ** -24;
/** How far an axis' factor may move from the one values were uploaded with before they are uploaded again. */
const RATIO_RANGE = 1e6;

/** A painter of 3D clouds on `gpu`'s context, or null when its program does not link. */
export function deepClouds(gpu: Gpu): DeepClouds | null {
  const program = link(gpu.gl, VERTEX_3D, FRAGMENT_3D);
  return program ? new DeepPainter(gpu, program) : null;
}

const UNIFORMS = [
  "factor",
  "shift",
  "right",
  "up",
  "toward",
  "center",
  "plot",
  "scale",
  "distance",
  "size",
  "radius",
  "palette",
];

class DeepPainter implements DeepClouds {
  readonly #gpu: Gpu;
  readonly #gl: WebGL2RenderingContext;
  readonly #program: WebGLProgram;
  readonly #uniforms: Record<string, WebGLUniformLocation | null>;
  /** Layers' values by their z column (layers sharing it may differ in x and y), and their colors. */
  readonly #values = new Map<object, Values3D[]>();
  readonly #styles = new Map<Uint8Array, Styles3D>();
  #vao: WebGLVertexArrayObject | undefined;
  /** Where the program reads each row's values and color index. */
  #attributes = { value: 0, style: 1 };
  /** Palettes as RGBA bytes, by their colors. */
  readonly #palettes = new Map<string, Uint8Array>();
  #palette: WebGLTexture | undefined;
  /** Uploads each chart painted since its last `endFrame`. */
  readonly #painted = new Map<object, Set<Values3D | Styles3D>>();
  #bytes = 0;

  constructor(gpu: Gpu, program: WebGLProgram) {
    this.#gpu = gpu;
    this.#gl = gpu.gl;
    this.#program = program;
    this.#uniforms = Object.fromEntries(
      UNIFORMS.map((name) => [name, gpu.gl.getUniformLocation(program, name)]),
    );
  }

  get bytes(): number {
    return this.#bytes;
  }

  paint(
    context: CanvasRenderingContext2D,
    mark: FaceGeometry,
    plot: Rect,
    pixelRatio: number,
    owner: object,
  ): boolean {
    const cloud = mark.cloud;
    if (!cloud) return false;
    // Sprites larger than the device allows would be cut off.
    if (cloud.layers.some((layer) => 2 * layer.radius * pixelRatio + 2 > this.#gpu.maxPointSize))
      return false;
    // Axes mapping no finite range of values are drawn on the CPU.
    if (
      !cloud.axes.every(
        (axis) => Number.isFinite(axis.factor) && axis.factor !== 0 && Number.isFinite(axis.origin),
      )
    )
      return false;
    const gl = this.#gl;
    const [width, height] = this.#gpu.fit(plot, pixelRatio);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.#program);
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    // Of points at one depth the later shows, as on the CPU and to the pointer.
    gl.depthFunc(gl.LEQUAL);
    const u = this.#uniforms;
    const m = cloud.view;
    gl.uniform2f(u.right!, m[0]!, m[1]!);
    gl.uniform3f(u.up!, m[2]!, m[3]!, m[4]!);
    gl.uniform3f(u.toward!, m[5]!, m[6]!, m[7]!);
    gl.uniform2f(u.center!, (cloud.cx - plot.x) * pixelRatio, (cloud.cy - plot.y) * pixelRatio);
    gl.uniform2f(u.plot!, width, height);
    gl.uniform1f(u.scale!, cloud.scale * pixelRatio);
    gl.uniform1f(u.distance!, Number.isFinite(cloud.distance) ? cloud.distance : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.#paletteTexture());
    gl.uniform1i(u.palette!, 0);
    const painted = this.#paintedBy(owner);
    const vao = this.#vertexArray();
    gl.bindVertexArray(vao);
    // A pixel's worth of the box's units at the scale drawn.
    const pixel = 1 / Math.max(1e-9, cloud.scale * pixelRatio);
    for (const layer of cloud.layers) {
      const values = this.#uploadValues(layer, cloud.axes, pixel);
      const styles = this.#uploadStyles(layer.style, values.length);
      for (const upload of [values, styles]) {
        upload.owners.add(owner);
        painted.add(upload);
      }
      const factor = cloud.axes.map((axis, k) => axis.factor / values.factors[k]!);
      const shift = cloud.axes.map(
        (axis, k) => axis.offset + (values.origins[k]! - axis.origin) * axis.factor,
      );
      gl.uniform3f(u.factor!, factor[0]!, factor[1]!, factor[2]!);
      gl.uniform3f(u.shift!, shift[0]!, shift[1]!, shift[2]!);
      const radius = layer.radius * pixelRatio;
      gl.uniform1f(u.size!, 2 * radius + 2);
      gl.uniform1f(u.radius!, radius);
      this.#writePalette(context, layer.palette);
      gl.bindBuffer(gl.ARRAY_BUFFER, values.buffer);
      gl.vertexAttribPointer(this.#attributes.value, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, styles.buffer);
      gl.vertexAttribPointer(this.#attributes.style, 1, gl.UNSIGNED_BYTE, false, 0, 0);
      gl.drawArrays(gl.POINTS, 0, values.length);
    }
    gl.bindVertexArray(null);
    gl.disable(gl.DEPTH_TEST);
    context.drawImage(this.#gpu.canvas, plot.x, plot.y, plot.width, plot.height);
    return true;
  }

  #paintedBy(owner: object): Set<Values3D | Styles3D> {
    let painted = this.#painted.get(owner);
    if (!painted) {
      painted = new Set();
      this.#painted.set(owner, painted);
    }
    return painted;
  }

  #paletteTexture(): WebGLTexture {
    const gl = this.#gl;
    if (!this.#palette) {
      this.#palette = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, this.#palette);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    return this.#palette;
  }

  /** Writes a layer's colors into the palette texture, bound at unit 0. */
  #writePalette(context: CanvasRenderingContext2D, palette: readonly string[]): void {
    if (palette.length === 0) return;
    const key = palette.join();
    let bytes = this.#palettes.get(key);
    if (!bytes) {
      bytes = new Uint8Array(palette.length * 4);
      for (const [i, color] of palette.entries()) {
        const [r, g, b] = rgba(context, color);
        bytes.set([Math.round(r * 255), Math.round(g * 255), Math.round(b * 255), 255], i * 4);
      }
      if (this.#palettes.size >= 32) this.#palettes.clear();
      this.#palettes.set(key, bytes);
    }
    const gl = this.#gl;
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, palette.length, 1, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
  }

  /** The vertex array of 3D layers, with both attributes enabled; buffers are bound per layer. */
  #vertexArray(): WebGLVertexArrayObject {
    const gl = this.#gl;
    if (!this.#vao) {
      this.#vao = gl.createVertexArray()!;
      gl.bindVertexArray(this.#vao);
      this.#attributes = {
        value: gl.getAttribLocation(this.#program, "value"),
        style: gl.getAttribLocation(this.#program, "style"),
      };
      gl.enableVertexAttribArray(this.#attributes.value);
      gl.enableVertexAttribArray(this.#attributes.style);
      gl.bindVertexArray(null);
    }
    return this.#vao;
  }

  /**
   * A 3D layer's values on the GPU, uploaded again when its columns, their
   * version, or the axes' log flags change, or when points in the box would
   * be off by more than a quarter pixel, or out of float32's range, as the
   * axes map them now (a domain changed, or the first upload's was elsewhere).
   */
  #uploadValues(layer: CloudLayer3D, axes: readonly Mapping[], pixel: number): Values3D {
    const logs = axes.map((axis) => axis.log).join();
    const uploads = this.#values.get(layer.z) ?? [];
    // An axis' domain center, in its units, and how far from it its domain reaches.
    const center = axes.map((axis) => axis.origin - axis.offset / axis.factor);
    const reach = axes.map((axis) => 1 / Math.abs(axis.factor));
    const precise = (upload: Values3D) =>
      upload.origins.every((origin, k) => {
        const factor = Math.abs(axes[k]!.factor);
        const ratio = factor / Math.abs(upload.factors[k]!);
        return (
          ratio > RATIO_RANGE ** -1 &&
          ratio < RATIO_RANGE &&
          (Math.abs(center[k]! - origin) + reach[k]!) * FLOAT32_ERROR * factor < pixel / 4
        );
      });
    const index = uploads.findIndex(
      (upload) => upload.x === layer.x && upload.y === layer.y && upload.logs === logs,
    );
    const cached = index >= 0 ? uploads[index] : undefined;
    if (cached && cached.version === layer.version && precise(cached)) return cached;
    const owners = cached?.owners ?? new Set<object>();
    if (cached) this.#discardValues(layer.z, cached);
    const gl = this.#gl;
    const length = Math.min(layer.x.length, layer.y.length, layer.z.length, layer.style.length);
    const columns = [layer.x, layer.y, layer.z];
    const origins = center.map((c) => (Number.isFinite(c) ? c : 0)) as [number, number, number];
    const factors = axes.map((axis) => axis.factor) as [number, number, number];
    const data = new Float32Array(length * 3);
    for (let k = 0; k < 3; k++) {
      const column = columns[k]!;
      const log = axes[k]!.log;
      const origin = origins[k]!;
      const factor = factors[k]!;
      for (let i = 0; i < length; i++) {
        const v = ((log ? Math.log10(column[i]!) : column[i]!) - origin) * factor;
        data[i * 3 + k] = Math.abs(v) < MISSING ? v : MISSING;
      }
    }
    const buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const upload: Values3D = {
      x: layer.x,
      y: layer.y,
      z: layer.z,
      version: layer.version,
      logs,
      origins,
      factors,
      length,
      buffer,
      bytes: data.byteLength,
      owners,
    };
    const list = this.#values.get(layer.z) ?? [];
    list.push(upload);
    this.#values.set(layer.z, list);
    this.#bytes += upload.bytes;
    return upload;
  }

  /** A 3D layer's colors on the GPU: one upload per color array, which a layer replaces when they change. */
  #uploadStyles(style: Uint8Array, length: number): Styles3D {
    const cached = this.#styles.get(style);
    if (cached) return cached;
    const gl = this.#gl;
    const buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, style.subarray(0, length), gl.STATIC_DRAW);
    const upload: Styles3D = { buffer, bytes: length, owners: new Set() };
    this.#styles.set(style, upload);
    this.#bytes += upload.bytes;
    return upload;
  }

  #discardValues(z: object, upload: Values3D): void {
    this.#gl.deleteBuffer(upload.buffer);
    const list = this.#values.get(z)?.filter((other) => other !== upload) ?? [];
    if (list.length > 0) this.#values.set(z, list);
    else this.#values.delete(z);
    this.#bytes -= upload.bytes;
    for (const painted of this.#painted.values()) painted.delete(upload);
  }

  #discardStyles(style: Uint8Array, upload: Styles3D): void {
    this.#gl.deleteBuffer(upload.buffer);
    this.#styles.delete(style);
    this.#bytes -= upload.bytes;
    for (const painted of this.#painted.values()) painted.delete(upload);
  }

  endFrame(owner: object): void {
    const painted = this.#painted.get(owner);
    for (const [z, uploads] of this.#values) {
      for (const upload of uploads) {
        if (!upload.owners.has(owner) || painted?.has(upload)) continue;
        upload.owners.delete(owner);
        if (upload.owners.size === 0) this.#discardValues(z, upload);
      }
    }
    for (const [style, upload] of this.#styles) {
      if (!upload.owners.has(owner) || painted?.has(upload)) continue;
      upload.owners.delete(owner);
      if (upload.owners.size === 0) this.#discardStyles(style, upload);
    }
    this.#painted.delete(owner);
  }

  release(owner: object): void {
    this.#painted.delete(owner);
    this.endFrame(owner);
  }
}
