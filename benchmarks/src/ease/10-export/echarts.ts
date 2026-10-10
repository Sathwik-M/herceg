import * as echarts from "echarts";
import { days, p50 } from "../data.ts";

export function render(container: HTMLElement) {
  const option = {
    animation: false,
    title: { text: "Request latency" },
    dataset: { source: { time: days, p50 } },
    xAxis: { type: "time" },
    yAxis: { type: "value", name: "ms" },
    series: [{ type: "line", encode: { x: "time", y: "p50" } }],
  };
  const chart = echarts.init(container);
  chart.setOption(option);
  const png = chart.getDataURL({ type: "png", pixelRatio: 2 });
  // SVG needs the SVG renderer: draw the option again, off screen.
  const offscreen = echarts.init(null, null, {
    renderer: "svg",
    ssr: true,
    width: 640,
    height: 320,
  });
  offscreen.setOption(option);
  const svg = offscreen.renderToSVGString();
  offscreen.dispose();
  return { chart, svg, png, pdf: undefined };
}
