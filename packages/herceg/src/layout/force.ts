// Force-directed layout, after d3-force with its defaults: springs along
// links and repulsion between every pair of nodes, over 300 ticks. Each tick
// adds the forces to the nodes' velocities, scaled by alpha, which decays
// from 1 to 0.001, then moves the nodes and damps their velocities.
// Repulsion is summed exactly for small graphs and with a Barnes–Hut
// quadtree for larger ones. Unlike d3's defaults, nodes start where pivot
// MDS places them (layout/pivot-mds.ts) rather than on a spiral, and
// connected components are packed side by side before and after, rather
// than held together by a pull toward the center, which squeezes large
// components out of shape. Everything is deterministic: the only randomness,
// a nudge that separates nodes at the same place, comes from a generator
// with a fixed seed.
//
// A simulation also runs from given positions, with some nodes held where
// they are and only some moving, for shorter: a network laid out again
// after its data changed, or settling around a node moved by hand. Nodes
// that do not move still pull and push those that do; their repulsion is
// summed over a quadtree built once. A simulation stops between chunks of a
// tick when a deadline passes and resumes where it stopped, so the layout of
// a large network can spread over animation frames; however it is split,
// it ends where one uninterrupted run does.

import { type Adjacency, componentsOf, packComponents } from "./components.ts";
import { pivotMdsSteps } from "./pivot-mds.ts";

/** Links between nodes, by node index. */
export interface ForceGraph {
  /** How many nodes the links refer to, numbered from 0. */
  nodes: number;
  source: Int32Array;
  target: Int32Array;
  /** Per link, a factor from 0 to 1 on its spring's strength; 1 without it. */
  strength?: Float64Array | undefined;
}

/** Where a simulation starts, what it holds still, and for how long. */
export interface ForceRun {
  /**
   * x, y per node to start from, in layout units. Without it, pivot MDS
   * places the nodes, and connected components are packed side by side
   * before and after the run.
   */
  start?: Float64Array | undefined;
  /** x, y per node held there, by node: they do not move, but pull and push the others. */
  held?: ReadonlyMap<number, readonly [number, number]> | undefined;
  /** The nodes that move, besides those held; all of them by default. */
  moving?: Int32Array | undefined;
  /** Alpha at the start; 1 by default. */
  alpha?: number | undefined;
  /** Ticks over which alpha decays to its minimum; 300 by default. */
  ticks?: number | undefined;
  /**
   * Components with no places of their own yet (new to a changed network):
   * laid out apart by pivot MDS as the run's first steps, packed side by
   * side, and put with their box's left edge and middle where they start.
   */
  arrange?: readonly Int32Array[] | undefined;
  /**
   * Packs connected components side by side once the run ends, as a fresh
   * layout's are, unless nodes are held: for a first layout carried on from
   * one interrupted by a change of the data.
   */
  pack?: boolean | undefined;
}

/** Length links settle toward, in layout units. */
export const LINK_DISTANCE = 30;
/** Repulsion of each node; negative pushes apart. */
const CHARGE = -30;
/** Velocities keep this share from one tick to the next. */
const VELOCITY_KEEP = 0.6;
const ALPHA_MIN = 0.001;
const TICKS = 300;
/** Above this many nodes, repulsion is approximated with a quadtree. */
const EXACT_NODES = 150;
/**
 * A cell this many times closer than it is wide acts as one body: d3's
 * theta of 0.9, squared, and above `COARSE_NODES` nodes, 1.2, which looks
 * the same on meshes, trees, and clusters of 20,000 nodes and saves about a
 * third of the time.
 */
const THETA2 = 0.81;
const COARSE_THETA2 = 1.44;
const COARSE_NODES = 5000;
/** Moving nodes whose repulsion is summed between looks at the deadline. */
const CHUNK = 2048;

/**
 * Lays out a graph and returns x, y per node in layout units, centered near
 * (0, 0), with linked nodes about `LINK_DISTANCE` apart. Links whose ends are
 * the same node, or are not nodes of the graph, are ignored.
 */
export function layoutForce(graph: ForceGraph, run?: ForceRun): Float64Array {
  const simulation = new ForceSimulation(graph, run);
  simulation.run();
  return simulation.positions;
}

/** A force simulation that runs in pieces (see `run`). */
export class ForceSimulation {
  /**
   * x, y per node in layout units: as far as the run has come, held nodes
   * where they are held; zeros until the run has `started`.
   */
  readonly positions: Float64Array;
  readonly #steps: Generator<void, void>;
  #started: boolean;
  /** Whether new components are still being laid out apart (see `ForceRun.arrange`). */
  #arranging = false;
  #done = false;
  /** Ticks run so far, the ticks of the run, alpha now, and the nodes that move (undefined for all). */
  #ticked = 0;
  #ticks: number;
  #alpha: number;
  #moving: Int32Array | undefined;

  constructor(graph: ForceGraph, run: ForceRun = {}) {
    this.positions = run.start ? Float64Array.from(run.start) : new Float64Array(graph.nodes * 2);
    this.#started = run.start !== undefined;
    // Components to lay out apart have no places until the run has laid them out.
    this.#arranging = (run.arrange?.length ?? 0) > 0;
    this.#ticks = run.ticks ?? TICKS;
    this.#alpha = run.alpha ?? 1;
    this.#moving = run.moving;
    this.#steps = this.#simulate(graph, run);
  }

  /** Alpha now, which the next tick decays. */
  get alpha(): number {
    return this.#alpha;
  }

  /** Ticks the run has left. */
  get ticksLeft(): number {
    return this.#done ? 0 : this.#ticks - this.#ticked;
  }

  /** The nodes that move, as given; undefined when all do. */
  get moving(): Int32Array | undefined {
    return this.#moving;
  }

  /** Whether the nodes have places to start from (a fresh layout's come from pivot MDS). */
  get started(): boolean {
    return this.#started;
  }

  /**
   * Whether every node has its place to start from: new components laid
   * out apart too (see `ForceRun.arrange`). Until then, the run cannot be
   * carried on in another.
   */
  get placed(): boolean {
    return this.#started && !this.#arranging;
  }

  /** Whether the run is over. */
  get done(): boolean {
    return this.#done;
  }

  /** Ticks run so far. */
  get ticked(): number {
    return this.#ticked;
  }

  /**
   * Runs until the end, until `performance.now()` passes `deadline`
   * (looked at between steps, a chunk of a tick at most), or until `ticks`
   * ticks have run in all; returns whether the run is over. Each call
   * takes at least one step unless `ticks` have run.
   */
  run(deadline = Number.POSITIVE_INFINITY, ticks = Number.POSITIVE_INFINITY): boolean {
    const timed = deadline < Number.POSITIVE_INFINITY;
    while (!this.#done && this.#ticked < ticks) {
      this.#done = this.#steps.next().done === true;
      if (timed && performance.now() > deadline) break;
    }
    return this.#done;
  }

  *#simulate(graph: ForceGraph, run: ForceRun): Generator<void, void> {
    const n = graph.nodes;
    const positions = this.positions;
    const held = run.held;
    const springs = prepareSprings(graph);
    // Components a fresh layout packs once the run ends, unless nodes are held.
    let components: Int32Array[] | undefined;
    if (run.start && run.pack && !held?.size) components = componentsOf(n, adjacencyOf(n, springs));
    if (!run.start) {
      const adjacency = adjacencyOf(n, springs);
      const found = componentsOf(n, adjacency);
      // Starting where graph distances say, rather than on d3's spiral, keeps rings and chains from folding.
      yield* pivotMdsSteps(adjacency, found, LINK_DISTANCE, positions);
      packComponents(positions, found, LINK_DISTANCE);
      if (!held?.size) components = found;
    }
    for (const [node, [x, y]] of held ?? []) {
      positions[node * 2] = x;
      positions[node * 2 + 1] = y;
    }
    this.#started = true;
    if (run.arrange?.length) {
      yield* arrangeApart(n, springs, run.arrange, positions);
      this.#arranging = false;
    }
    const moves = new Uint8Array(n);
    if (run.moving) for (const node of run.moving) moves[node] = 1;
    else moves.fill(1);
    for (const node of held?.keys() ?? []) moves[node] = 0;
    const list: number[] = [];
    for (let node = 0; node < n; node++) if (moves[node]) list.push(node);
    const moving = Int32Array.from(list);
    if (moving.length === 0) return;
    // Only springs with a moving end pull anything.
    const pulling = moving.length === n ? springs : springsMoving(springs, moves);
    const vx = new Float64Array(n);
    const vy = new Float64Array(n);
    const jiggle = jiggler();
    const ticks = this.#ticks;
    let alpha = this.#alpha;
    const decay = 1 - (ALPHA_MIN / alpha) ** (1 / Math.max(1, ticks));
    // Exact sums for small graphs. Otherwise a quadtree of the moving
    // nodes, rebuilt every tick, over still ones too unless they are many:
    // theirs is built once.
    const theta2 = n > COARSE_NODES ? COARSE_THETA2 : THETA2;
    const tree = n > EXACT_NODES ? new QuadTree(n, theta2) : undefined;
    let still: QuadTree | undefined;
    if (tree && moving.length < n / 2) {
      const others: number[] = [];
      for (let node = 0; node < n; node++) if (!moves[node]) others.push(node);
      still = new QuadTree(n, theta2);
      still.build(positions, Int32Array.from(others));
    }
    for (let tick = 0; tick < ticks; tick++) {
      alpha += -alpha * decay;
      this.#alpha = alpha;
      pullSprings(pulling, positions, vx, vy, alpha, jiggle);
      if (tree) {
        tree.build(positions, still ? moving : undefined);
        const k = CHARGE * alpha;
        for (let at = 0; at < moving.length; at++) {
          const i = moving[at]!;
          tree.push(positions, i, k, jiggle, vx, vy);
          still?.push(positions, i, k, jiggle, vx, vy);
          if ((at + 1) % CHUNK === 0) yield;
        }
      } else repelExactly(positions, moves, vx, vy, alpha, jiggle);
      for (const i of moving) {
        vx[i]! *= VELOCITY_KEEP;
        vy[i]! *= VELOCITY_KEEP;
        positions[i * 2]! += vx[i]!;
        positions[i * 2 + 1]! += vy[i]!;
      }
      this.#ticked++;
      yield;
    }
    // Repulsion pushed components apart; bring them back together.
    if (components) packComponents(positions, components, LINK_DISTANCE);
  }
}

/**
 * Lays components out apart by pivot MDS, packs them side by side, and puts
 * the pack with its box's left edge and middle where their nodes are now.
 */
function* arrangeApart(
  n: number,
  springs: Springs,
  components: readonly Int32Array[],
  positions: Float64Array,
): Generator<void, void> {
  const apart = new Float64Array(n * 2);
  yield* pivotMdsSteps(adjacencyOf(n, springs), components, LINK_DISTANCE, apart);
  packComponents(apart, components, LINK_DISTANCE);
  const box = (array: Float64Array) => {
    let [x0, y0, y1] = [
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ];
    for (const members of components)
      for (const node of members) {
        x0 = Math.min(x0, array[node * 2]!);
        y0 = Math.min(y0, array[node * 2 + 1]!);
        y1 = Math.max(y1, array[node * 2 + 1]!);
      }
    return [x0, (y0 + y1) / 2] as const;
  };
  const [ax, ay] = box(positions);
  const [bx, by] = box(apart);
  for (const members of components)
    for (const node of members) {
      positions[node * 2] = apart[node * 2]! - bx + ax;
      positions[node * 2 + 1] = apart[node * 2 + 1]! - by + ay;
    }
}

/** Neighbors per node, from the springs. */
function adjacencyOf(n: number, { source, target }: Springs): Adjacency {
  const starts = new Int32Array(n + 1);
  for (let link = 0; link < source.length; link++) {
    starts[source[link]! + 1]!++;
    starts[target[link]! + 1]!++;
  }
  for (let i = 0; i < n; i++) starts[i + 1]! += starts[i]!;
  const neighbors = new Int32Array(starts[n]!);
  const fill = starts.slice(0, n);
  for (let link = 0; link < source.length; link++) {
    const s = source[link]!;
    const t = target[link]!;
    neighbors[fill[s]!++] = t;
    neighbors[fill[t]!++] = s;
  }
  return { starts, neighbors };
}

/** A tiny random offset, as d3's `jiggle`, from a linear congruential generator seeded with 1. */
function jiggler(): () => number {
  let seed = 1;
  return () => {
    seed = (1664525 * seed + 1013904223) % 4294967296;
    return (seed / 4294967296 - 0.5) * 1e-6;
  };
}

interface Springs {
  source: Int32Array;
  target: Int32Array;
  /** Per link: the share of its pull that moves its target (the rest moves its source). */
  bias: Float64Array;
  strength: Float64Array;
  /** Per link, with nodes held still: whether its source and its target move. */
  moves?: Uint8Array | undefined;
}

/**
 * Springs as d3's link force sets them up: each link's strength is the
 * inverse of the smaller of its ends' degrees, so hubs are not pulled apart
 * by their many links, and the less connected end moves more.
 */
function prepareSprings(graph: ForceGraph): Springs {
  const { nodes: n, source, target } = graph;
  const kept: number[] = [];
  const degree = new Int32Array(n);
  for (let link = 0; link < source.length; link++) {
    const s = source[link]!;
    const t = target[link]!;
    if (s === t || !(s >= 0 && s < n && t >= 0 && t < n)) continue;
    kept.push(link);
    degree[s]!++;
    degree[t]!++;
  }
  const springs: Springs = {
    source: new Int32Array(kept.length),
    target: new Int32Array(kept.length),
    bias: new Float64Array(kept.length),
    strength: new Float64Array(kept.length),
  };
  kept.forEach((link, i) => {
    const s = source[link]!;
    const t = target[link]!;
    springs.source[i] = s;
    springs.target[i] = t;
    springs.bias[i] = degree[s]! / (degree[s]! + degree[t]!);
    springs.strength[i] = (graph.strength?.[link] ?? 1) / Math.min(degree[s]!, degree[t]!);
  });
  return springs;
}

/** The springs with a moving end, and which of their ends move (bit 1 the source's, 2 the target's). */
function springsMoving(springs: Springs, moves: Uint8Array): Springs {
  const kept: number[] = [];
  for (let link = 0; link < springs.source.length; link++)
    if (moves[springs.source[link]!] || moves[springs.target[link]!]) kept.push(link);
  const pick = <T extends Int32Array | Float64Array>(array: T, make: (n: number) => T): T => {
    const out = make(kept.length);
    kept.forEach((link, i) => {
      out[i] = array[link]!;
    });
    return out;
  };
  return {
    source: pick(springs.source, (n) => new Int32Array(n)),
    target: pick(springs.target, (n) => new Int32Array(n)),
    bias: pick(springs.bias, (n) => new Float64Array(n)),
    strength: pick(springs.strength, (n) => new Float64Array(n)),
    moves: Uint8Array.from(
      kept,
      (link) => moves[springs.source[link]!]! | (moves[springs.target[link]!]! << 1),
    ),
  };
}

function pullSprings(
  springs: Springs,
  positions: Float64Array,
  vx: Float64Array,
  vy: Float64Array,
  alpha: number,
  jiggle: () => number,
): void {
  const { source, target, bias, strength, moves } = springs;
  for (let link = 0; link < source.length; link++) {
    const s = source[link]!;
    const t = target[link]!;
    // Where the ends are headed this tick, as d3 measures.
    const x = positions[t * 2]! + vx[t]! - positions[s * 2]! - vx[s]! || jiggle();
    const y = positions[t * 2 + 1]! + vy[t]! - positions[s * 2 + 1]! - vy[s]! || jiggle();
    const length = Math.sqrt(x * x + y * y);
    const pull = ((length - LINK_DISTANCE) / length) * alpha * strength[link]!;
    const b = bias[link]!;
    // An end held still keeps its share of the pull, as d3's fixed nodes do.
    const ends = moves ? moves[link]! : 3;
    if (ends & 2) {
      vx[t]! -= x * pull * b;
      vy[t]! -= y * pull * b;
    }
    if (ends & 1) {
      vx[s]! += x * pull * (1 - b);
      vy[s]! += y * pull * (1 - b);
    }
  }
}

/**
 * Repulsion between every pair of nodes, falling off with distance (as in
 * two dimensions), and capped for nodes closer than one unit; nodes that do
 * not move push without being pushed.
 */
function repelExactly(
  positions: Float64Array,
  moves: Uint8Array,
  vx: Float64Array,
  vy: Float64Array,
  alpha: number,
  jiggle: () => number,
): void {
  const n = vx.length;
  const k = CHARGE * alpha;
  for (let i = 0; i < n; i++) {
    const xi = positions[i * 2]!;
    const yi = positions[i * 2 + 1]!;
    for (let j = i + 1; j < n; j++) {
      if (!moves[i] && !moves[j]) continue;
      let x = positions[j * 2]! - xi;
      let y = positions[j * 2 + 1]! - yi;
      let l = x * x + y * y;
      if (x === 0) {
        x = jiggle();
        l += x * x;
      }
      if (y === 0) {
        y = jiggle();
        l += y * y;
      }
      if (l < 1) l = Math.sqrt(l);
      const f = k / l;
      if (moves[i]) {
        vx[i]! += x * f;
        vy[i]! += y * f;
      }
      if (moves[j]) {
        vx[j]! -= x * f;
        vy[j]! -= y * f;
      }
    }
  }
}

/** Splitting stops this deep; nodes closer than the cells there share one. */
const MAX_DEPTH = 32;

/**
 * A quadtree over node positions (all nodes, or some of them), in flat
 * arrays reused between builds. Cells are allocated in fours, children after
 * their parent, so a pass from the last cell back to the first sums children
 * before parents. A leaf holds a list of nodes: one, or several at the same
 * place.
 */
class QuadTree {
  #capacity = 0;
  #cells = 0;
  /** Per cell: the first of its four children, or -1 for a leaf. */
  #child = new Int32Array(0);
  /** Per leaf: its first node, or -1 when empty; per node: the next in its leaf. */
  #head = new Int32Array(0);
  readonly #next: Int32Array;
  /** Per cell: its width, node count, and the nodes' centroid. */
  #width = new Float64Array(0);
  #count = new Float64Array(0);
  #cx = new Float64Array(0);
  #cy = new Float64Array(0);
  readonly #stack = new Int32Array((MAX_DEPTH + 2) * 4);
  readonly #theta2: number;

  constructor(nodes: number, theta2: number) {
    this.#theta2 = theta2;
    this.#next = new Int32Array(nodes);
    this.#grow(Math.max(16, nodes * 2));
  }

  #grow(capacity: number): void {
    const grown = <T extends Int32Array | Float64Array>(old: T, make: (n: number) => T): T => {
      const array = make(capacity);
      array.set(old);
      return array;
    };
    this.#child = grown(this.#child, (n) => new Int32Array(n));
    this.#head = grown(this.#head, (n) => new Int32Array(n));
    this.#width = grown(this.#width, (n) => new Float64Array(n));
    this.#count = grown(this.#count, (n) => new Float64Array(n));
    this.#cx = grown(this.#cx, (n) => new Float64Array(n));
    this.#cy = grown(this.#cy, (n) => new Float64Array(n));
    this.#capacity = capacity;
  }

  /** Four empty leaves, returning the first; their width is set by the caller. */
  #split(): number {
    if (this.#cells + 4 > this.#capacity) this.#grow(this.#capacity * 2);
    const first = this.#cells;
    this.#cells += 4;
    this.#child.fill(-1, first, first + 4);
    this.#head.fill(-1, first, first + 4);
    return first;
  }

  /** Builds the tree over `members`' positions, or every node's. */
  build(positions: Float64Array, members?: Int32Array): void {
    const count = members ? members.length : this.#next.length;
    let x0 = Number.POSITIVE_INFINITY;
    let y0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let y1 = Number.NEGATIVE_INFINITY;
    for (let k = 0; k < count; k++) {
      const i = members ? members[k]! : k;
      const x = positions[i * 2]!;
      const y = positions[i * 2 + 1]!;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    // A square cell over everything, with the root as one of four so cells are always in fours.
    const size = count > 0 ? Math.max(x1 - x0, y1 - y0, 1e-9) * (1 + 1e-9) : 1;
    this.#cells = 0;
    const root = this.#split();
    this.#width[root] = size;
    for (let k = 0; k < count; k++)
      this.#insert(root, x0, y0, positions, members ? members[k]! : k);
    this.#sum(positions);
  }

  #insert(root: number, rootX: number, rootY: number, positions: Float64Array, i: number): void {
    const x = positions[i * 2]!;
    const y = positions[i * 2 + 1]!;
    let cell = root;
    let x0 = rootX;
    let y0 = rootY;
    for (let depth = 0; ; depth++) {
      const half = this.#width[cell]! / 2;
      const first = this.#child[cell]!;
      if (first >= 0) {
        const right = x >= x0 + half ? 1 : 0;
        const below = y >= y0 + half ? 1 : 0;
        x0 += right * half;
        y0 += below * half;
        cell = first + right + below * 2;
        continue;
      }
      const other = this.#head[cell]!;
      if (
        other < 0 ||
        depth >= MAX_DEPTH ||
        (positions[other * 2] === x && positions[other * 2 + 1] === y)
      ) {
        this.#next[i] = other;
        this.#head[cell] = i;
        return;
      }
      // A leaf holding nodes elsewhere: split it and move them down a level.
      const children = this.#split();
      for (let c = 0; c < 4; c++) this.#width[children + c] = half;
      const ox = positions[other * 2]!;
      const oy = positions[other * 2 + 1]!;
      const quadrant = (ox >= x0 + half ? 1 : 0) + (oy >= y0 + half ? 2 : 0);
      this.#head[children + quadrant] = other;
      this.#head[cell] = -1;
      this.#child[cell] = children;
    }
  }

  /** Node counts and centroids of every cell, children before parents. */
  #sum(positions: Float64Array): void {
    for (let cell = this.#cells - 1; cell >= 0; cell--) {
      const first = this.#child[cell]!;
      let count = 0;
      let sx = 0;
      let sy = 0;
      if (first >= 0) {
        for (let c = first; c < first + 4; c++) {
          const k = this.#count[c]!;
          count += k;
          sx += k * this.#cx[c]!;
          sy += k * this.#cy[c]!;
        }
      } else {
        for (let i = this.#head[cell]!; i >= 0; i = this.#next[i]!) {
          count++;
          sx += positions[i * 2]!;
          sy += positions[i * 2 + 1]!;
        }
      }
      this.#count[cell] = count;
      this.#cx[cell] = count > 0 ? sx / count : 0;
      this.#cy[cell] = count > 0 ? sy / count : 0;
    }
  }

  /**
   * Adds the repulsion of the tree's nodes on node `i` (not on itself) to
   * its velocity, as d3's many-body force sums it, with strength `k`.
   */
  push(
    positions: Float64Array,
    i: number,
    k: number,
    jiggle: () => number,
    vx: Float64Array,
    vy: Float64Array,
  ): void {
    const xi = positions[i * 2]!;
    const yi = positions[i * 2 + 1]!;
    const stack = this.#stack;
    const theta2 = this.#theta2;
    let fx = 0;
    let fy = 0;
    let top = 0;
    stack[top++] = 0;
    while (top > 0) {
      const cell = stack[--top]!;
      const count = this.#count[cell]!;
      if (count === 0) continue;
      let x = this.#cx[cell]! - xi;
      let y = this.#cy[cell]! - yi;
      let l = x * x + y * y;
      const w = this.#width[cell]!;
      const first = this.#child[cell]!;
      // A distant cell pushes as one body at its centroid.
      if ((w * w) / theta2 < l) {
        if (x === 0) {
          x = jiggle();
          l += x * x;
        }
        if (y === 0) {
          y = jiggle();
          l += y * y;
        }
        if (l < 1) l = Math.sqrt(l);
        fx += (x * k * count) / l;
        fy += (y * k * count) / l;
        continue;
      }
      if (first >= 0) {
        stack[top++] = first;
        stack[top++] = first + 1;
        stack[top++] = first + 2;
        stack[top++] = first + 3;
        continue;
      }
      // A near leaf: each of its nodes pushes, but not on itself.
      const head = this.#head[cell]!;
      if (head === i && this.#next[head]! < 0) continue;
      if (x === 0) {
        x = jiggle();
        l += x * x;
      }
      if (y === 0) {
        y = jiggle();
        l += y * y;
      }
      if (l < 1) l = Math.sqrt(l);
      for (let j = head; j >= 0; j = this.#next[j]!) {
        if (j === i) continue;
        fx += (x * k) / l;
        fy += (y * k) / l;
      }
    }
    vx[i]! += fx;
    vy[i]! += fy;
  }
}

/** Where a layout lands in its room: per node x, y in pixels. */
export interface FitOptions {
  /** Pixels kept clear inside every edge of the room. */
  inset: number;
  /** Pixels kept clear inside the left and right edges instead, where labels need more. */
  insetX?: number | undefined;
  /** The most a layout unit may grow to, in pixels, so small graphs do not sprawl. */
  maxScale: number;
  /** How much more x may be stretched than y (or y than x) to use a room of another shape. */
  maxStretch: number;
}

/** Layout units to pixels: x' = cx + sx (x - mx), y' = cy + sy (y - my). */
export interface LayoutFit {
  cx: number;
  cy: number;
  mx: number;
  my: number;
  sx: number;
  sy: number;
}

/** Layout positions placed in a room by a fit (see `layoutFit`): x, y per node in pixels. */
export function fitLayout(
  positions: Float64Array,
  { cx, cy, mx, my, sx, sy }: LayoutFit,
): Float64Array {
  const n = positions.length / 2;
  const fitted = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    fitted[i * 2] = cx + (positions[i * 2]! - mx) * sx;
    fitted[i * 2 + 1] = cy + (positions[i * 2 + 1]! - my) * sy;
  }
  return fitted;
}

/**
 * How layout positions fit a room: as large as fits inside the inset, up
 * to `maxScale`, stretching one axis by up to `maxStretch` where the room's
 * shape differs from the layout's. A lone node, or nodes all at one place,
 * land in the middle.
 */
export function layoutFit(
  positions: Float64Array,
  room: { x: number; y: number; width: number; height: number },
  options: FitOptions,
): LayoutFit {
  const n = positions.length / 2;
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    x0 = Math.min(x0, positions[i * 2]!);
    x1 = Math.max(x1, positions[i * 2]!);
    y0 = Math.min(y0, positions[i * 2 + 1]!);
    y1 = Math.max(y1, positions[i * 2 + 1]!);
  }
  const width = Math.max(0, room.width - 2 * (options.insetX ?? options.inset));
  const height = Math.max(0, room.height - 2 * options.inset);
  const spanX = x1 - x0;
  const spanY = y1 - y0;
  // Each axis' own fit; an axis without extent fits any scale.
  const fitX = spanX > 0 ? width / spanX : Number.POSITIVE_INFINITY;
  const fitY = spanY > 0 ? height / spanY : Number.POSITIVE_INFINITY;
  const base = Math.min(fitX, fitY, options.maxScale);
  const scaleX = Math.min(fitX, base * options.maxStretch, options.maxScale);
  const scaleY = Math.min(fitY, base * options.maxStretch, options.maxScale);
  return {
    cx: room.x + room.width / 2,
    cy: room.y + room.height / 2,
    mx: n > 0 ? (x0 + x1) / 2 : 0,
    my: n > 0 ? (y0 + y1) / 2 : 0,
    sx: Number.isFinite(scaleX) ? scaleX : 0,
    sy: Number.isFinite(scaleY) ? scaleY : 0,
  };
}

/**
 * Pushes apart nodes whose circles, `gap` pixels apart, would overlap, over
 * a few passes, keeping each circle inside the room. Each pass compares
 * only nodes in neighboring cells of a grid as wide as the largest circle.
 * Nodes at the same place part along a direction set by their indices, so
 * the result stays deterministic.
 */
export function separate(
  positions: Float64Array,
  radii: Float64Array,
  room: { x: number; y: number; width: number; height: number },
  gap: number,
  passes = 6,
): void {
  const n = radii.length;
  if (n < 2) return;
  let largest = 0;
  for (const r of radii) largest = Math.max(largest, r);
  const size = 2 * largest + gap;
  if (!(size > 0)) return;
  const columns = Math.max(1, Math.ceil(room.width / size));
  const rows = Math.max(1, Math.ceil(room.height / size));
  const starts = new Int32Array(columns * rows + 1);
  const order = new Int32Array(n);
  const cellOf = new Int32Array(n);
  const cell = (i: number) => {
    const cx = Math.min(columns - 1, Math.max(0, Math.floor((positions[i * 2]! - room.x) / size)));
    const cy = Math.min(rows - 1, Math.max(0, Math.floor((positions[i * 2 + 1]! - room.y) / size)));
    return cy * columns + cx;
  };
  for (let pass = 0; pass < passes; pass++) {
    // Nodes sorted by cell: a counting sort.
    starts.fill(0);
    for (let i = 0; i < n; i++) {
      cellOf[i] = cell(i);
      starts[cellOf[i]! + 1]!++;
    }
    for (let c = 0; c < columns * rows; c++) starts[c + 1]! += starts[c]!;
    const next = starts.slice(0, columns * rows);
    for (let i = 0; i < n; i++) order[next[cellOf[i]!]!++] = i;
    let moved = false;
    for (let i = 0; i < n; i++) {
      const cx = cellOf[i]! % columns;
      const cy = Math.floor(cellOf[i]! / columns);
      for (let y = Math.max(0, cy - 1); y <= Math.min(rows - 1, cy + 1); y++) {
        for (let x = Math.max(0, cx - 1); x <= Math.min(columns - 1, cx + 1); x++) {
          const c = y * columns + x;
          for (let k = starts[c]!; k < starts[c + 1]!; k++) {
            const j = order[k]!;
            if (j <= i) continue;
            let dx = positions[j * 2]! - positions[i * 2]!;
            let dy = positions[j * 2 + 1]! - positions[i * 2 + 1]!;
            let d = Math.sqrt(dx * dx + dy * dy);
            const least = radii[i]! + radii[j]! + gap;
            if (d >= least) continue;
            if (d === 0) {
              const angle = (i + j) * 2.399963;
              dx = Math.cos(angle);
              dy = Math.sin(angle);
              d = 1;
            }
            const push = (least - d) / 2 / d;
            positions[i * 2]! -= dx * push;
            positions[i * 2 + 1]! -= dy * push;
            positions[j * 2]! += dx * push;
            positions[j * 2 + 1]! += dy * push;
            moved = true;
          }
        }
      }
    }
    for (let i = 0; i < n; i++) {
      const r = radii[i]!;
      positions[i * 2] = clamp(positions[i * 2]!, room.x + r, room.x + room.width - r);
      positions[i * 2 + 1] = clamp(positions[i * 2 + 1]!, room.y + r, room.y + room.height - r);
    }
    if (!moved) return;
  }
}

/** `value` within [lo, hi], or their middle when the range is empty. */
function clamp(value: number, lo: number, hi: number): number {
  return lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, value));
}
