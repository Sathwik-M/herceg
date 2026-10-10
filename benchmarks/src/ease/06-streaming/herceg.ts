import { createChart, line, table, time } from "herceg";
import { reading } from "../data.ts";

export function render(container: HTMLElement) {
  // A rolling window: appending past 300 rows drops the oldest.
  const cpu = table({ time: time([]), cpu: [] as number[] }, { maxRows: 300 });
  const chart = createChart(container, {
    title: "CPU",
    marks: [line(cpu, { x: "time", y: "cpu" })],
  });
  let i = 0;
  const timer = setInterval(() => cpu.appendRow(reading(i++)), 100);
  return { chart, stop: () => clearInterval(timer) };
}
