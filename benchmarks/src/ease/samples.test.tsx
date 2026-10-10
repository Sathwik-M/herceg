/// <reference types="vite/client" />
// Mounts every common-task sample (see docs/comparison.md, "Common tasks")
// in Chrome and checks that it draws what its task asks for, so that no
// sample can rot. Each check reads what is on screen: the DOM of SVG and
// HTML output, or for canvas output the library's own record of what it drew
// and the canvas pixels.

import type { Chart as ChartJS } from "chart.js";
import type { ECharts } from "echarts";
import type { Chart as HercegChart } from "herceg";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { daily, days, p50, p99, requests } from "./data.ts";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

interface Sample {
  render?: (...containers: HTMLElement[]) => unknown;
  Example?: () => ReactNode;
}

const samples = import.meta.glob<Sample>("./*/*.{ts,tsx}", { eager: true });

/** The sample of `task` for `library`, e.g. ("01-line", "herceg-react"). */
function sample(task: string, library: string): Sample {
  const found = samples[`./${task}/${library}.ts`] ?? samples[`./${task}/${library}.tsx`];
  if (!found) throw new Error(`no sample ${task}/${library}`);
  return found;
}

const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  document.body.replaceChildren();
});

function box(height = 320): HTMLDivElement {
  const element = document.createElement("div");
  element.style.cssText = `position:relative;width:640px;height:${height}px`;
  document.body.append(element);
  return element;
}

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
async function settle() {
  for (let i = 0; i < 3; i++) await frame();
}

/** Renders a sample's `render` into new containers, or its React `Example`. */
async function mount(task: string, library: string, containers = 1) {
  const found = sample(task, library);
  const elements = Array.from({ length: containers }, () => box());
  let result: unknown;
  if (found.Example) {
    const root = createRoot(elements[0]!);
    const Example = found.Example;
    await act(async () => root.render(<Example />));
    cleanups.push(() => act(async () => root.unmount()));
  } else {
    result = await found.render!(...elements);
    cleanups.push(() => dispose(library, result, elements));
  }
  await settle();
  return { elements, result: result as never };
}

/** Stops a sample's timers and destroys its charts, so none outlives its test. */
async function dispose(library: string, result: unknown, elements: HTMLElement[]) {
  const record = result as { chart?: unknown; stop?: () => void };
  record.stop?.();
  const handles = Array.isArray(result) ? result : [record.chart ?? result];
  if (library === "plotly") {
    const Plotly = (await import("plotly.js-dist-min")).default;
    for (const element of elements) Plotly.purge(element);
    return;
  }
  for (const handle of handles as Record<string, () => void>[]) {
    if (library === "echarts") handle.dispose!();
    else handle.destroy!();
  }
}

/** What the screen shows of an element, as pixels. */
async function screenshot(element: Element): Promise<ImageData> {
  const base64 = (await page.screenshot({ element, save: false })) as string;
  const image = new Image();
  image.src = `data:image/png;base64,${base64}`;
  await image.decode();
  const canvas = Object.assign(document.createElement("canvas"), {
    width: image.width,
    height: image.height,
  });
  const context = canvas.getContext("2d")!;
  context.drawImage(image, 0, 0);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

/** A screenshot once animations have ended: two in a row, 200 ms apart, the same. */
async function still(element: Element): Promise<ImageData> {
  let last = await screenshot(element);
  for (let tries = 0; tries < 20; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const next = await screenshot(element);
    if (next.data.every((value, i) => value === last.data[i])) return next;
    last = next;
  }
  throw new Error("the chart kept changing");
}

/** How many pixels are within a small distance of a "#rrggbb" color. */
function count(pixels: ImageData, color: string): number {
  const target = [1, 3, 5].map((i) => Number.parseInt(color.slice(i, i + 2), 16));
  let found = 0;
  for (let i = 0; i < pixels.data.length; i += 4) {
    if (target.every((value, c) => Math.abs(pixels.data[i + c]! - value) < 24)) found++;
  }
  return found;
}

/**
 * How many pixels are blue, as every library's first series is by default
 * (axes, grids, and text are gray), within rows `top` to `bottom`.
 */
function blue(pixels: ImageData, top = 0, bottom = pixels.height): number {
  let found = 0;
  for (let y = top; y < bottom; y++) {
    for (let x = 0; x < pixels.width; x++) {
      const i = (y * pixels.width + x) * 4;
      if (pixels.data[i + 2]! - pixels.data[i]! > 60) found++;
    }
  }
  return found;
}

// What each library drew.

/** Herceg's text alternative counts the series it drew: "Line chart with 3 series." */
function hercegSeries(element: Element): number {
  const match = element.textContent?.match(/with (\d+) series/);
  return match ? Number(match[1]) : 0;
}

function echartsTexts(chart: ECharts): string[] {
  const texts: string[] = [];
  // zrender's display list holds every element drawn on the canvas.
  const list = (
    chart.getZr() as unknown as {
      storage: { getDisplayList(update: boolean): { style?: { text?: string } }[] };
    }
  ).storage.getDisplayList(true);
  for (const element of list) if (element.style?.text) texts.push(element.style.text);
  return texts;
}

function echartsSeries(chart: ECharts): number {
  return (chart.getOption().series as unknown[]).length;
}

function plotlyTraces(element: Element): number {
  return element.querySelectorAll(".scatterlayer > .trace, .barlayer > .trace").length;
}

function tanstackLines(element: Element): number {
  return element.querySelectorAll(".ts-chart__line path").length;
}

const PLOT = { x: 330, y: 160 };

describe("01: a basic line chart", () => {
  for (const library of [
    "herceg",
    "herceg-react",
    "echarts",
    "chartjs",
    "plotly",
    "tanstack",
    "tanstack-react",
  ]) {
    test(`${library} draws the line`, async () => {
      const { elements } = await mount("01-line", library);
      // ECharts animates the line in, so wait for it.
      await expect.poll(async () => blue(await screenshot(elements[0]!))).toBeGreaterThan(400);
    });
  }
  for (const library of ["herceg", "herceg-react"]) {
    test(library, async () => {
      const { elements } = await mount("01-line", library);
      expect(hercegSeries(elements[0]!)).toBe(1);
      expect(elements[0]!.textContent).toContain("Request latency");
      expect(elements[0]!.textContent).toContain("ms");
    });
  }
  // The pixel checks above pass for dots alone; these find the line joining them.
  test("echarts", async () => {
    const { result } = await mount("01-line", "echarts");
    const chart = result as ECharts;
    expect(echartsSeries(chart)).toBe(1);
    expect(echartsTexts(chart)).toEqual(expect.arrayContaining(["Request latency", "ms"]));
    const list = (
      chart.getZr() as unknown as {
        storage: {
          getDisplayList(update: boolean): {
            shape?: { points?: ArrayLike<number> };
            style?: { lineWidth?: number; opacity?: number };
          }[];
        };
      }
    ).storage.getDisplayList(true);
    const line = list.find((element) => element.shape?.points?.length === 120);
    expect(line?.style?.lineWidth).toBeGreaterThan(0);
    expect(line?.style?.opacity ?? 1).toBeGreaterThan(0);
  });
  test("chartjs", async () => {
    const { result } = await mount("01-line", "chartjs");
    const chart = result as ChartJS;
    const meta = chart.getSortedVisibleDatasetMetas()[0]!;
    expect(meta.data).toHaveLength(60);
    expect(chart.scales.x!.ticks.length).toBeGreaterThan(2);
    // The line element through the points, drawn with a width (0 with showLine: false).
    const line = meta.dataset as unknown as { points: unknown[]; options: { borderWidth: number } };
    expect(line.points).toHaveLength(60);
    expect(line.options.borderWidth).toBeGreaterThan(0);
  });
  test("plotly", async () => {
    const { elements } = await mount("01-line", "plotly");
    expect(plotlyTraces(elements[0]!)).toBe(1);
    const line = elements[0]!.querySelector(".scatterlayer .trace path.js-line")!;
    expect(line.getAttribute("d")!.split("L").length).toBeGreaterThan(50);
    expect(elements[0]!.querySelector(".gtitle")?.textContent).toBe("Request latency");
    expect(elements[0]!.querySelector(".ytitle")?.textContent).toBe("ms");
  });
  for (const library of ["tanstack", "tanstack-react"]) {
    test(library, async () => {
      const { elements } = await mount("01-line", library);
      expect(tanstackLines(elements[0]!)).toBe(1);
      expect(elements[0]!.textContent).toContain("ms");
    });
  }
});

describe("02: a multi-series chart", () => {
  for (const library of ["herceg", "herceg-react"]) {
    test(library, async () => {
      const { elements } = await mount("02-multi-series", library);
      expect(hercegSeries(elements[0]!)).toBe(3);
      const legend = [...elements[0]!.querySelectorAll("button")].map((b) => b.textContent);
      expect(legend).toEqual(["api", "web", "db"]);
    });
  }
  test("echarts", async () => {
    const { result } = await mount("02-multi-series", "echarts");
    expect(echartsSeries(result)).toBe(3);
    expect(echartsTexts(result)).toEqual(expect.arrayContaining(["api", "web", "db"]));
  });
  test("chartjs", async () => {
    const { result } = await mount("02-multi-series", "chartjs");
    const metas = (result as ChartJS).getSortedVisibleDatasetMetas();
    expect(metas.map((meta) => meta.label)).toEqual(["api", "web", "db"]);
    for (const meta of metas) expect(meta.data).toHaveLength(60);
  });
  test("plotly", async () => {
    const { elements } = await mount("02-multi-series", "plotly");
    expect(plotlyTraces(elements[0]!)).toBe(3);
    expect(elements[0]!.querySelector(".legend")?.textContent).toBe("apiwebdb");
  });
  test("tanstack", async () => {
    const { elements } = await mount("02-multi-series", "tanstack");
    expect(tanstackLines(elements[0]!)).toBe(3);
    expect(elements[0]!.textContent).toContain("api");
  });
});

describe("03: a custom tooltip", () => {
  // Hovering the middle of the plot shows the day's latency and request count.
  const shows = /\w{3}, \w{3} \d+: \d+ ms, [\d,]+ requests/;
  for (const library of ["tanstack", "tanstack-react", "echarts"]) {
    test(library, async () => {
      const { elements } = await mount("03-tooltip", library);
      await userEvent.hover(elements[0]!, { position: PLOT });
      await expect.poll(() => elements[0]!.textContent).toMatch(shows);
    });
  }
  // Herceg's built-in tooltip: the day, then a row per series and its fields.
  const tooltip = (element: Element) =>
    [...element.querySelectorAll<HTMLElement>('div[aria-hidden="true"]')].find((div) =>
      div.textContent?.includes("requests"),
    );
  for (const library of ["herceg", "herceg-react"]) {
    test(library, async () => {
      const { elements } = await mount("03-tooltip", library);
      await userEvent.hover(elements[0]!, { position: PLOT });
      await expect
        .poll(() => [...(tooltip(elements[0]!)?.children ?? [])].map((row) => row.textContent))
        .toEqual([
          expect.stringMatching(/^\w{3}, \w{3} \d+$/),
          expect.stringMatching(/^p99\d+ ms$/),
          expect.stringMatching(/^requests[\d,]+$/),
        ]);
    });
    test(`${library}: the tooltip stays inside the chart at its right edge`, async () => {
      const { elements } = await mount("03-tooltip", library);
      await userEvent.hover(elements[0]!, { position: { x: 625, y: 160 } });
      await expect
        .poll(() => tooltip(elements[0]!)?.getBoundingClientRect().width)
        .toBeGreaterThan(80);
      const box = elements[0]!.getBoundingClientRect();
      const rect = tooltip(elements[0]!)!.getBoundingClientRect();
      expect(rect.left).toBeGreaterThanOrEqual(box.left);
      expect(rect.right).toBeLessThanOrEqual(box.right);
    });
  }
  test("chartjs", async () => {
    const { elements, result } = await mount("03-tooltip", "chartjs");
    await userEvent.hover(elements[0]!, { position: PLOT });
    // The tooltip is painted on the canvas: read the lines Chart.js drew.
    await expect
      .poll(() => {
        const tip = (result as ChartJS).tooltip!;
        return `${tip.title.join("")}: ${tip.body.flatMap((part) => part.lines).join("")}`;
      })
      .toMatch(shows);
  });
  test("plotly", async () => {
    const { elements } = await mount("03-tooltip", "plotly");
    await userEvent.hover(elements[0]!.querySelector(".nsewdrag")!, {
      position: { x: 270, y: 100 },
    });
    await expect.poll(() => elements[0]!.querySelector(".hoverlayer")?.textContent).toMatch(shows);
  });
});

describe("04: a threshold rule and a labeled band", () => {
  for (const library of ["herceg", "herceg-react"]) {
    test(library, async () => {
      const { elements } = await mount("04-annotation", library);
      const labels = [...elements[0]!.querySelectorAll("svg text")].map((t) => t.textContent);
      expect(labels).toEqual(expect.arrayContaining(["SLO", "Incident"]));
    });
  }
  test("echarts", async () => {
    const { result } = await mount("04-annotation", "echarts");
    expect(echartsTexts(result)).toEqual(expect.arrayContaining(["SLO", "Incident"]));
  });
  test("chartjs", async () => {
    const { result } = await mount("04-annotation", "chartjs");
    const chart = result as ChartJS;
    // The rule is red across the plot at the objective's y.
    const y = Math.round(chart.scales.y!.getPixelForValue(250) * devicePixelRatio);
    const x = Math.round(((chart.chartArea.left + chart.chartArea.right) / 2) * devicePixelRatio);
    const [r, g, b] = chart.ctx.getImageData(x, y, 1, 1).data;
    expect(r).toBeGreaterThan(150);
    expect(g! + b!).toBeLessThan(200);
  });
  test("plotly", async () => {
    const { elements } = await mount("04-annotation", "plotly");
    expect(elements[0]!.querySelectorAll(".shapelayer path")).toHaveLength(2);
    expect(elements[0]!.textContent).toContain("SLO");
    expect(elements[0]!.textContent).toContain("Incident");
  });
  test("tanstack", async () => {
    const { elements } = await mount("04-annotation", "tanstack");
    const labels = [...elements[0]!.querySelectorAll("svg text")].map((t) => t.textContent);
    expect(labels).toEqual(expect.arrayContaining(["SLO", "Incident"]));
    expect(elements[0]!.querySelector(".ts-chart__rule, [class*=rule]")).not.toBeNull();
  });
});

describe("05: two charts sharing the cursor and zoom", () => {
  const ticks = (element: Element) =>
    [...element.querySelectorAll("svg text")].map((text) => text.textContent).join(" ");

  test("herceg", async () => {
    const { elements, result } = await mount("05-sync", "herceg", 2);
    const [top, bottom] = result as HercegChart[];
    await userEvent.hover(elements[0]!, { position: PLOT });
    await expect
      .poll(() => bottom!.root.querySelector("svg line")?.getAttribute("visibility"))
      .toBe("visible");
    await userEvent.wheel(elements[0]!, { delta: { y: -300 } });
    await expect.poll(() => bottom!.getViewport().x).not.toBeNull();
    expect(bottom!.getViewport().x).toEqual(top!.getViewport().x);
  });
  test("herceg-react", async () => {
    const { elements } = await mount("05-sync", "herceg-react");
    const [top, bottom] = elements[0]!.children as unknown as HTMLElement[];
    await userEvent.hover(top!, { position: PLOT });
    await expect
      .poll(() => bottom!.querySelector("svg line")?.getAttribute("visibility"))
      .toBe("visible");
    const before = ticks(bottom!);
    await userEvent.wheel(top!, { delta: { y: -300 } });
    await expect.poll(() => ticks(bottom!)).not.toBe(before);
  });
  test("echarts", async () => {
    const { elements, result } = await mount("05-sync", "echarts", 2);
    const [, bottom] = result as ECharts[];
    await userEvent.hover(elements[0]!, { position: PLOT });
    await expect.poll(() => elements[1]!.textContent).toMatch(/\d{1,2},\d{3}/);
    await userEvent.wheel(elements[0]!, { delta: { y: -300 } });
    await expect
      .poll(() => (bottom!.getOption().dataZoom as { start: number }[])[0]!.start)
      .toBeGreaterThan(0);
  });
  test("chartjs", async () => {
    const { elements, result } = await mount("05-sync", "chartjs", 2);
    const [top, bottom] = result as ChartJS[];
    await userEvent.hover(elements[0]!, { position: PLOT });
    await expect.poll(() => bottom!.tooltip!.getActiveElements().length).toBe(1);
    // The charts sit at the page's top left; the pointer leaves them to its right.
    await userEvent.hover(document.body, { position: { x: 900, y: 100 } });
    await expect.poll(() => bottom!.tooltip!.getActiveElements().length).toBe(0);
    const before = bottom!.scales.x!.min;
    const range = (chart: ChartJS) => [chart.scales.x!.min, chart.scales.x!.max];
    await userEvent.wheel(elements[0]!.querySelector("canvas")!, { delta: { y: -300 } });
    await expect.poll(() => bottom!.scales.x!.min).toBeGreaterThan(before);
    expect(range(bottom!)).toEqual(range(top!));
    await userEvent.wheel(elements[1]!.querySelector("canvas")!, { delta: { y: 300 } });
    expect(range(top!)).toEqual(range(bottom!));
  });
  test("plotly", async () => {
    const { elements } = await mount("05-sync", "plotly", 2);
    await userEvent.hover(elements[0]!.querySelector(".nsewdrag")!, {
      position: { x: 270, y: 100 },
    });
    await expect.poll(() => elements[1]!.querySelector(".hoverlayer")?.textContent).toMatch(/\d/);
    // Plotly zooms by dragging a box; a relayout is what the drag ends with.
    // Only the x range is shared: the requests plot keeps its own y range.
    const Plotly = (await import("plotly.js-dist-min")).default;
    const range: [number, number] = [Date.UTC(2026, 0, 10), Date.UTC(2026, 0, 20)];
    await Plotly.relayout(elements[0]!, { "xaxis.range": range, "yaxis.range": [100, 120] });
    type Plot = { layout: { xaxis: { range: unknown[] }; yaxis: { range: number[] } } };
    await expect.poll(() => (elements[1] as unknown as Plot).layout.xaxis.range).toEqual(range);
    expect((elements[1] as unknown as Plot).layout.yaxis.range[1]).toBeGreaterThan(1_000);
  });
  test("tanstack", async () => {
    // zoomX's surface takes the pointer, so hovering a zoomable plot moves no
    // cursor; only the zoom is shared.
    const { elements } = await mount("05-sync", "tanstack", 2);
    const before = ticks(elements[1]!);
    // The zoom control takes the wheel once the plot has focus.
    elements[0]!.querySelector<SVGElement>("[data-chart-zoom-surface]")!.focus();
    await userEvent.wheel(elements[0]!, { delta: { y: -300 } });
    await expect.poll(() => ticks(elements[1]!)).not.toBe(before);
  });
});

describe("06: streaming into a rolling window", () => {
  // 400 readings at 10 a second, of which the window keeps the last 300.
  async function stream(task: string, library: string) {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    cleanups.push(() => vi.useRealTimers());
    const mounted = await mount(task, library);
    await act(async () => vi.advanceTimersByTime(40_000));
    await settle();
    return mounted;
  }
  for (const library of ["herceg", "herceg-react"]) {
    test(library, async () => {
      const { elements } = await stream("06-streaming", library);
      await expect.poll(() => elements[0]!.textContent).toMatch(/cpu: 300 points/);
    });
  }
  test("echarts", async () => {
    const { result } = await stream("06-streaming", "echarts");
    const series = (result as { chart: ECharts }).chart.getOption().series as { data: unknown[] }[];
    expect(series[0]!.data).toHaveLength(300);
  });
  test("chartjs", async () => {
    const { result } = await stream("06-streaming", "chartjs");
    expect((result as { chart: ChartJS }).chart.getDatasetMeta(0).data).toHaveLength(300);
  });
  test("plotly", async () => {
    const { elements } = await stream("06-streaming", "plotly");
    const plot = elements[0] as unknown as { data: { x: unknown[] }[] };
    await expect.poll(() => plot.data[0]!.x.length).toBe(300);
  });
  for (const library of ["tanstack", "tanstack-react"]) {
    test(library, async () => {
      const { elements } = await stream("06-streaming", library);
      // One path through 300 points: a move and 299 line segments.
      await expect
        .poll(
          () =>
            elements[0]!.querySelector(".ts-chart__line path")?.getAttribute("d")?.match(/L/g)
              ?.length,
        )
        .toBe(299);
    });
  }
});

describe("07: a line of 100,000 points", () => {
  for (const library of ["herceg", "echarts", "chartjs", "plotly", "tanstack"]) {
    test(`${library} draws the line`, async () => {
      const { elements } = await mount("07-large", library);
      // A noisy line across the plot: far more blue pixels than axes have.
      await expect.poll(async () => blue(await screenshot(elements[0]!))).toBeGreaterThan(5_000);
    });
  }
  test("herceg", async () => {
    const { elements } = await mount("07-large", "herceg");
    expect(elements[0]!.textContent).toMatch(/value: 100000 points/);
    // Reduced to the first, lowest, highest, and last point of each pixel column.
    const path = elements[0]!.querySelector('path[fill="none"][stroke="#3266d6"]')!;
    expect(path.getAttribute("d")!.split("L").length).toBeLessThan(5_000);
  });
  test("echarts", async () => {
    const { result } = await mount("07-large", "echarts");
    // The line is one polyline, sampled to about two points per pixel column.
    const list = (
      (result as ECharts).getZr() as unknown as {
        storage: { getDisplayList(update: boolean): { shape?: { points?: ArrayLike<number> } }[] };
      }
    ).storage.getDisplayList(true);
    const points = Math.max(...list.map((element) => element.shape?.points?.length ?? 0)) / 2;
    expect(points).toBeGreaterThan(300);
    expect(points).toBeLessThan(5_000);
  });
  test("chartjs", async () => {
    const { result } = await mount("07-large", "chartjs");
    const drawn = (result as ChartJS).getDatasetMeta(0).data.length;
    // Decimation draws the minimum and maximum of each pixel column.
    expect(drawn).toBeGreaterThan(500);
    expect(drawn).toBeLessThan(100_000);
  });
  test("plotly", async () => {
    const { elements } = await mount("07-large", "plotly");
    expect(elements[0]!.querySelector(".gl-canvas-context")).not.toBeNull();
    expect(
      (elements[0] as unknown as { data: { x: ArrayLike<number> }[] }).data[0]!.x,
    ).toHaveLength(100_000);
  });
});

describe("08: a custom mark", () => {
  const libraries = ["herceg", "echarts", "chartjs", "plotly", "tanstack"];
  for (const library of libraries) {
    test(`${library} draws stems from zero`, async () => {
      const { elements } = await mount("08-custom-mark", library);
      // Every value is above 80 of 160 ms, so once the dots have settled (some
      // libraries animate them up from zero) the plot's lower part shows only stems.
      expect(blue(await still(elements[0]!), 200, 260)).toBeGreaterThan(400);
    });
  }
  test("each shows a tooltip at the nearest day", async () => {
    // What each tooltip shows, which axis labels are not part of.
    const tooltips: Record<string, (element: HTMLElement, result: unknown) => string | undefined> =
      {
        herceg: (element) =>
          [...element.querySelectorAll<HTMLElement>("div")].find(
            (div) => div.style.pointerEvents === "none" && div.style.display === "block",
          )?.textContent ?? undefined,
        echarts: (element) =>
          [...element.querySelectorAll<HTMLElement>("div")].find(
            (div) => div.style.zIndex === "9999999",
          )?.textContent ?? undefined,
        chartjs: (_, result) =>
          (result as ChartJS).tooltip!.body?.flatMap((part) => part.lines).join(""),
        plotly: (element) => element.querySelector(".hoverlayer")?.textContent ?? undefined,
        tanstack: (element) => element.querySelector(".ts-chart-tooltip")?.textContent ?? undefined,
      };
    for (const library of libraries) {
      const { elements, result } = await mount("08-custom-mark", library);
      const target = elements[0]!.querySelector(".nsewdrag") ?? elements[0]!;
      await userEvent.hover(target, { position: library === "plotly" ? { x: 270, y: 100 } : PLOT });
      const shows = () => tooltips[library]!(elements[0]!, result) ?? "";
      await expect
        .poll(() => p50.some((value) => shows().includes(String(value))), { message: library })
        .toBe(true);
      elements[0]!.remove();
    }
  });
  test("herceg", async () => {
    const { elements } = await mount("08-custom-mark", "herceg");
    // Circles are drawn as SVG paths of two arcs.
    expect(elements[0]!.querySelectorAll('[data-kind="shapes"] path[d*="a3 3"]')).toHaveLength(60);
    expect(elements[0]!.textContent).toContain("p50: 60 points");
  });
  test("echarts", async () => {
    const { result } = await mount("08-custom-mark", "echarts");
    const list = (
      (result as ECharts).getZr() as unknown as {
        storage: { getDisplayList(update: boolean): { type: string }[] };
      }
    ).storage.getDisplayList(true);
    expect(list.filter((element) => element.type === "circle")).toHaveLength(60);
  });
  test("chartjs", async () => {
    const { result } = await mount("08-custom-mark", "chartjs");
    expect((result as ChartJS).getDatasetMeta(0).data).toHaveLength(60);
  });
  test("plotly", async () => {
    const { elements } = await mount("08-custom-mark", "plotly");
    expect(elements[0]!.querySelectorAll(".shapelayer path")).toHaveLength(60);
    expect(elements[0]!.querySelectorAll(".scatterlayer .point")).toHaveLength(60);
  });
  test("tanstack", async () => {
    const { elements } = await mount("08-custom-mark", "tanstack");
    expect(elements[0]!.querySelectorAll(".ts-chart__marks circle")).toHaveLength(60);
  });
});

describe("09: a dark theme with a brand palette", () => {
  const palette = ["#5b8def", "#f08a4b", "#3fbf8f"];
  for (const library of ["herceg", "herceg-react", "echarts", "chartjs", "plotly", "tanstack"]) {
    test(library, async () => {
      const { elements } = await mount("09-theme", library);
      const pixels = await screenshot(elements[0]!);
      // The top left corner shows the dark surface; each series shows its brand color.
      expect(count(pixels, "#15171c") + count(pixels, "#100c2a")).toBeGreaterThan(
        pixels.width * pixels.height * 0.5,
      );
      for (const color of palette) expect(count(pixels, color)).toBeGreaterThan(50);
    });
  }
});

describe("10: export to SVG, PNG, and PDF", () => {
  async function decode(png: Blob | string): Promise<ImageData> {
    const blob = typeof png === "string" ? await (await fetch(png)).blob() : png;
    const image = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(image.width, image.height);
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#fff";
    context.fillRect(0, 0, image.width, image.height);
    context.drawImage(image, 0, 0);
    return context.getImageData(0, 0, image.width, image.height);
  }
  for (const library of ["herceg", "echarts", "chartjs", "plotly", "tanstack"]) {
    test(library, async () => {
      const { result } = await mount("10-export", library);
      const { svg, png, pdf } = result as { svg?: string; png: Blob | string; pdf?: Uint8Array };
      // The PNG shows the line, at least at the chart's size.
      const pixels = await decode(png);
      expect(pixels.width).toBeGreaterThanOrEqual(640);
      expect(blue(pixels)).toBeGreaterThan(400);
      // The SVG holds the axis title and the line (TanStack Charts draws no chart title).
      if (library === "chartjs") expect(svg).toBeUndefined();
      else {
        expect(svg).toMatch(/<svg[\s\S]*>ms<[\s\S]*<\/svg>\s*$/);
        if (library !== "tanstack") expect(svg).toContain("Request latency");
        expect(svg).toMatch(/<path[^>]* d="M[^"]{400,}"/);
      }
      if (library === "herceg") {
        const text = new TextDecoder("latin1").decode(pdf!);
        expect(text.startsWith("%PDF-")).toBe(true);
        // The title is the document's, written as UTF-16.
        const title = [..."Request latency"].map((c) =>
          c.charCodeAt(0).toString(16).padStart(4, "0"),
        );
        expect(text).toContain(`/Title <FEFF${title.join("").toUpperCase()}>`);
      } else expect(pdf).toBeUndefined();
    });
  }
});

describe("12: bars and a line over categories", () => {
  test("herceg", async () => {
    const { elements } = await mount("12-bar-line", "herceg");
    expect(hercegSeries(elements[0]!)).toBe(2);
    // The target is a line through the six months' bands.
    const lines = [...elements[0]!.querySelectorAll('path[fill="none"]')].map(
      (path) => path.getAttribute("d")?.split("L").length,
    );
    expect(lines).toContain(6);
  });
  test("echarts", async () => {
    const { result } = await mount("12-bar-line", "echarts");
    expect(echartsSeries(result)).toBe(2);
    expect(echartsTexts(result)).toEqual(expect.arrayContaining(["Jan", "Jun"]));
  });
  test("chartjs", async () => {
    const { result } = await mount("12-bar-line", "chartjs");
    const metas = (result as ChartJS).getSortedVisibleDatasetMetas();
    expect(metas.map((meta) => meta.type).sort()).toEqual(["bar", "line"]);
  });
  test("plotly", async () => {
    const { elements } = await mount("12-bar-line", "plotly");
    expect(plotlyTraces(elements[0]!)).toBe(2);
  });
  test("tanstack", async () => {
    const { elements } = await mount("12-bar-line", "tanstack");
    expect(tanstackLines(elements[0]!)).toBe(1);
    expect(elements[0]!.querySelectorAll(".ts-chart__marks rect").length).toBeGreaterThanOrEqual(6);
  });
});

// The "Mistake" columns of docs/comparison.md: what each library does with the
// error, observed rather than assumed.
describe("mistakes", () => {
  const [chartjs, echarts, herceg, plotly, tanstack] = [
    import("chart.js/auto"),
    import("echarts"),
    import("herceg"),
    import("plotly.js-dist-min"),
    import("@tanstack/charts"),
  ];

  test("01: a misspelled field", async () => {
    const { line, table, time } = await herceg;
    const latency = table({ time: time(days), p50 });
    expect(() => line(latency, { x: "time", y: "latncy" as never })).toThrow(
      'line y: no field "latncy"; the table has "time", "p50"',
    );
    // ECharts falls back to the dataset's first value column.
    const chart = (await echarts).init(box());
    cleanups.push(() => chart.dispose());
    chart.setOption({
      dataset: { source: { time: days, p50, p99 } },
      xAxis: { type: "time" },
      yAxis: {},
      series: [{ type: "line", encode: { x: "time", y: "latncy" } }],
    });
    const data = (
      chart as unknown as {
        getModel(): {
          getSeriesByIndex(i: number): { getData(): { mapDimension(d: string): string } };
        };
      }
    )
      .getModel()
      .getSeriesByIndex(0)
      .getData();
    expect(data.mapDimension("y")).toBe("p50");
    // Chart.js parses nothing from rows without the key, and draws nothing.
    const canvas = box().appendChild(document.createElement("canvas"));
    const { default: Chart } = await chartjs;
    const parsed = new Chart(canvas, {
      type: "line",
      data: { datasets: [{ data: daily as never }] },
      options: { animation: false, parsing: { xAxisKey: "time", yAxisKey: "latncy" } },
    });
    cleanups.push(() => parsed.destroy());
    const values = (parsed.getDatasetMeta(0) as unknown as { _parsed: { y: number | null }[] })
      ._parsed;
    expect(values.every(({ y }) => y === null)).toBe(true);
  });

  test("02: numbers as the series field", async () => {
    const { line, table, time } = await herceg;
    const rows = table({
      time: time(days),
      latency: p50,
      status: days.map((_, i) => (i % 2 ? 500 : 200)),
    });
    expect(() => line(rows, { x: "time", y: "latency", series: "status" as never })).toThrow(
      'line series: field "status" holds number values; expected category; give its values as strings, or numbers wrapped in category()',
    );
  });

  test("03: a misspelled tooltip field", async () => {
    const { line, table, time } = await herceg;
    const latency = table({ time: time(days), p99, requests });
    expect(() =>
      line(latency, { x: "time", y: "p99", tooltip: { fields: ["reqeusts" as never] } }),
    ).toThrow(
      'line tooltip.fields[0]: no field "reqeusts"; the table has "time", "p99", "requests"',
    );
  });

  test("04: dates as strings", async () => {
    const { region } = await herceg;
    expect(() => region({ x1: "2026-01-21", x2: "2026-01-25" } as never)).toThrow(
      'region x1: "2026-01-21" names a field, and fields need a table; pass the table first, or give a number or Date',
    );
    const { defineChart, mountChart, rect } = await tanstack;
    const { scaleUtc } = await import("d3-scale");
    const { scaleLinear } = await import("@tanstack/charts/scales/linear");
    const band = [{ start: "2026-01-21", end: "2026-01-25", low: 0, high: 1 }];
    expect(() =>
      mountChart(box(), {
        ariaLabel: "Band",
        definition: defineChart({
          marks: [rect(band, { x1: "start", x2: "end", y1: "low", y2: "high" })],
          scales: { x: { scale: scaleUtc }, y: { scale: scaleLinear } },
        }),
      }),
    ).toThrow("A temporal scale factory requires Date channel values");
  });

  test("05: zoom turned on in one synced chart only", async () => {
    const { createChart, line, table, time } = await herceg;
    const latency = table({ time: time(days), p50 });
    const [a, b] = [box(), box()];
    const zooms = createChart(a, {
      marks: [line(latency, { x: "time", y: "p50" })],
      interaction: { zoom: "x", sync: "one" },
    });
    const follows = createChart(b, {
      marks: [line(latency, { x: "time", y: "p50" })],
      interaction: { sync: "one" },
    });
    cleanups.push(
      () => zooms.destroy(),
      () => follows.destroy(),
    );
    await userEvent.wheel(a, { delta: { y: -300 } });
    await expect.poll(() => follows.getViewport().x).toEqual(zooms.getViewport().x);
    // ECharts' connected chart without dataZoom keeps its range.
    const ec = await echarts;
    const option = (zoom: boolean) => ({
      dataset: { source: { time: days, p50 } },
      xAxis: { type: "time" },
      yAxis: {},
      dataZoom: zoom ? [{ type: "inside" }] : [],
      series: [{ type: "line", encode: { x: "time", y: "p50" } }],
    });
    const [c, d] = [box(), box()];
    const [first, second] = [ec.init(c), ec.init(d)];
    cleanups.push(
      () => first.dispose(),
      () => second.dispose(),
    );
    first.setOption(option(true));
    second.setOption(option(false));
    ec.connect([first, second]);
    await userEvent.wheel(c, { delta: { y: -300 } });
    await expect
      .poll(() => (first.getOption().dataZoom as { start: number }[])[0]!.start)
      .toBeGreaterThan(0);
    const extent = (
      second as unknown as {
        getModel(): { getComponent(type: string): { axis: { scale: { getExtent(): number[] } } } };
      }
    )
      .getModel()
      .getComponent("xAxis")
      .axis.scale.getExtent();
    expect(extent).toEqual([days[0], days.at(-1)]);
  });

  test("06: writing into a typed array the table borrowed", async () => {
    const { createChart, line, table, time } = await herceg;
    const values = Float64Array.from(p50);
    const latency = table({ time: time(days), v: values });
    const element = box();
    const chart = createChart(element, { marks: [line(latency, { x: "time", y: "v" })] });
    cleanups.push(() => chart.destroy());
    const drawn = () =>
      element.querySelector('path[fill="none"][stroke="#3266d6"]')?.getAttribute("d");
    const before = drawn();
    values[59] = 400;
    await settle();
    expect(drawn()).toBe(before);
    latency.set("v", 59, 400);
    await settle();
    expect(drawn()).not.toBe(before);
  });

  test("09: a misspelled theme name", async () => {
    const { createChart, line, table, time } = await herceg;
    const latency = table({ time: time(days), p50 });
    expect(() =>
      createChart(box(), {
        theme: "drak" as never,
        marks: [line(latency, { x: "time", y: "p50" })],
      }),
    ).toThrow(
      'theme: no theme "drak"; use "light", "dark", "high-contrast", "high-contrast-dark", "auto"',
    );
    // ECharts draws in its default theme; plotly.js ignores Plotly Python's template names.
    const chart = (await echarts).init(box(), "drak");
    cleanups.push(() => chart.dispose());
    expect(() => chart.setOption({ xAxis: { type: "time" }, yAxis: {}, series: [] })).not.toThrow();
    const { default: Plotly } = await plotly;
    const plot = box();
    cleanups.push(() => Plotly.purge(plot));
    await Plotly.newPlot(plot, [{ x: days, y: p50 }], { template: "plotly_dark" as never });
    expect(
      (plot as unknown as { _fullLayout: { paper_bgcolor: string } })._fullLayout.paper_bgcolor,
    ).toBe("#fff");
  });

  test("10: exporting an animated chart at once", async () => {
    const ec = await echarts;
    const option = (animation: boolean) => ({
      animation,
      dataset: { source: { time: days, p50 } },
      xAxis: { type: "time" },
      yAxis: {},
      series: [{ type: "line", encode: { x: "time", y: "p50" } }],
    });
    const exported = async (url: string) => {
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = Object.assign(document.createElement("canvas"), {
        width: image.width,
        height: image.height,
      });
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      return blue(context.getImageData(0, 0, image.width, image.height));
    };
    const [animated, still] = [ec.init(box()), ec.init(box())];
    cleanups.push(
      () => animated.dispose(),
      () => still.dispose(),
    );
    animated.setOption(option(true));
    still.setOption(option(false));
    expect(await exported(animated.getDataURL())).toBeLessThan(
      (await exported(still.getDataURL())) / 2,
    );
    const { default: Chart } = await chartjs;
    const chart = (animation: false | undefined) =>
      new Chart(box().appendChild(document.createElement("canvas")), {
        type: "line",
        data: { labels: days, datasets: [{ data: p50 }] },
        options: animation === false ? { animation } : {},
      });
    const [moving, settled] = [chart(undefined), chart(false)];
    cleanups.push(
      () => moving.destroy(),
      () => settled.destroy(),
    );
    expect(await exported(moving.toBase64Image())).toBeLessThan(
      (await exported(settled.toBase64Image())) / 2,
    );
  });
});
