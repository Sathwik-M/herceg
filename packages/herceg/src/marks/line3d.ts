// Lines of a 3D chart through (x, y, z): each series' rows, in table order,
// make one path, broken where a row has no place in the box's coordinates
// (a missing value, a nonpositive one on a log axis). On the CPU each
// segment, cut at the box's walls, is a face of two corners stroked a
// constant width on screen and sorted by depth with the chart's other faces;
// with one surface in the chart, segments are also cut where they cross its
// columns and rows, and each piece is ranked among the cells it lies over.
// That order is approximate: a segment piercing a cell, or two segments
// crossing, can be drawn in the wrong order around the crossing, which a GPU
// painter's depth test does not. Items are the samples, path after path.

import type { CategoryField, NumericField, Schema, Table } from "../data/table.ts";
import { symbolPath } from "../draw/symbols.ts";
import { ItemViews } from "../model/item-views.ts";
import type { LegendEntry } from "../model/legend.ts";
import type { ChartConfig } from "../model/model.ts";
import { isOpaqueColor } from "../scale/color.ts";
import type { LineBatch3D } from "../scene/scene.ts";
import type { Frozen, Line3DSpec } from "../spec/spec.ts";
import type { View } from "../three/camera.ts";
import { cutSegment } from "../three/clip.ts";
import { ScreenGrid } from "../three/hit.ts";
import {
  type ItemSources,
  type LayoutFrame,
  type LayoutItem,
  type LayoutMark,
  type LayoutResult,
  memberOf,
  ownOr,
} from "./layout-mark.ts";
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
  inFront,
  joinLayers3D,
  type Layer3D,
  PerChart,
  type Placed3D,
  positiveExtent,
} from "./plot3d.ts";
import { checkTooltip, type MarkTooltip } from "./tooltip-fields.ts";

export interface Line3DOptions<S extends Schema> {
  /** Number or time fields: each sample's position; z is vertical. */
  x: NumericField<S>;
  y: NumericField<S>;
  z: NumericField<S>;
  /** Category field: one path per value, each with its color and legend entry. */
  series?: CategoryField<S>;
  /** One color for every path; by default each series takes the chart's next. */
  stroke?: string;
  /** Width in pixels, the same however near or far; default 2. */
  strokeWidth?: number;
  /** Legend and tooltip name of the path without `series`. */
  label?: string;
  /** Fields of the row tooltips show besides the mark's values, such as counts that are not plotted. */
  tooltip?: MarkTooltip<S>;
  /** The subplot whose 3D box this layer shares. */
  panel?: string;
  id?: string;
}

const WIDTH = 2;
/** Pointer reach past a line's edge, in pixels, as on the CPU (three/faces.ts). */
const REACH = 3;

/** A path in the legend: a category of `series`, or every row. */
interface Group {
  label: string;
  category: string | undefined;
  /** The category's code; -1 without `series`. */
  code: number;
}

/** A line's samples for one chart's axes and series shown, path after path. */
interface Paths {
  key: string;
  /** Each sample's row: paths in legend order, each path's rows in table order, rows without a place left out. */
  rows: Uint32Array;
  count: number;
  /** Per sample: its path's legend group. */
  group: Uint16Array | Uint32Array;
  /** Per sample: 1 when a segment joins it to the next. */
  joined: Uint8Array;
  /** Where each group's samples start; the last entry ends the last group's. */
  starts: Uint32Array;
  /** Segments with a part in the box, and the runs paths break into. */
  segments: number;
  runs: number;
  /** Rows of the paths without a place, which break them. */
  missing: number;
  /** Samples read, in path order: those in the box, and those outside it at an end of a segment drawn. */
  readable: Uint32Array;
  /** Samples outside the box that are read: the normalized end, in the box, of the first segment drawn from them. */
  anchors: ReadonlyMap<number, readonly [number, number, number]>;
}

/** Where a line's segments are on screen for one view, for the pointer when a GPU painter draws them. */
interface Screen {
  view: View;
  paths: Paths;
  /** The sample each segment drawn starts at, and its ends' screen x, y, and depth (cut at the box). */
  starts: Uint32Array;
  ends: Float32Array;
  grid: ScreenGrid;
}

const allPaths = new PerChart<Paths>();
const screens = new PerChart<Screen>();
const keys = new PerChart<{ paths: Paths; key: object }>();

export class Line3DMark implements Layer3D {
  declare readonly [MARK]: true;
  readonly layout = true;
  readonly views = ItemViews;
  readonly dimensions = 3;
  readonly spec: Frozen<Line3DSpec>;
  readonly table: Table;
  readonly measure: string;
  readonly identity: ItemSources | undefined;
  readonly #fields: readonly [string, string, string];
  #held: { version: number; groups: readonly Group[] } | undefined;

  constructor(input: Line3DSpec, table: Table) {
    this.spec = frozen(input);
    checkTooltip(table, this.spec.tooltip, "line3d");
    // Read from the copy: the caller may change what it passed.
    const spec = this.spec;
    for (const axis of ["x", "y", "z"] as const)
      requireField(table, spec[axis], ["number", "time"], `line3d ${axis}`);
    if (spec.series !== undefined) requireField(table, spec.series, ["category"], "line3d series");
    if (
      spec.strokeWidth !== undefined &&
      !(spec.strokeWidth > 0 && Number.isFinite(spec.strokeWidth))
    )
      throw new RangeError(
        `line3d strokeWidth: expected a positive number of pixels; received ${spec.strokeWidth}`,
      );
    this.table = table;
    this.#fields = [spec.x, spec.y, spec.z];
    this.measure = spec.label ?? "Line";
    // Groups of a series field stand for its values, as series of it do.
    this.identity =
      this.spec.series === undefined
        ? undefined
        : { field: this.spec.series, read: memberOf("series") };
  }

  join(
    marks: readonly LayoutMark[],
    config: ChartConfig,
    indices?: readonly number[],
    panel?: string,
  ): LayoutMark {
    return joinLayers3D(marks, config, indices, panel);
  }

  /** Charts draw 3D layers through `join`; drawn alone, a layer takes the default options. */
  draw(frame: LayoutFrame): LayoutResult {
    return joinLayers3D([this], { marks: [this] }).draw(frame);
  }

  axisData(k: number, log: boolean): AxisData {
    const field = this.#fields[k]!;
    const kind = this.table.kind(field as never) === "time" ? "time" : "number";
    const extent = log
      ? positiveExtent(this.table.numbers(field as never))
      : this.table.extent(field as never);
    return { field, kind, extent };
  }

  /** The categories of `series` rows hold, as legend groups (one group without `series`), once per table version. */
  #groups(): readonly Group[] {
    const { spec, table } = this;
    if (spec.series === undefined) return [{ label: this.measure, category: undefined, code: -1 }];
    if (this.#held?.version === table.version) return this.#held.groups;
    const { codes, dictionary } = table.categories(spec.series as never);
    const held = new Uint8Array(dictionary.length);
    for (let row = 0; row < table.length; row++) if (codes[row]! >= 0) held[codes[row]!] = 1;
    const groups = dictionary.flatMap((category, code) =>
      held[code] ? [{ label: category, category, code }] : [],
    );
    this.#held = { version: table.version, groups };
    return groups;
  }

  legend(id: string | number, color: (key: string) => string): LegendEntry[] {
    return this.#groups().map(({ label, category }) => {
      const key = groupKey(id, category);
      return { key, label, color: ownOr(this.spec.stroke, color(key)) };
    });
  }

  scales(): [ColorRamp[], GlyphKey[]] {
    return [[], []];
  }

  /**
   * What writes a row's normalized position to `out` at `at`, and says
   * whether it has one, with the columns and axes read once.
   */
  #placer(axes: Frame3D["axes"]): (row: number, out: Float64Array, at?: number) => boolean {
    const [xs, ys, zs] = this.#fields.map((field) => this.table.numbers(field as never));
    const [ax, ay, az] = axes;
    return (row, out, at = 0) => {
      const u = ax.place(xs![row]!);
      const v = ay.place(ys![row]!);
      const w = az.place(zs![row]!);
      out[at] = u;
      out[at + 1] = v;
      out[at + 2] = w;
      return Number.isFinite(u) && Number.isFinite(v) && Number.isFinite(w);
    };
  }

  /**
   * The samples, path after path, found once per chart for its axes, the
   * table version, and the series shown: each shown series' rows in table
   * order (a counting sort by series), rows without a place breaking them.
   */
  #paths(frame: Frame3D): Paths {
    const { spec, table } = this;
    const { axes, hidden, id } = frame;
    const groups = this.#groups();
    const shown = groups.map((group) => !hidden.has(groupKey(id, group.category)));
    const key = `${table.version}|${shown.join()}|${axesKey(axes)}`;
    const held = allPaths.get(frame);
    if (held?.key === key) return held;
    const n = table.length;
    const series = spec.series === undefined ? undefined : table.categories(spec.series as never);
    const codes = series?.codes;
    // Each code's shown group (the code 0 standing for every row without `series`), or -1.
    const groupOf = new Int32Array(series ? series.dictionary.length : 1).fill(-1);
    groups.forEach((group, g) => {
      if (shown[g]) groupOf[Math.max(0, group.code)] = g;
    });
    const groupAt = (row: number) => {
      const code = codes ? codes[row]! : 0;
      return code >= 0 ? groupOf[code]! : -1;
    };
    const first = new Uint32Array(groups.length + 1);
    for (let row = 0; row < n; row++) {
      const g = groupAt(row);
      if (g >= 0) first[g + 1]!++;
    }
    for (let g = 0; g < groups.length; g++) first[g + 1]! += first[g]!;
    const order = new Uint32Array(first[groups.length]!);
    const next = first.slice(0, groups.length);
    for (let row = 0; row < n; row++) {
      const g = groupAt(row);
      if (g >= 0) order[next[g]!++] = row;
    }
    const rows = new Uint32Array(order.length);
    const group =
      groups.length > 0xffff ? new Uint32Array(order.length) : new Uint16Array(order.length);
    const joined = new Uint8Array(order.length);
    const starts = new Uint32Array(groups.length + 1);
    // Normalized positions while the paths are found.
    const at = new Float64Array(order.length * 3);
    const place = this.#placer(axes);
    let count = 0;
    let runs = 0;
    let missing = 0;
    for (let g = 0; g < groups.length; g++) {
      starts[g] = count;
      let previous = false;
      for (let k = first[g]!; k < first[g + 1]!; k++) {
        const row = order[k]!;
        if (!place(row, at, count * 3)) {
          missing++;
          previous = false;
          continue;
        }
        if (previous) joined[count - 1] = 1;
        else runs++;
        rows[count] = row;
        group[count] = g;
        count++;
        previous = true;
      }
    }
    starts[groups.length] = count;
    // Segments with a part in the box, and the samples outside it they reach from.
    const anchors = new Map<number, readonly [number, number, number]>();
    let segments = 0;
    const inside = (i: number) => inBox(at[i * 3]!, at[i * 3 + 1]!, at[i * 3 + 2]!);
    const ends = new Float64Array(6);
    for (let i = 0; i + 1 < count; i++) {
      if (!joined[i]) continue;
      const [a, b] = [inside(i), inside(i + 1)];
      if (a && b) {
        segments++;
        continue;
      }
      if (!cutSegment(at, at, ends, undefined, i * 3, i * 3 + 3)) continue;
      segments++;
      if (!a && !anchors.has(i)) anchors.set(i, [ends[0]!, ends[1]!, ends[2]!]);
      if (!b && !anchors.has(i + 1)) anchors.set(i + 1, [ends[3]!, ends[4]!, ends[5]!]);
    }
    const readable = new Uint32Array(count);
    let read = 0;
    for (let i = 0; i < count; i++) if (anchors.has(i) || inside(i)) readable[read++] = i;
    return allPaths.set(frame, {
      key,
      rows,
      count,
      group,
      joined,
      starts,
      segments,
      runs,
      missing,
      readable: readable.subarray(0, read),
      anchors,
    });
  }

  /** The colors of the paths: `stroke`, or each series'. */
  #palette(frame: Frame3D): string[] {
    return this.#groups().map((group) =>
      ownOr(this.spec.stroke, frame.color(groupKey(frame.id, group.category))),
    );
  }

  /** Where sample `i` is read on screen: at its place, or (outside the box) its anchor's. */
  #screen(frame: Frame3D, paths: Paths, i: number, out: Float64Array): number {
    const anchor = paths.anchors.get(i);
    if (anchor) return frame.view.project(anchor[0], anchor[1], anchor[2], out, 0);
    const at = new Float64Array(3);
    this.#placer(frame.axes)(paths.rows[i]!, at);
    return frame.view.project(at[0]!, at[1]!, at[2]!, out, 0);
  }

  items(frame: Frame3D): Items3D {
    const { spec, table } = this;
    const { axes, id } = frame;
    const paths = this.#paths(frame);
    const { rows, readable, starts } = paths;
    const count = readable.length;
    const [xs, ys, zs] = this.#fields.map((field) => table.numbers(field as never));
    const groups = this.#groups();
    const palette = this.#palette(frame);
    const series = spec.series === undefined ? undefined : table.categories(spec.series as never);
    const offset = table.rowOffset;
    const radius = (spec.strokeWidth ?? WIDTH) / 2 + 2;
    const out = new Float64Array(2);
    const item = (index: number): LayoutItem => {
      const i = readable[index]!;
      const row = rows[i]!;
      const g = paths.group[i]!;
      const values = [xs![row]!, ys![row]!, zs![row]!];
      const data: Record<string, number | string> = {};
      const parts = this.#fields.map((field, k) => {
        data[field] = values[k]!;
        return `${axes[k]!.title || axes[k]!.name} ${axes[k]!.format(values[k]!)}`;
      });
      if (spec.series !== undefined) data[spec.series] = groups[g]!.label;
      this.#screen(frame, paths, i, out);
      const [px, py] = [Math.fround(out[0]!), Math.fround(out[1]!)];
      return {
        key: JSON.stringify([id, offset + row]),
        label: groups[g]!.label,
        color: palette[g]!,
        value: values[2]!,
        text: parts.join(", "),
        px,
        py,
        outline: symbolPath("circle", px, py, radius),
        measure: this.measure,
        values: data,
        row,
      };
    };
    return {
      count,
      item,
      indexOf(key) {
        const identity = identityIn(key, id);
        if (identity === undefined) return -1;
        const row = identity - offset;
        if (!(row >= 0 && row < table.length)) return -1;
        // Its path's samples are in row order.
        const code = series ? series.codes[row]! : 0;
        const g = groups.findIndex((group) => Math.max(0, group.code) === code);
        if (g < 0) return -1;
        const at = findRow(
          rows.subarray(starts[g]!, starts[g + 1]!),
          starts[g + 1]! - starts[g]!,
          row,
        );
        return at < 0 ? -1 : findRow(readable, count, starts[g]! + at);
      },
      summary: () => {
        const what = spec.series === undefined ? "3D line" : `3D lines of ${groups.length} series`;
        const fields = this.#fields.join(", ");
        if (paths.count === 0) return `${what} through ${fields}, with nothing to show.`;
        const breaks =
          paths.missing === 0
            ? ""
            : `, broken by ${paths.missing} ${paths.missing === 1 ? "point" : "points"} without a value`;
        const runs = `${paths.runs} ${paths.runs === 1 ? "run" : "runs"}`;
        const inBox = count === paths.count ? "" : `, ${count} of them in the box`;
        const points = `${paths.count} ${paths.count === 1 ? "point" : "points"}`;
        return `${what} through ${fields}: ${points} in ${runs}${breaks}${inBox}.`;
      },
    };
  }

  place(frame: FaceFrame3D): Placed3D {
    const { spec } = this;
    const { faces, view, rank } = frame;
    const paths = this.#paths(frame);
    const { group } = paths;
    const width = spec.strokeWidth ?? WIDTH;
    const style = this.#palette(frame).map((color) => faces.styleOf(color, 1, 0, color, width));
    // The segment's part in the box, from (ends[0..2]) to (ends[3..5]).
    const ends = new Float64Array(6);
    const p = new Float64Array(3);
    const q = new Float64Array(3);
    const out = new Float64Array(2);
    const cuts: number[] = [];
    // Writes the piece of the part in the box from t0 to t1 along it as a face.
    const piece = (i: number, t0: number, t1: number) => {
      for (let k = 0; k < 3; k++) {
        p[k] = ends[k]! + t0 * (ends[k + 3]! - ends[k]!);
        q[k] = ends[k]! + t1 * (ends[k + 3]! - ends[k]!);
      }
      faces.begin();
      const near = view.project(p[0]!, p[1]!, p[2]!, out, 0);
      faces.corner(faces.vertex(out[0]!, out[1]!, near));
      const far = view.project(q[0]!, q[1]!, q[2]!, out, 0);
      faces.corner(faces.vertex(out[0]!, out[1]!, far));
      const key = rank
        ? rank.key((p[0]! + q[0]!) / 2, (p[1]! + q[1]!) / 2, (p[2]! + q[2]!) / 2)
        : 0;
      faces.face(style[group[i]!]!, key, (near + far) / 2, i);
    };
    this.#segments(frame, paths, (i, part) => {
      ends.set(part);
      if (!rank) {
        piece(i, 0, 1);
        return;
      }
      // Over a surface, a piece per cell it crosses, each ranked among them.
      cuts.length = 0;
      cuts.push(0, 1);
      crossings(rank.columns, ends[0]!, ends[3]!, cuts);
      crossings(rank.rows, ends[1]!, ends[4]!, cuts);
      cuts.sort((x, y) => x - y);
      for (let c = 0; c + 1 < cuts.length; c++)
        if (cuts[c + 1]! > cuts[c]!) piece(i, cuts[c]!, cuts[c + 1]!);
    });
    let items: Items3D | undefined;
    return {
      itemOfFace: (i, px, py) => {
        items ??= this.items(frame);
        return this.#nearestEnd(frame, paths, items, i, px, py);
      },
    };
  }

  /** Of the ends of the segment from sample `i`, the item read nearer (px, py). */
  #nearestEnd(
    frame: Frame3D,
    paths: Paths,
    items: Items3D,
    i: number,
    px: number,
    py: number,
  ): LayoutItem | undefined {
    const out = new Float64Array(2);
    let best: number | undefined;
    let nearest = Number.POSITIVE_INFINITY;
    for (const end of [i, i + 1]) {
      const at = findRow(paths.readable, paths.readable.length, end);
      if (at < 0) continue;
      this.#screen(frame, paths, end, out);
      const d = Math.hypot(out[0]! - px, out[1]! - py);
      if (d < nearest) {
        nearest = d;
        best = at;
      }
    }
    return best === undefined ? undefined : items.item(best);
  }

  /**
   * The paths for a GPU painter, as runs of points in the box and per point
   * the color index of the segment to the next (255 for none). Translucent
   * colors need drawing in order, so they have no batch.
   */
  batch(frame: Frame3D): LineBatch3D | undefined {
    const palette = this.#palette(frame);
    if (palette.length > 255 || !palette.every(isOpaqueColor)) return undefined;
    const paths = this.#paths(frame);
    let held = keys.get(frame);
    if (held?.paths !== paths) held = keys.set(frame, { paths, key: {} });
    return {
      kind: "lines",
      key: held.key,
      segments: paths.segments,
      palette,
      width: this.spec.strokeWidth ?? WIDTH,
      arrays: () => {
        const points = this.#runs(frame, paths);
        const out = { positions: new Float32Array(points * 3), style: new Uint8Array(points) };
        this.#runs(frame, paths, out);
        return out;
      },
    };
  }

  /**
   * Walks the segments drawn as runs of points in the box, writing each
   * point's normalized position, and the color of the segment from it to the
   * next (255 for none), to `out`; how many points. Segments reaching past
   * the box are cut at its walls here, in float64, so float32 keeps them.
   */
  #runs(
    frame: Frame3D,
    paths: Paths,
    out?: { positions: Float32Array; style: Uint8Array },
  ): number {
    let n = 0;
    // The sample the last point written is, while a run goes on from it.
    let last = -1;
    const point = (part: Float64Array, at: number) => {
      if (out) {
        for (let k = 0; k < 3; k++) out.positions[n * 3 + k] = part[at + k]!;
        out.style[n] = 255;
      }
      return n++;
    };
    this.#segments(frame, paths, (i, part, cut) => {
      const start = !cut[0] && last === i ? n - 1 : point(part, 0);
      if (out) out.style[start] = paths.group[i]!;
      point(part, 3);
      last = cut[1] ? -1 : i + 1;
    });
    return n;
  }

  /**
   * Calls `segment` with each segment drawn, in path order: the sample it
   * starts at, its part in the box (two points, normalized), and whether
   * each end was cut at a wall. Each sample is placed once.
   */
  #segments(
    frame: Frame3D,
    paths: Paths,
    segment: (i: number, part: Float64Array, cut: readonly [boolean, boolean]) => void,
  ): void {
    const place = this.#placer(frame.axes);
    let a = new Float64Array(3);
    let b = new Float64Array(3);
    const part = new Float64Array(6);
    const cut: [boolean, boolean] = [false, false];
    let placed = -1;
    for (let i = 0; i + 1 < paths.count; i++) {
      if (!paths.joined[i]) continue;
      if (placed !== i) place(paths.rows[i]!, a);
      place(paths.rows[i + 1]!, b);
      placed = i + 1;
      if (inBox(a[0]!, a[1]!, a[2]!) && inBox(b[0]!, b[1]!, b[2]!)) {
        part.set(a, 0);
        part.set(b, 3);
        cut[0] = false;
        cut[1] = false;
        segment(i, part, cut);
      } else if (cutSegment(a, b, part, cut)) segment(i, part, cut);
      [a, b] = [b, a];
    }
  }

  /**
   * The sample a GPU painter shows nearest the pointer: of the segments
   * within reach, the one nearest the eye where it comes closest, read at
   * its end nearer the pointer. Segments are projected and filed on screen
   * once per view.
   */
  pick(frame: Frame3D, px: number, py: number): Hit3D | undefined {
    const { view } = frame;
    const paths = this.#paths(frame);
    let screen = screens.get(frame);
    if (!screen || screen.paths !== paths || !screen.view.same(view))
      screen = screens.set(frame, this.#project(frame, paths));
    const { starts, ends } = screen;
    const reach = (this.spec.strokeWidth ?? WIDTH) / 2 + REACH;
    const distance = view.distance;
    let best = -1;
    let bestDepth = Number.NEGATIVE_INFINITY;
    screen.grid.near(px, py, 0, (s) => {
      const [ax, ay, az] = [ends[s * 6]!, ends[s * 6 + 1]!, ends[s * 6 + 2]!];
      const [bx, by, bz] = [ends[s * 6 + 3]!, ends[s * 6 + 4]!, ends[s * 6 + 5]!];
      const dx = bx - ax;
      const dy = by - ay;
      const length = dx * dx + dy * dy;
      const t =
        length > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / length)) : 0;
      const ox = ax + t * dx - px;
      const oy = ay + t * dy - py;
      if (ox * ox + oy * oy > reach * reach) return;
      // Depth where the segment comes closest: in perspective, 1 / (distance - depth) runs linearly on screen.
      const depth =
        length === 0
          ? Math.max(az, bz)
          : distance === Number.POSITIVE_INFINITY
            ? az + t * (bz - az)
            : distance - 1 / ((1 - t) / (distance - az) + t / (distance - bz));
      // At one depth the later segment shows, as the painter draws it.
      if (best < 0 || inFront(depth, s > best, bestDepth, distance)) {
        best = s;
        bestDepth = depth;
      }
    });
    if (best < 0) return undefined;
    const item = this.#nearestEnd(frame, paths, this.items(frame), starts[best]!, px, py);
    return item && { item, depth: bestDepth };
  }

  /** The segments drawn, cut at the box and projected for the frame's view, filed on screen. */
  #project(frame: Frame3D, paths: Paths): Screen {
    const { view, bounds } = frame;
    const starts = new Uint32Array(paths.segments);
    const ends = new Float32Array(paths.segments * 6);
    const out = new Float64Array(2);
    const end = (part: Float64Array, from: number, at: number) => {
      ends[at + 2] = view.project(part[from]!, part[from + 1]!, part[from + 2]!, out, 0);
      ends[at] = out[0]!;
      ends[at + 1] = out[1]!;
    };
    let s = 0;
    // The sample the last segment's end is, projected, when it was not cut.
    let projected = -1;
    this.#segments(frame, paths, (i, part, cut) => {
      // A segment's start is the last one's end, projected already.
      if (!cut[0] && projected === i) ends.copyWithin(s * 6, s * 6 - 3, s * 6);
      else end(part, 0, s * 6);
      end(part, 3, s * 6 + 3);
      projected = cut[1] ? -1 : i + 1;
      starts[s++] = i;
    });
    const reach = (this.spec.strokeWidth ?? WIDTH) / 2 + REACH;
    // Each segment filed in the cells within reach of it, once each.
    const grid = new ScreenGrid(bounds, s, (filer) => {
      for (let k = 0; k < s; k++)
        filer.segment(k, ends[k * 6]!, ends[k * 6 + 1]!, ends[k * 6 + 3]!, ends[k * 6 + 4]!, reach);
    });
    return { view, paths, starts, ends, grid };
  }
}

/** Adds to `cuts` where the segment from `from` to `to` (along one axis) crosses `positions`. */
function crossings(positions: Float64Array, from: number, to: number, cuts: number[]): void {
  if (from === to) return;
  for (let i = 0; i < positions.length; i++) {
    const t = (positions[i]! - from) / (to - from);
    if (t > 0 && t < 1) cuts.push(t);
  }
}

/** The legend and color key of a path. */
function groupKey(id: string | number, series: string | undefined): string {
  return JSON.stringify({ mark: id, series });
}

/**
 * Lines in a 3D chart through the number or time fields `x`, `y`, and `z`
 * (z is vertical): each series' rows, in table order, are one path.
 *
 * ```ts
 * line3d(flights, { x: "east", y: "north", z: "altitude", series: "flight" })
 * ```
 */
export function line3d<S extends Schema>(
  table: Table<S>,
  options: Line3DOptions<S>,
): ChartMark<Frozen<Line3DSpec>> {
  const spec: Line3DSpec = {
    type: "line3d",
    x: options.x,
    y: options.y,
    z: options.z,
    ...definedFields(options, [
      "tooltip",
      "series",
      "stroke",
      "strokeWidth",
      "label",
      "panel",
      "id",
    ]),
  };
  if (table.name !== undefined) spec.data = table.name;
  // Field names were checked against S above; marks work on the erased schema.
  return new Line3DMark(spec, table as unknown as Table);
}
