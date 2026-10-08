import { isLightColor } from "../scale/color.ts";
import type { Drawing, TextGeometry } from "../scene/scene.ts";
import type { Theme } from "../theme.ts";
import { escapeXml, n } from "./markup.ts";

/**
 * The halo that keeps labels readable over lines and fills, an outline
 * drawn below the text: the background color, or without one, white behind
 * dark text and black behind light text. Fills given by name are taken to
 * be as light as the theme's text.
 */
export function textHalo(fill: string, theme: Theme): { color: string; opacity: number } {
  if (theme.background !== "transparent") return { color: theme.background, opacity: 1 };
  const light = isLightColor(fill) ?? isLightColor(theme.text);
  return { color: light ? "#000000" : "#ffffff", opacity: 0.85 };
}

/** Width of a text halo in pixels: it extends half of this around each glyph. */
export const HALO_WIDTH = 3;

/** Text labels, with a halo when asked. */
export const textDrawing: Drawing<TextGeometry> = {
  guide: true,
  size: () => 0,
  svg(mark, { theme }) {
    const { color, opacity } = textHalo(mark.fill, theme);
    const halo = mark.halo
      ? ` stroke="${escapeXml(color)}" stroke-opacity="${opacity}" stroke-width="${HALO_WIDTH}" stroke-linejoin="round" paint-order="stroke"`
      : "";
    const c = mark.coords;
    let out = `<g fill="${escapeXml(mark.fill)}" text-anchor="${mark.anchor}"${halo}>`;
    for (let i = 0; i < mark.count; i++) {
      out += `<text x="${n(c[i * 2]!)}" y="${n(c[i * 2 + 1]!)}" dominant-baseline="middle">${escapeXml(mark.labels[i]!)}</text>`;
    }
    return `${out}</g>`;
  },
};
