# herceg for Python

Charts for pandas, Polars, PyArrow, and NumPy data, rendered by the
[herceg](../README.md) engine: the same charts, tooltips, zooming, and
large-data handling as the TypeScript library.

> Early development. Line, area, bar, scatter, heatmap, error bar,
> candlestick, and histogram marks, rule, region, and text annotations; small multiples;
> HTML, notebook, SVG, PNG, and PDF output.

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
hg.heatmap(load, x="hour", y="host", value="cpu")
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
```

HTML output and notebook display embed the herceg bundle (about 60 KiB), so
they work offline. Notebooks show each chart in an isolated iframe.

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

## Development

From the repository root:

```sh
npm run build:python   # bundle herceg's JavaScript into python/src/herceg/static
npm run test:python    # build, then run pytest in a uv environment
```

## Limits

- No live updates from Python after a chart is displayed; display a new chart
  instead.
- Notebook charts do not talk back to Python (selections, zoom state).
