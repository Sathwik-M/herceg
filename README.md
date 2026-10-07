# Herceg

Herceg is an open source charting and visualization library for analytics
applications. Today it provides:

- a framework-independent engine whose core runs without a DOM;
- a serializable chart specification (`ChartSpec`);
- columnar, typed-array tables with streaming updates and rolling windows;
- SVG and Canvas rendering, chosen per chart by how much it draws;
- level-of-detail reduction for large line and area series;
- keyboard navigation, generated data summaries, and static SVG export.

## Status

Early development. The `herceg` package renders line, area, and rule marks
with SVG or Canvas, streams data through columnar tables, and renders static
SVG without a DOM. It is measured against Apache ECharts, TanStack Charts,
Chart.js, Plotly, and uPlot in a reproducible benchmark suite.

- [packages/herceg](packages/herceg/README.md): usage.
- [docs/architecture.md](docs/architecture.md): how it works and why.
- [docs/comparison.md](docs/comparison.md): feature and benchmark comparison.
- [benchmarks/README.md](benchmarks/README.md): benchmark methodology.
- [AGENTS.md](AGENTS.md): engineering principles and contribution rules.

## Roadmap

Done: columnar data model, scales, SVG and Canvas rendering, line/area/rule
marks, level of detail, streaming updates, shared scheduler, browser
interaction, static SVG.

Next:

1. Bar, scatter, and heatmap marks; annotations; custom marks.
2. A min/max pyramid for zooming and streaming over very large series.
3. React adapter, with high-frequency updates that bypass React rendering.
4. GPU rendering for massive data, kept only where benchmarks justify it.
5. Python bindings sharing the chart specification, with notebook support and
   static export.
6. Other framework adapters (Vue, Svelte).

## Development

Requires Node.js 22.12 or newer (TypeScript scripts run with `--experimental-strip-types`)
and Google Chrome for browser benchmarks.

```sh
npm install
npm run lint
npm run typecheck
npm run bench:size
npm run bench
```

## License

MIT
