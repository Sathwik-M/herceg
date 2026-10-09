// An independent reference for what a grid should display: row order after
// filtering and sorting, cell text, and checks of what an adapter reports
// against it. It shares no code with the adapters beyond the fixture and the
// formatting functions every grid is configured with.
//
// Semantics: sorts compare numbers and times numerically and categories by
// label (code-unit order), put missing values last in either direction, and
// break ties by row identity, oldest first. Filters drop missing values.

import { COLUMN_WIDTH, ROW_HEIGHT, type RowFilter, type SortKey, type Visible } from "./adapter.ts";
import { formatValue, type GridField, type GridTable } from "./fixture.ts";

type Value = number | string | undefined;

function missing(value: Value): boolean {
  return value === undefined || (typeof value === "number" && Number.isNaN(value));
}

/** Ascending comparison with missing values last in both directions. */
function compare(a: Value, b: Value, descending: boolean): number {
  const am = missing(a);
  const bm = missing(b);
  if (am || bm) return am === bm ? 0 : am ? 1 : -1;
  const order = a! < b! ? -1 : a! > b! ? 1 : 0;
  return descending ? -order : order;
}

/** The rows a table holds over time: the starting table, appended batches, evictions, and updates. */
export class Reference {
  readonly fields: GridField[];
  private readonly chunks: GridTable[] = [];
  /** Updated values per field, by row identity. */
  private readonly overrides: Map<number, number>[];
  /** Live row identities are [start, end). */
  start: number;
  end: number;

  constructor(table: GridTable) {
    this.fields = table.fields;
    this.chunks.push(table);
    this.overrides = table.fields.map(() => new Map());
    this.start = table.firstId;
    this.end = table.firstId + table.length;
  }

  get length(): number {
    return this.end - this.start;
  }

  fieldIndex(name: string): number {
    const index = this.fields.findIndex((field) => field.name === name);
    if (index < 0) throw new Error(`no field ${name}`);
    return index;
  }

  append(batch: GridTable): void {
    if (batch.firstId !== this.end) throw new Error("batches must follow the newest row");
    this.chunks.push(batch);
    this.end += batch.length;
  }

  evict(count: number): void {
    this.start = Math.min(this.end, this.start + count);
  }

  update(field: number, ids: ArrayLike<number>, values: Float64Array): void {
    for (let i = 0; i < ids.length; i++) this.overrides[field]!.set(ids[i]!, values[i]!);
  }

  private chunkOf(id: number): GridTable {
    let lo = 0;
    let hi = this.chunks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.chunks[mid]!.firstId <= id) lo = mid;
      else hi = mid - 1;
    }
    return this.chunks[lo]!;
  }

  /** A number or time (NaN when missing), or a category label (undefined when missing). */
  value(id: number, field: number): Value {
    const chunk = this.chunkOf(id);
    const raw = chunk.columns[field]![id - chunk.firstId]!;
    if (this.fields[field]!.kind === "category")
      return raw < 0 ? undefined : chunk.dictionaries[field]![raw];
    const overrides = this.overrides[field]!;
    return overrides.size > 0 ? (overrides.get(id) ?? raw) : raw;
  }

  text(id: number, field: number): string {
    const value = this.value(id, field);
    return formatValue(this.fields[field]!.kind, missing(value) ? undefined : value);
  }

  private passes(id: number, filter: RowFilter, field: number): boolean {
    const value = this.value(id, field);
    if (missing(value)) return false;
    if (filter.kind === "range")
      return (value as number) >= filter.min && (value as number) <= filter.max;
    return filter.labels.includes(value as string);
  }

  /**
   * Identities of displayed rows in display order. `previous`, an earlier
   * order of the same sort, only speeds up sorting: it starts nearly sorted.
   * It is not used with a filter, since updates can bring rows the earlier
   * order left out back in.
   */
  order(
    sort: readonly SortKey[],
    filter: RowFilter | null,
    previous?: readonly number[],
  ): number[] {
    let ids: number[];
    if (previous && !filter) {
      ids = previous.filter((id) => id >= this.start);
      let newest = this.start - 1;
      for (const id of previous) newest = Math.max(newest, id);
      for (let id = newest + 1; id < this.end; id++) ids.push(id);
    } else {
      ids = [];
      for (let id = this.start; id < this.end; id++) ids.push(id);
    }
    if (filter) {
      const field = this.fieldIndex(filter.field);
      const labels = filter.kind === "in" ? new Set(filter.labels) : undefined;
      ids = ids.filter((id) =>
        labels ? labels.has(this.value(id, field) as string) : this.passes(id, filter, field),
      );
    }
    if (sort.length === 0) return previous && !filter ? ids.sort((a, b) => a - b) : ids;
    const keys = sort.map((key) => {
      const field = this.fieldIndex(key.field);
      return { descending: key.descending, values: ids.map((id) => this.value(id, field)) };
    });
    const positions = ids.map((_, p) => p);
    positions.sort((a, b) => {
      for (const key of keys) {
        const order = compare(key.values[a], key.values[b], key.descending);
        if (order !== 0) return order;
      }
      return ids[a]! - ids[b]!;
    });
    return positions.map((p) => ids[p]!);
  }
}

/** What a correct frame shows. */
export interface Expected {
  /** Displayed rows. */
  count: number;
  fields: number;
  /** Identity of the row at a display index. */
  idAt(index: number): number;
  text(id: number, field: number): string;
  /** Selection, when the scenario selects rows. */
  selected?: (id: number) => boolean;
  /** Requested scroll offsets; grids clamp them at the end of the content. */
  top: number;
  left: number;
}

/** Rows and columns visible at a scroll offset, as [first, last] indices. */
export function visibleRange(
  offset: number,
  size: number,
  step: number,
  count: number,
): [number, number] {
  const first = Math.floor((offset + 0.5) / step);
  const last = Math.min(count, Math.ceil((offset + size - 0.5) / step)) - 1;
  return [first, last];
}

/** Describes the first difference between what a grid shows and what it should, or undefined. */
export function verifyVisible(
  visible: Visible | undefined,
  expected: Expected,
): string | undefined {
  if (!visible) return "the grid reports nothing visible";
  const v = visible;
  if (v.count !== expected.count) return `shows ${v.count} rows in all, expected ${expected.count}`;
  const maxTop = Math.max(0, expected.count * ROW_HEIGHT - v.height);
  const top = Math.min(expected.top, maxTop);
  if (Math.abs(v.top - top) > Math.max(1, v.scrollStep ?? 1))
    return `shows the body from top ${v.top}, expected ${top}`;
  const maxLeft = Math.max(0, expected.fields * COLUMN_WIDTH - v.width);
  const left = Math.min(expected.left, maxLeft);
  if (Math.abs(v.left - left) > 1) return `shows the body from left ${v.left}, expected ${left}`;
  const [firstRow, lastRow] = visibleRange(v.top, v.height, ROW_HEIGHT, expected.count);
  const rows = Math.max(0, lastRow - firstRow + 1);
  if (v.rows.length !== rows)
    return `shows ${v.rows.length} rows, expected ${rows} (display rows ${firstRow}-${lastRow})`;
  for (let r = 0; r < rows; r++) {
    const id = expected.idAt(firstRow + r);
    const shown = v.rows[r];
    if (shown !== undefined && shown !== id)
      return `display row ${firstRow + r} is row ${shown}, expected ${id}`;
  }
  const [firstColumn, lastColumn] = visibleRange(v.left, v.width, COLUMN_WIDTH, expected.fields);
  const columns = lastColumn - firstColumn + 1;
  if (v.columns.length !== columns || v.columns.some((field, c) => field !== firstColumn + c))
    return `shows columns ${v.columns.join(",")}, expected ${firstColumn}-${lastColumn}`;
  for (let r = 0; r < rows; r++) {
    const id = expected.idAt(firstRow + r);
    for (let c = 0; c < columns; c++) {
      const want = expected.text(id, firstColumn + c);
      const got = v.text[r]?.[c];
      if (got !== want)
        return `row ${id} column ${firstColumn + c} shows "${got}", expected "${want}"`;
    }
    const selected = expected.selected?.(id) ?? false;
    if (v.selected[r] !== selected)
      return `row ${id} is shown ${v.selected[r] ? "selected" : "unselected"}, expected the opposite`;
  }
  return undefined;
}

/** Describes the first difference between two display orders, or undefined. */
export function verifyOrder(got: ArrayLike<number>, want: readonly number[]): string | undefined {
  if (got.length !== want.length) return `displays ${got.length} rows, expected ${want.length}`;
  for (let i = 0; i < want.length; i++)
    if (got[i] !== want[i]) return `display row ${i} is row ${got[i]}, expected ${want[i]}`;
  return undefined;
}
