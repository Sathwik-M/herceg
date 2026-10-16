// A dashboard of subplots against one panel drawing the same marks: the
// time a layout of nested columns with an inset adds to rendering,
// resizing, and the pointer.
import { type Chart, type ChartMark, createChart, line, panels, table } from "herceg";
import { columns, inset, panel, rows } from "herceg/layout";

export type Shape = "single" | "dashboard";

export interface Sample {
  /** createChart through its first frame, drawn synchronously. */
  mounts: number[];
  /** A new size, drawn synchronously. */
  resizes: number[];
  /**
   * A pointer move's work: its event, then the chart's part of the next
   * frame, which draws the crosshair and tooltip (to when a callback asked
   * for after the chart's runs, from the frame's start).
   */
  pointers: number[];
}

const POINTS = 2_000;
const SERIES = 3;
const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));

/** A table of three series of `POINTS` points, offset by `seed`. */
function metrics(seed: number) {
  const n = POINTS * SERIES;
  return table({
    t: Float64Array.from({ length: n }, (_, i) => i % POINTS),
    v: Float64Array.from(
      { length: n },
      (_, i) => Math.sin((i % POINTS) / 40 + seed + Math.floor(i / POINTS)) * 10 + seed,
    ),
    service: Array.from({ length: n }, (_, i) => `s${Math.floor(i / POINTS)}`),
  });
}

const tables = [0, 1, 2, 3, 4].map(metrics);

/** The marks of the five plots: in panels, or all in the one panel. */
function marksOf(shape: Shape): ChartMark[] {
  const ids = ["latency", "errors", "traffic", "saturation", "detail"];
  return tables.map((data, i) =>
    line(data, {
      x: "t",
      y: "v",
      color: "service",
      ...(shape === "dashboard" && { panel: ids[i]! }),
    }),
  );
}

function optionsOf(shape: Shape) {
  return {
    marks: marksOf(shape),
    locale: "en-US",
    renderer: "canvas" as const,
    ...(shape === "dashboard" && {
      panels: panels(
        columns(
          [2, 1],
          [
            rows(
              [2, 1],
              [
                panel({ id: "latency", title: "Latency" }, [
                  inset({ id: "detail", x: { domain: [400, 600] } }, { indicator: true }),
                ]),
                panel({ id: "errors", title: "Errors" }),
              ],
            ),
            rows(
              [1, 1],
              [
                panel({ id: "traffic", title: "Traffic" }),
                panel({ id: "saturation", title: "Saturation" }),
              ],
            ),
          ],
        ),
      ),
    }),
  };
}

async function sample(shape: Shape): Promise<Sample> {
  const host = document.querySelector<HTMLElement>("#chart")!;
  const out: Sample = { mounts: [], resizes: [], pointers: [] };
  for (let i = 0; i < 20; i++) {
    const start = performance.now();
    const chart = createChart(host, optionsOf(shape));
    chart.render();
    out.mounts.push(performance.now() - start);
    await chart.loading;
    if (i < 19) chart.destroy();
    else await measure(chart, out);
  }
  return out;
}

async function measure(chart: Chart, out: Sample): Promise<void> {
  const host = chart.root.parentElement!;
  for (let i = 0; i < 40; i++) {
    host.style.width = `${i % 2 ? 1000 : 900}px`;
    const start = performance.now();
    chart.render();
    out.resizes.push(performance.now() - start);
    await frame();
  }
  host.style.width = "1000px";
  chart.render();
  const rect = chart.root.getBoundingClientRect();
  const plots = chart.getPanels().map(({ plot }) => plot);
  for (let i = 0; i < 120; i++) {
    const plot = plots[i % plots.length]!;
    await frame();
    const start = performance.now();
    chart.root.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        clientX: rect.left + plot.x + ((i * 37) % plot.width),
        clientY: rect.top + plot.y + plot.height / 2,
        pointerId: 1,
      }),
    );
    const event = performance.now() - start;
    const drawn = await new Promise<number>((resolve) =>
      requestAnimationFrame((at) => resolve(performance.now() - at)),
    );
    out.pointers.push(event + drawn);
  }
  chart.destroy();
}

const api = { sample };
declare global {
  interface Window {
    layouts: typeof api;
  }
}
window.layouts = api;
