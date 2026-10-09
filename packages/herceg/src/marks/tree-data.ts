// What treemaps and sunbursts share: the tree a table describes, each node's
// total, the top-level branch it belongs to, and the legend of branches.

import {
  childrenByValue,
  type Hierarchy,
  type HierarchyEncoding,
  hierarchy,
  pathOf,
  subtreeValues,
} from "../data/hierarchy.ts";
import type { Table } from "../data/table.ts";
import type { LegendEntry } from "../model/legend.ts";
import type { LayoutItem, LayoutResult } from "./layout-mark.ts";
import { CATEGORY, requireField } from "./mark.ts";

/** How a spec names a tree: a path of category fields, or node and parent fields. */
export interface TreeFields {
  path?: string[];
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

export class TreeData {
  readonly table: Table;
  readonly encoding: HierarchyEncoding;
  readonly #value: string | undefined;
  #built:
    | { version: number; tree: Hierarchy; values: Float64Array; branch: Int32Array }
    | undefined;

  constructor(table: Table, fields: TreeFields, role: string) {
    if (fields.path && (fields.node !== undefined || fields.parent !== undefined)) {
      throw new Error(`${role} takes a path, or node and parent fields, not both`);
    }
    if (fields.path) {
      if (fields.path.length === 0) throw new Error(`${role} path needs at least one field`);
      for (const field of fields.path) requireField(table, field, CATEGORY, `${role} path`);
      this.encoding = { path: fields.path };
    } else if (fields.node !== undefined && fields.parent !== undefined) {
      requireField(table, fields.node, CATEGORY, `${role} node`);
      requireField(table, fields.parent, CATEGORY, `${role} parent`);
      this.encoding = { id: fields.node, parent: fields.parent };
    } else {
      throw new Error(`${role} needs a path of category fields, or node and parent fields`);
    }
    if (fields.value !== undefined) requireField(table, fields.value, ["number"], `${role} value`);
    this.table = table;
    this.#value = fields.value;
  }

  /** The tree, each node's total, and each node's top-level ancestor, rebuilt when the table changes. */
  get built() {
    const table = this.table;
    if (this.#built?.version === table.version) return this.#built;
    const tree = hierarchy(table, this.encoding);
    const values = subtreeValues(
      tree,
      this.#value === undefined ? undefined : table.numbers(this.#value),
    );
    const branch = new Int32Array(tree.size).fill(-1);
    for (let at = 1; at < tree.size; at++) {
      const node = tree.order[at]!;
      const parent = tree.parent[node]!;
      branch[node] = parent === 0 ? node : branch[parent]!;
    }
    this.#built = { version: table.version, tree, values, branch };
    return this.#built;
  }

  /** Top-level nodes with a value, largest first. */
  branches(id: string | number): Branch[] {
    const { tree, values } = this.built;
    return Array.from(tree.children.subarray(tree.childStart[0]!, tree.childStart[1]!))
      .filter((node) => values[node]! > 0)
      .sort((a, b) => values[b]! - values[a]! || a - b)
      .map((node) => ({
        node,
        key: JSON.stringify([id, tree.names[node]]),
        label: tree.names[node]!,
      }));
  }

  legend(id: string | number, color: (key: string) => string): LegendEntry[] {
    return this.branches(id).map(({ key, label }) => ({ key, label, color: color(key) }));
  }

  /** Each node's total, with the branches hidden through the legend counting as nothing. */
  shown(branches: readonly Branch[], hidden: ReadonlySet<string>): Float64Array {
    const { tree, values, branch } = this.built;
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
   * An item's key: the mark's id and the node's path, or with node and
   * parent fields its name, which is unique, so moving a node keeps its key.
   */
  keyOf(id: string | number, node: number): string {
    const { tree } = this.built;
    return JSON.stringify(
      "path" in this.encoding ? [id, ...pathOf(tree, node)] : [id, tree.names[node]],
    );
  }

  /** The node an item key of the mark `id` names; -1 when none does. */
  nodeOf(id: string | number, key: string): number {
    const { tree } = this.built;
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
   * Keyboard reading of the drawn nodes: depth first, each node's children
   * largest first. The order is worked out when first asked for, and items
   * only one at a time.
   */
  navigation(
    id: string | number,
    shown: Float64Array,
    drawn: (node: number) => boolean,
    itemOf: (node: number) => LayoutItem,
  ): Pick<LayoutResult, "count" | "item" | "indexOf"> {
    const { tree } = this.built;
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
        const node = this.nodeOf(id, key);
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

  /** Leaves with a value, for summaries. */
  leaves(shown: Float64Array): number {
    const { tree } = this.built;
    let count = 0;
    for (let node = 1; node < tree.size; node++) {
      if (shown[node]! > 0 && tree.childStart[node] === tree.childStart[node + 1]) count++;
    }
    return count;
  }
}

/** "1 group", "2 groups". */
export function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
