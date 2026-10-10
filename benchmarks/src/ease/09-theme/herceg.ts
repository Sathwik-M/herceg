import { createChart, line, table, time } from "herceg";
import { serviceColumns } from "../data.ts";

export function render(container: HTMLElement) {
  const latency = table({ ...serviceColumns, time: time(serviceColumns.time) });
  return createChart(container, {
    title: "Latency by service",
    marks: [line(latency, { x: "time", y: "latency", series: "service" })],
    y: { title: "ms" },
    // The dark theme is transparent, to take a dark page's background; this page is light.
    theme: { extends: "dark", background: "#15171c", palette: ["#5b8def", "#f08a4b", "#3fbf8f"] },
  });
}
