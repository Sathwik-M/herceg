// Subplots: a chart drawn in several panels, each with the marks that name it
// in their `panel` option. A chart's `panels` option holds a
// Panels; charts without one never load this module. Marks keep their place
// in the chart's one list of marks, so their identity, colors, and legend
// state do not depend on the panel they draw in.

import type { AxisOptions, PanelOptions } from "../guides/options.ts";
import { type Align, aligned } from "../layout/place.ts";
import type { LayoutMark } from "../marks/layout-mark.ts";
import type { BandContext, Bands, Mark } from "../marks/mark.ts";
import type { Rect } from "../scene/scene.ts";
import type { GridSpec, ScaleScope } from "../spec/spec.ts";
import type { AxisType } from "./axis.ts";
import type { MarkSeries } from "./inspect.ts";
import {
  type AnnotatedPanel,
  across,
  annotations,
  checkBands,
  checkFit,
  checkLayouts,
  columnGap,
  type DescribeAnnotation,
  groups,
  type HeaderPlace,
  type LayoutConfig,
  leastHeight,
  lowestWithAxes,
  onAxis,
  type PanelAxis,
  PanelBands,
  type PanelChart,
  type PanelGrid,
  type PanelLayout,
  type PanelRoom,
  type PanelSplit,
  type PanelSplitter,
  type RowSpace,
  rowGap,
  type ScaleGroups,
  trackSizes,
  typedGroups,
  yAxesOf,
} from "./panel-layout.ts";
import { mixedPanels, type ScaledConfig, type ScaleName, type Scopes, scopesOf } from "./scales.ts";
import { titleText } from "./titles.ts";

/** The `panel` that draws a mark in every panel. */
export const EVERY_PANEL = "*";

/** Ids of functions in settings, so that settings compare them by identity. */
const functionIds = new WeakMap<object, number>();
let lastFunctionId = 0;
function functionId(value: object): number {
  let id = functionIds.get(value);
  if (id === undefined) {
    id = ++lastFunctionId;
    functionIds.set(value, id);
  }
  return id;
}

/**
 * Subplots for a chart's `panels` option: panels in rows of `columns` (1 by
 * default), in order, each drawing the marks whose `panel` names it, and
 * marks with `panel: "*"` in all of them. Panels share x unless the chart's
 * `x.scope` says otherwise; each has a y scale of its own unless its
 * `y.scope` does. A panel may change the chart's `x` and `y` settings for
 * its own axes. A layout mark (a pie) has the panel it names to itself,
 * without axes.
 *
 * ```ts
 * createChart(element, {
 *   marks: [
 *     line(metrics, { x: "time", y: "latency", panel: "latency" }),
 *     bar(metrics, { x: "time", y: "requests", panel: "traffic" }),
 *     rule({ x: deployedAt, panel: "*" }),
 *   ],
 *   panels: panels([
 *     { id: "latency", title: "Latency", y: { title: "ms" } },
 *     { id: "traffic", title: "Requests" },
 *   ]),
 * });
 * ```
 */
export function panels(list: readonly PanelOptions[], grid: GridSpec = {}): Panels {
  return new Panels(list, grid);
}

export class Panels implements PanelLayout {
  columnGap(
    labeled: readonly boolean[],
    right: boolean,
    columns: number,
    room: number,
    title: number,
  ): number {
    return columnGap(labeled, right, columns, room, title);
  }

  readonly list: readonly PanelOptions[];
  readonly columns: number;
  readonly rowHeights: readonly number[] | undefined;
  readonly columnWidths: readonly number[] | undefined;
  scopes(config: ScaledConfig): Scopes {
    return scopesOf(config, "panel");
  }

  mixed(numbers: Mark, categories: Mark, scale: ScaleName): Error {
    return mixedPanels(numbers, categories, scale, panelOf);
  }

  get remedy(): string {
    return "set the grid's columns";
  }

  constructor(list: readonly PanelOptions[], grid: GridSpec = {}) {
    if (list.length === 0) throw new RangeError("panels: expected at least one panel");
    const ids = new Set<string>();
    for (const [i, { id }] of list.entries()) {
      if (typeof id !== "string" || id === "" || id === EVERY_PANEL)
        throw new TypeError(
          `panels[${i}].id: expected a name other than "" and "*"; received ${JSON.stringify(id)}`,
        );
      if (ids.has(id)) throw new TypeError(`panels[${i}].id: "${id}" names two panels`);
      ids.add(id);
    }
    const { columns = 1, rowHeights, columnWidths } = grid;
    if (!(Number.isInteger(columns) && columns >= 1))
      throw new RangeError(
        `grid columns: expected a whole number of at least 1; received ${columns}`,
      );
    // A grid has no more columns than panels.
    const used = Math.min(columns, list.length);
    const rows = Math.ceil(list.length / used);
    if (rowHeights !== undefined) {
      if (rowHeights.length !== rows)
        throw new RangeError(
          `grid rowHeights: expected ${rows}, one per row; received ${rowHeights.length}`,
        );
      if (!positive(rowHeights))
        throw new RangeError(
          `grid rowHeights: expected positive numbers; received ${rowHeights.join(", ")}`,
        );
    }
    if (columnWidths !== undefined) {
      if (columnWidths.length !== used)
        throw new RangeError(
          `grid columnWidths: expected ${used}, one per column; received ${columnWidths.length}`,
        );
      if (!positive(columnWidths))
        throw new RangeError(
          `grid columnWidths: expected positive numbers; received ${columnWidths.join(", ")}`,
        );
    }
    this.list = list;
    this.columns = columns;
    this.rowHeights = rowHeights;
    this.columnWidths = columnWidths;
  }

  /**
   * Rejects marks that name no panel or an unknown one, marks sharing a
   * panel with a layout mark, which has it to itself (a map's layers are
   * one mark), and what panels with axes of their own cannot do yet:
   * zooming or brushing along y. Returns the layout marks drawn.
   */
  check(
    marks: readonly Mark[],
    options: LayoutConfig,
    given: readonly LayoutMark[] = [],
  ): LayoutMark[] {
    const ids = new Set(this.list.map(({ id }) => id));
    const unknown = (type: string, panel: string) =>
      new Error(
        `${type} panel: no panel "${panel}"; name one of ${[...ids].map((id) => `"${id}"`).join(", ")}`,
      );
    checkLayouts(given, true);
    for (const { spec } of given)
      if (spec.panel !== undefined && spec.panel !== EVERY_PANEL && !ids.has(spec.panel))
        throw unknown(spec.type, spec.panel);
    const layouts = given[0] ? given[0].views.inPanels(given, options, true) : [];
    // The panels layout marks have to themselves.
    const held = new Map<string, string>();
    for (const { spec } of layouts) {
      const { type, panel } = spec;
      if (panel === undefined || panel === EVERY_PANEL)
        throw new Error(
          `${type} panel: expected the id of the panel it draws in; received ${JSON.stringify(panel) ?? "none"}`,
        );
      if (!ids.has(panel)) throw unknown(type, panel);
      const other = held.get(panel);
      if (other)
        throw new Error(
          `${type} panel: a ${other} mark has panel "${panel}" too; give each a panel of its own`,
        );
      held.set(panel, type);
    }
    if (layouts[0])
      layouts[0].views.interactions(
        layouts,
        options,
        held.size < this.list.length,
        given[0]!.spec.type,
      );
    for (const [i, { id, x, y, yRight }] of this.list.entries())
      if (held.has(id) && (x || y || yRight))
        throw new Error(
          `panels[${i}]: the ${held.get(id)} mark it draws has no axes; drop its x, y, and yRight`,
        );
    for (const [i, panel] of this.list.entries())
      if (panel.camera && !layouts.some((mark) => mark.spec.panel === panel.id && mark.camera))
        throw new Error(
          `panels[${i}].camera: panel "${panel.id}" has no 3D marks; drop camera or add a 3D mark`,
        );
    const [first] = held;
    for (const mark of marks) {
      const { type, panel } = mark.spec;
      if (panel === undefined)
        throw new Error(`${type} panel: missing; give the id of a panel, or "*" for every panel`);
      if (panel !== EVERY_PANEL && !ids.has(panel)) throw unknown(type, panel);
      if (panel === EVERY_PANEL && first)
        throw new Error(
          `${type} panel: "*" would draw in panel "${first[0]}", which a ${first[1]} mark has to itself; give the id of a panel with axes`,
        );
      if (held.has(panel))
        throw new Error(
          `${type} panel: a ${held.get(panel)} mark has panel "${panel}" to itself; name another`,
        );
    }
    const { zoom, brush } = options.interaction ?? {};
    // Panels with axes zoom and brush along x; maps and networks with panels to themselves, their plane.
    if (
      held.size < this.list.length &&
      ((typeof zoom === "string" && zoom.includes("y")) ||
        brush === "y" ||
        brush === "xy" ||
        brush === "lasso")
    )
      throw new Error('chart interaction: charts with panels zoom and brush along x only; use "x"');
    const scopes = this.scopes(options);
    this.#agree("x", marks, scopes.x, options.x, held);
    this.#agree("y", marks, scopes.y, options.y, held);
    this.#agree("yRight", marks, scopes.yRight, options.yRight, held);
    checkBands(marks, options, scopes);
    return layouts;
  }

  /** Panels draw their marks whole. */
  splits(): boolean {
    return false;
  }

  /**
   * Panels sharing a scale must agree on how it is set up: as the chart's
   * settings with their own, and for y with the type their marks on that
   * side give. An x scale takes the chart's type unless they set one, as it
   * did before panels could have x scales of their own, and draws one
   * title, which they must agree on too; y titles are each panel's own.
   * Panels a layout mark has (`held`) have no axes, and panels without
   * marks on the right axis none there, and so nothing to agree on.
   */
  #agree(
    axis: PanelAxis,
    marks: readonly Mark[],
    scope: ScaleScope,
    chart: AxisOptions | undefined,
    held: ReadonlyMap<string, string>,
  ): void {
    if (scope === "panel") return;
    const { columns } = this;
    const groupOf = (i: number) =>
      scope === "row" ? Math.floor(i / columns) : scope === "column" ? i % columns : 0;
    const first = new Map<number, string>();
    const x = axis === "x";
    this.list.forEach(({ id }, i) => {
      if (held.has(id)) return;
      const spec = this.panelAxis(axis, i, chart);
      const inPanel = marks.filter(({ spec }) => spec.panel === id || spec.panel === EVERY_PANEL);
      // Panels without the axis (as the chart draws them) have nothing to agree on.
      if (!x && !yAxesOf(inPanel)[axis === "y" ? "left" : "right"]) return;
      const drawn = inPanel.filter((mark) => onAxis(mark, axis));
      const type = spec?.type ?? (x ? undefined : typeOf(drawn, "y"));
      const { domain, zero, nice, ticks, format, tooltipFormat } = spec ?? {};
      const policy = JSON.stringify(
        [type, domain, zero, nice, ticks, format, tooltipFormat, x && spec?.title],
        // Tick generators and formatters agree when they are the same function.
        (_, value) => (typeof value === "function" ? `function ${functionId(value)}` : value),
      );
      const seen = first.get(groupOf(i));
      if (seen === undefined) first.set(groupOf(i), policy);
      else if (seen !== policy)
        throw new Error(
          `panels[${i}].${axis}: shares ${x ? "an x" : axis === "y" ? "a y" : "a right y"} scale with others but differs in type, domain, zero, nice, ticks, format, ${x ? "tooltipFormat, or title" : "or tooltipFormat"}; match them`,
        );
    });
  }

  /** A chart's splitter, which keeps its panels' categories (see PanelBands). */
  splitter(): PanelSplitter {
    const placed = new PanelBands();
    return {
      split: (base, chart, bands, context) => this.#split(base, chart, bands, context, placed),
    };
  }

  /** Every mark in the panels it names, with all of its series there; layout marks alone. */
  #split(
    base: readonly MarkSeries[],
    chart: PanelChart,
    bands: Bands,
    context: BandContext,
    placed: PanelBands,
  ): PanelSplit {
    const columns = Math.min(this.columns, this.list.length);
    const { length } = this.list;
    checkFit({ rows: Math.ceil(length / columns), columns }, length, chart, this.remedy);
    const members = this.list.map(({ id }) =>
      base.map(({ mark }) => mark.spec.panel === id || mark.spec.panel === EVERY_PANEL),
    );
    const split: PanelSplit = {
      keys: this.list.map(({ id }) => id),
      values: this.list.map(({ id, title }) => [titleText(title) ?? id]),
      dimensions: [],
      panels: members.map((drawn) =>
        base.map(({ mark, series }, m) => ({ mark, series: drawn[m] ? series : [] })),
      ),
      members,
      all: [...base],
    };
    const { marks } = chart.config;
    const items = this.list.map(({ id }) => {
      const mark = chart.layouts.find(({ spec }) => spec.panel === id);
      return mark && { mark, index: mark.indices?.[0] ?? marks.indexOf(mark), rows: undefined };
    });
    if (items.some(Boolean)) split.items = items;
    placed.place(split, columns, bands, this.scopes(chart.config), context);
    return split;
  }

  grid(split: PanelSplit, lineHeight: number): PanelGrid {
    const { length } = this.list;
    const columns = Math.min(this.columns, length);
    const rows = Math.ceil(length / columns);
    const titled = this.list.some(({ title }) => title);
    return {
      ...lowestWithAxes(split, columns),
      columns,
      rows,
      header: titled ? lineHeight + 4 : 0,
      columnHeader: 0,
      rowHeader: 0,
      rowWeights: this.rowHeights,
      columnWeights: this.columnWidths,
      least: leastHeight(rows, this.rowHeights, length),
    };
  }

  /** A panel's title above it, at the start of its plot's width unless `align` says. */
  headers(
    index: number,
    _values: readonly string[],
    _row: number,
    _column: number,
    plot: Rect,
    grid: PanelGrid,
    fit: (text: string, room: number) => string,
    _aside: number,
    align: Align | undefined,
  ): HeaderPlace[] {
    const title = titleText(this.list[index]?.title);
    if (!grid.header || !title) return [];
    const text = fit(title, plot.width);
    const { at, anchor } = aligned(align ?? "start", plot.x, plot.width);
    return [{ text, x: at, y: plot.y - grid.header / 2, anchor, angle: 0 }];
  }

  /** The chart's `x`, `y`, or `yRight`, with the panel's own settings in place of its. */
  panelAxis(
    axis: PanelAxis,
    index: number,
    chart: AxisOptions | undefined,
  ): AxisOptions | undefined {
    const own = this.list[index]?.[axis];
    return own ? { ...chart, ...own } : chart;
  }

  rowGap(grid: PanelGrid, panels: number, space: RowSpace): number {
    return rowGap(grid, panels, space);
  }

  tracks(
    free: number,
    count: number,
    weights: readonly number[] | undefined,
    panels: number,
    columns: number,
    room: PanelRoom,
  ): number[] {
    return trackSizes(free, count, weights, panels, columns, room, this.remedy);
  }

  /**
   * A group's axis is its first panel's, which the others agree with (see
   * `check`), of the type the marks its panels draw give unless that panel
   * sets one: categories in one subplot leave another's scale alone.
   */
  groups(
    scope: ScaleScope,
    split: PanelSplit,
    columns: number,
    axis: PanelAxis,
    chart: AxisOptions | undefined,
  ): ScaleGroups {
    const found = groups(scope, split, columns, axis);
    return typedGroups(found, axis, (g) => this.panelAxis(axis, found.first[g]!, chart), panelOf);
  }

  across(
    split: PanelSplit,
    groupOf: readonly number[],
    by: readonly number[],
  ): [number, MarkSeries[]][][] {
    return across(split, groupOf, by);
  }

  annotations(
    views: readonly AnnotatedPanel[],
    marks: readonly Mark[],
    describe: DescribeAnnotation,
    panel?: string,
  ): string[] {
    return annotations(views, marks, describe, true, panel);
  }

  describe(labels: readonly string[], max: number): string {
    const named = labels.slice(0, max).join(", ");
    const more = labels.length > max ? `, and ${labels.length - max} more` : "";
    return `Panels: ${named}${more}.`;
  }
}

/** A time axis when marks place times along `axis`; else a linear one. */
function typeOf(marks: readonly Mark[], axis: "x" | "y"): AxisType {
  return marks.some((mark) => mark.channelKind(axis) === "time") ? "time" : "linear";
}

/** Whether every weight is a positive number; `every` would skip a sparse array's holes. */
function positive(weights: readonly number[]): boolean {
  for (const weight of weights) if (!(weight > 0 && Number.isFinite(weight))) return false;
  return true;
}

/** The one panel a mark draws in, for errors; undefined for marks drawn in every panel. */
function panelOf({ spec }: Mark): string | undefined {
  return spec.panel === EVERY_PANEL ? undefined : spec.panel;
}
