import {
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  Decimation,
  Filler,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  ScatterController,
  TimeScale,
  Tooltip,
} from "chart.js";
import "chartjs-adapter-date-fns";
import type { CategoryData, PointData, SeriesData } from "../datasets.ts";
import type { Adapter, ChartHandle, ChartOptions } from "../page/adapter.ts";
import { clientPoint, color } from "../page/adapter.ts";

Chart.register(
  LineController,
  BarController,
  ScatterController,
  LineElement,
  BarElement,
  PointElement,
  LinearScale,
  CategoryScale,
  TimeScale,
  Tooltip,
  Filler,
  Decimation,
);

type XY = { x: number; y: number };

// Chart.js' internal (pre-parsed) format is one {x, y} object per point.
function seriesPoints(data: SeriesData): XY[][] {
  return data.ys.map((y) => {
    const points: XY[] = new Array(y.length);
    for (let i = 0; i < y.length; i++) points[i] = { x: data.x[i]!, y: y[i]! };
    return points;
  });
}

function canvasIn(container: HTMLElement, options: ChartOptions): HTMLCanvasElement {
  // Chart.js sizes the canvas from a relatively positioned parent.
  const box = document.createElement("div");
  box.style.cssText = `position:relative;width:${options.width}px;height:${options.height}px`;
  const canvas = document.createElement("canvas");
  box.append(canvas);
  container.append(box);
  return canvas;
}

function common(options: ChartOptions) {
  return {
    animation: false as const,
    responsive: true,
    maintainAspectRatio: false,
    events: options.tooltip ? undefined : [],
  };
}

function handle<T>(chart: Chart, setData: (data: T) => void): ChartHandle<T> {
  return {
    setData,
    pixelOf(_series, _index, x, y) {
      return clientPoint(
        chart.canvas,
        chart.scales.x!.getPixelForValue(x),
        chart.scales.y!.getPixelForValue(y),
      );
    },
    resize(width, height) {
      const box = chart.canvas.parentElement!;
      box.style.width = `${width}px`;
      box.style.height = `${height}px`;
      chart.resize(width, height);
    },
    destroy() {
      const box = chart.canvas.parentElement!;
      chart.destroy();
      box.remove();
    },
  };
}

function lineKind(fill: boolean) {
  return {
    prepare: (data: SeriesData) => seriesPoints(data),
    create(
      container: HTMLElement,
      data: SeriesData,
      options: ChartOptions,
    ): ChartHandle<SeriesData> {
      // With decimation on, `dataset.data` holds the decimated points, so the
      // adapter keeps the source arrays and assigns them on every update.
      let sources = seriesPoints(data);
      const chart = new Chart(canvasIn(container, options), {
        type: "line",
        data: {
          datasets: sources.map((points, s) => ({
            label: data.names[s],
            data: points,
            borderColor: color(s),
            backgroundColor: `${color(s)}40`,
            borderWidth: 1.5,
            pointRadius: 0,
            fill: fill ? "origin" : false,
          })),
        },
        options: {
          ...common(options),
          // Documented large-data settings: skip parsing for sorted, unique x
          // values, and min-max decimation (which requires parsing: false).
          parsing: false,
          normalized: true,
          interaction: { mode: "index", intersect: false },
          scales: { x: { type: "time" }, y: { type: "linear" } },
          plugins: {
            tooltip: { enabled: options.tooltip },
            decimation: { enabled: options.large, algorithm: "min-max" },
          },
        },
      });
      const assign = () => {
        sources.forEach((points, s) => {
          chart.data.datasets[s]!.data = points;
        });
        chart.update("none");
      };
      return {
        ...handle<SeriesData>(chart, (next) => {
          sources = seriesPoints(next);
          assign();
        }),
        append(x, ys, keep) {
          ys.forEach((y, s) => {
            const points = sources[s]!;
            for (let i = 0; i < x.length; i++) points.push({ x: x[i]!, y: y[i]! });
            if (points.length > keep) points.splice(0, points.length - keep);
          });
          assign();
        },
        // Axis limits are Chart.js' documented way to set the visible range;
        // decimation then works on the visible points.
        setViewport(x0, x1) {
          const x = chart.options.scales!.x!;
          x.min = x0;
          x.max = x1;
          chart.update("none");
        },
      };
    },
  };
}

const prepareBar = (data: CategoryData) => data.series.map((s) => Array.from(s.values));

function scatterPoints(data: PointData): XY[] {
  const points: XY[] = new Array(data.x.length);
  for (let i = 0; i < data.x.length; i++) points[i] = { x: data.x[i]!, y: data.y[i]! };
  return points;
}

export const adapter: Adapter = {
  id: "chartjs",
  renderer: { normal: "canvas", large: "canvas (parsing: false, min-max decimation)" },
  line: lineKind(false),
  area: lineKind(true),
  bar: {
    prepare: prepareBar,
    create(container, data, options) {
      const chart = new Chart(canvasIn(container, options), {
        type: "bar",
        data: {
          labels: data.categories,
          datasets: prepareBar(data).map((values, s) => ({
            label: data.series[s]!.name,
            data: values,
            backgroundColor: color(s),
          })),
        },
        options: {
          ...common(options),
          interaction: { mode: "index", intersect: false },
          plugins: { tooltip: { enabled: options.tooltip } },
        },
      });
      return handle<CategoryData>(chart, (next) => {
        prepareBar(next).forEach((values, s) => {
          chart.data.datasets[s]!.data = values;
        });
        chart.update("none");
      });
    },
  },
  scatter: {
    prepare: scatterPoints,
    create(container, data, options) {
      // Scatter x values are unsorted, so `parsing: false` / `normalized`
      // (which assume sorted data) must stay off.
      const chart = new Chart(canvasIn(container, options), {
        type: "scatter",
        data: {
          datasets: [
            {
              data: scatterPoints(data),
              pointRadius: 1.5,
              backgroundColor: color(0),
              borderWidth: 0,
            },
          ],
        },
        options: {
          ...common(options),
          interaction: { mode: "nearest", intersect: false },
          plugins: { tooltip: { enabled: options.tooltip } },
        },
      });
      return handle<PointData>(chart, (next) => {
        chart.data.datasets[0]!.data = scatterPoints(next);
        chart.update("none");
      });
    },
  },
  // Chart.js has no built-in heatmap; chartjs-chart-matrix is a third-party plugin.
};
