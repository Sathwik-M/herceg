import {
  type ChartListener,
  type ChartMark,
  type ChartUpdate,
  type Chart as HercegChart,
  type Inspection,
  tablesOf,
  viewOf,
} from "herceg";
import type { Snippet } from "svelte";
import type { ClassValue } from "svelte/elements";

/** Chart options as props: one left out, or `undefined`, takes its default. */
export interface ChartProps extends Omit<ChartUpdate, "marks" | "renderTooltip"> {
  /**
   * The tooltip's content (`{#snippet renderTooltip(inspection)}`), in the
   * chart's own box, which keeps its placement, the crosshair, and the
   * keyboard's announcements. Only the content of what the tooltip is at
   * renders, when that changes: never a node per data point.
   */
  renderTooltip?: Snippet<[Inspection]> | undefined;
  /** Marks built with herceg's functions; mark components among the children are added after them. */
  marks?: readonly ChartMark[] | undefined;
  /** Mark components: <Line>, <Area>, <Bar>, <Point>, <Heatmap>, <Contour>, <ErrorBar>, <Candlestick>, <Histogram>, <Pie>, <BoxPlot>, <Boxen>, <Violin>, <Treemap>, <Sunburst>, <Gauge>, <Funnel>, <Radar>, <Sankey>, <Graph>, <GeoShape>, <GeoPoint>, <Point3D>, <Line3D>, <Surface>, <Rule>, <Region>, <Text>, <Custom>. */
  children?: Snippet | undefined;
  class?: ClassValue | undefined;
  /** Style of the container. Without a `height` prop or style height, the chart is 320 px tall. */
  style?: string | undefined;
  /** The underlying chart once mounted (`bind:chart`), for imperative calls such as `setViewport` or `toSVG`. */
  chart?: HercegChart | null | undefined;
  /** The view changed (zoom, pan, reset, sync): x, y, and right y ranges, each null when not zoomed. */
  onviewport?: ChartListener<"viewport"> | undefined;
  /** The selection changed (`interaction.brush`): x and y ranges and a lasso's outline, null when cleared. */
  onselect?: ChartListener<"select"> | undefined;
  /** The data under the pointer or keyboard cursor changed, as for a tooltip of your own. */
  onhover?: ChartListener<"hover"> | undefined;
  /** The plot was clicked, with the data under the pointer (and with `rowSelection`, the rows it selected). */
  onclick?: ChartListener<"click"> | undefined;
  /** A channel `rowSelection` binds changed, by any chart or grid: what it holds now. */
  onrowselection?: ChartListener<"rowSelection"> | undefined;
  /** A 3D chart's camera moved (dragged, zoomed, reset, keys, `setCamera`); once a frame at most. */
  oncamera?: ChartListener<"camera"> | undefined;
  /** A treemap or sunburst was drilled into a node or back out: its key (null for the whole tree) and path. */
  ondrill?: ChartListener<"drill"> | undefined;
  /** A network's node was moved (dragged, keys, `setItemPosition`) or put back (null). */
  onitemmove?: ChartListener<"itemMove"> | undefined;
  /** Series or items were hidden or shown (legend, `setVisibility`): the keys now hidden. */
  onvisibility?: ChartListener<"visibility"> | undefined;
  /** The chart drew a frame of its data: its panels and pixel mapping describe it, for overlays. */
  onrender?: ChartListener<"render"> | undefined;
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
 * Same mark when the spec and the tables are unchanged, so caches survive
 * updates: every built-in mark's spec and tables describe it. Custom marks,
 * whose `draw` may close over new values, are only the same mark as
 * themselves.
 */
export function sameMark(a: ChartMark, b: ChartMark): boolean {
  if (a === b) return true;
  if (a.spec.type === "custom" || a.constructor !== b.constructor) return false;
  const [tables, others] = [tablesOf(a), tablesOf(b)];
  return (
    tables.length === others.length &&
    tables.every((table, i) => table === others[i]) &&
    viewOf(a) === viewOf(b) &&
    canonical(a.spec) === canonical(b.spec)
  );
}
