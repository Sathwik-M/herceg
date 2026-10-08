import { afterEach, describe, expect, it, vi } from "vitest";
import { table } from "../../src/data/table.ts";
import { type Chart, type ChartOptions, createChart } from "../../src/dom/chart.ts";
import { custom } from "../../src/marks/custom.ts";
import { line } from "../../src/marks/line.ts";

const charts: Chart[] = [];

afterEach(() => {
  for (const chart of charts.splice(0)) {
    const host = chart.root.parentElement;
    chart.destroy();
    host?.remove();
  }
  // The shared scheduler waits for a frame it asked for; let it run.
  if (vi.isFakeTimers()) vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

function data() {
  const t = Float64Array.from({ length: 101 }, (_, i) => i * 1000);
  return table({ t, v: Float64Array.from(t, (x) => Math.sin(x / 9000) * 10 + x / 4000) });
}

/** A chart in a container of its own, at the top of the page so that it is on screen. */
async function mount(options: Partial<ChartOptions>): Promise<Chart> {
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:0;top:0;width:600px;height:300px";
  document.body.append(host);
  const chart = createChart(host, {
    animation: { duration: 300 },
    marks: [line(data(), { x: "t", y: "v" })],
    ...options,
  });
  charts.push(chart);
  // Animation code loads with the chart.
  await chart.loading;
  chart.render();
  return chart;
}

/**
 * Frames and the clock from here on are the test's: time moves only with
 * `tick`, so frames take no time and transitions never fall back for speed.
 */
async function controlTime() {
  // Frames already asked for run first, on the real clock.
  await frame();
  await frame();
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
  // Frame times measured on the real clock are forgotten.
  for (const chart of charts) {
    chart.render();
    // Asks for a frame without changing anything, so the scheduler runs one.
    chart.syncCursor(null);
  }
  tick(16);
}
const tick = (ms: number) => vi.advanceTimersByTime(ms);

const x = (chart: Chart) => [...chart.model.panels()[0]!.x.domain];
const y = (chart: Chart) => [...chart.model.panels()[0]!.y.domain];
const plot = (chart: Chart) => ({ ...chart.model.panels()[0]!.plot });
const between = (value: number, a: number, b: number) =>
  value > Math.min(a, b) && value < Math.max(a, b);

describe("view transitions", () => {
  it("move the axes to a viewport asked for, which they report at once", async () => {
    const chart = await mount({});
    await controlTime();
    const viewports: unknown[] = [];
    chart.on("viewport", ({ domain }) => viewports.push(domain));
    const [lo, hi] = x(chart) as [number, number];
    chart.setViewport([20_000, 40_000]);
    expect(chart.model.viewport).toEqual([20_000, 40_000]);
    expect(viewports).toEqual([[20_000, 40_000]]);
    tick(50);
    const [a, b] = x(chart) as [number, number];
    expect(between(a, lo, 20_000)).toBe(true);
    expect(between(b, 40_000, hi)).toBe(true);
    // Asked for again mid-way, it moves on from where it is.
    chart.setViewport([50_000, 60_000]);
    tick(20);
    expect(between(x(chart)[0]!, a, 50_000)).toBe(true);
    tick(400);
    expect(x(chart)).toEqual([50_000, 60_000]);
    expect(viewports).toHaveLength(2);
  });

  it("end at the axes and plot a chart without animation shows", async () => {
    // Values that grow by four orders of magnitude pass wide tick labels.
    const t = Float64Array.from({ length: 101 }, (_, i) => i * 1000);
    const steep = table({ t, v: Float64Array.from(t, (x) => (x < 50_000 ? x / 1000 : x * 20)) });
    const marks = () => [line(steep, { x: "t", y: "v" })];
    const moving = await mount({ marks: marks() });
    const still = await mount({ marks: marks(), animation: false });
    await controlTime();
    for (const chart of [moving, still]) chart.setViewport([0, 40_000]);
    tick(400);
    for (const chart of [moving, still]) chart.setViewport(null);
    tick(16);
    expect(x(moving)).not.toEqual(x(still));
    expect(y(moving)).not.toEqual(y(still));
    tick(400);
    expect(x(moving)).toEqual(x(still));
    expect(y(moving)).toEqual(y(still));
    expect(plot(moving)).toEqual(plot(still));
    moving.setYViewport([0, 5]);
    tick(16);
    expect(y(moving)).not.toEqual([0, 5]);
    tick(400);
    expect(y(moving)).toEqual([0, 5]);
  });

  it("show the view asked for after leaving the screen", async () => {
    const chart = await mount({ animation: { duration: 1000 } });
    await controlTime();
    chart.setViewport([20_000, 40_000]);
    tick(100);
    const host = chart.root.parentElement!;
    // Visibility arrives from an IntersectionObserver, on the real clock.
    const observed = () => new Promise((resolve) => setTimeout(resolve, 100));
    host.style.top = "-2000px";
    await observed();
    host.style.top = "0px";
    await observed();
    tick(16);
    expect(x(chart)).toEqual([20_000, 40_000]);
  });

  it("jump to the view for new data, export, gestures, and drags", async () => {
    const chart = await mount({ interaction: { zoom: true } });
    await controlTime();
    chart.setViewport([20_000, 40_000]);
    tick(16);
    expect(x(chart)).not.toEqual([20_000, 40_000]);
    // Appended rows show at once, at the view asked for.
    chart.model.config.marks[0]!.table!.append({ t: [101_000], v: [1] });
    tick(16);
    expect(x(chart)).toEqual([20_000, 40_000]);

    chart.setViewport([10_000, 30_000]);
    chart.toSVG();
    expect(x(chart)).toEqual([10_000, 30_000]);

    chart.setViewport([0, 50_000]);
    tick(16);
    const rect = chart.root.getBoundingClientRect();
    const at = { bubbles: true, clientX: rect.left + 300, clientY: rect.top + 150, pointerId: 1 };
    chart.root.dispatchEvent(new PointerEvent("pointerdown", { ...at, button: 0 }));
    expect(x(chart)).toEqual([0, 50_000]);
    chart.root.dispatchEvent(new PointerEvent("pointerup", at));

    chart.setViewport([20_000, 40_000]);
    tick(16);
    chart.root.dispatchEvent(new WheelEvent("wheel", { ...at, deltaY: -100, cancelable: true }));
    tick(16);
    // The wheel zooms from the view on screen, and shows its zoom at once.
    expect(x(chart)).toEqual([...chart.model.viewport!]);
    tick(400);
  });

  it("end when a viewport listener draws or links the chart", async () => {
    const chart = await mount({});
    await controlTime();
    const stop = chart.on("viewport", () => chart.render());
    chart.setViewport([20_000, 40_000]);
    tick(16);
    expect(x(chart)).toEqual([20_000, 40_000]);
    stop();
    const unlink = chart.on("viewport", () => chart.update({ interaction: { sync: "group" } }));
    chart.setViewport([10_000, 30_000]);
    tick(16);
    expect(x(chart)).toEqual([10_000, 30_000]);
    unlink();
  });

  it("zoom to a brush and reset by double click gradually", async () => {
    const chart = await mount({ interaction: { zoom: true, brush: "x" } });
    await controlTime();
    const [lo, hi] = x(chart) as [number, number];
    const scale = chart.model.panels()[0]!.x;
    const rect = chart.root.getBoundingClientRect();
    for (const [type, value] of [
      ["pointerdown", 30_000],
      ["pointermove", 40_000],
      ["pointerup", 50_000],
    ] as const) {
      const clientX = rect.left + scale.map(value);
      const init = { bubbles: true, clientX, clientY: rect.top + 150, pointerId: 1 };
      chart.root.dispatchEvent(new PointerEvent(type, { ...init, button: 0 }));
    }
    const [from, to] = chart.model.viewport!;
    expect(from).toBeCloseTo(30_000, -2);
    expect(to).toBeCloseTo(50_000, -2);
    tick(50);
    expect(between(x(chart)[0]!, lo, from)).toBe(true);
    tick(400);
    expect(x(chart)).toEqual([from, to]);
    chart.root.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(chart.model.viewport).toBeNull();
    tick(50);
    expect(between(x(chart)[0]!, lo, from)).toBe(true);
    tick(400);
    expect(x(chart)).toEqual([lo, hi]);
  });

  it("load their code when a chart first asks for animation", async () => {
    const chart = await mount({ animation: false });
    expect(chart.loading).toBeUndefined();
    chart.update({ animation: true });
    expect(chart.loading).toBeInstanceOf(Promise);
    await chart.loading;
    expect(chart.loading).toBeUndefined();
    await controlTime();
    chart.setViewport([20_000, 40_000]);
    tick(16);
    expect(x(chart)).not.toEqual([20_000, 40_000]);
    expect(() => chart.update({ animation: { duration: Number.NaN } })).toThrow(
      "animation.duration must be milliseconds",
    );
  });

  it("stay still where motion is reduced, charts are linked, or frames are slow", async () => {
    const linked = await mount({ interaction: { sync: "group" } });
    linked.setViewport([20_000, 40_000]);
    await frame();
    expect(x(linked)).toEqual([20_000, 40_000]);

    // A chart that takes longer to draw than a frame allows jumps.
    const busy = custom({
      draw() {
        const until = performance.now() + 12;
        while (performance.now() < until);
      },
    });
    const slow = await mount({ marks: [line(data(), { x: "t", y: "v" }), busy] });
    slow.setViewport([20_000, 40_000]);
    await frame();
    expect(x(slow)).toEqual([20_000, 40_000]);

    vi.spyOn(window, "matchMedia").mockImplementation(
      (query) => ({ matches: query.includes("reduce"), media: query }) as MediaQueryList,
    );
    const calm = await mount({});
    calm.setViewport([20_000, 40_000]);
    await frame();
    expect(x(calm)).toEqual([20_000, 40_000]);
  });
});
