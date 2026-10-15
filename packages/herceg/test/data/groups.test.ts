// Row groups: aggregates over a view's positions, as derived tables compute
// them, kept current as the view's table streams, with stable keys.
import { describe, expect, it, vi } from "vitest";
import { category, encodedCategory, time } from "../../src/data/column.ts";
import { count, derive, max, mean, min, sum } from "../../src/data/derive.ts";
import { col } from "../../src/data/expr.ts";
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
      .aggregate({ by: ["host"], ops: OPS })
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
      .aggregate({ by: ["host"], ops: OPS })
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
    // Shorter keys name the groups above: "x" then 1, of the second level.
    expect(groups.indexOf(["x", 1])).toBe(0);
    expect(groups.indexOf(["x", 1, 0, 0])).toBe(-1);
    expect(groups.indexOf([])).toBe(-1);
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

/** Rows with numbers rounded to 12 significant digits: sums are compensated, derived ones are not. */
const rounded = (list: Record<string, unknown>[]) =>
  list.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([field, value]) => [
        field,
        typeof value === "number" ? Number(value.toPrecision(12)) : value,
      ]),
    ),
  );

/** A deterministic stream of numbers in [0, 1). */
const randoms = (seed: number) => () => {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647;
};

/** Requests over regions, services, and hosts, some latencies missing or infinite. */
function traffic(n: number, random = randoms(11)) {
  const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)]!;
  return {
    region: Array.from({ length: n }, () => pick(["eu", "us", "ap", null])),
    service: Array.from({ length: n }, () => pick(["api", "web", "db"])),
    host: Array.from({ length: n }, () => pick([1, 2, 3, 4, Number.NaN])),
    ms: Array.from({ length: n }, () =>
      random() < 0.1
        ? pick([Number.NaN, Number.POSITIVE_INFINITY])
        : Math.round(random() * 1e4) / 8,
    ),
    at: Array.from({ length: n }, () => Math.floor(random() * 1e6)),
  };
}

const BY = ["region", "service", "host"] as const;

/** Each level's table as derived tables aggregate its fields. */
const derived = (t: Table, query: { filter?: unknown } = {}) =>
  BY.map((_, depth) => {
    let steps = derive(t);
    if (query.filter) steps = steps.filter(query.filter as never);
    return rounded(rows(steps.aggregate({ by: BY.slice(0, depth + 1), ops: OPS }).table()));
  });

describe("nested row groups", () => {
  it("aggregate every level as derived tables aggregate the fields down to it", () => {
    const t = table({ ...traffic(500), region: category(traffic(500).region) });
    const groups = groupRows(rowView(t), { by: BY, ops: OPS });
    const levels = BY.map((field) => rounded(rows(groups.tableOf(field))));
    expect(levels).toEqual(derived(t as unknown as Table));
    expect(groups.table).toBe(groups.tableOf("host"));
    expect(BY.map((_, depth) => groups.countAt(depth))).toEqual(levels.map((l) => l.length));
    expect(groups.length).toBe(levels[2]!.length);
    // Each level's table has the grouping fields down to it, then the aggregates.
    expect(groups.tableOf("region").fields()).toEqual(["region", ...Object.keys(OPS)]);
    expect(groups.tableOf("service").fields()).toEqual(["region", "service", ...Object.keys(OPS)]);
  });

  it("combine a parent's mean from its rows' sums and counts, not its groups' means", () => {
    const t = table({ g: ["a", "a", "a", "a"], h: ["x", "y", "y", "y"], v: [10, 0, 0, 0] });
    const groups = groupRows(rowView(t), { by: ["g", "h"], ops: { avg: mean("v"), n: count() } });
    expect(rows(groups.table)).toEqual([
      { g: "a", h: "x", avg: 10, n: 1 },
      { g: "a", h: "y", avg: 0, n: 3 },
    ]);
    expect(rows(groups.tableOf("g"))).toEqual([{ g: "a", avg: 2.5, n: 4 }]);
  });

  it("name groups by key paths, with their parents, children, rows, and members at every level", () => {
    const t = table({
      region: ["eu", "us", "eu", "eu", "us", null],
      service: ["api", "api", "web", "api", "db", "api"],
      ms: [1, 2, 3, 4, 5, 6],
    });
    const groups = groupRows(rowView(t, { sort: [{ field: "ms", order: "descending" }] }), {
      by: ["region", "service"],
      ops: { n: count() },
    });
    // eu: api (rows 0, 3), web (2); us: api (1), db (4); missing: api (5).
    expect([0, 1, 2].map((g) => groups.keyOf(g, 0))).toEqual([["eu"], ["us"], [null]]);
    expect(groups.keyOf(3)).toEqual(["us", "db"]);
    expect(groups.indexOf(["us", "db"])).toBe(3);
    expect(groups.indexOf(["us"])).toBe(1);
    expect(groups.indexOf([null, "api"])).toBe(4);
    expect(groups.idOf(1, 0)).toBe('["us"]');
    expect(groups.idOf(1)).toBe('["us","api"]');
    expect(Array.from(groups.childrenOf(0, 0))).toEqual([0, 2]);
    expect(Array.from(groups.childrenOf(1, 0))).toEqual([1, 3]);
    expect(groups.childrenOf(0, 1)).toHaveLength(0);
    expect([0, 1, 2, 3, 4].map((g) => groups.parentOf(g, 1))).toEqual([0, 1, 0, 1, 2]);
    expect(groups.parentOf(1, 0)).toBe(-1);
    expect([groups.size(0, 0), groups.size(0)]).toEqual([3, 2]);
    expect([groups.groupOf(2), groups.groupOf(2, 0)]).toEqual([2, 0]);
    // Rows in the view's order within each last-level group, those groups in the order they appeared.
    expect(Array.from(groups.members(0))).toEqual([3, 0]);
    expect(Array.from(groups.members(0, 0))).toEqual([3, 0, 2]);
    expect([groups.memberAt(0, 0), groups.memberIndex(0)]).toEqual([3, 1]);
    expect(() => groups.keyOf(3, 0)).toThrow(/not among the 3 groups at depth 0/);
    expect(() => groups.countAt(2)).toThrow(/Depth 2/);
    expect(() => groups.tableOf("ms" as never)).toThrow(/no grouping field "ms"/);
    expect(() => groups.memberAt(0, 2)).toThrow(/no row 2/);
  });
});

describe("row groups in streams", () => {
  /** Every level's table as computed from scratch, each sorted by key to compare. */
  const fresh = (t: Table, query = {}) => {
    const groups = groupRows(rowView(t, query), { by: BY, ops: OPS });
    return BY.map((field) => byKey(rounded(rows(groups.tableOf(field)))));
  };
  const byKey = (list: Record<string, unknown>[]) =>
    [...list].sort((a, b) =>
      JSON.stringify(BY.map((f) => a[f])).localeCompare(JSON.stringify(BY.map((f) => b[f]))),
    );

  it("follow a rolling window by taking dropped rows away, as computing again would give", () => {
    const random = randoms(5);
    const t = table(
      {
        region: category([]),
        service: category([]),
        host: [] as number[],
        ms: [] as number[],
        at: [] as number[],
      },
      { maxRows: 300 },
    );
    for (const query of [{}, { filter: col("ms").gt(100), sort: [{ field: "at" as const }] }]) {
      const view = rowView(t, query);
      const groups = groupRows(view, { by: BY, ops: OPS });
      const resets = BY.map((field) => changesOf(groups.tableOf(field) as unknown as Table));
      for (let step = 0; step < 80; step++) {
        const batch = traffic(1 + Math.floor(random() * 60), random);
        t.append(batch);
        expect(BY.map((field) => byKey(rounded(rows(groups.tableOf(field)))))).toEqual(
          fresh(t as unknown as Table, query),
        );
        // Rows of every last-level group, in the view's order.
        if (step % 10 === 0) {
          const shown = view.read();
          const order = shown.indices ? Array.from(shown.indices) : [...Array(t.length).keys()];
          for (let g = 0; g < groups.length; g++)
            expect(Array.from(groups.members(g))).toEqual(
              order.filter((p) => groups.groupOf(p) === g),
            );
        }
      }
      // The first level's three regions and missing one never vanish: its table never starts over.
      expect(resets[0]!.some(({ reset }) => reset)).toBe(false);
    }
  });

  it("find minimums and maximums again when theirs leave, and keep sums from drifting", () => {
    const t = table({ g: category([]), v: [] as number[] }, { maxRows: 3 });
    const groups = groupRows(rowView(t), {
      by: ["g"],
      ops: { low: min("v"), high: max("v"), total: sum("v"), avg: mean("v") },
    });
    t.append({ g: ["a", "a", "a"], v: [0.1, 1e17, 0.2] });
    expect(rows(groups.table)).toEqual([
      { g: "a", low: 0.1, high: 1e17, total: 1e17, avg: 1e17 / 3 },
    ]);
    // 1e17 leaves; plain sums would keep an error of about 16 from its rounding.
    t.append({ g: ["a", "a"], v: [0.3, 0.4] });
    const [row] = rows(groups.table);
    expect(row).toMatchObject({ low: 0.2, high: 0.4 });
    expect(Math.abs((row!.total as number) - 0.9)).toBeLessThan(1e-15);
    // Every value leaves: the sum is 0 exactly, and the mean and extremes missing.
    t.append({ g: ["b", "b", "b"], v: [Number.NaN, 1, 2] });
    expect(rows(groups.table)).toEqual([{ g: "b", low: 1, high: 2, total: 3, avg: 1.5 }]);
  });

  it("keep groups' keys and numbers as rows come and go, and drop groups left without rows", () => {
    const t = table({ g: category(["a", "b", "a"]), h: [1, 1, 2] }, { maxRows: 3 });
    const groups = groupRows(rowView(t), { by: ["g", "h"], ops: { n: count() } });
    const changes = BY.slice(0, 2).map(() => [] as TableChange[]);
    groups.tableOf("g").subscribe((change) => changes[0]!.push(change));
    groups.table.subscribe((change) => changes[1]!.push(change));
    // Drops ("a", 1): "a" keeps a row (h 2), so no group of the first level vanishes.
    t.append({ g: ["b"], h: [2] });
    expect(rows(groups.tableOf("g"))).toEqual([
      { g: "a", n: 1 },
      { g: "b", n: 2 },
    ]);
    expect(rows(groups.table)).toEqual([
      { g: "b", h: 1, n: 1 },
      { g: "a", h: 2, n: 1 },
      { g: "b", h: 2, n: 1 },
    ]);
    expect(changes.map((list) => list.map(({ reset }) => reset))).toEqual([[false], [true]]);
    expect(groups.indexOf(["a", 2])).toBe(1);
    expect(groups.indexOf(["a", 1])).toBe(-1);
    // "a" leaves altogether.
    t.append({ g: ["c", "c"], h: [3, 3] });
    expect(rows(groups.tableOf("g"))).toEqual([
      { g: "b", n: 1 },
      { g: "c", n: 2 },
    ]);
    expect([groups.indexOf(["a"]), groups.indexOf(["c", 3])]).toEqual([-1, 1]);
    expect(groups.keyOf(1)).toEqual(["c", 3]);
  });

  it("follow categories through dictionaries the table compacts as rows drop", () => {
    const random = randoms(3);
    const t = table({ k: category([]), v: [] as number[] }, { maxRows: 20 });
    const groups = groupRows(rowView(t), { by: ["k"], ops: { n: count(), total: sum("v") } });
    for (let step = 0; step < 40; step++) {
      const n = 1 + Math.floor(random() * 12);
      // Labels drift, so old ones leave the window and the table compacts its dictionary.
      t.append({
        k: Array.from({ length: n }, () => `k${step + Math.floor(random() * 4)}`),
        v: Array.from({ length: n }, () => Math.floor(random() * 10)),
      });
      const expected = rows(
        derive(t)
          .aggregate({ by: ["k"], ops: { n: count(), total: sum("v") } })
          .table(),
      );
      const byLabel = (list: Record<string, unknown>[]) =>
        [...list].sort((a, b) => String(a.k).localeCompare(String(b.k)));
      expect(byLabel(rows(groups.table))).toEqual(byLabel(expected));
    }
  });

  it("follow categories whose compacted dictionary gives a label its old code again", () => {
    // k0 to k69, the first row k69: compacting keeps only k68, and k69 comes back as code 69.
    const labels = Array.from({ length: 70 }, (_, i) => `k${i}`);
    const codes = Int32Array.from([69, ...Array.from({ length: 69 }, (_, i) => i)]);
    const t = table({ k: encodedCategory(codes, labels) }, { maxRows: 70 });
    const groups = groupRows(rowView(t), { by: ["k"], ops: { n: count() } });
    t.append({ k: [...Array.from({ length: 68 }, (_, i) => `new${i}`), "k69"] });
    expect(t.categories("k").dictionary[69]).toBe("k69");
    const expected = rows(
      derive(t)
        .aggregate({ by: ["k"], ops: { n: count() } })
        .table(),
    );
    const byLabel = (list: Record<string, unknown>[]) =>
      [...list].sort((a, b) => String(a.k).localeCompare(String(b.k)));
    expect(byLabel(rows(groups.table))).toEqual(byLabel(expected));
    expect(groups.keyOf(groups.groupOf(1))).toEqual(["new0"]);
  });

  it("sum the same way whether or not the table drops rows", () => {
    for (const options of [{}, { maxRows: 100 }]) {
      const t = table({ g: ["a", "a", "a"], v: [1e16, 1, -1e16] }, options);
      const groups = groupRows(rowView(t), { by: ["g"], ops: { total: sum("v") } });
      // A plain sum would lose the 1 in 1e16.
      expect(groups.table.value("total", 0)).toBe(1);
    }
  });

  it("sum again exactly what values cancelling left inaccurate, as they leave or come", () => {
    const ops = { s: sum("v"), avg: mean("v"), lo: min("v") };
    const t = table({ g: ["a", "a", "a"], h: ["x", "x", "x"], v: [1e40, 1e16, 1] }, { maxRows: 3 });
    const groups = groupRows(rowView(t), { by: ["g", "h"], ops });
    t.dropFirst(2);
    for (const field of ["g", "h"] as const)
      expect(rows(groups.tableOf(field))[0]).toMatchObject({ s: 1, avg: 1, lo: 1 });
    // Appended values cancelling: a plain sum would say -1e16.
    const appended = table({ g: ["a"], v: [1e40] });
    const grouped = groupRows(rowView(appended), { by: ["g"], ops: { s: sum("v") } });
    appended.append({ g: ["a", "a", "a", "a"], v: [1e16, 1, -1e40, -1e16] });
    expect(grouped.table.value("s", 0)).toBe(1);
    expect(
      groupRows(rowView(appended), { by: ["g"], ops: { s: sum("v") } }).table.value("s", 0),
    ).toBe(1);
  });

  it("sum a parent exactly when its groups' sums cancel beyond their accuracy", () => {
    const t = table({
      g: ["a", "a", "a", "a", "a"],
      h: ["x", "x", "x", "y", "y"],
      v: [1e40, 1e16, 1, -1e40, -1e16],
    });
    const groups = groupRows(rowView(t), { by: ["g", "h"], ops: { s: sum("v") } });
    expect(groups.tableOf("g").value("s", 0)).toBe(1);
    t.append({ g: ["a"], h: ["y"], v: [1] });
    expect(groups.tableOf("g").value("s", 0)).toBe(2);
  });

  it("sum a parent from its rows when its groups overflowed both ways", () => {
    const t = table({
      g: ["a", "a", "a", "a"],
      h: ["x", "y", "x", "y"],
      v: [1e308, -1e308, 1e308, -1e308],
    });
    const groups = groupRows(rowView(t), { by: ["g", "h"], ops: { s: sum("v"), hi: max("v") } });
    expect(Array.from({ length: 2 }, (_, g) => groups.table.value("s", g))).toEqual([
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]);
    expect(groups.tableOf("g").value("s", 0)).toBe(0);
    // The parent's maximum leaves: it is folded again from groups that overflowed both ways.
    t.dropFirst(1);
    t.append({ g: ["a"], h: ["x"], v: [1e308] });
    expect(groups.tableOf("g").value("s", 0)).toBe(0);
  });

  it("read a parent's rows once when they overflow, not again with every append", () => {
    const t = table({ g: ["a", "a", "a"], h: ["x", "x", "x"], v: [1e308, 1e308, 1] });
    const groups = groupRows(rowView(t), { by: ["g", "h"], ops: { s: sum("v") } });
    expect(groups.tableOf("g").value("s", 0)).toBe(Number.POSITIVE_INFINITY);
    // Reading a parent's rows lists its groups below.
    const children = vi.spyOn(groups, "childrenOf");
    for (let i = 0; i < 10; i++) t.append({ g: ["a"], h: ["x"], v: [1] });
    expect(children).not.toHaveBeenCalled();
    expect(groups.tableOf("g").value("s", 0)).toBe(Number.POSITIVE_INFINITY);
  });

  it("keep a sum that overflowed infinite until the rows that overflowed it leave", () => {
    const t = table({ g: ["a", "a"], v: [1e308, 1e308] }, { maxRows: 2 });
    const groups = groupRows(rowView(t), { by: ["g"], ops: { s: sum("v") } });
    expect(groups.table.value("s", 0)).toBe(Number.POSITIVE_INFINITY);
    t.append({ g: ["a"], v: [1] });
    expect(groups.table.value("s", 0)).toBe(1e308);
  });

  it("find extremes again in table order, as computing again does, signed zeros among them", () => {
    const t = table({ g: ["a", "a", "a"], v: [5, -0, 0], s: [0, 2, 1] }, { maxRows: 3 });
    const query = { sort: [{ field: "s" as const }] };
    const ops = { low: min("v"), high: max("v") };
    const groups = groupRows(rowView(t, query), { by: ["g"], ops });
    // 5, the maximum, leaves: the group's rows are read again.
    t.append({ g: ["a"], v: [1], s: [3] });
    const fresh = groupRows(rowView(t, query), { by: ["g"], ops });
    expect(Object.is(groups.table.value("low", 0), fresh.table.value("low", 0))).toBe(true);
    expect(rows(groups.table)).toEqual(rows(fresh.table));
  });

  it("write every level's table before telling listeners of any", () => {
    const t = table({ g: ["a"], h: ["x"], v: [1] });
    const groups = groupRows(rowView(t), { by: ["g", "h"], ops: { n: count() } });
    const seen: unknown[] = [];
    groups
      .tableOf("g")
      .subscribe(() => seen.push([groups.tableOf("g").value("n", 0), groups.table.value("n", 0)]));
    t.append({ g: ["a"], h: ["x"], v: [2] });
    expect(seen).toEqual([[2, 2]]);
  });

  it("list rows for a listener that streams into the groups' source, and keep them whole after", () => {
    const t = table({ g: ["a", "a"], v: [1, 2] }, { maxRows: 2 });
    const groups = groupRows(rowView(t), { by: ["g"], ops: { total: sum("v") } });
    const read: number[][] = [];
    let once = true;
    groups.table.subscribe(() => {
      if (!once) return;
      once = false;
      t.append({ g: ["a"], v: [4] });
      // Read while the groups have yet to take that append: the rows still in the table.
      read.push(Array.from(groups.members(0)));
    });
    t.append({ g: ["a"], v: [3] });
    expect(read).toEqual([[0]]);
    expect(Array.from(groups.members(0))).toEqual([0, 1]);
    expect([groups.size(0), groups.table.value("total", 0)]).toEqual([2, 7]);
  });

  it("answer a listener that streams into their source as they were, cached rows or not", () => {
    for (const cached of [false, true]) {
      const t = table({ g: ["a", "b"], v: [1, 2] }, { maxRows: 2 });
      const groups = groupRows(rowView(t), { by: ["g"], ops: { s: sum("v") } });
      if (cached) groups.members(1);
      const read: unknown[] = [];
      let once = true;
      groups.table.subscribe(() => {
        if (!once) return;
        once = false;
        // Drops b's row (the groups' a, then b) and appends one of b's, which they have yet to take.
        t.append({ g: ["b"], v: [4] });
        read.push([
          Array.from(groups.members(0)),
          Array.from(groups.members(1)),
          groups.groupOf(0),
          groups.memberIndex(0),
          groups.groupOf(1),
        ]);
      });
      t.append({ g: ["a"], v: [3] });
      expect(read).toEqual([[[0], [], 0, 0, -1]]);
      expect([Array.from(groups.members(0)), Array.from(groups.members(1))]).toEqual([[0], [1]]);
    }
  });

  it("list rows in their new order for listeners once a sort field changed and rows came", () => {
    const t = table({ g: ["a", "a"], v: [1, 2], s: [1, 2] });
    const view = rowView(t, { sort: [{ field: "s" }] });
    const groups = groupRows(view, { by: ["g"], ops: { total: sum("v") } });
    groups.members(0);
    const read: number[][] = [];
    let phase = 0;
    groups.table.subscribe(() => {
      if (phase++ === 0) {
        t.set("s", 0, 10);
        t.append({ g: ["a"], v: [4], s: [4] });
      } else read.push(Array.from(groups.members(0)));
    });
    t.append({ g: ["a"], v: [3], s: [3] });
    expect(read).toEqual([[1, 2, 3, 0]]);
  });

  it("have no rows to list once disposed", () => {
    const t = table({ g: ["a", "a"], v: [1, 2] });
    const groups = groupRows(rowView(t), { by: ["g"] });
    groups.dispose();
    expect(Array.from(groups.members(0))).toEqual([]);
    expect(groups.memberIndex(0)).toBe(-1);
    expect(() => groups.memberAt(0, 0)).toThrow(/no row 0/);
  });

  it("start keeping values when a table without maxRows first drops rows", () => {
    const t = requests();
    const groups = groupRows(rowView(t), { by: ["host"], ops: OPS });
    // Groups keep the order they appeared in: compare them by key.
    const expected = () =>
      byHost(
        rounded(
          rows(
            derive(t)
              .aggregate({ by: ["host"], ops: OPS })
              .table(),
          ),
        ),
      );
    const byHost = (list: Record<string, unknown>[]) =>
      [...list].sort((a, b) => String(a.host).localeCompare(String(b.host)));
    const before = groups.byteLength;
    t.dropFirst(2);
    expect(byHost(rounded(rows(groups.table)))).toEqual(expected());
    // The values of "ms" are kept from now on, so later drops take rows away.
    expect(groups.byteLength).toBeGreaterThan(before);
    t.append({ host: ["web"], ms: [3], at: [0] });
    t.dropFirst(3);
    expect(byHost(rounded(rows(groups.table)))).toEqual(expected());
  });
});

/** A table's changes from now on. */
function changesOf(t: Table) {
  const changes: TableChange[] = [];
  t.subscribe((change) => changes.push(change));
  return changes;
}
