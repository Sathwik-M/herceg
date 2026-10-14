import { describe, expect, it } from "vitest";
import {
  LAYER_GAP,
  type LayeredGraph,
  layeredSteps,
  layoutLayered,
  MAX_BENDS,
} from "../../src/layout/layered.ts";

/** A graph whose links are its constraints. */
function graphOf(nodes: number, pairs: readonly (readonly [number, number])[]): LayeredGraph {
  const from = Int32Array.from(pairs, ([s]) => s);
  const to = Int32Array.from(pairs, ([, t]) => t);
  return { nodes, from, to, source: from, target: to };
}
const xy = (positions: Float64Array, i: number) => [positions[i * 2]!, positions[i * 2 + 1]!];

describe("layoutLayered", () => {
  it("puts a tree's levels in layers, each parent centered over its children", () => {
    // 0 above 1 and 2; 1 above 3, 4, 5.
    const tree = graphOf(6, [
      [0, 1],
      [0, 2],
      [1, 3],
      [1, 4],
      [1, 5],
    ]);
    const { positions, reversed } = layoutLayered(tree);
    expect(reversed).toBe(0);
    expect([0, 1, 2, 3, 4, 5].map((i) => xy(positions, i)[1])).toEqual([
      0,
      LAYER_GAP,
      LAYER_GAP,
      2 * LAYER_GAP,
      2 * LAYER_GAP,
      2 * LAYER_GAP,
    ]);
    // Centered within a sixth of the gap between nodes.
    const x = (i: number) => xy(positions, i)[0]!;
    expect(Math.abs(x(1) - x(4))).toBeLessThan(5);
    expect(Math.abs(x(0) - (x(1) + x(2)) / 2)).toBeLessThan(5);
    expect(x(3) < x(4) && x(4) < x(5)).toBe(true);
  });

  it("routes links spanning layers through a bend point in each layer between", () => {
    // 0 → 1 → 2 → 3, and 0 → 3 spans three layers.
    const graph = graphOf(4, [
      [0, 1],
      [1, 2],
      [2, 3],
      [0, 3],
    ]);
    const { positions, starts, bends } = layoutLayered(graph);
    expect(Array.from(starts)).toEqual([0, 0, 0, 0, 2]);
    expect(bends[1]).toBeCloseTo(LAYER_GAP);
    expect(bends[3]).toBeCloseTo(2 * LAYER_GAP);
    // The long link runs beside the chain, not through its nodes.
    expect(bends[0]).not.toBeCloseTo(xy(positions, 1)[0]!);
  });

  it("turns links closing cycles around, and counts them", () => {
    const cycle = graphOf(3, [
      [0, 1],
      [1, 2],
      [2, 0],
    ]);
    const { positions, reversed } = layoutLayered(cycle);
    expect(reversed).toBe(1);
    const layers = [0, 1, 2].map((i) => xy(positions, i)[1]);
    expect(new Set(layers).size).toBe(3);
    // Rows both ways between two nodes are one cycle.
    expect(
      layoutLayered({
        nodes: 2,
        from: Int32Array.of(0, 1),
        to: Int32Array.of(1, 0),
        source: Int32Array.of(0),
        target: Int32Array.of(1),
      }).reversed,
    ).toBe(1);
  });

  it("lays layers out in each direction, and components side by side", () => {
    const pair = graphOf(4, [
      [0, 1],
      [2, 3],
    ]);
    const down = layoutLayered(pair, "down").positions;
    expect(xy(down, 1)[1]! - xy(down, 0)[1]!).toBeCloseTo(LAYER_GAP);
    // The second component stands beside the first, centered across about 0.
    expect(xy(down, 2)[0]! - xy(down, 0)[0]!).toBeGreaterThan(30);
    expect(xy(down, 0)[0]! + xy(down, 2)[0]!).toBeCloseTo(0);
    const right = layoutLayered(pair, "right").positions;
    expect(xy(right, 1)[0]! - xy(right, 0)[0]!).toBeCloseTo(LAYER_GAP);
    const up = layoutLayered(pair, "up").positions;
    expect(xy(up, 1)[1]! - xy(up, 0)[1]!).toBeCloseTo(-LAYER_GAP);
    const left = layoutLayered(pair, "left").positions;
    expect(xy(left, 1)[0]! - xy(left, 0)[0]!).toBeCloseTo(-LAYER_GAP);
  });

  it("starts from the order previous positions give, and is deterministic", () => {
    const star = graphOf(4, [
      [0, 1],
      [0, 2],
      [0, 3],
    ]);
    const first = layoutLayered(star).positions;
    expect(layoutLayered(star).positions).toEqual(first);
    // Children placed right to left before keep that order.
    const previous = Float64Array.of(0, 0, 60, 45, 30, 45, 0, 45);
    const again = layoutLayered(star, "down", previous).positions;
    expect(xy(again, 3)[0]! < xy(again, 2)[0]! && xy(again, 2)[0]! < xy(again, 1)[0]!).toBe(true);
  });

  it("refuses links that would need too many bend points, before making them", () => {
    // A chain of 2,001 nodes, and links from its first node to each node after the next.
    expect((1999 * 2000) / 2).toBeGreaterThan(MAX_BENDS);
    const wide = graphOf(2001, [
      ...Array.from({ length: 2000 }, (_, i) => [i, i + 1] as const),
      ...Array.from({ length: 1999 }, (_, i) => [0, i + 2] as const),
    ]);
    expect(() => layoutLayered(wide)).toThrow(
      /^1,999,000 bend points, more than the 500,000 a layered layout routes$/,
    );
  });

  it("yields while it makes many bend points for few links", () => {
    // A chain of 20,000 nodes and ten links spanning most of it.
    const pairs: [number, number][] = [];
    for (let i = 0; i + 1 < 20_000; i++) pairs.push([i, i + 1]);
    for (let k = 0; k < 10; k++) pairs.push([k, 19_999 - k]);
    const steps = layeredSteps(graphOf(20_000, pairs));
    let count = 0;
    let step = steps.next();
    while (!step.done) {
      count++;
      step = steps.next();
    }
    const bends = step.value.starts.at(-1)!;
    expect(bends).toBeGreaterThan(190_000);
    expect(count).toBeGreaterThan(bends / 16_384);
  });

  it("yields between steps and ends as one run does", () => {
    const pairs: [number, number][] = [];
    for (let i = 1; i < 3000; i++) pairs.push([Math.floor((i - 1) / 3), i]);
    const tree = graphOf(3000, pairs);
    const steps = layeredSteps(tree);
    let count = 0;
    let step = steps.next();
    while (!step.done) {
      count++;
      step = steps.next();
    }
    expect(count).toBeGreaterThan(5);
    expect(step.value.positions).toEqual(layoutLayered(tree).positions);
  });
});
