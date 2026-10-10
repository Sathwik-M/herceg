import Plotly from "plotly.js-dist-min";
import { bigTime, bigValue } from "../data.ts";

export function render(container: HTMLElement) {
  // scattergl, drawn with WebGL, is Plotly's trace for large data (plain scatter simplifies its SVG path).
  const trace = { type: "scattergl" as const, mode: "lines" as const, x: bigTime, y: bigValue };
  return Plotly.newPlot(container, [trace], {
    title: { text: "Signal" },
    hovermode: "x",
    xaxis: { type: "date" },
  });
}
