/** Returns the width in CSS pixels of `text` drawn with a CSS `font`. */
export type MeasureText = (text: string, font: string) => number;

// Advance widths of ASCII 32..126 in Helvetica / Arial, in 1/1000 em. Used to
// lay out charts where no browser is available (server rendering, exports).
const WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
  611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
  222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

/** The size in pixels, weight, and family list of a CSS `font` such as "600 12px Inter, sans-serif". */
export function parseFont(font: string): { size: number; bold: boolean; family: string } {
  const match = /(\d+(?:\.\d+)?)px\s*(.*)$/.exec(font);
  const before = match ? font.slice(0, match.index) : "";
  return {
    size: match ? Number(match[1]) : 12,
    bold: /\b(bold|[6-9]00)\b/.test(before),
    family: match?.[2] ?? font,
  };
}

const MONOSPACE = /mono|courier|consolas|menlo|monaco/;
const SERIF = /(^|\s)(ui-)?serif$|times|georgia|garamond|palatino|cambria|baskerville/;
const SANS = /sans|helvetica|arial|system-ui|apple-system|segoe|roboto|verdana|tahoma/;

/**
 * What a CSS font family list draws with: the first family recognized as
 * monospace, serif, or sans-serif decides; sans-serif when none is.
 */
export function fontKind(family: string): "monospace" | "serif" | "sans" {
  for (const entry of family.toLowerCase().split(",")) {
    const name = entry.trim().replace(/^["']|["']$/g, "");
    if (MONOSPACE.test(name)) return "monospace";
    if (SERIF.test(name)) return "serif";
    if (SANS.test(name)) return "sans";
  }
  return "sans";
}

/**
 * Width estimate from Helvetica metrics (Courier's for monospace fonts),
 * padded by 10% because the viewer's font is unknown (system UI fonts run
 * slightly wider). Reserving a little too much space is better than
 * clipping labels; serif fonts, narrower, are estimated as Helvetica.
 */
export const estimateText: MeasureText = (text, font) => {
  const { size, family } = parseFont(font);
  const monospace = fontKind(family) === "monospace";
  let units = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    units +=
      code >= 0x2e80
        ? 1000
        : monospace
          ? 600
          : code >= 32 && code <= 126
            ? WIDTHS[code - 32]!
            : 556;
  }
  return (units / 1000) * size * 1.1;
};

/** Measures with a 2D canvas context, caching results per font and string. */
export function canvasMeasurer(context: {
  font: string;
  measureText(text: string): { width: number };
}): MeasureText {
  const cache = new Map<string, number>();
  return (text, font) => {
    const key = `${font}|${text}`;
    let width = cache.get(key);
    if (width === undefined) {
      if (context.font !== font) context.font = font;
      width = context.measureText(text).width;
      if (cache.size > 5000) cache.clear();
      cache.set(key, width);
    }
    return width;
  };
}

/** `text` shortened with an ellipsis, if needed, to at most `width` pixels. */
export function fitText(text: string, width: number, measure: MeasureText, font: string): string {
  if (measure(text, font) <= width) return text;
  // Cut between code points so surrogate pairs stay whole.
  const characters = Array.from(text);
  let lo = 0;
  let hi = characters.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (measure(`${characters.slice(0, mid).join("").trimEnd()}…`, font) <= width) lo = mid;
    else hi = mid - 1;
  }
  return `${characters.slice(0, lo).join("").trimEnd()}…`;
}

/**
 * A name fitted to `width` pixels, or "" when shortening it would leave
 * fewer than three characters, which say too little to be worth it.
 */
export function labelFor(name: string, width: number, measure: MeasureText, font: string): string {
  const text = fitText(name, width, measure, font);
  return text === name || Array.from(text).length >= 4 ? text : "";
}
