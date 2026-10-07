# Herceg — instructions for contributors and coding agents

Herceg is an open source charting and visualization library. The job is to
design, implement, benchmark, test, document, and improve Herceg until it is a
credible alternative to Apache ECharts, TanStack Charts, Chart.js, and Plotly
for modern analytics applications.

Treat this as a real software project intended for long term use by other
developers. Do not optimize for generating a lot of code quickly. Optimize for
correctness, performance, memory use, API quality, maintainability, and clear
engineering decisions.

## Repository specifics

### Layout

| Path | Purpose |
| --- | --- |
| `packages/herceg` | (In development) The `herceg` npm package: portable spec types, data model, scales, marks, LOD, scene, SVG and Canvas renderers, DOM runtime. Optional pieces are subpath exports. |
| `packages/react` | `@herceg/react`, the React adapter (planned). |
| `python/` | The `herceg` Python package (planned). |
| `benchmarks/` | Benchmark harness, competitor adapters, scenarios, and committed results in `benchmarks/results/`. |
| `docs/` | Permanent documentation: architecture, vocabulary, comparison, benchmark methodology. |
| `tmp/` | Gitignored scratch space. Never commit anything from here. |

The suggested package split (`@herceg/core`, `@herceg/svg`, `@herceg/canvas`,
`@herceg/line`, ...) is implemented as subpath modules of one `herceg` package
rather than separate npm packages: one version, no internal version skew, and
tree shaking at module granularity gives the same bundle benefit. Packages are
split only where dependencies differ (React, Python, optional third-party
peers).

### Commands

Run from the repository root.

```sh
npm install              # install workspace dependencies
npm run build            # build the herceg package (tsc)
npm run lint             # biome lint + format check
npm run format           # apply biome formatting and safe fixes
npm run typecheck        # type check all TypeScript, including compile-time tests
npm test                 # unit tests (vitest, Node)
npm run bench:core       # engine microbenchmarks (Node)
npm run bench:size       # bundle size benchmark
npm run bench            # browser benchmark suite (Chrome); see benchmarks/README.md
npm run bench:report     # regenerate result tables in docs/comparison.md
```

Keep this list in sync with `package.json` as build, test, and Python commands
are added.

### Astra reviews

"Astra" is the Codex model `gpt-6-astra`. A significant-step review is run with
High reasoning effort and full permissions:

```sh
codex exec -m gpt-6-astra -c model_reasoning_effort="high" \
  --dangerously-bypass-approvals-and-sandbox -C "$PWD" \
  "$(cat tmp/reviews/<topic>-request.md)" < /dev/null > tmp/reviews/<topic>-response.md
```

Close stdin (`< /dev/null`); otherwise `codex exec` waits for more input.

Write the request into `tmp/reviews/`, keep the response there, and never commit
either.

## Core goal

Build Herceg as a framework independent visualization engine with:

- Excellent TypeScript ergonomics.
- A small core bundle.
- Natural React bindings without tying the core architecture to React.
- A portable chart grammar that can support other JavaScript frameworks.
- Python bindings with a Plotly-like user experience.
- Strong support for small, medium, large, and massive datasets.
- Excellent performance for charts whose data changes often.
- Low memory amplification over the source data.
- SVG, Canvas, and GPU rendering paths where each makes sense.
- Automatic or assisted renderer selection.
- Strong support for custom visualization composition.
- First class streaming and incremental updates.
- First class columnar data.
- Good accessibility.
- Strong static export support.
- Good notebook support.
- Human-readable, maintainable code.

The goal is not to copy the API of another chart library. Study good ideas from
existing libraries, then design a coherent system.

## Comparison libraries

At minimum, continuously compare Herceg with:

- Apache ECharts
- TanStack Charts
- Chart.js
- Plotly.js and Plotly Python

Where useful, also compare against libraries such as Recharts, Vega and
Vega-Lite, uPlot, Highcharts, D3, and Observable Plot. Do not add a library to
the benchmark suite unless the comparison provides useful information.

## Repository hygiene

- `tmp/` is gitignored. Put temporary plans, experimental scripts, generated
  investigation notes, throwaway benchmarks, screenshots, profiler captures,
  one-off data files, temporary test applications, and review transcripts in
  `tmp/` (for example `tmp/plans/`, `tmp/investigations/`, `tmp/profiles/`,
  `tmp/screenshots/`, `tmp/generated/`, `tmp/experiments/`,
  `tmp/one-off-tests/`, `tmp/reviews/`).
- Do not commit temporary artifacts.
- Establish baseline benchmark results for competing libraries before claiming
  Herceg is faster, smaller, or more memory efficient.
- Do not create a pile of planning documents in the repository. Permanent
  documentation describes the current project, its public architecture,
  supported behavior, benchmark methodology, current results, and planned
  work. Temporary reasoning belongs in `tmp/`.

## Design principles

### 1. Framework independent core

React must not be the core abstraction. The architecture should resemble:

```
TypeScript API / React bindings / Python bindings / Vue, Svelte bindings later
        |
        v
Portable chart specification
        |
        v
Chart compiler
        |
        +--> data execution
        +--> layout and visual execution
        |
        v
Rendering plan
        |
        +--> SVG
        +--> Canvas
        +--> WebGL or WebGPU
```

React components are an adapter and a convenient authoring syntax. They must not
create one React element per data point. High frequency data updates must be
able to bypass React rendering completely.

### 2. Portable chart grammar

The serializable chart specification must not depend on React, Python, DOM
APIs, Canvas APIs, JavaScript functions, or browser-specific state. It must be
usable from TypeScript, Python, and future bindings.

JavaScript-only callbacks may exist as escape hatches, but they must not define
the portable core. Prefer portable expression trees for filters, conditions,
encodings, and transforms.

### 3. Typed data model

Treat data as a first class subsystem. Support efficient storage based on
TypedArrays, shared x columns, columnar storage, Apache Arrow where useful,
dictionary encoded categorical data, fixed-capacity buffers, ring buffers for
streaming, and views into existing data instead of copies where possible.

Avoid creating JavaScript objects for every point in large datasets. Track
memory amplification from raw input to internal runtime structures.

### 4. Specialized internal representations

Do not force every visualization into one generic scene graph.

```
small line   -> SVG path
dense line   -> packed Canvas geometry
massive line -> GPU buffer
scatter      -> packed point storage
heatmap      -> dense grid or texture
bar          -> compact rectangle geometry
text/axes    -> appropriate text and vector representation
```

A generic scene graph is fine for ordinary visual objects. It must not require
millions of generic scene nodes for millions of values.

### 5. Multiple renderers

Support SVG, Canvas 2D, and WebGL and/or WebGPU where they make sense. Do not use
GPU rendering just because it sounds faster. Benchmark it.

The runtime should eventually select renderers automatically based on mark type,
point count, chart dimensions, device pixel ratio, update frequency,
interaction requirements, number of charts on the page, available GPU
capabilities, and memory budget. Renderer selection must be overridable. Where
useful, different marks in the same visualization may use different render
paths (axes and labels in SVG, dense lines in Canvas or GPU, tooltips in HTML,
annotations in SVG).

### 6. Incremental updates

Frequent updates are a primary workload. Support append, append batch, replace
range, replace tail, drop before timestamp, update value, update column, change
viewport, and change style without rebuilding data. Do not require replacing
and reparsing the complete dataset when one value changes.

For streaming charts, investigate ring buffers, incremental geometry updates,
incremental LOD updates, persistent GPU buffers, partial GPU uploads, frame
coalescing, dirty region rendering, and offscreen chart throttling.

### 7. LOD and sampling

Level-of-detail handling is part of the architecture, not a late optimization.
Investigate and benchmark min/max buckets, first/min/max/last envelopes, LTTB,
pixel-aware sampling, aggregation by screen column, density reduction, and
hierarchical LOD pyramids.

Keep source data separate from represented data. Zooming should select an
appropriate resolution rather than repeatedly processing every source point.
Incrementally update LOD structures when new data arrives where practical.

### 8. Interaction engine

Do not perform generic linear nearest-point scans when a better method exists.
Use workload-specific approaches:

```
sorted time series  -> binary search
shared timestamps   -> one lookup followed by column reads
scatter             -> spatial grid, quadtree, or similar index
massive GPU scatter -> investigate GPU picking
bars                -> direct geometry lookup
heatmaps            -> coordinate-to-cell mapping
```

Benchmark pointer movement, tooltip latency, zooming, brushing, linked cursors,
and selection.

### 9. Dashboard scheduler

Multiple charts must cooperate. Build toward a scheduler that coalesces updates
into one frame, avoids redundant work, pauses or reduces rendering for
offscreen charts, prioritizes visible charts, limits work to the display refresh
rate, shares data and expensive transforms between charts that use the same
source, and supports synchronized axes and cursors efficiently.

### 10. Bundle size

Keep optional functionality optional. A basic line chart must not pull in every
renderer, every chart type, Python support, Arrow, GPU code, or large optional
dependencies. Measure raw, minified, gzip, and brotli size, and parsed
JavaScript where useful. Test tree shaking.

### 11. Python bindings

Design Python support from the start. The Python API should feel natural to
Python users; do not expose JavaScript-shaped objects just because the
TypeScript implementation uses them.

Target NumPy, pandas, Polars, PyArrow, Python sequences, and DuckDB where
practical. Support Jupyter, JupyterLab, VS Code notebooks where practical, HTML
output, static PNG, static SVG, PDF export where practical, and browser
embedding.

Avoid converting large datasets into Python dictionaries followed by JSON when a
columnar or binary path is available. TypeScript and Python share semantics
through the portable chart spec; they do not need identical syntax.

### 12. Rust or WASM

Evaluate Rust and WASM for sampling, LOD construction, data transforms, binning,
spatial indexing, geometry generation, and Arrow processing — only where they
measurably help. Do not move code to Rust or WASM without benchmarks. Do not
make small charts pay a WASM startup or bundle penalty. Keep browser
integration, plugins, accessible DOM work, and framework adapters in the
environment where they are easiest to maintain unless benchmarks justify
another approach.

## API quality

The TypeScript API must have strong type inference. Avoid public APIs full of
`any`, `unknown`, or `Record<string, unknown>` unless the domain really requires
them. Field references should infer from the dataset where possible, and invalid
numeric encodings should fail at compile time where reasonable.

React should support a natural compositional API in the spirit of:

```tsx
<Chart data={data}>
  <XAxis field="timestamp" />
  <Line x="timestamp" y="latency" groupBy="service" />
  <Area y1="p25" y2="p75" />
  <Rule y={250} />
  <Tooltip mode="nearest-x" />
</Chart>
```

Do not implement that exact API blindly. Test different designs. Prefer APIs
that are easy to learn, hard to misuse, and easy to maintain.

## Visualization grammar

Support high level chart helpers and lower level composition. Line, area,
points, rules, bands, annotations, custom glyphs, and custom geometry should
share scales, coordinates, axes, viewport, selection, tooltip behavior, data,
and transforms. Do not require a special chart component for every useful
combination. Provide escape hatches for custom marks and custom renderers
without making common use cases complicated.

## Chart types

The long term target covers strong versions of the major chart families:

- Cartesian: line, step line, area, stacked area, bar, grouped bar, stacked bar,
  scatter, bubble, range, error bars, candlestick/OHLC, box plot, histogram,
  density, waterfall.
- Part-to-whole and hierarchical: pie, donut, sunburst, treemap.
- Matrix and density: heatmap, calendar heatmap, large scatter density, hexbin.
- Flow and relationships: Sankey, graph/network, chord where justified.
- Specialized: radar, gauge, funnel, parallel coordinates, polar, geographic
  maps if the architecture supports them cleanly, financial charts, real-time
  telemetry charts.

Do not implement all of these before the core architecture proves itself. Start
with line, scatter, bar, area, and heatmap. They prove scales, layout,
interaction, large data behavior, streaming, multiple renderers, and
composition.

## Comparison matrix

Maintain the permanent comparison in `docs/comparison.md` and machine-readable
benchmark data in `benchmarks/results/*.json`.

Compare at least: line, bar, area, scatter, heatmaps, streaming, large and
massive datasets, frequent updates, annotations, custom marks, composition, zoom
and pan, brushing, selection, linked charts, synchronized cursors, tooltips,
legends, axes, multiple axes, responsive layout, themes, animations,
accessibility, SVG/Canvas/GPU rendering, static export, SSR, notebook support,
Python bindings, framework integrations, TypeScript quality, bundle size,
startup cost, memory use, update cost, interaction latency, documentation
quality, API complexity, and extensibility.

For every comparison include both strengths and weaknesses. Do not manipulate
scenarios to make Herceg win. If another library wins, record it. Do not reduce
the table to arbitrary scores; use measurements where they exist and short
written findings where they do not. Record benchmark environment details.

The summary table includes at least these rows for Herceg, ECharts, TanStack
Charts, Chart.js, and Plotly: initial render, incremental update, streaming,
memory, bundle size, line, scatter, heatmap, composition, TypeScript, React,
Python, accessibility, export, ease of use.

## Benchmark scenarios

- **Small:** 1–4 series, 20–200 points each, single mostly static chart.
  Measure startup overhead and bundle cost.
- **Medium:** 5–10 series, 1,000–5,000 points each, interactive.
- **Dashboard (core target):** 10 charts, up to 15 line series per chart, up to
  3,000 points per series, up to 450,000 source points total, linked cursor,
  periodic refresh.
- **Large:** 100,000–1,000,000 points, single visualization, zoom and hover.
- **Massive:** 1M, 5M, 10M+ points, only for chart types where that makes sense.
- **Streaming:** 1, 10, 20, 60 Hz, and 100 Hz ingestion with rendering coalesced
  to frames. Append one point, append batch, rolling window, replace tail,
  change style while streaming, zoom while streaming, cursor while streaming.
- **Multi-chart memory:** 10, 25, 50, 100 small charts. Find out whether Canvas
  backing buffers, duplicated datasets, scene structures, or framework overhead
  dominate memory.

Benchmark line, multi-line, bar, scatter, heatmap, and area; later candlestick,
box plot, large scatter, graph, Sankey, and geographic rendering if supported.

### What to measure

- Performance: initialization, first render, time to interactive, update
  latency, frame time, dropped frames, p50/p95/p99 frame time, zoom latency, pan
  latency, pointer/tooltip latency, series toggle latency, resize latency,
  streaming append cost.
- Memory: JS heap, retained heap, backing store and GPU memory where
  measurable, source data size, runtime memory amplification, memory after
  repeated updates, memory after destroying charts, signs of leaks.
- Bundle: install size where relevant, imported module size, minified, gzip,
  brotli, tree-shaken application bundle.
- Correctness: visual regression, axis, scale, tooltip, zoom, resize,
  serialization, accessibility behavior, export.

Use identical datasets and equivalent visual behavior when comparing libraries.

### Benchmark rules

Benchmarks must be reproducible. Record browser and version, operating system,
CPU, GPU, device pixel ratio, viewport size, library versions, build mode,
benchmark commit, warmup strategy, sample count, and raw results.

Do not compare development builds for production performance. Run enough samples
to avoid conclusions from one run. Keep raw results. Report variance. Separate
initial render, steady state, incremental update, interaction, memory, and
bundle size. Never claim "X times faster" from one unstable measurement.

### Benchmark honesty

Never optimize only for the benchmark. Watch for benchmarks that reward
behavior users would not want: dropping data without saying so, reducing visual
quality, disabling interaction, using a different chart than competitors,
measuring only initialization while ignoring updates, excluding setup work for
Herceg but including it for another library, keeping data resident for Herceg
while forcing competitors to rebuild it, or comparing Canvas against SVG without
explaining the renderer difference. Comparisons must be useful to users, not
marketing.

## Memory rules

Watch for hidden duplication across source data, normalized data, transformed
data, LOD data, geometry, interaction indexes, scene representation, renderer
buffers, GPU buffers, and framework state. Minimize unnecessary copies; share
data where it is safe. Include memory amplification in the comparison table.

## Testing

Maintain unit, integration, visual regression, browser, benchmark, type,
package, framework adapter, and (where practical) memory leak tests. Test happy
paths and failure cases, cleanup and destruction, repeated mount/unmount of many
charts, renderer changes, SSR where supported, accessibility output, and Python
serialization separately from JavaScript rendering.

### Visual correctness

Performance wins do not count if visual output is wrong. Keep reference cases
for scales, stacked data, missing values, NaN, infinities, negative values,
logarithmic scales, timestamps, time zones, irregular time intervals,
categorical axes, very large and very small values, empty datasets, single
point datasets, dense data, resized containers, and high and low DPR.

## Accessibility

Accessibility is not a later patch. For small SVG charts, investigate direct
semantic accessibility. For Canvas and GPU charts, provide an accessible
representation suitable for keyboard and screen-reader use. Consider chart
title, description, series descriptions, data summaries, keyboard navigation,
focus behavior, high contrast, reduced motion, and an accessible data table or
equivalent. Benchmark the cost of accessibility structures for large charts.

## Ease of use

For common tasks (basic line chart, multi-series chart, custom tooltip,
annotation, synchronized charts, streaming update, 100k point line, custom mark,
theme, export, Python notebook chart), compare how much code and how many
concepts each library requires. Do not game this through line count alone.
Judge API clarity, type errors, discoverability, required boilerplate,
customization difficulty, escape hatches, and debugging experience.

## Documentation rules

Permanent documentation reflects the repository as it exists now. Do not leave
phrases like "the agent should...", "next we will...", "as discussed
earlier...", or "we originally planned..." unless they belong in an explicit
roadmap or architecture decision record. Documentation must make sense to a
developer who finds the repository with no conversation context. When an
implementation is removed, remove its documentation. Do not maintain redundant
documents.

Permanent docs focus on: what Herceg is, what works today, how to use it,
architecture, supported APIs, benchmark methodology, benchmark results, known
limits, and roadmap.

## Code quality

The code should look like experienced humans maintain it.

Prefer small clear modules, direct names, explicit ownership of data, simple
control flow, comments that explain why, tests that describe behavior, and
boring code where boring code works.

Avoid unnecessary abstraction, speculative frameworks, wrapper layers with no
real purpose, giant files, giant generic types, clever type tricks that make
errors unreadable, unnecessary dependency injection, excessive factory
patterns, generated-looking comments, comments that repeat the code, huge prose
comments, placeholder abstractions, and generic utility folders full of
unrelated helpers.

Write code that another engineer can safely change.

### Naming

A concept has one name. Do not call the same thing series, trace, layer,
dataset, and mark in different places unless they mean different things. The
core vocabulary is defined in `docs/architecture.md`; keep code and docs
consistent with it.

## Significant-step review with Astra

Before every significant commit, request a review from Astra (see "Astra
reviews" above) with High reasoning and full permissions. Significant steps
include architectural decisions, public API changes, renderer implementations,
data model changes, benchmark infrastructure changes, memory model changes,
streaming changes, new chart families, Python binding changes, serialization
format changes, build/package restructuring, major performance work,
accessibility architecture, and major documentation changes.

Give Astra enough context to review the actual implementation, and ask it to
inspect correctness, architecture, API design, performance risks, memory risks,
TypeScript ergonomics, framework coupling, Python portability, bundle impact,
testing gaps, benchmark fairness, maintainability, unnecessary complexity, and
likely regressions. Ask for concrete problems and specific corrections, not
encouragement.

Review the feedback critically and do not apply suggestions blindly. Fix valid
issues before committing. Record permanent architectural decisions only when
they matter to future contributors. Do not commit raw review transcripts.

## Commits

Commit at important, coherent steps (for example: build benchmark harness, add
columnar dataset core, implement SVG line renderer, add incremental append
path, add React adapter). Do not commit every tiny edit and do not combine
unrelated changes. Each commit leaves the repository clean and tested.

Use short descriptive messages such as "Add columnar dataset storage" or
"Implement Canvas line renderer". Avoid "updates", "work", "changes", "misc
fixes", "AI improvements", "final".

### Required pre-commit process

1. **Review the change.** Inspect the complete diff. Confirm it is coherent,
   unrelated and temporary code is removed, naming is consistent, public APIs
   are intentional, and the code is easy to review.
2. **Clean the repository.** Remove temporary artifacts, debug logging, unused,
   obsolete, and one-off code and tests, abandoned experiments, commented-out
   experiments, stale generated files, stale or duplicate documentation, and
   unused dependencies. Inspect `tmp/`, delete what is no longer needed, and
   confirm nothing in it is staged.
3. **Run correctness checks.** Formatters, linters, type checks, unit,
   integration, browser, and visual tests, Python tests, and package build
   tests — everything relevant.
4. **Run relevant benchmarks.** At least every benchmark relevant to the changed
   subsystem; the full comparison suite for significant performance-sensitive
   commits.
5. **Check Herceg against competitors.** For the changed area, compare with
   ECharts, TanStack Charts, Chart.js, and Plotly: where Herceg is better,
   worse, roughly equal, not implemented, or not yet measured. No claimed wins
   without evidence.
6. **Update the comparison table** when results or supported features changed,
   and only then.
7. **Check objectives.** Verify the affected objectives: performance, memory,
   bundle size, correctness, TypeScript ergonomics, framework independence,
   React ergonomics, Python portability, composition, accessibility, ease of
   use, maintainability. If one gets worse, record why the tradeoff is
   acceptable.
8. **Astra review** for significant commits. Resolve valid issues; where a
   suggestion is rejected and it matters, record why.
9. **Final diff inspection** after fixes and cleanup. Do not commit files you did
   not mean to change.
10. **Commit.**

## Regression policy

Maintain benchmark baselines. When a commit causes a measurable regression:
confirm it is reproducible, find the source, fix it when practical, document
the reason if it is an intentional tradeoff, and update comparison data. Do not
silently accept regressions. Set regression thresholds once benchmark noise is
understood, and eventually automate suitable regression checks in CI.

When a feature is removed or behavior changes: update tests, documentation, and
comparison tables, document migration impact for public APIs, and remove
obsolete implementation and examples. Do not leave fake compatibility layers
unless they provide real value.

## Implementation order

Unless the repository gives a strong reason to change it:

1. **Foundation:** repository structure, AGENTS.md, test infrastructure,
   benchmark infrastructure, comparison baseline, portable chart spec, core
   data model, scale primitives.
2. **First useful renderer:** SVG renderer, line chart, axes, basic interaction,
   resize, accessibility baseline. Use this to prove correctness and API design.
3. **Dense data:** Canvas renderer, packed line representation, typed columns,
   shared x data, efficient nearest-x lookup, LOD/sampling, performance and
   memory comparison.
4. **Updates:** incremental append, batch append, rolling windows, dirty
   updates, scheduler, streaming benchmarks.
5. **Composition:** areas, bars, scatter, annotations, custom marks, shared
   scales, multi-view charts.
6. **React:** a thin adapter over the stable core. Confirm high frequency
   updates bypass React. Benchmark React integration separately.
7. **Massive data:** GPU renderer investigation, WebGL/WebGPU prototype,
   persistent buffers, massive scatter and line, GPU picking where useful. Keep
   it only if benchmarks justify it.
8. **Python:** Pythonic API, spec serialization, NumPy, pandas, Polars, PyArrow,
   notebook rendering, HTML output, static export strategy.
9. **Broader chart coverage** based on architecture quality, user value, and
   comparison gaps. Do not sacrifice core quality to maximize chart count.

## Success criteria

- **Small charts:** fast to initialize, small to download, accessible, easy to
  use, visually correct.
- **Dashboards:** low memory, fast to update, responsive during interaction,
  efficient across many chart instances, able to share data, synchronized
  interaction.
- **Large charts:** bounded rendering work, efficient data storage, low
  interaction latency, useful LOD behavior, predictable memory use.
- **Massive charts:** GPU rendering where beneficial, source data retained
  without huge object graphs, zoom and interaction without rebuilding
  everything.
- **Developers:** strong TypeScript, readable errors, clear concepts, useful
  composition, good documentation, framework independence, natural React and
  Python bindings, a stable portable chart grammar.

At every major design decision ask: does this make Herceg better for real chart
workloads, or does it only make the architecture look clever? Prefer the former.

Keep the repository clean. Keep measurements honest. Keep APIs simple. Keep
performance measurable. Keep memory visible. Keep framework bindings outside the
core. Commit meaningful progress in small, reviewable units.
