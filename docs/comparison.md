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
candlestick (and OHLC bar), histogram, pie, box plot, violin, treemap, sunburst, gauge, funnel, radar, Sankey, network (graph), map (geoshape and geopoint), and 3D (point3d and surface) marks, rule, region, and text annotations, and custom marks, on time axes that can leave out breaks.
uPlot has no bar, scatter, or heatmap support comparable to the scenarios, and
Chart.js has no built-in heatmap; those cells are marked n/a.

## Summary

| Area | Herceg | ECharts | TanStack Charts | Chart.js | Plotly |
| --- | --- | --- | --- | --- | --- |
| Initial render | Measured. Fast at every size measured: ~0.7 ms for 4 x 200 line points, ~1.6 ms for 10 x 5,000, ~4.8 ms for 1M points (uPlot: ~7.0 ms), ~35 ms for 10M points (uPlot: ~46 ms). Bars ~0.7 ms for 100 x 4; scatter ~2.1 ms for 10k points on Canvas, ~3.3 ms for 200k and ~13 ms for 1M with WebGL; heatmaps ~1.3 ms for 100 x 100 and ~13 ms for 500 x 500 cells, drawn as one image. Lines are reduced to at most four points per pixel column; SVG below 4,000 drawn points or cells, Canvas above. | Measured. Canvas; fast for small charts, ~150 ms for a 1M-point line with `minmax` sampling. Scatter and heatmap series render progressively: a 500x500 heatmap shows its first frame after ~60 ms and completes after ~9 s. | Measured. Fast small SVG charts; cost grows with rows because every row becomes a scene node (~0.8 s for 1M points on Canvas). | Measured. Fast for small and medium charts; min-max decimation makes 1M points cheap once the `{x, y}` objects exist. | Measured. Slowest small charts; SVG scatter is expensive at 10k points, WebGL traces handle large data. |
| Incremental update | Measured. Tables support append, drop, range replace, and reset; charts re-render once on the next frame. Replacing 10 x 5,000 line points takes ~1.2 ms, 1M points ~3.9 ms (uPlot ~6.2 ms), 10k scatter points ~1.5 ms, 100 x 100 heatmap cells ~0.7 ms. | Measured. `setOption` re-processes the series; no rolling-window append. | Measured. Updates rebuild the definition and scene. | Measured. Mutate arrays and `update('none')`; cheap. | Measured. `extendTraces` with `maxPoints` gives a documented rolling window, but each tick costs 20–30 ms here. |
| Streaming | Measured. ~1.0 ms per tick for 15 series x 3,000 points (uPlot: ~0.9 ms); keeps up in every paced scenario, including the ten-chart dashboard at 10 Hz. A million-point rolling window takes ~1.4 ms per 10,000-point tick (uPlot: ~6.2 ms), because min/max indexes are kept current as rows arrive. Rolling windows via `maxRows`. | Measured. ~11 ms per tick for 15 series x 3,000 points; keeps up with 100 Hz ingestion for one chart but drops frames for a 10-chart dashboard at 10 Hz. | Measured. ~31 ms per tick; at 60–100 Hz ingestion only ~33 updates per second get through. | Measured. ~3.5 ms per tick; keeps up in every paced scenario. | Measured. ~20 ms per tick; ~54 updates per second at 100 Hz, ~6 Hz for the 10-chart dashboard. |
| Memory | Measured. ~0.2 MB retained for 1M points: source typed arrays are used in place and geometry buffers are bounded. Ten-chart dashboard ~7 MB (uPlot ~3 MB); 100 small charts ~8 MB and no canvas backing stores, because small charts render to SVG. | Measured. ~240 MB retained for 1M points (internal storage plus per-point structures). | Measured. ~600 MB retained for 1M points (row objects, Dates, scene nodes). | Measured. ~49 MB for 1M points (one `{x, y}` object per point). | Measured. ~110 MB for 1M points with WebGL. |
| Bundle size (line chart, gzip) | Measured. ~42 KiB for a time-series line chart with tooltip, events, and brushing (monotone curves, which line charts carry whether they use them, are ~1 KiB of it, the four built-in themes with page-following themes about 2 KiB, the dispatch to layout marks such as pies about 1 KiB, y and xy zoom, rectangle and lasso brushes, and synced selections about 1.4 KiB, and facet headers, per-panel y scales, subplot routing, and weighted rows, which the model plans for any chart, about 1.1 KiB, x scales of panels' own (planned per group for any chart, with zoom, selections, and events per scale in the browser runtime) about 1.5 KiB, categories of panels' own (band axes planned per group, and category positions and values read through each panel's band places in tooltips and keyboard reads, and the chart's bands handed to summaries) about 0.1 KiB, the hooks that start view transitions and value transitions, whose code loads separately, about 0.6 KiB, the hooks that let a map's layers share a chart and tables hold geometry columns, about 0.1 KiB, the hooks for time axis breaks (whose code comes only with `timeBreaks`) and crosshair labels (loaded on demand), about 1.2 KiB, and the camera API and the hooks that load 3D turning (`camera`, `setCamera`, the camera event, presses kept to their pointer), about 0.6 KiB; the pie, the maps, the breaks, and the 3D marks themselves are not included). Each mark brings its own drawing code, so a line chart carries no bar, point, symbol, heatmap, or text drawing, color schemes are separate exports, and facets are only bundled when used; the chart model still includes band-axis, legend-layout (series, color, size, and shape keys), horizontal-bar inspection, right-axis, and panel-layout logic, and min/max indexes for large lines add ~1 KiB. The WebGL painter for large point series (~3.5 KiB; 3D charts add their ~2.6 KiB program, a separate chunk where the build splits them), 3D turning (~2 KiB), animation of views (~1 KiB) and of values (~6.5 KiB), and crosshair labels (~1 KiB) load only when a chart needs them, and text is measured with the browser's canvas, so the static text estimator is not bundled. | Measured. ~167 KiB tree-shaken, ~371 KiB full. | Measured. ~44 KiB including `d3-scale` for time. | Measured. ~64 KiB with time scale and date adapter. | Measured. ~391 KiB basic bundle, ~1.4 MiB full. |
| Line | Line, step lines, smooth monotone curves, several y fields or a long-format series field, gaps for missing values, log and time axes, level of detail for large series. Area (stacked, band) and rule marks. | Documented. Time axes, sampling, area fill, step lines. | Documented. `lineY`/`lineX`, gaps, curves. | Documented. Line, stepped, filled; decimation plugin. | Documented. `scatter`/`scattergl` lines, rich hover. |
| Scatter | Point mark with per-series color, radius, and opacity; every point is drawn. Series of 100,000+ points use WebGL (loaded on demand): ~13 ms to mount 1M points, ~3.6 ms per zoom step, both ahead of Plotly's WebGL. Nearest-point hover through a spatial grid index (~0.5 ms per move at 10k points). Streaming clouds, whole columns or split by a series field, upload only new points (a million points in two series at 1,000 rows per tick: ~3 ms of JavaScript per frame instead of ~13 ms before). Size (bubbles), continuous color (named sequential and diverging schemes, midpoints), opacity, and eight symbol shapes by field, with size and shape keys; outlines (`stroke`, `strokeWidth`); encoded and outlined points are drawn on the CPU, not WebGL. Points on category axes (strip and dot plots, on either axis or both, over bars too), in facets and subplots with each panel's own categories; these are always drawn on the CPU. No jitter or beeswarm placement within a band yet. | Documented. `large` mode for big scatter. | Documented. `dot` mark; one scene node per point. | Documented. Scatter/bubble. | Documented. SVG and WebGL scatter. |
| Heatmap | Heatmap mark over category, number, or time fields, drawn as one image (Canvas `drawImage`, PNG inside SVG), with a color legend and cell tooltips. Named sequential and diverging schemes, fixed color domains, and midpoints. No cell limit: a grid larger than the plot is drawn at the plot's device resolution, each pixel the mean (or with `reduce`, the max or min) of its block of cells, and tooltips still report the single cell under the pointer; memory follows the table's rows and the plot's pixels, not the cell count. Measured in a one-off run outside the committed suite (headless Chrome 154, Apple M6, 800 x 400 chart at DPR 2; competitors not run at these sizes): a sparse 4,000 x 4,000 grid of 200,000 rows mounts in ~42 ms and keeps ~15 MB beyond the source arrays, a dense one (16M rows) mounts in ~0.28 s, and 10M rows over 10,000 x 10,000 cells in ~0.22 s; band indices and the tooltip index take up to 12 bytes per row, and the first tooltip after a change builds that index (~0.1 s at 10M rows). Split by facets (each panel's cells from its own rows, never merged with another panel's), with x and y categories shared or each panel's, row's, or column's own, in facets and subplots, and one color scale across panels. No binning of its own or calendar layout. | Documented. Heatmap series, calendar heatmap. | Documented. `cell` mark with a D3 color scale. | No built-in heatmap (third-party `chartjs-chart-matrix`). | Documented. Heatmap traces rendered as an image. |
| Candlestick | Measured. Candlestick mark over number, time, or category x: rising candles hollow, falling ones filled, all four prices in tooltips. ~0.7 ms for 200 candles. With more candles than pixel columns, each column's candles merge into one (the first open, highest high, lowest low, and last close): ~6.8 ms for 100,000, where merged candles show direction by color only. OHLC bars are a `variant` of the same mark (not measured separately); a volume pane is a subplot sharing x. | Measured. Built-in `candlestick` series: ~2.9 ms for 200 candles; its `large` mode draws high-low lines without bodies, ~57 ms for 100,000. | No built-in candlestick. | No built-in candlestick (third-party `chartjs-chart-financial`, not measured). | Measured. Built-in `candlestick` and `ohlc` traces, drawing every candle: ~4.1 ms for 200, ~650 ms for 100,000. |
| Financial charts | Time axes that leave out breaks (`timeBreaks`): days of the week, daily clock spans, calendar dates, and spans of instants, in the chart's time zone with clock changes; ticks never fall inside a break and move to the session that opens after it, labeled by the day or month that begins; data inside breaks is hidden while lines join across; zoom, pan, brushes, tooltips, and level of detail work in time shown. One-off measurement (Node, scene construction, a 1M-point line over ten years of New York sessions): ~4 ms to mount (~2.4 ms without breaks), ~0.5 ms per zoomed view (~0.1 ms), ~1.2 ms per streamed tick of 1,000 points (~0.6 ms). Candlesticks and OHLC bars (`variant: "ohlc"`), and crosshair labels on the axes (`tooltip.axisLabels`). A range navigator (`rangeNavigator`): a strip under the plot drawing its lines, areas, points (sampled to one per pixel), bars, and candlesticks over the whole x axis, whose window pans and zooms by dragging (dragging elsewhere selects, a double click resets) and is three keyboard sliders with value texts; it follows breaks, streaming data, wheel zoom, brushes, and synced charts, and SVG, PDF, and PNG export draw it. One-off measurement (Chrome, JavaScript per frame): dragging the window over a 1M-point line ~2.6–2.9 ms a move, as panning without one; with a zoomed 100,000-point rolling window streaming, ~2.3–2.4 ms a frame instead of ~1.5–1.6 ms. No technical indicators beyond derived rolling windows, no drawing tools, no marker at a break's seam; no navigator with facets or subplots. | Documented. Axis breaks since 6.0 (`xAxis.breaks`): each break an explicit `start` and `end` with a visual `gap`, on value, log, and time axes (not category), so recurring weekends and sessions are listed one by one; its candlestick examples use a category axis of trading days instead. `axisPointer` labels values on the axes (by default with the `cross` pointer). OHLC bars through a custom series (an example), not a built-in style. `dataZoom` of type `slider`: a strip with a shadow of one series (a line and an area), handles that label their values, dragging across the shadow to select (`brushSelect`), along x or y and on category axes; no keyboard operation documented. | No candlesticks, axis breaks, axis pointer labels, or range navigator documented. | Documented. The `timeseries` scale spreads data points equidistant, which closes gaps between them (not breaks of time); candlesticks and OHLC bars only through the third-party `chartjs-chart-financial`; no axis labels at the crosshair; no range navigator (`chartjs-plugin-zoom` zooms and pans without an overview). | Documented. `rangebreaks` on date axes: `bounds` with a `pattern` of "day of week" or "hour", or `values` with a `dvalue` size; `candlestick` and `ohlc` traces; spike lines (`showspikes`) across the plot or to the axes, with no documented labels on the axes. `xaxis.rangeslider`: the traces drawn again in a strip (`thickness`, 15% of the plot by default), shown by default under candlestick and OHLC charts, with `yaxis.rangemode` for its y range; no keyboard operation documented. |
| Histogram | Measured. Histogram mark binning a number or time field into round or calendar bins (or a fixed step), overlaid or stacked by series, as counts, percent, or probability density. On the same fixed grid as Plotly: ~0.6 ms for 10,000 values, ~6.7 ms for 1,000,000. Split by facets, each panel counts its own rows, in bins chosen from the rows of the panels sharing its x scale (one set of bins, or each panel's, row's, or column's own), with percent and density over each panel's counts and stacks within each panel. Bins are recomputed when the data changes; no cumulative or 2D histograms yet. | No built-in histogram (bin with a dataset transform or by hand). | No built-in histogram. | No built-in histogram. | Measured. `histogram` trace with automatic or fixed bins and many normalizations: ~3.4 ms for 10,000 values, ~63 ms for 1,000,000. |
| Pie and donut | Pie mark with an inner radius for donuts: slices sum a value (or count rows) per category, largest first, with 2 px gaps that work on any background, labels beside the pie with leader lines (the smallest dropped when they do not fit), legend toggling that gives the rest the circle, and slice tooltips, hover outlines, and arrow-key reading. Drawn as SVG and Canvas arcs, and as cubic curves in PDF. A pie has its chart to itself: no facets of pies, no labels inside slices, no rose or half-circle layouts yet. | Documented. `pie` series with `radius` for donuts, `roseType`, label lines, selected offsets, start angle, and many label layouts. | Documented. `pie` in `@tanstack/charts/polar`, with radial arcs and bars. | Documented. `pie` and `doughnut` chart types; labels inside or outside need a plugin. | Documented. `pie` trace with `hole`, `textposition` inside or outside, pulled slices, and subplot domains for several pies. |
| Box plot | Box plot mark over raw values: quartiles, median, Tukey whiskers, and outlier dots per category, vertical or horizontal, side by side by a series field, with tooltips reporting every statistic. Statistics recomputed for every box when the data changes. Split by facets, each panel's boxes (and violins) summarize its own rows, on categories shared by every panel or each panel's, row's, or column's own, in facets and subplots. No notches, means, or precomputed summaries as input yet. | Documented. `boxplot` series over precomputed summaries, or the `boxplot` dataset transform; outliers as a separate scatter series. | Documented. `boxX`, `boxY`, and `boxRows` with a summary transform (quartiles, Tukey whiskers, outliers). | No built-in box plot (`@sgratzl/chartjs-chart-boxplot` plugin). | Documented. `box` trace computing statistics from raw values, with notches, means, standard deviations, and points; `violin` traces. |
| Violin | Violin mark over raw values: each group's Gaussian kernel density (Silverman's rule, or one bandwidth for all), mirrored and as wide as the others at its densest, reaching two bandwidths past the extreme values, with the whisker range, quartile box, and median inside; vertical or horizontal, side by side by a series field; tooltips report the median, quartiles, range, and count. Each group's values are copied and sorted for its statistics; its density then costs one pass for linear binning and a convolution of at most 512 points (a third of a bandwidth apart, or each point's average over its interval when the span is wider). Densities are recomputed when the data changes; no split violins, count or area scaling, points, or hard span yet. | No built-in violin series; drawn with a custom series. | Documented. `violinX` and `violinY` draw mirrored profiles from prepared, normalized widths; densities and statistics are computed by the application. | No built-in violin (`@sgratzl/chartjs-chart-boxplot` plugin). | Documented. `violin` trace computing a kernel density from raw values (Silverman's rule by default), with soft, hard, or manual spans, width or count scaling, split sides, an inner box, a mean line, and points. |
| Treemap and sunburst | Treemap and sunburst marks over a tree from path fields or node and parent fields, sized by summed values or row counts: squarified rectangles with group headers, or rings by depth; colored by top-level group, legend toggling of groups, names where they fit, tooltips with each node's path and share, and depth-first keyboard reading. Weights must be finite and non-negative. No drill-down, zoom into a branch, or icicle layout yet. | Documented. `treemap` series (drill-down, breadcrumb, level styles) and `sunburst` series (root navigation, level styles), with visual mapping of values. | Documented. `hierarchy/treemap`, `hierarchy/sunburst`, and `hierarchy/tree` marks. | No built-in treemap or sunburst (`chartjs-chart-treemap` plugin). | Documented. `treemap` (with a path bar), `sunburst`, and `icicle` traces from ids and parents, with branch values and click-to-zoom. |
| Gauge | Gauge mark: the last finite value of a number field on a 240-degree dial (0 to 100 by default), so appending rows moves it; optional colored bands as a ring outside the track, the value's arc in its band's color, Intl number formats, values past the ends filling the dial while the text shows them as they are, and an item for tooltips, hover and click events, and keyboard reading. Drawn as SVG and Canvas arcs and in PDF. One value per dial; no needle, ticks, threshold marker, or bullet layout yet. Not benchmarked. | Documented. `gauge` series: progress bar, pointer, axis line colored by ranges, ticks and labels, several pointers per dial, start and end angles, and a formatted `detail` value. | Documented as a composition, not a mark: `pie` over a partial angle range with `radialArc` and `radialText` (`@tanstack/charts/polar`); needles from further marks. | No built-in gauge; a `doughnut` with `circumference` and `rotation` draws a partial ring (plugins such as `chartjs-gauge` add needles). | Documented. `indicator` trace in `gauge` mode: angular or bullet shape, a value bar, colored `steps`, a `threshold` line, and number and delta displays. |
| Funnel | Funnel mark: a centered bar per category whose width is proportional to its summed value (or row count) relative to the largest stage, in input or value order, with faint connectors that carry no data, stage names, and each stage's value and share of the first stage on or beside its bar; tooltips add the share of the previous stage. One color for all stages; no area-proportional (trapezoid) layout, per-stage colors, or legend yet. Not benchmarked. | Documented. `funnel` series of trapezoids, sorted ascending, descending, or as given, with gaps, label positions, and size and alignment options. | Documented as a composition, not a mark: one `areaX` trapezoid per stage from derived endpoints. | No built-in funnel (`chartjs-chart-funnel` plugin). | Documented. `funnel` trace (bars with connectors; text with percent of the initial, previous, or total) and `funnelarea` trace (stacked trapezoids). |
| Radar | Radar mark from long data (a category field for spokes and a value field) or wide data (a number field per spoke, a row per polygon), 3 to 100 spokes and a polygon per series with a translucent fill, outline, and dots; one linear scale for every spoke (round by default, or a fixed domain, with values beyond it drawn at the rim and flagged in tooltips), polygon rings labeled along the first spoke where labels fit, spoke names outside the rim that shrink the radar (to a limit) and are shortened or dropped when they do not fit, outlines broken and fills left out at missing values, legend toggling, and tooltips, hover outlines, and keyboard reading per value. No per-spoke scales, circular grids, value labels, or stacked or rose layouts yet; not benchmarked. | Documented. `radar` component with an `indicator` per spoke, each with its own `max` (and `min`), polygon or circle shapes, split areas, and `radar` series with area styles and symbols. | Documented. Composed in `@tanstack/charts/polar` from `radialGrid` (polygon rings), `angleGrid`, and `radialArea` and `radialLine` with a closed curve; values normalized by the application. | Documented. Built-in `radar` chart type on a `radialLinear` scale, with point labels, backdrop tick labels, filled datasets, and circular or polygon grids. | Documented. `scatterpolar` traces with `fill: "toself"` on polar axes (category angular axis), with line, marker, and per-trace hover options; any polar axis styling. |
| Sankey | Sankey mark over one table of flows: source and target category fields, links summing a value or counting rows. Columns by longest path with sinks in the last column and six passes of relaxation, as d3-sankey does; translucent bands in the source node's color; names and values beside the nodes, inside the diagram, shortened or left out when they do not fit; tooltips, hover outlines, clicks, and keyboard reading of nodes and links. Links that would close a cycle are left out and counted in the chart's description. Not benchmarked. No draggable or hand-placed nodes, vertical orientation, circular links, or highlighting of a node's links yet; the layout is recomputed whenever the table changes. | Documented. `sankey` series from `nodes` and `links`: `nodeAlign` (justify, left, right), horizontal or vertical `orient`, `nodeWidth`, `nodeGap`, `layoutIterations`, draggable nodes, per-depth `levels` styles, links colored by source, target, or a gradient, edge labels, and adjacency or trajectory emphasis. Cyclic data is an error. | Documented. `sankeyDiagram` in `@tanstack/charts/network/sankey` (bundling d3-sankey) lays out separate `nodes` and `links` and composes ordinary marks (`link`, `rect`, `text`) over the positioned node and link rows; alignment, node and link sorting, responsive `nodeWidth`, `nodePadding`, and `inset`, and iterations are options. Cycles, negative values, and duplicate node keys are errors. | No built-in Sankey (the `chartjs-chart-sankey` plugin). | Documented. `sankey` trace (full bundle, not `plotly-basic`) from node and link arrays: `arrangement` (snap, perpendicular, freeform, fixed), nodes placed by `x` and `y`, draggable nodes, node and link hover, and circular links for cyclic data. |
| Network graph | Graph mark over a table of links (source and target category fields; an optional value summed per pair of nodes, either way round, setting link widths) and an optional table of nodes (a group field coloring nodes, with a legend that toggles groups without moving the rest, and a size field by area). Laid out by d3-force's simulation and defaults (springs, many-body repulsion with a Barnes–Hut quadtree above 150 nodes, 300 ticks), started from pivot MDS rather than a spiral, so rings and chains do not fold, with connected components packed in rows; deterministic, fitted to the room, overlapping nodes pushed apart. Ringed nodes, translucent links tinted by group, names beside the most connected nodes where they cover no other node or name; tooltips, hover outlines, clicks, and keyboard reading of nodes and links; SVG, Canvas, and PDF. Not benchmarked: one-off timings of the layout in Node are ~0.1 s for 1,000 nodes and ~1 s for 5,000 (with up to 30,000 links), and a network draws at most 5,000 nodes and 20,000 links. Recomputed from scratch whenever a table changes; no dragging, zoom, arrows, link labels, circular layout, or neighbor highlighting yet. | Documented. `graph` series from `nodes` and `links` with `layout` `none` (given positions, also on cartesian, polar, or geo coordinates), `circular`, or `force` (`repulsion`, `gravity`, `edgeLength`, `friction`, an animated or instant layout); `categories` with a legend, draggable nodes, roam (zoom and pan), edge arrows and labels, curved parallel edges, and adjacency emphasis on hover. | Documented. `forceLayout` in `@tanstack/charts/network/force` runs a stopped d3-force simulation synchronously and deterministically with explicit forces (link, many-body, center, collide, x, y, or custom d3 forces) and returns node and link rows with padded domains, drawn with ordinary marks (`link`, `dot`, `text`); resizing remaps without another simulation. Not a live simulation: dragging is left to the application. | No built-in network (the `chartjs-chart-graph` plugin adds graph and force-directed graph charts). | Documented. No network trace: the documentation draws networks as a `scatter` trace of nodes and one of line segments for links, with positions computed elsewhere (networkx in Python). |
| Geographic maps | `geoshape` regions (choropleths by a number field on a continuous scale, or by category with a legend that grays categories out) and `geopoint` points and bubbles (sized by area, colored by series or a number field, ringed, largest first) on one projection: Equal Earth, Natural Earth, Mercator, equirectangular, or Albers' conic equal-area, with a central meridian and a fit to the data, the world, or a box of degrees. Shapes are a packed geometry column (GeoArrow-style offsets, binary in specs, codes per row shared by derived tables) from GeoJSON, GeoPandas, or Shapely without per-vertex objects; edges are planar in longitude and latitude, cut at the seam and the Mercator limit. Tooltips, hover outlines, clicks, keyboard reading, and a summary; SVG, Canvas, static SVG, and PDF; React, Vue, Svelte, and Python (with a Plotly-style `geojson`/`locations` join). Not benchmarked: one-off timings in Node for 200 regions of 1,000 vertices and 10,000 bubbles are ~20–30 ms for the first drawing, ~11 ms at a new size, ~2 ms to redraw after a value change, ~2 µs to find the region under the pointer. No base maps, zoom or pan, globes (orthographic) or other spherical rotation, lines (routes), labels on regions, or custom projections yet. | Documented. `map` series and the `geo` component over GeoJSON or SVG registered with `registerMap`, colored through `visualMap`; `scatter`, `effectScatter`, `lines`, and `heatmap` series on geo coordinates; `roam` zoom and pan, region labels and emphasis, and a `projection` of `project`/`unproject` functions (or a d3-geo projection stream). No bundled base maps. | Documented. `geoShape` in the opt-in `@tanstack/charts/geo` entry draws GeoJSON (polygons, lines, and points sized by a value) through any d3-geo projection factory fitted to the plot, including globes, with sphere and graticule layers; boundaries are the application's own GeoJSON. | No built-in maps (the `chartjs-chart-geo` plugin adds choropleth and bubble map charts). | Documented. `choropleth` and `scattergeo` traces with built-in base maps (countries, US states) and `locationmode`, or GeoJSON with `locations` and `featureidkey`; many projections (including orthographic and Albers USA), `fitbounds`, zoom and pan; tile-based maps (`choroplethmap`, `scattermap`) as well. |
| 3D charts | `point3d` scatter (series colors or a number field on a color scale) and `surface` height fields over a grid of rows (number, time, or category x and y; irregular spacing; holes for missing values; up to 250,000 grid points), sharing one box with x, y, and z axes (linear, log, time), a cube or a given aspect, and an orthographic (default) or perspective camera. Drawn back to front as ordinary SVG, Canvas, and PDF geometry, so static export and the text alternative work: exactly for points and one surface with points (points under a surface are hidden by it), by cell depth for several surfaces. Opaque point clouds of 20,000+ points are drawn by WebGL with a depth test. Drag to turn, wheel zoom (opt-in), double-click reset, Shift+arrow keys and +/− to turn and zoom, buttons for people who cannot drag, a `camera` event and `setCamera`; tooltips and keyboard reading of every point and grid point with their values. Measured (see 3D charts below): turning 10,000 points ~2.0 ms (Plotly ~5.5 ms), 100,000 and 1,000,000 points on WebGL ~0.3–0.4 ms of JavaScript (Plotly ~11 ms at 100,000; at 1,000,000 its page failed to allocate an array buffer); a 50 x 50 surface ~3.0 ms (Plotly ~4.7 ms), but a 200 x 200 surface ~30 ms on the CPU against Plotly's ~7.2 ms on the GPU; mounting is faster than Plotly's (10,000 points ~2.8 ms against ~39 ms). No 3D lines, text, bars, meshes, parametric surfaces, isosurfaces, volumes, contours, or specular lighting; labels stay horizontal; flat shading only. | Documented. ECharts-GL (a separate package): `scatter3D`, `bar3D`, `line3D`, `lines3D`, `surface` (including parametric surfaces), `polygons3D`, `map3D`, and `globe`, in WebGL with realistic shading, post effects, and wireframes; mouse orbit, zoom, and pan; not measured here (its compatibility with ECharts 6 was not checked). | Not implemented. | Not implemented (no 3D chart types). | Documented. `scatter3d` (markers, lines, and text), `surface` (with contours and lighting, including parametric x and y), `mesh3d`, `cone`, `streamtube`, `isosurface`, and `volume`, all WebGL (gl3d), with orbit, turntable, zoom, and pan modes and camera relayout; no SVG or vector PDF of 3D scenes (static export rasterizes them). Measured below: faster than Herceg on large surfaces. |
| Data preparation | Derived tables in the spec and in TypeScript (`derive`) and Python (`hg.derive`): filter and calculate with portable expressions, bin, aggregate (count, sum, mean, median, quantiles, min, max, stdev, variance, distinct, first, last), rolling windows, sort. Computed in the browser over typed columns and kept current as the source streams (incrementally for row-by-row steps): ~15 ms to filter and calculate 1M rows, ~9 ms to aggregate them by 20 groups, ~10 µs to follow a 100-row append (`npm run bench:core`). No joins, pivots, or calendar bins yet. | Documented. `dataset.transform` with filter, sort, and registered external transforms (ecStat for regression and clustering). | Data is prepared by the application. | Data is prepared by the application. | Documented. Plotly.js `transforms` (filter, groupby, aggregate, sort) are deprecated; Plotly Express prepares data in pandas. |
| Data grid | `herceg/grid`: a DOM grid over a row view that mounts only the rows and columns in view, sorts by header clicks (several keys with Shift) through the view, and selects rows into a selection store other views can read; it follows the WAI grid pattern (one tab stop, a focused cell kept mounted while scrolled away, polite announcements) and takes the charts' themes. Nested groups (a level per grouping field) from `groupRows`, whose aggregate tables (count, sum, mean, min, max at every level, a parent's from its rows, never from its groups' means; updated incrementally as rows are appended and as a rolling window drops them) charts draw too: header rows with aggregates at every level, expansion by key path, each level's groups sorted among their siblings by key or aggregate and rows within their group, group selection of every row below into the same row set with mixed checkboxes, and the WAI tree grid pattern with levels. Columns resize and move by dragging headers (previewed once a frame, Escape to cancel), by keys on a focused header, or from a column menu that also pins them left or right, hides them, and shows hidden ones; the layout is the model's column list, which applications can save and restore. Pinned columns stick to the edges in the same row elements (one row of cells in visual order for screen readers), and scroll with the others in grids too narrow to hold them. ~29 KiB gzip with the data layer it needs, ~37 KiB with row groups (one-off single-bundle measurement), none of it in a chart's bundle. Measured against TanStack Table with TanStack Virtual, AG Grid Community, and Glide Data Grid (see [Grids](#grids)): over 100k rows by 20 fields, mounting from the table's typed columns takes ~3 ms (TanStack ~84 ms and AG Grid ~76 ms with the conversion to row objects they need, Glide ~1.7 ms), sorting by a number ~16 ms to the correct frame (TanStack and AG Grid ~80 ms), and the mounted grid keeps ~2 MB of heap without copying the data (TanStack ~54 MB and AG Grid ~27 MB on top of ~62 MB of row objects); it keeps up with 1,000-row appends at 10 Hz under a sort at every size, and mounts 1M x 100 fields, where the tabs of TanStack and AG Grid crash. Weaker than Glide's canvas on scroll steps (~2.5–5 ms against ~1 ms), and than plain typed-array code on filtering at 100k rows and on sorted appends at 1M rows. Grouping 1M rows by a category (five aggregates, sums compensated with error bounds) ~16–21 ms against ~35–50 ms for a derived table's aggregate (which also copies filtered columns), and following a 1,000-row append ~0.1 ms (one-off Node measurements); over 100k rows by 20 fields in one to three levels (100 or 1,000 last-level groups, uniform or skewed), a 100-row append and a grouped grid's frame of model work take ~0.05–0.11 ms collapsed and ~0.16–0.2 ms expanded (~0.5 ms when each change listed the groups' rows again; ~0.22 against ~3.3 ms at 1M rows), and in a rolling window of 100k rows (batches of 500 through two turnovers) ~0.12–0.4 ms at the median and ~0.4–0.8 ms at the 99th percentile, where computing the groups again took ~2.5–6 ms (~0.2 against ~55 ms at 1M rows), ~1.2 ms for a sorted and filtered view (~3.9 ms before), and ~0.75 ms for minimums and maximums of a rising field, which leave with every batch (~2.8 ms before), keeping 8 bytes per row for each aggregated field; with nearly unique keys, whose groups vanish with every batch, ~13 ms collapsed (~38 ms before) and no faster fully expanded (~36 ms) (interleaved Node A/B runs). With two columns pinned left and one right, 100k x 20 and 1M x 100 grids scrolled to their middle mount the same 588 cells as without pins; a scroll step of ten rows takes ~1.0 and ~1.1 ms including style and layout either way, a step of one column across ~0.6 and ~0.95 ms (without pins ~0.65 and ~0.95–1.0 ms, against ~0.64 and ~0.94 ms before column layout existed), and a resize preview frame ~0.6 ms, writing no cell's text. No pivots, column groups, sizing to content, or editing yet; grouping and column layout are not compared. | Documented. No data grid; the toolbox's `dataView` shows (and lets users edit) the chart's data as text. | No data grid; TanStack Table and TanStack Virtual are separate libraries, compared in [Grids](#grids). | No data grid. | Documented. `table` trace with cell values, formats, fills, and column order; no sorting or selection documented. |
| Interaction | Wheel zoom and drag pan along x, y, or both; brushing along x or y, by rectangle, or by lasso (selections, or drag-to-zoom along zoomed axes); crosshair labels on the axes (`tooltip.axisLabels`); keyboard navigation with Shift-arrow range selection along the axis it steps along (rectangles and lassos are pointer-only); synced cursors, zoom, and selections (as data values: synced charts need the same category order; charts whose panels have x scales of their own sync cursors only); and `viewport` (x and both y ranges, once per change), `select`, `hover`, and `click` events (also React props, Vue events, and Svelte callback props, and Python widget callbacks with the same payloads); hovered and clicked points name their mark and the row of its table (none for bins, groups, and other points summarizing rows). Selections report ranges and outlines, not the rows inside them; a range navigator under the plot (see Financial charts); brushing and the navigator are not benchmarked against other libraries yet. | Documented. `dataZoom` (inside, slider), brush component (rectangle, polygon, x or y ranges), and an event API (`click`, `datazoom`, `brushSelected`, ...). | Not verified here. | Documented. `onClick`/`onHover` callbacks; zoom, pan, and drag-to-zoom through `chartjs-plugin-zoom`. | Documented. Zoom, pan, box and lasso selection, and events (`plotly_click`, `plotly_hover`, `plotly_selected`, `plotly_relayout`). |
| Animation | Opt-in (`animation`): the axes move to a view asked for (`setViewport`, zooming to a brush, double-click reset) over 250 ms by default, eased without overshoot, in log space on log axes; tooltips follow the moving axes. With `values: true`, marks move to changed values (in-place updates and resets) and axes whose automatic domains change move with them: each frame interpolates the domains and plans ticks and grid lines for the domain between, and draws marks through those scales, so a value that stays moves only with its axis. Unstacked bars (by category or position, through their base when values change sign), pie slices (sharing boundaries, opening and closing as categories come and go), points (by row, with encoded size, color, and opacity; growing from and shrinking to nothing as rows start and stop being drawn), lines and areas whose x positions stay and which level of detail leaves whole (stack layers and band edges together, monotone curves curved again each frame through the values between), and horizontal and vertical rules. A change shows at once when the plot or categories change, when a mark that cannot move (stacked or labeled bars, text, heatmaps, custom marks, a line whose x changed, points across a reset) shares a moving axis, and for appends and drops, frequent changes, more than 2,000 bars, slices, and rules, 10,000 points, or 10,000 line points, clouds, and inspected charts (pointer and keyboard read the new values first). Wheel zoom, panning, resizes, and export show at once; charts with several panels, linked charts, and pages preferring reduced motion do not animate, nor do charts whose frames would take over 10 ms of JavaScript, alone or together (a heuristic from earlier frames). No entrance animations or general path morphing. Frame costs measured outside the benchmark suite (Chrome): about 0.2 to 0.7 ms of JavaScript a frame for up to 2,000 bars, 0.2 to 0.6 ms for 1,000 points and 0.5 to 0.6 ms for 10,000, 0.2 ms for a 2,000-point line. | Documented. On by default: entrance animations, transitions of updated values (`animationDurationUpdate`, 500 ms, `animationEasingUpdate`, `cubicInOut`), and `universalTransition` morphing between series; series of more than `animationThreshold` (2,000) items do not animate. Checked in Chrome (one-off, ECharts 6.1, SVG renderer): when new values grow the y axis, the new tick set shows at once and labels the two axes share slide to their new places. | Not verified here. | Documented. On by default (1,000 ms, `easeOutQuart`): data updates animate per property (`animations`), with modes for show, hide, active, and resize (`transitions`); `animation: false` turns it off. Checked in Chrome (one-off, Chart.js 4.5.1): when new values grow the y axis, the axis takes its new ticks at once and bars move from their old pixels to their new ones over the second, so a bar part way does not read on the axis shown. | Documented. Off by default: `Plotly.animate` with frames and a `transition` (duration, easing) for data and layout, and `layout.transition` for `Plotly.react` updates. |
| Composition | Line, area, bar, point, heatmap, error bar, and rule marks share scales, axes, tooltip, and legend in one chart; bars are vertical or horizontal. Rule, region, and text annotations from constants or one per table row (deploy markers, incident windows, labels), with text labels hidden or moved around their points where they would overlap, farther ones with leader lines that cross no other label, point, or line. Custom marks draw shapes with the chart's scales through the same SVG, Canvas, and static renderers; over x and y fields they show series with legend entries, tooltips at their points (custom text optional), keyboard stops, facet splits, and summaries (JavaScript only; no hit testing of the drawn shapes). Bars can write their values. A second y axis on the right for marks with `axis: "right"`. Small multiples by a category field wrapped into rows, or a grid with a row per value of one field and a column per value of another, and subplots: panels in a grid each drawing the marks that name them. x and y are shared or resolved per panel, row, or column (facets share both by default, subplots x; each subplot's x and y may be linear, log, or time), and each x scale zooms, pans, brushes, and resets on its own. Rows and columns may be weighted (`rowHeights`, `columnWidths`). A category axis of bars, heatmaps, points, box plots, or violins may be resolved per panel, row, or column too, each holding only the categories its panels' rows hold; stacked bars stack, heatmap cells resolve, and histograms, box plots, and violins summarize within each facet panel (histograms in bins chosen per x scale); error bars and candlesticks still need their category axes shared, annotations over a table only repeat in every panel, and charts with categories per panel cannot be synced yet; no nested facets yet. | Documented. Many series types in one grid, `markLine`/`markArea`, `custom` series. | Documented. Grammar of marks; strongest composition model of the group. | Documented. Mixed chart types; annotations via plugin. | Documented. Traces, layout shapes and annotations, subplots. |
| Themes | Light, dark, high-contrast light and dark (on surfaces of their own), and `auto` (matches the surface the chart sits on, or `prefers-color-scheme`, and switches with it). Objects override 18 tokens: colors, font, label and title sizes, grid dash, line width, bar corner radius, tooltip surface, palette, and ramps. Colors may be CSS variables in any CSS color syntax, read from the page and re-read when its root or body element changes; static output uses the fallbacks. Categorical palettes are checked for color-blind separation between neighbors. Does not follow `forced-colors` yet; no theme gallery. | Documented. 36 bundled themes (`echarts/theme`), registered JSON themes, and an online theme builder; `setTheme` switches at runtime. Colors are canvas color strings, so the app reads CSS variables itself. | Documented. Styled through `--ts-chart-*` CSS custom properties, resolved for canvas painting; follows `prefers-color-scheme` and forced colors and re-renders when the theme changes. | Documented. Global and per-chart defaults (`Chart.defaults.color`, `borderColor`, `font`); no built-in dark or high-contrast theme; the app reads CSS variables and updates charts. | Documented. Python ships named templates (`plotly_white`, `plotly_dark`, `ggplot2`, `seaborn`, `simple_white`, ...); plotly.js takes a template object in `layout.template`. No CSS variables. |
| TypeScript | Field options are typed from the table schema: a categorical field passed as a numeric encoding is a compile error. Compile-time tests guard this. | Documented. Large option types; tree-shaken `ComposeOption` types. | Documented. Fields and callbacks inferred from row types. | Documented. Typed configuration generics. | Community `@types/plotly.js`, not first-party. |
| React | First-party `@herceg/react`: `<Chart>` with mark elements typed against the table's schema; no React element per data point, and data updates go through tables without rendering React. Measured: mounting adds up to ~0.3 ms per chart (often within noise), streaming and hover are within noise of plain herceg, each chart's React root retains ~25 KB, and the adapter adds ~0.9 KiB gzip. | Community wrappers (for example `echarts-for-react`). | First-party adapters for React and other frameworks. | Community `react-chartjs-2`. | `react-plotly.js`. |
| Vue and Svelte | First-party `@herceg/vue` and `@herceg/svelte`: `<Chart>` with mark components typed against the table's schema in templates checked by vue-tsc or svelte-check. Vue's `<Chart>` reads marks from its slot without mounting them; Svelte's mark components mount and render one empty `<template>` each. No component per data point, and data updates go through tables without Vue or Svelte. The adapters add ~1.3 KiB (Vue) and ~1.5 KiB (Svelte, with the entry's compiled component) gzip; their runtime cost is not measured yet. | Community `vue-echarts`; Svelte wrappers not verified here. | First-party Vue and Svelte adapters (`@tanstack/charts/vue`, `@tanstack/charts/svelte`). | Community `vue-chartjs`; Svelte wrappers not verified here. | No first-party Vue or Svelte component. |
| Python | First-party `herceg` package: `hg.line(df, x=..., y=...)` one-liners and a chainable `hg.Chart` for pandas, Polars, PyArrow, and NumPy data. Columns travel as binary buffers (no JSON number lists); output to notebooks, self-contained HTML, SVG, PNG, and PDF, and live notebook charts (see Notebooks). `herceg.streamlit.chart` shows charts in Streamlit apps (components v2, one binary payload per run) and returns the whole selection (ranges and lasso) and the clicked data, with its rows, to the script; hover and zoom are not reported there. | Community `pyecharts`; community `streamlit-echarts` for Streamlit. | None. | None. | First-class Plotly Python and Plotly Express; Streamlit's built-in `st.plotly_chart` returns point, box, and lasso selections. |
| Notebooks | Static display: an isolated iframe with the engine and the data embedded, so it works offline. Live charts (`chart.widget()`, on anywidget): Python appends rows (with a rolling window), replaces data, and changes options without re-sending the chart, as binary buffers over the widget's connection; brushing (ranges and lassos), zooming (x and both y axes), hovering, and clicks (with the rows under the pointer) come back as properties and callbacks, with datetimes on time axes. Tested in JupyterLab 4 only; update latency through the kernel not measured. | Community `pyecharts` renders notebook HTML; no first-party widget. | None. | None. | Documented. `fig.show()` in notebooks and `go.FigureWidget` (anywidget-based since Plotly.py 6), which updates traces from Python and calls Python on click, hover, and selection. |
| Accessibility | Focusable figure with a generated data summary, arrow-key navigation announced through a live region, legend entries as toggle buttons, `title`/`desc` in static SVG. Automated axe-core audits (WCAG 2.1 A/AA and best practices) find nothing to fix in every chart family, both renderers, facets, subplots, all four themes, static SVG, and grids; tests check the accessibility tree screen readers receive (name, description read once, legend states, live announcements), but not yet tried with screen readers themselves. The keyboard reaches every series (Up and Down between them) and walks heatmaps cell by cell. | Documented. `aria` option generates descriptions; decal patterns. | Documented. Required accessible name, keyboard focus navigation. | Canvas only; the application supplies fallback content. | Limited; no keyboard navigation of data. |
| Export | Standalone SVG in the browser (`toSVG`) and without a DOM (`renderToSVG`, heatmaps embedded as PNG). One-page vector PDF without a DOM or dependencies (`herceg/pdf`, ~11 KiB gzip, bundled only when imported): paths, selectable text in the standard PDF fonts, heatmaps as images; no embedded fonts, so text is limited to Windows-1252 characters, and the PDF is not tagged. Python saves SVG and PDF (same renderers, embedded V8) and PNG (resvg) without a browser. | Documented. PNG/SVG from the browser, server-side SVG strings; no built-in PDF. | Documented. Static SVG, SSR, browser raster export. | PNG via `toBase64Image`; no built-in PDF. | Documented. PNG/SVG/JPEG/WebP; Kaleido for Python, which also writes PDF. |
| Ease of use | One table plus mark functions with typed fields, the same marks in TypeScript, the adapters, specs, and Python. Covers the common chart families (lines, areas, bars, points, heatmaps, distributions, part-to-whole, hierarchies, flows, networks, 3D points and surfaces) with fewer options than ECharts or Plotly, and no financial indicators yet. | Large declarative option object; many examples. | Typed grammar; scales and D3 modules are explicit imports. | Simple for standard charts; plugins for the rest. | Very quick for common charts, especially Plotly Express. |

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
React DOM out, since an application using the adapter already ships them;
`herceg-vue-line` and `herceg-svelte-line` do the same through `@herceg/vue`
and `@herceg/svelte` and leave Vue and Svelte's runtime out. Sizes are what
a page loads before the chart renders: the entry chunk and every chunk it
imports statically, each compressed on its own (Herceg's scheduler is one
such chunk, shared with its lazily loaded painters); chunks reached only by
dynamic imports are listed as loaded on demand. `herceg-grid` is not a
chart: it mounts a two-column grid (`herceg/grid`) over the same data, with
its model, row view, and selection store; no other library here has a grid
to compare it with.

<!-- results:size -->
| Entry | Version | Minified KiB | Gzip KiB | Brotli KiB | Required CSS, gzip KiB | Loaded on demand, gzip KiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| chartjs-auto | 4.5.1 | 246.8 | 79.9 | 69.3 | - | - |
| chartjs-line | 4.5.1 | 196.4 | 63.7 | 56.0 | - | - |
| echarts-full | 6.1.0 | 1107.9 | 370.5 | 302.3 | - | - |
| echarts-line | 6.1.0 | 490.7 | 166.8 | 142.7 | - | - |
| herceg-grid | 0.0.0 (05370de) | 85.8 | 29.7 | 26.8 | - | - |
| herceg-line | 0.0.0 (05370de) | 112.9 | 42.3 | 37.9 | - | 23.7 |
| herceg-react-line | 0.0.0 (05370de) | 115.5 | 43.4 | 39.0 | - | 23.7 |
| herceg-svelte-line | 0.0.0 (05370de) | 117.0 | 44.0 | 39.4 | - | 23.7 |
| herceg-vue-line | 0.0.0 (05370de) | 116.6 | 43.8 | 39.3 | - | 23.7 |
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
(`npm run bench -- --lib herceg,plotly --scenario ... --out results/three.json`).
Both libraries project orthographically with a cube box, points 7 px across
of one color, and surfaces colored by height and shaded (their defaults).
Plotly draws every 3D chart with WebGL (gl3d) and turns it through
`relayout` of `scene.camera.eye`. Herceg draws points on a canvas below
20,000 and with WebGL from there, and surfaces on a canvas (SVG for small
ones); its WebGL timings leave out the GPU's own work, as Plotly's do. ECharts
(through ECharts-GL) is not included.

<!-- results:three -->
- Date: 2026-10-09, commit 2f8fee2
- Machine: Apple M6, 12 cores, 32 GB, Darwin 27.0.0
- Browser: Chrome 154.0.8037.99 through Playwright 1.63.0 (installed Google Chrome), GPU ANGLE (Apple, ANGLE Metal Renderer: Apple M6, Unspecified Version), headed, idle frames every 17.9 ms
- Viewport 1280x1400, device pixel ratio 2
- Libraries: herceg 0.0.0 (2f8fee2), plotly 4.1.2
- Renderers (normal / large config): herceg: auto (svg below 4,000 drawn points, canvas above; 3D points from 20,000 on WebGL) / auto; plotly: svg / webgl (scattergl)

| Scenario (ms, median ± MAD) | herceg | plotly |
| --- | ---: | ---: |
| scatter3d-10k-init (10,000 points in 3D) | 2.75 ± 0.19 | 38.6 ± 1.95 |
| surface-100-init (100 x 100 grid surface) | 12.0 ± 1.66 | 47.4 ± 3.25 |

| Scenario (ms, median ± MAD) | herceg | plotly |
| --- | ---: | ---: |
| rotate-scatter3d-10k (10,000 points in 3D) | 1.96 ± 0.29 | 5.48 ± 0.17 |
| rotate-scatter3d-100k (100,000 points in 3D) | 0.32 ± 0.07 | 10.7 ± 0.31 |
| rotate-scatter3d-1m (1,000,000 points in 3D) | 0.43 ± 0.05 | error |
| rotate-surface-50 (50 x 50 grid surface) | 2.99 ± 0.35 | 4.68 ± 0.27 |
| rotate-surface-200 (200 x 200 grid surface) | 29.8 ± 1.19 | 7.19 ± 0.47 |
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
DevTools protocol), nor are long frames. Firefox is not included: Playwright's
Firefox build does not start on this machine's macOS.

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
