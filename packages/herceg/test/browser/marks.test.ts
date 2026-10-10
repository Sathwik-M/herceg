import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { table } from "../../src/data/table.ts";
import { createChart } from "../../src/dom/chart.ts";
import { estimateText } from "../../src/layout/text.ts";
import { area } from "../../src/marks/area.ts";
import { bar } from "../../src/marks/bar.ts";
import { boxplot } from "../../src/marks/boxplot.ts";
import { custom } from "../../src/marks/custom.ts";
import { graph } from "../../src/marks/graph.ts";
import { heatmap } from "../../src/marks/heatmap.ts";
import { type LineMark, line } from "../../src/marks/line.ts";
import type { MARK, Mark } from "../../src/marks/mark.ts";
import { point } from "../../src/marks/point.ts";
import { region } from "../../src/marks/region.ts";
import { rule } from "../../src/marks/rule.ts";
import { sankey } from "../../src/marks/sankey.ts";
import { text } from "../../src/marks/text.ts";
import { violin } from "../../src/marks/violin.ts";
import { renderToSVG } from "../../src/render/static.ts";
import { cloudPainter } from "../../src/render/webgl.ts";
import type { RasterGeometry } from "../../src/scene/scene.ts";
import { modelOf } from "./helpers.ts";

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
    const x = modelOf(chart).xScale()!;
    const y = modelOf(chart).yScale()!;
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
    const xs = modelOf(chart).xScale()!;
    const ys = modelOf(chart).yScale()!;
    hover(chart.root, xs.map(3), ys.map(2));
    await frame();
    expect(tooltipOf(chart.root).textContent).toContain("203");
    chart.destroy();
  });

  it("reduces heatmaps wider than the plot and reports the cell under the pointer", async () => {
    // 3,000 columns on a plot a few hundred pixels wide; column 1500 has no values.
    const [columns, rows] = [3000, 40];
    const c = Float64Array.from({ length: columns * rows }, (_, i) => i % columns);
    const r = Float64Array.from({ length: columns * rows }, (_, i) => Math.floor(i / columns));
    const v = Float64Array.from(c, (column) => (column === 1500 ? Number.NaN : column));
    const chart = createChart(host, {
      marks: [heatmap(table({ c, r, v }), { x: "c", y: "r", value: "v" })],
    });
    const canvas = chart.root.querySelector("canvas")!;
    const ratio = canvas.width / canvas.clientWidth;
    const xs = modelOf(chart).xScale()!;
    const ys = modelOf(chart).yScale()!;
    hover(chart.root, xs.map(1234), ys.map(7));
    await frame();
    const tooltip = tooltipOf(chart.root);
    expect(tooltip.style.display).toBe("block");
    expect(tooltip.textContent).toContain("1,234");
    // The pixel showing column 1500 is painted from its neighbors, but the
    // cell under the pointer has no value: no tooltip.
    const painted = canvas
      .getContext("2d")!
      .getImageData(Math.floor(xs.map(1500) * ratio), Math.floor(ys.map(7) * ratio), 1, 1);
    expect(painted.data[3]).toBe(255);
    hover(chart.root, xs.map(1500), ys.map(7));
    await frame();
    expect(tooltip.style.display).toBe("none");
    // One raster pixel per device pixel across, one per cell down.
    const raster = modelOf(chart).scene(estimateText).panels[0]!.marks[0] as RasterGeometry;
    expect(raster.columns).toBe(Math.floor(raster.width * ratio));
    expect(raster.columns).toBeLessThan(columns);
    expect(raster.rows).toBe(rows);
    chart.destroy();
  });

  it("draws every pixel of a reduced heatmap at fractional pixel ratios", async () => {
    const columns = 3000;
    const c = Float64Array.from({ length: columns }, (_, i) => i);
    const devicePixelRatio = Object.getOwnPropertyDescriptor(window, "devicePixelRatio")!;
    // A plot 541 CSS pixels wide spans a fractional number of device pixels.
    host.style.width = "561px";
    for (const ratio of [1, 1.25, 1.5, 1.75]) {
      Object.defineProperty(window, "devicePixelRatio", { value: ratio, configurable: true });
      const data = table({ c, r: new Float64Array(columns), v: new Float64Array(columns) });
      const chart = createChart(host, {
        renderer: "canvas",
        legend: false,
        x: { axis: false },
        y: { axis: false },
        marks: [
          heatmap(data, {
            x: "c",
            y: "r",
            value: "v",
            reduce: "max",
            colors: ["#000000", "#ff0000"],
            colorDomain: [0, 1],
          }),
        ],
      });
      // Every other pixel gets a hot cell; a pixel lost in drawing would
      // drop a red run or merge two.
      const across = (modelOf(chart).scene(estimateText).panels[0]!.marks[0] as RasterGeometry)
        .columns;
      expect(across).toBeLessThan(columns);
      // The first cell of pixel j is the first whose left edge is in it.
      const hot = new Set<number>();
      for (let j = 0; j < across; j += 2) hot.add(Math.ceil((j * columns) / across));
      data.setColumn(
        "v",
        Float64Array.from(c, (i) => (hot.has(i) ? 1 : 0)),
      );
      await frame();
      const canvas = chart.root.querySelector("canvas")!;
      const y = Math.floor(chart.toPixel(0, { axis: "y" })! * ratio);
      const line = canvas.getContext("2d")!.getImageData(0, y, canvas.width, 1).data;
      let runs = 0;
      for (let i = 0; i < canvas.width; i++) {
        const red = line[i * 4]! > 128 && line[i * 4 + 1]! < 64;
        const before = i > 0 && line[i * 4 - 4]! > 128 && line[i * 4 - 3]! < 64;
        if (red && !before) runs++;
      }
      expect(runs).toBe(Math.ceil(across / 2));
      chart.destroy();
    }
    Object.defineProperty(window, "devicePixelRatio", devicePixelRatio);
  });

  it("shows heatmap cell tooltips when nearest-x is requested", async () => {
    const cells = table({ c: ["a", "a"], r: ["low", "high"], v: [3, 42] });
    const chart = createChart(host, {
      tooltip: { mode: "nearest-x" },
      marks: [heatmap(cells, { x: "c", y: "r", value: "v" })],
    });
    hover(chart.root, chart.toPixel(0, { axis: "x" })!, chart.toPixel(1, { axis: "y" })!);
    await frame();
    const tooltip = tooltipOf(chart.root);
    expect(tooltip.style.display).toBe("block");
    expect(tooltip.textContent).toContain("42");
    chart.destroy();
  });

  it("draws encoded points on canvas, with symbol swatches and a size key", () => {
    const pts = table({
      x: [1, 2, 3, 4],
      y: [1, 2, 3, 4],
      pop: [10, 20, 40, 80],
      kind: ["a", "b", "a", "b"],
    });
    const chart = createChart(host, {
      renderer: "canvas",
      marks: [point(pts, { x: "x", y: "y", r: "pop", series: "kind", symbol: "kind" })],
    });
    const swatches = [...chart.root.querySelectorAll("button svg path")];
    expect(swatches).toHaveLength(2);
    // A circle is arcs; the second series' square is straight lines.
    expect(swatches[0]!.getAttribute("d")).toContain("a");
    expect(swatches[1]!.getAttribute("d")).toMatch(/^M[^a]*Z$/);
    expect(chart.root.textContent).toContain("pop");
    // Each point is painted in its own size: the canvas is not blank around the largest.
    const canvas = chart.root.querySelector("canvas")!;
    const context = canvas.getContext("2d")!;
    const ratio = canvas.width / canvas.clientWidth;
    const [px, py] = [chart.toPixel(4, { axis: "x" })!, chart.toPixel(4, { axis: "y" })!];
    const pixel = context.getImageData(Math.round((px + 8) * ratio), Math.round(py * ratio), 1, 1);
    expect(pixel.data[3]).toBeGreaterThan(0);
    chart.destroy();
  });

  it("fills where shapes of one color overlap, on canvas and in SVG", async () => {
    const kinds = ["k0", "k1", "k2", "k3", "k4", "k5", "k6", "k7"];
    // A circle (k0) on a square (k1), then on a triangle-down (k7): shapes
    // wound against each other would leave a hole where they overlap.
    for (const other of [1, 7]) {
      const at = (i: number) => (i === 0 || i === other ? 0 : 10);
      const pts = table({
        x: kinds.map((_, i) => at(i)),
        y: kinds.map((_, i) => at(i)),
        kind: kinds,
      });
      const mark = point(pts, { x: "x", y: "y", r: 20, symbol: "kind", fill: "#000000" });
      const chart = createChart(host, { renderer: "canvas", marks: [mark] });
      // Inside both shapes, above the grid line at y = 0.
      const x = chart.toPixel(0, { axis: "x" })!;
      const y = chart.toPixel(0, { axis: "y" })! - 8;
      const alpha = (c: HTMLCanvasElement, scale: number) =>
        c.getContext("2d")!.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1)
          .data[3];
      const canvas = chart.root.querySelector("canvas")!;
      expect(alpha(canvas, canvas.width / canvas.clientWidth)).toBe(255);
      // The same chart as static SVG, rasterized.
      const svg = renderToSVG({ width: 600, height: 300, marks: [mark] });
      const image = new Image();
      image.src = `data:image/svg+xml,${encodeURIComponent(svg)}`;
      await image.decode();
      const raster = document.createElement("canvas");
      raster.width = 600;
      raster.height = 300;
      raster.getContext("2d")!.drawImage(image, 0, 0);
      expect(alpha(raster, 1)).toBe(255);
      chart.destroy();
    }
  });

  it("draws areas stacked by a series field on SVG and canvas, with their rows in tooltips", async () => {
    const requests = () =>
      table(
        {
          minute: [0, 1, 2, 0, 2, 3, 1],
          count: [1, 2, 3, 10, 20, 30, 5],
          status: ["200", "200", "200", "500", "500", "500", "404"],
        },
        { maxRows: 9 },
      );
    const mark = (data: ReturnType<typeof requests>) =>
      area(data, { x: "minute", y: "count", series: "status", stack: true });
    const data = requests();
    const chart = createChart(host, { marks: [mark(data)] });
    const paths = () => chart.root.querySelectorAll('svg [data-kind="area"]');
    expect(paths()).toHaveLength(3);
    // The retained SVG draws what the chart exports.
    const svg = chart.toSVG();
    const drawn = [...paths()].map((path) => path.getAttribute("d"));
    for (const d of drawn) expect(svg).toContain(`d="${d}"`);
    // At minute 1 the 500s have no row: the tooltip names the series that do.
    const x = modelOf(chart).xScale()!;
    const y = modelOf(chart).yScale()!;
    hover(chart.root, x.map(1), y.map(4));
    await frame();
    expect(tooltipOf(chart.root).textContent).toBe("120024045");
    // Streamed rows restack the minutes they are at.
    data.append({ minute: [4, 4], count: [1, 2], status: ["200", "500"] });
    chart.render();
    expect([...paths()].map((path) => path.getAttribute("d"))).not.toEqual(drawn);
    chart.destroy();
    const canvas = createChart(host, { renderer: "canvas", marks: [mark(requests())] });
    const pixel = canvas.toPixel(1, { axis: "x" })!;
    const context = canvas.root.querySelector("canvas")!.getContext("2d")!;
    const scale = context.canvas.width / context.canvas.clientWidth;
    const at = (value: number) =>
      context.getImageData(
        Math.round(pixel * scale),
        Math.round(canvas.toPixel(value, { axis: "y" })! * scale),
        1,
        1,
      ).data[3];
    // Filled up to the 404s' top at minute 1 (7), and not above it.
    expect(at(6)).toBeGreaterThan(200);
    expect(at(12)).toBe(0);
    canvas.destroy();
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
    const y = modelOf(chart).yScale()!;
    const [left, right] = modelOf(chart).xScale()!.range;
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
    hover(bars.root, bars.toPixel(1, { axis: "x" })!, bars.toPixel(0, { axis: "y" })!);
    await frame();
    expect(visibleCrosshair(bars.root)).not.toBeNull();
    expect(visibleCrosshair(lines.root)).toBeNull();
    hover(lines.root, lines.toPixel(1, { axis: "x" })!, 100);
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
    const px = canvasChart.toPixel(5, { axis: "x" })! * ratio;
    const py = canvasChart.toPixel(5, { axis: "y" })! * ratio;
    const pixel = canvas.getContext("2d")!.getImageData(Math.round(px), Math.round(py), 1, 1).data;
    expect(Array.from(pixel)).toEqual([255, 0, 0, 255]);
    canvasChart.destroy();
    const svgChart = createChart(host, { marks, renderer: "svg" });
    expect(host.querySelector('svg g[clip-path] [data-kind="shapes"] path')).not.toBeNull();
    svgChart.destroy();
  });

  it("paints Sankey nodes and links on a canvas, with labels in SVG", () => {
    const flows = table({ from: ["a", "a"], to: ["b", "c"], v: [3, 1] });
    const chart = createChart(host, {
      marks: [sankey(flows, { source: "from", target: "to", value: "v" })],
      renderer: "canvas",
      theme: { palette: ["#ff0000"] },
    });
    const canvas = host.querySelector("canvas")!;
    const ratio = canvas.width / chart.root.clientWidth;
    const pixel = (key: unknown[]) => {
      const { px, py } = modelOf(chart).inspectItem(JSON.stringify(key))!.points[0]!;
      const at = [Math.round(px * ratio), Math.round(py * ratio)] as const;
      return Array.from(canvas.getContext("2d")!.getImageData(...at, 1, 1).data);
    };
    // Nodes are opaque; links are their source's color, translucent.
    expect(pixel([0, "a"])).toEqual([255, 0, 0, 255]);
    const [r, g, b, alpha] = pixel([0, "a", "b"]);
    expect([r, g, b]).toEqual([255, 0, 0]);
    expect(alpha! / 255).toBeCloseTo(0.35, 1);
    expect(host.querySelector("svg g[text-anchor='start']")!.textContent).toBe("a 4");
    chart.destroy();
  });

  it("paints network nodes and links on a canvas, with names in SVG", () => {
    // Equal values: both links are the widest, 6 px.
    const links = table({ from: ["a", "b"], to: ["b", "c"], v: [1, 1] });
    const chart = createChart(host, {
      marks: [graph(links, { source: "from", target: "to", value: "v" })],
      renderer: "canvas",
      theme: { palette: ["#ff0000"], muted: "#0000ff" },
    });
    const canvas = host.querySelector("canvas")!;
    const ratio = canvas.width / chart.root.clientWidth;
    const pixel = (key: unknown[]) => {
      const { px, py } = modelOf(chart).inspectItem(JSON.stringify(key))!.points[0]!;
      const at = [Math.round(px * ratio), Math.round(py * ratio)] as const;
      return Array.from(canvas.getContext("2d")!.getImageData(...at, 1, 1).data);
    };
    // Nodes are opaque; links are muted, translucent.
    expect(pixel([0, "b"])).toEqual([255, 0, 0, 255]);
    const [r, g, b, alpha] = pixel([0, "a", "b"]);
    expect([r, g, b]).toEqual([0, 0, 255]);
    expect(alpha! / 255).toBeCloseTo(0.45, 1);
    const names = [...host.querySelectorAll("svg text")].map((text) => text.textContent);
    expect(names).toEqual(expect.arrayContaining(["a", "b", "c"]));
    chart.destroy();
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
    const sx = modelOf(chart).xScale()!;
    const sy = modelOf(chart).yScale()!;
    // No round cap reaches past the line's end (y = 7.3 is between grid lines).
    expect(alpha(sx.map(4) - 2, sy.map(7.3))).toBe(255);
    expect(alpha(sx.map(4) + 3, sy.map(7.3))).toBe(0);
    // Where stroke covers fill, each paints at half opacity: 1 - 0.5 * 0.5.
    expect(alpha(sx.map(6), sy.map(3))).toBeCloseTo(191, -1);
    chart.destroy();
  });

  it("gives custom marks with series tooltips, keyboard stops, events, and legend toggles", async () => {
    const load = table({
      t: [0, 0, 1, 1, 2, 2],
      cpu: [1, 4, 2, 5, 3, 6],
      host: ["a", "b", "a", "b", "a", "b"],
    });
    const drawn: string[][] = [];
    const lollipops = custom(load, {
      x: "t",
      y: "cpu",
      series: "host",
      pointText: (row, format, s) => `${format.y(s.y[row]!)}%`,
      draw({ series, x, y, line: stem, circle }) {
        drawn.push(series.map((s) => s.label));
        for (const s of series) {
          for (let k = 0; k < s.length; k++) {
            const row = s.rows ? s.rows[k]! : k;
            stem(x(s.x[row]!), y(0), x(s.x[row]!), y(s.y[row]!), { stroke: s.color });
            circle(x(s.x[row]!), y(s.y[row]!), 4, { fill: s.color });
          }
        }
      },
    });
    const chart = createChart(host, { renderer: "svg", marks: [lollipops] });
    const hovers: (string | undefined)[] = [];
    chart.on("hover", ({ inspection }) => hovers.push(inspection?.points[1]?.text));
    hover(chart.root, chart.toPixel(1, { axis: "x" })! + 2, chart.toPixel(3, { axis: "y" })!);
    await frame();
    expect(tooltipOf(chart.root).textContent).toBe("1a2%b5%");
    expect(hovers).toEqual(["5%"]);
    // The keyboard steps through the first series, reporting each series at its x.
    chart.root.focus();
    const key = (k: string) =>
      chart.root.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    key("ArrowRight");
    key("ArrowRight");
    const live = chart.root.querySelector("[aria-live]")!;
    expect(live.textContent).toContain("a: 2%");
    expect(live.textContent).toContain("b: 5%");
    // Hiding b from the legend leaves it out of what draw receives.
    const buttons = chart.root.querySelectorAll("button");
    expect([...buttons].map((b) => b.textContent)).toEqual(["a", "b"]);
    buttons[1]!.click();
    chart.render();
    expect(drawn.at(-1)).toEqual(["a"]);
    expect(chart.root.querySelectorAll("svg g[clip-path] [data-kind='shapes'] path")).toHaveLength(
      6,
    );
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
          Math.round(chart.toPixel(x, { axis: "x" })! * ratio),
          Math.round(chart.toPixel(y, { axis: "y" })! * ratio),
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
        Math.round(chart.toPixel(x, { axis: "x" })! * ratio),
        Math.round(chart.toPixel(y, { axis: "y" })! * ratio),
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

  it("follows streaming rows by uploading only the new ones", async () => {
    const data = cloudTable(150_000);
    const rolling = table({ x: data.numbers("x"), y: data.numbers("y") }, { maxRows: 150_000 });
    const chart = createChart(host, {
      x: { domain: [0, 10], grid: false },
      y: { domain: [0, 10], grid: false },
      marks: [point(rolling, { x: "x", y: "y", r: 6, fill: "#000000", fillOpacity: 0.5 })],
    });
    await chart.loading;
    const proto = WebGL2RenderingContext.prototype;
    const whole = vi.spyOn(proto, "bufferData");
    const part = vi.spyOn(proto, "bufferSubData");
    const append = (x: number, y: number) => {
      rolling.append({ x: new Float64Array(1000).fill(x), y: new Float64Array(1000).fill(y) });
      chart.render();
    };
    // The first change uploads again, with room to grow; later ones only add rows.
    append(3, 3);
    const uploads = whole.mock.calls.length;
    expect(uploads).toBeGreaterThan(0);
    for (let tick = 0; tick < 20; tick++) append(1, 1);
    // Within the range uploaded (the data's, from 1 to 3, and half as much again each way).
    append(2.5, 2.5);
    expect(whole.mock.calls.length).toBe(uploads);
    expect(part.mock.calls.length).toBeGreaterThanOrEqual(21);
    // New points are drawn; the window has dropped the lone point at (5, 5).
    expect(pixel(chart, 3, 3)[3]).toBeGreaterThan(0);
    expect(pixel(chart, 2.5, 2.5)[3]).toBeGreaterThan(0);
    expect(pixel(chart, 5, 5)[3]).toBe(0);
    // Points past the range uploaded so far, and values replaced in place, upload again.
    append(1e6, 1);
    expect(whole.mock.calls.length).toBeGreaterThan(uploads);
    const after = whole.mock.calls.length;
    rolling.replace("y", 0, [2]);
    chart.render();
    expect(whole.mock.calls.length).toBeGreaterThan(after);
    whole.mockRestore();
    part.mockRestore();
    chart.destroy();
  });

  it("follows streaming rows split by a series field by uploading only each series' new ones", async () => {
    const n = 300_000;
    const data = cloudTable(n);
    const half = (count: number) => Array.from({ length: count }, (_, i) => (i % 2 ? "b" : "a"));
    const rolling = table(
      { x: data.numbers("x"), y: data.numbers("y"), kind: half(n) },
      { maxRows: n },
    );
    const chart = createChart(host, {
      x: { domain: [0, 10], grid: false },
      y: { domain: [0, 10], grid: false },
      marks: [point(rolling, { x: "x", y: "y", series: "kind", r: 6, fillOpacity: 0.5 })],
    });
    await chart.loading;
    // What keeps grouped rows current as the table streams loads after the first scene.
    chart.render();
    await vi.dynamicImportSettled();
    const proto = WebGL2RenderingContext.prototype;
    const whole = vi.spyOn(proto, "bufferData");
    const part = vi.spyOn(proto, "bufferSubData");
    const append = (x: number, y: number) => {
      // The series take unequal shares of each batch, and of each drop.
      rolling.append({
        x: new Float64Array(1000).fill(x),
        y: new Float64Array(1000).fill(y),
        kind: Array.from({ length: 1000 }, (_, i) => (i % 10 < 7 ? "a" : "b")),
      });
      chart.render();
    };
    // The first change groups the rows to follow and uploads them, the next
    // with room to grow; later ones only add each series' rows.
    append(3, 3);
    append(3, 3);
    const uploads = whole.mock.calls.length;
    expect(uploads).toBeGreaterThan(0);
    for (let tick = 0; tick < 20; tick++) append(1, 1);
    append(2.5, 2.5);
    expect(whole.mock.calls.length).toBe(uploads);
    // Two series, high and low halves each, every tick.
    expect(part.mock.calls.length).toBeGreaterThanOrEqual(21 * 2 * 2);
    expect(pixel(chart, 3, 3)[3]).toBeGreaterThan(0);
    expect(pixel(chart, 2.5, 2.5)[3]).toBeGreaterThan(0);
    // The window dropped the lone point at (5, 5).
    expect(pixel(chart, 5, 5)[3]).toBe(0);
    // Values replaced in place upload again.
    rolling.replace("y", 0, [2]);
    chart.render();
    expect(whole.mock.calls.length).toBeGreaterThan(uploads);
    whole.mockRestore();
    part.mockRestore();
    chart.destroy();
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
    // A geometry of another kind with a `cloud` field is not a point cloud,
    // drawn by an engine mark written for the test, as applications cannot.
    const lines = line(table({ x: [0, 1], y: [0, 1] }), { x: "x", y: "y" }) as LineMark;
    const odd: Omit<Mark, typeof MARK> = {
      spec: lines.spec,
      table: lines.table,
      tooltip: "x",
      channelKind: (axis) => lines.channelKind(axis),
      series: (key, palette) => lines.series(key, palette),
      xExtent: (series, log) => lines.xExtent(series, log),
      yExtent: (...args) => lines.yExtent(...args),
      geometry: (series, frame) =>
        lines.geometry(series, frame).map((g) => Object.assign(g, { cloud: false })),
    };
    const chart = createChart(host, { marks: [odd as Mark] });
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
    const inspection = chart.inspect(
      chart.toPixel(5, { axis: "x" })!,
      chart.toPixel(5, { axis: "y" })!,
    );
    expect(inspection?.value).toBe(5);
    expect(chart.toSVG()).toContain("<path");
    chart.destroy();
  });
});

describe("notched box plots", () => {
  it.each([false, true])(
    "fills the notch waist on Canvas and exports the retained SVG path (horizontal %s)",
    (horizontal) => {
      const data = table({
        group: ["a"],
        low: [0],
        q1: [25],
        median: [50],
        q3: [75],
        high: [100],
        count: [100],
      });
      const fields = {
        low: "low",
        q1: "q1",
        median: "median",
        q3: "q3",
        high: "high",
        count: "count",
        notch: true,
        fillOpacity: 1,
        fill: "#f00",
      } as const;
      const mark = boxplot(
        data,
        horizontal ? { y: "group", ...fields } : { x: "group", ...fields },
      );
      const svg = createChart(host, { renderer: "svg", marks: [mark] });
      const path = svg.root.querySelector('svg [data-kind="area"]')!;
      expect(path.getAttribute("d")).toMatch(/^M.*Z$/);
      expect(svg.toSVG()).toContain(`d="${path.getAttribute("d")}"`);
      svg.destroy();
      const chart = createChart(host, { renderer: "canvas", marks: [mark] });
      const model = modelOf(chart);
      const panel = model.panels()[0]!;
      const along = horizontal ? panel.y : panel.x;
      const across = horizontal ? panel.x : panel.y;
      const center = along.map(0);
      const half = (along.bandwidth! * 0.7) / 2;
      const context = chart.root.querySelector("canvas")!.getContext("2d")!;
      const ratio = context.canvas.width / context.canvas.clientWidth;
      const alpha = (offset: number, value: number) => {
        const [x, y] = horizontal
          ? [across.map(value), center + offset]
          : [center + offset, across.map(value)];
        return context.getImageData(Math.round(x * ratio), Math.round(y * ratio), 1, 1).data[3]!;
      };
      // The median waist is half as wide as the box. Just above q1 the full side fills.
      expect(alpha(half * 0.3, 50)).toBe(255);
      expect(alpha(half * 0.8, 50)).toBe(0);
      expect(alpha(half * 0.8, 30)).toBe(255);
      expect(alpha(half * 1.1, 30)).toBe(0);
      chart.destroy();
    },
  );
});

describe("split violins", () => {
  it.each([false, true])(
    "paints each half in its color and supports every interior (horizontal %s)",
    (horizontal) => {
      const data = table({
        g: Array(10).fill("a") as string[],
        s: [
          "first",
          "first",
          "first",
          "first",
          "first",
          "second",
          "second",
          "second",
          "second",
          "second",
        ],
        v: [1, 2, 3, 4, 5, 1, 2, 3, 4, 5],
      });
      for (const inner of ["box", "quartiles", "none"] as const) {
        const mark = violin(data, {
          ...(horizontal ? ({ x: "v", y: "g" } as const) : ({ x: "g", y: "v" } as const)),
          series: "s",
          split: true,
          inner,
          fillOpacity: 1,
        });
        const options = { marks: [mark], theme: { palette: ["#ff0000", "#0000ff"] } };
        const svg = createChart(host, { ...options, renderer: "svg" });
        const paths = [...svg.root.querySelectorAll('svg [data-kind="area"]')];
        expect(paths).toHaveLength(2);
        for (const path of paths) expect(svg.toSVG()).toContain(`d="${path.getAttribute("d")}"`);
        expect(svg.root.querySelectorAll('svg [stroke-dasharray="4 3"]').length).toBe(
          inner === "quartiles" ? 2 : 0,
        );
        svg.destroy();
        const dashes = vi.spyOn(CanvasRenderingContext2D.prototype, "setLineDash");
        const chart = createChart(host, { ...options, renderer: "canvas" });
        const model = modelOf(chart);
        const panel = model.panels()[0]!;
        const along = horizontal ? panel.y : panel.x;
        const across = horizontal ? panel.x : panel.y;
        const center = along.map(0);
        const context = chart.root.querySelector("canvas")!.getContext("2d")!;
        const ratio = context.canvas.width / context.canvas.clientWidth;
        const pixel = (side: number) => {
          const offset = side * along.bandwidth! * 0.1;
          const [x, y] = horizontal
            ? [across.map(3), center + offset]
            : [center + offset, across.map(3)];
          return Array.from(
            context.getImageData(Math.round(x * ratio), Math.round(y * ratio), 1, 1).data,
          );
        };
        expect(pixel(horizontal ? 1 : -1)).toEqual([255, 0, 0, 255]);
        expect(pixel(horizontal ? -1 : 1)).toEqual([0, 0, 255, 255]);
        if (inner === "quartiles") expect(dashes).toHaveBeenCalledWith([4, 3]);
        expect(chart.toSVG().includes('stroke-dasharray="4 3"')).toBe(inner === "quartiles");
        chart.destroy();
        dashes.mockRestore();
      }
    },
  );
});
