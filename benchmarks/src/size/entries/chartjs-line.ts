import {
  Chart,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  TimeScale,
  Tooltip,
} from "chart.js";
import "chartjs-adapter-date-fns";

Chart.register(LineController, LineElement, PointElement, LinearScale, TimeScale, Tooltip);

export function render(canvas: HTMLCanvasElement, x: number[], y: number[]) {
  return new Chart(canvas, {
    type: "line",
    data: { datasets: [{ data: x.map((t, i) => ({ x: t, y: y[i]! })), pointRadius: 0 }] },
    options: { interaction: { mode: "index", intersect: false }, scales: { x: { type: "time" } } },
  });
}
