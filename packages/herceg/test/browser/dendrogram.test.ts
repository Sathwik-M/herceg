import { afterEach, expect, it } from "vitest";
import { table } from "../../src/data/table.ts";
import { SvgLayer } from "../../src/dom/svg-layer.ts";
import { estimateText } from "../../src/layout/text.ts";
import { dendrogram } from "../../src/marks/dendrogram.ts";
import { ChartModel } from "../../src/model/model.ts";
import { paintCanvas } from "../../src/render/canvas.ts";
import type { SegmentGeometry } from "../../src/scene/scene.ts";
import { clustermap } from "../fixtures/clustermap.ts";

let host: HTMLDivElement | undefined;
afterEach(() => host?.remove());

it.each([1, 2])(
  "draws the four-panel clustermap with aligned leaves in SVG and Canvas (DPR %i)",
  (dpr) => {
    const model = new ChartModel(clustermap());
    model.setSize(800, 600, dpr);
    for (const [width, height] of [
      [800, 600],
      [1000, 800],
    ]) {
      model.setSize(width!, height!, dpr);
      const scene = model.scene(estimateText);
      const [corner, top, left, matrix] = model.panels();
      expect(corner!.x.categories).toEqual([]);
      expect(corner!.y.categories).toEqual([]);
      expect(top!.y.categories).toEqual([]);
      expect(left!.x.categories).toEqual([]);
      expect(scene.panels[0]!.marks).toEqual([]);
      const layer = new SvgLayer(document, "clustermap");
      if (!host) {
        host = document.createElement("div");
        document.body.append(host);
      }
      host.replaceChildren(layer.svg);
      layer.render(scene, { marks: true });
      const paths = [...layer.svg.querySelectorAll('path[stroke="#ff0000"]')];
      expect(paths).toHaveLength(2);
      const coordinates = paths.map((path) =>
        (path.getAttribute("d")!.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number),
      );
      const [columns, rows] = coordinates;
      // The top tree's linkage leaves a,b,c,d stand over matrix bands 2,3,0,1.
      for (const [offset, band] of [
        [0, 2],
        [10, 3],
        [12, 0],
        [22, 1],
      ])
        expect(columns![offset!]!).toBeCloseTo(matrix!.x.map(band!), 1);
      // The left tree's r1,r2,r3 stand beside matrix row bands 1,2,0.
      for (const [offset, band] of [
        [1, 1],
        [11, 2],
        [13, 0],
      ])
        expect(rows![offset!]!).toBeCloseTo(matrix!.y.map(band!), 1);
      expect(top!.plot.width).toBe(matrix!.plot.width);
      expect(left!.plot.height).toBe(matrix!.plot.height);
      const canvas = document.createElement("canvas");
      paintCanvas(canvas, scene);
      const context = canvas.getContext("2d")!;
      // Test interior points on every nonzero segment of both dendrograms.
      for (const panel of [scene.panels[1]!, scene.panels[2]!]) {
        const geometry = panel.marks[0] as SegmentGeometry;
        for (let i = 0; i < geometry.count; i++) {
          const [x1, y1, x2, y2] = Array.from(geometry.coords.subarray(i * 4, i * 4 + 4));
          const x = (x1! + x2!) / 2;
          const y = (y1! + y2!) / 2;
          if (
            Math.abs(x2! - x1!) + Math.abs(y2! - y1!) < 2 ||
            x <= panel.plot.x ||
            x >= panel.plot.x + panel.plot.width ||
            y <= panel.plot.y ||
            y >= panel.plot.y + panel.plot.height
          )
            continue;
          const pixel = context.getImageData(Math.floor(x * dpr), Math.floor(y * dpr), 1, 1).data;
          expect(pixel[0]).toBeGreaterThan(pixel[1]! + 20);
        }
      }
    }
  },
);

it("draws no SVG or Canvas pixels at zero stroke width", () => {
  const model = new ChartModel({
    marks: [
      dendrogram(table({ first: [0], second: [1], height: [2] }), {
        first: "first",
        second: "second",
        height: "height",
        leaves: ["a", "b"],
        strokeWidth: 0,
        stroke: "#ff0000",
      }),
    ],
    x: { show: false, grid: false },
    y: { show: false, grid: false },
    theme: { background: "transparent" },
  });
  model.setSize(400, 200, 1);
  const scene = model.scene(estimateText);
  const layer = new SvgLayer(document, "zero-width-tree");
  layer.render(scene, { marks: true });
  expect(layer.svg.querySelectorAll('path[stroke="#ff0000"]')).toHaveLength(0);
  const canvas = document.createElement("canvas");
  paintCanvas(canvas, scene);
  const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
  expect(pixels.some((value, index) => index % 4 === 3 && value !== 0)).toBe(false);
});
