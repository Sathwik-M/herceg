// Paints with a guide's own style over them: the cascade's last level for
// what the compiler draws (a listed axis', a layer's, a legend's style),
// over the paints the model resolved for the chart. Their colors and fonts
// are read as the chart reads its styles (CSS variables from the page).

import type { GuideKit } from "../model/guides.ts";
import type { StrokeStyle, TextStyle } from "../spec/spec.ts";
import type { StrokePaint, TextPaint } from "../style/style.ts";

/** Reads a style's colors and font as the chart does, `path` naming it in messages (see `ChartStyles.read`). */
export type Read = <T extends object>(style: T, path: string) => T;

/** A text paint with `style`, set at `path`, over it. */
export function restyle(
  kit: GuideKit,
  read: Read,
  paint: TextPaint,
  given: TextStyle | undefined,
  path: string,
): TextPaint {
  if (!given) return paint;
  const style = read(given, path);
  const size = style.fontSize ?? paint.size;
  const font = style.font ?? paint.font;
  const weight = style.fontWeight ?? paint.weight;
  const italic = style.fontStyle ? style.fontStyle === "italic" : paint.italic;
  const resized = style.lineHeight !== undefined || style.fontSize !== undefined;
  return {
    font,
    size,
    weight,
    italic,
    color: style.color ?? paint.color,
    opacity: style.opacity ?? paint.opacity,
    lineHeight: resized
      ? Math.round(size * (style.lineHeight ?? paint.lineHeight / paint.size))
      : paint.lineHeight,
    align: style.align ?? paint.align,
    halo: style.halo ?? paint.halo,
    background: style.background === undefined ? paint.background : style.background || undefined,
    padding: style.padding === undefined ? paint.padding : kit.insets(style.padding),
    css: kit.cssFont(font, size, weight, italic),
  };
}

/** A stroke paint with `style`, set at `path`, over it. */
export function restroke(
  kit: GuideKit,
  read: Read,
  paint: StrokePaint,
  given: StrokeStyle | undefined,
  path: string,
): StrokePaint {
  if (!given) return paint;
  const style = read(given, path);
  const strokeWidth = style.strokeWidth ?? paint.strokeWidth;
  return {
    stroke: style.stroke ?? paint.stroke,
    strokeWidth,
    dash: style.dash !== undefined ? (kit.dashPattern(style.dash, strokeWidth) ?? []) : paint.dash,
    opacity: style.opacity ?? paint.opacity,
  };
}
