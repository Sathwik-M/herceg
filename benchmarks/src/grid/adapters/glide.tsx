// Glide Data Grid in production React. It draws cells on a canvas and asks
// for each one through `getCellContent`, so the adapter keeps the fixture's
// typed columns as they are (no row objects) and formats a cell when Glide
// asks for it. Pixel scrolling (smoothScrollX/Y), no row markers, read-only
// text cells, stable callbacks, and `updateCells` for changed values whose
// order is unchanged.
//
// Glide has no row model: it shows rows 0..rows-1 and leaves sorting and
// filtering to the application. Here they are adapter code (an index of row
// identities sorted with a typed-array comparator, appended rows merged in),
// declared as external in the results: they measure Glide as a renderer over
// this implementation, not processing of Glide's own.
//
// What is visible is the region Glide last drew, recorded when React commits
// it (Glide draws in a layout effect of that commit), and for each of its
// cells what Glide last drew there: the row identity and text the cell
// carried and whether Glide highlighted it, recorded through `drawCell`
// (which then draws the cell as usual). The canvas pixels are not read.

import "@glideapps/glide-data-grid/dist/index.css";
import {
  CompactSelection,
  DataEditor,
  type DataEditorRef,
  type DrawCellCallback,
  type GridCell,
  GridCellKind,
  type GridColumn,
  type GridSelection,
  type Item,
  type TextCell,
} from "@glideapps/glide-data-grid";
import { type RefObject, useLayoutEffect, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import {
  type Adapter,
  COLUMN_WIDTH,
  GRID_HEIGHT,
  GRID_WIDTH,
  type GridHandle,
  HEADER_HEIGHT,
  ROW_HEIGHT,
  type RowFilter,
  type SortKey,
  type Visible,
} from "../adapter.ts";
import { formatValue, type GridField, type GridTable } from "../fixture.ts";

const THEME = {
  fontFamily: "Arial, sans-serif",
  baseFontStyle: "13px",
  headerFontStyle: "600 13px",
  cellHorizontalPadding: 8,
};

/**
 * The fixture's columns, extended by appends and evicted from the front.
 * Row identity `id` is at index `id - base`; columns are copied before the
 * first write, so the fixture is never changed.
 */
class Store {
  readonly fields: GridField[];
  readonly dictionaries: string[][];
  columns: (Float64Array | Int32Array)[];
  #owned: boolean[];
  base: number;
  /** Live rows are indices [start, end). */
  start = 0;
  end: number;

  constructor(table: GridTable) {
    this.fields = table.fields;
    this.dictionaries = table.dictionaries;
    this.columns = [...table.columns];
    this.#owned = table.columns.map(() => false);
    this.base = table.firstId;
    this.end = table.length;
  }

  get length(): number {
    return this.end - this.start;
  }

  get firstId(): number {
    return this.base + this.start;
  }

  append(batch: GridTable, evict: number): void {
    this.start = Math.min(this.end, this.start + evict);
    const needed = this.end + batch.length;
    const capacity = this.columns[0]!.length;
    if (needed > capacity) {
      // Grow by half, dropping evicted rows at the front.
      const length = this.length;
      const size = Math.max(needed - this.start, Math.ceil(length * 1.5) + batch.length);
      this.columns = this.columns.map((column) => {
        const grown = new (column.constructor as Float64ArrayConstructor | Int32ArrayConstructor)(
          size,
        );
        grown.set(column.subarray(this.start, this.end));
        return grown;
      });
      this.#owned = this.columns.map(() => true);
      this.base += this.start;
      this.end = length;
      this.start = 0;
    }
    batch.columns.forEach((values, f) => {
      this.#own(f);
      this.columns[f]!.set(values, this.end);
    });
    this.end += batch.length;
  }

  set(field: number, id: number, value: number): void {
    this.#own(field);
    this.columns[field]![id - this.base] = value;
  }

  #own(field: number) {
    if (this.#owned[field]) return;
    this.columns[field] = this.columns[field]!.slice();
    this.#owned[field] = true;
  }

  text(id: number, field: number): string {
    const value = this.columns[field]![id - this.base]!;
    const kind = this.fields[field]!.kind;
    if (kind === "category")
      return formatValue(kind, value < 0 ? undefined : this.dictionaries[field]![value]);
    return formatValue(kind, value);
  }

  /** Row identities passing `filter`, among `[from, end)` identities. */
  matching(filter: RowFilter | null, from: number): number[] {
    const ids: number[] = [];
    const last = this.base + this.end;
    if (!filter) {
      for (let id = from; id < last; id++) ids.push(id);
      return ids;
    }
    const f = this.fields.findIndex((field) => field.name === filter.field);
    const column = this.columns[f]!;
    if (filter.kind === "range") {
      for (let id = from; id < last; id++) {
        const v = column[id - this.base]!;
        if (v >= filter.min && v <= filter.max) ids.push(id);
      }
    } else {
      const wanted = new Uint8Array(this.dictionaries[f]!.length);
      for (const label of filter.labels) {
        const code = this.dictionaries[f]!.indexOf(label);
        if (code >= 0) wanted[code] = 1;
      }
      for (let id = from; id < last; id++) {
        const code = column[id - this.base]!;
        if (code >= 0 && wanted[code]) ids.push(id);
      }
    }
    return ids;
  }

  /** Compares rows by identity: keys in order, missing values last, then identity. */
  comparator(keys: readonly SortKey[]): (a: number, b: number) => number {
    const compares = keys.map((key) => {
      const f = this.fields.findIndex((field) => field.name === key.field);
      const column = this.columns[f]!;
      const sign = key.descending ? -1 : 1;
      const base = this.base;
      if (this.fields[f]!.kind === "category") {
        // Codes are not in label order: compare their ranks.
        const dictionary = this.dictionaries[f]!;
        const byLabel = dictionary
          .map((_, code) => code)
          .sort((x, y) => (dictionary[x]! < dictionary[y]! ? -1 : 1));
        const rank = new Int32Array(dictionary.length);
        byLabel.forEach((code, place) => {
          rank[code] = place;
        });
        return (a: number, b: number) => {
          const x = column[a - base]!;
          const y = column[b - base]!;
          if (x < 0 || y < 0) return x < 0 ? (y < 0 ? 0 : 1) : -1;
          return (rank[x]! - rank[y]!) * sign;
        };
      }
      return (a: number, b: number) => {
        const x = column[a - base]!;
        const y = column[b - base]!;
        if (x < y) return -sign;
        if (x > y) return sign;
        if (x === y) return 0;
        return Number.isNaN(x) ? (Number.isNaN(y) ? 0 : 1) : -1;
      };
    });
    return (a, b) => {
      for (const compare of compares) {
        const order = compare(a, b);
        if (order !== 0) return order;
      }
      return a - b;
    };
  }
}

/** Merges two lists sorted by `compare`. */
function merge(
  a: Uint32Array,
  b: Uint32Array,
  compare: (x: number, y: number) => number,
): Uint32Array {
  const out = new Uint32Array(a.length + b.length);
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < a.length && j < b.length) out[k++] = compare(a[i]!, b[j]!) <= 0 ? a[i++]! : b[j++]!;
  while (i < a.length) out[k++] = a[i++]!;
  while (j < b.length) out[k++] = b[j++]!;
  return out;
}

interface Shown {
  /** Changes whenever the data, order, or selection changes. */
  version: number;
  rows: number;
  getCellContent: (cell: Item) => GridCell;
  selection: GridSelection;
}

interface Drawn {
  version: number;
  rows: number;
  /** First column and row drawn, and how far each is scrolled past (tx, ty <= 0). */
  x: number;
  y: number;
  tx: number;
  ty: number;
}

/** A text cell that also carries its row's identity, so drawing can record it. */
type RowCell = TextCell & { readonly rowId: number };

interface GridProps {
  shown: Shown;
  columns: GridColumn[];
  editor: RefObject<DataEditorRef | null>;
  drawn: RefObject<Drawn | null>;
  drawCell: DrawCellCallback;
}

function Grid({ shown, columns, editor, drawn, drawCell }: GridProps) {
  const [region, setRegion] = useState<Omit<Drawn, "version" | "rows"> | null>(null);
  // Runs after Glide's own layout effects, in which it draws this commit.
  useLayoutEffect(() => {
    if (region) drawn.current = { version: shown.version, rows: shown.rows, ...region };
  });
  return (
    <DataEditor
      ref={editor}
      width={GRID_WIDTH}
      height={GRID_HEIGHT}
      columns={columns}
      rows={shown.rows}
      getCellContent={shown.getCellContent}
      gridSelection={shown.selection}
      rowHeight={ROW_HEIGHT}
      headerHeight={HEADER_HEIGHT}
      smoothScrollX
      smoothScrollY
      rowMarkers="none"
      theme={THEME}
      drawCell={drawCell}
      onVisibleRegionChanged={(range, tx, ty) => setRegion({ x: range.x, y: range.y, tx, ty })}
    />
  );
}

function mount(container: HTMLElement, table: GridTable, input: unknown): GridHandle {
  const store = input as Store;
  const columns: GridColumn[] = table.fields.map((field) => ({
    id: field.name,
    title: field.name,
    width: COLUMN_WIDTH,
  }));
  const editor: RefObject<DataEditorRef | null> = { current: null };
  const drawn: RefObject<Drawn | null> = { current: null };
  let query: { sort: SortKey[]; filter: RowFilter | null } = { sort: [], filter: null };
  /** Identities in display order; null while every row shows in identity order. */
  let order: Uint32Array | null = null;
  let selection: { start: number; end: number } | null = null;
  let version = 0;
  /** What Glide last drew in each cell (row * columns + column). */
  const painted = new Map<number, { id: number; text: string; highlighted: boolean }>();
  const drawCell: DrawCellCallback = (args, drawContent) => {
    const cell = args.cell as RowCell;
    painted.set(args.row * columns.length + args.col, {
      id: cell.rowId,
      text: cell.displayData,
      highlighted: args.highlighted,
    });
    drawContent();
  };
  const idAt = (row: number) => (order ? order[row]! : store.firstId + row);
  const rowCount = () => (order ? order.length : store.length);

  const root = createRoot(container);
  const render = () => {
    version++;
    const getCellContent = ([col, row]: Item): GridCell => {
      const id = idAt(row);
      const text = store.text(id, col);
      const cell: RowCell = {
        kind: GridCellKind.Text,
        data: text,
        displayData: text,
        allowOverlay: false,
        readonly: true,
        rowId: id,
      };
      return cell;
    };
    const rows = selection
      ? CompactSelection.fromSingleSelection([selection.start, selection.end])
      : CompactSelection.empty();
    const shown: Shown = {
      version,
      rows: rowCount(),
      getCellContent,
      selection: { columns: CompactSelection.empty(), rows, current: undefined },
    };
    flushSync(() =>
      root.render(
        <Grid shown={shown} columns={columns} editor={editor} drawn={drawn} drawCell={drawCell} />,
      ),
    );
  };
  const rebuild = () => {
    const { sort, filter } = query;
    if (sort.length === 0 && !filter) {
      order = null;
      return;
    }
    const ids = Uint32Array.from(store.matching(filter, store.firstId));
    if (sort.length > 0) ids.sort(store.comparator(sort));
    order = ids;
  };
  render();
  const scroller = () => container.querySelector<HTMLElement>(".dvn-scroller")!;

  return {
    visible(): Visible | undefined {
      const region = drawn.current;
      // Not drawn yet, or drawn before the latest change.
      if (!region || region.version !== version) return undefined;
      const element = scroller();
      const height = element.clientHeight - HEADER_HEIGHT;
      const width = element.clientWidth;
      const top = region.y * ROW_HEIGHT - region.ty;
      const left = region.x * COLUMN_WIDTH - region.tx;
      const rows: number[] = [];
      for (let row = region.y; row < region.rows && row * ROW_HEIGHT < top + height - 0.5; row++)
        rows.push(row);
      const fields: number[] = [];
      for (
        let col = region.x;
        col < columns.length && col * COLUMN_WIDTH < left + width - 0.5;
        col++
      )
        fields.push(col);
      const at = (row: number, col: number) => painted.get(row * columns.length + col);
      return {
        count: region.rows,
        rows: rows.map((row) => at(row, fields[0]!)?.id ?? -1),
        columns: fields,
        text: rows.map((row) => fields.map((col) => at(row, col)?.text ?? "(not drawn)")),
        selected: rows.map((row) => at(row, fields[0]!)?.highlighted ?? false),
        top,
        left,
        width,
        height,
      };
    },
    rowCount,
    order: () =>
      order ? order : Uint32Array.from({ length: store.length }, (_, i) => store.firstId + i),
    scrollTo(top, left) {
      const element = scroller();
      element.scrollTop = top;
      element.scrollLeft = left;
    },
    scrollOffset: () => ({ top: scroller().scrollTop, left: scroller().scrollLeft }),
    sort(keys) {
      query = { ...query, sort: keys };
      rebuild();
      render();
    },
    filter(filter) {
      query = { ...query, filter };
      rebuild();
      render();
    },
    append(batch, evict) {
      const firstNew = batch.firstId;
      store.append(batch, evict);
      if (order) {
        const kept = evict > 0 ? order.filter((id) => id >= store.firstId) : order;
        const added = Uint32Array.from(store.matching(query.filter, firstNew));
        const compare = store.comparator(query.sort);
        if (query.sort.length > 0) added.sort(compare);
        order = merge(kept, added, compare);
      }
      render();
    },
    update(field, ids, values) {
      for (let i = 0; i < ids.length; i++) store.set(field, ids[i]!, values[i]!);
      const name = table.fields[field]!.name;
      const reordered =
        query.filter?.field === name || query.sort.some((key) => key.field === name);
      if (reordered) {
        // Take the changed rows out and merge them back in at their new places.
        const changed = new Set(Array.from(ids));
        const kept = order!.filter((id) => !changed.has(id));
        const moved = Uint32Array.from(
          store.matching(query.filter, store.firstId).filter((id) => changed.has(id)),
        );
        const compare = store.comparator(query.sort);
        moved.sort(compare);
        order = merge(kept, moved, compare);
        render();
        return;
      }
      // Same order: redraw only the changed cells that are on screen.
      const region = drawn.current;
      const changed = new Set(Array.from(ids));
      const cells: { cell: Item }[] = [];
      if (region) {
        for (let row = region.y; row < Math.min(rowCount(), region.y + 40); row++)
          if (changed.has(idAt(row))) cells.push({ cell: [field, row] });
      }
      // updateCells draws them at once; the rest of what was drawn still holds.
      editor.current!.updateCells(cells);
    },
    selectRange(start, end) {
      selection = { start, end };
      render();
    },
    clearSelection() {
      selection = null;
      render();
    },
    selectedIds() {
      if (!selection) return [];
      return Array.from({ length: selection.end - selection.start }, (_, i) =>
        idAt(selection!.start + i),
      );
    },
    destroy: () => root.unmount(),
  };
}

export const adapter: Adapter = {
  id: "glide",
  renderer: "Canvas 2D, React 19 (pixel scrolling, no row markers)",
  processing: {
    sort: "external: adapter code (typed-array index sort, merge on append)",
    filter: "external: adapter code (typed-array scan)",
  },
  prepare: (table) => new Store(table),
  mount,
};
