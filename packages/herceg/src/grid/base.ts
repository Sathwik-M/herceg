// What every grid model shares, whether its rows are a local row view's
// (model.ts) or a remote source's (remote.ts): the columns it shows (their
// order, widths, pins, and which are hidden), where it is scrolled and which
// row it keeps at the top, the focused cell, and its listeners. What the rows
// are, and how they are found again, read, sorted, expanded, and selected, is
// each model's own, behind the few methods this class calls. The DOM grid
// (dom/grid.ts) draws any of them.

import type { GroupKey } from "../data/groups.ts";
import type { SortKey } from "../data/order.ts";
import type { Schema } from "../data/table.ts";
import type { TimeZone } from "../format/zone.ts";
import {
  type ColumnContent,
  type FormatSettings,
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

/** Options every grid model takes. */
export interface GridSettings {
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
 * Names a row of a grid while it is shown, however rows around it come and
 * go: equal `scope` and `id` are the same row. `indexOf` finds it again.
 */
export interface GridRef {
  readonly scope: unknown;
  readonly id: string | number;
}

/**
 * What renderers read of a row: a record, a group's header, or (in remote
 * grids) a placeholder for a row still loading. `version` changes when what
 * the row shows may have; a set size of -1 is unknown.
 */
export type ShownRow =
  | {
      readonly kind: "row";
      readonly ref: GridRef;
      readonly version: number;
      readonly level: number;
      readonly setIndex: number;
      readonly setSize: number;
    }
  | {
      readonly kind: "placeholder";
      readonly ref: GridRef;
      readonly version: number;
      readonly level: number;
      readonly setIndex: number;
      readonly setSize: number;
      /** How far its first cell is indented: as the group's header or row it stands for. */
      readonly indent: number;
    }
  | {
      readonly kind: "group";
      readonly ref: GridRef;
      readonly version: number;
      readonly key: GroupKey;
      readonly expanded: boolean;
      readonly level: number;
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
 * What a model shows as of one state of its rows: how many, and whether
 * the row at the top keeps its place since the last (not after a new
 * query, which keeps the pixel offset).
 */
export interface GridDisplay {
  readonly length: number;
  readonly keep: boolean;
}

/** A column as models keep it: with its id. */
export type Column<S extends Schema = Schema> = GridColumn<S> & { readonly id: string };

interface Focus {
  /** The focused body row; null for the header row. */
  row: GridRef | null;
  /** Where the row was, for when it leaves. */
  rowIndex: number;
  column: string;
  columnIndex: number;
}

const ROW_HEIGHT = 28;

/**
 * The state every grid model has: columns, viewport, scrolling, and focus,
 * over rows the subclass provides. Every read brings it up to date with its
 * rows; listeners are told synchronously when the rows or the model's own
 * state change.
 */
export abstract class BaseGridModel<S extends Schema = Schema> {
  readonly rowHeight: number;
  protected readonly settings: FormatSettings;
  /** The columns, shown or hidden, in order: the one record of their layout. */
  #columns: readonly Column<S>[] = [];
  /** What each column shows, by id, made when the columns are set. */
  #contents = new Map<string, ColumnContent>();
  #layout: readonly PlacedColumn[] = [];
  #width = 0;
  /** How many shown columns are held at each edge, and how wide they are. */
  #pins = { left: 0, right: 0, leftWidth: 0, rightWidth: 0 };

  #display: GridDisplay | undefined;
  #viewWidth = 0;
  #viewHeight = 0;
  #top = 0;
  #left = 0;
  /** The row at the top and how far it is scrolled past, kept in place as rows come and go. */
  #anchor: { ref: GridRef; offset: number } | null = null;
  #focus: Focus | null = null;
  /** Where Shift ranges start. */
  protected rangeAnchor: GridRef | null = null;
  readonly #listeners = new Set<() => void>();
  #batching = 0;
  #notified = false;

  constructor(options: GridSettings) {
    this.rowHeight = options.rowHeight ?? ROW_HEIGHT;
    if (!(Number.isFinite(this.rowHeight) && this.rowHeight > 0))
      throw new RangeError(`A grid's rowHeight must be positive, not ${this.rowHeight}`);
    this.settings = {
      locale: options.locale,
      timeZone: options.timeZone ?? "local",
      missing: options.missing ?? "",
    };
  }

  // Columns

  /**
   * Every column, shown or hidden, in order, with its id: their layout as
   * resizing, moving, pinning, and hiding left it, which `setColumns` takes
   * back.
   */
  get columns(): readonly GridColumn<S>[] {
    this.generated();
    return this.#columns;
  }

  /** The shown columns, placed side by side: pinned left, the others, pinned right. */
  get columnLayout(): readonly GridColumnLayout[] {
    this.generated();
    return this.#layout;
  }

  /** Width of the shown columns together, in CSS pixels. */
  get width(): number {
    this.generated();
    return this.#width;
  }

  /** The columns as they are, generated ones not caught up: for models generating them. */
  protected get columnList(): readonly Column<S>[] {
    return this.#columns;
  }

  /** Replaces the columns: their order, widths, pins, formats, aggregates, and which are hidden. */
  abstract setColumns(columns: readonly GridColumn<S>[]): void;

  /**
   * Sets a column's width, in CSS pixels, no narrower than
   * `MIN_COLUMN_WIDTH`. A pinned column held at its edge widens only as far
   * as the pinned columns leave the others `MIN_SCROLLING_WIDTH`.
   */
  resizeColumn(id: string, width: number): void {
    const column = this.column(id);
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
    const column = this.column(id);
    if (before !== null) this.column(before);
    if (before === id) return;
    const rest = this.#columns.filter((other) => other !== column);
    const at = before === null ? rest.length : rest.findIndex((other) => other.id === before);
    if (this.#columns[at] === column) return;
    rest.splice(at, 0, column);
    this.takeColumns(rest);
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
    const column = this.column(id);
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
    const column = this.column(id);
    if (column.pin !== undefined || column.hidden) return true;
    return pinsHold(pinnedWidth(this.#columns) + widthOf(column), this.#viewWidth);
  }

  /** Shows or hides a column. The focus on a column hidden goes to the nearest shown one. */
  setColumnVisible(id: string, visible: boolean): void {
    const column = this.column(id);
    if (!column.hidden === visible) return;
    const { hidden: _, ...rest } = column;
    this.#replace(column, (visible ? rest : { ...rest, hidden: true }) as Column<S>);
  }

  /** Index of the shown column `id`, or -1. */
  columnIndex(id: string): number {
    this.generated();
    return this.#layout.findIndex((column) => column.id === id);
  }

  // Rows

  get rowCount(): number {
    return this.current().length;
  }

  /** Height of every row together, in CSS pixels. */
  get contentHeight(): number {
    return this.rowCount * this.rowHeight;
  }

  /** Whether the rows are grouped, each group's header followed by its groups or rows: a tree. */
  abstract get grouped(): boolean;

  /** What the row at `rowIndex` shows. */
  abstract row(rowIndex: number): ShownRow;

  /** The text of a cell: row `rowIndex`, shown column `columnIndex`. */
  abstract textAt(rowIndex: number, columnIndex: number): string;

  /** Where the row a ref names shows now, or -1 when the grid no longer shows it. */
  indexOf(ref: GridRef): number {
    this.current();
    return this.find(ref, false);
  }

  // Sorting and groups

  abstract get sort(): readonly SortKey[];

  /**
   * Sorts by a column's field as a header click does: ascending, then
   * descending, then not at all; additive (Shift and click), the other keys
   * stay and a new field goes last.
   */
  abstract cycleSort(column: string, options?: { additive?: boolean }): void;

  /** Whether the group with this key path shows its groups below, or its rows. */
  abstract isExpanded(key: GroupKey): boolean;

  /** Shows or hides the groups below, or the rows, of the group with this key path. */
  abstract setExpanded(key: GroupKey, expanded: boolean): void;

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
    this.current();
    this.#scroll(this.#top, this.#left, true);
    this.notify();
  }

  get viewportWidth(): number {
    return this.#viewWidth;
  }

  get viewportHeight(): number {
    return this.#viewHeight;
  }

  /** How far the rows are scrolled, in CSS pixels; rows keep their place as the view changes. */
  get top(): number {
    this.current();
    return this.#top;
  }

  get left(): number {
    return this.#left;
  }

  /** Scrolls to these offsets, kept within the rows and columns. */
  scrollTo({ top, left }: { top?: number; left?: number }): void {
    // Offsets left out are the current ones once rows have caught up (and been anchored).
    this.current();
    this.#scroll(top ?? this.#top, left ?? this.#left);
  }

  /** Scrolls as little as needed to show a whole cell (or row, without a column). */
  reveal(rowIndex: number, column?: string): void {
    this.current();
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
   * The focused cell, which keeps to its row as rows move. When the row
   * leaves, the focus goes to the row taking its place, or to the header row
   * when none is left; when its group collapses, to the group's header; when
   * its column is hidden, to the nearest shown column. At first it is the
   * header's first cell; null while no column is shown.
   */
  get focus(): GridFocus | null {
    this.current();
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
      row: rowIndex < 0 ? null : this.refAt(rowIndex),
      rowIndex,
      column,
      columnIndex,
    };
    if (reveal) {
      const [top, left] = this.#revealed(rowIndex, columnIndex);
      this.#scroll(top, left, true);
    }
    this.notify();
  }

  /**
   * Moves the focus as the keyboard does and scrolls it into view. Moving
   * between rows with `extend` (Shift) selects the rows from the anchor to
   * the new focus. In grouped grids, on a row's first cell, right expands a
   * collapsed group, left collapses an expanded one, and left from a
   * collapsed group or a group's row goes to the group holding it.
   */
  moveFocus(move: FocusMove, { extend = false }: { extend?: boolean } = {}): void {
    // Listeners hear once the focus, the scroll, and a range are all in place.
    this.#batch(() => this.#moveFocus(move, extend));
  }

  #moveFocus(move: FocusMove, extend: boolean) {
    const focus = this.focus;
    if (!focus) return;
    if (
      focus.rowIndex >= 0 &&
      focus.columnIndex === 0 &&
      (move === "left" || move === "right") &&
      this.moveInTree(focus, move === "left")
    )
      return;
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
      extend && focus.rowIndex >= 0 && this.rangeAnchorIndex() === null ? focus.rowIndex : -1;
    if (from >= 0) this.rangeAnchor = this.refAt(from);
    this.focusCell(row, this.#layout[column]!.id);
    // The header row is always in view; going to the grid's first cell goes to the top of its rows too.
    if (move === "first") this.#scroll(0, 0);
    if (extend && row >= 0 && this.rangeAnchorIndex() !== null) this.select(row, "range");
  }

  // Selection

  /** Whether the row at `rowIndex` is selected; a group's header when all its rows are. */
  isSelected(rowIndex: number): boolean {
    return this.selectionState(rowIndex) === "all";
  }

  /** How much of a row is selected; a group's header is partly when some of its rows are. */
  abstract selectionState(rowIndex: number): SelectionState;

  /** Rows selected; null when a condition selects them that the grid cannot count. */
  abstract get selectedCount(): number | null;

  /** Increments whenever the selection changes. */
  abstract get selectionRevision(): number;

  /** Selects as clicks do (see `SelectMode`). */
  abstract select(rowIndex: number, mode?: SelectMode): void;

  /** Selects every row the grid shows, those scrolled away or in collapsed groups too. */
  abstract selectAll(): void;

  /** Clears the selection and the range anchor; whether there was anything to clear. */
  abstract clearSelection(): boolean;

  // Subscriptions

  /** Calls `listener` whenever what the grid shows may have changed; returns a function that stops it. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Stops listeners; models stop following what they show too. */
  dispose(): void {
    this.#listeners.clear();
  }

  protected notify() {
    if (this.#batching > 0) this.#notified = true;
    else for (const listener of [...this.#listeners]) listener();
  }

  /** Runs a command whose steps notify, telling listeners once, when it is done. */
  #batch(command: () => void) {
    this.#batching++;
    try {
      command();
    } finally {
      if (--this.#batching === 0 && this.#notified) {
        this.#notified = false;
        this.notify();
      }
    }
  }

  // For models

  /**
   * Brings the rows up to date: the display as it is now, the same object
   * when nothing changed since `previous`. Never notifies.
   */
  protected abstract catchUp(previous: GridDisplay | undefined): GridDisplay;

  /** What follows the row at `rowIndex` as rows move. */
  protected abstract refAt(rowIndex: number): GridRef;

  /**
   * Where a row is now, or -1 when it left. A row hidden by a collapsed
   * group above it is at that group's header with `collapsed`, and nowhere
   * without.
   */
  protected abstract find(ref: GridRef, collapsed: boolean): number;

  /**
   * In grouped grids, what Left (`left`) or Right does on a row's first
   * cell: expand or collapse its group, or go to the group holding it.
   * Whether it did anything.
   */
  protected moveInTree(_focus: GridFocus, _left: boolean): boolean {
    return false;
  }

  /** Brings generated columns up to date before they are read (a pivot's); none by default. */
  protected generated(): void {}

  /**
   * What the grid shows, catching up with changes since the last read: the
   * top row keeps its place unless the display says otherwise, and the
   * focus finds its row again. Never notifies: readers inside listeners
   * must not cause more notifications.
   */
  protected current(): GridDisplay {
    const previous = this.#display;
    const display = this.catchUp(previous);
    if (display === previous) return display;
    this.#display = display;
    const anchor = this.#anchor;
    if (anchor && display.keep) {
      const index = this.find(anchor.ref, true);
      if (index >= 0) this.#top = index * this.rowHeight + anchor.offset;
    }
    this.#top = this.#clampTop(this.#top);
    this.#resolveFocus();
    this.#remember();
    return display;
  }

  /** The column `id`, shown or hidden. */
  protected column(id: string): Column<S> {
    this.generated();
    const column = this.#columns.find((other) => other.id === id);
    if (!column) throw new Error(`No grid column "${id}"`);
    return column;
  }

  /** Takes these as the columns (with what they show, when given), placed anew. */
  protected takeColumns(columns: readonly Column<S>[], contents?: Map<string, ColumnContent>) {
    if (contents) this.#contents = contents;
    // The focus moves to the columns as they are now: catch up with the rows first.
    if (this.#display) this.current();
    this.#columns = Object.freeze(columns.map((column) => Object.freeze(column) as Column<S>));
    this.#placeColumns();
    this.#left = this.#clampLeft(this.#left);
    this.#resolveFocus();
    this.notify();
  }

  /**
   * Takes columns generated again while catching up (a pivot's): the first
   * scrolling column in view stays where it was on the screen.
   */
  protected regenerate(columns: readonly Column<S>[], contents: Map<string, ColumnContent>) {
    const left = this.#left;
    const anchor = this.#layout.find(
      ({ x, width, pinned }) => pinned === null && x + width > left + this.#pins.leftWidth,
    );
    this.#contents = contents;
    this.#columns = Object.freeze(columns.map((column) => Object.freeze(column) as Column<S>));
    this.#placeColumns();
    const moved = anchor && this.#layout.find(({ id }) => id === anchor.id);
    this.#left = this.#clampLeft(moved ? moved.x - anchor.x + left : left);
  }

  /** The row index of the range anchor, or null when there is none or it left. */
  protected rangeAnchorIndex(): number | null {
    const anchor = this.rangeAnchor;
    const index = anchor ? this.find(anchor, true) : -1;
    return index < 0 ? null : index;
  }

  #replace(column: Column<S>, next: Column<S>) {
    this.takeColumns(this.#columns.map((other) => (other === column ? next : other)));
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

  #scroll(top: number, left: number, quiet = false) {
    const [nextTop, nextLeft] = [this.#clampTop(top), this.#clampLeft(left)];
    const moved = nextTop !== this.#top || nextLeft !== this.#left;
    this.#top = nextTop;
    this.#left = nextLeft;
    this.#remember();
    if (moved && !quiet) this.notify();
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
    this.#anchor = { ref: this.refAt(index), offset: this.#top - index * this.rowHeight };
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
    let index = this.find(focus.row, true);
    if (index < 0 && length > 0) index = Math.min(focus.rowIndex, length - 1);
    focus.rowIndex = index;
    focus.row = index < 0 ? null : this.refAt(index);
  }
}

/** Sort keys after a header click on `field`: going to `order`, or off without one. */
export function cycled<F extends string>(
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

/** The order a header click on a field sorted `order` goes to: ascending, descending, then none. */
export function nextOrder(
  keys: readonly SortKey[],
  field: string,
): "ascending" | "descending" | undefined {
  const at = keys.findIndex((key) => key.field === field);
  const current = at < 0 ? undefined : (keys[at]!.order ?? "ascending");
  return current === undefined ? "ascending" : current === "ascending" ? "descending" : undefined;
}
