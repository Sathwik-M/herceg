// Long-format rows split by a series field and kept current as their table
// streams, with min/max indexes of their fields. Loaded the first time a
// chart splits a whole table's rows by a field (see SeriesSplitter), so
// charts without a series field carry none of it.

import type { NumericArray } from "../data/column.ts";
import type { Table } from "../data/table.ts";
import { rowsM4 } from "../lod/m4-rows.ts";
import type { RangeIndex } from "../lod/minmax-index.ts";
import { RowsIndex } from "../lod/rows-index.ts";
import type { SeriesStream } from "./series.ts";

/** One category's rows in `SplitRows`: positions, ascending, in `buffer[0, count)`. */
interface Group {
  readonly name: string;
  buffer: Uint32Array;
  count: number;
  /** Rows the group lost from its front since it was built, as the window moved. */
  dropped: number;
  /** x ascends over the rows. */
  sorted: boolean;
  /** One object per group while it follows its table, as streamed GPU uploads key them. */
  readonly key: object;
  /**
   * Min/max indexes of fields over the rows, by field, from the first time
   * a chart asks for one; brought up to date when asked again.
   */
  indexes: Map<string, RowsIndex> | undefined;
}

/** One category's rows, as `SplitRows.groups` gives them. */
export interface CategoryRows {
  readonly name: string;
  readonly rows: Uint32Array;
  readonly sorted: boolean;
  /** The group as it follows the table: see `Series.stream`. */
  readonly stream: SeriesStream;
}

/**
 * A table's rows grouped by a category field, in dictionary order, kept
 * current as rows are appended and dropped from the front (a rolling window)
 * instead of grouped again: appends cost the new rows, and drops a search
 * per group plus a pass over the rows that stay. Other changes regroup.
 * Groups are keyed by name, since a rolling window may renumber codes.
 */
export class SplitRows {
  readonly #table: Table;
  readonly #field: string;
  readonly #x: string | undefined;
  #groups = new Map<string, Group>();
  #version = -1;
  #modified = -1;
  #generation = -1;
  #offset = 0;
  #length = 0;

  constructor(table: Table, field: string, x: string | undefined) {
    this.#table = table;
    this.#field = field;
    this.#x = x;
  }

  /** The groups with rows, in the order of the field's dictionary. */
  groups(): CategoryRows[] {
    const table = this.#table;
    if (table.version !== this.#version) this.#update();
    const { dictionary } = table.categories(this.#field as never);
    const out: CategoryRows[] = [];
    for (const name of dictionary) {
      const group = this.#groups.get(name);
      if (!group || group.count === 0) continue;
      const rows = group.buffer.subarray(0, group.count);
      out.push({ name, rows, sorted: group.sorted, stream: new GroupRows(table, group, rows) });
    }
    return out;
  }

  #update(): void {
    const table = this.#table;
    const dropped = table.rowOffset - this.#offset;
    const kept = this.#length - dropped;
    const follows =
      table.generation === this.#generation &&
      table.modifiedVersion === this.#modified &&
      dropped >= 0 &&
      kept >= 0 &&
      table.length >= kept;
    if (follows) {
      if (dropped > 0) this.#drop(dropped);
      this.#append(kept, table.length);
    } else {
      this.#groups = new Map();
      this.#append(0, table.length);
    }
    this.#version = table.version;
    this.#modified = table.modifiedVersion;
    this.#generation = table.generation;
    this.#offset = table.rowOffset;
    this.#length = table.length;
  }

  /**
   * Takes the first `count` rows out of every group, and moves the rest down
   * into a buffer sized for them: the rows given out before stay as they were,
   * for scenes and charts that still read them.
   */
  #drop(count: number): void {
    const x = this.#xs();
    for (const [name, group] of this.#groups) {
      const { buffer, count: before } = group;
      // Positions ascend, so the dropped ones lead.
      let lo = 0;
      let hi = before;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (buffer[mid]! < count) lo = mid + 1;
        else hi = mid;
      }
      const kept = before - lo;
      if (kept === 0) {
        this.#groups.delete(name);
        continue;
      }
      const moved = new Uint32Array(capacityFor(kept));
      for (let k = 0; k < kept; k++) moved[k] = buffer[lo + k]! - count;
      group.buffer = moved;
      group.count = kept;
      group.dropped += lo;
      // A drop can remove the inversion that left x unsorted.
      if (!group.sorted && x) group.sorted = ascends(x, moved, 0, kept);
    }
  }

  /** Files rows `[from, to)` into their groups. */
  #append(from: number, to: number): void {
    if (from >= to) return;
    const { codes, dictionary } = this.#table.categories(this.#field as never);
    const x = this.#xs();
    // Each code's group, found once per change rather than once per row.
    const byCode: (Group | undefined)[] = new Array(dictionary.length);
    for (let row = from; row < to; row++) {
      const code = codes[row]!;
      if (code < 0) continue;
      let group = byCode[code];
      if (!group) {
        const name = dictionary[code]!;
        group = this.#groups.get(name);
        if (!group) {
          group = {
            name,
            buffer: new Uint32Array(16),
            count: 0,
            dropped: 0,
            sorted: x !== undefined,
            key: {},
            indexes: undefined,
          };
          this.#groups.set(name, group);
        }
        byCode[code] = group;
      }
      if (group.count === group.buffer.length) grow(group);
      const at = group.count;
      // As isSortedSubset: a missing x, the first one too, is not ascending.
      if (group.sorted && x) {
        const previous = group.count > 0 ? x[group.buffer[at - 1]!]! : Number.NEGATIVE_INFINITY;
        if (!(x[row]! >= previous)) group.sorted = false;
      }
      group.buffer[at] = row;
      group.count++;
    }
  }

  #xs(): NumericArray | undefined {
    const x = this.#x;
    return x === undefined || this.#table.kind(x as never) === "category"
      ? undefined
      : this.#table.numbers(x as never);
  }
}

/**
 * A group's rows at one version of its table, as series hold them: the
 * group's identity and drops, and min/max indexes of fields over these rows.
 */
class GroupRows implements SeriesStream {
  readonly key: object;
  readonly dropped: number;
  readonly m4 = rowsM4;
  readonly #table: Table;
  readonly #version: number;
  readonly #group: Group;
  readonly #rows: Uint32Array;
  /** Index views for this version, by field. */
  #views: Map<string, RangeIndex> | undefined;

  constructor(table: Table, group: Group, rows: Uint32Array) {
    this.key = group.key;
    this.dropped = group.dropped;
    this.#table = table;
    this.#version = table.version;
    this.#group = group;
    this.#rows = rows;
  }

  hasMinMaxIndex(field: string): boolean {
    return this.#group.indexes?.has(field) ?? false;
  }

  minMaxIndex(field: string): RangeIndex {
    this.#views ??= new Map();
    let view = this.#views.get(field);
    if (view) return view;
    const table = this.#table;
    const version = this.#version;
    const stale = () =>
      new Error(`The rows of "${this.#group.name}" were read before the table changed`);
    if (table.version !== version) throw stale();
    const values = table.numbers(field as never);
    const rows = this.#rows;
    this.#group.indexes ??= new Map();
    let index = this.#group.indexes.get(field);
    if (!index) {
      index = new RowsIndex();
      this.#group.indexes.set(field, index);
    }
    index.update(values, rows, this.dropped, rows.length);
    const covered = index;
    view = {
      length: rows.length,
      gapShare: covered.gapShare,
      query: (_values, from, to, out) => {
        if (table.version !== version) throw stale();
        return covered.query(values, rows, from, to, out);
      },
    };
    this.#views.set(field, view);
    return view;
  }
}

/** Room for a group of `count` rows and the appends to come. */
function capacityFor(count: number): number {
  return Math.max(16, Math.ceil(count * 1.5));
}

/**
 * Makes room at a group's end in a new buffer: rows given out before keep
 * their old buffer, which appends only ever write past.
 */
function grow(group: Group): void {
  const next = new Uint32Array(capacityFor(group.count));
  next.set(group.buffer.subarray(0, group.count));
  group.buffer = next;
}

/**
 * Whether x ascends over `rows[from, to)`; series.ts has the same check,
 * but importing it would split that module into a chunk of its own.
 */
function ascends(x: NumericArray, rows: Uint32Array, from: number, to: number): boolean {
  let previous = Number.NEGATIVE_INFINITY;
  for (let k = from; k < to; k++) {
    const value = x[rows[k]!]!;
    if (!(value >= previous)) return false;
    previous = value;
  }
  return true;
}
