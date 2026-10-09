// Herceg's grid (`herceg/grid`) over a row view of a table built from the
// fixture's typed columns without copying them. Sorting and filtering go
// through the view (`setQuery`); appends, evictions, and updates go through
// the table (`append`, `dropFirst`, `set`), and the view and grid follow it.
// Columns use the shared Intl formats, start alignment (Herceg aligns
// numbers to the end by default), and the default 10 rows of overscan.
// Scrolling sets the grid's scroll offset as a user's scroll would; when the
// scroller is already at the offset, it tells the model (`scrollTo`), which
// matters after Herceg kept the rows in view in place across a change.

import { col, encodedCategory, rowView, type Schema, Table, time } from "herceg";
import { createGrid, createGridModel, type GridColumn, type GridModel } from "herceg/grid";
import {
  type Adapter,
  COLUMN_WIDTH,
  type GridHandle,
  HEADER_HEIGHT,
  ROW_HEIGHT,
  readDomVisible,
  scrollport,
} from "../adapter.ts";
import { FORMAT, type GridTable } from "../fixture.ts";

export const THEME = { extends: "light", font: "Arial, sans-serif", fontSize: 13 } as const;

/** A Herceg table over the fixture's arrays: numbers and times adopted, categories by code. */
export function hercegTable(fixture: GridTable): Table<Schema> {
  const columns = Object.fromEntries(
    fixture.fields.map((field, f) => {
      const values = fixture.columns[f]!;
      if (field.kind === "category")
        return [field.name, encodedCategory(values as Int32Array, fixture.dictionaries[f]!)];
      return [field.name, field.kind === "time" ? time(values) : values];
    }),
  );
  return new Table<Schema>(columns);
}

/** A batch as `Table.append` takes it: typed arrays, and category labels. */
function batchOf(batch: GridTable): Record<string, Float64Array | (string | null)[]> {
  return Object.fromEntries(
    batch.fields.map((field, f) => {
      const values = batch.columns[f]!;
      if (field.kind !== "category") return [field.name, values as Float64Array];
      const dictionary = batch.dictionaries[f]!;
      return [field.name, Array.from(values, (code) => (code < 0 ? null : dictionary[code]!))];
    }),
  );
}

/**
 * A handle over a Herceg table, view, and model, for a grid that `attach`
 * puts in `container` (directly, or through @herceg/react).
 */
export function hercegHandle(
  container: HTMLElement,
  fixture: GridTable,
  source: Table<Schema>,
  attach: (model: GridModel<Schema>) => { destroy(): void },
): GridHandle {
  const view = rowView(source);
  const columns: GridColumn<Schema>[] = fixture.fields.map((field) => ({
    field: field.name,
    width: COLUMN_WIDTH,
    align: "start",
    ...(field.kind === "number" && { format: FORMAT.number }),
    ...(field.kind === "time" && { format: FORMAT.time }),
  }));
  const model = createGridModel({
    data: view,
    columns,
    rowHeight: ROW_HEIGHT,
    locale: FORMAT.locale,
    timeZone: FORMAT.timeZone,
    missing: FORMAT.missing,
  });
  const grid = attach(model);
  const scroller = () => container.querySelector<HTMLElement>(".hg-scroller")!;
  /** Rows the grid last drew a row count for (its aria-rowcount counts the header row too). */
  const drawnRows = (element: Element) => Number(element.getAttribute("aria-rowcount")) - 1;
  /**
   * Content pixels per scroller pixel: above 1 when rows are taller than the
   * browser allows. Read from the DOM, so reading it does no work in the grid.
   */
  const ratio = () => {
    const element = scroller();
    const range = element.scrollHeight - element.clientHeight;
    const content = drawnRows(element) * ROW_HEIGHT - (element.clientHeight - HEADER_HEIGHT);
    return range > 0 ? Math.max(1, content / range) : 1;
  };

  return {
    visible() {
      const element = container.querySelector(".hg-scroller");
      const header = container.querySelector(".hg-header");
      const body = container.querySelector(".hg-body");
      if (!element || !header || !body) return undefined;
      const rows = body.querySelectorAll("[role=row]");
      const index = (row: Element) => Number(row.getAttribute("aria-rowindex")) - 2;
      // Rows sit at their logical offset less a shift when scrolling is scaled.
      const first = rows[0];
      const shift = first
        ? index(first) * ROW_HEIGHT -
          (first.getBoundingClientRect().top - body.getBoundingClientRect().top)
        : 0;
      const view = scrollport(element);
      view.top = header.getBoundingClientRect().bottom;
      return {
        ...readDomVisible({
          count: drawnRows(element),
          view,
          top: element.scrollTop + shift,
          left: element.scrollLeft,
          rows,
          // Rows carry no identity in the DOM; they are checked by their cells' text.
          rowId: () => undefined,
          cells: (row) => row.querySelectorAll("[role=gridcell]"),
          cellField: (cell) => Number(cell.getAttribute("aria-colindex")) - 1,
          selected: (row) => row.getAttribute("aria-selected") === "true",
        }),
        scrollStep: ratio(),
      };
    },
    rowCount: () => model.rowCount,
    order() {
      const { indices, length, rowOffset } = view.read();
      return Uint32Array.from({ length }, (_, i) => rowOffset + (indices ? indices[i]! : i));
    },
    scrollTo(top, left) {
      const element = scroller();
      const physical = top / ratio();
      if (
        Math.abs(element.scrollTop - physical) < 0.5 &&
        Math.abs(element.scrollLeft - left) < 0.5
      ) {
        // No scroll event will come; the model may still be elsewhere.
        model.scrollTo({ top, left });
        return;
      }
      element.scrollTop = physical;
      element.scrollLeft = left;
    },
    scrollOffset() {
      const element = scroller();
      return { top: element.scrollTop * ratio(), left: element.scrollLeft };
    },
    sort(keys) {
      view.setQuery({
        ...view.query,
        sort: keys.map((key) => ({
          field: key.field,
          order: key.descending ? "descending" : "ascending",
        })),
      });
    },
    filter(filter) {
      const field = filter && col(filter.field);
      const expression = !filter
        ? undefined
        : filter.kind === "range"
          ? field!.ge(filter.min).and(field!.le(filter.max))
          : field!.isIn(...filter.labels);
      view.setQuery({ ...view.query, filter: expression });
    },
    append(batch, evict) {
      if (evict > 0) source.dropFirst(evict);
      source.append(batchOf(batch));
    },
    update(field, ids, values) {
      const name = fixture.fields[field]!.name;
      const offset = source.rowOffset;
      for (let i = 0; i < ids.length; i++) source.set(name, ids[i]! - offset, values[i]!);
    },
    selectRange(start, end) {
      model.select(start, "only");
      if (end - 1 > start) model.select(end - 1, "range");
    },
    clearSelection: () => {
      model.clearSelection();
    },
    selectedIds() {
      const selection = model.selection.get(model.channel);
      if (selection?.kind !== "rows") return [];
      const offset = source.rowOffset;
      return Array.from(selection.rows.positions(), (position) => offset + position);
    },
    destroy() {
      grid.destroy();
      model.dispose();
      view.dispose();
    },
  };
}

export const adapter: Adapter = {
  id: "herceg",
  renderer: "DOM rows and cells (10 rows and 2 columns of overscan)",
  processing: { sort: "native (row view)", filter: "native (row view, expression)" },
  prepare: hercegTable,
  mount: (container, fixture, input) =>
    hercegHandle(container, fixture, input as Table<Schema>, (model) =>
      createGrid(container, {
        model,
        ariaLabel: "Benchmark grid",
        headerHeight: HEADER_HEIGHT,
        theme: THEME,
      }),
    ),
};
