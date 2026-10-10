import Chart, { type ActiveElement } from "chart.js/auto";
import "chartjs-adapter-date-fns";
import { days, p50, requests } from "../data.ts";

function chart(container: HTMLElement, title: string, values: number[]) {
  const canvas = document.createElement("canvas");
  container.append(canvas);
  return new Chart(canvas, {
    type: "line",
    data: { labels: days, datasets: [{ label: title, data: values }] },
    options: {
      interaction: { mode: "index", intersect: false },
      plugins: { title: { display: true, text: title } },
      scales: { x: { type: "time" } },
    },
  });
}

export function render(top: HTMLElement, bottom: HTMLElement) {
  const charts = [chart(top, "Latency", p50), chart(bottom, "Requests", requests)];
  for (const source of charts) {
    const others = charts.filter((other) => other !== source);
    // Cursor: show the other charts' tooltips at the day hovered here, and clear them on leaving.
    const mirror = (active: ActiveElement[]) => {
      for (const other of others) {
        other.setActiveElements(active);
        other.tooltip!.setActiveElements(active, { x: 0, y: 0 });
        other.update("none");
      }
    };
    source.options.onHover = (_event, active) => mirror(active);
    source.canvas.addEventListener("mouseleave", () => mirror([]));
    // Zoom (chartjs-plugin-zoom is not installed): the wheel zooms every x axis.
    source.canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      const { min, max } = source.scales.x!;
      const at = source.scales.x!.getValueForPixel(event.offsetX)!;
      const factor = event.deltaY > 0 ? 1.25 : 0.8;
      for (const target of charts) {
        target.options.scales!.x!.min = at - (at - min) * factor;
        target.options.scales!.x!.max = at + (max - at) * factor;
        target.update("none");
      }
    });
  }
  return charts;
}
