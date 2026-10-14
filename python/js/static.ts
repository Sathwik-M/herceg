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
import { rasterFont } from "./raster-font.ts";

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
  svg(spec: string, buffers: string[], options = "[]", raster = false): string | { error: string } {
    return exported(() => {
      const sources = (
        JSON.parse(options) as (Omit<PdfFontSource, "data"> & { data: string })[]
      ).map((font) => ({ ...font, data: decodeBase64(font.data) }));
      const withFonts = <T>(run: () => T): T => {
        try {
          return run();
        } catch (error) {
          const problem = (error instanceof Error ? error.message : String(error))
            .replace(
              "; supply a covering font and fallback family, or set missingGlyph to a covered replacement",
              "",
            )
            .replace("; match theme.font or add an explicit fallback family", "");
          throw new Error(
            `fonts: ${problem}; supply supported TrueType fonts covering the text and matching theme["font"]`,
          );
        }
      };
      const resolver = sources.length
        ? withFonts(() => pdfFonts(sources).createResolver())
        : undefined;
      const svg = specToSVG(JSON.parse(spec) as ChartSpec, buffers.map(decodeBase64), {
        ...(resolver && {
          measureText: (text, font) => withFonts(() => resolver.measure(text, font)),
        }),
      });
      return raster
        ? JSON.stringify({
            svg,
            fonts: withFonts(() => sources.map((source, i) => encodeBase64(rasterFont(source, i)))),
          })
        : svg;
    });
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
