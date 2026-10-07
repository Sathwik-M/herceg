import { LineChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([LineChart, GridComponent, TooltipComponent, CanvasRenderer]);

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
