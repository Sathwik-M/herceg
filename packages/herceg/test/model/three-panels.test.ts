import { describe, expect, it, vi } from "vitest";
import { category } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { line } from "../../src/marks/line.ts";
import { line3d } from "../../src/marks/line3d.ts";
import { point3d } from "../../src/marks/point3d.ts";
import { surface } from "../../src/marks/surface.ts";
import { describeChart } from "../../src/model/describe.ts";
import { ChartModel } from "../../src/model/model.ts";
import { panels } from "../../src/model/panels.ts";
import { renderToPDF } from "../../src/pdf.ts";
import { renderToSVG } from "../../src/render/static.ts";
import type { FaceGeometry } from "../../src/scene/scene.ts";
import { loadSpec } from "../../src/spec/load.ts";
import type { ChartSpec } from "../../src/spec/spec.ts";
import { FaceBuffer } from "../../src/three/faces.ts";

const data = table({ x: [0, 1, 0, 1], y: [0, 0, 1, 1], z: [0, 1, 2, 3] });
function config() {
  return {
    camera: { elevation: 35 },
    panels: panels(
      [
        { id: "trend", title: "Trend" },
        { id: "a", title: "Observations", camera: { azimuth: 20 } },
        { id: "b", title: "Fit", camera: { azimuth: 90 } },
      ],
      { columns: 3 },
    ),
    marks: [
      line(data, { x: "x", y: "z", panel: "trend" }),
      point3d(data, { x: "x", y: "y", z: "z", panel: "a" }),
      line3d(data, { x: "x", y: "y", z: "z", panel: "a" }),
      surface(data, { x: "x", y: "y", z: "z", panel: "b" }),
    ],
  };
}
function model() {
  const model = new ChartModel(config());
  model.setSize(900, 350, 1);
  return model;
}

describe("3D subplots", () => {
  it("keeps palette slots for actual series when categories arrive after a cached scene", () => {
    const data = table({ x: [0], y: [0], z: [0], group: category(["a"]) });
    const chart = new ChartModel({
      theme: { palette: ["#ff0000", "#0000ff"] },
      panels: panels([{ id: "a" }]),
      marks: [point3d(data, { x: "x", y: "y", z: "z", series: "group", panel: "a" })],
    });
    chart.setSize(500, 350, 1);
    chart.scene(estimateText);
    data.append({ x: [1], y: [1], z: [1], group: ["b"] });
    const scene = chart.scene(estimateText);
    expect(scene.legend.map(({ label, color }) => [label, color])).toEqual([
      ["a", "#ff0000"],
      ["b", "#0000ff"],
    ]);
    const faces = scene.panels[0]!.marks.find((mark) => mark.kind === "faces") as FaceGeometry;
    expect(
      new Set(Array.from(faces.style.subarray(0, faces.count), (s) => faces.styles[s]!.fill)),
    ).toEqual(new Set(["#ff0000", "#0000ff"]));
  });

  it("own cameras before the first scene and reconcile defaults separately", () => {
    const chart = model();
    expect(chart.getCamera("a")).toMatchObject({ azimuth: 20, elevation: 35 });
    expect(chart.getCamera("b")).toMatchObject({ azimuth: 90, elevation: 35 });
    expect(() => chart.getCamera()).toThrow("panel is required");
    expect(() => chart.setCamera({})).toThrow("panel is required");
    expect(() => chart.getCamera("trend")).toThrow("has no 3D camera");
    chart.setCamera({ elevation: 55 }, "a");
    const copy = chart.getCamera("a")!;
    copy.elevation = 0;
    expect(chart.getCamera("a")!.elevation).toBe(55);
    chart.update(config());
    expect(chart.getCamera("a")!.elevation).toBe(55);
    const next = config();
    next.panels = panels([
      { id: "trend" },
      { id: "a", camera: { azimuth: 25 } },
      { id: "b", camera: { azimuth: 90 } },
    ]);
    chart.setCamera({ zoom: 2 }, "b");
    chart.update(next);
    expect(chart.getCamera("a")).toMatchObject({ azimuth: 25, elevation: 35 });
    expect(chart.getCamera("b")!.zoom).toBe(2);
    chart.setCamera(null, "b");
    expect(chart.getCamera("b")!.zoom).toBe(1);
    chart.update({ marks: [point3d(data, { x: "x", y: "y", z: "z" })] });
    expect(chart.getCamera()).toBeDefined();
    expect(() => chart.getCamera("a")).toThrow("has no 3D camera");
  });

  it("only projects and sorts the changed panel, keeping CPU geometry and reading order", () => {
    const chart = model();
    const first = chart.scene(estimateText, true);
    const sort = vi.spyOn(FaceBuffer.prototype, "geometry");
    chart.setCamera({ azimuth: 40 }, "a");
    const second = chart.scene(estimateText, true);
    expect(sort).toHaveBeenCalledTimes(1);
    sort.mockRestore();
    expect(second.panels[2]!.marks).toBe(first.panels[2]!.marks);
    expect(second.panels[1]!.marks).not.toBe(first.panels[1]!.marks);
    for (const panel of second.panels)
      for (const mark of panel.marks)
        if (mark.kind === "faces") expect((mark as FaceGeometry).batches).toBeUndefined();
    const a = chart.items!.result("a")!;
    expect(chart.inspectItem(a.item(0).key, "a")!.points[0]!.mark).toBe(1);
    expect(chart.inspectItem(a.item(4).key, "a")!.points[0]!.mark).toBe(2);
    expect(chart.allPanels().map(({ key }) => key)).toEqual(["trend", "a", "b"]);
    expect(chart.stepItem(undefined, 1, "a")).toBe(a.item(0).key);
    expect(chart.stepItem(undefined, 1, "b")).toBe(chart.items!.result("b")!.item(0).key);
    expect(describeChart(chart)).toContain("Observations");
    expect(describeChart(chart)).toContain("Fit");
    expect(describeChart(chart)).toContain("azimuth 40°");
    expect(describeChart(chart)).toContain("azimuth 90°");
    data.replace("z", 0, [0.5]);
    expect(chart.scene(estimateText).panels[2]!.marks).not.toBe(second.panels[2]!.marks);
  });

  it("reports each owner once and retains reentrant camera moves", () => {
    const chart = model();
    const changes: unknown[] = [];
    chart.items!.changed = (type, change) => {
      changes.push({ type, ...change });
      if (changes.length === 1) chart.setCamera({ azimuth: 80 }, "a");
    };
    chart.setCamera({ azimuth: 30 }, "a");
    chart.setCamera({ azimuth: 40 }, "a");
    chart.setCamera({ azimuth: 100 }, "b");
    chart.items!.finishCameras();
    expect(changes).toMatchObject([
      { type: "camera", panels: ["a"], camera: { azimuth: 40 } },
      { type: "camera", panels: ["b"], camera: { azimuth: 100 } },
    ]);
    chart.items!.finishCameras();
    expect(changes).toHaveLength(3);
    expect(changes[2]).toMatchObject({ panels: ["a"], camera: { azimuth: 80 } });
  });

  it("round trips subplot specs and exports both configured views", () => {
    const spec: ChartSpec = {
      data: { data: { columns: { x: [0, 1, 0, 1], y: [0, 0, 1, 1], z: [0, 1, 2, 3] } } },
      panels: [
        { id: "a", title: "Observations", camera: { azimuth: 20 } },
        { id: "b", title: "Fit", camera: { azimuth: 90 } },
      ],
      grid: { columns: 2 },
      marks: [
        { type: "point3d", panel: "a", x: "x", y: "y", z: "z" },
        { type: "surface", panel: "b", x: "x", y: "y", z: "z" },
      ],
    };
    expect(spec.panels![0]!.camera).toEqual({ azimuth: 20 });
    expect(spec.marks[0]!.panel).toBe("a");
    const chart = new ChartModel(loadSpec(spec).config);
    expect(chart.getCamera("b")!.azimuth).toBe(90);
    const svg = renderToSVG({ ...loadSpec(spec).config, width: 900, height: 350 });
    expect(svg).toContain("azimuth 20°");
    expect(svg).toContain("azimuth 90°");
    const pdf = renderToPDF({ ...loadSpec(spec).config, width: 900, height: 350 });
    expect(pdf.length).toBeGreaterThan(1000);
  });
});
