// A grid in the page, imported with its model as `herceg/grid`. It scrolls a
// spacer as tall as its rows and mounts only the rows and cells in view, with
// a few more around them, updated in place as it scrolls and as its model
// changes. It follows the WAI grid pattern: one tab stop, a roving focused
// cell, logical row and column indexes on what is mounted, and a polite
// live region saying what sorting and selecting did.

import type { Schema } from "../data/table.ts";
import type { GridColumnLayout, GridFocus, GridModel, GridRange } from "../grid/model.ts";
import type { ThemeName, ThemeSpec } from "../spec/spec.ts";
import { resolveTheme, themeReadsPage } from "../theme.ts";
import { GRID_CSS, themeProperties } from "./grid-style.ts";
import { readPage, watchPage } from "./page-theme.ts";
import { observeVisibility, type Scheduled, schedule, unschedule } from "./scheduler.ts";

export interface GridOptions<S extends Schema = Schema> {
  /** What the grid shows; the application owns it, and destroying the grid leaves it be. */
  model: GridModel<S>;
  /** Names the grid for assistive technology. */
  ariaLabel: string;
  /** "light" by default. */
  theme?: ThemeName | ThemeSpec | undefined;
  /** In CSS pixels; 32 by default. */
  headerHeight?: number | undefined;
}

/** Options to change; one given as undefined goes back to its default. */
export type GridUpdate = Partial<Omit<GridOptions, "model">>;

/**
 * The tallest the rows' spacer is made, in CSS pixels; taller content
 * scrolls scaled. Browsers lay out up to about 33.5 million pixels (Chrome,
 * Safari) or 17.9 million (Firefox), but Chrome stops drawing one-pixel
 * lines past 2^24, and single precision keeps half pixels exact only below
 * 2^23.
 */
const MAX_EXTENT = 8_000_000;
const HEADER_HEIGHT = 32;
/** Height of grids whose container has none. */
const DEFAULT_HEIGHT = 320;
const OVERSCAN = { rows: 10, columns: 2 };
/** How far a press may move and still be a click; farther, it selects text. */
const CLICK_SLOP = 4;
const HIDDEN_TEXT =
  "position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0";
const INSTRUCTIONS =
  "Arrow keys, Page Up, Page Down, Home, and End move between cells. Space selects a row, Shift with arrow keys selects a range, and Control A selects every row. Enter on a column header sorts by it; Shift and Enter adds it to the sort.";

const MOVES = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  PageUp: "pageUp",
  PageDown: "pageDown",
  Home: "rowStart",
  End: "rowEnd",
} as const;

/** A mounted cell: a body cell, or a header cell (with `sort` for its sort mark). */
interface Cell {
  readonly element: HTMLDivElement;
  readonly text: Text;
  readonly sort: Text | undefined;
  /** The body row it belongs to; null in the header. */
  readonly row: Row | null;
  /** The id of the column it shows, which it keeps when columns move. */
  id: string;
  /** That column's index among the shown columns. */
  column: number;
  /** The column layout it was placed for; null when newly assigned. */
  placed: GridColumnLayout | null;
}

/** A mounted body row, following the row whose identity it shows. */
interface Row {
  readonly element: HTMLDivElement;
  cells: Cell[];
  index: number;
  identity: number;
  generation: number;
  /** The table's `modifiedVersion` and the columns its text was written for. */
  written: { modified: number; layout: readonly GridColumnLayout[] } | null;
  y: number;
  width: number;
  selected: boolean | null;
}

let nextId = 0;

/**
 * A virtualized, accessible grid over a `GridModel`. Create it with
 * `createGrid`; it fills its container, which should have a height (else
 * the grid is 320 pixels tall).
 */
export class Grid<S extends Schema = Schema> implements Scheduled {
  readonly model: GridModel<S>;
  /** The element the grid adds to its container. */
  readonly root: HTMLDivElement;
  readonly #container: HTMLElement;
  readonly #scroller: HTMLDivElement;
  readonly #headerRow: HTMLDivElement;
  readonly #body: HTMLDivElement;
  readonly #live: HTMLDivElement;
  readonly #cells = new WeakMap<Element, Cell>();
  #options: GridOptions<S>;
  #headerHeight = HEADER_HEIGHT;
  #rows: Row[] = [];
  #headerCells: Cell[] = [];
  #header: { layout: readonly GridColumnLayout[]; sort: unknown } | null = null;
  /** The cell with tabindex 0. */
  #active: HTMLElement | null = null;
  /** Content box of the scroller, from the resize observer. */
  #box: { width: number; height: number } | null = null;
  #spacer = { height: -1, width: -1 };
  #ratio = 1;
  /** The scroller's offsets, as last read or set. */
  #scrollTop = 0;
  #scrollLeft = 0;
  /** The scroller's offset as last drawn, and the model's top it stands for. */
  #expected: { physical: number; logical: number } | null = null;
  #dirty = true;
  #visible = true;
  #destroyed = false;
  #rendering = false;
  /** Set by commands that move the page's focus into the grid on the next draw. */
  #focusRequested = false;
  #pageChanged = false;
  #press: { x: number; y: number } | null = null;
  readonly #stops: (() => void)[] = [];
  #unwatchPage: (() => void) | undefined;

  constructor(container: HTMLElement, options: GridOptions<S>) {
    const document = container.ownerDocument;
    this.#container = container;
    this.model = options.model;
    this.#options = options;
    this.root = element(document, "herceg-grid");
    const style = document.createElement("style");
    style.textContent = GRID_CSS;
    this.#scroller = element(document, "hg-scroller");
    this.#scroller.setAttribute("role", "grid");
    this.#scroller.tabIndex = 0;
    const header = element(document, "hg-header");
    header.setAttribute("role", "rowgroup");
    this.#headerRow = element(document);
    this.#headerRow.setAttribute("role", "row");
    header.append(this.#headerRow);
    this.#body = element(document, "hg-body");
    this.#body.setAttribute("role", "rowgroup");
    this.#scroller.append(header, this.#body);
    const description = element(document);
    description.id = `herceg-grid-${++nextId}-keys`;
    description.hidden = true;
    description.textContent = INSTRUCTIONS;
    this.#scroller.setAttribute("aria-describedby", description.id);
    this.#live = element(document);
    this.#live.setAttribute("aria-live", "polite");
    this.#live.setAttribute("aria-atomic", "true");
    this.#live.style.cssText = HIDDEN_TEXT;
    this.root.append(style, this.#scroller, description, this.#live);
    container.append(this.root);

    try {
      this.#applyOptions();
      this.#listen();
      this.#stops.push(this.model.subscribe(() => this.#invalidate()));
      this.#stops.push(
        observeVisibility(this.root, (visible) => {
          this.#visible = visible;
          if (visible && (this.#dirty || this.#pageChanged)) schedule(this);
        }),
      );
      if (typeof ResizeObserver !== "undefined") {
        const observer = new ResizeObserver((entries) => {
          for (const entry of entries) {
            if (entry.target === container) this.#fit(entry.contentRect.height);
            else this.#measured(entry.contentRect.width, entry.contentRect.height);
          }
        });
        observer.observe(container);
        observer.observe(this.#scroller);
        this.#stops.push(() => observer.disconnect());
      }
      // The first frame draws at once, so the grid is never blank.
      const sizes = getComputedStyle(container);
      this.#fit(
        container.clientHeight -
          Number.parseFloat(sizes.paddingTop) -
          Number.parseFloat(sizes.paddingBottom),
      );
      this.#placeSpacer();
      this.#measured(this.#scroller.clientWidth, this.#scroller.clientHeight);
      this.#draw();
    } catch (error) {
      // Nothing returns a handle to the caller, so undo everything here.
      this.destroy();
      throw error;
    }
  }

  get visible(): boolean {
    return this.#visible;
  }

  /** Changes options; one given as undefined goes back to its default. */
  update(options: GridUpdate): void {
    const next: Record<string, unknown> = { ...this.#options, ...options };
    for (const [key, value] of Object.entries(options)) if (value === undefined) delete next[key];
    this.#options = next as unknown as GridOptions<S>;
    this.#applyOptions();
    if (this.#box) this.#measured(this.#box.width, this.#box.height);
    this.#invalidate();
  }

  /** Draws now instead of on the next frame, even while the grid is scrolled out of the page's view. */
  render(): void {
    if (this.#destroyed) return;
    if (this.#pageChanged) this.#applyTheme();
    this.#draw();
  }

  /** Focuses a cell (row -1 for the header row), scrolling it into view, and moves the page's focus to it. */
  focusCell(rowIndex: number, column: string): void {
    this.model.focusCell(rowIndex, column);
    this.#focusRequested = true;
    this.render();
  }

  /** Removes the grid and stops everything it listens to; the model, its view, and its table stay. */
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    unschedule(this);
    for (const stop of this.#stops) stop();
    this.#unwatchPage?.();
    this.root.remove();
  }

  /** Called by the scheduler. */
  flush(): void {
    if (this.#destroyed) return;
    if (this.#pageChanged) {
      this.#applyTheme();
      this.#dirty = true;
    }
    if (this.#dirty) this.#draw();
  }

  #invalidate() {
    this.#dirty = true;
    schedule(this);
  }

  #applyOptions() {
    const { ariaLabel, headerHeight = HEADER_HEIGHT, theme } = this.#options;
    if (!(Number.isFinite(headerHeight) && headerHeight > 0))
      throw new RangeError(`A grid's headerHeight must be positive, not ${headerHeight}`);
    this.#headerHeight = headerHeight;
    this.#scroller.setAttribute("aria-label", ariaLabel);
    this.#applyTheme();
    // Themes that follow the page read it again when it may have changed.
    const follows = themeReadsPage(theme);
    if (follows && !this.#unwatchPage) {
      this.#unwatchPage = watchPage(this.#container.ownerDocument, () => {
        this.#pageChanged = true;
        schedule(this);
      });
    } else if (!follows && this.#unwatchPage) {
      this.#unwatchPage();
      this.#unwatchPage = undefined;
    }
  }

  #applyTheme() {
    this.#pageChanged = false;
    const theme = readPage(this.#container, (page) => resolveTheme(this.#options.theme, page));
    const properties = themeProperties(theme, this.model.rowHeight, this.#headerHeight);
    for (const [name, value] of Object.entries(properties))
      this.root.style.setProperty(name, value);
  }

  /** Sizes the grid to its container's content height, or the default without one. */
  #fit(height: number) {
    const value = `${height > 0 ? height : DEFAULT_HEIGHT}px`;
    if (this.root.style.height !== value) this.root.style.height = value;
  }

  /** Takes the scroller's content box: the rows' viewport is what the header leaves. */
  #measured(width: number, height: number) {
    this.#box = { width, height };
    this.model.setViewport(width, Math.max(0, height - this.#headerHeight));
  }

  #draw() {
    this.#dirty = false;
    const model = this.model;
    this.#rendering = true;
    try {
      const count = model.rowCount;
      const layout = model.columnLayout;
      const shift = this.#scroll();
      const shown = model.visibleRange(OVERSCAN);
      const focus = model.focus;
      const root = this.root.getRootNode() as Document | ShadowRoot;
      const holding = this.#scroller.contains(root.activeElement) || this.#focusRequested;
      // While it holds the page's focus, the focused cell stays mounted wherever it is scrolled.
      const keep = holding ? focus : null;
      this.#drawHeader(shown, keep, layout);
      this.#drawRows(shown, keep, shift, layout);
      this.#describe(count, layout.length);
      this.#placeFocus(focus, holding);
    } finally {
      this.#rendering = false;
      this.#focusRequested = false;
    }
  }

  /**
   * The grid's own attributes. With no column shown it has no rows (a row
   * needs cells), so it is a named group until columns come back.
   */
  #describe(rows: number, columns: number) {
    const scroller = this.#scroller;
    const grid = columns > 0;
    setAttribute(scroller, "role", grid ? "grid" : "group");
    // Rows and row groups belong in a grid. Their elements stay laid out, so
    // the scroll offset is kept for when columns come back.
    for (const [element, role] of [
      [this.#headerRow.parentElement!, "rowgroup"],
      [this.#headerRow, "row"],
      [this.#body, "rowgroup"],
    ] as const) {
      if (grid) setAttribute(element, "role", role);
      else element.removeAttribute("role");
    }
    if (grid) setAttribute(this.#headerRow, "aria-rowindex", "1");
    else this.#headerRow.removeAttribute("aria-rowindex");
    for (const [name, value] of [
      ["aria-rowcount", String(rows + 1)],
      ["aria-colcount", String(columns)],
      ["aria-multiselectable", "true"],
      ["aria-readonly", "true"],
    ] as const) {
      if (grid) setAttribute(scroller, name, value);
      else scroller.removeAttribute(name);
    }
  }

  /** Sizes the spacer: as tall as the rows, up to the most browsers draw correctly. */
  #placeSpacer() {
    const model = this.model;
    const height = Math.min(model.contentHeight, MAX_EXTENT);
    if (height !== this.#spacer.height) {
      this.#spacer.height = height;
      this.#body.style.height = `${height}px`;
    }
    if (model.width !== this.#spacer.width) {
      this.#spacer.width = model.width;
      this.#body.style.width = this.#headerRow.style.width = `${model.width}px`;
    }
    return height;
  }

  /**
   * Brings the scroller to the model's offsets and returns how far rows
   * shift from their logical place: none unless the rows are taller than
   * the spacer, which then scrolls a fraction (`#ratio`) as far.
   */
  #scroll(): number {
    const model = this.model;
    const viewport = model.viewportHeight;
    const spacer = this.#placeSpacer();
    const range = spacer - viewport;
    const ratio = range > 0 ? Math.max(1, (model.contentHeight - viewport) / range) : 1;
    this.#ratio = ratio;
    const top = model.top;
    const scroller = this.#scroller;
    if (Math.abs(top / ratio - this.#scrollTop) >= 1) {
      scroller.scrollTop = top / ratio;
      this.#scrollTop = scroller.scrollTop;
    }
    // The offset the scroller is at (as the browser took it) stands for the
    // model's top: a scroll event reporting it is the grid's own scrolling.
    this.#expected = { physical: this.#scrollTop, logical: top };
    if (Math.abs(model.left - this.#scrollLeft) >= 1) {
      scroller.scrollLeft = model.left;
      this.#scrollLeft = scroller.scrollLeft;
    }
    return Math.round(top - this.#scrollTop);
  }

  #drawHeader(shown: GridRange, keep: GridFocus | null, layout: readonly GridColumnLayout[]) {
    const columns = columnsOf(shown, keep?.rowIndex === -1 ? keep : null);
    const cells = this.#mountCells(this.#headerRow, null, this.#headerCells, columns, layout);
    this.#headerCells = cells;
    const sort = this.model.sort;
    const changed = this.#header?.layout !== layout || this.#header.sort !== sort;
    this.#header = { layout, sort };
    for (const cell of cells) {
      const column = layout[cell.column]!;
      if (!this.#place(cell, column) && !changed) continue;
      setText(cell.text, column.title);
      const at = sort.findIndex(({ field }) => field === column.field);
      const order = at < 0 ? undefined : (sort[at]!.order ?? "ascending");
      const mark = order
        ? `${order === "ascending" ? "▲" : "▼"}${sort.length > 1 ? at + 1 : ""}`
        : "";
      setText(cell.sort!, mark);
      // One header at a time carries aria-sort: the first key's.
      if (at === 0) cell.element.setAttribute("aria-sort", order!);
      else cell.element.removeAttribute("aria-sort");
    }
  }

  #drawRows(
    shown: GridRange,
    keep: GridFocus | null,
    shift: number,
    layout: readonly GridColumnLayout[],
  ) {
    const model = this.model;
    const { rowStart, rowEnd } = shown;
    const outside =
      keep && keep.rowIndex >= 0 && (keep.rowIndex < rowStart || keep.rowIndex >= rowEnd)
        ? keep.rowIndex
        : -1;
    const indices: number[] = [];
    // Rows without cells are not rows: with no column shown, none are mounted.
    if (layout.length > 0) {
      if (outside >= 0 && outside < rowStart) indices.push(outside);
      for (let i = rowStart; i < rowEnd; i++) indices.push(i);
      if (outside >= rowEnd) indices.push(outside);
    }

    // Rows keep their elements by identity, so a row that moves (a rolling
    // window dropping rows above it, a sort) keeps its text.
    const generation = model.data.source.generation;
    const previous = new Map<number, Row>();
    for (const row of this.#rows)
      if (row.generation === generation) previous.set(row.identity, row);
    const identities = indices.map((index) => model.identityAt(index));
    const found = identities.map((identity) => {
      const row = previous.get(identity);
      previous.delete(identity);
      return row;
    });
    // Rows no longer shown, those from before a reset among them.
    const kept = new Set(found);
    const free = this.#rows.filter((row) => !kept.has(row));
    const rows = found.map((row, k) => {
      if (row) return row;
      const reused = free.pop() ?? this.#newRow();
      reused.identity = identities[k]!;
      reused.generation = generation;
      reused.written = null;
      return reused;
    });
    for (const row of free) row.element.remove();
    arrange(
      this.#body,
      rows.map(({ element }) => element),
      this.#holder(this.#body),
    );
    this.#rows = rows;

    const modified = model.data.source.modifiedVersion;
    const height = model.rowHeight;
    for (let k = 0; k < rows.length; k++) {
      const row = rows[k]!;
      const index = indices[k]!;
      if (row.index !== index) {
        row.index = index;
        row.element.setAttribute("aria-rowindex", String(index + 2));
      }
      const y = index * height - shift;
      if (row.y !== y) {
        row.y = y;
        row.element.style.transform = `translateY(${y}px)`;
      }
      if (row.width !== model.width) {
        row.width = model.width;
        row.element.style.width = `${model.width}px`;
      }
      const selected = model.isSelected(index);
      if (row.selected !== selected) {
        row.selected = selected;
        row.element.setAttribute("aria-selected", String(selected));
      }
      const stale = row.written?.modified !== modified || row.written.layout !== layout;
      row.written = { modified, layout };
      const columns = columnsOf(shown, keep?.rowIndex === index ? keep : null);
      row.cells = this.#mountCells(row.element, row, row.cells, columns, layout);
      for (const cell of row.cells) {
        const column = layout[cell.column]!;
        if (this.#place(cell, column) || stale)
          setText(cell.text, model.textAt(index, cell.column));
      }
    }
  }

  #newRow(): Row {
    const element = this.root.ownerDocument.createElement("div");
    element.setAttribute("role", "row");
    return {
      element,
      cells: [],
      index: -1,
      identity: -1,
      generation: -1,
      written: null,
      y: Number.NaN,
      width: -1,
      selected: null,
    };
  }

  /**
   * The cells of shown columns `columns` in a row (null: the header), in
   * order: cells already showing a column keep it, the others are reused or
   * made. Newly assigned cells have `placed` null.
   */
  #mountCells(
    parent: HTMLElement,
    row: Row | null,
    current: Cell[],
    columns: number[],
    layout: readonly GridColumnLayout[],
  ): Cell[] {
    const ids = columns.map((column) => layout[column]!.id);
    if (
      current.length === columns.length &&
      current.every((cell, k) => cell.column === columns[k] && cell.id === ids[k])
    )
      return current;
    // Cells keep their column by id, so the focused one stays when columns move.
    const byId = new Map(current.map((cell) => [cell.id, cell]));
    const cells: (Cell | undefined)[] = ids.map((id) => {
      const cell = byId.get(id);
      byId.delete(id);
      return cell;
    });
    const free = [...byId.values()];
    for (let k = 0; k < cells.length; k++) {
      const cell = cells[k] ?? free.pop() ?? this.#cell(row);
      if (!cells[k] || cell.column !== columns[k]) cell.placed = null;
      cell.id = ids[k]!;
      cell.column = columns[k]!;
      cells[k] = cell;
    }
    for (const cell of free) cell.element.remove();
    const mounted = cells as Cell[];
    arrange(
      parent,
      mounted.map(({ element }) => element),
      this.#holder(parent),
    );
    return mounted;
  }

  #cell(row: Row | null): Cell {
    const document = this.root.ownerDocument;
    const element = document.createElement("div");
    element.setAttribute("role", row ? "gridcell" : "columnheader");
    element.tabIndex = -1;
    const text = document.createTextNode("");
    element.append(text);
    let sort: Text | undefined;
    if (!row) {
      const mark = document.createElement("span");
      mark.className = "hg-sort";
      mark.setAttribute("aria-hidden", "true");
      sort = document.createTextNode("");
      mark.append(sort);
      element.append(mark);
    }
    const cell: Cell = { element, text, sort, row, id: "", column: -1, placed: null };
    this.#cells.set(element, cell);
    return cell;
  }

  /** Places a cell for its column; whether it was not placed for it already (its text must be written). */
  #place(cell: Cell, column: GridColumnLayout): boolean {
    if (cell.placed === column) return false;
    cell.placed = column;
    const { element } = cell;
    element.style.left = `${column.x}px`;
    element.style.width = `${column.width}px`;
    element.dataset.align = column.align;
    element.setAttribute("aria-colindex", String(cell.column + 1));
    return true;
  }

  /** The child of `parent` holding the page's focus, which must not move: moving it would drop the focus. */
  #holder(parent: HTMLElement): Element | null {
    const active = (this.root.getRootNode() as Document | ShadowRoot).activeElement;
    let at: Element | null = active;
    while (at && at.parentElement !== parent) at = at.parentElement;
    return at;
  }

  /** Gives the focused cell the tab stop, and the page's focus when the grid holds it. */
  #placeFocus(focus: GridFocus | null, holding: boolean) {
    const target = focus ? this.#elementOf(focus) : null;
    if (target !== this.#active) {
      this.#active?.setAttribute("tabindex", "-1");
      target?.setAttribute("tabindex", "0");
      this.#active = target;
    }
    // Without a mounted focused cell, the grid itself is the tab stop.
    this.#scroller.tabIndex = target ? -1 : 0;
    if (!holding) return;
    const root = this.root.getRootNode() as Document | ShadowRoot;
    if (target && root.activeElement !== target) target.focus({ preventScroll: true });
    else if (!target && !this.#scroller.contains(root.activeElement))
      this.#scroller.focus({ preventScroll: true });
  }

  #elementOf({ rowIndex, columnIndex }: GridFocus): HTMLElement | null {
    const cells =
      rowIndex < 0 ? this.#headerCells : this.#rows.find(({ index }) => index === rowIndex)?.cells;
    return cells?.find(({ column }) => column === columnIndex)?.element ?? null;
  }

  #listen() {
    const scroller = this.#scroller;
    const listeners = [
      ["scroll", this.#onScroll],
      ["keydown", this.#onKeyDown],
      ["mousedown", this.#onMouseDown],
      ["click", this.#onClick],
      ["focusin", this.#onFocusIn],
      ["focusout", this.#onFocusOut],
    ] as const;
    for (const [type, listener] of listeners)
      scroller.addEventListener(type, listener as EventListener, { passive: type === "scroll" });
    // Detached elements can outlive the grid (browsers remember where the focus was).
    this.#stops.push(() => {
      for (const [type, listener] of listeners)
        scroller.removeEventListener(type, listener as EventListener);
    });
  }

  #onScroll = () => {
    const scroller = this.#scroller;
    this.#scrollTop = scroller.scrollTop;
    this.#scrollLeft = scroller.scrollLeft;
    // At the offset last drawn, the scroll was the grid's own (or along x
    // only): the model's top, which may have moved on since, stays.
    if (this.#scrollTop === this.#expected?.physical) {
      this.model.scrollTo({ left: this.#scrollLeft });
      return;
    }
    this.#expected = null;
    this.model.scrollTo({ top: this.#scrollTop * this.#ratio, left: this.#scrollLeft });
  };

  #onKeyDown = (event: KeyboardEvent) => {
    const model = this.model;
    const focus = model.focus;
    if (!focus || event.altKey) return;
    const command = event.ctrlKey || event.metaKey;
    const key = event.key;
    if (Object.hasOwn(MOVES, key)) {
      const move = MOVES[key as keyof typeof MOVES];
      const target =
        command && move === "rowStart" ? "first" : command && move === "rowEnd" ? "last" : move;
      // Shift extends the selection with moves between rows.
      const across =
        target === "left" || target === "right" || target === "rowStart" || target === "rowEnd";
      const before = model.selection.revision;
      model.moveFocus(target, { extend: event.shiftKey && !across });
      if (model.selection.revision !== before) this.#announceSelection();
    } else if ((key === " " || key === "Enter") && focus.rowIndex < 0) {
      model.cycleSort(focus.column, { additive: event.shiftKey });
      this.#announceSort();
    } else if (key === " ") {
      model.select(focus.rowIndex, "toggle");
      this.#announceSelection();
    } else if (command && key.toLowerCase() === "a") {
      model.selectAll();
      this.#announceSelection();
    } else if (key === "Escape" && model.clearSelection()) {
      this.#announceSelection();
    } else return;
    event.preventDefault();
    this.#focusRequested = true;
    this.render();
  };

  #onMouseDown = (event: MouseEvent) => {
    this.#press = { x: event.clientX, y: event.clientY };
    // Shift and click selects rows, not text.
    if (event.shiftKey) event.preventDefault();
  };

  #onClick = (event: MouseEvent) => {
    const press = this.#press;
    this.#press = null;
    // A press that moved selected text.
    if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > CLICK_SLOP) return;
    const target = this.#cellOf(
      (event.target as Element).closest("[role=gridcell],[role=columnheader]"),
    );
    if (!target) return;
    const { rowIndex, column } = target;
    const model = this.model;
    // Focus first: listeners of the sort or the selection may change the rows.
    model.focusCell(rowIndex, column);
    if (rowIndex < 0) {
      model.cycleSort(column, { additive: event.shiftKey });
      this.#announceSort();
    } else {
      const command = event.ctrlKey || event.metaKey;
      model.select(
        rowIndex,
        command ? (event.shiftKey ? "addRange" : "toggle") : event.shiftKey ? "range" : "only",
      );
      this.#announceSelection();
    }
    this.#focusRequested = true;
    this.render();
  };

  #onFocusIn = (event: FocusEvent) => {
    if (this.#rendering) return;
    const model = this.model;
    const cell = this.#cellOf(event.target as Element);
    const focus = model.focus;
    if (cell) {
      if (focus?.rowIndex !== cell.rowIndex || focus.column !== cell.column)
        model.focusCell(cell.rowIndex, cell.column);
    } else if (event.target === this.#scroller && focus) {
      // Tabbing in goes to the focused cell, wherever it was scrolled.
      model.reveal(focus.rowIndex, focus.column);
      this.render();
    }
  };

  #onFocusOut = () => {
    // Once the focus has left, the focused cell need not stay mounted.
    if (!this.#rendering) this.#invalidate();
  };

  /**
   * The cell an element shows, as the model has it now, which may have
   * changed since the element was drawn; null when its row or column is gone.
   */
  #cellOf(element: Element | null): { rowIndex: number; column: string } | null {
    const cell = element && this.#cells.get(element);
    // A column id now naming another field is another column.
    const column = cell && this.model.columnLayout[this.model.columnIndex(cell.id)];
    if (!cell || !column || column.field !== cell.placed?.field) return null;
    const { row } = cell;
    if (!row) return { rowIndex: -1, column: cell.id };
    if (row.generation !== this.model.data.source.generation) return null;
    const rowIndex = this.model.rowIndexOf(row.identity);
    return rowIndex < 0 ? null : { rowIndex, column: cell.id };
  }

  #announceSort() {
    const model = this.model;
    const title = (field: string) =>
      model.columns.find((column) => column.field === field)?.title ?? field;
    const keys = model.sort;
    this.#say(
      keys.length === 0
        ? "Not sorted"
        : `Sorted by ${keys.map(({ field, order }) => `${title(field)}, ${order ?? "ascending"}`).join(", then ")}`,
    );
  }

  #announceSelection() {
    const count = this.model.selectedCount;
    this.#say(
      count === 0 ? "No rows selected" : count === 1 ? "1 row selected" : `${count} rows selected`,
    );
  }

  #say(text: string) {
    // The same words again are a new announcement.
    this.#live.textContent = this.#live.textContent === text ? `${text} ` : text;
  }
}

/** A grid in `container`; see `Grid`. */
export function createGrid<S extends Schema>(
  container: HTMLElement,
  options: GridOptions<S>,
): Grid<S> {
  return new Grid(container, options);
}

function element(document: Document, className?: string): HTMLDivElement {
  const div = document.createElement("div");
  if (className) div.className = className;
  return div;
}

function setAttribute(target: Element, name: string, value: string) {
  if (target.getAttribute(name) !== value) target.setAttribute(name, value);
}

function setText(text: Text, value: string) {
  if (text.data !== value) text.data = value;
}

/** The shown columns in range, with the focused cell's column in order when outside it. */
function columnsOf(
  { columnStart: start, columnEnd: end }: GridRange,
  keep: GridFocus | null,
): number[] {
  const indices: number[] = [];
  const extra =
    keep && (keep.columnIndex < start || keep.columnIndex >= end) ? keep.columnIndex : -1;
  if (extra >= 0 && extra < start) indices.push(extra);
  for (let i = start; i < end; i++) indices.push(i);
  if (extra >= end) indices.push(extra);
  return indices;
}

/**
 * Puts `elements` in `parent` in this order, with no other children. The
 * element `fixed` holds the page's focus and stays put; the others move
 * around it, each only if it is out of place.
 */
function arrange(parent: Element, elements: readonly Element[], fixed: Element | null) {
  if (elements.length === 0) return;
  let pivot = fixed ? elements.indexOf(fixed) : -1;
  if (pivot < 0) {
    pivot = 0;
    if (parent.firstElementChild !== elements[0]) parent.prepend(elements[0]!);
  }
  for (let k = pivot + 1; k < elements.length; k++)
    if (elements[k]!.previousElementSibling !== elements[k - 1])
      elements[k - 1]!.after(elements[k]!);
  for (let k = pivot - 1; k >= 0; k--)
    if (elements[k]!.nextElementSibling !== elements[k + 1])
      parent.insertBefore(elements[k]!, elements[k + 1]!);
}
