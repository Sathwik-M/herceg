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
``chart.widget()`` makes a live notebook chart that Python can update and
observe (the ``notebook`` extra); ``herceg.streamlit.chart(chart)`` shows one
in a Streamlit app (the ``streamlit`` extra).
"""

from ._chart import (
    SCHEMES,
    SYMBOLS,
    Animation,
    Axis,
    Break,
    Camera,
    Chart,
    ChartOptions,
    ChartUpdate,
    HelperOptions,
    Navigator,
    Panel,
    Projection,
    Tooltip,
    area,
    bar,
    boxplot,
    candlestick,
    choropleth,
    funnel,
    gauge,
    graph,
    heatmap,
    histogram,
    line,
    line_3d,
    pie,
    radar,
    sankey,
    scatter,
    scatter_3d,
    scatter_geo,
    sunburst,
    surface,
    treemap,
    violin,
)
from ._derive import Derived, Expr, col, derive, when
from ._events import InspectedPoint, Inspection, Selection, Viewport
from ._rows import RowSelection, SelectionBinding

__all__ = [
    "SCHEMES",
    "SYMBOLS",
    "Animation",
    "Axis",
    "Break",
    "Camera",
    "Chart",
    "ChartOptions",
    "ChartUpdate",
    "HelperOptions",
    "Navigator",
    "Panel",
    "Projection",
    "RowSelection",
    "Selection",
    "SelectionBinding",
    "Tooltip",
    "Viewport",
    "Derived",
    "Expr",
    "InspectedPoint",
    "Inspection",
    "area",
    "bar",
    "boxplot",
    "candlestick",
    "choropleth",
    "col",
    "derive",
    "funnel",
    "gauge",
    "graph",
    "heatmap",
    "histogram",
    "line",
    "line_3d",
    "pie",
    "radar",
    "sankey",
    "scatter",
    "scatter_3d",
    "scatter_geo",
    "sunburst",
    "surface",
    "treemap",
    "violin",
    "when",
]
__version__ = "0.0.0"
