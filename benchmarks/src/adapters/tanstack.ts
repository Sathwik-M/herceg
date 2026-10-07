import { areaY, barY, cell, defineChart, dot, group, lineY, mountChart } from "@tanstack/charts";
import { mountCanvasChart } from "@tanstack/charts/canvas";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { scaleOrdinal } from "@tanstack/charts/scales/ordinal";
import { tooltip } from "@tanstack/charts/tooltip";
import { interpolateRgb } from "d3-interpolate";
import { scaleSequential, scaleUtc } from "d3-scale";
import type { CategoryData, GridData, PointData, SeriesData } from "../datasets.ts";
import type { Adapter, ChartHandle, ChartOptions } from "../page/adapter.ts";
import { clientPoint, color, PALETTE, rollArray } from "../page/adapter.ts";

// TanStack marks consume row objects; one row per point. Its temporal scales
// require Date values.
type Point = { t: Date; v: number };

function seriesRows(data: SeriesData): Point[][] {
  return data.ys.map((y) => {
    const rows: Point[] = new Array(y.length);
    for (let i = 0; i < y.length; i++) rows[i] = { t: new Date(data.x[i]!), v: y[i]! };
    return rows;
  });
}

// The definition object is TanStack's update boundary, so its exact generic
// type is not useful to the benchmark.
type Definition = Parameters<typeof mountChart>[1]["definition"];

function mount(container: HTMLElement, definition: Definition, options: ChartOptions) {
  const hostOptions = {
    definition,
    width: options.width,
    height: options.height,
    ariaLabel: "Benchmark chart",
  };
  // Canvas is TanStack's opt-in renderer for dense data.
  const host = options.large
    ? mountCanvasChart(container, hostOptions)
    : mountChart(container, hostOptions);
  return {
    update(next: Definition) {
      hostOptions.definition = next;
      host.update(hostOptions);
    },
    resize(width: number, height: number) {
      hostOptions.width = width;
      hostOptions.height = height;
      host.update(hostOptions);
    },
    /** Scene coordinates of the point with `index` in the mark's data, per mark in order. */
    point(series: number, index: number) {
      const candidates = host.getScene().points.filter((point) => point.datumIndex === index);
      return candidates[series] ?? candidates[0];
    },
    destroy: () => host.destroy(),
  };
}

function handle<T>(
  container: HTMLElement,
  host: ReturnType<typeof mount>,
  build: (data: T) => Definition,
): ChartHandle<T> {
  return {
    setData: (data) => host.update(build(data)),
    pixelOf(series, index) {
      const point = host.point(series, index);
      const surface = container.querySelector("svg, canvas") ?? container;
      return clientPoint(surface, point?.x ?? 0, point?.y ?? 0);
    },
    resize: host.resize,
    destroy: host.destroy,
  };
}

/**
 * The rows a window shows, plus one on each side so lines reach the edges.
 * TanStack's zoom guide leaves visible-row filtering to the application.
 */
function visibleRows(series: Point[], x0: number, x1: number): Point[] {
  const firstAtOrAfter = (value: number) => {
    let lo = 0;
    let hi = series.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (series[mid]!.t.getTime() < value) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return series.slice(Math.max(0, firstAtOrAfter(x0) - 1), firstAtOrAfter(x1) + 1);
}

function lineDefinition(
  rows: Point[][],
  options: ChartOptions,
  fill: boolean,
  window?: [number, number],
): Definition {
  const shown = window ? rows.map((series) => visibleRows(series, ...window)) : rows;
  return defineChart({
    marks: shown.map((series, s) =>
      fill
        ? areaY(series, { x: "t", y2: "v", y1: 0, fill: color(s), fillOpacity: 0.25 })
        : lineY(series, { x: "t", y: "v", stroke: color(s), strokeWidth: 1.5 }),
    ),
    scales: {
      // A zoomed chart's x scale is bound to the window, as in TanStack's zoom guide.
      x: { scale: window ? scaleUtc().domain(window.map((t) => new Date(t))) : scaleUtc },
      y: { scale: scaleLinear, nice: true },
    },
    focus: options.tooltip ? "group-x" : false,
    pointer: options.tooltip,
    ...(options.tooltip ? { tooltip } : {}),
  }) as Definition;
}

function lineKind(fill: boolean) {
  return {
    prepare: seriesRows,
    create(
      container: HTMLElement,
      data: SeriesData,
      options: ChartOptions,
    ): ChartHandle<SeriesData> {
      let rows = seriesRows(data);
      const host = mount(container, lineDefinition(rows, options, fill), options);
      return {
        ...handle<SeriesData>(container, host, (next) => {
          rows = seriesRows(next);
          return lineDefinition(rows, options, fill);
        }),
        // A new definition per update is TanStack's documented update path.
        append(x, ys, keep) {
          ys.forEach((y, s) => {
            const added: Point[] = new Array(x.length);
            for (let i = 0; i < x.length; i++) added[i] = { t: new Date(x[i]!), v: y[i]! };
            rollArray(rows[s]!, added, keep);
          });
          host.update(lineDefinition(rows, options, fill));
        },
        setViewport: (x0, x1) => host.update(lineDefinition(rows, options, fill, [x0, x1])),
      };
    },
  };
}

type BarRow = { category: string; series: string; value: number };

function barRows(data: CategoryData): BarRow[] {
  const rows: BarRow[] = [];
  data.categories.forEach((category, i) => {
    for (const series of data.series)
      rows.push({ category, series: series.name, value: series.values[i]! });
  });
  return rows;
}

function barDefinition(rows: BarRow[], data: CategoryData, options: ChartOptions): Definition {
  return defineChart({
    marks: [barY(rows, { x: "category", y: "value", color: "series", layout: group() })],
    scales: {
      x: { scale: () => scaleBand<string>().padding(0.2) },
      y: { scale: scaleLinear, nice: true },
    },
    color: {
      scale: () =>
        scaleOrdinal<string, string>()
          .domain(data.series.map((s) => s.name))
          .range(PALETTE),
    },
    focus: options.tooltip ? "group-x" : false,
    pointer: options.tooltip,
    ...(options.tooltip ? { tooltip } : {}),
  }) as Definition;
}

type XYRow = { x: number; y: number };

function scatterRows(data: PointData): XYRow[] {
  const rows: XYRow[] = new Array(data.x.length);
  for (let i = 0; i < data.x.length; i++) rows[i] = { x: data.x[i]!, y: data.y[i]! };
  return rows;
}

function scatterDefinition(rows: XYRow[], options: ChartOptions): Definition {
  return defineChart({
    marks: [dot(rows, { x: "x", y: "y", r: 1.5, fill: color(0) })],
    scales: {
      x: { scale: scaleLinear, nice: true },
      y: { scale: scaleLinear, nice: true },
    },
    focus: options.tooltip ? "nearest" : false,
    pointer: options.tooltip,
    ...(options.tooltip ? { tooltip } : {}),
  }) as Definition;
}

type CellRow = { column: number; row: number; value: number };

function cellRows(data: GridData): CellRow[] {
  const rows: CellRow[] = new Array(data.values.length);
  for (let r = 0; r < data.rows; r++) {
    for (let c = 0; c < data.columns; c++) {
      const i = r * data.columns + c;
      rows[i] = { column: c, row: r, value: data.values[i]! };
    }
  }
  return rows;
}

function heatmapDefinition(rows: CellRow[], data: GridData, options: ChartOptions): Definition {
  return defineChart({
    marks: [cell(rows, { x: "column", y: "row", color: "value" })],
    scales: {
      x: {
        scale: () => scaleBand<number>().domain(Array.from({ length: data.columns }, (_, i) => i)),
      },
      y: {
        scale: () => scaleBand<number>().domain(Array.from({ length: data.rows }, (_, i) => i)),
      },
    },
    color: { scale: () => scaleSequential(interpolateRgb("#f7fbff", "#08306b")) },
    focus: options.tooltip ? "nearest" : false,
    pointer: options.tooltip,
    ...(options.tooltip ? { tooltip } : {}),
  }) as Definition;
}

export const adapter: Adapter = {
  id: "tanstack",
  renderer: { normal: "svg", large: "canvas (mountCanvasChart)" },
  line: lineKind(false),
  area: lineKind(true),
  bar: {
    prepare: barRows,
    create(container, data, options) {
      const host = mount(container, barDefinition(barRows(data), data, options), options);
      return handle<CategoryData>(container, host, (next) =>
        barDefinition(barRows(next), next, options),
      );
    },
  },
  scatter: {
    prepare: scatterRows,
    create(container, data, options) {
      const host = mount(container, scatterDefinition(scatterRows(data), options), options);
      return handle<PointData>(container, host, (next) =>
        scatterDefinition(scatterRows(next), options),
      );
    },
  },
  heatmap: {
    prepare: cellRows,
    create(container, data, options) {
      const host = mount(container, heatmapDefinition(cellRows(data), data, options), options);
      return handle<GridData>(container, host, (next) =>
        heatmapDefinition(cellRows(next), next, options),
      );
    },
  },
};
