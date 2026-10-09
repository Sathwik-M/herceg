// Subplots: a chart drawn in several panels, each with the marks that name it
// in their `panel` option. A chart's `panels` option holds a
// Panels; charts without one never load this module. Marks keep their place
// in the chart's one list of marks, so their identity, colors, and legend
// state do not depend on the panel they draw in.

import type { Mark } from "../marks/mark.ts";
import type { Rect, SceneText } from "../scene/scene.ts";
import type { AxisSpec, ChartSpec, GridSpec, PanelSpec, ScaleResolution } from "../spec/spec.ts";
import type { AxisType } from "./axis.ts";
import type { MarkSeries } from "./inspect.ts";
import {
  across,
  groups,
  type PanelCheck,
  type PanelGrid,
  type PanelGroups,
  type PanelLayout,
  type PanelSplit,
} from "./panel-layout.ts";

/** The `panel` that draws a mark in every panel. */
export const EVERY_PANEL = "*";

/**
 * Subplots for a chart's `panels` option: panels in rows of `columns` (1 by
 * default), in order, each drawing the marks whose `panel` names it, and
 * marks with `panel: "*"` in all of them. Panels share x unless the chart's
 * `resolve.x` says otherwise; each has a y scale of its own unless its
 * `resolve.y` does. A panel may change the chart's `x` and `y` settings for
 * its own axes.
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
    const { columns = 1, rowHeights } = grid;
    if (!(Number.isInteger(columns) && columns >= 1))
      throw new RangeError(`A grid's columns must be a whole number of at least 1, not ${columns}`);
    const rows = Math.ceil(list.length / Math.min(columns, list.length));
    if (rowHeights !== undefined) {
      if (rowHeights.length !== rows)
        throw new RangeError(
          `A grid of ${rows} rows needs ${rows} row heights, not ${rowHeights.length}`,
        );
      if (!rowHeights.every((h) => h > 0 && Number.isFinite(h)))
        throw new RangeError(
          `A grid's row heights must be positive numbers, not ${rowHeights.join(", ")}`,
        );
    }
    this.list = list;
    this.columns = columns;
    this.rowHeights = rowHeights;
  }

  /**
   * Rejects marks that name no panel or an unknown one, and what panels with
   * axes of their own cannot do yet: right axes, and zooming or brushing
   * along y.
   */
  check(
    marks: readonly Mark[],
    options: Pick<ChartSpec, "resolve" | "interaction" | "x" | "y">,
  ): void {
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
    this.#agree("x", marks, options.resolve?.x ?? "shared", options.x);
    this.#agree("y", marks, options.resolve?.y ?? "independent", options.y);
  }

  /**
   * Panels sharing a scale must agree on how it is set up: as the chart's
   * settings with their own, and for y with the type their marks give. An
   * x scale takes the chart's type unless they set one, as it did before
   * panels could have x scales of their own, and draws one title, which
   * they must agree on too; y titles are each panel's own.
   */
  #agree(
    axis: "x" | "y",
    marks: readonly Mark[],
    resolution: ScaleResolution,
    chart: AxisSpec | undefined,
  ): void {
    if (resolution === "independent") return;
    const { columns } = this;
    const groupOf = (i: number) =>
      resolution === "rows" ? Math.floor(i / columns) : resolution === "columns" ? i % columns : 0;
    const first = new Map<number, string>();
    this.list.forEach(({ id }, i) => {
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
      rowWeights: this.rowHeights,
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
    axis: "x" | "y",
    index: number,
    drawn: readonly MarkSeries[],
    chart: AxisSpec | undefined,
  ): { type: AxisType; spec: AxisSpec | undefined } {
    const spec = this.panelAxis(axis, index, chart);
    return {
      type:
        spec?.type ??
        typeOf(
          drawn.map(({ mark }) => mark),
          axis,
        ),
      spec,
    };
  }

  /** The chart's `x` or `y`, with the panel's own settings in place of its. */
  panelAxis(axis: "x" | "y", index: number, chart: AxisSpec | undefined): AxisSpec | undefined {
    const own = this.list[index]?.[axis];
    return own ? { ...chart, ...own } : chart;
  }

  groups(resolution: ScaleResolution, split: PanelSplit, columns: number): PanelGroups {
    return groups(resolution, split, columns);
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
