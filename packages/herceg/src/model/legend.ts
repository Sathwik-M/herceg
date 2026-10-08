// Legend layout. Series entries, the color ramp, and size and shape keys flow
// left to right in rows across the top of the chart, wrapping at its right
// edge; each size or shape key starts a row of its own.

import { formatNumber } from "../format/format.ts";
import type { MeasureText } from "../layout/text.ts";
import type { ColorRamp, GlyphKey } from "../marks/mark.ts";
import { fraction } from "../scale/color.ts";
import {
  type ColorLegend,
  type GlyphLegend,
  LEGEND_SWATCH,
  type LegendItem,
} from "../scene/scene.ts";

/** Space between the chart's edges and what it draws. */
export const EDGE = 8;
const LEGEND_GAP = 16;
const KEY_GAP = 12;
const RAMP_WIDTH = 120;

/** A series' legend item before layout. */
export type LegendEntry = Omit<LegendItem, "hidden" | "x" | "y">;

export interface LegendContent {
  /** Series entries; empty when the series legend is off. */
  entries: readonly LegendEntry[];
  /** Continuous color scales, one legend each. */
  ramps: readonly ColorRamp[];
  keys: readonly GlyphKey[];
  /** Keys of hidden series. */
  hidden: ReadonlySet<string>;
}

export interface LegendLayout {
  legend: LegendItem[];
  colorLegends: ColorLegend[];
  glyphLegends: GlyphLegend[];
  /** The bottom edge of the last row; undefined when there is nothing to show. */
  bottom: number | undefined;
}

/** One thing in a row: its size, and what to do once its row is known. */
interface Item {
  width: number;
  height: number;
  /** Space after the item, when another follows on its row. */
  gap: number;
  /** Starts a new row. */
  breaks?: boolean;
  /** Called with the item's left edge and its row's middle. */
  place(x: number, y: number): void;
}

/**
 * Lays out the legends from `top` (the first row's top edge) across a chart
 * `width` pixels wide.
 */
export function layoutLegends(
  content: LegendContent,
  top: number,
  width: number,
  text: { measure: MeasureText; font: string; lineHeight: number; locale: string | undefined },
): LegendLayout {
  const { measure, font, lineHeight, locale } = text;
  const out: LegendLayout = {
    legend: [],
    colorLegends: [],
    glyphLegends: [],
    bottom: undefined,
  };
  const items: Item[] = content.entries.map((entry) => ({
    width: LEGEND_SWATCH + 6 + measure(entry.label, font),
    height: lineHeight,
    gap: LEGEND_GAP,
    place: (x, y) => out.legend.push({ ...entry, hidden: content.hidden.has(entry.key), x, y }),
  }));
  for (const ramp of content.ramps) {
    // Title, low label, ramp, high label.
    const [lo, hi] = ramp.domain;
    const low = formatNumber(lo, locale);
    const high = formatNumber(hi, locale);
    const titleWidth = measure(ramp.title, font) + 10;
    const lowWidth = measure(low, font) + 6;
    items.push({
      width: titleWidth + lowWidth + RAMP_WIDTH + 6 + measure(high, font),
      height: lineHeight,
      gap: LEGEND_GAP,
      place: (x, y) => {
        out.colorLegends.push({
          stops: ramp.stops,
          // Where the midpoint falls between the ends, for diverging ramps.
          middle:
            ramp.midpoint === undefined
              ? undefined
              : hi > lo
                ? Math.min(1, Math.max(0, fraction(ramp.midpoint, lo, hi)))
                : 0.5,
          y,
          title: { text: ramp.title, x },
          low: { text: low, x: x + titleWidth },
          ramp: { x: x + titleWidth + lowWidth, width: RAMP_WIDTH },
          high: { text: high, x: x + titleWidth + lowWidth + RAMP_WIDTH + 6 },
        });
      },
    });
  }
  for (const key of content.keys) {
    const legend: GlyphLegend = { title: { text: key.title, x: 0, y: 0 }, entries: [] };
    out.glyphLegends.push(legend);
    items.push({
      width: measure(key.title, font),
      height: lineHeight,
      gap: KEY_GAP,
      breaks: true,
      place: (x, y) => {
        legend.title.x = x;
        legend.title.y = y;
      },
    });
    for (const { label, glyph, r } of key.entries) {
      const size = Math.max(LEGEND_SWATCH, r * 2);
      items.push({
        width: size + 6 + measure(label, font),
        height: Math.max(lineHeight, size + 2),
        gap: KEY_GAP,
        place: (x, y) =>
          legend.entries.push({
            glyph,
            x: x + size / 2,
            y,
            label: { text: label, x: x + size + 6 },
          }),
      });
    }
  }
  if (items.length > 0) out.bottom = flow(items, top, width);
  return out;
}

/** Places items in rows as tall as their tallest item; returns the last row's bottom. */
function flow(items: readonly Item[], top: number, width: number): number {
  let row: { item: Item; x: number }[] = [];
  let y = top;
  const finish = () => {
    const height = Math.max(...row.map(({ item }) => item.height));
    for (const { item, x } of row) item.place(x, y + height / 2);
    y += height + 4;
    row = [];
  };
  let x = EDGE;
  for (const item of items) {
    if (row.length > 0 && (item.breaks || x + item.width > width - EDGE)) {
      finish();
      x = EDGE;
    }
    row.push({ item, x });
    x += item.width + item.gap;
  }
  finish();
  return y - 4;
}
