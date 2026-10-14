// A font registry: TrueType faces parsed once, and the widths of text set
// in them, shared by every output a chart draws. Browser charts measure
// with it and register its faces with the document (dom/fonts.ts), code
// that comes with the registry rather than the chart; SVG and PNG exports
// measure with it and name its families; PDF export embeds subsets of its
// faces (render/pdf-font-embed.ts). Text is set as browsers and resvg set
// it in the theme's family lists, glyph after glyph without kerning; PDF,
// which has no fallback of its own, may add fallback families and a
// replacement glyph.

import { claimFaces } from "../dom/font-claims.ts";
import { fallbackMeasure, registerFonts } from "../dom/fonts.ts";
import { type MeasureText, parseFont } from "../layout/text.ts";
import { PdfFontResolver } from "../render/pdf-font-embed.ts";
import { checkSimpleText, graphemeClusters } from "./clusters.ts";
import { EMBED_FONTS, type PageFonts, USE_FONTS } from "./prepared.ts";
import { parseTrueType, type TrueTypeFont } from "./truetype.ts";

export interface FontSource {
  /** Matches names in the theme's font and custom marks' font family lists. */
  family: string;
  weight?: "normal" | "bold";
  /** A TrueType font file; read, not copied, so it must not change afterward. */
  data: Uint8Array;
}

/** How a PDF export sets text the theme's families do not cover. */
export interface FontOptions {
  /** Registered families to set it in, in coverage order. */
  fallback?: readonly string[];
  /** Replace each uncovered grapheme cluster with this covered standalone scalar. Default: throw. */
  missingGlyph?: string;
}

/** How text is set: fallback families after a font's own, and a replacement for what none covers. */
export interface TextPolicy {
  readonly fallback: readonly string[];
  readonly replacement: string | undefined;
}

const OWN: TextPolicy = { fallback: [], replacement: undefined };

/**
 * Fonts made by `prepareFonts`: what charts measure their text with, and what
 * every output draws it in, so layout matches the drawing.
 */
export interface Fonts {
  /**
   * The width of `text` in CSS pixels, set in the faces of a CSS `font`'s
   * family list. Throws for text they do not cover and text that needs
   * shaping.
   */
  readonly measure: MeasureText;
  /** The faces as supplied, for registering them with a browser or a rasterizer. */
  readonly faces: readonly FontSource[];
  /**
   * A name unique to these fonts, which JSON writes for them instead of
   * their bytes: frameworks that compare options as JSON see other fonts
   * as a change, and the same fonts as none.
   */
  toJSON(): string;
  /** Per export: what a PDF embeds, its own subsets of the faces used, setting text as `options` say. */
  readonly [EMBED_FONTS]: (options?: FontOptions) => PdfFontResolver;
  /**
   * For a chart in `document`: claims the faces on the page (throwing, and
   * claiming none, when the page has another file for one), starts
   * registering them, and measures with them, and as the page draws it
   * (glyph after glyph) text they do not cover.
   */
  readonly [USE_FONTS]: (document: Document) => PageFonts;
}

let prepared = 0;

/** A parsed face and its source. */
export class Face {
  readonly source: FontSource;
  readonly font: TrueTypeFont;
  constructor(source: FontSource) {
    this.source = source;
    this.font = parseTrueType(source.data);
  }
  /** The advance of `glyph` in 1/1000 em, rounded once, so layout and PDF widths agree. */
  advance(glyph: number): number {
    return Math.round((this.font.advances[glyph]! * 1000 * 1e6) / this.font.unitsPerEm) / 1e6;
  }
}

export interface ResolvedGlyph {
  code: number;
  /** Original scalar, or full source cluster when NFC composes it to one glyph. */
  source: string;
  glyph: number;
  /** Advance in 1/1000 em, rounded once for both layout and /W. */
  advance: number;
}

export interface GlyphRun {
  face: Face;
  glyphs: ResolvedGlyph[];
  width: number;
}

/** Text as faces set it: runs of glyphs, and its width and vertical extents in ems. */
export interface ResolvedText {
  runs: GlyphRun[];
  width: number;
  capHeight: number;
  ascent: number;
  descent: number;
}

/**
 * Prepares fonts for charts and exports: `renderToSVG`, `renderToPDF`,
 * `specToSVG`, `specToPDF`, and `createChart` take them as `fonts`. Faces
 * are parsed once here; each PDF export embeds its own subsets.
 */
export function prepareFonts(sources: readonly FontSource[]): Fonts {
  return new FontRegistry(sources);
}

class FontRegistry implements Fonts {
  readonly measure: MeasureText;
  readonly faces: readonly FontSource[];
  readonly #name = `fonts ${++prepared}`;
  #families = new Map<string, Face[]>();
  #orders = new Map<string, Face[]>();
  #segmenter =
    typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
      ? new Intl.Segmenter("und", { granularity: "grapheme" })
      : undefined;

  constructor(sources: readonly FontSource[]) {
    if (!Array.isArray(sources) || !sources.length)
      throw new Error("fonts require at least one font");
    if (sources.length > 64) throw new Error("fonts support at most 64 font faces");
    this.faces = sources.map((source) => ({ ...source }));
    for (const source of this.faces) {
      const family = familyName(source.family);
      if (!family) throw new Error("font family must have a name");
      if (source.weight !== undefined && source.weight !== "normal" && source.weight !== "bold")
        throw new Error("font weight must be normal or bold");
      const faces = this.#families.get(family) ?? [];
      if (faces.some((face) => (face.source.weight ?? "normal") === (source.weight ?? "normal")))
        throw new Error(`Duplicate font face for ${source.family} (${source.weight ?? "normal"})`);
      faces.push(new Face(source));
      this.#families.set(family, faces);
    }
    // Charts measure the same labels scene after scene.
    const widths = new Map<string, number>();
    this.measure = (text, font) => {
      const key = `${font}|${text}`;
      let width = widths.get(key);
      if (width === undefined) {
        const { size, bold, family } = parseFont(font);
        width = this.resolve(text, family, bold).width * size;
        if (widths.size > 5000) widths.clear();
        widths.set(key, width);
      }
      return width;
    };
  }

  toJSON(): string {
    return this.#name;
  }

  [EMBED_FONTS](options: FontOptions = {}): PdfFontResolver {
    return new PdfFontResolver(this, this.policy(options));
  }

  [USE_FONTS](document: Document): PageFonts {
    claimFaces(document, this.faces);
    // A live chart keeps drawing text its fonts lack, in the faces the
    // browser falls back to, rather than refusing it as exports do; what the
    // fonts refused once is measured as the page draws it from then on.
    const refused = new Set<string>();
    const measure: MeasureText = (text, font) => {
      const key = `${font}|${text}`;
      if (!refused.has(key)) {
        try {
          return this.measure(text, font);
        } catch {
          if (refused.size > 5000) refused.clear();
          refused.add(key);
        }
      }
      return fallbackMeasure(document)(text, font);
    };
    return { measure, loaded: registerFonts(document, this.faces) };
  }

  /** How `options` say text is set, checked: fallback families these fonts have, and a covered standalone replacement. */
  policy({ fallback = [], missingGlyph: replacement }: FontOptions): TextPolicy {
    const families = fallback.map(familyName);
    for (const family of families)
      if (!this.#families.has(family))
        throw new Error(`fallback family ${family} is not registered`);
    if (replacement !== undefined && Array.from(replacement).length !== 1)
      throw new Error("missingGlyph must be one covered Unicode scalar");
    if (replacement !== undefined) checkSimpleText(replacement);
    if (
      replacement !== undefined &&
      /\p{Mark}|\p{Grapheme_Extend}|\p{Emoji_Modifier}/u.test(replacement)
    )
      throw new Error("missingGlyph must be a standalone scalar, not a mark or grapheme extender");
    return families.length || replacement !== undefined ? { fallback: families, replacement } : OWN;
  }

  /** Glyph runs of `text` in the faces for `family` (a CSS family list), then `policy`'s fallbacks. */
  resolve(text: string, family: string, bold: boolean, policy = OWN): ResolvedText {
    checkSimpleText(text);
    const faces = this.#ordered(family, bold, policy.fallback);
    const runs: GlyphRun[] = [];
    let units = 0;
    let capHeight = 0;
    let ascent = 0;
    let descent = 0;
    // NFC composition handles simple accents without mark positioning. The
    // selected face must cover the original scalars and the composed glyph;
    // ToUnicode retains the original sequence, including decomposed input.
    for (let sequence of graphemeClusters(text, this.#segmenter)) {
      const original = Array.from(sequence, (char) => char.codePointAt(0)!);
      const combining = /\p{Mark}/u.test(sequence);
      const normalized = combining ? sequence.normalize("NFC") : sequence;
      let codes = Array.from(normalized, (char) => char.codePointAt(0)!);
      if (combining && (codes.length !== 1 || /\p{Mark}/u.test(normalized)))
        throw new Error(
          `fonts cannot position combining sequence ${JSON.stringify(sequence)}; use precomposed text, or leave fonts out`,
        );
      if (combining) checkSimpleText(normalized);
      let face = faces.find((candidate) =>
        [...original, ...codes].every((code) => candidate.font.glyph(code) !== 0),
      );
      if (!face && policy.replacement !== undefined) {
        sequence = policy.replacement;
        codes = [sequence.codePointAt(0)!];
        face = faces.find((candidate) => candidate.font.glyph(codes[0]!) !== 0);
      }
      if (!face) {
        const names = codes
          .map((code) => `U+${code.toString(16).toUpperCase().padStart(4, "0")}`)
          .join(" ");
        throw new Error(
          `fonts do not cover ${names} in ${JSON.stringify(family)}; supply a covering font and fallback family, or set missingGlyph to a covered replacement`,
        );
      }
      let run = runs[runs.length - 1];
      if (!run || run.face !== face) {
        run = { face, glyphs: [], width: 0 };
        runs.push(run);
      }
      for (const code of codes) {
        const glyph = face.font.glyph(code);
        const advance = face.advance(glyph);
        run.glyphs.push({
          code,
          source: codes.length === 1 ? sequence : String.fromCodePoint(code),
          glyph,
          advance,
        });
        run.width += advance / 1000;
        units += advance;
      }
      const font = face.font;
      capHeight = Math.max(capHeight, font.capHeight / font.unitsPerEm);
      ascent = Math.max(ascent, font.ascent / font.unitsPerEm);
      descent = Math.min(descent, font.descent / font.unitsPerEm);
    }
    return { runs, width: units / 1000, capHeight, ascent, descent };
  }

  #ordered(family: string, bold: boolean, fallback: readonly string[]): Face[] {
    const key = `${bold}|${family}|${fallback.join()}`;
    const cached = this.#orders.get(key);
    if (cached) return cached;
    const faces: Face[] = [];
    const names = [...familyList(family), ...fallback];
    for (const name of names) {
      const registered = this.#families.get(name);
      if (!registered) continue;
      const weight = bold ? "bold" : "normal";
      const face =
        registered.find((candidate) => (candidate.source.weight ?? "normal") === weight) ??
        registered[0]!;
      if (!faces.includes(face)) faces.push(face);
    }
    if (!faces.length)
      throw new Error(
        `font family ${JSON.stringify(family)} is not registered; match the theme's font or add an explicit fallback family`,
      );
    if (this.#orders.size < 256) this.#orders.set(key, faces);
    return faces;
  }
}

export type { FontRegistry };

function familyName(name: string): string {
  return name
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim()
    .toLowerCase();
}

function familyList(list: string): string[] {
  return (list.match(/"[^"\n]*"|'[^'\n]*'|[^,"'\n]+/g) ?? []).map(familyName).filter(Boolean);
}
