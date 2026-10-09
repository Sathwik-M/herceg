import { describe, expect, it } from "vitest";
import { category } from "../../src/data/column.ts";
import { type Schema, type Table, table } from "../../src/data/table.ts";
import { type BarLayer, PositionStack } from "../../src/marks/position-stack.ts";
import { rowsByCode } from "../../src/marks/series.ts";

/**
 * Segments worked out from their definition, position by position:
 * positive values up from zero and negative ones down, in series order
 * and then row order; written apart from PositionStack.
 */
function reference(
  positions: ArrayLike<number>,
  values: ArrayLike<number>,
  layers: readonly BarLayer[],
  bands: boolean,
) {
  const tops = new Array<number>(positions.length).fill(Number.NaN);
  const bases = new Array<number>(positions.length).fill(Number.NaN);
  const up = new Map<number, number>();
  const down = new Map<number, number>();
  for (const { rows, shown } of layers) {
    for (const row of rows) {
      const at = positions[row]!;
      if (!(bands ? at >= 0 : Number.isFinite(at))) continue;
      const value = shown ? values[row]! : 0;
      if (!Number.isFinite(value)) continue;
      const sums = value >= 0 ? up : down;
      bases[row] = sums.get(at) ?? 0;
      tops[row] = bases[row]! + value;
      sums.set(at, tops[row]!);
    }
  }
  return { tops, bases };
}

function layersOf<S extends Schema>(data: Table<S>, hidden: readonly string[] = []): BarLayer[] {
  const { codes, dictionary } = data.categories("s" as never);
  const groups = rowsByCode(codes, dictionary.length);
  return dictionary.flatMap((name, code) =>
    groups[code]!.length > 0 ? [{ name, rows: groups[code]!, shown: !hidden.includes(name) }] : [],
  );
}

function check<S extends Schema>(
  stack: PositionStack,
  data: Table<S>,
  hidden: readonly string[] = [],
  bands = false,
) {
  const layers = layersOf(data, hidden);
  const positions = data.numbers("p" as never);
  const values = data.numbers("v" as never);
  const out = stack.update(data, positions, values, layers, bands, undefined);
  const want = reference(positions, values, layers, bands);
  expect(Array.from(out.tops)).toEqual(want.tops);
  expect(Array.from(out.bases)).toEqual(want.bases);
}

describe("position stacks", () => {
  it("stack each position's rows in series order, up and down from zero", () => {
    const data = table({
      p: [0, 0, 1, 0, 1, 1, Number.NaN],
      v: [1, -2, 3, 4, Number.NaN, -5, 9],
      s: category(["b", "a", "b", "b", "a", "a", "a"]),
    });
    const stack = new PositionStack();
    const { tops, bases } = stack.update(
      data,
      data.numbers("p"),
      data.numbers("v"),
      layersOf(data),
      false,
      undefined,
    );
    // b comes first in the dictionary: its rows at 0 stack first, in row order.
    expect(Array.from(bases)).toEqual([0, 0, 0, 1, Number.NaN, 0, Number.NaN]);
    expect(Array.from(tops)).toEqual([1, -2, 3, 5, Number.NaN, -5, Number.NaN]);
    check(new PositionStack(), data);
    check(new PositionStack(), data, ["b"]);
  });

  it("stream appends and drops as a stack from scratch does", () => {
    let seed = 11;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    let p = 0;
    const batch = (positions: number) => {
      const rows = { p: [] as number[], v: [] as number[], s: [] as string[] };
      for (let i = 0; i < positions; i++, p++) {
        // Series arrive in any order, some twice, some late, some not at all.
        for (const s of ["c", "a", "b"].sort(() => random() - 0.5)) {
          if (random() < 0.15) continue;
          const repeats = random() < 0.15 ? 2 : 1;
          for (let r = 0; r < repeats; r++) {
            rows.p.push(random() < 0.2 ? Math.max(0, p - 3) : random() < 0.03 ? Number.NaN : p);
            rows.v.push(random() < 0.05 ? Number.NaN : Math.round(random() * 20) - 6);
            rows.s.push(s);
          }
        }
      }
      return rows;
    };
    for (const maxRows of [53, 300]) {
      const data = table(batch(30), { maxRows });
      const stack = new PositionStack();
      check(stack, data);
      for (const positions of [1, 1, 2, 1, 20, 100, 1, 3, 1]) {
        data.append(batch(positions));
        check(stack, data);
      }
      check(stack, data, ["a"]);
      check(stack, data);
      data.dropFirst(17);
      check(stack, data);
      data.append(batch(1));
      check(stack, data);
      data.replace("v", 2, [100]);
      check(stack, data);
      data.reset({ p: [1, 1], v: [2, 3], s: ["a", "b"] });
      check(stack, data);
    }
  });

  it("stack band indices, leaving rows without a band out", () => {
    const data = table({
      p: [0, 1, -1, 0, 1, 0],
      v: [1, 2, 3, 4, 5, 6],
      s: category(["a", "a", "a", "b", "b", "a"]),
    });
    const stack = new PositionStack();
    check(stack, data, [], true);
    data.append({ p: [1, -1, 0], v: [7, 8, 9], s: ["a", "b", "b"] });
    check(stack, data, [], true);
  });

  it("number positions again once a window leaves most of them", () => {
    const rows = (from: number, count: number) => {
      const p = Array.from({ length: count }, (_, i) => from + Math.floor(i / 2));
      return { p, v: p.map((x) => x % 5), s: p.map((_, i) => (i % 2 ? "b" : "a")) };
    };
    const data = table(rows(0, 6000), { maxRows: 6000 });
    const stack = new PositionStack();
    check(stack, data);
    const before = stack.byteLength;
    data.dropFirst(5900);
    check(stack, data);
    // The update that drops them gives the memory back, with no change after it.
    expect(stack.byteLength).toBeLessThan(before / 4);
    data.append(rows(3000, 10));
    check(stack, data);
  });
});
