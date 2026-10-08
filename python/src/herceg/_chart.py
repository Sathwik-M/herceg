"""Charts: a Pythonic builder for the portable chart spec."""

from __future__ import annotations

import datetime as _dt
import math
import numbers
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Literal

from . import _render
from ._data import Column, Table

Tooltip = Literal["nearest-x", "nearest-y", "nearest"]
Curve = Literal["linear", "step", "step-before", "step-after"]

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
        theme: Literal["light", "dark"] | dict[str, Any] | None = None,
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
        self._tables: list[tuple[Any, Table]] = []
        self._default = self._table(data) if data is not None else None
        self._marks: list[tuple[dict[str, Any], int | None]] = []
        self._options: dict[str, Any] = {
            "title": title,
            "description": description,
            "width": width,
            "height": height,
            "x": _axis(x),
            "y": _axis(y),
            "yRight": _axis(y_right),
            "facet": {"field": facet, "columns": facet_columns} if facet is not None else None,
            "legend": legend,
            "tooltip": tooltip if isinstance(tooltip, bool) else {"mode": tooltip},
            "interaction": {
                key: value
                for key, value in {"zoom": zoom or None, "brush": brush, "sync": sync}.items()
                if value
            }
            or None,
            "renderer": renderer,
            "theme": _theme(theme),
            "locale": locale,
            "timeZone": time_zone,
        }

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
        buffers: list[bytes] = []
        used: dict[int, set[str]] = {}
        for spec, table in self._marks:
            if table is not None:
                fields = used.setdefault(table, set())
                fields.update(_fields(spec))
                if self._facet is not None and spec.get("facet") is None:
                    fields.add(self._facet)
        data = {}
        for table, fields in used.items():
            source = self._tables[table][1]
            data[_table_name(table)] = {
                "columns": {
                    # A point's symbol may name a shape rather than a column.
                    field: _column_spec(source.column(field), buffers)
                    for field in sorted(fields)
                    if field in source.names
                }
            }
        spec: dict[str, Any] = {"version": 1}
        spec.update({key: value for key, value in self._options.items() if value is not None})
        if data:
            spec["data"] = data
        spec["marks"] = [
            {
                **{key: value for key, value in mark.items() if value is not None},
                **({"data": _table_name(table)} if table is not None else {}),
            }
            for mark, table in self._marks
        ]
        return spec, buffers

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

    def _table(self, data: Any) -> int:
        for index, (source, _) in enumerate(self._tables):
            if source is data:
                return index
        self._tables.append((data, Table(data)))
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
        if spec.get("axis") not in (None, "left", "right"):
            raise ValueError(f"axis must be 'left' or 'right', not {spec['axis']!r}")
        if self._facet is not None and spec.get("axis") == "right":
            raise ValueError("charts with facets cannot use the right axis yet")
        if self._facet is not None and table is not None and spec.get("facet") is None:
            self._require(table, self._facet, ("category",), "facet")
            kind = spec["type"]
            if kind in ("heatmap", "histogram", "rule", "region", "text") or (
                kind == "bar" and spec.get("stack")
            ):
                name = "stacked bar" if kind == "bar" else kind
                raise ValueError(
                    f"{name} marks over a table cannot be split into panels yet; "
                    "pass repeat=True to draw them whole in every panel"
                )
        self._marks.append((spec, table))
        return self


def _table_name(index: int) -> str:
    return "data" if index == 0 else f"data{index + 1}"


def _fields(spec: dict[str, Any]) -> set[str]:
    fields: set[str] = set()
    for key in (
        *("x", "y", "x1", "x2", "y1", "y2", "xError", "yError", "series", "value", "text"),
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


_THEME_KEYS = {"font_size": "fontSize"}


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
