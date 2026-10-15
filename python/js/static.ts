// Static rendering inside an embedded JavaScript engine (no DOM): the Python
// package calls `hercegStatic.svg(specJson, base64Buffers, ...)`, and `pdf`, which
// returns the document as base64.

import type { SvgSizing } from "herceg";
import { type FontSource, prepareFonts } from "herceg/fonts";
import type { PdfExportOptions } from "herceg/pdf";
import { type ChartSpec, type PdfSpec, specToPDF, specToSnapshot, specToSVG } from "herceg/spec";
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
  svg(
    spec: string,
    buffers: string[],
    options = "[]",
    raster = false,
    sizing = "{}",
  ): string | { error: string } {
    return exported(() => {
      const sources = (JSON.parse(options) as (Omit<FontSource, "data"> & { data: string })[]).map(
        (font) => ({ ...font, data: decodeBase64(font.data) }),
      );
      const withFonts = <T>(run: () => T): T => {
        try {
          return run();
        } catch (error) {
          const problem = (error instanceof Error ? error.message : String(error))
            .replace(
              "; supply a covering font and fallback family, or set missingGlyph to a covered replacement",
              "",
            )
            .replace("; match the theme's font or add an explicit fallback family", "");
          throw new Error(
            `fonts: ${problem}; supply supported TrueType fonts covering the text and matching the theme's font`,
          );
        }
      };
      const registry = sources.length ? withFonts(() => prepareFonts(sources)) : undefined;
      const svg = specToSVG(JSON.parse(spec) as ChartSpec, buffers.map(decodeBase64), {
        ...(JSON.parse(sizing) as SvgSizing),
        // The fonts, with what they refuse reported in Python's words.
        ...(registry && {
          fonts: Object.create(registry, {
            measure: {
              value: (text: string, font: string) => withFonts(() => registry.measure(text, font)),
            },
          }) as typeof registry,
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
  /**
   * A snapshot for a page to show and a browser to hydrate, as JSON:
   * `options` hold its size, id prefix, locale, and zone, and its fonts as
   * base64.
   */
  snapshot(spec: string, buffers: string[], options = "{}"): string | { error: string } {
    return exported(() => {
      const { fonts, ...settings } = JSON.parse(options) as {
        fonts?: (Omit<FontSource, "data"> & { data: string })[];
      } & Record<string, unknown>;
      const prepared = fonts?.length
        ? prepareFonts(fonts.map((font) => ({ ...font, data: decodeBase64(font.data) })))
        : undefined;
      return JSON.stringify(
        specToSnapshot(JSON.parse(spec) as ChartSpec, buffers.map(decodeBase64), {
          ...(settings as { idPrefix: string }),
          ...(prepared && { fonts: prepared }),
        }),
      );
    });
  },
  pdf(spec: string, buffers: string[] | string[][], options = "{}"): string | { error: string } {
    const supplied = JSON.parse(options) as Omit<PdfExportOptions, "fonts"> & {
      fonts?: (Omit<FontSource, "data"> & { data: string })[];
    };
    const { fonts, fallback, missingGlyph, ...settings } = supplied;
    return exported(() => {
      const prepared = {
        ...settings,
        ...(fonts?.length && {
          fonts: prepareFonts(fonts.map((font) => ({ ...font, data: decodeBase64(font.data) }))),
          ...(fallback && { fallback }),
          ...(missingGlyph !== undefined && { missingGlyph }),
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
