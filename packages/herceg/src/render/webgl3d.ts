// Draws 3D charts with WebGL2: points as sprites, lines as ribbons, and
// surfaces' cells as triangles, all into one depth buffer, so what is nearer
// covers what is farther whatever order the layers come in. The page's
// cloud painter (render/webgl.ts) loads this module when a 3D chart needs it
// and lends it its context, so 2D charts never download it.

import type { NumericArray } from "../data/column.ts";
import type { Mapping } from "../lod/m4.ts";
import type {
  Batches3D,
  FaceGeometry,
  LineBatch3D,
  PointBatch3D,
  Rect,
  TriangleBatch3D,
} from "../scene/scene.ts";
import { type DeepClouds, type Gpu, link, MISSING, rgba } from "./webgl.ts";

// A point at normalized coordinates u in clip space, where View.project puts
// it on screen. In perspective w is the eye's distance to it over the
// distance to the box's center, and depth is affine in 1/w, so the GPU's
// interpolation across triangles and ribbons is exact; nearer is lower.
const PLACE = `
uniform vec2 right;
uniform vec3 up;
uniform vec3 toward;
uniform vec2 center;
uniform vec2 plot;
uniform float scale;
uniform float distance;
vec4 place(vec3 u) {
  float depth = dot(u, toward);
  float w = distance > 0.0 ? (distance - depth) / distance : 1.0;
  vec2 origin = vec2(center.x / plot.x * 2.0 - 1.0, 1.0 - center.y / plot.y * 2.0);
  vec2 offset = vec2(dot(u.xy, right), dot(u, up)) * scale * 2.0 / plot;
  float z = distance > 0.0 ? 1.5 * w - 1.5 : -0.5 * depth;
  return vec4(origin * w + offset, z, w);
}`;

// Each value in the box's units as the axes mapped it when uploaded (log10
// units on log axes), placed in the box as they map it now. Points outside
// the box, missing values (the sentinel), and rows not drawn (style 255) are
// moved off the screen. Square sprites' corners are discarded, so they never
// hide what is behind them in the depth buffer.
const POINTS_VERTEX = `#version 300 es
layout(location = 0) in vec3 value;
layout(location = 1) in float style;
uniform vec3 factor;
uniform vec3 shift;
uniform float size;
uniform sampler2D palette;
out vec4 color;
${PLACE}
void main() {
  vec3 u = value * factor + shift;
  if (style > 254.5 || any(greaterThan(abs(u), vec3(1.000001)))) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }
  gl_Position = place(u);
  gl_PointSize = size;
  color = texelFetch(palette, ivec2(int(style), 0), 0);
}`;

const POINTS_FRAGMENT = `#version 300 es
precision highp float;
in vec4 color;
uniform float size;
uniform float radius;
out vec4 fragment;
void main() {
  if (length(gl_PointCoord - 0.5) * size > radius + 0.5) discard;
  fragment = color;
}`;

// A cell's triangles take its color and normal from their last vertex. The
// light is the CPU's; facing it is cut into the same levels, and the
// palette holds each color at each level as the CPU shades it.
const TRIANGLES_VERTEX = `#version 300 es
layout(location = 0) in vec3 position;
layout(location = 1) in vec3 normal;
layout(location = 2) in float color;
uniform vec3 light;
uniform float levels;
flat out ivec2 shade;
${PLACE}
void main() {
  gl_Position = place(position);
  float level = 0.0;
  if (levels > 1.0)
    level = dot(normal, normal) > 0.0
      ? min(levels - 1.0, floor(abs(dot(normal, light)) * (levels - 1.0) + 0.5))
      : levels - 1.0;
  shade = ivec2(int(color), int(level));
}`;

const TRIANGLES_FRAGMENT = `#version 300 es
precision highp float;
flat in ivec2 shade;
uniform sampler2D palette;
out vec4 fragment;
void main() {
  fragment = texelFetch(palette, shade, 0);
}`;

// One instance per segment, from point `from` to the next (`to`), both in
// the box (the batch cut segments at its walls). Its quad reaches half a
// width past both ends; fragments farther than that from the segment are
// discarded, which rounds the caps and the joins. Depth is the segment's at
// the nearest point along it, so the caps keep their end's depth and the
// rest interpolates exactly.
const LINES_VERTEX = `#version 300 es
layout(location = 0) in vec3 from;
layout(location = 1) in vec3 to;
layout(location = 2) in float style;
uniform float halfWidth;
uniform sampler2D palette;
flat out vec4 color;
flat out vec4 ends;
flat out vec2 depths;
${PLACE}
void main() {
  if (style > 254.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec4 a = place(from);
  vec4 b = place(to);
  vec2 pa = (a.xy / a.w * 0.5 + 0.5) * plot;
  vec2 pb = (b.xy / b.w * 0.5 + 0.5) * plot;
  vec2 along = pb - pa;
  float span = sqrt(dot(along, along));
  vec2 tangent = span > 1e-6 ? along / span : vec2(1.0, 0.0);
  vec2 normal = vec2(-tangent.y, tangent.x);
  bool atEnd = gl_VertexID >= 2;
  float side = (gl_VertexID == 1 || gl_VertexID == 3) ? 1.0 : -1.0;
  vec2 p = (atEnd ? pb + tangent * halfWidth : pa - tangent * halfWidth) + normal * side * halfWidth;
  vec4 e = atEnd ? b : a;
  gl_Position = vec4((p / plot * 2.0 - 1.0) * e.w, e.z, e.w);
  color = texelFetch(palette, ivec2(int(style), 0), 0);
  ends = vec4(pa, pb);
  depths = vec2(a.z / a.w, b.z / b.w);
}`;

const LINES_FRAGMENT = `#version 300 es
precision highp float;
flat in vec4 color;
flat in vec4 ends;
flat in vec2 depths;
uniform float halfWidth;
out vec4 fragment;
void main() {
  vec2 p = gl_FragCoord.xy;
  vec2 d = ends.zw - ends.xy;
  float l2 = dot(d, d);
  float s = l2 > 1e-6 ? clamp(dot(p - ends.xy, d) / l2, 0.0, 1.0) : 0.0;
  vec2 q = p - (ends.xy + d * s);
  if (dot(q, q) > halfWidth * halfWidth) discard;
  // Seen end on, a segment shows its nearer end.
  float z = l2 > 1e-6 ? mix(depths.x, depths.y, s) : min(depths.x, depths.y);
  gl_FragDepth = z * 0.5 + 0.5;
  fragment = color;
}`;

/** What a chart holds on the GPU: released when no chart painted it in its last frame. */
interface Held {
  owners: Set<object>;
  bytes: number;
}

/**
 * A point layer's columns on the GPU, as float32: each value (log10 units
 * on log axes) less its axis' origin, times its factor. The origins are the
 * centers of the axes' domains when uploaded, so values of any magnitude in
 * the box come out near [-1, 1] and keep their precision.
 */
interface Values3D extends Held {
  x: NumericArray;
  y: NumericArray;
  z: NumericArray;
  version: number;
  logs: string;
  origins: [number, number, number];
  factors: [number, number, number];
  length: number;
  buffer: WebGLBuffer;
}

/** A point layer's color index per row. */
interface Styles3D extends Held {
  buffer: WebGLBuffer;
}

/** A batch of triangles: positions, normals, colors, and indices. */
interface Mesh3D extends Held {
  vao: WebGLVertexArrayObject;
  buffers: WebGLBuffer[];
  count: number;
  type: number;
}

/** A batch of lines: its points' positions and styles. */
interface Path3D extends Held {
  buffers: [WebGLBuffer, WebGLBuffer];
  points: number;
}

/** Float32 keeps 24 bits; positions in the box may be off by this share of their distance from the origin. */
const FLOAT32_ERROR = 2 ** -24;
/**
 * The most a point may be off in the box's units, beside a quarter pixel:
 * well inside the steps of the depth buffer surfaces are drawn back by
 * (TriangleBatch3D.behind), so points lying on a surface stay over it.
 */
const DEPTH_ERROR = 2e-7;
/** How far an axis' factor may move from the one values were uploaded with before they are uploaded again. */
const RATIO_RANGE = 1e6;
/** Rows of the palette texture: shading levels of triangles' colors (points and lines read the first). */
const PALETTE_ROWS = 16;

/** A painter of 3D charts on `gpu`'s context; its programs link when first needed. */
export function deepClouds(gpu: Gpu): DeepClouds {
  return new DeepPainter(gpu);
}

const PLACE_UNIFORMS = ["right", "up", "toward", "center", "plot", "scale", "distance"];

/** A linked program and its uniforms. */
interface Program {
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

class DeepPainter implements DeepClouds {
  readonly #gpu: Gpu;
  readonly #gl: WebGL2RenderingContext;
  /** Programs by kind once linked; null for one that does not link. */
  readonly #programs = new Map<string, Program | null>();
  /** Point layers' values by their z column (layers sharing it may differ in x and y). */
  readonly #values = new Map<object, Values3D[]>();
  readonly #styles = new Map<Uint8Array, Styles3D>();
  readonly #meshes = new Map<object, Mesh3D>();
  readonly #paths = new Map<object, Path3D>();
  #pointArray: WebGLVertexArrayObject | undefined;
  #lineArray: WebGLVertexArrayObject | undefined;
  /** Palettes as RGBA bytes, by their colors. */
  readonly #palettes = new Map<string, Uint8Array>();
  #palette: WebGLTexture | undefined;
  /** Uploads each chart painted since its last `endFrame`. */
  readonly #painted = new Map<object, Set<Held>>();
  #bytes = 0;

  constructor(gpu: Gpu) {
    this.#gpu = gpu;
    this.#gl = gpu.gl;
  }

  get bytes(): number {
    return this.#bytes;
  }

  #program(kind: Batches3D["batches"][number]["kind"]): Program | null {
    let held = this.#programs.get(kind);
    if (held !== undefined) return held;
    const gl = this.#gl;
    const [vertex, fragment, own] =
      kind === "points"
        ? [POINTS_VERTEX, POINTS_FRAGMENT, ["factor", "shift", "size", "radius", "palette"]]
        : kind === "triangles"
          ? [TRIANGLES_VERTEX, TRIANGLES_FRAGMENT, ["light", "levels", "palette"]]
          : [LINES_VERTEX, LINES_FRAGMENT, ["halfWidth", "palette"]];
    const program = link(gl, vertex, fragment);
    held = program && {
      program,
      uniforms: Object.fromEntries(
        [...PLACE_UNIFORMS, ...own].map((name) => [name, gl.getUniformLocation(program, name)]),
      ),
    };
    this.#programs.set(kind, held);
    return held;
  }

  paint(
    context: CanvasRenderingContext2D,
    mark: FaceGeometry,
    plot: Rect,
    pixelRatio: number,
    owner: object,
  ): boolean {
    const scene = mark.batches;
    if (!scene) return false;
    const points = scene.batches.filter((batch): batch is PointBatch3D => batch.kind === "points");
    // Sprites larger than the device allows would be cut off.
    if (points.some((layer) => 2 * layer.radius * pixelRatio + 2 > this.#gpu.maxPointSize))
      return false;
    // Points on axes mapping no finite range of values are drawn on the CPU.
    const axes = scene.axes;
    if (
      points.length > 0 &&
      !axes?.every(
        (axis) => Number.isFinite(axis.factor) && axis.factor !== 0 && Number.isFinite(axis.origin),
      )
    )
      return false;
    if (scene.batches.some((batch) => !this.#program(batch.kind))) return false;
    const gl = this.#gl;
    const [width, height] = this.#gpu.fit(plot, pixelRatio);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    // Of things at one depth the later shows, as on the CPU and to the pointer.
    gl.depthFunc(gl.LEQUAL);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.#paletteTexture());
    const painted = this.#paintedBy(owner);
    const view = { scene, plot, pixelRatio, width, height };
    for (const batch of scene.batches) {
      const program = this.#program(batch.kind)!;
      gl.useProgram(program.program);
      this.#place(program, view);
      gl.uniform1i(program.uniforms.palette!, 0);
      if (batch.kind === "points") this.#points(context, program, batch, axes!, view, painted);
      else if (batch.kind === "triangles") this.#triangles(program, batch, scene, painted);
      else this.#lines(context, program, batch, pixelRatio, painted);
      gl.bindVertexArray(null);
    }
    for (const held of painted) held.owners.add(owner);
    gl.disable(gl.DEPTH_TEST);
    context.drawImage(this.#gpu.canvas, plot.x, plot.y, plot.width, plot.height);
    return true;
  }

  /** Sets the uniforms placing points of the box on the canvas. */
  #place({ uniforms: u }: Program, { scene, plot, pixelRatio, width, height }: PaintView): void {
    const gl = this.#gl;
    const m = scene.view;
    gl.uniform2f(u.right!, m[0]!, m[1]!);
    gl.uniform3f(u.up!, m[2]!, m[3]!, m[4]!);
    gl.uniform3f(u.toward!, m[5]!, m[6]!, m[7]!);
    gl.uniform2f(u.center!, (scene.cx - plot.x) * pixelRatio, (scene.cy - plot.y) * pixelRatio);
    gl.uniform2f(u.plot!, width, height);
    gl.uniform1f(u.scale!, scene.scale * pixelRatio);
    gl.uniform1f(u.distance!, Number.isFinite(scene.distance) ? scene.distance : 0);
  }

  #points(
    context: CanvasRenderingContext2D,
    { uniforms: u }: Program,
    layer: PointBatch3D,
    axes: readonly Mapping[],
    { scene, pixelRatio }: PaintView,
    painted: Set<Held>,
  ): void {
    const gl = this.#gl;
    gl.bindVertexArray(this.#pointVertexArray());
    // A pixel's worth of the box's units at the scale drawn.
    const pixel = 1 / Math.max(1e-9, scene.scale * pixelRatio);
    const values = this.#uploadValues(layer, axes, pixel);
    const styles = this.#uploadStyles(layer.style, values.length);
    painted.add(values);
    painted.add(styles);
    const factor = axes.map((axis, k) => axis.factor / values.factors[k]!);
    const shift = axes.map(
      (axis, k) => axis.offset + (values.origins[k]! - axis.origin) * axis.factor,
    );
    gl.uniform3f(u.factor!, factor[0]!, factor[1]!, factor[2]!);
    gl.uniform3f(u.shift!, shift[0]!, shift[1]!, shift[2]!);
    const radius = layer.radius * pixelRatio;
    gl.uniform1f(u.size!, 2 * radius + 2);
    gl.uniform1f(u.radius!, radius);
    this.#writePalette(context, layer.palette);
    gl.bindBuffer(gl.ARRAY_BUFFER, values.buffer);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, styles.buffer);
    gl.vertexAttribPointer(1, 1, gl.UNSIGNED_BYTE, false, 0, 0);
    gl.drawArrays(gl.POINTS, 0, values.length);
  }

  #triangles(
    { uniforms: u }: Program,
    batch: TriangleBatch3D,
    scene: Batches3D,
    painted: Set<Held>,
  ): void {
    const gl = this.#gl;
    const mesh = this.#uploadMesh(batch);
    painted.add(mesh);
    if (mesh.count === 0) return;
    const [lx, ly, lz] = scene.light;
    gl.uniform3f(u.light!, lx, ly, lz);
    gl.uniform1f(u.levels!, batch.levels);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      256,
      batch.levels,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      batch.shades,
    );
    gl.bindVertexArray(mesh.vao);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(0, batch.behind);
    gl.drawElements(gl.TRIANGLES, mesh.count, mesh.type, 0);
    gl.disable(gl.POLYGON_OFFSET_FILL);
  }

  #lines(
    context: CanvasRenderingContext2D,
    { uniforms: u }: Program,
    batch: LineBatch3D,
    pixelRatio: number,
    painted: Set<Held>,
  ): void {
    const gl = this.#gl;
    const path = this.#uploadPath(batch);
    painted.add(path);
    if (path.points < 2) return;
    gl.uniform1f(u.halfWidth!, (batch.width * pixelRatio) / 2);
    this.#writePalette(context, batch.palette);
    gl.bindVertexArray(this.#lineVertexArray());
    // Instance i reads point i as its start and point i + 1 as its end.
    gl.bindBuffer(gl.ARRAY_BUFFER, path.buffers[0]);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 12);
    gl.bindBuffer(gl.ARRAY_BUFFER, path.buffers[1]);
    gl.vertexAttribPointer(2, 1, gl.UNSIGNED_BYTE, false, 0, 0);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, path.points - 1);
  }

  #paintedBy(owner: object): Set<Held> {
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
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8,
        256,
        PALETTE_ROWS,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        null,
      );
    }
    return this.#palette;
  }

  /** Writes a layer's colors into the palette texture's first row, bound at unit 0. */
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

  /** The vertex array of point layers, with both attributes enabled; buffers are bound per layer. */
  #pointVertexArray(): WebGLVertexArrayObject {
    const gl = this.#gl;
    if (!this.#pointArray) {
      this.#pointArray = gl.createVertexArray()!;
      gl.bindVertexArray(this.#pointArray);
      gl.enableVertexAttribArray(0);
      gl.enableVertexAttribArray(1);
    }
    return this.#pointArray;
  }

  /** The vertex array of line layers: each instance a segment, its corners from the vertex index. */
  #lineVertexArray(): WebGLVertexArrayObject {
    const gl = this.#gl;
    if (!this.#lineArray) {
      this.#lineArray = gl.createVertexArray()!;
      gl.bindVertexArray(this.#lineArray);
      for (const location of [0, 1, 2]) {
        gl.enableVertexAttribArray(location);
        gl.vertexAttribDivisor(location, 1);
      }
    }
    return this.#lineArray;
  }

  /**
   * A point layer's values on the GPU, uploaded again when its columns,
   * their version, or the axes' log flags change, or when points in the box
   * would be off by more than a quarter pixel or DEPTH_ERROR, or out of
   * float32's range, as the axes map them now (a domain changed, or the
   * first upload's was elsewhere).
   */
  #uploadValues(layer: PointBatch3D, axes: readonly Mapping[], pixel: number): Values3D {
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
          (Math.abs(center[k]! - origin) + reach[k]!) * FLOAT32_ERROR * factor <
            Math.min(pixel / 4, DEPTH_ERROR)
        );
      });
    const same = (upload: Values3D) =>
      upload.x === layer.x && upload.y === layer.y && upload.logs === logs;
    // Charts drawing these columns on domains far apart each keep one placed
    // for theirs; uploads no chart painted in its last frame are released then.
    const current = uploads.find(
      (upload) => same(upload) && upload.version === layer.version && precise(upload),
    );
    if (current) return current;
    // Uploads of an older version of the columns no chart paints again.
    for (const upload of uploads)
      if (same(upload) && upload.version !== layer.version) this.#discardValues(layer.z, upload);
    const owners = new Set<object>();
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

  /** A layer's colors on the GPU: one upload per color array, which a layer replaces when they change. */
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

  /** A batch of triangles on the GPU, built and uploaded once per batch key. */
  #uploadMesh(batch: TriangleBatch3D): Mesh3D {
    const cached = this.#meshes.get(batch.key);
    if (cached) return cached;
    const gl = this.#gl;
    const { positions, normals, colors, indices } = batch.arrays();
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    // At the locations the program gives position, normal, and color.
    const buffers = (
      [
        [positions, 3, gl.FLOAT],
        [normals, 3, gl.FLOAT],
        [colors, 1, gl.UNSIGNED_BYTE],
      ] as const
    ).map(([data, size, type], location) => {
      const buffer = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, type, false, 0, 0);
      return buffer;
    });
    const elements = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, elements);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    buffers.push(elements);
    gl.bindVertexArray(null);
    const mesh: Mesh3D = {
      vao,
      buffers,
      count: indices.length,
      type: indices instanceof Uint16Array ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT,
      bytes: positions.byteLength + normals.byteLength + colors.byteLength + indices.byteLength,
      owners: new Set(),
    };
    this.#meshes.set(batch.key, mesh);
    this.#bytes += mesh.bytes;
    return mesh;
  }

  /** A batch of lines on the GPU, built and uploaded once per batch key. */
  #uploadPath(batch: LineBatch3D): Path3D {
    const cached = this.#paths.get(batch.key);
    if (cached) return cached;
    const gl = this.#gl;
    const { positions, style } = batch.arrays();
    const buffers = [positions, style].map((data) => {
      const buffer = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      return buffer;
    }) as [WebGLBuffer, WebGLBuffer];
    const path: Path3D = {
      buffers,
      points: style.length,
      bytes: positions.byteLength + style.byteLength,
      owners: new Set(),
    };
    this.#paths.set(batch.key, path);
    this.#bytes += path.bytes;
    return path;
  }

  #discardValues(z: object, upload: Values3D): void {
    this.#gl.deleteBuffer(upload.buffer);
    const list = this.#values.get(z)?.filter((other) => other !== upload) ?? [];
    if (list.length > 0) this.#values.set(z, list);
    else this.#values.delete(z);
    this.#forget(upload);
  }

  /** Lets go of an upload whose buffers were deleted. */
  #forget(upload: Held): void {
    this.#bytes -= upload.bytes;
    for (const painted of this.#painted.values()) painted.delete(upload);
  }

  endFrame(owner: object): void {
    const painted = this.#painted.get(owner);
    // Whether `owner` lets go of an upload it did not paint this frame, and no other chart holds it.
    const released = (upload: Held) => {
      if (!upload.owners.has(owner) || painted?.has(upload)) return false;
      upload.owners.delete(owner);
      return upload.owners.size === 0;
    };
    const gl = this.#gl;
    for (const [z, uploads] of this.#values)
      for (const upload of uploads) if (released(upload)) this.#discardValues(z, upload);
    for (const [style, upload] of this.#styles)
      if (released(upload)) {
        gl.deleteBuffer(upload.buffer);
        this.#styles.delete(style);
        this.#forget(upload);
      }
    for (const [key, mesh] of this.#meshes)
      if (released(mesh)) {
        for (const buffer of mesh.buffers) gl.deleteBuffer(buffer);
        gl.deleteVertexArray(mesh.vao);
        this.#meshes.delete(key);
        this.#forget(mesh);
      }
    for (const [key, path] of this.#paths)
      if (released(path)) {
        for (const buffer of path.buffers) gl.deleteBuffer(buffer);
        this.#paths.delete(key);
        this.#forget(path);
      }
    this.#painted.delete(owner);
  }

  release(owner: object): void {
    this.#painted.delete(owner);
    this.endFrame(owner);
  }
}

/** What placing a scene on the canvas takes. */
interface PaintView {
  scene: Batches3D;
  plot: Rect;
  pixelRatio: number;
  width: number;
  height: number;
}
