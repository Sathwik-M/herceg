// Row pivots: a row view's rows as a crosstab, with a row for each value of
// one field, and a column for each value of another and each aggregate. The
// aggregates are those of row groups (data/groups.ts) by the two fields, in
// one computation: the first level's groups are the pivot's rows (their
// table, `rowTable`, holds each row's totals) and the second level's its
// observed combinations, each a row of the long table `table`, which charts
// read as any table. The crosstab is an index over them (data/pivot-index.ts):
// it holds only combinations some row has, so a combination no row has
// (absent) is told apart from one whose values are all missing. Limits on
// the columns generated, the combinations, and the memory the pivot owns are
// checked before the groups grow: past one, the pivot stops where it was,
// never dropping values.

import {
  type GroupAggregate,
  type GroupBounds,
  type GroupSchema,
  type NamedAggregate,
  RowGroups,
} from "./groups.ts";
import { buildIndex, type CrosstabIndex, indexBytes, released } from "./pivot-index.ts";
import type { RowView } from "./row-view.ts";
import type { NumericField, PositionField, Schema, Table } from "./table.ts";

/** How far a pivot may grow; it stops when one is passed (see `PivotLimitError`). */
export interface PivotLimits {
  /** Columns generated: pivot values × aggregates, and a total per aggregate. 1,024 by default. */
  generatedColumns?: number;
  /** Combinations of a row and a pivot value that the view's rows hold. 1,000,000 by default. */
  observedCombinations?: number;
  /** Bytes the pivot owns beyond its view and table, as estimated. 128 MiB by default. */
  ownedBytes?: number;
}

/** The limits pivots take by default: experimental guards, to be measured, not product limits. */
export const PIVOT_LIMITS: Readonly<Required<PivotLimits>> = Object.freeze({
  generatedColumns: 1024,
  observedCombinations: 1_000_000,
  ownedBytes: 128 * 2 ** 20,
});

/**
 * A limit a pivot passed, with what it reached and what it allows. Thrown
 * by `pivotRows`; once the pivot follows its view, it stops instead, where
 * it was before the change that would pass it, and keeps the error as
 * `failure`.
 */
export class PivotLimitError extends RangeError {
  readonly limit: keyof PivotLimits;
  readonly observed: number;
  readonly budget: number;

  constructor(limit: keyof PivotLimits, observed: number, budget: number) {
    const what =
      limit === "generatedColumns"
        ? "generated columns"
        : limit === "observedCombinations"
          ? "combinations of a row and a pivot value"
          : "bytes (estimated)";
    super(
      `A pivot of ${observed.toLocaleString("en-US")} ${what} passes its limit of ${budget.toLocaleString("en-US")} (limits.${limit})`,
    );
    this.name = "PivotLimitError";
    this.limit = limit;
    this.observed = observed;
    this.budget = budget;
  }
}

/** A value of a pivot's rows or pivot field: a category's label, a number (a time's epoch milliseconds), or null for missing. */
export type PivotValue = string | number | null;

/**
 * A column a pivot generates: an aggregate under a pivot value, or a row's
 * total of an aggregate. Its id names it however values come and go:
 * the pivot field, the value with its kind, and the aggregate's name,
 * operation, and field; never a place, a label as shown, or a code.
 */
export type PivotColumn =
  | {
      readonly kind: "value";
      readonly id: string;
      readonly value: PivotValue;
      /** The value's place in `values`, for `cell` and `value`; it moves as values come and go. */
      readonly index: number;
      readonly aggregate: NamedAggregate;
    }
  | { readonly kind: "total"; readonly id: string; readonly aggregate: NamedAggregate };

/**
 * A pivot's crosstab as of one state of its groups (`RowPivot.read`).
 * Rows and values are numbered within it; keys and column ids are not.
 * Borrowed: valid until the pivot changes.
 */
export interface PivotSnapshot {
  /** Rows, one per value of the rows field, in the order they first appeared: the rows of `rowTable`. */
  readonly rowCount: number;
  /**
   * The pivot field's values the rows hold, in column order: categories in
   * the order of their field's dictionary, numbers and times ascending, and
   * missing last.
   */
  readonly values: readonly PivotValue[];
  /** The columns generated, in order: each value's aggregates, then each total. */
  readonly columns: readonly PivotColumn[];
  /** Whether the index is a dense array of every row and value, or sparse. */
  readonly dense: boolean;
  /** Set once the pivot stopped at a limit: it shows what it held before. */
  readonly failure: PivotLimitError | null;
  /** A row's value of the rows field. */
  rowKey(row: number): PivotValue;
  /** The place of a value in `values`, or -1. */
  indexOf(value: PivotValue): number;
  /** The column with this id, or undefined. */
  column(id: string): PivotColumn | undefined;
  /** The position in `table` of a row's combination with the value at `index` of `values`, or -1 when none of its rows has it (absent). */
  cell(row: number, index: number): number;
  /**
   * An aggregate of a row's combination with a value: NaN where its values
   * are missing; undefined where the combination is absent, except counts,
   * which are 0 there when the pivot fills them (`zeroFill`).
   */
  value(row: number, index: number, aggregate: string): number | undefined;
}

export interface PivotOptions<R extends string, P extends string, O> {
  /** The field whose values are the rows. */
  rows: R;
  /** The field whose values generate columns, one per value and aggregate. */
  pivot: P;
  /** The aggregates of each combination, by name: `count()`, `sum("bytes")`, and so on; at least one. */
  ops: O;
  /** Adds a column per aggregate with each row's total: the aggregate of all its rows. */
  totals?: boolean;
  /** Absent combinations' counts read 0 rather than nothing. */
  zeroFill?: "count";
  limits?: PivotLimits;
}

/** What the pivot built its crosstab from, and what it kept to extend it. */
interface Built {
  readonly rowGeneration: number;
  readonly generation: number;
  rows: number;
  count: number;
  /** Values by slot, the slot of each, and for category pivots each long-table code's slot. */
  readonly values: PivotValue[];
  readonly slotOf: Map<PivotValue, number>;
  codeSlots: Int32Array;
  /** Each combination's slot, with room. */
  slots: Int32Array;
  index: CrosstabIndex;
  /** Slots in column order. */
  order: Int32Array;
}

/** Each pivot's groups, for grids (grid/pivot.ts): never exported from `herceg/pivot`. */
const groupsOf = new WeakMap<RowPivot, RowGroups>();

/** The row groups a pivot is made of, which grids show its rows by; never to be changed. */
export function pivotGroups(pivot: RowPivot): RowGroups {
  return groupsOf.get(pivot)!;
}

/**
 * A row view's rows as a crosstab: rows by the values of `rows`, columns by
 * the values of `pivot` the rows hold and each aggregate. `table` holds an
 * aggregate row per observed combination (the rows and pivot fields, then
 * the aggregates) and `rowTable` one per row (its totals); `read()` gives
 * the crosstab over them. They follow the view as row groups do: appended
 * rows update the combinations they join and add those they start, and the
 * crosstab extends with them. A change that would pass a limit stops the
 * pivot where it was (`failure`): its tables and crosstab keep what they
 * held, and its rows list their rows as they were (those still in the
 * table), until `dispose`.
 */
export class RowPivot<
  S extends Schema = Schema,
  R extends string = string,
  P extends string = string,
  O = Record<string, GroupAggregate>,
> {
  readonly view: RowView<S>;
  readonly rows: R;
  readonly pivot: P;
  readonly aggregates: readonly NamedAggregate[];
  readonly totals: boolean;
  readonly zeroFill: "count" | undefined;
  readonly limits: Readonly<Required<PivotLimits>>;
  /** One row per observed combination: the rows field, the pivot field, and each aggregate. */
  readonly table: Table<GroupSchema<S, R | P, O>>;
  /** One row per row of the crosstab: the rows field and each aggregate of all its rows. */
  readonly rowTable: Table<GroupSchema<S, R, O>>;
  readonly #groups: RowGroups;
  readonly #bounds: PivotBounds;
  readonly #kind: "number" | "time" | "category";
  #built: Built | null = null;
  #crosstab: Crosstab | null = null;
  #disposed = false;
  readonly #listeners = new Set<() => void>();
  readonly #stop: () => void;

  constructor(view: RowView<S>, options: PivotOptions<R, P, O>) {
    const source = view.source as unknown as Table;
    const { rows, pivot } = options;
    for (const field of [rows, pivot]) {
      if (!source.has(field)) throw new Error(`Unknown pivot field "${field}"`);
      if (source.kind(field) === "geometry")
        throw new Error(`Rows cannot pivot by geometry ("${field}")`);
    }
    if ((rows as string) === pivot)
      throw new Error(`A pivot's rows and columns need two fields, not "${rows}"`);
    const ops = (options.ops ?? {}) as Record<string, GroupAggregate>;
    if (Object.keys(ops).length === 0) throw new RangeError("A pivot needs at least one aggregate");
    if (options.zeroFill !== undefined && options.zeroFill !== "count")
      throw new TypeError(`Pivots fill counts ("count"), not "${options.zeroFill}"`);
    const limits = { ...PIVOT_LIMITS, ...options.limits };
    for (const [name, value] of Object.entries(limits))
      if (!(value > 0)) throw new RangeError(`limits.${name} must be positive, not ${value}`);
    this.view = view;
    this.rows = rows;
    this.pivot = pivot;
    this.totals = options.totals ?? false;
    this.zeroFill = options.zeroFill;
    this.limits = Object.freeze(limits);
    this.#kind = source.kind(pivot) as "number" | "time" | "category";
    // Erased: the groups and the crosstab read the pivot's fields by name.
    const erased = this as unknown as RowPivot;
    this.#bounds = new PivotBounds(this.limits, this.totals, Object.keys(ops).length);
    const groups = new RowGroups(
      view as unknown as RowView,
      { by: [rows, pivot], ops },
      this.#bounds,
    );
    this.#groups = groups;
    groupsOf.set(erased, groups);
    this.aggregates = groups.aggregates;
    this.table = groups.table as unknown as Table<GroupSchema<S, R | P, O>>;
    this.rowTable = groups.tableOf(rows) as unknown as Table<GroupSchema<S, R, O>>;
    // Listeners hear of a change once the groups followed it, with any their
    // tables' listeners made meanwhile, or refused it. Held weakly by the
    // groups (which their tables keep): a pivot no one keeps is let go.
    const ref = new WeakRef(this);
    const stop = groups.subscribe(() => {
      const pivot = ref.deref();
      if (!pivot) stop();
      else {
        pivot.#release();
        pivot.#notify();
      }
    });
    this.#stop = stop;
  }

  /** The limit the pivot stopped at, or null while it follows its view. */
  get failure(): PivotLimitError | null {
    return this.#bounds.failure;
  }

  /**
   * Bytes of the typed arrays the pivot holds beyond its view and tables:
   * its groups' (see `RowGroups.byteLength`) and the crosstab's.
   */
  get byteLength(): number {
    const built = this.#built;
    // With the slots in column order, and each slot's place in it.
    const own = built
      ? built.index.byteLength +
        built.slots.byteLength +
        built.codeSlots.byteLength +
        2 * built.order.byteLength
      : 0;
    return this.#groups.byteLength + own;
  }

  /**
   * The crosstab, brought up to date: the same object until rows or values
   * are added or the groups renumbered; aggregates are read from the tables
   * as they are.
   */
  read(): PivotSnapshot {
    // Catches the groups up; stopped ones stay as they were.
    this.#groups.countAt(0);
    const rowTable = this.rowTable as unknown as Table;
    const table = this.table as unknown as Table;
    const crosstab = this.#crosstab;
    const built = this.#built;
    if (
      crosstab &&
      built &&
      crosstab.failure === this.failure &&
      built.rowGeneration === rowTable.generation &&
      built.generation === table.generation &&
      built.rows === rowTable.length &&
      built.count === table.length
    )
      return crosstab;
    this.#crosstab = this.#build();
    return this.#crosstab;
  }

  /** The table positions of a row's rows: those of every combination it has. */
  members(row: number): Uint32Array {
    this.#row(row);
    return this.#groups.members(row, 0);
  }

  /** The table positions of the rows of a row's combination with a pivot value; none where it is absent. */
  cellMembers(row: number, value: PivotValue): Uint32Array {
    const crosstab = this.#row(row);
    const index = crosstab.indexOf(value);
    const position = index < 0 ? -1 : crosstab.cell(row, index);
    return position < 0 ? new Uint32Array(0) : this.#groups.members(position, 1);
  }

  /**
   * Calls `listener` whenever the pivot may have changed, once it followed
   * its view's table or query (or stopped at a limit); returns a function
   * that stops it.
   */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Stops following the view; the tables keep their last values. The view stays the application's. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#groups.dispose();
    this.#stop();
    this.#listeners.clear();
  }

  #notify() {
    for (const listener of [...this.#listeners]) listener();
  }

  /**
   * Lets go, once the groups followed a change, of what the next read would
   * build anew: the crosstab of groups since renumbered, or an index that
   * cannot take the combinations added in place (a sparse one, or a dense
   * one without room, at most one value a combination).
   */
  #release() {
    const built = this.#built;
    if (!built) return;
    const rowTable = this.rowTable as unknown as Table;
    const table = this.table as unknown as Table;
    if (built.rowGeneration !== rowTable.generation || built.generation !== table.generation) {
      this.#built = null;
      this.#crosstab = null;
      return;
    }
    const added = table.length - built.count;
    if (added > 0 && !built.index.extends(rowTable.length, built.values.length + added)) {
      built.index = released(built.index.dense);
      this.#crosstab = null;
    }
  }

  /** The crosstab, after checking that it has the row. */
  #row(row: number): PivotSnapshot {
    const crosstab = this.read();
    if (!(Number.isInteger(row) && row >= 0 && row < crosstab.rowCount))
      throw new RangeError(`Row ${row} is not among the pivot's ${crosstab.rowCount} rows`);
    return crosstab;
  }

  /**
   * Builds the crosstab: from scratch when the groups were renumbered, else
   * extended with the rows and combinations added since.
   */
  #build(): Crosstab {
    const rowTable = this.rowTable as unknown as Table;
    const table = this.table as unknown as Table;
    const rows = rowTable.length;
    const count = table.length;
    const previous = this.#built;
    const extend =
      previous !== null &&
      previous.rowGeneration === rowTable.generation &&
      previous.generation === table.generation;
    const built: Built =
      extend && previous
        ? previous
        : {
            rowGeneration: rowTable.generation,
            generation: table.generation,
            rows: 0,
            count: 0,
            values: [],
            slotOf: new Map(),
            codeSlots: new Int32Array(0),
            slots: new Int32Array(0),
            index: buildIndex(0, 0, { count: 0, rows: [], slots: new Int32Array(0) }, null, 0),
            order: new Int32Array(0),
          };
    const from = built.count;
    const known = built.values.length;
    this.#slotCombinations(built, from, count);
    built.index = buildIndex(
      rows,
      built.values.length,
      { count, rows: this.#groups.parentsAt(1), slots: built.slots },
      extend ? built.index : null,
      from,
    );
    if (!extend || built.values.length !== known) built.order = this.#order(built.values);
    built.rows = rows;
    built.count = count;
    this.#built = built;
    return new Crosstab(this as unknown as RowPivot, built, this.failure);
  }

  /** Gives the combinations from `from` to `to` their values' slots, adding slots for new values. */
  #slotCombinations(built: Built, from: number, to: number) {
    const table = this.table as unknown as Table;
    if (built.slots.length < to) {
      const slots = new Int32Array(Math.max(64, Math.ceil(to * 1.5)));
      slots.set(built.slots.subarray(0, from));
      built.slots = slots;
    }
    const { values, slotOf, slots } = built;
    const slot = (value: PivotValue) => {
      let found = slotOf.get(value);
      if (found === undefined) {
        found = values.length;
        values.push(value);
        slotOf.set(value, found);
      }
      return found;
    };
    if (this.#kind === "category") {
      const { codes, dictionary } = table.categories(this.pivot);
      if (built.codeSlots.length < dictionary.length) {
        const codeSlots = new Int32Array(dictionary.length).fill(-1);
        codeSlots.set(built.codeSlots);
        built.codeSlots = codeSlots;
      }
      const codeSlots = built.codeSlots;
      for (let c = from; c < to; c++) {
        const code = codes[c]!;
        if (code < 0) slots[c] = slot(null);
        else {
          if (codeSlots[code]! < 0) codeSlots[code] = slot(dictionary[code]!);
          slots[c] = codeSlots[code]!;
        }
      }
      return;
    }
    const numbers = table.numbers(this.pivot);
    for (let c = from; c < to; c++) {
      const value = numbers[c]!;
      slots[c] = slot(Number.isNaN(value) ? null : value);
    }
  }

  /** Slots in column order: categories as their field's dictionary has them, numbers ascending, missing last. */
  #order(values: readonly PivotValue[]): Int32Array {
    const slots = Int32Array.from(values.keys());
    if (this.#kind === "category") {
      const wanted = new Set(values);
      wanted.delete(null);
      const rank = new Map<PivotValue, number>();
      const { dictionary } = (this.view.source as unknown as Table).categories(this.pivot);
      for (let code = 0; code < dictionary.length && rank.size < wanted.size; code++)
        if (wanted.has(dictionary[code]!)) rank.set(dictionary[code]!, code);
      const place = (slot: number) =>
        values[slot] === null
          ? Number.POSITIVE_INFINITY
          : (rank.get(values[slot]!) ?? dictionary.length);
      return slots.sort((a, b) => place(a) - place(b) || a - b);
    }
    return slots.sort((a, b) => {
      const [x, y] = [values[a] as number | null, values[b] as number | null];
      if (x === null || y === null) return x === null ? (y === null ? 0 : 1) : -1;
      return x - y || 0;
    });
  }
}

/**
 * Pivots a row view's rows: a row per value of `rows`, a column per value
 * of `pivot` and aggregate. See `RowPivot`.
 *
 * ```ts
 * const traffic = pivotRows(rowView(requests), {
 *   rows: "region",
 *   pivot: "service",
 *   ops: { requests: count(), latency: mean("latency") },
 *   totals: true,
 * });
 * bar(traffic.table, { x: "region", y: "requests", series: "service" });
 * ```
 */
export function pivotRows<
  S extends Schema,
  R extends PositionField<S>,
  P extends PositionField<S>,
  O extends Record<string, GroupAggregate<NumericField<S>>>,
>(view: RowView<S>, options: PivotOptions<R, P, O>): RowPivot<S, R, P, O> {
  return new RowPivot(view, options);
}

/**
 * A generated column's id: the pivot field, the value tagged with its kind
 * (or the total), and the aggregate's name, operation, and field, as JSON.
 * Numbers are written as text, so infinities keep apart.
 */
export function pivotColumnId(
  pivot: string,
  kind: "number" | "time" | "category",
  value: PivotValue | undefined,
  { name, op, field }: NamedAggregate,
): string {
  const tagged =
    value === undefined
      ? ["total"]
      : value === null
        ? ["missing"]
        : [kind, kind === "category" ? value : String(value)];
  return JSON.stringify(["pivot", pivot, ...tagged, name, op, field ?? null]);
}

/** The crosstab of one state of a pivot's groups. */
class Crosstab implements PivotSnapshot {
  readonly rowCount: number;
  readonly values: readonly PivotValue[];
  readonly dense: boolean;
  readonly failure: PivotLimitError | null;
  readonly #pivot: RowPivot;
  readonly #index: CrosstabIndex;
  readonly #order: Int32Array;
  readonly #slotOf: ReadonlyMap<PivotValue, number>;
  /** Each slot's place in `values`. */
  readonly #places: Int32Array;
  #columns: readonly PivotColumn[] | null = null;
  #byId: Map<string, PivotColumn> | null = null;

  constructor(pivot: RowPivot, built: Built, failure: PivotLimitError | null) {
    this.#pivot = pivot;
    this.#index = built.index;
    this.#order = built.order;
    this.#slotOf = built.slotOf;
    this.rowCount = built.rows;
    this.values = Object.freeze(Array.from(built.order, (slot) => built.values[slot]!));
    this.#places = new Int32Array(built.order.length);
    built.order.forEach((slot, place) => {
      this.#places[slot] = place;
    });
    this.dense = built.index.dense;
    this.failure = failure;
  }

  get columns(): readonly PivotColumn[] {
    if (this.#columns) return this.#columns;
    const pivot = this.#pivot;
    const kind = (pivot.view.source as unknown as Table).kind(pivot.pivot) as
      | "number"
      | "time"
      | "category";
    const columns: PivotColumn[] = [];
    this.values.forEach((value, index) => {
      for (const aggregate of pivot.aggregates)
        columns.push(
          Object.freeze({
            kind: "value",
            id: pivotColumnId(pivot.pivot, kind, value, aggregate),
            value,
            index,
            aggregate,
          }),
        );
    });
    if (pivot.totals)
      for (const aggregate of pivot.aggregates)
        columns.push(
          Object.freeze({
            kind: "total",
            id: pivotColumnId(pivot.pivot, kind, undefined, aggregate),
            aggregate,
          }),
        );
    this.#columns = Object.freeze(columns);
    return this.#columns;
  }

  rowKey(row: number): PivotValue {
    return (this.#pivot.rowTable as unknown as Table).value(this.#pivot.rows, row) as PivotValue;
  }

  indexOf(value: PivotValue): number {
    const slot = this.#slotOf.get(value);
    return slot === undefined || slot >= this.#places.length ? -1 : this.#places[slot]!;
  }

  column(id: string): PivotColumn | undefined {
    this.#byId ??= new Map(this.columns.map((column) => [column.id, column]));
    return this.#byId.get(id);
  }

  cell(row: number, index: number): number {
    if (!(row >= 0 && row < this.rowCount && index >= 0 && index < this.#order.length)) return -1;
    return this.#index.at(row, this.#order[index]!);
  }

  value(row: number, index: number, aggregate: string): number | undefined {
    const position = this.cell(row, index);
    const pivot = this.#pivot;
    if (position >= 0) return (pivot.table as unknown as Table).numbers(aggregate)[position];
    const op = pivot.aggregates.find(({ name }) => name === aggregate)?.op;
    if (op === undefined) throw new Error(`The pivot has no aggregate "${aggregate}"`);
    return op === "count" && pivot.zeroFill === "count" ? 0 : undefined;
  }
}

/**
 * A pivot's limits, as the bounds of its groups. While rows stream, a
 * combination (or value) that a batch's dropped rows leave empty still
 * counts as the batch is counted: groups are dropped once it is in.
 */
class PivotBounds implements GroupBounds {
  failure: PivotLimitError | null = null;
  readonly #limits: Readonly<Required<PivotLimits>>;
  readonly #totals: boolean;
  readonly #aggregates: number;

  /** Of the pivot's values, not the pivot: the groups keep their bounds, and must not keep it. */
  constructor(limits: Readonly<Required<PivotLimits>>, totals: boolean, aggregates: number) {
    this.#limits = limits;
    this.#totals = totals;
    this.#aggregates = aggregates;
  }

  check(groups: readonly number[], values: readonly number[], bytes: number): Error | null {
    const [limits, totals] = [this.#limits, this.#totals];
    const columns = (values[1]! + (totals ? 1 : 0)) * this.#aggregates;
    if (columns > limits.generatedColumns)
      return this.#refuse("generatedColumns", columns, limits.generatedColumns);
    const [rows, combinations] = groups as [number, number];
    if (combinations > limits.observedCombinations)
      return this.#refuse("observedCombinations", combinations, limits.observedCombinations);
    const owned = bytes + this.#bytes(rows, combinations, values[1]!, columns);
    if (owned > limits.ownedBytes) return this.#refuse("ownedBytes", owned, limits.ownedBytes);
    return null;
  }

  /**
   * Bytes the pivot would own beside its groups' typed arrays (which the
   * groups count): the index, each combination's slot and the long
   * table's codes' slots, the groups' tables with their room, and by fixed
   * estimates the JavaScript objects of the groups and tables (a group's key
   * value, map entry, and cached key and id; category entries) and of the
   * generated columns.
   */
  #bytes(rows: number, combinations: number, values: number, columns: number) {
    const aggregates = this.#aggregates;
    const room = (count: number) => Math.max(64, Math.ceil(count * 1.5));
    const own = indexBytes(rows, values, combinations) + 4 * room(combinations) + 4 * combinations;
    const tables = room(rows) * (8 + 8 * aggregates) + room(combinations) * (16 + 8 * aggregates);
    return own + tables + rows * 240 + combinations * 64 + 256 * columns;
  }

  #refuse(limit: keyof PivotLimits, observed: number, budget: number): PivotLimitError {
    this.failure = new PivotLimitError(limit, Math.ceil(observed), budget);
    return this.failure;
  }
}
