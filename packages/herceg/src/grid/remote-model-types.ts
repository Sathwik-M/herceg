import type { GroupKey } from "../data/groups.ts";
import type { Schema } from "../data/table.ts";
import type { GridRef, GridSettings } from "./base.ts";
import type { GridColumn } from "./columns.ts";
import type { GridQuery, GridQueryOf, RowKey } from "./query.ts";
import type { RemoteSelectionStore } from "./remote-selection.ts";
import type { GridSource } from "./source.ts";

/** A query as `setQuery` takes it: its version and source may be left out. */
export type GridQueryInput<S extends Schema = Schema> = Omit<GridQueryOf<S>, "version" | "source"> &
  Partial<Pick<GridQuery, "version" | "source">>;

export interface RemoteGridModelOptions<S extends Schema = Schema> extends GridSettings {
  /** Where the rows are; the application owns it. */
  source: GridSource<S>;
  /** The query; every row in the source's order by default. */
  query?: GridQueryInput<S>;
  columns: readonly GridColumn<S>[];
  /** Where the selection goes; a store of the grid's own when left out. */
  selectionStore?: RemoteSelectionStore;
  /** The store's channel for the selection; "grid-rows" by default. */
  channel?: string;
  /** Rows a block holds: what one request asks for. 128 by default. */
  blockSize?: number;
  /** Blocks kept besides those the view wants; 16 by default. */
  cachedBlocks?: number;
  /** Bytes of blocks kept besides those in view; 8 MiB by default. */
  cacheBytes?: number;
  /** Requests in flight at once; 2 by default. */
  maxRequests?: number;
  /** Groups expanded at once; 256 by default. */
  maxExpanded?: number;
  /**
   * Milliseconds a jump (a scrollbar dragged far) waits for the scrolling to
   * settle before asking for rows, and never more than three times as long
   * while it goes on; 50 by default, 0 to ask at once.
   */
  settleDelay?: number;
}

/**
 * What a row of a remote grid shows: a record (with its key, when the source
 * names a key field), a group's header, or a placeholder for one still
 * loading or that failed to load.
 */
export type RemoteGridRow =
  | {
      readonly kind: "row";
      readonly ref: GridRef;
      readonly version: number;
      /** The record's key, or null when the source names no key field. */
      readonly key: RowKey | null;
      readonly level: number;
      /** Its place among its group's rows (or the grid's), and how many there are (-1: unknown). */
      readonly setIndex: number;
      readonly setSize: number;
    }
  | {
      readonly kind: "group";
      readonly ref: GridRef;
      readonly version: number;
      /** Its key path: its value of each grouping field down to its level's. */
      readonly key: GroupKey;
      readonly id: string;
      /** Rows the group holds, in its groups below too. */
      readonly rows: number;
      readonly expanded: boolean;
      readonly level: number;
      readonly setIndex: number;
      readonly setSize: number;
    }
  | {
      readonly kind: "placeholder";
      readonly ref: GridRef;
      readonly version: number;
      readonly state: "loading" | "failed";
      readonly level: number;
      readonly setIndex: number;
      readonly setSize: number;
      readonly indent: number;
    };

/** What a remote grid is doing. */
export interface RemoteGridStatus {
  /** Requests in flight. */
  readonly loading: number;
  /** Whether the grid waits for the first answer to its query. */
  readonly starting: boolean;
  /** Blocks that failed, shown as failed rows until `retry`. */
  readonly failed: number;
  /** The last failure, until `retry` or a new query. */
  readonly error: Error | null;
  /** Rows of the query (groups of its first level), or null while the source has not said. */
  readonly total: number | null;
  /** Blocks held, and their bytes. */
  readonly blocks: number;
  readonly bytes: number;
}

/** What the model said about a command it refused, counted so a renderer announces each once. */
export interface RemoteGridMessage {
  readonly text: string;
  readonly count: number;
}
