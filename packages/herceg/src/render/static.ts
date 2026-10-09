import { estimateText, type MeasureText } from "../layout/text.ts";
import { type ChartConfig, ChartModel, STATIC_RASTER_RATIO } from "../model/model.ts";
import { NO_PAGE } from "./fallbacks.ts";
import { pngDataUrl } from "./png.ts";
import { renderSvg } from "./svg.ts";

export interface StaticOptions extends ChartConfig {
  width: number;
  height: number;
  /**
   * Prefix for element ids in the output. Charts embedded in the same
   * document need distinct prefixes; by default each call gets a new one.
   */
  idPrefix?: string;
  /**
   * Text measurement. Defaults to built-in Helvetica metrics so output is the
   * same on every machine; pass a canvas-based measurer to match a browser.
   */
  measureText?: MeasureText;
}

let renders = 0;

/** Renders a chart to a standalone SVG string. Needs no DOM. */
export function renderToSVG(options: StaticOptions): string {
  const model = new ChartModel(options, NO_PAGE);
  model.setSize(options.width, options.height, 1, STATIC_RASTER_RATIO);
  const scene = model.scene(options.measureText ?? estimateText);
  return renderSvg(scene, {
    idPrefix: options.idPrefix ?? `herceg-svg-${++renders}`,
    encodeRaster: (mark) => pngDataUrl(mark.columns, mark.rows, mark.pixels),
    ...(options.description ? { description: options.description } : {}),
  });
}
