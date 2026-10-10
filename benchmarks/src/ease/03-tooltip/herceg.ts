import { createChart, line, table, time } from "herceg";
import { days, p99, requests } from "../data.ts";

export function render(container: HTMLElement) {
  const latency = table({ time: time(days), p99, requests });
  return createChart(container, {
    title: "Request latency",
    locale: "en-US",
    timeZone: "UTC",
    marks: [line(latency, { x: "time", y: "p99", tooltip: { fields: ["requests"] } })],
    // Tooltips write values with these; tick labels keep their own.
    x: { tooltipFormat: { weekday: "short", month: "short", day: "numeric" } },
    y: { title: "ms", tooltipFormat: { style: "unit", unit: "millisecond" } },
  });
}
