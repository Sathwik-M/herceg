import Plotly from "plotly.js-dist-min";
import { days, incident, p99, SLO } from "../data.ts";

export function render(container: HTMLElement) {
  return Plotly.newPlot(
    container,
    [{ type: "scatter", mode: "lines", name: "p99", x: days, y: p99 }],
    {
      title: { text: "Request latency" },
      xaxis: { type: "date" },
      yaxis: { title: { text: "ms" } },
      shapes: [
        {
          type: "rect",
          xref: "x",
          yref: "paper",
          x0: incident.start,
          x1: incident.end,
          y0: 0,
          y1: 1,
          fillcolor: "gray",
          opacity: 0.2,
          line: { width: 0 },
          label: { text: incident.label, textposition: "top left" },
        },
        {
          type: "line",
          xref: "paper",
          x0: 0,
          x1: 1,
          y0: SLO,
          y1: SLO,
          line: { color: "#d33" },
          label: { text: "SLO", textposition: "end" },
        },
      ],
    },
  );
}
