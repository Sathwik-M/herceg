import {
  type AxisFormat,
  type ChartOptions,
  type CustomSeries,
  custom,
  type DataDrawContext,
  type DrawContext,
  facet,
  geometry,
  type Chart as HercegChart,
  line,
  RowSet,
  rangeNavigator,
  rowSelection,
  type Schema,
  selectionStore,
  selectRows,
  table,
  time,
  timeBreaks,
} from "herceg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type App,
  computed,
  createApp,
  defineComponent,
  nextTick,
  onMounted,
  onUpdated,
  reactive,
  ref,
  shallowRef,
} from "vue";
import {
  Area,
  Bar,
  BoxPlot,
  Candlestick,
  Chart,
  Custom,
  Dendrogram,
  ErrorBar,
  Funnel,
  Gauge,
  GeoPoint,
  GeoShape,
  Histogram,
  Line,
  Line3D,
  Pie,
  Point,
  Point3D,
  Radar,
  Region,
  Rule,
  Surface,
  Text,
  Violin,
} from "../src/index.ts";

// The options each chart was last given, at creation and by `update`, which
// tests compare with the props that made them.
const given = vi.hoisted(() => new WeakMap<object, Record<string, unknown>>());
vi.mock("herceg", async (original) => {
  const herceg = await original<typeof import("herceg")>();
  return {
    ...herceg,
    createChart(container: HTMLElement, options: ChartOptions) {
      const chart = herceg.createChart(container, options);
      given.set(chart, { ...options });
      const update = chart.update.bind(chart);
      chart.update = (changes) => {
        Object.assign(given.get(chart)!, changes);
        update(changes);
      };
      return chart;
    },
  };
});
const optionsOf = (chart: HercegChart) => given.get(chart) as unknown as ChartOptions;

let host: HTMLDivElement;
let app: App | undefined;

beforeEach(() => {
  host = document.createElement("div");
  host.style.width = "600px";
  document.body.append(host);
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  host.remove();
});

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const metrics = table({ t: [0, 1, 2, 3], a: [1, 2, 3, 4], b: [4, 3, 2, 1] });
const paths = () => host.querySelectorAll("svg g[clip-path] path");
const components = {
  Violin,
  Chart,
  BoxPlot,
  Candlestick,
  ErrorBar,
  Point,
  Dendrogram,
  Line,
  Area,
  Bar,
  Custom,
  Pie,
  Gauge,
  Funnel,
  Radar,
  GeoShape,
  Histogram,
  GeoPoint,
  Line3D,
  Point3D,
  Surface,
  Region,
  Rule,
  Text,
};

/** Mounts a template; `setup` returns what it reads. */
function mount(template: string, setup: () => object = () => ({})): App {
  app = createApp(defineComponent({ components, setup, template }));
  app.mount(host);
  return app;
}

/** A template ref to <Chart>, and the herceg chart behind it. */
function chartRef() {
  const view = shallowRef<InstanceType<typeof Chart> | null>(null);
  return { view, chart: () => view.value!.chart! };
}

/** Counts `chart.update` calls and records the marks each passed. */
function spyUpdates(chart: HercegChart): (readonly unknown[])[] {
  const seen: (readonly unknown[])[] = [];
  const update = chart.update.bind(chart);
  chart.update = (options) => {
    seen.push(options.marks ?? []);
    update(options);
  };
  return seen;
}

describe("<Chart>", () => {
  it("draws dendrogram components with summary-only reading", () => {
    const linkage = table({ first: [0], second: [1], height: [2] });
    mount(
      `<Chart renderer="svg"><Dendrogram :data="linkage" first="first" second="second" height="height" :leaves="['a', 'b']" stroke="#ff0000" label="Clustering" /></Chart>`,
      () => ({ linkage }),
    );
    expect(host.querySelectorAll('path[stroke="#ff0000"]')).toHaveLength(1);
    expect(host.textContent).toContain("Clustering: 2 leaves, 1 merge. Merge heights 2 to 2.");
  });

  it("renders marks from its slot, one path per series", () => {
    mount(
      `<Chart title="Load">
        <Line :data="metrics" x="t" :y="['a', 'b']" />
        <Rule :y="2" label="limit" />
      </Chart>`,
      () => ({ metrics }),
    );
    expect(paths()).toHaveLength(2);
    expect(host.querySelector('[role="figure"]')!.getAttribute("aria-label")).toBe("Load");
    expect(host.textContent).toContain("limit");
  });

  it("takes groups of marks as marks, and names the fix for wrapping components", () => {
    const loadMarks = () => [line(metrics, { x: "t", y: "a" }), line(metrics, { x: "t", y: "b" })];
    mount(`<Chart :marks="loadMarks()" />`, () => ({ loadMarks }));
    expect(paths()).toHaveLength(2);
    app?.unmount();
    // A component of the application's: the chart cannot see what it renders.
    const LoadMarks = defineComponent({
      components,
      template: `<Line :data="metrics" x="t" y="a" />`,
      setup: () => ({ metrics }),
    });
    const errors: unknown[] = [];
    app = createApp(
      defineComponent({
        components: { ...components, LoadMarks },
        template: `<Chart><LoadMarks /></Chart>`,
      }),
    );
    app.config.errorHandler = (error) => errors.push(error);
    app.mount(host);
    expect(String(errors[0])).toMatch(/not components wrapping them: pass marks/);
  });

  it("renders a pie from its component, a path of arcs per slice", () => {
    const shares = table({ k: ["a", "b", "c"], v: [3, 2, 1] });
    mount(
      `<Chart title="Shares">
        <Pie :data="shares" category="k" value="v" :innerRadius="0.5" />
      </Chart>`,
      () => ({ shares }),
    );
    const slices = [...paths()].filter((path) => /A/.test(path.getAttribute("d") ?? ""));
    expect(slices).toHaveLength(3);
  });

  it("draws a map's regions and points from their components, with its projection", async () => {
    const square = (x: number) => [x, 0, x + 10, 0, x + 10, 10, x, 10];
    const regions = table({
      name: ["Ada", "Bel"],
      gdp: [1, 2],
      shape: geometry({
        coordinates: Float64Array.from([...square(0), ...square(10)]),
        ringOffsets: Int32Array.from([0, 4, 8]),
        polygonOffsets: Int32Array.from([0, 1, 2]),
        geometryOffsets: Int32Array.from([0, 1, 2]),
      }),
    });
    const places = table({ lon: [5], lat: [5] });
    const projection = ref<"mercator" | "equirectangular">("mercator");
    mount(
      `<Chart :projection="projection" locale="en-US">
        <GeoShape :data="regions" name="name" color="gdp" />
        <GeoPoint :data="places" longitude="lon" latitude="lat" />
      </Chart>`,
      () => ({ regions, places, projection }),
    );
    const filled = () =>
      [...paths()].filter((path) => path.getAttribute("fill-rule") === "evenodd");
    expect(filled()).toHaveLength(2);
    const before = filled()[0]!.getAttribute("d");
    projection.value = "equirectangular";
    await nextTick();
    await frame();
    expect(filled()[0]!.getAttribute("d")).not.toBe(before);
  });

  it("renders gauges and funnels from their components", () => {
    const readings = table({ cpu: [12, 73] });
    mount(`<Chart><Gauge :data="readings" value="cpu" :max="80" /></Chart>`, () => ({ readings }));
    expect(host.textContent).toContain("73");
    expect(host.textContent).toContain("80");
    app!.unmount();
    const stages = table({ stage: ["Visit", "Buy"], users: [2000, 300] });
    mount(
      `<Chart locale="en-US"><Funnel :data="stages" category="stage" value="users" /></Chart>`,
      () => ({ stages }),
    );
    expect(host.textContent).toContain("Visit");
    expect(host.textContent).toContain("2,000 · 100%");
  });

  it("reads a bare labels attribute on <Pie> as true", () => {
    const shares = table({ k: ["a", "b"], v: [3, 2] });
    const labelsWith = (attribute: string) => {
      mount(`<Chart><Pie :data="shares" category="k" value="v" ${attribute} /></Chart>`, () => ({
        shares,
      }));
      const text = host.querySelector("svg")!.textContent ?? "";
      app!.unmount();
      app = undefined;
      return text.includes("a") && text.includes("b");
    };
    expect(labelsWith("labels")).toBe(true);
    expect(labelsWith(':labels="true"')).toBe(true);
    expect(labelsWith(':labels="false"')).toBe(false);
  });

  it("reads a bare notch attribute on <BoxPlot> as true, for raw and precomputed boxes", () => {
    const raw = table({
      g: ["a", "a", "a", "a", "a", "b", "b", "b", "b"],
      v: [1, 2, 3, 4, 9, 2, 3, 5, 6],
    });
    const stats = table({ g: ["a"], lo: [1], q1: [2], med: [3], q3: [4], hi: [6], n: [20] });
    const drawn = (markup: string, data: object) => {
      mount(`<Chart renderer="svg">${markup}</Chart>`, () => data);
      // The shapes drawn, without the ids each chart's markup has of its own.
      const shapes = [...host.querySelectorAll("svg path")].map((path) => path.getAttribute("d"));
      app!.unmount();
      app = undefined;
      return shapes.join("|");
    };
    const rawBox = (attribute: string) =>
      drawn(`<BoxPlot :data="raw" x="g" y="v" ${attribute} />`, { raw });
    expect(rawBox("notch")).toBe(rawBox(':notch="true"'));
    expect(rawBox("notch")).not.toBe(rawBox(""));
    const statsBox = (attribute: string) =>
      drawn(
        `<BoxPlot :data="stats" x="g" low="lo" q1="q1" median="med" q3="q3" high="hi" count="n" ${attribute} />`,
        { stats },
      );
    expect(statsBox("notch")).toBe(statsBox(':notch="true"'));
    expect(statsBox("notch")).not.toBe(statsBox(""));
  });

  it("reads bare dodge attributes on <Point> and <ErrorBar> as true", () => {
    const stats = table({
      day: ["thu", "thu"],
      sex: ["f", "m"],
      mean: [2, 3],
      lo: [1, 2],
      hi: [3, 4],
    });
    const drawn = (attribute: string) => {
      mount(
        `<Chart renderer="svg">
          <Point :data="stats" x="day" y="mean" series="sex" ${attribute} />
          <ErrorBar :data="stats" x="day" y1="lo" y2="hi" series="sex" ${attribute} />
        </Chart>`,
        () => ({ stats }),
      );
      const shapes = [...host.querySelectorAll("svg path, svg circle")].map((node) =>
        [node.getAttribute("d"), node.getAttribute("cx")].join(),
      );
      app!.unmount();
      app = undefined;
      return shapes.join("|");
    };
    expect(drawn("dodge")).toBe(drawn(':dodge="true"'));
    expect(drawn("dodge")).not.toBe(drawn(""));
  });

  it("reads bare split as true and forwards violin interiors", () => {
    const samples = table({
      g: ["a", "a", "a", "a"],
      s: ["first", "first", "second", "second"],
      v: [1, 3, 2, 4],
    });
    const drawn = (attribute: string) => {
      const { view, chart } = chartRef();
      mount(
        `<Chart ref="view" renderer="svg"><Violin :data="samples" x="g" y="v" series="s" inner="quartiles" ${attribute} /></Chart>`,
        () => ({ samples, view }),
      );
      expect(optionsOf(chart()).marks[0]!.spec).toMatchObject({
        inner: "quartiles",
        ...(attribute ? { split: true } : {}),
      });
      const shapes = [...host.querySelectorAll('svg [data-kind="area"]')].map((path) =>
        path.getAttribute("d"),
      );
      expect(host.querySelectorAll('svg [stroke-dasharray="4 3"]')).toHaveLength(2);
      app!.unmount();
      app = undefined;
      return shapes;
    };
    expect(drawn("split")).toEqual(drawn(':split="true"'));
    expect(drawn("split")).not.toEqual(drawn(""));
  });

  it("renders a radar from its component, and reads a bare points attribute as true", () => {
    const players = table({ name: ["Ana", "Bo"], speed: [8, 5], power: [6, 9], range: [4, 7] });
    const dots = (attribute: string) => {
      mount(
        `<Chart>
          <Radar :data="players" :fields="['speed', 'power', 'range']" series="name" ${attribute} />
        </Chart>`,
        () => ({ players }),
      );
      expect(host.textContent).toContain("power");
      const fills = [...paths()].filter((path) => path.getAttribute("fill-opacity") === "0.15");
      expect(fills).toHaveLength(2);
      // Dots are circles of two arcs each.
      const count = [...paths()].filter((path) => /a3 3/.test(path.getAttribute("d") ?? "")).length;
      app!.unmount();
      app = undefined;
      return count;
    };
    expect(dots("points")).toBe(2);
    expect(dots(':points="false"')).toBe(0);
  });

  it("draws 3D marks from their components, with camera props and events", async () => {
    const grid = table({ x: [0, 1, 0, 1], y: [0, 0, 1, 1], z: [1, 2, 3, 4] });
    const points = table({ x: [0.5], y: [0.5], z: [3] });
    const camera = ref({ azimuth: 10 });
    const cameras: number[] = [];
    const onCamera = ({ camera }: { camera: { azimuth: number } }) => cameras.push(camera.azimuth);
    const { view, chart } = chartRef();
    mount(
      `<Chart ref="view" :camera="camera" :box-aspect="[2, 1, 1]" locale="en-US" @camera="onCamera">
        <Surface :data="grid" x="x" y="y" z="z" />
        <Point3D :data="points" x="x" y="y" z="z" />
        <Line3D :data="grid" x="x" y="y" z="z" />
      </Chart>`,
      () => ({ grid, points, camera, view, onCamera }),
    );
    expect(host.textContent).toContain("Surface of z over x and y");
    expect(host.textContent).toContain("3D line through x, y, z: 4 points in 1 run.");
    expect(optionsOf(chart()).boxAspect).toEqual([2, 1, 1]);
    chart().setCamera({ elevation: 50 });
    await frame();
    expect(cameras).toEqual([10]);
    camera.value = { azimuth: 40 };
    await nextTick();
    expect(chart().camera).toMatchObject({ azimuth: 40, elevation: 25 });
  });

  it("builds annotations from constants or from their own data", () => {
    const events = table({ at: [1, 2], name: ["deploy", "rollback"] });
    mount(
      `<Chart>
        <Region :x1="0.5" :x2="1.5" />
        <Line :data="metrics" x="t" y="a" />
        <Rule :data="events" x="at" text="name" />
        <Text :x="3" :y="4" label="peak" />
      </Chart>`,
      () => ({ metrics, events }),
    );
    // The region and the line; rules and text are drawn as guides.
    expect(paths()).toHaveLength(2);
    expect(host.textContent).toContain("deploy");
    expect(host.textContent).toContain("rollback");
    expect(host.textContent).toContain("peak");
  });

  it("reads kebab-case names and bare boolean attributes as a template writes them", () => {
    const { view, chart } = chartRef();
    mount(
      `<Chart ref="view" legend>
        <Area :data="metrics" x="t" :y="['a', 'b']" stack :fill-opacity="0.5" />
        <Bar :data="metrics" x="t" y="a" />
      </Chart>`,
      () => ({ metrics, view }),
    );
    const [area, bar] = optionsOf(chart()).marks;
    expect(area!.spec).toMatchObject({ stack: true, fillOpacity: 0.5 });
    expect(bar!.spec).not.toHaveProperty("stack");
    expect(optionsOf(chart()).legend).toBe(true);
  });

  it("stacks areas by a series field, with the gaps a template names", () => {
    const { view, chart } = chartRef();
    const hosts = table({ t: [0, 1, 0], cpu: [1, 2, 3], host: ["a", "a", "b"] });
    mount(
      `<Chart ref="view">
        <Area :data="hosts" x="t" y="cpu" series="host" stack stack-gaps="interpolate" />
      </Chart>`,
      () => ({ hosts, view }),
    );
    const [area] = optionsOf(chart()).marks;
    expect(area!.spec).toMatchObject({ series: "host", stack: true, stackGaps: "interpolate" });
    expect(paths()).toHaveLength(2);
  });

  it("keeps marks from v-for and v-if in template order", async () => {
    const { view, chart } = chartRef();
    const band = ref(false);
    const fields = ref(["a", "b"]);
    mount(
      `<Chart ref="view">
        <Region v-if="band" :y1="1" :y2="2" />
        <Line v-for="field in fields" :key="field" :data="metrics" x="t" :y="field" />
        <Rule :y="3" />
      </Chart>`,
      () => ({ metrics, view, band, fields }),
    );
    const order = () =>
      optionsOf(chart()).marks.map((mark) => {
        const spec = mark.spec as { type: string; y?: unknown };
        return spec.type === "line" ? `line:${spec.y}` : spec.type;
      });
    expect(order()).toEqual(["line:a", "line:b", "rule"]);
    band.value = true;
    fields.value = ["b", "a"];
    await nextTick();
    expect(order()).toEqual(["region", "line:b", "line:a", "rule"]);
  });

  it("works through tables and options held in deep reactive state", async () => {
    // ref() wraps the table in a proxy, which cannot reach its private fields.
    const data = ref(metrics);
    const fields = reactive(["a"]);
    mount(`<Chart><Line :data="data" x="t" :y="fields" /></Chart>`, () => ({ data, fields }));
    expect(paths()).toHaveLength(1);
    // An in-place change reaches the chart, not only a replaced array.
    fields.push("b");
    await nextTick();
    await frame();
    expect(paths()).toHaveLength(2);
  });

  it("rebuilds custom marks so their draw sees new values", async () => {
    const labels = () =>
      [...host.querySelectorAll('[data-kind="shapes"] text')].map((t) => t.textContent);
    const label = ref("first");
    // Read outside `draw`, so a change re-renders the chart.
    const draw = computed(() => {
      const current = label.value;
      return ({ text, x, y }: DrawContext) => text(x(1), y(2), current);
    });
    mount(
      `<Chart>
        <Line :data="metrics" x="t" y="a" />
        <Custom :draw="draw" />
      </Chart>`,
      () => ({ metrics, draw }),
    );
    expect(labels()).toEqual(["first"]);
    label.value = "second";
    await nextTick();
    await frame();
    expect(labels()).toEqual(["second"]);
  });

  it("passes series options to custom marks, which then have legend entries and tooltips", async () => {
    const { view, chart } = chartRef();
    const drawn: string[][] = [];
    const draw = ({ series, circle, x, y }: DataDrawContext<Schema>) => {
      drawn.push(series.map((s) => s.label));
      for (const s of series) circle(x(s.x[0]!), y(s.y[0]!), 3, { fill: s.color });
    };
    const text = (row: number, format: AxisFormat, s: CustomSeries) => `${format.y(s.y[row]!)} req`;
    mount(
      `<Chart ref="view">
        <Custom :data="metrics" x="t" :y="['a', 'b']" :point-text="text" :draw="draw" />
      </Chart>`,
      () => ({ metrics, view, draw, text }),
    );
    const buttons = host.querySelectorAll("button");
    expect([...buttons].map((button) => button.textContent)).toEqual(["a", "b"]);
    const mounted = chart();
    const inspection = mounted.inspect(
      mounted.toPixel(1, { axis: "x" })!,
      mounted.toPixel(2, { axis: "y" })!,
    )!;
    expect(inspection.points.map((p) => p.text)).toEqual(["2 req", "3 req"]);
    buttons[0]!.click();
    chart().render();
    expect(drawn.at(-1)).toEqual(["b"]);
  });

  it("keeps custom marks given as marks only while they are the same object", async () => {
    // A custom mark's spec does not describe what it draws.
    const badge = (label: string) => custom({ draw: ({ text, x, y }) => text(x(1), y(2), label) });
    const labels = () =>
      [...host.querySelectorAll('[data-kind="shapes"] text')].map((t) => t.textContent);
    const marks = shallowRef([line(metrics, { x: "t", y: "a" }), badge("first")]);
    mount(`<Chart :marks="marks" />`, () => ({ marks }));
    marks.value = [line(metrics, { x: "t", y: "a" }), badge("second")];
    await nextTick();
    await frame();
    expect(labels()).toEqual(["second"]);
  });

  it("emits chart events to the listener of the latest render", async () => {
    const { view, chart } = chartRef();
    const seen: string[] = [];
    const handler = shallowRef((event: { x: readonly [number, number] | null }) =>
      seen.push(`one:${event.x?.join("-")}`),
    );
    mount(
      `<Chart ref="view" @select="handler"><Line :data="metrics" x="t" y="a" /></Chart>`,
      () => ({ metrics, view, handler }),
    );
    handler.value = (event) => seen.push(`two:${event.x?.join("-")}`);
    await nextTick();
    chart().select([1, 2]);
    expect(seen).toEqual(["two:1-2"]);
  });

  it("emits render for the first frame, drawn as the chart mounts, with the ref set", async () => {
    const { view, chart } = chartRef();
    const panels: number[] = [];
    mount(`<Chart ref="view" @render="count"><Line :data="metrics" x="t" y="a" /></Chart>`, () => ({
      metrics,
      view,
      count: () => panels.push(chart().getPanels().length),
    }));
    await nextTick();
    expect(panels).toEqual([1]);
  });

  it("emits the whole view", () => {
    const { view, chart } = chartRef();
    const seen: unknown[] = [];
    mount(
      `<Chart ref="view" @viewport="record"><Line :data="metrics" x="t" y="a" /></Chart>`,
      () => ({ metrics, view, record: (event: unknown) => seen.push(event) }),
    );
    chart().setViewport({ x: [1, 2], y: [0, 5] });
    expect(seen).toEqual([{ x: [1, 2], y: [0, 5], yRight: null }]);
  });

  it("supports event modifiers and keeps native events off chart listeners", () => {
    const { view, chart } = chartRef();
    const seen: unknown[] = [];
    mount(
      `<Chart ref="view" @select.once="record" @click="record">
        <Line :data="metrics" x="t" y="a" />
      </Chart>`,
      () => ({ metrics, view, record: (event: unknown) => seen.push(event) }),
    );
    chart().select([0, 1]);
    chart().select([1, 2]);
    // `click` is the chart's event, not the element's.
    host.firstElementChild!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(seen).toEqual([{ x: [0, 1], y: null, lasso: null }]);
  });

  it("reports invalid marks and keeps the chart for when they are fixed", async () => {
    const errors: unknown[] = [];
    const field = ref("missing");
    app = createApp(
      defineComponent({
        components,
        setup: () => ({ metrics, field }),
        template: `<Chart><Line :data="metrics" x="t" :y="field" /></Chart>`,
      }),
    );
    app.config.errorHandler = (error) => errors.push(error);
    app.mount(host);
    expect(String(errors[0])).toMatch(/missing/);
    expect(paths()).toHaveLength(0);
    field.value = "a";
    await nextTick();
    expect(paths()).toHaveLength(1);
    const figure = host.querySelector('[role="figure"]');
    field.value = "missing";
    await nextTick();
    expect(errors).toHaveLength(2);
    field.value = "b";
    await nextTick();
    await frame();
    expect(host.querySelector('[role="figure"]')).toBe(figure);
    expect(figure!.isConnected).toBe(true);
    expect(paths()).toHaveLength(1);
  });

  it("applies prop changes to the same chart", async () => {
    const title = ref("One");
    mount(`<Chart :title="title"><Line :data="metrics" x="t" y="a" /></Chart>`, () => ({
      metrics,
      title,
    }));
    const figure = host.querySelector('[role="figure"]')!;
    title.value = "Two";
    await nextTick();
    expect(host.querySelector('[role="figure"]')).toBe(figure);
    expect(figure.getAttribute("aria-label")).toBe("Two");
  });

  it("does not update the chart when a re-render changes nothing", async () => {
    const { view, chart } = chartRef();
    const tick = ref(1);
    // The parent re-renders; the chart gets a new but equal axis object.
    mount(
      `<p>{{ tick }}</p>
      <Chart ref="view" :y="{ label: 'ms', ticks: tick > 0 ? 5 : 4 }">
        <Line :data="metrics" x="t" y="a" />
      </Chart>`,
      () => ({ metrics, view, tick }),
    );
    const updates = spyUpdates(chart());
    tick.value = 2;
    await nextTick();
    expect(host.querySelector("p")!.textContent).toBe("2");
    expect(updates).toHaveLength(0);
  });

  it("binds a row selection from reactive state, kept while its store and channel are", async () => {
    const { view, chart } = chartRef();
    const store = selectionStore(metrics);
    const tick = ref(1);
    const seen: unknown[] = [];
    // The binding lives in reactive state, which wraps it in a proxy.
    const state = reactive({ bound: rowSelection({ store, channel: "focus" }) });
    mount(
      `<p>{{ tick }}</p>
      <Chart ref="view" :row-selection="state.bound" @row-selection="seen.push($event.selection)">
        <Line :data="metrics" x="t" y="a" />
      </Chart>`,
      () => ({ metrics, view, tick, state, seen }),
    );
    const updates = spyUpdates(chart());
    state.bound = rowSelection({ store, channel: "focus" });
    tick.value = 2;
    await nextTick();
    expect(updates).toHaveLength(0);
    const rows = selectRows(new RowSet(metrics).add(1));
    store.set("focus", rows);
    expect(seen).toEqual([rows]);
  });

  it("draws OHLC bars from a static variant, and keeps equal breaks without updating", async () => {
    const day = 86_400_000;
    const prices = table({
      t: time([0, 1, 4].map((d) => Date.UTC(2025, 9, 9) + d * day)),
      o: [10, 12, 9],
      h: [13, 12.5, 9.5],
      l: [9, 8, 8.5],
      c: [12, 9, 9],
    });
    const { view, chart } = chartRef();
    const breaks = shallowRef(timeBreaks([{ weekdays: ["sat", "sun"] }]));
    mount(
      `<Chart ref="view" time-zone="UTC" :x="{ breaks }">
        <Candlestick :data="prices" x="t" open="o" high="h" low="l" close="c" variant="ohlc" />
      </Chart>`,
      () => ({ prices, view, breaks }),
    );
    expect(optionsOf(chart()).marks[0]!.spec).toMatchObject({ variant: "ohlc" });
    expect(host.querySelector("svg g[clip-path] rect")).toBeNull();
    const updates = spyUpdates(chart());
    // New breaks with the same rules are the same option; other rules are not.
    breaks.value = timeBreaks([{ weekdays: ["sat", "sun"] }]);
    await nextTick();
    expect(updates).toHaveLength(0);
    breaks.value = timeBreaks([{ weekdays: ["sun"] }]);
    await nextTick();
    expect(updates).toHaveLength(1);
  });

  it("draws a navigator, keeps an equal one without updating, and removes it", async () => {
    const { view, chart } = chartRef();
    const navigator = shallowRef<ReturnType<typeof rangeNavigator> | undefined>(rangeNavigator());
    mount(
      `<Chart ref="view" :navigator="navigator">
        <Line :data="metrics" x="t" y="a" />
      </Chart>`,
      () => ({ metrics, view, navigator }),
    );
    await chart().loading;
    expect(host.querySelectorAll('[aria-label="Range navigator"] [role="slider"]')).toHaveLength(3);
    const updates = spyUpdates(chart());
    navigator.value = rangeNavigator();
    await nextTick();
    expect(updates).toHaveLength(0);
    navigator.value = undefined;
    await nextTick();
    expect(updates).toHaveLength(1);
    expect(host.querySelector('[aria-label="Range navigator"]')).toBeNull();
  });

  it("draws a panel per facet value and keeps equal facets without updating", async () => {
    const sales = table({ t: [0, 1, 0, 1], v: [1, 2, 3, 4], region: ["N", "N", "S", "S"] });
    const { view, chart } = chartRef();
    const by = shallowRef(facet("region"));
    mount(`<Chart ref="view" :facet="by"><Line :data="sales" x="t" y="v" /></Chart>`, () => ({
      sales,
      view,
      by,
    }));
    expect(
      chart()
        .getPanels()
        .map((p) => p.key),
    ).toEqual(["N", "S"]);
    const updates = spyUpdates(chart());
    // A new facet object for the same field is the same option.
    by.value = facet("region");
    await nextTick();
    expect(updates).toHaveLength(0);
  });

  it("passes how panels share scales to the chart", async () => {
    const sales = table({ t: [0, 1, 10, 11], v: [1, 2, 3, 4], region: ["N", "N", "S", "S"] });
    const { view, chart } = chartRef();
    const resolve = shallowRef<{ x?: "independent" }>({ x: "independent" });
    mount(
      `<Chart ref="view" :facet="by" :resolve="resolve"><Line :data="sales" x="t" y="v" /></Chart>`,
      () => ({ sales, view, by: facet("region"), resolve }),
    );
    const groups = () =>
      new Set(
        chart()
          .getPanels()
          .map((p) => p.x!.group),
      ).size;
    expect(groups()).toBe(2);
    resolve.value = {};
    await nextTick();
    chart().render();
    expect(groups()).toBe(1);
  });

  it("keeps unchanged marks when a sibling mark changes", async () => {
    const { view, chart } = chartRef();
    const limit = ref(2);
    mount(
      `<Chart ref="view">
        <Line :data="metrics" x="t" y="a" />
        <Rule :y="limit" />
      </Chart>`,
      () => ({ metrics, view, limit }),
    );
    const seen = spyUpdates(chart());
    limit.value = 3;
    await nextTick();
    limit.value = 4;
    await nextTick();
    expect(seen).toHaveLength(2);
    // The line mark is the same object in both updates; only the rule changed.
    expect(seen[1]![0]).toBe(seen[0]![0]);
    expect(seen[1]![1]).not.toBe(seen[0]![1]);
  });

  it("sizes its container from width and height, and passes attributes through", () => {
    mount(
      `<Chart :width="300" :height="150" class="wide" data-test="chart">
        <Line :data="metrics" x="t" y="a" />
      </Chart>`,
      () => ({ metrics }),
    );
    const element = host.firstElementChild as HTMLElement;
    const box = element.getBoundingClientRect();
    expect([box.width, box.height]).toEqual([300, 150]);
    expect(element.className).toBe("wide");
    expect(element.dataset.test).toBe("chart");
  });

  it("resets options that are no longer passed", async () => {
    const { view, chart } = chartRef();
    const options = shallowRef<object>({ title: "Old", width: 300, theme: "dark" });
    mount(
      `<Chart ref="view" v-bind="options"><Line :data="metrics" x="t" y="a" /></Chart>`,
      () => ({ metrics, view, options }),
    );
    options.value = {};
    await nextTick();
    const svg = chart().toSVG();
    expect(svg).not.toContain("Old");
    expect(svg).toMatch(/width="600"/);
    expect((host.firstElementChild as HTMLElement).getBoundingClientRect().width).toBe(600);
  });

  it("applies new props before the parent's mounted and updated hooks run", async () => {
    const { view, chart } = chartRef();
    const title = ref("First");
    const seen: string[] = [];
    const record = () => seen.push(chart().toSVG().includes(title.value) ? title.value : "stale");
    mount(`<Chart ref="view" :title="title"><Line :data="metrics" x="t" y="a" /></Chart>`, () => {
      onMounted(record);
      onUpdated(record);
      return { metrics, view, title };
    });
    title.value = "Second";
    await nextTick();
    expect(seen).toEqual(["First", "Second"]);
  });

  it("treats options written in another key order as unchanged", async () => {
    const { view, chart } = chartRef();
    const axis = shallowRef({ label: "X", grid: true });
    mount(`<Chart ref="view" :x="axis"><Line :data="metrics" x="t" y="a" /></Chart>`, () => ({
      metrics,
      view,
      axis,
    }));
    const updates = spyUpdates(chart());
    axis.value = { grid: true, label: "X" };
    await nextTick();
    expect(updates).toHaveLength(0);
  });

  it("streams table changes without re-rendering Vue", async () => {
    const live = table({ t: [0, 1], v: [1, 2] }, { maxRows: 100 });
    const { view, chart } = chartRef();
    let renders = 0;
    mount(
      `<Chart ref="view" @vue:updated="rendered"><Line :data="live" x="t" y="v" /></Chart>`,
      () => {
        onUpdated(() => renders++);
        return { live, view, rendered: () => renders++ };
      },
    );
    const updates = spyUpdates(chart());
    const before = paths()[0]!.getAttribute("d");
    for (let i = 2; i < 50; i++) live.appendRow({ t: i, v: i % 7 });
    await nextTick();
    await frame();
    expect(paths()[0]!.getAttribute("d")).not.toBe(before);
    expect(renders).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it("exposes the chart through a template ref and destroys it on unmount", async () => {
    const { view } = chartRef();
    const shown = ref(true);
    const sales = table({ k: ["x", "y"], v: [1, 2] });
    mount(
      `<Chart v-if="shown" ref="view"><Bar :data="sales" x="k" y="v" /></Chart><div v-else />`,
      () => ({ sales, view, shown }),
    );
    const chart = view.value!.chart!;
    expect(chart.toSVG()).toContain("<svg");
    // Only the chart is exposed.
    expect(Object.keys(view.value!)).toEqual(["chart"]);
    shown.value = false;
    await nextTick();
    expect(host.querySelector('[role="figure"]')).toBeNull();
    expect(chart.root.isConnected).toBe(false);
    expect(view.value).toBeNull();
  });

  it("rejects children that are not marks", () => {
    const errors: unknown[] = [];
    app = createApp(defineComponent({ components, template: "<Chart><span /></Chart>" }));
    app.config.errorHandler = (error) => errors.push(error);
    app.config.warnHandler = () => {};
    app.mount(host);
    expect(String(errors[0])).toMatch(/mark components/);
  });
});

it("casts bare histogram boolean flags and keeps their values in the mark spec", async () => {
  const data = table({ v: [1, 1, 3], g: ["a", "b", "b"] });
  const { view, chart } = chartRef();
  mount(
    `<Chart ref="view"><Histogram :data="data" y="v" :bins="[0, 2, 4]" series="g" normalize="probability" commonNorm cumulative dodge /></Chart>`,
    () => ({ data, view }),
  );
  await nextTick();
  expect(chart().toSVG()).toContain("<path");
  expect(optionsOf(chart()).marks[0]!.spec).toMatchObject({
    y: "v",
    commonNorm: true,
    cumulative: true,
    dodge: true,
  });
});
