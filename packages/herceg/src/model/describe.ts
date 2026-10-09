import { scanExtent } from "../data/table.ts";
import { formatNumber } from "../format/format.ts";
import { rowOf, type Series } from "../marks/series.ts";
import type { ChartModel } from "./model.ts";

const MAX_SERIES = 20;

/** [min, max], the last finite value of a series, and its row. */
function valueRange(series: Series): [number, number, number, number] | undefined {
  const { values, rows, length } = series;
  let last = Number.NaN;
  let lastRow = -1;
  for (let k = length - 1; k >= 0 && !Number.isFinite(last); k--) {
    lastRow = rowOf(series, k);
    last = values[lastRow]!;
  }
  if (!Number.isFinite(last)) return undefined;
  // A whole column is one plain scan; subsets of rows go through their index.
  if (rows === undefined) {
    const extent = scanExtent(values, 0, length);
    return extent && [extent[0], extent[1], last, lastRow];
  }
  let min = Infinity;
  let max = -Infinity;
  for (let k = 0; k < length; k++) {
    const value = values[rows[k]!]!;
    if (value < min && value > -Infinity) min = value;
    if (value > max && value < Infinity) max = value;
  }
  return [min, max, last, lastRow];
}

/** A series' points, range, and last value, over its parts in every panel. */
function summarize(parts: readonly Series[], name: string, locale: string | undefined): string {
  let points = 0;
  let min = Infinity;
  let max = -Infinity;
  let last = Number.NaN;
  let lastRow = -1;
  for (const part of parts) {
    points += part.length;
    const range = valueRange(part);
    if (!range) continue;
    min = Math.min(min, range[0]);
    max = Math.max(max, range[1]);
    // Parts keep their rows in order, so the latest row holds the last value.
    if (range[3] > lastRow) [last, lastRow] = [range[2], range[3]];
  }
  if (lastRow < 0) return `${name}: no data`;
  const f = (v: number) => formatNumber(v, locale);
  return `${name}: ${points} ${points === 1 ? "point" : "points"}, from ${f(min)} to ${f(max)}, last ${f(last)}`;
}

/**
 * Text alternative for a chart: what it shows and a short summary of each
 * series. Charts drawn on Canvas have no other text representation of their
 * data, so this is what assistive technology reads.
 */
export function describeChart(model: ChartModel): string {
  const { config } = model;
  const layout = model.layoutSummary();
  if (layout !== undefined) {
    return [config.description, layout].filter(Boolean).join(" ");
  }
  const series = model.series();
  // Annotations describe themselves; the chart kind names the data marks.
  const kinds = [
    ...new Set(
      config.marks
        .filter((mark) => !("describe" in mark && mark.describe))
        .map((mark) => mark.spec.type),
    ),
  ].join(" and ");
  // The title is the chart's name, which is read before its description.
  const parts: string[] = [];
  if (config.description) parts.push(config.description);
  if (kinds) {
    parts.push(`${kinds[0]!.toUpperCase()}${kinds.slice(1)} chart with ${series.length} series.`);
  }
  const panelLayout = config.facet ?? config.panels;
  if (panelLayout) {
    const panels = model.panels().map(({ label }) => label);
    parts.push(panelLayout.describe(panels, MAX_SERIES));
  }
  // With series on both y axes, each one's name says which it is on.
  const right = series.filter((s) => model.onRight(s));
  const sides = right.length > 0 && right.length < series.length;
  const name = (s: Series) => {
    if (!sides) return s.label;
    const onRight = right.includes(s);
    const unit = (onRight ? config.yRight : config.y)?.label;
    return `${s.label} (${onRight ? "right" : "left"} axis${unit ? `, ${unit}` : ""})`;
  };
  for (const s of series.slice(0, MAX_SERIES)) {
    const drawn = model.parts(s);
    const mark = model.markOf(s);
    const y = mark && model.yScaleOf(mark);
    const sentence = mark?.summarize
      ? mark.summarize(drawn, name(s), {
          format: model.formatsOf(mark),
          locale: config.locale,
          log: y?.type === "log",
        })
      : summarize(drawn, name(s), config.locale);
    parts.push(`${sentence}.`);
  }
  if (series.length > MAX_SERIES) parts.push(`${series.length - MAX_SERIES} more series.`);
  parts.push(...model.annotationSummaries());
  return parts.join(" ");
}
