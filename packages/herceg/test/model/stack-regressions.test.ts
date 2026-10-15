import { stack as d3Stack, stackOffsetWiggle, stackOrderInsideOut } from "d3-shape";
import { expect, it, vi } from "vitest";
import type { NumericArray } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { area } from "../../src/marks/area.ts";
import { bar } from "../../src/marks/bar.ts";
import { RowStack } from "../../src/marks/stack.ts";
import { offsetLayers } from "../../src/marks/stack-offset.ts";
import { facet } from "../../src/model/facet.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { positionOf } from "../helpers/keyboard.ts";

function build(config: ChartConfig) {
  const model = new ChartModel({ locale: "en-US", ...config });
  model.setSize(600, 350, 1);
  model.scene(estimateText);
  return model;
}
function boundaries(model: ChartModel, horizontal = false) {
  return model
    .series()
    .filter((s) => s.label === "a" || s.label === "b")
    .map((s) => ({
      top: Array.from(horizontal ? s.x : s.y),
      base: Array.from((horizontal ? s.x0 : s.y0)!),
      order: s.stackIndex ?? s.edges?.order,
      edges: s.edges && { top: Array.from(s.edges.top), base: Array.from(s.edges.bottom!) },
    }));
}

for (const stack of ["center", "wiggle"] as const) {
  for (const axis of ["x", "y", "yRight"] as const) {
    for (const format of [
      { style: "unit", unit: "millisecond" } as const,
      { style: "currency", currency: "USD" } as const,
    ]) {
      it(`${stack} readings honor ${format.style} formatting on ${axis}`, () => {
        const data = table({ t: [0, 1], a: [2, 4], b: [6, 4] });
        const mark =
          axis === "x"
            ? area(data, { y: "t", x: ["a", "b"], orient: "y", stack })
            : area(data, {
                x: "t",
                y: ["a", "b"],
                axis: axis === "yRight" ? "right" : "left",
                stack,
              });
        const model = build({ marks: [mark], [axis]: { tooltipFormat: format } });
        expect(positionOf(model, model.series()[0]!.key, 0)!.points.map((p) => p.text)).toEqual(
          format.style === "unit" ? ["2 ms", "6 ms"] : ["$2.00", "$6.00"],
        );
      });
    }
  }
}

for (const horizontal of [false, true]) {
  for (const stack of ["fill", "center"] as const) {
    it(`${stack} appends mask missing positions along ${horizontal ? "y" : "x"} through rolling drops`, () => {
      const data = table({ t: [0, 1], a: [2, 4], b: [6, 4] }, { maxRows: 4 });
      const mark = (source: typeof data) =>
        horizontal
          ? area(source, { y: "t", x: ["a", "b"], orient: "y", stack })
          : area(source, { x: "t", y: ["a", "b"], stack });
      const model = build({ marks: [mark(data)] });
      for (const t of [Number.NaN, Infinity, -Infinity, 2, 3, 4]) {
        data.append({
          t: [t],
          a: [Number.isFinite(t) ? 2 : 1000],
          b: [Number.isFinite(t) ? 6 : 1000],
        });
        model.scene(estimateText);
        const fresh = build({
          marks: [
            mark(table({ t: data.numbers("t"), a: data.numbers("a"), b: data.numbers("b") })),
          ],
        });
        expect(boundaries(model, horizontal)).toEqual(boundaries(fresh, horizontal));
        expect((horizontal ? model.xScale() : model.yScale())!.domain).toEqual(
          (horizontal ? fresh.xScale() : fresh.yScale())!.domain,
        );
      }
    });
  }
  for (const long of [false, true]) {
    for (const stackOrder of ["input", "inside-out"] as const) {
      it(`reused ${long ? "union" : "field"} wiggle stacks follow category order along ${horizontal ? "y" : "x"} (${stackOrder})`, () => {
        const data = table({
          t: ["A", "B", "C", "A", "B", "C"],
          a: [2, 4, 3, 6, 4, 5],
          b: [6, 4, 5, 2, 4, 3],
          s: ["a", "a", "a", "b", "b", "b"],
        });
        const make = () =>
          horizontal
            ? area(data, {
                id: "stream",
                y: "t",
                x: long ? "a" : ["a", "b"],
                ...(long ? { series: "s" as const } : {}),
                stack: { offset: "wiggle", order: stackOrder },
              })
            : area(data, {
                id: "stream",
                x: "t",
                y: long ? "a" : ["a", "b"],
                ...(long ? { series: "s" as const } : {}),
                stack: { offset: "wiggle", order: stackOrder },
              });
        const mark = make();
        build({ marks: [mark] });
        const prefixData = table({ t: ["C", "B", "A"], v: [0, 0, 0] });
        const prefix = horizontal
          ? bar(prefixData, { y: "t", x: "v" })
          : bar(prefixData, { x: "t", y: "v" });
        const reused = build({ marks: [prefix, mark] });
        const fresh = build({ marks: [prefix, make()] });
        expect(boundaries(reused, horizontal)).toEqual(boundaries(fresh, horizontal));
      });
    }
  }
}

it("category cache validity preserves row append fast paths", () => {
  const data = table({ t: [0, 1], a: [2, 4], b: [6, 4] });
  const resolve = vi.fn(
    (
      tops: readonly Float64Array[],
      bases: readonly Float64Array[],
      positions?: NumericArray,
      totals?: Float64Array,
    ) => offsetLayers(tops, bases, "center", "input", positions, totals),
  );
  const stack = new RowStack("sum", { offset: { resolve } });
  const places = ["A", "B", "C"];
  const update = (mapping = places) =>
    stack.update(data, [data.numbers("a"), data.numbers("b")], "11", data.numbers("t"), mapping);
  const first = update();
  update();
  expect(resolve).toHaveBeenCalledTimes(1);
  data.append({ t: [2], a: [3], b: [5] });
  const appended = update();
  expect(resolve.mock.calls[1]![0][0]).toHaveLength(1);
  expect(appended.tops[0]!.buffer).toBe(first.tops[0]!.buffer);
  update(["C", "B", "A"]);
  expect(resolve.mock.calls[2]![0][0]).toHaveLength(3);
});

for (const stack of ["fill", "center", "wiggle"] as const) {
  it(`caches ${stack} facet field stacks and retains buffers after edits and visibility changes`, () => {
    const data = table({
      t: [0, 1, 0, 1],
      a: [2, 4, 4, 2],
      b: [6, 4, 4, 6],
      p: ["N", "N", "S", "S"],
    });
    const mark = area(data, { x: "t", y: ["a", "b"], stack });
    const model = build({ marks: [mark], facet: facet("p") });
    const parts = () => model.panels().map((panel) => model.panelSeries(panel.key));
    const top = parts()[0]![0]!.y;
    const base = parts()[0]![0]!.y0;
    const totals = parts()[0]![0]!.stackTotals;
    model.setSize(650, 400, 1);
    model.setViewport([0.2, 0.8]);
    model.scene(estimateText);
    expect(parts()[0]![0]!.y).toBe(top);
    expect(parts()[0]![0]!.y0).toBe(base);
    expect(parts()[0]![0]!.stackTotals).toBe(totals);
    data.set("a", 1, 8);
    model.scene(estimateText);
    expect(parts()[0]![0]!.y).toBe(top);
    model.hidden.add(model.series()[0]!.key);
    model.scene(estimateText);
    expect(parts()[0]![0]!.y).toBe(top);
    const fresh = build({
      marks: [area(data, { x: "t", y: ["a", "b"], stack })],
      facet: facet("p"),
    });
    fresh.hidden.add(fresh.series()[0]!.key);
    fresh.scene(estimateText);
    for (let p = 0; p < parts().length; p++) {
      expect(Array.from(parts()[p]![1]!.y)).toEqual(
        Array.from(fresh.panelSeries(fresh.panels()[p]!.key)[1]!.y),
      );
    }
    const saved = Array.from(top);
    const another = build({ marks: [mark], facet: facet("p") });
    expect(another.panelSeries(another.panels()[0]!.key)[0]!.y).not.toBe(top);
    expect(Array.from(top)).toEqual(saved);
  });
  for (const long of [false, true]) {
    it(`${stack} inside-out rolling ${long ? "union" : "field"} stacks reorder when a peak leaves`, () => {
      const a = [100, 0, 1, 5],
        b = [0, 4, 0, 0];
      const data = table(
        {
          t: long ? [0, 0, 1, 1, 2, 2, 3, 3] : [0, 1, 2, 3],
          a: long ? a.flatMap((v, i) => [v, b[i]!]) : a,
          b: long ? b.flatMap((v) => [v, v]) : b,
          s: long ? ["a", "b", "a", "b", "a", "b", "a", "b"] : ["a", "a", "a", "a"],
        },
        { maxRows: long ? 8 : 4 },
      );
      const make = (source: typeof data) =>
        area(source, {
          x: "t",
          y: long ? "a" : ["a", "b"],
          ...(long ? { series: "s" as const } : {}),
          stack: { offset: stack, order: "inside-out" },
        });
      const model = build({ marks: [make(data)] });
      expect(boundaries(model).map((s) => s.order)).toEqual([0, 1]);
      for (let t = 4; t < 8; t++) {
        data.append(
          long
            ? { t: [t, t], a: [2, 0], b: [0, 0], s: ["a", "b"] }
            : { t: [t], a: [2], b: [0], s: ["a"] },
        );
        model.scene(estimateText);
        const fresh = table({
          t: data.numbers("t"),
          a: data.numbers("a"),
          b: data.numbers("b"),
          s: Array.from({ length: data.length }, (_, row) => data.value("s", row) as string),
        });
        expect(boundaries(model)).toEqual(boundaries(build({ marks: [make(fresh)] })));
        if (t === 4) expect(boundaries(model).map((s) => s.order)).toEqual([1, 0]);
      }
    });
  }
}

for (const horizontal of [false, true]) {
  for (const stack of ["fill", "center", "wiggle"] as const) {
    it(`${stack} inside-out facets offset only their interleaved rows along ${horizontal ? "y" : "x"}`, () => {
      const input = {
        t: [0, 2, 0, 0, 1, 1],
        a: [0, 0, 5, 5, 0, 0],
        b: [5, 0, 0, 0, 0, 5],
        p: ["N", "S", "N", "S", "N", "S"],
      };
      const data = table(input);
      const make = (source: typeof data) =>
        horizontal
          ? area(source, {
              y: "t",
              x: ["a", "b"],
              orient: "y",
              stack: { offset: stack, order: "inside-out" },
            })
          : area(source, { x: "t", y: ["a", "b"], stack: { offset: stack, order: "inside-out" } });
      const model = build({ marks: [make(data)], facet: facet("p") });
      for (const panel of model.panels()) {
        const parts = model.panelSeries(panel.key);
        const rows = Array.from(parts[0]!.rows!);
        const fresh = build({
          marks: [
            make(
              table({
                t: rows.map((r) => input.t[r]!),
                a: rows.map((r) => input.a[r]!),
                b: rows.map((r) => input.b[r]!),
                p: rows.map((r) => input.p[r]!),
              }),
            ),
          ],
        });
        for (const [l, part] of parts.entries()) {
          expect(part.stackIndex).toBe(fresh.series()[l]!.stackIndex);
          const top = horizontal ? part.x : part.y;
          const base = (horizontal ? part.x0 : part.y0)!;
          expect(rows.map((r) => top[r])).toEqual(boundaries(fresh, horizontal)[l]!.top);
          expect(rows.map((r) => base[r])).toEqual(boundaries(fresh, horizontal)[l]!.base);
        }
      }
    });
  }
}

for (const t of [
  [0, 0, 1],
  [1, 0, 0],
]) {
  it(`inside-out preserves chronological occurrence order for tied peaks at ${t}`, () => {
    const a = t[0] === 0 ? [0, 5, 0] : [0, 0, 5];
    const b = t[0] === 0 ? [5, 0, 0] : [0, 5, 0];
    const model = build({
      marks: [
        area(table({ t, a, b }), {
          x: "t",
          y: ["a", "b"],
          stack: { offset: "wiggle", order: "inside-out" },
        }),
      ],
    });
    const rows = t.map((_, i) => i).sort((i, j) => t[i]! - t[j]! || i - j);
    const reference = d3Stack<{ a: number; b: number }>()
      .keys(["a", "b"])
      .order(stackOrderInsideOut)
      .offset(stackOffsetWiggle)(rows.map((i) => ({ a: a[i]!, b: b[i]! })));
    for (const [l, s] of model.series().entries()) {
      expect(s.stackIndex).toBe(reference[l]!.index);
      rows.forEach((row, i) => {
        expect(s.y0![row]).toBeCloseTo(reference[l]![i]![0]);
        expect(s.y[row]).toBeCloseTo(reference[l]![i]![1]);
      });
    }
  });
}

for (const long of [false, true]) {
  it(`rejects overflowing wiggle boundaries with finite totals in ${long ? "union" : "field"} stacks and recovers`, () => {
    const a = [1e308, 0, 0, 1e308, 0],
      b = [0, 1e308, 1e307, 0, 1e308];
    const data = table({
      t: long ? [0, 0, 1, 1, 2, 2, 3, 3, 4, 4] : [0, 1, 2, 3, 4],
      a: long ? a.flatMap((v, i) => [v, b[i]!]) : a,
      b: long ? b.flatMap((v) => [v, v]) : b,
      s: long ? ["a", "b", "a", "b", "a", "b", "a", "b", "a", "b"] : ["a", "a", "a", "a", "a"],
    });
    const model = new ChartModel({
      marks: [
        area(data, {
          x: "t",
          y: long ? "a" : ["a", "b"],
          ...(long ? { series: "s" as const } : {}),
          stack: "wiggle",
        }),
      ],
    });
    model.setSize(600, 350, 1);
    for (let attempt = 0; attempt < 2; attempt++)
      expect(() => model.scene(estimateText)).toThrow(/boundary.*rescale the values/);
    data.set(long ? "a" : "b", long ? 9 : 4, 0);
    expect(() => model.scene(estimateText)).not.toThrow();
  });
}
