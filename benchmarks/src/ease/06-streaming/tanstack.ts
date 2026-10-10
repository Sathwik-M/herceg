import { defineChart, lineY, mountChart } from "@tanstack/charts";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { tooltip } from "@tanstack/charts/tooltip";
import { scaleUtc } from "d3-scale";
import { reading } from "../data.ts";

type Reading = { time: Date; cpu: number };

function definition(rows: readonly Reading[]) {
  return defineChart({
    marks: [lineY(rows, { x: "time", y: "cpu" })],
    scales: { x: { scale: scaleUtc }, y: { scale: scaleLinear, nice: true } },
    focus: "group-x",
    tooltip,
  });
}

export function render(container: HTMLElement) {
  let rows: Reading[] = [];
  const chart = mountChart(container, { ariaLabel: "CPU", definition: definition(rows) });
  let i = 0;
  const timer = setInterval(() => {
    const { time, cpu } = reading(i++);
    // A new definition per change is TanStack's update path.
    rows = [...rows.slice(-299), { time: new Date(time), cpu }];
    chart.update({ ariaLabel: "CPU", definition: definition(rows) });
  }, 100);
  return { chart, stop: () => clearInterval(timer) };
}
