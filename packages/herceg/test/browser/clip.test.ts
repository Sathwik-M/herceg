// Marks' clip in live charts: the SVG layer's groups and clip paths, and
// the canvas, which cuts data to the plot unless its mark says otherwise;
// and how a live chart's SVG export sizes.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { table } from "../../src/data/table.ts";
import { createChart } from "../../src/dom/chart.ts";
import { estimateText } from "../../src/layout/text.ts";
import { point } from "../../src/marks/point.ts";
import { text } from "../../src/marks/text.ts";
import { renderToSVG } from "../../src/render/static.ts";
import type { PointGeometry } from "../../src/scene/scene.ts";
import type { Clip } from "../../src/spec/spec.ts";
import { modelOf } from "./helpers.ts";

let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  host.style.cssText = "width:600px;height:300px";
  document.body.append(host);
});

afterEach(() => {
  host.remove();
});

// A point just beyond the x domain's end, where the plot cuts it.
const values = table({ x: [0, 1, 2], y: [1, 2, 3], name: ["a", "b", "c"] });
const options = (clip: Clip | undefined, renderer: "svg" | "canvas") => ({
  renderer,
  legend: false,
  x: { domain: [0, 1.98] as [number, number] },
  marks: [
    point(values, {
      x: "x",
      y: "y",
      fill: "#ff0000",
      radius: 6,
      ...(clip !== undefined && { clip }),
    }),
  ],
});

/** The clip paths cutting `node`: its own and its groups'. */
const cuts = (node: Element) => {
  const ids: string[] = [];
  for (let at: Element | null = node; at && at.tagName !== "svg"; at = at.parentElement) {
    const clip = at.getAttribute("clip-path");
    if (clip) ids.push(clip.slice(5, -1));
  }
  return ids;
};

describe("clip", () => {
  it("cuts the SVG layer's data to the plot, to the chart, or not at all", () => {
    const fill = '[fill="#ff0000"]';
    const plotted = createChart(host, options(undefined, "svg"));
    const [plot] = cuts(host.querySelector(fill)!);
    expect(plot).toMatch(/-clip-\d+$/);
    plotted.update(options(false, "svg"));
    plotted.render();
    expect(cuts(host.querySelector(fill)!)).toEqual([]);
    plotted.update(options("chart", "svg"));
    plotted.render();
    const [chart] = cuts(host.querySelector(fill)!);
    expect(chart).toMatch(/-clip-chart$/);
    const box = host.querySelector(`[id="${chart}"] rect`)!;
    expect([box.getAttribute("width"), box.getAttribute("height")]).toEqual(["600", "300"]);
    plotted.update(options(undefined, "svg"));
    plotted.render();
    expect(cuts(host.querySelector(fill)!)).toEqual([plot]);
    plotted.destroy();
  });

  it("cuts text when its mark asks, and leaves it whole by default", () => {
    const labels = (clip?: Clip) =>
      text(values, {
        x: "x",
        y: "y",
        label: { field: "name", style: { color: "#00aa00" } },
        ...(clip !== undefined && { clip }),
      });
    const chart = createChart(host, { renderer: "canvas", legend: false, marks: [labels()] });
    expect(cuts(host.querySelector('[fill="#00aa00"]')!)).toEqual([]);
    chart.update({ renderer: "canvas", legend: false, marks: [labels("plot")] });
    chart.render();
    expect(cuts(host.querySelector('[fill="#00aa00"]')!)[0]).toMatch(/-clip-\d+$/);
    chart.destroy();
  });

  it("paints canvas data beyond the plot only when not cut to it", () => {
    for (const clip of [undefined, false, "chart"] as const) {
      const chart = createChart(host, options(clip, "canvas"));
      const scene = modelOf(chart).scene(estimateText);
      const { plot, marks } = scene.panels[0]!;
      const { coords } = marks.find((m) => m.kind === "point") as PointGeometry;
      const [x, y] = [coords[4]!, coords[5]!];
      expect(x).toBeGreaterThan(plot.x + plot.width);
      const canvas = host.querySelector("canvas")!;
      const ratio = canvas.width / host.clientWidth;
      const pixel = canvas
        .getContext("2d")!
        .getImageData(Math.round(x * ratio), Math.round(y * ratio), 1, 1).data;
      const red = pixel[0] === 255 && pixel[1] === 0 && pixel[3] === 255;
      expect([clip, red]).toEqual([clip, clip !== undefined]);
      chart.destroy();
    }
  });

  it("exports fluid SVG from a mounted chart", () => {
    const chart = createChart(host, options(false, "svg"));
    const svg = chart.toSVG({
      sizing: "fluid",
      preserveAspectRatio: "none",
      strokeScaling: "fixed",
    });
    expect(svg).toMatch(
      /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" id="[^"]+" viewBox="0 0 600 300" preserveAspectRatio="none"/,
    );
    expect(svg).toContain("vector-effect:non-scaling-stroke");
    // Inlined into the page, it leaves the page's other SVGs alone.
    const other = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    other.innerHTML = '<path d="M0 0H10" stroke="black"/>';
    const inlined = document.createElement("div");
    inlined.innerHTML = svg;
    document.body.append(other, inlined);
    expect(getComputedStyle(other.firstElementChild!).getPropertyValue("vector-effect")).toBe(
      "none",
    );
    expect(getComputedStyle(inlined.querySelector("path")!).getPropertyValue("vector-effect")).toBe(
      "non-scaling-stroke",
    );
    // Ids that start with a digit select their document too.
    const { renderer: _, ...rest } = options(false, "svg");
    inlined.innerHTML = renderToSVG({
      ...rest,
      width: 200,
      height: 100,
      strokeScaling: "fixed",
      idPrefix: "123",
    });
    expect(getComputedStyle(inlined.querySelector("path")!).getPropertyValue("vector-effect")).toBe(
      "non-scaling-stroke",
    );
    other.remove();
    inlined.remove();
    expect(() => chart.toSVG({ sizing: "full" as "fluid" })).toThrow(
      'toSVG sizing: expected "fixed" or "fluid"',
    );
    chart.destroy();
  });
});
