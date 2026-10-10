import Chart from "chart.js/auto";
import "chartjs-adapter-date-fns";
import { serviceRows } from "../data.ts";

export function render(container: HTMLElement) {
  const services = [...new Set(serviceRows.map((row) => row.service))];
  const canvas = document.createElement("canvas");
  container.append(canvas);
  return new Chart(canvas, {
    type: "line",
    data: {
      datasets: services.map((service) => ({
        label: service,
        data: serviceRows.filter((row) => row.service === service),
      })),
    },
    options: {
      parsing: { xAxisKey: "time", yAxisKey: "latency" },
      interaction: { mode: "index", intersect: false },
      plugins: { title: { display: true, text: "Latency by service" } },
      scales: { x: { type: "time" }, y: { title: { display: true, text: "ms" } } },
    },
  });
}
