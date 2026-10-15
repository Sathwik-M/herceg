import {
  type ChartError,
  type ChartListener,
  type ChartMark,
  type ChartUpdate,
  type Chart as HercegChart,
  type Hydration,
  type Inspection,
  tablesOf,
  viewOf,
} from "herceg";
import type { Snippet } from "svelte";
import type { ClassValue } from "svelte/elements";

/** Chart options as props: one left out, or `undefined`, takes its default. */
export interface ChartProps extends Omit<ChartUpdate, "marks" | "renderTooltip" | "onError"> {
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
  /**
   * The chart rendered on the server (`renderToSnapshot`, or Python's
   * `to_snapshot`) from the same options, as `hydration(snapshot)`: server
   * and first client renders show its markup, which the chart then takes
   * over without drawing it again. Read when the chart mounts; later values
   * are not.
   */
  initial?: Hydration | undefined;
  /** The view changed (zoom, pan, reset, sync): x, y, and right y ranges, each null when not zoomed. */
  onviewport?: ChartListener<"viewport"> | undefined;
  /** The view came near an end of what `interaction.limits` allows, as to load more data. */
  onedge?: ChartListener<"edge"> | undefined;
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
  /**
   * Something kept the chart from drawing: options or mark components it
   * refused, code it could not load, a frame that failed. With
   * `errorMode="inline"` (the default) the chart also shows it in its
   * place; with "throw", it is thrown, for the nearest `<svelte:boundary>`.
   */
  onerror?: ((error: ChartError) => void) | undefined;
}

/**
 * Ids of the functions options hold (tick generators, formatters), so that
 * a new function compares as a change and the same one as none.
 */
const functionIds = new WeakMap<object, number>();
let functions = 0;

/**
 * JSON with object keys sorted, so equal settings written in any order
 * compare equal, and functions by identity.
 */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_, v: unknown) => {
    if (typeof v === "function") {
      let id = functionIds.get(v);
      if (id === undefined) {
        id = ++functions;
        functionIds.set(v, id);
      }
      return `function ${id}`;
    }
    return v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v;
  });
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
