import { colorLegend, defineChart, lineY, mountChart } from "@tanstack/charts";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { tooltip } from "@tanstack/charts/tooltip";
import { scaleUtc } from "d3-scale";
import { serviceRows } from "../data.ts";

export function render(container: HTMLElement) {
  const rows = serviceRows.map((row) => ({ ...row, time: new Date(row.time) }));
  return mountChart(container, {
    ariaLabel: "Latency by service",
    definition: defineChart({
      marks: [lineY(rows, { x: "time", y: "latency", color: "service" })],
      scales: {
        x: { scale: scaleUtc },
        y: { scale: scaleLinear, nice: true, axis: { label: "ms" } },
      },
      color: { legend: colorLegend() },
      theme: {
        foreground: "#e6e8ec",
        muted: "#a0a6b0",
        grid: "#2c3038",
        background: "#15171c",
        palette: ["#5b8def", "#f08a4b", "#3fbf8f"],
      },
      focus: "group-x",
      tooltip,
    }),
  });
}
