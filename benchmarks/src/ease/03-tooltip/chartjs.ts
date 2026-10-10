import Chart from "chart.js/auto";
import "chartjs-adapter-date-fns";
import { daily } from "../data.ts";

const date = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

export function render(container: HTMLElement) {
  const canvas = document.createElement("canvas");
  container.append(canvas);
  return new Chart(canvas, {
    type: "line",
    data: { datasets: [{ label: "p99", data: daily }] },
    options: {
      parsing: { xAxisKey: "time", yAxisKey: "p99" },
      interaction: { mode: "index", intersect: false },
      plugins: {
        title: { display: true, text: "Request latency" },
        tooltip: {
          callbacks: {
            title: ([item]) => date.format(item!.parsed.x!),
            label: (item) => {
              const day = daily[item.dataIndex]!;
              return `${day.p99} ms, ${day.requests.toLocaleString("en-US")} requests`;
            },
          },
        },
      },
      scales: { x: { type: "time" }, y: { title: { display: true, text: "ms" } } },
    },
  });
}
