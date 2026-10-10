import * as echarts from "echarts";
import { monthly } from "../data.ts";

export function render(container: HTMLElement) {
  const chart = echarts.init(container);
  chart.setOption({
    title: { text: "Revenue" },
    legend: {},
    tooltip: { trigger: "axis" },
    dataset: { source: monthly },
    xAxis: { type: "category" },
    yAxis: { type: "value", name: "k$" },
    series: [
      { type: "bar", encode: { x: "month", y: "revenue" } },
      { type: "line", encode: { x: "month", y: "target" } },
    ],
  });
  return chart;
}
