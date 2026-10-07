import type { NumericField, Schema, Table } from "../data/table.ts";
import { textDrawing } from "../draw/text.ts";
import type { TextGeometry } from "../scene/scene.ts";
import type { TextSpec } from "../spec/spec.ts";
import { AnnotationData, position, readsTable, type TextField, valueAt } from "./annotation.ts";
import { definedFields } from "./line.ts";
import { type AxisFormat, type Frame, type Mark, type MarkKey, seriesKey } from "./mark.ts";

interface TextStyle {
  /** Defaults to the theme's text color. */
  fill?: string;
  /** Which end of the text is at the point. Default "middle". */
  anchor?: "start" | "middle" | "end";
  /** Pixel offsets from the point; positive dy moves down. */
  dx?: number;
  dy?: number;
  id?: string;
}

/** One label at constant values. */
export interface TextOptions extends TextStyle {
  x: number | Date;
  y: number | Date;
  label: string;
}

/**
 * Labels from a table, one per row; positions may also be constants. The
 * text is a field (`text`) or the same for every row (`label`).
 */
export type TextDataOptions<S extends Schema> = TextStyle & {
  x: NumericField<S> | number | Date;
  y: NumericField<S> | number | Date;
} & ({ text: TextField<S>; label?: never } | { label: string; text?: never });

/**
 * Text labels at data positions. They are drawn as SVG above the data and
 * left out when their point is outside the plot; meant for annotations, not
 * for labeling every point of a large series.
 */
export class TextMark implements Mark<TextSpec> {
  readonly spec: TextSpec;
  readonly tooltip = "x";
  readonly #data: AnnotationData;

  constructor(spec: TextSpec, table?: Table) {
    this.spec = spec;
    if (spec.x === undefined || spec.y === undefined) throw new Error("Text needs x and y");
    if ((spec.label === undefined) === (spec.text === undefined))
      throw new Error("Text needs exactly one of label or text");
    this.#data = new AnnotationData(table, { x: spec.x, y: spec.y }, spec.label, spec.text, "text");
  }

  get table(): Table | undefined {
    return this.#data.table;
  }

  channelKind(axis: "x" | "y") {
    return this.#data.kind(axis === "x" ? this.spec.x : this.spec.y);
  }

  series() {
    return [];
  }

  describe(format: AxisFormat, locale: string | undefined): string | undefined {
    const x = this.#data.channel(this.spec.x);
    const y = this.#data.channel(this.spec.y);
    return this.#data.summary(["Label", "Labels"], locale, (i) => {
      const at = valueAt(x, i);
      const value = valueAt(y, i);
      return Number.isFinite(at) && Number.isFinite(value)
        ? `x ${format.x(at)}, y ${format.y(value)}`
        : undefined;
    });
  }

  xExtent(_series: unknown, log: boolean): [number, number] | undefined {
    return this.#data.extent([this.spec.x], log);
  }

  yExtent(_series: unknown, x0: number, x1: number, log: boolean): [number, number] | undefined {
    // Only labels inside the x view count toward y.
    const x = this.#data.channel(this.spec.x);
    const lo = Math.min(x0, x1);
    const hi = Math.max(x0, x1);
    return this.#data.extent([this.spec.y], log, (i) => {
      const value = valueAt(x, i);
      return value >= lo && value <= hi;
    });
  }

  geometry(_series: unknown, frame: Frame, key: MarkKey): TextGeometry[] {
    const { spec } = this;
    const { plot } = frame;
    const data = this.#data;
    const id = seriesKey(key, "text");
    const x = data.channel(spec.x);
    const y = data.channel(spec.y);
    const coords = frame.floats(id, "text", data.count * 2);
    const labels: string[] = [];
    const dx = spec.dx ?? 0;
    const dy = spec.dy ?? 0;
    for (let i = 0; i < data.count; i++) {
      const px = frame.x.map(valueAt(x, i));
      const py = frame.y.map(valueAt(y, i));
      // Labels are not clipped, so ones whose point is out of view are left out.
      if (
        !(px >= plot.x && px <= plot.x + plot.width && py >= plot.y && py <= plot.y + plot.height)
      )
        continue;
      coords[labels.length * 2] = px + dx;
      coords[labels.length * 2 + 1] = py + dy;
      labels.push(data.text(i, frame.locale));
    }
    if (labels.length === 0) return [];
    return [
      {
        kind: "text",
        draw: textDrawing,
        key: id,
        fill: spec.fill ?? frame.theme.text,
        anchor: spec.anchor ?? "middle",
        coords,
        labels,
        count: labels.length,
      },
    ];
  }
}

/**
 * Text at data positions: one label at constant values, or one per row of a
 * table.
 *
 * ```ts
 * text({ x: launch, y: 120, label: "Launch", anchor: "start", dx: 6 })
 * text(peaks, { x: "time", y: "value", text: "value", dy: -10 })
 * ```
 */
export function text(options: TextOptions): TextMark;
export function text<S extends Schema>(table: Table<S>, options: TextDataOptions<S>): TextMark;
export function text<S extends Schema>(
  first: Table<S> | TextOptions,
  second?: TextDataOptions<S>,
): TextMark {
  const table = second ? (first as Table<S>) : undefined;
  const options = (second ?? first) as TextDataOptions<S>;
  const spec: TextSpec = {
    type: "text",
    x: position(options.x),
    y: position(options.y),
    ...definedFields(options, ["id", "label", "text", "fill", "anchor", "dx", "dy"]),
  };
  if (table?.name !== undefined && readsTable([spec.x, spec.y], spec.text)) {
    spec.data = table.name;
  }
  return new TextMark(spec, table as unknown as Table | undefined);
}
