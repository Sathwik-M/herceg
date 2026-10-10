import Plotly from "plotly.js-dist-min";
import { days, p50, requests } from "../data.ts";

// Plotly.Fx is documented, but missing from @types/plotly.js.
const { Fx } = Plotly as unknown as {
  Fx: {
    hover(plot: HTMLElement, points: { curveNumber: number; pointNumber: number }[]): void;
    unhover(plot: HTMLElement): void;
  };
};

function plot(container: HTMLElement, title: string, values: number[]) {
  return Plotly.newPlot(container, [{ type: "scatter", mode: "lines", x: days, y: values }], {
    title: { text: title },
    hovermode: "x",
    xaxis: { type: "date" },
  });
}

export async function render(top: HTMLElement, bottom: HTMLElement) {
  const plots = [await plot(top, "Latency", p50), await plot(bottom, "Requests", requests)];
  let syncing = false;
  for (const source of plots) {
    const others = plots.filter((other) => other !== source);
    // Zoom: copy x ranges (and their reset) to the other plots, without echoing them back.
    source.on("plotly_relayout", (event) => {
      const x = Object.fromEntries(
        Object.entries(event).filter(([key]) => key.startsWith("xaxis.")),
      );
      if (syncing || Object.keys(x).length === 0) return;
      syncing = true;
      Promise.all(others.map((other) => Plotly.relayout(other, x))).finally(() => {
        syncing = false;
      });
    });
    // Cursor: hover the other plots at the same point (they share x positions).
    // Hovers made by Fx.hover carry no pointer event; skipping them stops the echo.
    source.on("plotly_hover", (event) => {
      if (event.event === undefined) return;
      const at = [{ curveNumber: 0, pointNumber: event.points[0]!.pointNumber }];
      for (const other of others) Fx.hover(other, at);
    });
    source.on("plotly_unhover", () => {
      for (const other of others) Fx.unhover(other);
    });
  }
  return plots;
}
