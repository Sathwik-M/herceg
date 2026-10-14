// Layered layout, after Sugiyama, Tagawa, and Toda (1981): constraints point
// from a layer to a later one, as a tree's parent stands above its
// children. Cycles are broken by turning the back edges of a depth-first
// search around (only for placing; links keep their direction). Each node's
// layer is its longest path from a node without constraints into it, and
// nodes without constraints into them move down next to their nearest
// successor. Links spanning layers pass through a bend point in each layer
// between. Within layers, sweeps down and up sort nodes and bends by the
// barycenter of their neighbors in the layer before, keeping the order with
// the fewest crossings, counted as Barth, Jünger, and Mutzel do (2004).
// Coordinates follow: passes move each node toward its neighbors' mean,
// then the least-squares positions keeping the order and the gaps between
// nodes (pool adjacent violators). Connected components stand side by side.
// Ties break by node index, so the layout is deterministic.

import { type Adjacency, componentsOf } from "./components.ts";
import { LINK_DISTANCE } from "./force.ts";

/** Which way layers follow one another. */
export type LayerDirection = "down" | "right" | "up" | "left";

/** What a layered layout places. */
export interface LayeredGraph {
  /** How many nodes there are, numbered from 0. */
  nodes: number;
  /** Constraints: node `from[i]` stands in a layer before node `to[i]`'s. */
  from: Int32Array;
  to: Int32Array;
  /** The links to route, by their two ends; their route runs from source to target. */
  source: Int32Array;
  target: Int32Array;
}

/** Where a layered layout puts nodes and links, in layout units. */
export interface Layered {
  /** x, y per node. */
  positions: Float64Array;
  /**
   * Per link, its bend points from its source's end to its target's: those
   * of link `i` are x, y pairs `bends[2 * starts[i]]` up to `bends[2 * starts[i + 1]]`.
   */
  starts: Int32Array;
  bends: Float64Array;
  /** Constraints that point against the layers, closing cycles. */
  reversed: number;
}

/** Distance between consecutive layers. */
export const LAYER_GAP = 1.5 * LINK_DISTANCE;
/** Least distance between nodes in a layer, and between bend points. */
const NODE_GAP = LINK_DISTANCE;
const BEND_GAP = LINK_DISTANCE / 2;
/** Between components standing side by side. */
const COMPONENT_GAP = LINK_DISTANCE * 2;
/** Down-and-up pairs of crossing-reduction sweeps, and coordinate passes. */
const SWEEPS = 4;
const PASSES = 8;
/** Bend points a layout may make; more mean links spanning too many layers to route. */
export const MAX_BENDS = 500_000;
/** Vertices sorted or placed between pauses. */
const STEP = 16_384;

/** `layeredSteps` run to the end. */
export function layoutLayered(
  graph: LayeredGraph,
  direction: LayerDirection = "down",
  previous?: Float64Array,
): Layered {
  const steps = layeredSteps(graph, direction, previous);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

/**
 * A layered layout in steps, yielding between them so a large network's
 * layout can spread over frames. With `previous` (x, y per node, NaN for
 * none), nodes start in the order those positions give them across their
 * layer, so a layout of changed data keeps its nodes' order where it can.
 * Throws when links would need more than `MAX_BENDS` bend points.
 */
export function* layeredSteps(
  graph: LayeredGraph,
  direction: LayerDirection = "down",
  previous?: Float64Array,
): Generator<void, Layered> {
  const n = graph.nodes;
  const { forward, reversed } = acyclic(graph);
  yield;
  const rank = ranks(n, forward);
  yield;
  // Links each run from their upper end down through a bend point per layer between.
  const links = graph.source.length;
  let bends = 0;
  for (let link = 0; link < links; link++)
    bends += Math.max(0, Math.abs(rank[graph.target[link]!]! - rank[graph.source[link]!]!) - 1);
  if (bends > MAX_BENDS)
    throw new RangeError(
      `${bends.toLocaleString("en-US")} bend points, more than the ${MAX_BENDS.toLocaleString("en-US")} a layered layout routes`,
    );
  const positions = new Float64Array(n * 2);
  const starts = new Int32Array(links + 1);
  for (let link = 0; link < links; link++)
    starts[link + 1] =
      starts[link]! +
      Math.max(0, Math.abs(rank[graph.target[link]!]! - rank[graph.source[link]!]!) - 1);
  const points = new Float64Array(bends * 2);
  // Components side by side, each laid out alone.
  const components = componentsOf(n, linkAdjacency(n, graph.source, graph.target));
  // Components in the order of their lowest node (each lists it first), so the data's first comes first.
  components.sort((a, b) => a[0]! - b[0]!);
  // Each component's links, by the component of their source.
  const componentOf = new Int32Array(n);
  components.forEach((members, c) => {
    for (const node of members) componentOf[node] = c;
  });
  const linksOf: number[][] = components.map(() => []);
  for (let link = 0; link < links; link++) linksOf[componentOf[graph.source[link]!]!]!.push(link);
  // Each node's number within its component, shared by all of them.
  const local = new Int32Array(n);
  let offset = 0;
  for (const [c, members] of components.entries()) {
    const width = yield* placeComponent(
      graph,
      members,
      linksOf[c]!,
      local,
      rank,
      previous,
      direction,
      offset,
      { positions, starts, points },
    );
    offset += width + COMPONENT_GAP;
  }
  // Centered on (0, 0) across, as the other layouts are roughly.
  const shift = (offset - COMPONENT_GAP) / 2;
  const across = direction === "down" || direction === "up" ? 0 : 1;
  for (let i = 0; i < n; i++) positions[i * 2 + across]! -= shift;
  for (let i = 0; i < bends; i++) points[i * 2 + across]! -= shift;
  return { positions, starts, bends: points, reversed };
}

/** Undirected adjacency of links. */
function linkAdjacency(n: number, source: Int32Array, target: Int32Array): Adjacency {
  const starts = new Int32Array(n + 1);
  for (let link = 0; link < source.length; link++) {
    starts[source[link]! + 1]!++;
    starts[target[link]! + 1]!++;
  }
  for (let i = 0; i < n; i++) starts[i + 1]! += starts[i]!;
  const neighbors = new Int32Array(starts[n]!);
  const fill = starts.slice(0, n);
  for (let link = 0; link < source.length; link++) {
    neighbors[fill[source[link]!]!++] = target[link]!;
    neighbors[fill[target[link]!]!++] = source[link]!;
  }
  return { starts, neighbors };
}

/** Directed edges in compressed rows. */
interface Edges {
  starts: Int32Array;
  next: Int32Array;
}

function rowsOf(n: number, from: ArrayLike<number>, to: ArrayLike<number>): Edges {
  const starts = new Int32Array(n + 1);
  for (let i = 0; i < from.length; i++) starts[from[i]! + 1]!++;
  for (let v = 0; v < n; v++) starts[v + 1]! += starts[v]!;
  const next = new Int32Array(from.length);
  const fill = starts.slice(0, n);
  for (let i = 0; i < from.length; i++) next[fill[from[i]!]!++] = to[i]!;
  return { starts, next };
}

/**
 * The constraints without cycles: each distinct pair once, those a
 * depth-first search finds pointing back up its path turned around.
 * Searches start from nodes without constraints into them, then from the
 * rest, by index.
 */
function acyclic(graph: LayeredGraph): { forward: Edges; reversed: number } {
  const n = graph.nodes;
  const seen = new Set<number>();
  const from: number[] = [];
  const to: number[] = [];
  for (let i = 0; i < graph.from.length; i++) {
    const [u, v] = [graph.from[i]!, graph.to[i]!];
    if (u === v || seen.has(u * n + v)) continue;
    seen.add(u * n + v);
    from.push(u);
    to.push(v);
  }
  const out = rowsOf(n, from, to);
  const into = new Int32Array(n);
  for (const v of to) into[v]!++;
  // 0 unvisited, 1 on the search's path, 2 finished.
  const state = new Uint8Array(n);
  const back = new Set<number>();
  const stack = new Int32Array(n);
  const edge = new Int32Array(n);
  const roots: number[] = [];
  for (let v = 0; v < n; v++) if (into[v] === 0) roots.push(v);
  for (let v = 0; v < n; v++) if (into[v] !== 0) roots.push(v);
  for (const root of roots) {
    if (state[root]) continue;
    let top = 0;
    stack[0] = root;
    edge[0] = out.starts[root]!;
    state[root] = 1;
    while (top >= 0) {
      const u = stack[top]!;
      if (edge[top]! < out.starts[u + 1]!) {
        const v = out.next[edge[top]!]!;
        if (state[v] === 1) back.add(u * n + v);
        else if (state[v] === 0) {
          edge[top]!++;
          top++;
          stack[top] = v;
          edge[top] = out.starts[v]!;
          state[v] = 1;
          continue;
        }
        edge[top]!++;
      } else {
        state[u] = 2;
        top--;
      }
    }
  }
  const forwardFrom: number[] = [];
  const forwardTo: number[] = [];
  const turned = new Set<number>();
  for (let i = 0; i < from.length; i++) {
    let [u, v] = [from[i]!, to[i]!];
    if (back.has(u * n + v)) [u, v] = [v, u];
    // A pair both ways becomes one constraint.
    if (turned.has(u * n + v)) continue;
    turned.add(u * n + v);
    forwardFrom.push(u);
    forwardTo.push(v);
  }
  return { forward: rowsOf(n, forwardFrom, forwardTo), reversed: back.size };
}

/**
 * Each node's layer: its longest path from a node without constraints into
 * it; then such nodes move down to just above their nearest successor.
 */
function ranks(n: number, forward: Edges): Int32Array {
  const into = new Int32Array(n);
  for (const v of forward.next) into[v]!++;
  const order = new Int32Array(n);
  let end = 0;
  for (let v = 0; v < n; v++) if (into[v] === 0) order[end++] = v;
  const rank = new Int32Array(n);
  const left = into.slice();
  for (let at = 0; at < end; at++) {
    const u = order[at]!;
    for (let k = forward.starts[u]!; k < forward.starts[u + 1]!; k++) {
      const v = forward.next[k]!;
      rank[v] = Math.max(rank[v]!, rank[u]! + 1);
      if (--left[v]! === 0) order[end++] = v;
    }
  }
  for (let at = end - 1; at >= 0; at--) {
    const u = order[at]!;
    if (into[u] !== 0 || forward.starts[u] === forward.starts[u + 1]) continue;
    let nearest = Number.POSITIVE_INFINITY;
    for (let k = forward.starts[u]!; k < forward.starts[u + 1]!; k++)
      nearest = Math.min(nearest, rank[forward.next[k]!]!);
    rank[u] = nearest - 1;
  }
  return rank;
}

/** Where a component's layout is written. */
interface Out {
  positions: Float64Array;
  starts: Int32Array;
  points: Float64Array;
}

/**
 * Lays out one component across from `offset` and returns how wide it is.
 * Its nodes and bend points are numbered locally: members first, then the
 * bends of each of its links in turn, from the upper end down.
 */
function* placeComponent(
  graph: LayeredGraph,
  members: Int32Array,
  links: readonly number[],
  local: Int32Array,
  rank: Int32Array,
  previous: Float64Array | undefined,
  direction: LayerDirection,
  offset: number,
  out: Out,
): Generator<void, number> {
  members.forEach((node, i) => {
    local[node] = i;
  });
  let low = Number.POSITIVE_INFINITY;
  for (const node of members) low = Math.min(low, rank[node]!);
  // Every vertex of the layered graph: its layer, and for bends, the link and step.
  const layer: number[] = Array.from(members, (node) => rank[node]! - low);
  const isBend: boolean[] = Array.from(members, () => false);
  const bendOf: { link: number; step: number }[] = [];
  const up: number[][] = Array.from(members, () => []);
  const down: number[][] = Array.from(members, () => []);
  // Links and bend points made since the last pause: one link may make many.
  let made = 0;
  for (const link of links) {
    if (++made > STEP) {
      made = 0;
      yield;
    }
    const s = local[graph.source[link]!]!;
    const t = local[graph.target[link]!]!;
    const [a, b] = layer[s]! <= layer[t]! ? [s, t] : [t, s];
    // Ends in one layer (links without a constraint between them) stand apart.
    if (layer[a] === layer[b]) continue;
    let above = a;
    for (let r = layer[a]! + 1; r < layer[b]!; r++) {
      if (++made > STEP) {
        made = 0;
        yield;
      }
      const bend = layer.length;
      layer.push(r);
      isBend.push(true);
      bendOf[bend] = { link, step: r - layer[a]! - 1 };
      up.push([above]);
      down.push([]);
      down[above]!.push(bend);
      above = bend;
    }
    down[above]!.push(b);
    up[b]!.push(above);
  }
  const count = layer.length;
  let layers = 0;
  for (const r of layer) layers = Math.max(layers, r + 1);
  yield;
  // Starting order: as `previous` puts surviving nodes across, others after
  // the neighbors above them; without it, a depth-first search's order.
  const key = new Float64Array(count);
  const across = direction === "down" || direction === "up" ? 0 : 1;
  const visit = depthFirst(count, layer, up, down);
  for (let v = 0; v < count; v++) key[v] = visit[v]!;
  yield;
  if (previous) {
    const known = new Float64Array(count).fill(Number.NaN);
    for (let i = 0; i < members.length; i++) known[i] = previous[members[i]! * 2 + across]!;
    // Vertices without a previous place take their upper neighbors' mean,
    // layer by layer; those still without one go after the others.
    let last = Number.NEGATIVE_INFINITY;
    for (const v of known) if (v > last) last = v;
    for (const row of verticesByLayer(count, layers, layer, key))
      for (const v of row) {
        if (Number.isFinite(known[v]!)) continue;
        let sum = 0;
        let seen = 0;
        for (const u of up[v]!)
          if (Number.isFinite(known[u]!)) {
            sum += known[u]!;
            seen++;
          }
        if (seen > 0) known[v] = sum / seen;
      }
    if (Number.isFinite(last))
      for (let v = 0; v < count; v++)
        key[v] = Number.isFinite(known[v]!) ? known[v]! : last + 1 + visit[v]!;
  }
  const order = verticesByLayer(count, layers, layer, key);
  const position = new Float64Array(count);
  const place = () => {
    for (const row of order)
      row.forEach((v, i) => {
        position[v] = i;
      });
  };
  place();
  yield;
  // Crossing reduction: keep the best order the sweeps find.
  let best = order.map((row) => row.slice());
  let fewest = yield* crossings(order, down, position);
  let work = 0;
  for (let sweep = 0; sweep < SWEEPS * 2 && fewest > 0; sweep++) {
    const downward = sweep % 2 === 0;
    for (let k = 1; k < layers; k++) {
      work += order[downward ? k : layers - 1 - k]!.length;
      if (work > STEP) {
        work = 0;
        yield;
      }
      const r = downward ? k : layers - 1 - k;
      const row = order[r]!;
      const near = downward ? up : down;
      for (const v of row) {
        const neighbors = near[v]!;
        if (neighbors.length === 0) {
          key[v] = position[v]!;
          continue;
        }
        let sum = 0;
        for (const u of neighbors) sum += position[u]!;
        key[v] = sum / neighbors.length;
      }
      row.sort((a, b) => key[a]! - key[b]! || position[a]! - position[b]!);
      row.forEach((v, i) => {
        position[v] = i;
      });
    }
    const now = yield* crossings(order, down, position);
    if (now < fewest) {
      fewest = now;
      best = order.map((row) => row.slice());
    }
    yield;
  }
  for (let r = 0; r < layers; r++) order[r] = best[r]!;
  place();
  // Coordinates: packed in order, then moved toward neighbors' means.
  const x = new Float64Array(count);
  const gapOf = (v: number) => (isBend[v] ? BEND_GAP : NODE_GAP);
  for (const row of order) {
    let at = 0;
    row.forEach((v, i) => {
      if (i > 0) at += (gapOf(row[i - 1]!) + gapOf(v)) / 2;
      x[v] = at;
    });
  }
  for (let pass = 0; pass < PASSES; pass++) {
    const downward = pass % 2 === 0;
    for (let k = 0; k < layers; k++) {
      const r = downward ? k : layers - 1 - k;
      const row = order[r]!;
      work += row.length;
      if (work > STEP) {
        work = 0;
        yield;
      }
      // Each node pulled by as many neighbors as it has on that side; one
      // without any barely pulls, so it gives way to those that do.
      const wanted = new Float64Array(row.length);
      const weight = new Float64Array(row.length);
      row.forEach((v, i) => {
        const near = pass >= PASSES - 2 ? [...up[v]!, ...down[v]!] : downward ? up[v]! : down[v]!;
        if (near.length === 0) {
          wanted[i] = x[v]!;
          weight[i] = 1e-3;
          return;
        }
        // Centered over the span of its neighbors, as a tidy tree centers a parent over its children.
        let lo = Number.POSITIVE_INFINITY;
        let hi = Number.NEGATIVE_INFINITY;
        for (const u of near) {
          lo = Math.min(lo, x[u]!);
          hi = Math.max(hi, x[u]!);
        }
        wanted[i] = (lo + hi) / 2;
        weight[i] = near.length;
      });
      const gaps = row.map((v, i) => (i === 0 ? 0 : (gapOf(row[i - 1]!) + gapOf(v)) / 2));
      const placed = keepOrder(wanted, weight, gaps);
      row.forEach((v, i) => {
        x[v] = placed[i]!;
      });
    }
    yield;
  }
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  for (let v = 0; v < count; v++) {
    left = Math.min(left, x[v]!);
    right = Math.max(right, x[v]!);
  }
  const toPlane = (v: number): [number, number] => {
    const a = x[v]! - left + offset;
    const b = layer[v]! * LAYER_GAP;
    switch (direction) {
      case "down":
        return [a, b];
      case "up":
        return [a, -b];
      case "right":
        return [b, a];
      case "left":
        return [-b, a];
    }
  };
  members.forEach((node, i) => {
    [out.positions[node * 2], out.positions[node * 2 + 1]] = toPlane(i);
  });
  for (let v = members.length; v < count; v++) {
    const { link, step } = bendOf[v]!;
    // Bends run from the upper end down; a link whose source is below runs the other way.
    const s = local[graph.source[link]!]!;
    const t = local[graph.target[link]!]!;
    const span = out.starts[link + 1]! - out.starts[link]!;
    const at = out.starts[link]! + (layer[s]! <= layer[t]! ? step : span - 1 - step);
    [out.points[at * 2], out.points[at * 2 + 1]] = toPlane(v);
  }
  return right - left;
}

/** Vertices by layer, each layer sorted by `key`, then by vertex. */
function verticesByLayer(
  count: number,
  layers: number,
  layer: readonly number[],
  key: Float64Array,
): number[][] {
  const rows: number[][] = Array.from({ length: layers }, () => []);
  for (let v = 0; v < count; v++) rows[layer[v]!]!.push(v);
  for (const row of rows) row.sort((a, b) => key[a]! - key[b]! || a - b);
  return rows;
}

/** The order a depth-first search down the layers first reaches each vertex in, from those with nothing above. */
function depthFirst(
  count: number,
  layer: readonly number[],
  up: readonly number[][],
  down: readonly number[][],
): Int32Array {
  const visit = new Int32Array(count).fill(-1);
  let next = 0;
  const roots: number[] = [];
  for (let v = 0; v < count; v++) if (up[v]!.length === 0) roots.push(v);
  roots.sort((a, b) => layer[a]! - layer[b]! || a - b);
  const stack: number[] = [];
  for (const root of roots) {
    stack.push(root);
    while (stack.length > 0) {
      const v = stack.pop()!;
      if (visit[v]! >= 0) continue;
      visit[v] = next++;
      const below = down[v]!;
      for (let k = below.length - 1; k >= 0; k--) if (visit[below[k]!]! < 0) stack.push(below[k]!);
    }
  }
  for (let v = 0; v < count; v++) if (visit[v]! < 0) visit[v] = next++;
  return visit;
}

/**
 * Crossings between consecutive layers: inversions of edges' lower ends,
 * with a Fenwick tree, yielding between steps.
 */
function* crossings(
  order: number[][],
  down: readonly number[][],
  position: Float64Array,
): Generator<void, number> {
  let total = 0;
  let work = 0;
  for (let r = 0; r + 1 < order.length; r++) {
    work += order[r]!.length + order[r + 1]!.length;
    if (work > STEP) {
      work = 0;
      yield;
    }
    const lower = order[r + 1]!.length;
    const tree = new Int32Array(lower + 1);
    let seen = 0;
    for (const u of order[r]!) {
      const ends = down[u]!.map((v) => position[v]!).sort((a, b) => a - b);
      // Edges seen before with a lower end after this one's cross it.
      for (const end of ends) {
        let before = 0;
        for (let i = end + 1; i > 0; i -= i & -i) before += tree[i]!;
        total += seen - before;
      }
      for (const end of ends) {
        for (let i = end + 1; i <= lower; i += i & -i) tree[i]!++;
        seen++;
      }
    }
  }
  return total;
}

/**
 * The positions closest to `wanted` (least squares, by `weight`) that keep
 * their order with at least `gaps[i]` between positions i - 1 and i:
 * subtracting the gaps' running sum makes it isotonic regression, solved by
 * pooling adjacent violators.
 */
function keepOrder(
  wanted: Float64Array,
  weight: Float64Array,
  gaps: readonly number[],
): Float64Array {
  const n = wanted.length;
  const shift = new Float64Array(n);
  for (let i = 1; i < n; i++) shift[i] = shift[i - 1]! + gaps[i]!;
  // Blocks of pooled values: their weighted mean, weight, and size.
  const mean: number[] = [];
  const total: number[] = [];
  const size: number[] = [];
  for (let i = 0; i < n; i++) {
    mean.push(wanted[i]! - shift[i]!);
    total.push(weight[i]!);
    size.push(1);
    while (mean.length > 1 && mean[mean.length - 2]! > mean[mean.length - 1]!) {
      const b = mean.length - 1;
      const w = total[b - 1]! + total[b]!;
      mean[b - 1] = (mean[b - 1]! * total[b - 1]! + mean[b]! * total[b]!) / w;
      total[b - 1] = w;
      size[b - 1]! += size[b]!;
      mean.pop();
      total.pop();
      size.pop();
    }
  }
  const out = new Float64Array(n);
  let i = 0;
  for (let b = 0; b < mean.length; b++)
    for (let k = 0; k < size[b]!; k++, i++) out[i] = mean[b]! + shift[i]!;
  return out;
}
