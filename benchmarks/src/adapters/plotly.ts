import Plotly from "plotly.js-dist-min";
import {
  BUBBLE,
  type BubbleData,
  bubbleRadius,
  type CandleData,
  type CategoryData,
  type GridData,
  type Point3Data,
  type PointData,
  type SampleData,
  type SeriesData,
  type SurfaceData,
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

// Plotly's area-mode marker radius is sqrt(size / 2) with sizeref 1, so
// sizes of 2r² give the shared radii; opaque and without outlines, as the
// other libraries draw them.
function bubbleTraces(data: BubbleData): Partial<Plotly.Data>[] {
  const maxSize = Math.max(...data.size);
  const size = Array.from(data.size, (s) => 2 * bubbleRadius(s, maxSize) ** 2);
  return [
    {
      type: "scatter",
      mode: "markers",
      x: data.x as unknown as number[],
      y: data.y as unknown as number[],
      marker: {
        size,
        sizemode: "area",
        sizeref: 1,
        sizemin: 0,
        opacity: 1,
        line: { width: 0 },
        color: data.value as unknown as number[],
        colorscale: [
          [0, BUBBLE.colors[0]],
          [1, BUBBLE.colors[1]],
        ],
        showscale: false,
      },
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

// 3D charts are WebGL (gl3d) in Plotly. The camera is orthographic, as
// Herceg's is by default, with the box a cube, and its eye at Plotly's
// default distance in the direction of the azimuth and elevation.
function scene3d(
  options: ChartOptions,
  extra: Partial<Plotly.Layout> = {},
): Partial<Plotly.Layout> {
  return layout(options, {
    hovermode: options.tooltip ? "closest" : false,
    margin: { l: 0, r: 0, t: 0, b: 0 },
    scene: { aspectmode: "cube", camera: { projection: { type: "orthographic" } } },
    ...extra,
  } as Partial<Plotly.Layout>);
}

function eye(azimuth: number, elevation: number) {
  const distance = Math.hypot(1.25, 1.25, 1.25);
  const [a, e] = [(azimuth * Math.PI) / 180, (elevation * Math.PI) / 180];
  return {
    x: distance * Math.cos(e) * Math.cos(a),
    y: distance * Math.cos(e) * Math.sin(a),
    z: distance * Math.sin(e),
  };
}

function scatter3dTraces(data: Point3Data): Partial<Plotly.Data>[] {
  return [
    {
      type: "scatter3d",
      mode: "markers",
      x: data.x as unknown as number[],
      y: data.y as unknown as number[],
      z: data.z as unknown as number[],
      marker: { size: 7, color: color(0), line: { width: 0 } },
    } as Partial<Plotly.Data>,
  ];
}

// Plotly's surface takes z as rows of the grid, over the x and y vectors.
function surfaceTraces(data: SurfaceData): Partial<Plotly.Data>[] {
  const side = data.x.length;
  const z = Array.from({ length: data.y.length }, (_, j) =>
    data.z.subarray(j * side, (j + 1) * side),
  );
  return [
    {
      type: "surface",
      x: data.x as unknown as number[],
      y: data.y as unknown as number[],
      z: z as unknown as number[][],
    } as Partial<Plotly.Data>,
  ];
}

function camera3d(root: Root) {
  return async (azimuth: number, elevation: number) => {
    await Plotly.relayout(root, {
      "scene.camera.eye": eye(azimuth, elevation),
    } as Partial<Plotly.Layout>);
  };
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
  bubble: {
    prepare: bubbleTraces,
    async create(container, data, options) {
      const plotLayout = layout(options, { hovermode: options.tooltip ? "closest" : false });
      const root = await mount(container, bubbleTraces(data), plotLayout, options);
      return handle<BubbleData>(
        root,
        (next) => Plotly.react(root, bubbleTraces(next), plotLayout, config(options)),
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
  scatter3d: {
    prepare: scatter3dTraces,
    async create(container, data, options) {
      const plotLayout = scene3d(options);
      const root = await mount(container, scatter3dTraces(data), plotLayout, options);
      return {
        ...handle<Point3Data>(
          root,
          (next) => Plotly.react(root, scatter3dTraces(next), plotLayout, config(options)),
          plotLayout,
        ),
        setCamera: camera3d(root),
      };
    },
  },
  surface: {
    prepare: surfaceTraces,
    async create(container, data, options) {
      const plotLayout = scene3d(options);
      const root = await mount(container, surfaceTraces(data), plotLayout, options);
      return {
        ...handle<SurfaceData>(
          root,
          (next) => Plotly.react(root, surfaceTraces(next), plotLayout, config(options)),
          plotLayout,
        ),
        setCamera: camera3d(root),
      };
    },
  },
};
