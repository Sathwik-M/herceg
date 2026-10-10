// Behavior that earlier versions got wrong.
import { describe, expect, it } from "vitest";
import { time } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { area } from "../../src/marks/area.ts";
import { type LineMark, line } from "../../src/marks/line.ts";
import type { MARK, Mark } from "../../src/marks/mark.ts";
import { rule } from "../../src/marks/rule.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { renderToSVG } from "../../src/render/static.ts";
import type { AreaGeometry, LineGeometry, Scene } from "../../src/scene/scene.ts";

function build(config: ChartConfig, width = 600, height = 300) {
  const model = new ChartModel({ locale: "en-US", timeZone: "UTC", ...config });
  model.setSize(width, height, 1);
  return { model, scene: model.scene(estimateText) };
}

const yLabels = (scene: Scene) =>
  scene.panels[0]!.axes.find((a) => a.orient === "left")!.ticks.map((t) => t.label);

describe("areas with gaps", () => {
  it("closes band edges over intervals where both edges exist", () => {
    const data = table({
      x: [0, 1, 2, 3, 4],
      low: [1, 1, Number.NaN, 1, 1],
      high: [2, 2, 2, 2, 2],
    });
    const { scene } = build({ marks: [area(data, { x: "x", y1: "low", y2: "high" })] });
    const band = scene.panels[0]!.marks[0] as AreaGeometry;
    expect(band.upper.starts.length).toBe(2);
    expect(band.lower!.starts.length).toBe(2);
    expect(band.upper.count).toBe(4);
    expect(band.lower!.count).toBe(4);
  });

  it("keeps layers above a missing value continuous", () => {
    const data = table({ x: [0, 1, 2], a: [1, 1, 1], b: [1, Number.NaN, 1], c: [1, 1, 1] });
    const { scene } = build({ marks: [area(data, { x: "x", y: ["a", "b", "c"], stack: true })] });
    const [, b, c] = scene.panels[0]!.marks as AreaGeometry[];
    expect(b!.upper.starts.length).toBe(2);
    expect(c!.upper.starts.length).toBe(1);
    expect(c!.upper.count).toBe(3);
  });
});

describe("identities", () => {
  it("never mixes buffers of fields whose names look like stages", () => {
    const data = table({ x: [0, 1, 2], y: [0, 1, 0], "y:step": [5, 5, 5] });
    const { scene } = build({
      marks: [line(data, { x: "x", y: ["y", "y:step"], curve: "step-after" })],
    });
    const [first, second] = scene.panels[0]!.marks as LineGeometry[];
    expect(first!.path).not.toBe(second!.path);
    expect(first!.path.coords[1]).not.toBe(second!.path.coords[1]);
  });

  it("rejects duplicate mark ids", () => {
    const data = table({ x: [0, 1], y: [0, 1] });
    expect(() =>
      build({
        marks: [line(data, { x: "x", y: "y", id: "a" }), line(data, { x: "x", y: "y", id: "a" })],
      }),
    ).toThrow('id: "a" names two marks');
  });

  it("gives each static render unique element ids", () => {
    const data = table({ x: [0, 1], y: [0, 1] });
    const a = renderToSVG({
      width: 200,
      height: 100,
      title: "A",
      marks: [line(data, { x: "x", y: "y" })],
    });
    const b = renderToSVG({
      width: 200,
      height: 100,
      title: "B",
      marks: [line(data, { x: "x", y: "y" })],
    });
    const id = (svg: string) => /<title id="([^"]+)"/.exec(svg)![1];
    expect(id(a)).not.toBe(id(b));
  });
});

describe("domains", () => {
  it("uses the positive values on log axes", () => {
    const data = table({ x: [0, 0.01, 0.1, 10], y: [0, 0.01, 0.1, 10] });
    const { scene } = build({
      marks: [line(data, { x: "x", y: "y" })],
      x: { type: "log" },
      y: { type: "log" },
    });
    expect(Number(yLabels(scene)[0])).toBeLessThanOrEqual(0.01);
  });

  it("keeps a line visible when zoomed in between two samples", () => {
    const data = table({ x: [0, 10], y: [100, 200] });
    const { model } = build({ marks: [line(data, { x: "x", y: "y" })] });
    model.setViewport([4, 6]);
    const scene = model.scene(estimateText);
    const labels = yLabels(scene).map(Number);
    expect(Math.min(...labels)).toBeLessThanOrEqual(140);
    expect(Math.max(...labels)).toBeGreaterThanOrEqual(160);
    expect(Math.max(...labels)).toBeLessThan(200);
  });

  it("includes zero on x when asked", () => {
    const data = table({ x: [100, 200], y: [1, 2] });
    const { scene } = build({ marks: [line(data, { x: "x", y: "y" })], x: { zero: true } });
    expect(scene.panels[0]!.axes.find((a) => a.orient === "bottom")!.ticks[0]!.label).toBe("0");
  });

  it("does not scan data for y when the domain is fixed", () => {
    const data = table({ x: [0, 1], y: [0, 1] });
    const inner = line(data, { x: "x", y: "y" }) as LineMark;
    let scans = 0;
    // An engine mark written for the test, as applications cannot.
    const counting: Omit<Mark, typeof MARK> = {
      spec: inner.spec,
      table: inner.table,
      tooltip: inner.tooltip,
      channelKind: (axis) => inner.channelKind(axis),
      series: (key, palette) => inner.series(key, palette),
      xExtent: (series, log) => inner.xExtent(series, log),
      yExtent: (series, x0, x1, log, breaks) => {
        scans++;
        return inner.yExtent(series, x0, x1, log, breaks);
      },
      geometry: (series, frame) => inner.geometry(series, frame),
    };
    build({ marks: [counting as Mark], y: { domain: [0, 10] } });
    expect(scans).toBe(0);
  });
});

describe("layout", () => {
  it("keeps the first x label inside the chart", () => {
    const start = Date.UTC(2026, 0, 1);
    const data = table({ t: time([start, start + 5 * 86_400_000]), y: [1, 2] });
    const { scene } = build({
      marks: [line(data, { x: "t", y: "y" })],
      x: { format: { year: "numeric", month: "long", day: "numeric" } },
      y: { show: false },
    });
    const first = scene.panels[0]!.axes.find((a) => a.orient === "bottom")!.ticks[0]!;
    expect(
      first.position - estimateText(first.label, "12px sans-serif") / 2,
    ).toBeGreaterThanOrEqual(0);
  });

  it("skips rules outside the visible range", () => {
    const data = table({ x: [0, 10], y: [0, 1] });
    const { model } = build({ marks: [line(data, { x: "x", y: "y" }), rule({ x: 0 })] });
    model.setViewport([2, 10]);
    expect(model.scene(estimateText).panels[0]!.marks.some((m) => m.kind === "rule")).toBe(false);
  });

  it("omits categories without rows", () => {
    const data = table({ t: [0, 1, 2], host: ["a", "b", "c"], v: [1, 2, 3] }, { maxRows: 3 });
    data.append({ t: [3, 4], host: ["c", "c"], v: [4, 5] });
    const { scene, model } = build({
      marks: [line(data, { x: "t", y: "v", series: "host" })],
      legend: true,
    });
    expect(model.series().map((s) => s.label)).toEqual(["c"]);
    expect(scene.legend).toHaveLength(1);
  });
});

describe("inspect", () => {
  it("finds the closest point even when its x is farther", () => {
    const data = table({ x: [0, 3], y: [100, 0] });
    const { model, scene } = build({
      marks: [line(data, { x: "x", y: "y" })],
      y: { domain: [0, 100] },
      x: { domain: [0, 100] },
    });
    // Pointer at the bottom-left corner: (3, 0) is much closer than (0, 100).
    const inspection = model.inspect(
      scene.panels[0]!.plot.x + 1,
      scene.panels[0]!.plot.y + scene.panels[0]!.plot.height - 1,
      "nearest",
    )!;
    expect(inspection.value).toBe(3);
  });

  it("reaches every point by position, including repeated x values", () => {
    const data = table({ x: [0, 0, 1], y: [5, 6, 7] });
    const { model } = build({ marks: [line(data, { x: "x", y: "y" })] });
    const key = model.series()[0]!.key;
    expect(model.inspectPosition(key, 1)!.points[0]!.value).toBe(6);
    expect(model.inspectPosition(key, 2)!.value).toBe(1);
  });
});
