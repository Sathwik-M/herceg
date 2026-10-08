// PDF export, imported as `herceg/pdf`. A separate entry point, so charts
// that never export PDF neither bundle nor (unbundled) load its code.

import { estimateText } from "./layout/text.ts";
import { type ChartConfig, ChartModel } from "./model/model.ts";
import { renderPdf } from "./render/pdf.ts";

export interface PdfOptions extends ChartConfig {
  /** CSS pixels; the page measures 0.75 points per pixel. */
  width: number;
  height: number;
}

/**
 * Renders a chart to a one-page vector PDF (version 1.4) sized to the
 * chart. Needs no DOM. The layout is that of `renderToSVG`; text uses the
 * standard PDF fonts (Helvetica for sans-serif themes), which cover Latin-1
 * and common punctuation, and heatmaps become embedded images.
 */
export function renderToPDF(options: PdfOptions): Uint8Array {
  const model = new ChartModel(options);
  model.setSize(options.width, options.height, 1);
  return renderPdf(model.scene(estimateText), {
    title: options.title,
    subject: options.description,
    language: options.locale,
  });
}
