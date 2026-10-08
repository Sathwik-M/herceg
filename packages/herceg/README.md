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
numeric or time fields, `series` only accepts category fields.

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
codes (-1 for missing) and the dictionary.

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
```

Annotation positions count toward the axis domains, so thresholds and events
stay in view; on a category axis, a constant position is a band index (0 is
the first band, -0.5 its edge). Regions are drawn in mark order (list them first to shade
underneath the data); rules and text are drawn above the data, as SVG even
when the data is on a canvas, and with a halo so text stays readable over
lines. Annotations outside the view are left out. Text is meant for
annotations, not for labeling every point of a large series.

Bars, points, error bars, heatmaps, candlesticks, and histograms:

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

candlestick(prices, { x: "day", open: "open", high: "high", low: "low", close: "close" });

histogram(requests, { x: "latency" }); // counts in round bins
histogram(requests, { x: "latency", series: "region", bins: { step: 10 }, normalize: "percent" });

boxplot(requests, { x: "region", y: "latency", series: "version" });
boxplot(requests, { x: "latency", y: "region" }); // a category y lays boxes along y
```

Bar labels go past each bar's end, or for stacks inside each segment in a
color that contrasts with it; labels that do not fit are left out. A category
field on `x` or `y` (bars) or on `x` and `y` (heatmaps) gives a
band axis. Categories on a y axis run top to bottom; long names are shortened
with an ellipsis. Horizontal bars default to "nearest-y" tooltips, which
report every series in the band under the pointer. Heatmaps also accept number and time fields, with one column or row per
distinct value, up to 4,194,304 cells (bin finer data first). Heatmaps show a
color legend instead of series entries.

Points encode fields as well as positions. `r` names a number field to size
points by area, from zero (or the least value, when values are negative) at
`rRange[0]` pixels to the largest at `rRange[1]` (default [2, 12]), with a key
of round values below the legend. `fillOpacity` names a field mapped from
0.15 to opaque. `color` names a number field colored on a continuous scale,
with a color legend; series then appear in the legend in a neutral color.
`symbol` is one shape (`"circle"`, `"square"`, `"triangle"`, `"diamond"`,
`"cross"`, `"star"`, `"wye"`, `"triangle-down"`) or a category field whose
values take the shapes in that order, with a key unless the field also splits
series. Every shape covers the area of a circle of the same radius. Points
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

### Small multiples

`facet` draws the chart once per value of a category field, in a grid of
panels that share their x and y scales:

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
```

Panels follow the order in which values first appear in the data; rows
without a value are left out (though their categories still get a band on a
category axis). Marks over a table split its rows by the field,
which the table must have, unless they have `facet: "repeat"`; marks without
a table repeat. x labels go under the lowest panel of each column and y labels
beside the first. Pointer, brush, and zoom work in any panel and act on the
shared x; the arrow keys step through a panel and Up and Down move between
panels. Heatmaps, histograms, stacked bars, and annotations or custom marks over a table
can only repeat for now, and charts with facets have no right axis. A chart
too small for its panels (under 20 pixels a side) throws an error naming the
grid; give it more room or fewer columns.

### Custom marks

When no mark fits, `custom` draws shapes with the chart's scales on every
frame. Shapes render like other marks: in SVG or on a canvas, clipped to the
plot, and in static SVG. With a table, the `x` and `y` fields count toward
the axis domains.

```ts
custom(prices, {
  x: "time",
  y: ["low", "high"],
  description: "Daily price ranges.", // for the chart's text alternative
  draw({ table, x, y, line, circle }) {
    const time = table.numbers("time");
    const low = table.numbers("low");
    const high = table.numbers("high");
    for (let i = 0; i < time.length; i++) {
      line(x(time[i]!), y(low[i]!), x(time[i]!), y(high[i]!), { stroke: "#2a78d6" });
      circle(x(time[i]!), y(high[i]!), 3, { fill: "#2a78d6" });
    }
  },
});
```

`draw` receives `x` and `y` (data value to pixel; band index on category
axes), `domain`, `bandwidth`, `plot`, `theme`, and `path` (SVG
path syntax), `rect`, `circle`, `line`, and `text`, each with an optional
style (`fill`, `stroke`, `strokeWidth`, `opacity`, `dash`); they paint the same
on a canvas as in SVG (butt caps, miter joins, opacity applied to fill and
stroke separately). With a table, `draw` also gets it. Custom marks are
JavaScript only (a chart spec cannot hold a function), have no legend
entries or tooltips, and are meant for shapes in the thousands, not millions.

## Chart options

| Option | Description |
| --- | --- |
| `marks` | Marks to draw, bottom to top (rules are drawn on top). |
| `title`, `description` | Accessible name and description; the title is drawn. |
| `width`, `height` | Fixed size; omitted dimensions follow the container. |
| `x`, `y` | Scale and axis: `type` (`linear`, `log`, `time`), `domain`, `nice`, `zero`, `label`, `grid`, `ticks`, `format` (Intl options), `axis`. |
| `yRight` | The right y axis for marks with `axis: "right"`, with the same options as `y`. |
| `facet` | `facet(field, { columns? })`: a panel per value of a category field (see Small multiples). |
| `legend` | Shown by default for two or more series; legend entries toggle series. |
| `tooltip` | `true` (default), `false`, or `{ mode: "nearest-x" \| "nearest-y" \| "nearest" }`. |
| `interaction` | `{ zoom: true }` for wheel zoom and drag pan; `{ brush: "x" }` to select an x range by dragging (with `zoom`, the brush zooms instead and Shift-drag pans); `{ sync: "name" }` to share cursor and zoom with other charts. |
| `renderer` | `"auto"` (default), `"svg"`, or `"canvas"`. |
| `theme` | A theme name or an object overriding a theme's tokens (see Themes). |
| `locale`, `timeZone` | Label locale and time zone (`"local"`, `"UTC"`, or an IANA name). |

The returned `Chart` has `update(options)`, `setViewport([from, to] | null)`,
`select([from, to] | null)` and `selection` (the brushed range), `on(event,
listener)`, `render()`, `toSVG()`, `destroy()`, and `loading` (a promise
while the GPU painter for large point series loads, otherwise undefined).

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
chart.on("viewport", ({ domain }) => saveView(domain)); // zoom, pan, reset, sync
chart.on("hover", ({ inspection }) => showOwnTooltip(inspection)); // with tooltip: false
chart.on("click", ({ inspection }) => openDetails(inspection?.points[0]));
```

Events report changes only: a re-inspected point or an unchanged range does
not repeat them. An inspection's `axis` says what it is on: `"x"` or `"y"`
for a position along that axis (with its `position` in pixels), `"item"` for
a pie slice, whose `value` is the slice's and whose one point names it. Keyboard users select a range with Shift and the arrow keys
(Enter zooms to it when zoom is on; Escape clears it).

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
dtype: "float64" | "float32" | "int32" | ..., buffer: <index> }`), or
dictionary-encoded categories (`{ type: "category", codes, dictionary }`).
Marks are the same objects as a TypeScript mark's `spec`, with `data` naming
their table.

## Large data

Every point is drawn by default. In the browser, point series of 100,000
points or more are drawn with WebGL2, loaded on demand the first time a chart
needs it; `chart.loading` settles once they are on screen. With
`sampling: "pixel"`, opaque points
whose centers land on the same device pixel are drawn once (above 4,096
points per series), which is faster for dense scatter plots but can drop
subpixel edge coverage. Tooltips find the nearest point through a spatial
grid index. Heatmaps are drawn as one image.

Lines and areas over sorted x are reduced before drawing (M4): within each
device-pixel column, only the first, lowest, highest, and last points of an
unbroken run are kept, so a million-point series draws as a few thousand
points while keeping every column's extremes. Missing values split a line into
separately reduced runs, so data with very many gaps reduces less; dash
patterns can shift slightly because intermediate points are removed.
`renderer: "auto"` moves charts with many drawn points to Canvas. See
`docs/architecture.md` in the repository for details.
