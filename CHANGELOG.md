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
- **Export:** static SVG, PNG, and tagged multi-page PDF, without a DOM where possible.
- **Analytical grid (`herceg/grid`):** sorting, filtering, grouping, pivots, remote data, and row selection.

**Framework adapters:** `@herceg/react`, `@herceg/vue`, and `@herceg/svelte`. Charts are written as components, while data updates bypass the framework.

**Python (`herceg`)**
- `hg.*` charts from pandas, Polars, PyArrow, and NumPy data, sent as binary columns;
- output to notebooks, HTML, SVG, PNG, and PDF;
- live notebook widgets and a Streamlit component, with camera state per 3D panel;
- `herceg.express`: Seaborn-style statistical charts with recompute on new data;
- helpful unknown-option errors for matplotlib names, restricted to the callable's supported options.
