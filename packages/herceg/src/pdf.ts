// PDF export, imported as `herceg/pdf`. A separate entry point, so charts
// that never export PDF neither bundle nor (unbundled) load its code.

import type { Chart } from "./dom/handle.ts";
import { describeChart } from "./model/describe.ts";
import { type ChartConfig, ChartModel, STATIC_RASTER_RATIO } from "./model/model.ts";
import { EXPORT_SCENE, type ExportsScene } from "./render/export-scene.ts";
import { NO_PAGE } from "./render/fallbacks.ts";
import { drawPdfPage } from "./render/pdf.ts";
import { type DocumentInfo, PdfWriter } from "./render/pdf-document.ts";
import type { PdfFonts } from "./render/pdf-font-resolver.ts";
import { measurePdfText } from "./render/pdf-fonts.ts";
import { type PdfPageOptions, paperPage } from "./render/pdf-paper.ts";
import type { Scene } from "./scene/scene.ts";

export type { PdfFontOptions, PdfFontSource, PdfFonts } from "./render/pdf-font-resolver.ts";
export { pdfFonts } from "./render/pdf-font-resolver.ts";
export type { PdfPageOptions } from "./render/pdf-paper.ts";

/** Paper, metadata, and fonts shared by every page of a PDF export. */
export interface PdfExportOptions extends PdfPageOptions {
  /** Metadata only; visible chart titles are unchanged. */
  title?: string;
  /** Defaults to the description when exporting one chart. */
  subject?: string;
  /** Defaults to the chart locale for one chart, or en for multiple charts. */
  language?: string;
  /** Prepared embedded fonts from pdfFonts; omitted for standard PDF fonts. */
  fonts?: PdfFonts;
}

export interface PdfOptions extends ChartConfig {
  /** Prepared embedded fonts; a shared configuration is used across pages. */
  fonts?: PdfFonts;
  /** CSS pixels; the page measures 0.75 points per pixel. */
  width: number;
  height: number;
}

/**
 * Vector PDF 1.4 of one chart or a nonempty list, one chart per page.
 * Mounted charts retain their size, zoom, and hidden series. Static options
 * need no DOM. Fonts are subset once across all pages; heatmaps are images.
 */
export function renderToPDF(
  target: Chart | PdfOptions | readonly (Chart | PdfOptions)[],
  settings: PdfExportOptions = {},
): Uint8Array {
  const targets: readonly (Chart | PdfOptions)[] = Array.isArray(target)
    ? target
    : [target as Chart | PdfOptions];
  if (!targets.length)
    throw new RangeError("renderToPDF charts: expected at least one chart; supply a nonempty list");
  let fonts = settings.fonts;
  if (!fonts) {
    for (const item of targets) {
      const supplied = (item as PdfOptions).fonts;
      if (fonts && supplied && fonts !== supplied)
        throw new TypeError(
          "renderToPDF fonts: conflicting chart font configurations; supply one fonts option for the whole PDF",
        );
      fonts ??= supplied;
    }
  }
  if (Array.isArray(fonts))
    throw new TypeError(
      "renderToPDF fonts: expected prepared fonts; wrap the font array in pdfFonts(...)",
    );
  const resolver = fonts?.createResolver();
  const writer = new PdfWriter();
  let singleInfo: DocumentInfo | undefined;
  const add = (
    scene: Scene,
    model: ChartModel,
    page = paperPage(scene.width, scene.height, settings, resolver),
  ) => {
    const { title, description, locale } = model.config;
    const summary = describeChart(model);
    const documentLanguage = settings.language ?? (targets.length > 1 ? "en" : locale);
    const language = locale ?? documentLanguage;
    const info: DocumentInfo = {
      title,
      subject: description,
      language,
      alt: [title, summary].filter(Boolean).join(" "),
      // Generated summaries use English even when visible labels use another locale.
      altLanguage:
        summary && documentLanguage?.split("-")[0]?.toLowerCase() !== "en" ? "en" : undefined,
    };
    writer.add(drawPdfPage(scene, page, language), info);
    if (targets.length === 1) singleInfo = info;
  };
  for (const item of targets) {
    if (EXPORT_SCENE in item) (item as unknown as ExportsScene)[EXPORT_SCENE](add);
    else {
      const options = item as PdfOptions;
      // Validate fitting before laying out a chart with invalid dimensions.
      const page = paperPage(options.width, options.height, settings, resolver);
      const model = new ChartModel(options, NO_PAGE);
      model.setSize(options.width, options.height, 1, STATIC_RASTER_RATIO);
      const scene = model.scene(resolver?.measure ?? measurePdfText);
      add(scene, model, page);
    }
  }
  return writer.toBytes({
    title: settings.title ?? singleInfo?.title,
    subject: settings.subject ?? singleInfo?.subject,
    language: settings.language ?? singleInfo?.language ?? (targets.length > 1 ? "en" : undefined),
  });
}
