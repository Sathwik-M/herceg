import { stack as d3Stack, stackOffsetWiggle, stackOrderInsideOut } from "d3-shape";
import { describe, expect, it } from "vitest";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { area } from "../../src/marks/area.ts";
import { bar } from "../../src/marks/bar.ts";
import { facet } from "../../src/model/facet.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { renderToSVG } from "../../src/render/static.ts";
import type { AreaGeometry, TextGeometry } from "../../src/scene/scene.ts";
import { loadSpec } from "../../src/spec/load.ts";
import { positionOf } from "../helpers/keyboard.ts";

function build(config: ChartConfig) {
  const model = new ChartModel({ locale: "en-US", ...config });
  model.setSize(600, 350, 1);
  return { model, scene: model.scene(estimateText) };
}
const edges = (model: ChartModel, horizontal = false) =>
  model.series().map((s) => ({
    top: Array.from(horizontal ? s.x : s.y),
    base: Array.from((horizontal ? s.x0 : s.y0)!),
  }));
function close(actual: readonly number[], expected: readonly number[]) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((v, i) => {
    if (Number.isNaN(expected[i])) expect(v).toBeNaN();
    else expect(v).toBeCloseTo(expected[i]!, 12);
  });
}
const wide = () => table({ t: [0, 1, 2], a: [2, 4, 0], b: [6, 4, 0] });

describe("normalized and stream stacks", () => {
  for (const horizontal of [false, true]) {
    it(`normalizes field areas along ${horizontal ? "y" : "x"}, keeping raw readings`, () => {
      const data = wide();
      const mark = horizontal
        ? area(data, { y: "t", x: ["a", "b"], orient: "y", stack: "fill" })
        : area(data, { x: "t", y: ["a", "b"], stack: "fill" });
      const { model } = build({ marks: [mark] });
      const [a, b] = edges(model, horizontal);
      close(a!.top, [0.25, 0.5, 0]);
      close(a!.base, [0, 0, 0]);
      close(b!.top, [1, 1, 0]);
      close(b!.base, [0.25, 0.5, 0]);
      expect((horizontal ? model.xScale() : model.yScale())!.domain).toEqual([0, 1]);
      expect(positionOf(model, model.series()[0]!.key, 0)!.points[0]).toMatchObject({
        value: 2,
        text: "0.25 share (2 raw)",
      });
      model.hidden.add(model.series()[0]!.key);
      model.scene(estimateText);
      close(edges(model, horizontal)[1]!.top, [1, 1, 0]);
    });
    it(`normalizes repeated band bars ${horizontal ? "horizontally" : "vertically"}, with share labels`, () => {
      const data = table({ band: ["N", "N", "S"], a: [2, 2, 1], b: [3, 3, 3] });
      const mark = horizontal
        ? bar(data, {
            y: "band",
            x: ["a", "b"],
            stack: "fill",
            labels: { format: { style: "percent" } },
          })
        : bar(data, {
            x: "band",
            y: ["a", "b"],
            stack: "fill",
            labels: { format: { style: "percent" } },
          });
      const { model, scene } = build({ marks: [mark] });
      const [a, b] = edges(model, horizontal);
      close(a!.top, [0.2, 0.4, 0.25]);
      close(b!.top, [0.7, 1, 1]);
      expect(
        scene.panels[0]!.marks.filter((g): g is TextGeometry => g.kind === "text").flatMap(
          (g) => g.labels,
        ),
      ).toContain("20%");
      expect(positionOf(model, model.series()[0]!.key, 0)!.points[0]).toMatchObject({
        value: 2,
        text: "0.2 share (2 raw)",
      });
      expect(renderToSVG({ width: 600, height: 350, marks: [mark] })).toContain("20%");
    });
    for (const mode of ["center", "wiggle"] as const) {
      it(`${mode} uses raw thickness along ${horizontal ? "y" : "x"}`, () => {
        const data = wide();
        const mark = horizontal
          ? area(data, { y: "t", x: ["a", "b"], orient: "y", stack: mode })
          : area(data, { x: "t", y: ["a", "b"], stack: mode });
        const { model } = build({ marks: [mark] });
        const [a, b] = edges(model, horizontal);
        // Wiggle at t=1: weighted slope=(1*4 + 1*4)/8=1.
        // At t=2 total=0, so the baseline remains -1.
        const baseline = mode === "center" ? [-4, -4, 0] : [0, -1, -1];
        close(a!.base, baseline);
        close(
          a!.top,
          baseline.map((v, i) => v + [2, 4, 0][i]!),
        );
        close(
          b!.top,
          baseline.map((v, i) => v + [8, 8, 0][i]!),
        );
        expect(positionOf(model, model.series()[0]!.key, 0)!.points[0]).toMatchObject({
          value: 2,
          text: "2",
        });
      });
    }
  }
  for (const insideOut of [false, true]) {
    it(`matches d3-shape wiggle ${insideOut ? "inside-out" : "input"} order`, () => {
      const a = [0, 1, 5, 1, 0],
        b = [3, 2, 1, 0, 0],
        c = [0, 0, 1, 2, 3];
      const rows = a.map((v, i) => ({ a: v, b: b[i]!, c: c[i]! }));
      const reference = d3Stack<{ a: number; b: number; c: number }>()
        .keys(["a", "b", "c"])
        .offset(stackOffsetWiggle);
      if (insideOut) reference.order(stackOrderInsideOut);
      const want = reference(rows);
      const { model } = build({
        marks: [
          area(table({ t: [0, 2, 5, 9, 10], a, b, c }), {
            x: "t",
            y: ["a", "b", "c"],
            stack: { offset: "wiggle", order: insideOut ? "inside-out" : "input" },
          }),
        ],
      });
      edges(model).forEach((edge, i) => {
        close(
          edge.base,
          want[i]!.map(([low]) => low),
        );
        close(
          edge.top,
          want[i]!.map(([, high]) => high),
        );
      });
      expect(model.series().map((s) => s.label)).toEqual(["a", "b", "c"]);
    });
  }
  for (const mode of ["fill", "center", "wiggle"] as const) {
    for (const gaps of ["zero", "interpolate"] as const) {
      it(`resolves long-data ${gaps} gaps before ${mode}`, () => {
        const data = table({
          t: [0, 1, 2, 0, 2],
          v: [2, 4, 6, 6, 2],
          s: ["a", "a", "a", "b", "b"],
        });
        const { model } = build({
          marks: [area(data, { x: "t", y: "v", series: "s", stack: { offset: mode, gaps } })],
        });
        const s = model.series()[1]!;
        expect(s.edges!.top[1]! - s.edges!.bottom![1]!).toBeCloseTo(
          gaps === "zero" ? 0 : mode === "fill" ? 0.5 : 4,
        );
        expect(positionOf(model, model.series()[0]!.key, 1)!.points.map((p) => p.label)).toEqual([
          "a",
        ]);
      });
    }
    it(`keeps ${mode} NaN gaps and finite layers, rejecting negatives until corrected`, () => {
      const data = table({ t: [0, 1, 2], a: [2, Number.NaN, 4], b: [2, 4, Number.NaN] });
      const { model } = build({ marks: [area(data, { x: "t", y: ["a", "b"], stack: mode })] });
      expect(model.series()[0]!.y[1]).toBeNaN();
      expect(Number.isFinite(model.series()[1]!.y[1])).toBe(true);
      data.set("a", 0, -1);
      expect(() => model.scene(estimateText)).toThrow(/negative.*stack: true/);
      expect(() => model.scene(estimateText)).toThrow(/negative.*stack: true/);
      data.set("a", 0, 2);
      expect(() => model.scene(estimateText)).not.toThrow();
    });
    it(`${mode} rolling field/union stacks match a fresh window and stay fixed under zoom`, () => {
      for (const long of [false, true]) {
        const data = table(
          { t: [0, 0, 1, 1], a: [2, 6, 3, 5], b: [6, 2, 5, 3], s: ["a", "b", "a", "b"] },
          { maxRows: 8 },
        );
        const mark = (source: typeof data) =>
          area(
            source,
            long
              ? { x: "t", y: "a", series: "s", stack: { offset: mode, gaps: "interpolate" } }
              : { x: "t", y: ["a", "b"], stack: mode },
          );
        const { model } = build({ marks: [mark(data)] });
        for (let t = 2; t < 8; t++) {
          data.append({ t: [t, t], a: [t, t + 4], b: [4, 6], s: ["a", "b"] });
          model.scene(estimateText);
          const fresh = table({
            t: Array.from(data.numbers("t")),
            a: Array.from(data.numbers("a")),
            b: Array.from(data.numbers("b")),
            s: Array.from({ length: data.length }, (_, i) => data.value("s", i) as string),
          });
          expect(edges(model)).toEqual(edges(build({ marks: [mark(fresh)] }).model));
        }
        const before = edges(model);
        model.setViewport([5, 6]);
        model.scene(estimateText);
        expect(edges(model)).toEqual(before);
        model.hidden.add(model.series()[0]!.key);
        model.scene(estimateText);
        expect(model.series()[1]!.values[0]).toBe(data.numbers(long ? "a" : "b")[0]);
      }
    });
    it(`${mode} stacks fields independently within facets`, () => {
      const data = table({
        t: [0, 1, 0, 1],
        a: [2, 4, 4, 2],
        b: [6, 4, 4, 6],
        panel: ["N", "N", "S", "S"],
      });
      const { model } = build({
        marks: [area(data, { x: "t", y: ["a", "b"], stack: mode })],
        facet: facet("panel"),
      });
      model.parts(model.series()[0]!).forEach((part, panel) => {
        const start = panel * 2;
        const fresh = build({
          marks: [
            area(
              table({
                t: [0, 1],
                a: [2, 4, 4, 2].slice(start, start + 2),
                b: [6, 4, 4, 6].slice(start, start + 2),
              }),
              { x: "t", y: ["a", "b"], stack: mode },
            ),
          ],
        }).model.series()[0]!;
        close(Array.from(part.y).slice(start, start + 2), Array.from(fresh.y));
      });
    });
  }
  it("ignores missing positions in wiggle and preserves tiny normalized contributions", () => {
    const { model } = build({
      marks: [
        area(table({ t: [0, Number.NaN, 1], a: [2, 999, 4], b: [6, 999, 4] }), {
          x: "t",
          y: ["a", "b"],
          stack: "wiggle",
        }),
      ],
    });
    expect(model.series()[0]!.y0![2]).toBeCloseTo(-1);
    const tiny = build({
      marks: [area(table({ t: [0], a: [1e16], b: [1] }), { x: "t", y: ["b", "a"], stack: "fill" })],
    }).model.series()[0]!;
    expect(tiny.y[0]).toBeGreaterThan(0);
    expect(tiny.y[0]).toBeCloseTo(1e-16, 25);
    const tinyAfter = build({
      marks: [area(table({ t: [0], a: [1e16], b: [1] }), { x: "t", y: ["a", "b"], stack: "fill" })],
    }).model;
    expect(
      positionOf(tinyAfter, tinyAfter.series()[1]!.key, 0)!.points.find((p) => p.label === "b")!
        .text,
    ).toContain("0.0000000000000001 share (1 raw)");
    const huge = build({
      marks: [
        area(table({ t: [0, 1], a: [1e200, 2e200], b: [3e200, 2e200] }), {
          x: "t",
          y: ["a", "b"],
          stack: "wiggle",
        }),
      ],
    }).model;
    expect(Number.isFinite(huge.series()[0]!.y0![1]!)).toBe(true);
  });

  it("retries overflowing normalized stacks and recovers after correction", () => {
    const data = table({ t: [0], a: [1e308], b: [1e308] });
    const model = new ChartModel({ marks: [area(data, { x: "t", y: ["a", "b"], stack: "fill" })] });
    model.setSize(600, 350, 1);
    expect(() => model.scene(estimateText)).toThrow(/total.*rescale/);
    expect(() => model.scene(estimateText)).toThrow(/total.*rescale/);
    data.set("b", 0, 0);
    expect(() => model.scene(estimateText)).not.toThrow();
  });

  it("rolling position-normalized bars restack their affected positions", () => {
    const data = table(
      { band: ["N", "N", "S", "S"], value: [2, 6, 4, 4], group: ["a", "b", "a", "b"] },
      { maxRows: 6 },
    );
    const mark = (source: typeof data) =>
      bar(source, { x: "band", y: "value", series: "group", stack: "fill" });
    const { model } = build({ marks: [mark(data)] });
    for (let i = 1; i < 6; i++) {
      data.append({ band: ["N", "N"], value: [i, i + 2], group: ["a", "b"] });
      model.scene(estimateText);
      const fresh = table({
        band: Array.from({ length: data.length }, (_, r) => data.value("band", r) as string),
        value: Array.from(data.numbers("value")),
        group: Array.from({ length: data.length }, (_, r) => data.value("group", r) as string),
      });
      expect(edges(model)).toEqual(edges(build({ marks: [mark(fresh)] }).model));
    }
    model.hidden.add(model.series()[0]!.key);
    model.scene(estimateText);
    expect(positionOf(model, model.series()[1]!.key, 0)!.points[0]!.text).toContain("raw");
  });

  it("long inside-out curves share boundaries in geometric order", () => {
    const { scene } = build({
      marks: [
        area(
          table({
            t: [0, 1, 2, 0, 1, 2, 0, 1, 2],
            v: [0, 2, 0, 3, 2, 0, 0, 1, 4],
            s: ["a", "a", "a", "b", "b", "b", "c", "c", "c"],
          }),
          {
            x: "t",
            y: "v",
            series: "s",
            stack: { offset: "wiggle", order: "inside-out" },
            curve: "monotone",
          },
        ),
      ],
    });
    const layers = scene.panels[0]!.marks.filter((g): g is AreaGeometry => g.kind === "area");
    for (let i = 1; i < layers.length; i++)
      expect(Array.from(layers[i]!.lower!.coords)).toEqual(Array.from(layers[i - 1]!.upper.coords));
  });

  it("loads each portable stack and rejects unsupported bars with a correction", () => {
    for (const mode of ["fill", "center", "wiggle"] as const) {
      const spec = {
        data: { t: { columns: { t: [0, 1], a: [2, 4], b: [6, 4] } } },
        marks: [{ type: "area" as const, x: "t", y: ["a", "b"], stack: mode }],
      };
      expect(build(loadSpec(spec).config).model.series()[0]!.values[0]).toBe(2);
    }
    expect(() => bar(wide(), { x: "t", y: "a", stack: "wiggle" } as never)).toThrow(
      /bar stack:.*; use an area/,
    );
    expect(() =>
      loadSpec({
        data: { t: { columns: { t: [0], a: [1] } } },
        marks: [{ type: "bar", x: "t", y: "a", stack: "center" }],
      } as never),
    ).toThrow(/stack:.*; use an area/);
    expect(() => area(wide(), { x: "t", y: "a", stack: { order: "inside-out" } })).toThrow(
      'area stack.order: inside-out order needs shares or a stream; give offset: "fill", "center", or "wiggle"',
    );
    expect(() =>
      loadSpec({
        data: { t: { columns: { t: [0], a: [1] } } },
        marks: [{ type: "area", x: "t", y: "a", stack: { offset: "fill", order: "ascending" } }],
      } as never),
    ).toThrow(/stack\.order: expected "input" or "inside-out"/);
  });
});
