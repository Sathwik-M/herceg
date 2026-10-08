// Custom marks: a JavaScript `draw` function places shapes using the chart's
// scales. They share axes, viewport, and rendering (SVG, Canvas, static SVG)
// with built-in marks, but are not portable: a chart spec cannot hold one.
// Over one x field and y fields, a custom mark shows series as a line does,
// so tooltips, the keyboard, the legend, facets, and summaries reach it
// through the chart's own machinery rather than code of their own.

import type { CategoryField, NumericField, Schema, Table } from "../data/table.ts";
import { n } from "../draw/markup.ts";
import { shapesDrawing } from "../draw/shapes.ts";
import type { PathShape, Rect, ShapesGeometry, TextShape } from "../scene/scene.ts";
import type { Theme } from "../theme.ts";
import { definedFields } from "./line.ts";
import {
  type AxisFormat,
  buildSeries,
  CATEGORY,
  type Frame,
  type Mark,
  type MarkKey,
  NUMERIC,
  type Palette,
  requireField,
  SeriesSplitter,
  seriesKey,
} from "./mark.ts";
import { type Series, xExtent, yExtent } from "./series.ts";
import { unionExtent } from "./trace.ts";

/** Style of a shape. Without `fill` or `stroke`, shapes are filled with the theme's text color. */
export interface ShapeStyle {
  fill?: string;
  stroke?: string;
  /** Default 1. */
  strokeWidth?: number;
  /** From 0 to 1. Default 1. */
  opacity?: number;
  /** SVG-style dash pattern in pixels. */
  dash?: readonly number[];
}

export interface TextShapeStyle {
  /** Defaults to the theme's text color. */
  fill?: string;
  /** Which end of the text is at the point. Default "middle". */
  anchor?: "start" | "middle" | "end";
}

/**
 * What a custom mark's `draw` receives: the chart's scales and shape
 * functions. Positions are in CSS pixels; `x` and `y` turn data values into
 * them (times in epoch milliseconds; band indices on category axes).
 */
export interface DrawContext {
  x(value: number): number;
  y(value: number): number;
  /** The visible data range of each axis. */
  domain: { x: readonly [number, number]; y: readonly [number, number] };
  /** Band width in pixels on category axes; 0 on others. */
  bandwidth: { x: number; y: number };
  /** The area inside the axes; shapes are clipped to it. */
  plot: Rect;
  theme: Theme;
  /** A path in SVG path syntax, such as "M0 0L10 10". */
  path(d: string, style?: ShapeStyle): void;
  rect(x: number, y: number, width: number, height: number, style?: ShapeStyle): void;
  circle(cx: number, cy: number, r: number, style?: ShapeStyle): void;
  line(x1: number, y1: number, x2: number, y2: number, style?: ShapeStyle): void;
  /** Text vertically centered on `y`. */
  text(x: number, y: number, text: string, style?: TextShapeStyle): void;
}

/**
 * A series a custom mark shows: one y field, or one value of the `series`
 * field. Its points are rows of the mark's table.
 */
export interface CustomSeries {
  /** Identifies the series in the chart, as in legend state and events. */
  readonly key: string;
  /** Its name in the legend and tooltips. */
  readonly label: string;
  /** The color of its legend entry and tooltip swatch. */
  readonly color: string;
  /** The x and y columns, indexed by row. */
  readonly x: ArrayLike<number>;
  readonly y: ArrayLike<number>;
  /** The rows it holds, in table order; undefined when it holds every row. */
  readonly rows: ArrayLike<number> | undefined;
  /** How many rows it holds. */
  readonly length: number;
}

/** The draw context of a custom mark over a table. */
export interface DataDrawContext<S extends Schema> extends DrawContext {
  table: Table<S>;
  /**
   * The series to draw: those the legend has not hidden, each holding only
   * this panel's rows in charts with facets. Empty for marks without series.
   */
  series: readonly CustomSeries[];
}

interface CustomBase {
  /** A sentence for the chart's text alternative, saying what the mark shows. */
  description?: string;
  /** The y axis `y` maps to: "left" (default) or "right", the chart's `yRight`. */
  axis?: "left" | "right";
  /** With the chart's `facet`, draw all rows in every panel instead of splitting them. */
  facet?: "repeat";
  /** With the chart's `panels`, the id of the panel to draw in, or "*" for every panel. */
  panel?: string;
  id?: string;
}

/** A custom mark that only uses the scales other marks set. */
export interface CustomOptions extends CustomBase {
  draw(context: DrawContext): void;
}

/**
 * A custom mark over a table, whose fields count toward the axis domains.
 * With one `x` field and `y` fields, it shows series as a line does.
 */
export interface CustomDataOptions<S extends Schema> extends CustomBase {
  /** Fields whose values the mark places along x; a time field gives a time axis. */
  x?: NumericField<S> | readonly NumericField<S>[];
  /**
   * Fields whose values the mark places along y. With one `x` field, each
   * is a series (or one field is split by `series`), with a legend entry,
   * tooltips, and keyboard stops at its points.
   */
  y?: NumericField<S> | readonly NumericField<S>[];
  /**
   * Category field: one series per value, for one `x` and one `y` field.
   * `false`: no series; the fields only count toward the axis domains, for
   * glyphs drawn from several fields of a row, such as ranges.
   */
  series?: CategoryField<S> | false;
  /** Name of a single series in legends and tooltips. Defaults to the y field. */
  label?: string;
  /**
   * Tooltip text for a row of a series, by default its y value; `format`
   * formats values as the chart's x and y axes and other numbers.
   */
  pointText?(row: number, format: AxisFormat, series: CustomSeries): string;
  draw(context: DataDrawContext<S>): void;
}

/**
 * A custom mark's spec: its identity and, when it shows series, their
 * fields. `draw` and `pointText` cannot be serialized.
 */
export interface CustomSpec {
  type: "custom";
  id?: string;
  axis?: "left" | "right";
  facet?: "repeat";
  /** With the chart's `panels`, the id of the panel to draw in, or "*" for every panel. */
  panel?: string;
  /** The x field of the series. */
  x?: string;
  /** The y field of each series, or the one split by `series`. */
  y?: string | string[];
  series?: string;
  label?: string;
}

/** [min, max] of a field's finite values (cached by the table); positive ones on log axes. */
function fieldExtent(
  table: Table,
  field: string,
  log: boolean,
): readonly [number, number] | undefined {
  if (!log) return table.extent(field as never);
  const values = table.numbers(field as never);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const value = values[i]!;
    if (!(value > 0 && value < Infinity)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return min <= max ? [min, max] : undefined;
}

export class CustomMark implements Mark<CustomSpec> {
  readonly spec: CustomSpec;
  readonly table: Table | undefined;
  readonly tooltip = "x";
  readonly #x: readonly string[];
  readonly #y: readonly string[];
  /** Splits the table into series, when the mark shows any. */
  readonly #split: SeriesSplitter | undefined;
  readonly #draw: (context: DataDrawContext<Schema>) => void;
  readonly #pointText: CustomDataOptions<Schema>["pointText"];
  readonly #description: string | undefined;

  constructor(table: Table | undefined, options: CustomDataOptions<Schema>) {
    const spec: CustomSpec = {
      type: "custom",
      ...definedFields(options, ["id", "axis", "facet", "panel"]),
    };
    this.table = table;
    const list = (fields: string | readonly string[] | undefined) =>
      fields === undefined ? [] : typeof fields === "string" ? [fields] : [...fields];
    this.#x = list(options.x);
    this.#y = list(options.y);
    for (const [axis, fields] of [
      ["x", this.#x],
      ["y", this.#y],
    ] as const) {
      if (fields.length > 0 && !table)
        throw new Error(`A custom mark with ${axis} fields needs a table`);
      for (const field of fields) requireField(table!, field, NUMERIC, `custom ${axis}`);
    }
    // A point of a series is a row's (x, y). Other fields, such as both
    // ends of horizontal spans, only count toward the axis domains, as do
    // all fields with `series: false`.
    const field = options.series === false ? undefined : options.series;
    if (this.#x.length === 1 && this.#y.length > 0 && options.series !== false) {
      if (field !== undefined) requireField(table!, field, CATEGORY, "custom series");
      this.#split = new SeriesSplitter(table!, this.#x[0], this.#y, field, options.label);
      spec.x = this.#x[0]!;
      spec.y = typeof options.y === "string" ? options.y : [...this.#y];
      if (field !== undefined) spec.series = field;
      if (options.label !== undefined) spec.label = options.label;
    } else if (field !== undefined || options.label !== undefined || options.pointText) {
      throw new Error(
        "A custom mark's series, label, and pointText need one x field and y fields, and no series: false",
      );
    }
    this.spec = spec;
    this.#draw = options.draw;
    this.#pointText = options.pointText;
    this.#description = options.description;
  }

  channelKind(axis: "x" | "y") {
    const fields = axis === "x" ? this.#x : this.#y;
    if (fields.length === 0) return undefined;
    return fields.some((field) => this.table!.kind(field as never) === "time") ? "time" : "number";
  }

  series(key: MarkKey, palette: Palette): Series[] {
    if (!this.#split) return [];
    const x = this.table!.numbers(this.#x[0] as never);
    return buildSeries(this.table!, this.#split.sources(), x, key, palette, undefined);
  }

  xExtent(series: readonly Series[], log: boolean): readonly [number, number] | undefined {
    if (this.#split) return unionExtent(series.map((s) => xExtent(s, log)));
    return unionExtent(this.#x.map((field) => fieldExtent(this.table!, field, log)));
  }

  /**
   * Series fit y to what the x range shows, taking in the points just past
   * its edges: shapes between neighboring points may be steps or glyphs
   * rather than straight segments, and staying between the neighbors'
   * values keeps them in view. Other fields count whole.
   */
  yExtent(series: readonly Series[], x0: number, x1: number, log: boolean) {
    if (!this.#split)
      return unionExtent(this.#y.map((field) => fieldExtent(this.table!, field, log)));
    return unionExtent(series.map((s) => yExtent(s, x0, x1, s.y, log, undefined, true)));
  }

  /** Tooltip text for a row: the `pointText` option's, or the series' value. */
  pointText(series: Series, row: number, format: AxisFormat): string {
    return this.#pointText ? this.#pointText(row, format, series) : format.y(series.values[row]!);
  }

  describe(): string | undefined {
    return this.#description;
  }

  geometry(series: readonly Series[], frame: Frame, key: MarkKey): ShapesGeometry[] {
    const { theme } = frame;
    const shapes: (PathShape | TextShape)[] = [];
    const path = (d: string, style: ShapeStyle = {}) => {
      // A stroke of "none" or of no width is no stroke, on Canvas as in SVG.
      const width = style.strokeWidth ?? 1;
      const stroke =
        style.stroke !== undefined && style.stroke !== "none" && width > 0 && width < Infinity
          ? style.stroke
          : undefined;
      const opacity = style.opacity ?? 1;
      shapes.push({
        d,
        fill: style.fill ?? (stroke === undefined ? theme.text : "none"),
        stroke,
        strokeWidth: stroke === undefined ? 0 : width,
        opacity: opacity >= 0 && opacity <= 1 ? opacity : opacity > 1 ? 1 : 0,
        dash: style.dash,
      });
    };
    // Without a table, `table` is undefined; the table-free context's type has none.
    const context: DataDrawContext<Schema> = {
      table: this.table!,
      // Hidden series are not drawn, as with other marks.
      series: series.filter((s) => !frame.hidden.has(s.key)),
      x: (value) => frame.x.map(value),
      y: (value) => frame.y.map(value),
      domain: { x: frame.x.domain, y: frame.y.domain },
      bandwidth: { x: Math.abs(frame.x.bandwidth ?? 0), y: Math.abs(frame.y.bandwidth ?? 0) },
      plot: frame.plot,
      theme,
      path,
      rect: (x, y, width, height, style) =>
        path(`M${n(x)} ${n(y)}h${n(width)}v${n(height)}h${n(-width)}Z`, style),
      circle: (cx, cy, r, style) =>
        path(
          `M${n(cx - r)} ${n(cy)}a${n(r)} ${n(r)} 0 1 0 ${n(2 * r)} 0a${n(r)} ${n(r)} 0 1 0 ${n(-2 * r)} 0Z`,
          style,
        ),
      line: (x1, y1, x2, y2, style) =>
        path(`M${n(x1)} ${n(y1)}L${n(x2)} ${n(y2)}`, {
          ...style,
          stroke: style?.stroke ?? theme.text,
          fill: "none",
        }),
      text: (x, y, text, style = {}) => {
        const fill = style.fill ?? theme.text;
        if (fill === "none") return;
        shapes.push({ text, x, y, fill, anchor: style.anchor ?? "middle" });
      },
    };
    this.#draw(context);
    if (shapes.length === 0) return [];
    return [
      {
        kind: "shapes",
        draw: shapesDrawing,
        key: seriesKey(key, "custom"),
        shapes,
        font: `${theme.fontSize}px ${theme.font}`,
        fontSize: theme.fontSize,
      },
    ];
  }
}

/**
 * A custom mark: `draw` places shapes with the chart's scales on every
 * frame. With a table, the `x` and `y` fields count toward the axis
 * domains; with one `x` field, the `y` fields are series, which `draw`
 * receives, with legend entries and tooltips. JavaScript only: chart specs
 * (and so the Python package) cannot hold custom marks.
 *
 * ```ts
 * custom(load, {
 *   x: "time",
 *   y: "cpu",
 *   series: "host",
 *   draw({ series, x, y, line, circle }) {
 *     for (const s of series) {
 *       for (let k = 0; k < s.length; k++) {
 *         const row = s.rows ? s.rows[k]! : k;
 *         const [px, py] = [x(s.x[row]!), y(s.y[row]!)];
 *         line(px, y(0), px, py, { stroke: s.color });
 *         circle(px, py, 4, { fill: s.color });
 *       }
 *     }
 *   },
 * })
 * ```
 */
export function custom(options: CustomOptions): CustomMark;
export function custom<S extends Schema>(
  table: Table<S>,
  options: CustomDataOptions<S>,
): CustomMark;
export function custom<S extends Schema>(
  first: Table<S> | CustomOptions,
  second?: CustomDataOptions<S>,
): CustomMark {
  const table = second ? (first as Table<S>) : undefined;
  const options = (second ?? first) as CustomDataOptions<S>;
  // Field names were checked against S above; marks work on the erased schema.
  return new CustomMark(
    table as unknown as Table | undefined,
    options as unknown as CustomDataOptions<Schema>,
  );
}
