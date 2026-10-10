// Range navigators in the browser: the sliders over the strip, dragging,
// keys, staying in step with other changes of view, streaming, and removal.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cdp } from "vitest/browser";
import { time } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { type Chart, type ChartOptions, createChart } from "../../src/dom/chart.ts";
import { line } from "../../src/marks/line.ts";
import { facet } from "../../src/model/facet.ts";
import { rangeNavigator } from "../../src/model/navigator.ts";
import { timeBreaks } from "../../src/scale/breaks.ts";
import { accessibilityTree as treeUnder } from "./helpers.ts";

let host: HTMLDivElement;
const charts: Chart[] = [];

beforeEach(() => {
  host = document.createElement("div");
  host.style.cssText = "width:600px;height:320px";
  document.body.append(host);
});

afterEach(() => {
  for (const chart of charts.splice(0)) chart.destroy();
  host.remove();
});

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

function waves(n: number) {
  return table({
    t: Float64Array.from({ length: n }, (_, i) => i),
    v: Float64Array.from({ length: n }, (_, i) => Math.sin(i / 20) * 10),
  });
}

async function mount(options: Partial<ChartOptions> = {}, into = host): Promise<Chart> {
  const chart = createChart(into, {
    marks: [line(waves(1001), { x: "t", y: "v" })],
    navigator: rangeNavigator(),
    locale: "en-US",
    ...options,
  });
  charts.push(chart);
  await chart.loading;
  return chart;
}

const group = (chart: Chart) =>
  chart.root.querySelector<HTMLElement>('[role="group"][aria-label="Range navigator"]')!;
const sliders = (chart: Chart) => [
  ...group(chart).querySelectorAll<HTMLElement>('[role="slider"]'),
];

/** The strip's box in the chart, as its group covers it. */
function stripBox(chart: Chart) {
  const { left, top, width, height } = group(chart).style;
  return {
    x: Number.parseFloat(left),
    y: Number.parseFloat(top),
    width: Number.parseFloat(width),
    height: Number.parseFloat(height),
  };
}

/** A pointer event at (x, y) of the chart's root, sent to `target`. */
function pointer(chart: Chart, target: Element, type: string, x: number, y: number) {
  const rect = chart.root.getBoundingClientRect();
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      button: 0,
      pointerId: 1,
      isPrimary: true,
      clientX: rect.left + x,
      clientY: rect.top + y,
    }),
  );
}

/** Drags from `from` to `to` (x pixels of the chart) over `target`, in steps. */
function drag(chart: Chart, target: Element, from: number, to: number) {
  const y = stripBox(chart).y + stripBox(chart).height / 2;
  pointer(chart, target, "pointerdown", from, y);
  pointer(chart, target, "pointermove", (from + to) / 2, y);
  pointer(chart, target, "pointermove", to, y);
  pointer(chart, target, "pointerup", to, y);
}

/**
 * Real mouse input at (x, y) of the chart's root, through the browser: hit
 * testing, focus, pointer capture, and double clicks as a user's would.
 */
async function mouse(
  chart: Chart,
  type: "mousePressed" | "mouseMoved" | "mouseReleased",
  x: number,
  y: number,
  clickCount = 1,
) {
  const rect = chart.root.getBoundingClientRect();
  const frame = window.frameElement?.getBoundingClientRect() ?? { left: 0, top: 0 };
  await cdp().send("Input.dispatchMouseEvent", {
    type,
    x: frame.left + rect.left + x,
    y: frame.top + rect.top + y,
    button: "left",
    buttons: type === "mouseReleased" ? 0 : 1,
    clickCount,
  });
}

/** Real touches at x pixels of the chart's root, along the strip's middle. */
async function touch(
  chart: Chart,
  type: "touchStart" | "touchMove" | "touchEnd",
  fingers: Record<number, number>,
) {
  const rect = chart.root.getBoundingClientRect();
  const frame = window.frameElement?.getBoundingClientRect() ?? { left: 0, top: 0 };
  const strip = stripBox(chart);
  const y = frame.top + rect.top + strip.y + strip.height / 2;
  await cdp().send("Input.dispatchTouchEvent", {
    type,
    touchPoints: Object.entries(fingers).map(([id, x]) => ({
      id: Number(id),
      x: frame.left + rect.left + x,
      y,
      radiusX: 1,
      radiusY: 1,
      force: 1,
    })),
  });
}

function key(target: Element, name: string, shiftKey = false) {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: name, shiftKey, bubbles: true }));
}

/** Pixels of the strip per unit of x, for a strip over 0 to 1000. */
const perUnit = (chart: Chart) => stripBox(chart).width / 1000;

describe("a navigator's sliders", () => {
  it("cover the strip: the window and an edge on either side of it", async () => {
    const chart = await mount();
    const strip = stripBox(chart);
    const plot = chart.getPanels()[0]!.plot;
    expect(strip.x).toBe(plot.x);
    expect(strip.width).toBe(plot.width);
    expect(strip.y).toBeGreaterThan(plot.y + plot.height);
    const [start, middle, end] = sliders(chart);
    expect(start!.getAttribute("aria-label")).toBe("Start of the shown range");
    expect(middle!.getAttribute("aria-label")).toBe("Shown range");
    expect(end!.getAttribute("aria-label")).toBe("End of the shown range");
    // The window takes what the edges' reach into it leaves.
    expect(middle!.style.left).toBe("4px");
    expect(Number.parseFloat(middle!.style.width)).toBeCloseTo(strip.width - 8, 0);
    expect(start!.getAttribute("aria-valuenow")).toBe("0");
    expect(end!.getAttribute("aria-valuenow")).toBe("1000");
    expect(middle!.getAttribute("aria-valuetext")).toBe("0 to 1,000");
  });

  it("pan when the window is dragged, keeping y and its width", async () => {
    const chart = await mount({ interaction: { zoom: "xy" } });
    chart.setViewport({ x: [100, 300], y: [-5, 5] });
    await frame();
    const views: unknown[] = [];
    chart.on("viewport", (view) => views.push(view));
    const strip = stripBox(chart);
    const at = (value: number) => strip.x + value * perUnit(chart);
    drag(chart, sliders(chart)[1]!, at(200), at(400));
    const { x, y } = chart.getViewport();
    expect(x![0]).toBeCloseTo(300, 0);
    expect(x![1]).toBeCloseTo(500, 0);
    expect(y).toEqual([-5, 5]);
    expect(views).toHaveLength(2);
    // The window shows where it went.
    await frame();
    expect(Number(sliders(chart)[0]!.getAttribute("aria-valuenow"))).toBeCloseTo(300, 0);
  });

  it("stop the window at the ends of the strip", async () => {
    const chart = await mount();
    chart.setViewport([100, 300]);
    await frame();
    const strip = stripBox(chart);
    const at = (value: number) => strip.x + value * perUnit(chart);
    drag(chart, sliders(chart)[1]!, at(200), at(2000));
    const [x0, x1] = chart.getViewport().x!;
    expect(x1).toBeCloseTo(1000, 0);
    expect(x1 - x0).toBeCloseTo(200, 0);
  });

  it("zoom when an edge is dragged, never past the other", async () => {
    const chart = await mount();
    chart.setViewport([100, 300]);
    await frame();
    const strip = stripBox(chart);
    const at = (value: number) => strip.x + value * perUnit(chart);
    drag(chart, sliders(chart)[0]!, at(100), at(50));
    expect(chart.getViewport().x![0]).toBeCloseTo(50, 0);
    expect(chart.getViewport().x![1]).toBe(300);
    await frame();
    drag(chart, sliders(chart)[2]!, at(300), at(0));
    const [x0, x1] = chart.getViewport().x!;
    expect(x0).toBeCloseTo(50, 0);
    // The end stops a few pixels past the start.
    expect((x1 - x0) * perUnit(chart)).toBeCloseTo(3, 0);
  });

  it("show the range dragged over elsewhere, and nothing for a click", async () => {
    const chart = await mount();
    chart.setViewport([100, 200]);
    await frame();
    const strip = stripBox(chart);
    const at = (value: number) => strip.x + value * perUnit(chart);
    const y = strip.y + strip.height / 2;
    pointer(chart, group(chart), "pointerdown", at(600), y);
    pointer(chart, group(chart), "pointerup", at(600), y);
    expect(chart.getViewport().x).toEqual([100, 200]);
    drag(chart, group(chart), at(800), at(600));
    const [x0, x1] = chart.getViewport().x!;
    expect(x0).toBeCloseTo(600, 0);
    expect(x1).toBeCloseTo(800, 0);
  });

  it("show all of x on a double click, leaving y and the plot's own double click alone", async () => {
    const chart = await mount({ interaction: { zoom: "xy" } });
    chart.setViewport({ x: [100, 200], y: [-2, 2] });
    await frame();
    group(chart).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(chart.getViewport()).toEqual({ x: null, y: [-2, 2], yRight: null });
  });

  it("keep the wheel to the page", async () => {
    const chart = await mount({ interaction: { zoom: true } });
    const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100 });
    group(chart).dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(chart.getViewport().x).toBeNull();
  });

  it("move with the keys: edges themselves, the window panning or, with Shift, resizing", async () => {
    const chart = await mount();
    chart.setViewport([400, 600]);
    await frame();
    const [start, middle, end] = sliders(chart);
    const step = 1000 * 0.01;
    key(start!, "ArrowLeft");
    expect(chart.getViewport().x![0]).toBeCloseTo(400 - step, 0);
    key(end!, "ArrowRight");
    expect(chart.getViewport().x![1]).toBeCloseTo(600 + step, 0);
    key(middle!, "PageUp");
    expect(chart.getViewport().x![0]).toBeCloseTo(490, 0);
    expect(chart.getViewport().x![1]).toBeCloseTo(710, 0);
    key(middle!, "ArrowRight", true);
    expect(chart.getViewport().x![0]).toBeCloseTo(485, 0);
    expect(chart.getViewport().x![1]).toBeCloseTo(715, 0);
    key(middle!, "End");
    expect(chart.getViewport().x![1]).toBeCloseTo(1000, 0);
    key(start!, "Home");
    expect(chart.getViewport().x![0]).toBeCloseTo(0, 0);
    // Escape shows everything, and then has nothing to do.
    const reset = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    middle!.dispatchEvent(reset);
    expect(reset.defaultPrevented).toBe(true);
    expect(chart.getViewport().x).toBeNull();
    const again = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    middle!.dispatchEvent(again);
    expect(again.defaultPrevented).toBe(false);
  });

  it("announce where the window is once a drag ends, politely", async () => {
    const chart = await mount();
    chart.setViewport([100, 300]);
    await frame();
    const strip = stripBox(chart);
    const at = (value: number) => strip.x + value * perUnit(chart);
    drag(chart, sliders(chart)[1]!, at(200), at(300));
    const live = group(chart).querySelector('[aria-live="polite"]')!;
    await frame();
    expect(live.textContent).toMatch(/^Showing 200(\.\d+)? to 400(\.\d+)?\.$/);
  });

  it("follow the wheel, setViewport, and synced charts", async () => {
    const other = document.createElement("div");
    other.style.cssText = "width:600px;height:320px";
    document.body.append(other);
    try {
      const a = await mount({ interaction: { zoom: true, sync: "nav" } });
      const b = await mount({ interaction: { zoom: true, sync: "nav" } }, other);
      a.setViewport([200, 400]);
      await frame();
      expect(sliders(b)[0]!.getAttribute("aria-valuenow")).toBe("200");
      expect(sliders(b)[2]!.getAttribute("aria-valuenow")).toBe("400");
      // A drag in one moves the other.
      const strip = stripBox(b);
      const at = (value: number) => strip.x + value * perUnit(b);
      drag(b, sliders(b)[1]!, at(300), at(400));
      expect(a.getViewport().x![0]).toBeCloseTo(300, 0);
      const plot = a.getPanels()[0]!.plot;
      const rect = a.root.getBoundingClientRect();
      a.root.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaY: 200,
          clientX: rect.left + plot.x + plot.width / 2,
          clientY: rect.top + plot.y + plot.height / 2,
        }),
      );
      await frame();
      const [x0, x1] = a.getViewport().x!;
      expect(Number(sliders(a)[0]!.getAttribute("aria-valuenow"))).toBeCloseTo(x0, 6);
      expect(Number(sliders(a)[2]!.getAttribute("aria-valuenow"))).toBeCloseTo(x1, 6);
    } finally {
      other.remove();
    }
  });

  it("let go of a drag when something else changes the view", async () => {
    const chart = await mount();
    chart.setViewport([100, 300]);
    await frame();
    const strip = stripBox(chart);
    const at = (value: number) => strip.x + value * perUnit(chart);
    const y = strip.y + strip.height / 2;
    const target = sliders(chart)[1]!;
    pointer(chart, target, "pointerdown", at(200), y);
    pointer(chart, target, "pointermove", at(250), y);
    chart.setViewport([700, 800]);
    pointer(chart, target, "pointermove", at(300), y);
    pointer(chart, target, "pointerup", at(300), y);
    expect(chart.getViewport().x).toEqual([700, 800]);
  });

  it("let go of a drag when a viewport listener moves the view, and leave it there", async () => {
    const chart = await mount();
    chart.setViewport([100, 300]);
    await frame();
    const strip = stripBox(chart);
    const at = (value: number) => strip.x + value * perUnit(chart);
    const y = strip.y + strip.height / 2;
    const target = sliders(chart)[1]!;
    const stop = chart.on("viewport", () => {
      stop();
      chart.setViewport([700, 800]);
    });
    pointer(chart, target, "pointerdown", at(200), y);
    pointer(chart, target, "pointermove", at(250), y);
    pointer(chart, target, "pointermove", at(300), y);
    expect(chart.getViewport().x).toEqual([700, 800]);
    pointer(chart, target, "pointerup", at(300), y);
    expect(chart.getViewport().x).toEqual([700, 800]);
  });

  it("take a drag back with Escape, unless the view changed since", async () => {
    const chart = await mount();
    chart.setViewport([100, 300]);
    await frame();
    const strip = stripBox(chart);
    const at = (value: number) => strip.x + value * perUnit(chart);
    const y = strip.y + strip.height / 2;
    const target = sliders(chart)[1]!;
    pointer(chart, target, "pointerdown", at(200), y);
    pointer(chart, target, "pointermove", at(300), y);
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(chart.getViewport().x).toEqual([100, 300]);
    pointer(chart, target, "pointerdown", at(200), y);
    pointer(chart, target, "pointermove", at(300), y);
    chart.setViewport([500, 600]);
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(chart.getViewport().x).toEqual([500, 600]);
  });

  it("end a drag where the pointer is released", async () => {
    const chart = await mount();
    chart.setViewport([100, 300]);
    await frame();
    const strip = stripBox(chart);
    const at = (value: number) => strip.x + value * perUnit(chart);
    const y = strip.y + strip.height / 2;
    const target = sliders(chart)[1]!;
    pointer(chart, target, "pointerdown", at(200), y);
    pointer(chart, target, "pointermove", at(250), y);
    pointer(chart, target, "pointerup", at(300), y);
    const [x0, x1] = chart.getViewport().x!;
    expect(x0).toBeCloseTo(200, 0);
    expect(x1).toBeCloseTo(400, 0);
  });

  it("keep a selection inside the strip, a few pixels wide, past either end", async () => {
    const chart = await mount();
    const strip = stripBox(chart);
    const y = strip.y + strip.height / 2;
    const right = strip.x + strip.width;
    pointer(chart, group(chart), "pointerdown", right - 1, y);
    pointer(chart, group(chart), "pointermove", right + 10, y);
    pointer(chart, group(chart), "pointerup", right + 10, y);
    const [x0, x1] = chart.getViewport().x!;
    expect(x1).toBeCloseTo(1000, 6);
    expect((x1 - x0) * perUnit(chart)).toBeCloseTo(3, 0);
    pointer(chart, group(chart), "pointerdown", strip.x + 1, y);
    pointer(chart, group(chart), "pointermove", strip.x - 10, y);
    pointer(chart, group(chart), "pointerup", strip.x - 10, y);
    const [y0, y1] = chart.getViewport().x!;
    expect(y0).toBeCloseTo(0, 6);
    expect((y1 - y0) * perUnit(chart)).toBeCloseTo(3, 0);
  });

  it("move values with the keys on a reversed axis, as their bounds say", async () => {
    const chart = await mount({ x: { domain: [1000, 0] } });
    chart.setViewport([200, 400]);
    await frame();
    const [left, middle, right] = sliders(chart);
    // The left edge holds the end, the larger value.
    expect(left!.getAttribute("aria-label")).toBe("End of the shown range");
    expect(right!.getAttribute("aria-valuenow")).toBe("200");
    key(middle!, "Home");
    expect(chart.getViewport().x![0]).toBeCloseTo(0, 6);
    key(middle!, "End");
    expect(chart.getViewport().x![1]).toBeCloseTo(1000, 6);
    expect(chart.getViewport().x![0]).toBeCloseTo(800, 6);
    // Up on the end edge makes the end larger, which moves it left.
    key(left!, "ArrowLeft");
    expect(chart.getViewport().x![1]).toBeCloseTo(990, 6);
    key(left!, "ArrowUp");
    expect(chart.getViewport().x![1]).toBeCloseTo(1000, 6);
    key(right!, "Home");
    expect(chart.getViewport().x![0]).toBeCloseTo(0, 6);
    await frame();
    expect(Number(right!.getAttribute("aria-valuenow"))).toBe(
      Number(right!.getAttribute("aria-valuemin")),
    );
  });

  for (const reversed of [false, true]) {
    it(`take each slider to its bounds with Home and End${reversed ? " on a reversed axis" : ""}`, async () => {
      const chart = await mount(reversed ? { x: { domain: [1000, 0] } } : {});
      for (const part of [0, 1, 2]) {
        chart.setViewport([200, 400]);
        chart.render();
        const slider = sliders(chart)[part]!;
        for (const [name, bound] of [
          ["Home", "aria-valuemin"],
          ["End", "aria-valuemax"],
        ] as const) {
          const expected = Number(slider.getAttribute(bound));
          key(slider, name);
          await frame();
          expect(Number(slider.getAttribute("aria-valuenow"))).toBeCloseTo(expected, 9);
          chart.setViewport([200, 400]);
          chart.render();
        }
      }
    });
  }

  it("never cross the edges or turn a window inside out with the keys", async () => {
    for (const domain of [undefined, [1000, 0] as const]) {
      const chart = await mount(domain ? { x: { domain } } : {});
      chart.setViewport([200, 400]);
      chart.render();
      const [, middle] = sliders(chart);
      const start = sliders(chart).find(
        (slider) => slider.getAttribute("aria-label") === "Start of the shown range",
      )!;
      key(start, "End");
      for (let k = 0; k < 5; k++) key(start, "ArrowRight");
      const [x0, x1] = chart.getViewport().x!;
      expect(x1).toBe(400);
      expect(x0).toBeLessThan(400);
      // Narrowing stops at a few pixels, or as narrow as the window was,
      // about its middle.
      chart.setViewport([200, 201]);
      chart.render();
      key(middle!, "ArrowLeft", true);
      key(middle!, "ArrowLeft", true);
      const [y0, y1] = chart.getViewport().x!;
      expect(y1 - y0).toBeCloseTo(1, 6);
      expect((y0 + y1) / 2).toBeCloseTo(200.5, 6);
      chart.setViewport([200, 300]);
      chart.render();
      for (let k = 0; k < 20; k++) key(middle!, "ArrowDown", true);
      const [z0, z1] = chart.getViewport().x!;
      expect((z1 - z0) * perUnit(chart)).toBeCloseTo(3, 1);
      expect((z0 + z1) / 2).toBeCloseTo(250, 6);
      chart.destroy();
      charts.splice(charts.indexOf(chart), 1);
    }
  });

  it("move from the view asked for while an animation plays", async () => {
    const chart = await mount({ animation: { duration: 1000 } });
    await frame();
    chart.setViewport([600, 800]);
    await frame();
    key(sliders(chart)[1]!, "ArrowLeft");
    const [x0, x1] = chart.getViewport().x!;
    expect(x0).toBeCloseTo(590, 6);
    expect(x1).toBeCloseTo(790, 6);
  });

  it("pan a narrow window by its middle, with a real mouse", async () => {
    const chart = await mount();
    chart.setViewport([200, 201]);
    chart.render();
    const strip = stripBox(chart);
    const at = (value: number) => strip.x + value * perUnit(chart);
    const y = strip.y + strip.height / 2;
    await mouse(chart, "mousePressed", at(200.5), y);
    await mouse(chart, "mouseMoved", at(250.5), y);
    await mouse(chart, "mouseMoved", at(300.5), y);
    await mouse(chart, "mouseReleased", at(300.5), y);
    const [x0, x1] = chart.getViewport().x!;
    expect(x0).toBeCloseTo(300, 0);
    expect(x1 - x0).toBeCloseTo(1, 6);
  });

  it("take a selection back with Escape, the window holding the focus", async () => {
    const chart = await mount();
    chart.setViewport([100, 200]);
    chart.render();
    const strip = stripBox(chart);
    const at = (value: number) => strip.x + value * perUnit(chart);
    const y = strip.y + strip.height / 2;
    await mouse(chart, "mousePressed", at(600), y);
    await mouse(chart, "mouseMoved", at(700), y);
    expect(chart.getViewport().x![0]).toBeCloseTo(600, 0);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Shown range");
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await mouse(chart, "mouseMoved", at(800), y);
    await mouse(chart, "mouseReleased", at(800), y);
    expect(chart.getViewport().x).toEqual([100, 200]);
  });

  it("show all of x on a real double click", async () => {
    const chart = await mount();
    chart.setViewport([100, 200]);
    chart.render();
    const strip = stripBox(chart);
    const at = (value: number) => strip.x + value * perUnit(chart);
    const y = strip.y + strip.height / 2;
    await mouse(chart, "mousePressed", at(500), y);
    await mouse(chart, "mouseReleased", at(500), y);
    await mouse(chart, "mousePressed", at(500), y, 2);
    await mouse(chart, "mouseReleased", at(500), y, 2);
    expect(chart.getViewport().x).toBeNull();
  });

  it("let go of a drag when the strip goes", async () => {
    const chart = await mount();
    chart.setViewport([100, 300]);
    chart.render();
    const strip = stripBox(chart);
    const at = (value: number) => strip.x + value * perUnit(chart);
    const y = strip.y + strip.height / 2;
    await mouse(chart, "mousePressed", at(200), y);
    await mouse(chart, "mouseMoved", at(250), y);
    chart.update({ height: 80 });
    chart.render();
    expect(group(chart).hidden).toBe(true);
    const held = chart.getViewport().x;
    await mouse(chart, "mouseMoved", at(400), y);
    await mouse(chart, "mouseReleased", at(400), y);
    expect(chart.getViewport().x).toEqual(held);
  });

  it("follow one finger, and leave a second one alone", async () => {
    const chart = await mount();
    chart.setViewport([200, 400]);
    chart.render();
    const at = (value: number) => stripBox(chart).x + value * perUnit(chart);
    await touch(chart, "touchStart", { 1: at(300) });
    await touch(chart, "touchMove", { 1: at(350) });
    expect(chart.getViewport().x![0]).toBeCloseTo(250, 0);
    // Chrome's touch emulation lifts the first finger as the second lands,
    // which is then not a primary pointer: it selects nothing.
    await touch(chart, "touchStart", { 1: at(350), 2: at(700) });
    await touch(chart, "touchMove", { 1: at(350), 2: at(750) });
    await touch(chart, "touchEnd", {});
    expect(chart.getViewport().x![0]).toBeCloseTo(250, 0);
    expect(chart.getViewport().x![1]).toBeCloseTo(450, 0);
  });

  it("keep the edge that stays where it is, inside a time axis' break", async () => {
    const day = 86_400_000;
    const monday = Date.UTC(2025, 9, 6);
    const days = Array.from({ length: 28 }, (_, i) => monday + i * day).filter(
      (t) => new Date(t).getUTCDay() % 6 !== 0,
    );
    const prices = table({ t: time(days), v: days.map((_, i) => i) });
    const chart = await mount({
      marks: [line(prices, { x: "t", y: "v" })],
      timeZone: "UTC",
      x: { breaks: timeBreaks([{ weekdays: ["sat", "sun"] }]) },
    });
    // Thursday to Saturday, which the break collapses into Monday's seam.
    const saturday = monday + 12 * day;
    chart.setViewport([monday + 10 * day, saturday]);
    chart.render();
    const start = sliders(chart).find(
      (slider) => slider.getAttribute("aria-label") === "Start of the shown range",
    )!;
    key(start, "ArrowRight");
    expect(chart.getViewport().x![1]).toBe(saturday);
    const end = sliders(chart).find(
      (slider) => slider.getAttribute("aria-label") === "End of the shown range",
    )!;
    const begun = chart.getViewport().x![0];
    key(end, "ArrowRight");
    expect(chart.getViewport().x![0]).toBe(begun);
  });

  it("let go of a drag when the chart resizes under it", async () => {
    const chart = await mount();
    chart.setViewport([100, 300]);
    chart.render();
    const at = (value: number) => stripBox(chart).x + value * perUnit(chart);
    const y = stripBox(chart).y + stripBox(chart).height / 2;
    const target = sliders(chart)[1]!;
    pointer(chart, target, "pointerdown", at(200), y);
    pointer(chart, target, "pointermove", at(250), y);
    const held = chart.getViewport().x;
    chart.update({ width: 400 });
    chart.render();
    pointer(chart, target, "pointermove", at(400), y);
    pointer(chart, target, "pointerup", at(400), y);
    expect(chart.getViewport().x).toEqual(held);
  });

  it("let go of a drag when the axis turns around under it", async () => {
    const chart = await mount({ x: { show: false, domain: [0, 1000] } });
    chart.setViewport([200, 400]);
    chart.render();
    const at = (value: number) => stripBox(chart).x + value * perUnit(chart);
    const y = stripBox(chart).y + stripBox(chart).height / 2;
    const target = sliders(chart)[1]!;
    pointer(chart, target, "pointerdown", at(300), y);
    pointer(chart, target, "pointermove", at(350), y);
    const held = chart.getViewport().x;
    chart.update({ x: { show: false, domain: [1000, 0] } });
    chart.render();
    pointer(chart, target, "pointermove", at(400), y);
    pointer(chart, target, "pointerup", at(400), y);
    expect(chart.getViewport().x).toEqual(held);
  });

  it("let go of a drag when a viewport listener takes the navigator away", async () => {
    const hosts = table({ t: [0, 1, 2, 3], v: [1, 2, 3, 4], k: ["a", "a", "b", "b"] });
    const chart = await mount({ marks: [line(hosts, { x: "t", y: "v" })], x: { domain: [0, 3] } });
    chart.setViewport([1, 2]);
    chart.render();
    const at = (value: number) => stripBox(chart).x + (value / 3) * stripBox(chart).width;
    const y = stripBox(chart).y + stripBox(chart).height / 2;
    const target = sliders(chart)[1]!;
    const [from, to, further] = [at(1.5), at(1.6), at(1.8)];
    const stop = chart.on("viewport", () => {
      stop();
      chart.update({ navigator: undefined, facet: facet("k"), resolve: { x: "independent" } });
    });
    pointer(chart, target, "pointerdown", from, y);
    expect(() => {
      pointer(chart, target, "pointermove", to, y);
      pointer(chart, target, "pointermove", further, y);
      pointer(chart, target, "pointerup", further, y);
    }).not.toThrow();
  });

  it("start nothing when a render listener moves the view as they draw", async () => {
    const chart = await mount();
    chart.setViewport([200, 400]);
    chart.render();
    const at = (value: number) => stripBox(chart).x + value * perUnit(chart);
    const y = stripBox(chart).y + stripBox(chart).height / 2;
    const once = (view: [number, number]) => {
      const stop = chart.on("render", () => {
        stop();
        chart.setViewport(view);
      });
    };
    once([700, 800]);
    await mouse(chart, "mousePressed", at(300), y);
    await mouse(chart, "mouseMoved", at(350), y);
    await mouse(chart, "mouseReleased", at(350), y);
    expect(chart.getViewport().x).toEqual([700, 800]);
    chart.render();
    once([100, 150]);
    key(sliders(chart)[1]!, "ArrowRight");
    expect(chart.getViewport().x).toEqual([100, 150]);
  });

  it("start nothing, and leave the plot alone, when a render listener takes the navigator away", async () => {
    const hosts = table({ t: [0, 1, 2, 3], v: [1, 2, 3, 4], k: ["a", "a", "b", "b"] });
    for (const input of ["mouse", "key"] as const) {
      const chart = await mount({
        marks: [line(hosts, { x: "t", y: "v" })],
        x: { show: false, domain: [0, 3] },
        interaction: { zoom: true },
      });
      chart.setViewport([1, 2]);
      chart.render();
      const at = (value: number) => stripBox(chart).x + (value / 3) * stripBox(chart).width;
      const y = stripBox(chart).y + stripBox(chart).height / 2;
      const [from, to] = [at(1.5), at(1.8)];
      const middle = sliders(chart)[1]!;
      const stop = chart.on("render", () => {
        stop();
        chart.update({ navigator: undefined, facet: facet("k"), resolve: { x: "independent" } });
        chart.render();
      });
      if (input === "mouse") {
        await mouse(chart, "mousePressed", from, y);
        await mouse(chart, "mouseMoved", to, y);
        await mouse(chart, "mouseReleased", to, y);
      } else {
        expect(() => key(middle, "ArrowRight")).not.toThrow();
      }
      // Panels with x scales of their own start unzoomed; the press panned neither.
      expect(chart.getViewport({ panel: "a" }).x).toBeNull();
      expect(chart.getViewport({ panel: "b" }).x).toBeNull();
      chart.destroy();
      charts.splice(charts.indexOf(chart), 1);
    }
  });

  it("keep a press for itself when the plot grows under it as the strip goes", async () => {
    const chart = await mount({ x: { show: false }, interaction: { zoom: true } });
    chart.setViewport([200, 400]);
    chart.render();
    const at = (value: number) => stripBox(chart).x + value * perUnit(chart);
    const y = stripBox(chart).y + stripBox(chart).height / 2;
    const [from, to] = [at(300), at(350)];
    const stop = chart.on("render", () => {
      stop();
      chart.update({ navigator: undefined });
      chart.render();
    });
    await mouse(chart, "mousePressed", from, y);
    await mouse(chart, "mouseMoved", to, y);
    await mouse(chart, "mouseReleased", to, y);
    expect(chart.getViewport().x).toEqual([200, 400]);
  });

  it("let go of a drag when the axis' scale changes type under it", async () => {
    const chart = await mount({ x: { show: false, domain: [1, 1000] } });
    chart.setViewport([200, 400]);
    chart.render();
    const at = (value: number) => stripBox(chart).x + ((value - 1) / 999) * stripBox(chart).width;
    const y = stripBox(chart).y + stripBox(chart).height / 2;
    const target = sliders(chart)[1]!;
    pointer(chart, target, "pointerdown", at(300), y);
    pointer(chart, target, "pointermove", at(350), y);
    const held = chart.getViewport().x;
    chart.update({ x: { show: false, domain: [1, 1000], type: "log" } });
    chart.render();
    pointer(chart, target, "pointermove", at(400), y);
    pointer(chart, target, "pointerup", at(400), y);
    expect(chart.getViewport().x).toEqual(held);
  });

  it("survive a viewport listener that destroys the chart mid-drag", async () => {
    const chart = await mount();
    chart.setViewport([100, 300]);
    chart.render();
    const at = (value: number) => stripBox(chart).x + value * perUnit(chart);
    const y = stripBox(chart).y + stripBox(chart).height / 2;
    const target = sliders(chart)[1]!;
    const [from, to] = [at(200), at(250)];
    chart.on("viewport", () => chart.destroy());
    pointer(chart, target, "pointerdown", from, y);
    expect(() => {
      pointer(chart, target, "pointermove", to, y);
      pointer(chart, target, "pointerup", to, y);
    }).not.toThrow();
    expect(chart.root.isConnected).toBe(false);
  });

  it("hide in a chart too short for a strip", async () => {
    const chart = await mount({ height: 100, title: "Short" });
    await frame();
    expect(group(chart).hidden).toBe(true);
    chart.update({ height: 320 });
    chart.render();
    expect(group(chart).hidden).toBe(false);
  });

  it("keep a held window where it is while data streams in, and follow it unzoomed", async () => {
    const data = waves(1001);
    const chart = await mount({ marks: [line(data, { x: "t", y: "v" })] });
    const strip = stripBox(chart);
    const at = (value: number) => strip.x + value * perUnit(chart);
    const y = strip.y + strip.height / 2;
    chart.setViewport([100, 300]);
    await frame();
    const target = sliders(chart)[1]!;
    pointer(chart, target, "pointerdown", at(200), y);
    pointer(chart, target, "pointermove", at(250), y);
    data.append({
      t: Float64Array.from({ length: 1000 }, (_, i) => 1001 + i),
      v: new Float64Array(1000),
    });
    await frame();
    pointer(chart, target, "pointermove", at(300), y);
    pointer(chart, target, "pointerup", at(300), y);
    // The drag kept the strip it started on: 100 to the right, as the pointer moved.
    const [x0, x1] = chart.getViewport().x!;
    expect(x0).toBeCloseTo(200, 0);
    expect(x1).toBeCloseTo(400, 0);
    await frame();
    // The strip grew, so the window shrank to the left.
    expect(Number.parseFloat(sliders(chart)[1]!.style.width)).toBeCloseTo(
      (200 / 2000) * strip.width - 8,
      0,
    );
    // Unzoomed, the window follows the data.
    chart.setViewport(null);
    await frame();
    data.append({ t: [2001, 2002], v: [0, 0] });
    await frame();
    expect(sliders(chart)[2]!.getAttribute("aria-valuenow")).toBe(
      sliders(chart)[2]!.getAttribute("aria-valuemax"),
    );
  });

  it("export the strip and the window, without the sliders", async () => {
    const chart = await mount();
    chart.setViewport([250, 500]);
    const svg = chart.toSVG();
    expect(svg).not.toContain("slider");
    expect(svg.match(/fill-opacity="0\.6"/g)).toHaveLength(2);
  });

  it("go when the navigator does, and come with it", async () => {
    const chart = await mount();
    const before = chart.getPanels()[0]!.plot.height;
    chart.update({ navigator: undefined });
    expect(group(chart)).toBeNull();
    chart.render();
    expect(chart.getPanels()[0]!.plot.height).toBeGreaterThan(before);
    chart.update({ navigator: rangeNavigator({ height: 30 }) });
    await chart.loading;
    await frame();
    expect(stripBox(chart).height).toBe(30);
  });

  it("keep focus as options change", async () => {
    const chart = await mount();
    const [, middle] = sliders(chart);
    middle!.focus();
    chart.update({ navigator: rangeNavigator({ height: 48 }) });
    await chart.loading;
    await frame();
    expect(document.activeElement).toBe(middle);
    expect(stripBox(chart).height).toBe(48);
  });

  it("go with the chart, also while their code loads", async () => {
    const chart = createChart(host, {
      marks: [line(waves(10), { x: "t", y: "v" })],
      navigator: rangeNavigator(),
    });
    const loading = chart.loading;
    chart.destroy();
    await loading;
    expect(host.children).toHaveLength(0);
  });
});

describe("a navigator's accessibility tree", () => {
  it("is a group of three sliders, whose values the axis formats", async () => {
    const t0 = Date.UTC(2026, 0, 1);
    const days = table({
      t: Float64Array.from({ length: 31 }, (_, i) => t0 + i * 86_400_000),
      v: Float64Array.from({ length: 31 }, (_, i) => i),
    });
    const chart = await mount({
      title: "Days",
      timeZone: "UTC",
      marks: [line(days, { x: "t", y: "v" })],
      x: { type: "time" },
    });
    chart.setViewport([Date.UTC(2026, 0, 5), Date.UTC(2026, 0, 12)]);
    await frame();
    const tree = await treeUnder("figure", ["focusable", "valuemin", "valuemax"]);
    const at = tree.findIndex((line) => line.includes('group "Range navigator"'));
    expect(at).toBeGreaterThan(0);
    const [start, end] = [Date.UTC(2026, 0, 5), Date.UTC(2026, 0, 12)];
    const [first, last] = [t0, t0 + 30 * 86_400_000];
    const found = tree.slice(at + 1, at + 4).map((line) => line.trim());
    expect(found.map((line) => line.replace(/ valuemin.*/, ""))).toEqual([
      'slider "Start of the shown range" focusable=true',
      'slider "Shown range" focusable=true',
      'slider "End of the shown range" focusable=true',
    ]);
    // Each slider's bounds: an edge goes as far as the strip and a few
    // pixels short of the other edge; the window, whose value is its start,
    // as far as keeps its width.
    const bounds = found.map((line) =>
      line
        .match(/valuemin=(\S+) valuemax=(\S+)/)!
        .slice(1)
        .map(Number),
    );
    const few = ((last - first) / stripBox(chart).width) * 3;
    const expected = [
      [first, end - few],
      [first, last - (end - start)],
      [start + few, last],
    ];
    // Chrome keeps them in single precision: to about two minutes in 2026.
    bounds.forEach(([min, max], i) => {
      expect(Math.abs(min! - expected[i]![0]!)).toBeLessThan(150_000);
      expect(Math.abs(max! - expected[i]![1]!)).toBeLessThan(150_000);
    });
    // Chrome's tree does not report value texts: they are the tooltips' own.
    const texts = sliders(chart).map((slider) => slider.getAttribute("aria-valuetext"));
    expect(texts).toEqual([
      "Jan 5, 2026, 00:00",
      "Jan 5, 2026, 00:00 to Jan 12, 2026, 00:00",
      "Jan 12, 2026, 00:00",
    ]);
  });
});
