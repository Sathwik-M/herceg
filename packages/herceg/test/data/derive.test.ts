// Portable expressions and derived tables: each transform, incremental
// following of the source, and derived tables in specs.
import { describe, expect, it } from "vitest";
import { category, time } from "../../src/data/column.ts";
import {
  count,
  derive,
  deriveTable,
  distinct,
  first,
  last,
  max,
  mean,
  median,
  min,
  q1,
  q3,
  stdev,
  sum,
  variance,
} from "../../src/data/derive.ts";
import { col, compileExpression, type Expression, when } from "../../src/data/expression.ts";
import { quantile } from "../../src/data/quantile.ts";
import { type Schema, type Table, table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { ChartModel } from "../../src/model/model.ts";
import type { RectGeometry } from "../../src/scene/scene.ts";
import { loadSpec } from "../../src/spec/load.ts";
import type { ChartSpec } from "../../src/spec/spec.ts";

/** A field's values, missing ones as null. */
const values = <S extends Schema>(t: Table<S>, field: string) =>
  Array.from({ length: t.length }, (_, i) => t.value(field as never, i));

const readings = table({
  site: ["n", "s", "n", "s", "n", "e"],
  temp: [10, 20, Number.NaN, 30, 14, -5],
  hour: [0, 0, 1, 1, 2, 2],
});

describe("expressions", () => {
  const evaluate = (e: Expression, t: Table = readings as unknown as Table) => {
    const compiled = compileExpression(e, t);
    return Array.from({ length: t.length }, (_, i) => compiled.at(i));
  };

  it("compares, combines, and computes", () => {
    expect(evaluate(col("temp").gt(12).toJSON())).toEqual([false, true, false, true, true, false]);
    expect(evaluate(col("site").eq("n").and(col("temp").lt(12)).toJSON())).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(evaluate(col("temp").mul(1.8).add(32).toJSON())[0]).toBeCloseTo(50);
    expect(evaluate(["abs", ["field", "temp"]])[5]).toBe(5);
    expect(evaluate(["max", ["field", "temp"], 12])[0]).toBe(12);
    expect(evaluate(col("site").isIn("e", "s").toJSON())).toEqual([
      false,
      true,
      false,
      true,
      false,
      true,
    ]);
    expect(evaluate(when(col("temp").ge(15), "warm", "cool").toJSON())).toEqual([
      "cool",
      "warm",
      "cool",
      "warm",
      "cool",
      "cool",
    ]);
  });

  it("treats missing values as missing", () => {
    // NaN compares false, except as unequal, and is found by isMissing.
    expect(evaluate(col("temp").gt(0).toJSON())[2]).toBe(false);
    expect(evaluate(col("temp").ne(1).toJSON())[2]).toBe(true);
    expect(evaluate(col("temp").isMissing().toJSON())).toEqual([
      false,
      false,
      true,
      false,
      false,
      false,
    ]);
    expect(evaluate(["==", ["field", "temp"], null])[2]).toBe(true);
    const sparse = table({ k: category(["a", null]) }) as unknown as Table;
    expect(evaluate(col("k").isMissing().toJSON(), sparse)).toEqual([false, true]);
    // A category value no row holds matches nothing.
    expect(evaluate(col("site").eq("west").toJSON())).toEqual(Array(6).fill(false));
  });

  it("compare numbers either way round, missing ones false except as unequal", () => {
    const t = table({ a: [1, 2, Number.NaN, 3, Number.NaN], b: [2, 2, 1, Number.NaN, Number.NaN] });
    const at = (row: number, field: "a" | "b") => t.value(field, row) as number | null;
    const operators = {
      "==": (x: number, y: number) => x === y,
      "!=": (x: number, y: number) => x !== y,
      "<": (x: number, y: number) => x < y,
      "<=": (x: number, y: number) => x <= y,
      ">": (x: number, y: number) => x > y,
      ">=": (x: number, y: number) => x >= y,
    };
    const expected = (op: keyof typeof operators, x: number | null, y: number | null) =>
      x === null || y === null ? op === "!=" : operators[op](x, y);
    for (const op of Object.keys(operators) as (keyof typeof operators)[]) {
      const rows = [0, 1, 2, 3, 4];
      const field = (name: string): Expression => ["field", name];
      expect(evaluate([op, field("a"), 2], t as never)).toEqual(
        rows.map((row) => expected(op, at(row, "a"), 2)),
      );
      expect(evaluate([op, 2, field("a")], t as never)).toEqual(
        rows.map((row) => expected(op, 2, at(row, "a"))),
      );
      expect(evaluate([op, field("a"), field("b")], t as never)).toEqual(
        rows.map((row) => expected(op, at(row, "a"), at(row, "b"))),
      );
      expect(evaluate([op, ["+", field("a"), 1], ["*", field("b"), 1]], t as never)).toEqual(
        rows.map((row) => {
          const [x, y] = [at(row, "a"), at(row, "b")];
          return expected(op, x === null ? null : x + 1, y);
        }),
      );
    }
  });

  it("match categories by code, and combine any number of tests", () => {
    const t = table({ k: category(["a", null, "b", "c", "a"]), v: [1, 2, 3, 4, 5] });
    const tested = (e: Expression) => evaluate(e, t as never);
    expect(tested(col("k").isIn("a", "zzz").toJSON())).toEqual([true, false, false, false, true]);
    expect(tested(col("k").isIn("c", null).toJSON())).toEqual([false, true, false, true, false]);
    const [low, odd, notB] = [col("v").lt(5), col("v").ne(2).and(col("v").ne(4)), col("k").ne("b")];
    expect(tested(low.and(odd).toJSON())).toEqual([true, false, true, false, false]);
    expect(tested(low.and(odd).and(notB).toJSON())).toEqual([true, false, false, false, false]);
    expect(tested(["or", low.toJSON(), odd.toJSON(), notB.toJSON()])).toEqual(Array(5).fill(true));
    expect(tested(["or", col("v").gt(4).toJSON(), col("k").eq("b").toJSON()])).toEqual([
      false,
      false,
      true,
      false,
      true,
    ]);
    expect(tested(["-", ["field", "v"], 1])).toEqual([0, 1, 2, 3, 4]);
    expect(tested(["/", ["field", "v"], 2])).toEqual([0.5, 1, 1.5, 2, 2.5]);
    expect(tested(["%", ["field", "v"], 2])).toEqual([1, 0, 1, 0, 1]);
  });

  it("give booleans from and and or, false where an operand is missing", () => {
    const missing: Expression = ["if", false, true, null];
    const t = table({ v: [1] }) as unknown as Table;
    for (const e of [
      ["and", missing, true],
      ["and", true, missing],
      ["or", false, missing],
      ["or", missing, false],
    ] as Expression[]) {
      expect(evaluate(e, t)).toEqual([false]);
      expect(evaluate(["missing", e], t)).toEqual([false]);
    }
    expect(evaluate(["or", missing, true], t)).toEqual([true]);
  });

  it("compare times, signed zeros, and infinities as numbers", () => {
    const start = Date.UTC(2026, 0, 1);
    const t = table({
      at: time([start, start + 1000, Number.NaN]),
      v: [-0, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
    }) as unknown as Table;
    expect(evaluate([">=", ["field", "at"], start + 1], t)).toEqual([false, true, false]);
    expect(evaluate(["<", start + 1, ["field", "at"]], t)).toEqual([false, true, false]);
    expect(evaluate(["==", ["field", "v"], 0], t)).toEqual([true, false, false]);
    expect(evaluate([">", ["field", "v"], 1e308], t)).toEqual([false, true, false]);
    expect(evaluate(["<", ["field", "v"], -1e308], t)).toEqual([false, false, true]);
  });

  it("names what is wrong", () => {
    const t = readings as unknown as Table;
    expect(() => compileExpression(["field", "wind"], t)).toThrow(
      /expression: no field "wind".*"site"/,
    );
    expect(() => compileExpression([">", ["field", "site"], 3], t)).toThrow(
      /">": compares string with number; give both sides one type/,
    );
    expect(() => compileExpression(["and", ["field", "temp"]], t)).toThrow(
      /"and": expected boolean operands; received number/,
    );
    expect(() => compileExpression(["sqrt"], t)).toThrow(/"sqrt": expected 1 operand; received 0/);
    expect(() => compileExpression(when(true, "a", 1).toJSON(), t)).toThrow(
      /"if": branches give string and number/,
    );
    expect(() => compileExpression(["frobnicate", 1] as never, t)).toThrow(
      /expression: no operator "frobnicate"/,
    );
  });
});

describe("transforms", () => {
  it("calculates numbers, not times, from time fields", () => {
    const t = table({ at: time([0, 60_000]) });
    const copied = derive(t)
      .calculate("copy", col("at"))
      .calculate("later", col("at").add(1))
      .table();
    expect([copied.kind("copy"), copied.kind("later")]).toEqual(["number", "number"]);
  });

  it("filters and calculates", () => {
    const warm = derive(readings)
      .filter(col("temp").gt(12))
      .calculate("f", col("temp").mul(1.8).add(32))
      .calculate("label", when(col("temp").ge(25), "hot", "warm"))
      .table();
    expect(values(warm, "temp")).toEqual([20, 30, 14]);
    expect(values(warm, "f")).toEqual([68, 86, 57.2].map((v) => expect.closeTo(v, 9)));
    expect(warm.kind("label")).toBe("category");
    expect(values(warm, "label")).toEqual(["warm", "hot", "warm"]);
  });

  it("bins numbers and times by step, count, and start", () => {
    const t = table({
      v: [0.1, 0.25, 0.3, 0.95, Number.NaN],
      at: time([0, 59_999, 60_000, 125_000, 180_000]),
    });
    expect(values(derive(t).bin("v", { step: 0.1 }).table(), "v")).toEqual([
      0.1,
      0.2,
      0.3,
      0.9,
      null,
    ]);
    expect(values(derive(t).bin("v", { step: 0.5, start: -0.25, as: "b" }).table(), "b")).toEqual([
      -0.25,
      0.25,
      0.25,
      0.75,
      null,
    ]);
    // About 10 round bins over the extent by default.
    expect(values(derive(t).bin("v").table(), "v")).toEqual([0.1, 0.2, 0.3, 0.9, null]);
    const minutes = derive(t).bin("at", { step: 60_000 }).table();
    expect(minutes.kind("at")).toBe("time");
    expect(values(minutes, "at")).toEqual([0, 0, 60_000, 120_000, 180_000]);
  });

  it("aggregates groups with every operation", () => {
    const t = table({
      g: ["a", "a", "b", "a", "b", "b"],
      v: [1, 2, 10, 4, 20, Number.NaN],
    });
    const result = derive(t)
      .aggregate({
        by: ["g"],
        ops: {
          n: count(),
          values: count("v"),
          sum: sum("v"),
          mean: mean("v"),
          median: median("v"),
          min: min("v"),
          max: max("v"),
          q1: q1("v"),
          q3: q3("v"),
          sd: stdev("v"),
          var: variance("v"),
          distinct: distinct("v"),
          first: first("v"),
          last: last("v"),
        },
      })
      .table();
    expect(values(result, "g")).toEqual(["a", "b"]);
    const row = (i: number) =>
      Object.fromEntries(result.fields().map((f) => [f, result.value(f, i)]));
    expect(row(0)).toMatchObject({
      n: 3,
      sum: 7,
      median: 2,
      min: 1,
      max: 4,
      distinct: 3,
      first: 1,
      last: 4,
    });
    expect(row(0).mean).toBeCloseTo(7 / 3);
    expect(row(0).q1).toBeCloseTo(1.5);
    expect(row(0).q3).toBeCloseTo(3);
    expect(row(0).var).toBeCloseTo(7 / 3);
    expect(row(0).sd).toBeCloseTo(Math.sqrt(7 / 3));
    // Missing values are left out of every operation but count without a field.
    expect(row(1)).toMatchObject({
      n: 3,
      values: 2,
      sum: 30,
      mean: 15,
      min: 10,
      max: 20,
      last: null,
    });
    // Without groups, one row; with several fields, one per combination.
    expect(
      values(
        derive(t)
          .aggregate({ ops: { n: count() } })
          .table(),
        "n",
      ),
    ).toEqual([6]);
    const pairs = table({ a: ["x", "x", "y"], b: [1, 2, 1], v: [1, 1, 1] });
    expect(
      derive(pairs)
        .aggregate({ by: ["a", "b"], ops: { n: count() } })
        .table().length,
    ).toBe(3);
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    // An operation named as a grouping field replaces it.
    const counted = derive(t)
      .aggregate({ by: ["g"], ops: { g: count() } })
      .table();
    expect(values(counted, "g")).toEqual([3, 3]);
  });

  it("rolls trailing windows within groups", () => {
    const t = table({
      g: ["a", "b", "a", "a", "b", "a"],
      v: [1, 10, 3, Number.NaN, 20, 8],
    });
    const rolled = derive(t)
      .rolling({
        size: 2,
        by: ["g"],
        ops: {
          avg: { op: "mean", field: "v" },
          lo: { op: "min", field: "v" },
          hi: { op: "max", field: "v" },
          n: { op: "count", field: "v" },
        },
      })
      .table();
    // Group a: 1, 3, NaN, 8 → windows {1}, {1,3}, {3,NaN}, {NaN,8}.
    expect(values(rolled, "avg")).toEqual([1, 10, 2, 3, 15, 8]);
    expect(values(rolled, "lo")).toEqual([1, 10, 1, 3, 10, 8]);
    expect(values(rolled, "hi")).toEqual([1, 10, 3, 3, 20, 8]);
    expect(values(rolled, "n")).toEqual([1, 1, 2, 1, 2, 1]);
    // Long windows keep minimum and maximum exact.
    const walk = table({ v: [5, 1, 4, 2, 8, 0, 7] });
    const lows = derive(walk)
      .rolling({ size: 3, ops: { lo: { op: "min", field: "v" } } })
      .table();
    expect(values(lows, "lo")).toEqual([5, 1, 1, 1, 2, 0, 0]);
  });

  it("sorts stably, missing values last", () => {
    const t = table({ k: category(["b", null, "a", "b"]), v: [2, 1, Number.NaN, 0] });
    expect(values(derive(t).sort("v").table(), "v")).toEqual([0, 1, 2, null]);
    expect(values(derive(t).sort("v", "descending").table(), "v")).toEqual([2, 1, 0, null]);
    expect(values(derive(t).sort("k").table(), "v")).toEqual([null, 2, 0, 1]);
  });

  it("names the step that fails", () => {
    expect(() =>
      derive(readings).filter(col("temp").gt(0)).calculate("x", col("wind")).table(),
    ).toThrow(/transform\[1\] \(calculate\): expression: no field "wind"/);
    expect(() => deriveTable(readings as unknown as Table, [{ filter: ["+", 1, 2] }])).toThrow(
      /true or false expression/,
    );
  });
});

describe("edge cases", () => {
  it("bins from fractional starts and by tiny steps", () => {
    const offset = table({ v: [1000000000.25, 1000000001.25, 1000000001.75] });
    expect(values(derive(offset).bin("v", { step: 1, start: 1000000000.25 }).table(), "v")).toEqual(
      [1000000000.25, 1000000001.25, 1000000001.25],
    );
    const tiny = table({ v: [1e-16, 2e-16, 3e-16, 3.5e-16] });
    expect(values(derive(tiny).bin("v", { step: 1e-16 }).table(), "v")).toEqual([
      1e-16, 2e-16, 3e-16, 3e-16,
    ]);
    const tinier = table({ v: [1e-300, 2.5e-300] });
    expect(values(derive(tinier).bin("v", { step: 1e-300 }).table(), "v")).toEqual([
      1e-300, 2e-300,
    ]);
    // Steps that are not short decimals keep their own edges.
    const thirds = table({ v: [0.5, 1, 1.5] });
    expect(
      values(
        derive(thirds)
          .bin("v", { step: 1 / 3 })
          .table(),
        "v",
      ),
    ).toEqual([1 / 3, 1, 4 / 3]);
  });

  it("keeps every start as given", () => {
    // None of these starts counts in safe decimal units; each still starts a bin.
    for (const start of [0.12345678901234566, 1000000000000.0005, 1e15 + 0.25]) {
      const t = table({ v: [start, start + 1, start + 1.5] });
      expect(values(derive(t).bin("v", { step: 1, start }).table(), "v")).toEqual([
        start,
        start + 1,
        start + 1,
      ]);
    }
    // Round steps for small values are exact (0.0001, not 0.00009999999999999999).
    const small = table({ v: [0.0001, 0.00035, 0.0009] });
    expect(values(derive(small).bin("v").table(), "v")).toEqual([0.0001, 0.0003, 0.0009]);
    // More bins from the start than doubles count exactly: each value starts its own.
    const far = table({ v: [-1, 1] });
    expect(values(derive(far).bin("v", { step: 1e-300 }).table(), "v")).toEqual([-1, 1]);
  });

  it("rejects bin options the spec loader rejects", () => {
    const t = table({ v: [1, 2, 3] });
    const binned = (options: { step?: number; count?: number; start?: number }) => () =>
      derive(t).bin("v", options).table();
    expect(binned({ count: 0 })).toThrow(
      /\(bin\): count: expected a whole number of at least 1; received 0/,
    );
    expect(binned({ count: 2.5 })).toThrow(/count: .*received 2\.5/);
    expect(binned({ step: 0 })).toThrow(/step: expected a positive number; received 0/);
    expect(binned({ step: Number.POSITIVE_INFINITY })).toThrow(/step: .*received Infinity/);
    expect(binned({ start: Number.NaN })).toThrow(/start: expected a finite number; received NaN/);
    expect(binned({ start: Number.POSITIVE_INFINITY })).toThrow(/start: .*received Infinity/);
  });

  it("bins exact integers and constant data", () => {
    const stamps = table({ at: time([1767225600001, 1767225600006, 1767225600011]) });
    expect(values(derive(stamps).bin("at", { step: 1 }).table(), "at")).toEqual([
      1767225600001, 1767225600006, 1767225600011,
    ]);
    expect(values(derive(stamps).bin("at", { step: 5 }).table(), "at")).toEqual([
      1767225600000, 1767225600005, 1767225600010,
    ]);
    // One value, or none: bins 1 wide.
    expect(
      values(
        derive(table({ x: [5.5] }))
          .bin("x")
          .table(),
        "x",
      ),
    ).toEqual([5]);
    const empty = table({ x: new Float64Array(0) });
    const binned = derive(empty).bin("x").table();
    empty.append({ x: [3.2] });
    expect(values(binned, "x")).toEqual([3]);
  });

  it("rolls huge and nearly equal values without cancellation", () => {
    const near = table({ v: [1e12, 1e12 + 1, 1e12 + 2] });
    const sd = derive(near)
      .rolling({ size: 2, ops: { sd: { op: "stdev", field: "v" } } })
      .table();
    expect(values(sd, "sd")).toEqual([
      null,
      expect.closeTo(Math.SQRT1_2, 9),
      expect.closeTo(Math.SQRT1_2, 9),
    ]);
    const spike = table({ v: [1e16, 1, 1, 1] });
    const avg = derive(spike)
      .rolling({ size: 2, ops: { m: { op: "mean", field: "v" } } })
      .table();
    expect(values(avg, "m")).toEqual([1e16, 5e15, 1, 1]);
    const sums = derive(spike)
      .rolling({ size: 2, ops: { s: { op: "sum", field: "v" } } })
      .table();
    expect(values(sums, "s")).toEqual([1e16, 1e16 + 1, 2, 2]);
    // Squares and sums of huge values overflow; their spread and mean do not.
    const huge = table({ v: [1e160, 1e160, 1e160], w: [1e308, 1e308, 1e308] });
    const spread = derive(huge)
      .rolling({
        size: 2,
        ops: { sd: { op: "stdev", field: "v" }, m: { op: "mean", field: "w" } },
      })
      .table();
    expect(values(spread, "sd")).toEqual([null, 0, 0]);
    expect(values(spread, "m")).toEqual([1e308, 1e308, 1e308]);
    // Squared deviations a double holds stay finite on the way: this spread
    // squares past the largest double before its weight of a half. Values
    // whose differences pass the largest double overflow (a known limit).
    const wide = table({ v: [1e308, -1e308], w: [0, 1.4e154] });
    const finite = derive(wide)
      .rolling({
        size: 2,
        ops: { m: { op: "mean", field: "v" }, sd: { op: "stdev", field: "w" } },
      })
      .table();
    expect(values(finite, "m")).toEqual([1e308, -Infinity]);
    const [none, deviation] = values(finite, "sd") as [null, number];
    expect(none).toBeNull();
    expect(deviation / (1.4e154 * Math.SQRT1_2)).toBeCloseTo(1, 12);
  });

  it("keeps one row for ungrouped aggregates of nothing", () => {
    const t = table({ v: [1, 2] });
    const none = derive(t)
      .filter(col("v").gt(10))
      .aggregate({ ops: { n: count(), total: sum("v"), avg: mean("v") } })
      .table();
    expect([values(none, "n"), values(none, "total"), values(none, "avg")]).toEqual([
      [0],
      [0],
      [null],
    ]);
  });

  it("keeps unusual field names, missing branches, and only real operators", () => {
    const odd = table({ ["__proto__"]: [1, 2], v: [3, 4] } as never) as unknown as Table;
    const copy = deriveTable(odd, [{ filter: [">", ["field", "v"], 0] }]);
    expect(copy.fields()).toContain("__proto__");
    odd.append({ ["__proto__"]: [5], v: [6] } as never);
    expect(copy.length).toBe(3);
    const labels = derive(readings)
      .calculate("hot", when(col("temp").gt(15), "hot", null))
      .calculate("cool", when(col("temp").gt(15), null, "cool"))
      .table();
    expect([labels.kind("hot"), labels.kind("cool")]).toEqual(["category", "category"]);
    expect(values(labels, "hot")).toEqual([null, "hot", null, "hot", null, null]);
    expect(values(labels, "cool")).toEqual(["cool", null, "cool", null, "cool", "cool"]);
    expect(() =>
      compileExpression(["constructor", 1, 2] as never, readings as unknown as Table),
    ).toThrow(/expression: no operator "constructor"/);
  });
});

describe("following the source", () => {
  it("appends and drops rows through row-by-row pipelines", () => {
    const source = table({ x: [1, 2, 3], v: [5, 50, 7] }, { maxRows: 4 });
    const small = derive(source).filter(col("v").lt(10)).calculate("w", col("v").mul(2)).table();
    expect(values(small, "x")).toEqual([1, 3]);
    let changes = 0;
    small.subscribe(() => changes++);
    source.append({ x: [4], v: [8] });
    expect(values(small, "x")).toEqual([1, 3, 4]);
    expect(values(small, "w")).toEqual([10, 14, 16]);
    // The window drops x 1 and 2: their derived rows go, the others stay.
    source.append({ x: [5, 6], v: [90, 1] });
    expect(values(small, "x")).toEqual([3, 4, 6]);
    expect(changes).toBeGreaterThan(0);
  });

  it("recomputes aggregates, and everything after replacements", () => {
    const source = table({ g: ["a", "b"], v: [1, 2] });
    const totals = derive(source)
      .aggregate({ by: ["g"], ops: { total: sum("v") } })
      .table();
    source.append({ g: ["a"], v: [10] });
    expect(values(totals, "total")).toEqual([11, 2]);
    source.reset({ g: category(["c"]), v: [3] });
    expect(values(totals, "g")).toEqual(["c"]);
    const doubled = derive(source).calculate("w", col("v").mul(2)).table();
    source.set("v", 0, 4);
    expect(values(doubled, "w")).toEqual([8]);
  });

  it("does not share storage with its source", () => {
    const source = table({ v: Float64Array.of(1, 2, 3) });
    const copy = derive(source).sort("v").table();
    source.set("v", 0, 99);
    // The derived table changed only through its own recomputation.
    expect(values(copy, "v")).toEqual([2, 3, 99]);
  });
});

describe("derived tables in specs", () => {
  const spec = (transform: unknown, source = "raw"): ChartSpec => ({
    data: {
      raw: { columns: { g: ["a", "b", "a"], v: [1, 2, 3] } },
      totals: { source, transform } as never,
    },
    marks: [{ type: "bar", data: "totals", x: "g", y: "total" }],
  });

  it("loads them after their sources and charts them", () => {
    const { config, tables } = loadSpec(
      spec([{ aggregate: [{ op: "sum", field: "v", as: "total" }], by: ["g"] }]),
    );
    expect(values(tables.get("totals")!, "total")).toEqual([4, 2]);
    const model = new ChartModel({ locale: "en-US", ...config });
    model.setSize(400, 200, 1);
    const rects = model.scene(estimateText).panels[0]!.marks[0] as RectGeometry;
    expect(rects.count).toBe(2);
    // Appending to the source in the browser updates the chart's data.
    tables.get("raw")!.append({ g: ["b"], v: [5] } as never);
    expect(values(tables.get("totals")!, "total")).toEqual([4, 7]);
  });

  it("rejects unknown sources, cycles, and malformed steps", () => {
    expect(() => loadSpec(spec([], "nope"))).toThrow(/spec\.data\.totals\.source: no table "nope"/);
    const cycle: ChartSpec = {
      data: { a: { source: "b", transform: [] }, b: { source: "a", transform: [] } } as never,
      marks: [],
    };
    expect(() => loadSpec(cycle)).toThrow(/spec\.data\.a\.source: the table derives from itself/);
    expect(() => loadSpec(spec([{ explode: true }]))).toThrow(/a transform \(filter/);
    // Unknown step options are reported like any others; two transforms in a step are refused.
    const filter = [">", ["field", "v"], 1];
    expect(() => loadSpec(spec([{ filter, as: "x" }]), [], { unknown: "error" })).toThrow(
      /transform\[0\]\.as: not a property/,
    );
    expect(() => loadSpec(spec([{ filter, sort: "v" }]))).toThrow(
      /a step is one transform, here filter/,
    );
    expect(() =>
      loadSpec(spec([{ rolling: [{ op: "median", field: "v", as: "m" }], size: 2 }])),
    ).toThrow(/rolling\[0\]\.op/);
    expect(() => loadSpec(spec([{ calculate: ["+", ["field", "v"], 1] }]))).toThrow(
      /\.as: required/,
    );
  });
});

// The builder's types follow the steps; a misspelled field is a compile error.
// Checked by the compiler only, never run.
export function typeChecks() {
  derive(readings)
    .calculate("f", col("temp").mul(2))
    .aggregate({ by: ["site"], ops: { avg: mean("f") } })
    .table()
    .numbers("avg");
  // @ts-expect-error "wind" is not a field of readings.
  derive(readings).bin("wind", { step: 1 });
  // @ts-expect-error aggregates read number fields only.
  derive(readings).aggregate({ ops: { m: mean("site") } });
  // Text makes a category field, which is not a number.
  // @ts-expect-error "label" is a category.
  derive(readings).calculate("label", "hot").table().numbers("label");
  derive(readings)
    .calculate("label", when(col("temp").gt(0), "a", "b"))
    .table()
    .categories("label");
  const counted = derive(readings)
    .aggregate({ by: ["site"], ops: { site: count() } })
    .table();
  counted.numbers("site");
  // @ts-expect-error "site" holds counts, which replaced the grouping field.
  counted.categories("site");
}
