"""herceg: fast, columnar charts for Python.

Build a chart from a dataframe in one call::

    import herceg as hg

    hg.line(df, x="time", y=["p50", "p99"], title="Latency")

or compose several marks on one chart::

    chart = (
        hg.Chart(df, title="Latency", y=hg.Axis(title="ms"))
        .line(x="time", y=["p50", "p99"])
        .rule(y=250, label="SLO")
    )
    chart.save("latency.html")

Charts display in notebooks, save as HTML, SVG, PNG, or PDF, and serialize to the
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
    Dash,
    HelperOptions,
    Jitter,
    Navigator,
    Panel,
    Projection,
    Tooltip,
    TooltipField,
    area,
    bar,
    boxen,
    boxplot,
    candlestick,
    choropleth,
    contour,
    funnel,
    gauge,
    graph,
    heatmap,
    histogram,
    line,
    line_3d,
    matrix,
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
from ._data import Matrix
from ._derive import Derived, Expr, col, derive, when
from ._events import (
    DrillRoot,
    InspectedField,
    InspectedPoint,
    Inspection,
    ItemPositions,
    Selection,
    Viewport,
)
from ._pdf import save, to_pdf
from ._rows import RowSelection, SelectionBinding
from ._style import (
    BarStyle,
    Halo,
    Legend,
    LineStyle,
    Place,
    PlotStyle,
    StrokeStyle,
    Style,
    TextBox,
    TextStyle,
    Theme,
    Title,
    Tokens,
    TooltipStyle,
)

__all__ = [
    "save",
    "to_pdf",
    "SCHEMES",
    "SYMBOLS",
    "Animation",
    "Axis",
    "BarStyle",
    "Break",
    "Camera",
    "Chart",
    "ChartOptions",
    "ChartUpdate",
    "Dash",
    "Halo",
    "HelperOptions",
    "Jitter",
    "Legend",
    "LineStyle",
    "Navigator",
    "Panel",
    "Place",
    "PlotStyle",
    "Projection",
    "RowSelection",
    "Selection",
    "SelectionBinding",
    "StrokeStyle",
    "Style",
    "TextBox",
    "TextStyle",
    "Theme",
    "Title",
    "Tokens",
    "Tooltip",
    "TooltipField",
    "TooltipStyle",
    "Viewport",
    "Derived",
    "DrillRoot",
    "Expr",
    "InspectedField",
    "InspectedPoint",
    "Inspection",
    "ItemPositions",
    "Matrix",
    "area",
    "bar",
    "boxen",
    "boxplot",
    "candlestick",
    "choropleth",
    "col",
    "contour",
    "derive",
    "funnel",
    "gauge",
    "graph",
    "heatmap",
    "histogram",
    "line",
    "line_3d",
    "matrix",
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
