import type { Drawing, LabelsGeometry, TextGeometry, TextItem } from "../scene/scene.ts";
import type { ResolvedHalo } from "../style/style.ts";
import type { Theme } from "../theme.ts";
import { escapeXml, n, rectMarkup } from "./markup.ts";

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

/**
 * A text item's markup: only what differs from what the document's root
 * sets (the theme's font and size, and its muted color).
 */
export function textItemMarkup(item: TextItem, root: Theme): string {
  const { paint } = item;
  let out = "";
  if (item.box) {
    const box = paint.background!;
    out += rectMarkup(
      item.box,
      box.radius,
      ` fill="${escapeXml(box.fill)}"${box.stroke ? ` stroke="${escapeXml(box.stroke)}" stroke-width="${box.strokeWidth ?? 1}"` : ""}${rotation(item)}`,
    );
  }
  out += `<text x="${n(item.x)}" y="${n(item.y)}"`;
  if (item.anchor !== "start") out += ` text-anchor="${item.anchor}"`;
  if (item.baseline !== "alphabetic") out += ` dominant-baseline="${item.baseline}"`;
  if (paint.font !== root.font) out += ` font-family="${escapeXml(paint.font)}"`;
  if (paint.size !== root.fontSize) out += ` font-size="${paint.size}"`;
  if (paint.italic) out += ` font-style="italic"`;
  if (paint.weight !== 400) out += ` font-weight="${paint.weight}"`;
  if (paint.color !== root.muted) out += ` fill="${escapeXml(paint.color)}"`;
  const opacity = paint.opacity * (item.opacity ?? 1);
  if (opacity !== 1) out += ` opacity="${opacity}"`;
  if (item.halo) out += haloAttributes(item.halo);
  out += rotation(item);
  return `${out}>${escapeXml(item.text)}</text>`;
}

function rotation(item: TextItem): string {
  return item.angle ? ` transform="rotate(${item.angle} ${n(item.x)} ${n(item.y)})"` : "";
}

/** Labels in styles of their own, as positioned text items (boxes, fonts, sizes). */
export const labelsDrawing: Drawing<LabelsGeometry> = {
  guide: true,
  size: () => 0,
  svg(mark, { theme }) {
    let out = "";
    for (const item of mark.items) out += textItemMarkup(item, theme);
    return out;
  },
};
