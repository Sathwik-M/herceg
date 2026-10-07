import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

export function render(element: HTMLElement, x: number[], y: number[]) {
  return new uPlot(
    { width: 800, height: 400, ms: 1, series: [{}, { stroke: "blue" }] },
    [x, y],
    element,
  );
}
