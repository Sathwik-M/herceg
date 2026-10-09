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
and `last`, over finite values; quantiles interpolate as NumPy and pandas
do. Rolling windows are trailing windows of rows (within `groupby` groups),
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
`view.dispose()` stops it following its table.

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
area(metrics, { x: "time", y1: "p50", y2: "p99" }); // band between two fields

```

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
of its point, a few pixels away and off the other rows' points, and is left
out if none of those is free (sort the table to label what matters first).
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
```

Bar labels go past each bar's end, or for stacks inside each segment in a
color that contrasts with it; labels that do not fit are left out. A category
field on `x` or `y` (bars) or on `x` and `y` (heatmaps) gives a
band axis. Categories on a y axis run top to bottom; long names are shortened
with an ellipsis. Horizontal bars default to "nearest-y" tooltips, which
report every series in the band under the pointer. Heatmaps also accept number and time fields, with one column or row per
distinct value, and show a color legend instead of series entries.

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
`symbol` is one shape (`"circle"`, `"square"`, `"triangle"`, `"diamond"`,
`"cross"`, `"star"`, `"wye"`, `"triangle-down"`) or a category field whose
values take the shapes in that order, with a key unless the field also splits
series; a field named like a shape is refused rather than guessed at, so
rename it to encode it. Every shape covers the area of a circle of the same radius. Points
missing a value they encode are not drawn, and tooltips name the encoded
values. Encoded points are drawn on the CPU (Canvas or SVG), not by the WebGL
painter; opaque ones are drawn one color at a time, high values last.

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
is out of view has no tooltip.

Box plots summarize a number or time field per category of the other axis:
a box from the lower to the upper quartile (linear interpolation between
ranks, as NumPy and pandas compute them), a line at the median, whiskers to
the most extreme values within 1.5 interquartile ranges of the box (Tukey's
rule), and dots for the values beyond. `series` puts a box per value of a
category field side by side in each category, in its own color. Tooltips
report a box's median, quartiles, whiskers, count, and outliers. Missing and
non-finite values are left out. On a log axis, the parts of a box at zero or
below are not drawn. Statistics are recomputed for every box when the table
changes, so long streams of observations cost a full pass per frame. In
charts with facets, box plots repeat in every panel (`facet: "repeat"`).

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
```

Panels follow the order in which values first appear in the data; rows
without a value are left out (though their categories still get a band on a
category axis). A grid has a panel for every pair of values, rows by
columns, including pairs without rows, with the column values above the top
row and the row values beside the last column; wrapped panels each have
their value above them. Panels are keyed by their value, or in a grid by
both as a JSON array (`["North","A"]`), which inspections report as `panel`;
announcements and the chart's description name them by their values. Marks
over a table split its rows by the fields, which the table must have, unless
they have `facet: "repeat"`; marks without a table repeat. Panels share
their x and y scales; `resolve: { y }` gives each panel a y scale of its own
fitting what it draws (`"independent"`), or one per row (`"rows"`) or per
column (`"columns"`), for a continuous y axis, and `resolve: { x }` does the
same for a continuous x axis. x labels go under the lowest panel of each
column, or under every panel when a column's panels have different x
scales, with the x title once under each scale's lowest labels; y labels go
beside the first panel of each row, or beside every panel when a row's
panels differ. Specs with `resolve` need `"version": 2`, and with
`resolve.x` `"version": 3`, so that readers from before them refuse them
rather than draw shared axes. Charts whose panels have
y scales of their own cannot zoom along y or take a y viewport
(`setYViewport`) yet. Pointer, brush, and zoom work in any panel and act on
its x scale; the arrow keys step through a panel and Up and Down move
between its series and on to the next panel. Heatmaps, histograms, stacked bars, annotations over a
table, and custom marks over a table without series can only repeat for
now, and charts with facets have no right axis. A chart too small for its
panels (under 20 pixels a side) throws an error naming the grid; give it
more room or fewer columns.

With x scales of their own, each scale fits what its panels draw within its
own range, and zooms, pans, and resets by itself: the wheel and dragging act
on the panel under the pointer, double-clicking a panel resets its scale,
and double-clicking outside the panels resets every one. A shared y scale
still fits what every panel shows of its own x range, so zooming one panel
can change the y of the others. `setViewport([from, to], { panel })` names
the panel whose scale shows the range (null without a panel fits every
scale), and `viewport` events carry `panels`, the keys of the panels whose
range `domain` is, one event per scale. A selection belongs to the panels
sharing the x scale of the panel it was made in: it is drawn only there,
`select(range, { panel })` needs that panel, and `select` events and
`chart.selectionPanels` name them; a selection whose panels go (their facet
values leave the data) is cleared. Synced charts share cursors with such a
chart, drawn in every panel whose scale holds the value, but not viewports
or selections, which belong to some of its panels; sync only charts whose x
values mean the same thing. A scale's zoom is kept while its panels stay the
same: when they change (a new facet value wraps the panels anew), it fits
its data again. Category x axes are always shared.

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
in order, with their titles above them; `rowHeights` gives the rows' heights
relative to each other. They share the x axis, labeled under
the lowest panel of each column, and each has a y scale of its own, from its
marks; `resolve: { y: "shared" }` (or `"rows"`, `"columns"`) shares it
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
axis, category y axes are shared by every panel, and zooming and brushing act
on x only.

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
the thousands, not millions.

## Chart options

| Option | Description |
| --- | --- |
| `marks` | Marks to draw, bottom to top (rules are drawn on top). |
| `title`, `description` | Accessible name and description; the title is drawn. |
| `width`, `height` | Fixed size; omitted dimensions follow the container. |
| `x`, `y` | Scale and axis: `type` (`linear`, `log`, `time`), `domain`, `nice`, `zero`, `label`, `grid`, `ticks`, `format` (Intl options), `axis`; on a time x axis, `breaks: timeBreaks([...])` (see Financial charts). |
| `yRight` | The right y axis for marks with `axis: "right"`, with the same options as `y`. |
| `facet` | `facet(field, { columns? })`: a panel per value of a category field, wrapped; or `facet({ row?, column? })`: a grid by two fields (see Small multiples). |
| `resolve` | `{ x?, y? }`, each `"shared" \| "independent" \| "rows" \| "columns"`: which panels share an x or y scale (see Small multiples and Subplots). |
| `panels` | `panels([{ id, title?, x?, y? }, ...], { columns?, rowHeights? })`: subplots whose marks name them in `panel` (see Subplots). |
| `legend` | Shown by default for two or more series; legend entries toggle series. |
| `tooltip` | `true` (default), `false`, or `{ mode?: "nearest-x" \| "nearest-y" \| "nearest", axisLabels?: true }`; `axisLabels` labels the crosshair on the axes. |
| `interaction` | `zoom`: `true` or `"x"`, `"y"`, or `"xy"` for wheel zoom and drag pan along those axes (category axes do not zoom). `brush`: `"x"` or `"y"` to select a range by dragging, `"xy"` a rectangle, `"lasso"` a freehand region; along zoomed axes, a brush zooms instead (Shift-drag pans; lassos never zoom). `sync: "name"` shares cursor, x range, and selection with other charts; selections travel as data values (category indices on category axes), so charts sharing them should have the same axis types and category order. |
| `animation` | `true` or `{ duration }` (milliseconds, 250 by default) moves the axes gradually to a view asked for: `setViewport`, `setYViewport`, zooming to a brush, and double-click reset. Off by default. Wheel zoom, panning, new data, resizes, and export always show at once; charts with several panels or `sync`, pages preferring reduced motion, and charts whose frames seem to take over 10 ms (judged from earlier frames, alone or with the charts beside them) do not animate. The animation code loads with the first chart that asks for it. |
| `renderer` | `"auto"` (default), `"svg"`, or `"canvas"`. |
| `theme` | A theme name or an object overriding a theme's tokens (see Themes). |
| `locale`, `timeZone` | Label locale and time zone (`"local"`, `"UTC"`, or an IANA name). |
| `projection` | How maps are projected: a projection's name or `{ type, centralMeridian?, parallels?, fit? }` (see Maps). |

The returned `Chart` has `update(options)`, `setViewport([from, to] | null,
{ panel? })` and `setYViewport([from, to] | null)` (the left axis; a right
axis shows what the same pixels show on it), `select(selection | [from, to] |
null, { panel? })` (a pair is shorthand for an x range), `selection` and
`selectionPanels` (see Small multiples for `panel`), `on(event, listener)`,
`render()`, `toSVG()`, `destroy()`, and `loading` (a promise while the GPU
painter for large point series or the animation code loads, otherwise
undefined).

`update` takes a `ChartUpdate`: each option given replaces the chart's,
nested options (an axis, `interaction`, `tooltip`) whole, so pass every
setting you want to keep; an option given as `undefined` goes back to its
default; options left out are unchanged. React, Vue, and Svelte props are the
whole configuration: a prop left out, or `undefined`, takes its default.

`selection` is a `Selection`, `{ x, y, lasso }`, or null, all in data values:
the selected x and y ranges (null along an axis the brush leaves alone; a
lasso's extent) and a lasso's outline as `[x, y]` pairs. Code written when
`selection` was the x range reads `chart.selection?.x`.

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
chart.on("viewport", ({ domain, y }) => saveView(domain, y)); // zoom, pan, reset, sync
chart.on("viewport", ({ domain, panels }) => saveView(domain, panels)); // panels' own x scales
chart.on("hover", ({ inspection }) => showOwnTooltip(inspection)); // with tooltip: false
chart.on("click", ({ inspection }) => openDetails(inspection?.points[0]));
```

Events report changes only: a re-inspected point or an unchanged range does
not repeat them. An inspection's `axis` says what it is on: `"x"` or `"y"`
for a position along that axis (with its `position` in pixels), `"item"` for
an item of a layout mark (a pie slice, a tree's node, a gauge's dial, a
funnel's stage), whose `value` is the item's and whose one point names it. Keyboard users select a range with Shift and the arrow keys
along the axis the keys step along (x for lines and vertical bars, y for
horizontal bars), with brushes along that axis or rectangle and lasso
brushes, which only the pointer draws; Enter zooms to the range when zoom is
on along it, and Escape clears it. Selections made with the keyboard or the
pointer are announced.

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
marks step through their items. Legend entries are toggle buttons.

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
using `resolve`, `panels`, or `grid` must say 2 or later, and those using
`resolve.x` or a panel's own `x` must say 3 (`SPEC_VERSION`, the version this
herceg writes), so that older readers refuse what they would draw
differently. Loading checks a spec and names the property at
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
axis with breaks are placed on the CPU). With
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
