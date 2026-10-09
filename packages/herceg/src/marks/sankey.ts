import type { CategoryField, NumberField, Schema, Table } from "../data/table.ts";
import { SvgPath } from "../draw/markup.ts";
import { rectDrawing } from "../draw/rect.ts";
import { shapesDrawing } from "../draw/shapes.ts";
import { textDrawing } from "../draw/text.ts";
import { formatNumber } from "../format/format.ts";
import {
  CYCLE,
  DRAWN,
  EMPTY,
  layoutSankey,
  type SankeyGraph,
  type SankeyLayout,
} from "../layout/sankey.ts";
import { labelFor } from "../layout/text.ts";
import type { LegendEntry } from "../model/legend.ts";
import { isLightColor } from "../scale/color.ts";
import type {
  Geometry,
  PathShape,
  Rect,
  RectGeometry,
  ShapesGeometry,
  TextGeometry,
} from "../scene/scene.ts";
import type { Frozen, SankeySpec } from "../spec/spec.ts";
import { surface } from "../theme.ts";
import type { LayoutFrame, LayoutItem, LayoutMark, LayoutResult } from "./layout-mark.ts";
import { CATEGORY, type ChartMark, frozen, type MARK, requireField } from "./mark.ts";

export interface SankeyOptions<S extends Schema> {
  /** Category field naming where each row's flow comes from. */
  source: CategoryField<S>;
  /** Category field naming where it goes; a name in both fields is one node. */
  target: CategoryField<S>;
  /** Number field summed per source and target; without it, links count rows. */
  value?: NumberField<S>;
  /** Names and values beside the nodes that have room for them; true by default. */
  labels?: boolean;
  /** Width of the node bars in pixels; 12 by default. */
  nodeWidth?: number;
  /**
   * Order of the nodes in each column: by default, the order that keeps
   * links short and crossings few; "input" keeps the order in which nodes
   * first appear in the table, "value" puts the largest first.
   */
  sort?: "input" | "value";
  id?: string;
}

const NODE_WIDTH = 12;
/** Space between nodes in a column, in pixels, unless a column has too many nodes for it. */
const NODE_PADDING = 10;
/**
 * Links are translucent, in their source's color, so crossings show. Tints
 * over dark surfaces lose contrast, so links there are more opaque.
 */
const LINK_OPACITY = { light: 0.35, dark: 0.5 };
/** Space between a node and its label, in pixels. */
const LABEL_GAP = 6;
/** Links thinner than twice this are found this many pixels either side of their middle. */
const REACH = 2;

/** The table's flows, rebuilt when it changes. */
interface Flows {
  version: number;
  /** Node names, in the order they first appear. */
  names: string[];
  nodeOf: Map<string, number>;
  /** The link from one node to another: `linkOf.get(source * stride + target)`. */
  linkOf: Map<number, number>;
  stride: number;
  graph: SankeyGraph;
}

export class SankeyMark implements LayoutMark {
  declare readonly [MARK]: true;
  readonly layout = true;
  readonly spec: Frozen<SankeySpec>;
  readonly table: Table;
  readonly measure: string;
  #flows: Flows | undefined;
  /** The last layout, and the table version and bounds it is for. */
  #placed: { key: string; layout: SankeyLayout } | undefined;

  constructor(input: SankeySpec, table: Table) {
    this.spec = frozen(input);
    // Read from the copy: the caller may change what it passed.
    const spec = this.spec;
    requireField(table, spec.source, CATEGORY, "sankey source");
    requireField(table, spec.target, CATEGORY, "sankey target");
    if (spec.value !== undefined) requireField(table, spec.value, ["number"], "sankey value");
    const width = spec.nodeWidth ?? NODE_WIDTH;
    if (!(width > 0 && width < Number.POSITIVE_INFINITY)) {
      throw new RangeError(`sankey nodeWidth must be a positive number of pixels, not ${width}`);
    }
    this.table = table;
    this.measure = spec.value ?? "Count";
  }

  /**
   * One link per source and target that has rows with a positive, finite
   * value, summing them (or counting them); a total beyond the largest
   * double is Infinity, which the layout leaves out. Rows with a missing
   * name or any other value are left out, and so are names only they mention.
   */
  #graph(): Flows {
    const table = this.table;
    if (this.#flows?.version === table.version) return this.#flows;
    const from = table.categories(this.spec.source);
    const to = table.categories(this.spec.target);
    const values = this.spec.value === undefined ? undefined : table.numbers(this.spec.value);
    const names: string[] = [];
    const nodeOf = new Map<string, number>();
    // Each field's codes are looked up by name once, in `nodes`; a name in
    // both fields is one node.
    const nodeOfCode = (nodes: Int32Array, dictionary: readonly string[], code: number) => {
      let node = nodes[code]!;
      if (node < 0) {
        const name = dictionary[code]!;
        node = nodeOf.get(name) ?? names.length;
        if (node === names.length) {
          names.push(name);
          nodeOf.set(name, node);
        }
        nodes[code] = node;
      }
      return node;
    };
    const fromNodes = new Int32Array(from.dictionary.length).fill(-1);
    const toNodes = new Int32Array(to.dictionary.length).fill(-1);
    const stride = from.dictionary.length + to.dictionary.length;
    const linkOf = new Map<number, number>();
    const source: number[] = [];
    const target: number[] = [];
    const sums: number[] = [];
    for (let row = 0; row < table.length; row++) {
      const a = from.codes[row]!;
      const b = to.codes[row]!;
      if (a < 0 || b < 0) continue;
      const value = values ? values[row]! : 1;
      if (!(value > 0 && value < Number.POSITIVE_INFINITY)) continue;
      const s = nodeOfCode(fromNodes, from.dictionary, a);
      const t = nodeOfCode(toNodes, to.dictionary, b);
      let link = linkOf.get(s * stride + t);
      if (link === undefined) {
        link = sums.length;
        linkOf.set(s * stride + t, link);
        source.push(s);
        target.push(t);
        sums.push(0);
      }
      sums[link]! += value;
    }
    this.#flows = {
      version: table.version,
      names,
      nodeOf,
      linkOf,
      stride,
      graph: {
        nodes: names.length,
        source: Int32Array.from(source),
        target: Int32Array.from(target),
        value: Float64Array.from(sums),
      },
    };
    this.#placed = undefined;
    return this.#flows;
  }

  #layout(flows: Flows, bounds: Rect): SankeyLayout {
    const key = `${flows.version} ${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`;
    if (this.#placed?.key === key) return this.#placed.layout;
    const layout = layoutSankey(flows.graph, bounds, {
      nodeWidth: this.spec.nodeWidth ?? NODE_WIDTH,
      nodePadding: NODE_PADDING,
      order: this.spec.sort ?? "auto",
    });
    this.#placed = { key, layout };
    return layout;
  }

  /** Nodes are labeled where they are drawn, so there is no legend. */
  legend(): LegendEntry[] {
    return [];
  }

  draw(frame: LayoutFrame): LayoutResult {
    const { bounds, theme, locale } = frame;
    const flows = this.#graph();
    const { names, graph } = flows;
    const layout = this.#layout(flows, bounds);
    const { boxes, order, status, sourceY, targetY, thickness } = layout;
    const { source, target } = graph;

    const nodeKey = (node: number) => JSON.stringify([frame.id, names[node]]);
    // Colors are given in reading order, so the palette runs down the columns.
    const colors: string[] = [];
    for (const node of order) colors[node] = frame.color(nodeKey(node));
    const place = new Int32Array(graph.nodes).fill(-1);
    order.forEach((node, i) => {
      place[node] = i;
    });
    // Links in reading order: by source, then by target.
    const links: number[] = [];
    for (let link = 0; link < status.length; link++) if (status[link] === DRAWN) links.push(link);
    links.sort(
      (a, b) => place[source[a]!]! - place[source[b]!]! || place[target[a]!]! - place[target[b]!]!,
    );
    const linkPlace = new Map(links.map((link, i) => [link, i]));
    // Each band runs from its source's right edge to its target's left edge.
    const ends = (link: number) =>
      [boxes[source[link]! * 4 + 2]!, boxes[target[link]! * 4]!] as const;
    const bands = links.map((link) => {
      const [x0, x1] = ends(link);
      return bandPath(x0, x1, sourceY[link]!, targetY[link]!, thickness[link]!);
    });

    const font = `${theme.fontSize}px ${theme.font}`;
    const opacity = LINK_OPACITY[isLightColor(surface(theme)) === false ? "dark" : "light"];
    const geometry: Geometry[] = [
      {
        kind: "shapes",
        draw: shapesDrawing,
        key: "sankey-links",
        shapes: links.map(
          (link, i): PathShape => ({
            d: bands[i]!,
            fill: colors[source[link]!]!,
            stroke: undefined,
            strokeWidth: 0,
            opacity,
            dash: undefined,
          }),
        ),
        font,
        fontSize: theme.fontSize,
      } as ShapesGeometry,
    ];
    // Nodes over the ends of their links.
    geometry.push(...nodeRects(order, boxes, colors));
    if (this.spec.labels ?? true) geometry.push(...sankeyLabels(layout, names, frame));

    const nodeItem = (node: number): LayoutItem => {
      const [x0, y0, x1, y1] = boxes.subarray(node * 4, node * 4 + 4) as unknown as number[];
      const into = layout.inflow[node]!;
      const out = layout.outflow[node]!;
      const format = (value: number) => formatNumber(value, locale);
      const outline = new SvgPath();
      outline.rect(x0!, y0!, x1! - x0!, y1! - y0!);
      return {
        key: nodeKey(node),
        label: names[node]!,
        color: colors[node]!,
        value: Math.max(into, out),
        text:
          into > 0 && out > 0
            ? `${format(into)} in, ${format(out)} out`
            : into > 0
              ? `${format(into)} in`
              : `${format(out)} out`,
        px: (x0! + x1!) / 2,
        py: (y0! + y1!) / 2,
        outline: outline.d,
      };
    };
    const linkItem = (i: number): LayoutItem => {
      const link = links[i]!;
      const [x0, x1] = ends(link);
      const s = source[link]!;
      const t = target[link]!;
      return {
        key: JSON.stringify([frame.id, names[s], names[t]]),
        label: `${names[s]} → ${names[t]}`,
        color: colors[s]!,
        value: graph.value[link]!,
        text: formatNumber(graph.value[link]!, locale),
        px: (x0 + x1) / 2,
        py: (sourceY[link]! + targetY[link]!) / 2 + thickness[link]! / 2,
        outline: bands[i]!,
      };
    };
    const nodeCount = order.length;
    return {
      geometry,
      itemAt(px, py) {
        for (const node of order) {
          const at = node * 4;
          if (
            px >= boxes[at]! &&
            px <= boxes[at + 2]! &&
            py >= boxes[at + 1]! &&
            py <= boxes[at + 3]!
          )
            return nodeItem(node);
        }
        // Links drawn later are on top.
        for (let i = links.length - 1; i >= 0; i--) {
          const link = links[i]!;
          const [x0, x1] = ends(link);
          if (!(px >= x0 && px <= x1)) continue;
          const y = bandTop(x0, x1, sourceY[link]!, targetY[link]!, px);
          const w = thickness[link]!;
          const reach = Math.max(0, REACH - w / 2);
          if (py >= y - reach && py <= y + w + reach) return linkItem(i);
        }
        return undefined;
      },
      count: nodeCount + links.length,
      item: (index) => (index < nodeCount ? nodeItem(order[index]!) : linkItem(index - nodeCount)),
      indexOf: (key) => {
        // Keys are the mark's id and a node's name, or a link's two names.
        let parts: unknown;
        try {
          parts = JSON.parse(key);
        } catch {
          return -1;
        }
        if (!Array.isArray(parts) || parts[0] !== frame.id) return -1;
        const [, a, b] = parts as [unknown, string, string | undefined];
        const s = flows.nodeOf.get(a) ?? -1;
        if (s < 0) return -1;
        if (parts.length === 2) return place[s]!;
        const t = parts.length === 3 ? (flows.nodeOf.get(b!) ?? -1) : -1;
        const link = t < 0 ? undefined : flows.linkOf.get(s * flows.stride + t);
        const at = link === undefined ? undefined : linkPlace.get(link);
        return at === undefined ? -1 : nodeCount + at;
      },
      summary: () => this.#summary(layout, names, graph, links, locale),
    };
  }

  #summary(
    layout: SankeyLayout,
    names: readonly string[],
    graph: SankeyGraph,
    links: readonly number[],
    locale: string | undefined,
  ): string {
    const what = this.spec.value === undefined ? "row counts" : this.spec.value;
    // Links come from rows with positive, finite values, so a link without a
    // finite value is one whose total overflowed.
    let cycles = 0;
    let overflowed = 0;
    for (const status of layout.status) {
      if (status === CYCLE) cycles++;
      else if (status === EMPTY) overflowed++;
    }
    let left = "";
    if (cycles > 0)
      left += ` ${count(cycles, "flow closing a cycle is", "flows closing cycles are")} not drawn.`;
    if (overflowed > 0)
      left += ` ${count(overflowed, "flow whose total is too large to represent is", "flows whose totals are too large to represent are")} not drawn.`;
    if (links.length === 0) return `Sankey of ${what}, with nothing to show.${left}`;
    let largest = links[0]!;
    for (const link of links) if (graph.value[link]! > graph.value[largest]!) largest = link;
    const flow = `${names[graph.source[largest]!]} → ${names[graph.target[largest]!]}`;
    return `Sankey of ${what}: ${count(layout.order.length, "node", "nodes")} in ${count(layout.columns, "column", "columns")} and ${count(links.length, "flow", "flows")}; the largest flow is ${flow}, ${formatNumber(graph.value[largest]!, locale)}.${left}`;
  }
}

/** Node bars, one geometry per color, as palettes repeat colors. */
function nodeRects(
  order: Int32Array,
  boxes: Float64Array,
  colors: readonly string[],
): RectGeometry[] {
  const byColor = new Map<string, number[]>();
  for (const node of order) {
    const nodes = byColor.get(colors[node]!) ?? [];
    nodes.push(node);
    byColor.set(colors[node]!, nodes);
  }
  return [...byColor].map(([fill, nodes], group) => {
    const rects = new Float32Array(nodes.length * 4);
    nodes.forEach((node, i) => {
      const [x0, y0, x1, y1] = boxes.subarray(node * 4, node * 4 + 4) as unknown as number[];
      rects.set([x0!, y0!, x1! - x0!, y1! - y0!], i * 4);
    });
    return {
      kind: "rect",
      draw: rectDrawing,
      key: `sankey-nodes-${group}`,
      fill,
      fillOpacity: 1,
      rects,
      count: nodes.length,
    } as RectGeometry;
  });
}

/**
 * A link's band: its top edge a cubic curve from (x0, y0) to (x1, y1),
 * level at both ends, and its bottom edge the same curve `width` lower.
 */
function bandPath(x0: number, x1: number, y0: number, y1: number, width: number): string {
  const xm = (x0 + x1) / 2;
  const path = new SvgPath();
  path.moveTo(x0, y0);
  path.bezierCurveTo(xm, y0, xm, y1, x1, y1);
  path.lineTo(x1, y1 + width);
  path.bezierCurveTo(xm, y1 + width, xm, y0 + width, x0, y0 + width);
  path.closePath();
  return path.d;
}

/**
 * The y of a band's top edge (see `bandPath`) at `x`. Along the curve,
 * x - x0 = (x1 - x0)(1.5t - 1.5t² + t³), which rises steadily with t, so a
 * few Newton steps from t = (x - x0) / (x1 - x0) find t; then
 * y - y0 = (y1 - y0)(3t² - 2t³).
 */
export function bandTop(x0: number, x1: number, y0: number, y1: number, x: number): number {
  const u = x1 > x0 ? Math.min(1, Math.max(0, (x - x0) / (x1 - x0))) : 0.5;
  let t = u;
  for (let step = 0; step < 4; step++) {
    t -= (t * (1.5 - t * (1.5 - t)) - u) / (1.5 - t * (3 - 3 * t));
  }
  t = Math.min(1, Math.max(0, t));
  return y0 + (y1 - y0) * t * t * (3 - 2 * t);
}

/**
 * Names and values beside the nodes: right of the nodes in the left half
 * of the columns (and the middle one), left of the rest, so labels at the
 * edges stay inside. Where two columns' labels face each other across a
 * gap, a label at the height of one from the other side gets half the gap.
 * A label shows "name value" where that fits, else the name, shortened if
 * need be; in each column the largest nodes are labeled first, and labels
 * that would overlap one already placed are left out.
 */
function sankeyLabels(
  layout: SankeyLayout,
  names: readonly string[],
  frame: LayoutFrame,
): Geometry[] {
  const { bounds, theme, measure, locale } = frame;
  const { columns, columnX, nodeWidth, column, boxes, order } = layout;
  const font = `${theme.fontSize}px ${theme.font}`;
  const lineHeight = Math.round(theme.fontSize * 1.25);
  const gap = columns > 1 ? columnX[1]! - columnX[0]! - nodeWidth : 0;
  const rightward = (c: number) => c < columns / 2;
  // The column whose labels face column c's across their gap, or -1.
  const facing = (c: number) => {
    if (rightward(c)) return c + 1 < columns && !rightward(c + 1) ? c + 1 : -1;
    return c > 0 && rightward(c - 1) ? c - 1 : -1;
  };
  // Labels sit at their node's middle, kept inside the room, which needs
  // to be a line tall: labels are not clipped.
  if (bounds.height < lineHeight) return [];
  const low = bounds.y + lineHeight / 2;
  const high = bounds.y + bounds.height - lineHeight / 2;
  const heights: number[][] = Array.from({ length: columns }, () => []);
  const byColumn: number[][] = Array.from({ length: columns }, () => []);
  const yOf = new Float64Array(column.length);
  for (const node of order) {
    yOf[node] = Math.min(high, Math.max(low, (boxes[node * 4 + 1]! + boxes[node * 4 + 3]!) / 2));
    byColumn[column[node]!]!.push(node);
    heights[column[node]!]!.push(yOf[node]!);
  }

  const sides = {
    start: { coords: [] as number[], labels: [] as string[] },
    end: { coords: [] as number[], labels: [] as string[] },
  };
  const value = (node: number) => Math.max(layout.inflow[node]!, layout.outflow[node]!);
  byColumn.forEach((nodes, c) => {
    const across = facing(c);
    const side = rightward(c) ? sides.start : sides.end;
    const placed: number[] = [];
    for (const node of [...nodes].sort((a, b) => value(b) - value(a))) {
      const y = yOf[node]!;
      const near = (other: number) => Math.abs(other - y) < lineHeight;
      if (placed.some(near)) continue;
      const shared = across >= 0 && heights[across]!.some(near);
      const width = shared ? gap / 2 - LABEL_GAP - 2 : gap - 2 * LABEL_GAP;
      if (width <= 0) continue;
      const name = names[node]!;
      const full = `${name} ${formatNumber(value(node), locale)}`;
      const text = measure(full, font) <= width ? full : labelFor(name, width, measure, font);
      if (!text) continue;
      placed.push(y);
      side.coords.push(
        rightward(c) ? boxes[node * 4 + 2]! + LABEL_GAP : boxes[node * 4]! - LABEL_GAP,
        y,
      );
      side.labels.push(text);
    }
  });
  return (["start", "end"] as const)
    .filter((anchor) => sides[anchor].labels.length > 0)
    .map(
      (anchor) =>
        ({
          kind: "text",
          draw: textDrawing,
          key: `sankey-labels-${anchor}`,
          fill: theme.text,
          anchor,
          // Labels lie over links; the halo keeps them readable.
          halo: true,
          coords: Float32Array.from(sides[anchor].coords),
          labels: sides[anchor].labels,
          count: sides[anchor].labels.length,
        }) as TextGeometry,
    );
}

/** "1 node", "2 nodes". */
function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * A Sankey diagram of flows between nodes: a row per flow, from the node
 * named in `source` to the one named in `target`, each link as thick as the
 * sum of `value` over its rows, or their count.
 *
 * ```ts
 * sankey(energy, { source: "from", target: "to", value: "twh" })
 * ```
 */
export function sankey<S extends Schema>(
  table: Table<S>,
  options: SankeyOptions<S>,
): ChartMark<Frozen<SankeySpec>> {
  const spec: SankeySpec = { type: "sankey", source: options.source, target: options.target };
  if (options.value !== undefined) spec.value = options.value;
  if (options.labels !== undefined) spec.labels = options.labels;
  if (options.nodeWidth !== undefined) spec.nodeWidth = options.nodeWidth;
  if (options.sort !== undefined) spec.sort = options.sort;
  if (options.id !== undefined) spec.id = options.id;
  if (table.name !== undefined) spec.data = table.name;
  // Field names were checked against S above; marks work on the erased schema.
  return new SankeyMark(spec, table as unknown as Table);
}
