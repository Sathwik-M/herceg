# Comparison with other chart libraries

This page compares Herceg with Apache ECharts, TanStack Charts, Chart.js, and
Plotly. uPlot is included in the measurements as a reference point for fast
time-series rendering. Each entry is one of:

- **Measured** — produced by the benchmark suite in `benchmarks/`; raw data is
  in `benchmarks/results/*.json`. Methodology: `benchmarks/README.md`.
- **Documented** — taken from the library's official documentation, not
  measured here.
- **Not implemented** / **Not measured** — stated as such.

Measurements come from one machine and one browser. They describe relative
behavior under the stated configuration, not universal speedups.

## Status

Herceg does not render charts yet. The tables below are the competitor
baseline that Herceg will be measured against; Herceg columns are added to the
benchmark suite as features land.

## Summary

| Area | Herceg | ECharts | TanStack Charts | Chart.js | Plotly |
| --- | --- | --- | --- | --- | --- |
| Initial render | Not implemented | Measured. Canvas; fast for small charts, ~160 ms for a 1M-point line with `minmax` sampling. Scatter and heatmap series render progressively: a 500x500 heatmap shows its first frame after ~60 ms and completes after ~9 s. | Measured. Fast small SVG charts; cost grows with rows because every row becomes a scene node (~0.8 s for 1M points on Canvas). | Measured. Fast for small and medium charts; min-max decimation makes 1M points cheap once the `{x, y}` objects exist. | Measured. Slowest small charts; SVG scatter is expensive at 10k points, WebGL traces handle large data. |
| Incremental update | Not implemented | Measured. `setOption` re-processes the series; no rolling-window append. | Measured. Updates rebuild the definition and scene. | Measured. Mutate arrays and `update('none')`; cheap. | Measured. `extendTraces` with `maxPoints` gives a documented rolling window, but each tick costs 20–30 ms here. |
| Streaming | Not implemented | Measured. ~11 ms per tick for 15 series x 3,000 points; keeps up with 100 Hz ingestion for one chart but drops frames for a 10-chart dashboard at 10 Hz. | Measured. ~31 ms per tick; at 60–100 Hz ingestion only ~33 updates per second get through. | Measured. ~3.5 ms per tick; keeps up in every paced scenario. | Measured. ~20 ms per tick; ~54 updates per second at 100 Hz, ~6 Hz for the 10-chart dashboard. |
| Memory | Not implemented | Measured. ~240 MB retained for 1M points (internal storage plus per-point structures). | Measured. ~600 MB retained for 1M points (row objects, Dates, scene nodes). | Measured. ~49 MB for 1M points (one `{x, y}` object per point). | Measured. ~110 MB for 1M points with WebGL. |
| Bundle size (line chart, gzip) | Not implemented | Measured. ~167 KiB tree-shaken, ~371 KiB full. | Measured. ~44 KiB including `d3-scale` for time. | Measured. ~64 KiB with time scale and date adapter. | Measured. ~391 KiB basic bundle, ~1.4 MiB full. |
| Line | Not implemented | Documented. Time axes, sampling, area fill, step lines. | Documented. `lineY`/`lineX`, gaps, curves. | Documented. Line, stepped, filled; decimation plugin. | Documented. `scatter`/`scattergl` lines, rich hover. |
| Scatter | Not implemented | Documented. `large` mode for big scatter. | Documented. `dot` mark; one scene node per point. | Documented. Scatter/bubble. | Documented. SVG and WebGL scatter. |
| Heatmap | Not implemented | Documented. Heatmap series, calendar heatmap. | Documented. `cell` mark with a D3 color scale. | No built-in heatmap (third-party `chartjs-chart-matrix`). | Documented. Heatmap traces rendered as an image. |
| Composition | Not implemented | Documented. Many series types in one grid, `markLine`/`markArea`, `custom` series. | Documented. Grammar of marks; strongest composition model of the group. | Documented. Mixed chart types; annotations via plugin. | Documented. Traces, layout shapes and annotations, subplots. |
| TypeScript | Not implemented | Documented. Large option types; tree-shaken `ComposeOption` types. | Documented. Fields and callbacks inferred from row types. | Documented. Typed configuration generics. | Community `@types/plotly.js`, not first-party. |
| React | Not implemented | Community wrappers (for example `echarts-for-react`). | First-party adapters for React and other frameworks. | Community `react-chartjs-2`. | `react-plotly.js`. |
| Python | Not implemented | Community `pyecharts`. | None. | None. | First-class Plotly Python and Plotly Express. |
| Accessibility | Not implemented | Documented. `aria` option generates descriptions; decal patterns. | Documented. Required accessible name, keyboard focus navigation. | Canvas only; the application supplies fallback content. | Limited; no keyboard navigation of data. |
| Export | Not implemented | Documented. PNG/SVG from the browser, server-side SVG strings. | Documented. Static SVG, SSR, browser raster export. | PNG via `toBase64Image`. | Documented. PNG/SVG/JPEG/WebP; Kaleido for Python. |
| Ease of use | Not implemented | Large declarative option object; many examples. | Typed grammar; scales and D3 modules are explicit imports. | Simple for standard charts; plugins for the rest. | Very quick for common charts, especially Plotly Express. |

## Environment

<!-- results:environment -->
- Date: 2026-10-07, commit none (uncommitted changes)
- Machine: Apple M6, 12 cores, 32 GB, Darwin 27.0.0
- Browser: Chrome 154.0.8037.99, GPU ANGLE (Apple, ANGLE Metal Renderer: Apple M6, Unspecified Version), headed
- Viewport 1280x1400, device pixel ratio 2
- Libraries: echarts 6.1.0, chartjs 4.5.1, plotly 4.1.2, tanstack 1.0.0, uplot 1.6.32
- Renderers (normal / large config): echarts: canvas / canvas (sampling: minmax, large: true); chartjs: canvas / canvas (parsing: false, min-max decimation); plotly: svg / webgl (scattergl); tanstack: svg / canvas (mountCanvasChart); uplot: canvas / canvas
<!-- /results:environment -->

## Bundle size

Each entry renders the same time-series line chart with a tooltip and is
bundled for production with tree shaking (`benchmarks/src/size/entries/`).

<!-- results:size -->
| Entry | Version | Minified KiB | Gzip KiB | Brotli KiB | Required CSS, gzip KiB |
| --- | ---: | ---: | ---: | ---: | ---: |
| chartjs-auto | 4.5.1 | 246.8 | 79.9 | 69.3 | - |
| chartjs-line | 4.5.1 | 196.4 | 63.7 | 56.0 | - |
| echarts-full | 6.1.0 | 1107.9 | 370.5 | 302.3 | - |
| echarts-line | 6.1.0 | 490.7 | 166.8 | 142.7 | - |
| plotly-basic | 4.1.2 | 1184.3 | 391.4 | 325.2 | - |
| plotly-full | 4.1.2 | 4699.6 | 1432.7 | 1084.5 | - |
| tanstack-line | 1.0.0 | 125.5 | 44.4 | 39.4 | - |
| uplot | 1.6.32 | 50.9 | 22.5 | 20.4 | 0.7 |
<!-- /results:size -->

## Initial render

Time from calling the library until rendering is complete and the next frame
has been produced. Libraries that need a different input format convert the
shared typed-array dataset inside the timed operation, as an application with
columnar data would. Scenarios marked large use each library's documented
large-data configuration (see the renderer line under Environment). Libraries
that render progressively (ECharts scatter and heatmap series) show part of
the chart early; the first-frame time is given in parentheses when it is
much lower than the time to complete rendering.

<!-- results:init -->
| Scenario (ms, median ± MAD) | echarts | chartjs | plotly | tanstack | uplot |
| --- | ---: | ---: | ---: | ---: | ---: |
| line-small-init (4 series x 200 points) | 1.52 ± 0.18 | 1.79 ± 0.21 | 3.34 ± 0.29 | 1.34 ± 0.25 | 0.61 ± 0.12 |
| line-medium-init (10 series x 5,000 points) | 11.9 ± 1.32 | 6.28 ± 0.63 | 22.9 ± 2.44 | 38.4 ± 3.11 | 2.42 ± 0.19 |
| line-large-init (1 series x 1,000,000 points) | 157 ± 12.1 | 15.4 ± 1.31 | 320 ± 14.2 | 781 ± 15.6 | 7.58 ± 0.28 |
| area-medium-init (3 filled series x 5,000 points) | 5.68 ± 0.23 | 3.18 ± 0.23 | 11.0 ± 1.93 | 16.1 ± 1.68 | 1.19 ± 0.17 |
| bar-small-init (12 categories x 3 series) | 1.46 ± 0.33 | 0.72 ± 0.11 | 2.74 ± 0.35 | 0.63 ± 0.08 | n/a |
| bar-medium-init (100 categories x 4 series) | 3.21 ± 0.16 | 2.07 ± 0.12 | 6.81 ± 0.21 | 2.90 ± 0.32 | n/a |
| scatter-medium-init (10,000 points) | 81.6 ± 2.01 (first frame 4.91) | 4.57 ± 0.77 | 78.1 ± 3.51 | 27.7 ± 1.83 | n/a |
| scatter-large-init (200,000 points) | 65.4 ± 3.61 (first frame 45.6) | 69.8 ± 3.42 | 47.3 ± 3.25 | 239 ± 5.24 | n/a |
| heatmap-medium-init (100 x 100 cells) | 33.5 ± 1.43 (first frame 5.48) | n/a | 3.40 ± 0.19 | 36.3 ± 2.15 | n/a |
| heatmap-large-init (500 x 500 cells) | 9286 ± 176 (first frame 61.9) | n/a | 28.2 ± 0.52 | 468 ± 34.0 | n/a |
<!-- /results:init -->

## Full data replacement

<!-- results:update -->
| Scenario (ms, median ± MAD) | echarts | chartjs | plotly | tanstack | uplot |
| --- | ---: | ---: | ---: | ---: | ---: |
| line-medium-update (replace 10 x 5,000 points) | 12.0 ± 1.09 | 4.29 ± 0.36 | 19.7 ± 0.70 | 37.0 ± 1.46 | 1.25 ± 0.17 |
| line-large-update (replace 1,000,000 points) | 193 ± 18.3 | 13.9 ± 1.34 | 277 ± 2.09 | 733 ± 78.3 | 6.04 ± 0.95 |
| bar-medium-update (replace 100 x 4 bars) | 2.31 ± 0.24 | 1.70 ± 0.09 | 6.24 ± 0.70 | 3.05 ± 0.27 | n/a |
| scatter-medium-update (replace 10,000 points) | 95.3 ± 1.53 (first frame 19.5) | 3.88 ± 0.68 | 65.3 ± 2.02 | 42.4 ± 1.19 | n/a |
| heatmap-medium-update (replace 100 x 100 cells) | 44.2 ± 1.53 (first frame 19.2) | n/a | 3.77 ± 0.20 | 45.9 ± 1.83 | n/a |
<!-- /results:update -->

## Streaming

One tick appends points to every series, drops the oldest points to keep the
window size, and waits for the next frame. Each library uses its documented
live-data path: `setOption` (ECharts), array mutation plus `update('none')`
(Chart.js), `extendTraces` with `maxPoints` (Plotly), a new definition
(TanStack Charts), and `setData` (uPlot).

<!-- results:stream -->
| Scenario (ms, median ± MAD) | echarts | chartjs | plotly | tanstack | uplot |
| --- | ---: | ---: | ---: | ---: | ---: |
| stream-dashboard-chart (15 series, 3,000-point window, +1 point per tick) | 10.7 ± 0.81 | 3.54 ± 0.44 | 19.7 ± 0.86 | 31.0 ± 1.64 | 0.91 ± 0.10 |
| stream-large (1 series, 100,000-point window, +100 points per tick) | 18.2 ± 1.57 | 3.16 ± 0.25 | 29.9 ± 0.70 | 56.1 ± 2.88 | 0.90 ± 0.07 |
<!-- /results:stream -->

### Paced ingestion

A timer appends data at a fixed rate for five seconds while the display runs
at its normal refresh rate; each library decides when to render. A frame
interval spanning k refresh periods counts as k - 1 dropped frames. When a
library blocks the main thread, the timer fires less often and the achieved
ingestion rate drops below the target.

<!-- results:ingest -->
| Scenario (frame interval p50 / p95 / p99, dropped frames, achieved ingest rate) | echarts | chartjs | plotly | tanstack | uplot |
| --- | ---: | ---: | ---: | ---: | ---: |
| ingest-chart-10hz (15 series, 3,000-point window, +1 point at 10 Hz) | 16.7 / 17.8 / 18.4 ms, 0 dropped, 10 Hz | 16.7 / 18.0 / 18.5 ms, 0 dropped, 10 Hz | 16.7 / 17.6 / 18.3 ms, 1 dropped, 10 Hz | 16.7 / 17.6 / 18.3 ms, 1 dropped, 10 Hz | 16.7 / 17.8 / 18.4 ms, 0 dropped, 10 Hz |
| ingest-chart-60hz (15 series, 3,000-point window, +1 point at 60 Hz) | 16.7 / 17.6 / 18.4 ms, 0 dropped, 62 Hz | 16.7 / 17.6 / 18.0 ms, 0 dropped, 62 Hz | 16.7 / 33.3 / 34.2 ms, 27.5 dropped, 54 Hz | 33.3 / 34.2 / 35.1 ms, 134 dropped, 33 Hz | 16.7 / 17.9 / 18.5 ms, 0 dropped, 62 Hz |
| ingest-chart-100hz (15 series, 3,000-point window, +1 point at 100 Hz) | 16.7 / 17.6 / 18.5 ms, 0 dropped, 100 Hz | 16.7 / 17.6 / 18.3 ms, 0 dropped, 100 Hz | 16.7 / 33.3 / 34.2 ms, 26 dropped, 54 Hz | 33.3 / 34.4 / 50.0 ms, 136 dropped, 33 Hz | 16.7 / 17.7 / 18.4 ms, 0 dropped, 100 Hz |
| ingest-large-100hz (1 series, 100,000-point window, +10 points at 100 Hz) | 16.7 / 17.7 / 18.6 ms, 1 dropped, 60 Hz | 16.7 / 17.6 / 18.5 ms, 0 dropped, 100 Hz | 33.3 / 34.2 / 34.8 ms, 129.5 dropped, 34 Hz | 50.1 / 67.6 / 83.3 ms, 211 dropped, 18 Hz | 16.7 / 17.9 / 18.5 ms, 0 dropped, 100 Hz |
| ingest-dashboard-10hz (10 charts x 15 series x 3,000 points, +1 point per series at 10 Hz) | 17.5 / 84.2 / 101 ms, 175.5 dropped, 10 Hz | 16.7 / 17.6 / 18.3 ms, 1.5 dropped, 10 Hz | 167 / 183 / 184 ms, 269 dropped, 6 Hz | 300 / 344 / 358 ms, 278.5 dropped, 3 Hz | 16.7 / 17.7 / 18.4 ms, 0 dropped, 10 Hz |
<!-- /results:ingest -->

## Interaction

Real pointer moves (Chrome DevTools Protocol input) aimed at data points, to
the end of the next frame, with tooltips enabled. Moves are spaced 70 ms apart
so throttled hover handlers run for each event.

<!-- results:interaction -->
| Scenario (ms, median ± MAD) | echarts | chartjs | plotly | tanstack | uplot |
| --- | ---: | ---: | ---: | ---: | ---: |
| hover-line-medium (pointer moves over 10 x 5,000 points) | 7.75 ± 4.28 | 1.09 ± 0.61 | 7.91 ± 3.70 | 9.11 ± 5.24 | 0.52 ± 0.27 |
| hover-line-large (pointer moves over 1,000,000 points) | 0.91 ± 0.14 | 0.48 ± 0.14 | 440 ± 177 | 92.4 ± 1.89 | 0.26 ± 0.04 |
| hover-scatter-medium (pointer moves over 10,000 points) | 7.89 ± 2.93 | 1.87 ± 0.63 | 4.97 ± 2.39 | 3.45 ± 0.90 | n/a |

| Scenario (ms, median ± MAD) | echarts | chartjs | plotly | tanstack | uplot |
| --- | ---: | ---: | ---: | ---: | ---: |
| resize-line-medium (resize 800x400 <-> 600x300) | 3.57 ± 0.33 | 3.98 ± 0.35 | 10.6 ± 0.96 | 35.7 ± 1.74 | 1.43 ± 0.26 |
<!-- /results:interaction -->

## Dashboard

Ten 600x250 line charts, each with 15 series of 3,000 points (450,000 points).
"Refresh" replaces the data of all ten charts in one task.

<!-- results:dashboard -->
| Mount all charts (ms, median ± MAD) | echarts | chartjs | plotly | tanstack | uplot |
| --- | ---: | ---: | ---: | ---: | ---: |
| dashboard (10 charts x 15 series x 3,000 points) | 90.4 ± 2.14 | 48.6 ± 2.39 | 186 ± 6.64 | 315 ± 9.49 | 17.3 ± 0.89 |

| Refresh all charts (ms, median ± MAD) | echarts | chartjs | plotly | tanstack | uplot |
| --- | ---: | ---: | ---: | ---: | ---: |
| dashboard (10 charts x 15 series x 3,000 points) | 109 ± 4.82 | 34.7 ± 2.34 | 177 ± 3.06 | 317 ± 12.8 | 11.2 ± 0.86 |
<!-- /results:dashboard -->

## Memory

Retained heap is the increase in V8 heap, Blink heap, and ArrayBuffer backing
stores after mounting, measured after forced garbage collection. Canvas bytes
are estimated from canvas dimensions (width x height x 4) and are not part of
the heap number. Source data is created before the baseline and is not
included.

<!-- results:memory -->
| Scenario | echarts | chartjs | plotly | tanstack | uplot |
| --- | ---: | ---: | ---: | ---: | ---: |
| memory-line-large (1 chart, 1,000,000 points; source 16 MB) | 243 MB heap, 5.1 MB canvas, 4 nodes | 49 MB heap, 5.1 MB canvas, 3 nodes | 111 MB heap, 15 MB canvas, 135 nodes | 600 MB heap, 26 MB canvas, 8 nodes | 0.2 MB heap, 5.1 MB canvas, 24 nodes |
| memory-dashboard (10 charts x 15 series x 3,000 points; source 3.9 MB) | 115 MB heap, 24 MB canvas, 40 nodes | 57 MB heap, 24 MB canvas, 30 nodes | 48 MB heap, 0.0 MB canvas, 2257 nodes | 273 MB heap, 0.0 MB canvas, 814 nodes | 2.8 MB heap, 24 MB canvas, 1080 nodes |
| memory-small-100 (100 charts x 2 series x 100 points; source 0.3 MB) | 24 MB heap, 72 MB canvas, 400 nodes | 31 MB heap, 72 MB canvas, 300 nodes | 28 MB heap, 0.0 MB canvas, 13061 nodes | 21 MB heap, 0.0 MB canvas, 2274 nodes | 11 MB heap, 72 MB canvas, 3000 nodes |
<!-- /results:memory -->

## Findings so far

- uPlot sets the bar for time-series speed and memory: it renders typed arrays
  in place, so retained memory for 1M points is a fraction of a megabyte, and
  it keeps up with every paced ingestion scenario.
- Libraries that need one object per point (TanStack Charts rows, Chart.js
  `{x, y}`, ECharts pairs) retain 3–40x the source data size at 1M points.
- For many small charts, Canvas backing stores dominate: 100 300x150 charts at
  DPR 2 need ~72 MB of canvas pixels, more than the JavaScript heap of any
  library. The SVG libraries have no backing stores but create thousands of DOM
  nodes.
- Rebuilding on every update limits streaming: TanStack Charts (new
  definition per update) and Plotly (`extendTraces`) cannot sustain 60 Hz
  ingestion on a 15-series chart, and fall to a few frames per second on a
  ten-chart dashboard at 10 Hz.
- Progressive rendering keeps ECharts responsive for large scatter and heatmap
  series, but the complete picture can take seconds.
- Plotly's WebGL hover over 1M points takes hundreds of milliseconds per move;
  its SVG scatter is slower to mount at 10k points than its WebGL scatter is at
  200k.
