// Legend layout. Series entries, then what marks add (color ramps, size and
// shape keys), flow left to right in rows across the top of the chart,
// wrapping at its right edge; parts that break start a row of their own.

import { type Align, alignedAt } from "../layout/place.ts";
import { type MeasureText, textHalo, textHeight, textItem, textWidth } from "../layout/text.ts";
import { type Guide, type GuideItem, LEGEND_SWATCH, type LegendItem } from "../scene/scene.ts";
import type { TextPaint } from "../style/style.ts";

/** Space between the chart's edges and what it draws. */
export const EDGE = 8;
const LEGEND_GAP = 16;

/** A series' legend item before layout. */
export type LegendEntry = Omit<LegendItem, "hidden" | "x" | "y">;

/**
 * The keys of series and items hidden through the legend and the
 * visibility methods. A series of a mark in a legend group is also hidden
 * while its group's entry for its name is: `groups` maps the keys of such
 * series to their entries' keys (see `legendKey`).
 */
export class HiddenKeys extends Set<string> {
  readonly groups = new Map<string, string>();

  override has(key: string): boolean {
    return super.has(key) || super.has(this.groups.get(key) ?? key);
  }

  /** Scene-owned membership, including the series hidden by their group entries. */
  snapshot(): ReadonlySet<string> {
    const keys = new Set(this);
    for (const [key, entry] of this.groups) if (super.has(entry)) keys.add(key);
    return keys;
  }
}

/** How legend text is measured and set: entries' labels, parts' titles, and the values they write. */
export interface LegendText {
  measure: MeasureText;
  /** Series entries' labels. */
  label: TextPaint;
  /** The titles of color ramps and keys. */
  title: TextPaint;
  /** The values ramps and keys write. */
  value: TextPaint;
  /** The height of a row of the legend. */
  lineHeight: number;
  locale: string | undefined;
  /** What the legend is drawn on, for halos: the chart's background, or a plot's fill. */
  surface: string;
}

/**
 * A legend a mark adds after the series entries, such as a color ramp or a
 * key of sizes (see marks/legend-parts.ts): it lays itself out, puts the
 * guide it draws into the layout, and describes itself.
 */
export interface LegendPart {
  /** Parts with the same key show once: marks sharing a scale share its legend. */
  readonly key: string;
  /** Starts a row of its own; the model puts such parts after those that do not. */
  readonly breaks?: boolean;
  /**
   * The part's items in the legend's rows; it adds the guide it draws to
   * `out`, and what finishes it once every item is placed.
   */
  items(text: LegendText, out: LegendOut): LegendFlowItem[];
  /** A sentence for the chart's description, since legends are drawn and hidden from assistive technology. */
  describe(locale: string | undefined): string;
}

export interface LegendContent {
  /** Series entries; empty when the series legend is off. */
  entries: readonly LegendEntry[];
  /** In the order they flow. */
  parts: readonly LegendPart[];
  /** Keys of hidden series. */
  hidden: ReadonlySet<string>;
}

/** What parts add to the layout: their guides, and what to do once the rows are placed. */
export interface LegendOut {
  guides: Guide[];
  finish: (() => void)[];
}

/** One thing in a row: its size, and what to do once its row is known. */
export interface LegendFlowItem {
  width: number;
  height: number;
  /** Space after the item, when another follows on its row. */
  gap: number;
  /** Starts a new row. */
  breaks?: boolean;
  /** Called with the item's left edge and its row's middle. */
  place(x: number, y: number): void;
}

/** Opacity of a hidden series' entry: its swatch's, and its label's share of its paint's. */
export const HIDDEN = 0.4;

/** How the legend's items flow: rows wrapping at a width, or one item per row. */
export interface LegendFlow {
  /** The width rows wrap at; undefined for one item per row. */
  wrap: number | undefined;
  /** Where a row shorter than the legend goes in its width. */
  align: Align;
}

/** A legend measured, to be placed once where it goes is known. */
export interface MeasuredLegend {
  width: number;
  height: number;
  /**
   * Places the legend with its top left corner at (x, y), drawn on
   * `surface` (for halos) when that is not the one it was measured for.
   */
  place(x: number, y: number, surface?: string): Guide[];
}

/**
 * Measures the legends: series entries, then what parts add, in rows that
 * wrap at `flow.wrap` (or one item per row); undefined when there is nothing
 * to show.
 */
export function measureLegends(
  content: LegendContent,
  text: LegendText,
  flow: LegendFlow,
): MeasuredLegend | undefined {
  // The parts' own copy, whose surface placing may change before they draw.
  text = { ...text };
  const { measure, label, lineHeight } = text;
  const legend: LegendItem[] = [];
  // A row is as tall as the base text's line, or the labels' line and box.
  const entryHeight = Math.max(lineHeight, textHeight(label));
  const items: LegendFlowItem[] = content.entries.map((entry) => ({
    width: LEGEND_SWATCH + 6 + textWidth(entry.label, label, measure),
    height: entryHeight,
    gap: LEGEND_GAP,
    place: (x, y) => legend.push({ ...entry, hidden: content.hidden.has(entry.key), x, y }),
  }));
  const out: LegendOut = { guides: [], finish: [] };
  for (const part of content.parts) items.push(...part.items(text, out));
  if (items.length === 0) return undefined;
  const rows = arrange(items, flow.wrap);
  const width = Math.max(...rows.map((row) => row.width));
  const height = rows.reduce((sum, row) => sum + row.height + 4, -4);
  return {
    width,
    height,
    place(x, y, surface) {
      if (surface !== undefined) text.surface = surface;
      for (const row of rows) {
        let at = alignedAt(flow.align, x, width, row.width);
        for (const item of row.items) {
          item.place(at, y + row.height / 2);
          at += item.width + item.gap;
        }
        y += row.height + 4;
      }
      for (const finish of out.finish) finish();
      // Static output draws the entries' items; the browser, buttons: built when first read.
      let items: GuideItem[] | undefined;
      if (legend.length > 0)
        out.guides.unshift({
          kind: "legend",
          key: "legend",
          entries: legend,
          label,
          halo: textHalo(label, text.surface),
          get items() {
            items ??= entryItems(legend, text);
            return items;
          },
        });
      return out.guides;
    },
  };
}

/** A row of items, as wide as they are with their gaps and as tall as the tallest. */
interface Row {
  items: LegendFlowItem[];
  width: number;
  height: number;
}

/** Items in rows that wrap at `wrap` pixels (or one per row), and parts that break start their own. */
function arrange(items: readonly LegendFlowItem[], wrap: number | undefined): Row[] {
  const rows: Row[] = [];
  let row: Row | undefined;
  for (const item of items) {
    // A row's width counts the gap before each item after its first.
    const next = row && row.width + row.items.at(-1)!.gap + item.width;
    if (!row || item.breaks || wrap === undefined || next! > wrap) {
      row = { items: [], width: -1, height: 0 };
      rows.push(row);
    }
    row.width = row.items.length > 0 ? next! : item.width;
    row.items.push(item);
    row.height = Math.max(row.height, item.height);
  }
  return rows;
}

/** What static output draws of the series legend's entries: each one's swatch and label. */
function entryItems(entries: readonly LegendItem[], text: LegendText): GuideItem[] {
  const items: GuideItem[] = [];
  for (const entry of entries) {
    const opacity = entry.hidden ? HIDDEN : undefined;
    // Point series show their symbol; others a rounded square.
    items.push(
      entry.glyph
        ? {
            type: "shape",
            d: entry.glyph,
            at: [entry.x + LEGEND_SWATCH / 2, entry.y],
            fill: entry.color,
            stroke: entry.stroke,
            opacity,
          }
        : {
            type: "rect",
            x: entry.x,
            y: entry.y - LEGEND_SWATCH / 2,
            width: LEGEND_SWATCH,
            height: LEGEND_SWATCH,
            radius: 2,
            fill: entry.color,
            opacity,
          },
    );
    const label = textItem(
      entry.label,
      { x: entry.x + LEGEND_SWATCH + 6, y: entry.y, anchor: "start", baseline: "middle", angle: 0 },
      text.label,
      text.surface,
      text.measure,
    );
    // A hidden series' label is drawn at a share of its paint's opacity.
    items.push(opacity === undefined ? label : { ...label, opacity });
  }
  return items;
}
