import { createChart, line, table, time } from "herceg";
import { days, p50, requests } from "../data.ts";

export function render(top: HTMLElement, bottom: HTMLElement) {
  const traffic = table({ time: time(days), p50, requests });
  const interaction = { zoom: "x", sync: "traffic" } as const;
  return [
    createChart(top, {
      title: "Latency",
      marks: [line(traffic, { x: "time", y: "p50" })],
      interaction,
    }),
    createChart(bottom, {
      title: "Requests",
      marks: [line(traffic, { x: "time", y: "requests" })],
      interaction,
    }),
  ];
}
