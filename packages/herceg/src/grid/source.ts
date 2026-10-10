// Remote grid sources: where a remote grid (remote.ts) gets its rows. A
// source runs a grid query (query.ts) where the data lives and answers
// requests for windows of it: a run of rows, or of groups under a parent
// group, as typed columns rather than an object per row. The grid holds
// only the windows it shows and a few around them.
//
// A query's answers come from one snapshot: the first request of a query
// (`snapshot: null`) starts one, and later requests name it, so rows do not
// shift between windows while data changes underneath. A source that
// cannot keep a snapshot rejects requests naming it ("snapshot-expired").

import type { Expression, Fields } from "../data/expression.ts";
import { type GroupKey, groupId } from "../data/groups.ts";
import type { Schema } from "../data/table.ts";
import type { GridQuery, GridSchema, RowKey } from "./query.ts";

/**
 * A group's key path as JSON carries it: labels, finite numbers (a time's
 * epoch milliseconds), null for missing values, and infinities spelled out,
 * since JSON has none.
 */
export type GroupValue = string | number | null | { readonly number: "+infinity" | "-infinity" };
export type GroupPath = readonly GroupValue[];

/** Where a row of a query is: its parent group's path ([] at the top) and its place among its siblings. */
export interface RowAddress {
  readonly parent: GroupPath;
  readonly offset: number;
}

/**
 * A request for `limit` rows from `offset` under `parent`: for a query
 * without groups, rows ([] is the only parent); for one grouped by `D`
 * fields, the groups of a level under a parent of fewer than `D` values, or
 * the rows of a group with all `D`. `fields` are the row fields wanted (the
 * key among them); group windows hold their grouping fields and aggregates.
 */
export interface RowsRequest {
  readonly query: GridQuery;
  /** Counts the grid's queries; answers echo it. */
  readonly revision: number;
  readonly schemaVersion: string;
  /**
   * The snapshot to answer from; null to start one. Each such request starts
   * a snapshot of its own (a distinct id), which the grid releases once
   * (`GridSource.release`) when it stops reading it, even having read none of
   * it.
   */
  readonly snapshot: string | null;
  readonly parent: GroupPath;
  readonly offset: number;
  readonly limit: number;
  readonly fields: readonly string[];
}

/**
 * A column of a window: numbers and times as Float64Array (NaN missing),
 * categories as codes into the window's own dictionary (-1 missing).
 */
export type WindowColumn =
  | Float64Array
  | { readonly codes: Int32Array; readonly dictionary: readonly string[] };

interface WindowBase extends RowAddress {
  readonly revision: number;
  readonly snapshot: string;
  readonly length: number;
  /**
   * How many rows (or groups) the parent has, null when not known yet. A
   * window shorter than its limit is the last and says (one past the end
   * has no rows); within a snapshot the total never changes.
   */
  readonly total: number | null;
  readonly columns: Readonly<Record<string, WindowColumn>>;
}

/** An answer: rows, or groups with their grouping fields (down to their level), aggregates, and counts. */
export type RowsWindow =
  | (WindowBase & { readonly kind: "rows" })
  | (WindowBase & {
      readonly kind: "groups";
      /** Rows each group holds, in its groups below too. */
      readonly rowCounts: Float64Array;
      /** Groups of the next level each holds, or on the last level its rows. */
      readonly childCounts: Float64Array;
    });

export interface LocateRequest {
  readonly query: GridQuery;
  readonly revision: number;
  readonly schemaVersion: string;
  readonly snapshot: string;
  readonly key: RowKey;
}

/**
 * Where a record is in a snapshot (null when the query leaves it out), and
 * where each of its groups is, from the first level down.
 */
export interface LocateResult {
  readonly revision: number;
  readonly snapshot: string;
  readonly address: RowAddress | null;
  readonly ancestors: readonly RowAddress[];
}

/** Rows that live elsewhere, behind a server or a worker. */
export interface GridSource<S extends Schema = Schema> {
  readonly schema: GridSchema<S>;
  /** A window of a query's rows or groups. Rejects with a `GridSourceError`, or an abort. */
  rows(request: RowsRequest, signal: AbortSignal): Promise<RowsWindow>;
  /** Where a record is in a snapshot, so the focus can follow it to a new query; optional. */
  locate?(request: LocateRequest, signal: AbortSignal): Promise<LocateResult>;
  /** The grid no longer reads a snapshot; optional. */
  release?(snapshot: string): void;
}

export type GridSourceErrorCode =
  | "invalid-query"
  | "unsupported-query"
  | "schema-changed"
  | "snapshot-expired"
  | "unavailable"
  | "invalid-response";

/** A source's refusal, or a response the grid could not take. */
export class GridSourceError extends Error {
  readonly code: GridSourceErrorCode;

  constructor(code: GridSourceErrorCode, message: string) {
    super(message);
    this.name = "GridSourceError";
    this.code = code;
  }
}

/** A group key as JSON carries it. */
export function encodeGroupPath(key: GroupKey): GroupPath {
  return key.map((value) =>
    typeof value === "number" && !Number.isFinite(value)
      ? Number.isNaN(value)
        ? null
        : { number: value > 0 ? "+infinity" : "-infinity" }
      : // -0 is 0.
        value === 0
        ? 0
        : value,
  );
}

/** A group key from its JSON form. */
export function decodeGroupPath(path: GroupPath): GroupKey {
  if (!Array.isArray(path)) throw new TypeError("A group path must be a list");
  return path.map((value: GroupValue) => {
    if (value === null || typeof value === "string") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "object" && (value.number === "+infinity" || value.number === "-infinity"))
      return value.number === "+infinity" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
    throw new TypeError(`Not a group path value: ${JSON.stringify(value)}`);
  });
}

/**
 * The condition rows of the group with this key path meet, over its
 * grouping fields: equal values, missing ones as `missing`, infinities
 * past the largest finite number.
 */
export function groupCondition(by: readonly string[], key: GroupKey): Expression {
  const tests: Expression[] = key.map((value, k) => {
    const field: Expression = ["field", by[k]!];
    if (value === null) return ["missing", field];
    if (typeof value === "number" && !Number.isFinite(value))
      return value > 0 ? [">", field, Number.MAX_VALUE] : ["<", field, -Number.MAX_VALUE];
    return ["==", field, value];
  });
  return tests.length === 1 ? tests[0]! : ["and", ...tests];
}

/** A window's columns as expressions and cell readers read them, by the schema's kinds. */
export function windowFields(
  kinds: Readonly<Record<string, string>>,
  columns: Readonly<Record<string, WindowColumn>>,
): Fields {
  const names = Object.keys(columns);
  const column = (name: string) => {
    const values = columns[name];
    if (!values) throw new Error(`The answer has no field "${name}"`);
    return values;
  };
  return {
    fields: () => names,
    has: (name) => Object.hasOwn(columns, name),
    kind: (name) => (kinds[name] ?? "number") as "number" | "time" | "category",
    numbers: (name) => column(name) as Float64Array,
    categories: (name) => column(name) as { codes: Int32Array; dictionary: readonly string[] },
  };
}

/**
 * Throws a `GridSourceError` unless a window answers its request: the same
 * address, no more rows than asked, a total when it is the last, each
 * expected field a column of the right kind and length (codes within its
 * dictionary), counts of at least one for groups, and no record (by `key`,
 * a string or safe integer) or group (by its value of `group`) twice.
 * `kinds` are the fields expected and their kinds. Gives each record's
 * place by key, when there is a key field.
 */
export function checkWindow(
  answer: RowsWindow,
  request: RowsRequest,
  kind: "rows" | "groups",
  kinds: Readonly<Record<string, string>>,
  { key = null, group }: { key?: string | null; group?: string } = {},
): Map<RowKey, number> | null {
  const fail = (problem: string) => {
    throw new GridSourceError("invalid-response", `The answer ${problem}`);
  };
  if (typeof answer !== "object" || answer === null) fail("is not an object");
  if (answer.kind !== kind) fail(`is of ${answer.kind}, not ${kind}`);
  if (answer.revision !== request.revision) fail("answers another query");
  if (request.snapshot !== null && answer.snapshot !== request.snapshot)
    fail("comes from another snapshot");
  if (typeof answer.snapshot !== "string") fail("names no snapshot");
  if (answer.offset !== request.offset || !samePath(answer.parent, request.parent))
    fail("is of another place");
  const { length, total } = answer;
  if (!(Number.isInteger(length) && length >= 0 && length <= request.limit))
    fail(`has ${length} rows for a limit of ${request.limit}`);
  if (total !== null && !(Number.isInteger(total) && total >= 0)) fail(`has a total of ${total}`);
  // Past the end, an answer has no rows and says where the end is.
  const past = length === 0 && total !== null && total <= request.offset;
  if (!past && total !== null && total < request.offset + length)
    fail(`has a total of ${total} short of its rows`);
  if (total === null && length < request.limit) fail("is the last but has no total");
  if (!past && total !== null && length < request.limit && total !== request.offset + length)
    fail("is the last but its total says more");
  for (const [field, fieldKind] of Object.entries(kinds)) {
    const column = answer.columns?.[field];
    if (fieldKind === "category") {
      const c = column as { codes?: unknown; dictionary?: unknown } | undefined;
      if (!(c?.codes instanceof Int32Array) || !Array.isArray(c.dictionary))
        fail(`lacks category field "${field}"`);
      const { codes, dictionary } = c as { codes: Int32Array; dictionary: readonly string[] };
      if (codes.length !== length) fail(`has ${codes.length} values of "${field}"`);
      for (let i = 0; i < dictionary.length; i++)
        if (typeof dictionary[i] !== "string") fail(`has a label that is no string in "${field}"`);
      // A label twice would be two values to conditions, one to the eye.
      if (new Set(dictionary).size < dictionary.length) fail(`repeats a label in "${field}"`);
      for (const code of codes)
        if (code < -1 || code >= dictionary.length) fail(`has a bad code in "${field}"`);
    } else {
      if (!(column instanceof Float64Array)) fail(`lacks number field "${field}"`);
      if ((column as Float64Array).length !== length)
        fail(`has ${(column as Float64Array).length} values of "${field}"`);
    }
  }
  if (answer.kind === "groups") {
    for (const counts of [answer.rowCounts, answer.childCounts]) {
      if (!(counts instanceof Float64Array) || counts.length !== length) fail("lacks group counts");
      // A group holds a row at least, and some rows or groups below.
      for (const count of counts)
        if (!(Number.isInteger(count) && count >= 1)) fail(`has a group count of ${count}`);
    }
    if (group !== undefined) {
      const ids = new Set<string>();
      for (let row = 0; row < length; row++) ids.add(groupId([valueAt(answer, group, row)]));
      if (ids.size < length) fail("repeats a group");
    }
  }
  if (kind === "rows" && key !== null) {
    const keys = new Map<RowKey, number>();
    for (let row = 0; row < length; row++) {
      const value = valueAt(answer, key, row);
      if (value === null) fail("has a record without a key");
      if (typeof value === "number" && !Number.isSafeInteger(value))
        fail(`has a key of ${value}: keys are strings or safe integers`);
      keys.set(value as RowKey, row);
    }
    if (keys.size < length) fail("repeats a key");
    return keys;
  }
  return null;
}

/** A field's value at a window's row: a label, a number (-0 as 0), or null for missing. */
export function valueAt(answer: RowsWindow, field: string, row: number): string | number | null {
  const column = answer.columns[field]!;
  if (column instanceof Float64Array) {
    const value = column[row]!;
    return Number.isNaN(value) ? null : value === 0 ? 0 : value;
  }
  const code = column.codes[row]!;
  return code < 0 ? null : (column.dictionary[code] ?? null);
}

function samePath(a: GroupPath, b: GroupPath): boolean {
  return Array.isArray(a) && JSON.stringify(a) === JSON.stringify(b);
}
