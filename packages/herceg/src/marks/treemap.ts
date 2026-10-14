import { type Hierarchy, pathOf } from "../data/hierarchy.ts";
import type { CategoryField, NumberField, Schema, Table } from "../data/table.ts";
import { n } from "../draw/markup.ts";
import { rectDrawing } from "../draw/rect.ts";
import { textDrawing } from "../draw/text.ts";
import { formatNumber, numberFormatter } from "../format/format.ts";
import { labelFor } from "../layout/text.ts";
import { layoutTreemap } from "../layout/treemap.ts";
import { ItemViews } from "../model/item-views.ts";
import type { LegendEntry } from "../model/legend.ts";
import type { ChartConfig } from "../model/model.ts";
import { contrastingText } from "../scale/color.ts";
import type { Geometry, RectGeometry, TextGeometry } from "../scene/scene.ts";
import type { Frozen, TreemapSpec } from "../spec/spec.ts";
import { surface } from "../theme.ts";
import type {
  LayoutControls,
  LayoutFrame,
  LayoutItem,
  LayoutMark,
  LayoutResult,
} from "./layout-mark.ts";
import { definedFields } from "./line.ts";
import { type ChartMark, DIM, frozen, type MARK } from "./mark.ts";
import { type Branch, count, drillControls, TreeData, type TreeView, where } from "./tree-data.ts";

export type TreemapOptions<S extends Schema> = (
  | {
      /** Category fields from the outermost group in; a row ends at its first missing one. */
      path: readonly CategoryField<S>[];
      node?: never;
      parent?: never;
    }
  | {
      /** Category field naming each row's node; rows without a parent are top-level. */
      node: CategoryField<S>;
      parent: CategoryField<S>;
      path?: never;
    }
) & {
  /** Number field summed over each node's rows; without it, rows count. */
  value?: NumberField<S>;
  /** Names inside the rectangles that have room for them; true by default. */
  labels?: boolean;
  id?: string;
  /** With the chart's `panels`, the id of the panel the treemap has to itself. */
  panel?: string;
};

/** Space between neighboring rectangles, in pixels. */
const GAP = 2;
/** Inset of labels from their rectangle's corner. */
const INSET = 4;

export class TreemapMark implements LayoutMark {
  declare readonly [MARK]: true;
  readonly layout = true;
  readonly views = ItemViews;
  readonly spec: Frozen<TreemapSpec>;
  readonly table: Table;
  readonly measure: string;
  /** Clicks and Enter drill into nodes with `interaction.zoom`, and charts select their rows. */
  readonly interactions = ["zoom"] as const;
  readonly selects = true;
  readonly #data: TreeData;

  constructor(input: TreemapSpec, table: Table) {
    this.spec = frozen(input);
    // Read from the copy: the caller may change what it passed.
    const spec = this.spec;
    this.#data = new TreeData(table, spec, "treemap");
    this.table = table;
    this.measure = spec.value ?? "Count";
  }

  legend(id: string | number, color: (key: string) => string): LegendEntry[] {
    return this.#data.legend(id, color);
  }

  controls(config: ChartConfig): LayoutControls | undefined {
    return drillControls(config);
  }

  draw(frame: LayoutFrame): LayoutResult {
    const { theme, hidden, locale } = frame;
    // A facet panel draws the part of the tree its rows give a value; a
    // chart drilled into a node, the subtree under it.
    const root = frame.root?.length ? this.#data.rootOf(frame.id, frame.root) : 0;
    const view = root > 0 ? this.#data.drilled(root, frame.rows) : this.#data.view(frame.rows);
    const { tree, branch } = view;
    // Breadcrumbs take a strip above the tree in charts that drill.
    const path =
      frame.drillable || root > 0 ? this.#data.breadcrumbs(frame.id, view, frame) : undefined;
    const bounds = path
      ? {
          ...frame.bounds,
          y: frame.bounds.y + path.height,
          height: frame.bounds.height - path.height,
        }
      : frame.bounds;
    const branches = this.#data.branches(frame.id, view);
    const colorOf = new Map(branches.map(({ node, key }) => [node, frame.color(key)]));
    // Hidden branches take no room.
    const shown = this.#data.shown(view, branches, hidden);

    const font = `${theme.fontSize}px ${theme.font}`;
    const lineHeight = Math.round(theme.fontSize * 1.25);
    const labeled = this.spec.labels ?? true;
    const header = labeled && tree.height > 1 ? lineHeight + 2 : 0;
    const boxes = new Float64Array(tree.size * 4);
    layoutTreemap(tree, shown, bounds, { inner: GAP, outer: 0, top: header }, boxes);

    // With a selection highlighted, a leaf's selected share fills it from
    // its left edge, the rest of it dimmed; groups none of whose rows it
    // holds are dimmed.
    const selected = frame.selected?.(this.table);
    const counts = selected && this.#data.selectedOf(view, selected);
    // Leaves fill in their branch's color; groups show faintly behind them,
    // with their names in the strip along their top.
    const drawn: number[] = [];
    for (let at = 1; at < tree.size; at++) {
      const node = tree.order[at]!;
      if (boxes[node * 4 + 2]! > 0 && boxes[node * 4 + 3]! > 0) drawn.push(node);
    }
    const isLeaf = (node: number) => tree.childStart[node] === tree.childStart[node + 1];
    // Each branch's groups and leaves, in one pass.
    const parts = new Map<number, [number[], number[]]>();
    for (const node of drawn) {
      const top = branch[node]!;
      let lists = parts.get(top);
      if (!lists) {
        lists = [[], []];
        parts.set(top, lists);
      }
      lists[isLeaf(node) ? 1 : 0].push(node);
    }
    const geometry: Geometry[] = [...(path?.geometry ?? [])];
    for (const { node: top, key } of branches) {
      if (hidden.has(key)) continue;
      const fill = colorOf.get(top)!;
      for (const leaves of [false, true]) {
        const all = parts.get(top)?.[leaves ? 1 : 0] ?? [];
        const lit = counts ? all.filter((node) => counts.hits[node]! > 0) : all;
        // The part of a node's box drawn: a leaf's selected share from its
        // left edge, or the rest; anything else whole.
        const share = (node: number) =>
          counts && leaves ? this.#data.shareOf(view, counts, node) : 1;
        const dimmed = !counts
          ? []
          : all.filter((node) => (leaves ? share(node) < 1 : counts.hits[node] === 0));
        const boxOf = (node: number, dim: boolean): [number, number, number, number] => {
          const [x, y, w, h] = boxes.subarray(node * 4, node * 4 + 4) as unknown as number[];
          const part = w! * share(node);
          if (!counts || !leaves) return [x!, y!, w!, h!];
          return dim ? [x! + part, y!, w! - part, h!] : [x!, y!, part, h!];
        };
        for (const [nodes, dim] of [
          [dimmed, true],
          [lit, false],
        ] as const) {
          if (nodes.length === 0) continue;
          const rects = new Float32Array(nodes.length * 4);
          nodes.forEach((node, i) => {
            rects.set(boxOf(node, dim), i * 4);
          });
          geometry.push({
            kind: "rect",
            draw: rectDrawing,
            // A drilled tree's branches share their legend key: the node tells them apart.
            key: `treemap-${leaves ? "leaves" : "groups"}-${key}-${top}${dim ? "-dimmed" : ""}`,
            fill,
            fillOpacity: (leaves ? 1 : 0.22) * (dim ? DIM : 1),
            rects,
            count: nodes.length,
          } as RectGeometry);
        }
      }
    }
    if (labeled)
      geometry.push(...this.#labels(drawn, boxes, tree, colorOf, branch, frame, font, lineHeight));

    const percent = numberFormatter({ style: "percent", maximumFractionDigits: 1 }, locale);
    const total = shown[0]!;
    const itemOf = (node: number): LayoutItem => {
      const [x, y, w, h] = boxes.subarray(node * 4, node * 4 + 4) as unknown as number[];
      return {
        key: this.#data.keyOf(frame.id, view, node),
        label: [...view.prefix, ...pathOf(tree, node)].join(" / "),
        color: colorOf.get(branch[node]!) ?? theme.muted,
        value: shown[node]!,
        text: `${formatNumber(shown[node]!, locale)} (${percent(shown[node]! / total)}${where(view)})${this.#data.selectedText(view, counts, node, locale)}`,
        px: x! + w! / 2,
        py: y! + h! / 2,
        outline: `M${n(x!)} ${n(y!)}h${n(w!)}v${n(h!)}h${n(-w!)}Z`,
      };
    };
    const inside = (node: number, px: number, py: number) => {
      const i = node * 4;
      return (
        px >= boxes[i]! &&
        px < boxes[i]! + boxes[i + 2]! &&
        py >= boxes[i + 1]! &&
        py < boxes[i + 1]! + boxes[i + 3]!
      );
    };
    const navigation = this.#data.navigation(
      frame.id,
      view,
      shown,
      (node) => boxes[node * 4 + 2]! > 0 && boxes[node * 4 + 3]! > 0,
      itemOf,
    );
    return {
      geometry,
      itemAt(px, py) {
        // Down from the root to the deepest node under the point.
        let node = 0;
        for (;;) {
          let next = -1;
          for (let c = tree.childStart[node]!; c < tree.childStart[node + 1]!; c++) {
            const child = tree.children[c]!;
            if (shown[child]! > 0 && boxes[child * 4 + 2]! > 0 && inside(child, px, py))
              next = child;
          }
          if (next < 0) break;
          node = next;
        }
        return node === 0 ? undefined : itemOf(node);
      },
      // Not spread: that would read `count` and order every node now.
      get count() {
        return navigation.count;
      },
      item: navigation.item,
      indexOf: navigation.indexOf,
      summary: () => this.#summary(view, shown, branches, locale, percent),
      rowsOf: (key, of) => (of === this.table ? this.#data.rowsOf(frame.id, view, key) : undefined),
      drill: this.#data.drill(frame.id, root, view, path?.crumbs ?? []),
    };
  }

  /** Names inside rectangles with room: leaves at their corner, groups in their top strip. */
  #labels(
    drawn: readonly number[],
    boxes: Float64Array,
    tree: Hierarchy,
    colorOf: ReadonlyMap<number, string>,
    branch: Int32Array,
    frame: LayoutFrame,
    font: string,
    lineHeight: number,
  ): Geometry[] {
    const { theme, measure } = frame;
    const backdrop = surface(theme);
    const byFill = new Map<string, { coords: number[]; labels: string[] }>();
    for (const node of drawn) {
      const [x, y, w, h] = boxes.subarray(node * 4, node * 4 + 4) as unknown as number[];
      if (w! < 2 * INSET + 8 || h! < lineHeight + 2) continue;
      const text = labelFor(tree.names[node]!, w! - 2 * INSET, measure, font);
      if (!text) continue;
      const leaf = tree.childStart[node] === tree.childStart[node + 1];
      const fill = colorOf.get(branch[node]!) ?? theme.muted;
      const color = leaf ? (contrastingText(fill, 1, backdrop) ?? theme.text) : theme.text;
      let group = byFill.get(color);
      if (!group) {
        group = { coords: [], labels: [] };
        byFill.set(color, group);
      }
      group.coords.push(x! + INSET, y! + lineHeight / 2 + 2);
      group.labels.push(text);
    }
    return [...byFill].map(
      ([fill, { coords, labels }], i) =>
        ({
          kind: "text",
          draw: textDrawing,
          key: `treemap-labels-${i}`,
          fill,
          anchor: "start",
          halo: undefined,
          coords: Float32Array.from(coords),
          labels,
          count: labels.length,
        }) as TextGeometry,
    );
  }

  #summary(
    view: TreeView,
    shown: Float64Array,
    branches: readonly Branch[],
    locale: string | undefined,
    percent: (value: number) => string,
  ): string {
    const { tree } = view;
    const fields = this.spec.path?.join(" / ") ?? this.spec.node!;
    const what = `${this.spec.value ? `${this.spec.value} by ${fields}` : fields}${where(view)}`;
    const total = shown[0]!;
    if (!(total > 0)) return `Treemap of ${what}, with nothing to show.`;
    const leaves = this.#data.leaves(tree, shown);
    // The branches drawn: shown, and with rows (in a facet panel, its own).
    const visible = this.#data.largest(branches, shown);
    const largest = visible
      .slice(0, 3)
      .map(({ node, label }) => `${label} ${percent(shown[node]! / total)}`);
    return `Treemap of ${what}: ${count(leaves, "leaf", "leaves")} in ${count(visible.length, "group", "groups")} totaling ${formatNumber(total, locale)}. Largest: ${largest.join(", ")}.`;
  }
}

/**
 * A treemap of a tree described by `path` (category fields, outermost
 * first) or by `id` and `parent` fields, its leaves sized by the sum of
 * `value` over their rows, or their count.
 *
 * ```ts
 * treemap(sales, { path: ["region", "country"], value: "revenue" })
 * ```
 */
export function treemap<S extends Schema>(
  table: Table<S>,
  options: TreemapOptions<S>,
): ChartMark<Frozen<TreemapSpec>> {
  const { path } = options;
  // Every option is kept, so the mark refuses a tree named both ways.
  const spec = {
    type: "treemap",
    ...definedFields(options, ["node", "parent", "value", "labels", "id", "panel"]),
    ...(path !== undefined && { path: [...path] }),
  } as unknown as TreemapSpec;
  if (table.name !== undefined) spec.data = table.name;
  return new TreemapMark(spec, table as unknown as Table);
}
