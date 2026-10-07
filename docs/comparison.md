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

Herceg renders line, area, bar, point (scatter), heatmap, and rule marks.
uPlot has no bar, scatter, or heatmap support comparable to the scenarios, and
Chart.js has no built-in heatmap; those cells are marked n/a.

## Summary

| Area | Herceg | ECharts | TanStack Charts | Chart.js | Plotly |
| --- | --- | --- | --- | --- | --- |
| Initial render | Measured. Fast at every size measured: ~0.6 ms for 4 x 200 line points, ~1.6 ms for 10 x 5,000, ~4.7 ms for 1M points (uPlot: ~6.6 ms), ~38 ms for 10M points (uPlot: ~44 ms). Bars ~0.7 ms for 100 x 4; scatter ~1.8 ms for 10k points and ~27 ms for 200k (every point drawn on Canvas); heatmaps ~1.1 ms for 100 x 100 and ~11 ms for 500 x 500 cells, drawn as one image. Lines are reduced to at most four points per pixel column; SVG below 4,000 drawn points or cells, Canvas above. | Measured. Canvas; fast for small charts, ~150 ms for a 1M-point line with `minmax` sampling. Scatter and heatmap series render progressively: a 500x500 heatmap shows its first frame after ~60 ms and completes after ~9 s. | Measured. Fast small SVG charts; cost grows with rows because every row becomes a scene node (~0.8 s for 1M points on Canvas). | Measured. Fast for small and medium charts; min-max decimation makes 1M points cheap once the `{x, y}` objects exist. | Measured. Slowest small charts; SVG scatter is expensive at 10k points, WebGL traces handle large data. |
| Incremental update | Measured. Tables support append, drop, range replace, and reset; charts re-render once on the next frame. Replacing 10 x 5,000 line points takes ~1.0 ms, 1M points ~3.2 ms (uPlot ~5.4 ms), 10k scatter points ~1.7 ms, 100 x 100 heatmap cells ~0.7 ms. | Measured. `setOption` re-processes the series; no rolling-window append. | Measured. Updates rebuild the definition and scene. | Measured. Mutate arrays and `update('none')`; cheap. | Measured. `extendTraces` with `maxPoints` gives a documented rolling window, but each tick costs 20–30 ms here. |
| Streaming | Measured. ~0.9 ms per tick for 15 series x 3,000 points (uPlot: ~0.9 ms); keeps up in every paced scenario, including the ten-chart dashboard at 10 Hz. Rolling windows via `maxRows`. | Measured. ~11 ms per tick for 15 series x 3,000 points; keeps up with 100 Hz ingestion for one chart but drops frames for a 10-chart dashboard at 10 Hz. | Measured. ~31 ms per tick; at 60–100 Hz ingestion only ~33 updates per second get through. | Measured. ~3.5 ms per tick; keeps up in every paced scenario. | Measured. ~20 ms per tick; ~54 updates per second at 100 Hz, ~6 Hz for the 10-chart dashboard. |
| Memory | Measured. ~0.2 MB retained for 1M points: source typed arrays are used in place and geometry buffers are bounded. Ten-chart dashboard ~7 MB (uPlot ~3 MB); 100 small charts ~8 MB and no canvas backing stores, because small charts render to SVG. | Measured. ~240 MB retained for 1M points (internal storage plus per-point structures). | Measured. ~600 MB retained for 1M points (row objects, Dates, scene nodes). | Measured. ~49 MB for 1M points (one `{x, y}` object per point). | Measured. ~110 MB for 1M points with WebGL. |
| Bundle size (line chart, gzip) | Measured. ~21 KiB for a time-series line chart with tooltip. The renderers and chart model include bar, point, and heatmap support that a line-only bundle cannot drop yet (~3 KiB). | Measured. ~167 KiB tree-shaken, ~371 KiB full. | Measured. ~44 KiB including `d3-scale` for time. | Measured. ~64 KiB with time scale and date adapter. | Measured. ~391 KiB basic bundle, ~1.4 MiB full. |
| Line | Line, step lines, several y fields or a long-format series field, gaps for missing values, log and time axes, level of detail for large series. Area (stacked, band) and rule marks. | Documented. Time axes, sampling, area fill, step lines. | Documented. `lineY`/`lineX`, gaps, curves. | Documented. Line, stepped, filled; decimation plugin. | Documented. `scatter`/`scattergl` lines, rich hover. |
| Scatter | Point mark with per-series color, radius, and opacity. Every point is drawn on Canvas: ~110 ms for 1M points, ahead of Plotly's WebGL (~180 ms) but with no GPU path yet; optional pixel sampling for dense opaque points. Nearest-point hover through a spatial grid index (~0.5 ms per move at 10k points). No size or color encoding by field yet. | Documented. `large` mode for big scatter. | Documented. `dot` mark; one scene node per point. | Documented. Scatter/bubble. | Documented. SVG and WebGL scatter. |
| Heatmap | Heatmap mark over category, number, or time fields, drawn as one image (Canvas `drawImage`, PNG inside SVG), with a color legend and cell tooltips. Up to 4,194,304 cells; no binning transform or calendar layout. | Documented. Heatmap series, calendar heatmap. | Documented. `cell` mark with a D3 color scale. | No built-in heatmap (third-party `chartjs-chart-matrix`). | Documented. Heatmap traces rendered as an image. |
| Composition | Line, area, bar, point, heatmap, and rule marks share scales, axes, tooltip, and legend in one chart. No custom marks, horizontal bars, annotations beyond rules, or multiple axes yet. | Documented. Many series types in one grid, `markLine`/`markArea`, `custom` series. | Documented. Grammar of marks; strongest composition model of the group. | Documented. Mixed chart types; annotations via plugin. | Documented. Traces, layout shapes and annotations, subplots. |
| TypeScript | Field options are typed from the table schema: a categorical field passed as a numeric encoding is a compile error. Compile-time tests guard this. | Documented. Large option types; tree-shaken `ComposeOption` types. | Documented. Fields and callbacks inferred from row types. | Documented. Typed configuration generics. | Community `@types/plotly.js`, not first-party. |
| React | First-party `@herceg/react`: `<Chart>` with mark elements typed against the table's schema; no React element per data point, and data updates go through tables without rendering React. Measured: mounting adds up to ~0.3 ms per chart (often within noise), streaming and hover are within noise of plain herceg, each chart's React root retains ~25 KB, and the adapter adds ~0.6 KiB gzip. | Community wrappers (for example `echarts-for-react`). | First-party adapters for React and other frameworks. | Community `react-chartjs-2`. | `react-plotly.js`. |
| Python | Not implemented. | Community `pyecharts`. | None. | None. | First-class Plotly Python and Plotly Express. |
| Accessibility | Focusable figure with a generated data summary, arrow-key navigation announced through a live region, legend entries as toggle buttons, `title`/`desc` in static SVG. Not yet tested with screen readers. | Documented. `aria` option generates descriptions; decal patterns. | Documented. Required accessible name, keyboard focus navigation. | Canvas only; the application supplies fallback content. | Limited; no keyboard navigation of data. |
| Export | Standalone SVG in the browser (`toSVG`) and without a DOM (`renderToSVG`, heatmaps embedded as PNG). No PNG or PDF export of whole charts yet. | Documented. PNG/SVG from the browser, server-side SVG strings. | Documented. Static SVG, SSR, browser raster export. | PNG via `toBase64Image`. | Documented. PNG/SVG/JPEG/WebP; Kaleido for Python. |
| Ease of use | One table plus mark functions with typed fields. Far fewer chart types and options than the other libraries so far. | Large declarative option object; many examples. | Typed grammar; scales and D3 modules are explicit imports. | Simple for standard charts; plugins for the rest. | Very quick for common charts, especially Plotly Express. |

## Environment

<!-- results:environment -->
- Date: 2026-10-07, commit e554b06 (uncommitted changes)
- Machine: Apple M6, 12 cores, 32 GB, Darwin 27.0.0
- Browser: Chrome 154.0.8037.99, GPU ANGLE (Apple, ANGLE Metal Renderer: Apple M6, Unspecified Version), headed
- Viewport 1280x1400, device pixel ratio 2
- Libraries: herceg 0.0.0 (e554b06), echarts 6.1.0, chartjs 4.5.1, plotly 4.1.2, tanstack 1.0.0, uplot 1.6.32
- Renderers (normal / large config): herceg: auto (svg below 4,000 drawn points, canvas above) / auto; echarts: canvas / canvas (sampling: minmax, large: true); chartjs: canvas / canvas (parsing: false, min-max decimation); plotly: svg / webgl (scattergl); tanstack: svg / canvas (mountCanvasChart); uplot: canvas / canvas
<!-- /results:environment -->

## Bundle size

Each entry renders the same time-series line chart with a tooltip and is
bundled for production with tree shaking (`benchmarks/src/size/entries/`).
`herceg-react-line` renders it through `@herceg/react` and leaves React and
React DOM out, since an application using the adapter already ships them.

<!-- results:size -->
| Entry | Version | Minified KiB | Gzip KiB | Brotli KiB | Required CSS, gzip KiB |
| --- | ---: | ---: | ---: | ---: | ---: |
| chartjs-auto | 4.5.1 | 246.8 | 79.9 | 69.3 | - |
| chartjs-line | 4.5.1 | 196.4 | 63.7 | 56.0 | - |
| echarts-full | 6.1.0 | 1107.9 | 370.5 | 302.3 | - |
| echarts-line | 6.1.0 | 490.7 | 166.8 | 142.7 | - |
| herceg-line | 0.0.0 (52eeb9a) | 60.9 | 21.9 | 19.8 | - |
| herceg-react-line | 0.0.0 (52eeb9a) | 62.5 | 22.6 | 20.4 | - |
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
| Scenario (ms, median ± MAD) | herceg | echarts | chartjs | plotly | tanstack | uplot |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| line-small-init (4 series x 200 points) | 0.56 ± 0.10 | 1.46 ± 0.21 | 1.59 ± 0.21 | 3.14 ± 0.28 | 1.20 ± 0.17 | 0.59 ± 0.12 |
| line-medium-init (10 series x 5,000 points) | 1.56 ± 0.16 | 12.4 ± 1.37 | 6.88 ± 1.20 | 22.3 ± 1.97 | 38.2 ± 3.13 | 2.23 ± 0.15 |
| line-large-init (1 series x 1,000,000 points) | 4.66 ± 0.06 | 151 ± 9.76 | 15.7 ± 0.42 | 320 ± 7.19 | 749 ± 73.5 | 6.61 ± 0.69 |
| area-medium-init (3 filled series x 5,000 points) | 1.01 ± 0.16 | 5.57 ± 0.39 | 3.12 ± 0.43 | 10.3 ± 0.53 | 16.2 ± 1.28 | 1.13 ± 0.07 |
| bar-small-init (12 categories x 3 series) | 0.47 ± 0.10 | 1.41 ± 0.30 | 0.82 ± 0.17 | 2.62 ± 0.35 | 0.68 ± 0.12 | n/a |
| bar-medium-init (100 categories x 4 series) | 0.79 ± 0.16 | 3.00 ± 0.41 | 2.15 ± 0.37 | 7.60 ± 0.19 | 3.00 ± 0.23 | n/a |
| scatter-medium-init (10,000 points) | 1.95 ± 0.21 | 80.0 ± 1.75 (first frame 4.87) | 4.38 ± 0.27 | 74.8 ± 1.68 | 28.3 ± 2.77 | n/a |
| scatter-large-init (200,000 points) | 27.0 ± 1.06 | 60.3 ± 8.00 (first frame 40.1) | 73.4 ± 6.43 | 50.5 ± 8.22 | 236 ± 8.91 | n/a |
| heatmap-medium-init (100 x 100 cells) | 1.15 ± 0.08 | 32.1 ± 2.96 (first frame 5.14) | n/a | 3.29 ± 0.48 | 37.2 ± 2.06 | n/a |
| heatmap-large-init (500 x 500 cells) | 11.1 ± 0.37 | 9402 ± 356 (first frame 62.2) | n/a | 28.0 ± 4.00 | 455 ± 30.0 | n/a |
| line-massive-init (1 series x 10,000,000 points) | 37.6 ± 1.12 | 1632 ± 163 | 241 ± 11.8 | 2771 ± 26.7 | error | 44.3 ± 0.99 |
| scatter-massive-init (1,000,000 points) | 110 ± 1.07 | 300 ± 17.3 (first frame 172) | 429 ± 0.78 | 181 ± 3.99 | 1300 ± 153 | n/a |
<!-- /results:init -->

## Full data replacement

<!-- results:update -->
| Scenario (ms, median ± MAD) | herceg | echarts | chartjs | plotly | tanstack | uplot |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| line-medium-update (replace 10 x 5,000 points) | 1.06 ± 0.09 | 12.1 ± 0.90 | 4.27 ± 0.30 | 19.5 ± 0.61 | 36.3 ± 1.35 | 1.16 ± 0.31 |
| line-large-update (replace 1,000,000 points) | 3.17 ± 0.03 | 183 ± 10.6 | 13.4 ± 1.75 | 279 ± 3.77 | 723 ± 47.2 | 5.43 ± 0.00 |
| bar-medium-update (replace 100 x 4 bars) | 0.41 ± 0.09 | 2.19 ± 0.24 | 1.60 ± 0.25 | 5.88 ± 0.72 | 3.01 ± 0.28 | n/a |
| scatter-medium-update (replace 10,000 points) | 1.66 ± 0.13 | 95.5 ± 2.06 (first frame 19.7) | 4.03 ± 0.60 | 66.3 ± 3.25 | 43.2 ± 2.09 | n/a |
| heatmap-medium-update (replace 100 x 100 cells) | 0.66 ± 0.08 | 47.3 ± 1.58 (first frame 19.5) | n/a | 3.59 ± 0.31 | 46.7 ± 1.69 | n/a |
<!-- /results:update -->

## Streaming

One tick appends points to every series, drops the oldest points to keep the
window size, and waits for the next frame. Each library uses its documented
live-data path: `setOption` (ECharts), array mutation plus `update('none')`
(Chart.js), `extendTraces` with `maxPoints` (Plotly), a new definition
(TanStack Charts), and `setData` (uPlot).

<!-- results:stream -->
| Scenario (ms, median ± MAD) | herceg | echarts | chartjs | plotly | tanstack | uplot |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| stream-dashboard-chart (15 series, 3,000-point window, +1 point per tick) | 0.91 ± 0.08 | 10.6 ± 0.60 | 3.31 ± 0.31 | 19.5 ± 0.71 | 30.7 ± 1.12 | 0.89 ± 0.09 |
| stream-large (1 series, 100,000-point window, +100 points per tick) | 0.77 ± 0.09 | 18.1 ± 1.55 | 3.03 ± 0.25 | 29.6 ± 0.66 | 57.0 ± 3.40 | 0.91 ± 0.06 |
<!-- /results:stream -->

### Paced ingestion

A timer appends data at a fixed rate for five seconds while the display runs
at its normal refresh rate; each library decides when to render. A frame
interval spanning k refresh periods counts as k - 1 dropped frames. When a
library blocks the main thread, the timer fires less often and the achieved
ingestion rate drops below the target.

<!-- results:ingest -->
| Scenario (frame interval p50 / p95 / p99, dropped frames, achieved ingest rate) | herceg | echarts | chartjs | plotly | tanstack | uplot |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| ingest-chart-10hz (15 series, 3,000-point window, +1 point at 10 Hz) | 16.7 / 18.0 / 18.5 ms, 0 dropped, 10 Hz | 16.7 / 17.8 / 18.4 ms, 0 dropped, 10 Hz | 16.7 / 17.9 / 18.4 ms, 0 dropped, 10 Hz | 16.7 / 17.6 / 18.3 ms, 0 dropped, 10 Hz | 16.7 / 17.6 / 18.2 ms, 2 dropped, 10 Hz | 16.7 / 17.8 / 18.5 ms, 0 dropped, 10 Hz |
| ingest-chart-60hz (15 series, 3,000-point window, +1 point at 60 Hz) | 16.7 / 17.8 / 18.5 ms, 0 dropped, 62 Hz | 16.7 / 17.6 / 18.1 ms, 0 dropped, 62 Hz | 16.7 / 17.6 / 17.8 ms, 0 dropped, 62 Hz | 16.7 / 33.3 / 34.2 ms, 28.5 dropped, 54 Hz | 33.3 / 34.2 / 35.0 ms, 132.5 dropped, 33 Hz | 16.7 / 17.7 / 18.4 ms, 0 dropped, 62 Hz |
| ingest-chart-100hz (15 series, 3,000-point window, +1 point at 100 Hz) | 16.7 / 17.8 / 18.5 ms, 0 dropped, 100 Hz | 16.7 / 17.6 / 18.1 ms, 0 dropped, 100 Hz | 16.7 / 17.6 / 17.8 ms, 0 dropped, 100 Hz | 16.7 / 33.3 / 34.2 ms, 25.5 dropped, 55 Hz | 33.3 / 34.2 / 49.7 ms, 133.5 dropped, 33 Hz | 16.7 / 18.1 / 18.5 ms, 0 dropped, 100 Hz |
| ingest-large-100hz (1 series, 100,000-point window, +10 points at 100 Hz) | 16.7 / 17.8 / 18.5 ms, 0 dropped, 100 Hz | 16.7 / 17.6 / 18.5 ms, 1 dropped, 60 Hz | 16.7 / 17.6 / 18.5 ms, 0 dropped, 100 Hz | 33.3 / 34.2 / 34.8 ms, 128.5 dropped, 34 Hz | 50.0 / 67.6 / 83.3 ms, 210.5 dropped, 18 Hz | 16.7 / 17.9 / 18.5 ms, 0 dropped, 100 Hz |
| ingest-dashboard-10hz (10 charts x 15 series x 3,000 points, +1 point per series at 10 Hz) | 16.7 / 17.8 / 18.4 ms, 0 dropped, 10 Hz | 17.5 / 99.1 / 101 ms, 177.5 dropped, 10 Hz | 16.7 / 17.6 / 17.8 ms, 2 dropped, 10 Hz | 167 / 183 / 184 ms, 269.5 dropped, 6 Hz | 299 / 334 / 350 ms, 287 dropped, 3 Hz | 16.7 / 17.7 / 18.4 ms, 0 dropped, 10 Hz |
<!-- /results:ingest -->

## Interaction

Real pointer moves (Chrome DevTools Protocol input) aimed at data points, to
the end of the next frame, with tooltips enabled. Moves are spaced 70 ms apart
so throttled hover handlers run for each event. Zoom scenarios change the x
range through each library's documented zoom path (see
`benchmarks/README.md`); Plotly keeps its full-data y range while zooming,
the others rescale y to the visible points. "error" means the library's tab
crashed (out of memory) or the scenario timed out.

<!-- results:interaction -->
| Scenario (ms, median ± MAD) | herceg | echarts | chartjs | plotly | tanstack | uplot |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| hover-line-medium (pointer moves over 10 x 5,000 points) | 0.64 ± 0.31 | 7.31 ± 4.46 | 1.03 ± 0.48 | 8.33 ± 3.48 | 10.5 ± 6.39 | 0.51 ± 0.27 |
| hover-line-large (pointer moves over 1,000,000 points) | 0.37 ± 0.04 | 0.84 ± 0.27 | 0.49 ± 0.11 | 439 ± 183 | 92.6 ± 2.11 | 0.25 ± 0.03 |
| hover-scatter-medium (pointer moves over 10,000 points) | 0.42 ± 0.24 | 6.20 ± 2.61 | 1.86 ± 0.65 | 14.1 ± 3.10 | 3.73 ± 1.53 | n/a |

| Scenario (ms, median ± MAD) | herceg | echarts | chartjs | plotly | tanstack | uplot |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| zoom-line-large (x ranges of 50%, 10%, and 1% of 1,000,000 points, panning) | 0.68 ± 0.28 | 6.26 ± 0.55 | 2.06 ± 0.53 | 0.85 ± 0.13 | 57.5 ± 51.2 | 1.02 ± 0.71 |
| zoom-line-massive (x ranges of 50%, 10%, and 1% of 10,000,000 points, panning) | 2.97 ± 2.06 | 54.6 ± 2.51 | 6.29 ± 4.61 | 0.85 ± 0.15 | error | 5.80 ± 4.79 |

| Scenario (ms, median ± MAD) | herceg | echarts | chartjs | plotly | tanstack | uplot |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| resize-line-medium (resize 800x400 <-> 600x300) | 1.23 ± 0.15 | 3.40 ± 0.34 | 3.95 ± 0.34 | 10.3 ± 1.29 | 33.8 ± 1.14 | 1.51 ± 0.25 |
<!-- /results:interaction -->

## Dashboard

Ten 600x250 line charts, each with 15 series of 3,000 points (450,000 points).
"Refresh" replaces the data of all ten charts in one task.

<!-- results:dashboard -->
| Mount all charts (ms, median ± MAD) | herceg | echarts | chartjs | plotly | tanstack | uplot |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| dashboard (10 charts x 15 series x 3,000 points) | 16.0 ± 1.01 | 94.2 ± 3.25 | 48.3 ± 0.85 | 187 ± 14.0 | 315 ± 6.65 | 16.0 ± 1.14 |

| Refresh all charts (ms, median ± MAD) | herceg | echarts | chartjs | plotly | tanstack | uplot |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| dashboard (10 charts x 15 series x 3,000 points) | 9.29 ± 0.38 | 110 ± 1.45 | 37.0 ± 2.92 | 182 ± 1.39 | 323 ± 16.4 | 10.4 ± 0.95 |
<!-- /results:dashboard -->

## Memory

Retained heap is the increase in V8 heap, Blink heap, and ArrayBuffer backing
stores after mounting, measured after forced garbage collection. Canvas bytes
are estimated from canvas dimensions (width x height x 4) and are not part of
the heap number. Source data is created before the baseline and is not
included.

<!-- results:memory -->
| Scenario | herceg | echarts | chartjs | plotly | tanstack | uplot |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| memory-line-large (1 chart, 1,000,000 points; source 16 MB) | 0.2 MB heap, 5.1 MB canvas, 34 nodes | 243 MB heap, 5.1 MB canvas, 4 nodes | 49 MB heap, 5.1 MB canvas, 3 nodes | 111 MB heap, 15 MB canvas, 135 nodes | 600 MB heap, 26 MB canvas, 8 nodes | 0.2 MB heap, 5.1 MB canvas, 24 nodes |
| memory-dashboard (10 charts x 15 series x 3,000 points; source 3.9 MB) | 7.2 MB heap, 24 MB canvas, 752 nodes | 115 MB heap, 24 MB canvas, 40 nodes | 57 MB heap, 24 MB canvas, 30 nodes | 48 MB heap, 0.0 MB canvas, 2257 nodes | 273 MB heap, 0.0 MB canvas, 814 nodes | 2.8 MB heap, 24 MB canvas, 1080 nodes |
| memory-small-100 (100 charts x 2 series x 100 points; source 0.3 MB) | 8.5 MB heap, 0.0 MB canvas, 3437 nodes | 24 MB heap, 72 MB canvas, 400 nodes | 31 MB heap, 72 MB canvas, 300 nodes | 28 MB heap, 0.0 MB canvas, 13061 nodes | 21 MB heap, 0.0 MB canvas, 2274 nodes | 11 MB heap, 72 MB canvas, 3000 nodes |
<!-- /results:memory -->

## React integration

Herceg through `@herceg/react` next to plain herceg, from `npm run bench:react`.
Mounting and resizing go through React props; data replacement and streaming
change the table and bypass React. Each chart is its own React root, so
per-root setup is counted for every chart. The React wrappers of the other
libraries are not measured.

<!-- results:react -->
Measured 2026-10-07 at commit e554b06 (uncommitted changes) with react 19.3.0, react-dom 19.3.0, same environment as above.

| Scenario (median) | herceg | herceg via @herceg/react |
| --- | ---: | ---: |
| line-small-init (4 series x 200 points) | 0.58 ± 0.14 ms | 0.54 ± 0.12 ms |
| line-medium-init (10 series x 5,000 points) | 1.53 ± 0.06 ms | 1.81 ± 0.16 ms |
| line-large-init (1 series x 1,000,000 points) | 4.69 ± 0.22 ms | 4.68 ± 0.18 ms |
| area-medium-init (3 filled series x 5,000 points) | 1.11 ± 0.04 ms | 1.38 ± 0.12 ms |
| line-massive-init (1 series x 10,000,000 points) | 31.8 ± 0.64 ms | 30.0 ± 1.17 ms |
| line-medium-update (replace 10 x 5,000 points) | 1.06 ± 0.16 ms | 0.94 ± 0.07 ms |
| line-large-update (replace 1,000,000 points) | 3.56 ± 0.08 ms | 3.36 ± 0.14 ms |
| stream-dashboard-chart (15 series, 3,000-point window, +1 point per tick) | 1.05 ± 0.12 ms | 0.91 ± 0.10 ms |
| stream-large (1 series, 100,000-point window, +100 points per tick) | 0.68 ± 0.08 ms | 0.67 ± 0.08 ms |
| ingest-chart-10hz (15 series, 3,000-point window, +1 point at 10 Hz) | 0 dropped, 10 Hz | 0 dropped, 10 Hz |
| ingest-chart-60hz (15 series, 3,000-point window, +1 point at 60 Hz) | 0 dropped, 62 Hz | 0 dropped, 62 Hz |
| ingest-chart-100hz (15 series, 3,000-point window, +1 point at 100 Hz) | 0 dropped, 100 Hz | 0 dropped, 100 Hz |
| ingest-large-100hz (1 series, 100,000-point window, +10 points at 100 Hz) | 0 dropped, 100 Hz | 0 dropped, 100 Hz |
| ingest-dashboard-10hz (10 charts x 15 series x 3,000 points, +1 point per series at 10 Hz) | 0 dropped, 10 Hz | 0.5 dropped, 10 Hz |
| hover-line-medium (pointer moves over 10 x 5,000 points) | 0.72 ± 0.33 ms | 0.71 ± 0.39 ms |
| hover-line-large (pointer moves over 1,000,000 points) | 0.36 ± 0.05 ms | 0.35 ± 0.07 ms |
| zoom-line-large (x ranges of 50%, 10%, and 1% of 1,000,000 points, panning) | 0.72 ± 0.35 ms | 0.76 ± 0.34 ms |
| zoom-line-massive (x ranges of 50%, 10%, and 1% of 10,000,000 points, panning) | 2.75 ± 1.99 ms | 2.79 ± 2.02 ms |
| resize-line-medium (resize 800x400 <-> 600x300) | 1.16 ± 0.12 ms | 0.97 ± 0.10 ms |
| dashboard (10 charts x 15 series x 3,000 points) | mount 16.4 ms, refresh 9.14 ms | mount 17.1 ms, refresh 8.94 ms |
| memory-line-large (1 chart, 1,000,000 points) | 0.2 MB heap, 34 nodes | 0.3 MB heap, 35 nodes |
| memory-dashboard (10 charts x 15 series x 3,000 points) | 7.2 MB heap, 752 nodes | 7.4 MB heap, 762 nodes |
| memory-small-100 (100 charts x 2 series x 100 points) | 8.5 MB heap, 3437 nodes | 11 MB heap, 3537 nodes |
<!-- /results:react -->

## Findings so far

- uPlot sets the bar for time-series speed and memory: it renders typed arrays
  in place, so retained memory for 1M points is a fraction of a megabyte, and
  it keeps up with every paced ingestion scenario. Herceg matches its memory
  for large series and its pacing under streaming, mounts and replaces line
  charts faster (1M points: ~4.7 ms vs ~6.6 ms to mount, ~3.2 ms vs
  ~5.4 ms to replace), and is even per streaming tick (~0.9 ms each). uPlot
  is still ahead on hover (~0.5 ms vs ~0.6 ms over
  10 x 5,000 points) and on dashboard memory (~3 MB vs ~7 MB for ten charts).
- Scatter from typed columns: Herceg draws all 200,000 points on Canvas in
  ~28 ms. ECharts completes its progressive render in ~60 ms (first frame
  ~40 ms), Plotly's WebGL `scattergl` takes ~50 ms, and Chart.js ~71 ms. At
  10,000 points the libraries that render in one pass (Herceg ~1.8 ms,
  Chart.js ~4.4 ms) are far ahead of ECharts and Plotly (~77 ms). At 1M
  points Herceg's Canvas takes ~110 ms, Plotly ~180 ms, ECharts ~300 ms,
  Chart.js ~430 ms, and TanStack Charts ~1.3 s; Canvas cost grows with every
  point, which is where GPU rendering is expected to matter.
- Heatmaps drawn as one image scale with cell count at a few bytes per cell:
  500 x 500 cells take ~12 ms in Herceg and ~30 ms in Plotly, against ~450 ms
  for TanStack Charts (one scene node per cell) and ~9 s for ECharts to
  complete its progressive render.
- Massive data separates the libraries that keep data in typed arrays.
  Mounting a 10M-point line takes ~38 ms in Herceg and ~44 ms in uPlot,
  ~240 ms in Chart.js, and 1.6–2.8 s in ECharts and Plotly; TanStack Charts
  runs out of memory (its tab crashes). Zooming into 10M points takes
  ~0.85 ms in Plotly, whose WebGL traces keep data on the GPU and do not
  rescale y, ~3 ms in Herceg, ~6 ms in Chart.js and uPlot, and ~55 ms in
  ECharts.
- Bars at these sizes (up to 400 bars) take 0.5–7 ms in every library;
  differences are not noticeable to users.
- Going through `@herceg/react` costs little because React only describes
  the chart: mounting adds up to ~0.3 ms per chart, and streaming, data
  replacement, and hover never render React. The other measurable cost is
  memory for React roots: 100 small charts, each its own root, retain ~11 MB
  instead of ~8.5 MB.
- Small charts rendered as SVG avoid canvas backing stores entirely: Herceg's
  100 small charts use ~8 MB of heap and no canvas memory, while the Canvas
  libraries need ~72 MB of canvas pixels for the same charts.
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
