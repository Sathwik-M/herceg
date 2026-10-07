import type { Drawing, RasterGeometry, SvgContext, SvgElement } from "../scene/scene.ts";
import { markupOf, n } from "./markup.ts";

/**
 * Offscreen canvases holding raster pixels, by the pixels' buffer: the
 * chart model reuses one buffer per raster while its size allows, and a
 * dropped raster's canvas goes with its buffer.
 */
const sources = new WeakMap<ArrayBuffer, HTMLCanvasElement | OffscreenCanvas>();

/** The raster as an image, left out without an encoder. */
function rasterElements(mark: RasterGeometry, { encodeRaster }: SvgContext): SvgElement[] {
  if (!encodeRaster) return [];
  return [
    {
      tag: "image",
      attributes: {
        x: n(mark.x),
        y: n(mark.y),
        width: n(mark.width),
        height: n(mark.height),
        preserveAspectRatio: "none",
        style: "image-rendering:pixelated",
        href: encodeRaster(mark),
      },
    },
  ];
}

export const rasterDrawing: Drawing<RasterGeometry> = {
  size: (mark) => mark.columns * mark.rows,
  elements: rasterElements,
  svg: (mark, context) => markupOf(rasterElements(mark, context)),
  canvas(context, mark) {
    let source = sources.get(mark.pixels.buffer);
    if (!source || source.width !== mark.columns || source.height !== mark.rows) {
      source =
        typeof OffscreenCanvas !== "undefined"
          ? new OffscreenCanvas(mark.columns, mark.rows)
          : Object.assign(context.canvas.ownerDocument.createElement("canvas"), {
              width: mark.columns,
              height: mark.rows,
            });
      sources.set(mark.pixels.buffer, source);
    }
    const target = source.getContext("2d") as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
    if (!target) return;
    target.putImageData(new ImageData(mark.pixels, mark.columns, mark.rows), 0, 0);
    // Cells are flat colors; smoothing would blur their edges.
    const smoothing = context.imageSmoothingEnabled;
    context.imageSmoothingEnabled = false;
    context.drawImage(source, mark.x, mark.y, mark.width, mark.height);
    context.imageSmoothingEnabled = smoothing;
  },
};
