import {
  type ChartError,
  type ChartEvents,
  type ChartMark,
  type ChartOptions,
  chartError,
  createChart,
  type GuideOptions,
  type Chart as HercegChart,
  type Hydration,
  type Inspection,
  type Panels,
  type RenderTooltip,
  showFailure,
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
  type ShallowRef,
  type SlotsType,
  shallowRef,
  Teleport,
  Text,
  toRaw,
  type VNode,
} from "vue";
import { markBuilder, plain } from "./marks.ts";

/**
 * Options as props: the tooltip's content of your own is the `renderTooltip`
 * slot, and what keeps the chart from drawing the `error` event.
 */
type Options = Omit<ChartOptions, "marks" | "renderTooltip" | "onError">;
type Option<K extends keyof Options> = PropType<NonNullable<Options[K]>>;

/**
 * Chart options as props. Runtime types let `<Chart legend>` read as true,
 * and an absent boolean stays undefined so the chart's default applies.
 */
const optionProps = {
  title: [String, Object] as Option<"title">,
  description: String,
  width: Number,
  height: Number,
  x: Object as Option<"x">,
  y: Object as Option<"y">,
  yRight: Object as Option<"yRight">,
  scales: Object as Option<"scales">,
  guides: Array as Option<"guides">,
  facet: Object as Option<"facet">,
  panels: Object as Option<"panels">,
  legend: { type: [Boolean, Object] as Option<"legend">, default: undefined },
  padding: [Number, Object] as Option<"padding">,
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
  fonts: Object as Option<"fonts">,
  errorMode: String as Option<"errorMode">,
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
  /** The view came near an end of what `interaction.limits` allows, as to load more data. */
  edge: (_: ChartEvents["edge"]) => true,
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
  /**
   * Something kept the chart from drawing: options or mark components it
   * refused, code it could not load, a frame that failed. With
   * `error-mode="inline"` (the default) the chart also shows it in its
   * place; with "throw", it is thrown in render, for `onErrorCaptured`.
   */
  error: (_: ChartError) => true,
};

/** What a chart's slot adds to its options: marks, guides, and (from layout components) its panels. */
export interface Parts {
  marks: ChartMark[];
  guides: GuideOptions[];
  panels?: Panels | undefined;
}

/**
 * A component that adds to its chart's options as its vnode says (layout
 * and guide components); mark components add their mark.
 */
export interface PartComponent {
  displayName: string;
  /** Adds what the vnode describes, as `placing` says inside a panel. */
  addTo: (vnode: VNode, parts: Parts, placing: Placing | undefined) => void;
}

/**
 * What a <Panel> or an <Inset> gives the components inside it (see
 * layout.ts): its panel's id, and their options in it, refused where a
 * `panel` of their own names another.
 */
export interface Placing {
  readonly panel: string;
  props(type: unknown, props: object): object;
}

/** The vnodes among `children`, those of fragments (v-for, v-if) included, without text and comments. */
export function vnodesOf(children: unknown, out: VNode[] = []): VNode[] {
  if (Array.isArray(children)) {
    for (const child of children) vnodesOf(child, out);
    return out;
  }
  // Text and comments (such as a false v-if) are not marks.
  if (!isVNode(children) || children.type === Comment || children.type === Text) return out;
  if (children.type === Fragment) return vnodesOf(children.children, out);
  out.push(children);
  return out;
}

/** Adds what `children` describe to `parts`, marks and guides as `placing` says inside a panel. */
export function collect(children: unknown, parts: Parts, placing?: Placing): Parts {
  for (const vnode of vnodesOf(children)) {
    const component = vnode.type as Partial<PartComponent>;
    if (typeof component.addTo === "function") {
      component.addTo(vnode, parts, placing);
      continue;
    }
    const build = markBuilder(vnode.type);
    if (!build)
      throw new Error(
        "<Chart> children must be mark components such as <Line> or <Rule>, not components wrapping them: pass marks built with herceg's functions as :marks",
      );
    parts.marks.push(build(placing ? placing.props(vnode.type, { ...vnode.props }) : vnode.props));
  }
  return parts;
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

/** What a render describes, and later what the chart shows. */
interface View {
  marks: readonly ChartMark[];
  options: Options & { renderTooltip?: RenderTooltip };
  key: string;
}

/** What the tooltip is at, and the element its content renders in. */
interface Shown {
  inspection: Inspection;
  host: HTMLElement;
}

/**
 * The `renderTooltip` slot's content, teleported into the chart's tooltip
 * box. It reads what is shown itself, so a tooltip that moves re-renders
 * only this.
 */
const TooltipContent = defineComponent({
  props: {
    shown: { type: Object as PropType<ShallowRef<Shown | null>>, required: true },
    render: {
      type: Function as PropType<(props: { inspection: Inspection }) => VNode[]>,
      required: true,
    },
  },
  setup(props) {
    return () => {
      const shown = props.shown.value;
      return (
        shown && h(Teleport, { to: shown.host }, props.render({ inspection: shown.inspection }))
      );
    };
  },
});

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
    /**
     * The chart rendered on the server (`renderToSnapshot`, or Python's
     * `to_snapshot`) from the same options, as `hydration(snapshot)`:
     * server and first client renders show its markup, which the chart then
     * takes over without drawing it again. Read when the chart mounts; later
     * values are not.
     */
    initial: Object as PropType<Hydration>,
  },
  emits,
  slots: Object as SlotsType<{
    /** Mark components: <Line>, <Area>, <Bar>, <Point>, <Heatmap>, <Contour>, <ErrorBar>, <Candlestick>, <Histogram>, <Pie>, <BoxPlot>, <Boxen>, <Violin>, <Treemap>, <Sunburst>, <Gauge>, <Funnel>, <Radar>, <Sankey>, <Graph>, <GeoShape>, <GeoPoint>, <Point3D>, <Line3D>, <Surface>, <Rule>, <Region>, <Text>, <Custom>. */
    default?: () => VNode[];
    /**
     * The tooltip's content, in the chart's own box, which keeps its
     * placement, the crosshair, and the keyboard's announcements. Only the
     * content of what the tooltip is at renders, when that changes: never a
     * node per data point.
     */
    renderTooltip?: (props: { inspection: Inspection }) => VNode[];
  }>,
  expose: ["chart"],
  setup(props, { emit, slots }) {
    const container = shallowRef<HTMLDivElement | null>(null);
    // The server's markup, as setup found it: shown in a host of its own
    // until the chart takes it over.
    const snapshot = props.initial;
    if (snapshot && typeof snapshot.hydrate !== "function")
      throw new TypeError(
        "Chart initial: expected hydration(snapshot), from herceg, of what renderToSnapshot wrote; pass the snapshot through it",
      );
    const snapshotHost = shallowRef<HTMLDivElement | null>(null);
    /** The underlying chart, for imperative calls such as `setViewport` or `toSVG`; null until mounted. */
    const chart = shallowRef<HercegChart | null>(null);
    /** What the last render described, applied once Vue has patched the DOM. */
    let rendered: View | undefined;
    /** What the chart shows, to skip updates when a re-render changed nothing. */
    let applied: View | undefined;
    /** An error the last render met building marks or options. */
    let failure: { error: unknown } | undefined;
    /** What says why the last marks were refused, and of which error. */
    let refusal: { element: HTMLElement; message: string } | undefined;
    /** With errorMode "throw", what kept the chart from drawing, thrown in render. */
    const thrown = shallowRef<ChartError | null>(null);
    const onError = (error: ChartError) => {
      emit("error", error);
      if (props.errorMode === "throw") thrown.value = error;
    };
    /** What the tooltip is at, for `TooltipContent`. */
    const shown = shallowRef<Shown | null>(null);
    let host: HTMLElement | undefined;
    /** The chart's `renderTooltip` with the slot: it shows one element, which the slot renders in. */
    const renderTooltip: RenderTooltip = (inspection) => {
      host ??= document.createElement("div");
      shown.value = { inspection, host };
      return host;
    };

    // Called during render, so Vue tracks what the props and the slot read.
    function describe(): View {
      const options: Record<string, unknown> = {};
      for (const key of OPTION_KEYS) {
        if (props[key] !== undefined) options[key] = plain(props[key]);
      }
      const marks = (props.marks ?? []).map((mark) => toRaw(mark));
      const rendered = slots.renderTooltip !== undefined;
      const parts = collect(slots.default?.(), { marks, guides: [] });
      if (parts.panels) {
        if (options.panels)
          throw new Error(
            "<Chart> panels: layout components in its slot place its panels; drop :panels, or the layout components",
          );
        options.panels = parts.panels;
      }
      if (parts.guides.length > 0)
        options.guides = [
          ...((options.guides as GuideOptions[] | undefined) ?? []),
          ...parts.guides,
        ];
      return {
        marks: parts.marks,
        options: { ...(options as Options), ...(rendered && { renderTooltip }) },
        // The tooltip's renderer is the chart's own, calling the slot: the key
        // says whether there is one.
        key: `${canonical(options)}${rendered ? " rendered tooltip" : ""}`,
      };
    }

    /**
     * Says why mark components were refused (with errorMode "inline"): over
     * the chart, or in its place before there is one; nothing once they are
     * built again.
     */
    function refuse(error: ChartError | undefined) {
      if (refusal && refusal.message === error?.message) return;
      refusal?.element.remove();
      refusal = undefined;
      if (!error) return;
      const box = container.value!.getBoundingClientRect();
      const element = chart.value
        ? showFailure(chart.value.root, error, true)
        : showFailure(container.value!, error, false, {
            width: props.width ?? (box.width || 640),
            height: props.height ?? (box.height || 320),
          });
      refusal = { element, message: error.message };
      emit("error", error);
    }

    // Creates the chart, or brings it up to date with the last render.
    function sync() {
      if (failure) {
        if (props.errorMode === "throw") throw failure.error;
        refuse(chartError(failure.error, "validate"));
        return;
      }
      refuse(undefined);
      const next = rendered!;
      const last = applied;
      if (!chart.value || !last) {
        const config = { ...next.options, marks: next.marks, onError };
        const created = snapshot
          ? snapshot.hydrate(snapshotHost.value!, config)
          : createChart(container.value!, config);
        created.on("viewport", (event) => emit("viewport", event));
        created.on("edge", (event) => emit("edge", event));
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
      chart.value.update({ ...UNSET, renderTooltip: undefined, ...next.options, marks, onError });
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
        if (thrown.value) throw thrown.value;
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
        // The tooltip's content teleports out of it; the chart is appended after.
        const content = slots.renderTooltip;
        return h(
          "div",
          {
            ref: container,
            style: { width: px(props.width) ?? "100%", height: px(props.height) ?? "320px" },
          },
          [
            snapshot &&
              h("div", {
                ref: snapshotHost,
                style: { width: "100%", height: "100%" },
                innerHTML: snapshot.snapshot.html,
              }),
            content && h(TooltipContent, { shown, render: content }),
          ],
        );
      },
    };
  },
  render() {
    return this.renderChart();
  },
});
