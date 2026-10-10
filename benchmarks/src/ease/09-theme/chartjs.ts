import Chart from "chart.js/auto";
import "chartjs-adapter-date-fns";
import { serviceRows } from "../data.ts";

const palette = ["#5b8def", "#f08a4b", "#3fbf8f"];

export function render(container: HTMLElement) {
  const services = [...new Set(serviceRows.map((row) => row.service))];
  const canvas = document.createElement("canvas");
  // Chart.js has no themes: colors are options, and the canvas is transparent.
  canvas.style.background = "#15171c";
  container.append(canvas);
  const grid = { color: "#2c3038" };
  return new Chart(canvas, {
    type: "line",
    data: {
      datasets: services.map((service, i) => ({
        label: service,
        data: serviceRows.filter((row) => row.service === service),
        borderColor: palette[i],
        backgroundColor: palette[i],
      })),
    },
    options: {
      color: "#e6e8ec",
      parsing: { xAxisKey: "time", yAxisKey: "latency" },
      interaction: { mode: "index", intersect: false },
      plugins: { title: { display: true, text: "Latency by service", color: "#e6e8ec" } },
      scales: {
        x: { type: "time", grid, ticks: { color: "#a0a6b0" } },
        y: {
          grid,
          ticks: { color: "#a0a6b0" },
          title: { display: true, text: "ms", color: "#a0a6b0" },
        },
      },
    },
  });
}
