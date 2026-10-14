// Where a network's nodes are, for one chart state: the chart's, or a
// subplot's (facet panels share one). Two charts drawing the same tables
// lay them out apart. Three sets of positions, by node:
// - the layout's own: where the layout puts nodes, without regard to the
//   nodes moved by hand. Kept by node name as the data changes, so nodes
//   that remain stay near where they were and new ones enter near their
//   neighbors (see `#arrange`).
// - the settled: the layout's own, but in a force layout that settles,
//   with the nodes near those moved by hand settled around them. It
//   depends only on the layout's own and on where nodes are held, not on
//   the order of moves, so every view of a chart, and a chart restored from
//   saved moves, draws the same.
// - the shown: the settled, eased toward over a few frames when they change
//   (at once with reduced motion), or the layout's own while it is worked
//   out, frame by frame.
// Work runs in steps that spread over animation frames, so a large network
// is laid out without holding up the page.
//
// Per layout, after a change of the data:
// - force: nodes that remain start where they were, new ones beside their
//   placed neighbors (new components beside the rest), and a short
//   simulation moves the nodes near what changed.
// - circular: places nodes in their order again, turned to move the nodes
//   that remain least.
// - layered: lays the network out again, nodes starting in the order their
//   places gave them across their layers.

import { bestTurn, layoutCircular } from "../layout/circular.ts";
import { componentsOf } from "../layout/components.ts";
import { ForceSimulation, type LayoutFit, LINK_DISTANCE } from "../layout/force.ts";
import { type LayerDirection, type Layered, layeredSteps } from "../layout/layered.ts";

/** The layout a network asks for, its options filled in. */
export type NetworkLayout =
  | { type: "force"; settle: boolean }
  | { type: "circular"; sort: "degree" | "input" | "name" }
  | { type: "layered"; direction: LayerDirection };

/** What a network's layout reads of it. */
export interface LayoutNetwork {
  names: readonly string[];
  nodeOf: ReadonlyMap<string, number>;
  /** Per link, its ends: directed links from source to target. */
  source: Int32Array;
  target: Int32Array;
  /** Per link, a factor on its spring's strength; undefined for links alike. */
  strength: Float64Array | undefined;
  /** Per node, its group's index, -1 for none. */
  group: Int32Array;
  /** Per link: 1 where a row runs from its source to its target, 2 where one runs back, 3 both. */
  ways: Uint8Array;
  /** The link of a pair: `linkOf.get(pairKey(s, t))` (see `pairKey`). */
  linkOf: ReadonlyMap<number, number>;
  stride: number;
  directed: boolean;
}

/** The key `linkOf` finds the link between nodes `s` and `t` by: either way round unless directed. */
export function pairKey(
  { stride, directed }: Pick<LayoutNetwork, "stride" | "directed">,
  s: number,
  t: number,
): number {
  return directed ? s * stride + t : Math.min(s, t) * stride + Math.max(s, t);
}

/** How a chart's frames pace layout work; without one, work runs to the end at once. */
export interface LayoutClock {
  /** `performance.now()` past which work waits for the next frame. */
  deadline: number;
  /** Whether nodes on their way are drawn; false with reduced motion. */
  animate: boolean;
  /** When the frame started, by `performance.now()`. */
  now: number;
}

/** Simulation ticks of a settle, and how long nodes take to get there on screen. */
const SETTLE_TICKS = 40;
const SETTLE_ALPHA = 0.3;
const EASE_MS = 300;
/** At most this many nodes, with this many links between them and the rest, settle. */
const SETTLING = 1000;
const SETTLING_LINKS = 20_000;
/** Nodes within this many links of a change move, after a change of the data or to settle. */
const HOPS = 2;
/** Nodes this close to where a node is held settle too, as it may be held in another cluster. */
const NEAR = 2 * LINK_DISTANCE;
/**
 * Networks of more nodes and links than this show the layout as it is
 * worked out every so many milliseconds, not every frame: drawing them
 * costs more than the work a frame does.
 */
const LARGE = 20_000;
const SHOW_EVERY = 250;
/** A change moving more than this share of nodes moves all of them, from a higher alpha, for longer. */
const LOCAL_SHARE = 0.5;
const UPDATE = { alpha: 0.3, ticks: 100 };
const UPDATE_ALL = { alpha: 0.5, ticks: 200 };

/**
 * Work in progress: the layout's own positions (of the network the work is
 * for, which may be one the data has changed since), or the settled ones.
 */
type Job =
  | {
      kind: "layout";
      network: LayoutNetwork;
      simulation: ForceSimulation;
      /** A first layout, or one carried on from it, whose components are packed at the end. */
      first: boolean;
    }
  | { kind: "layered"; network: LayoutNetwork; steps: Generator<void, Layered> }
  | {
      kind: "settle";
      simulation: ForceSimulation;
      held: ReadonlyMap<number, readonly [number, number]>;
    };

export class NodePositions {
  /** The mark whose network these are: its id among the chart's. */
  readonly owner: string | number;
  /** The network last given, which everything shown is of. */
  #network: LayoutNetwork | undefined;
  #layout: NetworkLayout | undefined;
  /** The layout's own positions, x, y per node of `#network` in layout units, once there are any. */
  #own: Float64Array | undefined;
  /** The settled positions, for the nodes held in `#held`; undefined until worked out. */
  #settled: Float64Array | undefined;
  /** The nodes held, by name, that `#settled` is for; undefined when it is for none yet. */
  #held: Map<string, readonly [number, number]> | undefined;
  /** What is drawn, and the layout's own positions behind it, which fit the room. */
  #shown: Float64Array | undefined;
  #fitTo: Float64Array | undefined;
  /** Easing from what was shown to the settled positions: where nodes left from, and which nodes move. */
  #ease: { from: Float64Array; nodes: Int32Array; began: number | undefined } | undefined;
  /** A layered layout's bend points per link, and its nodes and bend points together, which fit the room. */
  #routes: Pick<Layered, "starts" | "bends"> | undefined;
  #withBends: Float64Array | undefined;
  #reversed = 0;
  #job: Job | undefined;
  /** The clock work last ran by: a frame works once, however many panels draw. */
  #clock: LayoutClock | undefined;
  #revision = 0;
  /** When work in progress was last shown, by `performance.now()`. */
  #shownAt = Number.NEGATIVE_INFINITY;
  #failure: string | undefined;
  /** How what is shown fits each room it is drawn in, kept until its extent may change. */
  readonly #fits = new Map<string, LayoutFit>();

  constructor(owner: string | number) {
    this.owner = owner;
  }

  /** x, y per node in layout units as drawn, or undefined while there is nothing to draw yet. */
  get shown(): Float64Array | undefined {
    return this.#shown;
  }

  /**
   * The layout's own positions as far as they are worked out, which views
   * fit the room to: not where nodes settle, so the view holds as they do.
   */
  get own(): Float64Array | undefined {
    return this.#shown && this.#fitTo;
  }

  /** A layered layout's bend points per link (see `Layered`), for the network drawn. */
  get routes(): Pick<Layered, "starts" | "bends"> | undefined {
    return this.#shown && this.#routes;
  }

  /** Constraints a layered layout turned around to break cycles. */
  get reversed(): number {
    return this.#reversed;
  }

  /** Changes whenever what is shown does. */
  get revision(): number {
    return this.#revision;
  }

  /** Whether work or easing remains: the chart draws again on the next frame. */
  get pending(): boolean {
    return this.#job !== undefined || this.#ease !== undefined;
  }

  /** Whether the layout's own positions are still being worked out (not just nodes settling). */
  get arranging(): boolean {
    return this.#job !== undefined && this.#job.kind !== "settle";
  }

  /**
   * Why the layout could not be worked out (a layered layout's links
   * spanning too many layers), until the network or its layout changes.
   */
  get failure(): string | undefined {
    return this.#failure;
  }

  /**
   * Works on the layout as `clock` allows between frames that draw it (see
   * `due`): the next one draws what has been done.
   */
  work(clock: LayoutClock): void {
    this.#clock = clock;
    this.#work(clock);
  }

  /**
   * Whether a frame should draw the positions now, at `now`: work is done,
   * nodes are easing, or, unless motion is reduced, the work in progress
   * has not been shown for a while (in small networks, at every frame).
   */
  due(now: number, animate: boolean): boolean {
    const job = this.#job;
    if (!job || job.kind === "settle") return !job || this.#ease !== undefined;
    // A layered layout shows nothing until it is done.
    if (job.kind === "layered" || !this.#own || !animate) return false;
    const network = this.#network!;
    const large = network.names.length + network.source.length > LARGE;
    return !large || now - this.#shownAt >= SHOW_EVERY;
  }

  /**
   * How what is shown fits a room, by a key of the room: `make`'s fit,
   * kept while the layout's own positions are (not while nodes settle or
   * ease), so the view holds as nodes move around a moved one.
   */
  fit(room: string, make: () => LayoutFit): LayoutFit {
    let fit = this.#fits.get(room);
    if (!fit) {
      if (this.#fits.size > 8) this.#fits.clear();
      fit = make();
      this.#fits.set(room, fit);
    }
    return fit;
  }

  /**
   * Brings the positions up to date with the network, its layout, and the
   * nodes held by hand (by node index), then works as `clock` allows.
   */
  update(
    network: LayoutNetwork,
    layout: NetworkLayout,
    held: ReadonlyMap<number, readonly [number, number]>,
    clock: LayoutClock | undefined,
  ): void {
    const again = clock !== undefined && clock === this.#clock;
    this.#clock = clock;
    if (network !== this.#network || !sameLayout(layout, this.#layout))
      this.#arrange(network, layout, clock);
    // The layout's own first; once they are there, the nodes settle around those held.
    if (!again) this.#work(clock);
    if (!this.#job && this.#own && !sameHeld(network, held, this.#held)) {
      this.#settle(network, layout, held);
      if (!again) this.#work(clock);
    }
    if (!again) this.#show(clock);
  }

  /** Lets go of a layered layout's bend points, and of the copy fitted with them. */
  #dropRoutes(): void {
    this.#routes = undefined;
    this.#withBends = undefined;
  }

  #arrange(network: LayoutNetwork, layout: NetworkLayout, clock: LayoutClock | undefined): void {
    const before = this.#network;
    const job = this.#job;
    const same = this.#layout?.type === layout.type;
    // Data that changes nothing the layout reads keeps everything as it is;
    // work for a network before the last goes on for it.
    if (before && sameLayout(layout, this.#layout) && sameInputs(before, network, layout)) {
      this.#network = network;
      if (job && job.kind !== "settle" && job.network === before) job.network = network;
      // Springs of other strengths settle nodes otherwise.
      if (!sameStrengths(before, network)) {
        this.#held = undefined;
        if (job?.kind === "settle") this.#job = undefined;
      }
      return;
    }
    this.#network = network;
    this.#layout = layout;
    this.#ease = undefined;
    this.#held = undefined;
    this.#settled = undefined;
    this.#failure = undefined;
    const reduced = clock?.animate === false;
    // Work on an earlier network that must end before it can be carried
    // into this one goes on: a force layout whose nodes do not all have
    // places yet, and a layered layout. Meanwhile nodes show where they were.
    const previous = before && this.#own && same ? remap(before, this.#own, network) : undefined;
    if (same && (job?.kind === "layered" || (job?.kind === "layout" && !job.simulation.placed))) {
      this.#own = previous && placeNew(network, previous).start;
      this.#dropRoutes();
      this.#publish(this.#own && Float64Array.from(this.#own));
      return;
    }
    this.#job = undefined;
    this.#dropRoutes();
    this.#reversed = 0;
    this.#fits.clear();
    if (layout.type === "circular") {
      const order = circularOrder(network, layout.sort);
      let own = layoutCircular(order, network.group);
      if (previous) own = layoutCircular(order, network.group, bestTurn(previous, own));
      this.#own = own;
    } else if (layout.type === "layered") {
      this.#layered(previous && placeNew(network, previous).start);
    } else if (!previous) {
      this.#own = undefined;
      this.#job = {
        kind: "layout",
        network,
        simulation: new ForceSimulation(forceGraph(network)),
        first: true,
      };
    } else this.#carry(before!, previous, job?.kind === "layout" ? job : undefined);
    // Shown at once as they start, so what is shown is always of this network.
    this.#publish(this.#own && (reduced ? Float64Array.from(this.#own) : this.#own));
  }

  /**
   * Carries a force layout into `#network` from `before`'s positions
   * (`previous`, remapped): new nodes beside their placed neighbors, new
   * components apart, and the nodes near what changed moved; a simulation
   * under way (`running`) goes on, with its moving nodes, alpha, and ticks.
   */
  #carry(
    before: LayoutNetwork,
    previous: Float64Array,
    running: Extract<Job, { kind: "layout" }> | undefined,
  ): void {
    const network = this.#network!;
    const n = network.names.length;
    const { start, changed, lonely } = seed(network, previous, before);
    this.#own = start;
    if (changed.length === 0 && !running) return;
    let moving: Int32Array | undefined = neighborhood(
      network,
      changed,
      new Map(),
      n,
      Number.POSITIVE_INFINITY,
    );
    let all = moving.length > n * LOCAL_SHARE;
    // A run under way goes on as it was, unless something changed, which reheats it.
    let { alpha, ticks } =
      running && changed.length === 0 ? { alpha: 0, ticks: 0 } : all ? UPDATE_ALL : UPDATE;
    if (running) {
      const was = running.simulation;
      // Its moving nodes, by name, move still.
      if (!was.moving) all = true;
      else if (!all) {
        const both = new Set(moving);
        for (const node of was.moving) {
          const now = network.nodeOf.get(running.network.names[node]!);
          if (now !== undefined) both.add(now);
        }
        moving = Int32Array.from(both).sort();
        all = moving.length > n * LOCAL_SHARE;
      }
      alpha = Math.max(alpha, was.alpha);
      ticks = Math.max(ticks, was.ticksLeft);
    }
    const first = running?.first === true;
    this.#job = {
      kind: "layout",
      network,
      simulation: new ForceSimulation(forceGraph(network), {
        start,
        moving: all ? undefined : moving,
        alpha,
        ticks,
        arrange: lonely,
        pack: first,
      }),
      first,
    };
  }

  /** Starts a layered layout of `#network`, nodes starting in the order `start` gives them. */
  #layered(start: Float64Array | undefined): void {
    const network = this.#network!;
    const { direction } = this.#layout as Extract<NetworkLayout, { type: "layered" }>;
    this.#own = start;
    this.#job = {
      kind: "layered",
      network,
      steps: layeredSteps(constraints(network), direction, start),
    };
  }

  /** Works out the settled positions for the nodes held now, or takes the layout's own. */
  #settle(
    network: LayoutNetwork,
    layout: NetworkLayout,
    held: ReadonlyMap<number, readonly [number, number]>,
  ): void {
    const own = this.#own!;
    this.#held = namesOf(network, held);
    // Nodes ease to the new places from wherever they are shown.
    this.#ease = undefined;
    if (layout.type !== "force" || !layout.settle || held.size === 0) {
      this.#settled = own;
      return;
    }
    const moving = neighborhood(network, [...held.keys()], held, SETTLING, SETTLING_LINKS, own);
    this.#settled = undefined;
    this.#job = {
      kind: "settle",
      simulation: new ForceSimulation(forceGraph(network), {
        start: own,
        held,
        moving,
        alpha: SETTLE_ALPHA,
        ticks: SETTLE_TICKS,
      }),
      held,
    };
  }

  /** Works as `clock` allows. */
  #work(clock: LayoutClock | undefined): void {
    const job = this.#job;
    if (!job) return;
    const deadline = clock?.deadline ?? Number.POSITIVE_INFINITY;
    if (job.kind === "layered") {
      for (;;) {
        let step: IteratorResult<void, Layered>;
        try {
          step = job.steps.next();
        } catch (error) {
          if (!(error instanceof RangeError)) throw error;
          this.#job = undefined;
          // A network the data has changed since failed: lay out the one it is now.
          if (job.network !== this.#network) {
            this.#layered(this.#own);
            return;
          }
          this.#own = undefined;
          this.#publish(undefined);
          this.#failure = error.message;
          return;
        }
        if (step.done) {
          this.#job = undefined;
          this.#fits.clear();
          const network = this.#network!;
          if (job.network === network) {
            const { starts, bends, positions, reversed } = step.value;
            this.#routes = { starts, bends };
            this.#reversed = reversed;
            this.#own = positions;
            // Links bend out past the nodes; the room fits them too.
            this.#withBends = new Float64Array(positions.length + bends.length);
            this.#withBends.set(positions);
            this.#withBends.set(bends, positions.length);
            return;
          }
          // The data changed meanwhile: lay out the network it is now, from these places.
          this.#layered(placeNew(network, remap(job.network, step.value.positions, network)).start);
          this.#publish(this.#own && Float64Array.from(this.#own));
          return;
        }
        if (clock && performance.now() > deadline) return;
      }
    }
    const { simulation } = job;
    const done = simulation.run(deadline);
    if (job.kind === "settle") {
      if (!done) return;
      // Held nodes keep their own places; the simulation held them where they are held.
      const settled = Float64Array.from(this.#own!);
      copyFree(simulation.positions, settled, job.held);
      this.#settled = settled;
      this.#ease = undefined;
      this.#job = undefined;
      return;
    }
    if (done) this.#job = undefined;
    if (job.network !== this.#network) {
      // A layout whose nodes all have places goes on in the network the data changed to.
      if (!simulation.placed && !done) return;
      this.#fits.clear();
      const network = this.#network!;
      this.#carry(
        job.network,
        remap(job.network, simulation.positions, network),
        done ? undefined : job,
      );
      this.#publish(
        this.#own && (clock?.animate === false ? Float64Array.from(this.#own) : this.#own),
      );
      return;
    }
    if (!simulation.started) return;
    this.#fits.clear();
    this.#own = simulation.positions;
    // What shows the layout changed in place.
    this.#revision++;
  }

  /** Shows what there is to show: work as it goes, or the settled positions, eased toward. */
  #show(clock: LayoutClock | undefined): void {
    const animate = clock?.animate !== false && clock !== undefined;
    const job = this.#job;
    if (job && job.kind !== "settle") {
      // The layout's own as they are worked out, unless motion is reduced:
      // then where they start, until they are done.
      if (!this.#own) {
        if (this.#shown) this.#publish(undefined);
      } else if (job.kind === "layout" && (animate || !this.#shown)) {
        const shown = animate ? this.#own : Float64Array.from(this.#own);
        this.#publish(shown, shown);
        if (clock) this.#shownAt = clock.now;
      }
      return;
    }
    const target = this.#settled;
    if (!target) return;
    if (this.#ease === undefined && this.#shown !== target) {
      // Nodes ease from where they are shown to where they settle.
      const from = this.#shown;
      if (!animate || !from || from.length !== target.length) {
        this.#publish(target);
        return;
      }
      const nodes: number[] = [];
      for (let node = 0; node < target.length / 2; node++)
        if (from[node * 2] !== target[node * 2] || from[node * 2 + 1] !== target[node * 2 + 1])
          nodes.push(node);
      if (nodes.length === 0) {
        this.#publish(target);
        return;
      }
      this.#ease = {
        from: Float64Array.from(from),
        nodes: Int32Array.from(nodes),
        began: undefined,
      };
    }
    const ease = this.#ease;
    if (!ease) return;
    ease.began ??= clock?.now;
    const t = clock && ease.began !== undefined ? (clock.now - ease.began) / EASE_MS : 1;
    if (t >= 1 || !animate) {
      this.#ease = undefined;
      this.#publish(target);
      return;
    }
    // Eased out: quick at first, slowing as nodes arrive.
    const e = 1 - (1 - t) ** 3;
    const shown = Float64Array.from(target);
    for (const node of ease.nodes)
      for (const axis of [0, 1]) {
        const at = node * 2 + axis;
        shown[at] = ease.from[at]! + (target[at]! - ease.from[at]!) * e;
      }
    this.#publish(shown);
  }

  #publish(
    positions: Float64Array | undefined,
    fitTo = this.#routes ? this.#withBends : this.#own,
  ): void {
    this.#shown = positions;
    this.#fitTo = fitTo;
    this.#revision++;
  }
}

/**
 * Whether a changed network reads the same for `layout`: the same nodes in
 * the same order, the same links in the same order, and for a circle the
 * same groups, for layers the same ways links' rows run. Values (but for
 * the settled positions, see `sameStrengths`), colors, and labels aside.
 */
function sameInputs(before: LayoutNetwork, network: LayoutNetwork, layout: NetworkLayout): boolean {
  const n = network.names.length;
  if (before.names.length !== n || before.source.length !== network.source.length) return false;
  if (before.directed !== network.directed) return false;
  for (let node = 0; node < n; node++) if (before.names[node] !== network.names[node]) return false;
  if (layout.type === "circular")
    for (let node = 0; node < n; node++)
      if (before.group[node] !== network.group[node]) return false;
  // The same links in the same order (a layered layout's routes are by link), the same ways.
  const { source, target } = network;
  for (let link = 0; link < source.length; link++) {
    if (before.source[link] !== source[link] || before.target[link] !== target[link]) return false;
    if (layout.type === "layered" && before.ways[link] !== network.ways[link]) return false;
  }
  return true;
}

/** Whether links pull alike in both networks (of the same links, see `sameInputs`). */
function sameStrengths(before: LayoutNetwork, network: LayoutNetwork): boolean {
  const [a, b] = [before.strength, network.strength];
  if (!a || !b) return a === b;
  for (let link = 0; link < a.length; link++) if (a[link] !== b[link]) return false;
  return true;
}

/** Whether the nodes held, by index of `network`, are those `names` holds, where it holds them. */
function sameHeld(
  network: LayoutNetwork,
  held: ReadonlyMap<number, readonly [number, number]>,
  names: ReadonlyMap<string, readonly [number, number]> | undefined,
): boolean {
  if (!names || names.size !== held.size) return false;
  for (const [node, [x, y]] of held) {
    const at = names.get(network.names[node]!);
    if (!at || at[0] !== x || at[1] !== y) return false;
  }
  return true;
}

function sameLayout(a: NetworkLayout, b: NetworkLayout | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Held nodes by name, as work takes them in. */
function namesOf(
  network: LayoutNetwork,
  held: ReadonlyMap<number, readonly [number, number]>,
): Map<string, readonly [number, number]> {
  const out = new Map<string, readonly [number, number]>();
  for (const [node, at] of held) out.set(network.names[node]!, at);
  return out;
}

/** Copies x, y of every node but those held. */
function copyFree(
  from: Float64Array,
  to: Float64Array,
  held: ReadonlyMap<number, readonly [number, number]>,
): void {
  if (held.size === 0) {
    to.set(from);
    return;
  }
  for (let node = 0; node < from.length / 2; node++) {
    if (held.has(node)) continue;
    to[node * 2] = from[node * 2]!;
    to[node * 2 + 1] = from[node * 2 + 1]!;
  }
}

/** x, y per node of `next` where the node was in `before`, NaN for nodes new to it. */
function remap(before: LayoutNetwork, positions: Float64Array, next: LayoutNetwork): Float64Array {
  const out = new Float64Array(next.names.length * 2).fill(Number.NaN);
  next.names.forEach((name, node) => {
    const old = before.nodeOf.get(name);
    if (old === undefined) return;
    out[node * 2] = positions[old * 2]!;
    out[node * 2 + 1] = positions[old * 2 + 1]!;
  });
  return out;
}

/** Neighbors per node, from the links. */
function adjacency(network: LayoutNetwork): { starts: Int32Array; neighbors: Int32Array } {
  const n = network.names.length;
  const { source, target } = network;
  const starts = new Int32Array(n + 1);
  for (let link = 0; link < source.length; link++) {
    starts[source[link]! + 1]!++;
    starts[target[link]! + 1]!++;
  }
  for (let i = 0; i < n; i++) starts[i + 1]! += starts[i]!;
  const neighbors = new Int32Array(starts[n]!);
  const at = starts.slice(0, n);
  for (let link = 0; link < source.length; link++) {
    neighbors[at[source[link]!]!++] = target[link]!;
    neighbors[at[target[link]!]!++] = source[link]!;
  }
  return { starts, neighbors };
}

/**
 * Where a force layout of changed data starts (see `placeNew`), and the
 * nodes the change touched: new ones, and those that gained or lost links.
 */
function seed(
  network: LayoutNetwork,
  previous: Float64Array,
  before: LayoutNetwork,
): { start: Float64Array; changed: number[]; lonely: Int32Array[] } {
  const n = network.names.length;
  const touched = new Uint8Array(n);
  const oldOf = Int32Array.from(network.names, (name) => before.nodeOf.get(name) ?? -1);
  for (let node = 0; node < n; node++) if (oldOf[node]! < 0) touched[node] = 1;
  const { source, target } = network;
  for (let link = 0; link < source.length; link++) {
    const [s, t] = [source[link]!, target[link]!];
    const [os, ot] = [oldOf[s]!, oldOf[t]!];
    if (os < 0 || ot < 0 || before.linkOf.get(pairKey(before, os, ot)) === undefined)
      touched[s] = touched[t] = 1;
  }
  for (let link = 0; link < before.source.length; link++) {
    const s = network.nodeOf.get(before.names[before.source[link]!]!);
    const t = network.nodeOf.get(before.names[before.target[link]!]!);
    if (s === undefined || t === undefined) {
      if (s !== undefined) touched[s] = 1;
      if (t !== undefined) touched[t] = 1;
    } else if (network.linkOf.get(pairKey(network, s, t)) === undefined)
      touched[s] = touched[t] = 1;
  }
  const changed: number[] = [];
  for (let node = 0; node < n; node++) if (touched[node]) changed.push(node);
  return { ...placeNew(network, previous), changed };
}

/**
 * Places nodes without a place (NaN): beside the mean of their placed
 * neighbors, nearest the placed first, each a little off in a direction its
 * name gives. Components reaching no placed node (`lonely`) start on a
 * small spiral right of the rest, for a force layout to lay them out apart
 * (see `ForceRun.arrange`): pivot MDS of a large component takes longer
 * than a frame.
 */
function placeNew(
  network: LayoutNetwork,
  positions: Float64Array,
): { start: Float64Array; lonely: Int32Array[] } {
  const n = network.names.length;
  const start = Float64Array.from(positions);
  const placed = new Uint8Array(n);
  const queue = new Int32Array(n);
  let end = 0;
  for (let node = 0; node < n; node++)
    if (Number.isFinite(start[node * 2]!)) {
      placed[node] = 1;
      queue[end++] = node;
    }
  if (end === n) return { start, lonely: [] };
  const { starts, neighbors } = adjacency(network);
  const reached = placed.slice();
  for (let at = 0; at < end; at++) {
    const node = queue[at]!;
    if (!placed[node]) {
      let [sx, sy, count] = [0, 0, 0];
      for (let k = starts[node]!; k < starts[node + 1]!; k++) {
        const other = neighbors[k]!;
        if (!placed[other]) continue;
        sx += start[other * 2]!;
        sy += start[other * 2 + 1]!;
        count++;
      }
      const angle = (hash(network.names[node]!) / 4294967296) * 2 * Math.PI;
      start[node * 2] = sx / count + (LINK_DISTANCE / 3) * Math.cos(angle);
      start[node * 2 + 1] = sy / count + (LINK_DISTANCE / 3) * Math.sin(angle);
      placed[node] = 1;
    }
    for (let k = starts[node]!; k < starts[node + 1]!; k++) {
      const other = neighbors[k]!;
      if (reached[other]) continue;
      reached[other] = 1;
      queue[end++] = other;
    }
  }
  if (end === n) return { start, lonely: [] };
  const lonely = componentsOf(n, { starts, neighbors }).filter((members) => !placed[members[0]!]);
  let [x1, y0, y1] = [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (let node = 0; node < n; node++) {
    if (!placed[node]) continue;
    x1 = Math.max(x1, start[node * 2]!);
    y0 = Math.min(y0, start[node * 2 + 1]!);
    y1 = Math.max(y1, start[node * 2 + 1]!);
  }
  // A spiral of nodes a third of a link apart, its left edge a link right of the rest.
  let count = 0;
  for (const members of lonely) count += members.length;
  const radius = (LINK_DISTANCE / 3) * Math.sqrt(count);
  const cx = (Number.isFinite(x1) ? x1 + LINK_DISTANCE : 0) + radius;
  const cy = Number.isFinite(y0) ? (y0 + y1) / 2 : 0;
  let k = 0;
  for (const members of lonely)
    for (const node of members) {
      const r = (LINK_DISTANCE / 3) * Math.sqrt(k + 0.5);
      const angle = k++ * 2.399963;
      start[node * 2] = cx + r * Math.cos(angle);
      start[node * 2 + 1] = cy + r * Math.sin(angle);
    }
  return { start, lonely };
}

/**
 * The nodes that move around `changed`: those within `HOPS` links of them,
 * breadth first, and with `positions`, those near where changed nodes are
 * held; held nodes never. At most `limit` nodes, with at most `links`
 * links between them, in that order.
 */
function neighborhood(
  network: LayoutNetwork,
  changed: readonly number[],
  held: ReadonlyMap<number, readonly [number, number]>,
  limit: number,
  links: number,
  positions?: Float64Array,
): Int32Array {
  const n = network.names.length;
  const { starts, neighbors } = adjacency(network);
  const depth = new Int32Array(n).fill(-1);
  const queue: number[] = [];
  // From the changed nodes in index order, whatever order they came in, so
  // the nodes kept under the limits are the same for the same changes.
  const sorted = [...changed].sort((a, b) => a - b);
  for (const node of sorted) {
    if (depth[node]! >= 0) continue;
    depth[node] = 0;
    queue.push(node);
  }
  for (let at = 0; at < queue.length; at++) {
    const node = queue[at]!;
    if (depth[node]! >= HOPS) continue;
    for (let k = starts[node]!; k < starts[node + 1]!; k++) {
      const other = neighbors[k]!;
      if (depth[other]! >= 0) continue;
      depth[other] = depth[node]! + 1;
      queue.push(other);
    }
  }
  if (positions) {
    // Nodes near where changed nodes are held, found through a grid of cells NEAR wide.
    const cells = new Map<number, number[]>();
    const cellOf = (x: number, y: number) =>
      Math.floor(x / NEAR) * 1_048_576 + Math.floor(y / NEAR);
    for (let other = 0; other < n; other++) {
      const cell = cellOf(positions[other * 2]!, positions[other * 2 + 1]!);
      let list = cells.get(cell);
      if (!list) {
        list = [];
        cells.set(cell, list);
      }
      list.push(other);
    }
    for (const node of sorted) {
      const at = held.get(node);
      if (!at) continue;
      const [cx, cy] = [Math.floor(at[0] / NEAR), Math.floor(at[1] / NEAR)];
      // Offsets rather than counting cells: far out, cx + 1 can be cx.
      for (const dx of [-1, 0, 1])
        for (const dy of [-1, 0, 1])
          for (const other of cells.get((cx + dx) * 1_048_576 + cy + dy) ?? []) {
            if (depth[other]! >= 0) continue;
            const dx = positions[other * 2]! - at[0];
            const dy = positions[other * 2 + 1]! - at[1];
            if (dx * dx + dy * dy > NEAR * NEAR) continue;
            depth[other] = HOPS;
            queue.push(other);
          }
    }
  }
  const out: number[] = [];
  let springs = 0;
  for (const node of queue) {
    if (held.has(node)) continue;
    springs += starts[node + 1]! - starts[node]!;
    if (out.length >= limit || springs > links) break;
    out.push(node);
  }
  return Int32Array.from(out).sort();
}

/** The springs of a network's force layout: heavier links pull somewhat harder. */
function forceGraph(network: LayoutNetwork) {
  return {
    nodes: network.names.length,
    source: network.source,
    target: network.target,
    strength: network.strength,
  };
}

/** The order of nodes around a circle: by group (none last), then by `sort`, ties by name. */
function circularOrder(network: LayoutNetwork, sort: "degree" | "input" | "name"): Int32Array {
  const n = network.names.length;
  // Degrees count neighbors: a pair's links each way are one.
  const degree = new Int32Array(n);
  const { source, target } = network;
  for (let link = 0; link < source.length; link++) {
    const [s, t] = [source[link]!, target[link]!];
    if (network.directed && s > t && network.linkOf.has(pairKey(network, t, s))) continue;
    degree[s]!++;
    degree[t]!++;
  }
  const names = network.names;
  const byName = (a: number, b: number) =>
    names[a]! < names[b]! ? -1 : names[a]! > names[b]! ? 1 : 0;
  const groupOf = (node: number) =>
    network.group[node]! < 0 ? Number.MAX_SAFE_INTEGER : network.group[node]!;
  const order = Array.from({ length: n }, (_, i) => i);
  order.sort(
    (a, b) =>
      groupOf(a) - groupOf(b) ||
      (sort === "degree" ? degree[b]! - degree[a]! || byName(a, b) : 0) ||
      (sort === "name" ? byName(a, b) : 0) ||
      a - b,
  );
  return Int32Array.from(order);
}

/** A layered layout's constraints: each link's rows, from source to target, either way they run. */
function constraints(network: LayoutNetwork) {
  const from: number[] = [];
  const to: number[] = [];
  const { source, target, ways } = network;
  for (let link = 0; link < source.length; link++) {
    if (ways[link]! & 1) {
      from.push(source[link]!);
      to.push(target[link]!);
    }
    if (ways[link]! & 2) {
      from.push(target[link]!);
      to.push(source[link]!);
    }
  }
  return {
    nodes: network.names.length,
    from: Int32Array.from(from),
    to: Int32Array.from(to),
    source,
    target,
  };
}

/** FNV-1a: a node's name as 32 bits, for directions that do not depend on its index. */
function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}
