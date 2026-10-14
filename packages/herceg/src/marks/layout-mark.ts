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
import type { PositionScale } from "../scale/scale.ts";
import type { Geometry, Rect } from "../scene/scene.ts";
import type { CameraSpec } from "../spec/spec.ts";
import type { Theme } from "../theme.ts";
import type { Camera } from "../three/camera.ts";
import type { MovedNodes, NodeMoves } from "./graph.ts";
import type { ChartMark, Mark } from "./mark.ts";
import type { LayoutClock, NodePositions } from "./node-positions.ts";
import type { Drill } from "./tree-data.ts";

/** The part of a map's or network's plane to show: x and y ranges in its units, each null for the fitted layout's. */
export interface Viewport {
  x: readonly [number, number] | null;
  y: readonly [number, number] | null;
}

/** A view of a map's or network's plane: its x and y ranges across the room, and the zoom (its scale over the fitted layout's). */
export interface PlaneView {
  x: readonly [number, number];
  y: readonly [number, number];
  zoom: number;
}

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
  /**
   * Drawn in a panel of facets or subplots, beside others that may draw the
   * same data: a map then projects at a scale level, as when zoomed, so that
   * panels share their projected shapes (see `zoomedTransform`).
   */
  inPanel?: boolean | undefined;
  /** For a mark drawing several layers as one (a map's): each layer's `rows`. */
  layerRows?: readonly (Uint32Array | undefined)[] | undefined;
  /**
   * For a map in facet panels: each layer's rows in any panel (all of them,
   * for a layer that repeats), which every panel's map is fitted to.
   */
  fitRows?: readonly (Uint32Array | undefined)[] | undefined;
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
  /**
   * The part of a map's or network's plane to show, x and y ranges in its units (see
   * `Chart.setViewport`); the fitted layout where both are null or absent.
   */
  viewport?: Viewport | undefined;
  /**
   * Which of a table's rows the selection the chart highlights holds, 1
   * each; undefined for a table none of whose rows are highlighted, which
   * draws as it is.
   */
  selected?: ((table: Table) => Uint8Array | undefined) | undefined;
  /**
   * The item key of the node a tree is drilled into (see
   * `Chart.setDrillRoot`), then its ancestors' nearest first, for a node the
   * data lost; the whole tree without any.
   */
  root?: readonly string[] | undefined;
  /** The chart drills into trees: they draw the path to their root above them, even at the top. */
  drillable?: boolean | undefined;
  /** A network's nodes the chart's user moved (see `Chart.setItemPosition`). */
  moved?: MovedNodes | undefined;
  /**
   * Where a network's nodes are, kept with the chart's state of the panel
   * (facet panels share one): the network keeps its layout there.
   */
  nodePositions?: { current: NodePositions | undefined } | undefined;
  /** How much layout work the frame allows; without one, a network is laid out to the end at once. */
  clock?: LayoutClock | undefined;
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
  /**
   * The rows of `table` the item keyed `key` stands for (a region's row, a
   * node's subtree's rows), for row selection; undefined when it stands for
   * none of `table`'s rows.
   */
  rowsOf?(key: string, table: Table): ArrayLike<number> | undefined;
  /**
   * The rows of `table` whose items lie inside `polygon` (pixels), as a
   * lasso selects them; undefined when the mark draws none of its rows.
   */
  lassoed?(polygon: readonly (readonly [number, number])[], table: Table): number[] | undefined;
  /**
   * A map's or network's plane as drawn: scales from its units to pixels across the
   * room, the zoom (the scale drawn over the fitted layout's), and what a
   * viewport would show (`LayoutFrame.viewport`), drawn or not.
   */
  plane?:
    | {
        x: PositionScale;
        y: PositionScale;
        zoom: number;
        view(viewport: Viewport | undefined): PlaneView;
      }
    | undefined;
  /** A tree's drill root, the path to it, and its breadcrumbs, in charts that drill or are drilled. */
  drill?: Drill | undefined;
  /** For a network: what moving its nodes needs. */
  moves?: NodeMoves | undefined;
  /** Whether layout work remains, which later frames do (see `LayoutFrame.clock`). */
  pending?: boolean | undefined;
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
   * projection): the chart's marks at `indices` (all of them by default), in
   * the subplot `panel` names; it throws for marks it cannot draw with.
   */
  join?(
    marks: readonly LayoutMark[],
    config: ChartConfig,
    indices?: readonly number[],
    panel?: string,
  ): LayoutMark;
  /**
   * For a mark drawing several of the chart's marks as one (a map's
   * layers): those marks, each splitting its own table's rows into facet
   * panels unless it repeats, and each one's index among the chart's marks.
   */
  readonly layers?: readonly LayoutMark[];
  readonly indices?: readonly number[];
  /**
   * Whether a chart of the mark alone selects its rows (`rowSelection`):
   * what its items stand for (`LayoutResult.rowsOf`), and how it draws
   * them highlighted (`LayoutFrame.selected`).
   */
  readonly selects?: boolean;
  /**
   * What `interaction` may turn on in a chart of the mark alone, which
   * refuses the rest: "zoom" for `zoom: true`, "plane" for that or "xy"
   * (a map's or network's plane), "lasso" for a lasso brush, and "drag" for `drag`.
   */
  readonly interactions?: readonly ("zoom" | "plane" | "lasso" | "drag")[];
  /**
   * What a chart of the mark alone loads for its options to be navigated by
   * pointer and keyboard (see dom/controls.ts); none when they turn nothing on.
   */
  controls?(config: ChartConfig): LayoutControls | undefined;
  /**
   * 3D charts, whose camera the pointer and keyboard turn: the camera `spec`
   * describes, its settings left out taken from `base` (by default the
   * default camera's). Throws for settings out of range.
   */
  camera?(spec: CameraSpec | undefined, base?: Camera): Camera;
}

/**
 * The controls a layout mark's chart loads (see `LayoutMark.controls`):
 * which ones, by the module the browser runtime loads for them
 * (dom/layout-controls.ts), and what their keys do.
 */
export interface LayoutControls {
  /** "layout" draws the frames a network's layout takes, for a chart without other controls. */
  kind: "orbit" | "map" | "drill" | "drag" | "layout";
  /** For the chart's description: what keys do beyond reading items. */
  hint: string;
}

/** Whether a pixel is inside a polygon of pixels, by the even-odd rule. */
export function insidePolygon(
  polygon: readonly (readonly [number, number])[],
  px: number,
  py: number,
): boolean {
  let odd = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!;
    const [xj, yj] = polygon[j]!;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) odd = !odd;
  }
  return odd;
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
 * What a layout mark works out from a selection of its table's rows (a
 * pie's selected sums), kept while the selection's membership and the rows
 * it is of are the same: those a frame gives (or a view of them), or every
 * row. Memberships are made again whenever the selection or the table
 * changes, and take what was kept with them.
 */
export class SelectionCache<T> {
  readonly #kept = new WeakMap<Uint8Array, { all?: T; some: WeakMap<object, T> }>();

  /** The value for the rows `selected` holds of `rows`, or of every row, from `compute` unless kept. */
  get(selected: Uint8Array, rows: object | undefined, compute: () => T): T {
    let kept = this.#kept.get(selected);
    if (!kept) {
      kept = { some: new WeakMap() };
      this.#kept.set(selected, kept);
    }
    const known = rows ? kept.some.get(rows) : kept.all;
    if (known !== undefined) return known;
    const value = compute();
    if (rows) kept.some.set(rows, value);
    else kept.all = value;
    return value;
  }
}

/**
 * The text a layout mark's item adds for what a highlighted selection holds
 * of it: "; 3 of 12 rows selected", with what they measure when the mark
 * sums a field ("; 3 of 12 rows selected, revenue 80 of 100").
 */
export function heldText(
  rows: number,
  of: number,
  measure: { field: string; held: number; of: number } | undefined,
  format: (value: number) => string,
): string {
  const text = `; ${format(rows)} of ${format(of)} ${of === 1 ? "row" : "rows"} selected`;
  return measure
    ? `${text}, ${measure.field} ${format(measure.held)} of ${format(measure.of)}`
    : text;
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
