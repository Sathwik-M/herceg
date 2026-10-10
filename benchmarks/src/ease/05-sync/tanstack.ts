import { defineChart, lineY, mountChart } from "@tanstack/charts";
import { createChartCursor, cursorHost } from "@tanstack/charts/cursor";
import { controlledSignal } from "@tanstack/charts/interaction/signal";
import { type ZoomXWindow, zoomX } from "@tanstack/charts/interaction/zoom";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { tooltip } from "@tanstack/charts/tooltip";
import { scaleUtc } from "d3-scale";
import { daily } from "../data.ts";

export function render(top: HTMLElement, bottom: HTMLElement) {
  const rows = daily.map((row) => ({ ...row, time: new Date(row.time) }));
  const extent = [rows[0]!.time, rows.at(-1)!.time] as const;
  // One cursor controller shared by both charts, matched by x value.
  const cursor = {
    use: cursorHost,
    controller: createChartCursor<Date, number>(),
    mode: "focus",
    match: "x",
  } as const;
  // The application owns the zoomed window and rebuilds both charts from it.
  let window: ZoomXWindow<Date> = { start: extent[0], end: extent[1] };
  // The rows in the window and one on each side, so lines reach the plot's edges.
  const visible = () =>
    rows.filter(
      (row, i) =>
        (rows[i + 1] ?? row).time >= window.start && (rows[i - 1] ?? row).time <= window.end,
    );
  const define = (y: "p50" | "requests") =>
    defineChart({
      marks: [lineY(visible(), { x: "time", y })],
      clip: true,
      scales: {
        x: { scale: scaleUtc().domain([window.start, window.end]) },
        y: { scale: scaleLinear, nice: true },
      },
      focus: "group-x",
      tooltip,
      cursor,
      controls: [zoomX({ window: controlledSignal(window, zoomTo), extent })],
    });
  const charts = [
    mountChart(top, { ariaLabel: "Latency", definition: define("p50") }),
    mountChart(bottom, { ariaLabel: "Requests", definition: define("requests") }),
  ];
  function zoomTo(next: ZoomXWindow<Date>) {
    window = next;
    charts[0]!.update({ ariaLabel: "Latency", definition: define("p50") });
    charts[1]!.update({ ariaLabel: "Requests", definition: define("requests") });
  }
  return charts;
}
