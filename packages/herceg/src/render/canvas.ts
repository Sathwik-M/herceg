// Paints grid lines and mark geometry into a 2D canvas. Axes, labels, and
// guides stay in SVG above the canvas, so text is crisp and accessible and
// pointer feedback never repaints the data. Each mark's geometry is painted
// by the drawing it carries.

import type { CloudOptions, RasterGeometry, Scene } from "../scene/scene.ts";

/**
 * Paints the scene's grid and marks. The canvas backing store is sized to the
 * scene times its pixel ratio; drawing happens in CSS pixels.
 */
export function paintCanvas(
  canvas: HTMLCanvasElement,
  scene: Scene,
  clouds: CloudOptions = {},
): void {
  const ratio = scene.pixelRatio;
  const width = Math.round(scene.width * ratio);
  const height = Math.round(scene.height * ratio);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext("2d");
  if (!context) return;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, width, height);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.lineJoin = "round";
  context.lineCap = "round";

  const { theme } = scene;
  if (theme.background !== "transparent") {
    context.fillStyle = theme.background;
    context.fillRect(0, 0, scene.width, scene.height);
  }
  for (const { plot, grid } of scene.panels) {
    if (grid.x.length + grid.y.length === 0) continue;
    context.beginPath();
    for (const y of grid.y) {
      const snapped = (Math.round(y * ratio) + 0.5) / ratio;
      context.moveTo(plot.x, snapped);
      context.lineTo(plot.x + plot.width, snapped);
    }
    for (const x of grid.x) {
      const snapped = (Math.round(x * ratio) + 0.5) / ratio;
      context.moveTo(snapped, plot.y);
      context.lineTo(snapped, plot.y + plot.height);
    }
    context.strokeStyle = theme.grid;
    context.lineWidth = 1 / ratio;
    context.stroke();
  }

  for (const { plot, marks } of scene.panels) {
    context.save();
    context.beginPath();
    context.rect(plot.x, plot.y, plot.width, plot.height);
    context.clip();
    const options = { plot, pixelRatio: ratio, clouds };
    for (const mark of marks) {
      const draw = mark.draw;
      // Guides are drawn by the SVG layer above the canvas.
      if (!draw.guide) draw.canvas(context, mark, options);
    }
    context.restore();
  }
}

/** Raster pixels as a PNG data URL, encoded by the browser through a canvas. */
export function canvasRasterUrl(mark: RasterGeometry, document: Document): string {
  const canvas = document.createElement("canvas");
  canvas.width = mark.columns;
  canvas.height = mark.rows;
  canvas.getContext("2d")?.putImageData(new ImageData(mark.pixels, mark.columns, mark.rows), 0, 0);
  return canvas.toDataURL();
}
