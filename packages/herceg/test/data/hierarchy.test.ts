import { describe, expect, it } from "vitest";
import { category } from "../../src/data/column.ts";
import { hierarchy, pathOf, pruneHierarchy, subtreeValues } from "../../src/data/hierarchy.ts";
import { table } from "../../src/data/table.ts";

const names = (tree: { names: readonly string[] }, nodes: ArrayLike<number>) =>
  Array.from(nodes, (node) => tree.names[node]);

describe("hierarchy", () => {
  it("builds a tree from paths, sharing prefixes and stopping at missing values", () => {
    const sales = table({
      region: ["Europe", "Europe", "Asia", "Asia", null],
      country: ["France", "Spain", "Japan", null, "Peru"],
      amount: [5, 3, 7, 2, 4],
    });
    const tree = hierarchy(sales, { path: ["region", "country"] });
    expect(tree.size).toBe(6);
    expect(names(tree, tree.children.subarray(tree.childStart[0]!, tree.childStart[1]!))).toEqual([
      "Europe",
      "Asia",
    ]);
    expect(Array.from(tree.depth)).toEqual([0, 1, 2, 2, 1, 2]);
    expect(tree.height).toBe(2);
    // The Asia row without a country belongs to Asia; the row without a region to nothing.
    expect(names(tree, tree.nodeOfRow.subarray(2, 4))).toEqual(["Japan", "Asia"]);
    expect(tree.nodeOfRow[4]).toBe(-1);
    const values = subtreeValues(tree, sales.numbers("amount"));
    expect(Array.from(values)).toEqual([17, 8, 5, 3, 9, 7]);
    expect(pathOf(tree, 5)).toEqual(["Asia", "Japan"]);
    // Without weights, rows count.
    expect(subtreeValues(tree)[0]).toBe(4);
  });

  it("keeps equal names under different parents apart", () => {
    const t = table({ a: ["x", "y"], b: ["same", "same"] });
    const tree = hierarchy(t, { path: ["a", "b"] });
    expect(tree.size).toBe(5);
    expect(tree.nodeOfRow[0]).not.toBe(tree.nodeOfRow[1]);
  });

  it("builds a tree from ids and parents, in any row order", () => {
    const org = table({
      id: ["cto", "ceo", "dev", "ops"],
      boss: ["ceo", null, "cto", "cto"],
      cost: [3, 5, 2, 1],
    });
    const tree = hierarchy(org, { id: "id", parent: "boss" });
    const order = names(tree, tree.order);
    expect(order).toEqual(["", "ceo", "cto", "dev", "ops"]);
    expect(Array.from(subtreeValues(tree, org.numbers("cost")))).toEqual([11, 6, 11, 2, 1]);
    expect(pathOf(tree, tree.nodeOfRow[2]!)).toEqual(["ceo", "cto", "dev"]);
  });

  it("refuses duplicate ids, unknown parents, cycles, and negative weights", () => {
    const build = (id: (string | null)[], parent: (string | null)[]) =>
      hierarchy(table({ id: category(id), parent: category(parent) }), {
        id: "id",
        parent: "parent",
      });
    expect(() => build(["a", "a"], [null, null])).toThrow('the id "a" appears twice');
    expect(() => build(["a"], ["z"])).toThrow('"a" has the parent "z"');
    expect(() => build(["a", "b", "c"], [null, "c", "b"])).toThrow("is its own ancestor");
    expect(() => build(["a"], ["a"])).toThrow('"a" is its own ancestor');
    const t = table({ g: ["a"], w: [-1] });
    expect(() => subtreeValues(hierarchy(t, { path: ["g"] }), t.numbers("w"))).toThrow(
      "has the weight -1",
    );
    const odd = table({ g: ["a", "b", "c"], w: [Number.POSITIVE_INFINITY, 1, Number.NaN] });
    expect(() => subtreeValues(hierarchy(odd, { path: ["g"] }), odd.numbers("w"))).toThrow(
      "has the weight Infinity",
    );
    const huge = table({ g: ["a", "b"], w: [1e308, 1e308] });
    expect(() => subtreeValues(hierarchy(huge, { path: ["g"] }), huge.numbers("w"))).toThrow(
      "more than a double holds",
    );
    // Missing weights count as nothing.
    const gaps = table({ g: ["a", "b"], w: [2, Number.NaN] });
    expect(Array.from(subtreeValues(hierarchy(gaps, { path: ["g"] }), gaps.numbers("w")))).toEqual([
      2, 2, 0,
    ]);
  });

  it("keeps depths of chains deeper than 65,536 nodes", () => {
    const n = 70_000;
    const ids = Array.from({ length: n }, (_, i) => `n${i}`);
    const chain = table({ id: ids, up: [null, ...ids.slice(0, -1)] });
    const tree = hierarchy(chain, { id: "id", parent: "up" });
    expect(tree.height).toBe(n);
    expect(tree.depth[tree.nodeOfRow[n - 1]!]).toBe(n);
  });

  it("totals some rows, and keeps the part of a tree they give a value", () => {
    const sales = table({
      region: ["Europe", "Europe", "Asia", "Asia", "Africa"],
      country: ["France", "Spain", "Japan", "Laos", "Mali"],
      amount: [5, 3, 7, 2, 4],
    });
    const tree = hierarchy(sales, { path: ["region", "country"] });
    const some = subtreeValues(tree, sales.numbers("amount"), Uint32Array.of(1, 2));
    expect(Array.from(some)).toEqual([10, 3, 0, 3, 7, 7, 0, 0, 0]);
    const part = pruneHierarchy(tree, some);
    // The root, Europe and Spain, and Asia and Japan, in the tree's order.
    expect(part.tree.size).toBe(5);
    expect(part.tree.names).toEqual(["", "Europe", "Spain", "Asia", "Japan"]);
    expect(Array.from(part.values)).toEqual([10, 3, 3, 7, 7]);
    expect(pathOf(part.tree, 4)).toEqual(["Asia", "Japan"]);
    expect(Array.from(part.tree.depth)).toEqual([0, 1, 2, 1, 2]);
    expect(Array.from(part.index)).toEqual([0, 1, -1, 2, 3, 4, -1, -1, -1]);
    expect(part.tree.nodeOfRow).toHaveLength(0);
  });

  it("handles an empty table", () => {
    const tree = hierarchy(table({ g: category([]) }), { path: ["g"] });
    expect([tree.size, tree.height, tree.children.length]).toEqual([1, 0, 0]);
    expect(Array.from(subtreeValues(tree))).toEqual([0]);
  });
});
