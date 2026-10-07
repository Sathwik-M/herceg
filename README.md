# Herceg

Herceg is an open source charting and visualization library for analytics
applications. It is designed around:

- a framework-independent engine with thin React (and later other framework)
  bindings;
- a portable, serializable chart specification shared by the TypeScript and
  Python APIs;
- columnar, typed-array data with low memory overhead and first-class streaming
  updates;
- SVG, Canvas, and GPU rendering paths chosen per workload;
- built-in level-of-detail handling for large datasets;
- accessibility and static export from the start.

## Status

Early development. The repository currently contains the benchmark harness and
a measured baseline of the libraries Herceg is compared against (Apache
ECharts, TanStack Charts, Chart.js, Plotly, and uPlot). Herceg itself does not
render charts yet.

- [docs/comparison.md](docs/comparison.md): feature and benchmark comparison.
- [benchmarks/README.md](benchmarks/README.md): benchmark methodology.
- [AGENTS.md](AGENTS.md): engineering principles and contribution rules.

## Roadmap

1. Foundation: portable chart spec, columnar data model, scales.
2. SVG renderer with line charts, axes, basic interaction, resize, and an
   accessibility baseline.
3. Canvas renderer, packed geometry, pixel-aware level of detail.
4. Incremental updates, rolling windows, and a dashboard scheduler.
5. Composition: area, bar, scatter, heatmap, annotations, custom marks.
6. React adapter.
7. GPU rendering for massive data, kept only where benchmarks justify it.
8. Python bindings with notebook support and static export.

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
