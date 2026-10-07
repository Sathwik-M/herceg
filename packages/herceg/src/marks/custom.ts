// Custom marks: a JavaScript `draw` function places shapes using the chart's
// scales. They share axes, viewport, and rendering (SVG, Canvas, static SVG)
// with built-in marks, but are not portable: a chart spec cannot hold one.

import type { NumericField, Schema, Table } from "../data/table.ts";
import { n } from "../draw/markup.ts";
import { shapesDrawing } from "../draw/shapes.ts";
import type { PathShape, Rect, ShapesGeometry, TextShape } from "../scene/scene.ts";
import type { Theme } from "../theme.ts";
import { definedFields } from "./line.ts";
import { type Frame, type Mark, type MarkKey, NUMERIC, requireField, seriesKey } from "./mark.ts";
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

/** The draw context of a custom mark over a table. */
export interface DataDrawContext<S extends Schema> extends DrawContext {
  table: Table<S>;
}

interface CustomBase {
  /** A sentence for the chart's text alternative, saying what the mark shows. */
  description?: string;
  /** The y axis `y` maps to: "left" (default) or "right", the chart's `yRight`. */
  axis?: "left" | "right";
  id?: string;
}

/** A custom mark that only uses the scales other marks set. */
export interface CustomOptions extends CustomBase {
  draw(context: DrawContext): void;
}

/** A custom mark over a table, whose fields count toward the axis domains. */
export interface CustomDataOptions<S extends Schema> extends CustomBase {
  /** Fields whose values the mark places along x; a time field gives a time axis. */
  x?: NumericField<S> | readonly NumericField<S>[];
  y?: NumericField<S> | readonly NumericField<S>[];
  draw(context: DataDrawContext<S>): void;
}

/** A custom mark's spec: only its identity, since `draw` cannot be serialized. */
export interface CustomSpec {
  type: "custom";
  id?: string;
  axis?: "left" | "right";
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
  readonly #draw: (context: DataDrawContext<Schema>) => void;
  readonly #description: string | undefined;

  constructor(table: Table | undefined, options: CustomDataOptions<Schema>) {
    this.spec = { type: "custom", ...definedFields(options, ["id", "axis"]) };
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
    this.#draw = options.draw;
    this.#description = options.description;
  }

  channelKind(axis: "x" | "y") {
    const fields = axis === "x" ? this.#x : this.#y;
    if (fields.length === 0) return undefined;
    return fields.some((field) => this.table!.kind(field as never) === "time") ? "time" : "number";
  }

  series() {
    return [];
  }

  xExtent(_series: unknown, log: boolean): readonly [number, number] | undefined {
    return unionExtent(this.#x.map((field) => fieldExtent(this.table!, field, log)));
  }

  yExtent(_series: unknown, _x0: number, _x1: number, log: boolean) {
    return unionExtent(this.#y.map((field) => fieldExtent(this.table!, field, log)));
  }

  describe(): string | undefined {
    return this.#description;
  }

  geometry(_series: unknown, frame: Frame, key: MarkKey): ShapesGeometry[] {
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
 * domains. JavaScript only: chart specs (and so the Python package) cannot
 * hold custom marks.
 *
 * ```ts
 * custom(prices, {
 *   x: "time",
 *   y: ["low", "high"],
 *   draw({ table, x, y, line }) {
 *     const t = table.numbers("time");
 *     const low = table.numbers("low");
 *     const high = table.numbers("high");
 *     for (let i = 0; i < t.length; i++) line(x(t[i]!), y(low[i]!), x(t[i]!), y(high[i]!));
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
