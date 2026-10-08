import {
  type ChartEvents,
  type ChartListener,
  type ChartMark,
  type ChartOptions,
  createChart,
  type Chart as HercegChart,
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

export interface ChartProps extends Omit<ChartOptions, "marks"> {
  /** Marks built with herceg's functions; mark elements among `children` are added after them. */
  marks?: readonly ChartMark[];
  /** Mark elements: <Line>, <Area>, <Bar>, <Point>, <Heatmap>, <ErrorBar>, <Candlestick>, <Histogram>, <Pie>, <BoxPlot>, <Violin>, <Treemap>, <Sunburst>, <Rule>, <Region>, <Text>, <Custom>. */
  children?: ReactNode;
  className?: string;
  /** Style of the container. Without a `height` prop or style height, the chart is 320 px tall. */
  style?: CSSProperties;
  /** The underlying chart, for imperative calls such as `setViewport` or `toSVG`. */
  ref?: Ref<HercegChart | null>;
  /** The visible x range changed (zoom, pan, reset, sync); null when fitted to the data. */
  onViewportChange?: ChartListener<"viewport">;
  /** The brushed x range changed (`interaction.brush`); null when cleared. */
  onSelect?: ChartListener<"select">;
  /** The data under the pointer or keyboard cursor changed, as for a tooltip of your own. */
  onHover?: ChartListener<"hover">;
  /** The plot was clicked, with the data under the pointer. */
  onClick?: ChartListener<"click">;
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
): void {
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
    if (!build) throw new Error("<Chart> children must be mark elements such as <Line> or <Rule>");
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
 * Mark types whose spec and table describe them completely. Other marks
 * (custom marks, whose `draw` may close over new props, and marks written
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
  "rule",
  "region",
  "text",
]);

/** Same mark when the spec and the table are unchanged, so caches survive re-renders. */
function sameMark(a: ChartMark, b: ChartMark): boolean {
  if (a === b) return true;
  if (!PORTABLE.has(a.spec.type) || a.constructor !== b.constructor) return false;
  return a.table === b.table && canonical(a.spec) === canonical(b.spec);
}

type Options = Omit<ChartOptions, "marks">;

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
 * <Chart title="Latency" y={{ label: "ms" }}>
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
  onViewportChange,
  onSelect,
  onHover,
  onClick,
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
    const created = createChart(container.current!, { ...options, marks });
    chart.current = created;
    applied.current = { marks, options, key: optionsKey };
    return () => {
      created.destroy();
      chart.current = null;
    };
  }, []);

  // A layout effect, so parents' layout effects and refs see the new props.
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
    chart.current.update({ ...reset, ...options, marks: next } as ChartOptions);
  });

  useChartEvent(chart, "viewport", onViewportChange);
  useChartEvent(chart, "select", onSelect);
  useChartEvent(chart, "hover", onHover);
  useChartEvent(chart, "click", onClick);

  useImperativeHandle<HercegChart | null, HercegChart | null>(ref, () => chart.current, []);

  return (
    <div
      ref={container}
      className={className}
      style={{ width: options.width ?? "100%", height: options.height ?? 320, ...style }}
    />
  );
}
