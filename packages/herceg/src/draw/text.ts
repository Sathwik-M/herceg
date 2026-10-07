import { isLightColor } from "../scale/color.ts";
import type { Drawing, TextGeometry } from "../scene/scene.ts";
import { escapeXml, n } from "./markup.ts";

/**
 * Text labels, with a halo (when asked) so they stay readable over lines and fills:
 * the background color, or without one, white behind dark text and black
 * behind light text. Fills given by name are taken to be as light as the
 * theme's text.
 */
export const textDrawing: Drawing<TextGeometry> = {
  guide: true,
  size: () => 0,
  svg(mark, { theme }) {
    const opaque = theme.background !== "transparent";
    const light = isLightColor(mark.fill) ?? isLightColor(theme.text);
    const color = opaque ? theme.background : light ? "#000000" : "#ffffff";
    const halo = mark.halo
      ? ` stroke="${escapeXml(color)}" stroke-opacity="${opaque ? 1 : 0.85}" stroke-width="3" stroke-linejoin="round" paint-order="stroke"`
      : "";
    const c = mark.coords;
    let out = `<g fill="${escapeXml(mark.fill)}" text-anchor="${mark.anchor}"${halo}>`;
    for (let i = 0; i < mark.count; i++) {
      out += `<text x="${n(c[i * 2]!)}" y="${n(c[i * 2 + 1]!)}" dominant-baseline="middle">${escapeXml(mark.labels[i]!)}</text>`;
    }
    return `${out}</g>`;
  },
};
