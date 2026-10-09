import { describe, expect, it } from "vitest";
import { table } from "../../src/data/table.ts";
import type { RangeExtremes } from "../../src/lod/minmax-index.ts";
import { RowStack, type StackedLayers, type StackKind } from "../../src/marks/stack.ts";
import { INDEXED_POINTS } from "../../src/marks/trace.ts";

/** The stack computed directly from the values, row by row. */
function expected(kind: StackKind, layers: (number[] | undefined)[], length: number) {
  const tops = layers.map(() => new Array<number>(length));
  const bases = layers.map(() => new Array<number>(length));
  for (let row = 0; row < length; row++) {
    let up = 0;
    let down = 0;
    layers.forEach((values, l) => {
      const value = values ? values[row]! : 0;
      if (!Number.isFinite(value)) {
        tops[l]![row] = Number.NaN;
        bases[l]![row] = kind === "signed" ? Number.NaN : up;
      } else if (kind === "signed" && value < 0) {
        bases[l]![row] = down;
        down += value;
        tops[l]![row] = down;
      } else {
        bases[l]![row] = up;
        up += value;
        tops[l]![row] = up;
      }
    });
  }
  return { tops, bases };
}

function check(kind: StackKind, stack: StackedLayers, layers: (number[] | undefined)[]) {
  const length = stack.tops[0]!.length;
  const want = expected(kind, layers, length);
  stack.tops.forEach((top, l) => {
    expect(Array.from(top)).toEqual(want.tops[l]);
  });
  stack.bases.forEach((base, l) => {
    if (kind === "sum" && l === 0) expect(base).toBeUndefined();
    else expect(Array.from(base!)).toEqual(want.bases[l]);
  });
}

describe("row stacks", () => {
  for (const kind of ["sum", "signed"] as const) {
    it(`stay equal to a fresh ${kind} stack through appends, drops, and changes`, () => {
      let next = 0;
      const value = (layer: number) => {
        const i = next + layer;
        // Missing and negative values here and there.
        return i % 17 === 0 ? Number.NaN : i % 5 === 0 ? -(i % 7) : (i % 11) + 0.5;
      };
      const rows = (count: number) => {
        const batch = { a: [] as number[], b: [] as number[], c: [] as number[] };
        for (let k = 0; k < count; k++, next++) {
          batch.a.push(value(0));
          batch.b.push(value(1));
          batch.c.push(value(2));
        }
        return batch;
      };
      const data = table(rows(40), { maxRows: 100 });
      const stack = new RowStack(kind);
      const layersOf = (shown = [true, true, true]) =>
        (["a", "b", "c"] as const).map((field, l) => (shown[l] ? data.numbers(field) : undefined));
      const asArrays = (shown = [true, true, true]) =>
        layersOf(shown).map((values) => (values ? Array.from(values) : undefined));
      const update = (shown = [true, true, true]) =>
        stack.update(data, layersOf(shown), shown.map(Number).join(""));

      check(kind, update(), asArrays());
      // Appends past the window drop rows from the front; one batch is larger than the window.
      for (const count of [1, 7, 30, 64, 150, 3]) {
        data.append(rows(count));
        check(kind, update(), asArrays());
      }
      data.dropFirst(20);
      check(kind, update(), asArrays());
      // Values replaced in place, a hidden layer, and a reset rebuild.
      data.replace("b", 3, [1, 2, 3]);
      check(kind, update(), asArrays());
      check(kind, update([true, false, true]), asArrays([true, false, true]));
      check(kind, update(), asArrays());
      data.reset({ a: [1, -2], b: [Number.NaN, 4], c: [5, 6] });
      check(kind, update(), asArrays());
      data.reset({ a: [], b: [], c: [] });
      check(kind, update(), asArrays());
      data.append(rows(5));
      check(kind, update(), asArrays());
    });
  }

  it("keep indexes of long stacks that agree with scanning", () => {
    const length = INDEXED_POINTS + 1000;
    const wave = (n: number, phase: number) =>
      Float64Array.from({ length: n }, (_, i) =>
        i % 9973 === 0 ? Number.NaN : 1 + Math.sin(i / 50 + phase),
      );
    const data = table({ a: wave(length, 0), b: wave(length, 1) }, { maxRows: length });
    const stack = new RowStack("sum", { indexed: true });
    const layers = () => [data.numbers("a"), data.numbers("b")];
    let state = stack.update(data, layers(), "11");
    const out: RangeExtremes = { low: -1, high: -1, gap: false };
    const verify = () => {
      expect(state.indexes).toBeDefined();
      for (const [l, { top, bottom }] of state.indexes!.entries()) {
        for (const [edge, values] of [
          [top, state.tops[l]!],
          [bottom, state.bases[l]],
        ] as const) {
          if (!edge || !values) continue;
          expect(edge.length).toBe(values.length);
          for (const [from, to] of [
            [0, values.length],
            [123, 45_678],
            [values.length - 500, values.length],
          ] as const) {
            edge.query(values, from, to, out);
            let min = Number.POSITIVE_INFINITY;
            let max = Number.NEGATIVE_INFINITY;
            let gap = false;
            for (let i = from; i < to; i++) {
              const v = values[i]!;
              if (!Number.isFinite(v)) gap = true;
              else {
                min = Math.min(min, v);
                max = Math.max(max, v);
              }
            }
            expect(values[out.low]).toBe(min);
            expect(values[out.high]).toBe(max);
            expect(out.gap).toBe(gap);
          }
        }
      }
    };
    verify();
    // Stacks that do not ask for indexes get none.
    expect(new RowStack("sum").update(data, layers(), "11").indexes).toBeUndefined();
    // Appends that drop rows from the front, then enough to move the buffers.
    for (const count of [10, 5000, 100_000, 200_000]) {
      data.append({ a: wave(count, 2), b: wave(count, 3) });
      state = stack.update(data, layers(), "11");
      verify();
    }
  });
});
