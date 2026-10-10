# Herceg

Herceg is an open source charting and visualization library for analytics
applications. Today it provides:

- a framework-independent engine whose core runs without a DOM;
- a serializable chart specification (`ChartSpec`);
- columnar, typed-array tables with streaming updates and rolling windows;
- line, area, bar, scatter, and heatmap marks, plus rule, region, and text
  annotations, that compose in one chart, and part-to-whole, hierarchy,
  flow, network, map, and 3D (scatter, line, and surface) charts;
- SVG and Canvas rendering, chosen per chart by how much it draws, and WebGL
  for large point series and large 3D charts, loaded only when a chart needs it;
- level-of-detail reduction for large line and area series;
- keyboard navigation, generated data summaries, and static SVG and PDF
  export;
- React, Vue, and Svelte components (`@herceg/react`, `@herceg/vue`,
  `@herceg/svelte`) whose data updates bypass the framework;
- a Python package (`python/`) for pandas, Polars, PyArrow, and NumPy data,
  with notebook, HTML, SVG, PNG, and PDF output, live notebook charts, and a
  Streamlit component.

## Status

Early development. The `herceg` package renders line, area, bar, scatter,
and heatmap marks and annotations with SVG or Canvas, streams data through columnar
tables, and renders static SVG and PDF without a DOM. `@herceg/react`,
`@herceg/vue`, and `@herceg/svelte` wrap it in React, Vue, and Svelte
components, and the Python package builds the same charts from dataframes
through the portable chart spec. The libraries are measured against Apache
ECharts, TanStack Charts, Chart.js, Plotly, and uPlot in a reproducible
benchmark suite.

- [packages/herceg](packages/herceg/README.md): usage.
- [packages/react](packages/react/README.md): React components.
- [packages/vue](packages/vue/README.md): Vue components.
- [packages/svelte](packages/svelte/README.md): Svelte components.
- [python](python/README.md): the Python package.
- [docs/architecture.md](docs/architecture.md): how it works and why.
- [docs/comparison.md](docs/comparison.md): feature and benchmark comparison.
- [benchmarks/README.md](benchmarks/README.md): benchmark methodology.
- [AGENTS.md](AGENTS.md): engineering principles and contribution rules.

## Roadmap

Done: columnar data model, scales, SVG and Canvas rendering, line, area
(stacked from several fields or from long data split by a series field,
zero or interpolated where a series has no row), bar
(vertical and horizontal, with value labels), point (with size, color,
opacity, and shape encoded by fields), heatmap (cells along number and time
axes that zoom and pan, or in bands, and calendars by week or by month),
error bar, candlestick (and
OHLC bars), histogram, pie (and donut), box plot, violin, treemap, sunburst, gauge,
funnel, radar, Sankey, network (graph), and map marks (choropleth regions and
points on Equal Earth, Natural Earth, Mercator, equirectangular, and conic
equal-area projections, from GeoJSON or packed geometry columns), 3D scatter,
line, and surface charts (orthographic or perspective, turned by dragging,
keys, and buttons, drawn back to front in SVG, Canvas, and PDF, and on the
GPU with a depth test when large: point clouds, long lines, and surfaces of
up to a million cells), monotone curves, named
color schemes and diverging color, built-in themes (light, dark, high
contrast, and one that follows the page) with CSS-variable theming, rule,
region, and text annotations from constants or data (with labels hidden or
moved where they would overlap), custom marks drawing
through the same renderers (with series, legends, and tooltips), derived
tables (filter, calculate, bin, aggregate, rolling windows, sort) with
portable expressions, level of detail, streaming updates (stacks of fields and of series
restacking only what appended and dropped rows touch), a shared
scheduler, browser interaction (tooltips, zoom along x, y, or both, range,
rectangle, and lasso brushing, events, synced cursors, zoom, and
selections, animated changes of view and of values (bars, pies, points,
and small lines and areas, with the axes they move), crosshair
labels on the axes), a range navigator (a strip under the plot, or under
all the panels of facets and subplots, over the whole x axis whose window
pans and zooms by pointer and keyboard), time
axes that leave out breaks (nights, weekends, holidays) in any time zone,
static SVG and PDF export (Unicode with opt-in `pdfFonts` and supplied
TrueType fonts), React, Vue, and Svelte adapters, min/max indexes for zooming
and streaming large line
series (whole columns or split by a series field), WebGL drawing of large
point series, chart specs with binary columns, a Python package, a second
y axis (in facets and subplots too, shared or per panel), small multiples
(wrapped or by row and column, with shared or per-panel x and y scales,
histograms, box plots, and violins summarizing each panel's rows,
annotations over a table drawing each row in its own panel, and categories
per panel for every mark on a category axis), points on category axes,
subplots (with weighted rows and columns), pies, treemaps, sunbursts, gauges, funnels, radars, and Sankey
diagrams in each facet panel or in a subplot of their own, live notebook charts (a widget that streams updates from Python
and reports interaction, tree drill roots, and network node positions back),
a Streamlit component with the same drill and move results, row views and
selection stores shared by charts and
grids (charts' brushes, lassos, and clicks select rows there and highlight what others select), maps that pan, zoom, and lasso their rows,
treemaps and sunbursts that drill into nodes with breadcrumbs, networks
with directed links, link labels, and nodes moved by dragging and keys
(each through the shared zoom, drag, and row selection options, with the
keyboard and a toolbar), row groups whose aggregates charts and grids share, and an
analytical grid (`herceg/grid`: virtualized rows and columns over the same
tables, sorting, row selection, nested groups with aggregates as a tree grid,
bounded pivots, columns resized, moved, pinned, and hidden by dragging, keys,
or a column menu, keyboard and ARIA navigation, and a React component), with
a remote mode (`herceg/grid/remote`) over rows that live elsewhere: a
portable grid query of filters, sorts, and groups that the source runs,
windows of typed columns loaded as they come into view from one snapshot,
focus and selection by key or condition, and conformance fixtures for
servers.

Next, in order:

1. Layout: maps, networks, and 3D charts in panels.
2. Animation of stacked and labeled bars, of categories that come and go,
   and of panels.
3. Linked selections beyond points, bars, lines, areas, maps, trees, and
   networks: highlighting bins, groups, cells, and spans whose rows are
   partly selected, lassos over summaries and networks, pies, Sankey
   diagrams, and trees in panels, drilling in panels, networks that pan and
   zoom and settle around moved nodes, and channels shared by separate
   notebook widgets (which report drills and moves).
4. More financial tools (drawing tools); 3D meshes, parametric surfaces, and translucent
   and wireframed surfaces on the GPU.
5. Grid: pivots over remote sources, bins in grid queries, a SQL
   generator for them, remote grids from Python, and editing.
6. PDF: optional shipped Unicode fonts, tagged output for assistive technology,
   and later bidirectional ordering/shaping and CFF fonts.
7. Screen-reader verification, benchmarks in Firefox and on other machines
   (WebKit and Chrome are measured), and an API review before a first release.
8. Heatmaps on log axes, calendar month labels aligned to week columns, and
   2D binning (density heatmaps from raw points).

## Development

Requires Node.js 22.12 or newer (TypeScript scripts run with
`--experimental-strip-types`), Google Chrome for browser tests and
benchmarks, Playwright's Firefox and WebKit builds for browser tests
(`npx playwright install firefox webkit`), and
[uv](https://docs.astral.sh/uv/) for the Python package.

```sh
npm install
npm run build
npm run lint
npm run typecheck
npm test
npm run test:browser
npm run test:package
npm run test:python
npm run test:python-package
npm run bench:size
npm run bench
```

See [AGENTS.md](AGENTS.md) for every command.

`test:browser` runs every browser suite (the engine's, the three adapters',
and the Python package's JavaScript) in Chrome, Firefox, and WebKit, in
about a minute; `HERCEG_BROWSERS=chromium` (or `firefox,webkit`) runs only
those. See [Browser tests](docs/architecture.md#browser-tests) for what each
engine is checked through.

`test:package` tests the built npm tarballs in a fresh consumer: packaged
files, exports, licenses matching the root LICENSE byte for byte, Node imports,
static SVG, and every entrypoint's declarations in NodeNext and bundler resolution
with `skipLibCheck: false`. Fixed public API fixtures catch missing or redirected
subpaths. Browser bundles for the engine and all three adapters require every
filesystem input to stay inside the consumer. It uses workspace peer versions
and build tools, with inherited npm workspace selectors cleared for packing and
installation. Vue template checking runs when `vue-tsc` and
its dependencies are available in npm's offline cache; otherwise it prints a
skip note. Run `build` first.

`test:python-package` builds the JavaScript bundles, sdist, and wheel, checks
the wheel's JavaScript files, then installs it and renders HTML in a fresh
virtual environment. It preserves uv cache and interpreter settings while removing
registry and source overrides, and tries uv offline first with a PyPI-only fallback.
Python must already be installed. Both checks remove their temporary projects;
pass `-- --keep-on-failure` to keep a failed project for inspection.

## License

MIT
