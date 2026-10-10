import { type MeasureText, parseFont } from "../layout/text.ts";
import { num, type PdfObjectWriter } from "./pdf-document.ts";
import { subsetTrueType } from "./pdf-font-subset.ts";
import { checkSimpleText, graphemeClusters } from "./pdf-text.ts";
import { parseTrueType, type TrueTypeFont } from "./pdf-truetype.ts";

export interface PdfFontSource {
  /** Matches names in theme.font and custom-mark font family lists. */
  family: string;
  weight?: "normal" | "bold";
  data: Uint8Array;
}

export interface PdfFontOptions {
  /** Additional registered families, in coverage order. */
  fallback?: readonly string[];
  /** Replace each uncovered grapheme cluster with this covered standalone scalar. Default: throw. */
  missingGlyph?: string;
}

/** Reusable font configuration; each export gets independent glyph usage and subsets. */
export interface PdfFonts {
  createResolver(): PdfFontResolver;
}

/**
 * Prepares embedded fonts for renderToPDF or specToPDF. Parsing and glyph
 * usage are scoped to each export; font byte buffers are borrowed read-only.
 */
export function pdfFonts(fonts: readonly PdfFontSource[], options: PdfFontOptions = {}): PdfFonts {
  const sources = fonts.map((source) => ({ ...source }));
  const settings = { ...options, ...(options.fallback && { fallback: [...options.fallback] }) };
  return { createResolver: () => new PdfFontResolver({ ...settings, fonts: sources }) };
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
  face: EmbeddedFace;
  glyphs: ResolvedGlyph[];
  width: number;
}

/** Usage is added by the writer, never by the layout measurer. */
export class EmbeddedFace {
  readonly font: TrueTypeFont;
  readonly characters = new Map<number, number>();
  readonly codes = new Map<string, number>();
  readonly cidGlyphs = new Map<number, number>();
  readonly source: PdfFontSource;
  constructor(source: PdfFontSource) {
    this.source = source;
    this.font = parseTrueType(source.data);
  }
  advance(glyph: number): number {
    return Math.round((this.font.advances[glyph]! * 1000 * 1e6) / this.font.unitsPerEm) / 1e6;
  }
  encode(glyphs: readonly ResolvedGlyph[]): string {
    let out = "<";
    for (const { code, source, glyph } of glyphs) {
      let cid = this.codes.get(source);
      if (cid === undefined) {
        cid = this.codes.size + 1;
        if (cid > 65535) throw new Error("PDF face exceeds 65,535 used character codes");
        this.codes.set(source, cid);
        this.cidGlyphs.set(cid, glyph);
        this.characters.set(code, glyph);
      }
      out += cid.toString(16).padStart(4, "0");
    }
    return `${out}>`;
  }
  write(file: PdfObjectWriter, id: number): void {
    const subset = subsetTrueType(this.font, this.characters);
    const descendant = file.reserve();
    const descriptor = file.reserve();
    const program = file.reserve();
    const mapping = file.reserve();
    const unicode = file.reserve();
    const cidToGid = new Uint8Array((this.codes.size + 1) * 2);
    const view = new DataView(cidToGid.buffer);
    const widths: string[] = [];
    const unicodeEntries: string[] = [];
    for (const [source, cid] of this.codes) {
      const glyph = this.cidGlyphs.get(cid)!;
      view.setUint16(cid * 2, subset.glyphs.get(glyph)!);
      widths.push(num(this.advance(glyph), 6));
      const text = source;
      let utf16 = "";
      for (let i = 0; i < text.length; i++)
        utf16 += text.charCodeAt(i).toString(16).padStart(4, "0");
      unicodeEntries.push(`<${cid.toString(16).padStart(4, "0")}> <${utf16}>`);
    }
    let cmap =
      "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /HercegUnicode def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <ffff>\nendcodespacerange\n";
    for (let i = 0; i < unicodeEntries.length; i += 100) {
      const chunk = unicodeEntries.slice(i, i + 100);
      cmap += `${chunk.length} beginbfchar\n${chunk.join("\n")}\nendbfchar\n`;
    }
    cmap += "endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n";
    file.stream(
      unicode,
      "",
      Uint8Array.from(cmap, (char) => char.charCodeAt(0)),
    );
    file.stream(mapping, "", cidToGid);
    file.stream(program, `/Length1 ${subset.data.length}`, subset.data);
    const font = this.font;
    const repertoire = font.noSubset ? font.characterCodes() : this.characters.keys();
    let flags = 32;
    for (const code of repertoire) {
      if (!STANDARD_LATIN.test(String.fromCodePoint(code))) {
        flags = 4;
        break;
      }
    }
    flags |= (font.fixedPitch ? 1 : 0) | (font.italicAngle ? 64 : 0);
    const scaled = (value: number) => num((value * 1000) / font.unitsPerEm, 6);
    file.object(
      descriptor,
      `<< /Type /FontDescriptor /FontName /${subset.name} /Flags ${flags} /FontBBox [${font.bbox.map(scaled).join(" ")}] /ItalicAngle ${num(font.italicAngle, 6)} /Ascent ${scaled(font.ascent)} /Descent ${scaled(font.descent)} /CapHeight ${scaled(font.capHeight)} /StemV ${this.source.weight === "bold" ? 120 : 80} /FontFile2 ${program} 0 R >>`,
    );
    file.object(
      descendant,
      `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${subset.name} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descriptor} 0 R /DW 1000 /W [1 [${widths.join(" ")}]] /CIDToGIDMap ${mapping} 0 R >>`,
    );
    file.object(
      id,
      `<< /Type /Font /Subtype /Type0 /BaseFont /${subset.name} /Encoding /Identity-H /DescendantFonts [${descendant} 0 R] /ToUnicode ${unicode} 0 R >>`,
    );
  }
}

// PDF Reference, Appendix D.1: Latin repertoire, including space/hyphen aliases.
const STANDARD_LATIN = /^[\u0020-\u007e\u00a0-\u00ffıŁłŒœŠšŸŽžƒˆˇ˘˙˚˛˜˝–—‘’‚“”„†‡•…‰‹›⁄€™−ﬁﬂ]$/u;

/** One resolver per export; it retains no cross-document caches or subset state. */
export class PdfFontResolver {
  readonly measure: MeasureText;
  #families = new Map<string, EmbeddedFace[]>();
  #fallback: string[];
  #replacement: string | undefined;
  #orders = new Map<string, EmbeddedFace[]>();
  #segmenter =
    typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
      ? new Intl.Segmenter("und", { granularity: "grapheme" })
      : undefined;

  constructor(options: PdfFontOptions & { fonts: readonly PdfFontSource[] }) {
    if (!options.fonts?.length) throw new Error("PDF embedded fonts require at least one font");
    if (options.fonts.length > 64) throw new Error("PDF export supports at most 64 font faces");
    for (const source of options.fonts) {
      const family = familyName(source.family);
      if (!family) throw new Error("PDF font family must have a name");
      if (source.weight !== undefined && source.weight !== "normal" && source.weight !== "bold")
        throw new Error("PDF font weight must be normal or bold");
      const faces = this.#families.get(family) ?? [];
      if (faces.some((face) => (face.source.weight ?? "normal") === (source.weight ?? "normal")))
        throw new Error(
          `Duplicate PDF font face for ${source.family} (${source.weight ?? "normal"})`,
        );
      faces.push(new EmbeddedFace(source));
      this.#families.set(family, faces);
    }
    this.#fallback = (options.fallback ?? []).map(familyName);
    for (const family of this.#fallback)
      if (!this.#families.has(family))
        throw new Error(`PDF fallback family ${family} is not registered`);
    this.#replacement = options.missingGlyph;
    if (this.#replacement !== undefined && Array.from(this.#replacement).length !== 1)
      throw new Error("PDF missingGlyph must be one covered Unicode scalar");
    if (this.#replacement !== undefined) checkSimpleText(this.#replacement);
    if (
      this.#replacement !== undefined &&
      /\p{Mark}|\p{Grapheme_Extend}|\p{Emoji_Modifier}/u.test(this.#replacement)
    )
      throw new Error(
        "PDF missingGlyph must be a standalone scalar, not a mark or grapheme extender",
      );
    this.measure = (text, font) => {
      const { size, bold, family } = parseFont(font);
      return this.resolve(text, family, bold).width * size;
    };
  }

  resolve(
    text: string,
    family: string,
    bold: boolean,
  ): { runs: GlyphRun[]; width: number; capHeight: number; ascent: number; descent: number } {
    checkSimpleText(text);
    const faces = this.#ordered(family, bold);
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
          `PDF export cannot position combining sequence ${JSON.stringify(sequence)}; use precomposed text or SVG/PNG`,
        );
      if (combining) checkSimpleText(normalized);
      let face = faces.find((candidate) =>
        [...original, ...codes].every((code) => candidate.font.glyph(code) !== 0),
      );
      if (!face && this.#replacement !== undefined) {
        sequence = this.#replacement;
        checkSimpleText(sequence);
        codes = [sequence.codePointAt(0)!];
        face = faces.find((candidate) => candidate.font.glyph(codes[0]!) !== 0);
      }
      if (!face) {
        const names = codes
          .map((code) => `U+${code.toString(16).toUpperCase().padStart(4, "0")}`)
          .join(" ");
        throw new Error(
          `PDF fonts do not cover ${names} in ${JSON.stringify(family)}; supply a covering font and fallback family, or set missingGlyph to a covered replacement`,
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

  #ordered(family: string, bold: boolean): EmbeddedFace[] {
    const key = `${bold}|${family}`;
    const cached = this.#orders.get(key);
    if (cached) return cached;
    const faces: EmbeddedFace[] = [];
    const names = [...familyList(family), ...this.#fallback];
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
        `PDF font family ${JSON.stringify(family)} is not registered; match theme.font or add an explicit fallback family`,
      );
    if (this.#orders.size < 256) this.#orders.set(key, faces);
    return faces;
  }
}

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
