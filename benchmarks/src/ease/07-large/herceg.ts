import { createChart, line, table, time } from "herceg";
import { bigTime, bigValue } from "../data.ts";

export function render(container: HTMLElement) {
  const signal = table({ time: time(bigTime), value: bigValue });
  return createChart(container, {
    title: "Signal",
    marks: [line(signal, { x: "time", y: "value" })],
  });
}
