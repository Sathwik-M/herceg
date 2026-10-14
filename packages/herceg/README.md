# herceg

Framework-independent charts for analytics: columnar data, streaming updates,
level-of-detail rendering, SVG and Canvas output, SVG and PDF export.

> Early development. Line, area, bar, point (scatter), and heatmap marks, and
> dendrograms, and rule, region, and text annotations are available; the API may change before
> 1.0.

## Quick start

```ts
import { createChart, line, rule, table, time } from "herceg";

const metrics = table({
  time: time(timestamps), // Float64Array of epoch ms, Date[], or ISO 8601 strings
  p50: p50Latency, // Float64Array or number[]
  p99: p99Latency,
});

const chart = createChart(document.querySelector("#latency")!, {
  title: "Request latency",
  marks: [line(metrics, { x: "time", y: ["p50", "p99"] }), rule({ y: 250, label: "SLO" })],
  y: { title: "ms" },
});
```

Field names are checked against the table at compile time: `y` only accepts
numeric or time fields, `series` only accepts category fields. A continuous
axis is a time axis when any field a mark places on it holds times, whether
the mark is a line, area, point, error bar, rug, candlestick, or heatmap;
bar lengths and histogram counts stay numbers. Set `type: "linear"` on the
axis to read times as plain numbers.

Common tasks (a basic line, several series, a custom tooltip, annotations,
synced charts, streaming, 100,000 points, a custom mark, a theme, export, a
Python notebook chart, bars with a target over categories) are written out in
[benchmarks/src/ease](https://github.com/op55-org/herceg/blob/main/benchmarks/src/ease), one directory per task,
beside the same task in ECharts, TanStack Charts, Chart.js, and Plotly; a
browser test keeps every sample drawing, and
[the comparison](https://github.com/op55-org/herceg/blob/main/docs/comparison.md#common-tasks) sets them side by
side.

## Data

`table()` builds columnar data. Typed arrays are used without copying; plain
arrays, `Date` arrays, and string arrays are converted once. Change a typed
array's values through the table (`set`, `replace`, below): the table and the
array share memory, but only the table's methods keep its cached extents and
level-of-detail indexes current and redraw the charts reading it.

Numbers are numbers, so say what else they are. Herceg does not guess from a
field's name or magnitudes: epoch milliseconds given as plain numbers draw a
number axis (ticks such as "1.77T"). Wrap them in `time()` for a time axis;
`time()` also takes `Date`s and ISO 8601 strings, read as `Date.parse` reads
them: a date alone is UTC midnight, and a date and time without an offset is
local time, so give `Z` or an offset for instants. Numbers that name things
(years, status codes, ids) are categories with `category()`, labeled as
`String` writes them, in order of first appearance.

```ts
const requests = table({
  time: time(["2026-01-21T09:30:00Z", "2026-01-21T09:31:00Z"]),
  latency: latencies,
  service: serviceNames, // string[]: a category field
  status: category([200, 503]), // numbers as categories: "200", "503"
});
requests.numbers("latency"); // Float64Array view of the live rows
requests.categories("service"); // { codes: Int32Array, dictionary: string[] }
requests.value("latency", 0); // number | null, typed by the field
requests.value("time", 0); // epoch milliseconds
requests.value("status", 1); // "503"
```

`table.value(field, row)` reads one value as its field's kind: a number (null
when missing), epoch milliseconds for times, a category's string, or a
shape's code for geometry fields.

Row objects can be converted with `fromRows(rows)`; their `Date` properties
become time fields, numbers number fields, and strings category fields.
`types` reads a property as another kind: `"time"` for epoch milliseconds or
ISO 8601 strings, `"category"` for numeric codes:

```ts
const rows = fromRows(records, { types: { at: "time", status: "category" } });
```

Categories that are
already dictionary-encoded (Arrow dictionaries, pandas categoricals) are used
without decoding: `encodedCategory(codes, dictionary)` takes `Int32Array`
codes (-1 for missing) and the dictionary. Shapes for maps are geometry
fields, from `fromGeoJSON(collection)` or `geometry(set, codes?)` (see Maps);
`table.geometries(field)` gives each row's code and the shapes.

A field sampled on a grid (a density estimate, a simulation's output, an
image) is a matrix: values at every x crossed with every y. `fromMatrix`
makes a table of one, without a column of x and y values per grid point:
the fields `x` and `y` name hold its coordinates, one per column of the
matrix and one per row, and every other field a value at each pair, in
rows of x (the i-th x and j-th y at j × the number of x values + i, as a
NumPy array of shape (y, x) flattens). The table's rows are the pairs in
that order; contours read the matrix as it is, and other readers (a
heatmap, a surface) get a value of x and y per row, made when first read.
Appending, dropping, or resetting rows, or replacing coordinates, leaves an
ordinary table; replacing values keeps the matrix.

```ts
const density = fromMatrix({ x: xs, y: ys, density: values }, { x: "x", y: "y" });
contour(density, { x: "x", y: "y", color: "density", variant: "bands" });
```

Tables are mutable and charts that read them re-render on the next animation
frame, once per frame however many changes arrive:

```ts
const live = table({ time: time([]), cpu: [] as number[] }, { maxRows: 3_000 });
live.append({ time: [Date.now()], cpu: [0.42] }); // keeps the newest 3,000 rows
live.appendRow({ time: "2026-01-21T09:32:00Z", cpu: 0.4 }); // times as their columns take them
live.set("cpu", 0, 0.5);
live.replace("cpu", 0, [0.1, 0.2]); // overwrite rows 0 and 1
live.dropBefore("time", Date.now() - 60_000);
live.reset({ time: newTimes, cpu: newValues });
```

### Derived tables

`derive` prepares data for charts: filters, calculated fields, bins,
aggregates, rolling windows, and sorting, in a chain whose field names are
checked at compile time against the fields each step produces.

```ts
import { col, count, derive, mean, when } from "herceg";

const hourly = derive(readings)
  .filter(col("temp").gt(-40).and(col("site").ne("test")))
  .calculate("f", col("temp").mul(1.8).add(32))
  .bin("time", { bins: { step: 3_600_000 }, as: "hour" })
  .aggregate({ by: ["hour", "site"], ops: { mean: mean("f"), n: count() } })
  .table();
line(hourly, { x: "hour", y: "mean", series: "site" });

derive(prices).rolling({ size: 20, ops: { ma: { op: "mean", field: "close" } } }).table();

// Rows counted in bins of x and y: a 2D histogram's cells, drawn as a heatmap of them.
const cells = derive(points)
  .bin("x", { bins: [0, 1, 2, 5, 10], as: "x0", end: "x1" })
  .bin("y", { bins: 20, as: "y0", end: "y1" })
  .aggregate({ by: ["x0", "x1", "y0", "y1"], ops: { n: count() } })
  .table();
heatmap(cells, { x1: "x0", x2: "x1", y1: "y0", y2: "y1", color: "n" });
```

`bin` takes bins as histograms do (one definition, `BinSpec`, for both):
about how many round bins (10 by default), `{ step, start }`, or edges. It
replaces the field (or adds `as`) with the start of each value's bin and,
with `end`, adds the bin's end; a value in no bin (missing, below an
explicit start, outside the edges) has none. Bins of a width run on from
multiples of the step (or the start) without end, so rows appended later
take the bins earlier rows did; a count bins the values the table holds,
and the last bin holds the greatest value, as a histogram's does.

The result is an ordinary table that follows its source. Appends to the
source go through filters, calculations, and bins of a width or of edges on
their own, and rows dropped from the source (a rolling window) drop the rows
they gave; other changes, and pipelines with aggregates, rolling windows,
sorting, or bins of a count, recompute the table. A derived table keeps its source
alive; the source holds it weakly, so one no longer referenced stops
following once it is collected. Treat derived tables as read-only: changes
to them are replaced when the source changes. Expressions
(`col("x").gt(0)`, `.add`, `.mul`, `.isIn`, `.isMissing`, `when`, and more)
are portable JSON trees, as specs carry them (`[">", ["field", "temp"], 30]`;
not Vega-Lite's expression strings). Missing values (NaN, missing
categories) compare false except as unequal, and `null` in a `when` branch
is missing in the other branch's type. Calculated fields are categories
when they give text and numbers otherwise, even a copy of a time field.
Ungrouped aggregates give one row even for no rows (a count of 0, missing
statistics). Aggregates are `count`, `sum`, `mean`, `median`, `min`, `max`,
`q1`, `q3`, `stdev`, `variance` (sample statistics), `distinct`, `first`,
and `last`, over finite values (`count()` counts rows, `count(field)` the
field's finite values); quantiles interpolate as NumPy and pandas do.
Rolling windows are trailing windows of rows (within `by` groups),
with `count`, `sum`, `mean`, `min`, `max`, and `stdev`. Bins hold their
start: `step` wide from `start` (by default at multiples of the step), or
about `count` round bins (default 10; 1 wide when all values are equal);
time fields bin by a step in milliseconds. Rolling statistics combine
partial aggregates rather than subtracting values that leave the window, so
huge values do not swamp small ones. Loading specs (`herceg/spec`) includes
the transforms, about 4.9 KiB gzip; charts built in TypeScript bundle them
only when they call `derive`.

### Row views and selections

A row view shows a table's rows filtered and sorted without copying a
column: it holds the positions of the rows it shows, which readers such as
grids take the table's values through.

```ts
import { col, rowView } from "herceg";

const view = rowView(requests, {
  filter: col("latency").gt(250),
  sort: [{ field: "service" }, { field: "latency", order: "descending" }],
});
const { indices, length } = view.read(); // positions into `requests`, in view order
```

Views follow their table: changes mark them out of date at once, and the
next `read` catches up, filtering appended rows and merging them into the
order, dropping rows that left a rolling window, and rebuilding when a
field the view filters or sorts by changes in place (or the table resets).
Sorts are stable, with missing values last in either direction and
categories by label. A view with neither filter nor sort holds no
positions. `view.subscribe(listener)` is told when it goes out of date;
`view.dispose()` stops it following its table. `view.query` gives back the
filter and sort, to change one and keep the other
(`view.setQuery({ ...view.query, sort })`), and `view.indexOf(position)`
finds where a table row shows in the view, or -1.

A `RowSet` is a set of a table's rows by identity, a bit per row, such as
the rows picked in a grid: its rows stay members as others are appended and
dropped, and a reset of the table empties it. `view.restrict(set)` shows
only its rows. A `SelectionStore` keeps one table's selections by channel,
each set and cleared by its owner, as a condition (`selectWhere(...)`,
which later rows meet or not and which can run where the data lives) or a
row set (`selectRows(set)`); `store.condition(["brush", "legend"])` is the
conjunction of channels' conditions, to filter a view by. Nothing
propagates between views on its own: the application decides which views
read which channels, and grids and charts bound to a channel (below) write
and highlight it.

Point marks take a view where they take a table, `point(view, { x, y })`,
and draw only its rows, read from the table's columns, redrawing as the
view changes; a grid and a chart filtered by the same store share one copy
of the data. Points of a view are drawn on the CPU (not the WebGL painter),
size and color scales span the whole table, facets repeat them in every
panel (`facet: "repeat"`) rather than splitting them, and views have no
place in portable specs yet; other marks take tables only.

### Selected rows

A chart bound to a channel of a selection store writes the rows its brushes,
lassos, and clicks select there, and highlights the rows the channel holds,
whoever selected them: brushing one chart highlights the same records in
other charts and in grids sharing the channel, and keeps highlighting them
while rows stream in.

```ts
import { createChart, line, point, rowSelection, rowView, selectionStore } from "herceg";
import { createGrid, createGridModel } from "herceg/grid";

const focus = selectionStore(trips);
createChart(scatter, {
  marks: [point(trips, { x: "distance", y: "fare" })],
  interaction: { brush: "xy" },
  rowSelection: rowSelection({ store: focus, channel: "focus" }),
});
createChart(timeline, {
  marks: [line(trips, { x: "pickup", y: "fare" })],
  rowSelection: rowSelection({ store: focus, channel: "focus", events: [] }), // highlights only
});
createGrid(list, {
  model: createGridModel({ data: rowView(trips), columns, selectionStore: focus, channel: "focus" }),
});
```

`rowSelection(...bindings)` binds one store per table the marks read, each
`{ store, channel, events?, effect? }`: `events` are the gestures that write
(`"brush"`, `"lasso"`, `"click"`, all by default; `[]` for a chart that only
highlights), and `effect: "none"` writes without dimming. A brush or lasso
writes where `interaction.brush` draws one, and a brush that writes rows
selects rather than zooming (the wheel and dragging with Shift still zoom
and pan). Marks over tables without a binding neither write nor dim.

- **Brushes** write a condition on the marks' fields: a row is selected when
  its value along each brushed axis is in the brush's range (for error bars,
  bands, and candles, when its span overlaps it), so rows appended later that
  meet it are selected too. On category axes the condition lists the
  categories' labels (or a banded field's numbers or times), so it keeps
  holding when categories are renumbered. A mark's several y fields are its
  series: a row is in when any shown one is. Series hidden through the
  legend leave the condition, a point mark's row view adds its filter, and
  facet panels with x scales of their own that the brush leaves out leave
  their rows out. Each table gets its own condition; nothing joins tables.
  A point mark over a view restricted to a row set selects the view's rows
  in the brush, as rows.
- **Stacks** are drawn at their tops, not their values: a brush along a
  stack's values selects the rows drawn inside it, as a row set (and so the
  table's whole selection is one).
- **Lassos** select the rows whose drawn point is inside: a point's center, a
  line's or area's vertex, the middle of a bar's end, a span's middle, a
  candle's close, a heatmap cell's center, a rug tick's middle, each where
  it is drawn (dodged, jittered, or in a legend group's slot). Rows not
  drawn (a point missing a value it encodes, a time inside an axis break)
  are not selected.
- **Clicks** select the row of the point, bar, or rug tick under the pointer
  (within a few pixels of a point's own glyph), the rows a histogram bin
  counts (inside its bar as drawn, dodged or horizontal; from its left edge,
  or a cumulative bin's first, up to its right one, the last bin's
  included), those of a box plot's or violin's group with a value, or every
  row of a heatmap's cell; never a summary's index as a row. Shift adds to the selection, Ctrl or Cmd adds or
  removes, and a click off the data clears it. With the keyboard cursor on a
  point, Space does what a click does (with the same keys), and announces how
  many rows are selected; Escape clears; Shift with the arrow keys brushes a
  range as before.

Lassos and clicks write `RowSet`s of the table's generation, which keep their
rows while others are appended and dropped and are empty after a reset
(charts then draw every row again). Clearing a brush clears the channel only
while it still holds what the brush wrote; another view replacing it lets the
brush go. `chart.select(selection, { rows: false })` shows a selection without
writing its rows, as when mirroring another view's brush, and lets the
chart's own brush go (what it wrote stays in the channel). Histograms are
brushed along their bins and box plots and violins along their categories,
and lassos select no rows of them yet: the chart refuses those gestures in
its bindings (and a selection set through `select` selects none of their
rows).

Highlighting dims the rows the channel does not hold to a quarter of their
opacity: points and bars draw each row once, dimmed or not, in the place it
has without a selection (point series large enough for WebGL stay on the
GPU, as two clouds whose uploads follow streamed rows); lines and areas draw
as they are within the x spans of their runs of selected rows and dimmed
outside them, so each pixel is painted once and the highlighted part is the
same curve and stack (spans reach over a line's round caps where it ends,
and runs end at their outermost rows the mark draws, so rows it cannot
place, such as nonpositive values on a log axis, are left out; a line's
runs of one row drawn are dots; lines whose x does not ascend, and rows at
one x that spans cannot tell apart, selected together or in part, draw
their selected rows' values over the dimmed line instead). An empty selection dims every row. Other marks
(histograms, box plots, violins, error bars, candlesticks, heatmaps, rugs,
annotations, custom marks) draw every row as before. Charts showing one
selection share a byte per row of its table, tested again only for appended
rows while the selection stays the same (a row set changed in place is read
again). Highlights are a mounted chart's: its `toSVG()`
shows them, while `renderToSVG`, `renderToPDF`, and the spec exports draw
every row undimmed.

A map, treemap, sunburst, or network with a chart of its own selects rows
too. A click selects what is under the pointer: a region's or point's row, a
tree node's rows (its own and every node's under it), a network node's rows
of its nodes table or a link's rows (every row either way, for undirected
links) of its links table; an item that stands for no row of a bound table
(a network node only links name) changes nothing. A map's lasso selects the
regions whose anchor, a point inside each that stays the same at any zoom,
is inside it (a region it crosses but whose anchor is outside stays out),
and the points whose center is. Highlighting dims the regions, points,
nodes, and links none of whose rows are selected; a tree node with some of
its rows selected is drawn as selected, and its tooltip says how many ("3
of 12 rows selected"). Other layout marks, trees in facet panels or
subplots, and 3D charts cannot select rows yet and refuse a binding, as
charts with a layout mark in a panel of its own do.

### Row groups

`groupRows` groups the rows a view shows by the values of some fields, and
keeps each group's aggregates in an ordinary table, one row per group, that
charts draw and grids show:

```ts
import { col, count, groupRows, max, mean, rowView } from "herceg";

const failed = rowView(requests, { filter: col("status").ge(500) });
const byService = groupRows(failed, {
  by: ["service"],
  ops: { errors: count(), latency: mean("latency"), worst: max("latency") },
});
bar(byService.table, { x: "service", y: "errors" });
```

Values are read through the view's positions, so no column is copied. The
view's filter and restriction choose the rows; its sort orders each group's
rows but not the aggregates, which add up rows in table order: the values
`derive(...).filter(...).aggregate(...)` gives, from `count` (rows, or with a
field its finite values), `sum`, `mean`, `min`, and `max`, which leave out
missing and infinite values. Sums are compensated (each keeps what rounding
left out of it, and what it lost; one whose values cancel enough to make
that matter is summed again exactly from its group's rows), so a group's
sum stays within about an ulp of the exact sum of its rows, however rows
came and went, and can differ from a derived table's plain sum in the last
digits. A sum that overflows on the way (past about ±1.8e308) is infinite
until rows leave it. Groups come in the order they first appeared.

With several fields, groups nest: by the first field, then within each of
those by the second, and so on, in one computation. Each level has a table
of its own, with the grouping fields down to it, which charts read:

```ts
const traffic = groupRows(rowView(requests), {
  by: ["region", "service"],
  ops: { n: count(), latency: mean("latency") },
});
bar(traffic.tableOf("region"), { x: "region", y: "n" });
bar(traffic.table, { x: "service", y: "latency", series: "region" }); // the last level's
```

A level's aggregates are of its own rows: a region's mean latency is the
mean of its requests, not of its services' means (levels above the last add
up the sums and counts of the level below, or read their rows when those
cancel). `tableOf` is typed by the
fields `by` lists, so a chart of the regions' table cannot name `service`
(with `by` an array whose order TypeScript does not know, it names only
its own grouping field).

The tables follow the view. Appended rows update the groups they join, at
every level, and add the groups they start; rows a rolling window (`maxRows`)
or `dropFirst` drops are taken away from theirs the same way, reading no
other row, except a group whose minimum or maximum left, or whose sum lost
its accuracy, whose rows are read again. Anything else (a value the groups read changed in place, a new
filter or restriction, a reset) computes the groups again. Tables change
where their values differ, keeping the groups that remain in their order,
and start over only when one of their groups lost its last row. Each change
of the view's table is one change of each level's table, told once every
level's table is written, so their listeners find every aggregate and new
group in place. Treat the tables as read-only; they
keep the groups following, and `dispose()` stops them (their tables keep
their last values, and they list no rows).

A group's key is its path of values down to its level (`traffic.keyOf(g)`
for the last level, `keyOf(g, 0)` for the first): a label for categories, a
number for numbers and times, null where the value is missing. Keys name
groups however rows come, go, and sort, and across resets: `indexOf(key)`
finds a group by its key at the key's level, `groupOf(position, depth)` the
group of a table row, and `parentOf` and `childrenOf` move between levels.
`members(g, depth)` lists a group's rows (those of its groups below too),
and `memberAt(g, i)` gives the `i`th row of a last-level group in the view's
order. Groups hold 4 bytes per table row (each row's group); once a reader
lists groups' rows, about 6 more per shown row, kept current as rows
stream; and once the table drops rows (or from the start with `maxRows`),
8 bytes per table row, shown or not, for each field the aggregates read:
the values to take away. `byteLength` counts these and the groups' own
arrays, not their keys and maps. `groups.subscribe(listener)` is told
whenever the groups followed a change of their view or table, once they
caught up with any change their tables' listeners made meanwhile.

### Row pivots

`pivotRows`, from `herceg/pivot`, shows a view's rows as a crosstab: a row
for each value of one field, and a column for each value of another and
each aggregate.

```ts
import { bar, count, mean, rowView } from "herceg";
import { pivotRows } from "herceg/pivot";

const traffic = pivotRows(rowView(requests), {
  rows: "region",
  pivot: "service",
  ops: { requests: count(), latency: mean("latency") },
  totals: true,
});
bar(traffic.table, { x: "region", y: "requests", series: "service" });

const crosstab = traffic.read();
crosstab.values; // the services the rows hold, in column order: ["api", "web", "db"]
crosstab.value(0, crosstab.indexOf("web"), "latency"); // the first region's mean web latency
```

The aggregates are row groups' by the two fields, in one computation (see
Row groups): `traffic.table` has a row for each combination of a region and
a service that some request has, holding both fields and each aggregate,
which charts read as any table, and `traffic.rowTable` a row per region
with its totals, the aggregates of all its rows (a total mean is the mean of
the region's requests, not of its services' means). `read()` gives the
crosstab over them: its rows are `rowTable`'s, in the order their values
first appeared, and its `values` are the pivot field's values the rows
hold, in column order: categories in the order of their field's dictionary,
numbers and times ascending, missing last. `cell(row, index)` is the
position in `table` of a row's combination with the value at `index`, or -1
where none of the row's rows has that value: the combination is absent.
`value(row, index, aggregate)` reads an aggregate: undefined where absent;
where present but its field's values are all missing, as groups have it: a
count of rows the rows it has, a count of the field and a sum 0, a mean,
minimum, or maximum NaN. With `zeroFill: "count"` absent combinations'
counts read 0. `members(row)` and `cellMembers(row, value)` list the positions of a
row's or a combination's rows, to drill down. Rows and value indexes are the
crosstab's own, valid until it changes; values and keys are not.

`crosstab.columns` lists the columns generated: each value's aggregates,
then with `totals` a total per aggregate. A column's `id` is JSON text of
the pivot field, the value with its kind (`category`, `number`, or `time`),
and the aggregate's name, operation, and field, or a total's tag instead of
a value: never a place, a label as shown, or a dictionary code, so ids stay
as values come and go, and a category named "1", "null", or "Total" is not
the number 1, the missing value, or the totals.

The pivot follows its view as groups do: appended rows update the
combinations they join and add those they start, and the crosstab extends
with them; rows a rolling window drops leave theirs, and a combination or
value left without rows goes. Its index is a dense array of every row and
value while there are at most about a million of them (4 MiB), extended in
place; past that it is sparse, each row's values and positions, built again
whenever combinations are added (about 2–3 ms for 1,000 rows appended to
70,000–80,000 combinations, where appends to existing combinations take
about 0.7–1.3 ms, view and groups included; one-off Node measurements).

Pivots are bounded. These are the defaults:

```ts
pivotRows(view, {
  rows: "region",
  pivot: "service",
  ops: { requests: count() },
  limits: { generatedColumns: 1024, observedCombinations: 1_000_000, ownedBytes: 128 * 2 ** 20 },
});
```

Generated columns count each value's aggregates and the totals. Owned
bytes limit an estimate of the memory the pivot keeps beyond its view and
table: its groups' typed arrays as they hold them now, what growing takes,
and the most that listing their rows and reading a group's rows again can
still take; the index and the tables with their room; and maps, keys, and
the generated columns by fixed allowances per entry. The typed arrays a
pivot holds stay within it, but it is not a cap on the heap: strings longer
than the allowances (long labels, which column ids repeat) and the
runtime's own object overhead can take more, and neither the moment an
array grows (when the old one and the new one are both held) nor the
source counts. Over the workloads measured it came to 1.5 to 4.2 times the
memory kept, before any rows were listed. `pivotRows` throws a `PivotLimitError`,
naming the `limit`, what the pivot reached (`observed`), and its `budget`,
as soon as one is passed and before the groups grow further. A pivot that
is following its view counts what a change would make it before changing
anything; when that passes a limit it stops where it was instead of
throwing to the table's other listeners: its tables and crosstab keep what
they held, its rows list their rows as they were then (those still in the
table, whatever the view shows now), its `subscribe` listeners are told,
and `failure` holds the error.
No value is dropped to stay within a limit. Recreate the pivot over a
narrower view, or with larger limits, to go on. While rows stream, a
combination that a batch's dropped rows leave empty still counts as the
batch is counted. A pivot's `subscribe` listeners hear of a change once it
followed it (read its tables there, not in listeners of the view or table
subscribed before it); `dispose()` stops a pivot, leaving its view.

Over a million rows, a pivot of 100 regions by 10 or 100 services and three
aggregates takes about 40 ms to build and keeps about 4–6 MiB, a sixth of
the source's 23 MiB; with 100,000 regions each holding two of the
services (about 200,000 combinations), about 0.16–0.28 s and 73 MiB, most of
it the groups' maps, keys, and tables, of which 39 MiB are typed arrays
(`byteLength`). The index takes at most about 5 ms of that; the rest is
grouping, so a pivot costs about what grouping by its two fields does, up
to a fifth more where nearly every row starts a group (one-off Node
measurements, Apple M6). A thousand services of three
aggregates pass the default column limit.

## Marks

```ts
// One line per y field, sharing x.
line(metrics, { x: "time", y: ["p50", "p99"] });
// Long format: one line per category value.
line(requests, { x: "time", y: "latency", series: "service" });
// Options: stroke, strokeWidth, dash, curve, label. `curve` is "linear", "step",
// "step-before", "step-after", or "monotone": smooth, through every point, and
// never past a point's value between two points; points under 2 pixels apart
// are joined straight. Areas take it too (bands and stacks on log y are straight).

const usage = table({ time: time(timestamps), user: userCpu, system: systemCpu });
area(usage, { x: "time", y: "user" }); // filled to zero
area(usage, { x: "time", y: ["user", "system"], stack: true });
// Long format: a layer per category value, stacked on every x any of them has.
const responses = table({ minute: time(minutes), status: statusCodes, count: counts });
area(responses, { x: "minute", y: "count", series: "status", stack: true });
area(responses, { x: "minute", y: "count", series: "status", stack: true, stackGaps: "interpolate" });
area(metrics, { x: "time", y1: "p50", y2: "p99" }); // band between two fields
// A single area is outlined along its top in its own color; stacks and bands
// are not unless `line: true`. `stroke` and `strokeWidth` style the outline and
// turn it on; `line: false` or a width of 0 turns it off.

// Over categories: points at the bands' centers, on the bars' band scale.
bar(sales, { x: "month", y: "units" });
line(sales, { x: "month", y: "target" });
line(stats, { x: "day", y: "mean", series: "sex", dodge: true }); // beside grouped bars
// Along y: positions on y, values on x, read by y.
line(casts, { x: "temperature", y: "depth", orient: "y" });
line(casts, { x: ["temperature", "salinity"], y: "depth", orient: "y" });
line(stats, { x: "tip", y: "day" }); // a category y lays a line along y, as bars lie
area(casts, { x: "density", y: "depth", orient: "y" }); // filled to x = 0
area(casts, { y: "depth", x1: "low", x2: "high" }); // a band along y
```

### Normalized stacks and streamgraphs

Areas accept `stack: true | false | "fill" | "center" | "wiggle"`; bars accept
`true | false | "fill"`. Histogram `stack: "fill"` has the same meaning: each
position's visible layers share its total.

```ts
area(usage, { x: "time", y: ["user", "system"], stack: "fill" });
area(usage, { x: "time", y: ["user", "system"], stack: "center" });
area(usage, { x: "time", y: ["user", "system"], stack: "wiggle", stackOrder: "inside-out" });
bar(sales, { x: "region", y: ["q1", "q2"], stack: "fill", labels: { style: "percent" } });
```

`"fill"` divides each finite contribution by the visible total at its position.
Its automatic value domain is 0–1; set that axis's `format: { style: "percent" }`
to display percentages. An all-zero total has zero thickness. Finite negative
contributions are refused, including mixed signs: use `stack: true` for signed
values, or transform the data explicitly. NaN and infinities draw no segment
and count as zero in totals. A missing layer keeps its gap; the other finite
layers still normalize to their own total. Repeated bar positions include all
rows at that position in the denominator.

`"center"` (silhouette) starts each position at minus half its total, symmetric
about zero. `"wiggle"` uses the Byron–Wattenberg weighted-slope stream baseline,
matching d3-shape's wiggle offset, starting at zero at the first retained
position. Both keep raw thickness, require nonnegative contributions, and use
the computed raw extent on a linear value axis. A boundary's coordinate is
an offset, not a measured value. Missing contributions count as zero in the
wiggle calculation while retaining their own gaps. Center treats contributions
as nonnegative thicknesses: it rejects signed inputs that d3's silhouette offset
accepts algebraically. It does not separate positive and negative layers as
d3's diverging offset does; use `stack: true` for signed values.

The default `stackOrder: "input"` keeps field or legend order. For these three
nonnegative area modes, `"inside-out"` orders layers by their peak's position
and balances their totals on either side; legend identities and colors stay
in input order. Geometric ordering uses the retained data, independent of zoom.

All modes work over number, time, and category positions, along x or with
`orient: "y"` along y; horizontal bars normalize across x. Series-field areas
resolve `stackGaps` before totals and offsets: absent rows are zero, or linearly
interpolated between finite bracketing rows at actual position distances, zero
beyond the ends. Interpolation does not bridge explicit missing values. Tooltips
and keyboard readings report observed rows only. For fill, their text shows the
share and raw value; inspection events keep `value` as the raw source value
(histograms keep their bin share as `value`, with raw counts or weights in text).
Stream readings show raw values using the value axis's tooltip format. Bar value
labels show shares for fill, formatted by `labels`, and raw values for ordinary stacks. Areas have series labels but no
per-value labels.

Hiding a legend layer renormalizes or reoffsets the visible layers. Facets and
subplots stack independently; zoom changes the view, not the denominators or
baselines. SVG, Canvas, and static exports use the same stack. Input-order fill
and center retain incremental append/drop updates; wiggle and inside-out
recompute over the retained window when data or visibility changes. Facet field
stacks compute within each panel and cache their boundaries across unchanged
redraws. Along-x input-order area stacks animate value changes as ordinary stacks do; inside-out updates display immediately because
ordering can change, and areas along y retain their existing immediate updates.

Stacks put the first layer at the bottom: fields in the order given, a
series field's values in the order of its legend. Areas of a series field
stack on every x any shown series has a row at. At an x where a series has
no row it counts as zero (`stackGaps: "zero"`, the default, right for counts
a query leaves out), or with `"interpolate"` as the straight line between
its rows on either side (right for series sampled at different times), and
as zero beyond its first and last rows. A missing value draws nothing and
counts as zero for the layers above, as in stacks of fields. Several rows of
a series at one x pair up with the others' rows there in order, a series
with fewer holding its last, so steps drawn by every series stay steps.
Tooltips, the keyboard, and the text alternative read each series' own rows,
at the top of its layer (at an x where the keyboard's series has several
rows, the others' rows of the same occurrence); hidden series leave the
stack, and the x positions only they had. On a log y axis, stacks stand on
the axis' low end, and layers standing on zero are drawn down to it, in
stacks of fields too.

Lines and areas run along an axis of positions: x, or with `orient: "y"`
y, as depth profiles and densities of y do, with their values on x.
`orient` is inferred from a category `y` with values on `x`, as bars lie
along a category y; several value fields need it (`x: ["a", "b"]` with
`orient: "y"`). Positions are numbers, times, or categories; on a category
axis each row is placed at its band's center, and a series' rows are drawn
in band order (rows of one band in theirs), whatever their order in the
table, so a line runs through the months of a bar chart's axis in order.
Rows without a category are left out; a missing value breaks the line, as
along a number axis. On a category axis, `dodge: true` with a `series`
field places each series' line or area through its share of the bands, as
grouped bars and dodged points stand (by the legend group's series, in a
group), and tooltips, the keyboard, and highlighted rows find points where
they are drawn. Areas along y fill across x to zero (or stack along x, or
fill the band between `x1` and `x2`). Lines and areas along y are traced,
and reduced to about four points per pixel row, along y; tooltips default
to "nearest-y", reporting every series at the y nearest the pointer (each
series scanned, not searched), and the keyboard steps through each
series' rows in order. They use the left y axis (`axis: "right"` is
refused, as for horizontal bars), and span their positions whatever x
shows; zooming along y does not rescale x.

A finite line row with no finite neighbor is a round dot whose diameter is
its stroke width. Areas show the dot on their upper edge, in the outline
color when present and otherwise the fill color. This applies to step and
smooth curves, either orientation, reduced data, and SVG, Canvas, and PDF.

Annotations take constant positions (numbers, or `Date`s on time axes), or
draw one item per row of a table when a position is a field. `label` is
constant text; `textField` names a category or number field with each item's text.

```ts
rule({ y: 250, label: "SLO" }); // horizontal reference line
rule(deploys, { x: "time", textField: "version" }); // a vertical rule per deploy

region({ x1: start, x2: end, label: "Maintenance" }); // shaded x range
region(incidents, { x1: "start", x2: "end", textField: "title" });
region({ y1: 200, y2: 300 }); // shaded y range; with x1/x2 too, a rectangle

text({ x: launch, y: 120, label: "Launch", anchor: "start", dx: 6 });
text(peaks, { x: "time", y: "value", textField: "value", dy: -10 });
text(cities, { x: "gdp", y: "growth", textField: "name", dy: -10, overlap: "move" });
```

Annotation positions count toward the axis domains, so thresholds and events
stay in view; on a category axis, a constant position is a band index (0 is
the first band, -0.5 its edge). Regions are drawn in mark order (list them first to shade
underneath the data); rules and text are drawn above the data, as SVG even
when the data is on a canvas. Text and region labels have halos to stay
readable over lines. A halo uses the background at full opacity when its
contrast with the text is at least 3:1; otherwise it uses the existing
light/dark fallback. `halo: false` disables it on `text`, `region`, `bar`,
`funnel`, `radar`, `sankey`, and `graph` (both node and link labels), and on
`rangeNavigator({ halo: false })`. Marks that choose halos only where needed
keep that choice by default. These rules also apply to static SVG and PDF.
Annotations outside the view are left out. Text labels that would
cover an earlier label of the same mark, in row order, are drawn anyway by
default. With `overlap: "hide"` they are left out. With `overlap: "move"`,
a label goes where `anchor`, `dx`, and `dy` put it if that is free and in
the plot; otherwise it tries above, below, after, before, and at the corners
of its point, a few pixels away and off the other rows' points, then the same
places a label's height or two farther out, with a thin line back to its
point that crosses no other label, point, or line, and is left out if none
of those is free. Every label tries its near places before any goes farther
out, so sorting the table sets which labels win within each of the two
rounds.
Empty labels take no room. Placement measures text with the browser's fonts
on screen and with estimated widths in static SVG and PDF output, so the two
can place labels differently. Text is meant for annotations and labeling a
few hundred points, not every point of a large series. In charts with
facets, annotations over a table draw each row in its own row's panel, and
labels keep off the labels of their own panel only (see [Small
multiples](#small-multiples)).

When a bar's `series` is its category position field (`x` for vertical bars,
`y` for horizontal bars), categories retain their colors and legend entries
and each bar occupies the full band. Value labels use that full band's room;
series of another field still stand side by side.

Bars, points, error bars, heatmaps, contours, candlesticks, histograms, box plots, letter-value (boxen) plots, and violins:

```ts
const sales = table({ region: regions, q1: q1Sales, q2: q2Sales });
bar(sales, { x: "region", y: ["q1", "q2"] }); // grouped; stack: true stacks them
bar(sales, { x: "q1", y: "region" }); // a category y gives horizontal bars
bar(requests, { x: "time", y: "latency" }); // number or time x: bars centered on values
bar(sales, { x: "region", y: "q1", labels: true }); // values at bar ends; Intl options format them

point(cars, { x: "weight", y: "mpg", series: "origin", radius: 3 });
point(countries, { x: "gdp", y: "life", size: "population", series: "continent" }); // bubbles
point(stations, { x: "lon", y: "lat", color: "temperature", colors: viridis });
point(cars, { x: "weight", y: "mpg", symbol: "origin" }); // a shape per origin
point(requests, { x: "region", y: "latency" }); // a category x places points in its bands
point(tips, { x: "day", y: "tip", series: "sex", dodge: true, jitter: { width: 0.5 } }); // strips
point(tips, { x: "day", y: "tip", swarm: true }); // a beeswarm: packed without overlap
errorBar(stats, { x: "group", y1: "low", y2: "high" }); // y, x1, x2 for horizontal ones
errorBar(stats, { x: "group", y: "mean", yError: "se" }); // mean ± se

const load = table({ hour: time(hours), host: hostNames, cpu: cpuValues });
heatmap(load, { x: "hour", y: "host", color: "cpu" }); // cells along a time axis, a row per host
heatmap(load, { x: "hour", y: "host", color: "cpu", xStep: 3_600_000 }); // an hour wide; gaps where hours are missing
heatmap(load, { x: "hour", y: "host", color: "cpu", xBanded: true }); // a column per distinct hour
heatmap(spectrum, { x: "time", y: "frequency", color: "power", sampling: { reduce: "max" } }); // grids larger than the plot
heatmap(events, { date: "day", color: "count", reduce: "sum" }); // rows of one day summed in its cell
heatmap(commits, { date: "day", color: "count" }); // a calendar: weeks along time, a row per weekday
heatmap(commits, { date: "day", color: "count", calendar: "months" }); // a row per month, a column per day
heatmap(cells, { x1: "x0", x2: "x1", y1: "y0", y2: "y1", color: "n" }); // cells between edges, as bins give them

contour(field, { x: "x", y: "y", color: "density" }); // lines at about 10 round values
contour(field, { x: "x", y: "y", color: "density", thresholds: [0.01, 0.05, 0.1, 0.2], variant: "bands", colors: viridis });

candlestick(prices, { x: "day", open: "open", high: "high", low: "low", close: "close" });
candlestick(prices, { x: "day", open: "open", high: "high", low: "low", close: "close", variant: "ohlc" });

histogram(requests, { x: "latency" }); // counts in round bins
histogram(requests, { x: "latency", series: "region", bins: { step: 10 }, normalize: "percent" });
histogram(requests, { x: "latency", series: "region", stack: "fill", element: "step" });
histogram(penguins, { x: "flipper", y: "mass", bins: { x: 30, y: 20 } }); // a 2D histogram's cells

boxplot(requests, { x: "region", y: "latency", series: "version" });
boxplot(requests, { x: "latency", y: "region" }); // a category y lays boxes along y
boxen(requests, { x: "region", y: "latency" }); // nested boxes out to the tails' letter values
violin(requests, { x: "region", y: "latency" }); // kernel densities, quartiles inside
// `fill` gives every box or violin one color; `fillOpacity` is 0.25 by default (boxen 0.7).
```

Bar labels go past each bar's end, or for stacks inside each segment in a
color that contrasts with it; labels that do not fit are left out. A category
field on `x` or `y` (bars, points, lines, areas) or on `x` and `y` (heatmaps,
points) gives a band axis. Categories on a y axis run top to bottom; long names are shortened
with an ellipsis. Points on a category axis sit at the centers of its bands
(strip and dot plots, over bars too), and are drawn on the CPU however many
there are; on a category y axis, a point's tooltip shows its category and
its reported `value` is the category's band index. Horizontal bars default
to "nearest-y" tooltips, which report every series in the band under the
pointer. Heatmaps show a color legend instead of series entries.

On a category axis, `dodge: true` places a point or error bar mark's series
side by side within each band, as grouped bars place theirs: the band is
split among the series shown, in their order, so error bars over grouped bars
of the same table and series field stand on their bars, and hiding a series
regroups both. `jitter: { width, seed }` spreads points across their band, or
with `dodge` their series' share of it, over `width`, a fraction of it from 0
to 1: each point moves by a hash of its row's identity and `seed` (0 by
default), not by a random draw, so it stays where it is as the chart redraws,
resizes, and streams, rows dropped before it included. Both need a category
`x` or `y` (not both), and `dodge` a series field. Tooltips, the keyboard,
and the nearest-point search find points and intervals where they are drawn,
and report their values, not where they were moved to.

`swarm: true` packs points across their band (or, with `dodge`, their
series' share of it) without overlap instead, as a beeswarm: in order of
their values, low to high, each point goes to the free place nearest its
band's center, a clearance of half a pixel from the points placed before
it. Points that find no place inside the band stand at its nearer edge,
over others, as Seaborn's do, and leave the room to the points after them;
a point tests itself against at most 512 placed neighbors, past which it
stands at an edge too, which keeps the work bounded. The layout depends on
pixels, so it is made again for each panel as the chart resizes and zooms,
of the points in view (and a radius past it), with every series of a mark
sharing each band's swarm (or each series its slot, dodged); appending rows
can move the points beside them. A swarm takes the place of `jitter`, and
refuses it and `sampling: "pixel"`. Laying out 10,000 points in one band
takes about 2 ms, 100,000 about 21 ms (Node, Apple M6).

```ts
bar(stats, { x: "day", y: "mean", series: "sex", legendGroup: "sex" });
errorBar(stats, { x: "day", y1: "low", y2: "high", series: "sex", dodge: true, legendGroup: "sex" });
```

`legendGroup` names a group of marks that share their series by name: in
one chart, series of the same name (their `series` value, or a single-series
mark's `label`) in marks of the same group take one palette color, one legend
entry, and one visibility, so a bar and its error bars, a line and its band,
or points and their fit hide and show together. Explicit `fill` and `stroke`
colors still apply (the legend entry shows the first member's color).
Side-by-side marks of a group (grouped bars, box plots, violins, dodged
histograms, points, and error bars) take their slots from the group's
visible names, so an interval stands on its bar even when one mark lacks
some of the group's series. Tooltips, the keyboard, and summaries still
read each mark's own series. A group's entry has a key of its own, which
`getLegend`, `setVisibility`, and `visibility` events use (a member series'
own key acts on its group's entry); it stays hidden across updates while a
mark names the group.

Heatmaps over number and time fields place their cells along number and
time axes, which zoom, pan, and brush as other marks' do, and other marks
share them. Each distinct value is a cell reaching halfway to the values
beside it; the first and last reach as far past their values as toward
their neighbor, and a lone value spans what the axis would show for it
alone (a tenth of the value either way, one either way of zero, an hour
either way of a time). Edges come from the data, never from the view, so
zooming never moves them. With `xStep` / `yStep` (milliseconds for times),
each cell is that wide around its value, but never past halfway to a closer
neighbor, so missing values leave gaps. Gaps and the space past the cells
show nothing and report no tooltip. Across a clock change, local midnights
are 23 or 25 hours apart; the default placement puts the boundary halfway in
elapsed time, where a step of a day would leave an hour's gap. `xBanded` / `yBanded` give one column (or row) per
distinct value instead, in ascending order, as category fields always have;
banded axes do not zoom. Automatic y domains end at a heatmap's cell edges
rather than at round values (`y: { nice: true }` rounds them). Heatmap
cells refuse log axes for now. On a time axis with breaks, rows inside
breaks are not drawn, and the cells either side of a break meet at its seam
as if the break took no time.

A heatmap of a `date` (a time field) lays out its days as a calendar in the
chart's time zone. `calendar: "weeks"` (the default) puts a column per
week, from the start of the week to the next week's start, along a time x
axis, which zooms and labels months or years as any time axis does, and a
row per day of the week, from `weekStart` (`"mon"` by default) down.
`calendar: "months"` puts a row per month, every month from the first
day's to the last's, and a column per day of the month, 1 to 31. Days
without rows, and dates a month lacks, are empty; rows sharing a day share
its cell. Calendars take no `x`, `y`, steps, or bands, and refuse time
breaks; weeks brush and zoom by time, a week column at a time.

Rows sharing a cell (the same x and y, or a calendar's day) combine into
its value by `reduce`: `"last"` (the default), the last of them with a
value, or their `"mean"`, `"sum"`, `"min"`, or `"max"`. A cell keeps its
value at every zoom, and tooltips, the keyboard, and the summary read it;
its row (in events) is the last of its rows with a value, clicks and
brushes select every one of them, and with `"sum"` the color scale runs
over the cells' sums. Combining costs a sort of the rows by cell, once per
table version, and a value per row only for tables with cells that rows
share.

`x1` and `x2` (or `y1` and `y2`), number or time fields, place each row's
cell between two edges instead, as the bins of `bin(..., { end })` give
them: one cell per distinct first edge, reaching to its rows' second, so
cells of unequal widths stay exact. Rows of one first edge must have one
second edge, and cells must not overlap; either is refused with an error.
These cells take no `xStep` or `xBanded`, nor time breaks yet; tooltips say
their edges.

A heatmap draws one pixel per cell while its cells are evenly spaced (bands,
or values one step apart, with or without gaps) and fit the plot's device
pixels. A grid with more columns (or rows) than that, such as 4,000 x 4,000
cells on a plot 1,500 device pixels wide, is drawn at the plot's resolution
instead: each pixel shows the block of cells whose left (or top) edges fall
in it, colored by the mean of their values, or with
`sampling: { reduce: "max" }` or `"min"`, by the greatest or least, which
keeps single hot cells visible. Unevenly spaced cells are drawn at the
plot's resolution too, each pixel colored by the cells it holds parts of:
within one cell, by that cell's value; across several, by the mean of their
values weighted by the area of each cell in the pixel, or the greatest or
least of them with `sampling`. Each cell counts once, by its value, however
many rows share it. Missing and NaN values are left out, and pixels without
values are transparent. Tooltips still report the single cell under the
pointer, or nothing when that cell has no value. Static SVG and PDF output,
which are zoomed and printed, reduce only past two pixels per CSS pixel.
Drawing costs one pass over the table's rows (each zoom or pan draws
again), and memory follows the rows and the plot's pixels, not the number
of cells, so there is no cell limit.

Points encode fields as well as positions. `radius` is every point's radius
in pixels (2.5 by default); `size` instead names a number field sizing points
by area, from zero (or the least value, when values are negative) at
`radiusRange[0]` pixels to the largest at `radiusRange[1]` (default [2, 12]),
with a key of round values below the legend. A mark takes `radius` or `size`,
not both. `fillOpacity` names a field mapped from
0.15 to opaque. `color` names a number or time field colored on a continuous
scale, with a color legend, or a category field whose values take the
theme's palette in order of appearance (cycling through at most its first
255 colors), keeping their colors while they stay in the table, with a key of
colors below the legend; series then appear in
the legend in a neutral color (a `color` naming the `series` field keeps the
series' colors). Marks with the same color scale, or the same key of sizes,
shapes, or colors, share one legend.
`symbol` is one shape (`"circle"`, `"square"`, `"triangle"`, `"diamond"`,
`"cross"`, `"star"`, `"wye"`, `"triangle-down"`) or a category field whose
values take the shapes in that order, with a key unless the field also splits
series: `{ field: "origin" }`, or the field's name. A name that is both a
shape and a field is refused rather than guessed at; `{ field }` encodes the
field, and specs always name fields that way. Every shape covers the area of a circle of the same radius. Points
missing a value they encode are not drawn, and tooltips name the encoded
values. Encoded points are drawn on the CPU (Canvas or SVG), not by the WebGL
painter; opaque ones are drawn one color at a time, high values last.
`stroke` and `strokeWidth` outline every point: `stroke` alone draws a 1 pixel
outline, and `strokeWidth` alone one in the chart's background color, which
keeps overlapping points apart; a width of 0 draws none. Legends show outlines
of a color of their own, so hollow points (`fill: "transparent"`) keep a
swatch. Outlined points are drawn one by one on the CPU too.

Continuous color (`colors` on heatmaps and on points with `color`) takes a
ramp of `#rgb` or `#rrggbb` colors from low to high. Named schemes are
exported one by one, so a bundle carries only those it imports: sequential
`viridis`, `magma`, `inferno`, `plasma`, `cividis`, `turbo`, `blues`, `greens`,
`greys`, `oranges`, `purples`, `reds`, `ylgnbu`, `ylorrd`; diverging `rdbu`,
`rdylbu`, `brbg`, `piyg`, `prgn`, `puor`, `spectral`; and categorical
`tableau10`, `category10`, `set2`, `dark2` (for a theme's `palette`). Specs
name schemes as strings (`"colors": "viridis"`). `colorDomain` fixes the
values at the ramp's ends (others are clamped), and `colorMidpoint` maps a
value to the ramp's middle color, each side onto its own half, for diverging
data; with a midpoint and no `colors`, the theme's `diverging` ramp is used.
A midpoint outside the data widens the scale to include it, so the legend
then runs from the midpoint; with `colorDomain`, it must lie inside the domain.

Candlesticks that close at or above their open are hollow, in the theme's
`rise` color (or the mark's `rise`); others are filled in `fall`, so direction
does not rest on color alone while candles are a few pixels wide. Tooltips
report all four prices, and the nearest-point search measures from the
close. Rows missing a price are left out; high and low widen to cover open
and close. When more candles are in view than the plot has pixels, each pixel
column's candles merge into one: the open of its earliest candle, the close
of its latest, and its highest high and lowest low. Merged candles are too
thin to show hollow bodies, so there direction is shown by color only.
`variant: "ohlc"` draws bars instead: a line from low to high with the open
ticked to its left and the close to its right, in `rise` or `fall`, so the
order of the ticks shows direction too.

Histograms take a number or time field: `x` for vertical bars, `y` for
horizontal bars, whose lengths run from x = 0, or both for a 2D histogram
(below). Horizontal histograms use the left y axis and refuse
`axis: "right"`.

```ts
histogram(requests, { y: "latency", bins: [0, 10, 25, 100] });
histogram(requests, { x: "latency", series: "region", normalize: "probability",
  commonNorm: true, cumulative: true, dodge: true });
```

Bins are shared by every series. Default edges are round numbers (multiples
of 1, 2, or 5 times a power of ten) or calendar intervals in the chart's time
zone. By default there are about log2(n) + 1 bins for n values, at most 1,000.
`bins` takes an approximate count, `{ step, start }` for fixed widths
(milliseconds for times), or a `readonly number[]` of exact edges. Explicit
edges must be finite and strictly increasing, with 2 to 1,001 entries;
invalid edges throw a `RangeError`. They are copied and used exactly as given,
shared across all series and panels, without rounding, extending, or
coarsening. Time edges are epoch milliseconds. Each bin holds
`edges[i] <= value < edges[i + 1]`, and the last also holds its right edge,
as in NumPy. Non-finite values and values outside the edges are left out.
Values below a fixed `start` are also left out.

`weight` names a number field each row counts as, in place of 1: counts
become sums of weights, and probabilities, percents, and densities shares of
them. Rows missing a weight, or with a negative one, are not counted, and
summaries say how many were left out.

`normalize` defaults to `"count"`. `"frequency"` divides each bin's count by
its width (counts per unit of the binned axis). `"probability"` divides each bin's count by
its series' total count in the bins; `"percent"` multiplies that by 100.
`"density"` divides probability by that bin's width, so each series has area
1 (per millisecond for times). `commonNorm: true` additionally multiplies
probability, percent, or density by that series' share of finite field values,
counted before values outside the bins are dropped. Its denominator includes
all series, including those hidden through the legend; hiding a series does
not rescale the others. It has no effect with count normalization.

`cumulative: true` accumulates each series' counts, probabilities, or percents
through the current bin. Cumulative density integrates each bin's density
by its width, so the final bar is 1, or the series' share with common
normalization (0 when there are no values in bins); cumulative frequency
integrates to counts, as Seaborn's does. Accumulation precedes
stacking. Tooltips report a cumulative range from the first edge to the
current right edge, and summaries identify cumulative bars.

Several series overlay translucently by default. `stack: true` stacks them,
and `stack: "fill"` stacks them as shares of each bin, so each bin's visible
series reach 1 (bins holding nothing hold no shares, and tooltips report
shares); `dodge: true` places visible series side by side within each bin,
in series order (or, in a legend group, the group's order), with opaque
fills by default. Dodge and stack exclude each other in types and at runtime.
`element: "step"` draws each series as an area whose top steps across its
bins, and `"poly"` as one through the bins' centers, both outlined along
their tops, at an opacity of 0.75 (0.25 overlaid) and stacked as bars are;
they take no `dodge`. Tooltips, brushes, and clicks read their bins as they
read bars. The
one-pixel gap between sufficiently wide bins stays; hiding a series gives its
slot to the others. Tooltips report a bin's center and edges as its data
position; the pointer finds, and keyboard reading anchors on, each dodged
bar where it is drawn. A bin whose center is out of view has no tooltip.

With facets, each panel counts its own rows. Automatic/fixed bins are chosen
from rows in panels sharing the binned axis (`resolve.x` for vertical,
`resolve.y` for horizontal), per panel, row, or column when requested. Rows
without a facet value widen no bins. Normalization and common normalization
are local to each panel, and a series absent from a panel has no bars there
but keeps its dodge slot, so a series stands in the same place in every
panel. Subplots draw their marks whole, with their own bins. Bins are
chosen again only when data changes, never on zoom.

With `x` and `y` both, a histogram counts pairs: each row whose x and y are
both values counts (as 1, or its `weight`) in the cell of its bin of each,
the last bin along each axis holding its right edge, as NumPy's
`histogram2d` does. `bins` bins both axes alike, or each with `{ x, y }`;
by default each axis gets about log2(n) + 1 round bins over the pairs.
Cells are colored on a continuous scale from 0 to the fullest cell
(`colors`, `colorDomain`, and `colorMidpoint` as for heatmaps), with a ramp
in the legend; `normalize` measures them as for bars, `"frequency"` and
`"density"` per unit of bin area, so densities integrate to 1 over it.
Cells holding nothing are not drawn and have no tooltip, as Seaborn leaves
them. Tooltips name a cell's two bins and what it measures (a cell is no
one row, so they take no `tooltip.fields`), the keyboard
steps cell by cell as in heatmaps, clicks select the rows a cell counts,
and brushes the rows whose x and y they cover. With facets, each panel
counts its own rows in bins chosen from the panels sharing its x scale
along x and its y scale along y, on one color scale. A 2D histogram counts
one distribution: it takes no `series` (facet instead), stacks, dodges,
cumulative counts, or elements, and refuses log axes and time breaks for
now.

```ts
histogram(penguins, { x: "flipper", y: "mass", bins: { x: 30, y: [2500, 3500, 4500, 6500] },
  normalize: "density", colors: viridis });
```

Bins are drawn as one image, as heatmap cells are; counting a million pairs
in 50 × 50 bins and drawing them takes about 12 ms (Node, Apple M6), and
static SVG holds the image, about 18 KB for those bins and 220 KB for
200 × 200 (26 KB gzipped).

### Contours

`contour` draws a field sampled on a grid: each row the field's value
(`color`, a number field) at an `x` and a `y` (number or time fields) of a
rectilinear grid, the distinct x values crossed with the distinct y values,
evenly spaced or not; a matrix table (`fromMatrix`) holds such a grid as it
is. `variant: "lines"` (the default) draws a line where the field crosses
each threshold; `"bands"` fills the regions from each threshold up to the
next, the last holding its upper threshold too, and leaves values outside
the thresholds unfilled. `thresholds` is about how many round values across
the field's values (10 by default; for bands, round edges covering them), or
the values themselves, increasing; they are the same in every facet panel.

```ts
const field = fromMatrix({ x: xs, y: ys, density: values }, { x: "x", y: "y" });
contour(field, { x: "x", y: "y", color: "density", thresholds: [0.01, 0.05, 0.1, 0.2],
  variant: "bands", colors: viridis });
contour(field, { x: "x", y: "y", color: "density", stroke: "#334155", strokeWidth: 1 });
```

Contours are traced by marching squares, with values interpolated linearly
along the grid's edges at its own coordinates. A cell whose corners
alternate above and below a threshold joins its high corners through its
middle when the bilinear interpolant's value at its saddle is at or above
the threshold (the asymptotic decider), so contours never cross, and
neighboring cells find a crossing by the edge it is on, so rings always
close. A grid point without a value (NaN, or a pair no row gives) leaves out
the four cells around it, as a hole; contours end where the grid does. A
value exactly at a threshold counts as at or above it. Bands are disjoint
polygons with holes: a band's rings are its lower threshold's and its upper
one's, filled by the even-odd rule, so neighboring bands share their
boundary, and a band the field passes over (above both of its thresholds)
has no region. Rows scattered rather than on a grid (values at fewer than a
quarter of the grid's points) are refused: bin them with a 2D histogram, or
estimate a density.

Each band (or line) is a series, in order, and its regions (or lines) its
points: tooltips name the field and the band's range or the line's level,
at the pointer, inside a region or within a few pixels of a line; the
keyboard reads the bands in order, Up and Down between them and Left and
Right through a band's regions, each at a point inside it. The legend keys
each band's color and range (each line's color and level; none with one
`stroke`). Colors are the field's values on the ramp (a band at its middle
value), over `colorDomain` or the field's extent, as a heatmap of the field
would color it. Regions and lines are not rows, so clicks and brushes select
none of them, and tooltips show no `tooltip.fields`. With facets, each
panel's rows are a grid of their own.

Tracing runs once per grid and thresholds: changing colors redraws what was
traced, and zooming and panning project it again, leaving out rings wholly
out of view. A 1,000 × 1,000 grid of a smooth field traces ten thresholds
in about 14 ms; one of uniform noise, whose cells each cross six of the ten
on average, in about 550 ms, making 7.6 million points in 850,000 rings
(81 MiB), which a zoom projects again in about 75 ms (Node, Apple M6).
Contours are drawn as polygons and lines on a canvas or in SVG, and as
vectors in static SVG and PDF, every traced point kept: ten bands of a
smooth 200 × 200 grid export as about 200 KB of SVG (41 KB gzipped) or
170 KB of PDF, and of a 1,000 × 1,000 one about 1 MB of either. Contours
refuse log axes and time breaks for now, and have no labels along their
lines yet.

Box plots accept raw values or precomputed statistics. Raw boxes summarize a
number or time field per category of the other axis: quartiles use linear
interpolation between ranks, as NumPy and pandas compute them. Whiskers use
Tukey's rule (1.5 × IQR) by default; `whiskers: "range"` reaches the minimum
and maximum with no outliers, and a nonnegative finite number sets the IQR
multiple. Default whiskers end at the most extreme observations within the
fences, preserving the observed endpoints even inside the quartiles. Custom
multipliers keep whiskers at least as far out as the interpolated quartiles,
including when no observations lie within the fences. Values
outside the whiskers are dots, unless `outliers: false`: hidden outliers are
neither drawn nor part of the value axis' extent or a box's span for
picking, and tooltips still count them. Missing and non-finite observations
are omitted.

```ts
boxplot(requests, { x: "region", y: "latency", whiskers: "range" });
boxplot(requests, { x: "region", y: "latency", whiskers: 2, notch: true });
boxplot(stats, {
  x: "region", low: "min", q1: "p25", median: "p50", q3: "p75", high: "max",
  count: "n", notch: true,
});
// Horizontal precomputed boxes: only the category y field is needed.
boxplot(stats, { y: "region", low: "min", q1: "p25", median: "p50", q3: "p75", high: "max" });
```

For precomputed input, one row is one box. Supply all five numeric or time
statistic fields and exactly one category field (`x` or `y`); raw value fields
and statistics exclude each other. Statistics must satisfy
`low ≤ q1 ≤ median ≤ q3 ≤ high`; a row with a missing or non-finite statistic
is omitted. Precomputed boxes have no outliers and cannot take `whiskers` or
`outliers`, since `low` and `high` already give their endpoints. Optional `count` names a
number field of positive safe integers; tooltips omit the count when absent.

`notch: true` narrows the box at its median, with endpoints at
median ± 1.57 × IQR / √count. Raw boxes count their finite observations;
precomputed notches require `count`. Endpoints are not clamped to the
quartiles, so small samples can produce a flipped outline. Axis extents and
picking include the notch interval. Notches use the existing area and segment
geometry in SVG, Canvas, static SVG, and PDF. On log axes, only parts with
finite mapped coordinates draw; the notch fill is omitted if any vertex
cannot be placed, while drawable outline segments remain.

`series` puts boxes side by side in each category, in their own colors.
Tooltips, keyboard reading, and summaries report the supplied statistics as
they do computed statistics. Statistics refresh when the table changes:
raw input costs a full pass and sorting each group's observations; precomputed
input reads columns without expanding counts or building observation objects.
Facets use each panel's own rows and categories, with every series keeping its
slot in every panel; `facet: "repeat"` repeats all boxes in every panel.

Letter-value plots (`boxen`, Hofmann, Wickham, and Kafadar's, as Seaborn's
`boxenplot` draws them) take raw category/value fields like box plots, and
draw each group's letter values: the quartiles' box, then a box out to each
eighth, sixteenth, and so on, every level narrower and lighter than the one
inside it (its fill opacity `fillOpacity` × 2^((level + 1 − k) / 3), the
quartile box at `fillOpacity`, 0.7 by default), a line at the median, and dots
at the values beyond the outermost boxes (`outliers: false` hides them as
box plots do). `depth` chooses the k levels: `"tukey"` (the default, about 5
to 8 values left in each tail), `"proportion"` (about `outlierProportion` of
the values beyond the boxes, 0.007 by default), `"trustworthy"` (stopping
where a letter value's confidence interval at `trustAlpha`, 0.05, would
overlap the next), `"full"` (out to the extremes, no outliers), or a whole
number of levels from 1. `widthMethod` narrows each level by half
(`"exponential"`, the default), by equal steps (`"linear"`), or makes each
box's area proportional to the share of values it holds (`"area"`; a box
without height has no width). Quantiles interpolate linearly, as NumPy's
percentiles do, and depths cut logarithms toward zero, as Seaborn's do.
Tooltips report the median, quartiles, levels and their extent, count, and
outliers; facets, `series`, legends, keyboard reading, and row selections
work as for box plots. The mark is its own module, out of bundles that do
not import it.

```ts
boxen(requests, { x: "region", y: "latency", series: "version", depth: "trustworthy" });
boxen(requests, { x: "latency", y: "region", depth: 4, widthMethod: "area", outliers: false });
```

Violins take raw category/value fields and distribution style options, and draw
each group's Gaussian kernel density instead, mirrored about the category's center: every
violin is as wide at its densest, and reaches two bandwidths past the group's
extreme values (Plotly's default "soft" span). The bandwidth is each group's
own by Silverman's rule of thumb, 0.9 min(sd, IQR / 1.34) n^-1/5, unless
`bandwidth` sets one in data units for all of them. Inside each violin, a
line spans the box plot's whiskers, a narrow box the quartiles, and a dot
marks the median. A group whose values do not vary is a line across the
violin's width. Tooltips report the median, quartiles, range, and count.
Densities are of the values themselves, not of their logarithms: on a log
axis a violin is the same density drawn on a stretched axis, and the part at
zero or below is not drawn.

`inner` selects what is drawn inside: `"box"` (the default whisker line,
quartile box, and median dot), `"quartiles"` (dashed lines at Q1 and Q3 and a
solid line at the median, reaching the density's edges), or `"none"`.

```ts
violin(requests, { x: "region", y: "latency", series: "version", split: true, inner: "quartiles" });
violin(requests, { x: "latency", y: "region", series: "version", split: true, inner: "none" });
```

`split: true` requires `series` and at most two observed values of that field
across the mark. Each draws a half at the category's center, the first left
(or below for horizontal violins), the second right (or above). Order follows
the legend: the first category with finite observations, then the series
field's dictionary order. Each half is independently as wide at its densest.
Sides follow the current whole-table order, recalculated when data changes.
A category or panel with a missing or hidden partner leaves its half empty;
colors, legend entries, tooltips, keyboard stops, and summaries stay separate.
Unused dictionary entries and rows without a category, series, or finite value
do not count.
More than two observed values is an error naming the field and count, also
after data updates. Inner marks draw separately on each half.

Both options work with facets and per-panel category scales, vertically and
horizontally, in SVG, Canvas, static SVG, and PDF. Constant values retain
their density fallback line with every `inner` setting. If the density cannot
be computed, `"box"` still draws its statistics, `"quartiles"` spans the
available width at each statistic, and `"none"` draws no shape.

Marks are drawn in array order; rules and text always draw above other marks.

### Dendrograms

`dendrogram(table, options)` draws a hierarchical clustering linkage on
category bands. Each merge row names its two child clusters and height:

```ts
import { dendrogram, table } from "herceg";

const linkage = table({ first: [0, 2, 5], second: [1, 3, 4], height: [1, 2, 4] });
const tree = dendrogram(linkage, {
  first: "first", second: "second", height: "height",
  leaves: ["a", "b", "c", "d"], // labels indexed by leaf id
  side: "bottom", label: "Column clustering",
});
```

The fields must hold numbers, with whole-number child ids: for n leaves,
0 through n−1 are leaves, and merge row k creates cluster n+k. Children
must be leaves or earlier merges, and each cluster can be merged only once.
`leaves` must have exactly rows+1 distinct string labels. Heights must be
finite and nonnegative; ties and decreasing heights are allowed. An empty
linkage with one leaf draws nothing. Invalid linkage values name their row
and field. Tables are validated again after changes.

`side` is the plot edge at height zero: `"bottom"` (default) or `"top"`
places leaves along x; `"left"` or `"right"` along y. The mark contributes
bands in first-child-before-second-child traversal order (SciPy's
`leaves_list`): the example is c, d, a, b. Bands from earlier marks keep
their order, so a heatmap whose categories already have that order aligns
unchanged. Leaves are placed at their categories' band centers; merges
at the middle of their two children. A missing leaf omits its merge and
all ancestors, while surviving branches stay in place.

Heights run linearly from the leaves' edge to the opposite plot edge at
the largest height, independently of axis domains and zoom. When every
height is zero, links stay at the leaves' edge. Hide the height-direction
axis (`show: false`), since its ticks do not describe these plot-relative
heights. `stroke` defaults to the theme's muted text and `strokeWidth` to
1 CSS pixel. `label` names the accessible summary, which reports leaves,
merges, and the merge-height range. Dendrograms have no series, legend
entry, tooltip, keyboard stops, or value animation. With facets they
require `facet: "repeat"`, since splitting linkage rows breaks cluster ids.

For a clustered heatmap, use four subplots with shared column and row
categories. `matrix`, `columnLinkage`, and `rowLinkage` below are tables;
the matrix's categories must be in the dendrograms' traversal orders:

```ts
createChart(element, {
  marks: [
    heatmap(matrix, { x: "column", y: "row", color: "value", panel: "matrix" }),
    dendrogram(columnLinkage, {
      first: "first", second: "second", height: "height", leaves: columnLabels,
      side: "bottom", panel: "top",
    }),
    dendrogram(rowLinkage, {
      first: "first", second: "second", height: "height", leaves: rowLabels,
      side: "right", panel: "left",
    }),
  ],
  panels: panels([
    { id: "corner", x: { show: false }, y: { show: false } },
    { id: "top", y: { show: false } },
    { id: "left", x: { show: false } },
    { id: "matrix" },
  ], { columns: 2, rowHeights: [1, 4], columnWidths: [1, 4] }),
  resolve: { x: "columns", y: "rows" },
});
```

The same options are `{ type: "dendrogram", ... }` in portable specs and
`<Dendrogram data={linkage} ... />` in React, Vue, and Svelte. The mark
uses one packed segments geometry for SVG, Canvas, static SVG, and PDF.
It brings its own module only when imported; a line chart bundles none
of its linkage validation or drawing code.

### Rugs

A rug shows each observation of one number or time field as a short tick
at the plot edge. Use exactly one of `x` or `y`:

```ts
import { rug } from "herceg";

rug(requests, { x: "latency", series: "service" });
rug(requests, { y: "latency", side: "right", length: 12, label: "Requests" });
```

An x rug has vertical ticks at the bottom (default) or top; a y rug has
horizontal ticks at the left (default) or right. `length` is finite and
positive, 8 CSS pixels by default, clipped to the plot. The ticks stay at
the edge through zoom and pan. `strokeWidth` defaults to 1 CSS pixel;
`stroke` overrides every series' palette color. `label` names a rug without
`series` in the legend and tooltip; its field name is the default.

A rug contributes only to its value axis' domain. The other axis may be
continuous or categorical and retains its other marks' domain, or the
chart's default domain. Missing, infinite, and nonpositive log values draw
nothing. Repeated values remain separate observations. Tooltips report the
series and the observed value using its axis' formatter, along x or y as
appropriate; the keyboard visits observations in ascending value order,
including repeated values, and summaries give the count and range.

Rugs split into facets and use `facet: "repeat"`, `panel`, `id`, and legend
toggles as other data marks do. A y rug uses only the left value axis
(`side: "right"` still selects the right plot edge). SVG, Canvas, static
SVG, and PDF draw one packed segment geometry per series, including large
rugs. React and Vue export `Rug`; Svelte exports `Rug.svelte` as `Rug`.
The portable spec uses `{ type: "rug", x: "latency" }` or `y`.

### What each mark supports

Charts share their behaviors unevenly so far: the marks along x and y axes
take part in everything, the others in less. ✓ supported, ◐ partly (see
the notes), — not yet (refused with an error), · not applicable.

| Marks | Facets | Subplots | Panel scales | Right axis | Zoom and pan | Brushes | Synced selection | Selected rows | Highlight | Legend toggle | Tooltip and keyboard | Tooltip fields | Value animation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| line, area, bar (including normalized stacks and area stream offsets) | ✓ | ✓ | ✓ | ◐ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ◐ |
| point | ◐ | ✓ | ✓ | ◐ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| histogram, boxplot, boxen, violin | ✓ | ✓ | ✓ | ◐ | ✓ | ✓ | ✓ | ◐ | — | ✓ | ◐ | · | — |
| rug | ✓ | ✓ | ✓ | — | ✓ | ✓ | ✓ | ◐ | — | ✓ | ✓ | ✓ | — |
| errorbar, candlestick | ✓ | ✓ | ✓ | ◐ | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | ✓ | — |
| dendrogram | ◐ | ✓ | ✓ | · | · | ✓ | ✓ | · | · | · | · | · | — |
| heatmap | ✓ | ✓ | ✓ | · | ✓ | ✓ | ✓ | ◐ | — | · | ✓ | ✓ | — |
| 2D histogram | ✓ | ✓ | ✓ | · | ✓ | ✓ | ✓ | ◐ | — | · | ✓ | · | — |
| contour | ✓ | ✓ | ✓ | · | ✓ | ✓ | ✓ | · | · | · | ✓ | · | — |
| rule, region, text | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | · | · | ◐ | · | ◐ |
| custom | ◐ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | ◐ | ◐ | ◐ | — |
| pie | ✓ | ✓ | · | · | — | — | — | — | — | ✓ | ✓ | · | ✓ |
| treemap, sunburst | ✓ | ✓ | · | · | drilling | — | — | ✓ | ✓ | ✓ | ✓ | · | — |
| radar | ✓ | ✓ | · | · | — | — | — | — | — | ✓ | ✓ | · | — |
| gauge, funnel, sankey | ✓ | ✓ | · | · | — | — | — | — | — | · | ✓ | · | — |
| graph | ✓ | ✓ | · | · | ✓ | ◐ | — | ✓ | ✓ | ◐ | ✓ | — | — |
| geoshape, geopoint | ✓ | ✓ | · | · | ✓ | ◐ | — | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| point3d, line3d | — | ✓ | · | · | turning | — | — | — | — | ✓ | ✓ | ✓ | — |
| surface | — | ✓ | · | · | turning | — | — | — | — | · | ✓ | · | — |

- Line and area gaps preserve isolated finite rows as stroke-sized dots on
  every renderer and export. Bars colored by their own category keep full
  bands, labels, and category legends. Text halos can be disabled on every
  mark that draws them; time tick labels are unique in their axis format.
- Every built-in mark exports through `renderToPDF`; each chart is one page and
  one Figure, including its facets or subplots.
- Selected rows and Highlight are what charts bound to a selection store do
  (`rowSelection`, see [Selected rows](#selected-rows)): brushes, lassos, and
  clicks write rows to its channel, and the chart highlights what the channel
  holds. Histograms are brushed along their bins (2D histograms along x, y,
  or both) and box plots and violins along their categories, heatmaps'
  cells are clicked, brushed (along a number or time axis, the cells whose
  values the brush covers, or between edges, the cells the brush
  overlaps; in a calendar, those whose centers it covers), or lassoed (at
  their centers), and lassos select none of the summaries' rows yet; these
  marks, error bars, and candlesticks draw every row undimmed. Contours'
  regions and lines are not rows: gestures over them select nothing. Maps,
  treemaps, sunbursts, and networks take a binding too, in a chart of their
  own or in panels: clicks select a region's or point's row, a tree node's
  rows (its own and those under it, of its panel's rows), a network node's
  rows of its nodes table, or a link's of its links table (of its panel's
  rows), and lassos a map's regions and points or a network's node centers;
  the other layout marks and 3D charts refuse one. Brushes and synced
  selections themselves are ranges and outlines in data values (a map's
  lasso, in its plane).
- Zoom, pan, and brushes work on number and time axes; subplots zoom and
  brush along x only, and facets with y scales of their own, on either
  side, do not zoom along y. Maps and networks zoom and pan their plane both ways
  (`interaction.zoom` true or "xy") and take a "lasso" brush; treemaps and
  sunbursts drill into nodes with `interaction.zoom: true` (see
  [Drilling into trees](#drilling-into-trees)); networks' nodes move with
  `interaction.drag` (see [Moving nodes](#moving-nodes)), which no other
  mark takes. All of them do so in panels too: facet panels share one view,
  drill root, and set of moved nodes, and each subplot has its own (see
  [Layout marks in panels](#layout-marks-in-panels)); beside panels with
  axes, which zoom and brush along x only, maps and networks pan and zoom
  with `zoom: true` and take no lasso.
- A range navigator on a number or time x axis describes its overview and
  current window in the chart's text alternative; with facets or subplots,
  it says that it controls every panel's shared x range.
- The right axis (see [A second y axis](#a-second-y-axis)) takes values
  along y: horizontal bars, box plots, boxen plots, violins, histograms, and error bars,
  points on category y, lines and areas along y, and rugs along y stay on
  the left, and a rule at an x or a rug along x has no y to place.
  In facets and subplots, every panel drawing marks on it has one.
- Points over a row view and custom marks without series repeat in every
  facet panel instead of splitting.
- Dendrograms repeat in every facet panel (`facet: "repeat"`); they have
  no inspection of their own, and their heights stay fixed within the plot
  as it zooms.
- Heatmaps zoom and pan their number and time axes; banded axes (category
  fields, or `xBanded` / `yBanded`) do not zoom, as for other marks. 2D
  histograms and contours place cells and regions on number and time axes,
  which zoom and pan, and take no right axis, log axes, or time breaks.
- Layout marks but 3D charts draw each facet panel's rows in it (a map's
  layers each split their rows or repeat, and a network's panels share one
  layout), or fill a subplot of their own beside panels with axes (see
  [Layout marks in panels](#layout-marks-in-panels)). Their panels have no
  axes, so they neither zoom along axes, brush ranges, sync, nor resolve
  scales (`resolve` other than "shared"); trees
  drill, maps and networks pan, zoom, and lasso, and networks move nodes
  there as in a chart of their own. 3D marks draw in subplots with a camera
  per panel; 3D facets are refused.
- Box plots, boxen plots, and violins on log axes have no keyboard stop for groups whose
  median is not positive; annotations are read in the chart's summary
  rather than one by one (a facet panel's own as the keyboard arrives
  there); custom marks are read through their series.
- Tooltip fields (see [Tooltips](#tooltips)) show more of the row a point
  or item is; marks whose points summarize rows (bins, groups, slices,
  nodes, surface samples) have no one row to show, custom marks take them
  with series, and network nodes do not yet.
- Value animation moves unstacked, unlabeled bars, points, lines and areas
  along x whose rows stay, rules, and pie slices (see
  [Animation](#animation)), in charts of one panel; lines and areas along
  y show their new values at once.
- Every mark draws in SVG, Canvas, static SVG, and PDF; large point series
  and 3D charts also draw with WebGL. Every mark has a React, Vue, and
  Svelte component, and every mark but custom marks (JavaScript only) a
  Python builder.

### Pies and donuts

```ts
pie(sales, { category: "region", value: "revenue" });
pie(sales, { category: "region", value: "revenue", innerRadius: 0.6 }); // a donut
pie(visits, { category: "browser" }); // counts rows
```

A pie has a slice per category, sized by the sum of `value` over the
category's rows, or their count without `value`; negative and missing values
count as nothing. Slices go largest first, clockwise from the top
(`sort: "input"` keeps the categories' order), with 2 px between them (less
for slices too thin for that), and
are labeled beside the pie with lines to them when there is room
(`labels: false` turns that off); labels that do not fit, smallest slices
first, are left out. The legend toggles slices, and the rest fill the circle.
Tooltips, hover and click events, and the arrow keys report a slice's value
and its share of the slices shown. A pie has its chart to itself, or with
facets a panel each, or a subplot of its own (see [Layout marks in
panels](#layout-marks-in-panels)): it shares no panel with other marks, and
does not zoom, brush, or sync.

### Treemaps and sunbursts

```ts
treemap(sales, { path: ["region", "country"], value: "revenue" });
sunburst(sales, { path: ["region", "country", "city"], value: "revenue" });
treemap(org, { node: "team", parent: "parentTeam", value: "cost" });
```

Both draw a tree. `path` names category fields from the outermost group in;
a row ends at its first missing one, and its value belongs to the node there.
`node` and `parent` name each row's node and its parent's instead; rows
without a parent are top-level, and duplicate nodes, unknown parents, and
cycles are errors. A node's value is the sum of `value` over its rows and
its descendants' (or their count); missing values count as nothing, and
negative or infinite values, or totals too large for a double, are errors.

A treemap fills the room with nested rectangles, largest first and kept close
to square (the squarified layout), 2 px apart; groups show their name in a
strip along their top. A sunburst draws rings around a center, a ring per
depth, each node's angle its share of its parent's, largest first clockwise
from the top. Nodes take their top-level group's color, deeper rings of a
sunburst lighter, and the legend toggles top-level groups, giving their room
to the rest. Names go inside the shapes that have room for at least three
characters. Tooltips report a node's path, value, and share of what is shown;
the arrow keys visit the nodes drawn, depth first. Items keep their keys
while the tree changes: a node's path, or with `node` and `parent` its name. Like a pie, each has its chart to
itself.

#### Drilling into trees

```ts
const chart = createChart(element, {
  marks: [treemap(sales, { path: ["region", "country", "city"], value: "revenue" })],
  interaction: { zoom: true }, // click or Enter opens a node
});
chart.on("drill", ({ key, path }) => console.log(key, path.map((step) => step.label)));
chart.setDrillRoot(["Europe", "France"]); // by names from the top, or by item key
chart.getDrillRoot(); // { key: '[0,"Europe","France"]', path: [{ key, label: "Europe" }, ...] }
chart.setDrillRoot(null); // the whole tree
```

With `interaction.zoom: true`, a click on a node with nodes under it lays
out the subtree under it in the room, as a tree of its own: its nodes keep
their keys and their top-level group's color, and tooltips give shares of
the node drilled into ("12% in Europe"). A strip above the tree names the
path from the whole tree ("All / Europe / France"), drawn as part of the
chart (so exports show it) with a native button over every step but the
last, which the pointer and the Tab key reach and screen readers read; a
sunburst also puts the node drilled into in its middle, where a click goes
up a level. Enter opens the node the keyboard reads, Backspace goes up, 0
shows the whole tree, and a toolbar has Up and whole-tree buttons; each
change is announced with the new summary. When the chart's row selection
takes clicks, a click selects the node's rows instead, and Enter still
drills. `setDrillRoot` drills with or without `interaction.zoom` and is
followed by a `drill` event (`{ key, path }`, null and `[]` for the whole
tree), which also says when the data no longer has the node drilled into
and the tree shows its nearest ancestor that remains instead;
`getDrillRoot()` gives the root set. Trees in facet panels share one root,
and each subplot's tree has its own (see
[Layout marks in panels](#layout-marks-in-panels)).

### Gauges and funnels

```ts
gauge(metrics, { value: "cpu", label: "CPU", format: { style: "unit", unit: "percent" } });
gauge(sensors, { value: "temp", max: 120, bands: [{ to: 60 }, { to: 90 }, { to: 120, color: "#e0464f" }] });
funnel(signups, { category: "stage", value: "users" });
```

A gauge shows the last finite value of a number field, so appending rows to
its table moves it. Its dial is a 240-degree arc open at the bottom, from
`min` to `max` (0 to 100 by default, as in ECharts): a track, the value's arc
along it in the color of the band the value falls in (the palette's first
color without bands), the value in the middle with `label` (the field's
name by default) under it, and the dial's ends under its ends. `format`
takes Intl.NumberFormat options for the value and the ends. `bands` split
the dial at ascending ends above `min` and at most `max`, each from the
previous band's end; they show as a thin ring outside the track, colored by
`color` or the palette in order, and the range past the last band's end has
none (a value there takes the palette's first color). Values beyond the dial
fill it to that end, while the text shows them as they are; without a
finite value, the track is empty and the value reads "–". Tooltips and the
keyboard report the value with the dial's range.

A funnel draws a centered bar per category, top to bottom, in the field's
order (`sort: "value"` puts the largest first). A stage's value is the sum of
`value` over its rows, or their count; missing, negative, and infinite
values count as nothing. Each bar is as wide as its value is to the largest
stage's: widths carry the values, while the faint connectors between bars
only lead the eye and their areas mean nothing. Stage names go left of the
bars, shortened to fit at most 35% of the width, and each stage's value and
share of the first stage go on its bar, or beside it when the bar is too
narrow (`labels: false` leaves both out). Tooltips, events, and the arrow
keys report a stage's value, share of the first stage, and share of the
previous one. All stages take the palette's first color, and there is no
legend. Like a pie, a gauge or a funnel has its chart, each facet panel, or
its subplot to itself.

### Radars

```ts
radar(scores, { category: "skill", value: "score", series: "player" });
radar(players, { fields: ["speed", "power", "range", "stamina"], series: "name" });
```

A radar draws spokes from a center, evenly spaced clockwise from the top,
and a polygon per series through its value on each spoke, filled at
`fillOpacity` (0.15 by default) and with a dot at each value (`points:
false` leaves them out). Spokes come from data in one of two shapes: the
values of a `category` field, in its dictionary order, with `value` the
number on each (a row per series and spoke), or distinct number `fields`, in
order, each row a polygon named by its `series` value. Radar values are
measurements, not counts: a later row replaces an earlier one's values for
the same series (and spoke). Without `series`, every row belongs to one
polygon, named `label`, so with `fields` the last row is drawn. A radar draws
3 to 100 spokes; a table with more draws nothing, and its description says
why.

Every spoke shares one linear scale from the center: by default from 0 (or
the smallest value, when negative) to a round number above the largest
shown, or `domain: [low, high]`. Values beyond it are drawn at the rim or the
center, and tooltips say so ("above the axis maximum of 10"). Rings mark
round values, labeled along the first spoke where the labels fit. Spoke names go outside the rim;
the radar shrinks to make room for them, down to 60% of its size, and names
that still do not fit are shortened or left out. Missing, NaN, and infinite
values leave their spoke's vertex out: the outline breaks there, and the
polygon goes unfilled. The legend toggles series (a radar of one polygon
shows one only with `legend: true`), and the scale fits what is shown. Tooltips, hover and click
events, and the arrow keys report one value at a time, series by series and
spoke by spoke; the pointer finds the nearest value within 24 pixels. Like a
pie, a radar has its chart, each facet panel, or its subplot to itself; in
facet panels, every radar has the table's spokes and series, each scaled to
its own panel's values unless `domain` is given.

### Sankey diagrams

```ts
sankey(energy, { source: "from", target: "to", value: "twh" });
sankey(sessions, { source: "page", target: "next" }); // counts rows
```

A Sankey diagram draws flows between nodes from a table with a row per flow.
Nodes are the names in `source` and `target`; a name in both is one node. A
link joins each source and target, as thick as the sum of `value` over their
rows, or their count without `value`. Rows with a missing name, or with a
missing, zero, negative, or infinite value, are left out, and so are links
from a node to itself. Links that would close a cycle are left out too (the
search starts from the nodes nothing flows into, so it is the link back
toward the start of a loop that goes), as are links whose total is too large
for a double; the chart's description says how many.

Nodes stand in columns by their longest path from a node nothing flows into,
with nodes nothing flows out of in the last column, as d3-sankey's "justify"
alignment does. A node is as tall as the larger of its inflow and outflow, on
one scale for the whole diagram that fits the fullest column with 10 px
between nodes (less when a column has too many nodes for that). Nodes settle
near the nodes they connect to, in an order chosen to keep links short and
crossings few, unless `sort: "input"` keeps the order in which nodes first
appear or `sort: "value"` puts the largest first. Links are translucent bands
in their source's color, stacked at each node in the order of the nodes at
their other ends. `nodeWidth` sets the bars' width (12 px by default).

Labels show a node's name and value beside it, inside the diagram: right of
the nodes in the left half of the columns, left of the rest. Values go first
when a label does not fit, then the name is shortened, and labels that would
overlap a larger node's are left out (`labels: false` turns them off). There
is no legend. Tooltips, hover and click events, and the arrow keys report a
node's inflow and outflow or a link's value, nodes first (column by column,
top to bottom), then links (by source, then target). The layout is computed
again whenever the table changes, so streamed rows redraw the whole diagram.
Like a pie, a Sankey diagram has its chart, each facet panel, or its subplot
to itself.

### Networks

```ts
graph(friendships, { source: "a", target: "b" });
graph(messages, {
  source: "from",
  target: "to",
  value: "count", // link widths
  nodes: people, // a second table, with a row per node
  node: "name",
  color: "team", // colors and the legend
  size: "followers", // node areas
});
```

A network draws nodes joined by links from a table with a row per link.
Nodes are the names in `source` and `target`, and, with `nodes`, the names in
that table's `node` field, so nodes without links can be drawn too. Links
have no direction unless `directed`: rows either way between two nodes add
to one link, as wide as the sum of `value` over them (1 to 6 px), or 1 px
without `value`. With `directed: true`, rows from a source to a target are
one link and rows the other way another, drawn with an arrowhead at the
target's edge, a pair's two links bowed apart. Rows with a missing name, or
with a missing, zero, negative, or infinite value, are left out, and so are
links from a node to itself (the chart's description says how many).
`linkLabelField` names a category field written at the middle of the heaviest
links where it covers no node or other label (as many as node labels); a
link whose rows name it differently has none, and the description says how
many.

A force simulation places the nodes, after d3-force: springs along links pull
linked nodes about one link length apart, every pair of nodes repels, and
alpha decays over 300 ticks. Unlike d3's defaults, nodes start where pivot
MDS puts them (positions whose distances follow distances in the network),
so rings come out round and chains and trees unfolded, and separate pieces of
the network are packed in rows rather than pulled toward the middle.
Heavier links pull somewhat harder. The layout is deterministic: the same
tables draw the same picture. It is scaled to fit the room (stretching one
axis by up to 30%), small networks are not blown up past 2.5 px per unit of
the simulation, and overlapping nodes are then pushed apart.

Nodes are circles of 5 px radius, or sized by area with `size` (3 to 14 px;
missing or infinite sizes draw smallest),
smaller in rooms crowded with nodes, each ringed in the
background color so overlaps read. With `color`, a category field, nodes
take their category's color, links within a category take it too (others are
gray), and the legend toggles categories: hiding one leaves its nodes and
their links out without moving the rest. A later row of the nodes table for
the same node replaces an earlier one's color and size; nodes only links
name have no category and are gray. Names stand beside the most connected nodes (the largest, with `size`):
all of up to 50 nodes, fewer in larger networks, and none where a name would
cover another node or name (`labels: false` turns them off).

Tooltips, hover and click events, and the arrow keys report a node's drawn
links, the sum of their values, its group, and its size, or a link's value
(the chart's description counts what is drawn too): nodes
first (the nodes table's order, then names as links first mention them), then
links. The pointer finds the node within 4 px of its edge, else the nearest
link within 4 px. The simulation runs again whenever either table changes,
about 0.1 s for 1,000 nodes and 1 s for 5,000 on a laptop, and resizing only
refits it. `graph()` refuses networks of more than 5,000 nodes or 20,000
links with an error: springs cost little next to repulsion up to that many
links, but a dense network's millions would take seconds. A network that
grows past the limits while drawn, or a spec loaded with more, draws nothing
and its description says why, until its tables shrink again. Like a pie, a network has its chart to itself.

A network pans and zooms with `interaction.zoom: true` (or `"xy"`), using
map gestures: wheel at the pointer, drag to pan, double-click or `0` to
reset, Shift+arrows to pan, plus/minus to zoom, and a toolbar. The
`viewport` event and `setViewport({ x, y })` use the force layout's
coordinates, with y increasing downwards. Node radii, rings, link widths,
and arrowheads keep their pixel sizes. Resizing refits the base layout;
navigation keeps its separated positions and does not run the simulation.
Exports show the current view. Pointer lookup uses packed spatial grids
for nodes and link routes, retaining the drawn order and nearest-edge rules.

`interaction.brush: "lasso"` selects nodes at their visible centers through
`rowSelection` bound to the nodes table. Every row naming a selected node
is selected; nodes inferred only from links have no node row. Unselected
nodes dim, and a link remains bright only when both endpoints are selected
(and its rows are selected when the links table also has a selection).
A lasso writes no link rows. With zoom and lasso together, plain drag
lassos; Shift-drag pans, and the toolbar's Lasso toggle switches plain
drags back to panning or node dragging. Escape clears the lasso.

#### Moving nodes

```ts
const chart = createChart(element, {
  marks: [graph(messages, { source: "from", target: "to", directed: true, linkLabelField: "kind" })],
  interaction: { drag: true, zoom: true },
});
chart.on("itemMove", ({ key, position }) => save(key, position));
chart.setItemPosition('[0,"Ana"]', { x: 40, y: -12 }); // layout units
chart.setItemPosition('[0,"Ana"]', null); // back where the layout puts it
chart.getItemPositions(); // { '[0,"Ana"]': { x: 40, y: -12 } } of the nodes moved
```

With `interaction.drag: true`, dragging a node moves it, its links
following, and it stays where it is dropped: nothing else moves, and the
layout does not run again. Shift with the arrow keys moves the node the
keyboard reads 10 px when zoom is off, and 0 or a toolbar button puts every moved node back.
With zoom enabled, Alt+Shift+arrows moves the node, Shift+arrows pans,
and 0 resets the view; the toolbar restores moved nodes,
and each move is announced; touches on the chart drag nodes rather than
scroll the page. The first pointer press owns the gesture until it ends or
is cancelled, so a second touch cannot pan during a node drag or start
dragging a node during a pan. A move is kept in the network's layout units
(links settle about 30 units long), so it follows a resize as the rest of
the network does, including while zoomed; `setItemPosition` moves a node so too, and an `itemMove`
event reports every move once it is dropped (`position` null for a node put
back). Moves last while the network's tables are unchanged (a mark made
again over them with other styles keeps them): a change lays the network
out again, and a drag whose data or viewport changes ends without a move.
Dragging stops at the view edge; `setItemPosition` keeps the given layout
position even outside the view, so panning can bring it back. A row selection of the nodes table selects a node's
rows when it is clicked, and one of the links table a link's rows; a node
only links name stands for no row, and a click on it changes nothing.
Networks in facet panels share one layout, so a node moved in one moves in
every panel; each subplot's network has moves of its own.

### Maps

```ts
import { createChart, fromGeoJSON, geopoint, geoshape, table } from "herceg";

const countries = fromGeoJSON(await (await fetch("countries.geojson")).json());
const cities = table({ city: [...], lon: [...], lat: [...], population: [...] });

createChart(element, {
  projection: "equal-earth",
  marks: [
    geoshape(countries, { labelField: "name", color: "gdp" }), // a choropleth
    geopoint(cities, { longitude: "lon", latitude: "lat", size: "population", labelField: "city" }),
  ],
});
```

A map draws `geoshape` regions and `geopoint` points (or bubbles) on one
projection; the two share a chart with each other, not with other marks.
Regions come from a table's geometry field, which holds polygons and
multipolygons in longitude and latitude (degrees, WGS 84). `fromGeoJSON`
reads a GeoJSON FeatureCollection into such a table: its shapes in a
`geometry` field (points in `longitude` and `latitude` fields), feature ids
in `id`, and each property in a field of its own (numbers and booleans as
numbers, strings as categories, a mix of the two as categories of their
text). `geometry(set, codes?)` builds a geometry column from packed arrays
(see Charts from specs), as GeoArrow nests multipolygons; rows hold codes
into the shapes, so filtered and sorted derived tables share them, and
appended rows name existing shapes by code. Edges are straight lines in
longitude and latitude, as GeoJSON defines them: shapes that cross the
antimeridian are expected to be cut there, as RFC 7946 asks.

`geoshape` fills each region by `color`: a number field on a continuous
scale (`colors`, `colorDomain`, and `colorMidpoint` as for heatmaps), with a
color legend, or a category field with a palette color per value, whose
legend grays a category's regions out without moving the map. Regions
without a value, and regions of a map without `color`, are filled with
`fill` (the theme's grid color by default); borders are drawn in the chart's
background color (`stroke`, `strokeWidth`, 0.75 px by default). `geometry`
names the field when the table has several. `geopoint` places points at the
`longitude` and `latitude` number fields, of one `radius` (4 px by default)
or sized by area with a `size` field (`radiusRange`, 2 to 16 px by default; a
size key joins the legend), colored by a
`series` category or by `color` (a number field on a continuous scale, or a
category field as for `point`), at 0.8 opacity, each ringed in
the background color (`stroke`, `strokeWidth`), and largest first, across
series, so smaller points stay on top. Points missing a value they encode
are left out. `labelField` (a category field) labels regions and points in
tooltips and keyboard reading.

The chart's `projection` is a name or `{ type, centralMeridian?,
parallels?, fit? }`:

| Projection | |
| --- | --- |
| `"equal-earth"` (default) | Equal-area, for world maps. |
| `"natural-earth"` | A compromise for world maps. |
| `"mercator"` | Conformal; cut at 85.05 degrees of latitude. |
| `"equirectangular"` | Longitude and latitude as they are. |
| `"conic-equal-area"` | Albers' equal-area conic, for countries and continents. |

`centralMeridian` is the longitude at the map's center (0 by default; for the
conic projection, the middle of the data, across the widest gap between its
longitudes), and shapes are cut where the opposite meridian crosses them.
`parallels` are the conic projection's standard parallels, by default a
sixth of the data's span of latitudes in from either end. `fit` is what the
map fills: the data's shapes and points (`"data"`, the default), the whole
`"world"`, or a box `[[west, south], [east, north]]` (west may lie east of
east, to cross the antimeridian; a box beyond Mercator's latitudes shows the
world). The fit does not change when the legend hides categories. Edges are
divided until they are drawn within a quarter pixel of their projected
curves, whatever the zoom.

Tooltips, hover and click events, and the arrow keys report a region's name
and value (or category) and a point's name and size (or color value, or
position): regions first in row order, then points. The pointer finds the
last-drawn point whose disc is within 3 px, else the last-drawn region
containing it (holes are not part of a region). The chart's description
summarizes each layer: the regions' range of values with the highest and
lowest, or their categories, and the points' count and largest.

Regions are projected once per projection and fit and kept with their
shapes, so changing values, colors, the legend, or the theme draws without
projecting again; at a new size they are projected again (200 regions of
1,000 vertices with 10,000 points, in Node: about 20 to 30 ms for the first
drawing, 11 ms at a new size, 2 ms to redraw, 2 µs to find the region under
the pointer). Points closer than a third of a pixel to the
previous one are left out of a region's outline.

#### Zooming and panning maps

```ts
const chart = createChart(element, {
  marks: [geoshape(countries, { labelField: "name", color: "gdp" })],
  interaction: { zoom: true, brush: "lasso" },
  rowSelection: rowSelection({ store: selectionStore(countries), channel: "picked" }),
});
chart.on("viewport", ({ x, y }) => console.log(x, y)); // the plane's ranges, null when fitted
chart.setViewport({ x: [0.1, 0.4], y: [0.6, 0.8] });
chart.setViewport(null); // the fitted map
```

With `interaction.zoom` (true or "xy"; maps zoom both ways), the wheel zooms
at the pointer, a drag pans, and double-click shows the whole map again;
Shift with the arrow keys pans an eighth of the room, plus and minus zoom,
0 shows the whole map, and a toolbar does all of it for people who cannot
drag, each change announced. The view is the chart's viewport, x and y
ranges of the projection's plane (units of the Earth's radius, x east and y
north), reported by `viewport` events and set by `setViewport`: a box shows
whole, centered, at one scale; a range along one axis alone keeps the
fitted map's middle along the other; null fits the map again. The wheel,
keys, and buttons zoom between the whole map and 256 times its scale.
Tooltips, the keyboard, and `toSVG()` follow the view: the regions and
points drawn are those in the room. With a "lasso" brush, a drag draws a
lasso instead (Shift-drag pans, as does a drag with the toolbar's lasso
button off, for touch), kept as the chart's selection in the plane so it
stays on the map as it moves; with `rowSelection`, it selects the regions
whose anchor (a point inside each, the same at any zoom) and the points
whose center lies inside it, a click selects the region or point under it,
and the regions and points the selection leaves out are dimmed. Layers of
one table share its binding. Maps in facet panels share one view; a map in a
subplot has its own, which `setViewport(view, { panel })` sets (see
[Layout marks in panels](#layout-marks-in-panels)). The view and the lasso
are in the projection's units: an update of `projection` keeps them, so
reset them (`setViewport(null)`, `select(null)`) along with it; the Python
widget and Streamlit do so themselves.

A zoomed or panned map reuses the shapes it projected: they are projected
at a scale level (four per doubling, the next one up from the scale shown)
and drawn moved and scaled down to the view, so a pan projects nothing
until it has moved about 260,000 pixels (each level's pixels are about an
origin near the view, which keeps small maps precise), a zoom projects
again only past a level, and shapes wholly outside the room are not
projected at all. The fitted map draws exactly as without a view. 200
regions of 1,000 vertices pan in about 0.6 ms a frame on Canvas or SVG and
zoom a level in about 5 ms on Canvas and 10 ms in SVG (Chrome, Apple M6).

### 3D charts

```ts
import { createChart, line3d, point3d, surface, table } from "herceg";

createChart(element, {
  camera: { azimuth: -60, elevation: 25 },
  z: { title: "Yield" },
  marks: [
    surface(fit, { x: "nitrogen", y: "rain", z: "yield" }), // a fitted surface
    point3d(trials, { x: "nitrogen", y: "rain", z: "yield", series: "field" }), // observations
    line3d(runs, { x: "nitrogen", y: "rain", z: "yield", series: "run" }), // paths through them
  ],
});
```

`point3d` draws points at the number or time fields `x`, `y`, and `z` (z is
vertical): one color and legend entry per category of `series`, or colored
by a number field `color` (`colors`, `colorDomain`, and `colorMidpoint` as
for heatmaps), with a color legend, or by a category field `color` as `point`
marks are; `radius` is the radius (3.5 px), `fill` and
`fillOpacity` the color without them, and `labelField` labels points in tooltips.
`line3d` draws lines through the number or time fields `x`, `y`, and `z`:
each category of `series` is one path (one color and legend entry; without
`series`, all rows form one path), through its rows in table order, so a
path may turn back along any axis. A row missing a value (or without a place
on a log axis) breaks its path there; rows of other series in between do
not. `stroke` gives every path one color and `strokeWidth` the width in
pixels (2), which stays the same however near or far the line is; a run of
one row draws nothing (compose `point3d` for markers).
`surface` draws a height field over a grid of rows: each row's `x` and `y`
(number, time, or category fields) pick a grid point (the distinct numbers
and times in order, the categories in dictionary order and evenly spaced),
and its `z` (a number field) is the height there; when rows repeat a grid
point, the last with a value wins. Each cell between four grid points with
values is drawn as two triangles (split along the diagonal from its lowest x
and y corner), a cell with three as their triangle, so missing values leave
holes. Grid spacing may be irregular; rows not on a grid (scattered samples)
are not triangulated: bin or aggregate them into one first. A surface holds
at most 1,048,576 grid points (`MAX_GRID_POINTS`), and without a GPU
painter (SVG, PDF, and PNG exports, the SVG renderer, a browser without
WebGL2, a wireframe or translucent surface) draws at most 250,000
(`MAX_CPU_GRID_POINTS`): larger ones throw. Cells are colored by the
mean of their corners' `z` (or `color` field) on the theme's sequential ramp
or `colors`, with a color legend, and shaded by how they face a light above
and to the left of the viewer; `shading: false` shows colors exactly as the
legend reads them. `wireframe: true` draws the grid's lines (except on
cells cut at the box's walls), `fillOpacity` makes the surface translucent.

3D marks share a chart with each other, not with other marks, and its box:
each axis spans every mark's data (rounded to ticks), set by the chart's
`x`, `y`, and `z` options as other axes are (`type` `"linear"`, `"log"`, or
`"time"`, `domain`, `nice`, `zero`, `label`, `grid`, `ticks`, `format`,
`axis`). The box is a cube unless `boxAspect` gives its sides' relative
lengths (`[2, 2, 1]` for a flat box). Grid lines are drawn on the three
walls behind the data, tick labels along the box's lowest edges for x and y
and its leftmost for z (thinned where they would overlap), and data outside
a given `domain` is left out, surfaces and lines cut at the walls.

The chart's `camera` is where it is seen from at first: `azimuth`, degrees
counterclockwise around the z axis from +x seen from above (-60 by default);
`elevation`, degrees above the floor, from -90 to 90 (25); `zoom` (1 fits
the box; from 0.5 to 10); and `perspective` (false: orthographic, so equal
lengths look equal wherever they are). The box keeps its size as it turns.
Dragging turns it (`interaction: { rotate: false }` turns that off), the
wheel zooms with `interaction: { zoom: true }`, and double-click returns to
the configured camera. Buttons in the chart's corner, shown while the
pointer or focus is in it, turn, tilt, zoom, and reset the view for people
who cannot drag; Shift with the arrow keys turns it too, and plus and minus
zoom. The arrow keys, as in other charts without axes, read the points in
row order, a line's points path after path, and a surface's grid points row
by row. Touch drags turn the box
sideways and leave vertical drags to scroll the page. `chart.getCamera()` returns a copy of the
current camera, `chart.setCamera({ ... })` changes the settings it is given
(null goes back to the configured camera), and a `camera` event reports
every move, once a frame at most. Updating the chart with a different
`camera` shows it; updating it with the same camera keeps the view the user
turned to.

A 3D subplot names its panel on every layer, alongside any other panel:

```ts
import { createChart, line, panels, point3d, surface } from "herceg";

const chart = createChart(element, {
  panels: panels([
    { id: "trend", title: "Trend" },
    { id: "cloud", title: "Observations", camera: { azimuth: 30 } },
    { id: "fit", title: "Fit", camera: { azimuth: 90 } },
  ], { columns: 3 }),
  marks: [
    line(history, { x: "time", y: "yield", panel: "trend" }),
    point3d(trials, { x: "nitrogen", y: "rain", z: "yield", panel: "cloud" }),
    surface(fit, { x: "nitrogen", y: "rain", z: "yield", panel: "fit" }),
  ],
  interaction: { zoom: true },
});
chart.setCamera({ elevation: 40 }, { panel: "cloud" });
chart.getCamera({ panel: "fit" });
chart.setCamera(null, { panel: "cloud" }); // its configured view
chart.on("camera", ({ camera, panels }) => console.log(camera, panels));
```

Panel camera settings override the chart's camera defaults. Omitting the
method target works with one camera; with several, name the panel.
A subplot's camera event carries `panels: [id]`; a standalone chart's
carries only `camera`. Each 3D panel has its own toolbar; dragging, wheel
zoom, and double-click act in that panel, while keyboard turning acts on
the panel the keyboard cursor reads. Up and Down move between panels,
Left and Right through their items, and the description names each panel
and its view. SVG, PDF, and PNG exports use each panel's current camera.

Subplots draw on the CPU, including large points and surfaces; standalone
charts keep the WebGL point, line, and surface paths. Surface panels obey
the 250,000 grid-point CPU limit. Each panel retains only its latest packed
geometry and, on Canvas, one transparent panel-sized raster; an unchanged
panel reuses both when a neighbor turns. Raster backing storage is about
`4 × sum(panel device-pixel areas)` bytes, in addition to geometry and the
main canvas. The whole canvas still clears and composites on each frame.
3D facets are refused with a message recommending separate subplot marks:
shared cameras alone would not define how surface grids split into facets.

Tooltips, hover and click events, and the keyboard report a point's, a
line's point's, or a grid point's `x`, `y`, and `z` (and `color`), and the
inspection's `values` holds them by field. The pointer finds what shows on
top under it: a point within 3 px of its disc, a line within 3 px of its
stroke (reporting the end of the segment nearer the pointer, or, for an end
outside the box, where the segment enters it), or a surface's cell
(reporting its corner nearest the pointer). The description summarizes the
points, the lines (their points, runs, and the rows that break them), or the
surface (its grid, highest, and lowest points), the axes' ranges, and the
camera; it and the keyboard read the data, never what is drawn.

Large standalone 3D charts are drawn by the GPU in the browser, with one depth test for
all of their marks, when every mark can be (opaque points, opaque lines, and
opaque surfaces without a wireframe) and the CPU would draw at least 20,000
faces: 20,000 points, 10,000 surface cells, 20,000 line segments, or a mix
(the WebGL code loads only then). Lines are ribbons a constant width on
screen with round ends and joins; a surface's cells keep their CPU colors
and shading (where facing the light falls on the boundary between two
shading steps, float32 may pick the other). Whatever is nearer shows,
crossings included, and points and lines lying on a surface show over it. Turning the camera uploads nothing, and the pointer
finds what the GPU shows from the data: a ray through a surface's grid, and
points and segments projected once per view. Edges are not antialiased.

Everything else is drawn back to front, as SVG, Canvas, and PDF draw it
(exports always are): points alone by depth, and one surface with any
points in an order exact for a height field, so points under a surface are
hidden by it and those above show; a point's disc is drawn as a marker, cut
only by the cells and lines in front of it, and overlapping points by depth.
Lines are cut at the box's walls into segments sorted by depth among the
other faces (over a single surface, also cut where they cross its columns
and rows and each piece ranked among its cells), which is approximate: a
line piercing a cell, or two lines crossing, can be drawn in the wrong order
near the crossing. Several surfaces in one chart are ordered by their cells'
depth, which can be wrong where they come close or cross. On the benchmark
machine (see `docs/comparison.md`) turning a 1001 by 1001 surface (a million
cells) takes under half a millisecond of JavaScript a frame and keeps 60
frames a second when it turns every frame; on the CPU a 317 by 317 surface
(100,000 cells) takes about 90 ms a turn.

### A second y axis

Marks with `axis: "right"` use a second y scale, drawn on the right and
configured by the chart's `yRight` option (the same options as `y`):

```ts
createChart(element, {
  marks: [
    line(traffic, { x: "time", y: "latency" }),
    line(traffic, { x: "time", y: "requests", axis: "right" }),
    rule({ y: 5000, label: "capacity", axis: "right" }),
  ],
  y: { title: "ms" },
  yRight: { title: "requests/s" },
});
```

Each axis fits its own marks, and tooltips format each value by its axis.
Grid lines follow the left axis (the right one where every mark is on the
right). Category values and marks placed along y (horizontal bars and error
bars) stay on the left; custom marks take `axis` too. Two scales in one plot invite comparisons between
heights that mean different things; for unrelated measures, two charts
sharing x through `interaction: { sync }` are often easier to read.

In charts with facets or subplots, every panel drawing marks on the right
axis has one. Its scale is shared as the left one's is (`resolve.y`), unless
`resolve.yRight` says otherwise:

```ts
createChart(element, {
  marks: [
    line(traffic, { x: "time", y: "latency" }),
    line(traffic, { x: "time", y: "requests", axis: "right" }),
  ],
  facet: facet("region"),
  resolve: { yRight: "independent" }, // each region's requests on a scale of its own
  yRight: { title: "requests/s" },
});
```

Right labels go beside the last panel of each row when the panels of a
row share the right scale, and beside every panel otherwise (making room
between the columns); the right title goes once at the chart's right edge,
beyond a grid's row headers. A subplot draws a right axis only when its
marks are on it, labels and titles it beside itself, and takes its own
settings from its `yRight` over the chart's (panels sharing a right scale
must agree on its type, domain, `zero`, `nice`, ticks, and format, as for
y); a subplot whose marks are all on the right has no left axis, and its
grid lines follow the right one. Zooming along y moves both axes through
the pixels it zooms, so it needs every panel to share both scales: facets
whose right scales are their own cannot zoom along y, and `setViewport` takes
a `yRight` range only when the right scale is shared (subplots take no y
ranges). Brushes report y ranges in the left axis' values. `getPanels()`
gives each panel's right axis with its `group`.

### Financial charts

Prices trade in sessions: nights, weekends, and holidays leave gaps on a time
axis. The x axis' `breaks` leave that time out, so sessions sit side by side:

```ts
import { candlestick, createChart, timeBreaks } from "herceg";

createChart(element, {
  marks: [candlestick(prices, { x: "time", open: "o", high: "h", low: "l", close: "c" })],
  timeZone: "America/New_York",
  x: {
    seams: true,
    breaks: timeBreaks([
      { weekdays: ["sat", "sun"] }, // whole days, midnight to midnight
      { hours: ["16:00", "09:30"] }, // every day, wrapping past midnight
      { dates: ["2025-12-25", "2026-01-01"] }, // holidays
      { from: Date.UTC(2025, 10, 28, 18), to: Date.UTC(2025, 11, 1, 14, 30) }, // instants
    ]),
  },
  tooltip: { axisLabels: true },
});
```

Breaks follow the chart's `timeZone`, wall-clock time included: a span of
`hours` leaves out the instants whose clock time is in it, so on the day
clocks change a night lasts an hour more or less, a span in a repeated hour
is left out both times, and a skipped one takes no time. Starts are
included, ends are not; a candle stamped 16:00 is inside a break from 16:00.
In a spec, `breaks` is the same list; `timeBreaks` brings
the code that resolves them, so charts without breaks do not bundle it.

Set `x.seams: true` to mark collapsed boundaries with dashed vertical lines,
one CSS pixel wide, behind the data and inside the plot. Use
`x.seams: { minSpacing: 40 }` to set the minimum distance in CSS pixels;
it must be finite and positive and defaults to 40. Seams are kept greedily
in chronological order, excluding plot edges, so markers become selective
when zoomed out. They follow each panel's shown domain; the navigator strip
draws none. Omission or `false` disables them. Enabled seams require time-axis
breaks. Seams use the theme's resolved `grid` color and
a `[3, 3]` dash, independently of `gridDash`.

The axis then measures the time it shows. Lines and areas join the points
either side of a break; points, bars, candles, and error bars inside a break
are not drawn, and neither count toward y nor show in tooltips (the
keyboard steps over them). Bars and candles are as wide as the gap between
neighbors in time shown, and room at the axis' ends is time shown too, so
Monday's first candle is not clipped by the weekend before it. Ticks fall
on the calendar of the time shown: a tick that would fall in a break moves
to the end of it, where the next session opens, and reads as the day,
month, or year that begins there ("Oct 13", "Nov"); ticks too close to such
a tick give way. Wheel zoom, panning, brushes, synced cursors, and view
transitions work in time shown; a pixel on a seam reads as the session that
opens there, and a synced cursor at a time this chart leaves out is not
drawn. A view entirely inside a break widens to the hour shown on either
side of it; a fixed `domain` like that is refused. Breaks need a time x
axis; with x scales of their own (`resolve.x`), every panel's time scale
leaves them out, and panels over numbers have none. Rules, regions, and
text inside a break are drawn at its seam.

`tooltip: { axisLabels: true }` labels the crosshair on the axes: the value
it marks on the axis it follows, and the pointer's position on the other
axes (both y axes when there are two), across a dashed line through the
plot. The keyboard and synced cursors label only the value they mark.
Labels go only on axes the chart draws: none for `show: false`, and no y
label in facet columns that share the first column's y axis. The labels' code loads the first time a
chart asks for them.

#### Range navigator

`navigator: rangeNavigator()` adds a strip under the plot that draws the
chart's marks small over the whole x axis, with a window over the x range
in view:

```ts
import { createChart, line, rangeNavigator } from "herceg";

createChart(element, {
  marks: [line(prices, { x: "time", y: "close", id: "close" })],
  navigator: rangeNavigator({ height: 40, marks: ["close"] }),
});
```

Dragging the window pans, dragging either of its edges zooms, dragging
elsewhere in the strip shows the range dragged over, and a double click
shows all of x (y keeps its view). The window follows every other change of
view: wheel zoom and panning, brushes that zoom, `setViewport`, and synced
charts. Its changes are changes of view like those: reported by `viewport`
events, shared with synced charts, and shown at once, not animated. A view
reaching past the data widens the strip to hold it. While data streams, an
x range set with the navigator stays put, as any set x range does, and the
strip grows with the data; with x not zoomed, the window spans everything.
A drag holds on to the strip it started on, so the window moves with the
pointer as data arrives, and lets go if something else changes the view;
if the strip moves or resizes under it (labels that widen a margin, a
resized chart), the drag goes on from where the window is.

The strip is 40 pixels tall by default (`height`, at least 16 and at most a
third of the height the plots and the strip share, and shorter where that
would leave the plots less than 30 pixels, or a row of several panels less
than 20; a chart too short for a 16-pixel strip beside them has none),
under the x axis and its title, across the plots' width, with the strip's
own ticks as grid lines and their labels inside it. It draws the marks
named in `marks` by `id`, or by default every line, area, point, vertical
bar, and candlestick mark (never annotations): lines and areas reduced to a
few points per pixel column, as the plot reduces them, bars and
candlesticks as the plot draws them, and points as a sample of one per
pixel of the strip, all in their series' colors over the data's whole y
range (or the y axis' `domain`). It follows the x axis' breaks. Charts with
layout marks (pies, maps, 3D charts), category x axes, or marks placed
along y (horizontal bars) cannot have one yet.

With facets or subplots, a chart still has one strip and one window, which
show and move the x range every panel shares:

```ts
import { bar, candlestick, createChart, panels, rangeNavigator } from "herceg";

createChart(element, {
  marks: [
    candlestick(prices, {
      x: "time", open: "open", high: "high", low: "low", close: "close", id: "price", panel: "price",
    }),
    bar(prices, { x: "time", y: "volume", panel: "volume" }),
  ],
  panels: panels([{ id: "price" }, { id: "volume" }], { rowHeights: [3, 1] }),
  navigator: rangeNavigator({ marks: ["price"] }),
});
```

The strip goes under all the panels, below the bottom x labels and the x
title, from the left edge of the leftmost plot to the right edge of the
rightmost (across the gaps between columns, whatever their widths, and
short of right axes and a grid's row headers), with an x axis of its own
over the panels' unzoomed x domain. It draws the marks of every panel:
`marks` names them by `id`, wherever they draw. Each panel's part of a mark
is drawn apart, so a facet's series never join from one panel to the next,
and over the y scale the panel has: panels that share y (a facet's default)
stay comparable in the strip, while panels with y scales of their own (a
price panel over a volume panel) each fill it on their own scale, the right
axis apart from the left. A mark drawn whole in several panels sharing a y
scale (`facet: "repeat"`, `panel: "*"`) is drawn once. The panels must
share x: `resolve.x` other than `"shared"` is refused, as one window shows
one x range. Wheel zoom and panning in any panel move the window, and its
changes are one `viewport` event each (without `panels`, as for any change
to a shared x), synced with other charts by x value whatever their panels.
For assistive technology, the sliders say they move the x range of every
panel.

Dense bars are reduced over every CSS pixel column their placed rectangles
intersect, including wide bars and clipped edges. Each column draws the
greatest positive and negative extent from zero (the low end on a log y
axis), one rectangle for each side present. Each rectangle keeps the
winning bar's color and fill opacity, including rows colored through
`series`; ties keep the first series, then its first row. Grouped bars keep
their placed coverage; only footprints intersecting the same column
compete. For stacked bars, each side keeps the complete stack at the
position reaching farthest on that side, with its segment colors; maxima
from different positions are never added. The positive and negative
winners may come from different positions. This preserves extremes, but
fills subpixel gaps and hides shorter bars and their colors; stack
proportions show the chosen positions rather than every position in the
column. Dense bar labels are omitted. Below two nonempty rectangles
intersecting the strip per CSS column on average, the strip keeps the
original rectangles, dodge, stacks, and labels. Missing, zero-area, and
wholly clipped bars do not count. Density detection and rectangle
construction share one source scan, including missing-heavy inputs; dense
stacks then read their selected segments. The same reduction appears in
static SVG, PDF, and PNG.

For the keyboard, the window's left edge, the window, and its right edge
are sliders, in that order in the tab sequence after the legend, named as
the start and end of the range shown (the left edge is the end on a
reversed axis). On an edge, the arrow
keys move it by a hundredth of the strip, Page Up and Page Down by a tenth,
and Home and End as far as it goes, a few pixels short of the other edge;
on the window, they pan it, and with Shift the arrows widen (Right, Up) or
narrow (Left, Down) it about its middle. Keys move values: Right, Up, Page
Up, and End toward larger ones, which on a reversed axis are leftward.
Escape takes a drag back to where it started, or shows all of x.
The sliders' values read as the x axis' tooltips write them, and where the
window ends up is announced politely. The chart's text alternative says
that the navigator shows the whole x range and gives the range in view,
formatted as those tooltips are; with several panels, it says that the
navigator controls every panel's x range. It refreshes at most once a
second as the view changes, outside the live regions. Static SVG and PDF
include that sentence in their description and alternative text. SVG,
PDF, and PNG show the strip and the window, without the sliders. The
strip's model code comes with `rangeNavigator`; the sliders load the first
time a chart has a navigator.
In a spec, `navigator` is
`true` or `{ height?, marks? }`, with facets and panels as without.

### Small multiples

`facet` draws the chart once per value of a category field, wrapped into
rows of panels, or once per pair of values of two fields, in a grid; panels
share their x and y scales unless `resolve` says otherwise:

```ts
import { facet } from "herceg";

createChart(element, {
  marks: [
    line(sales, { x: "week", y: "units" }), // one line per panel: that region's rows
    line(targets, { x: "week", y: "target", facet: "repeat" }), // whole, in every panel
    rule({ y: 100, label: "goal" }), // constants repeat
    rule(launches, { x: "week", textField: "product" }), // each launch in its region's panel
  ],
  facet: facet("region", { columns: 3 }), // in a spec: { field: "region", columns: 3 }
});

// A grid: a row per region and a column per product. Either may be left out
// for one column of rows or one row of columns.
createChart(element, {
  marks: [line(sales, { x: "week", y: "units" })],
  facet: facet({ row: "region", column: "product" }), // in a spec: { row: "region", column: "product" }
  resolve: { y: "rows" }, // each row of panels gets a y scale of its own
});

// Each region measured over its own weeks: an x scale per panel.
createChart(element, {
  marks: [line(trials, { x: "week", y: "response" })],
  facet: facet("site", { columns: 3 }),
  resolve: { x: "independent" },
  x: { title: "Week" },
  interaction: { zoom: true },
});

// Each region's products only, stacked by channel within the region.
createChart(element, {
  marks: [bar(sales, { x: "product", y: "units", series: "channel", stack: true })],
  facet: facet("region"),
  resolve: { x: "independent" }, // in a spec: "resolve": { "x": "independent" }
});

// A heatmap per region, each over the hours and hosts its own rows hold.
createChart(element, {
  marks: [heatmap(load, { x: "hour", y: "host", color: "cpu" })],
  facet: facet("region"),
  resolve: { x: "independent", y: "independent" },
});
```

Panels follow the order in which values first appear in the data; rows
without a value are left out (though their categories still get a band on a
shared category axis). A grid has a panel for every pair of values, rows by
columns, including pairs without rows, with the column values above the top
row and the row values beside the last column; wrapped panels each have
their value above them. Panels are keyed by their value, or in a grid by
both as a JSON array (`["North","A"]`), which inspections report as `panel`;
announcements and the chart's description name them by their values. Marks
over a table split its rows by the fields, which the table must have, unless
they have `facet: "repeat"`; marks without a table repeat. A layout mark (a
pie) is a faceted chart's only mark, and splits its rows too (see [Layout
marks in panels](#layout-marks-in-panels)). Panels share
their x and y scales; `resolve: { y }` gives each panel a y scale of its own
fitting what it draws (`"independent"`), or one per row (`"rows"`) or per
column (`"columns"`), and `resolve: { x }` does the same for x. x labels go
under the lowest panel of each column, or under every panel when a column's
panels have different x scales, with the x title once under each scale's
lowest labels; y labels go
beside the first panel of each row, or beside every panel when a row's
panels differ. Charts whose panels have
y scales of their own cannot zoom along y or take y ranges in
`setViewport` yet. Pointer, brush, and zoom work in any panel and act on
its x scale; the arrow keys step through a panel and Up and Down move
between its series and on to the next panel. A range navigator goes under
all the panels when they share x (see [Range navigator](#range-navigator)). Stacked bars and areas stack within each
panel (areas of a series field on the x positions of that panel's rows), and each panel's heatmap cell shows the last of that panel's rows
with a value there; a heatmap's colors follow one scale in every panel,
over all its table's values. Histograms count, and box plots and violins
summarize, each panel's rows apart. Annotations over a table draw each
row's rule, region, or label in its own row's panel, as other marks do:
labels hide or move off each other within their panel, a panel's scales
fit its own annotations, and the chart's description lists each panel's
after its name (twenty panels at most), as the keyboard does arriving in
a panel; `facet: "repeat"` draws them all in every panel, and constants
repeat. Custom marks over a table without series can only repeat for now.
Marks on the right axis get one in every panel (see [A second y
axis](#a-second-y-axis)). A chart too small for its
panels (under 20 pixels a side) throws an error naming the grid; give it
more room or fewer columns.

With x scales of their own, each scale fits what its panels draw within its
own range, and zooms, pans, and resets by itself: the wheel and dragging act
on the panel under the pointer, double-clicking a panel resets its scale,
and double-clicking outside the panels resets every one. A shared y scale
still fits what every panel shows of its own x range, so zooming one panel
can change the y of the others. `setViewport([from, to], { panel })` names
the panel whose scale shows the range (null without a panel resets every
scale), and `viewport` events carry `panels`, the keys of the panels whose
range `x` is, one event per scale. A selection belongs to the panels
sharing the x scale of the panel it was made in: it is drawn only there,
`select(range, { panel })` needs that panel, and `select` events and
`chart.selectionPanels` name them; a selection whose panels go (their facet
values leave the data) is cleared. Synced charts share cursors with such a
chart, drawn in every panel whose scale holds the value, but not viewports
or selections, which belong to some of its panels; sync only charts whose x
values mean the same thing. A scale's zoom is kept while its panels stay the
same: when they change (a new facet value wraps the panels anew), it fits
its data again.

A category axis that panels do not share holds only the categories of the
rows its panels draw (for box plots and violins, of the rows with a value),
in the order the shared axis would have them
(dictionary order, across the marks' tables in the chart's order), so a
category's band index can differ from one panel to the next: tooltips,
`toPixel`, `formatValue`, and selections read each panel's own (its axis'
`categories` in `getPanels()`). A mark with `facet: "repeat"`, or a subplot's
mark, counts all its rows in every panel it draws in; an empty panel has an
empty axis. Bars, box plots, and violins grouped by series keep a slot per
series of the mark in every category, whichever series a panel has, and
stacks, split into panels first, never reach across them. A selection on such an axis is cleared when
its panels' categories change, since its band indices would then name other
categories (the axis' `group` changes with them), and the keyboard carries
its cursor to another scale by its place across the plot (into a heatmap,
at its top left cell). Charts with categories of their own cannot be synced
or brushed along a y axis of categories.

### Subplots

`panels` draws different marks in different panels of one chart, sharing x
unless `resolve.x` says otherwise:

```ts
import { panels } from "herceg";

createChart(element, {
  marks: [
    line(metrics, { x: "time", y: ["p50", "p99"], panel: "latency" }),
    bar(metrics, { x: "time", y: "requests", panel: "traffic" }),
    rule({ x: deployedAt, label: "deploy", panel: "*" }), // in every panel
  ],
  panels: panels(
    [
      { id: "latency", title: "Latency", y: { title: "ms" } },
      { id: "traffic", title: "Requests", y: { type: "log" } },
    ],
    { columns: 1, rowHeights: [2, 1] }, // in a spec: "grid": { "columns": 1, "rowHeights": [2, 1] }
  ),
});
```

Each mark names the panel it draws in with `panel`, or `"*"` for all of
them; in a chart with panels, a mark without one is an error rather than
drawn everywhere by accident. Panels fill rows of `columns` (one by default)
in order, with their titles above them; `rowHeights` and `columnWidths` give
the rows' heights and the columns' widths relative to each other (a shared
scale keeps one domain over rows or columns of different sizes, each with
ticks for its size). They share the x axis, labeled under
the lowest panel of each column, and each has a y scale of its own, from its
marks (on a category y axis, of horizontal bars, box plots, violins,
heatmaps, or points, its own categories, as in Small multiples);
`resolve: { y: "shared" }` (or `"rows"`, `"columns"`) shares it
instead, when the panels sharing it agree on its type, domain, `zero`, and
`nice`. A panel's `y` takes the place of the chart's `y` settings for its
own axis, so one panel can be logarithmic or show times while another is
linear; a panel's y title is centered beside it. `resolve: { x:
"independent" }` (or `"rows"`, `"columns"`) gives panels x scales of their
own in the same way, each from its panels' marks (a time axis when they
place times) and its first panel's `x` settings, with labels and a title
under its panels as in Small multiples; panels sharing an x scale must agree
on its settings, title included, and a panel's `x: { show }` shows or leaves
out its own labels. A time series over a time axis can then sit above a distribution
of its values:

```ts
createChart(element, {
  marks: [
    line(metrics, { x: "time", y: "latency", panel: "series" }),
    bar(buckets, { x: "ms", y: "count", panel: "spread" }),
  ],
  panels: panels([
    { id: "series", x: { title: "Time" }, y: { title: "ms" } },
    { id: "spread", x: { title: "Latency (ms)" } },
  ]),
  resolve: { x: "independent" }, // in a spec: "resolve": { "x": "independent" }
});
```

Marks keep their place in the chart's list as their identity, so colors,
the legend, and hidden series do not depend on the panel a mark draws in. Inspections report the `panel`
id. A panel's `yRight` sets its right axis (see [A second y
axis](#a-second-y-axis)), and zooming and brushing act on x only. A range
navigator goes under all the panels and moves the x range they share (see
[Range navigator](#range-navigator)).

### Layout marks in panels

Pies, treemaps, sunbursts, gauges, funnels, radars, Sankey diagrams, maps,
and networks draw in panels too: with a facet, a layout mark is the chart's
only mark and draws each panel's rows there, as marks along axes do; with
subplots, it has the panel it names to itself, beside panels with axes.
3D marks share a subplot with other 3D layers, with their own camera,
or a chart of their own; 3D facets are refused.

```ts
// Small multiples: a pie of each region's sales, with one legend for all.
createChart(element, {
  marks: [pie(sales, { category: "product", value: "revenue" })],
  facet: facet("region", { columns: 4 }),
});

// A dashboard row: revenue over time, and each product's share beside it.
createChart(element, {
  marks: [
    line(sales, { x: "week", y: "revenue", panel: "trend" }),
    pie(sales, { category: "product", value: "revenue", innerRadius: 0.6, panel: "share" }),
  ],
  panels: panels(
    [
      { id: "trend", title: "Revenue" },
      { id: "share", title: "By product" },
    ],
    { columns: 2, columnWidths: [2, 1] },
  ),
  interaction: { zoom: "x" }, // the line's panel zooms; the pie's has no axes
});
```

A layout mark's panel has no axes, and nothing else draws in it: the mark
takes the room its neighbors' plots have, its labels kept inside. Each
facet panel's pie sums only that panel's rows; each treemap and sunburst
totals them over the table's tree, each gauge shows their last finite
value, and each funnel, radar, and Sankey diagram reads only them. Radars
keep the table's spokes and series in every panel, each scaled to its own
values unless `domain` is given; funnels have the stages their panel's rows
name. An item keeps its key in every panel, so a category has one color and
one legend entry, and its legend button hides it everywhere. Tooltips,
hover, and click events report the panel's key as `panel`; the arrow keys
read a panel's items, Up and Down moving on to the next panel or series,
and the chart's description names each panel before what it shows (up to
20). In a chart of subplots, a layout mark names one panel (not `"*"`),
which takes no `x` or `y` settings, and marks with `panel: "*"` are
refused there, since they would draw in it. Panels with axes keep zooming,
brushing, and syncing; a chart whose panels all draw layout marks has no x
axis for those. Values animate only in a chart of one layout mark.

A map's layers are one mark: in facets, each layer splits its rows by the
facet field, unless `facet: "repeat"` draws it whole in every panel (a base
map under the points that split), and every panel's map is fitted to the
rows of all of them, so a place is at the same pixels of each panel; in
subplots, the layers naming a panel are its map. A network's facet panels
share one layout of the whole network: each draws its rows' links, sized
and labeled by those rows alone, and the nodes they join, where the layout
puts them; nodes without links there are not drawn (the nodes table colors
and sizes nodes, it does not place them in panels).

```ts
// A map per year, over one base map; zooming one zooms them all.
createChart(element, {
  marks: [
    geoshape(countries, { facet: "repeat" }),
    geopoint(stores, { longitude: "lon", latitude: "lat", size: "sales" }),
  ],
  facet: facet("year"),
  interaction: { zoom: true, brush: "lasso" },
});

// Two trees side by side, each drilled on its own.
const chart = createChart(element, {
  marks: [
    treemap(budget, { path: ["unit", "team"], value: "cost", panel: "cost" }),
    treemap(budget, { path: ["unit", "team"], value: "staff", panel: "staff" }),
  ],
  panels: panels([{ id: "cost" }, { id: "staff" }], { columns: 2 }),
  interaction: { zoom: true },
});
chart.on("drill", ({ key, panels }) => console.log(panels, key)); // ["staff"], '[1,"R&D"]'
chart.setDrillRoot(["R&D"], { panel: "cost" });
```

Navigation and selection work the same in panels. Facet panels show one
mark's rows split by a field, and compare like with like, so they share
one state, as panels share a scale: one drill root (a panel with nothing
under it shows the path, and nothing), one view of a map's or network's
plane, and one set of moved nodes; drilling, zooming, or moving a node in
one panel does it in all of them, with one event that names no panel. Each
subplot's tree, map, or network has its own, set with its `panel`
(`setDrillRoot(node, { panel })`, `setViewport(view, { panel })`,
`setItemPosition(key, position, { panel })`, and the getters), which a
chart of several such subplots needs, and reported with `panels: [id]`
in `drill`, `viewport`, `itemMove`, and `select` events. Without a panel,
`getViewport` and `setViewport` are the axes' when the chart has panels
with axes. A subplot's state goes when the subplot does. The pointer acts in
the panel it presses (a drag stays there) and the keyboard in the panel the
cursor reads; facet panels have one toolbar, in the chart's corner, and
the first panel's path takes the Tab key (the others' take the pointer),
while each subplot has its toolbar and path. A lasso on facet panels'
shared plane is drawn in each and selects every panel's rows inside it; a
subplot's is its own; a chart has one selection either way. With
`rowSelection`, a click selects what an item stands for in its panel: a
tree node's rows there, a region's or point's row, a link's rows there, or a
node's rows of the nodes table, which every panel shares. Exports draw each
panel as it is.

### Custom marks

When no mark fits, `custom` draws shapes with the chart's scales on every
frame. Shapes render like other marks: in SVG or on a canvas, clipped to the
plot, and in static SVG. With a table, the `x` and `y` fields count toward
the axis domains, and with one `x` field the `y` fields are series, as for
`line`: one per field, or one per value of a `series` category field. Series
have legend entries (which hide them), tooltips and hover and click events
at the nearest x, keyboard stops, and sentences in the chart's text
alternative, and in charts with facets they split by panel.

```ts
custom(requests, {
  x: "time",
  y: "latency",
  series: "service",
  description: "Request latency per service.", // for the chart's text alternative
  pointText: (row, format, s) => `${format.y(s.y[row]!)} ms`, // tooltip text; default: the y value
  zero: "y", // stems stand on zero, so the y axis includes it, as for bars
  draw({ series, x, y, line, circle }) {
    for (const s of series) {
      for (let k = 0; k < s.length; k++) {
        const row = s.rowAt(k);
        const [px, py] = [x(s.x[row]!), y(s.y[row]!)];
        line(px, y(0), px, py, { stroke: s.color });
        circle(px, py, 4, { fill: s.color });
      }
    }
  },
});
```

`draw` receives `x` and `y` (data value to pixel; band index on category
axes), `domain`, `bandwidth`, `plot`, `theme`, and `path` (SVG
path syntax), `rect`, `circle`, `line`, and `text`, each with an optional
style (`fill`, `stroke`, `strokeWidth`, `opacity`, `dash`); they paint the same
on a canvas as in SVG (butt caps, miter joins, opacity applied to fill and
stroke separately). With a table, `draw` also gets it, and `series`: the
series to draw, without those hidden from the legend, each with its `label`,
`color`, `x` and `y` columns, `length`, `rows` (undefined when it holds
every row; in a facet panel, that panel's rows), and `rowAt(k)`, the row of
its point `k` (0 to `length - 1`), which indexes `x`, `y`, and the table's
columns. A `draw` that reads the table directly instead draws hidden series
and every panel's rows. The y axis fits the series' values in view, and
those of the points just past its edges, so shapes between neighboring
points stay in view; `zero: "y"` (or `"x"`, for horizontal shapes) says the
mark's shapes are drawn from zero, which the axis then includes, as it does
for bars, unless the axis says `zero: false`. Custom marks with series take
`tooltip: { fields }` as other marks do (see Tooltips).

Glyphs drawn from several fields of a row, such as ranges from `low` to
`high`, are not one series per field: give them `series: false`, and their
fields only count toward the domains, as do fields other than one `x` and
the `y` fields (both ends of horizontal spans, `x: ["start", "end"]`). Such
marks have no series, and in charts with facets need `facet: "repeat"`
(annotations, which have none either, split by panel as other marks do).
Custom marks are JavaScript only (a chart spec cannot hold a function), are
found by their points rather than their shapes, and are meant for shapes in
the thousands, not millions. They are how applications add marks: what the
built-in marks implement (how they resolve series, pick points, and lay out)
is internal, and charts take only marks the mark functions make.

## Chart options

| Option | Description |
| --- | --- |
| `marks` | Marks to draw, bottom to top (rules are drawn on top). |
| `title`, `description` | Accessible name and description; the title is drawn. |
| `width`, `height` | Fixed size; omitted dimensions follow the container (a block one in Firefox, where a chart in a `<span>` keeps its first width). |
| `x`, `y` | Scale and axis: `type` (`linear`, `log`, `time`), `domain`, `nice`, `zero`, `title`, `grid`, `ticks`, `format` (Intl options, for tick labels and tooltips), `tooltipFormat` (Intl options for tooltips, the keyboard, and crosshair labels only; see Tooltips), `show`; on a time x axis, `breaks: timeBreaks([...])` and `seams: true` or `{ minSpacing?: number }` (see Financial charts). |
| `yRight` | The right y axis for marks with `axis: "right"`, with the same options as `y`. |
| `facet` | `facet(field, { columns? })`: a panel per value of a category field, wrapped; or `facet({ row?, column? })`: a grid by two fields (see Small multiples). |
| `resolve` | `{ x?, y?, yRight? }`, each `"shared" \| "independent" \| "rows" \| "columns"`: which panels share an x, y, or right y scale (`yRight` as `y` unless given; see Small multiples, Subplots, and A second y axis). |
| `panels` | `panels([{ id, title?, x?, y? }, ...], { columns?, rowHeights?, columnWidths? })`: subplots whose marks name them in `panel` (see Subplots). |
| `navigator` | `rangeNavigator({ height?, marks? })`: a strip under the plot (under every panel, with facets or subplots) over the whole x axis, whose window shows and moves the x range in view (see Range navigator). |
| `legend` | Shown by default for two or more series; legend entries toggle series. |
| `tooltip` | `true` (default), `false`, or `{ mode?: "nearest-x" \| "nearest-y" \| "nearest", axisLabels?: true }`; `axisLabels` labels the crosshair on the axes. Marks take `tooltip: { fields }` for data of their rows (see Tooltips). |
| `renderTooltip` | JavaScript only: the tooltip's content of your own, text or a node, in the built-in box (see Tooltips). |
| `interaction` | `zoom`: `true` or `"x"`, `"y"`, or `"xy"` for wheel zoom and drag pan along those axes (category axes do not zoom); maps and networks pan and zoom both ways (`true` or `"xy"`), and treemaps and sunbursts drill into nodes (`true`). `drag: true` moves a network's nodes. `brush`: `"x"` or `"y"` to select a range by dragging, `"xy"` a rectangle, `"lasso"` a freehand region; along zoomed axes, a brush zooms instead (Shift-drag pans; lassos never zoom), unless it selects rows for `rowSelection`. `sync: "name"` shares cursor, x range, and selection with other charts; selections travel as data values (category indices on category axes), so charts sharing them should have the same axis types and category order. `rotate: false` stops dragging from turning 3D charts, whose `zoom` is `true` or `false`. Maps and networks take a `"lasso"` brush and no other. |
| `rowSelection` | `rowSelection({ store, channel, events?, effect? }, ...)`: channels of selection stores, one per table, that brushes, lassos, and clicks write rows to and the chart highlights (see Selected rows). |
| `animation` | `true` or `{ duration?, values? }`: the axes move gradually to views asked for, and with `values: true`, bars, pie slices, points, small lines and areas, and the axes with them, to changed values (see Animation). Off by default. |
| `renderer` | `"auto"` (default), `"svg"`, or `"canvas"`. |
| `theme` | A theme name or an object overriding a theme's tokens (see Themes). |
| `locale`, `timeZone` | Label locale and time zone (`"local"`, `"UTC"`, or an IANA name). |
| `projection` | How maps are projected: a projection's name or `{ type, centralMeridian?, parallels?, fit? }` (see Maps). |
| `z`, `camera`, `boxAspect` | 3D charts' vertical axis (options as for `x` and `y`), where they are seen from at first (`{ azimuth?, elevation?, zoom?, perspective? }`), and their box's side lengths (see 3D charts). |

Time axes try coarser calendar tick intervals when `format` repeats labels,
then drop any remaining duplicates, including nonadjacent ones. A date-only
format therefore uses day ticks rather than repeated hour labels. The
default date/time formats stay unchanged where they distinguish ticks.
`tooltipFormat` formats tooltip, keyboard, and crosshair values independently;
it does not change the axis ticks. Pass the same Intl options there when
those values should use the same precision.

The returned `Chart` has `root` (its element), `update(options)`,
`setViewport(view | [from, to] | null, { panel? })` and `getViewport({ panel?
})`, `select(selection | [from, to] | null, { panel? })` (a pair is shorthand
for an x range), `selection` and `selectionPanels` (see Small multiples for
`panel`), `getCamera({ panel? })` and `setCamera(camera | null, { panel? })`
(3D charts and subplots),
`getDrillRoot({ panel? })` and `setDrillRoot(node | null, { panel? })`
(treemaps and sunbursts), `getItemPositions({ panel? })` and
`setItemPosition(key, position | null, { panel? })` (networks), `getPanels()`,
`toPixel`, `fromPixel`, `formatValue`, and `inspect` (see Panels and pixels),
`getLegend()`, `getHiddenKeys()`, `setHiddenKeys(keys)`, and
`setVisibility(keys, visible)` (see Hiding series), `on(event, listener)`,
`render()`, `toSVG()` and `toPNG()` (see Export), `destroy()`, and `loading`
(a promise while the GPU painter for large point series, the animation
code, the controls of a 3D chart, a map, a tree, or a network, the brush, a
navigator's sliders, or what reads tooltip fields and draws
`renderTooltip`'s content load, otherwise undefined). The brush loads when a chart can brush
or first shows a selection; selections are kept and reported before it has,
and a drag that starts before it arrives goes on from where it began. Tests
that drag right after creating a chart await `chart.loading` first.

A `Viewport` is `{ x, y, yRight }`: the visible x range and the left and right
y axes' ranges, in data values (epoch ms on time axes), each null when that
axis is not zoomed and shows its configured `domain` or its data.
`setViewport` changes the axes it is given (`setViewport({ y: [0, 100] })`
zooms y alone; `{ x: null }` resets x) and keeps the others; a pair is an x
range, and null resets every axis. Its changes are one change of view: one
animation and one `viewport` event. `getViewport()` returns all three, so a
saved view restores with `chart.setViewport(saved)`. In charts whose panels
have x scales of their own, x ranges need the `panel` whose scale shows them;
y ranges are the chart's. Code written for the earlier API reads the event's
`x` for its `domain`, and calls `setViewport({ y })` for `setYViewport(y)`,
giving `yRight` too where the right axis should move with it.

`update` takes a `ChartUpdate`: each option given replaces the chart's,
nested options (an axis, `interaction`, `tooltip`) whole, so pass every
setting you want to keep; an option given as `undefined` goes back to its
default; options left out are unchanged. React, Vue, and Svelte props are the
whole configuration: a prop left out, or `undefined`, takes its default.

`selection` is a `Selection`, `{ x, y, lasso }`, or null, all in data values:
the selected x and y ranges (null along an axis the brush leaves alone; a
lasso's extent) and a lasso's outline as `[x, y]` pairs. Code written when
`selection` was the x range reads `chart.selection?.x`.

### Tooltips

The tooltip shows what is at the pointer or keyboard cursor: the position
(the x value, or y in `nearest-y` mode, or an item's name), then a row per
series or item with its value, written as the axis' `format` writes it.
`tooltipFormat` on an axis writes tooltips', the keyboard's, and the
crosshair labels' values without changing tick labels. Marks whose points
are rows (lines, areas, bars, points, rugs, error bars, candlesticks,
heatmaps, map regions and points, 3D points and lines, and custom marks
with series) show more of the row with `tooltip: { fields }`: a field's
name, or `{ field, label?, format? }` with Intl options, under each point's
row in order. Fields are checked against the mark's table at compile time
and when the mark is made; without a format, numbers are written as the
chart's other numbers, times as the x axis writes them when it is a time
axis (else as dates and times), and categories as they are; missing values
show as "–". Marks whose points summarize rows (histogram bins, box plots,
violins, pie slices, tree nodes, networks, Sankey diagrams) take no fields.

```ts
createChart(element, {
  locale: "en-US",
  marks: [
    line(latency, {
      x: "time",
      y: "p99",
      tooltip: { fields: [{ field: "requests", label: "Requests" }] },
    }),
  ],
  x: { tooltipFormat: { weekday: "short", month: "short", day: "numeric" } }, // "Wed, Jan 21"
  y: { title: "ms", tooltipFormat: { style: "unit", unit: "millisecond" } }, // "304 ms"
});
```

The fields are in inspections too, so hover and click events, `inspect`,
and the keyboard's announcements read them: each `InspectedPoint` has
`fields`, `{ field, label, kind, value, text }` for each, its value a number
(epoch milliseconds for times), a category, or null. The code that reads
and draws them loads the first time a chart has any (`chart.loading`).

For content of your own, `renderTooltip` (JavaScript only) returns text,
which is shown as text and never parsed as markup, or a node, for an
inspection; null or undefined shows the built-in content. The box keeps its
placement (beside the pointer, inside the chart), the crosshair and the
highlighted points stay, and the keyboard's announcements still read the
inspection as the built-in content writes it. It is called when what the
tooltip is at changes, not on every pointer move, and the box is placed
again as the node's content changes size, so frameworks may render into it
later. The React, Vue, and Svelte adapters render their own components
there (a `renderTooltip` prop, slot, or snippet).

```ts
createChart(element, {
  marks: [line(latency, { x: "time", y: "p99" })],
  renderTooltip: ({ points }) => `${points[0]?.text ?? ""} ms`,
});
```

### Animation

`animation: true`, or `{ duration }` in milliseconds (250 by default), moves
the axes gradually to a view asked for: `setViewport` (both axes of one call
together), zooming to a brush, and double-click reset. With `values: true`
too, marks move to new values when a table's values change in place or are
replaced (`set`, `replace`, `setColumn`, `reset`), and axes whose automatic
domains change move with them:

```ts
const chart = createChart(element, {
  marks: [bar(sales, { x: "region", y: "revenue" }), rule({ y: 50 })],
  animation: { values: true },
});
sales.setColumn("revenue", next); // the bars, the y axis, and the rule move
```

The axes move between the domains drawn before and after the change, and
each frame places ticks for the domain between as the chart places its own,
so ticks may change step on the way; marks are drawn through those moving
scales, so a bar or point whose value stays moves only as far as its axis
does, and a rule moves with its axis. Log axes move, and values on them, in
log space.

- **Bars** are matched by series and position (their category, or their x
  value), so rows may arrive in another order. Bars that appear grow from
  their base and bars that go shrink to it; a bar whose value changes sign
  shrinks to the baseline and grows on its other side.
- **Pie slices** are matched by category and turn to their new sizes,
  sharing their boundaries, so they always make a whole pie; slices that
  appear open from nothing and slices that go close.
- **Points** are matched by the row they show, so `set`, `replace`, and
  `setColumn` move each point from its row's old values to its new ones,
  with sizes, colors, and opacities they encode. A row whose point appears
  (its value was missing) grows from nothing, and one whose point goes
  shrinks, where its values are. To match points across `reset` or reordered
  API responses, set `point(data, { x: "x", y: "y", animationKey: "id" })`.
  The key names a number or category field (portable specs also accept time
  fields). Both scenes must use the same field and kind; equal finite numbers
  (`-0` equals `0`) or category labels match within each series. Dictionary
  codes can change. Explicit keys replace row matching: missing or duplicate
  keys in either rendered series show that series' new values at once, and
  if its axes move the whole change shows at once. Retained points move, new
  keys grow from zero radius, and removed keys shrink to zero. Without a key,
  points do not move across `reset`, which makes new rows. Sampled points
  (`sampling: "pixel"`) and GPU points do not move.
  A point that moves outside a fixed or zoomed axis' domain shrinks rather
  than leaving the plot.
- **Lines and areas** move when both scenes draw them through the same x
  positions, every row a point: no level of detail (a line with more rows
  than the plot's device pixels across reduces), missing values, or axis
  breaks. Their points move along y, monotone curves curved through the
  values between as the mark curves its own, and an area's edges, baseline,
  and a stack's shared edges move together; a stack's layers move together
  or, when one cannot, not at all. Rows at the same x after a `reset` count
  as the same points.

Only the drawing moves: data, tooltips, events, and summaries have the new
values at once. Animation keys do not preserve selections, row identities,
or hover state across resets. A derived table is recomputed whenever its
source changes, so marks of an aggregate over rows that keep arriving move with each change
that comes after the last has settled (every few seconds, say) and show more
frequent ones at once.

A change shows at once when the plot moves (labels wider than the margin had
room for: margins only grow, so the next change moves), categories or series
appear or go, a legend wraps differently, slices change order (with `sort:
"value"`, the default, when values pass each other), a line's x positions
change, or a mark that cannot move (stacked or labeled bars, text, heatmaps,
custom marks, or a line or point that cannot) shares an axis that moves;
with axes that stay, such marks show their new values while the others move.
So do appended and dropped rows, changes while values move and until the data
has been still for a change's duration, changes of options and of hidden
series, bars on log axes, bars sharing a position in one series, x axes with
breaks, scenes of more than 2,000 bars, slices, and rules, 10,000 points
(including points shrinking on exit across all series), or
10,000 points of lines and areas, point clouds, marks over row views, charts with
several panels or `sync`, charts off screen, charts the pointer is over,
pressed, or read with the keyboard, pages preferring reduced motion, and
charts whose frames seem to take over 10 ms (judged from earlier frames,
alone or with the charts beside them). Moving the pointer, pressing, and keys
show the new values and axes before they act, and `render()`, export, and a
chart's first frame always draw them. Wheel zoom, panning, new data, resizes,
and export show views at once too; charts with several panels or `sync` do
not move their views. The code for views loads with the first chart that
asks for `animation`, and the code for values separately, with the first that
asks for `values`.

### Themes

The built-in themes are `"light"` (the default), `"dark"`, `"high-contrast"`,
and `"high-contrast-dark"`, each painting a surface of its own (white,
`#12151c`, white, and black), so a chart reads the same on any page and in
every export. `"auto"` is light or dark to match the surface the chart sits
on, and transparent, showing that surface: the background colors around it
(through translucent layers and shadow roots), or, on a page without one,
the user's `prefers-color-scheme` when the page's `color-scheme` allows dark.
It switches when that changes. A chart in a frame judges the frame's own
page; give it a theme or background when the page around the frame is dark.
Any theme shows the page instead with `background: "transparent"`, as for a
chart in a tinted card. The categorical palettes keep adjacent series apart
for the common forms of color blindness, and every color reaches 3:1 against
its theme's surface (the high-contrast palettes 4.5:1).

An object overrides any of a theme's tokens, starting from `extends` (light
by default):

```ts
createChart(element, {
  theme: {
    extends: "auto",
    background: "transparent",
    text: "var(--ink, #1c2333)",
    palette: ["var(--brand)", "#ec6a2c", "#109e7f"],
    barRadius: 0,
  },
  marks: [bar(sales, { x: "region", y: "total" })],
});
```

| Token | Description |
| --- | --- |
| `background`, `text`, `muted`, `grid`, `axis` | Chart surface, titles and legend text, tick labels, grid lines, axis lines. |
| `font`, `fontSize`, `titleSize` | Font family, label size, and title size in px. |
| `gridDash` | Grid line dash pattern, such as `[2, 3]`; `[]` for solid lines. |
| `lineWidth` | Width of lines and area outlines that set none. |
| `barRadius` | Corner radius at the value end of unstacked bars; `0` for square bars. |
| `tooltipBackground`, `tooltipBorder` | Tooltip surface and border. |
| `palette` | Series colors, assigned in order. |
| `sequential`, `diverging` | Hex ramps for color scales, low to high. |
| `rise`, `fall` | Candlestick colors. |

Colors and the font may use CSS variables. Charts in a page read them, and
colors in any CSS syntax, from the page; they read the page again when the
class, style, or data attributes of its root or body element change (call
`update({})` after other theme changes). Static output (`renderToSVG`, PNG,
and PDF) has no page: each variable takes its fallback, and `"auto"` is light.
PDF output reads hex, `rgb()`, `hsl()`, and named colors. PDF pages are
white: a transparent theme with light text (a dark theme without its
background, or `"auto"` on a dark page) gets the dark surface it was meant
for.

## Events

`on` returns a function that stops listening:

```ts
const stop = chart.on("select", ({ x }) => {
  if (x) detail.setViewport(x); // show the brushed range in another chart
});
chart.on("select", ({ x, y, lasso }) => filterRows(x, y, lasso)); // ranges, and a lasso's outline
chart.on("viewport", ({ x, y, yRight }) => saveView({ x, y, yRight })); // zoom, pan, reset, sync
chart.on("viewport", ({ x, panels }) => saveView(x, panels)); // panels' own x scales
chart.on("hover", ({ inspection }) => showOwnTooltip(inspection)); // with tooltip: false
chart.on("click", ({ inspection }) => {
  const point = inspection?.points[0];
  // The row of the mark's table the point is: the record clicked.
  if (point?.markId === "orders" && point.row !== undefined) openOrder(orders.value("id", point.row));
});
chart.on("select", ({ rows }) => rows && saveFocus(rows)); // with rowSelection: what the brush wrote
chart.on("rowSelection", ({ table, channel, selection }) => count(selection)); // a bound channel changed
chart.on("camera", ({ camera }) => saveView(camera)); // a 3D chart turned
chart.on("drill", ({ key, path }) => saveDrill(key)); // a treemap or sunburst drilled into a node
chart.on("itemMove", ({ key, position }) => savePlace(key, position)); // a network's node moved
chart.on("drill", ({ key, panels }) => saveDrill(panels?.[0], key)); // a subplot's tree
chart.on("visibility", ({ hiddenKeys }) => saveHidden(hiddenKeys)); // legend, setVisibility
chart.on("render", () => placeOverlay(chart.getPanels())); // a frame of the data was drawn
```

Events report changes only: a re-inspected point or an unchanged view does
not repeat them. A `viewport` event reports a change of several axes (an xy
wheel zoom, a brushed rectangle zoomed to) once, with every axis' range; a
map's are its plane's x and y ranges. `panels` names the panels a change
belongs to when they are only some: those of an x scale of their own, or a
subplot's map, network, or tree (`viewport`, `select`, `drill`, and
`itemMove` events). `drill` and `itemMove` events follow
`setDrillRoot` and `setItemPosition` too, as `camera` events follow
`setCamera`. An
inspection's `axis` says what it is on: `"x"` or `"y"` for a position along
that axis (with its `position` in pixels), `"item"` for an item of a layout
mark (a pie slice, a tree's node, a gauge's dial, a funnel's stage), whose
`value` is the item's and whose one point names it.

Each of an inspection's `points` says where it comes from: `mark`, the
mark's index in the chart's `marks`, and `markId`, its `id` if it has one;
`key`, an opaque string identifying the point's series (or a layout mark's
item) in the chart; `label`, what the tooltip names it by; and `row`, the position
in the mark's table (for a mark over a row view, the view's table) of the
row the point is, which `table.value(field, row)` reads and a `RowSet` adds
(`picked.add(point.row)`). Points at
the same coordinates have their own rows (the pointer reports the first
drawn there; the keyboard reaches each). A point that is no one row has no
`row`: histogram bins, box plot and violin groups, pie slices, funnel stages,
tree nodes, and network and Sankey nodes and links summarize rows. A
heatmap cell's row is the last row in that cell, which colors it; a gauge's,
the row of the value it shows; a radar point's, the last row giving its
series that spoke's value. Positions count from the table's first current
row, so dropping rows from a stream renumbers the others: read a row, or
add it to a `RowSet`, which holds rows by identity, in the listener that
receives it. Keyboard users select a range with Shift and the arrow keys
along the axis the keys step along (x for lines and vertical bars, y for
horizontal bars), with brushes along that axis or rectangle and lasso
brushes, which only the pointer draws; Enter zooms to the range when zoom is
on along it, and Escape clears it. Selections made with the keyboard or the
pointer are announced.

With `rowSelection`, `select` and `click` events also carry `rows`: per
table, what the gesture wrote to its channel (a brush's condition, the rows
of a lasso or click, or null where it cleared them). Selections a synced
chart shows write nothing. `rowSelection` events report a bound channel's
changes by any writer (this chart, another, a grid): its `table`, `channel`,
and `selection`, a `DataSelection` or null.

## Panels and pixels

`getPanels()` describes the panels of the last frame drawn, in reading order:
each one's `key` and `label`, its `plot` (the area inside the axes), and its
`x`, `y`, and, with marks on the right axis, `yRight` axes. An axis has its
`type`, its `domain` (the values shown) and `range` (where they lie), and on
category axes its `categories` and `bandwidth`; panels whose axis has the same
`group` share its scale, and `canSetViewport` says whether `setViewport`
zooms it (not category axes, nor y axes of panels with y scales of their
own on that side). A panel a layout mark draws in (a pie's, and the one panel of a chart
of a layout mark, a map, or a 3D chart) has no axes, and `toPixel` and
`fromPixel` give undefined there. Pixels are CSS pixels from the top left
corner of `chart.root`, whatever the device pixel ratio.

```ts
const box = chart.root.getBoundingClientRect();
const [x, y] = [event.clientX - box.left, event.clientY - box.top]; // the chart's pixels
const at = { panel: "North", axis: "x" } as const; // a panel only with several panels
const px = chart.toPixel(Date.UTC(2026, 0, 5), at); // where a time is, or undefined
const time = chart.fromPixel(x, at); // the value at a pixel
const label = time === undefined ? "" : chart.formatValue(time, at); // as tooltips write it
const found = chart.inspect(x, y); // what the tooltip would show there
```

Values are numbers, epoch milliseconds on time axes, and fractional band
indices on category axes: `fromPixel` does not round them, and
`formatValue` gives the category at the index. Values past the domain map
past the plot, unclamped. `toPixel` gives undefined for what the axis cannot
show (values that are not finite, values that are not positive on log axes,
and times a break leaves out), and `fromPixel` at a break's seam gives the
first time shown after it. Every method gives undefined for an axis the
panel does not have, and throws for a panel the chart does not have; charts
of several panels need `panel`, even where they share a scale, since each
panel maps it to pixels of its own. `inspect` finds what the pointer would
there, in the panel under the pixel or in `panel` (with `mode` to find it
another way than the tooltip does), without moving the cursor, showing a
tooltip, or emitting an event.

Panels, pixels, legend entries, and inspections describe the last frame
drawn, as what is on screen does: a change (an update, new data, a resize)
shows in them once the chart draws it, on the next animation frame, or at
once with `chart.render()`. They never draw a frame themselves, so reading
them in a pointer handler costs no drawing. Inspections find points among
the series the last frame drew but read their values from the tables, so
after changing a table in place (`set`, `replace`, `dropFirst`), call
`render()` before inspecting to find values where they are drawn. A `render` event follows each
frame that draws the data (a cursor moving alone draws none), for overlays
that follow the chart's panels; `createChart` draws the first frame before it
returns, so read the panels once then. `loading` is about code the chart loads,
not about frames still to draw.

### Hiding series

The legend's entries hide and show what they name, which the chart's
methods do as well, with or without the built-in legend:

```ts
const [first] = chart.getLegend(); // { key, label, color } for each series, or each pie slice
chart.setVisibility(first!.key, false); // or a list of keys
const hidden = chart.getHiddenKeys(); // keep them, and restore them with setHiddenKeys
chart.setHiddenKeys([]); // show everything
```

Keys are opaque and are the keys inspections name points by. Hidden series
are not drawn, inspected, or visited by the keyboard, and value axes fitted
to the data leave them out; each change reports one `visibility` event, the
legend's buttons and these methods alike. Keys of series not drawn now (a stream
moved past them) stay hidden for when they return. A mark's keys go with its
identity, its `id` or else its index in `marks`: an update without the mark
drops them, and a mark that takes its index keeps them, so give marks ids
when their order changes.

## Accessibility

A chart is a focusable figure named by its `title` and described by a
summary of what it shows (`description` first, if given), which assistive
technology reads once. Focused, the arrow keys move a cursor through the
data and announce what it reaches, as the tooltip shows it. Left and Right
step through a series (Home, End, Page Up, and Page Down jump), and Up and
Down move to the next one: fields of one table drawn as lines, areas, or
bars are one stop, since each announcement names every series at the
cursor's x, while series of points and series at other places are stops of
their own; past the last stop of a panel, Up and Down move on to the next
panel. In heatmaps the arrow keys move cell by cell across rows and columns
as they are drawn, skipping empty cells, or to the nearest cell of the next
row or column when none is in line (Home and End go to a row's ends, Page
Up and Page Down to a column's); like the points of other marks, cells out
of a zoomed view are reached too, without panning to them. The description also says what color
scales and size and shape keys show. With a range navigator, it describes
the overview of the whole x range, the current range in x tooltip format,
and control of every panel's x in multi-panel charts. This text refreshes at
most once a second without live announcements on each pan; the
navigator's sliders announce where its window ends up politely.
Pies, trees, and other layout
marks step through their items; in facet panels and subplots, Left and
Right read a panel's items and Up and Down move between panels. Arriving in
a panel, the cursor names it and reads the annotations that panel alone
draws (its rows of annotations over a table, a subplot's own), which the
description lists after each panel's name. Legend entries are toggle buttons, and a
range navigator's window and edges are sliders (see Range navigator). What
a drag does, the keys do too, and a toolbar of named buttons (focusable,
shown while the pointer or focus is in the chart): Shift with the arrow keys
turns a 3D chart, pans a map or network, or moves a network's node, plus and minus
zoom, and 0 resets; Enter and Backspace drill into a tree and out, whose
path is a navigation landmark of buttons. The chart's description names
these keys, and each change is announced.

Tests check this in Chrome, Firefox, and WebKit: automated audits (axe-core)
of every chart family and of grids, and the accessibility tree each engine
gives screen readers, read through its own protocol. Screen readers
themselves have not been tried yet.

Static SVG includes the generated summary in its `desc`, with the supplied
`description` first. PDF exports are tagged with one Figure for the chart,
including facets and subplots. Its alternative text combines the title and
the same generated summary used in the DOM. Backgrounds and grid lines are artifacts; text
labels remain part of the figure. This does not claim PDF/UA conformance.

## Export

A mounted chart exports what it shows now, at its size, zoomed and with
series hidden as they are: `chart.toSVG()` a standalone SVG document,
`chart.toPNG({ scale })` a PNG `Blob` at `scale` times its size in CSS
pixels (2 by default; drawn from the SVG export, whose transparent
background stays transparent; its encoder loads the first time), and
`renderToPDF(chart)` from `herceg/pdf` a PDF, laid out as the page measured
its text:

```ts
import { renderToPDF } from "herceg/pdf";

const svg = chart.toSVG();
const png = await chart.toPNG({ scale: 2 }); // Blob, image/png
const pdf = renderToPDF(chart, { fonts }); // Uint8Array; fonts as below, optional
```

`renderToSVG` and `renderToPDF` take chart options too, and then need no
DOM, so they run on servers, in workers, and in build scripts:

```ts
import { renderToSVG } from "herceg";
import { renderToPDF } from "herceg/pdf";

const options = { width: 640, height: 320, marks: [line(metrics, { x: "time", y: "p99" })] };
const svg = renderToSVG(options); // standalone SVG document
const pdf = renderToPDF(options); // Uint8Array: a one-page vector PDF
```

`renderToPDF` accepts one mounted chart, static options, or a nonempty list.
`specToPDF` accepts one spec, a `{ spec, buffers }` entry, or a nonempty list:

```ts
import { renderToPDF } from "herceg/pdf";
import { specToPDF } from "herceg/spec";

const bytes = renderToPDF([chart, options, anotherChart], {
  pageSize: "A4", orientation: "landscape", margin: 36,
  title: "Performance report", subject: "Service performance", language: "en-GB", fonts,
}); // Uint8Array; one chart per page
const single = renderToPDF(chart, { pageSize: "A4" });
const fromSpecs = specToPDF([spec1, spec2], { pageSize: "Letter", title: "Report" });
const fromSpec = specToPDF(spec1, { pageSize: "A4" });
// Binary sidecars keep their indices local to each spec:
const fromBinary = specToPDF([
  { spec: spec1, buffers: buffers1 }, { spec: spec2, buffers: buffers2 },
], { fonts });
const oneBinary = specToPDF({ spec: spec1, buffers: buffers1 }, { fonts });
```

Mounted charts are read during export and keep their current size, zoom, and
hidden series. For several views and captions on one page, use subplots and
panel titles.

Without `pageSize`, each page uses its chart's size at 0.75 points per CSS
pixel; a supplied margin adds space around it. `"A4"` and `"Letter"` default
to portrait and a 36-point margin; `orientation: "landscape"` rotates the
paper dimensions. Margins are uniform PDF points (72 per inch), not chart
padding. Named paper sizes uniformly scale each chart up or down to fit and
center it inside the margins, clipping all content to the chart rectangle
while retaining the inner plot clips. Text remains selectable and marks
remain vectors. Orientation needs a named paper size. Fitting factors use
fixed-point decimals; factors that round to zero are refused with a correction
to reduce chart dimensions or margins.

Export settings `title` and `subject` set document metadata without replacing
visible chart titles. For one chart (including a one-item list), they default
to the chart's title and description, even with paper settings. Multi-chart
reports have no default title or subject. Document language defaults to the
single chart's locale, or `"en"` for multiple charts; `language` overrides it.
Each chart's visible content has a nested `/Span` with its locale's `/Lang`,
while the Figure alternative uses English when its generated summary needs
an override. Supply `fonts` once for the document: each used face has one
font object and a subset of the glyphs used across all pages. Without document
fonts, one shared `PdfFonts` object on chart options is inherited by every
page; conflicting objects are refused. Explicit document fonts take precedence.

The synchronous one-or-list exports share the page writer, fitting, and
orchestration code. Normal tree shaking retains list handling and paper sizing
in single-chart PDF bundles in this implementation.
They remain outside chart bundles that do not import PDF. The
`herceg-spec-pdf` size entry measures one buffered spec, and
`herceg-pdf-document` measures an actual report, beside the line PDF entries.

PDF export is a separate entry point, `herceg/pdf`. Import `pdfFonts` to
include the optional TrueType parser, subsetter, and embedded-font writer;
plain PDF exports bundle none of them. The `herceg-pdf` and
`herceg-pdf-fonts` size benchmarks include scene compilation and a line
mark, without and with embedded-font support respectively (about 46 and
53 KiB gzip, excluding supplied font bytes). The page is the chart's size
at 0.75 points per CSS pixel. Marks (contours included), axes, and legends are vectors, heatmaps and 2D histograms are compressed images,
and text is selectable. For a single chart, title and description default to document metadata.
Both font paths also emit one `Document` containing a `Figure` per chart, with each
chart's title and generated summary as `/Alt`, drawing linked through marked
content and a parent tree, and catalog `/Lang` from the document language.
The generated summary is English; the Figure has `/Lang (en)` unless it
inherits an English locale from the catalog.

Without `fonts`, text uses Helvetica, Times, or Courier (regular/bold),
with the existing Windows-1252 encoding; uncovered characters print as "?".
For Unicode, supply static TrueType fonts with families matching `theme.font`:

```ts
import { pdfFonts } from "herceg/pdf";
import { specToPDF } from "herceg/spec";

const fonts = pdfFonts(
  [
    { family: "Inter", data: regularBytes }, // Uint8Array; Node Buffer also works
    { family: "Inter", weight: "bold", data: boldBytes },
    { family: "Symbols", data: symbolBytes },
  ],
  { fallback: ["Symbols"] },
);
const pdf = renderToPDF({
  ...options,
  theme: { font: '"Inter", sans-serif' },
  fonts,
});
// Export settings are the second argument; sidecars travel in { spec, buffers } entries:
const fromSpec = specToPDF({ spec, buffers }, { fonts });
```

Both exporters take a prepared `PdfFonts` object, and reject a plain array
with guidance to wrap it in `pdfFonts(...)`. `fallback` and `missingGlyph`
belong to the second argument of `pdfFonts`, not the export options. The
prepared object can be reused: every export parses its own faces and owns
its glyph usage and subsets. Font descriptors and fallback lists are copied;
font byte buffers are borrowed read-only for the duration of each export.

The [Python package](../../python/README.md) accepts a family-to-path/bytes
`fonts=` mapping for SVG, PNG, and PDF. All three use this resolver for text
measurement. PNG loads the supplied faces into resvg; SVG references the
families and requires the viewer to provide their fonts.

`weight` is `"normal"` (default) or `"bold"`. A missing weight uses the other
registered face of that family, without synthetic bold. Families are matched
case-insensitively, including quoted CSS names and explicitly registered
generic names such as `sans-serif`. Coverage follows the CSS family list,
then `fallback`; each extended grapheme cluster stays in one face.
Simple combining accents use NFC precomposition when the face covers both the
source scalars and the composed glyph. Copy/search retains the original input.
Other combining sequences are refused because they need mark positioning.
Fonts are export options, never part of the portable spec, and are not loaded
from CSS, installed fonts, or URLs.

Embedded text uses Type0/CIDFontType2 fonts with Identity-H, explicit glyph
maps, and UTF-16BE ToUnicode maps for copy/search, including supplementary
characters. Subsets contain only drawn glyphs, `.notdef`, and composite
components; layout's unused candidates do not enlarge them. Layout and PDF
widths use identical advances (six decimal places in 1/1000 em), without
kerning or shaping. Hanging and middle anchors use the faces' cap heights.
OS/2 embedding restrictions are enforced; no-subsetting faces embed whole.
Fonts larger than 32 MiB and registries larger than 64 faces are refused.
Input font checksums are intentionally unchecked because real fonts often have
incorrect checksums; generated subsets receive fresh checksums.

- Missing embedded-font coverage throws an error naming the Unicode scalar.
  Add a covering fallback family or explicitly set `missingGlyph: "?"` in
  the options passed to `pdfFonts` (one covered standalone scalar, replacing
  each uncovered grapheme cluster).
- Embedded text admits Latin, Greek, Cyrillic, Armenian, Georgian, Han,
  hiragana, katakana, precomposed Hangul syllables, and selected Common/Inherited
  punctuation, digits, symbols, and composable accents. Shared characters must
  also pass Script_Extensions checks; see the exact ranges in
  [the architecture](https://github.com/op55-org/herceg/blob/main/docs/architecture.md). Other scripts, unassigned and
  private-use characters, controls, and default-ignorable characters throw an
  error naming the code point before fallback or replacement. Emoji modifier,
  flag, tag, and ZWJ sequences are refused before fallback or replacement.
  Joiners and variation sequences are also unsupported. Use SVG/PNG for these labels. CFF outlines, WOFF,
  font collections, and uninstantiated variable fonts are refused.
- Font fallback selects one face per extended grapheme cluster. `Intl.Segmenter`
  supplies the boundaries when available. Otherwise conservative grouping joins
  combining marks, Grapheme_Extend characters (including halfwidth kana voiced
  marks), emoji modifiers, and ZWJ continuations; unsupported clusters are still
  refused. Halfwidth kana marks retain separate glyphs and extraction scalars;
  simple accents use NFC composition without losing their original sequence.
- The layout measurer returns width only: unusually tall fallback faces may
  need extra margins or smaller text. Label shortening uses code-point cuts
  and may split grapheme clusters; no grapheme-aware shortening yet.
- Colors must be hex, `rgb()`, `hsl()`, or CSS color names. Pages are white
  paper: a transparent theme with light text gets a dark surface.
- Optional shipped fonts remain open work. Tagged PDFs provide a chart
  alternative, without separate text-label semantics or PDF/UA conformance.

## Charts from specs

Charts described as JSON, such as those the Python package writes, load
through the `herceg/spec` entry point:

```ts
import { chartFromSpec, specToPDF, specToSVG } from "herceg/spec";

chartFromSpec(element, spec, buffers); // buffers: ArrayBuffers for binary columns
const svg = specToSVG(spec, buffers);
const pdf = specToPDF({ spec, buffers });
```

A spec's `data` holds tables whose columns are JSON arrays,
`{ type: "time", values }`, binary columns (`{ type: "number" | "time",
dtype: "float64" | "float32" | "int32" | ..., buffer: <index> }`),
dictionary-encoded categories (`{ type: "category", codes, dictionary }`), or
geometries (`{ type: "geometry", coordinates, ringOffsets, polygonOffsets,
geometryOffsets, codes? }`: float64 longitude, latitude pairs and int32
offsets, each a buffer index or a JSON array, and int32 codes per row,
row i holding geometry i without them). A table with `"matrix": { "x":
"lon", "y": "lat" }` is a matrix (`fromMatrix`): the columns it names hold
the coordinates, and the others a value at each pair, so a grid's
coordinates travel once each.
Marks are the same objects as a TypeScript mark's `spec`, with `data` naming
their table. A mark's `spec` is frozen, readonly all the way down: to change
a mark, build a new one and pass it to `chart.update({ marks })`.

A spec's `rowSelection` is a binding or a list of them as `rowSelection()`
takes them, with `data` naming the table instead of a store (it may be left
out when the marks read one table): `{ "data": "trips", "channel": "focus",
"events": ["brush", "click"] }`. Stores are not part of a spec: `loadSpec`
makes one per bound table, returned in `stores`, or takes them in its
options, `loadSpec(spec, buffers, { tables, stores })`, with tables to use
instead of making them from the spec's columns, so that charts of several
specs share rows and selections; `chartFromSpec` takes the same options.

Specs say which format `version` they are: 1 (`SPEC_VERSION`), the only one
so far, also when left out. Loading refuses specs of later versions. Loading
checks a spec, and errors name the property at fault, what was expected, and
what was received, as in `marks[2].inner: expected "box", "quartiles", or
"none"; received "quart"`. Properties the format does not have, such as
misspellings, are refused, naming the property most likely meant
(`marks[0].strokeWidht: not a property of herceg's spec format; did you mean
"strokeWidth"?`); `loadSpec(spec, buffers, { unknown: "warn" })` logs them
with `console.warn` and loads the rest instead, and `{ unknown: "ignore" }`
loads the rest quietly. `validateSpec(value)` checks a value of unknown type,
such as parsed JSON, refusing what loading refuses, and narrows it to
`ChartSpec`; a loaded spec's `unknown` lists the properties it did not know:

```ts
import { createChart } from "herceg";
import { loadSpec, validateSpec } from "herceg/spec";

const spec: unknown = await response.json();
validateSpec(spec);
const { config } = loadSpec(spec);
createChart(element, config);
```

## Large data

Every point is drawn by default. In the browser, point series of 100,000
points or more are drawn with WebGL2, loaded on demand the first time a chart
needs it; `chart.loading` settles once they are on screen (points on a time
axis with breaks are placed on the CPU). So are standalone 3D charts of 20,000 points,
10,000 surface cells, or 20,000 line segments (see 3D charts). With
`sampling: "pixel"`, opaque points
whose centers land on the same device pixel are drawn once (above 4,096
points per series), which is faster for dense scatter plots but can drop
subpixel edge coverage. Tooltips find the nearest point through a spatial
grid index. Heatmaps and 2D histograms are drawn as one image of at most
the plot's device pixels, whatever their number of cells. Contours of large
grids are traced once and projected again as the view moves (see
Contours).

Lines and areas over sorted x are reduced before drawing (M4): within each
device-pixel column, only the first, lowest, highest, and last points of an
unbroken run are kept, so a million-point series draws as a few thousand
points while keeping every column's extremes. Missing values split a line into
separately reduced runs, so data with very many gaps reduces less; dash
patterns can shift slightly because intermediate points are removed. On a
time axis with breaks, columns are columns of time shown, and points inside
breaks are left out without splitting the run.
`renderer: "auto"` moves charts with many drawn points to Canvas. See
`docs/architecture.md` in the repository for details.

Input-order ordinary, fill, and centered stacks follow streaming tables:
appended rows and rows a rolling window drops restack only what they touch
(the rows themselves for fields, the
positions they are at for bars of a series field, and for areas of a series
field the x positions from the earliest one they change), instead of every
row. Areas of a series field have an edge for every layer at every x any
shown layer has, 16 bytes a layer and x (plus 16 bytes a row for each row's
top and bottom), so series with few x positions in common cost more than
their rows.

## Grids

`herceg/grid` shows the rows of a row view in a grid. Rows and columns
are virtualized: a grid of a million rows mounts only what is in view, and
each cell's text is formatted as it is drawn.

```ts
import { rowView } from "herceg";
import { createGrid, createGridModel } from "herceg/grid";

const model = createGridModel({
  data: rowView(requests),
  columns: [
    { field: "time", format: { timeStyle: "medium" } },
    { field: "service", title: "Service" },
    { field: "latency", title: "Latency (ms)", format: { maximumFractionDigits: 1 } },
  ],
  timeZone: "UTC",
});
const grid = createGrid(document.querySelector("#requests")!, {
  model,
  ariaLabel: "Requests",
});
```

The model holds what the grid shows apart from the rows themselves, which
the view chooses and orders: the columns, where the grid is scrolled, the
focused cell, and the selected rows. It has no DOM, and is also its own entry
point, `herceg/grid/model`. Columns take Intl format options for their
field's kind (none for categories) and a width (120 pixels by default, 32
at least); numbers align to the end. `model.setColumns` replaces them, and
`model.columns` gives them back. Missing values show as `missing` (empty by
default). One model serves one grid: grids of the same rows share the view
and the selection store.

Clicking a column's header sorts by its field, ascending, then descending,
then not at all; with Shift, the column's field is added to the other keys
instead of replacing them. Sorting goes through the view, keeping its filter
(`model.setSort(keys)` does the same). Clicking a row selects it, Ctrl or
Cmd toggles it, and Shift selects the rows from the last one clicked, in the
grid's order. The selection is a row set in the model's selection store,
under the channel "grid-rows" (the `selectionStore` and `channel` options), where
an application can read it, for example to restrict a chart's view to the
selected rows; a condition put in that channel shows as selected rows too.

The grid follows its table and view. Rows appended below the ones in view
cost nothing to draw; when rows drop out of a rolling window, or sorted rows
arrive above the top row, the rows in view stay where they were; and the
focused cell keeps to its row through sorting and streaming, or goes to the
row taking its place when its own leaves. The model, view, and table belong
to the application: `grid.destroy()` leaves them, and `model.dispose()`
stops the model following the view, as it does on its own once no one keeps
the model.

The grid is one tab stop. Arrow keys, Page Up and Page Down, Home and End
(a row's ends), and Ctrl+Home and Ctrl+End (the first and last cells) move
the focus through the header and the rows, scrolling the cell into view
first. Space toggles the focused row's selection, Shift with the arrow keys
selects the rows from the last one selected, Ctrl+A (Cmd+A) selects every
row, and Escape clears the selection; Enter or Space on a header sorts by it.
What sorting and selecting did is announced. Grids take the charts' themes
(`theme`); without a height of its own, a grid's container gets 320 pixels.

Columns are resized, moved, pinned to an edge, and hidden by the model's
commands, which name them by id, and from the grid's headers:

```ts
model.resizeColumn("latency", 160); // no narrower than MIN_COLUMN_WIDTH, 32 pixels
model.moveColumn("service", "time"); // before "time"; null puts it last
model.pinColumn("time", "left"); // or "right"; null unpins it
model.setColumnVisible("service", false);
```

Dragging a header's edge resizes its column (the right edge, or the left
one of a column pinned right), and dragging the header moves the column
among those pinned to the same side (or among the unpinned ones), dropped
where a line shows; Escape puts it back, and a drag never sorts. On a
focused header, Shift with Left or Right Arrow moves its column, Alt with
Left or Right Arrow resizes it by 16 pixels, and Alt and Down Arrow (or
Shift+F10, a right click, or the button on a hovered header) opens the
column's menu: move, resize, pin, unpin, or hide it, and a check for every
column, hidden ones too, to show or hide it. What each change did is
announced, and the focus stays on the column's header. A resize drag
changes the model once a frame as it goes, so the model's listeners hear
those widths too, and Escape puts the width back. `model.columns` holds the
layout the commands left (order, widths, pins, hidden columns), which
`setColumns` takes back, so an application can keep a user's layout:

```ts
localStorage.layout = JSON.stringify(model.columns);
model.setColumns(JSON.parse(localStorage.layout));
```

Pinned columns show first (pinned left) or last (pinned right), each side
in the columns' order, and stay in place as the others scroll under them;
unpinned, a column goes back to its place among the others. Each row is
still one row of cells in the order they show, as screen readers read it.
Pinned columns must leave the others at least 120 pixels
(`MIN_SCROLLING_WIDTH`): `pinColumn` refuses a column the grid has no room
to hold (`model.canPin(id)` says whether it has, and the menu offers no
other pin), and a held pinned column widens only as far as that allows.
`setColumns` takes pins as given, to restore a layout on any screen; in a
grid too narrow for them, pinned columns scroll with the others, in the same
order, until it is wide enough again.

A grid and a chart linked both ways share one table: the grid's selected
rows restrict what the chart shows, and the chart's brush filters the grid.
Each reads the table through a view of its own, so neither copies columns.

```ts
import { col, createChart, point, rowView, selectionStore } from "herceg";
import { createGrid, createGridModel } from "herceg/grid";

const store = selectionStore(requests);
const gridRows = rowView(requests);
const chartRows = rowView(requests);
const grid = createGrid(gridElement, {
  model: createGridModel({ data: gridRows, columns, selectionStore: store }),
  ariaLabel: "Requests",
});
const chart = createChart(chartElement, {
  marks: [point(chartRows, { x: "time", y: "latency" })],
  interaction: { brush: "x" },
});

// Selected rows show in the chart; with none selected, it shows them all.
store.subscribe(() => {
  const picked = store.get("grid-rows");
  chartRows.restrict(picked?.kind === "rows" ? picked.rows : null);
});
// A brushed range filters the grid; clearing the brush shows every row.
chart.on("select", ({ x }) =>
  gridRows.setQuery({
    ...gridRows.query,
    filter: x ? col("time").ge(x[0]).and(col("time").le(x[1])) : true,
  }),
);
```

How they link is the application's choice; nothing filters automatically.
Rows that a filter takes out of the grid stay selected, so the chart keeps
showing them.

A grid shows its view's rows in groups (see Row groups) given as `groups`:
a header row per group, followed when it is expanded by its groups of the
level below, or, on the last level, by its rows.

```ts
import { bar, count, groupRows, mean, rowView } from "herceg";

const view = rowView(requests);
const traffic = groupRows(view, {
  by: ["region", "service"],
  ops: { n: count(), latency: mean("latency") },
});
const model = createGridModel({
  data: view,
  groups: traffic,
  columns: [
    { field: "service" },
    { field: "region" },
    { field: "time" },
    { field: "latency", aggregate: "latency", format: { maximumFractionDigits: 1 } },
  ],
});
bar(traffic.tableOf("region"), { x: "region", y: "latency" }); // the same groups, charted
```

A header's first cell names its group by its own key value and counts its
rows ("api (1,204)"), indented by level; a column of a grouping field shows
the key's value on that field's level and below, and a column with an
`aggregate` the group's value of it at its level, in the column's format
when the aggregate is a sum, mean, minimum, or maximum of the column's own
field. Groups start collapsed: `model.setExpanded(key, true)` expands the
group with that key path (`["eu"]`, `["eu", "api"]`), and `expandAll()` and
`collapseAll()` change every level; expansion is kept by key, so groups keep
it as rows stream, through resets, and while a group above them is
collapsed (`model.setGroups` shows other groups, or none). `model.row(i)`
tells a group's header (`kind: "group"`, with its key, level, row count, and
expansion) from a table row (`kind: "row"`). Each row also says when what it shows
last changed (`version`) and names itself (`ref`, which `model.indexOf(ref)`
finds again). Clicking a column's header
sorts each group's rows by its field and the groups among their siblings by
the column's aggregate at every level, or by key on the level of a grouping
field; `model.setGroupSort` orders groups by any field of the groups'
tables (each level by the keys its table has), and without it they keep the
order they appeared in.

Selecting a group's header selects every row of the group that the view
shows, in its groups below too, collapsed or not, into the grid's row set;
its checkbox is checked when all of them are selected and mixed when some
are (`model.selectionState(i)`), and Shift ranges take whole groups whose
headers they cover. Rows appended to a group later are not selected. When a
group collapses around the focused cell, the focus goes to its header.
Grouped grids are WAI tree grids: rows say their level, their place among
their siblings, and whether they are expanded (except in Firefox, which drops
levels and places of rows in grids that number their rows, as these must). Since the focus is always on
a cell, a row's first cell stands for the row, as the pattern's focused rows
do: there Right expands a group, Left collapses it, and Left on a collapsed
group or a group's row goes to the group holding it (elsewhere the arrows
move between cells); Enter on any cell of a header expands or collapses it,
and Space selects its rows.

A pivot (see Row pivots) shows in a grid from `herceg/grid/pivot`, which a
grid that shows none never loads: a row per row of the pivot, and columns
for the rows field, for each value and aggregate, and for the totals.

```ts
import { createPivotGrid, createPivotGridModel } from "herceg/grid/pivot";

const model = createPivotGridModel({
  data: traffic,
  rowColumn: { title: "Region", width: 100 },
  aggregates: { latency: { title: "Latency (ms)", format: { maximumFractionDigits: 1 } } },
});
const grid = createPivotGrid(element, { model, ariaLabel: "Requests by region and service" });
model.pinColumn("region", "left");
```

With several aggregates, a header row of the pivot's values goes over their
aggregates' headers, each value spanning its columns, and repeated where
moving or pinning parts them; with one, each value heads its column. Absent
combinations are blank, and missing values show as `missing`; a row whose
key is missing reads "(missing)". The model is a grid model (`GridModel`)
without groups or table rows of its own: generated columns are named by
their ids in its commands (resizing, moving, pinning, hiding, focusing, and
sorting), and `model.columns` lists them with full titles ("api, Latency
(ms)"), which their headers carry as their accessible names. Layout and
focus stay with ids: a value that streams in later gets columns of its own
in column order, taking no other column's width, pin, or focus, and the
columns in view do not move (after the user moved columns, new ones go just
before the next column in column order, or last); layout that `setColumns`
gives for columns not generated yet waits for them. Clicking a header sorts
the rows by its column, absent and missing values last either way, without
touching the view's order: sort keys name the rows field or generated ids.
Selecting a row selects its rows of the view into the selection store, so
a chart restricted to them shows them; its checkbox is mixed once more of
its rows arrive. A pivot that stopped at a limit says so in a notice under
the grid, which keeps showing what it held, and its rows select nothing
more.

Rows have one height (`rowHeight`, 28 pixels by default) and columns explicit
widths. Rows taller together than 8 million pixels scroll scaled: the
scrollbar covers them all, and a pixel scrolled moves more than one. Not yet
available: column groups (headers over several columns) other than a
pivot's values, sizing columns to their content, moving columns by touch
(the menu moves them), custom cell content, editing, and copying.

### Remote grids

`herceg/grid/remote` shows rows that live elsewhere: in a database behind an
API, or in a table served from a worker. The page holds only the rows in
view and a few around them, and the filter, sorts, and groups run where the
data is. The grid draws, scrolls, focuses, and lays out columns as a local
grid does, from the same model code.

```ts
import { createRemoteGrid, createRemoteGridModel } from "herceg/grid/remote";

const model = createRemoteGridModel({
  source, // where the rows are: see below
  query: {
    filter: ["==", ["field", "status"], "error"],
    sort: [{ field: "time", order: "descending" }],
  },
  columns: [
    { field: "time", format: { timeStyle: "medium" } },
    { field: "service" },
    { field: "latency", format: { maximumFractionDigits: 1 } },
  ],
});
createRemoteGrid(element, { model, ariaLabel: "Failed requests" });
```

The query is plain JSON (`GridQuery`) that a server can run: a version (1),
the source's name, a filter (a portable expression, as `col(...)` builds),
sort keys, and optionally groups with aggregates. It holds nothing of the
grid's layout (widths, order, pins) or of what the user does (expansion,
focus, selection, the rows asked for), which stay in the model.
`validateGridQuery(query, schema)` checks one against a source's fields
and refuses unknown properties, so a server never ignores what it does not
understand. Its meaning is the local grid's: rows sort with missing values
last in both directions, labels by UTF-16 code units, and ties by the
source's key; aggregates (`count`, `sum`, `mean`, `min`, `max`) read finite
values; a filter that is missing (NaN) keeps no row. Times are epoch
milliseconds whatever zone the grid shows them in; a query cannot bin them,
so a local day is a field of the data (see the conformance fixtures).
`model.setQuery(query)` shows another query, and clicking a header sorts
through it, one request for the rows and groups together.

A source (`GridSource`) has the fields of its rows (`schema`: their kinds,
and the key field, unique and unchanging, if there is one) and answers
`rows(request, signal)`: `limit` rows (or groups) from `offset` under a
parent group's key path, as typed columns (numbers and times in
`Float64Array`s, NaN missing; categories as codes into the window's own
dictionary), with how many there are, or `null` until the last window. The
first request of a query has `snapshot: null`; the answer names a snapshot
(a new one for every such request) the later requests ask for, so rows do
not shift between windows while data changes, and the grid calls `release`
once for each snapshot it stops reading; a source that cannot keep one
rejects with a `GridSourceError` coded `"snapshot-expired"`. Requests carry the query's revision, and the
grid drops answers to revisions, windows, or groups it no longer shows, and
aborts their requests through `signal`. A source that can also `locate` a
record by key in a snapshot lets the focus follow its row to a new query.
A source over HTTP:

```ts
import { type GridSource, GridSourceError, type WindowColumn } from "herceg/grid/remote";

// The server sends columns as JSON arrays, null for missing values.
type Values = readonly (number | string | null)[];
const numbers = (values: Values) => Float64Array.from(values, (v) => (v === null ? Number.NaN : +v));
function labels(values: Values): WindowColumn {
  const dictionary = [...new Set(values.filter((v) => v !== null).map(String))];
  return { codes: Int32Array.from(values, (v) => (v === null ? -1 : dictionary.indexOf(String(v)))), dictionary };
}

const source: GridSource = {
  schema: {
    source: "requests",
    version: "3",
    fields: { id: "number", time: "time", service: "category", latency: "number" },
    key: "id",
  },
  async rows(request, signal) {
    const response = await fetch("/api/rows", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
    const body = await response.json();
    if (!response.ok) throw new GridSourceError(body.code ?? "unavailable", body.message);
    const kinds = this.schema.fields as Record<string, string>;
    const columns = Object.fromEntries(
      Object.entries(body.columns as Record<string, Values>).map(([field, values]) => [
        field,
        kinds[field] === "category" ? labels(values) : numbers(values),
      ]),
    );
    if (body.kind === "rows") return { ...body, columns };
    return { ...body, columns, rowCounts: numbers(body.rowCounts), childCounts: numbers(body.childCounts) };
  },
};
```

(Binary formats such as Arrow avoid the JSON arrays.) `herceg/grid/memory` has a source over a
Herceg table, `memorySource(table, { key: "id", latency: 20 })`, that answers
as a server would (it runs queries with the local grid's row views and
groups): for tests, for trying a remote grid, and for serving a table from a
worker. `herceg/grid/conformance` holds fixtures a server must answer alike
(missing values and NaN, string order, times and zones, group and leaf
sorts, pagination within a snapshot) as JSON, and `checkGridSource(driver)`
runs them against a server where a test installs the fixtures' rows.

Rows not loaded yet are placeholders ("Loading…", marked `aria-busy`, and
the grid itself while its query's first rows load); those that failed say
so, the live region announces the failure, and a notice under the rows
offers to try again (`model.retry()`; after an expired snapshot, it refreshes:
`model.refresh()` reads the query again), or says the source refused the
query when trying again cannot help. The model asks for the rows in
view in blocks of 128 (`blockSize`), and a block ahead of them in the
direction of scrolling, two
requests at a time (`maxRequests`); it keeps 16 blocks (`cachedBlocks`, and
at most `cacheBytes`, 8 MiB) besides those of the rows in view or mounted around them, dropping those
farthest from the view, and aborts requests more than two blocks away. A
scrollbar dragged far waits 50 ms for the scrolling to settle before asking
(`settleDelay`), and asks at least every 150 ms while it goes on. Until the source
says how many rows there are, the grid shows as many as it has read and a
block more, and grows as it scrolls. `model.status` says what is loading,
what failed, and how many blocks and bytes it holds.

The focus keeps to its row within a query. A new query puts it on its
column's header, and back on its record (by key) once the source locates it
there. Selections are keys or conditions, never positions, and live in a
`RemoteSelectionStore` (`remoteSelectionStore(schema)`, the `selectionStore`
option): clicking selects records by key, Shift ranges select the rows
between when all are loaded (and refuse, saying so, otherwise), Ctrl+A
selects every row matching the query's filter as a condition, toggling rows
takes them out or adds them by key, and selecting a group's header selects
the rows matching the group in place of the selection (`{ kind: "matching",
where, include, except }`; toggling it again clears it).
`selectionCondition(selection, key)` turns a selection into a filter a
server can run, and `model.selectedCount` is null for a condition, which
only the source can count. Selections stay through new queries.

Grouped queries show groups as a local grid does, each group's rows or groups
below asked for when it is expanded (`setExpanded(key, true)`, kept for
groups not loaded yet, and across sorts while the grouping fields stay); a
header reads its group's row count and aggregates from the source, a
column's `aggregate` naming one of the query's (`as`). Up to 256
groups expand at once (`maxExpanded`, counting those expanded before they
load); there is no `expandAll`. A group's checkbox says what the grid
knows: checked when the group (or one holding it, or every row) was
selected as a group, mixed when a group within it was or when some of its
records loaded are selected (or taken out of it), and checked too when all
of its records are loaded and selected; records not loaded are not guessed
at.
Not yet available remotely: pivots, editing, and bins in queries.
