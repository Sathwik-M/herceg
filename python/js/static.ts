// Static rendering inside an embedded JavaScript engine (no DOM): the Python
// package calls `hercegStatic.svg(specJson, base64Buffers)`, and `pdf`, which
// returns the document as base64.

import { type PdfFontOptions, type PdfFontSource, pdfFonts } from "herceg/pdf";
import { type ChartSpec, specToPDF, specToSVG } from "herceg/spec";
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
  pdf(spec: string, buffers: string[], options = "{}"): string | { error: string } {
    const supplied = JSON.parse(options) as PdfFontOptions & {
      fonts?: (Omit<PdfFontSource, "data"> & { data: string })[];
    };
    const { fonts, ...rest } = supplied;
    return exported(() =>
      encodeBase64(
        specToPDF(JSON.parse(spec) as ChartSpec, buffers.map(decodeBase64), {
          ...(fonts?.length && {
            fonts: pdfFonts(
              fonts.map((font) => ({ ...font, data: decodeBase64(font.data) })),
              rest,
            ),
          }),
        }),
      ),
    );
  },
};
