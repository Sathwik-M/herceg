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
| **Mark** | One visual layer of a chart (`line`, `area`, `bar`, `point`, `heatmap`, `errorbar`, `candlestick`, `histogram`, `boxplot`, `violin`, the annotations `rule`, `region`, `text`, and JavaScript-only `custom` marks). A mark pairs a spec with the table it reads; a network (`graph`) also reads a table of nodes. Layout marks (`pie`, `treemap`, `sunburst`, `gauge`, `funnel`, `radar`, `sankey`, `graph`, the map layers `geoshape` and `geopoint`, and the 3D layers `point3d` and `surface`) place their own geometry instead of using x and y scales. |
| **Item** | One thing a layout mark draws, such as a pie slice, a tree's node, a gauge's dial, a funnel's stage, a radar's value on one spoke, a Sankey diagram's or network's node or link, a map's region or point, or a 3D chart's point or surface grid point: what its tooltips and the keyboard visit. |
| **Projection** | Maps longitudes and latitudes to the plane a map is drawn in (`projection`, a chart option): Equal Earth, Natural Earth, Mercator, equirectangular, or conic equal-area. |
| **Camera** | Where a 3D chart is seen from: an azimuth about the vertical axis, an elevation above the floor, a zoom, and orthographic or perspective projection (`camera`, a chart option for the first view; then chart state the pointer and keyboard change). |
| **Series** | One drawn line, area, bar set, or point set within a mark: one y field, or one category of a `series` field. Legend entries and tooltip rows are series. |
| **Scale** | Maps data values to pixels: linear, log, time, or band. A band scale maps category indices to evenly spaced bands. |
| **Break** | A span of time a time axis leaves out (nights, weekends, holidays): the axis measures the time it shows, and data inside a break is not drawn. |
| **Axis** | The visual guide of a position scale. In specs, scale and axis options share one object (`x`, `y`). |
| **Viewport** | What a chart shows when zoomed: `{ x, y, yRight }`, the visible x range (one per x scale when panels have x scales of their own) and the left and right y axes' ranges; null for an axis that is not zoomed, which shows its configured domain or its data. |
| **Spec** | The portable, JSON-serializable description of a chart (`ChartSpec`). |
| **Scene** | The render plan for one frame: panels, title, and legend in CSS pixels, with no data references. |
| **Panel** | A plotting area of a scene: its plot rectangle, grid, axes, and geometry. Data is clipped to the plot; guides (rules, text) are not. A chart has one. |
| **Geometry** | A mark's part of the scene: packed polylines (lines, areas), rectangles (bars, regions), segments (error bars, candle wicks), points, a raster (heatmaps), arcs (pie slices, gauge dials), polygons (a map's regions), rules, text, shapes (custom marks, a gauge's value, funnel connectors, network nodes and links), or faces (a 3D chart's surface cells and points, in drawing order). Geometry columns of tables are shapes in longitude and latitude, not scene geometry. |
| **Renderer** | Turns a scene into pixels or markup: SVG markup, retained SVG DOM, Canvas 2D, PDF. |
| **Chart** | A mounted, interactive chart in the browser (`createChart`), and the handle applications hold to it (`Chart`). |
| **Row view** | A table's rows filtered, restricted to a row set, and sorted, as positions into the table (`RowView`); no column is copied. |
| **Row groups** | A row view's rows grouped by the values of some fields (`RowGroups`, made by `groupRows`): each group's key (its value of each field), the positions of its rows, and a table with one row of aggregates per group. |
| **Grid** | A mounted grid in the browser (`createGrid`) showing a row view's rows, or its row groups as header rows each followed by its rows when expanded, drawn from a grid model (`GridModel`), which holds its columns, scroll position, expansion, focus, and selection without a DOM. |
| **Grid column** | A field a grid shows, with its id, title, width, alignment, and format (`GridColumn`). Not a table's column (its storage). |

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
metrics (an even 0.6 em per glyph for monospace fonts) padded by 10%.

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
live rows until an explicit drop shrinks the buffer), 4 to 6 bytes per row for long-format grouping (each group's positions, with room for half as many again and at least 16), two `Float64Array`s per
layer for stacked areas and bars (top and base, with up to 0.5x room to grow
like a table's), and geometry buffers bounded by the plot width.

Rows of a whole table split by a series field are grouped once and kept
current (`SplitRows` in `marks/split.ts`): appended rows are filed
into their groups, and rows a rolling window drops leave the front of each
group (a binary search) while the rest move down into a buffer sized for
them, instead of the table being grouped again each change. Rows given out
are never written again, since scenes and other charts sharing the mark may
still read them; appends only write past their end. Groups are keyed by name, since a window
may renumber a category's codes; a change to values in place, or a reset,
groups again. A row view's rows are grouped from scratch. Each group counts
the rows it has lost, which lets GPU uploads follow it (below). Its code
(`marks/split.ts`) loads the first time a chart groups a whole table's
rows; until then, and for good if it cannot load, rows are grouped again each
change, with the same result. The grouping itself costs about what
grouping again did (both are passes over typed arrays; a rolling window's
drops still move every kept row), and extents of long-format series still
scan their rows each scene. What it buys is uploads: a point cloud of a
million rows in two series, streaming 1,000 rows per tick, takes about
3 ms of JavaScript per frame instead of 13 ms (Chrome, interleaved runs).

Stacks of several fields sharing rows (`marks/stack.ts`) are kept current
as the table streams: appended rows are stacked on their own and dropped
rows leave from the front, using the table's stable row identities
(`rowOffset`) and `modifiedVersion`, the version of the last change to
values already present; anything else (a replace, a reset, a layer hidden
or shown) stacks every row again. Long stacks (from 262,144 rows) keep
min/max indexes over their tops and bases, so y extents and band tracing
read a few blocks per pixel column rather than every row when the view has
no gaps. Bars stack row by row only when their positions strictly increase;
bars split by a series field, or with repeated positions, stack by position
on every change. Over a million-row window with 10,000 rows appended per
tick, five stacked area layers take about 4 ms a frame instead of 32 ms
(unstacked, about 3 ms); five stacked bar fields over 100,000 rows take
about 5 ms instead of 18 ms, as much as grouped bars (one-off Node
measurements of the scene, Apple M6).

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
into the order in one pass (O(kept + appended log appended)), and an in-place
update of a field the filter or sort reads, a reset, or a new query
rebuilds the view (O(rows), plus the sort). Filters compile when they run,
since a column's array can move and category codes change as rows drop. The
comparator (`data/order.ts`, shared with derived tables' sort) compares keys
in order, puts missing values last in either direction, orders infinities,
ranks categories by label once per sort, and breaks ties by position, so
orders are stable and settle the same way after updates. Like derived
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
need not filter the chart that drew it.

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

Row groups (`data/groups.ts`) group the rows a view shows by the values of
some fields and keep count, sum, mean, minimum, and maximum per group, with
derived tables' semantics (a count without a field counts rows, with one its
finite values; the others leave out missing and infinite values). Groups are
numbered in the order they first appeared, and group `g` is row `g` of their
table, an ordinary `Table` charts and grids read.

Each grouping field gives its values ids in order of first appearance
(category codes map to ids through an `Int32Array` per dictionary, numbers
through a `Map` in which NaN is one key, so missing values form a group and
-0 joins 0); with one field the id is the group, with several, ids combine
pairwise (`id × 2^26 + id`) through a map per further field. The group of
every position the view shows is kept in an `Int32Array` over the table's
rows (-1 for rows it leaves out), and running aggregates in `Float64Array`s
per group. Rows are visited in table order, whatever the view's sort: the
view's positions are marked in that array, then read in order. So sums add
up as derived tables add them (equal to `derive(...).filter(...).aggregate()`
to the bit), and sorting the view changes no aggregate.

Groups follow the view's table through its change events (which also give
the fields an update touched) and the view through its `queryRevision`.
Appended rows only (no drop, reset, query change, or update of a field the
groups read: grouping fields, aggregated fields, and the view's filter's) are
marked, found a group (new keys add groups at the end), and added to its
aggregates: O(appended), plus a scan of the view's positions for sorted
views, where appended rows merge anywhere. Anything else computes every
group again (O(rows)), starting from the same ids, so groups that remain
keep their numbers; groups left without rows are then dropped, their keys'
ids forgotten, and the rest renumbered in order. The table is changed where
values differ: a `replace` of each aggregate over each run of groups whose
value changed (runs closer than 64 groups merge, since another call costs
about as much as copying them), then an `append` of new groups; a group that
vanished resets it. So an append costs O(appended × aggregates), not
O(groups), however far apart the groups it touches are. The groups' table is
a `Table` subclass of the module's own whose listeners hear those writes as
one change, after the last one (its appended rows, the updated range, and
the fields): none of them sees some aggregates updated and others not. A
`Table` method writing several fields at once would do the same, but every
chart would bundle it. An update of a field only the view's sort reads keeps
the aggregates and only reorders the groups' rows. Reads catch up first, so a listener of the table that runs
before the groups heard of a change reads it already (a change no listener
call described, seen only through the version, is treated as an update of
every field); a listener of the groups' table that changes their source is
caught up with once the groups' own changes are written.

The positions of each group's rows, in the view's order, are listed only
when a reader asks (a grid with a group expanded, or selecting a group): one
`Uint32Array` of the view's positions, group after group, and where each
group starts, built by counting sort in two passes over the view and kept
until the groups next change. `memberIndex` finds a row among its group's by
binary search with the view's comparator. A group's key is its value of each
field (labels, numbers, or null), and its id the key as JSON with infinities
as text: keys, not numbers or codes, name groups to readers, since numbers
change when groups are renumbered and codes when dictionaries are compacted.
The groups' table keeps the groups alive (a `WeakMap`), and the table and
view hold them weakly, as views are held.

Memory: 4 bytes per table row (each row's group, with half again as room
once rows are appended), 4 bytes per shown row once rows are listed, and
8 bytes per group per running value. At a million rows and a thousand
groups, the groups take 4 MiB at first and grouping takes about 11 ms, where
a derived table's filter and aggregate take about 40 ms and allocate
copies of the filtered columns (about 98 MiB for 20 fields); 1,000 appended
rows update them in about 0.1 ms (one-off Node measurements, Apple M6).

## Grids

A grid (`herceg/grid`) shows a row view's rows. Its state lives in a
DOM-free model (`grid/model.ts`, also the entry point `herceg/grid/model`),
in three parts kept apart: the query is the view's (filter and sort, which
the model changes through `view.setQuery`, keeping the filter); the
presentation is the column list (order, widths, hidden columns, formats),
placed as prefix sums of widths; and the interaction is the model's own:
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

Grouped grids show a row groups' groups (`grid/grouped.ts`), each a header
row followed by its group's rows when expanded. The model keeps the
expansion as the ids of groups expanded otherwise than by default (all
collapsed, or all expanded after `expandAll`), so groups keep it as rows
stream and through resets; ids of groups gone are forgotten once they
outnumber the groups present. The display is the groups in order (by the
group sort over the groups' table, or as they appeared), each header's row
index as prefix counts of header and expanded rows (a `Float64Array` per
group, no object per row), so a row index finds its group by binary search
and its row as an offset into the group's rows. It is rebuilt (O(groups),
plus a sort of the groups when sorted) when the groups, their order, or the
expansion change. Rows of a collapsed group are not shown; the focus, the
row at the top, and a range's anchor follow table rows by identity and
headers by key, and a row hidden by its group collapsing resolves to the
group's header. Expanding or collapsing keeps the top row in place; new
groups or a new group order keep the pixel offset, as a new query does.

Selecting a header selects its group's rows into the row set (its rows are
listed for it). How many rows of each group are selected is counted once per
selection and change of the groups' rows: a pass over the row set's members,
or for a condition over the table, finding each row's group. Appends leave
the counts of row sets alone (appended rows are in none, and new groups have
none selected), so streaming into a grouped grid counts nothing again, and
the model's own clicks and keys adjust the counts they change instead of
counting again. Headers' cells are written from the groups' table through
the columns' formatters, the first naming the group by key and counting its
rows.

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
needs cells), so it becomes a named group until columns return. Frames go
through the shared scheduler, sizes come
from a resize observer on the container and the scroller, and grids out of
the page's view wait. A grid's container gets the grid's height, or 320
pixels when it has none.

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
carry `aria-level`, `aria-posinset`, and `aria-setsize` (their place among
the groups, or among their group's rows, since most are not mounted), and
headers `aria-expanded`. Since `aria-selected` has no mixed value, a header's
first cell holds a checkbox (`role="checkbox"`, `aria-checked` true, false,
or mixed) beside a toggle drawn for the eye only; its rows keep
`aria-selected`. Focus stays on cells, so the keys adapt the pattern's: a
row's first cell stands for the row (where the pattern would focus rows),
so Right and Left there expand and collapse a group and Left on a group's
row goes to its header, while elsewhere the arrows move between cells, as in
the pattern's cell focus; Enter on any cell of a header toggles it (the
pattern's cell focus takes Enter on the first cell only), and the live
region says what expanding and collapsing did.

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
what sorting and selecting did. Theme tokens become custom properties on the
grid's root, read by one stylesheet each grid carries (so grids in shadow
roots are styled); forced-colors mode uses system colors. `destroy()`
unschedules the grid and removes its listeners, observers, and elements.

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

On a time axis with breaks, columns are columns of time shown and points
inside breaks are left out without ending a run (see Time axis breaks).

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
rebuild its index and take up to about 5 ms instead of 4 ms. Bands and
long-format series (row subsets) are not indexed; long stacks have indexes
of their own (see the data model).

Histograms keep their bins, not their values: whenever the table changes,
one pass finds the extremes and another counts each series' values (by
division for evenly spaced edges, binary search for calendar ones), and at
most a thousand bars are drawn, whatever the data size. Series split by a
category field also keep their row indexes (4 bytes per row), as long-format
series do. Streaming recounts every value on each change.

Candlesticks (and OHLC bars, their `variant`) merge rather than sample: with more candles in view than the
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
index, queried over shown ranges. M4 over breaks (`lod/m4-breaks.ts`) takes
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

## Small multiples

With `facet`, the model draws a panel per value of a category field, or per
pair of values of a row field and a column field (each field's values in
order of first appearance across the tables of the marks that split, every
pair drawn, rows by columns). Facet headers are scene text (`Scene.headers`),
so every renderer and static export draws them the same way. With
`resolve.y`, panels are grouped (each alone, by row, or by column) and each
group gets a y plan from the data its panels draw within their x domains,
the same nice, headroom, and inset rules as a shared axis; a group with
nothing to show draws no y labels. The spec format's version 2 adds
`resolve` and version 3 `resolve.x`; older specs still load, and a spec
using either must say its version, since an older reader would ignore it. Rows
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
Up and Down carry the keyboard cursor's x value between panels sharing a
scale and its place across the plot otherwise, and a keyboard range never
reaches across scales. Synced charts share cursors with such charts (each
panel draws a cursor its scale holds) but neither send them nor take
viewports and selections, which belong to some panels only; applications
that link scales of the same quantity set them with `setViewport` and a
panel. Python's live widgets report one viewport and selection and refuse
charts whose panels have x scales of their own; the Streamlit component shows them and
reports clicks (the clicked panel's scale decides whether values are
times), keeps each panel's zoom across reruns by panel key, and refuses
`on_select`.

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
renderers stretch over the plot. Canvas draws it with `drawImage`; SVG embeds
it as a PNG. In the browser the canvas encodes the PNG; `renderToSVG` uses a
small bundled encoder, which only server-side bundles include. While the grid
fits the plot's device pixels, each cell is one pixel; when several rows fall
in one cell, the last row with a value wins, and missing values leave a cell
transparent. A grid with more columns or rows than the plot has device pixels
(the frame's `rasterRatio`: the device pixel ratio on screen, 2 for static
SVG and PDF, which are zoomed and printed) gets an image of the plot's size
instead, rounded down so each image pixel covers at least a device pixel
(nearest-neighbor drawing of a larger image would skip pixels, and with them
a block's only hot cell). The image is reduced along each axis separately:
cell `c` of `n` lands in pixel `floor(c * pixels / n)`, the pixel its leading
edge falls in, and one pass over the rows accumulates each pixel's sum and
count of finite values (or its greatest or least value, with `reduce: "max"`
or `"min"`). Sums are Float64; a block whose sum overflows (values near the
largest doubles) is summed again in a second pass with every value divided by
2^64, and its mean multiplied back. Each pixel's four bytes hold its count
until it is colored. The sums are a frame buffer kept while the image is
repainted (8 bytes per pixel besides the 4 of the image).
Rows that repeat a cell each count toward a mean. The painted image is kept
and reused until the table, the band order, the image size, the theme, or
the mark painting into the buffer changes, so redraws for other reasons (a
legend toggle, a brush) do not repaint it.

Tooltips report the cell under the pointer even when its pixel shows a block:
the band scale maps the pointer to a band index, and a cell index finds the
row. The index (`lod/cell-index.ts`) is the table's rows with a value, sorted
by cell row and column with two counting sorts (rows already in cell order,
as dense grids usually are, are taken as they are, and when they are every
row, the table itself is the index), so it keeps at most 4 bytes per row
whatever the number of cells (building it takes up to 8 more per row and a
counter per band), and a lookup is a binary search. It is built on the
first lookup after the table or the band order changes. Ramps
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

## Layout marks

Most marks place data along x and y scales. Layout marks (pies, treemaps,
sunbursts, gauges, funnels, radars, Sankey diagrams, and networks) place their own geometry in a panel instead: the chart model gives one the
room below the title and legend (`LayoutFrame`: bounds, theme, text
measurement, hidden keys, and stable colors per item key) and draws what it
returns (`LayoutResult`: geometry, an item lookup by pixel, the items in
reading order, and a summary). A chart holds marks along axes or one layout
mark (or the layers of one map, drawn as one; see Maps), never both, so the
Cartesian layout code runs unchanged and a line chart carries only the small
dispatch, not the pie.

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
uniform grid. Nodes are drawn as shapes geometry, one circle path per node,
largest first, each filled and ringed in the surface color, so overlaps stay
legible in SVG, Canvas, and PDF without a geometry kind of their own; links
are one path per width and color. The pointer lookup scans every node, then
every link.

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
and pixels per projection and fit (the three most recent fits, so a few
charts or sizes drawing one set do not evict each other). Points within
0.35 px of the last one kept are dropped, rings left with fewer than three
points too, and the holes of a polygon whose exterior is dropped. A resize
projects again rather than keeping every point in the plane as well as in
pixels; changes of values, colors, the legend, or the theme reuse the pixels
and the SVG path data, which is made once per shape. The plane boxes come
from vertices with edges divided at a degree, so at extreme zooms a curve
can reach a pixel or two past the box, and the plot's clip.

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

## 3D charts

3D charts are layout marks too: `point3d` points and `surface` surfaces are
the layers of one chart, joined (as a map's layers are) into a `Plot3D`
(`marks/plot3d.ts`) that plans the axes, fits the box, orders what every
layer draws, and finds what the pointer is on. Everything they draw is
ordinary scene geometry: the box's grid lines and edges are line geometry
drawn below the data, its tick labels and titles text drawn above, and the
layers' points and cells one `faces` geometry, so SVG, Canvas, PDF, static
export, and the text alternative need no 3D code of their own.

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

Faces (`three/faces.ts`, drawn by `draw/faces.ts`) are packed: screen
vertices with their depths, each face's corners as vertex indices (one
corner for a disc, three or four for a cell, more for a triangle of a cell
cut at the box's walls), a style index per face (fill, opacity, disc radius,
outline), and a sort key and depth.
Faces are sorted by key, then depth, with two 16-bit counting passes per key
(stable, so ties keep the order they were written in), and drawn in that
order; consecutive opaque faces of one style are filled as one path (of at
most 64 faces: Chrome fills one path of thousands of arcs slower than many
short ones), translucent ones, and ones outlined in another color, one by
one. A polygon is filled as the fan of triangles from its first corner, each
turned the same way, so a cell folded edge on still covers what its
triangles do under the nonzero rule; opaque cells are outlined in their own
color by half a pixel, which closes the seams antialiasing would leave
between neighbors, and wireframes are each cell's outline drawn right after
its fill, so cells in front hide the lines behind (cells cut at the walls,
drawn as triangles, have no wire, which would show their diagonals).

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

A disc, though, covers more than the point at its center: ranked by its
center, the cells around it drawn after it would cut its edge though they
lie behind it (seen from above, every point over a surface would show a
crescent), and two overlapping points over different cells would be drawn
in the cells' order, not by depth. So once the order is known, each disc is
placed among the polygons it overlaps on screen: after those behind it and
before those in front. A polygon covering the disc's center is in front when
the exact order draws it after the disc; others (and all of them in the
approximate order) are judged by their depth where they come nearest the
center, interpolated from their vertices. Where these disagree, the polygons
over the center win (a point shows exactly when its center does), then
those in front at the edge. Each disc goes as early as that allows, but no
earlier than the farther discs it overlaps (placed first), unless that
would draw it over a polygon in front of it; discs in one place are drawn by
depth. In grid cells crowded with discs (more than 16), every disc counts as
overlapping, which can only move a disc later among discs, so points piled
on one spot are not compared pair by pair. The result is drawn whole, so a
point shows as a marker would: its outline cut only by the polygons in front
of it. This costs most where many points lie over a dense surface: ordering
the faces of 10,000 points of radius 3.5 over a 100 by 100 grid takes 15 to
25 ms a scene in Node, about 40 ms at radius 10, and 10,000 or 20,000 points
piled on one spot under 30 ms (each disc is checked against the cells it
overlaps, found through two more grids like the pointer's).

A surface's grid is built once per table version: the distinct numbers or
times of x and y, sorted (or the categories rows hold, in dictionary order),
and per grid point the last row with a value, refused before allocation when
the grid would exceed 250,000 points. Per scene it projects each grid point
once, then writes a face per cell with three or four corners holding values;
cells reaching past the box (a configured domain narrower than the data) are
cut at its walls triangle by triangle, as drawn (Sutherland–Hodgman in
normalized coordinates), so a cut follows the surface. Shading is
flat per cell: the cell's normal in the box's units (across its diagonals),
two-sided against a light above and left of the eye, in 16 steps that
multiply the ramp color by 0.72 to 1.1, so styles stay few enough to share.

The pointer finds the face drawn last under it through a uniform grid
(`FaceIndex`, cells sized for a few faces each, 6 to 24 px a side): polygons
are filed in each cell their box covers, discs by their center, and a query
looks as far around as discs reach. A surface's cell reports its drawn
corner nearest the pointer. Grid points outside the box at the corners of
cells cut at its walls are items too, anchored at the drawn vertex nearest
them, so the pointer and the keyboard reach every cell drawn. Items are rows: points in
row order, a surface's grid points in grid order, keyed by the table's row
identity (`rowOffset` + row), so keys survive rows dropped from a stream.
Inspections of 3D items carry their values by field.

Point layers of at least 20,000 points, all opaque, on linear, time, or log
axes, are drawn by the GPU in the browser instead (`paint3d` in
`render/webgl.ts`, the painter 2D clouds use). Each layer's columns are
uploaded once per table version as float32 values mapped by the axes then
(less the centers of their domains, times their factors, so values of any
magnitude come out near the box's [-1, 1]), and uploaded again only if the
domains move so far that points in the box would be off by a quarter pixel
(float32's error grows with the distance from those centers) or the factors
change a millionfold; axes without a finite mapping draw on the CPU; each row's color is a byte into a
256-entry palette texture (255 for rows not drawn), uploaded per color array,
which the layer replaces when the table, the hidden series, or the colors
change, and palettes are kept as bytes by their colors. Uploads are kept by
their columns, so layers and charts drawing the same columns share them. The
axes' mappings and the view are uniforms, so turning the camera uploads
nothing. The vertex shader places points in the box, moves those outside it
(and missing values, a sentinel) off the screen, and a depth test, not
drawing order, decides what shows (at equal depths the later point, as on
the CPU); sprites' corners are discarded, so they never hide what is behind
them. The context now has a depth buffer (2D clouds leave it unused). The faces of such a chart are
built only when something reads them: the pointer's first query after a
turn, the keyboard, the summary, or a canvas without the painter. Turning a
million points costs under a millisecond of JavaScript a frame (GPU time not
included), against about 200 ms on the CPU path; the first tooltip after a
turn projects, sorts, and indexes every point, about 50 ms at a million.

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
nothing is embedded: layout and anchoring measure text with those fonts'
exact metrics (Adobe's AFM widths), so a PDF's margins and label placement
can differ slightly from the static SVG's, which uses estimates. Streams are Flate-compressed by a small built-in deflate (fixed
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

With `tooltip.axisLabels`, the overlay also labels the crosshair on the
axes: the inspected value on the axis it follows, and for the pointer, its
position on the other axes (both y axes when there are two) across a dashed
line. The labels live in `dom/axis-labels.ts`, loaded the first time a
chart asks for them, which imports no code of its own so that loading it
moves nothing out of a chart's bundle.

Charts emit `viewport`, `select`, `hover`, `click`, `camera`, `visibility`,
and `render` events. Each reports changes only (hover compares the inspected
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

## Accessibility

- The chart root is a focusable `figure` named by the title, described by a
  generated summary (series count and, per series, point count, range, and
  last value; marks such as heatmaps, histograms, and layout marks write
  their own), followed by what color scales and size and shape keys show,
  since their legends are drawn. It is refreshed at most once a second,
  does not repeat the title, and its element is hidden, so it is read once,
  as the figure's description.
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
- Static SVG output has `role="img"`, `<title>`, and `<desc>`.
- Browser tests audit rendered charts with axe-core (WCAG 2.1 A and AA rules
  and best practices; `test/browser/accessibility.test.ts`): every chart
  family, SVG and Canvas rendering, facets, subplots, the four built-in
  themes, a shown tooltip with the keyboard cursor on a point, and static
  SVG. Automated rules check names, roles, focusable controls, and HTML text
  contrast. The same tests read the accessibility tree Chrome gives screen
  readers (through the DevTools protocol): the figure's name and
  description, the legend's buttons and their states, what the live region
  says as the keyboard moves, and that nothing else is exposed. That is what
  a screen reader receives, not how one speaks it; the charts have not been
  tried with screen readers themselves.

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
scene, so mapping many values allocates nothing.

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
(`marks[2].strokeWidth`) or the table and column at fault. Properties the
format does not have are allowed, so newer specs still load, but reported:
logged by default, refused or ignored on request. The validator's checks are
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
A spec says which format version it is written in when it uses a feature an
older reader would silently ignore and draw something else for: version 2
adds `resolve` and `panels`, version 3 `resolve.x`, panels' own `x`, and
the x axis' `breaks`. The loader
reads every version up to its own and refuses later ones. Maps did not
change the format's version: a reader that predates them refuses their mark
types and geometry columns with an error rather than drawing something
else, and `projection` only applies to those marks (a spec with
`projection` but no map marks is refused).

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
The Streamlit component (`herceg.streamlit.chart`, components v2) has no
connection that outlives a script run, so every run sends the whole chart as
one binary payload: a uint32 header length, the JSON header (spec, buffer
offsets, events the script reacts to), and the buffers at 8-byte aligned
offsets, viewed in place as typed arrays. Streamlit calls the component
again on every run and on theme changes; equal bytes keep the drawn chart,
and changed bytes redraw it in place, keeping the zoom along x and y and the
whole selection (on category axes, by its categories' labels), which the
script receives whole; it does not hear of zooming. Charts without a theme read the app's from the
CSS variables Streamlit gives components, since Python may not know it.

A test (`test/architecture.test.ts`) keeps the core directories (`data`,
`geo`, `grid`, `scale`, `format`, `lod`, `marks`, `model`, `scene`, `spec`,
`three`) free of DOM access, and checks that everything `herceg/grid/model`
imports, however indirectly, is in them. Marks import their drawings
(`draw`), which write SVG without a DOM
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
  Breaks have no drawn marker at their seams (ECharts draws a zigzag). Each
  scene finds shown ranges per series with a search per break in view
  (about 0.1 ms for 2,600 breaks over a million rows), and a streamed
  million-point line with ten years of sessions takes about 1.2 ms a scene
  instead of 0.6 ms. A calendar keeps every span it resolved for as long as
  its `TimeBreaks` lives (24 bytes per interval).
- Subplots route whole marks; they have no right axes, shared category x
  and y axes only, x-only zoom and brushing, and no facets inside a panel.
  Rows and columns may be weighted; a scale shared across sizes is planned
  over its smallest panel, so what marks draw past their values fits in
  every one, and the others keep its domain with ticks for their size.
- Facets wrap one category field into rows of panels, or lay out a grid by
  two; x and y are shared or resolved per panel, row, or column, for
  continuous axes only. No y zoom with independent y, or right axes in
  faceted charts, and
  heatmaps, histograms, box plots, violins, stacked bars, annotations over a
  table, and custom marks over a table without series can only repeat in
  every panel. Panel splits are recomputed whenever their
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
- Animation moves the axes of single-panel charts between views; changed
  values (bars growing, pie slices turning), entering and leaving data, and
  the first appearance of a chart show at once.
- Box plots and violins recompute every group's statistics (and violins
  their densities) when their table changes, and repeat in every panel of
  charts with facets rather than splitting. On a log axis, a box or violin
  whose median is zero or below has no tooltip or keyboard stop, though
  its positive part is drawn.
- A pie, treemap, sunburst, gauge, funnel, radar, Sankey diagram, network, map, or 3D chart has its chart to itself: no
  other marks (a map's or 3D chart's layers excepted), facets, zoom (3D charts' camera aside), brushing, or sync. Pie labels go beside the pie
  only; treemaps and sunbursts have no drill-down, and their pointer lookup
  scans each level's children. A gauge shows one value, with no needle, ticks,
  or threshold marker; a funnel colors every stage alike and has no
  trapezoid (area-proportional) layout.
- Every spoke of a radar shares one scale: there are no per-spoke domains
  (as ECharts' indicators have), log scales, circular grids, or labels on
  the polygons' values. A radar draws at most 100 spokes, and its pointer
  lookup scans every drawn value.
- Networks are laid out once per change of either table, from scratch: a
  streamed row redraws the whole picture rather than settling the new node
  in place, and costs about a second at the 5,000-node limit (links are
  limited to 20,000). Nodes cannot be
  dragged or pinned, links have no arrows or labels, there are no circular
  or hierarchical layouts and no zoom, and hovering a node does not
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
- Maps have no zoom or pan, base maps, globes or other spherical rotation
  (only the central meridian moves), great-circle edges, lines or routes,
  labels on regions, or custom projections. Shapes that cross the
  antimeridian must be cut there, as RFC 7946 asks, or they are drawn the
  long way round; shapes of one feature cut apart show the cut as a border.
  Geometry columns hold polygons and multipolygons only (points are number
  fields), take new shapes only by `reset`, and a table holding one cannot be
  appended to from Python, which replaces it whole. Regions are projected
  again at every new size, and picking tests a shape's every ring.
- 3D charts draw points and rectilinear height-field surfaces only: no
  lines, text, or bars in 3D, meshes (`mesh3d`), parametric surfaces,
  isosurfaces, volumes, cones, or contours, and no shading beyond flat
  diffuse light. Several surfaces in one chart are ordered by their cells'
  depth, which can draw them wrongly where they come close or cross. A
  surface's grid has at most 250,000 points and is never reduced, so large
  surfaces cost their size every frame on the CPU (about 28 ms for 200 by
  200 on the benchmark machine). Points sharing a chart with a surface, and
  translucent points, are drawn on the CPU however many they are. Points are
  ordered as wholes: one whose center a surface hides is hidden but for what
  reaches past the surface's outline, and one whose center shows is drawn
  whole, even where its edge passes behind a nearer cell. Charts of a 3D mark
  have no facets, panels, brushing, or sync, and labels and titles stay
  horizontal. Streaming tables upload a GPU layer whole on every change.
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
- Bands, log scales, long-format series, and stacked areas with gaps in view
  re-scan the visible range on every frame; whole-column lines, areas filled
  to zero, and long gap-free stacks on linear scales use min/max indexes.
  Stacked bars split by a series field restack every row on each change.
- Renderer thresholds are not tuned.
- Rules and text are always drawn above other marks, regardless of mark order.
- The GPU draws only large point series; lines, areas, bars, and heatmaps use
  Canvas or SVG. Streaming uploads only new points for whole columns and
  for series split by a field on linear or log axes; series of a row view
  and values replaced in place upload again.
- PDF text is limited to the standard fonts' Windows-1252 characters (others
  print as "?"); fonts are not embedded, so Greek, Cyrillic, and CJK labels
  need SVG or PNG export. PDFs are not tagged for assistive technology,
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
