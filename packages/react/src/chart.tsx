import {
  type ChartError,
  type ChartEvents,
  type ChartListener,
  type ChartMark,
  type ChartOptions,
  type ChartUpdate,
  chartError,
  createChart,
  type Chart as HercegChart,
  type Hydration,
  type Inspection,
  type RenderTooltip,
  showFailure,
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
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { markBuilder } from "./marks.tsx";

/** Chart options as props: one left out, or `undefined`, takes its default. */
export interface ChartProps extends Omit<ChartUpdate, "marks" | "renderTooltip" | "onError"> {
  /**
   * The tooltip's content, rendered by React (with the application's
   * context) into the chart's own box, which keeps its placement, the
   * crosshair, and the keyboard's announcements; null for the built-in
   * content. Only the content of what the tooltip is at renders, when that
   * changes: never an element per data point. A function of the
   * inspection, not a component (it is called once more to see whether it
   * gives null): components go inside it.
   */
  renderTooltip?: ((inspection: Inspection) => ReactNode) | undefined;
  /** Marks built with herceg's functions; mark elements among `children` are added after them. */
  marks?: readonly ChartMark[];
  /** Mark elements: <Line>, <Area>, <Bar>, <Point>, <Heatmap>, <Contour>, <ErrorBar>, <Candlestick>, <Histogram>, <Pie>, <BoxPlot>, <Boxen>, <Violin>, <Treemap>, <Sunburst>, <Gauge>, <Funnel>, <Radar>, <Sankey>, <Graph>, <GeoShape>, <GeoPoint>, <Point3D>, <Line3D>, <Surface>, <Rule>, <Region>, <Text>, <Custom>. */
  children?: ReactNode;
  className?: string;
  /** Style of the container. Without a `height` prop or style height, the chart is 320 px tall. */
  style?: CSSProperties;
  /** The underlying chart, for imperative calls such as `setViewport` or `toSVG`. */
  ref?: Ref<HercegChart | null>;
  /**
   * The chart rendered on the server (`renderToSnapshot`, or Python's
   * `to_snapshot`) from the same options, as `hydration(snapshot)`: server
   * and first client renders show its markup, which the chart then takes
   * over without drawing it again. Read when the chart mounts; later values
   * are not.
   */
  initial?: Hydration | undefined;
  /** The view changed (zoom, pan, reset, sync): x, y, and right y ranges, each null when not zoomed. */
  onViewport?: ChartListener<"viewport">;
  /** The view came near an end of what `interaction.limits` allows, as to load more data. */
  onEdge?: ChartListener<"edge">;
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
  /**
   * Something kept the chart from drawing: options or mark elements it
   * refused, code it could not load, a frame that failed. With
   * `errorMode="inline"` (the default) the chart also shows it in its
   * place; with "throw", it is thrown in render, for an error boundary.
   */
  onError?: ((error: ChartError) => void) | undefined;
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
  // The chart listened to, and what stops it: subscribed in the commit a
  // handler comes, or a chart is made (once refused marks are fixed).
  const subscribed = useRef<{ chart: HercegChart; stop: () => void } | null>(null);
  useLayoutEffect(() => {
    latest.current = handler;
    const current = handler === undefined ? null : chart.current;
    if (subscribed.current?.chart === current) return;
    subscribed.current?.stop();
    subscribed.current = current && {
      chart: current,
      stop: current.on(type, (event) => latest.current?.(event)),
    };
  });
  useLayoutEffect(
    () => () => {
      subscribed.current?.stop();
      subscribed.current = null;
    },
    [],
  );
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
function canonical(value: unknown): string {
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
 * re-renders: every built-in mark's spec and tables describe it. Custom
 * marks, whose `draw` may close over new props, are only the same mark as
 * themselves.
 */
function sameMark(a: ChartMark, b: ChartMark): boolean {
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

type Options = Omit<ChartUpdate, "marks">;

/** What the tooltip is at, and the element its content renders in. */
interface Shown {
  inspection: Inspection;
  host: HTMLElement;
}

/**
 * The tooltip's content, rendered into the chart's box through a portal.
 * Its state is its own, so a tooltip that moves re-renders only this.
 */
function TooltipContent({
  shows,
  render,
}: {
  shows: RefObject<((shown: Shown | null) => void) | null>;
  render: (inspection: Inspection) => ReactNode;
}) {
  const [shown, setShown] = useState<Shown | null>(null);
  useLayoutEffect(() => {
    shows.current = setShown;
    return () => {
      shows.current = null;
    };
  }, [shows]);
  return shown && createPortal(render(shown.inspection), shown.host);
}

/**
 * The chart's `renderTooltip` for a `renderTooltip` prop: it hands what the
 * tooltip is at to `TooltipContent`, and the chart one element to show, or
 * nothing, for the built-in content, where the prop gives none. `version`
 * changes when a new prop would answer that differently for what the chart
 * last asked about, so the chart asks again.
 */
function useTooltip(render: ((inspection: Inspection) => ReactNode) | undefined) {
  const shows = useRef<((shown: Shown | null) => void) | null>(null);
  const latest = useRef(render);
  const asked = useRef<{ inspection: Inspection; empty: boolean } | null>(null);
  const [version, setVersion] = useState(0);
  useLayoutEffect(() => {
    latest.current = render;
    const last = asked.current;
    if (render && last && (render(last.inspection) == null) !== last.empty)
      setVersion((version) => version + 1);
  }, [render]);
  const rendered = render !== undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new version is a new renderer, which the chart asks again
  const option = useMemo<RenderTooltip | undefined>(() => {
    if (!rendered) return undefined;
    let host: HTMLElement | undefined;
    return (inspection) => {
      const empty = latest.current?.(inspection) == null;
      asked.current = { inspection, empty };
      if (empty) {
        shows.current?.(null);
        return null;
      }
      host ??= document.createElement("div");
      shows.current?.({ inspection, host });
      return host;
    };
  }, [rendered, version]);
  return { shows, option, version };
}

interface Applied {
  marks: readonly ChartMark[];
  options: Options;
  key: string;
}

/**
 * What the chart reports of what keeps it from drawing: `report`, a stable
 * `onError` for the chart (so the options compare equal across renders),
 * calls the latest `onError` and with errorMode "throw" throws it in
 * render; `show` says why mark elements were refused, over the chart (or
 * in its place before there is one), until marks are built again.
 */
function useFailures(
  onError: ((error: ChartError) => void) | undefined,
  mode: ChartProps["errorMode"],
  setThrown: (error: ChartError) => void,
) {
  const latest = useRef({ onError, mode });
  useLayoutEffect(() => {
    latest.current = { onError, mode };
  });
  const failure = useRef<{ element: HTMLElement; message: string } | null>(null);
  return useMemo(() => {
    const report = (error: ChartError) => {
      latest.current.onError?.(error);
      if (latest.current.mode === "throw") setThrown(error);
    };
    const show = (
      refused: ChartError | undefined,
      chart: HercegChart | null,
      container: HTMLElement,
      size: { width?: number | undefined; height?: number | undefined },
    ) => {
      const shown = failure.current;
      if (shown && shown.message === refused?.message) return;
      shown?.element.remove();
      failure.current = null;
      if (!refused) return;
      const element = chart
        ? showFailure(chart.root, refused, true)
        : showFailure(container, refused, false, {
            width: size.width ?? (container.getBoundingClientRect().width || 640),
            height: size.height ?? (container.getBoundingClientRect().height || 320),
          });
      failure.current = { element, message: refused.message };
      latest.current.onError?.(refused);
    };
    return { report, show };
  }, [setThrown]);
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
  initial,
  onViewport,
  onEdge,
  onSelect,
  onHover,
  onClick,
  onRowSelection,
  onCamera,
  onDrill,
  onItemMove,
  onVisibility,
  onRender,
  onError,
  renderTooltip,
  ...props
}: ChartProps) {
  const container = useRef<HTMLDivElement>(null);
  // The server's markup, as the first render found it: shown in a host of
  // its own until the chart takes it over, which only the first mount does.
  const [snapshot] = useState(initial);
  if (snapshot && typeof snapshot.hydrate !== "function")
    throw new TypeError(
      "Chart initial: expected hydration(snapshot), from herceg, of what renderToSnapshot wrote; pass the snapshot through it",
    );
  const html = useMemo(() => snapshot && { __html: snapshot.snapshot.html }, [snapshot]);
  const host = useRef<HTMLDivElement>(null);
  const hydrated = useRef(false);
  const chart = useRef<HercegChart | null>(null);
  /** What the chart shows, to skip updates when a re-render changed nothing. */
  const applied = useRef<Applied | null>(null);
  // With errorMode "throw", what keeps the chart from drawing is thrown here,
  // where an error boundary catches it, however late it came.
  const [thrown, setThrown] = useState<ChartError | null>(null);
  if (thrown) throw thrown;
  const failing = useFailures(onError, props.errorMode, setThrown);
  // Mark elements refused (an unknown field) leave the chart as it was, saying why.
  let marks: ChartMark[] = applied.current?.marks.slice() ?? [];
  let refused: ChartError | undefined;
  try {
    marks = [...(markProp ?? []), ...marksFrom(children)];
  } catch (error) {
    if (props.errorMode === "throw") throw error;
    refused = chartError(error, "validate");
  }
  const tooltip = useTooltip(renderTooltip);
  const shown: Options = { ...props, onError: failing.report };
  const options: Options = tooltip.option ? { ...shown, renderTooltip: tooltip.option } : shown;
  // The tooltip's renderer is new when its version is: canonical JSON
  // compares functions by identity.
  const optionsKey = canonical(options);

  // The chart is created once its marks are; later prop changes go through update().
  const create = () => {
    // Options given as undefined take their defaults, as if left out.
    const given = Object.entries(options).filter(([, value]) => value !== undefined);
    const config = { ...(Object.fromEntries(given) as Omit<ChartOptions, "marks">), marks };
    // A second mount (React's strict mode) finds the markup taken: it mounts afresh.
    const created =
      snapshot && !hydrated.current
        ? snapshot.hydrate(host.current!, config)
        : createChart(host.current ?? container.current!, config);
    hydrated.current = true;
    chart.current = created;
    applied.current = { marks, options, key: optionsKey };
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: created on mount, destroyed on unmount
  useLayoutEffect(() => {
    if (!refused) create();
    return () => {
      chart.current?.destroy();
      chart.current = null;
      applied.current = null;
    };
  }, []);
  // Marks refused at mount, fixed: the chart is made now, before the ref and
  // handlers below follow it (and parents' layout effects see it).
  useLayoutEffect(() => {
    if (!refused && !chart.current) create();
  });

  useChartEvent(chart, "viewport", onViewport);
  useChartEvent(chart, "edge", onEdge);
  useChartEvent(chart, "select", onSelect);
  useChartEvent(chart, "hover", onHover);
  useChartEvent(chart, "click", onClick);
  useChartEvent(chart, "rowSelection", onRowSelection);
  useChartEvent(chart, "camera", onCamera);
  useChartEvent(chart, "drill", onDrill);
  useChartEvent(chart, "itemMove", onItemMove);
  useChartEvent(chart, "visibility", onVisibility);
  const render = useChartEvent(chart, "render", onRender);

  // Each commit: the chart may be made in this one's layout effects, above.
  useImperativeHandle<HercegChart | null, HercegChart | null>(ref, () => chart.current);

  // The chart drew its first frame as it was created, before handlers
  // subscribed: `onRender` hears of it once the ref is set, once per chart.
  const told = useRef<HercegChart | null>(null);
  useLayoutEffect(() => {
    if (!chart.current || told.current === chart.current) return;
    told.current = chart.current;
    render.current?.({});
  });

  // A layout effect, so parents' layout effects and refs see the new props;
  // after the handlers' own, so events an update emits reach the latest.
  useLayoutEffect(() => {
    failing.show(refused, chart.current, container.current!, props);
    if (refused) return;
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
    <>
      <div
        ref={container}
        className={className}
        style={{ width: options.width ?? "100%", height: options.height ?? 320, ...style }}
      >
        {html && (
          <div
            ref={host}
            style={{ width: "100%", height: "100%" }}
            // biome-ignore lint/security/noDangerouslySetInnerHtml: herceg's own markup, its text escaped (`initial` comes from renderToSnapshot, never from users)
            dangerouslySetInnerHTML={html}
          />
        )}
      </div>
      {renderTooltip && <TooltipContent shows={tooltip.shows} render={renderTooltip} />}
    </>
  );
}
