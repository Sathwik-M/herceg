import Chart from "chart.js/auto";
import "chartjs-adapter-date-fns";
import { reading } from "../data.ts";

export function render(container: HTMLElement) {
  const canvas = document.createElement("canvas");
  container.append(canvas);
  const points: { x: number; y: number }[] = [];
  const chart = new Chart(canvas, {
    type: "line",
    data: { datasets: [{ label: "cpu", data: points, pointRadius: 0 }] },
    options: {
      animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: { title: { display: true, text: "CPU" } },
      scales: { x: { type: "time" } },
    },
  });
  let i = 0;
  const timer = setInterval(() => {
    const { time, cpu } = reading(i++);
    points.push({ x: time, y: cpu });
    if (points.length > 300) points.shift();
    chart.update();
  }, 100);
  return { chart, stop: () => clearInterval(timer) };
}
