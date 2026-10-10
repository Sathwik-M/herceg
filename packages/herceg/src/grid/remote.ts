// A grid model over rows that live elsewhere (a `GridSource`: a database
// behind an API, a worker), imported with its DOM grid as
// `herceg/grid/remote`. It shares the columns, scrolling, and focus of every
// grid model (base.ts); its rows are blocks of a query's answer that it
// asks the source for as they come into view, keeping a few around them.
//
// The answer is a tree of sibling lists: the query's rows, or for a grouped
// query the first level's groups, each group expanded holding the list of
// its groups below or its rows. A list knows its length (or how far it has
// been read, while the source has not said), holds the blocks loaded of it,
// and the lists of its expanded groups by their place in it, with prefix
// sums of the rows those show, so a row index finds its list and place by
// binary search per level. Nothing is kept per row of the answer, and an
// unloaded run of a million groups is one range.
//
// Each query (or refresh) is a revision of the model: requests carry its
// number and, after the first answer, the snapshot that answer started.
// Answers to an earlier revision, to a request since replaced, or for a list
// since collapsed are dropped; requests nothing needs any more are aborted.

import { compileExpression, type Expression, type Fields } from "../data/expression.ts";
import { type GroupKey, groupId } from "../data/groups.ts";
import type { SortKey } from "../data/order.ts";
import type { PositionField, Schema } from "../data/table.ts";
import { numberFormatter } from "../format/format.ts";
import {
  BaseGridModel,
  type Column,
  cycled,
  type GridDisplay,
  type GridFocus,
  type GridRef,
  type GridSettings,
  nextOrder,
  type SelectionState,
  type SelectMode,
} from "./base.ts";
import { describeColumns, type GridColumn, type PlacedColumn, valueFormatter } from "./columns.ts";
import {
  expressionFields,
  type GridAggregate,
  type GridQuery,
  type GridQueryOf,
  type GridSchema,
  type RowKey,
  schemaFields,
  validateGridQuery,
} from "./query.ts";
import {
  type RemoteSelection,
  type RemoteSelectionStore,
  remoteSelectionStore,
  selectionHas,
} from "./remote-selection.ts";
import {
  checkWindow,
  decodeGroupPath,
  encodeGroupPath,
  type GridSource,
  GridSourceError,
  groupCondition,
  type LocateRequest,
  type LocateResult,
  type RowsRequest,
  type RowsWindow,
  valueAt,
  windowFields,
} from "./source.ts";

/** A query as `setQuery` takes it: its version and source may be left out. */
export type GridQueryInput<S extends Schema = Schema> = Omit<GridQueryOf<S>, "version" | "source"> &
  Partial<Pick<GridQuery, "version" | "source">>;

export interface RemoteGridModelOptions<S extends Schema = Schema> extends GridSettings {
  /** Where the rows are; the application owns it. */
  source: GridSource<S>;
  /** The query; every row in the source's order by default. */
  query?: GridQueryInput<S>;
  columns: readonly GridColumn<S>[];
  /** Where the selection goes; a store of the grid's own when left out. */
  selection?: RemoteSelectionStore;
  /** The store's channel for the selection; "grid-rows" by default. */
  channel?: string;
  /** Rows a block holds: what one request asks for. 128 by default. */
  blockSize?: number;
  /** Blocks kept besides those the view wants; 16 by default. */
  cachedBlocks?: number;
  /** Bytes of blocks kept besides those in view; 8 MiB by default. */
  cacheBytes?: number;
  /** Requests in flight at once; 2 by default. */
  maxRequests?: number;
  /** Groups expanded at once; 256 by default. */
  maxExpanded?: number;
  /**
   * Milliseconds a jump (a scrollbar dragged far) waits for the scrolling to
   * settle before asking for rows, and never more than three times as long
   * while it goes on; 50 by default, 0 to ask at once.
   */
  settle?: number;
}

/**
 * What a row of a remote grid shows: a record (with its key, when the source
 * names a key field), a group's header, or a placeholder for one still
 * loading or that failed to load.
 */
export type RemoteGridRow =
  | {
      readonly kind: "row";
      readonly ref: GridRef;
      readonly version: number;
      /** The record's key, or null when the source names no key field. */
      readonly key: RowKey | null;
      readonly level: number;
      /** Its place among its group's rows (or the grid's), and how many there are (-1: unknown). */
      readonly setIndex: number;
      readonly setSize: number;
    }
  | {
      readonly kind: "group";
      readonly ref: GridRef;
      readonly version: number;
      /** Its key path: its value of each grouping field down to its level's. */
      readonly key: GroupKey;
      readonly id: string;
      /** Rows the group holds, in its groups below too. */
      readonly rows: number;
      readonly expanded: boolean;
      readonly level: number;
      readonly setIndex: number;
      readonly setSize: number;
    }
  | {
      readonly kind: "placeholder";
      readonly ref: GridRef;
      readonly version: number;
      readonly state: "loading" | "failed";
      readonly level: number;
      readonly setIndex: number;
      readonly setSize: number;
      readonly indent: number;
    };

/** What a remote grid is doing. */
export interface RemoteGridStatus {
  /** Requests in flight. */
  readonly loading: number;
  /** Whether the grid waits for the first answer to its query. */
  readonly starting: boolean;
  /** Blocks that failed, shown as failed rows until `retry`. */
  readonly failed: number;
  /** The last failure, until `retry` or a new query. */
  readonly error: Error | null;
  /** Rows of the query (groups of its first level), or null while the source has not said. */
  readonly total: number | null;
  /** Blocks held, and their bytes. */
  readonly blocks: number;
  readonly bytes: number;
}

/** What the model said about a command it refused, counted so a renderer announces each once. */
export interface RemoteGridMessage {
  readonly text: string;
  readonly count: number;
}

/** One query's answer, as the model has read it. */
interface Revision {
  readonly number: number;
  readonly query: GridQuery;
  snapshot: string | null;
  /** The first request is in flight: the others wait for the snapshot it starts. */
  starting: boolean;
  /** The source no longer has the snapshot: only a refresh reads more. */
  expired: boolean;
  readonly lists: Map<string, List>;
  root: List;
}

/** A parent's rows or groups, as far as they are known. */
interface List {
  readonly revision: Revision;
  readonly parent: GroupKey;
  readonly id: string;
  readonly depth: number;
  /** Whether it holds rows (not groups). */
  readonly leaf: boolean;
  /** The group whose rows or groups these are: its list and place there. */
  readonly holder: { readonly list: List; readonly ordinal: number } | null;
  attached: boolean;
  total: number | null;
  /** How far it has been read while its total is not known. */
  frontier: number;
  /** Rows shown before anything is known: as many as the last query's. */
  provisional: number;
  readonly blocks: Map<number, Block>;
  /** Lists of its expanded groups, by their place. */
  children: List[];
  /** Each child's group row index within the list, and the rows the children up to it show. */
  heads: Float64Array;
  prefix: Float64Array;
  /** Rows the list shows, its children's too. */
  span: number;
}

/**
 * A block of a list: `blockSize` rows from `index × blockSize`, which one
 * request asks for and the source answers with a window of rows.
 */
interface Block {
  readonly list: List;
  readonly index: number;
  state: "loading" | "loaded" | "failed" | "aborted";
  controller: AbortController | null;
  data: RowsWindow | null;
  fields: Fields | null;
  /** Each record's place in the block, by key. */
  keys: Map<RowKey, number> | null;
  error: Error | null;
  version: number;
  used: number;
  bytes: number;
  /** The condition of the selection, compiled for the block. */
  test: { selection: RemoteSelection; at: (row: number) => boolean } | null;
}

type RemoteRef = GridRef & { readonly list: List; readonly ordinal: number };

/** A selection the model made of a group (or of every row), followed to show its groups selected. */
interface Scope {
  readonly selection: RemoteSelection;
  /** The group's key path; null for every row. */
  readonly path: GroupKey | null;
  /** The query's filter and grouping fields then, as JSON: the scope holds while they do. */
  readonly filter: string;
  readonly by: string;
}

const LOADING = "Loading…";
const FAILED = "Couldn't load rows";
/** A jump farther than this many blocks from the last rows wanted waits for scrolling to settle. */
const JUMP = 2;
/** Rows the DOM grid mounts past the view on each side (its overscan). */
const MOUNTED = 10;

/**
 * The state of one grid over a remote source. Reads are synchronous over
 * what is loaded; rows not loaded are placeholders, and the model asks for
 * them (and a block ahead of the view) as they come into view.
 */
export class RemoteGridModel<S extends Schema = Schema> extends BaseGridModel<S> {
  readonly source: GridSource<S>;
  readonly schema: GridSchema<S>;
  readonly selection: RemoteSelectionStore;
  readonly channel: string;
  readonly blockSize: number;
  readonly #limits: {
    blocks: number;
    bytes: number;
    requests: number;
    expanded: number;
    settle: number;
  };
  #revision: Revision;
  #revisions = 0;
  /** Ids of groups expanded, kept across queries grouped alike. */
  readonly #expanded = new Set<string>();
  /** Fields each row block holds, and the revision they are of: within one they only grow. */
  #fields: string[] = [];
  #fieldsOf = -1;
  /** Counts changes of what the rows show; the display is of `#seen`. */
  #arrangement = 0;
  #seen = { arrangement: -1, revision: -1 };
  #display: GridDisplay | undefined;
  #versions = 0;
  #ticks = 0;
  #loading = 0;
  #error: Error | null = null;
  #message: RemoteGridMessage | null = null;
  #planned = false;
  #disposed = false;
  /** The rows last wanted, for telling a jump from scrolling, and their blocks, which the cache keeps. */
  #wanted = { first: 0, last: 0, focus: -2, down: true };
  #working = new Set<string>();
  /** A jump waiting for scrolling to settle: when it began, its timer, and the first row in view. */
  #deferred: { since: number; timer: ReturnType<typeof setTimeout> | null; first: number } | null =
    null;
  /** A record the focus goes back to once the source locates it in a new query. */
  #restore: {
    key: RowKey;
    column: string;
    revision: Revision;
    controller: AbortController;
  } | null = null;
  #scope: Scope | null = null;
  /** The scope the selection being published is to have, taken when the store says it changed. */
  #pending: (Omit<Scope, "selection"> & { readonly version: number }) | null = null;
  /** Groups' selected and loaded records, counted per selection and state of the blocks. */
  #counted: {
    selection: RemoteSelection;
    arrangement: number;
    counts: Map<string, { selected: number; seen: number }>;
  } | null = null;
  #sets = new WeakMap<
    RemoteSelection,
    { keys: Set<RowKey>; include: Set<RowKey>; except: Set<RowKey> }
  >();
  #texts: {
    layout: readonly PlacedColumn[];
    query: GridQuery;
    write: ((block: Block, row: number, path: GroupKey) => string)[];
  } | null = null;
  readonly #stop: () => void;

  constructor(options: RemoteGridModelOptions<S>) {
    super(options);
    const { source } = options;
    this.source = source;
    this.schema = source.schema;
    const selection = options.selection ?? remoteSelectionStore(this.schema);
    if (selection.schema.source !== this.schema.source)
      throw new Error("A grid's selection store must be of its source");
    this.selection = selection;
    this.channel = options.channel ?? "grid-rows";
    const positive = (value: number | undefined, fallback: number, what: string) => {
      const n = value ?? fallback;
      if (!(Number.isInteger(n) && n > 0))
        throw new RangeError(`A remote grid's ${what} must be a positive integer, not ${n}`);
      return n;
    };
    this.blockSize = positive(options.blockSize, 128, "blockSize");
    this.#limits = {
      blocks: positive(options.cachedBlocks, 16, "cachedBlocks"),
      bytes: positive(options.cacheBytes, 8 * 2 ** 20, "cacheBytes"),
      requests: positive(options.maxRequests, 2, "maxRequests"),
      expanded: positive(options.maxExpanded, 256, "maxExpanded"),
      settle: options.settle ?? 50,
    };
    const settle = this.#limits.settle;
    if (!(Number.isFinite(settle) && settle >= 0))
      throw new RangeError(`A remote grid's settle must be 0 or more milliseconds, not ${settle}`);
    this.#revision = this.#start(this.#validate(options.query ?? {}), 0);
    this.setColumns(options.columns);
    // Rows wanted are asked for once whatever changed has settled. Bound, not
    // an arrow: an arrow's `this` would be shared with the store's listener
    // below, which must hold the model only weakly.
    this.subscribe(this.#schedule.bind(this));
    const ref = new WeakRef(this);
    const changed = () => {
      const model = ref.deref();
      if (model) model.#selectionChanged();
      else stop();
    };
    const stop = selection.subscribe(changed);
    this.#stop = stop;
    followers.register(this, stop, this);
    this.#schedule();
  }

  // Query

  /** The query the grid shows. */
  get query(): GridQueryOf<S> {
    return this.#revision.query as GridQueryOf<S>;
  }

  /**
   * Shows another query's rows: a new revision, whose requests start a new
   * snapshot. The scroll offset stays (as many rows show until the source
   * says how many there are); the focus goes to its column's header, and
   * back to its record when the source can locate it. Selections stay.
   */
  setQuery(query: GridQueryInput<S>): void {
    this.#replace(this.#validate(query));
  }

  /** Reads the query again from a new snapshot, for data that changed where it lives. */
  refresh(): void {
    this.#replace(this.#revision.query);
  }

  /** Asks again for the blocks that failed; after a snapshot expired, refreshes. */
  retry(): void {
    const revision = this.#revision;
    if (revision.expired || (revision.snapshot === null && !revision.starting)) {
      this.refresh();
      return;
    }
    for (const list of revision.lists.values())
      for (const [index, block] of list.blocks)
        if (block.state === "failed") list.blocks.delete(index);
    this.#error = null;
    this.#changed();
  }

  get status(): RemoteGridStatus {
    let failed = 0;
    let blocks = 0;
    let bytes = 0;
    for (const list of this.#revision.lists.values())
      for (const block of list.blocks.values()) {
        if (block.state === "failed") failed++;
        if (block.state === "loaded") {
          blocks++;
          bytes += block.bytes;
        }
      }
    const revision = this.#revision;
    return {
      loading: this.#loading,
      starting: revision.snapshot === null && !this.#error,
      failed,
      error: this.#error,
      total: revision.root.total,
      blocks,
      bytes,
    };
  }

  /** The rows the grid shows when every list's length is known (for assistive technology), else null. */
  get exactRowCount(): number | null {
    for (const list of this.#revision.lists.values()) if (list.total === null) return null;
    return this.rowCount;
  }

  /** What the model last said of a command it refused (a range over rows not loaded, too many groups expanded). */
  get message(): RemoteGridMessage | null {
    return this.#message;
  }

  // Columns

  setColumns(columns: readonly GridColumn<S>[]): void {
    const contents = describeColumns(
      schemaFields(this.schema),
      columns as readonly GridColumn[],
      this.settings,
    );
    // Blocks lacking a field a column shows go before the column does.
    this.#readFields(columns);
    this.takeColumns(
      columns.map((column) => ({ ...column, id: column.id ?? column.field })) as Column<S>[],
      contents,
    );
  }

  // Rows

  get grouped(): boolean {
    return this.#revision.query.group !== undefined;
  }

  row(rowIndex: number): RemoteGridRow {
    const { list, ordinal } = this.#at(rowIndex);
    const ref = refOf(list, ordinal);
    const block = list.blocks.get(Math.floor(ordinal / this.blockSize));
    const setSize = list.total ?? -1;
    const level = list.depth + 1;
    if (block?.state !== "loaded") {
      // Rows not asked for of an expired snapshot will not load either.
      const failed = block ? block.state === "failed" : list.revision.expired;
      return {
        kind: "placeholder",
        ref,
        version: failed ? -1 : 0,
        state: failed ? "failed" : "loading",
        level,
        setIndex: ordinal,
        setSize,
        indent: list.leaf ? list.depth - 1 : list.depth,
      };
    }
    block.used = ++this.#ticks;
    const row = ordinal - block.index * this.blockSize;
    if (list.leaf)
      return {
        kind: "row",
        ref,
        version: block.version,
        key: this.#keyOf(block, row),
        level,
        setIndex: ordinal,
        setSize,
      };
    const key = [...list.parent, groupValue(block, list.depth, row, this.#by())];
    const child = list.children.find(({ holder }) => holder!.ordinal === ordinal);
    return {
      kind: "group",
      ref,
      version: block.version,
      key,
      id: groupId(key),
      rows: (block.data as RowsWindow & { kind: "groups" }).rowCounts[row]!,
      expanded: child !== undefined,
      level,
      setIndex: ordinal,
      setSize,
    };
  }

  /** The key of the record at `rowIndex`, or null for groups, placeholders, and sources without keys. */
  keyAt(rowIndex: number): RowKey | null {
    const row = this.row(rowIndex);
    return row.kind === "row" ? row.key : null;
  }

  /** Where the record with this key shows among the rows loaded, or -1. */
  rowIndexOfKey(key: RowKey): number {
    this.current();
    for (const list of this.#revision.lists.values()) {
      if (!list.leaf) continue;
      for (const block of list.blocks.values()) {
        const at = block.keys?.get(key);
        if (at !== undefined) return this.#indexOf(list, block.index * this.blockSize + at);
      }
    }
    return -1;
  }

  textAt(rowIndex: number, columnIndex: number): string {
    const { list, ordinal } = this.#at(rowIndex);
    const layout = this.columnLayout as readonly PlacedColumn[];
    const column = layout[columnIndex];
    if (!column) throw new RangeError(`Column ${columnIndex} is not shown`);
    const block = list.blocks.get(Math.floor(ordinal / this.blockSize));
    if (block?.state !== "loaded") {
      const failed = block ? block.state === "failed" : list.revision.expired;
      return columnIndex > 0 ? "" : failed ? FAILED : LOADING;
    }
    const row = ordinal - block.index * this.blockSize;
    if (list.leaf) return column.content.text(block.fields!, row);
    return this.#groupTexts(layout)[columnIndex]!(block, row, list.parent);
  }

  // Sorting and groups

  get sort(): readonly SortKey<PositionField<S>>[] {
    return (this.#revision.query.sort ?? []) as readonly SortKey<PositionField<S>>[];
  }

  /** Sorts the rows by these keys (within their group, when grouped), keeping the filter and groups. */
  setSort(keys: readonly SortKey<PositionField<S>>[]): void {
    this.setQuery({ ...this.query, sort: keys });
  }

  /**
   * Sorts as a header click does (see `GridModel.cycleSort`): in grouped
   * grids the groups sort too, by the column's aggregate, or by key on the
   * level of the grouping field it shows. One query either way.
   */
  cycleSort(column: string, { additive = false }: { additive?: boolean } = {}): void {
    const definition = this.column(column);
    const field = definition.field as PositionField<S>;
    const keys = this.sort;
    const order = nextOrder(keys, field);
    const query = this.query;
    const group = query.group;
    let grouping = group;
    if (group) {
      const names = group.aggregate.map(({ as }) => as);
      const aggregate =
        definition.aggregate !== undefined && names.includes(definition.aggregate)
          ? definition.aggregate
          : undefined;
      const key =
        aggregate ?? ((group.by as readonly string[]).includes(field) ? field : undefined);
      grouping = { ...group, sort: cycled(group.sort ?? [], key, order, additive) };
    }
    this.setQuery({
      ...query,
      sort: cycled(keys, field, order, additive),
      ...(grouping && { group: grouping }),
    });
  }

  isExpanded(key: GroupKey): boolean {
    return this.#expanded.has(groupId(key));
  }

  /**
   * Shows or hides the groups below, or the rows, of the group with this key
   * path, kept for groups not loaded yet and across queries grouped alike.
   * Past `maxExpanded` groups expanded, refuses, saying so (`message`).
   */
  setExpanded(key: GroupKey, expanded: boolean): void {
    const id = groupId(key);
    if (this.#expanded.has(id) === expanded) return;
    const revision = this.#revision;
    if (expanded) {
      // Groups expanded before they load count too: each will ask for its rows.
      if (this.#expanded.size >= this.#limits.expanded) {
        this.#say(`At most ${this.#limits.expanded} groups can be expanded at once`);
        return;
      }
      this.#expanded.add(id);
      const parent = revision.lists.get(groupId(key.slice(0, -1)));
      if (parent && !parent.leaf) {
        const found = this.#findGroup(parent, id);
        if (found) this.#attach(parent, found.ordinal, key, found.children);
      }
    } else {
      this.#expanded.delete(id);
      const list = revision.lists.get(id);
      if (list) this.#detach(list);
    }
    this.#changed();
  }

  /** Collapses every group. */
  collapseAll(): void {
    this.#expanded.clear();
    for (const child of [...this.#revision.root.children]) this.#detach(child);
    this.#changed();
  }

  // Focus

  override focusCell(rowIndex: number, column: string, options?: { reveal?: boolean }): void {
    // Focus moved by the user stays where they put it.
    this.#forgetRestore();
    super.focusCell(rowIndex, column, options);
  }

  // Selection

  get selectionRevision(): number {
    return this.selection.revision;
  }

  /**
   * Rows selected: the keys selected, or null for a condition, which only
   * the source can count.
   */
  get selectedCount(): number | null {
    const selection = this.selection.get(this.channel);
    if (!selection) return 0;
    return selection.kind === "keys" ? selection.keys.length : null;
  }

  /**
   * Whether the row at `rowIndex` is selected: a loaded record by its key or
   * the selection's condition; a group's header as far as the grid knows
   * (see `#groupState`). Placeholders are not.
   */
  selectionState(rowIndex: number): SelectionState {
    const selection = this.selection.get(this.channel);
    if (!selection) return "none";
    const { list, ordinal } = this.#at(rowIndex);
    const block = list.blocks.get(Math.floor(ordinal / this.blockSize));
    if (block?.state !== "loaded") return "none";
    const row = ordinal - block.index * this.blockSize;
    if (list.leaf) return this.#selected(selection, block, row) ? "all" : "none";
    const path = [...list.parent, groupValue(block, list.depth, row, this.#by())];
    const rows = (block.data as RowsWindow & { kind: "groups" }).rowCounts[row]!;
    return this.#groupState(selection, path, rows);
  }

  /**
   * Selects as clicks do (see `SelectMode`), by key: a record (or with
   * Shift a range of records, every one between loaded, all within one
   * group), or a group's header, which selects the rows matching the group
   * (those the source adds to it later too). A selection the model cannot
   * make (rows not loaded, a source without keys) is refused, saying why.
   */
  select(rowIndex: number, mode: SelectMode = "only"): void {
    const { list, ordinal } = this.#at(rowIndex);
    const block = list.blocks.get(Math.floor(ordinal / this.blockSize));
    if (block?.state !== "loaded") {
      this.#say("Rows still loading cannot be selected");
      return;
    }
    const store = this.selection;
    const current = store.get(this.channel);
    const row = ordinal - block.index * this.blockSize;
    const ref = refOf(list, ordinal);
    if (!list.leaf) {
      if (mode === "range" || mode === "addRange") {
        this.#say("Ranges select rows of one group; select a group by itself");
        return;
      }
      const path = [...list.parent, groupValue(block, list.depth, row, this.#by())];
      const scope = this.#scopeNow();
      this.rangeAnchor = ref;
      // Toggling the group selected as a whole clears it; any other selects the group alone.
      const rows = (block.data as RowsWindow & { kind: "groups" }).rowCounts[row]!;
      if (
        mode === "toggle" &&
        current &&
        current === scope?.selection &&
        scope.path !== null &&
        groupId(scope.path) === groupId(path) &&
        this.#groupState(current, path, rows) === "all"
      ) {
        store.set(this.channel, null);
        return;
      }
      this.#selectMatching(path);
      return;
    }
    const key = this.#keyOf(block, row);
    if (key === null) {
      this.#say(`Rows of "${this.schema.source}" have no key and cannot be selected one by one`);
      return;
    }
    if (mode === "only" || mode === "toggle") {
      this.rangeAnchor = ref;
      if (mode === "only" || !current) this.#publish({ kind: "keys", keys: [key] });
      else if (current.kind === "keys") {
        const has = this.#setsOf(current).keys.has(key);
        const keys = has ? current.keys.filter((other) => other !== key) : [...current.keys, key];
        this.#publish({ kind: "keys", keys });
      } else {
        // A row the condition selects is taken out; one it does not, added (or taken out of `include`).
        const selected = this.#selected(current, block, row);
        const meets = this.#meets(current, block, row);
        const include = current.include.filter((other) => other !== key);
        const except = current.except.filter((other) => other !== key);
        if (selected && meets) except.push(key);
        else if (!selected && !meets) include.push(key);
        this.#publish({ ...current, include, except });
      }
      return;
    }
    const from = this.rangeAnchorIndex();
    if (from === null) {
      this.rangeAnchor = ref;
      this.#publish({ kind: "keys", keys: [key] });
      return;
    }
    const anchor = this.#at(from);
    if (anchor.list !== list) {
      this.#say("A range selects rows of one group");
      return;
    }
    const [start, end] =
      anchor.ordinal <= ordinal ? [anchor.ordinal, ordinal] : [ordinal, anchor.ordinal];
    const keys: RowKey[] = [];
    for (let at = start; at <= end; at++) {
      const w = list.blocks.get(Math.floor(at / this.blockSize));
      const k = w?.state === "loaded" ? this.#keyOf(w, at - w.index * this.blockSize) : null;
      if (k === null) {
        this.#say("A range selects only rows loaded; scroll through it first");
        return;
      }
      keys.push(k);
    }
    if (mode === "range" || !current) this.#publish({ kind: "keys", keys });
    else if (current.kind === "keys") {
      const known = this.#setsOf(current).keys;
      this.#publish({
        kind: "keys",
        keys: [...current.keys, ...keys.filter((k) => !known.has(k))],
      });
    } else {
      const added = new Set(keys);
      this.#publish({
        ...current,
        include: [...current.include.filter((k) => !added.has(k)), ...keys],
        except: current.except.filter((k) => !added.has(k)),
      });
    }
  }

  /** Selects every row matching the query's filter, those the source adds later too. */
  selectAll(): void {
    this.#selectMatching(null);
  }

  clearSelection(): boolean {
    const had = this.selection.get(this.channel) !== null || this.rangeAnchor !== null;
    this.rangeAnchor = null;
    if (this.selection.get(this.channel) !== null) this.selection.set(this.channel, null);
    return had;
  }

  /** Stops asking the source for rows, aborts requests in flight, and releases the snapshot. */
  override dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#forgetRestore();
    this.#stop();
    followers.unregister(this);
    this.#end(this.#revision);
    if (this.#deferred?.timer) clearTimeout(this.#deferred.timer);
    super.dispose();
  }

  // For the shared model (base.ts)

  protected catchUp(previous: GridDisplay | undefined): GridDisplay {
    const revision = this.#revision;
    const seen = this.#seen;
    if (previous && seen.arrangement === this.#arrangement && seen.revision === revision.number)
      return previous;
    const keep = seen.revision === revision.number;
    this.#seen = { arrangement: this.#arrangement, revision: revision.number };
    this.#display = { length: revision.root.span, keep };
    return this.#display;
  }

  protected refAt(rowIndex: number): GridRef {
    const { list, ordinal } = this.#at(rowIndex);
    return refOf(list, ordinal);
  }

  protected find(ref: GridRef, collapsed: boolean): number {
    let { list, ordinal } = ref as RemoteRef;
    if (!list || list.revision !== this.#revision) return -1;
    while (!list.attached) {
      if (!collapsed || !list.holder) return -1;
      ({ list, ordinal } = list.holder);
    }
    return ordinal < count(list, this.blockSize) ? this.#indexOf(list, ordinal) : -1;
  }

  protected override moveInTree(focus: GridFocus, left: boolean): boolean {
    if (!this.grouped) return false;
    const row = this.row(focus.rowIndex);
    if (row.kind === "group" && row.expanded === left) {
      this.setExpanded(row.key, !row.expanded);
      return true;
    }
    const { holder } = this.#at(focus.rowIndex).list;
    if (!left || !holder?.list.attached) return false;
    this.focusCell(this.#indexOf(holder.list, holder.ordinal), focus.column);
    return true;
  }

  // The answer's tree

  /** A new revision of the query, showing `provisional` rows until the source says. */
  #start(query: GridQuery, provisional: number): Revision {
    const revision: Revision = {
      number: ++this.#revisions,
      query,
      snapshot: null,
      starting: false,
      expired: false,
      lists: new Map(),
      root: undefined as unknown as List,
    };
    revision.root = this.#list(revision, [], null, null, provisional);
    return revision;
  }

  #list(
    revision: Revision,
    parent: GroupKey,
    holder: List["holder"],
    total: number | null,
    provisional = 0,
  ): List {
    const depth = parent.length;
    const list: List = {
      revision,
      // A copy: a key path the caller changes later must not move the list.
      parent: Object.freeze([...parent]),
      id: groupId(parent),
      depth,
      leaf: depth === (revision.query.group?.by.length ?? 0),
      holder,
      attached: true,
      total,
      frontier: 0,
      provisional,
      blocks: new Map(),
      children: [],
      heads: new Float64Array(0),
      prefix: new Float64Array(0),
      span: 0,
    };
    list.span = count(list, this.blockSize);
    revision.lists.set(list.id, list);
    return list;
  }

  /** Shows the list of an expanded group at `ordinal` of `list`. */
  #attach(list: List, ordinal: number, key: GroupKey, total: number | null): List {
    // A group shown at another place (a source whose places moved) leaves it.
    const elsewhere = list.revision.lists.get(groupId(key));
    if (
      elsewhere?.holder &&
      (elsewhere.holder.list !== list || elsewhere.holder.ordinal !== ordinal)
    )
      this.#detach(elsewhere);
    let existing = list.children.find(({ holder }) => holder!.ordinal === ordinal);
    // Another group's list at that place is of where it was.
    if (existing && existing.id !== groupId(key)) {
      this.#detach(existing);
      existing = undefined;
    }
    if (existing) {
      if (existing.total === null && total !== null) {
        existing.total = total;
        this.#recount(existing);
      }
      return existing;
    }
    const child = this.#list(list.revision, key, { list, ordinal }, total);
    const children = [...list.children, child].sort(
      (a, b) => a.holder!.ordinal - b.holder!.ordinal,
    );
    list.children = children;
    this.#recount(list);
    return child;
  }

  /** Stops showing a list and those below it, aborting their requests. */
  #detach(list: List) {
    this.#drop(list);
    const holder = list.holder;
    if (holder?.list.attached) {
      holder.list.children = holder.list.children.filter((child) => child !== list);
      this.#recount(holder.list);
    }
  }

  /** Forgets a list and those below it. */
  #drop(list: List) {
    for (const child of list.children) this.#drop(child);
    for (const block of [...list.blocks.values()]) this.#abort(block);
    list.blocks.clear();
    list.attached = false;
    list.revision.lists.delete(list.id);
  }

  /** Counts the rows a list shows again, and those of the lists above it. */
  #recount(list: List) {
    for (let at: List | undefined = list; at; at = at.holder?.list) {
      const n = count(at, this.blockSize);
      // Groups past the end (a total smaller than thought) are not shown.
      const gone = at.children.filter(({ holder }) => holder!.ordinal >= n);
      for (const child of gone) this.#drop(child);
      if (gone.length > 0) at.children = at.children.filter((child) => child.attached);
      const heads = new Float64Array(at.children.length);
      const prefix = new Float64Array(at.children.length);
      let shown = 0;
      at.children.forEach((child, i) => {
        heads[i] = child.holder!.ordinal + shown;
        shown += child.span;
        prefix[i] = shown;
      });
      at.heads = heads;
      at.prefix = prefix;
      at.span = n + shown;
      if (!at.attached) break;
    }
  }

  /** The list and place of the row at `rowIndex`. */
  #at(rowIndex: number): { list: List; ordinal: number } {
    const length = this.current().length;
    if (!(Number.isInteger(rowIndex) && rowIndex >= 0 && rowIndex < length))
      throw new RangeError(`Row ${rowIndex} is not among the grid's ${length} rows`);
    let list = this.#revision.root;
    let x = rowIndex;
    for (;;) {
      const { heads, prefix, children } = list;
      // The last child whose group row is before x.
      let [lo, hi] = [0, heads.length];
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (heads[mid]! < x) lo = mid + 1;
        else hi = mid;
      }
      const i = lo - 1;
      if (i >= 0 && x <= heads[i]! + children[i]!.span) {
        x -= heads[i]! + 1;
        list = children[i]!;
        continue;
      }
      return { list, ordinal: x - (i >= 0 ? prefix[i]! : 0) };
    }
  }

  /** The row index of place `ordinal` of an attached list. */
  #indexOf(list: List, ordinal: number): number {
    let index = 0;
    for (let at: List | null = list, place = ordinal; at; ) {
      const { children, prefix } = at;
      // Children whose groups come before the place.
      let [lo, hi] = [0, children.length];
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (children[mid]!.holder!.ordinal < place) lo = mid + 1;
        else hi = mid;
      }
      index += place + (lo > 0 ? prefix[lo - 1]! : 0);
      const holder: List["holder"] = at.holder;
      if (!holder) break;
      index += 1;
      at = holder.list;
      place = holder.ordinal;
    }
    return index;
  }

  /** A loaded group of a list by id: its place and how many children it has. */
  #findGroup(list: List, id: string): { ordinal: number; children: number } | null {
    const by = this.#by();
    for (const block of list.blocks.values()) {
      if (block.state !== "loaded") continue;
      const data = block.data as RowsWindow & { kind: "groups" };
      for (let row = 0; row < data.length; row++)
        if (groupId([...list.parent, groupValue(block, list.depth, row, by)]) === id)
          return {
            ordinal: block.index * this.blockSize + row,
            children: data.childCounts[row]!,
          };
    }
    return null;
  }

  // Requests

  #validate(input: GridQueryInput<S>): GridQuery {
    return validateGridQuery(
      { ...input, version: input.version ?? 1, source: input.source ?? this.schema.source },
      this.schema,
    );
  }

  /** Shows a new revision of `query`, keeping the scroll offset and the focus's record. */
  #replace(query: GridQuery) {
    const old = this.#revision;
    const focus = this.focus;
    let restore: { key: RowKey; column: string } | null = null;
    if (focus && focus.rowIndex >= 0) {
      const key = this.keyAt(focus.rowIndex);
      if (key !== null) restore = { key, column: focus.column };
    } else if (focus && this.#restore?.column === focus.column)
      // Queries one after another before the record was located: it is still to go back to.
      restore = { key: this.#restore.key, column: focus.column };
    this.#forgetRestore();
    // A new query is asked for at once, not after a jump that was settling.
    if (this.#deferred?.timer) clearTimeout(this.#deferred.timer);
    this.#deferred = null;
    this.#wanted = { ...this.#wanted, first: -1 };
    const regrouped = JSON.stringify(old.query.group?.by) !== JSON.stringify(query.group?.by);
    if (regrouped) this.#expanded.clear();
    // As many rows as the last query showed, until the source says; none of another grouping's.
    const shown = regrouped ? 0 : (old.root.total ?? count(old.root, this.blockSize));
    const revision = this.#start(query, shown);
    this.#revision = revision;
    this.#restore =
      restore && this.source.locate
        ? { ...restore, revision, controller: new AbortController() }
        : null;
    this.rangeAnchor = null;
    this.#error = null;
    this.#texts = null;
    this.#readFields();
    this.#arrangement++;
    // The old query's requests are aborted and its snapshot released once the
    // new one is in place: the source's hooks may start another, which then
    // tells listeners itself.
    this.#end(old);
    if (this.#revision !== revision) return;
    // Listeners hear of it once, all of it in place: the focus waits on the
    // header, its row not known in the new query.
    if (focus && focus.rowIndex >= 0) super.focusCell(-1, focus.column, { reveal: false });
    else this.notify();
  }

  /** Aborts a revision's requests and releases its snapshot. */
  #end(revision: Revision) {
    for (const list of [...revision.lists.values()])
      for (const block of [...list.blocks.values()]) this.#abort(block);
    const { snapshot } = revision;
    if (snapshot !== null) later(() => this.source.release?.(snapshot));
  }

  #abort(block: Block) {
    if (block.state !== "loading") return;
    // Everything kept in order first: the source's abort listeners run
    // synchronously, and may do anything (a new query, another abort).
    const controller = block.controller;
    block.state = "aborted";
    block.controller = null;
    if (block.list.blocks.get(block.index) === block) block.list.blocks.delete(block.index);
    this.#loading--;
    // The request that was to start the snapshot: the next one starts it.
    const revision = block.list.revision;
    if (revision.snapshot === null) revision.starting = false;
    if (controller) later(() => controller.abort());
  }

  /** The fields row blocks hold: the columns', the key, the grouping fields, and the filter's. */
  #readFields(columns: readonly GridColumn<S>[] = this.columnList) {
    const { query } = this.#revision;
    const fields = new Set<string>(columns.map(({ field }) => field));
    if (this.schema.key !== null) fields.add(this.schema.key);
    for (const field of query.group?.by ?? []) fields.add(field);
    for (const field of expressionFields(query.filter)) fields.add(field);
    const selection = this.selection.get(this.channel);
    if (selection?.kind === "matching")
      for (const field of expressionFields(selection.where))
        if (Object.hasOwn(this.schema.fields, field)) fields.add(field);
    // Blocks of the query keep the fields they have: a selection or column
    // coming and going does not read them again.
    if (this.#fieldsOf === this.#revision.number)
      for (const field of this.#fields) fields.add(field);
    this.#fieldsOf = this.#revision.number;
    const next = [...fields].sort();
    if (next.join("\u0000") === this.#fields.join("\u0000")) return;
    const fresh = next.some((field) => !this.#fields.includes(field));
    this.#fields = next;
    if (!fresh) return;
    // Blocks read before lack the new fields.
    for (const list of this.#revision.lists.values()) {
      if (!list.leaf) continue;
      for (const block of [...list.blocks.values()]) {
        this.#abort(block);
        list.blocks.delete(block.index);
      }
    }
    // The caller tells listeners, once what it changed is all in place.
    this.#arrangement++;
  }

  #schedule() {
    if (this.#planned || this.#disposed) return;
    this.#planned = true;
    queueMicrotask(() => {
      this.#planned = false;
      this.#plan();
    });
  }

  /**
   * Asks for the blocks the view needs: those in view, the focused row's,
   * then a block ahead, in the direction of scrolling.
   * Requests for blocks more than two blocks from the view are aborted.
   * After a jump (a scrollbar dragged far), requests wait for the scrolling
   * to settle for `settle` ms, but never longer than three times that while it
   * goes on; moves of the focus (the keyboard) do not wait.
   */
  #plan() {
    if (this.#disposed) return;
    const revision = this.#revision;
    const length = this.current().length;
    const size = this.blockSize;
    const height = this.rowHeight;
    const top = this.top;
    const first = Math.min(Math.floor(top / height), Math.max(0, length - 1));
    const last = Math.min(
      length,
      Math.max(first + 1, Math.ceil((top + this.viewportHeight) / height)),
    );
    const focus = this.focus?.rowIndex ?? -1;
    /** Adds the blocks of rows `[from, to)`, in order. */
    const add = (into: Map<string, { list: List; index: number }>, from: number, to: number) => {
      for (let x = Math.max(0, from); x < Math.min(to, length); x++) {
        const { list, ordinal } = this.#at(x);
        const index = Math.floor(ordinal / size);
        const key = `${list.id}\u0000${index}`;
        if (!into.has(key)) into.set(key, { list, index });
      }
    };
    const wanted = new Map<string, { list: List; index: number }>();
    add(wanted, first, last);
    if (focus >= 0) add(wanted, focus, focus + 1);
    // A block ahead, in the direction of scrolling (rows behind were just
    // shown), which holds until the rows in view move; after a jump, below.
    const previous = this.#wanted;
    // A new query has no rows wanted before to have jumped from.
    const far =
      previous.first >= 0 &&
      (first >= previous.last + JUMP * size || last <= previous.first - JUMP * size);
    let down = previous.down;
    if (far) down = true;
    else if (first !== previous.first) down = first > previous.first;
    if (down) add(wanted, last, last + size);
    else add(wanted, first - size, first);
    // Requests a little past those wanted go on, so scrolling back and forth reuses them.
    const kept = new Map(wanted);
    add(kept, first - 2 * size, last + 2 * size);
    for (const list of revision.lists.values())
      for (const block of [...list.blocks.values()])
        if (block.state === "loading" && !kept.has(`${list.id}\u0000${block.index}`))
          this.#abort(block);
    this.#wanted = { first, last, focus, down };
    // The cache keeps those, and the blocks of rows the DOM grid mounts
    // around the view (ten more on each side).
    const working = new Map(wanted);
    add(working, first - MOUNTED, last + MOUNTED);
    this.#working = new Set(working.keys());
    // A view grown smaller wants fewer blocks: the cache keeps no more than its
    // limits. Blocks dropped are none the grid has mounted (see `#working`),
    // but groups count the records loaded: listeners hear of it, last.
    const evicted = this.#evict();
    try {
      if (this.#defer(far, first, focus !== previous.focus)) return;
      if (revision.expired || revision.starting) return;
      for (const { list, index } of wanted.values()) {
        if (this.#loading >= this.#limits.requests) break;
        if (list.blocks.has(index)) continue;
        // Past a known end there is nothing to ask for.
        if (list.total !== null && index * size >= list.total) continue;
        this.#request(list, index);
        // The first answer starts the snapshot the others are read from.
        if (revision.snapshot === null) break;
      }
    } finally {
      if (evicted) this.#changed();
    }
  }

  /**
   * Whether requests wait for scrolling to settle: from a jump (`far`) until
   * the rows in view have stayed `settle` ms (other changes meanwhile, an
   * answer or a resize, do not restart the wait), but no longer than three
   * times that from the jump, and never past a move of the focus.
   */
  #defer(far: boolean, first: number, focused: boolean): boolean {
    const { settle } = this.#limits;
    const deferred = this.#deferred;
    const now = Date.now();
    // Each wait ends by the deadline, three times `settle` from the jump.
    const wait = () => {
      const pending = this.#deferred!;
      if (pending.timer) clearTimeout(pending.timer);
      pending.timer = setTimeout(
        () => {
          if (this.#deferred) this.#deferred.timer = null;
          this.#plan();
        },
        Math.max(0, Math.min(settle, pending.since + 3 * settle - Date.now())),
      );
    };
    if (deferred && !focused && now - deferred.since < 3 * settle) {
      // Still scrolling: wait again. The wait over, or another change: go on waiting or ask.
      if (first !== deferred.first) {
        deferred.first = first;
        wait();
        return true;
      }
      if (deferred.timer) return true;
    }
    if (deferred) {
      if (deferred.timer) clearTimeout(deferred.timer);
      this.#deferred = null;
      return false;
    }
    if (!far || focused || settle === 0) return false;
    this.#deferred = { since: now, timer: null, first };
    wait();
    return true;
  }

  #request(list: List, index: number) {
    const revision = list.revision;
    // A plan a hook interrupted may go on over a query since replaced.
    if (revision !== this.#revision || !list.attached || this.#disposed) return;
    const controller = new AbortController();
    const block: Block = {
      list,
      index,
      state: "loading",
      controller,
      data: null,
      fields: null,
      keys: null,
      error: null,
      version: 0,
      used: ++this.#ticks,
      bytes: 0,
      test: null,
    };
    list.blocks.set(index, block);
    this.#loading++;
    if (revision.snapshot === null) revision.starting = true;
    const request: RowsRequest = {
      query: revision.query,
      revision: revision.number,
      schemaVersion: this.schema.version,
      snapshot: revision.snapshot,
      parent: encodeGroupPath(list.parent),
      offset: index * this.blockSize,
      limit: this.blockSize,
      fields: list.leaf ? this.#fields : [],
    };
    Promise.resolve()
      .then(() => this.source.rows(request, controller.signal))
      .then(
        (data) => this.#arrived(block, request, data),
        (error) => this.#failed(block, error),
      );
  }

  /** Whether an answer is still wanted: its block is the one asked for, of a list still shown. */
  #current(block: Block): boolean {
    const { list } = block;
    return (
      !this.#disposed &&
      list.revision === this.#revision &&
      list.attached &&
      list.blocks.get(block.index) === block &&
      block.state === "loading"
    );
  }

  #arrived(block: Block, request: RowsRequest, data: RowsWindow) {
    // A first answer started a snapshot of its own, which the grid releases
    // once it reads none of it: dropped, or refused below.
    const unread = () => {
      const snapshot = (data as { snapshot?: unknown } | null)?.snapshot;
      if (request.snapshot === null && typeof snapshot === "string")
        later(() => this.source.release?.(snapshot));
    };
    if (!this.#current(block)) {
      unread();
      return;
    }
    const { list } = block;
    const revision = list.revision;
    let held: {
      data: RowsWindow;
      keys: Map<RowKey, number> | null;
      fields: Fields;
      bytes: number;
    };
    // Everything that can throw on a bad answer happens before the block changes.
    try {
      const kinds = this.#kinds(list);
      const keys = checkWindow(data, request, list.leaf ? "rows" : "groups", kinds, {
        key: list.leaf ? this.schema.key : null,
        ...(!list.leaf && { group: this.#by()[list.depth]! }),
      });
      if (data.total !== null && list.total !== null && data.total !== list.total)
        throw new GridSourceError("invalid-response", "The answer changed its list's total");
      // Only the fields asked for are kept, in arrays of the block's own.
      const own = ownColumns(data, kinds);
      held = { data: own, keys, fields: windowFields(kinds, own.columns), bytes: bytesOf(own) };
    } catch (error) {
      unread();
      this.#failed(block, error);
      return;
    }
    this.#loading--;
    block.controller = null;
    if (revision.snapshot === null) {
      revision.snapshot = data.snapshot;
      revision.starting = false;
      this.#locate();
    }
    if (data.total !== null) list.total = data.total;
    list.frontier = Math.max(list.frontier, data.offset + data.length);
    if (data.length === 0) {
      // Past the end: the list is shorter than shown.
      list.blocks.delete(block.index);
      this.#recount(list);
      this.#changed();
      return;
    }
    block.data = held.data;
    block.keys = held.keys;
    block.fields = held.fields;
    block.bytes = held.bytes;
    block.version = ++this.#versions;
    block.state = "loaded";
    if (!list.leaf && held.data.kind === "groups") {
      // Groups expanded before they were loaded show their rows now.
      const by = this.#by();
      const counts = held.data.childCounts;
      for (let row = 0; row < held.data.length; row++) {
        const key = [...list.parent, groupValue(block, list.depth, row, by)];
        if (this.#expanded.has(groupId(key)))
          this.#attach(list, data.offset + row, key, counts[row]!);
      }
    }
    this.#recount(list);
    this.#evict();
    this.#changed();
  }

  #failed(block: Block, error: unknown) {
    if (!this.#current(block)) return;
    const { list } = block;
    const revision = list.revision;
    this.#loading--;
    block.controller = null;
    block.state = "failed";
    const failure =
      error instanceof GridSourceError
        ? error
        : new GridSourceError(
            "unavailable",
            error instanceof Error ? error.message : `The source failed: ${String(error)}`,
          );
    block.error = failure;
    this.#error = failure;
    if (failure.code === "snapshot-expired") revision.expired = true;
    if (revision.snapshot === null) revision.starting = false;
    // Failed blocks count against the cache too.
    this.#evict();
    this.#changed();
  }

  /** Asks the source where the focused record went in the new query. */
  #locate() {
    const restore = this.#restore;
    const revision = this.#revision;
    const locate = this.source.locate;
    if (!restore || restore.revision !== revision || !locate || revision.snapshot === null) return;
    const snapshot = revision.snapshot;
    const request: LocateRequest = {
      query: revision.query,
      revision: revision.number,
      schemaVersion: this.schema.version,
      snapshot,
      key: restore.key,
    };
    Promise.resolve()
      .then(() => locate.call(this.source, request, restore.controller.signal))
      .then(
        (result) => {
          if (this.#restore !== restore || this.#disposed) return;
          this.#restore = null;
          if (result?.revision !== revision.number || result.snapshot !== snapshot) return;
          // A result that does not hold together is not followed.
          try {
            if (result.address) this.#focusAt(result, restore.column, restore.key);
          } catch {}
        },
        () => {
          if (this.#restore === restore) this.#restore = null;
        },
      );
  }

  /** Stops waiting to put the focus back on a record. */
  #forgetRestore() {
    const controller = this.#restore?.controller;
    if (controller) later(() => controller.abort());
    this.#restore = null;
  }

  /** Focuses a located record (`record` its key), or the first collapsed group on its way. */
  #focusAt({ address, ancestors }: LocateResult, column: string, record: RowKey) {
    const revision = this.#revision;
    let path: GroupKey;
    try {
      path = decodeGroupPath(address!.parent);
    } catch {
      return;
    }
    // A place the query does not have is not followed.
    const whole = (n: unknown) => Number.isInteger(n) && (n as number) >= 0;
    if (!Array.isArray(ancestors) || path.length !== this.#by().length) return;
    if (!whole(address!.offset)) return;
    if (path.some((_, depth) => !whole(ancestors[depth]?.offset))) return;
    // Checked through the lists shown before anything changes: a place past
    // a known end, or a group there other than the record's, is not followed.
    const fits = (at: List | null, ordinal: number) => at?.total == null || ordinal < at.total;
    let shown: List | null = revision.root;
    let stop = path.length;
    for (let depth = 0; depth < path.length; depth++) {
      const offset = ancestors[depth]!.offset;
      if (!fits(shown, offset)) return;
      const key = path.slice(0, depth + 1);
      // A group loaded at that place must be the record's.
      const block = shown?.blocks.get(Math.floor(offset / this.blockSize));
      if (block?.state === "loaded") {
        const row = offset - block.index * this.blockSize;
        if (groupId([...shown!.parent, groupValue(block, depth, row, this.#by())]) !== groupId(key))
          return;
      }
      if (!this.#expanded.has(groupId(key))) {
        stop = depth;
        break;
      }
      const child: List | undefined = shown?.children.find(
        ({ holder }) => holder!.ordinal === offset,
      );
      if (child && child.id !== groupId(key)) return;
      // Nor where the group is shown elsewhere already.
      const elsewhere = revision.lists.get(groupId(key));
      if (elsewhere && elsewhere !== child) return;
      shown = child ?? null;
    }
    if (stop === path.length) {
      if (!fits(shown, address!.offset)) return;
      // A record loaded at that place must be the one located.
      const block = shown?.blocks.get(Math.floor(address!.offset / this.blockSize));
      if (
        block?.state === "loaded" &&
        this.#keyOf(block, address!.offset - block.index * this.blockSize) !== record
      )
        return;
    }
    // Lists whose lengths the source has not said yet show at least as far as the record.
    const reach = (at: List, ordinal: number) => {
      at.provisional = Math.max(at.provisional, ordinal + 1);
      this.#recount(at);
    };
    let list = revision.root;
    let target: { list: List; ordinal: number } | null = null;
    for (let depth = 0; depth < path.length; depth++) {
      const offset = ancestors[depth]!.offset;
      reach(list, offset);
      if (depth === stop) {
        target = { list, ordinal: offset };
        break;
      }
      list = this.#attach(list, offset, path.slice(0, depth + 1), null);
    }
    target ??= { list, ordinal: address!.offset };
    reach(target.list, target.ordinal);
    // Listeners hear of it once, with the focus in place.
    this.#arrangement++;
    const index = this.#indexOf(target.list, target.ordinal);
    if (index < this.rowCount && this.columnIndex(column) >= 0)
      super.focusCell(index, column, { reveal: false });
    else this.notify();
  }

  /**
   * Drops blocks past the cache's limits, farthest from the view first:
   * those the view wants (in view, the focused row's, and those around)
   * stay, so a cache smaller than them never asks for a block again and
   * again.
   */
  /** Whether it dropped any. */
  #evict(): boolean {
    const limits = this.#limits;
    const { first, last } = this.#wanted;
    const working = this.#working;
    const size = this.blockSize;
    // The cache's limits are of the blocks besides those the view wants.
    // Dropping any changes the records loaded, which groups' counts are of.
    const kept: { block: Block; distance: number }[] = [];
    let bytes = 0;
    for (const list of this.#revision.lists.values())
      for (const block of list.blocks.values()) {
        if (block.state === "loading" || working.has(`${list.id}\u0000${block.index}`)) continue;
        const start = this.#indexOf(list, block.index * size);
        const distance = start >= last ? start - last : Math.max(0, first - start - size);
        kept.push({ block, distance });
        bytes += block.bytes;
      }
    if (kept.length <= limits.blocks && bytes <= limits.bytes) return false;
    kept.sort((a, b) => b.distance - a.distance || a.block.used - b.block.used);
    this.#counted = null;
    let held = kept.length;
    for (const { block } of kept) {
      if (held <= limits.blocks && bytes <= limits.bytes) break;
      block.list.blocks.delete(block.index);
      held--;
      bytes -= block.bytes;
    }
    return true;
  }

  #changed() {
    this.#arrangement++;
    this.notify();
  }

  #say(text: string) {
    this.#message = { text, count: (this.#message?.count ?? 0) + 1 };
    this.notify();
  }

  // Reading blocks

  #by(): readonly string[] {
    return this.#revision.query.group?.by ?? [];
  }

  /** Fields a list's blocks hold, and their kinds. */
  #kinds(list: List): Record<string, string> {
    const fields = this.schema.fields as Record<string, string>;
    // Without a prototype: a field may be named "__proto__".
    const kinds: Record<string, string> = Object.create(null);
    if (list.leaf) {
      for (const field of this.#fields) kinds[field] = fields[field]!;
      return kinds;
    }
    const group = this.#revision.query.group!;
    for (const field of group.by.slice(0, list.depth + 1)) kinds[field] = fields[field]!;
    for (const aggregate of group.aggregate) kinds[aggregate.as] = aggregateKind(aggregate, fields);
    return kinds;
  }

  #keyOf(block: Block, row: number): RowKey | null {
    const key = this.schema.key;
    if (key === null) return null;
    return valueAt(block.data!, key, row);
  }

  /** What each column says on a group's header: as a local grid's groups do (grid/grouped.ts). */
  #groupTexts(
    layout: readonly PlacedColumn[],
  ): ((block: Block, row: number, parent: GroupKey) => string)[] {
    const query = this.#revision.query;
    const cached = this.#texts;
    if (cached?.layout === layout && cached.query === query) return cached.write;
    const settings = this.settings;
    const group = query.group!;
    const by = group.by;
    const fields = this.schema.fields as Record<string, "number" | "time" | "category">;
    const formats = by.map(
      (field) =>
        layout.find((column) => column.field === field)?.content.format ??
        valueFormatter(fields[field]!, undefined, settings),
    );
    const missing = settings.missing || "(missing)";
    const count = numberFormatter({ maximumFractionDigits: 0 }, settings.locale);
    const value = (
      block: Block,
      row: number,
      parent: GroupKey,
      k: number,
      format = formats[k]!,
    ) => {
      const depth = parent.length;
      const v = k < depth ? parent[k]! : groupValue(block, depth, row, by);
      return v === null ? missing : format(v);
    };
    const write = layout.map(
      (column, c): ((block: Block, row: number, parent: GroupKey) => string) => {
        if (c === 0)
          return (block, row, parent) =>
            `${value(block, row, parent, parent.length)} (${count((block.data as RowsWindow & { kind: "groups" }).rowCounts[row]!)})`;
        const k = by.indexOf(column.field);
        if (k >= 0)
          return (block, row, parent) =>
            k <= parent.length ? value(block, row, parent, k, column.content.format) : "";
        const aggregate = group.aggregate.find(({ as }) => as === column.content.aggregate);
        if (!aggregate) return () => "";
        const kind = aggregateKind(aggregate, fields) as "number" | "time";
        const format =
          aggregate.field === column.field && kind === column.kind && aggregate.op !== "count"
            ? column.content.format
            : valueFormatter(kind, undefined, settings);
        return (block, row) => format((block.data!.columns[aggregate.as] as Float64Array)[row]!);
      },
    );
    this.#texts = { layout, query, write };
    return write;
  }

  // Selection

  /**
   * The store's channel changed: the scope the model published with it
   * goes with it; one of a selection replaced since goes.
   */
  #selectionChanged() {
    // Counts and conditions compiled for the selection replaced would keep it.
    this.#counted = null;
    for (const list of this.#revision.lists.values())
      for (const block of list.blocks.values()) block.test = null;
    this.#scope = this.#scopeNow();
    // Rows show a condition as selected only with the fields it reads.
    this.#readFields();
    this.notify();
  }

  #setsOf(selection: RemoteSelection) {
    let sets = this.#sets.get(selection);
    if (!sets) {
      sets =
        selection.kind === "keys"
          ? { keys: new Set(selection.keys), include: new Set(), except: new Set() }
          : {
              keys: new Set(),
              include: new Set(selection.include),
              except: new Set(selection.except),
            };
      this.#sets.set(selection, sets);
    }
    return sets;
  }

  #selected(selection: RemoteSelection, block: Block, row: number): boolean {
    return selectionHas(selection, this.#setsOf(selection), this.#keyOf(block, row), () =>
      this.#meets(selection, block, row),
    );
  }

  /** Whether a loaded record meets a selection's condition (never for a selection of keys). */
  #meets(selection: RemoteSelection, block: Block, row: number): boolean {
    if (selection.kind !== "matching") return false;
    if (block.test?.selection !== selection) {
      let at: (row: number) => boolean;
      try {
        const test = compileExpression(selection.where, block.fields!);
        at = (r) => test.at(r) === true;
      } catch {
        // A condition over fields the grid does not read selects none of its rows.
        at = () => false;
      }
      block.test = { selection, at };
    }
    return block.test.at(row);
  }

  /**
   * A group's state, from what is known now: whole when it was selected as
   * a group (or a group holding it, or every row) and no record loaded
   * within it was taken out since; partly when a group within it was, or
   * when some of its records loaded are selected; whole too when all of its
   * records are loaded and selected. Records not loaded are not guessed at.
   */
  #groupState(selection: RemoteSelection, path: GroupKey, rows: number): SelectionState {
    const { selected, seen } = this.#loadedUnder(selection, path);
    const scope = this.#scopeNow();
    if (
      scope?.selection === selection &&
      scope.filter === JSON.stringify(this.#revision.query.filter ?? null) &&
      scope.by === JSON.stringify(this.#by())
    ) {
      const within = scope.path;
      if (within === null || isPrefix(within, path)) return selected < seen ? "some" : "all";
      // A group within this one was selected: all of it only if it is all there is.
      if (isPrefix(path, within))
        return this.#only(path, within) && selected >= seen ? "all" : "some";
    }
    if (selected === 0) return "none";
    return selected >= rows && seen >= rows ? "all" : "some";
  }

  /** Whether each group from `path` down to `within` holds only the next: `within` is all of `path`. */
  #only(path: GroupKey, within: GroupKey): boolean {
    for (let depth = path.length; depth < within.length; depth++)
      if (this.#revision.lists.get(groupId(within.slice(0, depth)))?.total !== 1) return false;
    return true;
  }

  /** How many records loaded within a group are selected, and how many are loaded. */
  #loadedUnder(selection: RemoteSelection, path: GroupKey): { selected: number; seen: number } {
    let counted = this.#counted;
    if (counted?.selection !== selection || counted.arrangement !== this.#arrangement) {
      counted = { selection, arrangement: this.#arrangement, counts: new Map() };
      this.#counted = counted;
    }
    const id = groupId(path);
    let count = counted.counts.get(id);
    if (!count) {
      count = { selected: 0, seen: 0 };
      for (const list of this.#revision.lists.values()) {
        if (!list.leaf || !isPrefix(path, list.parent)) continue;
        for (const block of list.blocks.values()) {
          if (block.state !== "loaded") continue;
          for (let row = 0; row < block.data!.length; row++) {
            count.seen++;
            if (this.#selected(selection, block, row)) count.selected++;
          }
        }
      }
      counted.counts.set(id, count);
    }
    return count;
  }

  #selectMatching(path: GroupKey | null) {
    const filter = this.#revision.query.filter;
    const tests: Expression[] = [];
    if (filter !== undefined) tests.push(filter);
    if (path) tests.push(groupCondition(this.#by(), path));
    const where: Expression =
      tests.length === 0 ? true : tests.length === 1 ? tests[0]! : ["and", ...tests];
    this.#publish({ kind: "matching", where, include: [], except: [] }, path);
  }

  /**
   * The scope the channel's selection was published with by the model:
   * that of the publication under way when the store is at its revision
   * (store listeners that run before the model's own read it so too), or
   * the one installed, while its selection is the channel's.
   */
  #scopeNow(): Scope | null {
    const current = this.selection.get(this.channel);
    const pending = this.#pending;
    const version = this.selection.version(this.channel);
    if (pending && pending.version === version && current?.kind === "matching") {
      const { version: _, ...scope } = pending;
      return { ...scope, selection: current };
    }
    return this.#scope?.selection === current ? this.#scope : null;
  }

  /**
   * Puts a selection in the channel; a group's or every row's when `path`
   * is given (null for every row), which the model then shows selected as
   * a group. Rows toggled in or out of it keep it a group's.
   */
  #publish(selection: RemoteSelection, path?: GroupKey | null) {
    const store = this.selection;
    const scope = this.#scopeNow();
    // The scope is of this publication alone: the channel's next version.
    const version = store.version(this.channel) + 1;
    if (path !== undefined)
      this.#pending = {
        path,
        filter: JSON.stringify(this.#revision.query.filter ?? null),
        by: JSON.stringify(this.#by()),
        version,
      };
    else if (scope && selection.kind === "matching")
      this.#pending = { path: scope.path, filter: scope.filter, by: scope.by, version };
    try {
      store.set(this.channel, selection);
    } finally {
      this.#pending = null;
    }
  }
}

/**
 * Runs a call into the source once the model's command is over: the
 * source's code (its abort listeners, `release`, `locate`, `rows`) may run
 * any command of the model, which must not find one half done.
 */
function later(hook: () => void) {
  queueMicrotask(hook);
}

/** A remote grid model; see `RemoteGridModel`. */
export function createRemoteGridModel<S extends Schema>(
  options: RemoteGridModelOptions<S>,
): RemoteGridModel<S> {
  return new RemoteGridModel(options);
}

/** Rows a list shows itself: its total, or as far as it is read and a block more. */
function count(list: List, size = 0): number {
  if (list.total !== null) return list.total;
  return Math.max(list.provisional, list.frontier + size);
}

function refOf(list: List, ordinal: number): RemoteRef {
  return { scope: list.revision, id: `${list.id}${ordinal}`, list, ordinal };
}

/** The value of a group's own grouping field: a label, a number, or null for missing. */
function groupValue(
  block: Block,
  depth: number,
  row: number,
  by: readonly string[],
): string | number | null {
  return valueAt(block.data!, by[depth]!, row);
}

function aggregateKind(aggregate: GridAggregate, fields: Record<string, string>): string {
  const { op, field } = aggregate;
  return op !== "count" && op !== "sum" && field !== undefined && fields[field] === "time"
    ? "time"
    : "number";
}

function isPrefix(prefix: GroupKey, path: GroupKey): boolean {
  return prefix.length <= path.length && groupId(path.slice(0, prefix.length)) === groupId(prefix);
}

/**
 * A window holding only the fields expected, each in arrays of its own: a
 * column viewing a much larger buffer (a source handing out views of its
 * arrays) would keep that buffer alive, and fields not asked for are not kept.
 */
function ownColumns(data: RowsWindow, kinds: Readonly<Record<string, string>>): RowsWindow {
  const own = <A extends Float64Array | Int32Array>(array: A): A =>
    array.buffer.byteLength > 65536 && array.buffer.byteLength > 4 * array.byteLength
      ? (array.slice() as A)
      : array;
  const columns: Record<string, RowsWindow["columns"][string]> = Object.create(null);
  for (const field of Object.keys(kinds)) {
    const column = data.columns[field]!;
    columns[field] =
      column instanceof Float64Array ? own(column) : { ...column, codes: own(column.codes) };
  }
  if (data.kind === "groups")
    return {
      ...data,
      columns,
      rowCounts: own(data.rowCounts),
      childCounts: own(data.childCounts),
    };
  return { ...data, columns };
}

/** Bytes a block keeps: its buffers, and its dictionaries' labels at two bytes a character. */
function bytesOf(data: RowsWindow): number {
  const buffers = new Set<ArrayBufferLike>();
  let bytes = 0;
  for (const column of Object.values(data.columns)) {
    if (column instanceof Float64Array) buffers.add(column.buffer);
    else {
      buffers.add(column.codes.buffer);
      for (const label of column.dictionary) bytes += 2 * label.length + 16;
    }
  }
  if (data.kind === "groups") {
    buffers.add(data.rowCounts.buffer);
    buffers.add(data.childCounts.buffer);
  }
  for (const buffer of buffers) bytes += buffer.byteLength;
  return bytes;
}

const followers = new FinalizationRegistry<() => void>((stop) => stop());
