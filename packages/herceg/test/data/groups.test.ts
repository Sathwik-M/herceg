// Row groups: aggregates over a view's positions, as derived tables compute
// them, kept current as the view's table streams, with stable keys.
import { describe, expect, it } from "vitest";
import { category, time } from "../../src/data/column.ts";
import { count, derive, max, mean, min, sum } from "../../src/data/derive.ts";
import { col } from "../../src/data/expression.ts";
import { groupId, groupRows } from "../../src/data/groups.ts";
import { RowSet } from "../../src/data/row-set.ts";
import { rowView } from "../../src/data/row-view.ts";
import { type Schema, type Table, type TableChange, table } from "../../src/data/table.ts";

/** A table's rows as objects, missing values as null. */
const rows = <S extends Schema>(t: Table<S>) =>
  Array.from({ length: t.length }, (_, i) =>
    Object.fromEntries(t.fields().map((field) => [field, t.value(field, i)])),
  );

const OPS = {
  n: count(),
  finite: count("ms"),
  total: sum("ms"),
  avg: mean("ms"),
  low: min("ms"),
  high: max("ms"),
};

/** Requests with missing and infinite latencies, and a missing host. */
const requests = () =>
  table({
    host: ["web", "api", "web", null, "api", "db", "web", "api"],
    ms: [10, 20, Number.NaN, 5, Number.POSITIVE_INFINITY, 7.5, -2, 0.1],
    at: time([5, 1, 4, 2, 8, 3, 7, 6]),
  });

describe("row groups", () => {
  it("aggregate as derived tables do: counts of rows and of finite values, sums, means, and extremes", () => {
    const t = requests();
    const groups = groupRows(rowView(t), { by: ["host"], ops: OPS });
    const derived = derive(t)
      .aggregate({ groupby: ["host"], ops: OPS })
      .table();
    expect(rows(groups.table)).toEqual(rows(derived));
    expect(rows(groups.table)).toEqual([
      { host: "web", n: 3, finite: 2, total: 8, avg: 4, low: -2, high: 10 },
      { host: "api", n: 3, finite: 2, total: 20.1, avg: 10.05, low: 0.1, high: 20 },
      { host: null, n: 1, finite: 1, total: 5, avg: 5, low: 5, high: 5 },
      { host: "db", n: 1, finite: 1, total: 7.5, avg: 7.5, low: 7.5, high: 7.5 },
    ]);
    expect(groups.length).toBe(4);
    expect([0, 1, 2, 3].map((g) => groups.size(g))).toEqual([3, 3, 1, 1]);
  });

  it("read the rows a view shows, filtered, restricted, or sorted, in table order", () => {
    const t = requests();
    const filtered = groupRows(rowView(t, { filter: col("ms").lt(15) }), {
      by: ["host"],
      ops: OPS,
    });
    const derived = derive(t)
      .filter(col("ms").lt(15))
      .aggregate({ groupby: ["host"], ops: OPS })
      .table();
    expect(rows(filtered.table)).toEqual(rows(derived));
    // Sorting changes neither the groups nor their order: groups come in the
    // order they first appear in the table, and sums add in table order.
    const sorted = groupRows(rowView(t, { sort: [{ field: "at", order: "descending" }] }), {
      by: ["host"],
      ops: OPS,
    });
    expect(rows(sorted.table)).toEqual(
      rows(groupRows(rowView(t), { by: ["host"], ops: OPS }).table),
    );
    const view = rowView(t);
    view.restrict(new RowSet(t).add(1).add(5));
    expect(rows(groupRows(view, { by: ["host"], ops: { n: count() } }).table)).toEqual([
      { host: "api", n: 1 },
      { host: "db", n: 1 },
    ]);
  });

  it("list each group's rows in the view's order, and find a row among them", () => {
    const t = requests();
    const groups = groupRows(rowView(t, { sort: [{ field: "at" }] }), { by: ["host"] });
    // at: 5 1 4 2 8 3 7 6 for rows 0 to 7.
    expect(Array.from(groups.members(0))).toEqual([2, 0, 6]);
    expect(Array.from(groups.members(1))).toEqual([1, 7, 4]);
    expect(groups.groupOf(6)).toBe(0);
    expect(groups.memberIndex(6)).toBe(2);
    expect(groups.memberIndex(7)).toBe(1);
    const unsorted = groupRows(rowView(t, { filter: col("host").ne("db") }), { by: ["host"] });
    expect(Array.from(unsorted.members(1))).toEqual([1, 4, 7]);
    expect(unsorted.groupOf(5)).toBe(-1);
    expect(unsorted.memberIndex(5)).toBe(-1);
    expect(unsorted.memberIndex(4)).toBe(1);
  });

  it("group by several fields, numbers and times among them, with missing values as groups", () => {
    const t = table({
      a: ["x", "x", "y", null, "x", "y"],
      b: [1, 2, 1, 1, 1, Number.NaN],
      t: time([0, 0, 0, 0, 0, 0]),
      v: [1, 2, 3, 4, 5, 6],
    });
    const groups = groupRows(rowView(t), { by: ["a", "b", "t"], ops: { s: sum("v") } });
    expect(rows(groups.table)).toEqual([
      { a: "x", b: 1, t: 0, s: 6 },
      { a: "x", b: 2, t: 0, s: 2 },
      { a: "y", b: 1, t: 0, s: 3 },
      { a: null, b: 1, t: 0, s: 4 },
      { a: "y", b: null, t: 0, s: 6 },
    ]);
    expect(groups.table.kind("t")).toBe("time");
    expect(groups.keyOf(4)).toEqual(["y", null, 0]);
    expect(groups.indexOf(["y", null, 0])).toBe(4);
    expect(groups.indexOf(["x", 1, 0])).toBe(0);
    expect(groups.indexOf(["x", 3, 0])).toBe(-1);
    expect(groups.indexOf(["x", "1", 0])).toBe(-1);
    expect(groups.indexOf(["x", 1])).toBe(-1);
  });

  it("keep -0 with 0 and infinities apart from missing values, in keys and their ids", () => {
    const t = table({ k: [0, -0, Number.POSITIVE_INFINITY, Number.NaN, Number.NEGATIVE_INFINITY] });
    const groups = groupRows(rowView(t), { by: ["k"], ops: { n: count() } });
    expect(Array.from({ length: groups.length }, (_, g) => groups.keyOf(g))).toEqual([
      [0],
      [Number.POSITIVE_INFINITY],
      [null],
      [Number.NEGATIVE_INFINITY],
    ]);
    expect(Object.is(groups.keyOf(0)[0], -0)).toBe(false);
    expect(groups.indexOf([-0])).toBe(0);
    expect(groups.indexOf([null])).toBe(2);
    const ids = Array.from({ length: groups.length }, (_, g) => groups.idOf(g));
    expect(ids).toEqual(["[0]", '["Infinity"]', "[null]", '["-Infinity"]']);
    expect(groupId(["null", null])).toBe('["null",null]');
  });

  it("give times as times for means and extremes of times, numbers for their counts and sums", () => {
    const t = table({ g: ["a", "a"], at: time([10, 20]) });
    const groups = groupRows(rowView(t), {
      by: ["g"],
      ops: { first: min("at"), n: count("at"), avg: mean("at"), total: sum("at") },
    });
    expect(["first", "n", "avg", "total"].map((f) => groups.table.kind(f as never))).toEqual([
      "time",
      "number",
      "time",
      "number",
    ]);
  });

  it("refuse fields they cannot group by or aggregate, and names given twice", () => {
    const t = requests();
    const view = rowView(t);
    const make = (options: unknown) => () => groupRows(view, options as never);
    expect(make({ by: [] })).toThrow(/at least one field/);
    expect(make({ by: ["nope"] })).toThrow(/Unknown grouping field "nope"/);
    expect(make({ by: ["host", "host"] })).toThrow(/given twice/);
    expect(make({ by: ["host"], ops: { host: count() } })).toThrow(/name of a grouping field/);
    expect(make({ by: ["host"], ops: { s: { op: "sum" } } })).toThrow(/needs a field/);
    expect(make({ by: ["host"], ops: { s: { op: "median", field: "ms" } } })).toThrow(
      /no "median"/,
    );
    expect(make({ by: ["host"], ops: { s: sum("host") } })).toThrow(/is a category/);
    expect(make({ by: ["host"], ops: { s: sum("nope") } })).toThrow(/unknown field "nope"/);
  });
});

describe("row groups following their view", () => {
  /** A table's changes from now on. */
  const changesOf = (t: Table) => {
    const changes: TableChange[] = [];
    t.subscribe((change) => changes.push(change));
    return changes;
  };
  /** The groups' table as computed from scratch. */
  const fresh = <S extends Schema>(t: Table<S>, query = {}) =>
    rows(groupRows(rowView(t as unknown as Table, query), { by: ["host"], ops: OPS }).table);

  it("update the aggregates of the groups appended rows join, and add the groups they start, as one change", () => {
    const t = requests();
    const groups = groupRows(rowView(t), { by: ["host"], ops: OPS });
    const table = groups.table as unknown as Table;
    const changes = changesOf(table);
    // Each change shows the groups' table whole: as computed afresh.
    const seen: unknown[] = [];
    table.subscribe(() => seen.push(rows(groups.table)));
    // api (1) and db (3) gain a row each: 1 and 2; only db's minimum changes.
    t.append({ host: ["api", "db"], ms: [1, 2], at: [9, 10] });
    expect(changes).toEqual([
      {
        dropped: 0,
        appended: 0,
        updated: { start: 1, end: 4 },
        fields: ["n", "finite", "total", "avg", "low"],
        reset: false,
      },
    ]);
    expect(seen).toEqual([fresh(t)]);
    changes.length = 0;
    // web's mean stays 4 (8 over 2 rows, then 12 over 3): it is not written.
    t.append({ host: ["cache", "web"], ms: [3, 4], at: [11, 12] });
    expect(changes).toEqual([
      {
        dropped: 0,
        appended: 1,
        updated: { start: 0, end: 1 },
        fields: ["n", "finite", "total"],
        reset: false,
      },
    ]);
    expect(seen.at(-1)).toEqual(fresh(t));
    expect(rows(groups.table)).toEqual(fresh(t));
    // Appends keep the table's row identities.
    expect(groups.table.generation).toBe(0);
    // Rows the view leaves out change nothing.
    const filtered = groupRows(rowView(t, { filter: col("host").eq("web") }), { by: ["host"] });
    const none = changesOf(filtered.table as unknown as Table);
    t.append({ host: ["api"], ms: [1], at: [13] });
    expect(none).toEqual([]);
  });

  it("write the groups that changed, not every group between them", () => {
    const keys = Array.from({ length: 1000 }, (_, i) => `k${i}`);
    const t = table({ k: keys, v: keys.map((_, i) => i) });
    const groups = groupRows(rowView(t), { by: ["k"], ops: { total: sum("v") } });
    const summary = groups.table as unknown as Table;
    const written: number[] = [];
    const replace = summary.replace.bind(summary);
    summary.replace = ((field: never, start: number, values: ArrayLike<number>) => {
      written.push(start, values.length);
      replace(field, start, values as never);
    }) as typeof summary.replace;
    t.append({ k: ["k0", "k999"], v: [1, 1] });
    expect(written).toEqual([0, 1, 999, 1]);
    expect(groups.table.value("total", 999)).toBe(1000);
  });

  it("follow sorted views as appended rows merge into them", () => {
    const t = requests();
    const query = { sort: [{ field: "ms" as const }], filter: col("ms").gt(0) };
    const groups = groupRows(rowView(t, query), { by: ["host"], ops: OPS });
    t.append({ host: ["web", "new", "api"], ms: [1, 100, Number.NaN], at: [0, 0, 0] });
    expect(rows(groups.table)).toEqual(fresh(t, query));
    expect(Array.from(groups.members(0))).toEqual([8, 0]);
    expect(groups.memberIndex(8)).toBe(0);
    expect(groups.keyOf(groups.length - 1)).toEqual(["new"]);
  });

  it("recompute when rows drop, keeping the order of the groups left and the table's rows when none vanished", () => {
    const t = table(
      { host: ["web", "api", "web", "db"], ms: [1, 2, 3, 4], at: time([0, 0, 0, 0]) },
      { maxRows: 4 },
    );
    const groups = groupRows(rowView(t), { by: ["host"], ops: OPS });
    const changes = changesOf(groups.table as unknown as Table);
    // "web" first appears at row 2 once row 0 drops; it keeps its place.
    t.append({ host: ["api"], ms: [5], at: [0] });
    expect(rows(groups.table).map(({ host, n }) => [host, n])).toEqual([
      ["web", 1],
      ["api", 2],
      ["db", 1],
    ]);
    expect(changes.map(({ reset }) => reset)).toEqual([false]);
    // "api" keeps two rows, "web" loses its last: the table starts over, in the same order.
    t.append({ host: ["db", "cache"], ms: [6, 7], at: [0, 0] });
    expect(rows(groups.table).map(({ host, n }) => [host, n])).toEqual([
      ["api", 1],
      ["db", 2],
      ["cache", 1],
    ]);
    expect(changes.at(-1)!.reset).toBe(true);
    expect(groups.indexOf(["web"])).toBe(-1);
    expect(groups.indexOf(["cache"])).toBe(2);
  });

  it("leave the table alone when only the view's order or a field they do not read changes", () => {
    const t = table({ host: ["web", "api", "web"], ms: [3, 1, 2], note: [0, 0, 0] });
    const view = rowView(t);
    const groups = groupRows(view, { by: ["host"], ops: { total: sum("ms") } });
    const changes = changesOf(groups.table as unknown as Table);
    const revision = groups.revision;
    t.set("note", 0, 1);
    expect(groups.revision).toBe(revision);
    view.setQuery({ sort: [{ field: "ms" }] });
    expect(changes).toEqual([]);
    expect(groups.revision).toBeGreaterThan(revision);
    expect(Array.from(groups.members(0))).toEqual([2, 0]);
    // A sort field changed in place reorders the rows, not the aggregates.
    t.set("ms", 2, 5);
    expect(Array.from(groups.members(0))).toEqual([0, 2]);
    expect(rows(groups.table)).toEqual([
      { host: "web", total: 8 },
      { host: "api", total: 1 },
    ]);
    expect(changes.map(({ updated, fields }) => [fields, updated])).toEqual([
      [["total"], { start: 0, end: 1 }],
    ]);
    view.setQuery({ filter: col("ms").gt(2) });
    expect(rows(groups.table)).toEqual([{ host: "web", total: 8 }]);
  });

  it("recompute after values change in place in a field they group by", () => {
    const t = requests();
    const groups = groupRows(rowView(t), { by: ["host"], ops: OPS });
    t.set("host", 5, "web");
    expect(rows(groups.table)).toEqual(fresh(t));
    t.replace("ms", 0, [100, 200]);
    expect(rows(groups.table)).toEqual(fresh(t));
  });

  it("keep their keys through resets, where groups that remain keep their order", () => {
    const t = requests();
    const groups = groupRows(rowView(t), { by: ["host"], ops: { n: count() } });
    t.reset({ host: ["db", "web", "new"], ms: [1, 2, 3], at: [0, 0, 0] });
    expect(rows(groups.table)).toEqual([
      { host: "web", n: 1 },
      { host: "db", n: 1 },
      { host: "new", n: 1 },
    ]);
    expect(groups.indexOf(["db"])).toBe(1);
    expect(groups.idOf(1)).toBe('["db"]');
  });

  it("are current inside listeners of the table that run before they hear of a change", () => {
    const t = requests();
    let seen: unknown[] = [];
    let groups: ReturnType<typeof make> | undefined;
    const make = () => groupRows(rowView(t), { by: ["host"], ops: { n: count() } });
    // Subscribed first, so it runs before the view and the groups hear of the change.
    t.subscribe(() => {
      if (groups) seen = Array.from({ length: groups.length }, (_, g) => groups!.keyOf(g));
    });
    groups = make();
    t.set("host", 0, "cache");
    expect(seen).toEqual([["web"], ["api"], [null], ["db"], ["cache"]]);
    expect(rows(groups.table)).toEqual([
      { host: "web", n: 2 },
      { host: "api", n: 3 },
      { host: null, n: 1 },
      { host: "db", n: 1 },
      { host: "cache", n: 1 },
    ]);
  });

  it("stay whole when listeners of their table read them or change their source", () => {
    const t = requests();
    const groups = groupRows(rowView(t, { sort: [{ field: "ms" }] }), { by: ["host"], ops: OPS });
    const seen: unknown[] = [];
    let more = true;
    groups.table.subscribe(() => {
      seen.push([groups.length, Array.from(groups.members(0))]);
      // Once, a listener appends to the groups' source while they change their table.
      if (more) {
        more = false;
        t.append({ host: ["web"], ms: [3], at: [0] });
      }
    });
    t.append({ host: ["web", "new"], ms: [1, 2], at: [0, 0] });
    expect(rows(groups.table)).toEqual(fresh(t, { sort: [{ field: "ms" }] }));
    // web's rows by latency: -2 (row 6), 1 (8), 3 (10), 10 (0), then the missing one (2).
    expect(seen.at(-1)).toEqual([5, [6, 8, 10, 0, 2]]);
    expect(groups.size(0)).toBe(5);
  });

  it("are kept following by their table, and stop when disposed", () => {
    const t = requests();
    const { table: summary } = groupRows(rowView(t), { by: ["host"], ops: { n: count() } });
    t.append({ host: ["web"], ms: [1], at: [0] });
    expect(summary.value("n", 0)).toBe(4);
    const groups = groupRows(rowView(t), { by: ["host"], ops: { n: count() } });
    groups.dispose();
    t.append({ host: ["web"], ms: [1], at: [0] });
    expect(groups.table.value("n", 0)).toBe(4);
    expect(groups.groupOf(0)).toBe(-1);
    expect(groups.byteLength).toBeGreaterThan(0);
  });

  it("start again on a table changed by someone else", () => {
    const t = requests();
    const groups = groupRows(rowView(t), { by: ["host"], ops: { n: count() } });
    (groups.table as unknown as Table).dropFirst(2);
    t.append({ host: ["web"], ms: [1], at: [0] });
    expect(rows(groups.table).map(({ host }) => host)).toEqual(["web", "api", null, "db"]);
  });

  it("match recomputing from scratch through a mixed stream", () => {
    const hosts = ["web", "api", "db", "cache", null];
    let seed = 7;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const batch = (n: number) => ({
      host: Array.from({ length: n }, () => hosts[Math.floor(random() * hosts.length)]!),
      ms: Array.from({ length: n }, () => (random() < 0.1 ? Number.NaN : random() * 100)),
      at: Array.from({ length: n }, () => Math.floor(random() * 1000)),
    });
    const t = table({ host: category([]), ms: [] as number[], at: time([]) }, { maxRows: 400 });
    const query = { filter: col("ms").gt(10), sort: [{ field: "at" as const }] };
    const view = rowView(t, query);
    const groups = groupRows(view, { by: ["host"], ops: OPS });
    for (let step = 0; step < 60; step++) {
      if (step % 7 === 3) t.set("ms", Math.floor(random() * t.length), random() * 100);
      else t.append(batch(1 + Math.floor(random() * 40)));
      const expected = fresh(t, query);
      const actual = rows(groups.table);
      // Same groups and aggregates; groups may keep an older order than a fresh start would.
      const byHost = (list: Record<string, unknown>[]) =>
        [...list].sort((a, b) => String(a.host).localeCompare(String(b.host)));
      expect(byHost(actual)).toEqual(byHost(expected));
      const shown = view.read();
      for (let g = 0; g < groups.length; g++) {
        const members = Array.from(groups.members(g));
        expect(members).toEqual(
          Array.from(shown.indices!.subarray(0, shown.length)).filter(
            (p) => groups.groupOf(p) === g,
          ),
        );
      }
    }
  });
});
