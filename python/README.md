# herceg for Python

Charts for pandas, Polars, PyArrow, and NumPy data, rendered by the
[herceg](../README.md) engine: the same charts, tooltips, zooming, and
large-data handling as the TypeScript library.

> Early development. Line, area, bar, scatter, heatmap, error bar,
> candlestick, and histogram marks, rule, region, and text annotations; small multiples;
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
hg.bar(sales, x="region", y=["q1", "q2"])
hg.bar(sales, x="q1", y="region")  # a category y gives horizontal bars
hg.bar(sales, x="region", y="q1", labels=True)  # values at the bar ends
hg.Chart(stats).bar(x="group", y="mean").error_bar(x="group", y="mean", y_error="se")
hg.scatter(cars, x="weight", y="mpg", series="origin", r=3)
hg.scatter(countries, x="gdp", y="life", r="population", series="continent")  # bubbles
hg.scatter(stations, x="lon", y="lat", color="anomaly", colors="rdbu", color_midpoint=0)
hg.scatter(cars, x="weight", y="mpg", symbol="origin")  # a shape per origin
hg.heatmap(load, x="hour", y="host", value="cpu", colors="viridis")
hg.candlestick(prices, x="day", open="open", high="high", low="low", close="close")
hg.histogram(requests, x="latency", series="region", bins={"step": 10})
```

`hg.Chart` composes marks on shared axes; each mark method returns the chart:

```python
chart = (
    hg.Chart(df, title="Request latency", y=hg.Axis(label="ms"), zoom=True)
    .line(x="time", y=["p50", "p99"])
    .rule(y=250, label="SLO")
)
```

Chart options: `title`, `description`, `width`, `height`, `x` and `y`
(`hg.Axis(type="log", domain=(0, 100), label="ms", ...)` or a dict),
`y_right` (the axis for marks added with `axis="right"`), `facet` and
`facet_columns` (a panel per value of a category column; marks with
`repeat=True` draw all their rows in every panel),
`legend`, `tooltip` (`True`, `False`, `"nearest-x"`, `"nearest-y"`, `"nearest"`), `zoom`,
`brush` (`"x"`: drag to select a range; with `zoom=True`, drag to zoom),
`sync` (charts with the same name on one HTML page share cursor and zoom;
notebook outputs are separate iframes, so `sync` does not reach across
cells), `renderer`, `theme` (`"light"`, `"dark"`, or a dict), `locale`, and
`time_zone`.

Mark methods take column names; `series` names a category column that splits
rows into one series per value. A mark can read other data with `data=`.
Points can size (`r`), color (`color`), fade (`fill_opacity`), and shape
(`symbol`) by column; `colors` takes a scheme name from `hg.SCHEMES` or a list
of hex colors, and `symbol` a shape from `hg.SYMBOLS` or a category column.
Column names are checked when the mark is added, with the available columns
in the error message.

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
and legends, heatmaps as images, and selectable text in the standard PDF
fonts, which cover Windows-1252 (Latin-1 and common punctuation); other
characters print as "?". Dark themes need a background color in PDFs, whose
viewers show transparent pages as white.

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
live.viewport = (start, end)             # zoom; None fits the data
live.selection = (start, end)            # brush; None clears it
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
live.selection                           # the brushed x range, or None
live.viewport                            # the visible x range when zoomed, or None

live.on_select(lambda selection: print(selection))
live.on_viewport(lambda viewport: print(viewport))
live.on_hover(lambda inspection: print(inspection))   # None when the pointer leaves
live.on_click(lambda inspection: print(inspection.value, inspection.points))
live.on_click(callback, remove=True)     # stop calling it
```

Ranges and inspections hold Python values: datetimes on time axes (naive, in
UTC, like the datetimes herceg reads), category labels on category axes, and
numbers otherwise. An `hg.Inspection` is what the tooltip shows: the
inspected `axis` (`"y"` for horizontal bars), the snapped `value` there and
its axis `label`, the facet `panel`, and `points`, one `hg.InspectedPoint`
per series with its `series` name, `value`, and tooltip `text`. Selection
and viewport callbacks also run when Python sets them. Hover, zoom, and selection
reach Python at most every 100 ms, always ending with the latest; hover and
click are only sent while a callback listens.

A widget displayed in several cells is one chart: updates and brushing reach
every output. A browser that opens the notebook later, or reloads it, draws
the current data.

## Streamlit

`herceg.streamlit.chart(chart)` shows a chart in a
[Streamlit](https://streamlit.io) app (Streamlit 1.51 or newer;
`pip install 'herceg[streamlit]'`) and returns what the user did with it:

```python
import herceg as hg
import herceg.streamlit as hst

chart = hg.Chart(df, brush="x").line(x="time", y="latency")
state = hst.chart(chart, key="latency", on_select="rerun", on_click="rerun")

if state.selection:
    start, end = state.selection
    st.dataframe(df[df["time"].between(start, end)])
if state.click:
    st.write(state.click.label, state.click.points)
```

`on_select` (brushing an x range, in charts with `brush="x"`) and `on_click`
(clicking data) take `"ignore"`, the default, which keeps them in the
browser; `"rerun"`, which reruns the script so that its `chart(...)` call
returns them; or a function, called before the rerun as Streamlit widget
callbacks are. `state.selection` is the brushed x range, with the same
values as live notebook charts (datetimes on time axes), and stays until the
user changes it. `state.click` is an `hg.Inspection` in the run a click
caused, and None otherwise. Inside `st.form`, a selection reaches the script
when the form is submitted, and `on_click` cannot react, since Streamlit
sends no clicks from forms. Give a chart a `key` to keep its selection when
its data changes, and to show several charts with the same content.

The chart is a Streamlit custom component (components v2): it renders in the
app's page, in a shadow root rather than an iframe, and its spec and column
buffers travel as one binary payload. A rerun that sends the same chart
leaves it as it is, zoom and brush included; a changed chart is redrawn in
place, keeping its zoom and its brush where the brushed values or category
labels still are. Charts without a theme follow the app's light or dark
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
  the engine. Link them from Python instead:
  `a.on_viewport(lambda viewport: setattr(b, "viewport", viewport))`.
- Python keeps the live chart's current data, so a browser that connects
  later can draw it, and `append` copies the table's columns on each call
  (about 0.35 ms for 100 rows into a million-row, three-column window on an
  Apple M6).
- Each widget sends the engine (about 146 KiB, 53 KiB gzipped) to the browser
  once. Live charts were tested in JupyterLab 4; Notebook 7, VS Code, and
  Colab support anywidget but have not been tested here.
- Hover and click events report values, not row numbers.
- In Streamlit, a chart that changes between script runs is sent whole: its
  data and, since the component's code travels inline with it, the engine
  (about 143 KiB, 52 KiB gzipped). Streamlit sends unchanged charts as a
  reference to what the browser already has. Hover and zoom are not
  reported to the script, since each report would rerun it.
