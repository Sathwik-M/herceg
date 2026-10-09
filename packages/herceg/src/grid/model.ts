// A grid's state without a DOM, imported as `herceg/grid/model`: the columns
// it shows (their order, widths, pins, and which are hidden), the rows of a
// row view (or the view's groups, each followed by its rows when expanded),
// where it is scrolled, which cell has the focus, and which rows are
// selected. A renderer (dom/grid.ts) draws it and turns keys, clicks, and
// drags into its commands; applications call the same commands.
// One model serves one grid: grids showing the same rows share the view, the
// groups, and the selection store, each with a model of its own.

import { compileExpression, type Expression } from "../data/expression.ts";
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
import type { TimeZone } from "../format/zone.ts";
import {
  type ColumnContent,
  describeColumns,
  type GridColumn,
  type GridColumnLayout,
  MIN_COLUMN_WIDTH,
  MIN_SCROLLING_WIDTH,
  type PinSide,
  type PlacedColumn,
  pinnedWidth,
  pinsHold,
  placeColumns,
  widthOf,
} from "./columns.ts";
import {
  countSelected,
  countsHold,
  headerTexts,
  type Projection,
  placeOf,
  project,
  type SelectedCounts,
  stamped,
} from "./grouped.ts";

export {
  type GridColumn,
  type GridColumnLayout,
  MIN_COLUMN_WIDTH,
  MIN_SCROLLING_WIDTH,
  type PinSide,
} from "./columns.ts";

export interface GridModelOptions<S extends Schema = Schema> {
  /** The rows to show, in order. The application owns the view; the grid sorts through it. */
  data: RowView<S>;
  columns: readonly GridColumn<S>[];
  /**
   * Groups of the view's rows (`groupRows(data, ...)`) to show as group
   * rows, each followed by its rows when expanded; none by default.
   */
  groups?: RowGroups<S> | null;
  /** Where the selected rows go; a store of the grid's own when left out. */
  selection?: SelectionStore<S>;
  /** The store's channel for the selected rows; "grid-rows" by default. */
  channel?: string;
  /** In CSS pixels; 28 by default. */
  rowHeight?: number;
  /** BCP 47 locale for numbers and times; the runtime's by default. */
  locale?: string;
  /** Zone times are shown in: "UTC", an IANA zone, or "local" (the default). */
  timeZone?: TimeZone;
  /** Text of missing values; empty by default. */
  missing?: string;
}

/** A cell: its row's index in the view (-1 for the header row) and its column. */
export interface GridFocus {
  readonly rowIndex: number;
  /** Index among the shown columns. */
  readonly columnIndex: number;
  /** The column's id. */
  readonly column: string;
}

/**
 * Rows `[rowStart, rowEnd)` and shown columns `[columnStart, columnEnd)`
 * among those that scroll; columns held at the edges are always in view.
 */
export interface GridRange {
  readonly rowStart: number;
  readonly rowEnd: number;
  readonly columnStart: number;
  readonly columnEnd: number;
}

/**
 * What a row of the grid shows: a row of the table, or, in grouped grids,
 * a group's header. Made when asked for; the grid keeps no object per row.
 */
export type GridRow =
  | {
      readonly kind: "row";
      /** Its position in the table. */
      readonly position: number;
      /** `rowOffset + position`: the row's own while rows come and go, until the table resets. */
      readonly identity: number;
      /** Its group (a row of the groups' table), or -1 when the grid has no groups. */
      readonly group: number;
      /** 2 under a group, 1 otherwise. */
      readonly level: number;
      /** Its place among its group's rows (or the grid's), from 0, and how many there are. */
      readonly setIndex: number;
      readonly setSize: number;
    }
  | {
      readonly kind: "group";
      /** The group: a row of the groups' table. */
      readonly group: number;
      readonly key: GroupKey;
      /** Names the group for maps and element keys, the same while its key is. */
      readonly id: string;
      /** Rows of the view in the group, shown or not. */
      readonly rows: number;
      readonly expanded: boolean;
      readonly level: 1;
      /** Its place among the groups, from 0, and how many there are. */
      readonly setIndex: number;
      readonly setSize: number;
    };

/** How much of a row is selected: a group's rows can be partly. */
export type SelectionState = "all" | "some" | "none";

/** Where `moveFocus` goes: a cell over, a page over, a row's ends, or the grid's first or last cell. */
export type FocusMove =
  | "up"
  | "down"
  | "left"
  | "right"
  | "pageUp"
  | "pageDown"
  | "rowStart"
  | "rowEnd"
  | "first"
  | "last";

/**
 * How `select` changes the selection: to only the row (a click), the row
 * toggled (Ctrl or Cmd and click), the rows from the anchor to it (Shift
 * and click), or those added (both). A group's header stands for its rows.
 */
export type SelectMode = "only" | "toggle" | "range" | "addRange";

/**
 * A row followed by identity (`rowOffset + position` in its table's
 * generation), or a group by its key among the groups it came from.
 */
type Ref =
  | { readonly identity: number; readonly generation: number }
  | { readonly id: string; readonly key: GroupKey; readonly groups: RowGroups };

interface Focus {
  /** The focused body row; null for the header row. */
  row: Ref | null;
  /** Where the row was, for when it leaves. */
  rowIndex: number;
  column: string;
  columnIndex: number;
}

/** What the grid shows, as of one state of its view, table, and groups. */
interface Display {
  readonly snapshot: RowSnapshot;
  readonly length: number;
  readonly grouped: Projection | null;
}

/** A row: its group and position (-1 for a group's header), and in grouped grids its group's place and its own. */
interface Entry {
  readonly group: number;
  readonly position: number;
  readonly rank: number;
  readonly offset: number;
}

const ROW_HEIGHT = 28;

/** A column as the model keeps it: with its id. */
type Column<S extends Schema> = GridColumn<S> & { readonly id: string };

/**
 * The state of one grid over a row view. Every read brings it up to date
 * with its view, its groups, its table, and its selection store; listeners
 * are told synchronously when any of them, or the model's own state, changes.
 */
export class GridModel<S extends Schema = Schema> {
  readonly data: RowView<S>;
  readonly selection: SelectionStore<S>;
  readonly channel: string;
  readonly rowHeight: number;
  readonly #table: Table;
  readonly #settings: { locale: string | undefined; timeZone: TimeZone; missing: string };
  /** The columns, shown or hidden, in order: the one record of their layout. */
  #columns: readonly Column<S>[] = [];
  /** What each column shows, by id, made when the columns are set. */
  #contents = new Map<string, ColumnContent>();
  #layout: readonly PlacedColumn[] = [];
  #width = 0;
  /** How many shown columns are held at each edge, and how wide they are. */
  #pins = { left: 0, right: 0, leftWidth: 0, rightWidth: 0 };

  #groups: RowGroups | null = null;
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
    texts: ((group: number) => string)[];
  } | null = null;
  #counts: SelectedCounts | null = null;

  /** What the grid shows as of the view's revision, its table's version, and the groups' revision in `#seen`. */
  #display: Display | undefined;
  #seen = {
    revision: -1,
    version: -1,
    query: -1,
    generation: -1,
    groups: -1,
    structure: -1,
    arrangement: -1,
  };

  #viewWidth = 0;
  #viewHeight = 0;
  #top = 0;
  #left = 0;
  /** The row at the top and how far it is scrolled past, kept in place as rows come and go. */
  #anchor: { ref: Ref; offset: number } | null = null;

  #focus: Focus | null = null;
  /** Where Shift ranges start. */
  #selectionAnchor: Ref | null = null;
  /** The row set the model last put in the channel, with the store's revision then. */
  #published: { rows: RowSet<S>; revision: number } | null = null;
  #condition: { expression: Expression; version: number; test: (row: number) => boolean } | null =
    null;
  #count: { selection: unknown; version: number; count: number } | null = null;

  readonly #listeners = new Set<() => void>();
  readonly #stop: () => void;

  constructor(options: GridModelOptions<S>) {
    const { data, selection } = options;
    this.data = data;
    this.#table = data.source as unknown as Table;
    if (selection && selection.source !== data.source)
      throw new Error("A grid's selection store must be of its view's table");
    this.selection = selection ?? selectionStore(data.source);
    this.channel = options.channel ?? "grid-rows";
    this.rowHeight = options.rowHeight ?? ROW_HEIGHT;
    if (!(Number.isFinite(this.rowHeight) && this.rowHeight > 0))
      throw new RangeError(`A grid's rowHeight must be positive, not ${this.rowHeight}`);
    this.#settings = {
      locale: options.locale,
      timeZone: options.timeZone ?? "local",
      missing: options.missing ?? "",
    };
    this.#groups = this.#checkGroups(options.groups ?? null, options.columns);
    this.setColumns(options.columns);
    // Held weakly by what it follows, so a model no one keeps stops following on its own.
    const ref = new WeakRef(this);
    const changed = () => {
      const model = ref.deref();
      if (model) model.#changed();
      else stop();
    };
    const stops = [data.subscribe(changed), this.selection.subscribe(changed)];
    const stop = () => {
      for (const unsubscribe of stops) unsubscribe();
    };
    this.#stop = stop;
    followers.register(this, stop, this);
  }

  // Columns

  /**
   * Every column, shown or hidden, in order, with its id: their layout as
   * resizing, moving, pinning, and hiding left it, which `setColumns` takes
   * back.
   */
  get columns(): readonly GridColumn<S>[] {
    return this.#columns;
  }

  /** The shown columns, placed side by side: pinned left, the others, pinned right. */
  get columnLayout(): readonly GridColumnLayout[] {
    return this.#layout;
  }

  /** Width of the shown columns together, in CSS pixels. */
  get width(): number {
    return this.#width;
  }

  /** Replaces the columns: their order, widths, pins, formats, aggregates, and which are hidden. */
  setColumns(columns: readonly GridColumn<S>[]): void {
    const contents = describeColumns(this.#table, columns as readonly GridColumn[], this.#settings);
    this.#checkGroups(this.#groups, columns);
    this.#contents = contents;
    this.#takeColumns(
      columns.map((column) => ({ ...column, id: column.id ?? column.field })) as Column<S>[],
    );
  }

  /**
   * Sets a column's width, in CSS pixels, no narrower than
   * `MIN_COLUMN_WIDTH`. A pinned column held at its edge widens only as far
   * as the pinned columns leave the others `MIN_SCROLLING_WIDTH`.
   */
  resizeColumn(id: string, width: number): void {
    const column = this.#column(id);
    if (!Number.isFinite(width)) throw new RangeError(`Column "${id}" cannot be ${width} wide`);
    const next = Math.max(MIN_COLUMN_WIDTH, Math.min(width, this.#widest(column)));
    if (next === widthOf(column)) return;
    this.#replace(column, { ...column, width: next });
  }

  /**
   * Moves a column before the column `before` in the columns' order, or last
   * with null. Pinned columns show at their edge in that order, so a move
   * among them, or among the others, is a move on the screen.
   */
  moveColumn(id: string, before: string | null): void {
    const column = this.#column(id);
    if (before !== null) this.#column(before);
    if (before === id) return;
    const rest = this.#columns.filter((other) => other !== column);
    const at = before === null ? rest.length : rest.findIndex((other) => other.id === before);
    if (this.#columns[at] === column) return;
    rest.splice(at, 0, column);
    this.#takeColumns(rest);
  }

  /**
   * Pins a column to the grid's left or right edge, or unpins it with null,
   * back to its place among the others. A column the grid has no room to
   * hold at an edge is refused (see `canPin`); `setColumns` takes pins as
   * given, to restore a layout, and pinned columns the grid becomes too
   * narrow for scroll with the others until it widens.
   */
  pinColumn(id: string, side: PinSide | null): void {
    if (side !== null && side !== "left" && side !== "right")
      throw new TypeError(`Columns pin to "left" or "right", not "${side}"`);
    const column = this.#column(id);
    if ((column.pin ?? null) === side) return;
    if (side !== null && !this.canPin(id))
      throw new RangeError(
        `Pinning "${id}" would leave the other columns less than ${MIN_SCROLLING_WIDTH} pixels`,
      );
    const { pin: _, ...rest } = column;
    this.#replace(column, (side === null ? rest : { ...rest, pin: side }) as Column<S>);
  }

  /**
   * Whether `pinColumn` can pin the column: whether, pinned, it would leave
   * the other columns at least `MIN_SCROLLING_WIDTH` of the grid as wide as
   * it is now. Always for a column pinned already (to move it to the other
   * side), a hidden one, or before the grid is measured.
   */
  canPin(id: string): boolean {
    const column = this.#column(id);
    if (column.pin !== undefined || column.hidden) return true;
    return pinsHold(pinnedWidth(this.#columns) + widthOf(column), this.#viewWidth);
  }

  /** Shows or hides a column. The focus on a column hidden goes to the nearest shown one. */
  setColumnVisible(id: string, visible: boolean): void {
    const column = this.#column(id);
    if (!column.hidden === visible) return;
    const { hidden: _, ...rest } = column;
    this.#replace(column, (visible ? rest : { ...rest, hidden: true }) as Column<S>);
  }

  /** Index of the shown column `id`, or -1. */
  columnIndex(id: string): number {
    return this.#layout.findIndex((column) => column.id === id);
  }

  // Groups

  /** The groups the grid shows, or null when it shows the view's rows alone. */
  get groups(): RowGroups<S> | null {
    return this.#groups as RowGroups<S> | null;
  }

  /**
   * Shows the view's rows in these groups (made by `groupRows` from the
   * grid's view), or without groups again with null. Groups start
   * collapsed, in the order they first appeared.
   */
  setGroups(groups: RowGroups<S> | null): void {
    if (groups === this.#groups) return;
    this.#checkGroups(groups, this.#columns);
    if (this.#display) this.#current();
    this.#groups = groups as RowGroups | null;
    this.#toggled.clear();
    this.#expandedByDefault = false;
    this.#groupSort = [];
    // Nothing may keep the groups replaced, which follow their view while kept.
    this.#counts = null;
    this.#groupTexts = null;
    if (this.#selectionAnchor && "id" in this.#selectionAnchor) this.#selectionAnchor = null;
    this.#structure++;
    this.#arrangement++;
    this.#current();
    this.#notify();
  }

  /** The order of the groups: keys over the groups' table (grouping fields and aggregates). */
  get groupSort(): readonly SortKey[] {
    return this.#groupSort;
  }

  /** Orders the groups by fields of the groups' table, stably; the order they appeared in without keys. */
  setGroupSort(keys: readonly SortKey[]): void {
    this.#current();
    this.#sortGroups(keys);
    this.#current();
    this.#notify();
  }

  /** Whether the group with this key shows its rows. */
  isExpanded(key: GroupKey): boolean {
    return this.#isOpen(groupId(key));
  }

  /**
   * Shows or hides the rows of the group with this key. The focus on one of
   * its rows moves to the group's header when it collapses.
   */
  setExpanded(key: GroupKey, expanded: boolean): void {
    if (this.isExpanded(key) === expanded) return;
    const id = groupId(key);
    if (expanded === this.#expandedByDefault) this.#toggled.delete(id);
    else this.#toggled.add(id);
    this.#prune();
    this.#rearrange();
  }

  /** Expands every group, those that appear later too. */
  expandAll(): void {
    this.#expandedByDefault = true;
    this.#toggled.clear();
    this.#rearrange();
  }

  /** Collapses every group, those that appear later too. */
  collapseAll(): void {
    this.#expandedByDefault = false;
    this.#toggled.clear();
    this.#rearrange();
  }

  /** Where the header of the group with this key shows, or -1. */
  rowIndexOfGroup(key: GroupKey): number {
    const groups = this.#groups;
    this.#current();
    if (!groups) return -1;
    return this.#find({ id: groupId(key), key, groups }, false);
  }

  // Rows

  get rowCount(): number {
    return this.#current().length;
  }

  /** Height of every row together, in CSS pixels. */
  get contentHeight(): number {
    return this.rowCount * this.rowHeight;
  }

  /** What the row at `rowIndex` shows: a row of the table, or a group's header. */
  row(rowIndex: number): GridRow {
    const display = this.#current();
    const entry = this.#entry(rowIndex);
    const { snapshot, grouped } = display;
    if (entry.position >= 0) {
      const { position, group } = entry;
      return {
        kind: "row",
        position,
        identity: snapshot.rowOffset + position,
        group,
        level: grouped ? 2 : 1,
        setIndex: grouped ? entry.offset - 1 : rowIndex,
        setSize: grouped ? grouped.groups.size(group) : display.length,
      };
    }
    const { groups, order, open } = grouped!;
    const { group } = entry;
    return {
      kind: "group",
      group,
      key: groups.keyOf(group),
      id: groups.idOf(group),
      rows: groups.size(group),
      expanded: open[group] === 1,
      level: 1,
      setIndex: entry.rank,
      setSize: order.length,
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
    return this.rowAt(rowIndex) + this.#current().snapshot.rowOffset;
  }

  /** Where the row of this identity shows now, or -1 when the grid leaves it out (or its group is collapsed). */
  rowIndexOf(identity: number): number {
    const { generation } = this.#current().snapshot;
    return this.#find({ identity, generation }, false);
  }

  /** The text of a cell: row `rowIndex` of the view, shown column `columnIndex`. */
  textAt(rowIndex: number, columnIndex: number): string {
    const column = this.#layout[columnIndex];
    if (!column) throw new RangeError(`Column ${columnIndex} is not shown`);
    const { group, position } = this.#entry(rowIndex);
    if (position >= 0) return column.content.text(this.#table, position);
    return this.#textsOfGroups()[columnIndex]!(group);
  }

  // Sorting

  get sort(): readonly SortKey<PositionField<S>>[] {
    return this.data.query.sort ?? [];
  }

  /** Sorts the view by these keys, keeping its filter; in grouped grids, the rows within each group. */
  setSort(keys: readonly SortKey<PositionField<S>>[]): void {
    this.data.setQuery({ ...this.data.query, sort: keys });
  }

  /**
   * Sorts by a column's field as a header click does: ascending, then
   * descending, then not at all. Plain, the field becomes the only key;
   * additive (Shift and click), the other keys stay and a new field goes last.
   * In grouped grids the groups sort too, by the column's aggregate, or by
   * their key when the column shows a grouping field.
   */
  cycleSort(column: string, { additive = false }: { additive?: boolean } = {}): void {
    const definition = this.#columns.find(({ id }) => id === column);
    if (!definition) throw new Error(`No grid column "${column}"`);
    const field = definition.field as PositionField<S>;
    const keys = this.sort;
    const at = keys.findIndex((key) => key.field === field);
    const current = at < 0 ? undefined : (keys[at]!.order ?? "ascending");
    const order =
      current === undefined ? "ascending" : current === "ascending" ? "descending" : undefined;
    const groups = this.#groups;
    if (groups) {
      const by = groups.by as readonly string[];
      const key = definition.aggregate ?? (by.includes(field) ? field : undefined);
      this.#current();
      this.#sortGroups(cycled(this.#groupSort, key, order, additive));
    }
    this.setSort(cycled(keys, field, order, additive));
  }

  // Viewport

  /** Sets the size of the area rows show in (below the header), in CSS pixels. */
  setViewport(width: number, height: number): void {
    if (width === this.#viewWidth && height === this.#viewHeight) return;
    const pinned = pinnedWidth(this.#columns);
    const held = pinsHold(pinned, this.#viewWidth);
    this.#viewWidth = Math.max(0, width);
    this.#viewHeight = Math.max(0, height);
    // Pinned columns are let go, or held again, as the grid narrows or widens.
    if (pinsHold(pinned, this.#viewWidth) !== held) this.#placeColumns();
    this.#current();
    this.#scroll(this.#top, this.#left, true);
    this.#notify();
  }

  get viewportWidth(): number {
    return this.#viewWidth;
  }

  get viewportHeight(): number {
    return this.#viewHeight;
  }

  /** How far the rows are scrolled, in CSS pixels; rows keep their place as the view changes. */
  get top(): number {
    this.#current();
    return this.#top;
  }

  get left(): number {
    return this.#left;
  }

  /** Scrolls to these offsets, kept within the rows and columns. */
  scrollTo({ top, left }: { top?: number; left?: number }): void {
    // Offsets left out are the current ones once rows have caught up (and been anchored).
    this.#current();
    this.#scroll(top ?? this.#top, left ?? this.#left);
  }

  /** Scrolls as little as needed to show a whole cell (or row, without a column). */
  reveal(rowIndex: number, column?: string): void {
    this.#current();
    const [top, left] = this.#revealed(
      rowIndex,
      column === undefined ? -1 : this.columnIndex(column),
    );
    this.#scroll(top, left);
  }

  /** The rows and columns in view, with `overscan` more rows and columns on each side. */
  visibleRange(overscan: { rows?: number; columns?: number } = {}): GridRange {
    const { rows = 10, columns = 2 } = overscan;
    const count = this.rowCount;
    const height = this.rowHeight;
    const top = this.#top;
    const clamp = (value: number, max: number) => Math.max(0, Math.min(max, value));
    const layout = this.#layout;
    // Columns between those held at the edges scroll, behind them.
    const pins = this.#pins;
    const [start, end] = [pins.left, layout.length - pins.right];
    // The first scrolling column whose `edge` is past `x`, by binary search.
    const first = (x: number, edge: (column: GridColumnLayout) => number) => {
      let [lo, hi] = [start, end];
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (edge(layout[mid]!) <= x) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    const left = this.#left + pins.leftWidth;
    const right = this.#left + this.#viewWidth - pins.rightWidth;
    const within = (index: number) => Math.max(start, Math.min(end, index));
    const columnStart = within(first(left, ({ x, width }) => x + width) - columns);
    return {
      rowStart: clamp(Math.floor(top / height) - rows, count),
      rowEnd: clamp(Math.ceil((top + this.#viewHeight) / height) + rows, count),
      columnStart,
      // Columns starting before the right edge show.
      columnEnd: Math.max(columnStart, within(first(right - 1e-6, ({ x }) => x) + columns)),
    };
  }

  // Focus

  /**
   * The focused cell, which keeps to its row as rows are sorted, appended,
   * and dropped. When the row leaves, the focus goes to the row taking its
   * place, or to the header row when none is left; when its group
   * collapses, to the group's header; when its column is hidden, to the
   * nearest shown column. At first it is the header's first cell; null
   * while no column is shown.
   */
  get focus(): GridFocus | null {
    this.#current();
    const layout = this.#layout;
    if (layout.length === 0) return null;
    const focus = this.#focus;
    if (!focus) return { rowIndex: -1, columnIndex: 0, column: layout[0]!.id };
    return { rowIndex: focus.rowIndex, columnIndex: focus.columnIndex, column: focus.column };
  }

  /** Focuses a cell (row -1 for the header row), scrolling it into view unless `reveal` is false. */
  focusCell(rowIndex: number, column: string, { reveal = true }: { reveal?: boolean } = {}): void {
    const count = this.rowCount;
    if (!(Number.isInteger(rowIndex) && rowIndex >= -1 && rowIndex < count))
      throw new RangeError(`Row ${rowIndex} is not among the grid's ${count} rows`);
    const columnIndex = this.columnIndex(column);
    if (columnIndex < 0) throw new Error(`No shown grid column "${column}"`);
    this.#focus = {
      row: rowIndex < 0 ? null : this.#refAt(rowIndex),
      rowIndex,
      column,
      columnIndex,
    };
    if (reveal) {
      const [top, left] = this.#revealed(rowIndex, columnIndex);
      this.#scroll(top, left, true);
    }
    this.#notify();
  }

  /**
   * Moves the focus as the keyboard does and scrolls it into view. Moving
   * between rows with `extend` (Shift) selects the rows from the anchor to
   * the new focus. In grouped grids, on a row's first cell, right expands a
   * collapsed group, left collapses an expanded one, and left from a group's
   * row goes to its header.
   */
  moveFocus(move: FocusMove, { extend = false }: { extend?: boolean } = {}): void {
    const focus = this.focus;
    if (!focus) return;
    if (focus.rowIndex >= 0 && focus.columnIndex === 0 && (move === "left" || move === "right")) {
      const display = this.#current();
      if (display.grouped) {
        const { group, position, rank } = this.#entry(focus.rowIndex);
        const expanded = display.grouped.open[group] === 1;
        if (position < 0 && expanded === (move === "left")) {
          this.setExpanded(display.grouped.groups.keyOf(group), !expanded);
          return;
        }
        if (position >= 0 && move === "left") {
          this.focusCell(display.grouped.starts[rank]!, focus.column);
          return;
        }
      }
    }
    const rows = this.rowCount;
    const columns = this.#layout.length;
    const page = Math.max(1, Math.floor(this.#viewHeight / this.rowHeight));
    let { rowIndex: row, columnIndex: column } = focus;
    if (move === "up") row = Math.max(-1, row - 1);
    else if (move === "down") row = Math.min(rows - 1, row + 1);
    else if (move === "left") column = Math.max(0, column - 1);
    else if (move === "right") column = Math.min(columns - 1, column + 1);
    else if (move === "pageUp") row = row < 0 ? -1 : Math.max(0, row - page);
    else if (move === "pageDown") row = Math.min(rows - 1, row + page);
    else if (move === "rowStart") column = 0;
    else if (move === "rowEnd") column = columns - 1;
    else if (move === "first") [row, column] = [-1, 0];
    else [row, column] = [rows - 1, columns - 1];
    // The first Shift move starts its range at the row it leaves.
    const from =
      extend && focus.rowIndex >= 0 && this.#anchorIndex() === null ? focus.rowIndex : -1;
    if (from >= 0) this.#selectionAnchor = this.#refAt(from);
    this.focusCell(row, this.#layout[column]!.id);
    // The header row is always in view; going to the grid's first cell goes to the top of its rows too.
    if (move === "first") this.#scroll(0, 0);
    if (extend && row >= 0 && this.#anchorIndex() !== null) this.select(row, "range");
  }

  // Selection

  /**
   * Whether the row at `rowIndex` is selected: in the channel's row set, or
   * meeting its condition. A group's header is when all its rows are.
   */
  isSelected(rowIndex: number): boolean {
    return this.selectionState(rowIndex) === "all";
  }

  /** How much of a row is selected; a group's header is partly when some of its rows are. */
  selectionState(rowIndex: number): SelectionState {
    const { group, position } = this.#entry(rowIndex);
    if (position >= 0) return this.#selected(position) ? "all" : "none";
    const selected = this.#groupCounts().counts[group]!;
    return selected === 0 ? "none" : selected >= this.#groups!.size(group) ? "all" : "some";
  }

  /**
   * Rows selected, counting those the view leaves out. A condition is
   * counted over the whole table, so ask after selecting, not every frame.
   */
  get selectedCount(): number {
    const selection = this.selection.get(this.channel);
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
   * the view shows, collapsed or not; toggling it clears them when all are
   * selected.
   */
  select(rowIndex: number, mode: SelectMode = "only"): void {
    const { group, position } = this.#entry(rowIndex);
    if (mode === "only" || mode === "toggle") {
      const only = mode === "only";
      const rows = only ? new RowSet(this.data.source) : this.#writable();
      let adjust: (counts: Float64Array) => void;
      if (position >= 0) {
        const removed = !only && rows.has(position);
        if (removed) rows.delete(position);
        else rows.add(position);
        adjust = (counts) => {
          if (only) counts.fill(0);
          if (group >= 0) counts[group]! += removed ? -1 : 1;
        };
      } else {
        const members = this.#groups!.members(group);
        const removed = !only && this.selectionState(rowIndex) === "all";
        if (removed) for (const member of members) rows.delete(member);
        else rows.addAll(members);
        adjust = (counts) => {
          if (only) counts.fill(0);
          counts[group] = removed ? 0 : members.length;
        };
      }
      this.#selectionAnchor = this.#refAt(rowIndex);
      this.#publish(rows, adjust);
      return;
    }
    let from = this.#anchorIndex();
    if (from === null) {
      from = rowIndex;
      this.#selectionAnchor = this.#refAt(rowIndex);
    }
    const rows = mode === "range" ? new RowSet(this.data.source) : this.#writable();
    const [start, end] = from <= rowIndex ? [from, rowIndex + 1] : [rowIndex, from + 1];
    this.#addRows(rows, start, end);
    this.#publish(rows, null);
  }

  /** Selects every row the view shows, those scrolled away or in collapsed groups too, as they are now. */
  selectAll(): void {
    const rows = new RowSet(this.data.source);
    const { snapshot } = this.#current();
    addRows(rows, snapshot, 0, snapshot.length);
    const groups = this.#groups;
    this.#publish(rows, (counts) => {
      for (let group = 0; group < counts.length; group++) counts[group] = groups!.size(group);
    });
  }

  /** Clears the channel and the range anchor; whether there was anything to clear. */
  clearSelection(): boolean {
    const had = this.selection.get(this.channel) !== null || this.#selectionAnchor !== null;
    this.#selectionAnchor = null;
    if (this.selection.get(this.channel) !== null) this.selection.set(this.channel, null);
    return had;
  }

  // Subscriptions

  /** Calls `listener` whenever what the grid shows may have changed; returns a function that stops it. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Stops following the view and the store. They, the groups, and the table stay the application's. */
  dispose(): void {
    this.#stop();
    followers.unregister(this);
    this.#listeners.clear();
    this.#condition = null;
    this.#count = null;
    this.#counts = null;
    this.#groupTexts = null;
  }

  #notify() {
    for (const listener of [...this.#listeners]) listener();
  }

  /** The view, its table, or the store changed. */
  #changed() {
    // Compiled conditions hold the table's arrays as they were.
    this.#condition = null;
    this.#count = null;
    this.#notify();
  }

  /** The column `id`, shown or hidden. */
  #column(id: string): Column<S> {
    const column = this.#columns.find((other) => other.id === id);
    if (!column) throw new Error(`No grid column "${id}"`);
    return column;
  }

  #replace(column: Column<S>, next: Column<S>) {
    this.#takeColumns(this.#columns.map((other) => (other === column ? next : other)));
  }

  /** Takes these as the columns, placed anew; what they show stays. */
  #takeColumns(columns: readonly Column<S>[]) {
    // The focus moves to the columns as they are now: catch up with the rows first.
    if (this.#display) this.#current();
    this.#columns = Object.freeze(columns.map((column) => Object.freeze(column) as Column<S>));
    this.#placeColumns();
    this.#left = this.#clampLeft(this.#left);
    this.#resolveFocus();
    this.#notify();
  }

  /** Places the shown columns, holding pinned ones at the edges if the viewport leaves room. */
  #placeColumns() {
    const layout = placeColumns(this.#columns, this.#contents, this.#viewWidth);
    this.#layout = Object.freeze(layout);
    const last = layout.at(-1);
    this.#width = last ? last.x + last.width : 0;
    const pins = { left: 0, right: 0, leftWidth: 0, rightWidth: 0 };
    while (pins.left < layout.length && layout[pins.left]!.pinned === "left")
      pins.leftWidth += layout[pins.left++]!.width;
    while (pins.right < layout.length && layout.at(-1 - pins.right)!.pinned === "right")
      pins.rightWidth += layout.at(-1 - pins.right++)!.width;
    this.#pins = pins;
  }

  /** The widest a column can be: pinned columns held at the edges leave the others room. */
  #widest(column: Column<S>): number {
    const pinned = pinnedWidth(this.#columns);
    const room = this.#viewWidth;
    if (column.pin === undefined || column.hidden || room <= 0 || !pinsHold(pinned, room))
      return Number.POSITIVE_INFINITY;
    return room - MIN_SCROLLING_WIDTH - (pinned - widthOf(column));
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

  /**
   * What the grid shows, catching up with changes since the last read: the
   * top row keeps its place when the table changed or groups were expanded
   * or collapsed, unless the query, the groups, or their order changed too
   * or the table was reset, and the focus finds its row again. Never
   * notifies: readers inside listeners must not cause more notifications.
   */
  #current(): Display {
    const view = this.data;
    const groups = this.#groups;
    // The groups' revision catches them up; the table's version too, since a
    // listener of the table that runs before the view's reads before the
    // view has been told.
    const revision = groups ? groups.revision : -1;
    const seen = this.#seen;
    if (
      this.#display &&
      view.revision === seen.revision &&
      view.source.version === seen.version &&
      revision === seen.groups &&
      this.#arrangement === seen.arrangement
    )
      return this.#display;
    const snapshot = view.read();
    const reset = snapshot.generation !== seen.generation;
    const requery = view.queryRevision !== seen.query || this.#structure !== seen.structure;
    const grouped = groups ? project(groups, this.#groupSort, (id) => this.#isOpen(id)) : null;
    this.#display = {
      snapshot,
      length: grouped ? grouped.starts[grouped.order.length]! : snapshot.length,
      grouped,
    };
    this.#seen = {
      revision: view.revision,
      version: view.source.version,
      query: view.queryRevision,
      generation: snapshot.generation,
      groups: revision,
      structure: this.#structure,
      arrangement: this.#arrangement,
    };
    const anchor = this.#anchor;
    if (anchor && !reset && !requery) {
      const index = this.#find(anchor.ref, true);
      if (index >= 0) this.#top = index * this.rowHeight + anchor.offset;
    }
    this.#top = this.#clampTop(this.#top);
    this.#resolveFocus();
    this.#remember();
    return this.#display;
  }

  #isOpen(id: string): boolean {
    return this.#expandedByDefault !== this.#toggled.has(id);
  }

  /** Forgets the expansion of groups gone once they outnumber those left, so streams of keys do not pile up. */
  #prune() {
    const groups = this.#groups;
    if (!groups || this.#toggled.size <= 64 + 2 * groups.length) return;
    const current = new Set<string>();
    for (let group = 0; group < groups.length; group++) current.add(groups.idOf(group));
    for (const id of this.#toggled) if (!current.has(id)) this.#toggled.delete(id);
  }

  /** Expansion changed: rows move, the focus leaves rows hidden, and listeners hear of it. */
  #rearrange() {
    this.#current();
    this.#arrangement++;
    this.#current();
    this.#notify();
  }

  #sortGroups(keys: readonly SortKey[]) {
    const table = this.#groups?.table;
    for (const { field } of keys)
      if (!table?.has(field)) throw new Error(`The groups have no field "${field}" to sort by`);
    this.#groupSort = Object.freeze(keys.map((key) => Object.freeze({ ...key })));
    this.#structure++;
    this.#arrangement++;
  }

  /** The row at `rowIndex`: its group and position, and where it is among the groups. */
  #entry(rowIndex: number): Entry {
    const { snapshot, grouped, length } = this.#current();
    if (!(Number.isInteger(rowIndex) && rowIndex >= 0 && rowIndex < length))
      throw new RangeError(`Row ${rowIndex} is not among the grid's ${length} rows`);
    if (!grouped) {
      const position = snapshot.indices ? snapshot.indices[rowIndex]! : rowIndex;
      return { group: -1, position, rank: -1, offset: 0 };
    }
    const place = placeOf(grouped, rowIndex);
    const group = grouped.order[place]!;
    const offset = rowIndex - grouped.starts[place]!;
    const position = offset === 0 ? -1 : grouped.groups.members(group)[offset - 1]!;
    return { group, position, rank: place, offset };
  }

  #scroll(top: number, left: number, quiet = false) {
    const [nextTop, nextLeft] = [this.#clampTop(top), this.#clampLeft(left)];
    const moved = nextTop !== this.#top || nextLeft !== this.#left;
    this.#top = nextTop;
    this.#left = nextLeft;
    this.#remember();
    if (moved && !quiet) this.#notify();
  }

  #clampTop(top: number): number {
    const max = this.#display!.length * this.rowHeight - this.#viewHeight;
    return Math.max(0, Math.min(max, top));
  }

  #clampLeft(left: number): number {
    return Math.max(0, Math.min(this.#width - this.#viewWidth, left));
  }

  /** The offsets showing a whole cell, scrolled as little as possible. */
  #revealed(rowIndex: number, columnIndex: number): [number, number] {
    let [top, left] = [this.#top, this.#left];
    if (rowIndex >= 0) {
      const y = rowIndex * this.rowHeight;
      if (y < top) top = y;
      else if (y + this.rowHeight > top + this.#viewHeight)
        top = y + this.rowHeight - this.#viewHeight;
    }
    // Columns held at the edges are always in view; the others scroll between them.
    const column = this.#layout[columnIndex];
    if (column && column.pinned === null) {
      const { leftWidth, rightWidth } = this.#pins;
      if (column.x - leftWidth < left) left = column.x - leftWidth;
      else if (column.x + column.width > left + this.#viewWidth - rightWidth)
        left = column.x + column.width - this.#viewWidth + rightWidth;
    }
    return [top, left];
  }

  /** Remembers the row at the top, to keep it there. */
  #remember() {
    const { length } = this.#display!;
    if (length === 0) {
      this.#anchor = null;
      return;
    }
    const index = Math.min(length - 1, Math.floor(this.#top / this.rowHeight));
    this.#anchor = { ref: this.#refAt(index), offset: this.#top - index * this.rowHeight };
  }

  /** What follows the row at `rowIndex`: its identity, or its group's key. */
  #refAt(rowIndex: number): Ref {
    const { snapshot, grouped } = this.#display!;
    const { group, position } = this.#entry(rowIndex);
    if (position >= 0)
      return { identity: snapshot.rowOffset + position, generation: snapshot.generation };
    const groups = grouped!.groups;
    return { id: groups.idOf(group), key: groups.keyOf(group), groups };
  }

  /**
   * Where a row or group is now, or -1 when it left (or the table was reset
   * since). A row of a collapsed group is at its group's header with
   * `collapsed`, and nowhere without.
   */
  #find(ref: Ref, collapsed: boolean): number {
    const { snapshot, grouped } = this.#display!;
    if ("id" in ref) {
      if (!grouped || ref.groups !== grouped.groups) return -1;
      const group = grouped.groups.indexOf(ref.key);
      return group < 0 ? -1 : grouped.starts[grouped.rank[group]!]!;
    }
    if (ref.generation !== snapshot.generation) return -1;
    const position = ref.identity - snapshot.rowOffset;
    if (!grouped) return this.data.indexOf(position);
    const { groups, starts, rank, open } = grouped;
    const group = groups.groupOf(position);
    if (group < 0) return -1;
    const header = starts[rank[group]!]!;
    if (!open[group]) return collapsed ? header : -1;
    const index = groups.memberIndex(position);
    return index < 0 ? -1 : header + 1 + index;
  }

  #anchorIndex(): number | null {
    const anchor = this.#selectionAnchor;
    const index = anchor ? this.#find(anchor, true) : -1;
    return index < 0 ? null : index;
  }

  #resolveFocus() {
    const focus = this.#focus;
    if (!focus || !this.#display) return;
    const layout = this.#layout;
    if (layout.length > 0) {
      let index = layout.findIndex(({ id }) => id === focus.column);
      if (index < 0) index = Math.min(focus.columnIndex, layout.length - 1);
      focus.columnIndex = index;
      focus.column = layout[index]!.id;
    }
    if (!focus.row) return;
    const length = this.#display.length;
    let index = this.#find(focus.row, true);
    if (index < 0 && length > 0) index = Math.min(focus.rowIndex, length - 1);
    focus.rowIndex = index;
    focus.row = index < 0 ? null : this.#refAt(index);
  }

  /** Whether the table's row at `position` is selected. */
  #selected(position: number): boolean {
    const selection = this.selection.get(this.channel);
    if (!selection) return false;
    if (selection.kind === "rows") return selection.rows.has(position);
    return this.#test(selection.expression)(position);
  }

  /** What each column shows on a group's header row. */
  #textsOfGroups(): ((group: number) => string)[] {
    const groups = this.#groups!;
    const layout = this.#layout;
    const cached = this.#groupTexts;
    if (cached?.layout === layout && cached.groups === groups) return cached.texts;
    const texts = headerTexts(groups, layout, this.#settings, this.#table);
    this.#groupTexts = { layout, groups, texts };
    return texts;
  }

  /** Selected rows per group, counted once per change of the selection or of the groups' rows. */
  #groupCounts(): SelectedCounts {
    const groups = this.#groups!;
    this.#current();
    const selection = this.selection.get(this.channel) as DataSelection | null;
    const revision = this.selection.revision;
    const view = this.data as unknown as RowView;
    const cached = this.#counts;
    if (cached && countsHold(cached, groups, revision, selection, view)) {
      // Groups started by appended rows have none selected yet.
      if (cached.counts.length < groups.length) {
        const counts = new Float64Array(groups.length);
        counts.set(cached.counts);
        this.#counts = { ...cached, counts };
      }
      return this.#counts!;
    }
    const test = selection?.kind === "predicate" ? this.#test(selection.expression) : () => false;
    this.#counts = countSelected(groups, selection, revision, test, view);
    return this.#counts;
  }

  /** Adds the rows from row index `start` to `end`: a group's header adds every row of its group. */
  #addRows(rows: RowSet<S>, start: number, end: number) {
    const { snapshot, grouped } = this.#current();
    if (!grouped) {
      addRows(rows, snapshot, start, end);
      return;
    }
    const { starts, order, open, groups } = grouped;
    for (let place = this.#entry(start).rank; place < order.length; place++) {
      const header = starts[place]!;
      if (header >= end) break;
      const group = order[place]!;
      const members = groups.members(group);
      if (header >= start) rows.addAll(members);
      else if (open[group])
        rows.addAll(
          members.subarray(start - header - 1, Math.min(members.length, end - header - 1)),
        );
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
    const current = this.selection.get(this.channel);
    const published = this.#published;
    if (
      published &&
      current?.kind === "rows" &&
      current.rows === published.rows &&
      published.rows.current &&
      this.selection.revision === published.revision
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
  #publish(rows: RowSet<S>, adjust: ((counts: Float64Array) => void) | null) {
    const store = this.selection;
    const groups = this.#groups;
    const before = this.#counts;
    const view = this.data as unknown as RowView;
    const current = store.get(this.channel) as DataSelection | null;
    let after: SelectedCounts | null = null;
    if (groups && adjust && before && countsHold(before, groups, store.revision, current, view)) {
      const counts = new Float64Array(groups.length);
      counts.set(before.counts);
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

/** Sort keys after a header click on `field`: going to `order`, or off without one. */
function cycled<F extends string>(
  keys: readonly SortKey<F>[],
  field: F | undefined,
  order: "ascending" | "descending" | undefined,
  additive: boolean,
): SortKey<F>[] {
  if (!additive) return order && field !== undefined ? [{ field, order }] : [];
  const next = [...keys];
  if (field === undefined) return next;
  const at = next.findIndex((key) => key.field === field);
  if (at < 0) {
    if (order) next.push({ field, order });
  } else if (order) next[at] = { field, order };
  else next.splice(at, 1);
  return next;
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
