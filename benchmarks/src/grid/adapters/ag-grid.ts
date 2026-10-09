// AG Grid Community, vanilla JavaScript, client-side row model. Configured
// as its documentation recommends for large and changing data: row objects
// with stable ids (`getRowId`), transactions for appends, evictions, and
// updates (applied synchronously; the async path batches for 50 ms), delta
// sorting for transactions under a sort, `rowBuffer` 10, row and column
// virtualization on, animations off, and only the Community modules the
// scenarios use. Sorting is native with a comparator that keeps missing
// values last in both directions (AG Grid's default puts them first when
// ascending). The number range filter is the native number filter; category
// membership uses the external filter, since Community has no set filter.

import {
  ClientSideRowModelApiModule,
  ClientSideRowModelModule,
  type ColDef,
  ColumnApiModule,
  createGrid,
  ExternalFilterModule,
  type GridApi,
  type IRowNode,
  ModuleRegistry,
  NumberFilterModule,
  RowApiModule,
  RowSelectionModule,
  themeQuartz,
} from "ag-grid-community";
import {
  type Adapter,
  COLUMN_WIDTH,
  type GridHandle,
  HEADER_HEIGHT,
  OVERSCAN_ROWS,
  ROW_HEIGHT,
  type RowFilter,
  type RowObject,
  readDomVisible,
  rowObjects,
  scrollport,
} from "../adapter.ts";
import { formatValue, type GridTable } from "../fixture.ts";

ModuleRegistry.registerModules([
  ClientSideRowModelModule,
  ClientSideRowModelApiModule,
  ColumnApiModule,
  RowApiModule,
  NumberFilterModule,
  ExternalFilterModule,
  RowSelectionModule,
]);

const theme = themeQuartz.withParams({
  fontFamily: "Arial, sans-serif",
  fontSize: 13,
  headerFontSize: 13,
  rowHeight: ROW_HEIGHT,
  headerHeight: HEADER_HEIGHT,
  cellHorizontalPadding: 8,
  wrapperBorder: false,
  wrapperBorderRadius: 0,
});

type Value = number | string | undefined;

/** Ascending order with missing values last; AG Grid negates the result for descending sorts. */
function missingLast(
  a: Value,
  b: Value,
  _nodeA: unknown,
  _nodeB: unknown,
  descending: boolean,
): number {
  const am = a === undefined;
  const bm = b === undefined;
  if (am || bm) {
    if (am === bm) return 0;
    // Negated afterwards when descending, so missing values still land last.
    return (am ? 1 : -1) * (descending ? -1 : 1);
  }
  return a! < b! ? -1 : a! > b! ? 1 : 0;
}

function mount(container: HTMLElement, table: GridTable, input: unknown): GridHandle {
  const fields = table.fields;
  let membership: { field: string; labels: Set<string> } | null = null;
  const columnDefs: ColDef<RowObject>[] = fields.map((field) => ({
    field: field.name,
    headerName: field.name,
    width: COLUMN_WIDTH,
    resizable: false,
    suppressMovable: true,
    sortable: true,
    comparator: missingLast,
    valueFormatter: (params) => formatValue(field.kind, params.value as Value),
    filter: field.kind === "number" ? "agNumberColumnFilter" : false,
    filterParams: { inRangeInclusive: true },
  }));
  const api: GridApi<RowObject> = createGrid(container, {
    theme,
    columnDefs,
    rowData: input as RowObject[],
    getRowId: (params) => String(params.data.id),
    rowHeight: ROW_HEIGHT,
    headerHeight: HEADER_HEIGHT,
    rowBuffer: OVERSCAN_ROWS,
    animateRows: false,
    suppressColumnMoveAnimation: true,
    deltaSort: true,
    rowSelection: {
      mode: "multiRow",
      checkboxes: false,
      headerCheckbox: false,
      enableClickSelection: false,
    },
    isExternalFilterPresent: () => membership !== null,
    doesExternalFilterPass: (node) =>
      membership!.labels.has(node.data![membership!.field] as string),
  });
  /** Identity of the oldest row, for evictions. */
  let oldest = table.firstId;

  return {
    visible() {
      // One element scrolls both ways; the header (and pinned rows) stick at its top.
      const viewport = container.querySelector(".ag-grid-viewport");
      const header = container.querySelector(".ag-grid-pinned-top-rows");
      const rows = container.querySelector(".ag-grid-scrolling-rows");
      // The grid builds its DOM after createGrid returns.
      if (!viewport || !header || !rows) return undefined;
      const view = scrollport(viewport);
      view.top = header.getBoundingClientRect().bottom;
      return readDomVisible({
        count: Math.round(rows.getBoundingClientRect().height / ROW_HEIGHT),
        view,
        top: viewport.scrollTop,
        left: viewport.scrollLeft,
        rows: container.querySelectorAll(".ag-grid-scrolling-container .ag-row"),
        rowId: (row) => Number(row.getAttribute("row-id")),
        cells: (row) => row.querySelectorAll(".ag-cell"),
        cellField: (cell) =>
          fields.findIndex((field) => field.name === cell.getAttribute("col-id")),
        selected: (row) => row.classList.contains("ag-row-selected"),
      });
    },
    rowCount: () => api.getDisplayedRowCount(),
    order() {
      const ids: number[] = [];
      api.forEachNodeAfterFilterAndSort((node) => ids.push(node.data!.id));
      return ids;
    },
    scrollTo(top, left) {
      const viewport = container.querySelector(".ag-grid-viewport")!;
      viewport.scrollTop = top;
      viewport.scrollLeft = left;
    },
    scrollOffset() {
      const viewport = container.querySelector(".ag-grid-viewport")!;
      return { top: viewport.scrollTop, left: viewport.scrollLeft };
    },
    sort(keys) {
      api.applyColumnState({
        state: keys.map((key, i) => ({
          colId: key.field,
          sort: key.descending ? "desc" : "asc",
          sortIndex: i,
        })),
        defaultState: { sort: null },
      });
    },
    filter(filter: RowFilter | null) {
      // setFilterModel filters by itself; the external filter needs onFilterChanged.
      if (filter?.kind === "range") {
        membership = null;
        api.setFilterModel({
          [filter.field]: {
            filterType: "number",
            type: "inRange",
            filter: filter.min,
            filterTo: filter.max,
          },
        });
        return;
      }
      membership = filter ? { field: filter.field, labels: new Set(filter.labels) } : null;
      if (Object.keys(api.getFilterModel()).length > 0) api.setFilterModel(null);
      else api.onFilterChanged();
    },
    append(batch, evict) {
      const remove = Array.from({ length: evict }, (_, i) => ({ id: oldest + i }) as RowObject);
      oldest += evict;
      api.applyTransaction({ add: rowObjects(batch), remove });
    },
    update(field, ids, values) {
      const name = fields[field]!.name;
      const rows: RowObject[] = [];
      for (let i = 0; i < ids.length; i++) {
        const node = api.getRowNode(String(ids[i]))!;
        rows.push({ ...node.data!, [name]: values[i] });
      }
      api.applyTransaction({ update: rows });
    },
    selectRange(start, end) {
      const nodes: IRowNode<RowObject>[] = [];
      for (let i = start; i < end; i++) nodes.push(api.getDisplayedRowAtIndex(i)!);
      api.deselectAll();
      api.setNodesSelected({ nodes, newValue: true });
    },
    clearSelection: () => api.deselectAll(),
    selectedIds: () => api.getSelectedNodes().map((node) => node.data!.id),
    destroy: () => api.destroy(),
  };
}

export const adapter: Adapter = {
  id: "ag-grid",
  renderer: "DOM rows and cells (rowBuffer 10, column virtualization), Quartz theme",
  processing: {
    sort: "native (comparator keeping missing values last, delta sort)",
    filter: "native number filter; external filter for category membership",
  },
  prepare: rowObjects,
  mount,
};
