import * as echarts from "echarts";
import { days, p50 } from "../data.ts";

export function render(container: HTMLElement) {
  const option: echarts.EChartsOption = {
    title: { text: "Request latency" },
    tooltip: { trigger: "axis" },
    dataset: { source: { time: days, p50 } },
    xAxis: { type: "time" },
    yAxis: { type: "value", name: "ms" },
    series: [
      {
        type: "custom",
        encode: { x: "time", y: "p50" },
        // A lollipop per day: a stem from zero and a dot at the value.
        renderItem: (_params, api) => {
          const [x, y] = api.coord([api.value("time"), api.value("p50")]) as [number, number];
          const base = api.coord([api.value("time"), 0])[1]!;
          const color = api.visual("color") as string;
          return {
            type: "group",
            children: [
              { type: "line", shape: { x1: x, y1: base, x2: x, y2: y }, style: { stroke: color } },
              { type: "circle", shape: { cx: x, cy: y, r: 3 }, style: { fill: color } },
            ],
          };
        },
      },
    ],
  };
  const chart = echarts.init(container);
  chart.setOption(option);
  return chart;
}
