// PDF export, imported as `herceg/pdf`. A separate entry point, so charts
// that never export PDF neither bundle nor (unbundled) load its code.

import type { Chart } from "./dom/handle.ts";
import { describeChart } from "./model/describe.ts";
import { type ChartConfig, ChartModel, STATIC_RASTER_RATIO } from "./model/model.ts";
import { EXPORT_SCENE, type ExportsScene } from "./render/export-scene.ts";
import { NO_PAGE } from "./render/fallbacks.ts";
import { renderPdf } from "./render/pdf.ts";
import type { PdfFontResolver, PdfFonts } from "./render/pdf-font-resolver.ts";
import { measurePdfText } from "./render/pdf-fonts.ts";
import type { Scene } from "./scene/scene.ts";

export type { PdfFontOptions, PdfFontSource, PdfFonts } from "./render/pdf-font-resolver.ts";
export { pdfFonts } from "./render/pdf-font-resolver.ts";

/** How a mounted chart is exported to PDF. */
export interface PdfExportOptions {
  /** Prepared embedded fonts from pdfFonts; omitted for standard PDF fonts. */
  fonts?: PdfFonts;
}

export interface PdfOptions extends ChartConfig, PdfExportOptions {
  /** CSS pixels; the page measures 0.75 points per pixel. */
  width: number;
  height: number;
}

/**
 * Renders a chart to a one-page vector PDF (version 1.4) sized to the
 * chart: a mounted chart (`createChart`'s) as it is now, at its size, with
 * its zoom and hidden series, or chart options, which need no DOM. Supply
 * fonts for Unicode text; without fonts it uses the standard PDF fonts and
 * WinAnsi encoding. Heatmaps become embedded images.
 */
export function renderToPDF(chart: Chart, options?: PdfExportOptions): Uint8Array;
export function renderToPDF(options: PdfOptions): Uint8Array;
export function renderToPDF(target: Chart | PdfOptions, settings?: PdfExportOptions): Uint8Array {
  const mounted = EXPORT_SCENE in target ? (target as unknown as ExportsScene) : undefined;
  const { fonts } = mounted ? (settings ?? {}) : (target as PdfOptions);
  if (Array.isArray(fonts))
    throw new TypeError(
      "PDF fonts must be prepared with pdfFonts(fonts, { fallback?, missingGlyph? }); wrap the font array in pdfFonts(...)",
    );
  const resolver = fonts?.createResolver();
  // A mounted chart's scene keeps the layout the page measured; options
  // are laid out with the PDF's own text measures.
  if (mounted) return mounted[EXPORT_SCENE]((scene, model) => pdfOf(scene, model, resolver));
  const options = target as PdfOptions;
  const model = new ChartModel(options, NO_PAGE);
  model.setSize(options.width, options.height, 1, STATIC_RASTER_RATIO);
  return pdfOf(model.scene(resolver?.measure ?? measurePdfText), model, resolver);
}

function pdfOf(scene: Scene, model: ChartModel, resolver: PdfFontResolver | undefined) {
  const { title, description, locale } = model.config;
  const summary = describeChart(model);
  return renderPdf(
    scene,
    {
      title,
      subject: description,
      language: locale,
      alt: [title, summary].filter(Boolean).join(" "),
      // The summary's prose is English even when visible text uses another locale.
      altLanguage: summary && locale?.split("-")[0]?.toLowerCase() !== "en" ? "en" : undefined,
    },
    resolver,
  );
}
