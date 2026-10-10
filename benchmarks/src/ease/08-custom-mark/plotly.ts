import Plotly from "plotly.js-dist-min";
import { days, p50 } from "../data.ts";

export function render(container: HTMLElement) {
  // Plotly has no custom marks: dots are a trace, and each stem is a layout shape.
  const stems = days.map((x, i) => ({
    type: "line" as const,
    x0: x,
    x1: x,
    y0: 0,
    y1: p50[i]!,
    line: { color: "#1f77b4", width: 1 },
  }));
  return Plotly.newPlot(
    container,
    [{ type: "scatter", mode: "markers", name: "p50", x: days, y: p50 }],
    {
      title: { text: "Request latency" },
      hovermode: "x",
      xaxis: { type: "date" },
      yaxis: { title: { text: "ms" }, rangemode: "tozero" },
      shapes: stems,
    },
  );
}
