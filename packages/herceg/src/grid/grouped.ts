// How a grid shows row groups (data/groups.ts): the groups of the first
// level in order, each header followed, when expanded, by its groups of the
// level below in order (and so on), or on the last level by its rows; what a
// header's cells say; and how many of each group's rows are selected. The
// model (model.ts) keeps the expansion, order, and selection these follow.

import type { Fields } from "../data/expression.ts";
import type { RowGroups } from "../data/groups.ts";
import { rowComparator, type SortKey } from "../data/order.ts";
import type { RowView } from "../data/row-view.ts";
import type { DataSelection } from "../data/selection.ts";
import type { Table } from "../data/table.ts";
import { numberFormatter } from "../format/format.ts";
import { type FormatSettings, type PlacedColumn, valueFormatter } from "./columns.ts";

/**
 * The groups as shown: the headers shown in order, where each one is, and
 * which groups are expanded. Headers' places are prefix counts, so a row
 * index finds its header by binary search and a group's row by its offset
 * past it; no object stands for any row.
 */
export interface Projection {
  readonly groups: RowGroups;
  /** Headers shown. */
  readonly count: number;
  /** Each header's group, and the group's depth. */
  readonly heads: Int32Array;
  readonly depths: Uint8Array;
  /** The row index of each header, then the number of rows. */
  readonly starts: Float64Array;
  /** Each header's place among its group's siblings, from 0, and how many there are. */
  readonly places: Int32Array;
  readonly siblings: Int32Array;
  /** Per depth, each group's header among those shown, or -1 while a group above is collapsed. */
  readonly rank: readonly Int32Array[];
  /** Per depth, 1 for groups shown expanded. */
  readonly open: readonly Uint8Array[];
}

/**
 * The groups of each level ordered by `sort` (by those of its keys the
 * level's table has, stably; as they appeared without any), under the
 * expanded groups above them, and the rows of expanded last-level groups.
 * Only the groups shown are sorted, and their expansion read. `tables` are
 * the fields each level shown sorts by, its table by default; a pivot shows
 * its first level alone, sorted by its crosstab.
 */
export function project(
  groups: RowGroups,
  sort: readonly SortKey[],
  isOpen: (id: string) => boolean,
  tables: readonly Fields[] = groups.by.map((field) => groups.tableOf(field)),
): Projection {
  const last = tables.length - 1;
  const counts = tables.map((_, depth) => groups.countAt(depth));
  const total = counts.reduce((sum, count) => sum + count, 0);
  const heads = new Int32Array(total);
  const depths = new Uint8Array(total);
  const starts = new Float64Array(total + 1);
  const places = new Int32Array(total);
  const siblings = new Int32Array(total);
  const rank = counts.map((count) => new Int32Array(count).fill(-1));
  const open = counts.map((count) => new Uint8Array(count));
  const orders = tables.map((table) => {
    const keys = sort.filter(({ field }) => table.has(field));
    return keys.length > 0 ? rowComparator(table, keys) : null;
  });
  let shown = 0;
  let row = 0;
  const visit = (list: Int32Array, depth: number) => {
    const order = orders[depth];
    if (order) list.sort(order);
    for (let i = 0; i < list.length; i++) {
      const group = list[i]!;
      const at = shown++;
      heads[at] = group;
      depths[at] = depth;
      starts[at] = row++;
      places[at] = i;
      siblings[at] = list.length;
      rank[depth]![group] = at;
      if (!isOpen(groups.idOf(group, depth))) continue;
      open[depth]![group] = 1;
      if (depth === last) row += groups.size(group, depth);
      else visit(groups.childrenOf(group, depth).slice(), depth + 1);
    }
  };
  visit(
    Int32Array.from({ length: counts[0]! }, (_, group) => group),
    0,
  );
  starts[shown] = row;
  return { groups, count: shown, heads, depths, starts, places, siblings, rank, open };
}

/** The header shown at or before `rowIndex`: the row's own, or its group's when it is a row of the table. */
export function placeOf({ starts, count }: Projection, rowIndex: number): number {
  let [lo, hi] = [0, count - 1];
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (starts[mid]! <= rowIndex) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * The header that shows a group at `depth`: its own while the groups above
 * it are expanded, else the first collapsed one above it.
 */
export function shownAs(
  { groups, open }: Projection,
  depth: number,
  group: number,
): { depth: number; group: number } {
  const path = new Int32Array(depth + 1);
  path[depth] = group;
  for (let d = depth; d > 0; d--) path[d - 1] = groups.parentOf(path[d]!, d);
  for (let d = 0; d < depth; d++) if (!open[d]![path[d]!]) return { depth: d, group: path[d]! };
  return { depth, group };
}

/**
 * What each shown column says on a group's header: the first names the
 * group by its own key value and counts its rows, a column of a grouping
 * field shows the key's value (on the field's level and below), and a
 * column with an aggregate shows the group's; others nothing.
 */
export function headerTexts(
  groups: RowGroups,
  layout: readonly PlacedColumn[],
  settings: FormatSettings,
  source: Table,
): ((group: number, depth: number) => string)[] {
  const by = groups.by as readonly string[];
  // Keys as the first column showing their field writes its values, or plainly.
  const formats = by.map(
    (field) =>
      layout.find((column) => column.field === field)?.content.format ??
      valueFormatter(source.kind(field) as "number" | "time" | "category", undefined, settings),
  );
  const missing = settings.missing || "(missing)";
  const value = (group: number, depth: number, k: number, format = formats[k]!) => {
    const key = groups.keyOf(group, depth)[k]!;
    return key === null ? missing : format(key);
  };
  const count = numberFormatter({ maximumFractionDigits: 0 }, settings.locale);
  const tables = by.map((field) => groups.tableOf(field));
  return layout.map((column, c): ((group: number, depth: number) => string) => {
    if (c === 0)
      return (group, depth) =>
        `${value(group, depth, depth)} (${count(groups.size(group, depth))})`;
    const k = by.indexOf(column.field);
    if (k >= 0)
      return (group, depth) => (k <= depth ? value(group, depth, k, column.content.format) : "");
    const aggregate = groups.aggregates.find(({ name }) => name === column.content.aggregate);
    if (!aggregate) return () => "";
    const { name, op, field } = aggregate;
    const kind = groups.table.kind(name) as "number" | "time";
    // The column's format suits aggregates of its own field that keep its kind, not counts.
    const format =
      field === column.field && kind === column.kind && op !== "count"
        ? column.content.format
        : valueFormatter(kind, undefined, settings);
    return (group, depth) => format(tables[depth]!.numbers(name)[group]!);
  });
}

/** Selected rows per group at each depth, and the state they were counted in. */
export interface SelectedCounts {
  readonly groups: RowGroups;
  /** The selection store's revision, which every change of a selection moves. */
  readonly revision: number;
  readonly generation: number;
  readonly rowOffset: number;
  readonly modified: number;
  readonly query: number;
  /** The last level's table's generation, which a renumbering of the groups starts again. */
  readonly renumbered: number;
  readonly version: number;
  readonly counts: readonly Float64Array[];
}

/**
 * Counts each group's selected rows: a row set's members (a pass over its
 * bits), or the rows meeting a condition (a pass over the table), each
 * counted for its last-level group, whose counts add up level by level.
 */
export function countSelected(
  groups: RowGroups,
  selection: DataSelection | null,
  revision: number,
  test: (position: number) => boolean,
  view: RowView,
): SelectedCounts {
  const last = groups.by.length - 1;
  const counts = groups.by.map((_, depth) => new Float64Array(groups.countAt(depth)));
  const leaves = counts[last]!;
  if (selection?.kind === "rows") {
    for (const position of selection.rows.positions()) {
      const group = groups.groupOf(position);
      if (group >= 0) leaves[group]!++;
    }
  } else if (selection) {
    for (let position = 0; position < view.source.length; position++) {
      if (!test(position)) continue;
      const group = groups.groupOf(position);
      if (group >= 0) leaves[group]!++;
    }
  }
  for (let depth = last; depth > 0; depth--) {
    const below = counts[depth]!;
    const above = counts[depth - 1]!;
    for (let group = 0; group < below.length; group++)
      above[groups.parentOf(group, depth)]! += below[group]!;
  }
  return stamped(groups, revision, view, counts);
}

/** Counts of the groups' selected rows as of now. */
export function stamped(
  groups: RowGroups,
  revision: number,
  view: RowView,
  counts: readonly Float64Array[],
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
 * start have none selected; a group renumbered renumbers the last level,
 * whose rows it holds), and for a condition `selection`, which appended rows
 * can meet, nothing changed at all.
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

/** Counts with room for groups added since, which have none selected. */
export function extended(counts: readonly Float64Array[], groups: RowGroups): Float64Array[] {
  return counts.map((at, depth) => {
    const count = groups.countAt(depth);
    if (at.length >= count) return at;
    const next = new Float64Array(count);
    next.set(at);
    return next;
  });
}

/** Counts a row of a last-level group selected (`delta` 1) or not (-1) in it and the groups above. */
export function countRow(
  counts: readonly Float64Array[],
  groups: RowGroups,
  group: number,
  delta: number,
) {
  for (let depth = counts.length - 1; depth >= 0; depth--) {
    counts[depth]![group]! += delta;
    if (depth > 0) group = groups.parentOf(group, depth);
  }
}

/** Counts every row of a group (and its groups below) selected, or none, and the groups above. */
export function countGroup(
  counts: readonly Float64Array[],
  groups: RowGroups,
  depth: number,
  group: number,
  all: boolean,
) {
  const delta = (all ? groups.size(group, depth) : 0) - counts[depth]![group]!;
  const fill = (g: number, d: number) => {
    counts[d]![g] = all ? groups.size(g, d) : 0;
    for (const child of groups.childrenOf(g, d)) fill(child, d + 1);
  };
  fill(group, depth);
  for (let d = depth, g = group; d > 0; d--) {
    g = groups.parentOf(g, d);
    counts[d - 1]![g]! += delta;
  }
}
