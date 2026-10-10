import { defineChart, lineY, mountChart } from "@tanstack/charts";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { tooltip } from "@tanstack/charts/tooltip";
import { scaleUtc } from "d3-scale";
import { daily } from "../data.ts";

const date = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

export function render(container: HTMLElement) {
  const rows = daily.map((row) => ({ ...row, time: new Date(row.time) }));
  return mountChart(container, {
    ariaLabel: "Request latency",
    definition: defineChart({
      marks: [lineY(rows, { x: "time", y: "p99" })],
      scales: {
        x: { scale: scaleUtc },
        y: { scale: scaleLinear, nice: true, axis: { label: "ms" } },
      },
      focus: "group-x",
      tooltip: {
        use: tooltip,
        format: ({ datum }) =>
          `${date.format(datum.time)}: ${datum.p99} ms, ${datum.requests.toLocaleString("en-US")} requests`,
      },
    }),
  });
}
