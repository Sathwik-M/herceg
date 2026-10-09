// The contract between the grid harness and one grid library, plus the
// layout every grid is configured with.

import type { GridTable } from "./fixture.ts";

/** Same geometry for every grid, in CSS pixels. */
export const GRID_WIDTH = 1200;
export const GRID_HEIGHT = 600;
export const ROW_HEIGHT = 28;
export const HEADER_HEIGHT = 32;
export const COLUMN_WIDTH = 120;
/** Rows rendered beyond the viewport, for grids that render DOM rows and let it be configured. */
export const OVERSCAN_ROWS = 10;

export interface SortKey {
  field: string;
  descending: boolean;
}

/**
 * A row filter. Ranges are inclusive at both ends; missing values never
 * pass. `in` keeps rows whose category label is one of `labels`.
 */
export type RowFilter =
  | { kind: "range"; field: string; min: number; max: number }
  | { kind: "in"; field: string; labels: string[] };

/**
 * What the grid shows now, read from what it rendered: DOM rows and cells,
 * or for a canvas grid the region it last drew.
 */
export interface Visible {
  /** Rows the grid's rendered extent stands for (its scrollable height, or row count attribute). */
  count: number;
  /**
   * Identities of rows at least partly inside the body viewport, top to
   * bottom; undefined where the rendered row carries none (it is then checked
   * by its cells' text alone).
   */
  rows: (number | undefined)[];
  /** Field indices of columns at least partly inside it, left to right. */
  columns: number[];
  /** Cell text: `text[r][c]` for `rows[r]` and `columns[c]`. */
  text: string[][];
  /** Whether each of `rows` is shown as selected. */
  selected: boolean[];
  /** Scroll offset of the shown body content and the body viewport's size. */
  top: number;
  left: number;
  width: number;
  height: number;
  /**
   * Content pixels one scrollbar pixel moves, for grids that scale content
   * too tall for the browser; 1 (the default) otherwise. Scrolling lands
   * within this of the requested offset.
   */
  scrollStep?: number;
}

/**
 * A mounted grid. Every operation applies one change through the library's
 * documented API; the harness then waits for frames until `visible()` shows
 * the correct result. Optional operations a library cannot do are left out,
 * and the adapter says why in `Adapter.unsupported`.
 */
export interface GridHandle {
  visible(): Visible | undefined;
  /** Rows the grid currently displays (after filtering). */
  rowCount(): number;
  /** Identities of all displayed rows in display order, read from the library's row model. */
  order(): ArrayLike<number>;
  /** Scrolls the body to pixel offsets, the way a user's scroll would. */
  scrollTo(top: number, left: number): void;
  /** Where the body is scrolled now (the browser's offsets, in content pixels), whatever the grid has drawn. */
  scrollOffset(): { top: number; left: number };
  /** Replaces the sort; an empty list restores source order. */
  sort(keys: SortKey[]): void | Promise<void>;
  /** Replaces the filter; null removes it. */
  filter(filter: RowFilter | null): void | Promise<void>;
  /** Appends rows after the newest and removes the `evict` oldest rows. */
  append(batch: GridTable, evict: number): void;
  /** Sets field `field` of the rows with identities `ids`. */
  update(field: number, ids: ArrayLike<number>, values: Float64Array): void;
  /** Selects the displayed rows [start, end) in display order, replacing the selection. */
  selectRange(start: number, end: number): void;
  clearSelection(): void;
  /** Identities of the selected rows, in any order. */
  selectedIds(): ArrayLike<number>;
  destroy(): void;
}

export type Operation = "sort" | "filter" | "append" | "update" | "select";

export interface Adapter {
  id: string;
  /** How the grid draws and its notable settings, recorded with results. */
  renderer: string;
  /** Who sorts and filters: the library, or code in the adapter (labeled in reports). */
  processing: { sort: string; filter: string };
  /** Operations the library cannot do, with the reason. */
  unsupported?: Partial<Record<Operation, string>>;
  /**
   * Converts the shared columnar fixture into the library's native input
   * (row objects, or nothing for grids that read columns through a callback).
   */
  prepare(table: GridTable): unknown;
  /** Mounts a grid in `container` (GRID_WIDTH x GRID_HEIGHT) from `prepare`'s output. */
  mount(container: HTMLElement, table: GridTable, input: unknown): GridHandle | Promise<GridHandle>;
}

/** Row objects for libraries that take them: `id` plus one property per field. */
export type RowObject = Record<string, number | string | undefined> & { id: number };

/** Row objects with missing values as `undefined` and categories as labels. */
export function rowObjects(table: GridTable): RowObject[] {
  const { fields, columns, dictionaries, length, firstId } = table;
  const rows = new Array<RowObject>(length);
  for (let i = 0; i < length; i++) {
    const row: RowObject = { id: firstId + i };
    for (let f = 0; f < fields.length; f++) {
      const value = columns[f]![i]!;
      if (fields[f]!.kind === "category")
        row[fields[f]!.name] = value < 0 ? undefined : dictionaries[f]![value];
      else row[fields[f]!.name] = Number.isNaN(value) ? undefined : value;
    }
    rows[i] = row;
  }
  return rows;
}

/** A rectangle in client (viewport) coordinates. */
export interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * The client box of an element's scrollport: inside its borders, without
 * scrollbars, less `header` pixels at the top covered by a sticky header.
 */
export function scrollport(element: Element, header = 0): Box {
  const box = element.getBoundingClientRect();
  const top = box.top + element.clientTop;
  const left = box.left + element.clientLeft;
  return {
    top: top + header,
    bottom: top + element.clientHeight,
    left,
    right: left + element.clientWidth,
  };
}

/** Elements and attribute readers for `readDomVisible`. */
export interface DomGrid {
  /** Rows the rendered extent stands for. */
  count: number;
  /** The body viewport: where rows are visible. */
  view: Box;
  /** Scroll offsets of the body content. */
  top: number;
  left: number;
  rows: Iterable<Element>;
  rowId(row: Element): number | undefined;
  cells(row: Element): Iterable<Element>;
  cellField(cell: Element): number;
  selected(row: Element): boolean;
}

/**
 * Reads rows and cells that intersect the body viewport from the DOM, by
 * geometry, so rows rendered for overscan or left behind are not counted.
 */
export function readDomVisible(grid: DomGrid): Visible {
  const { view } = grid;
  const shown: { y: number; row: Element }[] = [];
  for (const row of grid.rows) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom > view.top + 0.5 && rect.top < view.bottom - 0.5)
      shown.push({ y: rect.top, row });
  }
  shown.sort((a, b) => a.y - b.y);
  const columns: number[] = [];
  const text: string[][] = [];
  shown.forEach(({ row }, r) => {
    const cells: { x: number; field: number; text: string }[] = [];
    for (const cell of grid.cells(row)) {
      const rect = cell.getBoundingClientRect();
      if (rect.right > view.left + 0.5 && rect.left < view.right - 0.5)
        cells.push({ x: rect.left, field: grid.cellField(cell), text: cell.textContent ?? "" });
    }
    cells.sort((a, b) => a.x - b.x);
    if (r === 0) columns.push(...cells.map((cell) => cell.field));
    // Align every row with the first row's columns; a missing cell reads as blank.
    const byField = new Map(cells.map((cell) => [cell.field, cell.text]));
    text.push(columns.map((field) => byField.get(field) ?? ""));
  });
  return {
    count: grid.count,
    rows: shown.map(({ row }) => grid.rowId(row)),
    columns,
    text,
    selected: shown.map(({ row }) => grid.selected(row)),
    top: grid.top,
    left: grid.left,
    width: view.right - view.left,
    height: view.bottom - view.top,
  };
}
