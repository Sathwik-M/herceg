"""herceg: fast, columnar charts for Python.

Build a chart from a dataframe in one call::

    import herceg as hg

    hg.line(df, x="time", y=["p50", "p99"], title="Latency")

or compose several marks on one chart::

    chart = (
        hg.Chart(df, title="Latency", y=hg.Axis(label="ms"))
        .line(x="time", y=["p50", "p99"])
        .rule(y=250, label="SLO")
    )
    chart.save("latency.html")

Charts display in notebooks, save as HTML, SVG, or PNG, and serialize to the
portable herceg chart spec shared with the TypeScript library.
"""

from ._chart import Axis, Chart, area, bar, candlestick, heatmap, line, scatter

__all__ = ["Axis", "Chart", "area", "bar", "candlestick", "heatmap", "line", "scatter"]
__version__ = "0.0.0"
