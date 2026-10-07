import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { table } from "../../src/data/table.ts";
import { createChart } from "../../src/dom/chart.ts";
import { bar } from "../../src/marks/bar.ts";
import { heatmap } from "../../src/marks/heatmap.ts";
import { line } from "../../src/marks/line.ts";
import { point } from "../../src/marks/point.ts";

let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  host.style.cssText = "width:600px;height:300px";
  document.body.append(host);
});

afterEach(() => host.remove());

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

function hover(target: Element, x: number, y: number) {
  const rect = target.getBoundingClientRect();
  target.dispatchEvent(
    new PointerEvent("pointermove", {
      bubbles: true,
      clientX: rect.left + x,
      clientY: rect.top + y,
    }),
  );
}

const tooltipOf = (root: Element) =>
  [...root.children].find(
    (el) => el.tagName === "DIV" && (el as HTMLElement).style.pointerEvents === "none",
  ) as HTMLElement;

describe("new marks in the browser", () => {
  it("shows the nearest scatter point under the pointer", async () => {
    const n = 5000;
    const pts = table({
      x: Float64Array.from({ length: n }, (_, i) => i % 100),
      y: Float64Array.from({ length: n }, (_, i) => Math.floor(i / 100)),
    });
    const chart = createChart(host, { marks: [point(pts, { x: "x", y: "y" })] });
    const x = chart.model.xScale()!;
    const y = chart.model.yScale()!;
    hover(chart.root, x.map(42) + 1, y.map(7) + 1);
    await frame();
    const tooltip = tooltipOf(chart.root);
    expect(tooltip.style.display).toBe("block");
    expect(tooltip.textContent).toContain("42");
    expect(tooltip.textContent).toContain("7");
    chart.destroy();
  });

  it("draws large heatmaps on canvas with a color legend and cell tooltips", async () => {
    const side = 100;
    const c = new Float64Array(side * side);
    const r = new Float64Array(side * side);
    const v = new Float64Array(side * side);
    for (let i = 0; i < side * side; i++) {
      c[i] = i % side;
      r[i] = Math.floor(i / side);
      v[i] = i;
    }
    const grid = table({ c, r, v });
    const chart = createChart(host, {
      marks: [heatmap(grid, { x: "c", y: "r", value: "v", label: "Index" })],
    });
    expect(chart.root.querySelector("canvas")).not.toBeNull();
    expect(chart.root.querySelector("linearGradient")).not.toBeNull();
    expect(chart.root.textContent).toContain("Index");
    const xs = chart.model.xScale()!;
    const ys = chart.model.yScale()!;
    hover(chart.root, xs.map(3), ys.map(2));
    await frame();
    expect(tooltipOf(chart.root).textContent).toContain("203");
    chart.destroy();
  });

  it("shows heatmap cell tooltips when nearest-x is requested", async () => {
    const cells = table({ c: ["a", "a"], r: ["low", "high"], v: [3, 42] });
    const chart = createChart(host, {
      tooltip: { mode: "nearest-x" },
      marks: [heatmap(cells, { x: "c", y: "r", value: "v" })],
    });
    hover(chart.root, chart.model.xScale()!.map(0), chart.model.yScale()!.map(1));
    await frame();
    const tooltip = tooltipOf(chart.root);
    expect(tooltip.style.display).toBe("block");
    expect(tooltip.textContent).toContain("42");
    chart.destroy();
  });

  it("toggles bar series from the legend", () => {
    const sales = table({ region: ["N", "S"], a: [1, 2], b: [3, 4] });
    const chart = createChart(host, { marks: [bar(sales, { x: "region", y: ["a", "b"] })] });
    const paths = () => chart.root.querySelectorAll("svg g[clip-path] path");
    expect(paths()).toHaveLength(2);
    chart.root.querySelectorAll("button")[0]!.click();
    chart.render();
    expect(paths()).toHaveLength(1);
    chart.destroy();
  });

  it("replaces SVG nodes when a series changes from a line to points", () => {
    const data = table({ x: [0, 1, 2], v: [1, 3, 2] });
    const chart = createChart(host, {
      renderer: "svg",
      marks: [line(data, { x: "x", y: "v", id: "s", stroke: "#ff0000", strokeWidth: 8 })],
    });
    const plot = () => chart.root.querySelector("svg g[clip-path]")!;
    expect(plot().querySelector("[stroke='#ff0000']")).not.toBeNull();
    chart.update({
      renderer: "svg",
      marks: [point(data, { x: "x", y: "v", id: "s", fill: "#0000ff" })],
    });
    chart.render();
    expect(plot().querySelector("[stroke]")).toBeNull();
    expect(plot().querySelector("[stroke-width]")).toBeNull();
    expect(plot().querySelector("[fill='#0000ff']")).not.toBeNull();
    chart.destroy();
  });

  it.each([
    ["fillOpacity", { fill: "#000000", fillOpacity: 0.5 }],
    ["a translucent color", { fill: "rgba(0, 0, 0, 0.5)" }],
  ])("darkens overlapping translucent points on canvas (%s)", (_, style) => {
    // Two points at (1, 1), one at (2, 2).
    const pts = table({ x: [1, 1, 2], y: [1, 1, 2] });
    const chart = createChart(host, {
      renderer: "canvas",
      // No grid lines under the sampled pixels.
      x: { domain: [0, 3], grid: false },
      y: { domain: [0, 3], grid: false },
      marks: [point(pts, { x: "x", y: "y", r: 6, ...style })],
    });
    const canvas = chart.root.querySelector("canvas")!;
    const ratio = canvas.width / canvas.clientWidth;
    const alphaAt = (x: number, y: number) =>
      canvas
        .getContext("2d")!
        .getImageData(
          Math.round(chart.model.xScale()!.map(x) * ratio),
          Math.round(chart.model.yScale()!.map(y) * ratio),
          1,
          1,
        ).data[3]!;
    // One point at 50% is about 128; two coincident ones composite to about 191.
    expect(alphaAt(2, 2)).toBeCloseTo(128, -1);
    expect(alphaAt(1, 1)).toBeCloseTo(191, -1);
    chart.destroy();
  });
});
