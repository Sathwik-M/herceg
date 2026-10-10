import Chart from "chart.js/auto";
import "chartjs-adapter-date-fns";
import { BIG, bigTime, bigValue } from "../data.ts";

export function render(container: HTMLElement) {
  const canvas = document.createElement("canvas");
  container.append(canvas);
  // Decimation needs data in Chart.js's internal format, with parsing off.
  const points = Array.from({ length: BIG }, (_, i) => ({ x: bigTime[i]!, y: bigValue[i]! }));
  return new Chart(canvas, {
    type: "line",
    data: { datasets: [{ label: "value", data: points, pointRadius: 0, borderWidth: 1 }] },
    options: {
      animation: false,
      parsing: false,
      normalized: true,
      interaction: { mode: "nearest", axis: "x", intersect: false },
      plugins: {
        title: { display: true, text: "Signal" },
        decimation: { enabled: true, algorithm: "min-max" },
      },
      scales: { x: { type: "time" } },
    },
  });
}
