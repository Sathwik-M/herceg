import Chart from "chart.js/auto";
import "chartjs-adapter-date-fns";

export function render(canvas: HTMLCanvasElement, x: number[], y: number[]) {
  return new Chart(canvas, {
    type: "line",
    data: { datasets: [{ data: x.map((t, i) => ({ x: t, y: y[i]! })), pointRadius: 0 }] },
    options: { interaction: { mode: "index", intersect: false }, scales: { x: { type: "time" } } },
  });
}
