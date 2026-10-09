// Financial charts in the browser: zooming, panning, brushing, tooltips, and
// the keyboard on time axes with breaks, crosshair labels, and OHLC bars.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { time } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { type Chart, createChart } from "../../src/dom/chart.ts";
import { bar } from "../../src/marks/bar.ts";
import { candlestick } from "../../src/marks/candlestick.ts";
import { line } from "../../src/marks/line.ts";
import { pie } from "../../src/marks/pie.ts";
import { point } from "../../src/marks/point.ts";
import { panels } from "../../src/model/panels.ts";
import { timeBreaks } from "../../src/scale/breaks.ts";
import { modelOf } from "./helpers.ts";

let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  host.style.cssText = "width:600px;height:300px";
  document.body.append(host);
});

afterEach(() => {
  host.remove();
});

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const HOUR = 3_600_000;
const utc = (...parts: number[]) => Date.UTC(parts[0]!, parts[1]! - 1, ...parts.slice(2));

/** Hourly values around the clock for three weeks from Monday 2025-10-06. */
function hourly() {
  const t = Array.from({ length: 21 * 24 }, (_, i) => utc(2025, 10, 6) + i * HOUR);
  return table({ t: time(t), v: t.map((_, i) => Math.sin(i / 10) * 10 + 50) });
}

const weekend = () => timeBreaks([{ weekdays: ["sat", "sun"] }]);

function pointer(target: Element, type: string, x: number, y: number, shiftKey = false) {
  const rect = target.getBoundingClientRect();
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      clientX: rect.left + x,
      clientY: rect.top + y,
      shiftKey,
      pointerId: 1,
    }),
  );
}

function wheel(chart: Chart, x: number, deltaY: number) {
  const rect = chart.root.getBoundingClientRect();
  chart.root.dispatchEvent(
    new WheelEvent("wheel", {
      deltaY,
      clientX: rect.left + x,
      clientY: rect.top + 150,
      bubbles: true,
      cancelable: true,
    }),
  );
}

function drag(chart: Chart, from: number, to: number, shiftKey = false) {
  pointer(chart.root, "pointerdown", from, 150, shiftKey);
  pointer(chart.root, "pointermove", (from + to) / 2, 150, shiftKey);
  pointer(chart.root, "pointermove", to, 150, shiftKey);
  pointer(chart.root, "pointerup", to, 150, shiftKey);
}

const tooltipOf = (chart: Chart) =>
  [...chart.root.children].find(
    (el) => (el as HTMLElement).style.pointerEvents === "none" && el.tagName === "DIV",
  ) as HTMLElement;

describe("time axes with breaks", () => {
  it("zoom around the pointer and pan by pixels of time shown", () => {
    const chart = createChart(host, {
      timeZone: "UTC",
      interaction: { zoom: true },
      marks: [line(hourly(), { x: "t", y: "v" })],
      x: { breaks: weekend() },
    });
    // The pointer over Monday 2025-10-13, just past the first weekend's seam.
    const anchor = utc(2025, 10, 13, 2);
    const scale = modelOf(chart).xScale()!;
    // Whole pixels, as pointer events report them.
    const px = Math.round(scale.map(anchor));
    const share = (px - scale.range[0]) / (scale.range[1] - scale.range[0]);
    const value = scale.invert(px);
    wheel(chart, px, -300);
    chart.render();
    // The anchor keeps its share of the view, in time shown.
    const zoomed = modelOf(chart).xScale()!;
    const breaks = zoomed.breaks!;
    const [start, end] = zoomed.domain.map((t) => breaks.collapse(t));
    expect((breaks.collapse(value) - start!) / (end! - start!)).toBeCloseTo(share, 9);
    // A weekend inside the view takes no room.
    const [lo, hi] = chart.getViewport().x!;
    expect(lo).toBeLessThan(utc(2025, 10, 11));
    expect(hi).toBeGreaterThan(utc(2025, 10, 13, 3));
    // Dragging 50 pixels moves the view 50 pixels of time shown, across the weekend.
    const friday = utc(2025, 10, 10, 20);
    const before = zoomed.map(friday);
    drag(chart, 300, 250);
    chart.render();
    expect(chart.toPixel(friday, { axis: "x" })!).toBeCloseTo(before - 50, 1);
    chart.destroy();
  });

  it("brush data values across a break, and zoom to them", async () => {
    const chart = createChart(host, {
      timeZone: "UTC",
      interaction: { brush: "x", zoom: true },
      marks: [line(hourly(), { x: "t", y: "v" })],
      x: { breaks: weekend() },
    });
    // The brush loads on demand.
    await chart.loading;
    const x = modelOf(chart).xScale()!;
    const from = utc(2025, 10, 10, 12);
    const to = utc(2025, 10, 13, 12);
    drag(chart, x.map(from), x.map(to));
    const [lo, hi] = chart.getViewport().x!;
    expect(Math.abs(lo - from)).toBeLessThan(HOUR);
    expect(Math.abs(hi - to)).toBeLessThan(HOUR);
    chart.render();
    // A day of time shown: Friday's afternoon and Monday's morning, half each.
    const zoomed = modelOf(chart).xScale()!;
    const seam = zoomed.map(utc(2025, 10, 13));
    expect(seam - zoomed.range[0]).toBeCloseTo((zoomed.range[1] - zoomed.range[0]) / 2, 0);
    // A brush on the seam selects the end of the break, the first time shown after it.
    chart.update({ interaction: { brush: "x" } });
    chart.render();
    const scale = modelOf(chart).xScale()!;
    const start = scale.map(utc(2025, 10, 13));
    drag(chart, start, start + 40);
    await frame();
    expect(chart.selection!.x![0]).toBe(utc(2025, 10, 13));
    chart.destroy();
  });

  it("show the point nearest the pointer on screen in tooltips, never a hidden one", async () => {
    const data = hourly();
    const chart = createChart(host, {
      timeZone: "UTC",
      locale: "en-US",
      marks: [line(data, { x: "t", y: "v" })],
      x: { breaks: weekend() },
    });
    const x = modelOf(chart).xScale()!;
    const seam = x.map(utc(2025, 10, 13));
    pointer(chart.root, "pointermove", seam + 0.3, 150);
    await frame();
    const tooltip = tooltipOf(chart);
    expect(tooltip.style.display).toBe("block");
    expect(tooltip.textContent).toContain("Oct 13, 2025");
    chart.destroy();
  });

  it("step the keyboard over hidden points", () => {
    const chart = createChart(host, {
      timeZone: "UTC",
      locale: "en-US",
      marks: [line(hourly(), { x: "t", y: "v" })],
      x: { breaks: weekend() },
    });
    chart.root.focus();
    const key = (k: string) =>
      chart.root.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    key("ArrowRight");
    // From Monday's first hour, five days on is Friday's last.
    for (let i = 0; i < 5 * 24 - 1; i++) key("ArrowRight");
    const live = chart.root.querySelector('[aria-live="polite"]')!;
    expect(live.textContent).toContain("Oct 10, 2025");
    // One more step passes the whole weekend.
    key("ArrowRight");
    expect(live.textContent).toContain("Oct 13, 2025");
    key("ArrowLeft");
    expect(live.textContent).toContain("Oct 10, 2025");
    chart.destroy();
  });

  it("step the keyboard over hidden points of unsorted series, to the last shown at End", () => {
    // Monday, Saturday (hidden), Tuesday, Sunday (hidden), out of order.
    const data = table({
      t: time([utc(2025, 10, 13), utc(2025, 10, 11), utc(2025, 10, 14), utc(2025, 10, 12)]),
      v: [1, 2, 3, 4],
    });
    const chart = createChart(host, {
      timeZone: "UTC",
      locale: "en-US",
      marks: [point(data, { x: "t", y: "v" })],
      x: { breaks: weekend() },
    });
    chart.root.focus();
    const key = (k: string) =>
      chart.root.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    const live = chart.root.querySelector('[aria-live="polite"]')!;
    key("ArrowRight");
    expect(live.textContent).toContain("Oct 13, 2025");
    key("ArrowRight");
    expect(live.textContent).toContain("Oct 14, 2025");
    key("End");
    expect(live.textContent).toContain("Oct 14, 2025");
    key("Home");
    expect(live.textContent).toContain("Oct 13, 2025");
    chart.destroy();
  });

  it("carry the keyboard to the shown point nearest on screen in the next panel", () => {
    const gap = timeBreaks([{ from: 3, to: 8 }]);
    const upper = table({ t: time([2]), v: [1] });
    const lower = table({ t: time([0, 3, 10]), v: [100, 300, 1000] });
    const chart = createChart(host, {
      timeZone: "UTC",
      locale: "en-US",
      panels: panels([{ id: "a" }, { id: "b" }]),
      marks: [
        line(upper, { x: "t", y: "v", panel: "a" }),
        line(lower, { x: "t", y: "v", panel: "b" }),
      ],
      x: { breaks: gap, domain: [0, 10] },
    });
    chart.root.focus();
    const key = (k: string) =>
      chart.root.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    key("Home");
    key("ArrowDown");
    // 2 is 2 of time shown from 0 and 3 from 10; 3 is hidden.
    const live = chart.root.querySelector('[aria-live="polite"]')!;
    expect(live.textContent).toContain("100");
    expect(live.textContent).not.toContain("1,000");
    chart.destroy();
  });

  it("draw nothing at a synced cursor inside a break", async () => {
    const plain = createChart(host, {
      timeZone: "UTC",
      interaction: { sync: "financial" },
      marks: [line(hourly(), { x: "t", y: "v" })],
    });
    const other = document.createElement("div");
    other.style.cssText = "width:600px;height:300px";
    document.body.append(other);
    const broken = createChart(other, {
      timeZone: "UTC",
      interaction: { sync: "financial" },
      marks: [line(hourly(), { x: "t", y: "v" })],
      x: { breaks: weekend() },
    });
    const crosshairs = () =>
      [...broken.root.querySelectorAll("svg line")].filter(
        (line) => line.getAttribute("visibility") === "visible",
      );
    // On a Saturday in the plain chart.
    pointer(plain.root, "pointermove", plain.toPixel(utc(2025, 10, 11, 12), { axis: "x" })!, 150);
    await frame();
    expect(crosshairs()).toHaveLength(0);
    pointer(plain.root, "pointermove", plain.toPixel(utc(2025, 10, 14, 12), { axis: "x" })!, 150);
    await frame();
    expect(crosshairs()).toHaveLength(1);
    plain.destroy();
    broken.destroy();
    other.remove();
  });

  it("draw candles on canvas as in SVG", () => {
    const t = Array.from({ length: 2000 }, (_, i) => utc(2025, 1, 1) + i * HOUR);
    const prices = table({
      t: time(t),
      o: t.map((_, i) => 100 + Math.sin(i / 50)),
      h: t.map((_, i) => 101 + Math.sin(i / 50)),
      l: t.map((_, i) => 99 + Math.sin(i / 50)),
      c: t.map((_, i) => 100 + Math.sin((i + 1) / 50)),
    });
    for (const renderer of ["svg", "canvas"] as const) {
      const chart = createChart(host, {
        renderer,
        timeZone: "UTC",
        marks: [
          candlestick(prices, {
            x: "t",
            open: "o",
            high: "h",
            low: "l",
            close: "c",
            variant: "ohlc",
          }),
        ],
        x: { breaks: timeBreaks([{ weekdays: ["sat", "sun"] }, { hours: ["17:00", "09:00"] }]) },
      });
      expect(Boolean(chart.root.querySelector("canvas"))).toBe(renderer === "canvas");
      chart.destroy();
    }
  });
});

describe("crosshair labels", () => {
  const labels = (chart: Chart) =>
    [...chart.root.querySelectorAll("svg g > g")]
      .filter((g) => g.getAttribute("visibility") === "visible" && g.querySelector("rect"))
      .map((g) => g.textContent);

  it("label the inspected x on the x axis and the pointer's y on each y axis", async () => {
    const data = table({ t: time([utc(2025, 1, 6), utc(2025, 1, 7)]), a: [10, 20], b: [100, 200] });
    const chart = createChart(host, {
      timeZone: "UTC",
      locale: "en-US",
      tooltip: { axisLabels: true },
      marks: [line(data, { x: "t", y: "a" }), line(data, { x: "t", y: "b", axis: "right" })],
    });
    await chart.loading;
    const x = modelOf(chart).xScale()!;
    const y = modelOf(chart).yScale()!;
    pointer(chart.root, "pointermove", x.map(utc(2025, 1, 6, 2)), y.map(15));
    await frame();
    const shown = labels(chart);
    expect(shown).toHaveLength(3);
    expect(shown[0]).toContain("Jan 6, 2025");
    expect(Number(shown[1])).toBeCloseTo(15, 0);
    expect(Number(shown[2])).toBeCloseTo(150, -1);
    const dashed = chart.root.querySelector('line[stroke-dasharray="3 3"]')!;
    expect(dashed.getAttribute("visibility")).toBe("visible");
    pointer(chart.root, "pointerleave", 0, 0);
    await frame();
    expect(labels(chart)).toHaveLength(0);
    expect(dashed.getAttribute("visibility")).toBe("hidden");
    chart.destroy();
  });

  it("label categories of horizontal bars on y and the pointer's x, and only drawn axes", async () => {
    const data = table({ region: ["North", "South"], sales: [10, 20] });
    const chart = createChart(host, {
      locale: "en-US",
      tooltip: { axisLabels: true },
      x: { axis: false },
      marks: [bar(data, { x: "sales", y: "region" })],
    });
    await chart.loading;
    const y = modelOf(chart).yScale()!;
    pointer(chart.root, "pointermove", 300, y.map(1));
    await frame();
    // The x axis is not drawn, so only the category is labeled.
    expect(labels(chart)).toEqual(["South"]);
    chart.update({ x: {} });
    chart.render();
    pointer(chart.root, "pointermove", 300, y.map(1));
    await frame();
    expect(labels(chart)).toHaveLength(2);
    chart.destroy();
  });

  it("label only axes the chart draws: right-only charts and subplots without a y axis", async () => {
    const data = table({ t: [0, 1, 2], v: [1, 2, 3] });
    const right = createChart(host, {
      tooltip: { axisLabels: true },
      marks: [line(data, { x: "t", y: "v", axis: "right" })],
    });
    await right.loading;
    const scale = modelOf(right).yRightScale()!;
    pointer(right.root, "pointermove", right.toPixel(1, { axis: "x" })!, scale.map(2.5));
    await frame();
    // The x value and the right axis' value; there is no left axis to label.
    const shown = labels(right);
    expect(shown).toHaveLength(2);
    expect(Number(shown[1])).toBeCloseTo(2.5, 0);
    right.destroy();
    const sub = createChart(host, {
      tooltip: { axisLabels: true },
      panels: panels([{ id: "a" }, { id: "b", y: { axis: false } }]),
      marks: [
        line(data, { x: "t", y: "v", panel: "a" }),
        line(data, { x: "t", y: "v", panel: "b" }),
      ],
    });
    await sub.loading;
    const lower = modelOf(sub).panels()[1]!;
    pointer(sub.root, "pointermove", lower.x.map(1), lower.y.map(2));
    await frame();
    // The x axis under the lower panel; its y axis is not drawn.
    expect(labels(sub)).toHaveLength(1);
    sub.destroy();
  });

  it("label x only on axes of the inspected panel's own x scale", async () => {
    const times = table({ t: time([0, 10]), v: [1, 2] });
    const numbers = table({ n: [100, 200], v: [1, 2] });
    const chart = createChart(host, {
      tooltip: { axisLabels: true },
      panels: panels([{ id: "a", x: { axis: false } }, { id: "b" }]),
      resolve: { x: "independent" },
      marks: [
        line(times, { x: "t", y: "v", panel: "a" }),
        line(numbers, { x: "n", y: "v", panel: "b" }),
      ],
    });
    await chart.loading;
    const upper = modelOf(chart).panels()[0]!;
    pointer(chart.root, "pointermove", upper.x.map(5), upper.y.map(1.5));
    await frame();
    // Only the y value: the upper x axis is not drawn, and the lower one is another scale.
    expect(labels(chart)).toHaveLength(1);
    chart.destroy();
  });

  it("label only the inspected value for the keyboard, and nothing for items", async () => {
    const data = table({ t: [0, 1, 2], v: [1, 2, 3] });
    const chart = createChart(host, {
      tooltip: { axisLabels: true },
      marks: [line(data, { x: "t", y: "v" })],
    });
    await chart.loading;
    chart.root.focus();
    chart.root.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await frame();
    expect(labels(chart)).toEqual(["0"]);
    chart.destroy();
    const slices = table({ k: ["a", "b"], v: [1, 2] });
    const round = createChart(host, {
      tooltip: { axisLabels: true },
      marks: [pie(slices, { category: "k", value: "v" })],
    });
    await round.loading;
    pointer(round.root, "pointermove", 300, 160);
    await frame();
    expect(labels(round)).toHaveLength(0);
    round.destroy();
  });
});
