import { afterEach, describe, expect, it, vi } from "vitest";
import { table } from "../../src/data/table.ts";
import { type Chart, type ChartOptions, createChart } from "../../src/dom/chart.ts";
import { ValueAnimation } from "../../src/dom/value-transition.ts";
import { area } from "../../src/marks/area.ts";
import { bar } from "../../src/marks/bar.ts";
import { custom } from "../../src/marks/custom.ts";
import { tablesOf } from "../../src/marks/layout-mark.ts";
import { line } from "../../src/marks/line.ts";
import { pie } from "../../src/marks/pie.ts";
import { point } from "../../src/marks/point.ts";
import { MOUSE, modelOf } from "./helpers.ts";

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
    chart.root.dispatchEvent(new PointerEvent("pointerleave"));
  }
  tick(16);
}
const tick = (ms: number) => vi.advanceTimersByTime(ms);

const x = (chart: Chart) => [...modelOf(chart).panels()[0]!.x.domain];
const y = (chart: Chart) => [...modelOf(chart).panels()[0]!.y.domain];
const plot = (chart: Chart) => ({ ...modelOf(chart).panels()[0]!.plot });
const between = (value: number, a: number, b: number) =>
  value > Math.min(a, b) && value < Math.max(a, b);

describe("view transitions", () => {
  it("move the axes to a viewport asked for, which they report at once", async () => {
    const chart = await mount({});
    await controlTime();
    const viewports: unknown[] = [];
    chart.on("viewport", ({ x }) => viewports.push(x));
    const [lo, hi] = x(chart) as [number, number];
    chart.setViewport([20_000, 40_000]);
    expect(chart.getViewport().x).toEqual([20_000, 40_000]);
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
    moving.setViewport({ y: [0, 5] });
    tick(16);
    expect(y(moving)).not.toEqual([0, 5]);
    tick(400);
    expect(y(moving)).toEqual([0, 5]);
  });

  it("move both axes of one change together, reported once", async () => {
    const chart = await mount({});
    await controlTime();
    const viewports: unknown[] = [];
    chart.on("viewport", (view) => viewports.push(view));
    chart.setViewport({ x: [20_000, 40_000], y: [0, 5] });
    expect(viewports).toEqual([{ x: [20_000, 40_000], y: [0, 5], yRight: null }]);
    tick(50);
    // Both axes are on their way: the y change did not end the x one.
    expect(x(chart)).not.toEqual([20_000, 40_000]);
    expect(y(chart)).not.toEqual([0, 5]);
    tick(400);
    expect([x(chart), y(chart)]).toEqual([
      [20_000, 40_000],
      [0, 5],
    ]);
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
    tablesOf(modelOf(chart).config.marks[0]!)[0]!.append({ t: [101_000], v: [1] });
    tick(16);
    expect(x(chart)).toEqual([20_000, 40_000]);

    chart.setViewport([10_000, 30_000]);
    chart.toSVG();
    expect(x(chart)).toEqual([10_000, 30_000]);

    chart.setViewport([0, 50_000]);
    tick(16);
    const rect = chart.root.getBoundingClientRect();
    const at = {
      bubbles: true,
      clientX: rect.left + 300,
      clientY: rect.top + 150,
      pointerId: MOUSE,
    };
    chart.root.dispatchEvent(new PointerEvent("pointerdown", { ...at, button: 0 }));
    expect(x(chart)).toEqual([0, 50_000]);
    chart.root.dispatchEvent(new PointerEvent("pointerup", at));

    chart.setViewport([20_000, 40_000]);
    tick(16);
    chart.root.dispatchEvent(
      new WheelEvent("wheel", {
        ctrlKey: true,
        ...at,
        deltaY: -100,
        cancelable: true,
      }),
    );
    tick(16);
    // The wheel zooms from the view on screen, and shows its zoom at once.
    expect(x(chart)).toEqual([...chart.getViewport().x!]);
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
    const scale = modelOf(chart).panels()[0]!.x;
    const rect = chart.root.getBoundingClientRect();
    for (const [type, value] of [
      ["pointerdown", 30_000],
      ["pointermove", 40_000],
      ["pointerup", 50_000],
    ] as const) {
      const clientX = rect.left + scale.map(value);
      const init = { bubbles: true, clientX, clientY: rect.top + 150, pointerId: MOUSE };
      chart.root.dispatchEvent(new PointerEvent(type, { ...init, button: 0 }));
    }
    const [from, to] = chart.getViewport().x!;
    expect(from).toBeCloseTo(30_000, -2);
    expect(to).toBeCloseTo(50_000, -2);
    tick(50);
    expect(between(x(chart)[0]!, lo, from)).toBe(true);
    tick(400);
    expect(x(chart)).toEqual([from, to]);
    chart.root.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(chart.getViewport().x).toBeNull();
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
    expect(() => chart.update({ animation: { duration: Number.NaN }, errorMode: "throw" })).toThrow(
      "chart animation.duration: expected 0 or more ms",
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

describe("value transitions", () => {
  const VALUES = { duration: 300, values: true } as const;
  const sales = () => table({ region: ["N", "S", "E"], sales: [10, 20, 30] });
  /** A bar chart whose y axis stays put while its values change. */
  const bars = (data = sales(), animation: ChartOptions["animation"] = VALUES) =>
    mount({ animation, marks: [bar(data, { x: "region", y: "sales" })], y: { domain: [0, 40] } });
  const path = (chart: Chart, kind = "rect") =>
    chart.root.querySelector(`[data-kind="${kind}"]`)?.getAttribute("d") ?? "";
  const dataOf = (chart: Chart) => tablesOf(modelOf(chart).config.marks[0]!)[0]!;
  /** Changes the sales of a bar or pie chart's table, which every one of `charts` shows. */
  const change = (charts: Chart[], values: number[]) => {
    for (const data of new Set(charts.map(dataOf))) data.setColumn("sales", values);
  };

  it("move bars to new values, ending as a chart without animation draws them", async () => {
    const data = sales();
    const moving = await bars(data);
    const still = await bars(data, false);
    await controlTime();
    const before = path(moving);
    change([moving], [30, 20, 10]);
    tick(16);
    const after = path(still);
    expect(after).not.toBe(before);
    // On its way: neither where it was nor where it goes.
    tick(50);
    expect(path(moving)).not.toBe(before);
    expect(path(moving)).not.toBe(after);
    tick(400);
    expect(path(moving)).toBe(after);
    // The model, tooltips, and summaries have the new values from the start.
    expect(chart(moving)).toEqual(chart(still));
  });

  const chart = (chart: Chart) => ({
    plot: plot(chart),
    y: y(chart),
    svg: chart.toSVG().replace(/herceg-\d+/g, ""),
  });

  it("turn pie slices to new values", async () => {
    const data = sales();
    const marks = () => [pie(data, { category: "region", value: "sales", sort: "input" })];
    const moving = await mount({ animation: VALUES, marks: marks() });
    const still = await mount({ animation: false, marks: marks() });
    await controlTime();
    const before = path(moving, "arc");
    change([moving], [30, 20, 10]);
    tick(66);
    expect(path(moving, "arc")).not.toBe(before);
    expect(path(moving, "arc")).not.toBe(path(still, "arc"));
    tick(400);
    expect(path(moving, "arc")).toBe(path(still, "arc"));
  });

  /** The left axis' tick labels on screen. */
  const yLabels = (chart: Chart) =>
    [...chart.root.querySelectorAll('text[text-anchor="end"]')].map((text) => text.textContent);
  /** The grid lines on screen, drawn with the backgrounds under the data. */
  const grid = (chart: Chart) =>
    chart.root
      .querySelector(':scope > svg > g:first-of-type > path[fill="none"]')
      ?.getAttribute("d") ?? "";

  it("move the axes with values, their ticks and grid lines between", async () => {
    const marks = (data: ReturnType<typeof sales>) => [bar(data, { x: "region", y: "sales" })];
    const data = sales();
    const moving = await mount({ animation: VALUES, marks: marks(data) });
    const still = await mount({ animation: false, marks: marks(data) });
    await controlTime();
    const before = { labels: yLabels(moving), grid: grid(moving) };
    expect(before.labels).toEqual(["0", "5", "10", "15", "20", "25", "30"]);
    change([moving], [10, 20, 45]);
    tick(16);
    // On their way: neither where they were nor where they go.
    tick(100);
    expect(yLabels(moving)).not.toEqual(before.labels);
    expect(yLabels(moving)).not.toEqual(yLabels(still));
    expect(grid(moving)).not.toBe(before.grid);
    expect(grid(moving)).not.toBe(grid(still));
    tick(400);
    expect(yLabels(moving)).toEqual(["0", "10", "20", "30", "40", "50"]);
    expect(chart(moving)).toEqual(chart(still));
  });

  it("move points and lines with their axes, ending as a chart without animation draws them", async () => {
    const data = table({ x: [1, 2, 3, 4], y: [10, 20, 30, 20] });
    const marks = () => [line(data, { x: "x", y: "y" }), point(data, { x: "x", y: "y" })];
    const moving = await mount({ animation: VALUES, marks: marks() });
    const still = await mount({ animation: false, marks: marks() });
    await controlTime();
    const before = [path(moving, "line"), path(moving, "point")];
    data.set("y", 3, 45);
    tick(66);
    const passing = [path(moving, "line"), path(moving, "point")];
    expect(passing[0]).not.toBe(before[0]);
    expect(passing[1]).not.toBe(before[1]);
    expect(passing).not.toEqual([path(still, "line"), path(still, "point")]);
    tick(400);
    expect(chart(moving)).toEqual(chart(still));
  });

  it("animate points across keyed resets in SVG and Canvas, settling before inspection", async () => {
    for (const renderer of ["svg", "canvas"] as const) {
      const data = table({ x: [1, 2, 3], y: [10, 20, 30], id: ["a", "b", "c"] });
      const marks = () => [point(data, { x: "x", y: "y", animationKey: "id" })];
      const moving = await mount({
        animation: VALUES,
        renderer,
        marks: marks(),
        x: { domain: [0, 4] },
        y: { domain: [0, 100] },
      });
      const still = await mount({
        animation: false,
        renderer,
        marks: marks(),
        x: { domain: [0, 4] },
        y: { domain: [0, 100] },
      });
      await controlTime();
      const animations: ValueAnimation[] = [];
      const start = ValueAnimation.prototype.start;
      const spy = vi.spyOn(ValueAnimation.prototype, "start").mockImplementation(function (
        this: ValueAnimation,
        ...args
      ) {
        animations.push(this);
        return start.apply(this, args);
      });
      data.reset({ x: [1, 2, 3], y: [60, 70, 50], id: ["c", "a", "d"] });
      tick(50);
      expect(animations.some((animation) => animation.playing)).toBe(true);
      moving.root.dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, clientX: 200, clientY: 100 }),
      );
      expect(animations.every((animation) => !animation.playing)).toBe(true);
      expect(chart(moving)).toEqual(chart(still));
      spy.mockRestore();
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });

  for (const stack of [true, "fill", "center", "wiggle"] as const) {
    for (const curve of ["linear", "monotone"] as const) {
      it(`move ${stack} areas stacked by a series field together, their shared edges as one (${curve})`, async () => {
        const data = table({
          t: [0, 1, 2, 0, 2, 1],
          v: [10, 20, 15, 5, 5, 8],
          s: ["a", "a", "a", "b", "b", "c"],
        });
        const marks = () => [area(data, { x: "t", y: "v", series: "s", stack, curve })];
        const moving = await mount({ animation: VALUES, marks: marks(), y: { domain: [0, 80] } });
        const still = await mount({ animation: false, marks: marks(), y: { domain: [0, 80] } });
        await controlTime();
        const layers = (chart: Chart) =>
          [...chart.root.querySelectorAll('[data-kind="area"]')].map((p) => p.getAttribute("d"));
        const before = layers(moving);
        expect(before).toHaveLength(3);
        data.set("v", 1, 40);
        tick(66);
        const passing = layers(moving);
        // Every layer from the change up moves, none where it was or where it goes.
        for (const [i, d] of passing.entries()) {
          expect(d).not.toBe(before[i]);
          expect(d).not.toBe(layers(still)[i]);
        }
        tick(400);
        expect(chart(moving)).toEqual(chart(still));
      });
    }
  }

  it("show the new values and axes before the pointer reads them", async () => {
    const data = sales();
    const moving = await mount({
      animation: VALUES,
      marks: [bar(data, { x: "region", y: "sales" })],
    });
    await controlTime();
    change([moving], [10, 20, 45]);
    tick(50);
    const passing = yLabels(moving);
    const rect = moving.root.getBoundingClientRect();
    const at = {
      bubbles: true,
      clientX: rect.left + 480,
      clientY: rect.top + 150,
      pointerId: MOUSE,
    };
    moving.root.dispatchEvent(new PointerEvent("pointermove", at));
    // Drawn at once: the axis is the new one, and the tooltip has the new value.
    expect(yLabels(moving)).not.toEqual(passing);
    expect(yLabels(moving)).toEqual(["0", "10", "20", "30", "40", "50"]);
    tick(16);
    expect(moving.root.textContent).toContain("45");
  });

  it("show appended rows, and changes that move the axes, at once", async () => {
    const data = table({ region: ["N", "S"], sales: [10, 20] });
    const appending = await bars(data);
    // An automatic domain moves with the values.
    const free = await mount({
      animation: VALUES,
      marks: [bar(sales(), { x: "region", y: "sales" })],
    });
    await controlTime();
    data.append({ region: ["E"], sales: [30] });
    change([free], [10, 20, 90]);
    const before = [path(appending), path(free)];
    tick(16);
    const shown = [path(appending), path(free)];
    expect(shown[0]).not.toBe(before[0]);
    expect(shown[1]).not.toBe(before[1]);
    tick(400);
    expect([path(appending), path(free)]).toEqual(shown);
  });

  it("show the new values before the pointer or keyboard reads them", async () => {
    const moving = await bars();
    await controlTime();
    const settled = async () => {
      tick(400);
      return path(moving);
    };
    change([moving], [30, 20, 10]);
    tick(50);
    const rect = moving.root.getBoundingClientRect();
    const at = {
      bubbles: true,
      clientX: rect.left + 300,
      clientY: rect.top + 150,
      pointerId: MOUSE,
    };
    moving.root.dispatchEvent(new PointerEvent("pointermove", at));
    tick(16);
    const destination = path(moving);
    expect(await settled()).toBe(destination);
    moving.root.dispatchEvent(new PointerEvent("pointerleave", at));
    tick(16);

    change([moving], [10, 20, 30]);
    tick(50);
    const passing = path(moving);
    moving.root.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    // Drawn at once, before the value is announced.
    expect(path(moving)).not.toBe(passing);
    expect(moving.root.textContent).toContain("10");
    expect(await settled()).toBe(path(moving));
  });

  it("show the new values when the pointer or keyboard comes before the change draws", async () => {
    const data = sales();
    const moving = await bars(data);
    const still = await bars(data, false);
    await controlTime();
    const rect = moving.root.getBoundingClientRect();
    const at = {
      bubbles: true,
      clientX: rect.left + 300,
      clientY: rect.top + 150,
      pointerId: MOUSE,
    };
    let values = [30, 20, 10];
    for (const input of ["pointermove", "pointerdown", "keydown"]) {
      change([moving], values);
      if (input === "keydown")
        moving.root.dispatchEvent(new KeyboardEvent(input, { key: "ArrowRight", bubbles: true }));
      else moving.root.dispatchEvent(new PointerEvent(input, { ...at, button: 0 }));
      tick(16);
      expect(path(moving), input).toBe(path(still));
      moving.root.dispatchEvent(new PointerEvent("pointerup", at));
      moving.root.dispatchEvent(new PointerEvent("pointerleave", at));
      moving.root.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      tick(400);
      values = values.map((value) => 40 - value);
    }
  });

  it("show changes at once after values were stopped, and during presses", async () => {
    const data = sales();
    const moving = await bars(data);
    const still = await bars(data, false);
    await controlTime();
    // Stopped half way by the pointer passing, the bars show their new
    // values at once, and the next change moves from them.
    change([moving], [30, 20, 10]);
    tick(50);
    const at = { clientX: 150, clientY: 150, pointerId: MOUSE, button: 0 };
    moving.root.dispatchEvent(new PointerEvent("pointermove", at));
    still.render();
    expect(path(moving)).toBe(path(still));
    moving.root.dispatchEvent(new PointerEvent("pointerleave", at));
    const stopped = path(moving);
    change([moving], [20, 20, 20]);
    tick(16);
    expect(path(moving)).not.toBe(stopped);
    expect(path(moving)).not.toBe(path(still));
    tick(400);
    expect(path(moving)).toBe(path(still));
    // Ended by an option change, values in between are no place to move
    // from: the next change before a scene is drawn shows at once.
    change([moving], [30, 20, 10]);
    tick(50);
    moving.update({ title: "Sales" });
    still.update({ title: "Sales" });
    change([moving], [10, 20, 30]);
    tick(16);
    expect(path(moving)).toBe(path(still));
    tick(400);
    // A touch held in place sees new data drawn at once, and so does its click.
    const touch = { ...at, pointerType: "touch" };
    moving.root.dispatchEvent(new PointerEvent("pointerdown", touch));
    change([moving], [30, 20, 10]);
    tick(50);
    let clicked: string | undefined;
    moving.on("click", () => {
      clicked = path(moving);
    });
    moving.root.dispatchEvent(new PointerEvent("pointerup", touch));
    expect(clicked).toBe(path(still));
    tick(400);
    // A click right after the pointer arrives, before the next frame, sees
    // the new values drawn.
    change([moving], [10, 20, 30]);
    tick(50);
    moving.root.dispatchEvent(new PointerEvent("pointermove", at));
    moving.root.dispatchEvent(new PointerEvent("pointerdown", at));
    moving.root.dispatchEvent(new PointerEvent("pointerup", at));
    still.render();
    expect(clicked).toBe(path(still));
  });

  it("draw values a later change or option ended part way before a click reads them", async () => {
    const data = sales();
    const moving = await bars(data);
    const still = await bars(data, false);
    await controlTime();
    const at = { clientX: 150, clientY: 150, pointerId: MOUSE, button: 0 };
    for (const end of ["data", "options"]) {
      change([moving], [30, 20, 10]);
      tick(50);
      const passing = path(moving);
      if (end === "data") change([moving], [25, 20, 15]);
      else for (const chart of [moving, still]) chart.update({ title: "Sales" });
      let clicked: string | undefined;
      const stop = moving.on("click", () => {
        clicked = path(moving);
      });
      // No frame between the change and the click.
      for (const type of ["pointermove", "pointerdown", "pointerup"])
        moving.root.dispatchEvent(new PointerEvent(type, at));
      still.render();
      expect(clicked, end).not.toBe(passing);
      expect(clicked, end).toBe(path(still));
      stop();
      moving.root.dispatchEvent(new PointerEvent("pointerleave", at));
      tick(400);
    }
  });

  it("show at once what render listeners change while input stops values", async () => {
    const data = sales();
    const moving = await bars(data);
    const still = await bars(data, false);
    await controlTime();
    const at = { clientX: 150, clientY: 150, pointerId: MOUSE, button: 0 };
    for (const input of ["pointermove", "pointerdown", "keydown"]) {
      change([moving], [30, 20, 10]);
      tick(50);
      const stop = moving.on("render", () => {
        stop();
        change([moving], [25, 20, 15]);
      });
      moving.root.dispatchEvent(
        input === "keydown"
          ? new KeyboardEvent(input, { key: "ArrowRight", bubbles: true })
          : new PointerEvent(input, at),
      );
      tick(16);
      expect(path(moving), input).toBe(path(still));
      for (const type of ["pointerup", "pointerleave"])
        moving.root.dispatchEvent(new PointerEvent(type, at));
      moving.root.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      change([moving], [10, 20, 30]);
      tick(400);
    }
  });

  it("show hidden slices go at once, whatever changes with them", async () => {
    const data = sales();
    const marks = () => [pie(data, { category: "region", value: "sales", sort: "input" })];
    const moving = await mount({ animation: VALUES, marks: marks(), legend: false });
    const still = await mount({ animation: false, marks: marks(), legend: false });
    await controlTime();
    const arcs = (chart: Chart) =>
      [...chart.root.querySelectorAll('[data-kind="arc"]')].map((arc) => arc.getAttribute("d"));
    const [first, second] = moving.getLegend().map(({ key }) => key);
    // Hidden, then changed in the same frame.
    for (const chart of [moving, still]) chart.setVisibility(first!, false);
    change([moving], [10, 30, 20]);
    tick(16);
    expect(arcs(moving)).toEqual(arcs(still));
    tick(400);
    // Changed, then hidden in the same frame.
    change([moving], [10, 20, 30]);
    for (const chart of [moving, still]) chart.setVisibility(second!, false);
    tick(16);
    expect(arcs(moving)).toEqual(arcs(still));
  });

  it("show changes at once while inspected, in export, after render, and while frequent", async () => {
    const data = sales();
    const moving = await bars(data);
    const still = await bars(data, false);
    await controlTime();
    // Under the pointer, the bars show what the tooltip reads.
    const rect = moving.root.getBoundingClientRect();
    const at = {
      bubbles: true,
      clientX: rect.left + 300,
      clientY: rect.top + 150,
      pointerId: MOUSE,
    };
    moving.root.dispatchEvent(new PointerEvent("pointermove", at));
    change([moving], [30, 20, 10]);
    tick(16);
    expect(path(moving)).toBe(path(still));
    moving.root.dispatchEvent(new PointerEvent("pointerleave", at));
    tick(400);

    // Export shows the new values, as a chart without animation does, and
    // so does the chart from then on.
    change([moving], [10, 20, 30]);
    tick(50);
    const exported = moving.toSVG().replace(/herceg-\d+/g, "");
    expect(exported).toBe(still.toSVG().replace(/herceg-\d+/g, ""));
    expect(path(moving)).toBe(path(still));
    tick(400);

    change([moving], [30, 20, 10]);
    moving.render();
    still.render();
    expect(path(moving)).toBe(path(still));
    tick(400);

    // A change while values move ends the motion, and changes soon after show at once.
    change([moving], [10, 20, 30]);
    tick(50);
    change([moving], [30, 20, 10]);
    tick(16);
    expect(path(moving)).toBe(path(still));
    tick(100);
    change([moving], [20, 20, 20]);
    tick(16);
    expect(path(moving)).toBe(path(still));
    // Once the data is still for a while, changes move again.
    tick(400);
    change([moving], [10, 20, 30]);
    tick(50);
    expect(path(moving)).not.toBe(path(still));
  });

  it("leave values alone with `animation: true`, and load their code only when asked", async () => {
    const viewOnly = await bars(sales(), true);
    await controlTime();
    change([viewOnly], [30, 20, 10]);
    tick(16);
    const shown = path(viewOnly);
    tick(400);
    expect(path(viewOnly)).toBe(shown);
    viewOnly.update({ animation: VALUES });
    expect(viewOnly.loading).toBeInstanceOf(Promise);
  });

  it("show changes at once where motion is reduced", async () => {
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query) => ({ matches: query.includes("reduce"), media: query }) as MediaQueryList,
    );
    const calm = await bars();
    // Nor do axes.
    const free = await mount({
      animation: VALUES,
      marks: [bar(sales(), { x: "region", y: "sales" })],
    });
    await controlTime();
    change([calm, free], [30, 20, 45]);
    tick(16);
    const shown = [path(calm), yLabels(free)];
    tick(400);
    expect([path(calm), yLabels(free)]).toEqual(shown);
  });

  it("let go of what they move when the chart is destroyed", async () => {
    const moving = await bars();
    await controlTime();
    const animations: ValueAnimation[] = [];
    const start = ValueAnimation.prototype.start;
    vi.spyOn(ValueAnimation.prototype, "start").mockImplementation(function (
      this: ValueAnimation,
      ...args
    ) {
      animations.push(this);
      return start.apply(this, args);
    });
    change([moving], [30, 20, 10]);
    tick(50);
    expect(animations[0]?.playing).toBe(true);
    moving.destroy();
    expect(animations[0]?.playing).toBe(false);
    expect(() => tick(400)).not.toThrow();
  });
});
