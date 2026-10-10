import { describe, expect, it } from "vitest";
import { category, time } from "../../src/data/column.ts";
import { fromRows, lowerBound, type TableChange, table, upperBound } from "../../src/data/table.ts";

describe("table()", () => {
  it("adopts typed arrays without copying", () => {
    const x = new Float64Array([1, 2, 3]);
    const t = table({ x });
    expect(t.numbers("x")).toBe(x);
    expect(t.kind("x")).toBe("number");
  });

  it("converts plain arrays, dates, and strings", () => {
    const t = table({
      n: [1, null, 3],
      d: [new Date(0), new Date(1000), null],
      c: ["a", "b", "a"],
    });
    expect(Array.from(t.numbers("n"))).toEqual([1, Number.NaN, 3]);
    expect(t.kind("d")).toBe("time");
    expect(Array.from(t.numbers("d"))).toEqual([0, 1000, Number.NaN]);
    expect(t.categories("c").dictionary).toEqual(["a", "b"]);
    expect(Array.from(t.categories("c").codes)).toEqual([0, 1, 0]);
    expect(t.value("n", 1)).toBeNull();
    expect(t.value("c", 2)).toBe("a");
  });

  it("marks numeric arrays as time with time()", () => {
    const t = table({ t: time(new Float64Array([0, 1])) });
    expect(t.kind("t")).toBe("time");
  });

  it("reads ISO 8601 strings, Dates, and epoch milliseconds as times", () => {
    const t = table({
      t: time(["2026-01-21", "2026-01-21T09:30:00Z", new Date(1000), 2000, null]),
    });
    expect(Array.from(t.numbers("t"))).toEqual([
      Date.UTC(2026, 0, 21),
      Date.UTC(2026, 0, 21, 9, 30),
      1000,
      2000,
      Number.NaN,
    ]);
    expect(t.value("t", 0)).toBe(Date.UTC(2026, 0, 21));
    expect(() => table({ t: time(["2026-01-21", "tomorrow"]) })).toThrow(
      'Column "t": row 1: expected an ISO 8601 time, a Date, or epoch milliseconds; received "tomorrow"',
    );
  });

  it("reads numbers as categories with category()", () => {
    const t = table({
      year: category([2025, 2024, 2025, Number.NaN, null]),
      status: category(new Int32Array([200, 404, 200, 200, 404])),
      v: [1, 2, 3, 4, 5],
    });
    expect(t.kind("year")).toBe("category");
    // In order of first appearance, labeled as String writes them; NaN is missing.
    expect(t.categories("year").dictionary).toEqual(["2025", "2024"]);
    expect(Array.from(t.categories("year").codes)).toEqual([0, 1, 0, -1, -1]);
    expect(t.categories("status").dictionary).toEqual(["200", "404"]);
    expect(t.value("status", 1)).toBe("404");
    t.appendRow({ year: 2023, status: "500", v: 6 });
    t.set("year", 0, 2026);
    expect(t.categories("year").dictionary).toEqual(["2025", "2024", "2023", "2026"]);
    expect(t.value("status", 5)).toBe("500");
  });

  it("rejects columns of different lengths", () => {
    expect(() => table({ a: [1, 2], b: [1] })).toThrow(/expected 2/);
  });

  it("rejects unsupported values", () => {
    expect(() => table({ a: [true] as unknown as number[] })).toThrow(/Unsupported/);
  });
});

describe("append", () => {
  it("appends batches and grows capacity", () => {
    const t = table({ x: new Float64Array([0]), y: new Float64Array([10]) });
    for (let i = 1; i < 200; i++) t.append({ x: [i], y: [10 + i] });
    expect(t.length).toBe(200);
    expect(t.numbers("x")[199]).toBe(199);
    expect(t.numbers("y")[0]).toBe(10);
    expect(t.byteLength).toBeLessThanOrEqual(200 * 1.5 * 8 * 2 + 16);
  });

  it("never writes into adopted arrays", () => {
    const x = new Float64Array([1, 2, 3, 4]);
    const t = table({ x });
    t.dropFirst(3);
    t.append({ x: [5] });
    t.set("x", 0, 99);
    expect(Array.from(x)).toEqual([1, 2, 3, 4]);
    expect(Array.from(t.numbers("x"))).toEqual([99, 5]);
  });

  it("keeps a rolling window with maxRows", () => {
    const t = table({ x: [] as number[] }, { maxRows: 5 });
    for (let i = 0; i < 100; i++) t.appendRow({ x: i });
    expect(Array.from(t.numbers("x"))).toEqual([95, 96, 97, 98, 99]);
    expect(t.rowOffset).toBe(95);
    // Capacity stays bounded by the window, not by the number of appends.
    expect(t.byteLength).toBeLessThanOrEqual(64 * 8);
  });

  it("keeps only the newest rows when a batch exceeds maxRows", () => {
    const t = table({ x: [1, 2] }, { maxRows: 3 });
    t.append({ x: [3, 4, 5, 6, 7] });
    expect(Array.from(t.numbers("x"))).toEqual([5, 6, 7]);
    expect(t.rowOffset).toBe(4);
  });

  it("requires every field with equal lengths", () => {
    const t = table({ x: [1], y: [2] });
    expect(() => t.append({ x: [1] } as never)).toThrow(/all 2 fields/);
    expect(() => t.append({ x: [1, 2], y: [1] })).toThrow(/expected 2/);
  });

  it("takes times as ISO 8601 strings and Dates", () => {
    const t = table({ t: time(new Float64Array([0])), v: [1] });
    t.appendRow({ t: "1970-01-01T00:00:01Z", v: 2 });
    t.append({ t: [new Date(2000), "1970-01-01T00:00:03.000Z"], v: [3, 4] });
    t.set("t", 0, "1970-01-01T00:00:00.500Z");
    expect(Array.from(t.numbers("t"))).toEqual([500, 1000, 2000, 3000]);
    t.dropBefore("t", "1970-01-01T00:00:02Z");
    expect(t.length).toBe(2);
  });

  it("changes nothing when a value is not of its field's kind", () => {
    const t = table({ t: time([0, 1]), v: [1, 2], c: ["a", "b"] }, { maxRows: 2 });
    const changes: TableChange[] = [];
    t.subscribe((change) => changes.push(change));
    // A batch that would drop rows to make room fails before dropping any.
    expect(() => t.append({ t: [2, "later"], v: [3, 4], c: ["c", "d"] })).toThrow(
      'append "t": row 1: expected an ISO 8601 time, a Date, or epoch milliseconds; received "later"',
    );
    expect(() => t.append({ t: [2], v: ["3" as never], c: ["c"] })).toThrow(
      'append "v": row 0: expected a number; received "3"',
    );
    expect(() => t.replace("t", 0, ["2026-13-45"])).toThrow(/^replace "t": row 0: expected/);
    // Categories take strings and numbers only.
    expect(() => t.append({ t: [2], v: [3], c: [Object.create(null)] })).toThrow(
      'append "c": row 0: expected a string or number; received {}',
    );
    expect(() => t.replace("c", 0, [true as never])).toThrow(
      /^replace "c": row 0: expected a string/,
    );
    expect(t.categories("c").dictionary).toEqual(["a", "b"]);
    expect(t.length).toBe(2);
    expect(Array.from(t.numbers("t"))).toEqual([0, 1]);
    expect(Array.from(t.numbers("v"))).toEqual([1, 2]);
    expect(changes).toEqual([]);
    // Dates are read as Date reads them, so what was checked is what is written.
    class Fickle extends Date {
      #reads = 0;
      override getTime(): number {
        if (this.#reads++ > 0) throw new Error("read twice");
        return super.getTime();
      }
    }
    t.append({ t: [new Fickle(5)], v: [5], c: ["e"] });
    expect(t.value("t", 1)).toBe(5);
  });

  it("extends category dictionaries", () => {
    const t = table({ c: ["a"] });
    t.append({ c: ["b", null, "a"] });
    expect(t.categories("c").dictionary).toEqual(["a", "b"]);
    expect(Array.from(t.categories("c").codes)).toEqual([0, 1, -1, 0]);
  });

  it("reports changes to subscribers", () => {
    const t = table({ x: [1, 2, 3] }, { maxRows: 4 });
    const changes: TableChange[] = [];
    const unsubscribe = t.subscribe((change) => changes.push(change));
    t.append({ x: [4, 5] });
    t.set("x", 0, 7);
    unsubscribe();
    t.dropFirst(1);
    expect(changes).toEqual([
      { dropped: 1, appended: 2, updated: null, fields: [], reset: false },
      { dropped: 0, appended: 0, updated: { start: 0, end: 1 }, fields: ["x"], reset: false },
    ]);
    expect(t.version).toBe(3);
  });
});

describe("drops and updates", () => {
  it("drops rows before a value of a sorted field", () => {
    const t = table({ t: [10, 20, 30, 40], v: [1, 2, 3, 4] });
    t.dropBefore("t", 25);
    expect(Array.from(t.numbers("t"))).toEqual([30, 40]);
    expect(Array.from(t.numbers("v"))).toEqual([3, 4]);
    expect(t.rowOffset).toBe(2);
  });

  it("refuses dropBefore on unsorted fields", () => {
    const t = table({ t: [3, 1, 2] });
    expect(() => t.dropBefore("t", 2)).toThrow(/sorted/);
  });

  it("replaces ranges and whole columns", () => {
    const t = table({ x: [1, 2, 3, 4] });
    t.replace("x", 1, [20, 30]);
    expect(Array.from(t.numbers("x"))).toEqual([1, 20, 30, 4]);
    t.setColumn("x", [5, 6, 7, 8]);
    expect(Array.from(t.numbers("x"))).toEqual([5, 6, 7, 8]);
    expect(() => t.replace("x", 3, [1, 2])).toThrow(/out of bounds/);
    expect(() => t.setColumn("x", [1])).toThrow(/needs 4/);
  });

  it("resets all data and keeps the schema", () => {
    const t = table({ x: [1, 2], c: ["a", "b"] });
    t.reset({ x: [3, 4, 5], c: ["z", "z", "y"] });
    expect(t.length).toBe(3);
    expect(t.categories("c").dictionary).toEqual(["z", "y"]);
    expect(() => t.reset({ x: ["no"], c: ["a"] } as never)).toThrow(/keep field "x"/);
  });

  it("accepts numeric arrays when resetting time fields", () => {
    const t = table({ t: time(new Float64Array([1, 2])) });
    t.reset({ t: new Float64Array([3, 4, 5]) });
    expect(t.kind("t")).toBe("time");
    expect(t.length).toBe(3);
  });
});

describe("sortedness and extents", () => {
  it("tracks sortedness across appends", () => {
    const t = table({ x: [1, 2, 3] });
    expect(t.isSorted("x")).toBe(true);
    t.append({ x: [3, 4] });
    expect(t.isSorted("x")).toBe(true);
    t.append({ x: [0] });
    expect(t.isSorted("x")).toBe(false);
  });

  it("treats NaN as unsorted", () => {
    expect(table({ x: [1, Number.NaN, 3] }).isSorted("x")).toBe(false);
  });

  it("computes extents of finite values", () => {
    const t = table({ y: [3, Number.NaN, -1, Number.POSITIVE_INFINITY, 7] });
    expect(t.extent("y")).toEqual([-1, 7]);
    expect(table({ y: [Number.NaN] }).extent("y")).toBeUndefined();
    t.append({ y: [100] });
    expect(t.extent("y")).toEqual([-1, 100]);
  });
});

describe("fromRows()", () => {
  it("converts row objects into columns", () => {
    const rows = [
      { when: new Date(1000), value: 1, host: "a", nested: { skip: true } },
      { when: new Date(2000), value: 2, host: "b", nested: { skip: true } },
    ];
    const t = fromRows(rows);
    expect(t.fields()).toEqual(["when", "value", "host"]);
    expect(t.kind("when")).toBe("time");
    expect(Array.from(t.numbers("value"))).toEqual([1, 2]);
    expect(t.categories("host").dictionary).toEqual(["a", "b"]);
  });

  it("reads properties as the kinds `types` gives them", () => {
    const rows = [
      { at: 1_000, iso: "1970-01-01T00:00:02Z", status: 200, value: 1 },
      { at: 3_000, iso: null, status: 404, value: 2 },
    ];
    const t = fromRows(rows, { types: { at: "time", iso: "time", status: "category" } });
    expect([t.kind("at"), t.kind("iso"), t.kind("status"), t.kind("value")]).toEqual([
      "time",
      "time",
      "category",
      "number",
    ]);
    expect(Array.from(t.numbers("iso"))).toEqual([2000, Number.NaN]);
    expect(t.categories("status").dictionary).toEqual(["200", "404"]);
    // Strings stay categories unless typed as times.
    expect(fromRows(rows).kind("iso")).toBe("category");
    expect(() => fromRows(rows, { types: { atx: "time" } as never })).toThrow(
      'fromRows types: no field "atx"; the rows have "at", "iso", "status", "value"',
    );
    expect(() => fromRows(rows, { types: { at: "date" } as never })).toThrow(
      'fromRows types.at: expected "number", "time", or "category"; received "date"',
    );
    expect(() => fromRows([{ at: "soon" }], { types: { at: "time" } })).toThrow(
      'fromRows "at": row 0: expected an ISO 8601 time',
    );
  });
});

describe("binary search", () => {
  const values = [1, 2, 2, 2, 5];
  it("finds lower and upper bounds", () => {
    expect(lowerBound(values, 2)).toBe(1);
    expect(upperBound(values, 2)).toBe(4);
    expect(lowerBound(values, 0)).toBe(0);
    expect(lowerBound(values, 9)).toBe(5);
  });
});
