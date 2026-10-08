// Layout marks place their own geometry in a panel, without x and y scales:
// pies, treemaps, and sunbursts. The chart model gives each the panel's room
// and draws what it returns, as it does for marks along axes; items, rather
// than axis positions, are what tooltips, hover events, and the keyboard
// visit.

import type { Table } from "../data/table.ts";
import type { MeasureText } from "../layout/text.ts";
import type { LegendEntry } from "../model/legend.ts";
import type { Geometry, Rect } from "../scene/scene.ts";
import type { Theme } from "../theme.ts";
import type { Mark } from "./mark.ts";

/** What a layout mark lays out with: its room and the chart's settings. */
export interface LayoutFrame {
  /** The mark's identity among the chart's: its `id`, or its index. */
  id: string | number;
  /** The panel's room, label space included. */
  bounds: Rect;
  theme: Theme;
  locale: string | undefined;
  measure: MeasureText;
  /** Keys of items hidden through the legend. */
  hidden: ReadonlySet<string>;
  /** The color of an item, kept for the chart's lifetime once given. */
  color(key: string): string;
}

/** One thing a layout mark drew, as tooltips and the keyboard report it. */
export interface LayoutItem {
  key: string;
  /** What the item is: a category, or a node's path. */
  label: string;
  color: string;
  value: number;
  /** The value formatted, with its share where that means something. */
  text: string;
  /** Where a tooltip points. */
  px: number;
  py: number;
  /** SVG path data outlining the item, to highlight it. */
  outline: string;
}

/** What a layout mark drew in one scene. */
export interface LayoutResult {
  geometry: Geometry[];
  /** The item under a pixel. */
  itemAt(px: number, py: number): LayoutItem | undefined;
  /**
   * How many items the keyboard visits. Items are made when asked for, so
   * charts of many items do not build them all.
   */
  readonly count: number;
  /** The item at a place in reading order, from 0 to `count` - 1. */
  item(index: number): LayoutItem;
  /** The place in reading order of the item keyed `key`; -1 when it was not drawn. */
  indexOf(key: string): number;
  /** A sentence or two describing what was drawn, for screen readers. */
  summary(): string;
}

export interface LayoutMark {
  /** Tells layout marks from marks along axes. */
  readonly layout: true;
  readonly spec: { readonly type: string; readonly id?: string | undefined };
  readonly table: Table | undefined;
  /** What the values are, for tooltip headers: the value field, or "Count". */
  readonly measure: string;
  /** Entries for the legend, which toggles items by key; `id` as in `LayoutFrame`. */
  legend(id: string | number, color: (key: string) => string): LegendEntry[];
  draw(frame: LayoutFrame): LayoutResult;
}

/** Any mark a chart takes: one along axes, or a layout mark. */
export type ChartMark = Mark | LayoutMark;

export function isLayoutMark(mark: object): mark is LayoutMark {
  return (mark as Partial<LayoutMark>).layout === true;
}
