import {
  area,
  bar,
  type Chart,
  candlestick,
  createChart,
  heatmap,
  histogram,
  line,
  point,
  point3d,
  surface,
  table,
  time,
} from "herceg";
import {
  BUBBLE,
  type BubbleData,
  type CandleData,
  type CategoryData,
  type GridData,
  type Point3Data,
  type PointData,
  type SampleData,
  type SeriesData,
  type SurfaceData,
} from "../datasets.ts";
import type { Adapter, ChartHandle, ChartKind, ChartOptions, Point } from "../page/adapter.ts";
import { clientPoint } from "../page/adapter.ts";

// Herceg reads the benchmark's typed arrays in place: a table wraps them
// without copying. The table's maxRows makes it a rolling window, which is
// Herceg's documented streaming path.
export function seriesTable(data: SeriesData) {
  const columns: Record<string, Float64Array | ReturnType<typeof time>> = { t: time(data.x) };
  data.ys.forEach((y, s) => {
    columns[`s${s}`] = y;
  });
  return table(columns, { maxRows: data.x.length });
}

export function columnsOf(data: SeriesData) {
  const columns: Record<string, Float64Array> = { t: data.x };
  data.ys.forEach((y, s) => {
    columns[`s${s}`] = y;
  });
  return columns;
}

/** Streaming: append a batch to every series and keep the newest `keep` rows. */
export function appendTo(
  source: ReturnType<typeof seriesTable>,
  x: Float64Array,
  ys: Float64Array[],
  keep: number,
): void {
  const batch: Record<string, Float64Array> = { t: x };
  ys.forEach((y, s) => {
    batch[`s${s}`] = y;
  });
  source.append(batch);
  if (source.length > keep) source.dropFirst(source.length - keep);
}

function lineKind(fill: boolean): ChartKind<SeriesData> {
  return {
    prepare: seriesTable,
    create(
      container: HTMLElement,
      data: SeriesData,
      options: ChartOptions,
    ): ChartHandle<SeriesData> {
      const source = seriesTable(data);
      const fields = data.ys.map((_, s) => `s${s}`);
      const chart = createChart(container, {
        width: options.width,
        height: options.height,
        tooltip: options.tooltip,
        marks: [fill ? area(source, { x: "t", y: fields }) : line(source, { x: "t", y: fields })],
      });
      return {
        setData: (next) => source.reset(columnsOf(next)),
        append: (x, ys, keep) => appendTo(source, x, ys, keep),
        setViewport: (x0, x1) => chart.setViewport([x0, x1]),
        pixelOf: (_series, _index, x, y) => pixelOf(chart, x, y),
        resize: (width, height) => chart.update({ width, height }),
        destroy: () => chart.destroy(),
      };
    },
  };
}

/** Where data values are on the page, as the chart last drew them. */
export function pixelOf(chart: Chart, x: number, y: number): Point {
  return clientPoint(
    chart.root,
    chart.toPixel(x, { axis: "x" })!,
    chart.toPixel(y, { axis: "y" })!,
  );
}

function common(
  chart: Chart,
): Pick<ChartHandle<unknown>, "pixelOf" | "resize" | "destroy" | "rendered"> {
  return {
    pixelOf: (_series, _index, x, y) => pixelOf(chart, x, y),
    resize: (width, height) => chart.update({ width, height }),
    destroy: () => chart.destroy(),
    // Large point series wait for the GPU painter, which loads on demand.
    rendered: () => chart.loading,
  };
}

function barColumns(data: CategoryData) {
  const columns: Record<string, Float64Array | string[]> = { category: data.categories };
  data.series.forEach((s, i) => {
    columns[`s${i}`] = s.values;
  });
  return columns;
}

function candleColumns(data: CandleData) {
  return { t: time(data.x), o: data.open, h: data.high, l: data.low, c: data.close };
}

// A surface's grid points as one row each, as a long table gives them.
function surfaceColumns(data: SurfaceData) {
  const side = data.x.length;
  const x = new Float64Array(data.z.length);
  const y = new Float64Array(data.z.length);
  for (let k = 0; k < data.z.length; k++) {
    x[k] = data.x[k % side]!;
    y[k] = data.y[Math.floor(k / side)]!;
  }
  return { x, y, z: data.z };
}

/** A 3D chart's handle: `setCamera` turns it; there are no x and y scales to aim pointers with. */
function solid(chart: Chart): Omit<ChartHandle<never>, "setData"> {
  return {
    pixelOf: () => clientPoint(chart.root, 0, 0),
    resize: (width, height) => chart.update({ width, height }),
    destroy: () => chart.destroy(),
    // Large point clouds wait for the GPU painter, which loads on demand.
    rendered: () => chart.loading,
    setCamera: (azimuth, elevation) => chart.setCamera({ azimuth, elevation }),
  };
}

// Heatmap cells as one row each: column index, row index, value.
function gridColumns(data: GridData) {
  const count = data.columns * data.rows;
  const c = new Float64Array(count);
  const r = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    c[i] = i % data.columns;
    r[i] = Math.floor(i / data.columns);
  }
  return { c, r, v: data.values };
}

export const adapter: Adapter = {
  id: "herceg",
  renderer: {
    normal:
      "auto (svg below 4,000 drawn points, canvas above; 3D charts on WebGL from 20,000 points or 10,000 surface cells)",
    large: "auto",
  },
  line: lineKind(false),
  area: lineKind(true),
  bar: {
    prepare: (data) => table(barColumns(data)),
    create(container, data, options) {
      const source = table(barColumns(data));
      const fields = data.series.map((_, i) => `s${i}`);
      const chart = createChart(container, {
        width: options.width,
        height: options.height,
        tooltip: options.tooltip,
        marks: [bar(source, { x: "category", y: fields })],
      });
      return { ...common(chart), setData: (next) => source.reset(barColumns(next)) };
    },
  },
  scatter: {
    prepare: (data) => table({ x: data.x, y: data.y }),
    create(container, data, options) {
      const source = table({ x: data.x, y: data.y });
      const chart = createChart(container, {
        width: options.width,
        height: options.height,
        tooltip: options.tooltip,
        marks: [point(source, { x: "x", y: "y", radius: 1.5 })],
      });
      return {
        ...common(chart),
        setData: (next: PointData) => source.reset({ x: next.x, y: next.y }),
        setViewport: (x0, x1) => chart.setViewport([x0, x1]),
      };
    },
  },
  heatmap: {
    prepare: (data) => table(gridColumns(data)),
    create(container, data, options) {
      const source = table(gridColumns(data));
      const chart = createChart(container, {
        width: options.width,
        height: options.height,
        tooltip: options.tooltip,
        // Same ramp and no color legend, as configured for the other libraries.
        legend: false,
        marks: [heatmap(source, { x: "c", y: "r", color: "v", colors: ["#f7fbff", "#08306b"] })],
      });
      return { ...common(chart), setData: (next) => source.reset(gridColumns(next)) };
    },
  },
  candlestick: {
    prepare: (data) => table(candleColumns(data)),
    create(container, data, options) {
      const source = table(candleColumns(data));
      const chart = createChart(container, {
        width: options.width,
        height: options.height,
        tooltip: options.tooltip,
        marks: [candlestick(source, { x: "t", open: "o", high: "h", low: "l", close: "c" })],
      });
      return { ...common(chart), setData: (next) => source.reset(candleColumns(next)) };
    },
  },
  histogram: {
    prepare: (data) => table({ v: data.values }),
    create(container, data, options) {
      const source = table({ v: data.values });
      const chart = createChart(container, {
        width: options.width,
        height: options.height,
        tooltip: options.tooltip,
        // The fixed grid and x range every library is given: 5 wide from 25 to 175.
        x: { domain: [25, 175] },
        marks: [histogram(source, { x: "v", bins: { step: 5, start: 25 } })],
      });
      return {
        ...common(chart),
        setData: (next: SampleData) => source.reset({ v: next.values }),
      };
    },
  },
  bubble: {
    prepare: (data) => table(bubbleColumns(data)),
    create(container, data, options) {
      const source = table(bubbleColumns(data));
      const chart = createChart(container, {
        width: options.width,
        height: options.height,
        tooltip: options.tooltip,
        // No size key or color legend, as configured for the other libraries.
        legend: false,
        marks: [
          point(source, {
            x: "x",
            y: "y",
            size: "s",
            radiusRange: [BUBBLE.minRadius, BUBBLE.maxRadius],
            color: "v",
            colors: BUBBLE.colors,
          }),
        ],
      });
      return { ...common(chart), setData: (next) => source.reset(bubbleColumns(next)) };
    },
  },
  // Orthographic projection and the default camera, with 3.5 px points of
  // one color; surfaces colored by height and shaded, Herceg's defaults.
  scatter3d: {
    prepare: (data) => table({ x: data.x, y: data.y, z: data.z }),
    create(container, data, options) {
      const source = table({ x: data.x, y: data.y, z: data.z });
      const chart = createChart(container, {
        width: options.width,
        height: options.height,
        tooltip: options.tooltip,
        marks: [point3d(source, { x: "x", y: "y", z: "z" })],
      });
      return {
        ...solid(chart),
        setData: (next: Point3Data) => source.reset({ x: next.x, y: next.y, z: next.z }),
      };
    },
  },
  surface: {
    prepare: (data) => table(surfaceColumns(data)),
    create(container, data, options) {
      const source = table(surfaceColumns(data));
      const chart = createChart(container, {
        width: options.width,
        height: options.height,
        tooltip: options.tooltip,
        marks: [surface(source, { x: "x", y: "y", z: "z" })],
      });
      return {
        ...solid(chart),
        setData: (next: SurfaceData) => source.reset(surfaceColumns(next)),
      };
    },
  },
};

function bubbleColumns(data: BubbleData) {
  return { x: data.x, y: data.y, s: data.size, v: data.value };
}
