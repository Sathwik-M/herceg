import {
  custom,
  type DrawContext,
  facet,
  geometry,
  type Chart as HercegChart,
  type Mark as HercegMark,
  line,
  table,
  time,
  timeBreaks,
} from "herceg";
import { type Component, flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Annotations from "./Annotations.svelte";
import Faulty from "./Faulty.svelte";
import Gauges from "./Gauges.svelte";
import Lines from "./Lines.svelte";
import Lollipops from "./Lollipops.svelte";
import Maps from "./Maps.svelte";
import Parent from "./Parent.svelte";
import Pies from "./Pies.svelte";
import Prices from "./Prices.svelte";
import Stray from "./Stray.svelte";

let host: HTMLDivElement;
let mounted: Record<string, unknown> | undefined;

beforeEach(() => {
  host = document.createElement("div");
  host.style.width = "600px";
  document.body.append(host);
});

afterEach(() => {
  if (mounted) unmount(mounted);
  mounted = undefined;
  flushSync();
  host.remove();
});

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const metrics = table({ t: [0, 1, 2, 3], a: [1, 2, 3, 4], b: [4, 3, 2, 1] });
const paths = () => host.querySelectorAll("svg g[clip-path] path");

/** Mounts a component and runs its effects; changing `props` later updates it. */
function render<P extends Record<string, unknown>>(component: Component<P>, props: P): void {
  mounted = mount(component, { target: host, props });
  flushSync();
}

type LinesProps = Parameters<typeof Lines>[1];

/** Props for <Lines>, as state the tests change; `chart` is bound. */
function lines(initial: Partial<LinesProps> = {}): LinesProps & { chart: HercegChart } {
  const props = $state({ data: metrics, chart: null, ...initial });
  render(Lines, props);
  return props as LinesProps & { chart: HercegChart };
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

const order = (chart: HercegChart) =>
  chart.model.config.marks.map((mark) => {
    const spec = mark.spec as { type: string; y?: unknown };
    return spec.type === "line" ? `line:${spec.y}` : spec.type;
  });

describe("<Chart>", () => {
  it("draws OHLC bars, and keeps equal breaks without updating", () => {
    const day = 86_400_000;
    const data = table({
      t: time([0, 1, 4].map((d) => Date.UTC(2025, 9, 9) + d * day)),
      o: [10, 12, 9],
      h: [13, 12.5, 9.5],
      l: [9, 8, 8.5],
      c: [12, 9, 9],
    });
    const props = $state({
      data,
      breaks: timeBreaks([{ weekdays: ["sat", "sun"] }]),
      chart: null as HercegChart | null,
    });
    render(Prices, props);
    const chart = props.chart!;
    expect(host.querySelector("svg g[clip-path] rect")).toBeNull();
    const x = chart.model.xScale()!;
    const [thu, fri, mon] = [0, 1, 4].map((d) => x.map(Date.UTC(2025, 9, 9) + d * day));
    expect(mon! - fri!).toBeCloseTo(fri! - thu!, 6);
    const updates = spyUpdates(chart);
    // New breaks with the same rules are the same option; other rules are not.
    props.breaks = timeBreaks([{ weekdays: ["sat", "sun"] }]);
    flushSync();
    expect(updates).toHaveLength(0);
    props.breaks = timeBreaks([{ weekdays: ["sun"] }]);
    flushSync();
    expect(updates).toHaveLength(1);
  });

  it("renders marks from its children, one path per series", () => {
    lines({ fields: ["a", "b"], limit: 2, options: { title: "Load" } });
    expect(paths()).toHaveLength(2);
    expect(host.querySelector('[role="figure"]')!.getAttribute("aria-label")).toBe("Load");
    expect(host.textContent).toContain("limit");
  });

  it("renders a pie from its component, a path of arcs per slice", () => {
    render(Pies, { data: table({ k: ["a", "b", "c"], v: [3, 2, 1] }) });
    const slices = [...paths()].filter((path) => /A/.test(path.getAttribute("d") ?? ""));
    expect(slices).toHaveLength(3);
  });

  it("draws a map's regions and points from their components, with its projection", () => {
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
    render(Maps, { regions, places: table({ lon: [5], lat: [5] }) });
    const filled = [...paths()].filter((path) => path.getAttribute("fill-rule") === "evenodd");
    expect(filled).toHaveLength(2);
    // The point, ringed in the background color.
    expect(host.querySelectorAll('svg g[clip-path] g[stroke-width="1"] circle')).toHaveLength(1);
  });

  it("renders gauges and funnels from their components", () => {
    render(Gauges, {
      readings: table({ cpu: [12, 73] }),
      stages: table({ stage: ["Visit", "Buy"], users: [2000, 300] }),
    });
    expect(host.textContent).toContain("73");
    expect(host.textContent).toContain("80");
    expect(host.textContent).toContain("2,000 · 100%");
  });

  it("builds annotations from constants or from their own data", () => {
    const events = table({ at: [1, 2], name: ["deploy", "rollback"] });
    render(Annotations, { data: metrics, events });
    // The region and the line; rules and text are drawn as guides.
    expect(paths()).toHaveLength(2);
    expect(host.textContent).toContain("deploy");
    expect(host.textContent).toContain("rollback");
    expect(host.textContent).toContain("peak");
  });

  it("keeps marks from blocks and components of its own in template order", () => {
    const props = lines({ fields: ["a", "b"], limit: 3 });
    expect(order(props.chart)).toEqual(["line:a", "line:b", "rule"]);
    props.band = true;
    props.pair = true;
    props.fields = ["b", "a"];
    flushSync();
    expect(order(props.chart)).toEqual(["region", "line:b", "line:a", "point", "rule", "rule"]);
  });

  it("reorders marks when a keyed block moves them", async () => {
    const props = lines({ fields: ["a", "b"] });
    const seen = spyUpdates(props.chart);
    props.fields = ["b", "a"];
    flushSync();
    // Moved anchors are seen once the mutation observer has reported them.
    await Promise.resolve();
    flushSync();
    expect(order(props.chart)).toEqual(["line:b", "line:a"]);
    expect(seen).toHaveLength(1);
  });

  it("follows in-place changes of state it reads", async () => {
    const axis = { label: "Before" };
    const props = lines({ fields: ["a"], options: { x: axis } });
    props.fields!.push("b");
    flushSync();
    await frame();
    expect(order(props.chart)).toEqual(["line:a", "line:b"]);
    expect(host.textContent).toContain("Before");
    (props.options!.x as typeof axis).label = "After";
    flushSync();
    await frame();
    expect(host.textContent).toContain("After");
  });

  it("rebuilds custom marks so their draw sees new values", async () => {
    const labels = () =>
      [...host.querySelectorAll('[data-kind="shapes"] text')].map((t) => t.textContent);
    const writing =
      (label: string) =>
      ({ text, x, y }: DrawContext) =>
        text(x(1), y(2), label);
    const props = lines({ draw: writing("first") });
    expect(labels()).toEqual(["first"]);
    props.draw = writing("second");
    flushSync();
    await frame();
    expect(labels()).toEqual(["second"]);
  });

  it("passes series options to custom marks, which then have legend entries and tooltips", () => {
    const drawn: string[][] = [];
    const props = $state({
      data: metrics,
      drawn: (labels: string[]) => drawn.push(labels),
      chart: null as HercegChart | null,
    });
    render(Lollipops, props);
    const buttons = host.querySelectorAll("button");
    expect([...buttons].map((button) => button.textContent)).toEqual(["a", "b"]);
    const { model } = props.chart!;
    const inspection = model.inspect(model.xScale()!.map(1), model.yScale()!.map(2))!;
    expect(inspection.points.map((p) => p.text)).toEqual(["2 req", "3 req"]);
    buttons[0]!.click();
    props.chart!.render();
    expect(drawn.at(-1)).toEqual(["b"]);
  });

  it("keeps marks written against the Mark interface only while they are the same object", async () => {
    // A mark whose spec does not describe what it draws.
    const badge = (label: string): HercegMark => {
      const inner = custom({ draw: ({ text, x, y }) => text(x(1), y(2), label) });
      return {
        spec: { type: "badge" },
        table: undefined,
        tooltip: "x",
        channelKind: () => undefined,
        series: () => [],
        xExtent: () => undefined,
        yExtent: () => undefined,
        geometry: (series, frame, key) => inner.geometry(series, frame, key),
      };
    };
    const labels = () =>
      [...host.querySelectorAll('[data-kind="shapes"] text')].map((t) => t.textContent);
    const props = lines({ fields: [], marks: [line(metrics, { x: "t", y: "a" }), badge("first")] });
    props.marks = [line(metrics, { x: "t", y: "a" }), badge("second")];
    flushSync();
    await frame();
    expect(labels()).toEqual(["second"]);
  });

  it("calls the current handler without resubscribing", () => {
    const seen: string[] = [];
    const props = lines({ onselect: ({ x }) => seen.push(`one:${x?.join("-")}`) });
    const on = props.chart.on.bind(props.chart);
    let subscriptions = 0;
    props.chart.on = (type, listener) => {
      subscriptions++;
      return on(type, listener);
    };
    props.onselect = ({ x }) => seen.push(`two:${x?.join("-")}`);
    flushSync();
    props.chart.select([1, 2]);
    expect(seen).toEqual(["two:1-2"]);
    expect(subscriptions).toBe(0);
  });

  it("listens only while a handler is given", () => {
    const seen: unknown[] = [];
    const props = lines();
    props.chart.select([0, 1]);
    props.onselect = (event) => seen.push(event);
    flushSync();
    props.chart.select([1, 2]);
    props.onselect = undefined;
    flushSync();
    props.chart.select([2, 3]);
    expect(seen).toEqual([{ x: [1, 2], y: null, lasso: null }]);
  });

  it("applies prop changes to the same chart", () => {
    const props = lines({ options: { title: "One" } });
    const figure = host.querySelector('[role="figure"]')!;
    props.options = { title: "Two" };
    flushSync();
    expect(host.querySelector('[role="figure"]')).toBe(figure);
    expect(figure.getAttribute("aria-label")).toBe("Two");
  });

  it("does not update the chart when a change leaves its props equal", () => {
    const props = lines({ options: { y: { label: "ms" } } });
    const updates = spyUpdates(props.chart);
    props.options = { y: { label: "ms" } };
    flushSync();
    expect(updates).toHaveLength(0);
  });

  it("draws a panel per facet value and keeps equal facets without updating", () => {
    const sales = table({ t: [0, 1, 0, 1], v: [1, 2, 3, 4], region: ["N", "N", "S", "S"] });
    const props = lines({
      fields: [],
      marks: [line(sales, { x: "t", y: "v" })],
      options: { facet: facet("region") },
    });
    expect(props.chart.model.panels().map((p) => p.key)).toEqual(["N", "S"]);
    const updates = spyUpdates(props.chart);
    props.options = { facet: facet("region") };
    flushSync();
    expect(updates).toHaveLength(0);
  });

  it("keeps unchanged marks when a sibling mark changes", () => {
    const props = lines({ limit: 2 });
    const seen = spyUpdates(props.chart);
    props.limit = 3;
    flushSync();
    props.limit = 4;
    flushSync();
    expect(seen).toHaveLength(2);
    // The line mark is the same object in both updates; only the rule changed.
    expect(seen[1]![0]).toBe(seen[0]![0]);
    expect(seen[1]![1]).not.toBe(seen[0]![1]);
  });

  it("sizes its container from width and height, with class and style", () => {
    lines({ options: { width: 300, height: 150, class: "wide", style: "margin: 4px" } });
    const element = host.firstElementChild as HTMLElement;
    const box = element.getBoundingClientRect();
    expect([box.width, box.height]).toEqual([300, 150]);
    expect(element.className).toBe("wide");
    expect(element.style.margin).toBe("4px");
  });

  it("resets options that are no longer passed", () => {
    const props = lines({ options: { title: "Old", width: 300, theme: "dark" } });
    props.options = {};
    flushSync();
    const svg = props.chart.toSVG();
    expect(svg).not.toContain("Old");
    expect(svg).toMatch(/width="600"/);
    expect((host.firstElementChild as HTMLElement).getBoundingClientRect().width).toBe(600);
  });

  it("applies new props before the parent's effects run", () => {
    const seen: string[] = [];
    const props = $state({
      data: metrics,
      title: "First",
      record: (shown: string) => seen.push(shown),
    });
    render(Parent, props);
    props.title = "Second";
    flushSync();
    expect(seen).toEqual(["First", "Second"]);
  });

  it("treats options written in another key order as unchanged", () => {
    const props = lines({ options: { x: { label: "X", grid: true } } });
    const updates = spyUpdates(props.chart);
    props.options = { x: { grid: true, label: "X" } };
    flushSync();
    expect(updates).toHaveLength(0);
  });

  it("streams table changes without Svelte", async () => {
    const live = table({ t: [0, 1], a: [1, 2], b: [2, 1] }, { maxRows: 100 });
    const props = lines({ data: live });
    const updates = spyUpdates(props.chart);
    const before = paths()[0]!.getAttribute("d");
    for (let i = 2; i < 50; i++) live.appendRow({ t: i, a: i % 7, b: 1 });
    flushSync();
    await frame();
    expect(paths()[0]!.getAttribute("d")).not.toBe(before);
    expect(updates).toHaveLength(0);
  });

  it("binds the chart and destroys it on unmount", () => {
    const props = lines();
    const chart = props.chart;
    expect(chart.toSVG()).toContain("<svg");
    unmount(mounted!);
    mounted = undefined;
    flushSync();
    expect(host.querySelector('[role="figure"]')).toBeNull();
    expect(chart.root.isConnected).toBe(false);
    expect(props.chart).toBeNull();
  });

  it("throws invalid marks to the nearest boundary", () => {
    const errors: unknown[] = [];
    const props = $state({
      data: metrics,
      field: "a",
      bounded: true,
      onerror: (error: unknown) => errors.push(error),
    });
    render(Faulty, props);
    props.field = "missing";
    flushSync();
    expect(String(errors[0])).toMatch(/Unknown field "missing"/);
  });

  it("recovers once invalid marks are fixed", async () => {
    const props = $state({ data: metrics, field: "a" });
    render(Faulty, props);
    const before = paths()[0]!.getAttribute("d");
    props.field = "missing";
    expect(() => flushSync()).toThrow(/Unknown field "missing"/);
    props.field = "b";
    flushSync();
    await frame();
    expect(paths()).toHaveLength(1);
    expect(paths()[0]!.getAttribute("d")).not.toBe(before);
  });

  it("rejects mark components outside a chart", () => {
    expect(() => render(Stray, {})).toThrow(/inside a <Chart>/);
  });
});
