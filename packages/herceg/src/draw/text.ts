import { cssColor } from "../scale/css-color.ts";
import type { Drawing, TextGeometry } from "../scene/scene.ts";
import type { Halo } from "../spec/style.ts";
import { haloOf, type ResolvedHalo } from "../style/style.ts";
import type { Theme } from "../theme.ts";
import { escapeXml, n } from "./markup.ts";

/**
 * The halo that keeps a mark's labels colored `fill` readable over lines
 * and fills, as the mark's `halo` asks ("auto" when left out; see
 * `haloOf`), over what its frame draws on: the plot's fill, or the chart's
 * background. Colors given by name are read with the CSS color table.
 */
export function labelHalo(
  halo: Halo | undefined,
  fill: string,
  frame: { theme: Theme; surface?: string | undefined },
): ResolvedHalo | undefined {
  const { theme } = frame;
  return haloOf(halo ?? "auto", fill, frame.surface ?? theme.background, theme.text, cssColor);
}

/** SVG attributes of a halo, drawn under the text's fill. */
export function haloAttributes(halo: ResolvedHalo): string {
  return ` stroke="${escapeXml(halo.color)}" stroke-opacity="${halo.opacity}" stroke-width="${halo.width}" stroke-linejoin="round" paint-order="stroke"`;
}

/** Text labels, with a halo when asked. */
export const textDrawing: Drawing<TextGeometry> = {
  guide: true,
  size: () => 0,
  svg(mark) {
    const halo = mark.halo ? haloAttributes(mark.halo) : "";
    const c = mark.coords;
    let out = `<g fill="${escapeXml(mark.fill)}" text-anchor="${mark.anchor}"${halo}>`;
    for (let i = 0; i < mark.count; i++) {
      out += `<text x="${n(c[i * 2]!)}" y="${n(c[i * 2 + 1]!)}" dominant-baseline="middle">${escapeXml(mark.labels[i]!)}</text>`;
    }
    return `${out}</g>`;
  },
};
