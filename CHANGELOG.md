# Changelog

All published packages share one version: `herceg`, `@herceg/react`,
`@herceg/vue`, `@herceg/svelte`, and the Python package `herceg`. Before 1.0,
a minor version may change APIs; each such change is listed here with what
to do about it.

## Unreleased

The first public release. What it contains:

**Engine (`herceg`)**
- **Data and specs:**
  - columnar tables of typed arrays, with appends, rolling windows, replacements, and row views;
  - categories, times, derived tables, and portable expressions;
  - a serializable chart spec (`herceg/spec`) that every surface shares.
- **Marks:**
  - line, area, bar, point, heatmap, histogram, box plot, letter-value (boxen) plot, violin, error bar, candlestick, rug, and dendrogram;
  - rule, region, and text annotations;
  - pie, treemap, sunburst, gauge, funnel, radar, Sankey, network, maps (shapes and points), and 3D points, lines, and surfaces;
  - custom marks;
  - matplotlib dash strings (`"-"`, `"--"`, `":"`, `"-."`) on lines, rules, and custom shape styles, scaled by stroke width.
- **Composition:** marks compose in one chart, in facets, and in subplots, with shared or independent scales, right axes, and range navigators; 3D layers share CPU-rendered subplots with independent cameras and controls (3D facets are refused).
- **Scales:** `x`, `y`, and `yRight` are the scales "x", "y", and "yRight" with their axes. Their `scope` (`"chart"`, `"panel"`, `"row"`, or `"column"`) says which facet panels or subplots share one instance; it replaces the chart's `resolve` option (Python: `hg.AxisOptions(scope=...)` replaces `resolve_x`, `resolve_y`, and `resolve_y_right`). A scale's type comes from the marks of the panels sharing it, so one subplot can show categories along an axis while another shows numbers.
- **Scales and guides:** `scales` (`{ x, y, yRight }`, scale settings over the short forms') and `guides` (`axis(...)`, `legend(...)`, `colorbar(...)`) add axes, legends, and colorbars beyond the automatic ones. Ticks are a count, `{ every }` (calendar steps such as `"6 hours"` or `"month"` in the chart's time zone, or numbers from an anchor), `{ values }`, or a function; formats are Intl options, `{ number }` d3-like patterns, `{ time }` strftime patterns, or a function; specs refuse functions at their path. Axes take tick layers (minor ticks, day boundaries in a second row) with tick direction and length, label rotation candidates, and collisions (`"hide"`, `"stagger"`, `"wrap"`, `"show"`), and go on the top (x) or right (y). Legends take `columns` or `rows`, `order`, a `title`, custom `entries`, `merge: "semantic"` (one entry per series value across marks and panels), and `swatches: "mark"`; marks take `legend: false`. Colorbars draw a continuous color scale along its domain, vertical or horizontal, with ticks, a title, and a format, or a contour's bands as steps, and are described with their ranges. The guide compiler loads only with charts that use these. Python: `hg.Scale`, `hg.ScaleRef`, `hg.Ticks`, `hg.Format`, `hg.Tick`, `hg.TickLabels`, `hg.TickLayer`, `hg.axis`, `hg.legend`, `hg.colorbar`, `hg.LegendEntry`, `hg.Swatch`, and `legend=False` on marks; `hg.AxisOptions` and `hg.LegendOptions` are the short forms' settings.
- **Styles and themes:** a theme is tokens (`background`, `text`, `muted`, `grid`, `axis`, `palette`, `sequential`, `diverging`, `rise`, `fall`) and role styles (`text`, `title`, `panelTitle`, `axisTitle`, `tickLabel`, `legendLabel`, `legendTitle`, `plot`, `grid`, `axisLine`, `tick`, and the marks' `line`, `bar`, and `tooltip` defaults) over the built-in theme it `extends`: `theme: { extends, tokens, style }`, which replaces the theme's top-level keys (`font`, `fontSize`, `titleSize`, `gridDash`, `lineWidth`, `barRadius`, `tooltipBackground`, `tooltipBorder` become `style` roles). Axes, the legend, the title, and subplots take a `style` of their roles, cascading over the theme's. Text styles set font, size, weight, slant, color, opacity, line height, alignment, halo, a background box, and padding (the box goes where its text would go without one, and the text moves in by the padding); line styles set stroke, width, dash, and opacity; the plot style a background and border. Python: `hg.Theme`, `hg.Tokens`, `hg.Style`, `hg.TextStyle`, `hg.StrokeStyle`, `hg.PlotStyle`, `hg.LineStyle`, `hg.BarStyle`, `hg.TooltipStyle`, `hg.TextBox`.
- **Layout:** `padding` (pixels, or per side; `0` lets a chart fill its size; left out, spacing is automatic); titles as a string or `{ text, place, style }`, at the top or bottom, aligned by their style, broken into lines at `"\n"`; subplot titles as a string or `{ text, style }`; legends as `true`, `false`, or `{ place, style }`, placed on any side (`align`, `offset`) or inside a plot's corner or edge (`inset`, `scope`, `panel`). Python: `hg.Title`, `hg.LegendOptions`, `hg.Place`, `padding=`.
- **Marks:** `clip` (`"plot"`, `"chart"`, or `false`) on marks on the chart's scales; `halo` (`"auto"`, `false`, or `{ color, width?, opacity? }`) on `text`, `region`, `bar`, `funnel`, `radar`, `sankey`, `graph`, and `rangeNavigator`, replacing its boolean form. Python: `clip=`, and `halo=` taking `"auto"`, `False`, or `hg.Halo`.
- **Fonts (`herceg/fonts`):** `prepareFonts(sources)` gives a chart and every export the same TrueType faces (`fonts` on chart options, `renderToSVG`, `specToSVG`, `renderToPDF`, and `specToPDF`): live charts measure with them and register them with the page, SVG and PNG exports measure with them, PDF embeds subsets, and text in them is drawn unkerned, as measured. `fallback` and `missingGlyph` are PDF export settings. It replaces `pdfFonts` from `herceg/pdf` (`FontSource`, `FontOptions`, and `Fonts` replace `PdfFontSource`, `PdfFontOptions`, and `PdfFonts`).
- **Positions:** the portable `Coordinate` (a data value on a named scale, a field, a fraction of the plot or chart, or pixels from its edge, with a pixel offset) and `Position` (one per axis) types; annotations' number-or-field positions are typed `AnnotationValue`.
- **Rendering:** SVG or Canvas chosen per chart, WebGL for large point clouds and standalone 3D charts, and level-of-detail reduction for large lines and areas.
- **Interaction:**
  - tooltips with configurable fields;
  - keyboard reading;
  - zoom and pan;
  - brushes and lassos;
  - row selections shared between charts, which summaries (histograms, box plots, violins, heatmaps, pies, funnels, trees, Sankey diagrams) show as each item's selected part, in exports too;
  - synced cursors and views;
  - drilldown, map and network navigation, and node dragging;
  - per-panel 3D cameras through `getCamera({ panel })`, `setCamera(camera, { panel })`, and scoped camera events.
- **Accessibility:** generated descriptions, keyboard navigation, and accessible legends; tested with axe-core in Chrome, Firefox, and WebKit.
- **Export:** static SVG, PNG, and tagged multi-page PDF, without a DOM where possible; fluid SVG with `sizing: "fluid"`, `preserveAspectRatio`, and `strokeScaling: "fixed"` (`renderToSVG`, `specToSVG`, `chart.toSVG(sizing)`; Python `to_svg(sizing=..., preserve_aspect_ratio=..., stroke_scaling=...)`).
- **Analytical grid (`herceg/grid`):** sorting, filtering, grouping, pivots, remote data, and row selection.

**Framework adapters:** `@herceg/react`, `@herceg/vue`, and `@herceg/svelte`. Charts are written as components, while data updates bypass the framework.

**Python (`herceg`)**
- `hg.*` charts from pandas, Polars, PyArrow, and NumPy data, sent as binary columns;
- output to notebooks, HTML, SVG, PNG, and PDF;
- live notebook widgets and a Streamlit component, with camera state per 3D panel;
- `herceg.express`: Seaborn-style statistical charts with recompute on new data;
- helpful unknown-option errors for matplotlib names, restricted to the callable's supported options.
