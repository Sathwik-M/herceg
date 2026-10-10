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
  // plotly.js bundles no named templates ("plotly_dark" is Plotly Python's): set the colors.
  const axis = { gridcolor: "#2c3038", zerolinecolor: "#2c3038" };
  return Plotly.newPlot(container, traces, {
    title: { text: "Latency by service" },
    hovermode: "x",
    paper_bgcolor: "#15171c",
    plot_bgcolor: "#15171c",
    font: { color: "#e6e8ec" },
    colorway: ["#5b8def", "#f08a4b", "#3fbf8f"],
    xaxis: { ...axis, type: "date" },
    yaxis: { ...axis, title: { text: "ms" } },
  });
}
