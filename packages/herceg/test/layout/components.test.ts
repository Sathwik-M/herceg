import { describe, expect, it } from "vitest";
import { type Adjacency, componentsOf, packComponents } from "../../src/layout/components.ts";
import { pivotMds } from "../../src/layout/pivot-mds.ts";

/** Neighbors from undirected pairs. */
function adjacency(nodes: number, pairs: readonly (readonly [number, number])[]): Adjacency {
  const lists: number[][] = Array.from({ length: nodes }, () => []);
  for (const [a, b] of pairs) {
    lists[a]!.push(b);
    lists[b]!.push(a);
  }
  const starts = new Int32Array(nodes + 1);
  lists.forEach((list, i) => {
    starts[i + 1] = starts[i]! + list.length;
  });
  return { starts, neighbors: Int32Array.from(lists.flat()) };
}

describe("componentsOf", () => {
  it("lists components largest first, each breadth first from its lowest node", () => {
    const graph = adjacency(7, [
      [5, 6],
      [1, 3],
      [3, 2],
      [1, 4],
    ]);
    expect(componentsOf(7, graph).map((c) => Array.from(c))).toEqual([[1, 3, 4, 2], [5, 6], [0]]);
  });
});

describe("pivotMds", () => {
  it("places a ring on a circle, links a set length apart", () => {
    const n = 24;
    const ring = Array.from({ length: n }, (_, i) => [i, (i + 1) % n] as const);
    const graph = adjacency(n, ring);
    const positions = pivotMds(n, graph, componentsOf(n, graph), 30);
    const radii = Array.from({ length: n }, (_, i) =>
      Math.hypot(positions[i * 2]!, positions[i * 2 + 1]!),
    );
    for (const r of radii) expect(r).toBeCloseTo(radii[0]!, 6);
    for (const [a, b] of ring) {
      const side = Math.hypot(
        positions[a * 2]! - positions[b * 2]!,
        positions[a * 2 + 1]! - positions[b * 2 + 1]!,
      );
      expect(side).toBeCloseTo(30, 6);
    }
  });

  it("stretches a chain into a line and puts pairs and lone nodes at the middle", () => {
    const graph = adjacency(8, [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
      [5, 6],
    ]);
    const positions = pivotMds(8, graph, componentsOf(8, graph), 10);
    expect(Math.hypot(positions[0]! - positions[8]!, positions[1]! - positions[9]!)).toBeCloseTo(
      40,
      6,
    );
    expect(Array.from(positions.subarray(10))).toEqual([-5, 0, 5, 0, 0, 0]);
  });
});

describe("packComponents", () => {
  it("moves components whole into rows of boxes, tallest first, apart by the gap", () => {
    // Two triangles and a lone node, all piled at the origin.
    const graph = adjacency(7, [
      [0, 1],
      [1, 2],
      [2, 0],
      [3, 4],
      [4, 5],
      [5, 3],
    ]);
    const positions = Float64Array.from([0, 10, 10, -10, -10, -10, 0, 10, 10, -10, -10, -10, 0, 0]);
    packComponents(positions, componentsOf(7, graph), 4);
    const box = (nodes: number[]) => {
      const xs = nodes.map((i) => positions[i * 2]!);
      const ys = nodes.map((i) => positions[i * 2 + 1]!);
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    };
    // Rows hold 1.5 times the boxes' area (with gaps) as a square of their height:
    // sqrt(1.5 * (24 * 24 * 2 + 4 * 4)) wide, so the second triangle starts a row.
    const row = Math.sqrt(1752);
    const [a, b, lone] = [box([0, 1, 2]), box([3, 4, 5]), box([6])];
    expect(a[0]).toBeCloseTo((row - 20) / 2, 9);
    expect([a[1], a[3]! - a[1]!]).toEqual([0, 20]);
    // The second row, the triangle and the lone node 4 apart, centered too;
    // the lone node at the row's middle height.
    expect(b[0]).toBeCloseTo((row - 24) / 2, 9);
    expect(b[1]).toBe(24);
    expect(lone[0]).toBeCloseTo(b[0]! + 24, 9);
    expect(lone[1]).toBe(34);
    // Shapes are moved whole.
    expect(positions[6]! - positions[8]!).toBeCloseTo(-10, 9);
  });
});
