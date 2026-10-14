import { afterEach, beforeEach, expect, it } from "vitest";
import { table } from "../../src/data/table.ts";
import { createChart } from "../../src/dom/chart.ts";
import { area } from "../../src/marks/area.ts";
import { bar } from "../../src/marks/bar.ts";
import { line } from "../../src/marks/line.ts";
import { text } from "../../src/marks/text.ts";
import { modelOf } from "./helpers.ts";

let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  host.style.cssText = "width:600px;height:300px";
  document.body.append(host);
});
afterEach(() => host.remove());

it.each(["svg", "canvas"] as const)(
  "paints isolated rows as round dots in %s and static SVG",
  async (renderer) => {
    const data = table({ x: [0, 1, 2, 3, 4], y: [1, NaN, 3, NaN, 5] });
    for (const mark of [
      line(data, { x: "x", y: "y", strokeWidth: 6, stroke: "#ff0000" }),
      line(data, { y: "x", x: "y", orient: "y", curve: "step", strokeWidth: 6, stroke: "#ff0000" }),
      area(data, { x: "x", y: "y", strokeWidth: 6, fill: "#ff0000", line: false }),
    ]) {
      const chart = createChart(host, {
        marks: [mark],
        renderer,
        x: { show: false, domain: [0, 6], grid: false },
        y: { show: false, domain: [0, 6], grid: false },
        theme: { background: "transparent" },
      });
      const model = modelOf(chart);
      const x = model.xScale()!.map(mark.spec.orient === "y" ? 3 : 2);
      const y = model.yScale()!.map(mark.spec.orient === "y" ? 2 : 3);
      const image = new Image();
      const url = URL.createObjectURL(new Blob([chart.toSVG()], { type: "image/svg+xml" }));
      try {
        image.src = url;
        await image.decode();
        const raster = document.createElement("canvas");
        raster.width = 600;
        raster.height = 300;
        raster.getContext("2d")!.drawImage(image, 0, 0);
        const canvases =
          renderer === "canvas" ? [raster, chart.root.querySelector("canvas")!] : [raster];
        for (const canvas of canvases) {
          const ratio = canvas.width / 600;
          const pixel = (dx: number, dy: number) => [
            ...canvas
              .getContext("2d")!
              .getImageData(Math.floor((x + dx) * ratio), Math.floor((y + dy) * ratio), 1, 1).data,
          ];
          expect(pixel(0, 0)).toEqual([255, 0, 0, 255]);
          expect(pixel(4, 0)).toEqual(pixel(8, 8));
          expect(pixel(0, 4)).toEqual(pixel(8, 8));
        }
        if (renderer === "svg") {
          const path = chart.root.querySelector('path[stroke="#ff0000"]') as SVGPathElement;
          expect(path).not.toBeNull();
          expect(path.isPointInStroke(new DOMPoint(x, y))).toBe(true);
        }
      } finally {
        URL.revokeObjectURL(url);
        chart.destroy();
      }
    }
  },
);

it.each(["svg", "canvas"] as const)(
  "uses surface-colored halos and honors opt out in %s",
  (renderer) => {
    const chart = createChart(host, {
      renderer,
      marks: [text({ x: 1, y: 1, label: "note", fill: "#e06600" })],
    });
    const label = chart.root.querySelector('g[fill="#e06600"]')!;
    expect(label.getAttribute("stroke")).toBe("#ffffff");
    expect(label.getAttribute("stroke-opacity")).toBe("1");
    chart.update({ marks: [text({ x: 1, y: 1, label: "note", fill: "#e06600", halo: false })] });
    chart.render();
    expect(chart.root.querySelector('g[fill="#e06600"]')!.hasAttribute("stroke")).toBe(false);
    chart.destroy();
  },
);

it.each(["svg", "canvas"] as const)(
  "keeps category-colored bars centered with visible values in %s",
  (renderer) => {
    const data = table({
      zone: ["A", "B", "C", "D", "E", "F", "G"],
      value: [10, 20, 30, 40, 50, 60, 70],
    });
    const chart = createChart(host, {
      renderer,
      marks: [bar(data, { x: "zone", y: "value", series: "zone", labels: true })],
    });
    const model = modelOf(chart);
    const band = model.xScale()!;
    expect(chart.toSVG()).toContain(">70</text>");
    const at = model.inspect(band.map(3), model.yScale()!.map(20), "nearest-x")!;
    expect(at.points[0]!.label).toBe("D");
    expect(at.points[0]!.px).toBeCloseTo(band.map(3), 3);
    chart.destroy();
  },
);
