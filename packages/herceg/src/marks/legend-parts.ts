// Legends of color scales and of point sizes and shapes. Marks that encode
// values those ways add them to the chart's legend; each brings its layout,
// drawing, and description, so charts without them carry none of this code.

import { escapeXml, n } from "../draw/markup.ts";
import { formatNumber } from "../format/format.ts";
import type { LegendFlowItem, LegendLayout, LegendPart, LegendText } from "../model/legend.ts";
import { fraction } from "../scale/color.ts";
import {
  type ColorLegend,
  type GlyphLegend,
  LEGEND_SWATCH,
  type LegendDrawing,
  rampOffsets,
} from "../scene/scene.ts";
import type { Theme } from "../theme.ts";
import type { ColorRamp, GlyphKey } from "./mark.ts";

const LEGEND_GAP = 16;
const KEY_GAP = 12;
const RAMP_WIDTH = 120;

const label = (x: number, y: number, value: string, fill: string) =>
  `<text x="${n(x)}" y="${n(y)}" dominant-baseline="middle" fill="${escapeXml(fill)}">${escapeXml(value)}</text>`;

/** A color ramp's SVG; `id` must be unique in the document (for the gradient). */
const rampDrawing: LegendDrawing<ColorLegend> = {
  svg(legend: ColorLegend, theme: Theme, id: string): string {
    const offsets = rampOffsets(legend);
    const stops = legend.stops
      .map(
        (color, i) => `<stop offset="${n(offsets[i]! * 100)}%" stop-color="${escapeXml(color)}"/>`,
      )
      .join("");
    const { y, title, low, ramp, high } = legend;
    return (
      `<defs><linearGradient id="${id}">${stops}</linearGradient></defs>` +
      label(title.x, y, title.text, theme.text) +
      label(low.x, y, low.text, theme.muted) +
      `<rect x="${n(ramp.x)}" y="${n(y - LEGEND_SWATCH / 2)}" width="${n(ramp.width)}" height="${LEGEND_SWATCH}" rx="2" fill="url(#${id})"/>` +
      label(high.x, y, high.text, theme.muted)
    );
  },
};

/** A size or shape key's SVG: its title, then glyphs in the muted color with their labels. */
const glyphDrawing: LegendDrawing<GlyphLegend> = {
  svg({ title, entries }: GlyphLegend, theme: Theme): string {
    let out = label(title.x, title.y, title.text, theme.text);
    out += `<g fill="${escapeXml(theme.muted)}" fill-opacity="0.6">`;
    for (const { glyph, x, y } of entries)
      out += `<path transform="translate(${n(x)} ${n(y)})" d="${glyph}"/>`;
    out += "</g>";
    for (const { y, label: text } of entries) out += label(text.x, y, text.text, theme.muted);
    return out;
  },
};

/** The legend of a continuous color scale: its title, low value, ramp, and high value in a row. */
export function rampLegend(ramp: ColorRamp): LegendPart {
  const { title, domain, midpoint, stops } = ramp;
  return {
    key: `ramp|${title}|${domain.join()}|${midpoint}|${stops.join()}`,
    items({ measure, font, lineHeight, locale }: LegendText, out: LegendLayout): LegendFlowItem[] {
      const [lo, hi] = domain;
      const low = formatNumber(lo, locale);
      const high = formatNumber(hi, locale);
      const titleWidth = measure(title, font) + 10;
      const lowWidth = measure(low, font) + 6;
      return [
        {
          width: titleWidth + lowWidth + RAMP_WIDTH + 6 + measure(high, font),
          height: lineHeight,
          gap: LEGEND_GAP,
          place: (x, y) => {
            out.colorLegends.push({
              draw: rampDrawing,
              stops,
              // Where the midpoint falls between the ends, for diverging ramps.
              middle:
                midpoint === undefined
                  ? undefined
                  : hi > lo
                    ? Math.min(1, Math.max(0, fraction(midpoint, lo, hi)))
                    : 0.5,
              y,
              title: { text: title, x },
              low: { text: low, x: x + titleWidth },
              ramp: { x: x + titleWidth + lowWidth, width: RAMP_WIDTH },
              high: { text: high, x: x + titleWidth + lowWidth + RAMP_WIDTH + 6 },
            });
          },
        },
      ];
    },
    describe(locale: string | undefined): string {
      const f = (value: number) => formatNumber(value, locale);
      const middle = midpoint === undefined ? "" : `, diverging at ${f(midpoint)}`;
      return `Color shows ${title} from ${f(domain[0])} to ${f(domain[1])}${middle}.`;
    },
  };
}

/** The legend of sizes or shapes: a row of its own with the title, then each glyph and its label. */
export function keyLegend(key: GlyphKey): LegendPart {
  const { title, channel, entries } = key;
  return {
    key: `key|${title}|${channel}|${entries.map((e) => `${e.label} ${e.glyph}`).join("|")}`,
    breaks: true,
    items({ measure, font, lineHeight }: LegendText, out: LegendLayout): LegendFlowItem[] {
      const legend: GlyphLegend = {
        draw: glyphDrawing,
        title: { text: title, x: 0, y: 0 },
        entries: [],
      };
      out.glyphLegends.push(legend);
      const items: LegendFlowItem[] = [
        {
          width: measure(title, font),
          height: lineHeight,
          gap: KEY_GAP,
          breaks: true,
          place: (x, y) => {
            legend.title.x = x;
            legend.title.y = y;
          },
        },
      ];
      for (const { label: text, glyph, r } of entries) {
        const size = Math.max(LEGEND_SWATCH, r * 2);
        items.push({
          width: size + 6 + measure(text, font),
          height: Math.max(lineHeight, size + 2),
          gap: KEY_GAP,
          place: (x, y) =>
            legend.entries.push({ glyph, x: x + size / 2, y, label: { text, x: x + size + 6 } }),
        });
      }
      return items;
    },
    describe(): string {
      const values = entries.map(({ label: text, shape }) =>
        shape ? `${shape} for ${text}` : text,
      );
      return `${channel === "size" ? "Size" : "Shape"} shows ${title}: ${values.join(", ")}.`;
    },
  };
}

/** Legends for a mark's color scales and keys, color scales first. */
export function legendParts(ramps: readonly ColorRamp[], keys: readonly GlyphKey[]): LegendPart[] {
  return [...ramps.map(rampLegend), ...keys.map(keyLegend)];
}
