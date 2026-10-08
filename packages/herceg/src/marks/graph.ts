import type { CategoryField, NumericField, Schema, Table } from "../data/table.ts";
import { n } from "../draw/markup.ts";
import { shapesDrawing } from "../draw/shapes.ts";
import { textDrawing } from "../draw/text.ts";
import { formatNumber } from "../format/format.ts";
import { fitLayout, layoutForce, separate } from "../layout/force.ts";
import { labelFor } from "../layout/text.ts";
import type { LegendEntry } from "../model/legend.ts";
import { isLightColor } from "../scale/color.ts";
import type { Geometry, PathShape, Rect, ShapesGeometry, TextGeometry } from "../scene/scene.ts";
import type { GraphSpec } from "../spec/spec.ts";
import { surface } from "../theme.ts";
import type { LayoutFrame, LayoutItem, LayoutMark, LayoutResult } from "./layout-mark.ts";
import { CATEGORY, requireField } from "./mark.ts";

export type GraphOptions<S extends Schema, N extends Schema = Schema> = {
  /** Category field naming one end of each row's link. */
  source: CategoryField<S>;
  /** Category field naming the other end; a name in both fields is one node. */
  target: CategoryField<S>;
  /** Number field summed per pair of nodes, setting links' widths; without it, links are alike. */
  value?: NumericField<S>;
  /** Names beside the most connected (or largest) nodes that have room; true by default. */
  labels?: boolean;
  id?: string;
} & (
  | { nodes?: undefined; node?: undefined; group?: undefined; size?: undefined }
  | {
      /** A table with a row per node, for nodes without links and for groups and sizes. */
      nodes: Table<N>;
      /** Category field of `nodes` naming each row's node, as `source` and `target` do. */
      node: CategoryField<N>;
      /** Category field of `nodes`: nodes are colored by it, with a legend. */
      group?: CategoryField<N>;
      /** Number field of `nodes` sizing nodes by area. */
      size?: NumericField<N>;
    }
);

/**
 * The force simulation costs about a second at this many nodes, and every
 * change to the tables runs it again; larger networks are refused.
 */
export const MAX_NODES = 5000;
/**
 * Springs cost little next to repulsion up to this many links (at most a
 * few tens of milliseconds), but a dense network's millions would take
 * seconds, so more are refused too.
 */
export const MAX_LINKS = 20_000;
/** Radius of nodes, in pixels, in a room with space for them. */
const RADIUS = 5;
/** Radii of the smallest and largest `size` values, in a room with space for them. */
const SIZE_RANGE = [3, 14] as const;
/** Width of links of the least and the largest `value`, in pixels. */
const WIDTH_RANGE = [1, 6] as const;
/**
 * Links are translucent so nodes stand out and crossings show; tints over
 * dark surfaces lose contrast, so links there are more opaque.
 */
const LINK_OPACITY = { light: 0.45, dark: 0.55 };
/**
 * Width of the ring in the surface color around each node, which sets
 * nodes apart from links and each other; narrower around small nodes.
 */
const RING = 1.5;
/**
 * How many of the most connected (or largest) nodes are labeled where they
 * have room, in networks of up to this many nodes; larger ones label fewer.
 */
const LABELED = 50;
/** Space between a node and its label, in pixels. */
const LABEL_GAP = 4;
/** Pointer reach beyond a node's edge or a link's, in pixels. */
const REACH = 4;
/** Layout units grow to at most this many pixels, so small networks do not sprawl. */
const MAX_SCALE = 2.5;
/** One axis may stretch this much more than the other to use a room of another shape. */
const MAX_STRETCH = 1.3;

/** The tables' nodes and links, rebuilt when either changes. */
interface Network {
  /** The table versions it was built from. */
  versions: string;
  /** Node names: the nodes table's in its order, then names only links use, as they appear. */
  names: string[];
  nodeOf: Map<string, number>;
  /** Per node: its group's index in `groups`, or -1 for none. */
  group: Int32Array;
  /** Group names, in the order of their first node. */
  groups: string[];
  /** Per node: its `size` value, NaN where missing or infinite; undefined without `size`. */
  size: Float64Array | undefined;
  /** Per link: its ends (in the order its first row named them) and its total. */
  source: Int32Array;
  target: Int32Array;
  value: Float64Array;
  /** The link between two nodes: `linkOf.get(min * stride + max)`. */
  linkOf: Map<number, number>;
  stride: number;
  /** Nodes with links to themselves, which are left out. */
  loops: number;
  /** Links whose total overflows a double, which are left out. */
  overflowed: number;
  /** Layout positions, in layout units, once computed. */
  positions: Float64Array | undefined;
}

/** Where nodes are drawn in one room. */
interface Placement {
  /** The table versions and room it is for. */
  key: string;
  /** x, y per node, in pixels. */
  at: Float64Array;
  radii: Float64Array;
  /** 1, or less in rooms crowded with nodes, where nodes and links draw smaller. */
  crowding: number;
}

export class GraphMark implements LayoutMark {
  readonly layout = true;
  readonly spec: GraphSpec;
  /** The table of links. */
  readonly table: Table;
  /** The table of nodes, when there is one. */
  readonly nodes: Table | undefined;
  readonly otherTables: readonly Table[];
  readonly measure: string;
  #network: Network | undefined;
  #placed: Placement | undefined;

  constructor(spec: GraphSpec, links: Table, nodes?: Table) {
    requireField(links, spec.source, CATEGORY, "graph source");
    requireField(links, spec.target, CATEGORY, "graph target");
    if (spec.value !== undefined) requireField(links, spec.value, ["number"], "graph value");
    if (nodes) {
      if (spec.node === undefined)
        throw new Error("graph nodes need `node`, the field naming each row's node");
      requireField(nodes, spec.node, CATEGORY, "graph node");
      if (spec.group !== undefined) requireField(nodes, spec.group, CATEGORY, "graph group");
      if (spec.size !== undefined) requireField(nodes, spec.size, ["number"], "graph size");
    } else if (spec.node !== undefined || spec.group !== undefined || spec.size !== undefined) {
      throw new Error("graph node, group, and size are fields of a nodes table, and there is none");
    }
    this.spec = spec;
    this.table = links;
    this.nodes = nodes;
    this.otherTables = nodes ? [nodes] : [];
    this.measure = spec.value ?? "Links";
  }

  /**
   * Nodes from the nodes table, a later row replacing an earlier one's
   * group and size, then names only links use. One link per pair of nodes,
   * either way round, summing the values (or counting the rows) that are
   * positive and finite; rows with a missing name or any other value are
   * left out, and so are names only they mention.
   */
  #build(): Network {
    const { spec, table: links, nodes } = this;
    const versions = `${links.version} ${nodes?.version ?? ""}`;
    if (this.#network?.versions === versions) return this.#network;
    const names: string[] = [];
    const nodeOf = new Map<string, number>();
    const add = (name: string) => {
      let node = nodeOf.get(name);
      if (node === undefined) {
        node = names.length;
        names.push(name);
        nodeOf.set(name, node);
      }
      return node;
    };
    const groupOf: number[] = [];
    const sizeOf: number[] = [];
    let groupNames: readonly string[] = [];
    if (nodes) {
      const ids = nodes.categories(spec.node!);
      const groups = spec.group === undefined ? undefined : nodes.categories(spec.group);
      const sizes = spec.size === undefined ? undefined : nodes.numbers(spec.size);
      groupNames = groups?.dictionary ?? [];
      for (let row = 0; row < nodes.length; row++) {
        const code = ids.codes[row]!;
        if (code < 0) continue;
        const node = add(ids.dictionary[code]!);
        groupOf[node] = groups ? groups.codes[row]! : -1;
        // Infinite sizes have no area to scale; they count as missing.
        const size = sizes ? sizes[row]! : Number.NaN;
        sizeOf[node] = Number.isFinite(size) ? size : Number.NaN;
      }
    }

    const from = links.categories(spec.source);
    const to = links.categories(spec.target);
    const values = spec.value === undefined ? undefined : links.numbers(spec.value);
    // Each field's codes are looked up by name once.
    const nodeOfCode = (cache: Int32Array, dictionary: readonly string[], code: number) => {
      if (cache[code]! < 0) cache[code] = add(dictionary[code]!);
      return cache[code]!;
    };
    const fromNodes = new Int32Array(from.dictionary.length).fill(-1);
    const toNodes = new Int32Array(to.dictionary.length).fill(-1);
    const stride = names.length + from.dictionary.length + to.dictionary.length;
    const linkOf = new Map<number, number>();
    const source: number[] = [];
    const target: number[] = [];
    const sums: number[] = [];
    const loops = new Set<number>();
    for (let row = 0; row < links.length; row++) {
      const a = from.codes[row]!;
      const b = to.codes[row]!;
      if (a < 0 || b < 0) continue;
      const value = values ? values[row]! : 1;
      if (!(value > 0 && value < Number.POSITIVE_INFINITY)) continue;
      const s = nodeOfCode(fromNodes, from.dictionary, a);
      const t = nodeOfCode(toNodes, to.dictionary, b);
      if (s === t) {
        loops.add(s);
        continue;
      }
      const key = Math.min(s, t) * stride + Math.max(s, t);
      let link = linkOf.get(key);
      if (link === undefined) {
        link = sums.length;
        linkOf.set(key, link);
        source.push(s);
        target.push(t);
        sums.push(0);
      }
      sums[link]! += value;
    }

    // Totals beyond the largest double are left out, keeping link numbers dense.
    const kept: number[] = [];
    for (let link = 0; link < sums.length; link++)
      if (sums[link]! < Number.POSITIVE_INFINITY) kept.push(link);
    if (kept.length < sums.length) {
      linkOf.clear();
      kept.forEach((link, i) => {
        const s = source[link]!;
        const t = target[link]!;
        linkOf.set(Math.min(s, t) * stride + Math.max(s, t), i);
      });
    }
    const count = names.length;
    const network: Network = {
      versions,
      names,
      nodeOf,
      group: new Int32Array(count).fill(-1),
      groups: [],
      size: spec.size === undefined ? undefined : new Float64Array(count).fill(Number.NaN),
      source: Int32Array.from(kept, (link) => source[link]!),
      target: Int32Array.from(kept, (link) => target[link]!),
      value: Float64Array.from(kept, (link) => sums[link]!),
      linkOf,
      stride,
      loops: loops.size,
      overflowed: sums.length - kept.length,
      positions: undefined,
    };
    // Groups in the order of their first node.
    const groupIndex = new Map<number, number>();
    groupOf.forEach((code, node) => {
      if (code === undefined || code < 0) return;
      let index = groupIndex.get(code);
      if (index === undefined) {
        index = network.groups.length;
        groupIndex.set(code, index);
        network.groups.push(groupNames[code]!);
      }
      network.group[node] = index;
    });
    sizeOf.forEach((size, node) => {
      if (network.size) network.size[node] = size;
    });
    this.#network = network;
    return network;
  }

  /** Layout positions, computed once per network. */
  #positions(network: Network): Float64Array {
    if (network.positions) return network.positions;
    // Heavier links pull somewhat harder, without making the simulation stiff.
    let largest = 0;
    for (const value of network.value) largest = Math.max(largest, value);
    const strength =
      this.spec.value === undefined
        ? undefined
        : Float64Array.from(network.value, (value) => 0.5 + 0.5 * Math.sqrt(value / largest));
    network.positions = layoutForce({
      nodes: network.names.length,
      source: network.source,
      target: network.target,
      strength,
    });
    return network.positions;
  }

  /**
   * Where nodes are drawn in a room, and how large: the layout scaled to
   * fit at least `margin` inside its edges, then overlapping nodes pushed
   * apart. Hidden groups keep their places, so showing them again moves
   * nothing.
   */
  #place(network: Network, bounds: Rect, margin: number): Placement {
    const key = `${network.versions} ${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height} ${margin}`;
    if (this.#placed?.key === key) return this.#placed;
    const count = network.names.length;
    // Nodes shrink in rooms crowded with them, so they stay apart.
    const room = Math.max(1, bounds.width * bounds.height);
    const crowding = Math.min(1, Math.max(0.45, Math.sqrt(room / Math.max(1, count)) / 60));
    const radii = this.#radii(network, crowding);
    let largest = 0;
    for (const r of radii) largest = Math.max(largest, r);
    const at = fitLayout(this.#positions(network), bounds, {
      inset: Math.max(largest + RING + 1, margin),
      maxScale: MAX_SCALE,
      maxStretch: MAX_STRETCH,
    });
    const inside = {
      x: bounds.x + RING,
      y: bounds.y + RING,
      width: Math.max(0, bounds.width - 2 * RING),
      height: Math.max(0, bounds.height - 2 * RING),
    };
    separate(at, radii, inside, RING + 1);
    this.#placed = { key, at, radii, crowding };
    return this.#placed;
  }

  /** Why the network is too large to lay out, or undefined when it is not. */
  overLimit(): string | undefined {
    return overLimit(this.#build());
  }

  legend(id: string | number, color: (key: string) => string): LegendEntry[] {
    const network = this.#build();
    if (overLimit(network)) return [];
    return network.groups.map((group) => {
      const key = groupKey(id, group);
      return { key, label: group, color: color(key) };
    });
  }

  draw(frame: LayoutFrame): LayoutResult {
    const network = this.#build();
    const refused = overLimit(network);
    if (refused) return nothing(refused);
    const { bounds, theme, hidden, locale } = frame;
    const { names, source, target, value, group, groups } = network;
    const count = names.length;

    // Group colors; nodes without a group are muted, unless no node has one.
    const groupColors = groups.map((name) => frame.color(groupKey(frame.id, name)));
    const plain = groups.length > 0 ? theme.muted : frame.color(groupKey(frame.id, undefined));
    const colorOf = (node: number) => (group[node]! >= 0 ? groupColors[group[node]!]! : plain);
    const shown = (node: number) =>
      group[node]! < 0 || !hidden.has(groupKey(frame.id, groups[group[node]!]!));
    const nodes: number[] = [];
    for (let node = 0; node < count; node++) if (shown(node)) nodes.push(node);
    const links: number[] = [];
    for (let link = 0; link < source.length; link++)
      if (shown(source[link]!) && shown(target[link]!)) links.push(link);
    // Each node's drawn links and the sum of their values: links into hidden groups do not count.
    const degree = new Int32Array(count);
    const weight = new Float64Array(count);
    for (const link of links) {
      degree[source[link]!]!++;
      degree[target[link]!]!++;
      weight[source[link]!]! += value[link]!;
      weight[target[link]!]! += value[link]!;
    }

    const labeled = this.spec.labels ?? true;
    // Room for half a line of text above and below, so labels at the edges fit.
    const margin = labeled ? Math.round(theme.fontSize * 1.25) / 2 : 0;
    const { at, radii, crowding } = this.#place(network, bounds, margin);
    const x = (node: number) => at[node * 2]!;
    const y = (node: number) => at[node * 2 + 1]!;

    let heaviest = 0;
    for (const v of value) heaviest = Math.max(heaviest, v);
    // Links thin out in crowded rooms, as nodes shrink.
    const thin = Math.max(0.6, crowding);
    const widthOf = (link: number) =>
      thin *
      (this.spec.value === undefined
        ? WIDTH_RANGE[0]
        : WIDTH_RANGE[0] + (WIDTH_RANGE[1] - WIDTH_RANGE[0]) * (value[link]! / heaviest));
    // Links within a group take its color; others are muted.
    const linkColor = (link: number) => {
      const g = group[source[link]!]!;
      return g >= 0 && g === group[target[link]!] ? groupColors[g]! : theme.muted;
    };
    // Links of about the same width and color share a path.
    const paths = new Map<string, { width: number; color: string; d: string }>();
    for (const link of links) {
      const width = Math.round(widthOf(link) * 4) / 4;
      const color = linkColor(link);
      const key = `${width} ${color}`;
      const path = paths.get(key) ?? { width, color, d: "" };
      const s = source[link]!;
      const t = target[link]!;
      path.d += `M${n(x(s))} ${n(y(s))}L${n(x(t))} ${n(y(t))}`;
      paths.set(key, path);
    }
    const ring = surface(theme);
    const opacity = LINK_OPACITY[isLightColor(ring) === false ? "dark" : "light"];
    const font = `${theme.fontSize}px ${theme.font}`;
    // Muted links below colored ones, thin below thick.
    const linkShapes: PathShape[] = [...paths.values()]
      .sort(
        (a, b) =>
          Number(b.color === theme.muted) - Number(a.color === theme.muted) || a.width - b.width,
      )
      .map(({ width, color, d }) => ({
        d,
        fill: "none",
        stroke: color,
        strokeWidth: width,
        opacity,
        dash: undefined,
      }));
    // Larger nodes first, so smaller ones on top of them stay visible.
    const stacked = [...nodes].sort((a, b) => radii[b]! - radii[a]! || a - b);
    const nodeShapes: PathShape[] = stacked.map((node) => ({
      d: circle(x(node), y(node), radii[node]!),
      fill: colorOf(node),
      stroke: ring,
      strokeWidth: ringWidth(radii[node]!),
      opacity: 1,
      dash: undefined,
    }));
    const geometry: Geometry[] = [
      {
        kind: "shapes",
        draw: shapesDrawing,
        key: "graph-links",
        shapes: linkShapes,
        font,
        fontSize: theme.fontSize,
      } as ShapesGeometry,
      {
        kind: "shapes",
        draw: shapesDrawing,
        key: "graph-nodes",
        shapes: nodeShapes,
        font,
        fontSize: theme.fontSize,
      } as ShapesGeometry,
    ];
    if (labeled) geometry.push(...this.#labels(network, nodes, degree, at, radii, frame));

    const format = (v: number) => formatNumber(v, locale);
    const nodeItem = (node: number): LayoutItem => {
      const details: string[] = [];
      if (group[node]! >= 0) details.push(`${this.spec.group} ${groups[group[node]!]}`);
      if (network.size && Number.isFinite(network.size[node]))
        details.push(`${this.spec.size} ${format(network.size[node]!)}`);
      let text = plural(degree[node]!, "link", "links");
      // Links' totals are finite, but a node's sum of them can overflow.
      const total = weight[node]! < Number.POSITIVE_INFINITY ? weight[node]! : Number.NaN;
      if (this.spec.value !== undefined)
        text += `, ${this.spec.value} ${Number.isNaN(total) ? "too large to total" : format(total)}`;
      if (details.length > 0) text += ` (${details.join(", ")})`;
      return {
        key: JSON.stringify([frame.id, names[node]]),
        label: names[node]!,
        color: colorOf(node),
        value: this.spec.value === undefined ? degree[node]! : total,
        text,
        px: x(node),
        py: y(node),
        outline: circle(x(node), y(node), radii[node]! + ringWidth(radii[node]!) + 1.5),
      };
    };
    const linkItem = (i: number): LayoutItem => {
      const link = links[i]!;
      const s = source[link]!;
      const t = target[link]!;
      return {
        key: JSON.stringify([frame.id, names[s], names[t]]),
        label: `${names[s]} — ${names[t]}`,
        color: linkColor(link),
        value: value[link]!,
        text: format(value[link]!),
        px: (x(s) + x(t)) / 2,
        py: (y(s) + y(t)) / 2,
        outline: band(x(s), y(s), x(t), y(t), widthOf(link) / 2 + 2),
      };
    };
    const nodePlace = new Int32Array(count).fill(-1);
    nodes.forEach((node, i) => {
      nodePlace[node] = i;
    });
    const linkPlace = new Map(links.map((link, i) => [link, i]));
    return {
      geometry,
      itemAt(px, py) {
        // The node whose edge is nearest, within reach.
        let best = -1;
        let bestGap = REACH;
        for (const node of nodes) {
          const gap = Math.hypot(px - x(node), py - y(node)) - radii[node]!;
          if (gap <= bestGap) {
            best = node;
            bestGap = gap;
          }
        }
        if (best >= 0) return nodeItem(best);
        // Else the link nearest the pointer, within reach of its edge.
        let nearest = -1;
        let nearestGap = 0;
        links.forEach((link, i) => {
          const s = source[link]!;
          const t = target[link]!;
          const gap = distanceToSegment(px, py, x(s), y(s), x(t), y(t)) - widthOf(link) / 2;
          if (gap <= REACH && (nearest < 0 || gap < nearestGap)) {
            nearest = i;
            nearestGap = gap;
          }
        });
        return nearest >= 0 ? linkItem(nearest) : undefined;
      },
      count: nodes.length + links.length,
      item: (index) =>
        index < nodes.length ? nodeItem(nodes[index]!) : linkItem(index - nodes.length),
      indexOf(key) {
        // Keys are the mark's id and a node's name, or a link's two names.
        let parts: unknown;
        try {
          parts = JSON.parse(key);
        } catch {
          return -1;
        }
        if (!Array.isArray(parts) || parts[0] !== frame.id || parts.length > 3) return -1;
        const s = network.nodeOf.get(parts[1]) ?? -1;
        if (s < 0) return -1;
        if (parts.length === 2) return nodePlace[s]!;
        const t = network.nodeOf.get(parts[2]) ?? -1;
        const link = network.linkOf.get(Math.min(s, t) * network.stride + Math.max(s, t));
        const place = t < 0 || link === undefined ? undefined : linkPlace.get(link);
        return place === undefined ? -1 : nodes.length + place;
      },
      summary: () => this.#summary(network, nodes, links, degree, locale),
    };
  }

  /** Per node, its radius in pixels: `size` by area, or one radius for all. */
  #radii(network: Network, crowding: number): Float64Array {
    const count = network.names.length;
    const { size } = network;
    if (!size) return new Float64Array(count).fill(RADIUS * crowding);
    let largest = 0;
    // Sizes are finite or NaN, which no comparison passes.
    for (const v of size) if (v > largest) largest = v;
    const [r0, r1] = [SIZE_RANGE[0] * crowding, SIZE_RANGE[1] * crowding];
    // Areas grow linearly from the smallest radius at zero (and for missing values).
    return Float64Array.from(size, (v) => {
      const t = largest > 0 && v > 0 ? Math.min(1, v / largest) : 0;
      return Math.sqrt(r0 * r0 + (r1 * r1 - r0 * r0) * t);
    });
  }

  /**
   * Names beside the most connected nodes (the largest, with `size`): right
   * of each node, or left where that runs out of the room, and left out
   * where both would overlap a label already placed.
   */
  #labels(
    network: Network,
    nodes: readonly number[],
    degree: Int32Array,
    at: Float64Array,
    radii: Float64Array,
    frame: LayoutFrame,
  ): Geometry[] {
    const { bounds, theme, measure } = frame;
    const font = `${theme.fontSize}px ${theme.font}`;
    const lineHeight = Math.round(theme.fontSize * 1.25);
    const rank = network.size ?? degree;
    // Denser networks label fewer nodes: all of 50, 35 of 100, 11 of 1,000.
    const budget = Math.round(LABELED * Math.min(1, Math.sqrt(LABELED / nodes.length)));
    const candidates = [...nodes]
      .sort((a, b) => (rank[b]! || 0) - (rank[a]! || 0) || a - b)
      .slice(0, budget);
    const placed: number[] = [];
    // A label may cross links, but not other labels or other nodes, which its halo would hide.
    const free = (node: number, left: number, top: number, right: number, bottom: number) => {
      for (let i = 0; i < placed.length; i += 4) {
        if (
          left < placed[i + 2]! &&
          right > placed[i]! &&
          top < placed[i + 3]! &&
          bottom > placed[i + 1]!
        )
          return false;
      }
      for (const other of nodes) {
        if (other === node) continue;
        const r = radii[other]!;
        const ox = at[other * 2]!;
        const oy = at[other * 2 + 1]!;
        if (left < ox + r && right > ox - r && top < oy + r && bottom > oy - r) return false;
      }
      return true;
    };
    const sides = {
      start: { coords: [] as number[], labels: [] as string[] },
      end: { coords: [] as number[], labels: [] as string[] },
    };
    const right = bounds.x + bounds.width;
    for (const node of candidates) {
      const x = at[node * 2]!;
      const y = at[node * 2 + 1]!;
      const top = y - lineHeight / 2;
      const bottom = y + lineHeight / 2;
      if (top < bounds.y || bottom > bounds.y + bounds.height) continue;
      const offset = radii[node]! + RING + LABEL_GAP;
      // The wider side, at most a third of the room, bounds how long a name may be.
      const room = Math.min(bounds.width / 3, Math.max(right - x, x - bounds.x) - offset);
      const text = labelFor(network.names[node]!, room, measure, font);
      if (!text) continue;
      const width = measure(text, font);
      const after = x + offset;
      const before = x - offset;
      let anchor: "start" | "end";
      if (after + width <= right && free(node, after, top, after + width, bottom)) anchor = "start";
      else if (before - width >= bounds.x && free(node, before - width, top, before, bottom))
        anchor = "end";
      else continue;
      const [left, end] = anchor === "start" ? [after, after + width] : [before - width, before];
      placed.push(left, top, end, bottom);
      sides[anchor].coords.push(anchor === "start" ? after : before, y);
      sides[anchor].labels.push(text);
    }
    return (["start", "end"] as const)
      .filter((anchor) => sides[anchor].labels.length > 0)
      .map(
        (anchor) =>
          ({
            kind: "text",
            draw: textDrawing,
            key: `graph-labels-${anchor}`,
            fill: theme.text,
            anchor,
            // Labels lie over links and other nodes; the halo keeps them readable.
            halo: true,
            coords: Float32Array.from(sides[anchor].coords),
            labels: sides[anchor].labels,
            count: sides[anchor].labels.length,
          }) as TextGeometry,
      );
  }

  #summary(
    network: Network,
    nodes: readonly number[],
    links: readonly number[],
    degree: Int32Array,
    locale: string | undefined,
  ): string {
    const { names, loops, overflowed } = network;
    let left = "";
    if (loops > 0)
      left += ` ${plural(loops, "link from a node to itself is", "links from nodes to themselves are")} not drawn.`;
    if (overflowed > 0)
      left += ` ${plural(overflowed, "link whose total is too large to represent is", "links whose totals are too large to represent are")} not drawn.`;
    if (nodes.length === 0) return `Network with nothing to show.${left}`;
    const shownGroups = new Set<number>();
    let hub = nodes[0]!;
    for (const node of nodes) {
      if (network.group[node]! >= 0) shownGroups.add(network.group[node]!);
      if (degree[node]! > degree[hub]!) hub = node;
    }
    const groups = shownGroups.size > 0 ? ` in ${plural(shownGroups.size, "group", "groups")}` : "";
    let text = `Network of ${plural(nodes.length, "node", "nodes")} and ${plural(links.length, "link", "links")}${groups}; most connected: ${names[hub]} (${plural(degree[hub]!, "link", "links")}).`;
    if (this.spec.value !== undefined && links.length > 0) {
      let strongest = links[0]!;
      for (const link of links)
        if (network.value[link]! > network.value[strongest]!) strongest = link;
      text += ` Strongest link: ${names[network.source[strongest]!]} — ${names[network.target[strongest]!]}, ${this.spec.value} ${formatNumber(network.value[strongest]!, locale)}.`;
    }
    return text + left;
  }
}

/** The legend key and color key of a group; `undefined` for nodes of a network without groups. */
function groupKey(id: string | number, group: string | undefined): string {
  // An object, so no node's or link's key (arrays) can be the same.
  return JSON.stringify({ mark: id, group });
}

/** Why a network is too large to lay out, without a final period; undefined when it is not. */
function overLimit({ names, source }: Network): string | undefined {
  if (names.length <= MAX_NODES && source.length <= MAX_LINKS) return undefined;
  return `Network of ${plural(names.length, "node", "nodes")} and ${plural(source.length, "link", "links")}: too many to lay out (a network draws at most ${MAX_NODES} nodes and ${MAX_LINKS} links)`;
}

/** What a network draws when it cannot be drawn: nothing, and a sentence saying why. */
function nothing(why: string): LayoutResult {
  return {
    geometry: [],
    itemAt: () => undefined,
    count: 0,
    item: () => {
      throw new RangeError("graph has no items");
    },
    indexOf: () => -1,
    summary: () => `${why}.`,
  };
}

function ringWidth(radius: number): number {
  return Math.min(RING, radius * 0.35);
}

/**
 * SVG path data of a circle, as two half circles. The diameter is twice the
 * rounded radius: rounded separately, it could exceed the radius' reach and
 * bend the halves out of shape.
 */
function circle(x: number, y: number, radius: number): string {
  const r = n(radius);
  const d = n(Number(r) * 2);
  return `M${n(x - Number(r))} ${n(y)}a${r} ${r} 0 1 0 ${d} 0a${r} ${r} 0 1 0 -${d} 0Z`;
}

/** SVG path data of the rectangle `half` pixels either side of a segment, to outline a link. */
function band(x0: number, y0: number, x1: number, y1: number, half: number): string {
  const length = Math.hypot(x1 - x0, y1 - y0) || 1;
  const nx = (-(y1 - y0) / length) * half;
  const ny = ((x1 - x0) / length) * half;
  return `M${n(x0 + nx)} ${n(y0 + ny)}L${n(x1 + nx)} ${n(y1 + ny)}L${n(x1 - nx)} ${n(y1 - ny)}L${n(x0 - nx)} ${n(y0 - ny)}Z`;
}

function distanceToSegment(
  px: number,
  py: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const squared = dx * dx + dy * dy;
  const t = squared > 0 ? Math.min(1, Math.max(0, ((px - x0) * dx + (py - y0) * dy) / squared)) : 0;
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}

/** "1 link", "2 links". */
function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * A network of nodes joined by links, placed by a force simulation: a row
 * per link between the nodes named in `source` and `target`, and, with
 * `nodes`, a table naming each node in `node`, with its `group` and `size`.
 *
 * ```ts
 * graph(friendships, { source: "a", target: "b", nodes: people, node: "name", group: "team" })
 * ```
 */
export function graph<S extends Schema, N extends Schema = Schema>(
  links: Table<S>,
  options: GraphOptions<S, N>,
): GraphMark {
  const spec: GraphSpec = { type: "graph", source: options.source, target: options.target };
  if (options.value !== undefined) spec.value = options.value;
  if (options.nodes !== undefined) {
    if (options.nodes.name !== undefined) spec.nodes = options.nodes.name;
    spec.node = options.node;
    if (options.group !== undefined) spec.group = options.group;
    if (options.size !== undefined) spec.size = options.size;
  }
  if (options.labels !== undefined) spec.labels = options.labels;
  if (options.id !== undefined) spec.id = options.id;
  if (links.name !== undefined) spec.data = links.name;
  // Field names were checked against S and N above; marks work on the erased schemas.
  const mark = new GraphMark(spec, links as unknown as Table, options.nodes as unknown as Table);
  // Too large a network is a mistake when written. Marks loaded from specs
  // (a live chart's snapshot after rows streamed in, say) draw nothing and
  // say why instead, as growth while drawn does, so later changes can bring
  // the picture back.
  const refused = mark.overLimit();
  if (refused) throw new Error(refused);
  return mark;
}
