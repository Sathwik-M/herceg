// Regression tests for table edge cases: aliasing, storage conversion,
// argument validation, rolling-window bookkeeping, and empty columns.
import { describe, expect, it } from "vitest";
import { category, time } from "../../src/data/column.ts";
import { fromRows, type TableChange, table } from "../../src/data/table.ts";

describe("append edge cases", () => {
  it("reads inputs that view the table's own storage before compacting", () => {
    const t = table({ x: Float64Array.from({ length: 100 }, (_, i) => i) });
    t.append({ x: [100] }); // take ownership with spare capacity
    t.dropFirst(40);
    const view = t.numbers("x").subarray(0, 1);
    for (let i = 0; i < 200; i++) t.append({ x: i === 0 ? view : [0] });
    expect(t.numbers("x")[61]).toBe(40);
  });

  it("checks sortedness against stored values after integer wrapping", () => {
    const t = table({ x: new Uint8Array([10, 250]) });
    expect(t.isSorted("x")).toBe(true);
    t.append({ x: [256] }); // stored as 0
    expect(t.numbers("x")[2]).toBe(0);
    expect(t.isSorted("x")).toBe(false);
    expect(t.extent("x")).toEqual([0, 250]);
  });

  it("reports oversized batches as drops of existing rows plus kept rows", () => {
    const t = table({ x: [1, 2] }, { maxRows: 3 });
    const changes: TableChange[] = [];
    t.subscribe((change) => changes.push(change));
    t.append({ x: [3, 4, 5, 6, 7] });
    expect(changes[0]).toMatchObject({ dropped: 2, appended: 3 });
    expect(t.rowOffset).toBe(4);
  });

  it("extends cached extents on append without rescanning", () => {
    const t = table({ y: [5, 1, 3] });
    expect(t.extent("y")).toEqual([1, 5]);
    t.append({ y: [9] });
    expect(t.extent("y")).toEqual([1, 9]);
    t.dropFirst(1);
    expect(t.extent("y")).toEqual([1, 9]);
    t.dropFirst(3);
    expect(t.extent("y")).toBeUndefined();
  });

  it("caches the absence of finite values", () => {
    const t = table({ y: [Number.NaN, Number.NaN] });
    expect(t.extent("y")).toBeUndefined();
    t.append({ y: [2] });
    expect(t.extent("y")).toEqual([2, 2]);
  });
});

describe("validation", () => {
  it("requires integer maxRows", () => {
    expect(() => table({ x: [1] }, { maxRows: 1.5 })).toThrow(/positive integer/);
    expect(() => table({ x: [1] }, { maxRows: 0 })).toThrow(/positive integer/);
  });

  it("rejects invalid counts and indices without changing state", () => {
    const t = table({ x: [1, 2, 3] });
    expect(() => t.dropFirst(Number.NaN)).toThrow(RangeError);
    expect(() => t.dropFirst(1.5)).toThrow(RangeError);
    expect(() => t.replace("x", 0.5, [1])).toThrow(RangeError);
    expect(() => t.set("x", Number.NaN, 1)).toThrow(RangeError);
    expect(t.length).toBe(3);
    expect(t.version).toBe(0);
  });
});

describe("drops", () => {
  it("shrinks buffers after dropping most rows", () => {
    const t = table({ x: Float64Array.from({ length: 10_000 }, (_, i) => i) });
    t.append({ x: [10_000] });
    expect(t.byteLength).toBeGreaterThan(80_000);
    t.dropFirst(9_990);
    expect(t.byteLength).toBeLessThanOrEqual(64 * 8);
    expect(Array.from(t.numbers("x"))).toEqual(Array.from({ length: 11 }, (_, i) => 9_990 + i));
  });

  it("re-evaluates sortedness after dropping an inversion", () => {
    const t = table({ x: [3, 1, 2] });
    expect(t.isSorted("x")).toBe(false);
    t.dropFirst(1);
    expect(t.isSorted("x")).toBe(true);
    expect(() => t.dropBefore("x", 2)).not.toThrow();
    expect(Array.from(t.numbers("x"))).toEqual([2]);
  });

  it("reclaims dictionary entries no longer referenced by a rolling window", () => {
    const t = table({ name: category([]) }, { maxRows: 10 });
    for (let i = 0; i < 10_000; i++) t.appendRow({ name: `host-${i}` });
    const { codes, dictionary } = t.categories("name");
    expect(dictionary.length).toBeLessThanOrEqual(2 * 10 + 65);
    expect(Array.from(codes, (code) => dictionary[code])).toEqual(
      Array.from({ length: 10 }, (_, i) => `host-${9_990 + i}`),
    );
  });
});

describe("empty and tagged columns", () => {
  it("keeps empty category columns categorical", () => {
    const t = table({ c: category([]), t: time([]), v: [] as number[] });
    expect(t.kind("c")).toBe("category");
    expect(t.kind("t")).toBe("time");
    t.appendRow({ c: "a", t: 0, v: 1 });
    expect(t.value("c", 0)).toBe("a");
  });

  it("reads reset data as each field's existing kind", () => {
    const t = table({ c: ["a"], t: time([0]) });
    t.reset({ c: [], t: new Float64Array(0) });
    expect(t.kind("c")).toBe("category");
    expect(t.kind("t")).toBe("time");
    expect(t.length).toBe(0);
  });

  it("limits fromRows schemas to the selected fields", () => {
    const t = fromRows([{ x: 1, y: 2 }], { fields: ["x"] });
    expect(t.fields()).toEqual(["x"]);
    // @ts-expect-error y was not selected
    expect(() => t.numbers("y")).toThrow();
  });
});
