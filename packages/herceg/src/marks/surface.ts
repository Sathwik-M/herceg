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
import type { LegendEntry } from "../model/legend.ts";
import type { ChartConfig } from "../model/model.ts";
import { checkColorScale, checkRamp, rampOf, SequentialScale } from "../scale/color.ts";
import type { Frozen, SurfaceSpec } from "../spec/spec.ts";
import type { Theme } from "../theme.ts";
import type { View } from "../three/camera.ts";
import { clipToBox } from "../three/clip.ts";
import type { FaceBuffer } from "../three/faces.ts";
import { Traversal } from "../three/traversal.ts";
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
  type Frame3D,
  joinLayers3D,
  type Layer3D,
  type Placed3D,
  positiveExtent,
} from "./plot3d.ts";
import { identityIn } from "./point3d.ts";

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
  id?: string;
}

/** Grid points a surface draws at most: beyond this, rows should be binned or aggregated first. */
export const MAX_GRID_POINTS = 250_000;

/** Shading steps: cells share a style per color and step, so faces of one color batch. */
const LEVELS = 16;
/** Light reaching cells facing away from it, and the most it adds facing it. */
const AMBIENT = 0.72;
const DIFFUSE = 0.38;
/** Width of the outline each opaque cell gets in its own color, closing antialiasing seams. */
const SEAM = 0.5;
const WIRE = 0.6;
const EPSILON = 1e-9;
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

/** What a chart's last scene of a surface placed: kept per chart (by its faces) and reused. */
interface Scratch {
  view: View | undefined;
  /** Normalized position of each column and row, and height of each grid point (NaN without a value). */
  u: Float64Array;
  v: Float64Array;
  w: Float64Array;
  /** Each grid point's vertex among the faces' vertices, or -1 where it is not drawn. */
  vertexOf: Int32Array;
  depth: Float64Array;
  traversal: Traversal | undefined;
  /** Grid points the keyboard reads: those drawn, in grid order. */
  readable: Uint32Array;
}

const scratches = new WeakMap<FaceBuffer, Map<string | number, Scratch>>();

export class SurfaceMark implements Layer3D {
  declare readonly [MARK]: true;
  readonly layout = true;
  readonly dimensions = 3;
  readonly spec: Frozen<SurfaceSpec>;
  readonly table: Table;
  readonly measure: string;
  #grid: Grid | undefined;

  constructor(input: SurfaceSpec, table: Table) {
    this.spec = frozen(input);
    // Read from the copy: the caller may change what it passed.
    const spec = this.spec;
    requireField(table, spec.x, ["number", "time", "category"], "surface x");
    requireField(table, spec.y, ["number", "time", "category"], "surface y");
    requireField(table, spec.z, ["number"], "surface z");
    if (spec.color !== undefined) requireField(table, spec.color, ["number"], "surface color");
    if (Array.isArray(spec.colors)) checkRamp(spec.colors, "surface colors");
    checkColorScale(spec.colorDomain, spec.colorMidpoint, "Surface");
    if (spec.fillOpacity !== undefined && !(spec.fillOpacity >= 0 && spec.fillOpacity <= 1))
      throw new RangeError(`surface fillOpacity must be from 0 to 1, not ${spec.fillOpacity}`);
    this.table = table;
    this.measure = spec.label ?? "Surface";
    // A table that cannot make a grid is a mistake now, not at the first draw.
    if (table.length > 0) this.#build();
  }

  join(marks: readonly LayoutMark[], config: ChartConfig): LayoutMark {
    return joinLayers3D(marks, config);
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
        `A surface draws at most ${MAX_GRID_POINTS.toLocaleString("en-US")} grid points; ${nx.toLocaleString("en-US")} distinct values of ${spec.x} by ${ny.toLocaleString("en-US")} of ${spec.y} make ${(nx * ny).toLocaleString("en-US")}. Bin or aggregate the rows first`,
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

  #scale(theme: Theme): SequentialScale | undefined {
    const { spec } = this;
    let domain = spec.colorDomain;
    if (!domain) {
      const grid = this.#build();
      const tones = this.#tones();
      let lo = Number.POSITIVE_INFINITY;
      let hi = Number.NEGATIVE_INFINITY;
      for (const p of grid.present) {
        const t = tones[grid.row[p]!]!;
        if (t < lo) lo = t;
        if (t > hi) hi = t;
      }
      if (!(lo <= hi)) return undefined;
      domain = [lo, hi];
    }
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

  /** This chart's scratch for the surface, with positions for `frame`'s view. */
  #scratch(frame: Omit<Frame3D, "rank">): Scratch {
    const grid = this.#build();
    const { nx, ny } = grid;
    let byLayer = scratches.get(frame.faces);
    if (!byLayer) {
      byLayer = new Map();
      scratches.set(frame.faces, byLayer);
    }
    let scratch = byLayer.get(frame.id);
    // A grid of the same size may have gained values: readable points need room too.
    if (
      !scratch ||
      scratch.u.length !== nx ||
      scratch.v.length !== ny ||
      scratch.readable.length < grid.present.length
    ) {
      scratch = {
        view: undefined,
        u: new Float64Array(nx),
        v: new Float64Array(ny),
        w: new Float64Array(nx * ny),
        vertexOf: new Int32Array(nx * ny),
        depth: new Float64Array(nx * ny),
        traversal: undefined,
        readable: new Uint32Array(grid.present.length),
      };
      byLayer.set(frame.id, scratch);
    }
    if (scratch.view === frame.view) return scratch;
    scratch.view = frame.view;
    scratch.traversal = undefined;
    const [ax, ay, az] = frame.axes;
    const place = (
      axis: (typeof frame.axes)[number],
      values: Float64Array,
      names: readonly string[] | undefined,
      out: Float64Array,
    ) => {
      for (let i = 0; i < values.length; i++)
        out[i] = axis.place(names ? (axis.categories!.get(names[i]!) ?? Number.NaN) : values[i]!);
    };
    place(ax, grid.xs, grid.xNames, scratch.u);
    place(ay, grid.ys, grid.yNames, scratch.v);
    const z = this.table.numbers(this.spec.z as never);
    scratch.w.fill(Number.NaN);
    // Grid points the axes give no place (nonpositive values on log axes) are missing: NaN heights.
    for (const p of grid.present) {
      const i = p % nx;
      const height = az.place(z[grid.row[p]!]!);
      const placed =
        Number.isFinite(scratch.u[i]!) &&
        Number.isFinite(scratch.v[(p - i) / nx]!) &&
        Number.isFinite(height);
      scratch.w[p] = placed ? height : Number.NaN;
    }
    return scratch;
  }

  ranker(frame: Omit<Frame3D, "rank">): (x: number, y: number, z: number) => number {
    const scratch = this.#scratch(frame);
    const grid = this.#build();
    scratch.traversal = new Traversal(scratch.u, scratch.v, frame.view);
    const traversal = scratch.traversal;
    return (x, y, z) => traversal.pointKey(x, y, z, scratch.w, grid.nx);
  }

  place(frame: Frame3D): Placed3D {
    const { view, faces, theme } = frame;
    const { spec } = this;
    const grid = this.#build();
    const scratch = this.#scratch(frame);
    const { nx, ny, present } = grid;
    const { u, v, w, vertexOf, depth } = scratch;
    const traversal = frame.rank ? scratch.traversal : undefined;
    const out = new Float64Array(2);
    // Grid points inside the box become vertices; the rest are left out,
    // and cells reaching past the box are cut at its walls.
    vertexOf.fill(-1);
    let readable = 0;
    for (const p of present) {
      const i = p % nx;
      const j = (p - i) / nx;
      const [a, b, c] = [u[i]!, v[j]!, w[p]!];
      if (!(Math.abs(a) <= 1 + EPSILON && Math.abs(b) <= 1 + EPSILON && Math.abs(c) <= 1 + EPSILON))
        continue;
      depth[p] = view.project(a, b, c, out, 0);
      vertexOf[p] = faces.vertex(out[0]!, out[1]!, depth[p]!);
      scratch.readable[readable++] = p;
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
    // A light above and to the left of the eye, in the box's units.
    const light = normalize([
      view.eye[0] + 0.5 * view.up[0] - 0.35 * view.right[0],
      view.eye[1] + 0.5 * view.up[1] - 0.35 * view.right[1],
      view.eye[2] + 0.5 * view.up[2] - 0.35 * view.right[2],
    ]);
    // A cell's corners with values (counterclockwise from its lowest x and y,
    // so the fan from the first splits it along that corner's diagonal), and
    // their positions in the box's units.
    const corners = new Int32Array(4);
    const box = new Float64Array(12);
    const clipped: number[] = [];
    // Grid points outside the box at the corners of cut cells drawn: the vertex they are read at.
    const anchors = new Map<number, number>();
    const row = grid.row;
    for (let j = 0; scale && j + 1 < ny; j++) {
      for (let i = 0; i + 1 < nx; i++) {
        const a = j * nx + i;
        let m = 0;
        for (const p of [a, a + 1, a + nx + 1, a + nx]) if (!Number.isNaN(w[p]!)) corners[m++] = p;
        // Three corners make one triangle.
        if (m < 3) continue;
        let tone = 0;
        let inside = true;
        for (let k = 0; k < m; k++) {
          const p = corners[k]!;
          tone += tones[row[p]!]!;
          inside &&= vertexOf[p]! >= 0;
          const pi = p % nx;
          box[k * 3] = u[pi]! * ha;
          box[k * 3 + 1] = v[(p - pi) / nx]! * hb;
          box[k * 3 + 2] = w[p]! * hc;
        }
        let mean = tone / m;
        if (!Number.isFinite(mean)) {
          // Finite values near the largest overflow when summed: average their quarters.
          let quarters = 0;
          for (let k = 0; k < m; k++) quarters += tones[row[corners[k]!]!]! / 4;
          mean = (quarters / m) * 4;
        }
        const index = scale.index(mean);
        if (index < 0) continue;
        let level = LEVELS - 1;
        if (shading) {
          // The cell's facing: across the diagonals of a quad, or along two sides of a triangle.
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
          const facing =
            Math.abs(crossX * light[0] + crossY * light[1] + crossZ * light[2]) / length;
          level = Number.isFinite(facing) ? Math.round(facing * (LEVELS - 1)) : LEVELS - 1;
        }
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
          const first = faces.vertexCount;
          let sum = 0;
          for (let k = 0; k < kept.length; k += 3) {
            const at = view.project(kept[k]!, kept[k + 1]!, kept[k + 2]!, out, 0);
            faces.corner(faces.vertex(out[0]!, out[1]!, at));
            sum += at;
          }
          faces.face(style, key, sum / (kept.length / 3), a);
          // Its corners outside the box are read at the drawn vertex nearest them.
          for (let t = 0; t < triangle.length; t++) {
            const p = corners[triangle[t]!]!;
            if (vertexOf[p]! >= 0 || anchors.has(p)) continue;
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
                nearest = c / 3;
              }
            }
            anchors.set(p, first + nearest);
          }
        }
      }
    }
    // Grid points read, in grid order: those in the box and the corners of cut cells drawn.
    if (anchors.size > 0) {
      const outside = [...anchors.keys()].sort((a, b) => a - b);
      const inside = scratch.readable.slice(0, readable);
      let i = 0;
      let o = 0;
      for (let k = 0; k < readable + outside.length; k++)
        scratch.readable[k] =
          o >= outside.length || (i < readable && inside[i]! < outside[o]!)
            ? inside[i++]!
            : outside[o++]!;
      readable += outside.length;
    }
    return this.#placed(frame, grid, scratch, readable, scale, anchors);
  }

  #placed(
    frame: Frame3D,
    grid: Grid,
    scratch: Scratch,
    count: number,
    scale: SequentialScale | undefined,
    anchors: ReadonlyMap<number, number>,
  ): Placed3D {
    const { spec, table } = this;
    const { faces, axes, id, locale } = frame;
    const { nx } = grid;
    const readable = scratch.readable;
    const z = table.numbers(spec.z as never);
    const tones = spec.color === undefined ? undefined : table.numbers(spec.color as never);
    const offset = table.rowOffset;
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
    // A grid point's item, at its vertex (or for one outside the box, its cut cell's nearest).
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
      const vertex = scratch.vertexOf[p]! >= 0 ? scratch.vertexOf[p]! : anchors.get(p)!;
      const px = faces.vertices[vertex * 2]!;
      const py = faces.vertices[vertex * 2 + 1]!;
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
    const find = (p: number) => {
      let lo = 0;
      let hi = count;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (readable[mid]! < p) lo = mid + 1;
        else hi = mid;
      }
      return lo < count && readable[lo] === p ? lo : -1;
    };
    return {
      count,
      item: itemOf,
      indexOf(key) {
        const identity = identityIn(key, id);
        if (identity === undefined) return -1;
        for (let k = 0; k < count; k++) if (grid.row[readable[k]!] === identity - offset) return k;
        return -1;
      },
      itemOfFace(a, px, py) {
        // The cell's corner nearest the pointer: drawn ones first, else
        // (a cell cut at the walls) those read where the cut cell is drawn.
        let best = -1;
        let drawn = false;
        let nearest = Number.POSITIVE_INFINITY;
        for (const p of [a, a + 1, a + nx + 1, a + nx]) {
          if (p >= scratch.vertexOf.length) continue;
          const own = scratch.vertexOf[p]!;
          const vertex = own >= 0 ? own : (anchors.get(p) ?? -1);
          if (vertex < 0 || (drawn && own < 0)) continue;
          const d = Math.hypot(
            faces.vertices[vertex * 2]! - px,
            faces.vertices[vertex * 2 + 1]! - py,
          );
          if ((own >= 0 && !drawn) || d < nearest) {
            nearest = d;
            best = p;
            drawn ||= own >= 0;
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
        let inside = 0;
        for (let k = 0; k < count; k++) if (scratch.vertexOf[readable[k]!]! >= 0) inside++;
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

function normalize(v: number[]): [number, number, number] {
  const length = Math.hypot(v[0]!, v[1]!, v[2]!);
  return length > 0 ? [v[0]! / length, v[1]! / length, v[2]! / length] : [0, 0, 1];
}

function rgbOf(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** A color with its channels multiplied by `factor`, as hex. */
function shade([r, g, b]: [number, number, number], factor: number): string {
  const c = (v: number) => Math.min(255, Math.max(0, Math.round(v * factor)));
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
      "id",
    ]),
  };
  if (options.colors) spec.colors = [...options.colors];
  if (options.colorDomain) spec.colorDomain = [options.colorDomain[0], options.colorDomain[1]];
  if (table.name !== undefined) spec.data = table.name;
  // Field names were checked against S above; marks work on the erased schema.
  return new SurfaceMark(spec, table as unknown as Table);
}
