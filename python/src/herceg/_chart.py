"""Charts: a Pythonic builder for the portable chart spec."""

from __future__ import annotations

import datetime as _dt
import math
import numbers
from collections.abc import Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal

import numpy as np

from . import _render
from ._data import Column, Table
from ._derive import Derived

if TYPE_CHECKING:
    from .widget import ChartWidget

Tooltip = Literal["nearest-x", "nearest-y", "nearest"]
Curve = Literal["linear", "step", "step-before", "step-after", "monotone"]
ThemeName = Literal["light", "dark", "high-contrast", "high-contrast-dark", "auto"]

_NUMERIC = ("number", "time")

# Point shapes, in the order a symbol column's values take them.
SYMBOLS = ("circle", "square", "triangle", "diamond", "cross", "star", "wye", "triangle-down")

# Named color schemes: sequential, diverging, then categorical.
SCHEMES = (
    *("viridis", "magma", "inferno", "plasma", "cividis", "turbo"),
    *("blues", "greens", "greys", "oranges", "purples", "reds", "ylgnbu", "ylorrd"),
    *("rdbu", "rdylbu", "brbg", "piyg", "prgn", "puor", "spectral"),
    *("tableau10", "category10", "set2", "dark2"),
)

# An annotation position: a column name, a number, or a date or datetime
# (pandas Timestamps and NumPy datetime64 values work too).
Position = str | float | _dt.date


@dataclass
class Axis:
    """Scale and axis options for x or y. Unset options use herceg's defaults."""

    type: Literal["linear", "log", "time"] | None = None
    domain: tuple[float, float] | None = None
    label: str | None = None
    nice: bool | None = None
    zero: bool | None = None
    grid: bool | None = None
    ticks: int | None = None
    format: dict[str, Any] | None = None
    show: bool | None = None

    def _spec(self) -> dict[str, Any]:
        spec = {
            "type": self.type,
            "domain": list(self.domain) if self.domain is not None else None,
            "label": self.label,
            "nice": self.nice,
            "zero": self.zero,
            "grid": self.grid,
            "ticks": self.ticks,
            "format": self.format,
            "axis": self.show,
        }
        return {key: value for key, value in spec.items() if value is not None}


class Chart:
    """A chart: data, marks drawn in order, and options.

    Marks are added with methods that return the chart, so calls chain::

        chart = (
            hg.Chart(df, title="Latency", y=hg.Axis(label="ms"))
            .line(x="time", y=["p50", "p99"])
            .rule(y=250, label="SLO")
        )

    ``data`` is any table herceg reads (pandas, Polars, or PyArrow tables, a
    mapping of column names to arrays, or a list of records); marks use it
    unless they pass their own ``data``.
    """

    def __init__(
        self,
        data: Any = None,
        *,
        title: str | None = None,
        description: str | None = None,
        width: int | None = None,
        height: int | None = None,
        x: Axis | dict[str, Any] | None = None,
        y: Axis | dict[str, Any] | None = None,
        y_right: Axis | dict[str, Any] | None = None,
        facet: str | None = None,
        facet_columns: int | None = None,
        legend: bool | None = None,
        tooltip: bool | Tooltip = True,
        zoom: bool = False,
        brush: Literal["x"] | None = None,
        sync: str | None = None,
        renderer: Literal["auto", "svg", "canvas"] | None = None,
        theme: ThemeName | dict[str, Any] | None = None,
        locale: str | None = None,
        time_zone: str | None = None,
    ) -> None:
        if facet_columns is not None and facet is None:
            raise ValueError("facet_columns needs facet")
        # bool is an int in Python, but True columns would be meaningless.
        if facet_columns is not None and not (
            isinstance(facet_columns, int)
            and not isinstance(facet_columns, bool)
            and facet_columns >= 1
        ):
            raise ValueError(
                f"facet_columns must be a whole number of at least 1, not {facet_columns!r}"
            )
        self._facet = facet
        self._facet_columns = facet_columns
        self._tables: list[tuple[Any, Table | _DerivedColumns]] = []
        # Derived tables by index, with the index of the table they derive from.
        self._derived: dict[int, int] = {}
        self._default = self._table(data) if data is not None else None
        self._marks: list[tuple[dict[str, Any], int | None]] = []
        # The keyword arguments as given, so live charts can change some later.
        self._settings: dict[str, Any] = {
            "title": title,
            "description": description,
            "width": width,
            "height": height,
            "x": x,
            "y": y,
            "y_right": y_right,
            "legend": legend,
            "tooltip": tooltip,
            "zoom": zoom,
            "brush": brush,
            "sync": sync,
            "renderer": renderer,
            "theme": theme,
            "locale": locale,
            "time_zone": time_zone,
        }
        self._options = spec_options(self._settings)

    # Marks -----------------------------------------------------------------

    def line(
        self,
        x: str,
        y: str | Sequence[str],
        *,
        series: str | None = None,
        data: Any = None,
        stroke: str | None = None,
        stroke_width: float | None = None,
        dash: Sequence[float] | None = None,
        curve: Curve | None = None,
        label: str | None = None,
        axis: Literal["left", "right"] | None = None,
        repeat: bool = False,
        id: str | None = None,
    ) -> Chart:
        """Lines through x and y fields; several y fields or a series field give several lines."""
        table = self._mark_table(data)
        self._require(table, x, _NUMERIC, "line x")
        ys = self._require_many(table, y, _NUMERIC, "line y")
        self._require(table, series, ("category",), "line series")
        self._single_or_series(ys, series, "line")
        return self._add(
            {
                "type": "line",
                "x": x,
                "y": ys,
                "series": series,
                "stroke": stroke,
                "strokeWidth": stroke_width,
                "dash": list(dash) if dash is not None else None,
                "curve": curve,
                "label": label,
                "axis": axis,
                "facet": "repeat" if repeat else None,
                "id": id,
            },
            table,
        )

    def area(
        self,
        x: str,
        y: str | Sequence[str] | None = None,
        *,
        y1: str | None = None,
        y2: str | None = None,
        series: str | None = None,
        stack: bool = False,
        data: Any = None,
        fill: str | None = None,
        fill_opacity: float | None = None,
        line: bool | None = None,
        curve: Curve | None = None,
        label: str | None = None,
        axis: Literal["left", "right"] | None = None,
        repeat: bool = False,
        id: str | None = None,
    ) -> Chart:
        """Filled areas: down to zero, stacked, or the band between ``y1`` and ``y2``."""
        table = self._mark_table(data)
        self._require(table, x, _NUMERIC, "area x")
        band = y1 is not None or y2 is not None
        if band and (y1 is None or y2 is None):
            raise ValueError("a band area needs both y1 and y2")
        if band and y is not None:
            raise ValueError("an area takes y, or y1 and y2, not both")
        if not band and y is None:
            raise ValueError("an area needs y, or y1 and y2")
        if band and (series is not None or stack):
            raise ValueError("a band area (y1 and y2) cannot also have series or stack")
        if stack and series is not None:
            raise ValueError("stacked areas need several y columns sharing x, not a series column")
        ys = self._require_many(table, y, _NUMERIC, "area y") if y is not None else None
        self._require(table, y1, _NUMERIC, "area y1")
        self._require(table, y2, _NUMERIC, "area y2")
        self._require(table, series, ("category",), "area series")
        if ys is not None:
            self._single_or_series(ys, series, "area")
        return self._add(
            {
                "type": "area",
                "x": x,
                "y": ys,
                "y1": y1,
                "y2": y2,
                "series": series,
                "stack": stack or None,
                "fill": fill,
                "fillOpacity": fill_opacity,
                "line": line,
                "curve": curve,
                "label": label,
                "axis": axis,
                "facet": "repeat" if repeat else None,
                "id": id,
            },
            table,
        )

    def bar(
        self,
        x: str | Sequence[str],
        y: str | Sequence[str],
        *,
        series: str | None = None,
        stack: bool = False,
        data: Any = None,
        fill: str | None = None,
        fill_opacity: float | None = None,
        label: str | None = None,
        labels: bool | dict[str, Any] = False,
        axis: Literal["left", "right"] | None = None,
        repeat: bool = False,
        id: str | None = None,
    ) -> Chart:
        """Bars: one band per category of x, or bars centered on number or time x.

        A category ``y`` makes the bars horizontal, with lengths in ``x``.
        ``labels=True`` writes each value at its bar's end (inside each segment
        when stacked); a dict of Intl.NumberFormat options formats them.
        """
        table = self._mark_table(data)
        if isinstance(y, str) and self._kind(table, y) == "category":
            if axis == "right":
                raise ValueError("horizontal bars cannot use the right axis")
            xs = self._require_many(table, x, _NUMERIC, "horizontal bar x")
            self._single_or_series(xs, series, "bar")
            ys: str | list[str] = y
        else:
            if not isinstance(x, str):
                raise ValueError("bar: several x columns need a category y (horizontal bars)")
            self._require(table, x, ("number", "time", "category"), "bar x")
            xs = x
            ys = self._require_many(table, y, _NUMERIC, "bar y")
            self._single_or_series(ys, series, "bar")
        self._require(table, series, ("category",), "bar series")
        return self._add(
            {
                "type": "bar",
                "x": xs,
                "y": ys,
                "series": series,
                "stack": stack or None,
                "fill": fill,
                "fillOpacity": fill_opacity,
                "label": label,
                "labels": None if labels is False else labels,
                "axis": axis,
                "facet": "repeat" if repeat else None,
                "id": id,
            },
            table,
        )

    def error_bar(
        self,
        *,
        x: str | None = None,
        y: str | None = None,
        x1: str | None = None,
        x2: str | None = None,
        y1: str | None = None,
        y2: str | None = None,
        x_error: str | None = None,
        y_error: str | None = None,
        series: str | None = None,
        data: Any = None,
        stroke: str | None = None,
        stroke_width: float | None = None,
        cap: float | None = None,
        label: str | None = None,
        axis: Literal["left", "right"] | None = None,
        repeat: bool = False,
        id: str | None = None,
    ) -> Chart:
        """Error bars at each ``x``, from ``y1`` to ``y2`` or ``y`` ± ``y_error``; or, at each
        ``y``, from ``x1`` to ``x2`` or ``x`` ± ``x_error``.

        ``cap`` is the width of the end caps in pixels (0 for none). Add points or bars
        to show the center.
        """
        vertical = y_error is not None or (y1 is not None and y2 is not None)
        horizontal = x_error is not None or (x1 is not None and x2 is not None)
        if vertical == horizontal:
            raise ValueError(
                "error_bar needs x with y1 and y2 or with y and y_error (vertical), "
                "or y with x1 and x2 or with x and x_error (horizontal)"
            )
        if horizontal and axis == "right":
            raise ValueError("horizontal error bars cannot use the right axis")
        table = self._mark_table(data)
        along, other = ("y", "x") if horizontal else ("x", "y")
        position = y if horizontal else x
        if position is None:
            raise ValueError(f"error_bar needs {along}")
        self._require(table, position, ("number", "time", "category"), f"error_bar {along}")
        error = x_error if horizontal else y_error
        if error is not None:
            center = x if horizontal else y
            if center is None:
                raise ValueError(f"error_bar with {other}_error needs {other}")
            self._require(table, center, _NUMERIC, f"error_bar {other}")
            self._require(table, error, _NUMERIC, f"error_bar {other}_error")
        else:
            self._require(table, x1 if horizontal else y1, _NUMERIC, f"error_bar {other}1")
            self._require(table, x2 if horizontal else y2, _NUMERIC, f"error_bar {other}2")
        self._require(table, series, ("category",), "error_bar series")
        return self._add(
            {
                "type": "errorbar",
                "x": x,
                "y": y,
                "x1": x1,
                "x2": x2,
                "y1": y1,
                "y2": y2,
                "xError": x_error,
                "yError": y_error,
                "series": series,
                "stroke": stroke,
                "strokeWidth": stroke_width,
                "cap": cap,
                "label": label,
                "axis": axis,
                "facet": "repeat" if repeat else None,
                "id": id,
            },
            table,
        )

    def point(
        self,
        x: str,
        y: str,
        *,
        series: str | None = None,
        data: Any = None,
        r: float | str | None = None,
        r_range: tuple[float, float] | None = None,
        fill: str | None = None,
        fill_opacity: float | str | None = None,
        color: str | None = None,
        colors: str | Sequence[str] | None = None,
        color_domain: tuple[float, float] | None = None,
        color_midpoint: float | None = None,
        symbol: str | None = None,
        label: str | None = None,
        axis: Literal["left", "right"] | None = None,
        repeat: bool = False,
        id: str | None = None,
    ) -> Chart:
        """Scatter points.

        ``r`` is a radius in pixels or a numeric column sized by area within
        ``r_range`` (bubbles); ``fill_opacity`` is a number or a numeric
        column. ``color`` colors points by a numeric column on ``colors``, a
        scheme name such as ``"viridis"`` or a list of hex colors, centered on
        ``color_midpoint`` for diverging schemes. ``symbol`` is a shape
        (``"circle"``, ``"square"``, ``"triangle"``, ...) or a category column
        with a shape per value.
        """
        table = self._mark_table(data)
        self._require(table, x, _NUMERIC, "point x")
        self._require(table, y, _NUMERIC, "point y")
        self._require(table, series, ("category",), "point series")
        if isinstance(r, str):
            self._require(table, r, _NUMERIC, "point r")
        elif r is not None and not (math.isfinite(r) and r > 0):
            raise ValueError(f"point r must be a positive radius or a column, not {r!r}")
        if isinstance(fill_opacity, str):
            self._require(table, fill_opacity, _NUMERIC, "point fill_opacity")
        elif fill_opacity is not None and not 0 <= fill_opacity <= 1:
            raise ValueError(
                f"point fill_opacity must be from 0 to 1 or a column, not {fill_opacity!r}"
            )
        self._require(table, color, _NUMERIC, "point color")
        if symbol is not None:
            if self._kind(table, symbol) is not None:
                self._require(table, symbol, ("category",), "point symbol")
            elif symbol not in SYMBOLS:
                raise ValueError(
                    f"point symbol: {symbol!r} is neither a column nor one of {', '.join(SYMBOLS)}"
                )
        return self._add(
            {
                "type": "point",
                "x": x,
                "y": y,
                "series": series,
                "r": r,
                "rRange": _range(r_range, "point r_range", minimum=0),
                "fill": fill,
                "fillOpacity": fill_opacity,
                "color": color,
                "colors": _colors(colors, "point colors"),
                "colorDomain": _range(color_domain, "point color_domain"),
                "colorMidpoint": _midpoint(color_midpoint, color_domain, "point"),
                "symbol": symbol,
                "label": label,
                "axis": axis,
                "facet": "repeat" if repeat else None,
                "id": id,
            },
            table,
        )

    def histogram(
        self,
        x: str,
        *,
        bins: int | dict[str, float] | None = None,
        series: str | None = None,
        normalize: Literal["count", "percent", "density"] | None = None,
        stack: bool = False,
        data: Any = None,
        fill: str | None = None,
        fill_opacity: float | None = None,
        label: str | None = None,
        axis: Literal["left", "right"] | None = None,
        repeat: bool = False,
        id: str | None = None,
    ) -> Chart:
        """Counts of ``x``'s values in round bins.

        ``bins`` is about how many bins, or ``{"step": width, "start": edge}``;
        by default the count follows the data size. ``normalize`` measures
        ``"percent"`` of each series' values or ``"density"`` instead of counts.
        """
        table = self._mark_table(data)
        self._require(table, x, _NUMERIC, "histogram x")
        self._require(table, series, ("category",), "histogram series")
        return self._add(
            {
                "type": "histogram",
                "x": x,
                "bins": dict(bins) if isinstance(bins, dict) else bins,
                "series": series,
                "normalize": normalize,
                "stack": stack or None,
                "fill": fill,
                "fillOpacity": fill_opacity,
                "label": label,
                "axis": axis,
                "facet": "repeat" if repeat else None,
                "id": id,
            },
            table,
        )

    def candlestick(
        self,
        x: str,
        open: str,
        high: str,
        low: str,
        close: str,
        *,
        data: Any = None,
        rise: str | None = None,
        fall: str | None = None,
        label: str | None = None,
        axis: Literal["left", "right"] | None = None,
        repeat: bool = False,
        id: str | None = None,
    ) -> Chart:
        """Open-high-low-close candles at each ``x``, as for prices.

        Candles closing at or above their open are hollow in the ``rise``
        color, others filled in ``fall``; both default to the theme's.
        """
        table = self._mark_table(data)
        self._require(table, x, ("number", "time", "category"), "candlestick x")
        for role, field in (("open", open), ("high", high), ("low", low), ("close", close)):
            self._require(table, field, _NUMERIC, f"candlestick {role}")
        return self._add(
            {
                "type": "candlestick",
                "x": x,
                "open": open,
                "high": high,
                "low": low,
                "close": close,
                "rise": rise,
                "fall": fall,
                "label": label,
                "axis": axis,
                "facet": "repeat" if repeat else None,
                "id": id,
            },
            table,
        )

    def pie(
        self,
        category: str,
        value: str | None = None,
        *,
        data: Any = None,
        inner_radius: float | None = None,
        sort: Literal["value", "input"] | None = None,
        labels: bool | None = None,
        id: str | None = None,
    ) -> Chart:
        """A pie: a slice per value of ``category``, sized by the sum of
        ``value`` over its rows, or their count without it.

        ``inner_radius``, a fraction of the pie's radius below 1, makes a
        donut. Slices go largest first, clockwise from the top, unless
        ``sort="input"``. A pie has its chart to itself.
        """
        self._layout_alone("pie")
        if inner_radius is not None and not (
            isinstance(inner_radius, numbers.Real)
            and not isinstance(inner_radius, bool)
            and 0 <= inner_radius < 1
        ):
            raise ValueError(f"inner_radius must be at least 0 and below 1, not {inner_radius!r}")
        table = self._mark_table(data)
        self._require(table, category, ("category",), "pie category")
        self._require(table, value, ("number",), "pie value")
        return self._add(
            {
                "type": "pie",
                "category": category,
                "value": value,
                "innerRadius": inner_radius,
                "sort": sort,
                "labels": labels,
                "id": id,
            },
            table,
        )

    def boxplot(
        self,
        x: str,
        y: str,
        *,
        data: Any = None,
        series: str | None = None,
        fill_opacity: float | None = None,
        label: str | None = None,
        axis: Literal["left", "right"] | None = None,
        repeat: bool = False,
        id: str | None = None,
    ) -> Chart:
        """Box plots of a number column's values per category.

        One of ``x`` and ``y`` is a category column, the other the values:
        a category ``y`` lays the boxes along the y axis. Boxes span the
        quartiles with a line at the median; whiskers reach the most extreme
        values within 1.5 interquartile ranges, and values beyond are dots.
        ``series`` puts a box per value of a category column side by side.
        """
        return self._distribution(
            {"type": "boxplot"}, x, y, data, series, fill_opacity, label, axis, repeat, id
        )

    def violin(
        self,
        x: str,
        y: str,
        *,
        data: Any = None,
        series: str | None = None,
        bandwidth: float | None = None,
        fill_opacity: float | None = None,
        label: str | None = None,
        axis: Literal["left", "right"] | None = None,
        repeat: bool = False,
        id: str | None = None,
    ) -> Chart:
        """Violins of a number column's values per category.

        One of ``x`` and ``y`` is a category column, the other the values:
        a category ``y`` lays the violins along the y axis. Each violin is
        its values' Gaussian kernel density mirrored about its center,
        reaching two bandwidths past the extreme values, with the quartiles
        as a narrow box and the median as a dot inside. Every violin is as
        wide at its densest. ``bandwidth`` sets the kernel's standard
        deviation in data units for every violin; by default each has its
        own by Silverman's rule of thumb. ``series`` puts a violin per value
        of a category column side by side.
        """
        if bandwidth is not None and not (
            isinstance(bandwidth, numbers.Real)
            and not isinstance(bandwidth, bool)
            and math.isfinite(bandwidth)
            and bandwidth > 0
        ):
            raise ValueError(f"bandwidth must be a positive number, not {bandwidth!r}")
        return self._distribution(
            {"type": "violin", "bandwidth": bandwidth},
            x,
            y,
            data,
            series,
            fill_opacity,
            label,
            axis,
            repeat,
            id,
        )

    def _distribution(
        self,
        spec: dict[str, Any],
        x: str,
        y: str,
        data: Any,
        series: str | None,
        fill_opacity: float | None,
        label: str | None,
        axis: Literal["left", "right"] | None,
        repeat: bool,
        id: str | None,
    ) -> Chart:
        """Adds a box plot or violin mark: a category column on one axis, values on the other."""
        kind = spec["type"]
        table = self._mark_table(data)
        horizontal = self._kind(table, y) == "category" and self._kind(table, x) != "category"
        category, values = (y, x) if horizontal else (x, y)
        self._require(table, category, ("category",), f"{kind} {'y' if horizontal else 'x'}")
        self._require(table, values, _NUMERIC, f"{kind} {'x' if horizontal else 'y'}")
        self._require(table, series, ("category",), f"{kind} series")
        if horizontal and axis == "right":
            noun = "box plots" if kind == "boxplot" else "violins"
            raise ValueError(f"horizontal {noun} cannot use the right axis")
        if fill_opacity is not None and not (
            isinstance(fill_opacity, numbers.Real)
            and not isinstance(fill_opacity, bool)
            and 0 <= fill_opacity <= 1
        ):
            raise ValueError(f"fill_opacity must be from 0 to 1, not {fill_opacity!r}")
        return self._add(
            {
                "type": kind,
                "x": x,
                "y": y,
                "series": series,
                **{key: value for key, value in spec.items() if key != "type"},
                "fillOpacity": fill_opacity,
                "label": label,
                "axis": axis,
                "facet": "repeat" if repeat else None,
                "id": id,
            },
            table,
        )

    def treemap(
        self,
        path: Sequence[str] | None = None,
        value: str | None = None,
        *,
        node: str | None = None,
        parent: str | None = None,
        data: Any = None,
        labels: bool | None = None,
        id: str | None = None,
    ) -> Chart:
        """A treemap: nested rectangles for a tree, each leaf's area its share
        of the sum of ``value`` (or of the rows).

        The tree is ``path``, category columns from the outermost group in, or
        ``node`` and ``parent`` columns naming each row's node and its parent.
        Leaves take their top-level group's color; the legend toggles groups.
        A treemap has its chart to itself.
        """
        return self._tree("treemap", path, value, node, parent, data, labels, id)

    def sunburst(
        self,
        path: Sequence[str] | None = None,
        value: str | None = None,
        *,
        node: str | None = None,
        parent: str | None = None,
        data: Any = None,
        labels: bool | None = None,
        id: str | None = None,
    ) -> Chart:
        """A sunburst: a tree as rings around a center, each node's angle its
        share of its parent's; the tree as for ``treemap``. A sunburst has its
        chart to itself."""
        return self._tree("sunburst", path, value, node, parent, data, labels, id)

    def _tree(
        self,
        kind: str,
        path: Sequence[str] | None,
        value: str | None,
        node: str | None,
        parent: str | None,
        data: Any,
        labels: bool | None,
        id: str | None,
    ) -> Chart:
        self._layout_alone(kind)
        table = self._mark_table(data)
        if path is not None:
            if isinstance(path, str) or len(path) == 0:
                raise ValueError(f"{kind} path must be a list of at least one column")
            for name in path:
                self._require(table, name, ("category",), f"{kind} path")
        elif node is not None and parent is not None:
            self._require(table, node, ("category",), f"{kind} node")
            self._require(table, parent, ("category",), f"{kind} parent")
        else:
            raise ValueError(f"{kind} needs a path of category columns, or node and parent")
        self._require(table, value, ("number",), f"{kind} value")
        return self._add(
            {
                "type": kind,
                "path": list(path) if path is not None else None,
                "node": node,
                "parent": parent,
                "value": value,
                "labels": labels,
                "id": id,
            },
            table,
        )

    def _layout_alone(self, kind: str) -> None:
        """Layout marks (pies, treemaps, sunbursts) have no axes to facet or zoom."""
        if self._facet is not None:
            raise ValueError(f"charts of a {kind} cannot have facets yet")
        if any(self._settings.get(name) for name in ("zoom", "brush", "sync")):
            raise ValueError(f"charts of a {kind} have no x axis to zoom, brush, or sync")

    def heatmap(
        self,
        x: str,
        y: str,
        value: str,
        *,
        data: Any = None,
        colors: str | Sequence[str] | None = None,
        color_domain: tuple[float, float] | None = None,
        color_midpoint: float | None = None,
        label: str | None = None,
        repeat: bool = False,
        id: str | None = None,
    ) -> Chart:
        """A grid of cells colored by ``value``; one column or row per distinct x or y.

        ``colors`` is a scheme name such as ``"viridis"`` or a list of hex
        colors, low to high; with ``color_midpoint``, the theme's diverging
        ramp is the default and the midpoint takes its middle color.
        """
        table = self._mark_table(data)
        self._require(table, x, ("number", "time", "category"), "heatmap x")
        self._require(table, y, ("number", "time", "category"), "heatmap y")
        self._require(table, value, _NUMERIC, "heatmap value")
        return self._add(
            {
                "type": "heatmap",
                "x": x,
                "y": y,
                "value": value,
                "colors": _colors(colors, "heatmap colors"),
                "colorDomain": _range(color_domain, "heatmap color_domain"),
                "colorMidpoint": _midpoint(color_midpoint, color_domain, "heatmap"),
                "label": label,
                "facet": "repeat" if repeat else None,
                "id": id,
            },
            table,
        )

    def rule(
        self,
        *,
        x: Position | None = None,
        y: Position | None = None,
        label: str | None = None,
        text: str | None = None,
        data: Any = None,
        stroke: str | None = None,
        stroke_width: float | None = None,
        dash: Sequence[float] | None = None,
        axis: Literal["left", "right"] | None = None,
        repeat: bool = False,
        id: str | None = None,
    ) -> Chart:
        """Reference lines: horizontal at ``y`` or vertical at ``x``.

        A number or datetime draws one rule; a column name draws one rule per
        row, with ``text`` naming a column of labels.
        """
        if (x is None) == (y is None):
            raise ValueError("rule needs exactly one of x or y")
        table = self._annotation_table(data, {"x": x, "y": y}, text, "rule")
        return self._add(
            {
                "type": "rule",
                "x": _position(x),
                "y": _position(y),
                "stroke": stroke,
                "strokeWidth": stroke_width,
                "dash": list(dash) if dash is not None else None,
                "label": label,
                "text": text,
                "axis": axis,
                "facet": "repeat" if repeat else None,
                "id": id,
            },
            table,
        )

    def region(
        self,
        *,
        x1: Position | None = None,
        x2: Position | None = None,
        y1: Position | None = None,
        y2: Position | None = None,
        label: str | None = None,
        text: str | None = None,
        data: Any = None,
        fill: str | None = None,
        fill_opacity: float | None = None,
        axis: Literal["left", "right"] | None = None,
        repeat: bool = False,
        id: str | None = None,
    ) -> Chart:
        """Shaded regions: from ``x1`` to ``x2``, from ``y1`` to ``y2``, or both.

        Numbers or datetimes shade one region; column names shade one per
        row. Add regions before the marks they highlight to draw them
        underneath.
        """
        for start, end, name in ((x1, x2, "x"), (y1, y2, "y")):
            if (start is None) != (end is None):
                raise ValueError(f"region needs both {name}1 and {name}2, or neither")
        if x1 is None and y1 is None:
            raise ValueError("region needs x1 and x2, y1 and y2, or both")
        table = self._annotation_table(
            data, {"x1": x1, "x2": x2, "y1": y1, "y2": y2}, text, "region"
        )
        return self._add(
            {
                "type": "region",
                "x1": _position(x1),
                "x2": _position(x2),
                "y1": _position(y1),
                "y2": _position(y2),
                "fill": fill,
                "fillOpacity": fill_opacity,
                "label": label,
                "text": text,
                "axis": axis,
                "facet": "repeat" if repeat else None,
                "id": id,
            },
            table,
        )

    def text(
        self,
        *,
        x: Position,
        y: Position,
        label: str | None = None,
        text: str | None = None,
        data: Any = None,
        fill: str | None = None,
        anchor: Literal["start", "middle", "end"] | None = None,
        dx: float | None = None,
        dy: float | None = None,
        axis: Literal["left", "right"] | None = None,
        repeat: bool = False,
        id: str | None = None,
    ) -> Chart:
        """Text at ``(x, y)``: ``label`` for constant text, or ``text`` naming a column.

        Column names for ``x`` or ``y`` draw one label per row. ``dx`` and
        ``dy`` offset labels in pixels; positive ``dy`` moves down.
        """
        if (label is None) == (text is None):
            raise ValueError("text needs exactly one of label or text")
        table = self._annotation_table(data, {"x": x, "y": y}, text, "text")
        return self._add(
            {
                "type": "text",
                "x": _position(x),
                "y": _position(y),
                "label": label,
                "text": text,
                "fill": fill,
                "anchor": anchor,
                "dx": dx,
                "dy": dy,
                "axis": axis,
                "facet": "repeat" if repeat else None,
                "id": id,
            },
            table,
        )

    # Output ----------------------------------------------------------------

    def to_spec(self) -> tuple[dict[str, Any], list[bytes]]:
        """The portable chart spec and the binary buffers its columns reference."""
        return assemble_spec(
            self._options,
            self._facet_spec(),
            self._used_columns(),
            self._mark_specs(),
            self._derived_specs(),
        )

    def widget(self) -> ChartWidget:
        """A live notebook widget of this chart: Python can update it after display,
        and it reports zooming, brushing, hovering, and clicks back.

        Needs the ``notebook`` extra (``pip install 'herceg[notebook]'``).
        """
        from .widget import ChartWidget

        return ChartWidget(self)

    def to_html(self, *, full_page: bool = True) -> str:
        """Self-contained HTML that renders the chart, with herceg and the data embedded."""
        return _render.html(*self.to_spec(), full_page=full_page)

    def to_svg(self) -> str:
        """Standalone SVG, rendered without a browser (requires the ``export`` extra)."""
        return _render.svg(*self.to_spec())

    def to_png(self, *, scale: float = 2) -> bytes:
        """PNG at ``scale`` times the chart size (requires the ``export`` extra)."""
        return _render.png(self.to_svg(), scale=scale)

    def to_pdf(self) -> bytes:
        """One-page vector PDF sized to the chart (requires the ``export`` extra)."""
        return _render.pdf(*self.to_spec())

    def save(self, path: str, *, scale: float = 2) -> None:
        """Writes ``.html``, ``.svg``, ``.png``, or ``.pdf``, chosen by the file extension."""
        lower = str(path).lower()
        if lower.endswith(".html"):
            content: str | bytes = self.to_html()
        elif lower.endswith(".svg"):
            content = self.to_svg()
        elif lower.endswith(".png"):
            content = self.to_png(scale=scale)
        elif lower.endswith(".pdf"):
            content = self.to_pdf()
        else:
            raise ValueError(f"Unknown file type for {path!r}; use .html, .svg, .png, or .pdf")
        mode = "wb" if isinstance(content, bytes) else "w"
        with open(path, mode, **({} if mode == "wb" else {"encoding": "utf-8"})) as file:
            file.write(content)

    def show(self) -> None:
        """Displays the chart in a notebook, or opens it in a browser elsewhere."""
        _render.show(self)

    def _repr_html_(self) -> str:
        return _render.notebook_html(*self.to_spec(), height=self._options.get("height"))

    # Internals -------------------------------------------------------------

    def _facet_spec(self) -> dict[str, Any] | None:
        if self._facet is None:
            return None
        return {"field": self._facet, "columns": self._facet_columns}

    def _used_fields(self) -> dict[int, set[str]]:
        """The columns each table must send: those marks read, and those derived
        tables need from their sources."""
        used: dict[int, set[str]] = {}
        for spec, table in self._marks:
            if table is not None:
                fields = used.setdefault(table, set())
                fields.update(_fields(spec))
                if self._facet is not None and spec.get("facet") is None:
                    fields.add(self._facet)
        # Later tables derive from earlier ones, so needs flow back in one pass.
        for table in sorted(self._derived, reverse=True):
            if table not in used:
                continue
            source = self._derived[table]
            columns = self._tables[source][1]
            needs = used.setdefault(source, set())
            needs.update(self._tables[table][0].source_columns(used[table]))
            # A table sent without columns has no rows: send one, so counts
            # survive. Derived tables compute their rows whatever is read.
            if source not in self._derived and columns.names and not needs & set(columns.names):
                needs.add(_convertible(columns))
        return used

    def _used_columns(self) -> dict[str, dict[str, Column]]:
        """The columns sent, by spec table name; other columns are never sent."""
        return {
            table_name(table): {
                # A point's symbol may name a shape rather than a column.
                field: self._tables[table][1].column(field)
                for field in sorted(fields)
                if field in self._tables[table][1].names
            }
            for table, fields in self._used_fields().items()
            if table not in self._derived
        }

    def _derived_specs(self) -> dict[str, dict[str, Any]]:
        """The derived tables marks read, directly or through other derived tables."""
        used = self._used_fields()
        return {
            table_name(table): {
                "source": table_name(source),
                "transform": list(self._tables[table][0].steps),
            }
            for table, source in sorted(self._derived.items())
            if table in used
        }

    def _mark_specs(self) -> list[dict[str, Any]]:
        return [
            {
                **{key: value for key, value in mark.items() if value is not None},
                **({"data": table_name(table)} if table is not None else {}),
            }
            for mark, table in self._marks
        ]

    def _table_names(self) -> list[tuple[Any, str]]:
        """Each data source given to the chart or its marks, with its spec table name."""
        return [(source, table_name(index)) for index, (source, _) in enumerate(self._tables)]

    def _table(self, data: Any, converted: Table | None = None) -> int:
        for index, (source, _) in enumerate(self._tables):
            if source is data:
                return index
        if isinstance(data, Derived):
            source = self._table(data.source, data._table)
            self._tables.append((data, _DerivedColumns(data)))
            self._derived[len(self._tables) - 1] = source
        else:
            self._tables.append((data, converted or Table(data)))
        return len(self._tables) - 1

    def _mark_table(self, data: Any) -> int:
        if data is not None:
            return self._table(data)
        if self._default is None:
            raise ValueError("Pass data to the chart or to this mark")
        return self._default

    def _require(self, table: int, field: str | None, kinds: tuple[str, ...], role: str) -> None:
        if field is None:
            return
        source = self._tables[table][1]
        if field not in source.names:
            available = ", ".join(repr(name) for name in source.names)
            raise KeyError(f"{role}: no column {field!r}; the data has {available}")
        kind = source.column(field).kind
        if kind not in kinds:
            raise TypeError(
                f"{role}: column {field!r} holds {kind} values; expected {' or '.join(kinds)}"
            )

    def _kind(self, table: int, field: str) -> str | None:
        source = self._tables[table][1]
        return source.column(field).kind if field in source.names else None

    def _single_or_series(self, fields: str | list[str], series: str | None, role: str) -> None:
        if series is not None and not isinstance(fields, str):
            raise ValueError(f"{role}: use several value columns or a series column, not both")

    def _require_many(
        self, table: int, fields: str | Sequence[str], kinds: tuple[str, ...], role: str
    ):
        names = [fields] if isinstance(fields, str) else list(fields)
        for name in names:
            self._require(table, name, kinds, role)
        return names[0] if len(names) == 1 else names

    def _annotation_table(
        self, data: Any, positions: dict[str, Any], text: str | None, role: str
    ) -> int | None:
        """The table an annotation reads, when a position or its text is a column."""
        fields = {name: value for name, value in positions.items() if isinstance(value, str)}
        if not fields and text is None:
            return None
        table = self._mark_table(data)
        for name, field in fields.items():
            self._require(table, field, _NUMERIC, f"{role} {name}")
        self._require(table, text, ("category", "number"), f"{role} text")
        return table

    def _add(self, spec: dict[str, Any], table: int | None) -> Chart:
        layouts = [mark["type"] for mark, _ in self._marks if mark["type"] in _LAYOUT_MARKS]
        if layouts or (spec["type"] in _LAYOUT_MARKS and self._marks):
            kind = layouts[0] if layouts else spec["type"]
            raise ValueError(f"a {kind} has its chart to itself; draw other marks in another chart")
        if spec.get("axis") not in (None, "left", "right"):
            raise ValueError(f"axis must be 'left' or 'right', not {spec['axis']!r}")
        if self._facet is not None and spec.get("axis") == "right":
            raise ValueError("charts with facets cannot use the right axis yet")
        if self._facet is not None and table is not None and spec.get("facet") is None:
            self._require(table, self._facet, ("category",), "facet")
            kind = spec["type"]
            if kind in ("heatmap", "histogram", "boxplot", "violin", "rule", "region", "text") or (
                kind == "bar" and spec.get("stack")
            ):
                name = "stacked bar" if kind == "bar" else kind
                raise ValueError(
                    f"{name} marks over a table cannot be split into panels yet; "
                    "pass repeat=True to draw them whole in every panel"
                )
        self._marks.append((spec, table))
        return self


#: Marks that lay out their own chart, with no axes.
_LAYOUT_MARKS = ("pie", "treemap", "sunburst")


#: Chart options a live chart can change after display: all but data and facets,
#: which decide the columns sent.
OPTIONS = (
    *("title", "description", "width", "height", "x", "y", "y_right", "legend", "tooltip"),
    *("zoom", "brush", "sync", "renderer", "theme", "locale", "time_zone"),
)


def spec_options(settings: dict[str, Any]) -> dict[str, Any]:
    """The spec's chart options from Chart's keyword arguments; unset ones are left out."""
    tooltip = settings["tooltip"]
    interaction = {
        key: value
        for key, value in {
            "zoom": settings["zoom"] or None,
            "brush": settings["brush"],
            "sync": settings["sync"],
        }.items()
        if value
    }
    options = {
        "title": settings["title"],
        "description": settings["description"],
        "width": settings["width"],
        "height": settings["height"],
        "x": _axis(settings["x"]),
        "y": _axis(settings["y"]),
        "yRight": _axis(settings["y_right"]),
        "legend": settings["legend"],
        "tooltip": tooltip if tooltip is None or isinstance(tooltip, bool) else {"mode": tooltip},
        "interaction": interaction or None,
        "renderer": settings["renderer"],
        "theme": _theme(settings["theme"]),
        "locale": settings["locale"],
        "timeZone": settings["time_zone"],
    }
    return {key: value for key, value in options.items() if value is not None}


def assemble_spec(
    options: dict[str, Any],
    facet: dict[str, Any] | None,
    tables: dict[str, dict[str, Column]],
    marks: list[dict[str, Any]],
    derived: dict[str, dict[str, Any]] | None = None,
) -> tuple[dict[str, Any], list[bytes]]:
    """A spec and its buffers from chart options, columns by table name, mark
    specs, and derived tables by name."""
    buffers: list[bytes] = []
    spec: dict[str, Any] = {"version": 1, **options}
    if facet is not None:
        spec["facet"] = {key: value for key, value in facet.items() if value is not None}
    if tables or derived:
        spec["data"] = {
            name: {"columns": columns_spec(columns, buffers)} for name, columns in tables.items()
        }
        spec["data"].update(derived or {})
    spec["marks"] = marks
    return spec, buffers


def columns_spec(columns: dict[str, Column], buffers: list[bytes]) -> dict[str, Any]:
    """Spec columns whose values are appended to `buffers`, which they index."""
    return {field: _column_spec(column, buffers) for field, column in columns.items()}


class _DerivedColumns:
    """A derived table's columns, as charts check fields: names and kinds, no values."""

    def __init__(self, derived: Derived) -> None:
        self.names = tuple(derived._kinds)
        self._kinds = derived._kinds

    def column(self, name: str) -> Column:
        if name not in self._kinds:
            raise KeyError(name)
        return Column(self._kinds[name], np.empty(0))


def _convertible(columns: Table) -> str:
    """The first of a table's columns that converts, to send for its rows alone."""
    errors: list[Exception] = []
    for name in columns.names:
        try:
            columns.column(name)
        except (TypeError, ValueError) as error:
            errors.append(error)
            continue
        return name
    raise ValueError(
        "derive: counting the rows of this data needs one column of numbers, strings, "
        f"or dates; column {columns.names[0]!r} holds unsupported values"
    ) from errors[0]


def table_name(index: int) -> str:
    return "data" if index == 0 else f"data{index + 1}"


def _fields(spec: dict[str, Any]) -> set[str]:
    fields: set[str] = set()
    for key in (
        *("x", "y", "x1", "x2", "y1", "y2", "xError", "yError", "series", "value", "text"),
        "category",
        *("path", "node", "parent"),
        *("open", "high", "low", "close"),
        *("r", "fillOpacity", "color", "symbol"),
    ):
        value = spec.get(key)
        if isinstance(value, str):
            fields.add(value)
        elif isinstance(value, list):
            fields.update(value)
    return fields


def _column_spec(column: Column, buffers: list[bytes]) -> dict[str, Any]:
    buffers.append(column.values.tobytes())
    index = len(buffers) - 1
    if column.kind == "category":
        return {"type": "category", "codes": index, "dictionary": list(column.dictionary)}
    dtype = "float32" if column.values.dtype.itemsize == 4 else "float64"
    return {"type": column.kind, "dtype": dtype, "buffer": index}


def _axis(axis: Axis | dict[str, Any] | None) -> dict[str, Any] | None:
    if axis is None:
        return None
    if isinstance(axis, dict):
        axis = Axis(**axis)
    return axis._spec() or None


_THEME_KEYS = {
    "font_size": "fontSize",
    "title_size": "titleSize",
    "grid_dash": "gridDash",
    "line_width": "lineWidth",
    "bar_radius": "barRadius",
    "tooltip_background": "tooltipBackground",
    "tooltip_border": "tooltipBorder",
}


def _theme(theme: str | dict[str, Any] | None) -> Any:
    if theme is None or isinstance(theme, str):
        return theme
    return {_THEME_KEYS.get(key, key): value for key, value in theme.items()}


def _colors(colors: str | Sequence[str] | None, role: str) -> str | list[str] | None:
    """A scheme name, checked, or a list of colors."""
    if isinstance(colors, str):
        if colors not in SCHEMES:
            raise ValueError(f"{role}: unknown scheme {colors!r}; use one of {', '.join(SCHEMES)}")
        return colors
    return list(colors) if colors is not None else None


def _range(
    values: tuple[float, float] | None, role: str, *, minimum: float = -math.inf
) -> list[float] | None:
    """Two finite ascending numbers, at least ``minimum``, as a list."""
    if values is None:
        return None
    low, high = (float(v) for v in values)
    if not (math.isfinite(low) and math.isfinite(high) and minimum <= low < high):
        bound = "" if minimum == -math.inf else f", from {minimum:g} up"
        raise ValueError(f"{role} must be two finite numbers, ascending{bound}, not {values!r}")
    return [low, high]


def _midpoint(
    midpoint: float | None, domain: tuple[float, float] | None, role: str
) -> float | None:
    """A finite color midpoint, inside the color domain when there is one."""
    if midpoint is None:
        return None
    if not math.isfinite(midpoint):
        raise ValueError(f"{role} color_midpoint must be a finite number, not {midpoint!r}")
    if domain is not None and not domain[0] <= midpoint <= domain[1]:
        raise ValueError(f"{role} color_midpoint {midpoint!r} is outside color_domain {domain!r}")
    return float(midpoint)


def _position(value: Any) -> str | float | None:
    """Column names pass through; datetimes become epoch milliseconds."""
    if value is None or isinstance(value, str):
        return value
    if isinstance(value, numbers.Real):
        return float(value)
    from ._data import _time_ms

    return _time_ms(value)


# Express-style helpers: one call, one chart -----------------------------------


def line(
    data: Any, x: str, y: str | Sequence[str], *, series: str | None = None, **options: Any
) -> Chart:
    """A line chart. Remaining keyword arguments are chart options (title, x, y, ...)."""
    return Chart(data, **options).line(x, y, series=series)


def area(
    data: Any,
    x: str,
    y: str | Sequence[str],
    *,
    series: str | None = None,
    stack: bool = False,
    **options: Any,
) -> Chart:
    """An area chart, stacked with ``stack=True``."""
    return Chart(data, **options).area(x, y, series=series, stack=stack)


def bar(
    data: Any,
    x: str | Sequence[str],
    y: str | Sequence[str],
    *,
    series: str | None = None,
    stack: bool = False,
    labels: bool | dict[str, Any] = False,
    **options: Any,
) -> Chart:
    """A bar chart, grouped or stacked; horizontal when ``y`` is a category."""
    return Chart(data, **options).bar(x, y, series=series, stack=stack, labels=labels)


def scatter(
    data: Any,
    x: str,
    y: str,
    *,
    series: str | None = None,
    r: float | str | None = None,
    r_range: tuple[float, float] | None = None,
    color: str | None = None,
    colors: str | Sequence[str] | None = None,
    color_domain: tuple[float, float] | None = None,
    color_midpoint: float | None = None,
    symbol: str | None = None,
    fill_opacity: float | str | None = None,
    **options: Any,
) -> Chart:
    """A scatter plot; ``r``, ``color``, and ``symbol`` can encode columns (see ``Chart.point``)."""
    return Chart(data, **options).point(
        x,
        y,
        series=series,
        r=r,
        r_range=r_range,
        color=color,
        colors=colors,
        color_domain=color_domain,
        color_midpoint=color_midpoint,
        symbol=symbol,
        fill_opacity=fill_opacity,
    )


def heatmap(
    data: Any,
    x: str,
    y: str,
    value: str,
    *,
    colors: str | Sequence[str] | None = None,
    color_domain: tuple[float, float] | None = None,
    color_midpoint: float | None = None,
    **options: Any,
) -> Chart:
    """A heatmap; ``colors`` is a scheme name or a list of hex colors (see ``Chart.heatmap``)."""
    return Chart(data, **options).heatmap(
        x, y, value, colors=colors, color_domain=color_domain, color_midpoint=color_midpoint
    )


def histogram(
    data: Any,
    x: str,
    *,
    bins: int | dict[str, float] | None = None,
    series: str | None = None,
    normalize: Literal["count", "percent", "density"] | None = None,
    stack: bool = False,
    **options: Any,
) -> Chart:
    """A histogram of ``x``'s values."""
    return Chart(data, **options).histogram(
        x, bins=bins, series=series, normalize=normalize, stack=stack
    )


def pie(
    data: Any,
    category: str,
    value: str | None = None,
    *,
    inner_radius: float | None = None,
    sort: Literal["value", "input"] | None = None,
    labels: bool | None = None,
    **options: Any,
) -> Chart:
    """A pie, or with ``inner_radius`` a donut, of ``value`` per ``category``."""
    return Chart(data, **options).pie(
        category, value, inner_radius=inner_radius, sort=sort, labels=labels
    )


def boxplot(
    data: Any,
    x: str,
    y: str,
    *,
    series: str | None = None,
    **options: Any,
) -> Chart:
    """Box plots of ``y`` per category of ``x``, or of ``x`` per category of ``y``."""
    return Chart(data, **options).boxplot(x, y, series=series)


def violin(
    data: Any,
    x: str,
    y: str,
    *,
    series: str | None = None,
    bandwidth: float | None = None,
    **options: Any,
) -> Chart:
    """Violins of ``y`` per category of ``x``, or of ``x`` per category of ``y``."""
    return Chart(data, **options).violin(x, y, series=series, bandwidth=bandwidth)


def treemap(
    data: Any,
    path: Sequence[str] | None = None,
    value: str | None = None,
    *,
    node: str | None = None,
    parent: str | None = None,
    labels: bool | None = None,
    **options: Any,
) -> Chart:
    """A treemap of a tree given by ``path`` columns, or ``node`` and ``parent``."""
    return Chart(data, **options).treemap(path, value, node=node, parent=parent, labels=labels)


def sunburst(
    data: Any,
    path: Sequence[str] | None = None,
    value: str | None = None,
    *,
    node: str | None = None,
    parent: str | None = None,
    labels: bool | None = None,
    **options: Any,
) -> Chart:
    """A sunburst of a tree given by ``path`` columns, or ``node`` and ``parent``."""
    return Chart(data, **options).sunburst(path, value, node=node, parent=parent, labels=labels)


def candlestick(
    data: Any,
    x: str,
    open: str,
    high: str,
    low: str,
    close: str,
    *,
    rise: str | None = None,
    fall: str | None = None,
    label: str | None = None,
    **options: Any,
) -> Chart:
    """A candlestick chart of open, high, low, and close prices."""
    return Chart(data, **options).candlestick(
        x, open, high, low, close, rise=rise, fall=fall, label=label
    )
