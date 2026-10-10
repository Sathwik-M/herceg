import { bar, createChart, point, table } from "herceg";
import { months, revenue, target } from "../data.ts";

export function render(container: HTMLElement) {
  const sales = table({ month: months, revenue, target });
  return createChart(container, {
    title: "Revenue",
    marks: [
      bar(sales, { x: "month", y: "revenue" }),
      // Not yet possible: a line needs a number or time x, so the target is drawn as points.
      point(sales, { x: "month", y: "target", radius: 4 }),
    ],
    y: { title: "k$" },
  });
}
