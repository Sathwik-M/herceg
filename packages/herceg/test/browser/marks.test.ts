import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { table } from "../../src/data/table.ts";
import { createChart } from "../../src/dom/chart.ts";
import { bar } from "../../src/marks/bar.ts";
import { custom } from "../../src/marks/custom.ts";
import { heatmap } from "../../src/marks/heatmap.ts";
import { line } from "../../src/marks/line.ts";
import type { Mark } from "../../src/marks/mark.ts";
import { point } from "../../src/marks/point.ts";
import { region } from "../../src/marks/region.ts";
import { rule } from "../../src/marks/rule.ts";
import { text } from "../../src/marks/text.ts";
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

  it("follows the pointer along y over horizontal bars", async () => {
    const sales = table({ region: ["North", "South"], a: [1, 2], b: [3, 4] });
    const chart = createChart(host, { marks: [bar(sales, { x: ["a", "b"], y: "region" })] });
    const y = chart.model.yScale()!;
    const [left, right] = chart.model.xScale()!.range;
    hover(chart.root, right - 4, y.map(1) + 3);
    await frame();
    const tooltip = tooltipOf(chart.root);
    expect(tooltip.style.display).toBe("block");
    expect(tooltip.textContent).toBe("Southa2b4");
    // The crosshair runs across the plot through the band's center.
    const crosshair = chart.root.querySelector("svg line[visibility=visible]")!;
    expect(Number(crosshair.getAttribute("y1"))).toBeCloseTo(Math.round(y.map(1)) + 0.5, 3);
    expect(crosshair.getAttribute("y1")).toBe(crosshair.getAttribute("y2"));
    expect(Number(crosshair.getAttribute("x1"))).toBe(left);
    expect(Number(crosshair.getAttribute("x2"))).toBe(right);
    chart.destroy();
  });

  it("keeps horizontal bar charts out of shared x cursors", async () => {
    const other = document.createElement("div");
    other.style.cssText = "width:600px;height:300px";
    document.body.append(other);
    const sales = table({ region: ["North", "South"], a: [1, 2] });
    const series = table({ t: [0, 1, 2], v: [1, 2, 3] });
    const interaction = { sync: "hbar" };
    // An explicit nearest-point mode keeps the bars' cursor along y.
    const bars = createChart(host, {
      marks: [bar(sales, { x: "a", y: "region" })],
      interaction,
      tooltip: { mode: "nearest" },
    });
    const lines = createChart(other, { marks: [line(series, { x: "t", y: "v" })], interaction });
    const visibleCrosshair = (root: Element) => root.querySelector("svg line[visibility=visible]");
    hover(bars.root, bars.model.xScale()!.map(1), bars.model.yScale()!.map(0));
    await frame();
    expect(visibleCrosshair(bars.root)).not.toBeNull();
    expect(visibleCrosshair(lines.root)).toBeNull();
    hover(lines.root, lines.model.xScale()!.map(1), 100);
    await frame();
    expect(visibleCrosshair(lines.root)).not.toBeNull();
    bars.root.dispatchEvent(new PointerEvent("pointerleave"));
    await frame();
    expect(visibleCrosshair(bars.root)).toBeNull();
    bars.destroy();
    lines.destroy();
    other.remove();
  });

  it("draws regions with the data and text in the SVG overlay", () => {
    const series = table({ t: [0, 1, 2, 3], v: [1, 3, 2, 4] });
    const marks = [
      region({ x1: 1, x2: 2, label: "window" }),
      line(series, { x: "t", y: "v" }),
      text({ x: 3, y: 4, label: "last", anchor: "end", dx: -6 }),
    ];
    const svgChart = createChart(host, { marks, renderer: "svg" });
    const clipped = svgChart.root.querySelector("svg g[clip-path]")!;
    expect([...clipped.children].map((node) => node.getAttribute("data-kind"))).toEqual([
      "rect",
      "line",
    ]);
    const labels = () => [...host.querySelectorAll("svg text")].map((node) => node.textContent);
    expect(labels()).toEqual(expect.arrayContaining(["window", "last"]));
    svgChart.destroy();
    // On canvas the region is painted with the data; labels stay in SVG.
    const canvasChart = createChart(host, { marks, renderer: "canvas" });
    expect(canvasChart.root.querySelector("svg g[clip-path]")!.children).toHaveLength(0);
    expect(labels()).toEqual(expect.arrayContaining(["window", "last"]));
    canvasChart.destroy();
  });

  it("updates annotation text without rebuilding the axes or other annotations", () => {
    const series = table({ t: [0, 1, 2, 3], v: [1, 3, 2, 4] });
    const latest = table({ t: [3], v: [4] });
    const chart = createChart(host, {
      marks: [
        line(series, { x: "t", y: "v" }),
        rule({ y: 2, label: "limit" }),
        text(latest, { x: "t", y: "v", text: "v" }),
      ],
      y: { domain: [0, 5] },
    });
    const find = (label: string) =>
      [...host.querySelectorAll("svg text")].find((node) => node.textContent === label)!;
    const tick = find("5");
    const limit = find("limit");
    latest.set("v", 0, 3.5);
    chart.render();
    expect(find("3.5")).toBeDefined();
    expect(tick.isConnected).toBe(true);
    expect(limit.isConnected).toBe(true);
    chart.destroy();
  });

  it("paints custom shapes on a canvas and in SVG", () => {
    const series = table({ x: [0, 10], y: [0, 10] });
    const square = custom({
      draw({ x, y, rect }) {
        rect(x(4), y(6), x(6) - x(4), y(4) - y(6), { fill: "#ff0000" });
      },
    });
    const marks = [line(series, { x: "x", y: "y" }), square];
    const canvasChart = createChart(host, { marks, renderer: "canvas" });
    const canvas = host.querySelector("canvas")!;
    const ratio = canvas.width / canvasChart.root.clientWidth;
    const px = canvasChart.model.xScale()!.map(5) * ratio;
    const py = canvasChart.model.yScale()!.map(5) * ratio;
    const pixel = canvas.getContext("2d")!.getImageData(Math.round(px), Math.round(py), 1, 1).data;
    expect(Array.from(pixel)).toEqual([255, 0, 0, 255]);
    canvasChart.destroy();
    const svgChart = createChart(host, { marks, renderer: "svg" });
    expect(host.querySelector('svg g[clip-path] [data-kind="shapes"] path')).not.toBeNull();
    svgChart.destroy();
  });

  it("paints custom strokes with butt caps and opacity per paint, as SVG does", () => {
    const series = table({ x: [0, 10], y: [0, 10] });
    const shapes = custom({
      draw({ x, y, line: segment, rect }) {
        segment(x(2), y(7.3), x(4), y(7.3), { stroke: "#0000ff", strokeWidth: 10 });
        rect(x(6), y(4), x(8) - x(6), y(2) - y(4), {
          fill: "#ff0000",
          stroke: "#ff0000",
          strokeWidth: 6,
          opacity: 0.5,
        });
      },
    });
    const chart = createChart(host, {
      marks: [line(series, { x: "x", y: "y" }), shapes],
      renderer: "canvas",
    });
    const canvas = host.querySelector("canvas")!;
    const ratio = canvas.width / chart.root.clientWidth;
    const alpha = (x: number, y: number) =>
      canvas.getContext("2d")!.getImageData(Math.round(x * ratio), Math.round(y * ratio), 1, 1)
        .data[3];
    const sx = chart.model.xScale()!;
    const sy = chart.model.yScale()!;
    // No round cap reaches past the line's end (y = 7.3 is between grid lines).
    expect(alpha(sx.map(4) - 2, sy.map(7.3))).toBe(255);
    expect(alpha(sx.map(4) + 3, sy.map(7.3))).toBe(0);
    // Where stroke covers fill, each paints at half opacity: 1 - 0.5 * 0.5.
    expect(alpha(sx.map(6), sy.map(3))).toBeCloseTo(191, -1);
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

  it("loads the painter only for point clouds, and not again once unavailable", () => {
    // A geometry of another kind with a `cloud` field is not a point cloud.
    const lines = line(table({ x: [0, 1], y: [0, 1] }), { x: "x", y: "y" });
    const odd: Mark = {
      spec: lines.spec,
      table: lines.table,
      tooltip: "x",
      channelKind: (axis) => lines.channelKind(axis),
      series: (key, palette) => lines.series(key, palette),
      xExtent: (...args) => lines.xExtent(...args),
      yExtent: (...args) => lines.yExtent(...args),
      geometry: (series, frame) =>
        lines.geometry(series, frame).map((g) => Object.assign(g, { cloud: false })),
    };
    const chart = createChart(host, { marks: [odd] });
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
    expect(inspection?.value).toBe(5);
    expect(chart.toSVG()).toContain("<path");
    chart.destroy();
  });
});
