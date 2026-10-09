import { describe, expect, it, vi } from "vitest";
import { category } from "../../src/data/column.ts";
import { type Schema, type Table, table } from "../../src/data/table.ts";
import type { RangeExtremes } from "../../src/lod/minmax-index.ts";
import { rowsByCode } from "../../src/marks/series.ts";
import { INDEXED_POINTS } from "../../src/marks/trace.ts";
import { type StackLayer, type UnionLayers, UnionStack } from "../../src/marks/union-stack.ts";
import type { StackGaps } from "../../src/spec/spec.ts";

/**
 * The stack worked out directly from its definition, one position at a
 * time: written apart from UnionStack so that the two share no mistake.
 */
function reference(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  layers: readonly StackLayer[],
  gaps: StackGaps,
) {
  const shown = layers.filter((layer) => layer.shown);
  // Each shown layer's rows with an x, by x and then row.
  const rows = shown.map(({ rows }) =>
    Array.from(rows)
      .filter((row) => Number.isFinite(x[row]!))
      .sort((a, b) => x[a]! - x[b]! || a - b),
  );
  const xs = [...new Set(rows.flat().map((row) => x[row]!))].sort((a, b) => a - b);
  const union: number[] = [];
  const tops: number[][] = shown.map(() => []);
  const bottoms: number[][] = shown.map(() => []);
  const rowTops = new Map<number, number>();
  const rowBases = new Map<number, number>();
  for (const at of xs) {
    const here = rows.map((list) => list.filter((row) => x[row] === at));
    const occurrences = Math.max(...here.map((list) => list.length));
    for (let j = 0; j < occurrences; j++) {
      union.push(at);
      let total = 0;
      shown.forEach((_, l) => {
        const own = here[l]!;
        let value = 0;
        if (own.length > 0) value = y[own[Math.min(j, own.length - 1)]!]!;
        else if (gaps === "interpolate") {
          const before = rows[l]!.filter((row) => x[row]! < at).at(-1);
          const after = rows[l]!.find((row) => x[row]! > at);
          if (before !== undefined && after !== undefined) {
            // In halves, which keep the spans of the largest values finite.
            const t = (at / 2 - x[before]! / 2) / (x[after]! / 2 - x[before]! / 2);
            value = y[before]! * (1 - t) + y[after]! * t;
          }
        }
        const base = total;
        if (Number.isFinite(value)) total += value;
        const top = Number.isFinite(value) ? total : Number.NaN;
        tops[l]!.push(top);
        bottoms[l]!.push(base);
        if (j < own.length) {
          rowTops.set(own[j]!, top);
          rowBases.set(own[j]!, base);
        }
      });
    }
  }
  return { union, tops, bottoms, rowTops, rowBases };
}

/** Each category's rows, in dictionary order, as a series field splits them. */
function layersOf<S extends Schema>(data: Table<S>, hidden: readonly string[] = []): StackLayer[] {
  const { codes, dictionary } = data.categories("s" as never);
  const groups = rowsByCode(codes, dictionary.length);
  return dictionary.flatMap((name, code) =>
    groups[code]!.length > 0 ? [{ name, rows: groups[code]!, shown: !hidden.includes(name) }] : [],
  );
}

/** Checks a stack's edges and its rows' tops and bases against the reference. */
function check<S extends Schema>(
  data: Table<S>,
  stack: UnionLayers,
  layers: readonly StackLayer[],
  gaps: StackGaps,
) {
  const x = data.numbers("t" as never);
  const y = data.numbers("v" as never);
  const want = reference(x, y, layers, gaps);
  let l = 0;
  layers.forEach((layer, i) => {
    const edges = stack.edges[i];
    if (!layer.shown) {
      expect(edges).toBeUndefined();
      for (const row of layer.rows) expect(stack.tops[row]).toBeNaN();
      return;
    }
    expect(Array.from(edges!.x)).toEqual(want.union);
    expect(Array.from(edges!.top)).toEqual(want.tops[l]);
    if (l === 0) expect(edges!.bottom).toBeUndefined();
    else expect(Array.from(edges!.bottom!)).toEqual(want.bottoms[l]);
    l++;
    for (const row of layer.rows) {
      expect(stack.tops[row]).toBe(want.rowTops.get(row) ?? Number.NaN);
      expect(stack.bases[row]).toBe(want.rowBases.get(row) ?? Number.NaN);
    }
  });
  expect(stack.tops.length).toBe(data.length);
}

function stackOf(
  columns: { t: number[]; v: number[]; s: string[] },
  gaps: StackGaps = "zero",
  hidden: string[] = [],
) {
  const data = table({ ...columns, s: category(columns.s) });
  const layers = layersOf(data, hidden);
  const stack = new UnionStack().update(data, data.numbers("t"), data.numbers("v"), layers, gaps);
  check(data, stack, layers, gaps);
  return { stack, layers };
}

describe("union stacks", () => {
  it("stack each layer on the x positions of all of them", () => {
    const { stack } = stackOf({
      t: [0, 1, 2, 0, 2, 3, 1],
      v: [1, 2, 3, 10, 20, 30, 5],
      s: ["a", "a", "a", "b", "b", "b", "c"],
    });
    const [a, b, c] = stack.edges;
    expect(Array.from(a!.x)).toEqual([0, 1, 2, 3]);
    // Where a layer has no row it counts as zero: b is flat at x = 1.
    expect(Array.from(a!.top)).toEqual([1, 2, 3, 0]);
    expect(Array.from(b!.bottom!)).toEqual([1, 2, 3, 0]);
    expect(Array.from(b!.top)).toEqual([11, 2, 23, 30]);
    expect(Array.from(c!.top)).toEqual([11, 7, 23, 30]);
    // Rows stand where their layer is drawn at them.
    expect(Array.from(stack.tops)).toEqual([1, 2, 3, 11, 23, 30, 7]);
    expect(Array.from(stack.bases)).toEqual([0, 0, 0, 1, 3, 0, 2]);
  });

  it("interpolate between a layer's rows, and count zero beyond them", () => {
    const { stack } = stackOf(
      {
        t: [0, 1, 2, 0, 2, 3, 1],
        v: [1, 2, 3, 10, 20, 30, 5],
        s: ["a", "a", "a", "b", "b", "b", "c"],
      },
      "interpolate",
    );
    const [a, b, c] = stack.edges;
    expect(Array.from(a!.top)).toEqual([1, 2, 3, 0]);
    // b is halfway from 10 to 20 at x = 1; c only has x = 1.
    expect(Array.from(b!.top)).toEqual([11, 17, 23, 30]);
    expect(Array.from(c!.top)).toEqual([11, 22, 23, 30]);
  });

  it("interpolate between values too large for their difference", () => {
    const { stack } = stackOf(
      { t: [0, 2e12, 1e12], v: [-1e308, 1e308, 1], s: ["a", "a", "b"] },
      "interpolate",
    );
    expect(Array.from(stack.edges[0]!.top)).toEqual([-1e308, 0, 1e308]);
    expect(Array.from(stack.edges[1]!.top)).toEqual([-1e308, 1, 1e308]);
    // And between x too far apart for their difference.
    const wide = stackOf(
      { t: [-1e308, 1e308, 0, 9e307], v: [10, 20, 1, 1], s: [..."aabb"] },
      "interpolate",
    ).stack;
    expect(Array.from(wide.edges[0]!.top)).toEqual([10, 15, 19.5, 20]);
  });

  it("draw nothing at a missing value, which counts as zero above", () => {
    for (const gaps of ["zero", "interpolate"] as const) {
      const { stack } = stackOf(
        { t: [0, 1, 2, 0, 1, 2], v: [1, Number.NaN, 3, 10, 10, 10], s: [..."aaabbb"] },
        gaps,
      );
      expect(Array.from(stack.edges[0]!.top)).toEqual([1, Number.NaN, 3]);
      expect(Array.from(stack.edges[1]!.bottom!)).toEqual([1, 0, 3]);
      expect(stack.tops[1]).toBeNaN();
    }
    // An interpolation from or to a missing value is missing too.
    const { stack } = stackOf(
      { t: [0, 2, 1], v: [1, Number.NaN, 5], s: ["a", "a", "b"] },
      "interpolate",
    );
    expect(Array.from(stack.edges[0]!.top)).toEqual([1, Number.NaN, Number.NaN]);
    expect(Array.from(stack.edges[1]!.top)).toEqual([1, 5, 0]);
  });

  it("pair rows at one x by occurrence, a layer with fewer holding its last", () => {
    const { stack } = stackOf({
      t: [0, 1, 1, 2, 0, 1, 2, 1, 1, 1],
      v: [1, 2, 4, 3, 10, 10, 10, 100, Number.NaN, 300],
      s: [..."aaaabbbccc"],
    });
    const [a, b, c] = stack.edges;
    expect(Array.from(a!.x)).toEqual([0, 1, 1, 1, 2]);
    // a steps from 2 to 4 at x = 1 and holds 4; b holds its one row there.
    expect(Array.from(a!.top)).toEqual([1, 2, 4, 4, 3]);
    expect(Array.from(b!.top)).toEqual([11, 12, 14, 14, 13]);
    // c's second row there is missing; its third has a value.
    expect(Array.from(c!.top)).toEqual([11, 112, Number.NaN, 314, 13]);
    expect([stack.tops[1], stack.tops[2], stack.tops[5]]).toEqual([2, 4, 12]);
  });

  it("stack rows whose x does not ascend in x order, leaving the series' rows alone", () => {
    const columns = {
      t: [2, 0, Number.NaN, 1, 1, 0, 2],
      v: [3, 1, 99, 2, 20, 10, 30],
      s: [..."aaaabbb"],
    };
    for (const gaps of ["zero", "interpolate"] as const) {
      const { stack, layers } = stackOf(columns, gaps);
      expect(Array.from(layers[0]!.rows)).toEqual([0, 1, 2, 3]);
      expect(Array.from(stack.edges[1]!.top)).toEqual([11, 22, 33]);
      // The row without x is not stacked.
      expect(stack.tops[2]).toBeNaN();
    }
  });

  it("leave hidden layers out, with the x positions only they have", () => {
    const columns = {
      t: [0, 2, 1, 0, 2],
      v: [1, 3, 5, 10, 30],
      s: [..."aabcc"],
    };
    const { stack } = stackOf(columns, "zero", ["b"]);
    expect(stack.edges[1]).toBeUndefined();
    expect(Array.from(stack.edges[2]!.x)).toEqual([0, 2]);
    expect(Array.from(stack.edges[2]!.top)).toEqual([11, 33]);
    // Hiding the bottom layer leaves the next one on zero.
    const { stack: bottom } = stackOf(columns, "zero", ["a"]);
    expect(bottom.edges[1]!.bottom).toBeUndefined();
    stackOf(columns, "interpolate", ["a", "c"]);
    stackOf(columns, "interpolate", ["a", "b", "c"]);
  });

  it("stack empty tables and single rows", () => {
    stackOf({ t: [], v: [], s: [] });
    const { stack } = stackOf({ t: [5], v: [2], s: ["a"] }, "interpolate");
    expect(Array.from(stack.edges[0]!.top)).toEqual([2]);
  });

  /**
   * Rows of three series in a rolling window: in shuffled series order,
   * with a series lagging behind, rows repeated at one x, missing values,
   * and series that skip positions, so drops cut positions apart.
   */
  function stream(gaps: StackGaps, hidden: string[], maxRows = 97) {
    let seed = 7;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    let t = 0;
    const batch = (positions: number) => {
      const rows = { t: [] as number[], v: [] as number[], s: [] as string[] };
      for (let p = 0; p < positions; p++, t++) {
        for (const s of ["c", "a", "b"].sort(() => random() - 0.5)) {
          if (random() < 0.2) continue;
          const repeats = random() < 0.1 ? 2 : 1;
          for (let r = 0; r < repeats; r++) {
            // c lags three positions behind, still in order.
            rows.t.push(s === "c" ? Math.max(0, t - 3) : t);
            rows.v.push(random() < 0.05 ? Number.NaN : Math.round(random() * 20) - 2);
            rows.s.push(s);
          }
        }
      }
      return rows;
    };
    const data = table(batch(40), { maxRows });
    const stack = new UnionStack();
    const update = () => {
      const layers = layersOf(data, hidden);
      const out = stack.update(data, data.numbers("t"), data.numbers("v"), layers, gaps);
      check(data, out, layers, gaps);
      return out;
    };
    update();
    for (const positions of [1, 1, 3, 1, 10, 50, 2, 1, 1, 30, 1]) {
      data.append(batch(positions));
      update();
    }
    data.dropFirst(13);
    update();
    data.append(batch(1));
    data.append(batch(2));
    update();
    data.replace("v", 4, [7]);
    update();
  }

  for (const gaps of ["zero", "interpolate"] as const) {
    it(`stream appends and drops as a stack from scratch does (${gaps})`, () => {
      stream(gaps, []);
      stream(gaps, ["a"]);
      stream(gaps, ["b"]);
      stream(gaps, [], 400);
    });
  }

  it("give memory back as a window shrinks", () => {
    const t = Array.from({ length: 6000 }, (_, i) => Math.floor(i / 2));
    const data = table(
      { t, v: t.map((x) => x % 5), s: category(t.map((_, i) => (i % 2 ? "b" : "a"))) },
      { maxRows: 6000 },
    );
    const stack = new UnionStack();
    const update = () =>
      stack.update(data, data.numbers("t"), data.numbers("v"), layersOf(data), "zero");
    update();
    const before = stack.byteLength;
    data.dropFirst(5900);
    check(data, update(), layersOf(data), "zero");
    expect(stack.byteLength).toBeLessThan(before / 4);
  });

  it("restack only the positions changed, keeping their buffers", () => {
    const rows = (from: number, count: number) => {
      const t = Array.from({ length: count }, (_, i) => from + Math.floor(i / 2));
      return { t, v: t.map((x) => x % 7), s: t.map((_, i) => (i % 2 ? "b" : "a")) };
    };
    const data = table(rows(0, 200), { maxRows: 200 });
    const stack = new UnionStack();
    const update = () =>
      stack.update(data, data.numbers("t"), data.numbers("v"), layersOf(data), "zero");
    const before = update().edges[1]!.top.buffer;
    data.append(rows(100, 2));
    const after = update();
    check(data, after, layersOf(data), "zero");
    expect(after.edges[1]!.top.buffer).toBe(before);
  });

  it("keep a stack of rows out of x order until they change", () => {
    const data = table({ t: [2, 0, 1, 1, 0], v: [3, 1, 2, 20, 10], s: category([..."aaabb"]) });
    const stack = new UnionStack();
    const update = () =>
      stack.update(data, data.numbers("t"), data.numbers("v"), layersOf(data), "zero");
    update();
    const sort = vi.spyOn(Uint32Array.prototype, "sort");
    try {
      update();
      expect(sort).not.toHaveBeenCalled();
      data.set("v", 0, 4);
      check(data, update(), layersOf(data), "zero");
      expect(sort).toHaveBeenCalled();
    } finally {
      sort.mockRestore();
    }
  });

  it("stack again in the buffers they had, however long the union is", () => {
    // Ten layers with no x in common: the union is ten times the longest layer.
    const t = Array.from({ length: 1000 }, (_, i) => i);
    const data = table({
      t,
      v: t.map((x) => x % 7),
      s: category(t.map((x) => `s${x % 10}`)),
    });
    const stack = new UnionStack();
    const update = () =>
      stack.update(data, data.numbers("t"), data.numbers("v"), layersOf(data), "zero");
    const before = update().edges[3]!.top.buffer;
    data.set("v", 10, 100);
    const after = update();
    check(data, after, layersOf(data), "zero");
    expect(after.edges[3]!.top.buffer).toBe(before);
  });

  it("keep indexes of long stacks that agree with scanning", () => {
    const rows = (from: number, count: number) => {
      const t = Float64Array.from({ length: count * 2 }, (_, i) => from + Math.floor(i / 2));
      return {
        t,
        v: t.map((x, i) => (x % 9973 === 0 && i % 2 ? Number.NaN : 1 + Math.sin(x / 50 + (i % 2)))),
        s: Array.from(t, (_, i) => (i % 2 ? "b" : "a")),
      };
    };
    const length = INDEXED_POINTS + 1000;
    const data = table(rows(0, length), { maxRows: 2 * length });
    const stack = new UnionStack();
    const out: RangeExtremes = { low: -1, high: -1, gap: false };
    const verify = () => {
      const state = stack.update(
        data,
        data.numbers("t"),
        data.numbers("v"),
        layersOf(data),
        "zero",
      );
      for (const edges of state.edges) {
        expect(edges!.indexes).toBeDefined();
        for (const [index, values] of [
          [edges!.indexes!.top, edges!.top],
          [edges!.indexes!.bottom, edges!.bottom],
        ] as const) {
          if (!index || !values) continue;
          expect(index.length).toBe(values.length);
          for (const [from, to] of [
            [0, values.length],
            [123, 45_678],
            [values.length - 500, values.length],
          ] as const) {
            index.query(values, from, to, out);
            let min = Number.POSITIVE_INFINITY;
            let max = Number.NEGATIVE_INFINITY;
            let gap = false;
            for (let i = from; i < to; i++) {
              const v = values[i]!;
              if (!Number.isFinite(v)) gap = true;
              else [min, max] = [Math.min(min, v), Math.max(max, v)];
            }
            expect(values[out.low]).toBe(min);
            expect(values[out.high]).toBe(max);
            expect(out.gap).toBe(gap);
          }
        }
      }
    };
    verify();
    let next = length;
    for (const count of [10, 5000, 300_000]) {
      data.append(rows(next, count));
      next += count;
      verify();
    }
  });
});
