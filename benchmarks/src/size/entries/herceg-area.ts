import { area, category, createChart, table, time } from "herceg";

export function render(element: HTMLElement, x: Float64Array, y: Float64Array) {
  const services = Array.from(x, (_, i) => ["api", "web", "db"][i % 3]!);
  return createChart(element, {
    marks: [
      area(table({ t: time(x), v: y, service: category(services) }), {
        x: "t",
        y: "v",
        series: "service",
        stack: true,
      }),
    ],
  });
}
