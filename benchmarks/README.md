# Benchmarks

Reproducible comparisons between Herceg and other chart libraries. Results that
back published claims are committed in `results/`; everything else goes to
`tmp/benchmarks/` (gitignored).

```sh
npm run bench                        # full browser suite -> tmp/benchmarks/bench-<time>.json
npm run bench -- --lib echarts,uplot --filter line- --sample-scale 0.5
npm run bench -- --out results/browser.json   # refresh the committed results
npm run bench:size -- --out results/size.json # bundle sizes
npm run bench -- --browser webkit --headless --out results/browser-webkit.json   # the suite in WebKit
npm run bench:react                  # herceg vs herceg through @herceg/react -> results/react.json
npm run bench:grid                   # grid suite (see "Grids") -> tmp/benchmarks/grid-<time>.json
npm run bench:grid-remote            # remote grids (see "Remote grids") -> tmp/benchmarks/grid-remote-<time>.json
npm run bench:report                 # regenerate the tables in docs/comparison.md
npm run bench:express -- --out results/express.json   # herceg.express timings (Python)
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
| `src/grid/` | The grid suite: fixture, reference, scenarios, harness, runner, report, and one adapter per grid in `src/grid/adapters/`; the remote grid benchmark in `src/grid/remote/`. |
| `src/report.ts` | Writes Markdown tables into `docs/comparison.md`. |
| `python/express.py` | Timings of `herceg.express` (Python), with Seaborn's and statsmodels' computations beside them; run in the Python package's uv environment. |
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

`--browser webkit` runs the suite in Playwright's WebKit build (the engine of
Safari, not Safari itself; `npx playwright install webkit`), and `--browser
firefox` in its Firefox build with `layout.frame_rate` 0 so frames come as
soon as work allows. WebKit has no such setting: frames follow the display,
so every WebKit timing includes waiting for the next frame from wherever the
operation started (pointer moves from when the event arrives), and
differences under a frame are noise. WebKit runs headless: on macOS,
Playwright's headed WebKit windows that are not frontmost get throttled
frames (hundreds of milliseconds apart, for every library). Results record the Playwright version,
the browser build, and the idle frame cadence. Memory scenarios need Chrome's
DevTools protocol and are skipped in other browsers, as are long-animation-
frame counts in browsers that do not report them. Playwright's Firefox build
does not start on macOS 27 ("Could not find profile folder"), so no Firefox
results are committed.

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

Bundle sizes count what a page loads before the chart renders: the entry
chunk and the chunks it imports statically, each compressed on its own as
browsers fetch them. Chunks reached only through dynamic imports (Herceg's
WebGL painter, animation, crosshair labels) are reported separately as
loaded on demand.

The `herceg-react-line` size entry leaves React and React DOM out of the
bundle, since an application using the adapter already ships them;
`herceg-vue-line` leaves Vue out and `herceg-svelte-line` Svelte's runtime
for the same reason. The Svelte entry renders a component of its own,
compiled with `svelte/compiler`, and that component is measured with it.
The `herceg-grid` entry mounts a two-column grid (`herceg/grid`) over the
same data instead of a chart; none of the other libraries has a grid to
compare it with. `herceg-bar`, `herceg-area`, and `herceg-scatter` chart
the same data as stacked bars, stacked areas (both split by a series
field), and points, to track what each mark adds; the other libraries
have line entries only.

## Grids

`npm run bench:grid` compares Herceg's grid (`herceg/grid`, and the same grid
through `@herceg/react/grid`) with TanStack Table and TanStack Virtual, AG
Grid Community, and Glide Data Grid.

```sh
npm run bench:grid                                   # every scenario -> tmp/benchmarks/grid-<time>.json
npm run bench:grid -- --size 10k,100k --lib herceg,ag-grid --filter sort
npm run bench:grid -- --out results/grid.json        # refresh the committed results
node --experimental-strip-types benchmarks/src/grid/report.ts <results file>   # print the tables
```

Options: `--lib`, `--size` (`10k`, `100k`, `1m`, `1m-wide`), `--scenario`,
`--filter`, `--sample-scale`, `--timeout` (seconds), `--headless`, `--dpr`
(device pixel ratio, 1 by default), `--seed` (the fixture's values), and
`--order-seed` (libraries run in a seeded random order within each scenario,
so drift over a run does not favor one of them). Every scenario runs in a fresh page; a crash or timeout is
recorded as an error and the browser is restarted.

### Fixture

One seeded columnar table (`src/grid/fixture.ts`): per group of 20 fields, 16
numbers, 2 times, and 2 categories. Numbers follow different distributions
(uniform, integer with many ties, heavy-tailed, tiny, large, constant), some
with missing values; one time increases with the row and one is random with
missing values; one category has 8 labels with skewed frequencies and one has
1,000, both with missing values and with dictionary codes that do not follow
label order. About 0.5% of rows repeat the previous row in every field.
Sizes: 10,000 x 20 (overhead), 100,000 x 20 (the primary workload), and
1,000,000 x 20 and 1,000,000 x 100 (five independent groups; about 760 MB of
column buffers) as stress cases, which run a smaller set of scenarios once or
a few times. A stress case that fails is recorded as failing.

Numbers and times are `Float64Array` (NaN for missing values) and categories
`Int32Array` codes into a dictionary. Grids that take row objects get them
from `rowObjects` (missing values `undefined`, categories as labels); that
conversion is timed with mounting in "from the columns" and alone as
"conversion". Herceg adopts the arrays without copying them; Glide's adapter
reads them through `getCellContent`.

### Same grid for every library

1200 x 600 CSS pixels, 28 px rows, a 32 px header, 120 px columns, Arial
13 px, no wrapping, autosizing, or animation, and 10 rows of overscan where
it can be set. Cells read the same: `en-US` numbers with two decimals and no
minus sign on values that round to zero, times in UTC as `MM/DD/YYYY,
HH:MM:SS`, and an em dash for missing values (`FORMAT` in the fixture).
Herceg takes these as Intl options on its columns; the other adapters call
the same formatters when they render a cell.

### Verification

`src/grid/reference.ts` computes, independently of the adapters, what each
grid should show: rows filtered (ranges inclusive, missing values never
pass), sorted (numbers and times numerically, categories by label, missing
values last in both directions, ties by row identity), with each cell's
text. Every adapter reports what it shows (`visible()`): the row count its
rendered extent stands for, row identities, cell text, and selection, read
from its DOM rows and cells by geometry, or for Glide, which draws on a
canvas, the region it reported drawing and, for each cell, the row identity,
text, and highlight Glide last drew there, recorded through its `drawCell`
hook (which then draws the cell as usual; canvas pixels are not read).
Herceg's rows carry no identity in the DOM, so they are checked by their
cells' text alone: a row that repeats its neighbor in every field could
stand in for it unnoticed. A timed operation
ends at the first frame whose row count, rows, columns, text, and selection
match the reference at the grid's scroll offset, so a frame with blank rows,
stale cells, or a change not yet applied does not count; a grid that never
shows the right result within 30 s is reported `incorrect` and not timed.
Before timing, each scenario also compares the library's complete display
order and row count with the reference, and streaming trials compare them
after their last tick.

Changes that the checks would not see are avoided: updates change a field
in view, and appends below the viewport change the row count. Adapters made
to drop, halve, or misapply updates, appends, sorts, selections, or scroll
offsets were all reported incorrect when this was written; one that delays
updates came out slow, with unresolved ticks.

### Timing

As for charts, an operation starts when the harness calls the adapter. The
harness checks what the grid shows just before each frame paints, in a
ResizeObserver callback (which runs after the frame's animation callbacks
and layout), and the time is taken when that frame has been produced.
Checking after the frame instead would count work done in tasks queued
before the check, such as a React update scheduled by a scroll event, as if
the frame had shown it. This is the state observed at that point, not proof
of what the compositor presented: a library's own ResizeObserver running
later in the same frame could still change it (none does in these
scenarios, which do not resize). A frame in which the observer did not run
is counted as unobserved and never as correct. Times are raw: they include
the check (reading the visible rows and cells), whose cost is recorded as
`checkTime`.
Results record how many frames each operation took (`frames`): Glide, which
redraws after a scroll in a React update that runs after the frame, takes
two.

Between samples the harness collects garbage and pauses on a timer: after
frames that change nothing, Chrome waits for the display's next refresh
before producing another frame even with the frame rate limit off, which
would add about a refresh interval to whatever came next. Measurements are
therefore of an idle start with garbage collected; paced scenarios run with
vsync.

| Operation | Measures |
| --- | --- |
| `mount` | Create the grid from prepared native input, and from the shared columns (conversion included), to the first correct frame; destroy it. |
| `scroll` | 40 steps of the body's scroll offset (a screen down, three columns across, both, or to the last row and back), each to its correct frame. Herceg's grid scales scrolling above 8 million pixels of rows, so at 1M rows a scroll lands within one scaled pixel of the requested offset. |
| `scroll-trace` | Three seconds with vsync of scrolling down at 3,000 px/s (and across at 1,500 px/s for `diagonal`), the offset set every frame from the time elapsed; or (`wheel`) wheel events of 50 px every 16 ms, which the runner sends through the DevTools protocol on a fixed schedule without waiting for the page, while the page asks for them. Frame intervals, dropped frames, long animation frames, incomplete frames (frames that, just before painting, did not show the rows for the offset the body was at: blank rows on a DOM grid, content drawn for an earlier offset on a canvas grid), and for wheel traces the events received and distance scrolled within the trial. |
| `sort`, `filter` | From source order to the result, each sample from a reset grid; also the time inside the library's call. |
| `select` | Under a sort, select one displayed row, or the first half of the rows in display order, and read the selection back. |
| `append` | An offered load with vsync: 50 slots over 5 s, one per 100 ms, each after the first moved by a seeded amount up to a refresh interval (so ticks do not all land at one phase of the frame), in which ticks append 1,000 rows each (evicting the oldest 1,000 in the `rolling` cases, under a number sort in the `sorted` ones). Latency from each call to the frame showing its result, the first tick (which may copy data before its first write) apart from the rest, time inside the call, how late each tick was against the schedule, ticks delivered of those offered (a grid that blocks the main thread past its next slots misses them), ticks overtaken before they showed, and the intervals, dropped frames, and long animation frames of the frames that began within the offered period. Every trial starts from a newly mounted grid. |
| `update` | The same with 100 rows changed per tick, 10 of them on screen: a field no query reads, the sort key, or the filtered field. |
| `memory` | Heap after creating the fixture, after converting it, with the grid mounted, after a sort, a second after destroying the grid, after two rounds of five more mounts, and after releasing everything; each sample in a fresh page. |

Streaming ticks keep the grid at the top (`scrollTo(0, 0)` after each
change), as a live view of the top of its order does: Herceg keeps the rows
in view in place when sorted rows arrive above them, so it has to be asked;
for the other grids, which keep the pixel offset, the call does nothing.

### Memory

Heap readings are those of the chart suite (V8, Blink, and ArrayBuffer
backing stores after forced garbage collection), one fresh page per sample.
What the harness needs to check the sort is computed before the readings
that count. "Reserved" growth is the heap V8 has committed (with the Blink
heap and backing stores), without collecting garbage, after mounting less
before: how much mounting made the heap grow, not its peak, which these
readings cannot see. The heap a second after destroying a grid, and after
five more mounts, shows what a library keeps once destroyed; the growth per
further mount is the difference between two rounds of five. When this was
written, heap snapshots showed TanStack Table keeping its last destroyed
table, with its row objects, reachable through V8's allocation feedback for
an object with getters, and Glide keeping the last data it drew from
through a module-level object, each until another grid is created; AG Grid
keeps its grid for a timer's length (less than the second waited); none grew
per mount. DOM nodes are the elements under the grid's container; canvas memory
counts the canvases in the DOM, not those a grid keeps off-screen.

### Configurations

Each adapter documents its configuration at the top of its file.

| Grid | Input | Sorting and filtering | Updates | Rendering |
| --- | --- | --- | --- | --- |
| Herceg | Table over the fixture's arrays | Row view (`setQuery`): typed-array comparators, filter expressions | `Table.append`, `dropFirst`, `set` | DOM rows and cells, 10 rows and 2 columns of overscan |
| TanStack Table 9 + Virtual 3 | Row objects | Native sorted and filtered row models (`basic` comparator, `sortUndefined: "last"`, `inNumberRange`, a membership filter function) | A new data array keeping unchanged row objects | React 19 DOM table, flushSync, 10 rows and 3 columns of overscan |
| AG Grid Community 36 | Row objects, `getRowId` | Native sorting with a comparator keeping missing values last, `deltaSort`; native number filter; the external filter for membership (Community has no set filter) | Synchronous transactions (`applyTransaction`) | DOM rows and cells, `rowBuffer` 10, animations off |
| Glide Data Grid 6 | The fixture's arrays through `getCellContent` | External: adapter code, labeled as such | Writes to the arrays; `updateCells` when order is unchanged | Canvas 2D, React 19 |

### Fairness notes

- Glide has no row model; its sorting and filtering are adapter code, so its
  sort and filter rows measure Glide rendering that code's result, not
  processing of Glide's own. The results label them as external.
- Glide draws on a canvas; DOM grids create elements for the cells in view.
  Their DOM node counts and memory are not comparable one to one, and
  Glide's visible content is the region it reports drawing, not pixels.
- Glide 6.0.4-alpha24 is a prerelease: the latest stable release (6.0.3)
  declares React 16 to 18 as peers, and the suite uses React 19 throughout.
- AG Grid's async transactions batch for 50 ms; the scenarios deliver one
  batch per tick and use the synchronous path.
- Herceg is measured from source at the current commit; the competitors are
  pinned in `package.json`.
- Not measured yet: grouping, aggregation, and pivots (AG Grid's are
  Enterprise features), a separate comparison of rendering a prepared result,
  a grid linked to a chart, a high-cardinality category stress case,
  keyboard and screen reader behavior, and grid bundle sizes. Committed
  results use one data seed (`--seed` changes it) and device pixel ratio 1
  (`--dpr 2`).

## Remote grids

`npm run bench:grid-remote` compares Herceg's remote grid
(`herceg/grid/remote`) with AG Grid Community's infinite row model, the
remote row model of the grids compared here that Community includes (its
server-side row model is Enterprise; TanStack Table and Glide Data Grid
leave remote data to the application). Both read one synthetic source in
the page: ten million rows computed from their place when asked (an id,
which each grid shows unformatted, a number, and a category), nothing
stored, so the page's memory is the grid's own. Each answer waits a fixed
latency on a timer, 0, 20, or 100 ms (`--latency`), the same timer at 0.
The source counts the requests it starts, those aborted, and those
answered.

Both grids have blocks of 128 rows, two requests in flight, and 16 blocks
cached (Herceg: 16 besides the blocks its view wants). Each waits 50 ms for
scrolling to settle, and every scenario also runs with 0 (`--settle 50,0`):
Herceg's `settle` delays only jumps (rows in view more than two blocks from
those last wanted), while AG Grid's `blockLoadDebounceMillis` delays every
block it loads, so its scroll traces at 50 ms show more rows not loaded than
at 0. AG Grid's datasource cannot abort a request (its `getRows` has no
signal), so it answers every one; Herceg's are aborted when not needed.
Herceg prefetches a block ahead in the direction of scrolling; AG Grid asks
for the blocks of the rows it renders (with `rowBuffer` 10). Each grid is
moved through its own API for showing a row at the top (`model.scrollTo`,
`api.ensureIndexVisible`), not through scroll events.

- **Jumps** (frame rate limit off): five warmups, then 40 jumps to seeded
  random rows over the whole range, each after a pause (garbage collected,
  a frame, 50 ms), as between the grid suite's samples: right after a frame
  that changed nothing, Chrome makes the next one only at the display's
  refresh, which would add up to a refresh interval to a grid that shows its
  rows in its second frame. A jump starts when the harness asks the
  grid to put a row at the top (`model.scrollTo`, `api.ensureIndexVisible`)
  and ends with the first frame, read just before it paints as in the grid
  suite, in which that row is within a row of the viewport's top and every
  row covering the viewport from there down is mounted, 28 px below the one
  before, showing its id. It
  records the requests the jump started.
- **Traces** (vsync on, after the same pause): from a random row, the top row moves on every
  frame at 100 rows a second (about 2,800 px/s) or 1,000 (about 28,000
  px/s) for two seconds, three trials each in fresh pages, from the same
  seeded rows for both grids: requests started
  and aborted per second of scrolling, and the share of frames in which
  some row in view was not loaded yet.
- **Memory** (after forced garbage collection, V8 and Blink heaps and
  ArrayBuffer backing stores): a grid mounted and destroyed once, then
  mounted again and jumped to 50 places (what it retains over the first),
  destroyed (what remains), and four more rounds, each leaving what it
  leaves beyond the one before (single rounds differ by a few hundred KiB
  either way, so the median is what a round leaks). Herceg also reports the
  bytes its cached blocks hold.

These are a client's costs: the synthetic source answers any offset at
once, as an indexed or materialized result does. A database paging by
offset can take much longer to reach row nine million, which no grid
setting changes.
