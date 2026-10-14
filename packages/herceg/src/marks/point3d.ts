// Points of a 3D chart at (x, y, z): one disc each, in the chart's faces,
// so they are drawn in depth order with the chart's other layers. Rows are
// read once per scene in row order, so the drawn rows are the reading order
// and need no sort.

import type { CategoryField, NumberField, NumericField, Schema, Table } from "../data/table.ts";
import { symbolPath } from "../draw/symbols.ts";
import { formatNumber } from "../format/format.ts";
import { ItemViews } from "../model/item-views.ts";
import type { LegendEntry } from "../model/legend.ts";
import type { ChartConfig } from "../model/model.ts";
import {
  checkColorScale,
  checkRamp,
  isOpaqueColor,
  rampOf,
  SequentialScale,
} from "../scale/color.ts";
import type { PointBatch3D } from "../scene/scene.ts";
import type { Frozen, Point3DSpec } from "../spec/spec.ts";
import type { Theme } from "../theme.ts";
import type { View } from "../three/camera.ts";
import { ScreenGrid } from "../three/hit.ts";
import { Appearance, categoryColors, categoryTones, colorKey } from "./appearance.ts";
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
  inFront,
  joinLayers3D,
  type Layer3D,
  PerChart,
  type Placed3D,
  positiveExtent,
} from "./plot3d.ts";
import { checkTooltip, type MarkTooltip } from "./tooltip-fields.ts";

export interface Point3DOptions<S extends Schema> {
  /** Number or time fields: each point's position; z is vertical. */
  x: NumericField<S>;
  y: NumericField<S>;
  z: NumericField<S>;
  /** Category field: one colored set of points per value, with a legend. */
  series?: CategoryField<S>;
  /** Category field naming each point, for tooltips and keyboard reading. */
  labelField?: CategoryField<S>;
  /** Radius in pixels; default 3.5. */
  radius?: number;
  /**
   * A number field colored on a continuous scale, with a color legend; or a
   * category field whose values take the theme's palette in order of
   * appearance, with a key of them (the `series` field keeps its series' colors).
   */
  color?: NumberField<S> | CategoryField<S>;
  /** Colors for a number `color`, low to high; the theme's ramp by default. */
  colors?: readonly string[];
  colorDomain?: readonly [number, number];
  colorMidpoint?: number;
  fill?: string;
  /** Default 1. */
  fillOpacity?: number;
  /** Legend and tooltip name of points without `series`. */
  label?: string;
  /** Fields of the row tooltips show besides the mark's values, such as counts that are not plotted. */
  tooltip?: MarkTooltip<S>;
  /** The subplot whose 3D box this layer shares. */
  panel?: string;
  id?: string;
}

const RADIUS = 3.5;
/** Radius of the circles in the legend and the color key. */
const LEGEND_RADIUS = 4.5;
/** Pointer reach past a point's edge, in pixels, as on the CPU (three/faces.ts). */
const REACH = 3;

/** A set of points in the legend: a category of `series`, or every point. */
interface Group {
  label: string;
  category: string | undefined;
  /** The category's code; -1 without `series`. */
  code: number;
}

/** The rows a layer draws, in row order, for one chart's axes and series shown. */
interface Reading {
  key: string;
  rows: Uint32Array;
  count: number;
}

/** Where the rows drawn are on screen for one view, for the pointer when a GPU painter draws them. */
interface Screen {
  view: View;
  reading: Reading;
  x: Float32Array;
  y: Float32Array;
  depth: Float32Array;
  grid: ScreenGrid;
}

const readings = new PerChart<Reading>();
const screens = new PerChart<Screen>();

export class Point3DMark implements Layer3D {
  declare readonly [MARK]: true;
  readonly layout = true;
  readonly views = ItemViews;
  readonly dimensions = 3;
  readonly spec: Frozen<Point3DSpec>;
  readonly table: Table;
  readonly measure: string;
  readonly #fields: readonly [string, string, string];
  #held: { version: number; groups: readonly Group[] } | undefined;
  /** Each row's color index for GPU painters, for the table version, shown series, and colors in `key`. */
  #cloudStyle: { key: string; style: Uint8Array } | undefined;
  /** A number `color`, colored on a continuous scale. */
  readonly #toneField: string | undefined;
  /** A category `color` other than the series field, its values in order of appearance. */
  readonly #colorField: Appearance | undefined;

  constructor(input: Point3DSpec, table: Table) {
    this.spec = frozen(input);
    checkTooltip(table, this.spec.tooltip, "point3d");
    // Read from the copy: the caller may change what it passed.
    const spec = this.spec;
    for (const axis of ["x", "y", "z"] as const)
      requireField(table, spec[axis], ["number", "time"], `point3d ${axis}`);
    if (spec.series !== undefined) requireField(table, spec.series, ["category"], "point3d series");
    if (spec.labelField !== undefined)
      requireField(table, spec.labelField, ["category"], "point3d labelField");
    if (spec.color !== undefined) {
      requireField(table, spec.color, ["number", "category"], "point3d color");
      if (table.kind(spec.color) === "number") this.#toneField = spec.color;
      else if (
        spec.colors !== undefined ||
        spec.colorDomain !== undefined ||
        spec.colorMidpoint !== undefined
      )
        throw new Error(
          `point3d colors: "${spec.color}" is a category field, colored by the theme's palette; drop colors, colorDomain, and colorMidpoint`,
        );
      else if (spec.color !== spec.series) this.#colorField = new Appearance(spec.color);
    }
    if (Array.isArray(spec.colors)) checkRamp(spec.colors, "point3d colors");
    checkColorScale(spec.colorDomain, spec.colorMidpoint, "point3d");
    if (spec.radius !== undefined && !(spec.radius > 0 && Number.isFinite(spec.radius)))
      throw new RangeError(
        `point3d radius: expected a positive number of pixels; received ${spec.radius}`,
      );
    if (spec.fillOpacity !== undefined && !(spec.fillOpacity >= 0 && spec.fillOpacity <= 1))
      throw new RangeError(
        `point3d fillOpacity: expected a number from 0 to 1; received ${spec.fillOpacity}`,
      );
    this.table = table;
    this.#fields = [spec.x, spec.y, spec.z];
    this.measure = spec.label ?? "Points";
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

  #scale(theme: Theme): SequentialScale | undefined {
    const { spec } = this;
    if (this.#toneField === undefined) return undefined;
    const domain = spec.colorDomain ?? this.table.extent(this.#toneField as never);
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
    const glyph = symbolPath("circle", 0, 0, LEGEND_RADIUS);
    const muted = this.#toneField !== undefined || this.#colorField !== undefined;
    return this.#groups().map(({ label, category }) => {
      const key = groupKey(id, category);
      const fill = muted ? theme.muted : (this.spec.fill ?? color(key));
      return { key, label, color: fill, glyph };
    });
  }

  scales(theme: Theme): [ColorRamp[], GlyphKey[]] {
    if (this.#colorField) return [[], [colorKey(this.#colorField, this.table, theme)]];
    const scale = this.#scale(theme);
    if (!scale) return [[], []];
    const { domain, midpoint } = scale;
    return [[{ stops: scale.legendStops(), domain, midpoint, title: this.spec.color! }], []];
  }

  /** A category `color`'s codes, and each code's index into the theme's palette (-1 for none). */
  #categories(theme: Theme): { codes: Int32Array; tones: Int32Array } | undefined {
    const colors = this.#colorField;
    if (!colors) return undefined;
    const { codes } = this.table.categories(colors.field as never);
    return { codes, tones: categoryTones(colors, this.table, theme) };
  }

  /**
   * The points for a GPU painter: each row's color as an index into a
   * palette of the series' colors or the ramp's, 255 for rows not drawn.
   * Translucent points need drawing in order, so they have no batch.
   */
  batch(frame: Frame3D): PointBatch3D | undefined {
    const { spec, table } = this;
    if ((spec.fillOpacity ?? 1) < 1) return undefined;
    const { theme, hidden, id } = frame;
    const scale = this.#scale(theme);
    const categories = this.#categories(theme);
    const groups = this.#groups();
    const fills = groups.map((group) => spec.fill ?? frame.color(groupKey(id, group.category)));
    const shown = groups.map((group) => !hidden.has(groupKey(id, group.category)));
    const palette = categories
      ? categoryColors(theme)
      : this.#toneField === undefined
        ? fills
        : (scale?.colors() ?? []);
    if (palette.length > 255 || !palette.every(isOpaqueColor)) return undefined;
    // Rows' colors are indices, which the colors themselves do not change.
    const key = `${table.version}|${shown.join()}|${palette.length}`;
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
      const tones =
        this.#toneField === undefined ? undefined : table.numbers(this.#toneField as never);
      for (let row = 0; row < table.length; row++) {
        const code = codes ? codes[row]! : 0;
        const g = code >= 0 ? groupOf[code]! : -1;
        if (g < 0 || !shown[g]) continue;
        if (categories) {
          const tone = categories.tones[categories.codes[row]!] ?? -1;
          if (tone >= 0) style[row] = tone;
        } else if (!tones) style[row] = g;
        else if (scale) {
          const tone = scale.index(tones[row]!);
          if (tone >= 0) style[row] = tone;
        }
      }
      this.#cloudStyle = { key, style };
    }
    const [x, y, z] = this.#fields.map((field) => table.numbers(field as never));
    return {
      kind: "points",
      x: x!,
      y: y!,
      z: z!,
      version: table.version,
      style,
      palette,
      radius: spec.radius ?? RADIUS,
    };
  }

  /**
   * The rows drawn, in row order: of series shown, with a color, and inside
   * the box. Found once per chart for its axes, the table version, and the
   * series shown, so turning the camera finds nothing again.
   */
  #reading(frame: Frame3D): Reading {
    const { spec, table } = this;
    const { axes, hidden, id } = frame;
    const groups = this.#groups();
    const shown = groups.map((group) => !hidden.has(groupKey(id, group.category)));
    const key = `${table.version}|${shown.join()}|${axesKey(axes)}`;
    const held = readings.get(frame);
    if (held?.key === key) return held;
    const n = table.length;
    const [xs, ys, zs] = this.#fields.map((field) => table.numbers(field as never));
    const series = spec.series === undefined ? undefined : table.categories(spec.series as never);
    const codes = series?.codes;
    // Whether each series code (0 standing for every row without `series`) is shown.
    const showsCode = new Uint8Array(series ? series.dictionary.length : 1);
    groups.forEach((group, g) => {
      if (shown[g]) showsCode[Math.max(0, group.code)] = 1;
    });
    // Points colored by a field need a value to color by.
    const tones =
      this.#toneField === undefined ? undefined : table.numbers(this.#toneField as never);
    const colorCodes = this.#colorField
      ? table.categories(this.#colorField.field as never).codes
      : undefined;
    const rows = held && held.rows.length >= n ? held.rows : new Uint32Array(Math.ceil(n * 1.25));
    const [ax, ay, az] = axes;
    let count = 0;
    for (let row = 0; row < n; row++) {
      const code = codes ? codes[row]! : 0;
      if (code < 0 || !showsCode[code]) continue;
      if (tones && !Number.isFinite(tones[row]!)) continue;
      if (colorCodes && colorCodes[row]! < 0) continue;
      // Points outside the box (or without a place on it) are not drawn.
      if (!inBox(ax.place(xs![row]!), ay.place(ys![row]!), az.place(zs![row]!))) continue;
      rows[count++] = row;
    }
    return readings.set(frame, { key, rows, count });
  }

  /**
   * The point a GPU painter shows nearest the eye within reach of (px, py):
   * the drawn rows are projected and filed on screen once per view.
   */
  pick(frame: Frame3D, px: number, py: number): Hit3D | undefined {
    const { view, axes, bounds } = frame;
    const reading = this.#reading(frame);
    let screen = screens.get(frame);
    if (!screen || screen.reading !== reading || !screen.view.same(view)) {
      const { rows, count } = reading;
      const [xs, ys, zs] = this.#fields.map((field) => this.table.numbers(field as never));
      const [ax, ay, az] = axes;
      const x = new Float32Array(count);
      const y = new Float32Array(count);
      const depth = new Float32Array(count);
      const out = new Float64Array(2);
      for (let i = 0; i < count; i++) {
        const row = rows[i]!;
        depth[i] = view.project(
          ax.place(xs![row]!),
          ay.place(ys![row]!),
          az.place(zs![row]!),
          out,
          0,
        );
        x[i] = out[0]!;
        y[i] = out[1]!;
      }
      const grid = new ScreenGrid(bounds, count, (filer) => {
        for (let i = 0; i < count; i++) filer.box(i, x[i]!, y[i]!, x[i]!, y[i]!);
      });
      screen = screens.set(frame, { view, reading, x, y, depth, grid });
    }
    const { x, y, depth } = screen;
    const reach = (this.spec.radius ?? RADIUS) + REACH;
    let best = -1;
    screen.grid.near(px, py, reach, (i) => {
      const dx = x[i]! - px;
      const dy = y[i]! - py;
      if (dx * dx + dy * dy > reach * reach) return;
      // At one depth the later row shows, as the painter draws it.
      if (best < 0 || inFront(depth[i]!, i > best, depth[best]!, view.distance)) best = i;
    });
    return best < 0 ? undefined : { item: this.items(frame).item(best), depth: depth[best]! };
  }

  items(frame: Frame3D): Items3D {
    const { spec, table } = this;
    const { axes, view, id, theme } = frame;
    const { rows, count } = this.#reading(frame);
    const [xs, ys, zs] = this.#fields.map((field) => table.numbers(field as never));
    const names =
      spec.labelField === undefined ? undefined : table.categories(spec.labelField as never);
    const series = spec.series === undefined ? undefined : table.categories(spec.series as never);
    const tones =
      this.#toneField === undefined ? undefined : table.numbers(this.#toneField as never);
    const scale = this.#scale(theme);
    const colorValues = this.#colorField
      ? table.categories(this.#colorField.field as never)
      : undefined;
    const categories = this.#categories(theme);
    const offset = table.rowOffset;
    const radius = spec.radius ?? RADIUS;
    const out = new Float64Array(2);
    const category = (column: typeof names, row: number) => {
      const code = column ? column.codes[row]! : -1;
      return code >= 0 ? column!.dictionary[code]! : undefined;
    };
    const item = (i: number): LayoutItem => {
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
      const tag = category(colorValues, row);
      if (tag !== undefined) {
        parts.push(`${spec.color} ${tag}`);
        data[spec.color!] = tag;
      }
      const name = category(names, row);
      const group = category(series, row);
      if (name !== undefined) data[spec.labelField!] = name;
      if (group !== undefined) data[spec.series!] = group;
      view.project(
        axes[0].place(values[0]!),
        axes[1].place(values[1]!),
        axes[2].place(values[2]!),
        out,
        0,
      );
      const [px, py] = [Math.fround(out[0]!), Math.fround(out[1]!)];
      return {
        key: JSON.stringify([id, offset + row]),
        label: name ?? group ?? `${spec.label ?? "Point"} ${offset + row + 1}`,
        color:
          tones && scale
            ? scale.color(tones[row]!)
            : categories
              ? categoryColors(theme)[categories.tones[categories.codes[row]!]!]!
              : (spec.fill ?? frame.color(groupKey(id, group))),
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
    return {
      count,
      item,
      indexOf(key) {
        const identity = identityIn(key, id);
        return identity === undefined ? -1 : findRow(rows, count, identity - offset);
      },
      summary: () => {
        if (count === 0) return "3D chart with no points to show.";
        const groups = series
          ? new Set(Array.from(rows.subarray(0, count), (row) => series.codes[row])).size
          : 1;
        const what = `${count} ${count === 1 ? "point" : "points"}${series ? ` in ${groups} series` : ""}`;
        const colored = tones || colorValues ? `, colored by ${spec.color}` : "";
        return `${what} at ${this.#fields.join(", ")}${colored}.`;
      },
    };
  }

  place(frame: FaceFrame3D): Placed3D {
    const { view, axes, faces, rank, theme, id } = frame;
    const { spec, table } = this;
    const { rows, count } = this.#reading(frame);
    const [xs, ys, zs] = this.#fields.map((field) => table.numbers(field as never));
    const radius = spec.radius ?? RADIUS;
    const opacity = spec.fillOpacity ?? 1;
    // Each series' style, or with `color` each ramp entry's or palette color's.
    const scale = this.#scale(theme);
    const tones =
      this.#toneField === undefined ? undefined : table.numbers(this.#toneField as never);
    const categories = this.#categories(theme);
    const ramp = categories ? categoryColors(theme) : scale && tones ? scale.colors() : undefined;
    const rampStyles = ramp && new Int32Array(ramp.length).fill(-1);
    const series = spec.series === undefined ? undefined : table.categories(spec.series as never);
    const codes = series?.codes;
    // Each series code's style (the code 0 stands for every row without `series`).
    const styleOfCode = new Int32Array(series ? series.dictionary.length : 1).fill(-1);
    if (!ramp)
      for (const group of this.#groups()) {
        const fill = spec.fill ?? frame.color(groupKey(id, group.category));
        styleOfCode[Math.max(0, group.code)] = faces.styleOf(fill, opacity, radius);
      }
    const out = new Float64Array(2);
    const [ax, ay, az] = axes;
    for (let i = 0; i < count; i++) {
      const row = rows[i]!;
      let style: number;
      if (ramp) {
        const tone = categories
          ? categories.tones[categories.codes[row]!]!
          : scale!.index(tones![row]!);
        style = rampStyles![tone]!;
        if (style < 0) {
          style = faces.styleOf(ramp[tone]!, opacity, radius);
          rampStyles![tone] = style;
        }
      } else style = styleOfCode[codes ? codes[row]! : 0]!;
      const u = ax.place(xs![row]!);
      const v = ay.place(ys![row]!);
      const w = az.place(zs![row]!);
      const depth = view.project(u, v, w, out, 0);
      faces.begin();
      faces.corner(faces.vertex(out[0]!, out[1]!, depth));
      faces.face(style, rank ? rank.key(u, v, w) : 0, depth, row);
    }
    let items: Items3D | undefined;
    return {
      itemOfFace: (row) => {
        const at = findRow(rows, count, row);
        if (at < 0) return undefined;
        items ??= this.items(frame);
        return items.item(at);
      },
    };
  }
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
      "tooltip",
      "series",
      "labelField",
      "radius",
      "color",
      "colorMidpoint",
      "fill",
      "fillOpacity",
      "label",
      "panel",
      "id",
    ]),
  };
  if (options.colors) spec.colors = [...options.colors];
  if (options.colorDomain) spec.colorDomain = [options.colorDomain[0], options.colorDomain[1]];
  if (table.name !== undefined) spec.data = table.name;
  // Field names were checked against S above; marks work on the erased schema.
  return new Point3DMark(spec, table as unknown as Table);
}
