// A surface over a grid in a 3D chart. Each row is a grid point: its x and
// y values pick a column and a row of the grid (numbers and times in
// order, categories in dictionary order), and its z value is the height
// there; when several rows land on one grid point, the last with a value
// wins. Each cell between four grid points with values is drawn as two
// triangles (split along the diagonal from its lowest x and y corner),
// and a cell with three is drawn as the one triangle they make, so holes
// in the data are holes in the surface. Cells are colored by the mean of
// their corners' values and shaded by how they face a light.

import type { NumberField, PositionField, Schema, Table } from "../data/table.ts";
import { symbolPath } from "../draw/symbols.ts";
import { formatNumber } from "../format/format.ts";
import { ItemViews } from "../model/item-views.ts";
import type { LegendEntry } from "../model/legend.ts";
import type { ChartConfig } from "../model/model.ts";
import { checkColorScale, checkRamp, rampOf, SequentialScale } from "../scale/color.ts";
import type { TriangleBatch3D } from "../scene/scene.ts";
import type { Frozen, SurfaceSpec } from "../spec/spec.ts";
import type { Theme } from "../theme.ts";
import { clipToBox } from "../three/clip.ts";
import { monotone, rayInBox, walkGrid } from "../three/hit.ts";
import { crossing, Traversal } from "../three/traversal.ts";
import type { LayoutFrame, LayoutItem, LayoutMark, LayoutResult } from "./layout-mark.ts";
import { definedFields } from "./line.ts";
import {
  type ChartMark,
  type ColorRamp,
  frozen,
  type GlyphKey,
  type MARK,
  requireField,
} from "./mark.ts";
import {
  type AxisData,
  axesKey,
  type FaceFrame3D,
  type Frame3D,
  findRow,
  type Hit3D,
  type Items3D,
  identityIn,
  inBox,
  joinLayers3D,
  type Layer3D,
  PerChart,
  type Placed3D,
  positiveExtent,
  type Ranker,
} from "./plot3d.ts";

export interface SurfaceOptions<S extends Schema> {
  /** Number, time, or category fields: each row's grid column and row. */
  x: PositionField<S>;
  y: PositionField<S>;
  /** Number field: the height at each grid point. */
  z: NumberField<S>;
  /** A number field coloring the surface in place of `z`. */
  color?: NumberField<S>;
  /** Colors from low to high values; the theme's ramp by default. */
  colors?: readonly string[];
  colorDomain?: readonly [number, number];
  colorMidpoint?: number;
  /** Default 1. */
  fillOpacity?: number;
  /** Shade cells by how they face a light above and behind the viewer; true by default. */
  shading?: boolean;
  /** Draw the grid's lines over the surface; false by default. */
  wireframe?: boolean;
  /** What the surface is, in tooltips; "Surface" by default. */
  label?: string;
  /** The subplot whose 3D box this layer shares. */
  panel?: string;
  id?: string;
}

/**
 * Grid points a surface holds at most, and draws at most without a GPU
 * painter (in SVG, PDF, and PNG exports, and charts without WebGL2): beyond
 * these, rows should be binned or aggregated first.
 */
export const MAX_GRID_POINTS = 1_048_576;
export const MAX_CPU_GRID_POINTS = 250_000;

/**
 * Steps of a GPU painter's depth buffer cells are drawn back by: points and
 * lines lying on a surface show over it, whatever the order of the layers,
 * as they do on the CPU, though float32 places them a step or two apart.
 */
const BEHIND = 8;
/** Shading steps: cells share a style per color and step, so faces of one color batch. */
const LEVELS = 16;
/** Light reaching cells facing away from it, and the most it adds facing it. */
const AMBIENT = 0.72;
const DIFFUSE = 0.38;
/** Width of the outline each opaque cell gets in its own color, closing antialiasing seams. */
const SEAM = 0.5;
const WIRE = 0.6;
/** A quad cell's triangles, by its corners: split along the diagonal from the first. */
const FAN = [
  [0, 1, 2],
  [0, 2, 3],
];

/** The grid a surface's table makes, rebuilt when the table changes. */
interface Grid {
  version: number;
  /** Per column (x) and row (y) of the grid: its number or time, or its category's code. */
  xs: Float64Array;
  ys: Float64Array;
  /** Category names per column or row, for category fields. */
  xNames: readonly string[] | undefined;
  yNames: readonly string[] | undefined;
  nx: number;
  ny: number;
  /** Per grid point (y * nx + x): the row whose value it shows, or -1. */
  row: Int32Array;
  /** Grid points with values, in grid order. */
  present: Uint32Array;
}

/**
 * Where a surface's grid points lie in one chart's box, and which the
 * keyboard reads: found once per chart for its axes and the table version.
 */
interface Reading {
  /** The table version and the axes' key it was found for. */
  key: string;
  version: number;
  /** Normalized position of each column and row, and height of each grid point (NaN without a value). */
  u: Float64Array;
  v: Float64Array;
  w: Float64Array;
  /** Grid points read, in grid order: those in the box, and grid points outside it at corners of cut cells drawn. */
  readable: Uint32Array;
  /** How many of them lie in the box. */
  inside: number;
  /** Grid points outside the box that are read: the normalized place of the cut cell's corner nearest each. */
  anchors: ReadonlyMap<number, readonly [number, number, number]>;
}

/** What a chart's last scene of a surface placed, reused from scene to scene. */
interface Scratch {
  /** Each grid point's vertex among the faces' vertices, or -1 where it is not drawn. */
  vertexOf: Int32Array;
  depth: Float64Array;
  traversal: Traversal | undefined;
}

/** A surface's cells for a GPU painter: the batch key, kept while the reading and the box's aspect stay. */
interface Mesh {
  reading: Reading;
  aspect: string;
  key: object;
  cells: number;
}

const readings = new PerChart<Reading>();
const scratches = new PerChart<Scratch>();
const meshes = new PerChart<Mesh>();

export class SurfaceMark implements Layer3D {
  declare readonly [MARK]: true;
  readonly layout = true;
  readonly views = ItemViews;
  readonly dimensions = 3;
  readonly spec: Frozen<SurfaceSpec>;
  readonly table: Table;
  readonly measure: string;
  #grid: Grid | undefined;
  #domain: { version: number; extent: readonly [number, number] | undefined } | undefined;
  /** The colors cells take on the GPU, and the ramp and shading they are for. */
  #shaded: { key: string; bytes: Uint8Array } | undefined;

  constructor(input: SurfaceSpec, table: Table) {
    this.spec = frozen(input);
    // Read from the copy: the caller may change what it passed.
    const spec = this.spec;
    requireField(table, spec.x, ["number", "time", "category"], "surface x");
    requireField(table, spec.y, ["number", "time", "category"], "surface y");
    requireField(table, spec.z, ["number"], "surface z");
    if (spec.color !== undefined) requireField(table, spec.color, ["number"], "surface color");
    if (Array.isArray(spec.colors)) checkRamp(spec.colors, "surface colors");
    checkColorScale(spec.colorDomain, spec.colorMidpoint, "surface");
    if (spec.fillOpacity !== undefined && !(spec.fillOpacity >= 0 && spec.fillOpacity <= 1))
      throw new RangeError(
        `surface fillOpacity: expected a number from 0 to 1; received ${spec.fillOpacity}`,
      );
    this.table = table;
    this.measure = spec.label ?? "Surface";
    // A table that cannot make a grid is a mistake now, not at the first draw.
    if (table.length > 0) this.#build();
  }

  join(
    marks: readonly LayoutMark[],
    config: ChartConfig,
    indices?: readonly number[],
    panel?: string,
  ): LayoutMark {
    return joinLayers3D(marks, config, indices, panel);
  }

  draw(frame: LayoutFrame): LayoutResult {
    return joinLayers3D([this], { marks: [this] }).draw(frame);
  }

  #build(): Grid {
    const { table, spec } = this;
    if (this.#grid?.version === table.version) return this.#grid;
    const [x, y] = [gridAxis(table, spec.x), gridAxis(table, spec.y)];
    const nx = x.values.length;
    const ny = y.values.length;
    if (nx * ny > MAX_GRID_POINTS)
      throw new RangeError(
        `surface x, y: expected at most ${MAX_GRID_POINTS.toLocaleString("en-US")} grid points; ${nx.toLocaleString("en-US")} values of "${spec.x}" by ${ny.toLocaleString("en-US")} of "${spec.y}" make ${(nx * ny).toLocaleString("en-US")}; bin or aggregate the rows first`,
      );
    const z = table.numbers(spec.z as never);
    const row = new Int32Array(nx * ny).fill(-1);
    for (let r = 0; r < table.length; r++) {
      const i = x.index(r);
      const j = y.index(r);
      if (i < 0 || j < 0 || !Number.isFinite(z[r]!)) continue;
      row[j * nx + i] = r;
    }
    let held = 0;
    for (let p = 0; p < row.length; p++) if (row[p]! >= 0) held++;
    const present = new Uint32Array(held);
    held = 0;
    for (let p = 0; p < row.length; p++) if (row[p]! >= 0) present[held++] = p;
    this.#grid = {
      version: table.version,
      xs: x.values,
      ys: y.values,
      xNames: x.names,
      yNames: y.names,
      nx,
      ny,
      row,
      present,
    };
    return this.#grid;
  }

  axisData(k: number, log: boolean): AxisData {
    const { spec, table } = this;
    const grid = this.#build();
    const field = k === 0 ? spec.x : k === 1 ? spec.y : spec.z;
    if (k < 2) {
      const names = k === 0 ? grid.xNames : grid.yNames;
      if (names) return { field, kind: "category", extent: undefined, categories: names };
      const values = k === 0 ? grid.xs : grid.ys;
      const kind = table.kind(field as never) === "time" ? "time" : "number";
      const extent = log
        ? positiveExtent(values)
        : values.length > 0
          ? ([values[0]!, values[values.length - 1]!] as const)
          : undefined;
      return { field, kind, extent };
    }
    // Heights of the grid points only: rows off the grid do not widen the axis.
    const z = table.numbers(spec.z as never);
    const heights = Float64Array.from(grid.present, (p) => z[grid.row[p]!]!);
    if (log) return { field, kind: "number", extent: positiveExtent(heights) };
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const h of heights) {
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
    return { field, kind: "number", extent: lo <= hi ? [lo, hi] : undefined };
  }

  /** The values that color the surface: `color`, or z. */
  #tones(): ArrayLike<number> {
    const { spec, table } = this;
    return table.numbers((spec.color ?? spec.z) as never);
  }

  /** The extent of the tones of the grid points with values, found once per table version. */
  #toneDomain(): readonly [number, number] | undefined {
    const grid = this.#build();
    if (this.#domain?.version === grid.version) return this.#domain.extent;
    const tones = this.#tones();
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const p of grid.present) {
      const t = tones[grid.row[p]!]!;
      if (t < lo) lo = t;
      if (t > hi) hi = t;
    }
    const extent = lo <= hi ? ([lo, hi] as const) : undefined;
    this.#domain = { version: grid.version, extent };
    return extent;
  }

  #scale(theme: Theme): SequentialScale | undefined {
    const { spec } = this;
    const domain = spec.colorDomain ?? this.#toneDomain();
    if (!domain) return undefined;
    const fallback = spec.colorMidpoint === undefined ? theme.sequential : theme.diverging;
    return new SequentialScale(domain, rampOf(spec.colors, fallback), spec.colorMidpoint);
  }

  /** Surfaces have no legend entries; their colors have a color legend. */
  legend(): LegendEntry[] {
    return [];
  }

  scales(theme: Theme): [ColorRamp[], GlyphKey[]] {
    const scale = this.#scale(theme);
    if (!scale) return [[], []];
    const { domain, midpoint } = scale;
    const title = this.spec.color ?? this.spec.z;
    return [[{ stops: scale.legendStops(), domain, midpoint, title }], []];
  }

  /** A cell's color value: the mean of its `m` corners' (grid points) tones; NaN when one is missing. */
  #cellTone(grid: Grid, tones: ArrayLike<number>, corners: Int32Array, m: number): number {
    let tone = 0;
    for (let k = 0; k < m; k++) tone += tones[grid.row[corners[k]!]!]!;
    let mean = tone / m;
    if (!Number.isFinite(mean)) {
      // Finite values near the largest overflow when summed: average their quarters.
      let quarters = 0;
      for (let k = 0; k < m; k++) quarters += tones[grid.row[corners[k]!]!]! / 4;
      mean = (quarters / m) * 4;
    }
    return mean;
  }

  /**
   * Where the grid points lie in this chart's box and which are read, found
   * once for its axes and the table version: those in the box, and those
   * outside it at the corners of drawn cells cut at its walls, read where
   * the cut cell's drawn corner nearest them is.
   */
  #reading(frame: Frame3D): Reading {
    const grid = this.#build();
    const { axes } = frame;
    const key = `${grid.version}|${axesKey(axes)}`;
    const held = readings.get(frame);
    if (held?.key === key) return held;
    const { nx, ny, present, row } = grid;
    const [ax, ay, az] = axes;
    const place = (
      axis: (typeof axes)[number],
      values: Float64Array,
      names: readonly string[] | undefined,
    ) =>
      Float64Array.from(values, (value, i) =>
        axis.place(names ? (axis.categories!.get(names[i]!) ?? Number.NaN) : value),
      );
    const u = place(ax, grid.xs, grid.xNames);
    const v = place(ay, grid.ys, grid.yNames);
    const w = new Float64Array(nx * ny).fill(Number.NaN);
    const z = this.table.numbers(this.spec.z as never);
    // Grid points the axes give no place (nonpositive values on log axes) are missing: NaN heights.
    // Usually every grid point with a value is in the box: they are read as they are held.
    let readable = present;
    let inside = 0;
    for (const [k, p] of present.entries()) {
      const i = p % nx;
      const j = (p - i) / nx;
      const height = az.place(z[row[p]!]!);
      const placed = Number.isFinite(u[i]!) && Number.isFinite(v[j]!) && Number.isFinite(height);
      if (placed) w[p] = height;
      if (placed && inBox(u[i]!, v[j]!, height)) {
        if (readable !== present) readable[inside] = p;
        inside++;
      } else if (readable === present) {
        // The first left out: those before it were all in.
        readable = new Uint32Array(present.length);
        readable.set(present.subarray(0, k));
      }
    }
    // Corners outside the box of the cells cut at its walls: each triangle
    // of a cell (as drawn whole) cut at the walls, its corners outside read
    // at the kept corner nearest them, from the first cell that keeps any.
    const anchors = new Map<number, readonly [number, number, number]>();
    const tones = this.#tones();
    const corners = new Int32Array(4);
    const clipped: number[] = [];
    const drawable = this.spec.colorDomain !== undefined || this.#toneDomain() !== undefined;
    for (let j = 0; drawable && j + 1 < ny; j++)
      for (let i = 0; i + 1 < nx; i++) {
        const a = j * nx + i;
        let m = 0;
        let out = false;
        for (const p of [a, a + 1, a + nx + 1, a + nx]) {
          if (Number.isNaN(w[p]!)) continue;
          corners[m++] = p;
          const pi = p % nx;
          out ||= !inBox(u[pi]!, v[(p - pi) / nx]!, w[p]!);
        }
        if (m < 3 || !out || !Number.isFinite(this.#cellTone(grid, tones, corners, m))) continue;
        for (const triangle of m === 4 ? FAN : [[0, 1, 2]]) {
          clipped.length = 0;
          for (const k of triangle) {
            const p = corners[k]!;
            const pi = p % nx;
            clipped.push(u[pi]!, v[(p - pi) / nx]!, w[p]!);
          }
          const kept = clipToBox(clipped);
          if (kept.length < 9) continue;
          for (let t = 0; t < triangle.length; t++) {
            const p = corners[triangle[t]!]!;
            const pi = p % nx;
            if (inBox(u[pi]!, v[(p - pi) / nx]!, w[p]!) || anchors.has(p)) continue;
            let nearest = 0;
            let best = Number.POSITIVE_INFINITY;
            for (let c = 0; c < kept.length; c += 3) {
              const d = Math.hypot(
                kept[c]! - clipped[t * 3]!,
                kept[c + 1]! - clipped[t * 3 + 1]!,
                kept[c + 2]! - clipped[t * 3 + 2]!,
              );
              if (d < best) {
                best = d;
                nearest = c;
              }
            }
            anchors.set(p, [kept[nearest]!, kept[nearest + 1]!, kept[nearest + 2]!]);
          }
        }
      }
    let read = readable === present ? present : readable.subarray(0, inside);
    if (anchors.size > 0) {
      // In grid order, the points outside among those inside.
      read = new Uint32Array(inside + anchors.size);
      read.set(readable.subarray(0, inside));
      let at = inside;
      for (const p of anchors.keys()) read[at++] = p;
      read.sort();
    }
    return readings.set(frame, {
      key,
      version: grid.version,
      u,
      v,
      w,
      readable: read,
      inside,
      anchors,
    });
  }

  /** This chart's scratch for the surface, sized for its grid. */
  #scratch(frame: Frame3D): Scratch {
    const { nx, ny } = this.#build();
    const held = scratches.get(frame);
    if (held && held.vertexOf.length === nx * ny) return held;
    return scratches.set(frame, {
      vertexOf: new Int32Array(nx * ny),
      depth: new Float64Array(nx * ny),
      traversal: undefined,
    });
  }

  ranker(frame: Frame3D): Ranker {
    const { u, v, w } = this.#reading(frame);
    const grid = this.#build();
    const scratch = this.#scratch(frame);
    scratch.traversal = new Traversal(u, v, frame.view);
    const traversal = scratch.traversal;
    return { key: (x, y, z) => traversal.pointKey(x, y, z, w, grid.nx), columns: u, rows: v };
  }

  /**
   * The cells for a GPU painter, as triangles taking their cell's color and
   * normal; undefined for what it does not draw (translucent cells, which
   * need drawing in order, wires, and grids whose columns or rows fall out
   * of order on a shared category axis, whose cells overlap).
   */
  batch(frame: Frame3D): TriangleBatch3D | undefined {
    const { spec } = this;
    if ((spec.fillOpacity ?? 1) < 1 || spec.wireframe) return undefined;
    const reading = this.#reading(frame);
    if (!monotone(reading.u) || !monotone(reading.v)) return undefined;
    const scale = this.#scale(frame.theme);
    const half = frame.view.half;
    const aspect = half.join();
    let mesh = meshes.get(frame);
    if (!mesh || mesh.reading !== reading || mesh.aspect !== aspect) {
      const cells = scale ? this.#cells(reading, () => {}) : 0;
      mesh = meshes.set(frame, { reading, aspect, key: {}, cells });
    }
    const shading = spec.shading ?? true;
    return {
      kind: "triangles",
      key: mesh.key,
      cells: mesh.cells,
      shades: this.#shades(scale, shading),
      levels: shading ? LEVELS : 1,
      behind: BEHIND,
      arrays: () => this.#mesh(reading, half, scale),
    };
  }

  /**
   * Calls `cell` with each cell drawn, in grid order: its first grid point,
   * its corners with values (`m` of `corners`), and its tone; how many.
   */
  #cells(
    reading: Reading,
    cell: (a: number, corners: Int32Array, m: number, tone: number) => void,
  ): number {
    const grid = this.#build();
    const { nx, ny } = grid;
    const { w } = reading;
    const tones = this.#tones();
    const corners = new Int32Array(4);
    let count = 0;
    for (let j = 0; j + 1 < ny; j++)
      for (let i = 0; i + 1 < nx; i++) {
        const a = j * nx + i;
        let m = 0;
        for (const p of [a, a + 1, a + nx + 1, a + nx]) if (!Number.isNaN(w[p]!)) corners[m++] = p;
        if (m < 3) continue;
        const tone = this.#cellTone(grid, tones, corners, m);
        if (!Number.isFinite(tone)) continue;
        cell(a, corners, m, tone);
        count++;
      }
    return count;
  }

  /** Each ramp color at each shading level, as RGBA bytes, kept while the ramp is the same. */
  #shades(scale: SequentialScale | undefined, shading: boolean): Uint8Array {
    const key = `${scale?.stops.join()}|${shading}`;
    if (this.#shaded?.key === key) return this.#shaded.bytes;
    const levels = shading ? LEVELS : 1;
    const bytes = new Uint8Array(256 * levels * 4);
    const ramp = scale ? scale.colors().map(rgbOf) : [];
    for (let level = 0; level < levels; level++) {
      const factor = shading ? AMBIENT + (DIFFUSE * level) / (LEVELS - 1) : 1;
      ramp.forEach((rgb, i) => {
        const at = (level * 256 + i) * 4;
        for (let c = 0; c < 3; c++) bytes[at + c] = shaded(rgb[c]!, factor);
        bytes[at + 3] = 255;
      });
    }
    this.#shaded = { key, bytes };
    return bytes;
  }

  /**
   * The cells as triangles over the grid's vertices: each takes its cell's
   * color and normal from its last vertex, the grid point after the cell's
   * last corner (column and row), where it has a value; three-corner cells
   * missing that corner, and the pieces of cells cut at the box's walls (cut
   * as the CPU cuts them), get vertices of their own.
   */
  #mesh(reading: Reading, half: readonly number[], scale: SequentialScale | undefined) {
    const grid = this.#build();
    // The batch was made for the reading's table version; a scene drawn later would show stale cells.
    if (grid.version !== reading.version)
      throw new Error("A surface's cells changed before they were drawn");
    const { nx, ny } = grid;
    const { u, v, w } = reading;
    const box = new Float64Array(12);
    const normal = new Float64Array(3);
    // Writes cell's normal (in the box's units, of the corners in `box`) into `normal`.
    const facing = (corners: Int32Array, m: number) => {
      for (let k = 0; k < m; k++) {
        const p = corners[k]!;
        const i = p % nx;
        box[k * 3] = u[i]! * half[0]!;
        box[k * 3 + 1] = v[(p - i) / nx]! * half[1]!;
        box[k * 3 + 2] = w[p]! * half[2]!;
      }
      cellNormal(box, m, normal);
    };
    let triangles = 0;
    let extra = 0;
    const inside = (p: number) => {
      const i = p % nx;
      return inBox(u[i]!, v[(p - i) / nx]!, w[p]!);
    };
    const whole = (corners: Int32Array, m: number) => {
      for (let k = 0; k < m; k++) if (!inside(corners[k]!)) return false;
      return true;
    };
    // Calls `piece` with each triangle of a cell (corners in `box`) cut at
    // the box's walls, as normalized polygons. Cut cells are few, so they
    // are cut once to count and again to write, and nothing is kept between.
    const clipped: number[] = [];
    const pieces = (m: number, piece: (kept: number[]) => void) => {
      for (const triangle of m === 4 ? FAN : [[0, 1, 2]]) {
        clipped.length = 0;
        for (const k of triangle)
          clipped.push(
            box[k * 3]! / half[0]!,
            box[k * 3 + 1]! / half[1]!,
            box[k * 3 + 2]! / half[2]!,
          );
        const kept = clipToBox(clipped);
        if (kept.length >= 9) piece(kept);
      }
    };
    this.#cells(reading, (a, corners, m) => {
      if (whole(corners, m)) {
        triangles += m - 2;
        if (m === 3 && Number.isNaN(w[a + nx + 1]!)) extra++;
        return;
      }
      facing(corners, m);
      pieces(m, (kept) => {
        extra += kept.length / 3;
        triangles += kept.length / 3 - 2;
      });
    });
    const points = nx * ny;
    const vertices = points + extra;
    const positions = new Float32Array(vertices * 3);
    const normals = new Float32Array(vertices * 3);
    const colors = new Uint8Array(vertices);
    // Index 65,535 restarts primitives in WebGL2.
    const indices =
      vertices < 65_535 ? new Uint16Array(triangles * 3) : new Uint32Array(triangles * 3);
    for (let p = 0; p < points; p++) {
      const i = p % nx;
      positions[p * 3] = u[i]!;
      positions[p * 3 + 1] = v[(p - i) / nx]!;
      positions[p * 3 + 2] = w[p]!;
    }
    let next = points;
    let at = 0;
    const attributes = (vertex: number, color: number) => {
      normals.set(normal, vertex * 3);
      colors[vertex] = color;
    };
    const triangle = (a: number, b: number, c: number) => {
      indices[at++] = a;
      indices[at++] = b;
      indices[at++] = c;
    };
    this.#cells(reading, (a, corners, m, tone) => {
      facing(corners, m);
      const color = scale!.index(tone);
      if (!whole(corners, m)) {
        // Each piece's vertices are its own, all carrying the cell's attributes.
        pieces(m, (kept) => {
          const first = next;
          for (let k = 0; k < kept.length; k += 3) {
            positions[next * 3] = kept[k]!;
            positions[next * 3 + 1] = kept[k + 1]!;
            positions[next * 3 + 2] = kept[k + 2]!;
            attributes(next++, color);
          }
          for (let k = first + 1; k + 1 < next; k++) triangle(first, k, k + 1);
        });
        return;
      }
      // The cell's attributes go on the grid point after its last column and row.
      const last = a + nx + 1;
      if (m === 4) {
        attributes(last, color);
        triangle(a, a + 1, last);
        triangle(a + nx, a, last);
        return;
      }
      const [p, q, r] = [corners[0]!, corners[1]!, corners[2]!];
      if (r === last) triangle(p, q, r);
      else if (q === last) triangle(r, p, q);
      else if (p === last) triangle(q, r, p);
      else {
        // Missing that grid point: a copy of a corner of its own carries them.
        positions.copyWithin(next * 3, r * 3, r * 3 + 3);
        attributes(next, color);
        triangle(p, q, next++);
        return;
      }
      attributes(last, color);
    });
    return { positions, normals, colors, indices };
  }

  /**
   * The grid point a GPU painter shows at (px, py): the pointer's ray is
   * walked through the cells it crosses in the box, nearest first, to the
   * first triangle it meets; the cell's corner nearest the pointer is read.
   */
  pick(frame: Frame3D, px: number, py: number): Hit3D | undefined {
    const reading = this.#reading(frame);
    if (!this.#scale(frame.theme)) return undefined;
    const { view } = frame;
    const { nx } = this.#build();
    const { u, v, w } = reading;
    const { origin, direction } = view.ray(px, py);
    const span = rayInBox(origin, direction);
    if (!span) return undefined;
    const tones = this.#tones();
    const grid = this.#build();
    const corners = new Int32Array(4);
    const place = (p: number) => {
      const i = p % nx;
      return [u[i]!, v[(p - i) / nx]!, w[p]!];
    };
    let nearest = Number.POSITIVE_INFINITY;
    let cell = -1;
    walkGrid(u, v, origin, direction, span[0], span[1], (i, j) => {
      const a = j * nx + i;
      let m = 0;
      for (const p of [a, a + 1, a + nx + 1, a + nx]) if (!Number.isNaN(w[p]!)) corners[m++] = p;
      if (m < 3 || !Number.isFinite(this.#cellTone(grid, tones, corners, m))) return false;
      for (const [p, q, r] of m === 4 ? FAN : [[0, 1, 2]]) {
        const t = crossing(
          origin,
          direction,
          place(corners[p!]!),
          place(corners[q!]!),
          place(corners[r!]!),
        );
        // Only what lies in the box is drawn.
        if (t >= span[0] - 1e-9 && t <= span[1] + 1e-9 && t < nearest) {
          nearest = t;
          cell = a;
        }
      }
      return cell >= 0;
    });
    if (cell < 0) return undefined;
    const item = this.#items(frame).itemOfCell(cell, px, py);
    const at = origin.map((o, k) => o + nearest * direction[k]!);
    return item && { item, depth: view.depth(at[0]!, at[1]!, at[2]!), behind: BEHIND };
  }

  place(frame: FaceFrame3D): Placed3D {
    const { view, faces, theme } = frame;
    const { spec } = this;
    const grid = this.#build();
    if (grid.nx * grid.ny > MAX_CPU_GRID_POINTS) {
      // Standing in for a GPU painter that lost its context, nothing is
      // drawn until a fresh one is.
      if (frame.lost) return { itemOfFace: () => undefined };
      throw new RangeError(
        `surface: ${(grid.nx * grid.ny).toLocaleString("en-US")} grid points draw only on the GPU, in the browser with WebGL2, opaque, without a wireframe, and with marks beside it the GPU draws (opaque, points no larger than it draws); SVG, PDF, and PNG exports, and charts drawn otherwise, draw at most ${MAX_CPU_GRID_POINTS.toLocaleString("en-US")}; bin or aggregate the rows first`,
      );
    }
    const { u, v, w } = this.#reading(frame);
    const scratch = this.#scratch(frame);
    const { nx, ny, present } = grid;
    const { vertexOf, depth } = scratch;
    const traversal = frame.rank ? scratch.traversal : undefined;
    const out = new Float64Array(2);
    // Grid points inside the box become vertices; the rest are left out,
    // and cells reaching past the box are cut at its walls.
    vertexOf.fill(-1);
    for (const p of present) {
      const i = p % nx;
      const j = (p - i) / nx;
      const [a, b, c] = [u[i]!, v[j]!, w[p]!];
      if (!inBox(a, b, c)) continue;
      depth[p] = view.project(a, b, c, out, 0);
      vertexOf[p] = faces.vertex(out[0]!, out[1]!, depth[p]!);
    }
    const scale = this.#scale(theme);
    const tones = this.#tones();
    const opacity = spec.fillOpacity ?? 1;
    const shading = spec.shading ?? true;
    const wire = spec.wireframe ? theme.axis : undefined;
    const ramp = scale ? scale.colors().map(rgbOf) : [];
    const styles = new Int32Array(ramp.length * LEVELS).fill(-1);
    // Cut cells are drawn as triangles: a wire around each would show their diagonals.
    const cutStyles = wire ? new Int32Array(ramp.length * LEVELS).fill(-1) : styles;
    const [ha, hb, hc] = view.half;
    const light = view.light;
    // A cell's corners with values (counterclockwise from its lowest x and y,
    // so the fan from the first splits it along that corner's diagonal), and
    // their positions in the box's units.
    const corners = new Int32Array(4);
    const box = new Float64Array(12);
    const clipped: number[] = [];
    for (let j = 0; scale && j + 1 < ny; j++) {
      for (let i = 0; i + 1 < nx; i++) {
        const a = j * nx + i;
        let m = 0;
        for (const p of [a, a + 1, a + nx + 1, a + nx]) if (!Number.isNaN(w[p]!)) corners[m++] = p;
        // Three corners make one triangle.
        if (m < 3) continue;
        let inside = true;
        for (let k = 0; k < m; k++) {
          const p = corners[k]!;
          inside &&= vertexOf[p]! >= 0;
          const pi = p % nx;
          box[k * 3] = u[pi]! * ha;
          box[k * 3 + 1] = v[(p - pi) / nx]! * hb;
          box[k * 3 + 2] = w[p]! * hc;
        }
        const index = scale.index(this.#cellTone(grid, tones, corners, m));
        if (index < 0) continue;
        const level = shading ? shadeLevel(box, m, light) : LEVELS - 1;
        let style = styles[index * LEVELS + level]!;
        if (style < 0) {
          const fill = shade(
            ramp[index]!,
            shading ? AMBIENT + (DIFFUSE * level) / (LEVELS - 1) : 1,
          );
          style = faces.styleOf(
            fill,
            opacity,
            0,
            wire ?? (opacity >= 1 ? fill : undefined),
            wire ? WIRE : SEAM,
          );
          styles[index * LEVELS + level] = style;
        }
        if (!inside && wire) {
          let cut = cutStyles[index * LEVELS + level]!;
          if (cut < 0) {
            const { fill } = faces.styles[style]!;
            cut = faces.styleOf(fill, opacity, 0, opacity >= 1 ? fill : undefined, SEAM);
            cutStyles[index * LEVELS + level] = cut;
          }
          style = cut;
        }
        const key = traversal ? traversal.cellKey(i, j) : 0;
        faces.begin();
        if (inside) {
          let sum = 0;
          for (let k = 0; k < m; k++) {
            faces.corner(vertexOf[corners[k]!]!);
            sum += depth[corners[k]!]!;
          }
          faces.face(style, key, sum / m, a);
          continue;
        }
        // Part of the cell lies outside the box: its triangles (as drawn
        // whole), each cut at the walls, so a cut keeps to the surface.
        for (const triangle of m === 4 ? FAN : [[0, 1, 2]]) {
          clipped.length = 0;
          for (const k of triangle)
            clipped.push(box[k * 3]! / ha, box[k * 3 + 1]! / hb, box[k * 3 + 2]! / hc);
          const kept = clipToBox(clipped);
          if (kept.length < 9) continue;
          faces.begin();
          let sum = 0;
          for (let k = 0; k < kept.length; k += 3) {
            const at = view.project(kept[k]!, kept[k + 1]!, kept[k + 2]!, out, 0);
            faces.corner(faces.vertex(out[0]!, out[1]!, at));
            sum += at;
          }
          faces.face(style, key, sum / (kept.length / 3), a);
        }
      }
    }
    let items: SurfaceItems | undefined;
    return {
      itemOfFace: (a, px, py) => {
        items ??= this.#items(frame);
        return items.itemOfCell(a, px, py);
      },
    };
  }

  items(frame: Frame3D): Items3D {
    return this.#items(frame);
  }

  #items(frame: Frame3D): SurfaceItems {
    const { spec, table } = this;
    const { axes, id, locale, view } = frame;
    const grid = this.#build();
    const reading = this.#reading(frame);
    const { readable, anchors, u, v, w } = reading;
    const count = readable.length;
    const { nx } = grid;
    const z = table.numbers(spec.z as never);
    const tones = spec.color === undefined ? undefined : table.numbers(spec.color as never);
    const scale = this.#scale(frame.theme);
    const offset = table.rowOffset;
    const out = new Float64Array(2);
    /** Where a read grid point is on screen: at its place, or (outside the box) its anchor's. */
    const screen = (p: number): [number, number] => {
      const i = p % nx;
      const anchor = anchors.get(p);
      if (anchor) view.project(anchor[0], anchor[1], anchor[2], out, 0);
      else view.project(u[i]!, v[(p - i) / nx]!, w[p]!, out, 0);
      return [Math.fround(out[0]!), Math.fround(out[1]!)];
    };
    const coordinate = (k: number, p: number): number | string => {
      const i = p % nx;
      const j = (p - i) / nx;
      if (k === 2) return z[grid.row[p]!]!;
      const names = k === 0 ? grid.xNames : grid.yNames;
      const values = k === 0 ? grid.xs : grid.ys;
      const at = k === 0 ? i : j;
      return names ? names[at]! : values[at]!;
    };
    const fields = [spec.x, spec.y, spec.z];
    const itemOf = (index: number): LayoutItem => {
      const p = readable[index]!;
      const row = grid.row[p]!;
      const data: Record<string, number | string> = {};
      const parts = fields.map((field, k) => {
        const value = coordinate(k, p);
        data[field] = value;
        const text = typeof value === "string" ? value : axes[k]!.format(value);
        return `${axes[k]!.title || axes[k]!.name} ${text}`;
      });
      if (tones) {
        parts.push(`${spec.color} ${formatNumber(tones[row]!, locale)}`);
        data[spec.color!] = tones[row]!;
      }
      const [px, py] = screen(p);
      return {
        key: JSON.stringify([id, offset + row]),
        label: this.measure,
        color: scale ? scale.color((tones ?? z)[row]!) : frame.theme.muted,
        value: z[row]!,
        text: parts.join(", "),
        px,
        py,
        outline: symbolPath("circle", px, py, 4),
        measure: this.measure,
        values: data,
        row,
      };
    };
    const find = (p: number) => findRow(readable, count, p);
    return {
      count,
      item: itemOf,
      indexOf(key) {
        const identity = identityIn(key, id);
        if (identity === undefined) return -1;
        for (let k = 0; k < count; k++) if (grid.row[readable[k]!] === identity - offset) return k;
        return -1;
      },
      itemOfCell(a, px, py) {
        // The cell's corner nearest the pointer: those in the box first,
        // else (a cell cut at the walls) those read where the cut cell is.
        let best = -1;
        let drawn = false;
        let nearest = Number.POSITIVE_INFINITY;
        for (const p of [a, a + 1, a + nx + 1, a + nx]) {
          if (p >= w.length || Number.isNaN(w[p]!)) continue;
          const own = !anchors.has(p);
          if ((own && find(p) < 0) || (drawn && !own)) continue;
          const [x, y] = screen(p);
          const d = Math.hypot(x - px, y - py);
          if ((own && !drawn) || d < nearest) {
            nearest = d;
            best = p;
            drawn ||= own;
          }
        }
        const at = best < 0 ? -1 : find(best);
        return at < 0 ? undefined : itemOf(at);
      },
      summary: () => {
        const { nx, ny } = grid;
        const what = `Surface of ${spec.z} over ${spec.x} and ${spec.y}`;
        const held = grid.present.length;
        if (held === 0) return `${what}, with nothing to show.`;
        const cells = nx < 2 || ny < 2 ? " (one line of grid points makes no cells)" : "";
        const values = `${what}: ${nx} by ${ny} grid points, ${held} with values${cells}`;
        const { inside } = reading;
        const inBox =
          inside === held ? "" : `, ${inside === 0 ? "none" : inside} of them in the box`;
        if (count === 0) return `${values}${inBox}.`;
        let highest = readable[0]!;
        let lowest = readable[0]!;
        for (let k = 0; k < count; k++) {
          const p = readable[k]!;
          if (z[grid.row[p]!]! > z[grid.row[highest]!]!) highest = p;
          if (z[grid.row[p]!]! < z[grid.row[lowest]!]!) lowest = p;
        }
        const where = (p: number) =>
          `${axes[2]!.format(z[grid.row[p]!]!)} at ${[0, 1]
            .map((k) => {
              const value = coordinate(k, p);
              return typeof value === "string" ? value : axes[k]!.format(value);
            })
            .join(", ")}`;
        return `${values}${inBox}. Highest ${where(highest)}; lowest ${where(lowest)}.`;
      },
    };
  }
}

/**
 * The normal of a cell of `m` corners at `box` (x, y, z each, in the box's
 * units), written to `out` as a unit vector (zero for a degenerate cell):
 * across the diagonals of a quad, or along two sides of a triangle.
 */
function cellNormal(box: Float64Array, m: number, out: Float64Array): void {
  const [p, q, r, t] = m === 4 ? [0, 1, 2, 3] : [0, 0, 1, 2];
  const ax = box[r * 3]! - box[p * 3]!;
  const ay = box[r * 3 + 1]! - box[p * 3 + 1]!;
  const az = box[r * 3 + 2]! - box[p * 3 + 2]!;
  const bx = box[t * 3]! - box[q * 3]!;
  const by = box[t * 3 + 1]! - box[q * 3 + 1]!;
  const bz = box[t * 3 + 2]! - box[q * 3 + 2]!;
  const x = ay * bz - az * by;
  const y = az * bx - ax * bz;
  const z = ax * by - ay * bx;
  const length = Math.hypot(x, y, z);
  const ok = length > 0 && Number.isFinite(length);
  out[0] = ok ? x / length : 0;
  out[1] = ok ? y / length : 0;
  out[2] = ok ? z / length : 0;
}

/** A surface's items, and the item a cell shows. */
interface SurfaceItems extends Items3D {
  /** The read corner of cell `a` (by its first grid point) nearest the pointer. */
  itemOfCell(a: number, px: number, py: number): LayoutItem | undefined;
}

/**
 * The shading step of a cell of `m` corners at `box` (x, y, z each, in the
 * box's units): how squarely it faces `light`, either side, across the
 * diagonals of a quad or along two sides of a triangle.
 */
function shadeLevel(box: Float64Array, m: number, light: readonly number[]): number {
  const [p, q, r, t] = m === 4 ? [0, 1, 2, 3] : [0, 0, 1, 2];
  const ax = box[r * 3]! - box[p * 3]!;
  const ay = box[r * 3 + 1]! - box[p * 3 + 1]!;
  const az = box[r * 3 + 2]! - box[p * 3 + 2]!;
  const bx = box[t * 3]! - box[q * 3]!;
  const by = box[t * 3 + 1]! - box[q * 3 + 1]!;
  const bz = box[t * 3 + 2]! - box[q * 3 + 2]!;
  const crossX = ay * bz - az * by;
  const crossY = az * bx - ax * bz;
  const crossZ = ax * by - ay * bx;
  const length = Math.hypot(crossX, crossY, crossZ);
  const facing = Math.abs(crossX * light[0]! + crossY * light[1]! + crossZ * light[2]!) / length;
  return Number.isFinite(facing) ? Math.round(facing * (LEVELS - 1)) : LEVELS - 1;
}

function rgbOf(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** A color channel multiplied by `factor`. */
function shaded(channel: number, factor: number): number {
  return Math.min(255, Math.max(0, Math.round(channel * factor)));
}

/** A color with its channels multiplied by `factor`, as hex. */
function shade([r, g, b]: [number, number, number], factor: number): string {
  const c = (v: number) => shaded(v, factor);
  return `#${((1 << 24) | (c(r) << 16) | (c(g) << 8) | c(b)).toString(16).slice(1)}`;
}

/**
 * One axis of a grid from a field: its distinct numbers or times in order,
 * or the categories rows hold in dictionary order, and each row's place.
 */
function gridAxis(
  table: Table,
  field: string,
): { values: Float64Array; names: readonly string[] | undefined; index(row: number): number } {
  if (table.kind(field as never) === "category") {
    const { codes, dictionary } = table.categories(field as never);
    const held = new Uint8Array(dictionary.length);
    for (let row = 0; row < table.length; row++) if (codes[row]! >= 0) held[codes[row]!] = 1;
    const place = new Int32Array(dictionary.length).fill(-1);
    const names: string[] = [];
    for (let code = 0; code < dictionary.length; code++) {
      if (!held[code]) continue;
      place[code] = names.length;
      names.push(dictionary[code]!);
    }
    return {
      values: Float64Array.from(names, (_, i) => i),
      names,
      index: (row) => (codes[row]! >= 0 ? place[codes[row]!]! : -1),
    };
  }
  const numbers = table.numbers(field as never);
  const finite = new Float64Array(table.length);
  let n = 0;
  for (let row = 0; row < table.length; row++) {
    const value = numbers[row]!;
    if (Number.isFinite(value)) finite[n++] = value;
  }
  const sorted = finite.subarray(0, n).sort();
  let distinct = 0;
  for (let k = 0; k < n; k++)
    if (k === 0 || sorted[k] !== sorted[k - 1]) sorted[distinct++] = sorted[k]!;
  const values = sorted.slice(0, distinct);
  return {
    values,
    names: undefined,
    index(row) {
      const value = numbers[row]!;
      if (!Number.isFinite(value)) return -1;
      let lo = 0;
      let hi = values.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (values[mid]! < value) lo = mid + 1;
        else hi = mid;
      }
      return values[lo] === value ? lo : -1;
    },
  };
}

/**
 * A surface in a 3D chart over a grid of rows: each row's `x` and `y` (number,
 * time, or category fields) pick a grid point, and `z` is its height.
 *
 * ```ts
 * surface(terrain, { x: "east", y: "north", z: "elevation" })
 * ```
 */
export function surface<S extends Schema>(
  table: Table<S>,
  options: SurfaceOptions<S>,
): ChartMark<Frozen<SurfaceSpec>> {
  const spec: SurfaceSpec = {
    type: "surface",
    x: options.x,
    y: options.y,
    z: options.z,
    ...definedFields(options, [
      "color",
      "colorMidpoint",
      "fillOpacity",
      "shading",
      "wireframe",
      "label",
      "panel",
      "id",
    ]),
  };
  if (options.colors) spec.colors = [...options.colors];
  if (options.colorDomain) spec.colorDomain = [options.colorDomain[0], options.colorDomain[1]];
  if (table.name !== undefined) spec.data = table.name;
  // Field names were checked against S above; marks work on the erased schema.
  return new SurfaceMark(spec, table as unknown as Table);
}
