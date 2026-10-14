// What charts and exports reach prepared fonts (herceg/fonts) through:
// methods keyed by symbols, so the core carries none of the font code and
// charts without fonts load none of it.

import type { MeasureText } from "../layout/text.ts";
import type { Fonts } from "./registry.ts";

/** The key of what a PDF export embeds (see `Fonts`). */
export const EMBED_FONTS: unique symbol = Symbol("herceg PDF font embedding");
/** The key of what a chart in a page measures with and waits for (see `Fonts`). */
export const USE_FONTS: unique symbol = Symbol("herceg fonts in a page");

/** Fonts as a chart in a page uses them. */
export interface PageFonts {
  /** Measures with the fonts where they cover the text, and with the chart's fallback where not. */
  readonly measure: MeasureText;
  /**
   * Settles once the faces have loaded; undefined where the browser cannot
   * load them. Whenever faces load, charts in the document hear of it
   * (dom/measurers.ts).
   */
  readonly loaded: Promise<void> | undefined;
}

/** Throws unless `fonts` is undefined or fonts from `prepareFonts`, naming `where` (such as "renderToSVG"). */
export function checkFonts(fonts: unknown, where: string): asserts fonts is Fonts | undefined {
  if (fonts !== undefined && typeof (fonts as Fonts | null)?.[USE_FONTS] !== "function")
    throw new TypeError(
      `${where} fonts: expected prepared fonts; wrap the font sources in prepareFonts(...) from herceg/fonts`,
    );
}
