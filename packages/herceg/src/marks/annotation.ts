// Annotations (rules, regions, and text) draw one item from constant
// positions, or one item per row of a table when a position or the text is a
// field; facets split those rows into panels, which draw and summarize their
// own. This module resolves those channels for the three marks.

import type { FieldKind, NumericArray } from "../data/column.ts";
import type { Schema, Table } from "../data/table.ts";
import { formatNumber } from "../format/format.ts";
import type { AnnotationValue } from "../spec/spec.ts";
import { NUMERIC, type RowParts, requireField } from "./mark.ts";

/** Fields whose values can be drawn as text: categories and numbers. */
export type TextField<S extends Schema> = string extends keyof S
  ? string
  : { [K in keyof S & string]: S[K] extends "category" | "number" ? K : never }[keyof S & string];

/** Epoch milliseconds for dates; numbers and field names pass through. */
export function position<P extends string | number | Date | undefined>(value: P): Exclude<P, Date> {
  return (value instanceof Date ? value.getTime() : value) as Exclude<P, Date>;
}

const SUMMARY_ITEMS = 10;

/** A position ready to read: a constant, or a column with a value per row. */
export type Channel = number | NumericArray;

export function valueAt(channel: Channel, item: number): number {
  return typeof channel === "number" ? channel : channel[item]!;
}

/** Whether an annotation reads a table: a position or its text is a field. */
export function readsTable(
  positions: readonly (AnnotationValue | undefined)[],
  text: string | undefined,
): boolean {
  return text !== undefined || positions.some((position) => typeof position === "string");
}

/** Checks an annotation's fields and reads its positions and text. */
export class AnnotationData {
  /** The table when the annotation reads one; constants ignore it. */
  readonly table: Table | undefined;
  readonly #label: string | undefined;
  readonly #text: string | undefined;

  constructor(
    table: Table | undefined,
    positions: Record<string, AnnotationValue | undefined>,
    label: string | undefined,
    text: string | undefined,
    role: string,
  ) {
    this.#label = label;
    this.#text = text;
    if (!readsTable(Object.values(positions), text)) {
      this.table = undefined;
      return;
    }
    if (!table) {
      // A constant given as a string, such as a date, reads as a field name.
      const [channel, field] = Object.entries(positions).find(([, p]) => typeof p === "string") ?? [
        "textField",
        text,
      ];
      const constant = channel === "textField" ? "constant text as label" : "a number or Date";
      throw new Error(
        `${role} ${channel}: "${field}" names a field, and fields need a table; pass the table first, or give ${constant}`,
      );
    }
    for (const [channel, position] of Object.entries(positions)) {
      if (typeof position === "string")
        requireField(table, position, NUMERIC, `${role} ${channel}`);
    }
    if (text !== undefined) requireField(table, text, ["category", "number"], `${role} textField`);
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

  channel(position: AnnotationValue): Channel {
    return typeof position === "number" ? position : this.table!.numbers(position as never);
  }

  /**
   * Kind of a position's field; undefined for constants, which fit any axis
   * (on a category axis a constant is a band index, as in Plotly: 0 is the
   * first band's center and -0.5 its edge).
   */
  kind(position: AnnotationValue | undefined): FieldKind | undefined {
    return typeof position === "string" ? this.table!.kind(position as never) : undefined;
  }

  /** Whether items have text to draw. */
  get labeled(): boolean {
    return this.#label !== undefined || this.#text !== undefined;
  }

  /** Text of an item: the constant label, or the text field's value at its row. */
  text(item: number, locale: string | undefined): string {
    if (this.#text === undefined) return this.#label ?? "";
    const value = this.table!.value(this.#text as never, item);
    if (value === null) return "";
    return typeof value === "number" ? formatNumber(value, locale) : value;
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
   * [min, max] of usable values of the channels over the items of `rows`
   * (every item without them) that `keep` accepts; with `log`, positive
   * values only. Thresholds and events count toward the axis domain so
   * they stay in view.
   */
  extent(
    positions: readonly (AnnotationValue | undefined)[],
    log: boolean,
    keep?: (item: number) => boolean,
    rows?: RowParts,
  ): [number, number] | undefined {
    let min = Infinity;
    let max = -Infinity;
    for (const position of positions) {
      if (position === undefined) continue;
      const channel = this.channel(position);
      this.each(rows, (i) => {
        const value = valueAt(channel, i);
        if (!Number.isFinite(value) || (log && value <= 0) || (keep && !keep(i))) return;
        if (value < min) min = value;
        if (value > max) max = value;
      });
    }
    return min <= max ? [min, max] : undefined;
  }
}
