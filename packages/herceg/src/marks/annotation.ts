// Annotations (rules, regions, and text) draw one item from constant
// places, or one item per row of a table when a place or the label is a
// field; facets split those rows into panels, which draw and summarize their
// own. A place along an axis is a value (a constant or a field), or any
// coordinate (spec/place.ts): a category, a fraction of the plot, pixels,
// each moved by an offset. This module resolves them for the three marks.

import type { FieldKind, NumericArray } from "../data/column.ts";
import type { Schema, Table } from "../data/table.ts";
import { type Formatter, formatNumber, numberFormatter } from "../format/format.ts";
import { coordinateAt } from "../layout/position.ts";
import type { PositionScale } from "../scale/scale.ts";
import type { LabelSpec } from "../spec/encoding.ts";
import type { Coordinate } from "../spec/place.ts";
import type { AnnotationPosition, AnnotationValue, Frozen } from "../spec/spec.ts";
import { type Frame, NUMERIC, type RowParts, requireField } from "./mark.ts";

/** Fields whose values can be drawn as text: categories and numbers. */
export type TextField<S extends Schema> = string extends keyof S
  ? string
  : { [K in keyof S & string]: S[K] extends "category" | "number" ? K : never }[keyof S & string];

/** A place as annotations' TypeScript options take it: a value, a Date, a field, or a coordinate. */
export type PlaceOption<F extends string> =
  | number
  | Date
  | F
  | Coordinate
  | { data: number | string | Date; scale?: string; offset?: number };

/** Epoch milliseconds for dates, in values and coordinates; numbers, fields, and other coordinates pass through. */
export function position<P>(value: P): Exclude<P, Date> {
  if (value instanceof Date) return value.getTime() as Exclude<P, Date>;
  const data = (value as { data?: unknown } | undefined)?.data;
  if (data instanceof Date) return { ...value, data: data.getTime() } as Exclude<P, Date>;
  return value as Exclude<P, Date>;
}

const SUMMARY_ITEMS = 10;

/** A position ready to read: a constant, or a column with a value per row. */
export type Channel = number | NumericArray;

export function valueAt(channel: Channel, item: number): number {
  return typeof channel === "number" ? channel : channel[item]!;
}

/**
 * A place compiled: a value per item (a constant or a column), a category
 * on a band axis, or a share or pixels of the plot or chart; with the
 * coordinate it is, which `coordinateAt` resolves.
 */
export type Place = { readonly coordinate: Coordinate } & (
  | { readonly kind: "value"; readonly channel: Channel }
  | { readonly kind: "category"; readonly value: string }
  | { readonly kind: "frame" }
);

/** A label's settings, its short form (a string) read as its text. */
export type Label = Frozen<Exclude<LabelSpec, string>>;

/** The label object of a `label` option. */
export function labelOf(label: string | Frozen<LabelSpec> | undefined): Label | undefined {
  return typeof label === "string" ? { text: label } : (label as Label | undefined);
}

/** The field a place reads, if any. */
function fieldOf(position: Frozen<AnnotationPosition> | undefined): string | undefined {
  if (typeof position === "string") return position;
  return typeof position === "object" && "field" in position ? position.field : undefined;
}

/** Whether an annotation reads a table: a place or its label is a field. */
export function readsTable(
  positions: readonly (Frozen<AnnotationPosition> | undefined)[],
  label: string | undefined,
): boolean {
  return label !== undefined || positions.some((p) => fieldOf(p) !== undefined);
}

/** Checks an annotation's fields and reads its places and text. */
export class AnnotationData {
  /** The table when the annotation reads one; constants ignore it. */
  readonly table: Table | undefined;
  readonly label: Label | undefined;
  readonly #role: string;

  /**
   * `positions` are named by their axis (`x`, `y1`, ...); others (a rule's
   * `span`) lie along `across`.
   */
  constructor(
    table: Table | undefined,
    positions: Record<string, Frozen<AnnotationPosition> | undefined>,
    label: Label | undefined,
    role: string,
    scales: { x: string; y: string },
    across: "x" | "y" = "x",
  ) {
    this.label = label;
    this.#role = role;
    const text = label?.field;
    if (label && (label.text === undefined) === (text === undefined))
      throw new Error(`${role} label: needs one of text and field`);
    for (const [channel, place] of Object.entries(positions)) {
      const scale = typeof place === "object" && "scale" in place ? place.scale : undefined;
      const axis = channel[0] === "x" || channel[0] === "y" ? channel[0] : across;
      const own = scales[axis];
      if (scale !== undefined && scale !== own)
        throw new Error(
          `${role} ${channel}.scale: "${scale}" is not this ${axis} axis' scale ("${own}")${scale === "yRight" ? '; give axis: "right"' : ""}`,
        );
    }
    if (!readsTable(Object.values(positions), text)) {
      this.table = undefined;
      return;
    }
    if (!table) {
      // A constant given as a string, such as a date, reads as a field name.
      const [channel, field] = Object.entries(positions)
        .map(([name, p]) => [name, fieldOf(p)] as const)
        .find(([, f]) => f !== undefined) ?? ["label.field", text];
      const constant = channel === "label.field" ? "constant text as label" : "a number or Date";
      throw new Error(
        `${role} ${channel}: "${field}" names a field, and fields need a table; pass the table first, or give ${constant}`,
      );
    }
    for (const [channel, place] of Object.entries(positions)) {
      const field = fieldOf(place);
      if (field !== undefined) requireField(table, field, NUMERIC, `${role} ${channel}`);
    }
    if (text !== undefined)
      requireField(table, text, ["category", "number"], `${role} label.field`);
    this.table = table;
  }

  /** Items to draw: one per row when reading a table, otherwise one. */
  get count(): number {
    return this.table ? this.table.length : 1;
  }

  /** How many items `rows` holds: every item without them. */
  size(rows: RowParts | undefined): number {
    if (!rows) return this.count;
    let size = 0;
    for (const part of rows) size += part.length;
    return size;
  }

  /**
   * Visits the items `rows` holds (every item without them), in order: each
   * item, which is its row of the table, and its place among them.
   */
  each(rows: RowParts | undefined, visit: (item: number, place: number) => void): void {
    if (!rows) {
      for (let i = 0; i < this.count; i++) visit(i, i);
      return;
    }
    let place = 0;
    for (const part of rows) for (let k = 0; k < part.length; k++) visit(part[k]!, place++);
  }

  /** A place compiled. */
  place(position: Frozen<AnnotationPosition>): Place {
    if (typeof position === "number")
      return { kind: "value", channel: position, coordinate: { data: position } };
    if (typeof position === "string")
      return { kind: "value", channel: this.#column(position), coordinate: { field: position } };
    const coordinate = position as Coordinate;
    if ("field" in position)
      return { kind: "value", channel: this.#column(position.field), coordinate };
    if ("data" in position)
      return typeof position.data === "string"
        ? { kind: "category", value: position.data, coordinate }
        : { kind: "value", channel: position.data, coordinate };
    return { kind: "frame", coordinate };
  }

  #column(field: string): NumericArray {
    return this.table!.numbers(field as never);
  }

  /** An item's value at a place, NaN for places that are not values. */
  value(place: Place, item: number): number {
    return place.kind === "value" ? valueAt(place.channel, item) : Number.NaN;
  }

  /**
   * The pixel of an item's place along `axis` on `scale`, or undefined when
   * it has none (a missing value, a category the axis lacks, a value a log
   * scale cannot place unless `low` puts it at the scale's low end).
   */
  pixel(
    place: Place,
    axis: "x" | "y",
    item: number,
    scale: PositionScale,
    frame: Pick<Frame, "plot" | "chart">,
    low = false,
  ): number | undefined {
    // The constructor checked that a coordinate's scale is the axis' own: `scale`.
    return coordinateAt(place.coordinate, axis, {
      plot: frame.plot,
      chart: frame.chart ?? frame.plot,
      scales: { x: "x", y: "y" },
      at(_, value) {
        if (typeof value === "string") {
          const index = scale.categories?.indexOf(value) ?? -1;
          return index < 0 ? undefined : scale.map(index);
        }
        if (!Number.isFinite(value)) return undefined;
        const at = scale.map(
          low && scale.type === "log" && value <= 0
            ? Math.min(scale.domain[0], scale.domain[1])
            : value,
        );
        return Number.isNaN(at) ? undefined : at;
      },
      field: () => valueAt((place as { channel: Channel }).channel, item),
    });
  }

  /**
   * Kind of a place's field; undefined for constants, which fit any axis
   * (on a category axis a number is a band index, as in Plotly: 0 is the
   * first band's center and -0.5 its edge).
   */
  kind(position: Frozen<AnnotationPosition> | undefined): FieldKind | undefined {
    const field = fieldOf(position);
    return field === undefined ? undefined : this.table!.kind(field as never);
  }

  /** Whether items have text to draw. */
  get labeled(): boolean {
    return this.label !== undefined;
  }

  /**
   * Text of an item: the constant label, or the label field's value at its
   * row, numbers written with `write` (the chart's locale's by default).
   */
  text(item: number, locale: string | undefined, write?: Formatter): string {
    const label = this.label;
    if (label?.field === undefined) return label?.text ?? "";
    const value = this.table!.value(label.field as never, item);
    if (value === null) return "";
    return typeof value === "number" ? (write ?? ((v) => formatNumber(v, locale)))(value) : value;
  }

  /**
   * How numbers in labels are written: the label's Intl options, a
   * pattern by `pattern` (the feature compiler's), or the locale's default.
   */
  writer(
    locale: string | undefined,
    pattern?: (format: object, locale: string | undefined, path: string) => Formatter,
  ): Formatter | undefined {
    const format = this.label?.format as { number?: string; time?: string } | undefined;
    if (!format) return undefined;
    if (format.number !== undefined || format.time !== undefined)
      return pattern?.(format, locale, `${this.#role} label.format`);
    return numberFormatter(format as Intl.NumberFormatOptions, locale);
  }

  /**
   * A sentence for the chart's text alternative listing the items of
   * `rows` (every item without them): their text and where they are, as
   * `where` describes it (undefined for items that are not drawn), such as
   * "Rules: deploy v41 (x 03:00), deploy v42 (x 08:30)." At most ten items
   * are listed.
   */
  summary(
    [one, many]: [string, string],
    locale: string | undefined,
    where: (item: number) => string | undefined,
    rows?: RowParts,
  ): string | undefined {
    const items: string[] = [];
    let total = 0;
    this.each(rows, (i) => {
      const at = where(i);
      if (at === undefined) return;
      total++;
      if (items.length >= SUMMARY_ITEMS) return;
      const text = this.labeled ? this.text(i, locale) : "";
      items.push(text ? `${text} (${at})` : at);
    });
    if (total === 0) return undefined;
    const more = total > items.length ? `, and ${total - items.length} more` : "";
    return `${total === 1 ? one : many}: ${items.join(", ")}${more}.`;
  }

  /**
   * [min, max] of usable values of the places over the items of `rows`
   * (every item without them) that `keep` accepts; with `log`, positive
   * values only. Fractions, pixels, and categories never count. Marks that
   * do not count toward domains (`contributeDomain`) stand in only where no
   * other mark has values (see `Mark.domainFallback`).
   */
  extent(
    positions: readonly (Frozen<AnnotationPosition> | undefined)[],
    log: boolean,
    keep?: (item: number) => boolean,
    rows?: RowParts,
  ): [number, number] | undefined {
    let min = Infinity;
    let max = -Infinity;
    for (const position of positions) {
      if (position === undefined) continue;
      const place = this.place(position);
      if (place.kind !== "value") continue;
      this.each(rows, (i) => {
        const value = valueAt(place.channel, i);
        if (!Number.isFinite(value) || (log && value <= 0) || (keep && !keep(i))) return;
        if (value < min) min = value;
        if (value > max) max = value;
      });
    }
    return min <= max ? [min, max] : undefined;
  }
}

export type { AnnotationValue };
