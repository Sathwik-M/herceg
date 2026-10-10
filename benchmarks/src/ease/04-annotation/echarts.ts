import * as echarts from "echarts";
import { days, incident, p99, SLO } from "../data.ts";

export function render(container: HTMLElement) {
  const chart = echarts.init(container);
  chart.setOption({
    title: { text: "Request latency" },
    tooltip: { trigger: "axis" },
    dataset: { source: { time: days, p99 } },
    xAxis: { type: "time" },
    yAxis: { type: "value", name: "ms" },
    series: [
      {
        type: "line",
        encode: { x: "time", y: "p99" },
        markLine: { symbol: "none", label: { formatter: "SLO" }, data: [{ yAxis: SLO }] },
        markArea: {
          label: { show: true },
          data: [[{ name: incident.label, xAxis: incident.start }, { xAxis: incident.end }]],
        },
      },
    ],
  });
  return chart;
}
