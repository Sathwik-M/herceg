// PDF export, imported as `herceg/pdf`. A separate entry point, so charts
// that never export PDF neither bundle nor (unbundled) load its code.

import type { Chart } from "./dom/handle.ts";
import { checkFonts, EMBED_FONTS } from "./fonts/prepared.ts";
import type { FontOptions, Fonts } from "./fonts/registry.ts";
import { guideCompiler } from "./guides/compile.ts";
import { describeChart } from "./model/describe.ts";
import { GUIDE_KIT, type GuideCompiler } from "./model/guides.ts";
import { type ChartConfig, ChartModel, STATIC_RASTER_RATIO } from "./model/model.ts";
import { titleText } from "./model/titles.ts";
import { EXPORT_FONTS, EXPORT_SCENE, type ExportsScene } from "./render/export-scene.ts";
import { NO_PAGE } from "./render/fallbacks.ts";
import { drawPdfPage } from "./render/pdf.ts";
import { type DocumentInfo, PdfWriter } from "./render/pdf-document.ts";
import { measurePdfText } from "./render/pdf-fonts.ts";
import { type PdfPageOptions, paperPage } from "./render/pdf-paper.ts";
import type { Scene } from "./scene/scene.ts";

export type { PdfPageOptions } from "./render/pdf-paper.ts";

/**
 * Paper, metadata, and fonts shared by every page of a PDF export; with
 * fonts, `fallback` and `missingGlyph` set text the theme's families do not
 * cover.
 */
export interface PdfExportOptions extends PdfPageOptions, FontOptions {
  /** Metadata only; visible chart titles are unchanged. */
  title?: string;
  /** Defaults to the description when exporting one chart. */
  subject?: string;
  /** Defaults to the chart locale for one chart, or en for multiple charts. */
  language?: string;
  /**
   * Fonts from `prepareFonts` (herceg/fonts) to embed, the subsets the pages use;
   * without them, text is set in the standard PDF fonts.
   */
  fonts?: Fonts;
}

export interface PdfOptions extends ChartConfig {
  /** CSS pixels; the page measures 0.75 points per pixel. */
  width: number;
  height: number;
}

/**
 * Vector PDF 1.4 of one chart or a nonempty list, one chart per page.
 * Mounted charts retain their size, zoom, hidden series, and highlighted
 * selection; static options need no DOM, and draw the selections their
 * `rowSelection` stores hold. Fonts are subset once across all pages;
 * heatmaps are images.
 */
/** The guide compiler, made on first use. */
let guides: GuideCompiler | undefined;
const compiler = () => {
  guides ??= guideCompiler(GUIDE_KIT);
  return guides;
};

export function renderToPDF(
  target: Chart | PdfOptions | readonly (Chart | PdfOptions)[],
  settings: PdfExportOptions = {},
): Uint8Array {
  const targets: readonly (Chart | PdfOptions)[] = Array.isArray(target)
    ? target
    : [target as Chart | PdfOptions];
  if (!targets.length)
    throw new RangeError("renderToPDF charts: expected at least one chart; supply a nonempty list");
  // The fonts charts measure with, a mounted chart's or the options': one set for the document.
  let fonts = settings.fonts;
  let charts: Fonts | undefined;
  for (const item of targets) {
    const supplied =
      EXPORT_SCENE in item
        ? (item as unknown as ExportsScene)[EXPORT_FONTS]
        : (item as PdfOptions).fonts;
    // Static options are laid out with the document's fonts; a mounted chart
    // was measured with its own, which its page must draw in.
    if (fonts && supplied && fonts !== supplied && EXPORT_SCENE in item)
      throw new TypeError(
        "renderToPDF fonts: a chart measures its text with other fonts; leave fonts out to use the chart's",
      );
    if (!fonts && charts && supplied && charts !== supplied)
      throw new TypeError(
        "renderToPDF fonts: conflicting chart font configurations; supply one fonts option for the whole PDF",
      );
    charts ??= supplied;
  }
  fonts ??= charts;
  checkFonts(fonts, "renderToPDF");
  const { fallback, missingGlyph } = settings;
  if (!fonts && (fallback !== undefined || missingGlyph !== undefined))
    throw new TypeError(
      `renderToPDF ${fallback !== undefined ? "fallback" : "missingGlyph"}: sets text in supplied fonts; give fonts or drop it`,
    );
  const resolver = fonts?.[EMBED_FONTS]({
    ...(fallback && { fallback }),
    ...(missingGlyph !== undefined && { missingGlyph }),
  });
  const writer = new PdfWriter();
  let singleInfo: DocumentInfo | undefined;
  const add = (
    scene: Scene,
    model: ChartModel,
    page = paperPage(scene.width, scene.height, settings, resolver),
  ) => {
    const { description, locale } = model.config;
    const title = titleText(model.config.title);
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
      const model = new ChartModel(options, NO_PAGE, compiler());
      model.setSize(options.width, options.height, 1, STATIC_RASTER_RATIO);
      // What the bound stores hold now is drawn as a mounted chart draws it.
      options.rowSelection?.highlight(model);
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
