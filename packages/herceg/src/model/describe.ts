import { scanExtent } from "../data/table.ts";
import { formatNumber } from "../format/format.ts";
import { rowOf, type Series } from "../marks/series.ts";
import type { ChartModel } from "./model.ts";

const MAX_SERIES = 20;

/** [min, max] and the last finite value of a series. */
function valueRange(series: Series): [number, number, number] | undefined {
  const { values, rows, length } = series;
  let last = Number.NaN;
  for (let k = length - 1; k >= 0 && !Number.isFinite(last); k--) last = values[rowOf(series, k)]!;
  if (!Number.isFinite(last)) return undefined;
  // A whole column is one plain scan; subsets of rows go through their index.
  if (rows === undefined) {
    const extent = scanExtent(values, 0, length);
    return extent && [extent[0], extent[1], last];
  }
  let min = Infinity;
  let max = -Infinity;
  for (let k = 0; k < length; k++) {
    const value = values[rows[k]!]!;
    if (value < min && value > -Infinity) min = value;
    if (value > max && value < Infinity) max = value;
  }
  return [min, max, last];
}

function summarize(series: Series, name: string, locale: string | undefined): string {
  const range = valueRange(series);
  if (!range) return `${name}: no data`;
  const [min, max, last] = range;
  const f = (v: number) => formatNumber(v, locale);
  return `${name}: ${series.length} points, from ${f(min)} to ${f(max)}, last ${f(last)}`;
}

/**
 * Text alternative for a chart: what it shows and a short summary of each
 * series. Charts drawn on Canvas have no other text representation of their
 * data, so this is what assistive technology reads.
 */
export function describeChart(model: ChartModel): string {
  const { config } = model;
  const series = model.series();
  // Annotations describe themselves; the chart kind names the data marks.
  const kinds = [
    ...new Set(config.marks.filter((mark) => !mark.describe).map((mark) => mark.spec.type)),
  ].join(" and ");
  const parts: string[] = [];
  if (config.title) parts.push(config.title);
  if (config.description) parts.push(config.description);
  if (kinds) {
    parts.push(`${kinds[0]!.toUpperCase()}${kinds.slice(1)} chart with ${series.length} series.`);
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
    parts.push(`${summarize(s, name(s), config.locale)}.`);
  }
  if (series.length > MAX_SERIES) parts.push(`${series.length - MAX_SERIES} more series.`);
  parts.push(...model.annotationSummaries());
  return parts.join(" ");
}
