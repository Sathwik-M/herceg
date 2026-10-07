import {
  area,
  bar,
  type Chart,
  candlestick,
  createChart,
  heatmap,
  line,
  point,
  table,
  time,
} from "herceg";
import type { CandleData, CategoryData, GridData, PointData, SeriesData } from "../datasets.ts";
import type { Adapter, ChartHandle, ChartKind, ChartOptions } from "../page/adapter.ts";
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
        pixelOf(_series, _index, x, y) {
          return clientPoint(
            chart.root,
            chart.model.xScale()!.map(x),
            chart.model.yScale()!.map(y),
          );
        },
        resize: (width, height) => chart.update({ width, height }),
        destroy: () => chart.destroy(),
      };
    },
  };
}

function common(
  chart: Chart,
): Pick<ChartHandle<unknown>, "pixelOf" | "resize" | "destroy" | "rendered"> {
  return {
    pixelOf: (_series, _index, x, y) =>
      clientPoint(chart.root, chart.model.xScale()!.map(x), chart.model.yScale()!.map(y)),
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
  renderer: { normal: "auto (svg below 4,000 drawn points, canvas above)", large: "auto" },
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
        marks: [point(source, { x: "x", y: "y", r: 1.5 })],
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
        marks: [heatmap(source, { x: "c", y: "r", value: "v", colors: ["#f7fbff", "#08306b"] })],
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
};
