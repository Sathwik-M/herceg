// Subplots: a chart drawn in several panels, each with the marks that name it
// in their `panel` option, sharing x. A chart's `panels` option holds a
// Panels; charts without one never load this module. Marks keep their place
// in the chart's one list of marks, so their identity, colors, and legend
// state do not depend on the panel they draw in.

import type { Mark } from "../marks/mark.ts";
import type { Rect, SceneText } from "../scene/scene.ts";
import type { AxisSpec, ChartSpec, GridSpec, PanelSpec, ScaleResolution } from "../spec/spec.ts";
import type { AxisType } from "./axis.ts";
import type { MarkSeries } from "./inspect.ts";
import {
  type PanelCheck,
  type PanelGrid,
  type PanelLayout,
  type PanelSplit,
  yGroups,
} from "./panel-layout.ts";

/** The `panel` that draws a mark in every panel. */
export const EVERY_PANEL = "*";

/**
 * Subplots for a chart's `panels` option: panels in rows of `columns` (1 by
 * default), in order, each drawing the marks whose `panel` names it, and
 * marks with `panel: "*"` in all of them. Panels share x; each has a y scale
 * of its own unless the chart's `resolve.y` says otherwise, and may change
 * the chart's `y` settings for its own axis.
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
    const { columns = 1 } = grid;
    if (!(Number.isInteger(columns) && columns >= 1))
      throw new RangeError(`A grid's columns must be a whole number of at least 1, not ${columns}`);
    this.list = list;
    this.columns = columns;
  }

  /**
   * Rejects marks that name no panel or an unknown one, and what panels with
   * axes of their own cannot do yet: right axes, and zooming or brushing
   * along y.
   */
  check(marks: readonly Mark[], options: Pick<ChartSpec, "resolve" | "interaction" | "y">): void {
    const ids = new Set(this.list.map(({ id }) => id));
    for (const mark of marks) {
      const { type, panel } = mark.spec;
      if (panel === undefined)
        throw new Error(
          `A ${type} mark in a chart with panels needs a panel: the id of one, or "*" for every panel`,
        );
      if (panel !== EVERY_PANEL && !ids.has(panel))
        throw new Error(`A ${type} mark names the panel "${panel}", which the chart does not have`);
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
    const resolution = options.resolve?.y ?? "independent";
    if (resolution === "independent") return;
    // Panels sharing a y scale must agree on how it is set up, as the
    // chart's settings with their own and with the type their marks give.
    const { columns } = this;
    const groupOf = (i: number) =>
      resolution === "rows" ? Math.floor(i / columns) : resolution === "columns" ? i % columns : 0;
    const first = new Map<number, string>();
    this.list.forEach(({ id }, i) => {
      const drawn = marks.filter(({ spec }) => spec.panel === id || spec.panel === EVERY_PANEL);
      const spec = this.panelAxis(i, options.y);
      const type = spec?.type ?? typeOf(drawn);
      const policy = JSON.stringify([
        type,
        spec?.domain,
        spec?.zero,
        spec?.nice,
        spec?.ticks,
        spec?.format,
      ]);
      const seen = first.get(groupOf(i));
      if (seen === undefined) first.set(groupOf(i), policy);
      else if (seen !== policy)
        throw new Error(
          `Panel "${id}" shares a y scale with others but differs in its type, domain, zero, nice, ticks, or format`,
        );
    });
  }

  splitter(): { split(base: readonly MarkSeries[], check: PanelCheck): PanelSplit } {
    return { split: (base, check) => this.#split(base, check) };
  }

  /** Every mark in the panels it names, with all of its series there. */
  #split(base: readonly MarkSeries[], check: PanelCheck): PanelSplit {
    const columns = Math.min(this.columns, this.list.length);
    check({ rows: Math.ceil(this.list.length / columns), columns }, this.list.length);
    const members = this.list.map(({ id }) =>
      base.map(({ mark }) => mark.spec.panel === id || mark.spec.panel === EVERY_PANEL),
    );
    return {
      keys: this.list.map(({ id }) => id),
      values: this.list.map(({ id, title }) => [title ?? id]),
      dimensions: [],
      panels: members.map((drawn) =>
        base.map(({ mark, series }, m) => ({ mark, series: drawn[m] ? series : [] })),
      ),
      members,
      all: [...base],
    };
  }

  grid(_split: PanelSplit, lineHeight: number): PanelGrid {
    const columns = Math.min(this.columns, this.list.length);
    const titled = this.list.some(({ title }) => title);
    return {
      columns,
      rows: Math.ceil(this.list.length / columns),
      header: titled ? lineHeight + 4 : 0,
      columnHeader: 0,
      rowHeader: 0,
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

  /** A group's axis is its first panel's, which the others agree with (see `check`). */
  groupAxis(
    index: number,
    drawn: readonly MarkSeries[],
    chart: AxisSpec | undefined,
  ): { type: AxisType; spec: AxisSpec | undefined } {
    const spec = this.panelAxis(index, chart);
    return { type: spec?.type ?? typeOf(drawn.map(({ mark }) => mark)), spec };
  }

  /** The chart's `y`, with the panel's own settings in place of its. */
  panelAxis(index: number, chart: AxisSpec | undefined): AxisSpec | undefined {
    const own = this.list[index]?.y;
    return own ? { ...chart, ...own } : chart;
  }

  yGroups(
    resolution: ScaleResolution,
    split: PanelSplit,
    columns: number,
  ): { groupOf: number[]; drawn: MarkSeries[][] } {
    return yGroups(resolution, split, columns);
  }

  describe(labels: readonly string[], max: number): string {
    const named = labels.slice(0, max).join(", ");
    const more = labels.length > max ? `, and ${labels.length - max} more` : "";
    return `Panels: ${named}${more}.`;
  }
}

/** A time axis when marks place times along y; else a linear one. */
function typeOf(marks: readonly Mark[]): AxisType {
  return marks.some((mark) => mark.channelKind("y") === "time") ? "time" : "linear";
}
