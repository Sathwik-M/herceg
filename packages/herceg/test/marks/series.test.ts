import { describe, expect, it, vi } from "vitest";
import { category } from "../../src/data/column.ts";
import { type Table, table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { histogram } from "../../src/marks/histogram.ts";
import { point } from "../../src/marks/point.ts";
import { RowGroups } from "../../src/marks/row-groups.ts";
import { groupRows, isSortedSubset, type Series, yExtent } from "../../src/marks/series.ts";
import { ChartModel } from "../../src/model/model.ts";

function series(x: number[], y: number[], options: Partial<Series> = {}): Series {
  const values = Float64Array.from(y);
  return {
    key: "s",
    label: "s",
    color: "#000",
    x: Float64Array.from(x),
    y: values,
    y0: undefined,
    values,
    range: false,
    rows: undefined,
    length: x.length,
    sorted: true,
    ...options,
  };
}

describe("yExtent", () => {
  it("ignores missing and infinite values in a whole sorted column", () => {
    const s = series([0, 1, 2, 3, 4], [5, Number.NaN, Number.POSITIVE_INFINITY, -2, 7]);
    expect(yExtent(s, 0, 4)).toEqual([-2, 7]);
  });

  it("covers points inside the range and where segments cross its edges", () => {
    const s = series([0, 10, 20, 30], [0, 100, 0, 100]);
    // Inside [5, 15] only x = 10; the edges cut the segments at y = 50.
    expect(yExtent(s, 5, 15)).toEqual([50, 100]);
    expect(yExtent(s, 15, 5)).toEqual([50, 100]);
  });

  it("only counts positive values on log scales", () => {
    const s = series([0, 1, 2], [-1, 0, 10]);
    expect(yExtent(s, 0, 2, s.y, true)).toEqual([10, 10]);
  });

  it("tests x for unsorted series and row subsets", () => {
    const unsorted = series([3, 0, 2, 9], [1, 50, 2, 99], { sorted: false });
    expect(yExtent(unsorted, 0, 3)).toEqual([1, 50]);
    const subset = series([0, 1, 2, 3], [9, 1, 8, 2], {
      rows: Uint32Array.from([1, 3]),
      length: 2,
    });
    expect(yExtent(subset, 0, 3)).toEqual([1, 2]);
  });
});

describe("row groups", () => {
  /** What grouping the table from scratch gives, in dictionary order. */
  function regrouped(t: ReturnType<typeof stream>) {
    const { codes, dictionary } = t.categories("kind");
    const groups = groupRows(codes, dictionary.length);
    const x = t.numbers("x");
    return dictionary.flatMap((name, code) =>
      groups[code]!.length === 0
        ? []
        : [{ name, rows: Array.from(groups[code]!), sorted: isSortedSubset(x, groups[code]!) }],
    );
  }
  const stream = (maxRows: number) =>
    table({ x: new Float64Array(0), kind: category([]) }, { maxRows });
  const seen = (groups: RowGroups) =>
    groups.groups().map(({ name, rows, sorted }) => ({ name, rows: Array.from(rows), sorted }));

  it("stay what grouping again gives through appends, rolling drops, and renumbered codes", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const t = stream(300);
    const groups = new RowGroups(t as unknown as Table, "kind", "x");
    let x = 0;
    for (let tick = 0; tick < 200; tick++) {
      const count = 1 + Math.floor(random() * 40);
      // Categories drift, so the window's dictionary is compacted and codes renumbered.
      const base = Math.floor(tick / 20);
      t.append({
        x: Float64Array.from({ length: count }, () => {
          x += random() < 0.05 ? -3 : 1;
          return x;
        }),
        kind: Array.from({ length: count }, () =>
          random() < 0.05 ? (null as unknown as string) : `k${base + Math.floor(random() * 4)}`,
        ),
      });
      expect(seen(groups)).toEqual(regrouped(t));
    }
  });

  it("count the rows each group lost, and keep one key while it follows the table", () => {
    const t = stream(4);
    const groups = new RowGroups(t as unknown as Table, "kind", "x");
    t.append({ x: Float64Array.of(1, 2, 3, 4), kind: ["a", "b", "a", "b"] });
    const [a] = groups.groups();
    t.append({ x: Float64Array.of(5, 6), kind: ["a", "b"] });
    const [after] = groups.groups();
    // The window dropped x 1 and 2: "a" lost one row and kept x 3, now first, then x 5.
    expect(after!.name).toBe("a");
    expect(after!.dropped).toBe(1);
    expect(after!.key).toBe(a!.key);
    expect(Array.from(after!.rows)).toEqual([0, 2]);
    // A group the window empties starts over, with a key of its own.
    t.append({ x: Float64Array.of(7, 8, 9, 10), kind: ["b", "b", "b", "a"] });
    const again = groups.groups().find(({ name }) => name === "a")!;
    expect([again.dropped, again.key === a!.key]).toEqual([0, false]);
    // A change to values in place groups the table again.
    t.replace("kind", 0, ["b"]);
    expect(seen(groups)).toEqual(regrouped(t));
    expect(groups.groups().every(({ dropped }) => dropped === 0)).toBe(true);
  });

  it("leave rows given out unchanged, for scenes and charts that still read them", () => {
    const t = stream(6);
    const groups = new RowGroups(t as unknown as Table, "kind", "x");
    t.append({ x: Float64Array.of(1, 2, 3, 4, 5, 6), kind: ["a", "b", "a", "b", "a", "b"] });
    const given = groups.groups().map(({ rows }) => [rows, Array.from(rows)] as const);
    // Drops rebase the rest, and appends past a buffer's end grow it.
    t.append({ x: Float64Array.of(7, 8, 9), kind: ["a", "a", "a"] });
    groups.groups();
    t.append({ x: Float64Array.from({ length: 40 }, (_, i) => 10 + i), kind: Array(40).fill("a") });
    groups.groups();
    for (const [rows, copy] of given) expect(Array.from(rows)).toEqual(copy);
  });

  it("keep what a chart showed while another chart sharing the mark moves on", async () => {
    const t = stream(4);
    t.append({ x: Float64Array.of(1, 2, 3, 4), kind: ["a", "b", "a", "b"] });
    const mark = point(t as unknown as Table, { x: "x", y: "x", series: "kind" } as never);
    const chart = () => {
      const model = new ChartModel({ marks: [mark], locale: "en-US" });
      model.setSize(400, 300, 1);
      return model;
    };
    const [a, b] = [chart(), chart()];
    a.scene(estimateText);
    // The grouping that follows the table loads after the first scene.
    await vi.dynamicImportSettled();
    t.append({ x: Float64Array.of(5), kind: ["a"] });
    b.scene(estimateText);
    const at = (model: ChartModel) => {
      const x = model.xScale()!.map(3);
      const y = model.yScale()!.map(3);
      const point = model.inspect(x, y, "nearest")?.points[0];
      return point && [point.label, point.value];
    };
    const before = at(b);
    expect(before).toEqual(["a", 3]);
    // Chart a draws the next version: b's scene still reads its own rows.
    t.append({ x: Float64Array.of(6), kind: ["b"] });
    a.scene(estimateText);
    expect(at(b)).toEqual(before);
  });

  it("group rows without an x, or with a category x, as they stream", async () => {
    const t = table(
      { v: new Float64Array(0), kind: category([]), at: category([]) },
      { maxRows: 6 },
    );
    const add = (count: number) =>
      t.append({
        v: Float64Array.from({ length: count }, (_, i) => i),
        kind: Array.from({ length: count }, (_, i) => (i % 2 ? "a" : "b")),
        at: Array.from({ length: count }, (_, i) => `c${i}`),
      });
    add(4);
    for (const x of [undefined, "at"]) {
      const groups = new RowGroups(t as unknown as Table, "kind", x);
      add(3);
      const { codes, dictionary } = t.categories("kind");
      const expected = groupRows(codes, dictionary.length).map((rows, code) => [
        dictionary[code],
        Array.from(rows),
        false,
      ]);
      expect(
        groups.groups().map(({ name, rows, sorted }) => [name, Array.from(rows), sorted]),
      ).toEqual(expected.filter(([, rows]) => (rows as number[]).length > 0));
    }
    // A grouped histogram keeps drawing once the grouping that follows the table loads.
    const counts = histogram(t as unknown as Table, { x: "v", series: "kind" } as never);
    const model = new ChartModel({ marks: [counts], locale: "en-US" });
    model.setSize(400, 300, 1);
    model.scene(estimateText);
    await vi.dynamicImportSettled();
    add(5);
    expect(() => model.scene(estimateText)).not.toThrow();
  });

  it("give back room as a window shrinks a group", () => {
    const t = stream(100_000);
    const groups = new RowGroups(t as unknown as Table, "kind", "x");
    t.append({
      x: Float64Array.from({ length: 100_000 }, (_, i) => i),
      kind: Array(100_000).fill("a"),
    });
    groups.groups();
    t.dropFirst(99_990);
    const [a] = groups.groups();
    expect(a!.rows.length).toBe(10);
    expect(a!.rows.buffer.byteLength).toBeLessThanOrEqual(64 * 4);
  });

  it("keep groups and their keys when a window renumbers the field's codes", () => {
    const t = stream(10);
    const groups = new RowGroups(t as unknown as Table, "kind", "x");
    // A name ahead of "kept" in the dictionary, which the window drops.
    t.append({ x: Float64Array.of(0, 0.5), kind: ["early", "kept"] });
    const first = groups.groups().find(({ name }) => name === "kept")!;
    const codeBefore = t.categories("kind").codes[1];
    // Many names come and go; past twice the rows plus 64, the dictionary is compacted.
    let x = 1;
    for (let tick = 0; tick < 30; tick++) {
      t.append({
        x: Float64Array.from({ length: 9 }, () => x++),
        // "kept" ends each batch, so the window always holds one.
        kind: Array.from({ length: 9 }, (_, i) => (i === 8 ? "kept" : `gone ${tick} ${i}`)),
      });
      groups.groups();
    }
    const { codes, dictionary } = t.categories("kind");
    const kept = groups.groups().find(({ name }) => name === "kept")!;
    expect(dictionary.length).toBeLessThan(30 * 9);
    expect(codes[kept.rows[0]!]).not.toBe(codeBefore);
    expect(kept.key).toBe(first.key);
    expect(seen(groups)).toEqual(regrouped(t));
    // Every "kept" row but those still in the window has left.
    expect(kept.dropped + kept.rows.length).toBe(31);
  });

  it("count a missing x as not ascending, as regrouping does", () => {
    const t = stream(2);
    const groups = new RowGroups(t as unknown as Table, "kind", "x");
    t.append({ x: Float64Array.of(Number.NaN), kind: ["a"] });
    expect(groups.groups()[0]!.sorted).toBe(false);
    t.append({ x: Float64Array.of(3, Number.NaN), kind: ["b", "a"] });
    expect(seen(groups)).toEqual(regrouped(t));
  });

  it("tell when x stops ascending in a group, and when the inversion leaves the window", () => {
    const t = stream(3);
    const groups = new RowGroups(t as unknown as Table, "kind", "x");
    t.append({ x: Float64Array.of(5, 1, 2), kind: ["a", "a", "a"] });
    expect(groups.groups()[0]!.sorted).toBe(false);
    t.append({ x: Float64Array.of(3), kind: ["a"] });
    expect(groups.groups()[0]!.sorted).toBe(true);
  });
});
