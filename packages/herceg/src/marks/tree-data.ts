// What treemaps and sunbursts share: the tree a table describes, each node's
// total, the top-level branch it belongs to, and the legend of branches;
// the part of it under a node the chart is drilled into, with the path to
// it; and the rows a node stands for, for row selection.

import {
  childrenByValue,
  type Hierarchy,
  type HierarchyEncoding,
  hierarchy,
  pathOf,
  pruneHierarchy,
  subtreeOf,
  subtreeValues,
  underNode,
} from "../data/hierarchy.ts";
import type { Table } from "../data/table.ts";
import { textDrawing } from "../draw/text.ts";
import { formatNumber } from "../format/format.ts";
import { fitText } from "../layout/text.ts";
import type { LegendEntry } from "../model/legend.ts";
import type { ChartConfig } from "../model/model.ts";
import type { Rect, TextGeometry } from "../scene/scene.ts";
import {
  heldText,
  type LayoutControls,
  type LayoutFrame,
  type LayoutItem,
  type LayoutResult,
  RowsCache,
  SelectionCache,
} from "./layout-mark.ts";
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
    return `${role}: a path, or node and parent fields, not both; drop one`;
  if (fields.path === undefined && (fields.node === undefined || fields.parent === undefined))
    return `${role}: needs a path of category fields, or node and parent fields`;
  return undefined;
}

/**
 * A tree as a panel draws it: a chart's one panel the table's whole tree, a
 * facet panel the part its rows give a value (see `TreeData.view`), and a
 * chart drilled into a node the subtree under it, of those rows in a facet
 * panel (see `TreeData.drilled`).
 */
export interface TreeView {
  tree: Hierarchy;
  /** Each node's total over the panel's rows. */
  values: Float64Array;
  /** Each node's top-level ancestor (below the view's root); -1 for the root. */
  branch: Int32Array;
  /**
   * The top-level nodes with a value, largest over the whole table first:
   * the legend's order. `legend` names the legend entry each is colored and
   * hidden by: its own, or in a drilled view the top-level node of the whole
   * tree it is under.
   */
  tops: readonly { node: number; label: string; legend: string }[];
  /** In a drilled view, the names of the path to its root, which its items' keys begin with. */
  prefix: readonly string[];
  /** Each node's node in the whole tree; undefined for the whole tree. */
  nodes?: Int32Array | undefined;
  /** The rows the view's values are of (a facet panel's), ascending; all of them when undefined. */
  rows?: Uint32Array | undefined;
}

/** A node on a drilled tree's path: its item key and its name. */
export interface DrillStep {
  key: string;
  label: string;
}

/**
 * The node a tree is drilled into: its item key, or null for the whole
 * tree, and the nodes from the top level down to it (none for the whole tree).
 */
export interface DrillRoot {
  readonly key: string | null;
  readonly path: readonly DrillStep[];
}

/**
 * What a tree drew of the node a chart is drilled into (see
 * `Chart.drillRoot`): the node, the path to it, and where breadcrumbs
 * name each step.
 */
export interface Drill extends DrillRoot {
  /** Where the breadcrumbs name the whole tree (key null) and each step, in pixels. */
  readonly crumbs: readonly (Rect & { key: string | null; label: string })[];
  /** The item key of a node named by its key or its names from the top level down; undefined for none. */
  find(node: string | readonly string[]): string | undefined;
  /** The path to the node keyed `key`, from the top level down to it. */
  pathTo(key: string): DrillStep[];
  /** Whether the node keyed `key` has nodes under it with a value, to drill into. */
  opens(key: string): boolean;
}

/** What a treemap or sunburst draws its path with: the strip above the tree and its crumbs. */
export interface Breadcrumbs {
  geometry: TextGeometry[];
  /** The height the strip takes from the top of the room. */
  height: number;
  crumbs: Drill["crumbs"];
}

/** Breadcrumbs name the whole tree so. */
const ALL = "All";
const SEPARATOR = " / ";
/** What steps folded away for want of room are drawn as. */
const FOLD = "…";

/** Clicks and Enter drill into a tree's nodes with `interaction.zoom`; Backspace goes up. */
const DRILL: LayoutControls = {
  kind: "drill",
  hint: "Enter opens the node read, Backspace goes up a level, and 0 shows the whole tree.",
};

/** A tree's controls: drilling, when `interaction.zoom` is on. */
export function drillControls(config: ChartConfig): LayoutControls | undefined {
  return config.interaction?.zoom ? DRILL : undefined;
}

/**
 * What a selection holds of each node of a tree view (its own rows and
 * those under it): how many rows, of how many, and their total.
 */
export interface Held {
  hits: Int32Array;
  rows: Int32Array;
  values: Float64Array;
}

export class TreeData {
  readonly table: Table;
  readonly encoding: HierarchyEncoding;
  readonly #value: string | undefined;
  /** What highlighted selections hold of each view's nodes, by membership and view. */
  readonly #held = new SelectionCache<Held>();
  /** The whole table's tree, and the table version it is for. */
  #whole: { version: number; view: TreeView } | undefined;
  /** The part of the tree each facet panel's rows give a value. */
  readonly #parts = new RowsCache<TreeView>();
  /** The subtree last drilled into, for the table version and node of the whole tree. */
  #drilled: { version: number; root: number; view: TreeView } | undefined;
  /** The subtree each facet panel's rows last drilled into, by the rows. */
  readonly #drilledParts = new WeakMap<
    Uint32Array,
    { version: number; root: number; view: TreeView }
  >();

  constructor(table: Table, fields: TreeFields, role: string) {
    const problem = treeFormError(fields, role);
    if (problem) throw new Error(problem);
    if (fields.path) {
      if (fields.path.length === 0) throw new Error(`${role} path: expected at least one field`);
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
        .map((node) => ({ node, label: tree.names[node]!, legend: tree.names[node]! }));
      this.#whole = {
        version: table.version,
        view: { tree, values, branch: branchOf(tree), tops, prefix: [] },
      };
    }
    const whole = this.#whole.view;
    if (!rows) return whole;
    return this.#parts.get(table, rows, () => {
      const totals = subtreeValues(whole.tree, this.#weights(), rows);
      const { tree, values, index, nodes } = pruneHierarchy(whole.tree, totals);
      const tops = whole.tops.flatMap((top) =>
        index[top.node]! > 0 ? [{ ...top, node: index[top.node]! }] : [],
      );
      return { tree, values, branch: branchOf(tree), tops, prefix: [], nodes, rows };
    });
  }

  /**
   * The subtree under `root` (a node of the whole tree), laid out as a tree
   * of its own: its nodes keep their keys and the color and legend entry of
   * the top-level node they are under. With `rows` (a facet panel's), the
   * part of it those rows give a value: only its root where they give none.
   */
  drilled(root: number, rows?: Uint32Array): TreeView {
    const whole = this.view();
    const version = this.table.version;
    const kept = rows ? this.#drilledParts.get(rows) : this.#drilled;
    if (kept?.version === version && kept.root === root) return kept.view;
    let { tree, values, nodes } = subtreeOf(
      whole.tree,
      rows ? subtreeValues(whole.tree, this.#weights(), rows) : whole.values,
      root,
    );
    if (rows) {
      const part = pruneHierarchy(tree, values);
      const under = nodes;
      ({ tree, values } = part);
      nodes = Int32Array.from(part.nodes, (node) => under[node]!);
    }
    const legend = whole.tree.names[whole.branch[root]!]!;
    // In the order of the whole tree's values, so every panel lists them alike.
    const tops = Array.from(tree.children.subarray(tree.childStart[0]!, tree.childStart[1]!))
      .filter((node) => values[node]! > 0)
      .sort((a, b) => whole.values[nodes[b]!]! - whole.values[nodes[a]!]! || a - b)
      .map((node) => ({ node, label: tree.names[node]!, legend }));
    const prefix = pathOf(whole.tree, root);
    const view = { tree, values, branch: branchOf(tree), tops, prefix, nodes, rows };
    if (rows) this.#drilledParts.set(rows, { version, root, view });
    else this.#drilled = { version, root, view };
    return view;
  }

  /** The top-level nodes of `view` (the whole tree's by default) with a value, keyed for the mark `id`. */
  branches(id: string | number, view = this.view()): Branch[] {
    return view.tops.map(({ node, label, legend }) => ({
      node,
      key: JSON.stringify([id, legend]),
      label,
    }));
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
   * An item's key: the mark's id and the node's path from the whole tree's
   * top level, or with node and parent fields its name, which is unique, so
   * moving a node keeps its key.
   */
  keyOf(id: string | number, view: TreeView, node: number): string {
    const { tree } = view;
    return JSON.stringify(
      "path" in this.encoding
        ? [id, ...view.prefix, ...pathOf(tree, node)]
        : [id, tree.names[node]],
    );
  }

  /** The node of `view` an item key of the mark `id` names; -1 when none does. */
  nodeOf(id: string | number, view: TreeView, key: string): number {
    const { tree, prefix } = view;
    let names: unknown;
    try {
      names = JSON.parse(key);
    } catch {
      return -1;
    }
    if (!Array.isArray(names) || names.length < 2 || names[0] !== id) return -1;
    if (!("path" in this.encoding)) {
      if (names.length !== 2) return -1;
      // A drilled view's root is a node too, with its name.
      return prefix.length > 0 && tree.names[0] === names[1] ? 0 : tree.names.indexOf(names[1], 1);
    }
    // A drilled view's keys go through its root.
    if (names.length <= prefix.length || prefix.some((name, i) => names[i + 1] !== name)) return -1;
    return childAlong(tree, names.slice(1 + prefix.length) as string[]);
  }

  /**
   * The node of the whole tree a drill root names: the first of `keys` (the
   * root's item key, then its ancestors' nearest first) the tree still has,
   * so a tree drilled into a node its data lost shows its nearest ancestor
   * that remains; 0 (the root) for none.
   */
  rootOf(id: string | number, keys: readonly string[]): number {
    const whole = this.view();
    for (const key of keys) {
      const node = this.nodeOf(id, whole, key);
      if (node > 0) return node;
    }
    return 0;
  }

  /**
   * What a tree drilled into `root` (0 for none) of the whole tree, drawn as
   * `view`, tells the chart: its key, its path, the breadcrumbs `crumbs`
   * drew, and which nodes open in the view.
   */
  drill(id: string | number, root: number, view: TreeView, crumbs: Breadcrumbs["crumbs"]): Drill {
    const whole = this.view();
    const pathTo = (node: number): DrillStep[] => {
      const steps: DrillStep[] = [];
      for (let at = node; at > 0; at = whole.tree.parent[at]!)
        steps.push({ key: this.keyOf(id, whole, at), label: whole.tree.names[at]! });
      return steps.reverse();
    };
    return {
      key: root > 0 ? this.keyOf(id, whole, root) : null,
      path: pathTo(root),
      crumbs,
      find: (node) => {
        const at =
          typeof node === "string" ? this.nodeOf(id, whole, node) : childAlong(whole.tree, node);
        return at > 0 ? this.keyOf(id, whole, at) : undefined;
      },
      pathTo: (key) => {
        const at = this.nodeOf(id, whole, key);
        return at > 0 ? pathTo(at) : [];
      },
      opens: (key) => {
        const at = this.nodeOf(id, view, key);
        const { childStart, children } = view.tree;
        if (at <= 0) return false;
        for (let c = childStart[at]!; c < childStart[at + 1]!; c++)
          if (view.values[children[c]!]! > 0) return true;
        return false;
      },
    };
  }

  /**
   * The strip above a tree naming the path to the node it is drilled into
   * (`view`'s root), "All" first: every step but the last a crumb to go
   * back to. A path wider than the room folds the steps between "All" and
   * the parent into one "…", from the top down, as far as it needs (in
   * rooms too narrow for that, every step but the last, or every step);
   * their crumbs lie over it (the nearest on top), so the keyboard and
   * screen readers still reach each. Steps then share the room, each cut to
   * its part where needed.
   */
  breadcrumbs(id: string | number, view: TreeView, frame: LayoutFrame): Breadcrumbs {
    const { bounds, theme, measure } = frame;
    const font = `${theme.fontSize}px ${theme.font}`;
    const lineHeight = Math.round(theme.fontSize * 1.25);
    const height = lineHeight + 6;
    const whole = this.view();
    // The whole tree, then the path from the top level down to the view's root.
    const path: number[] = [];
    if (view.nodes)
      for (let at = view.nodes[0]!; at > 0; at = whole.tree.parent[at]!) path.push(at);
    const nodes: (number | null)[] = [null, ...path.reverse()];
    const labelOf = (node: number | null) => (node === null ? ALL : whole.tree.names[node]!);
    const separator = measure(SEPARATOR, font);
    // What the strip shows: "All", the fold of steps 1 to `folded` (none
    // at 0), then the other steps; the parent and the node drilled into
    // are never folded.
    const entries = (folded: number) => [
      { steps: [null], text: ALL },
      ...(folded > 0 ? [{ steps: nodes.slice(1, folded + 1), text: FOLD }] : []),
      ...nodes.slice(folded + 1).map((node) => ({ steps: [node], text: labelOf(node) })),
    ];
    const wide = (shown: { text: string }[]) =>
      shown.reduce((width, { text }) => width + measure(text, font), 0) +
      separator * (shown.length - 1);
    let folded = 0;
    while (folded < nodes.length - 3 && wide(entries(folded)) > bounds.width) folded++;
    let shown = entries(folded);
    // Too narrow even with every step cut to "…": the fold stands for every
    // step before the node drilled into, or, with no room for that either,
    // for every step.
    const ellipsis = measure(FOLD, font);
    const least = (shown: { text: string }[]) =>
      shown.reduce((width, { text }) => width + Math.min(measure(text, font), ellipsis), 0) +
      separator * (shown.length - 1);
    if (nodes.length > 1 && least(shown) > bounds.width)
      shown = [
        { steps: nodes.slice(0, -1), text: FOLD },
        { steps: nodes.slice(-1), text: labelOf(nodes.at(-1)!) },
      ];
    if (least(shown) > bounds.width) shown = [{ steps: nodes, text: FOLD }];
    const rooms = shares(
      shown.map(({ text }) => measure(text, font)),
      bounds.width - separator * (shown.length - 1),
    );
    const y = bounds.y + height / 2;
    let x = bounds.x;
    const crumbs: (Rect & { key: string | null; label: string })[] = [];
    const parts = { past: [] as [number, string][], current: [] as [number, string][] };
    shown.forEach(({ steps, text: full }, k) => {
      const text = fitText(full, rooms[k]!, measure, font);
      const width = measure(text, font);
      const last = k === shown.length - 1;
      (last ? parts.current : parts.past).push([x, text]);
      // The fold's steps each have a crumb over it, the nearest on top.
      for (const node of steps)
        crumbs.push({
          key: node === null ? null : this.keyOf(id, whole, node),
          label: labelOf(node),
          x: x - 2,
          y: bounds.y,
          width: width + 4,
          height,
        });
      x += width;
      if (!last) {
        parts.past.push([x, SEPARATOR]);
        x += separator;
      }
    });
    const text = (key: string, fill: string, labels: [number, string][]): TextGeometry => ({
      kind: "text",
      draw: textDrawing,
      key,
      fill,
      anchor: "start",
      halo: false,
      coords: Float32Array.from(labels.flatMap(([at]) => [at, y])),
      labels: labels.map(([, label]) => label),
      count: labels.length,
    });
    return {
      geometry: [
        text(`${JSON.stringify(id)}-path`, theme.muted, parts.past),
        text(`${JSON.stringify(id)}-path-current`, theme.text, parts.current),
      ].filter((geometry) => geometry.count > 0),
      height,
      crumbs,
    };
  }

  /**
   * The rows of the node of `view` keyed `key` stands for: its own and every
   * node's under it, of the view's rows; undefined for a key of no node.
   */
  rowsOf(id: string | number, view: TreeView, key: string): number[] | undefined {
    const node = this.nodeOf(id, view, key);
    if (node < 0) return undefined;
    const whole = this.view();
    const under = underNode(whole.tree, view.nodes?.[node] ?? node);
    const { nodeOfRow } = whole.tree;
    const rows: number[] = [];
    eachRow(view, nodeOfRow.length, (row) => {
      if (nodeOfRow[row]! >= 0 && under[nodeOfRow[row]!]) rows.push(row);
    });
    return rows;
  }

  /**
   * For each node of `view`, how many of its rows (its own and under it)
   * `selected` holds, how many it has, and the selected rows' total, as
   * `values` totals the node's: a node is drawn with that share of it
   * selected, and dimmed when none of its rows is.
   */
  selectedOf(view: TreeView, selected: Uint8Array): Held {
    // Views are kept while what they are of is the same.
    return this.#held.get(selected, view, () => {
      const { tree } = this.view();
      const { nodeOfRow } = tree;
      const weights = this.#weights();
      const hits = new Int32Array(tree.size);
      const rows = new Int32Array(tree.size);
      const values = new Float64Array(tree.size);
      eachRow(view, nodeOfRow.length, (row) => {
        const node = nodeOfRow[row]!;
        if (node < 0) return;
        rows[node]!++;
        if (!selected[row]) return;
        hits[node]!++;
        // As totals weigh rows: one without a weight adds nothing.
        const weight = weights ? weights[row]! : 1;
        if (!Number.isNaN(weight)) values[node]! += weight;
      });
      for (let at = tree.size - 1; at > 0; at--) {
        const node = tree.order[at]!;
        const parent = tree.parent[node]!;
        hits[parent]! += hits[node]!;
        rows[parent]! += rows[node]!;
        values[parent]! += values[node]!;
      }
      if (!view.nodes) return { hits, rows, values };
      const nodes = view.nodes;
      return {
        hits: Int32Array.from(nodes, (node) => hits[node]!),
        rows: Int32Array.from(nodes, (node) => rows[node]!),
        values: Float64Array.from(nodes, (node) => values[node]!),
      };
    });
  }

  /** The share of a node of `view` that the selection `held` describes holds: of its total. */
  shareOf(view: TreeView, held: Held, node: number): number {
    const total = view.values[node]!;
    return total > 0 ? Math.min(1, held.values[node]! / total) : 0;
  }

  /** The text an item adds for what a highlighted selection holds of its node. */
  selectedText(
    view: TreeView,
    held: Held | undefined,
    node: number,
    locale: string | undefined,
  ): string {
    if (!held) return "";
    const value = this.#value;
    return heldText(
      held.hits[node]!,
      held.rows[node]!,
      value === undefined
        ? undefined
        : { field: value, held: held.values[node]!, of: view.values[node]! },
      (n) => formatNumber(n, locale),
    );
  }

  /**
   * Keyboard reading of the drawn nodes of `view`: depth first, each node's
   * children largest first. The order is worked out when first asked for,
   * and items only one at a time.
   */
  navigation(
    id: string | number,
    view: TreeView,
    shown: Float64Array,
    drawn: (node: number) => boolean,
    itemOf: (node: number) => LayoutItem,
  ): Pick<LayoutResult, "count" | "item" | "indexOf"> {
    const { tree } = view;
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
        const node = this.nodeOf(id, view, key);
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

/** Calls `each` with every row of the table `view` counts: its rows, or all `length` of them. */
function eachRow(view: TreeView, length: number, each: (row: number) => void): void {
  if (view.rows) for (const row of view.rows) each(row);
  else for (let row = 0; row < length; row++) each(row);
}

/** The node reached from the root down children named `names`, in order; -1 when one is missing. */
function childAlong(tree: Hierarchy, names: readonly string[]): number {
  let node = 0;
  for (const name of names) {
    let next = -1;
    for (let c = tree.childStart[node]!; c < tree.childStart[node + 1]!; c++) {
      if (tree.names[tree.children[c]!] === name) next = tree.children[c]!;
    }
    if (next < 0) return -1;
    node = next;
  }
  return node;
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

/** A sentence's part naming where a drilled tree is: " in Europe / France"; "" for the whole tree. */
export function where(view: TreeView): string {
  return view.prefix.length > 0 ? ` in ${view.prefix.join(" / ")}` : "";
}

/** "1 group", "2 groups". */
export function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Room for each of several widths within `room`: each its own width, or an
 * equal share of what the narrower ones leave.
 */
function shares(widths: readonly number[], room: number): number[] {
  const rooms = new Array<number>(widths.length);
  let left = Math.max(0, room);
  let count = widths.length;
  for (const i of [...widths.keys()].sort((a, b) => widths[a]! - widths[b]!)) {
    rooms[i] = Math.min(widths[i]!, left / count--);
    left -= rooms[i]!;
  }
  return rooms;
}
