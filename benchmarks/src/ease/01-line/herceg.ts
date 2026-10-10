import { createChart, line, table, time } from "herceg";
import { days, p50 } from "../data.ts";

export function render(container: HTMLElement) {
  const latency = table({ time: time(days), p50 });
  return createChart(container, {
    title: "Request latency",
    marks: [line(latency, { x: "time", y: "p50" })],
    y: { title: "ms" },
  });
}
