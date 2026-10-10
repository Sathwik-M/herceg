import Plotly from "plotly.js-dist-min";
import { days, p50 } from "../data.ts";

export async function render(container: HTMLElement) {
  const plot = await Plotly.newPlot(
    container,
    [{ type: "scatter", mode: "lines", x: days, y: p50 }],
    {
      title: { text: "Request latency" },
      xaxis: { type: "date" },
      yaxis: { title: { text: "ms" } },
    },
  );
  const size = { width: 640, height: 320 };
  const png = await Plotly.toImage(plot, { ...size, format: "png", scale: 2 });
  // SVG comes as a data URL too; PDF only from Plotly Python (Kaleido).
  const url = await Plotly.toImage(plot, { ...size, format: "svg" });
  const svg = decodeURIComponent(url.slice(url.indexOf(",") + 1));
  return { chart: plot, svg, png, pdf: undefined };
}
