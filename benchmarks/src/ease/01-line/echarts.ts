import * as echarts from "echarts";
import { days, p50 } from "../data.ts";

export function render(container: HTMLElement) {
  const chart = echarts.init(container);
  chart.setOption({
    title: { text: "Request latency" },
    tooltip: { trigger: "axis" },
    dataset: { source: { time: days, p50 } },
    xAxis: { type: "time" },
    yAxis: { type: "value", name: "ms" },
    series: [{ type: "line", encode: { x: "time", y: "p50" } }],
  });
  return chart;
}
