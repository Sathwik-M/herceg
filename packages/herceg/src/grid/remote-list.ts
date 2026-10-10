// The answer's tree: sparse sibling lists, their loaded windows, and the
// rows shown by expanded groups.

import { type GroupKey, groupId } from "../data/groups.ts";
import type { GridAggregate, GridQuery } from "./query.ts";
import type { Block, List, RemoteRef, Revision } from "./remote-types.ts";
import { type RowsWindow, valueAt } from "./source.ts";

/** A new revision of the query, showing `provisional` rows until the source says. */
export function start(
  number: number,
  query: GridQuery,
  provisional: number,
  blockSize: number,
): Revision {
  const revision: Revision = {
    number,
    query,
    snapshot: null,
    starting: false,
    expired: false,
    lists: new Map(),
    root: undefined as unknown as List,
  };
  revision.root = _list(revision, [], null, null, provisional, blockSize);
  return revision;
}

function _list(
  revision: Revision,
  parent: GroupKey,
  holder: List["holder"],
  total: number | null,
  provisional: number,
  blockSize: number,
): List {
  const depth = parent.length;
  const list: List = {
    revision,
    // A copy: a key path the caller changes later must not move the list.
    parent: Object.freeze([...parent]),
    id: groupId(parent),
    depth,
    leaf: depth === (revision.query.group?.by.length ?? 0),
    holder,
    attached: true,
    total,
    frontier: 0,
    provisional,
    blocks: new Map(),
    children: [],
    heads: new Float64Array(0),
    prefix: new Float64Array(0),
    span: 0,
  };
  list.span = count(list, blockSize);
  revision.lists.set(list.id, list);
  return list;
}

/** Shows the list of an expanded group at `ordinal` of `list`. */
export function attach(
  list: List,
  ordinal: number,
  key: GroupKey,
  total: number | null,
  blockSize: number,
  abort: (block: Block) => void,
): List {
  // A group shown at another place (a source whose places moved) leaves it.
  const elsewhere = list.revision.lists.get(groupId(key));
  if (elsewhere?.holder && (elsewhere.holder.list !== list || elsewhere.holder.ordinal !== ordinal))
    detach(elsewhere, blockSize, abort);
  let existing = list.children.find(({ holder }) => holder!.ordinal === ordinal);
  // Another group's list at that place is of where it was.
  if (existing && existing.id !== groupId(key)) {
    detach(existing, blockSize, abort);
    existing = undefined;
  }
  if (existing) {
    if (existing.total === null && total !== null) {
      existing.total = total;
      recount(existing, blockSize, abort);
    }
    return existing;
  }
  const child = _list(list.revision, key, { list, ordinal }, total, 0, blockSize);
  const children = [...list.children, child].sort((a, b) => a.holder!.ordinal - b.holder!.ordinal);
  list.children = children;
  recount(list, blockSize, abort);
  return child;
}

/** Stops showing a list and those below it, aborting their requests. */
export function detach(list: List, blockSize: number, abort: (block: Block) => void) {
  _drop(list, abort);
  const holder = list.holder;
  if (holder?.list.attached) {
    holder.list.children = holder.list.children.filter((child) => child !== list);
    recount(holder.list, blockSize, abort);
  }
}

/** Forgets a list and those below it. */
function _drop(list: List, abort: (block: Block) => void) {
  for (const child of list.children) _drop(child, abort);
  for (const block of [...list.blocks.values()]) abort(block);
  list.blocks.clear();
  list.attached = false;
  list.revision.lists.delete(list.id);
}

/** Counts the rows a list shows again, and those of the lists above it. */
export function recount(list: List, blockSize: number, abort: (block: Block) => void) {
  for (let at: List | undefined = list; at; at = at.holder?.list) {
    const n = count(at, blockSize);
    // Groups past the end (a total smaller than thought) are not shown.
    const gone = at.children.filter(({ holder }) => holder!.ordinal >= n);
    for (const child of gone) _drop(child, abort);
    if (gone.length > 0) at.children = at.children.filter((child) => child.attached);
    const heads = new Float64Array(at.children.length);
    const prefix = new Float64Array(at.children.length);
    let shown = 0;
    at.children.forEach((child, i) => {
      heads[i] = child.holder!.ordinal + shown;
      shown += child.span;
      prefix[i] = shown;
    });
    at.heads = heads;
    at.prefix = prefix;
    at.span = n + shown;
    if (!at.attached) break;
  }
}

/** The list and place of the row at `rowIndex`. */
export function at(root: List, rowIndex: number, length: number): { list: List; ordinal: number } {
  if (!(Number.isInteger(rowIndex) && rowIndex >= 0 && rowIndex < length))
    throw new RangeError(`Row ${rowIndex} is not among the grid's ${length} rows`);
  let list = root;
  let x = rowIndex;
  for (;;) {
    const { heads, prefix, children } = list;
    // The last child whose group row is before x.
    let [lo, hi] = [0, heads.length];
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (heads[mid]! < x) lo = mid + 1;
      else hi = mid;
    }
    const i = lo - 1;
    if (i >= 0 && x <= heads[i]! + children[i]!.span) {
      x -= heads[i]! + 1;
      list = children[i]!;
      continue;
    }
    return { list, ordinal: x - (i >= 0 ? prefix[i]! : 0) };
  }
}

/** The row index of place `ordinal` of an attached list. */
export function indexOf(list: List, ordinal: number): number {
  let index = 0;
  for (let at: List | null = list, place = ordinal; at; ) {
    const { children, prefix } = at;
    // Children whose groups come before the place.
    let [lo, hi] = [0, children.length];
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (children[mid]!.holder!.ordinal < place) lo = mid + 1;
      else hi = mid;
    }
    index += place + (lo > 0 ? prefix[lo - 1]! : 0);
    const holder: List["holder"] = at.holder;
    if (!holder) break;
    index += 1;
    at = holder.list;
    place = holder.ordinal;
  }
  return index;
}

/** A loaded group of a list by id: its place and how many children it has. */
export function findGroup(
  list: List,
  id: string,
  blockSize: number,
): { ordinal: number; children: number } | null {
  const by = groupFields(list.revision);
  for (const block of list.blocks.values()) {
    if (block.state !== "loaded") continue;
    const data = block.data as RowsWindow & { kind: "groups" };
    for (let row = 0; row < data.length; row++)
      if (groupId([...list.parent, groupValue(block, list.depth, row, by)]) === id)
        return {
          ordinal: block.index * blockSize + row,
          children: data.childCounts[row]!,
        };
  }
  return null;
}

/** Rows a list shows itself: its total, or as far as it is read and a block more. */
export function count(list: List, size = 0): number {
  if (list.total !== null) return list.total;
  return Math.max(list.provisional, list.frontier + size);
}

export function refOf(list: List, ordinal: number): RemoteRef {
  return { scope: list.revision, id: `${list.id}${ordinal}`, list, ordinal };
}

/** The value of a group's own grouping field: a label, a number, or null for missing. */
export function groupValue(
  block: Block,
  depth: number,
  row: number,
  by: readonly string[],
): string | number | null {
  return valueAt(block.data!, by[depth]!, row);
}

export function aggregateKind(aggregate: GridAggregate, fields: Record<string, string>): string {
  const { op, field } = aggregate;
  return op !== "count" && op !== "sum" && field !== undefined && fields[field] === "time"
    ? "time"
    : "number";
}

export function isPrefix(prefix: GroupKey, path: GroupKey): boolean {
  return prefix.length <= path.length && groupId(path.slice(0, prefix.length)) === groupId(prefix);
}

export function groupFields(revision: Revision): readonly string[] {
  return revision.query.group?.by ?? [];
}

/** The record's key, or null for a source without keys. */
export function keyOf(block: Block, row: number, key: string | null) {
  return key === null ? null : valueAt(block.data!, key, row);
}
