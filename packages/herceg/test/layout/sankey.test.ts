import { describe, expect, it } from "vitest";
import {
  CYCLE,
  DRAWN,
  EMPTY,
  layoutSankey,
  type SankeyLayout,
  type SankeyLayoutOptions,
} from "../../src/layout/sankey.ts";

const bounds = { x: 10, y: 20, width: 600, height: 400 };
const options: SankeyLayoutOptions = { nodeWidth: 12, nodePadding: 10, order: "auto" };

/** Lays out links given as [source, target, value] between `nodes` nodes. */
function layout(
  nodes: number,
  links: [number, number, number][],
  overrides: Partial<SankeyLayoutOptions> = {},
): SankeyLayout {
  return layoutSankey(
    {
      nodes,
      source: Int32Array.from(links, ([s]) => s),
      target: Int32Array.from(links, ([, t]) => t),
      value: Float64Array.from(links, ([, , v]) => v),
    },
    bounds,
    { ...options, ...overrides },
  );
}

const box = (result: SankeyLayout, node: number) =>
  Array.from(result.boxes.subarray(node * 4, node * 4 + 4)) as [number, number, number, number];
const height = (result: SankeyLayout, node: number) => box(result, node)[3] - box(result, node)[1];

/** Nodes of a column, top to bottom. */
const columnOf = (result: SankeyLayout, c: number) =>
  Array.from(result.order).filter((node) => result.column[node] === c);

describe("layoutSankey", () => {
  it("puts nodes in columns by their longest path from a source, and sinks last", () => {
    // 0 → 1 → 2 → 3, 0 → 4 (a sink), 5 → 2.
    const result = layout(6, [
      [0, 1, 5],
      [1, 2, 5],
      [2, 3, 7],
      [0, 4, 2],
      [5, 2, 2],
    ]);
    expect(result.columns).toBe(4);
    expect(Array.from(result.column)).toEqual([0, 1, 2, 3, 3, 0]);
    // The first column's bars start at the left edge, the last's end at the right.
    expect(box(result, 0)[0]).toBe(10);
    expect(box(result, 3)[2]).toBeCloseTo(610, 9);
    expect(box(result, 1)[2] - box(result, 1)[0]).toBe(12);
    expect(Array.from(result.columnX)).toEqual([10, 206, 402, 598]);
  });

  it("sizes nodes by the larger of their inflow and outflow, on one scale", () => {
    // Node 1 takes in 10 and passes on 6.
    const result = layout(4, [
      [0, 1, 10],
      [1, 2, 4],
      [1, 3, 2],
    ]);
    expect(Array.from(result.inflow)).toEqual([0, 10, 4, 2]);
    expect(Array.from(result.outflow)).toEqual([10, 6, 0, 0]);
    const ky = height(result, 0) / 10;
    expect(height(result, 1) / 10).toBeCloseTo(ky, 9);
    expect(height(result, 2) / 4).toBeCloseTo(ky, 9);
    expect(height(result, 3) / 2).toBeCloseTo(ky, 9);
    // Links are as thick as their value on the same scale.
    expect(result.thickness[1]! / 4).toBeCloseTo(ky, 9);
  });

  it("fills the height with the fullest column, its nodes a padding apart", () => {
    const result = layout(5, [
      [0, 2, 3],
      [0, 3, 5],
      [1, 4, 2],
      [1, 3, 1],
    ]);
    // The last column holds 2, 3, and 4: 11 units and two paddings.
    const last = columnOf(result, 1);
    expect(last).toHaveLength(3);
    const total = last.reduce((sum, node) => sum + height(result, node), 0);
    expect(total + 2 * 10).toBeCloseTo(400, 6);
    for (let i = 1; i < last.length; i++) {
      expect(box(result, last[i]!)[1] - box(result, last[i - 1]!)[3]).toBeGreaterThanOrEqual(
        10 - 1e-6,
      );
    }
    for (const node of result.order) {
      expect(box(result, node)[1]).toBeGreaterThanOrEqual(20 - 1e-6);
      expect(box(result, node)[3]).toBeLessThanOrEqual(420 + 1e-6);
    }
  });

  it("shrinks the padding when a column has too many nodes for it", () => {
    const many = Array.from({ length: 60 }, (_, i): [number, number, number] => [0, i + 1, 1]);
    const result = layout(61, many);
    const sinks = columnOf(result, 1);
    // Padding takes at most half the height, so every node keeps some.
    for (const node of sinks) expect(height(result, node)).toBeGreaterThan(3);
    for (let i = 1; i < sinks.length; i++) {
      expect(box(result, sinks[i]!)[1]).toBeGreaterThanOrEqual(box(result, sinks[i - 1]!)[3]);
    }
  });

  it("stacks links at a node in the order of the nodes at their other ends", () => {
    const result = layout(4, [
      [0, 1, 3],
      [0, 2, 3],
      [0, 3, 3],
    ]);
    const targets = columnOf(result, 1);
    const tops = targets.map((node) => result.sourceY[node - 1]!);
    expect(tops).toEqual([...tops].sort((a, b) => a - b));
    // Stacked flush from the source's top.
    expect(Math.min(...tops)).toBeCloseTo(box(result, 0)[1], 9);
    for (const node of targets)
      expect(result.targetY[node - 1]).toBeCloseTo(box(result, node)[1], 9);
  });

  it("lays out the same graph the same way every time", () => {
    const links: [number, number, number][] = [
      [0, 3, 4],
      [1, 3, 2],
      [1, 4, 6],
      [2, 4, 1],
      [3, 5, 5],
      [4, 5, 3],
      [4, 6, 4],
      [2, 6, 2],
    ];
    const a = layout(7, links);
    const b = layout(7, links);
    expect(Array.from(a.boxes)).toEqual(Array.from(b.boxes));
    expect(Array.from(a.sourceY)).toEqual(Array.from(b.sourceY));
    expect(Array.from(a.order)).toEqual(Array.from(b.order));
  });

  it("keeps the given order, or puts the largest first, when asked", () => {
    const links: [number, number, number][] = [
      [0, 3, 1],
      [1, 3, 5],
      [2, 3, 3],
    ];
    expect(columnOf(layout(4, links, { order: "input" }), 0)).toEqual([0, 1, 2]);
    expect(columnOf(layout(4, links, { order: "value" }), 0)).toEqual([1, 2, 0]);
  });

  it("leaves out links that close cycles, and links from a node to itself", () => {
    // 0 → 1 → 2 → 0 loops back to the source; 1 → 1 loops on itself.
    const result = layout(3, [
      [0, 1, 5],
      [1, 2, 5],
      [2, 0, 1],
      [1, 1, 2],
    ]);
    expect(Array.from(result.status)).toEqual([DRAWN, DRAWN, CYCLE, CYCLE]);
    expect(Array.from(result.column)).toEqual([0, 1, 2]);
    expect(result.inflow[0]).toBe(0);
    // Without a source, the search starts at the first node.
    const loop = layout(2, [
      [1, 0, 1],
      [0, 1, 1],
    ]);
    expect(Array.from(loop.status)).toEqual([CYCLE, DRAWN]);
    // From a source into a loop, the link back toward the source goes.
    const fed = layout(3, [
      [2, 1, 1],
      [1, 2, 1],
      [0, 1, 1],
    ]);
    expect(Array.from(fed.status)).toEqual([CYCLE, DRAWN, DRAWN]);
  });

  it("scales by the links drawn, whatever the links left out", () => {
    const chain: [number, number, number][] = [
      [0, 1, 1],
      [1, 2, 1],
    ];
    const plain = layout(3, chain);
    // A huge link back from 2 to 1 closes a cycle and is left out.
    const looped = layout(3, [...chain, [2, 1, 1e308]]);
    expect(looped.status[2]).toBe(CYCLE);
    expect(Array.from(looped.boxes)).toEqual(Array.from(plain.boxes));
    expect(height(looped, 0)).toBeCloseTo(400, 6);
  });

  it("leaves out links without a positive, finite value, and nodes left without links", () => {
    const result = layout(5, [
      [0, 1, 3],
      [0, 2, 0],
      [0, 3, -4],
      [0, 4, Number.NaN],
      [1, 4, Number.POSITIVE_INFINITY],
    ]);
    expect(Array.from(result.status)).toEqual([DRAWN, EMPTY, EMPTY, EMPTY, EMPTY]);
    expect(Array.from(result.column)).toEqual([0, 1, -1, -1, -1]);
    expect(Array.from(result.order)).toEqual([0, 1]);
    expect(Array.from(result.boxes.subarray(8))).toEqual(new Array(12).fill(0));
  });

  it("gives a single link the whole room", () => {
    const result = layout(2, [[0, 1, 42]]);
    expect(box(result, 0)).toEqual([10, 20, 22, 420]);
    expect(box(result, 1)[1]).toBeCloseTo(20, 9);
    expect(box(result, 1)[2]).toBeCloseTo(610, 9);
    expect(result.thickness[0]).toBeCloseTo(400, 9);
  });

  it("stacks disconnected graphs without overlap", () => {
    const result = layout(4, [
      [0, 1, 3],
      [2, 3, 1],
    ]);
    expect(Array.from(result.column)).toEqual([0, 1, 0, 1]);
    for (const c of [0, 1]) {
      const [a, b] = columnOf(result, c);
      expect(box(result, b!)[1] - box(result, a!)[3]).toBeGreaterThanOrEqual(10 - 1e-6);
    }
  });

  it("keeps geometry finite for values near the largest double", () => {
    const result = layout(3, [
      [0, 2, 1.5e308],
      [1, 2, 1.5e308],
    ]);
    expect(Array.from(result.boxes).every(Number.isFinite)).toBe(true);
    expect(height(result, 0)).toBeCloseTo(height(result, 1), 6);
  });

  it("draws nothing for a graph without links, or without room", () => {
    const empty = layout(0, []);
    expect([empty.columns, empty.order.length]).toEqual([0, 0]);
    const flat = layoutSankey(
      { nodes: 2, source: Int32Array.of(0), target: Int32Array.of(1), value: Float64Array.of(1) },
      { x: 0, y: 0, width: 0, height: 0 },
      options,
    );
    expect(Array.from(flat.boxes).every(Number.isFinite)).toBe(true);
  });
});
