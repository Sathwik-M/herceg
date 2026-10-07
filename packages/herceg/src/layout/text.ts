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

function fontSize(font: string): number {
  const match = /(\d+(?:\.\d+)?)px/.exec(font);
  return match ? Number(match[1]) : 12;
}

/**
 * Width estimate from Helvetica metrics, padded by 10% because the viewer's
 * font is unknown (system UI fonts run slightly wider). Reserving a little too
 * much space is better than clipping labels.
 */
export const estimateText: MeasureText = (text, font) => {
  let units = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    units += code >= 32 && code <= 126 ? WIDTHS[code - 32]! : code >= 0x2e80 ? 1000 : 556;
  }
  return (units / 1000) * fontSize(font) * 1.1;
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
