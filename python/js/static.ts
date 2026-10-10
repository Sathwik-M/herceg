// Static rendering inside an embedded JavaScript engine (no DOM): the Python
// package calls `hercegStatic.svg(specJson, base64Buffers)`, and `pdf`, which
// returns the document as base64.

import { type PdfFontOptions, type PdfFontSource, pdfFonts } from "herceg/pdf";
import { type ChartSpec, specToPDF, specToSVG } from "herceg/spec";
import { decodeBase64, encodeBase64 } from "./buffers.ts";

(globalThis as { hercegStatic?: unknown }).hercegStatic = {
  svg(spec: string, buffers: string[]): string {
    return specToSVG(JSON.parse(spec) as ChartSpec, buffers.map(decodeBase64));
  },
  pdf(spec: string, buffers: string[], options = "{}"): string {
    const supplied = JSON.parse(options) as PdfFontOptions & {
      fonts?: (Omit<PdfFontSource, "data"> & { data: string })[];
    };
    const { fonts, ...rest } = supplied;
    if (!fonts?.length && (rest.fallback?.length || rest.missingGlyph !== undefined))
      throw new Error("PDF fallback and missingGlyph options require embedded fonts");
    return encodeBase64(
      specToPDF(JSON.parse(spec) as ChartSpec, buffers.map(decodeBase64), {
        ...(fonts?.length && {
          fonts: pdfFonts(
            fonts.map((font) => ({ ...font, data: decodeBase64(font.data) })),
            rest,
          ),
        }),
      }),
    );
  },
};
