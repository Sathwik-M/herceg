import { createChart, line, table, time } from "herceg";
import { renderToPDF } from "herceg/pdf";
import { days, p50 } from "../data.ts";

export async function render(container: HTMLElement) {
  const latency = table({ time: time(days), p50 });
  const chart = createChart(container, {
    title: "Request latency",
    width: 640,
    height: 320,
    marks: [line(latency, { x: "time", y: "p50" })],
    y: { title: "ms" },
  });
  const svg = chart.toSVG();
  const png = await chart.toPNG({ scale: 2 });
  // The chart as it is now: zoomed, with series hidden.
  const pdf = renderToPDF(chart);
  return { chart, svg, png, pdf };
}
