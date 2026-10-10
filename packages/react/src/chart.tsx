import {
  type ChartEvents,
  type ChartListener,
  type ChartMark,
  type ChartOptions,
  type ChartUpdate,
  createChart,
  type Chart as HercegChart,
  tablesOf,
  viewOf,
} from "herceg";
import {
  Children,
  type CSSProperties,
  Fragment,
  isValidElement,
  type ReactNode,
  type Ref,
  type RefObject,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";
import { markBuilder } from "./marks.tsx";

/** Chart options as props: one left out, or `undefined`, takes its default. */
export interface ChartProps extends Omit<ChartUpdate, "marks"> {
  /** Marks built with herceg's functions; mark elements among `children` are added after them. */
  marks?: readonly ChartMark[];
  /** Mark elements: <Line>, <Area>, <Bar>, <Point>, <Heatmap>, <ErrorBar>, <Candlestick>, <Histogram>, <Pie>, <BoxPlot>, <Violin>, <Treemap>, <Sunburst>, <Gauge>, <Funnel>, <Radar>, <Sankey>, <Graph>, <GeoShape>, <GeoPoint>, <Point3D>, <Line3D>, <Surface>, <Rule>, <Region>, <Text>, <Custom>. */
  children?: ReactNode;
  className?: string;
  /** Style of the container. Without a `height` prop or style height, the chart is 320 px tall. */
  style?: CSSProperties;
  /** The underlying chart, for imperative calls such as `setViewport` or `toSVG`. */
  ref?: Ref<HercegChart | null>;
  /** The view changed (zoom, pan, reset, sync): x, y, and right y ranges, each null when not zoomed. */
  onViewport?: ChartListener<"viewport">;
  /** The selection changed (`interaction.brush`): x and y ranges and a lasso's outline, null when cleared. */
  onSelect?: ChartListener<"select">;
  /** The data under the pointer or keyboard cursor changed, as for a tooltip of your own. */
  onHover?: ChartListener<"hover">;
  /** The plot was clicked, with the data under the pointer (and with `rowSelection`, the rows it selected). */
  onClick?: ChartListener<"click">;
  /** A channel `rowSelection` binds changed, by any chart or grid: what it holds now. */
  onRowSelection?: ChartListener<"rowSelection">;
  /** A 3D chart's camera moved (dragged, zoomed, reset, keys, `setCamera`); once a frame at most. */
  onCamera?: ChartListener<"camera">;
  /** A treemap or sunburst was drilled into a node or back out: its key (null for the whole tree) and path. */
  onDrill?: ChartListener<"drill">;
  /** A network's node was moved (dragged, keys, `setItemPosition`) or put back (null). */
  onItemMove?: ChartListener<"itemMove">;
  /** Series or items were hidden or shown (legend, `setVisibility`): the keys now hidden. */
  onVisibility?: ChartListener<"visibility">;
  /** The chart drew a frame of its data: its panels and pixel mapping describe it, for overlays. */
  onRender?: ChartListener<"render">;
}

/**
 * Subscribes to a chart event while `handler` is given. The handler of the
 * last committed render is called, so passing a new function each render
 * does not resubscribe, and renders React discards never take effect.
 */
function useChartEvent<K extends keyof ChartEvents>(
  chart: RefObject<HercegChart | null>,
  type: K,
  handler: ChartListener<K> | undefined,
): RefObject<ChartListener<K> | undefined> {
  const latest = useRef(handler);
  useLayoutEffect(() => {
    latest.current = handler;
  });
  const present = handler !== undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: resubscribes only when a handler appears or goes
  useLayoutEffect(() => {
    if (!present || !chart.current) return;
    return chart.current.on(type, (event) => latest.current?.(event));
  }, [present]);
  return latest;
}

function marksFrom(children: ReactNode, out: ChartMark[] = []): ChartMark[] {
  for (const child of Children.toArray(children)) {
    if (!isValidElement(child)) continue;
    const props = child.props as { children?: ReactNode };
    if (child.type === Fragment) {
      marksFrom(props.children, out);
      continue;
    }
    const build = markBuilder(child.type);
    if (!build)
      throw new Error(
        "<Chart> children must be mark elements such as <Line> or <Rule>, not components wrapping them: call a function that returns marks, or pass marks={...}",
      );
    out.push(build(child.props));
  }
  return out;
}

/** JSON with object keys sorted, so equal settings written in any order compare equal. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/**
 * Mark types whose spec and table describe them completely. Custom marks,
 * whose `draw` may close over new props, are only the same mark as
 * themselves.
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
  "point3d",
  "line3d",
  "surface",
  "rule",
  "region",
  "text",
]);

/** Same mark when the spec and the tables are unchanged, so caches survive re-renders. */
function sameMark(a: ChartMark, b: ChartMark): boolean {
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

type Options = Omit<ChartUpdate, "marks">;

interface Applied {
  marks: readonly ChartMark[];
  options: Options;
  key: string;
}

/**
 * A herceg chart. Props are applied with `chart.update` when they change;
 * data changes made on a table (append, replace, reset) re-render the chart
 * directly, without re-rendering React.
 *
 * ```tsx
 * <Chart title="Latency" y={{ title: "ms" }}>
 *   <Line data={metrics} x="time" y={["p50", "p99"]} />
 *   <Rule y={250} label="SLO" />
 * </Chart>
 * ```
 */
export function Chart({
  marks: markProp,
  children,
  className,
  style,
  ref,
  onViewport,
  onSelect,
  onHover,
  onClick,
  onRowSelection,
  onCamera,
  onDrill,
  onItemMove,
  onVisibility,
  onRender,
  ...options
}: ChartProps) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<HercegChart | null>(null);
  /** What the chart shows, to skip updates when a re-render changed nothing. */
  const applied = useRef<Applied | null>(null);
  const marks = [...(markProp ?? []), ...marksFrom(children)];
  const optionsKey = canonical(options);

  // The chart is created once; later prop changes go through update().
  // biome-ignore lint/correctness/useExhaustiveDependencies: created once on mount
  useLayoutEffect(() => {
    // Options given as undefined take their defaults, as if left out.
    const given = Object.entries(options).filter(([, value]) => value !== undefined);
    const created = createChart(container.current!, {
      ...(Object.fromEntries(given) as Omit<ChartOptions, "marks">),
      marks,
    });
    chart.current = created;
    applied.current = { marks, options, key: optionsKey };
    return () => {
      created.destroy();
      chart.current = null;
    };
  }, []);

  useChartEvent(chart, "viewport", onViewport);
  useChartEvent(chart, "select", onSelect);
  useChartEvent(chart, "hover", onHover);
  useChartEvent(chart, "click", onClick);
  useChartEvent(chart, "rowSelection", onRowSelection);
  useChartEvent(chart, "camera", onCamera);
  useChartEvent(chart, "drill", onDrill);
  useChartEvent(chart, "itemMove", onItemMove);
  useChartEvent(chart, "visibility", onVisibility);
  const render = useChartEvent(chart, "render", onRender);

  useImperativeHandle<HercegChart | null, HercegChart | null>(ref, () => chart.current, []);

  // The chart drew its first frame as it was created, before handlers
  // subscribed: `onRender` hears of it once the ref is set.
  useLayoutEffect(() => {
    if (chart.current) render.current?.({});
  }, [render]);

  // A layout effect, so parents' layout effects and refs see the new props;
  // after the handlers' own, so events an update emits reach the latest.
  useLayoutEffect(() => {
    const last = applied.current;
    if (!chart.current || !last) return;
    // Unchanged marks keep their identity, so their caches survive.
    const next = marks.map((mark, i) => {
      const previous = last.marks[i];
      return previous && sameMark(mark, previous) ? previous : mark;
    });
    const sameMarks =
      next.length === last.marks.length && next.every((mark, i) => mark === last.marks[i]);
    if (sameMarks && optionsKey === last.key) return;
    // Props are the whole configuration: options no longer passed go back
    // to their defaults rather than keeping their previous values.
    const cleared = Object.keys(last.options).filter((key) => !(key in options));
    const reset = Object.fromEntries(cleared.map((key) => [key, undefined]));
    applied.current = { marks: next, options, key: optionsKey };
    chart.current.update({ ...reset, ...options, marks: next });
  });

  return (
    <div
      ref={container}
      className={className}
      style={{ width: options.width ?? "100%", height: options.height ?? 320, ...style }}
    />
  );
}
