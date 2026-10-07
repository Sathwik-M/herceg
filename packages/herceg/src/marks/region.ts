import type { NumericField, Schema, Table } from "../data/table.ts";
import { rectDrawing } from "../draw/rect.ts";
import { textDrawing } from "../draw/text.ts";
import type { Formatter } from "../format/format.ts";
import type { PositionScale } from "../scale/scale.ts";
import type { RectGeometry, TextGeometry } from "../scene/scene.ts";
import type { Position, RegionSpec } from "../spec/spec.ts";
import {
  AnnotationData,
  type Channel,
  position,
  readsTable,
  type TextField,
  valueAt,
} from "./annotation.ts";
import { definedFields } from "./line.ts";
import { type AxisFormat, type Frame, type Mark, type MarkKey, seriesKey } from "./mark.ts";

interface RegionStyle {
  fill?: string;
  fillOpacity?: number;
  /** Text drawn in the top left corner of every region. */
  label?: string;
  id?: string;
}

/** A region between constant values. */
export interface RegionOptions extends RegionStyle {
  x1?: number | Date;
  x2?: number | Date;
  y1?: number | Date;
  y2?: number | Date;
}

/** Regions from a table, one per row; positions may also be constants. */
export interface RegionDataOptions<S extends Schema> extends RegionStyle {
  x1?: NumericField<S> | number | Date;
  x2?: NumericField<S> | number | Date;
  y1?: NumericField<S> | number | Date;
  y2?: NumericField<S> | number | Date;
  /** Field with each region's text. */
  text?: TextField<S>;
}

const PADDING = 4;

/**
 * Shaded regions: between x1 and x2 across the plot's height, between y1
 * and y2 across its width, or rectangles with both. Their ends are included
 * in the axis domains.
 */
export class RegionMark implements Mark<RegionSpec> {
  readonly spec: RegionSpec;
  readonly tooltip = "x";
  readonly #data: AnnotationData;

  constructor(spec: RegionSpec, table?: Table) {
    this.spec = spec;
    for (const axis of ["x", "y"] as const) {
      if ((spec[`${axis}1`] === undefined) !== (spec[`${axis}2`] === undefined))
        throw new Error(`A region needs both ${axis}1 and ${axis}2, or neither`);
    }
    if (spec.x1 === undefined && spec.y1 === undefined)
      throw new Error("A region needs x1 and x2, y1 and y2, or both");
    this.#data = new AnnotationData(
      table,
      { x1: spec.x1, x2: spec.x2, y1: spec.y1, y2: spec.y2 },
      spec.label,
      spec.text,
      "region",
    );
  }

  get table(): Table | undefined {
    return this.#data.table;
  }

  channelKind(axis: "x" | "y") {
    const [a, b] = this.#pair(axis);
    return this.#data.kind(a) ?? this.#data.kind(b);
  }

  describe(format: AxisFormat, locale: string | undefined): string | undefined {
    const x = this.#channels("x");
    const y = this.#channels("y");
    const range = (channels: [Channel, Channel] | undefined, f: Formatter, i: number) => {
      if (!channels) return "";
      const a = valueAt(channels[0], i);
      const b = valueAt(channels[1], i);
      return Number.isFinite(a) && Number.isFinite(b) ? `${f(a)} to ${f(b)}` : undefined;
    };
    return this.#data.summary(["Region", "Regions"], locale, (i) => {
      const across = range(x, format.x, i);
      const down = range(y, format.y, i);
      if (across === undefined || down === undefined) return undefined;
      return [across && `x ${across}`, down && `y ${down}`].filter(Boolean).join(", ");
    });
  }

  series() {
    return [];
  }

  xExtent(_series: unknown, log: boolean): [number, number] | undefined {
    return this.#data.extent(this.#pair("x"), log);
  }

  yExtent(_series: unknown, x0: number, x1: number, log: boolean): [number, number] | undefined {
    const [a, b] = this.#pair("x");
    if (a === undefined || b === undefined) return this.#data.extent(this.#pair("y"), log);
    // Regions that also span x count toward y only where they overlap the view.
    const start = this.#data.channel(a);
    const end = this.#data.channel(b);
    const lo = Math.min(x0, x1);
    const hi = Math.max(x0, x1);
    return this.#data.extent(this.#pair("y"), log, (i) => {
      const p = valueAt(start, i);
      const q = valueAt(end, i);
      return Math.max(p, q) >= lo && Math.min(p, q) <= hi;
    });
  }

  geometry(_series: unknown, frame: Frame, key: MarkKey): (RectGeometry | TextGeometry)[] {
    const { plot, theme } = frame;
    const data = this.#data;
    const id = seriesKey(key, "region");
    const xs = this.#channels("x");
    const ys = this.#channels("y");
    const rects = frame.floats(id, "rect", data.count * 4);
    const coords = frame.floats(id, "text", data.labeled ? data.count * 2 : 0);
    const labels: string[] = [];
    let count = 0;
    for (let i = 0; i < data.count; i++) {
      // Each region is clipped to the plot, so a label stays in its visible part.
      const across = span(xs, i, frame.x, plot.x, plot.x + plot.width);
      const down = span(ys, i, frame.y, plot.y, plot.y + plot.height);
      if (!across || !down) continue;
      rects[count * 4] = across[0];
      rects[count * 4 + 1] = down[0];
      rects[count * 4 + 2] = across[1] - across[0];
      rects[count * 4 + 3] = down[1] - down[0];
      if (data.labeled) {
        coords[labels.length * 2] = across[0] + PADDING;
        coords[labels.length * 2 + 1] = down[0] + PADDING + theme.fontSize / 2;
        labels.push(data.text(i, frame.locale));
      }
      count++;
    }
    const out: (RectGeometry | TextGeometry)[] = [
      {
        kind: "rect",
        draw: rectDrawing,
        key: id,
        fill: this.spec.fill ?? theme.muted,
        fillOpacity: this.spec.fillOpacity ?? 0.15,
        rects,
        count,
      },
    ];
    if (labels.length > 0) {
      out.push({
        kind: "text",
        draw: textDrawing,
        halo: true,
        key: seriesKey(key, "region label"),
        fill: theme.text,
        anchor: "start",
        coords,
        labels,
        count: labels.length,
      });
    }
    return out;
  }

  #pair(axis: "x" | "y"): [Position | undefined, Position | undefined] {
    return axis === "x" ? [this.spec.x1, this.spec.x2] : [this.spec.y1, this.spec.y2];
  }

  #channels(axis: "x" | "y"): [Channel, Channel] | undefined {
    const [a, b] = this.#pair(axis);
    return a === undefined || b === undefined
      ? undefined
      : [this.#data.channel(a), this.#data.channel(b)];
  }
}

/**
 * Pixel span [start, end] of item i on one axis, clipped to [min, max]; the
 * whole range without channels; undefined when nothing of it is in view.
 */
function span(
  channels: [Channel, Channel] | undefined,
  item: number,
  scale: PositionScale,
  min: number,
  max: number,
): [number, number] | undefined {
  if (!channels) return [min, max];
  const a = place(scale, valueAt(channels[0], item));
  const b = place(scale, valueAt(channels[1], item));
  if (a === undefined || b === undefined) return undefined;
  const start = Math.max(min, Math.min(a, b));
  const end = Math.min(max, Math.max(a, b));
  return end > start ? [start, end] : undefined;
}

/**
 * Pixel of a value, or undefined when missing or infinite. Values a log
 * scale cannot place (zero or below) sit at its low end, so a region from
 * zero reaches the axis.
 */
function place(scale: PositionScale, value: number): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  if (scale.type === "log" && value <= 0) value = Math.min(scale.domain[0], scale.domain[1]);
  const pixel = scale.map(value);
  return Number.isNaN(pixel) ? undefined : pixel;
}

/**
 * Shaded regions: one between constant values, or one per row of a table.
 * List them before the marks they highlight to draw them underneath.
 *
 * ```ts
 * region({ x1: start, x2: end, label: "Maintenance" })
 * region(incidents, { x1: "start", x2: "end", text: "title" })
 * region({ y1: 200, y2: 300, fill: "#2a9d8f" })
 * ```
 */
export function region(options: RegionOptions): RegionMark;
export function region<S extends Schema>(
  table: Table<S>,
  options: RegionDataOptions<S>,
): RegionMark;
export function region<S extends Schema>(
  first: Table<S> | RegionOptions,
  second?: RegionDataOptions<S>,
): RegionMark {
  const table = second ? (first as Table<S>) : undefined;
  const options = (second ?? first) as RegionDataOptions<S>;
  const spec: RegionSpec = {
    type: "region",
    ...(definedFields(
      {
        ...options,
        x1: position(options.x1),
        x2: position(options.x2),
        y1: position(options.y1),
        y2: position(options.y2),
      },
      ["id", "x1", "x2", "y1", "y2", "fill", "fillOpacity", "label", "text"],
    ) as Omit<RegionSpec, "type">),
  };
  if (table?.name !== undefined && readsTable([spec.x1, spec.x2, spec.y1, spec.y2], spec.text)) {
    spec.data = table.name;
  }
  return new RegionMark(spec, table as unknown as Table | undefined);
}
