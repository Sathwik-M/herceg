// A grid's state without a DOM, imported as `herceg/grid/model`: the rows
// of a row view (or the view's groups, level by level, each followed by its
// groups below or its rows when expanded, or a pivot's rows, from
// grid/pivot.ts), which rows are selected, and what every grid model has
// (grid/base.ts): its columns, where it is scrolled, and which cell has the
// focus. A renderer (dom/grid.ts) draws it and turns keys, clicks, and drags
// into its commands; applications call the same commands.
// One model serves one grid: grids showing the same rows share the view, the
// groups, and the selection store, each with a model of its own.

import { compileExpression, type Expression, type Fields } from "../data/expression.ts";
import { type GroupKey, groupId, type RowGroups } from "../data/groups.ts";
import type { SortKey } from "../data/order.ts";
import { RowSet } from "../data/row-set.ts";
import type { RowSnapshot, RowView } from "../data/row-view.ts";
import {
  type DataSelection,
  type SelectionStore,
  selectionStore,
  selectRows,
} from "../data/selection.ts";
import type { PositionField, Schema, Table } from "../data/table.ts";
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
import {
  type ColumnContent,
  describeColumns,
  type GridColumn,
  type PlacedColumn,
} from "./columns.ts";
import {
  countGroup,
  countRow,
  countSelected,
  countsHold,
  extended,
  headerTexts,
  type Projection,
  placeOf,
  project,
  type SelectedCounts,
  shownAs,
  stamped,
} from "./grouped.ts";

export {
  BaseGridModel,
  type FocusMove,
  type GridFocus,
  type GridRange,
  type GridRef,
  type GridSettings,
  type SelectionState,
  type SelectMode,
  type ShownRow,
} from "./base.ts";
export {
  type GridColumn,
  type GridColumnLayout,
  MIN_COLUMN_WIDTH,
  MIN_SCROLLING_WIDTH,
  type PinSide,
} from "./columns.ts";

export interface GridModelOptions<S extends Schema = Schema> extends GridSettings {
  /** The rows to show, in order. The application owns the view; the grid sorts through it. */
  data: RowView<S>;
  columns: readonly GridColumn<S>[];
  /**
   * Groups of the view's rows (`groupRows(data, ...)`) to show as group
   * rows, each followed by its groups below, or its rows, when expanded;
   * none by default.
   */
  groups?: RowGroups<S> | null;
  /** Where the selected rows go; a store of the grid's own when left out. */
  selectionStore?: SelectionStore<S>;
  /** The store's channel for the selected rows; "grid-rows" by default. */
  channel?: string;
}

/**
 * What a row of the grid shows: a row of the table, or, in grouped grids,
 * a group's header. Made when asked for; the grid keeps no object per row.
 */
export type GridRow =
  | {
      readonly kind: "row";
      /** Follows the row: its table's generation and identity. */
      readonly ref: GridRef;
      /** The table's `modifiedVersion`: what the row shows changes with it. */
      readonly version: number;
      /** Its position in the table. */
      readonly position: number;
      /** `rowOffset + position`: the row's own while rows come and go, until the table resets. */
      readonly identity: number;
      /** Its group (a row of the groups' last table), or -1 when the grid has no groups. */
      readonly group: number;
      /** Its level in the tree: one past the groups' levels under groups, 1 otherwise. */
      readonly level: number;
      /** Its place among its group's rows (or the grid's), from 0, and how many there are. */
      readonly setIndex: number;
      readonly setSize: number;
    }
  | {
      readonly kind: "group";
      /** Follows the group: its groups and its id. */
      readonly ref: GridRef;
      /** The groups' revision: what the header shows changes with it. */
      readonly version: number;
      /** The group: a row of its level's table, `groups.tableOf(groups.by[level - 1])`. */
      readonly group: number;
      /** Its key path: its value of each grouping field down to its level's. */
      readonly key: GroupKey;
      /** Names the group for maps and element keys, the same while its key is. */
      readonly id: string;
      /** Rows of the view in the group, shown or not. */
      readonly rows: number;
      readonly expanded: boolean;
      /** Its level in the tree, from 1: the number of grouping fields its key has. */
      readonly level: number;
      /** Its place among the groups in the same group above (or the first level's), from 0, and how many there are. */
      readonly setIndex: number;
      readonly setSize: number;
    };

/** A table row by its table's generation and identity, or a group by its key among its groups. */
type RowRef = { readonly scope: number; readonly id: number };
type GroupRef = { readonly scope: RowGroups; readonly id: string; readonly key: GroupKey };

/** What the grid shows, as of one state of its view, table, and groups. */
interface Display extends GridDisplay {
  readonly snapshot: RowSnapshot;
  readonly grouped: Projection | null;
}

/**
 * A row: its group and the group's depth (the last level's for a row of the
 * table), its position (-1 for a group's header), and in grouped grids the
 * header shown at or before it and how far past that header it is.
 */
interface Entry {
  readonly depth: number;
  readonly group: number;
  readonly position: number;
  readonly header: number;
  readonly offset: number;
}

/**
 * A pivot as a grid shows it (grid/pivot.ts, which keeps pivots out of
 * grids that show none): its rows are its groups' first level, never
 * expanded, and its columns are generated, each a field of its crosstab.
 */
export interface GridPivot {
  readonly groups: RowGroups;
  /** The table whose row `r` holds the pivot's row `r`, which cells read. */
  readonly rows: Table;
  /** The crosstab's fields (the rows field and the columns generated), which rows sort by. */
  readonly fields: Fields;
  /** Counts changes of the columns generated. */
  readonly revision: number;
  /** Whether the pivot stopped at a limit: its rows show what they held, and select nothing. */
  readonly stopped: boolean;
  /** The columns generated now, laid out as `current` left them, or as `given` (by `setColumns`) says. */
  columns(
    current: readonly Column[],
    given: readonly GridColumn[] | null,
  ): { columns: Column[]; contents: Map<string, ColumnContent> };
}

/**
 * The state of one grid over a row view. Every read brings it up to date
 * with its view, its groups, its table, and its selection store; listeners
 * are told synchronously when any of them, or the model's own state, changes.
 */
export class GridModel<S extends Schema = Schema> extends BaseGridModel<S> {
  readonly data: RowView<S>;
  readonly selectionStore: SelectionStore<S>;
  readonly channel: string;
  readonly #table: Table;

  #groups: RowGroups | null = null;
  readonly #pivot: GridPivot | null;
  /** The pivot's columns' revision the columns were generated for. */
  #pivotRevision = -1;
  #groupSort: readonly SortKey[] = [];
  /** Ids of groups expanded otherwise than by default. */
  readonly #toggled = new Set<string>();
  #expandedByDefault = false;
  /** Counts changes of the groups or their order, which keep the scroll offset as a new query does. */
  #structure = 0;
  /** Counts those and changes of expansion, which keep the top row in place. */
  #arrangement = 0;
  #groupTexts: {
    layout: readonly PlacedColumn[];
    groups: RowGroups;
    texts: ((group: number, depth: number) => string)[];
  } | null = null;
  #counts: SelectedCounts | null = null;

  /** The view's revision, its table's version, and the groups' revision the display is of. */
  #seen = {
    revision: -1,
    version: -1,
    query: -1,
    generation: -1,
    groups: -1,
    structure: -1,
    arrangement: -1,
  };

  /** The row set the model last put in the channel, with the store's revision then. */
  #published: { rows: RowSet<S>; revision: number } | null = null;
  #condition: { expression: Expression; version: number; test: (row: number) => boolean } | null =
    null;
  #count: { selection: unknown; version: number; count: number } | null = null;

  readonly #stop: () => void;

  /** `pivot`, from `createPivotGridModel`, shows a pivot's rows. */
  constructor(options: GridModelOptions<S>, pivot?: GridPivot) {
    super(options);
    const { data, selectionStore: store } = options;
    this.data = data;
    this.#table = data.source as unknown as Table;
    if (store && store.source !== data.source)
      throw new Error(
        "grid selectionStore: the store is of another table; give a store of the view's table",
      );
    this.selectionStore = store ?? selectionStore(data.source);
    this.channel = options.channel ?? "grid-rows";
    this.#pivot = pivot ?? null;
    this.#groups = pivot
      ? pivot.groups
      : this.#checkGroups(options.groups ?? null, options.columns);
    this.setColumns(options.columns);
    // Held weakly by what it follows, so a model no one keeps stops following on its own.
    const ref = new WeakRef(this);
    const changed = () => {
      const model = ref.deref();
      if (model) model.#changed();
      else stop();
    };
    const stops = [data.subscribe(changed), this.selectionStore.subscribe(changed)];
    const stop = () => {
      for (const unsubscribe of stops) unsubscribe();
    };
    this.#stop = stop;
    followers.register(this, stop, this);
  }

  // Columns

  /**
   * Replaces the columns: their order, widths, pins, formats, aggregates, and
   * which are hidden. A pivot grid's columns are generated: it takes their
   * layout, by id, kept for columns not generated now until they are.
   */
  setColumns(columns: readonly GridColumn<S>[]): void {
    const pivot = this.#pivot;
    if (pivot) {
      const generated = pivot.columns(
        this.columnList as readonly Column[],
        columns as readonly GridColumn[],
      );
      this.#pivotRevision = pivot.revision;
      this.takeColumns(generated.columns as Column<S>[], generated.contents);
      return;
    }
    const contents = describeColumns(this.#table, columns as readonly GridColumn[], this.settings);
    this.#checkGroups(this.#groups, columns);
    this.takeColumns(
      columns.map((column) => ({ ...column, id: column.id ?? column.field })) as Column<S>[],
      contents,
    );
  }

  // Groups

  /** The groups the grid shows, or null when it shows the view's rows alone (or a pivot's). */
  get groups(): RowGroups<S> | null {
    return (this.#pivot ? null : this.#groups) as RowGroups<S> | null;
  }

  get grouped(): boolean {
    return this.groups !== null;
  }

  /**
   * Shows the view's rows in these groups (made by `groupRows` from the
   * grid's view), or without groups again with null. Groups start
   * collapsed, in the order they first appeared.
   */
  setGroups(groups: RowGroups<S> | null): void {
    if (this.#pivot) throw new Error("A pivot grid shows its pivot's rows");
    if (groups === this.#groups) return;
    this.#checkGroups(groups, this.columnList);
    this.current();
    this.#groups = groups as RowGroups | null;
    this.#toggled.clear();
    this.#expandedByDefault = false;
    this.#groupSort = [];
    // Nothing may keep the groups replaced, which follow their view while kept.
    this.#counts = null;
    this.#groupTexts = null;
    if (this.rangeAnchor && "key" in this.rangeAnchor) this.rangeAnchor = null;
    this.#structure++;
    this.#arrangement++;
    this.current();
    this.notify();
  }

  /** The order of the groups: keys over the groups' tables (grouping fields and aggregates). */
  get groupSort(): readonly SortKey[] {
    return this.#groupSort;
  }

  /**
   * Orders the groups by fields of the groups' tables, stably; the order
   * they appeared in without keys. Each level's groups are ordered among
   * their siblings by the keys its table has: aggregates order every level,
   * and a grouping field the groups of its own level.
   */
  setGroupSort(keys: readonly SortKey[]): void {
    this.current();
    this.#sortGroups(keys);
    this.current();
    this.notify();
  }

  /** Whether the group with this key path (of any level) shows its groups below, or its rows. */
  isExpanded(key: GroupKey): boolean {
    return this.#isOpen(groupId(key));
  }

  /**
   * Shows or hides the groups below, or the rows, of the group with this key
   * path; groups below keep their own expansion. The focus on a row or group
   * hidden moves to the group's header when it collapses.
   */
  setExpanded(key: GroupKey, expanded: boolean): void {
    if (this.isExpanded(key) === expanded) return;
    const id = groupId(key);
    if (expanded === this.#expandedByDefault) this.#toggled.delete(id);
    else this.#toggled.add(id);
    this.#prune();
    this.#rearrange();
  }

  /** Expands every group of every level, those that appear later too. */
  expandAll(): void {
    this.#expandedByDefault = true;
    this.#toggled.clear();
    this.#rearrange();
  }

  /** Collapses every group of every level, those that appear later too. */
  collapseAll(): void {
    this.#expandedByDefault = false;
    this.#toggled.clear();
    this.#rearrange();
  }

  /** Where the header of the group with this key path shows, or -1 (a group above it is collapsed). */
  rowIndexOfGroup(key: GroupKey): number {
    const groups = this.#groups;
    this.current();
    if (!groups) return -1;
    return this.find({ scope: groups, id: groupId(key), key } as GroupRef, false);
  }

  // Rows

  /** What the row at `rowIndex` shows: a row of the table, or a group's header. */
  row(rowIndex: number): GridRow {
    const display = this.current() as Display;
    const entry = this.#entry(rowIndex);
    const ref = this.refAt(rowIndex);
    const { grouped } = display;
    if (entry.position >= 0) {
      const { position, group } = entry;
      return {
        kind: "row",
        ref,
        version: this.#table.modifiedVersion,
        position,
        identity: ref.id as number,
        group,
        level: grouped ? grouped.groups.by.length + 1 : 1,
        setIndex: grouped ? entry.offset - 1 : rowIndex,
        setSize: grouped ? grouped.groups.size(group) : display.length,
      };
    }
    const { groups, open, places, siblings } = grouped!;
    const { group, depth, header } = entry;
    return {
      kind: "group",
      ref,
      version: groups.revision,
      group,
      key: (ref as GroupRef).key,
      id: ref.id as string,
      rows: groups.size(group, depth),
      expanded: open[depth]![group] === 1,
      level: depth + 1,
      setIndex: places[header]!,
      setSize: siblings[header]!,
    };
  }

  /** The table position of the row at `rowIndex`; a group's header has none. */
  rowAt(rowIndex: number): number {
    const { position } = this.#entry(rowIndex);
    if (position < 0) throw new TypeError(`Row ${rowIndex} is a group's header, not a table row`);
    return position;
  }

  /**
   * The row's identity, `rowOffset + position`, which stays its own as rows
   * are appended and dropped, until the table resets.
   */
  identityAt(rowIndex: number): number {
    return this.rowAt(rowIndex) + (this.current() as Display).snapshot.rowOffset;
  }

  /** Where the row of this identity shows now, or -1 when the grid leaves it out (or its group is collapsed). */
  rowIndexOf(identity: number): number {
    const { generation } = (this.current() as Display).snapshot;
    return this.find({ scope: generation, id: identity }, false);
  }

  /** The text of a cell: row `rowIndex` of the view, shown column `columnIndex`. */
  textAt(rowIndex: number, columnIndex: number): string {
    // Catching up first: a pivot's columns follow its rows.
    const { group, depth, position } = this.#entry(rowIndex);
    const column = this.columnLayout[columnIndex] as PlacedColumn | undefined;
    if (!column) throw new RangeError(`Column ${columnIndex} is not shown`);
    if (position >= 0) return column.content.text(this.#table, position);
    if (this.#pivot) return column.content.text(this.#pivot.rows, group);
    return this.#textsOfGroups()[columnIndex]!(group, depth);
  }

  // Sorting

  get sort(): readonly SortKey<PositionField<S>>[] {
    // A pivot grid's keys are of its crosstab's fields, as they are now.
    if (this.#pivot) {
      this.generated();
      return this.#groupSort as readonly SortKey<PositionField<S>>[];
    }
    return this.data.query.sort ?? [];
  }

  /**
   * Sorts the view by these keys, keeping its filter; in grouped grids, the
   * rows within each group. A pivot grid sorts its rows by its columns'
   * fields, leaving the view alone.
   */
  setSort(keys: readonly SortKey<PositionField<S>>[]): void {
    if (this.#pivot) this.setGroupSort(keys);
    else this.data.setQuery({ ...this.data.query, sort: keys });
  }

  /**
   * Sorts by a column's field as a header click does: ascending, then
   * descending, then not at all. Plain, the field becomes the only key;
   * additive (Shift and click), the other keys stay and a new field goes last.
   * In grouped grids the groups sort too: every level's by the column's
   * aggregate, or the level of the grouping field the column shows by key.
   */
  cycleSort(column: string, { additive = false }: { additive?: boolean } = {}): void {
    const definition = this.column(column);
    const field = definition.field as PositionField<S>;
    const keys = this.sort;
    const order = nextOrder(keys, field);
    const groups = this.#groups;
    if (groups && !this.#pivot) {
      const by = groups.by as readonly string[];
      const key = definition.aggregate ?? (by.includes(field) ? field : undefined);
      this.current();
      this.#sortGroups(cycled(this.#groupSort, key, order, additive));
    }
    this.setSort(cycled(keys, field, order, additive));
  }

  // Selection

  /** How much of a row is selected; a group's header is partly when some of its rows are. */
  selectionState(rowIndex: number): SelectionState {
    const { group, depth, position } = this.#entry(rowIndex);
    if (position >= 0) return this.#selected(position) ? "all" : "none";
    const selected = this.#groupCounts().counts[depth]![group]!;
    return selected === 0 ? "none" : selected >= this.#groups!.size(group, depth) ? "all" : "some";
  }

  get selectionRevision(): number {
    return this.selectionStore.revision;
  }

  /**
   * Rows selected, counting those the view leaves out. A condition is
   * counted over the whole table, so ask after selecting, not every frame.
   */
  get selectedCount(): number {
    const selection = this.selectionStore.get(this.channel);
    if (!selection) return 0;
    if (selection.kind === "rows") return selection.rows.size;
    const version = this.#table.version;
    if (this.#count?.selection !== selection || this.#count.version !== version) {
      const test = this.#test(selection.expression);
      let count = 0;
      for (let row = 0; row < this.#table.length; row++) if (test(row)) count++;
      this.#count = { selection, version, count };
    }
    return this.#count.count;
  }

  /**
   * Selects as clicks do (see `SelectMode`); the selection is a row set in
   * the channel. Selecting a group's header selects every row of the group
   * the view shows, in its groups below too, collapsed or not; toggling it
   * clears them when all are selected.
   */
  select(rowIndex: number, mode: SelectMode = "only"): void {
    const { group, depth, position } = this.#entry(rowIndex);
    if (this.#pivot?.stopped) return;
    if (mode === "only" || mode === "toggle") {
      const only = mode === "only";
      const rows = only ? new RowSet(this.data.source) : this.#writable();
      const groups = this.#groups;
      let adjust: (counts: readonly Float64Array[]) => void;
      if (position >= 0) {
        const removed = !only && rows.has(position);
        if (removed) rows.delete(position);
        else rows.add(position);
        adjust = (counts) => {
          if (only) for (const at of counts) at.fill(0);
          if (group >= 0) countRow(counts, groups!, group, removed ? -1 : 1);
        };
      } else {
        const members = groups!.members(group, depth);
        const removed = !only && this.selectionState(rowIndex) === "all";
        if (removed) for (const member of members) rows.delete(member);
        else rows.addAll(members);
        adjust = (counts) => {
          if (only) for (const at of counts) at.fill(0);
          countGroup(counts, groups!, depth, group, !removed);
        };
      }
      this.rangeAnchor = this.refAt(rowIndex);
      this.#publish(rows, adjust);
      return;
    }
    let from = this.rangeAnchorIndex();
    if (from === null) {
      from = rowIndex;
      this.rangeAnchor = this.refAt(rowIndex);
    }
    const rows = mode === "range" ? new RowSet(this.data.source) : this.#writable();
    const [start, end] = from <= rowIndex ? [from, rowIndex + 1] : [rowIndex, from + 1];
    this.#addRows(rows, start, end);
    this.#publish(rows, null);
  }

  /** Selects every row the view shows, those scrolled away or in collapsed groups too, as they are now. */
  selectAll(): void {
    const { snapshot } = this.current() as Display;
    if (this.#pivot?.stopped) return;
    const rows = new RowSet(this.data.source);
    addRows(rows, snapshot, 0, snapshot.length);
    const groups = this.#groups;
    this.#publish(rows, (counts) => {
      counts.forEach((at, depth) => {
        for (let group = 0; group < at.length; group++) at[group] = groups!.size(group, depth);
      });
    });
  }

  /** Clears the channel and the range anchor; whether there was anything to clear. */
  clearSelection(): boolean {
    const had = this.selectionStore.get(this.channel) !== null || this.rangeAnchor !== null;
    this.rangeAnchor = null;
    if (this.selectionStore.get(this.channel) !== null) this.selectionStore.set(this.channel, null);
    return had;
  }

  /** Stops following the view and the store. They, the groups, and the table stay the application's. */
  override dispose(): void {
    this.#stop();
    followers.unregister(this);
    super.dispose();
    this.#condition = null;
    this.#count = null;
    this.#counts = null;
    this.#groupTexts = null;
  }

  // For the shared model (base.ts)

  /**
   * Catches up with the view, its table, and the groups: the top row keeps
   * its place when the table changed or groups were expanded or collapsed,
   * unless the query, the groups, or their order changed too or the table
   * was reset.
   */
  protected catchUp(previous: GridDisplay | undefined): Display {
    const view = this.data;
    const groups = this.#groups;
    const pivot = this.#pivot;
    if (pivot && pivot.revision !== this.#pivotRevision) this.#generate(pivot);
    // The groups' revision catches them up; the table's version too, since a
    // listener of the table that runs before the view's reads before the
    // view has been told.
    const revision = groups ? groups.revision : -1;
    const seen = this.#seen;
    if (
      previous &&
      view.revision === seen.revision &&
      view.source.version === seen.version &&
      revision === seen.groups &&
      this.#arrangement === seen.arrangement
    )
      return previous as Display;
    const snapshot = view.read();
    const reset = snapshot.generation !== seen.generation;
    const requery = view.queryRevision !== seen.query || this.#structure !== seen.structure;
    const grouped = groups
      ? project(
          groups,
          this.#groupSort,
          (id) => this.#isOpen(id),
          pivot ? [pivot.fields] : undefined,
        )
      : null;
    this.#seen = {
      revision: view.revision,
      version: view.source.version,
      query: view.queryRevision,
      generation: snapshot.generation,
      groups: revision,
      structure: this.#structure,
      arrangement: this.#arrangement,
    };
    return {
      snapshot,
      length: grouped ? grouped.starts[grouped.count]! : snapshot.length,
      grouped,
      keep: !reset && !requery,
    };
  }

  /** What follows the row at `rowIndex`: its identity, or its group's key path. */
  protected refAt(rowIndex: number): GridRef {
    const { snapshot, grouped } = this.current() as Display;
    const { group, depth, position } = this.#entry(rowIndex);
    if (position >= 0) return { scope: snapshot.generation, id: snapshot.rowOffset + position };
    const groups = grouped!.groups;
    return {
      scope: groups,
      id: groups.idOf(group, depth),
      key: groups.keyOf(group, depth),
    } as GroupRef;
  }

  /**
   * Where a row or group is now, or -1 when it left (or the table was reset
   * since). A row or group hidden by a collapsed group above is at that
   * group's header with `collapsed`, and nowhere without.
   */
  protected find(ref: GridRef, collapsed: boolean): number {
    const { snapshot, grouped } = this.current() as Display;
    if ("key" in ref) {
      const { key, scope } = ref as GroupRef;
      if (!grouped || scope !== grouped.groups) return -1;
      const group = grouped.groups.indexOf(key);
      if (group < 0) return -1;
      const depth = key.length - 1;
      const shown = shownAs(grouped, depth, group);
      if (shown.depth < depth && !collapsed) return -1;
      return grouped.starts[grouped.rank[shown.depth]![shown.group]!]!;
    }
    const { scope, id } = ref as RowRef;
    if (scope !== snapshot.generation) return -1;
    const position = id - snapshot.rowOffset;
    if (!grouped) return this.data.indexOf(position);
    const { groups, starts, rank, open } = grouped;
    const group = groups.groupOf(position);
    if (group < 0) return -1;
    const last = groups.by.length - 1;
    const shown = shownAs(grouped, last, group);
    const header = starts[rank[shown.depth]![shown.group]!]!;
    if (shown.depth < last || !open[last]![group]) return collapsed ? header : -1;
    const index = groups.memberIndex(position);
    return index < 0 ? -1 : header + 1 + index;
  }

  protected override moveInTree(focus: GridFocus, left: boolean): boolean {
    const { grouped } = this.current() as Display;
    if (!grouped || this.#pivot) return false;
    const { group, depth, position, header } = this.#entry(focus.rowIndex);
    const expanded = position < 0 && grouped.open[depth]![group] === 1;
    if (position < 0 && expanded === left) {
      this.setExpanded(grouped.groups.keyOf(group, depth), !expanded);
      return true;
    }
    // A collapsed group's parent, or a row's group, is shown above it.
    const holder =
      position >= 0
        ? header
        : depth > 0
          ? grouped.rank[depth - 1]![grouped.groups.parentOf(group, depth)]!
          : -1;
    if (!left || holder < 0) return false;
    this.focusCell(grouped.starts[holder]!, focus.column);
    return true;
  }

  /** A pivot's columns follow its values: they catch up with the rows. */
  protected override generated() {
    if (this.#pivot) this.current();
  }

  /** The view, its table, or the store changed. */
  #changed() {
    // Compiled conditions hold the table's arrays as they were.
    this.#condition = null;
    this.#count = null;
    this.notify();
  }

  /** Throws unless the groups are of the view and have the aggregates the columns show. */
  #checkGroups(
    groups: RowGroups<S> | RowGroups | null,
    columns: readonly GridColumn<S>[],
  ): RowGroups | null {
    if (!groups) return null;
    if (groups.view !== this.data) throw new Error("A grid's groups must be of its view's rows");
    for (const { field, id, aggregate } of columns) {
      if (aggregate !== undefined && !groups.aggregates.some(({ name }) => name === aggregate))
        throw new Error(`Column "${id ?? field}" shows "${aggregate}", which the groups lack`);
    }
    return groups as unknown as RowGroups;
  }

  #isOpen(id: string): boolean {
    return !this.#pivot && this.#expandedByDefault !== this.#toggled.has(id);
  }

  /**
   * Takes the pivot's columns as they are now: generated columns come and
   * go, keeping their layout and the focus, the first scrolling column in
   * view stays where it was, and sort keys of columns gone go too.
   */
  #generate(pivot: GridPivot) {
    const generated = pivot.columns(this.columnList as readonly Column[], null);
    this.#pivotRevision = pivot.revision;
    // Rows sort by the columns there are; the others' keys go.
    const keys = this.#groupSort.filter(({ field }) => pivot.fields.has(field));
    if (keys.length < this.#groupSort.length) this.#groupSort = Object.freeze(keys);
    this.regenerate(generated.columns as Column<S>[], generated.contents);
  }

  /** Forgets the expansion of groups gone once they outnumber those left, so streams of keys do not pile up. */
  #prune() {
    const groups = this.#groups;
    if (!groups) return;
    const depths = groups.by.length;
    let count = 0;
    for (let depth = 0; depth < depths; depth++) count += groups.countAt(depth);
    if (this.#toggled.size <= 64 + 2 * count) return;
    const current = new Set<string>();
    for (let depth = 0; depth < depths; depth++)
      for (let group = 0; group < groups.countAt(depth); group++)
        current.add(groups.idOf(group, depth));
    for (const id of this.#toggled) if (!current.has(id)) this.#toggled.delete(id);
  }

  /** Expansion changed: rows move, the focus leaves rows hidden, and listeners hear of it. */
  #rearrange() {
    this.current();
    this.#arrangement++;
    this.current();
    this.notify();
  }

  #sortGroups(keys: readonly SortKey[]) {
    const table = this.#pivot?.fields ?? this.#groups?.table;
    for (const { field } of keys)
      if (!table?.has(field)) throw new Error(`The groups have no field "${field}" to sort by`);
    this.#groupSort = Object.freeze(keys.map((key) => Object.freeze({ ...key })));
    this.#structure++;
    this.#arrangement++;
  }

  /** The row at `rowIndex`: its group and position, and the header it follows. */
  #entry(rowIndex: number): Entry {
    const { snapshot, grouped, length } = this.current() as Display;
    if (!(Number.isInteger(rowIndex) && rowIndex >= 0 && rowIndex < length))
      throw new RangeError(`Row ${rowIndex} is not among the grid's ${length} rows`);
    if (!grouped) {
      const position = snapshot.indices ? snapshot.indices[rowIndex]! : rowIndex;
      return { depth: -1, group: -1, position, header: -1, offset: 0 };
    }
    const header = placeOf(grouped, rowIndex);
    const group = grouped.heads[header]!;
    const offset = rowIndex - grouped.starts[header]!;
    const position = offset === 0 ? -1 : grouped.groups.memberAt(group, offset - 1);
    return { depth: grouped.depths[header]!, group, position, header, offset };
  }

  /** Whether the table's row at `position` is selected. */
  #selected(position: number): boolean {
    const selection = this.selectionStore.get(this.channel);
    if (!selection) return false;
    if (selection.kind === "rows") return selection.rows.has(position);
    return this.#test(selection.expression)(position);
  }

  /** What each column shows on a group's header row. */
  #textsOfGroups(): ((group: number, depth: number) => string)[] {
    const groups = this.#groups!;
    const layout = this.columnLayout as readonly PlacedColumn[];
    const cached = this.#groupTexts;
    if (cached?.layout === layout && cached.groups === groups) return cached.texts;
    const texts = headerTexts(groups, layout, this.settings, this.#table);
    this.#groupTexts = { layout, groups, texts };
    return texts;
  }

  /** Selected rows per group, counted once per change of the selection or of the groups' rows. */
  #groupCounts(): SelectedCounts {
    const groups = this.#groups!;
    this.current();
    const selection = this.selectionStore.get(this.channel) as DataSelection | null;
    const revision = this.selectionStore.revision;
    const view = this.data as unknown as RowView;
    const cached = this.#counts;
    if (cached && countsHold(cached, groups, revision, selection, view)) {
      // Groups started by appended rows have none selected yet.
      const counts = extended(cached.counts, groups);
      if (counts.some((at, depth) => at !== cached.counts[depth]))
        this.#counts = { ...cached, counts };
      return this.#counts!;
    }
    const test = selection?.kind === "predicate" ? this.#test(selection.expression) : () => false;
    this.#counts = countSelected(groups, selection, revision, test, view);
    return this.#counts;
  }

  /**
   * Adds the rows from row index `start` to `end`: a group's header adds
   * every row of its group, those of its groups below too.
   */
  #addRows(rows: RowSet<S>, start: number, end: number) {
    const { snapshot, grouped } = this.current() as Display;
    if (!grouped) {
      addRows(rows, snapshot, start, end);
      return;
    }
    const { starts, heads, depths, open, groups, count } = grouped;
    const last = groups.by.length - 1;
    // The depth of a header in the range whose rows were added: those below it add nothing more.
    let covered = -1;
    for (let at = this.#entry(start).header; at < count; at++) {
      const header = starts[at]!;
      if (header >= end) break;
      const [group, depth] = [heads[at]!, depths[at]!];
      if (covered >= 0 && depth > covered) continue;
      covered = -1;
      if (header >= start) {
        rows.addAll(groups.members(group, depth));
        covered = depth;
      } else if (depth === last && open[depth]![group]) {
        const members = groups.members(group, depth);
        rows.addAll(
          members.subarray(start - header - 1, Math.min(members.length, end - header - 1)),
        );
      }
    }
  }

  /** A compiled condition, for the table as it is now. */
  #test(expression: Expression): (row: number) => boolean {
    const version = this.#table.version;
    const cached = this.#condition;
    if (cached?.expression === expression && cached.version === version) return cached.test;
    const { at } = compileExpression(expression, this.#table);
    const test = (row: number) => at(row) === true;
    this.#condition = { expression, version, test };
    return test;
  }

  /**
   * The row set to change: the one the model last published, if the
   * channel still holds it, nothing replaced it since, and the table was
   * not reset; else a new set with the channel's rows (a condition's rows as
   * they are now: toggling a row of it keeps the others selected).
   */
  #writable(): RowSet<S> {
    const current = this.selectionStore.get(this.channel);
    const published = this.#published;
    if (
      published &&
      current?.kind === "rows" &&
      current.rows === published.rows &&
      published.rows.current &&
      this.selectionStore.revision === published.revision
    )
      return published.rows;
    const rows = new RowSet(this.data.source);
    if (current?.kind === "rows") rows.addAll(current.rows.positions());
    else if (current?.kind === "predicate") {
      const test = this.#test(current.expression);
      const matching: number[] = [];
      for (let row = 0; row < this.#table.length; row++) if (test(row)) matching.push(row);
      rows.addAll(matching);
    }
    return rows;
  }

  /**
   * Puts the rows in the channel. In grouped grids, `adjust` turns the
   * counts of selected rows per group into those of the new selection,
   * when they were current, so a click counts nothing again.
   */
  #publish(rows: RowSet<S>, adjust: ((counts: readonly Float64Array[]) => void) | null) {
    const store = this.selectionStore;
    const groups = this.#groups;
    const before = this.#counts;
    const view = this.data as unknown as RowView;
    const current = store.get(this.channel) as DataSelection | null;
    let after: SelectedCounts | null = null;
    if (groups && adjust && before && countsHold(before, groups, store.revision, current, view)) {
      const counts = extended(before.counts, groups).map((at) => at.slice());
      adjust(counts);
      // Stamped as things are now, and with the revision setting the channel
      // makes: the store's listeners may change the store, the view, or the
      // table, which the stamp then no longer matches.
      after = stamped(groups, store.revision + 1, view, counts);
    }
    this.#counts = null;
    store.set(this.channel, selectRows(rows));
    this.#published = { rows, revision: store.revision };
    // Unless a listener showed other groups meanwhile, which these counts must not keep.
    if (after && this.#groups === groups) this.#counts = after;
  }
}

/** A grid model; see `GridModel`. */
export function createGridModel<S extends Schema>(options: GridModelOptions<S>): GridModel<S> {
  return new GridModel(options);
}

/** Adds the rows at view indices `[start, end)`. */
function addRows<S extends Schema>(
  rows: RowSet<S>,
  { indices, length }: RowSnapshot,
  start: number,
  end: number,
) {
  // A view of every row in some order selects them all as one range.
  if (!indices || (start === 0 && end === length && length === rows.source.length))
    rows.addRange(indices ? 0 : start, indices ? length : end);
  else rows.addAll(indices.subarray(start, end));
}

const followers = new FinalizationRegistry<() => void>((stop) => stop());
