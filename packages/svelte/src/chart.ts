import {
  type ChartListener,
  type ChartMark,
  type ChartUpdate,
  type Chart as HercegChart,
  tablesOf,
  viewOf,
} from "herceg";
import type { Snippet } from "svelte";
import type { ClassValue } from "svelte/elements";

/** Chart options as props: one left out, or `undefined`, takes its default. */
export interface ChartProps extends Omit<ChartUpdate, "marks"> {
  /** Marks built with herceg's functions; mark components among the children are added after them. */
  marks?: readonly ChartMark[] | undefined;
  /** Mark components: <Line>, <Area>, <Bar>, <Point>, <Heatmap>, <ErrorBar>, <Candlestick>, <Histogram>, <Pie>, <BoxPlot>, <Violin>, <Treemap>, <Sunburst>, <Gauge>, <Funnel>, <Radar>, <Sankey>, <Graph>, <GeoShape>, <GeoPoint>, <Rule>, <Region>, <Text>, <Custom>. */
  children?: Snippet | undefined;
  class?: ClassValue | undefined;
  /** Style of the container. Without a `height` prop or style height, the chart is 320 px tall. */
  style?: string | undefined;
  /** The underlying chart once mounted (`bind:chart`), for imperative calls such as `setViewport` or `toSVG`. */
  chart?: HercegChart | null | undefined;
  /** The visible x range changed (zoom, pan, reset, sync); null when fitted to the data. */
  onviewport?: ChartListener<"viewport"> | undefined;
  /** The brushed x range changed (`interaction.brush`); null when cleared. */
  onselect?: ChartListener<"select"> | undefined;
  /** The data under the pointer or keyboard cursor changed, as for a tooltip of your own. */
  onhover?: ChartListener<"hover"> | undefined;
  /** The plot was clicked, with the data under the pointer. */
  onclick?: ChartListener<"click"> | undefined;
}

/** JSON with object keys sorted, so equal settings written in any order compare equal. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/**
 * Mark types whose spec and table describe them completely. Other marks
 * (custom marks, whose `draw` may close over new values, and marks written
 * against the `Mark` interface) are only the same mark as themselves.
 */
const PORTABLE = new Set([
  "line",
  "area",
  "bar",
  "point",
  "heatmap",
  "errorbar",
  "candlestick",
  "histogram",
  "pie",
  "boxplot",
  "violin",
  "treemap",
  "sunburst",
  "gauge",
  "funnel",
  "radar",
  "sankey",
  "graph",
  "geoshape",
  "geopoint",
  "rule",
  "region",
  "text",
]);

/** Same mark when the spec and the tables are unchanged, so caches survive updates. */
export function sameMark(a: ChartMark, b: ChartMark): boolean {
  if (a === b) return true;
  if (!PORTABLE.has(a.spec.type) || a.constructor !== b.constructor) return false;
  const [tables, others] = [tablesOf(a), tablesOf(b)];
  return (
    tables.length === others.length &&
    tables.every((table, i) => table === others[i]) &&
    viewOf(a) === viewOf(b) &&
    canonical(a.spec) === canonical(b.spec)
  );
}
