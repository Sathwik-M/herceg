import {
  type CategoryColumn,
  type CategoryInput,
  type Column,
  type ColumnInput,
  createColumn,
  createColumnOfKind,
  encode,
  type FieldKind,
  isNumericArray,
  type NumericArray,
  type TimeInput,
  toMilliseconds,
} from "./column.ts";

/** Field name to storage kind. */
export type Schema = Record<string, FieldKind>;

type Present<E> = Exclude<E, null | undefined>;

type KindOfInput<V> = V extends TimeInput
  ? "time"
  : V extends CategoryInput
    ? "category"
    : V extends NumericArray
      ? "number"
      : V extends readonly (infer E)[]
        ? [Present<E>] extends [never]
          ? "number"
          : Present<E> extends Date
            ? "time"
            : Present<E> extends string
              ? "category"
              : Present<E> extends number
                ? "number"
                : never
        : never;

/** Schema inferred from the columns passed to `table()`. */
export type SchemaOf<T> = { [K in keyof T & string]: KindOfInput<T[K]> };

/**
 * Fields usable as numeric positions (numbers and times). Tables whose field
 * names are only known at runtime (a string index signature) accept any
 * string; marks check those fields when they are created.
 */
export type NumericField<S extends Schema> = string extends keyof S
  ? string
  : { [K in keyof S & string]: S[K] extends "number" | "time" ? K : never }[keyof S & string];

/** Category fields, with the same fallback for runtime field names. */
export type CategoryField<S extends Schema> = string extends keyof S
  ? string
  : { [K in keyof S & string]: S[K] extends "category" ? K : never }[keyof S & string];

export type FieldName<S extends Schema> = keyof S & string;

/** A single value as accepted by `appendRow` and `set`. */
export type ValueOf<K extends FieldKind> = K extends "category"
  ? string | null
  : K extends "time"
    ? Date | number | null
    : number | null;

/** Values for one field as accepted by `append` and `replace`. */
export type ValuesOf<K extends FieldKind> = K extends "category"
  ? readonly (string | null)[]
  : K extends "time"
    ? NumericArray | readonly (Date | number | null)[]
    : NumericArray | readonly (number | null)[];

export type Row<S extends Schema> = { [K in keyof S]: ValueOf<S[K]> };
export type Batch<S extends Schema> = { [K in keyof S]: ValuesOf<S[K]> };

/**
 * Describes one mutation so caches can update instead of rebuilding. Row
 * identities are `rowOffset + index`; `rowOffset` may advance by more than
 * `dropped` when an append batch is larger than `maxRows`.
 */
export interface TableChange {
  /** Existing rows removed from the front. */
  dropped: number;
  /** Rows added at the end (after any batch rows that never fit). */
  appended: number;
  /** Rows changed in place, as a range of row indices after the change. */
  updated: { start: number; end: number } | null;
  /** Fields affected by an in-place update; empty for append and drop. */
  fields: readonly string[];
  /** Everything changed; derived data must be rebuilt. */
  reset: boolean;
}

export interface TableOptions {
  /** Name used when the table is referenced from a serialized spec. */
  name?: string;
  /**
   * Keep at most this many rows: appends drop the oldest rows. Use it for
   * rolling windows over streaming data. A positive integer.
   */
  maxRows?: number;
}

type Listener = (change: TableChange) => void;

const GROWTH = 1.5;
const MIN_CAPACITY = 64;

function requireCount(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0)
    throw new RangeError(`${name} must be a non-negative integer`);
}

/**
 * Columnar data with equal-length typed columns.
 *
 * Rows live in a contiguous slice `[start, start + length)` of each column
 * buffer. Appends write after the slice; drops advance `start`. When the end
 * of the buffer is reached the live rows are moved to the front, or the
 * buffers grow by 1.5x. Every consumer therefore sees contiguous typed arrays,
 * at the cost of up to 1.5x the live data in reserved capacity.
 *
 * Typed arrays passed by the caller are read in place and never written: the
 * first mutation copies them into buffers the table owns.
 */
export class Table<S extends Schema = Schema> {
  readonly name: string | undefined;
  readonly maxRows: number;
  #columns = new Map<string, Column>();
  #start = 0;
  #length: number;
  #capacity: number;
  #version = 0;
  #rowOffset = 0;
  #views = new Map<string, NumericArray | Int32Array>();
  #sorted = new Map<string, boolean>();
  /** Cached extents; null records that a field has no finite values. */
  #extents = new Map<string, readonly [number, number] | null>();
  #listeners = new Set<Listener>();

  constructor(columns: Record<string, ColumnInput>, options: TableOptions = {}) {
    this.name = options.name;
    this.maxRows = options.maxRows ?? Number.POSITIVE_INFINITY;
    if (
      !(
        this.maxRows === Number.POSITIVE_INFINITY ||
        (Number.isInteger(this.maxRows) && this.maxRows > 0)
      )
    ) {
      throw new RangeError("maxRows must be a positive integer");
    }
    let length: number | undefined;
    for (const [field, input] of Object.entries(columns)) {
      let column: Column;
      try {
        column = createColumn(input);
      } catch (error) {
        const Kind = error instanceof RangeError ? RangeError : TypeError;
        throw new Kind(`Column "${field}": ${(error as Error).message}`);
      }
      if (length !== undefined && column.buffer.length !== length) {
        throw new RangeError(
          `Column "${field}" has ${column.buffer.length} rows, expected ${length}`,
        );
      }
      length = column.buffer.length;
      this.#columns.set(field, column);
    }
    this.#length = length ?? 0;
    this.#capacity = this.#length;
    if (this.#length > this.maxRows) this.#dropFront(this.#length - this.maxRows);
  }

  /** Number of live rows. */
  get length(): number {
    return this.#length;
  }

  /** Increments on every mutation. */
  get version(): number {
    return this.#version;
  }

  /**
   * Rows dropped (or never kept) since the table was created or reset.
   * `rowOffset + i` is a stable identity for row `i` across drops.
   */
  get rowOffset(): number {
    return this.#rowOffset;
  }

  /** Bytes reserved by column buffers, including unused capacity. */
  get byteLength(): number {
    let bytes = 0;
    for (const column of this.#columns.values()) bytes += column.buffer.byteLength;
    return bytes;
  }

  fields(): FieldName<S>[] {
    return [...this.#columns.keys()] as FieldName<S>[];
  }

  has(field: string): field is FieldName<S> {
    return this.#columns.has(field);
  }

  kind(field: FieldName<S>): FieldKind {
    return this.#column(field).kind;
  }

  /** Live values of a numeric or time field. The view is valid until the next mutation. */
  numbers(field: NumericField<S>): NumericArray {
    const column = this.#column(field);
    if (column.kind === "category") throw new TypeError(`Field "${field}" is categorical`);
    return this.#view(field, column.buffer);
  }

  /** Dictionary codes (-1 for missing) and the dictionary of a category field. */
  categories(field: CategoryField<S>): { codes: Int32Array; dictionary: readonly string[] } {
    const column = this.#column(field);
    if (column.kind !== "category") throw new TypeError(`Field "${field}" is not categorical`);
    return { codes: this.#view(field, column.buffer) as Int32Array, dictionary: column.dictionary };
  }

  /** One value: number (NaN becomes null), epoch ms for times, or a string. */
  value(field: FieldName<S>, row: number): number | string | null {
    const column = this.#column(field);
    if (!(Number.isInteger(row) && row >= 0 && row < this.#length))
      throw new RangeError(`Row ${row} out of range`);
    const raw = column.buffer[this.#start + row]!;
    if (column.kind === "category") return raw < 0 ? null : column.dictionary[raw]!;
    return Number.isNaN(raw) ? null : raw;
  }

  /** True when the field has no NaN and never decreases, enabling binary search. */
  isSorted(field: NumericField<S>): boolean {
    let sorted = this.#sorted.get(field);
    if (sorted === undefined) {
      sorted = isAscending(this.numbers(field), 0, this.#length);
      this.#sorted.set(field, sorted);
    }
    return sorted;
  }

  /** [min, max] of finite values, or undefined when there are none. */
  extent(field: NumericField<S>): readonly [number, number] | undefined {
    let extent = this.#extents.get(field);
    if (extent === undefined) {
      const values = this.numbers(field);
      extent =
        (this.isSorted(field) ? finiteEnds(values) : scanExtent(values, 0, values.length)) ?? null;
      this.#extents.set(field, extent);
    }
    return extent ?? undefined;
  }

  /** Appends one batch of rows. Every field must be present with the same length. */
  append(batch: Batch<S>): void {
    const entries = Object.entries(batch) as [string, ArrayLike<unknown>][];
    if (entries.length !== this.#columns.size) {
      throw new TypeError(`append() needs all ${this.#columns.size} fields`);
    }
    const count = entries[0]?.[1].length ?? 0;
    for (const [field, values] of entries) {
      this.#column(field);
      if (values.length !== count)
        throw new RangeError(`Field "${field}" has ${values.length} values, expected ${count}`);
    }
    if (count === 0) return;
    // Inputs that view this table's own storage could be overwritten by
    // compaction before they are read.
    for (const entry of entries) {
      const values = entry[1];
      if (isNumericArray(values) && this.#ownsBuffer(values.buffer)) entry[1] = values.slice();
    }

    // Batch rows beyond maxRows never enter the table; existing rows that
    // would be evicted are dropped before compaction so they are not copied.
    const skip = Math.max(0, count - this.maxRows);
    const kept = count - skip;
    const dropped = Math.min(Math.max(0, this.#length + kept - this.maxRows), this.#length);
    this.#dropFront(dropped);
    this.#reserve(kept);

    const at = this.#start + this.#length;
    for (const [field, values] of entries) writeValues(this.#columns.get(field)!, at, values, skip);
    this.#length += kept;
    this.#rowOffset += skip;
    for (const [field, column] of this.#columns) {
      if (column.kind === "category") continue;
      this.#extendDerived(field, column.buffer, at, kept, dropped > 0);
    }
    this.#changed({ dropped, appended: kept, updated: null, fields: [], reset: false });
  }

  appendRow(row: Row<S>): void {
    const batch: Record<string, unknown[]> = {};
    for (const [field, value] of Object.entries(row)) batch[field] = [value];
    this.append(batch as unknown as Batch<S>);
  }

  /**
   * Drops the oldest `count` rows (all of them when `count` exceeds the
   * length). Buffers shrink when the drop leaves them less than a quarter full.
   */
  dropFirst(count: number): void {
    requireCount(count, "dropFirst() count");
    const dropped = Math.min(count, this.#length);
    if (dropped === 0) return;
    this.#dropFront(dropped);
    const target = Math.max(MIN_CAPACITY, Math.ceil(this.#length * GROWTH));
    if (this.#capacity > 4 * target) this.#reallocate(target);
    this.#changed({ dropped, appended: 0, updated: null, fields: [], reset: false });
  }

  /** Drops leading rows whose `field` value is below `value`. The field must be sorted. */
  dropBefore(field: NumericField<S>, value: number | Date): void {
    if (!this.isSorted(field)) throw new Error(`dropBefore() needs "${field}" to be sorted`);
    this.dropFirst(lowerBound(this.numbers(field), toMilliseconds(value)));
  }

  /** Sets one value in place. */
  set<K extends FieldName<S>>(field: K, row: number, value: ValueOf<S[K]>): void {
    this.replace(field, row, [value] as unknown as ValuesOf<S[K]>);
  }

  /** Overwrites rows `[start, start + values.length)` of one field. */
  replace<K extends FieldName<S>>(field: K, start: number, values: ValuesOf<S[K]>): void {
    const column = this.#column(field);
    let input = values as ArrayLike<unknown>;
    const count = input.length;
    requireCount(start, "replace() start");
    if (start + count > this.#length) throw new RangeError("replace() range is out of bounds");
    if (count === 0) return;
    if (isNumericArray(input) && this.#ownsBuffer(input.buffer)) input = input.slice();
    if (!column.owned) this.#reallocate(this.#capacity);
    writeValues(column, this.#start + start, input, 0);
    this.#sorted.delete(field);
    this.#extents.delete(field);
    this.#changed({
      dropped: 0,
      appended: 0,
      updated: { start, end: start + count },
      fields: [field],
      reset: false,
    });
  }

  /** Replaces every value of one field, keeping the row count. */
  setColumn<K extends FieldName<S>>(field: K, values: ValuesOf<S[K]>): void {
    if ((values as ArrayLike<unknown>).length !== this.#length) {
      throw new RangeError(`setColumn() needs ${this.#length} values`);
    }
    this.replace(field, 0, values);
  }

  /**
   * Replaces all data. The new columns must have the same fields; values are
   * read as each field's existing kind, so numeric arrays work for time
   * fields and empty arrays for category fields.
   */
  reset(columns: { [K in keyof S]: ColumnInput }): void {
    const inputs = columns as Record<string, ColumnInput>;
    if (Object.keys(inputs).length !== this.#columns.size)
      throw new TypeError("reset() must keep the same fields");
    const next = new Map<string, Column>();
    let length: number | undefined;
    for (const [field, existing] of this.#columns) {
      const input = inputs[field];
      if (input === undefined) throw new TypeError(`reset() is missing field "${field}"`);
      const column = createColumnOfKind(existing.kind, input);
      if (column.kind !== existing.kind)
        throw new TypeError(`reset() must keep field "${field}" as ${existing.kind}`);
      if (length !== undefined && column.buffer.length !== length) {
        throw new RangeError(
          `Column "${field}" has ${column.buffer.length} rows, expected ${length}`,
        );
      }
      length = column.buffer.length;
      next.set(field, column);
    }
    this.#columns = next;
    this.#start = 0;
    this.#length = length ?? 0;
    this.#capacity = this.#length;
    this.#rowOffset = 0;
    this.#sorted.clear();
    this.#extents.clear();
    if (this.#length > this.maxRows) this.#dropFront(this.#length - this.maxRows);
    this.#changed({ dropped: 0, appended: 0, updated: null, fields: [], reset: true });
  }

  /** Calls `listener` after every mutation. Returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #column(field: string): Column {
    const column = this.#columns.get(field);
    if (!column) throw new Error(`Unknown field "${field}"`);
    return column;
  }

  #ownsBuffer(buffer: ArrayBufferLike): boolean {
    for (const column of this.#columns.values()) if (column.buffer.buffer === buffer) return true;
    return false;
  }

  #view(field: string, buffer: NumericArray): NumericArray {
    let view = this.#views.get(field);
    if (view === undefined) {
      view =
        this.#start === 0 && this.#length === buffer.length
          ? buffer
          : buffer.subarray(this.#start, this.#start + this.#length);
      this.#views.set(field, view);
    }
    return view;
  }

  #dropFront(count: number) {
    this.#start += count;
    this.#length -= count;
    this.#rowOffset += count;
    if (this.#length === 0) this.#start = 0;
    if (count === 0) return;
    // Dropping rows can remove the inversion that made a field unsorted, and
    // can remove the rows that held an extreme.
    for (const [field, sorted] of this.#sorted) if (!sorted) this.#sorted.delete(field);
    this.#extents.clear();
    for (const column of this.#columns.values()) {
      if (column.kind === "category") this.#compactDictionary(column);
    }
  }

  /**
   * Rolling windows over changing categories would otherwise grow the
   * dictionary forever. When it holds more than twice as many entries as
   * there are live rows, unused entries are removed and codes renumbered,
   * keeping the order of the survivors.
   */
  #compactDictionary(column: CategoryColumn) {
    if (column.dictionary.length <= 2 * this.#length + 64) return;
    // Codes borrowed from the caller (encodedCategory) are copied before
    // they are renumbered.
    if (!column.owned) this.#reallocate(this.#capacity);
    const end = this.#start + this.#length;
    const remap = new Int32Array(column.dictionary.length).fill(-1);
    for (let i = this.#start; i < end; i++) {
      const code = column.buffer[i]!;
      if (code >= 0) remap[code] = 0;
    }
    const survivors: string[] = [];
    for (let code = 0; code < remap.length; code++) {
      if (remap[code] === 0) {
        remap[code] = survivors.length;
        survivors.push(column.dictionary[code]!);
      }
    }
    for (let i = this.#start; i < end; i++) {
      const code = column.buffer[i]!;
      if (code >= 0) column.buffer[i] = remap[code]!;
    }
    column.dictionary.length = 0;
    column.dictionary.push(...survivors);
    column.codes = undefined;
  }

  /** Makes room for `count` rows after the live slice. */
  #reserve(count: number) {
    const required = this.#length + count;
    const owned = [...this.#columns.values()].every((column) => column.owned);
    if (owned && this.#start + required <= this.#capacity) return;
    // Compacting in place is only worth it when it leaves real slack;
    // otherwise frequent compactions would cost O(length) per append.
    if (owned && required * GROWTH <= this.#capacity) {
      for (const column of this.#columns.values()) {
        column.buffer.copyWithin(0, this.#start, this.#start + this.#length);
      }
      this.#start = 0;
      return;
    }
    this.#reallocate(Math.max(MIN_CAPACITY, Math.ceil(required * GROWTH)));
  }

  /** Moves the live rows of every column into new owned buffers. */
  #reallocate(capacity: number) {
    for (const column of this.#columns.values()) {
      const live = column.buffer.subarray(this.#start, this.#start + this.#length);
      const next = new (column.buffer.constructor as new (length: number) => NumericArray)(
        capacity,
      );
      next.set(live);
      column.buffer = next as never;
      column.owned = true;
    }
    this.#start = 0;
    this.#capacity = capacity;
  }

  /**
   * Updates cached sortedness and extents for rows just written at `at`,
   * reading the stored values (after integer wrapping or float rounding).
   */
  #extendDerived(field: string, buffer: NumericArray, at: number, count: number, removed: boolean) {
    if (this.#sorted.get(field) === true) {
      const from = at > this.#start ? at - 1 : at;
      this.#sorted.set(field, isAscending(buffer, from, at + count));
    }
    const extent = this.#extents.get(field);
    if (removed || extent === undefined) {
      this.#extents.delete(field);
      return;
    }
    const added = scanExtent(buffer, at, at + count);
    if (!added) return;
    this.#extents.set(
      field,
      extent ? [Math.min(extent[0], added[0]), Math.max(extent[1], added[1])] : added,
    );
  }

  #changed(change: TableChange) {
    this.#version++;
    this.#views.clear();
    for (const listener of this.#listeners) listener(change);
  }
}

function toNumber(value: unknown): number {
  if (value == null) return Number.NaN;
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  throw new TypeError(`Expected a number or Date, got ${String(value)}`);
}

function writeValues(column: Column, at: number, values: ArrayLike<unknown>, skip: number) {
  const target = column.buffer;
  if (column.kind === "category") {
    for (let i = skip; i < values.length; i++)
      target[at + i - skip] = encode(column, values[i] as string | null);
    return;
  }
  if (isNumericArray(values)) {
    target.set(skip === 0 ? values : values.subarray(skip), at);
    return;
  }
  for (let i = skip; i < values.length; i++) target[at + i - skip] = toNumber(values[i]);
}

function isAscending(values: NumericArray, start: number, end: number): boolean {
  let previous = -Infinity;
  for (let i = start; i < end; i++) {
    const value = values[i]!;
    if (!(value >= previous)) return false;
    previous = value;
  }
  return true;
}

function finiteEnds(values: NumericArray): readonly [number, number] | undefined {
  let lo = 0;
  let hi = values.length - 1;
  while (lo <= hi && !Number.isFinite(values[lo]!)) lo++;
  while (hi >= lo && !Number.isFinite(values[hi]!)) hi--;
  return lo <= hi ? [values[lo]!, values[hi]!] : undefined;
}

/** [min, max] of finite values in `values[start, end)`. */
export function scanExtent(
  values: ArrayLike<number>,
  start: number,
  end: number,
): [number, number] | undefined {
  let min = Infinity;
  let max = -Infinity;
  for (let i = start; i < end; i++) {
    const value = values[i]!;
    if (value < min && value > -Infinity) min = value;
    if (value > max && value < Infinity) max = value;
  }
  return min <= max ? [min, max] : undefined;
}

/** First index whose value is >= `target` in an ascending array. */
export function lowerBound(
  values: ArrayLike<number>,
  target: number,
  start = 0,
  end = values.length,
): number {
  let lo = start;
  let hi = end;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index whose value is > `target` in an ascending array. */
export function upperBound(
  values: ArrayLike<number>,
  target: number,
  start = 0,
  end = values.length,
): number {
  let lo = start;
  let hi = end;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid]! <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Creates a table from columns. Typed arrays are used without copying; plain
 * arrays are converted once. Strings become dictionary-encoded categories and
 * Dates become epoch-millisecond time fields.
 */
export function table<const T extends Record<string, ColumnInput>>(
  columns: T,
  options?: TableOptions,
): Table<SchemaOf<T>> {
  return new Table<SchemaOf<T>>(columns, options);
}

type RowSchema<R> = {
  [K in keyof R & string as Present<R[K]> extends number | Date | string ? K : never]: Present<
    R[K]
  > extends Date
    ? "time"
    : Present<R[K]> extends string
      ? "category"
      : "number";
};

/**
 * Converts row objects into a table. Only number, Date, and string properties
 * become fields. Pass `fields` to pick them explicitly.
 */
export function fromRows<
  R extends object,
  const F extends keyof RowSchema<R> & string = keyof RowSchema<R> & string,
>(
  rows: readonly R[],
  options: TableOptions & { fields?: readonly F[] } = {},
): Table<Pick<RowSchema<R>, F>> {
  const first = rows[0] as Record<string, unknown> | undefined;
  const fields =
    (options.fields as readonly string[] | undefined) ??
    (first ? Object.keys(first).filter((key) => isColumnValue(first[key])) : []);
  const columns: Record<string, ColumnInput> = {};
  for (const field of fields) {
    const sample = rows.find((row) => (row as Record<string, unknown>)[field] != null) as
      | Record<string, unknown>
      | undefined;
    const value = sample?.[field];
    if (typeof value === "string") {
      columns[field] = rows.map((row) => (row as Record<string, string | null>)[field] ?? null);
    } else {
      const out = new Float64Array(rows.length);
      for (let i = 0; i < rows.length; i++)
        out[i] = toNumber((rows[i] as Record<string, unknown>)[field]);
      columns[field] = value instanceof Date ? { kind: "time", values: out } : out;
    }
  }
  const { fields: _, ...tableOptions } = options;
  return new Table<Pick<RowSchema<R>, F>>(columns, tableOptions);
}

function isColumnValue(value: unknown): boolean {
  return (
    typeof value === "number" || typeof value === "string" || value instanceof Date || value == null
  );
}
