// What treemaps and sunbursts share: the tree a table describes, each node's
// total, the top-level branch it belongs to, and the legend of branches.

import {
  childrenByValue,
  type Hierarchy,
  type HierarchyEncoding,
  hierarchy,
  pathOf,
  pruneHierarchy,
  subtreeValues,
} from "../data/hierarchy.ts";
import type { Table } from "../data/table.ts";
import type { LegendEntry } from "../model/legend.ts";
import { type LayoutItem, type LayoutResult, RowsCache } from "./layout-mark.ts";
import { CATEGORY, requireField } from "./mark.ts";

/** How a spec names a tree: a path of category fields, or node and parent fields. */
export interface TreeFields {
  path?: readonly string[];
  node?: string;
  parent?: string;
  value?: string;
}

/** A top-level node with a value: a legend entry and a color. */
export interface Branch {
  node: number;
  key: string;
  label: string;
}

/** Why a tree's fields name it neither or both ways (a path, or node and parent), if they do. */
export function treeFormError(
  fields: { path?: unknown; node?: unknown; parent?: unknown },
  role: string,
): string | undefined {
  if (fields.path !== undefined && (fields.node !== undefined || fields.parent !== undefined))
    return `${role} takes a path, or node and parent fields, not both`;
  if (fields.path === undefined && (fields.node === undefined || fields.parent === undefined))
    return `${role} needs a path of category fields, or node and parent fields`;
  return undefined;
}

/**
 * A tree as a panel draws it: a chart's one panel the table's whole tree,
 * and a facet panel the part its rows give a value (see `TreeData.view`).
 */
export interface TreeView {
  tree: Hierarchy;
  /** Each node's total over the panel's rows. */
  values: Float64Array;
  /** Each node's top-level ancestor; -1 for the root. */
  branch: Int32Array;
  /** The top-level nodes with a value, largest over the whole table first: the legend's order. */
  tops: readonly { node: number; label: string }[];
}

export class TreeData {
  readonly table: Table;
  readonly encoding: HierarchyEncoding;
  readonly #value: string | undefined;
  /** The whole table's tree, and the table version it is for. */
  #whole: { version: number; view: TreeView } | undefined;
  /** The part of the tree each facet panel's rows give a value. */
  readonly #parts = new RowsCache<TreeView>();

  constructor(table: Table, fields: TreeFields, role: string) {
    const problem = treeFormError(fields, role);
    if (problem) throw new Error(problem);
    if (fields.path) {
      if (fields.path.length === 0) throw new Error(`${role} path needs at least one field`);
      for (const field of fields.path) requireField(table, field, CATEGORY, `${role} path`);
      this.encoding = { path: fields.path };
    } else {
      requireField(table, fields.node!, CATEGORY, `${role} node`);
      requireField(table, fields.parent!, CATEGORY, `${role} parent`);
      this.encoding = { id: fields.node!, parent: fields.parent! };
    }
    if (fields.value !== undefined) requireField(table, fields.value, ["number"], `${role} value`);
    this.table = table;
    this.#value = fields.value;
  }

  #weights() {
    return this.#value === undefined ? undefined : this.table.numbers(this.#value);
  }

  /**
   * The tree the table describes, each node's total, and each node's
   * top-level ancestor, rebuilt when the table changes; with `rows` (a facet
   * panel's), the part of it those rows give a value, as a tree of its own,
   * so each panel keeps only its own nodes. Nodes keep their names, and so
   * their keys, in every part.
   */
  view(rows?: Uint32Array): TreeView {
    const table = this.table;
    if (this.#whole?.version !== table.version) {
      const tree = hierarchy(table, this.encoding);
      const values = subtreeValues(tree, this.#weights());
      const tops = Array.from(tree.children.subarray(tree.childStart[0]!, tree.childStart[1]!))
        .filter((node) => values[node]! > 0)
        .sort((a, b) => values[b]! - values[a]! || a - b)
        .map((node) => ({ node, label: tree.names[node]! }));
      this.#whole = {
        version: table.version,
        view: { tree, values, branch: branchOf(tree), tops },
      };
    }
    const whole = this.#whole.view;
    if (!rows) return whole;
    return this.#parts.get(table, rows, () => {
      const totals = subtreeValues(whole.tree, this.#weights(), rows);
      const { tree, values, index } = pruneHierarchy(whole.tree, totals);
      const tops = whole.tops.flatMap(({ node, label }) =>
        index[node]! > 0 ? [{ node: index[node]!, label }] : [],
      );
      return { tree, values, branch: branchOf(tree), tops };
    });
  }

  /** The top-level nodes of `view` (the whole tree's by default) with a value, keyed for the mark `id`. */
  branches(id: string | number, view = this.view()): Branch[] {
    return view.tops.map(({ node, label }) => ({ node, key: JSON.stringify([id, label]), label }));
  }

  legend(id: string | number, color: (key: string) => string): LegendEntry[] {
    return this.branches(id).map(({ key, label }) => ({ key, label, color: color(key) }));
  }

  /** Each node's total in `view`, with the `branches` hidden through the legend counting as nothing. */
  shown(view: TreeView, branches: readonly Branch[], hidden: ReadonlySet<string>): Float64Array {
    const { tree, values, branch } = view;
    const out = values.slice();
    const hiddenNodes = new Set(branches.filter(({ key }) => hidden.has(key)).map((b) => b.node));
    if (hiddenNodes.size === 0) return out;
    for (let node = 1; node < tree.size; node++) {
      if (hiddenNodes.has(branch[node]!)) out[node] = 0;
    }
    out[0] = 0;
    for (const { node } of branches) out[0] += out[node]!;
    return out;
  }

  /**
   * An item's key: the mark's id and the node's path in `tree`, or with node
   * and parent fields its name, which is unique, so moving a node keeps its key.
   */
  keyOf(id: string | number, tree: Hierarchy, node: number): string {
    return JSON.stringify(
      "path" in this.encoding ? [id, ...pathOf(tree, node)] : [id, tree.names[node]],
    );
  }

  /** The node of `tree` an item key of the mark `id` names; -1 when none does. */
  nodeOf(id: string | number, tree: Hierarchy, key: string): number {
    let names: unknown;
    try {
      names = JSON.parse(key);
    } catch {
      return -1;
    }
    if (!Array.isArray(names) || names.length < 2 || names[0] !== id) return -1;
    if (!("path" in this.encoding)) {
      return names.length === 2 ? tree.names.indexOf(names[1] as string, 1) : -1;
    }
    let node = 0;
    for (const name of names.slice(1)) {
      let next = -1;
      for (let c = tree.childStart[node]!; c < tree.childStart[node + 1]!; c++) {
        if (tree.names[tree.children[c]!] === name) next = tree.children[c]!;
      }
      if (next < 0) return -1;
      node = next;
    }
    return node;
  }

  /**
   * Keyboard reading of the drawn nodes of `tree`: depth first, each node's
   * children largest first. The order is worked out when first asked for,
   * and items only one at a time.
   */
  navigation(
    id: string | number,
    tree: Hierarchy,
    shown: Float64Array,
    drawn: (node: number) => boolean,
    itemOf: (node: number) => LayoutItem,
  ): Pick<LayoutResult, "count" | "item" | "indexOf"> {
    let order: Int32Array | undefined;
    let place: Int32Array | undefined;
    const ordered = (): Int32Array => {
      if (order) return order;
      const out: number[] = [];
      const stack = [0];
      let scratch: Uint32Array = new Uint32Array(16);
      while (stack.length > 0) {
        const node = stack.pop()!;
        if (node > 0) out.push(node);
        const children = childrenByValue(tree, shown, node, scratch);
        if (children.length > scratch.length) scratch = children;
        // Pushed smallest first, so the largest comes off the stack first.
        for (let i = children.length - 1; i >= 0; i--) {
          const child = children[i]!;
          if (shown[child]! > 0 && drawn(child)) stack.push(child);
        }
      }
      order = Int32Array.from(out);
      return order;
    };
    return {
      get count() {
        return ordered().length;
      },
      item: (index) => itemOf(ordered()[index]!),
      indexOf: (key) => {
        const node = this.nodeOf(id, tree, key);
        if (node < 0) return -1;
        if (!place) {
          place = new Int32Array(tree.size).fill(-1);
          ordered().forEach((at, i) => {
            place![at] = i;
          });
        }
        return place[node]!;
      },
    };
  }

  /** The branches that have a value in `shown`, largest first, for summaries. */
  largest(branches: readonly Branch[], shown: Float64Array): Branch[] {
    return branches
      .filter(({ node }) => shown[node]! > 0)
      .sort((a, b) => shown[b.node]! - shown[a.node]!);
  }

  /** Leaves of `tree` with a value in `shown`, for summaries. */
  leaves(tree: Hierarchy, shown: Float64Array): number {
    let count = 0;
    for (let node = 1; node < tree.size; node++) {
      if (shown[node]! > 0 && tree.childStart[node] === tree.childStart[node + 1]) count++;
    }
    return count;
  }
}

/** Each node's top-level ancestor (itself at the top level); -1 for the root. */
function branchOf(tree: Hierarchy): Int32Array {
  const branch = new Int32Array(tree.size).fill(-1);
  for (let at = 1; at < tree.size; at++) {
    const node = tree.order[at]!;
    const parent = tree.parent[node]!;
    branch[node] = parent === 0 ? node : branch[parent]!;
  }
  return branch;
}

/** "1 group", "2 groups". */
export function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
