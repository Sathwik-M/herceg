import type { CategoryField, NumberField, Schema, Table } from "../data/table.ts";
import { SvgPath } from "../draw/markup.ts";
import { rectDrawing } from "../draw/rect.ts";
import { shapesDrawing } from "../draw/shapes.ts";
import { labelHalo, textDrawing } from "../draw/text.ts";
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
import { ItemViews } from "../model/item-views.ts";
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
import type { Halo } from "../spec/style.ts";
import { surface } from "../theme.ts";
import {
  heldText,
  type LayoutFrame,
  type LayoutItem,
  type LayoutMark,
  type LayoutResult,
  RowsCache,
  SelectionCache,
} from "./layout-mark.ts";
import { CATEGORY, type ChartMark, DIM, frozen, type MARK, requireField } from "./mark.ts";

export interface SankeyOptions<S extends Schema> {
  /** The outline that keeps text readable: "auto" (the default), false for none, or a color of its own. */
  halo?: Halo;
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
  /** With the chart's `panels`, the id of the panel the Sankey diagram has to itself. */
  panel?: string;
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

/** What a selection holds of each link, by link: its rows' count and sum, and the link's rows. */
interface Held {
  rows: Float64Array;
  sums: Float64Array;
  of: Float64Array;
}

/**
 * What a selection holds of each node, by node, over the links drawn into
 * and out of it: their rows, how many of them it holds, and what those
 * bring in and take out.
 */
interface HeldNodes {
  rows: Float64Array;
  of: Float64Array;
  into: Float64Array;
  out: Float64Array;
}

/** The flows of a table's rows, rebuilt when it changes. */
interface Flows {
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
  readonly views = ItemViews;
  readonly spec: Frozen<SankeySpec>;
  readonly table: Table;
  readonly measure: string;
  /**
   * Clicks select a link's rows or a node's (its links'), and a selection
   * of them is drawn as a share of each link.
   */
  readonly selects = true;
  /** The flows of all rows and of each facet panel's. */
  readonly #flows = new RowsCache<Flows>();
  /** What highlighted selections hold of each flows' links and nodes. */
  readonly #held = new SelectionCache<Held>();
  /** Each flows' last layout, and the bounds it is for. */
  readonly #placed = new WeakMap<Flows, { key: string; layout: SankeyLayout }>();

  constructor(input: SankeySpec, table: Table) {
    this.spec = frozen(input);
    // Read from the copy: the caller may change what it passed.
    const spec = this.spec;
    requireField(table, spec.source, CATEGORY, "sankey source");
    requireField(table, spec.target, CATEGORY, "sankey target");
    if (spec.value !== undefined) requireField(table, spec.value, ["number"], "sankey value");
    const width = spec.nodeWidth ?? NODE_WIDTH;
    if (!(width > 0 && width < Number.POSITIVE_INFINITY)) {
      throw new RangeError(
        `sankey nodeWidth: expected a positive number of pixels; received ${width}`,
      );
    }
    this.table = table;
    this.measure = spec.value ?? "Count";
  }

  /**
   * One link per source and target that has rows (among `rows`, all rows by
   * default) with a positive, finite value, summing them (or counting
   * them); a total beyond the largest double is Infinity, which the layout
   * leaves out. Rows with a missing name or any other value are left out,
   * and so are names only they mention.
   */
  #graph(rows: Uint32Array | undefined): Flows {
    return this.#flows.get(this.table, rows, () => this.#gather(rows));
  }

  /** The flows of `rows` (all rows without them); see `#graph`. */
  #gather(rows: Uint32Array | undefined): Flows {
    const table = this.table;
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
    const count = rows ? rows.length : table.length;
    for (let k = 0; k < count; k++) {
      const row = rows ? rows[k]! : k;
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
    return {
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
  }

  /**
   * Calls `each` with every row among `rows` (all rows by default) that is
   * a flow of `flows`: its link, the link's source and target, and its value.
   */
  #eachFlow(
    flows: Flows,
    rows: Uint32Array | undefined,
    each: (row: number, link: number, value: number) => void,
  ): void {
    const table = this.table;
    const from = table.categories(this.spec.source);
    const to = table.categories(this.spec.target);
    const values = this.spec.value === undefined ? undefined : table.numbers(this.spec.value);
    // Each field's codes as nodes, -1 for names no flow has.
    const nodes = (field: { dictionary: readonly string[] }) =>
      Int32Array.from(field.dictionary, (name) => flows.nodeOf.get(name) ?? -1);
    const [sources, targets] = [nodes(from), nodes(to)];
    const count = rows ? rows.length : table.length;
    for (let k = 0; k < count; k++) {
      const row = rows ? rows[k]! : k;
      const [a, b] = [from.codes[row]!, to.codes[row]!];
      if (a < 0 || b < 0) continue;
      const value = values ? values[row]! : 1;
      if (!(value > 0 && value < Number.POSITIVE_INFINITY)) continue;
      const link = flows.linkOf.get(sources[a]! * flows.stride + targets[b]!);
      if (link !== undefined) each(row, link, value);
    }
  }

  /** What `selected` holds of the links of `flows`, made of `rows` (all rows by default). */
  #heldOf(selected: Uint8Array, rows: Uint32Array | undefined, flows: Flows): Held {
    return this.#held.get(selected, rows, () => {
      const links = flows.graph.value.length;
      const held: Held = {
        rows: new Float64Array(links),
        sums: new Float64Array(links),
        of: new Float64Array(links),
      };
      this.#eachFlow(flows, rows, (row, link, value) => {
        held.of[link]!++;
        if (selected[row] !== 1) return;
        held.rows[link]!++;
        held.sums[link]! += value;
      });
      return held;
    });
  }

  #layout(flows: Flows, bounds: Rect): SankeyLayout {
    const key = `${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`;
    const placed = this.#placed.get(flows);
    if (placed?.key === key) return placed.layout;
    const layout = layoutSankey(flows.graph, bounds, {
      nodeWidth: this.spec.nodeWidth ?? NODE_WIDTH,
      nodePadding: NODE_PADDING,
      order: this.spec.sort ?? "auto",
    });
    this.#placed.set(flows, { key, layout });
    return layout;
  }

  /** Nodes are labeled where they are drawn, so there is no legend. */
  legend(): LegendEntry[] {
    return [];
  }

  draw(frame: LayoutFrame): LayoutResult {
    const { bounds, theme, locale } = frame;
    const flows = this.#graph(frame.rows);
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
    const shape = (d: string, link: number, dim: boolean): PathShape => ({
      d,
      fill: colors[source[link]!]!,
      stroke: undefined,
      strokeWidth: 0,
      opacity: opacity * (dim ? DIM : 1),
      dash: undefined,
    });
    const shapes = (key: string, list: PathShape[]): ShapesGeometry => ({
      kind: "shapes",
      draw: shapesDrawing,
      key,
      shapes: list,
      font,
      fontSize: theme.fontSize,
    });
    // With a selection highlighted, each link's selected share is a band of
    // that thickness along its middle, the rest of it dimmed either side;
    // nodes none of whose links' rows it holds are dimmed.
    const selected = frame.selected?.(this.table);
    const held = selected && this.#heldOf(selected, frame.rows, flows);
    // Nodes count the rows of the links drawn: those closing cycles are left out.
    const nodes: HeldNodes | undefined = held && {
      rows: new Float64Array(graph.nodes),
      of: new Float64Array(graph.nodes),
      into: new Float64Array(graph.nodes),
      out: new Float64Array(graph.nodes),
    };
    if (held && nodes)
      for (const link of links)
        for (const node of [source[link]!, target[link]!]) {
          nodes.rows[node]! += held.rows[link]!;
          nodes.of[node]! += held.of[link]!;
          if (node === source[link]) nodes.out[node]! += held.sums[link]!;
          else nodes.into[node]! += held.sums[link]!;
        }
    const geometry: Geometry[] = [];
    if (held && nodes) {
      const [lit, dimmed]: [PathShape[], PathShape[]] = [[], []];
      for (const link of links) {
        const [x0, x1] = ends(link);
        const w = thickness[link]!;
        const part = w * Math.min(1, held.sums[link]! / graph.value[link]!);
        const side = (w - part) / 2;
        const [y0, y1] = [sourceY[link]!, targetY[link]!];
        if (part > 0) lit.push(shape(bandPath(x0, x1, y0 + side, y1 + side, part), link, false));
        if (side > 0)
          dimmed.push(
            shape(bandPath(x0, x1, y0, y1, side), link, true),
            shape(bandPath(x0, x1, y0 + side + part, y1 + side + part, side), link, true),
          );
      }
      geometry.push(shapes("sankey-links-dimmed", dimmed), shapes("sankey-links", lit));
      const shown = order.filter((node) => nodes.rows[node]! > 0);
      const faint = order.filter((node) => nodes.rows[node] === 0);
      geometry.push(
        ...nodeRects(faint, boxes, colors, "-dimmed"),
        ...nodeRects(shown, boxes, colors),
      );
    } else {
      geometry.push(
        shapes(
          "sankey-links",
          links.map((link, i) => shape(bands[i]!, link, false)),
        ),
        // Nodes over the ends of their links.
        ...nodeRects(order, boxes, colors),
      );
    }
    if (this.spec.labels ?? true)
      geometry.push(...sankeyLabels(layout, names, frame, this.spec.halo));

    const nodeItem = (node: number): LayoutItem => {
      const [x0, y0, x1, y1] = boxes.subarray(node * 4, node * 4 + 4) as unknown as number[];
      const into = layout.inflow[node]!;
      const out = layout.outflow[node]!;
      const format = (value: number) => formatNumber(value, locale);
      const outline = new SvgPath();
      outline.rect(x0!, y0!, x1! - x0!, y1! - y0!);
      const field = this.spec.value;
      // The selection's rows of the node's links, and what they bring in and take out.
      const selection = !nodes
        ? ""
        : heldText(nodes.rows[node]!, nodes.of[node]!, undefined, format) +
          (field === undefined
            ? ""
            : `, ${field} ${[
                into > 0 ? `${format(nodes.into[node]!)} of ${format(into)} in` : "",
                out > 0 ? `${format(nodes.out[node]!)} of ${format(out)} out` : "",
              ]
                .filter(Boolean)
                .join(", ")}`);
      return {
        key: nodeKey(node),
        label: names[node]!,
        color: colors[node]!,
        value: Math.max(into, out),
        text:
          (into > 0 && out > 0
            ? `${format(into)} in, ${format(out)} out`
            : into > 0
              ? `${format(into)} in`
              : `${format(out)} out`) + selection,
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
      const field = this.spec.value;
      const format = (value: number) => formatNumber(value, locale);
      const value = graph.value[link]!;
      return {
        key: JSON.stringify([frame.id, names[s], names[t]]),
        label: `${names[s]} → ${names[t]}`,
        color: colors[s]!,
        value,
        text:
          format(value) +
          (held
            ? heldText(
                held.rows[link]!,
                held.of[link]!,
                field === undefined ? undefined : { field, held: held.sums[link]!, of: value },
                format,
              )
            : ""),
        px: (x0 + x1) / 2,
        py: (sourceY[link]! + targetY[link]!) / 2 + thickness[link]! / 2,
        outline: bands[i]!,
      };
    };
    const nodeCount = order.length;
    // The node or link an item key names: the mark's id and a node's name, or a link's two names.
    const find = (key: string): { node: number; link?: number } | undefined => {
      let parts: unknown;
      try {
        parts = JSON.parse(key);
      } catch {
        return undefined;
      }
      if (!Array.isArray(parts) || parts[0] !== frame.id) return undefined;
      const [, a, b] = parts as [unknown, string, string | undefined];
      const s = flows.nodeOf.get(a) ?? -1;
      if (s < 0 || place[s]! < 0) return undefined;
      if (parts.length === 2) return { node: s };
      const t = parts.length === 3 ? (flows.nodeOf.get(b!) ?? -1) : -1;
      const link = t < 0 ? undefined : flows.linkOf.get(s * flows.stride + t);
      return link === undefined ? undefined : { node: s, link };
    };
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
        const found = find(key);
        if (!found) return -1;
        if (found.link === undefined) return place[found.node]!;
        const at = linkPlace.get(found.link);
        return at === undefined ? -1 : nodeCount + at;
      },
      // A link's rows, or a node's: those of the links into and out of it.
      rowsOf: (key, table) => {
        const found = table === this.table ? find(key) : undefined;
        if (!found) return undefined;
        const { node, link } = found;
        const rows: number[] = [];
        this.#eachFlow(flows, frame.rows, (row, at) => {
          // Of links drawn: those closing cycles are left out.
          if (status[at] !== DRAWN) return;
          if (link !== undefined ? at === link : source[at] === node || target[at] === node)
            rows.push(row);
        });
        return rows;
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

/** Node bars, one geometry per color, as palettes repeat colors; dimmed under keys ending in `dimmed`. */
function nodeRects(
  order: ArrayLike<number> & Iterable<number>,
  boxes: Float64Array,
  colors: readonly string[],
  dimmed = "",
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
      key: `sankey-nodes-${group}${dimmed}`,
      fill,
      fillOpacity: dimmed ? DIM : 1,
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
  halo: Halo | undefined,
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
          halo: labelHalo(halo, theme.text, frame),
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
  if (options.halo !== undefined) spec.halo = options.halo;
  if (options.id !== undefined) spec.id = options.id;
  if (options.panel !== undefined) spec.panel = options.panel;
  if (table.name !== undefined) spec.data = table.name;
  // Field names were checked against S above; marks work on the erased schema.
  return new SankeyMark(spec, table as unknown as Table);
}
