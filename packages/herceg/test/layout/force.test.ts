import { describe, expect, it } from "vitest";
import {
  type ForceGraph,
  ForceSimulation,
  fitLayout as fitWith,
  LINK_DISTANCE,
  layoutFit,
  layoutForce,
  separate,
} from "../../src/layout/force.ts";

/** A graph from pairs of node indices. */
function graphOf(nodes: number, pairs: readonly (readonly [number, number])[]): ForceGraph {
  return {
    nodes,
    source: Int32Array.from(pairs, ([s]) => s),
    target: Int32Array.from(pairs, ([, t]) => t),
  };
}

const ring = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => [from + i, from + ((i + 1) % n)] as const);

const point = (positions: Float64Array, i: number) =>
  [positions[i * 2]!, positions[i * 2 + 1]!] as const;
const distance = (positions: Float64Array, i: number, j: number) => {
  const [x0, y0] = point(positions, i);
  const [x1, y1] = point(positions, j);
  return Math.hypot(x1 - x0, y1 - y0);
};

/** A random tree with extra links, from a fixed seed. */
function randomGraph(nodes: number, seed = 7): ForceGraph {
  let s = seed;
  const random = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  const pairs: [number, number][] = [];
  for (let i = 1; i < nodes; i++) pairs.push([i, Math.floor(random() * i)]);
  for (let i = 0; i < nodes / 2; i++)
    pairs.push([Math.floor(random() * nodes), Math.floor(random() * nodes)]);
  return graphOf(nodes, pairs);
}

describe("layoutForce", () => {
  it("is deterministic", () => {
    const graph = randomGraph(300);
    expect(layoutForce(graph)).toEqual(layoutForce(graph));
    const small = graphOf(5, [
      [0, 1],
      [1, 2],
      [3, 4],
    ]);
    expect(layoutForce(small)).toEqual(layoutForce(small));
  });

  it("settles a ring into a regular polygon", () => {
    const positions = layoutForce(graphOf(12, ring(12)));
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < 12; i++) {
      cx += positions[i * 2]! / 12;
      cy += positions[i * 2 + 1]! / 12;
    }
    const radii = Array.from({ length: 12 }, (_, i) => {
      const [x, y] = point(positions, i);
      return Math.hypot(x - cx, y - cy);
    });
    const mean = radii.reduce((a, b) => a + b) / 12;
    for (const r of radii) expect(Math.abs(r - mean) / mean).toBeLessThan(0.02);
    // Neighbors are evenly spaced, near the link distance.
    const sides = ring(12).map(([i, j]) => distance(positions, i, j));
    for (const side of sides) {
      expect(Math.abs(side - sides[0]!) / sides[0]!).toBeLessThan(0.02);
      expect(side).toBeGreaterThan(LINK_DISTANCE * 0.8);
      expect(side).toBeLessThan(LINK_DISTANCE * 1.6);
    }
  });

  it("unfolds a long chain, which a spiral start leaves folded", () => {
    const chain = Array.from({ length: 29 }, (_, i) => [i, i + 1] as const);
    const positions = layoutForce(graphOf(30, chain));
    // End to end, it spans most of its length.
    expect(distance(positions, 0, 29)).toBeGreaterThan(29 * LINK_DISTANCE * 0.7);
  });

  it("keeps separate components apart, near each other", () => {
    // Two rings of 8 and a lone node.
    const positions = layoutForce(graphOf(17, [...ring(8), ...ring(8, 8)]));
    const extent = (from: number, to: number) => {
      let [cx, cy] = [0, 0];
      for (let i = from; i < to; i++) {
        cx += positions[i * 2]! / (to - from);
        cy += positions[i * 2 + 1]! / (to - from);
      }
      let r = 0;
      for (let i = from; i < to; i++) {
        const [x, y] = point(positions, i);
        r = Math.max(r, Math.hypot(x - cx, y - cy));
      }
      return { cx, cy, r };
    };
    const a = extent(0, 8);
    const b = extent(8, 16);
    const gap = Math.hypot(a.cx - b.cx, a.cy - b.cy) - a.r - b.r;
    expect(gap).toBeGreaterThan(5);
    // Packing keeps components (and the lone node) close.
    expect(gap).toBeLessThan(a.r);
    const lone = point(positions, 16);
    expect(Math.hypot(lone[0] - a.cx, lone[1] - a.cy)).toBeLessThan(a.r * 4);
  });

  it("keeps components of any shape from overlapping", () => {
    // Ten components of 24 nodes: cliques, stars, and rings, mixed.
    const shapes = [
      "clique",
      "star",
      "ring",
      "star",
      "clique",
      "clique",
      "star",
      "star",
      "star",
      "ring",
    ];
    const pairs: [number, number][] = [];
    shapes.forEach((shape, c) => {
      const at = c * 24;
      for (let i = 0; i < 24; i++) {
        if (shape === "ring") pairs.push([at + i, at + ((i + 1) % 24)]);
        if (shape === "star" && i > 0) pairs.push([at, at + i]);
        if (shape === "clique") for (let j = i + 1; j < 24; j++) pairs.push([at + i, at + j]);
      }
    });
    const positions = layoutForce(graphOf(240, pairs));
    const boxes = shapes.map((_, c) => {
      const xs = Array.from({ length: 24 }, (_, i) => positions[(c * 24 + i) * 2]!);
      const ys = Array.from({ length: 24 }, (_, i) => positions[(c * 24 + i) * 2 + 1]!);
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] as const;
    });
    for (const [i, a] of boxes.entries())
      for (const b of boxes.slice(i + 1))
        expect(a[0] > b[2] || b[0] > a[2] || a[1] > b[3] || b[1] > a[3]).toBe(true);
  });

  it("ignores links to a node itself or outside the graph, and copes with nodes at one place", () => {
    const positions = layoutForce(
      graphOf(3, [
        [0, 0],
        [0, 1],
        [1, 7],
        [-1, 2],
      ]),
    );
    expect(positions).toHaveLength(6);
    for (const v of positions) expect(Number.isFinite(v)).toBe(true);
    expect(distance(positions, 0, 1)).toBeLessThan(LINK_DISTANCE * 1.6);
    expect(layoutForce(graphOf(0, []))).toEqual(new Float64Array(0));
    expect(layoutForce(graphOf(1, []))).toHaveLength(2);
  });

  it("weakens springs by link strength", () => {
    // A star whose spokes pull with different strengths: the weak spoke is longer.
    const star = graphOf(
      6,
      [1, 2, 3, 4, 5].map((i) => [0, i] as const),
    );
    const strong = layoutForce(star);
    const weak = layoutForce({ ...star, strength: Float64Array.from([1, 1, 1, 1, 0.2]) });
    expect(distance(weak, 0, 5)).toBeGreaterThan(distance(strong, 0, 5) + 1);
  });

  it("lays out thousands of nodes with a quadtree, without NaN, in bounded time", () => {
    const graph = randomGraph(2000);
    const start = performance.now();
    const positions = layoutForce(graph);
    // About 0.3 s on a laptop; the bound only catches a lost quadtree.
    expect(performance.now() - start).toBeLessThan(5000);
    for (const v of positions) expect(Number.isFinite(v)).toBe(true);
    // Linked nodes end up far closer than nodes picked at random.
    let linked = 0;
    for (let link = 0; link < graph.source.length; link++)
      linked += distance(positions, graph.source[link]!, graph.target[link]!);
    let random = 0;
    for (let i = 0; i < 2000; i++) random += distance(positions, i, (i * 7919) % 2000);
    expect(linked / graph.source.length).toBeLessThan((random / 2000) * 0.5);
  });

  it("approximates repulsion closely above the exact limit", () => {
    // 150 nodes are summed exactly, 151 with the quadtree: the spread barely changes.
    const spread = (nodes: number) => {
      const positions = layoutForce(randomGraph(nodes, 3));
      let [cx, cy] = [0, 0];
      for (let i = 0; i < nodes; i++) {
        cx += positions[i * 2]! / nodes;
        cy += positions[i * 2 + 1]! / nodes;
      }
      let sum = 0;
      for (let i = 0; i < nodes; i++) {
        const [x, y] = point(positions, i);
        sum += Math.hypot(x - cx, y - cy);
      }
      return sum / nodes;
    };
    expect(spread(151) / spread(150)).toBeCloseTo(1, 1);
  });
});

/** Layout positions placed in a room as `layoutFit` fits them. */
const fitLayout = (
  positions: Float64Array,
  room: { x: number; y: number; width: number; height: number },
  options: { inset: number; maxScale: number; maxStretch: number },
) => fitWith(positions, layoutFit(positions, room, options));

describe("ForceSimulation", () => {
  it("ends where an uninterrupted run does, however its steps spread over deadlines", () => {
    const graph = randomGraph(400);
    const whole = layoutForce(graph);
    const sliced = new ForceSimulation(graph);
    let calls = 0;
    // Deadlines already past: every call takes one step.
    while (!sliced.run(0)) calls++;
    expect(calls).toBeGreaterThan(300);
    expect(sliced.positions).toEqual(whole);
    // A run limited to some ticks stops there and goes on from there.
    const paced = new ForceSimulation(graph);
    paced.run(Number.POSITIVE_INFINITY, 10);
    expect(paced.ticked).toBe(10);
    expect(paced.done).toBe(false);
    paced.run();
    expect(paced.positions).toEqual(whole);
  });

  it("holds nodes where they are held, and moves only the nodes it is given", () => {
    const graph = graphOf(12, ring(12));
    const start = layoutForce(graph);
    const held = new Map([[0, [500, 400] as const]]);
    const moving = Int32Array.of(1, 11);
    const positions = layoutForce(graph, { start, held, moving, alpha: 0.3, ticks: 40 });
    expect(point(positions, 0)).toEqual([500, 400]);
    // Its neighbors are pulled toward it; nodes not moving stay exactly.
    for (const node of [1, 11])
      expect(Math.hypot(positions[node * 2]! - 500, positions[node * 2 + 1]! - 400)).toBeLessThan(
        Math.hypot(start[node * 2]! - 500, start[node * 2 + 1]! - 400),
      );
    for (let node = 2; node < 11; node++)
      expect(point(positions, node)).toEqual(point(start, node));
    // The same with a quadtree: still nodes push through one built once.
    const large = randomGraph(600);
    const laid = layoutForce(large);
    const some = Int32Array.from({ length: 40 }, (_, i) => i + 1);
    const settled = layoutForce(large, { start: laid, held, moving: some, alpha: 0.3, ticks: 40 });
    for (let node = 41; node < 600; node++) expect(point(settled, node)).toEqual(point(laid, node));
    for (const v of settled) expect(Number.isFinite(v)).toBe(true);
  });

  it("says its nodes are placed only once components to lay out apart are", () => {
    const graph = graphOf(6, [
      [0, 1],
      [2, 3],
      [3, 4],
      [4, 5],
    ]);
    const start = Float64Array.of(0, 0, 30, 0, 100, 0, 100.1, 0, 100.2, 0, 100.3, 0);
    const run = new ForceSimulation(graph, {
      start,
      arrange: [Int32Array.of(2, 3, 4, 5)],
      ticks: 5,
    });
    expect(run.started).toBe(true);
    expect(run.placed).toBe(false);
    run.run();
    expect(run.placed).toBe(true);
    // Laid out apart, the chain's links are about a link long.
    expect(distance(run.positions, 2, 3)).toBeGreaterThan(LINK_DISTANCE / 2);
  });

  it("starts from pivot MDS only without a start, and says when it has started", () => {
    const fresh = new ForceSimulation(randomGraph(300));
    expect(fresh.started).toBe(false);
    fresh.run(0);
    fresh.run();
    expect(fresh.started).toBe(true);
    const start = layoutForce(randomGraph(300));
    expect(new ForceSimulation(randomGraph(300), { start }).started).toBe(true);
  });
});

describe("fitLayout", () => {
  const room = { x: 10, y: 20, width: 200, height: 100 };

  it("centers and scales into the room, stretching one axis a little", () => {
    const fitted = fitLayout(Float64Array.from([0, 0, 100, 100]), room, {
      inset: 5,
      maxScale: 10,
      maxStretch: 1.5,
    });
    // Height limits: 90 / 100; width may stretch to 1.5 times that.
    expect(Array.from(fitted)).toEqual([42.5, 25, 177.5, 115]);
  });

  it("caps the scale, and puts lone or coincident nodes in the middle", () => {
    const options = { inset: 5, maxScale: 2, maxStretch: 1 };
    expect(Array.from(fitLayout(Float64Array.from([0, 0, 10, 0]), room, options))).toEqual([
      100, 70, 120, 70,
    ]);
    expect(Array.from(fitLayout(Float64Array.from([3, 4]), room, options))).toEqual([110, 70]);
    expect(Array.from(fitLayout(Float64Array.from([3, 4, 3, 4]), room, options))).toEqual([
      110, 70, 110, 70,
    ]);
    expect(fitLayout(new Float64Array(0), room, options)).toHaveLength(0);
  });
});

describe("separate", () => {
  it("pushes overlapping circles apart, inside the room", () => {
    const room = { x: 0, y: 0, width: 100, height: 100 };
    const positions = Float64Array.from([50, 50, 52, 50, 50, 50, 1, 1]);
    const radii = Float64Array.from([5, 5, 3, 4]);
    separate(positions, radii, room, 1, 20);
    for (let i = 0; i < 4; i++) {
      for (let j = i + 1; j < 4; j++)
        expect(distance(positions, i, j)).toBeGreaterThan(radii[i]! + radii[j]! + 0.5);
      const [x, y] = point(positions, i);
      expect(x).toBeGreaterThanOrEqual(radii[i]!);
      expect(y).toBeGreaterThanOrEqual(radii[i]!);
    }
    // Circles already apart stay where they are.
    const apart = Float64Array.from([10, 10, 50, 50]);
    separate(apart, Float64Array.from([3, 3]), room, 1);
    expect(Array.from(apart)).toEqual([10, 10, 50, 50]);
  });
});
