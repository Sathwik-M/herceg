import type { NumericField, Schema, Table } from "../data/table.ts";
import { textDrawing } from "../draw/text.ts";
import { LabelBoxes } from "../layout/label-boxes.ts";
import type { TextGeometry } from "../scene/scene.ts";
import type { Frozen, TextSpec } from "../spec/spec.ts";
import { AnnotationData, position, readsTable, type TextField, valueAt } from "./annotation.ts";
import { definedFields } from "./line.ts";
import { type AxisFormat, type Frame, frozen, type Mark, type MarkKey, seriesKey } from "./mark.ts";

interface TextStyle {
  /** The y axis the values are on: "left" (default) or "right", the chart's `yRight`. */
  axis?: "left" | "right";
  /** With the chart's `facet`, draw all rows in every panel instead of splitting them. */
  facet?: "repeat";
  /** With the chart's `panels`, the id of the panel to draw in, or "*" for every panel. */
  panel?: string;
  /** Defaults to the theme's text color. */
  fill?: string;
  /** Which end of the text is at the point. Default "middle". */
  anchor?: "start" | "middle" | "end";
  /** Pixel offsets from the point; positive dy moves down. */
  dx?: number;
  dy?: number;
  /**
   * Labels that would cover an earlier one of this mark, in row order:
   * drawn anyway ("show", the default), left out ("hide"), or moved
   * ("move"): kept where they are put when that is free and in the plot,
   * else tried above, below, beside, and at the corners of their point, off
   * the other rows' points, and left out when nothing fits.
   */
  overlap?: "show" | "hide" | "move";
  id?: string;
}

/** Room kept around each label against others, in pixels; a halo reaches 1.5. */
const LABEL_GAP = 2;
/** Room between a moved label and its point, in pixels. */
const POINT_GAP = 5;
/** Half the side of the box a labeled point keeps clear of moved labels, in pixels: a dot. */
const POINT_SIZE = 3;
/**
 * Where a moved label may go, as directions from its point: above, below,
 * after, before, then the corners.
 */
const AROUND: readonly (readonly [number, number])[] = [
  [0, -1],
  [0, 1],
  [1, 0],
  [-1, 0],
  [1, -1],
  [-1, -1],
  [1, 1],
  [-1, 1],
];
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
export class TextMark implements Mark<Frozen<TextSpec>> {
  readonly spec: Frozen<TextSpec>;
  readonly tooltip = "x";
  readonly #data: AnnotationData;

  constructor(input: TextSpec, table?: Table) {
    this.spec = frozen(input);
    // Read from the copy: the caller may change what it passed.
    const spec = this.spec;
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
    const { plot, theme } = frame;
    const data = this.#data;
    const id = seriesKey(key, "text");
    const x = data.channel(spec.x);
    const y = data.channel(spec.y);
    const anchor = spec.anchor ?? "middle";
    const dx = spec.dx ?? 0;
    const dy = spec.dy ?? 0;
    const overlap = spec.overlap ?? "show";
    const placed = overlap === "show" ? undefined : new LabelBoxes();
    const moving = overlap === "move";
    const font = `${theme.fontSize}px ${theme.font}`;
    // Half a label's height, with the room kept around it.
    const half = Math.ceil(theme.fontSize * 0.6) + LABEL_GAP;
    const inPlot = (x0: number, y0: number, x1: number, y1: number) =>
      x0 >= plot.x && x1 <= plot.x + plot.width && y0 >= plot.y && y1 <= plot.y + plot.height;
    const pointAt = (row: number) => [frame.x.map(valueAt(x, row)), frame.y.map(valueAt(y, row))];
    // Moved labels keep off the points of the other rows in view.
    const dots = moving ? new LabelBoxes() : undefined;
    const dotOf = new Int32Array(dots ? data.count : 0).fill(-1);
    if (dots) {
      for (let row = 0; row < data.count; row++) {
        const [px, py] = pointAt(row) as [number, number];
        const s = POINT_SIZE;
        if (inPlot(px, py, px, py)) dotOf[row] = dots.add(px - s, py - s, px + s, py + s);
      }
    }
    const coords = frame.floats(id, "text", data.count * 2);
    const labels: string[] = [];
    for (let row = 0; row < data.count; row++) {
      const [px, py] = pointAt(row) as [number, number];
      // Labels are not clipped, so ones whose point is out of view are left out.
      if (!inPlot(px, py, px, py)) continue;
      const label = data.text(row, frame.locale);
      let lx = px + dx;
      let ly = py + dy;
      if (placed) {
        // Empty labels draw nothing, so they take no room.
        if (label === "") continue;
        const width = frame.measure(label, font);
        // From the anchor to the label's center, and half its box's width.
        const shift = anchor === "start" ? width / 2 : anchor === "end" ? -width / 2 : 0;
        const reach = width / 2 + LABEL_GAP;
        // Places are boxes' centers: the author's, then, when moving, the
        // spots around the point, nearest sides first.
        const side = POINT_GAP + reach;
        const level = POINT_GAP + half;
        let found = false;
        for (let p = 0; p < (moving ? 9 : 1) && !found; p++) {
          const [cx, cy] =
            p === 0
              ? [lx + shift, ly]
              : [px + AROUND[p - 1]![0] * side, py + AROUND[p - 1]![1] * level];
          const [x0, y0, x1, y1] = [cx - reach, cy - half, cx + reach, cy + half];
          // Moving labels stay in the plot, and moved ones off other points.
          if (moving && !inPlot(x0, y0, x1, y1)) continue;
          if (p > 0 && dots!.hits(x0, y0, x1, y1, dotOf[row])) continue;
          if (placed.hits(x0, y0, x1, y1)) continue;
          placed.add(x0, y0, x1, y1);
          lx = cx - shift;
          ly = cy;
          found = true;
        }
        if (!found) continue;
      }
      coords[labels.length * 2] = lx;
      coords[labels.length * 2 + 1] = ly;
      labels.push(label);
    }
    if (labels.length === 0) return [];
    return [
      {
        kind: "text",
        draw: textDrawing,
        halo: true,
        key: id,
        fill: spec.fill ?? theme.text,
        anchor,
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
    ...definedFields(options, [
      "id",
      "label",
      "text",
      "fill",
      "anchor",
      "dx",
      "dy",
      "overlap",
      "axis",
      "facet",
      "panel",
    ]),
  };
  if (table?.name !== undefined && readsTable([spec.x, spec.y], spec.text)) {
    spec.data = table.name;
  }
  return new TextMark(spec, table as unknown as Table | undefined);
}
