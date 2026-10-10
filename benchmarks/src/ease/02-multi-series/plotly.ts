import Plotly from "plotly.js-dist-min";
import { serviceRows } from "../data.ts";

export function render(container: HTMLElement) {
  const services = [...new Set(serviceRows.map((row) => row.service))];
  const traces = services.map((service) => {
    const rows = serviceRows.filter((row) => row.service === service);
    return {
      type: "scatter" as const,
      mode: "lines" as const,
      name: service,
      x: rows.map((row) => row.time),
      y: rows.map((row) => row.latency),
    };
  });
  return Plotly.newPlot(container, traces, {
    title: { text: "Latency by service" },
    hovermode: "x",
    xaxis: { type: "date" },
    yaxis: { title: { text: "ms" } },
  });
}
