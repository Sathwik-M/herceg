// Chart events as the Python package reads them (python/src/herceg/_events.py):
// plain JSON in which times are flagged, so Python can return datetimes, and
// category positions are their labels rather than band indices.

import type { Chart, Inspection } from "herceg";

type Ends = [number, number] | [string, string];

/** An x range: numbers (epoch ms when `time`) or, on category axes, labels. */
export interface RangePayload {
  x: Ends;
  time: boolean;
}

export interface InspectionPayload {
  /** "item" for a pie slice, whose value is the slice's. */
  axis: "x" | "y" | "item";
  value: number | string | null;
  time: boolean;
  label: string;
  panel?: string;
  points: { series: string; value: number | null; text: string }[];
}

export function rangePayload(
  chart: Chart,
  range: readonly [number, number] | null,
): RangePayload | null {
  if (!range) return null;
  const scale = chart.model.xScale();
  const categories = scale?.type === "band" ? scale.categories : undefined;
  if (categories) {
    return { x: [label(categories, range[0]), label(categories, range[1])], time: false };
  }
  return { x: [range[0], range[1]], time: scale?.type === "time" };
}

/** A range from Python as the chart takes it: category labels become band indices. */
export function chartRange(chart: Chart, x: Ends | null): [number, number] | null {
  if (!x) return null;
  const [start, end] = x;
  if (typeof start === "number" && typeof end === "number") return [start, end];
  const categories = chart.model.xScale()?.categories ?? [];
  const from = categories.indexOf(String(start));
  const to = categories.indexOf(String(end));
  return from >= 0 && to >= 0 ? [from, to] : null;
}

export function inspectionPayload(
  chart: Chart,
  inspection: Inspection | undefined,
): InspectionPayload | null {
  if (!inspection) return null;
  const scale =
    inspection.axis === "item"
      ? undefined
      : inspection.axis === "x"
        ? chart.model.xScale()
        : chart.model.yScale();
  const categories = scale?.type === "band" ? scale.categories : undefined;
  return {
    axis: inspection.axis,
    value: categories ? label(categories, inspection.value) : finite(inspection.value),
    time: scale?.type === "time",
    label: inspection.label,
    ...(inspection.panel !== undefined && { panel: inspection.panel }),
    points: inspection.points.map((point) => ({
      series: point.label,
      value: finite(point.value),
      text: point.text,
    })),
  };
}

function label(categories: readonly string[], index: number): string {
  return categories[Math.round(index)] ?? String(index);
}

/** JSON has no NaN or infinities; missing values travel as null. */
function finite(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}
