# Architecture

This document describes how Herceg is built today and why. It is the reference
for contributors; user-facing usage lives in the package README.

## Vocabulary

One name per concept, used the same way in code and docs.

| Term | Meaning |
| --- | --- |
| **Table** | Columnar data: named columns of equal length (`Table`). |
| **Field** | The name of a column in a table. Encodings refer to fields. |
| **Column** | The typed storage behind a field: numbers, times (epoch ms), or dictionary-encoded categories. |
| **Mark** | One visual layer of a chart (`line`, `area`, `rule`). A mark pairs a portable spec with the table it reads. |
| **Series** | One drawn line or area within a mark: one y field, or one category of a `series` field. Legend entries and tooltip rows are series. |
| **Scale** | Maps data values to pixels (linear, log, time). |
| **Axis** | The visual guide of a position scale. In specs, scale and axis options share one object (`x`, `y`). |
| **Viewport** | The visible x range when zoomed; null means "fit the data". |
| **Spec** | The portable, JSON-serializable description of a chart (`ChartSpec`). |
| **Scene** | The render plan for one frame: packed geometry in CSS pixels, axes, legend, no data references. |
| **Geometry** | A mark's part of the scene (`LineGeometry`, `AreaGeometry`, `RuleGeometry`). |
| **Renderer** | Turns a scene into pixels or markup: SVG markup, retained SVG DOM, Canvas 2D. |
| **Chart** | A mounted, interactive chart in the browser (`createChart`). |

## Pipeline

```
TypeScript API: line(table, {...}), area(...), rule(...)        (Python and JSON specs later)
        |  marks = portable spec + bound table
        v
ChartModel (DOM-free)
  series     resolve fields, split long-format rows, assign palette colors
  domains    x from data or viewport; y from data visible in x
  layout     ticks, labels, margins, legend placement
  geometry   per mark, level-of-detail reduction into reused buffers
        |
        v
Scene  ──>  renderSvg()      standalone SVG string (server, export, tests)
       ──>  SvgLayer         retained SVG DOM
       ──>  paintCanvas()    Canvas 2D for dense marks
        |
        v
Chart (browser runtime): scheduler, pointer/keyboard, tooltip, legend, zoom, sync
```

The model never touches the DOM, so the same code produces server-rendered
SVG (`renderToSVG`) and browser charts. Text measurement is injected: the
browser uses a canvas context, static rendering uses built-in Helvetica
metrics padded by 10%.

## Data model

Tables are columnar. Each numeric or time column is one typed array; category
columns store `Int32Array` codes (−1 for missing) plus a string dictionary.
There are no per-row objects anywhere in the pipeline.

- **Zero-copy input.** Typed arrays passed to `table()` are used in place.
  The table never writes into them: the first mutation copies them into
  buffers it owns (copy-on-write). Plain arrays, Dates, and strings are
  converted once.
- **Contiguous storage.** Live rows occupy one slice of each buffer. Appends
  write after the slice and drops move its start. When the buffer end is
  reached, live rows move to the front if that leaves a third of the buffer
  free, otherwise buffers are reallocated at 1.5x the live rows (at least 64
  rows). An explicit drop that leaves a buffer less than a quarter full
  shrinks it. Every consumer therefore reads plain contiguous typed arrays;
  the cost is reserved capacity after growth. A ring buffer would avoid that
  headroom but would make every consumer handle two segments.
- **Rolling windows.** `maxRows` drops the oldest rows on append. Rows that
  would be dropped are removed before compaction, so they are never copied.
- **Change events.** Each mutation increments `version` and reports what
  changed (dropped, appended, updated range, reset). Caches key on the version
  today; the change details exist for incremental structures.
- **Derived state.** Sortedness and extents per field are cached and updated
  cheaply on append. Long-format series are split into row-index lists
  (`Uint32Array` per group, 4 bytes per row) instead of copies; categories
  without rows produce no series.
- **Rolling categories.** When a category dictionary holds more than twice as
  many entries as there are live rows, unused entries are dropped and codes
  renumbered, so long-running streams over changing categories stay bounded.

Memory amplification over the source data is therefore: reserved capacity
for tables that grow (about 0.5x the live rows right after growth; at most
0.5x `maxRows` for rolling windows; after drops, up to about six times the
live rows until an explicit drop shrinks the buffer), 4 bytes per row for long-format grouping, two `Float64Array`s per
layer for stacked areas (top and base), and geometry buffers bounded by the
plot width.

## Level of detail

Lines and areas over sorted x use M4 aggregation: within each device-pixel
column only the first, minimum, maximum, and last points of an unbroken run
are kept, at their real positions and in order. A line drawn through those
points covers each pixel column over the same vertical extent as the full
line, unlike LTTB or averaging, which can drop peaks. Removing intermediate
points does shorten the path, so dash patterns can shift.

Output is at most four points per device-pixel column for each unbroken run,
before step curves add their corner points. That bounds rendering cost, SVG
path size, and memory for typical data. Missing values split a line into runs
that are reduced separately, so data that alternates between values and gaps
can still produce one run per few points.

The reduction scans the visible index range (found by binary search) on every
frame: O(visible points), about 3 ms for one million points
(`npm run bench:core`). Unsorted x is drawn point by point without reduction.

## Rendering

Each scene can be drawn three ways:

- `renderSvg` produces a standalone SVG document.
- `SvgLayer` keeps SVG elements per geometry key and only updates attributes.
  Axes and grid are rebuilt only when their markup changes.
- `paintCanvas` redraws grid and marks into a canvas sized to the device pixel
  ratio.

In the browser the layers are, bottom to top: an optional canvas for marks,
the SVG layer (grid and marks when not on canvas, rules, axes, title, pointer
overlay), the HTML legend, the tooltip, and visually hidden text for
assistive technology. Pointer feedback only touches the overlay, so hovering
never repaints data.

The `renderer` option chooses where marks go. `auto` (the default) uses SVG
until a scene has more than 4,000 drawn points after level of detail and
returns to SVG below 2,000; the gap prevents flapping while data streams. SVG
keeps small charts crisp, accessible, and free of canvas backing stores,
which dominate memory for many small charts. How many points a chart draws
depends on its width, device pixel ratio, data shape, and series count: a
dense line at 800 px and DPR 1 stays below the threshold, the same line at
DPR 2 exceeds it. The thresholds have not been tuned with benchmarks yet.

## Updates and scheduling

All charts share one `requestAnimationFrame` loop. Table changes, resizes,
option updates, and pointer moves mark a chart dirty; the next frame renders
each dirty chart once, however many changes arrived. Charts outside the
viewport (IntersectionObserver) stay dirty and render when they become
visible. A chart's first frame renders synchronously when it is created.

Charts that set the same `interaction.sync` name share the cursor x and the
viewport.

## Identity and color

Each series has a key built from its mark's `id` (or index) and its source
(a y field or a category) as JSON, so no combination of names can collide.
Keys identify legend state, geometry buffers, and colors. Palette slots are
assigned to keys the first time they appear and kept for the chart's
lifetime, so a series keeps its color when others appear, disappear, or are
hidden.

## Interaction

Tooltips use the model's `inspect()`: for sorted series the nearest x is
found by binary search (O(log n) per series); "nearest-x" reports every
visible series at that x, "nearest" the closest point on screen (searching
outward from the nearest x until points are farther away horizontally than
the best match). With zoom enabled, the wheel zooms x around the pointer,
dragging pans, and double-click resets the viewport; both work in pixel space
through the scale, so they behave the same on log axes. Keyboard navigation
keeps a position within a series, so repeated x values are each reachable.

## Accessibility

- The chart root is a focusable `figure` named by the title, described by a
  generated summary (series count and, per series, point count, range, and
  last value) that is refreshed at most once a second.
- Arrow keys, Page Up/Down, Home, and End move a cursor through the data; the
  values are announced through a polite live region and shown in the tooltip.
- Legend entries are buttons with `aria-pressed`.
- Static SVG output has `role="img"`, `<title>`, and `<desc>`.

## Spec and API

`ChartSpec` (in `src/spec/spec.ts`) is plain JSON: field names, constants,
and Intl format options; no functions or typed arrays. The TypeScript API
builds the same structures: `line(table, options)` returns a mark whose
`spec` is the portable part. Mark implementations are attached to the mark
objects rather than looked up in a registry, so unused mark types are tree
shaken away. Field options are typed from the table schema: numeric encodings
only accept number or time fields, `series` only accepts category fields.

## Package layout

The `herceg` npm package contains the engine, renderers, and browser runtime
as ES modules with `sideEffects: false`; bundlers drop what a chart does not
use. Framework adapters live in separate packages because their dependencies
differ. One package avoids version skew between engine pieces. A test
(`test/architecture.test.ts`) keeps the core directories (`data`, `scale`,
`format`, `lod`, `marks`, `model`, `scene`, `spec`) free of DOM access.

## Known limits

- Mark types: line, area, rule.
- One x and one y axis per chart.
- Level of detail re-scans the visible range on every frame; there is no
  precomputed min/max pyramid.
- Renderer thresholds are not tuned.
- Rules are always drawn above lines and areas, regardless of mark order.
- No React adapter, Python package, or GPU renderer. See the roadmap in the
  repository README.
