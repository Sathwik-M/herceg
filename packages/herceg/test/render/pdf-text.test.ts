import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { graphemeClusters } from "../../src/fonts/clusters.ts";
import { EMBED_FONTS } from "../../src/fonts/prepared.ts";
import { parseTrueType } from "../../src/fonts/truetype.ts";
import { type FontOptions, type FontSource, prepareFonts } from "../../src/fonts.ts";
import type { PdfFontResolver } from "../../src/render/pdf-font-embed.ts";
import { subsetTrueType } from "../../src/render/pdf-font-subset.ts";

const data = new Uint8Array(
  readFileSync(new URL("../fixtures/pdf-fonts/sans.ttf", import.meta.url)),
);
const source = parseTrueType(data);
function face(family: string, text: string): FontSource {
  return {
    family,
    data: subsetTrueType(
      source,
      new Map(Array.from(text, (char, i) => [char.codePointAt(0)!, source.glyph(65 + (i % 2))])),
    ).data,
  };
}

/** One export's embedding of fonts prepared from `sources`. */
const embedder = (sources: readonly FontSource[], options?: FontOptions): PdfFontResolver =>
  prepareFonts(sources)[EMBED_FONTS](options);

describe.each(["native", "fallback"] as const)("PDF clusters with %s segmentation", (mode) => {
  function resolver(fonts: FontSource[], missingGlyph?: string): PdfFontResolver {
    if (mode === "fallback") vi.stubGlobal("Intl", undefined);
    try {
      return embedder(fonts, {
        fallback: fonts.slice(1).map((font) => font.family),
        ...(missingGlyph === undefined ? {} : { missingGlyph }),
      });
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it.each(["ﾞ", "ﾟ"])("keeps halfwidth kana and %s in one covering face", (mark) => {
    const cluster = `ｶ${mark}`;
    for (const missingGlyph of [undefined, "?"]) {
      const fonts = resolver(
        [face("Primary", "ｶ?"), face("Fallback", `${cluster}?`)],
        missingGlyph,
      );
      const { runs } = fonts.resolve(`${cluster}ｶ`, "Primary", false);
      expect(runs.map((run) => run.face.parsed.source.family)).toEqual(["Fallback", "Primary"]);
      expect(runs[0]!.glyphs.map((glyph) => glyph.source)).toEqual(["ｶ", mark]);
      expect(runs[0]!.face.encode(runs[0]!.glyphs)).toBe("<00010002>");
      expect(runs[0]!.face.cidGlyphs.get(1)).not.toBe(runs[0]!.face.cidGlyphs.get(2));
    }
  });

  it.each(["ﾞ", "ﾟ"])(
    "refuses split coverage or replaces the entire kana cluster with %s",
    (mark) => {
      const faces = [face("Primary", "ｶ?"), face("Fallback", `${mark}?`)];
      const fonts = resolver(faces);
      expect(() => fonts.resolve(`ｶ${mark}`, "Primary", false)).toThrow(/do not cover.*fallback/);
      const replaced = resolver(faces, "?").resolve(`ｶ${mark}ｶ`, "Primary", false);
      expect(replaced.runs).toHaveLength(1);
      expect(replaced.runs[0]!.glyphs.map((glyph) => glyph.source)).toEqual(["?", "ｶ"]);
      expect(() => resolver(faces, mark)).toThrow(/standalone scalar/);
    },
  );

  it("composes accents atomically and refuses unpositioned marks before replacement", () => {
    const fonts = resolver([face("Primary", "e?"), face("Fallback", "éé?")], "?");
    const { runs } = fonts.resolve("ée", "Primary", false);
    expect(runs.map((run) => run.face.parsed.source.family)).toEqual(["Fallback", "Primary"]);
    expect(runs[0]!.glyphs.map((glyph) => glyph.source)).toEqual(["é"]);
    for (const text of ["x́", "1\u20e3", "a\u1ab0"])
      expect(() => fonts.resolve(text, "Primary", false)).toThrow(/cannot position combining/);
  });

  it.each([
    ["a\u200dB", "U+200D"],
    ["★\ufe0f", "U+FE0F"],
    ["雪\u{e0100}", "U+E0100"],
    ["👍🏽", "U+1F3FD"],
    ["🇬🇧", "U+1F1EC"],
  ])(
    "refuses unsupported clusters %s with full or split coverage and replacement",
    (text, code) => {
      const chars = Array.from(text);
      for (const fonts of [
        [{ family: "Primary", data }],
        [face("Primary", `${text}?`)],
        [face("Primary", `${chars[0]}?`), face("Fallback", `${chars.slice(1).join("")}?`)],
      ])
        expect(() => resolver(fonts, "?").resolve(text, "Primary", false)).toThrow(code);
    },
  );
});

it("conservatively groups extenders and joiner continuations without Intl", () => {
  for (const text of ["é", "ｶﾞ", "ﾊﾟ", "a\u200dB", "★\ufe0f", "雪\u{e0100}", "👍🏽"])
    expect([...graphemeClusters(`${text}x`)]).toEqual([text, "x"]);
  // Ordinary spacing Lm letters are separate, just as in native segmentation.
  expect([...graphemeClusters("OʼBrien")]).toEqual(Array.from("OʼBrien"));
});

describe("PDF simple-text admission", () => {
  it.each([
    "AZéĀʰ",
    "αΩϿ",
    "Аяӿ",
    "Աֆ֏",
    "ႠაᲐ",
    "一雪龿𠀀",
    "あゔゝ",
    "アヿㇰ𛀀",
    "가힣",
    "A·B",
    "ä",
    "ᾶ",
    "ガ",
    "ｶﾞﾊﾟｰ",
    "012９①²Ⅳ",
    " €→∑⌀␀⑳─▉◆★✓⟿⤀⬛⸀",
    "、。〿㆐㌀﹐！￦",
    "𝌀𝟿🀀🌀😀🯀",
  ])("admits covered simple text %s", (text) => {
    const fonts = embedder([face("Fixture", text + text.normalize("NFC"))]);
    expect(fonts.resolve(text, "Fixture", false).width).toBeGreaterThan(0);
  });

  it.each([
    0x0000,
    0x001f,
    0x007f,
    0x009f,
    0x00ad,
    0x034f,
    0x0378,
    0x060c,
    0x0640,
    0x0700,
    0x0966,
    0x1100,
    0x115f,
    0x11ff,
    0x1802,
    0x1cd0,
    0x1dfa,
    0x200b,
    0x200d,
    0x2028,
    0x2029,
    0x202e,
    0x204f,
    0x2060,
    0x2800,
    0x2c00,
    0x2e30,
    0x2e3c,
    0x2e41,
    0x2ff0,
    0x3105,
    0xa960,
    0xac00 - 1,
    0xd7a4,
    // Contour tone letters ligate; vertical kana repeat marks need vertical layout.
    0x02e5,
    0x02e9,
    0x3031,
    0x3035,
    0xa712,
    0xa716,
    0xd7b0,
    0xd800,
    0xe000,
    0xfe00,
    0xfe10,
    0xfeff,
    0xff00,
    0xffa0,
    0xffa1,
    0xffdc,
    0xffef,
    0xffff,
    0x10100,
    0x1093f,
    0x10940,
    0x1095f,
    0x10960,
    0x10d40,
    0x10f70,
    0x11380,
    0x11f04,
    0x13000,
    0x1342f,
    0x13430,
    0x1343f,
    0x13440,
    0x13455,
    0x1345f,
    0x13460,
    0x16100,
    0x16d40,
    0x1bc00,
    0x1d380,
    0x1d800,
    0x1f3fb,
    0xe0100,
    0xf0000,
    0x10ffff,
  ])("refuses U+%s before covered/uncovered input can be replaced", (code) => {
    const text = String.fromCodePoint(code);
    const name = `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
    for (const font of [{ family: "Fixture", data }, face("Fixture", `${text}?`)]) {
      for (const missingGlyph of [undefined, "?"]) {
        const fonts = embedder([font], { ...(missingGlyph === undefined ? {} : { missingGlyph }) });
        expect(() => fonts.resolve(`A${text}B`, "Fixture", false)).toThrow(name);
        expect(() => fonts.resolve(text, "Unknown", false)).toThrow(name);
      }
      expect(() => embedder([font], { missingGlyph: text })).toThrow(name);
    }
  });

  it("allows replacement for uncovered admitted text", () => {
    const fonts = embedder([{ family: "Fixture", data }], { missingGlyph: "?" });
    for (const text of ["Ա", "ა", "雪", "あ", "ア", "가", "😀"])
      expect(fonts.resolve(text, "Fixture", false).runs[0]!.glyphs[0]!.source).toBe("?");
  });
});
