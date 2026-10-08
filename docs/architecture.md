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
| **Mark** | One visual layer of a chart (`line`, `area`, `bar`, `point`, `heatmap`, `errorbar`, `candlestick`, `histogram`, `boxplot`, `violin`, the annotations `rule`, `region`, `text`, and JavaScript-only `custom` marks). A mark pairs a spec with the table it reads. Layout marks (`pie`, `treemap`, `sunburst`, `gauge`, `funnel`, `radar`, `sankey`) place their own geometry instead of using x and y scales. |
| **Item** | One thing a layout mark draws, such as a pie slice, a tree's node, a gauge's dial, a funnel's stage, a radar's value on one spoke, or a Sankey diagram's node or link: what its tooltips and the keyboard visit. |
| **Series** | One drawn line, area, bar set, or point set within a mark: one y field, or one category of a `series` field. Legend entries and tooltip rows are series. |
| **Scale** | Maps data values to pixels: linear, log, time, or band. A band scale maps category indices to evenly spaced bands. |
| **Axis** | The visual guide of a position scale. In specs, scale and axis options share one object (`x`, `y`). |
| **Viewport** | The visible x range when zoomed, and the visible y ranges when zoomed along y; null means "fit the data". |
| **Spec** | The portable, JSON-serializable description of a chart (`ChartSpec`). |
| **Scene** | The render plan for one frame: panels, title, and legend in CSS pixels, with no data references. |
| **Panel** | A plotting area of a scene: its plot rectangle, grid, axes, and geometry. Data is clipped to the plot; guides (rules, text) are not. A chart has one. |
| **Geometry** | A mark's part of the scene: packed polylines (lines, areas), rectangles (bars, regions), segments (error bars, candle wicks), points, a raster (heatmaps), arcs (pie slices, gauge dials), rules, text, or shapes (custom marks, a gauge's value, funnel connectors). |
| **Renderer** | Turns a scene into pixels or markup: SVG markup, retained SVG DOM, Canvas 2D, PDF. |
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
  domains    x from data or viewport; y from data visible in x, per y axis
  layout     ticks, labels, margins, legend placement
  geometry   per mark, level-of-detail reduction into reused buffers
        |
        v
Scene  ──>  renderSvg()      standalone SVG string (server, export, tests)
       ──>  renderPdf()      one-page PDF document (herceg/pdf)
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

## Derived tables

Data preparation is part of the spec: a data entry with `source` and
`transform` derives rows from another table (`data/derive.ts`). Expressions
are JSON trees with the operator first (`[">", ["field", "temp"], 30]`), so
specs stay plain data and Python builds them with operators; they compile
once per evaluation against the rows' columns into closures, comparing a
category field with a string literal by dictionary code. Steps run over
columns, not row objects: filters and sorts gather rows into new typed
arrays, calculations add columns, bins replace values with their bin's
start, aggregates group by field values (codes for categories) in order of
appearance, and rolling windows keep a two-stack sliding window of partial
aggregates (count, mean, squared deviations, minimum, maximum) combined
with Chan's pairwise update, O(1) amortized per row and without the
cancellation of running sums. Columns still read from the source are copied at the
end, so the derived table never shares a buffer the source may overwrite.

A derived table is an ordinary `Table`, which charts and marks use as any
other. It follows its source through `subscribe`: when every step works row
by row (filters, calculations, bins with a fixed step), appended source rows
run through the steps on their own and are appended, and each derived row
remembers its source row's identity (`rowOffset + index`) so drops remove
exactly the rows they produced; any other change or pipeline recomputes the
table with `reset`. A derived table keeps its source alive (a `WeakMap` from
derived to source), so chains hold together; the source's subscription
holds the derived table weakly (`WeakRef`) and is removed when it is
collected (`FinalizationRegistry`). The spec
loader loads tables in dependency order and rejects unknown sources and
cycles.

## Level of detail

Lines and areas over sorted x use M4 aggregation: within each device-pixel
column only the first, minimum, maximum, and last points of an unbroken run
are kept, at their real positions and in order. A line drawn through those
points covers each pixel column over the same vertical extent as the full
line, unlike LTTB or averaging, which can drop peaks. Removing intermediate
points does shorten the path, so dash patterns can shift.

Output is at most four points per device-pixel column for each unbroken run,
before step curves add a corner per point. That bounds rendering cost, SVG
path size, and memory for typical data.

Monotone curves (Steffen's method, as d3's `curveMonotoneX`) bend lines
between the points that level of detail keeps, in pixels: segments at least
2 pixels wide are curved, narrower ones (dense data) stay straight, since a
curve between points that close differs from the line by less than their
distance. A curved segment is a cubic Bezier whose control points the
polyline keeps beside its points (`Polyline.curveTo`); renderers draw it as
one (SVG `C`, canvas `bezierCurveTo`, PDF `c`), so curves add no vertices
and need no flattening. Tangents come from distinct neighbors, repeated
points ignored, and the traced range reaches two distinct x values past
each edge of the view, so zooming does not change a curve through data that
is not reduced; where level of detail reduces dense data, the curves next to
it follow the reduced points, and change as zooming changes the reduction
(no bound on that change is promised). Automatic y domains include the
points just outside the view across its edges: a monotone segment stays
between its ends, so that bounds what is drawn on any scale. Bands and
stacks curve all their boundaries together: rows are reduced jointly (each
device-pixel column keeps its first and last rows and every boundary's
lowest and highest), each boundary is one curve through its own points (so
none passes its data), shared by the layers on either side, and a segment
where two boundaries could cross (the difference of their cubics has a
Bezier ordinate of the wrong sign) is straight for all of them, so layers
never overlap. Bands and stacks on log y axes are drawn straight. Missing values split a line into runs
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

Line series, and areas filled to zero, of at least 262,144 points use a
min/max index of their y field. The table owns the index and keeps it
current: appends recompute only the trailing blocks, drops leave it valid
(it covers the column's whole buffer, so positions do not move), small
in-place updates recompute their blocks, and when the table moves its rows
(compaction or growth, once per many appended rows) it rebuilds the index,
which averages O(1) per appended row. A reset, or a replace of at least a
quarter of the rows, drops it. A mark asks for a new index when a chart
redraws it and nothing replaced the data wholesale since that chart's
previous draw: zooming, panning, and streaming build one; data replaced
before every draw never does. Charts sharing a table share its indexes.

The index stores the positions of the lowest and highest finite values of
every 64-value block and of every 512, 4,096, ... values above that, plus
whether a block holds a gap: about 1.4 MB for ten million points, built in
~1.3 ms per million. With it, M4 finds each pixel column's end by binary
search and its extremes by an index query instead of scanning, and the y
domain is an index query too. Pixel columns that contain gaps are scanned,
and data where most blocks hold gaps skips the index for reduction; the
output is identical either way. Zooming into ten million points takes about
1.3 ms instead of 3 ms. Streaming 10,000 points per tick into a
million-point window takes a median of about 1.5 ms instead of 2.7 ms (p95
2.0 instead of 3.4 ms); the ticks that move the window's storage also
rebuild its index and take up to about 5 ms instead of 4 ms. Bands, stacked
areas, and long-format series (row subsets) are not indexed.

Histograms keep their bins, not their values: whenever the table changes,
one pass finds the extremes and another counts each series' values (by
division for evenly spaced edges, binary search for calendar ones), and at
most a thousand bars are drawn, whatever the data size. Series split by a
category field also keep their row indexes (4 bytes per row), as long-format
series do. Streaming recounts every value on each change.

Candlesticks merge rather than sample: with more candles in view than the
plot has pixel columns, each column draws one candle with the open of its
earliest candle, the close of its latest, and its highest high and lowest low,
so no price extreme is lost. The merge works in any row order, and the
geometry buffers hold at most one candle per column.

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

## Two y axes

A mark's spec names its y axis (`axis: "right"`; left by default). The model
computes each side's domain from its own marks' visible data, plans ticks and
margins per side, and gives every mark a frame whose `y` is its side's scale,
so mark geometry, picking, and custom marks do not know which side they are
on. Tooltips look up each series through its mark's frame and format values
with its axis' formatter; "nearest-y" tooltips compare values within one
axis (the left, or the right when only it has series). Marks whose positions
run along y (category y, horizontal bars and error bars) are inspected by
the pointer's y in one scale, so they stay on the left; the model refuses
them on the right. An axis is shown when one of its marks places values
along y (a y position or field in its spec), whatever the data, the view, or
hidden series, so the layout stays put while they change; a configured
domain alone adds no axis. The text alternative names each series' axis when
both have series. Zooming and panning along y move both sides over the same
pixels: the y viewport holds a range for each.

## Small multiples

With `facet`, the model draws a panel per value of a category field, or per
pair of values of a row field and a column field (each field's values in
order of first appearance across the tables of the marks that split, every
pair drawn, rows by columns). Facet headers are scene text (`Scene.headers`),
so every renderer and static export draws them the same way. With
`resolve.y`, panels are grouped (each alone, by row, or by column) and each
group gets a y plan from the data its panels draw within the shared x
domain, the same nice, headroom, and inset rules as a shared axis; a group
with nothing to show draws no y labels. The spec format's version 2 adds
`resolve`; version 1 specs still load, and a spec with `resolve` must say
version 2, since a version 1 reader would ignore it. Rows
are split after series are resolved: a facet split of a series is the same
columns read through a list of the rows in each panel (4 bytes per row),
computed in two passes per series (with a transient 4-byte panel index per
row) and kept until its table changes, with
sortedness checked per panel. Series keep their keys, so colors, legend
entries, and hidden state are shared across panels. Splitting after series
are resolved is right for marks whose series are row-aligned (lines, points,
bands and stacks of several fields, unstacked bars, error bars, candlesticks);
stacked bars, heatmaps, and histograms, whose geometry combines rows, refuse
facets until they split
before combining. Continuous domains come from every panel's series, so rows
without a facet value are left out of them; category bands still come from
whole tables. Each panel gets a frame whose scales are the
shared plans moved to its row and column, and whose buffer pools are its
own, so geometry code is the same as for one panel; each has its own
inspector, and the chart routes the pointer to the panel under it.

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
a lookup table), and renderers stretch the image over the plot.
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

Continuous color (heatmaps, and points with a `color` field) maps values
through a 255-entry lookup table interpolated from the ramp's stops: odd, so
a diverging scale's midpoint has an exact middle entry, and under 256, so a
point's color is one byte. With a midpoint, values on each side map onto
their half of the table, and the legend's gradient moves its middle stop to
the midpoint's place between the ends. Named schemes are separate exports;
only the spec loader holds the table of names, so charts built in TypeScript
bundle the schemes they import and no others.

Points encoding fields fill per-point arrays alongside their coordinates:
radii (`Float32Array`), lookup-table color indexes and symbol codes (bytes),
and opacities. Points without encodings keep the single-style fast paths (one
path of arcs, pixel sampling, WebGL clouds). Opaque encoded points are drawn
one path per color after a counting sort by color index, so a canvas fill
or SVG element covers every point of a color; translucent ones are drawn
one by one so overlaps darken, as plain translucent points are. Symbols are
polygons of the same area as the circle of the same radius.

## Layout marks

Most marks place data along x and y scales. Layout marks (pies, treemaps,
sunbursts, gauges, funnels, radars, and Sankey diagrams) place their own geometry in a panel instead: the chart model gives one the
room below the title and legend (`LayoutFrame`: bounds, theme, text
measurement, hidden keys, and stable colors per item key) and draws what it
returns (`LayoutResult`: geometry, an item lookup by pixel, the items in
reading order, and a summary). A chart holds marks along axes or one layout
mark, never both, so the Cartesian layout code runs unchanged and a line
chart carries only the small dispatch, not the pie.

What a tooltip or keyboard cursor is on is an `Inspection`: an axis
inspection (a position along x or y and each series' point there) or an item
inspection (one slice: its key, value, label, and an SVG outline that the DOM
chart draws as the hover highlight). Arrow keys step through items in
reading order. Pie slices are arc geometry, six floats per sector (center,
inner and outer radius, start and end angle); SVG draws them with `A`
commands, Canvas with `arc`, and PDF with cubic curves of at most a quarter
turn. Gaps between slices move each slice's straight sides inward, parallel
to themselves, so they show whatever is behind the chart. Labels beside a pie
are spread per side to keep their order without overlapping
(`layout/pie-labels.ts`).

Trees are packed arrays over a table's rows (`data/hierarchy.ts`): each
node's parent, depth, and children (offsets into one child array), a
parents-first order, and the node each row belongs to, with a root of its
own above the top-level nodes. Node totals are a pass over the rows and one
back up that order. Treemaps lay out with the squarified algorithm
(`layout/treemap.ts`), sunbursts with an adjacency partition
(`layout/partition.ts`); both write packed boxes or spans per node, and the
tree is rebuilt only when its table changes.

A gauge reads its field's last finite value on every scene, scanning back
from the last row, so a streaming table moves it without any state of its
own. Its dial, value arc, and bands are arc geometry; the track is drawn only
beyond the value, since antialiased edges of a track under the value's arc
would fringe it. The large value is a shapes geometry, whose text can carry
its own size and weight (`fontSize`, `bold`) in SVG, Canvas, and PDF. A funnel
caches stage totals per table version, as a pie does, and draws its bars as
one rectangle geometry over a shapes path of connectors; widths are
proportional to values, and the connectors encode nothing.

A radar reads its table into packed arrays of the values rows give, series
by series in spoke order (each value's spoke and number, and where each
series starts), rebuilt when the table changes: storage follows the rows
however sparsely they fill the series and spokes, and only shown series are
placed. A later row replaces an earlier one's value for the same series and
spoke. It draws with existing geometry kinds, so SVG, Canvas, and PDF need
no radar code: the rings and spokes are one line geometry, the fills one
shapes geometry of SVG path data (drawn below every outline), each series'
outline a line geometry whose runs break at missing values, and its dots a
point geometry. The radius is the largest that leaves room outside the rim
for the spoke labels (`layout/radar-labels.ts`): each label is a box that
moves outward along its spoke as the radius grows, so each edge facing
outward bounds the radius linearly.

A Sankey diagram's graph is built in one pass over its table: each category
code of the source and target fields is mapped to a node by name once, and
rows with the same source and target add to one link. The layout
(`layout/sankey.ts`) follows d3-sankey: a depth-first search drops links
that close cycles, columns come from longest paths (sinks justified to the
last column), and six passes of relaxation move nodes toward the weighted
average of where their links would run level, then push each column's nodes
apart. Unlike d3-sankey, the link stacks at the moved nodes' neighbors
re-sort once per column rather than after each node, and each link keeps its
offset in both stacks, so a hub of thousands of links costs milliseconds
rather than quadratic time. It works on values as fractions of the largest
drawn link, so sums near the largest double stay finite, and writes packed
boxes per node and band ends per link. The graph is rebuilt when the table changes and the layout
when the table or the room does. Links are filled bands of two cubic curves,
drawn as shapes geometry; the pointer finds a band by solving its curve's
x for the curve parameter with a few Newton steps.

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
count toward the axis domains. Over one x field and y fields, a custom mark
builds series as a line does (`SeriesSplitter`, `buildSeries`), so the
legend, hiding, tooltips, events, keyboard navigation, facet splits, y
domains that follow the view, and text summaries all come from the chart's
own code for series; there is no inspection code for custom marks. `draw`
receives the series it should draw (hidden ones left out, facet panels'
row subsets) as read-only views, and an optional `pointText` writes their
tooltip text. Since the shapes between points are unknown, y extents take
in the points just past the view's edges (as for monotone curves) rather
than interpolating straight segments. With `series: false` (glyphs from
several fields of a row, such as ranges), or fields other than one x and y
fields, the fields only count toward the domains; such marks have no
series, and in charts with facets must repeat. A custom mark's spec holds its type, id, and the fields of its
series: functions cannot be serialized, so specs, and with them the Python
package, cannot contain custom marks, and the framework adapters rebuild them
whenever they render them again rather than comparing specs. Marks implement
the `Mark` interface, whose spec only needs a type and an id (`MarkIdentity`).

## Rendering

Geometry carries its drawing (`Drawing` in `scene/scene.ts`, implementations
in `src/draw/`): its SVG markup, optionally the same output as a few SVG
elements with attributes, and its size (for choosing a renderer). Data
drawings also paint on a canvas; guide drawings (rules, text) draw only in
SVG, above the data. The mark that emits the geometry attaches the drawing,
so the SVG and Canvas renderers know no geometry kinds and a bundle only
contains drawing code for the marks it imports (a line chart does not carry
bar, point, raster, or text drawing). Each geometry type is checked against
its drawing's type at compile time; the `Geometry` base type that renderers
hold erases that pairing. Each scene can be drawn four ways:

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
- `renderPdf` (`render/pdf.ts`) writes a one-page PDF 1.4 document with the
  static SVG's layout, measured in points (0.75 per CSS pixel).

PDF drawing is the exception to drawings carried by geometry: `renderPdf`
switches on the geometry kind. A `pdf` member on each drawing would keep each
kind self-contained, but marks import their drawings, so it would ship PDF
code in every chart bundle, while PDF export is rare and mostly runs on
servers and in the Python package. The switch is checked against the
built-in geometry union (`MarkGeometry`), so a new kind does not compile
until PDF draws it; a geometry kind it does not know (from a third-party
drawing) is refused with an error. The PDF reuses the drawings' path tracing
(`traceLine`, `traceArea`), so outlines match the canvas. Marks, axes, and
legends are vector paths (circles as Bézier curves, point symbols and
legend glyphs, and custom marks' SVG path data converted, arcs included;
encoded points grouped by color as on canvas); opacities are graphics states; heatmaps are
RGB images with a soft mask for missing cells, each cell wider than a pixel
repeated to about two image pixels per CSS pixel (at most 4,194,304 pixels),
because some viewers (macOS Preview) smooth images whatever the file asks
and would blur cells into each other; the color legend's ramp is an axial
shading. Text uses the standard 14 fonts, which every viewer has, so
nothing is embedded: layout measures text with the same Helvetica metrics
as the static SVG (padded by 10%), and anchoring uses the fonts' exact
metrics. Streams are Flate-compressed by a small built-in deflate (fixed
Huffman codes with LZ77 matching; zlib's dynamic codes make text streams
about 30% smaller), since the output must be built
synchronously wherever the engine runs, including the V8 engine embedded in
Python, which has no compression API. Output is deterministic: no creation
date or random file identifier.

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

## Themes

A theme is a set of tokens (`theme.ts`) resolved once per configuration into
plain values that the model and renderers read. Themes that follow the page
(`"auto"`, or tokens holding CSS variables) need an environment to resolve:
the DOM chart passes one that finds whether the chart sits on a dark
surface (the nearest background color, else the page's color scheme) and
computes CSS values on a hidden probe inside the container, converting colors
in any syntax to sRGB hex (or `rgba()`), because ramps, contrast checks, and
the PDF writer parse colors. The chart watches the color scheme and attribute
changes on the page's root and body elements, reads the page again on its
next frame, and re-renders only if the resolved theme changed. Static rendering has no page: variables take their fallbacks and
`"auto"` is light, so the output does not depend on where it was rendered.

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
the cell under the pointer; when cells overlap, the mark drawn last wins.
With zoom enabled along x (`true` or "x"), y ("y"), or both ("xy"), the
wheel zooms those axes around the pointer, dragging pans them, and
double-click resets both; all work in pixel space through the scales, so
they behave the same on log axes. Category axes do not zoom. Viewports are
kept ascending and shown the way the axis' configured domain runs, so
reversed axes stay reversed. The y viewport is kept as domains for the left
axis and, in charts with one, the right axis, each what the same pixels show
on it. Keyboard navigation keeps a position within a series, so repeated x
values are each reachable.

A press on the plot becomes one of three gestures once it moves 3 px: a
brush (with `interaction.brush`), a pan (with zoom only, or Shift with
both), or nothing; a press that does not move is a click. A brush selects a
range along x or y, a rectangle ("xy"), or a lasso (its outline, thinned
past 400 points); rectangles and lassos need 3 px each way. A selection is
kept in data values, so it stays on its data while the chart zooms or
resizes, and drawn in the pointer overlay, clipped to each plot. When zoom
is on along every axis a selection has a range on, releasing the brush (or
Enter, for a selection made with the keyboard or received from a synced
chart) sets the viewport instead; lassos never zoom. Synced charts share
selections as data values (category indices on category axes), each drawing
them on its own scales, so charts sharing a selection should have the same
axis types and category order. Shift with the arrow keys selects a range
from where the keyboard cursor started, along the axis it steps along (x for
lines and vertical bars, y for horizontal bars): with brushes along that
axis, and with rectangle and lasso brushes, which only the pointer draws.
The live region announces selections made with the keyboard and the
pointer.

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
number lists. `chartFromSpec`, `specToSVG`, and `specToPDF` render a loaded spec.

## Package layout

The `herceg` npm package contains the engine, renderers, and browser runtime
as ES modules with `sideEffects: false`; bundlers drop what a chart does not
use. Framework adapters live in separate packages because their dependencies
differ. One package avoids version skew between engine pieces. PDF export
is a subpath, `herceg/pdf`, so that unbundled imports of `herceg` (from a
CDN or in Node) do not load it either.

`@herceg/react` is a thin layer over the same engine. `<Chart>` creates one
chart in a layout effect and destroys it on unmount; mark elements (`<Line>`,
`<Bar>`, ...) render nothing and are read as mark specs, so there is no React
element per data point. Props are the whole configuration: changes reach the
chart through `chart.update` in a layout effect, with removed options reset
to their defaults, and are skipped when no mark's spec or table and no option
changed (compared as JSON with sorted keys). Unchanged marks keep their
identity, so their caches survive re-renders. Data changes go
through the table and reach the chart through its own change events and
frame scheduler, without rendering React.

`@herceg/vue` follows the same model in Vue's terms. `<Chart>` reads its
mark components from the default slot during render, without mounting them,
so Vue tracks the state that options and marks read and re-renders the chart
when it changes; the chart is created in `onMounted` and updated in
`onUpdated` with the same comparison as in React. Option arrays and objects
are copied out of Vue's reactive proxies as they are read, so in-place
changes of reactive state are seen and tables are used unwrapped (their
private fields cannot be reached through a proxy). Errors building marks
are caught during render and thrown again from those hooks, because a render
that throws makes Vue replace the container, and the chart with it. Chart
events are declared with `emits`; since Vue does not tell a component which
listeners it has, the chart always listens, and unlike the React adapter it
has hover and click payloads computed even when nobody listens. Annotation
and custom mark components are generic in the table rather than in its
schema, so vue-tsc infers the table from `data` before typing `draw`, and
reports a wrong field on its attribute; with overloads, as in React, the
template checker would drop the error.

`@herceg/svelte` cannot read its children, since a Svelte snippet is opaque,
so its mark components are mounted: each builds its mark in a `$derived`
from its props and adds itself to the enclosing `<Chart>` through context.
Each renders one empty `<template>` element, inside a hidden element of the
chart, and the chart orders marks by the document position of those
elements, so marks added later by `{#if}` or `{#each}`, or rendered by the
application's own components, still draw in template order; a mutation
observer on that hidden element re-sorts them when a keyed `{#each}` moves
them without changing any. One effect reads
the options and every mark, so it re-runs when any of them changes, and
applies them with the same comparison as in React; the chart is created the
first time it runs, after the mark components have added themselves.
Options are copied out of `$state` proxies as they are read, as in Vue.
Event handlers are callback props (`onselect`, ...), subscribed only while
given. The package is built with `svelte-package` and checked with
svelte-check, which need TypeScript's JavaScript API: the package keeps
TypeScript 6 for them, next to the repository's TypeScript 7.

The Python package (`python/`) emits specs with binary buffers and ships
bundles of the engine built by `npm run build:python`: a classic script for
HTML output, a DOM-free script for SVG export in an embedded V8, and ES
modules for live charts. A live notebook chart (`chart.widget()`, an
anywidget) keeps the current data in Python and sends each change as one
message: appended or replaced columns as binary buffers, changed options as
JSON. Messages carry a revision number. A browser that connects late,
reloads, or misses a message asks for the whole chart, which Python builds
from the current data when it is sent (holding the lock that orders
updates); it is not stored in the widget state, so updates never re-send
it. A range brushed or zoomed in one browser goes through Python to the
others, marked with its origin; a range report made before a newer change
from elsewhere is dropped. Views of one widget share its tables and marks
in the browser, so an update is decoded once however many outputs show it.
The Streamlit component (`herceg.streamlit.chart`, components v2) has no
connection that outlives a script run, so every run sends the whole chart as
one binary payload: a uint32 header length, the JSON header (spec, buffer
offsets, events the script reacts to), and the buffers at 8-byte aligned
offsets, viewed in place as typed arrays. Streamlit calls the component
again on every run and on theme changes; equal bytes keep the drawn chart,
and changed bytes redraw it in place, keeping the zoom along x and y and the
whole selection (on category axes, by its categories' labels), though the
script hears only of x ranges. Charts without a theme read the app's from the
CSS variables Streamlit gives components, since Python may not know it.

A test (`test/architecture.test.ts`) keeps the core directories (`data`,
`scale`, `format`, `lod`, `marks`, `model`, `scene`, `spec`) free of DOM
access. Marks import their drawings (`draw`), which write SVG without a DOM
and paint canvases through the context they are handed; only raster
painting reaches the DOM, creating an offscreen canvas in that canvas'
document when `OffscreenCanvas` is unavailable.

## Known limits

- Geometry is stored in single precision (`Float32Array`) pixel
  coordinates. When zooming leaves neighboring points more than about 10^7
  pixels outside the plot (a view of a millionth of the data's range or
  less), lines and curves between them can be visibly displaced.
- Mark types: line, area, bar, point, heatmap, error bar, candlestick, histogram, the rule, region,
  and text annotations, and custom marks. Horizontal bars need a category y;
  bars along a number or time y are not supported. Error bars stand at the
  center of their position, not beside grouped bars; horizontal ones at y
  positions a log axis cannot place still count toward the x domain.
- Custom marks are JavaScript only, cannot bind category fields other than
  `series`, and are inspected at their series' points, not by the shapes
  they draw; custom marks without series have no legend entries or tooltips.
- Annotation fields cannot be categories (constants on a category axis are
  band indices); text has no collision avoidance or connectors. Bar value
  labels estimate text widths from the font size to decide what fits.
- Continuous color only for heatmaps; points cannot be colored by a numeric
  field.
- One x axis and at most two y axes per chart; category values and marks
  placed along y (horizontal bars and error bars) only on the left.
- Facets wrap one category field into rows of panels, or lay out a grid by
  two, sharing x; y is shared or resolved per panel, row, or column, for
  continuous axes only. No independent x scales, y zoom with independent y,
  or right axes in faceted charts, and
  heatmaps, histograms, box plots, violins, stacked bars, annotations over a
  table, and custom marks over a table without series can only repeat in
  every panel. Panel splits are recomputed whenever their
  table changes, and rows of a faceted large line do not use its min/max
  index. A category whose rows all lack a facet value still gets an (empty)
  band. Panels smaller than 20 pixels a side are refused with an error
  rather than drawn.
- Heatmaps are limited to 4,194,304 cells and have no built-in binning.
- Box plots and violins recompute every group's statistics (and violins
  their densities) when their table changes, and repeat in every panel of
  charts with facets rather than splitting. On a log axis, a box or violin
  whose median is zero or below has no tooltip or keyboard stop, though
  its positive part is drawn.
- A pie, treemap, sunburst, gauge, funnel, radar, or Sankey diagram has its chart to itself: no
  other marks, facets, zoom, brushing, or sync. Pie labels go beside the pie
  only; treemaps and sunbursts have no drill-down, and their pointer lookup
  scans each level's children. A gauge shows one value, with no needle, ticks,
  or threshold marker; a funnel colors every stage alike and has no
  trapezoid (area-proportional) layout.
- Every spoke of a radar shares one scale: there are no per-spoke domains
  (as ECharts' indicators have), log scales, circular grids, or labels on
  the polygons' values. A radar draws at most 100 spokes, and its pointer
  lookup scans every drawn value.
- Sankey diagrams leave out links that close cycles rather than drawing
  them looping back, and links spanning several columns pass behind the
  nodes between. Nodes cannot be dragged or placed by hand, and there is no
  highlighting of a node's links on hover. The whole layout is recomputed
  when the table changes, and the pointer lookup scans every node and link.
- Selections report ranges and lasso outlines, not the rows inside them.
  Synced selections are data values, so charts with differently ordered
  categories select different categories. The keyboard selects ranges only;
  rectangles and lassos need a pointer.
- Rolling statistics over values whose differences exceed the largest double
  (about 1.8e308) overflow to Infinity.
- Python derived tables count their source's rows through one of its
  columns, so a source whose columns nothing reads needs at least one that
  converts (numbers, strings, or dates).
- The model always carries band-axis, color-legend, inspection-along-y, and
  right-axis logic, so a line-only bundle includes some bar, heatmap, and
  second-axis support it does not use.
- Bands, stacked areas, log scales, and long-format series re-scan the
  visible range on every frame; only whole-column lines and areas filled to
  zero on linear scales use the min/max index.
- Renderer thresholds are not tuned.
- Rules and text are always drawn above other marks, regardless of mark order.
- The GPU draws only large point series; lines, areas, bars, and heatmaps use
  Canvas or SVG. Uploads are not incremental: streaming a large point series
  uploads it again on every change.
- PDF text is limited to the standard fonts' Windows-1252 characters (others
  print as "?"); fonts are not embedded, so Greek, Cyrillic, and CJK labels
  need SVG or PNG export. PDFs are not tagged for assistive technology,
  colors must be hex, `rgb()`, `hsl()`, or names, transparent backgrounds
  show as white paper, and halos of labels are read twice by readers that
  ignore replacement text (macOS Preview).
- No adapters for frameworks other than React, Vue, and Svelte. See the
  roadmap in the repository README.
