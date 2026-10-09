// Chart events as the Python package reads them (python/src/herceg/_events.py):
// plain JSON in which the axes holding times are named, so Python can return
// datetimes, and category positions are their labels rather than band indices.

import type { Chart, Inspection, Selection, Viewport } from "herceg";

type Ends = [number, number] | [string, string];
type Range = readonly [number, number];
type Axis = "x" | "y" | "yRight";
/** What these functions read of an axis' scale. */
type Scale = { readonly type: string; readonly categories?: readonly string[] | undefined };

/** A viewport: each axis' range, or null where it is not zoomed. */
export interface ViewportPayload {
  x: Ends | null;
  y: Ends | null;
  yRight: Ends | null;
  /** The axes whose values are times, in epoch milliseconds. */
  time?: Axis[];
}

/** A selection: x and y ranges and a lasso's outline. */
export interface SelectionPayload {
  x: Ends | null;
  y: Ends | null;
  /** [x, y] pairs: numbers, epoch ms on time axes, and band positions on category axes. */
  lasso: [number, number][] | null;
  /**
   * For a lasso over category axes, their categories, which its band
   * positions refer to: elsewhere they would outline other categories.
   */
  categories?: Categories;
  time?: Axis[];
}

/** The categories of a selection's x and y axes; null for an axis of other values. */
type Categories = [string[] | null, string[] | null];

export interface InspectionPayload {
  /** "item" for a pie slice, whose value is the slice's. */
  axis: "x" | "y" | "item";
  value: number | string | null;
  time: boolean;
  label: string;
  panel?: string;
  points: {
    mark: number;
    markId: string | null;
    key: string;
    label: string;
    row: number | null;
    value: number | null;
    text: string;
  }[];
  /** An item's data by field (a 3D chart's point): numbers, times in epoch ms, and categories. */
  values?: Readonly<Record<string, number | string>>;
}

/** What reads a chart's axes: their scales, as Python sees their values. */
interface Scales {
  x: Scale | undefined;
  y: Scale | undefined;
  yRight?: Scale | undefined;
}

/**
 * The scales of the axes Python reads: x, which every panel of a live chart
 * shares, and the y axes of `panel` (by default the first panel's).
 */
function scalesOf(chart: Chart, panel?: string): Scales {
  const { model } = chart;
  const found = model.panels().find(({ key }) => key === panel);
  return {
    x: model.xScale(),
    y: found?.y ?? model.yScale(),
    yRight: found?.yRight ?? model.yRightScale(),
  };
}

const timeAxes = (scales: Scales, axes: readonly Axis[]): Axis[] =>
  axes.filter((axis) => scales[axis]?.type === "time");

export function viewportPayload(chart: Chart, view: Viewport): ViewportPayload {
  const scales = scalesOf(chart);
  return {
    x: ends(view.x, scales.x),
    y: ends(view.y, scales.y),
    yRight: ends(view.yRight, scales.yRight),
    time: timeAxes(scales, ["x", "y", "yRight"]),
  };
}

/** A viewport from Python as the chart takes it: category labels become band indices. */
export function chartViewport(chart: Chart, payload: ViewportPayload | null): Viewport {
  const scales = scalesOf(chart);
  return {
    x: chartRange(payload?.x ?? null, scales.x),
    y: chartRange(payload?.y ?? null, scales.y),
    yRight: chartRange(payload?.yRight ?? null, scales.yRight),
  };
}

/**
 * A selection as Python reads it, or null for none. Its y values are read
 * on the y axis of the first panel it belongs to.
 */
export function selectionPayload(
  chart: Chart,
  selection: Selection | null,
): SelectionPayload | null {
  if (!selection || !(selection.x || selection.y || selection.lasso)) return null;
  const scales = scalesOf(chart, chart.selectionPanels?.[0]);
  const categories = selection.lasso ? categoriesOf(chart) : undefined;
  return {
    x: ends(selection.x, scales.x),
    y: ends(selection.y, scales.y),
    lasso: selection.lasso?.map(([x, y]) => [x, y]) ?? null,
    ...(categories && { categories }),
    time: timeAxes(scales, ["x", "y"]),
  };
}

/**
 * A selection from Python as the chart takes it, or null for none: with
 * category labels, where the categories are now, and null when a range's
 * categories are gone, since part of a selection is another selection.
 */
export function chartSelection(chart: Chart, payload: SelectionPayload | null): Selection | null {
  if (!payload) return null;
  // A lasso whose categories moved would outline others.
  if (payload.lasso && payload.categories) {
    if (JSON.stringify(categoriesOf(chart)) !== JSON.stringify(payload.categories)) return null;
  }
  const scales = scalesOf(chart);
  const x = chartRange(payload.x, scales.x);
  const y = chartRange(payload.y, scales.y);
  if ((payload.x && !x) || (payload.y && !y)) return null;
  const lasso = payload.lasso?.map(([px, py]) => [px, py] as const) ?? null;
  return x || y || lasso ? { x, y, lasso } : null;
}

/**
 * Whether a selection depends on the categories, which change with the
 * data: its ranges name them, or its lasso outlines them.
 */
export function namesCategories(payload: SelectionPayload | null): boolean {
  return (
    typeof payload?.x?.[0] === "string" ||
    typeof payload?.y?.[0] === "string" ||
    payload?.categories !== undefined
  );
}

/** The categories of the axes a selection is on; undefined when neither is a category axis. */
function categoriesOf(chart: Chart): Categories | undefined {
  const { x, y } = scalesOf(chart, chart.selectionPanels?.[0]);
  if (!x?.categories && !y?.categories) return undefined;
  return [x?.categories ? [...x.categories] : null, y?.categories ? [...y.categories] : null];
}

export function inspectionPayload(
  chart: Chart,
  inspection: Inspection | undefined,
): InspectionPayload | null {
  if (!inspection) return null;
  // The panel's scales, which may differ from other panels'.
  const panel = chart.model.panels().find(({ key }) => key === inspection.panel);
  const scale =
    inspection.axis === "item"
      ? undefined
      : inspection.axis === "x"
        ? (panel?.x ?? chart.model.xScale())
        : (panel?.y ?? chart.model.yScale());
  const categories = scale?.type === "band" ? scale.categories : undefined;
  return {
    axis: inspection.axis,
    value: categories ? label(categories, inspection.value) : finite(inspection.value),
    time: scale?.type === "time",
    label: inspection.label,
    ...(inspection.panel !== undefined && { panel: inspection.panel }),
    points: inspection.points.map((point) => ({
      mark: point.mark,
      markId: point.markId ?? null,
      key: point.key,
      label: point.label,
      row: point.row ?? null,
      value: finite(point.value),
      text: point.text,
    })),
    ...(inspection.axis === "item" && inspection.values && { values: inspection.values }),
  };
}

/** A range's ends as Python reads them: on category axes, labels. */
function ends(range: Range | null, scale: Scale | undefined): Ends | null {
  if (!range) return null;
  const categories = scale?.type === "band" ? scale.categories : undefined;
  if (categories) return [label(categories, range[0]), label(categories, range[1])];
  return [range[0], range[1]];
}

/** A range from Python as the chart takes it: category labels become band indices, or null when gone. */
function chartRange(range: Ends | null, scale: Scale | undefined): Range | null {
  if (!range) return null;
  const [start, end] = range;
  if (typeof start === "number" && typeof end === "number") return [start, end];
  const categories = scale?.categories ?? [];
  const from = categories.indexOf(String(start));
  const to = categories.indexOf(String(end));
  return from >= 0 && to >= 0 ? [from, to] : null;
}

function label(categories: readonly string[], index: number): string {
  return categories[Math.round(index)] ?? String(index);
}

/** JSON has no NaN or infinities; missing values travel as null. */
function finite(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}
