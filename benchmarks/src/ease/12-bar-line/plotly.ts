import Plotly from "plotly.js-dist-min";
import { months, revenue, target } from "../data.ts";

export function render(container: HTMLElement) {
  return Plotly.newPlot(
    container,
    [
      { type: "bar", name: "revenue", x: months, y: revenue },
      { type: "scatter", mode: "lines+markers", name: "target", x: months, y: target },
    ],
    { title: { text: "Revenue" }, hovermode: "x", yaxis: { title: { text: "k$" } } },
  );
}
