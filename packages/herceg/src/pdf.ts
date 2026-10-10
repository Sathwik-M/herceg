// PDF export, imported as `herceg/pdf`. A separate entry point, so charts
// that never export PDF neither bundle nor (unbundled) load its code.

import { describeChart } from "./model/describe.ts";
import { type ChartConfig, ChartModel, STATIC_RASTER_RATIO } from "./model/model.ts";
import { NO_PAGE } from "./render/fallbacks.ts";
import { renderPdf } from "./render/pdf.ts";
import type { PdfFonts } from "./render/pdf-font-resolver.ts";
import { measurePdfText } from "./render/pdf-fonts.ts";

export type { PdfFontOptions, PdfFontSource, PdfFonts } from "./render/pdf-font-resolver.ts";
export { pdfFonts } from "./render/pdf-font-resolver.ts";

export interface PdfOptions extends ChartConfig {
  /** CSS pixels; the page measures 0.75 points per pixel. */
  width: number;
  height: number;
  /** Prepared embedded fonts from pdfFonts; omitted for standard PDF fonts. */
  fonts?: PdfFonts;
}

/**
 * Renders a chart to a one-page vector PDF (version 1.4) sized to the
 * chart. Needs no DOM. Supply fonts for Unicode text; without fonts it uses
 * the standard PDF fonts and WinAnsi encoding. Layout and drawing use the
 * same advances in either path; heatmaps become embedded images.
 */
export function renderToPDF(options: PdfOptions): Uint8Array {
  if (Array.isArray(options.fonts))
    throw new TypeError(
      "PDF fonts must be prepared with pdfFonts(fonts, { fallback?, missingGlyph? }); wrap the font array in pdfFonts(...)",
    );
  const resolver = options.fonts?.createResolver();
  const model = new ChartModel(options, NO_PAGE);
  model.setSize(options.width, options.height, 1, STATIC_RASTER_RATIO);
  const scene = model.scene(resolver?.measure ?? measurePdfText);
  const summary = describeChart(model);
  return renderPdf(
    scene,
    {
      title: options.title,
      subject: options.description,
      language: options.locale,
      alt: [options.title, summary].filter(Boolean).join(" "),
      // The summary's prose is English even when visible text uses another locale.
      altLanguage:
        summary && options.locale?.split("-")[0]?.toLowerCase() !== "en" ? "en" : undefined,
    },
    resolver,
  );
}
