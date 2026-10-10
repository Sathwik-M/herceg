import { defineChart, lineY, mountChart } from "@tanstack/charts";
import { renderChartImage, serializeChartSvg } from "@tanstack/charts/export";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { scaleUtc } from "d3-scale";
import { daily } from "../data.ts";

export async function render(container: HTMLElement) {
  const rows = daily.map((row) => ({ ...row, time: new Date(row.time) }));
  const chart = mountChart(container, {
    ariaLabel: "Request latency",
    definition: defineChart({
      marks: [lineY(rows, { x: "time", y: "p50" })],
      scales: {
        x: { scale: scaleUtc },
        y: { scale: scaleLinear, nice: true, axis: { label: "ms" } },
      },
    }),
  });
  const svg = serializeChartSvg(container);
  const png = await renderChartImage(container, { type: "image/png", scale: 2 });
  return { chart, svg, png, pdf: undefined };
}
