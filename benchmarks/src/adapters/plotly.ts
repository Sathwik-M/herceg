import Plotly from "plotly.js-dist-min";
import type {
  CandleData,
  CategoryData,
  GridData,
  PointData,
  SampleData,
  SeriesData,
} from "../datasets.ts";
import type { Adapter, ChartHandle, ChartOptions } from "../page/adapter.ts";
import { clientPoint, color, FALL, RISE } from "../page/adapter.ts";

type Root = Plotly.PlotlyHTMLElement;

// Plotly exposes axis conversion only through its internal layout object.
interface Axis {
  d2l(value: number): number;
  l2p(value: number): number;
}
interface FullLayout {
  xaxis: Axis;
  yaxis: Axis;
  _size: { l: number; t: number };
}

const config = (options: ChartOptions): Partial<Plotly.Config> => ({
  displayModeBar: false,
  responsive: false,
  staticPlot: !options.tooltip,
});

function layout(options: ChartOptions, extra: Partial<Plotly.Layout> = {}): Partial<Plotly.Layout> {
  return {
    width: options.width,
    height: options.height,
    showlegend: false,
    hovermode: options.tooltip ? "x" : false,
    margin: { l: 50, r: 20, t: 20, b: 40 },
    ...extra,
  };
}

// Plotly accepts typed arrays directly; dates are epoch milliseconds on a date axis.
function lineTraces(
  data: SeriesData,
  options: ChartOptions,
  fill: boolean,
): Partial<Plotly.Data>[] {
  return data.ys.map((y, s) => ({
    // scattergl is Plotly's documented path for large series.
    type: options.large ? "scattergl" : "scatter",
    mode: "lines",
    name: data.names[s],
    x: data.x as unknown as number[],
    y: y as unknown as number[],
    line: { color: color(s), width: 1.5 },
    fill: fill ? "tozeroy" : "none",
  }));
}

// Plotly's candlestick trace takes the four price columns; rising candles are hollow by default.
function candleTraces(data: CandleData): Partial<Plotly.Data>[] {
  return [
    {
      type: "candlestick",
      x: data.x as unknown as number[],
      open: data.open as unknown as number[],
      high: data.high as unknown as number[],
      low: data.low as unknown as number[],
      close: data.close as unknown as number[],
      increasing: { line: { color: RISE }, fillcolor: "rgba(0,0,0,0)" },
      decreasing: { line: { color: FALL }, fillcolor: FALL },
    } as Partial<Plotly.Data>,
  ];
}

// Plotly's histogram trace bins the values itself, on the fixed grid every
// library is given: 5 wide from 25 (values lie within about 25 to 175).
function histogramTraces(data: SampleData): Partial<Plotly.Data>[] {
  return [
    {
      type: "histogram",
      x: data.values as unknown as number[],
      xbins: { start: 25, end: 175, size: 5 },
      marker: { color: color(0) },
    } as Partial<Plotly.Data>,
  ];
}

async function mount(
  container: HTMLElement,
  traces: Partial<Plotly.Data>[],
  plotLayout: Partial<Plotly.Layout>,
  options: ChartOptions,
): Promise<Root> {
  const root = document.createElement("div");
  container.append(root);
  return Plotly.newPlot(root, traces, plotLayout, config(options));
}

function handle<T>(
  root: Root,
  setData: (data: T) => Promise<unknown>,
  plotLayout: Partial<Plotly.Layout>,
): ChartHandle<T> {
  return {
    async setData(data) {
      await setData(data);
    },
    pixelOf(_series, _index, x, y) {
      const layout = (root as unknown as { _fullLayout: FullLayout })._fullLayout;
      return clientPoint(
        root,
        layout._size.l + layout.xaxis.l2p(layout.xaxis.d2l(x)),
        layout._size.t + layout.yaxis.l2p(layout.yaxis.d2l(y)),
      );
    },
    async resize(width, height) {
      plotLayout.width = width;
      plotLayout.height = height;
      await Plotly.relayout(root, { width, height });
    },
    destroy() {
      Plotly.purge(root);
      root.remove();
    },
  };
}

function lineKind(fill: boolean) {
  return {
    prepare: (data: SeriesData, options: ChartOptions) => lineTraces(data, options, fill),
    async create(
      container: HTMLElement,
      data: SeriesData,
      options: ChartOptions,
    ): Promise<ChartHandle<SeriesData>> {
      const plotLayout = layout(options, { xaxis: { type: "date" } });
      const root = await mount(container, lineTraces(data, options, fill), plotLayout, options);
      return {
        ...handle<SeriesData>(
          root,
          (next) =>
            Plotly.react(root, lineTraces(next, options, fill), plotLayout, config(options)),
          plotLayout,
        ),
        async append(x, ys, keep) {
          // extendTraces with maxPoints is Plotly's documented rolling-window
          // API. Batches must match the typed arrays the traces were built with.
          await Plotly.extendTraces(
            root,
            { x: ys.map(() => x as unknown as number[]), y: ys as unknown as number[][] },
            ys.map((_, s) => s),
            keep,
          );
        },
        async setViewport(x0, x1) {
          await Plotly.relayout(root, { "xaxis.range": [x0, x1] });
        },
      };
    },
  };
}

function barTraces(data: CategoryData): Partial<Plotly.Data>[] {
  return data.series.map((series, s) => ({
    type: "bar",
    name: series.name,
    x: data.categories,
    y: series.values as unknown as number[],
    marker: { color: color(s) },
  }));
}

function scatterTraces(data: PointData, options: ChartOptions): Partial<Plotly.Data>[] {
  return [
    {
      type: options.large ? "scattergl" : "scatter",
      mode: "markers",
      x: data.x as unknown as number[],
      y: data.y as unknown as number[],
      marker: { size: 3, color: color(0) },
    },
  ];
}

function heatmapTraces(data: GridData): Partial<Plotly.Data>[] {
  const z: Float64Array[] = [];
  for (let r = 0; r < data.rows; r++) {
    z.push(data.values.subarray(r * data.columns, (r + 1) * data.columns));
  }
  return [
    {
      type: "heatmap",
      z: z as unknown as number[][],
      colorscale: [
        [0, "#f7fbff"],
        [1, "#08306b"],
      ],
      showscale: false,
    },
  ];
}

export const adapter: Adapter = {
  id: "plotly",
  renderer: { normal: "svg", large: "webgl (scattergl)" },
  line: lineKind(false),
  area: {
    prepare: (data, options) => lineTraces(data, options, true),
    create: (container, data, options) => lineKind(true).create(container, data, options),
  },
  bar: {
    prepare: barTraces,
    async create(container, data, options) {
      const plotLayout = layout(options, { barmode: "group" });
      const root = await mount(container, barTraces(data), plotLayout, options);
      return handle<CategoryData>(
        root,
        (next) => Plotly.react(root, barTraces(next), plotLayout, config(options)),
        plotLayout,
      );
    },
  },
  scatter: {
    prepare: scatterTraces,
    async create(container, data, options) {
      const plotLayout = layout(options, { hovermode: options.tooltip ? "closest" : false });
      const root = await mount(container, scatterTraces(data, options), plotLayout, options);
      return {
        ...handle<PointData>(
          root,
          (next) => Plotly.react(root, scatterTraces(next, options), plotLayout, config(options)),
          plotLayout,
        ),
        async setViewport(x0, x1) {
          await Plotly.relayout(root, { "xaxis.range": [x0, x1] });
        },
      };
    },
  },
  heatmap: {
    prepare: heatmapTraces,
    async create(container, data, options) {
      const plotLayout = layout(options, { hovermode: options.tooltip ? "closest" : false });
      const root = await mount(container, heatmapTraces(data), plotLayout, options);
      return handle<GridData>(
        root,
        (next) => Plotly.react(root, heatmapTraces(next), plotLayout, config(options)),
        plotLayout,
      );
    },
  },
  candlestick: {
    prepare: candleTraces,
    async create(container, data, options) {
      // Plotly adds a range slider under candlestick charts; the others have
      // none. Times are epoch milliseconds, so the axis is declared a date axis.
      const plotLayout = layout(options, {
        xaxis: { type: "date", rangeslider: { visible: false } },
      });
      const root = await mount(container, candleTraces(data), plotLayout, options);
      return handle<CandleData>(
        root,
        (next) => Plotly.react(root, candleTraces(next), plotLayout, config(options)),
        plotLayout,
      );
    },
  },
  histogram: {
    prepare: histogramTraces,
    async create(container, data, options) {
      // The x range every library is given.
      const plotLayout = layout(options, { bargap: 0.02, xaxis: { range: [25, 175] } });
      const root = await mount(container, histogramTraces(data), plotLayout, options);
      return handle<SampleData>(
        root,
        (next) => Plotly.react(root, histogramTraces(next), plotLayout, config(options)),
        plotLayout,
      );
    },
  },
};
