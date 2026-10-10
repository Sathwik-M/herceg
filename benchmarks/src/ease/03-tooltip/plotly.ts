import Plotly from "plotly.js-dist-min";
import { days, p99, requests } from "../data.ts";

export function render(container: HTMLElement) {
  const trace = {
    type: "scatter" as const,
    mode: "lines" as const,
    x: days,
    y: p99,
    customdata: requests,
    hovertemplate: "%{x|%a, %b %-d}: %{y} ms, %{customdata:,} requests<extra></extra>",
  };
  return Plotly.newPlot(container, [trace], {
    title: { text: "Request latency" },
    hovermode: "x",
    xaxis: { type: "date" },
    yaxis: { title: { text: "ms" } },
  });
}
