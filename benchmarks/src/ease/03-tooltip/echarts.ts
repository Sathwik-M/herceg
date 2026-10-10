import * as echarts from "echarts";
import { daily } from "../data.ts";

const date = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

type Day = (typeof daily)[number];

export function render(container: HTMLElement) {
  const option: echarts.EChartsOption = {
    title: { text: "Request latency" },
    tooltip: {
      trigger: "axis",
      formatter: (params) => {
        // With trigger "axis", params is an array; its data is a row of the dataset.
        const day = (params as echarts.DefaultLabelFormatterCallbackParams[])[0]!.data as Day;
        return `${date.format(day.time)}: ${day.p99} ms, ${day.requests.toLocaleString("en-US")} requests`;
      },
    },
    dataset: { source: daily },
    xAxis: { type: "time" },
    yAxis: { type: "value", name: "ms" },
    series: [{ type: "line", encode: { x: "time", y: "p99" } }],
  };
  const chart = echarts.init(container);
  chart.setOption(option);
  return chart;
}
