import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { table } from "../../src/data/table.ts";
import { createChart } from "../../src/dom/chart.ts";
import { bar } from "../../src/marks/bar.ts";
import { heatmap } from "../../src/marks/heatmap.ts";
import { line } from "../../src/marks/line.ts";
import { point } from "../../src/marks/point.ts";
import { cloudPainter } from "../../src/render/webgl.ts";

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

describe("point clouds on the GPU", () => {
  const cloudTable = (n: number, scale = 1) => {
    // Most points at (1, 1); two at (8, 8) for overlap; one alone at (5, 5).
    const x = new Float64Array(n).fill(scale);
    const y = new Float64Array(n).fill(1);
    x[0] = 5 * scale;
    y[0] = 5;
    x[1] = x[2] = 8 * scale;
    y[1] = y[2] = 8;
    return table({ x, y });
  };
  const pixel = (chart: ReturnType<typeof createChart>, x: number, y: number) => {
    const canvas = chart.root.querySelector("canvas")!;
    const ratio = canvas.width / canvas.clientWidth;
    return canvas
      .getContext("2d")!
      .getImageData(
        Math.round(chart.model.xScale()!.map(x) * ratio),
        Math.round(chart.model.yScale()!.map(y) * ratio),
        1,
        1,
      ).data;
  };
  const painter = cloudPainter()!;
  let paints: boolean[] = [];
  const paint = painter.paint.bind(painter);
  beforeEach(() => {
    paints = [];
    painter.paint = (...args) => {
      const drawn = paint(...args);
      paints.push(drawn);
      return drawn;
    };
  });
  afterEach(() => {
    painter.paint = paint;
  });

  it("draws large point series with WebGL once the painter has loaded", async () => {
    const chart = createChart(host, {
      x: { domain: [0, 10], grid: false },
      y: { domain: [0, 10], grid: false },
      marks: [
        point(cloudTable(150_000), { x: "x", y: "y", r: 6, fill: "#000000", fillOpacity: 0.5 }),
      ],
    });
    // The painter loads on demand; until then the cloud is not drawn.
    expect(chart.loading).toBeDefined();
    expect(pixel(chart, 5, 5)[3]).toBe(0);
    await chart.loading;
    expect(paints).toEqual([true]);
    // One point at (5, 5); two coincident ones at (8, 8) blend to ~75%.
    expect(pixel(chart, 5, 5)[3]).toBeCloseTo(128, -1);
    expect(pixel(chart, 8, 8)[3]).toBeCloseTo(191, -1);
    expect(pixel(chart, 3, 3)[3]).toBe(0);
    chart.destroy();
  });

  it("releases uploads when the chart is destroyed", async () => {
    const before = painter.bytes;
    const chart = createChart(host, { marks: [point(cloudTable(150_000), { x: "x", y: "y" })] });
    await chart.loading;
    chart.render();
    expect(painter.bytes).toBe(before + 150_000 * 16);
    chart.destroy();
    expect(painter.bytes).toBe(before);
  });

  it("keeps precision for extreme values and resolves any CSS color", async () => {
    const chart = createChart(host, {
      x: { domain: [0, 10e100], grid: false },
      y: { domain: [0, 10], grid: false },
      marks: [
        point(cloudTable(150_000, 1e100), { x: "x", y: "y", r: 4, fill: "color(srgb 1 0 0)" }),
      ],
    });
    await chart.loading;
    expect(paints).toEqual([true]);
    expect(Array.from(pixel(chart, 5e100, 5))).toEqual([255, 0, 0, 255]);
    chart.destroy();
  });

  it("places points on the CPU when the GPU would lose precision or overflow", async () => {
    // One far-away point makes the data's span huge; zoomed near zero, the
    // GPU representation is too coarse, so the CPU draws the points.
    const far = cloudTable(150_000);
    far.set("x", 3, -1e16);
    const zoomed = createChart(host, {
      x: { domain: [4, 6], grid: false },
      y: { domain: [0, 10], grid: false },
      marks: [point(far, { x: "x", y: "y", r: 4, fill: "#000000" })],
    });
    await zoomed.loading;
    expect(paints).toEqual([false]);
    expect(pixel(zoomed, 5, 5)[3]).toBe(255);
    zoomed.destroy();
    paints = [];
    const huge = cloudTable(150_000);
    huge.set("x", 3, -1e308);
    huge.set("x", 4, 1e308);
    const overflow = createChart(host, {
      x: { domain: [0, 10], grid: false },
      y: { domain: [0, 10], grid: false },
      marks: [point(huge, { x: "x", y: "y", r: 4, fill: "#000000" })],
    });
    await overflow.loading;
    expect(paints).toEqual([false]);
    expect(pixel(overflow, 5, 5)[3]).toBe(255);
    overflow.destroy();
  });

  it("places points on the CPU when the GPU cannot draw them", async () => {
    const chart = createChart(host, {
      x: { domain: [0, 10], grid: false },
      y: { domain: [0, 10], grid: false },
      // Larger than any device's largest point sprite.
      marks: [point(cloudTable(150_000), { x: "x", y: "y", r: 600, fill: "#000000" })],
    });
    await chart.loading;
    expect(paints).toEqual([false]);
    expect(pixel(chart, 5, 5)[3]).toBe(255);
    chart.destroy();
  });

  it("does not load the painter when no series becomes a cloud", () => {
    const chart = createChart(host, {
      marks: [point(cloudTable(150_000), { x: "x", y: "y", sampling: "pixel" })],
    });
    expect(chart.loading).toBeUndefined();
    chart.destroy();
  });

  it("finds points under the pointer and exports them as SVG", async () => {
    const chart = createChart(host, {
      x: { domain: [0, 10] },
      y: { domain: [0, 10] },
      marks: [point(cloudTable(150_000), { x: "x", y: "y" })],
    });
    await chart.loading;
    const inspection = chart.model.inspect(
      chart.model.xScale()!.map(5),
      chart.model.yScale()!.map(5),
    );
    expect(inspection?.x).toBe(5);
    expect(chart.toSVG()).toContain("<path");
    chart.destroy();
  });
});
