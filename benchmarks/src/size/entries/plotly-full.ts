import Plotly from "plotly.js-dist-min";

export function render(element: HTMLElement, x: number[], y: number[]) {
  return Plotly.newPlot(element, [{ type: "scatter", mode: "lines", x, y }], {
    xaxis: { type: "date" },
  });
}
