"""Charts: a Pythonic builder for the portable chart spec."""

from __future__ import annotations

import datetime as _dt
import math
import numbers
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal, Protocol, TypedDict

import numpy as np

from . import _geo, _render
from ._data import Column, Table
from ._derive import Derived

# Annotations read at runtime (typing.get_type_hints) need Unpack too.
if sys.version_info >= (3, 11):
    from typing import Unpack
else:
    from typing_extensions import Unpack

if TYPE_CHECKING:
    from .widget import ChartWidget

TooltipMode = Literal["nearest-x", "nearest-y", "nearest"]
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


_WEEKDAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


@dataclass(frozen=True)
class Break:
    """Time a time axis leaves out, in the chart's ``time_zone``, so the time
    left (trading sessions) is drawn without gaps. Give exactly one of:

    - ``weekdays``: days of the week, ``("sat", "sun")``;
    - ``hours``: a daily span of wall-clock time, ``("16:00", "09:30")``
      (strings or ``datetime.time``), wrapping past midnight when it ends
      earlier than it starts; across a clock change, the instants whose
      wall-clock time is in it;
    - ``dates``: whole calendar days, as dates or ``"YYYY-MM-DD"`` strings;
    - ``start`` and ``end``: a span of instants (naive datetimes are UTC).

    Starts are included, ends are not. Data inside a break is not drawn;
    lines and areas join the points on either side.
    """

    weekdays: Sequence[str] | None = None
    hours: tuple[str | _dt.time, str | _dt.time] | None = None
    dates: Sequence[str | _dt.date] | None = None
    start: Any = None
    end: Any = None

    def _spec(self) -> dict[str, Any]:
        given = [
            name
            for name, value in (
                ("weekdays", self.weekdays),
                ("hours", self.hours),
                ("dates", self.dates),
                ("start", self.start),
            )
            if value is not None
        ]
        if len(given) != 1 and not (not given and self.end is not None):
            raise ValueError(
                "a Break has one of weekdays, hours, dates, or start and end, "
                f"not {' and '.join(given) or 'none'}"
            )
        if self.weekdays is not None:
            days = [self.weekdays] if isinstance(self.weekdays, str) else list(self.weekdays)
            bad = [day for day in days if day not in _WEEKDAYS]
            if not days or bad:
                raise ValueError(
                    f"weekdays must be names from {', '.join(_WEEKDAYS)}, not {self.weekdays!r}"
                )
            return {"weekdays": days}
        if self.hours is not None:
            if isinstance(self.hours, str) or len(self.hours) != 2:
                raise ValueError(
                    f'hours must be two times of day, ("16:00", "09:30"), not {self.hours!r}'
                )
            return {"hours": [_clock(value) for value in self.hours]}
        if self.dates is not None:
            dates = [self.dates] if isinstance(self.dates, str | _dt.date) else list(self.dates)
            if not dates:
                raise ValueError("dates needs at least one date")
            return {"dates": [_iso_date(value) for value in dates]}
        if self.start is None or self.end is None:
            raise ValueError("a Break of instants needs both start and end")
        start, end = _instant(self.start, "start"), _instant(self.end, "end")
        if not end > start:
            raise ValueError(f"a Break must end after it starts, not at {self.end!r}")
        return {"from": start, "to": end}


def _clock(value: str | _dt.time) -> str:
    """A time of day as "HH:MM"."""
    if isinstance(value, _dt.time):
        if value.second or value.microsecond:
            raise ValueError(f"break hours are whole minutes, not {value!r}")
        return f"{value.hour:02d}:{value.minute:02d}"
    if not isinstance(value, str) or len(value.split(":")) != 2:
        raise ValueError(f'break hours are times of day, "HH:MM", not {value!r}')
    return value


def _iso_date(value: str | _dt.date) -> str:
    if isinstance(value, _dt.datetime):
        raise ValueError(f"break dates are whole days; pass a date, not {value!r}")
    if isinstance(value, _dt.date):
        return value.isoformat()
    try:
        _dt.date.fromisoformat(value)
    except (TypeError, ValueError):
        raise ValueError(f'break dates are dates or "YYYY-MM-DD" strings, not {value!r}') from None
    if len(value) != 10:
        raise ValueError(f'break dates are dates or "YYYY-MM-DD" strings, not {value!r}')
    return value


def _instant(value: Any, role: str) -> int:
    """An instant as whole epoch milliseconds."""
    if isinstance(value, numbers.Real) and not isinstance(value, bool):
        ms = float(value)
    else:
        from ._data import _time_ms

        ms = _time_ms(value)
    if not (math.isfinite(ms) and ms == int(ms)):
        raise ValueError(f"a Break's {role} must be a whole millisecond, not {value!r}")
    return int(ms)


def _break(rule: Break | dict[str, Any]) -> dict[str, Any]:
    if isinstance(rule, Break):
        return rule._spec()
    if isinstance(rule, dict):
        fields = dict(rule)
        # The spec's names for a span of instants.
        if "from" in fields or "to" in fields:
            fields["start"], fields["end"] = fields.pop("from", None), fields.pop("to", None)
        try:
            return Break(**fields)._spec()
        except TypeError:
            raise ValueError(
                f"a break has weekdays, hours, dates, or from and to, not {sorted(rule)}"
            ) from None
    raise TypeError(f"breaks are Break objects or dicts, not {rule!r}")


#: Intl.NumberFormat options, as herceg's spec reader knows them.
_NUMBER_FORMAT = frozenset(
    ("localeMatcher", "numberingSystem", "style", "currency", "currencyDisplay")
    + ("currencySign", "unit", "unitDisplay", "notation", "compactDisplay", "signDisplay")
    + ("useGrouping", "minimumIntegerDigits", "minimumFractionDigits", "maximumFractionDigits")
    + ("minimumSignificantDigits", "maximumSignificantDigits", "roundingMode")
    + ("roundingPriority", "roundingIncrement", "trailingZeroDisplay")
)
#: Intl.DateTimeFormat options, likewise.
_TIME_FORMAT = frozenset(
    ("localeMatcher", "numberingSystem", "calendar", "timeZone", "hour12", "hourCycle")
    + ("formatMatcher", "dateStyle", "timeStyle", "weekday", "era", "year", "month", "day")
    + ("dayPeriod", "hour", "minute", "second", "fractionalSecondDigits", "timeZoneName")
)


def _check_format(format: dict[str, Any] | None, role: str, known: frozenset[str]) -> None:
    """Refuses Intl options that do not exist, which Intl would silently ignore."""
    unknown = [key for key in format or () if key not in known]
    if unknown:
        raise ValueError(f"{role}: {unknown[0]!r} is not an Intl format option")


@dataclass
class Axis:
    """Scale and axis options for x or y. Unset options use herceg's defaults.

    ``breaks``, on a time x axis only, leave out spans of time (see ``Break``)::

        hg.Axis(breaks=[hg.Break(weekdays=("sat", "sun")), hg.Break(hours=("16:00", "09:30"))])
    """

    type: Literal["linear", "log", "time"] | None = None
    domain: tuple[float, float] | None = None
    label: str | None = None
    nice: bool | None = None
    zero: bool | None = None
    grid: bool | None = None
    ticks: int | None = None
    format: dict[str, Any] | None = None
    show: bool | None = None
    breaks: Sequence[Break | dict[str, Any]] | None = None

    def __post_init__(self) -> None:
        _check_format(self.format, "axis format", _NUMBER_FORMAT | _TIME_FORMAT)

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
            "breaks": [_break(rule) for rule in self.breaks] if self.breaks is not None else None,
        }
        return {key: value for key, value in spec.items() if value is not None}


ProjectionName = Literal[
    "equal-earth", "natural-earth", "mercator", "equirectangular", "conic-equal-area"
]
PROJECTIONS = ("equal-earth", "natural-earth", "mercator", "equirectangular", "conic-equal-area")


@dataclass
class Projection:
    """How a map is projected (the chart's ``projection``).

    ``type`` is ``"equal-earth"`` (the default, for world maps),
    ``"natural-earth"``, ``"mercator"``, ``"equirectangular"``, or
    ``"conic-equal-area"`` (Albers, for countries and continents).
    ``central_meridian`` is the longitude at the map's center (0, or for the
    conic projection the middle of the data); ``parallels`` are the conic
    projection's standard parallels (by default a sixth of the data's
    latitudes in from either end). ``fit`` is what the map fits into its
    plot: ``"data"`` (the default), ``"world"``, or a box
    ``((west, south), (east, north))`` in degrees, whose west may lie east
    of its east to cross the antimeridian.
    """

    type: ProjectionName = "equal-earth"
    central_meridian: float | None = None
    parallels: tuple[float, float] | None = None
    fit: Literal["data", "world"] | tuple[tuple[float, float], tuple[float, float]] | None = None

    def _spec(self) -> dict[str, Any]:
        if self.type not in PROJECTIONS:
            raise ValueError(
                f"projection must be one of {', '.join(map(repr, PROJECTIONS))}, not {self.type!r}"
            )
        if self.central_meridian is not None and not _finite(self.central_meridian):
            raise ValueError(
                f"central_meridian must be a finite longitude, not {self.central_meridian!r}"
            )
        parallels = None
        if self.parallels is not None:
            parallels = _range(self.parallels, "projection parallels", minimum=-90)
            if parallels is not None and parallels[1] > 90:
                raise ValueError(f"projection parallels must be latitudes, not {self.parallels!r}")
        fit: Any = self.fit
        if fit not in (None, "data", "world"):
            try:
                (west, south), (east, north) = fit
                box = [[float(west), float(south)], [float(east), float(north)]]
            except (TypeError, ValueError):
                raise ValueError(
                    'projection fit must be "data", "world", or ((west, south), (east, north)), '
                    f"not {fit!r}"
                ) from None
            (west, south), (east, north) = box
            if not (
                all(map(math.isfinite, [west, south, east, north]))
                and abs(west) <= 540
                and abs(east) <= 540
                and -90 <= south < north <= 90
                and west != east
            ):
                raise ValueError(
                    "projection fit needs longitudes and latitudes in degrees, south below "
                    f"north and west apart from east, not {fit!r}"
                )
            fit = box
        spec = {
            "type": self.type,
            "centralMeridian": None
            if self.central_meridian is None
            else float(self.central_meridian),
            "parallels": parallels,
            "fit": fit,
        }
        return {key: value for key, value in spec.items() if value is not None}


@dataclass
class Tooltip:
    """Tooltip options: ``mode`` ("nearest-x", "nearest-y", or "nearest"; by
    default one suited to the marks) and ``axis_labels``, which labels the
    crosshair on the axes, as financial charts do: the inspected value on the
    axis it follows and the pointer's position on the other."""

    mode: TooltipMode | None = None
    axis_labels: bool = False

    def _spec(self) -> dict[str, Any]:
        spec: dict[str, Any] = {}
        if self.mode is not None:
            spec["mode"] = self.mode
        if self.axis_labels:
            spec["axisLabels"] = True
        return spec


@dataclass
class Panel:
    """One of a chart's ``panels``: marks with ``panel=id`` draw in it.

    ``x`` and ``y`` set the panel's own axes over the chart's ``x`` and ``y``;
    panels sharing an x scale take the first one's.
    """

    id: str
    title: str | None = None
    y: Axis | dict[str, Any] | None = None
    x: Axis | dict[str, Any] | None = None

    def _spec(self) -> dict[str, Any]:
        spec = {
            "id": self.id,
            "title": self.title,
            "x": _axis(self.x, "a panel's x"),
            "y": _axis(self.y, "a panel's y"),
        }
        return {key: value for key, value in spec.items() if value is not None}


class _SharedOptions(TypedDict, total=False):
    title: str | None
    description: str | None
    width: int | None
    height: int | None
    y_right: Axis | dict[str, Any] | None
    legend: bool | None
    tooltip: bool | TooltipMode | Tooltip | None
    zoom: bool | Literal["x", "y", "xy"] | None
    brush: Literal["x", "y", "xy", "lasso"] | None
    sync: str | None
    animation: bool | float | None
    resolve_x: Literal["shared", "independent", "rows", "columns"] | None
    resolve_y: Literal["shared", "independent", "rows", "columns"] | None
    renderer: Literal["auto", "svg", "canvas"] | None
    theme: ThemeName | dict[str, Any] | None
    locale: str | None
    time_zone: str | None
    projection: ProjectionName | Projection | dict[str, Any] | None


class _LayoutOptions(TypedDict, total=False):
    facet: str | None
    facet_columns: int | None
    facet_row: str | None
    facet_col: str | None
    panels: Sequence[Panel | str] | None
    panel_columns: int | None
    panel_row_heights: Sequence[float] | None
    panel_column_widths: Sequence[float] | None


class ChartUpdate(_SharedOptions, total=False):
    """Chart options a live chart can change (``widget.update``): those of
    ``Chart`` but data, facets, and panels. ``None`` takes an option's default."""

    x: Axis | dict[str, Any] | None
    y: Axis | dict[str, Any] | None


class ChartOptions(ChartUpdate, _LayoutOptions, total=False):
    """``Chart``'s keyword arguments. ``None`` takes an option's default."""


class HelperOptions(_SharedOptions, _LayoutOptions, total=False):
    """Chart options as the one-call helpers (``hg.line``, ``hg.scatter``, ...)
    take them, after their own: ``x_axis`` and ``y_axis`` are the chart's ``x``
    and ``y``, since the helpers' ``x`` and ``y`` name columns."""

    x_axis: Axis | dict[str, Any] | None
    y_axis: Axis | dict[str, Any] | None


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
        facet_row: str | None = None,
        facet_col: str | None = None,
        resolve_x: Literal["shared", "independent", "rows", "columns"] | None = None,
        resolve_y: Literal["shared", "independent", "rows", "columns"] | None = None,
        panels: Sequence[Panel | str] | None = None,
        panel_columns: int | None = None,
        panel_row_heights: Sequence[float] | None = None,
        panel_column_widths: Sequence[float] | None = None,
        legend: bool | None = None,
        tooltip: bool | TooltipMode | Tooltip | None = True,
        zoom: bool | Literal["x", "y", "xy"] | None = False,
        brush: Literal["x", "y", "xy", "lasso"] | None = None,
        sync: str | None = None,
        animation: bool | float | None = False,
        renderer: Literal["auto", "svg", "canvas"] | None = None,
        theme: ThemeName | dict[str, Any] | None = None,
        locale: str | None = None,
        time_zone: str | None = None,
        projection: ProjectionName | Projection | dict[str, Any] | None = None,
    ) -> None:
        if facet_columns is not None and facet is None:
            raise ValueError("facet_columns needs facet")
        if facet is not None and (facet_row is not None or facet_col is not None):
            raise ValueError("use facet to wrap panels, or facet_row and facet_col, not both")
        panel_list = [Panel(p) if isinstance(p, str) else p for p in panels or ()]
        if panels is not None and not panel_list:
            raise ValueError("panels needs at least one panel")
        ids = [p.id for p in panel_list]
        if any(not isinstance(i, str) or i in ("", "*") for i in ids):
            raise ValueError('panel ids must be names other than "" and "*"')
        if len(set(ids)) != len(ids):
            raise ValueError("panel ids must differ")
        if panel_columns is not None and not panel_list:
            raise ValueError("panel_columns needs panels")
        if panel_columns is not None and not (
            isinstance(panel_columns, int)
            and not isinstance(panel_columns, bool)
            and panel_columns >= 1
        ):
            raise ValueError(
                f"panel_columns must be a whole number of at least 1, not {panel_columns!r}"
            )
        # A grid has no more columns than panels.
        columns = min(panel_columns or 1, len(panel_list)) if panel_list else 0
        row_heights = _panel_weights(
            panel_row_heights,
            "panel_row_heights",
            panel_list,
            -(-len(panel_list) // columns) if columns else 0,
            "heights, one per row",
        )
        column_widths = _panel_weights(
            panel_column_widths,
            "panel_column_widths",
            panel_list,
            columns,
            "widths, one per column",
        )
        if panel_list and (facet is not None or facet_row is not None or facet_col is not None):
            raise ValueError("a chart has facets or panels, not both")
        if panel_list and (zoom in ("y", "xy") or brush in ("y", "xy", "lasso")):
            raise ValueError("charts with panels can zoom and brush along x only")
        for name, resolution in (("resolve_x", resolve_x), ("resolve_y", resolve_y)):
            if resolution not in (None, "shared", "independent", "rows", "columns"):
                raise ValueError(
                    f"{name} must be 'shared', 'independent', 'rows', or 'columns', "
                    f"not {resolution!r}"
                )
            if resolution not in (None, "shared") and not (
                facet is not None or facet_row is not None or facet_col is not None or panel_list
            ):
                raise ValueError(f"{name} needs facet, facet_row, facet_col, or panels")
        if resolve_y not in (None, "shared") and zoom in ("y", "xy"):
            raise ValueError("charts whose panels have y scales of their own cannot zoom along y")
        if not (animation is None or isinstance(animation, bool)) and not (
            isinstance(animation, int | float) and math.isfinite(animation) and animation >= 0
        ):
            raise ValueError(
                f"animation must be True, False, or milliseconds of at least 0, not {animation!r}"
            )
        if facet_row is not None and facet_row == facet_col:
            raise ValueError(f"facet_row and facet_col must differ, not both {facet_row!r}")
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
        self._facet_row = facet_row
        self._facet_col = facet_col
        # The fields that split rows into panels.
        self._facets = [f for f in (facet, facet_row, facet_col) if f is not None]
        self._panels = panel_list
        self._panel_columns = panel_columns
        self._panel_row_heights = row_heights
        self._panel_column_widths = column_widths
        self._tables: list[tuple[Any, _Columns]] = []
        # Derived tables by index, with the index of the table they derive from.
        self._derived: dict[int, int] = {}
        self._default = self._table(data) if data is not None else None
        self._marks: list[tuple[dict[str, Any], int | None]] = []
        # The nodes table of each network, by the network's place in `_marks`.
        self._node_tables: dict[int, int] = {}
        # Tables of features joined with rows of data, by table, for live updates.
        self._joins: dict[int, _JoinedShapes] = {}
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
            "resolve_x": resolve_x,
            "resolve_y": resolve_y,
            "zoom": zoom,
            "brush": brush,
            "sync": sync,
            "animation": animation,
            "renderer": renderer,
            "theme": theme,
            "locale": locale,
            "time_zone": time_zone,
            "projection": projection,
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
        panel: str | None = None,
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
                "panel": panel,
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
        stroke: str | None = None,
        stroke_width: float | None = None,
        curve: Curve | None = None,
        label: str | None = None,
        axis: Literal["left", "right"] | None = None,
        repeat: bool = False,
        panel: str | None = None,
        id: str | None = None,
    ) -> Chart:
        """Filled areas: down to zero, stacked, or the band between ``y1`` and ``y2``.

        A single area has an outline along its top in its own color; stacked
        and band areas have none unless ``line=True``. ``stroke`` and
        ``stroke_width`` set the outline's color and width, and turn it on.
        """
        if stroke_width is not None and not (_finite(stroke_width) and stroke_width >= 0):
            raise ValueError(f"area stroke_width must be 0 or more pixels, not {stroke_width!r}")
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
                "stroke": stroke,
                "strokeWidth": stroke_width,
                "curve": curve,
                "label": label,
                "axis": axis,
                "facet": "repeat" if repeat else None,
                "panel": panel,
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
        panel: str | None = None,
        id: str | None = None,
    ) -> Chart:
        """Bars: one band per category of x, or bars centered on number or time x.

        A category ``y`` makes the bars horizontal, with lengths in ``x``.
        ``labels=True`` writes each value at its bar's end (inside each segment
        when stacked); a dict of Intl.NumberFormat options formats them.
        """
        if isinstance(labels, dict):
            _check_format(labels, "bar labels", _NUMBER_FORMAT)
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
                "panel": panel,
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
        panel: str | None = None,
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
        # A column of another form would be dropped, so it is refused.
        given = dict(x=x, y=y, x1=x1, x2=x2, y1=y1, y2=y2, x_error=x_error, y_error=y_error)
        used = (
            [along, other, f"{other}_error"]
            if error is not None
            else [along, f"{other}1", f"{other}2"]
        )
        extra = next(
            (name for name, column in given.items() if column is not None and name not in used),
            None,
        )
        if extra is not None:
            raise ValueError(f"error_bar from {', '.join(used)} cannot also take {extra}")
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
                "panel": panel,
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
        stroke: str | None = None,
        stroke_width: float | None = None,
        color: str | None = None,
        colors: str | Sequence[str] | None = None,
        color_domain: tuple[float, float] | None = None,
        color_midpoint: float | None = None,
        symbol: str | None = None,
        sampling: Literal["none", "pixel"] | None = None,
        label: str | None = None,
        axis: Literal["left", "right"] | None = None,
        repeat: bool = False,
        panel: str | None = None,
        id: str | None = None,
    ) -> Chart:
        """Scatter points.

        ``r`` is a radius in pixels or a numeric column sized by area within
        ``r_range`` (bubbles); ``fill_opacity`` is a number or a numeric
        column. ``stroke`` and ``stroke_width`` ring each point, in the
        background color by default. ``color`` colors points by a numeric column on ``colors``, a
        scheme name such as ``"viridis"`` or a list of hex colors, centered on
        ``color_midpoint`` for diverging schemes. ``symbol`` is a shape
        (``"circle"``, ``"square"``, ``"triangle"``, ...) or a category column
        with a shape per value; a column named like a shape must be renamed to
        be encoded. ``sampling="pixel"`` draws opaque points whose centers share
        a device pixel once, which is faster for dense scatters.
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
        if stroke_width is not None and not (_finite(stroke_width) and stroke_width >= 0):
            raise ValueError(f"point stroke_width must be 0 or more pixels, not {stroke_width!r}")
        self._require(table, color, _NUMERIC, "point color")
        if symbol in SYMBOLS and self._kind(table, symbol) is not None:
            raise ValueError(
                f"point symbol: {symbol!r} names both a shape and a column; "
                "rename the column to encode it"
            )
        if symbol is not None and symbol not in SYMBOLS:
            if self._kind(table, symbol) is None:
                raise ValueError(
                    f"point symbol: {symbol!r} is neither a column nor one of {', '.join(SYMBOLS)}"
                )
            self._require(table, symbol, ("category",), "point symbol")
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
                "stroke": stroke,
                "strokeWidth": stroke_width,
                "color": color,
                "colors": _colors(colors, "point colors"),
                "colorDomain": _range(color_domain, "point color_domain"),
                "colorMidpoint": _midpoint(color_midpoint, color_domain, "point"),
                "symbol": symbol,
                "sampling": sampling,
                "label": label,
                "axis": axis,
                "facet": "repeat" if repeat else None,
                "panel": panel,
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
        panel: str | None = None,
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
                "panel": panel,
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
        variant: Literal["candlestick", "ohlc"] | None = None,
        rise: str | None = None,
        fall: str | None = None,
        label: str | None = None,
        axis: Literal["left", "right"] | None = None,
        repeat: bool = False,
        panel: str | None = None,
        id: str | None = None,
    ) -> Chart:
        """Open-high-low-close candles at each ``x``, as for prices.

        Candles closing at or above their open are hollow in the ``rise``
        color, others filled in ``fall``; both default to the theme's.
        ``variant="ohlc"`` draws bars instead: a line from low to high with
        the open ticked to its left and the close to its right.
        """
        if variant not in (None, "candlestick", "ohlc"):
            raise ValueError(f"variant must be 'candlestick' or 'ohlc', not {variant!r}")
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
                "variant": variant,
                "rise": rise,
                "fall": fall,
                "label": label,
                "axis": axis,
                "facet": "repeat" if repeat else None,
                "panel": panel,
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

    def gauge(
        self,
        value: str,
        *,
        data: Any = None,
        min: float | None = None,
        max: float | None = None,
        bands: Sequence[float | tuple[float, str]] | None = None,
        label: str | None = None,
        format: dict[str, Any] | None = None,
        id: str | None = None,
    ) -> Chart:
        """A gauge: the last finite value of the ``value`` column on a dial
        from ``min`` to ``max`` (0 to 100 by default), so rows appended to a
        live chart move it.

        ``bands`` color ranges of the dial by their upper ends, ascending,
        above ``min`` and at most ``max``: numbers, or ``(to, color)`` pairs.
        Each starts where the previous one ends, the first at ``min``; colors
        default to the theme's palette. ``format`` takes Intl.NumberFormat
        options for the value and the dial's ends. A gauge has its chart to
        itself.
        """
        self._layout_alone("gauge")
        _check_format(format, "gauge format", _NUMBER_FORMAT)
        table = self._mark_table(data)
        self._require(table, value, ("number",), "gauge value")
        low = 0.0 if min is None else min
        high = 100.0 if max is None else max
        if not (_finite(low) and _finite(high) and low < high):
            raise ValueError(
                f"gauge min must be below max, and both finite, not {low!r} and {high!r}"
            )
        return self._add(
            {
                "type": "gauge",
                "value": value,
                "min": None if min is None else float(min),
                "max": None if max is None else float(max),
                "bands": _gauge_bands(bands, low, high),
                "label": label,
                "format": format,
                "id": id,
            },
            table,
        )

    def funnel(
        self,
        category: str,
        value: str | None = None,
        *,
        data: Any = None,
        sort: Literal["input", "value"] | None = None,
        labels: bool | None = None,
        id: str | None = None,
    ) -> Chart:
        """A funnel: a centered bar per value of ``category``, top to bottom,
        as wide as the sum of ``value`` over its rows (or their count) is to
        the largest stage's. Missing, negative, and infinite values count as
        nothing.

        Stages keep the column's order unless ``sort="value"`` puts the
        largest first. ``labels=False`` leaves out the stage names and the
        values with their share of the first stage. A funnel has its chart to
        itself.
        """
        self._layout_alone("funnel")
        table = self._mark_table(data)
        self._require(table, category, ("category",), "funnel category")
        self._require(table, value, ("number",), "funnel value")
        return self._add(
            {
                "type": "funnel",
                "category": category,
                "value": value,
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
        fill: str | None = None,
        fill_opacity: float | None = None,
        label: str | None = None,
        axis: Literal["left", "right"] | None = None,
        repeat: bool = False,
        panel: str | None = None,
        id: str | None = None,
    ) -> Chart:
        """Box plots of a number column's values per category.

        One of ``x`` and ``y`` is a category column, the other the values:
        a category ``y`` lays the boxes along the y axis. Boxes span the
        quartiles with a line at the median; whiskers reach the most extreme
        values within 1.5 interquartile ranges, and values beyond are dots.
        ``series`` puts a box per value of a category column side by side.
        ``fill`` gives every box one color instead of the palette's.
        """
        return self._distribution(
            {"type": "boxplot", "fill": fill},
            x,
            y,
            data,
            series,
            fill_opacity,
            label,
            axis,
            repeat,
            panel,
            id,
        )

    def violin(
        self,
        x: str,
        y: str,
        *,
        data: Any = None,
        series: str | None = None,
        bandwidth: float | None = None,
        fill: str | None = None,
        fill_opacity: float | None = None,
        label: str | None = None,
        axis: Literal["left", "right"] | None = None,
        repeat: bool = False,
        panel: str | None = None,
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
        of a category column side by side. ``fill`` gives every violin one
        color instead of the palette's.
        """
        if bandwidth is not None and not (
            isinstance(bandwidth, numbers.Real)
            and not isinstance(bandwidth, bool)
            and math.isfinite(bandwidth)
            and bandwidth > 0
        ):
            raise ValueError(f"bandwidth must be a positive number, not {bandwidth!r}")
        return self._distribution(
            {"type": "violin", "bandwidth": bandwidth, "fill": fill},
            x,
            y,
            data,
            series,
            fill_opacity,
            label,
            axis,
            repeat,
            panel,
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
        panel: str | None,
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
                "panel": panel,
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
        if path is not None and (node is not None or parent is not None):
            raise ValueError(f"{kind} takes a path, or node and parent, not both")
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

    def radar(
        self,
        category: str | None = None,
        value: str | None = None,
        *,
        fields: Sequence[str] | None = None,
        series: str | None = None,
        data: Any = None,
        domain: tuple[float, float] | None = None,
        fill_opacity: float | None = None,
        points: bool | None = None,
        label: str | None = None,
        id: str | None = None,
    ) -> Chart:
        """A radar: spokes from a center, clockwise from the top, and a polygon
        per series through its value on each spoke.

        Spokes are the values of the ``category`` column, with ``value`` the
        number on each, or the distinct number columns ``fields``, each row a
        polygon named by its ``series`` value. A later row replaces an earlier
        one's values for the same series (and spoke); without ``series``, all
        rows are one polygon, so with ``fields`` the last row is drawn. A radar
        draws 3 to 100 spokes. Every spoke shares one scale: from 0 (or the
        smallest value) to a round number above the largest, or ``domain``;
        values outside it are drawn at the rim or the center. A missing value
        breaks the polygon's outline there and leaves it unfilled. A radar has
        its chart to itself.
        """
        self._layout_alone("radar")
        table = self._mark_table(data)
        long = category is not None or value is not None
        if long == (fields is not None) or (long and (category is None or value is None)):
            raise ValueError(
                "radar needs category and value columns (a spoke per category) "
                "or fields (a spoke per column), not both"
            )
        if fields is not None:
            if isinstance(fields, str):
                raise ValueError("radar fields must be a list of columns")
            for name in fields:
                self._require(table, name, ("number",), "radar fields")
            repeated = next((name for i, name in enumerate(fields) if name in fields[:i]), None)
            if repeated is not None:
                raise ValueError(f"radar fields must be distinct; {repeated!r} repeats")
            _check_spokes(len(fields), "fields")
        else:
            self._require(table, category, ("category",), "radar category")
            self._require(table, value, ("number",), "radar value")
            assert category is not None
            codes = self._tables[table][1].column(category).values
            # Derived tables have no rows here; their spokes are checked when drawn.
            spokes = len(np.unique(codes[codes >= 0]))
            if spokes > 0:
                _check_spokes(spokes, repr(category))
        self._require(table, series, ("category",), "radar series")
        if fill_opacity is not None and not (
            isinstance(fill_opacity, numbers.Real)
            and not isinstance(fill_opacity, bool)
            and 0 <= fill_opacity <= 1
        ):
            raise ValueError(f"fill_opacity must be from 0 to 1, not {fill_opacity!r}")
        return self._add(
            {
                "type": "radar",
                "category": category,
                "value": value,
                "fields": list(fields) if fields is not None else None,
                "series": series,
                "domain": _range(domain, "radar domain"),
                "fillOpacity": fill_opacity,
                "points": points,
                "label": label,
                "id": id,
            },
            table,
        )

    def sankey(
        self,
        source: str,
        target: str,
        value: str | None = None,
        *,
        data: Any = None,
        labels: bool | None = None,
        node_width: float | None = None,
        sort: Literal["input", "value"] | None = None,
        id: str | None = None,
    ) -> Chart:
        """A Sankey diagram: a row per flow, from the node named in ``source``
        to the one named in ``target``, each link as thick as the sum of
        ``value`` over its rows, or their count without it.

        A name in both columns is one node. Rows without a positive value,
        links from a node to itself, and links that would close a cycle are
        left out. Nodes are ordered in their column to keep links short and
        crossings few, unless ``sort="input"`` keeps the order they first
        appear in or ``sort="value"`` puts the largest first. ``node_width``
        is in pixels. A Sankey diagram has its chart to itself.
        """
        self._layout_alone("sankey")
        if node_width is not None and not (
            isinstance(node_width, numbers.Real)
            and not isinstance(node_width, bool)
            and 0 < node_width < math.inf
        ):
            raise ValueError(f"node_width must be a positive number of pixels, not {node_width!r}")
        if sort not in (None, "input", "value"):
            raise ValueError(f"sort must be 'input' or 'value', not {sort!r}")
        table = self._mark_table(data)
        self._require(table, source, ("category",), "sankey source")
        self._require(table, target, ("category",), "sankey target")
        self._require(table, value, ("number",), "sankey value")
        return self._add(
            {
                "type": "sankey",
                "source": source,
                "target": target,
                "value": value,
                "labels": labels,
                "nodeWidth": node_width,
                "sort": sort,
                "id": id,
            },
            table,
        )

    def graph(
        self,
        source: str,
        target: str,
        value: str | None = None,
        *,
        nodes: Any = None,
        node: str | None = None,
        group: str | None = None,
        size: str | None = None,
        data: Any = None,
        labels: bool | None = None,
        id: str | None = None,
    ) -> Chart:
        """A network: a row per link between the nodes named in ``source`` and
        ``target``, placed by a force simulation, links as wide as the sum of
        ``value`` over their rows when given.

        Links have no direction: rows either way between two nodes are one
        link. Rows without a positive value and links from a node to itself
        are left out. ``nodes`` is a second data source with a row per node,
        named in its ``node`` column, which adds nodes without links and
        colors nodes by ``group`` (with a legend) or sizes them by ``size``;
        nodes only links name have no group. A network draws at most 5,000
        nodes and 20,000 links and has its chart to itself.
        """
        self._layout_alone("graph")
        table = self._mark_table(data)
        self._require(table, source, ("category",), "graph source")
        self._require(table, target, ("category",), "graph target")
        self._require(table, value, ("number",), "graph value")
        node_table = None
        if nodes is not None:
            if node is None:
                raise ValueError("graph nodes need node, the column naming each row's node")
            node_table = self._table(nodes)
            self._require(node_table, node, ("category",), "graph node")
            self._require(node_table, group, ("category",), "graph group")
            self._require(node_table, size, ("number",), "graph size")
        elif node is not None or group is not None or size is not None:
            raise ValueError("graph node, group, and size are columns of nodes, which is missing")
        nodes_count, links_count = self._network_size(
            table, source, target, value, node_table, node
        )
        if nodes_count > MAX_NODES or links_count > MAX_LINKS:
            raise ValueError(
                f"a graph draws at most {MAX_NODES:,} nodes and {MAX_LINKS:,} links; "
                f"this network has {nodes_count:,} nodes and {links_count:,} links"
            )
        self._add(
            {
                "type": "graph",
                "source": source,
                "target": target,
                "value": value,
                "node": node,
                "group": group,
                "size": size,
                "labels": labels,
                "id": id,
            },
            table,
        )
        if node_table is not None:
            self._node_tables[len(self._marks) - 1] = node_table
        return self

    def _network_size(
        self,
        table: int,
        source: str,
        target: str,
        value: str | None,
        node_table: int | None,
        node: str | None,
    ) -> tuple[int, int]:
        """How many nodes and links a network draws, counted as the browser
        counts them: the names in the nodes table and in rows the links keep,
        and one link per pair of different names, either way round, whose
        values sum to a finite total."""
        links = self._tables[table][1]
        ends = [links.column(source), links.column(target)]
        keep = (ends[0].values >= 0) & (ends[1].values >= 0)
        if value is not None:
            values = links.column(value).values
            keep &= (values > 0) & (values < math.inf)
        # Derived tables have no rows here, and their empty codes are floats.
        a, b = (
            np.asarray(column.dictionary, dtype=object)[column.values[keep].astype(np.intp)]
            for column in ends
        )
        names, ids = np.unique(np.concatenate([a, b]), return_inverse=True)
        low = np.minimum(ids[: len(a)], ids[len(a) :])
        high = np.maximum(ids[: len(a)], ids[len(a) :])
        distinct = low != high
        pairs, rows = np.unique((low * len(names) + high)[distinct], return_inverse=True)
        links_count = len(pairs)
        if value is not None:
            # Pairs whose values sum past the largest double are left out, as in the browser.
            with np.errstate(over="ignore"):
                totals = np.bincount(rows, weights=values[keep][distinct], minlength=len(pairs))
            links_count = int(np.count_nonzero(np.isfinite(totals)))
        found = set(names)
        if node_table is not None:
            assert node is not None
            ids_column = self._tables[node_table][1].column(node)
            codes = ids_column.values[ids_column.values >= 0].astype(np.intp)
            found.update(np.asarray(ids_column.dictionary, dtype=object)[codes])
        return len(found), links_count

    def _layout_alone(self, kind: str) -> None:
        """Layout marks (pies, treemaps, sunbursts, gauges, funnels, radars, Sankey
        diagrams, graphs) have no axes to facet or zoom."""
        if self._facets or self._panels:
            raise ValueError(f"charts of a {kind} cannot have facets or panels yet")
        if any(self._settings.get(name) for name in ("zoom", "brush", "sync")):
            raise ValueError(f"charts of a {kind} have no x axis to zoom, brush, or sync")

    def geoshape(
        self,
        geometry: str | None = None,
        *,
        data: Any = None,
        name: str | None = None,
        color: str | None = None,
        colors: str | Sequence[str] | None = None,
        color_domain: tuple[float, float] | None = None,
        color_midpoint: float | None = None,
        fill: str | None = None,
        fill_opacity: float | None = None,
        stroke: str | None = None,
        stroke_width: float | None = None,
        label: str | None = None,
        geojson: Any = None,
        locations: str | None = None,
        feature_id_key: str = "id",
        id: str | None = None,
    ) -> Chart:
        """Regions of a map: each row's shape, filled by ``color``, a numeric column
        on a continuous scale (a choropleth) or a category column with a color per
        value, whose legend grays its regions out.

        The data holds the shapes in its ``geometry`` column (by default the one
        named "geometry", or a GeoDataFrame's): a GeoDataFrame, a GeoJSON
        FeatureCollection (its properties become columns), or any table whose
        column holds GeoJSON geometries or objects with ``__geo_interface__``.
        Shapes are polygons and multipolygons in longitude and latitude.

        Or, as in Plotly, the values come from ``data`` and the shapes from
        ``geojson``: each row's ``locations`` value names its feature by
        ``feature_id_key`` (``"id"`` or ``"properties.<name>"``; Plotly's
        ``featureidkey``), compared as text.
        Every feature is drawn; those no row names have no value. ``name``
        labels regions in tooltips, keyboard reading, and the summary.
        Geoshape and geopoint marks share a chart, projected by its
        ``projection``.
        """
        self._map_alone("geoshape")
        if geojson is not None:
            if locations is None:
                raise ValueError(
                    "geoshape geojson needs locations, the column naming each row's feature"
                )
            values = self._mark_table(data)
            # Layers joining the same rows to the same features share their table.
            same = next(
                (
                    index
                    for index, join in self._joins.items()
                    if join.made_from(self._tables[values][0], geojson, locations, feature_id_key)
                ),
                None,
            )
            if same is None:
                joined = _JoinedShapes(self, values, geojson, locations, feature_id_key)
                table = self._table(joined, joined.table)
                self._joins[table] = joined
            else:
                table = same
        else:
            if locations is not None:
                raise ValueError("geoshape locations needs geojson, the shapes the rows name")
            table = self._mark_table(data)
        if geometry is None:
            geometry = _geometry_column(self._tables[table][0], self._tables[table][1])
        self._require(table, geometry, ("geometry",), "geoshape geometry")
        self._require(table, name, ("category",), "geoshape name")
        self._require(table, color, ("number", "category"), "geoshape color")
        numeric = color is not None and self._kind(table, color) == "number"
        if not numeric and (
            colors is not None or color_domain is not None or color_midpoint is not None
        ):
            raise ValueError(
                "geoshape colors, color_domain, and color_midpoint need a numeric color column"
            )
        if fill_opacity is not None and not (_finite(fill_opacity) and 0 <= fill_opacity <= 1):
            raise ValueError(f"geoshape fill_opacity must be from 0 to 1, not {fill_opacity!r}")
        if stroke_width is not None and not (_finite(stroke_width) and stroke_width >= 0):
            raise ValueError(
                f"geoshape stroke_width must be 0 or more pixels, not {stroke_width!r}"
            )
        return self._add(
            {
                "type": "geoshape",
                "geometry": geometry,
                "name": name,
                "color": color,
                "colors": _colors(colors, "geoshape colors"),
                "colorDomain": _range(color_domain, "geoshape color_domain"),
                "colorMidpoint": _midpoint(color_midpoint, color_domain, "geoshape"),
                "fill": fill,
                "fillOpacity": fill_opacity,
                "stroke": stroke,
                "strokeWidth": stroke_width,
                "label": label,
                "id": id,
            },
            table,
        )

    def geopoint(
        self,
        longitude: str,
        latitude: str,
        *,
        data: Any = None,
        name: str | None = None,
        series: str | None = None,
        r: float | str | None = None,
        r_range: tuple[float, float] | None = None,
        color: str | None = None,
        colors: str | Sequence[str] | None = None,
        color_domain: tuple[float, float] | None = None,
        color_midpoint: float | None = None,
        fill: str | None = None,
        fill_opacity: float | None = None,
        stroke: str | None = None,
        stroke_width: float | None = None,
        label: str | None = None,
        id: str | None = None,
    ) -> Chart:
        """Points of a map at ``longitude`` and ``latitude`` columns (degrees):
        places, or bubbles sized by area with a numeric ``r`` column.

        ``series`` gives a color and legend entry per category, ``color`` colors
        points by a numeric column. Points are drawn largest first, each ringed
        in the background color (``stroke``, ``stroke_width``). For a
        GeoDataFrame of points, add the columns first:
        ``gdf.assign(lon=gdf.geometry.x, lat=gdf.geometry.y)``.
        """
        self._map_alone("geopoint")
        table = self._mark_table(data)
        self._require(table, longitude, ("number",), "geopoint longitude")
        self._require(table, latitude, ("number",), "geopoint latitude")
        self._require(table, name, ("category",), "geopoint name")
        self._require(table, series, ("category",), "geopoint series")
        if isinstance(r, str):
            self._require(table, r, ("number",), "geopoint r")
        elif r is not None and not (_finite(r) and r > 0):
            raise ValueError(f"geopoint r must be a positive radius or a column, not {r!r}")
        self._require(table, color, ("number",), "geopoint color")
        if fill_opacity is not None and not (_finite(fill_opacity) and 0 <= fill_opacity <= 1):
            raise ValueError(f"geopoint fill_opacity must be from 0 to 1, not {fill_opacity!r}")
        if stroke_width is not None and not (_finite(stroke_width) and stroke_width >= 0):
            raise ValueError(
                f"geopoint stroke_width must be 0 or more pixels, not {stroke_width!r}"
            )
        return self._add(
            {
                "type": "geopoint",
                "longitude": longitude,
                "latitude": latitude,
                "name": name,
                "series": series,
                "r": r,
                "rRange": _range(r_range, "geopoint r_range", minimum=0),
                "color": color,
                "colors": _colors(colors, "geopoint colors"),
                "colorDomain": _range(color_domain, "geopoint color_domain"),
                "colorMidpoint": _midpoint(color_midpoint, color_domain, "geopoint"),
                "fill": fill,
                "fillOpacity": fill_opacity,
                "stroke": stroke,
                "strokeWidth": stroke_width,
                "label": label,
                "id": id,
            },
            table,
        )

    def _map_alone(self, kind: str) -> None:
        """Maps have no axes to facet, zoom, brush, or sync."""
        if self._facets or self._panels:
            raise ValueError(f"charts of a {kind} cannot have facets or panels yet")
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
        reduce: Literal["mean", "max", "min"] | None = None,
        label: str | None = None,
        repeat: bool = False,
        panel: str | None = None,
        id: str | None = None,
    ) -> Chart:
        """A grid of cells colored by ``value``; one column or row per distinct x or y.

        ``colors`` is a scheme name such as ``"viridis"`` or a list of hex
        colors, low to high; with ``color_midpoint``, the theme's diverging
        ramp is the default and the midpoint takes its middle color. Grids
        with more columns or rows than the plot has pixels draw each pixel
        from a block of cells, colored by the ``reduce`` of their values:
        ``"mean"`` (the default), ``"max"``, or ``"min"``.
        """
        if reduce not in (None, "mean", "max", "min"):
            raise ValueError(f"heatmap reduce must be 'mean', 'max', or 'min', not {reduce!r}")
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
                "reduce": reduce,
                "label": label,
                "facet": "repeat" if repeat else None,
                "panel": panel,
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
        panel: str | None = None,
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
                "panel": panel,
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
        panel: str | None = None,
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
                "panel": panel,
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
        overlap: Literal["show", "hide", "move"] | None = None,
        axis: Literal["left", "right"] | None = None,
        repeat: bool = False,
        panel: str | None = None,
        id: str | None = None,
    ) -> Chart:
        """Text at ``(x, y)``: ``label`` for constant text, or ``text`` naming a column.

        Column names for ``x`` or ``y`` draw one label per row. ``dx`` and
        ``dy`` offset labels in pixels; positive ``dy`` moves down. Labels that
        would cover an earlier one of this mark, in row order, are drawn anyway
        (``overlap="show"``), left out (``"hide"``), or, where their place is
        taken or outside the plot, tried around their point and left out when
        nothing fits (``"move"``).
        """
        if overlap not in (None, "show", "hide", "move"):
            raise ValueError(f"overlap must be 'show', 'hide', or 'move', not {overlap!r}")
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
                "overlap": overlap,
                "axis": axis,
                "facet": "repeat" if repeat else None,
                "panel": panel,
                "id": id,
            },
            table,
        )

    # Output ----------------------------------------------------------------

    def to_spec(self) -> tuple[dict[str, Any], list[bytes]]:
        """The portable chart spec and the binary buffers its columns reference."""
        if self._settings.get("projection") is not None and not any(
            mark["type"] in _MAP_MARKS for mark, _ in self._marks
        ):
            raise ValueError("a projection needs geoshape or geopoint marks to project")
        return assemble_spec(
            self._options,
            self._layout_spec(),
            self._used_columns(),
            self._mark_specs(),
            self._derived_specs(),
        )

    def widget(self) -> ChartWidget:
        """A live notebook widget of this chart: Python can update it after display,
        and it reports zooming, brushing, hovering, and clicks back. It reports
        one x range, so its panels share x (``resolve_x`` is ``"shared"``).

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
        if isinstance(content, bytes):
            with open(path, "wb") as binary:
                binary.write(content)
        else:
            with open(path, "w", encoding="utf-8") as text:
                text.write(content)

    def show(self) -> None:
        """Displays the chart in a notebook, or opens it in a browser elsewhere."""
        _render.show(self)

    def _repr_html_(self) -> str:
        return _render.notebook_html(*self.to_spec(), height=self._options.get("height"))

    # Internals -------------------------------------------------------------

    def _layout_spec(self) -> dict[str, Any]:
        """The spec's facet, or its panels and grid; nothing for one panel."""
        if self._facet is not None:
            return {"facet": {"field": self._facet, "columns": self._facet_columns}}
        if self._facets:
            return {"facet": {"row": self._facet_row, "column": self._facet_col}}
        if self._panels:
            layout: dict[str, Any] = {"panels": [p._spec() for p in self._panels]}
            grid = {
                "columns": self._panel_columns,
                "rowHeights": self._panel_row_heights,
                "columnWidths": self._panel_column_widths,
            }
            if any(value is not None for value in grid.values()):
                layout["grid"] = grid
            return layout
        return {}

    def _used_fields(self) -> dict[int, set[str]]:
        """The columns each table must send: those marks read, and those derived
        tables need from their sources."""
        used: dict[int, set[str]] = {}
        for index, (spec, table) in enumerate(self._marks):
            # A network's node fields are columns of its nodes, not of its links.
            node_table = self._node_tables.get(index)
            links = spec
            if node_table is not None:
                links = {key: value for key, value in spec.items() if key not in _NODE_FIELDS}
            if table is not None:
                fields = used.setdefault(table, set())
                fields.update(_fields(links))
                if spec.get("facet") is None:
                    fields.update(self._facets)
            if node_table is not None:
                used.setdefault(node_table, set()).update(
                    spec[key] for key in _NODE_FIELDS if spec.get(key) is not None
                )
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
                **(
                    {"nodes": table_name(self._node_tables[index])}
                    if index in self._node_tables
                    else {}
                ),
            }
            for index, (mark, table) in enumerate(self._marks)
        ]

    def _table_names(self) -> list[tuple[Any, str]]:
        """Each data source given to the chart or its marks, with its spec table name."""
        return [(source, table_name(index)) for index, (source, _) in enumerate(self._tables)]

    def _table(self, data: Any, converted: _Columns | None = None) -> int:
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
        kinds = [mark["type"] for mark, _ in self._marks]
        layouts = [kind for kind in kinds if kind in _LAYOUT_MARKS]
        # The layers of a map share their chart with each other, and only with them.
        layers = spec["type"] in _MAP_MARKS and set(kinds) <= set(_MAP_MARKS)
        if not layers and (layouts or (spec["type"] in _LAYOUT_MARKS and self._marks)):
            kind = layouts[0] if layouts else spec["type"]
            if kind in _MAP_MARKS:
                raise ValueError(
                    f"a {kind} shares its chart only with geoshape and geopoint marks; "
                    "draw other marks in another chart"
                )
            raise ValueError(f"a {kind} has its chart to itself; draw other marks in another chart")
        if spec.get("axis") not in (None, "left", "right"):
            raise ValueError(f"axis must be 'left' or 'right', not {spec['axis']!r}")
        if self._facets and spec.get("axis") == "right":
            raise ValueError("charts with facets cannot use the right axis yet")
        if self._panels:
            panel = spec.get("panel")
            if panel is None:
                raise ValueError(
                    f"a {spec['type']} mark in a chart with panels needs panel=: "
                    'the id of one, or "*" for every panel'
                )
            if panel != "*" and panel not in [p.id for p in self._panels]:
                raise ValueError(
                    f"a {spec['type']} mark names the panel {panel!r}, "
                    "which the chart does not have"
                )
            if spec.get("axis") == "right":
                raise ValueError("charts with panels cannot use the right axis yet")
        elif spec.get("panel") is not None:
            raise ValueError("panel= needs a chart with panels")
        if self._facets and table is not None and spec.get("facet") is None:
            for field in self._facets:
                self._require(table, field, ("category",), "facet")
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
_LAYOUT_MARKS = (
    *("pie", "treemap", "sunburst", "gauge", "funnel", "radar", "sankey", "graph"),
    *("geoshape", "geopoint"),
)

#: The layers of maps, which share a chart and its projection.
_MAP_MARKS = ("geoshape", "geopoint")

#: The most nodes and links a graph lays out, as the browser enforces.
MAX_NODES = 5000
MAX_LINKS = 20_000

#: A graph's fields that are columns of its nodes.
_NODE_FIELDS = ("node", "group", "size")


#: Chart options a live chart can change after display: all but data and facets,
#: which decide the columns sent.
OPTIONS = (
    *("title", "description", "width", "height", "x", "y", "y_right", "legend", "tooltip"),
    *("zoom", "brush", "sync", "animation", "resolve_x", "resolve_y", "renderer", "theme"),
    *("locale", "time_zone", "projection"),
)


def spec_options(settings: dict[str, Any]) -> dict[str, Any]:
    """The spec's chart options from Chart's keyword arguments; unset ones are left out."""
    tooltip = settings["tooltip"]
    animation = settings["animation"]
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
        "y": _axis(settings["y"], "y"),
        "yRight": _axis(settings["y_right"], "y_right"),
        "legend": settings["legend"],
        "tooltip": tooltip
        if tooltip is None or isinstance(tooltip, bool)
        else tooltip._spec()
        if isinstance(tooltip, Tooltip)
        else {"mode": tooltip},
        "interaction": interaction or None,
        "animation": (animation or None)
        if animation is None or isinstance(animation, bool)
        else {"duration": animation},
        "resolve": {
            axis: settings[f"resolve_{axis}"] for axis in ("x", "y") if settings[f"resolve_{axis}"]
        }
        or None,
        "renderer": settings["renderer"],
        "theme": _theme(settings["theme"]),
        "locale": settings["locale"],
        "timeZone": settings["time_zone"],
        "projection": _projection(settings.get("projection")),
    }
    return {key: value for key, value in options.items() if value is not None}


def assemble_spec(
    options: dict[str, Any],
    layout: dict[str, Any],
    tables: dict[str, dict[str, Column]],
    marks: list[dict[str, Any]],
    derived: dict[str, dict[str, Any]] | None = None,
) -> tuple[dict[str, Any], list[bytes]]:
    """A spec and its buffers from chart options, columns by table name, mark
    specs, and derived tables by name."""
    buffers: list[bytes] = []
    spec: dict[str, Any] = {"version": 3, **options}
    for key, value in layout.items():
        spec[key] = (
            {k: v for k, v in value.items() if v is not None} if isinstance(value, dict) else value
        )
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


class _Columns(Protocol):
    """What charts read of a table: its column names and, by name, its columns."""

    @property
    def names(self) -> tuple[str, ...]: ...

    def column(self, name: str) -> Column: ...


class _DerivedColumns:
    """A derived table's columns, as charts check fields: names and kinds, no values."""

    def __init__(self, derived: Derived) -> None:
        self.names = tuple(derived._kinds)
        self._kinds = derived._kinds

    def column(self, name: str) -> Column:
        if name not in self._kinds:
            raise KeyError(name)
        return Column(self._kinds[name], np.empty(0))


def _convertible(columns: _Columns) -> str:
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


def _check_spokes(spokes: int, what: str) -> None:
    """Refuses a radar of too few spokes to make a polygon, or too many to read."""
    if spokes < 3:
        raise ValueError(f"radar needs at least 3 spokes; {what} has {spokes}")
    if spokes > 100:
        raise ValueError(f"radar draws at most 100 spokes; {what} has {spokes}")


def table_name(index: int) -> str:
    return "data" if index == 0 else f"data{index + 1}"


def _fields(spec: dict[str, Any]) -> set[str]:
    fields: set[str] = set()
    for key in (
        *("x", "y", "x1", "x2", "y1", "y2", "xError", "yError", "series", "value", "text"),
        *("category", "fields"),
        *("path", "node", "parent", "source", "target"),
        *("open", "high", "low", "close"),
        *("r", "fillOpacity", "color", "symbol"),
        *("geometry", "name", "longitude", "latitude"),
    ):
        value = spec.get(key)
        if isinstance(value, str):
            fields.add(value)
        elif isinstance(value, list):
            fields.update(value)
    return fields


def _column_spec(column: Column, buffers: list[bytes]) -> dict[str, Any]:
    if column.kind == "geometry":
        shapes = column.shapes
        assert shapes is not None
        arrays = {
            "coordinates": shapes.coordinates,
            "ringOffsets": shapes.ring_offsets,
            "polygonOffsets": shapes.polygon_offsets,
            "geometryOffsets": shapes.geometry_offsets,
        }
        # Row i holds geometry i unless rows name their shapes otherwise.
        if not np.array_equal(column.values, np.arange(len(column.values))):
            arrays["codes"] = column.values
        spec: dict[str, Any] = {"type": "geometry"}
        for key, array in arrays.items():
            buffers.append(array.tobytes())
            spec[key] = len(buffers) - 1
        return spec
    buffers.append(column.values.tobytes())
    index = len(buffers) - 1
    if column.kind == "category":
        return {"type": "category", "codes": index, "dictionary": list(column.dictionary)}
    dtype = "float32" if column.values.dtype.itemsize == 4 else "float64"
    return {"type": column.kind, "dtype": dtype, "buffer": index}


def _axis(axis: Axis | dict[str, Any] | None, role: str = "x") -> dict[str, Any] | None:
    if axis is None:
        return None
    if isinstance(axis, dict):
        axis = Axis(**axis)
    if role != "x" and axis.breaks is not None:
        raise ValueError(f"breaks are for the chart's x axis only, not {role}")
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
#: Theme keys that are one word, the same in Python and in the spec.
_THEME_WORDS = frozenset(
    ("extends", "background", "text", "muted", "grid", "axis", "font")
    + ("palette", "sequential", "diverging", "rise", "fall")
)


def _projection(projection: Any) -> Any:
    """A projection's spec from a name, a Projection, or a dict of its fields."""
    if projection is None:
        return None
    if isinstance(projection, str):
        projection = Projection(projection)  # type: ignore[arg-type]
    elif isinstance(projection, dict):
        projection = Projection(**projection)
    return projection._spec()


def _geometry_column(source: Any, columns: Any) -> str:
    """The column of shapes when a geoshape names none: "geometry", or a GeoDataFrame's."""
    active = getattr(source, "_geometry_column_name", None)
    for name in ("geometry", active):
        if name is not None and name in columns.names:
            return name
    raise ValueError("geoshape needs geometry=, the column holding the shapes")


class _JoinedShapes:
    """A GeoJSON collection's features, with the values of the rows naming them,
    as Plotly's ``locations`` and ``featureidkey`` join them: a row per feature,
    with missing values where no row names it. Live charts join new rows the
    same way (``rejoin``)."""

    def __init__(self, chart: Chart, table: int, geojson: Any, locations: str, key: str) -> None:
        if table in chart._derived:
            raise ValueError(
                "geoshape joins the rows of a table to the shapes, not those of a derived "
                "table, which the browser computes; join before deriving"
            )
        interface = getattr(geojson, "__geo_interface__", geojson)
        if not _geo.is_feature_collection(interface):
            raise TypeError("geoshape geojson must be a GeoJSON FeatureCollection")
        _geo.check_crs(geojson)
        chart._require(table, locations, ("category", "number"), "geoshape locations")
        self.source = chart._tables[table][0]
        self._geojson = geojson
        self._locations = locations
        self._key = key
        self._keys = [_geo.key_text(_geo.feature_key(f, key)) for f in interface["features"]]
        self._shapes = Table(interface)
        self.table = self.rejoin(chart._tables[table][1])

    def made_from(self, source: Any, geojson: Any, locations: str, key: str) -> bool:
        """Whether this join is of the same rows and features, by the same keys."""
        return (
            self.source is source
            and self._geojson is geojson
            and (self._locations, self._key) == (locations, key)
        )

    def rejoin(self, source: _Columns) -> _Joined:
        """The features joined with the rows of `source`."""
        if self._locations not in source.names:
            raise KeyError(f"geoshape locations: the rows have no column {self._locations!r}")
        located = source.column(self._locations)
        if located.kind not in ("category", "number"):
            raise TypeError(
                f"geoshape locations: column {self._locations!r} holds {located.kind} values"
            )
        values = (
            [None if code < 0 else located.dictionary[code] for code in located.values]
            if located.kind == "category"
            else located.values.tolist()
        )
        row_of: dict[str, int] = {}
        for row, value in enumerate(values):
            text = _geo.key_text(value)
            if text is None:
                continue
            if text in row_of:
                raise ValueError(
                    f"geoshape locations name {text!r} twice; aggregate the rows to one per feature"
                )
            row_of[text] = row
        keys = self._keys
        rows = np.array([-1 if k is None else row_of.get(k, -1) for k in keys], dtype=np.intp)
        if values and not (rows >= 0).any():
            raise ValueError(
                f"no feature's {self._key} matches a value of {self._locations!r} (features: "
                f"{keys[:3]!r}; rows: {[_geo.key_text(v) for v in values[:3]]!r})"
            )
        if "geometry" in source.names:
            raise ValueError('geoshape: the data has a column named "geometry", as the shapes')
        return _Joined(source, rows, self._shapes)


class _Joined:
    """The joined rows' columns, converted when a mark first reads them: the
    data's taken at each feature's row, then the features' own."""

    def __init__(self, source: _Columns, rows: np.ndarray, shapes: Table) -> None:
        self._source = source
        self._rows = rows
        self._shapes = shapes
        self.names = (*source.names, *(n for n in shapes.names if n not in source.names))
        self._columns: dict[str, Column] = {}

    def column(self, name: str) -> Column:
        column = self._columns.get(name)
        if column is None:
            if name in self._source.names:
                column = _take(self._source.column(name), self._rows)
            else:
                column = self._shapes.column(name)
            self._columns[name] = column
        return column


def _take(column: Column, rows: np.ndarray) -> Column:
    """A column's values at `rows`, missing where a row is -1."""
    missing = rows < 0
    picked = (
        column.values[np.where(missing, 0, rows)]
        if len(column.values)
        else np.zeros(len(rows), dtype=column.values.dtype)
    )
    if column.kind in ("category", "geometry"):
        values = np.where(missing, -1, picked).astype("<i4")
        return Column(column.kind, values, column.dictionary, column.shapes)
    return Column(column.kind, np.where(missing, np.nan, picked).astype(column.values.dtype))


def _theme(theme: str | dict[str, Any] | None) -> Any:
    if theme is None or isinstance(theme, str):
        return theme
    known = _THEME_WORDS | _THEME_KEYS.keys() | set(_THEME_KEYS.values())
    unknown = [key for key in theme if key not in known]
    if unknown:
        names = ", ".join(sorted(_THEME_WORDS | _THEME_KEYS.keys()))
        raise ValueError(f"theme: unknown key {unknown[0]!r}; a theme takes {names}")
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


def _panel_weights(
    weights: Sequence[float] | None, option: str, panels: list[Panel], count: int, noun: str
) -> list[float] | None:
    """Relative row heights or column widths of a grid of panels, checked."""
    if weights is None:
        return None
    if not panels:
        raise ValueError(f"{option} needs panels")
    if len(weights) != count:
        raise ValueError(f"{option} needs {count} {noun}")
    if not all(isinstance(w, numbers.Real) and not isinstance(w, bool) for w in weights):
        raise ValueError(f"{option} must be positive numbers")
    # NumPy numbers and fractions become floats, which JSON can carry.
    values = [float(w) for w in weights]
    if not all(0 < w < math.inf for w in values):
        raise ValueError(f"{option} must be positive numbers")
    return values


def _finite(value: Any) -> bool:
    """A real, finite number; booleans are not numbers here."""
    return isinstance(value, numbers.Real) and not isinstance(value, bool) and math.isfinite(value)


def _gauge_bands(
    bands: Sequence[float | tuple[float, str]] | None, low: float, high: float
) -> list[dict[str, Any]] | None:
    """Gauge bands as the spec takes them, checked as the engine checks them."""
    if bands is None:
        return None
    out: list[dict[str, Any]] = []
    previous = low
    for band in bands:
        if isinstance(band, (tuple, list)):
            if len(band) != 2:
                raise ValueError(f"gauge bands are numbers or (to, color) pairs, not {band!r}")
            to, color = band
        else:
            to, color = band, None
        if not (_finite(to) and low < to <= high):
            raise ValueError(
                f"gauge bands must end above min ({low:g}) and at most at max ({high:g}), "
                f"not at {to!r}"
            )
        if not to > previous:
            raise ValueError(
                f"gauge bands must end in ascending order, not {to:g} after {previous:g}"
            )
        out.append({"to": float(to)} if color is None else {"to": float(to), "color": color})
        previous = to
    return out


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


def _chart_of(data: Any, options: HelperOptions) -> Chart:
    """A helper's chart: its ``x_axis`` and ``y_axis`` are the chart's ``x`` and ``y``."""
    settings: dict[str, Any] = dict(options)
    for axis in ("x", "y"):
        if f"{axis}_axis" in settings:
            settings[axis] = settings.pop(f"{axis}_axis")
    return Chart(data, **settings)


def line(
    data: Any,
    x: str,
    y: str | Sequence[str],
    *,
    series: str | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """A line chart. Remaining keyword arguments are chart options (``HelperOptions``)."""
    return _chart_of(data, options).line(x, y, series=series)


def area(
    data: Any,
    x: str,
    y: str | Sequence[str],
    *,
    series: str | None = None,
    stack: bool = False,
    **options: Unpack[HelperOptions],
) -> Chart:
    """An area chart, stacked with ``stack=True``."""
    return _chart_of(data, options).area(x, y, series=series, stack=stack)


def bar(
    data: Any,
    x: str | Sequence[str],
    y: str | Sequence[str],
    *,
    series: str | None = None,
    stack: bool = False,
    labels: bool | dict[str, Any] = False,
    **options: Unpack[HelperOptions],
) -> Chart:
    """A bar chart, grouped or stacked; horizontal when ``y`` is a category."""
    return _chart_of(data, options).bar(x, y, series=series, stack=stack, labels=labels)


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
    sampling: Literal["none", "pixel"] | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """A scatter plot; ``r``, ``color``, and ``symbol`` can encode columns (see ``Chart.point``)."""
    return _chart_of(data, options).point(
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
        sampling=sampling,
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
    reduce: Literal["mean", "max", "min"] | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """A heatmap; ``colors`` is a scheme name or a list of hex colors (see ``Chart.heatmap``)."""
    return _chart_of(data, options).heatmap(
        x,
        y,
        value,
        colors=colors,
        color_domain=color_domain,
        color_midpoint=color_midpoint,
        reduce=reduce,
    )


def histogram(
    data: Any,
    x: str,
    *,
    bins: int | dict[str, float] | None = None,
    series: str | None = None,
    normalize: Literal["count", "percent", "density"] | None = None,
    stack: bool = False,
    **options: Unpack[HelperOptions],
) -> Chart:
    """A histogram of ``x``'s values."""
    return _chart_of(data, options).histogram(
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
    **options: Unpack[HelperOptions],
) -> Chart:
    """A pie, or with ``inner_radius`` a donut, of ``value`` per ``category``."""
    return _chart_of(data, options).pie(
        category, value, inner_radius=inner_radius, sort=sort, labels=labels
    )


def gauge(
    data: Any,
    value: str,
    *,
    min: float | None = None,
    max: float | None = None,
    bands: Sequence[float | tuple[float, str]] | None = None,
    label: str | None = None,
    format: dict[str, Any] | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """A gauge of the last finite value of ``value``, on a dial from ``min`` to ``max``."""
    return _chart_of(data, options).gauge(
        value, min=min, max=max, bands=bands, label=label, format=format
    )


def funnel(
    data: Any,
    category: str,
    value: str | None = None,
    *,
    sort: Literal["input", "value"] | None = None,
    labels: bool | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """A funnel of ``value`` (or row counts) per stage of ``category``, top to bottom."""
    return _chart_of(data, options).funnel(category, value, sort=sort, labels=labels)


def boxplot(
    data: Any,
    x: str,
    y: str,
    *,
    series: str | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """Box plots of ``y`` per category of ``x``, or of ``x`` per category of ``y``."""
    return _chart_of(data, options).boxplot(x, y, series=series)


def violin(
    data: Any,
    x: str,
    y: str,
    *,
    series: str | None = None,
    bandwidth: float | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """Violins of ``y`` per category of ``x``, or of ``x`` per category of ``y``."""
    return _chart_of(data, options).violin(x, y, series=series, bandwidth=bandwidth)


def treemap(
    data: Any,
    path: Sequence[str] | None = None,
    value: str | None = None,
    *,
    node: str | None = None,
    parent: str | None = None,
    labels: bool | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """A treemap of a tree given by ``path`` columns, or ``node`` and ``parent``."""
    return _chart_of(data, options).treemap(path, value, node=node, parent=parent, labels=labels)


def sunburst(
    data: Any,
    path: Sequence[str] | None = None,
    value: str | None = None,
    *,
    node: str | None = None,
    parent: str | None = None,
    labels: bool | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """A sunburst of a tree given by ``path`` columns, or ``node`` and ``parent``."""
    return _chart_of(data, options).sunburst(path, value, node=node, parent=parent, labels=labels)


def radar(
    data: Any,
    category: str | None = None,
    value: str | None = None,
    *,
    fields: Sequence[str] | None = None,
    series: str | None = None,
    domain: tuple[float, float] | None = None,
    fill_opacity: float | None = None,
    points: bool | None = None,
    label: str | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """A radar of ``value`` per ``category``, or of the columns ``fields`` per row."""
    return _chart_of(data, options).radar(
        category,
        value,
        fields=fields,
        series=series,
        domain=domain,
        fill_opacity=fill_opacity,
        points=points,
        label=label,
    )


def sankey(
    data: Any,
    source: str,
    target: str,
    value: str | None = None,
    *,
    labels: bool | None = None,
    node_width: float | None = None,
    sort: Literal["input", "value"] | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """A Sankey diagram of flows from ``source`` to ``target``, sized by ``value``."""
    return _chart_of(data, options).sankey(
        source, target, value, labels=labels, node_width=node_width, sort=sort
    )


def graph(
    data: Any,
    source: str,
    target: str,
    value: str | None = None,
    *,
    nodes: Any = None,
    node: str | None = None,
    group: str | None = None,
    size: str | None = None,
    labels: bool | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """A network of links from ``source`` to ``target``, with ``nodes`` for groups and sizes."""
    return _chart_of(data, options).graph(
        source, target, value, nodes=nodes, node=node, group=group, size=size, labels=labels
    )


def choropleth(
    data: Any,
    color: str | None = None,
    *,
    geometry: str | None = None,
    geojson: Any = None,
    locations: str | None = None,
    feature_id_key: str = "id",
    name: str | None = None,
    colors: str | Sequence[str] | None = None,
    color_domain: tuple[float, float] | None = None,
    color_midpoint: float | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """A map of regions colored by ``color`` (see ``Chart.geoshape``): shapes from
    ``data`` (a GeoDataFrame or GeoJSON FeatureCollection), or values from ``data``
    joined to the features of ``geojson`` by ``locations`` and ``feature_id_key``.
    Remaining keyword arguments are chart options (title, projection, ...)."""
    return _chart_of(data if geojson is None else None, options).geoshape(
        geometry,
        data=data if geojson is not None else None,
        geojson=geojson,
        locations=locations,
        feature_id_key=feature_id_key,
        name=name,
        color=color,
        colors=colors,
        color_domain=color_domain,
        color_midpoint=color_midpoint,
    )


def scatter_geo(
    data: Any,
    longitude: str,
    latitude: str,
    *,
    name: str | None = None,
    series: str | None = None,
    r: float | str | None = None,
    r_range: tuple[float, float] | None = None,
    color: str | None = None,
    colors: str | Sequence[str] | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """Points or bubbles on a map at ``longitude`` and ``latitude`` (see ``Chart.geopoint``)."""
    return _chart_of(data, options).geopoint(
        longitude,
        latitude,
        name=name,
        series=series,
        r=r,
        r_range=r_range,
        color=color,
        colors=colors,
    )


def candlestick(
    data: Any,
    x: str,
    open: str,
    high: str,
    low: str,
    close: str,
    *,
    variant: Literal["candlestick", "ohlc"] | None = None,
    rise: str | None = None,
    fall: str | None = None,
    label: str | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """A candlestick chart of open, high, low, and close prices; OHLC bars with
    ``variant="ohlc"``."""
    return _chart_of(data, options).candlestick(
        x, open, high, low, close, variant=variant, rise=rise, fall=fall, label=label
    )
