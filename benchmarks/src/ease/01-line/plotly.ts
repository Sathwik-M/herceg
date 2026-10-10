import Plotly from "plotly.js-dist-min";
import { days, p50 } from "../data.ts";

export function render(container: HTMLElement) {
  return Plotly.newPlot(
    container,
    [{ type: "scatter", mode: "lines", name: "p50", x: days, y: p50 }],
    {
      title: { text: "Request latency" },
      xaxis: { type: "date" },
      yaxis: { title: { text: "ms" } },
    },
  );
}
