// Row groups: a row view's rows grouped by the values of some fields, with
// each group's counts, sums, means, minimums, and maximums in an ordinary
// table, one row per group, that charts and grids share. Values are read
// through the view's positions, so no column is copied; each group's rows
// are listed (positions in the view's order) only when a reader asks for
// them, as a grid showing a group's rows does.
//
// The table follows the view. Appended rows update the groups they join and
// add the groups they start, reading no other row; anything else (rows
// dropped, a value changed in place in a field the groups read, a new query
// or restriction, a reset) computes every group again, changing the table
// only where its values changed.

import { type ColumnInput, category, time } from "./column.ts";
import type { Expression } from "./expression.ts";
import { rowComparator } from "./order.ts";
import { fieldsOf, type RowSnapshot, type RowView } from "./row-view.ts";
import {
  type FieldName,
  type NumericField,
  type PositionField,
  type Schema,
  Table,
  type TableChange,
} from "./table.ts";

/** Operations that summarize a group's rows. */
export type GroupOp = "count" | "sum" | "mean" | "min" | "max";

/**
 * An aggregate of each group's rows, as `count()`, `sum("bytes")`, or
 * `mean("latency")` make. `count()` counts rows; with a field, operations
 * read its finite values: a count of them, their sum (0 without any), or
 * their mean, minimum, or maximum (missing without any).
 */
export interface GroupAggregate<F extends string = string> {
  readonly op: GroupOp;
  readonly field?: F;
}

/** One of the aggregates a groups' table holds. */
export interface NamedAggregate {
  readonly name: string;
  readonly op: GroupOp;
  readonly field: string | undefined;
}

/**
 * A group's value of each grouping field: a category's label, a number (a
 * time's epoch milliseconds), or null where the value is missing. Keys name
 * groups however rows come, go, and sort, and across resets; positions and
 * category codes do not.
 */
export type GroupKey = readonly (string | number | null)[];

/** Operations whose result is a value of their field, so a time stays a time. */
type KeepsKind = "mean" | "min" | "max";

type ResultKind<S extends Schema, A> = A extends { op: KeepsKind; field: infer F }
  ? F extends keyof S
    ? S[F] extends "time"
      ? "time"
      : "number"
    : "number"
  : "number";

/** The fields of a groups' table: the grouping fields, then each aggregate. */
export type GroupSchema<S extends Schema, B extends keyof S, O> = Pick<S, B> & {
  [P in keyof O & string]: ResultKind<S, O[P]>;
};

export interface GroupOptions<B extends string, O> {
  /** Fields whose values group the rows, one group per combination: numbers, times, or categories. */
  by: readonly B[];
  /** Each group's aggregates, by the name of the field they make in the table. */
  ops?: O;
}

/** A grouping field: the ids its values have been given, in order of first appearance. */
interface KeyField {
  readonly name: string;
  readonly kind: "number" | "time" | "category";
  /** Each value's id. Missing numbers are NaN here, missing categories null. */
  readonly ids: Map<string | number | null, number>;
  /** For categories: each dictionary code's id, -1 until seen since the last rebuild. */
  codeIds: Int32Array;
}

/** Ids of values combine as `id × RADIX + id`, exact while ids stay below it. */
const RADIX = 2 ** 26;

/** Each groups' table keeps its groups following; the source holds them only weakly. */
const keepers = new WeakMap<Table, RowGroups>();
const followers = new FinalizationRegistry<() => void>((stop) => stop());

/**
 * Unchanged groups between two changed ones that are written over rather
 * than ending a run: another `replace` costs about as much as copying them.
 */
const GAP = 64;

/**
 * The groups' table. An update of the groups writes several aggregates and
 * appends new groups; `batch` tells listeners of all of it as one change
 * once the last write is done, so none sees some aggregates updated and
 * others not. (A `Table` method doing this would be in every chart's bundle.)
 */
class GroupTable extends Table {
  readonly #listeners = new Set<(change: TableChange) => void>();
  #held: { appended: number; start: number; end: number; fields: Set<string> } | null = null;

  constructor(columns: Record<string, ColumnInput>) {
    super(columns);
    super.subscribe((change) => {
      const held = this.#held;
      if (!held) {
        for (const listener of [...this.#listeners]) listener(change);
        return;
      }
      // Batches replace and append, which move no row.
      held.appended += change.appended;
      if (change.updated) {
        held.start = Math.min(held.start, change.updated.start);
        held.end = Math.max(held.end, change.updated.end);
      }
      for (const field of change.fields) held.fields.add(field);
    });
  }

  override subscribe(listener: (change: TableChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Makes the replaces and appends `write` makes, then tells listeners of them as one change. */
  batch(write: () => void): void {
    const held = {
      appended: 0,
      start: Number.POSITIVE_INFINITY,
      end: 0,
      fields: new Set<string>(),
    };
    this.#held = held;
    try {
      write();
    } finally {
      this.#held = null;
    }
    const updated = held.fields.size > 0 ? { start: held.start, end: held.end } : null;
    if (!updated && held.appended === 0) return;
    const change = {
      dropped: 0,
      appended: held.appended,
      updated,
      fields: [...held.fields],
      reset: false,
    };
    for (const listener of [...this.#listeners]) listener(change);
  }
}

/**
 * A row view's rows grouped by the values of `by`, with the aggregates of
 * each group in `table`: one row per group, in the order groups first
 * appeared, holding the grouping fields' values and each aggregate. Rows are
 * read through the view's positions; no column is copied.
 *
 * The table is current as soon as the view's table changes: appended rows
 * update the rows of the groups they join and add rows for the groups they
 * start; other changes compute the groups again, and change the table where
 * their values differ, or reset it when a group lost its last row. Treat
 * the table as read-only. It keeps the groups following; `dispose()` stops
 * them.
 */
export class RowGroups<
  S extends Schema = Schema,
  // biome-ignore lint/suspicious/noExplicitAny: `RowGroups<S>` erases the table's fields, so readers such as grids take groups of any aggregates (which they name at runtime).
  R extends Schema = any,
> {
  readonly view: RowView<S>;
  readonly by: readonly FieldName<S>[];
  readonly aggregates: readonly NamedAggregate[];
  /** One row per group: the grouping fields' values, then each aggregate. */
  readonly table: Table<R>;
  readonly #table: GroupTable;
  readonly #source: Table;
  readonly #fields: KeyField[];
  /** For each grouping field after the first: (id of the values before it × RADIX + its value's id) → id. */
  readonly #levels: Map<number, number>[];

  #count = 0;
  #keys: GroupKey[] = [];
  #ids: string[] = [];
  /** Rows per group. */
  #rows = new Float64Array(0);
  /** Per aggregate: its running value per group (a count, a sum, a minimum, or a maximum). */
  #values: Float64Array[];
  /** Per aggregate: for means, the count of values summed. */
  #finite: (Float64Array | null)[];
  /** The group of each position the view shows; -1 for positions it leaves out. */
  #slots = new Int32Array(0);
  /** The positions of each group's rows, group after group, in the view's order. */
  #members = new Uint32Array(0);
  /** Where each group's rows start in #members, and where the last one's end. */
  #starts = new Uint32Array(1);
  #listed = -1;
  #compare: { version: number; query: number; compare: (a: number, b: number) => number } | null =
    null;

  /** What the groups were computed from. */
  #seen: {
    version: number;
    query: number;
    generation: number;
    rowOffset: number;
    length: number;
    modified: number;
  };
  /** Table changes heard since the last update, and what they need. */
  #heard = 0;
  #recompute = false;
  #reordered = false;
  /** The table's version as last changed here. */
  #published: number;
  #revision = 0;
  /** Set while changing the groups' table, whose listeners may read the groups or change their source. */
  #updating = false;
  #stopped = false;
  readonly #stop: () => void;

  constructor(
    view: RowView<S>,
    options: GroupOptions<FieldName<S>, Record<string, GroupAggregate>>,
  ) {
    const source = view.source as unknown as Table;
    this.view = view;
    this.#source = source;
    const by = [...options.by];
    if (by.length === 0) throw new RangeError("Groups need at least one field to group by");
    this.#fields = by.map((name, i) => {
      if (!source.has(name)) throw new Error(`Unknown grouping field "${name}"`);
      const kind = source.kind(name);
      if (kind === "geometry") throw new Error(`Rows cannot group by geometry ("${name}")`);
      if (by.indexOf(name) !== i) throw new Error(`Grouping field "${name}" is given twice`);
      return { name, kind, ids: new Map(), codeIds: new Int32Array(0) };
    });
    this.by = Object.freeze(by);
    this.#levels = by.slice(1).map(() => new Map());
    const aggregates = Object.entries(options.ops ?? {}).map(([name, { op, field }]) => {
      if (by.includes(name as FieldName<S>))
        throw new Error(`Aggregate "${name}" has the name of a grouping field`);
      if (!["count", "sum", "mean", "min", "max"].includes(op))
        throw new TypeError(`Aggregate "${name}": groups have no "${op}"`);
      if (field === undefined) {
        if (op !== "count") throw new TypeError(`Aggregate "${name}" (${op}) needs a field`);
      } else {
        if (!source.has(field)) throw new Error(`Aggregate "${name}": unknown field "${field}"`);
        const kind = source.kind(field);
        if (kind !== "number" && kind !== "time")
          throw new TypeError(`Aggregate "${name}": field "${field}" is a ${kind}, not numbers`);
      }
      return Object.freeze({ name, op, field });
    });
    this.aggregates = Object.freeze(aggregates);
    this.#values = aggregates.map(() => new Float64Array(0));
    this.#finite = aggregates.map(({ op }) => (op === "mean" ? new Float64Array(0) : null));

    this.#compute(view.read(), 0);
    this.#table = new GroupTable(this.#inputs());
    this.table = this.#table as unknown as Table<R>;
    this.#published = this.#table.version;
    this.#seen = this.#state();

    // Held weakly by what it follows, so groups no one keeps (nor their table) stop on their own.
    const ref = new WeakRef(this);
    const stops = [
      source.subscribe((change) => {
        const groups = ref.deref();
        if (groups) groups.#changed(change);
        else stop();
      }),
      view.subscribe(() => {
        const groups = ref.deref();
        if (!groups) stop();
        else if (view.queryRevision !== groups.#seen.query) groups.#update();
      }),
    ];
    const stop = () => {
      for (const unsubscribe of stops) unsubscribe();
    };
    this.#stop = stop;
    followers.register(this, stop, this);
    keepers.set(this.#table, this as unknown as RowGroups);
  }

  /** The number of groups. */
  get length(): number {
    this.#update();
    return this.#count;
  }

  /**
   * Increments whenever the groups, their aggregates, or the order of their
   * rows may have changed; readers keep what they derive from the groups by it.
   */
  get revision(): number {
    this.#update();
    return this.#revision;
  }

  /** Bytes the groups hold beyond their view and table: each row's group, the rows listed by group, and running aggregates. */
  get byteLength(): number {
    let bytes = this.#slots.byteLength + this.#members.byteLength + this.#starts.byteLength;
    bytes += this.#rows.byteLength;
    for (const values of this.#values) bytes += values.byteLength;
    for (const finite of this.#finite) bytes += finite?.byteLength ?? 0;
    return bytes;
  }

  /** The key of group `group` (a row of `table`). */
  keyOf(group: number): GroupKey {
    this.#check(group);
    return this.#keys[group]!;
  }

  /** A string naming the group by its key, unique among these groups: for maps and element keys. */
  idOf(group: number): string {
    this.#check(group);
    this.#ids[group] ??= groupId(this.#keys[group]!);
    return this.#ids[group];
  }

  /** The group (a row of `table`) with this key, or -1 when no row of the view has it. */
  indexOf(key: GroupKey): number {
    this.#update();
    const fields = this.#fields;
    if (key.length !== fields.length) return -1;
    let id = fields[0]!.ids.get(mapKey(fields[0]!, key[0]!));
    for (let k = 1; k < fields.length && id !== undefined; k++) {
      const next = fields[k]!.ids.get(mapKey(fields[k]!, key[k]!));
      id = next === undefined ? undefined : this.#levels[k - 1]!.get(id * RADIX + next);
    }
    return id ?? -1;
  }

  /** Rows of the view in the group. */
  size(group: number): number {
    this.#check(group);
    return this.#rows[group]!;
  }

  /** The group of the table's row at `position`, or -1 when the view leaves the row out. */
  groupOf(position: number): number {
    this.#update();
    if (!(Number.isInteger(position) && position >= 0 && position < this.#source.length)) return -1;
    // Nothing is left after `dispose`.
    return this.#slots[position] ?? -1;
  }

  /**
   * The positions of a group's rows in the view's order. Borrowed: valid
   * until the table or the view changes, and never to be written. The first
   * call after a change lists every group's rows, a pass over the view.
   */
  members(group: number): Uint32Array {
    this.#check(group);
    this.#list();
    return this.#members.subarray(this.#starts[group], this.#starts[group + 1]);
  }

  /** Where the table's row at `position` is among its group's rows, or -1 when the view leaves it out. */
  memberIndex(position: number): number {
    const group = this.groupOf(position);
    if (group < 0) return -1;
    this.#list();
    const members = this.#members;
    const start = this.#starts[group]!;
    const end = this.#starts[group + 1]!;
    // A group's rows are in the view's order, which breaks ties by position.
    const compare = this.#comparator();
    let [lo, hi] = [start, end];
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compare(members[mid]!, position) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo < end && members[lo] === position ? lo - start : -1;
  }

  /** Stops following the view; the table keeps its last values. */
  dispose(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#stop();
    followers.unregister(this);
    this.#slots = new Int32Array(0);
    this.#members = new Uint32Array(0);
    this.#compare = null;
  }

  #check(group: number) {
    this.#update();
    if (!(Number.isInteger(group) && group >= 0 && group < this.#count))
      throw new RangeError(`Group ${group} is not among the ${this.#count} groups`);
  }

  #state() {
    const source = this.#source;
    return {
      version: source.version,
      query: this.view.queryRevision,
      generation: source.generation,
      rowOffset: source.rowOffset,
      length: source.length,
      modified: source.modifiedVersion,
    };
  }

  /** A change of the table, heard as it happens (after the view's, which subscribed first). */
  #changed(change: TableChange) {
    // A read inside an earlier listener caught up with it already.
    if (this.#source.version === this.#seen.version) return;
    this.#heard++;
    if (change.updated) {
      const query = this.view.query;
      // A view keeps its filter as an expression.
      const reads = new Set<string>([...this.by, ...fieldsOf(query.filter as Expression)]);
      for (const { field } of this.aggregates) if (field !== undefined) reads.add(field);
      if (change.fields.some((field) => reads.has(field))) this.#recompute = true;
      else if (query.sort?.some(({ field }) => change.fields.includes(field)))
        this.#reordered = true;
    }
    this.#update();
  }

  /** Catches up with the view and its table. */
  #update() {
    const source = this.#source;
    const view = this.view;
    const seen = this.#seen;
    if (this.#stopped || this.#updating) return;
    if (source.version === seen.version && view.queryRevision === seen.query) return;
    const snapshot = view.read();
    // Changes made before a read caught up, which no listener call described.
    const unheard = source.version - seen.version > this.#heard;
    const recompute =
      this.#recompute ||
      (unheard && source.modifiedVersion !== seen.modified) ||
      source.generation !== seen.generation ||
      view.queryRevision !== seen.query ||
      source.rowOffset !== seen.rowOffset ||
      source.length < seen.length;
    const appended = !recompute && source.length > seen.length;
    if (recompute || appended || this.#reordered) this.#revision++;
    // Caught up before the groups' table changes: its listeners read what is current.
    this.#heard = 0;
    this.#recompute = false;
    this.#reordered = false;
    this.#seen = this.#state();
    this.#updating = true;
    try {
      if (recompute) this.#rebuild(snapshot);
      else if (appended) this.#append(snapshot, seen.length);
    } finally {
      this.#updating = false;
    }
    // A listener of the groups' table changed their source meanwhile.
    if (source.version !== this.#seen.version || view.queryRevision !== this.#seen.query)
      this.#update();
  }

  #rebuild(snapshot: RowSnapshot) {
    const old = this.#count;
    this.#compute(snapshot, 0);
    for (let group = 0; group < old; group++) {
      if (this.#rows[group] === 0) {
        this.#compact();
        this.#publishAll();
        return;
      }
    }
    this.#publish(null, old);
  }

  #append(snapshot: RowSnapshot, from: number) {
    const old = this.#count;
    this.#publish(this.#compute(snapshot, from), old);
  }

  /**
   * Groups the rows the view shows from position `from` on, all of them
   * from 0 (starting every group's aggregates again), in table order, and
   * adds them to their groups' aggregates. Returns the groups that existed
   * before and gained rows, ascending, when computing from a later position.
   */
  #compute(snapshot: RowSnapshot, from: number): number[] {
    const length = this.#source.length;
    if (from === 0) {
      this.#clear(0, this.#count);
      // Category codes may have been renumbered.
      for (const field of this.#fields) field.codeIds.fill(-1);
    }
    if (this.#slots.length < length) {
      // Room to grow once rows are appended; the first computation takes what it needs.
      const slots = new Int32Array(this.#slots.length === 0 ? length : grown(length));
      slots.set(this.#slots.subarray(0, from));
      this.#slots = slots;
    }
    const slots = this.#slots;
    this.#mark(snapshot, from, length);
    const old = this.#count;
    const find = this.#finder();
    const gained: number[] = [];
    // In table order, so aggregates come out as recomputing them would make them.
    for (let position = from; position < length; position++) {
      if (slots[position] !== -2) continue;
      const group = find(position);
      slots[position] = group;
      if (from > 0 && group < old) gained.push(group);
    }
    this.#accumulate(from, length);
    gained.sort((a, b) => a - b);
    return gained.filter((group, i) => i === 0 || gained[i - 1] !== group);
  }

  /** Marks the positions from `from` that the view shows -2 and the others -1. */
  #mark({ indices, length: shown }: RowSnapshot, from: number, length: number) {
    const slots = this.#slots;
    if (!indices) {
      slots.fill(-2, from, length);
      return;
    }
    slots.fill(-1, from, length);
    if (from === 0) {
      for (let i = 0; i < shown; i++) slots[indices[i]!] = -2;
    } else if (!this.view.query.sort?.length) {
      // Unsorted views keep table order: new rows are at the end.
      for (let i = shown - 1; i >= 0 && indices[i]! >= from; i--) slots[indices[i]!] = -2;
    } else {
      for (let i = 0; i < shown; i++) if (indices[i]! >= from) slots[indices[i]!] = -2;
    }
  }

  /** What finds the group of a row, adding it when its key is new; it reads the table as it is now. */
  #finder(): (position: number) => number {
    const fields = this.#fields;
    const ids = fields.map((field) => this.#idReader(field, fields.length === 1));
    if (ids.length === 1) return ids[0]!;
    const levels = this.#levels;
    const last = levels.length - 1;
    return (position) => {
      let id = ids[0]!(position);
      for (let k = 0; k <= last; k++) {
        const combined = id * RADIX + ids[k + 1]!(position);
        const level = levels[k]!;
        let next = level.get(combined);
        if (next === undefined) {
          next = k === last ? this.#add(position) : level.size;
          if (k < last && next >= RADIX) throw new RangeError("Too many groups");
          level.set(combined, next);
        }
        id = next;
      }
      return id;
    };
  }

  /** The id of a field's value in a row; with one grouping field, the id is the group, added when new. */
  #idReader(field: KeyField, groups: boolean): (position: number) => number {
    const source = this.#source;
    const ids = field.ids;
    const next = (position: number, value: string | number | null) => {
      // Ids of fields followed by others combine with theirs: they must stay below RADIX.
      const id = groups ? this.#add(position) : ids.size;
      if (!groups && id >= RADIX)
        throw new RangeError(`Too many values of "${field.name}" to group by`);
      ids.set(value, id);
      return id;
    };
    if (field.kind === "category") {
      const { codes, dictionary } = source.categories(field.name);
      if (field.codeIds.length < dictionary.length) {
        const grownIds = new Int32Array(grown(dictionary.length)).fill(-1);
        grownIds.set(field.codeIds);
        field.codeIds = grownIds;
      }
      const codeIds = field.codeIds;
      return (position) => {
        const code = codes[position]!;
        if (code < 0) return ids.get(null) ?? next(position, null);
        let id = codeIds[code]!;
        if (id < 0) {
          const label = dictionary[code]!;
          id = ids.get(label) ?? next(position, label);
          codeIds[code] = id;
        }
        return id;
      };
    }
    const values = source.numbers(field.name);
    return (position) => {
      const value = values[position]!;
      // Maps take NaN as one key, so missing numbers share a group.
      return ids.get(value) ?? next(position, value);
    };
  }

  /** Adds a group with the key of the row at `position`. */
  #add(position: number): number {
    const group = this.#count++;
    if (group >= this.#rows.length) this.#reserve(grown(group + 1));
    const source = this.#source;
    this.#keys[group] = Object.freeze(
      this.#fields.map(({ name, kind }) => {
        if (kind === "category") {
          const { codes, dictionary } = source.categories(name);
          const code = codes[position]!;
          return code < 0 ? null : dictionary[code]!;
        }
        const value = source.numbers(name)[position]!;
        // -0 groups with 0.
        return Number.isNaN(value) ? null : value === 0 ? 0 : value;
      }),
    );
    return group;
  }

  /** Room for `capacity` groups. */
  #reserve(capacity: number) {
    const grow = (array: Float64Array) => {
      const next = new Float64Array(capacity);
      next.set(array);
      return next;
    };
    const old = this.#rows.length;
    this.#rows = grow(this.#rows);
    this.#values = this.#values.map(grow);
    this.#finite = this.#finite.map((finite) => finite && grow(finite));
    this.#clear(old, capacity);
  }

  /** Empties the aggregates of groups `from` to `to`. */
  #clear(from: number, to: number) {
    this.#rows.fill(0, from, to);
    this.aggregates.forEach(({ op }, k) => {
      this.#values[k]!.fill(op === "min" || op === "max" ? Number.NaN : 0, from, to);
      this.#finite[k]?.fill(0, from, to);
    });
  }

  /** Adds the rows from position `from` on to their groups' aggregates. */
  #accumulate(from: number, to: number) {
    const slots = this.#slots;
    const rows = this.#rows;
    for (let position = from; position < to; position++) {
      const group = slots[position]!;
      if (group >= 0) rows[group]!++;
    }
    this.aggregates.forEach(({ op, field }, k) => {
      if (field === undefined) return;
      const values = this.#source.numbers(field);
      const out = this.#values[k]!;
      if (op === "count") {
        for (let position = from; position < to; position++) {
          const group = slots[position]!;
          if (group >= 0 && Number.isFinite(values[position]!)) out[group]!++;
        }
      } else if (op === "sum" || op === "mean") {
        const finite = this.#finite[k];
        for (let position = from; position < to; position++) {
          const group = slots[position]!;
          const value = values[position]!;
          if (group < 0 || !Number.isFinite(value)) continue;
          out[group]! += value;
          if (finite) finite[group]!++;
        }
      } else {
        const lower = op === "min";
        for (let position = from; position < to; position++) {
          const group = slots[position]!;
          const value = values[position]!;
          if (group < 0 || !Number.isFinite(value)) continue;
          const current = out[group]!;
          if (Number.isNaN(current) || (lower ? value < current : value > current))
            out[group] = value;
        }
      }
    });
  }

  /** Aggregate `k` of group `group`. */
  #result(k: number, group: number): number {
    const { op, field } = this.aggregates[k]!;
    if (op === "count" && field === undefined) return this.#rows[group]!;
    const value = this.#values[k]![group]!;
    if (op !== "mean") return value;
    const n = this.#finite[k]![group]!;
    return n > 0 ? value / n : Number.NaN;
  }

  /** Drops groups left without rows; the others keep their order. */
  #compact() {
    const count = this.#count;
    const rows = this.#rows;
    const remap = new Int32Array(count);
    let kept = 0;
    for (let group = 0; group < count; group++) remap[group] = rows[group]! > 0 ? kept++ : -1;
    const slots = this.#slots;
    const length = this.#source.length;
    for (let position = 0; position < length; position++) {
      const group = slots[position]!;
      if (group >= 0) slots[position] = remap[group]!;
    }
    // Survivors only move down, so moving them in order overwrites nothing still needed.
    for (let group = 0; group < count; group++) {
      const to = remap[group]!;
      if (to < 0 || to === group) continue;
      rows[to] = rows[group]!;
      for (const values of this.#values) values[to] = values[group]!;
      for (const finite of this.#finite) if (finite) finite[to] = finite[group]!;
      this.#keys[to] = this.#keys[group]!;
    }
    this.#keys.length = kept;
    this.#count = kept;
    this.#clear(kept, count);
    this.#ids = [];
    // Ids of the surviving keys only, so values seen once do not stay forever.
    for (const field of this.#fields) {
      field.ids.clear();
      field.codeIds.fill(-1);
    }
    for (const level of this.#levels) level.clear();
    this.#keys.forEach((key, group) => {
      this.#register(key, group);
    });
  }

  /** Gives a key's values their ids again, the whole key naming `group`. */
  #register(key: GroupKey, group: number) {
    const fields = this.#fields;
    const idOf = (k: number, own: number) => {
      const field = fields[k]!;
      const value = mapKey(field, key[k]!);
      let id = field.ids.get(value);
      if (id === undefined) {
        id = own;
        field.ids.set(value, id);
      }
      return id;
    };
    let id = idOf(0, fields.length === 1 ? group : fields[0]!.ids.size);
    const last = this.#levels.length - 1;
    for (let k = 0; k <= last; k++) {
      const combined = id * RADIX + idOf(k + 1, fields[k + 1]!.ids.size);
      const level = this.#levels[k]!;
      let next = level.get(combined);
      if (next === undefined) {
        next = k === last ? group : level.size;
        level.set(combined, next);
      }
      id = next;
    }
  }

  /**
   * Writes the aggregates that changed among `groups` (ascending; null for
   * every group before `old`), in runs of groups, then appends the groups
   * from `old` on, as one change of the table.
   */
  #publish(groups: readonly number[] | null, old: number) {
    const table = this.#table;
    // Someone else changed it: start it over.
    if (table.version !== this.#published || table.length !== old) {
      this.#publishAll();
      return;
    }
    const count = groups ? groups.length : old;
    table.batch(() => {
      this.aggregates.forEach(({ name }, k) => {
        const column = table.numbers(name);
        // Runs of changed groups, as start and end pairs.
        const runs: number[] = [];
        for (let i = 0; i < count; i++) {
          const group = groups ? groups[i]! : i;
          if (Object.is(this.#result(k, group), column[group])) continue;
          const last = runs.length - 1;
          if (last > 0 && group - runs[last]! <= GAP) runs[last] = group + 1;
          else runs.push(group, group + 1);
        }
        for (let r = 0; r < runs.length; r += 2) {
          const [start, end] = [runs[r]!, runs[r + 1]!];
          const values = new Float64Array(end - start);
          for (let group = start; group < end; group++)
            values[group - start] = this.#result(k, group);
          table.replace(name, start, values);
        }
      });
      if (this.#count > old) table.append(this.#batch(old, this.#count) as never);
    });
    this.#published = table.version;
  }

  #publishAll() {
    const table = this.#table;
    table.reset(this.#batch(0, this.#count) as never);
    this.#published = table.version;
  }

  /** Groups `from` to `to` as columns: labels for category keys, numbers for the rest. */
  #batch(from: number, to: number): Record<string, (string | null)[] | Float64Array> {
    const columns: Record<string, (string | null)[] | Float64Array> = Object.create(null);
    const keys = this.#keys;
    this.#fields.forEach(({ name, kind }, k) => {
      if (kind === "category") {
        columns[name] = keys.slice(from, to).map((key) => key[k] as string | null);
      } else {
        const values = new Float64Array(to - from);
        for (let group = from; group < to; group++)
          values[group - from] = (keys[group]![k] as number | null) ?? Number.NaN;
        columns[name] = values;
      }
    });
    this.aggregates.forEach(({ name }, k) => {
      const values = new Float64Array(to - from);
      for (let group = from; group < to; group++) values[group - from] = this.#result(k, group);
      columns[name] = values;
    });
    return columns;
  }

  /** The first table's columns, tagged with their kinds, as even empty ones keep them. */
  #inputs(): Record<string, ColumnInput> {
    const batch = this.#batch(0, this.#count);
    const inputs: Record<string, ColumnInput> = Object.create(null);
    const source = this.#source;
    for (const { name, kind } of this.#fields) {
      const column = batch[name]!;
      inputs[name] =
        kind === "category"
          ? category(column as (string | null)[])
          : kind === "time"
            ? time(column as Float64Array)
            : (column as Float64Array);
    }
    for (const { name, op, field } of this.aggregates) {
      const values = batch[name] as Float64Array;
      const keeps = op === "mean" || op === "min" || op === "max";
      inputs[name] =
        keeps && field !== undefined && source.kind(field) === "time" ? time(values) : values;
    }
    return inputs;
  }

  /** Lists each group's rows, in the view's order, when the groups changed since. */
  #list() {
    this.#update();
    if (this.#listed === this.#revision) return;
    const { indices, length } = this.view.read();
    const count = this.#count;
    const slots = this.#slots;
    const starts = new Uint32Array(count + 1);
    for (let i = 0; i < length; i++) starts[slots[indices ? indices[i]! : i]! + 1]!++;
    for (let group = 0; group < count; group++) starts[group + 1]! += starts[group]!;
    const members =
      this.#members.length >= length
        ? this.#members
        : new Uint32Array(this.#members.length === 0 ? length : grown(length));
    const next = starts.slice(0, count);
    for (let i = 0; i < length; i++) {
      const position = indices ? indices[i]! : i;
      members[next[slots[position]!]!++] = position;
    }
    this.#members = members;
    this.#starts = starts;
    this.#listed = this.#revision;
  }

  /** The view's order, for the table as it is now. */
  #comparator(): (a: number, b: number) => number {
    const source = this.#source;
    const query = this.view.queryRevision;
    const cached = this.#compare;
    if (cached?.version === source.version && cached.query === query) return cached.compare;
    const sort = this.view.query.sort ?? [];
    const compare = sort.length > 0 ? rowComparator(source, sort) : (a: number, b: number) => a - b;
    this.#compare = { version: source.version, query, compare };
    return compare;
  }
}

/**
 * Groups a row view's rows by the values of `by`, with aggregates of each
 * group in `groups.table`; see `RowGroups`.
 *
 * ```ts
 * const byService = groupRows(rowView(requests), {
 *   by: ["service"],
 *   ops: { requests: count(), latency: mean("latency") },
 * });
 * bar(byService.table, { x: "service", y: "requests" });
 * ```
 */
export function groupRows<
  S extends Schema,
  B extends PositionField<S>,
  O extends Record<string, GroupAggregate<NumericField<S>>> = Record<never, never>,
>(view: RowView<S>, options: GroupOptions<B, O>): RowGroups<S, GroupSchema<S, B, O>> {
  return new RowGroups(
    view,
    options as unknown as GroupOptions<FieldName<S>, Record<string, GroupAggregate>>,
  );
}

/**
 * A string naming a group by its key: its values as JSON, with infinities
 * as text. Unique among one grouping's keys, whose values at each place are
 * all labels or all numbers.
 */
export function groupId(key: GroupKey): string {
  return JSON.stringify(key, (_, value) =>
    typeof value === "number" && !Number.isFinite(value) ? String(value) : value,
  );
}

/** A key's value as a field's ids are keyed: missing numbers are NaN. */
function mapKey(field: KeyField, value: string | number | null): string | number | null {
  return value === null && field.kind !== "category" ? Number.NaN : value;
}

/** Capacity for `length` entries, with room to grow. */
function grown(length: number): number {
  return Math.max(64, Math.ceil(length * 1.5));
}
