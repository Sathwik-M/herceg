# Herceg

Herceg is an open source charting and visualization library for analytics
applications. Today it provides:

- a framework-independent engine whose core runs without a DOM;
- a serializable chart specification (`ChartSpec`);
- columnar, typed-array tables with streaming updates and rolling windows;
- line, area, bar, scatter, and heatmap marks, plus rule, region, and text
  annotations, that compose in one chart;
- SVG and Canvas rendering, chosen per chart by how much it draws, and WebGL
  for large point series, loaded only when a chart needs it;
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

Done: columnar data model, scales, SVG and Canvas rendering, line, area, bar
(vertical and horizontal, with value labels), point (with size, color,
opacity, and shape encoded by fields), heatmap, error bar, candlestick (and
OHLC bars), histogram, pie (and donut), box plot, violin, treemap, sunburst, gauge,
funnel, radar, Sankey, network (graph), and map marks (choropleth regions and
points on Equal Earth, Natural Earth, Mercator, equirectangular, and conic
equal-area projections, from GeoJSON or packed geometry columns), monotone curves, named
color schemes and diverging color, built-in themes (light, dark, high
contrast, and one that follows the page) with CSS-variable theming, rule,
region, and text annotations from constants or data (with labels hidden or
moved where they would overlap), custom marks drawing
through the same renderers (with series, legends, and tooltips), derived
tables (filter, calculate, bin, aggregate, rolling windows, sort) with
portable expressions, level of detail, streaming updates, a shared
scheduler, browser interaction (tooltips, zoom along x, y, or both, range,
rectangle, and lasso brushing, events, synced cursors, zoom, and
selections, animated changes of view, crosshair labels on the axes), time
axes that leave out breaks (nights, weekends, holidays) in any time zone,
static SVG and PDF export, React, Vue, and Svelte adapters,
min/max indexes for zooming and streaming large line series, WebGL drawing
of large point series, chart specs with binary columns, a Python package, a
second y axis, small multiples (wrapped or by row and column, with shared or
per-panel x and y scales), subplots (with weighted rows and columns), live notebook charts (a
widget that streams updates from Python and reports interaction back), and a
Streamlit component.

Next, in order:

1. Large data: incremental updates for bars and point clouds split by a
   series field.
2. Layout: categories resolved per panel.
3. Animation of changed values (bars, pies) and of panels; leader lines for
   moved labels.
4. More financial tools (a range navigator, drawing tools, markers at
   breaks) and 3D.
5. Screen-reader verification, benchmarks in Firefox and on other machines
   (WebKit and Chrome are measured), and an API review before a first release.

## Development

Requires Node.js 22.12 or newer (TypeScript scripts run with
`--experimental-strip-types`), Google Chrome for browser tests and
benchmarks, and [uv](https://docs.astral.sh/uv/) for the Python package.

```sh
npm install
npm run lint
npm run typecheck
npm test
npm run test:browser
npm run test:python
npm run bench:size
npm run bench
```

See [AGENTS.md](AGENTS.md) for every command.

## License

MIT
