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
      focus: "group-x",
      tooltip,
    }),
  });
}
