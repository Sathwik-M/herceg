import { category, createChart, heatmap, table } from "herceg";

export function render(element: HTMLElement, x: Float64Array, y: Float64Array) {
  const hosts = Array.from(x, (_, i) => `host ${i % 12}`);
  return createChart(element, {
    marks: [
      heatmap(table({ x, host: category(hosts), value: y }), { x: "x", y: "host", color: "value" }),
    ],
  });
}
