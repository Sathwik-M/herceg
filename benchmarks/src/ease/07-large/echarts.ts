import * as echarts from "echarts";
import { bigTime, bigValue } from "../data.ts";

export function render(container: HTMLElement) {
  const chart = echarts.init(container);
  chart.setOption({
    title: { text: "Signal" },
    tooltip: { trigger: "axis" },
    dataset: { source: { time: bigTime, value: bigValue } },
    xAxis: { type: "time" },
    yAxis: { type: "value" },
    series: [
      { type: "line", encode: { x: "time", y: "value" }, showSymbol: false, sampling: "lttb" },
    ],
  });
  return chart;
}
