import { defineChart, lineY } from "@tanstack/charts";
import { mountCanvasChart } from "@tanstack/charts/canvas";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { tooltip } from "@tanstack/charts/tooltip";
import { scaleUtc } from "d3-scale";
import { BIG, bigTime, bigValue } from "../data.ts";

export function render(container: HTMLElement) {
  const rows = Array.from({ length: BIG }, (_, i) => ({
    time: new Date(bigTime[i]!),
    value: bigValue[i]!,
  }));
  // Canvas is TanStack's opt-in renderer for paint-heavy marks.
  return mountCanvasChart(container, {
    ariaLabel: "Signal",
    definition: defineChart({
      marks: [lineY(rows, { x: "time", y: "value", strokeWidth: 1 })],
      scales: { x: { scale: scaleUtc }, y: { scale: scaleLinear, nice: true } },
      focus: "nearest-x",
      tooltip,
    }),
  });
}
