import { describe, expect, it } from "vitest";
import { col } from "../../src/data/expression.ts";
import { RowSet } from "../../src/data/row-set.ts";
import { rowView } from "../../src/data/row-view.ts";
import { table } from "../../src/data/table.ts";

/** The positions a view shows, as an array. */
function shown(view: { read(): { indices: Uint32Array | undefined; length: number } }): number[] {
  const { indices, length } = view.read();
  return indices ? Array.from(indices) : Array.from({ length }, (_, i) => i);
}

/** A seeded random number generator, so failures reproduce. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

describe("row views", () => {
  it("show every row, in table order, without positions when nothing filters or sorts", () => {
    const t = table({ x: [1, 2, 3] });
    const view = rowView(t);
    expect(view.read().indices).toBeUndefined();
    expect(view.length).toBe(3);
    t.append({ x: [4] });
    expect(view.length).toBe(4);
    expect(view.byteLength).toBe(0);
  });

  it("filter with expressions and keep table order", () => {
    const t = table({ x: [5, 1, 7, 3, 9], host: ["a", "b", "a", "b", "a"] });
    const view = rowView(t, { filter: col("x").gt(2).and(col("host").eq("a")) });
    expect(shown(view)).toEqual([0, 2, 4]);
    view.setQuery({ filter: col("host").eq("b") });
    expect(shown(view)).toEqual([1, 3]);
    view.setQuery({ filter: true });
    expect(view.read().indices).toBeUndefined();
    expect(() => view.setQuery({ filter: col("x") as never })).toThrow(/true or false/);
  });

  it("sort numbers with missing values last both ways and infinities in order", () => {
    const t = table({
      x: [3, Number.NaN, Number.NEGATIVE_INFINITY, 1, Number.POSITIVE_INFINITY, 1],
    });
    const up = rowView(t, { sort: [{ field: "x" }] });
    // Ties keep table order: row 3 before row 5.
    expect(shown(up)).toEqual([2, 3, 5, 0, 4, 1]);
    const down = rowView(t, { sort: [{ field: "x", order: "descending" }] });
    expect(shown(down)).toEqual([4, 0, 3, 5, 2, 1]);
  });

  it("sort categories by label, not by when each first appeared, then by the next key", () => {
    const t = table({ host: ["web", "api", null, "web", "db", "api"], ms: [5, 9, 1, 2, 7, 3] });
    const view = rowView(t, {
      sort: [{ field: "host" }, { field: "ms", order: "descending" }],
    });
    expect(shown(view)).toEqual([1, 5, 4, 0, 3, 2]);
  });

  it("merge appended rows into the order and rebase it as rows drop", () => {
    const t = table({ x: [5, 1, 9] }, { maxRows: 4 });
    const view = rowView(t, { sort: [{ field: "x" }] });
    expect(shown(view)).toEqual([1, 0, 2]);
    t.append({ x: [3, 7] });
    // Row 0 (5) is evicted: rows are now 1, 9, 3, 7.
    expect(Array.from(t.numbers("x"))).toEqual([1, 9, 3, 7]);
    expect(shown(view)).toEqual([0, 2, 3, 1]);
    // A batch larger than the window keeps only its last rows.
    t.append({ x: [8, 2, 6, 4, 0] });
    expect(Array.from(t.numbers("x"))).toEqual([2, 6, 4, 0]);
    expect(shown(view)).toEqual([3, 0, 2, 1]);
  });

  it("stay equal to a fresh view as random batches stream through a rolling window", () => {
    const next = random(7);
    const value = () => (next() < 0.05 ? Number.NaN : Math.round(next() * 20));
    const tag = () => ["a", "b", "c", null][Math.floor(next() * 4)]!;
    const t = table(
      { x: Array.from({ length: 50 }, value), tag: Array.from({ length: 50 }, tag) },
      { maxRows: 300 },
    );
    const query = {
      filter: col("x").gt(3),
      sort: [{ field: "tag" as const }, { field: "x" as const, order: "descending" as const }],
    };
    const streaming = rowView(t, query);
    for (let step = 0; step < 60; step++) {
      const n = 1 + Math.floor(next() * 80);
      t.append({ x: Array.from({ length: n }, value), tag: Array.from({ length: n }, tag) });
      if (step % 7 === 3) t.set("x", Math.floor(next() * t.length), value());
      // Read on most steps, so several changes sometimes catch up at once.
      if (step % 3 !== 2) expect(shown(streaming)).toEqual(shown(rowView(t, query)));
    }
    expect(shown(streaming)).toEqual(shown(rowView(t, query)));
  });

  it("rebuild when the fields they filter or sort by change, and keep rows otherwise", () => {
    const t = table({ x: [3, 1, 2], label: [10, 20, 30] });
    const view = rowView(t, { sort: [{ field: "x" }] });
    expect(shown(view)).toEqual([1, 2, 0]);
    const before = view.revision;
    t.set("label", 0, 99);
    expect(view.revision).toBeGreaterThan(before);
    expect(shown(view)).toEqual([1, 2, 0]);
    t.set("x", 0, 0);
    expect(shown(view)).toEqual([0, 1, 2]);
  });

  it("match categories that arrive after the filter was set", () => {
    const t = table({ host: ["a", "b"] });
    const view = rowView(t, { filter: col("host").eq("c") });
    expect(shown(view)).toEqual([]);
    t.append({ host: ["c", "a", "c"] });
    expect(shown(view)).toEqual([2, 4]);
  });

  it("keep sorting and filtering categories by label when drops renumber their codes", () => {
    const t = table({ host: ["zz", "yy", "xx", "ww"] }, { maxRows: 4 });
    const sorted = rowView(t, { sort: [{ field: "host" }] });
    const later = rowView(t, { filter: col("host").eq("k-90") });
    sorted.read();
    later.read();
    // Enough distinct labels through a small window that drops compact the dictionary.
    for (let i = 0; i < 100; i++) t.append({ host: [`k-${i}`] });
    expect(t.categories("host").dictionary.length).toBeLessThan(80);
    const labels = (view: typeof sorted) =>
      Array.from(view.read().indices!, (row) => t.value("host", row));
    expect(labels(sorted)).toEqual(["k-96", "k-97", "k-98", "k-99"]);
    expect(labels(later)).toEqual([]);
    t.append({ host: ["k-90", "a"] });
    expect(labels(sorted)).toEqual(["a", "k-90", "k-98", "k-99"]);
    expect(labels(later)).toEqual(["k-90"]);
  });

  it("catch up on a change a listener of the table reads before the view is told", () => {
    const t = table({ x: [3, 1, 2] });
    let seen: number[] = [];
    // This listener runs before the view's, which subscribes later.
    t.subscribe(() => {
      seen = shown(view);
    });
    const view = rowView(t, { sort: [{ field: "x" }] });
    expect(shown(view)).toEqual([1, 2, 0]);
    t.set("x", 0, 0);
    expect(seen).toEqual([0, 1, 2]);
  });

  it("keep their own copy of the sort keys", () => {
    const t = table({ x: [1, 2, 3] });
    const key: { field: "x"; order: "ascending" | "descending" } = {
      field: "x",
      order: "ascending",
    };
    const view = rowView(t, { sort: [key] });
    expect(shown(view)).toEqual([0, 1, 2]);
    key.order = "descending";
    t.append({ x: [4] });
    expect(shown(view)).toEqual([0, 1, 2, 3]);
  });

  it("start again after a reset, and show only the rows of a restriction", () => {
    const t = table({ x: [4, 3, 2, 1] });
    const picked = new RowSet(t).add(1).add(3);
    const view = rowView(t, { sort: [{ field: "x" }] });
    view.restrict(picked);
    expect(shown(view)).toEqual([3, 1]);
    t.reset({ x: [9, 8] });
    // The set was of the rows before the reset.
    expect(picked.current).toBe(false);
    expect(shown(view)).toEqual([]);
    view.restrict(null);
    expect(shown(view)).toEqual([1, 0]);
    expect(() => view.restrict(new RowSet(table({ x: [1] })))).toThrow(/its own table/);
  });

  it("tell their listeners they are out of date and stop when disposed", () => {
    const t = table({ x: [1, 2] });
    const view = rowView(t, { filter: col("x").gt(0) });
    let calls = 0;
    view.subscribe(() => calls++);
    t.append({ x: [3] });
    view.setQuery({ filter: col("x").gt(1) });
    expect(calls).toBe(2);
    view.dispose();
    t.append({ x: [4] });
    expect(calls).toBe(2);
  });
});

describe("finding rows in views", () => {
  it("give the query back, so one part can change and the other stay", () => {
    const t = table({ x: [3, 1, 2], host: ["a", "b", "a"] });
    const view = rowView(t, { filter: col("host").eq("a"), sort: [{ field: "x" }] });
    expect(view.query).toEqual({
      filter: ["==", ["field", "host"], "a"],
      sort: [{ field: "x" }],
    });
    expect(Object.isFrozen(view.query.sort)).toBe(true);
    view.setQuery({ ...view.query, sort: [{ field: "x", order: "descending" }] });
    expect(shown(view)).toEqual([0, 2]);
    view.setQuery({ filter: true });
    expect(view.query).toEqual({});
  });

  it("keep their own copy of the filter", () => {
    const t = table({ x: [1, 5, 9] });
    const limit: [">", ["field", "x"], number] = [">", ["field", "x"], 2];
    const view = rowView(t, { filter: limit });
    limit[2] = 6;
    expect(shown(view)).toEqual([1, 2]);
    expect(Object.isFrozen(view.query.filter)).toBe(true);
  });

  it("count changes of query and restriction apart from changes of the table", () => {
    const t = table({ x: [1, 2] });
    const view = rowView(t);
    t.append({ x: [3] });
    expect(view.queryRevision).toBe(0);
    view.setQuery({ sort: [{ field: "x" }] });
    view.restrict(new RowSet(t).add(0));
    expect(view.queryRevision).toBe(2);
    expect(view.revision).toBe(3);
  });

  it("find where a row shows, in every kind of view, and -1 for rows left out", () => {
    const next = random(3);
    const value = () => (next() < 0.1 ? Number.NaN : Math.round(next() * 10));
    const tag = () => ["b", "a", null][Math.floor(next() * 3)]!;
    const t = table(
      { x: Array.from({ length: 200 }, value), tag: Array.from({ length: 200 }, tag) },
      { maxRows: 250 },
    );
    const views = [
      rowView(t),
      rowView(t, { filter: col("x").gt(4) }),
      rowView(t, { sort: [{ field: "x", order: "descending" }] }),
      rowView(t, { filter: col("x").ge(2), sort: [{ field: "tag" }, { field: "x" }] }),
    ];
    for (let step = 0; step < 4; step++) {
      for (const view of views) {
        const order = shown(view);
        for (let row = 0; row < t.length; row++)
          expect(view.indexOf(row), `row ${row}`).toBe(order.indexOf(row));
      }
      t.append({ x: Array.from({ length: 30 }, value), tag: Array.from({ length: 30 }, tag) });
    }
    for (const view of views) {
      expect(view.indexOf(-1)).toBe(-1);
      expect(view.indexOf(t.length)).toBe(-1);
      expect(view.indexOf(0.5)).toBe(-1);
    }
  });
});
