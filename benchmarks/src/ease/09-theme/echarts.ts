import * as echarts from "echarts";
import { serviceRows } from "../data.ts";

export function render(container: HTMLElement) {
  const services = [...new Set(serviceRows.map((row) => row.service))];
  const chart = echarts.init(container, "dark");
  chart.setOption({
    color: ["#5b8def", "#f08a4b", "#3fbf8f"],
    title: { text: "Latency by service" },
    legend: {},
    tooltip: { trigger: "axis" },
    xAxis: { type: "time" },
    yAxis: { type: "value", name: "ms" },
    series: services.map((service) => ({
      type: "line",
      name: service,
      data: serviceRows
        .filter((row) => row.service === service)
        .map((row) => [row.time, row.latency]),
    })),
  });
  return chart;
}
