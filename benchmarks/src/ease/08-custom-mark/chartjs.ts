import Chart, { type Plugin } from "chart.js/auto";
import "chartjs-adapter-date-fns";
import { days, p50 } from "../data.ts";

// Dots are a scatter dataset; a plugin draws a stem from zero under each one.
const stems: Plugin<"scatter"> = {
  id: "stems",
  beforeDatasetsDraw(chart) {
    const { ctx, scales } = chart;
    const base = scales.y!.getPixelForValue(0);
    ctx.save();
    for (const point of chart.getDatasetMeta(0).data) {
      ctx.strokeStyle = String(point.options.backgroundColor);
      ctx.beginPath();
      ctx.moveTo(point.x, base);
      ctx.lineTo(point.x, point.y);
      ctx.stroke();
    }
    ctx.restore();
  },
};

export function render(container: HTMLElement) {
  const canvas = document.createElement("canvas");
  container.append(canvas);
  return new Chart(canvas, {
    type: "scatter",
    data: { datasets: [{ label: "p50", data: days.map((x, i) => ({ x, y: p50[i]! })) }] },
    plugins: [stems],
    options: {
      interaction: { mode: "nearest", axis: "x", intersect: false },
      plugins: { title: { display: true, text: "Request latency" } },
      scales: {
        x: { type: "time" },
        y: { beginAtZero: true, title: { display: true, text: "ms" } },
      },
    },
  });
}
