import { createChart, line, table, time } from "herceg";
import { serviceColumns } from "../data.ts";

export function render(container: HTMLElement) {
  const latency = table({ ...serviceColumns, time: time(serviceColumns.time) });
  return createChart(container, {
    title: "Latency by service",
    marks: [line(latency, { x: "time", y: "latency", series: "service" })],
    y: { title: "ms" },
  });
}
