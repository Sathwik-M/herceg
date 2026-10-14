// A grid in the page, imported with its model as `herceg/grid`. It scrolls a
// spacer as tall as its rows and mounts only the rows and cells in view, with
// a few more around them, updated in place as it scrolls and as its model
// changes; cells of pinned columns stick to the edges (CSS sticky, so they
// keep up with the browser's scrolling). It follows the WAI grid pattern (the
// treegrid pattern when its rows are grouped): one tab stop, a roving focused
// cell, logical row and column indexes on what is mounted, and a polite live
// region saying what sorting, selecting, expanding, collapsing, and changing
// columns did. Headers resize and move their columns by dragging, or by keys
// and a column menu.

import type { Schema } from "../data/table.ts";
import type {
  BaseGridModel,
  GridFocus,
  GridRange,
  GridRef,
  SelectionState,
  ShownRow,
} from "../grid/base.ts";
import type { ColumnContent, GridColumnLayout, PlacedColumn } from "../grid/columns.ts";
import type { GridModel } from "../grid/model.ts";
import type { ThemeName, ThemeSpec } from "../spec/spec.ts";
import { resolveTokens, themeReadsPage } from "../theme.ts";
import { ColumnControls } from "./grid-columns.ts";
import { GRID_CSS, themeProperties } from "./grid-style.ts";
import { readPage, watchPage } from "./page-theme.ts";
import { observeVisibility, type Scheduled, schedule, unschedule } from "./scheduler.ts";

export interface GridOptions<S extends Schema = Schema, M extends BaseGridModel<S> = GridModel<S>> {
  /** What the grid shows; the application owns it, and destroying the grid leaves it be. */
  model: M;
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
 * Header rows over the columns' own, for grids that need them
 * (dom/grid-pivot.ts: a pivot's values over their aggregates).
 */
export interface HeaderRows {
  /** How many rows it draws for this layout. */
  rows(layout: readonly PlacedColumn[]): number;
  /**
   * Draws them at the top of the header rowgroup, over the shown columns
   * mounted (`columns`, indices into `layout`, whose header cells are
   * `cells`), in a grid of columns `width` wide whose rows are `span` wide.
   */
  draw(
    header: HTMLElement,
    columns: readonly number[],
    cells: readonly { readonly element: HTMLElement }[],
    layout: readonly PlacedColumn[],
    width: number,
    span: number,
  ): void;
}

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
/** How far a press may move and still be a click; farther, it selects text or drags a header. */
const CLICK_SLOP = 4;
const HIDDEN_TEXT =
  "position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0";
const INSTRUCTIONS =
  "Arrow keys, Page Up, Page Down, Home, and End move between cells. Space selects a row, Shift with arrow keys selects a range, and Control A selects every row. Enter on a column header sorts by it; Shift and Enter adds it to the sort. On a column header, Shift with Left or Right Arrow moves the column, Alt with Left or Right Arrow resizes it, and Alt and Down Arrow opens its menu, which also pins, hides, and shows columns.";
const GROUP_INSTRUCTIONS =
  " Rows are grouped. Enter on a group expands or collapses it, and Space selects its rows. On a row's first cell, Right Arrow expands a group, Left Arrow collapses it, and Left Arrow on a collapsed group or a group's row goes to the group holding it.";

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
  /** What column's content its text was written for. */
  content: ColumnContent | null;
  readonly element: HTMLDivElement;
  readonly text: Text;
  readonly sort: Text | undefined;
  /** The expand toggle and checkbox of a group's first cell, made when first needed. */
  controls: { element: HTMLSpanElement; check: HTMLSpanElement } | null;
  /** The body row it belongs to; null in the header. */
  readonly row: Row | null;
  /** The id of the column it shows, which it keeps when columns move. */
  id: string;
  /** That column's index among the shown columns. */
  column: number;
  /** The column layout it was placed for; null when newly assigned. */
  placed: GridColumnLayout | null;
}

/** A mounted body row, following the row (or group's header) whose ref it shows. */
interface Row {
  readonly element: HTMLDivElement;
  cells: Cell[];
  index: number;
  ref: GridRef | null;
  /**
   * The row's version and the columns its text was written for: a group's
   * header writes its first cell otherwise.
   */
  written: { version: number; layout: readonly GridColumnLayout[] } | null;
  y: number;
  width: number;
  selected: SelectionState | null;
}

/**
 * What grids of other kinds add to the DOM grid: a pivot's header rows
 * (dom/grid-pivot.ts), a remote grid's loading and failed rows
 * (dom/grid-remote.ts).
 */
export interface GridExtras {
  readonly headers?: HeaderRows;
  /** The keyboard instructions, in place of the plain grid's. */
  instructions?(grouped: boolean): string;
  /** The rows there are for assistive technology, null when unknown; the model's row count by default. */
  rowCount?(): number | null;
  /** Marks a mounted row as it is drawn. */
  row?(element: HTMLElement, row: ShownRow): void;
  /** Called after each frame drawn, with the grid's scroller (in its root) and its live region. */
  drawn?(scroller: HTMLElement, say: (text: string) => void): void;
}

let nextId = 0;

/**
 * A virtualized, accessible grid over a `GridModel`. Create it with
 * `createGrid`; it fills its container, which should have a height (else
 * the grid is 320 pixels tall).
 */
export class Grid<S extends Schema = Schema, M extends BaseGridModel<S> = GridModel<S>>
  implements Scheduled
{
  readonly model: M;
  /** The element the grid adds to its container. */
  readonly root: HTMLDivElement;
  readonly #container: HTMLElement;
  readonly #scroller: HTMLDivElement;
  readonly #headerRow: HTMLDivElement;
  readonly #body: HTMLDivElement;
  readonly #description: HTMLDivElement;
  readonly #live: HTMLDivElement;
  /** What the headers do to their columns: drags, keys, and the column menu. */
  readonly #controls: ColumnControls<S>;
  readonly #cells = new WeakMap<Element, Cell>();
  #options: GridOptions<S, M>;
  readonly #extras: GridExtras;
  /** Header rows: the columns' own and those `#headers` draws. */
  #levels = 1;
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

  /** `extras` are what pivot and remote grids add (`createPivotGrid` and `createRemoteGrid` give them). */
  constructor(container: HTMLElement, options: GridOptions<S, M>, extras: GridExtras = {}) {
    const document = container.ownerDocument;
    this.#container = container;
    this.model = options.model;
    this.#options = options;
    this.#extras = extras;
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
    this.#description = description;
    this.#scroller.setAttribute("aria-describedby", description.id);
    this.#live = element(document);
    this.#live.setAttribute("aria-live", "polite");
    this.#live.setAttribute("aria-atomic", "true");
    this.#live.style.cssText = HIDDEN_TEXT;
    this.root.append(style, this.#scroller, description, this.#live);
    container.append(this.root);
    this.#controls = new ColumnControls({
      model: this.model,
      root: this.root,
      scroller: this.#scroller,
      headerCells: () => this.#headerCells,
      cellOf: (element) => this.#cellOf(element),
      render: (focus) => {
        if (focus) this.#focusRequested = true;
        this.render();
      },
      invalidate: () => this.#invalidate(),
      say: (text) => this.#say(text),
    });

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
    this.#options = next as unknown as GridOptions<S, M>;
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
    this.#controls.destroy();
    this.#destroyed = true;
    unschedule(this);
    for (const stop of this.#stops) stop();
    this.#unwatchPage?.();
    this.root.remove();
  }

  /** Called by the scheduler. */
  flush(): void {
    if (this.#destroyed) return;
    this.#controls.flush();
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
    const theme = readPage(this.#container, (page) => resolveTokens(this.#options.theme, page));
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
    this.model.setViewport(width, Math.max(0, height - this.#headerHeight * this.#levels));
  }

  #draw() {
    this.#dirty = false;
    const model = this.model;
    this.#rendering = true;
    try {
      const count = model.rowCount;
      // The model's layout is of placed columns, which say what they show.
      const layout = model.columnLayout as readonly PlacedColumn[];
      const levels = 1 + (this.#extras.headers?.rows(layout) ?? 0);
      if (levels !== this.#levels) {
        this.#levels = levels;
        // Rows' indexes count the header rows: every mounted row writes its own again.
        for (const row of this.#rows) row.index = -1;
        if (this.#box) this.#measured(this.#box.width, this.#box.height);
      }
      // A column's menu closing with its column gives the focus back to the grid.
      if (this.#controls.sync()) this.#focusRequested = true;
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
      this.#extras.drawn?.(this.#scroller, (text) => this.#say(text));
    } finally {
      this.#rendering = false;
      this.#focusRequested = false;
    }
  }

  /**
   * The grid's own attributes. With no column shown it has no rows (a row
   * needs cells), so it is a named group until columns come back; with
   * groups it is a tree grid.
   */
  #describe(rows: number, columns: number) {
    const scroller = this.#scroller;
    const grid = columns > 0;
    const grouped = this.model.grouped;
    setAttribute(scroller, "role", grid ? (grouped ? "treegrid" : "grid") : "group");
    const extras = this.#extras;
    const instructions =
      extras.instructions?.(grouped) ??
      (grouped ? INSTRUCTIONS + GROUP_INSTRUCTIONS : INSTRUCTIONS);
    if (this.#description.textContent !== instructions)
      this.#description.textContent = instructions;
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
    if (grid) setAttribute(this.#headerRow, "aria-rowindex", String(this.#levels));
    else this.#headerRow.removeAttribute("aria-rowindex");
    const known = extras.rowCount ? extras.rowCount() : rows;
    for (const [name, value] of [
      ["aria-rowcount", String(known === null ? -1 : known + this.#levels)],
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
    const span = this.#span();
    if (span !== this.#spacer.width) {
      this.#spacer.width = span;
      this.#body.style.width = this.#headerRow.style.width = `${span}px`;
    }
    return height;
  }

  /**
   * How wide rows are: as the columns, or as the viewport when they are
   * narrower and some are held at the right edge, which they then reach.
   * Either way nothing scrolls past the columns.
   */
  #span(): number {
    const { width, viewportWidth, columnLayout } = this.model;
    return columnLayout.at(-1)?.pinned === "right" ? Math.max(width, viewportWidth) : width;
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

  #drawHeader(shown: GridRange, keep: GridFocus | null, layout: readonly PlacedColumn[]) {
    const columns = columnsOf(shown, keep?.rowIndex === -1 ? keep : null, layout);
    const cells = this.#mountCells(this.#headerRow, null, this.#headerCells, columns, layout);
    this.#headerCells = cells;
    this.#extras.headers?.draw(
      this.#headerRow.parentElement!,
      columns,
      cells,
      layout,
      this.model.width,
      this.#spacer.width,
    );
    const sort = this.model.sort;
    const changed = this.#header?.layout !== layout || this.#header.sort !== sort;
    this.#header = { layout, sort };
    const moving = this.#controls.moving;
    for (const cell of cells) {
      const column = layout[cell.column]!;
      cell.element.toggleAttribute("data-moving", cell.id === moving);
      if (!this.#place(cell, column, layout) && !changed) continue;
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
    layout: readonly PlacedColumn[],
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

    // Rows keep their elements by ref (rows by identity, groups' headers by
    // key), so a row that moves (a rolling window dropping rows above it, a
    // sort, a group expanding above it) keeps its text.
    const previous = new Map<number | string, Row>();
    for (const row of this.#rows) if (row.ref) previous.set(row.ref.id, row);
    const entries = indices.map((index) => model.row(index));
    const found = entries.map(({ ref }) => {
      const row = previous.get(ref.id);
      // Rows of another scope (from before a reset, or of groups replaced) may share ids.
      if (row?.ref?.scope !== ref.scope) return undefined;
      previous.delete(ref.id);
      return row;
    });
    // Rows no longer shown, those from before a reset among them.
    const kept = new Set(found);
    const free = this.#rows.filter((row) => !kept.has(row));
    const rows = found.map((row, k) => {
      const entry = entries[k]!;
      // The same row may come with a new ref (its group collapsed and expanded again).
      if (row) {
        row.ref = entry.ref;
        return row;
      }
      const reused = free.pop() ?? this.#newRow();
      reused.ref = entry.ref;
      reused.written = null;
      // Group headers and table rows mark selection differently.
      reused.selected = null;
      return reused;
    });
    for (const row of free) row.element.remove();
    arrange(
      this.#body,
      rows.map(({ element }) => element),
      this.#holder(this.#body),
    );
    this.#rows = rows;

    const grouped = model.grouped;
    const height = model.rowHeight;
    for (let k = 0; k < rows.length; k++) {
      const row = rows[k]!;
      const index = indices[k]!;
      const entry = entries[k]!;
      if (row.index !== index) {
        row.index = index;
        row.element.setAttribute("aria-rowindex", String(index + 1 + this.#levels));
      }
      const y = index * height - shift;
      if (row.y !== y) {
        row.y = y;
        row.element.style.transform = `translateY(${y}px)`;
      }
      if (row.width !== this.#spacer.width) {
        row.width = this.#spacer.width;
        row.element.style.width = `${row.width}px`;
      }
      this.#placeInTree(row.element, entry, grouped);
      this.#extras.row?.(row.element, entry);
      const selected = model.selectionState(index);
      if (row.selected !== selected) {
        row.selected = selected;
        // A group's header can be partly selected, which its checkbox says.
        if (entry.kind === "group") row.element.removeAttribute("aria-selected");
        else row.element.setAttribute("aria-selected", String(selected === "all"));
        row.element.dataset.selection = selected;
      }
      // A table row's cells keep their text while their columns only move or
      // resize; a group's header's first cell names the group, so its text
      // goes with the columns' places.
      const written = row.written;
      const stale =
        written?.version !== entry.version || (entry.kind !== "row" && written.layout !== layout);
      row.written = { version: entry.version, layout };
      const columns = columnsOf(shown, keep?.rowIndex === index ? keep : null, layout);
      row.cells = this.#mountCells(row.element, row, row.cells, columns, layout);
      for (const cell of row.cells) {
        const column = layout[cell.column]!;
        const controls = entry.kind === "group" && cell.column === 0;
        this.#place(cell, column, layout);
        const decorated = this.#decorate(cell, controls, selected, grouped);
        if (stale || decorated || cell.content !== column.content) {
          cell.content = column.content;
          setText(cell.text, model.textAt(index, cell.column));
        }
      }
    }
  }

  /**
   * A row's place in the tree, for grouped grids: its level, place among its
   * siblings, and expansion, and how far its first cell is indented (a
   * table row's as far as its group's header).
   */
  #placeInTree(element: HTMLDivElement, entry: ShownRow, grouped: boolean) {
    if (!grouped) {
      for (const name of ["aria-level", "aria-posinset", "aria-setsize", "aria-expanded"])
        element.removeAttribute(name);
      element.style.removeProperty("--hg-indent");
      return;
    }
    const indent = String(
      entry.kind === "placeholder" ? entry.indent : entry.level - (entry.kind === "group" ? 1 : 2),
    );
    if (element.style.getPropertyValue("--hg-indent") !== indent)
      element.style.setProperty("--hg-indent", indent);
    setAttribute(element, "aria-level", String(entry.level));
    setAttribute(element, "aria-posinset", String(entry.setIndex + 1));
    setAttribute(element, "aria-setsize", String(entry.setSize));
    if (entry.kind === "group") setAttribute(element, "aria-expanded", String(entry.expanded));
    else element.removeAttribute("aria-expanded");
  }

  /**
   * Puts a group's checkbox in a cell, with its expand toggle when groups
   * can expand (not a pivot's), or takes them out; whether they came or
   * went (the text must be written again).
   */
  #decorate(cell: Cell, wanted: boolean, selected: SelectionState, toggles: boolean): boolean {
    const shown = cell.controls?.element.parentNode === cell.element;
    if (wanted) {
      let controls = cell.controls;
      if (!controls) {
        const document = this.root.ownerDocument;
        const element = document.createElement("span");
        element.className = "hg-controls";
        const toggle = document.createElement("span");
        toggle.className = "hg-toggle";
        toggle.setAttribute("aria-hidden", "true");
        const check = document.createElement("span");
        check.className = "hg-check";
        check.setAttribute("role", "checkbox");
        check.setAttribute("aria-label", "Select");
        if (toggles) element.append(toggle);
        element.append(check);
        controls = { element, check };
        cell.controls = controls;
      }
      setAttribute(
        controls.check,
        "aria-checked",
        selected === "all" ? "true" : selected === "some" ? "mixed" : "false",
      );
      if (!shown) cell.element.insertBefore(controls.element, cell.text);
    } else if (shown) {
      cell.controls!.element.remove();
    }
    return wanted !== shown;
  }

  #newRow(): Row {
    const element = this.root.ownerDocument.createElement("div");
    element.setAttribute("role", "row");
    return {
      element,
      cells: [],
      index: -1,
      ref: null,
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
      // For pointers: the keys and the context menu do what these do.
      const button = document.createElement("span");
      button.className = "hg-menu-button";
      button.setAttribute("aria-hidden", "true");
      const edge = document.createElement("span");
      edge.className = "hg-resize";
      edge.setAttribute("aria-hidden", "true");
      element.append(mark, button, edge);
    }
    const cell: Cell = {
      content: null,
      element,
      text,
      sort,
      controls: null,
      row,
      id: "",
      column: -1,
      placed: null,
    };
    this.#cells.set(element, cell);
    return cell;
  }

  /**
   * Places a cell for its column; whether it was not placed for it already.
   * Cells of columns held at an edge are in the row's flow and stick there
   * (sticky offsets are their distances from the edge); the others are
   * placed absolutely, and scroll under them.
   */
  #place(cell: Cell, column: GridColumnLayout, layout: readonly GridColumnLayout[]): boolean {
    if (cell.placed === column) return false;
    cell.placed = column;
    const index = cell.column;
    placeCell(cell.element, column, layout, index, index + 1, this.model.width);
    setAttribute(cell.element, "aria-colindex", String(index + 1));
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
    if (focus && focus.rowIndex < 0 && this.#controls.keyDown(event, focus.column)) return;
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
      const before = model.selectionRevision;
      const expansion = this.#expansion(focus.rowIndex);
      model.moveFocus(target, { extend: event.shiftKey && !across });
      if (model.selectionRevision !== before) this.#announceSelection();
      // Left and Right expand and collapse groups on their first cell.
      expansion(true);
    } else if ((key === " " || key === "Enter") && focus.rowIndex < 0) {
      model.cycleSort(focus.column, { additive: event.shiftKey });
      this.#announceSort();
    } else if (key === "Enter" && this.#groupAt(focus.rowIndex)) {
      const { key: groupKey, expanded } = this.#groupAt(focus.rowIndex)!;
      const expansion = this.#expansion(focus.rowIndex);
      model.setExpanded(groupKey, !expanded);
      expansion(false);
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
    // Drags of headers, their edges, and their menu buttons are not clicks on cells.
    if (this.#controls.click(event)) return;
    // A press that moved selected text.
    if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > CLICK_SLOP) return;
    const clicked = event.target as Element;
    const cell = clicked.closest("[role=gridcell],[role=columnheader]");
    let target = this.#cellOf(cell);
    if (!target) return;
    const model = this.model;
    // Focus first: listeners of the sort or the selection may change the
    // rows, so the cell is found again after (or the click goes nowhere).
    model.focusCell(target.rowIndex, target.column);
    target = this.#cellOf(cell);
    if (!target) return;
    const { rowIndex, column } = target;
    const group = this.#groupAt(rowIndex);
    if (rowIndex < 0) {
      model.cycleSort(column, { additive: event.shiftKey });
      this.#announceSort();
    } else if (group && clicked.closest(".hg-toggle")) {
      const expansion = this.#expansion(rowIndex);
      model.setExpanded(group.key, !group.expanded);
      expansion(false);
    } else if (clicked.closest(".hg-check")) {
      model.select(rowIndex, "toggle");
      this.#announceSelection();
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
    const rowIndex = row.ref ? this.model.indexOf(row.ref) : -1;
    return rowIndex < 0 ? null : { rowIndex, column: cell.id };
  }

  /** The group whose header is at `rowIndex`, as it is now; null for other rows. */
  #groupAt(rowIndex: number): (ShownRow & { kind: "group" }) | null {
    if (rowIndex < 0 || !this.model.grouped) return null;
    const row = this.model.row(rowIndex);
    return row.kind === "group" ? row : null;
  }

  /**
   * What says, after a command, whether the group at `rowIndex` (named as it
   * is now: listeners of the command may move it) expanded or collapsed;
   * with `changed`, only if it did.
   */
  #expansion(rowIndex: number): (changed: boolean) => void {
    const group = this.#groupAt(rowIndex);
    if (!group) return () => {};
    const name = this.model.textAt(rowIndex, 0);
    return (changed) => {
      const expanded = this.model.isExpanded(group.key);
      if (!changed || expanded !== group.expanded)
        this.#say(`${name} ${expanded ? "expanded" : "collapsed"}`);
    };
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
      count === null
        ? "Matching rows selected"
        : count === 0
          ? "No rows selected"
          : count === 1
            ? "1 row selected"
            : `${count} rows selected`,
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

/**
 * Places a cell over shown columns `start` to `end` (one column's, or a
 * header's over several) at `column`'s offset, width, and edge, in a grid of
 * columns `width` wide: cells of columns held at an edge are in the row's
 * flow and stick there (sticky offsets are their distances from the edge);
 * the others are placed absolutely, and scroll under them.
 */
export function placeCell(
  element: HTMLElement,
  column: Pick<GridColumnLayout, "x" | "width" | "pinned" | "align">,
  layout: readonly GridColumnLayout[],
  start: number,
  end: number,
  width: number,
) {
  const style = element.style;
  const { pinned } = column;
  // The first cell held at the right goes after the others in the row's flow.
  const first = pinned === "right" && layout[start - 1]?.pinned !== "right";
  const last = pinned === "left" && layout[end]?.pinned !== "left";
  // Most cells keep their place when one column resizes: write only what changed.
  const set = (name: "left" | "right" | "marginLeft" | "width", value: string) => {
    if (style[name] !== value) style[name] = value;
  };
  set("left", pinned === "right" ? "" : `${column.x}px`);
  set("right", pinned === "right" ? `${width - column.x - column.width}px` : "");
  set("marginLeft", first ? "auto" : "");
  set("width", `${column.width}px`);
  setAttribute(element, "data-pin", pinned ?? "");
  // The boundary between held columns and those scrolling under them.
  setAttribute(element, "data-edge", first || last ? pinned! : "");
  setAttribute(element, "data-align", column.align);
}

/** Sets an attribute unless it has the value; an empty value for `data-` attributes removes it. */
export function setAttribute(target: Element, name: string, value: string) {
  if (value === "" && name.startsWith("data-")) {
    if (target.hasAttribute(name)) target.removeAttribute(name);
  } else if (target.getAttribute(name) !== value) target.setAttribute(name, value);
}

export function setText(text: Text, value: string) {
  if (text.data !== value) text.data = value;
}

/**
 * The shown columns to mount, in order: those held at the left edge, the
 * scrolling ones in range (with the focused cell's column when outside it),
 * and those held at the right edge.
 */
function columnsOf(
  { columnStart: start, columnEnd: end }: GridRange,
  keep: GridFocus | null,
  layout: readonly GridColumnLayout[],
): number[] {
  const indices: number[] = [];
  let left = 0;
  while (left < layout.length && layout[left]!.pinned === "left") indices.push(left++);
  let right = layout.length;
  while (right > left && layout[right - 1]!.pinned === "right") right--;
  const index = keep?.columnIndex ?? -1;
  const extra = index >= left && index < right && (index < start || index >= end) ? index : -1;
  if (extra >= 0 && extra < start) indices.push(extra);
  for (let i = start; i < end; i++) indices.push(i);
  if (extra >= end) indices.push(extra);
  for (let i = right; i < layout.length; i++) indices.push(i);
  return indices;
}

/**
 * Puts `elements` in `parent` in this order, with no other children. The
 * element `fixed` holds the page's focus and stays put; the others move
 * around it, each only if it is out of place.
 */
export function arrange(parent: Element, elements: readonly Element[], fixed: Element | null) {
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
