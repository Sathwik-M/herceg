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

Herceg renders line, area, bar, point (scatter), heatmap, error bar,
candlestick, and histogram marks, rule, region, and text annotations, and custom marks.
uPlot has no bar, scatter, or heatmap support comparable to the scenarios, and
Chart.js has no built-in heatmap; those cells are marked n/a.

## Summary

| Area | Herceg | ECharts | TanStack Charts | Chart.js | Plotly |
| --- | --- | --- | --- | --- | --- |
| Initial render | Measured. Fast at every size measured: ~0.7 ms for 4 x 200 line points, ~1.6 ms for 10 x 5,000, ~4.8 ms for 1M points (uPlot: ~7.0 ms), ~35 ms for 10M points (uPlot: ~46 ms). Bars ~0.7 ms for 100 x 4; scatter ~2.1 ms for 10k points on Canvas, ~3.3 ms for 200k and ~13 ms for 1M with WebGL; heatmaps ~1.3 ms for 100 x 100 and ~13 ms for 500 x 500 cells, drawn as one image. Lines are reduced to at most four points per pixel column; SVG below 4,000 drawn points or cells, Canvas above. | Measured. Canvas; fast for small charts, ~150 ms for a 1M-point line with `minmax` sampling. Scatter and heatmap series render progressively: a 500x500 heatmap shows its first frame after ~60 ms and completes after ~9 s. | Measured. Fast small SVG charts; cost grows with rows because every row becomes a scene node (~0.8 s for 1M points on Canvas). | Measured. Fast for small and medium charts; min-max decimation makes 1M points cheap once the `{x, y}` objects exist. | Measured. Slowest small charts; SVG scatter is expensive at 10k points, WebGL traces handle large data. |
| Incremental update | Measured. Tables support append, drop, range replace, and reset; charts re-render once on the next frame. Replacing 10 x 5,000 line points takes ~1.2 ms, 1M points ~3.9 ms (uPlot ~6.2 ms), 10k scatter points ~1.5 ms, 100 x 100 heatmap cells ~0.7 ms. | Measured. `setOption` re-processes the series; no rolling-window append. | Measured. Updates rebuild the definition and scene. | Measured. Mutate arrays and `update('none')`; cheap. | Measured. `extendTraces` with `maxPoints` gives a documented rolling window, but each tick costs 20–30 ms here. |
| Streaming | Measured. ~1.0 ms per tick for 15 series x 3,000 points (uPlot: ~0.9 ms); keeps up in every paced scenario, including the ten-chart dashboard at 10 Hz. A million-point rolling window takes ~1.4 ms per 10,000-point tick (uPlot: ~6.2 ms), because min/max indexes are kept current as rows arrive. Rolling windows via `maxRows`. | Measured. ~11 ms per tick for 15 series x 3,000 points; keeps up with 100 Hz ingestion for one chart but drops frames for a 10-chart dashboard at 10 Hz. | Measured. ~31 ms per tick; at 60–100 Hz ingestion only ~33 updates per second get through. | Measured. ~3.5 ms per tick; keeps up in every paced scenario. | Measured. ~20 ms per tick; ~54 updates per second at 100 Hz, ~6 Hz for the 10-chart dashboard. |
| Memory | Measured. ~0.2 MB retained for 1M points: source typed arrays are used in place and geometry buffers are bounded. Ten-chart dashboard ~7 MB (uPlot ~3 MB); 100 small charts ~8 MB and no canvas backing stores, because small charts render to SVG. | Measured. ~240 MB retained for 1M points (internal storage plus per-point structures). | Measured. ~600 MB retained for 1M points (row objects, Dates, scene nodes). | Measured. ~49 MB for 1M points (one `{x, y}` object per point). | Measured. ~110 MB for 1M points with WebGL. |
| Bundle size (line chart, gzip) | Measured. ~29 KiB for a time-series line chart with tooltip, events, and brushing. Each mark brings its own drawing code, so a line chart carries no bar, point, heatmap, or text drawing, and facets are only bundled when used; the chart model still includes band-axis, color-legend, horizontal-bar inspection, right-axis, and panel-layout logic, and min/max indexes for large lines add ~1 KiB. The WebGL painter for large point series (~2 KiB) loads only when a chart needs it. | Measured. ~167 KiB tree-shaken, ~371 KiB full. | Measured. ~44 KiB including `d3-scale` for time. | Measured. ~64 KiB with time scale and date adapter. | Measured. ~391 KiB basic bundle, ~1.4 MiB full. |
| Line | Line, step lines, several y fields or a long-format series field, gaps for missing values, log and time axes, level of detail for large series. Area (stacked, band) and rule marks. | Documented. Time axes, sampling, area fill, step lines. | Documented. `lineY`/`lineX`, gaps, curves. | Documented. Line, stepped, filled; decimation plugin. | Documented. `scatter`/`scattergl` lines, rich hover. |
| Scatter | Point mark with per-series color, radius, and opacity; every point is drawn. Series of 100,000+ points use WebGL (loaded on demand): ~13 ms to mount 1M points, ~3.6 ms per zoom step, both ahead of Plotly's WebGL. Nearest-point hover through a spatial grid index (~0.5 ms per move at 10k points). No size or color encoding by field yet. | Documented. `large` mode for big scatter. | Documented. `dot` mark; one scene node per point. | Documented. Scatter/bubble. | Documented. SVG and WebGL scatter. |
| Heatmap | Heatmap mark over category, number, or time fields, drawn as one image (Canvas `drawImage`, PNG inside SVG), with a color legend and cell tooltips. Up to 4,194,304 cells; no binning transform or calendar layout. | Documented. Heatmap series, calendar heatmap. | Documented. `cell` mark with a D3 color scale. | No built-in heatmap (third-party `chartjs-chart-matrix`). | Documented. Heatmap traces rendered as an image. |
| Candlestick | Measured. Candlestick mark over number, time, or category x: rising candles hollow, falling ones filled, all four prices in tooltips. ~0.7 ms for 200 candles. With more candles than pixel columns, each column's candles merge into one (the first open, highest high, lowest low, and last close): ~6.8 ms for 100,000, where merged candles show direction by color only. No OHLC bar style or volume pane yet. | Measured. Built-in `candlestick` series: ~2.9 ms for 200 candles; its `large` mode draws high-low lines without bodies, ~57 ms for 100,000. | No built-in candlestick. | No built-in candlestick (third-party `chartjs-chart-financial`, not measured). | Measured. Built-in `candlestick` and `ohlc` traces, drawing every candle: ~4.1 ms for 200, ~650 ms for 100,000. |
| Histogram | Measured. Histogram mark binning a number or time field into round or calendar bins (or a fixed step), overlaid or stacked by series, as counts, percent, or probability density. On the same fixed grid as Plotly: ~0.6 ms for 10,000 values, ~6.7 ms for 1,000,000. Bins are recomputed when the data changes; no cumulative or 2D histograms yet. | No built-in histogram (bin with a dataset transform or by hand). | No built-in histogram. | No built-in histogram. | Measured. `histogram` trace with automatic or fixed bins and many normalizations: ~3.4 ms for 10,000 values, ~63 ms for 1,000,000. |
| Interaction | Wheel zoom, drag pan, x brushing (a selection band, or drag-to-zoom with zoom on), keyboard navigation with Shift-arrow selection, synced cursors and zoom, and `viewport`, `select`, `hover`, and `click` events (also React props). No box or lasso selection, y zoom, or selection shared across charts; brushing is not benchmarked yet. | Documented. `dataZoom` (inside, slider), brush component (rectangle, polygon, x or y ranges), and an event API (`click`, `datazoom`, `brushSelected`, ...). | Not verified here. | Documented. `onClick`/`onHover` callbacks; zoom, pan, and drag-to-zoom through `chartjs-plugin-zoom`. | Documented. Zoom, pan, box and lasso selection, and events (`plotly_click`, `plotly_hover`, `plotly_selected`, `plotly_relayout`). |
| Composition | Line, area, bar, point, heatmap, error bar, and rule marks share scales, axes, tooltip, and legend in one chart; bars are vertical or horizontal. Rule, region, and text annotations from constants or one per table row (deploy markers, incident windows, labels). Custom marks draw shapes with the chart's scales through the same SVG, Canvas, and static renderers (JavaScript only; no tooltips for them yet). Bars can write their values. A second y axis on the right for marks with `axis: "right"`. Small multiples by a category field, wrapped in a grid with shared scales (no row by column facets or independent scales yet). | Documented. Many series types in one grid, `markLine`/`markArea`, `custom` series. | Documented. Grammar of marks; strongest composition model of the group. | Documented. Mixed chart types; annotations via plugin. | Documented. Traces, layout shapes and annotations, subplots. |
| TypeScript | Field options are typed from the table schema: a categorical field passed as a numeric encoding is a compile error. Compile-time tests guard this. | Documented. Large option types; tree-shaken `ComposeOption` types. | Documented. Fields and callbacks inferred from row types. | Documented. Typed configuration generics. | Community `@types/plotly.js`, not first-party. |
| React | First-party `@herceg/react`: `<Chart>` with mark elements typed against the table's schema; no React element per data point, and data updates go through tables without rendering React. Measured: mounting adds up to ~0.3 ms per chart (often within noise), streaming and hover are within noise of plain herceg, each chart's React root retains ~25 KB, and the adapter adds ~0.6 KiB gzip. | Community wrappers (for example `echarts-for-react`). | First-party adapters for React and other frameworks. | Community `react-chartjs-2`. | `react-plotly.js`. |
| Python | First-party `herceg` package: `hg.line(df, x=..., y=...)` one-liners and a chainable `hg.Chart` for pandas, Polars, PyArrow, and NumPy data. Columns travel as binary buffers (no JSON number lists); output to notebooks, self-contained HTML, SVG, and PNG, and live notebook charts (see Notebooks). | Community `pyecharts`. | None. | None. | First-class Plotly Python and Plotly Express. |
| Notebooks | Static display: an isolated iframe with the engine and the data embedded, so it works offline. Live charts (`chart.widget()`, on anywidget): Python appends rows (with a rolling window), replaces data, and changes options without re-sending the chart, as binary buffers over the widget's connection; brushing, zooming, hovering, and clicks come back as properties and callbacks with datetimes on time axes. Tested in JupyterLab 4 only; update latency through the kernel not measured. | Community `pyecharts` renders notebook HTML; no first-party widget. | None. | None. | Documented. `fig.show()` in notebooks and `go.FigureWidget` (anywidget-based since Plotly.py 6), which updates traces from Python and calls Python on click, hover, and selection. |
| Accessibility | Focusable figure with a generated data summary, arrow-key navigation announced through a live region, legend entries as toggle buttons, `title`/`desc` in static SVG. Not yet tested with screen readers. | Documented. `aria` option generates descriptions; decal patterns. | Documented. Required accessible name, keyboard focus navigation. | Canvas only; the application supplies fallback content. | Limited; no keyboard navigation of data. |
| Export | Standalone SVG in the browser (`toSVG`) and without a DOM (`renderToSVG`, heatmaps embedded as PNG); Python saves SVG (same renderer, embedded V8) and PNG (resvg) without a browser. No PDF. | Documented. PNG/SVG from the browser, server-side SVG strings. | Documented. Static SVG, SSR, browser raster export. | PNG via `toBase64Image`. | Documented. PNG/SVG/JPEG/WebP; Kaleido for Python. |
| Ease of use | One table plus mark functions with typed fields. Far fewer chart types and options than the other libraries so far. | Large declarative option object; many examples. | Typed grammar; scales and D3 modules are explicit imports. | Simple for standard charts; plugins for the rest. | Very quick for common charts, especially Plotly Express. |

## Environment

<!-- results:environment -->
- Date: 2026-10-07, commit 61f1019 (uncommitted changes)
- Machine: Apple M6, 12 cores, 32 GB, Darwin 27.0.0
- Browser: Chrome 154.0.8037.99, GPU ANGLE (Apple, ANGLE Metal Renderer: Apple M6, Unspecified Version), headed
- Viewport 1280x1400, device pixel ratio 2
- Libraries: herceg 0.0.0 (61f1019), echarts 6.1.0, chartjs 4.5.1, plotly 4.1.2, tanstack 1.0.0, uplot 1.6.32
- Renderers (normal / large config): herceg: auto (svg below 4,000 drawn points, canvas above) / auto; echarts: canvas / canvas (sampling: minmax, large: true); chartjs: canvas / canvas (parsing: false, min-max decimation); plotly: svg / webgl (scattergl); tanstack: svg / canvas (mountCanvasChart); uplot: canvas / canvas
<!-- /results:environment -->

## Bundle size

Each entry renders the same time-series line chart with a tooltip and is
bundled for production with tree shaking (`benchmarks/src/size/entries/`).
`herceg-react-line` renders it through `@herceg/react` and leaves React and
React DOM out, since an application using the adapter already ships them.

<!-- results:size -->
| Entry | Version | Minified KiB | Gzip KiB | Brotli KiB | Required CSS, gzip KiB | Loaded on demand, gzip KiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| chartjs-auto | 4.5.1 | 246.8 | 79.9 | 69.3 | - | - |
| chartjs-line | 4.5.1 | 196.4 | 63.7 | 56.0 | - | - |
| echarts-full | 6.1.0 | 1107.9 | 370.5 | 302.3 | - | - |
| echarts-line | 6.1.0 | 490.7 | 166.8 | 142.7 | - | - |
| herceg-line | 0.0.0 (61f1019) | 78.0 | 29.0 | 26.2 | - | 2.8 |
| herceg-react-line | 0.0.0 (61f1019) | 80.1 | 29.9 | 27.1 | - | 2.8 |
| plotly-basic | 4.1.2 | 1184.3 | 391.4 | 325.2 | - | - |
| plotly-full | 4.1.2 | 4699.6 | 1432.7 | 1084.5 | - | - |
| tanstack-line | 1.0.0 | 125.5 | 44.4 | 39.4 | - | - |
| uplot | 1.6.32 | 50.9 | 22.5 | 20.4 | 0.7 | - |
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
| line-small-init (4 series x 200 points) | 0.70 ± 0.09 | 1.45 ± 0.23 | 1.60 ± 0.23 | 3.03 ± 0.24 | 1.17 ± 0.16 | 0.50 ± 0.10 |
| line-medium-init (10 series x 5,000 points) | 1.83 ± 0.19 | 11.4 ± 0.78 | 6.90 ± 1.37 | 22.9 ± 1.79 | 37.9 ± 1.35 | 2.30 ± 0.09 |
| line-large-init (1 series x 1,000,000 points) | 5.11 ± 0.20 | 150 ± 6.82 | 14.3 ± 1.60 | 321 ± 9.71 | 755 ± 64.5 | 6.47 ± 0.62 |
| area-medium-init (3 filled series x 5,000 points) | 1.17 ± 0.24 | 5.41 ± 0.61 | 3.41 ± 0.30 | 10.8 ± 0.34 | 15.6 ± 1.58 | 1.29 ± 0.13 |
| bar-small-init (12 categories x 3 series) | 0.52 ± 0.13 | 1.28 ± 0.22 | 0.78 ± 0.10 | 2.56 ± 0.27 | 0.55 ± 0.12 | n/a |
| bar-medium-init (100 categories x 4 series) | 0.72 ± 0.14 | 3.51 ± 0.40 | 2.20 ± 0.26 | 7.04 ± 0.67 | 3.07 ± 0.21 | n/a |
| scatter-medium-init (10,000 points) | 1.71 ± 0.15 | 77.9 ± 3.23 (first frame 5.13) | 4.24 ± 0.44 | 76.7 ± 2.58 | 28.4 ± 2.81 | n/a |
| scatter-large-init (200,000 points) | 3.36 ± 0.12 | 60.0 ± 1.18 (first frame 47.7) | 72.9 ± 4.86 | 51.2 ± 9.86 | 228 ± 9.15 | n/a |
| heatmap-medium-init (100 x 100 cells) | 1.20 ± 0.25 | 32.3 ± 0.70 (first frame 5.11) | n/a | 3.37 ± 0.46 | 36.4 ± 2.49 | n/a |
| heatmap-large-init (500 x 500 cells) | 12.3 ± 1.35 | 8820 ± 115 (first frame 56.8) | n/a | 27.1 ± 3.18 | 460 ± 39.2 | n/a |
| candlestick-small-init (200 candles, each drawn by every library) | 0.67 ± 0.07 | 2.88 ± 0.30 | n/a | 4.14 ± 0.23 | n/a | n/a |
| candlestick-large-init (100,000 candles; each library's large-data strategy) | 6.77 ± 0.08 | 56.8 ± 7.10 (first frame 43.3) | n/a | 653 ± 38.1 | n/a | n/a |
| histogram-medium-init (10,000 values in bins 5 wide from 25, x from 25 to 175) | 0.64 ± 0.15 | n/a | n/a | 3.40 ± 0.24 | n/a | n/a |
| histogram-large-init (1,000,000 values in bins 5 wide from 25, x from 25 to 175) | 6.68 ± 1.29 | n/a | n/a | 63.3 ± 1.65 | n/a | n/a |
| line-massive-init (1 series x 10,000,000 points) | 33.7 ± 2.35 | 2118 ± 32.2 | 119 ± 10.8 | 2780 ± 76.3 | error | 45.4 ± 0.73 |
| scatter-massive-init (1,000,000 points) | 16.4 ± 3.13 | 297 ± 25.6 (first frame 173) | 418 ± 9.82 | 181 ± 5.35 | 1203 ± 61.1 | n/a |
<!-- /results:init -->

## Full data replacement

<!-- results:update -->
| Scenario (ms, median ± MAD) | herceg | echarts | chartjs | plotly | tanstack | uplot |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| line-medium-update (replace 10 x 5,000 points) | 1.07 ± 0.12 | 12.5 ± 1.00 | 3.99 ± 0.46 | 19.6 ± 0.66 | 36.5 ± 1.97 | 1.09 ± 0.23 |
| line-large-update (replace 1,000,000 points) | 3.84 ± 0.10 | 191 ± 19.1 | 13.1 ± 1.40 | 281 ± 3.38 | 726 ± 41.7 | 6.01 ± 0.68 |
| bar-medium-update (replace 100 x 4 bars) | 0.42 ± 0.08 | 2.17 ± 0.28 | 1.49 ± 0.12 | 6.35 ± 0.59 | 2.90 ± 0.30 | n/a |
| scatter-medium-update (replace 10,000 points) | 1.43 ± 0.14 | 93.1 ± 1.79 (first frame 19.2) | 3.83 ± 0.46 | 68.1 ± 3.66 | 41.4 ± 2.25 | n/a |
| heatmap-medium-update (replace 100 x 100 cells) | 0.72 ± 0.08 | 46.3 ± 0.72 (first frame 19.2) | n/a | 3.71 ± 0.15 | 45.8 ± 1.81 | n/a |
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
| stream-dashboard-chart (15 series, 3,000-point window, +1 point per tick) | 0.95 ± 0.13 | 10.7 ± 1.19 | 3.37 ± 0.34 | 19.4 ± 0.59 | 30.7 ± 1.38 | 0.93 ± 0.14 |
| stream-large (1 series, 100,000-point window, +100 points per tick) | 0.83 ± 0.12 | 18.0 ± 1.74 | 3.09 ± 0.35 | 29.8 ± 0.70 | 56.8 ± 2.94 | 0.92 ± 0.08 |
| stream-massive (1 series, 1,000,000-point window, +10,000 points per tick) | 1.39 ± 0.11 | 159 ± 2.06 | 19.5 ± 0.49 | 275 ± 2.15 | 643 ± 27.4 | 6.19 ± 0.18 |
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
| ingest-chart-10hz (15 series, 3,000-point window, +1 point at 10 Hz) | 16.7 / 17.9 / 18.5 ms, 0 dropped, 10 Hz | 16.7 / 17.7 / 18.6 ms, 0 dropped, 10 Hz | 16.7 / 17.7 / 18.5 ms, 0 dropped, 10 Hz | 16.7 / 17.6 / 17.7 ms, 0.5 dropped, 10 Hz | 16.7 / 17.6 / 17.9 ms, 1.5 dropped, 10 Hz | 16.7 / 17.9 / 18.4 ms, 0 dropped, 10 Hz |
| ingest-chart-60hz (15 series, 3,000-point window, +1 point at 60 Hz) | 16.7 / 18.0 / 18.4 ms, 0 dropped, 62 Hz | 16.7 / 17.6 / 18.6 ms, 0 dropped, 62 Hz | 16.7 / 17.6 / 17.9 ms, 0 dropped, 62 Hz | 16.7 / 33.3 / 33.3 ms, 25 dropped, 55 Hz | 33.3 / 34.2 / 44.0 ms, 132.5 dropped, 33 Hz | 16.7 / 17.9 / 18.5 ms, 0 dropped, 62 Hz |
| ingest-chart-100hz (15 series, 3,000-point window, +1 point at 100 Hz) | 16.7 / 17.8 / 18.4 ms, 0 dropped, 100 Hz | 16.7 / 17.6 / 17.8 ms, 0 dropped, 99 Hz | 16.7 / 17.6 / 17.9 ms, 0 dropped, 100 Hz | 16.7 / 33.3 / 34.2 ms, 25.5 dropped, 55 Hz | 33.3 / 34.2 / 35.1 ms, 133.5 dropped, 33 Hz | 16.7 / 17.8 / 18.3 ms, 0 dropped, 100 Hz |
| ingest-large-100hz (1 series, 100,000-point window, +10 points at 100 Hz) | 16.7 / 18.0 / 18.5 ms, 0 dropped, 100 Hz | 16.7 / 17.6 / 18.6 ms, 0.5 dropped, 60 Hz | 16.7 / 17.6 / 18.4 ms, 0 dropped, 100 Hz | 33.3 / 34.2 / 49.4 ms, 129 dropped, 34 Hz | 50.1 / 67.6 / 83.3 ms, 211.5 dropped, 18 Hz | 16.7 / 18.1 / 18.6 ms, 0 dropped, 100 Hz |
| ingest-dashboard-10hz (10 charts x 15 series x 3,000 points, +1 point per series at 10 Hz) | 16.7 / 17.7 / 18.4 ms, 0 dropped, 10 Hz | 66.7 / 101 / 117 ms, 215.5 dropped, 10 Hz | 16.7 / 17.6 / 18.3 ms, 2 dropped, 10 Hz | 167 / 168 / 172 ms, 267.5 dropped, 6 Hz | 299 / 334 / 349 ms, 286 dropped, 3 Hz | 16.7 / 17.7 / 18.5 ms, 0 dropped, 10 Hz |
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
| hover-line-medium (pointer moves over 10 x 5,000 points) | 0.72 ± 0.34 | 8.90 ± 3.19 | 0.88 ± 0.37 | 8.56 ± 2.95 | 10.7 ± 6.51 | 0.53 ± 0.27 |
| hover-line-large (pointer moves over 1,000,000 points) | 0.40 ± 0.06 | 0.85 ± 0.22 | 0.42 ± 0.11 | 443 ± 186 | 92.3 ± 1.93 | 0.26 ± 0.04 |
| hover-scatter-medium (pointer moves over 10,000 points) | 0.47 ± 0.26 | 9.13 ± 2.66 | 1.88 ± 0.73 | 13.4 ± 3.75 | 5.72 ± 3.65 | n/a |

| Scenario (ms, median ± MAD) | herceg | echarts | chartjs | plotly | tanstack | uplot |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| zoom-line-large (x ranges of 50%, 10%, and 1% of 1,000,000 points, panning) | 0.90 ± 0.30 | 6.48 ± 0.41 | 1.71 ± 0.33 | 0.94 ± 0.13 | 58.9 ± 50.8 | 1.06 ± 0.71 |
| zoom-line-massive (x ranges of 50%, 10%, and 1% of 10,000,000 points, panning) | 1.32 ± 0.64 | 55.6 ± 2.12 | 5.25 ± 3.42 | 0.87 ± 0.12 | error | 5.87 ± 4.94 |
| zoom-scatter-massive (x ranges of 50%, 10%, and 1% of 1,000,000 points, panning) | 3.76 ± 0.23 | 37.3 ± 17.5 | 199 ± 30.8 | 7.59 ± 0.28 | 166 ± 140 | n/a |

| Scenario (ms, median ± MAD) | herceg | echarts | chartjs | plotly | tanstack | uplot |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| resize-line-medium (resize 800x400 <-> 600x300) | 1.06 ± 0.12 | 3.70 ± 0.45 | 3.92 ± 0.38 | 10.3 ± 1.42 | 35.1 ± 2.11 | 1.53 ± 0.36 |
<!-- /results:interaction -->

## Dashboard

Ten 600x250 line charts, each with 15 series of 3,000 points (450,000 points).
"Refresh" replaces the data of all ten charts in one task.

<!-- results:dashboard -->
| Mount all charts (ms, median ± MAD) | herceg | echarts | chartjs | plotly | tanstack | uplot |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| dashboard (10 charts x 15 series x 3,000 points) | 15.9 ± 0.57 | 90.2 ± 6.39 | 46.6 ± 1.50 | 183 ± 11.5 | 316 ± 9.39 | 16.2 ± 1.07 |

| Refresh all charts (ms, median ± MAD) | herceg | echarts | chartjs | plotly | tanstack | uplot |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| dashboard (10 charts x 15 series x 3,000 points) | 8.20 ± 0.47 | 112 ± 3.76 | 34.9 ± 1.58 | 179 ± 3.82 | 339 ± 35.8 | 10.6 ± 1.10 |
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
| memory-line-large (1 chart, 1,000,000 points; source 16 MB) | 0.2 MB heap, 5.1 MB canvas, 36 nodes | 243 MB heap, 5.1 MB canvas, 4 nodes | 49 MB heap, 5.1 MB canvas, 3 nodes | 111 MB heap, 15 MB canvas, 135 nodes | 600 MB heap, 26 MB canvas, 8 nodes | 0.2 MB heap, 5.1 MB canvas, 24 nodes |
| memory-dashboard (10 charts x 15 series x 3,000 points; source 3.9 MB) | 7.2 MB heap, 24 MB canvas, 772 nodes | 115 MB heap, 24 MB canvas, 40 nodes | 57 MB heap, 24 MB canvas, 30 nodes | 48 MB heap, 0.0 MB canvas, 2257 nodes | 273 MB heap, 0.0 MB canvas, 814 nodes | 2.8 MB heap, 24 MB canvas, 1080 nodes |
| memory-small-100 (100 charts x 2 series x 100 points; source 0.3 MB) | 8.8 MB heap, 0.0 MB canvas, 3637 nodes | 24 MB heap, 72 MB canvas, 400 nodes | 31 MB heap, 72 MB canvas, 300 nodes | 28 MB heap, 0.0 MB canvas, 13061 nodes | 21 MB heap, 0.0 MB canvas, 2274 nodes | 11 MB heap, 72 MB canvas, 3000 nodes |
<!-- /results:memory -->

## React integration

Herceg through `@herceg/react` next to plain herceg, from `npm run bench:react`.
Mounting and resizing go through React props; data replacement and streaming
change the table and bypass React. Each chart is its own React root, so
per-root setup is counted for every chart. The React wrappers of the other
libraries are not measured.

<!-- results:react -->
Measured 2026-10-07 at commit 413a800 (uncommitted changes) with react 19.3.0, react-dom 19.3.0, same environment as above.

| Scenario (median) | herceg | herceg via @herceg/react |
| --- | ---: | ---: |
| line-small-init (4 series x 200 points) | 0.57 ± 0.11 ms | 0.60 ± 0.16 ms |
| line-medium-init (10 series x 5,000 points) | 1.74 ± 0.20 ms | 1.97 ± 0.05 ms |
| line-large-init (1 series x 1,000,000 points) | 5.32 ± 0.04 ms | 5.34 ± 0.52 ms |
| area-medium-init (3 filled series x 5,000 points) | 0.99 ± 0.13 ms | 1.08 ± 0.11 ms |
| line-massive-init (1 series x 10,000,000 points) | 34.4 ± 2.79 ms | 32.4 ± 0.18 ms |
| line-medium-update (replace 10 x 5,000 points) | 1.24 ± 0.11 ms | 1.20 ± 0.10 ms |
| line-large-update (replace 1,000,000 points) | 3.23 ± 0.07 ms | 3.40 ± 0.13 ms |
| stream-dashboard-chart (15 series, 3,000-point window, +1 point per tick) | 1.09 ± 0.14 ms | 0.98 ± 0.11 ms |
| stream-large (1 series, 100,000-point window, +100 points per tick) | 0.65 ± 0.06 ms | 0.66 ± 0.07 ms |
| ingest-chart-10hz (15 series, 3,000-point window, +1 point at 10 Hz) | 0 dropped, 10 Hz | 0 dropped, 10 Hz |
| ingest-chart-60hz (15 series, 3,000-point window, +1 point at 60 Hz) | 0 dropped, 62 Hz | 0 dropped, 62 Hz |
| ingest-chart-100hz (15 series, 3,000-point window, +1 point at 100 Hz) | 0 dropped, 100 Hz | 0 dropped, 100 Hz |
| ingest-large-100hz (1 series, 100,000-point window, +10 points at 100 Hz) | 0 dropped, 100 Hz | 0 dropped, 100 Hz |
| ingest-dashboard-10hz (10 charts x 15 series x 3,000 points, +1 point per series at 10 Hz) | 0 dropped, 10 Hz | 0 dropped, 10 Hz |
| hover-line-medium (pointer moves over 10 x 5,000 points) | 0.70 ± 0.31 ms | 0.71 ± 0.31 ms |
| hover-line-large (pointer moves over 1,000,000 points) | 0.34 ± 0.06 ms | 0.41 ± 0.06 ms |
| zoom-line-large (x ranges of 50%, 10%, and 1% of 1,000,000 points, panning) | 0.77 ± 0.25 ms | 0.91 ± 0.24 ms |
| zoom-line-massive (x ranges of 50%, 10%, and 1% of 10,000,000 points, panning) | 1.12 ± 0.56 ms | 1.08 ± 0.51 ms |
| resize-line-medium (resize 800x400 <-> 600x300) | 1.19 ± 0.19 ms | 1.00 ± 0.09 ms |
| dashboard (10 charts x 15 series x 3,000 points) | mount 16.3 ms, refresh 8.32 ms | mount 16.9 ms, refresh 7.96 ms |
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
- Scatter from typed columns: at 10,000 points the libraries that render in
  one pass (Herceg ~1.8 ms on Canvas, Chart.js ~4.6 ms) are far ahead of
  ECharts and Plotly (~80 ms). Large point series are where GPU rendering
  pays: Herceg's WebGL path mounts 200,000 points in ~3.4 ms and 1M in
  ~14 ms (uploading the data each time; the GPU finishes a few milliseconds
  after the measured frame), against ~180 ms for Plotly's WebGL `scattergl`,
  ~300 ms for ECharts, ~420 ms for Chart.js, and ~1.2 s for TanStack Charts
  at 1M. Zooming 1M points takes ~4 ms in Herceg and ~8 ms in Plotly, whose
  data both stay on the GPU, against ~38 ms for ECharts and ~170–190 ms for
  TanStack Charts and Chart.js.
- Heatmaps drawn as one image scale with cell count at a few bytes per cell:
  500 x 500 cells take ~12 ms in Herceg and ~30 ms in Plotly, against ~450 ms
  for TanStack Charts (one scene node per cell) and ~9 s for ECharts to
  complete its progressive render.
- Massive data separates the libraries that keep data in typed arrays.
  Mounting a 10M-point line takes ~38 ms in Herceg and ~44 ms in uPlot,
  ~240 ms in Chart.js, and 1.6–2.8 s in ECharts and Plotly; TanStack Charts
  runs out of memory (its tab crashes). Zooming into 10M points takes
  ~0.85 ms in Plotly, whose WebGL traces keep data on the GPU and do not
  rescale y, ~1.4 ms in Herceg, whose min/max index answers each pixel
  column without rescanning, ~6 ms in Chart.js and uPlot, and ~55 ms in
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
