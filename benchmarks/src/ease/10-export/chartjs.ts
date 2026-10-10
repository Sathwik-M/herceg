import Chart from "chart.js/auto";
import "chartjs-adapter-date-fns";
import { days, p50 } from "../data.ts";

export function render(container: HTMLElement) {
  const canvas = document.createElement("canvas");
  container.append(canvas);
  const chart = new Chart(canvas, {
    type: "line",
    data: { labels: days, datasets: [{ label: "p50", data: p50 }] },
    options: {
      // An animated chart would export its first frame.
      animation: false,
      plugins: { title: { display: true, text: "Request latency" } },
      scales: { x: { type: "time" }, y: { title: { display: true, text: "ms" } } },
    },
  });
  // Canvas only: PNG (or JPEG), no SVG or PDF.
  return { chart, svg: undefined, png: chart.toBase64Image("image/png"), pdf: undefined };
}
