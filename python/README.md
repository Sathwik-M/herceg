# herceg for Python

Charts for pandas, Polars, PyArrow, and NumPy data, rendered by the
[herceg](https://github.com/op55-org/herceg/blob/main/README.md) engine: the same charts, tooltips, zooming, and
large-data handling as the TypeScript library.

> Early development. Line, area, bar, scatter, heatmap, dendrogram, error bar,
> candlestick, histogram, pie, box plot, letter-value (boxen) plot, violin, treemap, sunburst, gauge, funnel, radar, Sankey, network (graph), and map (choropleth and point) marks, rule, region, and text annotations; small multiples;
> HTML, notebook, SVG, PNG, and PDF output; live notebook charts; Streamlit apps.

```python
import herceg as hg

hg.line(df, x="time", y=["p50", "p99"], title="Request latency")
```

## From matplotlib

Herceg takes tables and field names. Start with `data = {"x": xs, "y": ys}`;
compose marks with `hg.Chart(data)`. Option names have one spelling; common
matplotlib names in unknown-option errors suggest the options that callable takes.

| matplotlib | Herceg |
| --- | --- |
| `ax.plot(xs, ys)` | `hg.line(data, x="x", y="y")`, or `chart.line("x", "y")` |
| `ax.scatter(xs, ys)` | `hg.scatter(data, x="x", y="y")`, or `chart.point("x", "y")` |
| `ax.bar(categories, heights)` | `hg.bar(data, x="category", y="height")` with those columns |
| `ax.fill_between(xs, low, high)` | `chart.area(x="x", y1="low", y2="high")` with those columns |
| `ax.axhline(value)` / `ax.axvline(value)` | `chart.rule(y=value)` / `chart.rule(x=value)` |
| `ax.text(x, y, text)` / `ax.annotate(text, (x, y))` | `chart.text(x=x, y=y, label=text)`; `dx`/`dy` offset text in pixels |
| `plt.subplots(...)` | `hg.Chart(data, panels=["a", "b"], panel_columns=2)`; marks name `panel="a"` or `"b"` |
| `ax.twinx()` | `hg.Chart(data, y_right=hg.Axis(...))`; supported marks use `axis="right"` |
| `ax.legend()` | `legend=True` on the chart (automatic for multiple series); `label` names a single series |
| `fig.savefig(path)` | `chart.save(path)` for HTML, SVG, PNG, or PDF |
| `linewidth` / `lw` | `stroke_width` on lines, rules, and other outlined marks |
| `linestyle` / `ls` | `dash` on 2D lines and rules |
| `marker`, `markersize` / `ms` | Points use `symbol` and `radius` (CSS pixels; matplotlib's `markersize` is a diameter in points); `size` names a column for area encoding |
| `color` / `c`, `edgecolor`, `facecolor` | Lines use `stroke`; bars use `fill`; points use `fill` for a constant or `color` for a column, plus `stroke` for outlines |
| `alpha` | `fill_opacity` on marks that take it; no line opacity option |
| `cmap`, `vmin` / `vmax` | `colors="viridis"` and `color_domain=(low, high)` on color-scaled marks |
| `bins`, `density=True` | `hg.histogram(data, x="y", bins=20, normalize="density")` |
| `ax.set_xlim(...)` / `ax.set_ylim(...)` | `hg.Chart(data, x=hg.Axis(domain=(low, high)), y=hg.Axis(domain=(low, high)))`; helpers use `x_axis` / `y_axis` |
| `zorder` | Marks draw in the order given; add marks in the desired order |

`dash` accepts `"-"` (solid), `"--"` (dashed), `":"` (dotted), and `"-."`
(dashdot). Their [matplotlib default patterns](https://matplotlib.org/stable/users/explain/customizing.html)
are `[]`, `[3.7, 1.6]`, `[1, 1.65]`, and `[6.4, 1.6, 1, 1.6]`, each
multiplied by the resolved stroke width. A numeric array such as `[6, 4]`
uses CSS pixels without scaling. Specs keep the string, so theme widths
apply when drawing; `herceg.express.pointplot` uses the same patterns for
its line styles.

There is no pyplot state, combined plot format string (`"ro--"`), line
marker option (compose `.line(...)` and `.point(...)`), arbitrary `zorder`,
annotation arrows, secondary x axis (`twiny`), or matplotlib's full artist
and coordinate-transform API. Marker symbols and color schemes use
Herceg's `hg.SYMBOLS` and `hg.SCHEMES`, not matplotlib's complete catalogs.

## Charts

One call makes a chart of one kind:

```python
hg.line(df, x="time", y="latency", series="service")
hg.line(casts, x="temperature", y="depth", orient="y")  # along y: a depth profile
hg.area(df, x="time", y=["user", "system"], stack=True)
hg.area(responses, x="minute", y="count", series="status", stack=True)  # long format
hg.area(cpu, x="time", y="load", series="host", stack=True, stack_gaps="interpolate")
hg.bar(sales, x="region", y=["q1", "q2"])
hg.bar(sales, x="q1", y="region")  # a category y gives horizontal bars
hg.bar(sales, x="region", y="q1", labels=True)  # values at the bar ends
hg.Chart(stats).bar(x="group", y="mean").error_bar(x="group", y="mean", y_error="se")
hg.scatter(cars, x="weight", y="mpg", series="origin", radius=3)
hg.scatter(countries, x="gdp", y="life", size="population", series="continent")  # bubbles
hg.scatter(stations, x="lon", y="lat", color="anomaly", colors="rdbu", color_midpoint=0)
hg.scatter(cars, x="weight", y="mpg", symbol="origin")  # a shape per origin
hg.scatter(requests, x="region", y="latency")  # a category x places points in its bands
hg.scatter(tips, x="day", y="tip", swarm=True)  # a beeswarm: packed without overlap
hg.heatmap(load, x="hour", y="host", color="cpu", colors="viridis")  # hours along a time axis
hg.heatmap(load, x="hour", y="host", color="cpu", x_banded=True)  # a column per distinct hour
hg.heatmap(commits, date="day", color="count", calendar="months")  # a calendar
hg.heatmap(events, date="day", color="count", reduce="sum")  # a day's rows summed in its cell
hg.heatmap(color=grid, x=xs, y=ys)  # a 2D array: row i, column j at y[i], x[j]
hg.contour(field, x="x", y="y", color="density", variant="bands", colors="viridis")
hg.contour(color=grid, x=xs, y=ys, thresholds=[0.1, 0.5, 0.9])  # lines of a 2D array
hg.candlestick(prices, x="day", open="open", high="high", low="low", close="close")
hg.candlestick(prices, "day", "open", "high", "low", "close", variant="ohlc")  # OHLC bars
hg.histogram(requests, x="latency", series="region", bins={"step": 10})
hg.histogram(requests, x="latency", series="region", stack="fill", element="step")
hg.histogram(penguins, x="flipper", y="mass", bins={"x": 30, "y": 20})  # a 2D histogram
hg.pie(sales, "region", "revenue", inner_radius=0.6)  # a donut; counts rows without a value
hg.boxplot(requests, x="region", y="latency", series="version")
hg.boxen(requests, x="region", y="latency")  # letter values: nested boxes out to the tails
hg.violin(requests, x="region", y="latency")  # kernel densities, quartiles inside
hg.treemap(sales, ["region", "country"], "revenue")
hg.sunburst(org, node="team", parent="parent_team", value="cost")
hg.gauge(metrics, "cpu", bands=[70, 90, (100, "#e0464f")])  # the last value on a dial
hg.funnel(signups, "stage", "users")
hg.radar(scores, "skill", "score", series="player")  # a spoke per skill
hg.radar(players, fields=["speed", "power", "range"], series="name")  # a polygon per row
hg.sankey(energy, "source", "target", "twh")  # flows between nodes; counts rows without a value
hg.graph(talks, "from", "to", nodes=people, node="name", color="team")  # a network
hg.choropleth(countries_gdf, "gdp", label_field="name", projection="equal-earth")  # a map
hg.choropleth(rates, "rate", geojson=counties, locations="fips")  # values joined to shapes
hg.scatter_geo(cities, "lon", "lat", size="population", label_field="city")  # bubbles on a map
hg.scatter_3d(iris, x="sepal_length", y="sepal_width", z="petal_length", series="species")
hg.line_3d(flights, x="east", y="north", z="altitude", series="flight")  # a path per flight
hg.surface(terrain, x="east", y="north", z="height")  # a grid of rows
hg.surface(z=heights, x=eastings, y=northings)  # a 2D array: row i, column j at y[i], x[j]
```

3D charts draw `.point_3d(...)` points, `.line_3d(...)` lines (each `series`
category's rows, in order, one path, broken where a row has no value), and
`.surface(...)` surfaces in one box (they share a chart with each other
only), seen from `camera=hg.Camera(azimuth=-60,
elevation=25, zoom=1, perspective=False)` (or a dict of those) and turned by
dragging (`rotate=False` stops that), the wheel with `zoom=True`, the
keyboard, and buttons in the chart's corner. `z=hg.Axis(...)` sets the
vertical axis, `box_aspect=(2, 2, 1)` the box's proportions. A surface from a
matrix travels as a matrix (`hg.matrix`), its coordinates once each; rows
not on a grid must be binned or aggregated first. In the browser, large standalone 3D charts
(20,000 points, 10,000 surface cells, or 20,000 line segments) are drawn
with WebGL2 and depth-tested, up to 1,048,576 grid points a surface; static
SVG, PNG, and PDF draw on the CPU, back to front, at most 250,000, and show
the starting camera.

3D layers also draw beside other charts in subplots:

```python
chart = (hg.Chart(data, panels=["trend", hg.Panel("cloud", title="Cloud", camera={"azimuth": 30}),
                               hg.Panel("path", title="Path", camera={"azimuth": 90})],
                  panel_columns=3, zoom=True)
         .line("time", "value", panel="trend")
         .point_3d("x", "y", "z", panel="cloud")
         .line_3d("x", "y", "z", panel="path"))
```

`.surface(..., panel="fit")` works the same way, and multiple 3D layers
naming one panel share its box. `hg.Panel(camera=...)` overrides the chart
camera (a dict overrides only its given fields; `hg.Camera` gives a full
camera). Subplots use CPU geometry for SVG, Canvas, PDF, and PNG; WebGL
points, lines, and surfaces remain available for standalone charts.
Surface panels keep the CPU limit of 250,000 grid points. Each panel caches
its latest geometry and Canvas image, so turning one does not project or
trace unchanged neighbors. Each has its own toolbar and keyboard turning,
and the description names each panel. 3D facets are refused: use subplot
marks instead.

Maps, trees, and networks take the shared interaction options. `zoom=True`
or `zoom="xy"` pans and zooms maps and networks with the wheel, dragging,
Shift+arrows, plus/minus, double-click or 0 to reset, and a toolbar. A map's
`viewport` uses its projection's plane; a network's uses layout coordinates,
with y increasing downwards. Nodes keep their pixel radii while zooming.
`brush="lasso"` selects map regions and points or network node centers.
For networks, bind `row_selection` to the nodes table: all rows naming a
lassoed node are selected; inferred nodes without node rows select none.
Unselected nodes and links dim; links stay bright when both endpoints are
selected. Lasso writes no link rows. With lasso and zoom, plain drag lassos
and Shift-drag pans; the Lasso toolbar toggle switches plain drags back.

`zoom=True` drills into treemaps and sunbursts (click or Enter, Backspace and
breadcrumbs to go back). `drag=True` moves network nodes without running
the layout again, also while zoomed. Shift+arrows moves the node read when
zoom is off; Alt+Shift+arrows does so when zoom is on, leaving Shift+arrows
and 0 for the view. The toolbar restores moved nodes. Widgets keep
`item_positions` in layout coordinates, including positions outside the
current view. `.graph(..., directed=True)` draws arrows from source to
target, and `link_label_field="kind"` writes names along links with room.

```python
hg.Chart(countries, zoom=True, brush="lasso", row_selection=hg.SelectionBinding("picked")).geoshape(color="gdp")
hg.Chart(sales, zoom=True).treemap(path=["region", "country"], value="revenue")
hg.Chart(talks, zoom=True, drag=True).graph("from", "to", directed=True, link_label_field="kind")
```

Maps and networks draw in facets and panels too, and every tree, map, and
network navigates there as alone. A map's layers each split their rows by
the facet column, unless `facet="repeat"` draws one whole in every panel (a
base map), and every panel is fitted to the rows of all of them; in panels,
the layers naming a `panel` are its map. A network's facet panels share one
layout of the whole network, each drawing its rows' links and the nodes
they join. Facet panels share one drill root, one view, and one set of
moved nodes, so zooming one zooms them all; each panel's tree, map, or
network has its own.

```python
(
    hg.Chart(stores, facet="year", zoom=True)
    .geoshape(data=countries, facet="repeat")      # the same base map in every panel
    .geopoint("lon", "lat", size="sales")          # each year's stores
)
(
    hg.Chart(budget, panels=["cost", "staff"], panel_columns=2, zoom=True)
    .treemap(["unit", "team"], "cost", panel="cost")
    .treemap(["unit", "team"], "staff", panel="staff")
)
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
and SVG, Canvas, static SVG, and PDF output.

Heatmaps over number and time columns place their cells along number and
time axes, which zoom and pan: each cell reaches halfway to the values
beside it, or with `x_step` / `y_step` (milliseconds for times) is that wide
around its value, leaving gaps where values are missing. `x_banded=True` /
`y_banded=True` give one column (or row) per distinct value instead, as
category columns have. `date=` lays the days of a time column out as a
calendar in the chart's `time_zone`: `calendar="weeks"` (the default) a
column per week along a time axis and a row per day of the week from
`week_start` (`"mon"` by default), `calendar="months"` a row per month and
a column per day of the month.

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
    hg.Chart(df, title="Request latency", y=hg.Axis(title="ms"), zoom=True)
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
(`hg.Axis(type="log", domain=(0, 100), title="ms", ...)` or a dict),
`y_right` (the axis for marks added with `axis="right"`, in every panel
that draws them), `facet` and
`facet_columns` (a panel per value of a category column, wrapped into rows),
or `facet_row` and `facet_column` (a grid with a row per value of one category
column and a column per value of another; either may be left out), with
`resolve_x`, `resolve_y`, and `resolve_y_right` (`"shared"`,
`"independent"`, `"rows"`, or `"columns"`) choosing which panels share an x,
a y, or a right y scale (facets share them by default, subplots x; the right
y as `resolve_y` unless given; on a category axis, panels that do not share
it show only the categories their rows hold); histograms, box plots, and
violins summarize each panel's rows (histograms in bins chosen from the rows
of the panels sharing an x scale); annotations over a table draw each row in
its own row's panel; marks with `facet="repeat"` draw all their rows in every
panel, which dendrograms need; pies, treemaps, sunbursts, gauges, funnels,
radars, Sankey diagrams, maps (a map's layers together), and networks draw
each facet panel's rows in it, as a faceted chart's only mark, or fill a
panel of their own with `panel=` (no `"*"`, and no other mark there), whose
neighbors keep their axes; `panels` (ids or
`hg.Panel("latency", title="Latency", x=hg.Axis(title="Time"),
y=hg.Axis(title="ms"), y_right=hg.Axis(title="requests"))`), `panel_columns`, and
`panel_row_heights` and `panel_column_widths` (relative heights of the rows
and widths of the columns) for subplots, whose marks
name their panel with `panel="latency"` (or `"*"` for all),
`legend`, `tooltip` (`True`, `False`, `"nearest-x"`, `"nearest-y"`, `"nearest"`, or
`hg.Tooltip(mode=..., axis_labels=True)`, which also labels the crosshair on
the axes; tooltip fields, below, are marks'), `zoom`
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
default. At run time, a helper (or an express function) refuses an option it
does not take by its own name, with the closest it does take, including
other libraries' names for herceg's: `hg.line(df, x="time", y="p99",
color="host")` raises `TypeError: line: no option 'color'; did you mean
'series' or 'stroke'?`.

Tooltips show the position and each series' value, written as the axis'
`format` writes it; `hg.Axis(tooltip_format=...)` writes tooltips' (and the
keyboard's and crosshair labels') values without changing tick labels.
Marks whose points are rows (lines, areas, bars, points, rugs, error bars,
candlesticks, heatmaps, map regions and points, 3D points and lines) show
more of the row with `tooltip=hg.Tooltip(fields=[...])`: column names, or
`hg.TooltipField(column, label=..., format=...)` with Intl format options
as `Axis.format` takes them. A helper's `tooltip` is its chart's and its
fields its one mark's; in `hg.Chart`, give them to the mark:

```python
hg.line(
    daily,
    x="time",
    y="p99",
    locale="en-US",
    tooltip=hg.Tooltip(fields=[hg.TooltipField("requests", label="Requests")]),
    x_axis=hg.Axis(tooltip_format={"weekday": "short", "month": "short", "day": "numeric"}),
    y_axis=hg.Axis(title="ms", tooltip_format={"style": "unit", "unit": "millisecond"}),
)
hg.Chart(daily).line(x="time", y="p99", tooltip=hg.Tooltip(fields=["requests"]))
```

Marks whose points summarize rows (histograms, box plots, pies, trees,
networks) and express charts, which draw tables they compute, refuse
fields. Hover and click events carry them (`InspectedPoint.fields`).

`theme` is `"light"` (the default), `"dark"`, `"high-contrast"`,
`"high-contrast-dark"`, each with a background of its own, `"auto"`
(light or dark to match the surface the chart is drawn on, in HTML output,
with the surface showing through; light in static files), or a dict that
overrides a theme's tokens (`"background": "transparent"` shows what the
chart is drawn on): `extends`, `background`, `text`, `muted`, `grid`, `axis`,
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
`False` disables them. Enabled seams need time-axis breaks. Seams use the theme's resolved grid color and a `[3, 3]` dash.

`navigator=True` adds a range navigator: a strip under the plot drawing the
chart's lines, areas, points, bars, and candlesticks over the whole x axis,
with a window over the x range in view, which dragging and the keyboard move
and resize. `hg.Navigator(height=48, marks=["close"])` sets its height in
pixels and the `id`s of the marks it draws. It works in static output too
(drawn as is) and in live charts, where moving it reports the viewport as
zooming does. With facets or panels, one strip goes under all of them,
draws every panel's marks (each panel's part apart, over that panel's y
scale), and moves the x range they share, so the panels must share x
(`resolve_x="shared"`, the default).
The chart's text alternative, SVG description, and PDF alternative text
describe the navigator's overview of the whole x range, current range in x tooltip
format, and control of every panel's x when there are several. Live charts
refresh this summary at most once a second as the view changes; only the
navigator's sliders announce their changes politely.

Dense bar strips use pixel-column envelopes in live charts and SVG, PDF,
and PNG: each sign keeps the extreme bar's series color (ties use series,
then row order), each placed bar covers every column it intersects, and
stacks keep all segments at the most extreme position per sign. Shorter
bars and their colors can be hidden. Below two nonempty rectangles
intersecting the strip per column, bars are drawn exactly. Missing, zero-area, and wholly clipped bars do not
count toward reduction; missing-heavy sources are scanned once.

```python
hg.line(prices, x="time", y="close", id="close", navigator=hg.Navigator(marks=["close"]))

(
    hg.Chart(prices, panels=["price", "volume"], navigator=hg.Navigator(marks=["close"]))
    .line("time", "close", id="close", panel="price")
    .bar("time", "volume", panel="volume")
)
hg.line(sales, x="week", y="units", facet="region", navigator=True)
```

Mark methods take column names; `series` names a category column that splits
rows into one series per value. A mark can read other data with `data=`.
Points have one `radius` in pixels, or size (`size`, within `radius_range`),
color (`color`), fade (`fill_opacity`), and shape (`symbol`) by column; a
numeric `color` takes `colors`, a scheme name from `hg.SCHEMES` or a list of
hex colors, and a category `color` the theme's palette, a color per value
with a key in the legend; `symbol` takes a shape from `hg.SYMBOLS` or a
category column, by name or as `{"field": column}` (which a column named like
a shape needs). `stroke` and `stroke_width` outline points and
areas, and `fill` gives every box plot or violin one color.
Column names are checked when the mark is added, with the available columns
in the error message.

Marks naming the same `legend_group` share series by name: series of the
same name (a `series` value, or a single mark's `label`) take one color, one
legend entry, and one visibility, so a bar and its error bars hide together.
Side-by-side marks of a group (grouped bars, box plots, violins, dodged
histograms, points, and error bars) take the group's slots, so an error bar
stands on its bar even when one mark lacks some of the group's series.
On a category axis, `dodge=True` places a point, error bar, line, or area
mark's series side by side in each category, as grouped bars are, and
`jitter` (a width from 0 to 1 of the category's band, or
`hg.Jitter(width, seed=...)`) spreads points across it by a hash of each
row, so they keep their places as the chart redraws and streams;
`swarm=True` instead packs them across it without overlap, in order of
value (a beeswarm, laid out again as the chart resizes and zooms, with
points that do not fit at the band's edges):

```python
(
    hg.Chart(stats)
    .bar(x="day", y="mean", series="sex", legend_group="sex")
    .error_bar(x="day", y1="low", y2="high", series="sex", dodge=True, legend_group="sex")
    .line(x="day", y="mean", series="sex", dodge=True, legend_group="sex")
)
hg.scatter(tips, x="day", y="tip", series="sex", dodge=True, jitter=0.5)
```

Lines and areas run along x, through their rows in band order on a
category x, or with `orient="y"` along y, values on x, read by y in
tooltips and the keyboard (a category `y` with values on `x` lays them
along y without it, as bars lie). Several value columns along y need it:
`hg.line(casts, x=["temperature", "salinity"], y="depth", orient="y")`.
Areas along y fill across x to zero, stack along x, or fill the band
between `x1` and `x2` (`hg.Chart(casts).area(y="depth", x1="low",
x2="high")`). Lines and areas along y use the left y axis.

Histograms take a number or time column, `x` (vertical) or `y`
(horizontal), or both for a 2D histogram, in both `hg.histogram` and
`Chart.histogram`:

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

`weight` names a number column each row counts as in place of 1; rows
missing a weight, or with a negative one, are not counted. `normalize` is
`"count"` by default, `"frequency"` (count / bin width), `"probability"` (bin
count / series count in bins), `"percent"` (probability × 100), or
`"density"` (probability / bin width). `common_norm=True` also weights each normalized series by its share
of finite observations, before dropping values outside bins. Hidden series
stay in that denominator; count normalization is unchanged. With facets,
bins follow panels sharing the binned axis (`resolve_x` or `resolve_y`), and
normalization is local to each panel. Subplots draw whole marks.

`cumulative=True` accumulates counts, probabilities, or percents through each
bin; density integrates bin widths to give probability mass. The final bar
is 1 (or the series' share with common normalization), or 0 for no counted
values; cumulative frequency gives counts. Accumulation happens before
stacking. `stack=True` stacks series, and `stack="fill"` stacks them as
shares of each bin. `dodge=True` places the visible series side by side with
opaque fills by default, giving hidden series' slots to the others. Dodge
excludes stacks and `element="step"` or `"poly"`, which draw each series as
an area stepping across its bins or running through their centers;
horizontal histograms exclude `axis="right"`.

With `x` and `y` both, cells count the rows whose x and y fall in a bin of
each, colored by `colors` from 0 to the fullest cell (or over
`color_domain`); cells holding nothing are left empty. `bins` takes one bin
definition for both axes, or a dict of them, `{"x": ..., "y": ...}`;
`normalize` measures `"frequency"` and `"density"` per unit of bin area. A
2D histogram counts one distribution: it takes no `series` (facet instead),
stacks, dodges, `cumulative`, or `element`. Counts match NumPy's
`histogram2d`, the last bin along each axis holding its right edge.

```python
hg.Chart(penguins).histogram("flipper", y="mass", bins={"x": 30, "y": [2500, 3500, 6500]},
                             normalize="density", colors="viridis")
```

Contours draw a field sampled on a grid: `Chart.contour(x, y, color)` with
columns of a table whose rows are grid points (every distinct x with every
distinct y), or of an `hg.matrix`, or with a 2D array `color` (as in
`go.Contour(z=...)`) and optional positions `x` and `y`. `variant="lines"`
(the default) draws a line where the field crosses each threshold;
`variant="bands"` fills the regions from each up to the next. `thresholds`
is about how many round values (10 by default), or the values, increasing.
Lines take `stroke` (one color for all) and `stroke_width`, bands
`fill_opacity`; `colors`, `color_domain`, and `color_midpoint` color both
by the field's values. Values are interpolated linearly between grid points
(the bilinear saddle decides cells whose corners alternate); grid points
without a value leave holes, and contours end where the grid does.
Tooltips name the field and a band's range or a line's level; the legend
keys each band.

```python
field = hg.matrix({"x": xs, "y": ys, "density": grid}, x="x", y="y")
hg.Chart(field).contour("x", "y", "density", thresholds=[0.01, 0.05, 0.1], variant="bands")
```

`hg.matrix(columns, x=..., y=...)` makes a matrix data source: the columns
named by `x` and `y` hold its coordinates (one per column and one per row),
and every other column a value at each pair, as a 2D array of shape
(len(y), len(x)) or flattened in that order. It reads as a table of a row
per pair and sends its coordinates once each, rather than once per row.
Heatmaps, surfaces, and other marks draw it too; a live widget's `append`
and `replace` refuse it, since its rows are its coordinates' pairs.

Heatmaps combine the rows sharing a cell into its value with `reduce`:
`"last"` (the default), `"mean"`, `"sum"`, `"min"`, or `"max"`, the same at
every zoom; `sampling={"reduce": "max"}` colors a pixel showing several
cells by the greatest (or `"min"`, or `"mean"`, the default) of their
values. `x1` and `x2` (or `y1` and `y2`) place each row's cell between two
edges, as the bins of `hg.derive(...).bin(..., end=...)` give them.

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
exclude raw values, have no outliers, and reject `whiskers` and `outliers`;
missing or non-finite statistics omit the box. Raw boxes draw values beyond
the whiskers as dots unless `outliers=False`, which leaves them out of the
drawing and the value axis' extent (tooltips still count them). `count` names an optional number column
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
precomputed counts are omitted from tooltips.

Letter-value plots (`hg.boxen`, `Chart.boxen`) draw each group's quartile
box, then boxes out to its eighths, sixteenths, and so on, each level
narrower and lighter than the one inside it, a line at the median, and the
values beyond the outermost boxes as dots (unless `outliers=False`):

```python
hg.boxen(requests, x="region", y="latency", series="version", depth="trustworthy")
hg.Chart(requests).boxen("latency", "region", depth=4, width_method="area", outliers=False)
```

`depth` chooses the levels: "tukey" (the default) leaves 5 to 8 values in
each tail, "proportion" about `outlier_proportion` (0.007) of them,
"trustworthy" stops where a letter value's confidence interval at
`trust_alpha` (0.05) would overlap the next, "full" reaches the extremes,
and a whole number gives the levels (1 is the quartile box alone).
`width_method` narrows each level by half ("exponential", the default), by
equal steps ("linear"), or makes each box's area proportional to its share
of the values ("area"). `fill_opacity` (0.7) is the quartile box's; each
level out is 2^(-1/3) as opaque.

### Dendrograms

`Chart.dendrogram(first, second, height, *, leaves, side=None, data=None,
stroke=None, stroke_width=None, label=None, facet=None, panel=None,
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
With facets, `facet="repeat"` is required.

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
facet=None, panel=None, id=None)` adds one tick per observation of exactly
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
counts and ranges. Facets split rows, `facet="repeat"` repeats them, and
`panel` places rugs in subplots. A y rug refuses `axis="right"`;
`side="right"` places its ticks at the right edge. There is no one-call
`hg.rug` helper.

## Normalized stacks and streamgraphs

```python
hg.area(usage, x="time", y=["user", "system"], stack="fill")
hg.area(usage, x="time", y=["user", "system"], stack="center")
hg.area(usage, x="time", y=["user", "system"], stack="wiggle", stack_order="inside-out")
hg.bar(sales, x="region", y=["q1", "q2"], stack="fill", labels={"style": "percent"})
```

The same options work on `hg.Chart(...).area(...)` and `.bar(...)`. Fill stacks
nonnegative values as shares of each position's visible total, on a 0–1 axis;
use `y={"format": {"style": "percent"}}` (or x for horizontal charts) for percent
ticks. Center uses a symmetric baseline around zero; wiggle uses the
Byron–Wattenberg stream baseline, starting at zero at the first retained
position. Their axes show raw extents; thickness shows the raw value. Center
requires nonnegative thicknesses, whereas d3's silhouette offset accepts signed inputs
algebraically. It does not split positive and negative layers like d3's diverging
offset; use `stack=True` for signed values. Bars refuse stream offsets and suggest using an area. All three modes refuse finite
negative values, including mixed signs; `stack=True` keeps signed stacking.
Missing values retain gaps and count as zero in totals; an all-zero position
has zero thickness. `stack_gaps="interpolate"` on a series-column area resolves
absent rows between finite bracketing rows before normalization or offsets.

Area `stack_order="inside-out"` is available with fill, center, and wiggle;
colors and legend order stay fixed. `orient="y"` areas stack across x, and bars
with a category y are horizontal. Tooltip and keyboard text show share and raw
value for fill, and raw values for streams. Fill bar labels show shares,
formatted by `labels`. Legend toggles recalculate the visible stack; facets,
subplots, HTML, notebooks, and static SVG/PNG/PDF use the same engine semantics.
`herceg.express.histplot(..., multiple="fill")` keeps the same per-bin share
meaning, with raw counts or weights in tooltip text. Express barplot estimates
remain grouped; stream offsets are available through `hg.area` and `Chart.area`.

Finite line rows between gaps draw round dots with diameter `stroke_width`
(or the theme's line width). Areas show them on the upper edge. Step curves,
`orient="y"`, reduced data, and SVG/PNG/PDF exports follow the same rule.
For `hg.bar(df, x="zone", y="gain", series="zone", labels=True)`, each bar
uses its full category band; category colors and legend entries are retained.
Horizontal bars behave the same when `series` names their category y.

`Chart.text`, `Chart.region`, and the bar, funnel, radar, Sankey, and graph
methods and helpers accept `halo=False` to disable text outlines (both node
and link labels for graphs). `hg.Navigator(halo=False)` disables navigator
label outlines. Halos use the background at full opacity at 3:1 text contrast
or higher, falling back to the light/dark choice otherwise. The option is
serialized as `halo` in the portable spec and works in every renderer and
static export. Express charts are ordinary `Chart` objects: annotations
added with `.text(..., halo=False)` use the same option.

Time axes choose coarser intervals for coarse `format` options and drop
remaining duplicate labels. `hg.Axis(tooltip_format=...)` formats tooltip,
keyboard, and crosshair values independently, without changing tick labels.

## Statistical charts

`herceg.express` makes Seaborn's statistical charts in one call. It
computes their statistics with NumPy and returns an ordinary `hg.Chart` of
herceg's marks, so they display, save as HTML, SVG, PNG, and PDF, and run in
notebooks and Streamlit like any other chart:

```python
import numpy as np
import herceg.express as hx

hx.barplot(tips, x="day", y="total_bill", series="sex", estimator=np.median)
hx.lineplot(fmri, x="timepoint", y="signal", series="event", errorbar=("se", 1))
hx.pointplot(fmri, x="timepoint", y="signal", units="subject")  # repeated measures
hx.regplot(tips, x="total_bill", y="tip", order=2, facet_column="smoker")
hx.regplot(titanic, x="age", y="survived", logistic=True)
hx.histplot(penguins, x="flipper_length_mm", series="species", kde=True)
hx.kdeplot(geyser, x="waiting", y="duration", levels=5, thresh=0.1, filled=True)
hx.jointplot(penguins, x="bill_length_mm", y="bill_depth_mm", kind="hist")
hx.swarmplot(tips, x="day", y="total_bill", series="sex", dodge=True)
hx.boxenplot(diamonds, x="clarity", y="carat")
hx.pairplot(penguins, series="species")
hx.clustermap(flights_wide, z_score=1)
```

| Function | Computes (NumPy) | Draws |
| --- | --- | --- |
| `barplot`, `pointplot` | an `estimator` (named, or a function) per category, and an interval | bars, or points joined by lines, with error bars dodged by `series` |
| `lineplot` | the estimate and interval at each distinct x, or a line per unit | lines, with bands (`error_style="band"`) or error bars |
| `regplot` | polynomial (`order`), logistic, robust, log-x, or lowess fits, with bootstrap bands; estimates per x or bin | points (or estimates with error bars), fit lines, bands |
| `residplot` | residuals from a polynomial or robust fit, optionally a lowess line through them | points around a rule at 0 |
| `histplot` | Seaborn's bin edges; heights, and KDE overlays scaled to them | the histogram mark (counts in the browser) as bars, steps, or polygons, lines; cells for x and y |
| `kdeplot` | Gaussian kernel densities (SciPy's `gaussian_kde`), 1D or 2D; Seaborn's contour levels | lines or filled areas, along x or y; contour lines or bands for x and y |
| `ecdfplot` | the empirical distribution | step lines, along x or y |
| `rugplot`, `stripplot`, `swarmplot` | (none; for swarms, which points fit) | rug ticks; points jittered by row and seed, or packed in swarms |
| `boxplot`, `boxenplot`, `violinplot` | quartiles and whiskers, letter values (also in `statistics`) | the box plot, boxen, and violin marks |
| `pairplot`, `jointplot` | bins, densities, fits | subplots: scatter plots, density contours, or 2D histograms, with histograms or densities |
| `clustermap` | hierarchical clustering of rows and columns | a reordered heatmap with dendrograms in side panels |

Arguments are keyword-only after the data, and what express shares with
herceg's charts takes herceg's names: `x`, `y`, `series` (a category
column, or numbers read as categories, splitting the marks' series in one
legend group, so a series' bars and error bars, or line and band, share a
legend entry and hide together), `order` and `series_order` (which levels,
in which order; rows of other levels are left out), `palette` (a list of
colors), and the chart options of the one-call helpers (`title`, `width`,
`height`, `theme`, `x_axis`, ...). Among those options, `facet_row` and
`facet_column` facet the chart, each panel with statistics of its own;
`facet` and `panels` are refused, and `pairplot`, `jointplot`,
`clustermap`, and `residplot` take no facets. Options a mark also takes
mean what they mean there: histplot's `normalize` ("count", "frequency",
"probability", "percent", or "density"), `element` ("bars", "step", or
"poly"), and `common_norm` (off by default); `weight`, a column of numbers
from 0 up weighting each row, in histplot, kdeplot, ecdfplot, regplot
(weighted least squares), and barplot, pointplot, and lineplot (weighted
means, with bootstrap intervals, as Seaborn's `WeightedAggregator`);
boxplot's `whiskers` ("tukey", 1.5 IQR, by default; "range"; or an IQR
multiple) and `outliers`; boxenplot's `depth` ("tukey", "proportion",
"trustworthy", "full", or a number of levels), `outlier_proportion`,
`trust_alpha`, `width_method` ("exponential", "linear", or "area"), and
`outliers`, as the boxen mark takes them; violinplot's `inner` ("box",
"quartiles", or "none"); and
stripplot's `jitter`, the fraction of each category's band (or, with
`dodge`, of each series' slot) the points spread across: `True` is 0.5,
and an `hg.Jitter` brings its own seed. Statistical options keep Seaborn's
names (`estimator`, `errorbar`, `n_boot`, `bw_method`, `bw_adjust`, `ci`,
`multiple`, `linestyles`, `warn_thresh`, ...). Densities and ECDFs of `y`
alone run along y, as do the KDE overlays of horizontal histograms.

A `kdeplot` of `x` and `y` draws the density's contours (bands with
`filled=True`) at Seaborn's levels: `levels` is how many (10) or the
probability masses below each, from `thresh` (0.05) up, each contour
enclosing all but that share of the density. NumPy resolves the levels to
densities, sent as the contour's thresholds, so the browser draws what
Seaborn would. A `histplot` of both counts 2D cells (Seaborn's bins along
each axis, `bins` and `binwidth` per axis as pairs), colored by `colors`;
`jointplot`'s `kind="kde"` and `kind="hist"` draw those in the joint panel
and the marginal densities or histograms beside it.

`pointplot` joins each series' estimates with a line through the categories
in order, broken where the series has no estimate, under its error bars and
points (dodged with them); `linestyles` takes Matplotlib's styles, one for
every line or one per series level ("-", "--", ":", "-.", drawn as dash
patterns), and `linestyle="none"` draws none, as Seaborn 0.13 has it
(`join` is refused). `swarmplot` packs each category's points without
overlap in the browser, at the size the chart is drawn; it warns, as
Seaborn does, when more than `warn_thresh` (5%) of a category's points
cannot be placed, from the same layout run in Python at the chart's `width`
and `height` (640 by 320 pixels when not given) with the plot's margins
estimated, on the value axis its options make (`type`, `domain`, `nice`,
`ticks`, `zero`) and with facets sharing axes as `resolve_x` and
`resolve_y` say, drawing only the points inside the plot, so a chart
drawn larger or smaller than that may fit more or fewer points than the
warning says. Axes are labeled with the columns' names unless `x_axis` or `y_axis`
say otherwise. Rows missing a value the chart uses are left out, and the
chart's description says how many.

Estimates take an `estimator`: "mean", "median", "sum", "min", or "max",
computed for many resamples at once, or a function of a group's values
returning one number (`numpy.median`, a lambda), called once per resample
as Seaborn calls it, and checked on each group (a function returning
several values, or none that is finite, is refused, naming the group).
Intervals take Seaborn's `errorbar`: `("ci", 95)` resamples each group
`n_boot` times (1,000) with `numpy.random.default_rng(seed)` and takes the
percentile interval of the estimates, `("pi", 50)` the central percentiles
of the values, `("se", 1)` (of means) and `("sd", 1)` multiples of the
standard error and deviation (`ddof=1`) about the estimate, a function of
a group's values returning its interval's ends (low first), and `None`
none. Each group's resampling starts from the seed, drawing its indices
as Seaborn's `bootstrap` does, so a seed gives Seaborn's intervals exactly.
The seed is 0 unless given; `seed=None` draws one and records it. Groups of
one value have no interval. `units` names the sampling units of repeated
measures (subjects, say): `("ci", ...)` intervals then resample units and
the rows within each chosen unit, drawing as Seaborn's structured
bootstrap does, in barplot, pointplot, and regplot. In lineplot, as in
Seaborn, `units` draws instead a line per unit through its rows, in its
series' color and legend entry (`estimator=None, errorbar=None`), the
lines broken apart by missing values.

`regplot` fits, per series and panel, a least-squares polynomial of
`order` (rows weighted by `weight`, those of weight 0 left out of the fit), or with `logistic=True` a logistic
regression of outcomes from 0 to 1 (statsmodels' GLM: IRLS from its
starting means and its convergence and perfect-separation tests; a
resample its x separates perfectly has no fit and is left out of the band,
as Seaborn leaves it), with `robust=True` a line downweighting outliers
(statsmodels' RLM: Huber's T, the scale re-estimated by the MAD each
pass), with `logx=True` a line in log x, or with `lowess=True` a locally
weighted line without a band. Logistic and robust fits run in NumPy, every
resample of a chunk iterating together, so statsmodels is not needed (it
is only what they were checked against). `x_estimator` (an estimator) and
`x_bins` (a count, or bin centers; rows go to the nearest) draw an
estimate of y at each distinct x or bin instead of the points, with
intervals per `x_ci` ("ci", at `ci`'s level; "sd"; a level; or None), while
the fit uses every row. `x_partial` and `y_partial` remove the linear
effect of other columns from x and y first (not with `logx` or `logistic`,
whose x or y it would move off their domain); `fit_reg=False` leaves out the
fit, `scatter=False` the points, and `truncate=False` draws each fit over
all the data's x range rather than its own rows'. `x_jitter` and
`y_jitter` are refused: they would move points off the values tooltips
read. `residplot` takes `order`, `robust`, `lowess`, and the partials.
`lmplot` is regplot with `facet_row` and `facet_column`.

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
fit uses (`frac`): about 0.8 s for 10,000 rows with statsmodels' default
`delta=0`, about 10 ms with `delta` 1% of the x range, which interpolates
between fits as statsmodels does. Resampling, densities, and fits work in
chunks of about 8 MiB of arrays (or one resample, when that is larger), so
small groups take little memory and large ones keep their speed: 1,000
resamples of 100,000 values peak at about 3 MiB (Seaborn's about 2 MiB).

### Computing again from new data

An express chart remembers its call: the function, its arguments (copied
when it is made), its seed, the columns it read, and its data (a reference,
not a copy, from which a widget made later starts). `hx.recompute(chart,
data)` makes a new chart as the function would from `data`, with those
arguments and seed, and adds again the marks added to the chart after the
function made it (`.rule(y=0)`), reading the new chart's table where they
read the old one's:

```python
chart = hx.lineplot(signals, x="time", y="value", series="sensor")
chart = hx.recompute(chart, signals_now)   # the same chart of the new rows
```

A recompute groups the new rows and computes every estimate, fit, and
density again, except bootstrap work (intervals and bands) of groups whose
values, weights, units, options, and seed, and for bands their grid, are
the same as in the chart recomputed: a seed makes their results the same,
so they are reused. Appending one timepoint to a lineplot of 1,000
timepoints resamples one group, not 1,000. Results are kept for the groups
the chart has, a few numbers each (a band, two of its grid's length).

In a notebook, `chart.widget()` of an express chart takes the rows of the
function's data: `live.append(rows, max_rows=...)` adds rows to them (a
table like the data, or one row as a mapping), `live.replace(rows)`
replaces them, and the function computes the chart again, keeping
everything `live.update(...)` changed. The widget copies the columns the
function read when it is made, so later changes to the dataframe are not
its own. Where the new chart has the same marks, its changed tables and
options travel in one message and replace the old ones at once, zoom,
selection, and legend as they were; where its marks differ (a new series
level adds a band), the whole chart is sent and each display draws it
again, keeping its zoom, brush, the series hidden through its legend, and
the keyboard focus. Rows selected in the tables replaced go. `data=` is
refused: the marks draw tables computed from the function's data. Live
widgets refuse pair, joint, and cluster maps, whose panels have x scales
of their own.

A Streamlit rerun calls the function again: the same data with the same
seed makes the same chart, which Streamlit leaves as it is (zoom and brush
included); new data remounts the chart where it was, restoring its zoom
and brush. To reuse groups' bootstrap results across reruns, keep the
chart in `st.session_state` and refresh it with `hx.recompute`.

Differences from Seaborn: Seaborn's `hue`, `hue_order`, `row`, and `col`
are `series`, `series_order`, `facet_row`, and `facet_column`; `stat` is
`normalize` (its "proportion" is "probability"); `weights` is `weight`
everywhere; boxplot's `whis` and `showfliers`, and boxenplot's `k_depth`,
`outlier_prop`, and `showfliers`, are `whiskers`, `outliers`, `depth`,
`outlier_proportion`, and `outliers`; kdeplot's `fill` is `filled`;
`kde_kws`, `err_style`, and `gridsize` are `kde_options`, `error_style`,
and `grid_size`; swarm plots' `size` (points) is `radius` (pixels); strip
plots' `jitter` is a fraction of the band, not
Seaborn's half-width in category spacing, and `common_norm` is off unless
asked for (pair plots' diagonal densities each integrate to 1). The seed
is 0 unless given (Seaborn draws one each call); estimators named by
string are "mean", "median", "sum", "min", and "max" only (not every pandas
aggregation), and functions and interval functions receive NumPy arrays,
not pandas Series; `("se", k)` takes the mean only (the standard error is
the mean's), weights take the mean and `("ci", ...)` only (as Seaborn's),
and weights and units together are refused (Seaborn ignores units with
weights); regplot takes `weight` (Seaborn's does not), computes logistic and
robust fits without statsmodels, refuses `x_jitter` and `y_jitter`, and with
`truncate=False` reaches the data's x range, not the axes' limits;
boxenplot shades levels by fill opacity, not a palette lightened per level.
`pointplot` dodges with grouped bars' arithmetic, each series in its share
of the category, not Seaborn's 0.025 of the category per series level, and
takes no `markers`; swarms leave half a pixel between points where Seaborn's
candidate places stand 5% farther out, so they pack about as tightly but
not point for point alike; `violinplot` uses herceg's violin mark, each violin as
wide as the others at its densest, with Silverman's rule (R's,
0.9 min(sd, IQR/1.34) n^-1/5) per violin or one `bandwidth` for all, not
SciPy's Scott factor, and takes `split=True` (a series of at most two
levels, as halves) and `inner="box"`, `"quartiles"`, or `"none"`, but not
`"stick"` or `"point"`; `histplot` draws densities over layered series only
(not stacked, filled, or dodged ones), its bivariate histograms take no
`series`, `thresh`, `pthresh`, `pmax`, or `cbar`, and its steps and
polygons are always filled (Seaborn's `fill=False` outlines have no
counterpart); bivariate `kdeplot`s take no `series`, and with facets
resolve their levels over every panel's density together (Seaborn resolves
each facet's own), so a contour is the same density in each panel;
`jointplot` takes `kind="scatter"`, `"reg"`, `"kde"`, or `"hist"`, but
not `"hex"`, and kde and hist kinds no `series`; `pairplot` gives the diagonal's histograms and densities y scales of
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
    .bin("time", bins={"step": 3_600_000}, name="hour")
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
hg.save(chart, "chart.png", scale=3)  # the same format dispatch as chart.save
chart.to_spec()            # (spec dict, list of binary buffers)
chart.widget()             # a live notebook chart (see below)
```

HTML output and notebook display embed the herceg bundle (about 142 KiB,
52 KiB gzipped), so they work offline. Notebooks show each chart in an
isolated iframe.

`hg.to_pdf(chart_or_charts, **settings)` returns PDF bytes, and
`hg.save(chart_or_charts, path, **settings)` saves one chart using
`Chart.save(path)`, choosing HTML, SVG, PNG, or PDF by extension. A nonempty
sequence requires a `.pdf` path; use `hg.save` on each chart for other
formats. Both functions accept charts from `herceg.express`:

```python
charts = [latency, throughput, errors]
pdf_bytes = hg.to_pdf(
    charts, page_size="A4", orientation="landscape", margin=36,
    title="Performance report", subject="Service performance", language="en-GB",
)
hg.save(charts, "report.pdf", page_size="A4", title="Performance report")
hg.save(latency, "latency.pdf", page_size="Letter")
chart.save("page.pdf", page_size="Letter", margin=36, title="Report")
```

Each chart is read during export and occupies one page. Use subplots and
panel titles for several views with captions on one page. Without `page_size`,
pages keep each chart's dimensions at 0.75 points per CSS pixel, with zero
margin by default; a supplied margin adds space around the chart. `"A4"` and
`"Letter"` default to portrait and a 36-point margin.
`orientation="landscape"` needs a named paper size. Margins are uniform PDF
points (72 per inch). Named paper sizes scale charts up or down uniformly to
fit and center them within those margins, clipping each complete chart to
its rectangle and keeping its plot clips. Vector marks and selectable text
are retained. A fitting scale that rounds to zero is refused; reduce chart
dimensions or margins.

`Chart.to_pdf()` and `Chart.save()` keep their single-chart behavior and
accept the same paper, margin, font, and metadata options for PDF. Export
`title` and `subject` affect metadata; each chart keeps its visible title and
alternative text. For one chart, including a one-item sequence, title,
subject, and language default to its title, description, and locale. For
multiple charts, the default language is `"en"`, with no default title or
subject. Each chart's visible content uses a nested language scope for its
locale, while English summaries keep their English alternative scope.

SVG, PNG, and PDF export need the `export` extra (`pip install
'herceg[export]'`): SVG is rendered by the same DOM-free renderer as herceg's
`renderToSVG`, run in an embedded V8 engine (`mini-racer`), so it matches the
browser's chart except for text measurement. Without supplied fonts, SVG
uses fixed Helvetica estimates. PNG is rasterized from that SVG by `resvg`,
using system fonts by default. PDF comes from herceg's
`renderToPDF` in the same engine: vector marks, axes,
and legends, heatmaps as images, and selectable text. What the renderer
refuses, such as an option the spec does not accept (`theme="drak"`) or a
font it cannot embed, raises `ValueError` with herceg's message. Without supplied fonts,
PDF uses the standard fonts and Windows-1252 encoding (other characters
print as "?"). Custom fonts are export options, separate from the spec,
with the same `fonts=` mapping for SVG, PNG, and PDF:

```python
from pathlib import Path

chart = hg.Chart(data, title="Δ latency", theme={"font": "Inter"}).line(x="time", y="latency")
fonts = {
    "Inter": {"normal": Path("Inter-Regular.ttf"), "bold": Path("Inter-Bold.ttf")},
    "Symbols": Path("Symbols.ttf").read_bytes(),
}
pdf_bytes = chart.to_pdf(fonts=fonts, fallback=["Symbols"])
png_bytes = chart.to_png(fonts=fonts, scale=2)
svg_text = chart.to_svg(fonts=fonts)
chart.save("chart.png", fonts=fonts)
hg.save(chart, "chart.svg", fonts=fonts)
hg.save([latency, throughput], "unicode-report.pdf", fonts=fonts, fallback=["Symbols"])
chart.save("chart.pdf", fonts=fonts, fallback=["Symbols"])
# A family with one face can also be supplied as {"Inter": "Inter-Regular.ttf"}.
```

Python keeps these font arguments: its JavaScript bridge prepares them with
`pdfFonts` before export. SVG and PNG use the PDF resolver's TrueType text
measurement in embedded V8, so all three formats lay out labels with the
supplied faces' horizontal advances, without kerning. PNG also loads those
faces into resvg, including byte inputs and families registered under an
alias. It uses temporary local font files, removed after each export, and
does not load system fonts when `fonts` is nonempty. Resvg handles the final
rasterization; its text shaping can differ from PDF's unkerned glyph runs.
SVG references families by name and embeds neither font files nor font URLs;
its viewer must provide the same fonts to reproduce the measured layout.
`fallback` and `missing_glyph` remain PDF-only options. For SVG and PNG,
put covering families in `theme["font"]`, for example `"Inter, Symbols"`.
`hg.save` forwards `fonts` for single charts; lists still require a PDF path.

TypeScript callers use `fonts: pdfFonts(sources,
{ fallback, missingGlyph })`; plain JavaScript PDF exports omit this helper
and bundle no TrueType parser or subsetter.

Each font is bytes or a filesystem path (`str` or `PathLike`). Nested family
mappings accept `"normal"` and `"bold"`; a missing weight uses the available
face without synthetic bold. Match `theme["font"]` to the registered families.
CSS family lists are tried first, then PDF's `fallback`, with each grapheme cluster
kept in one face. Simple accents use an NFC precomposed glyph with the
original sequence preserved for extraction; sequences needing mark positioning
are refused. PDF uses the same resolver to measure and draw: exact horizontal
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
See [the exact allowlist](https://github.com/op55-org/herceg/blob/main/docs/architecture.md). Other scripts, unassigned and
private-use characters, controls, and default-ignorable characters are refused
with their code point before coverage or replacement. Static TrueType
`glyf` outlines are supported; CFF, WOFF, collections, variable fonts, joiners,
and variation sequences are refused. Emoji modifier, flag, tag, and ZWJ sequences
are refused before fallback or replacement. The same font format, coverage,
and simple-text restrictions apply when supplying fonts for SVG or PNG
measurement. SVG and PNG exported without `fonts` retain their default text behavior.
Clusters use `Intl.Segmenter` when available (verified in MiniRacer 0.14.1).
Without it, conservative grouping joins combining marks, Grapheme_Extend
characters (including halfwidth kana voiced marks), emoji modifiers, and ZWJ
continuations; unsupported clusters still fail. Fallback keeps each cluster in
one face, and replacement emits one scalar for the whole uncovered cluster.
Unusually tall fallback fonts may need extra margins; layout currently measures
width only, and code-point cuts in shortened labels may split grapheme clusters.
Dark themes need a background color in PDFs, whose viewers show transparent
pages as white. Optional shipped fonts are still open work.

Embedded fonts are subset once per document, unioning glyphs across all pages.
Each used face shares one font object.

`to_pdf()` and `save("chart.pdf")` automatically produce tagged PDFs with
either standard or embedded fonts. One Figure contains the whole chart,
including facets and subplots; its alternative text combines the title and
the engine's generated chart summary. Backgrounds and grid lines are artifacts,
and the document language comes from `locale` when supplied. Text labels stay
inside the Figure; PDF/UA conformance is not claimed.

## Live notebook charts

`chart.widget()` returns a chart that Python keeps updating after it is
displayed, and that reports zooming, brushing, hovering, clicks, drills, and
node moves back to Python. It runs on [anywidget](https://anywidget.dev), so it works in
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
live.on_camera(lambda camera: print(camera.azimuth, camera.elevation))  # standalone 3D
```

Trees and networks report their state with the same property and callback
pattern. `drill_root` is an `hg.DrillRoot`: a tuple of item keys from the top
level through the current root, or `None` for the whole tree. Assign a path
reported by `on_drill` to restore it; assigning `None` (or `()`) resets it.
The keys are the same opaque keys reported by inspections, rather than labels.
`zoom=True` enables mouse and keyboard drilling. Facet panels share one
root, which `drill_root` holds. In panels, each treemap or sunburst drills
on its own: `panel_drill_roots` maps each such panel's id to its root, and
assigning a mapping drills the panels it names; `on_drill(callback,
panel="b")` hears of one panel's changes, while `drill_root` and a plain
`on_drill` refuse such a chart, naming the mapping. `item_positions` and
`panel_item_positions`, `on_item_move(..., panel=)`, and for maps' and
networks' views `viewport` and `panel_viewports` with `on_viewport(...,
panel=)`, follow the same rule: `viewport` is the chart's axes' (or its
facet panels' shared map's) and each map or network panel's is its own
(numbers in its plane's units, without `y_right`); a chart none of whose
panels has axes refuses `viewport` and a plain `on_viewport`. A
`Selection` from a lasso on a map or network panel names it in `panels`.

```python
tree = hg.treemap(sales, path=["region", "country"], value="revenue", zoom=True).widget()
tree.on_drill(lambda root: print(root))
tree                                  # display it, then drill into a region
saved_root = tree.drill_root           # for example, ('[0,"Europe"]',)
tree.drill_root = None                 # show the whole tree
tree.drill_root = saved_root           # restore that branch
```

`item_positions` is an `hg.ItemPositions`: a dictionary from node item keys
to `(x, y)` pairs in the network's layout units, rather than pixels. It holds
only manually moved nodes. Assigning replaces the whole mapping: omitting a
key puts that node back in its computed position, and `{}` resets every node.
The getter and callbacks return copies; edit a copy and assign it to apply it.
A change of a network's data (its links or its nodes) clears its overrides,
while title, theme, resize, and other tables' changes keep them. A display that hides a node keeps its override and applies it when
the node is shown again. Moves and multi-node resets are combined per frame. Item keys and drill targets are checked by the browser; an unknown key
shows an error above the chart and reconciles the state to what was applied.

```python
network = hg.graph(links, "source", "target", drag=True).widget()
network.on_item_move(lambda positions: print(positions))
network                               # display it, then drag a node
positions = network.item_positions
if positions:
    node = next(iter(positions))
    positions[node] = (10.0, 20.0)
    network.item_positions = positions
network.item_positions = {}           # reset every moved node
```

Drill and move callbacks also run for Python assignments and resets. Both
states reach every output and survive redisplay or browser reload, even when
no callback listens. Restoring a tree whose data removed a branch uses its
nearest surviving ancestor. Map viewports retain both x and y ranges.

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
`label`, `value`, and tooltip `text`, the `fields` of its row its mark's
tooltip shows (`hg.InspectedField`: `field`, `label`, `kind`, `value`, with
datetimes for times, and `text`), and where it comes from: `row`, the
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

For 3D widgets, `live.camera` reads or sets the standalone camera; with
subplots use `live.panel_cameras` (a mapping by panel id) and
`live.on_camera(callback, panel="cloud")`. Assigning
`live.panel_cameras = {"cloud": hg.Camera(azimuth=40)}` changes only that
panel; `None` resets it. Camera states synchronize across notebook
displays and late displays receive them in the snapshot. Reports are
throttled while dragging; the first browser also reports its resolved
camera. Changing effective camera defaults through `live.update(camera=...)`
resets the affected cameras even before displaying the widget or after closing
all displays. Cameras whose effective defaults stay the same retain their views.
Streamlit takes `on_camera="rerun"` or a
callback; its `ChartState.camera` and `ChartState.panel_cameras` hold the
standalone or subplot cameras. Reruns preserve turned views unless their
configured camera changes.

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
group's, on a pie slice, funnel stage, tree node, or Sankey link its rows.
Summaries draw the selected rows against the whole: a bin's selected part
of its bar, the selected values' own box over each box plot's (their density
inside each violin), a heatmap cell's selected share as a square in it, and
each slice's, stage's, node's, and link's selected share; tooltips say how
much ("12 of 42 rows selected"). `events=["click"]` chooses the gestures
that select (`[]` for a chart that only shows what others select),
`effect="none"` selects without dimming, `data=` names the table (by default
the chart's data), and `fields=["kind"]` sends columns the marks do not
read, for conditions set from Python to test (a widget refuses a condition
on a column it does not send); a list binds several tables, one binding
each.

`selection=` is what the channel holds when the chart is drawn: a
condition (`hg.col("fare") > 20`), rows by position in the data (whole
numbers, or a boolean mask), or a widget's `row_selection`. Static output
(`to_svg`, `to_png`, `to_pdf`, `hg.save`) draws it highlighted, so a widget's
selection exports through a chart made with it, and a widget or Streamlit
chart starts with it:

```python
picked = hg.SelectionBinding("focus", selection=hg.col("fare") > 20)
hg.Chart(trips, row_selection=picked).histogram(x="distance").to_svg()
```

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
browser and reports nothing; SVG, PNG, and PDF draw the bindings'
`selection`.

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
data), `on_viewport` (pan and zoom), `on_drill` (tree navigation), `on_item_move` (network nodes moved or
reset), and `on_row_selection` (selecting rows, in charts with one
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

`state.viewport` is an `hg.Viewport`, in projected plane units for maps and
layout units for networks. Compatible redraws preserve both ranges and
lassos after restoring node positions; changed network data or layout
fields clear the network view and positions. Use `on_viewport="rerun"` to
report view changes to Python, or leave it ignored to navigate in the browser.

Maps preserve their viewport and lasso only while the resolved projection
parameters match. A data update that changes a conic projection's inferred
central meridian or parallels, or a widget update of `projection`, clears
both (each map subplot's alone), in Streamlit and notebook widgets.

`state.drill_root` and `state.item_positions` use the same tuple of item
keys and dictionary of layout-coordinate pairs as notebook widgets, and
`state.panel_drill_roots`, `state.panel_item_positions`, and
`state.panel_viewports` hold each panel's, as widgets' mappings do. They
are persistent state, including inside forms, and reach Python when their
reaction is enabled. Reaction functions take no arguments, like the other
Streamlit callbacks. A compatible redraw keeps the drill root (or its nearest
surviving ancestor) and keeps positions when only styles change; changes to
network data or layout fields clear positions. Results from an obsolete
network layout are discarded in Python.

```python
tree = hg.treemap(sales, path=["region", "country"], value="revenue", zoom=True)
state = hst.chart(tree, key="sales-tree", on_drill="rerun")
st.write("Current branch:", state.drill_root)

network = hg.graph(links, "source", "target", drag=True)
state = hst.chart(network, key="network", on_item_move="rerun")
st.write("Moved nodes:", state.item_positions)
```

The chart is a Streamlit custom component (components v2): it renders in the
app's page, in a shadow root rather than an iframe, and its spec and column
buffers travel as one binary payload. A rerun that sends the same chart
leaves it as it is, zoom and brush included; changed data or options remount
the chart in the same container, restoring its zoom and brush where the
brushed values or category labels still are. Points with `animation_key`
show at once on remount; keyed replacements animate in notebook widgets and
JavaScript apps. Charts without a theme follow the app's light or dark
theme, also when it changes. [examples/streamlit_app.py](https://github.com/op55-org/herceg/blob/main/python/examples/streamlit_app.py)
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
- A widget has no `to_png()` of what it shows: a notebook cell cannot wait
  for the browser's answer to a message it sends, and Python does not know
  the series hidden through the legend, the browser's size, or its fonts.
  `chart.to_png()` and `chart.save()` draw the chart as Python built it
  (its configured domains, not a zoom made in the browser).
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
- Each widget sends the engine (about 646 KiB, 240 KiB gzipped) to the browser
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
  (about 641 KiB, 238 KiB gzipped). Streamlit sends unchanged charts as a
  reference to what the browser already has. Hover and zoom are not
  reported to the script, since each report would rerun it.
