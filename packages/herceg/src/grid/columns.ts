// Grid columns: which fields a grid shows, in what order and width, which
// are pinned to its edges, and how their values read as text. Values are
// formatted when a cell is drawn, by one Intl formatter per column; no
// formatted string is kept.

import type { PositionField, Schema, Table } from "../data/table.ts";
import {
  type Formatter,
  type NumberFormat,
  numberFormatter,
  type TimeFormat,
  timeFormatter,
} from "../format/format.ts";
import type { TimeZone } from "../format/zone.ts";

type FormatOf<K> = K extends "number" ? NumberFormat : K extends "time" ? TimeFormat : never;

/** A side of the grid a column can be pinned to. */
export type PinSide = "left" | "right";

/**
 * A field shown in a grid. `format` is Intl options for the field's kind:
 * number options for numbers, date and time options for times, none for
 * categories.
 */
export type GridColumn<S extends Schema = Schema> = {
  [F in PositionField<S>]: {
    field: F;
    /** Names the column in focus, sort, and layout calls; the field by default. Unique in a grid. */
    id?: string;
    /** The header's text; the field by default. */
    title?: string;
    /** In CSS pixels, at least `MIN_COLUMN_WIDTH`; 120 by default. */
    width?: number;
    /** Numbers align to the end by default, so their digits line up; other values to the start. */
    align?: "start" | "center" | "end";
    format?: FormatOf<S[F]>;
    hidden?: boolean;
    /**
     * Holds the column at the grid's left or right edge while the others
     * scroll past. Pinned columns show first or last, in the columns' order.
     */
    pin?: PinSide;
    /**
     * In grouped grids: the name of an aggregate of the groups that group
     * rows show in this column. Without one, group rows leave it empty.
     */
    aggregate?: string;
  };
}[PositionField<S>];

/** A shown column, placed: what renderers draw. */
export interface GridColumnLayout {
  readonly id: string;
  readonly field: string;
  readonly kind: "number" | "time" | "category";
  readonly title: string;
  /** Left edge, from the first shown column, in CSS pixels, as if nothing were scrolled. */
  readonly x: number;
  readonly width: number;
  readonly align: "start" | "center" | "end";
  /**
   * The edge the column is held at as the others scroll, or null. Null for
   * pinned columns too while the grid is too narrow to hold them (see
   * `GridModel.canPin`); they then scroll with the others, in the same order.
   */
  readonly pinned: PinSide | null;
}

export interface FormatSettings {
  locale: string | undefined;
  timeZone: TimeZone;
  /** Text for missing values. */
  missing: string;
}

/** What a column shows, apart from where: made by `setColumns`, kept while columns only move, resize, pin, or hide. */
export interface ColumnContent {
  readonly kind: "number" | "time" | "category";
  readonly title: string;
  readonly align: "start" | "center" | "end";
  /** The cell text of the table's row at `position`. Bound to the table's current arrays. */
  text(table: Table, position: number): string;
  /** A value of the column's field as text: a label, a number, or a time; null for missing. */
  format(value: string | number | null): string;
  readonly aggregate: string | undefined;
  /** A header over the column and its neighbors with the same one: a pivot's value over its aggregates. */
  readonly heading?: { readonly id: string; readonly title: string };
}

/** A shown column with what it shows. */
export interface PlacedColumn extends GridColumnLayout {
  /** The same object as long as the column's content is: its cells' text need not be written again. */
  readonly content: ColumnContent;
}

const WIDTH = 120;
/** The narrowest a column can be, in CSS pixels: room for the cell's padding and a few characters. */
export const MIN_COLUMN_WIDTH = 32;
/**
 * How much room pinned columns leave for the others, at least, to be held
 * at the edges: the width of one column of the default width.
 */
export const MIN_SCROLLING_WIDTH = WIDTH;
const LAST_DATE = 8.64e15;

/** Full timestamps, to the second, as tooltips show them. */
const TIME: TimeFormat = {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
};

/** Checks columns against the table, and says what each shows (hidden ones too), by id. */
export function describeColumns(
  table: Table,
  columns: readonly GridColumn[],
  settings: FormatSettings,
): Map<string, ColumnContent> {
  const contents = new Map<string, ColumnContent>();
  for (const column of columns) {
    const { field } = column;
    if (!table.has(field)) throw new Error(`Unknown grid field "${field}"`);
    const kind = table.kind(field);
    if (kind === "geometry") throw new Error(`Grids cannot show geometry ("${field}")`);
    const id = column.id ?? field;
    if (contents.has(id)) throw new Error(`Two grid columns have the id "${id}"`);
    const width = column.width ?? WIDTH;
    if (!(Number.isFinite(width) && width >= MIN_COLUMN_WIDTH))
      throw new RangeError(
        `Column "${id}" needs a width of at least ${MIN_COLUMN_WIDTH} pixels, not ${width}`,
      );
    if (column.pin !== undefined && column.pin !== "left" && column.pin !== "right")
      throw new TypeError(`Column "${id}" pins to "left" or "right", not "${column.pin}"`);
    if (column.format !== undefined && kind === "category")
      throw new TypeError(`Column "${id}" shows categories, which take no format`);
    const format = valueFormatter(kind, column.format, settings);
    contents.set(id, {
      kind,
      title: column.title ?? field,
      align: column.align ?? (kind === "number" ? "end" : "start"),
      text: reader(field, kind, format, settings.missing),
      format,
      aggregate: column.aggregate,
    });
  }
  return contents;
}

/**
 * Places the shown columns side by side: those pinned left first, then the
 * others, then those pinned right, each in the columns' order. Pinned columns
 * are held at their edges unless together they would leave less than
 * `MIN_SCROLLING_WIDTH` of a `room` pixels wide (0: not measured yet).
 */
export function placeColumns(
  columns: readonly (GridColumn & { id: string })[],
  contents: ReadonlyMap<string, ColumnContent>,
  room: number,
): PlacedColumn[] {
  const shown = columns.filter((column) => !column.hidden);
  const ordered = [
    ...shown.filter(({ pin }) => pin === "left"),
    ...shown.filter(({ pin }) => pin === undefined),
    ...shown.filter(({ pin }) => pin === "right"),
  ];
  const held = pinsHold(pinnedWidth(shown), room);
  const placed: PlacedColumn[] = [];
  let x = 0;
  for (const { id, field, width = WIDTH, pin } of ordered) {
    const content = contents.get(id)!;
    const { kind, title, align } = content;
    placed.push({
      id,
      field,
      kind,
      title,
      x,
      width,
      align,
      pinned: held ? (pin ?? null) : null,
      content,
    });
    x += width;
  }
  return placed;
}

/** Width of the shown pinned columns together. */
export function pinnedWidth(columns: readonly GridColumn[]): number {
  let width = 0;
  for (const column of columns)
    if (column.pin !== undefined && !column.hidden) width += column.width ?? WIDTH;
  return width;
}

/** Whether pinned columns this wide together are held at their edges in a grid of `room` pixels (0: not measured). */
export function pinsHold(width: number, room: number): boolean {
  return room <= 0 || width <= room - MIN_SCROLLING_WIDTH;
}

/** A column's width, given or the default. */
export function widthOf(column: GridColumn): number {
  return column.width ?? WIDTH;
}

/** What reads a field's values as text. */
function reader(
  field: string,
  kind: "number" | "time" | "category",
  format: (value: string | number | null) => string,
  missing: string,
): (table: Table, position: number) => string {
  if (kind === "category") {
    return (table, position) => {
      const { codes, dictionary } = table.categories(field);
      const code = codes[position]!;
      return code < 0 ? missing : dictionary[code]!;
    };
  }
  return (table, position) => format(table.numbers(field)[position]!);
}

/** What writes values of a kind as text, with Intl options for numbers or times. */
export function valueFormatter(
  kind: "number" | "time" | "category",
  format: NumberFormat | TimeFormat | undefined,
  { locale, timeZone, missing }: FormatSettings,
): (value: string | number | null) => string {
  if (kind === "category") return (value) => (value === null ? missing : String(value));
  if (kind === "time") {
    const write = timeFormatter((format as TimeFormat | undefined) ?? TIME, timeZone, locale);
    const number = readableNumber(locale);
    return (value) => {
      if (value === null || Number.isNaN(value)) return missing;
      // Dates end 8.64e15 ms from 1970 either way; Intl throws past them.
      return Math.abs(value as number) <= LAST_DATE
        ? write(value as number)
        : number(value as number);
    };
  }
  const write = format ? numberFormatter(format as NumberFormat, locale) : readableNumber(locale);
  return (value) => (value === null || Number.isNaN(value) ? missing : write(value as number));
}

/** Two decimals for most numbers, three significant digits for small ones, as tooltips show them. */
function readableNumber(locale: string | undefined): Formatter {
  const large = numberFormatter({ maximumFractionDigits: 2 }, locale);
  const small = numberFormatter({ maximumSignificantDigits: 3 }, locale);
  return (value) => (Math.abs(value) >= 1 || value === 0 ? large(value) : small(value));
}
