// Scenario catalog shared by the browser harness and the Node runner.

export type ChartType =
  | "line"
  | "area"
  | "bar"
  | "scatter"
  | "heatmap"
  | "candlestick"
  | "histogram"
  | "bubble";

export type Operation =
  /** Create the chart and wait for the first frame. */
  | "init"
  /** Replace the dataset with another of the same shape. */
  | "update"
  /** Append `append` points per series, keep `points`, wait for a frame; repeat. */
  | "stream"
  /** Append on a timer at `rateHz` while frames run at the display rate (vsync on). */
  | "ingest"
  /** Move the pointer across the plot and wait for each frame. */
  | "hover"
  /** Toggle the container size. */
  | "resize"
  /** Show a sequence of x ranges (zoomed in, panning), waiting for each frame. */
  | "zoom"
  /** Retained heap, DOM nodes, and canvas pixels after creating the chart(s). */
  | "memory"
  /** Create `charts` line charts at once (dashboard), then refresh them all. */
  | "dashboard";

export interface Scenario {
  id: string;
  chart: ChartType;
  operation: Operation;
  /** Series count (line/area/bar) or 1. */
  series: number;
  /** Points per series, categories for bars, cells for heatmaps. */
  points: number;
  /** Use each library's documented large-data configuration. */
  large: boolean;
  tooltip: boolean;
  /** Number of charts mounted at once. */
  charts?: number;
  /** Streaming: points appended per series per tick. */
  append?: number;
  /** Paced ingestion rate and duration. */
  rateHz?: number;
  durationMs?: number;
  /** Measured samples; the runner may override. */
  samples: number;
  /** Seconds before the runner gives up on a library (default 600). */
  timeout?: number;
  warmup: number;
  description: string;
}

const s = (scenario: Scenario) => scenario;

export const SCENARIOS: Scenario[] = [
  // Initial render
  s({
    id: "line-small-init",
    chart: "line",
    operation: "init",
    series: 4,
    points: 200,
    large: false,
    tooltip: true,
    samples: 20,
    warmup: 5,
    description: "4 series x 200 points",
  }),
  s({
    id: "line-medium-init",
    chart: "line",
    operation: "init",
    series: 10,
    points: 5_000,
    large: false,
    tooltip: true,
    samples: 10,
    warmup: 3,
    description: "10 series x 5,000 points",
  }),
  s({
    id: "line-large-init",
    chart: "line",
    operation: "init",
    series: 1,
    points: 1_000_000,
    large: true,
    tooltip: true,
    samples: 5,
    warmup: 1,
    description: "1 series x 1,000,000 points",
  }),
  s({
    id: "area-medium-init",
    chart: "area",
    operation: "init",
    series: 3,
    points: 5_000,
    large: false,
    tooltip: true,
    samples: 10,
    warmup: 3,
    description: "3 filled series x 5,000 points",
  }),
  s({
    id: "bar-small-init",
    chart: "bar",
    operation: "init",
    series: 3,
    points: 12,
    large: false,
    tooltip: true,
    samples: 20,
    warmup: 5,
    description: "12 categories x 3 series",
  }),
  s({
    id: "bar-medium-init",
    chart: "bar",
    operation: "init",
    series: 4,
    points: 100,
    large: false,
    tooltip: true,
    samples: 10,
    warmup: 3,
    description: "100 categories x 4 series",
  }),
  s({
    id: "scatter-medium-init",
    chart: "scatter",
    operation: "init",
    series: 1,
    points: 10_000,
    large: false,
    tooltip: true,
    samples: 10,
    warmup: 3,
    description: "10,000 points",
  }),
  s({
    id: "scatter-large-init",
    chart: "scatter",
    operation: "init",
    series: 1,
    points: 200_000,
    large: true,
    tooltip: true,
    samples: 5,
    warmup: 1,
    description: "200,000 points",
  }),
  s({
    id: "heatmap-medium-init",
    chart: "heatmap",
    operation: "init",
    series: 1,
    points: 10_000,
    large: false,
    tooltip: true,
    samples: 10,
    warmup: 3,
    description: "100 x 100 cells",
  }),
  s({
    id: "heatmap-large-init",
    chart: "heatmap",
    operation: "init",
    series: 1,
    points: 250_000,
    large: true,
    tooltip: true,
    samples: 5,
    warmup: 1,
    description: "500 x 500 cells",
  }),
  s({
    id: "candlestick-small-init",
    chart: "candlestick",
    operation: "init",
    series: 1,
    points: 200,
    large: false,
    tooltip: true,
    samples: 10,
    warmup: 3,
    description: "200 candles, each drawn by every library",
  }),
  s({
    id: "candlestick-large-init",
    chart: "candlestick",
    operation: "init",
    series: 1,
    points: 100_000,
    large: true,
    tooltip: true,
    samples: 5,
    warmup: 1,
    description: "100,000 candles; each library's large-data strategy",
  }),
  s({
    id: "bubble-medium-init",
    chart: "bubble",
    operation: "init",
    series: 1,
    points: 10_000,
    large: false,
    tooltip: true,
    samples: 10,
    warmup: 3,
    description: "10,000 points sized and colored by two fields",
  }),
  s({
    id: "histogram-medium-init",
    chart: "histogram",
    operation: "init",
    series: 1,
    points: 10_000,
    large: false,
    tooltip: true,
    samples: 10,
    warmup: 3,
    description: "10,000 values in bins 5 wide from 25, x from 25 to 175",
  }),
  s({
    id: "histogram-large-init",
    chart: "histogram",
    operation: "init",
    series: 1,
    points: 1_000_000,
    large: true,
    tooltip: true,
    samples: 5,
    warmup: 1,
    description: "1,000,000 values in bins 5 wide from 25, x from 25 to 175",
  }),

  // Massive data: only libraries with a documented large-data path are
  // expected to finish; the others are recorded as errors or timeouts.
  s({
    id: "line-massive-init",
    chart: "line",
    operation: "init",
    series: 1,
    points: 10_000_000,
    large: true,
    tooltip: true,
    samples: 5,
    warmup: 1,
    timeout: 240,
    description: "1 series x 10,000,000 points",
  }),
  s({
    id: "scatter-massive-init",
    chart: "scatter",
    operation: "init",
    series: 1,
    points: 1_000_000,
    large: true,
    tooltip: true,
    samples: 5,
    warmup: 1,
    timeout: 240,
    description: "1,000,000 points",
  }),

  // Full data replacement
  s({
    id: "line-medium-update",
    chart: "line",
    operation: "update",
    series: 10,
    points: 5_000,
    large: false,
    tooltip: true,
    samples: 20,
    warmup: 5,
    description: "replace 10 x 5,000 points",
  }),
  s({
    id: "line-large-update",
    chart: "line",
    operation: "update",
    series: 1,
    points: 1_000_000,
    large: true,
    tooltip: true,
    samples: 5,
    warmup: 2,
    description: "replace 1,000,000 points",
  }),
  s({
    id: "bar-medium-update",
    chart: "bar",
    operation: "update",
    series: 4,
    points: 100,
    large: false,
    tooltip: true,
    samples: 20,
    warmup: 5,
    description: "replace 100 x 4 bars",
  }),
  s({
    id: "scatter-medium-update",
    chart: "scatter",
    operation: "update",
    series: 1,
    points: 10_000,
    large: false,
    tooltip: true,
    samples: 10,
    warmup: 3,
    description: "replace 10,000 points",
  }),
  s({
    id: "heatmap-medium-update",
    chart: "heatmap",
    operation: "update",
    series: 1,
    points: 10_000,
    large: false,
    tooltip: true,
    samples: 10,
    warmup: 3,
    description: "replace 100 x 100 cells",
  }),

  // Streaming: one tick = append + next frame
  s({
    id: "stream-dashboard-chart",
    chart: "line",
    operation: "stream",
    series: 15,
    points: 3_000,
    append: 1,
    large: false,
    tooltip: true,
    samples: 100,
    warmup: 10,
    description: "15 series, 3,000-point window, +1 point per tick",
  }),
  s({
    id: "stream-large",
    chart: "line",
    operation: "stream",
    series: 1,
    points: 100_000,
    append: 100,
    large: true,
    tooltip: true,
    samples: 50,
    warmup: 5,
    description: "1 series, 100,000-point window, +100 points per tick",
  }),
  s({
    id: "stream-massive",
    chart: "line",
    operation: "stream",
    series: 1,
    points: 1_000_000,
    append: 10_000,
    large: true,
    tooltip: true,
    // Enough ticks to cover several moves of the window's storage, which a
    // library may pay for every so many appended points.
    samples: 150,
    warmup: 5,
    description: "1 series, 1,000,000-point window, +10,000 points per tick",
  }),

  // Paced ingestion with normal frame scheduling
  {
    id: "ingest-chart-10hz",
    chart: "line",
    operation: "ingest",
    series: 15,
    points: 3_000,
    append: 1,
    rateHz: 10,
    durationMs: 5_000,
    large: false,
    tooltip: true,
    samples: 2,
    warmup: 1,
    description: "15 series, 3,000-point window, +1 point at 10 Hz",
  },
  {
    id: "ingest-chart-60hz",
    chart: "line",
    operation: "ingest",
    series: 15,
    points: 3_000,
    append: 1,
    rateHz: 60,
    durationMs: 5_000,
    large: false,
    tooltip: true,
    samples: 2,
    warmup: 1,
    description: "15 series, 3,000-point window, +1 point at 60 Hz",
  },
  {
    id: "ingest-chart-100hz",
    chart: "line",
    operation: "ingest",
    series: 15,
    points: 3_000,
    append: 1,
    rateHz: 100,
    durationMs: 5_000,
    large: false,
    tooltip: true,
    samples: 2,
    warmup: 1,
    description: "15 series, 3,000-point window, +1 point at 100 Hz",
  },
  {
    id: "ingest-large-100hz",
    chart: "line",
    operation: "ingest",
    series: 1,
    points: 100_000,
    append: 10,
    rateHz: 100,
    durationMs: 5_000,
    large: true,
    tooltip: true,
    samples: 2,
    warmup: 1,
    description: "1 series, 100,000-point window, +10 points at 100 Hz",
  },
  {
    id: "ingest-dashboard-10hz",
    chart: "line",
    operation: "ingest",
    series: 15,
    points: 3_000,
    charts: 10,
    append: 1,
    rateHz: 10,
    durationMs: 5_000,
    large: false,
    tooltip: true,
    samples: 2,
    warmup: 1,
    description: "10 charts x 15 series x 3,000 points, +1 point per series at 10 Hz",
  },

  // Interaction
  s({
    id: "hover-line-medium",
    chart: "line",
    operation: "hover",
    series: 10,
    points: 5_000,
    large: false,
    tooltip: true,
    samples: 60,
    warmup: 10,
    description: "pointer moves over 10 x 5,000 points",
  }),
  s({
    id: "hover-line-large",
    chart: "line",
    operation: "hover",
    series: 1,
    points: 1_000_000,
    large: true,
    tooltip: true,
    samples: 30,
    warmup: 5,
    description: "pointer moves over 1,000,000 points",
  }),
  s({
    id: "hover-scatter-medium",
    chart: "scatter",
    operation: "hover",
    series: 1,
    points: 10_000,
    large: false,
    tooltip: true,
    samples: 60,
    warmup: 10,
    description: "pointer moves over 10,000 points",
  }),
  s({
    id: "zoom-line-large",
    chart: "line",
    operation: "zoom",
    series: 1,
    points: 1_000_000,
    large: true,
    tooltip: true,
    samples: 30,
    warmup: 6,
    description: "x ranges of 50%, 10%, and 1% of 1,000,000 points, panning",
  }),
  s({
    id: "zoom-line-massive",
    chart: "line",
    operation: "zoom",
    series: 1,
    points: 10_000_000,
    large: true,
    tooltip: true,
    samples: 15,
    warmup: 3,
    timeout: 240,
    description: "x ranges of 50%, 10%, and 1% of 10,000,000 points, panning",
  }),
  s({
    id: "zoom-scatter-massive",
    chart: "scatter",
    operation: "zoom",
    series: 1,
    points: 1_000_000,
    large: true,
    tooltip: true,
    samples: 15,
    warmup: 3,
    timeout: 240,
    description: "x ranges of 50%, 10%, and 1% of 1,000,000 points, panning",
  }),
  s({
    id: "resize-line-medium",
    chart: "line",
    operation: "resize",
    series: 10,
    points: 5_000,
    large: false,
    tooltip: true,
    samples: 20,
    warmup: 4,
    description: "resize 800x400 <-> 600x300",
  }),

  // Dashboard: 10 charts x 15 series x 3,000 points = 450,000 points
  s({
    id: "dashboard",
    chart: "line",
    operation: "dashboard",
    series: 15,
    points: 3_000,
    charts: 10,
    large: false,
    tooltip: true,
    samples: 5,
    warmup: 1,
    description: "10 charts x 15 series x 3,000 points",
  }),

  // Memory
  s({
    id: "memory-line-large",
    chart: "line",
    operation: "memory",
    series: 1,
    points: 1_000_000,
    large: true,
    tooltip: true,
    samples: 3,
    warmup: 0,
    description: "1 chart, 1,000,000 points",
  }),
  s({
    id: "memory-dashboard",
    chart: "line",
    operation: "memory",
    series: 15,
    points: 3_000,
    charts: 10,
    large: false,
    tooltip: true,
    samples: 3,
    warmup: 0,
    description: "10 charts x 15 series x 3,000 points",
  }),
  s({
    id: "memory-small-100",
    chart: "line",
    operation: "memory",
    series: 2,
    points: 100,
    charts: 100,
    large: false,
    tooltip: true,
    samples: 3,
    warmup: 0,
    description: "100 charts x 2 series x 100 points",
  }),
];

export function scenario(id: string): Scenario {
  const found = SCENARIOS.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Unknown scenario: ${id}`);
  return found;
}
