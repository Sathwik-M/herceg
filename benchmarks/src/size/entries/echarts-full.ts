import * as echarts from "echarts";

export function render(element: HTMLElement, x: number[], y: number[]) {
  const chart = echarts.init(element);
  chart.setOption({
    tooltip: { trigger: "axis" },
    xAxis: { type: "time" },
    yAxis: { type: "value" },
    series: [{ type: "line", showSymbol: false, data: x.map((t, i) => [t, y[i]]) }],
  });
  return chart;
}
