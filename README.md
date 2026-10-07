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
- keyboard navigation, generated data summaries, and static SVG export;
- React components (`@herceg/react`) whose data updates bypass React;
- a Python package (`python/`) for pandas, Polars, PyArrow, and NumPy data,
  with notebook, HTML, SVG, and PNG output.

## Status

Early development. The `herceg` package renders line, area, bar, scatter,
and heatmap marks and annotations with SVG or Canvas, streams data through columnar
tables, and renders static SVG without a DOM. `@herceg/react` wraps it in
React components, and the Python package builds the same charts from
dataframes through the portable chart spec. The libraries are measured
against Apache ECharts, TanStack Charts, Chart.js, Plotly, and uPlot in a
reproducible benchmark suite.

- [packages/herceg](packages/herceg/README.md): usage.
- [packages/react](packages/react/README.md): React components.
- [python](python/README.md): the Python package.
- [docs/architecture.md](docs/architecture.md): how it works and why.
- [docs/comparison.md](docs/comparison.md): feature and benchmark comparison.
- [benchmarks/README.md](benchmarks/README.md): benchmark methodology.
- [AGENTS.md](AGENTS.md): engineering principles and contribution rules.

## Roadmap

Done: columnar data model, scales, SVG and Canvas rendering, line, area, bar
(vertical and horizontal, with value labels), point, heatmap, and error bar
marks, rule, region, and text annotations from constants or data, custom
marks drawing through the same renderers, level of detail, streaming
updates, shared scheduler, browser interaction (tooltips, zoom, brushing,
events, synced charts), static SVG, React adapter, min/max indexes for
zooming and streaming large line series, WebGL drawing of large point series, chart specs
with binary columns, Python package.

Next:

1. Multiple y axes and small multiples.
2. More chart types: histograms (binning), box plots, candlesticks, pie and
   donut charts.
3. Live notebook charts (a widget that streams updates from Python) and PDF
   export.
4. Other framework adapters (Vue, Svelte).

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
