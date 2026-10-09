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
| Bundle size (line chart, gzip) | Measured. ~42 KiB for a time-series line chart with tooltip, events, and brushing (monotone curves, which line charts carry whether they use them, are ~1 KiB of it, the four built-in themes with page-following themes about 2 KiB, the dispatch to layout marks such as pies about 1 KiB, y and xy zoom, rectangle and lasso brushes, and synced selections about 1.4 KiB, and facet headers, per-panel y scales, subplot routing, and weighted rows, which the model plans for any chart, about 1.1 KiB, x scales of panels' own (planned per group for any chart, with zoom, selections, and events per scale in the browser runtime) about 1.5 KiB, the hooks that start view transitions, whose code loads separately, about 0.3 KiB, the hooks that let a map's layers share a chart and tables hold geometry columns, about 0.1 KiB, the hooks for time axis breaks (whose code comes only with `timeBreaks`) and crosshair labels (loaded on demand), about 1.2 KiB, and the camera API and the hooks that load 3D turning (`camera`, `setCamera`, the camera event, presses kept to their pointer), about 0.6 KiB; the pie, the maps, the breaks, and the 3D marks themselves are not included). Each mark brings its own drawing code, so a line chart carries no bar, point, symbol, heatmap, or text drawing, color schemes are separate exports, and facets are only bundled when used; the chart model still includes band-axis, legend-layout (series, color, size, and shape keys), horizontal-bar inspection, right-axis, and panel-layout logic, and min/max indexes for large lines add ~1 KiB. The WebGL painter for large point series (~4 KiB, with its 3D program), 3D turning (~2 KiB), animation (~1 KiB), and crosshair labels (~1 KiB) load only when a chart needs them, and text is measured with the browser's canvas, so the static text estimator is not bundled. | Measured. ~167 KiB tree-shaken, ~371 KiB full. | Measured. ~44 KiB including `d3-scale` for time. | Measured. ~64 KiB with time scale and date adapter. | Measured. ~391 KiB basic bundle, ~1.4 MiB full. |
| Line | Line, step lines, smooth monotone curves, several y fields or a long-format series field, gaps for missing values, log and time axes, level of detail for large series. Area (stacked, band) and rule marks. | Documented. Time axes, sampling, area fill, step lines. | Documented. `lineY`/`lineX`, gaps, curves. | Documented. Line, stepped, filled; decimation plugin. | Documented. `scatter`/`scattergl` lines, rich hover. |
| Scatter | Point mark with per-series color, radius, and opacity; every point is drawn. Series of 100,000+ points use WebGL (loaded on demand): ~13 ms to mount 1M points, ~3.6 ms per zoom step, both ahead of Plotly's WebGL. Nearest-point hover through a spatial grid index (~0.5 ms per move at 10k points). Size (bubbles), continuous color (named sequential and diverging schemes, midpoints), opacity, and eight symbol shapes by field, with size and shape keys; outlines (`stroke`, `strokeWidth`); encoded and outlined points are drawn on the CPU, not WebGL. | Documented. `large` mode for big scatter. | Documented. `dot` mark; one scene node per point. | Documented. Scatter/bubble. | Documented. SVG and WebGL scatter. |
| Heatmap | Heatmap mark over category, number, or time fields, drawn as one image (Canvas `drawImage`, PNG inside SVG), with a color legend and cell tooltips. Named sequential and diverging schemes, fixed color domains, and midpoints. No cell limit: a grid larger than the plot is drawn at the plot's device resolution, each pixel the mean (or with `reduce`, the max or min) of its block of cells, and tooltips still report the single cell under the pointer; memory follows the table's rows and the plot's pixels, not the cell count. Measured in a one-off run outside the committed suite (headless Chrome 154, Apple M6, 800 x 400 chart at DPR 2; competitors not run at these sizes): a sparse 4,000 x 4,000 grid of 200,000 rows mounts in ~42 ms and keeps ~15 MB beyond the source arrays, a dense one (16M rows) mounts in ~0.28 s, and 10M rows over 10,000 x 10,000 cells in ~0.22 s; band indices and the tooltip index take up to 12 bytes per row, and the first tooltip after a change builds that index (~0.1 s at 10M rows). No binning of its own or calendar layout. | Documented. Heatmap series, calendar heatmap. | Documented. `cell` mark with a D3 color scale. | No built-in heatmap (third-party `chartjs-chart-matrix`). | Documented. Heatmap traces rendered as an image. |
| Candlestick | Measured. Candlestick mark over number, time, or category x: rising candles hollow, falling ones filled, all four prices in tooltips. ~0.7 ms for 200 candles. With more candles than pixel columns, each column's candles merge into one (the first open, highest high, lowest low, and last close): ~6.8 ms for 100,000, where merged candles show direction by color only. OHLC bars are a `variant` of the same mark (not measured separately); a volume pane is a subplot sharing x. | Measured. Built-in `candlestick` series: ~2.9 ms for 200 candles; its `large` mode draws high-low lines without bodies, ~57 ms for 100,000. | No built-in candlestick. | No built-in candlestick (third-party `chartjs-chart-financial`, not measured). | Measured. Built-in `candlestick` and `ohlc` traces, drawing every candle: ~4.1 ms for 200, ~650 ms for 100,000. |
| Financial charts | Time axes that leave out breaks (`timeBreaks`): days of the week, daily clock spans, calendar dates, and spans of instants, in the chart's time zone with clock changes; ticks never fall inside a break and move to the session that opens after it, labeled by the day or month that begins; data inside breaks is hidden while lines join across; zoom, pan, brushes, tooltips, and level of detail work in time shown. One-off measurement (Node, scene construction, a 1M-point line over ten years of New York sessions): ~4 ms to mount (~2.4 ms without breaks), ~0.5 ms per zoomed view (~0.1 ms), ~1.2 ms per streamed tick of 1,000 points (~0.6 ms). Candlesticks and OHLC bars (`variant: "ohlc"`), and crosshair labels on the axes (`tooltip.axisLabels`). No technical indicators beyond derived rolling windows, no drawing tools or range navigator, no marker at a break's seam. | Documented. Axis breaks since 6.0 (`xAxis.breaks`): each break an explicit `start` and `end` with a visual `gap`, on value, log, and time axes (not category), so recurring weekends and sessions are listed one by one; its candlestick examples use a category axis of trading days instead. `axisPointer` labels values on the axes (by default with the `cross` pointer). OHLC bars through a custom series (an example), not a built-in style. | No candlesticks, axis breaks, or axis pointer labels documented. | Documented. The `timeseries` scale spreads data points equidistant, which closes gaps between them (not breaks of time); candlesticks and OHLC bars only through the third-party `chartjs-chart-financial`; no axis labels at the crosshair. | Documented. `rangebreaks` on date axes: `bounds` with a `pattern` of "day of week" or "hour", or `values` with a `dvalue` size; `candlestick` and `ohlc` traces; spike lines (`showspikes`) across the plot or to the axes, with no documented labels on the axes. |
| Histogram | Measured. Histogram mark binning a number or time field into round or calendar bins (or a fixed step), overlaid or stacked by series, as counts, percent, or probability density. On the same fixed grid as Plotly: ~0.6 ms for 10,000 values, ~6.7 ms for 1,000,000. Bins are recomputed when the data changes; no cumulative or 2D histograms yet. | No built-in histogram (bin with a dataset transform or by hand). | No built-in histogram. | No built-in histogram. | Measured. `histogram` trace with automatic or fixed bins and many normalizations: ~3.4 ms for 10,000 values, ~63 ms for 1,000,000. |
| Pie and donut | Pie mark with an inner radius for donuts: slices sum a value (or count rows) per category, largest first, with 2 px gaps that work on any background, labels beside the pie with leader lines (the smallest dropped when they do not fit), legend toggling that gives the rest the circle, and slice tooltips, hover outlines, and arrow-key reading. Drawn as SVG and Canvas arcs, and as cubic curves in PDF. A pie has its chart to itself: no facets of pies, no labels inside slices, no rose or half-circle layouts yet. | Documented. `pie` series with `radius` for donuts, `roseType`, label lines, selected offsets, start angle, and many label layouts. | Documented. `pie` in `@tanstack/charts/polar`, with radial arcs and bars. | Documented. `pie` and `doughnut` chart types; labels inside or outside need a plugin. | Documented. `pie` trace with `hole`, `textposition` inside or outside, pulled slices, and subplot domains for several pies. |
| Box plot | Box plot mark over raw values: quartiles, median, Tukey whiskers, and outlier dots per category, vertical or horizontal, side by side by a series field, with tooltips reporting every statistic. Statistics recomputed for every box when the data changes; box plots cannot be split by facets yet. No notches, means, or precomputed summaries as input yet. | Documented. `boxplot` series over precomputed summaries, or the `boxplot` dataset transform; outliers as a separate scatter series. | Documented. `boxX`, `boxY`, and `boxRows` with a summary transform (quartiles, Tukey whiskers, outliers). | No built-in box plot (`@sgratzl/chartjs-chart-boxplot` plugin). | Documented. `box` trace computing statistics from raw values, with notches, means, standard deviations, and points; `violin` traces. |
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
| Interaction | Wheel zoom and drag pan along x, y, or both; brushing along x or y, by rectangle, or by lasso (selections, or drag-to-zoom along zoomed axes); crosshair labels on the axes (`tooltip.axisLabels`); keyboard navigation with Shift-arrow range selection along the axis it steps along (rectangles and lassos are pointer-only); synced cursors, zoom, and selections (as data values: synced charts need the same category order; charts whose panels have x scales of their own sync cursors only); and `viewport` (x and both y ranges, once per change), `select`, `hover`, and `click` events (also React props, Vue events, and Svelte callback props, and Python widget callbacks with the same payloads); hovered and clicked points name their mark and the row of its table (none for bins, groups, and other points summarizing rows). Selections report ranges and outlines, not the rows inside them; no zoom slider; brushing is not benchmarked yet. | Documented. `dataZoom` (inside, slider), brush component (rectangle, polygon, x or y ranges), and an event API (`click`, `datazoom`, `brushSelected`, ...). | Not verified here. | Documented. `onClick`/`onHover` callbacks; zoom, pan, and drag-to-zoom through `chartjs-plugin-zoom`. | Documented. Zoom, pan, box and lasso selection, and events (`plotly_click`, `plotly_hover`, `plotly_selected`, `plotly_relayout`). |
| Animation | Opt-in (`animation`): the axes move to a view asked for (`setViewport`, zooming to a brush, double-click reset) over 250 ms by default, eased without overshoot, in log space on log axes; tooltips follow the moving axes. New data, wheel zoom, panning, resizes, and export show at once; charts with several panels, linked charts, and pages preferring reduced motion do not animate, nor do charts whose frames would take over 10 ms of JavaScript, alone or together (a heuristic from earlier frames). No entrance animations, no morphing of changed values (bars growing, slices turning) yet; not in the benchmark suite. | Documented. On by default: entrance animations, transitions of updated values (`animationDurationUpdate`, `animationEasingUpdate`), and `universalTransition` morphing between series; turned off above `animationThreshold` (2,000 items). | Not verified here. | Documented. On by default (1,000 ms, `easeOutQuart`): data updates animate per property (`animations`), with modes for show, hide, active, and resize (`transitions`); `animation: false` turns it off. | Documented. Off by default: `Plotly.animate` with frames and a `transition` (duration, easing) for data and layout, and `layout.transition` for `Plotly.react` updates. |
| Composition | Line, area, bar, point, heatmap, error bar, and rule marks share scales, axes, tooltip, and legend in one chart; bars are vertical or horizontal. Rule, region, and text annotations from constants or one per table row (deploy markers, incident windows, labels), with text labels hidden or moved around their points where they would overlap (no leader lines). Custom marks draw shapes with the chart's scales through the same SVG, Canvas, and static renderers; over x and y fields they show series with legend entries, tooltips at their points (custom text optional), keyboard stops, facet splits, and summaries (JavaScript only; no hit testing of the drawn shapes). Bars can write their values. A second y axis on the right for marks with `axis: "right"`. Small multiples by a category field wrapped into rows, or a grid with a row per value of one field and a column per value of another, and subplots: panels in a grid each drawing the marks that name them. x and y are shared or resolved per panel, row, or column (facets share both by default, subplots x; each subplot's x and y may be linear, log, or time), and each x scale zooms, pans, brushes, and resets on its own. Rows and columns may be weighted (`rowHeights`, `columnWidths`). Category axes are always shared; no nested facets yet. | Documented. Many series types in one grid, `markLine`/`markArea`, `custom` series. | Documented. Grammar of marks; strongest composition model of the group. | Documented. Mixed chart types; annotations via plugin. | Documented. Traces, layout shapes and annotations, subplots. |
| Themes | Light, dark, high-contrast light and dark (on surfaces of their own), and `auto` (matches the surface the chart sits on, or `prefers-color-scheme`, and switches with it). Objects override 18 tokens: colors, font, label and title sizes, grid dash, line width, bar corner radius, tooltip surface, palette, and ramps. Colors may be CSS variables in any CSS color syntax, read from the page and re-read when its root or body element changes; static output uses the fallbacks. Categorical palettes are checked for color-blind separation between neighbors. Does not follow `forced-colors` yet; no theme gallery. | Documented. 36 bundled themes (`echarts/theme`), registered JSON themes, and an online theme builder; `setTheme` switches at runtime. Colors are canvas color strings, so the app reads CSS variables itself. | Documented. Styled through `--ts-chart-*` CSS custom properties, resolved for canvas painting; follows `prefers-color-scheme` and forced colors and re-renders when the theme changes. | Documented. Global and per-chart defaults (`Chart.defaults.color`, `borderColor`, `font`); no built-in dark or high-contrast theme; the app reads CSS variables and updates charts. | Documented. Python ships named templates (`plotly_white`, `plotly_dark`, `ggplot2`, `seaborn`, `simple_white`, ...); plotly.js takes a template object in `layout.template`. No CSS variables. |
| TypeScript | Field options are typed from the table schema: a categorical field passed as a numeric encoding is a compile error. Compile-time tests guard this. | Documented. Large option types; tree-shaken `ComposeOption` types. | Documented. Fields and callbacks inferred from row types. | Documented. Typed configuration generics. | Community `@types/plotly.js`, not first-party. |
| React | First-party `@herceg/react`: `<Chart>` with mark elements typed against the table's schema; no React element per data point, and data updates go through tables without rendering React. Measured: mounting adds up to ~0.3 ms per chart (often within noise), streaming and hover are within noise of plain herceg, each chart's React root retains ~25 KB, and the adapter adds ~0.9 KiB gzip. | Community wrappers (for example `echarts-for-react`). | First-party adapters for React and other frameworks. | Community `react-chartjs-2`. | `react-plotly.js`. |
| Vue and Svelte | First-party `@herceg/vue` and `@herceg/svelte`: `<Chart>` with mark components typed against the table's schema in templates checked by vue-tsc or svelte-check. Vue's `<Chart>` reads marks from its slot without mounting them; Svelte's mark components mount and render one empty `<template>` each. No component per data point, and data updates go through tables without Vue or Svelte. The adapters add ~1.3 KiB (Vue) and ~1.5 KiB (Svelte, with the entry's compiled component) gzip; their runtime cost is not measured yet. | Community `vue-echarts`; Svelte wrappers not verified here. | First-party Vue and Svelte adapters (`@tanstack/charts/vue`, `@tanstack/charts/svelte`). | Community `vue-chartjs`; Svelte wrappers not verified here. | No first-party Vue or Svelte component. |
| Python | First-party `herceg` package: `hg.line(df, x=..., y=...)` one-liners and a chainable `hg.Chart` for pandas, Polars, PyArrow, and NumPy data. Columns travel as binary buffers (no JSON number lists); output to notebooks, self-contained HTML, SVG, PNG, and PDF, and live notebook charts (see Notebooks). `herceg.streamlit.chart` shows charts in Streamlit apps (components v2, one binary payload per run) and returns the whole selection (ranges and lasso) and the clicked data, with its rows, to the script; hover and zoom are not reported there. | Community `pyecharts`; community `streamlit-echarts` for Streamlit. | None. | None. | First-class Plotly Python and Plotly Express; Streamlit's built-in `st.plotly_chart` returns point, box, and lasso selections. |
| Notebooks | Static display: an isolated iframe with the engine and the data embedded, so it works offline. Live charts (`chart.widget()`, on anywidget): Python appends rows (with a rolling window), replaces data, and changes options without re-sending the chart, as binary buffers over the widget's connection; brushing (ranges and lassos), zooming (x and both y axes), hovering, and clicks (with the rows under the pointer) come back as properties and callbacks, with datetimes on time axes. Tested in JupyterLab 4 only; update latency through the kernel not measured. | Community `pyecharts` renders notebook HTML; no first-party widget. | None. | None. | Documented. `fig.show()` in notebooks and `go.FigureWidget` (anywidget-based since Plotly.py 6), which updates traces from Python and calls Python on click, hover, and selection. |
| Accessibility | Focusable figure with a generated data summary, arrow-key navigation announced through a live region, legend entries as toggle buttons, `title`/`desc` in static SVG. Automated axe-core audits (WCAG 2.1 A/AA and best practices) find nothing to fix in every chart family, both renderers, facets, subplots, all four themes, and static SVG; tests check the accessibility tree screen readers receive (name, description read once, legend states, live announcements), but not yet tried with screen readers themselves. The keyboard reaches every series (Up and Down between them) and walks heatmaps cell by cell. | Documented. `aria` option generates descriptions; decal patterns. | Documented. Required accessible name, keyboard focus navigation. | Canvas only; the application supplies fallback content. | Limited; no keyboard navigation of data. |
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
dynamic imports are listed as loaded on demand.

<!-- results:size -->
| Entry | Version | Minified KiB | Gzip KiB | Brotli KiB | Required CSS, gzip KiB | Loaded on demand, gzip KiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| chartjs-auto | 4.5.1 | 246.8 | 79.9 | 69.3 | - | - |
| chartjs-line | 4.5.1 | 196.4 | 63.7 | 56.0 | - | - |
| echarts-full | 6.1.0 | 1107.9 | 370.5 | 302.3 | - | - |
| echarts-line | 6.1.0 | 490.7 | 166.8 | 142.7 | - | - |
| herceg-line | 0.0.0 (6cfdbfa) | 113.0 | 42.2 | 37.8 | - | 9.1 |
| herceg-react-line | 0.0.0 (6cfdbfa) | 115.5 | 43.3 | 38.7 | - | 9.1 |
| herceg-svelte-line | 0.0.0 (6cfdbfa) | 116.8 | 43.8 | 39.2 | - | 9.1 |
| herceg-vue-line | 0.0.0 (6cfdbfa) | 116.5 | 43.7 | 39.1 | - | 9.1 |
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
