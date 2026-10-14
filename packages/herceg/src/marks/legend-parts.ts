// Legends of color scales and of point sizes and shapes. Marks that encode
// values those ways add them to the chart's legend; each brings its layout,
// drawing, and description, so charts without them carry none of this code.

import { escapeXml, n, rectMarkup } from "../draw/markup.ts";
import { formatNumber } from "../format/format.ts";
import { textHeight, textItem, textWidth } from "../layout/text.ts";
import type { LegendFlowItem, LegendOut, LegendPart, LegendText } from "../model/legend.ts";
import { fraction } from "../scale/color.ts";
import {
  type GuideItem,
  type KeyGuide,
  LEGEND_SWATCH,
  type RampGuide,
  type RampItem,
  rampOffsets,
  type TextItem,
} from "../scene/scene.ts";
import type { TextPaint } from "../style/style.ts";
import type { ColorRamp, GlyphKey } from "./mark.ts";

const LEGEND_GAP = 16;
const KEY_GAP = 12;
const RAMP_WIDTH = 120;

/** A legend's line of text, starting at x and vertically centered on y. */
const label = (x: number, y: number, line: string, paint: TextPaint, text: LegendText): TextItem =>
  textItem(
    line,
    { x, y, anchor: "start", baseline: "middle", angle: 0 },
    paint,
    text.surface,
    text.measure,
  );

/** A ramp as SVG: a rectangle filled with a gradient of its stops, the gradient's id `id`. */
function rampMarkup(item: RampItem, id: string): string {
  const stops = item.stops
    .map(
      (color, i) =>
        `<stop offset="${n(item.offsets[i]! * 100)}%" stop-color="${escapeXml(color)}"/>`,
    )
    .join("");
  return `<defs><linearGradient id="${id}">${stops}</linearGradient></defs>${rectMarkup(item, item.radius, ` fill="url(#${id})"`)}`;
}

/** The legend of a continuous color scale: its title, low value, ramp, and high value in a row. */
export function rampLegend(ramp: ColorRamp): LegendPart {
  const { title, domain, midpoint, stops } = ramp;
  const key = `ramp|${title}|${domain.join()}|${midpoint}|${stops.join()}`;
  return {
    key,
    items(text: LegendText, out: LegendOut): LegendFlowItem[] {
      const { measure, lineHeight, locale } = text;
      const [lo, hi] = domain;
      const low = formatNumber(lo, locale);
      const high = formatNumber(hi, locale);
      const titleWidth = textWidth(title, text.title, measure) + 10;
      const lowWidth = textWidth(low, text.value, measure) + 6;
      // Where the midpoint falls between the ends, for diverging ramps.
      const middle =
        midpoint === undefined
          ? undefined
          : hi > lo
            ? Math.min(1, Math.max(0, fraction(midpoint, lo, hi)))
            : 0.5;
      const at = out.guides.length;
      out.guides.push(placeRamp(0, 0));
      function placeRamp(x: number, y: number): RampGuide {
        const start = x + titleWidth + lowWidth;
        return {
          kind: "ramp",
          key,
          stops,
          middle,
          y,
          title: { text: title, x },
          low: { text: low, x: x + titleWidth },
          ramp: { x: start, width: RAMP_WIDTH },
          high: { text: high, x: start + RAMP_WIDTH + 6 },
          rampMarkup,
          items: [
            label(x, y, title, text.title, text),
            label(x + titleWidth, y, low, text.value, text),
            {
              type: "ramp",
              x: start,
              y: y - LEGEND_SWATCH / 2,
              width: RAMP_WIDTH,
              height: LEGEND_SWATCH,
              radius: 2,
              stops,
              offsets: rampOffsets(stops, middle),
            },
            label(start + RAMP_WIDTH + 6, y, high, text.value, text),
          ],
        };
      }
      return [
        {
          width: titleWidth + lowWidth + RAMP_WIDTH + 6 + textWidth(high, text.value, measure),
          height: Math.max(lineHeight, textHeight(text.title), textHeight(text.value)),
          gap: LEGEND_GAP,
          place: (x, y) => {
            out.guides[at] = placeRamp(x, y);
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

/**
 * The legend of sizes, shapes, or colors: a row of its own with the title,
 * then each glyph and its label. Glyphs without colors of their own are the
 * value text's color, translucent.
 */
export function keyLegend(key: GlyphKey): LegendPart {
  const { title, channel, entries } = key;
  const id = `key|${title}|${channel}|${entries.map((e) => `${e.label} ${e.glyph} ${e.color}`).join("|")}`;
  return {
    key: id,
    breaks: true,
    items(text: LegendText, out: LegendOut): LegendFlowItem[] {
      const { measure, lineHeight } = text;
      const legend = {
        kind: "key",
        key: id,
        title: { text: title, x: 0, y: 0 },
        entries: [] as KeyGuide["entries"][number][],
        items: [] as GuideItem[],
      } satisfies KeyGuide;
      out.guides.push(legend);
      out.finish.push(() => {
        legend.items.push(label(legend.title.x, legend.title.y, title, text.title, text));
        for (const { glyph, x, y, fill } of legend.entries)
          legend.items.push(
            fill === undefined
              ? { type: "shape", d: glyph, at: [x, y], fill: text.value.color, fillOpacity: 0.6 }
              : { type: "shape", d: glyph, at: [x, y], fill },
          );
        for (const { y, label: entry } of legend.entries)
          legend.items.push(label(entry.x, y, entry.text, text.value, text));
      });
      const items: LegendFlowItem[] = [
        {
          width: textWidth(title, text.title, measure),
          height: Math.max(lineHeight, textHeight(text.title)),
          gap: KEY_GAP,
          breaks: true,
          place: (x, y) => {
            legend.title.x = x;
            legend.title.y = y;
          },
        },
      ];
      for (const { label: entry, glyph, r, color } of entries) {
        const size = Math.max(LEGEND_SWATCH, r * 2);
        items.push({
          width: size + 6 + textWidth(entry, text.value, measure),
          height: Math.max(lineHeight, size + 2, textHeight(text.value)),
          gap: KEY_GAP,
          place: (x, y) =>
            legend.entries.push({
              glyph,
              x: x + size / 2,
              y,
              ...(color !== undefined && { fill: color }),
              label: { text: entry, x: x + size + 6 },
            }),
        });
      }
      return items;
    },
    describe(): string {
      const values = entries.map(({ label: text, shape }) =>
        shape ? `${shape} for ${text}` : text,
      );
      const shows = channel === "size" ? "Size" : channel === "shape" ? "Shape" : "Color";
      return `${shows} shows ${title}: ${values.join(", ")}.`;
    },
  };
}

/** Legends for a mark's color scales and keys, color scales first. */
export function legendParts(ramps: readonly ColorRamp[], keys: readonly GlyphKey[]): LegendPart[] {
  return [...ramps.map(rampLegend), ...keys.map(keyLegend)];
}
