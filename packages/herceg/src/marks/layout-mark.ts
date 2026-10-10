// Layout marks place their own geometry in a panel, without x and y scales:
// pies, treemaps, networks, and the like. The chart model gives each the
// panel's room and draws what it returns, as it does for marks along axes;
// items, rather than axis positions, are what tooltips, hover events, and
// the keyboard visit. A layout mark has a chart to itself, or one of a
// chart's facet panels or subplots.

import type { RowView } from "../data/row-view.ts";
import type { Table } from "../data/table.ts";
import type { MeasureText } from "../layout/text.ts";
import type { ItemViews } from "../model/item-views.ts";
import type { LegendEntry, LegendPart } from "../model/legend.ts";
import type { ChartConfig } from "../model/model.ts";
import type { Geometry, Rect } from "../scene/scene.ts";
import type { CameraSpec } from "../spec/spec.ts";
import type { Theme } from "../theme.ts";
import type { Camera } from "../three/camera.ts";
import type { ChartMark, Mark } from "./mark.ts";

/** What a layout mark lays out with: its room and the chart's settings. */
export interface LayoutFrame {
  /** The mark's identity among the chart's: its `id`, or its index. */
  id: string | number;
  /** The panel's room, label space included. */
  bounds: Rect;
  /**
   * The rows of the mark's table to draw, ascending, as in a facet panel:
   * the rows with the panel's values. All of them when absent.
   */
  rows?: Uint32Array | undefined;
  theme: Theme;
  locale: string | undefined;
  measure: MeasureText;
  /** Keys of items hidden through the legend. */
  hidden: ReadonlySet<string>;
  /** The color of an item, kept for the chart's lifetime once given. */
  color(key: string): string;
  /** The chart's camera, for marks drawn in three dimensions. */
  camera?: Camera | undefined;
  /** Whether a GPU painter may draw large point sets (see PointCloud3D). */
  clouds?: boolean;
  /** The chart animates changed values: pies describe their slices (PieSlices). */
  keyed?: boolean;
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
  /** What `value` measures, when it differs from the mark's `measure` (items of several marks). */
  measure?: string;
  /** The item's data by field, where it has several values (a 3D point): numbers, times in epoch ms, and categories. */
  values?: Readonly<Record<string, number | string>>;
  /** The row of the mark's table the item is, for items that are one row. */
  row?: number;
  /** In a chart of several layers (a map's, a 3D box's), the index of the item's layer among them. */
  layer?: number;
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

/** A mark that lays out its own geometry in a panel; internal, as `Mark` is. */
export interface LayoutMark extends ChartMark {
  /** Tells layout marks from marks along axes. */
  readonly layout: true;
  /**
   * What charts keep of what their layout marks drew, and check charts of
   * layout marks with: every layout mark gives the same class, through which
   * charts reach it, so that charts without layout marks do not load it.
   */
  readonly views: typeof ItemViews;
  readonly table: Table | undefined;
  /** Tables the mark reads besides `table`, such as a network's nodes; charts follow their changes too. */
  readonly otherTables?: readonly Table[];
  /** What the values are, for tooltip headers: the value field, or "Count". */
  readonly measure: string;
  /** Entries for the legend, which toggles items by key; `id` as in `LayoutFrame`. */
  legend(id: string | number, color: (key: string) => string, theme: Theme): LegendEntry[];
  /** Legends of color scales and size keys, for marks encoding values that way. */
  legends?(theme: Theme, locale: string | undefined): LegendPart[];
  draw(frame: LayoutFrame): LayoutResult;
  /**
   * Marks that can share a chart (maps' layers) give the one mark that draws
   * a chart's layout marks together, with the chart's options (a map's
   * projection); it throws for marks it cannot draw with.
   */
  join?(marks: readonly LayoutMark[], config: ChartConfig): LayoutMark;
  /**
   * 3D charts, whose camera the pointer and keyboard turn: the camera `spec`
   * describes, its settings left out taken from `base` (by default the
   * default camera's). Throws for settings out of range.
   */
  camera?(spec: CameraSpec | undefined, base?: Camera): Camera;
}

export function isLayoutMark(mark: object): mark is LayoutMark {
  return (mark as Partial<LayoutMark>).layout === true;
}

/**
 * What a layout mark works out from rows of its table (a pie's sums), kept
 * while the table is unchanged: for all rows, and for each list of rows a
 * frame gives (each facet panel's, which charts keep while the table and
 * the panels are unchanged), dropped with the list.
 */
export class RowsCache<T> {
  #all: { version: number; value: T } | undefined;
  readonly #some = new WeakMap<Uint32Array, { version: number; value: T }>();

  /** The value for `rows` of `table`, or all its rows, from `compute` unless kept. */
  get(table: Table, rows: Uint32Array | undefined, compute: () => T): T {
    const kept = rows ? this.#some.get(rows) : this.#all;
    if (kept?.version === table.version) return kept.value;
    const entry = { version: table.version, value: compute() };
    if (rows) this.#some.set(rows, entry);
    else this.#all = entry;
    return entry.value;
  }
}

/**
 * The row view a mark shows the rows of, if it shows a view's rows rather
 * than its table's: what a chart follows besides `tablesOf`.
 */
export function viewOf(mark: ChartMark): RowView | undefined {
  return "view" in mark ? (mark as Mark).view : undefined;
}

/**
 * Every table a mark reads, which charts redraw on changes to, and which
 * framework adapters compare to tell whether a rebuilt mark is the same.
 */
export function tablesOf(mark: ChartMark): Table[] {
  const { table } = mark as Mark | LayoutMark;
  const tables = table ? [table] : [];
  if (isLayoutMark(mark) && mark.otherTables) tables.push(...mark.otherTables);
  return tables;
}
