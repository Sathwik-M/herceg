// Row groups: a row view's rows grouped by the values of some fields, level
// by level (by the first field, then the first two, and so on), with each
// group's counts, sums, means, minimums, and maximums in an ordinary table
// per level, one row per group, that charts and grids share. Values are read
// through the view's positions, so no column is copied; each group's rows
// are listed (in the view's order) only once a reader asks for them, as a
// grid showing a group's rows does, and then kept current.
//
// The tables follow the view. Rows appended, and rows a rolling window drops
// from the front, update the groups they join or leave, reading no other row
// (but the rows of a group whose minimum or maximum left); anything else (a
// value changed in place in a field the groups read, a new query or
// restriction, a reset) computes every group again, changing the tables only
// where their values changed.

import { type ColumnInput, category, time } from "./column.ts";
import type { Expression } from "./expression.ts";
import { GroupLevel, GroupTable, type LevelAggregate } from "./group-levels.ts";
import { MemberRuns } from "./group-members.ts";
import { rowComparator } from "./order.ts";
import { fieldsOf, type RowSnapshot, type RowView } from "./row-view.ts";
import type {
  FieldName,
  NumericField,
  PositionField,
  Schema,
  Table,
  TableChange,
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

/** One of the aggregates a groups' tables hold. */
export interface NamedAggregate {
  readonly name: string;
  readonly op: GroupOp;
  readonly field: string | undefined;
}

/**
 * A group's key path: its value of each grouping field down to its own
 * level, a category's label, a number (a time's epoch milliseconds), or null
 * where the value is missing. Keys name groups however rows come, go, and
 * sort, and across resets; positions and category codes do not.
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

/**
 * The grouping fields a level's table lacks: those after `F` in `B`, or,
 * when `B` is not a tuple (its order unknown), every one but `F` (every one
 * but which `F` is, when `F` is a union).
 */
type After<B extends readonly string[], F extends string> = B extends readonly [
  infer First,
  ...infer Rest extends readonly string[],
]
  ? First extends F
    ? Rest[number]
    : After<Rest, F>
  : number extends B["length"]
    ? F extends unknown
      ? Exclude<B[number], F>
      : never
    : never;

/** A level's table: the last level's fields less the grouping fields below it; any fields for groups whose fields are erased. */
type LevelTable<R extends Schema, B extends readonly string[], F extends string> = unknown extends R
  ? Table<R>
  : Table<Omit<R, After<B, F>>>;

export interface GroupOptions<B extends string, O> {
  /**
   * Fields whose values group the rows: numbers, times, or categories. With
   * several, groups nest: by the first field, then within each of those by
   * the second, and so on.
   */
  by: readonly B[];
  /** Each group's aggregates, by the name of the field they make in the tables. */
  ops?: O;
}

/**
 * What bounds how far groups grow (a row pivot's limits, data/pivot.ts),
 * asked what they would reach: per level the groups there and the values of
 * its grouping field, and the bytes of the typed arrays they would hold (what
 * they hold, what growing to that takes, and the most reading them can still
 * take: listing groups' rows and children, reading a group's rows again). An
 * error refuses. Groups being made ask as they take room for the rows and
 * as they add each group, and throw the refusal (nothing is kept). Groups
 * following their view count what a change would make them before changing
 * anything, asking as each new group or value is counted; refused, they stop
 * where they were, throwing nothing to the table's listeners: their tables
 * keep their last values, and reads answer as they would have then (for
 * rows still in the table), until `dispose`. Bounded groups that compute every group
 * again number them afresh, so groups the rows no longer hold never count.
 */
export interface GroupBounds {
  check(groups: readonly number[], values: readonly number[], bytes: number): Error | null;
}

/** A grouping field: the ids its values have been given, in order of first appearance. */
interface KeyField {
  readonly name: string;
  readonly kind: "number" | "time" | "category";
  /** Each value's id (on the first level, its group). Missing numbers are NaN here, missing categories null. */
  readonly ids: Map<string | number | null, number>;
  /** For categories: each dictionary code's id, -1 until seen since codes may have changed. */
  codeIds: Int32Array;
}

/** Ids of groups and values combine as `group × RADIX + id`, exact while ids stay below it. */
const RADIX = 2 ** 26;

/** Each groups' table keeps its groups following; the source holds them only weakly. */
const keepers = new WeakMap<Table, RowGroups>();
const followers = new FinalizationRegistry<() => void>((stop) => stop());

/**
 * A row view's rows grouped by the values of `by`, level by level: the
 * groups of each level (`depth` 0 for the first field) hold the rows of
 * their key, the groups of the level below split them by the next field, and
 * each row belongs to one group of the last level. Each level has a table
 * (`tableOf(field)`; `table` is the last level's), one row per group, in the
 * order groups first appeared, holding the grouping fields' values and each
 * aggregate. Rows are read through the view's positions; no column is copied.
 *
 * The tables are current as soon as the view's table changes: appended and
 * dropped rows update the groups they join and leave and add the groups they
 * start; other changes compute the groups again. Tables change where their
 * values differ, or reset when one of their groups lost its last row. Treat
 * them as read-only. They keep the groups following; `dispose()` stops them.
 */
export class RowGroups<
  S extends Schema = Schema,
  // biome-ignore lint/suspicious/noExplicitAny: `RowGroups<S>` erases the tables' fields, so readers such as grids take groups of any aggregates (which they name at runtime).
  R extends Schema = any,
  B extends readonly string[] = readonly string[],
> {
  readonly view: RowView<S>;
  readonly by: readonly FieldName<S>[];
  readonly aggregates: readonly NamedAggregate[];
  /** The last level's table: one row per group of every grouping field's values. */
  readonly table: Table<R>;
  readonly #source: Table;
  readonly #fields: KeyField[];
  readonly #levels: GroupLevel[];
  /** For each level below the first: (parent × RADIX + id of the value) → group. */
  readonly #lookups: Map<number, number>[];
  /** The fields aggregates read, each once. */
  readonly #read: readonly string[];
  /** Aggregates whose values are times. */
  readonly #times: ReadonlySet<string>;

  /** The last level's group of each row the view shows, -1 for others: position `p` at `#offset + p`. */
  #slots = new Int32Array(0);
  #offset = 0;
  /** The values of the fields in `#read`, at the same indices: kept to take rows away once the table drops them. */
  #kept: Float64Array[] | null = null;
  /** Whether the table drops rows (it has `maxRows`, or has dropped some). */
  #dropping: boolean;
  /** Each last-level group's rows, once a reader asked for them. */
  #members: MemberRuns | null = null;
  #children: {
    renumbered: number;
    groups: number;
    starts: Int32Array[];
    lists: Int32Array[];
  } | null = null;
  /** Room for the rows of a group whose aggregates are read again. */
  #scratch = new Uint32Array(0);
  /** Counts renumberings of the groups. */
  #renumbered = 0;
  /** Set when a group lost its last row. */
  #emptied = false;
  readonly #bounds: GroupBounds | undefined;
  /** Set when bounded groups computed every group afresh, renumbering them. */
  #fresh = false;
  /** The view's order, for one version of the table, and the bytes of the category ranks it holds. */
  #compare: {
    version: number;
    query: number;
    compare: (a: number, b: number) => number;
    bytes: number;
  } | null = null;

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
  #revision = 0;
  /** Set while changing the groups' tables, whose listeners may read the groups or change their source. */
  #updating = false;
  #stopped = false;
  /** Set once the bounds refused a change: the groups no longer follow, and read as they were. */
  #frozen = false;
  #lookupCost = { version: -1, room: -1, bytes: 0 };
  #ranks = { version: -1, query: -1, bytes: 0 };
  /** While bounded groups are first made: what they reach so far, asked of the bounds as they grow. */
  #making: { rows: number; groups: number[]; values: number[] } | null = null;
  readonly #stop: () => void;
  readonly #listeners = new Set<() => void>();

  /** `bounds` limits how far the groups grow; row pivots (data/pivot.ts) give them. */
  constructor(
    view: RowView<S>,
    options: GroupOptions<FieldName<S>, Record<string, GroupAggregate>>,
    bounds?: GroupBounds,
  ) {
    const source = view.source as unknown as Table;
    this.view = view;
    this.#source = source;
    this.#bounds = bounds;
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
    this.#lookups = by.map(() => new Map());
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
    const read = [
      ...new Set(aggregates.flatMap(({ field }) => (field === undefined ? [] : [field]))),
    ];
    this.#read = read;
    this.#times = new Set(
      aggregates
        .filter(({ op, field }) => op !== "count" && op !== "sum" && field !== undefined)
        .filter(({ field }) => source.kind(field!) === "time")
        .map(({ name }) => name),
    );
    const leveled: LevelAggregate[] = aggregates.map(({ name, op, field }) => ({
      name,
      op,
      field: field === undefined ? -1 : read.indexOf(field),
    }));
    this.#levels = by.map((_, depth) => new GroupLevel(depth, depth === by.length - 1, leveled));
    this.#dropping = source.maxRows !== Number.POSITIVE_INFINITY;

    if (bounds) {
      this.#making = { rows: 0, groups: by.map(() => 0), values: by.map(() => 0) };
      // What groups of no rows take (their columns, their fields' dictionaries) counts too.
      this.#ask(() => {});
    }
    this.#compute(view.read());
    this.#making = null;
    this.#seen = this.#state();
    this.#refresh();
    for (const level of this.#levels) {
      level.table = new GroupTable(this.#columns(level, 0, level.count, true));
      level.published = { version: level.table.version, length: level.count };
      level.unmark();
      keepers.set(level.table, this as unknown as RowGroups);
    }
    this.table = this.#levels.at(-1)!.table as unknown as Table<R>;

    // Held weakly by what it follows, so groups no one keeps (nor their tables) stop on their own.
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
  }

  /** The number of groups of the last level. */
  get length(): number {
    return this.countAt(this.by.length - 1);
  }

  /** The number of groups at `depth` (0 for the first grouping field's). */
  countAt(depth: number): number {
    this.#update();
    return this.#level(depth).count;
  }

  /**
   * Increments whenever the groups, their aggregates, or the order of their
   * rows may have changed; readers keep what they derive from the groups by it.
   */
  get revision(): number {
    this.#update();
    return this.#revision;
  }

  /**
   * Bytes of the typed arrays the groups hold beyond their view and tables:
   * each row's group, values kept for rows to drop, the rows listed by
   * group, and each group's running aggregates. Keys, ids, and the maps of
   * values, which grow with the number of groups, are not counted.
   */
  get byteLength(): number {
    let bytes = this.#slots.byteLength + this.#scratch.byteLength;
    bytes += this.#members?.byteLength ?? 0;
    for (const kept of this.#kept ?? []) bytes += kept.byteLength;
    for (const level of this.#levels) bytes += level.byteLength;
    for (const field of this.#fields) bytes += field.codeIds.byteLength;
    for (const list of this.#children?.lists ?? []) bytes += list.byteLength;
    for (const starts of this.#children?.starts ?? []) bytes += starts.byteLength;
    return bytes + (this.#compare?.bytes ?? 0);
  }

  /**
   * The table of the groups by the grouping fields up to `field`: one row
   * per group, holding those fields' values and each aggregate.
   */
  tableOf<F extends B[number]>(field: F): LevelTable<R, B, F> {
    const depth = this.by.indexOf(field as unknown as FieldName<S>);
    if (depth < 0) throw new Error(`The groups have no grouping field "${field}"`);
    return this.#levels[depth]!.table as unknown as LevelTable<R, B, F>;
  }

  /** The key of a group (a row of its level's table) at `depth`, the last level's by default. */
  keyOf(group: number, depth = this.by.length - 1): GroupKey {
    this.#check(group, depth);
    const levels = this.#levels;
    const level = levels[depth]!;
    let key = level.keys[group];
    if (!key) {
      const values: (string | number | null)[] = new Array(depth + 1);
      for (let d = depth, g = group; d >= 0; d--) {
        values[d] = levels[d]!.values[g]!;
        g = levels[d]!.parents[g]!;
      }
      key = level.keys[group] = Object.freeze(values);
    }
    return key;
  }

  /** A string naming a group by its key, unique among these groups: for maps and element keys. */
  idOf(group: number, depth = this.by.length - 1): string {
    const level = this.#levels[depth];
    this.#check(group, depth);
    level!.ids[group] ??= groupId(this.keyOf(group, depth));
    return level!.ids[group];
  }

  /** The group (a row of its level's table) with this key, or -1: the key's length gives its level. */
  indexOf(key: GroupKey): number {
    this.#update();
    const fields = this.#fields;
    if (key.length < 1 || key.length > fields.length) return -1;
    let group = fields[0]!.ids.get(mapKey(fields[0]!, key[0]!));
    for (let d = 1; d < key.length && group !== undefined; d++) {
      const id = fields[d]!.ids.get(mapKey(fields[d]!, key[d]!));
      group = id === undefined ? undefined : this.#lookups[d]!.get(group * RADIX + id);
    }
    return group ?? -1;
  }

  /** Rows of the view in a group at `depth`, the last level by default. */
  size(group: number, depth = this.by.length - 1): number {
    this.#check(group, depth);
    return this.#levels[depth]!.rows[group]!;
  }

  /** The group of the level above holding a group at `depth`; -1 on the first level. */
  parentOf(group: number, depth: number): number {
    this.#check(group, depth);
    return depth === 0 ? -1 : this.#levels[depth]!.parents[group]!;
  }

  /**
   * The parent of every group at `depth` (below the first), by group: what
   * `parentOf` gives one at a time. Borrowed: valid until groups are added
   * or renumbered, and never to be written.
   */
  parentsAt(depth: number): Int32Array {
    this.#update();
    const level = this.#level(depth);
    if (depth === 0) throw new RangeError("Groups of the first level have no parents");
    return level.parents.subarray(0, level.count);
  }

  /**
   * The groups of the level below in a group at `depth`, in the order they
   * appeared; none on the last level. Borrowed: valid until groups are
   * added or renumbered, and never to be written.
   */
  childrenOf(group: number, depth: number): Int32Array {
    this.#check(group, depth);
    if (depth === this.by.length - 1) return new Int32Array(0);
    const { starts, lists } = this.#childLists();
    return lists[depth]!.subarray(starts[depth]![group], starts[depth]![group + 1]);
  }

  /** The group at `depth` (the last level by default) of the table's row at `position`, or -1 when the view leaves the row out. */
  groupOf(position: number, depth = this.by.length - 1): number {
    this.#update();
    this.#level(depth);
    if (!(Number.isInteger(position) && position >= 0 && position < this.#source.length)) return -1;
    const index = this.#indexAt(position);
    // Nothing is left after `dispose`.
    let group = index < 0 ? -1 : (this.#slots[index] ?? -1);
    for (let d = this.by.length - 1; d > depth && group >= 0; d--)
      group = this.#levels[d]!.parents[group]!;
    return group;
  }

  /**
   * The positions of a group's rows, in a new array: the rows of a
   * last-level group in the view's order, and of a group above, each of its
   * last-level groups' rows in turn, in the order those groups appeared.
   * The first call after rows were listed anew (see `memberAt`) lists them.
   */
  members(group: number, depth = this.by.length - 1): Uint32Array {
    this.#check(group, depth);
    if (this.#stopped) return new Uint32Array(0);
    const runs = this.#runs();
    const rowOffset = this.#source.rowOffset;
    const last = this.by.length - 1;
    const leaves: number[] = [];
    const visit = (g: number, d: number) => {
      if (d === last) leaves.push(g);
      else for (const child of this.childrenOf(g, d)) visit(child, d + 1);
    };
    visit(group, depth);
    const out = new Uint32Array(leaves.reduce((sum, leaf) => sum + runs.size(leaf), 0));
    let at = 0;
    for (const leaf of leaves) at += runs.copy(leaf, out, at, rowOffset);
    return out;
  }

  /**
   * The table position of the `index`th row, in the view's order, of a
   * last-level group. Rows are listed by group when first asked for (a pass
   * over the view) and kept current from then on as rows stream; a new
   * query, a reset, or a change of a field the groups read or the view sorts
   * by lists them again when next asked.
   */
  memberAt(group: number, index: number): number {
    this.#check(group, this.by.length - 1);
    const runs = this.#stopped ? null : this.#runs();
    if (!(runs && Number.isInteger(index) && index >= 0 && index < runs.size(group)))
      throw new RangeError(`Group ${group} has no row ${index}`);
    return runs.at(group, index, this.#source.rowOffset);
  }

  /** Where the table's row at `position` is among its last-level group's rows, or -1 when the view leaves it out. */
  memberIndex(position: number): number {
    const group = this.groupOf(position);
    if (group < 0 || this.#stopped) return -1;
    const runs = this.#runs();
    // A group's rows are in the view's order, which breaks ties by position (frozen ones in table order).
    const order = this.view.query.sort?.length && !this.#frozen ? this.#comparator() : null;
    return runs.indexOf(group, position, this.#source.rowOffset, order);
  }

  /**
   * Calls `listener` whenever the groups followed a change of their view or
   * table, once they caught up with any change their tables' listeners made
   * meanwhile (or, bounded, stopped at it); returns a function that stops it.
   */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Stops following the view; the tables keep their last values. */
  dispose(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#stop();
    followers.unregister(this);
    this.#slots = new Int32Array(0);
    this.#kept = null;
    this.#members = null;
    this.#children = null;
    this.#compare = null;
    this.#scratch = new Uint32Array(0);
    this.#listeners.clear();
  }

  #level(depth: number): GroupLevel {
    const level = this.#levels[depth];
    if (!(Number.isInteger(depth) && level))
      throw new RangeError(`Depth ${depth} is not among the ${this.by.length} levels of groups`);
    return level;
  }

  #check(group: number, depth: number) {
    this.#update();
    const { count } = this.#level(depth);
    if (!(Number.isInteger(group) && group >= 0 && group < count))
      throw new RangeError(`Group ${group} is not among the ${count} groups at depth ${depth}`);
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
      const reads = new Set<string>([
        ...this.by,
        ...this.#read,
        ...fieldsOf(query.filter as Expression),
      ]);
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
    if (this.#stopped || this.#frozen || this.#updating) return;
    if (source.version === seen.version && view.queryRevision === seen.query) return;
    const snapshot = view.read();
    // Changes made before a read caught up, which no listener call described.
    const unheard = source.version - seen.version > this.#heard;
    const dropped = source.rowOffset - seen.rowOffset;
    if (dropped > 0) this.#dropping = true;
    const recompute =
      this.#recompute ||
      (unheard && source.modifiedVersion !== seen.modified) ||
      source.generation !== seen.generation ||
      view.queryRevision !== seen.query ||
      // Dropped rows are taken away by their values, kept from now on.
      (dropped > 0 && this.#read.length > 0 && !this.#kept);
    const moved = dropped > 0 || source.rowOffset + source.length !== seen.rowOffset + seen.length;
    const reordered = this.#reordered;
    // The view's order as it was holds the table's old arrays.
    this.#compare = null;
    // Bounded groups refused what the change would make them (a new order of
    // a sorted view too, whose ranks they would make) stop as they are.
    if (this.#bounds && (recompute || moved || reordered)) {
      const from = recompute ? 0 : Math.max(0, seen.rowOffset + seen.length - source.rowOffset);
      if (this.#refusal(snapshot, from, recompute, Math.min(dropped, seen.length))) {
        this.#frozen = true;
        this.#stop();
        followers.unregister(this);
        this.#tell();
        return;
      }
    }
    if (recompute || moved || reordered) this.#revision++;
    // Caught up before the groups' tables change: their listeners read what is current.
    this.#heard = 0;
    this.#recompute = false;
    this.#reordered = false;
    this.#seen = this.#state();
    this.#updating = true;
    try {
      // Rows of a group are listed again in their new order when next asked for.
      if (reordered) this.#members = null;
      if (recompute) this.#rebuild(snapshot);
      else if (moved) this.#follow(snapshot, seen);
    } finally {
      this.#updating = false;
    }
    // A listener of the groups' tables changed their source meanwhile.
    if (source.version !== this.#seen.version || view.queryRevision !== this.#seen.query)
      this.#update();
    else this.#tell();
  }

  #tell() {
    for (const listener of [...this.#listeners]) listener();
  }

  /** Computes every group again; groups that remain keep their numbers. */
  #rebuild(snapshot: RowSnapshot) {
    this.#compute(snapshot);
    const last = this.#levels.at(-1)!;
    for (let group = 0; group < last.count && !this.#emptied; group++)
      if (last.rows[group] === 0) this.#emptied = true;
    this.#finish(true);
  }

  /** Takes away the rows dropped since `seen` and adds those appended. */
  #follow(snapshot: RowSnapshot, seen: { rowOffset: number; length: number }) {
    const source = this.#source;
    // An append larger than `maxRows` drops every row there was, and some of its own.
    const removed = Math.min(source.rowOffset - seen.rowOffset, seen.length);
    const from = Math.max(0, seen.rowOffset + seen.length - source.rowOffset);
    // Tables compact a dictionary as rows drop, renumbering its codes.
    if (source.rowOffset > seen.rowOffset) this.#forgetCodes();
    if (removed > 0) this.#remove(removed, seen.rowOffset + removed);
    if (from < source.length) this.#add(snapshot, from);
    this.#finish(false);
  }

  /**
   * Brings the groups up to date once rows were added and taken away, and
   * writes the tables, telling their listeners once every table is written.
   */
  #finish(everyGroup: boolean) {
    this.#refresh();
    const reset = this.#emptied
      ? this.#compact()
      : this.#fresh
        ? this.#levels.map(() => true)
        : null;
    this.#fresh = false;
    const changes = this.#levels.map((level) =>
      level.publish(reset?.[level.depth] ?? false, everyGroup, (from, to) =>
        this.#columns(level, from, to, false),
      ),
    );
    this.#levels.forEach((level, depth) => {
      const change = changes[depth];
      if (change) level.table.tell(change);
    });
  }

  /**
   * Groups every row the view shows and adds it to its groups' aggregates,
   * from scratch, in table order: the last level's from the rows, each
   * level above's from the one below.
   */
  #compute(snapshot: RowSnapshot) {
    const source = this.#source;
    const length = source.length;
    const levels = this.#levels;
    // Groups the rows no longer hold would count against the bounds until
    // they are dropped: bounded groups start over, as their bounds counted.
    const fresh = this.#bounds !== undefined && !this.#making;
    for (const level of levels) {
      if (fresh) level.forget();
      else level.clear(0, level.count);
    }
    if (fresh) {
      for (const field of this.#fields) field.ids.clear();
      for (const lookup of this.#lookups) lookup.clear();
      this.#fresh = true;
      this.#renumbered++;
      this.#children = null;
    }
    // Category codes may have been renumbered.
    this.#forgetCodes();
    this.#offset = 0;
    if (this.#slots.length < length) {
      // Room to grow once rows are appended; the first computation takes what it needs.
      const size = this.#slots.length === 0 ? length : grown(length);
      if (this.#making) this.#ask((making) => (making.rows = size));
      this.#slots = new Int32Array(size);
    }
    const slots = this.#slots;
    this.#mark(snapshot, 0, length);
    const find = this.#finder();
    for (let position = 0; position < length; position++)
      if (slots[position] === -2) slots[position] = find(position);
    const columns = this.#read.map((field) => source.numbers(field));
    levels.at(-1)!.accumulate(slots, 0, length, columns, 0);
    for (let depth = levels.length - 1; depth > 0; depth--)
      levels[depth - 1]!.fold(levels[depth]!, null);
    // Values cancelling can leave a sum's compensation off: those are summed again exactly.
    for (const level of levels) level.checkSums(null);
    this.#kept =
      this.#dropping && columns.length > 0
        ? columns.map((column) => {
            const kept = new Float64Array(slots.length);
            kept.set(column);
            return kept;
          })
        : null;
    this.#members = null;
  }

  /**
   * What the bounds say to the groups once the rows the view shows from
   * position `from` on are added (every row, to no groups, with `fresh`)
   * after `removed` rows dropped: counted without changing anything, and
   * asked again as each new group or value is counted. Their refusal, or null.
   */
  #refusal(snapshot: RowSnapshot, from: number, fresh: boolean, removed: number): Error | null {
    const bounds = this.#bounds!;
    const source = this.#source;
    const length = source.length;
    const fields = this.#fields;
    // The room for each row's group the change would take (see `#compute` and `#reserve`).
    const capacity = this.#slots.length;
    const rows = fresh
      ? capacity >= length
        ? capacity
        : capacity === 0
          ? length
          : grown(length)
      : this.#offset + removed + length <= capacity || length * 1.5 <= capacity
        ? capacity
        : grown(length);
    const groups = this.#levels.map((level) => (fresh ? 0 : level.count));
    const values = fields.map((field) => (fresh ? 0 : field.ids.size));
    // A computation from scratch numbers groups afresh, giving back the levels' room (`forget`).
    const ask = () => bounds.check(groups, values, this.#bytesAt(rows, groups, fresh));
    let refusal = ask();
    // Values and groups new to each level, by key, with the numbers they would take.
    const newValues = fields.map(() => new Map<string | number | null, number>());
    const newGroups = fields.map(() => new Map<number, number>());
    // Keys as the fields' ids have them: labels, null for missing categories, NaN for missing numbers.
    const keys = fields.map((field): ((position: number) => string | number | null) => {
      if (field.kind !== "category") {
        const numbers = source.numbers(field.name);
        return (position) => numbers[position]!;
      }
      const { codes, dictionary } = source.categories(field.name);
      return (position) => (codes[position]! < 0 ? null : dictionary[codes[position]!]!);
    });
    const lookups = this.#lookups;
    const count = (position: number) => {
      let grew = false;
      let parent = -1;
      for (let depth = 0; depth < fields.length; depth++) {
        const key = keys[depth]!(position);
        let id = fresh ? undefined : fields[depth]!.ids.get(key);
        if (id === undefined) id = newValues[depth]!.get(key);
        if (id === undefined) {
          id = values[depth]!++;
          newValues[depth]!.set(key, id);
          grew = true;
        }
        // On the first level a value's id is its group.
        let group = id;
        if (depth > 0) {
          const combined = parent * RADIX + id;
          let found = fresh ? undefined : lookups[depth]!.get(combined);
          if (found === undefined) found = newGroups[depth]!.get(combined);
          if (found === undefined) {
            found = groups[depth]!++;
            newGroups[depth]!.set(combined, found);
            grew = true;
          }
          group = found;
        }
        parent = group;
      }
      groups[0] = values[0]!;
      if (grew) refusal = ask();
    };
    const { indices, length: shown } = snapshot;
    if (!indices) for (let p = from; p < length && !refusal; p++) count(p);
    else if (from === 0 || this.view.query.sort?.length) {
      for (let i = 0; i < shown && !refusal; i++) if (indices[i]! >= from) count(indices[i]!);
    } else {
      // Unsorted views keep table order: new rows are at the end.
      for (let i = shown - 1; i >= 0 && indices[i]! >= from && !refusal; i--) count(indices[i]!);
    }
    return refusal;
  }

  /** Takes away the table's first `removed` rows (as they were), which it dropped. */
  #remove(removed: number, end: number) {
    const start = this.#offset;
    const slots = this.#slots;
    this.#apply(start, start + removed, -1, this.#kept ?? [], 0);
    const members = this.#members;
    if (members) {
      if (!this.view.query.sort?.length) {
        // Rows in table order: a group's oldest rows lead its run.
        for (let index = start; index < start + removed; index++) {
          const group = slots[index]!;
          if (group >= 0) members.dropFirst(group, 1);
        }
      } else {
        const groups = new Set<number>();
        for (let index = start; index < start + removed; index++)
          if (slots[index]! >= 0) groups.add(slots[index]!);
        for (const group of groups) members.dropBefore(group, end);
      }
    }
    this.#offset += removed;
  }

  /** Groups the rows from position `from` on, all appended, and adds them to their groups. */
  #add(snapshot: RowSnapshot, from: number) {
    const source = this.#source;
    const length = source.length;
    this.#reserve(from, length);
    const offset = this.#offset;
    const slots = this.#slots;
    this.#mark(snapshot, from, length);
    const find = this.#finder();
    for (let position = from; position < length; position++)
      if (slots[offset + position] === -2) slots[offset + position] = find(position);
    const columns = this.#read.map((field) => source.numbers(field));
    this.#kept?.forEach((kept, i) => {
      kept.set(columns[i]!.subarray(from, length), offset + from);
    });
    this.#apply(offset + from, offset + length, 1, columns, offset);
    const members = this.#members;
    if (!members) return;
    const rowOffset = source.rowOffset;
    if (!members.fits(rowOffset + length)) {
      this.#members = null;
      return;
    }
    members.grow(this.#levels.at(-1)!.count);
    if (!this.view.query.sort?.length) {
      for (let position = from; position < length; position++) {
        const group = slots[offset + position]!;
        if (group >= 0) members.push(group, rowOffset + position);
      }
      return;
    }
    // Appended rows merge into each group's rows in the view's order.
    const compare = this.#comparator();
    const added = new Map<number, number[]>();
    for (let position = from; position < length; position++) {
      const group = slots[offset + position]!;
      if (group < 0) continue;
      const list = added.get(group);
      if (list) list.push(position);
      else added.set(group, [position]);
    }
    for (const [group, positions] of added) {
      positions.sort(compare);
      members.merge(
        group,
        positions.map((position) => rowOffset + position),
        compare,
        rowOffset,
      );
    }
  }

  /**
   * Adds (`sign` 1) or takes away (-1) the rows at window indices `from` to
   * `to` at every level, reading aggregated values at
   * `columns[field][index - offset]`.
   */
  #apply(
    from: number,
    to: number,
    sign: 1 | -1,
    columns: readonly ArrayLike<number>[],
    offset: number,
  ) {
    const levels = this.#levels;
    const slots = this.#slots;
    for (let index = from; index < to; index++) {
      let group = slots[index]!;
      for (let depth = levels.length - 1; depth >= 0 && group >= 0; depth--) {
        const level = levels[depth]!;
        if (level.change(group, sign, columns, index - offset) === 0) this.#emptied = true;
        group = level.parents[group]!;
      }
    }
  }

  /**
   * Computes again what taking rows away left stale: the minimums and
   * maximums that left, and sums that lost their accuracy (checked once a
   * batch is in, for the groups it changed). Last-level groups read their
   * rows; groups above add up the level below, and read their rows when
   * their groups' sums cancel beyond their accuracy.
   */
  #refresh() {
    const levels = this.#levels;
    for (const level of levels) level.checkSums(level.changed);
    const last = levels.at(-1)!;
    if (last.staleCount > 0) {
      for (let group = 0; group < last.count; group++)
        if (last.stale[group]) this.#reread(last, group);
      last.settle();
    }
    for (let depth = levels.length - 2; depth >= 0; depth--) {
      const level = levels[depth]!;
      if (level.staleCount === 0) continue;
      for (let group = 0; group < level.count; group++) if (level.stale[group]) level.empty(group);
      level.fold(levels[depth + 1]!, level.stale);
      level.resum(levels[depth + 1]!);
      for (const group of level.inexact()) this.#reread(level, group);
      level.settle();
    }
  }

  /** Computes a group's stale aggregates again from its rows, in table order. */
  #reread(level: GroupLevel, group: number) {
    const runs = this.#runs();
    const source = this.#source;
    const last = this.by.length - 1;
    const leaves: number[] = [];
    const visit = (g: number, d: number) => {
      if (d === last) leaves.push(g);
      else for (const child of this.childrenOf(g, d)) visit(child, d + 1);
    };
    visit(group, level.depth);
    const size = leaves.reduce((sum, leaf) => sum + runs.size(leaf), 0);
    if (this.#scratch.length < size) this.#scratch = new Uint32Array(grown(size));
    const rows = this.#scratch.subarray(0, size);
    let at = 0;
    for (const leaf of leaves) at += runs.copy(leaf, rows, at, source.rowOffset);
    // Rows of sorted views, and of several groups, go back to table order.
    if (leaves.length > 1 || this.view.query.sort?.length) rows.sort();
    level.recompute(
      group,
      rows,
      this.#read.map((field) => source.numbers(field)),
    );
  }

  /**
   * Drops groups left without rows, level by level from the first (a group's
   * groups below leave with it); the others keep their order. Returns the
   * levels whose groups were renumbered, whose tables start over.
   */
  #compact(): boolean[] {
    this.#emptied = false;
    this.#renumbered++;
    this.#children = null;
    const reset: boolean[] = [];
    // The renumbering of the level above, which its groups' parents follow.
    let above: Int32Array | null = null;
    for (const level of this.#levels) {
      const remap = new Int32Array(level.count);
      let kept = 0;
      for (let group = 0; group < level.count; group++)
        remap[group] = level.rows[group]! > 0 ? kept++ : -1;
      const lost = kept < level.count;
      level.renumber(lost ? remap : null, kept, above);
      reset.push(lost);
      above = lost ? remap : null;
    }
    // The last level's groups were renumbered: its rows' groups too.
    if (above) {
      const slots = this.#slots;
      const end = this.#offset + this.#source.length;
      for (let index = this.#offset; index < end; index++) {
        const group = slots[index]!;
        if (group >= 0) slots[index] = above[group]!;
      }
      this.#members?.renumber(above, this.#levels.at(-1)!.count);
    }
    // Ids of the surviving keys only, so values seen once do not stay forever.
    const fields = this.#fields;
    for (const field of fields) field.ids.clear();
    this.#forgetCodes();
    // Room of groups gone is given back once it is far more than those left need.
    for (const level of this.#levels) level.trim();
    this.#levels.forEach((level, depth) => {
      const field = fields[depth]!;
      const lookup = this.#lookups[depth]!;
      lookup.clear();
      for (let group = 0; group < level.count; group++) {
        const value = mapKey(field, level.values[group]!);
        if (depth === 0) {
          field.ids.set(value, group);
          continue;
        }
        let id = field.ids.get(value);
        if (id === undefined) {
          id = field.ids.size;
          field.ids.set(value, id);
        }
        lookup.set(level.parents[group]! * RADIX + id, group);
      }
    });
    return reset;
  }

  /** Marks the positions from `from` that the view shows -2 and the others -1. */
  #mark({ indices, length: shown }: RowSnapshot, from: number, length: number) {
    const slots = this.#slots;
    const offset = this.#offset;
    if (!indices) {
      slots.fill(-2, offset + from, offset + length);
      return;
    }
    slots.fill(-1, offset + from, offset + length);
    if (from === 0) {
      for (let i = 0; i < shown; i++) slots[offset + indices[i]!] = -2;
    } else if (!this.view.query.sort?.length) {
      // Unsorted views keep table order: new rows are at the end.
      for (let i = shown - 1; i >= 0 && indices[i]! >= from; i--) slots[offset + indices[i]!] = -2;
    } else {
      for (let i = 0; i < shown; i++) if (indices[i]! >= from) slots[offset + indices[i]!] = -2;
    }
  }

  /** Room for rows up to position `length`, the first `live` of which are kept. */
  #reserve(live: number, length: number) {
    const offset = this.#offset;
    const capacity = this.#slots.length;
    if (offset + length <= capacity) return;
    // Moving the rows to the front costs as much as the appends that filled the room since.
    const size = length * 1.5 <= capacity ? capacity : grown(length);
    const move = <A extends Int32Array | Float64Array>(array: A): A => {
      if (size === array.length) {
        array.copyWithin(0, offset, offset + live);
        return array;
      }
      const next = new (array.constructor as new (length: number) => A)(size);
      next.set(array.subarray(offset, offset + live));
      return next;
    };
    this.#slots = move(this.#slots);
    if (this.#kept) this.#kept = this.#kept.map(move);
    this.#offset = 0;
  }

  /** What finds the last-level group of a row, adding groups for keys that are new; it reads the table as it is now. */
  #finder(): (position: number) => number {
    const fields = this.#fields;
    const levels = this.#levels;
    const first = levels[0]!;
    const making = this.#making;
    const add = (value: string | number | null) => {
      if (making) this.#ask(({ groups, values }) => (groups[0] = values[0] = first.count + 1));
      return first.add(value, -1);
    };
    const ids = fields.map((field, depth) => this.#idReader(field, depth === 0 ? add : null));
    if (ids.length === 1) return ids[0]!;
    const lookups = this.#lookups;
    return (position) => {
      let group = ids[0]!(position);
      for (let depth = 1; depth < levels.length; depth++) {
        const combined = group * RADIX + ids[depth]!(position);
        const lookup = lookups[depth]!;
        let next = lookup.get(combined);
        if (next === undefined) {
          const level = levels[depth]!;
          if (depth < levels.length - 1 && level.count >= RADIX)
            throw new RangeError("Too many groups");
          if (making)
            this.#ask(({ groups, values }) => {
              groups[depth] = level.count + 1;
              values[depth] = fields[depth]!.ids.size;
            });
          next = level.add(this.#valueAt(fields[depth]!, position), group);
          lookup.set(combined, next);
        }
        group = next;
      }
      return group;
    };
  }

  /**
   * The id of a field's value in a row. With `add`, the id is a group of the
   * first level, added when the value is new.
   */
  #idReader(
    field: KeyField,
    add: ((value: string | number | null) => number) | null,
  ): (position: number) => number {
    const source = this.#source;
    const ids = field.ids;
    const next = (key: string | number | null, value: string | number | null) => {
      // Ids combine with groups: they must stay below RADIX.
      const id = add ? add(value) : ids.size;
      if (id >= RADIX) throw new RangeError(`Too many values of "${field.name}" to group by`);
      ids.set(key, id);
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
        if (code < 0) return ids.get(null) ?? next(null, null);
        let id = codeIds[code]!;
        if (id < 0) {
          const label = dictionary[code]!;
          id = ids.get(label) ?? next(label, label);
          codeIds[code] = id;
        }
        return id;
      };
    }
    const values = source.numbers(field.name);
    return (position) => {
      const value = values[position]!;
      // Maps take NaN as one key, so missing numbers share a group; -0 joins 0.
      return ids.get(value) ?? next(value, Number.isNaN(value) ? null : value === 0 ? 0 : value);
    };
  }

  /** While the groups are first made: asks the bounds about what `grow` makes them reach, throwing their refusal. */
  #ask(grow: (making: { rows: number; groups: number[]; values: number[] }) => void) {
    const making = this.#making!;
    grow(making);
    const bytes = this.#bytesAt(making.rows, making.groups);
    const refusal = this.#bounds!.check(making.groups, making.values, bytes);
    if (refusal) throw refusal;
  }

  /**
   * Bytes of the typed arrays the groups would hold with room for `rows`
   * table rows and `groups` groups per level (computed `fresh`, from no
   * groups, which gives back the levels' room and drops the lists made
   * from them): those they hold now, what growing to that takes (as
   * `#reserve`, `GroupLevel`, and `#idReader` grow), and the most that
   * reading them can still take: listing every group's rows (see
   * group-members.ts) in the view's order, the levels' children lists, and
   * room to read a group's rows again.
   */
  #bytesAt(rows: number, groups: readonly number[], fresh = false): number {
    let bytes = this.byteLength;
    const members = this.#members?.byteLength ?? 0;
    let children = 0;
    for (const list of this.#children?.lists ?? []) children += list.byteLength;
    for (const starts of this.#children?.starts ?? []) children += starts.byteLength;
    if (fresh) {
      for (const level of this.#levels) bytes -= level.byteLength;
      bytes -= members + children;
    }
    const read = this.#read.length;
    const kept = this.#dropping && read > 0;
    const capacity = this.#slots.length;
    if (rows > capacity) bytes += (rows - capacity) * (4 + (kept && this.#kept ? 8 * read : 0));
    if (kept && !this.#kept) bytes += Math.max(rows, capacity) * 8 * read;
    let total = 0;
    this.#levels.forEach((level, depth) => {
      const count = groups[depth]!;
      total += count;
      const room = fresh ? 0 : level.rows.length;
      if (count > room)
        bytes += (Math.max(64, Math.ceil(count * 1.5)) - room) * level.bytesPerGroup;
    });
    // Every group's rows listed (a computation from scratch lists them anew).
    const runs = fresh ? null : this.#members;
    bytes += MemberRuns.bytesAt(runs, rows, groups.at(-1)!) - (runs ? members : 0);
    bytes += Math.max(0, 4 * (total + this.#levels.length) - (fresh ? 0 : children));
    if (read > 0) bytes += Math.max(0, 4 * grown(rows) - this.#scratch.byteLength);
    // The view's order, made to list a sorted view's rows by group.
    bytes += Math.max(0, this.#rankBytes() - (this.#compare?.bytes ?? 0));
    return bytes + this.#lookupGrowth();
  }

  /** Bytes the category fields' code lookups take growing with their dictionaries: kept while the table and lookups stay. */
  #lookupGrowth(): number {
    const version = this.#source.version;
    let room = 0;
    for (const field of this.#fields) room += field.codeIds.length;
    const cached = this.#lookupCost;
    if (cached.version === version && cached.room === room) return cached.bytes;
    let bytes = 0;
    for (const field of this.#fields) {
      if (field.kind !== "category") continue;
      const { length } = this.#source.categories(field.name).dictionary;
      if (field.codeIds.length < length) bytes += 4 * grown(length) - field.codeIds.byteLength;
    }
    this.#lookupCost = { version, room, bytes };
    return bytes;
  }

  /**
   * Forgets the ids of category codes, which may have been renumbered; a
   * lookup larger than its dictionary now takes (one that shrank as rows
   * dropped, or after a reset) is given back, so lookups stay within room
   * for half again of their dictionaries.
   */
  #forgetCodes() {
    for (const field of this.#fields) {
      if (field.kind !== "category") continue;
      const needed = grown(this.#source.categories(field.name).dictionary.length);
      if (field.codeIds.length > needed) field.codeIds = new Int32Array(0);
      else field.codeIds.fill(-1);
    }
  }

  /** A field's value in a row, as keys hold it. */
  #valueAt(field: KeyField, position: number): string | number | null {
    if (field.kind === "category") {
      const { codes, dictionary } = this.#source.categories(field.name);
      const code = codes[position]!;
      return code < 0 ? null : dictionary[code]!;
    }
    const value = this.#source.numbers(field.name)[position]!;
    return Number.isNaN(value) ? null : value === 0 ? 0 : value;
  }

  /**
   * Each last-level group's rows, listed now unless they are current. A
   * listener of the groups' tables that changed their source reads the
   * groups as they were before that change: their rows still in the table,
   * in the view's order, listed for that reader only.
   */
  #runs(): MemberRuns {
    this.#update();
    const behind = this.#behind();
    if (this.#members && !behind) return this.#members;
    const source = this.#source;
    const seen = this.#seen;
    // Rows appended since have no group yet, and rows dropped since left the view; after a reset, none has.
    const shift = source.rowOffset - seen.rowOffset;
    const limit = !behind
      ? source.length
      : source.generation === seen.generation
        ? seen.length - shift
        : 0;
    // Frozen groups list their rows as they were, in table order, whatever the view shows now.
    const { indices, length } =
      this.#frozen && behind
        ? { indices: undefined, length: Math.max(0, limit) }
        : this.view.read();
    const runs = new MemberRuns(
      this.#levels.at(-1)!.count,
      indices,
      length,
      this.#slots,
      this.#offset + shift,
      limit,
      source.rowOffset,
    );
    if (!behind) this.#members = runs;
    return runs;
  }

  /** Whether a listener of the groups' tables changed their source or view, which they have yet to follow. */
  #behind(): boolean {
    return (
      this.#source.version !== this.#seen.version || this.view.queryRevision !== this.#seen.query
    );
  }

  /**
   * Where the groups keep the table's row at `position`, or -1 for a row
   * they have not seen. While they are behind their source (see `#runs`),
   * rows dropped since shift positions, rows appended since have no group,
   * none has after a reset, and rows the view no longer shows have none.
   */
  #indexAt(position: number): number {
    const source = this.#source;
    const seen = this.#seen;
    if (!this.#behind()) return this.#offset + position;
    if (source.generation !== seen.generation) return -1;
    if (!this.#frozen && this.view.indexOf(position) < 0) return -1;
    const at = position + source.rowOffset - seen.rowOffset;
    return at >= 0 && at < seen.length ? this.#offset + at : -1;
  }

  /** Each level's groups' children, made when groups were added or renumbered since. */
  #childLists() {
    const levels = this.#levels;
    let groups = 0;
    for (const level of levels) groups += level.count;
    const cached = this.#children;
    if (cached?.renumbered === this.#renumbered && cached.groups === groups) return cached;
    const starts: Int32Array[] = [];
    const lists: Int32Array[] = [];
    for (let depth = 0; depth < levels.length - 1; depth++) {
      const { count } = levels[depth]!;
      const child = levels[depth + 1]!;
      // A counting sort of the level below by parent keeps the order groups appeared in.
      const start = new Int32Array(count + 1);
      for (let c = 0; c < child.count; c++) start[child.parents[c]! + 1]!++;
      for (let group = 0; group < count; group++) start[group + 1]! += start[group]!;
      const list = new Int32Array(child.count);
      const next = start.slice(0, count);
      for (let c = 0; c < child.count; c++) list[next[child.parents[c]!]!++] = c;
      starts.push(start);
      lists.push(list);
    }
    this.#children = { renumbered: this.#renumbered, groups, starts, lists };
    return this.#children;
  }

  /** A level's groups `from` to `to` as columns: labels for category keys, numbers for the rest, tagged with their kinds for a new table. */
  #columns(level: GroupLevel, from: number, to: number, tagged: boolean) {
    const levels = this.#levels;
    const fields = this.#fields;
    const keys: ColumnInput[] = [];
    // Each group's ancestors, level by level up.
    const groups = new Int32Array(to - from);
    for (let i = 0; i < groups.length; i++) groups[i] = from + i;
    for (let depth = level.depth; depth >= 0; depth--) {
      const at = levels[depth]!;
      const { kind } = fields[depth]!;
      if (kind === "category") {
        const labels = Array.from(groups, (group) => at.values[group] as string | null);
        keys[depth] = tagged ? category(labels) : labels;
      } else {
        const values = Float64Array.from(
          groups,
          (group) => (at.values[group] as number | null) ?? Number.NaN,
        );
        keys[depth] = tagged && kind === "time" ? time(values) : values;
      }
      for (let i = 0; depth > 0 && i < groups.length; i++) groups[i] = at.parents[groups[i]!]!;
    }
    const columns: Record<string, ColumnInput> = Object.create(null);
    keys.forEach((column, depth) => {
      columns[fields[depth]!.name] = column;
    });
    level.aggregates.forEach(({ name }, k) => {
      const values = new Float64Array(to - from);
      for (let group = from; group < to; group++) values[group - from] = level.result(k, group);
      columns[name] = tagged && this.#times.has(name) ? time(values) : values;
    });
    return columns;
  }

  /** The view's order, for the table as it is now. */
  #comparator(): (a: number, b: number) => number {
    const source = this.#source;
    const query = this.view.queryRevision;
    const cached = this.#compare;
    if (cached?.version === source.version && cached.query === query) return cached.compare;
    const sort = this.view.query.sort ?? [];
    const compare = sort.length > 0 ? rowComparator(source, sort) : (a: number, b: number) => a - b;
    this.#compare = { version: source.version, query, compare, bytes: this.#rankBytes() };
    return compare;
  }

  /** Bytes the view's order holds ranking its category sort fields' labels (see `rowComparator`), as of the table's version and the view's query. */
  #rankBytes(): number {
    const [version, query] = [this.#source.version, this.view.queryRevision];
    const cached = this.#ranks;
    if (cached.version === version && cached.query === query) return cached.bytes;
    let bytes = 0;
    for (const { field } of this.view.query.sort ?? [])
      if (this.#source.kind(field) === "category")
        bytes += 4 * this.#source.categories(field).dictionary.length;
    this.#ranks = { version, query, bytes };
    return bytes;
  }
}

/**
 * Groups a row view's rows by the values of `by`, with aggregates of each
 * group in `groups.table`; with several fields, level by level, each level's
 * aggregates in `groups.tableOf(field)`. See `RowGroups`.
 *
 * ```ts
 * const byService = groupRows(rowView(requests), {
 *   by: ["region", "service"],
 *   ops: { requests: count(), latency: mean("latency") },
 * });
 * bar(byService.tableOf("region"), { x: "region", y: "requests" });
 * bar(byService.table, { x: "service", y: "latency", series: "region" });
 * ```
 */
export function groupRows<
  S extends Schema,
  const B extends readonly PositionField<S>[],
  O extends Record<string, GroupAggregate<NumericField<S>>> = Record<never, never>,
>(
  view: RowView<S>,
  options: GroupOptions<B[number], O> & { by: B },
): RowGroups<S, GroupSchema<S, B[number], O>, B> {
  return new RowGroups(
    view,
    options as unknown as GroupOptions<FieldName<S>, Record<string, GroupAggregate>>,
  );
}

/**
 * A string naming a group by its key: its values as JSON, with infinities
 * as text. Unique among one grouping's keys, whose values at each place are
 * all labels or all numbers, and whose lengths tell their levels.
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
