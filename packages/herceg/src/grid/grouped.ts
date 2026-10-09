// How a grid shows the groups of its rows (data/groups.ts): the groups in
// order, each header followed by its group's rows when expanded; what a
// header's cells say; and how many of each group's rows are selected. The
// model (model.ts) keeps the expansion, order, and selection these follow.

import type { RowGroups } from "../data/groups.ts";
import { rowComparator, type SortKey } from "../data/order.ts";
import type { RowView } from "../data/row-view.ts";
import type { DataSelection } from "../data/selection.ts";
import type { Table } from "../data/table.ts";
import { numberFormatter } from "../format/format.ts";
import { type FormatSettings, type PlacedColumn, valueFormatter } from "./columns.ts";

/**
 * The groups as shown: in order, where each one's header is, and which
 * show their rows. Headers' places are prefix counts, so a row index finds
 * its group by binary search; no object stands for any row.
 */
export interface Projection {
  readonly groups: RowGroups;
  /** Groups (rows of the groups' table) in display order. */
  readonly order: Uint32Array;
  /** Each group's place in `order`. */
  readonly rank: Int32Array;
  /** The row index of each header, in display order, then the number of rows. */
  readonly starts: Float64Array;
  /** 1 for each group showing its rows. */
  readonly open: Uint8Array;
}

/** The groups ordered by `sort` (stably; as they appeared without keys), and `isOpen` ones' rows. */
export function project(
  groups: RowGroups,
  sort: readonly SortKey[],
  isOpen: (id: string) => boolean,
): Projection {
  const count = groups.length;
  const order = new Uint32Array(count);
  for (let group = 0; group < count; group++) order[group] = group;
  if (sort.length > 0) order.sort(rowComparator(groups.table, sort));
  const rank = new Int32Array(count);
  const open = new Uint8Array(count);
  const starts = new Float64Array(count + 1);
  for (let place = 0; place < count; place++) {
    const group = order[place]!;
    rank[group] = place;
    open[group] = isOpen(groups.idOf(group)) ? 1 : 0;
    starts[place + 1] = starts[place]! + 1 + (open[group] ? groups.size(group) : 0);
  }
  return { groups, order, rank, starts, open };
}

/** The place in `order` of the group whose header or row is at `rowIndex`. */
export function placeOf({ starts, order }: Projection, rowIndex: number): number {
  // The last header at or before the row.
  let [lo, hi] = [0, order.length - 1];
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (starts[mid]! <= rowIndex) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * What each shown column says on a group's header: the first names the
 * group by its key and counts its rows, a column of a grouping field shows
 * the key's value, and a column with an aggregate shows it; others nothing.
 */
export function headerTexts(
  groups: RowGroups,
  layout: readonly PlacedColumn[],
  settings: FormatSettings,
  source: Table,
): ((group: number) => string)[] {
  const by = groups.by as readonly string[];
  // Keys as the first column showing their field writes its values, or plainly.
  const formats = by.map(
    (field) =>
      layout.find((column) => column.field === field)?.content.format ??
      valueFormatter(source.kind(field) as "number" | "time" | "category", undefined, settings),
  );
  const missing = settings.missing || "(missing)";
  const value = (group: number, k: number, format = formats[k]!) => {
    const key = groups.keyOf(group)[k]!;
    return key === null ? missing : format(key);
  };
  const count = numberFormatter({ maximumFractionDigits: 0 }, settings.locale);
  return layout.map((column, c): ((group: number) => string) => {
    if (c === 0)
      return (group) =>
        `${by.map((_, k) => value(group, k)).join(", ")} (${count(groups.size(group))})`;
    const k = by.indexOf(column.field);
    if (k >= 0) return (group) => value(group, k, column.content.format);
    const aggregate = groups.aggregates.find(({ name }) => name === column.content.aggregate);
    if (!aggregate) return () => "";
    const { name, op, field } = aggregate;
    const kind = groups.table.kind(name) as "number" | "time";
    // The column's format suits aggregates of its own field that keep its kind, not counts.
    const format =
      field === column.field && kind === column.kind && op !== "count"
        ? column.content.format
        : valueFormatter(kind, undefined, settings);
    return (group) => format(groups.table.numbers(name)[group]!);
  });
}

/** Selected rows per group, and the state they were counted in. */
export interface SelectedCounts {
  readonly groups: RowGroups;
  /** The selection store's revision, which every change of a selection moves. */
  readonly revision: number;
  readonly generation: number;
  readonly rowOffset: number;
  readonly modified: number;
  readonly query: number;
  /** The groups' table's generation, which a renumbering of the groups starts again. */
  readonly renumbered: number;
  readonly version: number;
  readonly counts: Float64Array;
}

/**
 * Counts each group's selected rows: a row set's members (a pass over its
 * bits), or the rows meeting a condition (a pass over the table).
 */
export function countSelected(
  groups: RowGroups,
  selection: DataSelection | null,
  revision: number,
  test: (position: number) => boolean,
  view: RowView,
): SelectedCounts {
  const counts = new Float64Array(groups.length);
  if (selection?.kind === "rows") {
    for (const position of selection.rows.positions()) {
      const group = groups.groupOf(position);
      if (group >= 0) counts[group]!++;
    }
  } else if (selection) {
    for (let position = 0; position < view.source.length; position++) {
      if (!test(position)) continue;
      const group = groups.groupOf(position);
      if (group >= 0) counts[group]!++;
    }
  }
  return stamped(groups, revision, view, counts);
}

/** Counts of the groups' selected rows as of now. */
export function stamped(
  groups: RowGroups,
  revision: number,
  view: RowView,
  counts: Float64Array,
): SelectedCounts {
  const source = view.source;
  return {
    groups,
    revision,
    generation: source.generation,
    rowOffset: source.rowOffset,
    modified: source.modifiedVersion,
    query: view.queryRevision,
    renumbered: groups.table.generation,
    version: source.version,
    counts,
  };
}

/**
 * Whether counts still hold for the store at `revision`: no selection
 * changed (a row set put in again may have changed), nothing but appends
 * changed the groups' rows (rows appended join no row set, and groups they
 * start have none selected), and for a condition `selection`, which
 * appended rows can meet, nothing changed at all.
 */
export function countsHold(
  counts: SelectedCounts,
  groups: RowGroups,
  revision: number,
  selection: DataSelection | null,
  view: RowView,
): boolean {
  const source = view.source;
  return (
    counts.groups === groups &&
    counts.revision === revision &&
    counts.generation === source.generation &&
    counts.rowOffset === source.rowOffset &&
    counts.modified === source.modifiedVersion &&
    counts.query === view.queryRevision &&
    counts.renumbered === groups.table.generation &&
    (selection?.kind !== "predicate" || counts.version === source.version)
  );
}
