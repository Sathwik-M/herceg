import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { SeriesData } from "../datasets.ts";
import type { Adapter, ChartHandle, ChartOptions } from "../page/adapter.ts";
import { clientPoint, color, rollArray } from "../page/adapter.ts";

// uPlot reads typed arrays directly: [x, ...ys].
function columns(data: SeriesData): uPlot.AlignedData {
  return [data.x, ...data.ys] as unknown as uPlot.AlignedData;
}

function lineKind(fill: boolean) {
  return {
    prepare: columns,
    create(
      container: HTMLElement,
      data: SeriesData,
      options: ChartOptions,
    ): ChartHandle<SeriesData> {
      const plot = new uPlot(
        {
          width: options.width,
          height: options.height,
          // Timestamps are milliseconds.
          ms: 1,
          // uPlot has no tooltip; its cursor and live legend are the hover readout.
          cursor: { show: options.tooltip },
          legend: { show: options.tooltip },
          scales: { x: { time: true } },
          series: [
            {},
            ...data.ys.map((_, s) => ({
              label: data.names[s],
              stroke: color(s),
              width: 1.5,
              fill: fill ? `${color(s)}40` : undefined,
            })),
          ],
        },
        columns(data),
        container,
      );
      // Rolling windows use plain arrays shifted in place, as in uPlot's streaming demos.
      let rolling: number[][] | null = null;
      let current = data;
      return {
        setData(next) {
          rolling = null;
          current = next;
          plot.setData(columns(next));
        },
        append(x, ys, keep) {
          rolling ??= [Array.from(current.x), ...current.ys.map((y) => Array.from(y))];
          rollArray(rolling[0]!, x, keep);
          ys.forEach((y, s) => {
            rollArray(rolling![s + 1]!, y, keep);
          });
          plot.setData(rolling as uPlot.AlignedData);
        },
        pixelOf: (_series, _index, x, y) =>
          clientPoint(plot.over, plot.valToPos(x, "x"), plot.valToPos(y, "y")),
        resize: (width, height) => plot.setSize({ width, height }),
        destroy: () => plot.destroy(),
      };
    },
  };
}

export const adapter: Adapter = {
  id: "uplot",
  renderer: { normal: "canvas", large: "canvas" },
  line: lineKind(false),
  area: lineKind(true),
  // Grouped bars, scatter, and heatmaps need uPlot plugins or custom path builders.
};
