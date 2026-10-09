# herceg

Framework-independent charts for analytics: columnar data, streaming updates,
level-of-detail rendering, SVG and Canvas output, SVG and PDF export.

> Early development. Line, area, bar, point (scatter), and heatmap marks, and
> rule, region, and text annotations are available; the API may change before
> 1.0.

## Quick start

```ts
import { createChart, line, rule, table, time } from "herceg";

const metrics = table({
  time: time(timestamps), // Float64Array of epoch ms, or Date[]
  p50: p50Latency, // Float64Array or number[]
  p99: p99Latency,
});

const chart = createChart(document.querySelector("#latency")!, {
  title: "Request latency",
  marks: [line(metrics, { x: "time", y: ["p50", "p99"] }), rule({ y: 250, label: "SLO" })],
  y: { label: "ms" },
});
```

Field names are checked against the table at compile time: `y` only accepts
numeric or time fields, `series` only accepts category fields. A continuous
axis is a time axis when any field a mark places on it holds times, whether
the mark is a line, area, point, error bar, or candlestick; bar lengths and
histogram counts stay numbers, and heatmaps give every value of a position
its own band. Set `type: "linear"` on the axis to read times as plain numbers.

## Data

`table()` builds columnar data. Typed arrays are used without copying; plain
arrays, `Date` arrays, and string arrays are converted once.

```ts
const requests = table({
  time: time(timestamps),
  latency: latencies,
  service: serviceNames, // string[]: a category field
});
requests.numbers("latency"); // Float64Array view of the live rows
requests.categories("service"); // { codes: Int32Array, dictionary: string[] }
```

Row objects can be converted with `fromRows(rows)`. Categories that are
already dictionary-encoded (Arrow dictionaries, pandas categoricals) are used
without decoding: `encodedCategory(codes, dictionary)` takes `Int32Array`
codes (-1 for missing) and the dictionary. Shapes for maps are geometry
fields, from `fromGeoJSON(collection)` or `geometry(set, codes?)` (see Maps);
`table.geometries(field)` gives each row's code and the shapes.

Tables are mutable and charts that read them re-render on the next animation
frame, once per frame however many changes arrive:

```ts
const live = table({ time: time([]), cpu: [] as number[] }, { maxRows: 3_000 });
live.append({ time: [Date.now()], cpu: [0.42] }); // keeps the newest 3,000 rows
live.appendRow({ time: Date.now(), cpu: 0.4 });
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
  .bin("time", { step: 3_600_000, as: "hour" })
  .aggregate({ groupby: ["hour", "site"], ops: { mean: mean("f"), n: count() } })
  .table();
line(hourly, { x: "hour", y: "mean", series: "site" });

derive(prices).rolling({ size: 20, ops: { ma: { op: "mean", field: "close" } } }).table();
```

The result is an ordinary table that follows its source. Appends to the
source go through filters, calculations, and fixed-step bins on their own,
and rows dropped from the source (a rolling window) drop the rows they gave;
other changes, and pipelines with aggregates, rolling windows, sorting, or
bins without a step, recompute the table. A derived table keeps its source
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
Rolling windows are trailing windows of rows (within `groupby` groups),
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
read which channels.

Point marks take a view where they take a table, `point(view, { x, y })`,
and draw only its rows, read from the table's columns, redrawing as the
view changes; a grid and a chart filtered by the same store share one copy
of the data. Points of a view are drawn on the CPU (not the WebGL painter),
size and color scales span the whole table, facets repeat them in every
panel (`facet: "repeat"`) rather than splitting them, and views have no
place in portable specs yet; other marks take tables only.

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

```

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

Annotations take constant positions (numbers, or `Date`s on time axes), or
draw one item per row of a table when a position is a field. `label` is
constant text; `text` names a category or number field with each item's text.

```ts
rule({ y: 250, label: "SLO" }); // horizontal reference line
rule(deploys, { x: "time", text: "version" }); // a vertical rule per deploy

region({ x1: start, x2: end, label: "Maintenance" }); // shaded x range
region(incidents, { x1: "start", x2: "end", text: "title" });
region({ y1: 200, y2: 300 }); // shaded y range; with x1/x2 too, a rectangle

text({ x: launch, y: 120, label: "Launch", anchor: "start", dx: 6 });
text(peaks, { x: "time", y: "value", text: "value", dy: -10 });
text(cities, { x: "gdp", y: "growth", text: "name", dy: -10, overlap: "move" });
```

Annotation positions count toward the axis domains, so thresholds and events
stay in view; on a category axis, a constant position is a band index (0 is
the first band, -0.5 its edge). Regions are drawn in mark order (list them first to shade
underneath the data); rules and text are drawn above the data, as SVG even
when the data is on a canvas, and with a halo so text stays readable over
lines. Annotations outside the view are left out. Text labels that would
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
few hundred points, not every point of a large series.

Bars, points, error bars, heatmaps, candlesticks, histograms, box plots, and violins:

```ts
const sales = table({ region: regions, q1: q1Sales, q2: q2Sales });
bar(sales, { x: "region", y: ["q1", "q2"] }); // grouped; stack: true stacks them
bar(sales, { x: "q1", y: "region" }); // a category y gives horizontal bars
bar(requests, { x: "time", y: "latency" }); // number or time x: bars centered on values
bar(sales, { x: "region", y: "q1", labels: true }); // values at bar ends; Intl options format them

point(cars, { x: "weight", y: "mpg", series: "origin", r: 3 });
point(countries, { x: "gdp", y: "life", r: "population", series: "continent" }); // bubbles
point(stations, { x: "lon", y: "lat", color: "temperature", colors: viridis });
point(cars, { x: "weight", y: "mpg", symbol: "origin" }); // a shape per origin
point(requests, { x: "region", y: "latency" }); // a category x places points in its bands
errorBar(stats, { x: "group", y1: "low", y2: "high" }); // y, x1, x2 for horizontal ones
errorBar(stats, { x: "group", y: "mean", yError: "se" }); // mean ± se

const load = table({ hour: time(hours), host: hostNames, cpu: cpuValues });
heatmap(load, { x: "hour", y: "host", value: "cpu" });
heatmap(spectrum, { x: "time", y: "frequency", value: "power", reduce: "max" }); // grids larger than the plot

candlestick(prices, { x: "day", open: "open", high: "high", low: "low", close: "close" });
candlestick(prices, { x: "day", open: "open", high: "high", low: "low", close: "close", variant: "ohlc" });

histogram(requests, { x: "latency" }); // counts in round bins
histogram(requests, { x: "latency", series: "region", bins: { step: 10 }, normalize: "percent" });

boxplot(requests, { x: "region", y: "latency", series: "version" });
boxplot(requests, { x: "latency", y: "region" }); // a category y lays boxes along y
violin(requests, { x: "region", y: "latency" }); // kernel densities, quartiles inside
// `fill` gives every box or violin one color; `fillOpacity` is 0.25 by default.
```

Bar labels go past each bar's end, or for stacks inside each segment in a
color that contrasts with it; labels that do not fit are left out. A category
field on `x` or `y` (bars, points) or on `x` and `y` (heatmaps, points) gives a
band axis. Categories on a y axis run top to bottom; long names are shortened
with an ellipsis. Points on a category axis sit at the centers of its bands
(strip and dot plots, over bars too), and are drawn on the CPU however many
there are; on a category y axis, a point's tooltip shows its category and
its reported `value` is the category's band index. Horizontal bars default
to "nearest-y" tooltips, which report every series in the band under the
pointer. Heatmaps also accept number and time fields, with one column or row
per distinct value, and show a color legend instead of series entries.

A heatmap draws one pixel per cell while its grid fits the plot's device
pixels. A grid with more columns (or rows) than that, such as 4,000 x 4,000
cells on a plot 1,500 device pixels wide, is drawn at the plot's resolution
instead: each pixel shows the block of cells whose left (or top) edges fall
in it, colored by the mean of their values, or with `reduce: "max"` or
`"min"`, by the greatest or least, which keeps single hot cells visible.
Missing and NaN values are left out of a block, a block without values is
transparent, and rows that repeat a cell each count, where a cell drawn at
full resolution shows its last row. Tooltips still report the single cell
under the pointer, or nothing when that cell has no value. Static SVG and
PDF output, which are zoomed and printed, reduce only past two pixels per
CSS pixel. Drawing costs one pass over the table's rows, and memory follows
the rows and the plot's pixels, not the number of cells, so there is no cell
limit.

Points encode fields as well as positions. `r` names a number field to size
points by area, from zero (or the least value, when values are negative) at
`rRange[0]` pixels to the largest at `rRange[1]` (default [2, 12]), with a key
of round values below the legend. `fillOpacity` names a field mapped from
0.15 to opaque. `color` names a number field colored on a continuous scale,
with a color legend; series then appear in the legend in a neutral color.
Marks with the same color scale, or the same key of sizes or shapes, share
one legend.
`symbol` is one shape (`"circle"`, `"square"`, `"triangle"`, `"diamond"`,
`"cross"`, `"star"`, `"wye"`, `"triangle-down"`) or a category field whose
values take the shapes in that order, with a key unless the field also splits
series; a field named like a shape is refused rather than guessed at, so
rename it to encode it. Every shape covers the area of a circle of the same radius. Points
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

Histograms count values in bins shared by all their series. Bin edges are
round numbers (multiples of 1, 2, or 5 times a power of ten) or, for times,
calendar intervals in the chart's time zone; by default there are about
log2(n) + 1 of them for n values, at most 1,000. `bins` takes an approximate
count, or `{ step, start }` for fixed widths (milliseconds for times); values
below an explicit `start` are left out, as with Plotly's `xbins.start`. Each
bin holds values from its left edge up to its right one, the last also its
right edge. Several series overlay translucently, or stack with `stack: true`.
`normalize: "percent"` measures percent of each series' counted values
(stacked percentages need not total 100), and `"density"` that share per unit
of x (per millisecond for times), so each series' bars cover an area of 1, like
Plotly's "probability density". Tooltips report a bin's range and its bar;
a bin is inspected through its center, so one zoomed so far that its center
is out of view has no tooltip. Split by facets, each panel counts its own
rows, in bins chosen from the rows of the panels sharing its x scale: one set
of bins for every panel when they share x, each panel's, row's, or column's
own with `resolve: { x }` (rows without a facet value are drawn nowhere and
widen no bins). Percent and density are over each panel's own counts of a
series, stacks stack within each panel, and a series with no rows in a panel
has no bars there. Bins are chosen again only when the table changes, never
on zoom.

Box plots summarize a number or time field per category of the other axis:
a box from the lower to the upper quartile (linear interpolation between
ranks, as NumPy and pandas compute them), a line at the median, whiskers to
the most extreme values within 1.5 interquartile ranges of the box (Tukey's
rule), and dots for the values beyond. `series` puts a box per value of a
category field side by side in each category, in its own color. Tooltips
report a box's median, quartiles, whiskers, count, and outliers. Missing and
non-finite values are left out. On a log axis, the parts of a box at zero or
below are not drawn. Statistics are recomputed for every box when the table
changes, so long streams of observations cost a full pass per frame. Split
by facets, each panel's boxes summarize its own rows, so a category in two
panels has two boxes from different values; every series keeps its slot in
every panel, and `facet: "repeat"` draws all rows' boxes in every panel.

Violins take the same fields and options as box plots and draw each group's
Gaussian kernel density instead, mirrored about the category's center: every
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

Marks are drawn in array order; rules and text always draw above other marks.

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
and its share of the slices shown. A pie has its chart to itself: it cannot
share one with other marks, have facets, or zoom, brush, or sync.

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
legend. Like a pie, a gauge or a funnel has its chart to itself.

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
pie, a radar has its chart to itself.

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
Like a pie, a Sankey diagram has its chart to itself.

### Networks

```ts
graph(friendships, { source: "a", target: "b" });
graph(messages, {
  source: "from",
  target: "to",
  value: "count", // link widths
  nodes: people, // a second table, with a row per node
  node: "name",
  group: "team", // colors and the legend
  size: "followers", // node areas
});
```

A network draws nodes joined by links from a table with a row per link.
Nodes are the names in `source` and `target`, and, with `nodes`, the names in
that table's `node` field, so nodes without links can be drawn too. Links
have no direction: rows either way between two nodes add to one link, as wide
as the sum of `value` over them (1 to 6 px), or 1 px without `value`. Rows
with a missing name, or with a missing, zero, negative, or infinite value,
are left out, and so are links from a node to itself (the chart's
description says how many).

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
background color so overlaps read. With `group`, nodes take their group's
color, links within a group take it too (others are gray), and the legend
toggles groups: hiding one leaves its nodes and their links out without
moving the rest. A later row of the nodes table for the same node replaces an
earlier one's group and size; nodes only links name have no group and are
gray. Names stand beside the most connected nodes (the largest, with `size`):
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

### Maps

```ts
import { createChart, fromGeoJSON, geopoint, geoshape, table } from "herceg";

const countries = fromGeoJSON(await (await fetch("countries.geojson")).json());
const cities = table({ city: [...], lon: [...], lat: [...], population: [...] });

createChart(element, {
  projection: "equal-earth",
  marks: [
    geoshape(countries, { name: "name", color: "gdp" }), // a choropleth
    geopoint(cities, { longitude: "lon", latitude: "lat", r: "population", name: "city" }),
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
`longitude` and `latitude` number fields, sized by area with an `r` field
(`rRange`, 2 to 16 px by default; a size key joins the legend), colored by a
`series` category or a `color` number field, at 0.8 opacity, each ringed in
the background color (`stroke`, `strokeWidth`), and largest first, across
series, so smaller points stay on top. Points missing a value they encode
are left out. `name` (a category field) names regions and points in
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

### 3D charts

```ts
import { createChart, line3d, point3d, surface, table } from "herceg";

createChart(element, {
  camera: { azimuth: -60, elevation: 25 },
  z: { label: "Yield" },
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
for heatmaps), with a color legend; `r` is the radius (3.5 px), `fill` and
`fillOpacity` the color without them, and `name` names points in tooltips.
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
sideways and leave vertical drags to scroll the page. `chart.camera` is the
current camera, `chart.setCamera({ ... })` changes the settings it is given
(null goes back to the configured camera), and a `camera` event reports
every move, once a frame at most. Updating the chart with a different
`camera` shows it; updating it with the same camera keeps the view the user
turned to.

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

Large 3D charts are drawn by the GPU in the browser, with one depth test for
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
  y: { label: "ms" },
  yRight: { label: "requests/s" },
});
```

Each axis fits its own marks, and tooltips format each value by its axis.
Grid lines follow the left axis (the right one when every mark is on the
right). Category values and marks placed along y (horizontal bars and error
bars) stay on the left; custom marks take `axis` too. Two scales in one plot invite comparisons between
heights that mean different things; for unrelated measures, two charts
sharing x through `interaction: { sync }` are often easier to read.

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
In a spec, `breaks` is the same list (spec version 3); `timeBreaks` brings
the code that resolves them, so charts without breaks do not bundle it.

Set `x.seams: true` to mark collapsed boundaries with dashed vertical lines,
one CSS pixel wide, behind the data and inside the plot. Use
`x.seams: { minSpacing: 40 }` to set the minimum distance in CSS pixels;
it must be finite and positive and defaults to 40. Seams are kept greedily
in chronological order, excluding plot edges, so markers become selective
when zoomed out. They follow each panel's shown domain; the navigator strip
draws none. Omission or `false` disables them. Enabled seams require time-axis
breaks and spec version 5. Seams use the theme's resolved `grid` color and
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
Labels go only on axes the chart draws: none for `axis: false`, and no y
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
pointer as data arrives, and lets go if something else changes the view.

The strip is 40 pixels tall by default (`height`, at least 16 and at most a
third of the height the plot and the strip share; a chart too short to
leave its plot 30 pixels beside the strip has none), under the x axis and
its title, across the
plot's width, with the strip's own ticks as grid lines and their labels
inside it. It draws the marks named in `marks` by `id`, or by default every
line, area, point, vertical bar, and candlestick mark (never annotations):
lines and areas reduced to a few points per pixel column, as the plot
reduces them, bars and candlesticks as the plot draws them, and points as a
sample of one per pixel of the strip, all in their series' colors over the
data's whole y range (or the y axis' `domain`). It follows the x axis'
breaks. Charts with facets or panels, layout marks (pies, maps, 3D
charts), category x axes, or marks placed along y (horizontal bars) cannot
have one yet.

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
window ends up is announced politely. Static SVG, PDF, and PNG show the
strip and the window, without the sliders. The strip's model code comes with
`rangeNavigator` (about 3.8 KiB gzip); the sliders load the first time a
chart has a navigator (about 2.9 KiB gzip). In a spec, `navigator` is
`true` or `{ height?, marks? }` (spec version 4).

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
  x: { label: "Week" },
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
  marks: [heatmap(load, { x: "hour", y: "host", value: "cpu" })],
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
they have `facet: "repeat"`; marks without a table repeat. Panels share
their x and y scales; `resolve: { y }` gives each panel a y scale of its own
fitting what it draws (`"independent"`), or one per row (`"rows"`) or per
column (`"columns"`), and `resolve: { x }` does the same for x. x labels go
under the lowest panel of each column, or under every panel when a column's
panels have different x scales, with the x title once under each scale's
lowest labels; y labels go
beside the first panel of each row, or beside every panel when a row's
panels differ. Specs with `resolve` need `"version": 2`, and with
`resolve.x` `"version": 3`, so that readers from before them refuse them
rather than draw shared axes. Charts whose panels have
y scales of their own cannot zoom along y or take y ranges in
`setViewport` yet. Pointer, brush, and zoom work in any panel and act on
its x scale; the arrow keys step through a panel and Up and Down move
between its series and on to the next panel. Stacked bars and areas stack within each
panel (areas of a series field on the x positions of that panel's rows), and each panel's heatmap cell shows the last of that panel's rows
with a value there; a heatmap's colors follow one scale in every panel,
over all its table's values. Histograms count, and box plots and violins
summarize, each panel's rows apart. Annotations over a table (which read it
whole, having no series) and custom marks over a table without series can
only repeat for now, and charts with facets have no right axis. A chart too small for its
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

A category axis of bars, heatmaps, points, box plots, or violins that panels
do not share holds only the categories of the rows its panels draw (for box
plots and violins, of the rows with a value), in the order the shared axis would have them
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
at its top left cell). Error bars and candlesticks on a category axis still
need it shared, and charts with categories of their own cannot be synced or
brushed along a y axis of categories.

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
      { id: "latency", title: "Latency", y: { label: "ms" } },
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
on its settings, title included, and a panel's `x: { axis }` shows or leaves
out its own labels. A time series over a time axis can then sit above a distribution
of its values:

```ts
createChart(element, {
  marks: [
    line(metrics, { x: "time", y: "latency", panel: "series" }),
    bar(buckets, { x: "ms", y: "count", panel: "spread" }),
  ],
  panels: panels([
    { id: "series", x: { label: "Time" }, y: { label: "ms" } },
    { id: "spread", x: { label: "Latency (ms)" } },
  ]),
  resolve: { x: "independent" }, // in a spec: "resolve": { "x": "independent" }
});
```

Marks keep their place in the chart's list as their identity, so colors,
the legend, and hidden series do not depend on the panel a mark draws in. Inspections report the `panel`
id. Specs with `panels` need `"version": 2`, and panels with their own `x`
`"version": 3`. Charts with panels have no right
axis, error bars and candlesticks on a category y axis need it shared
(`resolve: { y: "shared" }`), and zooming and brushing act on x only.

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
  draw({ series, x, y, line, circle }) {
    for (const s of series) {
      for (let k = 0; k < s.length; k++) {
        const row = s.rows ? s.rows[k]! : k;
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
`color`, `x` and `y` columns, `length`, and `rows` (undefined when it holds
every row; in a facet panel, that panel's rows). A `draw` that reads the
table directly instead draws hidden series and every panel's rows. The y
axis fits the series' values in view, and those of the points just past
its edges, so shapes between neighboring points stay in view; give the
chart `y: { zero: true }` for shapes drawn from zero.

Glyphs drawn from several fields of a row, such as ranges from `low` to
`high`, are not one series per field: give them `series: false`, and their
fields only count toward the domains, as do fields other than one `x` and
the `y` fields (both ends of horizontal spans, `x: ["start", "end"]`). Such
marks have no series, and in charts with facets need `facet: "repeat"`.
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
| `width`, `height` | Fixed size; omitted dimensions follow the container. |
| `x`, `y` | Scale and axis: `type` (`linear`, `log`, `time`), `domain`, `nice`, `zero`, `label`, `grid`, `ticks`, `format` (Intl options), `axis`; on a time x axis, `breaks: timeBreaks([...])` and `seams: true` or `{ minSpacing?: number }` (see Financial charts). |
| `yRight` | The right y axis for marks with `axis: "right"`, with the same options as `y`. |
| `facet` | `facet(field, { columns? })`: a panel per value of a category field, wrapped; or `facet({ row?, column? })`: a grid by two fields (see Small multiples). |
| `resolve` | `{ x?, y? }`, each `"shared" \| "independent" \| "rows" \| "columns"`: which panels share an x or y scale (see Small multiples and Subplots). |
| `panels` | `panels([{ id, title?, x?, y? }, ...], { columns?, rowHeights?, columnWidths? })`: subplots whose marks name them in `panel` (see Subplots). |
| `navigator` | `rangeNavigator({ height?, marks? })`: a strip under the plot over the whole x axis, whose window shows and moves the x range in view (see Range navigator). |
| `legend` | Shown by default for two or more series; legend entries toggle series. |
| `tooltip` | `true` (default), `false`, or `{ mode?: "nearest-x" \| "nearest-y" \| "nearest", axisLabels?: true }`; `axisLabels` labels the crosshair on the axes. |
| `interaction` | `zoom`: `true` or `"x"`, `"y"`, or `"xy"` for wheel zoom and drag pan along those axes (category axes do not zoom). `brush`: `"x"` or `"y"` to select a range by dragging, `"xy"` a rectangle, `"lasso"` a freehand region; along zoomed axes, a brush zooms instead (Shift-drag pans; lassos never zoom). `sync: "name"` shares cursor, x range, and selection with other charts; selections travel as data values (category indices on category axes), so charts sharing them should have the same axis types and category order. `rotate: false` stops dragging from turning 3D charts, whose `zoom` is `true` or `false`. |
| `animation` | `true` or `{ duration?, values? }`: the axes move gradually to views asked for, and with `values: true`, bars, pie slices, points, small lines and areas, and the axes with them, to changed values (see Animation). Off by default. |
| `renderer` | `"auto"` (default), `"svg"`, or `"canvas"`. |
| `theme` | A theme name or an object overriding a theme's tokens (see Themes). |
| `locale`, `timeZone` | Label locale and time zone (`"local"`, `"UTC"`, or an IANA name). |
| `projection` | How maps are projected: a projection's name or `{ type, centralMeridian?, parallels?, fit? }` (see Maps). |
| `z`, `camera`, `boxAspect` | 3D charts' vertical axis (options as for `x` and `y`), where they are seen from at first (`{ azimuth?, elevation?, zoom?, perspective? }`), and their box's side lengths (see 3D charts). |

The returned `Chart` has `root` (its element), `update(options)`,
`setViewport(view | [from, to] | null, { panel? })` and `getViewport({ panel?
})`, `select(selection | [from, to] | null, { panel? })` (a pair is shorthand
for an x range), `selection` and `selectionPanels` (see Small multiples for
`panel`), `camera` and `setCamera(camera | null)` (3D charts), `getPanels()`,
`toPixel`, `fromPixel`, `formatValue`, and `inspect` (see Panels and pixels),
`getLegend()`, `getHiddenKeys()`, `setHiddenKeys(keys)`, and
`setVisibility(keys, visible)` (see Hiding series), `on(event, listener)`,
`render()`, `toSVG()`, `destroy()`, and `loading` (a promise while the GPU
painter for large point series, the animation code, a 3D chart's buttons,
the brush, or a navigator's sliders load, otherwise undefined). The brush loads when a chart can brush
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
and `"high-contrast-dark"`. Light and dark have transparent backgrounds and
take the page's; the high-contrast themes paint white or black surfaces of
their own. `"auto"` is light or dark to match the surface the chart sits on:
the background colors around it (through translucent layers and shadow
roots), or, on a page without one, the user's `prefers-color-scheme` when the
page's `color-scheme` allows dark. It switches when that changes. A chart in a
frame judges the frame's own page; give it a theme or background when the page
around the frame is dark. The categorical palettes keep adjacent series
apart for the common forms of color blindness, and the high-contrast palettes
reach 4.5:1 against their surfaces.

An object overrides any of a theme's tokens, starting from `extends`:

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
PDF output reads hex, `rgb()`, `hsl()`, and named colors.

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
chart.on("camera", ({ camera }) => saveView(camera)); // a 3D chart turned
chart.on("visibility", ({ hiddenKeys }) => saveHidden(hiddenKeys)); // legend, setVisibility
chart.on("render", () => placeOverlay(chart.getPanels())); // a frame of the data was drawn
```

Events report changes only: a re-inspected point or an unchanged view does
not repeat them. A `viewport` event reports a change of several axes (an xy
wheel zoom, a brushed rectangle zoomed to) once, with every axis' range. An
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

## Panels and pixels

`getPanels()` describes the panels of the last frame drawn, in reading order:
each one's `key` and `label`, its `plot` (the area inside the axes), and its
`x`, `y`, and, with marks on the right axis, `yRight` axes. An axis has its
`type`, its `domain` (the values shown) and `range` (where they lie), and on
category axes its `categories` and `bandwidth`; panels whose axis has the same
`group` share its scale, and `canSetViewport` says whether `setViewport`
zooms it (not category axes, nor y axes of panels with y scales of their
own). A chart of a layout mark (a pie, a map, a 3D chart) has one panel,
without axes. Pixels are CSS pixels from the top left corner of
`chart.root`, whatever the device pixel ratio.

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
Up and Page Down to a column's). The description also says what color
scales and size and shape keys show. Pies, trees, and other layout
marks step through their items. Legend entries are toggle buttons, and a
range navigator's window and edges are sliders (see Range navigator).

## Export

`renderToSVG` and `renderToPDF` need no DOM, so they run on servers, in
workers, and in build scripts:

```ts
import { renderToSVG } from "herceg";
import { renderToPDF } from "herceg/pdf";

const options = { width: 640, height: 320, marks: [line(metrics, { x: "time", y: "p99" })] };
const svg = renderToSVG(options); // standalone SVG document
const pdf = renderToPDF(options); // Uint8Array: a one-page vector PDF
```

PDF export is a separate entry point, `herceg/pdf`, so applications that do
not export PDFs do not bundle it (about 11 KiB gzip). The page is the chart's
size at 0.75 points per CSS pixel, laid out as the static SVG. Marks, axes,
and legends are vector paths, heatmaps are compressed images, and text is
selectable text in the standard PDF fonts (Helvetica for sans-serif themes,
Times or Courier for serif or monospace ones), so no font is embedded. The
chart's title and description become the document's title and subject.

- The standard fonts cover Windows-1252 (Latin-1 and common punctuation);
  other characters, such as Greek, Cyrillic, or CJK, print as "?".
- Colors must be hex, `rgb()`, `hsl()`, or CSS color names; others, such as
  CSS variables, throw an error.
- A transparent background stays transparent, which PDF viewers show as
  white paper: give dark themes a background color.
- The document is not tagged for assistive technology.

## Charts from specs

Charts described as JSON, such as those the Python package writes, load
through the `herceg/spec` entry point:

```ts
import { chartFromSpec, specToPDF, specToSVG } from "herceg/spec";

chartFromSpec(element, spec, buffers); // buffers: ArrayBuffers for binary columns
const svg = specToSVG(spec, buffers);
const pdf = specToPDF(spec, buffers);
```

A spec's `data` holds tables whose columns are JSON arrays,
`{ type: "time", values }`, binary columns (`{ type: "number" | "time",
dtype: "float64" | "float32" | "int32" | ..., buffer: <index> }`),
dictionary-encoded categories (`{ type: "category", codes, dictionary }`), or
geometries (`{ type: "geometry", coordinates, ringOffsets, polygonOffsets,
geometryOffsets, codes? }`: float64 longitude, latitude pairs and int32
offsets, each a buffer index or a JSON array, and int32 codes per row,
row i holding geometry i without them).
Marks are the same objects as a TypeScript mark's `spec`, with `data` naming
their table. A mark's `spec` is frozen, readonly all the way down: to change
a mark, build a new one and pass it to `chart.update({ marks })`.

Specs say which format `version` they are; one without is version 1. Specs
using `resolve`, `panels`, or `grid` must say 2 or later, those using
`resolve.x`, a panel's own `x`, or the x axis' `breaks` 3 or later, and
those with a `navigator` 4 or later, and those with enabled x axis `seams` 5
(`SPEC_VERSION`, the version this herceg writes), so that older readers refuse
what they would draw differently. Loading checks a spec and names the property at
fault in errors. Properties herceg does not know, misspelled or from a newer
version, are logged with `console.warn` and otherwise ignored;
`loadSpec(spec, buffers, { unknown: "error" })` refuses them instead, and
`{ unknown: "ignore" }` loads quietly. `validateSpec(value)` checks a value
of unknown type, such as parsed JSON, and narrows it to `ChartSpec`:

```ts
import { createChart } from "herceg";
import { loadSpec, validateSpec } from "herceg/spec";

const spec: unknown = await response.json();
validateSpec(spec);
const { config } = loadSpec(spec, [], { unknown: "error" });
createChart(element, config);
```

## Large data

Every point is drawn by default. In the browser, point series of 100,000
points or more are drawn with WebGL2, loaded on demand the first time a chart
needs it; `chart.loading` settles once they are on screen (points on a time
axis with breaks are placed on the CPU). So are 3D charts of 20,000 points,
10,000 surface cells, or 20,000 line segments (see 3D charts). With
`sampling: "pixel"`, opaque points
whose centers land on the same device pixel are drawn once (above 4,096
points per series), which is faster for dense scatter plots but can drop
subpixel edge coverage. Tooltips find the nearest point through a spatial
grid index. Heatmaps are drawn as one image of at most the plot's device
pixels, whatever their number of cells.

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

Stacks follow streaming tables: appended rows and rows a rolling window
drops restack only what they touch (the rows themselves for fields, the
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
under the channel "grid-rows" (the `selection` and `channel` options), where
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
  model: createGridModel({ data: gridRows, columns, selection: store }),
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
expansion) from a table row (`kind: "row"`). Clicking a column's header
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
their siblings, and whether they are expanded. Since the focus is always on
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

## Migrating from earlier versions

Herceg is not yet at 1.0. Grid columns are at least 32 pixels wide
(`MIN_COLUMN_WIDTH`): `setColumns` and `createGridModel` refuse narrower
widths, which they took before.

Row groups by several fields nest. `groups.table` is unchanged (one row per
combination of the fields' values), but a grid shows a header per level
(each naming its own value) instead of one header per combination, and
`indexOf` of a shorter key finds the group of that level rather than -1.
`members(g)` returns a new array instead of one borrowed from the groups. A
group's `GridRow` has its level (1 for the first) and its place among its
siblings rather than among every group. Groups' sums are compensated, so
they can differ in the last digits from those of earlier versions (and of
derived tables).

Its chart handle now keeps the engine to itself:

- `chart.model` is gone. `getPanels()` describes the panels and their axes
  (`model.panels()`, `xScale()`, `yScale()`, and `yRightScale()`), `toPixel`,
  `fromPixel`, and `formatValue` map and write values (a scale's `map` and
  `invert`), and `inspect` finds data (`model.inspect`). Viewports are read
  with `getViewport({ panel })` (`model.viewport`, `viewportOf`, and
  `yViewport`) and set with `setViewport`; an axis' `group` and
  `canSetViewport` say what `model.sharesX` and `sharesY` did. Series are
  hidden with `setVisibility` and `setHiddenKeys` rather than by changing
  `model.hidden`, which also redraws and reports the change.
- `syncCursor`, `syncViewport`, `syncSelection`, `flush`, and `visible` are
  gone: charts with the same `interaction.sync` reach each other through
  their group, and frames are drawn by the shared frame loop or `render()`.
- The mark functions return a `ChartMark`, which shows its `spec`; the
  classes behind them (`LineMark`, `BarMark`, and the others) and what marks
  implement (`Mark`, `LayoutMark`, `LayoutFrame`, `LayoutItem`,
  `LayoutResult`, and `Plot3D`) are no longer exported, and charts take only
  marks the mark functions make. Marks of your own are `custom` marks, whose
  `plot` is a read-only `PlotRect`; `tablesOf` and `viewOf` give the tables
  and row view a mark follows.
