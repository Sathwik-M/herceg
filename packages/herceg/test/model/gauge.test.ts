import { describe, expect, it } from "vitest";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { gauge } from "../../src/marks/gauge.ts";
import { line } from "../../src/marks/line.ts";
import { describeChart } from "../../src/model/describe.ts";
import { type ChartConfig, ChartModel, type ItemInspection } from "../../src/model/model.ts";
import { renderToPDF } from "../../src/pdf.ts";
import { renderToSVG } from "../../src/render/static.ts";
import type {
  ArcGeometry,
  Scene,
  ShapesGeometry,
  TextGeometry,
  TextShape,
} from "../../src/scene/scene.ts";
import { loadSpec } from "../../src/spec/load.ts";

function build(config: ChartConfig, width = 400, height = 300) {
  const model = new ChartModel({ locale: "en-US", ...config });
  model.setSize(width, height, 1);
  return { model, scene: model.scene(estimateText) };
}

const marks = (scene: Scene) => scene.panels[0]!.marks;
const arcs = (scene: Scene, key: string) =>
  marks(scene).find((m): m is ArcGeometry => m.kind === "arc" && m.key === key);
const sector = (mark: ArcGeometry, i: number) => Array.from(mark.arcs.subarray(i * 6, i * 6 + 6));
const valueText = (scene: Scene) => {
  const shapes = marks(scene).find((m): m is ShapesGeometry => m.kind === "shapes")!;
  return (shapes.shapes[0] as TextShape).text;
};
const labels = (scene: Scene) =>
  marks(scene).find((m): m is TextGeometry => m.kind === "text")?.labels ?? [];

/** The dial starts at 150 degrees and turns 240 clockwise. */
const START = (150 / 180) * Math.PI;
const SWEEP = (240 / 180) * Math.PI;

describe("gauge", () => {
  it("shows the field's last finite value on a 240-degree dial", () => {
    const cpu = table({ cpu: [10, 73, Number.NaN] });
    const { scene, model } = build({ marks: [gauge(cpu, { value: "cpu" })] });
    const dial = arcs(scene, "gauge-dial")!;
    expect(dial.count).toBe(2);
    // The track runs from the value to the dial's end, the value's arc from its start.
    const [cx, cy, r0, r, t0, t1] = sector(dial, 0);
    const [, , , , v0, v1] = sector(dial, 1);
    expect(r0! / r!).toBeCloseTo(0.82, 5);
    expect(v0).toBeCloseTo(START, 5);
    expect(v1).toBeCloseTo(START + 0.73 * SWEEP, 5);
    expect(t0).toBeCloseTo(v1!, 5);
    expect(t1).toBeCloseTo(START + SWEEP, 5);
    expect(dial.colors).toEqual([scene.theme.grid, scene.theme.palette[0]]);
    // Centered in the room, with no legend.
    expect(cx).toBeCloseTo(200, 5);
    expect(cy).toBeGreaterThan(150);
    expect(scene.legend).toEqual([]);
    expect(valueText(scene)).toBe("73");
    expect(labels(scene)).toEqual(["cpu", "0", "100"]);
    expect(model.layoutSummary()).toBe("Gauge of cpu: 73, from 0 to 100.");
    expect(arcs(scene, "gauge-bands")).toBeUndefined();
    // Static SVG writes the value at the size and weight it was laid out with.
    const value = marks(scene).find((m): m is ShapesGeometry => m.kind === "shapes")!;
    expect(value.fontSize).toBeGreaterThan(scene.theme.fontSize);
    expect(value.font).toBe(`600 ${value.fontSize}px ${scene.theme.font}`);
    const svg = renderToSVG({ marks: [gauge(cpu, { value: "cpu" })], width: 400, height: 300 });
    expect(svg).toContain(`font-size="${value.fontSize}" font-weight="600">73</text>`);
  });

  it("follows rows appended to its table", () => {
    const cpu = table({ cpu: [10, 73] });
    const { model } = build({ marks: [gauge(cpu, { value: "cpu", label: "CPU" })] });
    cpu.appendRow({ cpu: 42 });
    const scene = model.scene(estimateText);
    expect(valueText(scene)).toBe("42");
    expect(labels(scene)[0]).toBe("CPU");
    expect(model.inspectItem(model.stepItem(undefined, 1)!)!.points[0]!.text).toBe(
      "42 of 0 to 100",
    );
  });

  it("stops the arc at the dial's ends but reports the true value", () => {
    const hot = table({ t: [130] });
    const { scene, model } = build({ marks: [gauge(hot, { value: "t" })] });
    const [, , , , , end] = sector(arcs(scene, "gauge-dial")!, 1);
    expect(end).toBeCloseTo(START + SWEEP, 5);
    expect(valueText(scene)).toBe("130");
    const key = model.stepItem(undefined, 1)!;
    expect(model.inspectItem(key)!.points[0]!.text).toBe("130 of 0 to 100, above the maximum");
    const cold = build({ marks: [gauge(table({ t: [-5] }), { value: "t", min: 0, max: 10 })] });
    const [, , , , from, to] = sector(arcs(cold.scene, "gauge-dial")!, 1);
    expect(to! - from!).toBe(0);
    expect(cold.model.layoutSummary()).toBe("Gauge of t: -5, from 0 to 10, below the minimum.");
  });

  it("draws bands outside the track and colors the value by its band", () => {
    const cpu = table({ cpu: [73] });
    const { scene, model } = build({
      marks: [
        gauge(cpu, {
          value: "cpu",
          min: 0,
          max: 200,
          bands: [{ to: 60 }, { to: 100, color: "#ff0000" }, { to: 160 }],
        }),
      ],
    });
    const bands = arcs(scene, "gauge-bands")!;
    const dial = arcs(scene, "gauge-dial")!;
    expect(bands.count).toBe(3);
    expect(bands.gap).toBeGreaterThan(0);
    const [, , , r] = sector(dial, 0);
    const [, , b0, , a0, a1] = sector(bands, 0);
    expect(b0).toBeGreaterThan(r!);
    expect(a0).toBeCloseTo(START, 5);
    expect(a1).toBeCloseTo(START + 0.3 * SWEEP, 5);
    // The last band ends at its own end, short of the dial's.
    expect(sector(bands, 2)[5]).toBeCloseTo(START + 0.8 * SWEEP, 5);
    // Colors default to the palette in order.
    const palette = scene.theme.palette;
    expect([0, 1, 2].map((i) => bands.colors[bands.colorIndex[i]!])).toEqual([
      palette[0],
      "#ff0000",
      palette[2],
    ]);
    expect(dial.colors[1]).toBe("#ff0000");
    expect(model.layoutSummary()).toBe("Gauge of cpu: 73, from 0 to 200, in the band up to 100.");
    // A value no band reaches takes the first palette color.
    cpu.appendRow({ cpu: 180 });
    expect(arcs(model.scene(estimateText), "gauge-dial")!.colors[1]).toBe(palette[0]);
  });

  it("places values on a dial as wide as the doubles allow", () => {
    const wide = table({ v: [0] });
    const { model } = build({
      marks: [
        gauge(wide, { value: "v", min: -1e308, max: 1e308, bands: [{ to: 0 }, { to: 1e308 }] }),
      ],
    });
    const sweepAt = (value: number) => {
      wide.appendRow({ v: value });
      const scene = model.scene(estimateText);
      const dial = arcs(scene, "gauge-dial")!;
      const bands = arcs(scene, "gauge-bands")!;
      expect([...dial.arcs, ...bands.arcs].every(Number.isFinite)).toBe(true);
      expect(sector(bands, 0)[5]).toBeCloseTo(START + SWEEP / 2, 5);
      return sector(dial, 1)[5]! - START;
    };
    expect(sweepAt(0)).toBeCloseTo(SWEEP / 2, 5);
    expect(sweepAt(1e308)).toBeCloseTo(SWEEP, 5);
    expect(sweepAt(-1e308)).toBeCloseTo(0, 5);
    expect(sweepAt(Number.MAX_VALUE)).toBeCloseTo(SWEEP, 5);
  });

  it("formats the value and the dial's ends", () => {
    const share = table({ s: [0.734] });
    const { scene } = build({
      marks: [gauge(share, { value: "s", max: 1, format: { style: "percent" } })],
    });
    expect(valueText(scene)).toBe("73%");
    expect(labels(scene)).toEqual(["s", "0%", "100%"]);
  });

  it("shows an empty track and a dash without a finite value", () => {
    for (const values of [[] as number[], [Number.NaN, Number.POSITIVE_INFINITY]]) {
      const { scene, model } = build({ marks: [gauge(table({ v: values }), { value: "v" })] });
      const dial = arcs(scene, "gauge-dial")!;
      const [, , , , t0, t1] = sector(dial, 0);
      expect(t1! - t0!).toBeCloseTo(SWEEP, 5);
      expect(valueText(scene)).toBe("–");
      expect(describeChart(model)).toBe("Gauge of v: no value, from 0 to 100.");
      const [cx, cy] = sector(dial, 0);
      const item = model.inspect(cx!, cy!) as ItemInspection;
      expect(item.points[0]!.text).toBe("no value, from 0 to 100");
    }
  });

  it("is one item, found anywhere on the dial", () => {
    const { scene, model } = build({ marks: [gauge(table({ cpu: [50] }), { value: "cpu" })] });
    const [cx, cy, , r] = sector(arcs(scene, "gauge-dial")!, 0) as number[];
    const item = model.inspect(cx!, cy! - r! + 2) as ItemInspection;
    expect([item.axis, item.label, item.value]).toEqual(["item", "cpu", 50]);
    expect(item.points[0]!.label).toBe("cpu");
    expect(item.outline).toMatch(/^M.*A.*Z$/);
    expect(model.inspect(cx!, cy!)).toEqual(item);
    expect(model.inspect(2, 290)).toBeUndefined();
    const key = model.stepItem(undefined, 1)!;
    expect(item.key).toBe(key);
    expect(model.stepItem(key, 1)).toBe(key);
  });

  it("refuses bad domains and bands, and shares its chart with nothing", () => {
    const cpu = table({ cpu: [1], host: ["a"] });
    expect(() => gauge(cpu, { value: "cpu", min: 5, max: 5 })).toThrow("min must be below max");
    expect(() => gauge(cpu, { value: "cpu", max: Number.NaN })).toThrow("min must be below max");
    expect(() => gauge(cpu, { value: "cpu", bands: [{ to: 120 }] })).toThrow("at most at max");
    expect(() => gauge(cpu, { value: "cpu", bands: [{ to: 0 }] })).toThrow("above min");
    expect(() => gauge(cpu, { value: "cpu", bands: [{ to: 50 }, { to: 40 }] })).toThrow(
      "ascending order, not 40 after 50",
    );
    expect(() => gauge(cpu, { value: "host" as never })).toThrow();
    const dial = gauge(cpu, { value: "cpu" });
    expect(() => build({ marks: [dial, line(cpu, { x: "cpu", y: "cpu" })] })).toThrow(
      "A gauge mark has its chart to itself",
    );
    expect(() => build({ marks: [dial], interaction: { brush: "x" } })).toThrow("no x axis");
  });

  it("loads from specs and renders to SVG and PDF", () => {
    const spec = (mark: object) => ({
      version: 1 as const,
      width: 300,
      height: 200,
      data: { m: { columns: { cpu: [40, 61.5] } } },
      marks: [{ type: "gauge", value: "cpu", ...mark }],
    });
    const { config } = loadSpec(
      spec({ max: 80, bands: [{ to: 50 }, { to: 80, color: "#e0464f" }], label: "CPU" }) as never,
      [],
    );
    const svg = renderToSVG({ ...config, width: 300, height: 200 });
    // The value is semibold and larger than the chart's text.
    expect(svg).toMatch(/<text [^>]*font-size="\d+" font-weight="600">61.5<\/text>/);
    expect(svg).toContain("CPU");
    expect(svg).toMatch(/<path d="M[^"]*A[^"]*" fill="#e0464f"/);
    expect(renderToPDF({ ...config, width: 300, height: 200 }).length).toBeGreaterThan(500);
    const load = (mark: object) => () => loadSpec(spec(mark) as never, []);
    expect(load({ bands: [{ to: 50 }, { to: 20 }] })).toThrow(
      "marks[0].bands[1].to: expected an end above the previous band's (50), got 20",
    );
    expect(load({ bands: [{ color: "red" }] })).toThrow("marks[0].bands[0].to: required");
    expect(load({ format: { style: "nonsense" } })).toThrow("marks[0].format");
    expect(load({ min: 100 })).toThrow("Mark 0 (gauge): gauge min must be below max");
    expect(load({ value: undefined })).toThrow("marks[0].value: required");
  });
});
