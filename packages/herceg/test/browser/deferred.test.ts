// Input that arrives before a chart's interaction controller has loaded: the
// chart keeps it and the controller plays it once attached. This file does
// not import helpers.ts, whose import loads the controller first.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MOUSE } from "../../../../scripts/browser/mouse.ts";
import { table } from "../../src/data/table.ts";
import { type Chart, createChart, forgetInteraction } from "../../src/dom/chart.ts";
import { line } from "../../src/marks/line.ts";
import { point3d } from "../../src/marks/point3d.ts";
import type { ChartError } from "../../src/spec/errors.ts";

let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  host.style.cssText = "width:600px;height:300px";
  document.body.append(host);
  forgetInteraction();
});

afterEach(() => {
  host.remove();
  forgetInteraction();
});

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const data = () => table({ t: [0, 1, 2, 3, 4], v: [10, 20, 30, 40, 50] });

function pointer(chart: Chart, type: string, x: number, y: number, init: PointerEventInit = {}) {
  const rect = chart.root.getBoundingClientRect();
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: rect.left + x,
    clientY: rect.top + y,
    pointerId: MOUSE,
    ...init,
  });
  chart.root.dispatchEvent(event);
  return event;
}

const tooltipOf = (chart: Chart) =>
  [...chart.root.children].find(
    (el) => el.tagName === "DIV" && (el as HTMLElement).style.pointerEvents === "none",
  ) as HTMLElement | undefined;

describe("the interaction controller", () => {
  it("loads after the first frame, which draws without it", async () => {
    const chart = createChart(host, { marks: [line(data(), { x: "t", y: "v" })] });
    expect(chart.root.querySelectorAll("svg g[clip-path] path")).toHaveLength(1);
    expect(tooltipOf(chart)).toBeUndefined();
    const loading = chart.loading;
    expect(loading).toBeInstanceOf(Promise);
    await loading;
    expect(chart.loading).toBeUndefined();
    expect(tooltipOf(chart)).toBeDefined();
    chart.destroy();
  });

  it("attaches at once in charts mounted after one loaded it", async () => {
    const first = createChart(host, { marks: [line(data(), { x: "t", y: "v" })] });
    await first.loading;
    first.destroy();
    const chart = createChart(host, { marks: [line(data(), { x: "t", y: "v" })] });
    expect(chart.loading).toBeUndefined();
    expect(tooltipOf(chart)).toBeDefined();
    chart.destroy();
  });

  it("shows the tooltip where the pointer stopped while it loaded", async () => {
    const chart = createChart(host, { marks: [line(data(), { x: "t", y: "v" })] });
    pointer(chart, "pointermove", 100, 150);
    pointer(chart, "pointermove", 300, 150);
    await chart.loading;
    await frame();
    const tooltip = tooltipOf(chart)!;
    expect(tooltip.style.display).toBe("block");
    expect(tooltip.textContent).toContain("30");
    chart.destroy();
  });

  it("shows nothing for a pointer that left before it loaded", async () => {
    const hovers: unknown[] = [];
    const chart = createChart(host, { marks: [line(data(), { x: "t", y: "v" })] });
    chart.on("hover", ({ inspection }) => hovers.push(inspection));
    pointer(chart, "pointermove", 300, 150);
    pointer(chart, "pointerleave", 0, 0);
    await chart.loading;
    await frame();
    expect(tooltipOf(chart)!.style.display).not.toBe("block");
    expect(hovers.filter(Boolean)).toHaveLength(0);
    chart.destroy();
  });

  it("reads keys pressed while it loaded, in order", async () => {
    const chart = createChart(host, { marks: [line(data(), { x: "t", y: "v" })] });
    chart.root.focus();
    const keys = ["End", "ArrowLeft"].map((key) => {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      chart.root.dispatchEvent(event);
      return event;
    });
    // The page does not scroll for keys the chart will read.
    expect(keys.every((event) => event.defaultPrevented)).toBe(true);
    const live = chart.root.querySelector("[aria-live]")!;
    expect(live.textContent).toBe("");
    await chart.loading;
    expect(live.textContent).toContain("v: 40");
    chart.destroy();
  });

  it("leaves keys the chart does not read to the page", () => {
    const chart = createChart(host, { marks: [line(data(), { x: "t", y: "v" })] });
    const event = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true });
    chart.root.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    chart.destroy();
  });

  it("zooms by a wheel step taken while it loaded", async () => {
    const chart = createChart(host, {
      interaction: { zoom: true },
      marks: [line(data(), { x: "t", y: "v" })],
    });
    const rect = chart.root.getBoundingClientRect();
    const wheel = new WheelEvent("wheel", {
      ctrlKey: true,
      deltaY: -200,
      clientX: rect.left + 300,
      clientY: rect.top + 150,
      bubbles: true,
      cancelable: true,
    });
    chart.root.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
    expect(chart.getViewport().x).toBeNull();
    await chart.loading;
    expect(chart.getViewport().x).not.toBeNull();
    chart.destroy();
  });

  it("plays a drag pressed, moved, and released while it loaded", async () => {
    const brushed = createChart(host, {
      interaction: { brush: "x" },
      marks: [line(data(), { x: "t", y: "v" })],
    });
    pointer(brushed, "pointerdown", 150, 150, { button: 0 });
    pointer(brushed, "pointermove", 250, 150);
    pointer(brushed, "pointermove", 400, 150);
    pointer(brushed, "pointerup", 400, 150, { button: 0 });
    expect(brushed.selection).toBeNull();
    await brushed.loading;
    const x = brushed.selection?.x;
    expect(x).toBeDefined();
    expect(x![0]).toBeLessThan(x![1]);
    brushed.destroy();
  });

  it("does nothing once destroyed while it loaded", async () => {
    const chart = createChart(host, { marks: [line(data(), { x: "t", y: "v" })] });
    pointer(chart, "pointermove", 300, 150);
    const loading = chart.loading;
    chart.destroy();
    await loading;
    expect(host.children).toHaveLength(0);
  });

  it("plays a wheel step a binding of the chart's own takes, leaving it to the page meanwhile", async () => {
    const chart = createChart(host, {
      interaction: {
        bindings: [{ gesture: { type: "wheel", axis: "y" }, action: { type: "zoom" } }],
      },
      marks: [line(data(), { x: "t", y: "v" })],
    });
    const rect = chart.root.getBoundingClientRect();
    const wheel = new WheelEvent("wheel", {
      deltaY: -200,
      clientX: rect.left + 300,
      clientY: rect.top + 150,
      bubbles: true,
      cancelable: true,
    });
    chart.root.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
    await chart.loading;
    expect(chart.getViewport().x).not.toBeNull();
    chart.destroy();
  });

  it("is loading until what attaching starts to load has loaded", async () => {
    const chart = createChart(host, {
      tooltip: { axisLabels: true },
      marks: [line(data(), { x: "t", y: "v" })],
    });
    await chart.loading;
    expect(chart.loading).toBeUndefined();
    chart.destroy();
  });

  it("drops presses on a layout mark's panels, whose controls were not there to take them", async () => {
    const chart = createChart(host, {
      marks: [
        point3d(table({ x: [0, 1, 2], y: [0, 1, 2], z: [0, 1, 2] }), { x: "x", y: "y", z: "z" }),
      ],
    });
    const clicks: unknown[] = [];
    chart.on("click", (event) => clicks.push(event));
    const camera = chart.getCamera();
    pointer(chart, "pointerdown", 300, 150, { button: 0 });
    pointer(chart, "pointermove", 340, 150);
    pointer(chart, "pointerup", 340, 150, { button: 0 });
    await chart.loading;
    expect(clicks).toEqual([]);
    expect(chart.getCamera()).toEqual(camera);
    chart.destroy();
  });

  it("reports bindings it refuses, and leaves the chart without input, as loaded or not", async () => {
    const reported: unknown[] = [];
    const twice = { gesture: { type: "pinch" }, action: { type: "zoom" } } as const;
    const options = {
      interaction: { bindings: [twice, twice] },
      marks: [line(data(), { x: "t", y: "v" })],
      onError: (error: unknown) => reported.push(error),
    };
    const cold = createChart(host, options);
    pointer(cold, "pointermove", 300, 150);
    await expect(cold.loading).rejects.toThrow("duplicates binding 0");
    expect(tooltipOf(cold)).toBeUndefined();
    // The chart says so in its place, as of options it refuses.
    expect(cold.root.querySelector('[role="alert"]')?.textContent).toContain(
      "duplicates binding 0",
    );
    cold.destroy();
    // Another chart loads the controller; this one attaches it at once, and fails alike.
    const other = createChart(host, { marks: [line(data(), { x: "t", y: "v" })] });
    await other.loading;
    const cached = createChart(host, options);
    await expect(cached.loading).rejects.toThrow("duplicates binding 0");
    expect(tooltipOf(cached)).toBeUndefined();
    expect(reported).toHaveLength(2);
    cached.destroy();
    other.destroy();
  });

  it("tells no one of code that fails to load once the chart is destroyed", async () => {
    let fail = (_: Error) => {};
    forgetInteraction(() => new Promise((_, reject) => (fail = reject)));
    const errors: ChartError[] = [];
    const chart = createChart(host, {
      marks: [line(data(), { x: "t", y: "v" })],
      onError: (error) => errors.push(error),
    });
    const loading = chart.loading!;
    loading.catch(() => {});
    // The controller loads after the first frame is on screen.
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve)));
    chart.destroy();
    fail(new Error("offline"));
    await expect(loading).rejects.toThrow("offline");
    expect(errors).toEqual([]);
  });

  it("rejects loading when it cannot load, and takes no more input", async () => {
    forgetInteraction(() => Promise.reject(new Error("offline")));
    const errors: ChartError[] = [];
    const chart = createChart(host, {
      marks: [line(data(), { x: "t", y: "v" })],
      onError: (error) => errors.push(error),
    });
    await expect(chart.loading).rejects.toThrow("offline");
    // Reported as code that failed to load; the chart, drawn, stays in sight.
    expect(errors.map((e) => [e.code, e.phase])).toEqual([["load-failed", "load"]]);
    expect(chart.root.querySelector('[role="alert"]')).toBeNull();
    chart.root.focus();
    const key = new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true });
    chart.root.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(false);
    // It still draws and answers.
    expect(chart.inspect(300, 150)?.points[0]?.value).toBe(30);
    chart.destroy();
  });
});
