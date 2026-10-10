// Subplots: a chart drawn in several panels, each with the marks that name it
// in their `panel` option. A chart's `panels` option holds a
// Panels; charts without one never load this module. Marks keep their place
// in the chart's one list of marks, so their identity, colors, and legend
// state do not depend on the panel they draw in.

import { isLayoutMark, type LayoutMark } from "../marks/layout-mark.ts";
import type { Bands, Mark } from "../marks/mark.ts";
import type { Rect, SceneText } from "../scene/scene.ts";
import type { AxisSpec, GridSpec, PanelSpec, ScaleResolution } from "../spec/spec.ts";
import type { AxisType } from "./axis.ts";
import type { MarkSeries } from "./inspect.ts";
import {
  across,
  checkBands,
  checkLayouts,
  groups,
  type LayoutOptions,
  lowestWithAxes,
  PanelBands,
  type PanelChart,
  type PanelCheck,
  type PanelGrid,
  type PanelGroups,
  type PanelLayout,
  type PanelSplit,
  type PanelSplitter,
  refuseAxes,
} from "./panel-layout.ts";

/** The `panel` that draws a mark in every panel. */
export const EVERY_PANEL = "*";

/**
 * Subplots for a chart's `panels` option: panels in rows of `columns` (1 by
 * default), in order, each drawing the marks whose `panel` names it, and
 * marks with `panel: "*"` in all of them. Panels share x unless the chart's
 * `resolve.x` says otherwise; each has a y scale of its own unless its
 * `resolve.y` does. A panel may change the chart's `x` and `y` settings for
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
 *     { id: "latency", title: "Latency", y: { label: "ms" } },
 *     { id: "traffic", title: "Requests" },
 *   ]),
 * });
 * ```
 */
export function panels(list: readonly PanelSpec[], grid: GridSpec = {}): Panels {
  return new Panels(list, grid);
}

export class Panels implements PanelLayout {
  readonly list: readonly PanelSpec[];
  readonly columns: number;
  readonly rowHeights: readonly number[] | undefined;
  readonly columnWidths: readonly number[] | undefined;
  get yDefault(): ScaleResolution {
    return "independent";
  }

  get remedy(): string {
    return "set the grid's columns";
  }

  constructor(list: readonly PanelSpec[], grid: GridSpec = {}) {
    if (list.length === 0) throw new RangeError("A chart's panels need at least one panel");
    const ids = new Set<string>();
    for (const { id } of list) {
      if (typeof id !== "string" || id === "" || id === EVERY_PANEL)
        throw new TypeError(
          `A panel's id must be a name other than "" and "*", not ${JSON.stringify(id)}`,
        );
      if (ids.has(id)) throw new TypeError(`Two panels have the id "${id}"`);
      ids.add(id);
    }
    const { columns = 1, rowHeights, columnWidths } = grid;
    if (!(Number.isInteger(columns) && columns >= 1))
      throw new RangeError(`A grid's columns must be a whole number of at least 1, not ${columns}`);
    // A grid has no more columns than panels.
    const used = Math.min(columns, list.length);
    const rows = Math.ceil(list.length / used);
    if (rowHeights !== undefined) {
      if (rowHeights.length !== rows)
        throw new RangeError(
          `A grid of ${rows} rows needs ${rows} row heights, not ${rowHeights.length}`,
        );
      if (!positive(rowHeights))
        throw new RangeError(
          `A grid's row heights must be positive numbers, not ${rowHeights.join(", ")}`,
        );
    }
    if (columnWidths !== undefined) {
      if (columnWidths.length !== used)
        throw new RangeError(
          `A grid of ${used} columns needs ${used} column widths, not ${columnWidths.length}`,
        );
      if (!positive(columnWidths))
        throw new RangeError(
          `A grid's column widths must be positive numbers, not ${columnWidths.join(", ")}`,
        );
    }
    this.list = list;
    this.columns = columns;
    this.rowHeights = rowHeights;
    this.columnWidths = columnWidths;
  }

  /**
   * Rejects marks that name no panel or an unknown one, marks sharing a
   * panel with a layout mark, which has it to itself, and what panels with
   * axes of their own cannot do yet: right axes, zooming or brushing along
   * y, and a navigator.
   */
  check(marks: readonly Mark[], options: LayoutOptions, layouts: readonly LayoutMark[] = []): void {
    if (options.navigator) throw new Error("Charts with panels cannot have a navigator yet");
    const ids = new Set(this.list.map(({ id }) => id));
    const unknown = (type: string, panel: string) =>
      new Error(`A ${type} mark names the panel "${panel}", which the chart does not have`);
    checkLayouts(layouts);
    // The panels layout marks have to themselves.
    const held = new Map<string, string>();
    for (const { spec } of layouts) {
      const { type, panel } = spec;
      if (panel === undefined || panel === EVERY_PANEL)
        throw new Error(
          `A ${type} mark in a chart with panels needs the id of the panel it draws in`,
        );
      if (!ids.has(panel)) throw unknown(type, panel);
      const other = held.get(panel);
      if (other)
        throw new Error(
          `Panel "${panel}" has two layout marks, a ${other} and a ${type}; give each a panel of its own`,
        );
      held.set(panel, type);
    }
    if (held.size === this.list.length) refuseAxes(layouts[0]!.spec.type, options);
    for (const { id, x, y } of this.list)
      if (held.has(id) && (x || y))
        throw new Error(
          `Panel "${id}" draws a ${held.get(id)} mark, which has no axes: it takes no x or y settings`,
        );
    const [first] = held;
    for (const mark of marks) {
      const { type, panel } = mark.spec;
      if (panel === undefined)
        throw new Error(
          `A ${type} mark in a chart with panels needs a panel: the id of one, or "*" for every panel`,
        );
      if (panel !== EVERY_PANEL && !ids.has(panel)) throw unknown(type, panel);
      if (panel === EVERY_PANEL && first)
        throw new Error(
          `A ${type} mark with panel "*" would draw in panel "${first[0]}", which a ${first[1]} mark has to itself; give it the id of a panel with axes`,
        );
      if (held.has(panel))
        throw new Error(
          `A ${type} mark names the panel "${panel}", which a ${held.get(panel)} mark has to itself`,
        );
      if (mark.spec.axis === "right")
        throw new Error("Charts with panels cannot use the right axis yet");
    }
    const { zoom, brush } = options.interaction ?? {};
    if (
      (typeof zoom === "string" && zoom.includes("y")) ||
      brush === "y" ||
      brush === "xy" ||
      brush === "lasso"
    )
      throw new Error("Charts with panels can zoom and brush along x only");
    this.#agree("x", marks, options.resolve?.x ?? "shared", options.x, held);
    this.#agree("y", marks, options.resolve?.y ?? "independent", options.y, held);
    checkBands(marks, options, this.yDefault);
  }

  /** Panels draw their marks whole. */
  splits(): boolean {
    return false;
  }

  /**
   * Panels sharing a scale must agree on how it is set up: as the chart's
   * settings with their own, and for y with the type their marks give. An
   * x scale takes the chart's type unless they set one, as it did before
   * panels could have x scales of their own, and draws one title, which
   * they must agree on too; y titles are each panel's own. Panels a layout
   * mark has (`held`) have no axes, and so nothing to agree on.
   */
  #agree(
    axis: "x" | "y",
    marks: readonly Mark[],
    resolution: ScaleResolution,
    chart: AxisSpec | undefined,
    held: ReadonlyMap<string, string>,
  ): void {
    if (resolution === "independent") return;
    const { columns } = this;
    const groupOf = (i: number) =>
      resolution === "rows" ? Math.floor(i / columns) : resolution === "columns" ? i % columns : 0;
    const first = new Map<number, string>();
    this.list.forEach(({ id }, i) => {
      if (held.has(id)) return;
      const spec = this.panelAxis(axis, i, chart);
      const drawn = marks.filter(({ spec }) => spec.panel === id || spec.panel === EVERY_PANEL);
      const x = axis === "x";
      const type = spec?.type ?? (x ? undefined : typeOf(drawn, axis));
      const { domain, zero, nice, ticks, format } = spec ?? {};
      const policy = JSON.stringify([type, domain, zero, nice, ticks, format, x && spec?.label]);
      const seen = first.get(groupOf(i));
      if (seen === undefined) first.set(groupOf(i), policy);
      else if (seen !== policy)
        throw new Error(
          `Panel "${id}" shares ${x ? "an x" : "a y"} scale with others but differs in its type, domain, zero, nice, ticks, ${x ? "format, or label" : "or format"}`,
        );
    });
  }

  /** A chart's splitter, which keeps its panels' categories (see PanelBands). */
  splitter(): PanelSplitter {
    const placed = new PanelBands();
    return { split: (base, check, chart, bands) => this.#split(base, check, chart, bands, placed) };
  }

  /** Every mark in the panels it names, with all of its series there; layout marks alone. */
  #split(
    base: readonly MarkSeries[],
    check: PanelCheck,
    chart: PanelChart,
    bands: Bands,
    placed: PanelBands,
  ): PanelSplit {
    const columns = Math.min(this.columns, this.list.length);
    check({ rows: Math.ceil(this.list.length / columns), columns }, this.list.length);
    const members = this.list.map(({ id }) =>
      base.map(({ mark }) => mark.spec.panel === id || mark.spec.panel === EVERY_PANEL),
    );
    const split: PanelSplit = {
      keys: this.list.map(({ id }) => id),
      values: this.list.map(({ id, title }) => [title ?? id]),
      dimensions: [],
      panels: members.map((drawn) =>
        base.map(({ mark, series }, m) => ({ mark, series: drawn[m] ? series : [] })),
      ),
      members,
      all: [...base],
    };
    const { marks } = chart.config;
    const items = this.list.map(({ id }) => {
      const index = marks.findIndex((mark) => isLayoutMark(mark) && mark.spec.panel === id);
      const mark = marks[index] as LayoutMark | undefined;
      return mark && { mark, index, rows: undefined };
    });
    if (items.some(Boolean)) split.items = items;
    placed.place(split, columns, bands, chart.config.resolve, this.yDefault);
    return split;
  }

  grid(split: PanelSplit, lineHeight: number): PanelGrid {
    const columns = Math.min(this.columns, this.list.length);
    const titled = this.list.some(({ title }) => title);
    return {
      ...lowestWithAxes(split, columns),
      columns,
      rows: Math.ceil(this.list.length / columns),
      header: titled ? lineHeight + 4 : 0,
      columnHeader: 0,
      rowHeader: 0,
      rowWeights: this.rowHeights,
      columnWeights: this.columnWidths,
    };
  }

  /** A panel's title above it. */
  headers(
    index: number,
    _values: readonly string[],
    _row: number,
    _column: number,
    plot: Rect,
    grid: PanelGrid,
    fit: (text: string, room: number) => string,
  ): SceneText[] {
    const title = this.list[index]?.title;
    if (!grid.header || !title) return [];
    const text = fit(title, plot.width);
    return [{ text, x: plot.x, y: plot.y - grid.header / 2, anchor: "start", angle: 0 }];
  }

  /**
   * A group's axis is its first panel's, which the others agree with (see
   * `check`); a category axis is one in every panel.
   */
  groupAxis(
    axis: "x" | "y",
    index: number,
    drawn: readonly MarkSeries[],
    chart: AxisSpec | undefined,
    chartType: AxisType,
  ): { type: AxisType; spec: AxisSpec | undefined } {
    const spec = this.panelAxis(axis, index, chart);
    const type =
      chartType === "band"
        ? chartType
        : (spec?.type ??
          typeOf(
            drawn.map(({ mark }) => mark),
            axis,
          ));
    return { type, spec };
  }

  /** The chart's `x` or `y`, with the panel's own settings in place of its. */
  panelAxis(axis: "x" | "y", index: number, chart: AxisSpec | undefined): AxisSpec | undefined {
    const own = this.list[index]?.[axis];
    return own ? { ...chart, ...own } : chart;
  }

  groups(
    resolution: ScaleResolution,
    split: PanelSplit,
    columns: number,
    axis: "x" | "y",
  ): PanelGroups {
    return groups(resolution, split, columns, axis);
  }

  across(
    split: PanelSplit,
    groupOf: readonly number[],
    by: readonly number[],
  ): [number, MarkSeries[]][][] {
    return across(split, groupOf, by);
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
