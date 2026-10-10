import { defineChart, lineY } from "@tanstack/charts";
import { Chart } from "@tanstack/charts/react";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { tooltip } from "@tanstack/charts/tooltip";
import { scaleUtc } from "d3-scale";
import { daily } from "../data.ts";

const rows = daily.map((row) => ({ ...row, time: new Date(row.time) }));
const latency = defineChart({
  marks: [lineY(rows, { x: "time", y: "p50" })],
  scales: {
    x: { scale: scaleUtc },
    y: { scale: scaleLinear, nice: true, axis: { label: "ms" } },
  },
  focus: "group-x",
  tooltip,
});

export function Example() {
  return <Chart definition={latency} ariaLabel="Request latency" />;
}
