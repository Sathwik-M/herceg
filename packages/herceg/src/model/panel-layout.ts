// What lays a chart out in panels: a facet, which splits rows by category
// values, or subplots, whose marks name their panel. The model reads either
// through these types; their code loads only with a facet or panels.

import type { Mark } from "../marks/mark.ts";
import type { Rect, SceneText } from "../scene/scene.ts";
import type { AxisSpec, ChartSpec, ScaleResolution } from "../spec/spec.ts";
import type { AxisType } from "./axis.ts";
import type { MarkSeries } from "./inspect.ts";

/** Where a chart's panels go: a grid of `columns` by `rows`, and the room headers take. */
export interface PanelGrid {
  columns: number;
  rows: number;
  /** Above every panel, for wrapped facets and titled subplots. */
  header: number;
  /** Above the top row and beside the last column, for a grid's columns and rows. */
  columnHeader: number;
  rowHeader: number;
}

/** The panels of a scene: their keys, each one's marks and series, and every mark's across panels. */
export interface PanelSplit {
  keys: string[];
  /** What names each panel: its facet values, or a subplot's title. */
  values: string[][];
  /** Each facet field's values in order of first appearance: a grid's rows, then its columns. */
  dimensions: string[][];
  /** Per panel, every mark (in the chart's order) with its series there. */
  panels: MarkSeries[][];
  /** Per panel and mark, whether the mark draws there; every mark does, without it. */
  members?: boolean[][];
  /** Each mark's series in all panels; marks that repeat, once. */
  all: MarkSeries[];
}

/** Sees a split's rows and columns of panels, and throws if the chart cannot draw them. */
export type PanelCheck = (shape: { rows: number; columns: number }, panels: number) => void;

export interface PanelLayout {
  /** Rejects marks and options the panels cannot draw. */
  check(marks: readonly Mark[], options: Pick<ChartSpec, "resolve" | "interaction" | "y">): void;
  /** Splits a chart's series into panels, keeping what it can from one scene to the next. */
  splitter(): { split(base: readonly MarkSeries[], check: PanelCheck): PanelSplit };
  grid(split: PanelSplit, lineHeight: number): PanelGrid;
  /** The headers panel `index`, named by `values`, at `plot`, carries. */
  headers(
    index: number,
    values: readonly string[],
    row: number,
    column: number,
    plot: Rect,
    grid: PanelGrid,
    fit: (text: string, room: number) => string,
  ): SceneText[];
  /** What to do when the panels do not fit, for the error saying so. */
  readonly remedy: string;
  /** How panels share y when the chart's `resolve` does not say. */
  readonly yDefault: ScaleResolution;
  /**
   * The y axis of a group of panels sharing a scale, whose first is panel
   * `index` and which draws `drawn`: its settings over the chart's, and its type.
   */
  groupAxis(
    index: number,
    drawn: readonly MarkSeries[],
    chart: AxisSpec | undefined,
    chartType: AxisType,
  ): { type: AxisType; spec: AxisSpec | undefined };
  /** Panel `index`'s y axis settings: the chart's, with the panel's own. */
  panelAxis(index: number, chart: AxisSpec | undefined): AxisSpec | undefined;
  yGroups(
    resolution: ScaleResolution,
    split: PanelSplit,
    columns: number,
  ): { groupOf: number[]; drawn: MarkSeries[][] };
  /** A sentence naming the panels, up to `max` of their labels. */
  describe(labels: readonly string[], max: number): string;
}

/**
 * The groups of a split's panels that share a y scale under `resolution`
 * (each panel alone, or the panels of a row or of a column, in rows of
 * `columns`): each panel's group, and what each group's panels draw.
 */
export function yGroups(
  resolution: ScaleResolution,
  split: PanelSplit,
  columns: number,
): { groupOf: number[]; drawn: MarkSeries[][] } {
  const groupOf = split.panels.map((_, i) =>
    resolution === "independent"
      ? i
      : resolution === "rows"
        ? Math.floor(i / columns)
        : resolution === "columns"
          ? i % columns
          : 0,
  );
  // A group's marks are those drawn in any of its panels, in the chart's order.
  const drawn: (MarkSeries | undefined)[][] = [];
  split.panels.forEach((marks, i) => {
    const at = groupOf[i]!;
    drawn[at] ??= marks.map(() => undefined);
    const group = drawn[at];
    marks.forEach(({ mark, series }, m) => {
      if (split.members && !split.members[i]![m]) return;
      group[m] ??= { mark, series: [] };
      const entry = group[m];
      // A mark with no rows in a panel adds nothing to its group, not even
      // the zero a bar stands on; a mark repeated in every panel, once.
      for (const s of series) if (s.length > 0 && !entry.series.includes(s)) entry.series.push(s);
    });
  });
  return {
    groupOf,
    drawn: drawn.map((group) => group.filter((entry) => entry !== undefined)),
  };
}
