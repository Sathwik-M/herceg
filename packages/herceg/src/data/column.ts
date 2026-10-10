// Column storage. A column owns one typed buffer; the table that holds it
// decides which slice of the buffer is live (see table.ts).

import type { GeometryInput, GeometrySet } from "./geometry.ts";

export type NumericArray =
  | Float64Array
  | Float32Array
  | Int32Array
  | Uint32Array
  | Int16Array
  | Uint16Array
  | Int8Array
  | Uint8Array
  | Uint8ClampedArray;

/**
 * How a field is stored and interpreted.
 * - `number`: numeric values; NaN marks a missing value in float columns.
 * - `time`: epoch milliseconds stored like `number`, from numbers, Dates, or
 *   ISO 8601 strings.
 * - `category`: dictionary-encoded strings; code -1 marks a missing value.
 * - `geometry`: codes into a set of shapes (data/geometry.ts); -1 marks none.
 */
export type FieldKind = "number" | "time" | "category" | "geometry";

export interface NumberColumn {
  readonly kind: "number" | "time";
  buffer: NumericArray;
  /** False while the buffer is a caller's typed array; it is copied before any write. */
  owned: boolean;
  readonly check?: undefined;
}

export interface CategoryColumn {
  readonly kind: "category";
  buffer: Int32Array;
  owned: boolean;
  readonly dictionary: string[];
  /** Code lookup for the dictionary; built lazily on first append. */
  codes: Map<string, number> | undefined;
  readonly check?: undefined;
}

export interface GeometryColumn {
  readonly kind: "geometry";
  buffer: Int32Array;
  owned: boolean;
  /** The shapes codes point into; shared, never written. */
  readonly set: GeometrySet;
  /** Throws unless values are codes of the set, before a table writes them. */
  readonly check: (values: ArrayLike<unknown>) => void;
}

export type Column = NumberColumn | CategoryColumn | GeometryColumn;

/** A time as tables take it: epoch milliseconds, a Date, or an ISO 8601 string. */
export type TimeValue = Date | number | string;

/** Marks a numeric array, or a list of Dates or ISO 8601 strings, as a time column. */
export interface TimeInput {
  readonly kind: "time";
  readonly values: ArrayLike<number> | readonly (TimeValue | null | undefined)[];
}

/**
 * A time column: epoch milliseconds, Dates, or ISO 8601 strings, read as
 * `Date.parse` reads them (a date alone is UTC midnight; a date and time
 * without an offset is local time, so give `Z` or an offset).
 */
export function time(values: TimeInput["values"]): TimeInput {
  return { kind: "time", values };
}

/** A category as tables take it: its label, or a number (a year, a code, an id) read as one. */
export type CategoryValue = string | number;

/**
 * A category column: labels, or numbers read as labels (tagged, as needed
 * when it may start empty or holds numbers), or dictionary codes with
 * their dictionary.
 */
export type CategoryInput =
  | {
      readonly kind: "category";
      readonly values: NumericArray | readonly (CategoryValue | null | undefined)[];
    }
  | {
      readonly kind: "category";
      /** Index into `dictionary` per row; -1 for missing values. */
      readonly codes: Int32Array;
      /** Distinct values. */
      readonly dictionary: readonly string[];
    };

/**
 * A category column of strings, or of numbers such as years, status codes,
 * or ids: each distinct value is a category, labeled as `String` writes it
 * (NaN is missing), in order of first appearance.
 */
export function category(
  values: NumericArray | readonly (CategoryValue | null | undefined)[],
): CategoryInput {
  return { kind: "category", values };
}

/**
 * Dictionary-encoded categories, as delivered by Arrow, pandas, or Polars.
 * The codes are used without copying until the table writes to them.
 */
export function encodedCategory(codes: Int32Array, dictionary: readonly string[]): CategoryInput {
  return { kind: "category", codes, dictionary };
}

export type ColumnInput =
  | NumericArray
  | readonly (number | null | undefined)[]
  | readonly (Date | null | undefined)[]
  | readonly (string | null | undefined)[]
  | TimeInput
  | CategoryInput
  | GeometryInput;

export function isNumericArray(value: unknown): value is NumericArray {
  return ArrayBuffer.isView(value) && !(value instanceof DataView) && !isBigIntArray(value);
}

function isBigIntArray(value: ArrayBufferView): boolean {
  return value instanceof BigInt64Array || value instanceof BigUint64Array;
}

const getTime = Date.prototype.getTime;

/**
 * A value of a number or time field as stored: Dates as epoch
 * milliseconds, and in time fields ISO 8601 strings too; NaN for a missing
 * value. Throws for others, naming their `row` when given.
 */
export function toNumber(value: unknown, row?: number, time?: boolean): number {
  if (value == null) return Number.NaN;
  if (typeof value === "number") return value;
  // Read as Date's own method does, so that what was checked is what is written.
  if (value instanceof Date) return getTime.call(value);
  const parsed = time && typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isNaN(parsed)) return parsed;
  throw new TypeError(
    `${row === undefined ? "" : `row ${row}: `}expected ${time ? "an ISO 8601 time, a Date, or epoch milliseconds" : "a number"}; received ${JSON.stringify(value)}`,
  );
}

/** Epoch milliseconds of a time, as `toNumber` reads values of time fields. */
export const toMilliseconds = (value: TimeValue | null | undefined, row?: number): number =>
  toNumber(value, row, true);

function firstPresent(values: ArrayLike<unknown>): unknown {
  for (let i = 0; i < values.length; i++) {
    if (values[i] != null) return values[i];
  }
  return undefined;
}

function createEncodedCategory(codes: Int32Array, dictionary: readonly string[]): CategoryColumn {
  const lookup = new Map<string, number>();
  dictionary.forEach((entry, code) => {
    if (lookup.has(entry)) throw new RangeError(`Category dictionary repeats "${entry}"`);
    lookup.set(entry, code);
  });
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i]!;
    if (code < -1 || code >= dictionary.length) {
      throw new RangeError(`Category code ${code} at row ${i} is outside the dictionary`);
    }
  }
  return {
    kind: "category",
    buffer: codes,
    owned: false,
    dictionary: [...dictionary],
    codes: lookup,
  };
}

export function createCategory(
  values: ArrayLike<CategoryValue | null | undefined>,
): CategoryColumn {
  const column: CategoryColumn = {
    kind: "category",
    buffer: new Int32Array(values.length),
    owned: true,
    dictionary: [],
    codes: new Map(),
  };
  for (let i = 0; i < values.length; i++) column.buffer[i] = encode(column, values[i]);
  return column;
}

/** Returns the dictionary code for a value, adding it when new; numbers stand for their labels. */
export function encode(column: CategoryColumn, value: CategoryValue | null | undefined): number {
  if (value == null || Number.isNaN(value)) return -1;
  const label = String(value);
  if (!column.codes) {
    column.codes = new Map(column.dictionary.map((entry, code) => [entry, code]));
  }
  let code = column.codes.get(label);
  if (code === undefined) {
    code = column.dictionary.length;
    column.dictionary.push(label);
    column.codes.set(label, code);
  }
  return code;
}

/**
 * Builds a column from user input. Typed arrays are wrapped without copying
 * and marked as not owned; plain arrays are converted. Without a `time()` or
 * `category()` tag, an empty or all-null array becomes a number column.
 */
export function createColumn(input: ColumnInput): Column {
  if (isNumericArray(input)) return { kind: "number", buffer: input, owned: false };
  if (!Array.isArray(input)) {
    // Geometry inputs build their own column, so only charts using them bundle that code.
    if ((input as GeometryInput).column) return (input as GeometryInput).column();
    const tagged = input as TimeInput | CategoryInput;
    if (tagged.kind === "category") {
      return "codes" in tagged
        ? createEncodedCategory(tagged.codes, tagged.dictionary)
        : createCategory(tagged.values);
    }
    const timed = tagged;
    if (isNumericArray(timed.values)) return { kind: "time", buffer: timed.values, owned: false };
    const buffer = Float64Array.from(timed.values as ArrayLike<TimeValue>, toMilliseconds);
    return { kind: "time", buffer, owned: true };
  }
  const sample = firstPresent(input);
  if (typeof sample === "string") return createCategory(input as readonly (string | null)[]);
  if (sample instanceof Date) {
    const buffer = Float64Array.from(input as readonly (Date | null)[], toMilliseconds);
    return { kind: "time", buffer, owned: true };
  }
  if (sample === undefined || typeof sample === "number") {
    const buffer = Float64Array.from(input as readonly (number | null)[], (v) => v ?? Number.NaN);
    return { kind: "number", buffer, owned: true };
  }
  throw new TypeError(`Unsupported column value: ${String(sample)}`);
}

/** Builds a column of a known kind, as when replacing data under an existing schema. */
export function createColumnOfKind(kind: FieldKind, input: ColumnInput): Column {
  if (kind === "time" && (isNumericArray(input) || Array.isArray(input))) {
    return createColumn({ kind: "time", values: input as TimeInput["values"] });
  }
  if (kind === "category" && (isNumericArray(input) || Array.isArray(input))) {
    return createCategory(input as ArrayLike<CategoryValue | null>);
  }
  return createColumn(input);
}
