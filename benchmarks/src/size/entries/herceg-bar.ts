import { bar, category, createChart, table } from "herceg";

export function render(element: HTMLElement, x: Float64Array, y: Float64Array) {
  const regions = Array.from(x, (_, i) => `region ${i % 12}`);
  return createChart(element, {
    marks: [
      bar(table({ region: category(regions), sales: y, kind: category(regions) }), {
        x: "region",
        y: "sales",
        series: "kind",
        stack: true,
      }),
    ],
  });
}
