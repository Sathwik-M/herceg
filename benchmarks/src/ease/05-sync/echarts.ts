import * as echarts from "echarts";
import { days, p50, requests } from "../data.ts";

function option(title: string, y: string) {
  return {
    title: { text: title },
    tooltip: { trigger: "axis" },
    dataset: { source: { time: days, p50, requests } },
    xAxis: { type: "time" },
    yAxis: { type: "value" },
    dataZoom: [{ type: "inside" }],
    series: [{ type: "line", encode: { x: "time", y } }],
  };
}

export function render(top: HTMLElement, bottom: HTMLElement) {
  const charts = [echarts.init(top), echarts.init(bottom)];
  charts[0]!.setOption(option("Latency", "p50"));
  charts[1]!.setOption(option("Requests", "requests"));
  echarts.connect(charts);
  return charts;
}
