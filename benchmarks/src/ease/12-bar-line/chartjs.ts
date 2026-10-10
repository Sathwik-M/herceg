import Chart from "chart.js/auto";
import { months, revenue, target } from "../data.ts";

export function render(container: HTMLElement) {
  const canvas = document.createElement("canvas");
  container.append(canvas);
  return new Chart(canvas, {
    type: "bar",
    data: {
      labels: months,
      datasets: [
        { label: "revenue", data: revenue },
        { type: "line", label: "target", data: target },
      ],
    },
    options: {
      interaction: { mode: "index", intersect: false },
      plugins: { title: { display: true, text: "Revenue" } },
      scales: { y: { title: { display: true, text: "k$" } } },
    },
  });
}
