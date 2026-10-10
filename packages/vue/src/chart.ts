import {
  type ChartEvents,
  type ChartMark,
  type ChartOptions,
  createChart,
  type Chart as HercegChart,
  tablesOf,
  viewOf,
} from "herceg";
import {
  Comment,
  defineComponent,
  Fragment,
  h,
  isVNode,
  onBeforeUnmount,
  onMounted,
  onUpdated,
  type PropType,
  type SlotsType,
  shallowRef,
  Text,
  toRaw,
  type VNode,
} from "vue";
import { markBuilder, plain } from "./marks.ts";

type Options = Omit<ChartOptions, "marks">;
type Option<K extends keyof Options> = PropType<NonNullable<Options[K]>>;

/**
 * Chart options as props. Runtime types let `<Chart legend>` read as true,
 * and an absent boolean stays undefined so the chart's default applies.
 */
const optionProps = {
  title: String,
  description: String,
  width: Number,
  height: Number,
  x: Object as Option<"x">,
  y: Object as Option<"y">,
  yRight: Object as Option<"yRight">,
  facet: Object as Option<"facet">,
  panels: Object as Option<"panels">,
  resolve: Object as Option<"resolve">,
  legend: { type: Boolean, default: undefined },
  tooltip: { type: [Boolean, Object] as Option<"tooltip">, default: undefined },
  interaction: Object as Option<"interaction">,
  rowSelection: Object as Option<"rowSelection">,
  navigator: Object as Option<"navigator">,
  animation: { type: [Boolean, Object] as Option<"animation">, default: undefined },
  renderer: String as Option<"renderer">,
  theme: [String, Object] as Option<"theme">,
  locale: String,
  timeZone: String,
  projection: [String, Object] as Option<"projection">,
  z: Object as Option<"z">,
  camera: Object as Option<"camera">,
  boxAspect: Array as unknown as Option<"boxAspect">,
} satisfies { [K in keyof Options]-?: unknown };

const OPTION_KEYS = Object.keys(optionProps) as (keyof Options)[];
/** Every option unset, so options no longer passed go back to their defaults. */
const UNSET = Object.fromEntries(OPTION_KEYS.map((key) => [key, undefined]));

/**
 * Chart events, emitted as Vue events (`@select="..."`). Vue does not tell a
 * component which listeners it has, so the chart listens for every event:
 * unlike in React, hover and click payloads are computed even when nobody
 * listens, which costs little next to drawing.
 */
const emits = {
  /** The view changed (zoom, pan, reset, sync): x, y, and right y ranges, each null when not zoomed. */
  viewport: (_: ChartEvents["viewport"]) => true,
  /** The selection changed (`interaction.brush`): x and y ranges and a lasso's outline, null when cleared. */
  select: (_: ChartEvents["select"]) => true,
  /** The data under the pointer or keyboard cursor changed, as for a tooltip of your own. */
  hover: (_: ChartEvents["hover"]) => true,
  /** The plot was clicked, with the data under the pointer (and with `rowSelection`, the rows it selected). */
  click: (_: ChartEvents["click"]) => true,
  /** A channel `rowSelection` binds changed, by any chart or grid: what it holds now. */
  rowSelection: (_: ChartEvents["rowSelection"]) => true,
  /** A 3D chart's camera moved (dragged, zoomed, reset, keys, `setCamera`); once a frame at most. */
  camera: (_: ChartEvents["camera"]) => true,
  /** A treemap or sunburst was drilled into a node or back out: its key (null for the whole tree) and path. */
  drill: (_: ChartEvents["drill"]) => true,
  /** A network's node was moved (dragged, keys, `setItemPosition`) or put back (null). */
  itemMove: (_: ChartEvents["itemMove"]) => true,
  /** Series or items were hidden or shown (legend, `setVisibility`): the keys now hidden. */
  visibility: (_: ChartEvents["visibility"]) => true,
  /** The chart drew a frame of its data: its panels and pixel mapping describe it, for overlays. */
  render: (_: ChartEvents["render"]) => true,
};

function collectMarks(children: unknown, out: ChartMark[]): ChartMark[] {
  if (Array.isArray(children)) {
    for (const child of children) collectMarks(child, out);
    return out;
  }
  // Text and comments (such as a false v-if) are not marks.
  if (!isVNode(children) || children.type === Comment || children.type === Text) return out;
  if (children.type === Fragment) return collectMarks(children.children, out);
  const build = markBuilder(children.type);
  if (!build)
    throw new Error(
      "<Chart> children must be mark components such as <Line> or <Rule>, not components wrapping them: pass marks built with herceg's functions as :marks",
    );
  out.push(build(children.props));
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

/** What a render describes, and later what the chart shows. */
interface View {
  marks: readonly ChartMark[];
  options: Options;
  key: string;
}

const px = (size: number | undefined) => (size === undefined ? undefined : `${size}px`);

/**
 * A herceg chart. Props are applied with `chart.update` when they change;
 * data changes made on a table (append, replace, reset) re-render the chart
 * directly, without re-rendering Vue.
 *
 * ```vue
 * <Chart title="Latency" :y="{ title: 'ms' }">
 *   <Line :data="metrics" x="time" :y="['p50', 'p99']" />
 *   <Rule :y="250" label="SLO" />
 * </Chart>
 * ```
 */
export const Chart = defineComponent({
  name: "HercegChart",
  props: {
    ...optionProps,
    /** Marks built with herceg's functions; mark components in the slot are added after them. */
    marks: Array as PropType<readonly ChartMark[]>,
  },
  emits,
  slots: Object as SlotsType<{
    /** Mark components: <Line>, <Area>, <Bar>, <Point>, <Heatmap>, <ErrorBar>, <Candlestick>, <Histogram>, <Pie>, <BoxPlot>, <Violin>, <Treemap>, <Sunburst>, <Gauge>, <Funnel>, <Radar>, <Sankey>, <Graph>, <GeoShape>, <GeoPoint>, <Point3D>, <Line3D>, <Surface>, <Rule>, <Region>, <Text>, <Custom>. */
    default?: () => VNode[];
  }>,
  expose: ["chart"],
  setup(props, { emit, slots }) {
    const container = shallowRef<HTMLDivElement | null>(null);
    /** The underlying chart, for imperative calls such as `setViewport` or `toSVG`; null until mounted. */
    const chart = shallowRef<HercegChart | null>(null);
    /** What the last render described, applied once Vue has patched the DOM. */
    let rendered: View | undefined;
    /** What the chart shows, to skip updates when a re-render changed nothing. */
    let applied: View | undefined;
    /** An error the last render met building marks or options. */
    let failure: { error: unknown } | undefined;

    // Called during render, so Vue tracks what the props and the slot read.
    function describe(): View {
      const options: Record<string, unknown> = {};
      for (const key of OPTION_KEYS) {
        if (props[key] !== undefined) options[key] = plain(props[key]);
      }
      const marks = (props.marks ?? []).map((mark) => toRaw(mark));
      return {
        marks: collectMarks(slots.default?.(), marks),
        options: options as Options,
        key: canonical(options),
      };
    }

    // Creates the chart, or brings it up to date with the last render.
    function sync() {
      if (failure) throw failure.error;
      const next = rendered!;
      const last = applied;
      if (!chart.value || !last) {
        const created = createChart(container.value!, { ...next.options, marks: next.marks });
        created.on("viewport", (event) => emit("viewport", event));
        created.on("select", (event) => emit("select", event));
        created.on("hover", (event) => emit("hover", event));
        created.on("click", (event) => emit("click", event));
        created.on("rowSelection", (event) => emit("rowSelection", event));
        created.on("camera", (event) => emit("camera", event));
        created.on("drill", (event) => emit("drill", event));
        created.on("itemMove", (event) => emit("itemMove", event));
        created.on("visibility", (event) => emit("visibility", event));
        created.on("render", (event) => emit("render", event));
        chart.value = created;
        applied = next;
        // The first frame was drawn as the chart was created, before it had listeners.
        emit("render", {});
        return;
      }
      // Unchanged marks keep their identity, so their caches survive.
      const marks = next.marks.map((mark, i) => {
        const previous = last.marks[i];
        return previous && sameMark(mark, previous) ? previous : mark;
      });
      const sameMarks =
        marks.length === last.marks.length && marks.every((mark, i) => mark === last.marks[i]);
      if (sameMarks && next.key === last.key) return;
      // Props are the whole configuration: options no longer passed go back
      // to their defaults rather than keeping their previous values.
      chart.value.update({ ...UNSET, ...next.options, marks });
      applied = { ...next, marks };
    }

    onMounted(sync);
    onUpdated(sync);
    onBeforeUnmount(() => {
      chart.value?.destroy();
      chart.value = null;
    });

    return {
      chart,
      /** The render function; kept in setup so only `chart` is exposed to template refs. */
      renderChart: () => {
        // Building marks throws on invalid props, such as an unknown field.
        // Thrown here, Vue would replace the container with a placeholder
        // and strand the chart in the old one, so the error is thrown again
        // from the mounted or updated hook, where Vue reports it as well.
        try {
          rendered = describe();
          failure = undefined;
        } catch (error) {
          failure = { error };
        }
        // Class, style, and other attributes fall through onto this element.
        return h("div", {
          ref: container,
          style: { width: px(props.width) ?? "100%", height: px(props.height) ?? "320px" },
        });
      },
    };
  },
  render() {
    return this.renderChart();
  },
});
