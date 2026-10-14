import { checkFonts } from "../fonts/prepared.ts";
import { estimateText, type MeasureText } from "../layout/text.ts";
import { describeChart } from "../model/describe.ts";
import { type ChartConfig, ChartModel, STATIC_RASTER_RATIO } from "../model/model.ts";
import { NO_PAGE } from "./fallbacks.ts";
import { pngDataUrl } from "./png.ts";
import { checkSizing, renderSvg, type SvgSizing } from "./svg.ts";

export interface StaticOptions extends ChartConfig, SvgSizing {
  width: number;
  height: number;
  /**
   * Prefix for element ids in the output. Charts embedded in the same
   * document need distinct prefixes; by default each call gets a new one.
   */
  idPrefix?: string;
  /**
   * Text measurement. Defaults to built-in Helvetica metrics so output is the
   * same on every machine; pass a canvas-based measurer to match a browser,
   * or `fonts` to measure with the fonts the SVG names.
   */
  measureText?: MeasureText;
}

let renders = 0;

/**
 * Renders a chart to a standalone SVG string. Needs no DOM. With
 * `rowSelection`, the selections its stores hold are drawn highlighted.
 */
export function renderToSVG(options: StaticOptions): string {
  checkSizing(options, "renderToSVG");
  checkFonts(options.fonts, "renderToSVG");
  if (options.fonts && options.measureText)
    throw new TypeError(
      "renderToSVG: fonts or measureText, not both; fonts measure their own text",
    );
  const model = new ChartModel(options, NO_PAGE);
  model.setSize(options.width, options.height, 1, STATIC_RASTER_RATIO);
  // What the bound stores hold now is drawn as a mounted chart draws it.
  options.rowSelection?.highlight(model);
  const scene = model.scene(options.fonts?.measure ?? options.measureText ?? estimateText);
  const { sizing, preserveAspectRatio, strokeScaling } = options;
  return renderSvg(scene, {
    sizing,
    preserveAspectRatio,
    strokeScaling,
    idPrefix: options.idPrefix ?? `herceg-svg-${++renders}`,
    unkerned: options.fonts !== undefined,
    encodeRaster: (mark) => pngDataUrl(mark.columns, mark.rows, mark.pixels),
    description: describeChart(model),
  });
}
