import Chart from "chart.js/auto";
import "chartjs-adapter-date-fns";
import { days, p50 } from "../data.ts";

export function render(container: HTMLElement) {
  const canvas = document.createElement("canvas");
  container.append(canvas);
  return new Chart(canvas, {
    type: "line",
    data: { labels: days, datasets: [{ label: "p50", data: p50 }] },
    options: {
      interaction: { mode: "index", intersect: false },
      plugins: { title: { display: true, text: "Request latency" } },
      scales: { x: { type: "time" }, y: { title: { display: true, text: "ms" } } },
    },
  });
}
