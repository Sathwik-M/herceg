import { describe, expect, it } from "vitest";
import { RowSet } from "../../src/data/row-set.ts";
import { table } from "../../src/data/table.ts";

describe("row sets", () => {
  it("hold rows by identity as other rows are appended and dropped", () => {
    const t = table({ x: Float64Array.from({ length: 100 }, (_, i) => i) }, { maxRows: 100 });
    const set = new RowSet(t).add(3).addRange(40, 70).add(99);
    expect(set.size).toBe(32);
    expect(set.has(3) && set.has(55) && !set.has(70)).toBe(true);
    // Fifty rows drop: row 55 is now at 5, and rows 3 and 40-49 have left.
    t.append({ x: Float64Array.from({ length: 50 }, (_, i) => 100 + i) });
    expect(set.has(5)).toBe(true);
    expect(set.size).toBe(21);
    expect(Array.from(set.positions())).toEqual([...Array.from({ length: 20 }, (_, i) => i), 49]);
    set.delete(0).add(60);
    expect(set.size).toBe(21);
    expect(set.byteLength).toBeLessThan(64);
  });

  it("keep identities apart past 2^32 rows", () => {
    const t = table({ x: [0, 1] }, { maxRows: 2 });
    const set = new RowSet(t).add(0);
    // An oversized append keeps only its last rows: a sparse array this long
    // moves identities on by about 2^32 at once.
    const huge: (number | null)[] = [];
    huge.length = 2 ** 32 - 1;
    huge[huge.length - 1] = 7;
    t.append({ x: huge });
    // One more row: identities now start exactly 2^32 after the set's first.
    t.append({ x: [8] });
    expect(t.rowOffset).toBe(2 ** 32);
    // The selected row left long ago; nothing wraps around to the new rows.
    expect([set.size, set.has(0), set.has(1)]).toEqual([0, false, false]);
    expect(set.add(1).positions()).toEqual(Uint32Array.of(1));
  });

  it("are empty after their table resets, which starts identities again", () => {
    const t = table({ x: [1, 2, 3] });
    const set = new RowSet(t).add(1);
    t.reset({ x: [7, 8, 9] });
    expect(set.current).toBe(false);
    expect([set.size, set.has(1), set.positions().length]).toEqual([0, false, 0]);
    expect(() => set.add(0)).toThrow(/reset/);
    expect(() => new RowSet(t).add(3)).toThrow(RangeError);
  });
});
