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

Herceg renders line, area, bar, point (scatter), heatmap, contour, rug, dendrogram, error bar,
candlestick (and OHLC bar), histogram (1D and 2D), pie, box plot, violin, treemap, sunburst, gauge, funnel, radar, Sankey, network (graph), map (geoshape and geopoint), and 3D (point3d, line3d, and surface) marks, rule, region, and text annotations, and custom marks, on time axes that can leave out breaks.
Dendrograms draw a precomputed hierarchical linkage with its leaves on a
heatmap's categories in subplots; Python's `herceg.express` computes the
clustering for its `clustermap` (see [Statistical charts](#statistical-charts)).
Rug and dendrogram performance has not been compared with competitors.
uPlot has no bar, scatter, or heatmap support comparable to the scenarios, and
Chart.js has no built-in heatmap; those cells are marked n/a.

## Summary

| Area | Herceg | ECharts | TanStack Charts | Chart.js | Plotly |
| --- | --- | --- | --- | --- | --- |
| Initial render | Measured. Fast at every size measured: ~0.7 ms for 4 x 200 line points, ~1.6 ms for 10 x 5,000, ~4.8 ms for 1M points (uPlot: ~7.0 ms), ~35 ms for 10M points (uPlot: ~46 ms). Bars ~0.7 ms for 100 x 4; scatter ~2.1 ms for 10k points on Canvas, ~3.3 ms for 200k and ~13 ms for 1M with WebGL; heatmaps ~1.3 ms for 100 x 100 and ~13 ms for 500 x 500 cells, drawn as one image. Lines are reduced to at most four points per pixel column; SVG below 4,000 drawn points or cells, Canvas above. | Measured. Canvas; fast for small charts, ~150 ms for a 1M-point line with `minmax` sampling. Scatter and heatmap series render progressively: a 500x500 heatmap shows its first frame after ~60 ms and completes after ~9 s. | Measured. Fast small SVG charts; cost grows with rows because every row becomes a scene node (~0.8 s for 1M points on Canvas). | Measured. Fast for small and medium charts; min-max decimation makes 1M points cheap once the `{x, y}` objects exist. | Measured. Slowest small charts; SVG scatter is expensive at 10k points, WebGL traces handle large data. |
| Incremental update | Measured. Tables support append, drop, range replace, and reset; charts re-render once on the next frame. Replacing 10 x 5,000 line points takes ~1.2 ms, 1M points ~3.9 ms (uPlot ~6.2 ms), 10k scatter points ~1.5 ms, 100 x 100 heatmap cells ~0.7 ms. | Measured. `setOption` re-processes the series; no rolling-window append. | Measured. Updates rebuild the definition and scene. | Measured. Mutate arrays and `update('none')`; cheap. | Measured. `extendTraces` with `maxPoints` gives a documented rolling window, but each tick costs 20–30 ms here. |
| Streaming | Measured. ~1.0 ms per tick for 15 series x 3,000 points (uPlot: ~0.9 ms); keeps up in every paced scenario, including the ten-chart dashboard at 10 Hz. A million-point rolling window takes ~1.4 ms per 10,000-point tick (uPlot: ~6.2 ms), because min/max indexes are kept current as rows arrive. Rolling windows via `maxRows`. | Measured. ~11 ms per tick for 15 series x 3,000 points; keeps up with 100 Hz ingestion for one chart but drops frames for a 10-chart dashboard at 10 Hz. | Measured. ~31 ms per tick; at 60–100 Hz ingestion only ~33 updates per second get through. | Measured. ~3.5 ms per tick; keeps up in every paced scenario. | Measured. ~20 ms per tick; ~54 updates per second at 100 Hz, ~6 Hz for the 10-chart dashboard. |
| Memory | Measured. ~0.2 MB retained for 1M points: source typed arrays are used in place and geometry buffers are bounded. Ten-chart dashboard ~7 MB (uPlot ~3 MB); 100 small charts ~8 MB and no canvas backing stores, because small charts render to SVG. | Measured. ~240 MB retained for 1M points (internal storage plus per-point structures). | Measured. ~600 MB retained for 1M points (row objects, Dates, scene nodes). | Measured. ~49 MB for 1M points (one `{x, y}` object per point). | Measured. ~110 MB for 1M points with WebGL. |
| Bundle size (line chart, gzip) | Measured. ~46 KiB for a time-series line chart with tooltip, events, and brushing (monotone curves, which line charts carry whether they use them, are ~1 KiB of it, the four built-in themes with page-following themes about 2 KiB, the dispatch to layout marks such as pies about 1 KiB, y and xy zoom, rectangle and lasso brushes, and synced selections about 1.4 KiB, and facet headers, per-panel y scales, subplot routing, and weighted rows, which the model plans for any chart, about 1.1 KiB, x scales of panels' own (planned per group for any chart, with zoom, selections, and events per scale in the browser runtime) about 1.5 KiB, categories of panels' own (band axes planned per group, and category positions and values read through each panel's band places in tooltips and keyboard reads, and the chart's bands handed to summaries) about 0.1 KiB, the hooks that start view transitions and value transitions, whose code loads separately, about 0.6 KiB, the hooks that let a map's layers share a chart and tables hold geometry columns, about 0.1 KiB, the hooks for time axis breaks (whose code comes only with `timeBreaks`) and crosshair labels (loaded on demand), about 1.2 KiB, the camera API and the hooks that load 3D turning (`camera`, `setCamera`, the camera event, presses kept to their pointer), about 0.6 KiB, the hooks of row selections (`rowSelection`, whose code comes with `rowSelection()`), about 0.15 KiB, the hooks that load tooltip fields and content of the application's own (`tooltip.fields`, `renderTooltip`) and check fields as marks are made, about 0.3 KiB, exports of a mounted chart (`toPNG`, and the hook `renderToPDF(chart)` uses), about 0.1 KiB, and times read from ISO 8601 strings, numbers as categories, and values converted before a table changes, about 0.15 KiB; the pie, the maps, the breaks and their seam drawing, and the 3D marks themselves are not included). Each mark brings its own drawing code, so a line chart carries no bar, point, symbol, heatmap, or text drawing, color schemes are separate exports, and facets and the code that copies traces through independent panel bands or time breaks are only bundled when used; the chart model still includes band-axis, legend-layout (series, color, size, and shape keys), horizontal-bar inspection, right-axis, and panel-layout logic, and min/max indexes for large lines add ~1 KiB. The WebGL painter for large point series (~3.5 KiB; 3D charts add their ~4.2 KiB programs for points, lines, and surfaces, a separate chunk where the build splits them), 3D turning (~2 KiB), animation of views (~1 KiB) and of values (~6.5 KiB), crosshair labels (~1 KiB), tooltip fields and content of the application's own (~1.1 KiB), and PNG export (~0.4 KiB) load only when a chart needs them, and text is measured with the browser's canvas, so the static text estimator is not bundled. | Measured. ~167 KiB tree-shaken, ~371 KiB full. | Measured. ~44 KiB including `d3-scale` for time. | Measured. ~64 KiB with time scale and date adapter. | Measured. ~391 KiB basic bundle, ~1.4 MiB full. |
| Line | Line, step lines, smooth monotone curves, several y fields or a long-format series field, gaps for missing values, log and time axes, level of detail for large series. Area (stacked, band) and rule marks. | Documented. Time axes, sampling, area fill, step lines. | Documented. `lineY`/`lineX`, gaps, curves. | Documented. Line, stepped, filled; decimation plugin. | Documented. `scatter`/`scattergl` lines, rich hover. |
| Stacked areas and bars | Areas and bars stack several fields row by row, or the series of a category field: areas on every x any shown series has (a series without a row there counts as zero, or with `stackGaps: "interpolate"` as the line between its rows, zero beyond its ends; several rows at one x pair up by occurrence), bars by position, positive values up and negative down. Edges are typed arrays aligned on that union of x; tooltips, the keyboard, events, and summaries read each series' own rows, at its layer's top; hidden series leave the stack; facets stack each panel apart; on log axes area stacks stand on the axis' low end; monotone curves and value animation move the layers together. Streaming restacks only what appended and dropped rows touch. One-off measurements (not a committed scenario; Chrome 154, macOS 27, Apple M6, 800 x 400 at DPR 2, three runs interleaved with the version before; the stacks' own cost is in `npm run bench:core`): bars of 10 series x 10,000 positions in a rolling window, a position per tick at 60 Hz, take ~4.0 ms of JavaScript a frame (p95 ~5.8) instead of ~6.4 (p95 ~8.4), with no dropped frames either way, against ~3.6 ms for the same bars grouped; areas of a series field stacked the same way ~3.7 ms. At 10 Hz frames alternate between two clock states for every variant (~4.4 against ~7.6 ms in the fast one). The edges cost 16 bytes per layer and x, so series sharing few x cost up to the number of series times their rows. Areas and bars also normalize nonnegative values per position with `stack: "fill"`, as histograms normalize per bin; area `"center"` and `"wiggle"` offsets retain raw thickness, with optional `stackOrder: "inside-out"`. Both orientations, legend renormalization, facets/subplots, zoom, static export, and share/raw keyboard readings use the same engine across TypeScript, Python, React, Vue, and Svelte. Mixed signs require ordinary stacks; new modes keep per-layer missing gaps. Fill/center in input order retain incremental updates; wiggle and inside-out rebuild the retained window, with inside-out value updates immediate. Comparative timing of these new modes is not yet measured; the measurements above concern ordinary stacks. | Documented. `stack` groups series, `stackStrategy` (same sign, all, positive, negative) and `stackOrder`; series are matched by category on category axes and by data index otherwise, so series on time or value axes must share their x in order, and a series without a value at a position is skipped rather than filled (from its source, 6.1). | Documented. `areaY` stacks implicitly at repeated x by series (`z`), with `stack()` layouts for order, offset (diverging, normalize, center, wiggle), and reversal; a missing position and series pair counts as zero for the layout without a point of its own, so each area is drawn through its own rows. | Documented. `stacked: true` on the value scale stacks datasets matched by their index-scale value; filled lines (`fill: "stack"` or `"-1"`) run through each dataset's own points, so a dataset missing an x adds nothing there and its fill joins its neighbors (from its source, 4.5). | Documented. `stackgroup` on scatter traces with `stackgaps` "infer zero" (the default) or "interpolate" (constant beyond a trace's ends), `groupnorm` for fraction or percent stacks, and orientation; bars with `barmode: "stack"` or "relative". |
| Scatter | Point mark with per-series color, radius, and opacity; every point is drawn. Series of 100,000+ points use WebGL (loaded on demand): ~13 ms to mount 1M points, ~3.6 ms per zoom step, both ahead of Plotly's WebGL. Nearest-point hover through a spatial grid index (~0.5 ms per move at 10k points). Streaming clouds, whole columns or split by a series field, upload only new points (a million points in two series at 1,000 rows per tick: ~3 ms of JavaScript per frame instead of ~13 ms before). Size (bubbles), continuous color (named sequential and diverging schemes, midpoints), category color (the theme's palette per value), opacity, and eight symbol shapes by field, with size, shape, and color keys; outlines (`stroke`, `strokeWidth`); encoded and outlined points are drawn on the CPU, not WebGL. Points on category axes (strip and dot plots, on either axis or both, over bars too), in facets and subplots with each panel's own categories; these are always drawn on the CPU; series dodge within a band, and points jitter by a hash of each row and a seed or pack as a beeswarm (`swarm`: in order of value without overlap, laid out again on resize and zoom; bounded, about 2 ms for 10,000 points in a band). | Documented. `large` mode for big scatter. | Documented. `dot` mark; one scene node per point. | Documented. Scatter/bubble. | Documented. SVG and WebGL scatter. |
| Heatmap | Heatmap mark over category, number, or time fields, drawn as one image (Canvas `drawImage`, PNG inside SVG), with a color legend and cell tooltips. Number and time fields place cells along number and time axes that zoom, pan, and brush like other marks' axes and that other marks share: edges halfway between distinct values, or a fixed `xStep` / `yStep` that leaves gaps where values are missing, computed from the data, never the view; boundaries between local days fall halfway in elapsed time across clock changes (calendar weeks end at the zone's midnights); on time axes with breaks, cells either side of a break meet at its seam. `xBanded` / `yBanded` give one band per distinct value instead, and `x1`/`x2` (`y1`/`y2`) place cells between each row's edges, as binned data has them. Rows sharing a cell combine by `reduce` (last, mean, sum, min, or max), the same at every zoom. Calendar heatmaps of a date field in the chart's time zone: weeks along a zoomable time axis by weekday (any first day of the week), or months by day of the month, with missing and nonexistent days empty. Named sequential and diverging schemes, fixed color domains, and midpoints. No cell limit: a grid larger than the plot is drawn at the plot's device resolution, each pixel the mean (or with `sampling.reduce`, the max or min) of its block of cells, weighted by area where cells are unevenly spaced, and tooltips and the keyboard still find the single cell under the pointer (by binary search: at 10M cells a keyboard step along a row, or down a column within 32 rows, takes microseconds, where it scanned every cell, ~0.3 s; longer jumps still scan); memory follows the table's rows and the plot's pixels, not the cell count. Measured in a one-off run outside the committed suite (headless Chrome 154, Apple M6, 800 x 400 chart at DPR 2; competitors not run at these sizes): a sparse 4,000 x 4,000 grid of 200,000 rows mounts in ~42 ms and keeps ~15 MB beyond the source arrays, a dense one (16M rows) mounts in ~0.28 s, and 10M rows over 10,000 x 10,000 cells in ~0.22 s; band indices and the tooltip index take up to 12 bytes per row, and the first tooltip after a change builds that index (~0.1 s at 10M rows). Scene construction in Node (one-off, same chart, medians of 5 runs, interleaved A/B against banded number fields, which could not zoom): a dense 2,000 x 2,000 grid builds its first scene in ~90 ms either way and repaints a zoomed view in ~22 ms (a repaint took ~34 ms); 10M rows over 10,000 x 10,000 cells take ~380 ms (~375 ms) and ~93 ms per zoomed view (~85 ms per repaint); the first tooltip takes the same ~8 ms and ~170 ms (building the index); unevenly spaced cells cost more, ~175 ms for 2,000 x 2,000 (~105 ms banded), which also builds the tooltip index, and ~55 ms per zoomed view. Split by facets (each panel's cells from its own rows, never merged with another panel's), with x and y categories or number and time scales shared or each panel's, row's, or column's own, in facets and subplots, and one color scale across panels. No binning of its own (2D histograms bin rows; see below), no log axes yet, and calendar month labels are the time axis' ticks rather than labels aligned to week columns. | Documented. Heatmap series on a Cartesian grid of two category axes (its development build refuses others), on a matrix, on maps, or on a calendar coordinate system. | Documented. `cell` mark with a D3 color scale. | No built-in heatmap (third-party `chartjs-chart-matrix`). | Documented. Heatmap traces rendered as an image, at cell coordinates (`x` and `y`, or `x0` and `dx`) on zoomable number, date, or category axes, with `xgap` / `ygap`. |
| Candlestick | Measured. Candlestick mark over number, time, or category x: rising candles hollow, falling ones filled, all four prices in tooltips. ~0.7 ms for 200 candles. With more candles than pixel columns, each column's candles merge into one (the first open, highest high, lowest low, and last close): ~6.8 ms for 100,000, where merged candles show direction by color only. OHLC bars are a `variant` of the same mark (not measured separately); a volume pane is a subplot sharing x. | Measured. Built-in `candlestick` series: ~2.9 ms for 200 candles; its `large` mode draws high-low lines without bodies, ~57 ms for 100,000. | No built-in candlestick. | No built-in candlestick (third-party `chartjs-chart-financial`, not measured). | Measured. Built-in `candlestick` and `ohlc` traces, drawing every candle: ~4.1 ms for 200, ~650 ms for 100,000. |
| Financial charts | Time axes that leave out breaks (`timeBreaks`): days of the week, daily clock spans, calendar dates, and spans of instants, in the chart's time zone with clock changes; ticks never fall inside a break and move to the session that opens after it, labeled by the day or month that begins; data inside breaks is hidden while lines join across; zoom, pan, brushes, tooltips, and level of detail work in time shown. One-off measurement (Node, scene construction, a 1M-point line over ten years of New York sessions): ~4 ms to mount (~2.4 ms without breaks), ~0.5 ms per zoomed view (~0.1 ms), ~1.2 ms per streamed tick of 1,000 points (~0.6 ms). Candlesticks and OHLC bars (`variant: "ohlc"`), and crosshair labels on the axes (`tooltip.axisLabels`). A range navigator (`rangeNavigator`): a strip under the plot drawing its lines, areas, points (sampled to one per pixel), bars, and candlesticks over the whole x axis, whose window pans and zooms by dragging (dragging elsewhere selects, a double click resets) and is three keyboard sliders with value texts; it follows breaks, streaming data, wheel zoom, brushes, and synced charts, and SVG, PDF, and PNG export draw it. With facets or subplots that share x, one strip under all the panels draws every panel's marks (each panel's part apart, over that panel's y scale) and moves the x range they share; x scales per panel are refused. One-off measurement (Chrome, JavaScript per frame): dragging the window over a 1M-point line ~2.6–2.9 ms a move, as panning without one; with a zoomed 100,000-point rolling window streaming, ~2.3–2.4 ms a frame instead of ~1.5–1.6 ms; under 12 facet panels of a 100,000-row line ~0.5–0.6 ms a move (~0.2–0.3 ms panning without), under 4 subplots of 100,000 rows with a dense volume panel, column reduction takes drag p50/p95 from 2.550/2.820 to 0.340/0.445 ms and retained overview buffers from 2.40 MiB to 223 KiB; a single 1M-bar chart goes from 21.970/23.090 to 0.420/0.475 ms and 22.89 MiB to 110 KiB. Overview rebuild p50 is 1.225 → 1.700 ms and 6.930 → 10.650 ms respectively: checking placed rectangle footprints adds rebuild work, while dragging reuses the bounded geometry. A separate minified Node measurement of 1M rows with only 20 usable bars takes p50 5.944–6.086 → 2.505–2.775 ms after combining density and exact geometry in one source scan. The drag and dense rebuild figures use one-off before/after production Canvas measurements in Chrome 154, DPR 1, three alternating rounds; methodology and p95 rebuilds are in [Range navigator](architecture.md#range-navigator). Dense bars cover every CSS column their placed rectangles intersect, including wide bars and clipped edges, and keep each column's extreme per sign, with the extreme bar's color (ties: first series, then row); stacks retain the segments at the most extreme position per sign. Subpixel gaps fill, shorter bars' colors can disappear, and stack proportions show the chosen positions. Sparse bars stay exact; missing, zero-area, and wholly clipped rectangles do not count toward density. Opt-in dashed seam markers (`x.seams`) behind data in SVG, Canvas, and PDF, thinned in chronological order to a minimum CSS-pixel spacing (default 40); the navigator draws none. No technical indicators beyond derived rolling windows, no drawing tools; dense navigator bars still require a full scan to rebuild after data changes; candlesticks remain one glyph per row. | Documented. Axis breaks since 6.0 (`xAxis.breaks`): each break an explicit `start` and `end` with a visual `gap`, on value, log, and time axes (not category), so recurring weekends and sessions are listed one by one; its candlestick examples use a category axis of trading days instead. `axisPointer` labels values on the axes (by default with the `cross` pointer). OHLC bars through a custom series (an example), not a built-in style. `dataZoom` of type `slider`: a strip with a shadow of one series (a line and an area), handles that label their values, dragging across the shadow to select (`brushSelect`), along x or y and on category axes, controlling one axis or several grids' (`xAxisIndex` as a list); no keyboard operation documented. | No candlesticks, axis breaks, axis pointer labels, or range navigator documented. | Documented. The `timeseries` scale spreads data points equidistant, which closes gaps between them (not breaks of time); candlesticks and OHLC bars only through the third-party `chartjs-chart-financial`; no axis labels at the crosshair; no range navigator (`chartjs-plugin-zoom` zooms and pans without an overview). | Documented. `rangebreaks` on date axes: `bounds` with a `pattern` of "day of week" or "hour", or `values` with a `dvalue` size; `candlestick` and `ohlc` traces; spike lines (`showspikes`) across the plot or to the axes, with no documented labels on the axes. `xaxis.rangeslider`: the traces drawn again in a strip (`thickness`, 15% of the plot by default), shown by default under candlestick and OHLC charts, with `yaxis.rangemode` for its y range; no keyboard operation documented. |
| Histogram | Measured. Histogram mark binning a number or time field into round or calendar bins (or a fixed step), overlaid or stacked by series, as counts, percent, or probability density. On the same fixed grid as Plotly: ~0.6 ms for 10,000 values, ~6.7 ms for 1,000,000. Split by facets, each panel counts its own rows, in bins chosen from the rows of the panels sharing its binned axis (one set of bins, or each panel's, row's, or column's own), with percent and density over each panel's counts and stacks within each panel. Bins are recomputed when the data changes. Vertical or horizontal with exact explicit edges, probability, common normalization including hidden series, cumulative bars (density integrates widths), and opaque dodged series; these additions are correctness-tested in SVG, Canvas, static SVG, and PDF, but their performance has not been compared. 2D histograms of x and y are in the next row. | No built-in histogram (bin with a dataset transform or by hand). | No built-in histogram. | No built-in histogram. | Measured. `histogram` trace with automatic or fixed bins and many normalizations: ~3.4 ms for 10,000 values, ~63 ms for 1,000,000. |
| Contours and 2D histograms | Measured in Node only (`npm run bench:core`, Apple M6; competitors not run). `contour` mark over a rectilinear grid of rows (evenly spaced or not) or a matrix table (`fromMatrix`: coordinates once each, not per grid point): lines at thresholds, or disjoint filled bands with holes, by marching squares with the asymptotic decider for saddles; missing values leave holes; a stepped legend of bands; tooltips at the pointer inside a band region or near a line, keyboard reading of bands and their regions, a text summary per band; facets. Tracing ten thresholds of a smooth 1,000 x 1,000 grid takes ~14 ms, of uniform noise (each cell crossing six of the ten on average, 7.6M points) ~550 ms; tracing is kept, so recoloring redraws in ~0.25 ms (noise: ~7 ms) and zooming projects again in ~2 ms (noise: ~75 ms). Exports keep every traced point (no simplification): ten bands of a smooth 200 x 200 grid are ~200 KB of SVG (~41 KB gzipped). No contour labels, smoothing, log axes, or time breaks; scattered points need binning or a density estimate first (Python's `herceg.express.kdeplot` makes one). 2D histograms (`histogram` with `x` and `y`): the 1D bins along each axis (counts, explicit edges, steps, calendar bins), weights, counts matching NumPy's `histogram2d`, frequency, probability, percent, and density per unit of bin area, drawn as one image with heatmap tooltips and keyboard steps; a million points in 50 x 50 bins are counted and drawn in ~12 ms. No hexagonal bins, `histfunc`-style averages, or 2D histogram contours. | Not built in: no contour series (ECharts-GL's surface draws wireframes, not contour lines), and 2D histograms are heatmaps of counts binned by hand (ecStat's histogram transform is one-dimensional). | Not implemented. | Not implemented (no built-in heatmap; contours need a plugin or a custom chart). | Documented. `contour` trace (z on a grid with x and y, filled, line, or heatmap coloring, contour labels, gap connection, line smoothing), `histogram2d` (count, sum, average, min, or max per bin; several normalizations), and `histogram2dcontour`; Plotly Express `density_heatmap` and `density_contour` (contours of a 2D histogram rather than a kernel density). Not measured here. Others: Observable Plot has `contour` and `density` marks (d3-contour's marching squares over a regular grid, each threshold's region drawn over the lower ones rather than as disjoint bands) and `hexbin` and 2D `bin` transforms; Vega has `isocontour` and `kde2d` transforms. |
| Pie and donut | Pie mark with an inner radius for donuts: slices sum a value (or count rows) per category, largest first, with 2 px gaps that work on any background, labels beside the pie with leader lines (the smallest dropped when they do not fit), legend toggling that gives the rest the circle, and slice tooltips, hover outlines, and arrow-key reading. Drawn as SVG and Canvas arcs, and as cubic curves in PDF. Pies draw in each facet panel (each its panel's rows, with one legend and one color per category) or in a subplot of their own beside panels with axes. No labels inside slices, no rose or half-circle layouts yet. | Documented. `pie` series with `radius` for donuts, `roseType`, label lines, selected offsets, start angle, and many label layouts. | Documented. `pie` in `@tanstack/charts/polar`, with radial arcs and bars. | Documented. `pie` and `doughnut` chart types; labels inside or outside need a plugin. | Documented. `pie` trace with `hole`, `textposition` inside or outside, pulled slices, and subplot domains for several pies. |
| Box plot | Raw values per category or one precomputed box per row (`low`, `q1`, `median`, `q3`, `high`, optional `count`): vertical or horizontal, grouped by series, with statistic tooltips, keyboard reading, summaries, and facet-local categories. Raw whiskers use Tukey's 1.5 IQR, the full range, or a nonnegative IQR multiple; precomputed endpoints are supplied, with no outliers. Notches use median ± 1.57 IQR / √count (precomputed count required), without clamping, in SVG, Canvas, static SVG, and PDF. Raw statistics recompute and sort when data changes; precomputed input reads columns without expanding counts or creating observation objects. No means yet; box plot performance has not been compared. | Documented. `boxplot` series over precomputed summaries, or the `boxplot` dataset transform; outliers as a separate scatter series. | Documented. `boxX`, `boxY`, and `boxRows` with a summary transform (quartiles, Tukey whiskers, outliers). | No built-in box plot (`@sgratzl/chartjs-chart-boxplot` plugin). | Documented. `box` trace computing statistics from raw values, with notches, means, standard deviations, and points; `violin` traces. |
| Violin | Violin mark over raw values: Gaussian kernel densities (Silverman bandwidth per group, or one bandwidth for all), independently as wide at their peaks, reaching two bandwidths past the extreme values. Vertical or horizontal, grouped side by side or split into halves for at most two observed series values (first left/below, second right/above); missing or hidden partners leave their half empty. Inner box (default), dashed quartiles with a solid median, or none; separate colors, legend entries, statistic tooltips, keyboard stops, and summaries. Facets with per-panel categories, SVG, Canvas, static SVG, and PDF. Each group copies and sorts values for statistics; density uses linear binning and a convolution of at most 512 points, recomputed when data changes. No count or area scaling, points, means, or hard span yet; violin performance against competitors is not measured. | No built-in violin series; drawn with a custom series. | Documented. `violinX` and `violinY` draw mirrored profiles from prepared, normalized widths; densities and statistics are computed by the application. | No built-in violin (`@sgratzl/chartjs-chart-boxplot` plugin). | Documented. `violin` trace computing a kernel density from raw values (Silverman's rule by default), with soft, hard, or manual spans, width or count scaling, split sides, an inner box, a mean line, and points. |
| Treemap and sunburst | Treemap and sunburst marks over a tree from path fields or node and parent fields, sized by summed values or row counts: squarified rectangles with group headers, or rings by depth; colored by top-level group, legend toggling of groups, names where they fit, tooltips with each node's path and share, and depth-first keyboard reading. Weights must be finite and non-negative. Drill-down with the shared `interaction.zoom`: click or Enter on a node lays out its subtree (keys and colors kept), Backspace, a sunburst's middle, and a breadcrumb strip (drawn in exports, with native buttons for the pointer, Tab, and screen readers) go back; `setDrillRoot` and `getDrillRoot` with a `drill` event (React `onDrill`, Vue `@drill`, Svelte `ondrill`). A click selects a node's rows through `rowSelection` (then Enter drills). One-off measurement (Chrome): drilling into a region of 10,000 leaves ~1.5 ms a frame, back out ~2.2 ms. Drilling in facet panels (which share one root) and subplots (each its own) too; no icicle layout or level styles yet. | Documented. `treemap` series (drill-down, breadcrumb, level styles) and `sunburst` series (root navigation, level styles), with visual mapping of values. | Documented. `hierarchy/treemap`, `hierarchy/sunburst`, and `hierarchy/tree` marks. | No built-in treemap or sunburst (`chartjs-chart-treemap` plugin). | Documented. `treemap` (with a path bar), `sunburst`, and `icicle` traces from ids and parents, with branch values and click-to-zoom. |
| Gauge | Gauge mark: the last finite value of a number field on a 240-degree dial (0 to 100 by default), so appending rows moves it; optional colored bands as a ring outside the track, the value's arc in its band's color, Intl number formats, values past the ends filling the dial while the text shows them as they are, and an item for tooltips, hover and click events, and keyboard reading. Drawn as SVG and Canvas arcs and in PDF. One value per dial; no needle, ticks, threshold marker, or bullet layout yet. Not benchmarked. | Documented. `gauge` series: progress bar, pointer, axis line colored by ranges, ticks and labels, several pointers per dial, start and end angles, and a formatted `detail` value. | Documented as a composition, not a mark: `pie` over a partial angle range with `radialArc` and `radialText` (`@tanstack/charts/polar`); needles from further marks. | No built-in gauge; a `doughnut` with `circumference` and `rotation` draws a partial ring (plugins such as `chartjs-gauge` add needles). | Documented. `indicator` trace in `gauge` mode: angular or bullet shape, a value bar, colored `steps`, a `threshold` line, and number and delta displays. |
| Funnel | Funnel mark: a centered bar per category whose width is proportional to its summed value (or row count) relative to the largest stage, in input or value order, with faint connectors that carry no data, stage names, and each stage's value and share of the first stage on or beside its bar; tooltips add the share of the previous stage. One color for all stages; no area-proportional (trapezoid) layout, per-stage colors, or legend yet. Not benchmarked. | Documented. `funnel` series of trapezoids, sorted ascending, descending, or as given, with gaps, label positions, and size and alignment options. | Documented as a composition, not a mark: one `areaX` trapezoid per stage from derived endpoints. | No built-in funnel (`chartjs-chart-funnel` plugin). | Documented. `funnel` trace (bars with connectors; text with percent of the initial, previous, or total) and `funnelarea` trace (stacked trapezoids). |
| Radar | Radar mark from long data (a category field for spokes and a value field) or wide data (a number field per spoke, a row per polygon), 3 to 100 spokes and a polygon per series with a translucent fill, outline, and dots; one linear scale for every spoke (round by default, or a fixed domain, with values beyond it drawn at the rim and flagged in tooltips), polygon rings labeled along the first spoke where labels fit, spoke names outside the rim that shrink the radar (to a limit) and are shortened or dropped when they do not fit, outlines broken and fills left out at missing values, legend toggling, and tooltips, hover outlines, and keyboard reading per value. No per-spoke scales, circular grids, value labels, or stacked or rose layouts yet; not benchmarked. | Documented. `radar` component with an `indicator` per spoke, each with its own `max` (and `min`), polygon or circle shapes, split areas, and `radar` series with area styles and symbols. | Documented. Composed in `@tanstack/charts/polar` from `radialGrid` (polygon rings), `angleGrid`, and `radialArea` and `radialLine` with a closed curve; values normalized by the application. | Documented. Built-in `radar` chart type on a `radialLinear` scale, with point labels, backdrop tick labels, filled datasets, and circular or polygon grids. | Documented. `scatterpolar` traces with `fill: "toself"` on polar axes (category angular axis), with line, marker, and per-trace hover options; any polar axis styling. |
| Sankey | Sankey mark over one table of flows: source and target category fields, links summing a value or counting rows. Columns by longest path with sinks in the last column and six passes of relaxation, as d3-sankey does; translucent bands in the source node's color; names and values beside the nodes, inside the diagram, shortened or left out when they do not fit; tooltips, hover outlines, clicks, and keyboard reading of nodes and links. Links that would close a cycle are left out and counted in the chart's description. Not benchmarked. No draggable or hand-placed nodes, vertical orientation, circular links, or highlighting of a node's links yet; the layout is recomputed whenever the table changes. | Documented. `sankey` series from `nodes` and `links`: `nodeAlign` (justify, left, right), horizontal or vertical `orient`, `nodeWidth`, `nodeGap`, `layoutIterations`, draggable nodes, per-depth `levels` styles, links colored by source, target, or a gradient, edge labels, and adjacency or trajectory emphasis. Cyclic data is an error. | Documented. `sankeyDiagram` in `@tanstack/charts/network/sankey` (bundling d3-sankey) lays out separate `nodes` and `links` and composes ordinary marks (`link`, `rect`, `text`) over the positioned node and link rows; alignment, node and link sorting, responsive `nodeWidth`, `nodePadding`, and `inset`, and iterations are options. Cycles, negative values, and duplicate node keys are errors. | No built-in Sankey (the `chartjs-chart-sankey` plugin). | Documented. `sankey` trace (full bundle, not `plotly-basic`) from node and link arrays: `arrangement` (snap, perpendicular, freeform, fixed), nodes placed by `x` and `y`, draggable nodes, node and link hover, and circular links for cyclic data. |
| Network graph | Graph mark over a table of links (source and target category fields; an optional value summed per pair of nodes, either way round, setting link widths) and an optional table of nodes (a category `color` field coloring nodes, with a legend that toggles categories without moving the rest, and a size field by area). Laid out by d3-force's simulation and defaults (springs, many-body repulsion with a Barnes–Hut quadtree above 150 nodes, 300 ticks), started from pivot MDS rather than a spiral, so rings and chains do not fold, with connected components packed in rows; deterministic, fitted to the room, overlapping nodes pushed apart. Ringed nodes, translucent links tinted by category, names beside the most connected nodes where they cover no other node or name; tooltips, hover outlines, clicks, and keyboard reading of nodes and links; SVG, Canvas, and PDF. Not benchmarked: one-off timings of the layout in Node are ~0.1 s for 1,000 nodes and ~1 s for 5,000 (with up to 30,000 links), and a network draws at most 5,000 nodes and 20,000 links. Recomputed from scratch whenever a table changes. Directed links (`directed`: a link per ordered pair, bowed apart both ways, arrowheads at the target's ring) and link labels (`linkLabelField`). Nodes dragged with the shared `interaction.drag` (Shift-arrow keys, or Alt+Shift with zoom on), staying where dropped without re-simulating, with `setItemPosition` and an `itemMove` event; nodes and links select their rows of the nodes or links table through `rowSelection`. One-off measurement (Chrome): a drag frame at 5,000 nodes and 20,000 links ~4 ms of the main thread (nodes and links packed, not path strings). Zoom and pan through `interaction.zoom` (true or "xy"), with the same wheel, drag, double-click, Shift-arrow, plus/minus/0, toolbar, and viewport API as maps, in layout coordinates; nodes keep their pixel radii. Lassos select visible nodes' rows and dim other nodes and links; node moves and `setItemPosition` work while zoomed. Pointer candidates use packed spatial grids with the existing picking order. React, Vue, Svelte, Python widgets and Streamlit share these options and view events. Networks draw in facet panels (one layout of the whole network, each panel its rows' links, totaled there) and subplots (each its own view and moves). No layout settling around a moved node, circular layout, parallel labeled links, or neighbor highlighting yet. | Documented. `graph` series from `nodes` and `links` with `layout` `none` (given positions, also on cartesian, polar, or geo coordinates), `circular`, or `force` (`repulsion`, `gravity`, `edgeLength`, `friction`, an animated or instant layout); `categories` with a legend, draggable nodes, roam (zoom and pan), edge arrows and labels, curved parallel edges, and adjacency emphasis on hover. | Documented. `forceLayout` in `@tanstack/charts/network/force` runs a stopped d3-force simulation synchronously and deterministically with explicit forces (link, many-body, center, collide, x, y, or custom d3 forces) and returns node and link rows with padded domains, drawn with ordinary marks (`link`, `dot`, `text`); resizing remaps without another simulation. Not a live simulation: dragging is left to the application. | No built-in network (the `chartjs-chart-graph` plugin adds graph and force-directed graph charts). | Documented. No network trace: the documentation draws networks as a `scatter` trace of nodes and one of line segments for links, with positions computed elsewhere (networkx in Python). |
| Geographic maps | `geoshape` regions (choropleths by a number field on a continuous scale, or by category with a legend that grays categories out) and `geopoint` points and bubbles (sized by area, colored by series or a number field, ringed, largest first) on one projection: Equal Earth, Natural Earth, Mercator, equirectangular, or Albers' conic equal-area, with a central meridian and a fit to the data, the world, or a box of degrees. Shapes are a packed geometry column (GeoArrow-style offsets, binary in specs, codes per row shared by derived tables) from GeoJSON, GeoPandas, or Shapely without per-vertex objects; edges are planar in longitude and latitude, cut at the seam and the Mercator limit. Tooltips, hover outlines, clicks, keyboard reading, and a summary; SVG, Canvas, static SVG, and PDF; React, Vue, Svelte, and Python (with a Plotly-style `geojson`/`locations` join). Zoom and pan through the shared `interaction.zoom` and viewport (ranges of the projection's plane, `viewport` events, `setViewport`): wheel at the pointer, drag, double-click, Shift-arrow keys, plus and minus, and a toolbar; tooltips, keyboard reading, and `toSVG()` follow the view. Lasso (`brush: "lasso"`) and click selection of regions and points as rows through `rowSelection`, dimming the rest. Small multiples of maps (layers split by a facet field or repeated as a base map, every panel fitted alike and zoomed together) and maps in subplots, each with its own view. Not benchmarked against other libraries: one-off timings in Node for 200 regions of 1,000 vertices and 10,000 bubbles are ~20–30 ms for the first drawing, ~11 ms at a new size, ~2 ms to redraw after a value change, ~2 µs to find the region under the pointer; in Chrome, a pan frame of 200 regions of 1,000 vertices takes ~0.6 ms of the main thread (shapes reused, moved) and a zoom step to a new projection level ~5 ms on Canvas, ~9 ms in SVG. No base maps, globes (orthographic) or other spherical rotation, lines (routes), labels on regions, custom projections, or views synced between charts yet. | Documented. `map` series and the `geo` component over GeoJSON or SVG registered with `registerMap`, colored through `visualMap`; `scatter`, `effectScatter`, `lines`, and `heatmap` series on geo coordinates; `roam` zoom and pan, region labels and emphasis, and a `projection` of `project`/`unproject` functions (or a d3-geo projection stream). No bundled base maps. | Documented. `geoShape` in the opt-in `@tanstack/charts/geo` entry draws GeoJSON (polygons, lines, and points sized by a value) through any d3-geo projection factory fitted to the plot, including globes, with sphere and graticule layers; boundaries are the application's own GeoJSON. | No built-in maps (the `chartjs-chart-geo` plugin adds choropleth and bubble map charts). | Documented. `choropleth` and `scattergeo` traces with built-in base maps (countries, US states) and `locationmode`, or GeoJSON with `locations` and `featureidkey`; many projections (including orthographic and Albers USA), `fitbounds`, zoom and pan; tile-based maps (`choroplethmap`, `scattermap`) as well. |
| 3D charts | `point3d` scatter (series colors or a number field on a color scale), `line3d` lines (a path per series through its rows in table order, broken where a row has no value, a constant width on screen), and `surface` height fields over a grid of rows (number, time, or category x and y; irregular spacing; holes for missing values; up to 1,048,576 grid points, 250,000 on the CPU), sharing one box with x, y, and z axes (linear, log, time), a cube or a given aspect, and an orthographic (default) or perspective camera. Large charts (20,000 points, 10,000 surface cells, or 20,000 line segments, opaque, surfaces without wireframes) are drawn by WebGL with one depth test for every mark, so crossings are exact: points as sprites, lines as round-capped ribbons, cells as triangles with the CPU's flat colors and shading; nothing is uploaded while turning, and the pointer, keyboard, and description read the data. Everything else, and every export, is drawn back to front as ordinary SVG, Canvas, and PDF geometry: exactly for points and one surface with points, approximately for lines (cut over a surface's cells and sorted by depth) and for several surfaces. Drag to turn, wheel zoom (opt-in), double-click reset, Shift+arrow keys and +/− to turn and zoom, buttons for people who cannot drag, a `camera` event and `setCamera`; tooltips and keyboard reading of every point, line sample, and grid point with their values. Measured (see 3D charts below): turning a 1001 x 1001 surface (a million cells) ~0.5 ms of JavaScript, 60 frames a second turned every frame (Plotly: ~71 ms, 15 frames a second); mounting it ~0.24 s (Plotly ~0.40 s); 100,000 cells ~0.4 ms (Plotly ~12 ms; Herceg on the CPU ~89 ms); 1,000,000 points ~0.4 ms (Plotly failed to allocate); 10,000 points ~1.4 ms (Plotly ~5.0 ms). Memory at a million cells: ~33 MB of heap (16 MB of it the benchmark's rows of grid points) and 49 MB of GPU buffers; Plotly ~1.2 MB of heap (its GPU memory not measured). No meshes, parametric surfaces, isosurfaces, volumes, contours, 3D text or bars, translucent or wireframed surfaces on the GPU, color-scaled lines, or specular lighting; GPU edges are not antialiased; labels stay horizontal; flat shading only. | Documented. ECharts-GL (a separate package): `scatter3D`, `bar3D`, `line3D` (polylines through points, with width and color by value), `lines3D`, `surface` (including parametric surfaces from equations or sampled grids, with wireframes), `polygons3D`, `map3D`, and `globe`, all in WebGL with realistic shading, post effects, and antialiasing; mouse orbit, zoom, and pan; no SVG or vector export of 3D scenes; not measured here (its compatibility with ECharts 6 was not checked). | Not implemented. | Not implemented (no 3D chart types). | Documented. `scatter3d` (markers, lines with width and color scales, and text), `surface` (with contours and lighting, including parametric x and y from 2D arrays), `mesh3d` (vertices and triangle indices, or a Delaunay or alpha-shape triangulation, colored per vertex or face), `cone`, `streamtube`, `isosurface`, and `volume`, all WebGL (gl3d), with orbit, turntable, zoom, and pan modes and camera relayout; no SVG or vector PDF of 3D scenes (static export rasterizes them). Measured below: as fast as Herceg's GPU path at 100,000 cells turned every frame, slower at a million. |
| Data preparation | Derived tables in the spec and in TypeScript (`derive`) and Python (`hg.derive`): filter and calculate with portable expressions, bin, aggregate (count, sum, mean, median, quantiles, min, max, stdev, variance, distinct, first, last), rolling windows, sort. Computed in the browser over typed columns and kept current as the source streams (incrementally for row-by-row steps): ~15 ms to filter and calculate 1M rows, ~9 ms to aggregate them by 20 groups, ~10 µs to follow a 100-row append (`npm run bench:core`). Row pivots (`herceg/pivot`): a view's rows as a crosstab whose long table of observed combinations charts read (see Data grid). No joins or calendar bins yet. | Documented. `dataset.transform` with filter, sort, and registered external transforms (ecStat for regression and clustering). | Data is prepared by the application. | Data is prepared by the application. | Documented. Plotly.js `transforms` (filter, groupby, aggregate, sort) are deprecated; Plotly Express prepares data in pandas. |
| Data grid | `herceg/grid`: a DOM grid over a row view that mounts only the rows and columns in view, sorts by header clicks (several keys with Shift) through the view, and selects rows into a selection store other views can read; it follows the WAI grid pattern (one tab stop, a focused cell kept mounted while scrolled away, polite announcements) and takes the charts' themes. Nested groups (a level per grouping field) from `groupRows`, whose aggregate tables (count, sum, mean, min, max at every level, a parent's from its rows, never from its groups' means; updated incrementally as rows are appended and as a rolling window drops them) charts draw too: header rows with aggregates at every level, expansion by key path, each level's groups sorted among their siblings by key or aggregate and rows within their group, group selection of every row below into the same row set with mixed checkboxes, and the WAI tree grid pattern with levels. Columns resize and move by dragging headers (previewed once a frame, Escape to cancel), by keys on a focused header, or from a column menu that also pins them left or right, hides them, and shows hidden ones; the layout is the model's column list, which applications can save and restore. Pinned columns stick to the edges in the same row elements (one row of cells in visual order for screen readers), and scroll with the others in grids too narrow to hold them. ~30 KiB gzip with the data layer it needs, ~37 KiB with row groups (one-off single-bundle measurement), none of it in a chart's bundle. Measured against TanStack Table with TanStack Virtual, AG Grid Community, and Glide Data Grid (see [Grids](#grids)): over 100k rows by 20 fields, mounting from the table's typed columns takes ~3 ms (TanStack ~84 ms and AG Grid ~76 ms with the conversion to row objects they need, Glide ~1.7 ms), sorting by a number ~16 ms to the correct frame (TanStack and AG Grid ~80 ms), and the mounted grid keeps ~2 MB of heap without copying the data (TanStack ~54 MB and AG Grid ~27 MB on top of ~62 MB of row objects); it keeps up with 1,000-row appends at 10 Hz under a sort at every size, and mounts 1M x 100 fields, where the tabs of TanStack and AG Grid crash. Weaker than Glide's canvas on scroll steps (~2.5–5 ms against ~1 ms), and than plain typed-array code on filtering at 100k rows and on sorted appends at 1M rows. Grouping 1M rows by a category (five aggregates, sums compensated with error bounds) ~16–21 ms against ~35–50 ms for a derived table's aggregate (which also copies filtered columns), and following a 1,000-row append ~0.1 ms (one-off Node measurements); over 100k rows by 20 fields in one to three levels (100 or 1,000 last-level groups, uniform or skewed), a 100-row append and a grouped grid's frame of model work take ~0.05–0.11 ms collapsed and ~0.16–0.2 ms expanded (~0.5 ms when each change listed the groups' rows again; ~0.22 against ~3.3 ms at 1M rows), and in a rolling window of 100k rows (batches of 500 through two turnovers) ~0.12–0.4 ms at the median and ~0.4–0.8 ms at the 99th percentile, where computing the groups again took ~2.5–6 ms (~0.2 against ~55 ms at 1M rows), ~1.2 ms for a sorted and filtered view (~3.9 ms before), and ~0.75 ms for minimums and maximums of a rising field, which leave with every batch (~2.8 ms before), keeping 8 bytes per row for each aggregated field; with nearly unique keys, whose groups vanish with every batch, ~13 ms collapsed (~38 ms before) and no faster fully expanded (~36 ms) (interleaved Node A/B runs). With two columns pinned left and one right, 100k x 20 and 1M x 100 grids scrolled to their middle mount the same 588 cells as without pins; a scroll step of ten rows takes ~1.0 and ~1.1 ms including style and layout either way, a step of one column across ~0.6 and ~0.95 ms (without pins ~0.65 and ~0.95–1.0 ms, against ~0.64 and ~0.94 ms before column layout existed), and a resize preview frame ~0.6 ms, writing no cell's text. Row pivots (`herceg/pivot`, shown by `herceg/grid/pivot`): one rows field by one pivot field with count, sum, mean, min, and max, as row groups by the two fields (a long table of observed combinations, a table of rows with their totals, and a dense or sparse index between them, absent combinations told from missing values); generated columns named by stable ids that layout, focus, and sorting follow as values stream in, values heading their aggregates in a second header row (`aria-colspan`), row selection of the source rows; limits on generated columns, combinations, and estimated bytes (1,024, 1M, 128 MiB by default), refused before the groups grow, never by dropping values. ~40 ms to pivot 1M rows by 100 row keys (as long as grouping them), ~0.7–1.3 ms to follow a 1,000-row append, and ~44 KiB gzip for a pivot grid (~20 KiB the pivot alone); `herceg/grid` grows ~400 B for it (one-off Node measurements, see [Grids](#grids)). Remote grids (`herceg/grid/remote`): a portable query of filters, sorts, and groups with aggregates that the source runs where the data lives, blocks of typed columns from one snapshot loaded as they scroll into view (placeholders marked busy, failures shown and announced), focus and selection by key or condition, an in-memory reference source, and conformance fixtures for servers; over ten million synthetic rows they show rows after a jump as soon as AG Grid's infinite row model does and, asking for the block ahead, kept every frame loaded while scrolling at 1,000 rows a second where AG Grid's showed placeholders in 96% of frames at 100 ms latency (see [Remote grids](#remote-grids)); AG Grid's server-side row model, which groups and pivots on the server, is Enterprise, and TanStack Table's manual pagination and Glide's async cells leave fetching and caching to the application. ~30 KiB gzip for a remote grid; `herceg/grid` grows ~400 B for the model code it shares (and for fixes of its own to commands that listeners interrupt). No column groups but a pivot's values, several pivot fields, subtotals, sizing to content, remote pivots, or editing yet; grouping, pivots, and column layout are not compared. | Documented. No data grid; the toolbox's `dataView` shows (and lets users edit) the chart's data as text. | No data grid; TanStack Table and TanStack Virtual are separate libraries, compared in [Grids](#grids). | No data grid. | Documented. `table` trace with cell values, formats, fills, and column order; no sorting or selection documented. |
| Interaction | Wheel zoom and drag pan along x, y, or both; brushing along x or y, by rectangle, or by lasso (selections, or drag-to-zoom along zoomed axes); crosshair labels on the axes (`tooltip.axisLabels`); keyboard navigation with Shift-arrow range selection along the axis it steps along (rectangles and lassos are pointer-only); synced cursors, zoom, and selections (as data values: synced charts need the same category order; charts whose panels have x scales of their own sync cursors only); and `viewport` (x and both y ranges, once per change), `select`, `hover`, and `click` events (also React props, Vue events, and Svelte callback props, and Python widget callbacks with the same payloads); hovered and clicked points name their mark and the row of its table (none for bins, groups, and other points summarizing rows). Tooltips write values with axes' `format` or tooltip-only `tooltipFormat`, show more of the row with marks' `tooltip.fields` (portable, in specs and Python; read by events and the keyboard too), and take content of the application's own with `renderTooltip` (text or a node, React, Vue, and Svelte content in the adapters) inside the built-in box. Linked selections: charts bound to a channel of a selection store (`rowSelection`) write the rows their brushes (as conditions on the marks' fields, which rows streamed in later meet), lassos, clicks, and Space on the keyboard cursor select (a histogram bin's rows by its edges, a box plot's group), and highlight the rows the channel holds, whoever selected them, so charts and grids sharing a channel show one selection; points, bars, lines, areas, map regions and points, tree nodes, and network nodes and links dim the rest (other marks draw every row), and `select`, `click`, and `rowSelection` events, adapter props, and Python widget and Streamlit callbacks carry the rows. One-off measurement (Chrome, JavaScript per frame, 1,000 rows streamed into a 100,000-row window, interleaved): highlighting a live condition that leaves ~15,000 runs of selected rows takes WebGL points from ~0.3 to ~0.8 ms and a line from ~0.2 to ~1.7 ms (lines cost per run: one run adds ~0.15 ms). A range navigator under the plot (see Financial charts). Maps, treemaps and sunbursts, and networks take the same options: `interaction.zoom` pans and zooms maps' and networks' planes (reported as viewports) and drills into trees (`drill` events), `brush: "lasso"` lassos maps and networks, `interaction.drag` moves networks' nodes (`itemMove` events), and `rowSelection` selects regions, points, tree nodes' rows, and network nodes and links, each with keyboard equivalents (lassos aside, which are pointer-only) and a toolbar of named buttons; 3D charts turn as before. Layout controls and item-change notifications load through the optional item runtime; the ordinary line entry adds 50 B gzip over the version before layout interaction, with its public methods and behavior retained. Brushing, linked selections, the navigator, and these controls are not benchmarked against other libraries yet. | Documented. `dataZoom` (inside, slider), brush component (rectangle, polygon, x or y ranges) whose `brushLink` links selected items across series of one chart and whose `outOfBrush` styles the items outside it, and an event API (`click`, `datazoom`, `brushSelected`, ...). | Not verified here. | Documented. `onClick`/`onHover` callbacks; zoom, pan, and drag-to-zoom through `chartjs-plugin-zoom`; no selection of data. | Documented. Zoom, pan, box and lasso selection with `selected`/`unselected` styles and `selectedpoints` per trace, and events (`plotly_click`, `plotly_hover`, `plotly_selected`, `plotly_relayout`); linking charts is the application's (in Python, Dash callbacks). |
| Animation | Opt-in (`animation`): the axes move to a view asked for (`setViewport`, zooming to a brush, double-click reset) over 250 ms by default, eased without overshoot, in log space on log axes; tooltips follow the moving axes. With `values: true`, marks move to changed values (in-place updates and resets) and axes whose automatic domains change move with them: each frame interpolates the domains and plans ticks and grid lines for the domain between, and draws marks through those scales, so a value that stays moves only with its axis. Unstacked bars (by category or position, through their base when values change sign), pie slices (sharing boundaries, opening and closing as categories come and go), points (by row or by an explicit `animationKey` across reordered resets, using finite numbers or category labels; missing or duplicate keys show that series at once; with encoded size, color, and opacity; growing from and shrinking to nothing as rows start and stop being drawn; keyed replacements animate in notebook widgets and JavaScript apps, while Streamlit remounts when data changes and shows points at once), lines and areas whose x positions stay and which level of detail leaves whole (stack layers and band edges together, monotone curves curved again each frame through the values between), and horizontal and vertical rules. A change shows at once when the plot or categories change, when a mark that cannot move (stacked or labeled bars, text, heatmaps, custom marks, a line whose x changed, unkeyed points across a reset) shares a moving axis, and for appends and drops, frequent changes, more than 2,000 bars, slices, and rules, 10,000 points including exits across all series, or 10,000 line points, clouds, and inspected charts (pointer and keyboard read the new values first). Wheel zoom, panning, resizes, and export show at once; charts with several panels, linked charts, and pages preferring reduced motion do not animate, nor do charts whose frames would take over 10 ms of JavaScript, alone or together (a heuristic from earlier frames). No entrance animations or general path morphing. Frame costs measured outside the benchmark suite (Chrome): about 0.2 to 0.7 ms of JavaScript a frame for up to 2,000 bars, 0.2 to 0.6 ms for 1,000 points and 0.5 to 0.6 ms for 10,000, 0.2 ms for a 2,000-point line. | Documented. On by default: entrance animations, transitions of updated values (`animationDurationUpdate`, 500 ms, `animationEasingUpdate`, `cubicInOut`), and `universalTransition` morphing between series; series of more than `animationThreshold` (2,000) items do not animate. Checked in Chrome (one-off, ECharts 6.1, SVG renderer): when new values grow the y axis, the new tick set shows at once and labels the two axes share slide to their new places. | Not verified here. | Documented. On by default (1,000 ms, `easeOutQuart`): data updates animate per property (`animations`), with modes for show, hide, active, and resize (`transitions`); `animation: false` turns it off. Checked in Chrome (one-off, Chart.js 4.5.1): when new values grow the y axis, the axis takes its new ticks at once and bars move from their old pixels to their new ones over the second, so a bar part way does not read on the axis shown. | Documented. Off by default: `Plotly.animate` with frames and a `transition` (duration, easing) for data and layout, and `layout.transition` for `Plotly.react` updates. |
| Composition | Line, area, bar, point, heatmap, rug, error bar, and rule marks share scales, axes, tooltip, and legend in one chart; bars are vertical or horizontal, and lines and areas run along x or y (`orient`), over number, time, or category axes (a line through a bar chart's months, dodged beside grouped bars). Rugs show individual numeric or time observations as short ticks fixed to a plot edge, in either orientation, with row tooltips, keyboard reading, facets, and legend toggles; their performance against competitors is not yet measured. Rule, region, and text annotations from constants or one per table row (deploy markers, incident windows, labels), with text labels hidden or moved around their points where they would overlap, farther ones with leader lines that cross no other label, point, or line. Custom marks draw shapes with the chart's scales through the same SVG, Canvas, and static renderers; over x and y fields they show series with legend entries, tooltips at their points (custom text optional), keyboard stops, facet splits, and summaries (JavaScript only; no hit testing of the drawn shapes). Bars can write their values, or shares for normalized stacks. Normalized stacks and area stream baselines resolve within each panel and reuse unchanged boundaries across redraws. Center requires nonnegative thicknesses, unlike d3's signed silhouette inputs or its separate diverging offset; composing raw values and shares on one axis requires an explicit choice of domains or a separate value axis. A second y axis on the right for marks with `axis: "right"`, in every facet panel or subplot drawing them, its scale shared or resolved per panel, row, or column (`resolve.yRight`, by default as y; subplots take their own `yRight` settings). Small multiples by a category field wrapped into rows, or a grid with a row per value of one field and a column per value of another, and subplots: panels in a grid each drawing the marks that name them. x and y are shared or resolved per panel, row, or column (facets share both by default, subplots x; each subplot's x and y may be linear, log, or time), and each x scale zooms, pans, brushes, and resets on its own. Rows and columns may be weighted (`rowHeights`, `columnWidths`). A category axis of any mark may be resolved per panel, row, or column too, each holding only the categories its panels' rows hold; stacked bars stack, heatmap cells resolve, and histograms, box plots, and violins summarize within each facet panel (histograms in bins chosen per binned axis); annotations over a table draw each row in its own row's panel (labels placed, and the panel described and announced, apart; 50 panels over 100,000 rows draw in the time one panel of them takes). Charts with categories per panel cannot be synced yet, facets with right y scales of their own do not zoom along y, and range navigators need panels that share x (one strip under all of them); no nested facets yet. Pies, treemaps, sunbursts, gauges, funnels, radars, Sankey diagrams, maps, and networks draw in each facet panel, from that panel's rows, with one legend whose toggles hide a category in every panel, or fill a subplot of their own beside panels with axes (a dashboard row of a pie beside a line), with tooltips, keyboard reading, and summaries per panel; their panels have no axes to zoom or brush. A map's layers split by the facet field or repeat (a base map), every panel fitted alike; a network's facet panels share one layout of the whole network. Trees drill, maps and networks pan, zoom, and lasso, nodes move, and rows are selected in panels as in charts of their own: facet panels share one drill root, view, and set of moved nodes (one zoom moves all of them), and each subplot has its own, addressed by `panel` and reported with `panels` (one-off Node scene timings: a drill of 12 facet panels of 10,000 leaves about 1.9 ms, a pan of one of six map subplots of 200 regions about 0.4 ms). 3D charts still have charts to themselves. Dendrograms of a precomputed linkage stand on a heatmap's category bands in subplots (`herceg.express.clustermap` computes the clustering). | Documented. Many series types in one grid, `markLine`/`markArea`, `custom` series. | Documented. Grammar of marks; strongest composition model of the group. | Documented. Mixed chart types; annotations via plugin. | Documented. Traces, layout shapes and annotations, subplots. |
| Themes | Light (the default), dark, high-contrast light and dark, each on a surface of its own, and `auto` (transparent, matching the surface the chart sits on, or `prefers-color-scheme`, and switching with it). Objects override 18 tokens: colors, font, label and title sizes, grid dash, line width, bar corner radius, tooltip surface, palette, and ramps. Colors may be CSS variables in any CSS color syntax, read from the page and re-read when its root or body element changes; static output uses the fallbacks. Categorical palettes are checked for color-blind separation between neighbors. Does not follow `forced-colors` yet; no theme gallery. | Documented. 36 bundled themes (`echarts/theme`), registered JSON themes, and an online theme builder; `setTheme` switches at runtime. Colors are canvas color strings, so the app reads CSS variables itself. | Documented. Styled through `--ts-chart-*` CSS custom properties, resolved for canvas painting; follows `prefers-color-scheme` and forced colors and re-renders when the theme changes. | Documented. Global and per-chart defaults (`Chart.defaults.color`, `borderColor`, `font`); no built-in dark or high-contrast theme; the app reads CSS variables and updates charts. | Documented. Python ships named templates (`plotly_white`, `plotly_dark`, `ggplot2`, `seaborn`, `simple_white`, ...); plotly.js takes a template object in `layout.template`. No CSS variables. |
| TypeScript | Field options are typed from the table schema: a categorical field passed as a numeric encoding is a compile error. Compile-time tests guard this. | Documented. Large option types; tree-shaken `ComposeOption` types. | Documented. Fields and callbacks inferred from row types. | Documented. Typed configuration generics. | Community `@types/plotly.js`, not first-party. |
| React | First-party `@herceg/react`: `<Chart>` with mark elements typed against the table's schema; no React element per data point, and data updates go through tables without rendering React. Measured: mounting adds up to ~0.3 ms per chart (often within noise), streaming and hover are within noise of plain herceg, each chart's React root retains ~25 KB, and the adapter adds ~0.9 KiB gzip. | Community wrappers (for example `echarts-for-react`). | First-party adapters for React and other frameworks. | Community `react-chartjs-2`. | `react-plotly.js`. |
| Vue and Svelte | First-party `@herceg/vue` and `@herceg/svelte`: `<Chart>` with mark components typed against the table's schema in templates checked by vue-tsc or svelte-check. Vue's `<Chart>` reads marks from its slot without mounting them; Svelte's mark components mount and render one empty `<template>` each. No component per data point, and data updates go through tables without Vue or Svelte. The adapters add ~1.3 KiB (Vue) and ~1.5 KiB (Svelte, with the entry's compiled component) gzip; their runtime cost is not measured yet. | Community `vue-echarts`; Svelte wrappers not verified here. | First-party Vue and Svelte adapters (`@tanstack/charts/vue`, `@tanstack/charts/svelte`). | Community `vue-chartjs`; Svelte wrappers not verified here. | No first-party Vue or Svelte component. |
| Python | First-party `herceg` package: `hg.line(df, x=..., y=...)` one-liners and a chainable `hg.Chart` for pandas, Polars, PyArrow, and NumPy data. Columns travel as binary buffers (no JSON number lists); output to notebooks, self-contained HTML, SVG, PNG, and PDF, and live notebook charts (see Notebooks). `herceg.streamlit.chart` shows charts in Streamlit apps (components v2, one binary payload per run) and returns the whole selection (ranges and lasso), the clicked data, with its rows, a row selection's rows or condition, tree `drill_root` paths, and manual network `item_positions` to the script (with `on_drill` and `on_item_move` reruns; positions survive style-only redraws and clear with changed network data or layout fields); `on_viewport` reports pan and zoom as an `hg.Viewport`, including networks' layout coordinates and maps' projected plane ranges. Hover is not reported there. | Community `pyecharts`; community `streamlit-echarts` for Streamlit. | None. | None. | First-class Plotly Python and Plotly Express; Streamlit's built-in `st.plotly_chart` returns point, box, and lasso selections. |
| Statistical charts | `herceg.express` (Python): Seaborn-named functions computing their statistics in NumPy (bootstrap intervals that reproduce Seaborn's for a seed, with repeated-measures units and weights, any estimator; polynomial, logistic, robust, and lowess fits; SciPy-compatible kernel densities, ECDFs, Seaborn's histogram bins, letter values, hierarchical clustering) and drawing ordinary marks: bar, point (joined by lines over the categories), and line estimates with intervals, regression and residual plots, histograms (bars, steps, or polygons; filled stacks; weights), densities and ECDFs along x or y, rugs, strip, swarm (the point mark's bounded beeswarm layout, with Seaborn's warning), box, letter-value (the core's boxen mark), and violin plots, bivariate densities as contour lines or bands at Seaborn's levels, 2D histograms, pair, joint, and cluster maps. Charts compute again from new data (`hx.recompute`, notebook widgets' `append` and `replace`), reusing unchanged groups' bootstrap results. No TypeScript counterpart of the estimation yet; see [Statistical charts](#statistical-charts). | Documented. The `ecStat` extension (regression, histogram, clustering) and dataset transforms; no Seaborn-like API. | None. | None (community plugins for box plots and others). | Documented. Plotly Express: `histogram` with marginals, `ecdf`, `box`, `violin`, `strip`, `density_heatmap` and `density_contour`, OLS and lowess `trendline`s (statsmodels), and `scatter_matrix`; figure factory dendrograms. No bootstrap intervals or clustermap. |
| Notebooks | Static display: an isolated iframe with the engine and the data embedded, so it works offline. Live charts (`chart.widget()`, on anywidget): Python appends rows (with a rolling window), replaces data, and changes options without re-sending the chart, as binary buffers over the widget's connection; brushing (ranges and lassos), zooming (x and both y axes), hovering, and clicks (with the rows under the pointer) come back as properties and callbacks, with datetimes on time axes, and a chart's row selection (`row_selection=`) reports the rows selected, by position in the data after rows streamed in and out, or a brush's condition, and takes rows or a condition from Python. Live widgets also report tree `drill_root` paths and manual network `item_positions`, with `on_drill` and `on_item_move`, Python assignments and resets, and restoration across displays; network data changes clear moves. Tested in JupyterLab 4 only; update latency through the kernel not measured. | Community `pyecharts` renders notebook HTML; no first-party widget. | None. | None. | Documented. `fig.show()` in notebooks and `go.FigureWidget` (anywidget-based since Plotly.py 6), which updates traces from Python and calls Python on click, hover, and selection. |
| Accessibility | Focusable figure with a generated data summary, arrow-key navigation announced through a live region, legend entries as toggle buttons, generated summary in static SVG `desc`; a range navigator adds its overview of the whole x range, formatted visible range, and control of every panel's shared x to the summary, refreshed at most once a second without live pan announcements (the sliders announce politely); tagged PDF with one Figure for the whole chart (including facets), title and generated summary as alternative text, decorative backgrounds/grid lines as artifacts, and document language from the supplied locale. PDF labels remain inside the Figure; no PDF/UA conformance claim or screen-reader PDF testing yet. Automated axe-core audits (WCAG 2.1 A/AA and best practices) find nothing to fix in every chart family, both renderers, facets, subplots, all four themes, static SVG, and grids, in Chrome, Firefox, and WebKit; tests check the accessibility tree each of the three engines gives screen readers (name, description read once, legend states, live announcements, grid headers, rows, and selection), but not yet tried with screen readers themselves. Firefox drops the levels of grouped grid rows (it ignores `aria-level` in grids that number their rows). The keyboard reaches every series (Up and Down between them) and walks heatmaps cell by cell. | Documented. `aria` option generates descriptions; decal patterns. | Documented. Required accessible name, keyboard focus navigation. | Canvas only; the application supplies fallback content. | Limited; no keyboard navigation of data. |
| Export | A mounted chart as it is now (size, zoom, hidden series): standalone SVG (`toSVG`), PNG (`toPNG`, drawn from the SVG in a module loaded on first use), and PDF (`renderToPDF(chart)` from `herceg/pdf`). Without a DOM, SVG (`renderToSVG`, heatmaps embedded as PNG) and tagged vector PDF without dependencies (`herceg/pdf`, about 46 KiB gzip including scene compilation and a line mark, bundled only when imported; synchronous single-chart exports also retain list handling and fitting): paths, selectable text, heatmaps as images, and a chart-level Figure alternative. `renderToPDF` and `specToPDF` (one chart/spec or a list), and Python `hg.to_pdf` / `hg.save` (one chart or a sequence), export one chart per page (`hg.save` also delegates single charts to `Chart.save` for HTML/SVG/PNG; sequences require a `.pdf` path), with A4/Letter portrait or landscape, point margins, fitted and centered vector charts clipped to their own rectangles, title/subject/language metadata with single-chart defaults preserved, visible chart locale scopes nested under English alternatives, one Document with a Figure per chart, and fonts subset once across pages; several views on one page use subplots and panel titles. Standard fonts use Windows-1252; optional supplied static TrueType fonts add subsetting and Unicode copy/search maps (about 53 KiB gzip excluding font bytes), with conservative script coverage and no complex shaping. Both font paths emit the structure tree, marked content, ParentTree, artifacts, and locale language; no PDF/UA conformance claim. Python saves SVG and PDF (same renderers, embedded V8) and PNG (resvg) without a browser. | Documented. PNG/SVG from the browser, server-side SVG strings; no built-in PDF. | Documented. Static SVG, SSR, browser raster export. | PNG via `toBase64Image`; no built-in PDF. | Documented. PNG/SVG/JPEG/WebP; Kaleido for Python, which also writes PDF. |
| Ease of use | Shortest or tied in 11 of 12 [common tasks](#common-tasks) (several series, tooltip content, annotations, synced charts, streaming, 100k points, themes, export, and a line over bars' categories take one option, mark, or call); field names checked at compile time, and runtime errors that name the field and the fix (Python helpers name themselves, with the closest option). Tooltip fields are laid out in rows, not a template of the application's own (that takes `renderTooltip`, in JavaScript), and custom marks state their baseline. | Every task through options; `connect` syncs charts in one call; misspelled fields and theme names fail silently. | Typed as strictly as Herceg; zoom windows, visible rows, rolling windows, and annotation extents are application code; no drawn titles. | Simple for standard charts; annotations and zoom need plugins, large data five settings; canvas only. | Shortest tooltips (`hovertemplate`) and Python (Plotly Express); synced charts need event plumbing. |

Network picking has a separate one-off measurement (2026-10-10, Node
22.23.3, Darwin 27, Apple M6; 2048 × 1024, labels off). It uses the actual
network geometry and picker with deterministic positions replacing the
force simulation, identical data and queries before and after, five warmup
batches and fifteen measured batches of 512 queries. Values below are
medians and p95 of batch-average milliseconds per query, not individual
pointer-event percentiles. Uniform queries over 5,000 nodes / 20,000 links
fall from 0.834 / 0.889 to 0.019 / 0.023 ms. At 50,000 / 200,000 they fall
from 0.677 / 0.776 to 0.0023 / 0.0024 ms, but 508 of 512 queries hit nodes
and avoid links. Queries in the gap between two node clusters exercise
links instead: 1.116 / 1.178 to 0.029 / 0.030 ms at 5,000 / 20,000, and
12.219 / 18.206 to 0.268 / 0.305 ms at 50,000 / 200,000. Picked-key
checksums match in every fixture. The larger size raises caps only in the
measurement bundle; supported layouts remain capped at 5,000 / 20,000.

The index has costs: first link lookup in the clustered fixture rises from
7.6 to 34.7 ms at the supported cap, and 15.3 to 228.6 ms at the synthetic
larger size. Packed candidate storage uses 4.33 and 42.89 MB respectively;
uniform fixtures use 3.46 and 33.91 MB. It is allocated lazily and retained
across selection redraws, then rebuilt after positions or the view change.
Interleaved runs of the existing 5,000 / 20,000 drag scene show about 0.6 ms
extra redraw cost in Node (roughly 5.0 to 5.6 ms), accepted for navigation
and selection support. These results compare Herceg with its previous
picker, not competitors; network interaction has not been benchmarked
against ECharts, TanStack Charts, Chart.js plugins, or Plotly compositions.
The network controls remain optional; the line entry has no added code.

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

Entries mount charts or grids, bundled for production with tree shaking
(`benchmarks/src/size/entries/`). The line entries render the same time-series
chart with a tooltip.
`herceg-react-line` renders it through `@herceg/react` and leaves React and
React DOM out, since an application using the adapter already ships them;
`herceg-vue-line` and `herceg-svelte-line` do the same through `@herceg/vue`
and `@herceg/svelte` and leave Vue and Svelte's runtime out. Sizes are what
a page loads before the chart renders: the entry chunk and every chunk it
imports statically, each compressed on its own (Herceg's scheduler is one
such chunk, shared with its lazily loaded painters); chunks reached only by
dynamic imports are listed as optional chunks: every chunk the entry could
load for some chart (WebGL points, animation, crosshair labels, map and tree
controls), not what this chart downloads, which for these entries is
nothing more until a feature that needs one is used. `herceg-grid` is not a
chart: it mounts a two-column grid (`herceg/grid`) over the same data, with
its model, row view, and selection store; no other library here has a grid
to compare it with. `herceg-bar` (bars stacked by a series field),
`herceg-area` (areas stacked by a series field), and `herceg-scatter`
(points) track what each mark adds to Herceg's bundle. `herceg-heatmap`
mounts a heatmap over a number x field and a category y field; it includes
continuous cell placement and synchronous calendar placement. These mark
entries have no counterparts among the other libraries' entries. `herceg-pivot`
pivots the same data by a field of four values (`herceg/pivot`, no DOM), and
`herceg-grid-pivot` shows that pivot in its grid (`herceg/grid/pivot`), and
`herceg-grid-remote` shows the same data as a remote grid
(`herceg/grid/remote`) over a source answering from the page's arrays.

The PDF size entries also measure one buffered portable spec
(`herceg-spec-pdf`) and a two-chart A4 report (`herceg-pdf-document`). On
2026-10-14 (Herceg 0.0.0, Apple M6, Darwin 27.0.0, Node 22.23.3, esbuild
0.28.2, the production splitting/compression method above), unified PDF
exports measure 46,830 B gzip for the line PDF (+815 B against the single-page
implementation on `main` at `38452a4c`), 54,378 B with embedded-font support
(+793 B, excluding font bytes), 228,709 B for the new buffered-spec entry,
and 46,862 B for the new report entry. Normal tree shaking retains fitting
and list handling at single-chart call sites in this implementation. This is
an intentional cost for a consistent export vocabulary.
The ordinary line entry remains 46,737 B gzip, and every existing non-PDF
entry is unchanged. These PDF entry workloads have no equivalent export
entry for competitors; the figures establish bundle cost, not a comparative
performance win. The generated table below remains its dated baseline.

The ordinary time-line entry retains category-position and y-orientation
support because the same `line()` accepts these options at runtime, and
`table()` infers categories from string arrays. Swarm placement and point-view
copying for independent panel bands or time breaks are excluded from its
initial bundle; the placement providers carry the synchronous copying path.

<!-- results:size -->
| Entry | Version | Minified KiB | Gzip KiB | Brotli KiB | Required CSS, gzip KiB | Optional chunks, gzip KiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| chartjs-auto | 4.5.1 | 246.8 | 79.9 | 69.3 | - | - |
| chartjs-line | 4.5.1 | 196.4 | 63.7 | 56.0 | - | - |
| echarts-full | 6.1.0 | 1107.9 | 370.5 | 302.3 | - | - |
| echarts-line | 6.1.0 | 490.7 | 166.8 | 142.7 | - | - |
| herceg-area | 0.0.0 (9729117e) | 147.3 | 55.0 | 49.0 | - | 34.7 |
| herceg-bar | 0.0.0 (9729117e) | 136.4 | 51.6 | 45.9 | - | 34.7 |
| herceg-contour | 0.0.0 (9729117e) | 134.8 | 51.3 | 45.8 | - | 31.7 |
| herceg-grid-pivot | 0.0.0 (9729117e) | 132.0 | 44.8 | 40.1 | - | - |
| herceg-grid-remote | 0.0.0 (9729117e) | 88.1 | 30.5 | 27.4 | - | - |
| herceg-grid | 0.0.0 (9729117e) | 88.9 | 30.9 | 27.8 | - | - |
| herceg-heatmap | 0.0.0 (9729117e) | 137.9 | 52.5 | 46.7 | - | 31.7 |
| herceg-line | 0.0.0 (9729117e) | 121.2 | 45.6 | 40.8 | - | 34.7 |
| herceg-pdf-document | 0.0.0 (9729117e) | 117.3 | 45.8 | 40.9 | - | 2.9 |
| herceg-pdf-fonts | 0.0.0 (9729117e) | 136.0 | 53.1 | 47.4 | - | 2.9 |
| herceg-pdf | 0.0.0 (9729117e) | 117.3 | 45.8 | 40.9 | - | 2.9 |
| herceg-pivot | 0.0.0 (9729117e) | 60.3 | 20.1 | 18.3 | - | - |
| herceg-react-line | 0.0.0 (9729117e) | 124.5 | 47.0 | 42.1 | - | 34.7 |
| herceg-scatter | 0.0.0 (9729117e) | 142.5 | 54.1 | 48.1 | - | 34.7 |
| herceg-spec-pdf | 0.0.0 (9729117e) | 642.7 | 240.6 | 198.9 | - | 2.9 |
| herceg-svelte-line | 0.0.0 (9729117e) | 125.8 | 47.5 | 42.5 | - | 34.7 |
| herceg-vue-line | 0.0.0 (9729117e) | 125.3 | 47.3 | 42.3 | - | 34.7 |
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

## 3D charts

Mounting a 3D chart, and turning its camera through a sequence of angles
(steps of 7 degrees around, tilting between 10 and 50 degrees above the
floor), each to the end of the next frame, in a run of these scenarios alone
(`npm run bench -- --lib herceg,herceg-cpu,plotly --scenario ... --out results/three.json`).
Both libraries project orthographically with a cube box, points 7 px across
of one color, and surfaces colored by height and shaded (their defaults).
Plotly draws every 3D chart with WebGL (gl3d) and turns it through
`relayout` of `scene.camera.eye`. Herceg draws on the GPU (WebGL) from
20,000 points or 10,000 surface cells (a 200 x 200 surface and up), and
below that on a canvas (SVG for small surfaces); `herceg-cpu` is Herceg with
WebGL2 unavailable, so every chart is drawn on the CPU, the baseline its GPU
path is measured against (it refuses surfaces over 250,000 grid points).
`rotate` timings end with the next frame's script, so they leave out the
GPU's own work, for Plotly as for Herceg; `orbit` turns the camera a step
every frame with the display's refresh on (60 Hz) and reports the intervals
between frames, which include it. Memory is the retained heap after
mounting (Herceg's benchmark adapter expands the grid into a row per grid
point, 16 MB at a million cells); GPU buffers are not in it (Herceg's are 49
MB at a million cells). ECharts (through ECharts-GL) is not included.

<!-- results:three -->
- Date: 2026-10-09, commit 62d339e (uncommitted changes)
- Machine: Apple M6, 12 cores, 32 GB, Darwin 27.0.0
- Browser: Chrome 154.0.8037.99 through Playwright 1.63.0 (installed Google Chrome), GPU ANGLE (Apple, ANGLE Metal Renderer: Apple M6, Unspecified Version), headed, idle frames every 18.2 ms
- Viewport 1280x1400, device pixel ratio 2
- Libraries: herceg 0.0.0 (62d339e), herceg-cpu 0.0.0 (62d339e), plotly 4.1.2
- Renderers (normal / large config): herceg: auto (svg below 4,000 drawn points, canvas above; 3D charts on WebGL from 20,000 points or 10,000 surface cells) / auto; herceg-cpu: auto without WebGL2 (svg below 4,000 drawn points, canvas above) / auto without WebGL2; plotly: svg / webgl (scattergl)

| Scenario (ms, median ± MAD) | herceg | herceg-cpu | plotly |
| --- | ---: | ---: | ---: |
| scatter3d-10k-init (10,000 points in 3D) | 2.63 ± 0.27 | 2.98 ± 0.24 | 35.7 ± 1.51 |
| surface-100-init (100 x 100 grid surface) | 11.6 ± 1.02 | 11.3 ± 0.62 | 40.2 ± 3.11 |
| surface-317-init (317 x 317 grid surface (99,856 cells)) | 25.3 ± 2.55 | 110 ± 4.76 | 72.6 ± 1.44 |
| surface-1001-init (1001 x 1001 grid surface (1,000,000 cells)) | 241 ± 18.2 | error | 395 ± 11.1 |

| Scenario (ms, median ± MAD) | herceg | herceg-cpu | plotly |
| --- | ---: | ---: | ---: |
| rotate-scatter3d-10k (10,000 points in 3D) | 1.37 ± 0.11 | 1.50 ± 0.18 | 5.01 ± 0.17 |
| rotate-scatter3d-100k (100,000 points in 3D) | 0.36 ± 0.05 | 14.1 ± 2.37 | 10.7 ± 0.33 |
| rotate-scatter3d-1m (1,000,000 points in 3D) | 0.43 ± 0.07 | 198 ± 8.53 | error |
| rotate-surface-50 (50 x 50 grid surface) | 2.59 ± 0.24 | 2.57 ± 0.27 | 4.50 ± 0.32 |
| rotate-surface-200 (200 x 200 grid surface) | 0.36 ± 0.06 | 28.4 ± 1.66 | 6.80 ± 0.32 |
| rotate-surface-317 (317 x 317 grid surface (99,856 cells)) | 0.42 ± 0.08 | 88.5 ± 2.92 | 11.8 ± 0.51 |
| rotate-surface-1001 (1001 x 1001 grid surface (1,000,000 cells)) | 0.45 ± 0.10 | error | 70.7 ± 2.04 |

| Frame interval (ms, median) | herceg | herceg-cpu | plotly |
| --- | ---: | ---: | ---: |
| orbit-surface-317 (317 x 317 grid surface (99,856 cells), turned every frame) | 16.7 (p95 17.7), 0 of 60 late | 67.6 (p95 84.2), 60 of 60 late | 16.7 (p95 17.7), 0 of 60 late |
| orbit-surface-1001 (1001 x 1001 grid surface (1,000,000 cells), turned every frame) | 16.7 (p95 17.7), 0 of 60 late | error | 66.7 (p95 68.5), 60 of 60 late |

| Scenario | herceg | herceg-cpu | plotly |
| --- | ---: | ---: | ---: |
| memory-surface-1001 (1001 x 1001 grid surface (1,000,000 cells); source 8.0 MB) | 33 MB heap, 5.1 MB canvas, 85 nodes | error | 1.2 MB heap, 4.6 MB canvas, 78 nodes |
<!-- /results:three -->

## Grids

Herceg's grid (`herceg/grid`, and the same grid through
`@herceg/react/grid`) against TanStack Table 9 with TanStack Virtual, AG Grid
Community 36, and Glide Data Grid 6, from `npm run bench:grid` (methodology:
`benchmarks/README.md`, "Grids"). Every grid shows the same seeded table (16
number, 2 time, and 2 category fields per 20, with missing values, ties, and
duplicated rows) in 1200 x 600 pixels with 28 px rows, a 32 px header,
120 px columns, and the same cell text. A timing ends at the first frame
whose rows, cells, selection, and row count match an independent reference,
read just before the frame paints; a grid that never shows the right result
is reported incorrect, not timed. Latency scenarios start from an idle page
with the frame rate limit off; scroll traces and streaming run with vsync.

Read these with the configurations in mind:

- TanStack Table and AG Grid take row objects, so "from the columns" includes
  converting the shared typed columns into them; "from native input" starts
  from objects already made. Herceg reads the columns in place and Glide
  through `getCellContent`.
- Glide has no row model. Its sort and filter rows measure Glide drawing the
  result of adapter code (a typed-array index sort and scan), labeled
  external; they are not Glide's own processing. Glide draws on a canvas, and
  what it shows is read from what it reports drawing, not from pixels. The
  suite uses its 6.0.4 prerelease, the first to support React 19.
- AG Grid Community has no set filter, so category membership goes through
  its external filter; sorting uses a comparator that keeps missing values
  last, with delta sorting for transactions.
- Grouping, pivots, a grid linked to a chart, keyboard and screen reader
  behavior, and bundle sizes are not compared here.

<!-- results:grid -->
- Date: 2026-10-09, commit ec8716b (uncommitted changes)
- Machine: Apple M6, 12 cores, 32 GB, Darwin 27.0.0
- Browser: Chrome 154.0.8037.99, GPU ANGLE (Apple, ANGLE Metal Renderer: Apple M6, Unspecified Version), headed, viewport 1280x720, device pixel ratio 1
- Libraries: herceg 0.0.0 (ec8716b); herceg-react 0.0.0 (ec8716b) (react 19.3.0, react-dom 19.3.0); tanstack-table 9.2.8 (@tanstack/react-virtual 3.14.13, react 19.3.0, react-dom 19.3.0); ag-grid 36.2.0; glide 6.0.4-alpha24 (react 19.3.0, react-dom 19.3.0)
- herceg: DOM rows and cells (10 rows and 2 columns of overscan); sort native (row view); filter native (row view, expression)
- herceg-react: DOM rows and cells, mounted through @herceg/react/grid (React 19); sort native (row view); filter native (row view, expression)
- tanstack-table: DOM table, React 19 (TanStack Virtual rows with 10 overscan, columns with 3); sort native (sorted row model); filter native (filtered row model)
- ag-grid: DOM rows and cells (rowBuffer 10, column virtualization), Quartz theme; sort native (comparator keeping missing values last, delta sort); filter native number filter; external filter for category membership
- glide: Canvas 2D, React 19 (pixel scrolling, no row markers); sort external: adapter code (typed-array index sort, merge on append); filter external: adapter code (typed-array scan)

| Mount (ms, median ± MAD) | herceg | herceg-react | tanstack-table | ag-grid | glide |
| --- | ---: | ---: | ---: | ---: | ---: |
| 10k x 20: from native input | 3.11 ± 0.13 | 3.29 ± 0.24 | 7.23 ± 0.44 | 12.5 ± 0.44 | 1.81 ± 0.20 (3 frames) |
| 10k x 20: from the columns, conversion included | 3.18 ± 0.19 | 3.28 ± 0.27 | 10.4 ± 0.58 | 15.9 ± 0.58 | 1.91 ± 0.18 |
| 10k x 20: conversion alone | 0.07 ± 0.01 | 0.07 ± 0.01 | 3.19 ± 0.12 | 3.26 ± 0.11 | 0.00 ± 0.00 |
| 10k x 20: destroy | 0.62 ± 0.02 | 0.57 ± 0.04 | 0.64 ± 0.05 | 1.15 ± 0.03 | 0.14 ± 0.03 |
| 100k x 20: from native input | 3.07 ± 0.18 | 3.28 ± 0.19 | 44.3 ± 0.70 | 36.5 ± 0.59 | 1.99 ± 0.14 (3 frames) |
| 100k x 20: from the columns, conversion included | 3.16 ± 0.14 | 3.38 ± 0.11 | 83.7 ± 1.49 | 75.7 ± 0.43 | 2.03 ± 0.21 |
| 100k x 20: conversion alone | 0.15 ± 0.03 | 0.16 ± 0.03 | 40.6 ± 0.66 | 39.7 ± 0.30 | 0.00 ± 0.00 |
| 100k x 20: destroy | 0.60 ± 0.05 | 0.57 ± 0.06 | 0.34 ± 0.01 | 1.15 ± 0.05 | 0.17 ± 0.03 |
| 1M x 20: from native input | 3.18 ± 0.07 | 3.33 ± 0.07 | 481 ± 44.5 | 309 ± 0.08 | 2.43 ± 0.17 (3 frames) |
| 1M x 20: from the columns, conversion included | 5.51 ± 0.15 | 4.39 ± 0.07 | 1313 ± 133 | 719 ± 4.88 | 2.36 ± 0.45 |
| 1M x 20: conversion alone | 1.26 ± 0.00 | 0.85 ± 0.00 | 724 ± 3.52 | 412 ± 5.57 | 0.00 ± 0.00 |
| 1M x 20: destroy | 0.55 ± 0.00 | 0.57 ± 0.00 | 0.64 ± 0.04 | 1.22 ± 0.03 | 0.15 ± 0.02 |
| 1M x 100: from native input | 3.12 ± 0.19 | 3.47 ± 0.19 | error [1] | error [2] | 2.22 ± 0.29 (3 frames) |
| 1M x 100: from the columns, conversion included | 7.30 ± 0.19 | 7.37 ± 0.29 | error [1] | error [2] | 2.35 ± 0.33 |
| 1M x 100: conversion alone | 4.13 ± 0.06 | 4.06 ± 0.03 | error [1] | error [2] | 0.01 ± 0.00 |
| 1M x 100: destroy | 0.54 ± 0.04 | 0.55 ± 0.07 | error [1] | error [2] | 0.15 ± 0.02 |

| Scroll a step to its correct frame (ms) | herceg | herceg-react | tanstack-table | ag-grid | glide |
| --- | ---: | ---: | ---: | ---: | ---: |
| 10k x 20: a screen down | 3.18 ± 0.36 | 3.20 ± 0.34 | 4.55 ± 0.51 | 4.72 ± 0.51 | 0.82 ± 0.11 (2 frames) |
| 10k x 20: three columns across | 2.89 ± 0.81 | 2.79 ± 0.92 | 2.82 ± 0.40 | 2.86 ± 0.34 | 0.74 ± 0.15 (2 frames) |
| 10k x 20: both | 4.82 ± 0.42 | 4.50 ± 0.49 | 6.20 ± 0.93 | 6.22 ± 0.90 | 0.91 ± 0.16 (2 frames) |
| 10k x 20: to the last row and back | 2.63 ± 0.37 | 2.89 ± 0.14 | 4.84 ± 0.99 | 5.71 ± 1.10 | 0.74 ± 0.12 (2 frames) |
| 100k x 20: a screen down | 4.20 ± 0.34 | 3.19 ± 0.29 | 3.88 ± 0.24 | 4.09 ± 0.30 | 0.80 ± 0.14 (2 frames) |
| 100k x 20: three columns across | 3.29 ± 0.73 | 2.45 ± 0.85 | 2.44 ± 0.24 | 2.51 ± 0.27 | 0.71 ± 0.14 (2 frames) |
| 100k x 20: both | 5.23 ± 0.65 | 4.22 ± 0.45 | 7.61 ± 0.80 | 5.63 ± 0.29 | 1.06 ± 0.11 (2 frames) |
| 100k x 20: to the last row and back | 2.51 ± 0.29 | 2.85 ± 0.14 | 3.77 ± 0.27 | 5.38 ± 0.44 | 0.83 ± 0.19 (2 frames) |
| 1M x 20: a screen down | 3.60 ± 0.27 | 3.68 ± 0.33 | 3.54 ± 0.24 | 5.44 ± 0.27 | 1.03 ± 0.12 (2 frames) |
| 1M x 20: to the last row and back | 2.84 ± 0.15 | 2.47 ± 0.24 | 3.92 ± 0.39 | 6.84 ± 0.20 | 1.04 ± 0.18 (2 frames) |
| 1M x 100: a screen down | 3.73 ± 0.53 | 2.78 ± 0.05 | error [3] | error [4] | 1.16 ± 0.17 (2 frames) |
| 1M x 100: to the last row and back | 2.61 ± 0.12 | 2.27 ± 0.23 | error [5] | error [6] | 0.99 ± 0.15 (2 frames) |

| Continuous scrolling for 3 s with vsync (frame interval p50 / p95 / p99 ms; dropped frames; incomplete frames) | herceg | herceg-react | tanstack-table | ag-grid | glide |
| --- | ---: | ---: | ---: | ---: | ---: |
| 10k x 20: down, offset set every frame | 16.7 / 17.6 / 18.2; 0 dropped; 0 of 180.5 incomplete | 16.7 / 17.6 / 18.6; 0 dropped; 0 of 180.5 incomplete | 16.7 / 17.9 / 18.5; 0 dropped; 0 of 180.5 incomplete | 16.7 / 17.8 / 18.4; 0 dropped; 0 of 181 incomplete | 16.7 / 17.9 / 18.6; 0 dropped; 179.5 of 180.5 incomplete |
| 10k x 20: down and across, offset set every frame | 16.7 / 17.6 / 18.0; 0 dropped; 0 of 181 incomplete | 16.7 / 17.6 / 18.4; 0 dropped; 0 of 180 incomplete | 16.7 / 17.7 / 18.3; 0 dropped; 0 of 180.5 incomplete | 16.7 / 18.1 / 18.5; 0 dropped; 0 of 180.5 incomplete | 16.7 / 17.9 / 18.4; 0 dropped; 180 of 181 incomplete |
| 10k x 20: down, browser wheel events | 16.7 / 18.0 / 18.5; 0 dropped; 0 of 180.5 incomplete; 169 wheel events, 8.4k px | 16.7 / 17.8 / 18.6; 0 dropped; 0 of 180 incomplete; 167.5 wheel events, 8.4k px | 16.7 / 18.0 / 18.4; 0 dropped; 0 of 180.5 incomplete; 171 wheel events, 8.6k px | 16.7 / 18.4 / 33.3; 5 dropped; 0 of 177 incomplete; 159.5 wheel events, 8.5k px | 16.7 / 17.7 / 18.5; 0 dropped; 116 of 180 incomplete; 170.5 wheel events, 8.5k px |
| 100k x 20: down, offset set every frame | 16.7 / 17.6 / 18.2; 0 dropped; 0 of 180.5 incomplete | 16.7 / 17.6 / 18.4; 0 dropped; 0 of 180 incomplete | 16.7 / 17.9 / 18.4; 0 dropped; 0 of 180 incomplete | 16.7 / 18.1 / 18.5; 0 dropped; 0 of 180.5 incomplete | 16.7 / 17.9 / 18.5; 0 dropped; 180 of 181 incomplete |
| 100k x 20: down and across, offset set every frame | 16.7 / 17.6 / 18.0; 0 dropped; 0 of 180.5 incomplete | 16.7 / 17.6 / 18.1; 0 dropped; 0 of 180 incomplete | 16.7 / 17.6 / 18.4; 0 dropped; 0 of 180 incomplete | 16.7 / 17.7 / 18.2; 0 dropped; 0 of 181 incomplete | 16.7 / 17.8 / 18.4; 0 dropped; 180 of 181 incomplete |
| 100k x 20: down, browser wheel events | 16.7 / 18.1 / 18.5; 0 dropped; 0 of 180 incomplete; 167 wheel events, 8.5k px | 16.7 / 17.8 / 18.4; 0 dropped; 0 of 180.5 incomplete; 170.5 wheel events, 8.6k px | 16.7 / 18.0 / 18.5; 0 dropped; 0 of 181 incomplete; 172 wheel events, 8.6k px | 16.7 / 18.2 / 32.4; 4 dropped; 0 of 177 incomplete; 158.5 wheel events, 8.5k px | 16.7 / 17.9 / 18.5; 0 dropped; 119 of 180.5 incomplete; 173.5 wheel events, 8.7k px |

| Sort and filter to the correct frame (ms; time inside the call) | herceg | herceg-react | tanstack-table | ag-grid | glide |
| --- | ---: | ---: | ---: | ---: | ---: |
| 10k x 20: sort a number ascending | 3.77 ± 0.18; 0.04 in call | 3.70 ± 0.13; 0.04 in call | 9.15 ± 0.17; 6.51 in call | 9.98 ± 0.28; 7.25 in call | 2.65 ± 0.13; 2.37 in call |
| 10k x 20: sort a number descending | 3.63 ± 0.08; 0.04 in call | 3.85 ± 0.18; 0.04 in call | 9.23 ± 0.23; 6.55 in call | 9.97 ± 0.29; 7.22 in call | 2.53 ± 0.12; 2.26 in call |
| 10k x 20: sort by category, then number | 4.89 ± 0.18; 0.03 in call | 4.92 ± 0.17; 0.03 in call | 12.3 ± 0.32; 9.65 in call | 12.1 ± 0.40; 9.27 in call | 3.30 ± 0.09; 3.03 in call |
| 10k x 20: number range, ~1% kept | 3.02 ± 0.15; 0.05 in call | 2.94 ± 0.08; 0.06 in call | 4.32 ± 0.17; 1.68 in call | 5.97 ± 0.26; 3.41 in call | 1.16 ± 0.13; 0.80 in call |
| 10k x 20: number range, ~50% kept | 2.91 ± 0.13; 0.05 in call | 2.95 ± 0.13; 0.06 in call | 3.74 ± 0.38; 1.89 in call | 4.68 ± 0.41; 2.87 in call | 1.11 ± 0.16; 0.80 in call |
| 10k x 20: number range, ~99% kept | 1.19 ± 0.18; 0.05 in call | 1.16 ± 0.15; 0.06 in call | 2.22 ± 0.28; 1.44 in call | 2.31 ± 0.25; 1.56 in call | 1.20 ± 0.13; 0.82 in call |
| 10k x 20: category membership, ~1% kept | 2.85 ± 0.17; 0.06 in call | 2.78 ± 0.10; 0.06 in call | 4.33 ± 0.13; 1.72 in call | 5.66 ± 0.33; 3.21 in call | 1.12 ± 0.12; 0.79 in call |
| 10k x 20: category membership, ~50% kept | 2.63 ± 0.11; 0.09 in call | 2.85 ± 0.35; 0.10 in call | 3.19 ± 0.09; 1.69 in call | 3.52 ± 0.22; 2.14 in call | 1.95 ± 0.29; 1.67 in call |
| 10k x 20: category membership, ~99% kept | 1.21 ± 0.14; 0.14 in call | 1.16 ± 0.07; 0.13 in call | 2.21 ± 0.10; 1.52 in call | 2.12 ± 0.25; 1.26 in call | 3.91 ± 0.25; 3.61 in call |
| 100k x 20: sort a number ascending | 15.5 ± 0.27; 0.04 in call | 15.7 ± 0.38; 0.04 in call | 81.3 ± 3.78; 78.6 in call | 83.2 ± 5.60; 80.5 in call | 15.2 ± 0.30; 15.0 in call |
| 100k x 20: sort a number descending | 15.5 ± 0.12; 0.03 in call | 15.5 ± 0.14; 0.04 in call | 80.9 ± 2.30; 78.2 in call | 82.8 ± 2.74; 80.1 in call | 15.1 ± 0.23; 14.8 in call |
| 100k x 20: sort by category, then number | 26.2 ± 1.14; 0.04 in call | 24.7 ± 0.35; 0.04 in call | 91.4 ± 2.09; 88.8 in call | 81.4 ± 3.47; 78.6 in call | 23.5 ± 0.23; 23.3 in call |
| 100k x 20: number range, ~1% kept | 5.41 ± 0.25; 0.05 in call | 5.25 ± 0.25; 0.06 in call | 8.53 ± 0.12; 5.94 in call | 11.7 ± 0.48; 9.03 in call | 1.11 ± 0.13; 0.80 in call |
| 100k x 20: number range, ~50% kept | 5.41 ± 0.07; 0.06 in call | 5.28 ± 0.06; 0.05 in call | 10.6 ± 0.33; 8.78 in call | 11.9 ± 0.27; 10.2 in call | 1.50 ± 0.19; 1.12 in call |
| 100k x 20: number range, ~99% kept | 3.66 ± 0.16; 0.06 in call | 3.69 ± 0.08; 0.05 in call | 9.12 ± 0.49; 8.48 in call | 9.58 ± 0.18; 8.83 in call | 1.23 ± 0.14; 0.89 in call |
| 100k x 20: category membership, ~1% kept | 4.23 ± 0.21; 0.05 in call | 4.19 ± 0.27; 0.06 in call | 9.19 ± 0.31; 6.59 in call | 11.2 ± 1.04; 8.14 in call | 1.22 ± 0.17; 0.89 in call |
| 100k x 20: category membership, ~50% kept | 4.46 ± 0.20; 0.10 in call | 4.58 ± 0.19; 0.10 in call | 12.2 ± 1.00; 10.4 in call | 10.7 ± 0.31; 9.31 in call | 2.17 ± 0.11; 1.88 in call |
| 100k x 20: category membership, ~99% kept | 2.88 ± 0.14; 0.13 in call | 3.15 ± 0.15; 0.13 in call | 9.98 ± 0.53; 9.31 in call | 8.83 ± 1.84; 7.75 in call | 4.04 ± 0.26; 3.74 in call |
| 1M x 20: sort a number descending | 163 ± 1.13; 0.05 in call | 168 ± 0.57; 0.06 in call | 1570 ± 10.2; 1567 in call | 1516 ± 17.5; 1512 in call | 175 ± 2.21; 175 in call |
| 1M x 20: number range, ~50% kept | 23.0 ± 0.41; 0.07 in call | 23.0 ± 0.74; 0.08 in call | 109 ± 2.43; 107 in call | 88.5 ± 0.07; 86.6 in call | 6.12 ± 0.78; 5.82 in call |
| 1M x 100: sort a number descending | 163 ± 1.23; 0.03 in call | 160 ± 2.25; 0.03 in call | error [7] | error [8] | 168 ± 1.18; 168 in call |
| 1M x 100: number range, ~50% kept | 23.8 ± 0.70; 0.09 in call | 25.4 ± 0.47; 0.08 in call | error [9] | error [10] | 6.24 ± 0.77; 5.88 in call |

| Select rows, sorted (ms to the correct frame) | herceg | herceg-react | tanstack-table | ag-grid | glide |
| --- | ---: | ---: | ---: | ---: | ---: |
| 10k x 20: one row | 0.79 ± 0.07 | 0.78 ± 0.06 | 1.27 ± 0.11 | 1.09 ± 0.18 | 1.00 ± 0.13 |
| 10k x 20: half the rows in display order | 1.04 ± 0.11 | 1.16 ± 0.12 | 2.29 ± 0.13 | 3.17 ± 0.27 | 0.93 ± 0.11 |
| 10k x 20: read the selection back | 0.08 ± 0.01 | 0.08 ± 0.01 | 0.41 ± 0.05 | 0.17 ± 0.01 | 0.10 ± 0.00 |
| 100k x 20: one row | 0.89 ± 0.13 | 0.83 ± 0.12 | 1.29 ± 0.11 | 1.03 ± 0.17 | 0.99 ± 0.09 |
| 100k x 20: half the rows in display order | 1.15 ± 0.18 | 1.16 ± 0.18 | 7.61 ± 0.24 | 16.5 ± 0.79 | 0.96 ± 0.09 |
| 100k x 20: read the selection back | 0.56 ± 0.02 | 0.56 ± 0.02 | 4.23 ± 0.09 | 1.95 ± 0.08 | 0.94 ± 0.02 |

| Streaming: ticks offered at 10 Hz for 5 s with vsync (tick to correct frame p50 / p95 ms, first tick; time in call; dropped frames; ticks delivered of those offered) | herceg | herceg-react | tanstack-table | ag-grid | glide |
| --- | ---: | ---: | ---: | ---: | ---: |
| 10k x 20: append 1,000 rows | 9.98 / 20.6 (first 19.8); 0.57 in call; 0 dropped; 50/50 delivered | 9.18 / 18.1 (first 16.3); 0.58 in call; 0 dropped; 50/50 delivered | 26.0 / 33.9 (first 10.3); 25.3 in call; 0 dropped; 50/50 delivered | 13.7 / 19.6 (first 17.4); 9.98 in call; 0 dropped; 50/50 delivered | 7.04 / 17.4 (first 15.1); 3.00 in call; 0 dropped; 50/50 delivered |
| 10k x 20: append 1,000 rows, sorted | 10.7 / 20.8 (first 15.6); 1.99 in call; 0 dropped; 50/50 delivered | 10.2 / 18.9 (first 17.5); 2.16 in call; 0 dropped; 50/50 delivered | 41.2 / 79.3 (first 16.6); 40.6 in call; 43.5 dropped; 50/50 delivered | 27.1 / 36.4 (first 14.2); 25.9 in call; 0.5 dropped; 50/50 delivered | 8.51 / 15.8 (first 17.0); 4.59 in call; 0 dropped; 50/50 delivered |
| 10k x 20: append 1,000, evict 1,000 | 17.3 / 28.0 (first 24.3); 0.58 in call; 0 dropped; 50/50 delivered | 17.9 / 29.4 (first 27.1); 0.61 in call; 0 dropped; 50/50 delivered | 24.1 / 28.8 (first 16.0); 20.9 in call; 0.5 dropped; 50/50 delivered | 23.1 / 27.6 (first 15.5); 19.3 in call; 0 dropped; 50/50 delivered | 7.07 / 17.2 (first 15.5); 3.29 in call; 0 dropped; 50/50 delivered |
| 10k x 20: append 1,000, evict 1,000, sorted | 13.5 / 22.0 (first 19.4); 1.11 in call; 0 dropped; 50/50 delivered | 15.8 / 26.3 (first 20.0); 1.71 in call; 0 dropped; 50/50 delivered | 24.3 / 32.0 (first 14.0); 23.2 in call; 0.5 dropped; 50/50 delivered | 24.8 / 30.4 (first 10.8); 22.4 in call; 0 dropped; 50/50 delivered | 7.04 / 17.2 (first 14.8); 4.97 in call; 0 dropped; 50/50 delivered |
| 10k x 20: change 100 rows, display field | 11.6 / 21.5 (first 16.5); 0.18 in call; 0 dropped; 50/50 delivered | 12.3 / 21.2 (first 18.5); 0.18 in call; 0 dropped; 50/50 delivered | 17.8 / 21.1 (first 18.2); 14.8 in call; 0 dropped; 50/50 delivered | 10.4 / 20.7 (first 16.0); 5.45 in call; 0 dropped; 50/50 delivered | 6.74 / 17.4 (first 14.8); 0.47 in call; 0 dropped; 50/50 delivered |
| 10k x 20: change 100 rows, sort key | 17.8 / 26.2 (first 21.3); 7.57 in call; 0 dropped; 50/50 delivered | 18.3 / 27.9 (first 22.6); 7.69 in call; 0.5 dropped; 50/50 delivered | 27.4 / 33.8 (first 16.0); 25.9 in call; 0 dropped; 50/50 delivered | 25.2 / 27.9 (first 8.90); 21.7 in call; 0.5 dropped; 50/50 delivered | 7.83 / 16.1 (first 14.2); 6.10 in call; 0 dropped; 50/50 delivered |
| 10k x 20: change 100 rows, filtered field | 17.7 / 27.0 (first 24.5); 1.84 in call; 0 dropped; 50/50 delivered | 16.3 / 28.8 (first 27.8); 1.80 in call; 0 dropped; 50/50 delivered | 23.5 / 26.7 (first 14.2); 20.5 in call; 0 dropped; 50/50 delivered | 20.6 / 22.5 (first 9.21); 16.5 in call; 0 dropped; 50/50 delivered | 7.13 / 17.1 (first 15.1); 4.90 in call; 0 dropped; 50/50 delivered |
| 100k x 20: append 1,000 rows | 10.8 / 20.2 (first 18.8); 0.58 in call; 0 dropped; 50/50 delivered | 9.37 / 19.8 (first 15.9); 0.59 in call; 0 dropped; 50/50 delivered | 45.1 / 53.4 (first 36.3); 44.6 in call; 37 dropped; 49.5/50 delivered | 21.1 / 26.0 (first 10.1); 18.9 in call; 0.5 dropped; 50/50 delivered | 7.11 / 17.6 (first 15.0); 3.12 in call; 0 dropped; 50/50 delivered |
| 100k x 20: append 1,000 rows, sorted | 10.5 / 19.4 (first 16.5); 5.89 in call; 0 dropped; 50/50 delivered | 11.3 / 20.7 (first 14.4); 6.04 in call; 0 dropped; 50/50 delivered | 178 / 216 (first 167); 177 in call; 201.5 dropped; 23/50 delivered; 84.6 ms to drain | 46.7 / 56.5 (first 35.3); 46.1 in call; 45 dropped; 50/50 delivered | 11.7 / 15.9 (first 16.4); 9.84 in call; 0 dropped; 50/50 delivered |
| 100k x 20: append 1,000, evict 1,000 | 20.2 / 28.8 (first 20.6); 0.66 in call; 0 dropped; 50/50 delivered | 19.0 / 28.3 (first 24.4); 0.67 in call; 0 dropped; 50/50 delivered | 38.9 / 42.5 (first 39.2); 37.6 in call; 23 dropped; 50/50 delivered | 26.8 / 33.5 (first 13.3); 24.6 in call; 1 dropped; 50/50 delivered | 6.97 / 17.4 (first 14.8); 3.52 in call; 0 dropped; 50/50 delivered |
| 100k x 20: append 1,000, evict 1,000, sorted | 10.7 / 20.3 (first 14.7); 5.23 in call; 0 dropped; 50/50 delivered | 9.69 / 19.9 (first 16.2); 5.25 in call; 0 dropped; 50/50 delivered | 155 / 186 (first 164); 154 in call; 182.5 dropped; 25/50 delivered | 38.4 / 43.1 (first 38.1); 37.8 in call; 19.5 dropped; 50/50 delivered | 17.5 / 18.9 (first 14.2); 16.3 in call; 0 dropped; 50/50 delivered |
| 100k x 20: change 100 rows, display field | 10.7 / 21.7 (first 18.7); 0.18 in call; 0 dropped; 50/50 delivered | 10.7 / 21.0 (first 19.4); 0.19 in call; 0 dropped; 50/50 delivered | 34.6 / 38.5 (first 35.9); 33.9 in call; 9 dropped; 50/50 delivered | 22.3 / 27.6 (first 15.6); 19.6 in call; 0 dropped; 50/50 delivered | 6.99 / 17.4 (first 14.7); 0.47 in call; 0 dropped; 50/50 delivered |
| 100k x 20: change 100 rows, sort key | 29.3 / 33.5 (first 19.0); 26.5 in call; 1 dropped; 50/50 delivered | 29.3 / 32.7 (first 18.5); 26.5 in call; 0 dropped; 50/50 delivered | 161 / 171 (first 161); 160 in call; 179 dropped; 25/50 delivered | 38.6 / 42.9 (first 37.8); 37.6 in call; 18 dropped; 50/50 delivered | 22.6 / 23.9 (first 15.4); 21.6 in call; 0 dropped; 50/50 delivered |
| 100k x 20: change 100 rows, filtered field | 21.4 / 23.7 (first 18.9); 12.7 in call; 0 dropped; 50/50 delivered | 21.3 / 25.0 (first 19.3); 12.8 in call; 0 dropped; 50/50 delivered | 42.4 / 49.2 (first 46.8); 41.6 in call; 34 dropped; 50/50 delivered | 28.6 / 34.2 (first 13.3); 27.3 in call; 1 dropped; 50/50 delivered | 15.8 / 17.2 (first 16.6); 14.5 in call; 0 dropped; 50/50 delivered |
| 1M x 20: append 1,000 rows, sorted | 28.7 / 34.2 (first 18.0); 28.2 in call; 0 dropped; 50/50 delivered | 29.2 / 34.9 (first 18.6); 28.6 in call; 4 dropped; 50/50 delivered | 2672 / 2672 (first 2628); 2670 in call; 314 dropped; 2/50 delivered; 385 ms to drain | 542 / 549 (first 516); 541 in call; 273 dropped; 9/50 delivered; 358 ms to drain | 28.4 / 35.8 (first 19.9); 28.0 in call; 3 dropped; 50/50 delivered |
| 1M x 100: append 1,000 rows, sorted | 29.3 / 33.1 (first 55.1); 28.7 in call; 2 dropped; 50/50 delivered | 28.9 / 34.3 (first 59.2); 28.4 in call; 2 dropped; 50/50 delivered | error [11] | error [12] | 28.4 / 34.0 (first 59.7); 28.0 in call; 1 dropped; 50/50 delivered |

| Memory with the grid mounted (retained heap, and growth of the reserved heap while mounting; native input; DOM nodes; canvas) | herceg | herceg-react | tanstack-table | ag-grid | glide |
| --- | ---: | ---: | ---: | ---: | ---: |
| 10k x 20: mounted | 2.2 MB (reserved +4.3); input 0.0 MB; 461 nodes | 2.3 MB (reserved +4.3); input 0.0 MB; 462 nodes | 8.5 MB (reserved +18); input 6.2 MB; 500 nodes | 7.8 MB (reserved +16); input 6.2 MB; 744 nodes | 1.5 MB (reserved +3.1); input 0.0 MB; 12 nodes; canvas 3.0 MB |
| 100k x 20: mounted | 2.2 MB (reserved +4.5); input 0.0 MB; 461 nodes | 2.3 MB (reserved +4.5); input 0.0 MB; 462 nodes | 54 MB (reserved +108); input 62 MB; 500 nodes | 27 MB (reserved +59); input 62 MB; 744 nodes | 1.5 MB (reserved +3.1); input 0.0 MB; 12 nodes; canvas 3.0 MB |
| 1M x 20: mounted | 2.2 MB (reserved +4.3); input 0.0 MB; 461 nodes | 2.3 MB (reserved +4.5); input 0.0 MB; 462 nodes | 515 MB (reserved +788); input 621 MB; 500 nodes | 224 MB (reserved +300); input 621 MB; 744 nodes | 1.5 MB (reserved +3.6); input 0.0 MB; 17 nodes; canvas 3.0 MB |
| 1M x 100: mounted | 2.3 MB (reserved +4.5); input 0.1 MB; 461 nodes | 2.3 MB (reserved +4.8); input 0.1 MB; 462 nodes | error [13] | error [14] | 1.5 MB (reserved +3.1); input 0.0 MB; 17 nodes; canvas 3.0 MB |

| Heap kept 1 s after destroying the grid (after one mount / after five more); growth per further mount; kept after releasing the data too | herceg | herceg-react | tanstack-table | ag-grid | glide |
| --- | ---: | ---: | ---: | ---: | ---: |
| 10k x 20: destroy and remount | 0.9 / 0.9 MB; 0.0 MB per mount; 1.1 MB after release | 0.9 / 1.2 MB; 0.0 MB per mount; 1.5 MB after release | 1.2 / 6.6 MB; 0.0 MB per mount; 13 MB after release | 2.3 / 2.6 MB; 0.1 MB per mount; 3.2 MB after release | 1.8 / 2.1 MB; 0.0 MB per mount; 3.9 MB after release |
| 100k x 20: destroy and remount | 0.9 / 0.9 MB; 0.0 MB per mount; 1.1 MB after release | 0.9 / 1.2 MB; 0.0 MB per mount; 1.5 MB after release | 1.2 / 51 MB; 0.0 MB per mount; 113 MB after release | 2.3 / 2.6 MB; 0.1 MB per mount; 3.2 MB after release | 2.2 / 2.1 MB; 0.0 MB per mount; 18 MB after release |
| 1M x 20: destroy and remount | 0.9 / 0.9 MB; 0.0 MB per mount; 1.1 MB after release | 0.9 / 1.2 MB; 0.0 MB per mount; 1.2 MB after release | 1.2 / 493 MB; 0.0 MB per mount; 1115 MB after release | 2.3 / 2.6 MB; 0.1 MB per mount; 3.2 MB after release | 5.8 / 2.1 MB; 0.0 MB per mount; 154 MB after release |
| 1M x 100: destroy and remount | 0.9 / 0.9 MB; 0.0 MB per mount; 1.1 MB after release | 0.9 / 1.2 MB; 0.0 MB per mount; 1.6 MB after release | error [13] | error [14] | 5.8 / 2.2 MB; 0.0 MB per mount; 762 MB after release |

1. tanstack-table, grid-1m-wide-mount: page.evaluate: Target crashed 
2. ag-grid, grid-1m-wide-mount: page.evaluate: Target crashed 
3. tanstack-table, grid-1m-wide-scroll-vertical: page.evaluate: Target crashed 
4. ag-grid, grid-1m-wide-scroll-vertical: page.evaluate: Target crashed 
5. tanstack-table, grid-1m-wide-scroll-end: page.evaluate: Target crashed 
6. ag-grid, grid-1m-wide-scroll-end: page.evaluate: Target crashed 
7. tanstack-table, grid-1m-wide-sort-number-desc: page.evaluate: Target crashed 
8. ag-grid, grid-1m-wide-sort-number-desc: page.evaluate: Target crashed 
9. tanstack-table, grid-1m-wide-filter-range-50: page.evaluate: Target crashed 
10. ag-grid, grid-1m-wide-filter-range-50: page.evaluate: Target crashed 
11. tanstack-table, grid-1m-wide-append-sorted: page.evaluate: Target crashed 
12. ag-grid, grid-1m-wide-append-sorted: page.evaluate: Target crashed 
13. tanstack-table, grid-1m-wide-memory: page.evaluate: Target crashed 
14. ag-grid, grid-1m-wide-memory: page.evaluate: Target crashed 
<!-- /results:grid -->

### Pivots

Of the grids compared, only AG Grid pivots, and only in its Enterprise
edition (the `PivotModule`; AG Grid Community, measured here, has none);
it can stop generating columns past `pivotMaxGeneratedColumns`, with no
limit by default. TanStack Table groups and aggregates rows but has no
pivot, and Glide Data Grid has no row model. Of the chart libraries, none
has a grid that pivots (Plotly's `table` trace shows given cells). So no
pivot is benchmarked against another library; Herceg's measurements are
its own, in Node:

| Pivot of 1M rows, 3 aggregates | Row keys × values | Combinations | Build | Kept |
| --- | ---: | ---: | ---: | ---: |
| Dense, 100 row keys | 100 × 10 | 1,000 | ~40 ms | ~4 MiB |
| Dense, 100 row keys | 100 × 100 | 10,000 | ~43 ms | ~6 MiB |
| Sparse, two values per row key | 100,000 × 100 | ~200,000 | ~0.16–0.28 s | ~73 MiB |

Grouping the same rows by the same two fields takes as long within the
variance; the index is at most ~5 ms of it. The source holds ~23 MiB. A
1,000-row append, with the view and groups following it, takes ~0.7–1.3 ms
into existing combinations of 100,000 rows, ~2–3 ms when it adds
combinations to a sparse index of 70,000–80,000 (built again), and up to
~6.6 ms in a rolling window whose groups vanish with every batch; a pivot
grid's frame of model work after one is ~0.1–0.4 ms over 100 rows and
~1.9 ms over 10,000 rows sorted by a generated column (one-off Node
measurements, Apple M6, other work on the machine). With 1,000 values of
three aggregates a pivot passes the default limit of 1,024 generated
columns, and is refused.

### Remote grids

Over data that lives elsewhere, AG Grid has two row models: the infinite
row model (Community: blocks of rows loaded by a datasource as they scroll
into view, `cacheBlockSize`, `maxBlocksInCache`, `blockLoadDebounceMillis`,
`maxConcurrentDatasourceRequests`, and an unknown row count until the last
block) and the server-side row model (Enterprise: grouping, aggregation,
pivoting, sorting, and filtering passed to the server in `getRows`
requests, child blocks loaded under each expanded group, transactions and
refreshes, and selection of all rows matching kept on the server's terms).
TanStack Table leaves remote data to the application: `manualPagination`,
`manualSorting`, and `manualFiltering` with a `pageCount` hand the state to
code that fetches pages, and infinite scrolling is built from TanStack
Virtual and a fetching library. Glide Data Grid draws whatever
`getCellContent` returns, including loading cells, and its examples page
data in on demand (an async data source hook kept by the application),
with no cache or query of its own. Herceg's remote grid
(`herceg/grid/remote`) sends a portable query (filter, sort, groups with
aggregates) and asks for blocks of typed columns from one snapshot, with
grouped results as windows of siblings under a key path; focus and
selection follow keys or conditions; conformance fixtures say what a
server must answer.

`npm run bench:grid-remote` (methodology: `benchmarks/README.md`, "Remote
grids") compares Herceg with AG Grid's infinite row model, set to the same
block size, requests, and cache, over a synthetic source of ten million
rows computed in the page (so the page's memory is the grid's), each answer
after 0, 20, or 100 ms:

| Median over 40 jumps or 3 traces | Herceg 0 ms | 20 ms | 100 ms | AG Grid 0 ms | 20 ms | 100 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Jump to every row in view loaded, ms | 62 | 87 | 169 | 59 | 79 | 165 |
| The same with `settleDelay` 0, ms | 2.5 | 36.5 | 119.7 | 5.5 | 39.0 | 122.3 |
| Requests per jump | 2 | 2 | 2 | 1 | 1 | 1 |
| Requests per second, 100 rows/s | 0.5 | 0.5 | 0.5 | 0.5 | 0.5 | 0.5 |
| Requests per second, 1,000 rows/s | 7.5 | 7.5 | 7.5 | 7.5 | 7.4 | 7.5 |
| Frames with rows not loaded, 1,000 rows/s | 0% | 0% | 0% | 30% | 42% | 96% |
| The same with `settleDelay` 0 | 0% | 0% | 0% | 0% | 6% | 68% |

- 2026-10-10, commit 1be4640 (uncommitted changes); Apple M6, 12 cores, 32 GB, Darwin 27.0.0; Chrome 154.0.8037.99, headless, viewport 1280x720; herceg 0.0.0 (1be4640), ag-grid-community 36.2.0; raw results in `benchmarks/results/grid-remote.json`.
- Memory, after mounting and jumping to 50 places: Herceg retains 1.1 MiB of heap (46 KiB of it the blocks cached, 188 DOM nodes), AG Grid 3.2 MiB (300 DOM nodes); destroyed and mounted again, each round leaves a median of 34 KiB (Herceg) and 94 KiB (AG Grid), within the run-to-run swing of a few hundred KiB.

Herceg and AG Grid take the same time to show rows after a jump: the
latency and the 50 ms both wait for scrolling to settle (with `settleDelay` 0,
~2.5 ms against ~5.5 ms at 0 ms latency, and the latency plus about a frame
otherwise). They make the same requests a second while scrolling. Scrolling
fast, Herceg asks for the block ahead before it comes into view, so no
frame showed rows still loading at 1,000 rows a second even at 100 ms,
where AG Grid, which asks for the blocks of the rows it renders, showed
placeholders in 96% of frames (68% without its debounce, which delays every
block it loads); on a jump that block costs Herceg a second request, where
AG Grid makes one. Ten million rows cost either grid about what one screen
of them does: Herceg holds 46 KiB of rows in its cache and ~1.1 MiB of heap
in all, AG Grid ~3.2 MiB. Grouped queries, focus restoration, and selections
are not compared (AG Grid's server-side model, which has them, is
Enterprise).

### What the grid results show

- **Data held twice.** TanStack Table and AG Grid need one object per row: at
  100k x 20 converting the columns takes ~40 ms and ~62 MB, and at 1M x 20
  ~0.4–0.9 s and ~620 MB. With the grid mounted they keep ~54 MB (TanStack)
  and ~27 MB (AG Grid) more at 100k rows, ~0.5 GB and ~0.2 GB at 1M. At
  1M x 100 their tabs crash. Herceg (its table adopts the typed columns) and
  Glide (reading them through a callback) mount every size in ~2–3 ms from
  their native input and keep ~2 MB; from the shared columns Herceg takes
  ~4–7 ms at 1M rows, where building its table checks every category code.
- **Sorting and filtering.** Herceg sorts 100k rows by a number in ~16 ms to
  the correct frame and 1M in ~0.16–0.17 s, against ~80 ms and ~1.5–2.2 s
  for TanStack Table and AG Grid, whose comparators read row objects. Glide over
  a plain typed-array sort is as fast as Herceg; over a plain typed-array
  scan it filters faster unless nearly every row passes (~1–2 ms at 100k
  against ~3–5 ms for Herceg's filter expressions, ~6–7 ms against
  ~23–29 ms at 1M). TanStack and AG Grid filter 100k rows in ~9–12 ms.
  Since this table, comparisons of a number field with a constant read its
  array directly and category membership tests codes: in an interleaved
  A/B run after it (other work on the machine), a range filter took ~6 ms
  to the correct frame at 1M rows instead of ~23 ms, as Glide's adapter
  does, and ~3.4 ms at 100k instead of ~5.3 ms.
- **Streaming.** Under a sort, Herceg merges appended rows into its view: a
  1,000-row append at 10 Hz shows in ~10 ms at 100k rows (mostly the wait
  for the next frame), with every tick delivered at every size. AG Grid's
  delta sort takes ~47 ms per tick at 100k and gets 7 of 50 ticks through at
  1M; TanStack Table re-sorts every row on each change, ~180 ms per tick at
  100k, and receives about half the ticks (2 of 50 at 1M). Changing the sort
  key of 100 rows cost Herceg ~14–27 ms per tick at 100k in these runs,
  when its view rebuilt the order after any change to a sort key, against
  ~4–22 ms for Glide's adapter, which moves only the changed rows (both
  varied this much between runs; AG Grid ~38 ms, TanStack Table
  ~160–175 ms). The view now moves only the changed rows too: in an
  interleaved A/B run of these scenarios after the table above (other work
  on the machine), 100 changed sort keys at 100k took ~4 ms in the call
  instead of ~25 ms and ~16 ms to the correct frame instead of ~28 ms, and
  100 changed filtered values ~1.2 ms instead of ~13 ms. At 1M rows the per-tick cost of sorted appends alternates
  between ~6–10 ms and ~25–35 ms for Herceg and Glide's adapter alike, so
  medians there differ from run to run. Rolling windows cost Herceg ~8–20 ms
  per tick at 100k, also varying between runs, with up to ~9 dropped frames
  in five seconds; Glide stays at ~6 ms.
- **Scrolling.** Every DOM grid shows a scroll step in its first frame:
  ~2.5–5 ms for Herceg, ~2.5–7.5 ms for TanStack Table and AG Grid (about
  the same for all three on horizontal steps, AG Grid slowest at 1M rows).
  Glide redraws its canvas in ~1 ms but in a React update after the frame
  the scroll happened in, so its content trails the scroll position by a
  frame: in three seconds of wheel scrolling about two frames in three
  showed content for an earlier offset, against none for the DOM grids. No
  grid dropped more than a frame or two scrolling at display rate.
- **Selection.** Selecting half of 100k sorted rows takes ~1 ms in Herceg
  and Glide (a row set, or one range), ~8 ms in TanStack Table (an object of
  ids), and ~17 ms in AG Grid.
- **React.** Herceg through `@herceg/react/grid` measures like the plain
  grid (data, sorting, and scrolling bypass React), apart from the
  run-to-run variance in streaming noted above.
- **After destroying.** A second after being destroyed, Herceg and AG Grid
  have released their grids. TanStack Table keeps its last table, with its
  row objects, reachable until another is created (~50 MB at 100k), and
  Glide the last data it drew from.

## WebKit

The same suite in WebKit, the engine of Safari, through Playwright's WebKit
build (`npm run bench -- --browser webkit --headless`; not Safari itself, and
headless, since headed windows behind others get throttled frames). WebKit cannot
produce frames faster than the display, so every timing below is the latency
from the operation to the next frame, including the wait for it: operations
start wherever in a frame they are issued (pointer moves from the event), and
differences smaller than a frame (the idle cadence below) are noise. Compare
libraries within these tables, not with the Chrome tables above, which
disable the frame rate limit. Memory is not measured (it needs Chrome's
DevTools protocol), nor are long frames.

Firefox runs with `npm run bench -- --browser firefox` (latency scenarios with
`layout.frame_rate` 0, paced ingestion and orbit at the default frame rate in
a separate process), but no Firefox results are committed yet: they need an
otherwise idle machine (`--out results/browser-firefox.json`, default samples
and warmups). Firefox has neither `performance.memory` nor Chrome's heap
measurement, so memory scenarios are omitted (the JSON's `method.memory` says
why), and it reports no long animation frames, so ingestion results omit
`longFrames`.

<!-- results:webkit -->
- Date: 2026-10-09, commit 6eca6ef (uncommitted changes)
- Machine: Apple M6, 12 cores, 32 GB, Darwin 27.0.0
- Browser: WebKit 26.6 through Playwright 1.63.0 (webkit revision 2359), GPU Apple GPU, headless, idle frames every 16.7 ms
- Viewport 1280x1400, device pixel ratio 2
- Libraries: herceg 0.0.0 (6eca6ef), echarts 6.1.0, chartjs 4.5.1, plotly 4.1.2, tanstack 1.0.0, uplot 1.6.32
- Renderers (normal / large config): herceg: auto (svg below 4,000 drawn points, canvas above) / auto; echarts: canvas / canvas (sampling: minmax, large: true); chartjs: canvas / canvas (parsing: false, min-max decimation); plotly: svg / webgl (scattergl); tanstack: svg / canvas (mountCanvasChart); uplot: canvas / canvas

| Scenario (ms, median ± MAD) | herceg | echarts | chartjs | plotly | tanstack | uplot |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| line-small-init (4 series x 200 points) | 16.8 ± 0.33 | 15.4 ± 0.77 | 14.4 ± 0.86 | 16.9 ± 0.62 | 16.7 ± 0.50 | 17.1 ± 0.50 |
| line-medium-init (10 series x 5,000 points) | 16.9 ± 0.73 | 15.2 ± 0.53 | 16.6 ± 0.72 | 30.5 ± 0.24 | 32.0 ± 1.71 | 16.7 ± 0.20 |
| line-large-init (1 series x 1,000,000 points) | 16.3 ± 0.54 | 74.5 ± 2.88 | 12.6 ± 0.42 | 325 ± 3.10 | 612 ± 45.3 | 15.8 ± 0.82 |
| area-medium-init (3 filled series x 5,000 points) | 16.8 ± 0.62 | 16.7 ± 0.88 | 15.3 ± 0.44 | 17.5 ± 0.33 | 17.2 ± 0.33 | 15.9 ± 0.87 |
| bar-small-init (12 categories x 3 series) | 17.0 ± 0.66 | 15.4 ± 0.99 | 14.9 ± 0.71 | 16.3 ± 0.73 | 16.6 ± 0.89 | n/a |
| bar-medium-init (100 categories x 4 series) | 16.4 ± 0.46 | 15.2 ± 0.48 | 15.9 ± 0.86 | 16.8 ± 0.04 | 16.0 ± 0.41 | n/a |
| scatter-medium-init (10,000 points) | 16.8 ± 0.10 | 414 ± 2.97 (first frame 18.4) | 15.6 ± 0.33 | 67.3 ± 0.87 | 30.9 ± 0.38 | n/a |
| scatter-large-init (200,000 points) | 16.5 ± 0.82 | 101 ± 17.7 (first frame 22.8) | 53.3 ± 0.62 | 45.5 ± 3.54 | 217 ± 11.2 | n/a |
| heatmap-medium-init (100 x 100 cells) | 16.5 ± 0.23 | 395 ± 13.9 (first frame 17.4) | n/a | 17.2 ± 0.40 | 41.3 ± 0.47 | n/a |
| heatmap-large-init (500 x 500 cells) | 16.8 ± 0.58 | 11104 ± 41.8 (first frame 45.3) | n/a | 105 ± 5.40 | 368 ± 26.4 | n/a |
| candlestick-small-init (200 candles, each drawn by every library) | 16.5 ± 0.41 | 16.6 ± 0.35 | n/a | 17.1 ± 0.09 | n/a | n/a |
| candlestick-large-init (100,000 candles; each library's large-data strategy) | 17.0 ± 0.26 | 198 ± 16.0 (first frame 41.3) | n/a | 839 ± 11.2 | n/a | n/a |
| bubble-medium-init (10,000 points sized and colored by two fields) | 16.8 ± 0.58 | 415 ± 0.70 (first frame 17.3) | 46.6 ± 0.45 | 84.9 ± 0.60 | n/a | n/a |
| histogram-medium-init (10,000 values in bins 5 wide from 25, x from 25 to 175) | 16.9 ± 0.19 | n/a | n/a | 16.8 ± 0.82 | n/a | n/a |
| histogram-large-init (1,000,000 values in bins 5 wide from 25, x from 25 to 175) | 16.0 ± 0.54 | n/a | n/a | 61.8 ± 1.24 | n/a | n/a |
| line-massive-init (1 series x 10,000,000 points) | 18.0 ± 1.88 | 881 ± 63.5 | 80.0 ± 4.72 | 4284 ± 177 | 14284 ± 5214 | 61.4 ± 1.18 |
| scatter-massive-init (1,000,000 points) | 16.1 ± 0.70 | 396 ± 12.7 (first frame 88.1) | 344 ± 9.16 | 163 ± 7.24 | 1086 ± 41.9 | n/a |

| Scenario (ms, median ± MAD) | herceg | echarts | chartjs | plotly | tanstack | uplot |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| line-medium-update (replace 10 x 5,000 points) | 16.9 ± 0.79 | 16.6 ± 0.85 | 16.6 ± 0.38 | 31.8 ± 0.52 | 31.6 ± 0.96 | 16.6 ± 0.87 |
| line-large-update (replace 1,000,000 points) | 16.8 ± 1.18 | 88.9 ± 3.16 | 16.6 ± 0.88 | 320 ± 18.1 | 648 ± 26.5 | 15.9 ± 1.28 |
| bar-medium-update (replace 100 x 4 bars) | 16.6 ± 0.72 | 16.7 ± 0.29 | 16.7 ± 0.51 | 16.7 ± 0.37 | 16.7 ± 0.45 | n/a |
| scatter-medium-update (replace 10,000 points) | 16.7 ± 0.28 | 417 ± 0.47 (first frame 18.6) | 16.7 ± 0.09 | 60.7 ± 0.45 | 62.7 ± 6.64 | n/a |
| heatmap-medium-update (replace 100 x 100 cells) | 16.7 ± 0.70 | 408 ± 8.23 (first frame 17.7) | n/a | 16.7 ± 0.09 | 62.4 ± 2.32 | n/a |

| Scenario (ms, median ± MAD) | herceg | echarts | chartjs | plotly | tanstack | uplot |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| stream-dashboard-chart (15 series, 3,000-point window, +1 point per tick) | 16.6 ± 0.71 | 16.7 ± 0.81 | 16.7 ± 0.25 | 28.9 ± 2.39 | 27.3 ± 2.36 | 16.6 ± 0.49 |
| stream-large (1 series, 100,000-point window, +100 points per tick) | 16.6 ± 0.83 | 16.6 ± 0.60 | 16.7 ± 0.82 | 34.8 ± 0.85 | 50.4 ± 1.23 | 16.8 ± 0.82 |
| stream-massive (1 series, 1,000,000-point window, +10,000 points per tick) | 16.6 ± 0.67 | 111 ± 2.88 | 16.7 ± 0.72 | 340 ± 5.38 | 648 ± 32.2 | 16.7 ± 0.30 |

| Scenario (frame interval p50 / p95 / p99, dropped frames, achieved ingest rate) | herceg | echarts | chartjs | plotly | tanstack | uplot |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| ingest-chart-10hz (15 series, 3,000-point window, +1 point at 10 Hz) | 16.7 / 18.3 / 19.3 ms, 0.5 dropped, 9 Hz | 16.6 / 36.1 / 43.4 ms, 50 dropped, 9 Hz | 16.7 / 29.4 / 34.8 ms, 25.5 dropped, 9 Hz | 16.6 / 39.6 / 45.7 ms, 59 dropped, 9 Hz | 16.7 / 37.9 / 42.8 ms, 53.5 dropped, 9 Hz | 16.7 / 23.7 / 28.3 ms, 12.5 dropped, 9 Hz |
| ingest-chart-60hz (15 series, 3,000-point window, +1 point at 60 Hz) | 16.7 / 17.9 / 19.3 ms, 0 dropped, 50 Hz | 16.9 / 19.9 / 21.1 ms, 0 dropped, 50 Hz | 17.0 / 20.4 / 21.4 ms, 0.5 dropped, 50 Hz | 25.4 / 29.2 / 30.4 ms, 142 dropped, 38 Hz | 25.1 / 31.1 / 37.3 ms, 107 dropped, 39 Hz | 16.7 / 19.7 / 20.9 ms, 0 dropped, 50 Hz |
| ingest-chart-100hz (15 series, 3,000-point window, +1 point at 100 Hz) | 16.7 / 18.3 / 19.2 ms, 0 dropped, 74 Hz | 15.8 / 22.6 / 24.6 ms, 1.5 dropped, 83 Hz | 16.3 / 22.0 / 23.4 ms, 0.5 dropped, 82 Hz | 25.2 / 29.3 / 30.9 ms, 117.5 dropped, 39 Hz | 24.5 / 27.9 / 31.2 ms, 70 dropped, 40 Hz | 16.4 / 21.9 / 22.9 ms, 0 dropped, 80 Hz |
| ingest-large-100hz (1 series, 100,000-point window, +10 points at 100 Hz) | 16.7 / 18.1 / 19.0 ms, 0 dropped, 79 Hz | 12.2 / 35.4 / 37.0 ms, 23.5 dropped, 82 Hz | 16.7 / 20.1 / 21.5 ms, 0 dropped, 81 Hz | 33.8 / 37.8 / 39.3 ms, 149 dropped, 29 Hz | 94.6 / 103 / 104 ms, 255 dropped, 21 Hz | 16.6 / 20.9 / 22.3 ms, 0 dropped, 82 Hz |
| ingest-dashboard-10hz (10 charts x 15 series x 3,000 points, +1 point per series at 10 Hz) | 16.7 / 34.6 / 37.8 ms, 48 dropped, 9 Hz | 16.6 / 64.8 / 68.4 ms, 123.5 dropped, 9 Hz | 16.6 / 44.4 / 48.7 ms, 69.5 dropped, 9 Hz | 235 / 250 / 255 ms, 276.5 dropped, 4 Hz | 261 / 428 / 488 ms, 286.5 dropped, 3 Hz | 16.7 / 41.7 / 46.5 ms, 62.5 dropped, 9 Hz |

| Scenario (ms, median ± MAD) | herceg | echarts | chartjs | plotly | tanstack | uplot |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| hover-line-medium (pointer moves over 10 x 5,000 points) | 5.20 ± 0.51 | 14.4 ± 1.67 | 6.99 ± 0.59 | 15.8 ± 0.45 | 14.7 ± 2.40 | 3.95 ± 0.51 |
| hover-line-large (pointer moves over 1,000,000 points) | 4.53 ± 0.46 | 7.79 ± 0.45 | 2.69 ± 0.40 | 455 ± 191 | 87.0 ± 5.35 | 3.55 ± 0.34 |
| hover-scatter-medium (pointer moves over 10,000 points) | 4.47 ± 0.40 | 23.3 ± 3.06 | 9.48 ± 0.30 | 9.36 ± 0.76 | 14.9 ± 0.81 | n/a |

| Scenario (ms, median ± MAD) | herceg | echarts | chartjs | plotly | tanstack | uplot |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| zoom-line-large (x ranges of 50%, 10%, and 1% of 1,000,000 points, panning) | 16.6 ± 1.01 | 16.7 ± 0.35 | 16.6 ± 0.75 | 16.9 ± 1.04 | 50.2 ± 40.0 | 16.5 ± 0.71 |
| zoom-line-massive (x ranges of 50%, 10%, and 1% of 10,000,000 points, panning) | 16.6 ± 0.56 | 16.0 ± 1.34 | 16.6 ± 3.10 | 19.4 ± 1.52 | 949 ± 877 | 13.2 ± 6.48 |
| zoom-scatter-massive (x ranges of 50%, 10%, and 1% of 1,000,000 points, panning) | 17.0 ± 0.68 | 99.1 ± 50.0 | 144 ± 24.5 | 16.4 ± 0.86 | 179 ± 72.9 | n/a |

| Scenario (ms, median ± MAD) | herceg | echarts | chartjs | plotly | tanstack | uplot |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| resize-line-medium (resize 800x400 <-> 600x300) | 16.6 ± 0.40 | 17.1 ± 0.94 | 16.8 ± 0.34 | 17.9 ± 1.63 | 31.2 ± 2.18 | 16.7 ± 0.73 |

| Mount all charts (ms, median ± MAD) | herceg | echarts | chartjs | plotly | tanstack | uplot |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| dashboard (10 charts x 15 series x 3,000 points) | 28.6 ± 1.40 | 58.6 ± 3.36 | 37.0 ± 2.96 | 239 ± 5.40 | 245 ± 18.4 | 26.7 ± 0.46 |

| Refresh all charts (ms, median ± MAD) | herceg | echarts | chartjs | plotly | tanstack | uplot |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| dashboard (10 charts x 15 series x 3,000 points) | 21.9 ± 1.52 | 63.0 ± 5.74 | 37.0 ± 1.18 | 240 ± 1.04 | 282 ± 26.3 | 20.1 ± 0.62 |
<!-- /results:webkit -->

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

## Statistical charts

`herceg.express` against Seaborn 0.13, function by function. Statistics were
checked against Seaborn, SciPy, and statsmodels (python/tests); charts are
herceg charts, so they are interactive, export to SVG, PNG, and PDF, and
work in notebooks and Streamlit, where Seaborn draws Matplotlib figures.

| Seaborn | herceg.express | Lacks |
| --- | --- | --- |
| `barplot`, `pointplot` | Mean, median, sum, min, max, or any function per category and series, with `("ci", level)` bootstrap intervals (Seaborn's resamples for a seed, and with `units` its structured bootstrap of repeated measures), `"pi"`, `"se"`, `"sd"`, or an interval function; weighted means (`weight`); series dodged; facets (`facet_row`, `facet_column`) with estimates per panel; `pointplot` joins its estimates with lines over the category axis (broken where a series has none), with `linestyles` or `linestyle="none"`. | Pandas aggregation names beyond the five, `"se"` about other estimators than the mean; `pointplot`'s `markers` and Seaborn's small dodge (herceg dodges as grouped bars do). |
| `lineplot` | Estimate per distinct x with bands or error bars, weighted means, or rows as they are (`estimator=None`), with `units` a line per unit; time x. | `style`, `size`. |
| `regplot`, `lmplot` | Polynomial least squares (`order`, weighted by `weight`), `logistic` and `robust` fits (statsmodels' GLM and RLM in NumPy, without statsmodels), `logx`, lowess (statsmodels' algorithm in NumPy), bootstrap bands (by rows, or `units`); `x_estimator` and `x_bins` estimates with `x_ci`; `x_partial`, `y_partial`, `fit_reg`, `truncate`; series and facets. | `x_jitter`, `y_jitter` (refused: they would move points off their values); `truncate=False` reaches the data's range, not the axes' limits. |
| `residplot` | Residuals of a polynomial or `robust` fit, with an optional lowess line; partials. | — |
| `histplot` | Seaborn's bins (`bins`, `binwidth`, `binrange`, `discrete`), `normalize` as the histogram mark's (count, frequency, probability, percent, or density), `weight` (Seaborn's `weights`, with its warning for "auto" bins), `cumulative`, `common_norm` (off by default, as in the mark), layered, stacked, filled (`multiple="fill"`), or dodged series, bars, steps, or polygons (`element`), x or y, KDE overlays on layered bars (along y over horizontal ones); bivariate histograms of x and y (Seaborn's bins per axis, counts checked against NumPy's `histogram2d`) as the 2D histogram mark. | KDE over stacked, filled, or dodged series, unfilled steps (`fill=False`); bivariate `thresh`, `pthresh`, `pmax`, `cbar`, and series. |
| `kdeplot` | 1D lines or `filled` areas, along x or (for `y` alone) along y, read by y in tooltips and the keyboard, with Scott's, Silverman's, or a given factor, `bw_adjust`, `cut`, `clip`, `common_norm` (off by default), `cumulative`, `weight`; 2D as contour lines or `filled` bands at Seaborn's `levels` and `thresh` (iso-proportions of the density's mass, resolved in NumPy and checked against Seaborn's), facets with levels shared by every panel. | `multiple`, bivariate series, per-facet levels, contour labels. |
| `ecdfplot` | `normalize` probability (Seaborn's proportion), percent, or count, complementary, `weight`, along x or y; a series of one distinct value shows as a point. | Seaborn's riser from 0 (or 1) before the first value: every point drawn is an observation's step, as tooltips and the keyboard read them. Along y, a lone value's point is read as points are, x (its share) first. |
| `rugplot` | Ticks of a length in pixels at the plot's edge, with tooltips and keyboard reading. | Height as a share of the axes. |
| `stripplot` | Jitter as the point mark's (a fraction of the band, or an `hg.Jitter`), by a hash of each row and a seed (points keep their places as data streams), dodge. | — |
| `swarmplot` | The point mark's `swarm`: each category's points packed without overlap in order of value, laid out again in the browser as the chart resizes and zooms (bounded: about 2 ms for 10,000 points in a band, 21 ms for 100,000), dodged by `series`; Seaborn's warning when more than `warn_thresh` of a category's points cannot be placed, from the same layout run in Python at the chart's size. | Exact Seaborn placement (its candidates stand 5% farther out); the warning estimates the plot's size, which a chart filling its container may not have. |
| `boxplot` | herceg's box plot mark, its outliers shown or hidden (`outliers`); `whiskers` ("tukey", "range", or an IQR multiple), notches. | Percentile whiskers. |
| `boxenplot` | herceg's boxen mark (TypeScript and every adapter too): Seaborn's letter values and depth rules (`depth` "tukey", "proportion", "trustworthy", "full", or a number), `outlier_proportion`, `trust_alpha`, `width_method` ("exponential", "linear", "area"), `outliers`; series side by side, facets. | Seaborn's lightened palette per level (herceg lightens by fill opacity); `gap`, `linecolor`. |
| `violinplot` | herceg's violin mark, series side by side or `split` into halves (a series of at most two levels), `inner` box, quartiles, or none. | Seaborn's Scott bandwidth and area normalization (violins are as wide at their densest, with Silverman's rule), `inner="stick"` and `"point"`. |
| `pairplot` | Scatter plots of every pair with histograms or densities on the diagonal, `corner`. | Shared y axes per row through the diagonal; other `kind`s. |
| `jointplot` | Scatter (or `kind="reg"`) with marginal histograms sharing its scales; `kind="kde"` (density contours, `filled`, with marginal densities) and `kind="hist"` (a 2D histogram with marginal histograms). | `kind="hex"`; series with the kde and hist kinds, marginal densities with series. |
| `clustermap` | Average (or single, complete, weighted, ward) linkage of rows and columns, z-scores or min-max scaling, dendrograms in side panels. | Row and column color annotations, masks. |
| `countplot`, `catplot`, `displot`, `relplot` | — | Not in express (`hg.bar`, `hg.histogram`, and facets cover some). |

Seaborn draws a figure of what it computed; to show new data, the plot is
drawn again. An express chart remembers its call: `hx.recompute(chart,
data)` makes it again from new data with the same arguments and seed,
reusing the bootstrap results of groups whose values did not change (a
lineplot of 1,000 timepoints given one more resamples one group), and a
notebook widget of one recomputes on `append` and `replace`, sending only
the tables that changed when its marks are the same and keeping the
displays' zoom, brush, and legend. Plotly Express charts are figures of
data too; their trendlines and marginals are computed again by calling
the function again.

Timings from `npm run bench:express` (raw samples, versions, and inputs in
`benchmarks/results/express.json`): Apple M6, Python 3.13, NumPy 2.5, SciPy
1.18, Seaborn 0.13.2, statsmodels 0.15; medians of 3 to 10 runs after a
warmup, with the peak Python memory of one more run. "Compute" times the
numerical routine alone, "chart" the express function and `to_spec()`,
"recompute" `hx.recompute` of a chart and `to_spec()`, and "SVG" static
export of a chart already built. Other work shared the machine,
so differences under about 20% are noise.

| Workload | herceg.express | Reference |
| --- | --- | --- |
| Bootstrap, 1,000 means of 100,000 values (compute) | ~210 ms, 3.1 MiB | Seaborn's `bootstrap`: ~285 ms, 2.3 MiB |
| Bootstrap, 1,000 medians of 100,000 values (compute) | ~800 ms, 4.6 MiB | Seaborn's `bootstrap`: ~890 ms, 2.3 MiB |
| Bootstrap, 1,000 means of 1,000 values in 20 units (compute) | ~11 ms | Seaborn's structured `bootstrap`: ~32 ms |
| `barplot`, 100,000 rows, 4 groups, 95% CI (chart) | ~250 ms | — |
| `lineplot`, 1,000 x values of 10 rows, 95% CI (chart; recompute after one more x value) | ~56 ms; ~4 ms | — |
| Logistic fit and 95% band, 1,000 rows, 1,000 resamples (compute) | ~165 ms | Seaborn with statsmodels' GLM: ~645 ms |
| Robust fit and 95% band, 1,000 rows, 1,000 resamples (compute) | ~320 ms | Seaborn with statsmodels' RLM: ~1.2 s |
| `pairplot`, 10,000 rows x 5 columns, series (chart; SVG) | ~32 ms; SVG ~58 ms more | — |
| `clustermap`, 500 x 50 (chart, SciPy's linkage) | ~3 ms | — |
| Average linkage, 500 x 50, the NumPy fallback (compute) | ~72 ms, 10 MiB | SciPy's `linkage`: well under ~3 ms (inside the chart time above) |
| Lowess, 10,000 rows, `delta=0` (compute; Seaborn's default) | ~0.8 s | statsmodels: ~1.2 s |
| Lowess, 10,000 rows, `delta` 1% of the x range (compute) | ~10 ms | statsmodels: ~14 ms |

Resampling a chunk of resamples at a time makes the bootstraps faster than
Seaborn's one-resample loop; chunks take about 8 MiB of arrays (or one
resample, when that is larger), as fast as the 64 MiB chunks they replaced,
so the peak memory of 1,000 resamples of 100,000 values fell from 41 MiB to
3.1 MiB (medians from 62 MiB to 4.6 MiB), near Seaborn's 2.3 MiB, and the
NumPy linkage's from 66 MiB to 10 MiB. Logistic and robust fits iterate
every resample of a chunk together, where Seaborn fits one statsmodels model
per resample. Lowess, in NumPy, computes each chunk of local fits with BLAS
dot products and is faster than statsmodels' compiled loop (it was 2.5 times
slower). A recompute reuses
the intervals of groups whose values did not change (one new x value
resamples one group of 1,001). Seaborn's own pair plots draw 20 Matplotlib
scatter plots of 10,000 points on the CPU, while herceg sends the columns
once and draws them in the browser, so the two totals are not compared.

## Common tasks

The same twelve tasks written with each library, as an experienced user of
it would write them from its documentation, over identical data
([benchmarks/src/ease](../benchmarks/src/ease), one directory per task and a
file per library, with React and Python versions where they are natural).
`benchmarks/src/ease/samples.test.tsx` mounts every TypeScript sample in Chrome
and checks what it draws (series, axes, annotations, the tooltip under the
pointer, the synced chart, the rolling window, the exported files), and
`python/tests/test_ease_samples.py` runs the Python ones, so the samples keep
working as the libraries change. The same test checks the mistakes the tables
report that happen at runtime (compile errors are checked by type-checking
the samples).

Versions: ECharts 6.1.0, TanStack Charts 1.0.0 (with d3-scale 4.0.2 for time
scales), Chart.js 4.5.1 (with chartjs-adapter-date-fns 3.0.0), Plotly.js 4.1.2
(`plotly.js-dist-min`), React 19.3.0, and Herceg at this commit. Not installed,
so not used: chartjs-plugin-annotation and chartjs-plugin-zoom, the community
React wrappers (echarts-for-react, react-chartjs-2, react-plotly.js),
pyecharts, and jsPDF. The Chart.js samples of tasks 4 and 5 therefore draw
annotations and zoom with code of their own, which an experienced user would
leave to those plugins: their line counts and concepts do not represent
Chart.js with its plugins. Plotly Python and Kaleido are not in the test environment either: the
Plotly Express samples follow Plotly's documentation and are skipped by
pytest, and the message quoted for task 11 is Plotly Express's, not run here.

How to read the tables:

- **Lines** are lines that are not blank, not comments, and not the import of
  the shared data, after formatting (biome, ruff); `node
  --experimental-strip-types benchmarks/src/ease/lines.ts` counts them.
  Imports count. The samples import whole bundles (`echarts`,
  `chart.js/auto`, `plotly.js-dist-min`); their tree-shaken setups add about
  ten lines of registration (`echarts.use([...])`, `Chart.register(...)`).
  Herceg's and TanStack's imports are tree-shaken already.
- **Concepts** are what a newcomer has to learn for the task, beyond the
  previous tasks.
- **Mistake** is one plausible error and what the library does with it, as
  observed in these samples: a type error, a runtime message, or a silently
  wrong chart.
- Every chart shows a tooltip at the nearest x, which is Herceg's default;
  the others need `tooltip: { trigger: "axis" }` (ECharts), `interaction: {
  mode: "index", intersect: false }` (Chart.js), `hovermode: "x"` with
  several series (Plotly), and `focus: "group-x"` with the `tooltip`
  extension (TanStack). TanStack Charts draws no title (the page's heading
  and the required `ariaLabel` name a chart).

Line counts favor libraries whose idioms are short to write, not those that
are easiest to get right; the concepts and mistakes columns matter more.

### 1. A basic line chart

Daily latency over 60 days with a title, a time x axis, and a y axis title.
[01-line](../benchmarks/src/ease/01-line)

| Library | Lines | Concepts | Mistake: a misspelled field (`"latncy"`) |
| --- | --- | --- | --- |
| Herceg | 9; React 10 | `table` of columns, `time()`, a mark function (`line`), `createChart` options (`title`, `y: { title }`) | Compile error; in JavaScript, `line y: no field "latncy"; the table has "time", "p50"`. |
| ECharts | 13 | `init` and `setOption`, the option object, `dataset` and `encode`, axis `type: "time"`, the tooltip component | `encode: { y: "latncy" }`: no error or warning; the series falls back to the dataset's first value column, so a typo for another column draws the wrong one. |
| TanStack Charts | 19; React 18 | `defineChart`, marks (`lineY`), scale factories (d3's `scaleUtc`, with `Date` values), `mountChart` and its required `ariaLabel`, focus strategies, the `tooltip` extension | Compile error (fields are inferred from the rows); in JavaScript, no error and no line. |
| Chart.js | 15 | a `<canvas>`, `type` with `data.labels` and `datasets`, the time scale and its date adapter, `interaction` | The sample's arrays have no field names. With object rows and `parsing: { yAxisKey: "latncy" }`, as in task 2's sample, nothing is parsed or drawn, without a warning. |
| Plotly | 12 | traces (`type`, `mode`), layout, axis `type: "date"`, `newPlot` (a promise) | It takes arrays, so the mistake is a property read that TypeScript catches. Leaving out `xaxis.type: "date"` shows epoch milliseconds as "1.77T" without a warning. |

Herceg and TanStack Charts check field names against the data's type;
ECharts and Chart.js take field names as plain strings, which a typo leaves
silently wrong. Epoch milliseconds
need saying in every library: `time()` in Herceg (a number column is a
number axis, whatever the field is named; `time()` also takes Dates and
ISO 8601 strings), `type: "time"` in ECharts and Chart.js, `type: "date"` in
Plotly, and `Date` objects in TanStack.

### 2. A multi-series chart

Three services' latency from a long table (a row per service and day), one
line per service with a legend. [02-multi-series](../benchmarks/src/ease/02-multi-series)

| Library | Lines | Concepts | Mistake: the series field holds numbers (HTTP status codes) |
| --- | --- | --- | --- |
| Herceg | 9; React 10 | `series` field | Compile error; in JavaScript, `line series: field "status" holds number values; expected category; give its values as strings, or numbers wrapped in category()`. |
| ECharts | 20 | the `legend` component; a series per group, grouped by hand (or with `dataset` filter transforms) | Works: groups are built in application code. |
| TanStack Charts | 20 | the `color` channel groups lines; `colorLegend` | Works: two lines and a legend. |
| Chart.js | 22 | a dataset per group, grouped by hand; `parsing` keys | Works. |
| Plotly | 20 | a trace per group, grouped by hand; `hovermode` | Works. |

Splitting long data is one option in Herceg and TanStack Charts; the others
make the application group the rows. Herceg is the strict one about kinds:
categories come from strings, so numeric codes need `category(codes)`.
Herceg's samples take columns; from the rows, `fromRows(serviceRows, {
types: { time: "time" } })` reads them, the epoch milliseconds as times (a
concept more).

### 3. A custom tooltip

The tooltip shows the date as "Wed, Jan 21", the value with "ms", and the
day's request count, a field that is not plotted. [03-tooltip](../benchmarks/src/ease/03-tooltip)

| Library | Lines | Concepts | Mistake |
| --- | --- | --- | --- |
| Herceg | 12; React 16 | a mark's `tooltip: { fields }` for the request count, axes' `tooltipFormat` (Intl options) for the date and the unit, the chart's `locale` and `timeZone` | A misspelled field: compile error; in JavaScript, `line tooltip.fields[0]: no field "reqeusts"; the table has "time", "p99", "requests"`. |
| ECharts | 27 | `tooltip.formatter`, its params (an array with `trigger: "axis"`), `EChartsOption` typing and casts of `params.data` | Formatters return HTML: text from data containing `<` is parsed as markup. |
| TanStack Charts | 29; React 40 | `tooltip: { use, format }` with typed rows; in React, `renderTooltipBody` from `@tanstack/charts/react/tooltip` | Passing `renderTooltipBody` to the `Chart` of `@tanstack/charts/react`: compile error (that component lacks the prop). |
| Chart.js | 33 | `plugins.tooltip.callbacks` (`title`, `label`), tooltip items (`parsed`, `dataIndex`) | Without `intersect: false`, the tooltip shows only with the pointer on a point. |
| Plotly | 17 | `hovertemplate` syntax (`%{x\|%a, %b %-d}`, d3-format), `customdata`, `<extra></extra>` | Leaving out `<extra></extra>`: a second box with the trace's name appears beside the tooltip. |

Herceg and Plotly describe the content as data, which their Python
packages and specs share: Herceg names more fields of the row
(`tooltip=hg.Tooltip(fields=["requests"])` in Python, where Plotly Express
takes `hover_data`) and formats values per axis, Plotly writes a template.
Herceg's tooltip keeps a row per series, so its layout is the built-in one
("Wed, Jan 21", then "p99 304 ms" and "requests 12,480") rather than the
sentence the other samples write; the keyboard's announcements read the
same fields. For content of its own, `renderTooltip` (JavaScript only;
React content in `@herceg/react`) draws in the built-in box, keeping its
placement and crosshair, as the other formatters do. ECharts' formatters
return HTML, TanStack's typed rows, and Chart.js's callbacks lines of text.

### 4. An annotation

A threshold rule labeled "SLO" and a labeled band over an incident window.
[04-annotation](../benchmarks/src/ease/04-annotation)

| Library | Lines | Concepts | Mistake: the band's dates as ISO strings (`"2026-01-21"`) |
| --- | --- | --- | --- |
| Herceg | 13; React 12 | `rule` and `region` marks with constant positions; mark order (regions first to shade underneath) | Compile error; in JavaScript, `region x1: "2026-01-21" names a field, and fields need a table; pass the table first, or give a number or Date`. |
| ECharts | 23 | `markLine` and `markArea` on a series, their data formats (`[{ yAxis }]`, `[[start, end]]`) | Works: ECharts parses date strings on time axes. |
| TanStack Charts | 44 | `ruleY`, `rect` with explicit y extents (rects span values, not the plot), `text` marks for labels | `TypeError: A temporal scale factory requires Date channel values`. |
| Chart.js | 40, without its plugin | a plugin of your own with canvas drawing and `scale.getPixelForValue` (chartjs-plugin-annotation, not installed, takes options instead) | `getPixelForValue` takes parsed numbers: the band is not drawn, without a warning. |
| Plotly | 37 | `layout.shapes`, `xref`/`yref` (`"paper"` spans the plot), shape `label`s | Works: Plotly takes date strings. |

Annotations are marks in Herceg, sharing the chart's scales, and count
toward the axis domains; TanStack composes them from general marks, ECharts
attaches them to a series, Plotly lays them out in paper or data coordinates,
and Chart.js has an annotation plugin. With it (documented, not run here),
the plugin of the sample becomes options, about half the lines:

```ts
import annotationPlugin from "chartjs-plugin-annotation";
Chart.register(annotationPlugin);
// options.plugins:
annotation: {
  annotations: {
    incident: { type: "box", xMin: incident.start, xMax: incident.end, label: { display: true, content: "Incident" } },
    slo: { type: "line", yMin: SLO, yMax: SLO, label: { display: true, content: "SLO" } },
  },
},
```

### 5. Two synchronized charts

Latency and request charts whose cursors and zoomed x ranges follow each
other. [05-sync](../benchmarks/src/ease/05-sync)

| Library | Lines | Concepts | Mistake: zoom turned on in only one chart |
| --- | --- | --- | --- |
| Herceg | 17; React 16 | `interaction: { zoom: "x", sync: "name" }` | The other chart still follows the zoom; it just does not zoom by its own wheel. |
| ECharts | 19 | `echarts.connect`, `dataZoom` (`type: "inside"`) | The chart without `dataZoom` does not follow, without a warning. |
| TanStack Charts | 46, partly | `createChartCursor` and `cursorHost` (`match: "x"`), `zoomX` with a `controlledSignal`, an application-owned window that rebuilds both definitions, visible rows and `clip` | Not applicable: the application applies the window to both charts. |
| Chart.js | 42, without its plugin | `onHover`, `setActiveElements` on the other chart and its tooltip, scale `min`/`max`, wheel handling by hand (chartjs-plugin-zoom is not installed) | Not applicable: all of it is application code. |
| Plotly | 40 | `plotly_relayout` and `plotly_hover` events, `Plotly.relayout` with only the x axis' keys, `Plotly.Fx.hover` (missing from @types/plotly.js), a guard against echoes | Not applicable: as for Chart.js. |

One option in Herceg, one call in ECharts, and event plumbing elsewhere
(chartjs-plugin-zoom would replace the Chart.js sample's wheel code, not its
cursor code). The TanStack sample does half the task: in TanStack Charts
1.0.0, `zoomX`'s surface takes the pointer, so over a zoomable plot the
tooltip and the shared cursor do not follow it (the samples' test checks only
the shared zoom there). Plotly charts that can share one figure are simpler
as subplots with matching x axes.

### 6. Streaming with a rolling window

A reading every 100 ms, keeping the newest 300.
[06-streaming](../benchmarks/src/ease/06-streaming)

| Library | Lines | Concepts | Mistake: changing the data without telling the chart |
| --- | --- | --- | --- |
| Herceg | 11; React 16 | a table's `maxRows`, `appendRow` (tables redraw their charts once a frame) | Tables are changed through their methods, which redraw. Writing into a typed array the table borrowed shows nothing until something else redraws. |
| ECharts | 20 | trimming by hand, `setOption` with the new data | Pushing to the array without `setOption`: the chart stays as it was. |
| TanStack Charts | 24; React 29 | trimming by hand, a new definition per change (`host.update`, or state and `useMemo` in React) | Mutating the rows without a new definition: the chart stays as it was. |
| Chart.js | 25 | trimming by hand, `chart.update()`, `animation: false` | Without `update()`: the chart stays as it was. |
| Plotly | 14 | `extendTraces` with its `maxPoints` argument | Mutating the trace's arrays: the plot stays as it was until a redraw. |

Herceg's tables and Plotly's `extendTraces` own the window; elsewhere the
application trims and resubmits data. In React, Herceg's chart never
re-renders for data, while TanStack's re-renders through React state on each
reading.

### 7. A line of 100,000 points

[07-large](../benchmarks/src/ease/07-large)

| Library | Lines | Concepts | Mistake: leaving out the large-data settings |
| --- | --- | --- | --- |
| Herceg | 8 | none new: typed arrays are used as they are, and level of detail is automatic | Nothing to leave out. |
| ECharts | 15 | `sampling: "lttb"`, `showSymbol: false` | Without them, every point is drawn, symbols too where they fit, which is slower to render and hover. |
| TanStack Charts | 20 | `mountCanvasChart`, a row object per point | The SVG host draws it too, as one path; the documented route for dense signals is an envelope the application computes. |
| Chart.js | 22 | `parsing: false` with points as `{ x, y }`, `normalized`, the `decimation` plugin, `animation: false`, `pointRadius: 0` | With defaults, every point is parsed, animated, and drawn as a dot; decimation silently does nothing while `parsing` is on, as its documentation says. |
| Plotly | 9 | `scattergl` | Plain `scatter` draws it too, since Plotly simplifies SVG line paths; `scattergl` is the documented choice for large data. |

[Initial render](#initial-render) and [Interaction](#interaction) measure
these libraries' large lines with the same settings (ECharts there samples
with `minmax`).

### 8. A custom mark

A lollipop per day: a stem from zero and a dot at the value.
[08-custom-mark](../benchmarks/src/ease/08-custom-mark)

| Library | Lines | Concepts | Mistake: forgetting that the stems start at zero |
| --- | --- | --- | --- |
| Herceg | 24 | `custom` with fields and `draw` (the scales, shape functions, `series` and `rowAt`), the mark's `zero: "y"` | Leaving out `zero: "y"`: the y axis fits the values only; stems are cut at the plot's bottom, without a warning. |
| ECharts | 31 | a `custom` series, `renderItem` with `api.coord`, `api.value`, and `api.visual`, graphic elements | Value axes include zero by default. |
| TanStack Charts | 72 | `createMark`: channels (which set the domains), `render` returning keyed scene nodes and the `ChartPoint`s the pointer, keyboard, and tooltip find, the theme's palette | Without `includeZero`, stems run out of the plot, over the axis and the page below. |
| Chart.js | 35 | dots as a scatter dataset, a plugin drawing stems from the dataset's elements, `interaction` | Without `beginAtZero`, stems run over the x axis. |
| Plotly | 22 | no custom marks: a `layout.shapes` line per row beside a marker trace, `rangemode: "tozero"`, `hovermode` | Shapes count toward autorange, so they stay in view. |

Herceg's custom mark gets tooltips, keyboard reading, the legend, and the
text alternative from its fields; ECharts' custom series takes part in the
axis tooltip through `encode`; TanStack's answers the pointer only through
the points its `render` returns, which is most of its sample's length;
Chart.js and Plotly draw beside a built-in dataset or trace, which carries
the tooltips.

### 9. A theme

The multi-series chart, dark, with a brand palette, on a light page.
[09-theme](../benchmarks/src/ease/09-theme)

| Library | Lines | Concepts | Mistake: a misspelled theme name (`"drak"`) |
| --- | --- | --- | --- |
| Herceg | 10; React 11 | `theme: { extends, palette }`; named themes paint their own background, `"auto"` the page's | Compile error; in JavaScript, `theme: no theme "drak"; use "light", "dark", "high-contrast", "high-contrast-dark", "auto"`; in Python, the spec's check refuses it when the chart is displayed or exported. |
| ECharts | 21 | a built-in theme named at `init`, `color` in the option | Draws in the default theme, without a warning. |
| TanStack Charts | 27 | `theme` tokens in the definition (or CSS variables and `color`) | No named themes. |
| Chart.js | 35 | no themes: colors per dataset, scale, and title, and a CSS background for the canvas | No named themes. |
| Plotly | 25 | `paper_bgcolor`, `plot_bgcolor`, `font`, `gridcolor`, `colorway` | `template: "plotly_dark"` (Plotly Python's) is ignored in plotly.js, without a warning; plotly.js bundles no named templates. |

Herceg's and ECharts' dark themes paint their own surfaces, so they read the
same on a light page; Herceg's `"auto"` (or `background: "transparent"`)
shows the page instead, for charts on tinted cards. Chart.js, Plotly.js,
and TanStack Charts take the colors from the application.

### 10. Export

SVG, PNG, and PDF of the basic line chart, in the browser (Python below).
[10-export](../benchmarks/src/ease/10-export)

| Library | Lines | SVG / PNG / PDF | Mistake: exporting right after creating the chart |
| --- | --- | --- | --- |
| Herceg | 16 | `chart.toSVG()` / `chart.toPNG({ scale })` (a promise of a `Blob`) / `renderToPDF(chart)` from `herceg/pdf` | No animation by default; exports render the chart's state at once. |
| ECharts | 24 | a second, SVG-renderer instance (`ssr: true`, `renderToSVGString`) / `getDataURL` / none | With animation on (the default), the PNG caught the line half drawn (a data URL of 17.7k characters instead of 29.4k). |
| TanStack Charts | 20 | `serializeChartSvg` / `renderChartImage` / none | No animation by default. |
| Chart.js | 16 | none / `toBase64Image` / none | With animation on (the default), the PNG was nearly empty (7.1k characters instead of 55.1k). |
| Plotly | 17 | `Plotly.toImage` as a data URL, decoded / `Plotly.toImage` / none in the browser | Both calls are promises; forgetting `await` gives a promise, not an image. |

Herceg is the only one with a PDF in the browser. Its three exports show the
mounted chart as it is (zoomed, with series hidden); `renderToSVG` and
`renderToPDF(options)` draw options without a DOM. Chart.js exports at its
canvas' resolution (`devicePixelRatio`); the others were asked for twice the
chart's size. In Python, a live widget has no PNG of what it shows: a cell
cannot wait for the browser's reply, so `chart.save` draws the chart as
Python built it. Python saves all three by file
extension (`chart.save("latency.png")`, 5 lines), as Plotly Python does
through Kaleido (`fig.write_image`, 5 lines).

### 11. A Python notebook chart

Task 2's chart from a pandas DataFrame in a notebook cell.
[11-notebook](../benchmarks/src/ease/11-notebook)

| Library | Lines | Concepts | Mistake: a misspelled column |
| --- | --- | --- | --- |
| Herceg | 10 | `hg.line(df, x=, y=, series=, title=, y_axis=hg.Axis(title=))`; the chart displays itself | `KeyError: "line y: no column 'latncy'; the data has 'time', 'service', 'latency'"` when the chart is built. |
| Plotly Express | 10 | `px.line(df, x=, y=, color=, title=, labels=)`; the figure displays itself | `ValueError: Value of 'y' is not the name of a column in 'data_frame'. Expected one of ['time', 'service', 'latency'] but received: latncy`. |

The two are alike: one call over a DataFrame, named columns, and an error
that lists the columns. Plotly Express names series `color` and relabels
axes through `labels`; Herceg names them `series`, as its TypeScript does,
and takes axes as `x_axis`/`y_axis` in one-call helpers, since `x` and `y`
name columns. ECharts (through the community pyecharts), TanStack Charts,
and Chart.js have no Python packages.

### 12. Bars and a line over categories

Monthly revenue bars with a target line over the same months.
[12-bar-line](../benchmarks/src/ease/12-bar-line)

| Library | Lines | Concepts | Mistake: the line's values in another month order than the bars' |
| --- | --- | --- | --- |
| Herceg | 9 | `bar` and `line` over one category axis | Categories match by value. |
| ECharts | 17 | a category axis, series of two types | With `xAxis.data` and value arrays, values pair by position: misaligned without a warning. |
| TanStack Charts | 21 | `barY` and `lineY` over one band scale | Categories match by value. |
| Chart.js | 20 | a mixed chart (a dataset's own `type`) | `labels` and data pair by position: misaligned without a warning. |
| Plotly | 11 | a bar trace and a scatter trace on one category axis | Categories match by value. |

### What the tasks show

- Herceg's samples are the shortest, or tied, in 11 of the 12 tasks: several
  series from long data, tooltip content, annotations, synced charts,
  streaming, 100,000 points, themes, export, and bars with a line over
  their categories each take one option, mark, or call, and field names are checked at compile time in TypeScript and
  React, with runtime messages that name the field and the fix.
- Its custom marks need a stated baseline (`zero`), as other libraries'
  axes do, and its tooltip lays fields out in rows rather than in a
  template of the application's own.
- TanStack Charts is typed as strictly, but leaves zoom windows, visible
  rows, rolling windows, and annotation extents to the application, and in
  1.0.0 its zoom control and pointer tooltips exclude each other.
- ECharts covers every task with options, but misspelled fields and theme
  names fail silently, and `setOption` checks nothing unless the option is
  annotated as `EChartsOption`.
- Chart.js leaves annotations and zoom to plugins (not measured here), and
  needs the most settings for large data; animated charts export their first
  frame.
- Plotly is the most concise for tooltips and, through Plotly Express, in
  Python, and needs event plumbing for synced charts and `type: "date"` for
  epoch milliseconds.

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
- Of the comparison libraries, only Plotly draws contours and 2D histograms
  (ECharts, TanStack Charts, and Chart.js have neither). Plotly's contours
  are further along in presentation: labels along lines, smoothing, and
  contours of 2D histograms. Herceg's trace saddles by the bilinear field
  rather than a fixed rule, fill disjoint bands with holes, read matrices
  without a coordinate per grid point, and keep what they traced, so a
  recolor or zoom only projects it; the two have not been timed against
  each other, and Herceg's exports hold every traced point.
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
- In WebKit, where every timing includes waiting for the display's next
  frame, the picture holds: Herceg shows every scenario in about one frame
  (16–18 ms; the ten-chart dashboard in ~29 ms to mount and ~22 ms to
  refresh, uPlot ~27 and ~20 ms), including 10M-point lines and 1M-point
  scatters, where ECharts, Plotly, and TanStack Charts take hundreds of
  milliseconds to seconds. Hover is within a few milliseconds for Herceg,
  uPlot, and Chart.js. Ingesting into ten charts at 10 Hz drops frames in
  every library (48 for Herceg, 62 for uPlot, 70 for Chart.js, 124 for
  ECharts, over 270 for Plotly and TanStack Charts).
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
- Grids over shared typed columns (Herceg, and Glide reading them through a
  callback) mount any size in a few milliseconds and keep ~2 MB, where
  TanStack Table and AG Grid first build ~620 MB of row objects for 1M rows
  and crash at 1M x 100. Herceg's row views sort 100k rows in ~16 ms
  against ~80 ms for their comparators over row objects, and keep sorted
  grids current under 10 Hz appends at 1M rows; plain typed-array code
  (Glide's external adapter) still filters faster than Herceg's views at
  100k rows (on par at 1M since the A/B runs noted there) and merges
  appends faster, and Glide's canvas is fastest per scroll step but shows
  content a frame behind the scroll position. See [Grids](#grids).
