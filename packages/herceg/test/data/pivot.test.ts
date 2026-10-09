// Row pivots: crosstabs of a view's rows checked against a plain reference
// over random data (missing values, NaN, infinities, unused categories),
// absent combinations told from missing ones, dense and sparse indexes,
// limits refused before anything grows, and streaming.
import { describe, expect, it, vi } from "vitest";
import { category, encodedCategory, time } from "../../src/data/column.ts";
import { count, max, mean, min, sum } from "../../src/data/derive.ts";
import { col } from "../../src/data/expression.ts";
import { GroupLevel } from "../../src/data/group-levels.ts";
import { RowGroups } from "../../src/data/groups.ts";
import {
  PivotLimitError,
  type PivotSnapshot,
  type PivotValue,
  pivotColumnId,
  pivotRows,
  type RowPivot,
} from "../../src/data/pivot.ts";
import { buildIndex, DENSE_ENTRIES } from "../../src/data/pivot-index.ts";
import { rowView } from "../../src/data/row-view.ts";
import { type Schema, type Table, table } from "../../src/data/table.ts";

const OPS = {
  n: count(),
  finite: count("ms"),
  total: sum("ms"),
  avg: mean("ms"),
  low: min("ms"),
  high: max("ms"),
};

/** A seeded generator of numbers in [0, 1). */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Kind = "category" | "number" | "time";

/**
 * Requests: a region (some missing), a pivot field of the given kind (with
 * missing values, and for numbers -0 and infinities), and latencies that
 * are halves (so sums are exact), some NaN or infinite.
 */
function requests(rows: number, kind: Kind, seed: number, values = 6) {
  const next = random(seed);
  const pick = <T>(choices: readonly T[]) => choices[Math.floor(next() * choices.length)]!;
  const regions = ["eu", "us", "ap", "sa", null];
  const numbers = [
    3,
    -1,
    0,
    -0,
    2.5,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NaN,
  ];
  const pivot =
    kind === "category"
      ? // A dictionary with entries no row uses, in an order of its own.
        encodedCategory(
          Int32Array.from({ length: rows }, () =>
            next() < 0.1 ? -1 : Math.floor(next() * values),
          ),
          ["unused", ...Array.from({ length: values }, (_, k) => `s${values - k}`), "spare"].slice(
            1,
          ),
        )
      : kind === "number"
        ? Float64Array.from({ length: rows }, () => pick(numbers))
        : time(
            Float64Array.from({ length: rows }, () =>
              next() < 0.1 ? Number.NaN : Math.floor(next() * values) * 3_600_000,
            ),
          );
  return table({
    region: category(Array.from({ length: rows }, () => pick(regions))),
    key: pivot,
    ms: Float64Array.from({ length: rows }, () =>
      next() < 0.1
        ? Number.NaN
        : next() < 0.05
          ? Number.POSITIVE_INFINITY
          : Math.floor(next() * 40) / 2,
    ),
    at: time(Float64Array.from({ length: rows }, (_, i) => i * 1000)),
  });
}

interface Reference {
  rows: PivotValue[];
  values: PivotValue[];
  cells: Map<string, number[]>;
  totals: Map<PivotValue, number[]>;
}

/** A combination's key: numbers as text, so infinities and missing values keep apart. */
const pair = (row: PivotValue, value: PivotValue) =>
  JSON.stringify([row, typeof value === "number" ? String(value) : value]);

/** The crosstab computed plainly: rows and values as they first appear among the rows shown, in table order. */
function reference(t: Table, positions: readonly number[]): Reference {
  const rows: PivotValue[] = [];
  const values: PivotValue[] = [];
  const cells = new Map<string, number[]>();
  const totals = new Map<PivotValue, number[]>();
  for (const position of [...positions].sort((a, b) => a - b)) {
    const row = t.value("region", position) as PivotValue;
    const raw = t.value("key", position) as PivotValue;
    // -0 joins 0.
    const value = raw === 0 ? 0 : raw;
    if (!rows.includes(row)) rows.push(row);
    if (!values.includes(value)) values.push(value);
    const key = pair(row, value);
    cells.set(key, [...(cells.get(key) ?? []), position]);
    totals.set(row, [...(totals.get(row) ?? []), position]);
  }
  // Column order: categories as the dictionary has them, numbers ascending, missing last.
  const dictionary = t.kind("key") === "category" ? t.categories("key").dictionary : [];
  const place = (value: PivotValue) =>
    typeof value === "string" ? dictionary.indexOf(value) : (value as number);
  values.sort((a, b) =>
    a === null || b === null
      ? Number(a === null) - Number(b === null)
      : place(a) === place(b)
        ? 0
        : place(a) < place(b)
          ? -1
          : 1,
  );
  return { rows, values, cells, totals };
}

/** The aggregates of some rows' latencies, as derived tables compute them. */
function aggregates(t: Table, positions: readonly number[]) {
  const ms = t.numbers("ms");
  const finite = positions.map((p) => ms[p]!).filter(Number.isFinite);
  const total = finite.reduce((a, b) => a + b, 0);
  return {
    n: positions.length,
    finite: finite.length,
    total,
    avg: finite.length ? total / finite.length : Number.NaN,
    low: finite.length ? Math.min(...finite) : Number.NaN,
    high: finite.length ? Math.max(...finite) : Number.NaN,
  };
}

/**
 * Checks a pivot's crosstab and row totals against the reference over the
 * rows its view shows. Rows come in the order their groups first appeared,
 * which streaming can make other than the reference's (`ordered` false).
 */
function expectMatches(pivot: RowPivot, t: Table, ordered = true) {
  const snapshot = pivot.read();
  const { indices, length } = pivot.view.read();
  const positions = indices
    ? [...indices.subarray(0, length)]
    : Array.from({ length }, (_, i) => i);
  const expected = reference(t, positions);
  const rows = Array.from({ length: snapshot.rowCount }, (_, r) => snapshot.rowKey(r));
  if (ordered) expect(rows).toEqual(expected.rows);
  else expect(new Set(rows)).toEqual(new Set(expected.rows));
  expect(snapshot.values).toEqual(expected.values);
  rows.forEach((row, r) => {
    expected.values.forEach((value, index) => {
      const members = expected.cells.get(pair(row, value));
      const position = snapshot.cell(r, index);
      if (!members) {
        expect(position, `${row} × ${value} is absent`).toBe(-1);
        expect(snapshot.value(r, index, "avg")).toBeUndefined();
        return;
      }
      expect(position).toBeGreaterThanOrEqual(0);
      const want = aggregates(t, members);
      for (const [name, aggregate] of Object.entries(want))
        expect(snapshot.value(r, index, name), `${name} of ${row} × ${value}`).toBe(aggregate);
      expect([...pivot.cellMembers(r, value)].sort((a, b) => a - b)).toEqual(members);
    });
    const total = aggregates(t, expected.totals.get(row)!);
    for (const [name, value] of Object.entries(total))
      expect((pivot.rowTable as unknown as Table).numbers(name)[r]).toBe(value);
  });
}

/** A pivot made within the least byte budget it can be made in, and that budget. */
function tightest(make: (ownedBytes: number) => RowPivot) {
  let [lo, hi] = [1, 2 ** 30];
  while (hi - lo > hi / 1000) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      make(mid).dispose();
      hi = mid;
    } catch {
      lo = mid;
    }
  }
  return { pivot: make(hi), budget: hi };
}

/** Within its budget as it estimates, a pivot holds no more typed arrays than that. */
function expectWithin({ pivot, budget }: { pivot: RowPivot; budget: number }) {
  if (!pivot.failure) expect(pivot.byteLength).toBeLessThanOrEqual(budget);
}

/** Latencies whose sums cancel: they are summed again exactly, from their rows. */
const cancelling = (rows: number) => {
  const values = new Float64Array(rows);
  values.set([1e40, 1e16, 1, -1e40, -1e16]);
  return values;
};

describe("row pivots", () => {
  for (const kind of ["category", "number", "time"] as const) {
    it(`pivot by a ${kind} field as a plain crosstab does, with every aggregate and the totals`, () => {
      for (const seed of [1, 2, 3]) {
        const t = requests(400, kind, seed);
        const pivot = pivotRows(rowView(t), {
          rows: "region",
          pivot: "key",
          ops: OPS,
          totals: true,
        });
        expectMatches(pivot as unknown as RowPivot, t as unknown as Table);
        expect(pivot.read().dense).toBe(true);
      }
    });
  }

  it("read the rows a filtered and sorted view shows, and only the values they hold", () => {
    const t = requests(300, "category", 4);
    const view = rowView(t, {
      filter: col("ms").lt(10),
      sort: [{ field: "ms", order: "descending" }],
    });
    const pivot = pivotRows(view, { rows: "region", pivot: "key", ops: OPS });
    expectMatches(pivot as unknown as RowPivot, t as unknown as Table);
    view.setQuery({ filter: col("key").eq("s2") });
    expect(pivot.read().values).toEqual(["s2"]);
    expectMatches(pivot as unknown as RowPivot, t as unknown as Table);
  });

  it("tell absent combinations from those whose values are all missing, and fill counts only when asked", () => {
    const t = table({
      region: category(["eu", "eu", "us"]),
      key: category(["api", "web", "api"]),
      ms: [Number.NaN, 4, Number.NaN],
    });
    const plain = pivotRows(rowView(t), { rows: "region", pivot: "key", ops: OPS }).read();
    const filled = pivotRows(rowView(t), {
      rows: "region",
      pivot: "key",
      ops: OPS,
      zeroFill: "count",
    }).read();
    const web = plain.indexOf("web");
    // us has api, all of whose latencies are missing, and no web at all.
    const missing = Object.fromEntries(
      Object.keys(OPS).map((name) => [name, plain.value(1, plain.indexOf("api"), name)]),
    );
    expect(missing).toEqual({
      n: 1,
      finite: 0,
      total: 0,
      avg: Number.NaN,
      low: Number.NaN,
      high: Number.NaN,
    });
    expect(plain.cell(1, web)).toBe(-1);
    expect(Object.keys(OPS).map((name) => plain.value(1, web, name))).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(filled.cell(1, web)).toBe(-1);
    expect(Object.keys(OPS).map((name) => filled.value(1, web, name))).toEqual([
      0,
      0,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("keep a sparse index where rows × values are many, with the same crosstab", () => {
    const next = random(9);
    const rows = 3000;
    const t = table({
      region: Float64Array.from({ length: rows }, () => Math.floor(next() * 1400)),
      key: Float64Array.from({ length: rows }, () => Math.floor(next() * 1000)),
      ms: Float64Array.from({ length: rows }, () => Math.floor(next() * 40) / 2),
    });
    const pivot = pivotRows(rowView(t), {
      rows: "region",
      pivot: "key",
      ops: { n: count(), total: sum("ms") },
      limits: { generatedColumns: 2000 },
    });
    const snapshot = pivot.read();
    expect(snapshot.rowCount * snapshot.values.length).toBeGreaterThan(DENSE_ENTRIES);
    expect(snapshot.dense).toBe(false);
    const { indices, length } = pivot.view.read();
    const positions = indices
      ? [...indices.subarray(0, length)]
      : Array.from({ length }, (_, i) => i);
    const cells = new Map<string, number[]>();
    for (const position of positions) {
      const key = pair(t.value("region", position), t.value("key", position));
      cells.set(key, [...(cells.get(key) ?? []), position]);
    }
    let present = 0;
    for (let r = 0; r < snapshot.rowCount; r++)
      snapshot.values.forEach((value, index) => {
        const members = cells.get(pair(snapshot.rowKey(r), value));
        if (!members) {
          expect(snapshot.cell(r, index)).toBe(-1);
          return;
        }
        present++;
        expect(snapshot.value(r, index, "n")).toBe(members.length);
      });
    expect(present).toBe(cells.size);
  });

  it("build dense and sparse indexes that find the same combinations", () => {
    const next = random(5);
    const count = 2000;
    const rowsOf = Int32Array.from({ length: count }, () => Math.floor(next() * 50));
    const pairs = new Map<string, number>();
    const slots = new Int32Array(count);
    let kept = 0;
    const rows = new Int32Array(count);
    for (let c = 0; c < count; c++) {
      const slot = Math.floor(next() * 40);
      const key = `${rowsOf[c]} ${slot}`;
      if (pairs.has(key)) continue;
      pairs.set(key, kept);
      rows[kept] = rowsOf[c]!;
      slots[kept++] = slot;
    }
    const combinations = { count: kept, rows, slots };
    const dense = buildIndex(50, 40, combinations, null, 0);
    // Past the dense ceiling, and more entries than sparse would take.
    const sparse = buildIndex(50, DENSE_ENTRIES, combinations, null, 0);
    expect([dense.dense, sparse.dense]).toEqual([true, false]);
    for (let row = 0; row < 50; row++)
      for (let slot = 0; slot < 40; slot++) {
        const expected = pairs.get(`${row} ${slot}`) ?? -1;
        expect(dense.at(row, slot)).toBe(expected);
        expect(sparse.at(row, slot)).toBe(expected);
      }
  });

  it("name generated columns by the pivot field, the value and its kind, and the aggregate", () => {
    const t = table({
      region: category(["eu", "eu", "eu", "eu", "eu", "eu"]),
      key: category(["Total", "null", "Infinity", 'say "hi", then', "1", null]),
      ms: [1, 2, 3, 4, 5, 6],
    });
    const pivot = pivotRows(rowView(t), {
      rows: "region",
      pivot: "key",
      ops: { n: count(), total: sum("ms") },
      totals: true,
    });
    const ids = pivot.read().columns.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('["pivot","key","category","Total","n","count",null]');
    expect(ids).toContain('["pivot","key","total","n","count",null]');
    expect(ids).toContain('["pivot","key","missing","total","sum","ms"]');
    expect(ids).toContain('["pivot","key","category","say \\"hi\\", then","total","sum","ms"]');
    // A number and a category of the same text, an infinity and its text, are other columns.
    const n = { name: "n", op: "count", field: undefined } as const;
    expect(pivotColumnId("key", "number", 1, n)).not.toBe(pivotColumnId("key", "category", "1", n));
    expect(pivotColumnId("key", "number", Number.POSITIVE_INFINITY, n)).not.toBe(
      pivotColumnId("key", "category", "Infinity", n),
    );
    expect(pivotColumnId("key", "time", 0, n)).not.toBe(pivotColumnId("key", "number", 0, n));
  });

  it("keep columns' ids as values stream in, rows sort, and other aggregates change", () => {
    const t = table({
      region: category(["eu", "us"]),
      key: [10, 30],
      ms: [1, 2],
    });
    const view = rowView(t);
    const ops = { n: count(), total: sum("ms") };
    const pivot = pivotRows(view, { rows: "region", pivot: "key", ops });
    const before = pivot.read().columns.map(({ id }) => id);
    // A value between the others: columns move, ids stay.
    t.append({ region: ["eu"], key: [20], ms: [3] });
    view.setQuery({ sort: [{ field: "ms", order: "descending" }] });
    const after = pivot.read();
    expect(after.values).toEqual([10, 20, 30]);
    const ids = after.columns.map(({ id }) => id);
    expect(ids.filter((id) => before.includes(id))).toEqual(before);
    expect(ids).toHaveLength(6);
    // Another aggregate added: the columns of this one keep their ids.
    const more = pivotRows(view, {
      rows: "region",
      pivot: "key",
      ops: { ...ops, worst: max("ms") },
    });
    expect(
      more
        .read()
        .columns.map(({ id }) => id)
        .filter((id) => ids.includes(id)),
    ).toEqual(ids);
  });

  it("follow appends, a rolling window, and updates in place as the reference does", () => {
    for (const kind of ["category", "number"] as const) {
      const source = requests(1200, kind, 11, 9);
      const t = table(
        {
          region: category([] as string[]),
          key: kind === "category" ? category([] as string[]) : new Float64Array(0),
          ms: new Float64Array(0),
          at: time(new Float64Array(0)),
        },
        { maxRows: 500 },
      );
      const pivot = pivotRows(rowView(t), { rows: "region", pivot: "key", ops: OPS, totals: true });
      const seen: PivotSnapshot[] = [];
      for (let from = 0; from < source.length; from += 97) {
        const to = Math.min(source.length, from + 97);
        const values = (field: "region" | "key" | "ms" | "at") =>
          Array.from({ length: to - from }, (_, i) => source.value(field, from + i));
        t.append({
          region: values("region") as (string | null)[],
          key: values("key") as never,
          ms: values("ms").map((v) => v ?? Number.NaN) as number[],
          at: values("at") as number[],
        });
        if (from % 3 === 0 && t.length > 10) t.set("ms", 3, 7.5);
        expectMatches(pivot as unknown as RowPivot, t as unknown as Table, false);
        seen.push(pivot.read());
      }
      // Some batches only added to combinations there were: the crosstab stayed.
      expect(new Set(seen).size).toBeLessThanOrEqual(seen.length);
    }
  });

  it("add values streamed in as columns in their place", () => {
    const t = table({ region: category(["eu"]), key: category(["b"]), ms: [1] });
    const pivot = pivotRows(rowView(t), { rows: "region", pivot: "key", ops: { n: count() } });
    expect(pivot.read().values).toEqual(["b"]);
    t.append({ region: ["us", "eu"], key: ["a", null], ms: [2, 3] });
    // "a" came after "b" in the dictionary: it goes after it.
    expect(pivot.read().values).toEqual(["b", "a", null]);
    expect(pivot.read().value(1, 1, "n")).toBe(1);
    expect(pivot.read().value(0, 1, "n")).toBeUndefined();
  });

  it("refuse a pivot past its limits, saying which, what it reached, and the budget", () => {
    const t = table({
      region: category(["eu", "us", "eu"]),
      key: category(["api", "web", "db"]),
      ms: [1, 2, 3],
    });
    const make = (limits: object, totals = true) =>
      pivotRows(rowView(t), {
        rows: "region",
        pivot: "key",
        ops: { n: count(), avg: mean("ms") },
        totals,
        limits,
      });
    // Three values and the totals, of two aggregates each.
    expect(() => make({ generatedColumns: 8 })).not.toThrow();
    expect(() => make({ generatedColumns: 7 })).toThrow(PivotLimitError);
    expect(() => make({ generatedColumns: 6 }, false)).not.toThrow();
    try {
      make({ generatedColumns: 7 });
    } catch (error) {
      expect(error).toMatchObject({
        name: "PivotLimitError",
        limit: "generatedColumns",
        observed: 8,
        budget: 7,
      });
      expect((error as Error).message).toBe(
        "A pivot of 8 generated columns passes its limit of 7 (limits.generatedColumns)",
      );
    }
    expect(() => make({ observedCombinations: 3 })).not.toThrow();
    expect(() => make({ observedCombinations: 2 })).toThrow(
      expect.objectContaining({ limit: "observedCombinations", observed: 3, budget: 2 }),
    );
    expect(() => make({ ownedBytes: 1000 })).toThrow(
      expect.objectContaining({ limit: "ownedBytes", budget: 1000 }),
    );
    expect(() => make({ generatedColumns: 0 })).toThrow(RangeError);
  });

  it("refuse as they are made the moment a limit is passed, adding no group past it", () => {
    const rows = 200_000;
    const t = table({
      region: Float64Array.from({ length: rows }, (_, i) => i),
      key: Float64Array.from({ length: rows }, (_, i) => i % 3),
      ms: new Float64Array(rows),
    });
    const add = vi.spyOn(GroupLevel.prototype, "add");
    try {
      expect(() =>
        pivotRows(rowView(t), {
          rows: "region",
          pivot: "key",
          ops: { n: count() },
          limits: { observedCombinations: 10 },
        }),
      ).toThrow(expect.objectContaining({ observed: 11 }));
      // Eleven rows' groups and the ten combinations within the limit, of 200,000.
      expect(add).toHaveBeenCalledTimes(21);
    } finally {
      add.mockRestore();
    }
  });

  it("stop at a limit while following, keeping what they held and telling listeners, without throwing", () => {
    const t = table({ region: category(["eu", "us"]), key: category(["api", "web"]), ms: [1, 2] });
    const pivot = pivotRows(rowView(t), {
      rows: "region",
      pivot: "key",
      ops: { n: count(), avg: mean("ms") },
      limits: { generatedColumns: 4 },
    });
    const before = pivot.read();
    const later = vi.fn();
    const told = vi.fn();
    pivot.subscribe(told);
    const add = vi.spyOn(GroupLevel.prototype, "add");
    t.subscribe(later);
    expect(() => t.append({ region: ["eu"], key: ["db"], ms: [3] })).not.toThrow();
    expect(add).not.toHaveBeenCalled();
    add.mockRestore();
    expect(later).toHaveBeenCalledTimes(1);
    expect(told).toHaveBeenCalled();
    expect(pivot.failure).toMatchObject({ limit: "generatedColumns", observed: 6, budget: 4 });
    const after = pivot.read();
    expect(after.failure).toBe(pivot.failure);
    expect(after.values).toEqual(before.values);
    expect([...(pivot.table as unknown as Table).numbers("n")]).toEqual([1, 1]);
    t.append({ region: ["eu"], key: ["api"], ms: [4] });
    expect([...(pivot.table as unknown as Table).numbers("n")]).toEqual([1, 1]);
    // Rows as they were: eu's first row, not those appended since, whatever the view shows now.
    expect([...pivot.members(0)]).toEqual([0]);
    pivot.view.setQuery({ filter: col("ms").gt(10) });
    expect([...pivot.members(0)]).toEqual([0]);
    expect([...pivot.cellMembers(1, "web")]).toEqual([1]);
  });

  it("tell listeners once the pivot followed a change, or stopped at a limit", () => {
    const t = table({ region: category(["eu"]), key: category(["api"]), ms: [1] });
    const view = rowView(t);
    const pivot = pivotRows(view, {
      rows: "region",
      pivot: "key",
      ops: { n: count() },
      limits: { generatedColumns: 2 },
    });
    const seen: unknown[] = [];
    pivot.subscribe(() =>
      seen.push([...(pivot.table as unknown as Table).numbers("n")], pivot.failure?.limit),
    );
    t.append({ region: ["eu"], key: ["api"], ms: [2] });
    view.setQuery({ filter: col("ms").gt(1) });
    t.append({ region: ["eu", "us"], key: ["web", "db"], ms: [3, 4] });
    expect(seen).toEqual([[2], undefined, [1], undefined, [1], "generatedColumns"]);
  });

  it("tell listeners once the groups caught up with changes their tables' listeners made", () => {
    const t = table({ region: category(["eu"]), key: category(["api"]), ms: [1] });
    const pivot = pivotRows(rowView(t), { rows: "region", pivot: "key", ops: { n: count() } });
    let appended = false;
    (pivot.table as unknown as Table).subscribe(() => {
      if (appended) return;
      appended = true;
      t.append({ region: ["eu"], key: ["api"], ms: [3] });
    });
    const seen: number[][] = [];
    pivot.subscribe(() => {
      seen.push([...(pivot.table as unknown as Table).numbers("n")]);
      expect(pivot.read().value(0, 0, "n")).toBe(t.length);
    });
    t.append({ region: ["eu"], key: ["api"], ms: [2] });
    expect(seen).toEqual([[3]]);
  });

  it("give back dictionaries' lookups a reset leaves far too large, so the estimate holds", () => {
    const dictionary = Array.from({ length: 100_000 }, (_, i) => `k${i}`);
    const t = table({
      region: encodedCategory(new Int32Array([0]), dictionary),
      key: category(["api"]),
      ms: [1],
    });
    const pivot = pivotRows(rowView(t), {
      rows: "region",
      pivot: "key",
      ops: { n: count() },
      limits: { ownedBytes: 2_000_000 },
    });
    expect(pivot.byteLength).toBeGreaterThan(600_000);
    t.reset({
      region: category(Array.from({ length: 30_000 }, () => "k0")),
      key: category(Array.from({ length: 30_000 }, () => "api")),
      ms: new Float64Array(30_000),
    });
    pivot.read();
    expect(pivot.failure).toBeNull();
    expect(pivot.byteLength).toBeLessThan(400_000);
  });

  it("keep dictionaries' lookups within what the estimate counts as dictionaries shrink a little", () => {
    const dictionary = Array.from({ length: 100_000 }, (_, i) => `k${i}`);
    const t = table({
      region: encodedCategory(new Int32Array([0]), dictionary),
      key: category(["api"]),
      ms: [1],
    });
    const budget = 1_000_000;
    const pivot = pivotRows(rowView(t), {
      rows: "region",
      pivot: "key",
      ops: { n: count() },
      limits: { ownedBytes: budget },
    });
    t.reset({
      region: encodedCategory(new Int32Array(10_000), dictionary.slice(0, 50_001)),
      key: category(Array.from({ length: 10_000 }, () => "api")),
      ms: new Float64Array(10_000),
    });
    pivot.read();
    // Within budget as estimated, the typed arrays it holds are too.
    expect(pivot.failure === null ? pivot.byteLength <= budget : true).toBe(true);
    expect(pivot.byteLength).toBeLessThan(500_000);
  });

  it("hold no more typed arrays than their byte limit allows, whatever comes and goes", () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const next = random(seed);
      const pick = (n: number) => Math.floor(next() * n);
      const batch = (rows: number, keys: number, values: number) => ({
        region: Array.from({ length: rows }, () => `r${pick(keys)}`),
        key: Array.from({ length: rows }, () => `k${pick(values)}`),
        ms: Array.from({ length: rows }, (_, i) => (next() < 0.1 ? Number.NaN : i + pick(50))),
      });
      const t = table(
        {
          region: category([] as string[]),
          key: category([] as string[]),
          ms: new Float64Array(0),
        },
        seed % 2 ? { maxRows: 3000 } : {},
      );
      const view = rowView(t);
      const budget = 300_000 + seed * 250_000;
      const pivot = pivotRows(view, {
        rows: "region",
        pivot: "key",
        ops: { n: count(), low: min("ms"), high: max("ms"), total: sum("ms") },
        totals: seed % 3 === 0,
        limits: { ownedBytes: budget, generatedColumns: 10_000 },
      });
      for (let step = 0; step < 120 && !pivot.failure; step++) {
        const what = next();
        if (what < 0.55) t.append(batch(1 + pick(400), 1 + pick(seed * 60), 1 + pick(40)));
        else if (what < 0.7 && t.length > 0) t.dropFirst(1 + pick(t.length));
        else if (what < 0.78) t.reset(batch(pick(2000), 1 + pick(200), 1 + pick(30)));
        else if (what < 0.88) view.setQuery({ filter: col("ms").lt(pick(400)) });
        else if (t.length > 0) t.set("ms", pick(t.length), pick(100));
        // Before a read as after: the groups have followed, and what they hold counts.
        if (!pivot.failure)
          expect(pivot.byteLength, `seed ${seed}, step ${step}`).toBeLessThanOrEqual(budget);
        if (next() < 0.7) {
          const crosstab = pivot.read();
          if (crosstab.rowCount > 0) pivot.members(pick(crosstab.rowCount));
        }
        if (!pivot.failure)
          expect(pivot.byteLength, `seed ${seed}, step ${step}`).toBeLessThanOrEqual(budget);
      }
    }
  });

  it("budget rows read again when a group's minimum leaves, and room left after groups go", () => {
    const rows = 100_000;
    const t = table(
      {
        region: category(Array.from({ length: rows }, () => "eu")),
        key: category(Array.from({ length: rows }, () => "api")),
        v: Float64Array.from({ length: rows }, (_, i) => i),
      },
      { maxRows: rows },
    );
    const lowest = tightest(
      (ownedBytes) =>
        pivotRows(rowView(t), {
          rows: "region",
          pivot: "key",
          ops: { low: min("v") },
          limits: { ownedBytes },
        }) as unknown as RowPivot,
    );
    // The minimum leaves: its group's rows are listed and read again.
    t.dropFirst(1);
    lowest.pivot.read();
    expectWithin(lowest);

    const fields = Object.fromEntries(
      Array.from({ length: 10 }, (_, k) => [
        `f${k}`,
        Float64Array.from({ length: 1000 }, (_, i) => i + k),
      ]),
    );
    const wide = table(
      {
        region: Float64Array.from({ length: 1000 }, (_, i) => i),
        key: category(Array.from({ length: 1000 }, () => "api")),
        ...fields,
      },
      { maxRows: 1_000_000 },
    );
    const ops = Object.fromEntries(Array.from({ length: 10 }, (_, k) => [`m${k}`, mean(`f${k}`)]));
    const means = tightest(
      (ownedBytes) =>
        pivotRows(
          rowView(wide) as never,
          {
            rows: "region",
            pivot: "key",
            ops,
            limits: { ownedBytes },
          } as never,
        ) as RowPivot,
    );
    // Most groups go, then one that stays grows.
    wide.dropFirst(615);
    const more = Object.fromEntries(
      Array.from({ length: 10 }, (_, k) => [`f${k}`, new Float64Array(7700)]),
    );
    wide.append({
      region: new Float64Array(7700).fill(999),
      key: Array(7700).fill("api"),
      ...more,
    } as never);
    means.pivot.read();
    expectWithin(means);
  });

  it("budget the places of listed groups that went, and levels emptied before a reset", () => {
    const keys = table(
      {
        region: Float64Array.from({ length: 1000 }, (_, i) => i),
        key: category(Array(1000).fill("api")),
        ms: new Float64Array(1000),
      },
      { maxRows: 1_000_000 },
    );
    const listed = tightest(
      (ownedBytes) =>
        pivotRows(rowView(keys), {
          rows: "region",
          pivot: "key",
          ops: { n: count() },
          limits: { ownedBytes },
        }) as unknown as RowPivot,
    );
    listed.pivot.read();
    listed.pivot.members(0);
    keys.dropFirst(999);
    for (const rows of [41_000, 20_501]) {
      keys.append({
        region: new Float64Array(rows).fill(999),
        key: Array(rows).fill("api"),
        ms: new Float64Array(rows),
      });
      listed.pivot.read();
      expectWithin(listed);
    }

    const emptied = table(
      {
        region: Float64Array.from({ length: 65 }, (_, i) => i),
        key: category(Array(65).fill("api")),
        ms: new Float64Array(65),
      },
      { maxRows: 1_000_000 },
    );
    const ops = Object.fromEntries(Array.from({ length: 100 }, (_, k) => [`m${k}`, mean("ms")]));
    const many = tightest(
      (ownedBytes) =>
        pivotRows(rowView(emptied), {
          rows: "region",
          pivot: "key",
          ops,
          limits: { ownedBytes },
        }) as unknown as RowPivot,
    );
    emptied.dropFirst(65);
    emptied.reset({
      region: new Float64Array(8000),
      key: category(Array(8000).fill("api")),
      ms: cancelling(8000),
    });
    many.pivot.read();
    expectWithin(many);
  });

  it("budget a sorted view's ranks of labels, and an index that streaming made sparse", () => {
    const labels = Array.from({ length: 100_000 }, (_, i) => `l${i}`);
    const sorted = table({
      region: [1],
      key: [1],
      label: encodedCategory(new Int32Array([0]), labels),
    });
    const ranked = {
      pivot: pivotRows(rowView(sorted, { sort: [{ field: "label" }] }), {
        rows: "region",
        pivot: "key",
        ops: { n: count() },
        limits: { ownedBytes: 2_000_000 },
      }) as unknown as RowPivot,
      budget: 2_000_000,
    };
    ranked.pivot.members(0);
    sorted.append({ region: [1], key: [1], label: ["l1"] });
    ranked.pivot.members(0);
    expectWithin(ranked);
    expect(ranked.pivot.byteLength).toBeGreaterThan(400_000);

    const t = table(
      {
        region: Float64Array.from({ length: 1000 }, (_, i) => i),
        key: Float64Array.from({ length: 1000 }, (_, i) => i),
        ms: new Float64Array(1000),
      },
      { maxRows: 1_000_000 },
    );
    const streamed = {
      pivot: pivotRows(rowView(t), {
        rows: "region",
        pivot: "key",
        ops: { avg: mean("ms") },
        limits: { ownedBytes: 18_500_000, generatedColumns: 2000 },
      }) as unknown as RowPivot,
      budget: 18_500_000,
    };
    streamed.pivot.read();
    t.append({
      region: Float64Array.from({ length: 500 }, (_, i) => 1000 + i),
      key: Float64Array.from({ length: 500 }, (_, i) => 1000 + i),
      ms: new Float64Array(500),
    });
    for (const rows of [450_000, 225_000]) {
      t.append({
        region: new Float64Array(rows),
        key: new Float64Array(rows),
        ms: cancelling(rows),
      });
      expectWithin(streamed);
    }
    streamed.pivot.read();
    expectWithin(streamed);
  });

  it("ask their bounds before a new order of a sorted view, whose ranks they would make", () => {
    const t = table({ a: [1], b: [1], label: category(["l0"]) });
    let refused = false;
    const groups = new RowGroups(
      rowView(t, { sort: [{ field: "label" }] }),
      { by: ["a", "b"], ops: { n: count() } },
      {
        check: (_, __, bytes) => {
          refused ||= bytes > 10_000;
          return bytes > 10_000 ? new Error("over") : null;
        },
      },
    );
    for (let i = 1; i <= 3000; i++) t.set("label", 0, `l${i}`);
    groups.memberIndex(0);
    expect(refused).toBe(true);
    expect(groups.byteLength).toBeLessThanOrEqual(10_000);
  });

  it("let go of a crosstab its groups renumbered at once, before it is read again", () => {
    const rows = 600;
    const t = table(
      {
        region: Float64Array.from({ length: rows }, (_, i) => i),
        key: Float64Array.from({ length: rows }, (_, i) => i),
        ms: new Float64Array(rows),
      },
      { maxRows: 1_000_000 },
    );
    // Room for the reset's rows, and less than they and the old crosstab together hold.
    const budget = 7_800_000;
    const diagonal = {
      pivot: pivotRows(rowView(t), {
        rows: "region",
        pivot: "key",
        ops: { avg: mean("ms") },
        limits: { ownedBytes: budget, generatedColumns: 1000 },
      }) as unknown as RowPivot,
      budget,
    };
    diagonal.pivot.read();
    t.reset({
      region: new Float64Array(200_000),
      key: new Float64Array(200_000),
      ms: cancelling(200_000),
    });
    expect(diagonal.pivot.failure).toBeNull();
    expectWithin(diagonal);
    diagonal.pivot.read();
    expectWithin(diagonal);
  });

  it("weigh what a pivot of no rows takes: its totals' columns and its fields' dictionaries", () => {
    const empty = table({
      region: category([] as string[]),
      key: category([] as string[]),
      ms: new Float64Array(0),
    });
    expect(() =>
      pivotRows(rowView(empty), {
        rows: "region",
        pivot: "key",
        ops: { n: count(), avg: mean("ms") },
        totals: true,
        limits: { generatedColumns: 1 },
      }),
    ).toThrow(expect.objectContaining({ limit: "generatedColumns", observed: 2 }));
    const dictionary = Array.from({ length: 100_000 }, (_, i) => `k${i}`);
    const unused = table({
      region: encodedCategory(new Int32Array(0), dictionary),
      key: category([] as string[]),
      ms: new Float64Array(0),
    });
    expect(() =>
      pivotRows(rowView(unused), {
        rows: "region",
        pivot: "key",
        ops: { n: count() },
        limits: { ownedBytes: 100_000 },
      }),
    ).toThrow(expect.objectContaining({ limit: "ownedBytes" }));
  });

  it("estimate no less than the typed arrays they hold, small pivots too", () => {
    for (const rows of [1, 50, 5000]) {
      const t = requests(rows, "number", rows);
      const make = (ownedBytes: number) =>
        pivotRows(rowView(t), { rows: "region", pivot: "key", ops: OPS, limits: { ownedBytes } });
      const pivot = make(2 ** 31);
      pivot.read();
      pivot.members(0);
      // Within the least budget it is made in, it holds no more typed arrays than that.
      let [lo, hi] = [1, 2 ** 31];
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        try {
          make(mid);
          hi = mid;
        } catch {
          lo = mid;
        }
      }
      expect(pivot.byteLength, `${rows} rows`).toBeLessThanOrEqual(hi);
    }
  });

  it("count only the combinations a new filter shows, so a filter that swaps them stays within the limit", () => {
    const t = table({
      region: category(["eu", "eu", "us", "us"]),
      key: category(["a", "b", "c", "d"]),
      ms: [1, 2, 3, 4],
    });
    const view = rowView(t, { filter: col("region").eq("eu") });
    const pivot = pivotRows(view, {
      rows: "region",
      pivot: "key",
      ops: { n: count() },
      limits: { generatedColumns: 2, observedCombinations: 2 },
    });
    view.setQuery({ filter: col("region").eq("us") });
    expect(pivot.read().values).toEqual(["c", "d"]);
    expect(pivot.failure).toBeNull();
  });

  it("list a row's rows and a combination's rows, and none for an absent one", () => {
    const t = table({
      region: category(["eu", "us", "eu", "eu"]),
      key: category(["api", "api", "web", "api"]),
      ms: [1, 2, 3, 4],
    });
    const pivot = pivotRows(rowView(t), { rows: "region", pivot: "key", ops: { n: count() } });
    expect([...pivot.members(0)].sort()).toEqual([0, 2, 3]);
    expect([...pivot.cellMembers(0, "api")]).toEqual([0, 3]);
    expect([...pivot.cellMembers(1, "web")]).toEqual([]);
    expect([...pivot.cellMembers(1, "nothing")]).toEqual([]);
    expect(() => pivot.members(2)).toThrow(RangeError);
  });

  it("stop on dispose, leaving the view and the tables as they were", () => {
    const t = table({ region: category(["eu"]), key: category(["api"]), ms: [1] });
    const view = rowView(t);
    const pivot = pivotRows(view, { rows: "region", pivot: "key", ops: { n: count() } });
    pivot.dispose();
    t.append({ region: ["eu"], key: ["api"], ms: [2] });
    expect([...(pivot.table as unknown as Table).numbers("n")]).toEqual([1]);
    expect(view.length).toBe(2);
    expect(pivot.read().rowCount).toBe(1);
  });

  it("check their fields and aggregates", () => {
    const t = table({ region: category(["eu"]), key: category(["api"]), ms: [1] });
    const view = rowView(t) as unknown as ReturnType<typeof rowView<Schema>>;
    const make = (options: object) =>
      pivotRows(view, { rows: "region", pivot: "key", ops: { n: count() }, ...options } as never);
    expect(() => make({ rows: "nope" })).toThrow('Unknown pivot field "nope"');
    expect(() => make({ pivot: "region" })).toThrow("two fields");
    expect(() => make({ ops: {} })).toThrow("at least one aggregate");
    expect(() => make({ zeroFill: "sum" })).toThrow(TypeError);
    expect(() => make({ ops: { region: count() } })).toThrow("grouping field");
  });
});
