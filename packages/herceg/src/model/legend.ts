// Legend layout. Series entries, then what marks add (color ramps, size and
// shape keys), flow left to right in rows across the top of the chart,
// wrapping at its right edge; parts that break start a row of their own.

import type { MeasureText } from "../layout/text.ts";
import {
  type ColorLegend,
  type GlyphLegend,
  LEGEND_SWATCH,
  type LegendItem,
} from "../scene/scene.ts";

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
  readonly groups: Map<string, string>;

  constructor(keys?: Iterable<string>, groups = new Map<string, string>()) {
    super(keys);
    this.groups = groups;
  }

  override has(key: string): boolean {
    if (super.has(key)) return true;
    const entry = this.groups.get(key);
    return entry !== undefined && super.has(entry);
  }

  /** Whether `key` itself is hidden, not through a group. */
  stores(key: string): boolean {
    return super.has(key);
  }
}

/** How legend text is measured and set. */
export interface LegendText {
  measure: MeasureText;
  font: string;
  lineHeight: number;
  locale: string | undefined;
}

/**
 * A legend a mark adds after the series entries, such as a color ramp or a
 * key of sizes (see marks/legend-parts.ts): it lays itself out, puts what it
 * draws into the layout, and describes itself.
 */
export interface LegendPart {
  /** Parts with the same key show once: marks sharing a scale share its legend. */
  readonly key: string;
  /** Starts a row of its own; the model puts such parts after those that do not. */
  readonly breaks?: boolean;
  /** The part's items in the legend's rows; each adds what it draws to `out` once placed. */
  items(text: LegendText, out: LegendLayout): LegendFlowItem[];
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

export interface LegendLayout {
  legend: LegendItem[];
  colorLegends: ColorLegend[];
  glyphLegends: GlyphLegend[];
  /** The bottom edge of the last row; undefined when there is nothing to show. */
  bottom: number | undefined;
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

/**
 * Lays out the legends from `top` (the first row's top edge) across a chart
 * `width` pixels wide.
 */
export function layoutLegends(
  content: LegendContent,
  top: number,
  width: number,
  text: LegendText,
): LegendLayout {
  const { measure, font, lineHeight } = text;
  const out: LegendLayout = {
    legend: [],
    colorLegends: [],
    glyphLegends: [],
    bottom: undefined,
  };
  const items: LegendFlowItem[] = content.entries.map((entry) => ({
    width: LEGEND_SWATCH + 6 + measure(entry.label, font),
    height: lineHeight,
    gap: LEGEND_GAP,
    place: (x, y) => out.legend.push({ ...entry, hidden: content.hidden.has(entry.key), x, y }),
  }));
  for (const part of content.parts) items.push(...part.items(text, out));
  if (items.length > 0) out.bottom = flow(items, top, width);
  return out;
}

/** Places items in rows as tall as their tallest item; returns the last row's bottom. */
function flow(items: readonly LegendFlowItem[], top: number, width: number): number {
  let row: { item: LegendFlowItem; x: number }[] = [];
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
