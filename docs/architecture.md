# Architecture

This document describes how Herceg is built today and why. It is the reference
for contributors; user-facing usage lives in the package README.

## Vocabulary

One name per concept, used the same way in code and docs.

| Term | Meaning |
| --- | --- |
| **Table** | Columnar data: named columns of equal length (`Table`). |
| **Field** | The name of a column in a table. Encodings refer to fields. |
| **Column** | The typed storage behind a field: numbers, times (epoch ms), dictionary-encoded categories, or geometries (codes into a shared set of shapes). |
| **Encoding** | A mark option naming a field whose values a visual property follows: `size` (point area, within `radiusRange`), `color` (a number or time field on a continuous scale, or a category field with a palette color per value), `fillOpacity`, and `symbol`. Constant counterparts name what they set: `radius` in pixels, `fill` and `stroke` for paint. |
| **Text roles** | `label` is constant text (a series' or mark's name, every annotation's text); `labelField` and `textField` name fields with each record's or annotation's text; `title` heads a chart, a panel, or an axis; `labels` turns drawn labels on or off. Python spells every option in snake_case (`radius_range`, `label_field`, `facet_column`), and `herceg.express` takes the same names as the marks (`series`, `series_order`, `facet_row`, `facet_column`, `whiskers`, `normalize`). |
| **Mark** | One visual layer of a chart (`line`, `area`, `bar`, `point`, `heatmap`, `rug`, `dendrogram`, `errorbar`, `candlestick`, `histogram`, `boxplot`, `violin`, the annotations `rule`, `region`, `text`, and JavaScript-only `custom` marks). A mark pairs a spec with the table it reads; a network (`graph`) also reads a table of nodes. Layout marks (`pie`, `treemap`, `sunburst`, `gauge`, `funnel`, `radar`, `sankey`, `graph`, the map layers `geoshape` and `geopoint`, and the 3D layers `point3d` and `surface`) place their own geometry instead of using x and y scales. |
| **Item** | One thing a layout mark draws, such as a pie slice, a tree's node, a gauge's dial, a funnel's stage, a radar's value on one spoke, a Sankey diagram's or network's node or link, a map's region or point, or a 3D chart's point or surface grid point: what its tooltips and the keyboard visit. |
| **Projection** | Maps longitudes and latitudes to the plane a map is drawn in (`projection`, a chart option): Equal Earth, Natural Earth, Mercator, equirectangular, or conic equal-area. |
| **Camera** | Where a 3D chart is seen from: an azimuth about the vertical axis, an elevation above the floor, a zoom, and orthographic or perspective projection (`camera`, a chart option for the first view; then chart state the pointer and keyboard change). |
| **Series** | One drawn line, area, bar set, or point set within a mark: one y field, or one category of a `series` field. Legend entries and tooltip rows are series. |
| **Orient** | The axis a line or area runs along (`orient`, "x" or "y"): the axis of its positions, which it is traced, reduced, and read along; its values are on the other. Bars lie along y when their positions are a category y, histograms when they bin `y`. |
| **Scale** | Maps data values to pixels: linear, log, time, or band. A band scale maps category indices to evenly spaced bands. |
| **Break** | A span of time a time axis leaves out (nights, weekends, holidays): the axis measures the time it shows, and data inside a break is not drawn. |
| **Axis** | The visual guide of a position scale. In specs, scale and axis options share one object (`x`, `y`). |
| **Viewport** | What a chart shows when zoomed: `{ x, y, yRight }`, the visible x range (one per x scale when panels have x scales of their own) and the left and right y axes' ranges; null for an axis that is not zoomed, which shows its configured domain or its data. A map's are ranges of its projection's plane; a network's are ranges of its force layout, with y increasing downwards. |
| **Drill root** | The node a treemap or sunburst is drilled into, whose subtree it lays out (`getDrillRoot`, chart state that clicks, keys, and `setDrillRoot` change, shared by facet panels and each subplot's own); null for the whole tree. |
| **Controls** | What a chart of a 3D, map, tree, or network mark loads to turn, pan and zoom, drill, or move nodes by pointer, keyboard, and toolbar (`dom/controls.ts`). |
| **Spec** | The portable, JSON-serializable description of a chart (`ChartSpec`). |
| **Scene** | The render plan for one frame: panels, title, and legend in CSS pixels, with no data references. |
| **Panel** | A plotting area of a scene: its plot rectangle, grid, axes, and geometry. Data is clipped to the plot; guides (rules, text) are not. A chart has one, or one per facet value or subplot, and with a navigator, the strip under them is a panel of the scene too, though not one the chart inspects or zooms. |
| **Navigator** | A strip under the plot (under every panel, with facets or subplots) drawing a chart's marks over its whole x axis, with a window over the x range in view (the viewport) that the pointer and keyboard move and resize (`navigator`, a chart option made by `rangeNavigator`). |
| **Geometry** | A mark's part of the scene: packed polylines (lines, areas), rectangles (bars, regions), segments (rugs, error bars, candle wicks, dendrogram links, network links and arrowheads), points (network nodes too), a raster (heatmaps), arcs (pie slices, gauge dials), polygons (a map's regions), rules, text, shapes (custom marks, a gauge's value, funnel connectors, a directed network's bowed links), or faces (a 3D chart's surface cells and points, in drawing order). Geometry columns of tables are shapes in longitude and latitude, not scene geometry. |
| **Renderer** | Turns a scene into pixels or markup: SVG markup, retained SVG DOM, Canvas 2D, PDF. |
| **Chart** | A mounted, interactive chart in the browser (`createChart`), and the handle applications hold to it (`Chart`). |
| **Row view** | A table's rows filtered, restricted to a row set, and sorted, as positions into the table (`RowView`); no column is copied. |
| **Row groups** | A row view's rows grouped by the values of some fields, level by level (`RowGroups`, made by `groupRows`): each group's key path (its value of each field down to its level), its parent and children, the positions of its rows, and per level a table with one row of aggregates per group. |
| **Row pivot** | A row view's rows as a crosstab (`RowPivot`, made by `pivotRows`): a row per value of one field and a column per value of another and aggregate, over row groups by the two fields, with an index from each row and value to their combination's aggregates. A combination none of the rows holds is absent. |
| **Grid** | A mounted grid in the browser (`createGrid`) showing a row view's rows, or its row groups as header rows each followed by its groups below (or its rows) when expanded, or a row pivot's rows (`createPivotGrid`), or a grid source's rows (`createRemoteGrid`), drawn from a grid model (`GridModel`, `RemoteGridModel`), which holds its columns, scroll position, expansion, focus, and selection without a DOM. |
| **Grid query** | What a remote grid asks of a grid source, as portable JSON (`GridQuery`): a filter expression, sort keys, and optionally groups with aggregates; never layout or interaction. |
| **Grid source** | Rows that live elsewhere (a server, a worker) behind `GridSource`: it answers a grid query in windows of typed columns, from a snapshot the query's first answer starts. |
| **Grid column** | A column a grid shows, with its id, title, width, alignment, and format: a field (`GridColumn`), or a column a row pivot generates for a value and an aggregate (or a total), named by an id of those. Not a table's column (its storage). |

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
       ──>  renderPdf()      PDF page/document (herceg/pdf)
       ──>  SvgLayer         retained SVG DOM
       ──>  paintCanvas()    Canvas 2D for dense marks
        |
        v
Chart (browser runtime): scheduler, pointer/keyboard, tooltip, legend, zoom, sync
```

The model never touches the DOM, so the same code produces server-rendered
SVG (`renderToSVG`) and browser charts. Text measurement is injected: the
browser uses a canvas context, static rendering uses built-in Helvetica
metrics (an even 0.6 em per glyph for monospace fonts) padded by 10%.

## Data model

Tables are columnar. Each numeric or time column is one typed array; category
columns store `Int32Array` codes (−1 for missing) plus a string dictionary.
There are no per-row objects anywhere in the pipeline.

- **Zero-copy input.** Typed arrays passed to `table()` are used in place.
  The table never writes into them: the first mutation copies them into
  buffers it owns (copy-on-write). Plain arrays, Dates, and strings are
  converted once. A field's kind comes from its values or a tag, never from
  its name or magnitudes: `time()` reads epoch milliseconds, Dates, and ISO
  8601 strings (as `Date.parse` does, which spec columns share), and
  `category()` strings or numbers, labeled as `String` writes them.
- **Writes that fail change nothing.** `append` and `replace` check every
  value a column keeps (numbers, times that parse, strings or numbers for
  categories) before any row is dropped or written, so a value of the wrong
  kind throws with its row and leaves the table as it was; of a batch longer
  than `maxRows`, only the rows kept are checked. Checking allocates
  nothing, so streaming one row at a time costs what it did.
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
- **Geometry columns.** Shapes for maps are stored as category labels are:
  an `Int32Array` code per row (-1 for none) into a set of polygons packed as
  GeoArrow nests multipolygons (`data/geometry.ts`): float64 longitude,
  latitude pairs and int32 offsets of rings, polygons, and geometries. The
  set is checked once (offsets that start at 0, never decrease, and end at
  the next array's length; coordinates within ±540 degrees of longitude and
  ±90 of latitude, which catches data in projected reference systems), never
  written, and shared: tables move, drop, filter, and sort 4 bytes per row,
  derived tables hold their source's set, and appended rows name existing
  shapes by code (checked before anything changes). New shapes come with a
  new column (`reset`). A table's `byteLength` counts the codes; the set is
  counted once wherever it is shared (`geometryBytes`). Derived steps carry
  geometry fields through and refuse them as values (expressions, bins,
  sorts, groups). Tables do not depend on the geometry module: a geometry
  input builds its own column, so line charts do not bundle it.

Memory amplification over the source data is therefore: reserved capacity
for tables that grow (about 0.5x the live rows right after growth; at most
0.5x `maxRows` for rolling windows; after drops, up to about six times the
live rows until an explicit drop shrinks the buffer), 4 to 6 bytes per row for long-format grouping (each group's positions, with room for half as many again and at least 16), about 0.16 bytes per row for each field a long-format line or area indexes (up to twice that as a series grows, and about four times after its rows shrink; see Level of detail), two `Float64Array`s per
layer for stacks of fields (top and base, with up to 0.5x room to grow
like a table's), 28 bytes per row for bars stacked by a series field (each
row's top, base, position, series, and next row at its position) and 29
per position plus its `Map` entry, 16 bytes per row and 16 per layer and x position (plus 8
per x) for areas stacked by a series field (see below), and geometry
buffers bounded by the plot width.

Rows of a whole table split by a series field are grouped once and kept
current (`SplitRows` in `marks/split.ts`): appended rows are filed
into their groups, and rows a rolling window drops leave the front of each
group (a binary search) while the rest move down into a buffer sized for
them, instead of the table being grouped again each change. Rows given out
are never written again, since scenes and other charts sharing the mark may
still read them; appends only write past their end. Groups are keyed by name, since a window
may renumber a category's codes; a change to values in place, or a reset,
groups again. A row view's rows are grouped from scratch. Each group counts
the rows it has lost, which lets GPU uploads follow it (below), and keeps
min/max indexes of the fields lines and areas read over its rows (see Level
of detail). Its code (`marks/split.ts`, with the indexes and the reduction
through rows) loads the first time a chart groups a whole table's rows;
until then, and for good if it cannot load, rows are grouped again each
change, with the same result. Once it loads, the next scene groups through
it, whether or not the table has changed, and charts made later group
through it from their first scene. The grouping itself costs about
what grouping again did (both are passes over typed arrays; a rolling
window's drops still move every kept row). What it buys is what follows a
group from one change to the next: uploads, so a point cloud of a million
rows in two series, streaming 1,000 rows per tick, takes about 3 ms of
JavaScript per frame instead of 13 ms (Chrome, interleaved runs), and
indexes, so long-format lines zoom and stream at about the cost of whole
columns.

Stack offsets live in `marks/stack-offset.ts`, imported by the area/bar stacking
modules, with no dependency from the line entry. Row storage accepts an offset
routine from its mark: bars use fill alone, so they carry no area ordering or
stream baseline code. The portable area `stack` is boolean, `"fill"`, `"center"`,
or `"wiggle"`; bar `stack` is boolean or `"fill"`.
Fill means the same per-position shares as histogram fill. New modes require
nonnegative finite contributions; NaN and infinities remain per-layer gaps and
count as zero for other layers. Zero totals have zero thickness. Mixed signs
require ordinary signed stacking. Input-order fill/center operate on the rows
or union positions being restacked, retaining incremental append/drop behavior.
Union offsets retain an explicit first base (one extra float64 per position).
Fill also keeps one float64 total per row, shared across layers, and union fill
one per aligned position; readings use source values divided by these totals
rather than subtracting rounded cumulative boundaries.
Wiggle uses the Byron–Wattenberg weighted-slope recurrence in position order,
starting at zero; inside-out balances layers in peak-position order, preserving
series identity and legend order. Both recompute after a retained-window change.
Sorted wiggle positions can be visited directly; unsorted inputs need an order.
Peak ties preserve chronological occurrence order. Category key-list identity
invalidates cached offsets and union edges without disabling numeric append paths.
Every cumulative offset boundary must remain finite; overflow asks the caller
to rescale values.
Facet field stacks offset each panel's rows directly in table-sized owned
arrays, without packing or streaming scratch stacks. Each chart's facet planner
owns a cache keyed by table version, panel rows,
visibility, and category positions. Unchanged redraws keep boundaries, and
restacking reuses buffers of the same size. Series-field facets offset their
own union. Zoom never changes the retained-data denominators or stream baseline.

Fill's automatic value domain is 0–1; axis percent formatting is explicit.
Center and wiggle use raw extents and refuse logarithmic value scales. Mark-local
`pointText` hooks supply shares with raw values for fill. Streams use ordinary
inspection, which formats raw thickness with the value axis's tooltip formatter.
Center requires nonnegative thicknesses; d3's silhouette accepts signed inputs
algebraically, and its separate diverging offset splits positive and negative
layers. Herceg's signed option is `stack: true`. Bar value labels use shares for
fill.
Inspection events retain source values for area/bar, and existing bin-share
values for histograms, whose text also gives raw counts/weights. Missing and
interpolated synthetic rows never become observations. All render/export paths
read the same boundaries. Input-order areas along x retain value animation;
inside-out order changes display immediately to avoid crossing layers.

Stacks of several fields sharing rows (`marks/stack.ts`) are kept current
as the table streams: appended rows are stacked on their own and dropped
rows leave from the front, using the table's stable row identities
(`rowOffset`) and `modifiedVersion`, the version of the last change to
values already present; anything else (a replace, a reset, a layer hidden
or shown) stacks every row again. Long stacks (from 262,144 rows) keep
min/max indexes over their tops and bases, so y extents and band tracing
read a few blocks per pixel column rather than every row when the view has
no gaps. Bars of several fields stack row by row only when their positions
strictly increase, and by position on every change when they repeat. Over a
million-row window with 10,000 rows appended per tick, five stacked area
layers take about 4 ms a frame instead of 32 ms (unstacked, about 3 ms);
five stacked bar fields over 100,000 rows take about 5 ms instead of 18 ms,
as much as grouped bars (one-off Node measurements of the scene, Apple M6).

Bars split by a series field stack position by position
(`marks/position-stack.ts`): each row links to the next row at its
position (an x value, or a band index, numbered through a `Map` and a free
list), in row order, so the rows a rolling window drops lead their
positions' lists. Appended and dropped rows mark the positions they are at,
and only those are restacked from their lists (series order, then row
order, positive values up and negative down); a position left without rows
gives its number back. Values replaced in place, a reset, series shown,
hidden, added, or gone, or a change of the band list (categories are band
indices) stack every row again. A window that leaves fewer than a quarter
of the numbered positions live numbers them again, rewriting each row's
position, so their arrays shrink; a stack rebuilt for the same layers
reuses its buffers, others get new ones, since another chart sharing the
mark may still read the old. Both stacks report the bytes they hold
(`byteLength`). For ten series of
10,000 positions in a rolling window, a position appended per tick costs
the stack about 0.09 ms with the grouping of its rows, against about 2.7 ms
to stack every row again (`npm run bench:core`). A chart's scene takes
about 2.1 ms a tick instead of 4.6 ms when every row was stacked again
(grouped bars: about 2.4 ms), a change of values in place about 4.1 ms
instead of 4.7 ms, and the first scene about 4.8 ms instead of 6.0 ms; in
Chrome at 60 Hz the stream costs about 4.0 ms of JavaScript a frame instead
of 6.4 ms (one-off runs interleaved with the version before, medians of
six in Node 22.23 and of three in Chrome 154, macOS 27, Apple M6). Bars of
several fields with repeated positions still stack from scratch on every
change.

Areas split by a series field stack on the union of their x positions
(`marks/union-stack.ts`): each shown layer has a top and a base at every x
any shown layer has a row at, in typed arrays laid out like a table's
columns (live positions in a buffer with room to grow), and each row also
gets the top and base of its layer at its own position, so tooltips, the
keyboard, events, and summaries read the series' real rows while geometry
and y extents read the edges (`Series.edges`, traced as a whole sorted
series of their own). A layer without a row at an x counts as zero there,
or with `stackGaps: "interpolate"` as the straight line between its last
row before and its first after (zero beyond its ends: zero at the union's
outside positions, so its edge ramps to its first row), and a missing
value at either end leaves the interpolation missing. Several rows of a
layer at one x pair with the others' by occurrence, the stack having as
many positions there as the layer with the most rows, and a layer with
fewer holding its last row, missing or not. Layers whose x does not ascend,
or is missing in some row, are merged through a private permutation sorted
by x (the series' own rows keep their order) and restacked from scratch on
every change. Otherwise an append restacks the positions from the first x
it changes (its rows' first x, or with interpolation their layer's previous
last x) to the end, after cutting the union there, and a rolling window's
drops restack the positions up to the new first x of the layers that lost
rows (as many or fewer than before, written where the old ones ended); the
positions between stay. Overlapping ends, a head longer than half the
union, or anything else stacks every row again. Unions of at least 262,144
positions keep min/max indexes of their edges, updated over rewritten
positions. The edges cost O(kU) for k layers over U positions, which is the
table's size when the series share their x and up to k times it when they
share none (100 series of 1,000 distinct x each: 160 MB of edges).
Streaming ten series of 10,000 positions, a position per tick, costs the
stack about 0.09 ms with its grouping, against about 2.4 ms to stack every
row again (`npm run bench:core`), and a chart about 1.9 ms a scene
(unstacked, 1.4 ms), the first scene about 3.9 ms (unstacked, 1.6 ms; the
one-off runs above). Layers in an order of their own stay stacked while
their table does not change. Facet panels stack their rows
from scratch (`UnionStack.once`), writing rows' tops into one pair of
table-sized arrays the panels share, and keep the result while the table,
the panels' rows, and the hidden series stay the same.

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

## Row views and selections

Derived tables compute rows; row views (`data/row-view.ts`) choose and order
existing ones, holding a `Uint32Array` of positions into their table and no
column. A view is lazy but invalidated eagerly: table changes bump its
revision and notify its listeners at once, and `read()` brings it current.
Catching up works from row identities (`rowOffset + position`), so several
changes are caught up together: rows that left a rolling window are dropped
and the rest rebased (O(kept)), appended rows (less any an oversized append
evicted) are filtered and, in sorted views, sorted on their own and merged
into the order in one pass (O(kept + appended log appended)), rows updated
in place in a field the filter or sort reads (recorded as ranges of
identities) leave the order and those that still pass are sorted and merged
back the same way (O(kept + changed log changed), with a byte per row over
the updated rows' span, or a search per row shown where the view is small
next to it), since the other rows keep their keys, and updates covering more than an eighth of the rows, a reset,
or a new query rebuild the view (O(rows), plus the sort). Filters compile
when they run, since a column's array can move and category codes change as
rows drop. The comparator (`data/order.ts`, shared with derived tables'
sort) compares keys in order, puts missing values last in either direction,
orders infinities, ranks categories by label once per sort, and breaks ties
by position, so orders are stable and settle the same way after updates. Like derived
tables, views are held weakly by their table's subscription.

A table's `generation` counts resets, which start identities again, so a
row's identity across resets is its table, generation, and `rowOffset +
position`. `RowSet`s (`data/row-set.ts`) are bitsets over identities from
the first row they could hold, bound to a generation; dropped rows' bits
are trimmed as the set is read (O(words)); `addAll` sets many bits in one
pass. `RowView.indexOf` finds a row's place by binary search, over positions
in unsorted views and with the sort's comparator (cached per table version)
in sorted ones. `SelectionStore`
(`data/selection.ts`) keeps an application's selections of one table by
channel, as portable conditions or local row sets; consumers choose which
channels they read and whether to filter or highlight, so a chart's brush
need not filter the chart that drew it. Grids write and show a channel, and
charts bound to one do too (see Selected rows).

Marks show a view's rows through the row lists series already carry
(`Series.rows`): a point mark over a view keeps the view's table as its
table and the view as `mark.view`; its series split copies the view's
positions (4 bytes a shown row, no column), since the view rewrites its own
when another reader catches it up while a scene's series and picks still
use them, splits them by series field too, and is cached by the view's
revision as well as the table's version; charts subscribe to marks' views
as to their tables. Facet panels are found from whole tables, so marks
over views only repeat in facets for now. Adapters treat marks over different views as different marks.
The WebGL painter uploads whole columns, so points of a view stay on the
CPU path for now.

## Row groups

Row groups (`data/groups.ts`, with each level's state in
`data/group-levels.ts` and the lists of groups' rows in
`data/group-members.ts`) group the rows a view shows by the values of some
fields, level by level: level `d` groups by the first `d + 1` fields, each
group's parent is the group of the level above holding its rows, and every
row belongs to one group of the last level. Each group keeps count, sum,
mean, minimum, and maximum, with derived tables' semantics (a count without a
field counts rows, with one its finite values; the others leave out missing
and infinite values). Groups are numbered per level in the order they first
appeared, and group `g` of a level is row `g` of its table, an ordinary
`Table` charts and grids read. One table per level, rather than one table
with a depth column, gives each level a schema of its own (the grouping
fields down to it, then the aggregates), which charts read as they read any
table and TypeScript types by the fields `by` lists (`tableOf`); a depth
column would leave the deeper grouping fields missing on parents' rows,
which cannot be told from a missing value, and would make charts filter it.

Each grouping field gives its values ids in order of first appearance
(category codes map to ids through an `Int32Array` per dictionary, numbers
through a `Map` in which NaN is one key, so missing values form a group and
-0 joins 0). On the first level the id is the group; below it, a map per
level takes `parent × 2^26 + id` to the group, adding it (with its parent and
own value) when new. Groups keep their own value and parent in parallel
arrays, and key paths, ids, and children lists are made from them when
asked for. The last-level group of every position the view shows is kept
in an `Int32Array` over the table's rows (-1 for rows it leaves out), as a
window that slides as the table drops rows, compacted or grown when appends
reach its end. Running aggregates are `Float64Array`s per level and
aggregate. A computation from scratch visits rows in table order, whatever
the view's sort (the view's positions are marked in that array, then read in
order), adding them to the last level's groups, whose aggregates then add up
into each level above: a parent's mean is its rows' sum over their count,
never a mean of its groups' means. Sums are compensated (Neumaier: each
group's running sum and what rounding left out of it, whose correction is
exact) and add up what adding to that remainder rounded away (exactly, by
Knuth's two-sum, so exact arithmetic loses nothing). Once a batch is in, a
changed group whose losses pass an ulp of its sum (values cancelling: a
large value leaving a window, or values of opposite signs arriving) is
stale, and its sum is computed again exactly (Shewchuk's partials, as
Python's `math.fsum`) from its rows, kept as the rounded sum and its exact
remainder, whose own rounding is its new loss. So a last-level group's sum
is within about an ulp of the exact sum of its rows whatever rows came and
went, and can differ from a derived table's plain sum in the last digits. A
stale group above adds up its groups' sums exactly, with their losses; when
those still pass an ulp of its sum (its groups cancelling), it reads its
rows too. A last-level sum that overflows is infinite, with an unknown
loss, until a row leaves it, which computes it again (plainly, where the
exact partials overflow too); a sum above that overflowed or became
missing adding its groups' sums, which its rows need not, reads its rows,
and an overflow found there is kept, like a last-level one, until a row
leaves it.
A minimum or maximum of zero above the last level may differ in sign from
a derived table's, which keeps the first in table order. Over values spanning 40 orders of magnitude with random signs
in a rolling window, every level stayed within an ulp of the exact sums
(4,000 steps, four seeds, `tmp` fuzzing).

Groups follow the view's table through its change events (which also give
the fields an update touched) and the view through its `queryRevision`.
Rows appended and rows dropped from the front (no reset, query change, or
update of a field the groups read: grouping fields, aggregated fields, and
the view's filter's) are added to and taken from their group at every
level: O((appended + dropped) × levels × aggregates), plus a scan of the
view's positions for sorted views, where appended rows merge anywhere.
Taking a row away needs its values, which the table no longer has once it
dropped the row, so groups over a table that drops rows (one with `maxRows`,
or once it first drops some, which computes the groups again) keep the
values of each field the aggregates read for every table row, shown or not,
at the same window indices. A sum whose values all left is 0 exactly. A
group whose minimum or maximum left (or whose sum overflowed) is marked
stale and computed again: a last-level group from its rows (listed for it
if they were not), in table order as a computation from scratch adds them,
a group above from its groups below. Since the table compacts a dictionary as
rows drop, renumbering its codes, groups forget their codes' ids whenever
rows drop (a fill over the dictionary's size) and find them again by label. Anything else
computes every group again (O(rows)), starting from the same ids, so groups
that remain keep their numbers. Groups left without rows are then dropped,
level by level from the first (a group's groups below leave with it), their
keys' ids forgotten, and the rest renumbered in order; the window's groups
are renumbered too (a pass over it).

Each level's table is changed where values differ: a `replace` of each
aggregate over each run of changed groups (runs closer than 64 groups merge,
since another call costs about as much as copying them), then an `append` of
new groups; a level that lost a group resets its table. So an update costs
O(changed groups), however far apart they are. The tables are a `Table`
subclass of the module's own whose listeners hear those writes as one
change (its appended rows, the updated range, and the fields, or a reset),
told once every level's table is written: none of them sees some
aggregates or levels updated and others not, so a grid read from a
listener of the first level's table orders groups by every level's final
aggregates. A `Table` method writing several fields at once would do the
same, but every chart would bundle it.
An update of a field only the view's sort reads keeps the aggregates and
only reorders the groups' rows. Reads catch up first, so a listener of the
table that runs before the groups heard of a change reads it already (a
change no listener call described, seen only through the version, is
treated as an update of every field); a listener of the groups' tables that
changes their source is caught up with once the groups' own changes are
told, and meanwhile reads the groups as they were before its change: their
rows still in the table, listed for that read only, so no list built
against a newer view outlives it. Listeners of the groups themselves
(`subscribe`) are told once the groups caught up, such changes included.

The rows of each last-level group, in the view's order, are listed only
when a reader asks (a grid with a group expanded, selecting a group, or a
stale minimum): one packed `Uint32Array` holding every group's run of rows,
each in a slot with a quarter more room after it, as row identities less a
base, so rows dropped from the front move no entry. From then on they are
kept current: appended rows are written into their run's room (rows of
views in table order at its end; rows of sorted views merged in, from the
back), dropped rows leave the front of their run (or, in sorted views, are
filtered out of it), and a run without room moves to the end of the vector
with room for half as many again, the vector being packed anew when its end
is reached. A new query, a reset, an update of a field the groups read or
the view sorts by, or identities outgrowing 32 bits drop the lists, to be
listed again when next asked for. `memberAt` reads a row by its index in a
group's run; `memberIndex` finds a row by binary search with the view's
comparator; `members` copies a group's rows (a group above: its last-level
groups' rows in turn). A group's key is its path of values (labels,
numbers, or null) and its id the key as JSON with infinities as text: keys,
not numbers or codes, name groups to readers, since numbers change when
groups are renumbered and codes when dictionaries are compacted; a key's
length tells its level. The groups' tables keep the groups alive (a
`WeakMap`), and the tables and view hold them weakly, as views are held.

Memory: 4 bytes per table row (each row's group, with half again as room
once rows are appended); for tables that drop rows, 8 bytes per row (with
the same room) for each field the aggregates read; once rows are listed,
about 6 bytes per shown row; and per group and level, 8 bytes per running
value, 24 more per sum or mean (its compensation, error bound, and count),
and a few for its parent and marks. `byteLength` counts these typed arrays, not the keys,
ids, and maps of values, which grow with the number of groups. At a
million rows and a thousand groups, one level takes 4 MiB at first and
grouping takes about 17–20 ms (12–13 ms with plain sums), where a derived table's filter and
aggregate take about 40 ms and allocate copies of the filtered columns
(about 98 MiB for 20 fields); 1,000 appended rows update them in about
0.1 ms (one-off Node measurements, Apple M6). Over 100,000 rows of 20
fields with five aggregates (two of them sums), one level of 100 groups
takes about 1.6 ms to group (1.1 ms with plain sums), and three levels of
ten groups each about 6.5 ms (5.9 ms as one level of their thousand
combinations with plain sums): finding groups through the maps dominates.
In a rolling window of 100,000 rows taking batches of 500 through two
turnovers, a batch and a grid's frame of model work take 0.12 to 0.4 ms at
the median and 0.4 to 0.8 ms at the 99th percentile, where computing the
groups again took 2.5 to 6 ms; 1.2 ms for a sorted and filtered view
(whose own merge and drop pass over its rows; 3.9 ms before); 0.75 ms for
minimums and maximums of a field that rises with time, which leave nearly
every group with every batch (2.8 ms before); and 0.14 ms for sums of
values cancelling exactly, which read no row again. That costs about
4.5 MiB of values kept for four aggregated fields. With keys nearly unique
(about 63,000 groups of 100,000 rows), groups vanish with every batch and
each level that lost one is renumbered and its table reset: 13 ms (38 ms
before) collapsed, and as slow as before (about 36 ms) fully expanded,
where 63,000 headers are placed again. (Interleaved Node measurements
against the previous implementation, Apple M6.)

## Row pivots

A row pivot (`data/pivot.ts`, `herceg/pivot`) is row groups by its rows
field and its pivot field, made with bounds (below), and an index over
them, so pivots have no aggregation of their own: the first level's groups
are the pivot's rows (their table, `rowTable`, holds each row's totals,
folded from its rows' sums and counts like any level above the last), and
the second level's groups its observed combinations, whose table is the
long table charts read. A wide table of every value as a field would change
its schema with every new value and cost rows × values × aggregates; the
long table costs the combinations the rows hold.

The crosstab (`read()`, data/pivot-index.ts) gives the pivot's values slots
in the order they first appear among the combinations (category codes of
the long table map to slots through an `Int32Array`, numbers through a
`Map` in which missing is null), keeps each combination's slot (an
`Int32Array` with room), and orders slots for columns: categories by their
place in the source field's dictionary (found in one pass over it that
stops once every value is placed), numbers and times ascending, missing
last. The index maps a row (a first-level group) and a slot to the
combination's position, from the second level's parents (`parentsAt`, a
borrowed array): dense, an `Int32Array` of rows × slots, row-major with room
for half again of each, while that is at most 2^20 entries (twice that for
an index already dense, so a pivot near the line does not switch back and
forth) or no larger than sparse; else sparse, compressed rows of slots,
ascending, and positions, built by two counting sorts (by slot, then by row)
and searched by bisection within a row. Snapshots are kept while the
tables' generations and lengths are; appends that add rows, combinations, or
values extend them (a dense index in place, unless it lacks room; a sparse
one is built again), and a renumbering of either level (a group left
without rows, a recomputation) builds them anew. What the next read would
build anew is let go as soon as the groups followed the change (the
crosstab of renumbered groups, an index that cannot take the combinations
added in place), so a pivot never holds a stale index beside what it was
counted for. Aggregates are read from
the long table when asked for, so a snapshot holds no values.

Generated columns are each value's aggregates, then a total per aggregate.
Their ids are JSON arrays: a tag, the pivot field, the value's kind and
value (numbers as text, so infinities keep apart from labels) or a missing
or total tag, and the aggregate's name, operation, and field. They hold no
place, code, or label as shown, so readers can key layout by them while
values come and go; an aggregate redefined under the same name is another
column.

Limits are the groups' bounds (`GroupBounds`): before groups change they
are asked what the change would make them, in table rows tracked and per
level groups and values. Groups being made ask as they take room for the
rows and as they add each group, so a refusal comes as the limit is passed,
with what was made within it discarded. Groups following their view count
first, without changing anything (a pass over the appended rows, or over
every row for a recomputation, with temporary maps of the keys new to each
level, asking as each is counted), so a refused change leaves them exactly
as last published: they stop following and answer reads as they would
have then, for rows still in the table, from their own record of each
row's group rather than the view (whose query may have changed since),
which the pivot's tables and crosstab go on showing; its grid selects
nothing more. The table's other listeners hear nothing of it, and the
pivot's listeners hear of it as of any change: they are its groups'
(`RowGroups.subscribe`), told once the groups followed a change of their
table or view, with any change their tables' listeners made meanwhile, or
refused one. Bounded groups that compute
every group again number them afresh rather than keeping their numbers, so
groups the rows no longer hold, which would be dropped only afterwards,
never count. A batch's dropped rows are counted as still there, so a
combination they leave empty counts while the batch is counted. The pivot's
bounds count generated columns as values × aggregates (and the totals),
observed combinations as the second level's groups, and owned bytes as the
groups' typed arrays (which the groups report, as part of what they are
asked) and the pivot's own. The groups report what they hold now, measured,
plus what growing to the count takes by their own policies (levels and
tables to at least 64 groups, then half again; the row window to half
again; code lookups to half again of their dictionaries), plus the most
their readers can still make them take: every group's rows listed (runs
with a quarter more room each, a quarter more after them, half again of a
run once it grows; their places, which never shrink, counted apart), in a
sorted view's order (with its ranks of category labels), the levels'
children lists, and room to read a whole group's rows again. The pivot adds its index, each combination's slot, its
tables with their room, and by fixed estimates per entry the JavaScript
maps, keys, values, and category entries, and the generated columns. A
pivot of no rows is weighed too (its totals' columns, its fields'
dictionaries). So the typed arrays held stay within what was counted:
bounded groups that compute every group again give back their levels' room,
all groups give back a level's room once groups leaving it leave it more
than twice what the rest need, and a category field's lookup once its
dictionary shrank (rows dropped, a reset) below the room it took; the view's
order the groups cache (with its ranks, and the table's arrays it reads) is
dropped whenever they follow a change; and a randomized test of appends,
drops, resets, filters, updates, and listed rows holds the pivot's typed
arrays within the limit at every step. The limit guards an estimate, not
the heap: JavaScript objects are counted by fixed allowances per entry,
which long labels (repeated in column ids) or a runtime's own object
overhead can exceed, and peaks while an array is reallocated are not
counted. Over pivots of 100,000 and a million rows the estimate came to 1.5
to 4.2 times the memory measured after the pivot was made, before any rows
were listed: the most where groups have many rows each, whose lists it
counts.

A pivot of a million rows by 100 row keys and 10 or 100 values (three
aggregates) builds in about 40 ms, as long as grouping by the two fields
(up to a fifth longer where nearly every row starts a group, each asking
the bounds),
and keeps about 4–6 MiB beside the source's 23 MiB; with 100,000 row keys of
two values each (about 200,000 combinations) it takes 0.16 to 0.28 s and
73 MiB, of which 39 MiB are typed arrays, the rest the groups' maps, keys,
and tables. The index takes at most about 5 ms of that. Following
1,000-row appends to a pivot of 100,000 rows takes about 0.7–1.3 ms with
the view and the groups, 2–3 ms when each adds combinations to a sparse
index of 70,000–80,000, and 0.6–6.6 ms in a rolling window, where groups
vanish and the index is built again (one-off Node measurements, Apple M6,
other work on the machine).

## Grids

A grid (`herceg/grid`) shows a row view's rows. Its state lives in a
DOM-free model (`grid/model.ts`, also the entry point `herceg/grid/model`;
what it shares with the remote grid's model, below, is in `grid/base.ts`),
in three parts kept apart: the query is the view's (filter and sort, which
the model changes through `view.setQuery`, keeping the filter); the
presentation is the column list (order, widths, pins, hidden columns,
formats), placed as prefix sums of widths; and the interaction is the
model's own:
viewport size and scroll offsets, the focused cell, and the selection anchor,
with the selected rows themselves in a `SelectionStore` channel. The view,
store, and table belong to the application, and several grids share them
with a model each, since a model holds one viewport and one focus.

The model is lazy like the view. Changes to the view, its table, or the
store notify the model's listeners at once, and the next read catches up,
without notifying again (readers inside listeners would otherwise loop).
Rows are followed by identity (generation and `rowOffset + position`),
found again with `RowView.indexOf`, whose search is exact since sorted
views break ties by position. Catching up after a change of the
table, but not of the query (`RowView.queryRevision`, which counts
`setQuery` and `restrict`), puts the row that was at the top back where it
was, so rows dropped from a rolling window or sorted in above do not move
the rows in view; a new query, a reset, or a top row gone keep the pixel
offset. The focused cell keeps to its row through sorts and streaming; when
the row leaves, the focus goes to the row now at its last index, or to the
header row when none is left; a hidden column's focus goes to the nearest
shown one. Formatting reads values through one Intl formatter per column,
made once (format/format.ts caches them), and keeps no strings.

The column list is the one record of the layout, keyed by column id:
`resizeColumn`, `moveColumn`, `pinColumn`, and `setColumnVisible` replace
one entry or reorder the list, and `model.columns` gives it back for
`setColumns` to restore. What a column shows (its title, alignment,
formatter, and reader) is made when the columns are set, for hidden columns
too, and kept by the commands: placing the columns again is one pass over
them (O(columns), as are the binary searches of the visible range), and the
DOM grid tells by that content's identity that no cell's text needs writing
when columns only move, resize, pin, or hide. Shown columns are placed
pinned left, then unpinned, then pinned right, each in the list's order, so
pinning keeps a column's place for when it is unpinned, and a move within a
side is a move in the list. Widths are at least 32 pixels; the focus keeps
to its column's id through every command.

Pinned columns are held at their edges while together they leave the
others 120 pixels of the viewport (`MIN_SCROLLING_WIDTH`), and otherwise let
go: their layout entries say `pinned: null`, and they scroll with the
others in the same order until the grid widens (before it is measured, they
are held). Holding is the layout's only dependence on the viewport, so a
resize of the container places the columns again only when it crosses that
line. A held pinned column widens only as far as that room, and
`pinColumn` refuses a column without room to be held (`canPin` asks first),
so an interactive pin never lets go of the others; `setColumns` takes pins
as given, to restore layouts on narrow screens. Held, they take no
part in horizontal scrolling: the visible range and `reveal` cover the
unpinned columns between the held widths, and the scroll range is unchanged
(the content's width less the viewport's equals the unpinned columns' width
less the room between the pins).

Grouped grids show a row groups' groups (`grid/grouped.ts`), each a header
row followed, when expanded, by its groups of the level below or, on the
last level, by its rows. The model keeps the expansion as the ids of groups
(key paths, so any level) expanded otherwise than by default (all
collapsed, or all expanded after `expandAll`), so groups keep it as rows
stream, through resets, and while a group above them is collapsed; ids of
groups gone are forgotten once they outnumber the groups present. The
display is the headers shown, in order: the first level's groups, and under
each expanded group its children (the groups' children lists, made by a
counting sort by parent) ordered among themselves by the keys of the group
sort that their level's table has, or as they appeared. Each header's group,
depth, row index (prefix counts of headers and expanded rows, a
`Float64Array`), and place among its siblings are parallel arrays, with a
rank per group and level (-1 while hidden), so a row index finds its header
by binary search and a table row as an offset past its group's header; no
object stands for any row. It is rebuilt when the groups, their order, or
the expansion change: its arrays are made and filled for every group
(O(groups)), but only the groups shown are visited, their expansion read,
and their siblings sorted; collapsed groups' children are neither sorted
nor visited. Rows of collapsed groups are not
shown; the focus, the row at the top, and a range's anchor follow table rows
by identity and headers by key, and a row or group hidden by a group
collapsing above it resolves to the header of the first collapsed group on
its path. Expanding or collapsing keeps the top row in place; new groups or
a new group order keep the pixel offset, as a new query does. While rows
stream into an expanded grid, the rows of its groups are kept current (see
Row groups) rather than listed again each change.

Selecting a header selects the rows of its group (and its groups below)
into the row set. How many rows of each group are selected is counted once
per selection and change of the groups' rows: a pass over the row set's
members, or for a condition over the table, finding each row's last-level
group, whose counts then add up level by level. Appends leave the counts of
row sets alone (appended rows are in none, and new groups have none
selected), so streaming into a grouped grid counts nothing again, and the
model's own clicks and keys adjust the counts they change (a row: its group
and those above; a group: it, its groups below, and the change in those
above) instead of counting again. Headers' cells are written from their
level's table through the columns' formatters, the first naming the group
by its own key value and counting its rows.

A pivot's grid (`grid/pivot.ts`, `createPivotGridModel`, with the DOM grid
from `dom/grid-pivot.ts`, both in `herceg/grid/pivot`) is a grid model whose
groups are the pivot's, shown one level deep and never expanded: its rows
are the pivot's rows, followed by key and selecting their rows of the view
through the same counting as groups' headers. The model takes the pivot
through a small interface (`GridPivot`) so `herceg/grid` holds none of it:
the columns generated with their layout, a revision of them, the
crosstab's fields (the rows field and each generated id) for sorting, and
the table cells read rows from. The column list stays the one record of the
layout: when the pivot's values change, the columns are generated again
and laid out from it by id; a value's columns arriving go in column order,
or, once the user has moved columns, just before the next column in column
order (last when none is placed), and the first scrolling column in view
keeps its place on the screen. Layout of columns not generated (given by
`setColumns`, or of values that left) waits for them, the oldest forgotten
once they outnumber the generated columns twice over and 64; a column going
from an order the user chose (moved, or given) keeps the column it
followed, and goes back after it (or after the nearest one before it still
there). Generated
cells read the crosstab as it is when drawn. Sort keys name the crosstab's
fields (those of columns gone are dropped with them) and order the rows (absent and missing values last either way,
counts filled with zeros as zeros), leaving the view's order alone. The DOM
grid writes a group row's cells again when the row's `version` moves, which
for a pivot's row is its groups' revision, so values that change under rows
in view are written again. `createPivotGrid` gives the DOM grid
a header row of the pivot's values over their aggregates' headers while
any shown column has one (`HeaderRows`): each value spans a run of
adjacent shown columns under it held at the same edge, so values parted by
pinning or moving get a header each, and blanks hidden from assistive
technology hold the place of held columns without a value. Only the
headers over mounted columns are mounted, placed as cells are, with
logical `aria-colindex` and `aria-colspan`; rows count both header rows in
`aria-rowcount` and start at `aria-rowindex` 3, and the viewport is what
both header rows leave. Headers under a value carry their full title as
their accessible name. That row costs `herceg/grid` nothing; the hooks for
it, the pivot's columns, and its rows cost about 400 bytes gzip.

Selection commands write a `RowSet` into the store's channel. Toggles and
ranges change the set the model last put there when the channel still holds
it, nothing replaced it since (the store's revision), and the table was not
reset (a set from before a reset refuses changes); otherwise they start a
new set from the channel's rows, evaluating a condition there once. Ranges
are in the grid's order: the view's positions between two places, added in
one pass (`RowSet.addAll`), or as one range when the view shows every row. A
condition in the channel shows as selected rows, compiled once per change;
counting it scans the table, so it is counted after commands, not per
frame. Like views, models are held weakly by what they follow, so a model
no one keeps stops on its own; `dispose()` stops it at once.

The DOM grid (`dom/grid.ts`) is a scroll container (`role="grid"`) holding a
sticky header row and a spacer as tall as the rows, in which only the rows
in view, with ten more above and below, are mounted, each holding the cells
of the columns in view and two more on each side. A mounted row follows
its row's identity, and a cell its column's id: a row still shown keeps its
element, so rows moved by a rolling window or a sort move without rewriting
their text, a focused cell keeps its element when columns move, and text is
written only for rows newly shown, after an in-place change of the table
(`modifiedVersion`), or for new columns. Elements of rows that left are
reused for rows that entered and moved into place, so the DOM order is the
display order, which screen readers follow; nothing is pooled beyond the
rows and cells in view. Clicks and focus resolve the row and column an
element shows against the model as it is, since rows can move before the
next frame redraws them. With no column shown the grid has no rows (a row
needs cells), so it becomes a named group until columns return.

Rows and the header row are flex boxes. Cells of held columns are in their
flow, sticky (`position: sticky`, with their distance from the edge as the
offset; the first one pinned right takes the free space before it), so the
browser keeps them in place while it scrolls, with no frame of lag; the
other cells are placed absolutely and scroll under them, opaque and drawn
above with a rule at the boundary. So pinning duplicates nothing: each row
is one element holding its cells in the order they show, with logical
`aria-colindex` values, as one header row is, and screen readers read rows
as they look. A row mounts its held cells, those of the unpinned columns in
view, and two more on each side; with pinned columns taking room from the
viewport, that is about as many cells as without them (a 1200 by 600 pixel
grid of 100k rows by 20 columns mounts 588 cells in 42 rows with two
columns pinned left and one right, as it does with none). Placing a cell
writes only the styles that changed, so a resize restyles the cells of the
resized column and those after it.

What headers do to columns lives in `dom/grid-columns.ts`. A press on a
header that moves farther than 4 pixels drags, with the pointer captured
by the scroller (and released anywhere: the document hears the release
while a press lasts, and a lost capture or a move with no button down ends
it): on the header's edge it resizes the column, the width the pointer asks
for applied once a frame in the grid's scheduled frame (any number of
pointer moves make one model change, and one redraw); elsewhere
it moves the column, a line showing where it would drop among the mounted
headers of its side (the pointer kept within that side's part of the
viewport), committed on release. Escape puts the place back, or the width
as it was through `setColumns` (resizing would hold a pinned column to the
room it has now, which a grid narrowed meanwhile may lack), and the click
that ends a drag is swallowed, so a drag never sorts. Touches
on headers scroll the grid rather than move columns. The keys on a focused
header (Shift with arrows, Alt with arrows) and the column menu
(`dom/grid-menu.ts`, a WAI menu outside the grid's own roles, of items and
menu checkboxes with `aria-keyshortcuts` and disabled states, opened by Alt
and Down, Shift+F10, a right click, or the header's button) call the same
model commands, each checking again when chosen that it still applies. An
open menu is written again before a frame in which the columns or the
grid's width changed, and closes with its column, handing the focus to the
grid's focused cell; otherwise it gives the focus back to the header when it
closes, and the live region says what each change did. A header's button is not
displayed until the header is hovered or focused: laid out in every
header, its glyph made each horizontal scroll step about 0.08 ms slower in
style and layout.

Frames go through the shared scheduler, sizes come from a resize observer
on the container and the scroller, and grids out of the page's view wait.
A grid's container gets the grid's height, or 320 pixels when it has none.

Browsers lay out boxes up to about 33.5 million pixels (Chrome and WebKit
clamp element heights at 33,554,428) and Firefox about 17.9 million, but
Chrome stops drawing one-pixel lines past 2^24 pixels (measured: row borders
vanish at 16.8 million), and single precision keeps half pixels exact only
below 2^23. The spacer is therefore at most 8 million pixels tall; taller
rows scroll scaled, the logical offset being the scroller's times
(rows − viewport) / (spacer − viewport), with rows placed at their logical
offset less the difference. Each frame pairs the scroller's offset, as the
browser took it, with the model's top it stands for: a scroll event
reporting that offset is the grid's own scrolling (or a scroll along x) and
leaves the model's top alone, which anchoring may have moved since, so
targets of the keyboard and the last row are reached exactly; other offsets,
the user's, map by the ratio. A million 28-pixel rows scroll 3.5 times as
far per pixel.

Grouped grids follow the WAI tree grid pattern (`role="treegrid"`): rows
carry `aria-level` (a group's level from 1; table rows one past the last),
`aria-posinset`, and `aria-setsize` (their place among their siblings, or
among their group's rows, since most are not mounted), and headers
`aria-expanded`; a row's first cell is indented by its level (a custom
property on the row). Since `aria-selected` has no mixed value, a header's
first cell holds a checkbox (`role="checkbox"`, `aria-checked` true, false,
or mixed) beside a toggle drawn for the eye only; its rows keep
`aria-selected`. Focus stays on cells, so the keys adapt the pattern's: a
row's first cell stands for the row (where the pattern would focus rows),
so Right and Left there expand and collapse a group, and Left on a collapsed
group or a group's row goes to the group holding it, while elsewhere the
arrows move between cells, as in the pattern's cell focus; Enter on any cell
of a header toggles it (the pattern's cell focus takes Enter on the first
cell only), and the live region says what expanding and collapsing did.

Keyboard focus follows the WAI grid pattern: one tab stop, held by the
focused cell when it is mounted and by the grid otherwise (Tab into the grid
then reveals and focuses the focused cell). Keys move the model's focus,
which scrolls the target into view, and the grid draws at once and focuses
the cell. While the page's focus is inside the grid, the focused cell is
never recycled: its row (and column) stay mounted outside the window when
scrolled away, clipped by the spacer (`overflow: clip`, so they do not
extend the scroll range), and other elements move around it, since moving a
focused element drops its focus. Rows carry `aria-rowindex` and
`aria-selected`, cells `aria-colindex`, the grid `aria-rowcount` and
`aria-colcount`, and the first sort key's header `aria-sort`; a hidden
description gives the keys, and a polite live region outside the grid says
what sorting, selecting, and changing columns did. Theme tokens become
custom properties on the grid's root, read by one stylesheet each grid
carries (so grids in shadow roots are styled); forced-colors mode uses
system colors. `destroy()` unschedules the grid, puts back what a drag
under way changed, closes a column's menu, and removes its listeners,
observers, and elements.

### Remote grids

A remote grid (`herceg/grid/remote`) shows rows a grid source holds
elsewhere. Its model (`grid/remote.ts`, `RemoteGridModel`) and the local one
are subclasses of one base (`grid/base.ts`, `BaseGridModel`) that holds what
does not depend on where rows are: the column list and its placement,
viewport and scroll offsets with the row kept at the top, the focused cell
and the range anchor (by ref), and listeners. Each model provides its rows
through a few synchronous methods (catching up, a row's ref, finding a ref
again, a row's text, and the selection and expansion commands); nothing
asynchronous reaches the base or the DOM grid. A row's `ref` (a scope and an
id) names it while it is shown, and the DOM grid keeps elements by it and
writes a row's text again when its `version` changes, whichever model it
draws. Loading and failure states reach the DOM grid through a small hook
(`GridExtras`, also how a pivot's header row does) from
`dom/grid-remote.ts`, so `herceg/grid` holds no remote code; the shared base,
the hooks, and making listener-interrupted commands safe (a batched
`moveFocus`, clicks and announcements that find their row again) cost it
about 400 bytes gzip.

The query (`grid/query.ts`) is plain JSON with a version, checked against
the source's schema with unknown properties refused. It reuses `Expression`,
the groups' aggregate operations, field kinds, and the sort order of
`data/order.ts`, with ties going by the source's key so that pages of one
snapshot fit together; a query's grouping has the same level-by-level
semantics as `groupRows` (aggregates over each group's rows, never its
groups' values) and the group sort of a local grid, with ties by a group's
own value. It is kept apart from the chart spec's `GridSpec`, which lays out
panels. Times are epoch milliseconds; queries have no bins, since a fixed
step cannot be a local calendar day.

The source protocol (`grid/source.ts`) is a request for `limit` rows (or a
level's groups) from `offset` under a parent's key path (`[]` at the top),
naming the fields wanted, the query's revision, the schema version, and the
snapshot, null for the query's first request (each starting a snapshot of
its own, released once when the grid stops reading it, even unread). Answers are windows of typed
columns with the parent's total, or null until the last window; group
windows add each group's row and child counts; a window past the end has no
rows and the parent's total. The model checks every answer against its
request (address, lengths, kinds, codes within the window's dictionary, a
total on a short window, a total that never changes within a snapshot,
group counts of at least one, keys that are strings or safe integers, no
key or group twice) and keeps only the fields it asked for, and takes an
answer only if its revision is current, the block is the one asked for, and
its list is still shown; anything else is dropped (a snapshot a dropped
first answer started is released), and requests no longer needed are
aborted (abort is advice: a late answer is dropped anyway). Key paths cross JSON with
infinities spelled out (`encodeGroupPath`), since a group's key may be one.

The model holds the answer as a tree of sibling lists: the query's rows, or
the first level's groups, and under each expanded group the list of its
groups or rows. A list has its total (or how far it has been read and a
block more, while the source has not said), the blocks loaded of it (128
rows, aligned), and the lists of its expanded groups by their place, with
each child's row index and prefix sums of the rows the children show. A row
index finds its list and place by a binary search per level, and a list's
place finds its row index by climbing; an unloaded run of groups is one
range, with nothing per row or group kept. Expansion is a set of group ids
(key paths, kept across queries grouped by the same fields): a group whose
block arrives expanded gets its list, with the child count its window gave.
Refs are a list and a place, so the focus, the row kept at the top, and a
range's anchor follow rows through expansion and blocks loading above them,
and resolve to a collapsed group's header.

Requests are planned once whatever changed has settled (a microtask): the
blocks in view first, then the focused row's, then a block ahead in the
direction of scrolling (rows behind were just shown; below, after a jump),
two at a time.
Requests beyond two
blocks from the view are aborted at once, so scrolling back and forth over
a boundary reuses them. A jump (rows in view more than two blocks from those
last wanted, the focus unmoved) waits 50 ms for the scrolling to settle,
and asks at least every 150 ms while it goes on, so a dragged scrollbar
does not ask for every block it passes; focus moves (the keyboard) never
wait. The first request of a revision goes alone: the snapshot its answer
names is asked for by the rest. The cache keeps the blocks the view wants
(and those of the rows the DOM grid mounts around it) and 16 more (and
8 MiB), dropping those farthest from the view first, least recently used
among equals, failed blocks too. It never drops a block the grid has
mounted, but groups count the records loaded, so a planning pass that drops
any notifies once, at its end. Every notification is the last step of its
command (`moveFocus` batches its steps), and the model calls into the
source (`rows`, `locate`, `release`, and aborting a request's signal) only
in a microtask after the command, so neither listeners nor the source's
code ever find a command half done, and either may run any command. Windows that view a much larger buffer are
copied when they arrive, so a source handing out views of its arrays cannot
make the cache hold them.

A new query (or `refresh`) is a new revision: its requests start a new
snapshot, the old one is released, the scroll offset stays (the root list
shows as many rows as the last until the first answer, or none when the
grouping fields changed), and the focus goes to its column's header; with a
source that locates records, it goes back to its record's new place once
located (with the ancestors' places, attaching the lists of expanded ones,
and only to places the lists have), unless the user moved it meanwhile; a
locate under way is aborted by the next query. Selections
live in a `RemoteSelectionStore` (`grid/remote-selection.ts`), never as
positions: keys, or a condition with keys added and taken out, which a
server can run as a filter (`selectionCondition`). Selecting all matching
captures the query's filter; a group's header selects the rows matching the
group's key path (`groupCondition`), and the model remembers that scope (with
the filter and grouping fields it was made under, set before the store tells
listeners, and following the selection only through the model's own
toggles) to show the group selected. Otherwise a group's state is counted
from the records loaded within it now (cached per selection and change of
the blocks), so it follows the current snapshot and selections made
elsewhere, and claims "all" only when every record is loaded and selected. Rows read the fields a selection's
condition needs, so a condition over a field no column shows still shows;
within a query the fields read only grow, so selections coming and going
read no rows again. Shift ranges
need every row between loaded and within one list, and are refused with a
message the DOM grid announces otherwise.

The DOM grid's remote hook marks placeholders `aria-busy` (and the grid
while its query's first rows load), writes `aria-rowcount="-1"` while a
list's total is unknown, shows a notice under the rows (the scroller made shorter, so it covers
none) with a retry button when blocks fail (none for a query the source
refuses, which trying again cannot change), gives the focus back to the grid
after retrying, and announces each new failure and each refusal once. Rows
an expired snapshot will not load show as failed, not loading. The reference
source (`grid/memory.ts`, `herceg/grid/memory`) runs a query with the local
grid's row views and groups, a snapshot being a view (and its groups) of the
table, expired when the table changes; it copies windows out with
dictionaries of their own labels. The conformance fixtures
(`grid/conformance.ts`, `herceg/grid/conformance`) are worked out by hand
from these semantics and checked against it.

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
never overlap. Bands and stacks on log y axes are drawn straight, a stack's
edges at zero at the axis' low end (the plot's top on a reversed axis),
where it stands. Missing values split a line into runs
that are reduced separately, so data that alternates between values and gaps
can still produce one run per few points.

On a time axis with breaks, columns are columns of time shown and points
inside breaks are left out without ending a run (see Time axis breaks).

The reduction scans the visible index range (found by binary search) on every
frame: O(visible points), about 0.8 ms for one million points
(`npm run bench:core`). On linear scales a whole column of the table is
scanned pixel column by pixel column: x is compared with a threshold just
left of the column's right edge rather than mapped. The threshold is checked
with the exact column formula, and points at or past it get the exact test;
because the floating-point mapping never decreases, the result is identical
to mapping every point. Gaps end a column in the same pass. Long-format
series whose rows follow their table (see the data model) are scanned the
same way through their rows, by a loop of their own (`lod/m4-rows.ts`,
loaded with the grouping): looking up rows in the loop that scans whole
columns would slow it by half. Log scales and other row subsets (facet
panels, and the scene before the grouping loads) use a per-point loop.
Unsorted x is drawn point by point without reduction.

The y domain comes from the same visible range: sorted series are trimmed to
the points inside it, so whole columns reduce to a plain min/max scan.

Lines, and areas filled to zero, over whole columns of at least 4,096
points use a min/max index of their y field (five columns of 200,000 points
zoom in about 1.2 ms instead of 2.2 ms with them). The table owns the index and keeps it
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
rebuild its index and take up to about 5 ms instead of 4 ms. Bands are not
indexed; long stacks have indexes of their own (see the data model), and
long-format series their group's (below).

Long-format lines, and areas filled to zero, of at least 4,096 rows a
series use a min/max index of their group: one per group and y field
(`RowsIndex` in `lod/rows-index.ts`), owned by the grouping and so shared
by every chart drawing the mark. It has the table index's blocks, over
positions in the group's rows, reading values through them (`y[rows[k]]`),
so no value is copied; queries take and give positions, as M4 and extents
use them. Blocks are numbered from the group's first row ever (the rows it
has dropped plus the position), so a rolling window's drops discard the
blocks they empty and summarize again the one they cut, instead of moving
every block, and extremes are kept as offsets in their block, so nothing is
rewritten as positions move down. A chart's request brings the index up to
date: appended rows cost their own blocks, a drop a block per level and a
shift of the remaining summaries. A change to values in place, or a reset,
groups the rows again, and the indexes go with the old groups, so a chart
builds one only when nothing changed values in place since its previous
draw. Groups take a lower threshold than columns: without an index, extents
read every row in view through the rows (about 2.5 ns a row), while the
index takes about 0.16 bytes a row (160 KB for a million rows; storage
grows by doubling and shrinks only when four times larger than needed, so
up to twice that as a series grows, as in a window that has turned over,
and about four times after its rows shrink), beside the 4 to 6 bytes of the
rows themselves. Dense pixel columns are reduced through the
index as whole columns are. Over five series of 200,000 rows each (800 by
400 pixels at 2x, Node, medians of interleaved runs), a zoom step showing
every row takes about 1.3 ms instead of 6.0 ms, for lines and for areas
(the same data as five columns, below the column threshold, takes 2.1 ms), and
streaming 10,000 rows per tick into the million-row window takes a median
of about 2.1 ms instead of 5.8 ms (p95 2.3 instead of 6.6 ms; five
columns: 1.8 ms), as does a row per series per tick; what remains is mostly
the reduction through rows and the drops' move of every kept row. A skewed
split (600,000, 250,000, 100,000, 40,000, and 10,000 rows) zooms in about
1.2 ms instead of 6.2 ms. The scene that first builds the indexes takes
about 4.9 ms. Facet panels' rows are subsets of their series' and keep
scanning.

Histograms keep their bins, not their values: whenever the table changes,
one pass finds the extremes and another counts each series' values (by
division for evenly spaced edges, binary search for calendar ones; each
value counting as its row's `weight`, when there is one), and at
most a thousand bars are drawn, whatever the data size. Measures follow
from the counts: frequencies divide by bin widths, shares by the series'
total, and `stack: "fill"` divides each bin's stacked measures by the bin's
total over the series shown. `element: "step"` and `"poly"` draw each series
as one area (its top stepping across the bins, or through their centers,
down to the series below), built from the bins' pixels rather than through
level of detail, since there are so few. Series split by a
category field also keep their row indexes (4 bytes per row), as long-format
series do. Streaming recounts every value on each change. Split by facets, a
histogram counts each panel's rows in one pass, by each row's series code
(see Small multiples), and keeps no rows by series.

Candlesticks (and OHLC bars, their `variant`) merge rather than sample: with more candles in view than the
plot has pixel columns, each column draws one candle with the open of its
earliest candle, the close of its latest, and its highest high and lowest low,
so no price extreme is lost. The merge works in any row order, and the
geometry buffers hold at most one candle per column.

## Band axes

A mark reports the kind of field on each position channel. A categorical
field (bar x or y, heatmap x and y, point x or y) puts the axis on a band scale whose values are
category indices; the category labels are the union of what the marks on that
axis contribute, in order of appearance (panels that resolve the axis apart
hold only some of them; see Small multiples). Bands are identified by raw value
(a category, or a number's full-precision key), so values whose formatted
labels coincide stay separate. Each row's band index is computed
once per table version (4 bytes per row) and reused while the band list is
unchanged. Heatmaps band number and time fields only when asked to
(`xBanded`, `yBanded`), one band per distinct value; otherwise their cells
lie along number and time axes (see Heatmap cells). Band labels are thinned to every k-th band when neighbors would
overlap. A categorical axis cannot be shared with marks placing numbers
along it; the chart rejects that combination.

Lines and areas over a category axis place each row at its band's center,
as bars do, and draw a series' rows in band order: rows already ascending
through the bands keep their own order, and others are sorted by band
(rows of one band in theirs) into a permutation of 4 bytes per row, kept
while the band indices and the series' rows are the same (the band list,
and so the indices, change only with the data or the axis' categories).
Rows without a category leave the series, so the series is sorted along
its positions and binary search, level of detail, and min/max indexes
serve it as they serve lines over numbers; band indices map to pixels
linearly. Areas stacked by a series field stack on the union of band
positions, from each layer's rows with a band in table order (the union
stack's streaming needs them ascending), and are read in band order after.
In panels with categories of their own, positions are mapped through the
panel's places (which keep the chart's order) into a buffer for tracing.
Panel places and time breaks carry the synchronous point-view copying path
(`lod/point-view.ts`), so ordinary numeric traces retain their source
columns and do not bundle that copying code. Tracing frames expose only
the position scale's type, domain, mapping, and breaks; a dodged trace
shifts its mapping without wrapping the scale's inspection or tick methods.
Lines and areas take only categories as bands (`categoryBands`,
`categoryIndices`), so their code carries none of the labels of banded
numbers and times.

Points, error bars, lines, and areas can spread their series across each
band (`dodge`, with the arithmetic of grouped bars: the band split among
the visible series in order) and points across their share of it
(`jitter`, a hash of the row's identity, `rowOffset + row`, and a seed, so
placement survives redraws and drops). A dodged line or area is traced on
a frame whose position scale is moved by its slot's offset, so level of
detail buckets the pixels it draws, and highlighted runs are clipped where
it is drawn. The offset is in pixels, applied where the mark places
a row; series keep their band indices, so inspection along the axis still
reports every series of the band. The mark records each series' slot (its
place and the number of places, not pixels, since a repeated mark draws in
panels of different sizes) as it draws (`BandShares`), and picking and
inspection (`displace`, with `maxDisplacement` bounding how far that moves a row
along x for the nearest-point search's pruning) read the same slots, so the
pointer, tooltips, and the keyboard find points where they are drawn.
Marks of a legend group take their slots from the group's roster, its
visible names across the chart (`Frame.groups`), rather than from their own
series: grouped bars, box plots, violins, dodged histograms, points, error
bars, lines, and areas of one group then stand alike even when one lacks a
name.

Points can instead pack across their band, or their slot, as a beeswarm
(`swarm`, marks/swarm.ts). The rows of a mark's series are kept in order of
band, then value (rebuilt only when their positions, rows, or values
change), and each panel's scene lays them out again, since the layout is in
pixels: each band's (and with `dodge`, each slot's) points in view (not
those a time axis' break hides), ascending
by value, each at the free offset nearest the center given the points
placed before it. The placed points within reach along the value axis (a
window that slides with the values) each block an open span of offsets;
both ends of the spans are sorted natively and swept, and the run of spans
covering the center gives the two nearest free places, the nearer one
taken (ties alternate sides, so swarms grow evenly). A point with no free
place inside the band stands at its nearer edge and does not join the
window, which therefore holds no more points than fit in the band beside
it, and a window past 512 points sends a point to the edge too: a band of
n points takes O(n k log k) for k at most 512, and in practice the k that
fit. Offsets are kept per panel (by its plot) with the inputs that made
them (scales, slots, visibility), so inspection, picking, and highlighted
parts read the layout geometry made: by row where the panel draws every
row, otherwise in the order of the panel's rows (found by binary search),
so facets hold as many offsets as rows between them. 10,000 points in one band lay out in
about 2.2 ms and 100,000 in about 21 ms; a scene of 10,000 points over four
bands in about 7 ms (Node, Apple M6, mostly overflowing swarms of normal
values). `herceg.express`'s `swarmplot` runs a port of the same layout in
Python to warn, as Seaborn does, when a category's points do not fit,
cross-checked against a fixture of this one's output.
Grouped bars, box plots, and violins record and report their slots the
same way, so tooltips and the keyboard stand on the bar or shape a series
draws rather than on its band's center.

## Lines and areas along y

A line or area with `orient: "y"` (or a category y with values on x) holds
the chart's x and y in its series, as every reader of series expects: x its
values (`values` is x), y its positions. `sorted` still means x ascends, so
it is false, and `ySorted` says whether y does (worked out again for each
facet panel's rows, as `sorted` is). The mark traces it with the
code that traces along x, on a view of its series with positions as x and a
frame with the scales and plot transposed, then swaps each traced
polyline's coordinates (and curve controls) back: level of detail reduces
it by pixel rows, monotone curves are monotone in y, and "step-after" holds
a value up to the next position, as an ECDF of y needs. On a time x axis
with breaks, the rows whose values a break hides are left out of the
traced copy, and the line joins across them, as lines along x join across
hidden positions; stacks and bands keep them, at the break's seam, so
neighboring layers still share their edges. An area along y
closes at x = 0 (or its stack's base, or a band's `x1`) through a lower
edge of its own, since the scene's baseline is horizontal. Layers of a
stack by a series field hold their edges in the series as layers along x
do, `edges.x` their positions along the orient (y here), so highlights and
the inspector, which pair a stack's layers by occurrence at a position,
read them along y. Its `tooltip` is "y": the chart defaults to
"nearest-y", which scans each series (horizontal bars and histograms are
few, and so far no index serves y), and the keyboard steps through each
series' rows in order. Such marks use the left y axis, as horizontal bars
do, and span their positions along y whatever x shows, as marks along x
span their positions whatever y shows; zooming along y does not rescale
x. They show new values at once instead of animating them, since value
transitions move points along y.

## Heatmap cells

A heatmap's axis over a number or time field (unless banded) holds cells
(`marks/heatmap-cells.ts`): one per distinct finite value, found once per
table version through a Map, as band axes find theirs, and ordered. Without
a step, a boundary lies halfway between neighboring values, computed once
and shared by the two cells so no value falls between them, and the ends
reach as far out as in; with `xStep` / `yStep`, a cell reaches half a step
from its value, or to the halfway point where a neighbor is closer, leaving
gaps where values are further apart. A lone value without a step spans the
room `usableDomain` gives it, so a streaming chart's first row draws; a step
too small to tell a cell's edges apart at its values is refused, and edges
are clamped to the finite doubles. Edges depend on the data (and on the x
axis' breaks, below), never on the domain, so cells keep their edges as the
view moves. Values within a millionth of a cell of a lattice (evenly spaced,
or one step apart with whole steps between) are slots of that lattice, which
the image draws per slot (see Points and rasters); empty slots take no
memory. Series hold the rows' values in `x` and `y`, so inspection,
formatting, overlays, brushes, and events read data values; the mark keeps
each row's cell (4 bytes per row and axis) for the cell index, painting, and
the keyboard.

Extents are the edges of the first and last cells the rows hold (a facet
panel's own, cached by its rows). The y extent of what an x range shows
covers the y cells of the columns the range overlaps, read from each x
cell's lowest and highest y cell (two Int32 per x cell, built once per rows),
so automatic y domains follow x as they do for points without scanning rows
each frame. Heatmaps are `tight` marks: automatic y domains with one on the
axis end at its cells' edges rather than at round values, unless the axis
asks for `nice`. Log axes are refused for now. On a time x axis with breaks,
values inside breaks have no cell, and the others are placed in the time
shown (`Breaks.collapse`), so the cells either side of a break meet at its
seam, and cells evenly spaced in time shown stay a lattice. A mark keeps its
placements for the few break contexts it is drawn in (charts sharing it may
leave out different time), and summaries read the cells each series was
drawn on.

Calendars (a `date` field; `marks/heatmap-calendar.ts`) place a time field's
days in the chart's zone, converting each distinct instant to its
wall-clock day once (`toWall`). By weeks, x cells run from each week's start
to the next week's (`fromWall` of wall-clock midnights, so a week across a
clock change is an hour short or long, and the weeks are a lattice only when
each is seven days long, as in UTC), and y has seven weekday bands in order
from `weekStart`; by months, y has a band for every month from the first
day's to the last's and x one per day of the month. Calendar bands carry keys
of their own (`weekday:mon`, `month:24288`, `day:1`), and are remapped like
any band list when other marks share the axis; labels name Gregorian days
and months, whatever calendar the locale prefers. By weeks, series place each
row at the instant its day starts, so a day's rows share a place, and the
weeks each series is drawn on are found by those days: a mark charts in
several zones share keeps a placement per zone and locale. No field holds a
row's weekday or month, so brushes select a calendar's rows by their
cells' centers, as a row set, as they select a stack's; lassos find any
heatmap's cells at their centers too, which a cell's value need not be.

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

## Time axis breaks

A time x axis can leave out time: `breaks` rules name days of the week,
daily spans of wall-clock time, calendar dates, or spans of instants
(`scale/breaks.ts`). The rules are portable JSON; in TypeScript,
`timeBreaks(rules)` returns a `TimeBreaks` that carries the code resolving
them, as `facet()` and `panels()` carry theirs, so the model and level of
detail reach breaks only through an interface (`Breaks` in `lod/m4.ts`) and
a chart without breaks bundles a few hooks, not the breaks. It serializes
as its rules (`toJSON`), which is what adapters compare and specs store.

**Resolution.** A `Calendar` (one per `TimeBreaks` and time zone) resolves
the rules over a span of time into sorted, disjoint, merged intervals
[from, to), stored as `Float64Array`s with the break time before each (24
bytes per interval: about 60 KB for ten years of nights and weekends).
Wall-clock rules follow the zone by membership: an instant is in an
`hours` span when its clock time is, so across a change of offset a span
is up to two intervals (a span inside a repeated hour is left out twice,
and skipped clock times take no time), and a date is a calendar day of 23
or 25 hours where clocks change. Offsets come from sampling the zone every
four days and a binary search of quarter hours where samples differ, so
resolving ten years asks the zone about a thousand times rather than for
every interval (about 0.7 ms). The span resolved grows when a value outside
it is asked about, by at least 28 days or half its length, so streaming
data and zooming out resolve rarely; growth is exact, never extrapolated,
and refused past 250,000 intervals.

**Positions.** A value's position is the value less the break time between
the first span resolved and it; every value inside a break is at its seam.
Positions are measured from a fixed start, so growing the span never moves
one: scales built before keep their meaning, and arrays are replaced, never
changed. Bounds are whole milliseconds, so positions of whole-millisecond
times are exact. The inverse at a seam is the end of the break, the first
value shown after it, which is what a pointer on a seam reads.

**Seam markers.** `x.seams: true` or `{ minSpacing?: number }` opts into
one-CSS-pixel dashed vertical lines behind data inside the plot.
`Calendar.seams` in `scale/breaks.ts` uses the final panel scale and
`within` to map merged intervals' ends onto pixel centers (which every
renderer draws as placed), excludes plot edges, and keeps seams
greedily in chronological order at least `minSpacing` CSS pixels apart (finite and
positive, default 40), normalizing reversed domains and using absolute pixel
distances. The work is O(log B + visible breaks), with output bounded by plot
width and spacing. The model prepends ordinary `SegmentGeometry` to each
panel's marks, so data draws over seams. The geometry carries the resolved
grid color and a `[3, 3]` dash. `draw/seams.ts`, imported only by the break
code, draws the SVG path and Canvas segments, and provides retained SVG
elements; PDF uses its existing segments case with dash support. Charts
without breaks bundle no seam planning or drawing code. SVG paths are
aria-hidden, unfocusable, and pointer-transparent. The chart description explains omitted
time even when markers are thinned. The navigator keeps its compressed scale
and ticks but omits seam markers.

**Scale.** `BrokenTimeScale` keeps its domain in epoch milliseconds and maps
linearly over positions: its `mapping()` is the linear coefficients over
positions plus the calendar, so code that inlines mappings applies
`collapse` where it reads raw values. Ticks are calendar ticks of an
interval chosen from the time shown; a tick inside a break moves to its
end, labeled by the coarsest calendar field that changes across the break
(`tickContexts`, which `timeTickLabels` reads), and regular ticks closer
than half a label's room to a moved one give way. Breaks of eight
intervals or longer are checked for a tick by flooring their end rather
than walked, so a closure of years costs one check. When many short
sessions keep moving ticks, coarser intervals are tried.

**Data inside breaks** is not drawn and does not count: `hides` filters
points, bars, candles, and error bars; y extents and level of detail work
over the *shown ranges* of sorted rows (`shown`: a galloping search per
break, and breaks holding no rows leave one range); inspection jumps hidden
runs by binary search (`shownFrom`, `shownBefore`) and measures distances on
screen. Lines join the points either side.

**Level of detail** stays in data space: the min/max index of y is the same
index (a long-format series' is its group's, read through its rows), queried
over shown ranges. M4 over breaks (`lod/m4-breaks.ts`) takes
a pixel column as the floor of `xo + (collapse(x) - origin) * xf`, the same
arithmetic on every path, and keeps a column open across shown ranges, so a
column with a break inside it still emits at most four points. Columns of
linear data are scanned with a threshold (the column's edge taken back to a
value and checked with the exact formula) or, for dense data with an index,
ended by a binary search of x for the edge, corrected with the exact
formula, and an index query. Over a million minute bars of ten years of New
York sessions, a whole-series reduction takes about 1.6 ms (0.9 ms
without breaks) and 0.8 ms with the index (0.5 ms) in Node
(`npm run bench:core`).

**Domains.** Room at the ends of an automatic domain (half a bar or candle
slot, glyph insets, headroom) is applied in positions, since padding in
time would vanish inside a break before the first session; slots measure
the smallest gap between shown positions. Nice domains choose their
interval from the time shown. A view entirely inside a break widens to the
hour shown either side of its seam; a configured domain like that is
refused. Animated view changes interpolate positions.

## Range navigator

A chart's `navigator` (`rangeNavigator(options)`, a `Navigator`; in specs,
`true` or `{ height?, marks? }`) adds a strip under the
plot, or under all the panels of facets and subplots, with one window over
the x range they share (`model/navigator.ts`). The native option is a prepared object, as
breaks, facets, and panels are, so the model reaches the strip only through
it: a line chart without one bundles a few hooks (room under the axis, the
strip's panel, the check, and mounting the sliders), about 110 bytes gzip.
`renderToSVG`, `toSVG`, and PDF export stay synchronous because the strip's
drawing is the model's, and only the browser's sliders load on demand.
`Navigator.describe` writes the text alternative's sentence from the last
drawn window, using its first panel's x tooltip formatter, and says that
the navigator controls every panel's x when there are several. The DOM
description's refresh key includes this sentence, so viewport and layout
changes refresh the summary at most once a second, outside the live
regions. The wording stays in the optional navigator module.

**Layout.** The model takes the strip's room (its height plus 12 pixels)
from the height the rows of plots share, after the title, legends, panel
headers, the gaps between rows, the x labels, and the x title, before it
lays out the plots, so the x axis and its title move up. The strip is at
most a third of what the plots and the strip share, shorter where the
plots would keep less than 30 pixels or less than the least the grid's
rows need (`PanelGrid.least`: 20 pixels for each row of several panels, by
their weights, which `trackSizes` would otherwise refuse), and none when
even 16 pixels would not leave them that, so a strip never makes rows too
short. Columns can still come out too narrow: shorter rows plan fewer y
ticks, whose labels may be wider, so a grid whose columns are within a few
pixels of 20 is refused with the strip, as it is without one when its data
widens its labels. The strip spans the plots: from the left edge
of the leftmost to the right edge of the rightmost, across the gaps
between columns and an incomplete last row's empty cells, short of right
axes and a grid's row headers. The model appends the strip's panel to the
scene after its views: the scene's renderers (SVG, Canvas, PDF, and so
PNG) draw it like any panel, while inspection, the keyboard, viewports,
`getPanels`, and sync never see it. Its scene key is `"navigator"`, with
`~` added until no panel has that key (a facet value or subplot of that
name), as the live SVG renderer keeps each panel's nodes by key. The
navigator's check runs after the layout's own: it refuses layout marks,
category x axes, marks placed along y, and with facets or panels a
`resolve.x` other than `"shared"`, also while every panel's data shares
one x scale, as one window shows one x range.

**Overview.** The strip's x axis (the rail) is the unzoomed x domain of
every panel's marks, planned by the model's own x planning (rounding, room
for glyphs, and breaks as the unzoomed plots have them) over the narrowest
plot, as the model plans a shared x scale over its narrowest column; a
strip wider than that (under columns of panels) keeps that domain with
ticks planned for its own width, since rounding or padding it again for the
wider strip could leave a reset window short of the rail. The rail widens
to hold a view reaching past the data, such as a synced chart's or a wheel
zoom's. The strip draws the marks it names, or every one it can, in the
chart's order of marks and then of panels: each panel's series (a facet's
parts of them) apart, so parts of one series never join across panels,
each with the y scale of its panel's y group on its side (as
`DrawnPanel.yGroup` and `yRightGroup` name them: one for panels sharing y,
each panel's own otherwise). A group's scale is the extent of the group's
drawn marks over the whole rail, or its axis' `domain` (its panels agree on
the settings), from zero for bars and areas. A mark drawn whole in several
panels of one group (a facet's repeated mark, a subplot mark in `"*"`) is
drawn once; facets' stacks stay each panel's own. Lines, areas, and
candlesticks draw themselves through their `geometry`, and bars through
`model/navigator-bars.ts`, with a frame of the
rail, the strip, and buffers of the strip's own, by stage, panel index,
and series key (so neither the plots' buffers nor another panel's part are
ever overwritten), their geometry keys given the panel index too, as parts
of one series in several panels would share keys in the one strip: lines
and areas are M4-reduced at the strip's pixel
width, through the same min/max indexes as the plot (the same chart and
scene count a draw once). Bars below two nonempty rectangles intersecting
the strip per CSS column on average use their exact geometry, including
widths, dodge, stacks, and labels. Dense bars cover every CSS column their
placed rectangles intersect, including clipped edges and wide bars. Each
occupied column draws a rectangle per side of zero, reaching the most
extreme bar tip. Each side keeps that bar's series color and fill opacity
(also for rows colored through the series field), with ties resolved by series order,
then row order. Grouped bars keep their placed horizontal coverage; colors
of shorter bars sharing a column disappear, and subpixel gaps are filled.
Stacks select the position with the most extreme cumulative tip on each side, then draw its actual
segments with their colors and bases; they never sum separate rows' maxima.
Each layer emits at most two rectangles per column, merging repeated-position
segments of that layer. Stack proportions represent the selected positions,
which may differ for positive and negative sides. Dense labels are omitted.
A log y axis uses the same low-end baseline as full bars; reversed axes and
x breaks use the same mappings. The winner buffer holds four doubles per
side and column; output buffers hold four floats per emitted rectangle, with
capacity to grow. Stack interval scratch is shared across layers. Density
and geometry share one source scan, keeping at most twice the strip's
column count in exact candidate rectangles across all series. Missing,
zero-area, and wholly clipped rectangles do not count. Sparse candidates
are emitted directly; labels and corner metadata, when needed, are built
over only those retained rows. Dense stacks make a second source scan to
recover selected segments. Dragging reuses the geometry, so drawing
and retained overview buffers depend on strip width and stack layers rather
than input rows. Candlesticks retain their exact geometry. Unsorted lines are
drawn whole, as the plot
draws them. Points are sampled: the first point in each CSS pixel of the
strip, drawn as small squares by a drawing of the strip's own (the point
drawing's symbols would add 5 KiB to charts of lines), so a series holds at
most as many as the strip has pixels, though finding them reads every
point. The overview is kept per chart and drawn again only when the rail,
the strip, the pixel ratio, the panels (their keys, y groups, and y types),
the hidden series, the options, the theme, text measurement, or the
versions of the tables and row views its marks read change: moving the
window rebuilds the plots' scene but reuses the overview, while each
streamed change rebuilds it (the rail's pixel columns move as the domain
grows), and buffers of panels gone are let go. The window is drawn every scene
from the plot's x domain as drawn, so a playing animation moves it too:
the parts outside it faded, an outline, and a grip at each edge (one shapes
geometry), and the rail's ticks are the strip's grid lines with their
labels inside the strip (text, with a halo), every second or third tick
where labels would crowd; a strip too short for its text has no labels.

**Sliders.** `dom/navigator.ts`, which imports no code so that nothing
moves out of a chart's bundle into a shared chunk, puts an HTML group of
three sliders over the strip: the window's left edge, the window, and its
right edge (named start and end by the values they hold, so swapped on a
reversed axis), with hit areas side by side: each edge's reaches 10
pixels outside the window and up to 4 inside, leaving at least 6 in the
middle to the window, so a narrow window still pans. A press focuses the
slider it lands on (the window's, elsewhere in the strip), so that Escape
reaches the drag, and a strip that goes (the chart grows too short for it)
ends a drag held over it. Under several panels, the group's description
says the window moves the x range of all of them. The chart mounts
them through the navigator's `mount`, which keeps one set per chart across
updates (so focus stays), and they follow the chart through its handle:
they redraw on `render` events, read the strip the model last drew, format
values with `formatValue` as the x axis of the strip's first panel writes
them, and change the view with `setViewport` followed
by `render()`, which ends any transition that `animation` started, so
drags follow the pointer and are reported and synced as any `setViewport`.
A drag keeps the rail it started on, so data arriving meanwhile does not
move the window under the pointer, and ends if anything else changed the
view since its last move or a viewport listener moved it; a strip that
moved or resized (margins that grew for wider labels, which panning
several panels' axes makes common, or a resized chart) takes it on from
where the window is, a selection from the value it started at. One
pointer drags at a time, a second finger doing nothing.
Window and edge drags are pixel shifts through the rail, so log axes keep
their ratios and axes with breaks the time shown, and an edge that does
not move keeps its value exactly (a break collapses many values into one
pixel); the window stays at least three pixels wide. The strip's presses,
`wheel`, and `dblclick` events stay out of the chart's own (a double click
resets x only), and a press or key aborts when the strip goes, or a `render`
listener moves the view, as it draws first; a drag also ends when the rail
changes type, breaks, or direction, though not when data widens it. Keys draw what is pending first (ending a transition), then move the
focused slider's value by a hundredth (Page Up, Page Down: a tenth) of the
strip; Escape cancels a drag or shows all of x, and is left alone when
neither applies. Edges, drags, and keys work on the window's start and end
by value, in pixels measured toward larger values, so reversed axes behave
alike and an edge never passes the other; Home and End go exactly to the
bounds the sliders state. Values are numbers (epoch ms on time axes), with
value texts as tooltips write them; the window's value is its start. The sliders'
own polite live region says where the window is after a drag, a reset, or
400 ms after the last key.

**Cost.** In Chrome on the benchmark machine (one-off runs with other work
on the machine, interleaved, p50 of 110 frames), dragging the window over a
1,000,000-point line takes about 2.6 to 2.9 ms of JavaScript a move, as
much as panning the plot with `setViewport` and `render()` without a
navigator (2.3 to 2.9 ms). Streaming 100 points a frame into a rolling
window of 100,000, a frame takes about 2.8 ms either way unzoomed and 2.3
to 2.4 ms instead of 1.5 to 1.6 ms zoomed, the overview drawn again each
time. The
overview of a 100,000-point line holds about 35 KiB (Node); in Chrome, ten
such charts take about 0.9 MiB more with a navigator than without (canvas
rendering), about half of it with an empty strip (`marks: []`), the sliders
and the strip's drawing.

Bar overview measurements (one-off, before and after the reduction, baseline
`f4eb551`; headless Chrome 154.0.8037.99, Darwin 27.0.0, Apple M6,
Canvas, DPR 1, 1000×600 charts in a 1100×700 viewport, production bundles).
The four subplots share 100,000 rows: two price lines, volume bars, an area,
and a line, with independent y scales and one shared numeric x scale. The
single bar chart has 1,000,000 rows. Both show a 1% x window during dragging.
Each of three alternating before/after rounds uses a fresh chart, 30 warmup
moves then 110 measured moves through the navigator's pointer handler, and
10 warmup table changes then 35 measured overview rebuilds. Timings are
synchronous JavaScript (not compositor or presented-frame latency), measured
with the isolated page's 5 µs timer. Rebuild timings cover only construction
of the overview after a changed volume value, excluding plots and drawing.
Buffers are retained overview pool capacity, including growth room and
scratch, not total chart heap or Canvas backing stores.

| Chart | Drag p50 / p95, before → after (ms) | Overview rebuild p50 / p95, before → after (ms) | Retained overview buffers, before → after |
| --- | --- | --- | --- |
| Four subplots, 100k rows | 2.550 / 2.820 → 0.340 / 0.445 | 1.225 / 1.360 → 1.700 / 1.800 | 2,514,720 B (2.40 MiB) → 227,880 B (223 KiB) |
| Single bar chart, 1M rows | 21.970 / 23.090 → 0.420 / 0.475 | 6.930 / 8.135 → 10.650 / 13.895 | 24,000,000 B (22.89 MiB) → 113,040 B (110 KiB) |

Round p50 ranges for dragging were 2.480–2.720 → 0.330–0.350 ms
(subplots) and 21.800–22.685 → 0.415–0.425 ms (1M bars). Rebuilds
were 1.150–1.310 → 1.665–1.745 ms and 6.845–6.980 → 10.465–10.750 ms.
The extra rebuild work checks actual rectangle placement, clipped coverage,
and every intersected column. This cost preserves wide bars and counts only
rectangles that paint in the strip; dragging still reuses the bounded
geometry. Rebuild work grows with intersected columns as well as source
rows (a wide bar can cover several columns).

A separate missing-heavy exact-path measurement uses 1,000,000 sorted rows,
20 values of 1 followed by NaN, a 600 CSS-pixel strip, fixed linear scales,
and reused output buffers (Node 22.23.3, Darwin 27.0.0, Apple M6, minified
production bundle). Two rounds each use 100 warmups and 250 alternating
samples of full bar geometry, the previous reducer, and the footprint
reducer. The previous reducer's two source walks took p50 5.944–6.086 ms;
the single-walk exact path takes 2.505–2.775 ms. Round p95 was 7.012 →
2.901 ms and 8.196 → 3.609 ms; full bar geometry p50 was 3.038–3.076 ms.
These are overview construction timings, excluding table changes, plot
construction, and drawing. The core benchmark includes this case alongside
full geometry. Sparse output stores only the usable rectangles.

Initial gzip size is unchanged for 21 of the 22 measured entries, including
`herceg-line` at 43,981 B. `herceg-bar` grows by 15 B to 50,831 B to prepare
bar placement for the strip. Navigator comparisons against other libraries
remain unmeasured.

## Small multiples

With `facet`, the model draws a panel per value of a category field, or per
pair of values of a row field and a column field (each field's values in
order of first appearance across the tables of the marks that split, every
pair drawn, rows by columns). Facet headers are scene text (`Scene.headers`),
so every renderer and static export draws them the same way. With
`resolve.y`, panels are grouped (each alone, by row, or by column) and each
group gets a y plan from the data its panels draw within their x domains,
the same nice, headroom, and inset rules as a shared axis; a group with
nothing to show draws no y labels. Rows
are split after series are resolved: a facet split of a series is the same
columns read through a list of the rows in each panel (4 bytes per row),
computed in two passes per series (with a transient 4-byte panel index per
row) and kept until its table changes, with
sortedness checked per panel. Series of one table's rows split alike (the
fields of wide data) share their panels' row lists. Series keep their keys, so colors, legend
entries, and hidden state are shared across panels. Splitting after series
are resolved is right for marks whose series are row-aligned (lines, points,
bands and stacks of several fields, unstacked bars, error bars, candlesticks).
Stacked bars, whose geometry combines rows, resolve their series unstacked
when a facet splits them (`Mark.series`'s `split`) and stack after the split
(`stackPanels`), each panel, position, and sign apart: one pair of
table-sized top and base arrays per field, which the panels' disjoint rows
fill, kept while the table, the panels' rows, and the hidden series stay the
same. Areas stacked by a series field do the same, each panel's layers on
the x positions of that panel's rows, with edges of their own. Heatmaps split like row-aligned marks: each panel's raster and cell
index read only its rows, so a cell takes the last row with a value among
them, and equal cells of other panels never meet (see Points and rasters).
Marks whose series summarize rows (histograms, box plots, violins) are
split before they combine them: with `split`, their `series` lists only
their series' keys, labels, and colors (the legend's, `model.series()`'s),
and the splitter hands them each panel's rows of their table
(`Mark.summarizePanels`: one partition per table version and panel list, 4
bytes per row, whatever series the rows are in) with the x group of each
panel. A histogram chooses bins per x group from the rows of its panels
(one set for a shared x, so rows without a facet value widen no bins, but
rows without a series value do, as in one chart), then counts each panel's
rows by series code in one pass; percent and density are over a panel
series' own counts, stacks are of the visible series within a panel, and a
series without rows in a panel has no bars there rather than empty bins.
Box plots and violins summarize each panel's rows as one chart summarizes
all of them, and list series in one chart's order (each series value by
the first category it has values in: a pass over the rows, nothing
summarized). Every panel lists every series, absent ones empty, so slots
and keyboard stops agree across panels. Counts and summaries are kept per
chart (by its first panel's rows) while the table, the panels' rows, the x
groups, and the zone are the same; redrawing or hiding a series recounts
and sorts nothing. A summary series finds its summary through its `values`
(the summary's medians, which panels' copies share), and a box's band comes
from the chart's band of a table row of its group, so panels read the
chart's one mapping instead of making their own. Annotations over a table
have no series to split: the splitter hands each panel its rows of their
table from the same partition (`MarkSeries.rows`, one part per panel, so
annotations over one table share it), groups of panels sharing a scale read
their panels' parts without copying them together, and `geometry`, the
extents, and `describe` take the parts as a trailing argument
(`RowParts`); scratch and pooled buffers are sized by a panel's rows, not
the table's. In Node on the development machine (with other work running),
a rule, a region, and a label (`overlap: "hide"`) per row of 100,000 rows in
50 panels take about 55 ms a scene, as one panel of the same rows does
(rules about 9 ms, regions 3.5 ms, labels 40 ms, most of it measuring and
hiding labels; `npm run bench:core`). `split.all` carries every panel's
parts, so rows without a facet value count toward no domain. Continuous domains come from every panel's series, so rows
without a facet value are left out of them; the bands of a shared category
axis still come from whole tables. Each panel gets a frame whose scales are the
shared plans moved to its row and column, and whose buffer pools are its
own, so geometry code is the same as for one panel; each has its own
inspector, and the chart routes the pointer to the panel under it.

Subplots (`panels`) take the same path. A `PanelLayout` (`model/panel-layout.ts`)
is what the model reads: a facet or a `Panels`, each loaded only with charts
that use it. Where a facet splits each series' rows, subplots route whole
marks: every panel's list holds every mark in the chart's order, with series
only where the mark's `panel` names that panel (or is `"*"`), and a member
mask so marks elsewhere are neither drawn nor inspected there. Marks keep
their index in the chart as their identity in every panel, so series keys,
colors, and legend state are the same as in one panel. Panels default to a y
scale each (`resolve.y` "independent"); each group of panels sharing y plans
it from what its panels draw, with the chart's `y` and its first panel's own
settings, and subplots infer each group's type (linear or time) from their
own marks.

The right y axis is planned as the left one is, by one planner over either
side's marks: shared, or with `resolve.yRight` (by default the left one's
resolution) by panel, row, or column, each group from what its panels draw
on that side (`PanelLayout.groups` filters marks by side; a right group takes
its settings from its first panel drawing on the right, and subplots'
`yRight` settings agree as y's do). A panel has a right axis when a mark it
draws places values on it, and a left one unless all of them are on the
right, so subplots without right marks draw no right axis and a subplot of
right marks only no left one, its grid lines following the right axis. The
two sides' labels go by one rule: beside each row's first panel on the
left and its last on the right, or beside every panel whose scale is its
own (and in subplots), the gaps between columns holding the right labels of
the panel before and the left ones of the panel after; a grid's row
headers go beyond the right labels, and the right title beyond them. Each
panel's frame, inspector, formatter, and `DrawnPanel.yRightGroup` read its
own right plan. A y zoom moves both axes through the same pixels, so facets
refuse it when right marks have scales of their own, and `setViewport`
checks each side's range against that side's resolution. Fifty panels of two lines over
100,000 rows take about 1.6 ms a scene with both on the left or a shared
right axis, and 1.8 ms with right axes of their own. What only a grid of panels needs
(fitting it to the chart, weighted rows and columns, the room between rows)
is the layout's (`PanelLayout.tracks`, `rowGap`), loaded only with it.

`resolve.x` groups panels for x the same way (`PanelLayout.groups`), and the
model plans each group as it plans the one shared x scale: the x extent of
what its panels draw, its viewport or the configured domain (for subplots,
its first panel's `x` settings over the chart's, and a time axis when its
marks place times), its nice, headroom, and inset rules at the common plot
width, its ticks, and its tooltip formatter, moved to each panel's column. A
y extent then reads each panel's series within that panel's x domain: each
y group is split by the x groups of its panels (`PanelLayout.across`, only
the pairs that occur), the raw extents of the parts are unioned, and the y
group's zero rule is applied once, so a bar's baseline counts even where the
bar is out of view. With one x scale this is the single computation it was
before, and its scenes are unchanged. A shared y scale therefore follows
every panel's own x view: zooming one x scale can change the y of panels on
the others. Labels go under every panel when x is resolved by panel or by
row (a column's panels then differ), and a scale's title goes once under
its lowest labels, centered under its panel, its row, or the grid; rows
leave room between them for both. Widening the margins and the gaps between
columns checks the first and last labels of every labeled panel's scale.

Viewports are kept per x scale, keyed by its panels' keys: a scale whose
panels change (a new facet value wraps the panels anew, or a row gains a
column) is a new scale and fits its data, rather than handing one
category's zoom to another, and the keys of scales no longer drawn are
dropped. The browser runtime acts on the scale of the panel a gesture is in:
the wheel (not over the gaps between panels, where the page scrolls), drag
pans (with the scales the press started on; a press whose panel leaves the
scene mid-drag stops), brush-to-zoom, double-click on a panel (elsewhere,
every scale; never on the legend), and Enter after a keyboard selection. A
chart keeps one selection, owned by the panels sharing the x scale of the
panel it was made in: drawn only there, reported with their keys, and
cleared (with an event naming them) once no panel of that scale is drawn.
Up and Down carry the keyboard cursor's value along the axis it follows (x,
or y for marks inspected along y) between panels sharing that axis' scale,
and its place across the plot otherwise, and a keyboard range never reaches
across scales. Synced charts share cursors with such charts (each
panel draws a cursor its scale holds) but neither send them nor take
viewports and selections, which belong to some panels only; applications
that link scales of the same quantity set them with `setViewport` and a
panel. Python's live widgets report one viewport and selection and refuse
charts whose panels have x scales of their own; the Streamlit component shows them and
reports clicks (the clicked panel's scale decides whether values are
times), keeps each panel's zoom across reruns by panel key, and refuses
`on_select`.

With `resolve` other than `"shared"` on a category axis, each group of panels
sharing the axis holds only the chart's bands that the rows its panels draw
hold, in the chart's order. The model discovers the chart's bands and resolves
series as it does for one panel, so a series' categorical channel holds chart
band indices: the shared axis' array of each row's band (4 bytes per row, the
field's own numbering when one mark's bands lead the axis, else one remapped
copy for the chart), which every panel shares. After the layout splits rows
into panels, `PanelBands` (`model/panel-layout.ts`) finds the bands each
panel's rows hold (a pass over each split's rows per table version, cached by
its row list; marks drawn whole, facet repeats and subplots, over their whole
column), unions them per group, and gives each group a band list and its
places: where each chart band is among the group's (-1 for none). A group
holding the chart's first bands, each at its own index (as when it holds them
all), needs no places; one whose bands span at most 4,096 chart bands, or at
most eight times as many as it holds, looks places up in an `Int32Array` over
that span; others search the sorted bands they hold. A group's places
therefore take at most 16 KiB, or 32 bytes per band it holds where that is
more: never a chart-sized or table-sized array per panel. Panels' series are
shallow copies carrying the places (`Series.places`), shared by the panels of
a group, or with both axes resolved apart (heatmaps, points over two
category fields) of a pair of groups; a mark's copy carries places only on
the axes it bands. Whatever reads a categorical position reads it through
`placeAt` (bar, point, and heatmap geometry, inspection, the keyboard), and
the values tooltips and events report through `valueAt` (a point's value on
a category y axis is its category's place). Places keep the chart's order, so a range
of places is a range of chart bands; a panel's ascending band indices can
still lie outside its domain, so placed series are searched as unsorted.
Groups are kept by their panels' keys while their bands are the same (labels
are measured once per list), and a group's key, the scale's `group`, carries a
number that changes with its bands (not with their labels alone, nor with
other groups): a selection on the scale is cleared, and a drag through it
stops, when they change, as when its panels do, since its band indices then
name other categories. Hidden series keep their categories; grouped bars keep
a slot per series of the mark in every category of every panel. A heatmap's
cell index holds chart band indices rather than places: places keep the
chart's order and every row a panel draws has a band its group holds, so the
index is the same at every panel's places, and one index serves every panel
drawing the same rows (a repeated mark, a subplot's `"*"`). The pointer's
place is turned back into a chart band (`BandPlaces.band`) to look a cell up,
and the keyboard compares cells at their places, as the panel draws them.
Text summaries read series' parts in every panel, which hold chart band
indices, so they name categories by the chart's bands (`SummaryContext.bands`)
rather than one panel's. Every mark that bands an axis (bars, heatmaps,
points, box plots, violins, error bars, and candlesticks, whose merged
pixel columns compare candles by chart band, which places keep in order)
reads its positions through the places (`Mark.bands` says so); box plots and
violins hold the categories of their groups with values. Whole-table marks
without series implement `resolveBands` to keep each panel's resolved band
keys and contribute their `bands` to category membership; dendrograms use
`c:<label>` keys and place their leaves on each panel's band scale. Synced
charts and brushes along a y axis of such categories are refused, and
category axes still do not zoom.

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
extremes are drawn whole and ticks stay round: they are chosen in the
rounded domain, since choosing them in the widened one could take a coarser
step (a short axis rounded to -20..40 at two ticks would keep only 0).

Points on a category axis (strip and dot plots, either axis or both) sit at
their bands' centers. Their series hold each row's band index, as bars'
do, read through a panel's places; rows without a category are neither
drawn nor counted in the other axis' domain. Such points are always placed
on the CPU, since a GPU cloud uploads its raw columns, and a category y
axis has no values: a point's reported value there is its category's
place and its tooltip text the category. Summaries of such points count
only those drawn (with a category, a position, and the values they encode),
and along category y say how many categories they fall in.

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
drawing them or is destroyed. Clouds of whole columns follow their table as
it streams: they are keyed by table and field pair (so charts drawing the
same columns share one upload) and carry the table's `rowOffset` and
`modifiedVersion`. Clouds of a series' rows follow their group the same way,
keyed by the group and carrying the rows it has dropped; their new points
are gathered from the group's last rows. The first change uploads the cloud again with room for
half as many points again and a normalized range reaching half the data's
span past each end; later changes that only append and drop rows write the
new points with `bufferSubData` and draw from a later first point, until
the buffers fill, a point falls outside the range, or the window shrinks to
under a quarter of the buffers, which uploads again; a stream whose range
still spans dropped outliers is refitted once if that range would cost the
GPU its precision.
Streaming 10,000 points per tick into a million-point window then costs
about 0.1 ms of JavaScript a frame instead of 4 ms (one-off measurement in
Chrome; GPU time not included). Clouds that never change keep exact-size
uploads. Until the painter has loaded, cloud series are
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

Heatmaps are rasterized into an RGBA image (colors from a lookup table) that
renderers stretch over the cells in view, clipped to the plot. Canvas draws it
with `drawImage`; SVG embeds it as a PNG. In the browser the canvas encodes
the PNG; `renderToSVG` uses a small bundled encoder, which only server-side
bundles include. Where the image is and which pixel each cell lands in is
decided per frame along each axis (`marks/heatmap-raster.ts`), in buffers the
chart keeps between frames, a value per band or cell (never per lattice slot
or table row):

- **Lattices.** Bands, and cells one width apart (see Heatmap cells), are
  slots of a lattice. With lattices on both axes, the image covers the slots
  in view, reaching past the plot's edges for slots in view only in part,
  and has a pixel per slot while they fit the plot's device pixels (the
  frame's `rasterRatio`: the device pixel ratio on screen, 2 for static SVG
  and PDF, which are zoomed and printed). Each cell is one pixel; when
  several rows fall in one cell, the last row with a value wins, and missing
  values leave a cell transparent. With more slots than device pixels, the
  image has as many pixels as fit, rounded down so each covers at least a
  device pixel (nearest-neighbor drawing of a larger image would skip
  pixels, and with them a block's only hot cell), and is reduced along each
  axis separately: slot `s` of `n` lands in pixel `floor(s * pixels / n)`,
  the pixel its leading edge falls in, and one pass over the rows
  accumulates each pixel's sum and count of finite values (or its greatest
  or least value, with `reduce: "max"` or `"min"`). Sums are Float64; a
  block whose sum overflows (values near the largest doubles) is summed
  again in a second pass with every value divided by 2^64, and its mean
  multiplied back. Each pixel's four bytes hold its count until it is
  colored. The sums are a frame buffer kept while the image is repainted (8
  bytes per pixel besides the 4 of the image). Rows that repeat a cell each
  count toward a mean.
- **Spans.** When either axis is not a lattice (unevenly spaced values), or
  a lattice's slots in view would reach more than two plot lengths past the
  plot (deep in a zoom), both axes become spans: the image covers the plot
  where cells are in view, at its device resolution along axes that are not
  lattices (and per slot, or blocks of slots, along those that are), and
  each cell is its projected edges in image pixels, snapped to a pixel
  boundary within a millionth of a pixel so float error gives no pixel a
  sliver of a cell. Painting goes cell by cell through the cell index
  (below, which tooltips use too, built here first): each cell sums its
  rows (or takes their greatest or least) and adds that to every pixel it
  covers, weighted by the area it covers there, into a Float64 sum per
  pixel, with its rows' covered area in the pixel's four bytes (as a
  Float32) until it is colored. So a cell is painted once however many rows
  repeat it, and the result does not depend on the rows' order. Each pixel
  also keeps the last row of the first cell reaching it, NaN once a second
  cell does: a pixel within one cell shows that cell's last row with a
  value, as tooltips report, and one holding parts of several shows the
  area-weighted mean of all their rows (or with `reduce`, the greatest or
  least row of any cell in it). Overflowing sums are summed again scaled,
  as for blocks. The image, sums, and last values take 20 bytes per pixel,
  of the plot's device pixels at most.

The painted image and where it is are kept and reused until the table, a
row's band or cell (the band order, the breaks), a facet panel's rows or its
categories' places, the scales' domains and ranges, the plot, the raster
ratio, the theme, or the mark painting into the buffer changes, so redraws
for other reasons (a legend toggle, a brush) neither place nor paint a cell.
Each zoom or pan paints again, in one pass over the rows.

Tooltips report the cell under the pointer even when its pixel shows a block:
the band scale maps the pointer to a band index, or along a number or time
axis the scale's inverse finds the cell whose span holds the value there (by
binary search over the cells' edges, so a gap holds none), and a cell index
finds the row. The index (`lod/cell-index.ts`) is the series' positions with a value
(the table's rows, or a facet panel's), sorted by cell row and column with
two counting sorts (positions already in cell order, as dense grids usually
are, are taken as they are, and when they are every position, the series
itself is the index), so it keeps at most 4 bytes per row whatever the
number of cells, and a lookup is a binary search. Building it over a whole
table takes up to 8 more bytes per row and a counter per band or cell; over a facet
panel's rows, it first gathers their cells and values (16 bytes per
position), so up to 24 per position; and a grid of several times more bands
than positions (a panel's few rows among many categories) is sorted by
comparison instead, without counters. It is built on the first lookup or
spans paint after the table, the band order, or a facet panel's rows change, and is
kept by the rows it indexes, so a faceted heatmap's panels take one index
each, their rows' share of one table's. The keyboard steps through it too:
a step along a row is the next entry in the index's order, and a step along
a column looks the next rows up one at a time (32 at most), both by binary
search; entering the grid takes its first or last entry. Jumps (Home, End,
Page Up and Page Down), steps past a row's or column's end, and steps down
a column whose next cell is more than 32 rows away scan the cells. Ramps
are `#rgb` or `#rrggbb` colors, checked when the mark or theme is created, so
the raster and the legend read them the same way.

Band axes find each field's distinct values once per table version, numbered
in order of appearance through a Map and then renumbered in ascending order;
when a field's bands lead the axis in their own order (one mark on it), its
rows' band indices are that numbering itself rather than a remapped copy.
Thinning band labels needs the widest label, measured once per list of band
labels, so an axis of 10,000 categories measures each label once rather than
on every layout pass.

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

Category fields encoding a point's shape (`symbol`) or color (`color`) take
places in a cycle, of the shapes or of the theme's palette, in order of first
appearance (`marks/appearance.ts`): a value keeps its place while it stays in
the table, though compaction renumbers codes, so a streaming chart's points
do not change shape or color as values come and go, and the places are found
once per table version, as a code-indexed array the drawing loop reads.
Points colored by category carry palette indexes as continuous colors do,
marked categorical so value animation changes them at once rather than
moving them through other categories' colors; the legend keys the values in
their colors, and the series a `color` field does not split are listed in a
neutral color.

## Layout marks

Most marks place data along x and y scales. Layout marks (pies, treemaps,
sunbursts, gauges, funnels, radars, Sankey diagrams, and networks) place their own geometry in a panel instead: the chart model gives one a
room (`LayoutFrame`: bounds, the rows of its table to draw, theme, text
measurement, hidden keys, and stable colors per item key) and draws what it
returns (`LayoutResult`: geometry, an item lookup by pixel, the items in
reading order, and a summary). The room is the space below a chart's title
and legend, for a chart of one layout mark (or of the layers of one map or
3D box, drawn as one; see Maps), or a panel's plot, for a layout mark in
facet panels or in a subplot of its own (see Layout marks in panels). A
panel holds marks along axes or one layout mark, never both.

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

A network (`graph`) is the one mark that reads two tables: its links and,
optionally, its nodes. Layout marks list tables beyond `table` in
`otherTables`, and `tablesOf(mark)` gives all of them to whatever follows
changes: the DOM chart subscribes to each and keys its description on their
versions, and the React, Vue, and Svelte adapters compare them when deciding
whether a rebuilt mark is the same. The network is built in one pass over
each table (names to node indexes once per dictionary code, one link per
unordered pair), rebuilt when either table changes. Its layout
(`layout/force.ts`) runs d3-force's simulation with its defaults: springs of
length 30 whose strength is the inverse of the smaller end's degree, and
whose pull moves the less connected end more; many-body repulsion of -30,
summed exactly up to 150 nodes and with a Barnes–Hut quadtree (theta 0.9,
rebuilt each tick in flat typed arrays) above; alpha decaying from 1 to
0.001 over 300 ticks; velocities keeping 60% per tick. Two things differ from
d3, both for the picture's sake. Nodes start from pivot MDS
(`layout/pivot-mds.ts`, after Brandes and Pich): breadth-first distances
from up to 50 pivots, double centered, and the top two eigenvectors of the
small pivot-by-pivot matrix, so the start already follows distances in the
network; from d3's phyllotaxis spiral, rings and long chains settle folded.
And connected components are packed in rows of their bounding boxes, tallest
first (`layout/components.ts`), before and after the simulation, instead of
being held together by a pull toward the center: components started inside
one another never separate under 1/r repulsion, and the pull squeezes large
components out of shape. Boxes are a less compact arrangement than discs,
but they cannot overlap. Networks are limited to 5,000 nodes, where repulsion
costs about a second, and 20,000 links, so dense networks cannot make the
springs cost more. Degrees and totals in tooltips and the description are
counted over the links drawn, so hiding a group changes them. Layout positions are cached per network; each room
refits them (uniform scale, one axis stretched by at most 30%, at most 2.5 px
per unit), then pushes overlapping circles apart over a few passes of a
uniform grid. Nodes are a point geometry (packed centers, radii, and color
indexes), largest first, each filled and ringed in the surface color, so
overlaps stay legible; links are a segments geometry per width and color
(four floats a link, with an opacity of their own), so a frame that moves a
node writes typed arrays rather than SVG path strings. Directed networks
keep a link per ordered pair; a pair with links both ways bows each to its
right as a quadratic curve (a shapes path, since few links are bowed),
and each directed link ends at its target's ring with a chevron of two
segments along its end's tangent. Link labels (`linkLabelField`) are a link's
category when all its rows agree, placed at its middle where they cover no
node or label, budgeted as node labels. Pointer candidates come from packed
32-pixel spatial grids (`layout/hit-grid.ts`), built lazily for nodes and
links separately: node hits do not build the link index. Nodes insert their
radius plus pointer reach; links insert only columns reached within each
crossed row, expanded by half their width and pointer reach. Reciprocal
curves use the same eight chords as distance testing. Segments are clipped
before indexing, so links with offscreen endpoints remain pickable without
index work following their full zoomed extent. Grids narrow candidates;
exact distances and drawing ranks still decide: containing nodes by
selection, smaller radius, then later order; nearby nodes by edge gap,
then later order; nodes before links; links by edge gap, then their drawing
layer. Candidate grids are retained across draws of unchanged positions,
including selection changes, and replaced on moves, navigation, or resize.

Nodes the chart's user moves (`setItemPosition`, or a drag's position each
frame, which is drawn without being a move until it is dropped) are kept
per chart by key in the network's layout units, with the layout positions
they were moved in: the drawing places them through the room's fit
(`layoutFit`) after the automatic placement and its separation, which
moved nodes are left out of, so the fit never changes as nodes move, and
moves are dropped when the network's tables change and the layout runs
again. What identifies the layout is kept per links and nodes table, their
versions, and the fields and options the layout reads, so a mark made again
over the same tables (an adapter's re-render with other styles) keeps the
chart's moves; a drag whose node the layout lost ends without a move. A
frame dragging a node of 5,000 nodes and 20,000 links took about 4 ms of
the main thread in the earlier Chrome measurement (p95 about 5.5 ms, p99
under 8 ms), the frames keeping 60 Hz. With navigation and picking state,
interleaved Node runs of the same scene now take about 5.6 ms rather than
5.0 ms. The extra redraw cost is accepted for these interactions; browser
frame costs for the new controller have not been measured.

Networks expose `LayoutResult.plane` just as maps do (`layout/graph-view.ts`).
Separated base pixels are inverted through their original fit into layout
units, then projected through the view; the fit's modest x/y stretch is
retained, while navigation magnifies both axes by the same factor. Radii,
rings, link widths and arrows remain in pixels. Moved nodes project from
their stored layout coordinates without clamping; a drag clamps the pointer
before inversion. Node selection also dims links unless both endpoints
are selected, intersected with link-row highlighting where present.
Lassos test visible node centers and return all nodes-table rows naming
those nodes, including duplicates; they leave link-table selections alone.

The network controller composes shared plane navigation with node dragging
and one toolbar. Lasso mode claims plain drags; Shift-drag pans. Otherwise,
a node press drags that node and a background press pans. With zoom on,
Shift+arrows and 0 navigate, Alt+Shift+arrows moves a focused node, and the
restore-nodes button remains separate. A change of the view of the plane
a node is dragged on (not another subplot's) cancels the drag. Controls load only through layout marks, so line charts carry none
of this code. Python widgets preserve graph x/y ranges; Streamlit keeps
plane views separately from axis panels, restoring viewport and positions
before replaying a lasso, and scopes network state to its layout epoch.
Streamlit's `on_viewport` reports an `hg.Viewport` like widgets do.
Node dragging and plane navigation share pointer ownership from the initial
press until completion or cancellation, so another touch cannot start the
other gesture, even before the first pointer moves. Maps ignore second touches.
Both Python front ends compare resolved map projection parameters before
keeping ranges and lassos, per map (the chart's one, or each subplot's;
facet panels' fitted to the rows the panels draw); a data change that
changes inferred conic parameters clears that map's viewport and lasso
together.

### Layout marks in panels

Every layout mark but 3D charts draws in panels (`IN_PANELS` in
`model/panel-layout.ts`; a 3D chart's camera and GPU painter are the
chart's). The `PanelLayout`'s checks own the rules, and return the layout
marks the panels draw (`ItemViews.inPanels`): the geoshape and geopoint
layers naming one subplot, or all of them in facets, joined into one map
(`GeoMap`, which knows each layer's index among the chart's marks, so its
items name their mark and its layers' identities are the chart's, not the
map's). With a facet, a layout mark is the chart's only mark and splits its
rows (a map's layers each split theirs, or repeat with `facet: "repeat"`,
and one must split); with subplots, it names one panel, which takes no axis
settings and no other mark, `"*"` marks included. `ItemViews.interactions`
checks a chart's `interaction` against what its layout marks take (zoom for
drilling, a plane's zoom and lasso, dragging nodes), the same check as for a
chart of one: panels with axes take zoom and brushes along x; where every
panel draws a layout mark, options none of them takes are refused, and so
are sync, seams, and `resolve`.

The splitter marks such panels in its split (`PanelSplit.items`: the mark,
its index among the chart's marks, and its rows there). A facet hands the
mark each panel's rows of its table from the same partition that
summarizing marks read (4 bytes per row, kept per table version and panel
list); a subplot draws the whole table. The model's one scene path lays the
chart out as for marks along axes and draws the layout mark into its panel's
plot: those panels get no axes, grid lines, or inspector, nor any part in
scales, so the grid labels a shared x scale under the lowest panel with
axes of each column (`PanelGrid.lowest`, leaving room between rows when that
is above a layout mark's panel), a scale takes the settings of its group's
first panel with axes (`PanelGroups.first`), and a chart of layout marks
alone has no axis margins. `model.panels()` (panels with scales) leaves them
out; `model.allPanels()` lists every panel in order, for `getPanels`, the
keyboard, and the pointer. Marks keep their index among the chart's marks as
their identity whatever their kind, so series and item keys never collide
and inspections name the right mark.

Each layout mark reads its frame's `rows`, caching what it works out per
table version and row list (`RowsCache`), so 50 panels keep 50 sets of sums
rather than recomputing one: pies and funnels sum per category, trees total
each panel's rows over the table's one tree and keep the part with a value
as a tree of its own (`pruneHierarchy`), so a panel's arrays, boxes, and
keys are as large as its own nodes rather than the whole tree, a gauge
scans its rows back for the last finite value, a
radar reads each panel's latest values on the table's spokes and series
(found once per table version), and a Sankey diagram aggregates each
panel's flows and keeps a layout per flows and bounds. Items keep their keys
(`[id, name]`) in every panel, so the chart's palette, which gives a key a
color on first request (the legend asks first, over the whole table), and its
hidden keys apply in every panel. Normalization is each panel's own: shares,
areas, flows, and a radar's automatic domain fit their panel.

A treemap or sunburst drilled into a node draws the subtree under it as a
tree of its own (`subtreeOf`, kept per table version and node): its nodes'
keys go on through the path to the node (`TreeView.prefix`), so they are
those of the whole tree, and every node takes the color and legend entry of
the top-level node it is under, so colors, hidden entries, and selections
stay as they were. The drill root is the chart's (`ItemViews`), as set by
`setDrillRoot` and then as drawn, with the path to it: a node the data lost
gives way to its nearest ancestor that remains, found through that path
(so for node and parent fields too), and the DOM chart reports the change
with one `drill` event after the frame that drew it. With `interaction.zoom`, the tree
draws its path above itself, "All" and every node down to the root, as two
text geometries (steps to go back to, muted, and the current one), even at
the top so that the first drill does not move the tree. A path wider than
the room folds the steps between "All" and the parent into one "…", from
the top down (in rooms too narrow for that, every step but the last, or
every step), and the steps shown share what is left, each cut to its
part. The result's `Drill` gives every step's box (folded steps' all over
the fold, the nearest on top), over which the controls lay native buttons
with transparent text, so folded steps stay reachable by Tab and screen
readers, and it resolves nodes named by key or by names from the top. Drilling into a region of a treemap of 10,000 leaves takes about
1.5 ms a frame in Chrome (0.8 ms for the scene in Node), and back to the
whole tree about 2.2 ms.

A facet splits each map layer's rows as it splits a mark's table
(`PanelItem.layerRows`, and the rows of every panel together,
`PanelItem.fitRows`, which each panel's map fits and plans a conic
projection by, so every panel shows a place at the same pixels of its room).
Maps in panels project their shapes at a scale level, as a zoomed map does,
even when fitted (`LayoutFrame.inPanel`), so panels of one size share one
cached projection: the shape cache keeps four transforms per geometry set,
which six fitted panels at six origins would otherwise thrash (a pan of one
of six map subplots of 200 regions: about 44 ms a scene before, 0.4 ms
after, in Node). A network's facet panels share one layout of the whole
network: each draws the links its rows give, with their totals and labels
over those rows alone (`GraphMark.#part`, kept per rows), and the nodes they
join; the placement (the force layout fitted to a room and its overlapping
nodes pushed apart) is computed once per room size at its corner and moved
to each room, so equal panels draw a node at the same place of each, and
pointer lookups are kept per panel.

What the chart's user changes of layout marks is kept per state in
`ItemViews`: a tree's drill root, a map's or network's view (ranges of its
plane), and a network's moved nodes, with the node being dragged. Facet
panels show one mark's rows split by a field, so they share one state, keyed
""; each subplot has its own, keyed by its id; a chart of one layout mark has
"". The first panel of a state drawn in a scene settles it (a root the whole
tree lost gives way to its nearest ancestor, reported once; moves of
another layout go), and a scene drops the states of subplots the last one
left out. A facet panel whose part of the tree has nothing under the root
still draws the path to it. Methods take a panel (`Chart.setDrillRoot(node,
{ panel })`, `setItemPosition`, `getItemPositions`, `getDrillRoot`, and for
planes `setViewport` and `getViewport`) and resolve it to its state; without
one, the chart's one state, or the one subplot's of that kind, and an error
naming the panels when there are several. Changes report the panels of a
subplot's state (`panels: [id]`) through the item-change sink. A plane's view
is the chart's viewport only in name: `Chart.setViewport` asks the items
first (`ItemViews.setView` with the model, which owns the view where the
target is a plane panel, or where the chart has no panels with axes), so a
chart's axes keep their viewports apart from its maps', and without a panel
in a chart with axes the view is the axes'. A lasso on a plane belongs to
its state's panels (`SelectionOwner.plane`): drawn in each of a facet's,
written as the rows each panel draws inside it, and reported with the
subplot's `panels`; a chart still has one selection. Clicks and the
keyboard's Space select what the item stands for in its panel: a tree's
part of the tree keeps its nodes' nodes in the whole tree and its rows
(`TreeView.nodes`, `TreeView.rows`), so a node's rows and the highlight's
counts are the panel's; a link's rows are its panel's; a node's rows of the
nodes table are the same in every panel.

What layout marks drew is kept by an `ItemViews` (`model/item-views.ts`), one
per chart: each panel's `LayoutResult` with its key, name, plot, and mark, the
item inspections (named by panel in charts of panels), the stepping of the
keyboard through a panel's items, and the per-panel summaries the
description lists (up to 20 panels). It also builds the scene of a chart of
one layout mark and checks such a chart (`ItemViews.alone`). Charts reach it
through their layout marks, each of which gives the class (`LayoutMark.views`),
so a line chart loads none of it; moving the lone layout chart's code there
paid for panels' code in the model, and a line chart's bundle is about 50
bytes smaller than before. In the DOM chart, Up and Down move between stops:
a panel of marks along axes has its series', and a layout mark's panel is
one stop, whose items Left, Right, Home, End, and the page keys read; the
cursor is the panel and the item's key, since one key is in several panels.
A press in a layout mark's panel is a click, and the wheel there zooms
nothing. Value transitions play only in a chart of one panel, and layout
marks in panels draw without the descriptions a transition needs.

In Node on the development machine (with other work running), the first
scene of 50 pies over 100,000 rows (8 categories, laid out 10 by 5 at
1600 x 1200) takes about 1.4 ms, which splits the rows by panel and sums each
panel's; drawing it again takes about 0.2 ms, and after a row arrives about
1.3 ms (`npm run bench:core`). Treemaps of 100,000 distinct leaves, 2,000 in
each of 50 panels, take about 120 ms the first time, and keep about 11 MB of
typed arrays and 71 MB of heap after collection, against about 8 MB and
65 MB for one treemap of the same leaves: each panel's part of the tree,
not the whole tree 50 times.

## Maps

Maps are layout marks too, but a map's layers (`geoshape` regions and
`geopoint` points) share a chart and the chart's `projection`. Layout marks
that offer `join` (only maps' layers) are drawn as one mark: the model's
`validate()` replaces the chart's layout marks with what the first one's
`join` returns, a `GeoMap` (`marks/geo.ts`) that refuses other kinds of
layout marks and repeated ids. The map settles the projection, fits what
every layer draws into the room, and lets each layer draw with the same
transform; layers keep their own identity (`id`, or their place among the
layers) in item, legend, and geometry keys, and their own legends and color
scales, since fields of the same name in two layers may measure different
things. Items are read layer by layer; the pointer tries layers from the
last drawn. Layout marks gained two optional members for this, `join` and
`legends` (continuous color ramps and size keys for the legend header),
`legend` receives the theme (points colored by a field show their series in
a neutral color), and items an optional `measure` (the tooltip's heading, which differs between a
map's layers).

Projections (`geo/projection.ts`) are d3-geo's raw forward projections, in
radians and units of the Earth's radius: Equal Earth (the default), Natural
Earth I, Mercator, equirectangular, and Albers' conic equal-area (cylindrical
equal-area when its parallels are symmetric about the equator). Only
longitude rotation is supported (`centralMeridian`), so there is no horizon
to clip and no spherical clipping. Edges are straight lines in longitude and
latitude, as GeoJSON (RFC 7946) defines them, not great circles, so cutting
shapes at the map's edges is plane clipping (`geo/clip.ts`): longitudes are
shifted by the central meridian, each 360-degree window a ring reaches is
cut out of it and moved back (with the central meridian at 0, rings within
±180 need no cutting), and latitudes are cut at Mercator's limit (85.05
degrees). A cut follows the cutting line between where the ring leaves it
and where it comes back, pairing those crossings in order along the line, so
a concave ring cut in several places becomes several rings without
zero-width connectors that a border would trace; rings are cut one by one
and filled with the even-odd rule, so holes stay holes, and a ring that
crosses itself is kept in order around it. Edges longer than a degree are
divided, and in pixels each edge is halved again (at most 16 times) until
its projected midpoint is within a quarter pixel of the chord drawn for it,
as d3-geo resamples, so the seam, the poles, and parallels follow the
projection's curves at any zoom; edges under 2 pixels are drawn straight.
Fit boxes and rings span at most a turn of longitude (wider ones are
refused, or left out), so cutting visits at most two windows. A conic projection without a central meridian takes
the middle of the data's longitudes, across the widest gap between them in
1-degree columns, and its parallels a sixth of the data's latitudes in from
either end.

Fitting (`geo/project.ts`) scales and centers the plane box of what the
layers draw (or of the world's outline, or of a box of degrees) into the
room, leaving the largest point's radius and half its ring; a single point
spans about two degrees, and a map of nothing, or a box beyond the
projection's latitudes, shows the world. The box does not depend on
values or hidden categories, so recoloring and the legend never move the
map. Shapes are projected per geometry set (`geo/shapes.ts`), shared by
every mark and chart drawing it: a plane box per geometry and projection,
and pixels per projection and fit (the four most recent fits, so a few
charts, sizes, or zoom levels drawing one set do not evict each other). Points within
0.35 px of the last one kept are dropped, rings left with fewer than three
points too, and the holes of a polygon whose exterior is dropped. A resize
projects again rather than keeping every point in the plane as well as in
pixels; changes of values, colors, the legend, or the theme reuse the pixels
and the SVG path data, which is made once per shape. The plane boxes come
from vertices with edges divided at a degree, each ring's widened by twice
the furthest any of those edges' middles lies from its chord, so they hold
the projected curves at any zoom; projecting the middles too costs about 1
to 3 ms more per 200,000 vertices in Node, once per projection.

Regions are a `polygons` geometry: per shape, Float32 pixels and ring
offsets, filled with the even-odd rule and bordered shape by shape (one SVG
path element each, so a change of colors only changes fill attributes;
`fill("evenodd")` on a canvas; `f*` in PDF), and drawn in row order. A layer's points
are one point geometry with a ring (in the background color by default)
that point drawing strokes over each point, drawn one by one, largest first
across every series (each with its series' color by index), so smaller
points stay on top. The
pointer finds the last-drawn point whose disc it is within 3 px of through a
uniform grid of centers searched as far as the largest radius, else the
last-drawn region containing it: a uniform 32-pixel grid of each polygon's
box (polygons covering more than 64 cells are kept in a list tested on
every query, so the grid's size follows the room) narrows the candidates,
and an even-odd crossing test over all of a shape's rings decides. The
keyboard's tooltip anchors a region at the middle of the widest stretch
inside it along the middle of its largest polygon's box, which lies in the
shape, never in a hole.

200 regions of 1,000 vertices and 10,000 points take about 20 to 30 ms to
measure, project, cut, divide, simplify, and fit the first time (in Node,
one machine), 11 ms at a new size, 2 ms to draw again after a value
changes, and about 2 µs to find the region under the pointer.

A map's view is ranges of x and y in the plane (`LayoutFrame.viewport`),
kept with the other state its user changes in `ItemViews` (see Layout marks
in panels), which `Chart.setViewport` and `getViewport` reach when the
chart's view is a plane's:
the map is drawn at the scale at which the ranges given fit the room,
centered on them, and along an axis without a range on the fitted map's
middle; without either it is the fitted map, drawn exactly as before (in a
chart of one map; maps in panels always project at a level, below). Rather
than projecting every shape at every pan step's transform, a zoomed or
panned map projects shapes at a level (`zoomedTransform`: the next power of
2^(1/4) at or above the scale shown, its origin on a grid of 2^18 pixels by
the view, so the pixels near the view stay small and precise in Float32
however small the map) and draws them moved and scaled down by at most a
level (`PolygonGeometry.transform`: canvas and PDF transform each point as
they trace it, SVG gives each path a `matrix` transform and divides its
border's width by the scale, so borders keep their width and pans rewrite
only the transform attribute). Projected shapes are cached per set and
transform key as before (four entries now), and the transform key names the
grid's origin, not the translation, so a pan reuses every shape until it
leaves the grid cell and a zoom projects again only past a level; projecting
at the level above keeps the drawn shapes within the quarter-pixel
tolerance. Shapes are culled before they are projected, by their cached
plane boxes plus the border and two pixels. The pointer's index, tooltip
anchors, and outlines work in the projected shapes' space, through the move;
an outline keeps only the parts of its edges inside the plot, as the
drawing is clipped, since the overlay it is drawn in is not. A region
whose box crosses the plot's edge is drawn and read only if some of it
shows (an edge crosses the plot, or the plot's middle is inside it, holes
and other polygons counted), and the keyboard's tooltip of a region shown
in part is in that part (the widest stretch inside it along a few lines).
Points are placed per draw from their plane positions, which are kept per
projection. `LayoutResult.plane` gives the plane's scales across the room,
the zoom, and the view any viewport shows (as the map fits it), for the
controls and lassos. Lassos select regions by an anchor per geometry kept
with its plane box (`planeAnchor`: the keyboard's anchor of the shape
projected to 1,024 pixels across its own plane box without dropping
points, so the same at any zoom and as precise for small regions far from
the plane's origin as for large ones), and points by their center. In Chrome on an Apple
M6, a frame panning 200 regions of 1,000 vertices takes about 0.6 ms of the
main thread (median; p99 1 ms) on Canvas or SVG, the frames keeping the
display's 60 Hz, and a zoom step to a new level about 5 ms on Canvas and
10 ms in SVG (p95 11 and 21 ms); in Node, the scene of a pan step takes
about 0.1 ms and of a new level about 4 ms.

## 3D charts

3D charts are layout marks too: `point3d` points, `line3d` lines, and
`surface` surfaces are the layers of one chart, joined (as a map's layers
are) into a `Plot3D` (`marks/plot3d.ts`) that plans the axes, fits the box,
and draws every layer together, either as ordinary scene geometry or
through a GPU painter. The box's grid lines and edges are line geometry
drawn below the data and its tick labels and titles text drawn above; the
layers are one `faces` geometry, which either holds their faces (points,
segments, and cells, drawn back to front, so SVG, Canvas, PDF, and static
export need no 3D code of their own) or describes them for a GPU painter
(`batches`, below), with the faces made only if a canvas has to draw them
without one.

Each axis is planned over every layer's data as a 2D axis is (`planAxis`,
over a range of -1 to 1: linear, log, and time axes, nice domains, ticks,
and formats; categories of a surface's floor evenly spaced), and normalized
coordinates are scaled by the box's aspect (a cube by default). The camera
(`three/camera.ts`) is an eye direction from an azimuth and an elevation,
with the screen's right and up vectors computed from the angles, so the
basis is defined straight above and below. Projection is orthographic, or in
perspective from an eye five half-sides away (zoom magnifies the picture; it
does not move the eye). The box is fitted by bounds that hold at every angle
(its floor's half diagonal across, its half diagonal up and down, or in
perspective the silhouette of the sphere around it), so it keeps its size as
it turns. The model owns the camera: it starts as the configured one,
interaction and `setCamera` change it, and an update that configures a
different camera (compared after filling in defaults) replaces it, so
framework adapters that re-render with the same props keep the view the user
turned to. The DOM chart turns it on drags, the wheel, keys, and buttons
(`dom/orbit.ts`, loaded the first time a chart draws a 3D mark) and reports
it once a frame. The box's far walls carry the grid; x and y are labeled
along the lowest edges on screen and z along the leftmost (ties going to the
nearer edge), with labels pushed out along the edge's normal on screen and
thinned to every n-th tick, against each other and against the titles and
the labels of axes placed before; an edge seen nearly end on gets no labels.

Each layer reads its items from its data, not from what it drew
(`Layer3D.items`): the keyboard, the description, and keys find the rows a
point layer draws (series shown, a color, a place in the box), a line's
samples, and a surface's grid points in the box, and each item is projected
for the view only when it is read. What a layer finds is kept per chart
and per layer for a key of the planned axes (their mappings, or categories,
so an axis planned again the same way keeps it), the table version, and the
series shown; `Plot3D` plans its axes once per version of its tables. A
surface's grid points outside the box at the corners of cells cut at its
walls are items too, read at the corner of the cut piece nearest them (found
in normalized coordinates, from the first cell in grid order whose cut piece
keeps any), and so are a line's samples outside the box at the end of a
segment that enters it, read where it enters. Turning the camera finds
nothing again, and a summary never projects or sorts.

Faces (`three/faces.ts`, drawn by `draw/faces.ts`) are packed: screen
vertices with their depths, each face's corners as vertex indices (one
corner for a disc, two for a segment, three or four for a cell, more for a
triangle of a cell cut at the box's walls), a style index per face (fill,
opacity, disc radius, outline color and width), and a sort key and depth.
Faces are sorted by key, then depth, with two 16-bit counting passes per key
(stable, so ties keep the order they were written in), and drawn in that
order; consecutive opaque faces of one style are filled (or stroked) as one
path (of at most 64 faces: Chrome fills one path of thousands of arcs slower
than many short ones), translucent ones, and ones outlined in another color,
one by one. A polygon is filled as the fan of triangles from its first
corner, each turned the same way, so a cell folded edge on still covers what
its triangles do under the nonzero rule; opaque cells are outlined in their
own color by half a pixel, which closes the seams antialiasing would leave
between neighbors, and wireframes are each cell's outline drawn right after
its fill, so cells in front hide the lines behind (cells cut at the walls,
drawn as triangles, have no wire, which would show their diagonals). A
segment is a stroke of its style's width with round ends, so a line's
segments, drawn at different places in the order, join smoothly.

A line (`marks/line3d.ts`) is each series' rows in table order (a counting
sort by series), the rows without a place left out and breaking their path;
each segment is cut at the box's walls (in normalized coordinates, so a
segment crossing the box keeps its part inside) and becomes a face of two
corners at the depth of its middle. Over the chart's one surface, segments
are also cut where they cross its columns and rows, and each piece is
ranked among the cells as a point at its middle would be.

The order is exact where it can be. Points alone are drawn by depth. For one
surface, with any points, the key is the surface's: along the eye's
direction a height field can hide only what lies farther along both grid
axes, so its cells are ranked row by row and, within a row, column by column
from the far side (in perspective, toward the eye's position from both
sides), and drawing in that order paints every cell before any that can
cover it. Points take the rank of the cell they lie over (or of where they
fall between cells outside the grid), drawn just before that cell when the
ray from them to the eye crosses its triangles, else just after; a
brute-force test
compares this with the nearest triangle at every pixel from several angles,
including from below, in perspective with the eye above the grid, on a
reversed axis, and around missing values. Several surfaces fall back to
sorting every face by the mean depth of its corners, which can be wrong
where they approach or cross.

Lines in that order are approximate: a piece is ranked by its middle, so a
segment piercing a cell, or a wide stroke near a cell's edge, can be drawn
on the wrong side of it near the crossing, and segments of crossing lines,
sorted by their middles' depths, can be drawn in the wrong order where they
cross. Drawing by depth per pixel (the GPU path) is exact where this is not.

A disc, though, covers more than the point at its center: ranked by its
center, the cells around it drawn after it would cut its edge though they
lie behind it (seen from above, every point over a surface would show a
crescent), and two overlapping points over different cells would be drawn
in the cells' order, not by depth. So once the order is known, each disc is
placed among the polygons and segments it overlaps on screen: after those
behind it and before those in front. A polygon covering the disc's center
is in front when the exact order draws it after the disc; others (all of
them in the approximate order, and segments always) are judged by their
depth where they come nearest the center, interpolated from their vertices
as the projection does (linearly on screen orthographically; in
perspective, 1 / (eye distance - depth) is linear on screen), and over a
cell folded on screen by the nearer of its triangles. Where these disagree,
the polygons over the center win (a point shows exactly when its center
does), then those in front at the edge. Each disc goes as early as that
allows, but no earlier than the farther discs it overlaps (placed first),
unless that would draw it over a polygon in front of it; discs in one place
are drawn by depth. In grid cells crowded with discs (more than 16), every
disc counts as overlapping, which can only move a disc later among discs, so
points piled on one spot are not compared pair by pair. The result is drawn
whole, so a point shows as a marker would: its outline cut only by the faces
in front of it. This costs most where many points lie over a dense surface:
ordering the faces of 10,000 points of radius 3.5 over a 100 by 100 grid
takes 15 to 25 ms a scene in Node, about 40 ms at radius 10, and 10,000 or
20,000 points piled on one spot under 30 ms (each disc is checked against
the faces it overlaps, found through two more grids like the pointer's).

A surface's grid is built once per table version: the distinct numbers or
times of x and y, sorted (or the categories rows hold, in dictionary order),
and per grid point the last row with a value, refused before allocation when
the grid would exceed 1,048,576 points; the CPU draws at most 250,000 and
refuses more with a clear error (in exports, with the SVG renderer, without
WebGL2, and for surfaces the GPU path does not draw), or, standing in for a
GPU painter that lost its context, draws nothing until it is back. Per
scene it projects each grid point once, then writes a face per cell with
three or four corners holding values; cells reaching past the box (a
configured domain narrower than the data) are cut at its walls triangle by
triangle, as drawn (Sutherland–Hodgman in normalized coordinates), so a cut
follows the surface. Shading is flat per cell: the cell's normal in the
box's units (across its diagonals), two-sided against a light above and
left of the eye, in 16 steps that multiply the ramp color by 0.72 to 1.1,
so styles stay few enough to share.

The pointer finds the face drawn last under it through a uniform grid
(`FaceIndex`, cells sized for a few faces each, 6 to 24 px a side): polygons
are filed in each cell their box covers, segments in each cell their stroke
reaches, discs by their center, and a query looks as far around as discs
reach. A surface's cell reports its corner nearest the pointer (corners in
the box first), a segment the end nearer it. Items are rows: points in row
order, a line's samples path after path, a surface's grid points in grid
order, keyed by the table's row identity (`rowOffset` + row), so keys
survive rows dropped from a stream. Inspections of 3D items carry their
values by field.

### 3D charts on the GPU

A chart is drawn by the GPU in the browser when every layer gives a batch
(`Layer3D.batch`) and drawing the chart on the CPU would cost at least
20,000 faces (`GPU_FACES_3D`: a point or a segment counts one, a surface
cell two). A point batch needs opaque points (its rows' columns, a color
byte per row, and the axes' mappings); a line batch opaque strokes; a
triangle batch an opaque surface without a wireframe whose columns and rows
fall in order on the axes (a second surface's categories may not, and its
cells would overlap). Anything else draws the whole chart on the CPU, as
does a painter that declines it (sprites larger than the device allows,
axes without a finite mapping). The threshold was measured: turning a 50
by 50 surface (2,401 cells) costs 2.7 ms on the CPU and 0.5 ms through the
GPU, 200 by 200 (39,601 cells) 28 ms against 0.4 ms; below 10,000 cells the
CPU's frame is under about 7 ms, and small surfaces stay vector and
antialiased and need no painter loaded.

The painter (`render/webgl3d.ts`, loaded only for a 3D chart's first batch,
through the page's painter in `render/webgl.ts` and its context, so in
builds that split dynamic imports into chunks 2D clouds never download it;
the Python package's single-file bundles hold both) draws every batch into
one depth buffer, cleared once per chart, so what is nearer shows whatever
order the layers come in, and copies the picture into the chart's canvas at
its place in mark order. All three programs place points with one
homogeneous projection matching `View.project`: in perspective w is the
eye's distance to a point over its distance to the box's center, and depth
is written as 1.5 w - 1.5 (z / w affine in 1 / w), so the GPU's
interpolation across triangles and ribbons is exact; orthographically depth
is linear. At equal depths the later layer shows, as on the CPU, except that
a surface's cells are drawn eight steps of the depth buffer back (polygon
offset), so points and lines lying on a surface show over it whichever
layer comes later, as they do on the CPU, though float32 places a point and
the cell under it a step or two apart (marks within those steps under a
surface show through it).

Points are sprites as before: each layer's columns are uploaded once per
table version as float32 values mapped by the axes then (less the centers
of their domains, times their factors, so values of any magnitude come out
near the box's [-1, 1]), and uploaded again only if the domains move so far
that points in the box would be off by a quarter pixel, or by 2e-7 of the
box (well inside the steps surfaces are drawn back by), as float32's error
grows with the distance from those centers, or the factors change a
millionfold; each row's color is a byte into a palette texture (255 for rows
not drawn), uploaded per color array, which the layer replaces when the
table, the hidden series, or the colors change. Uploads are kept by their
columns, so layers and charts drawing the same columns share them, with one
for each chart placed far from the others' (domains far apart). The
vertex shader moves points outside the box (and missing values, a sentinel)
off the screen, and sprites' corners are discarded, so they never hide what
is behind them.

A surface's cells are indexed triangles over the grid's vertices, their
positions normalized to the box (float32 is exact enough inside it). Each
triangle takes its flat color and normal from its last vertex (WebGL's
provoking vertex): a cell's two triangles both end at the grid point after
its last column and row, which carries that cell's color index and unit
normal (the CPU's, in the box's units, so `boxAspect` applies); a
three-corner cell missing that corner, and each piece of a cell cut at the
box's walls (cut on the CPU exactly as the CPU path cuts it, so no triangle
reaches outside the box), get vertices of their own. The vertex shader
computes how squarely the cell faces the light (the CPU's, a uniform) and
cuts it into the CPU's 16 steps; the fragment reads the color at that step
from a 256 by 16 texture the surface fills with the CPU's arithmetic, so
GPU and CPU colors match exactly except where facing falls on a step's
boundary (float32 may pick the other step: none of thousands of cells
sampled in the tests). Indices are 16-bit below 65,535 vertices (65,535
restarts primitives), else 32-bit. A million cells (1001 by 1001 grid
points) upload 49 MB: 25 bytes per vertex (position, normal, color) and 24
per cell (six 32-bit indices).

A line is instanced ribbons: one instance per segment, reading point i as
its start and i + 1 as its end from one buffer of runs of points in path
order (12 bytes each, normalized), and a color byte per point for the
segment to the next (255 at a run's end: a path's end, a break, or a
segment leaving the box). Segments reaching past the box are cut at its
walls (Liang–Barsky) when the runs are built, in float64, measured from the
end nearer the box and each cut end placed on the wall it lies beyond, so a
segment from however far outside keeps its part in the box (one far out on
two axes at once, whose part inside float64 cannot place within 1e-4 of the
box, is left out rather than drawn wrong); the CPU's faces, the pointer,
and the keyboard cut them the same way. The vertex shader spans each
segment with a quad half a width past each end, a constant width on screen;
fragments farther than half the width from the segment are discarded, which
rounds the ends and joins, and each fragment's depth is the segment's where
it comes nearest (`gl_FragDepth`), so an end keeps its depth. Ribbons, like
sprites and triangles, are not antialiased.

Batches build their arrays only when the painter has no upload of them
(`key`, an object kept while what it describes stays, per chart, for the
axes' key, the table version, and the box's aspect), so the arrays are not
kept on the CPU once uploaded, and turning the camera uploads nothing:
the view, the light, and the axes' mappings are uniforms. Uploads belong to
the charts that painted them in their last frame and are released when no
chart did; a lost context drops them all, the chart draws on the CPU in the
meantime (surfaces too large for it draw nothing), and a fresh painter loads.
A painter that declines a chart for good (points larger than its sprites)
leaves it to the CPU, which refuses surfaces too large for it with the same
error as an export.

The pointer finds what the GPU shows from the data, whenever it drew the
chart (after the CPU drew it instead, through its faces): each layer gives
the item nearest the eye within reach and its depth there, and the nearest
wins (`Layer3D.pick`). A surface walks the pointer's ray (`View.ray`) through
the cells it crosses inside the box, nearest first, over its columns' and
rows' positions (`three/hit.ts`), testing each cell's triangles, so no index
is kept: about a millisecond at a million cells. Points and segments (cut at
the walls) are projected once per view and filed on screen in a uniform
grid (a segment once in each cell within reach of it),
built on the first query after a turn (about 50 ms for a million points,
about 120 ms for a million samples of a line), then a query is under a
millisecond. A point within reach and nearer the eye than the surface under
the pointer wins over it, as on the CPU. Depths are compared as the 24-bit
depth buffer holds them (the projection's depth, quantized, a surface's
eight steps back), and of two at one step the later layer or row wins, as
the depth test lets it show.

On the benchmark machine (see `docs/comparison.md`), turning a 1001 by 1001
surface takes under half a millisecond of JavaScript a frame and keeps 60
frames a second when turned every frame; mounting it takes about a quarter
second (half of it the grid, the rest the batch's arrays and the upload).

## Dendrograms

A dendrogram reads a SciPy-layout linkage table: number fields `first`,
`second`, and `height`, with `leaves` labels indexed by leaf id. Its module
validates the tree and caches its first-child-before-second-child band order
until the table changes. It has no series, extents, legend, or inspection;
`describe` supplies leaf and merge counts and the height range. Facets must
repeat it whole. `side` contributes categories on x (bottom/top) or y
(left/right), leaving the height direction untyped so it can coexist with
a heatmap's band axes. Heights normalize by the largest merge height in
plot pixels, independent of continuous axis scales; missing leaves suppress
ancestral links. Geometry uses three packed segments per merge, drawn by
the existing SVG, Canvas, static SVG, and PDF paths. Linkage traversal and
placement are iterative, with work and storage linear in merge count.

## Annotations

Rules, regions, and text share one model (`marks/annotation.ts`): each
position is a constant (a number; times in epoch milliseconds) or a number or
time field. With constants only, the mark draws one item and reads no table;
when any position or its `textField` is a field, it draws one item per row of its
table. `label` is constant text and `textField` a category or number field
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
rebuilds neither the axes nor other annotations. Text with `overlap` places
labels greedily in row order, measuring each with the chart's text measurer
(`Frame.measure`) and filing placed boxes in a grid (`layout/label-boxes.ts`),
so each label checks only its neighbors; boxes too large for the grid, or far
outside it, are checked one by one. Each mark places its own labels. Moving
labels keep their given place when it is free and in the plot, else try
eight spots touching their point, nearest sides first, off the other rows'
points and inside the plot. Annotations have no series, so
they appear in neither legends nor tooltips; the chart's text alternative
lists them (up to ten items each, with positions formatted as in tooltips)
after the series summaries; in charts with panels, those every panel draws
once, then each panel's own (a facet panel's rows, a subplot's annotations)
after its name, up to twenty panels (`PanelLayout.annotations`), which the
keyboard also reads arriving in a panel. `Mark.geometry` receives the mark's key so their
geometry and buffers stay distinct per mark. In facets, an annotation over
a table draws, places labels among, and describes only its panel's rows
(see Small multiples). Fields must be numbers or
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
row subsets) as read-only views made for each draw, with `rowAt(k)` reading
a point's row through the series' row subset, and an optional `pointText`
writes their tooltip text. `zero` puts zero in the domain of the axis the
shapes stand on through the model's `Mark.zero`, as for bars: the model and
the navigator count it for marks with visible series, and for marks without
series (`Mark.seriesless`) always, and an axis' own `zero: false` wins.
Since the shapes between points are unknown, y extents take
in the points just past the view's edges (as for monotone curves) rather
than interpolating straight segments. With `series: false` (glyphs from
several fields of a row, such as ranges), or fields other than one x and y
fields, the fields only count toward the domains; such marks have no
series, and in charts with facets must repeat. A custom mark's spec holds its type, id, and the fields of its
series: functions cannot be serialized, so specs, and with them the Python
package, cannot contain custom marks, and the framework adapters rebuild them
whenever they render them again rather than comparing specs. Custom marks
implement the internal `Mark` interface as built-in marks do, with a spec of
only a type and an id (`MarkIdentity`); they are the supported way to add
marks (see The chart handle).

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
  ratio; point drawings hand clouds, and 3D charts' faces their batches, to
  the WebGL painter when one is loaded.
- `drawPdfPage` (`render/pdf.ts`) draws a scene into a PDF page; `renderPdf`
  wraps it in a one-page PDF 1.4 document. The default page is measured in
  points (0.75 per CSS pixel).

The optional public `renderToPDF` (`src/pdf.ts`, exported from `herceg/pdf`)
accepts one mounted chart, DOM-free options, or a nonempty list. It reads
mounted charts' current state during export and emits one chart per page;
subplots and panel titles provide several views on a page. Paper sizing in
`render/pdf-paper.ts` supports A4 and Letter in portrait or landscape, uniform
margins in points (36 by default), uniform scaling up or down to fit, and
centering. Chart-sized pages remain the default, with margins adding space
rather than changing chart scale. A chart-boundary clip follows the fitting
transform and encloses all painting, preserving the inner plot clips.
Transform numbers use fixed-point decimals; a factor that rounds to zero
is refused with a correction to reduce chart dimensions or margins.

Synchronous single-chart and list exports share orchestration and fitting
code, which normal tree shaking retains in single-chart bundles in this
implementation. The unified export vocabulary accepts this measured cost. The size harness includes one buffered `specToPDF` export
(`herceg-spec-pdf`) and an actual list export (`herceg-pdf-document`).

The internal `PdfWriter` in `render/pdf-document.ts` owns the PDF objects,
compressed streams, page references, structure references, and font IDs.
Each page has local font resource names, opacities, images, and shadings;
font objects are document-wide. Completed pages are serialized immediately,
releasing their scenes and uncompressed raster resources. Font programs and
Unicode maps are written only after all pages contribute glyphs, so each
face is subset once. Every export creates a fresh resolver; repeating an
export cannot retain glyph usage from another document. Document metadata
and each chart's alternative are separate: a report title never replaces a
visible chart title. Single-chart metadata (including a one-item list) defaults
to the chart's title, description, and locale. Multi-chart documents default
to English, with no default title or subject. Export settings override
`title`, `subject`, and `language`. A Figure's generated alternative has an
English language override unless the final catalog language is English;
its visible content uses a nested `/Span`
with `/Lang` for that chart's locale. `specToPDF` accepts one spec or a list,
including `{ spec, buffers }` entries whose binary indices are local to each
page. Python's `hg.to_pdf(chart_or_charts, **settings)` returns bytes and
`hg.save(chart_or_charts, path, **settings)` delegates a single chart to
`Chart.save(path)`, choosing its format by extension. Sequences require a
`.pdf` path and use the same writer, transporting fonts once and chart
buffers separately; other formats require saving each chart separately.
`Chart.to_pdf()` and `Chart.save()` remain single-chart conveniences.

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
shading. Without export-supplied fonts, text uses six standard PDF faces
(regular/bold Helvetica, Times, and Courier) with WinAnsi and exact Adobe
AFM advances. With `fonts: pdfFonts(sources, options)`, `src/pdf.ts` asks
the prepared `PdfFonts` object for an export-scoped `PdfFontResolver`,
passes its measurer into `model.scene()`, and passes the same resolver into
`renderPdf()`. Both layout and drawing resolve family,
weight, and coverage into glyph runs. Advances from `hmtx` are rounded once
at six decimal places in 1/1000 em and used identically in layout and `/W`;
no kerning or shaping is applied. The whole fallback string is anchored before
individual spans are positioned, including rotated text and halos. Cap heights
from OS/2 (hhea ascent when unavailable) replace the Helvetica assumption for
hanging/middle embedded text. Width-only layout cannot account for unusual
fallback ascents/descents; label truncation still cuts at code-point boundaries.

`render/pdf-truetype.ts` validates static sfnt TrueType `glyf` faces and
Unicode cmap formats 4/12 with table/glyph bounds and composite-cycle checks.
`render/pdf-font-subset.ts` rebuilds `glyf`, `loca`, `hmtx`, `cmap`, names,
checksums, and dependent headers after drawing, including `.notdef` and
recursive composite components. Measuring unused candidates does not collect
usage. The prepared object snapshots source descriptors and fallback lists and
borrows font bytes read-only. It is reusable; each document owns its parsed
faces, ordered-family cache (bounded at 256 entries), character-to-CID map,
and subset; there is no global parsed-font
cache. Fonts are limited to 32 MiB and registries to 64 faces. OS/2 tables
are checked against their version's minimum length, including legacy 68-byte
version 0 tables. OS/2 fsType restricted and bitmap-only embedding are rejected;
no-subsetting faces retain the full original program. Bitmap-only and
no-subsetting bits are ignored in versions 0–1, where they were unassigned.
Input table and whole-font checksums are intentionally unchecked: real fonts
often contain incorrect checksums. Generated subsets have fresh checksums.
CFF needs a separate CIDFontType0/FontFile3 path
and is refused, as are collections, WOFF, and uninstantiated variable fonts.

The writer embeds FontFile2 with Type0/CIDFontType2, Identity-H, `/W`, an
explicit CIDToGIDMap, and ToUnicode maps to original UTF-16BE scalars
and combining sequences (including surrogate pairs). Font descriptor flags
classify the embedded repertoire against Adobe's standard Latin set: characters
outside it set Symbolic and clear Nonsymbolic, while fixed-pitch and italic bits
are preserved. Whole-font embedding classifies the full Unicode cmap repertoire.
Identity-H codes are CIDs, not Unicode; aliases
of one glyph receive separate CIDs. Registered CSS family names (including
quoted and generic names) and the explicit fallback list determine coverage,
with an entire extended grapheme cluster kept in one face. Simple accents use
NFC precomposition: the face must cover the source scalars and the composed
glyph, while ToUnicode preserves the original sequence. Other combining
sequences are refused because unpositioned marks can render incorrectly.
Clusters use `Intl.Segmenter` when available in browsers, Node, or embedded
V8. MiniRacer 0.14.1 provides it. Without it, conservative grouping appends
Marks, `Grapheme_Extend` characters (including the Lm halfwidth kana voiced
and semi-voiced marks U+FF9E/U+FF9F and variation selectors), emoji modifiers,
and ZWJ plus its following scalar. Ordinary spacing modifier letters remain
separate. This fallback covers admitted text; it is not a full implementation
of [Unicode extended grapheme segmentation](https://www.unicode.org/reports/tr29/).
Unsupported sequences are refused before coverage or replacement in both paths.
Halfwidth kana clusters use one face and one advancing glyph per scalar, with
distinct CIDs and extraction scalars. NFC-composed glyphs preserve the entire
original cluster in ToUnicode. Replacement emits one scalar per uncovered
cluster and must itself be an admitted standalone scalar.

Text admission uses an allowlist rather than a list of scripts to refuse:
Latin, Greek, Cyrillic, Armenian, Georgian, Han, Hiragana, and Katakana by
Unicode `Script`; Hangul only as precomposed syllables U+AC00–U+D7A3.
Common/Inherited scalars must fall in the following selected ranges and have
`Script_Extensions` intersecting those scripts or remaining Common/Inherited.
Primary-script Common/Inherited alone does not authorize a character; for
example, Arabic shared punctuation and Vedic marks remain unsupported.
[Unicode Script and Script_Extensions](https://www.unicode.org/reports/tr24/)
distinguish these shared characters from unrestricted punctuation.

| Common/Inherited purpose | Inclusive ranges |
| --- | --- |
| Basic punctuation, digits, Latin-1 symbols | U+0020–007E, U+00A0–00FF |
| Spacing modifiers and combining accents | U+02B0–02E4, U+02EA–036F, U+1AB0–1AFF, U+1DC0–1DFF |
| Punctuation, superscripts, currency, mathematical, technical, enclosed, geometric symbols, dingbats | U+2000–27FF, U+2900–2BFF, U+2E00–2E7F |
| CJK punctuation, shared kana signs, annotation, strokes, enclosed and compatibility symbols | U+3000–3030, U+3036–303F, U+3099–309C, U+30A0–30FF, U+3190–33FF |
| Modifier tone letters and small form variants | U+A700–A711, U+A717–A71F, U+FE50–FE6F |
| Fullwidth and halfwidth forms, excluding halfwidth Hangul | U+FF01–FF9F, U+FFE0–FFEE |
| Tai Xuan Jing symbols and mathematical alphanumerics | U+1D300–1D37F, U+1D400–1D7FF |
| Mahjong, dominoes, cards, enclosed symbols, pictographs, individual emoji, legacy computing symbols | U+1F000–1FAFF, U+1FB00–1FBFF |

These ranges never override script, category, or cluster checks. All other
scripts, private-use and unassigned scalars, surrogates, controls (including
all format controls), line/paragraph separators, default-ignorable characters,
and emoji modifiers are refused. This includes Egyptian layout controls and
Sidetic even in runtimes whose Unicode tables predate those assignments, and
the contour tone letters (U+02E5–02E9, U+A712–A716), which ligate, and the
vertical kana repeat marks (U+3031–3035), which need vertical layout.
Admission follows the runtime's Unicode property tables: an older runtime
refuses characters it considers unassigned, including inside an allowed block.
New scripts are refused automatically. Marks must NFC-compose to one admitted
non-Mark scalar; other mark positioning remains unsupported. Hangul Jamo,
halfwidth Hangul, Braille, vertical presentation forms, and ideographic
description operators are outside the allowlist.
Composite glyphs require first-component XY placement, mutually exclusive
transform flags, and valid attachment indices in the accumulated parent and
expanded child outlines, including their four phantom points.
Composite resources are bounded to 64 nesting levels, 4,096 direct components,
65,536 expanded component instances, 65,535 expanded points/contours per glyph,
and 262,144 component references per font. Missing coverage is
an error unless a covered replacement scalar is explicitly supplied. Text
outside the allowlist is refused with its code point; coverage cannot substitute
for shaping or ordering. Emoji modifier, flag, tag, and
ZWJ sequences are refused before fallback or replacement. Joiners and variation
sequences are refused too.

`PdfOptions` accepts `fonts?: PdfFonts` outside the portable spec;
`PdfExportOptions` carries paper, margins, title, subject, language, and fonts. `specToPDF`
takes these document settings separately from the spec. `pdfFonts(sources, { fallback?, missingGlyph? })` carries the
resolver factory and embedded-face writer. `renderToPDF` and `render/pdf.ts`
import these implementation types only; `pdf-document.ts` calls a face's
writer through the document's `reserve`/`object`/`stream` interface, without
importing the subsetter. Unicode matchers are pure regular-expression constants,
so unused re-exports do not retain font code in bundles. Plain PDF exports
bundle no parser, resolver, subsetter,
or binary font helpers; importing and using `pdfFonts` includes them. The
`herceg-pdf` and `herceg-pdf-fonts` size entries track both paths, excluding
supplied font programs. Python reads family-to-path/bytes mappings in
`_render.py`, checks face counts and byte lengths before transport, bounds each
path read to 32 MiB plus one byte, transports font bytes as base64, and decodes them in
`python/js/static.ts`, which calls `pdfFonts` with Python's unchanged
fallback/replacement options; this adds temporary byte/base64 copies.
Parsing and subsetting add
no runtime dependency and are bundled only when `pdfFonts` is used, never
through the core chart entry or a plain `specToPDF` export.
The PDF's measured layout may differ from static SVG's estimates.

Both font paths produce tagged PDF. `src/pdf.ts` combines the chart title
and `describeChart(model)` for the Figure's UTF-16BE `/Alt`, preserving the
DOM's generated summary even when standard fonts replace visible Unicode
glyphs. The catalog has `/MarkInfo << /Marked true >>`, `/Lang` from the
document language, and a `StructTreeRoot` whose single `Document` contains
a `Figure` per chart in page order. The Figure's `/Pg` identifies the page and `/K 0` identifies the
drawing's `/Figure << /MCID 0 >> BDC` sequence. Page i's `/StructParents i`
selects the ParentTree's `/Nums [i [figure-reference] ...]` entry; each
array's index 0 maps that page's MCID 0 back to its Figure. The structure
root's `ParentTreeNextKey` equals the page count. Backgrounds and grid lines precede
the figure in `/Artifact BMC` content. Labels, legends, and annotations stay
inside the figure, including label halos' existing replacement-text spans.
Facets and subplots share one Figure because they form one chart with a
shared title, legends, and description of the panels; splitting them would
require separate panel alternatives rather than repeating the chart summary.
This is chart-level tagging, without PDF/UA conformance or separate label
semantics. The generated summary's prose is English and the Figure is tagged
with `/Lang (en)` unless it inherits an English locale from the catalog;
`locale` controls number and date formatting, without translating the summary.
Python's chart and document `to_pdf` methods receive the same tags through
`specToPDF`.

Streams are Flate-compressed by a small built-in deflate (fixed
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

With `animation`, a view asked for (`setViewport`, zooming to a brush,
double-click reset) is shown gradually, by `dom/transition.ts`,
which a chart loads the first time its options ask for animation (until
then, views change at once). The model's viewports
take the new view at once, and the `viewport` event reports it once. The
chart keeps a transition: the ranges drawn when it was asked for, and, from
its first frame, the ranges it ends at. Those are planned by building the
scene of the new view, which is never painted, so they include nice rounding
and room for glyphs. Each frame then sets the model's transition domains,
eased and in log space on log axes. The model draws these as given, and every
frame is an ordinary scene, so tooltips and brushes read what is on screen.
Anything that must show at once ends the transition at the new view: table
changes, resizes, option updates, legend toggles, wheel zoom and panning,
presses, `render()`, and export. Charts with several panels, linked charts,
and pages preferring reduced motion skip it.

Animation should not cost dashboards frames, so the chart estimates frame
costs from the JavaScript time of earlier frames (paint and compositing are
not counted, and earlier frames only suggest the next). Transitions whose
first frame falls on the same scheduler frame form a batch, which jumps
before planning when twice its charts' last frame times add up to over 10 ms
(the first frame builds two scenes); retargeting a chart replaces its share.
A playing transition ends once its chart's frame, or the scheduler's whole
frame, takes over 10 ms. Intermediate frames keep the margins planned for
the new view, so passing tick labels never move the plot.

With `animation: { values: true }`, `dom/value-transition.ts` (with
`value-motion.ts`, `value-points.ts`, and `value-traces.ts`), which a chart
loads separately the first time its options ask for it, also moves marks to
changed values, and the axes with them. The data is current at once; what
moves is a picture of the change, made from the geometry of the scene on
screen and of the next. Scenes of such charts carry what identifies each
item: bar geometry carries `BarItems` (each bar's position along its axis, a
band index or the value, and its root and tip in pixels), point geometry
`PointItems` (the table, its generation, and each point's row identity,
`rowOffset + row`, or an explicit `animationKey` field and its values), and a
pie's sectors `PieSlices` (its slices in order,
where each ends as a fraction of the turn, its size, and a function that
draws other slices as the pie draws its own, leaders and labels included).
Marks of other charts emit none of them. Every traced polyline says whether
it is `whole`, a point for every row traced, none left out by level of
detail, a missing value, or a break; and each panel the model reports keeps
the plans of its axes (`PanelPlans`), whose continuous plans carry the
context and tick count they were planned with. The lazy module imports no
engine code of its own: the chart hands it `planAxis`, `Polyline`, and
`monotonePolyline`, since
esbuild would otherwise move the modules both import into chunks of their
own, which compress worse than the bundle they come from.

When a table reports a change of values in place or a reset, the chart copies
the bars, slices, points, lines and areas traced whole, and rules of the
frame on screen, in pixels, with the panel whose scales drew them, because
the model reuses geometry buffers for its next scene (and the table has
already changed, so old values can no longer be read from it). The next
frame builds the new scene once and matches the copy to it: bars by series
key and position (a series repeating a position has no identity for its
bars, and shows its new values at once), points by series key and row
identity within one table generation, or by equal explicit keys when both
scenes name the same field and kind. Numeric keys reuse the row identity
`Float64Array`; category keys capture label string references at geometry
time, independent of dictionary recoding. Snapshots copy these arrays along
with positions. No per-point objects or interning are used. Temporary maps
and sets match primitive keys in the lazy `value-points.ts` module; it imports
no runtime code from initial modules. Finite numbers match without coercion
(`-0` equals `0`), category labels match as strings, and time keys use their
numeric values. Missing or duplicate keys in either rendered series make
that series show its new values at once, with no row fallback; moving axes
make the whole change show at once. Keys do not affect selection or table
row identity. The per-frame point bound includes retained points, entrants,
and exits across the whole chart.

Lines and areas match by series key when both scenes trace them through the
same x pixels in the same runs (rows at one x are one point of a line,
whichever rows of the table they are, so a reset that keeps x moves too).
Horizontal and vertical rules match by key, and slices by key, in one order
merging both pies'. Each scale that both scenes
draw with the same type and range, and with continuous domains in the same
direction (bands and broken time axes must be unchanged), moves from its
domain before to its domain after, evenly in what it maps linearly (log10 on
log axes). With domains `D(t)` between, something drawn at `p0` before and
`p1` after is drawn at `r0 + a(p0 - r0) + b(p1 - r0)`, `a = (1 - t) S0 /
S(t)` and `b = t S1 / S(t)`, where `S` are the domains' spans and `r0` the
range's start: that is the value between, `(1 - t) v0 + t v1` in mapped
terms, placed by the scale between, without reading data again. Items
that appear start where their value would have been before; items that go
end where theirs is after. Later frames draw the new scene with its marks
interpolated and, for moving scales, axes and grid lines planned anew with
`planAxis` from the scenes' plans: the domain and the part ticks are chosen
in (before room for glyphs) both between, the same tick count, and labels
formatted together, so a frame's ticks are those the chart would choose for
its domain (the tick step may change on the way) and its first and last
frames match the scenes. Frames are eased as views are and build no scene.
Bars move their roots and tips rather than their tops and heights, so a bar
changing sign shrinks to the baseline and grows past it, with its rounded
end at the tip; slices move their widths, so neighbors share a boundary and
the slices make a whole turn throughout; points move their centers, encoded
radii, opacities, and color-ramp positions (the scenes' palettes must hold
the same colors), and grow from or shrink to nothing as rows start or stop
being drawn; lines and areas move each point, an area's baseline (zero on
the moving scale, inside the plot), and both edges of bands and stack layers.
Monotone curves are curved again each frame through the points between, so
they never pass a point's value between two points: a line's or an area's
alone with `monotonePolyline` (which the chart passes in too), and a band's
or stack's layers together with the joint curve their mark attaches to its
keyed geometry (`AreaGeometry.curve`, trace.ts `curveLayers`), so edges two
layers share stay one edge and layers never cross. A mark's areas move
together or not at all: a layer that cannot move (a missing value, say)
keeps its neighbors at their new values too. Items that appear or go are
drawn as geometry only: the model, tooltips, the keyboard, events, and
summaries have the new data from the start.

A change moves only when both scenes have one panel with the same key, plot,
and theme, scales that can move between them, the same series of bars,
points, lines, areas, and rules, and retained slices in the same order. When
any scale moves, every geometry in the panel must move with it (marks that
cannot, such as stacked or labeled bars, text, heatmaps, custom marks, or a
line whose x positions changed, would stand apart from the axes), and lines
and areas need x to stay; otherwise the change shows at once. With scales
that stay, marks that cannot move show their new values while the others
move. Margins grow at once but shrink only on resizes and option changes, so
a change whose labels need more room shows at once and the next moves.
Appended and dropped rows, row views' changes, changes under options or
hidden keys other than those the scene on screen was drawn with, changes
while values move and until the data has been still for a change's duration
(so streaming charts do not animate forever; a derived aggregate, recomputed
on each change of its source, moves only on changes that far apart), and
charts that are inspected, off screen, linked, slow (as for views, counting
the copy), or whose endpoint scenes draw more than 2,000 bars, slices, and
rules, 10,000 points, or 10,000 points of lines and areas, or any point cloud,
show at once too. Snapshots check these endpoint counts before copying.
Matching then counts point exits and checks the combined 10,000-point budget
across all series, including points that show at once. With fixed axes, some
series can animate while others show at once to keep within that budget;
with moving axes, an unmatched series makes the whole change show at once.
One transition plays
at a time: a view asked for settles values first, and a table change ends a
change of view. Pointer moves, presses, and keys settle values, dropping a
copy not yet moved from and drawing the new scene (axes included) before they
inspect it, and a change under the pointer, a press, or the keyboard cursor
shows at once; the wheel zooms from the model's scales, which are the new
scene's throughout. After a settle that dropped anything, what is on screen
may be a frame between two scenes, so changes show at once until the next
scene is built; `render()`, export, and static output always draw the new
values, and destroying a chart lets go of what it was moving.

Preparing a change copies and matches the items: about 0.03 ms for 100 bars
and 0.2 to 0.3 ms for 2,000 in Node, 0.1 ms for 1,000 points and 0.9 ms for
10,000 (matching rows through a map), and 0.02 ms for a 2,000-point line. In
Chrome (one-off runs outside the benchmark suite: headless Chrome 154 on an
Apple M6 at DPR 1, with other work on the machine; means over 14 changes of 12
frames each), each later frame takes about 0.2 to 0.7 ms of JavaScript for 10
to 2,000 bars (1.6 ms for 2,000 in a busier run), 0.05 ms for 20 bars with a
moving axis, 0.3 to 0.9 ms for 5 to 100 slices, 0.2 to 0.6 ms for 1,000 points
(the most for translucent points, which SVG draws one by one) and 0.5 to 0.6
ms for 10,000 (on a canvas), and 0.2 ms for a 2,000-point line (in a chart
2,400 pixels wide, which draws it whole), against 0.2 to 0.8 ms for the frame
that draws such a change without animation. In real time (frame intervals
over 8 changes, counting the frames between two scenes to confirm the values
moved), 0 to 6 of 200 frames took over 20 ms (up to 34 ms) while 1,000 to
10,000 points moved, against 0 to 7 when the same changes showed at once; at
3,500 translucent points in SVG, whose markup is parsed again each frame,
about half the changes ended early for slow frames. The limits come from
these: 10,000 points take less JavaScript a frame than the change drawn at
once, and the copies and frame buffers of a change hold about 40 bytes a
point (56 with sizes), 28 a point of a line, and 76 a bar, released when it
ends. Marks bound each series alike before keeping anything for it, so a
larger series costs nothing. Pies place their
labels again each frame: 0.5 to 0.9 ms for 500 slices and 2 to 3 ms for
2,000, still less than the frame that draws such a pie's change at once (up
to 2 and 7 ms). Charts without `values` measure the same as before the
feature in interleaved runs.

Charts that set the same `interaction.sync` name share the cursor x and the
viewport (charts whose panels have x scales of their own, the cursor only). Charts inspected along y (horizontal bars) measure values on x, so
they neither share nor follow the cursor; linking them by category is not
supported.

## Identity and color

Each series has a key built from its mark's `id` (or index) and its source
(a y field or a category) as JSON, so no combination of names can collide.
Keys identify legend state, geometry buffers, and colors. Palette slots are
assigned to keys the first time they appear and kept for the chart's
lifetime, so a series keeps its color when others appear, disappear, or are
hidden.

Marks naming a `legendGroup` share series by name across marks (a bar and
its error bars, a line and its band). Each series keeps its own key, which
geometry buffers, caches, inspection, and the keyboard use, so two marks
never write into each other's buffers; the group adds a second identity, a
legend key of the group and the series' name (a JSON object, which names no
mark), which takes the palette slot, the one legend entry, and the
visibility. The model maps each grouped series' key to its legend key as
series resolve (`HiddenKeys`), so a series counts as hidden when its key or
its group's entry is: everything that reads visibility by series key sees
the group's state without knowing about groups. The palette callback registers
membership before marks stack their series, including series with explicit
colors, which take no palette slot. Scenes retain independent visibility
snapshots. Marks that dodge prepare and share a roster of visible group names
on demand, using the original snapshot when selection highlighting splits a
series.

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
The named themes paint backgrounds of their own (light white, dark
`#12151c`), so a chart reads the same on any page and in every export;
`"auto"` resolves to light or dark with a transparent background, since it
is drawn to match the surface under it. The SVG layer, the canvas (when it
holds the marks), and static SVG and PDF paint the background; PDF pages
are white, so the PDF writer paints a transparent theme with light text in
the dark surface `surface(theme)` assumes. Text halos take the background
where text contrasts with it, else white or black against the text.

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
values are each reachable. The other series are read at the first point
each draws at the cursor's x, except where a mark pairs rows of its series
(`Mark.alongside`): at an x where a layer of a series field's area stack
has several rows, the stack's other layers are read at the same one of
theirs, in row order, and left out where they have fewer.

A press on the plot becomes one of three gestures once it moves 3 px: a
brush (with `interaction.brush`), a pan (with zoom only, or Shift with
both), or nothing; a press that does not move is a click. A brush selects a
range along x or y, a rectangle ("xy"), or a lasso (its outline, thinned
past 400 points); rectangles and lassos need 3 px each way. A selection is
kept in data values, so it stays on its data while the chart zooms or
resizes, and drawn in the pointer overlay, clipped to each plot. The chart
keeps the selection and its rules (`dom/brushed.ts`); the drag and its
drawing (`dom/brush.ts`) load with a dynamic `import()` when a chart can
brush or first has a selection to show, so charts that never brush carry
none of it, and a press made before it arrives drags once it has. When zoom
is on along every axis a selection has a range on, releasing the brush (or
Enter, for a selection made with the keyboard or received from a synced
chart) sets the viewport instead; lassos never zoom. Synced charts share
selections as data values (category indices on category axes), each drawing
them on its own scales, so charts sharing a selection should have the same
axis types and category order. Shift with the arrow keys selects a range
from where the keyboard cursor started, along the axis it steps along (x for
lines and vertical bars, y for horizontal bars): with brushes along that
axis, and with rectangle and lasso brushes, which only the pointer draws.
With `rowSelection` taking brushes, a brush selects rows and never zooms.
The live region announces selections made with the keyboard and the
pointer.

With `tooltip.axisLabels`, the overlay also labels the crosshair on the
axes: the inspected value on the axis it follows, and for the pointer, its
position on the other axes (both y axes when there are two) across a dashed
line. The labels live in `dom/axis-labels.ts`, loaded the first time a
chart asks for them, which imports no code of its own so that loading it
moves nothing out of a chart's bundle.

Tooltips write values with their axis' `tooltipFormat`, else its
`format`, the formatter `formatValue` and the keyboard read too. A mark's
`tooltip.fields` name more fields of the rows its points are: marks check
them against their tables when they are made (`marks/tooltip-fields.ts`),
and inspections carry them, read from each point's row, as `fields` on the
point, which the tooltip draws under the point's row and the live region
reads after its value. Reading and writing them (`dom/tooltip-content.ts`)
loads the first time a chart has fields or `renderTooltip`: the chart sets
the model's `fields`, which makes a reader per panel for its inspector (and
the layout marks' item views) in the chart's locale and zone, with the x
axis' formatter for times on time axes, and replaces the tooltip's `show`
with one that draws the fields and `renderTooltip`'s content. Like the
crosshair labels, the module imports only types, writing with `Intl` itself.
Inspections without the reader (before it loads, and in static rendering)
have no fields. Content of the application's own is asked for when what the
tooltip is at changes (compared as JSON, with the theme and the renderer),
and a resize observer places the box again as it changes size, so the
adapters' frameworks may render into the node they hand back after the
call: React through a portal from a component of its own state, Vue
through a teleport, Svelte into an element of its markup, each rendering
only the tooltip's content.

Charts emit `viewport`, `select`, `hover`, `click`, `camera`, `drill`,
`itemMove`, `visibility`, and `render` events. Each reports changes only (hover compares the inspected
values; `render` follows frames that draw the data, not those that only move
the cursor), and a listener that throws is reported without stopping the
others or the chart. Hover listeners
receive inspections even with the built-in tooltip off, which is how an
application draws its own.

Every change of view (a public `setViewport`, a wheel step, a pan move, a
brush zoomed to, a double-click reset, a synced chart's range) runs in one
`#changeView` call: it snapshots each x scale's viewport and the y viewport,
makes the change, then emits one `viewport` event per x scale whose view
changed, with all three ranges, after the change is complete. Listeners may
change the view again; their change reports itself, and the outer call skips
x scales whose view a listener's change already reported. An `update` that
gives panels y scales of their own reports the y viewport it lets go of.
Only changes that set x share the final x range with synced charts; y
ranges are not synced.
`setViewport` checks a whole change (an x range without a panel where
panels have x scales of their own, y ranges where panels have y scales of
their own) before it changes anything.

### Layout controls

Layout marks are navigated by controls of their family: 3D charts turn
(`dom/orbit.ts`), maps pan and zoom (`dom/map-controls.ts`), treemaps and
sunbursts drill (`dom/drill.ts`), and networks' nodes move
(`dom/node-drag.ts`). A mark names the controls its options turn on
(`LayoutMark.controls(config)`, a kind and the sentence the chart's
description adds about its keys) and what of `interaction` it takes
(`LayoutMark.interactions`: `zoom: true`, a map's plane, which takes "xy"
too, a lasso, `drag`), which `ItemViews.interactions` checks, refusing the
rest with what the option does elsewhere. The DOM chart has one path for
all of them: it loads `dom/layout-controls.ts` with one dynamic `import()`
when its marks ask for controls, which loads each family's module once
(subplots of trees and maps load both) and mounts it with a host
(`dom/controls.ts`: the chart's handle, its model, the pointer overlay,
announcements, a redraw, the legend, and where the keyboard cursor is: its
panel and its item). Each family acts on its panels: the pointer in the
panel it presses (a drag keeps the panel it started in), the keys in the
cursor's panel, a toolbar per state (one in the chart's corner for a
chart's one or its facet panels', one in each subplot's corner otherwise,
named with the subplot's title), and breadcrumbs over each tree's path (of
trees sharing a root, the first panel's take the Tab key and screen
readers, the others the pointer only). The optional `ItemViews` runtime owns the active controls,
their pending import, and their latest scene through a portable lifecycle
interface; it contains no browser imports. Controls of another kind, or of
a chart destroyed or changed while they loaded, are disposed. Promise
identity rejects obsolete imports even through a switch back to the same
family. Layout item state is available before the first scene, so option
updates can start loading controls immediately, including when an axes
chart becomes a layout chart; `Chart.loading` includes that import. Controls listen on the chart's root themselves, their keys
in the capture phase ahead of the chart's (they
take Shift with the arrows, plus, minus, 0, Enter, and Backspace, and stop
those they act on), and change the chart through its public methods
(`setViewport`, `setCamera`, `select`) or, for drills and node moves, the
same item state the public `setDrillRoot` and `setItemPosition` change,
reported through the chart's `drill` and `itemMove` events by an optional
item-change sink. Programmatic setters connect that sink synchronously,
even with gestures disabled; loaded controls connect it for gestures.
Reconciled roots are reported before the frame's hover and render listeners.
Each command starts from the pending state (the viewport, drill root, or
node position asked for, drawn or not), so presses faster than frames add up, and node
moves name the layout they were made in, so one made on a network whose
data changed and is not yet drawn again is dropped rather than misplaced. A
drag owns its pointer (captured) and is no click once it moves 3 px, which
the chart's own press tracking sees too. They share a toolbar
(`dom/toolbar.ts`) of named buttons, focusable while hidden.

The controls lifecycle and item notifications live behind the optional
item runtime, so ordinary line charts carry only the public setters and
small bridges for loading, drawing, and events. Esbuild metafiles attribute
the initial growth from layout interaction to 355 minified bytes in
`dom/chart.ts` and 81 in `model/model.ts`; the family implementations were
already outside the line entry's initial chunks. With the lifecycle and
notifications moved, the line entry is 50 B gzip above `4fe2634^`, before
layout interaction (43,811 to 43,861 B), measured with unchanged
`npm run bench:size` settings. Buttons retain their own presses, and a click
on an item representing none of the bound rows retains the brush. Controls
remain lazy chunks loaded one family at a time, with a shared router and
toolbar; map controls also load the brush that draws their lasso. The line
entry's reachable lazy chunks total 31,946 B gzip, 17 B more than before
the trim. Making item state available before drawing adds 14 B gzip to
each PDF entry through the shared model, preserving immediate controls
loading when charts change family.

An inspected point carries its identity: the mark's index in the chart's
marks (each panel's inspector is given the index of every mark it inspects,
since subplots inspect some marks only and one mark object may be listed
twice) and `id`, the series key, and the row of the mark's table, which is
`rowOf(series, position)` for every mark whose series index table rows.
Marks whose series index rows of a summary (histograms, box plots, violins)
say so with `summarizes`, and their points have no row. Layout items carry a
row where one row is the item (gauges, radar points, map shapes and points);
a map of several layers tags its items with the layer's index. Building an
inspection costs three more fields per point and one map lookup.

## Selected rows

A chart's `rowSelection` binds it to channels of selection stores, one per
table its marks read (`model/row-selection.ts`). The binding is an object
made by `rowSelection()`, as facets and navigators are, so the code comes
only with charts that import it: a line chart that binds no store carries
the hooks that call it (about 150 B gzip). The model calls the binding's
`check` as it validates (layout marks other than maps, trees, and
networks refuse one, alone or in panels, as do 3D marks; so do
stores of tables no mark reads, and brushes or lassos over summaries'
statistics), and the mounted chart calls `mount`, which gives it a
`RowLink`: the store subscriptions, what the chart's gestures wrote, and the
model's `highlight` hook (and `layoutHighlight`, which gives layout marks a
table's membership). The chart calls the link where its gestures end: a
selection set by the pointer, the keyboard, or `select()` (not one a synced
chart sent, which would write another chart's selection again, nor one set
with `rows: false`, which notebook widgets use to show one view's brush in
the others, since the views share their stores, and for brushes Python
sets, which draw without selecting rows; such a selection replaces the
brush, so the link no longer clears what the brush wrote), a click
(before the brush is cleared, so a click writes once), a brush the chart
lets go of because its panels are gone (its rows go too, from channels
that still hold them), and the brush's zoom test, which a brush that writes
rows never passes. The link listens to the
chart's keys itself for Space and Escape, after the chart's own handling;
Space draws pending changes first (`render()`), so it selects what the
cursor shows. A link that replaces another (a new binding of the
same channels, as adapters' props change) takes over what its brush wrote,
and the check of a change the old link had pending.
Writes nest: a listener may replace what the chart just
wrote, so the link checks once the outermost write is done whether any
channel still holds its brush's rows. After another writer's change it
checks a microtask later, once the change has been reported, so a view
that shows the writer's brush (with `rows: false`) has let its own go and
does not clear the brush it now shows.
Everything in the model directory stays free of the DOM: the link reads the
chart through a structural interface.

What a gesture selects is `model/selected-rows.ts`'s, from what the last
scene drew (rows a mark does not draw, by `Mark.shows`, a band, an axis
break, or a value its scale cannot place, the low end of a range or of a
stacked area too, are never selected by lassos, clicks, and keys, and a
stacked area's zeros on a log axis are where it draws them, at the low end; points are clicked within
their own glyph's reach, `Mark.reach`): the panels' series (`panelSeries`), their marks (`markOf`), and
the panels' scales. A range brush becomes, per table, the disjunction over
the marks drawn in its panels of each mark's condition: per series reading
(a mark's y fields are its series), the conjunction of its places along the
brushed axes being in range (a field's value, or a span overlapping it), with
category ranges listed by the bands' values (`c:` keys are labels, `n:`
keys numbers or times), joined by the shown series of a series field, a row
view's filter, and the facet panels the brush covers when it covers only
some. A y range is read on a right axis through the same pixels, panel by
panel where panels have right axes of their own. A stack brushed along its values is selected by its drawn tops, as rows,
as is a point mark over a view restricted to a row set (which no condition
says), and then the table's other marks' conditions are evaluated into the
same row set. Summaries take no part in lassos or in brushes along their
statistics, whichever way the selection was set. Lassos test each row's anchor (bars' through the bar mark's own
placement, `BarMark.placement` and `ends`, so grouped bars are found where
they are drawn) against the outline in pixels, after its bounding box.
Clicks find the topmost mark's point under the pointer: a bar or histogram
bin containing it, a box, violin, or cell picked at distance 0, or the
nearest anchor within the mark's reach plus a few pixels (a binary search
window on sorted series). Points summarizing rows give their rows through
`Mark.summarized`, a test of a table row (a bin's exact edges and its series,
a group's category and series value with a value), evaluated over the
table's rows (or the view's) of the clicked panel; a summary's index is
never taken for a row. Results are computed for every table before any
channel changes.

Highlighting (`model/highlight.ts`) replaces a mark's geometry through the
model's hook while the mark's table's channel holds a selection (a row set
of an earlier generation is none), and only for points, bars, lines, and
areas. Membership is a byte per table row, kept per table and selection
object (in weak maps, so charts showing one selection share it) while the
table's version and, for row sets, the set's own `version` are the same;
when the table only appended or dropped rows (`modifiedVersion` and
generation unchanged), kept rows keep their bytes and only appended rows are
tested, so a live condition over a rolling window costs the new rows. What
is made from a membership (series' rows split by it, values masked by it)
is kept in weak maps keyed by the membership first, so it goes with it.
Points and bars draw twice through the mark's own geometry, once for each series cut
down to its unselected rows (dimmed: `fillOpacity` times 0.25, translucent
so overlaps darken as other translucent points do) and once to its selected
rows, under keys of their own (`\u0001off`, `\u0001on`) so they draw into
buffers of their own; the list keeps every series, so grouped bars keep
their slots, and frames say `keyed: false`, so value transitions do not
take the parts for new items. Lines and areas draw whole and dimmed (a line
through a wrapper of its drawing that multiplies the canvas' global alpha
and adds an SVG `opacity`, an area's fill at a fraction of its opacity and
its outline as a dimmed line, since areas paint the outline opaque), clipped
to the plot outside the pixel spans of each series' runs of selected rows,
and the same geometry as drawn clipped to the spans (from a run's first row
to its last in x order, ascending, merged where they touch, at least a pixel
wide, across the plot's height: an SVG `clipPath` of rectangles, or a canvas
clip; a run ends at its outermost rows the mark draws through, by the rule
it draws by: x, y, and a range's or a stack's lower end placed, a stacked
area's zeros at a log axis' low end, rows inside axis breaks hidden, and for
a layer drawn through its stack's edges x alone, since the edges draw what
is there; a run goes on across rows a break hides, as the line joins the
rows either side, and keeps rows inside it the line breaks at, since the
caps either side are within its span, so only runs' ends are placed; a run
that ends a path reaches half the stroke width further, over its round
cap), so each pixel is painted once and the highlighted part is the very
curve, level-of-detail reduction, and stack the mark drew; a layer of a
series field's stack, drawn through the union's edges, reaches the union's
ends past its own first and last rows. A line's runs of one row drawn are
dots. Lines whose x does not ascend, and rows at one x that no span tells
apart (a vertical run of selected rows, or other rows drawn at the x where
a run ends, past rows the line breaks at), draw whole and dimmed with
a copy of their values over them, the unselected rows' missing, drawn at
the opacity that over the dimmed drawing of the same color shows its own:
`(1 - 0.25) a / (1 - 0.25 a)`, `a` being the color's own alpha (read from
hex and functional CSS colors; others count as opaque) times the mark's
opacity, an area's fill and outline each so, series by series in the
mark's order and an area's fill before its outline, as the mark paints
them. Point series large enough for
the GPU painter would fall to the CPU if split, so they draw as two clouds,
of their unselected and selected rows, so each point composites once; each
part streams as its cloud does (`PointCloud.stream`: a key per cloud and
part, the rows it has lost from its front, and an epoch that changes with
the selection, the generation, or values changed in place), since under one
selection a part only loses rows from its front and gains them at its end,
and the painter appends to its upload; parts are kept in weak maps by
selection, then by their cloud's stream key, so a selection's parts go with
it. Dimmed points' rings dim too. Highlights belong to the mounted chart:
static exports from options draw every row.

In a chart of one map, tree, or network (`LayoutMark.selects`), what a
gesture selects is the mark's to say: its drawing (`LayoutResult`) gives
the rows of a table an item stands for (`rowsOf`: a region's or a point's
row; a tree node's, by a pass over the rows testing their node against the
node's subtree, marked once per click; a network node's rows of the nodes
table, and a link's rows of the links table, by a per-row link index the
network keeps), and a lasso's rows (`lassoed`, an outline in pixels, from
the selection's plane coordinates through the map's scales), resolved by
`selected-rows.ts` for the item under the pointer or the keyboard. An item
standing for no row of the bound tables (a map layer of another table)
makes a click change nothing, the chart's brush or lasso included, rather
than clear them as a click off the data does. Layout marks
highlight through their frame (`LayoutFrame.selected`, the table's
membership byte per row), drawing what the selection leaves out dimmed
below the rest as separate geometries: regions and points, tree nodes none
of whose rows (counted per node, its own and its subtree's) are selected,
with "n of m rows selected" in their items' text, and network nodes and
links. Where items overlap (a map's), the pointer finds the one drawn on
top, the selected one; the keyboard reads them in row order all the same.

Payloads: `select` and `click` events carry what the gesture wrote, and
`rowSelection` events every change of a bound channel, from any writer
(each change once: the link compares the channel's selection object). The
Python widget numbers rows as Python does: its snapshot gives, per bound
table, the rows dropped since the last replace and the replaces so far, and
the browser reports a row set's identities as that count plus its own
`rowOffset` plus the position (`generation` 0, the snapshot's table) and the
generation as Python's count plus its own, so Python maps them to positions
in its data now whatever was appended or dropped since, and drops reports of
an earlier generation, and reports made before a change it has not seen
(each report carries the revision it was made at, as selections and
viewports do). Python sets rows by position, which the browser applies in
order with Python's other changes, and keeps its positions on their rows as
`append` drops rows from the front; a `replace` lets row selections go. Streamlit remounts a chart
when its payload changes, so its positions are qualified by a digest of the
payload's data instead: a run that changes only how the chart looks keeps
the digest, and the new chart's stores take the rows clicks and lassos
selected, at the same positions; what the brush wrote (a condition, or a
stack's rows) comes back only with the brush, where it can be kept, and the
script hears when it could not: after a redraw, each channel is reported
unless it holds what was last sent, of the same data. Conditions Python sets must test columns the chart
sends (a binding's `fields` adds columns its marks do not read); the widget
refuses others before changing what it holds.

## Accessibility

- The chart root is a focusable `figure` named by the title, described by a
  generated summary (series count and, per series, point count, range, and
  last value; marks such as heatmaps, histograms, points on a category y
  axis, and layout marks write their own), followed by what color scales and size and shape keys show,
  since their legends are drawn. It is refreshed at most once a second,
  does not repeat the title, and its element is hidden, so it is read once,
  as the figure's description.
- A range navigator adds its overview of the whole x range and formatted visible range,
  and its control of every panel's x in multi-panel charts, to this summary.
  The window's sentence participates in the refresh key; panning does not
  write it into a live region. Navigator sliders announce their changes
  separately through their own polite live region.
- Arrow keys, Page Up/Down, Home, and End move a cursor through the data; the
  values are announced whole through a polite, atomic live region and shown
  in the tooltip, which is hidden from assistive technology so they are not
  read twice. Drawings (SVG and canvas) are hidden from it too. The cursor
  stops at the series `ChartModel.keyboardStops` lists per panel. An
  inspection along x (lines, areas, vertical bars) or y reports every series
  with a point at exactly that place, so series sharing their positions
  (fields of one table) share a stop; other series, and each series of
  points or cells, are stops of their own. Up and Down move between stops
  and panels. Heatmaps step cell by cell through `Mark.stepCell` (a scan per
  key press), skipping empty cells and reading the row drawn in each.
- Legend entries are buttons with `aria-pressed` in a group named "Legend",
  hidden when there are none.
- Static SVG output has `role="img"`, `<title>`, and `<desc>` containing the
  generated summary (the supplied description first), as PDF alt text does.
- Browser tests audit rendered charts with axe-core (WCAG 2.1 A and AA rules
  and best practices; `test/browser/accessibility.test.ts`): every chart
  family, SVG and Canvas rendering, facets, subplots, the four built-in
  themes, a shown tooltip with the keyboard cursor on a point, and static
  SVG. Automated rules check names, roles, focusable controls, and HTML text
  contrast. The same tests read the accessibility tree each engine gives
  screen readers, in Chrome, Firefox, and WebKit (see Browser tests): the
  figure's name and description, the legend's buttons and their states,
  what the live region says as the keyboard moves, that nothing else is
  exposed, and grids' names, headers, rows, levels, and selection. That is
  what a screen reader receives, not how one speaks it; the charts have not
  been tried with screen readers themselves.

## The chart handle

`createChart` returns `Chart`, an interface (`dom/handle.ts`) rather than the
class behind it (`MountedChart` in `dom/chart.ts`), so what applications call
is a deliberate list: options, viewports, selections, the camera, panels and
pixel mapping, inspection, legend visibility, events, rendering, and export.
The React, Vue, and Svelte adapters hand out the same interface. The chart's
model, its entry in the shared frame loop (an object with `flush` and
`visible`), and its member of a sync group (an object with `syncCursor`,
`syncViewport`, and `syncSelection`, which also names it as the sender of its
broadcasts) are private; what synced charts send is applied without being
sent again, as before.

`getPanels()` gives snapshots of the last scene's panels: plot rectangles and,
per axis, its type, domain, range, categories, band width, the group of
panels sharing its scale, and whether `setViewport` zooms it. They are copies
(category lists, which the model never changes in place, are shared), not
the engine's scales, so scales and their tick and break machinery stay free to
change. Pixel mapping, formatting, legend entries, and inspection read the
last scene too and never draw: what they report is what is on screen, and a
pointer handler that reads them costs no frame. `render()` draws pending
changes when a caller needs them now; `toSVG()` draws only what is pending,
and reports that frame once its own scene is built, so render listeners may
export and what they change is drawn on the next frame. The model caches its panel list per
scene, so mapping many values allocates nothing. Every export of a mounted
chart goes through one method keyed by a symbol (`render/export-scene.ts`),
which draws what is pending and hands a scene of the current state (size,
viewports, hidden series) and the model to a writer: `toSVG` writes SVG,
`toPNG` draws that SVG on a canvas in a module it loads the first time, and
`renderToPDF(chart)` in `herceg/pdf` writes a PDF from the same scene, laid
out with the page's text measures, so the chart's code carries no PDF code
and the handle no PDF method.

Hiding series has one path: the legend's buttons, `setVisibility`,
`setHiddenKeys`, and updates that remove marks all change the model's hidden
set, end a playing transition, draw, and report one `visibility` event when
the set changed. Each scene draws and inspects with a copy of the set, and a
layout mark's last scene keeps its measure and the chart's marks, so what
inspection finds before the next frame is what is on screen; the values it
reports are read from the tables, which an application changing them in
place renders first. Pointer and keyboard routing follow the last scene's
kind too (a layout mark's items, or panels), and keys draw pending changes
before moving the cursor. Hidden keys outlive
their series (a stream may bring them back) but not their mark: an update
drops the keys of mark identities (ids, or indexes) it no longer has.

Changes of view (`setViewport`, wheel and pan, synced ranges, transitions)
mark the chart dirty without marking its panels changed, so a later call
naming a panel does not draw first to find it: setting several panels' views
and a selection draws once, on the next frame. Changes that may change the
panels (options, data, size, hidden series) still draw before such a call.

Marks are opaque: the mark functions return `ChartMark`, whose `spec` is
public, and a type-only brand keeps charts to marks those functions made.
What marks implement (`Mark`, `LayoutMark`, `Frame`, series, scene geometry,
and drawings) is internal. Publishing it would commit to buffer reuse, scene
counters, GPU decisions, the physical layout of series, and layout marks
seeing the whole chart configuration, and the PDF renderer draws only known
geometry kinds. `custom()` is the extension API: domains, scales, clipping,
SVG and Canvas output, series with legend entries, tooltips, the keyboard,
facets, and summaries. A lower-level extension API would follow demonstrated
needs (custom picking, packed geometry, layouts) with its own lifecycle and
export contract. The adapters reconcile marks with what is public: specs,
constructors, and `tablesOf` and `viewOf`.

## Spec and API

`ChartSpec` (in `src/spec/spec.ts`) is plain JSON: field names, constants,
and Intl format options; no functions or typed arrays. The TypeScript API
builds the same structures: `line(table, options)` returns a mark (a
`ChartMark`) whose `spec` is the portable part, a frozen copy of what built it (`Frozen<T>`),
since the mark's caches depend on it: charts change by taking new marks.
Mark implementations are attached to the mark
objects rather than looked up in a registry, so unused mark types are tree
shaken away. Field options are typed from the table schema: numeric encodings
only accept number or time fields, positions also take categories but never
geometry, and `series` only accepts category fields. Options whose forms
exclude each other (an area's `y` or its `y1` and `y2`, an error bar's
orientation, a tree's `path` or its `node` and `parent`) are unions the
compiler keeps apart, in mark options and portable specs alike, and the
marks refuse mixed forms from untyped callers and loaded specs too. Tables built with `new Table` rather
than `table()` have no inferred schema, so marks check their fields only at
runtime.

Specs written elsewhere (the Python package, stored JSON) are loaded by
`herceg/spec`, a separate entry point so applications built with the
TypeScript API do not bundle it. `loadSpec(spec, buffers)` first checks the
spec at runtime, since the type checker cannot see specs from other
languages: structure, enumerations, booleans, finite numbers, field
references, and column payloads, with errors that give the property path
(`marks[2].strokeWidth`) or the table and column at fault, shaped
`location: problem; correction` (`marks[2].inner: expected "box",
"quartiles", or "none"; received "quart"`), as the engine's and the Python
package's errors are, each in its caller's spelling. Properties the format
does not have are refused by default, naming the known property one or two
edits away when there is one; they can be logged or ignored on request
instead. The validator's checks are
typed against the spec's types, so a spec property without a check fails to
compile. It then builds
tables from `data` and marks from `marks`. Columns are JSON arrays or binary: numbers and times as
little-endian typed buffers (`{ type, dtype, buffer }`, where `buffer`
indexes the buffers delivered next to the JSON), categories as int32
dictionary codes, and geometries as a float64 buffer of coordinates and
int32 buffers of offsets (and of codes, when rows do not hold geometry i in
row i). Binary columns become typed-array views of the delivered
bytes, copied only when misaligned, so large data never passes through JSON
number lists. `chartFromSpec`, `specToSVG`, and `specToPDF` render a loaded spec.
A spec's bindings name tables, not stores: `loadSpec` makes a store per
bound table, or takes the stores (and the tables, so that specs loaded apart
share rows) in its options. `projection` only applies to map marks (a spec
with `projection` but no map marks is refused).

A spec carries its format's `version`: 1, the only one so far
(`SPEC_VERSION`), also when left out; the loader refuses later versions,
whose properties may mean what it cannot draw. Herceg is unpublished, so the
format changes in place: its compatibility promise starts with the first
published release.

## Package layout

The `herceg` npm package contains the engine, renderers, and browser runtime
as ES modules with `sideEffects: false`; bundlers drop what a chart does not
use. Framework adapters live in separate packages because their dependencies
differ. One package avoids version skew between engine pieces. PDF export
is a subpath, `herceg/pdf`, so that unbundled imports of `herceg` (from a
CDN or in Node) do not load it either.

Grids are the subpaths `herceg/grid` (the DOM grid and its model) and
`herceg/grid/model` (the model alone, without a DOM), so applications that
draw charts load none of it; a line chart's bundle contains no grid module.
React's `<Grid>` is likewise `@herceg/react/grid`: it creates the grid in a
layout effect, applies `ariaLabel`, `theme`, and `headerHeight` with
`update`, makes a new grid for a new model, and renders React for none of the
grid's changes.

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
Drill roots and manual network positions use the same revision and origin
protocol as viewports. Python exposes `drill_root` as a tuple of ancestor
item keys (None for the whole tree), and `item_positions` as a mapping of
item keys to layout-coordinate pairs. Their callbacks receive the resulting
state. Each subplot's tree, network, or map has states of its own, kept by
event and panel (messages carry its `panel`, snapshots `panel_states`) and
exposed as `panel_drill_roots`, `panel_item_positions`, and
`panel_viewports`, with callbacks registered for a panel; the scalar
properties are the chart's one state (facet panels share it). Snapshots
restore them before listening to engine events; position
assignments suppress intermediate setter events. Move deltas are accumulated
and combined once a frame before whole-state comparison and reporting; peers
apply only changed coordinates and defer hidden nodes until they are shown.
A change of a network's data (its links' or its nodes' table, or a table
either derives from) clears that network's positions in Python even
without an open output and advances its stale-report fence; other
networks keep theirs. Map viewport restoration keeps x and y without requiring axis metadata.
Replacements reset those tables in place, so points with `animationKey`
animate across replacements, as they do in JavaScript apps.
The Streamlit component (`herceg.streamlit.chart`, components v2) has no
connection that outlives a script run, so every run sends the whole chart as
one binary payload: a uint32 header length, the JSON header (spec, buffer
offsets, events the script reacts to), and the buffers at 8-byte aligned
offsets, viewed in place as typed arrays. Streamlit calls the component
again on every run and on theme changes; equal bytes keep the drawn chart,
and changed bytes remount the chart in the same container, restoring the
zoom along x and y and the whole selection where their values remain (on
category axes, by their labels). Data changes therefore remount too, so keyed
points show at once in Streamlit. The script receives the selection whole;
it does not hear of zooming. `on_drill` and `on_item_move` enable persistent
`drill_root` and `item_positions` results, using the same Python values as
widgets. Roots survive redraws through their nearest surviving ancestor;
positions survive style-only redraws and are tagged with the network data
and layout identity so Python discards stale results. These values travel in
the existing component state, with one binary chart payload per run: each
holds the chart's one state and each subplot's by panel (`{ root, panels }`,
`{ epoch, positions, panels }`, and the viewport with `panels`), which reruns
keep where a subplot's plane has the same key (a map's projection, or a
network in the same layout). The layout epoch is the chart's, as the data
epoch of row selections is: a run changing one network's data lays out
every network again.
Charts without a theme read the app's from the
CSS variables Streamlit gives components, since Python may not know it.

A test (`test/architecture.test.ts`) keeps the core directories (`data`,
`geo`, `grid`, `scale`, `format`, `lod`, `marks`, `model`, `scene`, `spec`,
`three`) free of DOM access, and checks that everything `herceg/grid/model`
imports, however indirectly, is in them. Marks import their drawings
(`draw`), which write SVG without a DOM
and paint canvases through the context they are handed; only raster
painting reaches the DOM, creating an offscreen canvas in that canvas'
document when `OffscreenCanvas` is unavailable.

## Browser tests

Every browser suite (the engine's `test/browser`, the three adapters', and
the Python package's JavaScript in `python/js`) runs headless in three
engines: the installed Google Chrome (154.0.8037.99 when written), and
Playwright 1.63's Firefox 155.0 (build 1543) and WebKit 26.6 (build 2359).
`npm run test:browser` runs all three, about a minute on an Apple M6, where
Chrome alone takes about 17 s; `HERCEG_BROWSERS=chromium` runs one.
`scripts/browser/` holds the engines (`browsers.ts`) and the commands tests
run in Node: accessibility trees and garbage collection, through each
engine's own protocol where Playwright has nothing for all three, and real
mouse input, through Playwright's mouse.

- Accessibility trees come from Chrome's DevTools protocol, Firefox's remote
  debugging protocol (the tree its Accessibility Inspector shows, which the
  platform's accessibility API serves), and WebKit's inspector protocol (the
  tree Safari's Web Inspector shows), which Playwright speaks but exposes no
  session of, so the tests reach it through Playwright's in-process objects;
  a release that moves them fails the tests rather than checking less. The
  trees are written alike (`accessibility.ts`): ARIA role names, no text
  under roles whose children are presentational (buttons, checkboxes,
  sliders), though links, alerts, and descriptions there stay, no
  description that repeats the name, and WebKit's rows, cells, and headers
  named by their content as the other engines name them (VoiceOver reads
  their children). WebKit's protocol reports no descriptions,
  `aria-multiselectable`, or `aria-keyshortcuts`, which there come from the
  DOM, and neither Firefox's nor WebKit's reports value ranges, which the
  tests read from the sliders. The engines still differ, and the tests say
  how: WebKit's tables have no row groups, and its rows say `selected` only
  when they are; Firefox makes every row and cell of a grid selectable, a
  selected row's cells selected too, and drops the levels of grouped grids'
  rows (see Known limits).
- Real mouse input is Playwright's mouse. In Firefox it answers before the
  page has the event, which then comes one move a frame, so the command
  waits for each input's event (and fails if none comes); Firefox's pages
  share one mouse, so its test files run one at a time (about 28 s for the
  engine's suite, which takes 7 to 9 s in the others). Pointer events tests
  make up use the engine's mouse id (`MOUSE`): Firefox's mouse is pointer 0,
  which a page can capture only once the mouse has been over it, so in
  Firefox it moves over each test file's page first (`setup.ts`). Real
  multi-finger touch has no Playwright equivalent outside Chrome's DevTools
  protocol: its two tests run in Chrome only.
- Garbage collection is Chrome's HeapProfiler, Firefox's memory actor
  (cycle collection, then garbage), and WebKit's `Heap.gc` after deep calls
  overwrite stale pointers its conservative stack scan would keep. A
  collection that leaves an unreferenced object fails. Leak tests read their
  weak references only after collecting: `deref` keeps its object until the
  task ends, which in Firefox outlasts a collection.
- Firefox is given an application data folder of its own (`MOZ_APP_DATA`):
  it keeps its list of profiles in `~/Library/Application Support/Firefox`
  even when given a profile, and macOS 27 refuses to create that folder.

## Known limits

- In Firefox (155), screen readers hear no levels or places among siblings
  for the rows of grouped grids: Firefox drops rows' `aria-level`,
  `aria-posinset`, and `aria-setsize` in grids that also number their rows
  (`aria-rowcount`, `aria-rowindex`), which grids that mount only the rows
  in view need. Chrome and WebKit expose them.
- In Firefox, a chart in an inline container (a `<span>`) keeps its first
  width: Firefox measures an inline element holding a block as that block
  rather than the box it lies in, so the chart never sees the room it has.
  Give it a block container or a width.
- Geometry is stored in single precision (`Float32Array`) pixel
  coordinates. When zooming leaves neighboring points more than about 10^7
  pixels outside the plot (a view of a millionth of the data's range or
  less), lines and curves between them can be visibly displaced.
- Mark types: line, area, bar, point, heatmap, error bar, candlestick, histogram, the rule, region,
  and text annotations, and custom marks. Horizontal bars need a category y;
  bars along a number or time y are not supported. Lines and areas along y
  are read by scanning their series (no index along y), take no right
  axis, and do not rescale x when y zooms. Error bars stand at the
  center of their position, not beside grouped bars; horizontal ones at y
  positions a log axis cannot place still count toward the x domain.
- Custom marks are JavaScript only, cannot bind category fields other than
  `series`, and are inspected at their series' points, not by the shapes
  they draw; custom marks without series have no legend entries or tooltips.
- Annotation fields cannot be categories (constants on a category axis are
  band indices); text can hide or move labels that would overlap, but has
  no leader lines and does not avoid other marks' geometry. Bar value
  labels estimate text widths from the font size to decide what fits.
- Continuous color for heatmaps, points, and map regions and points only.
- One x axis per panel and at most two y axes per chart; category values
  and marks placed along y (horizontal bars and error bars) only on the
  left.
- Breaks only on time x axes, the same for every panel (a panel's own `x`
  cannot change them). Histograms count values inside breaks (their bins
  span them), custom marks draw what their `draw` draws, annotations inside
  a break sit at its seam, and text summaries count points inside breaks.
  Opt-in `x.seams` draws dashed vertical markers (ECharts draws a zigzag). Each
  scene finds shown ranges per series with a search per break in view
  (about 0.1 ms for 2,600 breaks over a million rows), and a streamed
  million-point line with ten years of sessions takes about 1.2 ms a scene
  instead of 0.6 ms. A calendar keeps every span it resolved for as long as
  its `TimeBreaks` lives (24 bytes per interval).
- Row selections cover marks along axes and maps, treemaps, sunbursts, and
  networks, alone or in facet panels and subplots: other layout marks and
  3D marks refuse a binding, and custom marks and annotations neither write
  nor dim. A map's lasso selects a region by its anchor, not
  by overlap; a network's lasso selects node centers and requires a nodes table.
  Histograms, box plots, violins, error bars, candlesticks, and heatmaps
  write rows but draw every row undimmed (a bin with some rows selected is
  not shown as such), and lassos and brushes along a summary's statistics
  select none of their rows. A brush selects whole rows of every mark of
  its table drawn in its panels; marks over several tables never join
  them. Streaming 1,000 rows a frame into a 100,000-row window with a live
  condition, highlighting costs about 0.5 ms of JavaScript a frame for
  points drawn by the GPU (0.5 to 1.0 ms instead of 0.2 to 0.4) and 1.5 ms
  for a line (1.7 ms instead of 0.2: a pass over its rows' bytes, its runs'
  ends placed, a dot per run of one row, and the line drawn twice, clipped),
  in Chrome, for a condition that leaves about 15,000 runs among 20,000
  selected rows; the scene alone in Node takes about 0.25 ms more for
  CPU-drawn points, and for the line 1.4 ms more, or 0.15 ms for one run
  (one-off interleaved runs, Apple M6). The cost follows the runs: a million
  rows on a log axis take 1.3 ms more for one run and 14.5 ms more for a
  scattered condition of 150,000 runs. Charts
  showing a selection share a byte per row of its table, and points and
  bars split their rows at 4 bytes per row (lines whose x does not ascend
  copy their values, 8 bytes per row and field), made again as rows stream
  in. Brushes Python sets on a widget draw without selecting rows. PDF and
  static SVG export from options do not highlight.
- Range navigators need a number or time x axis that every panel shares:
  no x scales per panel, layout marks, or horizontal bars. The strip draws lines, areas,
  points (a sample of one per pixel, in one size and shape), vertical bars,
  and candlesticks, not heatmaps, error bars, histograms, box plots,
  violins, annotations, or custom marks. Dense bars use column envelopes
  with bounded drawing and rectangle buffers; bars and points still scan
  their source rows whenever data changes, and unsorted lines are drawn
  whole. The strip reuses its overview while dragging. It has no y axis,
  its y scales differing under panels with scales of their own. Charts
  with a navigator show changed values at once (`animation.values` moves
  marks only in scenes of one panel), and charts too short
  to leave their plots 30 pixels (and each row of several panels 20) beside
  a 16-pixel strip have none.
  The sliders' announcements are in English.
- Subplots route whole marks; they have x-only zoom and brushing, and no
  facets inside a panel.
  Rows and columns may be weighted; a scale shared across sizes is planned
  over its smallest panel, so what marks draw past their values fits in
  every one, and the others keep its domain with ticks for their size.
- Facets wrap one category field into rows of panels, or lay out a grid by
  two; x, y, and the right y are shared or resolved per panel, row, or
  column. No y zoom with y scales of their own on either side, no sync of
  charts with categories per panel, and custom marks over a table without
  series can only repeat in every panel. Panel splits are recomputed whenever their
  table changes, and rows of a faceted large line do not use its min/max
  index. A category whose rows all lack a facet value still gets an (empty)
  band. Panels smaller than 20 pixels a side are refused with an error
  rather than drawn.
- Heatmaps have no binning of their own (a derived table's `bin` and
  `aggregate` steps make the grid) and one band per distinct value. A grid
  larger than the plot's device pixels is drawn reduced, with a pixel per
  block of cells: a block with any value is painted, so a sparse grid looks
  denser than it is, and static SVG and PDF hold the reduced image, so
  zooming into the file shows no more cells. Changing any value of the table
  finds the x and y bands again and repaints the image, and the next tooltip
  rebuilds the cell index, each a pass over the rows: for 10 million rows,
  about 0.3 s and 0.1 s in Chrome on the benchmark machine. Band indices and
  the cell index take up to 12 bytes per row (4 more per axis shared with
  other marks).
- Animation moves the axes of single-panel charts between views and, with
  `values`, bars, pie slices, points, and lines and areas traced whole to
  changed values, with the axes their domains move, when the plot and
  categories stay put. Points with `animationKey` match across resets by
  finite numeric values or category labels. Stacked or labeled bars, unkeyed
  points across a reset, points crossing the edge of a fixed domain (they
  shrink instead), lines whose x positions or level of detail change,
  panels, categories that come or go, and the first appearance of a chart
  show at once.
- Box plots and violins recompute every group's statistics (and violins
  their densities) when their table changes, in every panel of charts with
  facets. On a log axis, a box or violin
  whose median is zero or below has no tooltip or keyboard stop, though
  its positive part is drawn.
- A pie, treemap, sunburst, gauge, funnel, radar, or Sankey diagram has its
  chart, each facet panel, or a subplot to itself; a network, map, or 3D
  chart has its chart to itself: no other marks (a map's or 3D chart's
  layers excepted), facets, or subplots. None of them zooms (3D charts'
  camera, maps' plane, and trees' drilling in a chart of their own aside),
  brushes (maps' lassos aside), or syncs. Pie labels go beside the pie only;
  treemaps and sunbursts drill only in a chart of their own (not in facet
  panels or subplots), their breadcrumbs fold and cut steps to fit the strip
  (a folded step is reached through the fold's buttons, by keyboard or
  screen reader, not seen), and their pointer lookup scans each level's
  children. Maps zoom between the whole map and 256 times its scale by
  gestures (`setViewport` sets any view), pan without bounds, and do not
  sync with other charts. A gauge shows one value, with no needle, ticks, or
  threshold marker; a funnel colors every stage alike and has no trapezoid
  (area-proportional) layout.
- Every spoke of a radar shares one scale: there are no per-spoke domains
  (as ECharts' indicators have), log scales, circular grids, or labels on
  the polygons' values. A radar draws at most 100 spokes, and its pointer
  lookup scans every drawn value.
- Networks are laid out once per change of either table, from scratch: a
  streamed row redraws the whole picture rather than settling the new node
  in place, and costs about a second at the 5,000-node limit (links are
  limited to 20,000), which drops nodes moved by hand. Moved nodes stay
  where they are dropped without the layout settling around them, there
  is no pan or zoom, nodes are not lassoed, links of a pair whose rows
  name them differently have no label (no parallel links are drawn), there
  are no circular or hierarchical layouts, and hovering a node does not
  highlight its neighbors. Labels go to the 50 most connected nodes at most
  (fewer in larger networks) and are left out where they would cover a
  node. The pointer lookup scans every node and link.
- Sankey diagrams leave out links that close cycles rather than drawing
  them looping back, and links spanning several columns pass behind the
  nodes between. Nodes cannot be dragged or placed by hand, and there is no
  highlighting of a node's links on hover. The whole layout is recomputed
  when the table changes, and the pointer lookup scans every node and link.
- In charts whose panels have x scales of their own, one scale at a time
  has a selection, synced charts share only cursors with them, and Python's
  live widgets refuse them (Streamlit shows them without reporting
  selections). Annotations repeated in panels whose x scales differ in type
  are described in the text alternative with their first panel's formats.
- Selections report ranges and lasso outlines, not the rows inside them.
  Synced selections are data values, so charts with differently ordered
  categories select different categories. The keyboard selects ranges only;
  rectangles and lassos need a pointer.
- Maps have no base maps, globes or other spherical rotation (only the
  central meridian moves; panning moves the plane), great-circle edges,
  lines or routes, labels on regions, or custom projections. Shapes that
  cross the antimeridian must be cut there, as RFC 7946 asks, or they are
  drawn the long way round; shapes of one feature cut apart show the cut as
  a border. Geometry columns hold polygons and multipolygons only (points
  are number fields), take new shapes only by `reset`, and a table holding
  one cannot be appended to from Python, which replaces it whole. Regions
  are projected again at every new size and zoom level, and picking tests a
  shape's every ring.
- 3D charts draw points, lines, and rectilinear height-field surfaces only:
  no text or bars in 3D, meshes (`mesh3d`), parametric surfaces,
  isosurfaces, volumes, cones, or contours, lines colored by a field, and no
  shading beyond flat diffuse light. On the CPU (exports, small charts,
  browsers without WebGL2), several surfaces in one chart are ordered by
  their cells' depth, and lines by their segments', which can draw them
  wrongly where they come close or cross; the GPU's depth test does not. A
  surface's grid has at most 1,048,576 points and is never reduced; the CPU
  draws at most 250,000 and costs their size every frame (about 28 ms for
  200 by 200 on the benchmark machine). Translucent points and lines, and
  translucent or wireframed surfaces, keep the whole chart on the CPU
  however large it is (refused past the CPU's budget). On the CPU points are
  ordered as wholes: one whose center a surface hides is hidden but for what
  reaches past the surface's outline, and one whose center shows is drawn
  whole, even where its edge passes behind a nearer cell. On the GPU edges
  are not antialiased, and marks within a few steps of the depth buffer under
  a surface show through it. Charts of a 3D mark have no facets, panels,
  brushing, or sync, and labels and titles stay horizontal. Streaming tables
  upload a GPU layer whole on every change.
- Rolling statistics over values whose differences exceed the largest double
  (about 1.8e308) overflow to Infinity.
- Python derived tables count their source's rows through one of its
  columns, so a source whose columns nothing reads needs at least one that
  converts (numbers, strings, or dates).
- The model always carries band-axis, inspection-along-y, and right-axis
  logic, so a line-only bundle includes some bar, heatmap, and second-axis
  support it does not use. Color ramps and size and shape keys are not among
  it: marks that encode values those ways add legend parts
  (`marks/legend-parts.ts`) that lay themselves out, draw their SVG, and
  describe themselves, so the model and the renderers only flow and call
  them.
- Bands, log scales, facet panels' rows, and stacked areas with gaps in view
  re-scan the visible range on every frame; lines and areas filled to zero
  (whole columns, or long-format series following their table) and long
  gap-free stacks on linear scales use min/max indexes. A change to values
  of a long-format table in place groups its rows again and rebuilds their
  indexes, and a rolling window's drops move every row its groups keep.
  Bars of several fields at repeated positions restack every row on each
  change; so do areas stacked by a series field whose x does not ascend in
  some series or is missing in some row, and their facet panels. A series
  appending x positions far behind the others restacks every position from
  there. On a log y axis, a stack's edges at zero are drawn at the axis'
  low end, which costs a copy of each edge per frame.
- Renderer thresholds are not tuned.
- Rules and text are always drawn above other marks, regardless of mark order.
- The GPU draws only large point series; lines, areas, bars, and heatmaps use
  Canvas or SVG. Streaming uploads only new points for whole columns and
  for series split by a field on linear or log axes; series of a row view
  and values replaced in place upload again.
- PDF Unicode text requires supplied static TrueType fonts and a conservative
  script/block allowlist. Other scripts, unassigned characters, controls,
  CFF outlines, joiners, and variation sequences are refused.
  Without supplied fonts the standard Windows-1252 path replaces uncovered
  text with "?". Optional shipped fonts are open work. Tagged PDFs provide
  one chart-level Figure alternative, without PDF/UA conformance;
  colors must be hex, `rgb()`, `hsl()`, or names, transparent backgrounds
  show as white paper, and halos of labels are read twice by readers that
  ignore replacement text (macOS Preview).
- Grids have rows of one height and columns of set widths, with no
  resizing or reordering by dragging, pinned columns, nested groups,
  pivots, custom cell content, editing, or copying, and only a React
  adapter. Row groups recompute every group (a pass over the rows) on any
  change but appends, so a rolling window recomputes them on every append,
  and a new sort of the view recomputes them to find the aggregates
  unchanged; they compute count, sum, mean, minimum, and maximum only, and
  have no place in portable specs yet. Nearly unique keys cost a key array
  and map entries per group: about 0.25 s to group a million rows into
  630,000 groups (appends stay about 1 ms per 1,000 rows). Listing groups' rows, which a grid
  with groups expanded does, is a pass over the view after each change
  (about 0.3 ms per 100,000 rows); groups sort again after each change when
  sorted. There is no "select this group, rows to come included" condition
  yet: selecting a group takes the rows it has. Group headers say "(missing)"
  for missing keys without a `missing` text. Sorting runs on
  the main thread (about 0.13 s for a million rows by a number, 0.25 s by a
  category and a number). Wheel scrolling past 8 million pixels of rows moves
  more than a pixel per pixel. Mounted rows and cells are only those in view,
  so text selection and the browser's find cover only those, and screen
  readers can only read rows the grid has mounted; announcements are in
  English. The grid has not been tried with screen readers themselves.
- No adapters for frameworks other than React, Vue, and Svelte. See the
  roadmap in the repository README.
