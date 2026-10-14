// Embedded fonts of one PDF export: the glyphs its pages use, from faces a
// font registry parsed, written as subset CID fonts once the pages are done.

import type { Face, FontRegistry, GlyphRun, ResolvedText, TextPolicy } from "../fonts/registry.ts";
import type { MeasureText } from "../layout/text.ts";
import { parseFont } from "../layout/text.ts";
import { num, type PdfObjectWriter } from "./pdf-document.ts";
import { subsetTrueType } from "./pdf-font-subset.ts";

/** A face as one export embeds it; usage is added by the writer, never by layout. */
export class PdfFace {
  readonly parsed: Face;
  readonly characters = new Map<number, number>();
  readonly codes = new Map<string, number>();
  readonly cidGlyphs = new Map<number, number>();
  constructor(face: Face) {
    const { fsType } = face.font;
    if (fsType & 0x0002)
      throw new Error(
        "PDF export cannot embed a font whose OS/2 fsType forbids embedding (restricted license)",
      );
    if (fsType & 0x0200)
      throw new Error(
        "PDF export cannot embed a font whose OS/2 fsType allows bitmap embedding only",
      );
    this.parsed = face;
  }
  encode(glyphs: GlyphRun["glyphs"]): string {
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
    const subset = subsetTrueType(this.parsed.font, this.characters);
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
      widths.push(num(this.parsed.advance(glyph), 6));
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
    const font = this.parsed.font;
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
      `<< /Type /FontDescriptor /FontName /${subset.name} /Flags ${flags} /FontBBox [${font.bbox.map(scaled).join(" ")}] /ItalicAngle ${num(font.italicAngle, 6)} /Ascent ${scaled(font.ascent)} /Descent ${scaled(font.descent)} /CapHeight ${scaled(font.capHeight)} /StemV ${this.parsed.source.weight === "bold" ? 120 : 80} /FontFile2 ${program} 0 R >>`,
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

/** Glyph runs as one export embeds them. */
export interface PdfGlyphRun {
  face: PdfFace;
  glyphs: GlyphRun["glyphs"];
  width: number;
}

/**
 * One PDF export's view of a font registry: its text resolution, with the
 * export's fallbacks and replacement (`policy`), and its own glyph usage.
 */
export class PdfFontResolver {
  readonly measure: MeasureText;
  readonly #registry: FontRegistry;
  readonly #policy: TextPolicy;
  readonly #faces = new Map<Face, PdfFace>();
  constructor(registry: FontRegistry, policy: TextPolicy) {
    this.#registry = registry;
    this.#policy = policy;
    this.measure =
      policy.fallback.length || policy.replacement !== undefined
        ? (text, font) => {
            const { size, bold, family } = parseFont(font);
            return registry.resolve(text, family, bold, policy).width * size;
          }
        : registry.measure;
  }

  resolve(
    text: string,
    family: string,
    bold: boolean,
  ): Omit<ResolvedText, "runs"> & { runs: PdfGlyphRun[] } {
    const resolved = this.#registry.resolve(text, family, bold, this.#policy);
    return {
      ...resolved,
      runs: resolved.runs.map((run) => ({ ...run, face: this.#embed(run.face) })),
    };
  }

  #embed(face: Face): PdfFace {
    let embedded = this.#faces.get(face);
    if (!embedded) {
      embedded = new PdfFace(face);
      this.#faces.set(face, embedded);
    }
    return embedded;
  }
}
