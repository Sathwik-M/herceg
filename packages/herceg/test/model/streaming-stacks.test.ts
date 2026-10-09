// Stacked areas and bars over streaming tables: stacks kept current row by
// row must draw what a chart built from the same rows draws.
import { describe, expect, it } from "vitest";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { area } from "../../src/marks/area.ts";
import { bar } from "../../src/marks/bar.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";

function rows(from: number, count: number) {
  const t = Array.from({ length: count }, (_, i) => from + i);
  const wave = (phase: number) =>
    t.map((x) => (x % 13 === 0 ? Number.NaN : Math.sin(x / 5 + phase) * 4 + (phase > 1 ? -1 : 2)));
  return { t, a: wave(0), b: wave(1), c: wave(2) };
}

function seriesOf(config: ChartConfig, hidden: string[] = []) {
  const model = new ChartModel({ locale: "en-US", ...config });
  for (const key of hidden) model.hidden.add(key);
  model.setSize(600, 300, 1);
  model.scene(estimateText);
  return { model, series: model.series().map((s) => [Array.from(s.y), s.y0 && Array.from(s.y0)]) };
}

describe("stacks over streaming tables", () => {
  for (const [name, mark] of [
    [
      "areas",
      (data: unknown) => area(data as never, { x: "t", y: ["a", "b", "c"] as never, stack: true }),
    ],
    [
      "bars",
      (data: unknown) => bar(data as never, { x: "t", y: ["a", "b", "c"] as never, stack: true }),
    ],
  ] as const) {
    it(`draw stacked ${name} as a chart of the same rows does`, () => {
      const data = table(rows(0, 50), { maxRows: 120 });
      const streaming = new ChartModel({ locale: "en-US", marks: [mark(data)] });
      streaming.setSize(600, 300, 1);
      let next = 50;
      for (const count of [1, 30, 90, 200, 2]) {
        data.append(rows(next, count));
        next += count;
        streaming.scene(estimateText);
        const snapshot = table({
          t: Array.from(data.numbers("t")),
          a: Array.from(data.numbers("a")),
          b: Array.from(data.numbers("b")),
          c: Array.from(data.numbers("c")),
        });
        const fresh = seriesOf({ marks: [mark(snapshot)] }).series;
        const now = streaming.series().map((s) => [Array.from(s.y), s.y0 && Array.from(s.y0)]);
        expect(now).toEqual(fresh);
      }
      // Hiding a layer restacks the others.
      const key = streaming.series()[1]!.key;
      streaming.hidden.add(key);
      streaming.scene(estimateText);
      const top = Array.from(streaming.series()[2]!.y);
      const snapshot = table({
        t: Array.from(data.numbers("t")),
        a: Array.from(data.numbers("a")),
        b: Array.from(data.numbers("b")),
        c: Array.from(data.numbers("c")),
      });
      const fresh = seriesOf({ marks: [mark(snapshot)] }, [key]).series;
      expect(top).toEqual(fresh[2]![0]);
    });
  }

  it("switch bars to stacking by position when a position repeats", () => {
    const data = table({ t: [0, 1, 2], a: [1, 2, 3], b: [4, 5, 6] });
    const model = new ChartModel({ marks: [bar(data, { x: "t", y: ["a", "b"], stack: true })] });
    model.setSize(600, 300, 1);
    model.scene(estimateText);
    data.append({ t: [2, 3], a: [10, 20], b: [1, 2] });
    model.scene(estimateText);
    const [, second] = model.series();
    // The two rows at 2 stack on each other.
    expect(Array.from(second!.y0!)).toEqual([1, 2, 13, 19, 20]);
    expect(Array.from(second!.y)).toEqual([5, 7, 19, 20, 22]);
  });

  it("check positions again when they change in place", () => {
    const data = table({ t: [0, 1, 2], a: [1, 2, 3], b: [4, 5, 6] });
    const model = new ChartModel({ marks: [bar(data, { x: "t", y: ["a", "b"], stack: true })] });
    model.setSize(600, 300, 1);
    model.scene(estimateText);
    data.replace("t", 2, [1]);
    model.scene(estimateText);
    // The rows at 1 now stack on each other.
    expect(Array.from(model.series()[1]!.y)).toEqual([5, 10, 16]);
  });

  it("draw long indexed stacks as a chart of the same rows does", () => {
    const length = 300_000;
    const make = (n: number, from: number) => {
      const t = Float64Array.from({ length: n }, (_, i) => from + i);
      return { t, a: t.map((x) => 2 + Math.sin(x / 700)), b: t.map((x) => 3 + Math.cos(x / 900)) };
    };
    const data = table(make(length, 0), { maxRows: length });
    const geometry = (model: ChartModel) =>
      model.scene(estimateText).panels[0]!.marks.map((mark) => {
        const area = mark as unknown as { upper: { coords: Float32Array; count: number } };
        return Array.from(area.upper.coords.subarray(0, area.upper.count * 2));
      });
    const mark = (t: unknown) => area(t as never, { x: "t", y: ["a", "b"] as never, stack: true });
    const streaming = new ChartModel({ marks: [mark(data)] });
    streaming.setSize(600, 300, 1);
    geometry(streaming);
    data.append(make(20_000, length));
    for (const range of [null, [100_000, 101_000]] as const) {
      streaming.setViewport(range);
      const fresh = new ChartModel({
        marks: [
          mark(
            table({
              t: data.numbers("t").slice(),
              a: data.numbers("a").slice(),
              b: data.numbers("b").slice(),
            }),
          ),
        ],
      });
      fresh.setSize(600, 300, 1);
      fresh.setViewport(range);
      expect(geometry(streaming)).toEqual(geometry(fresh));
    }
  });

  it("stack bars by position when positions repeat", () => {
    const data = table({ t: [0, 0, 1], a: [1, 2, 3], b: [4, 5, 6] });
    const { model } = seriesOf({ marks: [bar(data, { x: "t", y: ["a", "b"], stack: true })] });
    // Rows at the same position stack on each other, as before.
    const [first, second] = model.series();
    expect(Array.from(first!.y)).toEqual([1, 3, 3]);
    expect(Array.from(second!.y0!)).toEqual([3, 7, 3]);
    expect(Array.from(second!.y)).toEqual([7, 12, 9]);
  });
});
