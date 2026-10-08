// Sankey layout, after d3-sankey: nodes in columns by their longest path
// from a source, with sinks in the last column ("justify"); node heights in
// proportion to their flow on one scale for every column; vertical places
// relaxed toward the nodes each connects to, then pushed apart so nodes keep
// their padding. Everything is deterministic: ties go to the lower index.

/** Flows between nodes, by node index: one entry per link. */
export interface SankeyGraph {
  /** How many nodes the links refer to, numbered from 0. */
  nodes: number;
  source: Int32Array;
  target: Int32Array;
  value: Float64Array;
}

export interface SankeyLayoutOptions {
  /** Width of the node bars, in pixels. */
  nodeWidth: number;
  /** Space between nodes in a column, in pixels; less when a column has too many nodes for it. */
  nodePadding: number;
  /**
   * How nodes are ordered in their column: "auto" lets the relaxation order
   * them to reduce crossings, "input" keeps the order of their indices, and
   * "value" puts the largest first.
   */
  order: "auto" | "input" | "value";
  /** Relaxation passes; more settle nodes further at more cost. */
  iterations?: number;
}

/** What became of a link: drawn, left out for closing a cycle (or looping to its own node), or left out for having no positive, finite value. */
export const DRAWN = 0;
export const CYCLE = 1;
export const EMPTY = 2;

export interface SankeyLayout {
  /** How many columns have nodes. */
  columns: number;
  /** Per column: the left edge of its bars. */
  columnX: Float64Array;
  /** Width of the bars: as asked, or narrower when the columns have no room for it. */
  nodeWidth: number;
  /** Per node: its column, or -1 for a node without drawn links. */
  column: Int32Array;
  /** Per node: the sums of its drawn incoming and outgoing links. */
  inflow: Float64Array;
  outflow: Float64Array;
  /** Per node: x0, y0, x1, y1 of its bar; zeros for nodes not drawn. */
  boxes: Float64Array;
  /** The nodes drawn, column by column, top to bottom. */
  order: Int32Array;
  /** Per link: DRAWN, CYCLE, or EMPTY. */
  status: Uint8Array;
  /** Per drawn link: the top of its band at the source and at the target, and its thickness. */
  sourceY: Float64Array;
  targetY: Float64Array;
  thickness: Float64Array;
}

/** Relaxation passes, as in d3-sankey. */
const ITERATIONS = 6;

export function layoutSankey(
  graph: SankeyGraph,
  bounds: { x: number; y: number; width: number; height: number },
  options: SankeyLayoutOptions,
): SankeyLayout {
  const { nodes: n, source, target, value } = graph;
  const m = source.length;
  const status = new Uint8Array(m);
  for (let link = 0; link < m; link++) {
    const v = value[link]!;
    if (!(v > 0 && v < Number.POSITIVE_INFINITY)) status[link] = EMPTY;
    else if (source[link] === target[link]) status[link] = CYCLE;
  }
  breakCycles(n, source, target, status);

  // Links by node, in link order to start with.
  const outgoing: number[][] = Array.from({ length: n }, () => []);
  const incoming: number[][] = Array.from({ length: n }, () => []);
  const inflow = new Float64Array(n);
  const outflow = new Float64Array(n);
  let largest = 0;
  for (let link = 0; link < m; link++) {
    if (status[link] !== DRAWN) continue;
    outgoing[source[link]!]!.push(link);
    incoming[target[link]!]!.push(link);
    outflow[source[link]!]! += value[link]!;
    inflow[target[link]!]! += value[link]!;
    largest = Math.max(largest, value[link]!);
  }
  // Geometry works on values as fractions of the largest drawn link, so sums
  // of values near the largest double do not overflow, and links left out
  // do not change the scale.
  const weight = Float64Array.from(value, (v, link) => (status[link] === DRAWN ? v / largest : 0));
  const nodeWeight = new Float64Array(n);
  for (let node = 0; node < n; node++) {
    let into = 0;
    let out = 0;
    for (const link of incoming[node]!) into += weight[link]!;
    for (const link of outgoing[node]!) out += weight[link]!;
    nodeWeight[node] = Math.max(into, out);
  }

  const column = justifiedColumns(n, source, target, outgoing, incoming);
  let count = 0;
  for (let node = 0; node < n; node++) count = Math.max(count, column[node]! + 1);
  const columns: number[][] = Array.from({ length: count }, () => []);
  for (let node = 0; node < n; node++) if (column[node]! >= 0) columns[column[node]!]!.push(node);
  if (options.order === "value") {
    for (const nodes of columns) nodes.sort((a, b) => nodeWeight[b]! - nodeWeight[a]! || a - b);
  }

  // Bars span the width, the first column at the left edge and the last at the right.
  // Bars are no wider than the gaps between them.
  const nodeWidth =
    count > 0 ? Math.max(0, Math.min(options.nodeWidth, bounds.width / (2 * count - 1))) : 0;
  const step = count > 1 ? (bounds.width - nodeWidth) / (count - 1) : 0;
  const columnX = Float64Array.from({ length: count }, (_, c) => bounds.x + c * step);
  const top = new Float64Array(n);
  const size = new Float64Array(n);
  const thickness = new Float64Array(m);
  const y0 = bounds.y;
  const y1 = bounds.y + Math.max(0, bounds.height);
  // Padding gives way when a column has too many nodes for it: it takes at
  // most half the height.
  const longest = Math.max(0, ...columns.map((nodes) => nodes.length));
  const py =
    longest > 1
      ? Math.min(options.nodePadding, (0.5 * (y1 - y0)) / (longest - 1))
      : options.nodePadding;
  // One scale for every column: the one that fits the fullest.
  let ky = Number.POSITIVE_INFINITY;
  for (const nodes of columns) {
    let sum = 0;
    for (const node of nodes) sum += nodeWeight[node]!;
    if (sum > 0) ky = Math.min(ky, (y1 - y0 - (nodes.length - 1) * py) / sum);
  }
  if (!(ky > 0 && ky < Number.POSITIVE_INFINITY)) ky = 0;
  for (let link = 0; link < m; link++) thickness[link] = weight[link]! * ky;

  // Each column starts stacked from the top, its spare room spread evenly
  // between and around its nodes.
  for (const nodes of columns) {
    let y = y0;
    for (const node of nodes) {
      top[node] = y;
      size[node] = nodeWeight[node]! * ky;
      y += size[node]! + py;
    }
    const spare = (y1 - y + py) / (nodes.length + 1);
    nodes.forEach((node, i) => {
      top[node]! += spare * (i + 1);
    });
  }

  // Each node stacks its outgoing links in the order of their targets, and
  // its incoming links in the order of their sources. Per link: the
  // thickness above it in each stack, and how many links.
  const outAbove = new Float64Array(m);
  const inAbove = new Float64Array(m);
  const outRank = new Int32Array(m);
  const inRank = new Int32Array(m);
  const byTargetTop = (a: number, b: number) => top[target[a]!]! - top[target[b]!]! || a - b;
  const bySourceTop = (a: number, b: number) => top[source[a]!]! - top[source[b]!]! || a - b;
  const byTop = (a: number, b: number) => top[a]! - top[b]! || a - b;
  const stack = (links: number[], above: Float64Array, rank: Int32Array) => {
    let y = 0;
    links.forEach((link, i) => {
      above[link] = y;
      rank[link] = i;
      y += thickness[link]!;
    });
  };
  const sortOutgoing = (node: number) => {
    stack(outgoing[node]!.sort(byTargetTop), outAbove, outRank);
  };
  const sortIncoming = (node: number) => {
    stack(incoming[node]!.sort(bySourceTop), inAbove, inRank);
  };
  for (let node = 0; node < n; node++) {
    sortOutgoing(node);
    sortIncoming(node);
  }

  // Where a link's target (or source) would have its top for the link to
  // run level, with the stack at the other end spread by the padding.
  const targetTop = (link: number) => {
    const from = source[link]!;
    const spread = ((outgoing[from]!.length - 1) * py) / 2;
    return top[from]! - spread + outAbove[link]! + outRank[link]! * py - inAbove[link]!;
  };
  const sourceTop = (link: number) => {
    const to = target[link]!;
    const spread = ((incoming[to]!.length - 1) * py) / 2;
    return top[to]! - spread + inAbove[link]! + inRank[link]! * py - outAbove[link]!;
  };

  /**
   * Moves each node of a column `alpha` of the way toward the average of
   * the places its links would have it, weighting longer links more, then
   * pushes the column's nodes `beta` of the way apart. The stacks at the
   * nodes' other ends re-sort once the column has moved, not after each
   * node as in d3-sankey, which costs time quadratic in a hub's links.
   */
  const relax = (
    nodes: number[],
    links: number[][],
    ideal: (link: number) => number,
    alpha: number,
    beta: number,
  ) => {
    for (const node of nodes) {
      let sum = 0;
      let weights = 0;
      for (const link of links[node]!) {
        const w = weight[link]! * (column[target[link]!]! - column[source[link]!]!);
        sum += ideal(link) * w;
        weights += w;
      }
      if (!(weights > 0)) continue;
      top[node]! += (sum / weights - top[node]!) * alpha;
    }
    if (options.order === "auto") nodes.sort(byTop);
    resolveCollisions(nodes, top, size, py, y0, y1, beta);
    const sources = new Set<number>();
    const targets = new Set<number>();
    for (const node of nodes) {
      for (const link of incoming[node]!) sources.add(source[link]!);
      for (const link of outgoing[node]!) targets.add(target[link]!);
    }
    for (const node of sources) sortOutgoing(node);
    for (const node of targets) sortIncoming(node);
  };

  const iterations = options.iterations ?? ITERATIONS;
  for (let i = 0; i < iterations; i++) {
    const alpha = 0.99 ** i;
    // The last pass pushes nodes all the way apart.
    const beta = Math.max(1 - alpha, (i + 1) / iterations);
    for (let c = count - 2; c >= 0; c--) relax(columns[c]!, outgoing, sourceTop, alpha, beta);
    for (let c = 1; c < count; c++) relax(columns[c]!, incoming, targetTop, alpha, beta);
  }
  for (let node = 0; node < n; node++) {
    sortOutgoing(node);
    sortIncoming(node);
  }

  const boxes = new Float64Array(n * 4);
  for (let node = 0; node < n; node++) {
    if (column[node]! < 0) continue;
    const x = columnX[column[node]!]!;
    boxes.set([x, top[node]!, x + nodeWidth, top[node]! + size[node]!], node * 4);
  }
  const sourceY = new Float64Array(m);
  const targetY = new Float64Array(m);
  for (let link = 0; link < m; link++) {
    if (status[link] !== DRAWN) continue;
    sourceY[link] = top[source[link]!]! + outAbove[link]!;
    targetY[link] = top[target[link]!]! + inAbove[link]!;
  }
  const order = Int32Array.from(columns.flatMap((nodes) => [...nodes].sort(byTop)));
  return {
    columns: count,
    columnX,
    nodeWidth,
    column,
    inflow,
    outflow,
    boxes,
    order,
    status,
    sourceY,
    targetY,
    thickness,
  };
}

/**
 * Marks the links that close cycles as CYCLE, leaving the drawn links
 * acyclic. A depth-first search from the sources (nodes nothing flows into),
 * then from the remaining nodes in order, drops each link back to a node on
 * the current path, so in a loop it is the link returning toward where the
 * flow started that goes.
 */
function breakCycles(n: number, source: Int32Array, target: Int32Array, status: Uint8Array): void {
  const m = source.length;
  const start = new Int32Array(n + 1);
  const fed = new Uint8Array(n);
  for (let link = 0; link < m; link++) {
    if (status[link] !== DRAWN) continue;
    start[source[link]! + 1]!++;
    fed[target[link]!] = 1;
  }
  for (let node = 0; node < n; node++) start[node + 1]! += start[node]!;
  const links = new Int32Array(start[n]!);
  const fill = start.slice(0, n);
  for (let link = 0; link < m; link++) {
    if (status[link] === DRAWN) links[fill[source[link]!]!++] = link;
  }
  // 0: not reached yet; 1: on the current path; 2: done.
  const state = new Uint8Array(n);
  const path: number[] = [];
  const next: number[] = [];
  const visit = (root: number) => {
    state[root] = 1;
    path.push(root);
    next.push(start[root]!);
    while (path.length > 0) {
      const top = path.length - 1;
      const node = path[top]!;
      const at = next[top]!;
      if (at === start[node + 1]) {
        state[node] = 2;
        path.pop();
        next.pop();
        continue;
      }
      next[top] = at + 1;
      const link = links[at]!;
      const to = target[link]!;
      if (state[to] === 1) status[link] = CYCLE;
      else if (state[to] === 0) {
        state[to] = 1;
        path.push(to);
        next.push(start[to]!);
      }
    }
  };
  for (let node = 0; node < n; node++) if (!fed[node] && state[node] === 0) visit(node);
  for (let node = 0; node < n; node++) if (state[node] === 0) visit(node);
}

/**
 * Each node's column: its longest path from a source, except that sinks
 * go to the last column; -1 for nodes without links. The links must be
 * acyclic.
 */
function justifiedColumns(
  n: number,
  source: Int32Array,
  target: Int32Array,
  outgoing: readonly number[][],
  incoming: readonly number[][],
): Int32Array {
  const depth = new Int32Array(n).fill(-1);
  // Kahn's algorithm: a node's depth is final once every link into it is counted.
  const waiting = Int32Array.from(incoming, (links) => links.length);
  const ready: number[] = [];
  for (let node = 0; node < n; node++) {
    if (waiting[node] === 0 && outgoing[node]!.length > 0) {
      depth[node] = 0;
      ready.push(node);
    }
  }
  let deepest = 0;
  for (let at = 0; at < ready.length; at++) {
    const node = ready[at]!;
    for (const link of outgoing[node]!) {
      const to = target[link]!;
      depth[to] = Math.max(depth[to]!, depth[source[link]!]! + 1);
      deepest = Math.max(deepest, depth[to]!);
      if (--waiting[to]! === 0) ready.push(to);
    }
  }
  for (let node = 0; node < n; node++) {
    if (depth[node]! >= 0 && outgoing[node]!.length === 0) depth[node] = deepest;
  }
  return depth;
}

/**
 * Pushes overlapping nodes of a column apart, `alpha` of the way: out from
 * the middle node, then up from the bottom and down from the top so that
 * nodes stay within [y0, y1] when the column has room for them.
 */
function resolveCollisions(
  nodes: readonly number[],
  top: Float64Array,
  size: Float64Array,
  py: number,
  y0: number,
  y1: number,
  alpha: number,
): void {
  if (nodes.length === 0) return;
  const middle = nodes.length >> 1;
  const subject = nodes[middle]!;
  pushUp(nodes, top, size, py, top[subject]! - py, middle - 1, alpha);
  pushDown(nodes, top, size, py, top[subject]! + size[subject]! + py, middle + 1, alpha);
  pushUp(nodes, top, size, py, y1, nodes.length - 1, alpha);
  pushDown(nodes, top, size, py, y0, 0, alpha);
}

/** Moves nodes from `i` down that start above `y` (the previous node's bottom plus padding). */
function pushDown(
  nodes: readonly number[],
  top: Float64Array,
  size: Float64Array,
  py: number,
  y: number,
  i: number,
  alpha: number,
): void {
  for (; i < nodes.length; i++) {
    const node = nodes[i]!;
    const dy = (y - top[node]!) * alpha;
    if (dy > 1e-6) top[node]! += dy;
    y = top[node]! + size[node]! + py;
  }
}

/** Moves nodes from `i` up that end below `y` (the next node's top less padding). */
function pushUp(
  nodes: readonly number[],
  top: Float64Array,
  size: Float64Array,
  py: number,
  y: number,
  i: number,
  alpha: number,
): void {
  for (; i >= 0; i--) {
    const node = nodes[i]!;
    const dy = (top[node]! + size[node]! - y) * alpha;
    if (dy > 1e-6) top[node]! -= dy;
    y = top[node]! - py;
  }
}
