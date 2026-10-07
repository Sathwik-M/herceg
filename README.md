# Herceg

Herceg is an open source charting and visualization library for analytics
applications. Today it provides:

- a framework-independent engine whose core runs without a DOM;
- a serializable chart specification (`ChartSpec`);
- columnar, typed-array tables with streaming updates and rolling windows;
- line, area, bar, scatter, heatmap, and rule marks that compose in one chart;
- SVG and Canvas rendering, chosen per chart by how much it draws;
- level-of-detail reduction for large line and area series;
- keyboard navigation, generated data summaries, and static SVG export;
- React components (`@herceg/react`) whose data updates bypass React.

## Status

Early development. The `herceg` package renders line, area, bar, scatter,
heatmap, and rule marks with SVG or Canvas, streams data through columnar
tables, and renders static SVG without a DOM. `@herceg/react` wraps it in
React components. Both are measured against Apache ECharts, TanStack Charts,
Chart.js, Plotly, and uPlot in a reproducible benchmark suite.

- [packages/herceg](packages/herceg/README.md): usage.
- [packages/react](packages/react/README.md): React components.
- [docs/architecture.md](docs/architecture.md): how it works and why.
- [docs/comparison.md](docs/comparison.md): feature and benchmark comparison.
- [benchmarks/README.md](benchmarks/README.md): benchmark methodology.
- [AGENTS.md](AGENTS.md): engineering principles and contribution rules.

## Roadmap

Done: columnar data model, scales, SVG and Canvas rendering, line, area, bar,
point, heatmap, and rule marks, level of detail, streaming updates, shared
scheduler, browser interaction, static SVG, React adapter, min/max indexes
for zooming large line series.

Next:

1. Annotations, horizontal bars, error bars, and custom marks with pluggable
   geometry drawing (which also keeps unused mark kinds out of bundles).
2. Min/max indexes that update incrementally while very large series stream,
   and indexes for areas.
3. GPU rendering for massive data, kept only where benchmarks justify it.
4. Python bindings sharing the chart specification, with notebook support and
   static export.
5. Other framework adapters (Vue, Svelte).

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
