// Column storage. A column owns one typed buffer; the table that holds it
// decides which slice of the buffer is live (see table.ts).

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
 * - `time`: epoch milliseconds stored like `number`.
 * - `category`: dictionary-encoded strings; code -1 marks a missing value.
 */
export type FieldKind = "number" | "time" | "category";

export interface NumberColumn {
  readonly kind: "number" | "time";
  buffer: NumericArray;
  /** False while the buffer is a caller's typed array; it is copied before any write. */
  owned: boolean;
}

export interface CategoryColumn {
  readonly kind: "category";
  buffer: Int32Array;
  owned: boolean;
  readonly dictionary: string[];
  /** Code lookup for the dictionary; built lazily on first append. */
  codes: Map<string, number> | undefined;
}

export type Column = NumberColumn | CategoryColumn;

/** Marks a numeric array or Date list as a time column. */
export interface TimeInput {
  readonly kind: "time";
  readonly values: ArrayLike<number> | readonly (Date | number | null | undefined)[];
}

export function time(values: TimeInput["values"]): TimeInput {
  return { kind: "time", values };
}

/** Marks a string list as a category column, needed when it may start empty. */
export interface CategoryInput {
  readonly kind: "category";
  readonly values: readonly (string | null | undefined)[];
}

export function category(values: CategoryInput["values"]): CategoryInput {
  return { kind: "category", values };
}

export type ColumnInput =
  | NumericArray
  | readonly (number | null | undefined)[]
  | readonly (Date | null | undefined)[]
  | readonly (string | null | undefined)[]
  | TimeInput
  | CategoryInput;

export function isNumericArray(value: unknown): value is NumericArray {
  return ArrayBuffer.isView(value) && !(value instanceof DataView) && !isBigIntArray(value);
}

function isBigIntArray(value: ArrayBufferView): boolean {
  return value instanceof BigInt64Array || value instanceof BigUint64Array;
}

export function toMilliseconds(value: Date | number | null | undefined): number {
  if (value == null) return Number.NaN;
  return typeof value === "number" ? value : value.getTime();
}

function firstPresent(values: ArrayLike<unknown>): unknown {
  for (let i = 0; i < values.length; i++) {
    if (values[i] != null) return values[i];
  }
  return undefined;
}

export function createCategory(values: ArrayLike<string | null | undefined>): CategoryColumn {
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

/** Returns the dictionary code for a value, adding it when new. */
export function encode(column: CategoryColumn, value: string | null | undefined): number {
  if (value == null) return -1;
  if (!column.codes) {
    column.codes = new Map(column.dictionary.map((entry, code) => [entry, code]));
  }
  let code = column.codes.get(value);
  if (code === undefined) {
    code = column.dictionary.length;
    column.dictionary.push(value);
    column.codes.set(value, code);
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
    const tagged = input as TimeInput | CategoryInput;
    if (tagged.kind === "category") return createCategory(tagged.values);
    const timed = tagged;
    if (isNumericArray(timed.values)) return { kind: "time", buffer: timed.values, owned: false };
    const buffer = Float64Array.from(timed.values as ArrayLike<Date | number>, toMilliseconds);
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
  if (kind === "category" && Array.isArray(input)) {
    return createCategory(input as readonly (string | null)[]);
  }
  return createColumn(input);
}
