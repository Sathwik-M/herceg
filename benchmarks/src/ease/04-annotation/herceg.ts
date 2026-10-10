import { createChart, line, region, rule, table, time } from "herceg";
import { days, incident, p99, SLO } from "../data.ts";

export function render(container: HTMLElement) {
  const latency = table({ time: time(days), p99 });
  return createChart(container, {
    title: "Request latency",
    marks: [
      region({ x1: incident.start, x2: incident.end, label: incident.label }),
      line(latency, { x: "time", y: "p99" }),
      rule({ y: SLO, label: "SLO" }),
    ],
    y: { title: "ms" },
  });
}
