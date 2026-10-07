import { custom, type Chart as HercegChart, type Mark as HercegMark, line, table } from "herceg";
import { act, StrictMode, Suspense, startTransition, use, useLayoutEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Bar, Chart, Custom, Line, Region, Rule, Text } from "../src/index.ts";

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

  it("builds annotations from constants or from their own data", () => {
    const events = table({ at: [1, 2], name: ["deploy", "rollback"] });
    act(() =>
      root.render(
        <Chart>
          <Region x1={0.5} x2={1.5} />
          <Line data={metrics} x="t" y="a" />
          <Rule data={events} x="at" text="name" />
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
        <Chart ref={ref} y={{ label: "ms" }}>
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
    const view = (x: { label: string; grid: boolean }) => (
      <Chart ref={ref} x={x}>
        <Line data={metrics} x="t" y="a" />
      </Chart>
    );
    act(() => root.render(view({ label: "X", grid: true })));
    let updates = 0;
    const update = ref.current!.update.bind(ref.current);
    ref.current!.update = (options) => {
      updates++;
      update(options);
    };
    act(() => root.render(view({ grid: true, label: "X" })));
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
