import { pathOf } from "../data/hierarchy.ts";
import type { CategoryField, NumberField, Schema, Table } from "../data/table.ts";
import { ArcPath, arcDrawing, inSector, sectorPaints, traceSector } from "../draw/arc.ts";
import { textDrawing } from "../draw/text.ts";
import { formatNumber, numberFormatter } from "../format/format.ts";
import { layoutPartition } from "../layout/partition.ts";
import { labelFor } from "../layout/text.ts";
import type { LegendEntry } from "../model/legend.ts";
import { contrastingText } from "../scale/color.ts";
import type { ArcGeometry, Geometry, TextGeometry } from "../scene/scene.ts";
import type { Frozen, SunburstSpec } from "../spec/spec.ts";
import { surface } from "../theme.ts";
import type { LayoutFrame, LayoutItem, LayoutMark, LayoutResult } from "./layout-mark.ts";
import { definedFields } from "./line.ts";
import { frozen } from "./mark.ts";
import { type Branch, count, TreeData } from "./tree-data.ts";

export type SunburstOptions<S extends Schema> = (
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
  /** Names inside the sectors that have room for them; true by default. */
  labels?: boolean;
  id?: string;
};

/** Sectors start at the top and go clockwise. */
const START = -Math.PI / 2;
const TAU = 2 * Math.PI;
/** Space between neighboring sectors and rings, in pixels. */
const GAP = 2;
/** Where a label's box is checked: its corners and the middles of its edges. */
const BOX_POINTS = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
] as const;
/** The empty center, as a fraction of the radius. */
const HOLE = 0.18;

export class SunburstMark implements LayoutMark {
  readonly layout = true;
  readonly spec: Frozen<SunburstSpec>;
  readonly table: Table;
  readonly measure: string;
  readonly #data: TreeData;

  constructor(input: SunburstSpec, table: Table) {
    this.spec = frozen(input);
    // Read from the copy: the caller may change what it passed.
    const spec = this.spec;
    this.#data = new TreeData(table, spec, "sunburst");
    this.table = table;
    this.measure = spec.value ?? "Count";
  }

  legend(id: string | number, color: (key: string) => string): LegendEntry[] {
    return this.#data.legend(id, color);
  }

  draw(frame: LayoutFrame): LayoutResult {
    const { bounds, theme, measure, hidden, locale } = frame;
    const { tree, branch } = this.#data.built;
    const branches = this.#data.branches(frame.id);
    const shown = this.#data.shown(branches, hidden);
    const spans = new Float64Array(tree.size * 2);
    layoutPartition(tree, shown, true, spans);

    const r = Math.max(0, Math.min(bounds.width, bounds.height) / 2 - 2);
    const hole = r * HOLE;
    const ring = tree.height > 0 ? (r - hole) / tree.height : 0;
    const cx = bounds.x + bounds.width / 2;
    const cy = bounds.y + bounds.height / 2;
    const radii = (node: number) => {
      const r0 = hole + ring * (tree.depth[node]! - 1);
      // Rings are a gap apart too.
      return [r0 + GAP / 2, r0 + ring - GAP / 2] as const;
    };
    const angles = (node: number) =>
      [START + spans[node * 2]! * TAU, START + spans[node * 2 + 1]! * TAU] as const;

    // Sectors by depth, in their branch's color, lighter further out.
    const colors = branches.map(({ key }) => frame.color(key));
    const colorIndex = new Map(branches.map(({ node }, i) => [node, i]));
    // Each ring's sectors that show, in clockwise order.
    const paints = (node: number) => {
      const [r0, r1] = radii(node);
      const [a0, a1] = angles(node);
      return sectorPaints(r0, r1, a1 - a0, GAP);
    };
    const byDepth: number[][] = Array.from({ length: tree.height + 1 }, () => []);
    for (let at = 1; at < tree.size; at++) {
      const node = tree.order[at]!;
      if (shown[node]! > 0 && paints(node)) byDepth[tree.depth[node]!]!.push(node);
    }
    for (const nodes of byDepth) nodes.sort((a, b) => spans[a * 2]! - spans[b * 2]!);
    const geometry: Geometry[] = [];
    const opacityAt = (depth: number) => Math.max(0.45, 1 - 0.2 * (depth - 1));
    for (let depth = 1; depth <= tree.height; depth++) {
      const nodes = byDepth[depth]!;
      if (nodes.length === 0) continue;
      const arcs = new Float32Array(nodes.length * 6);
      const index = new Uint32Array(nodes.length);
      nodes.forEach((node, i) => {
        arcs.set([cx, cy, ...radii(node), ...angles(node)], i * 6);
        index[i] = colorIndex.get(branch[node]!) ?? 0;
      });
      geometry.push({
        kind: "arc",
        draw: arcDrawing,
        key: `sunburst-${depth}`,
        arcs,
        count: nodes.length,
        colors,
        colorIndex: index,
        fillOpacity: opacityAt(depth),
        gap: GAP,
      } as ArcGeometry);
    }

    if (this.spec.labels ?? true) {
      const font = `${theme.fontSize}px ${theme.font}`;
      const lineHeight = Math.round(theme.fontSize * 1.25);
      const backdrop = surface(theme);
      const byColor = new Map<string, { coords: number[]; labels: string[] }>();
      for (const nodes of byDepth) {
        for (const node of nodes) {
          const [r0, r1] = radii(node);
          const [a0, a1] = angles(node);
          const middle = (r0 + r1) / 2;
          const mid = (a0 + a1) / 2;
          const [x, y] = [cx + middle * Math.cos(mid), cy + middle * Math.sin(mid)];
          // Horizontal text centered in the sector: the longest that keeps
          // its box (corners and edge middles) inside it, as painted.
          const fits = (width: number) => {
            const [w, h] = [width / 2 + 2, lineHeight / 2];
            for (const [dx, dy] of BOX_POINTS) {
              if (!inSector(x + dx * w, y + dy * h, cx, cy, r0, r1, a0, a1, GAP)) return false;
            }
            return true;
          };
          // The whole name first, then shorter and shorter cuts of it.
          const name = tree.names[node]!;
          let text = fits(measure(name, font)) ? name : "";
          for (let room = measure(name, font) * 0.8; !text && room >= 12; room *= 0.8) {
            const candidate = labelFor(name, room, measure, font);
            if (!candidate) break;
            if (fits(measure(candidate, font))) text = candidate;
          }
          if (!text) continue;
          const fill = colors[colorIndex.get(branch[node]!) ?? 0]!;
          const ink = contrastingText(fill, opacityAt(tree.depth[node]!), backdrop) ?? theme.text;
          let group = byColor.get(ink);
          if (!group) {
            group = { coords: [], labels: [] };
            byColor.set(ink, group);
          }
          group.coords.push(x, y);
          group.labels.push(text);
        }
      }
      for (const [fill, { coords, labels }] of byColor) {
        geometry.push({
          kind: "text",
          draw: textDrawing,
          key: `sunburst-labels-${fill}`,
          fill,
          anchor: "middle",
          halo: false,
          coords: Float32Array.from(coords),
          labels,
          count: labels.length,
        } as TextGeometry);
      }
    }

    const percent = numberFormatter({ style: "percent", maximumFractionDigits: 1 }, locale);
    const total = shown[0]!;
    const itemOf = (node: number): LayoutItem => {
      const [r0, r1] = radii(node);
      const [a0, a1] = angles(node);
      const outline = new ArcPath();
      traceSector(outline, cx, cy, r0, r1, a0, a1, GAP);
      const mid = (a0 + a1) / 2;
      return {
        key: this.#data.keyOf(frame.id, node),
        label: pathOf(tree, node).join(" / "),
        color: colors[colorIndex.get(branch[node]!) ?? 0] ?? theme.muted,
        value: shown[node]!,
        text: `${formatNumber(shown[node]!, locale)} (${percent(shown[node]! / total)})`,
        px: cx + ((r0 + r1) / 2) * Math.cos(mid),
        py: cy + ((r0 + r1) / 2) * Math.sin(mid),
        outline: outline.d,
      };
    };
    const navigation = this.#data.navigation(frame.id, shown, paints, itemOf);
    return {
      geometry,
      itemAt(px, py) {
        const distance = Math.hypot(px - cx, py - cy);
        if (!(distance >= hole && distance <= r) || ring <= 0) return undefined;
        const depth = Math.min(tree.height, Math.floor((distance - hole) / ring) + 1);
        let fraction = (Math.atan2(py - cy, px - cx) - START) / TAU;
        fraction -= Math.floor(fraction);
        // The last sector of the ring starting at or before the angle.
        const nodes = byDepth[depth]!;
        let lo = 0;
        let hi = nodes.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (spans[nodes[mid]! * 2]! <= fraction) lo = mid + 1;
          else hi = mid;
        }
        const node = nodes[lo - 1];
        if (node === undefined) return undefined;
        const [r0, r1] = radii(node);
        const [a0, a1] = angles(node);
        return inSector(px, py, cx, cy, r0, r1, a0, a1, GAP) ? itemOf(node) : undefined;
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
    if (!(total > 0)) return `Sunburst of ${what}, with nothing to show.`;
    const visible = branches.filter(({ key }) => !hidden.has(key));
    const largest = visible
      .slice(0, 3)
      .map(({ node, label }) => `${label} ${percent(shown[node]! / total)}`);
    return `Sunburst of ${what}: ${count(this.#data.leaves(shown), "leaf", "leaves")} in ${count(visible.length, "group", "groups")} totaling ${formatNumber(total, locale)}. Largest: ${largest.join(", ")}.`;
  }
}

/**
 * A sunburst of a tree described by `path` (category fields, outermost
 * first) or by `node` and `parent` fields, each node's angle its share of
 * the sum of `value` (or of the rows) under its parent.
 *
 * ```ts
 * sunburst(sales, { path: ["region", "country"], value: "revenue" })
 * ```
 */
export function sunburst<S extends Schema>(
  table: Table<S>,
  options: SunburstOptions<S>,
): SunburstMark {
  const { path } = options;
  // Every option is kept, so the mark refuses a tree named both ways.
  const spec = {
    type: "sunburst",
    ...definedFields(options, ["node", "parent", "value", "labels", "id"]),
    ...(path !== undefined && { path: [...path] }),
  } as unknown as SunburstSpec;
  if (table.name !== undefined) spec.data = table.name;
  return new SunburstMark(spec, table as unknown as Table);
}
