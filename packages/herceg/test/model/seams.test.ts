import { describe, expect, it, vi } from "vitest";
import { time } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { seamDrawing } from "../../src/draw/seams.ts";
import { estimateText } from "../../src/layout/text.ts";
import { grid } from "../../src/layout.ts";
import { line } from "../../src/marks/line.ts";
import { pie } from "../../src/marks/pie.ts";
import { describeChart } from "../../src/model/describe.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { rangeNavigator } from "../../src/model/navigator.ts";
import { panels } from "../../src/model/panels.ts";
import { renderSvg } from "../../src/render/svg.ts";
import { Calendar, timeBreaks } from "../../src/scale/breaks.ts";
import type { Panel, SegmentGeometry } from "../../src/scene/scene.ts";
import { loadSpec } from "../../src/spec/load.ts";
import type { ChartSpec } from "../../src/spec/spec.ts";
import { validateSpec } from "../../src/spec/validate.ts";

const data = table({ t: time([0, 20]), v: [1, 2] });
const gap = () =>
  timeBreaks([
    { from: 4, to: 6 },
    { from: 6, to: 8 },
    { from: 10, to: 12 },
  ]);

function build(config: Partial<ChartConfig> = {}) {
  const model = new ChartModel({
    timeZone: "UTC",
    marks: [line(data, { x: "t", y: "v" })],
    x: { domain: [0, 20], breaks: gap(), seams: true },
    ...config,
  });
  model.setSize(600, 300, 1);
  return { model, scene: model.scene(estimateText) };
}

/** Where a seam at pixel `x` is drawn: on a pixel's center. */
const placed = (x: number) => Math.round(x) + 0.5;

function positions(panel: Panel): number[] | undefined {
  const geometry = panel.marks.find((mark) => mark.draw === seamDrawing) as
    | SegmentGeometry
    | undefined;
  return geometry && Array.from(geometry.coords).filter((_, i) => i % 4 === 0);
}

describe("time-axis seam markers", () => {
  it("uses the resolved grid color and a fixed dash without theme defaults", () => {
    for (const theme of ["light", "dark", "high-contrast", "high-contrast-dark", "auto"] as const) {
      const { scene } = build({ theme });
      const seams = scene.panels[0]!.marks[0] as SegmentGeometry;
      expect(seams.stroke).toBe(scene.theme.grid);
      expect(seams.dash).toEqual([3, 3]);
    }
    const { scene } = build({
      theme: { tokens: { grid: "#123456" }, style: { grid: { dash: [5, 2] } } },
    });
    const seams = scene.panels[0]!.marks[0] as SegmentGeometry;
    expect(seams.stroke).toBe("#123456");
    expect(seams.dash).toEqual([3, 3]);
  });

  it("plans merged seams once per panel and draws decorative paths behind data", () => {
    const breaks = gap();
    const plan = vi.spyOn(Calendar.prototype, "seams");
    const { model, scene } = build({ x: { domain: [0, 20], breaks, seams: true } });
    expect(plan).toHaveBeenCalledTimes(1);
    plan.mockRestore();
    const panel = scene.panels[0]!;
    expect(positions(panel)).toEqual([
      placed(model.xScale()!.map(8)),
      placed(model.xScale()!.map(12)),
    ]);
    const svg = renderSvg(scene);
    const seams = panel.marks[0] as SegmentGeometry;
    expect(seams.kind).toBe("segments");
    expect(seams.draw).toBe(seamDrawing);
    expect(seams.dash).toEqual([3, 3]);
    expect(svg).toContain(seams.draw.svg(seams, { theme: scene.theme, encodeRaster: undefined }));
    expect(svg).toContain('stroke-width="1" stroke-dasharray="3 3"');
    expect(svg).toContain('aria-hidden="true" focusable="false" pointer-events="none"');
    expect(svg.indexOf('stroke-width="1" stroke-dasharray="3 3"')).toBeLessThan(
      svg.indexOf('stroke-width="2"'),
    );
    expect(describeChart(model)).toContain("The time axis leaves out breaks in time.");
  });

  it("marks merged sessions across a clock change at their actual opening instants", () => {
    const from = Date.UTC(2025, 2, 7, 17); // Friday noon in New York.
    const to = Date.UTC(2025, 2, 11, 16); // Tuesday noon after the spring clock change.
    const prices = table({ t: time([from, to]), v: [1, 2] });
    const { model, scene } = build({
      timeZone: "America/New_York",
      marks: [line(prices, { x: "t", y: "v" })],
      x: {
        domain: [from, to],
        breaks: timeBreaks([{ weekdays: ["sat", "sun"] }, { hours: ["16:00", "09:30"] }]),
        seams: true,
      },
    });
    expect(positions(scene.panels[0]!)).toEqual([
      placed(model.xScale()!.map(Date.UTC(2025, 2, 10, 13, 30))),
      placed(model.xScale()!.map(Date.UTC(2025, 2, 11, 13, 30))),
    ]);
  });

  it("keeps chronological order on reversed domains", () => {
    const { model, scene } = build({ x: { domain: [20, 0], breaks: gap(), seams: true } });
    const expected = [8, 12].map((t) => placed(model.xScale()!.map(t)));
    expect(positions(scene.panels[0]!)).toEqual(expected);
    expect(expected[0]).toBeGreaterThan(expected[1]!);
  });

  it("excludes seams on viewport edges and breaks cut by those edges", () => {
    const { model } = build();
    for (const domain of [
      [8, 12],
      [5, 11],
      [0, 5],
      [12, 20],
    ] as [number, number][]) {
      model.setViewport(domain);
      expect(positions(model.scene(estimateText).panels[0]!)).toBeUndefined();
    }
    model.setViewport([8, 20]);
    expect(positions(model.scene(estimateText).panels[0]!)).toEqual([
      placed(model.xScale()!.map(12)),
    ]);
  });

  it("thins greedily in CSS pixels after layout, independently of DPR", () => {
    const breaks = timeBreaks(
      Array.from({ length: 9 }, (_, i) => ({ from: i * 2 + 1, to: i * 2 + 2 })),
    );
    const { model } = build({ x: { domain: [0, 20], breaks, seams: { minSpacing: 100 } } });
    for (const width of [300, 600]) {
      let first: readonly number[] | undefined;
      for (const ratio of [1, 2, 3]) {
        model.setSize(width, 300, ratio);
        const scene = model.scene(estimateText);
        const scale = model.xScale()!;
        const expected: number[] = [];
        for (let t = 2; t <= 18; t += 2) {
          const px = placed(scale.map(t));
          if (expected.length === 0 || px - expected.at(-1)! >= 100) expected.push(px);
        }
        expect(positions(scene.panels[0]!)).toEqual(expected);
        if (first) expect(positions(scene.panels[0]!)).toEqual(first);
        first = positions(scene.panels[0]!);
      }
    }
    const defaults = build({ x: { domain: [0, 20], breaks, seams: true } }).scene;
    const explicit = build({ x: { domain: [0, 20], breaks, seams: { minSpacing: 40 } } }).scene;
    expect(positions(defaults.panels[0]!)).toEqual(positions(explicit.panels[0]!));
  });

  it("uses each independent panel's final scale and omits number panels", () => {
    const { model, scene } = build({
      x: { domain: [0, 20], breaks: gap(), seams: { minSpacing: 1 }, scope: "panel" },
      panels: panels(
        [
          { id: "a", x: { type: "time", domain: [0, 20] } },
          { id: "b", x: { type: "time", domain: [8, 20] } },
          { id: "c", x: { type: "linear", domain: [0, 20] } },
        ],
        grid({ columns: [1, 2, 1] }),
      ),

      marks: ["a", "b", "c"].map((panel) => line(data, { x: "t", y: "v", panel })),
    });
    const views = model.panels();
    expect(positions(scene.panels[0]!)).toEqual([8, 12].map((t) => placed(views[0]!.x.map(t))));
    expect(positions(scene.panels[1]!)).toEqual([placed(views[1]!.x.map(12))]);
    expect(positions(scene.panels[2]!)).toBeUndefined();
  });

  it("omits seams in the navigator, even though its scale leaves time out", () => {
    const { scene } = build({ navigator: rangeNavigator() });
    expect(positions(scene.panels[0]!)).toHaveLength(2);
    expect(positions(scene.panels[1]!)).toBeUndefined();
  });

  it("needs time-axis breaks and finite positive spacing when enabled", () => {
    for (const minSpacing of [0, -1, NaN, Infinity])
      expect(() => build({ x: { breaks: gap(), seams: { minSpacing } } })).toThrow(
        /chart x\.seams\.minSpacing: expected a positive number; received/,
      );
    expect(() => build({ x: { seams: true } })).toThrow(/chart x\.seams: need x\.breaks/);
    expect(() => build({ x: { type: "linear", breaks: gap(), seams: true } })).toThrow(
      /chart x\.breaks: need a time x axis/,
    );
    expect(() =>
      build({
        marks: [pie(table({ kind: ["a", "b"], v: [1, 2] }), { category: "kind", value: "v" })],
      }),
    ).toThrow(/no x axis/);
    const plan = vi.spyOn(Calendar.prototype, "seams");
    for (const x of [{}, { seams: false }, { breaks: gap(), seams: false }])
      expect(positions(build({ x }).scene.panels[0]!)).toBeUndefined();
    expect(plan).not.toHaveBeenCalled();
    plan.mockRestore();
  });
});

describe("seam placement", () => {
  it("puts seams on pixel centers inside the plot, which every renderer draws as placed", () => {
    for (const width of [600, 601, 437]) {
      const model = new ChartModel({
        timeZone: "UTC",
        marks: [line(data, { x: "t", y: "v" })],
        x: { domain: [0, 20], breaks: gap(), seams: { minSpacing: 1 } },
      });
      model.setSize(width, 300, 1);
      const scene = model.scene(estimateText);
      const { plot } = scene.panels[0]!;
      const placed = positions(scene.panels[0]!)!;
      expect(placed.length).toBeGreaterThan(0);
      for (const x of placed) {
        expect(x - Math.floor(x)).toBe(0.5);
        expect(x > plot.x && x < plot.x + plot.width).toBe(true);
        expect(renderSvg(scene)).toContain(`M${x} `);
      }
    }
  });
});

describe("portable specs with seams", () => {
  const spec = (x: NonNullable<ChartSpec["x"]>): ChartSpec => ({
    data: { d: { columns: { t: { type: "time", values: [0, 20] }, v: [1, 2] } } },
    marks: [{ type: "line", x: "t", y: "v" }],
    x,
  });

  it("round trips and load", () => {
    const original = spec({ domain: [0, 20], breaks: gap().toJSON(), seams: { minSpacing: 40 } });
    original.theme = { tokens: { grid: "#ff0000" } };
    const loaded = loadSpec(JSON.parse(JSON.stringify(original)), undefined, { unknown: "error" });
    expect(JSON.parse(JSON.stringify(loaded.config.x))).toEqual(original.x);
    expect(positions(build(loaded.config).scene.panels[0]!)).toHaveLength(2);
  });

  it("rejects invalid spacing, missing breaks, and y seams", () => {
    for (const x of [{}, { seams: false }]) validateSpec(spec(x));
    validateSpec(spec({ breaks: [], seams: true }));
    validateSpec(spec({ breaks: [], seams: {} }));
    for (const minSpacing of [0, -1, NaN, Infinity, "40"])
      expect(() => validateSpec(spec({ breaks: [], seams: { minSpacing } } as never))).toThrow(
        /minSpacing/,
      );
    expect(() => validateSpec(spec({ seams: true }))).toThrow(/time-axis breaks/);
    expect(() => validateSpec({ ...spec({}), y: { seams: true } })).toThrow(/x axis only/);
  });
});
