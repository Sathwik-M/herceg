import { describe, expect, it } from "vitest";
import { hierarchy, subtreeValues } from "../../src/data/hierarchy.ts";
import { table } from "../../src/data/table.ts";
import { layoutPartition } from "../../src/layout/partition.ts";
import { layoutTreemap } from "../../src/layout/treemap.ts";

function tree(groups: string[], items: string[], weights: number[]) {
  const t = table({ group: groups, item: items, w: weights });
  const h = hierarchy(t, { path: ["group", "item"] });
  return { tree: h, values: subtreeValues(h, t.numbers("w")) };
}

const box = (out: Float64Array, node: number) => Array.from(out.subarray(node * 4, node * 4 + 4));
const area = (out: Float64Array, node: number) => out[node * 4 + 2]! * out[node * 4 + 3]!;

describe("layoutTreemap", () => {
  const { tree: t, values } = tree(
    ["a", "a", "a", "b", "b", "c"],
    ["a1", "a2", "a3", "b1", "b2", "c1"],
    [6, 6, 4, 3, 2, 1],
  );
  const bounds = { x: 0, y: 0, width: 600, height: 400 };

  it("gives every node an area in proportion to its value, inside its parent", () => {
    const out = new Float64Array(t.size * 4);
    layoutTreemap(t, values, bounds, { inner: 0, outer: 0, top: 0 }, out);
    const total = 600 * 400;
    for (let node = 1; node < t.size; node++) {
      expect(area(out, node) / total).toBeCloseTo(values[node]! / values[0]!, 9);
      const [x, y, w, h] = box(out, node);
      const [px, py, pw, ph] = box(out, t.parent[node]!);
      expect(x).toBeGreaterThanOrEqual(px! - 1e-9);
      expect(y).toBeGreaterThanOrEqual(py! - 1e-9);
      expect(x! + w!).toBeLessThanOrEqual(px! + pw! + 1e-9);
      expect(y! + h!).toBeLessThanOrEqual(py! + ph! + 1e-9);
    }
  });

  it("keeps rectangles close to square", () => {
    const many = tree(
      Array.from({ length: 40 }, () => "g"),
      Array.from({ length: 40 }, (_, i) => `i${i}`),
      Array.from({ length: 40 }, (_, i) => 40 - i),
    );
    const out = new Float64Array(many.tree.size * 4);
    layoutTreemap(many.tree, many.values, bounds, { inner: 0, outer: 0, top: 0 }, out);
    let worst = 1;
    for (let node = 2; node < many.tree.size; node++) {
      const [, , w, h] = box(out, node);
      worst = Math.max(worst, w! / h!, h! / w!);
    }
    // A slice-and-dice layout of the same values reaches ratios above 60.
    expect(worst).toBeLessThan(4);
  });

  it("leaves gaps between siblings and room for parents' labels", () => {
    const out = new Float64Array(t.size * 4);
    layoutTreemap(t, values, bounds, { inner: 2, outer: 0, top: 20 }, out);
    const groups = Array.from(t.children.subarray(t.childStart[0]!, t.childStart[1]!));
    // Top-level groups are flush with the chart's edges and 2 px apart.
    const right = Math.max(...groups.map((g) => out[g * 4]! + out[g * 4 + 2]!));
    expect(right).toBeCloseTo(600, 9);
    const [a] = groups;
    for (let c = t.childStart[a!]!; c < t.childStart[a! + 1]!; c++) {
      expect(out[t.children[c]! * 4 + 1]!).toBeGreaterThanOrEqual(out[a! * 4 + 1]! + 20 - 1e-9);
    }
  });

  it("gives empty rectangles to nodes without a value and to rooms too small", () => {
    const zero = tree(["a", "a"], ["x", "y"], [0, 5]);
    const out = new Float64Array(zero.tree.size * 4);
    layoutTreemap(zero.tree, zero.values, bounds, { inner: 0, outer: 0, top: 0 }, out);
    const x = zero.tree.nodeOfRow[0]!;
    expect(box(out, x)).toEqual([0, 0, 0, 0]);
    // Two children 1.5 px wide less a 4 px gap have no room.
    const pair = tree(["a", "a"], ["x", "y"], [1, 1]);
    const small = { x: 0, y: 0, width: 3, height: 3 };
    layoutTreemap(pair.tree, pair.values, small, { inner: 4, outer: 0, top: 0 }, out);
    expect(box(out, pair.tree.nodeOfRow[0]!)).toEqual([0, 0, 0, 0]);
    expect(box(out, pair.tree.nodeOfRow[1]!)).toEqual([0, 0, 0, 0]);
  });
});

describe("layoutPartition", () => {
  it("splits each parent's span among its children by value, largest first", () => {
    const { tree: t, values } = tree(["a", "a", "b"], ["x", "y", "z"], [1, 3, 4]);
    const out = new Float64Array(t.size * 2);
    layoutPartition(t, values, true, out);
    const span = (node: number) => [out[node * 2], out[node * 2 + 1]];
    const [a, b] = Array.from(t.children.subarray(t.childStart[0]!, t.childStart[1]!));
    expect(span(a!)).toEqual([0, 0.5]);
    expect(span(b!)).toEqual([0.5, 1]);
    const [x, y] = [t.nodeOfRow[0]!, t.nodeOfRow[1]!];
    expect(span(y)).toEqual([0, 0.375]);
    expect(span(x)).toEqual([0.375, 0.5]);
    layoutPartition(t, values, false, out);
    expect(span(x)).toEqual([0, 0.125]);
  });
});
