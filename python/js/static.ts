// Static rendering inside an embedded JavaScript engine (no DOM): the Python
// package calls `hercegStatic.svg(specJson, base64Buffers)`, and `pdf`, which
// returns the document as base64.

import {
  type PdfExportOptions,
  type PdfFontOptions,
  type PdfFontSource,
  pdfFonts,
} from "herceg/pdf";
import { type ChartSpec, type PdfSpec, specToPDF, specToSVG } from "herceg/spec";
import { decodeBase64, encodeBase64 } from "./buffers.ts";

/**
 * Runs an export. What herceg refuses (a spec it does not accept, a font it
 * cannot embed) is returned as `{ error }`, which Python raises with
 * herceg's message: thrown, it would reach Python as V8's report, with a line
 * of this bundle's source in it.
 */
function exported(run: () => string): string | { error: string } {
  try {
    return run();
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

(globalThis as { hercegStatic?: unknown }).hercegStatic = {
  svg(spec: string, buffers: string[]): string | { error: string } {
    return exported(() => specToSVG(JSON.parse(spec) as ChartSpec, buffers.map(decodeBase64)));
  },
  pdf(spec: string, buffers: string[] | string[][], options = "{}"): string | { error: string } {
    const supplied = JSON.parse(options) as PdfFontOptions &
      Omit<PdfExportOptions, "fonts"> & {
        fonts?: (Omit<PdfFontSource, "data"> & { data: string })[];
      };
    const { fonts, fallback, missingGlyph, ...settings } = supplied;
    return exported(() => {
      const prepared = {
        ...settings,
        ...(fonts?.length && {
          fonts: pdfFonts(
            fonts.map((font) => ({ ...font, data: decodeBase64(font.data) })),
            { ...(fallback && { fallback }), ...(missingGlyph !== undefined && { missingGlyph }) },
          ),
        }),
      };
      const input = JSON.parse(spec) as ChartSpec | ChartSpec[];
      return encodeBase64(
        Array.isArray(input)
          ? specToPDF(
              input.map(
                (spec, i): PdfSpec => ({
                  spec,
                  buffers: (buffers as string[][])[i]!.map(decodeBase64),
                }),
              ),
              prepared,
            )
          : specToPDF({ spec: input, buffers: (buffers as string[]).map(decodeBase64) }, prepared),
      );
    });
  },
};
