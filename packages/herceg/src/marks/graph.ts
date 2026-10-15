import type { CategoryField, NumberField, Schema, Table } from "../data/table.ts";
import { labelHalo } from "../draw/label-halo.ts";
import { n } from "../draw/markup.ts";
import { pointDrawing } from "../draw/point.ts";
import { segmentDrawing } from "../draw/segments.ts";
import { shapesDrawing } from "../draw/shapes.ts";
import { textDrawing } from "../draw/text.ts";
import { formatNumber } from "../format/format.ts";
import { fitLayout, type LayoutFit, layoutFit, separate } from "../layout/force.ts";
import { graphView } from "../layout/graph-view.ts";
import { HitGrid } from "../layout/hit-grid.ts";
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
import type { Frozen, GraphLayout, GraphSpec } from "../spec/spec.ts";
import type { Halo } from "../spec/style.ts";
import { surface } from "../theme.ts";
import type {
  LayoutControls,
  LayoutFrame,
  LayoutItem,
  LayoutMark,
  LayoutResult,
} from "./layout-mark.ts";
import { insidePolygon } from "./layout-mark.ts";
import { CATEGORY, type ChartMark, DIM, frozen, type MARK, requireField } from "./mark.ts";
import {
  type LayoutNetwork,
  type NetworkLayout,
  NodePositions,
  pairKey,
} from "./node-positions.ts";

export type GraphOptions<S extends Schema, N extends Schema = Schema> = {
  /** The outline that keeps text readable: "auto" (the default), false for none, or a color of its own. */
  halo?: Halo;
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
  linkLabelField?: CategoryField<S>;
  /** Names beside the most connected (or largest) nodes that have room; true by default. */
  labels?: boolean;
  /**
   * How nodes are placed: "force" (the default), "circular", or "layered",
   * or an object naming one in `type` with its options (see `GraphLayout`).
   */
  layout?: GraphLayout;
  id?: string;
  /** With the chart's `panels`, the id of the panel the network has to itself. */
  panel?: string;
} & (
  | { nodes?: undefined; node?: undefined; color?: undefined; size?: undefined }
  | {
      /** A table with a row per node, for nodes without links and for colors and sizes. */
      nodes: Table<N>;
      /** Category field of `nodes` naming each row's node, as `source` and `target` do. */
      node: CategoryField<N>;
      /** Category field of `nodes`: nodes are colored by it, with a legend. */
      color?: CategoryField<N>;
      /** Number field of `nodes` sizing nodes by area. */
      size?: NumberField<N>;
    }
);

/**
 * A force layout of this many nodes takes about ten seconds, spread over
 * frames in the browser; larger networks are refused, as no layout of them
 * is quick or legible enough.
 */
export const MAX_NODES = 50_000;
/** Links beyond this many cost the springs, routes, and drawing more than repulsion; more are refused too. */
export const MAX_LINKS = 200_000;
/** Ids for lists of rows, so caches can tell one facet panel's from another's. */
const rowIds = new WeakMap<Uint32Array, number>();
let rowCount = 0;
function idOf(rows: Uint32Array): number {
  let id = rowIds.get(rows);
  if (id === undefined) {
    id = ++rowCount;
    rowIds.set(rows, id);
  }
  return id;
}

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
/** A mapping of numbers, as a scale's. */
type Map1 = (value: number) => number;
/** How far a layered layout's links each way between two nodes keep to either side, in pixels. */
const LAYER_SIDE = 5;
/** Layered links are curves in networks of up to this many links, and polylines in larger ones. */
const CURVED_LINKS = 20_000;
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
interface Network extends LayoutNetwork {
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
  /** Per link, with `linkLabelField`: its label's code, -1 for none, -2 for rows naming it differently. */
  label: Int32Array | undefined;
  /** The label field's categories. */
  labels: readonly string[];
  /** Nodes with links to themselves, which are left out. */
  loops: number;
  /** Links whose total overflows a double, which are left out. */
  overflowed: number;
}

/**
 * Pointer lookups of a room: grids of nodes and links, built when first
 * needed, and those reaching beyond the grids' area, looked through one by one.
 */
interface Picking {
  nodes?: HitGrid;
  links?: HitGrid;
  farNodes?: number[];
  farLinks?: number[];
}

/** Where nodes are drawn in one room. */
interface Placement {
  /** The positions' revision and the room it is for. */
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
 * Nodes moved in one chart, by key, x, y in layout units: where they are
 * drawn (`at`, the node being dragged where it is dragged), and the moves
 * made (`held`, where the layout holds them: a drag moves nothing until it
 * is dropped, so nothing settles before).
 */
export interface MovedNodes {
  at: ReadonlyMap<string, readonly [number, number]>;
  held: ReadonlyMap<string, readonly [number, number]>;
}

/** What a network's drawing lends the controls that move its nodes (see dom/node-drag.ts). */
export interface NodeMoves {
  /** Whether the network's tables are still as they were drawn (no change waits to be drawn). */
  current(): boolean;
  /** Whether the item keyed `key` is a node drawn now, which can be dragged. */
  movable(key: string): boolean;
  /**
   * Whether the item keyed `key` is a node of this panel's network, drawn or
   * in a hidden group: one `setItemPosition` moves, drawn there once shown.
   */
  inPanel(key: string): boolean;
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
  readonly interactions = ["plane", "lasso", "drag"] as const;
  readonly selects = true;
  #network: Network | undefined;
  /** The layout, its options filled in. */
  readonly #layout: NetworkLayout;
  /** Each facet panel's part of the network, by its rows (see `#part`). */
  readonly #parts = new WeakMap<Uint32Array, Network>();
  /** Placements by the positions they place, then by the size of the room, at its top left corner (see `#place`). */
  readonly #placed = new WeakMap<NodePositions, Map<string, Placement>>();
  /** Where nodes are when a frame keeps no state for them (a mark drawn on its own). */
  readonly #positions = { current: undefined as NodePositions | undefined };
  /**
   * Pointer lookups of the room last drawn by each chart's positions (or,
   * in facet panels, by each panel's rows), with what they depend on.
   */
  readonly #picking = new WeakMap<
    object,
    { places: NodePositions; key: string; picking: Picking }
  >();

  constructor(input: GraphSpec, links: Table, nodes?: Table) {
    this.spec = frozen(input);
    // Read from the copy: the caller may change what it passed.
    const spec = this.spec;
    this.#layout = layoutOf(spec.layout);
    requireField(links, spec.source, CATEGORY, "graph source");
    requireField(links, spec.target, CATEGORY, "graph target");
    if (spec.value !== undefined) requireField(links, spec.value, ["number"], "graph value");
    if (spec.linkLabelField !== undefined)
      requireField(links, spec.linkLabelField, CATEGORY, "graph linkLabelField");
    if (nodes) {
      if (spec.node === undefined)
        throw new Error(
          "graph node: required with a nodes table; name the field of each row's node",
        );
      requireField(nodes, spec.node, CATEGORY, "graph node");
      if (spec.color !== undefined) requireField(nodes, spec.color, CATEGORY, "graph color");
      if (spec.size !== undefined) requireField(nodes, spec.size, ["number"], "graph size");
    } else if (spec.node !== undefined || spec.color !== undefined || spec.size !== undefined) {
      throw new Error(
        "graph nodes: node, color, and size are fields of a nodes table; give nodes or drop them",
      );
    }
    this.table = links;
    this.nodes = nodes;
    this.otherTables = nodes ? [nodes] : [];
    this.measure = spec.value ?? "Links";
  }

  controls(config: ChartConfig): LayoutControls {
    const { zoom, pan, brush, drag, bindings } = config.interaction ?? {};
    // Without interaction, the chart still draws the frames a layout takes.
    if (!zoom && !pan && !brush && !drag && !bindings?.length) return { kind: "layout", hint: "" };
    const pans = pan ?? zoom;
    return {
      kind: "drag",
      hint: pans
        ? `Shift with the arrow keys pans it, ${zoom ? "plus and minus zoom, " : ""}and 0 shows the whole network.` +
          (drag ? " Alt with Shift and the arrow keys moves the node read." : "")
        : drag
          ? DRAG.hint
          : "",
    };
  }

  /** The key `linkOf` finds the link of nodes `s` and `t` by. */
  #pair(network: Pick<Network, "stride">, s: number, t: number): number {
    return pairKey({ stride: network.stride, directed: this.spec.directed === true }, s, t);
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
      const groups = spec.color === undefined ? undefined : nodes.categories(spec.color);
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
    const named =
      spec.linkLabelField === undefined ? undefined : links.categories(spec.linkLabelField);
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
    // Per link, which ways its rows run: from its source to its target (1), back (2).
    const ways: number[] = [];
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
        ways.push(0);
      } else if (labels[link] !== code) labels[link] = -2;
      sums[link]! += value;
      ways[link]! |= source[link] === s ? 1 : 2;
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
    const value = Float64Array.from(kept, (link) => sums[link]!);
    // Heavier links pull somewhat harder, without making the simulation stiff.
    let largest = 0;
    for (const v of value) largest = Math.max(largest, v);
    const network: Network = {
      versions,
      names,
      nodeOf,
      group: new Int32Array(count).fill(-1),
      groups: [],
      size: spec.size === undefined ? undefined : new Float64Array(count).fill(Number.NaN),
      source: Int32Array.from(kept, (link) => source[link]!),
      target: Int32Array.from(kept, (link) => target[link]!),
      value,
      strength:
        spec.value === undefined
          ? undefined
          : Float64Array.from(value, (v) => 0.5 + 0.5 * Math.sqrt(v / largest)),
      ways: Uint8Array.from(kept, (link) => ways[link]!),
      directed: spec.directed === true,
      linkOf,
      stride,
      linkOfRow,
      label: named ? Int32Array.from(kept, (link) => labels[link]!) : undefined,
      labels: named?.dictionary ?? [],
      loops: loops.size,
      overflowed: sums.length - kept.length,
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

  /**
   * Where nodes are drawn in a room, and how large: the layout scaled to
   * fit at least `margin` inside its edges, then, in a force layout,
   * overlapping nodes pushed apart. Hidden groups keep their places, so
   * showing them again moves nothing. The fit holds while nodes settle, so
   * the view does not move under them.
   */
  #place(network: Network, places: NodePositions, bounds: Rect, margin: number): Placement {
    let kept = this.#placed.get(places);
    if (!kept) {
      kept = new Map();
      this.#placed.set(places, kept);
    }
    // Laid out in a room of the size at its corner, then moved to the room:
    // facet panels of one size share the work, and draw nodes alike.
    // Positions as they are now, and the network they place (whose sizes radii follow).
    const shown = `${places.revision} ${network.versions}`;
    const size = `${shown} ${bounds.width} ${bounds.height} ${margin}`;
    let placed = kept.get(size);
    if (!placed) {
      if (kept.size > 8 || ![...kept.keys()][0]?.startsWith(`${shown} `)) kept.clear();
      placed = this.#placeAt(network, places, { ...bounds, x: 0, y: 0 }, margin);
      kept.set(size, placed);
    }
    if (bounds.x === 0 && bounds.y === 0) return placed;
    const at = placed.at.map((v, i) => v + (i % 2 === 0 ? bounds.x : bounds.y));
    const fit = { ...placed.fit, cx: placed.fit.cx + bounds.x, cy: placed.fit.cy + bounds.y };
    return { ...placed, key: `${size} ${bounds.x} ${bounds.y}`, at, fit };
  }

  #placeAt(network: Network, places: NodePositions, bounds: Rect, margin: number): Placement {
    const key = `${places.revision} ${network.versions} ${bounds.width} ${bounds.height} ${margin} 0 0`;
    const count = network.names.length;
    // Nodes shrink in rooms crowded with them, so they stay apart.
    const room = Math.max(1, bounds.width * bounds.height);
    const crowding = Math.min(1, Math.max(0.45, Math.sqrt(room / Math.max(1, count)) / 60));
    const radii = this.#radii(network, crowding);
    let largest = 0;
    for (const r of radii) largest = Math.max(largest, r);
    const circular = this.#layout.type === "circular";
    // A circle's labels stand outside it, beside the nodes at its left and right.
    const labelRoom = circular && margin > 0 ? Math.min(80, bounds.width / 6) : 0;
    const inset = Math.max(largest + RING + 1, margin);
    const options = {
      inset,
      insetX: Math.max(inset, labelRoom),
      maxScale: MAX_SCALE,
      // A circle stays round.
      maxStretch: circular ? 1 : MAX_STRETCH,
    };
    const positions = places.shown!;
    const { insetX, maxStretch } = options;
    const fit = places.fit(
      `${bounds.width} ${bounds.height} ${inset} ${insetX} ${maxStretch}`,
      () => layoutFit(places.own ?? positions, bounds, options),
    );
    const at = fitLayout(positions, fit);
    const inside = {
      x: bounds.x + RING,
      y: bounds.y + RING,
      width: Math.max(0, bounds.width - 2 * RING),
      height: Math.max(0, bounds.height - 2 * RING),
    };
    // Only a force layout's nodes may overlap, and only where they can be
    // set apart: nodes whose circles would cover the room stay as they are.
    let area = 0;
    for (const r of radii) area += (2 * r + RING + 1) ** 2;
    if (this.#layout.type === "force" && area < inside.width * inside.height)
      separate(at, radii, inside, RING + 1);
    return { key, at, radii, crowding, fit };
  }

  /**
   * Whether the network, as its tables are now, has the node keyed `key`
   * (drawn or not), the mark being `id` among its chart's: what a host that
   * keeps moves without drawing the chart (a notebook widget with no display
   * open) asks to let go of those of nodes the data took.
   */
  ownsNode(key: string, id: string | number): boolean {
    return nodeOfKey(this.#build(), id, key) >= 0;
  }

  /**
   * The moves of a network not drawn (too large, or still being arranged):
   * its nodes can be moved, and keep their moves, though none can be dragged.
   */
  #unplaced(network: Network, id: string | number): NodeMoves {
    const owns = (key: string) => nodeOfKey(network, id, key) >= 0;
    return {
      current: () => this.#versions() === network.versions,
      owns,
      movable: owns,
      inPanel: owns,
      toLayout: () => [Number.NaN, Number.NaN],
      pixelOf: () => undefined,
    };
  }

  /**
   * The part of the network a facet panel's rows of the links table give:
   * the same nodes and links, each link's total over those rows (0 for
   * links without), and the label they name it by; kept per rows.
   */
  #part(network: Network, rows: Uint32Array): Network {
    const kept = this.#parts.get(rows);
    if (kept?.versions === network.versions) return kept;
    const { table: links, spec } = this;
    const values = spec.value === undefined ? undefined : links.numbers(spec.value);
    const named =
      spec.linkLabelField === undefined ? undefined : links.categories(spec.linkLabelField);
    const value = new Float64Array(network.value.length);
    // -3 for links none of the rows names yet.
    const label = named && new Int32Array(network.value.length).fill(-3);
    for (const row of rows) {
      const link = network.linkOfRow[row]!;
      if (link < 0) continue;
      value[link]! += values ? values[row]! : 1;
      if (!label) continue;
      const code = named!.codes[row]!;
      label[link] = label[link] === -3 || label[link] === code ? code : -2;
    }
    const part = { ...network, value, label };
    this.#parts.set(rows, part);
    return part;
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
    const whole = this.#build();
    // The chart's state of the panel keeps where nodes are; a lone mark keeps its own.
    const slot = frame.nodePositions ?? this.#positions;
    const refused = overLimit(whole);
    if (refused) {
      if (slot.current) this.#picking.delete(slot.current);
      // Moves of nodes the network has stay for when it is drawn again.
      return { ...nothing(refused), moves: this.#unplaced(whole, frame.id) };
    }
    let places = slot.current;
    if (places?.owner !== frame.id) slot.current = places = new NodePositions(frame.id);
    // Moved nodes are held where they were put; a drag is not yet a move.
    const moved = frame.moved?.at;
    const held = new Map<number, readonly [number, number]>();
    for (const [key, place] of frame.moved?.held ?? []) {
      const node = nodeOfKey(whole, frame.id, key);
      if (node >= 0) held.set(node, place);
    }
    places.update(whole, this.#layout, held, frame.clock);
    if (places.failure) {
      // Links spanning more layers than a layered layout routes.
      this.#picking.delete(places);
      return {
        ...nothing(
          `N${describeNetwork(whole).slice(1)}: too many layers between linked nodes to route (${places.failure}); use another layout, or filter the links`,
        ),
        moves: this.#unplaced(whole, frame.id),
      };
    }
    if (!places.shown) {
      this.#picking.delete(places);
      // Nodes can be moved already (moves restored as a chart mounts), though not dragged.
      return {
        ...nothing(`Arranging the ${describeNetwork(whole)}`),
        pending: true,
        moves: this.#unplaced(whole, frame.id),
      };
    }
    const { bounds, theme, hidden, locale, rows } = frame;
    // A facet panel draws its rows' links, with their totals there, and the
    // nodes they join, where the whole network's layout puts them.
    const network = rows ? this.#part(whole, rows) : whole;
    const { names, source, target, value, group, groups } = network;
    const count = names.length;
    const directed = this.spec.directed === true;

    // Group colors; nodes without a group are muted, unless no node has one.
    const groupColors = groups.map((name) => frame.color(groupKey(frame.id, name)));
    const plain = groups.length > 0 ? theme.muted : frame.color(groupKey(frame.id, undefined));
    const colorOf = (node: number) => (group[node]! >= 0 ? groupColors[group[node]!]! : plain);
    const shown = (node: number) =>
      group[node]! < 0 || !hidden.has(groupKey(frame.id, groups[group[node]!]!));
    const joined = rows && new Uint8Array(count);
    for (let link = 0; joined && link < source.length; link++)
      if (value[link]! > 0) joined[source[link]!] = joined[target[link]!] = 1;
    const nodes: number[] = [];
    for (let node = 0; node < count; node++)
      if (shown(node) && (!joined || joined[node])) nodes.push(node);
    const links: number[] = [];
    for (let link = 0; link < source.length; link++)
      if (shown(source[link]!) && shown(target[link]!) && value[link]! > 0) links.push(link);
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
    const placement = this.#place(whole, places, bounds, margin);
    const { radii, crowding, fit } = placement;
    const plane = graphView(fit, bounds, frame.viewport);
    const navigating = !!(frame.viewport?.x || frame.viewport?.y);
    const at = navigating || (moved && moved.size > 0) ? placement.at.slice() : placement.at;
    if (navigating) {
      for (let node = 0; node < count; node++) {
        at[node * 2] = plane.x.map(fit.mx + (placement.at[node * 2]! - fit.cx) / (fit.sx || 1));
        at[node * 2 + 1] = plane.y.map(
          fit.my + (placement.at[node * 2 + 1]! - fit.cy) / (fit.sy || 1),
        );
      }
    }
    const clampX = (node: number, x: number) =>
      Math.min(bounds.x + bounds.width - radii[node]!, Math.max(bounds.x + radii[node]!, x));
    const clampY = (node: number, y: number) =>
      Math.min(bounds.y + bounds.height - radii[node]!, Math.max(bounds.y + radii[node]!, y));
    // Manual positions project without pinning nodes to the current view edge.
    const pixelAt = ([lx, ly]: readonly [number, number]): [number, number] => [
      plane.x.map(lx),
      plane.y.map(ly),
    ];
    for (const [key, place] of moved ?? []) {
      const node = nodeOfKey(network, frame.id, key);
      if (node < 0) continue;
      [at[node * 2], at[node * 2 + 1]] = pixelAt(place);
    }
    const x = (node: number) => at[node * 2]!;
    const y = (node: number) => at[node * 2 + 1]!;

    // With a selection highlighted, what none of its rows' selection holds is dimmed.
    const litNodes = this.#litNodes(network, frame.selected);
    const litLinks = this.#litLinks(network, frame.selected, rows);
    // A node selection leaves bright only links whose two ends it holds.
    const highlightedLinks = litNodes
      ? Uint8Array.from(source, (s, link) =>
          litNodes[s] && litNodes[target[link]!] && (!litLinks || litLinks[link]) ? 1 : 0,
        )
      : litLinks;

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
    // A directed link whose pair runs the other way too bows to its own side;
    // a layered layout's links curve through their bend points instead.
    const routes = places.routes;
    const bowed = (link: number) =>
      !routes && directed && network.linkOf.has(this.#pair(network, target[link]!, source[link]!));
    const across = this.#layout.type === "layered" ? this.#layout.direction : undefined;
    // Many links are drawn through their bend points straight, which costs a chord a span.
    const curved = source.length <= CURVED_LINKS;
    // Routes from nodes' pixels, bend points mapped from layout units as they are.
    const routing =
      (px: (node: number) => number, py: (node: number) => number, mapX: Map1, mapY: Map1) =>
      (link: number): Route => {
        const [s, t] = [source[link]!, target[link]!];
        if (!routes) return routeOf(px(s), py(s), px(t), py(t), bowed(link));
        const points = [px(s), py(s)];
        for (let k = routes.starts[link]!; k < routes.starts[link + 1]!; k++)
          points.push(mapX(routes.bends[k * 2]!), mapY(routes.bends[k * 2 + 1]!));
        points.push(px(t), py(t));
        const vertical = across === "down" || across === "up";
        // Directed links each way between two nodes go a few pixels to either side.
        if (directed && network.linkOf.has(this.#pair(network, t, s))) {
          if (points.length === 4)
            points.splice(2, 0, (points[0]! + points[2]!) / 2, (points[1]! + points[3]!) / 2);
          const side = (s < t ? 1 : -1) * LAYER_SIDE;
          for (let i = 2; i < points.length - 2; i += 2) points[i + (vertical ? 0 : 1)]! += side;
        }
        return pathRoute(points, vertical, curved);
      };
    const route = routing(
      x,
      y,
      (v) => plane.x.map(v),
      (v) => plane.y.map(v),
    );
    const ringColor = surface(theme);
    const opacity = LINK_OPACITY[isLightColor(ringColor) === false ? "dark" : "light"];
    // Links of about the same width, color, and highlight share a geometry.
    type Part = { width: number; color: string; dim: boolean; coords: number[]; d: string };
    // Parts by color, then width, dimmed ones apart.
    const byColor = [new Map<string, Map<number, Part>>(), new Map<string, Map<number, Part>>()];
    const parts: Part[] = [];
    // Each drawn link's part, by its place in `links`, for the order they are drawn in.
    const partOf: Part[] = [];
    for (const link of links) {
      const width = Math.round(widthOf(link) * 4) / 4;
      const color = linkColor(link);
      const dim = highlightedLinks !== undefined && !highlightedLinks[link];
      const byWidth = byColor[dim ? 1 : 0]!;
      let widths = byWidth.get(color);
      if (!widths) {
        widths = new Map();
        byWidth.set(color, widths);
      }
      let part = widths.get(width);
      if (!part) {
        part = { width, color, dim, coords: [], d: "" };
        widths.set(width, part);
        parts.push(part);
      }
      partOf.push(part);
      // Undirected straight links, most of them in large networks, need no route.
      const t = target[link]!;
      if (!directed && !routes) {
        part.coords.push(x(source[link]!), y(source[link]!), x(t), y(t));
        continue;
      }
      // So do undirected layered links of large networks, straight between their bend points.
      if (!directed && routes && !curved) {
        let [ax, ay] = [x(source[link]!), y(source[link]!)];
        for (let k = routes.starts[link]!; k < routes.starts[link + 1]!; k++) {
          const bx = plane.x.map(routes.bends[k * 2]!);
          const by = plane.y.map(routes.bends[k * 2 + 1]!);
          part.coords.push(ax, ay, bx, by);
          [ax, ay] = [bx, by];
        }
        part.coords.push(ax, ay, x(t), y(t));
        continue;
      }
      const r = route(link);
      // Directed links end at the target's ring, an arrowhead's tip there.
      const end = directed ? radii[t]! + ringWidth(radii[t]!) + 0.5 : 0;
      const [ex, ey] = r.pointBack(end);
      if (r.bow) part.d += `M${n(r.x0)} ${n(r.y0)}Q${n(r.cx)} ${n(r.cy)} ${n(ex)} ${n(ey)}`;
      else if (r.path) {
        // Chords of the curve, the last ending at the arrowhead's tip.
        const { path } = r;
        for (let i = 2; i < path.length; i += 2) {
          const last = i === path.length - 2;
          part.coords.push(
            path[i - 2]!,
            path[i - 1]!,
            last ? ex : path[i]!,
            last ? ey : path[i + 1]!,
          );
        }
      } else part.coords.push(r.x0, r.y0, ex, ey);
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
    const ordered = [...parts].sort(
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
    // A circle's labels point outward: left of the nodes on its left half.
    const middle = plane.x.map(0);
    const leftward =
      this.#layout.type === "circular" ? (node: number) => x(node) < middle : () => false;
    if (labeled)
      geometry.push(...this.#labels(network, nodes, degree, at, radii, frame, placed, leftward));
    if (network.label)
      geometry.push(...this.#linkLabels(network, links, route, at, radii, nodes, frame, placed));

    const format = (v: number) => formatNumber(v, locale);
    const nodeItem = (node: number): LayoutItem => {
      const details: string[] = [];
      if (group[node]! >= 0) details.push(`${this.spec.color} ${groups[group[node]!]}`);
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
        outline: routePath(r, widthOf(link) / 2 + 2),
      };
    };
    const nodePlace = new Int32Array(count).fill(-1);
    nodes.forEach((node, i) => {
      nodePlace[node] = i;
    });
    // Each link's place among those drawn, found once a link key is looked up.
    let linkPlace: Int32Array | undefined;
    const placeOfLink = (link: number) => {
      if (!linkPlace) {
        linkPlace = new Int32Array(source.length).fill(-1);
        links.forEach((link, i) => {
          linkPlace![link] = i;
        });
      }
      return link < 0 ? -1 : linkPlace[link]!;
    };
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
      current: () => this.#versions() === network.versions,
      owns: (key) => nodeOfKey(network, frame.id, key) >= 0,
      movable: (key) => nodePlace[nodeOfKey(network, frame.id, key)]! >= 0,
      inPanel: (key) => {
        const node = nodeOfKey(network, frame.id, key);
        return node >= 0 && (!joined || joined[node] === 1);
      },
      toLayout: (key, px, py) => {
        const node = nodeOfKey(network, frame.id, key);
        if (node >= 0) [px, py] = [clampX(node, px), clampY(node, py)];
        return [plane.x.invert(px), plane.y.invert(py)];
      },
      pixelOf: (key, place) => {
        const node = nodeOfKey(network, frame.id, key);
        if (node < 0) return undefined;
        return place ? pixelAt(place) : [x(node), y(node)];
      },
    };
    // Picking candidates come from the layout as fitted to the room, before
    // any zoom: the pointer is mapped back there, so they last while the view
    // pans and zooms. At a zoom of 1 or more, everything within reach on
    // screen is within reach there too; a view set wider is indexed as drawn.
    const fitted = plane.zoom >= 1;
    const fitX = (v: number) => fit.cx + (v - fit.mx) * fit.sx;
    const fitY = (v: number) => fit.cy + (v - fit.my) * fit.sy;
    const baseAt = fitted && (navigating || moved) ? placement.at.slice() : at;
    if (baseAt !== at)
      for (const [key, [lx, ly]] of moved ?? []) {
        const node = nodeOfKey(network, frame.id, key);
        if (node >= 0) [baseAt[node * 2], baseAt[node * 2 + 1]] = [fitX(lx), fitY(ly)];
      }
    const bx = (node: number) => baseAt[node * 2]!;
    const by = (node: number) => baseAt[node * 2 + 1]!;
    const baseRoute = baseAt === at ? route : routing(bx, by, fitX, fitY);
    const toBase = (px: number, py: number): [number, number] =>
      fitted ? [fitX(plane.x.invert(px)), fitY(plane.y.invert(py))] : [px, py];
    // Indexed where nodes are, or might be moved to, within a few rooms of the room.
    let [left, top, right, bottom] = [
      bounds.x,
      bounds.y,
      bounds.x + bounds.width,
      bounds.y + bounds.height,
    ];
    let largest = 0;
    for (const node of nodes) {
      left = Math.min(left, bx(node));
      right = Math.max(right, bx(node));
      top = Math.min(top, by(node));
      bottom = Math.max(bottom, by(node));
      largest = Math.max(largest, radii[node]!);
    }
    // With room for the nodes' circles and links' strokes around them.
    const pad = Math.max(largest, WIDTH_RANGE[1] / 2 + 2) + REACH;
    [left, top, right, bottom] = [left - pad, top - pad, right + pad, bottom + pad];
    const indexed = {
      x: Math.max(left, bounds.x - 2 * bounds.width),
      y: Math.max(top, bounds.y - 2 * bounds.height),
      width: 0,
      height: 0,
    };
    indexed.width = Math.min(right, bounds.x + 3 * bounds.width) - indexed.x;
    indexed.height = Math.min(bottom, bounds.y + 3 * bounds.height) - indexed.y;
    // Nodes and links reaching beyond that (moved there, or bowing or
    // bending out) are looked through one by one.
    const beyond = (left: number, top: number, right: number, bottom: number) =>
      left < indexed.x ||
      right > indexed.x + indexed.width ||
      top < indexed.y ||
      bottom > indexed.y + indexed.height;
    // Picking candidates depend on positions and widths, not highlight order;
    // each facet panel's on its links.
    const pickKey = JSON.stringify([
      placement.key,
      rows && idOf(rows),
      fitted ? null : frame.viewport,
      [...hidden],
      [...(moved ?? [])],
    ]);
    // Only the latest: grids of 200,000 links take tens of megabytes.
    const owner = rows ?? places;
    let latest = this.#picking.get(owner);
    if (latest?.places !== places || latest.key !== pickKey) {
      latest = { places, key: pickKey, picking: {} };
      this.#picking.set(owner, latest);
    }
    const picking = latest.picking;
    const kept = picking;
    const farNodes = () =>
      (kept.farNodes ??= nodes.filter((node) => {
        const far = radii[node]! + REACH;
        return beyond(bx(node) - far, by(node) - far, bx(node) + far, by(node) + far);
      }));
    // How far from its route's chords a link can be picked.
    const reachOf = (link: number, r: Route) => {
      const reach = widthOf(link) / 2 + REACH;
      // A curve's chords drawn at another zoom differ a little.
      if (r.path) return reach + 2;
      // A bow drawn zoomed lies between its chord and the bow fitted here,
      // never farther from the chord than half the bow's offset.
      return r.bow
        ? reach + Math.hypot(r.cx - (r.x0 + r.x1) / 2, r.cy - (r.y0 + r.y1) / 2) / 2
        : reach;
    };
    const farLinks = () =>
      (kept.farLinks ??= links.flatMap((link, i) => {
        const r = baseRoute(link);
        const reach = reachOf(link, r);
        let [left, right] = [Math.min(r.x0, r.x1), Math.max(r.x0, r.x1)];
        let [top, bottom] = [Math.min(r.y0, r.y1), Math.max(r.y0, r.y1)];
        for (let k = 0; r.path && k < r.path.length; k += 2) {
          [left, right] = [Math.min(left, r.path[k]!), Math.max(right, r.path[k]!)];
          [top, bottom] = [Math.min(top, r.path[k + 1]!), Math.max(bottom, r.path[k + 1]!)];
        }
        return beyond(left - reach, top - reach, right + reach, bottom + reach) ? [i] : [];
      }));
    return {
      geometry,
      plane,
      itemAt(px, py) {
        if (
          !(
            px >= bounds.x &&
            px <= bounds.x + bounds.width &&
            py >= bounds.y &&
            py <= bounds.y + bounds.height
          )
        )
          return undefined;
        picking.nodes ??= new HitGrid(indexed, (grid, add) => {
          for (const node of nodes) {
            const far = radii[node]! + REACH;
            grid.box(node, bx(node) - far, by(node) - far, bx(node) + far, by(node) + far, add);
          }
        });
        const [qx, qy] = toBase(px, py);
        // The node drawn on top of those under the pointer, else the one
        // whose edge is nearest, within reach.
        let top = -1;
        let best = -1;
        let bestGap = REACH;
        const nearNode = (node: number) => {
          const gap = Math.hypot(px - x(node), py - y(node)) - radii[node]!;
          if (gap <= 0) {
            if (top < 0 || drawnAbove(node, top)) top = node;
          } else if (gap < bestGap || (gap === bestGap && node > best)) {
            best = node;
            bestGap = gap;
          }
        };
        for (const node of picking.nodes.at(qx, qy)) nearNode(node);
        for (const node of farNodes()) nearNode(node);
        if (top >= 0) return nodeItem(top);
        if (best >= 0) return nodeItem(best);
        // Else the link nearest the pointer, within reach of its edge; of
        // links as near (those whose stroke it is on), the one drawn on top.
        let nearest = -1;
        let nearestGap = 0;
        picking.links ??= new HitGrid(indexed, (grid, add) => {
          links.forEach((link, i) => {
            const r = baseRoute(link);
            const reach = reachOf(link, r);
            const path = r.path;
            if (!path) grid.segment(i, r.x0, r.y0, r.x1, r.y1, reach, add);
            for (let k = 2; path && k < path.length; k += 2)
              grid.segment(i, path[k - 2]!, path[k - 1]!, path[k]!, path[k + 1]!, reach, add);
          });
        });
        const nearLink = (i: number) => {
          const link = links[i]!;
          const gap = Math.max(0, route(link).distance(px, py) - widthOf(link) / 2);
          if (gap > REACH) return;
          if (nearest < 0 || gap < nearestGap || (gap === nearestGap && linkAbove(i, nearest))) {
            nearest = i;
            nearestGap = gap;
          }
        };
        for (const i of picking.links.at(qx, qy)) nearLink(i);
        for (const i of farLinks()) nearLink(i);
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
        const place = placeOfLink(linkOfKey(parts));
        return place < 0 ? -1 : nodes.length + place;
      },
      summary: () => this.#summary(network, nodes, links, degree, locale, places),
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
        // In a facet panel, its rows only.
        const out: number[] = [];
        for (const row of rows ?? network.linkOfRow.keys())
          if (network.linkOfRow[row] === link) out.push(row);
        return out;
      },
      lassoed: (polygon, table) => {
        if (table !== this.nodes) return undefined;
        const held = new Uint8Array(count);
        for (const node of nodes) {
          const px = x(node),
            py = y(node);
          if (
            px >= bounds.x &&
            px <= bounds.x + bounds.width &&
            py >= bounds.y &&
            py <= bounds.y + bounds.height &&
            insidePolygon(polygon, px, py)
          )
            held[node] = 1;
        }
        const { codes, dictionary } = table.categories(this.spec.node!);
        const nodeOfCode = Int32Array.from(dictionary, (name) => network.nodeOf.get(name) ?? -1);
        const rows: number[] = [];
        for (let row = 0; row < codes.length; row++)
          if (codes[row]! >= 0 && held[nodeOfCode[codes[row]!]!]) rows.push(row);
        return rows;
      },
      moves,
      pending: places.pending,
    };
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

  /** Per link, whether any of its rows (of `rows`, in a facet panel) the highlighted selection holds. */
  #litLinks(
    network: Network,
    selected: LayoutFrame["selected"],
    rows: Uint32Array | undefined,
  ): Uint8Array | undefined {
    const membership = selected?.(this.table);
    if (!membership) return undefined;
    const lit = new Uint8Array(network.source.length);
    for (const row of rows ?? network.linkOfRow.keys()) {
      const link = network.linkOfRow[row]!;
      if (link >= 0 && membership[row]) lit[link] = 1;
    }
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
      // Nodes all alike stay in order.
      const alike = part.every((node) => radii[node] === radii[part[0]!]);
      const stacked = alike ? part : [...part].sort((a, b) => radii[b]! - radii[a]! || a - b);
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
    leftward: (node: number) => boolean,
  ): Geometry[] {
    const { bounds, theme, measure } = frame;
    const font = `${theme.fontSize}px ${theme.font}`;
    const lineHeight = Math.round(theme.fontSize * 1.25);
    const rank = network.size ?? degree;
    // Denser networks label fewer nodes: all of 50, 35 of 100, 11 of 1,000.
    const budget = Math.round(LABELED * Math.min(1, Math.sqrt(LABELED / nodes.length)));
    const candidates = top(nodes, budget, (a, b) => (rank[b]! || 0) - (rank[a]! || 0) || a - b);
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
      if (x < bounds.x || x > right) continue;
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
      const fits = {
        start: after + width <= right && free(node, after, top, after + width, bottom),
        end: before - width >= bounds.x && free(node, before - width, top, before, bottom),
      };
      const [first, second] = leftward(node)
        ? (["end", "start"] as const)
        : (["start", "end"] as const);
      const anchor = fits[first] ? first : fits[second] ? second : undefined;
      if (!anchor) continue;
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
            halo: labelHalo(this.spec.halo, theme.text, frame),
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
    const candidates = top(named, budget, (a, b) => network.value[b]! - network.value[a]! || a - b);
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
        halo: labelHalo(this.spec.halo, theme.text, frame),
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
    places: NodePositions,
  ): string {
    const { names, loops, overflowed } = network;
    let left = "";
    if (places.reversed > 0)
      left += ` ${plural(places.reversed, "link closes a cycle and runs", "links close cycles and run")} against the layers.`;
    if (places.arranging) left += " The nodes are still being arranged.";
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
 * The way a link runs from (x0, y0) to (x1, y1): straight, bowed to its
 * right through a quadratic curve's control point (cx, cy), or along a
 * curve through bend points, flattened into `path`.
 */
interface Route {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  bow: boolean;
  cx: number;
  cy: number;
  /** For a curve through bend points: x, y of the points of its polyline, ends included. */
  path?: Float64Array | undefined;
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

/**
 * The way of a link of a layered layout through its points (ends and bend
 * points, x, y each): a curve leaving and reaching each point along the
 * layers' direction (`vertical`, or across), as tidy trees draw links,
 * flattened into a polyline of a few chords per span, more for longer ones;
 * with `curved` false, one straight chord per span.
 */
function pathRoute(points: readonly number[], vertical: boolean, curved: boolean): Route {
  const path: number[] = [points[0]!, points[1]!];
  for (let i = 2; i < points.length; i += 2) {
    const [ax, ay, bx, by] = [points[i - 2]!, points[i - 1]!, points[i]!, points[i + 1]!];
    const pieces = curved
      ? Math.min(8, Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / 10)))
      : 1;
    for (let k = 1; k <= pieces; k++) {
      const t = k / pieces;
      // Across the layers, the curve eases out of one point and into the next.
      const b = 3 * t * t - 2 * t * t * t;
      path.push(
        vertical ? ax + (bx - ax) * b : ax + (bx - ax) * t,
        vertical ? ay + (by - ay) * t : ay + (by - ay) * b,
      );
    }
  }
  const line = Float64Array.from(path);
  const n = line.length / 2;
  const [x0, y0, x1, y1] = [line[0]!, line[1]!, line[n * 2 - 2]!, line[n * 2 - 1]!];
  const direction = (): [number, number] => {
    // The last chord with any length.
    for (let i = n - 2; i >= 0; i--) {
      const dx = x1 - line[i * 2]!;
      const dy = y1 - line[i * 2 + 1]!;
      const d = Math.hypot(dx, dy);
      if (d > 0) return [dx / d, dy / d];
    }
    return [1, 0];
  };
  return {
    x0,
    y0,
    x1,
    y1,
    bow: false,
    cx: (x0 + x1) / 2,
    cy: (y0 + y1) / 2,
    path: line,
    pointBack(back) {
      if (back <= 0) return [x1, y1];
      const [ux, uy] = direction();
      return [x1 - ux * back, y1 - uy * back];
    },
    direction,
    middle() {
      // Halfway along the polyline.
      let total = 0;
      for (let i = 1; i < n; i++)
        total += Math.hypot(line[i * 2]! - line[i * 2 - 2]!, line[i * 2 + 1]! - line[i * 2 - 1]!);
      let left = total / 2;
      for (let i = 1; i < n; i++) {
        const [ax, ay, bx, by] = [
          line[i * 2 - 2]!,
          line[i * 2 - 1]!,
          line[i * 2]!,
          line[i * 2 + 1]!,
        ];
        const d = Math.hypot(bx - ax, by - ay);
        if (d >= left && d > 0) return [ax + ((bx - ax) * left) / d, ay + ((by - ay) * left) / d];
        left -= d;
      }
      return [x1, y1];
    },
    distance(px, py) {
      let best = Number.POSITIVE_INFINITY;
      for (let i = 1; i < n; i++)
        best = Math.min(
          best,
          distanceToSegment(
            px,
            py,
            line[i * 2 - 2]!,
            line[i * 2 - 1]!,
            line[i * 2]!,
            line[i * 2 + 1]!,
          ),
        );
      return best;
    },
  };
}

/** SVG path data along a route, to outline a link. */
function routePath(r: Route, half: number): string {
  if (r.bow) return `M${n(r.x0)} ${n(r.y0)}Q${n(r.cx)} ${n(r.cy)} ${n(r.x1)} ${n(r.y1)}`;
  if (!r.path) return band(r.x0, r.y0, r.x1, r.y1, half);
  let d = "";
  for (let i = 0; i < r.path.length; i += 2)
    d += `${i ? "L" : "M"}${n(r.path[i]!)} ${n(r.path[i + 1]!)}`;
  return d;
}

/** The legend key and color key of a group; `undefined` for nodes of a network without groups. */
function groupKey(id: string | number, group: string | undefined): string {
  // An object, so no node's or link's key (arrays) can be the same.
  return JSON.stringify({ mark: id, group });
}

/** "network of 3 nodes and 2 links", "network of 50,001 nodes and 1 link". */
function describeNetwork({ names, source }: Network): string {
  const count = (n: number, one: string, many: string) =>
    `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
  return `network of ${count(names.length, "node", "nodes")} and ${count(source.length, "link", "links")}`;
}

/** Why a network is too large to lay out, without a final period; undefined when it is not. */
function overLimit(network: Network): string | undefined {
  if (network.names.length <= MAX_NODES && network.source.length <= MAX_LINKS) return undefined;
  const most = `${MAX_NODES.toLocaleString("en-US")} nodes and ${MAX_LINKS.toLocaleString("en-US")} links`;
  return `N${describeNetwork(network).slice(1)}: too many to lay out (a network draws at most ${most})`;
}

/** The options of each layout, and what each option says when given to another. */
const LAYOUT_OPTIONS = {
  settle: { type: "force", does: "settles" },
  sort: { type: "circular", does: "sorts" },
  direction: { type: "layered", does: "has a direction" },
} as const;

/** A network's layout with its options filled in; throws for a layout or option it does not have. */
function layoutOf(layout: GraphLayout | undefined): NetworkLayout {
  const given: Record<string, unknown> =
    typeof layout === "string" ? { type: layout } : { type: "force", ...layout };
  const { type } = given;
  if (type !== "force" && type !== "circular" && type !== "layered")
    throw new Error(
      `graph layout: expected "force", "circular", or "layered"; received ${JSON.stringify(type)}`,
    );
  for (const key of Object.keys(given)) {
    if (key === "type" || given[key] === undefined) continue;
    const option = LAYOUT_OPTIONS[key as keyof typeof LAYOUT_OPTIONS];
    if (!option)
      throw new Error(`graph layout.${key}: not an option of a ${type} layout; drop ${key}`);
    if (option.type !== type)
      throw new Error(
        `graph layout.${key}: only a ${option.type} layout ${option.does}; drop ${key}, or use type "${option.type}"`,
      );
  }
  const choice = <T extends string>(key: string, values: readonly T[], fallback: T): T => {
    const value = given[key] ?? fallback;
    if (!values.includes(value as T))
      throw new Error(
        `graph layout.${key}: expected ${values
          .map((v) => JSON.stringify(v))
          .join(", ")
          .replace(/, ([^,]*)$/, ", or $1")}; received ${JSON.stringify(value)}`,
      );
    return value as T;
  };
  if (type === "circular")
    return { type, sort: choice("sort", ["degree", "input", "name"] as const, "degree") };
  if (type === "layered")
    return {
      type,
      direction: choice("direction", ["down", "right", "up", "left"] as const, "down"),
    };
  if (given.settle !== undefined && typeof given.settle !== "boolean")
    throw new Error(
      `graph layout.settle: expected true or false; received ${JSON.stringify(given.settle)}`,
    );
  return { type, settle: given.settle !== false };
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

/** The first `count` of `items` in the order `compare` gives, without sorting them all. */
function top(
  items: readonly number[],
  count: number,
  compare: (a: number, b: number) => number,
): number[] {
  if (items.length <= count * 4) return [...items].sort(compare).slice(0, count);
  const kept: number[] = [];
  for (const item of items) {
    if (kept.length === count && compare(item, kept[count - 1]!) >= 0) continue;
    // Insertion into the few kept so far.
    let at = Math.min(kept.length, count - 1);
    kept[at] = item;
    while (at > 0 && compare(kept[at]!, kept[at - 1]!) < 0) {
      [kept[at], kept[at - 1]] = [kept[at - 1]!, kept[at]!];
      at--;
    }
  }
  return kept;
}

/** "1 link", "2 links". */
function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * A network of nodes joined by links, placed by a force simulation: a row
 * per link between the nodes named in `source` and `target`, and, with
 * `nodes`, a table naming each node in `node`, with its `color` and `size`.
 *
 * ```ts
 * graph(friendships, { source: "a", target: "b", nodes: people, node: "name", color: "team" })
 * ```
 */
export function graph<S extends Schema, N extends Schema = Schema>(
  links: Table<S>,
  options: GraphOptions<S, N>,
): ChartMark<Frozen<GraphSpec>> {
  const spec: GraphSpec = { type: "graph", source: options.source, target: options.target };
  if (options.value !== undefined) spec.value = options.value;
  if (options.directed !== undefined) spec.directed = options.directed;
  if (options.linkLabelField !== undefined) spec.linkLabelField = options.linkLabelField;
  if (options.nodes !== undefined) {
    if (options.nodes.name !== undefined) spec.nodes = options.nodes.name;
    spec.node = options.node;
    if (options.color !== undefined) spec.color = options.color;
    if (options.size !== undefined) spec.size = options.size;
  }
  if (options.labels !== undefined) spec.labels = options.labels;
  if (options.halo !== undefined) spec.halo = options.halo;
  if (options.layout !== undefined) spec.layout = options.layout;
  if (options.id !== undefined) spec.id = options.id;
  if (options.panel !== undefined) spec.panel = options.panel;
  if (links.name !== undefined) spec.data = links.name;
  // Field names were checked against S and N above; marks work on the erased schemas.
  const mark = new GraphMark(spec, links as unknown as Table, options.nodes as unknown as Table);
  // Too large a network is a mistake when written. Marks loaded from specs
  // (a live chart's snapshot after rows streamed in, say) draw nothing and
  // say why instead, as growth while drawn does, so later changes can bring
  // the picture back.
  const refused = mark.overLimit();
  if (refused) throw new Error(`graph: ${refused}; filter or aggregate the links first`);
  return mark;
}
