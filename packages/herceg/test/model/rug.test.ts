import { describe, expect, it, vi } from "vitest";
import { time } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { line } from "../../src/marks/line.ts";
import { point } from "../../src/marks/point.ts";
import { type RugMark, rug } from "../../src/marks/rug.ts";
import { describeChart } from "../../src/model/describe.ts";
import { facet } from "../../src/model/facet.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { panels } from "../../src/model/panels.ts";
import { renderToSVG } from "../../src/render/static.ts";
import { timeBreaks } from "../../src/scale/breaks.ts";
import type { Scene, SegmentGeometry } from "../../src/scene/scene.ts";
import { loadSpec } from "../../src/spec/load.ts";
import { validateSpec } from "../../src/spec/validate.ts";
import { legendOf } from "../helpers/guides.ts";

function build(config: ChartConfig) {
  const model = new ChartModel({ locale: "en-US", timeZone: "UTC", ...config });
  model.setSize(600, 300, 2);
  return { model, scene: model.scene(estimateText) };
}
const ticks = (scene: Scene, panel = 0) =>
  scene.panels[panel]!.marks.filter((m): m is SegmentGeometry => m.kind === "segments");
const endpoints = (g: SegmentGeometry, i = 0) => Array.from(g.coords.subarray(i * 4, i * 4 + 4));
const observations = table({ v: [3, 1, 2, 2], g: ["a", "a", "b", "b"] });

describe("rug", () => {
  it.each(["bottom", "top", "left", "right"] as const)(
    "draws inward from %s through zoom",
    (side) => {
      const alongX = side === "bottom" || side === "top";
      const mark = alongX
        ? rug(observations, { x: "v", side, length: 12 })
        : rug(observations, { y: "v", side, length: 12 });
      const { model, scene } = build({
        marks: [mark],
        x: { domain: [0, 4] },
        y: { domain: [0, 4] },
      });
      const check = (drawn: Scene) => {
        const { plot } = drawn.panels[0]!;
        const [x1, y1, x2, y2] = endpoints(ticks(drawn)[0]!);
        const value = alongX ? model.xScale()!.map(1) : model.yScale()!.map(1);
        const edge =
          side === "bottom"
            ? plot.y + plot.height
            : side === "top"
              ? plot.y
              : side === "right"
                ? plot.x + plot.width
                : plot.x;
        if (alongX) {
          expect(x1).toBeCloseTo(value, 3);
          expect(x2).toBeCloseTo(value, 3);
          expect(y1).toBeCloseTo(edge, 3);
          expect(y2).toBeCloseTo(edge + (side === "bottom" ? -12 : 12), 3);
        } else {
          expect(y1).toBeCloseTo(value, 3);
          expect(y2).toBeCloseTo(value, 3);
          expect(x1).toBeCloseTo(edge, 3);
          expect(x2).toBeCloseTo(edge + (side === "right" ? -12 : 12), 3);
        }
      };
      check(scene);
      model.setViewport([0.5, 2.5]);
      model.setYViewport({ y: [0.5, 2.5], yRight: null });
      const zoom = model.scene(estimateText);
      expect(ticks(zoom)[0]!.count).toBe(3);
      check(zoom);
    },
  );

  it.each(["x", "y"] as const)("widens only %s, with a usable other domain", (axis) => {
    const t = table({ v: [100, 200] });
    const { model } = build({ marks: [axis === "x" ? rug(t, { x: "v" }) : rug(t, { y: "v" })] });
    const own = axis === "x" ? model.xScale()! : model.yScale()!;
    const other = axis === "x" ? model.yScale()! : model.xScale()!;
    expect(own.domain[0]).toBeLessThanOrEqual(100);
    expect(own.domain[1]).toBeGreaterThanOrEqual(200);
    expect(other.domain[1]).toBeLessThan(10);
    expect(other.domain[1]).toBeGreaterThan(other.domain[0]);
  });

  it("leaves companion domains alone, including log and category axes", () => {
    const t = table({ x: [1, 2], y: [100, 200], c: ["a", "b"] });
    for (const y of ["y", "c"] as const) {
      const marks = [point(t, { x: "x", y })];
      const config: ChartConfig = {
        marks,
        legend: false,
        ...(y === "y" ? { y: { type: "log" } } : {}),
      };
      const before = build(config).model.yScale()!;
      const { model } = build({ ...config, marks: [...marks, rug(t, { x: "x" })] });
      expect(model.yScale()!.domain).toEqual(before.domain);
      expect(model.inspectPosition(model.series().at(-1)!.key, 0)!.points.at(-1)!.text).toBe("1");
    }
    const withY = build({ marks: [rug(t, { y: "y" })], x: { type: "log", domain: [1000, 2000] } });
    expect(withY.model.inspectPosition(withY.model.series()[0]!.key, 0)!.points[0]!.text).toBe(
      "100",
    );
  });

  it.each(["x", "y"] as const)("skips missing, infinite and log-invalid %s values", (axis) => {
    const t = table({ v: [null, Number.NaN, Infinity, -Infinity, -2, 0, 1, 10] });
    const mark = axis === "x" ? rug(t, { x: "v" }) : rug(t, { y: "v" });
    const linear = build({ marks: [mark] });
    expect(ticks(linear.scene)[0]!.count).toBe(4);
    const logged = build({ marks: [mark], [axis]: { type: "log" } });
    expect(ticks(logged.scene)[0]!.count).toBe(2);
    const [stop] = logged.model.keyboardStops("");
    expect(stop!.length).toBe(2);
    expect(logged.model.inspectPosition(stop!.key, 0)!.points[0]!.row).toBe(6);
    expect(describeChart(logged.model)).toContain("2 values, from 1 to 10");
  });

  it.each(["x", "y"] as const)(
    "inspects %s observations in value order with real rows and formatted values",
    (axis) => {
      const mark =
        axis === "x"
          ? rug(observations, { x: "v", label: "Samples" })
          : rug(observations, { y: "v", label: "Samples" });
      const { model, scene } = build({
        marks: [mark],
        [axis]: { format: { maximumFractionDigits: 1 } },
      });
      expect(model.tooltipMode()).toBe(axis === "x" ? "nearest-x" : "nearest-y");
      const [stop] = model.keyboardStops("");
      const hits = [0, 1, 2, 3].map((i) => model.inspectPosition(stop!.key, i)!.points[0]!);
      expect(hits.map((p) => p.value)).toEqual([1, 2, 2, 3]);
      expect(hits.map((p) => p.row)).toEqual([1, 2, 3, 0]);
      expect(hits.map((p) => p.label)).toEqual(["Samples", "Samples", "Samples", "Samples"]);
      expect(hits.map((p) => p.text)).toEqual(["1", "2", "2", "3"]);
      const plot = scene.panels[0]!.plot;
      const pointer =
        axis === "x"
          ? [model.xScale()!.map(2.1), plot.y + 20]
          : [plot.x + 20, model.yScale()!.map(2.1)];
      expect(model.inspect(pointer[0]!, pointer[1]!)!.value).toBe(2);
      const tickHit = model.inspect(hits[0]!.px, hits[0]!.py, "nearest")!;
      expect(tickHit.axis).toBe(axis);
      expect(tickHit.points[0]!.value).toBe(1);
      expect(describeChart(model)).toContain("Samples: 4 values, from 1 to 3");
    },
  );

  it("formats number and time values as their axis does", () => {
    const t = table({
      v: [1.234, 2.345],
      date: time([Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 2)]),
    });
    for (const axis of ["x", "y"] as const) {
      const numeric = build({
        marks: [axis === "x" ? rug(t, { x: "v" }) : rug(t, { y: "v" })],
        [axis]: { format: { minimumFractionDigits: 2, maximumFractionDigits: 2 } },
      });
      expect(
        numeric.model.inspectPosition(numeric.model.series()[0]!.key, 0)!.points[0]!.text,
      ).toBe("1.23");
      const dated = build({
        marks: [axis === "x" ? rug(t, { x: "date" }) : rug(t, { y: "date" })],
      });
      expect((axis === "x" ? dated.model.xScale() : dated.model.yScale())!.type).toBe("time");
      const hit = dated.model.inspectPosition(dated.model.series()[0]!.key, 0)!;
      expect(hit.points[0]!.text).toBe(hit.label);
      expect(describeChart(dated.model)).toContain(hit.label);
    }
  });

  it("colors series, overrides their strokes and hides toggled observations", () => {
    const { model, scene } = build({
      marks: [rug(observations, { x: "v", series: "g" })],
      legend: true,
    });
    expect(ticks(scene).map((g) => g.count)).toEqual([2, 2]);
    expect(new Set(ticks(scene).map((g) => g.stroke)).size).toBe(2);
    expect(legendOf(scene).map((entry) => entry.label)).toEqual(["a", "b"]);
    model.hidden.add(legendOf(scene)[0]!.key);
    expect(ticks(model.scene(estimateText))).toHaveLength(1);
    expect(model.keyboardStops("")).toHaveLength(1);
    const custom = build({
      marks: [rug(observations, { y: "v", series: "g", stroke: "red", strokeWidth: 2 })],
    });
    expect(ticks(custom.scene).every((g) => g.stroke === "red" && g.strokeWidth === 2)).toBe(true);
  });

  it("splits facets, repeats observations and anchors each independent subplot", () => {
    const faceted = build({
      marks: [rug(observations, { x: "v" })],
      facet: facet("g"),
      y: { scope: "panel" },
      x: { scope: "panel" },
    });
    expect(faceted.scene.panels.map((_, i) => ticks(faceted.scene, i)[0]!.count)).toEqual([2, 2]);
    const repeat = build({
      marks: [
        line(observations, { x: "v", y: "v" }),
        rug(observations, { x: "v", facet: "repeat" }),
      ],
      facet: facet("g"),
    });
    expect(repeat.scene.panels.map((_, i) => ticks(repeat.scene, i)[0]!.count)).toEqual([4, 4]);
    expect(describeChart(repeat.model)).toContain("4 values, from 1 to 3");
    const subplots = build({
      marks: [rug(observations, { y: "v", panel: "*" })],
      panels: panels([
        { id: "a", x: { domain: [100, 200] } },
        { id: "b", x: { domain: [1000, 2000] } },
      ]),
      x: { scope: "panel" },
    });
    for (const panel of subplots.scene.panels) {
      const hit = subplots.model.inspectPosition(
        subplots.model.panelSeries(panel.key)[0]!.key,
        0,
        panel.key,
      )!;
      expect(hit.points[0]!.px).toBeCloseTo(panel.plot.x + 4);
      expect(hit.points[0]!.value).toBe(1);
    }
  });

  it("summarizes each panel's log policy without counting repeated rows twice", () => {
    const t = table({ v: [-1, 0, 1, 10] });
    for (const axis of ["x", "y"] as const) {
      const mark = axis === "x" ? rug(t, { x: "v", panel: "*" }) : rug(t, { y: "v", panel: "*" });
      const { model } = build({
        marks: [mark],
        panels: panels([
          { id: "log", [axis]: { type: "log" } },
          { id: "linear", [axis]: { type: "linear" } },
        ]),
        y: { scope: "panel" },
        x: { scope: "panel" },
      });
      expect(describeChart(model)).toContain("4 values, from -1 to 10");
    }
  });

  it("jumps over 100,000 observations in a time break when picking", () => {
    const start = Date.UTC(2026, 0, 1);
    const end = start + 10_000;
    const values = Float64Array.from({ length: 100_002 }, (_, i) =>
      i === 0 ? start - 1 : i === 100_001 ? end + 1 : start + (i - 1) / 10,
    );
    const mark = rug(table({ v: time(values) }), { x: "v" }) as RugMark;
    const reading = vi.spyOn(mark, "readSeries");
    const { model, scene } = build({
      marks: [mark],
      x: { domain: [start - 2, end + 2], breaks: timeBreaks([{ from: start, to: end }]) },
    });
    expect(ticks(scene)[0]!.count).toBe(2);
    expect(model.keyboardStops("")[0]!.length).toBe(2);
    const frame = reading.mock.calls[0]![1];
    reading.mockRestore();
    const calls = vi.spyOn(mark, "place");
    const plot = scene.panels[0]!.plot;
    // Exercise the picker on source rows too, independently of readable-row compaction.
    const hit = mark.pick(
      model.series(),
      model.xScale()!.map(end + 1),
      plot.y + plot.height - 4,
      frame,
    )!;
    expect(hit.position).toBe(100_001);
    expect(calls).toHaveBeenCalled();
    expect(calls.mock.calls.length).toBeLessThan(10);
    calls.mockRestore();
  });

  it.each(["x", "y"] as const)("has no keyboard stop for all-invalid log %s data", (axis) => {
    const t = table({ v: [-2, 0] });
    const { model } = build({
      marks: [axis === "x" ? rug(t, { x: "v" }) : rug(t, { y: "v" })],
      [axis]: { type: "log" },
    });
    expect(model.keyboardStops("")).toEqual([]);
  });

  it("does no reading compaction for a hidden large rug on redraw", () => {
    const values = Float64Array.from({ length: 100_000 }, (_, i) => i + 1);
    const mark = rug(table({ v: time(values) }), { x: "v" }) as RugMark;
    const { model } = build({
      marks: [mark],
      x: { breaks: timeBreaks([{ from: 0, to: 2 }]) },
    });
    expect(model.keyboardStops("")[0]!.length).toBe(99_999);
    model.hidden.add(model.series()[0]!.key);
    const original = mark.readSeries.bind(mark);
    let mappings = 0;
    let buffers = 0;
    const reading = vi.spyOn(mark, "readSeries").mockImplementation((series, frame) => {
      const map = vi.spyOn(frame.x, "map");
      const bytes = vi.spyOn(frame, "bytes");
      try {
        return original(series, frame);
      } finally {
        mappings += map.mock.calls.length;
        buffers += bytes.mock.calls.length;
        map.mockRestore();
        bytes.mockRestore();
      }
    });
    model.scene(estimateText);
    expect(model.keyboardStops("")).toEqual([]);
    expect(mappings).toBe(0);
    expect(buffers).toBe(0);
    reading.mockRestore();
  });

  it("packs 100,000 coincident observations in one geometry item", () => {
    const t = table({ v: new Float64Array(100_000).fill(1) });
    const { scene } = build({ marks: [rug(t, { x: "v" })] });
    expect(ticks(scene)).toHaveLength(1);
    expect(ticks(scene)[0]!.count).toBe(100_000);
    expect(ticks(scene)[0]!.strokeWidth).toBe(1);
    const [x1, y1, x2, y2] = endpoints(ticks(scene)[0]!);
    expect(x1).toBe(x2);
    expect(y1! - y2!).toBe(8);
  });

  it("follows table edits and preserves observation identity", () => {
    const t = table({ v: [3, 1] });
    const { model } = build({ marks: [rug(t, { x: "v" })] });
    t.append({ v: [2] });
    model.scene(estimateText);
    expect(model.inspectPosition(model.series()[0]!.key, 1)!.points[0]!.row).toBe(2);
    t.set("v", 0, 0);
    model.scene(estimateText);
    expect(model.inspectPosition(model.series()[0]!.key, 0)!.points[0]!.row).toBe(0);
  });

  it("loads a rug and renders a static segment path", () => {
    const spec = {
      data: { d: { columns: { v: [1, 2] } } },
      marks: [{ type: "rug" as const, x: "v", stroke: "#123456" }],
    };
    const loaded = loadSpec(spec);
    expect(loaded.config.marks[0]!.spec.type).toBe("rug");
    const svg = renderToSVG({ ...loaded.config, width: 300, height: 200 });
    const path = svg.match(/<path[^>]*d="([^"]*)"[^>]*stroke="#123456"/)!;
    expect(path).not.toBeNull();
    expect(path[1]!.match(/M/g)).toHaveLength(2);
    expect(path[1]!.match(/L/g)).toHaveLength(2);
    // The existing own-property mark registry check is the compatibility gate.
    expect(() => validateSpec({ ...spec, marks: [{ type: "unknown-rug" }] })).toThrow(
      /marks\[0\].type/,
    );
  });

  it.each([
    [{}, /marks\[0\].*exactly one/],
    [{ x: "v", y: "v" }, /marks\[0\].*exactly one/],
    [{ x: "v", side: "left" }, /marks\[0\].*side/],
    [{ y: "v", side: "top" }, /marks\[0\].*side/],
    [{ y: "v", axis: "right" }, /marks\[0\].*right axis/],
    [{ x: "v", length: 0 }, /marks\[0\].length/],
    [{ x: "v", length: Infinity }, /marks\[0\].length/],
    [{ x: "v", length: null }, /marks\[0\].length/],
    [{ x: "v", strokeWidth: -1 }, /marks\[0\].strokeWidth/],
    [{ x: "v", strokeWidth: null }, /marks\[0\].strokeWidth/],
    [{ x: "v", side: "inside" }, /marks\[0\].side/],
    [{ x: "missing" }, /marks\[0\]: rug x: no field "missing"/],
  ])("refuses invalid specs with paths: %j", (options, error) => {
    expect(() =>
      loadSpec({
        data: { d: { columns: { v: [1], category: ["a"] } } },
        marks: [{ type: "rug", ...options }],
      } as never),
    ).toThrow(error as RegExp);
  });

  it("checks column kinds and options in direct TypeScript calls", () => {
    const t = table({ c: ["a"], v: [1] });
    for (const options of [
      {},
      { x: "v", y: "v" },
      { x: "v", length: -1 },
      { x: "v", length: null },
      { x: "v", strokeWidth: null },
      { y: "v", side: "bottom" },
      { y: "v", axis: "right" },
      { x: "c" },
      { x: "v", series: "v" },
    ])
      expect(() => rug(t, options as never)).toThrow();
    expect(
      build({ marks: [rug(table({ v: [] as number[] }), { x: "v" })] }).model.keyboardStops(""),
    ).toEqual([]);
  });
});
