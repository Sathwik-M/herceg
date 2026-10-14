// Supplied fonts in a browser: their faces registered with the document
// once, for every chart using them, so text draws in what it was measured
// in. Part of the font registry's code (herceg/fonts), not the chart's.

import { checkSimpleText, graphemeClusters } from "../fonts/clusters.ts";
import type { FontSource } from "../fonts/registry.ts";
import { canvasMeasurer, type MeasureText, parseFont } from "../layout/text.ts";
import { faceKey } from "./font-claims.ts";
import { facesLoaded } from "./measurers.ts";

const SVG = "http://www.w3.org/2000/svg";

/** Each document's registered faces by family and weight, and when each has loaded. */
const registered = new WeakMap<Document, Map<string, Promise<void>>>();
/** Each document's measurer of text supplied fonts do not cover; dropped when faces load. */
const fallbacks = new WeakMap<Document, MeasureText>();
/**
 * Measures text a chart's supplied fonts do not cover, in the faces the
 * browser falls back to, as the chart draws it: glyph after glyph, without
 * kerning or ligatures. Canvases do not leave those out in every browser,
 * so grapheme clusters set without a shaper (`checkSimpleText`) are
 * measured alone on a canvas and summed, and runs of clusters that need
 * shaping are measured whole, in SVG set as the chart sets it.
 */
export function fallbackMeasure(document: Document): MeasureText {
  let measure = fallbacks.get(document);
  if (!measure) {
    const context = document.createElement("canvas").getContext("2d");
    if (context) context.fontKerning = "none";
    // Without a canvas (some test environments), glyphs are 0.6 em wide.
    const canvas: MeasureText = context
      ? canvasMeasurer(context)
      : (text, css) => text.length * 0.6 * parseFont(css).size;
    const segmenter =
      typeof Intl.Segmenter === "function"
        ? new Intl.Segmenter("und", { granularity: "grapheme" })
        : undefined;
    // Shaped runs, rare, are measured as SVG text unkerned and unligated:
    // in a document, laid out, then removed.
    const shaped: MeasureText = (run, css) => {
      const svg = document.createElementNS(SVG, "svg");
      svg.setAttribute("style", "position:absolute;visibility:hidden");
      const text = svg.appendChild(document.createElementNS(SVG, "text"));
      // The shorthand resets kerning and ligatures, so they are set after it.
      text.style.font = css;
      text.style.fontKerning = "none";
      text.style.fontVariantLigatures = "none";
      text.textContent = run;
      document.documentElement.append(svg);
      const width = text.getComputedTextLength?.() ?? canvas(run, css);
      svg.remove();
      return width;
    };
    const widths = new Map<string, number>();
    measure = (text, css) => {
      const key = `${css}|${text}`;
      let width = widths.get(key);
      if (width === undefined) {
        width = 0;
        let run = "";
        for (const cluster of graphemeClusters(text, segmenter)) {
          try {
            checkSimpleText(cluster);
          } catch {
            run += cluster;
            continue;
          }
          if (run) width += shaped(run, css);
          run = "";
          width += canvas(cluster, css);
        }
        if (run) width += shaped(run, css);
        if (widths.size > 5000) widths.clear();
        widths.set(key, width);
      }
      return width;
    };
    fallbacks.set(document, measure);
  }
  return measure;
}

/** A face loaded in `document`: text the fonts fall back from is measured again, by every chart. */
function loaded(document: Document): void {
  fallbacks.delete(document);
  facesLoaded(document);
}

/**
 * Registers `faces` with `document`, each family and weight
 * once however many charts give it (`claimFaces` has checked they give the
 * same file); they stay registered for the page's life, as other charts and
 * the page's own text may draw with them. Resolves once they have loaded;
 * undefined where the browser has no font loading API.
 */
export function registerFonts(
  document: Document,
  faces: readonly FontSource[],
): Promise<void> | undefined {
  const FontFaceOf = document.defaultView?.FontFace;
  if (!FontFaceOf || !document.fonts) return undefined;
  let own = registered.get(document);
  if (!own) {
    own = new Map();
    registered.set(document, own);
  }
  const loads = faces.map((source) => {
    const key = faceKey(source);
    let ready = own.get(key);
    if (!ready) {
      const face = new FontFaceOf(
        source.family.trim().replace(/^["']|["']$/g, ""),
        // Font files arrive in ordinary buffers, which FontFace reads.
        source.data as Uint8Array<ArrayBuffer>,
        { weight: source.weight === "bold" ? "700" : "400" },
      );
      document.fonts.add(face);
      // A face that fails to load leaves its text to the browser's fallback.
      ready = face.load().then(
        () => loaded(document),
        () => undefined,
      );
      own.set(key, ready);
    }
    return ready;
  });
  return Promise.all(loads).then(() => {});
}
