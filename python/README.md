# herceg for Python

Charts for pandas, Polars, PyArrow, and NumPy data, rendered by the
[herceg](../README.md) engine: the same charts, tooltips, zooming, and
large-data handling as the TypeScript library.

> Early development. Line, area, bar, scatter, heatmap, dendrogram, error bar,
> candlestick, histogram, pie, box plot, violin, treemap, sunburst, gauge, funnel, radar, Sankey, network (graph), and map (choropleth and point) marks, rule, region, and text annotations; small multiples;
> HTML, notebook, SVG, PNG, and PDF output; live notebook charts; Streamlit apps.

```python
import herceg as hg

hg.line(df, x="time", y=["p50", "p99"], title="Request latency")
```

## Charts

One call makes a chart of one kind:

```python
hg.line(df, x="time", y="latency", series="service")
hg.area(df, x="time", y=["user", "system"], stack=True)
hg.area(responses, x="minute", y="count", series="status", stack=True)  # long format
hg.area(cpu, x="time", y="load", series="host", stack=True, stack_gaps="interpolate")
hg.bar(sales, x="region", y=["q1", "q2"])
hg.bar(sales, x="q1", y="region")  # a category y gives horizontal bars
hg.bar(sales, x="region", y="q1", labels=True)  # values at the bar ends
hg.Chart(stats).bar(x="group", y="mean").error_bar(x="group", y="mean", y_error="se")
hg.scatter(cars, x="weight", y="mpg", series="origin", r=3)
hg.scatter(countries, x="gdp", y="life", r="population", series="continent")  # bubbles
hg.scatter(stations, x="lon", y="lat", color="anomaly", colors="rdbu", color_midpoint=0)
hg.scatter(cars, x="weight", y="mpg", symbol="origin")  # a shape per origin
hg.scatter(requests, x="region", y="latency")  # a category x places points in its bands
hg.heatmap(load, x="hour", y="host", value="cpu", colors="viridis")  # hours along a time axis
hg.heatmap(load, x="hour", y="host", value="cpu", x_banded=True)  # a column per distinct hour
hg.heatmap(commits, date="day", value="count", calendar="months")  # a calendar
hg.candlestick(prices, x="day", open="open", high="high", low="low", close="close")
hg.candlestick(prices, "day", "open", "high", "low", "close", variant="ohlc")  # OHLC bars
hg.histogram(requests, x="latency", series="region", bins={"step": 10})
hg.pie(sales, "region", "revenue", inner_radius=0.6)  # a donut; counts rows without a value
hg.boxplot(requests, x="region", y="latency", series="version")
hg.violin(requests, x="region", y="latency")  # kernel densities, quartiles inside
hg.treemap(sales, ["region", "country"], "revenue")
hg.sunburst(org, node="team", parent="parent_team", value="cost")
hg.gauge(metrics, "cpu", bands=[70, 90, (100, "#e0464f")])  # the last value on a dial
hg.funnel(signups, "stage", "users")
hg.radar(scores, "skill", "score", series="player")  # a spoke per skill
hg.radar(players, fields=["speed", "power", "range"], series="name")  # a polygon per row
hg.sankey(energy, "source", "target", "twh")  # flows between nodes; counts rows without a value
hg.graph(talks, "from", "to", nodes=people, node="name", group="team")  # a network
hg.choropleth(countries_gdf, "gdp", name="name", projection="equal-earth")  # a map
hg.choropleth(rates, "rate", geojson=counties, locations="fips")  # values joined to shapes
hg.scatter_geo(cities, "lon", "lat", r="population", name="city")  # bubbles on a map
hg.scatter_3d(iris, x="sepal_length", y="sepal_width", z="petal_length", series="species")
hg.line_3d(flights, x="east", y="north", z="altitude", series="flight")  # a path per flight
hg.surface(terrain, x="east", y="north", z="height")  # a grid of rows
hg.surface(z=heights, x=eastings, y=northings)  # a 2D array: row i, column j at y[i], x[j]
```

3D charts draw `.point3d(...)` points, `.line3d(...)` lines (each `series`
category's rows, in order, one path, broken where a row has no value), and
`.surface(...)` surfaces in one box (they share a chart with each other
only), seen from `camera=hg.Camera(azimuth=-60,
elevation=25, zoom=1, perspective=False)` (or a dict of those) and turned by
dragging (`rotate=False` stops that), the wheel with `zoom=True`, the
keyboard, and buttons in the chart's corner. `z=hg.Axis(...)` sets the
vertical axis, `box_aspect=(2, 2, 1)` the box's proportions. A surface from a
matrix travels as three columns with a row per grid point; rows not on a
grid must be binned or aggregated first. In the browser, large 3D charts
(20,000 points, 10,000 surface cells, or 20,000 line segments) are drawn
with WebGL2 and depth-tested, up to 1,048,576 grid points a surface; static
SVG, PNG, and PDF draw on the CPU, back to front, at most 250,000, and show
the starting camera.

Maps, trees, and networks take the options axes do. `zoom=True` pans and
zooms a map (the wheel, dragging, Shift with the arrow keys, plus and minus,
0 to show it all, and a toolbar), whose `viewport` is in its projection's
plane, and `brush="lasso"` lassos its regions and points; `zoom=True` on a
treemap or sunburst drills into the node clicked (Enter on the node read,
Backspace and the breadcrumbs above it to go back); `drag=True` lets a
network's nodes be dragged, staying where they are dropped (Shift with the
arrow keys moves the node read). `row_selection` selects a region's or
point's row, a tree node's rows, or a network node's or link's rows by
click (lassos on maps). `.graph(..., directed=True)` draws links from
source to target with arrowheads, and `link_label="kind"` writes a category
along the links with room; both need spec version 11.

```python
hg.Chart(countries, zoom=True, brush="lasso", row_selection=hg.SelectionBinding("picked")).geoshape(color="gdp")
hg.Chart(sales, zoom=True).treemap(path=["region", "country"], value="revenue")
hg.Chart(talks, drag=True).graph("from", "to", directed=True, link_label="kind")
```

Violins accept `split=True` and `inner="box" | "quartiles" | "none"` in both
`hg.violin(...)` and `Chart.violin(...)`. The default box is unchanged;
`"quartiles"` draws dashed Q1/Q3 lines and a solid median, and `"none"`
omits inner marks. Split requires a category `series` field with at most two
observed values across the mark: first left (below horizontally), second
right (above), in the current whole-table legend order. Categories or panels
with missing or hidden partners leave their half empty, and each keeps its
color, legend entry, tooltip, keyboard stop, and
summary. More than two values fails when rendered with an error naming the
field and count; unused dictionary values and missing/non-finite rows do not
count. Both options work with facets, per-panel categories, either orientation,
and SVG, Canvas, static SVG, and PDF output. Specs use version 7 only when
`split=True` or a non-default `inner` needs it.

Heatmaps over number and time columns place their cells along number and
time axes, which zoom and pan: each cell reaches halfway to the values
beside it, or with `x_step` / `y_step` (milliseconds for times) is that wide
around its value, leaving gaps where values are missing. `x_banded=True` /
`y_banded=True` give one column (or row) per distinct value instead, as
category columns have. `date=` lays the days of a time column out as a
calendar in the chart's `time_zone`: `calendar="weeks"` (the default) a
column per week along a time axis and a row per day of the week from
`week_start` (`"mon"` by default), `calendar="months"` a row per month and
a column per day of the month. Specs use version 9 when a heatmap places a
number or time column along an axis, has a step, or is a calendar; earlier
readers band such columns, so they refuse it.

```python
hg.violin(requests, x="region", y="latency", series="version", split=True, inner="quartiles")
hg.Chart(requests, facet="service", resolve_y="independent").violin(
    x="latency", y="region", series="version", split=True, inner="none"
)
```

Maps read shapes from GeoPandas GeoDataFrames, GeoJSON FeatureCollection
dicts (properties become columns), or columns of GeoJSON geometries or
objects with `__geo_interface__` (Shapely), without importing GeoPandas or
Shapely; shapes travel as packed binary arrays, not JSON coordinates.
Coordinates must be longitudes and latitudes in degrees (WGS 84): a
GeoDataFrame in a projected reference system is refused with a hint to
`to_crs(4326)`. As in Plotly, `geojson=` with `locations=` and
`feature_id_key=` (Plotly's `featureidkey`: `"id"` or `"properties.<name>"`,
compared as text, so leading zeros count) joins a dataframe's values to the features: every
feature is drawn, those no row names without a value. `hg.Chart(...,
projection=...)` combines `.geoshape(...)` regions and `.geopoint(...)`
points on one map; `projection` is a name (`"equal-earth"`,
`"natural-earth"`, `"mercator"`, `"equirectangular"`,
`"conic-equal-area"`) or `hg.Projection(type, central_meridian=...,
parallels=(29.5, 45.5), fit="data" | "world" | ((west, south), (east,
north)))`. A live chart replaces a table of shapes whole (`replace`) rather
than appending to it; for values joined with `geojson=`, `replace(rows,
data=values)` joins the new rows to the features again.

`hg.Chart` composes marks on shared axes; each mark method returns the chart:

```python
chart = (
    hg.Chart(df, title="Request latency", y=hg.Axis(label="ms"), zoom=True)
    .line(x="time", y=["p50", "p99"])
    .rule(y=250, label="SLO")
)

# Small multiples: a pie of each region's rows, with one legend for all.
hg.Chart(sales, facet="region").pie("product", "revenue")

# A dashboard row: a line beside a donut, a panel each.
(
    hg.Chart(sales, panels=["trend", "share"], panel_columns=2, zoom="x")
    .line(x="week", y="revenue", panel="trend")
    .pie("product", "revenue", inner_radius=0.6, panel="share")
)
```

Chart options: `title`, `description`, `width`, `height`, `x` and `y`
(`hg.Axis(type="log", domain=(0, 100), label="ms", ...)` or a dict),
`y_right` (the axis for marks added with `axis="right"`, in every panel
that draws them), `facet` and
`facet_columns` (a panel per value of a category column, wrapped into rows),
or `facet_row` and `facet_col` (a grid with a row per value of one category
column and a column per value of another; either may be left out), with
`resolve_x`, `resolve_y`, and `resolve_y_right` (`"shared"`,
`"independent"`, `"rows"`, or `"columns"`) choosing which panels share an x,
a y, or a right y scale (facets share them by default, subplots x; the right
y as `resolve_y` unless given; on a category axis, panels that do not share
it show only the categories their rows hold); histograms, box plots, and
violins summarize each panel's rows (histograms in bins chosen from the rows
of the panels sharing an x scale); annotations over a table draw each row in
its own row's panel; marks with `repeat=True` draw all their rows in every
panel, which dendrograms need; pies, treemaps, sunbursts, gauges, funnels,
radars, and Sankey diagrams draw each facet panel's rows in it, as a
faceted chart's only mark, or fill a panel of their own with `panel=` (no
`"*"`, and no other mark there), whose neighbors keep their axes; `panels` (ids or
`hg.Panel("latency", title="Latency", x=hg.Axis(label="Time"),
y=hg.Axis(label="ms"), y_right=hg.Axis(label="requests"))`), `panel_columns`, and
`panel_row_heights` and `panel_column_widths` (relative heights of the rows
and widths of the columns) for subplots, whose marks
name their panel with `panel="latency"` (or `"*"` for all),
`legend`, `tooltip` (`True`, `False`, `"nearest-x"`, `"nearest-y"`, `"nearest"`, or
`hg.Tooltip(mode=..., axis_labels=True)`, which also labels the crosshair on
the axes), `zoom`
(`True` or `"x"`, `"y"`, `"xy"`: wheel zoom and drag pan along those axes),
`brush` (`"x"`, `"y"`: drag to select a range; `"xy"`: a rectangle; `"lasso"`: a
freehand region; along zoomed axes, drag to zoom instead),
`sync` (charts with the same name on one HTML page share cursor and zoom;
notebook outputs are separate iframes, so `sync` does not reach across
cells), `animation` (`True`, milliseconds, or `hg.Animation(duration=250,
values=True)`: zooming to a brush and double-click reset move the axes
gradually in HTML output, and with `values`, bars, pie slices, and lines and
areas whose x values stay move to the data a live chart's `replace` sends,
with axes whose domains change; points match across replacements with
`animation_key="id"` on `Chart.point()` or `hg.scatter()`), `renderer`,
`theme` (below), `locale`, `time_zone`, and `projection` (maps, above).

For points refreshed from an API, use an explicit animation key:

```python
chart = hg.scatter(data, "x", "y", animation_key="id", animation=hg.Animation(values=True))
widget = chart.widget()
widget.replace(next_data)  # matching ids move even when rows are reordered
```

The key column is sent with the data. It may hold finite numbers, datetimes,
or category labels; keys must be present and unique within each rendered
series in both frames. Missing or duplicate keys show that series at once
(the whole chart if its axes move). Category dictionary codes may change;
labels identify points. New keys grow and removed keys shrink. Animation keys
only match the drawing and do not preserve selections across replacements.
Unkeyed points still show replaced rows at once. Keyed points animate across
replacements in notebook widgets and JavaScript apps. Streamlit components
remount when their data changes, so keyed points show at once there. Sampled
points, GPU clouds, frequent updates, and the other animation limits still
show at once.

The one-call helpers (`hg.line`, `hg.scatter`, which adds `point` marks,
`hg.choropleth`, which adds `geoshape` marks, and the rest) take their mark's
keyword arguments and the same chart options together, as in
`hg.line(df, x="time", y="p99", stroke="#d62728", title="Latency")` or the
band `hg.area(df, x="time", y1="p25", y2="p75")`; their `x` and `y` name
columns, so the axes are `x_axis` and `y_axis` there. The options are typed
(`hg.ChartOptions`, `hg.HelperOptions`, and `hg.ChartUpdate` for live
updates), so type checkers catch misspelled ones; `None` takes an option's
default.

`theme` is `"light"` (the default), `"dark"`, `"high-contrast"`,
`"high-contrast-dark"`, `"auto"` (light or dark to match the surface the chart
is drawn on, in HTML output; light in static files), or a dict that overrides a
theme's tokens: `extends`, `background`, `text`, `muted`, `grid`, `axis`,
`font`, `font_size`, `title_size`, `grid_dash`, `line_width`, `bar_radius`,
`tooltip_background`, `tooltip_border`, `palette`, `sequential`, `diverging`,
`rise`, and `fall`. Colors may be CSS variables such as
`"var(--brand, #3266d6)"`, which charts read from the HTML page that draws
them. Notebook outputs are isolated frames that do not see the notebook's
variables, and static output has no page: both use the fallback.

```python
hg.Chart(data, theme={"extends": "dark", "bar_radius": 0, "palette": ["#5b8def", "#dc6f3a"]})
```

A time x axis can leave out time, so trading sessions sit side by side:
`hg.Axis(breaks=[...])` takes `hg.Break` rules, each one of `weekdays`
(`("sat", "sun")`), `hours` (`("16:00", "09:30")` or `datetime.time`s, a
daily span wrapping past midnight), `dates` (holidays, as dates or
`"YYYY-MM-DD"`), or `start` and `end` (instants; naive datetimes are UTC),
all in the chart's `time_zone`, clock changes included. Data inside a break
is not drawn; lines join the points either side, and ticks that would fall
in a break move to the session that opens after it. Dicts in the spec's
form (`{"weekdays": [...]}`, `{"from": ..., "to": ...}`) work too.

```python
sessions = hg.Axis(
    seams=True,
    breaks=[
        hg.Break(weekdays=("sat", "sun")),
        hg.Break(hours=("16:00", "09:30")),
        hg.Break(dates=[datetime.date(2025, 12, 25)]),
    ]
)
(
    hg.Chart(prices, x=sessions, time_zone="America/New_York", tooltip=hg.Tooltip(axis_labels=True))
    .candlestick("time", "open", "high", "low", "close")
)
```

`hg.Axis(seams=True)` marks time breaks' seams with dashed vertical lines,
one CSS pixel wide, behind the data and inside the plot. Set
`seams={"min_spacing": 40}` to change their minimum spacing (finite and
positive, default 40 CSS pixels). Seams are kept in chronological order;
markers become selective when zoomed out and exclude plot edges. They
follow each panel's shown domain; the navigator draws none. Omission or
`False` disables them. Enabled seams need time-axis breaks and write spec
version 5. Seams use the theme's resolved grid color and a `[3, 3]` dash.

`navigator=True` adds a range navigator: a strip under the plot drawing the
chart's lines, areas, points, bars, and candlesticks over the whole x axis,
with a window over the x range in view, which dragging and the keyboard move
and resize. `hg.Navigator(height=48, marks=["close"])` sets its height in
pixels and the `id`s of the marks it draws. It works in static output too
(drawn as is) and in live charts, where moving it reports the viewport as
zooming does; charts with facets or panels cannot have one yet.

```python
hg.line(prices, x="time", y="close", id="close", navigator=hg.Navigator(marks=["close"]))
```

Mark methods take column names; `series` names a category column that splits
rows into one series per value. A mark can read other data with `data=`.
Points can size (`r`), color (`color`), fade (`fill_opacity`), and shape
(`symbol`) by column; `colors` takes a scheme name from `hg.SCHEMES` or a list
of hex colors, and `symbol` a shape from `hg.SYMBOLS` or a category column
(not one named like a shape). `stroke` and `stroke_width` outline points and
areas, and `fill` gives every box plot or violin one color.
Column names are checked when the mark is added, with the available columns
in the error message.

Marks naming the same `legend_group` share series by name: series of the
same name (a `series` value, or a single mark's `label`) take one color, one
legend entry, and one visibility, so a bar and its error bars hide together.
Side-by-side marks of a group (grouped bars, box plots, violins, dodged
histograms, points, and error bars) take the group's slots, so an error bar
stands on its bar even when one mark lacks some of the group's series.
On a category axis, `dodge=True` places a point or error bar mark's series
side by side in each category, as grouped bars are, and `jitter` (a width
from 0 to 1 of the category's band, or `hg.Jitter(width, seed=...)`) spreads
points across it by a hash of each row, so they keep their places as the
chart redraws and streams:

```python
(
    hg.Chart(stats)
    .bar(x="day", y="mean", series="sex", legend_group="sex")
    .error_bar(x="day", y1="low", y2="high", series="sex", dodge=True, legend_group="sex")
)
hg.scatter(tips, x="day", y="tip", series="sex", dodge=True, jitter=0.5)
```

These write spec version 10.

Histograms take exactly one number or time column, `x` (vertical) or `y`
(horizontal), in both `hg.histogram` and `Chart.histogram`:

```python
hg.histogram(requests, y="latency", bins=[0, 10, 25, 100])
hg.Chart(requests).histogram("latency", series="region", normalize="probability",
                            common_norm=True, cumulative=True, dodge=True)
```

`bins` is an approximate integer count, a `{"step": width, "start": edge}`
dict, or a numeric sequence / 1-D NumPy array of exact edges. Edges must be
finite and strictly increasing, with 2 to 1,001 entries; invalid input raises
`ValueError`. Edges round-trip through JSON at full floating-point precision,
without rounding, extending, or coarsening. Time edges use epoch milliseconds.
Bins include their left edge and exclude their right edge, except that the last
bin includes both. Non-finite and outside values are left out; explicit edges
are shared by all series and panels.

`normalize` is `"count"` by default, `"probability"` (bin count / series count
in bins), `"percent"` (probability × 100), or `"density"` (probability / bin
width). `common_norm=True` also weights each normalized series by its share
of finite observations, before dropping values outside bins. Hidden series
stay in that denominator; count normalization is unchanged. With facets,
bins follow panels sharing the binned axis (`resolve_x` or `resolve_y`), and
normalization is local to each panel. Subplots draw whole marks.

`cumulative=True` accumulates counts, probabilities, or percents through each
bin; density integrates bin widths to give probability mass. The final bar
is 1 (or the series' share with common normalization), or 0 for no counted
values. Accumulation happens before stacking. `dodge=True` places the visible
series side by side with opaque fills by default, giving hidden series' slots
to the others. Dodge excludes `stack=True`; horizontal histograms exclude
`axis="right"`. The new options write spec version 10; omitted/false flags keep
the earlier version. A chart's version is the maximum required by its features.

Box plots accept raw category/value columns or precomputed statistic columns:

```python
hg.boxplot(requests, x="region", y="latency", whiskers="range")
hg.boxplot(requests, x="region", y="latency", whiskers=2, notch=True)
hg.boxplot(stats, x="region", low="min", q1="p25", median="p50", q3="p75",
           high="max", count="n", notch=True)
hg.Chart(stats).boxplot(y="region", low="min", q1="p25", median="p50",
                       q3="p75", high="max")  # horizontal, one box per row
```

Precomputed boxes take exactly one category `x` or `y` and all five numeric
or time statistic fields, ordered `low ≤ q1 ≤ median ≤ q3 ≤ high`. They
exclude raw values, have no outliers, and reject `whiskers`; missing or
non-finite statistics omit the box. `count` names an optional number column
of positive safe integers, required for `notch=True`.

Raw `whiskers` defaults to `"tukey"` (1.5 × IQR); `"range"` uses minimum and
maximum with no outliers, and a finite nonnegative number sets the IQR
multiple. Default whiskers reach the most extreme observations within the
fences, even inside the quartiles. Custom multipliers keep whiskers at least
as far out as the quartiles, including when no observations lie within the
fences. Notches extend 1.57 × IQR / √count from
the median, using the finite observation count for raw input. They are not
clamped to the quartiles; small samples can produce a flipped outline. SVG,
Canvas, static SVG, and PDF draw the same geometry. Tooltips, keyboard
reading, legends, summaries, and facets work with both input forms; absent
precomputed counts are omitted from tooltips. Raw notches and nondefault
whiskers emit spec version 6 so older readers refuse them. Older readers
already refuse precomputed boxes because they lack a raw value-axis field.

### Dendrograms

`Chart.dendrogram(first, second, height, *, leaves, side=None, data=None,
stroke=None, stroke_width=None, label=None, repeat=False, panel=None,
id=None)` adds a clustering linkage tree. The three fields name number
columns in SciPy's linkage layout: row k merges its two child ids into
cluster n+k, with leaves 0 through n−1. Ids must be whole numbers naming a
leaf or an earlier merge; each cluster is merged once. Heights are finite
and nonnegative. `leaves[i]` is leaf i's string category label, with exactly
rows+1 distinct labels; an empty linkage with one leaf is valid.

```python
linkage = {"first": [0, 2, 5], "second": [1, 3, 4], "height": [1, 2, 4]}
chart = hg.Chart(linkage, y=hg.Axis(show=False)).dendrogram(
    "first", "second", "height",
    leaves=["a", "b", "c", "d"], side="bottom", label="Column clustering",
)
```

The tree contributes leaf categories in first-child-before-second-child
order (c, d, a, b here) and places leaves at band centers. `side` names
the leaves' plot edge: bottom (default) or top along x, left or right along
y. Merge heights scale linearly within the panel to its opposite edge,
independent of axis zoom. Hide that direction's axis with `hg.Axis(show=False)`.
Ties and decreasing heights are allowed; all-zero heights stay at the
leaves' edge. A leaf missing from the axis omits links above it. The default
stroke is muted theme text, with width 1 CSS pixel; `label` names a summary
of leaf and merge counts and height range, with no legend or inspection.
With facets, `repeat=True` is required.

Compose a clustered heatmap with panels corner, top, left, matrix,
`panel_columns=2`, `panel_row_heights=[1, 4]`,
`panel_column_widths=[1, 4]`, `resolve_x="columns"`, and `resolve_y="rows"`.
Put the heatmap in matrix with categories reordered by the dendrograms,
the column tree in top with `side="bottom"`, and the row tree in left
with `side="right"`; hide corner's axes, top's y axis, and left's x axis.
The bands align across panels in SVG, Canvas, and static SVG/PNG/PDF.
`hx.clustermap` builds this layout from a table (see Statistical charts).

### Rugs

`Chart.rug(x=None, *, y=None, series=None, data=None, length=None,
side=None, stroke=None, stroke_width=None, label=None, axis=None,
repeat=False, panel=None, id=None)` adds one tick per observation of exactly
one number or time column. It composes with other marks:

```python
hg.Chart(requests).rug("latency", series="service")
hg.Chart(requests).rug(y="latency", side="right", length=12, label="Requests")
```

Ticks reach 8 CSS pixels into the plot by default, from bottom/top for `x`
or left/right for `y`, and stay at that edge through zoom and pan.
`length` must be finite and positive; `stroke_width` defaults to 1 pixel.
`stroke` overrides series colors. Rugs widen only their observed axis,
omit missing and infinite values (and nonpositive values on a log axis),
and preserve coincident observations. Tooltips and keyboard reading report
real rows and format the observed value using its axis; summaries give
counts and ranges. Facets split rows, `repeat=True` repeats them, and
`panel` places rugs in subplots. A y rug refuses `axis="right"`;
`side="right"` places its ticks at the right edge. There is no one-call
`hg.rug` helper.

## Statistical charts

`herceg.express` makes Seaborn's statistical charts in one call. It
computes their statistics with NumPy and returns an ordinary `hg.Chart` of
herceg's marks, so they display, save as HTML, SVG, PNG, and PDF, and run in
notebooks and Streamlit like any other chart:

```python
import herceg.express as hx

hx.barplot(tips, x="day", y="total_bill", hue="sex", seed=1)
hx.lineplot(fmri, x="timepoint", y="signal", hue="event", errorbar=("se", 1))
hx.regplot(tips, x="total_bill", y="tip", order=2)
hx.histplot(penguins, x="flipper_length_mm", hue="species", kde=True)
hx.pairplot(penguins, hue="species")
hx.clustermap(flights_wide, z_score=1)
```

| Function | Computes (NumPy) | Draws |
| --- | --- | --- |
| `barplot`, `pointplot` | an `estimator` ("mean" or "median") per category, and an interval | bars or points, with error bars dodged by `hue` |
| `lineplot` | the estimate and interval at each distinct x | lines, with bands (`err_style="band"`) or error bars |
| `regplot` | least-squares polynomial fits (`order`), or `lowess`, with bootstrap bands | points, fit lines, bands |
| `residplot` | residuals from a polynomial fit, optionally a lowess line through them | points around a rule at 0 |
| `histplot` | Seaborn's bin edges; heights, and KDE overlays scaled to them | the histogram mark (counts in the browser), lines |
| `kdeplot` | Gaussian kernel densities (SciPy's `gaussian_kde`), 1D or 2D | lines or filled areas; a density heatmap for x and y |
| `ecdfplot` | the empirical distribution | step lines |
| `rugplot`, `stripplot` | (none) | rug ticks; points jittered by row and seed |
| `boxplot`, `violinplot` | quartiles and whiskers (also in `statistics`) | the box plot and violin marks |
| `pairplot`, `jointplot` | bins, densities, fits | subplots: scatter plots with histograms or densities |
| `clustermap` | hierarchical clustering of rows and columns | a reordered heatmap with dendrograms in side panels |

Arguments follow Seaborn's names and are keyword-only after the data: `x`,
`y`, `hue` (a category column, or numbers read as categories, splitting the
marks' series in one legend group, so a hue level's bars and error bars, or
line and band, share a legend entry and hide together), `order` and `hue_order`
(which levels, in which order; rows of other levels are left out), `col`
and `row` (facets), `palette` (a list of colors), and the chart options of
the one-call helpers (`title`, `width`, `height`, `theme`, `x_axis`, ...).
Axes are labeled with the columns' names unless `x_axis` or `y_axis` say
otherwise. Rows missing a value the chart uses are left out, and the chart's
description says how many.

Intervals take Seaborn's `errorbar`: `("ci", 95)` resamples each group
`n_boot` times (1,000) with `numpy.random.default_rng(seed)` and takes the
percentile interval of the estimates, `("pi", 50)` the central percentiles
of the values, `("se", 1)` and `("sd", 1)` multiples of the standard error
and deviation (`ddof=1`) about the estimate, and `None` none. Each group's
resampling starts from the seed, drawing its indices as Seaborn's
`bootstrap` does, so a seed gives Seaborn's intervals exactly. Without a
`seed`, one is drawn and recorded. Groups of one value have no interval.

The chart's description (its accessible text) ends with what was computed:
the estimator and method, the resamples and seed, the bandwidth rule, and
the rows left out. `hx.statistics(chart)` returns the same, with the
computed tables as NumPy arrays (estimates and intervals, bin heights,
densities, fit coefficients, box statistics, linkages and leaf orders):

```python
chart = hx.barplot(tips, x="day", y="tip", seed=3)
stats = hx.statistics(chart)
stats.seed, stats.tables["estimates"]["low"]
```

SciPy is optional (`pip install 'herceg[stats]'`): `clustermap` uses its
hierarchical clustering when it is installed, and the same agglomeration in
NumPy otherwise. Results were checked against Seaborn, SciPy, and
statsmodels (`tests/test_express_numerics.py`, `tests/test_express.py`).
Lowess fits take time proportional to the rows times the rows each local
fit uses (`frac`): about 3 s for 10,000 rows with statsmodels' default
`delta=0`, about 30 ms with `delta` 1% of the x range, which interpolates
between fits as statsmodels does.

Express charts are snapshots of what was computed: `widget.update(...)`
changes their options, while `append` and `replace` change the tables the
marks draw (a histogram recounts its bins, a box plot its quartiles), not
the estimates, fits, or densities Python computed. To recompute, call the
function again (Streamlit reruns do); a fixed seed keeps intervals from
changing on every run. Live widgets refuse pair, joint, and cluster maps,
whose panels have x scales of their own.

Differences from Seaborn: `pointplot` draws no lines between its points
(lines cannot run along a category axis yet); `violinplot` uses herceg's
violin mark, each violin as wide as the others at its densest, with
Silverman's rule (R's, 0.9 min(sd, IQR/1.34) n^-1/5) per violin or one
`bandwidth` for all, not SciPy's Scott factor, and takes `split=True` (a
hue of at most two levels, as halves) and `inner="box"`, `"quart"`, or
None, but not `"stick"` or `"point"`; `histplot` has no
`multiple="fill"`, `element="step"`, `stat="frequency"`, or weights, and
draws densities over vertical bars only; `kdeplot` draws bivariate
densities as a heatmap without contours; `kdeplot` and `ecdfplot` refuse
`y` alone (a line along y would be read by its x in tooltips and keyboard
reading, reporting the observation rather than the density or share);
`jointplot` takes `kind="scatter"` or
`"reg"`; `pairplot` gives the diagonal's histograms and densities y scales of
their own and its scatter plots matching y ranges per row, rather than one
shared y axis per row.

## Data

Charts accept pandas, Polars, and PyArrow tables, mappings of column names to
arrays or lists, and lists of records. A column is converted the first time a
mark uses it, without building Python objects per value for array data:

| Column | Sent as |
| --- | --- |
| integers, floats, booleans | float64 (float32 stays float32); missing values are NaN |
| datetimes, dates (any unit) | epoch milliseconds as float64, keeping fractions; naive values are UTC |
| strings, categoricals, Arrow dictionaries | int32 codes and a dictionary |

Only columns that marks use are sent, as little-endian binary buffers next to
the chart spec, never as JSON number lists. Columns of Python objects (pandas
`object` columns, lists) are typed by their values: all strings, all numbers,
or all dates and datetimes. `None`, NaN, `pd.NA`, and `NaT` are missing
values; a column with nothing else is an empty number column.

Conversions that would silently change data are refused with an error naming
the column: integers beyond ±2**53 (float64 would round them; convert to
float yourself to accept that), columns mixing strings, numbers, and dates,
and column names or category labels that collide once read as text (such as
`1` and `"1"`).

`hg.derive` prepares data in the chart itself, in the portable spec: the
browser computes the rows, so a chart can send raw data once and aggregate
it there, and live charts aggregate rows as they stream in.

```python
hourly = (
    hg.derive(df)
    .filter((hg.col("temp") > -40) & (hg.col("site") != "test"))
    .calculate("f", hg.col("temp") * 1.8 + 32)
    .bin("time", step=3_600_000, name="hour")
    .aggregate(by=["hour", "site"], mean=("f", "mean"), n="count")
)
hg.line(hourly, x="hour", y="mean", series="site")
hg.derive(prices).rolling(20, ma=("close", "mean"))
```

Expressions use Python operators (`&`, `|`, and `~` combine conditions),
`is_in`, `is_missing`, `when`, and math methods; aggregations name their
results as pandas' named aggregation does. Each step checks the columns it
reads, and only the source columns that steps and marks use are sent.

## Output

```python
chart                      # displays in Jupyter, JupyterLab, and VS Code notebooks
chart.show()               # notebook display, or a browser tab outside notebooks
chart.save("chart.html")   # self-contained page: herceg and the data embedded
chart.save("chart.svg")    # static SVG
chart.save("chart.png")    # PNG at twice the chart size (scale=...)
chart.save("chart.pdf")    # one-page vector PDF (chart.to_pdf() returns the bytes)
chart.to_spec()            # (spec dict, list of binary buffers)
chart.widget()             # a live notebook chart (see below)
```

HTML output and notebook display embed the herceg bundle (about 142 KiB,
52 KiB gzipped), so they work offline. Notebooks show each chart in an
isolated iframe.

SVG, PNG, and PDF export need the `export` extra (`pip install
'herceg[export]'`): SVG is rendered by the same DOM-free renderer as herceg's
`renderToSVG`, run in an embedded V8 engine (`mini-racer`), so it matches the
browser's chart except for text measurement, which uses fixed Helvetica
metrics. PNG is rasterized from that SVG by `resvg`. PDF comes from herceg's
`renderToPDF` in the same engine, with the SVG's layout: vector marks, axes,
and legends, heatmaps as images, and selectable text. Without supplied fonts,
PDF uses the standard fonts and Windows-1252 encoding (other characters
print as "?"). For Unicode, fonts are export options, separate from the spec:

```python
from pathlib import Path

chart = hg.Chart(data, title="Δ latency", theme={"font": "Inter"}).line(x="time", y="latency")
fonts = {
    "Inter": {"normal": Path("Inter-Regular.ttf"), "bold": Path("Inter-Bold.ttf")},
    "Symbols": Path("Symbols.ttf").read_bytes(),
}
pdf_bytes = chart.to_pdf(fonts=fonts, fallback=["Symbols"])
chart.save("chart.pdf", fonts=fonts, fallback=["Symbols"])
# A family with one face can also be supplied as {"Inter": "Inter-Regular.ttf"}.
```

Python keeps these font arguments: its JavaScript bridge prepares them with
`pdfFonts` before export. TypeScript callers use `fonts: pdfFonts(sources,
{ fallback, missingGlyph })`; plain JavaScript PDF exports omit this helper
and bundle no TrueType parser or subsetter.

Each font is bytes or a filesystem path (`str` or `PathLike`). Nested family
mappings accept `"normal"` and `"bold"`; a missing weight uses the available
face without synthetic bold. Match `theme["font"]` to the registered families.
CSS family lists are tried first, then `fallback`, with each grapheme cluster
kept in one face. Simple accents use an NFC precomposed glyph with the
original sequence preserved for extraction; sequences needing mark positioning
are refused. The same resolver measures and draws: exact horizontal
advances, no kerning, Unicode copy/search maps (including supplementary
characters), and deterministic per-document subsets with composite dependencies.
OS/2 embedding restrictions are enforced, including whole embedding when
subsetting is forbidden. Python checks the 64-face and 32 MiB per-font limits
before transport, checks byte inputs before reading paths, and bounds path reads
to 32 MiB plus one byte. Bytes then cross the embedded-V8 boundary as base64;
this transport adds temporary copies. Input font checksums are intentionally
unchecked because real fonts often have incorrect checksums; generated subsets
receive fresh checksums.

Missing coverage throws an actionable error; `missing_glyph="?"` explicitly
replaces an uncovered grapheme cluster with one covered standalone scalar.
Embedded text admits Latin, Greek, Cyrillic, Armenian, Georgian, Han, hiragana,
katakana, precomposed Hangul syllables, and selected Common/Inherited symbols,
punctuation, digits, and composable accents, subject to Script_Extensions checks.
See [the exact allowlist](../docs/architecture.md). Other scripts, unassigned and
private-use characters, controls, and default-ignorable characters are refused
with their code point before coverage or replacement. Static TrueType
`glyf` outlines are supported; CFF, WOFF, collections, variable fonts, joiners,
and variation sequences are refused. Emoji modifier, flag, tag, and ZWJ sequences
are refused before fallback or replacement. These font options apply only to PDF.
Clusters use `Intl.Segmenter` when available (verified in MiniRacer 0.14.1).
Without it, conservative grouping joins combining marks, Grapheme_Extend
characters (including halfwidth kana voiced marks), emoji modifiers, and ZWJ
continuations; unsupported clusters still fail. Fallback keeps each cluster in
one face, and replacement emits one scalar for the whole uncovered cluster.
Unusually tall fallback fonts may need extra margins; layout currently measures
width only, and code-point cuts in shortened labels may split grapheme clusters.
Dark themes need a background color in PDFs, whose viewers show transparent
pages as white. Optional shipped fonts are still open work.

`to_pdf()` and `save("chart.pdf")` automatically produce tagged PDFs with
either standard or embedded fonts. One Figure contains the whole chart,
including facets and subplots; its alternative text combines the title and
the engine's generated chart summary. Backgrounds and grid lines are artifacts,
and the document language comes from `locale` when supplied. Text labels stay
inside the Figure; PDF/UA conformance is not claimed.

## Live notebook charts

`chart.widget()` returns a chart that Python keeps updating after it is
displayed, and that reports zooming, brushing, hovering, and clicks back to
Python. It runs on [anywidget](https://anywidget.dev), so it works in
JupyterLab, Jupyter Notebook 7, VS Code, and Colab; install the `notebook`
extra (`pip install 'herceg[notebook]'`).

```python
live = hg.Chart(df, title="CPU", zoom=True, brush="x").line(x="time", y="cpu").widget()
live                                     # display it

live.append(new_rows, max_rows=10_000)   # stream rows, keeping the last 10,000
live.replace(today)                      # replace every row
live.update(title="CPU, today", theme="dark")
live.viewport = (start, end)             # zoom x (y fits its data); None resets every axis
live.viewport = hg.Viewport(x=(start, end), y=(0, 100))
live.selection = (start, end)            # brush an x range; None clears it
live.selection = hg.Selection(x=(start, end), y=(50, 100))
```

`append` and `replace` take a table like the chart's data, or for `append`
one row as a mapping of column names to values. The rows need every column
the chart reads, with the same kinds of values (missing values fit any
kind); other columns are ignored. Only the new rows travel, as binary
buffers over the widget's connection, and the chart redraws once on the next
frame. `max_rows` keeps a rolling window: the oldest rows are dropped. For a
mark that reads its own data, pass that object: `live.append(rows,
data=events)`. `update` takes the options of `hg.Chart` except data and
facets; `None` restores an option's default.

Interaction comes back as properties and callbacks:

```python
live.selection                           # an hg.Selection, or None
live.viewport                            # an hg.Viewport: x, y, y_right, each None when not zoomed

live.on_select(lambda selection: print(selection))
live.on_viewport(lambda viewport: print(viewport.x, viewport.y))
live.on_hover(lambda inspection: print(inspection))   # None when the pointer leaves
live.on_click(lambda inspection: print(df.iloc[inspection.points[0].row]))
live.on_click(callback, remove=True)     # stop calling it
live.on_camera(lambda camera: print(camera.azimuth, camera.elevation))  # a 3D chart turned
```

An `hg.Viewport` holds the visible `x` range and the ranges of the left and
right y axes, `y` and `y_right`, each None when that axis is not zoomed. An
`hg.Selection` holds the brushed `x` and `y` ranges (None along an axis the
brush leaves alone; a lasso's extent) and a `lasso`'s outline as `(x, y)`
points. Assigning either replaces the whole state: an `(start, end)` pair is
an x range, so `live.viewport = (start, end)` also resets y. Values are
Python values: datetimes on time axes (naive, in UTC, like the datetimes
herceg reads), category labels for ranges on category axes (a lasso's points
there are band positions, the first category at 0, of the categories it
was first drawn over, and the lasso goes when new data moves them), and
numbers otherwise.
In subplots whose y axes differ, y values are read on the first panel's.

An `hg.Inspection` is what the tooltip shows: the inspected `axis` (`"y"`
for horizontal bars), the snapped `value` there and its axis `label`, the
facet `panel`, and `points`, one `hg.InspectedPoint` per series with its
`label`, `value`, and tooltip `text`, and where it comes from: `row`, the
point's row in its mark's data as the chart holds it (`df.iloc[row]` of the
dataframe given), `mark`, the mark's index in the order marks were added,
`mark_id`, its `id`, and `key`, which identifies its series. A point that is
no one row has `row` None: histogram bins, box plot and violin groups, pie
slices, funnel stages, tree nodes, and network and Sankey nodes and links
summarize rows. The rows of a derived table (`hg.derive`) are the derived
table's, and a choropleth joined with `geojson=` has a row per feature. A 3D
chart's inspection also has `values`, the point's (or grid point's) columns
by name (datetimes as epoch milliseconds). `on_camera` receives an
`hg.Camera`, at most every 100 ms while a chart is dragged.

Selection and viewport callbacks also run when Python sets them. Hover,
zoom, and selection reach Python at most every 100 ms, always ending with
the latest; hover and click are only sent while a callback listens.
Earlier versions returned the x range itself where `.x` now holds it, and
named a point's `label` `series`.

A widget displayed in several cells is one chart: updates and brushing reach
every output. A browser that opens the notebook later, or reloads it, draws
the current data.

### Selected rows

`row_selection=hg.SelectionBinding("focus")` binds a chart to a channel of a
selection of its data's rows: its brushes, lassos, and clicks select rows
there (Shift adds, Ctrl or Cmd adds or removes, a click off the data
clears; Space selects the point under the keyboard cursor), and the chart
dims the rows the channel does not hold. A brush selects the rows whose
values are in its ranges, as a condition rows streamed in later meet too; a
click on a histogram bin selects the rows it counts, on a box plot the
group's. `events=["click"]` chooses the gestures that select (`[]` for a
chart that only shows what others select), `effect="none"` selects without
dimming, `data=` names the table (by default the chart's data), and
`fields=["kind"]` sends columns the marks do not read, for conditions set
from Python to test (a widget refuses a condition on a column it does not
send); a list binds several tables, one binding each.

```python
live = (
    hg.Chart(trips, brush="xy", row_selection=hg.SelectionBinding("focus"))
    .point(x="distance", y="fare")
    .widget()
)
live.on_row_selection(lambda picked: print(picked.rows, picked.condition))
live.row_selection                       # an hg.RowSelection
live.row_selection = [3, 8]              # select rows by position (or a boolean mask)
live.row_selection = hg.col("fare") > 20 # or a condition; None clears
```

An `hg.RowSelection` holds the `channel`, the `data` it selects rows of, and
either `rows`, the selected rows' positions in the data as the chart holds
it now (`trips.iloc[picked.rows]`, after rows `append` with `max_rows`
dropped), or a brush's `condition`, an `hg.Expr`; both are None when
nothing is selected. The browser numbers rows as Python does, so rows
selected before an `append` or a drop still name the same records, and rows
selected before a `replace` are gone. Setting `live.selection` draws a brush
without selecting rows; set `row_selection` for that. Every output of a widget shows one
row selection. Static output (HTML, a cell's value) highlights in the
browser and reports nothing.

## Streamlit

`herceg.streamlit.chart(chart)` shows a chart in a
[Streamlit](https://streamlit.io) app (Streamlit 1.51 or newer;
`pip install 'herceg[streamlit]'`) and returns what the user did with it:

```python
import herceg as hg
import herceg.streamlit as hst

chart = hg.Chart(df, brush="x").line(x="time", y="latency")
state = hst.chart(chart, key="latency", on_select="rerun", on_click="rerun")

if state.selection and state.selection.x:
    start, end = state.selection.x
    st.dataframe(df[df["time"].between(start, end)])
if state.click:
    st.write(state.click.label, state.click.points)
```

`on_select` (brushing, in charts with `brush=`), `on_click` (clicking
data), and `on_row_selection` (selecting rows, in charts with one
`row_selection` binding; `state.row_selection` is an `hg.RowSelection`, of
this run's data only; runs that change how the chart looks but not its
data keep clicked and lassoed rows, and a brush's rows while the brush can
be kept) take `"ignore"`, the default, which keeps them in the browser;
`"rerun"`, which reruns the script so that its `chart(...)` call returns
them; or a function, called before the rerun as Streamlit widget callbacks
are. `state.selection` is an `hg.Selection`, as live notebook charts report
it, and stays until the user changes it. `state.click` is an `hg.Inspection` in the run a click
caused, and None otherwise. Inside `st.form`, a selection reaches the script
when the form is submitted, and `on_click` cannot react, since Streamlit
sends no clicks from forms. Give a chart a `key` to keep its selection when
its data changes, and to show several charts with the same content.

The chart is a Streamlit custom component (components v2): it renders in the
app's page, in a shadow root rather than an iframe, and its spec and column
buffers travel as one binary payload. A rerun that sends the same chart
leaves it as it is, zoom and brush included; changed data or options remount
the chart in the same container, restoring its zoom and brush where the
brushed values or category labels still are. Points with `animation_key`
show at once on remount; keyed replacements animate in notebook widgets and
JavaScript apps. Charts without a theme follow the app's light or dark
theme, also when it changes. [examples/streamlit_app.py](examples/streamlit_app.py)
is a complete app.

## Development

From the repository root:

```sh
npm run build:python   # bundle herceg's JavaScript into python/src/herceg/static
npm run test:python    # build, then run pytest in a uv environment
```

## Limits

- Static output (a chart displayed as a cell's value, HTML files) neither
  updates nor talks back to Python; use `chart.widget()` for that.
- Live charts need a running kernel. Where widgets are not rendered (GitHub,
  nbviewer, notebooks saved without widget state) they show nothing; display
  the chart itself for a static copy.
- `sync` does not link separate widgets, since each loads its own copy of
  the engine, and nor does a row selection's channel. Link them from Python
  instead:
  `a.on_viewport(lambda view: setattr(b, "viewport", dataclasses.replace(b.viewport, x=view.x)))`,
  `a.on_row_selection(lambda picked: setattr(b, "row_selection", picked))`
  (for charts of the same data; `b`'s binding names in `fields=` the
  columns `a`'s brushes test that `b` does not draw). Row selections of a derived table's rows
  stay in the browser: live charts refuse to bind one.
- Python keeps the live chart's current data, so a browser that connects
  later can draw it, and `append` copies the table's columns on each call
  (about 0.35 ms for 100 rows into a million-row, three-column window on an
  Apple M6).
- Each widget sends the engine (about 146 KiB, 53 KiB gzipped) to the browser
  once. Live charts were tested in JupyterLab 4; Notebook 7, VS Code, and
  Colab support anywidget but have not been tested here.
- A point's `row` is its position in the data the browser drew when it
  reported the point. In a chart streaming with `max_rows`, rows dropped
  before the callback runs renumber the rest, so by then the row may name
  another record.
- Live charts report one viewport and selection, so `chart.widget()` refuses
  charts whose panels have x scales of their own (`resolve_x`); display them
  statically. Charts whose panels have y scales of their own (`resolve_y`,
  subplots) take no y viewport, and those with right y scales of their own
  (`resolve_y_right`) no right one.
  In Streamlit they show (each panel keeping its zoom across reruns) and
  report clicks, but `on_select` is refused.
- In Streamlit, a chart that changes between script runs is sent whole: its
  data and, since the component's code travels inline with it, the engine
  (about 143 KiB, 52 KiB gzipped). Streamlit sends unchanged charts as a
  reference to what the browser already has. Hover and zoom are not
  reported to the script, since each report would rerun it.
