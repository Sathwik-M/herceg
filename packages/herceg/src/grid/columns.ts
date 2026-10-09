// Grid columns: which fields a grid shows, in what order and width, and how
// their values read as text. Values are formatted when a cell is drawn, by one
// Intl formatter per column; no formatted string is kept.

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
    /** In CSS pixels; 120 by default. */
    width?: number;
    /** Numbers align to the end by default, so their digits line up; other values to the start. */
    align?: "start" | "center" | "end";
    format?: FormatOf<S[F]>;
    hidden?: boolean;
  };
}[PositionField<S>];

/** A shown column, placed: what renderers draw. */
export interface GridColumnLayout {
  readonly id: string;
  readonly field: string;
  readonly kind: "number" | "time" | "category";
  readonly title: string;
  /** Left edge, from the first shown column, in CSS pixels. */
  readonly x: number;
  readonly width: number;
  readonly align: "start" | "center" | "end";
}

export interface FormatSettings {
  locale: string | undefined;
  timeZone: TimeZone;
  /** Text for missing values. */
  missing: string;
}

/** A shown column with what reads its values as text. */
export interface PlacedColumn extends GridColumnLayout {
  /** The cell text of the table's row at `position`. Bound to the table's current arrays. */
  text(table: Table, position: number): string;
}

const WIDTH = 120;
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

/** Checks columns against the table and places the shown ones side by side. */
export function placeColumns(
  table: Table,
  columns: readonly GridColumn[],
  settings: FormatSettings,
): PlacedColumn[] {
  const ids = new Set<string>();
  const placed: PlacedColumn[] = [];
  let x = 0;
  for (const column of columns) {
    const { field } = column;
    if (!table.has(field)) throw new Error(`Unknown grid field "${field}"`);
    const kind = table.kind(field);
    if (kind === "geometry") throw new Error(`Grids cannot show geometry ("${field}")`);
    const id = column.id ?? field;
    if (ids.has(id)) throw new Error(`Two grid columns have the id "${id}"`);
    ids.add(id);
    const width = column.width ?? WIDTH;
    if (!(Number.isFinite(width) && width > 0))
      throw new RangeError(`Column "${id}" needs a positive width, not ${width}`);
    if (column.format !== undefined && kind === "category")
      throw new TypeError(`Column "${id}" shows categories, which take no format`);
    if (column.hidden) continue;
    placed.push({
      id,
      field,
      kind,
      title: column.title ?? field,
      x,
      width,
      align: column.align ?? (kind === "number" ? "end" : "start"),
      text: reader(field, kind, column.format, settings),
    });
    x += width;
  }
  return placed;
}

/** What reads a field's values as text. */
function reader(
  field: string,
  kind: "number" | "time" | "category",
  format: NumberFormat | TimeFormat | undefined,
  { locale, timeZone, missing }: FormatSettings,
): (table: Table, position: number) => string {
  if (kind === "category") {
    return (table, position) => {
      const { codes, dictionary } = table.categories(field);
      const code = codes[position]!;
      return code < 0 ? missing : dictionary[code]!;
    };
  }
  if (kind === "time") {
    const write = timeFormatter((format as TimeFormat | undefined) ?? TIME, timeZone, locale);
    const number = readableNumber(locale);
    return (table, position) => {
      const value = table.numbers(field)[position]!;
      if (Number.isNaN(value)) return missing;
      // Dates end 8.64e15 ms from 1970 either way; Intl throws past them.
      return Math.abs(value) <= LAST_DATE ? write(value) : number(value);
    };
  }
  const write = format ? numberFormatter(format as NumberFormat, locale) : readableNumber(locale);
  return (table, position) => {
    const value = table.numbers(field)[position]!;
    return Number.isNaN(value) ? missing : write(value);
  };
}

/** Two decimals for most numbers, three significant digits for small ones, as tooltips show them. */
function readableNumber(locale: string | undefined): Formatter {
  const large = numberFormatter({ maximumFractionDigits: 2 }, locale);
  const small = numberFormatter({ maximumSignificantDigits: 3 }, locale);
  return (value) => (Math.abs(value) >= 1 || value === 0 ? large(value) : small(value));
}
