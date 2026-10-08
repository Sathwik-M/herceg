# Benchmarks

Reproducible comparisons between Herceg and other chart libraries. Results that
back published claims are committed in `results/`; everything else goes to
`tmp/benchmarks/` (gitignored).

```sh
npm run bench                        # full browser suite -> tmp/benchmarks/bench-<time>.json
npm run bench -- --lib echarts,uplot --filter line- --sample-scale 0.5
npm run bench -- --out results/browser.json   # refresh the committed results
npm run bench:size -- --out results/size.json # bundle sizes
npm run bench:react                  # herceg vs herceg through @herceg/react -> results/react.json
npm run bench:report                 # regenerate the tables in docs/comparison.md
```

Run these from the repository root. The browser suite drives the locally
installed Google Chrome through Playwright and opens a visible window. Leave the
machine otherwise idle while it runs.

## Layout

| Path | Contents |
| --- | --- |
| `src/datasets.ts` | Deterministic dataset generators (seeded PRNG). Every library receives identical values. |
| `src/scenarios.ts` | Scenario catalog: chart type, size, operation, sample counts. |
| `src/page/` | In-page harness and the adapter contract. |
| `src/adapters/` | One adapter per library. Each documents the configuration it uses. |
| `src/runner/` | Node runner: builds pages, serves them, drives Chrome, records results. |
| `src/size/` | Bundle size benchmark and its entry points. JavaScript and required CSS are reported separately. |
| `src/report.ts` | Writes Markdown tables into `docs/comparison.md`. |
| `results/` | Committed results with environment details. |

## Methodology

### Builds and pages

Each library gets its own production bundle (esbuild, minified,
`NODE_ENV=production`) containing the harness and that library's adapter, so a
page never loads two chart libraries. Every scenario runs in a fresh page.

### Browser

Google Chrome (the installed stable channel), headed, viewport 1280x1400 CSS
px, device pixel ratio 2, cross-origin isolated pages (COOP/COEP) so
`performance.now()` has 5 µs resolution, and:

- `--js-flags=--expose-gc`;
- `--disable-renderer-backgrounding --disable-background-timer-throttling
  --disable-backgrounding-occluded-windows`, so a covered window is not
  throttled;
- for every scenario except paced ingestion, `--disable-frame-rate-limit
  --disable-gpu-vsync`: frames are produced as soon as work allows, so waiting
  for a frame measures work instead of vsync alignment. Paced ingestion runs in
  a second browser with normal vsync, because frame pacing is what it measures.

### Timing

An operation starts when the harness calls the library and ends when the
library reports that rendering is complete and the next frame has been
produced. The frame boundary is a `MessageChannel` message posted from inside
`requestAnimationFrame`, which runs after the frame's style, layout, and paint.
This includes deferred work scheduled with `requestAnimationFrame` or
`ResizeObserver`. Libraries that render progressively over several frames
(ECharts scatter and heatmap series) expose completion through their adapter
(`finished` event), so timings cover the complete render, not the first
partial frame. Herceg's large point series wait for its on-demand WebGL
painter the same way (`chart.loading`).

GPU rasterization happens off the main thread and is not included. For
WebGL paths (Plotly `scattergl`, Herceg point clouds) that leaves out the GPU
executing the draw: forcing completion with a pixel read adds about 4 ms to
Herceg's 1,000,000-point scatter mount on the benchmark machine. Plotly's
WebGL timings have the same limitation.

Animations are disabled in every library, including ECharts' tooltip
transition. Tooltips are enabled unless a scenario says otherwise.

Each scenario has warmup iterations that are discarded, followed by measured
samples (see `src/scenarios.ts`; `--sample-scale` scales both). Reports show
the median and the median absolute deviation (MAD); raw samples, p95, and p99
are in the JSON files.

Libraries that need a different input format (row objects, `[x, y]` pairs)
convert the shared typed arrays inside their adapter, so timings include the
conversion, as they would in an application holding columnar data. The
conversion is also timed on its own and stored as `prepare` in the raw results;
treat it as a diagnostic, since a discarded conversion does not have the same
allocation and GC behavior as one the library retains.

### Operations

| Operation | Measures |
| --- | --- |
| `init` | Create a chart and finish rendering it; the chart is destroyed between samples. |
| `update` | Replace the complete dataset with another of the same shape. |
| `stream` | Append points to every series, drop the oldest to keep a fixed window, finish rendering; repeat. Each adapter uses the library's documented live-data API. |
| `ingest` | A timer appends data at a fixed rate (10, 60, or 100 Hz) for five seconds of wall-clock time while the display runs at its normal refresh rate. Records frame intervals, dropped frames (each frame interval spanning k refresh periods counts k - 1), long animation frames (over 50 ms), time spent inside append calls, and the ingestion rate actually achieved: a library that blocks the main thread receives fewer ticks. |
| `hover` | Real pointer moves dispatched through the DevTools Protocol, aimed at data points (mapped to pixels through each library's own coordinate API) so every library has a point to hit, to the next frame. Moves are spaced 70 ms apart so throttled hover handlers run for every event. |
| `resize` | Toggle the container between 800x400 and 600x300. |
| `zoom` | Show a sequence of x ranges covering 50%, 10%, and 1% of the data in turn, each centered further along (so ranges both zoom and pan), to the next frame. Each adapter uses the library's documented zoom or axis-range path: ECharts `dataZoom` (an `inside` component, `dispatchAction`), Chart.js scale `min`/`max` with `update('none')`, Plotly `relayout` of `xaxis.range`, uPlot `setScale`, TanStack Charts a new definition whose x scale is bound to the window with visible rows filtered (its zoom guide leaves filtering to the application), Herceg `setViewport`. |
| `dashboard` | Mount ten 600x250 line charts (15 series x 3,000 points each), then refresh all ten in one task. |
| `memory` | See below. |

### Memory

Memory is read with the Chrome DevTools Protocol after forced garbage
collection (`HeapProfiler.collectGarbage`, `Runtime.getHeapUsage`). The total
is the V8 heap plus the Blink (Oilpan) heap plus ArrayBuffer backing stores.
Backing stores matter: typed-array data lives there, and leaving them out would
hide columnar storage.

For each sample: baseline → create source data → mount charts → measure →
destroy charts and data → measure. Reported values:

- `retainedBytes`: heap growth from mounting the charts (source data excluded).
- `sourceBytes`: the source data itself.
- `canvasBytes`: estimated canvas backing stores (width x height x 4 per
  canvas). Not part of the heap number; GPU memory is not measured.
- `domNodes`: elements under the chart containers.
- `leakedBytes`: heap after destroying everything, relative to the baseline.

### Large-data configurations

Scenarios flagged `large` switch each library to the configuration its
documentation recommends for big data. The adapters record the exact options:

- ECharts: `sampling: "minmax"` for lines, `large: true` for scatter.
- Chart.js: `parsing: false`, `normalized: true`, min-max decimation for
  lines. Scatter keeps default parsing because its x values are unsorted.
- Plotly: `scattergl` (WebGL) traces.
- TanStack Charts: the opt-in Canvas host (`mountCanvasChart`).
- uPlot: no changes.

The sampling options reduce the number of drawn points with different bucket
rules (ECharts buckets by index, Chart.js by pixel). Their visual equivalence
to the full data has not been verified here.

Massive scenarios (10,000,000-point line, 1,000,000-point scatter) use the
same configurations. Libraries that run out of memory or time are recorded as
errors (`Target crashed`, `timed out after N s`) rather than left out; each
massive scenario gives a library 240 seconds (`--timeout` overrides every
scenario's limit). After an error the runner starts a fresh browser, since a
crashed tab can leave the old one unable to open pages.

### Fairness notes

- Libraries without a built-in chart type are reported as `n/a` (Chart.js
  heatmap, uPlot bar/scatter/heatmap) rather than benchmarked through
  third-party plugins.
- uPlot has no tooltip; its cursor and live legend are its hover readout.
- When zooming, Plotly keeps the y range it computed for all data, while the
  other libraries rescale y to the visible points (ECharts, Chart.js,
  TanStack Charts, uPlot, and Herceg recompute it), so Plotly does less work
  per zoom step.
- Canvas and SVG libraries are compared as they are. The renderer used by each
  configuration is recorded with the results.
- Results are from one machine. Compare libraries within a run, not across
  machines.

### React integration

`npm run bench:react` runs plain `herceg` and `herceg-react` (the same charts
through `@herceg/react`) in one session and writes `results/react.json`; it
is not part of the main comparison. The React adapter supports the line and
area scenarios. Mounting and resizing go through React props, rendered
synchronously with `flushSync`; data replacement and streaming change the
table directly, the adapter's documented path for live data. Each chart is
its own React root here, so per-root setup (event delegation on the
container) is counted once per chart; an application with one root pays it
once.

The `herceg-react-line` size entry leaves React and React DOM out of the
bundle, since an application using the adapter already ships them;
`herceg-vue-line` leaves Vue out for the same reason.
