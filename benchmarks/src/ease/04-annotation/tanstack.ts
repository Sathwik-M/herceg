import { defineChart, lineY, mountChart, rect, ruleY, text } from "@tanstack/charts";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { tooltip } from "@tanstack/charts/tooltip";
import { scaleUtc } from "d3-scale";
import { daily, incident, SLO } from "../data.ts";

export function render(container: HTMLElement) {
  const rows = daily.map((row) => ({ ...row, time: new Date(row.time) }));
  // Rects span y values, not the plot: give the band the data's y extent.
  const band = {
    start: new Date(incident.start),
    end: new Date(incident.end),
    low: Math.min(...rows.map((row) => row.p99)),
    high: Math.max(...rows.map((row) => row.p99), SLO),
  };
  return mountChart(container, {
    ariaLabel: "Request latency",
    definition: defineChart({
      marks: [
        rect([band], { x1: "start", x2: "end", y1: "low", y2: "high", fillOpacity: 0.15 }),
        text([band], {
          x: "start",
          y: "high",
          text: () => incident.label,
          anchor: "start",
          dx: 4,
          dy: 8,
        }),
        lineY(rows, { x: "time", y: "p99" }),
        ruleY([SLO], { stroke: "#d33" }),
        text([SLO], {
          x: () => rows.at(-1)!.time,
          y: (value) => value,
          text: () => "SLO",
          anchor: "end",
          dy: -8,
        }),
      ],
      scales: {
        x: { scale: scaleUtc },
        y: { scale: scaleLinear, nice: true, axis: { label: "ms" } },
      },
      focus: "group-x",
      tooltip,
    }),
  });
}
