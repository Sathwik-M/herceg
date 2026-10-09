// Points of a 3D chart at (x, y, z): one disc each, in the chart's faces,
// so they are drawn in depth order with the chart's other layers. Rows are
// read once per scene in row order, so the drawn rows are the reading order
// and need no sort.

import type { CategoryField, NumberField, NumericField, Schema, Table } from "../data/table.ts";
import { symbolPath } from "../draw/symbols.ts";
import { formatNumber } from "../format/format.ts";
import type { LegendEntry } from "../model/legend.ts";
import type { ChartConfig } from "../model/model.ts";
import {
  checkColorScale,
  checkRamp,
  isOpaqueColor,
  rampOf,
  SequentialScale,
} from "../scale/color.ts";
import type { CloudLayer3D } from "../scene/scene.ts";
import type { Frozen, Point3DSpec } from "../spec/spec.ts";
import type { Theme } from "../theme.ts";
import type { FaceBuffer } from "../three/faces.ts";
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

export interface Point3DOptions<S extends Schema> {
  /** Number or time fields: each point's position; z is vertical. */
  x: NumericField<S>;
  y: NumericField<S>;
  z: NumericField<S>;
  /** Category field: one colored set of points per value, with a legend. */
  series?: CategoryField<S>;
  /** Category field naming each point, for tooltips and keyboard reading. */
  name?: CategoryField<S>;
  /** Radius in pixels; default 3.5. */
  r?: number;
  /** A number field colored on a continuous scale, with a color legend. */
  color?: NumberField<S>;
  /** Colors for `color`, low to high; the theme's ramp by default. */
  colors?: readonly string[];
  colorDomain?: readonly [number, number];
  colorMidpoint?: number;
  fill?: string;
  /** Default 1. */
  fillOpacity?: number;
  /** Legend and tooltip name of points without `series`. */
  label?: string;
  id?: string;
}

const RADIUS = 3.5;

/** A set of points in the legend: a category of `series`, or every point. */
interface Group {
  label: string;
  category: string | undefined;
  /** The category's code; -1 without `series`. */
  code: number;
}

/**
 * The rows each layer drew last, in row order, per chart (by its faces) and
 * layer identity, so layers of one chart (the same mark twice, too) and
 * charts sharing a mark keep their own.
 */
const drawnRows = new WeakMap<FaceBuffer, Map<string | number, Uint32Array>>();

export class Point3DMark implements Layer3D {
  declare readonly [MARK]: true;
  readonly layout = true;
  readonly dimensions = 3;
  readonly spec: Frozen<Point3DSpec>;
  readonly table: Table;
  readonly measure: string;
  readonly #fields: readonly [string, string, string];
  #held: { version: number; groups: readonly Group[] } | undefined;
  /** Each row's color index for GPU painters, for the table version, shown series, and colors in `key`. */
  #cloudStyle: { key: string; style: Uint8Array } | undefined;

  constructor(input: Point3DSpec, table: Table) {
    this.spec = frozen(input);
    // Read from the copy: the caller may change what it passed.
    const spec = this.spec;
    for (const axis of ["x", "y", "z"] as const)
      requireField(table, spec[axis], ["number", "time"], `point3d ${axis}`);
    if (spec.series !== undefined) requireField(table, spec.series, ["category"], "point3d series");
    if (spec.name !== undefined) requireField(table, spec.name, ["category"], "point3d name");
    if (spec.color !== undefined) requireField(table, spec.color, ["number"], "point3d color");
    if (Array.isArray(spec.colors)) checkRamp(spec.colors, "point3d colors");
    checkColorScale(spec.colorDomain, spec.colorMidpoint, "Point3d");
    if (spec.r !== undefined && !(spec.r > 0 && Number.isFinite(spec.r)))
      throw new RangeError(`point3d r must be a positive radius in pixels, not ${spec.r}`);
    if (spec.fillOpacity !== undefined && !(spec.fillOpacity >= 0 && spec.fillOpacity <= 1))
      throw new RangeError(`point3d fillOpacity must be from 0 to 1, not ${spec.fillOpacity}`);
    this.table = table;
    this.#fields = [spec.x, spec.y, spec.z];
    this.measure = spec.label ?? "Points";
  }

  join(marks: readonly LayoutMark[], config: ChartConfig): LayoutMark {
    return joinLayers3D(marks, config);
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

  #scale(theme: Theme): SequentialScale | undefined {
    const { spec } = this;
    if (spec.color === undefined) return undefined;
    const domain = spec.colorDomain ?? this.table.extent(spec.color as never);
    if (!domain) return undefined;
    const fallback = spec.colorMidpoint === undefined ? theme.sequential : theme.diverging;
    return new SequentialScale(domain, rampOf(spec.colors, fallback), spec.colorMidpoint);
  }

  /**
   * The categories of `series` rows hold, as legend groups (one group
   * without `series`), found once per table version.
   */
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

  legend(id: string | number, color: (key: string) => string, theme: Theme): LegendEntry[] {
    const glyph = symbolPath("circle", 0, 0, 4.5);
    return this.#groups().map(({ label, category }) => {
      const key = groupKey(id, category);
      const fill = this.spec.color !== undefined ? theme.muted : (this.spec.fill ?? color(key));
      return { key, label, color: fill, glyph };
    });
  }

  scales(theme: Theme): [ColorRamp[], GlyphKey[]] {
    const scale = this.#scale(theme);
    if (!scale) return [[], []];
    const { domain, midpoint } = scale;
    return [[{ stops: scale.legendStops(), domain, midpoint, title: this.spec.color! }], []];
  }

  /**
   * The points for a GPU painter: each row's color as an index into a
   * palette of the series' colors or the ramp's, 255 for rows not drawn.
   * Translucent points need drawing in order, so they have no cloud.
   */
  cloud(frame: Frame3D): CloudLayer3D | undefined {
    const { spec, table } = this;
    if ((spec.fillOpacity ?? 1) < 1) return undefined;
    const { theme, hidden, id } = frame;
    const scale = this.#scale(theme);
    const groups = this.#groups();
    const fills = groups.map((group) => spec.fill ?? frame.color(groupKey(id, group.category)));
    const shown = groups.map((group) => !hidden.has(groupKey(id, group.category)));
    const palette = spec.color === undefined ? fills : (scale?.colors() ?? []);
    if (palette.length > 255 || !palette.every(isOpaqueColor)) return undefined;
    const key = `${table.version}|${shown.join()}|${palette.join()}`;
    let style = this.#cloudStyle?.key === key ? this.#cloudStyle.style : undefined;
    if (!style) {
      style = new Uint8Array(table.length).fill(255);
      const series = spec.series === undefined ? undefined : table.categories(spec.series as never);
      const codes = series?.codes;
      // Each code's group, or -1 for codes no row holds.
      const groupOf = new Int32Array(series ? series.dictionary.length : 1).fill(-1);
      groups.forEach((group, g) => {
        groupOf[Math.max(0, group.code)] = g;
      });
      const tones = spec.color === undefined ? undefined : table.numbers(spec.color as never);
      for (let row = 0; row < table.length; row++) {
        const code = codes ? codes[row]! : 0;
        const g = code >= 0 ? groupOf[code]! : -1;
        if (g < 0 || !shown[g]) continue;
        if (!tones) style[row] = g;
        else if (scale) {
          const tone = scale.index(tones[row]!);
          if (tone >= 0) style[row] = tone;
        }
      }
      this.#cloudStyle = { key, style };
    }
    const [x, y, z] = this.#fields.map((field) => table.numbers(field as never));
    return {
      x: x!,
      y: y!,
      z: z!,
      version: table.version,
      style,
      palette,
      radius: spec.r ?? RADIUS,
    };
  }

  place(frame: Frame3D): Placed3D {
    const { view, axes, faces, rank, theme, hidden, id } = frame;
    const { spec, table } = this;
    const n = table.length;
    const [xs, ys, zs] = this.#fields.map((field) => table.numbers(field as never));
    const radius = spec.r ?? RADIUS;
    const opacity = spec.fillOpacity ?? 1;
    // Each series' style, or with `color` each ramp entry's; -1 for hidden series.
    const scale = this.#scale(theme);
    const tones = spec.color === undefined ? undefined : table.numbers(spec.color as never);
    const ramp = scale && tones ? scale.colors() : undefined;
    const rampStyles = ramp && new Int32Array(ramp.length).fill(-1);
    const series = spec.series === undefined ? undefined : table.categories(spec.series as never);
    const codes = series?.codes;
    // Each series code's style (the code 0 stands for every row without `series`); -1 when hidden.
    const styleOfCode = new Int32Array(series ? series.dictionary.length : 1).fill(-1);
    for (const group of this.#groups()) {
      const key = groupKey(id, group.category);
      if (hidden.has(key)) continue;
      const fill = spec.fill ?? frame.color(key);
      styleOfCode[Math.max(0, group.code)] = faces.styleOf(fill, opacity, radius);
    }
    let byLayer = drawnRows.get(faces);
    if (!byLayer) {
      byLayer = new Map();
      drawnRows.set(faces, byLayer);
    }
    let rows = byLayer.get(id);
    if (!rows || rows.length < n) {
      rows = new Uint32Array(Math.max(16, Math.ceil(n * 1.25)));
      byLayer.set(id, rows);
    }
    const out = new Float64Array(2);
    const [ax, ay, az] = axes;
    const firstVertex = faces.vertexCount;
    let count = 0;
    // With `color` but no value to color by, no point has a color to draw.
    const drawable = spec.color === undefined || scale !== undefined;
    for (let row = 0; drawable && row < n; row++) {
      const code = codes ? codes[row]! : 0;
      let style = code >= 0 ? styleOfCode[code]! : -1;
      if (style < 0) continue;
      if (ramp) {
        const tone = scale!.index(tones![row]!);
        if (tone < 0) continue;
        style = rampStyles![tone]!;
        if (style < 0) {
          style = faces.styleOf(ramp[tone]!, opacity, radius);
          rampStyles![tone] = style;
        }
      }
      const u = ax.place(xs![row]!);
      const v = ay.place(ys![row]!);
      const w = az.place(zs![row]!);
      // Points outside the box (or without a place on it) are not drawn.
      if (!(Math.abs(u) <= 1 + 1e-9 && Math.abs(v) <= 1 + 1e-9 && Math.abs(w) <= 1 + 1e-9))
        continue;
      const depth = view.project(u, v, w, out, 0);
      faces.begin();
      faces.corner(faces.vertex(out[0]!, out[1]!, depth));
      faces.face(style, rank ? rank(u, v, w) : 0, depth, row);
      rows[count++] = row;
    }
    return this.#placed(frame, rows, count, firstVertex, radius);
  }

  #placed(
    frame: Frame3D,
    rows: Uint32Array,
    count: number,
    firstVertex: number,
    radius: number,
  ): Placed3D {
    const { spec, table } = this;
    const { faces, axes, id } = frame;
    const [xs, ys, zs] = this.#fields.map((field) => table.numbers(field as never));
    const names = spec.name === undefined ? undefined : table.categories(spec.name as never);
    const series = spec.series === undefined ? undefined : table.categories(spec.series as never);
    const tones = spec.color === undefined ? undefined : table.numbers(spec.color as never);
    const offset = table.rowOffset;
    const styles = faces.styles;
    // Styles of drawn points, by drawing position among this layer's faces.
    const firstFace = faces.count - count;
    const category = (column: typeof names, row: number) => {
      const code = column ? column.codes[row]! : -1;
      return code >= 0 ? column!.dictionary[code]! : undefined;
    };
    const itemOf = (i: number): LayoutItem => {
      const row = rows[i]!;
      const values = [xs![row]!, ys![row]!, zs![row]!];
      const parts = values.map(
        (value, k) => `${axes[k]!.title || axes[k]!.name} ${axes[k]!.format(value)}`,
      );
      const data: Record<string, number | string> = {};
      this.#fields.forEach((field, k) => {
        data[field] = values[k]!;
      });
      if (tones) {
        parts.push(`${spec.color} ${formatNumber(tones[row]!, frame.locale)}`);
        data[spec.color!] = tones[row]!;
      }
      const name = category(names, row);
      const group = category(series, row);
      if (name !== undefined) data[spec.name!] = name;
      if (group !== undefined) data[spec.series!] = group;
      const px = faces.vertices[(firstVertex + i) * 2]!;
      const py = faces.vertices[(firstVertex + i) * 2 + 1]!;
      return {
        key: JSON.stringify([id, offset + row]),
        label: name ?? group ?? `${spec.label ?? "Point"} ${offset + row + 1}`,
        color: styles[faces.style[firstFace + i]!]!.fill,
        value: values[2]!,
        text: parts.join(", "),
        px,
        py,
        outline: symbolPath("circle", px, py, radius + 2),
        measure: this.measure,
        values: data,
        row,
      };
    };
    /** Where row `row` is among the drawn rows, or -1. */
    const find = (row: number) => {
      let lo = 0;
      let hi = count;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (rows[mid]! < row) lo = mid + 1;
        else hi = mid;
      }
      return lo < count && rows[lo] === row ? lo : -1;
    };
    return {
      count,
      item: itemOf,
      indexOf(key) {
        const identity = identityIn(key, id);
        return identity === undefined ? -1 : find(identity - offset);
      },
      itemOfFace(row) {
        const at = find(row);
        return at < 0 ? undefined : itemOf(at);
      },
      summary: () => {
        if (count === 0) return "3D chart with no points to show.";
        const groups = series
          ? new Set(Array.from(rows.subarray(0, count), (row) => series.codes[row])).size
          : 1;
        const what = `${count} ${count === 1 ? "point" : "points"}${series ? ` in ${groups} series` : ""}`;
        return `${what} at ${this.#fields.join(", ")}${tones ? `, colored by ${spec.color}` : ""}.`;
      },
    };
  }
}

/** The row identity in an item key of layer `id`, or undefined. */
export function identityIn(key: string, id: string | number): number | undefined {
  let parts: unknown;
  try {
    parts = JSON.parse(key);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parts) || parts.length !== 2 || parts[0] !== id) return undefined;
  return typeof parts[1] === "number" ? parts[1] : undefined;
}

/** The legend and color key of a set of points. */
function groupKey(id: string | number, series: string | undefined): string {
  return JSON.stringify({ mark: id, series });
}

/**
 * Points in a 3D chart at the number or time fields `x`, `y`, and `z` (z is
 * vertical), colored by series or by a number field as `point` marks are.
 *
 * ```ts
 * point3d(iris, { x: "sepalLength", y: "sepalWidth", z: "petalLength", series: "species" })
 * ```
 */
export function point3d<S extends Schema>(
  table: Table<S>,
  options: Point3DOptions<S>,
): ChartMark<Frozen<Point3DSpec>> {
  const spec: Point3DSpec = {
    type: "point3d",
    x: options.x,
    y: options.y,
    z: options.z,
    ...definedFields(options, [
      "series",
      "name",
      "r",
      "color",
      "colorMidpoint",
      "fill",
      "fillOpacity",
      "label",
      "id",
    ]),
  };
  if (options.colors) spec.colors = [...options.colors];
  if (options.colorDomain) spec.colorDomain = [options.colorDomain[0], options.colorDomain[1]];
  if (table.name !== undefined) spec.data = table.name;
  // Field names were checked against S above; marks work on the erased schema.
  return new Point3DMark(spec, table as unknown as Table);
}
