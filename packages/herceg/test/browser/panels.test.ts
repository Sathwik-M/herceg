// Scenes with several panels, drawn by the live SVG layer and the canvas painter.
import { afterEach, describe, expect, it } from "vitest";
import { table } from "../../src/data/table.ts";
import { SvgLayer } from "../../src/dom/svg-layer.ts";
import { estimateText } from "../../src/layout/text.ts";
import { line } from "../../src/marks/line.ts";
import { rule } from "../../src/marks/rule.ts";
import { ChartModel } from "../../src/model/model.ts";
import { paintCanvas } from "../../src/render/canvas.ts";
import type { Scene } from "../../src/scene/scene.ts";

const model = new ChartModel({
  marks: [
    line(table({ x: [0, 10], y: [5, 5] }), { x: "x", y: "y" }),
    rule({ y: 5, label: "five" }),
  ],
  y: { domain: [0, 10] },
});
model.setSize(400, 200, 1);
const base = model.scene(estimateText);
const [only] = base.panels;

/**
 * The chart's one panel repeated under `keys`, side by side: each panel's
 * plot is a slice of the original, with a 20px gutter between slices.
 */
function sceneOf(keys: readonly string[]): Scene {
  const { plot } = only!;
  const width = (plot.width - 20 * (keys.length - 1)) / Math.max(1, keys.length);
  return {
    ...base,
    panels: keys.map((key, i) => ({
      ...only!,
      key,
      plot: { ...plot, x: plot.x + i * (width + 20), width },
    })),
  };
}

let host: HTMLDivElement | undefined;
afterEach(() => host?.remove());

function mount(): SvgLayer {
  const layer = new SvgLayer(document, "panels");
  host = document.createElement("div");
  host.append(layer.svg);
  document.body.append(host);
  return layer;
}

/** The layer's data groups (clipped) and annotation groups, in document order. */
function groups(layer: SvgLayer) {
  const children = [...layer.svg.children].filter((node) => node.tagName === "g");
  const clipped = children.filter((node) => node.hasAttribute("clip-path"));
  const clips = [...layer.svg.querySelectorAll("clipPath")];
  // Clip rectangles in the order the data groups use them.
  const rects = clipped.map((group) => {
    const id = /url\(#(.+)\)/.exec(group.getAttribute("clip-path")!)![1];
    const clip = clips.find((node) => node.id === id);
    return clip ? Number(clip.querySelector("rect")!.getAttribute("x")) : undefined;
  });
  return { children, clipped, clips, rects };
}

describe("panels", () => {
  it("keep each panel's nodes through reorders, removal, and return", () => {
    const layer = mount();
    const steps: string[][] = [["a", "b"], ["b", "a"], ["b", "c"], [], ["a", "b"]];
    let previous: Element[] = [];
    for (const keys of steps) {
      const scene = sceneOf(keys);
      layer.render(scene, { marks: true });
      const { children, clipped, clips, rects } = groups(layer);
      // One clip per panel, each data group clipped to its own panel's plot.
      expect(clips).toHaveLength(keys.length);
      expect(new Set(clips.map((clip) => clip.id)).size).toBe(keys.length);
      expect(rects).toEqual(scene.panels.map((panel) => panel.plot.x));
      // Data groups in panel order, then annotation groups, then axes.
      const annotations = children.filter(
        (node) => node.querySelector("text")?.textContent === "five",
      );
      expect(annotations).toHaveLength(keys.length);
      const lastData = Math.max(-1, ...clipped.map((node) => children.indexOf(node)));
      for (const node of annotations) expect(children.indexOf(node)).toBeGreaterThan(lastData);
      if (keys.join() === "b,a") {
        // Panel b keeps its nodes when it moves first.
        expect(clipped[0]).toBe(previous[1]);
        expect(clipped[1]).toBe(previous[0]);
      }
      previous = clipped;
    }
  });

  it("fill data groups when the SVG takes over drawing from a canvas", () => {
    const layer = mount();
    const scene = sceneOf(["a", "b"]);
    layer.render(scene, { marks: false });
    expect(groups(layer).clipped.map((group) => group.childElementCount)).toEqual([0, 0]);
    layer.render(scene, { marks: true });
    expect(groups(layer).clipped.map((group) => group.childElementCount)).toEqual([1, 1]);
  });

  it("clip canvas drawing to each panel, leaving gutters empty", () => {
    const scene = sceneOf(["a", "b"]);
    const canvas = document.createElement("canvas");
    paintCanvas(canvas, { ...scene, theme: { ...scene.theme, background: "transparent" } });
    const context = canvas.getContext("2d")!;
    const [a, b] = scene.panels;
    // The line runs across the whole chart at y = 5, the middle of the plot.
    const y = Math.round(a!.plot.y + a!.plot.height / 2);
    const alpha = (x: number) => context.getImageData(Math.round(x), y, 1, 1).data[3]!;
    expect(alpha(a!.plot.x + a!.plot.width / 2)).toBeGreaterThan(0);
    expect(alpha(b!.plot.x + b!.plot.width / 2)).toBeGreaterThan(0);
    expect(alpha(a!.plot.x + a!.plot.width + 10)).toBe(0);
  });
});
