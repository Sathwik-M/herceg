import Chart, { type Plugin } from "chart.js/auto";
import "chartjs-adapter-date-fns";
import { days, incident, p99, SLO } from "../data.ts";

// chartjs-plugin-annotation draws rules and boxes from options; without it,
// a plugin of our own draws them with the chart's scales.
const annotations: Plugin<"line"> = {
  id: "annotations",
  beforeDatasetsDraw({ ctx, chartArea: area, scales: { x } }) {
    const [left, right] = [x!.getPixelForValue(incident.start), x!.getPixelForValue(incident.end)];
    ctx.save();
    ctx.fillStyle = "rgba(128, 128, 128, 0.2)";
    ctx.fillRect(left, area.top, right - left, area.height);
    ctx.fillStyle = "#555";
    ctx.fillText(incident.label, left + 4, area.top + 12);
    ctx.restore();
  },
  afterDatasetsDraw({ ctx, chartArea: area, scales: { y } }) {
    const at = y!.getPixelForValue(SLO);
    ctx.save();
    ctx.strokeStyle = "#d33";
    ctx.beginPath();
    ctx.moveTo(area.left, at);
    ctx.lineTo(area.right, at);
    ctx.stroke();
    ctx.fillStyle = "#d33";
    ctx.fillText("SLO", area.right - 24, at - 4);
    ctx.restore();
  },
};

export function render(container: HTMLElement) {
  const canvas = document.createElement("canvas");
  container.append(canvas);
  return new Chart(canvas, {
    type: "line",
    data: { labels: days, datasets: [{ label: "p99", data: p99 }] },
    plugins: [annotations],
    options: {
      interaction: { mode: "index", intersect: false },
      plugins: { title: { display: true, text: "Request latency" } },
      scales: { x: { type: "time" }, y: { title: { display: true, text: "ms" } } },
    },
  });
}
