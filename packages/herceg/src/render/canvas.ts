// Paints grid lines and mark geometry into a 2D canvas. Axes, labels, and
// guides stay in SVG above the canvas, so text is crisp and accessible and
// pointer feedback never repaints the data. Each mark's geometry is painted
// by the drawing it carries.

import { gridStrokes } from "../scene/grid.ts";
import { type CloudOptions, clipOf, type RasterGeometry, type Scene } from "../scene/scene.ts";

/**
 * Paints the scene's grid and marks. The canvas backing store is sized to the
 * scene times its pixel ratio; drawing happens in CSS pixels.
 */
export function paintCanvas(
  canvas: HTMLCanvasElement,
  scene: Scene,
  clouds: CloudOptions = {},
  kerning = true,
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
  // Supplied fonts measure glyph by glyph: text is drawn so, unkerned and,
  // where the canvas can leave them out (Chrome), without ligatures.
  context.fontKerning = kerning ? "auto" : "none";
  context.textRendering = kerning ? "auto" : "optimizeSpeed";

  const { theme } = scene;
  if (theme.background !== "transparent") {
    context.fillStyle = theme.background;
    context.fillRect(0, 0, scene.width, scene.height);
  }
  for (const { plot, frame } of scene.panels) {
    if (!frame?.fill) continue;
    context.fillStyle = frame.fill;
    context.fillRect(plot.x, plot.y, plot.width, plot.height);
  }
  for (const { coords, paint } of gridStrokes(scene.panels, theme, ratio)) {
    context.beginPath();
    for (let i = 0; i < coords.length; i += 4) {
      context.moveTo(coords[i]!, coords[i + 1]!);
      context.lineTo(coords[i + 2]!, coords[i + 3]!);
    }
    context.strokeStyle = paint.stroke;
    // One-pixel grid lines are a device pixel wide, crisp at any ratio.
    context.lineWidth = paint.strokeWidth === 1 ? 1 / ratio : paint.strokeWidth;
    context.globalAlpha = paint.opacity;
    context.setLineDash([...paint.dash]);
    context.stroke();
  }
  context.setLineDash([]);
  context.globalAlpha = 1;

  // Guides are drawn by the SVG layer above the canvas.
  for (const { plot, marks } of scene.panels) {
    context.save();
    context.beginPath();
    context.rect(plot.x, plot.y, plot.width, plot.height);
    context.clip();
    const options = { plot, pixelRatio: ratio, clouds };
    for (const mark of marks) {
      const draw = mark.draw;
      if (!draw.guide && clipOf(mark) === "plot") draw.canvas(context, mark, options);
    }
    context.restore();
  }
  // Data its marks do not cut to the plot, which the canvas' own edges cut.
  // GPU clouds are drawn over their plot only, so these are placed on the CPU.
  const cpu: CloudOptions = {};
  for (const { plot, marks } of scene.panels) {
    for (const mark of marks) {
      const draw = mark.draw;
      if (!draw.guide && clipOf(mark) !== "plot")
        draw.canvas(context, mark, { plot, pixelRatio: ratio, clouds: cpu });
    }
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
