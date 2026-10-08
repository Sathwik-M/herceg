import type { NumericArray } from "./column.ts";
import type { CategoryField, Schema, Table } from "./table.ts";

/**
 * How a table describes a tree. With `id` and `parent`, each row is a node
 * naming its parent (rows without a parent are top-level). With `path`, each
 * row is a leaf at the end of its path of category fields, outermost first;
 * a path may stop early at a missing value.
 */
export type HierarchyEncoding<S extends Schema = Schema> =
  | { id: CategoryField<S>; parent: CategoryField<S> }
  | { path: readonly CategoryField<S>[] };

/**
 * A tree over a table's rows in packed arrays. Node 0 is a root of its own,
 * whose children are the table's top-level nodes; node i's children are
 * `children[childStart[i]]` to `children[childStart[i + 1] - 1]`, in the
 * order they first appear in the table.
 */
export interface Hierarchy {
  /** Nodes, the root included. */
  readonly size: number;
  /** Parent of each node; -1 for the root. */
  readonly parent: Int32Array;
  /** Depth of each node; the root is 0. */
  readonly depth: Uint32Array;
  /** The deepest node's depth. */
  readonly height: number;
  readonly childStart: Uint32Array;
  readonly children: Uint32Array;
  /** Every node, each after its parent. */
  readonly order: Uint32Array;
  /** Each node's name: its id or path value; "" for the root. */
  readonly names: readonly string[];
  /** The node each row belongs to; -1 for rows outside the tree. */
  readonly nodeOfRow: Int32Array;
}

/** Builds the tree a table describes; throws on duplicate ids, unknown parents, and cycles. */
export function hierarchy<S extends Schema>(
  table: Table<S>,
  encoding: HierarchyEncoding<S>,
): Hierarchy {
  const { parent, names, nodeOfRow } =
    "path" in encoding ? fromPaths(table, encoding.path) : fromParents(table, encoding);
  return link(parent, names, nodeOfRow);
}

function fromParents<S extends Schema>(
  table: Table<S>,
  encoding: { id: CategoryField<S>; parent: CategoryField<S> },
) {
  const ids = table.categories(encoding.id);
  const parents = table.categories(encoding.parent);
  const n = table.length;
  // Node of each id code, so parents resolve by name in either column.
  const nodeOfId = new Map<string, number>();
  const names = [""];
  const nodeOfRow = new Int32Array(n).fill(-1);
  for (let row = 0; row < n; row++) {
    const code = ids.codes[row]!;
    if (code < 0) continue;
    const id = ids.dictionary[code]!;
    if (nodeOfId.has(id)) throw new Error(`hierarchy: the id "${id}" appears twice`);
    nodeOfId.set(id, names.length);
    nodeOfRow[row] = names.length;
    names.push(id);
  }
  const parent = new Int32Array(names.length);
  parent[0] = -1;
  for (let row = 0; row < n; row++) {
    const node = nodeOfRow[row]!;
    if (node < 0) continue;
    const code = parents.codes[row]!;
    if (code < 0) continue;
    const name = parents.dictionary[code]!;
    const of = nodeOfId.get(name);
    if (of === undefined) {
      throw new Error(
        `hierarchy: "${names[node]}" has the parent "${name}", which no row has as its id`,
      );
    }
    parent[node] = of;
  }
  return { parent, names, nodeOfRow };
}

function fromPaths<S extends Schema>(table: Table<S>, path: readonly CategoryField<S>[]) {
  if (path.length === 0) throw new Error("hierarchy: a path needs at least one field");
  const levels = path.map((field) => table.categories(field));
  const n = table.length;
  const names = [""];
  const parents = [-1];
  // A node's child per name, keyed by parent node and the name's code: the
  // parent's depth decides which level's dictionary the code is from.
  const stride = Math.max(...levels.map((level) => level.dictionary.length)) + 1;
  const childOf = new Map<number, number>();
  const nodeOfRow = new Int32Array(n).fill(-1);
  for (let row = 0; row < n; row++) {
    let node = 0;
    for (const level of levels) {
      const code = level.codes[row]!;
      if (code < 0) break;
      const key = node * stride + code;
      let child = childOf.get(key);
      if (child === undefined) {
        child = names.length;
        childOf.set(key, child);
        names.push(level.dictionary[code]!);
        parents.push(node);
      }
      node = child;
    }
    if (node > 0) nodeOfRow[row] = node;
  }
  return { parent: Int32Array.from(parents), names, nodeOfRow };
}

/** Child lists, depths, and a parents-first order from the parent array. */
function link(parent: Int32Array, names: readonly string[], nodeOfRow: Int32Array): Hierarchy {
  const size = parent.length;
  const childStart = new Uint32Array(size + 1);
  for (let i = 1; i < size; i++) childStart[parent[i]! + 1]!++;
  for (let i = 0; i < size; i++) childStart[i + 1]! += childStart[i]!;
  const children = new Uint32Array(Math.max(0, size - 1));
  const next = childStart.slice(0, size);
  for (let i = 1; i < size; i++) children[next[parent[i]!]!++] = i;
  // Breadth first from the root: nodes on a cycle are never reached.
  const order = new Uint32Array(size);
  const depth = new Uint32Array(size);
  let reached = 1;
  let height = 0;
  for (let at = 0; at < reached; at++) {
    const node = order[at]!;
    for (let c = childStart[node]!; c < childStart[node + 1]!; c++) {
      const child = children[c]!;
      depth[child] = depth[node]! + 1;
      if (depth[child]! > height) height = depth[child]!;
      order[reached++] = child;
    }
  }
  if (reached < size) {
    const seen = new Uint8Array(size);
    for (let at = 0; at < reached; at++) seen[order[at]!] = 1;
    throw new Error(`hierarchy: "${names[seen.indexOf(0)]}" is its own ancestor`);
  }
  return { size, parent, depth, height, childStart, children, order, names, nodeOfRow };
}

/**
 * The total weight under each node: the sum of `weights` over the rows of
 * the node and its descendants, or the number of those rows without
 * weights. Missing weights count as zero; negative and infinite ones are
 * refused, as are totals too large for a double.
 */
export function subtreeValues(tree: Hierarchy, weights?: NumericArray): Float64Array {
  const values = new Float64Array(tree.size);
  const rows = tree.nodeOfRow;
  for (let row = 0; row < rows.length; row++) {
    const node = rows[row]!;
    if (node < 0) continue;
    const weight = weights ? weights[row]! : 1;
    if (Number.isNaN(weight)) continue;
    if (!(weight >= 0 && weight < Number.POSITIVE_INFINITY)) {
      throw new RangeError(`hierarchy: "${tree.names[node]}" has the weight ${weight}`);
    }
    values[node]! += weight;
  }
  for (let at = tree.size - 1; at > 0; at--) {
    const node = tree.order[at]!;
    values[tree.parent[node]!]! += values[node]!;
  }
  if (!Number.isFinite(values[0]!)) {
    throw new RangeError("hierarchy: the weights add up to more than a double holds");
  }
  return values;
}

/** Names from the outermost ancestor down to `node`, for labels and tooltips. */
export function pathOf(tree: Hierarchy, node: number): string[] {
  const names: string[] = [];
  for (let at = node; at > 0; at = tree.parent[at]!) names.push(tree.names[at]!);
  return names.reverse();
}

/**
 * A node's children, largest value first (ties in table order), in `scratch`
 * when it is long enough; the tree's own child list is not reordered.
 */
export function childrenByValue(
  tree: Hierarchy,
  values: Float64Array,
  node: number,
  scratch: Uint32Array,
): Uint32Array {
  const from = tree.childStart[node]!;
  const to = tree.childStart[node + 1]!;
  const out =
    scratch.length >= to - from ? scratch.subarray(0, to - from) : new Uint32Array(to - from);
  out.set(tree.children.subarray(from, to));
  return out.sort((a, b) => values[b]! - values[a]! || a - b);
}
