import { createChart, line, table, time } from "herceg";
import { days, p99, requests } from "../data.ts";

const date = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

export function render(container: HTMLElement) {
  const latency = table({ time: time(days), p99, requests });
  const chart = createChart(container, {
    title: "Request latency",
    marks: [line(latency, { x: "time", y: "p99" })],
    y: { title: "ms" },
    tooltip: false,
  });
  // With the built-in tooltip off, a hover listener shows one of our own.
  const tip = document.createElement("div");
  tip.style.cssText =
    "position:absolute;left:0;top:0;pointer-events:none;white-space:nowrap;background:#fff;border:1px solid #ccc";
  tip.hidden = true;
  chart.root.append(tip);
  chart.on("hover", ({ inspection }) => {
    const point = inspection?.points[0];
    tip.hidden = point?.row === undefined;
    if (point?.row === undefined) return;
    const day = date.format(latency.numbers("time")[point.row]);
    const count = latency.numbers("requests")[point.row]!.toLocaleString("en-US");
    tip.textContent = `${day}: ${point.value} ms, ${count} requests`;
    // Right of the point, or left of it past the middle, to stay inside the chart.
    const left = point.px > chart.root.clientWidth / 2;
    tip.style.transform = `translate(calc(${point.px}px ${left ? "- 100% - 12px" : "+ 12px"}), ${point.py}px)`;
  });
  return chart;
}
