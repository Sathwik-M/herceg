// Text that supplied fonts measure and draw without a shaper: glyphs one
// after another, left to right, in grapheme clusters.
// Admission is deliberately conservative: glyph coverage cannot supply
// shaping, mark positioning, or bidirectional ordering.
const SIMPLE_SCRIPT =
  /\p{Script=Latin}|\p{Script=Greek}|\p{Script=Cyrillic}|\p{Script=Armenian}|\p{Script=Georgian}|\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u;
const SHARED_SCRIPT = /\p{Script=Common}|\p{Script=Inherited}/u;
const SIMPLE_EXTENSIONS =
  /\p{Script_Extensions=Latin}|\p{Script_Extensions=Greek}|\p{Script_Extensions=Cyrillic}|\p{Script_Extensions=Armenian}|\p{Script_Extensions=Georgian}|\p{Script_Extensions=Han}|\p{Script_Extensions=Hiragana}|\p{Script_Extensions=Katakana}|\p{Script_Extensions=Hangul}|\p{Script_Extensions=Common}|\p{Script_Extensions=Inherited}/u;

// Selected Common/Inherited blocks, not a blanket exception for those scripts.
// Every scalar must also pass category, Script_Extensions, and cluster checks.
// Contour tone letters (U+02E5-02E9, U+A712-A716) ligate, and the vertical
// kana repeat marks (U+3031-3035) need vertical layout, so they are left out.
// See docs/architecture.md for the exact ranges and runtime Unicode policy.
const SIMPLE_SHARED_BLOCK =
  // biome-ignore lint/suspicious/noMisleadingCharacterClass: This tests one scalar; cluster composition is validated separately.
  /^[\u0020-\u007e\u00a0-\u00ff\u02b0-\u02e4\u02ea-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u2000-\u27ff\u2900-\u2bff\u2e00-\u2e7f\u3000-\u3030\u3036-\u303f\u3099-\u309c\u30a0-\u30ff\u3190-\u33ff\ua700-\ua711\ua717-\ua71f\ufe50-\ufe6f\uff01-\uff9f\uffe0-\uffee\u{1d300}-\u{1d37f}\u{1d400}-\u{1d7ff}\u{1f000}-\u{1faff}\u{1fb00}-\u{1fbff}]$/u;

export function checkSimpleText(text: string): void {
  const emojiSequence =
    /(?:\p{Emoji_Modifier_Base}\uFE0F?\p{Emoji_Modifier}|[\u{1f1e6}-\u{1f1ff}]{2}|\p{Emoji}[\u{e0020}-\u{e007e}]+\u{e007f}|\p{Extended_Pictographic}[\p{Mark}\p{Emoji_Modifier}]*\u200D[\p{Mark}]*\p{Extended_Pictographic})/u.exec(
      text,
    );
  if (emojiSequence) {
    const char =
      Array.from(emojiSequence[0]).find((char) =>
        /\p{Format}|\p{Default_Ignorable_Code_Point}|\p{Emoji_Modifier}/u.test(char),
      ) ?? emojiSequence[0];
    const code = char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
    throw new Error(
      `fonts cannot shape emoji sequences containing U+${code}; leave fonts out (SVG and PNG then draw with system fonts) or use a renderer that shapes text`,
    );
  }
  for (const char of text) {
    const code = char.codePointAt(0)!;
    let reason: string | undefined;
    if (/\p{Surrogate}/u.test(char)) reason = "invalid Unicode surrogate";
    else if (/\p{Format}/u.test(char)) reason = "format control";
    else if (/\p{Unassigned}/u.test(char)) reason = "unassigned code point";
    else if (/\p{Other}|\p{Line_Separator}|\p{Paragraph_Separator}/u.test(char))
      reason = "code point";
    else if (/\p{Default_Ignorable_Code_Point}|\p{Emoji_Modifier}/u.test(char))
      reason = "code point";
    else if (
      !SIMPLE_SCRIPT.test(char) &&
      !(code >= 0xac00 && code <= 0xd7a3) &&
      !(SHARED_SCRIPT.test(char) && SIMPLE_SHARED_BLOCK.test(char) && SIMPLE_EXTENSIONS.test(char))
    )
      reason = "code point";
    if (reason) {
      const name = `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
      throw new Error(
        `fonts cannot render ${reason} ${name} as left-to-right text without shaping; leave fonts out (SVG and PNG then draw with system fonts) or use a renderer that shapes text`,
      );
    }
  }
}

/** Native extended graphemes, or conservative grouping for the admitted repertoire. */
export function* graphemeClusters(text: string, segmenter?: Intl.Segmenter): Iterable<string> {
  if (segmenter) {
    for (const { segment } of segmenter.segment(text)) yield segment;
    return;
  }
  // Grapheme_Extend includes the Lm halfwidth kana marks FF9E/FF9F and
  // variation selectors. Other spacing modifier letters remain independent.
  // Joiners and emoji modifiers are grouped here but refused by admission.
  let cluster = "";
  let joined = false;
  for (const char of text) {
    if (cluster && (joined || /\p{Mark}|\p{Grapheme_Extend}|\p{Emoji_Modifier}|\u200d/u.test(char)))
      cluster += char;
    else {
      if (cluster) yield cluster;
      cluster = char;
    }
    joined = char === "\u200d";
  }
  if (cluster) yield cluster;
}
