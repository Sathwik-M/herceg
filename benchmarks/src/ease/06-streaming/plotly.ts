import Plotly from "plotly.js-dist-min";
import { reading } from "../data.ts";

export async function render(container: HTMLElement) {
  const plot = await Plotly.newPlot(container, [{ type: "scatter", mode: "lines", x: [], y: [] }], {
    title: { text: "CPU" },
    hovermode: "x",
    xaxis: { type: "date" },
  });
  let i = 0;
  const timer = setInterval(() => {
    const { time, cpu } = reading(i++);
    // The last argument keeps the newest 300 points.
    Plotly.extendTraces(plot, { x: [[time]], y: [[cpu]] }, [0], 300);
  }, 100);
  return { chart: plot, stop: () => clearInterval(timer) };
}
