import * as echarts from "echarts";
import { reading } from "../data.ts";

export function render(container: HTMLElement) {
  const points: [number, number][] = [];
  const chart = echarts.init(container);
  chart.setOption({
    title: { text: "CPU" },
    tooltip: { trigger: "axis" },
    xAxis: { type: "time" },
    yAxis: { type: "value" },
    series: [{ type: "line", showSymbol: false, data: points }],
  });
  let i = 0;
  const timer = setInterval(() => {
    const { time, cpu } = reading(i++);
    points.push([time, cpu]);
    if (points.length > 300) points.shift();
    chart.setOption({ series: [{ data: points }] });
  }, 100);
  return { chart, stop: () => clearInterval(timer) };
}
