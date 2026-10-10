import { barY, defineChart, lineY, mountChart } from "@tanstack/charts";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { tooltip } from "@tanstack/charts/tooltip";
import { monthly } from "../data.ts";

export function render(container: HTMLElement) {
  return mountChart(container, {
    ariaLabel: "Revenue",
    definition: defineChart({
      marks: [
        barY(monthly, { x: "month", y: "revenue" }),
        lineY(monthly, { x: "month", y: "target", points: true, stroke: "#f97316" }),
      ],
      scales: {
        x: { scale: () => scaleBand<string>().padding(0.2) },
        y: { scale: scaleLinear, nice: true, axis: { label: "k$" } },
      },
      focus: "group-x",
      tooltip,
    }),
  });
}
