import { type Hierarchy, pathOf } from "../data/hierarchy.ts";
import type { CategoryField, NumberField, Schema, Table } from "../data/table.ts";
import { n } from "../draw/markup.ts";
import { rectDrawing } from "../draw/rect.ts";
import { textDrawing } from "../draw/text.ts";
import { formatNumber, numberFormatter } from "../format/format.ts";
import { labelFor } from "../layout/text.ts";
import { layoutTreemap } from "../layout/treemap.ts";
import type { LegendEntry } from "../model/legend.ts";
import { contrastingText } from "../scale/color.ts";
import type { Geometry, RectGeometry, TextGeometry } from "../scene/scene.ts";
import type { TreemapSpec } from "../spec/spec.ts";
import { surface } from "../theme.ts";
import type { LayoutFrame, LayoutItem, LayoutMark, LayoutResult } from "./layout-mark.ts";
import { definedFields } from "./line.ts";
import { type Branch, count, TreeData } from "./tree-data.ts";

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
};

/** Space between neighboring rectangles, in pixels. */
const GAP = 2;
/** Inset of labels from their rectangle's corner. */
const INSET = 4;

export class TreemapMark implements LayoutMark {
  readonly layout = true;
  readonly spec: TreemapSpec;
  readonly table: Table;
  readonly measure: string;
  readonly #data: TreeData;

  constructor(spec: TreemapSpec, table: Table) {
    this.#data = new TreeData(table, spec, "treemap");
    this.spec = spec;
    this.table = table;
    this.measure = spec.value ?? "Count";
  }

  legend(id: string | number, color: (key: string) => string): LegendEntry[] {
    return this.#data.legend(id, color);
  }

  draw(frame: LayoutFrame): LayoutResult {
    const { bounds, theme, hidden, locale } = frame;
    const { tree, branch } = this.#data.built;
    const branches = this.#data.branches(frame.id);
    const colorOf = new Map(branches.map(({ node, key }) => [node, frame.color(key)]));
    // Hidden branches take no room.
    const shown = this.#data.shown(branches, hidden);

    const font = `${theme.fontSize}px ${theme.font}`;
    const lineHeight = Math.round(theme.fontSize * 1.25);
    const labeled = this.spec.labels ?? true;
    const header = labeled && tree.height > 1 ? lineHeight + 2 : 0;
    const boxes = new Float64Array(tree.size * 4);
    layoutTreemap(tree, shown, bounds, { inner: GAP, outer: 0, top: header }, boxes);

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
    const geometry: Geometry[] = [];
    for (const { node: top, key } of branches) {
      if (hidden.has(key)) continue;
      const fill = colorOf.get(top)!;
      for (const leaves of [false, true]) {
        const nodes = parts.get(top)?.[leaves ? 1 : 0] ?? [];
        if (nodes.length === 0) continue;
        const rects = new Float32Array(nodes.length * 4);
        nodes.forEach((node, i) => {
          rects.set(boxes.subarray(node * 4, node * 4 + 4), i * 4);
        });
        geometry.push({
          kind: "rect",
          draw: rectDrawing,
          key: `treemap-${leaves ? "leaves" : "groups"}-${key}`,
          fill,
          fillOpacity: leaves ? 1 : 0.22,
          rects,
          count: nodes.length,
        } as RectGeometry);
      }
    }
    if (labeled)
      geometry.push(...this.#labels(drawn, boxes, tree, colorOf, branch, frame, font, lineHeight));

    const percent = numberFormatter({ style: "percent", maximumFractionDigits: 1 }, locale);
    const total = shown[0]!;
    const itemOf = (node: number): LayoutItem => {
      const [x, y, w, h] = boxes.subarray(node * 4, node * 4 + 4) as unknown as number[];
      return {
        key: this.#data.keyOf(frame.id, node),
        label: pathOf(tree, node).join(" / "),
        color: colorOf.get(branch[node]!) ?? theme.muted,
        value: shown[node]!,
        text: `${formatNumber(shown[node]!, locale)} (${percent(shown[node]! / total)})`,
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
      summary: () => this.#summary(shown, branches, hidden, locale, percent),
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
          halo: false,
          coords: Float32Array.from(coords),
          labels,
          count: labels.length,
        }) as TextGeometry,
    );
  }

  #summary(
    shown: Float64Array,
    branches: readonly Branch[],
    hidden: ReadonlySet<string>,
    locale: string | undefined,
    percent: (value: number) => string,
  ): string {
    const fields = this.spec.path?.join(" / ") ?? this.spec.node!;
    const what = this.spec.value ? `${this.spec.value} by ${fields}` : fields;
    const total = shown[0]!;
    if (!(total > 0)) return `Treemap of ${what}, with nothing to show.`;
    const leaves = this.#data.leaves(shown);
    const visible = branches.filter(({ key }) => !hidden.has(key));
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
): TreemapMark {
  const { path } = options;
  // Every option is kept, so the mark refuses a tree named both ways.
  const spec = {
    type: "treemap",
    ...definedFields(options, ["node", "parent", "value", "labels", "id"]),
    ...(path !== undefined && { path: [...path] }),
  } as unknown as TreemapSpec;
  if (table.name !== undefined) spec.data = table.name;
  return new TreemapMark(spec, table as unknown as Table);
}
