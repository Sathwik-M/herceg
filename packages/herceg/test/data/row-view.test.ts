import { describe, expect, it } from "vitest";
import { category } from "../../src/data/column.ts";
import { col, when } from "../../src/data/expression.ts";
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

  it("stay equal to a fresh view as rows they filter and sort by change in place", () => {
    const next = random(11);
    const value = () => (next() < 0.05 ? Number.NaN : Math.round(next() * 50));
    const tag = () => ["a", "b", "c", "d", null][Math.floor(next() * 5)]!;
    const t = table(
      { x: Array.from({ length: 400 }, value), tag: Array.from({ length: 400 }, tag) },
      { maxRows: 600 },
    );
    const sorted = {
      filter: col("x").gt(5),
      sort: [{ field: "tag" as const }, { field: "x" as const, order: "descending" as const }],
    };
    const filtered = { filter: col("tag").isIn("a", "c") };
    const members = new RowSet(t);
    for (let row = 0; row < t.length; row += 3) members.add(row);
    const restricted = () => {
      const view = rowView(t, { sort: [{ field: "x" }] });
      view.restrict(members);
      return view;
    };
    const views = [rowView(t, sorted), rowView(t, filtered), restricted()];
    const fresh = () => [rowView(t, sorted), rowView(t, filtered), restricted()];
    for (let step = 0; step < 80; step++) {
      // A few rows change, now and then many, between appends and drops.
      const changes = step % 10 === 9 ? 120 : 1 + Math.floor(next() * 6);
      for (let i = 0; i < changes; i++) {
        const row = Math.floor(next() * t.length);
        if (next() < 0.5) t.set("x", row, value());
        else t.set("tag", row, step % 13 === 0 ? `new ${step}` : tag());
      }
      if (step % 4 === 1) t.replace("x", Math.floor(next() * (t.length - 5)), [1, 60, 2, 59, 3]);
      if (step % 5 === 2) t.append({ x: [value(), value()], tag: [tag(), tag()] });
      if (step % 6 === 4) t.dropFirst(3);
      // Read on most steps, so several changes sometimes catch up at once.
      if (step % 3 === 2) continue;
      const expected = fresh();
      views.forEach((view, i) => {
        const order = shown(expected[i]!);
        expect(shown(view)).toEqual(order);
        for (const at of [0, order.length >> 1, order.length - 1])
          if (at >= 0) expect(view.indexOf(order[at]!)).toBe(at);
      });
    }
  });

  it("place updated rows anew in large and selective views alike", () => {
    const n = 20_000;
    const t = table({ x: Float64Array.from({ length: n }, (_, i) => i) });
    // A view of most rows marks updated ones; one of a few searches for them.
    const wide = rowView(t, { sort: [{ field: "x", order: "descending" }] });
    const narrow = rowView(t, { filter: col("x").lt(10).or(col("x").gt(19_990)) });
    shown(wide);
    shown(narrow);
    for (const [row, value] of [
      [5, 50_000],
      [19_995, 3],
      [12_000, 7],
      [3, 15_000],
    ] as const)
      t.set("x", row, value);
    expect(shown(wide).slice(0, 3)).toEqual([5, 19_999, 19_998]);
    expect(shown(wide).at(-1)).toBe(0);
    expect(shown(narrow)).toEqual(shown(rowView(t, { filter: narrow.query.filter })));
    expect(narrow.indexOf(12_000)).toBeGreaterThanOrEqual(0);
    expect(narrow.indexOf(3)).toBe(-1);
  });

  it("place updated rows anew across drops, evicting appends, resets, and rows not placed yet", () => {
    const t = table({ x: [5, 4, 3, 2, 1, 0] }, { maxRows: 6 });
    const view = rowView(t, { sort: [{ field: "x" }] });
    expect(shown(view)).toEqual([5, 4, 3, 2, 1, 0]);
    // Updated, then evicted by an append larger than the window, unread.
    t.set("x", 2, 100);
    t.append({ x: [9, 8, 7, 6, 5, 4, 3] });
    expect(shown(view)).toEqual(shown(rowView(t, { sort: [{ field: "x" }] })));
    // Rows appended and updated before the view placed them.
    t.append({ x: [50, 60] });
    t.set("x", 5, -1);
    t.set("x", 0, 70);
    expect(shown(view)).toEqual(shown(rowView(t, { sort: [{ field: "x" }] })));
    // Updated rows pending when the table is reset.
    t.set("x", 1, -5);
    t.reset({ x: [2, 1] });
    expect(shown(view)).toEqual([1, 0]);
  });

  it("place an updated row by where it is when a listener before them moved it", () => {
    const t = table({ x: Float64Array.from({ length: 100 }, (_, i) => i) });
    let dropping = true;
    t.subscribe((change) => {
      if (dropping && change.updated) {
        dropping = false;
        t.dropFirst(1);
      }
    });
    const view = rowView(t, { sort: [{ field: "x" }] });
    shown(view);
    t.set("x", 20, -1);
    expect(shown(view).slice(0, 3)).toEqual([19, 0, 1]);
    expect(view.indexOf(19)).toBe(0);
  });

  it("leave out rows whose filter is missing, keeping the rows around them", () => {
    const t = table({ x: [0, 1, 2] });
    const view = rowView(t, { filter: when(col("x").eq(1), null, true) });
    expect(shown(view)).toEqual([0, 2]);
    t.append({ x: [1, 3] });
    expect(shown(view)).toEqual([0, 2, 4]);
  });

  it("match category members that arrive after the filter was set", () => {
    const t = table({ tag: category(["a", "b"]) });
    const view = rowView(t, { filter: col("tag").isIn("b", "late") });
    expect(shown(view)).toEqual([1]);
    t.append({ tag: ["late", "a", "other", "late"] });
    expect(shown(view)).toEqual([1, 2, 5]);
    t.dropFirst(2);
    t.append({ tag: ["b"] });
    expect(shown(view)).toEqual([0, 3, 4]);
  });

  it("reorder when the fields they filter or sort by change, and keep rows otherwise", () => {
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
