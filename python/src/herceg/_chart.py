"""Charts: a Pythonic builder for the portable chart spec."""

from __future__ import annotations

import datetime as _dt
import numbers
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Literal

from . import _render
from ._data import Column, Table

Tooltip = Literal["nearest-x", "nearest-y", "nearest"]
Curve = Literal["linear", "step", "step-before", "step-after"]

_NUMERIC = ("number", "time")

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
        id: str | None = None,
    ) -> Chart:
        """Bars: one band per category of x, or bars centered on number or time x.

        A category ``y`` makes the bars horizontal, with lengths in ``x``.
        """
        table = self._mark_table(data)
        if isinstance(y, str) and self._kind(table, y) == "category":
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
        r: float | None = None,
        fill: str | None = None,
        fill_opacity: float | None = None,
        label: str | None = None,
        id: str | None = None,
    ) -> Chart:
        """Scatter points."""
        table = self._mark_table(data)
        self._require(table, x, _NUMERIC, "point x")
        self._require(table, y, _NUMERIC, "point y")
        self._require(table, series, ("category",), "point series")
        return self._add(
            {
                "type": "point",
                "x": x,
                "y": y,
                "series": series,
                "r": r,
                "fill": fill,
                "fillOpacity": fill_opacity,
                "label": label,
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
        colors: Sequence[str] | None = None,
        label: str | None = None,
        id: str | None = None,
    ) -> Chart:
        """A grid of cells colored by ``value``; one column or row per distinct x or y."""
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
                "colors": list(colors) if colors is not None else None,
                "label": label,
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
        id: str | None = None,
    ) -> Chart:
        """Shaded regions: from ``x1`` to ``x2``, from ``y1`` to ``y2``, or both.

        Numbers or datetimes shade one region; column names shade one per
        row. Add regions before the marks they highlight to draw them
        underneath.
        """
        for start, end, axis in ((x1, x2, "x"), (y1, y2, "y")):
            if (start is None) != (end is None):
                raise ValueError(f"region needs both {axis}1 and {axis}2, or neither")
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
                used.setdefault(table, set()).update(_fields(spec))
        data = {}
        for table, fields in used.items():
            source = self._tables[table][1]
            data[_table_name(table)] = {
                "columns": {
                    field: _column_spec(source.column(field), buffers) for field in sorted(fields)
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

    def save(self, path: str, *, scale: float = 2) -> None:
        """Writes ``.html``, ``.svg``, or ``.png``, chosen by the file extension."""
        lower = str(path).lower()
        if lower.endswith(".html"):
            content: str | bytes = self.to_html()
        elif lower.endswith(".svg"):
            content = self.to_svg()
        elif lower.endswith(".png"):
            content = self.to_png(scale=scale)
        else:
            raise ValueError(f"Unknown file type for {path!r}; use .html, .svg, or .png")
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
        self._marks.append((spec, table))
        return self


def _table_name(index: int) -> str:
    return "data" if index == 0 else f"data{index + 1}"


def _fields(spec: dict[str, Any]) -> set[str]:
    fields: set[str] = set()
    for key in ("x", "y", "x1", "x2", "y1", "y2", "series", "value", "text"):
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
    **options: Any,
) -> Chart:
    """A bar chart, grouped or stacked; horizontal when ``y`` is a category."""
    return Chart(data, **options).bar(x, y, series=series, stack=stack)


def scatter(
    data: Any, x: str, y: str, *, series: str | None = None, r: float | None = None, **options: Any
) -> Chart:
    """A scatter plot."""
    return Chart(data, **options).point(x, y, series=series, r=r)


def heatmap(data: Any, x: str, y: str, value: str, **options: Any) -> Chart:
    """A heatmap."""
    return Chart(data, **options).heatmap(x, y, value)
