import {
  col,
  custom,
  facet,
  geometry,
  type Chart as HercegChart,
  line,
  RowSet,
  rangeNavigator,
  rowSelection,
  rowView,
  selectionStore,
  selectRows,
  table,
  time,
  timeBreaks,
} from "herceg";
import {
  act,
  createContext,
  StrictMode,
  Suspense,
  startTransition,
  use,
  useContext,
  useLayoutEffect,
  useRef,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Area,
  Bar,
  Candlestick,
  Chart,
  Custom,
  Dendrogram,
  Funnel,
  Gauge,
  GeoPoint,
  GeoShape,
  Graph,
  Line,
  Line3D,
  Pie,
  Point,
  Point3D,
  Radar,
  Region,
  Rule,
  Sankey,
  Sunburst,
  Surface,
  Text,
  Treemap,
  Violin,
} from "../src/index.ts";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  host.style.width = "600px";
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const metrics = table({ t: [0, 1, 2, 3], a: [1, 2, 3, 4], b: [4, 3, 2, 1] });
const paths = () => host.querySelectorAll("svg g[clip-path] path");

describe("<Chart>", () => {
  for (const stack of ["fill", "center", "wiggle"] as const) {
    it(`passes ${stack} and inside-out area options through React`, () => {
      let chart: HercegChart | null = null;
      act(() =>
        root.render(
          <Chart
            ref={(value) => {
              chart = value;
            }}
            renderer="svg"
          >
            <Area data={metrics} x="t" y={["a", "b"]} stack={stack} stackOrder="inside-out" />
          </Chart>,
        ),
      );
      expect(chart!.toSVG()).toContain('fill-opacity="0.85"');
      const before = chart!.toSVG();
      act(() => {
        chart!.setVisibility(chart!.getLegend()[0]!.key, false);
        chart!.render();
      });
      expect(chart!.toSVG()).not.toBe(before);
    });
  }
  it("accepts fill bar options through React", () => {
    act(() =>
      root.render(
        <Chart renderer="svg">
          <Bar data={metrics} x="t" y={["a", "b"]} stack="fill" labels={{ style: "percent" }} />
        </Chart>,
      ),
    );
    expect(host.textContent).toContain("20%");
  });
  it("draws dendrogram elements with summary-only reading", () => {
    const linkage = table({ first: [0], second: [1], height: [2] });
    act(() =>
      root.render(
        <Chart renderer="svg">
          <Dendrogram
            data={linkage}
            first="first"
            second="second"
            height="height"
            leaves={["a", "b"]}
            stroke="#ff0000"
            label="Clustering"
          />
        </Chart>,
      ),
    );
    expect(host.querySelectorAll('path[stroke="#ff0000"]')).toHaveLength(1);
    expect(host.textContent).toContain("Clustering: 2 leaves, 1 merge. Merge heights 2 to 2.");
  });

  it("renders marks from child elements, one path per series", () => {
    act(() =>
      root.render(
        <Chart title="Load">
          <Line data={metrics} x="t" y={["a", "b"]} />
          <Rule y={2} label="limit" />
        </Chart>,
      ),
    );
    expect(paths()).toHaveLength(2);
    expect(host.querySelector('[role="figure"]')!.getAttribute("aria-label")).toBe("Load");
    expect(host.textContent).toContain("limit");
  });

  it("reuses groups of marks from functions, and names the fix for wrapping components", () => {
    const loadMarks = () => (
      <>
        <Line data={metrics} x="t" y="a" />
        <Line data={metrics} x="t" y="b" />
      </>
    );
    act(() => root.render(<Chart>{loadMarks()}</Chart>));
    expect(paths()).toHaveLength(2);
    // A component of the application's: the chart cannot see what it renders.
    const LoadMarks = () => loadMarks();
    const quiet = createRoot(document.createElement("div"));
    expect(() => act(() => quiet.render(<Chart>{<LoadMarks />}</Chart>))).toThrow(
      /not components wrapping them: call a function/,
    );
    act(() => quiet.unmount());
  });

  it("draws a view's rows, and a new view replaces the mark", () => {
    const slow = rowView(metrics, { filter: col("a").gt(2) });
    const fast = rowView(metrics, { filter: col("a").le(2) });
    // The rows of the table the chart shows: those found where they are drawn.
    const shown = () => {
      const c = chartOf();
      c.render();
      return [0, 1, 2, 3].filter((row) => {
        const x = c.toPixel(metrics.numbers("t")[row]!, { axis: "x" })!;
        const y = c.toPixel(metrics.numbers("a")[row]!, { axis: "y" })!;
        return c.inspect(x, y)?.points[0]?.row === row;
      });
    };
    let chart: HercegChart | null = null;
    const chartOf = () => chart!;
    act(() =>
      root.render(
        <Chart
          renderer="svg"
          ref={(c) => {
            chart = c;
          }}
        >
          <Point data={slow} x="t" y="a" />
        </Chart>,
      ),
    );
    expect(shown()).toEqual([2, 3]);
    act(() =>
      root.render(
        <Chart
          renderer="svg"
          ref={(c) => {
            chart = c;
          }}
        >
          <Point data={fast} x="t" y="a" />
        </Chart>,
      ),
    );
    expect(shown()).toEqual([0, 1]);
  });

  it("renders a pie from its element, a path of arcs per slice", () => {
    const shares = table({ k: ["a", "b", "c"], v: [3, 2, 1] });
    act(() =>
      root.render(
        <Chart title="Shares">
          <Pie data={shares} category="k" value="v" innerRadius={0.5} />
        </Chart>,
      ),
    );
    const slices = [...paths()].filter((path) => /A/.test(path.getAttribute("d") ?? ""));
    expect(slices).toHaveLength(3);
    expect(host.textContent).toContain("Shares");
  });

  it("renders violins from their element", () => {
    const requests = table({ region: ["n", "n", "n", "s", "s", "s"], ms: [1, 2, 4, 3, 5, 9] });
    act(() =>
      root.render(
        <Chart>
          <Violin data={requests} x="region" y="ms" />
        </Chart>,
      ),
    );
    // Each violin's fill and its outline.
    const fills = [...paths()].filter((path) => path.getAttribute("fill-opacity") === "0.25");
    expect(fills).toHaveLength(1);
    expect(fills[0]!.getAttribute("d")!.match(/M/g)).toHaveLength(2);
  });

  it("renders treemaps and sunbursts from their elements", async () => {
    const sales = table({ region: ["a", "a", "b"], country: ["x", "y", "z"], v: [1, 2, 3] });
    act(() =>
      root.render(
        <Chart>
          <Treemap data={sales} path={["region", "country"]} value="v" />
        </Chart>,
      ),
    );
    expect(host.textContent).toContain("z");
    act(() =>
      root.render(
        <Chart>
          <Sunburst data={sales} path={["region", "country"]} value="v" />
        </Chart>,
      ),
    );
    // A new mark draws on the next frame.
    await frame();
    expect([...paths()].some((path) => /A/.test(path.getAttribute("d") ?? ""))).toBe(true);
  });

  it("renders gauges and funnels from their elements", async () => {
    const timed = table({ at: time([0]), cpu: [1] });
    // @ts-expect-error a gauge shows a number field, not a time field
    expect(<Gauge data={timed} value="at" />).toBeTruthy();
    const readings = table({ cpu: [12, 73] });
    act(() =>
      root.render(
        <Chart locale="en-US">
          <Gauge data={readings} value="cpu" label="CPU" bands={[{ to: 80 }, { to: 100 }]} />
        </Chart>,
      ),
    );
    expect(host.textContent).toContain("73");
    expect(host.textContent).toContain("CPU");
    const stages = table({ stage: ["Visit", "Buy"], users: [2000, 300] });
    act(() =>
      root.render(
        <Chart locale="en-US">
          <Funnel data={stages} category="stage" value="users" />
        </Chart>,
      ),
    );
    // A new mark draws on the next frame.
    await frame();
    expect(host.textContent).toContain("Visit");
    expect(host.textContent).toContain("2,000 · 100%");
  });

  it("renders a Sankey diagram from its element", () => {
    const energy = table({
      from: ["coal", "coal", "power"],
      to: ["power", "steel", "homes"],
      twh: [5, 2, 4],
    });
    act(() =>
      root.render(
        <Chart>
          <Sankey data={energy} source="from" target="to" value="twh" nodeWidth={10} />
        </Chart>,
      ),
    );
    const bands = [...paths()].filter((path) => /C/.test(path.getAttribute("d") ?? ""));
    expect(bands).toHaveLength(3);
    expect(host.textContent).toContain("coal 7");
  });

  it("renders a radar from its element, a filled polygon per series", () => {
    const players = table({ name: ["Ana", "Bo"], speed: [8, 5], power: [6, 9], range: [4, 7] });
    act(() =>
      root.render(
        <Chart>
          <Radar data={players} fields={["speed", "power", "range"]} series="name" />
        </Chart>,
      ),
    );
    expect(host.textContent).toContain("power");
    const fills = [...paths()].filter((path) => path.getAttribute("fill-opacity") === "0.15");
    expect(fills).toHaveLength(2);
  });

  it("renders a network from its element, and rebuilds it when its nodes table changes", async () => {
    const talks = table({ from: ["Ana", "Ana", "Bo"], to: ["Bo", "Cy", "Cy"] });
    const ref: { current: HercegChart | null } = { current: null };
    const teams = table({ name: ["Ana", "Bo", "Cy"], team: ["Data", "Data", "Sales"] });
    const alone = (people: typeof teams) => (
      <Chart ref={ref} locale="en-US" title="Talks">
        <Graph data={talks} source="from" target="to" nodes={people} node="name" color="team" />
      </Chart>
    );
    act(() => root.render(alone(teams)));
    expect(host.textContent).toContain("Network of 3 nodes and 3 links");
    expect(host.textContent).toContain("Sales");
    const chart = ref.current!;
    const seen: (readonly unknown[])[] = [];
    const update = chart.update.bind(chart);
    chart.update = (options) => {
      seen.push(options.marks ?? []);
      update(options);
    };
    // Equal props over the same tables keep the mark, and with it the layout.
    act(() => root.render(alone(teams)));
    expect(seen).toHaveLength(0);
    // Another nodes table, under the same props, is another mark.
    const moved = table({ name: ["Ana", "Bo", "Cy"], team: ["Data", "Ops", "Ops"] });
    act(() => root.render(alone(moved)));
    expect(seen).toHaveLength(1);
    await frame();
    expect(host.textContent).toContain("Ops");
    expect(host.textContent).not.toContain("Sales");
  });

  it("draws a map's regions and points from their elements, with its projection", async () => {
    const square = (x: number) => [x, 0, x + 10, 0, x + 10, 10, x, 10];
    const shapes = geometry({
      coordinates: Float64Array.from([...square(0), ...square(10)]),
      ringOffsets: Int32Array.from([0, 4, 8]),
      polygonOffsets: Int32Array.from([0, 1, 2]),
      geometryOffsets: Int32Array.from([0, 1, 2]),
    });
    const regions = table({ name: ["Ada", "Bel"], gdp: [1, 2], shape: shapes });
    const places = table({ lon: [5], lat: [5] });
    const ref: { current: HercegChart | null } = { current: null };
    const map = (projection: "mercator" | "equirectangular") => (
      <Chart ref={ref} projection={projection} locale="en-US">
        <GeoShape data={regions} labelField="name" color="gdp" />
        <GeoPoint data={places} longitude="lon" latitude="lat" />
      </Chart>
    );
    act(() => root.render(map("mercator")));
    const filled = [...paths()].filter((path) => path.getAttribute("fill-rule") === "evenodd");
    expect(filled).toHaveLength(2);
    expect(host.textContent).toContain("Map of 2 regions colored by gdp");
    const chart = ref.current!;
    const seen: unknown[] = [];
    const update = chart.update.bind(chart);
    chart.update = (options) => {
      seen.push(options);
      update(options);
    };
    act(() => root.render(map("mercator")));
    expect(seen).toHaveLength(0);
    act(() => root.render(map("equirectangular")));
    expect(seen).toHaveLength(1);
    await frame();
  });

  it("draws 3D marks from their elements, keeping a turned view until the camera prop changes", async () => {
    const grid = table({ x: [0, 1, 0, 1], y: [0, 0, 1, 1], z: [1, 2, 3, 4] });
    const points = table({ x: [0.5], y: [0.5], z: [3] });
    const ref: { current: HercegChart | null } = { current: null };
    const cameras: number[] = [];
    const view = (azimuth: number) => (
      <Chart
        ref={ref}
        camera={{ azimuth }}
        locale="en-US"
        onCamera={({ camera }) => cameras.push(camera.azimuth)}
      >
        <Surface data={grid} x="x" y="y" z="z" />
        <Point3D data={points} x="x" y="y" z="z" />
        <Line3D data={grid} x="x" y="y" z="z" />
      </Chart>
    );
    act(() => root.render(view(10)));
    expect(host.textContent).toContain("Surface of z over x and y");
    expect(host.textContent).toContain("3D line through x, y, z: 4 points in 1 run.");
    const chart = ref.current!;
    chart.setCamera({ elevation: 50 });
    await frame();
    expect(cameras).toEqual([10]);
    act(() => root.render(view(10)));
    expect(chart.camera).toMatchObject({ azimuth: 10, elevation: 50 });
    // A changed prop shows its camera; the application set it, so no event says so.
    act(() => root.render(view(30)));
    expect(chart.camera).toMatchObject({ azimuth: 30, elevation: 25 });
    await frame();
    expect(cameras).toEqual([10]);
  });

  it("reports drilling into a tree and moving a network's nodes", () => {
    const sales = table({ region: ["N", "N", "S"], country: ["a", "b", "c"], v: [1, 2, 3] });
    const ref: { current: HercegChart | null } = { current: null };
    const drills: (string | null)[] = [];
    act(() =>
      root.render(
        <Chart ref={ref} interaction={{ zoom: true }} onDrill={({ key }) => drills.push(key)}>
          <Treemap data={sales} path={["region", "country"]} value="v" />
        </Chart>,
      ),
    );
    act(() => ref.current!.setDrillRoot(["N"]));
    expect(drills).toEqual(['[0,"N"]']);
    expect(ref.current!.drillRoot?.path.map(({ label }) => label)).toEqual(["N"]);
    const talks = table({ from: ["a", "b"], to: ["b", "c"] });
    const moves: unknown[] = [];
    act(() =>
      root.render(
        <Chart
          ref={ref}
          interaction={{ drag: true }}
          onItemMove={({ position }) => moves.push(position)}
        >
          <Graph data={talks} source="from" target="to" />
        </Chart>,
      ),
    );
    act(() => ref.current!.setItemPosition('[0,"a"]', { x: 1, y: 2 }));
    expect(moves).toEqual([{ x: 1, y: 2 }]);
  });

  it("builds annotations from constants or from their own data", () => {
    const events = table({ at: [1, 2], name: ["deploy", "rollback"] });
    act(() =>
      root.render(
        <Chart>
          <Region x1={0.5} x2={1.5} />
          <Line data={metrics} x="t" y="a" />
          <Rule data={events} x="at" textField="name" />
          <Text x={3} y={4} label="peak" />
        </Chart>,
      ),
    );
    // The region and the line; rules and text are drawn as guides.
    expect(paths()).toHaveLength(2);
    expect(host.textContent).toContain("deploy");
    expect(host.textContent).toContain("rollback");
    expect(host.textContent).toContain("peak");
  });

  it("rebuilds custom marks so their draw sees new props", async () => {
    const labels = () =>
      [...host.querySelectorAll('[data-kind="shapes"] text')].map((t) => t.textContent);
    const view = (label: string) => (
      <Chart>
        <Line data={metrics} x="t" y="a" />
        <Custom draw={({ text, x, y }) => text(x(1), y(2), label)} />
      </Chart>
    );
    act(() => root.render(view("first")));
    expect(labels()).toEqual(["first"]);
    act(() => root.render(view("second")));
    await frame();
    expect(labels()).toEqual(["second"]);
  });

  it("passes series options to custom marks, which then have legend entries and tooltips", () => {
    let chart: HercegChart | null = null;
    const drawn: string[][] = [];
    function App() {
      const ref = useRef<HercegChart | null>(null);
      chart = ref.current ?? chart;
      return (
        <Chart ref={ref}>
          <Custom
            data={metrics}
            x="t"
            y={["a", "b"]}
            pointText={(row, format, s) => `${format.y(s.y[row]!)} req`}
            draw={({ series, circle, x, y }) => {
              drawn.push(series.map((s) => s.label));
              for (const s of series) circle(x(s.x[0]!), y(s.y[0]!), 3, { fill: s.color });
            }}
          />
        </Chart>
      );
    }
    act(() => root.render(<App />));
    act(() => root.render(<App />));
    const buttons = host.querySelectorAll("button");
    expect([...buttons].map((button) => button.textContent)).toEqual(["a", "b"]);
    const mounted = chart as unknown as HercegChart;
    const inspection = mounted.inspect(
      mounted.toPixel(1, { axis: "x" })!,
      mounted.toPixel(2, { axis: "y" })!,
    )!;
    expect(inspection.points.map((p) => p.text)).toEqual(["2 req", "3 req"]);
    act(() => buttons[0]!.click());
    (chart as unknown as HercegChart).render();
    expect(drawn.at(-1)).toEqual(["b"]);
  });

  it("keeps custom marks given as marks only while they are the same object", async () => {
    // A custom mark's spec does not describe what it draws.
    const badge = (label: string) => custom({ draw: ({ text, x, y }) => text(x(1), y(2), label) });
    const labels = () =>
      [...host.querySelectorAll('[data-kind="shapes"] text')].map((t) => t.textContent);
    const view = (label: string) => (
      <Chart marks={[line(metrics, { x: "t", y: "a" }), badge(label)]} />
    );
    act(() => root.render(view("first")));
    act(() => root.render(view("second")));
    await frame();
    expect(labels()).toEqual(["second"]);
  });

  it("calls the latest event handlers without resubscribing", () => {
    let chart: HercegChart | null = null;
    const seen: string[] = [];
    function App({ name }: { name: string }) {
      const ref = useRef<HercegChart | null>(null);
      chart = ref.current ?? chart;
      return (
        <Chart ref={ref} onSelect={({ x }) => seen.push(`${name}:${x?.join("-")}`)}>
          <Line data={metrics} x="t" y="a" />
        </Chart>
      );
    }
    act(() => root.render(<App name="one" />));
    act(() => root.render(<App name="two" />));
    act(() => (chart as unknown as HercegChart).select([1, 2]));
    expect(seen).toEqual(["two:1-2"]);
  });

  it("binds a row selection, kept across re-renders while its store and channel are", () => {
    const store = selectionStore(metrics);
    const other = selectionStore(metrics);
    const seen: unknown[] = [];
    const ref: { current: HercegChart | null } = { current: null };
    function App({ tick, bound }: { tick: number; bound: typeof store }) {
      return (
        <Chart
          ref={ref}
          title={`tick ${tick % 1}`}
          rowSelection={rowSelection({ store: bound, channel: "focus" })}
          onRowSelection={({ selection }) => seen.push(selection)}
        >
          <Line data={metrics} x="t" y="a" />
        </Chart>
      );
    }
    act(() => root.render(<App tick={1} bound={store} />));
    const chart = ref.current!;
    let updates = 0;
    const update = chart.update.bind(chart);
    chart.update = (options) => {
      updates++;
      update(options);
    };
    // A new binding of the same store and channel is the same binding.
    act(() => root.render(<App tick={2} bound={store} />));
    expect(updates).toBe(0);
    const rows = selectRows(new RowSet(metrics).add(1));
    act(() => store.set("focus", rows));
    expect(seen).toEqual([rows]);
    // Another store rebinds the chart.
    act(() => root.render(<App tick={3} bound={other} />));
    expect(updates).toBe(1);
    act(() => store.set("focus", null));
    expect(seen).toEqual([rows]);
    act(() => other.set("focus", rows));
    expect(seen).toEqual([rows, rows]);
  });

  it("tells onRender of the first frame, with the ref set", () => {
    const panels: number[] = [];
    function App() {
      const ref = useRef<HercegChart | null>(null);
      return (
        <Chart ref={ref} onRender={() => panels.push(ref.current!.getPanels().length)}>
          <Line data={metrics} x="t" y="a" />
        </Chart>
      );
    }
    act(() => root.render(<App />));
    expect(panels).toEqual([1]);
  });

  it("reports hiding that an update makes to the handler given with it", () => {
    const ref: { current: HercegChart | null } = { current: null };
    const seen: string[] = [];
    function App({ name, both }: { name: string; both: boolean }) {
      return (
        <Chart
          ref={ref}
          onVisibility={({ hiddenKeys }) => seen.push(`${name}:${hiddenKeys.length}`)}
        >
          <Line data={metrics} x="t" y="a" />
          {both && <Line data={metrics} x="t" y="b" />}
        </Chart>
      );
    }
    act(() => root.render(<App name="one" both />));
    act(() => ref.current!.setVisibility(ref.current!.getLegend()[1]!.key, false));
    // The second line goes, and its hidden key with it.
    act(() => root.render(<App name="two" both={false} />));
    expect(seen).toEqual(["one:1", "two:0"]);
  });

  it("passes the whole view to onViewport", () => {
    let chart: HercegChart | null = null;
    const views: unknown[] = [];
    function App() {
      const ref = useRef<HercegChart | null>(null);
      chart = ref.current ?? chart;
      return (
        <Chart ref={ref} onViewport={(view) => views.push(view)}>
          <Line data={metrics} x="t" y="a" />
        </Chart>
      );
    }
    act(() => root.render(<App />));
    act(() => root.render(<App />));
    act(() => (chart as unknown as HercegChart).setViewport({ x: [1, 2], y: [0, 5] }));
    expect(views).toEqual([{ x: [1, 2], y: [0, 5], yRight: null }]);
  });

  it("keeps the committed handler while a transition is suspended", async () => {
    let chart: HercegChart | null = null;
    const seen: string[] = [];
    const pending = new Promise<never>(() => {});
    function Waits({ wait }: { wait: boolean }) {
      if (wait) use(pending);
      return null;
    }
    function App({ name, wait }: { name: string; wait: boolean }) {
      const ref = useRef<HercegChart | null>(null);
      chart = ref.current ?? chart;
      return (
        <Suspense fallback={null}>
          <Chart ref={ref} onSelect={() => seen.push(name)}>
            <Line data={metrics} x="t" y="a" />
          </Chart>
          <Waits wait={wait} />
        </Suspense>
      );
    }
    act(() => root.render(<App name="one" wait={false} />));
    // The transition suspends, so React keeps showing render "one".
    act(() => startTransition(() => root.render(<App name="two" wait />)));
    act(() => (chart as unknown as HercegChart).select([1, 2]));
    expect(seen).toEqual(["one"]);
  });

  it("applies prop changes to the same chart", () => {
    let chart: HercegChart | null = null;
    function App({ title }: { title: string }) {
      const ref = useRef<HercegChart | null>(null);
      chart = ref.current ?? chart;
      return (
        <Chart ref={ref} title={title}>
          <Line data={metrics} x="t" y="a" />
        </Chart>
      );
    }
    act(() => root.render(<App title="One" />));
    const figure = host.querySelector('[role="figure"]')!;
    act(() => root.render(<App title="Two" />));
    expect(host.querySelector('[role="figure"]')).toBe(figure);
    expect(figure.getAttribute("aria-label")).toBe("Two");
  });

  it("does not update the chart when a re-render changes nothing", () => {
    const ref: { current: HercegChart | null } = { current: null };
    // The parent re-renders with a new prop; the chart's own props stay equal.
    function App(_: { tick: number }) {
      return (
        <Chart ref={ref} y={{ title: "ms" }}>
          <Line data={metrics} x="t" y="a" />
        </Chart>
      );
    }
    const view = (tick: number) => <App tick={tick} />;
    act(() => root.render(view(1)));
    const chart = ref.current!;
    let updates = 0;
    const update = chart.update.bind(chart);
    chart.update = (options) => {
      updates++;
      update(options);
    };
    act(() => root.render(view(2)));
    expect(updates).toBe(0);
  });

  it("draws a panel per facet value and keeps equal facets without updating", () => {
    const sales = table({ t: [0, 1, 0, 1], v: [1, 2, 3, 4], region: ["N", "N", "S", "S"] });
    const ref: { current: HercegChart | null } = { current: null };
    function App({ field }: { field: string }) {
      return (
        <Chart ref={ref} facet={facet(field)}>
          <Line data={sales} x="t" y="v" />
        </Chart>
      );
    }
    act(() => root.render(<App field="region" />));
    const chart = ref.current!;
    expect(chart.getPanels().map((p) => p.key)).toEqual(["N", "S"]);
    let updates = 0;
    const update = chart.update.bind(chart);
    chart.update = (options) => {
      updates++;
      update(options);
    };
    // A new facet object for the same field is the same option.
    act(() => root.render(<App field="region" />));
    expect(updates).toBe(0);
  });

  it("draws OHLC bars, and keeps equal breaks without updating", () => {
    const day = 86_400_000;
    const prices = table({
      t: time([0, 1, 4].map((d) => Date.UTC(2025, 9, 9) + d * day)),
      o: [10, 12, 9],
      h: [13, 12.5, 9.5],
      l: [9, 8, 8.5],
      c: [12, 9, 9],
    });
    const ref: { current: HercegChart | null } = { current: null };
    function App({ days }: { days: ("sat" | "sun")[] }) {
      return (
        <Chart ref={ref} timeZone="UTC" x={{ breaks: timeBreaks([{ weekdays: days }]) }}>
          <Candlestick data={prices} x="t" open="o" high="h" low="l" close="c" variant="ohlc" />
        </Chart>
      );
    }
    act(() => root.render(<App days={["sat", "sun"]} />));
    const chart = ref.current!;
    expect(host.querySelector("svg g[clip-path] rect")).toBeNull();
    // Thursday, Friday, and Monday a day apart.
    const [thu, fri, mon] = [0, 1, 4].map(
      (d) => chart.toPixel(Date.UTC(2025, 9, 9) + d * day, { axis: "x" })!,
    );
    expect(mon! - fri!).toBeCloseTo(fri! - thu!, 6);
    let updates = 0;
    const update = chart.update.bind(chart);
    chart.update = (options) => {
      updates++;
      update(options);
    };
    // New breaks with the same rules are the same option; other rules are not.
    act(() => root.render(<App days={["sat", "sun"]} />));
    expect(updates).toBe(0);
    act(() => root.render(<App days={["sun"]} />));
    expect(updates).toBe(1);
  });

  it("draws a navigator, keeps an equal one without updating, and removes it", async () => {
    const ref: { current: HercegChart | null } = { current: null };
    function App({ height }: { height?: number }) {
      return (
        <Chart ref={ref} {...(height !== undefined && { navigator: rangeNavigator({ height }) })}>
          <Line data={metrics} x="t" y="a" />
        </Chart>
      );
    }
    act(() => root.render(<App height={40} />));
    const chart = ref.current!;
    await chart.loading;
    expect(host.querySelectorAll('[aria-label="Range navigator"] [role="slider"]')).toHaveLength(3);
    let updates = 0;
    const update = chart.update.bind(chart);
    chart.update = (options) => {
      updates++;
      update(options);
    };
    act(() => root.render(<App height={40} />));
    expect(updates).toBe(0);
    act(() => root.render(<App />));
    expect(updates).toBe(1);
    expect(host.querySelector('[aria-label="Range navigator"]')).toBeNull();
  });

  it("keeps unchanged marks when a sibling mark changes", () => {
    const ref: { current: HercegChart | null } = { current: null };
    const view = (limit: number) => (
      <Chart ref={ref}>
        <Line data={metrics} x="t" y="a" />
        <Rule y={limit} />
      </Chart>
    );
    act(() => root.render(view(2)));
    const chart = ref.current!;
    const seen: (readonly unknown[])[] = [];
    const update = chart.update.bind(chart);
    chart.update = (options) => {
      seen.push(options.marks ?? []);
      update(options);
    };
    act(() => root.render(view(3)));
    act(() => root.render(view(4)));
    expect(seen).toHaveLength(2);
    // The line mark is the same object in both updates; only the rule changed.
    expect(seen[1]![0]).toBe(seen[0]![0]);
    expect(seen[1]![1]).not.toBe(seen[0]![1]);
  });

  it("sizes its container from width and height", () => {
    act(() =>
      root.render(
        <Chart width={300} height={150}>
          <Line data={metrics} x="t" y="a" />
        </Chart>,
      ),
    );
    const box = (host.firstElementChild as HTMLElement).getBoundingClientRect();
    expect([box.width, box.height]).toEqual([300, 150]);
  });

  it("resets options that are no longer passed", () => {
    const ref: { current: HercegChart | null } = { current: null };
    const line = <Line data={metrics} x="t" y="a" />;
    act(() =>
      root.render(
        <Chart ref={ref} title="Old" width={300} theme="dark">
          {line}
        </Chart>,
      ),
    );
    act(() => root.render(<Chart ref={ref}>{line}</Chart>));
    const svg = ref.current!.toSVG();
    expect(svg).not.toContain("Old");
    // Back to the light theme's text color and the container's full width.
    expect(svg).toMatch(/width="600"/);
    expect((host.firstElementChild as HTMLElement).getBoundingClientRect().width).toBe(600);
  });

  it("applies new props before parent layout effects run", () => {
    const seen: string[] = [];
    function App({ title }: { title: string }) {
      const ref = useRef<HercegChart | null>(null);
      useLayoutEffect(() => {
        seen.push(ref.current!.toSVG().includes(title) ? title : "stale");
      });
      return (
        <Chart ref={ref} title={title}>
          <Line data={metrics} x="t" y="a" />
        </Chart>
      );
    }
    act(() => root.render(<App title="First" />));
    act(() => root.render(<App title="Second" />));
    expect(seen).toEqual(["First", "Second"]);
  });

  it("treats options written in another key order as unchanged", () => {
    const ref: { current: HercegChart | null } = { current: null };
    const view = (x: { title: string; grid: boolean }) => (
      <Chart ref={ref} x={x}>
        <Line data={metrics} x="t" y="a" />
      </Chart>
    );
    act(() => root.render(view({ title: "X", grid: true })));
    let updates = 0;
    const update = ref.current!.update.bind(ref.current);
    ref.current!.update = (options) => {
      updates++;
      update(options);
    };
    act(() => root.render(view({ grid: true, title: "X" })));
    expect(updates).toBe(0);
  });

  it("streams table changes without re-rendering React", async () => {
    const live = table({ t: [0, 1], v: [1, 2] }, { maxRows: 100 });
    let renders = 0;
    function App() {
      renders++;
      return (
        <Chart>
          <Line data={live} x="t" y="v" />
        </Chart>
      );
    }
    act(() => root.render(<App />));
    const before = paths()[0]!.getAttribute("d");
    for (let i = 2; i < 50; i++) live.appendRow({ t: i, v: i % 7 });
    await frame();
    expect(paths()[0]!.getAttribute("d")).not.toBe(before);
    expect(renders).toBe(1);
  });

  it("exposes the chart through a ref and destroys it on unmount", () => {
    const ref: { current: HercegChart | null } = { current: null };
    act(() =>
      root.render(
        <Chart ref={ref}>
          <Bar data={table({ k: ["x", "y"], v: [1, 2] })} x="k" y="v" />
        </Chart>,
      ),
    );
    expect(ref.current?.toSVG()).toContain("<svg");
    act(() => root.render(<div />));
    expect(host.querySelector('[role="figure"]')).toBeNull();
    expect(ref.current).toBeNull();
  });

  it("survives StrictMode's double mount", () => {
    act(() =>
      root.render(
        <StrictMode>
          <Chart>
            <Line data={metrics} x="t" y="a" />
          </Chart>
        </StrictMode>,
      ),
    );
    expect(host.querySelectorAll('[role="figure"]')).toHaveLength(1);
  });

  it("renders tooltip content in the chart's box, with the application's context", async () => {
    const Unit = createContext("");
    let renders = 0;
    function Content({ text }: { text: string }) {
      renders++;
      return <b>{`${text} ${useContext(Unit)}`}</b>;
    }
    const ref: { current: HercegChart | null } = { current: null };
    const show = (
      renderTooltip?: (i: { value: number; points: { text: string }[] }) => React.ReactNode,
    ) =>
      act(() =>
        root.render(
          <Unit value="ms">
            <Chart ref={ref} locale="en-US" renderTooltip={renderTooltip}>
              <Line data={metrics} x="t" y="a" tooltip={{ fields: ["b"] }} />
            </Chart>
          </Unit>,
        ),
      );
    show((inspection) =>
      inspection.value === 0 ? null : <Content text={inspection.points[0]!.text} />,
    );
    await ref.current!.loading;
    const hover = async (x: number) => {
      const chart = ref.current!;
      const rect = chart.root.getBoundingClientRect();
      const { plot } = chart.getPanels()[0]!;
      await act(async () => {
        chart.root.dispatchEvent(
          new PointerEvent("pointermove", {
            bubbles: true,
            clientX: rect.left + chart.toPixel(x, { axis: "x" })!,
            clientY: rect.top + plot.y + plot.height / 2,
          }),
        );
        chart.render();
      });
    };
    const box = () =>
      [...host.querySelectorAll<HTMLElement>('div[aria-hidden="true"]')].find(
        (div) => div.style.display === "block",
      );
    await hover(1);
    expect(box()!.textContent).toBe("2 ms");
    expect(box()!.querySelector("b")).not.toBeNull();
    // Moving within what the tooltip is at renders nothing again.
    const before = renders;
    await hover(1);
    expect(renders).toBe(before);
    await hover(2);
    expect(box()!.textContent).toBe("3 ms");
    // Null shows the built-in content.
    await hover(0);
    expect([...box()!.children].map((row) => row.textContent)).toEqual(["0", "a1", "b4"]);
    // A new prop that gives content where the last gave none shows it, without a move.
    show((inspection) => <Content text={`at ${inspection.value}`} />);
    await act(async () => ref.current!.render());
    expect(box()!.textContent).toBe("at 0 ms");
    // And one that gives none shows the built-in content.
    show((inspection) => (inspection.value === 0 ? null : <Content text="other" />));
    await act(async () => ref.current!.render());
    expect([...box()!.children].map((row) => row.textContent)).toEqual(["0", "a1", "b4"]);
    // Without renderTooltip, the built-in content shows the fields.
    show(undefined);
    await hover(3);
    expect([...box()!.children].map((row) => row.textContent)).toEqual(["3", "a4", "b1"]);
  });

  it("rejects children that are not marks", () => {
    expect(() =>
      act(() =>
        root.render(
          <Chart>
            <span />
          </Chart>,
        ),
      ),
    ).toThrow(/mark elements/);
  });
});
