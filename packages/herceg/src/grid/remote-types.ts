import type { Expression, Fields } from "../data/expression.ts";
import type { GroupKey } from "../data/groups.ts";
import type { GridRef } from "./base.ts";
import type { GridQuery, RowKey } from "./query.ts";
import type { RowsWindow } from "./source.ts";

/** One query's answer, as the model has read it. */
export interface Revision {
  readonly number: number;
  readonly query: GridQuery;
  snapshot: string | null;
  /** The first request is in flight: the others wait for the snapshot it starts. */
  starting: boolean;
  /** The source no longer has the snapshot: only a refresh reads more. */
  expired: boolean;
  readonly lists: Map<string, List>;
  root: List;
}

/** A parent's rows or groups, as far as they are known. */
export interface List {
  readonly revision: Revision;
  readonly parent: GroupKey;
  readonly id: string;
  readonly depth: number;
  /** Whether it holds rows (not groups). */
  readonly leaf: boolean;
  /** The group whose rows or groups these are: its list and place there. */
  readonly holder: { readonly list: List; readonly ordinal: number } | null;
  attached: boolean;
  total: number | null;
  /** How far it has been read while its total is not known. */
  frontier: number;
  /** Rows shown before anything is known: as many as the last query's. */
  provisional: number;
  readonly blocks: Map<number, Block>;
  /** Lists of its expanded groups, by their place. */
  children: List[];
  /** Each child's group row index within the list, and the rows the children up to it show. */
  heads: Float64Array;
  prefix: Float64Array;
  /** Rows the list shows, its children's too. */
  span: number;
}

/**
 * A block of a list: `blockSize` rows from `index × blockSize`, which one
 * request asks for and the source answers with a window of rows.
 */
export interface Block {
  readonly list: List;
  readonly index: number;
  state: "loading" | "loaded" | "failed" | "aborted";
  controller: AbortController | null;
  data: RowsWindow | null;
  fields: Fields | null;
  /** Each record's place in the block, by key. */
  keys: Map<RowKey, number> | null;
  version: number;
  used: number;
  bytes: number;
  /** The condition of the selection, compiled for the block. */
  test: { selection: RemoteSelection; at: (row: number) => boolean } | null;
}

export type RemoteRef = GridRef & { readonly list: List; readonly ordinal: number };

/** A selection the model made of a group (or of every row), followed to show its groups selected. */
export interface Scope {
  readonly selection: RemoteSelection;
  /** The group's key path; null for every row. */
  readonly path: GroupKey | null;
  /** The query's filter and grouping fields then, as JSON: the scope holds while they do. */
  readonly filter: string;
  readonly by: string;
}

/**
 * Records chosen by key, or every row meeting `where` (as the source holds
 * them, now and later) or keyed in `include`, but none keyed in `except`.
 */
export type RemoteSelection =
  | { readonly kind: "keys"; readonly keys: readonly RowKey[] }
  | {
      readonly kind: "matching";
      readonly where: Expression;
      readonly include: readonly RowKey[];
      readonly except: readonly RowKey[];
    };
