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
| **Mark** | One visual layer of a chart (`line`, `area`, `bar`, `point`, `heatmap`, `errorbar`, the annotations `rule`, `region`, `text`, and JavaScript-only `custom` marks). A mark pairs a spec with the table it reads. |
| **Series** | One drawn line, area, bar set, or point set within a mark: one y field, or one category of a `series` field. Legend entries and tooltip rows are series. |
| **Scale** | Maps data values to pixels: linear, log, time, or band. A band scale maps category indices to evenly spaced bands. |
| **Axis** | The visual guide of a position scale. In specs, scale and axis options share one object (`x`, `y`). |
| **Viewport** | The visible x range when zoomed; null means "fit the data". |
| **Spec** | The portable, JSON-serializable description of a chart (`ChartSpec`). |
| **Scene** | The render plan for one frame: packed geometry in CSS pixels, axes, legend, no data references. |
| **Geometry** | A mark's part of the scene: packed polylines (lines, areas), rectangles (bars, regions), segments (error bars), points, a raster (heatmaps), rules, text, or shapes (custom marks). |
| **Renderer** | Turns a scene into pixels or markup: SVG markup, retained SVG DOM, Canvas 2D. |
| **Chart** | A mounted, interactive chart in the browser (`createChart`). |

## Pipeline

```
TypeScript API: line(table, {...}), bar(...), point(...), heatmap(...), ...
        |  marks = portable spec + bound table
        v
ChartModel (DOM-free)
  axes       categorical channels give band axes, time fields time axes
  series     resolve fields, split long-format rows, map categories to
             band indices, assign palette colors
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
frame: O(visible points), about 0.8 ms for one million points
(`npm run bench:core`). On linear scales a whole column of the table is
scanned pixel column by pixel column: x is compared with a threshold just
left of the column's right edge rather than mapped. The threshold is checked
with the exact column formula, and points at or past it get the exact test;
because the floating-point mapping never decreases, the result is identical
to mapping every point. Gaps end a column in the same pass. Log scales and
row subsets of long-format tables use a per-point loop. Unsorted x is drawn
point by point without reduction.

The y domain comes from the same visible range: sorted series are trimmed to
the points inside it, so whole columns reduce to a plain min/max scan.

Line series of at least 262,144 points get a min/max index once a chart
draws the same table version a second time, as when zooming or panning; data
that changes before every draw does not build one. Indexes belong to the
table version and its columns, so charts sharing a mark or a table share
them. The index stores the positions of the
lowest and highest finite values of every 64-value block and of every 512,
4,096, ... values above that, plus whether a block holds a gap: about 1.4 MB
for ten million points, built in ~1.3 ms per million. With it, M4 finds each
pixel column's end by binary search and its extremes by an index query
instead of scanning, and the y domain is an index query too. Pixel columns
that contain gaps are scanned, and data where most blocks hold gaps skips the
index for reduction; the output is identical either way. Zooming into ten million points takes about 1.4 ms
instead of 3 ms. Areas and long-format series (row subsets) are not indexed.

## Band axes

A mark reports the kind of field on each position channel. A categorical
field (bar x or y, heatmap x and y) puts the axis on a band scale whose values are
category indices; the category labels are the union of what the marks on that
axis contribute, in order of appearance. Bands are identified by raw value
(a category, or a number's full-precision key), so values whose formatted
labels coincide stay separate. Each row's band index is computed
once per table version (4 bytes per row) and reused while the band list is
unchanged. Heatmaps also band number and time fields, one band per distinct
value. Band labels are thinned to every k-th band when neighbors would
overlap. A categorical axis cannot be shared with marks that need a numeric
axis (lines, areas); the chart rejects that combination.

## Points and rasters

Points are drawn per series into a packed coordinate buffer. Opaque points
(a hex, `rgb()`, `hsl()`, or named fill with `fillOpacity` 1) are filled as one
path per series; other points are filled one by one so overlaps darken as
they should. With `sampling: "pixel"`, above 4,096
points per series, opaque points whose centers fall in the same device pixel
are drawn once, through a reusable occupancy buffer. Tooltips for points use
a uniform grid index over the points drawn inside the plot (two
`Uint32Array`s), built on the first pointer query after each frame and cached
per frame, so charts sharing a mark keep separate indexes. Automatic domains
leave room for the point radius at the plot edges: after rounding to nice
values, the domain widens by the radius in pixels, so points at the data
extremes are drawn whole and ticks stay round.

Point series of at least 100,000 visible points are drawn by the GPU in the
browser. The point mark then emits a point cloud instead of pixel
coordinates: references to its source columns, the axis mappings, and the
table version. A WebGL2 painter, loaded with a dynamic `import()` the first
time a scene holds a cloud (so other charts never download it), uploads each
cloud once per table version: every coordinate normalized to [0, 1] over its
axis's data range, then split into a float32 and its float32 remainder (about
48 bits). Zooming and panning then only change shader uniforms. One WebGL
context serves every chart on the page, since browsers allow only a few; each
cloud is drawn into its plot-sized canvas and copied into the chart's 2D
canvas at the mark's place in drawing order. Uploads (16 bytes per point)
belong to the charts that draw them and are released when a chart stops
drawing them or is destroyed. Until the painter has loaded, cloud series are
not drawn (`chart.loading` settles once they are). The CPU places the points
instead when the painter cannot represent them faithfully (a data range that
overflows, position error above a quarter pixel at the current zoom, points
larger than the device's largest point sprite), without WebGL2, after a lost
context, with `renderer: "svg"`, and in `toSVG()` and `renderToSVG`. Picking
still uses the CPU grid index.

Bars are horizontal when their `y` is a category, as in Plotly Express: the
mark keeps series in chart coordinates (lengths in `x`, band indices in `y`,
stack bases in `x0`), so the model's extents, picking, and inspection need
no notion of orientation. An x axis that measures bar lengths takes the y
axis' defaults: it includes zero, rounds its ends, and draws grid lines.
Categories on a y axis run top to bottom, in reading order; bands of numbers
and times run bottom to top like a numeric axis. Category labels longer than
30% of the chart's width are shortened with an ellipsis.

Bars on number or time x are 80% as wide as the smallest gap between
neighboring distinct x values in view, across all series (capped at 64 px).
Those distinct values are sorted once per table version. Stacked series split
by a category field share one pair of table-sized top and base arrays, since
each row belongs to one series.

Heatmaps are rasterized: each cell is one pixel of an RGBA image (colors from
a 256-entry lookup table), and renderers stretch the image over the plot.
Canvas draws it with `drawImage`; SVG embeds it as a PNG. In the browser the
canvas encodes the PNG; `renderToSVG` uses a small bundled encoder, which only
server-side bundles include. Tooltips look cells up in a cell-to-row table,
rebuilt when the table or the band order changes. When several rows fall in
one cell, the last row with a value wins; missing values leave a cell
transparent. Ramps are `#rgb` or
`#rrggbb` colors, checked when the mark or theme is created, so the raster and
the legend read them the same way. A heatmap draws at most 4,194,304 cells
(16 MB of pixels plus 16 MB of lookup); larger grids are rejected with an
error asking for binning.

## Annotations

Rules, regions, and text share one model (`marks/annotation.ts`): each
position is a constant (a number; times in epoch milliseconds) or a number or
time field. With constants only, the mark draws one item and reads no table;
when any position or its `text` is a field, it draws one item per row of its
table. `label` is constant text and `text` a category or number field
(numbers formatted for the chart's locale). The spec loader only binds a
table to annotations that read one, so a constant rule in a spec with several
tables needs no `data`.

Annotation positions are part of the axis extents, so thresholds and events
stay in view; rectangles and text count toward y only where they overlap the
visible x range. Regions are rectangles drawn with the data in mark order and
clipped to the plot. Rules and text are guides: drawn as SVG above the data
(over a canvas when the data is on one), not clipped, and left out when they
fall outside the view. Text has a halo in the background color (white or
black, by the text color, when the background is transparent) so it stays
readable over lines (fills given by name, which would need the full CSS
color table to classify, get the halo for the theme's text color). The SVG
layer keeps each annotation's nodes by geometry key, so a changing label
rebuilds neither the axes nor other annotations. Annotations have no series, so
they appear in neither legends nor tooltips; the chart's text alternative
lists them (up to ten items each, with positions formatted as in tooltips)
after the series summaries. `Mark.geometry` receives the mark's key so their
geometry and buffers stay distinct per mark. Fields must be numbers or
times; on a category axis a constant is a band index, as in Plotly (0 is the
first band's center, -0.5 its edge).

## Custom marks

`custom()` is the escape hatch for shapes no mark draws. Its `draw` function
runs on every frame with the chart's scales and emits paths (SVG path
syntax; rectangles, circles, and lines are written as paths), and text. They
become one `shapes` geometry whose drawing writes SVG elements and paints a
canvas through `Path2D`, so custom shapes follow the same renderer choice,
clipping, and static export as other marks. Fields listed as `x` and `y`
count toward the axis domains. A custom mark's spec holds only its type and
id: functions cannot be serialized, so specs, and with them the Python
package, cannot contain custom marks, and the React adapter rebuilds them on
every render rather than comparing specs. Marks implement the `Mark`
interface, whose spec only needs a type and an id (`MarkIdentity`).

## Rendering

Geometry carries its drawing (`Drawing` in `scene/scene.ts`, implementations
in `src/draw/`): its SVG markup, optionally the same output as a few SVG
elements with attributes, and its size (for choosing a renderer). Data
drawings also paint on a canvas; guide drawings (rules, text) draw only in
SVG, above the data. The mark that emits the geometry attaches the drawing,
so renderers know no geometry kinds and a bundle only contains drawing code
for the marks it imports (a line chart does not carry bar, point, raster,
or text drawing). Each geometry type is checked against its drawing's type
at compile time; the `Geometry` base type that renderers hold erases that
pairing. Each scene
can be drawn three ways:

- `renderSvg` produces a standalone SVG document.
- `SvgLayer` keeps each geometry's nodes by key. Drawings that describe
  themselves as elements (lines, areas, bars, opaque points, rasters) are
  updated attribute by attribute, which costs several times less than
  reparsing markup; others (translucent points, rules, text) are a group
  whose markup is rewritten when its hash changes. Axes and grid are rebuilt
  only when their markup changes. Bars and points are one `path` element per
  series, not one element per data point.
- `paintCanvas` redraws grid and marks into a canvas sized to the device pixel
  ratio; point drawings hand clouds to the WebGL painter when one is loaded.

In the browser the layers are, bottom to top: an optional canvas for marks,
the SVG layer (grid and marks when not on canvas, guides, axes, title, pointer
overlay), the HTML legend, the tooltip, and visually hidden text for
assistive technology. Pointer feedback only touches the overlay, so hovering
never repaints data. Scheduled frames avoid reading layout, which would force
the browser to lay out the previous frame's DOM writes: the container size is
measured when a `ResizeObserver` reports a change (layout is current then),
for the first frame, and on explicit `render()` and `toSVG()` calls. Legend
entries are rewritten only when what they show changes, and the data summary
for assistive technology only when the data or options change, not when the
view zooms or pans.

The `renderer` option chooses where marks go. `auto` (the default) uses SVG
until a scene has more than 4,000 drawn points (line vertices, bars, points,
or heatmap cells) after level of detail and
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
viewport. Charts inspected along y (horizontal bars) measure values on x, so
they neither share nor follow the cursor; linking them by category is not
supported.

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
the best match). Points and heatmaps answer "nearest" queries with their own
index. "nearest-x" only snaps to points inside the visible x range, since
clipped points are not drawn. "nearest-y" does the same along y for
horizontal bars, scanning each series (bars on a band axis are few) and
reporting only bars with some part inside the x domain. Marks
only choose the default mode: "nearest-x" when every mark is drawn along x
(lines, areas, vertical bars), "nearest-y" when every mark is drawn along y
(horizontal bars), and "nearest" otherwise.
An explicit mode applies to every mark except heatmaps, which always report
the cell under the pointer; when cells overlap, the mark drawn last wins. With zoom enabled, the wheel zooms x around the pointer,
dragging pans, and double-click resets the viewport; both work in pixel space
through the scale, so they behave the same on log axes. Keyboard navigation
keeps a position within a series, so repeated x values are each reachable.

A press on the plot becomes one of three gestures once it moves 3 px: a
brush (with `interaction.brush`), a pan (with zoom only, or Shift with
both), or nothing; a press that does not move is a click. A brush is drawn
as a band in the pointer overlay and kept in data values, so it stays on
its data while the chart zooms or resizes; with zoom on, releasing it sets
the viewport instead. Shift with the arrow keys brushes from where the
keyboard cursor started, and the live region announces the range.

Charts emit `viewport`, `select`, `hover`, and `click` events. Each reports
changes only (hover compares the inspected values), and a listener that
throws is reported without stopping the others or the chart. Hover listeners
receive inspections even with the built-in tooltip off, which is how an
application draws its own.

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

Specs written elsewhere (the Python package, stored JSON) are loaded by
`herceg/spec`, a separate entry point so applications built with the
TypeScript API do not bundle it. `loadSpec(spec, buffers)` first checks the
spec at runtime, since the type checker cannot see specs from other
languages: structure, enumerations, booleans, finite numbers, field
references, and column payloads, with errors that give the property path
(`marks[2].strokeWidth`) or the table and column at fault. It then builds
tables from `data` and marks from `marks`. Columns are JSON arrays or binary: numbers and times as
little-endian typed buffers (`{ type, dtype, buffer }`, where `buffer`
indexes the buffers delivered next to the JSON) and categories as int32
dictionary codes. Binary columns become typed-array views of the delivered
bytes, copied only when misaligned, so large data never passes through JSON
number lists. `chartFromSpec` and `specToSVG` render a loaded spec.

## Package layout

The `herceg` npm package contains the engine, renderers, and browser runtime
as ES modules with `sideEffects: false`; bundlers drop what a chart does not
use. Framework adapters live in separate packages because their dependencies
differ. One package avoids version skew between engine pieces.

`@herceg/react` is a thin layer over the same engine. `<Chart>` creates one
chart in a layout effect and destroys it on unmount; mark elements (`<Line>`,
`<Bar>`, ...) render nothing and are read as mark specs, so there is no React
element per data point. Props are the whole configuration: changes reach the
chart through `chart.update` in a layout effect, with removed options reset
to their defaults, and are skipped when no mark's spec or table and no option
changed (compared as JSON with sorted keys). Unchanged marks keep their
identity, so their caches survive re-renders. Data changes go
through the table and reach the chart through its own change events and
frame scheduler, without rendering React. A test
(`test/architecture.test.ts`) keeps the core directories (`data`, `scale`,
`format`, `lod`, `marks`, `model`, `scene`, `spec`) free of DOM access. Marks
import their drawings (`draw`), which write SVG without a DOM and paint
canvases through the context they are handed; only raster painting reaches
the DOM, creating an offscreen canvas in that canvas' document when
`OffscreenCanvas` is unavailable.

## Known limits

- Mark types: line, area, bar, point, heatmap, error bar, the rule, region,
  and text annotations, and custom marks. Horizontal bars need a category y;
  bars along a number or time y are not supported. Error bars stand at the
  center of their position, not beside grouped bars; horizontal ones at y
  positions a log axis cannot place still count toward the x domain.
- Custom marks are JavaScript only, have no legend entries or tooltips, and
  cannot bind category fields.
- Annotation fields cannot be categories (constants on a category axis are
  band indices); text has no collision avoidance or connectors. Bar value
  labels estimate text widths from the font size to decide what fits.
- Continuous color only for heatmaps; points cannot be colored by a numeric
  field.
- One x and one y axis per chart.
- Heatmaps are limited to 4,194,304 cells and have no built-in binning.
- The model always carries band-axis, color-legend, and inspection-along-y
  logic, so a line-only bundle includes some bar and heatmap support it does
  not use.
- Areas, log scales, and long-format line series re-scan the visible range on
  every frame; only whole-column line series on linear scales use the min/max
  index.
- Renderer thresholds are not tuned.
- Rules and text are always drawn above other marks, regardless of mark order.
- The GPU draws only large point series; lines, areas, bars, and heatmaps use
  Canvas or SVG. Uploads are not incremental: streaming a large point series
  uploads it again on every change.
- No adapters for frameworks other than React. See the roadmap in the repository README.
