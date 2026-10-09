// A grid's state without a DOM, imported as `herceg/grid/model`: the columns
// it shows, the rows of a row view, where it is scrolled, which cell has the
// focus, and which rows are selected. A renderer (dom/grid.ts) draws it and
// turns keys and clicks into its commands; applications call the same
// commands. One model serves one grid: grids showing the same rows share
// the view and the selection store, each with a model of its own.

import { compileExpression, type Expression } from "../data/expression.ts";
import type { SortKey } from "../data/order.ts";
import { RowSet } from "../data/row-set.ts";
import type { RowSnapshot, RowView } from "../data/row-view.ts";
import { type SelectionStore, selectionStore, selectRows } from "../data/selection.ts";
import type { PositionField, Schema, Table } from "../data/table.ts";
import type { TimeZone } from "../format/zone.ts";
import {
  type GridColumn,
  type GridColumnLayout,
  type PlacedColumn,
  placeColumns,
} from "./columns.ts";

export type { GridColumn, GridColumnLayout } from "./columns.ts";

export interface GridModelOptions<S extends Schema = Schema> {
  /** The rows to show, in order. The application owns the view; the grid sorts through it. */
  data: RowView<S>;
  columns: readonly GridColumn<S>[];
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

/** Rows `[rowStart, rowEnd)` and shown columns `[columnStart, columnEnd)`. */
export interface GridRange {
  readonly rowStart: number;
  readonly rowEnd: number;
  readonly columnStart: number;
  readonly columnEnd: number;
}

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
 * and click), or those added (both).
 */
export type SelectMode = "only" | "toggle" | "range" | "addRange";

/** A row followed by identity: `rowOffset + position` in its table's generation. */
interface Identity {
  identity: number;
  generation: number;
}

interface Focus {
  /** The focused body row; null for the header row. */
  row: Identity | null;
  /** Where the row was, for when it leaves. */
  rowIndex: number;
  column: string;
  columnIndex: number;
}

const ROW_HEIGHT = 28;

/**
 * The state of one grid over a row view. Every read brings it up to date
 * with its view, its table, and its selection store; listeners are told
 * synchronously when any of them, or the model's own state, changes.
 */
export class GridModel<S extends Schema = Schema> {
  readonly data: RowView<S>;
  readonly selection: SelectionStore<S>;
  readonly channel: string;
  readonly rowHeight: number;
  readonly #table: Table;
  readonly #settings: { locale: string | undefined; timeZone: TimeZone; missing: string };
  #columns: readonly GridColumn<S>[] = [];
  #layout: readonly PlacedColumn[] = [];
  #width = 0;

  /** The view's rows as of its revision and its table's version in `#seen`. */
  #snapshot: RowSnapshot | undefined;
  #seen = { revision: -1, version: -1, query: -1, generation: -1 };

  #viewWidth = 0;
  #viewHeight = 0;
  #top = 0;
  #left = 0;
  /** The row at the top and how far it is scrolled past, kept in place as rows come and go. */
  #anchor: (Identity & { offset: number }) | null = null;

  #focus: Focus | null = null;
  /** Where Shift ranges start. */
  #selectionAnchor: Identity | null = null;
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

  /** Every column, shown or hidden, in order, with its id. */
  get columns(): readonly GridColumn<S>[] {
    return this.#columns;
  }

  /** The shown columns, placed side by side. */
  get columnLayout(): readonly GridColumnLayout[] {
    return this.#layout;
  }

  /** Width of the shown columns together, in CSS pixels. */
  get width(): number {
    return this.#width;
  }

  /** Replaces the columns: their order, widths, formats, and which are hidden. */
  setColumns(columns: readonly GridColumn<S>[]): void {
    const layout = placeColumns(this.#table, columns as readonly GridColumn[], this.#settings);
    // The focus moves to the columns as they are now: catch up with the rows first.
    if (this.#snapshot) this.#current();
    this.#columns = Object.freeze(
      columns.map((column) => Object.freeze({ ...column, id: column.id ?? column.field })),
    ) as readonly GridColumn<S>[];
    this.#layout = Object.freeze(layout);
    const last = layout.at(-1);
    this.#width = last ? last.x + last.width : 0;
    this.#left = this.#clampLeft(this.#left);
    this.#resolveFocus();
    this.#notify();
  }

  /** Index of the shown column `id`, or -1. */
  columnIndex(id: string): number {
    return this.#layout.findIndex((column) => column.id === id);
  }

  // Rows

  get rowCount(): number {
    return this.#current().length;
  }

  /** Height of every row together, in CSS pixels. */
  get contentHeight(): number {
    return this.rowCount * this.rowHeight;
  }

  /** The table position of the row at `rowIndex` in the view. */
  rowAt(rowIndex: number): number {
    const { indices, length } = this.#current();
    if (!(Number.isInteger(rowIndex) && rowIndex >= 0 && rowIndex < length))
      throw new RangeError(`Row ${rowIndex} is not among the grid's ${length} rows`);
    return indices ? indices[rowIndex]! : rowIndex;
  }

  /**
   * The row's identity, `rowOffset + position`, which stays its own as rows
   * are appended and dropped, until the table resets.
   */
  identityAt(rowIndex: number): number {
    return this.rowAt(rowIndex) + this.#current().rowOffset;
  }

  /** Where the row of this identity shows now, or -1 when the view leaves it out. */
  rowIndexOf(identity: number): number {
    const { generation } = this.#current();
    return this.#indexOf({ identity, generation });
  }

  /** The text of a cell: row `rowIndex` of the view, shown column `columnIndex`. */
  textAt(rowIndex: number, columnIndex: number): string {
    const column = this.#layout[columnIndex];
    if (!column) throw new RangeError(`Column ${columnIndex} is not shown`);
    return column.text(this.#table, this.rowAt(rowIndex));
  }

  // Sorting

  get sort(): readonly SortKey<PositionField<S>>[] {
    return this.data.query.sort ?? [];
  }

  /** Sorts the view by these keys, keeping its filter. */
  setSort(keys: readonly SortKey<PositionField<S>>[]): void {
    this.data.setQuery({ ...this.data.query, sort: keys });
  }

  /**
   * Sorts by a column's field as a header click does: ascending, then
   * descending, then not at all. Plain, the field becomes the only key;
   * additive (Shift and click), the other keys stay and a new field goes last.
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
    let sort: SortKey<PositionField<S>>[];
    if (!additive) sort = order ? [{ field, order }] : [];
    else {
      sort = [...keys];
      if (at < 0) sort.push({ field, order: "ascending" });
      else if (order) sort[at] = { field, order };
      else sort.splice(at, 1);
    }
    this.setSort(sort);
  }

  // Viewport

  /** Sets the size of the area rows show in (below the header), in CSS pixels. */
  setViewport(width: number, height: number): void {
    if (width === this.#viewWidth && height === this.#viewHeight) return;
    this.#viewWidth = Math.max(0, width);
    this.#viewHeight = Math.max(0, height);
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
    // The first column whose `edge` is past `x`, by binary search.
    const first = (x: number, edge: (column: GridColumnLayout) => number) => {
      let [lo, hi] = [0, layout.length];
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (edge(layout[mid]!) <= x) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    const left = this.#left;
    const right = left + this.#viewWidth;
    return {
      rowStart: clamp(Math.floor(top / height) - rows, count),
      rowEnd: clamp(Math.ceil((top + this.#viewHeight) / height) + rows, count),
      columnStart: clamp(first(left, ({ x, width }) => x + width) - columns, layout.length),
      // Columns starting before the right edge show.
      columnEnd: clamp(first(right - 1e-6, ({ x }) => x) + columns, layout.length),
    };
  }

  // Focus

  /**
   * The focused cell, which keeps to its row as rows are sorted, appended,
   * and dropped. When the row leaves, the focus goes to the row taking its
   * place, or to the header row when none is left; when its column is
   * hidden, to the nearest shown column. At first it is the header's first
   * cell; null while no column is shown.
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
      row: rowIndex < 0 ? null : this.#identity(rowIndex),
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
   * the new focus.
   */
  moveFocus(move: FocusMove, { extend = false }: { extend?: boolean } = {}): void {
    const focus = this.focus;
    if (!focus) return;
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
    if (from >= 0) this.#selectionAnchor = this.#identity(from);
    this.focusCell(row, this.#layout[column]!.id);
    // The header row is always in view; going to the grid's first cell goes to the top of its rows too.
    if (move === "first") this.#scroll(0, 0);
    if (extend && row >= 0 && this.#anchorIndex() !== null) this.select(row, "range");
  }

  // Selection

  /** Whether the row at `rowIndex` is selected: in the channel's row set, or meeting its condition. */
  isSelected(rowIndex: number): boolean {
    const position = this.rowAt(rowIndex);
    const selection = this.selection.get(this.channel);
    if (!selection) return false;
    if (selection.kind === "rows") return selection.rows.has(position);
    return this.#test(selection.expression)(position);
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

  /** Selects as clicks do (see `SelectMode`); the selection is a row set in the channel. */
  select(rowIndex: number, mode: SelectMode = "only"): void {
    const position = this.rowAt(rowIndex);
    if (mode === "only" || mode === "toggle") {
      const rows = mode === "only" ? new RowSet(this.data.source) : this.#writable();
      if (mode === "toggle" && rows.has(position)) rows.delete(position);
      else rows.add(position);
      this.#selectionAnchor = this.#identity(rowIndex);
      this.#publish(rows);
      return;
    }
    let from = this.#anchorIndex();
    if (from === null) {
      from = rowIndex;
      this.#selectionAnchor = this.#identity(rowIndex);
    }
    const rows = mode === "range" ? new RowSet(this.data.source) : this.#writable();
    const [start, end] = from <= rowIndex ? [from, rowIndex + 1] : [rowIndex, from + 1];
    addRows(rows, this.#current(), start, end);
    this.#publish(rows);
  }

  /** Selects every row the view shows, those scrolled away too, as they are now. */
  selectAll(): void {
    const rows = new RowSet(this.data.source);
    const snapshot = this.#current();
    addRows(rows, snapshot, 0, snapshot.length);
    this.#publish(rows);
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

  /** Stops following the view and the store. They, and the table, stay the application's. */
  dispose(): void {
    this.#stop();
    followers.unregister(this);
    this.#listeners.clear();
    this.#condition = null;
    this.#count = null;
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

  /**
   * The view's rows, catching up with changes since the last read: the top
   * row keeps its place when the table changed, unless the query changed
   * too or the table was reset, and the focus finds its row again. Never
   * notifies: readers inside listeners must not cause more notifications.
   */
  #current(): RowSnapshot {
    const view = this.data;
    // The table's version too: a listener of the table that runs before the
    // view's reads before the view has been told.
    const seen = this.#seen;
    if (this.#snapshot && view.revision === seen.revision && view.source.version === seen.version)
      return this.#snapshot;
    const snapshot = view.read();
    const reset = snapshot.generation !== this.#seen.generation;
    const requery = view.queryRevision !== this.#seen.query;
    this.#snapshot = snapshot;
    this.#seen = {
      revision: view.revision,
      version: view.source.version,
      query: view.queryRevision,
      generation: snapshot.generation,
    };
    const anchor = this.#anchor;
    if (anchor && !reset && !requery) {
      const index = this.#indexOf(anchor);
      if (index >= 0) this.#top = index * this.rowHeight + anchor.offset;
    }
    this.#top = this.#clampTop(this.#top);
    this.#resolveFocus();
    this.#remember();
    return snapshot;
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
    const max = this.#snapshot!.length * this.rowHeight - this.#viewHeight;
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
    const column = this.#layout[columnIndex];
    if (column) {
      if (column.x < left) left = column.x;
      else if (column.x + column.width > left + this.#viewWidth)
        left = column.x + column.width - this.#viewWidth;
    }
    return [top, left];
  }

  /** Remembers the row at the top, to keep it there. */
  #remember() {
    const { length } = this.#snapshot!;
    if (length === 0) {
      this.#anchor = null;
      return;
    }
    const index = Math.min(length - 1, Math.floor(this.#top / this.rowHeight));
    this.#anchor = { ...this.#identity(index), offset: this.#top - index * this.rowHeight };
  }

  #identity(rowIndex: number): Identity {
    const snapshot = this.#snapshot!;
    const position = snapshot.indices ? snapshot.indices[rowIndex]! : rowIndex;
    return { identity: snapshot.rowOffset + position, generation: snapshot.generation };
  }

  /** Where a row is now, or -1 when it left (or the table was reset since). */
  #indexOf({ identity, generation }: Identity): number {
    const snapshot = this.#snapshot!;
    if (generation !== snapshot.generation) return -1;
    return this.data.indexOf(identity - snapshot.rowOffset);
  }

  #anchorIndex(): number | null {
    const anchor = this.#selectionAnchor;
    const index = anchor ? this.#indexOf(anchor) : -1;
    return index < 0 ? null : index;
  }

  #resolveFocus() {
    const focus = this.#focus;
    if (!focus || !this.#snapshot) return;
    const layout = this.#layout;
    if (layout.length > 0) {
      let index = layout.findIndex(({ id }) => id === focus.column);
      if (index < 0) index = Math.min(focus.columnIndex, layout.length - 1);
      focus.columnIndex = index;
      focus.column = layout[index]!.id;
    }
    if (!focus.row) return;
    const length = this.#snapshot.length;
    let index = this.#indexOf(focus.row);
    if (index < 0 && length > 0) index = Math.min(focus.rowIndex, length - 1);
    focus.rowIndex = index;
    focus.row = index < 0 ? null : this.#identity(index);
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

  #publish(rows: RowSet<S>) {
    this.selection.set(this.channel, selectRows(rows));
    this.#published = { rows, revision: this.selection.revision };
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
