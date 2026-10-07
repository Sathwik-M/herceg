import { formatNumber } from "../format/format.ts";
import { rowOf, type Series } from "../marks/series.ts";
import type { ChartModel } from "./model.ts";

const MAX_SERIES = 20;

function summarize(series: Series, locale: string | undefined): string {
  let min = Infinity;
  let max = -Infinity;
  let last = Number.NaN;
  for (let k = 0; k < series.length; k++) {
    const value = series.values[rowOf(series, k)]!;
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
    last = value;
  }
  if (!(min <= max)) return `${series.label}: no data`;
  const f = (v: number) => formatNumber(v, locale);
  return `${series.label}: ${series.length} points, from ${f(min)} to ${f(max)}, last ${f(last)}`;
}

/**
 * Text alternative for a chart: what it shows and a short summary of each
 * series. Charts drawn on Canvas have no other text representation of their
 * data, so this is what assistive technology reads.
 */
export function describeChart(model: ChartModel): string {
  const { config } = model;
  const series = model.series();
  const kinds = [...new Set(config.marks.map((mark) => mark.spec.type))].join(" and ");
  const parts: string[] = [];
  if (config.title) parts.push(config.title);
  if (config.description) parts.push(config.description);
  parts.push(
    `${kinds[0]?.toUpperCase() ?? ""}${kinds.slice(1)} chart with ${series.length} series.`,
  );
  for (const s of series.slice(0, MAX_SERIES)) parts.push(`${summarize(s, config.locale)}.`);
  if (series.length > MAX_SERIES) parts.push(`${series.length - MAX_SERIES} more series.`);
  return parts.join(" ");
}
