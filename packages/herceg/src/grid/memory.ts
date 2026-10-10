// A grid source over a Herceg table, imported as `herceg/grid/memory`: the
// reference for what a server answers (it runs queries with the local
// grid's own row views and groups, so their semantics are the local grid's),
// for tests and benchmarks (with latency), and for serving a table from a
// worker. Each snapshot is a view of the table (and its groups) as the
// query asks; a change to the table expires every snapshot, since views
// follow their table, rather than copying the table to keep them.

import type { Expression } from "../data/expression.ts";
import { type GroupKey, groupId, groupRows, type RowGroups } from "../data/groups.ts";
import { rowComparator, type SortKey } from "../data/order.ts";
import { type RowView, rowView } from "../data/row-view.ts";
import type { Schema, Table } from "../data/table.ts";
import { type GridQuery, type GridSchema, validateGridQuery } from "./query.ts";
import {
  decodeGroupPath,
  encodeGroupPath,
  type GridSource,
  GridSourceError,
  type LocateRequest,
  type LocateResult,
  type RowAddress,
  type RowsRequest,
  type RowsWindow,
  type WindowColumn,
} from "./source.ts";

export interface MemorySourceOptions {
  /** The source's name, which queries give; "memory" by default. */
  name?: string;
  /** The field whose values are each row's key: unique, never missing. None by default. */
  key?: string | null;
  /** Milliseconds each answer waits, or a function of the request; none by default (answers still arrive later). */
  latency?: number | ((request: RowsRequest | LocateRequest) => number);
  /** Snapshots kept at once; older ones expire. 8 by default. */
  snapshots?: number;
  /** The most rows a request may ask for; 10,000 by default. */
  maxLimit?: number;
}

/** Requests a source answered, refused, and saw aborted. */
export interface MemorySourceStats {
  requests: number;
  answered: number;
  failed: number;
  aborted: number;
}

interface Snapshot {
  readonly id: string;
  readonly query: string;
  readonly view: RowView;
  readonly groups: RowGroups | null;
  /** Each parent's groups in order, by the parent's id. */
  readonly siblings: Map<string, Int32Array>;
}

/** A table's rows served as a grid source; see `memorySource`. */
export class MemorySource<S extends Schema = Schema> implements GridSource<S> {
  readonly table: Table<S>;
  readonly schema: GridSchema<S>;
  readonly stats: MemorySourceStats = { requests: 0, answered: 0, failed: 0, aborted: 0 };
  readonly #latency: (request: RowsRequest | LocateRequest) => number;
  readonly #keep: number;
  readonly #maxLimit: number;
  readonly #snapshots = new Map<string, Snapshot>();
  #next = 0;
  readonly #stop: () => void;

  constructor(table: Table<S>, options: MemorySourceOptions = {}) {
    this.table = table;
    const key = options.key ?? null;
    // Without a prototype: a field may be named "__proto__".
    const fields: Record<string, "number" | "time" | "category"> = Object.create(null);
    for (const field of table.fields()) {
      const kind = table.kind(field as never);
      if (kind !== "geometry") fields[field] = kind;
    }
    if (key !== null && !(key in fields)) throw new Error(`Unknown key field "${key}"`);
    this.schema = Object.freeze({
      source: options.name ?? "memory",
      version: "1",
      fields: Object.freeze(fields) as unknown as Readonly<S>,
      key: key as (keyof S & string) | null,
    });
    const latency = options.latency ?? 0;
    this.#latency = typeof latency === "number" ? () => latency : latency;
    this.#keep = options.snapshots ?? 8;
    this.#maxLimit = options.maxLimit ?? 10_000;
    // Views follow their table, so answers from before a change would not be of one snapshot.
    this.#stop = table.subscribe(() => this.#expire());
  }

  async rows(request: RowsRequest, signal: AbortSignal): Promise<RowsWindow> {
    this.stats.requests++;
    try {
      await wait(this.#latency(request), signal);
      const answer = this.#answer(request);
      this.stats.answered++;
      return answer;
    } catch (error) {
      if (signal.aborted) this.stats.aborted++;
      else this.stats.failed++;
      throw error;
    }
  }

  async locate(request: LocateRequest, signal: AbortSignal): Promise<LocateResult> {
    await wait(this.#latency(request), signal);
    if (request.schemaVersion !== this.schema.version)
      throw new GridSourceError("schema-changed", "The source's fields changed");
    const snapshot = this.#snapshot(request.snapshot, request.query);
    const answer = { revision: request.revision, snapshot: snapshot.id };
    const { key } = this.schema;
    if (key === null)
      throw new GridSourceError("unsupported-query", `"${this.schema.source}" names no key`);
    const position = this.#positionOf(key, request.key);
    const { view, groups } = snapshot;
    if (position < 0) return { ...answer, address: null, ancestors: [] };
    if (!groups) {
      const offset = view.indexOf(position);
      return { ...answer, address: offset < 0 ? null : { parent: [], offset }, ancestors: [] };
    }
    const group = groups.groupOf(position);
    if (group < 0) return { ...answer, address: null, ancestors: [] };
    const path = groups.keyOf(group);
    const ancestors: RowAddress[] = path.map((_, depth) => {
      const parent = path.slice(0, depth);
      const siblings = this.#siblings(snapshot, parent);
      return {
        parent: encodeGroupPath(parent),
        offset: siblings.indexOf(groups.indexOf(path.slice(0, depth + 1))),
      };
    });
    return {
      ...answer,
      address: { parent: encodeGroupPath(path), offset: groups.memberIndex(position) },
      ancestors,
    };
  }

  release(snapshot: string): void {
    const found = this.#snapshots.get(snapshot);
    if (found) this.#forget(found);
  }

  /** Stops following the table and forgets every snapshot. */
  dispose(): void {
    this.#stop();
    this.#expire();
  }

  #answer(request: RowsRequest): RowsWindow {
    if (request.schemaVersion !== this.schema.version)
      throw new GridSourceError("schema-changed", "The source's fields changed");
    const { offset, limit } = request;
    if (!(Number.isInteger(offset) && offset >= 0 && Number.isInteger(limit) && limit > 0))
      throw new GridSourceError("invalid-query", "A request needs a whole offset and limit");
    if (limit > this.#maxLimit)
      throw new GridSourceError("unsupported-query", `Windows hold at most ${this.#maxLimit} rows`);
    const snapshot =
      request.snapshot === null
        ? this.#create(request.query)
        : this.#snapshot(request.snapshot, request.query);
    let parent: GroupKey;
    try {
      parent = decodeGroupPath(request.parent);
    } catch (error) {
      throw new GridSourceError("invalid-query", (error as Error).message);
    }
    const { groups, view } = snapshot;
    const depths = groups?.by.length ?? 0;
    if (parent.length > depths)
      throw new GridSourceError("invalid-query", "The parent is deeper than the query's groups");
    const base = {
      revision: request.revision,
      snapshot: snapshot.id,
      parent: request.parent,
      offset,
    };
    if (!groups || parent.length === depths) {
      for (const field of request.fields)
        if (!Object.hasOwn(this.schema.fields, field))
          throw new GridSourceError("invalid-query", `Unknown field "${field}"`);
      let rows: Uint32Array;
      let total: number;
      if (groups) {
        const group = groups.indexOf(parent);
        const members = group < 0 ? new Uint32Array(0) : groups.members(group);
        rows = members.subarray(Math.min(offset, members.length), offset + limit);
        total = members.length;
      } else {
        const { indices, length } = view.read();
        const end = Math.min(length, offset + limit);
        rows = indices
          ? indices.subarray(Math.min(offset, end), end)
          : Uint32Array.from({ length: Math.max(0, end - offset) }, (_, i) => offset + i);
        total = length;
      }
      const fields = [
        ...new Set([...request.fields, ...(this.schema.key ? [this.schema.key] : [])]),
      ];
      return {
        kind: "rows",
        ...base,
        length: rows.length,
        total,
        columns: gather(this.table as unknown as Table, fields, rows),
      };
    }
    const depth = parent.length;
    const siblings = this.#siblings(snapshot, parent);
    const shown = siblings.subarray(Math.min(offset, siblings.length), offset + limit);
    const by = groups.by as readonly string[];
    const level = groups.tableOf(by[depth]!) as unknown as Table;
    const fields = [...by.slice(0, depth + 1), ...groups.aggregates.map(({ name }) => name)];
    const last = by.length - 1;
    return {
      kind: "groups",
      ...base,
      length: shown.length,
      total: siblings.length,
      columns: gather(level, fields, shown),
      rowCounts: Float64Array.from(shown, (group) => groups.size(group, depth)),
      childCounts: Float64Array.from(shown, (group) =>
        depth < last ? groups.childrenOf(group, depth).length : groups.size(group, depth),
      ),
    };
  }

  /** A new snapshot of a query: a view sorted with ties by key, and its groups. */
  #create(query: GridQuery): Snapshot {
    let checked: GridQuery;
    try {
      checked = validateGridQuery(query, this.schema);
    } catch (error) {
      throw new GridSourceError("invalid-query", (error as Error).message);
    }
    const { key } = this.schema;
    // Ties go by key; rows keep table order on ties, which is key order when keys ascend.
    const sort: SortKey[] = [...(checked.sort ?? [])];
    const table = this.table as unknown as Table;
    if (key !== null && (table.kind(key) === "category" || !table.isSorted(key)))
      sort.push({ field: key });
    const view = rowView(table, {
      ...(checked.filter !== undefined && { filter: checked.filter as Expression }),
      ...(sort.length > 0 && { sort }),
    });
    const group = checked.group;
    const groups = group
      ? (groupRows(view, {
          by: group.by,
          ops: Object.fromEntries(
            group.aggregate.map(({ op, field, as }) => [
              as,
              field === undefined ? { op } : { op, field },
            ]),
          ),
        } as never) as unknown as RowGroups)
      : null;
    const snapshot: Snapshot = {
      id: `s${++this.#next}`,
      query: JSON.stringify(query),
      view,
      groups,
      siblings: new Map(),
    };
    this.#snapshots.set(snapshot.id, snapshot);
    // The oldest snapshots expire past the limit.
    for (const old of this.#snapshots.values()) {
      if (this.#snapshots.size <= this.#keep) break;
      this.#forget(old);
    }
    return snapshot;
  }

  #snapshot(id: string, query: GridQuery): Snapshot {
    const snapshot = this.#snapshots.get(id);
    if (!snapshot) throw new GridSourceError("snapshot-expired", `Snapshot "${id}" has expired`);
    if (snapshot.query !== JSON.stringify(query))
      throw new GridSourceError("invalid-query", `Snapshot "${id}" is of another query`);
    return snapshot;
  }

  /**
   * A parent's groups in order: by the group sort's keys that their level's
   * table has, then by their own value, ascending, missing last.
   */
  #siblings(snapshot: Snapshot, parent: GroupKey): Int32Array {
    const id = groupId(parent);
    const cached = snapshot.siblings.get(id);
    if (cached) return cached;
    const groups = snapshot.groups!;
    const depth = parent.length;
    const by = groups.by as readonly string[];
    let list: Int32Array;
    if (depth === 0) list = Int32Array.from({ length: groups.countAt(0) }, (_, group) => group);
    else {
      const group = groups.indexOf(parent);
      list = group < 0 ? new Int32Array(0) : groups.childrenOf(group, depth - 1).slice();
    }
    const table = groups.tableOf(by[depth]!) as unknown as Table;
    const query = JSON.parse(snapshot.query) as GridQuery;
    const keys = (query.group?.sort ?? []).filter(({ field }) => table.has(field));
    list.sort(rowComparator(table, [...keys, { field: by[depth]! }]));
    snapshot.siblings.set(id, list);
    return list;
  }

  /** The position of the row with this key, or -1. */
  #positionOf(field: string, key: string | number): number {
    const table = this.table as unknown as Table;
    if (table.kind(field) === "category") {
      const { codes, dictionary } = table.categories(field);
      const code = typeof key === "string" ? dictionary.indexOf(key) : -1;
      return code < 0 ? -1 : codes.indexOf(code);
    }
    if (typeof key !== "number") return -1;
    const values = table.numbers(field);
    if (!table.isSorted(field)) return values.indexOf(key);
    let [lo, hi] = [0, table.length];
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (values[mid]! < key) lo = mid + 1;
      else hi = mid;
    }
    return values[lo] === key ? lo : -1;
  }

  #forget(snapshot: Snapshot) {
    snapshot.groups?.dispose();
    snapshot.view.dispose();
    this.#snapshots.delete(snapshot.id);
  }

  #expire() {
    for (const snapshot of [...this.#snapshots.values()]) this.#forget(snapshot);
  }
}

/**
 * A table's rows as a grid source, answering as a server would: queries
 * run over the table's columns where it lives (the page, or a worker), and
 * windows are copied out with dictionaries of their own labels.
 *
 * ```ts
 * const source = memorySource(requests, { key: "id", latency: 20 });
 * const model = createRemoteGridModel({ source, columns: [{ field: "time" }, { field: "latency" }] });
 * ```
 */
export function memorySource<S extends Schema>(
  table: Table<S>,
  options?: MemorySourceOptions,
): MemorySource<S> {
  return new MemorySource(table, options);
}

/** Waits `ms` (a timer even at 0, so answers arrive later as a server's do), unless aborted. */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function abortError(): Error {
  return new DOMException("The request was aborted", "AbortError");
}

/** Columns of `fields` at the table's rows `rows`, categories with dictionaries of the labels they use. */
function gather(
  table: Table,
  fields: readonly string[],
  rows: Uint32Array | Int32Array,
): Record<string, WindowColumn> {
  const columns: Record<string, WindowColumn> = Object.create(null);
  for (const field of fields) {
    if (table.kind(field) === "category") {
      const { codes, dictionary } = table.categories(field);
      const local = new Map<number, number>();
      const labels: string[] = [];
      const out = new Int32Array(rows.length);
      rows.forEach((row, i) => {
        const code = codes[row]!;
        if (code < 0) {
          out[i] = -1;
          return;
        }
        let at = local.get(code);
        if (at === undefined) {
          at = labels.push(dictionary[code]!) - 1;
          local.set(code, at);
        }
        out[i] = at;
      });
      columns[field] = { codes: out, dictionary: labels };
    } else {
      const values = table.numbers(field);
      columns[field] = Float64Array.from(rows, (row) => values[row]!);
    }
  }
  return columns;
}
