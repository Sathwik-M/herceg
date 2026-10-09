import { createChart, point, table } from "herceg";

export function render(element: HTMLElement, x: Float64Array, y: Float64Array) {
  return createChart(element, {
    marks: [point(table({ x, y }), { x: "x", y: "y" })],
  });
}
