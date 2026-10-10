import type { CategoryField, NumberField, Schema, Table } from "../data/table.ts";
import { n } from "../draw/markup.ts";
import { pointDrawing } from "../draw/point.ts";
import { segmentDrawing } from "../draw/segments.ts";
import { shapesDrawing } from "../draw/shapes.ts";
import { textDrawing } from "../draw/text.ts";
import { formatNumber } from "../format/format.ts";
import { fitLayout, type LayoutFit, layoutFit, layoutForce, separate } from "../layout/force.ts";
import { labelFor } from "../layout/text.ts";
import { ItemViews } from "../model/item-views.ts";
import type { LegendEntry } from "../model/legend.ts";
import type { ChartConfig } from "../model/model.ts";
import { isLightColor } from "../scale/color.ts";
import type {
  Geometry,
  PathShape,
  PointGeometry,
  Rect,
  SegmentGeometry,
  ShapesGeometry,
  TextGeometry,
} from "../scene/scene.ts";
import type { Frozen, GraphSpec } from "../spec/spec.ts";
import { surface } from "../theme.ts";
import type {
  LayoutControls,
  LayoutFrame,
  LayoutItem,
  LayoutMark,
  LayoutResult,
} from "./layout-mark.ts";
import { CATEGORY, type ChartMark, DIM, frozen, type MARK, requireField } from "./mark.ts";

export type GraphOptions<S extends Schema, N extends Schema = Schema> = {
  /** Category field naming one end of each row's link. */
  source: CategoryField<S>;
  /** Category field naming the other end; a name in both fields is one node. */
  target: CategoryField<S>;
  /** Number field summed per pair of nodes, setting links' widths; without it, links are alike. */
  value?: NumberField<S>;
  /**
   * Links go from `source` to `target`, with an arrowhead at the target: a
   * pair's links one way and the other are two, bowed apart. Undirected by default.
   */
  directed?: boolean;
  /**
   * Category field naming each link, written along the links that have
   * room; a link of rows naming it differently has none.
   */
  linkLabel?: CategoryField<S>;
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
      size?: NumberField<N>;
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

/** How far a pair's two directed links bow apart: a share of their length, at most so many pixels. */
const BOW = 0.12;
const MAX_BOW = 28;
/** Arrowheads' sides, in pixels at the least, and their angle to the link. */
const ARROW = 6;
const ARROW_ANGLE = (24 * Math.PI) / 180;
/** Colors one geometry of points indexes, a byte each. */
const MAX_COLORS = 256;
/** Links whose names are written, as nodes': all of 50, fewer in denser networks. */
const LINK_LABELED = 50;

/** Shift with the arrow keys moves the node read, and 0 puts moved nodes back. */
const DRAG: LayoutControls = {
  kind: "drag",
  hint: "Shift with the arrow keys moves the node read, and 0 puts moved nodes back.",
};

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
  /**
   * Per link: its ends and its total. Directed links go from source to
   * target; undirected ones are named in the order their first row named them.
   */
  source: Int32Array;
  target: Int32Array;
  value: Float64Array;
  /** The link of a pair: `linkOf.get(pairKey(s, t))`, either way round unless directed. */
  linkOf: Map<number, number>;
  stride: number;
  /** Per row of the links table: its link, or -1 for rows left out. */
  linkOfRow: Int32Array;
  /** Per link, with `linkLabel`: its label's code, -1 for none, -2 for rows naming it differently. */
  label: Int32Array | undefined;
  /** The label field's categories. */
  labels: readonly string[];
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
  /** Layout units to the room's pixels, before overlapping nodes were pushed apart. */
  fit: LayoutFit;
}

/**
 * Nodes moved by dragging in one chart, by key: x, y in layout units, and
 * the layout positions they were moved in (moves in another are dropped).
 */
export interface MovedNodes {
  layout: object;
  at: ReadonlyMap<string, readonly [number, number]>;
}

/** What a network's drawing lends the controls that move its nodes (see dom/node-drag.ts). */
export interface NodeMoves {
  /** The layout positions moves are in. */
  layout: object;
  /** Whether the network's tables are still as they were laid out (no change waits to be drawn). */
  current(): boolean;
  /** Whether the item keyed `key` is a node drawn now, which can be moved. */
  movable(key: string): boolean;
  /** Whether a key is one of the network's nodes', drawn or not (a hidden group's). */
  owns(key: string): boolean;
  /**
   * Where in layout units the node keyed `key` goes to be drawn at a pixel,
   * kept inside the room as it is drawn, so a move past the edge stops there.
   */
  toLayout(key: string, px: number, py: number): [number, number];
  /** Where the node keyed `key` is drawn, in pixels, or would be if moved to `at` (layout units). */
  pixelOf(key: string, at?: readonly [number, number]): [number, number] | undefined;
}

export class GraphMark implements LayoutMark {
  declare readonly [MARK]: true;
  readonly layout = true;
  readonly views = ItemViews;
  readonly spec: Frozen<GraphSpec>;
  /** The table of links. */
  readonly table: Table;
  /** The table of nodes, when there is one. */
  readonly nodes: Table | undefined;
  readonly otherTables: readonly Table[];
  readonly measure: string;
  /** Dragging moves nodes with `interaction.drag`, and charts select rows of either table. */
  readonly interactions = ["drag"] as const;
  readonly selects = true;
  #network: Network | undefined;
  #placed: Placement | undefined;

  constructor(input: GraphSpec, links: Table, nodes?: Table) {
    this.spec = frozen(input);
    // Read from the copy: the caller may change what it passed.
    const spec = this.spec;
    requireField(links, spec.source, CATEGORY, "graph source");
    requireField(links, spec.target, CATEGORY, "graph target");
    if (spec.value !== undefined) requireField(links, spec.value, ["number"], "graph value");
    if (spec.linkLabel !== undefined)
      requireField(links, spec.linkLabel, CATEGORY, "graph linkLabel");
    if (nodes) {
      if (spec.node === undefined)
        throw new Error("graph nodes need `node`, the field naming each row's node");
      requireField(nodes, spec.node, CATEGORY, "graph node");
      if (spec.group !== undefined) requireField(nodes, spec.group, CATEGORY, "graph group");
      if (spec.size !== undefined) requireField(nodes, spec.size, ["number"], "graph size");
    } else if (spec.node !== undefined || spec.group !== undefined || spec.size !== undefined) {
      throw new Error("graph node, group, and size are fields of a nodes table, and there is none");
    }
    this.table = links;
    this.nodes = nodes;
    this.otherTables = nodes ? [nodes] : [];
    this.measure = spec.value ?? "Links";
  }

  controls(config: ChartConfig): LayoutControls | undefined {
    return config.interaction?.drag ? DRAG : undefined;
  }

  /** The key `linkOf` finds the link of nodes `s` and `t` by. */
  #pair(network: Pick<Network, "stride">, s: number, t: number): number {
    const { stride } = network;
    return this.spec.directed ? s * stride + t : Math.min(s, t) * stride + Math.max(s, t);
  }

  /** The versions of the tables the network is built from. */
  #versions(): string {
    return `${this.table.version} ${this.nodes?.version ?? ""}`;
  }

  /**
   * Nodes from the nodes table, a later row replacing an earlier one's
   * group and size, then names only links use. One link per pair of nodes
   * (each way, for directed links), summing the values (or counting the
   * rows) that are positive and finite; rows with a missing name or any
   * other value are left out, and so are names only they mention.
   */
  #build(): Network {
    const { spec, table: links, nodes } = this;
    const versions = this.#versions();
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
    const named = spec.linkLabel === undefined ? undefined : links.categories(spec.linkLabel);
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
    const labels: number[] = [];
    const linkOfRow = new Int32Array(links.length).fill(-1);
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
      const key = this.#pair({ stride }, s, t);
      let link = linkOf.get(key);
      const code = named ? named.codes[row]! : -1;
      if (link === undefined) {
        link = sums.length;
        linkOf.set(key, link);
        source.push(s);
        target.push(t);
        sums.push(0);
        labels.push(code);
      } else if (labels[link] !== code) labels[link] = -2;
      sums[link]! += value;
      linkOfRow[row] = link;
    }

    // Totals beyond the largest double are left out, keeping link numbers dense.
    const kept: number[] = [];
    const renumber = new Int32Array(sums.length).fill(-1);
    for (let link = 0; link < sums.length; link++)
      if (sums[link]! < Number.POSITIVE_INFINITY) renumber[link] = kept.push(link) - 1;
    if (kept.length < sums.length) {
      linkOf.clear();
      kept.forEach((link, i) => {
        linkOf.set(this.#pair({ stride }, source[link]!, target[link]!), i);
      });
      for (let row = 0; row < linkOfRow.length; row++)
        if (linkOfRow[row]! >= 0) linkOfRow[row] = renumber[linkOfRow[row]!]!;
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
      linkOfRow,
      label: named ? Int32Array.from(kept, (link) => labels[link]!) : undefined,
      labels: named?.dictionary ?? [],
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
    const options = {
      inset: Math.max(largest + RING + 1, margin),
      maxScale: MAX_SCALE,
      maxStretch: MAX_STRETCH,
    };
    const positions = this.#positions(network);
    const at = fitLayout(positions, bounds, options);
    const inside = {
      x: bounds.x + RING,
      y: bounds.y + RING,
      width: Math.max(0, bounds.width - 2 * RING),
      height: Math.max(0, bounds.height - 2 * RING),
    };
    separate(at, radii, inside, RING + 1);
    const fit = layoutFit(positions, bounds, options);
    this.#placed = { key, at, radii, crowding, fit };
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
    const directed = this.spec.directed === true;

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
    const placement = this.#place(network, bounds, margin);
    const { radii, crowding, fit } = placement;
    // Nodes the chart's user moved are where they were put, in the layout's units.
    const moved =
      frame.moved?.layout === this.#layoutIdentity(network) ? frame.moved?.at : undefined;
    const at = moved && moved.size > 0 ? placement.at.slice() : placement.at;
    const clampX = (node: number, x: number) =>
      Math.min(bounds.x + bounds.width - radii[node]!, Math.max(bounds.x + radii[node]!, x));
    const clampY = (node: number, y: number) =>
      Math.min(bounds.y + bounds.height - radii[node]!, Math.max(bounds.y + radii[node]!, y));
    // A node moved to a place in layout units, drawn inside the room.
    const pixelAt = (node: number, [lx, ly]: readonly [number, number]): [number, number] => [
      clampX(node, fit.cx + (lx - fit.mx) * fit.sx),
      clampY(node, fit.cy + (ly - fit.my) * fit.sy),
    ];
    for (const [key, place] of moved ?? []) {
      const node = nodeOfKey(network, frame.id, key);
      if (node < 0) continue;
      [at[node * 2], at[node * 2 + 1]] = pixelAt(node, place);
    }
    const x = (node: number) => at[node * 2]!;
    const y = (node: number) => at[node * 2 + 1]!;

    // With a selection highlighted, what none of its rows' selection holds is dimmed.
    const litNodes = this.#litNodes(network, frame.selected);
    const litLinks = this.#litLinks(network, frame.selected);

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
    // A directed link whose pair runs the other way too bows to its own side.
    const bowed = (link: number) =>
      directed && network.linkOf.has(this.#pair(network, target[link]!, source[link]!));
    const route = (link: number) =>
      routeOf(x(source[link]!), y(source[link]!), x(target[link]!), y(target[link]!), bowed(link));
    const ringColor = surface(theme);
    const opacity = LINK_OPACITY[isLightColor(ringColor) === false ? "dark" : "light"];
    // Links of about the same width, color, and highlight share a geometry.
    type Part = { width: number; color: string; dim: boolean; coords: number[]; d: string };
    const parts = new Map<string, Part>();
    // Each drawn link's part, by its place in `links`, for the order they are drawn in.
    const partOf: Part[] = [];
    for (const link of links) {
      const width = Math.round(widthOf(link) * 4) / 4;
      const color = linkColor(link);
      const dim = litLinks !== undefined && !litLinks[link];
      const key = `${width} ${color} ${dim}`;
      let part = parts.get(key);
      if (!part) {
        part = { width, color, dim, coords: [], d: "" };
        parts.set(key, part);
      }
      partOf.push(part);
      const r = route(link);
      // Directed links end at the target's ring, an arrowhead's tip there.
      const t = target[link]!;
      const end = directed ? radii[t]! + ringWidth(radii[t]!) + 0.5 : 0;
      const [ex, ey] = r.pointBack(end);
      if (r.bow) part.d += `M${n(r.x0)} ${n(r.y0)}Q${n(r.cx)} ${n(r.cy)} ${n(ex)} ${n(ey)}`;
      else part.coords.push(r.x0, r.y0, ex, ey);
      if (directed) {
        const [ux, uy] = r.direction();
        const side = Math.max(ARROW * Math.max(0.6, crowding), width * 2.5);
        for (const turn of [ARROW_ANGLE, -ARROW_ANGLE]) {
          const cos = Math.cos(turn);
          const sin = Math.sin(turn);
          part.coords.push(
            ex,
            ey,
            ex - side * (ux * cos - uy * sin),
            ey - side * (ux * sin + uy * cos),
          );
        }
      }
    }
    // Dimmed links below the others, muted below colored, thin below thick.
    const ordered = [...parts.values()].sort(
      (a, b) =>
        Number(b.dim) - Number(a.dim) ||
        Number(b.color === theme.muted) - Number(a.color === theme.muted) ||
        a.width - b.width,
    );
    // Links are drawn part by part, each part's straight links before its
    // bowed ones, and in order within those.
    const layerOf = new Map(ordered.map((part, i) => [part, i]));
    const layer = (i: number) => layerOf.get(partOf[i]!)! * 2 + (bowed(links[i]!) ? 1 : 0);
    const linkAbove = (i: number, j: number) =>
      layer(i) !== layer(j) ? layer(i) > layer(j) : i > j;
    const font = `${theme.fontSize}px ${theme.font}`;
    const geometry: Geometry[] = [];
    ordered.forEach(({ width, color, dim, coords, d }, i) => {
      const shown = dim ? opacity * DIM : opacity;
      if (coords.length > 0)
        geometry.push({
          kind: "segments",
          draw: segmentDrawing,
          key: `graph-links-${i}${dim ? "-dimmed" : ""}`,
          stroke: color,
          strokeWidth: width,
          opacity: shown,
          coords: Float32Array.from(coords),
          count: coords.length / 4,
        } as SegmentGeometry);
      if (d)
        geometry.push({
          kind: "shapes",
          draw: shapesDrawing,
          key: `graph-bows-${i}${dim ? "-dimmed" : ""}`,
          shapes: [
            {
              d,
              fill: "none",
              stroke: color,
              strokeWidth: width,
              opacity: shown,
              dash: undefined,
            } as PathShape,
          ],
          font,
          fontSize: theme.fontSize,
        } as ShapesGeometry);
    });
    geometry.push(...this.#nodeGeometry(nodes, at, radii, colorOf, ringColor, litNodes));
    // Labels' boxes, x0, y0, x1, y1 each, which later labels keep clear of.
    const placed: number[] = [];
    if (labeled) geometry.push(...this.#labels(network, nodes, degree, at, radii, frame, placed));
    if (network.label)
      geometry.push(...this.#linkLabels(network, links, route, at, radii, nodes, frame, placed));

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
      const r = route(link);
      const code = network.label?.[link] ?? -1;
      const named = code >= 0 ? `${network.labels[code]}: ` : "";
      const [mx, my] = r.middle();
      return {
        key: JSON.stringify([frame.id, names[s], names[t]]),
        label: `${names[s]} ${directed ? "→" : "—"} ${names[t]}`,
        color: linkColor(link),
        value: value[link]!,
        text: `${named}${format(value[link]!)}`,
        px: mx,
        py: my,
        outline: r.bow
          ? `M${n(r.x0)} ${n(r.y0)}Q${n(r.cx)} ${n(r.cy)} ${n(r.x1)} ${n(r.y1)}`
          : band(r.x0, r.y0, r.x1, r.y1, widthOf(link) / 2 + 2),
      };
    };
    const nodePlace = new Int32Array(count).fill(-1);
    nodes.forEach((node, i) => {
      nodePlace[node] = i;
    });
    const linkPlace = new Map(links.map((link, i) => [link, i]));
    /** The link an item key names, -1 for none drawn. */
    const linkOfKey = (parts: unknown[]) => {
      const s = network.nodeOf.get(parts[1] as string) ?? -1;
      const t = network.nodeOf.get(parts[2] as string) ?? -1;
      const link = s < 0 || t < 0 ? undefined : network.linkOf.get(this.#pair(network, s, t));
      return link === undefined ? -1 : link;
    };
    const keyParts = (key: string): unknown[] | undefined => {
      let parts: unknown;
      try {
        parts = JSON.parse(key);
      } catch {
        return undefined;
      }
      return Array.isArray(parts) && parts[0] === frame.id && parts.length <= 3 ? parts : undefined;
    };
    // Nodes are drawn as #nodeGeometry stacks them: those the selection
    // leaves out first, then the largest first, then in order.
    const drawnAbove = (a: number, b: number) => {
      const la = litNodes?.[a] ?? 0;
      const lb = litNodes?.[b] ?? 0;
      if (la !== lb) return la > lb;
      return radii[a] !== radii[b] ? radii[a]! < radii[b]! : a > b;
    };
    const moves: NodeMoves = {
      layout: this.#layoutIdentity(network),
      current: () => this.#versions() === network.versions,
      owns: (key) => keyParts(key)?.length === 2,
      movable: (key) => {
        const parts = keyParts(key);
        return parts?.length === 2 && nodePlace[network.nodeOf.get(parts[1] as string) ?? -1]! >= 0;
      },
      toLayout: (key, px, py) => {
        const node = nodeOfKey(network, frame.id, key);
        if (node >= 0) [px, py] = [clampX(node, px), clampY(node, py)];
        return [fit.mx + (px - fit.cx) / (fit.sx || 1), fit.my + (py - fit.cy) / (fit.sy || 1)];
      },
      pixelOf: (key, place) => {
        const node = nodeOfKey(network, frame.id, key);
        if (node < 0) return undefined;
        return place ? pixelAt(node, place) : [x(node), y(node)];
      },
    };
    return {
      geometry,
      itemAt(px, py) {
        // The node drawn on top of those under the pointer, else the one
        // whose edge is nearest, within reach.
        let top = -1;
        let best = -1;
        let bestGap = REACH;
        for (const node of nodes) {
          const gap = Math.hypot(px - x(node), py - y(node)) - radii[node]!;
          if (gap <= 0) {
            if (top < 0 || drawnAbove(node, top)) top = node;
          } else if (gap <= bestGap) {
            best = node;
            bestGap = gap;
          }
        }
        if (top >= 0) return nodeItem(top);
        if (best >= 0) return nodeItem(best);
        // Else the link nearest the pointer, within reach of its edge; of
        // links as near (those whose stroke it is on), the one drawn on top.
        let nearest = -1;
        let nearestGap = 0;
        links.forEach((link, i) => {
          const gap = Math.max(0, route(link).distance(px, py) - widthOf(link) / 2);
          if (gap > REACH) return;
          if (nearest < 0 || gap < nearestGap || (gap === nearestGap && linkAbove(i, nearest))) {
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
        const parts = keyParts(key);
        if (!parts || parts.length < 2) return -1;
        if (parts.length === 2) {
          const node = network.nodeOf.get(parts[1] as string);
          return node === undefined ? -1 : nodePlace[node]!;
        }
        const place = linkPlace.get(linkOfKey(parts));
        return place === undefined ? -1 : nodes.length + place;
      },
      summary: () => this.#summary(network, nodes, links, degree, locale),
      // A node stands for its rows of the nodes table, a link for those of the links table.
      rowsOf: (key, table) => {
        const parts = keyParts(key);
        if (!parts) return undefined;
        if (parts.length === 2) {
          const node = network.nodeOf.get(parts[1] as string);
          // A node only links name stands for no row.
          const rows = node === undefined || table !== this.nodes ? [] : this.#nodeRows(node);
          return rows.length > 0 ? rows : undefined;
        }
        const link = linkOfKey(parts);
        if (link < 0 || table !== this.table) return undefined;
        const rows: number[] = [];
        network.linkOfRow.forEach((of, row) => {
          if (of === link) rows.push(row);
        });
        return rows;
      },
      moves,
    };
  }

  /**
   * What identifies the layout positions moves are made in, the same for
   * every mark drawing the same tables (and versions) with the fields and
   * options the layout reads, so a mark made again with other styles keeps
   * the chart's moves; moves in another layout are dropped.
   */
  #layoutIdentity(network: Network): object {
    const { spec, table, nodes } = this;
    const fields = [spec.source, spec.target, spec.value, spec.directed === true, spec.node];
    const signature = JSON.stringify(fields);
    let byNodes = layouts.get(table);
    if (!byNodes) {
      byNodes = new WeakMap();
      layouts.set(table, byNodes);
    }
    const owner = nodes ?? table;
    let bySignature = byNodes.get(owner);
    if (!bySignature) {
      bySignature = new Map();
      byNodes.set(owner, bySignature);
    }
    // Each layout of the tables has its own, new with every change of their versions.
    let kept = bySignature.get(signature);
    if (kept?.versions !== network.versions) {
      kept = { versions: network.versions, identity: {} };
      bySignature.set(signature, kept);
    }
    return kept.identity;
  }

  /** The rows of the nodes table naming node `node`. */
  #nodeRows(node: number): number[] {
    const nodes = this.nodes!;
    const { codes, dictionary } = nodes.categories(this.spec.node!);
    const name = this.#network!.names[node];
    const rows: number[] = [];
    for (let row = 0; row < codes.length; row++)
      if (codes[row]! >= 0 && dictionary[codes[row]!] === name) rows.push(row);
    return rows;
  }

  /** Per node, whether any of its rows of the nodes table the highlighted selection holds. */
  #litNodes(network: Network, selected: LayoutFrame["selected"]): Uint8Array | undefined {
    const membership = this.nodes && selected?.(this.nodes);
    if (!membership) return undefined;
    const lit = new Uint8Array(network.names.length);
    const { codes, dictionary } = this.nodes!.categories(this.spec.node!);
    const nodeOfCode = Int32Array.from(dictionary, (name) => network.nodeOf.get(name) ?? -1);
    for (let row = 0; row < codes.length; row++)
      if (membership[row] && codes[row]! >= 0 && nodeOfCode[codes[row]!]! >= 0)
        lit[nodeOfCode[codes[row]!]!] = 1;
    return lit;
  }

  /** Per link, whether any of its rows the highlighted selection holds. */
  #litLinks(network: Network, selected: LayoutFrame["selected"]): Uint8Array | undefined {
    const membership = selected?.(this.table);
    if (!membership) return undefined;
    const lit = new Uint8Array(network.source.length);
    network.linkOfRow.forEach((link, row) => {
      if (link >= 0 && membership[row]) lit[link] = 1;
    });
    return lit;
  }

  /**
   * The nodes as points, largest first so smaller ones on top of them stay
   * visible, each filled and ringed in the surface color; with `lit`, those
   * it leaves out dimmed below the others.
   */
  #nodeGeometry(
    nodes: readonly number[],
    at: Float64Array,
    radii: Float64Array,
    colorOf: (node: number) => string,
    ringColor: string,
    lit: Uint8Array | undefined,
  ): PointGeometry[] {
    const parts = lit
      ? [nodes.filter((node) => !lit[node]), nodes.filter((node) => lit[node])]
      : [nodes];
    let thinnest = RING;
    for (const node of nodes) thinnest = Math.min(thinnest, ringWidth(radii[node]!));
    const geometry: PointGeometry[] = [];
    parts.forEach((part, i) => {
      const dim = lit !== undefined && i === 0;
      const stacked = [...part].sort((a, b) => radii[b]! - radii[a]! || a - b);
      // Points index at most 256 colors: more make runs of nodes, drawn in order.
      let start = 0;
      while (start < stacked.length) {
        const palette: string[] = [];
        const colorIndex = new Map<string, number>();
        const indices: number[] = [];
        let end = start;
        for (; end < stacked.length; end++) {
          const color = colorOf(stacked[end]!);
          let c = colorIndex.get(color);
          if (c === undefined) {
            if (palette.length === MAX_COLORS) break;
            c = palette.push(color) - 1;
            colorIndex.set(color, c);
          }
          indices.push(c);
        }
        const run = stacked.slice(start, end);
        const index = Uint8ClampedArray.from(indices);
        const coords = new Float32Array(run.length * 2);
        const sizes = new Float32Array(run.length);
        let largest = 0;
        run.forEach((node, k) => {
          coords[k * 2] = at[node * 2]!;
          coords[k * 2 + 1] = at[node * 2 + 1]!;
          sizes[k] = radii[node]!;
          largest = Math.max(largest, radii[node]!);
        });
        geometry.push({
          kind: "point",
          draw: pointDrawing,
          key: `graph-nodes${dim ? "-dimmed" : ""}${start > 0 ? `-${start}` : ""}`,
          fill: palette[0] ?? ringColor,
          fillOpacity: dim ? DIM : 1,
          opaque: false,
          ring: { color: ringColor, width: thinnest, ...(dim && { opacity: DIM }) },
          radius: largest,
          symbol: "circle",
          coords,
          count: run.length,
          radii: sizes,
          colors: palette.length > 1 ? { index, palette } : undefined,
        } as PointGeometry);
        start = end;
      }
    });
    return geometry;
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
    placed: number[],
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

  /**
   * Names along the heaviest links (the first, without `value`) with
   * room: at the link's middle, left out where it would cover a label
   * placed or a node; budgeted as node labels are.
   */
  #linkLabels(
    network: Network,
    links: readonly number[],
    route: (link: number) => Route,
    at: Float64Array,
    radii: Float64Array,
    nodes: readonly number[],
    frame: LayoutFrame,
    placed: number[],
  ): Geometry[] {
    const { theme, measure, bounds } = frame;
    const label = network.label!;
    const font = `${theme.fontSize}px ${theme.font}`;
    const lineHeight = Math.round(theme.fontSize * 1.25);
    const named = links.filter((link) => label[link]! >= 0);
    const budget = Math.round(
      LINK_LABELED * Math.min(1, Math.sqrt(LINK_LABELED / Math.max(1, named.length))),
    );
    const candidates = named
      .sort((a, b) => network.value[b]! - network.value[a]! || a - b)
      .slice(0, budget);
    const covers = (left: number, top: number, right: number, bottom: number) => {
      for (let i = 0; i < placed.length; i += 4)
        if (
          left < placed[i + 2]! &&
          right > placed[i]! &&
          top < placed[i + 3]! &&
          bottom > placed[i + 1]!
        )
          return true;
      for (const node of nodes) {
        const r = radii[node]!;
        const ox = at[node * 2]!;
        const oy = at[node * 2 + 1]!;
        if (left < ox + r && right > ox - r && top < oy + r && bottom > oy - r) return true;
      }
      return false;
    };
    const coords: number[] = [];
    const labels: string[] = [];
    for (const link of candidates) {
      const r = route(link);
      const [mx, my] = r.middle();
      // A link's name is at most as long as the link.
      const room = Math.min(bounds.width / 4, Math.hypot(r.x1 - r.x0, r.y1 - r.y0) - 8);
      const text = labelFor(network.labels[label[link]!]!, room, measure, font);
      if (!text) continue;
      const width = measure(text, font);
      const box = [
        mx - width / 2,
        my - lineHeight / 2,
        mx + width / 2,
        my + lineHeight / 2,
      ] as const;
      if (box[0] < bounds.x || box[2] > bounds.x + bounds.width) continue;
      if (box[1] < bounds.y || box[3] > bounds.y + bounds.height || covers(...box)) continue;
      placed.push(...box);
      coords.push(mx, my);
      labels.push(text);
    }
    if (labels.length === 0) return [];
    return [
      {
        kind: "text",
        draw: textDrawing,
        key: "graph-link-labels",
        fill: theme.text,
        anchor: "middle",
        halo: true,
        coords: Float32Array.from(coords),
        labels,
        count: labels.length,
      } as TextGeometry,
    ];
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
    const differ = network.label?.filter((code) => code === -2).length ?? 0;
    if (differ > 0)
      left += ` ${plural(differ, "link whose rows name it differently has", "links whose rows name them differently have")} no label.`;
    if (nodes.length === 0) return `Network with nothing to show.${left}`;
    const shownGroups = new Set<number>();
    let hub = nodes[0]!;
    for (const node of nodes) {
      if (network.group[node]! >= 0) shownGroups.add(network.group[node]!);
      if (degree[node]! > degree[hub]!) hub = node;
    }
    const groups = shownGroups.size > 0 ? ` in ${plural(shownGroups.size, "group", "groups")}` : "";
    const kind = this.spec.directed ? "directed links" : "links";
    let text = `Network of ${plural(nodes.length, "node", "nodes")} and ${plural(links.length, kind.slice(0, -1), kind)}${groups}; most connected: ${names[hub]} (${plural(degree[hub]!, "link", "links")}).`;
    if (this.spec.value !== undefined && links.length > 0) {
      let strongest = links[0]!;
      for (const link of links)
        if (network.value[link]! > network.value[strongest]!) strongest = link;
      const arrow = this.spec.directed ? "→" : "—";
      text += ` Strongest link: ${names[network.source[strongest]!]} ${arrow} ${names[network.target[strongest]!]}, ${this.spec.value} ${formatNumber(network.value[strongest]!, locale)}.`;
    }
    return text + left;
  }
}

/**
 * Layout identities by links table, then nodes table (the links table
 * without one), then the fields and options the layout reads.
 */
const layouts = new WeakMap<
  Table,
  WeakMap<Table, Map<string, { versions: string; identity: object }>>
>();

/** The node a node's item key names, -1 for none. */
function nodeOfKey(network: Network, id: string | number, key: string): number {
  let parts: unknown;
  try {
    parts = JSON.parse(key);
  } catch {
    return -1;
  }
  if (!Array.isArray(parts) || parts.length !== 2 || parts[0] !== id) return -1;
  return network.nodeOf.get(parts[1] as string) ?? -1;
}

/**
 * The way a link runs from (x0, y0) to (x1, y1): straight, or bowed to its
 * right through a quadratic curve's control point (cx, cy).
 */
interface Route {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  bow: boolean;
  cx: number;
  cy: number;
  /** The point `back` pixels before the end, along the way. */
  pointBack(back: number): [number, number];
  /** The way's direction at its end, a unit vector. */
  direction(): [number, number];
  /** Its middle. */
  middle(): [number, number];
  /** Pixels from a point to the way. */
  distance(px: number, py: number): number;
}

/** The way of a link: bowed when its pair has a link the other way too. */
function routeOf(x0: number, y0: number, x1: number, y1: number, bow: boolean): Route {
  const length = Math.hypot(x1 - x0, y1 - y0) || 1;
  const offset = bow ? Math.min(MAX_BOW, BOW * length) : 0;
  // The right of the way, as screens turn: links each way bow apart.
  const cx = (x0 + x1) / 2 - ((y1 - y0) / length) * offset;
  const cy = (y0 + y1) / 2 + ((x1 - x0) / length) * offset;
  const at = (t: number): [number, number] => {
    const u = 1 - t;
    return [u * u * x0 + 2 * u * t * cx + t * t * x1, u * u * y0 + 2 * u * t * cy + t * t * y1];
  };
  const direction = (): [number, number] => {
    const [dx, dy] = bow ? [x1 - cx, y1 - cy] : [x1 - x0, y1 - y0];
    const d = Math.hypot(dx, dy) || 1;
    return [dx / d, dy / d];
  };
  return {
    x0,
    y0,
    x1,
    y1,
    bow,
    cx,
    cy,
    pointBack(back) {
      if (back <= 0) return [x1, y1];
      const [ux, uy] = direction();
      return [x1 - ux * back, y1 - uy * back];
    },
    direction,
    middle: () => (bow ? at(0.5) : [(x0 + x1) / 2, (y0 + y1) / 2]),
    distance(px, py) {
      if (!bow) return distanceToSegment(px, py, x0, y0, x1, y1);
      // A curve's distance, from eight chords along it.
      let best = Number.POSITIVE_INFINITY;
      let [ax, ay] = [x0, y0];
      for (let k = 1; k <= 8; k++) {
        const [bx, by] = at(k / 8);
        best = Math.min(best, distanceToSegment(px, py, ax, ay, bx, by));
        [ax, ay] = [bx, by];
      }
      return best;
    },
  };
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
): ChartMark<Frozen<GraphSpec>> {
  const spec: GraphSpec = { type: "graph", source: options.source, target: options.target };
  if (options.value !== undefined) spec.value = options.value;
  if (options.directed !== undefined) spec.directed = options.directed;
  if (options.linkLabel !== undefined) spec.linkLabel = options.linkLabel;
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
