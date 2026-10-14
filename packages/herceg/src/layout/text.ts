// Text measurement and layout: widths of text in a font (estimated where
// no browser or supplied fonts measure it), and text broken into lines and
// boxed as guides draw it.

import { plainColor } from "../scale/color.ts";
import type { Rect, TextItem } from "../scene/scene.ts";
import { haloOf, type ResolvedHalo, type TextPaint } from "../style/style.ts";

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

/** Text broken into lines at "\n", and how far they reach. */
export interface TextLines {
  readonly lines: readonly string[];
  /** Each line's width in pixels. */
  readonly widths: readonly number[];
  /** The widest line's width. */
  readonly width: number;
  /** The lines' height: their count times the paint's line height. */
  readonly height: number;
}

/** `text` in lines as `paint` sets it, each measured with `measure`. */
export function textLines(text: string, paint: TextPaint, measure: MeasureText): TextLines {
  const lines = text.split("\n");
  const widths = lines.map((line) => measure(line, paint.css));
  return { lines, widths, width: Math.max(...widths), height: lines.length * paint.lineHeight };
}

/**
 * The box of `lines` drawn at `at` (unturned), padded by the paint's
 * padding: as wide as the widest line, each line its line height tall,
 * stacked down from the first, whose middle (or top, "hanging") is at `at.y`.
 */
export function textBox(lines: TextLines, at: TextAt, paint: TextPaint): Rect {
  const { size, lineHeight, padding } = paint;
  const [top, right, bottom, left] = padding;
  const first = at.baseline === "middle" ? at.y - lineHeight / 2 : at.y - (lineHeight - size) / 2;
  const start = at.x - lines.width * (at.anchor === "middle" ? 0.5 : at.anchor === "end" ? 1 : 0);
  return {
    x: start - left,
    y: first - top,
    width: lines.width + left + right,
    height: lines.height + top + bottom,
  };
}

/**
 * Where guide text is drawn: its point, which side of the text the point is
 * on (its middle, or its top for "hanging" text), and its turn.
 */
export type TextAt = Pick<TextItem, "x" | "y" | "anchor" | "angle"> & {
  baseline: "middle" | "hanging";
};

/** How wide a line of `text` in `paint` is drawn: with its box's padding when it has a box. */
export function textWidth(text: string, paint: TextPaint, measure: MeasureText): number {
  const [, right, , left] = paint.padding;
  return measure(text, paint.css) + (paint.background ? left + right : 0);
}

/** How tall a line of text in `paint` is drawn: its line height, and its box's padding. */
export function textHeight(paint: TextPaint): number {
  const [top, , bottom] = paint.padding;
  return paint.lineHeight + (paint.background ? top + bottom : 0);
}

/**
 * Where text in a box is drawn so that the box's edge (or middle) goes where
 * the text's own would go without one: the text moves inside the box by its
 * padding, in the text's own turn.
 */
function padded(at: TextAt, [top, right, bottom, left]: TextPaint["padding"]): TextAt {
  const dx = at.anchor === "start" ? left : at.anchor === "end" ? -right : (left - right) / 2;
  return moved(at, dx, at.baseline === "hanging" ? top : (top - bottom) / 2);
}

/** `at` moved `dx` along its text and `dy` down it, in the text's own turn. */
function moved(at: TextAt, dx: number, dy: number): TextAt {
  const turn = (at.angle * Math.PI) / 180;
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  return { ...at, x: at.x + dx * cos - dy * sin, y: at.y + dx * sin + dy * cos };
}

/**
 * The halo of guide text in `paint` drawn over `surface`, or over its box
 * when it has one. Guides read colors without the CSS color table, which
 * only text marks carry.
 */
export function textHalo(paint: TextPaint, surface: string): ResolvedHalo | undefined {
  return haloOf(
    paint.halo,
    paint.color,
    paint.background?.fill ?? surface,
    paint.color,
    plainColor,
  );
}

/**
 * A guide's line of `text` at `at` in `paint`, with the paint's halo over
 * `surface` and, when the paint has a background, the box behind it
 * (measured with `measure`, and only then), whose edge goes where the
 * text's own would (see `padded`).
 */
export function textItem(
  text: string,
  at: TextAt,
  paint: TextPaint,
  surface: string,
  measure?: MeasureText,
  box?: Rect,
): TextItem {
  if (!box && paint.background && measure) {
    at = padded(at, paint.padding);
    box = textBox(textLines(text, paint, measure), at, paint);
  }
  const { x, y, anchor, baseline, angle } = at;
  const halo = textHalo(paint, surface);
  const item: { -readonly [K in keyof TextItem]: TextItem[K] } = {
    type: "text",
    text,
    x,
    y,
    anchor,
    baseline,
    angle,
    paint,
  };
  if (halo) item.halo = halo;
  if (box) item.box = box;
  return item;
}

/**
 * A guide's `text` at `at` in `paint`, a line each as "\n" breaks it,
 * stacked as `textBox` says (turned with the text): each with the paint's
 * halo over `surface`, and the first with the box behind them all when the
 * paint has a background.
 */
export function textItems(
  text: string,
  at: TextAt,
  paint: TextPaint,
  surface: string,
  measure: MeasureText,
): TextItem[] {
  if (!text.includes("\n")) return [textItem(text, at, paint, surface, measure)];
  const lines = text.split("\n");
  if (paint.background) at = padded(at, paint.padding);
  const box = paint.background ? textBox(textLines(text, paint, measure), at, paint) : undefined;
  // Later lines go down the text's own way.
  return lines.map((line, i) =>
    textItem(
      line,
      moved(at, 0, paint.lineHeight * i),
      paint,
      surface,
      undefined,
      i === 0 ? box : undefined,
    ),
  );
}
