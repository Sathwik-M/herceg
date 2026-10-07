import { createChart, line, table, time } from "herceg";

export function render(element: HTMLElement, x: Float64Array, y: Float64Array) {
  return createChart(element, {
    marks: [line(table({ t: time(x), v: y }), { x: "t", y: "v" })],
  });
}
