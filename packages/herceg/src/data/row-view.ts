// Row views: a table's rows filtered and ordered, without copying its
// columns. A view holds the positions of the rows it shows; grids and charts
// read the table's columns through them. Derived tables (derive.ts) are for
// computed rows; a view only chooses and orders existing ones.

import { compileExpression, Expr, type Expression } from "./expression.ts";
import { rowComparator, type SortKey } from "./order.ts";
import type { RowSet } from "./row-set.ts";
import type { PositionField, Schema, Table, TableChange } from "./table.ts";

export interface RowQuery<S extends Schema = Schema> {
  /** Shows the rows where this is true; every row without it. */
  filter?: Expr | Expression | boolean | undefined;
  /** Orders rows by these keys, in priority order; table order without. */
  sort?: readonly SortKey<PositionField<S>>[] | undefined;
}

/** What a view shows, as of one version of its table. */
export interface RowSnapshot {
  /**
   * Positions in the table's current rows, in view order; undefined when the
   * view shows every row in table order. Borrowed: valid until the table or
   * the view changes, and never to be written.
   */
  readonly indices: Uint32Array | undefined;
  readonly length: number;
  /** The table's version, generation, and rowOffset these positions are for. */
  readonly version: number;
  readonly generation: number;
  readonly rowOffset: number;
}

/**
 * A table's rows, filtered by an expression, restricted to a row set, and
 * sorted by keys, as positions into the table: no column is copied. Changes
 * to the table mark the view out of date at once and are caught up on the
 * next `read`: appended rows are filtered and merged into the order, dropped
 * rows leave it, and updates to the fields it filters or sorts by rebuild it.
 * Views follow their table until disposed or collected.
 */
export class RowView<S extends Schema = Schema> {
  readonly source: Table<S>;
  #filter: Expression | undefined;
  #sort: readonly SortKey[] = [];
  #query: Readonly<RowQuery<S>> = {};
  /** The comparator of #sort for one version of the table: it holds that version's arrays. */
  #compare: { version: number; compare: (a: number, b: number) => number } | undefined;
  #restriction: RowSet<S> | null = null;
  /** Fields the filter and sort read; updates to others keep rows and order. */
  #reads = new Set<string>();
  /** Positions, in view order, up to #length; undefined when every row shows in table order. */
  #indices: Uint32Array | undefined;
  /** A second buffer, merges write into it and swap. */
  #spare: Uint32Array | undefined;
  #length = 0;
  /** The table's state the positions describe. */
  #version = -1;
  #generation = -1;
  #offset = 0;
  /** Identity past the last row the positions have considered. */
  #end = 0;
  #rebuild = true;
  /** The table's version as of the last change the view was told about. */
  #told: number;
  #revision = 0;
  #queryRevision = 0;
  #listeners = new Set<() => void>();
  #unsubscribe: () => void;

  constructor(source: Table<S>, query: RowQuery<S> = {}) {
    this.source = source;
    this.#told = source.version;
    this.#apply(query);
    // The table holds the view weakly, so a view no one keeps stops following it.
    const ref = new WeakRef(this);
    const stop = source.subscribe((change) => {
      const view = ref.deref();
      if (view) view.#changed(change);
      else stop();
    });
    this.#unsubscribe = stop;
    followers.register(this, stop, this);
  }

  /** Increments whenever what the view shows may have changed: its table, query, or restriction. */
  get revision(): number {
    return this.#revision;
  }

  /**
   * Increments when `setQuery` or `restrict` changes which rows the view
   * selects and how it orders them, and not when its table changes: readers
   * tell a new question from new data with it.
   */
  get queryRevision(): number {
    return this.#queryRevision;
  }

  /** Bytes the view's positions hold, not counting its table. */
  get byteLength(): number {
    return (this.#indices?.byteLength ?? 0) + (this.#spare?.byteLength ?? 0);
  }

  /** Rows shown, bringing the view up to date. */
  get length(): number {
    return this.read().length;
  }

  /** The filter (as an expression) and sort keys the view applies, to change one and keep the other. */
  get query(): Readonly<RowQuery<S>> {
    return this.#query;
  }

  /**
   * Where the view shows the table's row at `position`: its index in the
   * view's order, or -1 when the view leaves it out. A binary search, so
   * readers can follow a row by identity as the view changes.
   */
  indexOf(position: number): number {
    const { indices, length } = this.read();
    if (!(Number.isInteger(position) && position >= 0 && position < this.source.length)) return -1;
    if (!indices) return position;
    // Sorted views order by the keys, then by position: a total order to search by.
    const compare = this.#sort.length > 0 ? this.#comparator() : (a: number, b: number) => a - b;
    let [lo, hi] = [0, length];
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compare(indices[mid]!, position) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo < length && indices[lo] === position ? lo : -1;
  }

  /** Changes the filter and sort; the restriction stays. */
  setQuery(query: RowQuery<S>): void {
    this.#apply(query);
    this.#rebuild = true;
    this.#queryRevision++;
    this.#invalidate();
  }

  /**
   * Shows only the rows of `rows` (of the same table), or every row again
   * with null. The set is read when the view rebuilds: call `restrict` again
   * after changing it.
   */
  restrict(rows: RowSet<S> | null): void {
    if (rows && rows.source !== this.source)
      throw new Error("A view can only be restricted to rows of its own table");
    this.#restriction = rows;
    this.#rebuild = true;
    this.#queryRevision++;
    this.#invalidate();
  }

  /** The rows the view shows now, brought up to date with the table. */
  read(): RowSnapshot {
    this.#maintain();
    const source = this.source;
    return {
      indices: this.#indices?.subarray(0, this.#length),
      length: this.#indices ? this.#length : source.length,
      version: source.version,
      generation: source.generation,
      rowOffset: source.rowOffset,
    };
  }

  /** Calls `listener` whenever the view goes out of date; returns a function that stops it. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Stops following the table and releases the positions. */
  dispose(): void {
    this.#unsubscribe();
    followers.unregister(this);
    this.#listeners.clear();
    this.#indices = undefined;
    this.#spare = undefined;
    this.#compare = undefined;
  }

  #apply(query: RowQuery<S>) {
    const source = this.source as unknown as Table;
    // Copied and frozen: an expression the caller changes later must not change the view.
    const filter = frozen(query.filter instanceof Expr ? query.filter.expression : query.filter);
    if (filter !== undefined) {
      const test = compileExpression(filter, source);
      if (test.type !== "boolean")
        throw new TypeError(`A filter needs a true or false expression, not a ${test.type}`);
    }
    // Copied: keys the caller keeps could change under an incremental merge.
    const sort = Object.freeze(
      (query.sort ?? []).map(({ field, order }) =>
        Object.freeze(order === undefined ? { field } : { field, order }),
      ),
    );
    for (const { field } of sort) {
      if (!source.has(field)) throw new Error(`Unknown sort field "${field}"`);
      if (source.kind(field) === "geometry")
        throw new Error(`Rows cannot sort by geometry ("${field}")`);
    }
    this.#filter = filter === true ? undefined : filter;
    this.#sort = sort;
    this.#compare = undefined;
    this.#query = Object.freeze({
      ...(this.#filter !== undefined && { filter: this.#filter }),
      ...(sort.length > 0 && { sort: sort as readonly SortKey<PositionField<S>>[] }),
    });
    this.#reads = new Set([...fieldsOf(filter), ...sort.map(({ field }) => field)]);
  }

  #changed(change: TableChange) {
    this.#told = this.source.version;
    // It holds the table's old arrays.
    this.#compare = undefined;
    if (change.reset) this.#rebuild = true;
    else if (change.updated && change.fields.some((field) => this.#reads.has(field)))
      this.#rebuild = true;
    // Appends and drops are caught up on the next read.
    this.#invalidate();
  }

  #invalidate() {
    this.#revision++;
    for (const listener of [...this.#listeners]) listener();
  }

  /** Whether every row shows, in table order: no positions needed. */
  get #identity(): boolean {
    return this.#filter === undefined && this.#sort.length === 0 && this.#restriction === null;
  }

  #maintain() {
    const source = this.source;
    if (!this.#rebuild && this.#version === source.version) return;
    // A change the view has not been told about yet (read by a listener of
    // the table that runs first) may have been anything.
    if (this.#told !== source.version) this.#rebuild = true;
    if (this.#identity) {
      this.#indices = undefined;
      this.#spare = undefined;
    } else if (this.#rebuild || this.#generation !== source.generation) {
      this.#build();
    } else {
      const dropped = source.rowOffset - this.#offset;
      if (dropped > 0) this.#drop(dropped);
      // Rows appended since, less any an oversized append evicted at once.
      const from = Math.max(0, this.#end - source.rowOffset);
      if (from < source.length) this.#append(from);
    }
    this.#rebuild = false;
    this.#version = source.version;
    this.#generation = source.generation;
    this.#offset = source.rowOffset;
    this.#end = source.rowOffset + source.length;
  }

  #build() {
    const kept = this.#matching(0, this.source.length);
    if (this.#sort.length > 0) kept.sort(this.#comparator());
    this.#indices = kept;
    this.#spare = undefined;
    this.#length = kept.length;
  }

  /** Forgets rows dropped from the table and moves the others' positions down. */
  #drop(dropped: number) {
    const indices = this.#indices!;
    let n = 0;
    for (let i = 0; i < this.#length; i++) {
      const position = indices[i]! - dropped;
      if (position >= 0) indices[n++] = position;
    }
    this.#length = n;
  }

  #append(from: number) {
    const fresh = this.#matching(from, this.source.length);
    if (fresh.length === 0) return;
    const length = this.#length + fresh.length;
    if (this.#sort.length === 0) {
      // Filtered rows keep table order: new rows go at the end.
      this.#reserve(length);
      this.#indices!.set(fresh, this.#length);
      this.#length = length;
      return;
    }
    const compare = this.#comparator();
    fresh.sort(compare);
    // One merge of the batch, not an insertion per row.
    const out =
      this.#spare && this.#spare.length >= length ? this.#spare : new Uint32Array(grown(length));
    const old = this.#indices!;
    let [i, j, k] = [0, 0, 0];
    while (i < this.#length && j < fresh.length)
      out[k++] = compare(old[i]!, fresh[j]!) <= 0 ? old[i++]! : fresh[j++]!;
    while (i < this.#length) out[k++] = old[i++]!;
    while (j < fresh.length) out[k++] = fresh[j++]!;
    this.#spare = old;
    this.#indices = out;
    this.#length = length;
  }

  /** The sort's comparator for the table as it is now. */
  #comparator(): (a: number, b: number) => number {
    const version = this.source.version;
    if (this.#compare?.version !== version)
      this.#compare = {
        version,
        compare: rowComparator(this.source as unknown as Table, this.#sort),
      };
    return this.#compare.compare;
  }

  /** Positions from `from` to `to` that pass the filter and restriction, ascending. */
  #matching(from: number, to: number): Uint32Array {
    const source = this.source as unknown as Table;
    // Compiled now: a column's array can move and its category codes change as the table does.
    const test = this.#filter === undefined ? undefined : compileExpression(this.#filter, source);
    const restriction = this.#restriction;
    if (restriction && !restriction.current) return new Uint32Array(0);
    const kept = new Uint32Array(to - from);
    let n = 0;
    for (let row = from; row < to; row++) {
      if (test && !test.at(row)) continue;
      if (restriction && !restriction.has(row)) continue;
      kept[n++] = row;
    }
    return n === kept.length ? kept : kept.slice(0, n);
  }

  #reserve(length: number) {
    if (this.#indices && this.#indices.length >= length) return;
    const next = new Uint32Array(grown(length));
    if (this.#indices) next.set(this.#indices.subarray(0, this.#length));
    this.#indices = next;
  }
}

/** Views a table's rows; see `RowView`. */
export function rowView<S extends Schema>(source: Table<S>, query?: RowQuery<S>): RowView<S> {
  return new RowView(source, query);
}

/** Capacity for `length` positions, with room to grow. */
function grown(length: number): number {
  return Math.max(64, Math.ceil(length * 1.5));
}

/** A frozen copy of an expression. */
function frozen<E extends Expression | boolean | undefined>(expression: E): E {
  return (Array.isArray(expression) ? Object.freeze(expression.map(frozen)) : expression) as E;
}

/** The fields an expression reads. */
function fieldsOf(expression: Expression | undefined): string[] {
  if (!Array.isArray(expression)) return [];
  const [operator, ...operands] = expression as readonly [string, ...Expression[]];
  if (operator === "field") return [operands[0] as string];
  return operands.flatMap(fieldsOf);
}

const followers = new FinalizationRegistry<() => void>((stop) => stop());
