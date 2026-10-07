import { defineChart, lineY } from "@tanstack/charts";
import { mountChart } from "@tanstack/charts/dom";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { tooltip } from "@tanstack/charts/tooltip";
import { scaleUtc } from "d3-scale";

export function render(element: HTMLElement, x: number[], y: number[]) {
  const rows = x.map((t, i) => ({ t: new Date(t), v: y[i]! }));
  return mountChart(element, {
    definition: defineChart({
      marks: [lineY(rows, { x: "t", y: "v" })],
      scales: { x: { scale: scaleUtc }, y: { scale: scaleLinear, nice: true } },
      focus: "group-x",
      tooltip,
    }),
    ariaLabel: "Line chart",
  });
}
