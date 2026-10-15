"""Charts: a Pythonic builder for the portable chart spec."""

from __future__ import annotations

import datetime as _dt
import difflib
import functools
import inspect
import json
import math
import numbers
import sys
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from os import PathLike
from typing import TYPE_CHECKING, Any, Literal, ParamSpec, Protocol, TypedDict, TypeVar

import numpy as np

from . import _geo, _render
from ._data import Column, Matrix, Table, listed, shown
from ._derive import BinSpec, Derived, Expr, _fields_of, bin_spec
from ._encoding import (
    SYMBOLS,
    BarLabels,
    Continuity,
    Coordinate,
    Encodings,
    Label,
    MarkStyle,
    Position,
    Stack,
    condition_spec,
    coordinate_field,
    coordinate_spec,
    encodings_spec,
    fraction_option,
    label_spec,
    mark_style_spec,
    tagged_spec,
)
from ._guides import (
    Format,
    Guide,
    LegendOptions,
    Scale,
    Ticks,
    format_spec,
    guides_spec,
    legend_spec,
    scales_spec,
    ticks_spec,
)
from ._rows import RowSelection, SelectionBinding, bindings
from ._style import (
    AXIS_ROLES,
    PANEL_ROLES,
    HaloOption,
    Style,
    Theme,
    ThemeName,
    Title,
    _built,
    _spec,
    halo_spec,
    insets,
    style_spec,
    theme_spec,
    title_spec,
)

# Annotations read at runtime (typing.get_type_hints) need Unpack too.
if sys.version_info >= (3, 11):
    from typing import Unpack
else:
    from typing_extensions import Unpack

if TYPE_CHECKING:
    from .widget import ChartWidget

TooltipMode = Literal["nearest-x", "nearest-y", "nearest"]
Dash = Sequence[float] | Literal["-", "--", ":", "-."]
Curve = Literal["linear", "step", "step-before", "step-after", "monotone"]
BarStack = bool | Literal["fill"]
AreaStack = bool | Literal["fill", "center", "wiggle"] | Stack | Mapping[str, Any]
Orient = Literal["x", "y"]
# What a mark's drawing is cut to: its plot, the whole chart, or nothing.
Clip = Literal["plot", "chart", False]
HistogramNormalize = Literal["count", "frequency", "probability", "percent", "density"]
HistogramElement = Literal["bars", "step", "poly"]
#: How rows sharing a heatmap's cell combine into its value.
CellReduce = Literal["last", "mean", "sum", "min", "max"]


class HeatmapSampling(TypedDict, total=False):
    """How a pixel showing several heatmap cells colors them: by their
    ``"mean"``, ``"max"``, or ``"min"``."""

    reduce: Literal["mean", "max", "min"]


_NUMERIC = ("number", "time")

# The spec format version charts are written in: the only one so far.
_SPEC_VERSION = 1

# Named color schemes: sequential, diverging, then categorical.
SCHEMES = (
    *("viridis", "magma", "inferno", "plasma", "cividis", "turbo"),
    *("blues", "greens", "greys", "oranges", "purples", "reds", "ylgnbu", "ylorrd"),
    *("rdbu", "rdylbu", "brbg", "piyg", "prgn", "puor", "spectral"),
    *("tableau10", "category10", "set2", "dark2"),
)


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
                "Break: expected one of weekdays, hours, dates, or start and end; "
                f"received {' and '.join(given) or 'none'}"
            )
        if self.weekdays is not None:
            days = [self.weekdays] if isinstance(self.weekdays, str) else list(self.weekdays)
            bad = [day for day in days if day not in _WEEKDAYS]
            if not days or bad:
                raise ValueError(
                    f"Break weekdays: expected names from {listed(_WEEKDAYS)}; "
                    f"received {shown(self.weekdays)}"
                )
            return {"weekdays": days}
        if self.hours is not None:
            if isinstance(self.hours, str) or len(self.hours) != 2:
                raise ValueError(
                    'Break hours: expected two times of day, as ("16:00", "09:30"); '
                    f"received {shown(self.hours)}"
                )
            return {"hours": [_clock(value) for value in self.hours]}
        if self.dates is not None:
            dates = [self.dates] if isinstance(self.dates, str | _dt.date) else list(self.dates)
            if not dates:
                raise ValueError(
                    f"Break dates: expected at least one date; received {shown(self.dates)}"
                )
            return {"dates": [_iso_date(value) for value in dates]}
        if self.start is None or self.end is None:
            raise ValueError("Break: a span of instants needs both start and end")
        start, end = _instant(self.start, "start"), _instant(self.end, "end")
        if not end > start:
            raise ValueError(
                f"Break end: expected an instant after start; received {shown(self.end)}"
            )
        return {"from": start, "to": end}


def _clock(value: str | _dt.time) -> str:
    """A time of day as "HH:MM"."""
    if isinstance(value, _dt.time):
        if value.second or value.microsecond:
            raise ValueError(f"Break hours: expected whole minutes; received {value!r}")
        return f"{value.hour:02d}:{value.minute:02d}"
    if not isinstance(value, str) or len(value.split(":")) != 2:
        raise ValueError(f'Break hours: expected times of day as "HH:MM"; received {shown(value)}')
    return value


def _iso_date(value: str | _dt.date) -> str:
    if isinstance(value, _dt.datetime):
        raise ValueError(f"Break dates: expected dates, not datetimes; received {value!r}")
    if isinstance(value, _dt.date):
        return value.isoformat()
    try:
        _dt.date.fromisoformat(value)
    except (TypeError, ValueError):
        raise ValueError(
            f'Break dates: expected dates or "YYYY-MM-DD" strings; received {shown(value)}'
        ) from None
    if len(value) != 10:
        raise ValueError(
            f'Break dates: expected dates or "YYYY-MM-DD" strings; received {shown(value)}'
        )
    return value


def _instant(value: Any, role: str) -> int:
    """An instant as whole epoch milliseconds."""
    if isinstance(value, numbers.Real) and not isinstance(value, bool):
        ms = float(value)
    else:
        from ._data import _time_ms

        try:
            ms = _time_ms(value)
        except TypeError:
            raise TypeError(
                f"Break {role}: expected a number or a datetime; received {shown(value)}"
            ) from None
    if not (math.isfinite(ms) and ms == int(ms)):
        raise ValueError(f"Break {role}: expected a whole millisecond; received {shown(value)}")
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
                "AxisOptions breaks: expected keys weekdays, hours, dates, or from and to; "
                f"received {sorted(rule)}"
            ) from None
    raise TypeError(
        f"AxisOptions breaks: expected hg.Break objects or dicts; received {shown(rule)}"
    )


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
        raise ValueError(f"{role}: {shown(unknown[0])} is not an Intl format option")


#: Which panels share one instance of a scale (``AxisOptions.scope``).
Scope = Literal["chart", "panel", "row", "column"]
SCOPES = ("chart", "panel", "row", "column")


@dataclass
class AxisOptions:
    """Scale and axis options for x or y. Unset options use herceg's defaults.

    ``breaks``, on a time x axis only, leave out spans of time (see ``Break``)::

        hg.AxisOptions(
            breaks=[hg.Break(weekdays=("sat", "sun")), hg.Break(hours=("16:00", "09:30"))]
        )

    ``seams=True`` marks their collapsed boundaries with dashed vertical lines;
    ``seams={"min_spacing": 40}`` sets their minimum spacing in CSS pixels.

    ``format`` writes tick labels and tooltips' values, as Intl format options;
    ``tooltip_format`` writes one value of the axis in tooltips, the keyboard's
    announcements, and crosshair labels only, such as ``{"weekday": "short",
    "month": "short", "day": "numeric"}`` or ``{"style": "unit", "unit":
    "millisecond"}``.

    ``scope``, on the chart's ``x``, ``y``, and ``y_right`` only, says which
    facet panels or subplots share one instance of the axis' scale:
    ``"chart"`` (every panel), ``"panel"`` (each its own), ``"row"``, or
    ``"column"``. By default x is the chart's, y is each subplot's own and the
    chart's in facets, and y_right is as y. A scale panels do not share takes
    its type from the marks of its own panels, so one subplot can show
    categories along y while another shows numbers.
    """

    type: Literal["linear", "log", "time"] | None = None
    domain: tuple[float, float] | None = None
    title: str | None = None
    nice: bool | None = None
    zero: bool | None = None
    grid: bool | None = None
    ticks: int | Ticks | dict[str, Any] | None = None
    format: Format | dict[str, Any] | None = None
    tooltip_format: Format | dict[str, Any] | None = None
    show: bool | None = None
    breaks: Sequence[Break | dict[str, Any]] | None = None
    seams: bool | dict[str, float] | None = None
    scope: Scope | None = None
    style: Style | dict[str, Any] | None = None

    def __post_init__(self) -> None:
        for name in ("format", "tooltip_format"):
            value = getattr(self, name)
            # Intl options as a dict of their names; patterns are hg.Format.
            if isinstance(value, dict) and not set(value) & {"number", "time"}:
                _check_format(value, f"AxisOptions {name}", _NUMBER_FORMAT | _TIME_FORMAT)
        if self.scope is not None and self.scope not in SCOPES:
            raise ValueError(
                f"AxisOptions scope: expected {listed(SCOPES)}; received {shown(self.scope)}"
            )

    def _spec(self) -> dict[str, Any]:
        seams = self.seams
        if seams is not None and not isinstance(seams, bool):
            if not isinstance(seams, dict) or any(key != "min_spacing" for key in seams):
                raise ValueError(
                    "AxisOptions seams: expected True, False, or a dict with min_spacing; "
                    f"received {shown(seams)}"
                )
            spacing = seams.get("min_spacing", 40)
            if (
                isinstance(spacing, bool)
                or not isinstance(spacing, (int, float))
                or not math.isfinite(spacing)
                or spacing <= 0
            ):
                raise ValueError(
                    "AxisOptions seams min_spacing: expected a finite, positive number of pixels; "
                    f"received {shown(spacing)}"
                )
            seams = {"minSpacing": seams["min_spacing"]} if seams else {}
        if seams is not None and seams is not False and self.breaks is None:
            raise ValueError(
                "AxisOptions seams: mark the breaks of a time x axis, and the axis has none; "
                "give breaks or drop seams"
            )
        spec = {
            "type": self.type,
            "domain": list(self.domain) if self.domain is not None else None,
            "title": self.title,
            "nice": self.nice,
            "zero": self.zero,
            "grid": self.grid,
            "ticks": ticks_spec(self.ticks, "AxisOptions ticks"),
            "format": format_spec(self.format, "AxisOptions format"),
            "tooltipFormat": format_spec(self.tooltip_format, "AxisOptions tooltip_format"),
            "show": self.show,
            "breaks": [_break(rule) for rule in self.breaks] if self.breaks is not None else None,
            "seams": seams,
            "scope": self.scope,
            "style": style_spec(self.style, "AxisOptions style", AXIS_ROLES),
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
                f"Projection type: expected {listed(PROJECTIONS)}; received {shown(self.type)}"
            )
        if self.central_meridian is not None and not _finite(self.central_meridian):
            raise ValueError(
                "Projection central_meridian: expected a finite longitude; "
                f"received {shown(self.central_meridian)}"
            )
        parallels = None
        if self.parallels is not None:
            parallels = _range(self.parallels, "Projection parallels", minimum=-90)
            if parallels is not None and parallels[1] > 90:
                raise ValueError(
                    "Projection parallels: expected latitudes from -90 to 90; "
                    f"received {self.parallels!r}"
                )
        fit: Any = self.fit
        if fit not in (None, "data", "world"):
            try:
                (west, south), (east, north) = fit
                box = [[float(west), float(south)], [float(east), float(north)]]
            except (TypeError, ValueError):
                raise ValueError(
                    'Projection fit: expected "data", "world", or ((west, south), (east, north)); '
                    f"received {shown(fit)}"
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
                    "Projection fit: expected longitudes and latitudes in degrees, south below "
                    f"north and west apart from east; received {fit!r}"
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


@dataclass(frozen=True)
class TooltipField:
    """A column a mark's tooltips show of the row they are at, besides its
    values: ``field`` names it, ``label`` names it in the tooltip (the
    column's name by default), and ``format`` writes it, as Intl format
    options (``{"maximumFractionDigits": 0}``, ``{"weekday": "short"}``), as
    ``AxisOptions.format`` takes them. Without a format, numbers are written as the
    chart's other numbers, times as the x axis writes them when it is a time
    axis (else as dates and times), and categories as they are."""

    field: str
    label: str | None = None
    format: dict[str, Any] | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.field, str):
            raise TypeError(
                f"TooltipField field: expected a column name; received {shown(self.field)}"
            )
        _check_format(self.format, "TooltipField format", _NUMBER_FORMAT | _TIME_FORMAT)

    def _spec(self) -> dict[str, Any]:
        spec = {"field": self.field, "label": self.label, "format": self.format}
        return {key: value for key, value in spec.items() if value is not None}


@dataclass
class Tooltip:
    """Tooltip options: ``mode`` ("nearest-x", "nearest-y", or "nearest"; by
    default one suited to the marks) and ``axis_labels``, which labels the
    crosshair on the axes, as financial charts do: the inspected value on the
    axis it follows and the pointer's position on the other.

    ``fields`` are columns of the row a tooltip is at that it shows besides a
    mark's values, such as a count that is not plotted: column names or
    ``hg.TooltipField``. They belong to marks whose points are rows (lines,
    areas, bars, points, heatmaps, maps, 3D points and lines): give them to
    the mark, ``chart.line(..., tooltip=hg.Tooltip(fields=["requests"]))``,
    or to a one-call helper, ``hg.line(..., tooltip=...)``, whose one mark
    takes them. The keyboard's announcements and hover events read them too.
    """

    mode: TooltipMode | None = None
    axis_labels: bool = False
    fields: Sequence[str | TooltipField] | None = None

    def _spec(self) -> dict[str, Any]:
        if self.fields is not None:
            raise ValueError(
                "Chart tooltip fields: belong to the marks whose rows they show; give "
                "them to a mark, as in chart.line(..., tooltip=hg.Tooltip(fields=[...]))"
            )
        spec: dict[str, Any] = {}
        if self.mode is not None:
            spec["mode"] = self.mode
        if self.axis_labels:
            spec["axisLabels"] = True
        return spec

    def _mark_spec(self, mark: str) -> dict[str, Any]:
        """The tooltip of mark ``mark``: its fields."""
        if self.mode is not None or self.axis_labels:
            option = "mode" if self.mode is not None else "axis_labels"
            raise ValueError(
                f"{mark} tooltip {option}: is the chart's; give it to the chart's tooltip"
            )
        if self.fields is None:
            return {}
        if isinstance(self.fields, str):
            raise ValueError(
                f"{mark} tooltip fields: expected a list of columns; received {shown(self.fields)}"
            )
        fields: list[Any] = []
        for i, entry in enumerate(self.fields):
            if isinstance(entry, TooltipField):
                fields.append(entry._spec())
            elif isinstance(entry, str):
                fields.append(entry)
            else:
                raise TypeError(
                    f"{mark} tooltip fields[{i}]: expected a column name or an hg.TooltipField; "
                    f"received {shown(entry)}"
                )
        return {"fields": fields}


@dataclass
class Animation:
    """Animation options (the chart's ``animation``): ``duration`` in
    milliseconds, and ``values``, with which bars, pie slices, and lines and
    areas whose x values stay also move to changed values when a live
    chart's data is replaced, the axes with them, besides the axes moving to
    views asked for. ``animation=True`` is ``Animation()``, and a number is a
    duration."""

    duration: float = 250
    values: bool = False

    def _spec(self) -> dict[str, Any]:
        if not (_finite(self.duration) and self.duration >= 0):
            raise ValueError(
                "Animation duration: expected milliseconds of at least 0; "
                f"received {shown(self.duration)}"
            )
        spec: dict[str, Any] = {"duration": self.duration}
        if self.values:
            spec["values"] = True
        return spec


@dataclass
class Navigator:
    """A range navigator (the chart's ``navigator``): a strip under the plot
    drawing the chart's marks over the whole x axis, with a window showing
    the x range in view, which dragging and the keyboard move and resize.

    ``height`` is the strip's height in pixels (40 by default, at least 16,
    and at most a third of what the plots and the strip share; a chart too
    short to leave its plots room beside a 16-pixel strip has none);
    ``marks`` names the ``id`` of each mark the strip draws (by default every
    line, area, scatter, bar, and candlestick mark). ``navigator=True`` is
    ``Navigator()``. The chart needs a number or time x axis; with facets or
    panels, the strip goes under all of them, draws every panel's marks, and
    moves the x range they share, so the x axis' scope must be ``"chart"``.
    """

    height: float | None = None
    marks: Sequence[str] | None = None
    halo: HaloOption | None = None

    def _spec(self) -> dict[str, Any]:
        spec: dict[str, Any] = {}
        if self.height is not None:
            if isinstance(self.height, bool) or not (_finite(self.height) and self.height >= 16):
                raise ValueError(
                    f"Navigator height: expected at least 16 pixels; received {shown(self.height)}"
                )
            spec["height"] = float(self.height)
        if self.marks is not None:
            if isinstance(self.marks, str) or not all(isinstance(m, str) for m in self.marks):
                raise ValueError(
                    f"Navigator marks: expected a list of mark ids; received {shown(self.marks)}"
                )
            ids = list(self.marks)
            repeated = next((m for i, m in enumerate(ids) if m in ids[:i]), None)
            if repeated is not None:
                raise ValueError(
                    f"Navigator marks: {shown(repeated)} is listed twice; list each mark once"
                )
            spec["marks"] = ids
        if self.halo is not None:
            spec["halo"] = _halo(self.halo, "Navigator")
        return spec


@dataclass
class Jitter:
    """How points in the bands of a category axis spread (``Chart.point``'s
    ``jitter``): across ``width``, a fraction from 0 to 1 of their band (or,
    with ``dodge``, of their series' share of it), by a hash of each row and
    ``seed``, so the same rows land in the same places on every draw, also
    as a live chart streams. ``jitter=0.4`` is ``Jitter(width=0.4)``."""

    width: float = 0.5
    seed: int = 0

    def _spec(self) -> dict[str, Any]:
        if isinstance(self.width, bool) or not (_finite(self.width) and 0 <= self.width <= 1):
            raise ValueError(
                f"Jitter width: expected a number from 0 to 1; received {shown(self.width)}"
            )
        if isinstance(self.seed, bool) or not isinstance(self.seed, numbers.Integral):
            raise ValueError(f"Jitter seed: expected a whole number; received {shown(self.seed)}")
        spec: dict[str, Any] = {"width": float(self.width)}
        if self.seed:
            spec["seed"] = int(self.seed)
        return spec


@dataclass
class Camera:
    """Where a 3D chart is seen from at first (the chart's ``camera``).

    ``azimuth`` is the eye's direction around the vertical z axis, in degrees
    counterclockwise from +x seen from above; ``elevation`` its height above
    the floor, from -90 (from below) to 90 (from above). ``zoom`` magnifies
    the box (1 fits it in the chart; from 0.5 to 10), and ``perspective``
    draws nearer things larger instead of projecting orthographically.
    Dragging, the wheel (with ``zoom=True``), and the keyboard turn it after.
    """

    azimuth: float = -60
    elevation: float = 25
    zoom: float = 1
    perspective: bool = False

    def _spec(self) -> dict[str, Any]:
        if not _finite(self.azimuth):
            raise ValueError(
                "Camera azimuth: expected a finite number of degrees; "
                f"received {shown(self.azimuth)}"
            )
        if not (_finite(self.elevation) and -90 <= self.elevation <= 90):
            raise ValueError(
                "Camera elevation: expected degrees from -90 to 90; "
                f"received {shown(self.elevation)}"
            )
        if not (_finite(self.zoom) and 0.5 <= self.zoom <= 10):
            raise ValueError(
                f"Camera zoom: expected a number from 0.5 to 10; received {shown(self.zoom)}"
            )
        if not isinstance(self.perspective, bool):
            raise ValueError(
                f"Camera perspective: expected True or False; received {shown(self.perspective)}"
            )
        spec: dict[str, Any] = {
            "azimuth": float(self.azimuth),
            "elevation": float(self.elevation),
            "zoom": float(self.zoom),
        }
        if self.perspective:
            spec["perspective"] = True
        return spec


@dataclass
class Panel:
    """One of a chart's ``panels``: marks with ``panel=id`` draw in it.

    ``x``, ``y``, and ``y_right`` set the panel's own axes over the chart's
    ``x``, ``y``, and ``y_right`` (the right axis of its marks with
    ``axis="right"``); panels sharing an x scale take the first one's.
    """

    id: str
    title: str | Title | dict[str, Any] | None = None
    y: AxisOptions | dict[str, Any] | None = None
    x: AxisOptions | dict[str, Any] | None = None
    y_right: AxisOptions | dict[str, Any] | None = None
    camera: Camera | dict[str, Any] | None = None
    style: Style | dict[str, Any] | None = None

    def _spec(self) -> dict[str, Any]:
        spec = {
            "id": self.id,
            "title": title_spec(self.title, "Panel title", placed=False),
            "style": style_spec(self.style, "Panel style", PANEL_ROLES),
            "x": _axis(self.x, "Panel x"),
            "y": _axis(self.y, "Panel y"),
            "yRight": _axis(self.y_right, "Panel y_right"),
            "camera": _camera(self.camera, "Panel camera", partial=True),
        }
        return {key: value for key, value in spec.items() if value is not None}


class _SharedOptions(TypedDict, total=False):
    title: str | Title | dict[str, Any] | None
    description: str | None
    width: int | None
    height: int | None
    y_right: AxisOptions | dict[str, Any] | None
    legend: bool | LegendOptions | dict[str, Any] | None
    scales: dict[str, Scale | dict[str, Any]] | None
    guides: Sequence[Guide] | None
    padding: float | dict[str, float] | None
    tooltip: bool | TooltipMode | Tooltip | None
    zoom: bool | Literal["x", "y", "xy"] | None
    brush: Literal["x", "y", "xy", "lasso"] | None
    sync: str | None
    animation: bool | float | Animation | None
    renderer: Literal["auto", "svg", "canvas"] | None
    theme: ThemeName | Theme | dict[str, Any] | None
    locale: str | None
    time_zone: str | None
    projection: ProjectionName | Projection | dict[str, Any] | None
    camera: Camera | dict[str, Any] | None
    box_aspect: tuple[float, float, float] | None
    rotate: bool | None
    drag: bool | None
    navigator: bool | Navigator | dict[str, Any] | None


class _LayoutOptions(TypedDict, total=False):
    facet: str | None
    facet_columns: int | None
    facet_row: str | None
    facet_column: str | None
    panels: Sequence[Panel | str] | None
    panel_columns: int | None
    panel_row_heights: Sequence[float] | None
    panel_column_widths: Sequence[float] | None


class _BindingOptions(TypedDict, total=False):
    row_selection: SelectionBinding | Sequence[SelectionBinding] | None


class ChartUpdate(_SharedOptions, total=False):
    """Chart options a live chart can change (``widget.update``): those of
    ``Chart`` but data, facets, and panels. ``None`` takes an option's default."""

    x: AxisOptions | dict[str, Any] | None
    y: AxisOptions | dict[str, Any] | None
    z: AxisOptions | dict[str, Any] | None


class ChartOptions(ChartUpdate, _LayoutOptions, _BindingOptions, total=False):
    """``Chart``'s keyword arguments. ``None`` takes an option's default."""


class HelperOptions(_SharedOptions, _LayoutOptions, _BindingOptions, total=False):
    """Chart options as the one-call helpers (``hg.line``, ``hg.scatter``, ...)
    take them, after their own: ``x_axis``, ``y_axis``, and ``z_axis`` are the
    chart's ``x``, ``y``, and ``z``, since the helpers' ``x``, ``y``, and ``z``
    name columns."""

    x_axis: AxisOptions | dict[str, Any] | None
    y_axis: AxisOptions | dict[str, Any] | None
    z_axis: AxisOptions | dict[str, Any] | None


_P = ParamSpec("_P")
_R = TypeVar("_R")


def _own_options(function: Callable[..., Any]) -> set[str]:
    return {
        name
        for name, parameter in inspect.signature(function).parameters.items()
        if name != "self" and parameter.kind is not parameter.VAR_KEYWORD
    }


def _check_method_options(function: Callable[_P, _R]) -> Callable[_P, _R]:
    """Keep method signatures while reporting unknown options like helpers do."""
    known = _own_options(function)

    @functools.wraps(function)
    def checked(*args: _P.args, **kwargs: _P.kwargs) -> _R:
        for name in kwargs:
            if name not in known:
                raise TypeError(_unknown_option(function, name, known))
        return function(*args, **kwargs)

    return checked


#: The channels each mark's ``encode`` takes.
_LINE_CHANNELS = ("color", "stroke", "dash", "stroke_width", "opacity")
_AREA_CHANNELS = ("color", "fill", "stroke", "opacity")
_BAR_CHANNELS = ("color", "fill", "stroke", "stroke_width", "opacity")


def _markers(value: Any) -> Any:
    """Lines' markers: True, False, or a shape name."""
    if value is None or isinstance(value, bool):
        return value
    if value not in SYMBOLS:
        raise ValueError(
            f"line markers: expected True, False, or a shape ({listed(SYMBOLS)}); "
            f"received {shown(value)}"
        )
    return value


def _continuity(value: Any, mark: str) -> Any:
    if value is None:
        return None
    return _built(value, Continuity, f"{mark} continuity")._spec()


def _dash(value: Dash | None, mark: str) -> str | list[float] | None:
    if value is None:
        return None
    if isinstance(value, str):
        if value not in ("-", "--", ":", "-."):
            raise ValueError(
                f'{mark} dash: expected an array or "-", "--", ":", or "-."; '
                f"received {shown(value)}"
            )
        return value
    return list(value)


def _check_stack(stack: AreaStack, mark: str) -> None:
    choices = ("fill", "center", "wiggle") if mark == "area" else ("fill",)
    if not isinstance(stack, bool) and stack not in choices:
        correction = (
            'choose True, False, "fill", "center", or "wiggle"'
            if mark == "area"
            else 'choose True, False, or "fill"; use an area for "center" or "wiggle"'
        )
        raise ValueError(f"{mark} stack: unsupported stack {shown(stack)}; {correction}")


def _check_stack_values(table: _Columns, fields: str | Sequence[str], mark: str) -> None:
    for field in [fields] if isinstance(fields, str) else fields:
        values = table.column(field).values
        if np.any(np.isfinite(values) & (values < 0)):
            raise ValueError(
                f"{mark} stack {field}: negative values have no nonnegative share "
                "or stream thickness; "
                "use stack=True for signed values"
            )


class Chart:
    """A chart: data, marks drawn in order, and options.

    Marks are added with methods that return the chart, so calls chain::

        chart = (
            hg.Chart(df, title="Latency", y=hg.AxisOptions(title="ms"))
            .line(x="time", y=["p50", "p99"])
            .rule(y=250, label="SLO")
        )

    ``data`` is any table herceg reads (pandas, Polars, or PyArrow tables, a
    mapping of column names to arrays, or a list of records); marks use it
    unless they pass their own ``data``.
    """

    @_check_method_options
    def __init__(
        self,
        data: Any = None,
        *,
        title: str | Title | dict[str, Any] | None = None,
        description: str | None = None,
        width: int | None = None,
        height: int | None = None,
        x: AxisOptions | dict[str, Any] | None = None,
        y: AxisOptions | dict[str, Any] | None = None,
        y_right: AxisOptions | dict[str, Any] | None = None,
        facet: str | None = None,
        facet_columns: int | None = None,
        facet_row: str | None = None,
        facet_column: str | None = None,
        panels: Sequence[Panel | str] | None = None,
        panel_columns: int | None = None,
        panel_row_heights: Sequence[float] | None = None,
        panel_column_widths: Sequence[float] | None = None,
        legend: bool | LegendOptions | dict[str, Any] | None = None,
        scales: dict[str, Scale | dict[str, Any]] | None = None,
        guides: Sequence[Guide] | None = None,
        padding: float | dict[str, float] | None = None,
        tooltip: bool | TooltipMode | Tooltip | None = True,
        zoom: bool | Literal["x", "y", "xy"] | None = False,
        brush: Literal["x", "y", "xy", "lasso"] | None = None,
        sync: str | None = None,
        animation: bool | float | Animation | None = False,
        renderer: Literal["auto", "svg", "canvas"] | None = None,
        theme: ThemeName | Theme | dict[str, Any] | None = None,
        locale: str | None = None,
        time_zone: str | None = None,
        projection: ProjectionName | Projection | dict[str, Any] | None = None,
        z: AxisOptions | dict[str, Any] | None = None,
        camera: Camera | dict[str, Any] | None = None,
        box_aspect: tuple[float, float, float] | None = None,
        rotate: bool | None = True,
        drag: bool | None = None,
        navigator: bool | Navigator | dict[str, Any] | None = None,
        row_selection: SelectionBinding | Sequence[SelectionBinding] | None = None,
    ) -> None:
        if facet_columns is not None and facet is None:
            raise ValueError("Chart facet_columns: wraps the panels of facet; give facet")
        if facet is not None and (facet_row is not None or facet_column is not None):
            raise ValueError(
                "Chart facet: facet, or facet_row and facet_column, not both; drop one"
            )
        panel_list = [Panel(p) if isinstance(p, str) else p for p in panels or ()]
        if panels is not None and not panel_list:
            raise ValueError(f"Chart panels: expected at least one panel; received {panels!r}")
        ids = [p.id for p in panel_list]
        bad = [i for i in ids if not isinstance(i, str) or i in ("", "*")]
        if bad:
            raise ValueError(
                'Chart panels: expected ids that are names other than "" and "*"; '
                f"received {shown(bad[0])}"
            )
        if len(set(ids)) != len(ids):
            repeated = next(i for n, i in enumerate(ids) if i in ids[:n])
            raise ValueError(
                f"Chart panels: {shown(repeated)} names two panels; give each panel its own id"
            )
        if panel_columns is not None and not panel_list:
            raise ValueError("Chart panel_columns: lays out panels, and the chart has none")
        if panel_columns is not None and not (
            isinstance(panel_columns, int)
            and not isinstance(panel_columns, bool)
            and panel_columns >= 1
        ):
            raise ValueError(
                "Chart panel_columns: expected a whole number of at least 1; "
                f"received {shown(panel_columns)}"
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
        if panel_list and (facet is not None or facet_row is not None or facet_column is not None):
            raise ValueError("Chart panels: facets or panels, not both; drop one")
        if panel_list:
            _check_subplot_ranges({"zoom": zoom, "brush": brush})
        axes = {"x": x, "y": y, "y_right": y_right, "scales": scales}
        # One window shows one x range, so every panel must share it.
        x_scope = axis_scope(axes, "x")
        if _navigator(navigator) is not None and x_scope not in (None, "chart"):
            raise ValueError(
                "Chart navigator: needs one x scale shared by every panel, and x's scope is "
                f'{shown(x_scope)}; give x scope "chart" or drop navigator'
            )
        check_y_zoom({"zoom": zoom, **axes}, right=False, subplots=bool(panel_list))
        _animation(animation)
        if facet_row is not None and facet_row == facet_column:
            raise ValueError(
                f"Chart facet_column: {facet_column!r} is facet_row too; "
                "facet rows and columns by different fields"
            )
        # bool is an int in Python, but True columns would be meaningless.
        if facet_columns is not None and not (
            isinstance(facet_columns, int)
            and not isinstance(facet_columns, bool)
            and facet_columns >= 1
        ):
            raise ValueError(
                "Chart facet_columns: expected a whole number of at least 1; "
                f"received {shown(facet_columns)}"
            )
        self._facet = facet
        self._facet_columns = facet_columns
        self._facet_row = facet_row
        self._facet_column = facet_column
        # The fields that split rows into panels.
        self._facets = [f for f in (facet, facet_row, facet_column) if f is not None]
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
            "scales": scales,
            "guides": guides,
            "padding": padding,
            "tooltip": tooltip,
            "zoom": zoom,
            "brush": brush,
            "sync": sync,
            "animation": animation,
            "renderer": renderer,
            "theme": theme,
            "locale": locale,
            "time_zone": time_zone,
            "projection": projection,
            "z": z,
            "camera": camera,
            "box_aspect": box_aspect,
            "rotate": rotate,
            "drag": drag,
            "navigator": navigator,
        }
        self._options = spec_options(self._settings)
        # Bindings to channels of row selections, one per table (see SelectionBinding).
        self._row_selection = bindings(row_selection)

    # Marks -----------------------------------------------------------------

    @_check_method_options
    def line(
        self,
        x: str | Sequence[str],
        y: str | Sequence[str],
        *,
        orient: Orient | None = None,
        series: str | None = None,
        dodge: bool = False,
        data: Any = None,
        color: str | None = None,
        stroke: str | None = None,
        stroke_width: float | None = None,
        dash: Dash | None = None,
        opacity: float | None = None,
        stroke_opacity: float | None = None,
        encode: Encodings | Mapping[str, Any] | None = None,
        style: MarkStyle | Mapping[str, Any] | None = None,
        markers: bool | str | None = None,
        continuity: Continuity | Mapping[str, Any] | None = None,
        where: Expr | None = None,
        curve: Curve | None = None,
        label: str | None = None,
        legend_group: str | None = None,
        legend: Literal[False] | None = None,
        axis: Literal["left", "right"] | None = None,
        facet: Literal["repeat"] | None = None,
        panel: str | None = None,
        clip: Clip | None = None,
        tooltip: Tooltip | None = None,
        id: str | None = None,
    ) -> Chart:
        """Lines through x and y columns; several value columns or a series column give
        several lines.

        Lines run along x: positions in ``x`` (numbers, times, or categories,
        at their bands' centers in band order) and values in ``y``. With
        ``orient="y"``, or a category ``y``, they run along y instead
        (depth profiles), with values in ``x``, and tooltips and the
        keyboard read them by y. On a category axis, ``dodge=True`` places
        the series of a ``series`` column side by side in each band, as
        grouped bars and dodged points are.

        ``color`` is a CSS color, or a column whose values color the series
        through the chart's ``"color"`` scale (``scales={"color":
        hg.Scale(type="ordinal", map={...})}`` fixes them); ``stroke`` wins
        over it. ``encode`` gives channels by column, scale, or condition
        (``hg.Encodings``); ``style=hg.MarkStyle(by=hg.StyleMap(...))``
        styles series by value, such as an ``"Average"`` series dashed.
        ``markers=True`` (or a shape name) draws a point at each observation.
        ``continuity`` (``hg.Continuity``) says which neighbors connect, and
        ``where`` leaves rows out as gaps, meeting the line where the
        condition changes.
        """
        table = self._mark_table(data)
        along, x_spec, y_spec = self._oriented(table, "line", x, y, orient)
        _left_along_y("line", along, axis)
        self._require(table, series, ("category",), "line series")
        self._single_or_series(y_spec if along == "x" else x_spec, series, "line")
        self._check_dodge(table, "line", dodge, along, x_spec if along == "x" else y_spec, series)
        return self._add(
            {
                "type": "line",
                "x": x_spec,
                "y": y_spec,
                "orient": orient,
                "series": series,
                "dodge": dodge or None,
                "color": color,
                "stroke": stroke,
                "strokeWidth": stroke_width,
                "dash": _dash(dash, "line"),
                "opacity": fraction_option(opacity, "line opacity"),
                "strokeOpacity": fraction_option(stroke_opacity, "line stroke_opacity"),
                "encode": encodings_spec(encode, _LINE_CHANNELS, "line"),
                "style": mark_style_spec(style, ("marker",), "line"),
                "markers": _markers(markers),
                "continuity": _continuity(continuity, "line"),
                "where": condition_spec(where, "line where"),
                "curve": curve,
                "label": label,
                "legendGroup": _legend_group(legend_group, "line"),
                "legend": _mark_legend(legend, "line"),
                "axis": axis,
                "facet": _mark_facet(facet, "line"),
                "panel": panel,
                "clip": _clip(clip, "line"),
                "tooltip": self._mark_tooltip(table, tooltip, "line"),
                "id": id,
            },
            table,
        )

    @_check_method_options
    def area(
        self,
        x: str | Sequence[str] | None = None,
        y: str | Sequence[str] | None = None,
        *,
        y1: str | None = None,
        y2: str | None = None,
        x1: str | None = None,
        x2: str | None = None,
        orient: Orient | None = None,
        series: str | None = None,
        stack: AreaStack = False,
        dodge: bool = False,
        data: Any = None,
        color: str | None = None,
        fill: str | None = None,
        fill_opacity: float | None = None,
        line: bool | None = None,
        stroke: str | None = None,
        stroke_width: float | None = None,
        opacity: float | None = None,
        stroke_opacity: float | None = None,
        encode: Encodings | Mapping[str, Any] | None = None,
        style: MarkStyle | Mapping[str, Any] | None = None,
        continuity: Continuity | Mapping[str, Any] | None = None,
        where: Expr | None = None,
        curve: Curve | None = None,
        label: str | None = None,
        legend_group: str | None = None,
        legend: Literal[False] | None = None,
        axis: Literal["left", "right"] | None = None,
        facet: Literal["repeat"] | None = None,
        panel: str | None = None,
        clip: Clip | None = None,
        tooltip: Tooltip | None = None,
        id: str | None = None,
    ) -> Chart:
        """Filled areas: down to zero, stacked, or the band between ``y1`` and ``y2``.

        Areas run along x, as lines do, or with ``orient="y"`` (or a category
        ``y``) along y, filled across x to zero; along y, ``x1`` and ``x2``
        give a band. ``stack=True`` stacks several value columns row by row,
        or the series of a ``series`` column on every position any of them
        has. There, a series counts as zero at a position where it has no
        row, or with ``stack=hg.Stack(gaps="interpolate")`` as the straight
        line between its rows on either side. On a category axis,
        ``dodge=True`` places unstacked series side by side in each band.

        ``stack="fill"`` shows shares of each position's visible total.
        ``"center"`` centers raw thickness around zero; ``"wiggle"`` uses
        the Byron–Wattenberg stream baseline. These offsets require
        nonnegative values; ``hg.Stack(offset=..., order="inside-out")``
        reorders their layers geometrically.

        A single area has an outline along its top in its own color; stacked
        and band areas have none unless ``line=True``. ``stroke`` and
        ``stroke_width`` set the outline's color and width, and turn it on.
        ``color`` is a CSS color or a column coloring the series through the
        chart's ``"color"`` scale (``fill`` wins over it); ``encode``,
        ``style``, ``continuity``, and ``where`` work as for lines, with
        ``where`` shading only where its condition holds (a conditional
        band).
        """
        stacking = _built(stack, Stack, "area stack") if isinstance(stack, Mapping) else stack
        if isinstance(stacking, Stack):
            offset = stacking.offset or "zero"
            spread: Any = True if offset == "zero" else offset
            gaps = stacking.gaps
        else:
            _check_stack(stack, "area")
            spread, gaps = stack, None
        if stroke_width is not None and not (_finite(stroke_width) and stroke_width >= 0):
            raise ValueError(
                f"area stroke_width: expected 0 or more pixels; received {shown(stroke_width)}"
            )
        table = self._mark_table(data)
        along_x = y1 is not None or y2 is not None
        along_y = x1 is not None or x2 is not None
        if along_x and along_y:
            raise ValueError("area: a band along x (y1, y2) or along y (x1, x2), not both")
        x_spec: str | list[str] | None
        y_spec: str | list[str] | None
        runs: Orient
        if along_x or along_y:
            low, high, values, position = ("y1", "y2", y, x) if along_x else ("x1", "x2", x, y)
            runs = "x" if along_x else "y"
            ends = (y1, y2) if along_x else (x1, x2)
            if ends[0] is None or ends[1] is None:
                missing = low if ends[0] is None else high
                raise ValueError(f"area {missing}: a band needs both {low} and {high}")
            if values is not None:
                other = "y" if along_x else "x"
                raise ValueError(f"area {other}: {other}, or {low} and {high}, not both; drop one")
            if series is not None or spread:
                option = "series" if series is not None else "stack"
                raise ValueError(
                    f"area {option}: a band ({low} and {high}) has no series or stack; "
                    f"drop {option}"
                )
            if orient is not None and orient != runs:
                raise ValueError(
                    f"area orient: a band between {low} and {high} runs along {runs}; drop orient"
                )
            if position is None or not isinstance(position, str):
                raise ValueError(f"area {runs}: a band runs along one {runs} column; give it")
            self._require(table, position, (*_NUMERIC, "category"), f"area {runs}")
            self._require(table, ends[0], _NUMERIC, f"area {low}")
            self._require(table, ends[1], _NUMERIC, f"area {high}")
            self._check_dodge(table, "area", dodge, runs, position, None)
            x_spec, y_spec = (position, None) if along_x else (None, position)
            _left_along_y("area", runs, axis)
        else:
            if x is None or y is None:
                raise ValueError(
                    "area: needs x and y, or a band: y1 and y2 along x, or x1 and x2 along y"
                )
            runs, x_values, y_values = self._oriented(table, "area", x, y, orient)
            x_spec, y_spec = x_values, y_values
            _left_along_y("area", runs, axis)
            self._require(table, series, ("category",), "area series")
            self._single_or_series(y_values if runs == "x" else x_values, series, "area")
            if isinstance(spread, str):
                _check_stack_values(
                    self._tables[table][1], y_values if runs == "x" else x_values, "area"
                )
            if dodge and spread:
                raise ValueError(
                    "area dodge: a stack's layers stand on each other; drop dodge or stack"
                )
            self._check_dodge(table, "area", dodge, runs, x_spec if runs == "x" else y_spec, series)
        if gaps is not None and series is None:
            raise ValueError(
                "area stack gaps: for stacks by a series column; give series, or drop gaps"
            )
        if spread and (where is not None or continuity is not None):
            option = "where" if where is not None else "continuity"
            raise ValueError(
                f"area {option}: stacked areas cannot leave rows out yet; drop it or the stack"
            )
        return self._add(
            {
                "type": "area",
                "x": x_spec,
                "y": y_spec,
                "y1": y1,
                "y2": y2,
                "x1": x1,
                "x2": x2,
                "orient": orient,
                "series": series,
                "stack": _spec(stacking) if isinstance(stacking, Stack) else stack or None,
                "dodge": dodge or None,
                "color": color,
                "fill": fill,
                "fillOpacity": fill_opacity,
                "line": line,
                "stroke": stroke,
                "strokeWidth": stroke_width,
                "opacity": fraction_option(opacity, "area opacity"),
                "strokeOpacity": fraction_option(stroke_opacity, "area stroke_opacity"),
                "encode": encodings_spec(encode, _AREA_CHANNELS, "area"),
                "style": mark_style_spec(style, (), "area"),
                "continuity": _continuity(continuity, "area"),
                "where": condition_spec(where, "area where"),
                "curve": curve,
                "label": label,
                "legendGroup": _legend_group(legend_group, "area"),
                "legend": _mark_legend(legend, "area"),
                "axis": axis,
                "facet": _mark_facet(facet, "area"),
                "panel": panel,
                "clip": _clip(clip, "area"),
                "tooltip": self._mark_tooltip(table, tooltip, "area"),
                "id": id,
            },
            table,
        )

    @_check_method_options
    def bar(
        self,
        x: str | Sequence[str],
        y: str | Sequence[str],
        *,
        series: str | None = None,
        stack: BarStack = False,
        dodge: bool | None = None,
        data: Any = None,
        color: str | None = None,
        fill: str | None = None,
        fill_opacity: float | None = None,
        stroke: str | None = None,
        stroke_width: float | None = None,
        stroke_opacity: float | None = None,
        dash: Dash | None = None,
        opacity: float | None = None,
        encode: Encodings | Mapping[str, Any] | None = None,
        style: MarkStyle | Mapping[str, Any] | None = None,
        label: str | None = None,
        legend_group: str | None = None,
        legend: Literal[False] | None = None,
        labels: bool | BarLabels | Mapping[str, Any] = False,
        axis: Literal["left", "right"] | None = None,
        facet: Literal["repeat"] | None = None,
        panel: str | None = None,
        clip: Clip | None = None,
        tooltip: Tooltip | None = None,
        halo: HaloOption | None = None,
        id: str | None = None,
    ) -> Chart:
        """Bars: one band per category of x, or bars centered on number or time x.

        A category ``y`` makes the bars horizontal, with lengths in ``x``.
        Several series (a ``series`` column's values, or several ``y``
        columns) stand side by side at each position, as grouped bars, unless
        ``dodge=False`` overlaps them or ``stack`` piles them; coloring bars by
        a column (``color="site"``, through the chart's ``"color"`` scale)
        makes no series, so never places them apart. ``stroke`` and
        ``stroke_width`` outline each bar.
        ``labels=True`` writes each value at its bar's end (inside each segment
        when stacked); ``hg.BarLabels`` formats, styles, and filters them
        (white or black text by contrast with the bar unless its style sets a
        color). ``stack="fill"`` normalizes nonnegative values per position,
        and labels show shares. Tooltip and keyboard text also report the raw
        values.
        """
        _check_stack(stack, "bar")
        if dodge and stack:
            raise ValueError("bar dodge: stacked bars pile up in one slot; drop dodge or stack")
        value_labels: BarLabels | None = None
        if labels is not False and labels is not True:
            value_labels = _built(labels, BarLabels, "bar labels")
            pattern = value_labels.format
            if isinstance(pattern, Mapping) and not {"number", "time"} & set(pattern):
                _check_format(dict(pattern), "bar labels format", _NUMBER_FORMAT)
        for name, value in (("stroke_opacity", stroke_opacity), ("opacity", opacity)):
            fraction_option(value, f"bar {name}")
        if stroke_width is not None and not (_finite(stroke_width) and stroke_width >= 0):
            raise ValueError(
                f"bar stroke_width: expected 0 or more pixels; received {shown(stroke_width)}"
            )
        table = self._mark_table(data)
        if isinstance(y, str) and self._kind(table, y) == "category":
            if axis == "right":
                raise ValueError('bar axis: horizontal bars have no right axis; drop axis="right"')
            xs = self._require_many(table, x, _NUMERIC, "bar x")
            self._single_or_series(xs, series, "bar")
            ys: str | list[str] = y
        else:
            if not isinstance(x, str):
                raise ValueError(
                    "bar x: several columns need a category y, for horizontal bars; "
                    "give one x column"
                )
            self._require(table, x, ("number", "time", "category"), "bar x")
            xs = x
            ys = self._require_many(table, y, _NUMERIC, "bar y")
            self._single_or_series(ys, series, "bar")
        self._require(table, series, ("category",), "bar series")
        if stack == "fill":
            _check_stack_values(
                self._tables[table][1],
                xs if isinstance(y, str) and self._kind(table, y) == "category" else ys,
                "bar",
            )
        return self._add(
            {
                "type": "bar",
                "halo": _halo(halo, "bar"),
                "x": xs,
                "y": ys,
                "series": series,
                "stack": stack or None,
                "dodge": dodge,
                "color": color,
                "fill": fill,
                "fillOpacity": fill_opacity,
                "stroke": stroke,
                "strokeWidth": stroke_width,
                "strokeOpacity": stroke_opacity,
                "dash": _dash(dash, "bar"),
                "opacity": opacity,
                "encode": encodings_spec(encode, _BAR_CHANNELS, "bar"),
                "style": mark_style_spec(style, (), "bar"),
                "label": label,
                "legendGroup": _legend_group(legend_group, "bar"),
                "legend": _mark_legend(legend, "bar"),
                "labels": value_labels._spec() if value_labels else labels or None,
                "axis": axis,
                "facet": _mark_facet(facet, "bar"),
                "panel": panel,
                "clip": _clip(clip, "bar"),
                "tooltip": self._mark_tooltip(table, tooltip, "bar"),
                "id": id,
            },
            table,
        )

    @_check_method_options
    def rug(
        self,
        x: str | None = None,
        *,
        y: str | None = None,
        series: str | None = None,
        data: Any = None,
        length: float | None = None,
        side: Literal["bottom", "top", "left", "right"] | None = None,
        stroke: str | None = None,
        stroke_width: float | None = None,
        label: str | None = None,
        legend_group: str | None = None,
        legend: Literal[False] | None = None,
        axis: Literal["left", "right"] | None = None,
        facet: Literal["repeat"] | None = None,
        panel: str | None = None,
        clip: Clip | None = None,
        tooltip: Tooltip | None = None,
        id: str | None = None,
    ) -> Chart:
        """One tick per observation of exactly one number or time column.

        Ticks reach ``length`` CSS pixels into the plot (default 8), from
        bottom/top for ``x`` or left/right for ``y``. Their edges stay fixed
        during zoom and pan. Missing and nonfinite values are omitted.
        """
        if (x is not None) == (y is not None):
            raise ValueError("rug: needs exactly one of x and y")
        sides = ("bottom", "top") if x is not None else ("left", "right")
        if side is not None and side not in sides:
            along = "x" if x is not None else "y"
            raise ValueError(
                f"rug side: expected {listed(sides)} for a rug along {along}; "
                f"received {shown(side)}"
            )
        if y is not None and axis == "right":
            raise ValueError('rug axis: a rug along y has no right axis; drop axis="right"')
        if length is not None and not (_finite(length) and length > 0):
            raise ValueError(
                "rug length: expected a finite, positive number of pixels; "
                f"received {shown(length)}"
            )
        if stroke_width is not None and not (_finite(stroke_width) and stroke_width >= 0):
            raise ValueError(
                "rug stroke_width: expected a finite number of at least 0; "
                f"received {shown(stroke_width)}"
            )
        table = self._mark_table(data)
        self._require(table, x, _NUMERIC, "rug x")
        self._require(table, y, _NUMERIC, "rug y")
        self._require(table, series, ("category",), "rug series")
        return self._add(
            {
                "type": "rug",
                "x": x,
                "y": y,
                "series": series,
                "length": float(length) if length is not None else None,
                "side": side,
                "stroke": stroke,
                "strokeWidth": float(stroke_width) if stroke_width is not None else None,
                "label": label,
                "legendGroup": _legend_group(legend_group, "rug"),
                "legend": _mark_legend(legend, "rug"),
                "axis": axis,
                "facet": _mark_facet(facet, "rug"),
                "panel": panel,
                "clip": _clip(clip, "rug"),
                "tooltip": self._mark_tooltip(table, tooltip, "rug"),
                "id": id,
            },
            table,
        )

    @_check_method_options
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
        dodge: bool = False,
        data: Any = None,
        stroke: str | None = None,
        stroke_width: float | None = None,
        cap: float | None = None,
        label: str | None = None,
        legend_group: str | None = None,
        legend: Literal[False] | None = None,
        axis: Literal["left", "right"] | None = None,
        facet: Literal["repeat"] | None = None,
        panel: str | None = None,
        clip: Clip | None = None,
        tooltip: Tooltip | None = None,
        id: str | None = None,
    ) -> Chart:
        """Error bars at each ``x``, from ``y1`` to ``y2`` or ``y`` ± ``y_error``; or, at each
        ``y``, from ``x1`` to ``x2`` or ``x`` ± ``x_error``.

        ``cap`` is the width of the end caps in pixels (0 for none). Add points or bars
        to show the center. ``dodge=True`` places the series of a ``series``
        column side by side in each category, as grouped bars are, so each
        interval stands on its bar. Marks with the same ``legend_group`` share
        series by name: one color, legend entry, and visibility each.
        """
        vertical = y_error is not None or (y1 is not None and y2 is not None)
        horizontal = x_error is not None or (x1 is not None and x2 is not None)
        if vertical == horizontal:
            raise ValueError(
                "error_bar: needs x with y1 and y2 or with y and y_error (vertical), "
                "or y with x1 and x2 or with x and x_error (horizontal)"
            )
        if horizontal and axis == "right":
            raise ValueError(
                'error_bar axis: horizontal error bars have no right axis; drop axis="right"'
            )
        table = self._mark_table(data)
        along, other = ("y", "x") if horizontal else ("x", "y")
        position = y if horizontal else x
        if position is None:
            raise ValueError(f"error_bar {along}: needs the column the bars stand at")
        self._require(table, position, ("number", "time", "category"), f"error_bar {along}")
        error = x_error if horizontal else y_error
        if error is not None:
            center = x if horizontal else y
            if center is None:
                raise ValueError(
                    f"error_bar {other}: {other}_error is measured from {other}; give {other}"
                )
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
            raise ValueError(
                f"error_bar {extra}: bars from {', '.join(used)} take no {extra}; drop {extra}"
            )
        self._require(table, series, ("category",), "error_bar series")
        if dodge:
            if series is None:
                raise ValueError("error_bar dodge: places series side by side; give series")
            if self._kind(table, position) != "category":
                raise ValueError(
                    f"error_bar dodge: needs a category {along}; "
                    f"column {position!r} holds {self._kind(table, position)} values"
                )
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
                "dodge": dodge or None,
                "stroke": stroke,
                "strokeWidth": stroke_width,
                "cap": cap,
                "label": label,
                "legendGroup": _legend_group(legend_group, "error_bar"),
                "legend": _mark_legend(legend, "error_bar"),
                "axis": axis,
                "facet": _mark_facet(facet, "error_bar"),
                "panel": panel,
                "clip": _clip(clip, "error_bar"),
                "tooltip": self._mark_tooltip(table, tooltip, "error_bar"),
                "id": id,
            },
            table,
        )

    @_check_method_options
    def point(
        self,
        x: str,
        y: str,
        *,
        series: str | None = None,
        animation_key: str | None = None,
        data: Any = None,
        radius: float | None = None,
        size: str | None = None,
        radius_range: tuple[float, float] | None = None,
        fill: str | None = None,
        fill_opacity: float | str | None = None,
        stroke: str | None = None,
        stroke_width: float | None = None,
        color: str | None = None,
        colors: str | Sequence[str] | None = None,
        color_domain: tuple[float, float] | None = None,
        color_midpoint: float | None = None,
        symbol: str | Mapping[str, str] | None = None,
        sampling: Literal["none", "pixel"] | None = None,
        dodge: bool = False,
        jitter: float | Jitter | None = None,
        swarm: bool = False,
        label: str | None = None,
        legend_group: str | None = None,
        legend: Literal[False] | None = None,
        axis: Literal["left", "right"] | None = None,
        facet: Literal["repeat"] | None = None,
        panel: str | None = None,
        clip: Clip | None = None,
        tooltip: Tooltip | None = None,
        id: str | None = None,
    ) -> Chart:
        """Scatter points.

        ``x`` and ``y`` are numeric, datetime, or category columns; a category
        column places points in its bands, as for strip and dot plots.
        ``radius`` is the radius in pixels of every point; ``size`` instead
        sizes points by area by a numeric column, within ``radius_range``
        (bubbles). ``fill_opacity`` is a number or a numeric
        column. ``stroke`` and ``stroke_width`` ring each point, in the
        background color by default. ``color`` colors points by a numeric
        column on ``colors``, a scheme name such as ``"viridis"`` or a list of
        hex colors, centered on ``color_midpoint`` for diverging schemes; or
        by a category column, whose values take the chart's ``"color"`` scale
        (``scales={"color": hg.Scale(type="ordinal", map=...)}`` fixes them;
        otherwise the theme's palette in the column's order), with a key in
        the legend (naming the ``series`` column colors the series so). ``symbol`` is a shape
        (``"circle"``, ``"square"``, ``"triangle"``, ...) or a category column
        with a shape per value: its name, or ``{"field": name}``, which a
        column named like a shape needs. ``sampling="pixel"`` draws opaque
        points whose centers share a device pixel once, which is faster for
        dense scatters.
        ``animation_key`` names a numeric, datetime, or category column matching
        points across live replacements when ``Animation(values=True)`` is set.

        With a category ``x`` or ``y``, ``dodge=True`` places the series of a
        ``series`` column side by side in each category, as grouped bars are,
        and ``jitter`` (a width from 0 to 1 of the band, or ``hg.Jitter``)
        spreads points across their band, by row and seed; ``swarm=True``
        instead packs them across it without overlap, in order of their
        values (a beeswarm), laid out again as the chart resizes and zooms,
        with points that do not fit at the band's edges. Marks with the same
        ``legend_group`` share series by name: one color, legend entry, and
        visibility each.
        """
        table = self._mark_table(data)
        self._require(table, x, (*_NUMERIC, "category"), "point x")
        self._require(table, y, (*_NUMERIC, "category"), "point y")
        self._require(table, series, ("category",), "point series")
        self._require(table, animation_key, (*_NUMERIC, "category"), "point animation_key")
        _check_size(radius, size, "point")
        self._require(table, size, _NUMERIC, "point size")
        if isinstance(fill_opacity, str):
            self._require(table, fill_opacity, _NUMERIC, "point fill_opacity")
        elif fill_opacity is not None and not 0 <= fill_opacity <= 1:
            raise ValueError(
                "point fill_opacity: expected a number from 0 to 1 or a column; "
                f"received {shown(fill_opacity)}"
            )
        if stroke_width is not None and not (_finite(stroke_width) and stroke_width >= 0):
            raise ValueError(
                f"point stroke_width: expected 0 or more pixels; received {shown(stroke_width)}"
            )
        self._require(table, color, (*_NUMERIC, "category"), "point color")
        self._check_category_color(table, color, colors, color_domain, color_midpoint, "point")
        symbol_spec = self._symbol(table, symbol)
        spread = (
            Jitter(width=jitter)
            if isinstance(jitter, numbers.Real) and not isinstance(jitter, bool)
            else jitter
        )
        if spread is not None and not isinstance(spread, Jitter):
            raise ValueError(
                "point jitter: expected a width from 0 to 1 or an hg.Jitter; "
                f"received {shown(jitter)}"
            )
        if not isinstance(swarm, bool):
            raise TypeError(f"point swarm: expected True or False; received {shown(swarm)}")
        if swarm and spread is not None:
            raise ValueError("point swarm: places points itself; drop jitter or swarm")
        if swarm and sampling == "pixel":
            raise ValueError('point sampling: a swarm places every point; drop sampling="pixel"')
        if dodge or spread is not None or swarm:
            option = "dodge" if dodge else "jitter" if spread is not None else "swarm"
            if (self._kind(table, x) == "category") == (self._kind(table, y) == "category"):
                raise ValueError(f"point {option}: needs exactly one category column, x or y")
            if dodge and series is None:
                raise ValueError("point dodge: places series side by side; give series")
        return self._add(
            {
                "type": "point",
                "x": x,
                "y": y,
                "series": series,
                "animationKey": animation_key,
                "radius": radius,
                "size": size,
                "radiusRange": _range(radius_range, "point radius_range", minimum=0),
                "fill": fill,
                "fillOpacity": fill_opacity,
                "stroke": stroke,
                "strokeWidth": stroke_width,
                "color": color,
                "colors": _colors(colors, "point colors"),
                "colorDomain": _range(color_domain, "point color_domain"),
                "colorMidpoint": _midpoint(color_midpoint, color_domain, "point"),
                "symbol": symbol_spec,
                "sampling": sampling,
                "dodge": dodge or None,
                "jitter": spread._spec() if spread is not None else None,
                "swarm": swarm or None,
                "label": label,
                "legendGroup": _legend_group(legend_group, "point"),
                "legend": _mark_legend(legend, "point"),
                "axis": axis,
                "facet": _mark_facet(facet, "point"),
                "panel": panel,
                "clip": _clip(clip, "point"),
                "tooltip": self._mark_tooltip(table, tooltip, "point"),
                "id": id,
            },
            table,
        )

    @_check_method_options
    def histogram(
        self,
        x: str | None = None,
        *,
        y: str | None = None,
        bins: BinSpec | Mapping[str, BinSpec] | None = None,
        series: str | None = None,
        weight: str | None = None,
        normalize: HistogramNormalize | None = None,
        common_norm: bool = False,
        cumulative: bool = False,
        dodge: bool = False,
        stack: bool | Literal["fill"] = False,
        element: HistogramElement | None = None,
        data: Any = None,
        fill: str | None = None,
        fill_opacity: float | None = None,
        colors: str | Sequence[str] | None = None,
        color_domain: tuple[float, float] | None = None,
        color_midpoint: float | None = None,
        label: str | None = None,
        legend_group: str | None = None,
        legend: Literal[False] | None = None,
        axis: Literal["left", "right"] | None = None,
        facet: Literal["repeat"] | None = None,
        panel: str | None = None,
        clip: Clip | None = None,
        id: str | None = None,
    ) -> Chart:
        """Counts of a number or time field in bins: of ``x`` (vertical bars) or
        of ``y`` (horizontal bars), or of both, a 2D histogram's cells.

        Bins are an approximate count, a step/start dict, or exact increasing
        edges; a 2D histogram takes those for both axes, or a dict of them
        for each, ``{"x": ..., "y": ...}``. Each row counts as 1, or as its
        ``weight`` (a number column; rows missing a weight, or with a
        negative one, are not counted). ``normalize`` measures each series'
        bins: counts, ``"frequency"`` (counts per unit of the binned axis,
        or of bin area in 2D), or ``"probability"``, ``"percent"``, and
        ``"density"`` of its counts; common_norm weights its share of finite
        values in the panel (including hidden series and values outside
        bins). Cumulative density integrates widths. Stack stacks series,
        and ``stack="fill"`` as shares of each bin; dodge places visible
        series side by side and excludes stack. ``element="step"`` draws
        each series as an area stepping across its bins, and ``"poly"`` as
        one through their centers.

        A 2D histogram counts the rows whose ``x`` and ``y`` both fall in a
        bin of each, colored by ``colors`` (a scheme name or hex colors)
        from 0 to the fullest cell, or over ``color_domain``; cells holding
        nothing are left empty. It takes no series (facet instead), stacks,
        dodges, cumulative counts, or elements.
        """
        if x is None and y is None:
            raise ValueError("histogram: needs x, y, or both")
        if normalize not in (None, "count", "frequency", "probability", "percent", "density"):
            raise ValueError(
                'histogram normalize: expected "count", "frequency", "probability", "percent", '
                f'or "density"; received {shown(normalize)}'
            )
        table = self._mark_table(data)
        self._require(table, weight, ("number",), "histogram weight")
        if x is not None and y is not None:
            bars = {
                "series": series,
                "common_norm": common_norm or None,
                "cumulative": cumulative or None,
                "dodge": dodge or None,
                "stack": stack or None,
                "element": element,
                "fill": fill,
                "fill_opacity": fill_opacity,
                "legend_group": legend_group,
            }
            given = next((name for name, value in bars.items() if value is not None), None)
            if given == "series":
                raise ValueError(
                    "histogram series: a 2D histogram of x and y counts one distribution; "
                    "facet by the column instead"
                )
            if given is not None:
                raise ValueError(
                    f"histogram {given}: for bars of x or y; a 2D histogram of both takes none, "
                    "so drop it"
                )
            if axis == "right":
                raise ValueError(
                    "histogram axis: a 2D histogram places cells, on no right axis; "
                    'drop axis="right"'
                )
            self._require(table, x, _NUMERIC, "histogram x")
            self._require(table, y, _NUMERIC, "histogram y")
            return self._add(
                {
                    "type": "histogram",
                    "x": x,
                    "y": y,
                    "bins": _bins_2d(bins),
                    "weight": weight,
                    "normalize": normalize,
                    "colors": _colors(colors, "histogram colors"),
                    "colorDomain": _range(color_domain, "histogram color_domain"),
                    "colorMidpoint": _midpoint(color_midpoint, color_domain, "histogram"),
                    "label": label,
                    "legend": _mark_legend(legend, "histogram"),
                    "facet": _mark_facet(facet, "histogram"),
                    "panel": panel,
                    "clip": _clip(clip, "histogram"),
                    "id": id,
                },
                table,
            )
        cells = next(
            (
                name
                for name, value in (
                    ("colors", colors),
                    ("color_domain", color_domain),
                    ("color_midpoint", color_midpoint),
                )
                if value is not None
            ),
            None,
        )
        if cells is not None:
            raise ValueError(
                f"histogram {cells}: colors the cells of 2D histograms of x and y; bars take fill"
            )
        if y is not None and axis == "right":
            raise ValueError(
                'histogram axis: a horizontal histogram (y) has no right axis; drop axis="right"'
            )
        for name, flag in (
            ("common_norm", common_norm),
            ("cumulative", cumulative),
            ("dodge", dodge),
        ):
            if not isinstance(flag, bool):
                raise ValueError(
                    f"histogram {name}: expected True or False; received {shown(flag)}"
                )
        if not isinstance(stack, bool) and stack != "fill":
            raise ValueError(
                f'histogram stack: expected True, False, or "fill"; received {shown(stack)}'
            )
        if dodge and stack:
            raise ValueError("histogram dodge: dodge or stack, not both; drop one")
        if element not in (None, "bars", "step", "poly"):
            raise ValueError(
                f'histogram element: expected "bars", "step", or "poly"; received {shown(element)}'
            )
        if dodge and element not in (None, "bars"):
            raise ValueError(
                "histogram dodge: places bars side by side in each bin; drop dodge, or draw "
                'element="bars"'
            )
        if isinstance(bins, Mapping) and ("x" in bins or "y" in bins):
            raise ValueError(
                'histogram bins: {"x": ..., "y": ...} bins both axes of a 2D histogram; '
                f"give one bin definition for {'x' if x is not None else 'y'}"
            )
        spec_bins = None if bins is None else bin_spec(bins, "histogram bins")
        self._require(
            table,
            y if y is not None else x,
            _NUMERIC,
            "histogram y" if y is not None else "histogram x",
        )
        self._require(table, series, ("category",), "histogram series")
        return self._add(
            {
                "type": "histogram",
                "x": x,
                "y": y,
                "bins": spec_bins,
                "series": series,
                "weight": weight,
                "normalize": normalize,
                "commonNorm": common_norm or None,
                "cumulative": cumulative or None,
                "dodge": dodge or None,
                "stack": stack or None,
                "element": element,
                "fill": fill,
                "fillOpacity": fill_opacity,
                "label": label,
                "legendGroup": _legend_group(legend_group, "histogram"),
                "legend": _mark_legend(legend, "histogram"),
                "axis": axis,
                "facet": _mark_facet(facet, "histogram"),
                "panel": panel,
                "clip": _clip(clip, "histogram"),
                "id": id,
            },
            table,
        )

    @_check_method_options
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
        legend_group: str | None = None,
        legend: Literal[False] | None = None,
        axis: Literal["left", "right"] | None = None,
        facet: Literal["repeat"] | None = None,
        panel: str | None = None,
        clip: Clip | None = None,
        tooltip: Tooltip | None = None,
        id: str | None = None,
    ) -> Chart:
        """Open-high-low-close candles at each ``x``, as for prices.

        Candles closing at or above their open are hollow in the ``rise``
        color, others filled in ``fall``; both default to the theme's.
        ``variant="ohlc"`` draws bars instead: a line from low to high with
        the open ticked to its left and the close to its right.
        """
        if variant not in (None, "candlestick", "ohlc"):
            raise ValueError(
                f'candlestick variant: expected "candlestick" or "ohlc"; received {shown(variant)}'
            )
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
                "legendGroup": _legend_group(legend_group, "candlestick"),
                "legend": _mark_legend(legend, "candlestick"),
                "axis": axis,
                "facet": _mark_facet(facet, "candlestick"),
                "panel": panel,
                "clip": _clip(clip, "candlestick"),
                "tooltip": self._mark_tooltip(table, tooltip, "candlestick"),
                "id": id,
            },
            table,
        )

    @_check_method_options
    def pie(
        self,
        category: str,
        value: str | None = None,
        *,
        data: Any = None,
        inner_radius: float | None = None,
        sort: Literal["value", "input"] | None = None,
        labels: bool | None = None,
        panel: str | None = None,
        id: str | None = None,
    ) -> Chart:
        """A pie: a slice per value of ``category``, sized by the sum of
        ``value`` over its rows, or their count without it.

        ``inner_radius``, a fraction of the pie's radius below 1, makes a
        donut. Slices go largest first, clockwise from the top, unless
        ``sort="input"``. A pie has its chart to itself; with facets, each
        panel, a pie of the panel's rows; with panels, the one ``panel`` names.
        """
        self._layout_place("pie")
        if inner_radius is not None and not (
            isinstance(inner_radius, numbers.Real)
            and not isinstance(inner_radius, bool)
            and 0 <= inner_radius < 1
        ):
            raise ValueError(
                "pie inner_radius: expected a fraction of at least 0 and below 1; "
                f"received {shown(inner_radius)}"
            )
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
                "panel": panel,
                "id": id,
            },
            table,
        )

    @_check_method_options
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
        panel: str | None = None,
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
        itself; with facets, each panel, the last value of the panel's rows;
        with panels, the one ``panel`` names.
        """
        self._layout_place("gauge")
        _check_format(format, "gauge format", _NUMBER_FORMAT)
        table = self._mark_table(data)
        self._require(table, value, ("number",), "gauge value")
        low = 0.0 if min is None else min
        high = 100.0 if max is None else max
        if not (_finite(low) and _finite(high) and low < high):
            raise ValueError(
                "gauge min: expected a finite min below a finite max; "
                f"received {low!r} and {high!r}"
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
                "panel": panel,
                "id": id,
            },
            table,
        )

    @_check_method_options
    def funnel(
        self,
        category: str,
        value: str | None = None,
        *,
        data: Any = None,
        sort: Literal["input", "value"] | None = None,
        labels: bool | None = None,
        panel: str | None = None,
        halo: HaloOption | None = None,
        id: str | None = None,
    ) -> Chart:
        """A funnel: a centered bar per value of ``category``, top to bottom,
        as wide as the sum of ``value`` over its rows (or their count) is to
        the largest stage's. Missing, negative, and infinite values count as
        nothing.

        Stages keep the column's order unless ``sort="value"`` puts the
        largest first. ``labels=False`` leaves out the stage names and the
        values with their share of the first stage. A funnel has its chart to
        itself; with facets, each panel, a funnel of the panel's rows; with
        panels, the one ``panel`` names.
        """
        self._layout_place("funnel")
        table = self._mark_table(data)
        self._require(table, category, ("category",), "funnel category")
        self._require(table, value, ("number",), "funnel value")
        return self._add(
            {
                "type": "funnel",
                "halo": _halo(halo, "funnel"),
                "category": category,
                "value": value,
                "sort": sort,
                "labels": labels,
                "panel": panel,
                "id": id,
            },
            table,
        )

    @_check_method_options
    def boxplot(
        self,
        x: str | None = None,
        y: str | None = None,
        *,
        data: Any = None,
        low: str | None = None,
        q1: str | None = None,
        median: str | None = None,
        q3: str | None = None,
        high: str | None = None,
        count: str | None = None,
        whiskers: Literal["tukey", "range"] | float | None = None,
        notch: bool | None = None,
        outliers: bool | None = None,
        series: str | None = None,
        fill: str | None = None,
        fill_opacity: float | None = None,
        label: str | None = None,
        legend_group: str | None = None,
        legend: Literal[False] | None = None,
        axis: Literal["left", "right"] | None = None,
        facet: Literal["repeat"] | None = None,
        panel: str | None = None,
        clip: Clip | None = None,
        id: str | None = None,
    ) -> Chart:
        """Box plots of a number column's values per category.

        One of ``x`` and ``y`` is a category column, the other the values:
        a category ``y`` lays the boxes along the y axis. Boxes span the
        quartiles with a line at the median; whiskers reach the most extreme
        values within 1.5 interquartile ranges, and values beyond are dots.
        ``series`` puts a box per value of a category column side by side.
        ``fill`` gives every box one color instead of the palette's.
        Instead of raw values, name ``low``, ``q1``, ``median``, ``q3``, and
        ``high`` columns with just a category ``x`` or ``y``: one box per row,
        no outliers. ``count`` is optional unless ``notch=True``. Notches
        extend 1.57 IQR / sqrt(count) from the median, without clamping.
        Raw ``whiskers`` are "tukey" (default), "range", or a nonnegative
        IQR multiple; precomputed boxes already give their whisker ends.
        ``outliers=False`` draws no dots beyond the whiskers (tooltips still
        count them), and leaves them out of the value axis' extent.
        """
        statistics = {"low": low, "q1": q1, "median": median, "q3": q3, "high": high}
        precomputed = any(value is not None for value in statistics.values()) or count is not None
        if precomputed:
            if x is not None and y is not None:
                raise ValueError(
                    "boxplot: raw x and y values or precomputed statistics "
                    "(low, q1, median, q3, high, count), not both; drop one"
                )
            if x is None and y is None:
                raise ValueError("boxplot: precomputed boxes need a category x or y")
            missing = [name for name, value in statistics.items() if value is None]
            if missing:
                raise ValueError(
                    f"boxplot {missing[0]}: precomputed boxes need low, q1, median, q3, and high; "
                    f"give {', '.join(missing)}"
                )
            if whiskers is not None:
                raise ValueError(
                    "boxplot whiskers: low and high already give precomputed boxes their "
                    "whisker ends; drop whiskers"
                )
            if notch and count is None:
                raise ValueError("boxplot notch: precomputed boxes need count to notch; give count")
            if outliers is not None:
                raise ValueError(
                    "boxplot outliers: precomputed boxes have none to draw; drop outliers"
                )
        elif x is None or y is None:
            raise ValueError(f"boxplot {'x' if x is None else 'y'}: raw values need both x and y")
        if (
            whiskers is not None
            and whiskers not in ("tukey", "range")
            and not (
                isinstance(whiskers, numbers.Real)
                and not isinstance(whiskers, bool)
                and math.isfinite(whiskers)
                and whiskers >= 0
            )
        ):
            raise ValueError(
                'boxplot whiskers: expected "tukey", "range", or a finite nonnegative IQR '
                f"multiple; received {shown(whiskers)}"
            )
        if isinstance(whiskers, numbers.Real):
            whiskers = float(whiskers)
        if notch is not None and not isinstance(notch, bool):
            raise TypeError(f"boxplot notch: expected True or False; received {shown(notch)}")
        if outliers is not None and not isinstance(outliers, bool):
            raise TypeError(f"boxplot outliers: expected True or False; received {shown(outliers)}")
        return self._distribution(
            {
                "type": "boxplot",
                "fill": fill,
                **statistics,
                "count": count,
                "whiskers": whiskers,
                "notch": notch,
                "outliers": outliers,
                "legendGroup": _legend_group(legend_group, "boxplot"),
                "legend": _mark_legend(legend, "boxplot"),
                "clip": _clip(clip, "boxplot"),
            },
            x,
            y,
            data,
            series,
            fill_opacity,
            label,
            axis,
            facet,
            panel,
            id,
        )

    @_check_method_options
    def boxen(
        self,
        x: str,
        y: str,
        *,
        data: Any = None,
        series: str | None = None,
        depth: Literal["tukey", "proportion", "trustworthy", "full"] | int | None = None,
        outlier_proportion: float | None = None,
        trust_alpha: float | None = None,
        width_method: Literal["exponential", "linear", "area"] | None = None,
        outliers: bool | None = None,
        fill: str | None = None,
        fill_opacity: float | None = None,
        label: str | None = None,
        legend_group: str | None = None,
        legend: Literal[False] | None = None,
        axis: Literal["left", "right"] | None = None,
        facet: Literal["repeat"] | None = None,
        panel: str | None = None,
        clip: Clip | None = None,
        id: str | None = None,
    ) -> Chart:
        """Letter-value ("boxen") plots of a number column's values per category.

        One of ``x`` and ``y`` is a category column, the other the values:
        a category ``y`` lays the boxes along the y axis. Each group draws
        nested boxes between its letter values, its quartiles, eighths,
        sixteenths, ... out from the median, each level narrower and lighter
        than the one inside it, and dots at the values beyond the outermost
        boxes unless ``outliers=False``. ``depth`` chooses the levels:
        "tukey" (the default) leaves 5 to 8 values in each tail,
        "proportion" about ``outlier_proportion`` (0.007) of them,
        "trustworthy" stops where a letter value's confidence interval at
        ``trust_alpha`` (0.05) would overlap the next, "full" reaches every
        value, or a whole number gives the levels (1 is the quartile box).
        ``width_method`` narrows each level by half ("exponential", the
        default), by equal steps ("linear"), or to its share of the values
        over its height ("area"). ``series`` puts a group per value of a
        category column side by side; ``fill`` gives every box one color.
        """
        if depth is not None and depth not in ("tukey", "proportion", "trustworthy", "full"):
            if not (
                isinstance(depth, numbers.Integral) and not isinstance(depth, bool) and depth >= 1
            ):
                raise ValueError(
                    'boxen depth: expected "tukey", "proportion", "trustworthy", "full", or a '
                    f"whole number of levels from 1; received {shown(depth)}"
                )
            depth = int(depth)
        for name, value in (
            ("outlier_proportion", outlier_proportion),
            ("trust_alpha", trust_alpha),
        ):
            if value is not None and not (
                isinstance(value, numbers.Real) and not isinstance(value, bool) and 0 < value < 1
            ):
                raise ValueError(
                    f"boxen {name}: expected a number between 0 and 1; received {shown(value)}"
                )
        if width_method is not None and width_method not in ("exponential", "linear", "area"):
            raise ValueError(
                'boxen width_method: expected "exponential", "linear", or "area"; '
                f"received {shown(width_method)}"
            )
        if outliers is not None and not isinstance(outliers, bool):
            raise TypeError(f"boxen outliers: expected True or False; received {shown(outliers)}")
        return self._distribution(
            {
                "type": "boxen",
                "fill": fill,
                "depth": depth,
                "outlierProportion": outlier_proportion,
                "trustAlpha": trust_alpha,
                "widthMethod": width_method,
                "outliers": outliers,
                "legendGroup": _legend_group(legend_group, "boxen"),
                "legend": _mark_legend(legend, "boxen"),
                "clip": _clip(clip, "boxen"),
            },
            x,
            y,
            data,
            series,
            fill_opacity,
            label,
            axis,
            facet,
            panel,
            id,
        )

    @_check_method_options
    def violin(
        self,
        x: str,
        y: str,
        *,
        data: Any = None,
        series: str | None = None,
        bandwidth: float | None = None,
        split: bool | None = None,
        inner: Literal["box", "quartiles", "none"] | None = None,
        fill: str | None = None,
        fill_opacity: float | None = None,
        label: str | None = None,
        legend_group: str | None = None,
        legend: Literal[False] | None = None,
        axis: Literal["left", "right"] | None = None,
        facet: Literal["repeat"] | None = None,
        panel: str | None = None,
        clip: Clip | None = None,
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
        color instead of the palette's. ``split=True`` shares the category
        center between two series (first left, or below horizontally); a
        missing partner leaves its half empty. ``inner`` selects the default
        "box", dashed "quartiles" with a solid median, or "none".
        """
        if bandwidth is not None and not (
            isinstance(bandwidth, numbers.Real)
            and not isinstance(bandwidth, bool)
            and math.isfinite(bandwidth)
            and bandwidth > 0
        ):
            raise ValueError(
                f"violin bandwidth: expected a positive number; received {shown(bandwidth)}"
            )
        if split is not None and not isinstance(split, bool):
            raise TypeError(f"violin split: expected True or False; received {shown(split)}")
        if split and series is None:
            raise ValueError("violin split: halves each category between two series; give series")
        if inner is not None and inner not in ("box", "quartiles", "none"):
            raise ValueError(
                f'violin inner: expected "box", "quartiles", or "none"; received {shown(inner)}'
            )
        return self._distribution(
            {
                "type": "violin",
                "bandwidth": bandwidth,
                "fill": fill,
                "split": split,
                "inner": inner,
                "legendGroup": _legend_group(legend_group, "violin"),
                "legend": _mark_legend(legend, "violin"),
                "clip": _clip(clip, "violin"),
            },
            x,
            y,
            data,
            series,
            fill_opacity,
            label,
            axis,
            facet,
            panel,
            id,
        )

    def _distribution(
        self,
        spec: dict[str, Any],
        x: str | None,
        y: str | None,
        data: Any,
        series: str | None,
        fill_opacity: float | None,
        label: str | None,
        axis: Literal["left", "right"] | None,
        facet: Literal["repeat"] | None,
        panel: str | None,
        id: str | None,
    ) -> Chart:
        """Adds a box plot, boxen, or violin mark: a category column on one
        axis, values on the other."""
        kind = spec["type"]
        table = self._mark_table(data)
        precomputed = spec.get("median") is not None
        if precomputed:
            horizontal = x is None
        else:
            assert x is not None and y is not None
            horizontal = self._kind(table, y) == "category" and self._kind(table, x) != "category"
        category, values = (y, x) if horizontal else (x, y)
        self._require(table, category, ("category",), f"{kind} {'y' if horizontal else 'x'}")
        if precomputed:
            for name in ("low", "q1", "median", "q3", "high"):
                self._require(table, spec[name], _NUMERIC, f"boxplot {name}")
            self._require(table, spec.get("count"), ("number",), "boxplot count")
        else:
            self._require(table, values, _NUMERIC, f"{kind} {'x' if horizontal else 'y'}")
        self._require(table, series, ("category",), f"{kind} series")
        if horizontal and axis == "right":
            noun = {"boxplot": "box plots", "boxen": "boxen plots", "violin": "violins"}[kind]
            raise ValueError(
                f'{kind} axis: horizontal {noun} have no right axis; drop axis="right"'
            )
        if fill_opacity is not None and not (
            isinstance(fill_opacity, numbers.Real)
            and not isinstance(fill_opacity, bool)
            and 0 <= fill_opacity <= 1
        ):
            raise ValueError(
                f"{kind} fill_opacity: expected a number from 0 to 1; "
                f"received {shown(fill_opacity)}"
            )
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
                "facet": _mark_facet(facet, kind),
                "panel": panel,
                "id": id,
            },
            table,
        )

    @_check_method_options
    def treemap(
        self,
        path: Sequence[str] | None = None,
        value: str | None = None,
        *,
        node: str | None = None,
        parent: str | None = None,
        data: Any = None,
        labels: bool | None = None,
        panel: str | None = None,
        id: str | None = None,
    ) -> Chart:
        """A treemap: nested rectangles for a tree, each leaf's area its share
        of the sum of ``value`` (or of the rows).

        The tree is ``path``, category columns from the outermost group in, or
        ``node`` and ``parent`` columns naming each row's node and its parent.
        Leaves take their top-level group's color; the legend toggles groups.
        A treemap has its chart to itself; with facets, each panel, a treemap
        of the panel's rows; with panels, the one ``panel`` names.
        """
        return self._tree("treemap", path, value, node, parent, data, labels, panel, id)

    @_check_method_options
    def sunburst(
        self,
        path: Sequence[str] | None = None,
        value: str | None = None,
        *,
        node: str | None = None,
        parent: str | None = None,
        data: Any = None,
        labels: bool | None = None,
        panel: str | None = None,
        id: str | None = None,
    ) -> Chart:
        """A sunburst: a tree as rings around a center, each node's angle its
        share of its parent's; the tree, and where it is drawn, as for
        ``treemap``."""
        return self._tree("sunburst", path, value, node, parent, data, labels, panel, id)

    def _tree(
        self,
        kind: str,
        path: Sequence[str] | None,
        value: str | None,
        node: str | None,
        parent: str | None,
        data: Any,
        labels: bool | None,
        panel: str | None,
        id: str | None,
    ) -> Chart:
        self._layout_place(kind)
        table = self._mark_table(data)
        if path is not None and (node is not None or parent is not None):
            raise ValueError(f"{kind} path: a path, or node and parent, not both; drop one")
        if path is not None:
            if isinstance(path, str) or len(path) == 0:
                raise ValueError(
                    f"{kind} path: expected a list of at least one column; received {shown(path)}"
                )
            for name in path:
                self._require(table, name, ("category",), f"{kind} path")
        elif node is not None and parent is not None:
            self._require(table, node, ("category",), f"{kind} node")
            self._require(table, parent, ("category",), f"{kind} parent")
        else:
            raise ValueError(f"{kind}: needs a path of category columns, or node and parent")
        self._require(table, value, ("number",), f"{kind} value")
        return self._add(
            {
                "type": kind,
                "path": list(path) if path is not None else None,
                "node": node,
                "parent": parent,
                "value": value,
                "labels": labels,
                "panel": panel,
                "id": id,
            },
            table,
        )

    @_check_method_options
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
        panel: str | None = None,
        halo: HaloOption | None = None,
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
        its chart to itself; with facets, each panel, the values of the
        panel's rows on the table's spokes, each panel scaled to its own
        values unless ``domain`` is given; with panels, the one ``panel`` names.
        """
        self._layout_place("radar")
        table = self._mark_table(data)
        long = category is not None or value is not None
        if long == (fields is not None) or (long and (category is None or value is None)):
            raise ValueError(
                "radar: needs category and value columns (a spoke per category) "
                "or fields (a spoke per column), not both"
            )
        if fields is not None:
            if isinstance(fields, str):
                raise ValueError(
                    f"radar fields: expected a list of columns; received {shown(fields)}"
                )
            for name in fields:
                self._require(table, name, ("number",), "radar fields")
            repeated = next((name for i, name in enumerate(fields) if name in fields[:i]), None)
            if repeated is not None:
                raise ValueError(
                    f"radar fields: {repeated!r} is listed twice; list each column once"
                )
            _check_spokes(len(fields), "fields", "the fields make")
        else:
            self._require(table, category, ("category",), "radar category")
            self._require(table, value, ("number",), "radar value")
            assert category is not None
            codes = self._tables[table][1].column(category).values
            # Derived tables have no rows here; their spokes are checked when drawn.
            spokes = len(np.unique(codes[codes >= 0]))
            if spokes > 0:
                _check_spokes(spokes, "category", f"{category!r} has")
        self._require(table, series, ("category",), "radar series")
        if fill_opacity is not None and not (
            isinstance(fill_opacity, numbers.Real)
            and not isinstance(fill_opacity, bool)
            and 0 <= fill_opacity <= 1
        ):
            raise ValueError(
                f"radar fill_opacity: expected a number from 0 to 1; received {shown(fill_opacity)}"
            )
        return self._add(
            {
                "type": "radar",
                "halo": _halo(halo, "radar"),
                "category": category,
                "value": value,
                "fields": list(fields) if fields is not None else None,
                "series": series,
                "domain": _range(domain, "radar domain"),
                "fillOpacity": fill_opacity,
                "points": points,
                "label": label,
                "panel": panel,
                "id": id,
            },
            table,
        )

    @_check_method_options
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
        panel: str | None = None,
        halo: HaloOption | None = None,
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
        is in pixels. A Sankey diagram has its chart to itself; with facets,
        each panel, the flows of the panel's rows; with panels, the one
        ``panel`` names.
        """
        self._layout_place("sankey")
        if node_width is not None and not (
            isinstance(node_width, numbers.Real)
            and not isinstance(node_width, bool)
            and 0 < node_width < math.inf
        ):
            raise ValueError(
                "sankey node_width: expected a positive number of pixels; "
                f"received {shown(node_width)}"
            )
        if sort not in (None, "input", "value"):
            raise ValueError(f'sankey sort: expected "input" or "value"; received {shown(sort)}')
        table = self._mark_table(data)
        self._require(table, source, ("category",), "sankey source")
        self._require(table, target, ("category",), "sankey target")
        self._require(table, value, ("number",), "sankey value")
        return self._add(
            {
                "type": "sankey",
                "halo": _halo(halo, "sankey"),
                "source": source,
                "target": target,
                "value": value,
                "labels": labels,
                "nodeWidth": node_width,
                "sort": sort,
                "panel": panel,
                "id": id,
            },
            table,
        )

    @_check_method_options
    def graph(
        self,
        source: str,
        target: str,
        value: str | None = None,
        *,
        nodes: Any = None,
        node: str | None = None,
        color: str | None = None,
        size: str | None = None,
        data: Any = None,
        labels: bool | None = None,
        directed: bool | None = None,
        link_label_field: str | None = None,
        layout: Literal["force", "circular", "layered"] | Mapping[str, Any] | None = None,
        panel: str | None = None,
        halo: HaloOption | None = None,
        id: str | None = None,
    ) -> Chart:
        """A network: a row per link between the nodes named in ``source`` and
        ``target``, links as wide as the sum of ``value`` over their rows when
        given.

        ``layout`` places the nodes: ``"force"`` (the default), a force
        simulation whose nodes near a moved node settle around it
        (``{"type": "force", "settle": False}`` moves only the node);
        ``"circular"``, one circle by group, then by ``"sort"``: ``"degree"``
        (the default), ``"input"``, or ``"name"``; or ``"layered"``, layers
        in the links' direction, from source to target, for trees and
        directed acyclic networks, with ``"direction"`` ``"down"`` (the
        default), ``"right"``, ``"up"``, or ``"left"``. Nodes that remain
        keep their places as the data changes.

        Links have no direction (rows either way between two nodes are one
        link) unless ``directed``, which draws them from source to target
        with arrowheads, a pair's links each way bowed apart. Rows without a
        positive value and links from a node to itself are left out.
        ``link_label_field`` names a category column written along the links
        with room (none where a link's rows name it differently). ``nodes`` is
        a second data source with a row per node, named in its ``node``
        column, which adds nodes without links and colors nodes by the
        category column ``color`` (with a legend) or sizes them by ``size``;
        nodes only links name have no color of their own. A network draws at
        most 50,000 nodes and 200,000 links. It has its chart to itself, each
        facet panel (drawing the panel's links, and the nodes they join, where
        one layout of the whole network puts them), or the panel ``panel``
        names; ``Chart(drag=True)`` lets its nodes be dragged.
        """
        self._layout_place("graph")
        table = self._mark_table(data)
        self._require(table, source, ("category",), "graph source")
        self._require(table, target, ("category",), "graph target")
        self._require(table, value, ("number",), "graph value")
        self._require(table, link_label_field, ("category",), "graph link_label_field")
        layout_spec = _graph_layout(layout)
        node_table = None
        if nodes is not None:
            if node is None:
                raise ValueError(
                    "graph node: a nodes table needs node, the column naming each row's node"
                )
            node_table = self._table(nodes)
            self._require(node_table, node, ("category",), "graph node")
            self._require(node_table, color, ("category",), "graph color")
            self._require(node_table, size, ("number",), "graph size")
        elif node is not None or color is not None or size is not None:
            given = "node" if node is not None else "color" if color is not None else "size"
            raise ValueError(
                f"graph {given}: node, color, and size are columns of a nodes table; give nodes"
            )
        nodes_count, links_count = self._network_size(
            table, source, target, value, node_table, node, directed=directed is True
        )
        if nodes_count > MAX_NODES or links_count > MAX_LINKS:
            raise ValueError(
                f"graph: draws at most {MAX_NODES:,} nodes and {MAX_LINKS:,} links; "
                f"this network has {nodes_count:,} nodes and {links_count:,} links"
            )
        self._add(
            {
                "type": "graph",
                "halo": _halo(halo, "graph"),
                "source": source,
                "target": target,
                "value": value,
                "node": node,
                "color": color,
                "size": size,
                "labels": labels,
                "directed": directed,
                "linkLabelField": link_label_field,
                "layout": layout_spec,
                "panel": panel,
                "id": id,
            },
            table,
        )
        if node_table is not None:
            self._node_tables[len(self._marks) - 1] = node_table
        return self

    def _remaining_moves(self, positions: Mapping[str, Any]) -> dict[str, Any]:
        """Moved network nodes without those the chart's data no longer has (see
        `remaining_moves`)."""
        default = self._table_names()[self._default][1] if self._default is not None else None
        return remaining_moves(
            positions, self._mark_specs(), self._used_columns(), self._derived_specs(), default
        )

    def _network_size(
        self,
        table: int,
        source: str,
        target: str,
        value: str | None,
        node_table: int | None,
        node: str | None,
        *,
        directed: bool = False,
    ) -> tuple[int, int]:
        """How many nodes and links a network draws, counted as the browser
        counts them: the names in the nodes table and in rows the links keep,
        and one link per pair of different names (either way round, unless
        ``directed``) whose values sum to a finite total."""
        links = self._tables[table][1]
        found, links_count = network_nodes(
            links.column(source),
            links.column(target),
            None if value is None else links.column(value),
            None if node_table is None else self._tables[node_table][1].column(node or ""),
            directed=directed,
        )
        return len(found), links_count

    def _layout_place(self, kind: str) -> None:
        """Layout marks (pies, treemaps, sunbursts, gauges, funnels, radars, Sankey
        diagrams, graphs) have no axes to zoom: they have their chart to
        themselves, or a facet panel each, or a panel of their own (see ``_add``).
        A treemap or sunburst drills with ``zoom=True``; a network pans and
        zooms its layout plane, lassos nodes, moves them with ``drag=True``,
        and selects rows. With panels, which options panels with axes take is
        checked once every mark is added (see ``to_spec``)."""
        if self._row_selection and kind not in _SELECTING_LAYOUT_MARKS:
            raise ValueError(
                f"Chart row_selection: a {kind} cannot select rows yet; marks along x "
                "and y can, as can maps, pies, funnels, treemaps, sunbursts, Sankey "
                "diagrams, and networks"
            )
        if not self._panels:
            _check_alone(self._settings, kind)

    @_check_method_options
    def geoshape(
        self,
        geometry: str | None = None,
        *,
        data: Any = None,
        label_field: str | None = None,
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
        facet: Literal["repeat"] | None = None,
        panel: str | None = None,
        tooltip: Tooltip | None = None,
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
        Every feature is drawn; those no row names have no value.
        ``label_field`` names a category column labeling regions in tooltips,
        keyboard reading, and the summary.
        Geoshape and geopoint marks share a chart, projected by its
        ``projection``: with facets, every layer splits its rows by the facet
        column unless ``facet="repeat"`` draws it whole in each panel (a base
        map); with panels, the layers naming a ``panel`` are its map.
        """
        self._map_place("geoshape")
        if geojson is not None:
            if locations is None:
                raise ValueError(
                    "geoshape geojson: needs locations, the column naming each row's feature"
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
                raise ValueError("geoshape locations: needs geojson, the shapes the rows name")
            table = self._mark_table(data)
        if geometry is None:
            geometry = _geometry_column(self._tables[table][0], self._tables[table][1])
        self._require(table, geometry, ("geometry",), "geoshape geometry")
        self._require(table, label_field, ("category",), "geoshape label_field")
        self._require(table, color, ("number", "category"), "geoshape color")
        self._check_category_color(table, color, colors, color_domain, color_midpoint, "geoshape")
        ramp = next(
            (
                name
                for name, value in (
                    ("colors", colors),
                    ("color_domain", color_domain),
                    ("color_midpoint", color_midpoint),
                )
                if value is not None
            ),
            None,
        )
        if color is None and ramp is not None:
            raise ValueError(f"geoshape {ramp}: colors by a numeric color column; give color")
        if fill_opacity is not None and not (_finite(fill_opacity) and 0 <= fill_opacity <= 1):
            raise ValueError(
                "geoshape fill_opacity: expected a number from 0 to 1; "
                f"received {shown(fill_opacity)}"
            )
        if stroke_width is not None and not (_finite(stroke_width) and stroke_width >= 0):
            raise ValueError(
                f"geoshape stroke_width: expected 0 or more pixels; received {shown(stroke_width)}"
            )
        return self._add(
            {
                "type": "geoshape",
                "geometry": geometry,
                "labelField": label_field,
                "color": color,
                "colors": _colors(colors, "geoshape colors"),
                "colorDomain": _range(color_domain, "geoshape color_domain"),
                "colorMidpoint": _midpoint(color_midpoint, color_domain, "geoshape"),
                "fill": fill,
                "fillOpacity": fill_opacity,
                "stroke": stroke,
                "strokeWidth": stroke_width,
                "label": label,
                "facet": _mark_facet(facet, "geoshape"),
                "panel": panel,
                "tooltip": self._mark_tooltip(table, tooltip, "geoshape"),
                "id": id,
            },
            table,
        )

    @_check_method_options
    def geopoint(
        self,
        longitude: str,
        latitude: str,
        *,
        data: Any = None,
        label_field: str | None = None,
        series: str | None = None,
        radius: float | None = None,
        size: str | None = None,
        radius_range: tuple[float, float] | None = None,
        color: str | None = None,
        colors: str | Sequence[str] | None = None,
        color_domain: tuple[float, float] | None = None,
        color_midpoint: float | None = None,
        fill: str | None = None,
        fill_opacity: float | None = None,
        stroke: str | None = None,
        stroke_width: float | None = None,
        label: str | None = None,
        facet: Literal["repeat"] | None = None,
        panel: str | None = None,
        tooltip: Tooltip | None = None,
        id: str | None = None,
    ) -> Chart:
        """Points of a map at ``longitude`` and ``latitude`` columns (degrees):
        places of one ``radius`` in pixels, or bubbles sized by area by a
        numeric ``size`` column within ``radius_range``.

        ``series`` gives a color and legend entry per category, ``color`` colors
        points by a numeric column (or a category column, a palette color per
        value, as ``Chart.point``'s). Points are drawn largest first, each ringed
        in the background color (``stroke``, ``stroke_width``). For a
        GeoDataFrame of points, add the columns first:
        ``gdf.assign(lon=gdf.geometry.x, lat=gdf.geometry.y)``. Layers share a
        map as ``Chart.geoshape`` says, also in facets and panels.
        """
        self._map_place("geopoint")
        table = self._mark_table(data)
        self._require(table, longitude, ("number",), "geopoint longitude")
        self._require(table, latitude, ("number",), "geopoint latitude")
        self._require(table, label_field, ("category",), "geopoint label_field")
        self._require(table, series, ("category",), "geopoint series")
        _check_size(radius, size, "geopoint")
        self._require(table, size, ("number",), "geopoint size")
        self._require(table, color, ("number", "category"), "geopoint color")
        self._check_category_color(table, color, colors, color_domain, color_midpoint, "geopoint")
        if fill_opacity is not None and not (_finite(fill_opacity) and 0 <= fill_opacity <= 1):
            raise ValueError(
                "geopoint fill_opacity: expected a number from 0 to 1; "
                f"received {shown(fill_opacity)}"
            )
        if stroke_width is not None and not (_finite(stroke_width) and stroke_width >= 0):
            raise ValueError(
                f"geopoint stroke_width: expected 0 or more pixels; received {shown(stroke_width)}"
            )
        return self._add(
            {
                "type": "geopoint",
                "longitude": longitude,
                "latitude": latitude,
                "labelField": label_field,
                "series": series,
                "radius": radius,
                "size": size,
                "radiusRange": _range(radius_range, "geopoint radius_range", minimum=0),
                "color": color,
                "colors": _colors(colors, "geopoint colors"),
                "colorDomain": _range(color_domain, "geopoint color_domain"),
                "colorMidpoint": _midpoint(color_midpoint, color_domain, "geopoint"),
                "fill": fill,
                "fillOpacity": fill_opacity,
                "stroke": stroke,
                "strokeWidth": stroke_width,
                "label": label,
                "facet": _mark_facet(facet, "geopoint"),
                "panel": panel,
                "tooltip": self._mark_tooltip(table, tooltip, "geopoint"),
                "id": id,
            },
            table,
        )

    def _map_place(self, kind: str) -> None:
        """Maps zoom and pan both ways (``zoom=True`` or ``"xy"``), take a
        ``"lasso"`` brush, select rows, and sync nothing; with panels, which
        options panels with axes take is checked once every mark is added."""
        if not self._panels:
            _check_alone(self._settings, kind)

    @_check_method_options
    def point_3d(
        self,
        x: str,
        y: str,
        z: str,
        *,
        data: Any = None,
        series: str | None = None,
        label_field: str | None = None,
        radius: float | None = None,
        color: str | None = None,
        colors: str | Sequence[str] | None = None,
        color_domain: tuple[float, float] | None = None,
        color_midpoint: float | None = None,
        fill: str | None = None,
        fill_opacity: float | None = None,
        label: str | None = None,
        tooltip: Tooltip | None = None,
        panel: str | None = None,
        id: str | None = None,
    ) -> Chart:
        """Points in a 3D chart at the numeric or datetime columns ``x``, ``y``,
        and ``z`` (z is vertical).

        ``series`` gives a color and legend entry per category, ``color``
        colors points by a numeric column (or a category column, a palette
        color per value, as ``Chart.point``'s), and ``label_field`` names a
        category column labeling each point in tooltips. ``radius`` is the
        radius in pixels (3.5 by default). 3D marks share their chart or subplot, its
        box, and its ``camera``.
        """
        self._check_3d("point_3d")
        table = self._mark_table(data)
        for axis, field in (("x", x), ("y", y), ("z", z)):
            self._require(table, field, _NUMERIC, f"point_3d {axis}")
        self._require(table, series, ("category",), "point_3d series")
        self._require(table, label_field, ("category",), "point_3d label_field")
        self._require(table, color, ("number", "category"), "point_3d color")
        self._check_category_color(table, color, colors, color_domain, color_midpoint, "point_3d")
        _check_size(radius, None, "point_3d")
        if fill_opacity is not None and not (_finite(fill_opacity) and 0 <= fill_opacity <= 1):
            raise ValueError(
                "point_3d fill_opacity: expected a number from 0 to 1; "
                f"received {shown(fill_opacity)}"
            )
        return self._add(
            {
                "type": "point3d",
                "x": x,
                "y": y,
                "z": z,
                "series": series,
                "labelField": label_field,
                "radius": radius,
                "color": color,
                "colors": _colors(colors, "point_3d colors"),
                "colorDomain": _range(color_domain, "point_3d color_domain"),
                "colorMidpoint": _midpoint(color_midpoint, color_domain, "point_3d"),
                "fill": fill,
                "fillOpacity": fill_opacity,
                "label": label,
                "tooltip": self._mark_tooltip(table, tooltip, "point_3d"),
                "panel": panel,
                "id": id,
            },
            table,
        )

    @_check_method_options
    def line_3d(
        self,
        x: str,
        y: str,
        z: str,
        *,
        data: Any = None,
        series: str | None = None,
        stroke: str | None = None,
        stroke_width: float | None = None,
        label: str | None = None,
        tooltip: Tooltip | None = None,
        panel: str | None = None,
        id: str | None = None,
    ) -> Chart:
        """Lines in a 3D chart through the numeric or datetime columns ``x``,
        ``y``, and ``z`` (z is vertical).

        Each ``series`` category's rows, in table order, are one path with its
        color and legend entry (all rows are one path without it); a row
        missing a value breaks its path. ``stroke_width`` is in pixels (2 by
        default) and stays the same however near or far the line is. 3D marks
        share their chart or subplot, its box, and its ``camera``.
        """
        self._check_3d("line_3d")
        table = self._mark_table(data)
        for axis, field in (("x", x), ("y", y), ("z", z)):
            self._require(table, field, _NUMERIC, f"line_3d {axis}")
        self._require(table, series, ("category",), "line_3d series")
        if stroke_width is not None and not (_finite(stroke_width) and stroke_width > 0):
            raise ValueError(
                "line_3d stroke_width: expected a positive number of pixels; "
                f"received {shown(stroke_width)}"
            )
        return self._add(
            {
                "type": "line3d",
                "x": x,
                "y": y,
                "z": z,
                "series": series,
                "stroke": stroke,
                "strokeWidth": stroke_width,
                "label": label,
                "tooltip": self._mark_tooltip(table, tooltip, "line_3d"),
                "panel": panel,
                "id": id,
            },
            table,
        )

    @_check_method_options
    def surface(
        self,
        x: Any = None,
        y: Any = None,
        z: Any = None,
        *,
        data: Any = None,
        color: str | None = None,
        colors: str | Sequence[str] | None = None,
        color_domain: tuple[float, float] | None = None,
        color_midpoint: float | None = None,
        fill_opacity: float | None = None,
        shading: bool | None = None,
        wireframe: bool | None = None,
        label: str | None = None,
        panel: str | None = None,
        id: str | None = None,
    ) -> Chart:
        """A surface in a 3D chart, from a grid of rows or from a matrix.

        With column names, each row is a grid point: ``x`` and ``y`` (numbers,
        datetimes, or categories) pick its place, and ``z`` is its height;
        points without a value leave holes. With a 2D array ``z`` (as in
        ``go.Surface(z=...)``), row ``i`` and column ``j`` is the height at
        ``y[i]`` and ``x[j]``, where ``x`` and ``y`` are optional sequences
        (positions 0, 1, 2, ... by default), sent as a matrix (``hg.matrix``)
        of columns ``"x"``, ``"y"``, and ``"z"``.

        The surface is colored by height, or by a numeric ``color`` column,
        and shaded by how it faces a light (``shading=False`` keeps colors as
        the legend shows them); ``wireframe=True`` draws its grid lines.
        """
        self._check_3d("surface")
        if z is None:
            raise TypeError(
                "surface z: expected a column name or a 2D array of heights; received None"
            )
        if not isinstance(z, str):
            if data is not None or color is not None:
                option = "data" if data is not None else "color"
                raise ValueError(
                    f"surface {option}: a z matrix takes no data or color column; drop {option}"
                )
            data = _matrix_of(z, x, y, "z", "surface")
            x, y, z = "x", "y", "z"
        elif not (isinstance(x, str) and isinstance(y, str)):
            axis, value = ("x", x) if not isinstance(x, str) else ("y", y)
            raise TypeError(
                f"surface {axis}: expected a column name, as z names a column; "
                f"received {shown(value)}"
            )
        table = self._mark_table(data)
        self._require(table, x, (*_NUMERIC, "category"), "surface x")
        self._require(table, y, (*_NUMERIC, "category"), "surface y")
        self._require(table, z, ("number",), "surface z")
        self._require(table, color, ("number",), "surface color")
        if fill_opacity is not None and not (_finite(fill_opacity) and 0 <= fill_opacity <= 1):
            raise ValueError(
                "surface fill_opacity: expected a number from 0 to 1; "
                f"received {shown(fill_opacity)}"
            )
        return self._add(
            {
                "type": "surface",
                "x": x,
                "y": y,
                "z": z,
                "color": color,
                "colors": _colors(colors, "surface colors"),
                "colorDomain": _range(color_domain, "surface color_domain"),
                "colorMidpoint": _midpoint(color_midpoint, color_domain, "surface"),
                "fillOpacity": fill_opacity,
                "shading": shading,
                "wireframe": wireframe,
                "label": label,
                "panel": panel,
                "id": id,
            },
            table,
        )

    def _check_3d(self, kind: str) -> None:
        """3D marks use a chart or subplot; only standalone charts restrict axis interaction."""
        if self._facets:
            raise ValueError(
                f"{kind} facet: 3D marks cannot split into facets; use separate marks in panels"
            )
        if self._row_selection:
            raise ValueError(
                f"Chart row_selection: a {kind} cannot select rows yet; marks along x and y can"
            )
        if self._panels:
            return
        used = next((name for name in ("brush", "sync") if self._settings.get(name)), None)
        if used is not None:
            raise ValueError(f"Chart {used}: a {kind} has no x axis to act on; drop {used}")
        if self._settings.get("zoom") not in (True, False, None):
            raise ValueError(
                "Chart zoom: 3D charts zoom their camera with zoom=True; "
                f"received {shown(self._settings['zoom'])}"
            )

    @_check_method_options
    def heatmap(
        self,
        x: Any = None,
        y: Any = None,
        color: Any = None,
        *,
        x1: str | None = None,
        x2: str | None = None,
        y1: str | None = None,
        y2: str | None = None,
        date: str | None = None,
        calendar: Literal["weeks", "months"] | None = None,
        week_start: Literal["mon", "tue", "wed", "thu", "fri", "sat", "sun"] | None = None,
        data: Any = None,
        colors: str | Sequence[str] | None = None,
        color_domain: tuple[float, float] | None = None,
        color_midpoint: float | None = None,
        reduce: CellReduce | None = None,
        sampling: HeatmapSampling | None = None,
        x_step: float | None = None,
        y_step: float | None = None,
        x_banded: bool = False,
        y_banded: bool = False,
        label: str | None = None,
        legend: Literal[False] | None = None,
        facet: Literal["repeat"] | None = None,
        panel: str | None = None,
        clip: Clip | None = None,
        tooltip: Tooltip | None = None,
        id: str | None = None,
    ) -> Chart:
        """A grid of cells colored by the numeric column ``color``: cells at ``x`` and ``y``, or the
        days of a time column ``date`` laid out as a calendar. With a 2D array ``color`` (as in
        ``go.Heatmap(z=...)``), row ``i`` and column ``j`` is the cell at ``y[i]`` and ``x[j]``
        (positions 0, 1, 2, ... without them), sent as a matrix (``hg.matrix``).

        Category columns give one column (or row) per category. Number and
        time columns place a cell at each distinct value along a number or
        time axis, which zooms and pans: each cell reaches halfway to the
        values beside it, or with ``x_step`` / ``y_step`` (milliseconds for
        times) is that wide around its value, never past halfway to a
        closer neighbor, so values further apart leave gaps. ``x_banded`` /
        ``y_banded`` give one column (or row) per distinct number or time
        instead, as categories have.

        A calendar lays the days out in the chart's ``time_zone``: with
        ``calendar="weeks"`` (the default), a column per week along a time
        axis and a row per day of the week, from ``week_start`` (``"mon"``
        by default) down; with ``calendar="months"``, a row per month, from
        the first day's month to the last's, and a column per day of the
        month. Days without rows are empty; rows sharing a day share a cell.

        ``x1`` and ``x2`` (or ``y1`` and ``y2``), number or time columns,
        place each row's cell between two edges instead, as the bins of
        ``hg.derive(...).bin(..., end=...)`` give them; cells of one first
        edge have one second edge, and must not overlap.

        ``colors`` is a scheme name such as ``"viridis"`` or a list of hex
        colors, low to high; with ``color_midpoint``, the theme's diverging
        ramp is the default and the midpoint takes its middle color. Rows
        sharing a cell combine into its value by ``reduce``: ``"last"`` (the
        default), the last of them with a value, or their ``"mean"``,
        ``"sum"``, ``"min"``, or ``"max"``, the same at every zoom. Grids
        with more columns or rows than the plot has pixels draw each pixel
        from a block of cells, colored by ``sampling={"reduce": ...}`` of
        their values: ``"mean"`` (the default), ``"max"``, or ``"min"``.
        """
        if reduce not in (None, "last", "mean", "sum", "min", "max"):
            raise ValueError(
                'heatmap reduce: expected "last", "mean", "sum", "min", or "max"; '
                f"received {shown(reduce)}"
            )
        sampled = _sampling(sampling)
        if color is None:
            raise ValueError("heatmap color: needs the numeric column that colors the cells")
        if not isinstance(color, str):
            placed = next(
                (
                    name
                    for name, value in (("data", data), ("date", date), ("x1", x1), ("y1", y1))
                    if value is not None
                ),
                None,
            )
            if placed is not None:
                raise ValueError(
                    f"heatmap {placed}: a color matrix places its cells itself; drop {placed}, or "
                    "name columns"
                )
            data = _matrix_of(color, x, y, "value", "heatmap")
            x, y, color = "x", "y", "value"
        table = self._mark_table(data)
        self._require(table, color, _NUMERIC, "heatmap color")
        shared = {
            "type": "heatmap",
            "color": color,
            "colors": _colors(colors, "heatmap colors"),
            "colorDomain": _range(color_domain, "heatmap color_domain"),
            "colorMidpoint": _midpoint(color_midpoint, color_domain, "heatmap"),
            "reduce": reduce,
            "sampling": sampled,
            "label": label,
            "legend": _mark_legend(legend, "heatmap"),
            "facet": _mark_facet(facet, "heatmap"),
            "panel": panel,
            "clip": _clip(clip, "heatmap"),
            "tooltip": self._mark_tooltip(table, tooltip, "heatmap"),
            "id": id,
        }
        if date is not None:
            grid = {
                "x": x,
                "y": y,
                "x1": x1,
                "x2": x2,
                "y1": y1,
                "y2": y2,
                "x_step": x_step,
                "y_step": y_step,
            }
            given = [name for name, option in grid.items() if option is not None]
            given += [name for name, on in (("x_banded", x_banded), ("y_banded", y_banded)) if on]
            if given:
                raise ValueError(
                    f"heatmap {given[0]}: a calendar (date) places its days itself; drop {given[0]}"
                )
            if calendar not in (None, "weeks", "months"):
                raise ValueError(
                    f'heatmap calendar: expected "weeks" or "months"; received {shown(calendar)}'
                )
            if week_start is not None and week_start not in _WEEKDAYS:
                raise ValueError(
                    f"heatmap week_start: expected {listed(_WEEKDAYS)}; "
                    f"received {shown(week_start)}"
                )
            if calendar == "months" and week_start is not None:
                raise ValueError(
                    "heatmap week_start: applies to calendars of weeks; "
                    'drop it, or give calendar="weeks"'
                )
            self._require(table, date, ("time",), "heatmap date")
            return self._add(
                {**shared, "date": date, "calendar": calendar, "weekStart": week_start}, table
            )
        edges: dict[str, Any] = {}
        for axis, one, low, high, step, bands in (
            ("x", x, x1, x2, x_step, x_banded),
            ("y", y, y1, y2, y_step, y_banded),
        ):
            if one is not None and (low is not None or high is not None):
                raise ValueError(
                    f"heatmap {axis}1: {axis} places cells at values, {axis}1 and {axis}2 "
                    "between edges; give one form"
                )
            if (low is None) != (high is None):
                missing = f"{axis}1" if low is None else f"{axis}2"
                raise ValueError(
                    f"heatmap {missing}: missing; cells between edges need {axis}1 and {axis}2"
                )
            if one is None and low is None:
                raise ValueError(
                    "heatmap: needs x and y (or x1 and x2, y1 and y2), or a date to lay out "
                    "as a calendar"
                )
            if low is not None and high is not None:
                option = f"{axis}_step" if step is not None else f"{axis}_banded" if bands else None
                if option is not None:
                    raise ValueError(
                        f"heatmap {option}: cells between {axis}1 and {axis}2 take their edges "
                        f"from them; drop {option}"
                    )
                self._require(table, low, _NUMERIC, f"heatmap {axis}1")
                self._require(table, high, _NUMERIC, f"heatmap {axis}2")
                if self._kind(table, low) != self._kind(table, high):
                    raise ValueError(
                        f"heatmap {axis}2: {high!r} holds {self._kind(table, high)} values and "
                        f"{axis}1's {low!r} {self._kind(table, low)} values; give edges of one kind"
                    )
                edges[f"{axis}1"], edges[f"{axis}2"] = low, high
        if calendar is not None or week_start is not None:
            option = "calendar" if calendar is not None else "week_start"
            raise ValueError(
                f"heatmap {option}: applies to calendars of a date; give date or drop {option}"
            )
        self._require(table, x, ("number", "time", "category"), "heatmap x")
        self._require(table, y, ("number", "time", "category"), "heatmap y")

        def placement(
            axis: str, field: str | None, step: float | None, bands: bool
        ) -> tuple[float | None, bool | None]:
            """The spec's step and banded option along one axis."""
            if not isinstance(bands, bool):
                raise ValueError(
                    f"heatmap {axis}_banded: expected True or False; received {shown(bands)}"
                )
            category = field is not None and self._kind(table, field) == "category"
            if step is not None:
                if not (_finite(step) and step > 0):
                    raise ValueError(
                        f"heatmap {axis}_step: expected a positive number; received {shown(step)}"
                    )
                if category or bands:
                    raise ValueError(
                        f"heatmap {axis}_step: sizes cells along a number or time {axis} axis; "
                        + (
                            f"{field!r} holds categories, so drop {axis}_step"
                            if category
                            else f"{axis}_banded bands it, so drop one"
                        )
                    )
                step = float(step)
            return step, True if bands else None

        x_step, x_bands = placement("x", x, x_step, x_banded)
        y_step, y_bands = placement("y", y, y_step, y_banded)
        return self._add(
            {
                **shared,
                "x": x,
                "y": y,
                "xStep": x_step,
                "yStep": y_step,
                "xBanded": x_bands,
                "yBanded": y_bands,
                **edges,
            },
            table,
        )

    @_check_method_options
    def contour(
        self,
        x: Any = None,
        y: Any = None,
        color: Any = None,
        *,
        data: Any = None,
        thresholds: int | Sequence[float] | np.ndarray[Any, Any] | None = None,
        variant: Literal["lines", "bands"] | None = None,
        colors: str | Sequence[str] | None = None,
        color_domain: tuple[float, float] | None = None,
        color_midpoint: float | None = None,
        stroke: str | None = None,
        stroke_width: float | None = None,
        fill_opacity: float | None = None,
        label: str | None = None,
        legend: Literal[False] | None = None,
        facet: Literal["repeat"] | None = None,
        panel: str | None = None,
        clip: Clip | None = None,
        id: str | None = None,
    ) -> Chart:
        """Contours of a field sampled on a grid: lines where it crosses each
        threshold, or with ``variant="bands"``, bands filled from each up to
        the next, colored on the ``colors`` ramp.

        With column names, each row is a grid point: number or time columns
        ``x`` and ``y`` place it on a rectilinear grid (every distinct x with
        every distinct y), and the number column ``color`` is the field's
        value there; an ``hg.matrix`` holds such a grid as it is. With a 2D
        array ``color`` (as in ``go.Contour(z=...)``), row ``i`` and column
        ``j`` is the value at ``y[i]`` and ``x[j]`` (positions 0, 1, 2, ...
        without them), sent as a matrix. Values are interpolated linearly
        between grid points; points without a value leave holes, and contours
        end where the grid does.

        ``thresholds`` is about how many round values across the field (10
        by default; for bands, round edges covering it), or the values,
        increasing (at least two for bands). Lines take ``stroke`` (one color
        for all) and ``stroke_width``; bands ``fill_opacity``.
        """
        if variant not in (None, "lines", "bands"):
            raise ValueError(
                f'contour variant: expected "lines" or "bands"; received {shown(variant)}'
            )
        bands = variant == "bands"
        if color is None:
            raise ValueError("contour color: needs the number column, or a 2D array, of the field")
        if not isinstance(color, str):
            if data is not None:
                raise ValueError(
                    "contour data: a color matrix holds the field itself; drop data, or name "
                    "columns of it"
                )
            data = _matrix_of(color, x, y, "value", "contour")
            x, y, color = "x", "y", "value"
        elif not (isinstance(x, str) and isinstance(y, str)):
            axis, value = ("x", x) if not isinstance(x, str) else ("y", y)
            raise TypeError(
                f"contour {axis}: expected a column name, as color names a column; "
                f"received {shown(value)}"
            )
        given = ("stroke", stroke) if stroke is not None else ("stroke_width", stroke_width)
        if bands and given[1] is not None:
            raise ValueError(
                f"contour {given[0]}: draws lines; bands take colors and fill_opacity, so drop "
                f'{given[0]} or use variant="lines"'
            )
        if not bands and fill_opacity is not None:
            raise ValueError(
                "contour fill_opacity: fills bands; lines take stroke and stroke_width, so drop "
                'it or use variant="bands"'
            )
        if stroke_width is not None and not (_finite(stroke_width) and stroke_width >= 0):
            raise ValueError(
                "contour stroke_width: expected a number of at least 0; "
                f"received {shown(stroke_width)}"
            )
        if fill_opacity is not None and not (_finite(fill_opacity) and 0 <= fill_opacity <= 1):
            raise ValueError(
                "contour fill_opacity: expected a number from 0 to 1; "
                f"received {shown(fill_opacity)}"
            )
        table = self._mark_table(data)
        self._require(table, x, _NUMERIC, "contour x")
        self._require(table, y, _NUMERIC, "contour y")
        self._require(table, color, ("number",), "contour color")
        return self._add(
            {
                "type": "contour",
                "x": x,
                "y": y,
                "color": color,
                "thresholds": _thresholds(thresholds, bands),
                "variant": variant,
                "colors": _colors(colors, "contour colors"),
                "colorDomain": _range(color_domain, "contour color_domain"),
                "colorMidpoint": _midpoint(color_midpoint, color_domain, "contour"),
                "stroke": stroke,
                "strokeWidth": None if stroke_width is None else float(stroke_width),
                "fillOpacity": None if fill_opacity is None else float(fill_opacity),
                "label": label,
                "legend": _mark_legend(legend, "contour"),
                "facet": _mark_facet(facet, "contour"),
                "panel": panel,
                "clip": _clip(clip, "contour"),
                "id": id,
            },
            table,
        )

    @_check_method_options
    def dendrogram(
        self,
        first: str,
        second: str,
        height: str,
        *,
        leaves: Sequence[str],
        side: Literal["bottom", "top", "left", "right"] | None = None,
        data: Any = None,
        stroke: str | None = None,
        stroke_width: float | None = None,
        label: str | None = None,
        facet: Literal["repeat"] | None = None,
        panel: str | None = None,
        clip: Clip | None = None,
        id: str | None = None,
    ) -> Chart:
        """A SciPy-layout linkage tree with leaves on category bands.

        ``leaves[i]`` labels leaf id i. ``side`` is the plot edge at height
        zero (bottom by default); heights scale within the panel's pixels.
        With facets, pass ``facet="repeat"`` to draw the whole tree in each.
        """
        if side not in (None, "bottom", "top", "left", "right"):
            raise ValueError(
                'dendrogram side: expected "bottom", "top", "left", or "right"; '
                f"received {shown(side)}"
            )
        if stroke_width is not None and (not np.isfinite(stroke_width) or stroke_width < 0):
            raise ValueError(
                "dendrogram stroke_width: expected a finite number of at least 0; "
                f"received {shown(stroke_width)}"
            )
        table = self._mark_table(data)
        options = ("first", "second", "height")
        fields = (first, second, height)
        for option, field in zip(options, fields, strict=True):
            self._require(table, field, ("number",), f"dendrogram {option}")
        if isinstance(leaves, (str, bytes)):
            raise TypeError(
                f"dendrogram leaves: expected a list of labels; received {shown(leaves)}"
            )
        labels = list(leaves)
        seen: set[str] = set()
        for i, leaf in enumerate(labels):
            if not isinstance(leaf, str):
                raise TypeError(
                    f"dendrogram leaves[{i}]: expected a label (a string); received {shown(leaf)}"
                )
            if leaf in seen:
                raise ValueError(
                    f"dendrogram leaves[{i}]: {shown(leaf)} labels an earlier leaf too; "
                    "give each leaf its own label"
                )
            seen.add(leaf)
        columns = [self._tables[table][1].column(field).values for field in fields]
        rows = len(columns[0])
        n = rows + 1
        if len(labels) != n:
            raise ValueError(
                f"dendrogram leaves: expected {n} labels, for {rows} merge rows; "
                f"received {len(labels)}"
            )
        used = bytearray(n + rows)
        for row in range(rows):
            for channel, column in enumerate(columns):
                value = float(column[row])
                at = f"dendrogram {options[channel]}, row {row}"
                if channel == 2:
                    if not np.isfinite(value) or value < 0:
                        raise ValueError(
                            f"{at}: expected a finite height of at least 0; received {value}"
                        )
                else:
                    if not np.isfinite(value) or not value.is_integer() or not 0 <= value < n + row:
                        raise ValueError(
                            f"{at}: expected a whole number naming a leaf or an earlier merge; "
                            f"received {value}"
                        )
                    cluster = int(value)
                    if used[cluster]:
                        raise ValueError(
                            f"{at}: cluster {cluster} is merged more than once; merge it once"
                        )
                    used[cluster] = 1
        return self._add(
            {
                "type": "dendrogram",
                "first": first,
                "second": second,
                "height": height,
                "leaves": labels,
                "side": side,
                "stroke": stroke,
                "strokeWidth": stroke_width,
                "label": label,
                "facet": _mark_facet(facet, "dendrogram"),
                "panel": panel,
                "clip": _clip(clip, "dendrogram"),
                "id": id,
            },
            table,
        )

    @_check_method_options
    def rule(
        self,
        *,
        x: Coordinate | None = None,
        y: Coordinate | None = None,
        span: tuple[Coordinate, Coordinate] | None = None,
        label: str | Label | Mapping[str, Any] | None = None,
        data: Any = None,
        stroke: str | None = None,
        stroke_width: float | None = None,
        stroke_opacity: float | None = None,
        dash: Dash | None = None,
        contribute_domain: bool | None = None,
        axis: Literal["left", "right"] | None = None,
        facet: Literal["repeat"] | None = None,
        panel: str | None = None,
        clip: Clip | None = None,
        id: str | None = None,
    ) -> Chart:
        """Reference lines: horizontal at ``y`` or vertical at ``x``.

        A number or datetime draws one rule; a column name draws one rule per
        row. ``hg.Fraction``, ``hg.Pixels``, and ``hg.DataPosition`` place a
        rule by a share of the plot, by pixels, or by a value moved by an
        offset. ``span`` (two such places) runs it along part of the other
        axis. ``label`` is text, or an ``hg.Label``: a column of labels
        (``field``), placed at the rule's start, center, or end, or outside
        the plot beside the axis (``hg.LabelPlace``), in a style of its own.
        Rules count toward the axes' domains only with
        ``contribute_domain=True``; otherwise they show where the data is.
        """
        if (x is None) == (y is None):
            raise ValueError("rule: needs exactly one of x and y")
        label_json = label_spec(label, "rule")
        if span is not None and (not isinstance(span, (tuple, list)) or len(span) != 2):
            raise ValueError(
                "rule span: expected two places, such as (hg.Fraction(0.25), 10); "
                f"received {shown(span)}"
            )
        places = {"x": x, "y": y, **({"span[0]": span[0], "span[1]": span[1]} if span else {})}
        table = self._annotation_table(data, places, label_json, "rule")
        return self._add(
            {
                "type": "rule",
                "x": coordinate_spec(x, "rule x"),
                "y": coordinate_spec(y, "rule y"),
                "span": (
                    [tagged_spec(place, "rule span") for place in span]
                    if span is not None
                    else None
                ),
                "stroke": stroke,
                "strokeWidth": stroke_width,
                "strokeOpacity": fraction_option(stroke_opacity, "rule stroke_opacity"),
                "dash": _dash(dash, "rule"),
                "label": label_json,
                "contributeDomain": _flag(contribute_domain, "rule contribute_domain"),
                "axis": axis,
                "facet": _mark_facet(facet, "rule"),
                "panel": panel,
                "clip": _clip(clip, "rule"),
                "id": id,
            },
            table,
        )

    @_check_method_options
    def region(
        self,
        *,
        x1: Coordinate | None = None,
        x2: Coordinate | None = None,
        y1: Coordinate | None = None,
        y2: Coordinate | None = None,
        label: str | Label | Mapping[str, Any] | None = None,
        data: Any = None,
        fill: str | None = None,
        fill_opacity: float | None = None,
        contribute_domain: bool | None = None,
        axis: Literal["left", "right"] | None = None,
        facet: Literal["repeat"] | None = None,
        panel: str | None = None,
        clip: Clip | None = None,
        halo: HaloOption | None = None,
        id: str | None = None,
    ) -> Chart:
        """Shaded regions: from ``x1`` to ``x2``, from ``y1`` to ``y2``, or both.

        Numbers or datetimes shade one region; column names shade one per
        row; ``hg.Fraction``, ``hg.Pixels``, and ``hg.DataPosition`` place
        an edge as they do rules. ``label`` is text or an ``hg.Label``,
        along the ``side`` its place names (top by default), inside or
        outside the region. Add regions before the marks they highlight to
        draw them underneath. Regions count toward the axes' domains only
        with ``contribute_domain=True``.
        """
        for start, end, name in ((x1, x2, "x"), (y1, y2, "y")):
            if (start is None) != (end is None):
                missing = f"{name}1" if start is None else f"{name}2"
                raise ValueError(f"region {missing}: needs both {name}1 and {name}2, or neither")
        if x1 is None and y1 is None:
            raise ValueError("region: needs x1 and x2, y1 and y2, or both")
        label_json = label_spec(label, "region")
        table = self._annotation_table(
            data, {"x1": x1, "x2": x2, "y1": y1, "y2": y2}, label_json, "region"
        )
        return self._add(
            {
                "type": "region",
                "halo": _halo(halo, "region"),
                "x1": coordinate_spec(x1, "region x1"),
                "x2": coordinate_spec(x2, "region x2"),
                "y1": coordinate_spec(y1, "region y1"),
                "y2": coordinate_spec(y2, "region y2"),
                "fill": fill,
                "fillOpacity": fill_opacity,
                "label": label_json,
                "contributeDomain": _flag(contribute_domain, "region contribute_domain"),
                "axis": axis,
                "facet": _mark_facet(facet, "region"),
                "panel": panel,
                "clip": _clip(clip, "region"),
                "id": id,
            },
            table,
        )

    @_check_method_options
    def text(
        self,
        *,
        label: str | Label | Mapping[str, Any],
        x: Coordinate | None = None,
        y: Coordinate | None = None,
        at: Position | None = None,
        data: Any = None,
        overlap: Literal["show", "hide", "move"] | None = None,
        style: MarkStyle | Mapping[str, Any] | None = None,
        contribute_domain: bool | None = None,
        axis: Literal["left", "right"] | None = None,
        facet: Literal["repeat"] | None = None,
        panel: str | None = None,
        clip: Clip | None = None,
        halo: HaloOption | None = None,
        id: str | None = None,
    ) -> Chart:
        """Text ``label`` at ``(x, y)``, or at ``at``, an ``hg.Position``.

        ``label`` is constant text, or an ``hg.Label``: a column of text
        (``field``), numbers written with ``format``, in an ``hg.TextStyle``
        of its own (font size, weight, color, halo, a box behind it, and
        ``align`` its start, center, or end at the point). Column names for
        ``x`` or ``y`` draw one label per row; ``hg.Fraction``,
        ``hg.Pixels``, and ``hg.DataPosition`` mix shares of the plot,
        pixels, and values moved by offsets. Labels that would cover an
        earlier one of this mark, in row order, are drawn anyway
        (``overlap="show"``), left out (``"hide"``), or, where their place is
        taken or outside the plot, tried around their point and left out when
        nothing fits (``"move"``), with a leader line back to it
        (``style=hg.MarkStyle(leader=hg.StrokeStyle(...))``).
        """
        if overlap not in (None, "show", "hide", "move"):
            raise ValueError(
                f'text overlap: expected "show", "hide", or "move"; received {shown(overlap)}'
            )
        if at is not None and (x is not None or y is not None):
            raise ValueError(
                "text at: a place, or its short forms x and y, not both; drop at or x and y"
            )
        if at is None and (x is None or y is None):
            raise ValueError("text: needs a place; give x and y, or at=hg.Position(x=..., y=...)")
        if at is not None:
            at = _built(at, Position, "text at")
        if label is None:
            raise ValueError("text label: needs text or an hg.Label; give label")
        label_json = label_spec(label, "text", places=False)
        places = {"x": at.x, "y": at.y} if at is not None else {"x": x, "y": y}
        table = self._annotation_table(data, places, label_json, "text")
        return self._add(
            {
                "type": "text",
                "halo": _halo(halo, "text"),
                "x": coordinate_spec(x, "text x"),
                "y": coordinate_spec(y, "text y"),
                "at": at._spec() if at is not None else None,
                "label": label_json,
                "overlap": overlap,
                "style": mark_style_spec(style, ("leader",), "text"),
                "contributeDomain": _flag(contribute_domain, "text contribute_domain"),
                "axis": axis,
                "facet": _mark_facet(facet, "text"),
                "panel": panel,
                "clip": _clip(clip, "text"),
                "id": id,
            },
            table,
        )

    # Output ----------------------------------------------------------------

    def to_spec(self) -> tuple[dict[str, Any], list[bytes]]:
        """The portable chart spec and the binary buffers its columns reference."""
        self._check_spec()
        return assemble_spec(
            self._spec_options(),
            self._layout_spec(),
            self._used_columns(),
            self._mark_specs(),
            self._derived_specs(),
            self._matrices(),
        )

    def _layouts(self) -> list[dict[str, Any]]:
        """The specs of the chart's layout marks, in order."""
        return [mark for mark, _ in self._marks if mark["type"] in _LAYOUT_MARKS]

    def _check_spec(self) -> None:
        """What the browser checks of the whole chart once every mark is added,
        before a spec of it is made or a live chart shows it."""
        layouts = self._layouts()
        check_layout_options(self._settings, layouts, len(self._panels))
        maps = [mark for mark in layouts if mark["type"] in _MAP_MARKS]
        if self._facets and maps and all(mark.get("facet") == "repeat" for mark in maps):
            raise ValueError(
                f"{maps[0]['type']} facet: every layer of the map repeats, so none splits into "
                'facet panels; drop facet="repeat" from one'
            )
        if self._settings.get("projection") is not None and not any(
            mark["type"] in _MAP_MARKS for mark, _ in self._marks
        ):
            raise ValueError(
                "Chart projection: projects geoshape and geopoint marks, and the chart has "
                "none; drop projection"
            )
        for panel in self._panels:
            if panel.camera is not None and not any(
                mark["type"] in _MARKS_3D and mark.get("panel") == panel.id
                for mark, _ in self._marks
            ):
                raise ValueError(
                    f"Panel camera: panel {shown(panel.id)} has no 3D marks; "
                    "drop camera or add a point_3d, line_3d, or surface mark"
                )
        three_d = any(mark["type"] in _MARKS_3D for mark, _ in self._marks)
        for name in ("z", "camera", "box_aspect"):
            if self._settings.get(name) is not None and not three_d:
                raise ValueError(
                    f"Chart {name}: an option of 3D charts, and the chart has no point_3d, "
                    f"line_3d, or surface marks; drop {name}"
                )

    def widget(self) -> ChartWidget:
        """A live notebook widget of this chart: Python can update it after display,
        and it reports zooming, brushing, hovering, and clicks back. It reports
        one x range, so its panels share x (x's scope is ``"chart"``).

        Needs the ``notebook`` extra (``pip install 'herceg[notebook]'``).
        """
        from .widget import ChartWidget

        return ChartWidget(self)

    def to_html(self, *, full_page: bool = True) -> str:
        """Self-contained HTML that renders the chart, with herceg and the data embedded."""
        return _render.html(*self.to_spec(), full_page=full_page)

    def to_svg(
        self,
        *,
        fonts: _render.Fonts | None = None,
        sizing: _render.SvgSizing | None = None,
        preserve_aspect_ratio: str | None = None,
        stroke_scaling: _render.StrokeScaling | None = None,
    ) -> str:
        """Standalone SVG, measured with supplied fonts and referencing their families.

        Requires the ``export`` extra. Font files are not embedded in the SVG.
        ``sizing="fluid"`` leaves out the width and height, so CSS or the
        container sizes the SVG and its viewBox scales the chart;
        ``preserve_aspect_ratio`` says how it fits a box of another shape
        (``"none"`` stretches it), and ``stroke_scaling="fixed"`` keeps lines
        their width in pixels however it scales. Scaling an SVG scales its
        text and geometry as laid out at the chart's size.
        """
        return _render.svg(
            *self.to_spec(),
            fonts=fonts,
            sizing=sizing,
            preserve_aspect_ratio=preserve_aspect_ratio,
            stroke_scaling=stroke_scaling,
        )

    def to_png(self, *, scale: float = 2, fonts: _render.Fonts | None = None) -> bytes:
        """PNG at ``scale`` times the chart size (requires the ``export`` extra)."""
        return _render.png(*self.to_spec(), scale=scale, fonts=fonts)

    def to_pdf(
        self,
        *,
        fonts: _render.Fonts | None = None,
        fallback: Sequence[str] = (),
        missing_glyph: str | None = None,
        page_size: _render.PdfPageSize | None = None,
        orientation: _render.PdfOrientation | None = None,
        margin: float | None = None,
        title: str | None = None,
        subject: str | None = None,
        language: str | None = None,
    ) -> bytes:
        """Vector PDF on chart-sized or named paper (requires the ``export`` extra)."""
        return _render.pdf(
            *self.to_spec(),
            fonts=fonts,
            fallback=fallback,
            missing_glyph=missing_glyph,
            page_size=page_size,
            orientation=orientation,
            margin=margin,
            title=title,
            subject=subject,
            language=language,
        )

    def save(
        self,
        path: str | PathLike[str],
        *,
        scale: float = 2,
        fonts: _render.Fonts | None = None,
        sizing: _render.SvgSizing | None = None,
        preserve_aspect_ratio: str | None = None,
        stroke_scaling: _render.StrokeScaling | None = None,
        fallback: Sequence[str] = (),
        missing_glyph: str | None = None,
        page_size: _render.PdfPageSize | None = None,
        orientation: _render.PdfOrientation | None = None,
        margin: float | None = None,
        title: str | None = None,
        subject: str | None = None,
        language: str | None = None,
    ) -> None:
        """Writes ``.html``, ``.svg``, ``.png``, or ``.pdf``, chosen by the file extension."""
        lower = str(path).lower()
        pdf_options = {
            "fallback": fallback or None,
            "missing_glyph": missing_glyph,
            "page_size": page_size,
            "orientation": orientation,
            "margin": margin,
            "title": title,
            "subject": subject,
            "language": language,
        }
        option = next((key for key, value in pdf_options.items() if value is not None), None)
        if not lower.endswith(".pdf") and option is not None:
            raise ValueError(
                f"save {option}: an option of PDF export; save to a .pdf path or drop {option}"
            )
        svg_options = {
            "sizing": sizing,
            "preserve_aspect_ratio": preserve_aspect_ratio,
            "stroke_scaling": stroke_scaling,
        }
        option = next((key for key, value in svg_options.items() if value is not None), None)
        if not lower.endswith(".svg") and option is not None:
            raise ValueError(
                f"save {option}: an option of SVG export; save to a .svg path or drop {option}"
            )
        if fonts is not None and lower.endswith(".html"):
            raise ValueError(
                "save fonts: an option of SVG, PNG, or PDF export; "
                "save to a .svg, .png, or .pdf path or drop fonts"
            )
        if lower.endswith(".html"):
            content: str | bytes = self.to_html()
        elif lower.endswith(".svg"):
            try:
                content = self.to_svg(
                    fonts=fonts,
                    sizing=sizing,
                    preserve_aspect_ratio=preserve_aspect_ratio,
                    stroke_scaling=stroke_scaling,
                )
            except (ValueError, TypeError) as error:
                raise type(error)(str(error).replace("to_svg", "save")) from None
        elif lower.endswith(".png"):
            try:
                content = self.to_png(scale=scale, fonts=fonts)
            except (ValueError, TypeError) as error:
                raise type(error)(str(error).replace("to_png", "save")) from None
        elif lower.endswith(".pdf"):
            try:
                content = self.to_pdf(
                    fonts=fonts,
                    fallback=fallback,
                    missing_glyph=missing_glyph,
                    page_size=page_size,
                    orientation=orientation,
                    margin=margin,
                    title=title,
                    subject=subject,
                    language=language,
                )
            except (ValueError, TypeError) as error:
                raise type(error)(str(error).replace("to_pdf", "save")) from None
        else:
            raise ValueError(
                'save path: expected a ".html", ".svg", ".png", or ".pdf" file; '
                f"received {shown(path)}"
            )
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

    def _spec_options(self) -> dict[str, Any]:
        """The spec's chart options, with its row selection, whose tables are named
        once the marks are known."""
        if not self._row_selection:
            return self._options
        names = [self._bound_table(binding) for binding in self._row_selection]
        if len(set(names)) < len(names):
            raise ValueError(
                "Chart row_selection: two bindings select rows of one table; "
                "give each table one binding"
            )
        for binding, name in zip(self._row_selection, names, strict=True):
            self._check_brush(binding, name)
        specs = [
            binding._spec(
                name, self._bound_length(binding) if binding.selection is not None else None
            )
            for binding, name in zip(self._row_selection, names, strict=True)
        ]
        return {**self._options, "rowSelection": specs[0] if len(specs) == 1 else specs}

    def _bound_length(self, binding: SelectionBinding) -> int | None:
        """How many rows the table a binding selects has; unknown (None) for a
        derived table, whose rows are computed in the browser."""
        index = self._bound_index(binding)
        if index in self._derived:
            return None
        columns = self._tables[index][1]
        if isinstance(columns, Matrix):
            return columns.shape[0] * columns.shape[1]
        return len(columns.column(_convertible(columns))) if columns.names else 0

    def _check_brush(self, binding: SelectionBinding, name: str) -> None:
        """Brushes along a summary's statistics (a histogram's counts, a box
        plot's values), and lassos over summaries, select no rows yet."""
        brush = self._settings["brush"]
        if brush is None or ("lasso" if brush == "lasso" else "brush") not in binding.events:
            return
        for mark, table in self._marks:
            kind = mark["type"]
            if table is None or table_name(table) != name:
                continue
            if brush == "lasso" and kind in ("histogram", "boxplot", "boxen", "violin"):
                raise ValueError(
                    f"SelectionBinding events: lassos cannot select the rows of {kind} marks "
                    'yet; leave out "lasso"'
                )
            if kind == "rug":
                # A rug's ticks have a place along their own axis only.
                observed = "x" if mark.get("x") is not None else "y"
                other = "y" if observed == "x" else "x"
                if brush in (other, "xy"):
                    raise ValueError(
                        f"Chart brush: a rug's ticks have no {other} value, so its rows are "
                        f"brushed along {observed} only; received {shown(brush)}"
                    )
                continue
            if kind not in ("histogram", "boxplot", "boxen", "violin"):
                continue
            # A 2D histogram's cells place their rows along x and y both.
            if kind == "histogram" and mark.get("x") is not None and mark.get("y") is not None:
                continue
            # A summary's value axis holds statistics: a histogram's counts,
            # across its binned axis, and box plots' values, which may lie along x.
            y = mark.get("y")
            if kind == "histogram":
                categories = "y" if mark.get("x") is None else "x"
            else:
                categories = "y" if y is not None and self._kind(table, y) == "category" else "x"
            values = "y" if categories == "x" else "x"
            if brush in (values, "xy"):
                raise ValueError(
                    f"Chart brush: a {kind}'s {values} axis holds statistics, so its rows are "
                    f"brushed along {categories} only; received {shown(brush)}"
                )

    def _bound_table(self, binding: SelectionBinding) -> str:
        """The name of the table a binding selects rows of."""
        return table_name(self._bound_index(binding))

    def _bound_index(self, binding: SelectionBinding) -> int:
        """The table a binding selects rows of: its ``data``, or else the chart's
        data, or the one table the marks read."""
        read = sorted(
            {table for _, table in self._marks if table is not None}
            | set(self._node_tables.values())
        )
        if binding.data is None:
            if self._default is not None and self._default in read:
                return self._default
            if len(read) != 1:
                raise ValueError(
                    "SelectionBinding data: the chart has no data of its own and its marks "
                    "read several tables; give data=, the object given to a mark"
                )
            return read[0]
        found = next(
            (index for index, (source, _) in enumerate(self._tables) if source is binding.data),
            None,
        )
        if found is None or found not in read:
            raise ValueError(
                "SelectionBinding data: expected an object given to one of the chart's marks"
            )
        return found

    def _layout_spec(self) -> dict[str, Any]:
        """The spec's facet, or its panels and grid; nothing for one panel."""
        if self._facet is not None:
            return {"facet": {"field": self._facet, "columns": self._facet_columns}}
        if self._facets:
            return {"facet": {"row": self._facet_row, "column": self._facet_column}}
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
        # Columns row selections' conditions set from Python test, and those
        # of the conditions bindings start with.
        for binding in self._row_selection:
            condition = binding.selection
            if isinstance(condition, RowSelection):
                condition = condition.condition
            tested = sorted(_fields_of(condition._json)) if isinstance(condition, Expr) else []
            if not binding.fields and not tested:
                continue
            index = self._bound_index(binding)
            derived = index in self._derived
            names = self._tables[index][1].names
            for name in binding.fields:
                if derived or name not in names:
                    raise ValueError(
                        f"SelectionBinding fields: no column {name!r} in the data it selects"
                    )
            for name in tested:
                if name not in names:
                    raise ValueError(
                        f"SelectionBinding selection: no column {name!r} in the data it selects"
                    )
            used.setdefault(index, set()).update([*binding.fields, *tested])
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
        """The columns sent, by spec table name; other columns are never sent,
        but a matrix's coordinates always are: they say its shape."""
        used = self._used_fields()
        for table, (source, _) in enumerate(self._tables):
            if isinstance(source, Matrix) and table in used:
                used[table] |= {source.x, source.y}
        return {
            table_name(table): {
                # A point's symbol may name a shape rather than a column.
                field: self._tables[table][1].column(field)
                for field in sorted(fields)
                if field in self._tables[table][1].names
            }
            for table, fields in used.items()
            if table not in self._derived
        }

    def _matrices(self) -> dict[str, dict[str, str]]:
        """The coordinates of the matrix tables sent, by spec table name."""
        return {
            table_name(table): {"x": source.x, "y": source.y}
            for table, (source, _) in enumerate(self._tables)
            if isinstance(source, Matrix)
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
        elif isinstance(data, Matrix):
            self._tables.append((data, data))
        else:
            self._tables.append((data, converted or Table(data)))
        return len(self._tables) - 1

    def _mark_table(self, data: Any) -> int:
        if data is not None:
            return self._table(data)
        if self._default is None:
            raise ValueError("Chart data: the chart has none; pass data to hg.Chart or to the mark")
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
            # Categories come from strings, and times (only a heatmap's date takes
            # nothing else) from datetimes, so the usual fix is the column's type.
            if kinds[0] == "category":
                fix = "; give its values as strings, or make it a categorical column"
            elif kinds[0] == "time":
                fix = "; give datetimes"
            elif kind == "category" and "number" in kinds:
                fix = "; give numbers, not strings"
            else:
                fix = ""
            raise TypeError(
                f"{role}: column {field!r} holds {kind} values; expected {' or '.join(kinds)}{fix}"
            )

    def _mark_tooltip(
        self, table: int, tooltip: Tooltip | None, mark: str
    ) -> dict[str, Any] | None:
        """The spec of a mark's ``tooltip``, its fields checked against its data."""
        if tooltip is None:
            return None
        if not isinstance(tooltip, Tooltip):
            raise TypeError(
                f"{mark} tooltip: expected an hg.Tooltip with fields; received {shown(tooltip)}"
            )
        spec = tooltip._mark_spec(mark)
        for i, entry in enumerate(spec.get("fields", ())):
            field = entry if isinstance(entry, str) else entry["field"]
            self._require(
                table, field, ("number", "time", "category"), f"{mark} tooltip fields[{i}]"
            )
        return spec or None

    def _kind(self, table: int, field: str) -> str | None:
        source = self._tables[table][1]
        return source.column(field).kind if field in source.names else None

    def _single_or_series(self, fields: str | list[str], series: str | None, role: str) -> None:
        if series is not None and not isinstance(fields, str):
            raise ValueError(
                f"{role} series: several value columns or a series column, not both; drop one"
            )

    def _oriented(
        self,
        table: int,
        mark: str,
        x: str | Sequence[str],
        y: str | Sequence[str],
        orient: Orient | None,
    ) -> tuple[Orient, str | list[str], str | list[str]]:
        """Which axis a line or area runs along (``orient``, or y for a
        category y with values on x, as bars lie along a category y), and its
        x and y as the spec writes them, checked: positions are one number,
        time, or category column; values one or several number columns."""
        if orient not in (None, "x", "y"):
            raise ValueError(f'{mark} orient: expected "x" or "y"; received {shown(orient)}')

        def kind(field: str | Sequence[str]) -> str | None:
            return self._kind(table, field) if isinstance(field, str) else None

        along: Orient = orient or ("y" if kind(y) == "category" and kind(x) != "category" else "x")
        position, values = (x, y) if along == "x" else (y, x)
        if not isinstance(position, str):
            if along == "x":
                raise ValueError(
                    f"{mark} x: several columns are values along x of a {mark} along y; "
                    'give orient="y", or one x column'
                )
            raise ValueError(
                f"{mark} y: a {mark} along y has one y column of positions; "
                'give one y column, or orient="x"'
            )
        if orient == "x" and kind(values) == "category":
            raise ValueError(
                f'{mark} orient: "x" makes y the values, and {values!r} holds categories; '
                'give orient="y", or a number column as y'
            )
        across = "y" if along == "x" else "x"
        self._require(table, position, (*_NUMERIC, "category"), f"{mark} {along}")
        spec_values = self._require_many(table, values, _NUMERIC, f"{mark} {across}")
        return (along, position, spec_values) if along == "x" else (along, spec_values, position)

    def _check_dodge(
        self,
        table: int,
        mark: str,
        dodge: bool,
        along: Orient,
        position: Any,
        series: str | None,
    ) -> None:
        """Dodged lines and areas need a category position and a series column."""
        if not isinstance(dodge, bool):
            raise TypeError(f"{mark} dodge: expected True or False; received {shown(dodge)}")
        if not dodge:
            return
        if self._kind(table, position) != "category":
            raise ValueError(
                f"{mark} dodge: places series side by side in the bands of a category {along}; "
                f"give a category column as {along}, or drop dodge"
            )
        if series is None:
            raise ValueError(f"{mark} dodge: places series side by side; give series")

    def _require_many(
        self, table: int, fields: str | Sequence[str], kinds: tuple[str, ...], role: str
    ):
        names = [fields] if isinstance(fields, str) else list(fields)
        for name in names:
            self._require(table, name, kinds, role)
        return names[0] if len(names) == 1 else names

    def _symbol(self, table: int, symbol: str | Mapping[str, str] | None) -> Any:
        """A point's ``symbol`` as the spec writes it: a shape's name, or
        ``{"field": column}`` for a category column."""
        if isinstance(symbol, Mapping):
            if set(symbol) != {"field"} or not isinstance(symbol["field"], str):
                raise ValueError(
                    'point symbol: expected a shape\'s name or {"field": column}; '
                    f"received {shown(dict(symbol))}"
                )
            self._require(table, symbol["field"], ("category",), "point symbol")
            return {"field": symbol["field"]}
        if symbol is None:
            return None
        if symbol in SYMBOLS:
            if self._kind(table, symbol) is not None:
                raise ValueError(
                    f"point symbol: {shown(symbol)} names both a shape and a column; "
                    f'give {{"field": {shown(symbol)}}} to encode the column'
                )
            return symbol
        if self._kind(table, symbol) is None:
            raise ValueError(
                f"point symbol: expected a column or {listed(SYMBOLS)}; received {shown(symbol)}"
            )
        self._require(table, symbol, ("category",), "point symbol")
        return {"field": symbol}

    def _check_category_color(
        self,
        table: int,
        color: str | None,
        colors: Any,
        color_domain: Any,
        color_midpoint: Any,
        mark: str,
    ) -> None:
        """Refuses a ramp's options for a category ``color``, which the theme's
        palette colors value by value."""
        if color is None or self._kind(table, color) != "category":
            return
        if colors is not None or color_domain is not None or color_midpoint is not None:
            raise ValueError(
                f"{mark} colors: {color!r} is a category column, colored by the theme's "
                "palette; drop colors, color_domain, and color_midpoint"
            )

    def _annotation_table(
        self, data: Any, positions: dict[str, Any], label: Any, role: str
    ) -> int | None:
        """The table an annotation reads, when a place or its label is a column."""
        fields = {
            name: field
            for name, value in positions.items()
            if (field := coordinate_field(value)) is not None
        }
        text = label.get("field") if isinstance(label, dict) else None
        if not fields and text is None:
            return None
        table = self._mark_table(data)
        for name, field in fields.items():
            self._require(table, field, _NUMERIC, f"{role} {name}")
        self._require(table, text, ("category", "number"), f"{role} label field")
        return table

    def _add(self, spec: dict[str, Any], table: int | None) -> Chart:
        kinds = [mark["type"] for mark, _ in self._marks]
        layouts = [kind for kind in kinds if kind in _LAYOUT_MARKS]
        # The layers of a map, and of a 3D chart, share their chart with each other only.
        layers = any(
            spec["type"] in group and set(kinds) <= set(group) for group in (_MAP_MARKS, _MARKS_3D)
        )
        method = _method(spec["type"])
        if self._panels:
            self._place_in_panels(spec)
        elif not layers and (layouts or (spec["type"] in _LAYOUT_MARKS and self._marks)):
            kind = layouts[0] if layouts else spec["type"]
            # The layout mark, and a mark that cannot share its chart.
            alone, other = _method(kind), method if layouts else _method(kinds[0])
            if self._facets:
                raise ValueError(
                    f"{alone}: has each facet panel to itself; draw the {other} in another chart"
                )
            if kind in _MAP_MARKS:
                raise ValueError(
                    f"{alone}: shares its chart only with geoshape and geopoint marks; "
                    f"draw the {other} in another chart"
                )
            if kind in _MARKS_3D:
                raise ValueError(
                    f"{alone}: shares its chart only with point_3d, line_3d, and surface marks; "
                    f"draw the {other} in another chart"
                )
            raise ValueError(f"{alone}: has its chart to itself; draw the {other} in another chart")
        if spec.get("axis") not in (None, "left", "right"):
            raise ValueError(
                f'{method} axis: expected "left" or "right"; received {shown(spec["axis"])}'
            )
        if self._facets and on_right_axis(spec):
            check_y_zoom(self._settings, right=True)
        if self._panels:
            panel = spec.get("panel")
            ids = [p.id for p in self._panels]
            if panel is None:
                raise ValueError(
                    f'{method} panel: expected the id of a panel, or "*" for every panel; '
                    "received None"
                )
            if panel != "*" and panel not in ids:
                raise ValueError(
                    f"{method} panel: no panel {shown(panel)}; "
                    f"the chart has {', '.join(map(shown, ids))}"
                )
        elif spec.get("panel") is not None:
            raise ValueError(f"{method} panel: the chart has no panels; drop panel")
        if self._facets and table is not None and spec.get("facet") is None:
            if spec["type"] == "dendrogram":
                raise ValueError(
                    "dendrogram facet: a tree cannot be split across facet panels; "
                    'give facet="repeat" to draw it whole in each'
                )
            for option, field in (
                ("facet", self._facet),
                ("facet_row", self._facet_row),
                ("facet_column", self._facet_column),
            ):
                self._require(table, field, ("category",), f"Chart {option}")
        self._check_categories(spec, table)
        self._marks.append((spec, table))
        return self

    def _place_in_panels(self, spec: dict[str, Any]) -> None:
        """Refuses, as the browser would, a layout mark (a pie) without a panel of
        its own, and marks drawing in a panel a layout mark has to itself."""
        kind, panel = spec["type"], spec.get("panel")
        method = _method(kind)
        held = {
            mark["panel"]: _method(mark["type"])
            for mark, _ in self._marks
            if mark["type"] in _LAYOUT_MARKS
        }
        # Layers of a map or a 3D box can share their panel.
        layer = any(
            kind in group and held.get(panel) in {_method(item) for item in group}
            for group in (_MAP_MARKS, _MARKS_3D)
        )
        if kind not in _LAYOUT_MARKS:
            if panel == "*" and held:
                first = next(iter(held))
                raise ValueError(
                    f'{method} panel: "*" would draw in panel {shown(first)}, which a '
                    f"{held[first]} has to itself; give the id of a panel with axes"
                )
            if panel in held:
                raise ValueError(
                    f"{method} panel: a {held[panel]} has panel {shown(panel)} to itself; "
                    "give the id of a panel with axes"
                )
            return
        if panel is None or panel == "*":
            raise ValueError(
                f"{method} panel: expected the id of the panel it draws in; received {shown(panel)}"
            )
        if panel in held and not layer:
            raise ValueError(
                f"{method} panel: a {held[panel]} has panel {shown(panel)} to itself; "
                f"give the {method} a panel of its own"
            )
        for mark, _ in self._marks:
            other = _method(mark["type"])
            if mark.get("panel") == "*":
                raise ValueError(
                    f'{method} panel: the {other} with panel="*" draws in panel {shown(panel)} '
                    f"too, and a {method} has its panel to itself; give the {other} the id of "
                    "a panel with axes"
                )
            if mark.get("panel") == panel and not layer:
                raise ValueError(
                    f"{method} panel: a {other} draws in panel {shown(panel)}, and a {method} "
                    "has its panel to itself; give one of them another panel"
                )
        own = next((p for p in self._panels if p.id == panel), None)
        if own is not None and (own.x is not None or own.y is not None or own.y_right is not None):
            axis = "x" if own.x is not None else "y" if own.y is not None else "y_right"
            raise ValueError(
                f"Panel {axis}: panel {shown(panel)} draws a {method}, which has no axes; "
                f"drop the panel's {axis}"
            )

    def _check_categories(self, spec: dict[str, Any], table: int | None) -> None:
        """Refuses, as the browser would, what panels with categories of their own
        (an x or y scope other than ``"chart"`` on a category axis) cannot do
        yet: sync, and brush along a y axis of such categories."""
        if table is None or not (self._facets or self._panels):
            return
        kind = spec["type"]
        for axis in ("x", "y"):
            scope = scope_of(self._settings, axis, subplots=bool(self._panels))
            field = spec.get(axis)
            # Calendars band days of the week, and in months days of the month too.
            calendar = kind == "heatmap" and spec.get("date") is not None
            leaf_axis = "y" if spec.get("side") in ("left", "right") else "x"
            banded = (
                (kind == "dendrogram" and axis == leaf_axis)
                or (kind == "heatmap" and spec.get(f"{axis}Banded") is True)
                or (calendar and (axis == "y" or spec.get("calendar") == "months"))
                or (isinstance(field, str) and self._kind(table, field) == "category")
            )
            if scope == "chart" or not banded:
                continue
            if self._settings["sync"] is not None:
                raise ValueError(
                    f"Chart sync: panels with categories of their own ({axis} scope "
                    f'{shown(scope)}) cannot sync yet; drop sync or give {axis} scope "chart"'
                )
            if axis == "y" and self._settings["brush"] not in (None, "x"):
                raise ValueError(
                    "Chart brush: panels with y categories of their own brush along x only; "
                    f"received {shown(self._settings['brush'])}"
                )


#: Marks that lay out their own chart, with no axes.
_LAYOUT_MARKS = (
    *("pie", "treemap", "sunburst", "gauge", "funnel", "radar", "sankey", "graph"),
    *("geoshape", "geopoint", "point3d", "line3d", "surface"),
)

#: Layout marks whose charts select rows (maps too), in panels as well.
_SELECTING_LAYOUT_MARKS = ("pie", "funnel", "treemap", "sunburst", "sankey", "graph")

#: The layers of maps, which share a chart and its projection.
_MAP_MARKS = ("geoshape", "geopoint")

#: The layers of 3D charts, which share a chart, its box, and its camera.
_MARKS_3D = ("point3d", "line3d", "surface")

#: Chart methods whose names differ from the type of the mark they add.
_METHODS = {"errorbar": "error_bar", "point3d": "point_3d", "line3d": "line_3d"}


def _method(kind: str) -> str:
    """The Chart method that adds marks of a spec type, as messages name marks."""
    return _METHODS.get(kind, kind)


def _dropped(option: str) -> str:
    """The keyword to drop for an option as `_x_option` names it."""
    return "seams" if option == "x seams" else option


#: The most nodes and links a graph lays out, as the browser enforces.
MAX_NODES = 50_000
MAX_LINKS = 200_000

#: Each graph layout's options and their choices (None for true or false).
_GRAPH_LAYOUTS: dict[str, dict[str, tuple[str, ...] | None]] = {
    "force": {"settle": None},
    "circular": {"sort": ("degree", "input", "name")},
    "layered": {"direction": ("down", "right", "up", "left")},
}


def _graph_layout(layout: str | Mapping[str, Any] | None) -> str | dict[str, Any] | None:
    """A graph's ``layout`` as the spec takes it, checked with Python's spellings."""
    if layout is None:
        return None
    given: dict[str, Any] = {"type": layout} if isinstance(layout, str) else dict(layout)
    kind = given.get("type", "force") if not isinstance(layout, str) else layout
    if kind not in _GRAPH_LAYOUTS:
        raise ValueError(
            f"graph layout: expected {listed(list(_GRAPH_LAYOUTS))}; received {shown(kind)}"
        )
    for option, value in given.items():
        if option == "type":
            continue
        owner = next((name for name, options in _GRAPH_LAYOUTS.items() if option in options), None)
        if owner is None:
            raise ValueError(f'graph layout["{option}"]: not an option of a {kind} layout; drop it')
        if owner != kind:
            raise ValueError(
                f'graph layout["{option}"]: only a {owner} layout takes it; drop it, '
                f'or use "type": "{owner}"'
            )
        choices = _GRAPH_LAYOUTS[kind][option]
        if choices is None and not isinstance(value, bool):
            raise ValueError(
                f'graph layout["{option}"]: expected True or False; received {value!r}'
            )
        if choices is not None and value not in choices:
            raise ValueError(
                f'graph layout["{option}"]: expected {listed(choices)}; received {shown(value)}'
            )
    return layout if isinstance(layout, str) else {"type": kind, **given}


def remaining_moves(
    positions: Mapping[str, Any],
    marks: Sequence[Mapping[str, Any]],
    tables: Mapping[str, Mapping[str, Column]],
    derived: Mapping[str, Any],
    default: str | None,
) -> dict[str, Any]:
    """Moved network nodes (by item key) without those of nodes their
    network's data no longer has, as the browser lets them go (networks too
    large to draw too). Networks of derived tables, whose rows Python does
    not have, keep theirs: a browser that has drawn the change reports which
    it let go of."""
    found: dict[Any, set[str] | None] = {}

    def nodes_of(mark_id: Any) -> set[str] | None:
        mark = next((m for m in marks if m.get("id") == mark_id), None)
        if mark is None and isinstance(mark_id, int) and 0 <= mark_id < len(marks):
            mark = marks[mark_id]
        if mark is None or mark["type"] != "graph":
            return None
        links, node_table = mark.get("data", default), mark.get("nodes")
        if links is None:
            return None
        if links in derived or node_table in derived:
            return None
        columns = tables[links]
        return network_names(
            columns[mark["source"]],
            columns[mark["target"]],
            columns[mark["value"]] if mark.get("value") is not None else None,
            tables[node_table][mark["node"]] if node_table is not None else None,
        )

    kept: dict[str, Any] = {}
    for key, place in positions.items():
        try:
            mark_id, name = json.loads(key)
        except (ValueError, TypeError):
            mark_id = name = None
        # Keys of another shape name no node, and go, as the browser lets them go.
        if (
            not isinstance(mark_id, (int, str))
            or isinstance(mark_id, bool)
            or not isinstance(name, str)
        ):
            continue
        if mark_id not in found:
            found[mark_id] = nodes_of(mark_id)
        names = found[mark_id]
        if names is None or name in names:
            kept[key] = place
    return kept


def network_nodes(
    source: Column,
    target: Column,
    value: Column | None,
    node: Column | None,
    *,
    directed: bool = False,
) -> tuple[set[str], int]:
    """A network's node names and how many links it draws, as the browser
    finds them: the names in the nodes table and in link rows with both
    ends and (with ``value``) a positive, finite value, and one link per pair
    of different names (either way round, unless ``directed``) whose values
    sum to a finite total."""
    keep = _drawn_rows(source, target, value)
    values = None if value is None else value.values
    # Derived tables have no rows here, and their empty codes are floats.
    a, b = (
        np.asarray(column.dictionary, dtype=object)[column.values[keep].astype(np.intp)]
        for column in (source, target)
    )
    names, ids = np.unique(np.concatenate([a, b]), return_inverse=True)
    starts, ends = ids[: len(a)], ids[len(a) :]
    low = starts if directed else np.minimum(starts, ends)
    high = ends if directed else np.maximum(starts, ends)
    distinct = low != high
    pairs, rows = np.unique((low * len(names) + high)[distinct], return_inverse=True)
    links_count = len(pairs)
    if values is not None:
        # Pairs whose values sum past the largest double are left out, as in the browser.
        with np.errstate(over="ignore"):
            totals = np.bincount(rows, weights=values[keep][distinct], minlength=len(pairs))
        links_count = int(np.count_nonzero(np.isfinite(totals)))
    found = {str(name) for name in names}
    if node is not None:
        found.update(_names(node, node.values >= 0))
    return found, links_count


def network_names(
    source: Column, target: Column, value: Column | None, node: Column | None
) -> set[str]:
    """The node names of `network_nodes`, found from the codes rows use
    rather than from a name per row."""
    keep = _drawn_rows(source, target, value)
    found = _names(source, keep) | _names(target, keep)
    if node is not None:
        found |= _names(node, node.values >= 0)
    return found


def _drawn_rows(source: Column, target: Column, value: Column | None) -> np.ndarray:
    """Link rows the browser draws: with both ends and (with ``value``) a
    positive, finite value."""
    keep = (source.values >= 0) & (target.values >= 0)
    if value is not None:
        keep &= (value.values > 0) & (value.values < math.inf)
    return keep


def _names(column: Column, rows: np.ndarray) -> set[str]:
    """The names a category column gives the rows `rows` selects."""
    codes = np.unique(column.values[rows].astype(np.intp))
    return {str(name) for name in np.asarray(column.dictionary, dtype=object)[codes]}


#: A graph's fields that are columns of its nodes.
_NODE_FIELDS = ("node", "color", "size")


#: Chart options a live chart can change after display: all but data and facets,
#: which decide the columns sent.
OPTIONS = (
    *("title", "description", "width", "height", "x", "y", "y_right", "legend", "padding"),
    *("scales", "guides"),
    "tooltip",
    *("zoom", "brush", "sync", "animation"),
    *("renderer", "theme"),
    *("locale", "time_zone", "projection", "z", "camera", "box_aspect", "rotate", "navigator"),
    "drag",
)


def on_right_axis(spec: Mapping[str, Any]) -> bool:
    """Whether a mark places values on the right y axis: with ``axis="right"``,
    unless it is a rule at an x or a region across an x range, which have no y."""
    if spec.get("axis") != "right":
        return False
    return spec["type"] not in ("rule", "region") or any(
        spec.get(key) is not None for key in ("y", "y1", "y2")
    )


def check_layout_options(
    settings: Mapping[str, Any],
    layouts: Sequence[Mapping[str, Any]],
    subplots: int,
) -> None:
    """Checks what a chart's layout marks (``layouts``, their specs) take of its
    interaction options, as the browser does: in a chart of their own or facet
    panels, each kind its own; among ``subplots`` subplots, what panels with
    axes take beside them, or what they take when no panel has axes. Panels
    without axes have no scales to share."""
    if settings.get("drag") and not any(mark["type"] == "graph" for mark in layouts):
        raise ValueError(
            "Chart drag: moves a network's nodes, and the chart has no graph; drop drag"
        )
    if subplots:
        _check_subplot_ranges(settings)
    # Standalone 3D charts check their options as marks are added.
    if not subplots:
        layouts = [mark for mark in layouts if mark["type"] not in _MARKS_3D]
    if not subplots:
        for kind in dict.fromkeys(mark["type"] for mark in layouts):
            _check_alone(settings, kind)
        if not layouts:
            return
    elif len({mark["panel"] for mark in layouts}) < subplots:
        # Panels with axes zoom and brush along x; maps and networks beside them pan and zoom.
        zoom, brush = settings.get("zoom"), settings.get("brush")
        if zoom == "xy" or brush == "lasso":
            option = "zoom" if zoom == "xy" else "brush"
            raise ValueError(
                f"Chart {option}: panels with axes {option} along x only; "
                f"received {shown(settings[option])}"
            )
        return
    else:
        _check_subplots(settings, layouts)
    # Layout marks have a subplot each, and facet panels draw the same marks.
    scoped = next(
        (
            axis
            for axis in ("x", "y", "y_right")
            if axis_scope(settings, axis) not in (None, "chart")
        ),
        None,
    )
    if scoped is not None:
        raise ValueError(
            f"Chart {scoped} scope: every panel draws a {_method(layouts[0]['type'])} or another "
            f"mark without axes, so the panels have no scales to share; drop {scoped}'s scope"
        )


def _check_subplot_ranges(settings: Mapping[str, Any]) -> None:
    """Subplots zoom and brush along x (maps and networks with every panel
    pan and zoom both ways, and lasso: see `check_layout_options`)."""
    zoom, brush = settings.get("zoom"), settings.get("brush")
    if zoom == "y":
        raise ValueError(
            f"Chart zoom: charts with panels zoom along x only; received {shown(zoom)}"
        )
    if brush in ("y", "xy"):
        raise ValueError(
            f"Chart brush: charts with panels brush along x only; received {shown(brush)}"
        )


def _check_alone(settings: Mapping[str, Any], kind: str) -> None:
    """What a layout mark takes in a chart of its own or its facet panels: a
    treemap or sunburst drills with ``zoom=True``; maps and networks pan and
    zoom both ways (``zoom=True`` or ``"xy"``) and take a ``"lasso"`` brush;
    only a network's nodes drag; nothing syncs or has x seams."""
    zoom, brush = settings.get("zoom"), settings.get("brush")
    if kind in _MAP_MARKS:
        if zoom in ("x", "y"):
            raise ValueError(
                f'Chart zoom: expected True or "xy", as maps zoom both ways; received {shown(zoom)}'
            )
        if brush not in (None, "lasso"):
            raise ValueError(f'Chart brush: expected "lasso" for maps; received {shown(brush)}')
    if settings.get("drag") and kind != "graph":
        raise ValueError(f"Chart drag: moves a network's nodes, and a {kind} has none; drop drag")
    drills = kind in ("treemap", "sunburst")
    if drills and zoom not in (True, False, None):
        raise ValueError(
            f"Chart zoom: a {kind} drills with zoom=True, not along an axis; received {shown(zoom)}"
        )
    if kind == "graph":
        if zoom not in (True, False, None, "xy"):
            raise ValueError(
                f"Chart zoom: a graph pans and zooms both ways, received {shown(zoom)}; "
                "use zoom=True or zoom='xy'"
            )
        if brush not in (None, "lasso"):
            raise ValueError(
                f"Chart brush: a graph takes only a lasso, received {shown(brush)}; "
                "use brush='lasso'"
            )
    used = _x_option(
        settings,
        ("sync",)
        if kind == "graph" or kind in _MAP_MARKS
        else ("brush", "sync")
        if drills
        else ("zoom", "brush", "sync"),
    )
    if used is not None:
        raise ValueError(f"Chart {used}: a {kind} has no x axis to act on; drop {_dropped(used)}")


def _check_subplots(settings: Mapping[str, Any], layouts: Sequence[Mapping[str, Any]]) -> None:
    """What subplots that all draw layout marks, so that no panel has axes,
    take: trees drill with ``zoom=True``; maps and networks pan and zoom both
    ways and take lassos."""
    zoom, brush = settings.get("zoom"), settings.get("brush")
    kinds = {mark["type"] for mark in layouts}
    planes = kinds & {"graph", *_MAP_MARKS}
    takes = {
        "zoom": zoom is True
        and bool(planes or kinds & {"treemap", "sunburst", *_MARKS_3D})
        or (zoom == "xy" and bool(planes)),
        "brush": brush == "lasso" and bool(planes),
    }
    used = _x_option(
        settings, tuple(name for name in ("zoom", "brush", "sync") if not takes.get(name, False))
    )
    if used is not None:
        raise ValueError(
            f"Chart {used}: every panel draws a {_method(layouts[0]['type'])} or another mark "
            f"without axes, so no panel has an x axis; drop {_dropped(used)}"
        )


def _x_option(settings: Mapping[str, Any], options: Sequence[str]) -> str | None:
    """The first of a chart's `options` that is set, or else "x seams" when the x
    axis marks seams: what acts on an x axis, as messages name it."""
    used = next((name for name in options if settings.get(name)), None)
    seams = (spec_options(dict(settings)).get("x") or {}).get("seams")
    return used or ("x seams" if seams not in (None, False) else None)


def check_y_zoom(settings: Mapping[str, Any], *, right: bool, subplots: bool = False) -> None:
    """Refuses, as the browser does, zooming along y in charts whose facet panels
    have y scales of their own (y's scope), or with marks on the right axis
    (``right``), right y scales of their own (y_right's scope): a y zoom moves
    both axes through the same pixels, in every panel. Subplots refuse y zoom
    on their own (see `_check_subplot_ranges`)."""
    if settings["zoom"] not in ("y", "xy") or subplots:
        return
    if scope_of(settings, "y", subplots=False) != "chart":
        raise ValueError(
            "Chart zoom: charts whose panels have y scales of their own (y scope) zoom "
            f"along x only; received {shown(settings['zoom'])}"
        )
    if right and scope_of(settings, "y_right", subplots=False) != "chart":
        raise ValueError(
            "Chart zoom: charts whose panels have right y scales of their own "
            f"(y_right scope) zoom along x only; received {shown(settings['zoom'])}"
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
    # Dragging turns 3D charts unless asked not to.
    if settings.get("rotate") is False:
        interaction["rotate"] = False
    # Dragging moves a network's nodes when asked to.
    if settings.get("drag"):
        interaction["drag"] = True
    options = {
        "title": title_spec(settings["title"], "Chart title", placed=True),
        "description": settings["description"],
        "width": settings["width"],
        "height": settings["height"],
        "x": _axis(settings["x"]),
        "y": _axis(settings["y"], "Chart y"),
        "yRight": _axis(settings["y_right"], "Chart y_right"),
        "legend": legend_spec(settings["legend"]),
        "scales": scales_spec(settings.get("scales")),
        "guides": guides_spec(settings.get("guides")),
        "padding": insets(settings.get("padding"), "Chart padding"),
        "tooltip": tooltip
        if tooltip is None or isinstance(tooltip, bool)
        else tooltip._spec()
        if isinstance(tooltip, Tooltip)
        else {"mode": tooltip},
        "interaction": interaction or None,
        "animation": _animation(animation),
        "renderer": settings["renderer"],
        "theme": theme_spec(settings["theme"]),
        "locale": settings["locale"],
        "timeZone": settings["time_zone"],
        "projection": _projection(settings.get("projection")),
        "z": _axis(settings.get("z"), "Chart z"),
        "camera": _camera(settings.get("camera")),
        "boxAspect": _box_aspect(settings.get("box_aspect")),
        "navigator": _navigator(settings.get("navigator")),
    }
    return {key: value for key, value in options.items() if value is not None}


def assemble_spec(
    options: dict[str, Any],
    layout: dict[str, Any],
    tables: dict[str, dict[str, Column]],
    marks: list[dict[str, Any]],
    derived: dict[str, dict[str, Any]] | None = None,
    matrices: dict[str, dict[str, str]] | None = None,
) -> tuple[dict[str, Any], list[bytes]]:
    """A spec and its buffers from chart options, columns by table name, mark
    specs, derived tables by name, and the coordinates of matrix tables."""
    buffers: list[bytes] = []
    spec: dict[str, Any] = {"version": _SPEC_VERSION, **options}
    for key, value in layout.items():
        spec[key] = (
            {k: v for k, v in value.items() if v is not None} if isinstance(value, dict) else value
        )
    if tables or derived:
        spec["data"] = {
            name: {
                "columns": columns_spec(columns, buffers),
                **({"matrix": matrices[name]} if matrices and name in matrices else {}),
            }
            for name, columns in tables.items()
        }
        spec["data"].update(derived or {})
    # After the columns', so that a selection changes no column's buffer index.
    if "rowSelection" in options:
        spec["rowSelection"] = _selection_buffers(options["rowSelection"], buffers)
    spec["marks"] = marks
    return spec, buffers


def _selection_buffers(rows: Any, buffers: list[bytes]) -> Any:
    """A spec's row selection with the rows its bindings start with (bytes of
    uint32 positions) appended to `buffers`, which they then index."""

    def one(binding: dict[str, Any]) -> dict[str, Any]:
        selection = binding.get("selection")
        if selection is None or not isinstance(selection.get("rows"), bytes):
            return binding
        buffers.append(selection["rows"])
        return {**binding, "selection": {**selection, "rows": len(buffers) - 1}}

    return [one(binding) for binding in rows] if isinstance(rows, list) else one(rows)


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


def _left_along_y(mark: str, along: Orient, axis: str | None) -> None:
    """Lines and areas along y use the left axis, as horizontal bars do."""
    if along == "y" and axis == "right":
        raise ValueError(
            f"{mark} axis: {mark}s along y use the left axis, as horizontal bars do; "
            'drop axis="right"'
        )


def _clip(clip: Clip | None, mark: str) -> Clip | None:
    """A mark's ``clip``: what its drawing is cut to."""
    if not (clip is None or clip is False or clip in ("plot", "chart")):
        raise ValueError(f'{mark} clip: expected "plot", "chart", or False; received {shown(clip)}')
    return clip


def _mark_facet(facet: str | None, mark: str) -> str | None:
    """A mark's ``facet``: None, or ``"repeat"`` to draw all its rows in every
    facet panel instead of splitting them by the facet fields."""
    if facet not in (None, "repeat"):
        raise ValueError(f'{mark} facet: expected "repeat" or None; received {shown(facet)}')
    return facet


def _check_size(radius: float | None, size: str | None, mark: str) -> None:
    """Refuses a radius that is not a positive number of pixels, or a radius
    with a size column."""
    if radius is not None and size is not None:
        raise ValueError(f"{mark} radius: a constant radius or a size column, not both; drop one")
    if radius is not None and not (_finite(radius) and radius > 0):
        raise ValueError(
            f"{mark} radius: expected a positive number of pixels; received {shown(radius)}"
        )


def _check_spokes(spokes: int, option: str, what: str) -> None:
    """Refuses a radar of too few spokes to make a polygon, or too many to read;
    `what` says what makes them, as in "'k' has"."""
    if spokes < 3:
        raise ValueError(f"radar {option}: needs at least 3 spokes; {what} {spokes}")
    if spokes > 100:
        raise ValueError(f"radar {option}: draws at most 100 spokes; {what} {spokes}")


def table_name(index: int) -> str:
    return "data" if index == 0 else f"data{index + 1}"


def _fields(spec: dict[str, Any]) -> set[str]:
    fields: set[str] = set()
    for key in (
        *("x", "y", "x1", "x2", "y1", "y2", "xError", "yError", "series", "value"),
        "weight",
        *("category", "fields", "date"),
        *("path", "node", "parent", "source", "target", "linkLabelField"),
        *("open", "high", "low", "close"),
        *("first", "second", "height"),
        *("q1", "median", "q3", "count"),
        *("size", "fillOpacity", "color", "symbol", "animationKey"),
        *("geometry", "labelField", "longitude", "latitude", "z"),
    ):
        value = spec.get(key)
        if isinstance(value, str):
            fields.add(value)
        elif isinstance(value, list):
            fields.update(value)
        elif isinstance(value, dict) and isinstance(value.get("field"), str):
            fields.add(value["field"])
    # Columns only tooltips show travel too.
    for entry in (spec.get("tooltip") or {}).get("fields", ()):
        fields.add(entry if isinstance(entry, str) else entry["field"])
    fields |= _feature_fields(spec)
    return fields


def _feature_fields(spec: dict[str, Any]) -> set[str]:
    """The columns a mark's encodings, conditions, styles by value, labels,
    and places read."""
    fields: set[str] = set()
    for channel in (spec.get("encode") or {}).values():
        if "field" in channel:
            fields.add(channel["field"])
        elif "condition" in channel:
            fields |= _fields_of(channel["condition"]["when"])
    fields |= _fields_of(spec.get("where"))
    continuity = spec.get("continuity") or {}
    fields |= _fields_of(continuity.get("defined"))
    if isinstance(continuity.get("breakBy"), dict):
        fields.add(continuity["breakBy"]["field"])
    by = (spec.get("style") or {}).get("by") or {}
    if isinstance(by.get("field"), str):
        fields.add(by["field"])
    for key in ("label", "labels"):
        if isinstance(spec.get(key), dict) and isinstance(spec[key].get("field"), str):
            fields.add(spec[key]["field"])
    for place in [*(spec.get("at") or {}).values(), *(spec.get("span") or ())]:
        if isinstance(place, str):
            fields.add(place)
        elif isinstance(place, dict) and isinstance(place.get("field"), str):
            fields.add(place["field"])
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


def _axis(
    axis: AxisOptions | dict[str, Any] | None, role: str = "Chart x"
) -> dict[str, Any] | None:
    """An axis's spec; `role` is where it was given, as "Chart y" or "Panel x"."""
    if axis is None:
        return None
    if isinstance(axis, dict):
        axis = AxisOptions(**axis)
    if role != "Chart x" and axis.breaks is not None:
        raise ValueError(f"{role} breaks: only the chart's x axis takes breaks; drop them")
    if role != "Chart x" and axis.seams is not None:
        raise ValueError(f"{role} seams: only the chart's x axis takes seams; drop them")
    if role == "Chart z" and axis.style is not None:
        raise ValueError("Chart z style: a 3D chart's axes take the theme's styles; drop style")
    if role not in ("Chart x", "Chart y", "Chart y_right") and axis.scope is not None:
        raise ValueError(
            f"{role} scope: only the chart's x, y, and y_right take a scope; move it there"
        )
    return axis._spec() or None


def axis_scope(settings: Mapping[str, Any], axis: str) -> str | None:
    """The scope the chart sets for its ``x``, ``y``, or ``y_right`` scale
    (``axis``), if any: in ``scales``, or else in the axis' options."""
    scales = settings.get("scales")
    for given in (scales.get(axis) if isinstance(scales, Mapping) else None, settings.get(axis)):
        if given is None:
            continue
        scope = given.get("scope") if isinstance(given, Mapping) else getattr(given, "scope", None)
        if isinstance(scope, str):
            return scope
    return None


def scope_of(settings: Mapping[str, Any], axis: str, *, subplots: bool) -> str:
    """Which panels share the chart's ``x``, ``y``, or ``y_right`` scale: its
    own scope, or by default the whole chart for x, each subplot's own or the
    whole chart in facets for y, and y's for y_right."""
    if axis == "x":
        return axis_scope(settings, "x") or "chart"
    y = axis_scope(settings, "y") or ("panel" if subplots else "chart")
    return y if axis == "y" else axis_scope(settings, "y_right") or y


def _projection(projection: Any) -> Any:
    """A projection's spec from a name, a Projection, or a dict of its fields."""
    if projection is None:
        return None
    if isinstance(projection, str):
        projection = Projection(projection)  # type: ignore[arg-type]
    elif isinstance(projection, dict):
        projection = Projection(**projection)
    return projection._spec()


def _animation(animation: Any) -> bool | dict[str, Any] | None:
    """The spec's animation: True, a duration, or Animation's options; None when off."""
    if animation is None or isinstance(animation, bool):
        return animation or None
    if isinstance(animation, Animation):
        return animation._spec()
    if not (_finite(animation) and animation >= 0):
        raise ValueError(
            "Chart animation: expected True, False, milliseconds of at least 0, or an "
            f"hg.Animation; received {shown(animation)}"
        )
    return {"duration": animation}


def _navigator(navigator: Any) -> bool | dict[str, Any] | None:
    """The spec's navigator: True, or a Navigator's options; None when off."""
    if navigator is None or navigator is False:
        return None
    if navigator is True:
        return True
    if isinstance(navigator, dict):
        navigator = Navigator(**navigator)
    if not isinstance(navigator, Navigator):
        raise TypeError(
            "Chart navigator: expected True, False, an hg.Navigator, or a dict of its fields; "
            f"received {shown(navigator)}"
        )
    return navigator._spec() or True


def _camera(
    camera: Any, name: str = "Chart camera", *, partial: bool = False
) -> dict[str, Any] | None:
    """A camera's spec from a Camera or a dict of its fields."""
    if camera is None:
        return None
    given = set(camera) if partial and isinstance(camera, dict) else None
    if isinstance(camera, dict):
        camera = Camera(**camera)
    if not isinstance(camera, Camera):
        raise TypeError(
            f"{name}: expected an hg.Camera or a dict of its fields; received {shown(camera)}"
        )
    spec = camera._spec()
    return (
        {key: value for key, value in spec.items() if key in given} if given is not None else spec
    )


def _box_aspect(aspect: Any) -> list[float] | None:
    if aspect is None:
        return None
    try:
        sides = [float(side) for side in aspect]
    except (TypeError, ValueError):
        sides = []
    if len(sides) != 3 or not all(0 < side < math.inf for side in sides):
        raise ValueError(
            f"Chart box_aspect: expected three positive lengths; received {shown(aspect)}"
        )
    return sides


def _matrix_of(values: Any, x: Any, y: Any, name: str, mark: str) -> Matrix:
    """A 2D array of values as a matrix: row i, column j at ``y[i]``, ``x[j]``
    (positions 0, 1, 2, ... without them), in columns "x", "y", and `name`."""
    grid = np.asarray(values, dtype=np.float64)
    if grid.ndim != 2:
        raise ValueError(f"{mark} {name}: expected a 2D matrix; received shape {grid.shape}")
    rows, columns = grid.shape

    def positions(given: Any, count: int, axis: str) -> Any:
        if given is None:
            return np.arange(count, dtype=np.float64)
        if isinstance(given, str):
            raise TypeError(
                f"{mark} {axis}: expected positions along the {name} matrix; "
                f"received the column name {shown(given)}"
            )
        array = np.asarray(given)
        if array.ndim != 1 or len(array) != count:
            side = "column" if axis == "x" else "row"
            received = len(array) if array.ndim == 1 else f"an array of shape {array.shape}"
            raise ValueError(
                f"{mark} {axis}: expected {count} values, one per matrix {side}; "
                f"received {received}"
            )
        return given

    return Matrix(
        {"x": positions(x, columns, "x"), "y": positions(y, rows, "y"), name: grid},
        x="x",
        y="y",
    )


def matrix(columns: Mapping[str, Any], *, x: str, y: str) -> Matrix:
    """A matrix data source: values at every ``x`` crossed with every ``y``.

    ``columns`` maps names to arrays, as ``hg.Chart`` takes them: the
    columns named by ``x`` and ``y`` hold the coordinates (one per column of
    the matrix, and one per row), and every other column a value at each
    pair, as a 2D array of shape (len(y), len(x)), row ``i`` and column
    ``j`` at ``y[i]`` and ``x[j]``, or flattened in that order. It reads as
    a table of a row per pair; contours and heatmaps draw it, and its
    coordinates travel once each rather than once per row::

        density = hg.matrix({"x": xs, "y": ys, "density": grid}, x="x", y="y")
        hg.Chart(density).contour("x", "y", "density", variant="bands")
    """
    return Matrix(columns, x, y)


def _geometry_column(source: Any, columns: Any) -> str:
    """The column of shapes when a geoshape names none: "geometry", or a GeoDataFrame's."""
    active = getattr(source, "_geometry_column_name", None)
    for name in ("geometry", active):
        if name is not None and name in columns.names:
            return name
    raise ValueError(
        'geoshape geometry: the data has no "geometry" column; name the column holding the shapes'
    )


class _JoinedShapes:
    """A GeoJSON collection's features, with the values of the rows naming them,
    as Plotly's ``locations`` and ``featureidkey`` join them: a row per feature,
    with missing values where no row names it. Live charts join new rows the
    same way (``rejoin``)."""

    def __init__(self, chart: Chart, table: int, geojson: Any, locations: str, key: str) -> None:
        if table in chart._derived:
            raise ValueError(
                "geoshape data: joins the rows of a table to the shapes, and a derived table's "
                "rows are computed in the browser; join before deriving"
            )
        interface = getattr(geojson, "__geo_interface__", geojson)
        if not _geo.is_feature_collection(interface):
            raise TypeError(
                "geoshape geojson: expected a GeoJSON FeatureCollection; "
                f"received {type(geojson).__name__}"
            )
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
                f"geoshape locations: column {self._locations!r} holds {located.kind} values; "
                "expected category or number"
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
                    f"geoshape locations: {shown(text)} names a feature twice; "
                    "aggregate the rows to one per feature"
                )
            row_of[text] = row
        keys = self._keys
        rows = np.array([-1 if k is None else row_of.get(k, -1) for k in keys], dtype=np.intp)
        if values and not (rows >= 0).any():
            raise ValueError(
                f"geoshape locations: no value of {self._locations!r} matches a feature's "
                f"{self._key} (features: {keys[:3]!r}; rows: "
                f"{[_geo.key_text(v) for v in values[:3]]!r}); check feature_id_key"
            )
        if "geometry" in source.names:
            raise ValueError(
                'geoshape data: has a column named "geometry", as the joined shapes are; rename it'
            )
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


def _colors(colors: str | Sequence[str] | None, role: str) -> str | list[str] | None:
    """A scheme name, checked, or a list of colors."""
    if isinstance(colors, str):
        if colors not in SCHEMES:
            raise ValueError(
                f"{role}: unknown scheme {shown(colors)}; name one of {listed(SCHEMES)}"
            )
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
        raise ValueError(
            f"{role}: expected two finite numbers, ascending{bound}; received {values!r}"
        )
    return [low, high]


def _panel_weights(
    weights: Sequence[float] | None, option: str, panels: list[Panel], count: int, noun: str
) -> list[float] | None:
    """Relative row heights or column widths of a grid of panels, checked."""
    if weights is None:
        return None
    if not panels:
        raise ValueError(f"Chart {option}: lays out panels, and the chart has none")
    if len(weights) != count:
        raise ValueError(f"Chart {option}: expected {count} {noun}; received {len(weights)}")
    if not all(isinstance(w, numbers.Real) and not isinstance(w, bool) for w in weights):
        raise ValueError(f"Chart {option}: expected positive numbers; received {weights!r}")
    # NumPy numbers and fractions become floats, which JSON can carry.
    values = [float(w) for w in weights]
    if not all(0 < w < math.inf for w in values):
        raise ValueError(f"Chart {option}: expected positive numbers; received {weights!r}")
    return values


def _mark_legend(legend: Any, mark: str) -> Literal[False] | None:
    """A mark's ``legend``: ``False`` leaves it out of the chart's legends."""
    if legend is not None and legend is not False:
        raise ValueError(
            f"{mark} legend: expected False, which leaves the mark out of the legends; "
            f"received {shown(legend)}"
        )
    return legend


def _legend_group(group: str | None, mark: str) -> str | None:
    """A mark's legend group: a name, which marks sharing it share series by."""
    if group is not None and not (isinstance(group, str) and group):
        raise ValueError(f"{mark} legend_group: expected a name; received {shown(group)}")
    return group


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
                raise ValueError(
                    f"gauge bands: expected numbers or (to, color) pairs; received {shown(band)}"
                )
            to, color = band
        else:
            to, color = band, None
        if not (_finite(to) and low < to <= high):
            raise ValueError(
                f"gauge bands: expected ends above min ({low:g}) and at most max ({high:g}); "
                f"received {shown(to)}"
            )
        if not to > previous:
            raise ValueError(
                f"gauge bands: expected ends in ascending order; received {to:g} after {previous:g}"
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
        raise ValueError(
            f"{role} color_midpoint: expected a finite number; received {shown(midpoint)}"
        )
    if domain is not None and not domain[0] <= midpoint <= domain[1]:
        raise ValueError(
            f"{role} color_midpoint: expected a value inside color_domain {domain!r}; "
            f"received {midpoint!r}"
        )
    return float(midpoint)


def _flag(value: Any, role: str) -> bool | None:
    if value is not None and not isinstance(value, bool):
        raise TypeError(f"{role}: expected True or False; received {shown(value)}")
    return value


# Express-style helpers: one call, one chart -----------------------------------

#: Names other libraries give options herceg names otherwise (Plotly
#: Express, Seaborn, matplotlib), and the options a helper may take instead.
_ELSEWHERE: dict[str, tuple[str, ...]] = {
    "alpha": ("opacity", "fill_opacity"),
    "linewidth": ("stroke_width",),
    "lw": ("stroke_width",),
    "linestyle": ("dash",),
    "ls": ("dash",),
    "marker": ("symbol", "markers"),
    "markersize": ("radius", "size"),
    "ms": ("radius", "size"),
    "c": ("color", "stroke", "fill"),
    "edgecolor": ("stroke",),
    "facecolor": ("fill",),
    "label": ("name",),
    "cmap": ("colors",),
    "vmin": ("color_domain",),
    "vmax": ("color_domain",),
    "color": ("series", "stroke", "fill"),
    "colour": ("color", "series", "stroke", "fill"),
    "hue": ("series",),
    "hue_order": ("series_order",),
    "row": ("facet_row",),
    "col": ("facet_column",),
    "facet_col": ("facet_column",),
    "col_wrap": ("facet_columns",),
    "facet_col_wrap": ("facet_columns",),
    "template": ("theme",),
    "labels": ("x_axis", "y_axis"),
    # Seaborn's statistical options herceg names as its marks do.
    "weights": ("weight",),
    "stat": ("normalize",),
    "whis": ("whiskers",),
    "showfliers": ("outliers",),
    "k_depth": ("depth",),
    "outlier_prop": ("outlier_proportion",),
    "fill": ("filled",),
    "err_style": ("error_style",),
    "kde_kws": ("kde_options",),
    "gridsize": ("grid_size",),
}


def helper(function: Callable[_P, _R]) -> Callable[_P, _R]:
    """Makes a one-call helper (``hg.line``, ``hx.barplot``, ...) refuse
    keyword arguments it does not take by its own name, suggesting those it
    does: otherwise Python's error would name ``Chart.__init__``, which the
    helper passes its chart options to."""
    known = _own_options(function) | HelperOptions.__optional_keys__
    express = function.__module__.startswith("herceg.express")
    rows = not express and function.__name__ in _ROW_HELPERS

    @functools.wraps(function)
    def checked(*args: _P.args, **kwargs: _P.kwargs) -> _R:
        for name in kwargs:
            if name not in known:
                raise TypeError(_unknown_option(function, name, known))
        tooltip = kwargs.get("tooltip")
        if not rows and isinstance(tooltip, Tooltip) and tooltip.fields is not None:
            raise ValueError(
                f"{function.__name__} tooltip fields: "
                + (
                    "express charts draw tables they compute, without the data's other "
                    "columns; draw the chart with hg.Chart and give fields to its marks"
                    if express
                    else "its points summarize rows, so they have no row's fields to show; "
                    "drop fields"
                )
            )
        return function(*args, **kwargs)

    return checked


#: Helpers whose mark's points are rows of the data, which tooltip fields read.
_ROW_HELPERS = frozenset(
    ("line", "area", "bar", "scatter", "scatter_3d", "line_3d", "heatmap")
    + ("choropleth", "scatter_geo", "candlestick")
)


def _unknown_option(function: Callable[..., Any], name: str, known: set[str]) -> str:
    method = function.__qualname__.startswith("Chart.")
    constructor = method and function.__name__ == "__init__"
    location = "Chart" if constructor else function.__name__
    where = "herceg.express" if function.__module__.startswith("herceg.express") else "herceg"
    help_name = "Chart" if constructor else function.__qualname__ if method else location
    suggested = [option for option in _ELSEWHERE.get(name, ()) if option in known]
    if name in ("markersize", "ms") and "radius" in suggested:
        suggested = ["radius"]
    # A known foreign option with no equivalent must not get an unrelated fuzzy match.
    if name not in _ELSEWHERE:
        suggested += difflib.get_close_matches(name, sorted(known), n=1, cutoff=0.7)
    hint = (
        f"did you mean {' or '.join(repr(option) for option in suggested)}?"
        if suggested
        else f"see help({where}.{help_name}) for the options it takes"
    )
    if name == "zorder":
        hint = "marks draw in the order given; add the mark later to draw it on top"
    elif name == "density" and "normalize" in known:
        hint = 'did you mean normalize="density"?'
    elif name in ("xlim", "ylim"):
        axis = name[0]
        if constructor:
            hint = f"did you mean {axis}=hg.AxisOptions(domain=...)?"
        elif f"{axis}_axis" in known:
            hint = f"did you mean {axis}_axis=hg.AxisOptions(domain=...)?"
        elif method:
            hint = f"set the chart's domain with hg.Chart({axis}=hg.AxisOptions(domain=...))"
    return f"{location}: no option {name!r}; {hint}"


def _rows_chart_of(data: Any, options: HelperOptions) -> tuple[Chart, Tooltip | None]:
    """The chart of a helper whose mark's points are rows, and the mark's
    tooltip: the ``fields`` of the helper's ``tooltip``, which are the mark's."""
    tooltip = options.get("tooltip")
    if not (isinstance(tooltip, Tooltip) and tooltip.fields is not None):
        return _chart_of(data, options), None
    # The chart keeps the rest, or its default tooltip without any.
    rest = tooltip.mode is not None or tooltip.axis_labels
    shared = Tooltip(mode=tooltip.mode, axis_labels=tooltip.axis_labels) if rest else None
    chart = _chart_of(data, {**options, "tooltip": shared})
    return chart, Tooltip(fields=tooltip.fields)


def _chart_of(data: Any, options: HelperOptions) -> Chart:
    """A helper's chart: its ``x_axis``, ``y_axis``, and ``z_axis`` are the chart's
    ``x``, ``y``, and ``z``."""
    settings: dict[str, Any] = dict(options)
    for axis in ("x", "y", "z"):
        if f"{axis}_axis" in settings:
            settings[axis] = settings.pop(f"{axis}_axis")
    return Chart(data, **settings)


@helper
def line(
    data: Any,
    x: str | Sequence[str],
    y: str | Sequence[str],
    *,
    orient: Orient | None = None,
    series: str | None = None,
    dodge: bool = False,
    color: str | None = None,
    stroke: str | None = None,
    stroke_width: float | None = None,
    dash: Dash | None = None,
    opacity: float | None = None,
    stroke_opacity: float | None = None,
    encode: Encodings | Mapping[str, Any] | None = None,
    style: MarkStyle | Mapping[str, Any] | None = None,
    markers: bool | str | None = None,
    continuity: Continuity | Mapping[str, Any] | None = None,
    where: Expr | None = None,
    curve: Curve | None = None,
    label: str | None = None,
    legend_group: str | None = None,
    axis: Literal["left", "right"] | None = None,
    panel: str | None = None,
    clip: Clip | None = None,
    id: str | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """A line chart, along x, or along y with ``orient="y"`` (see ``Chart.line``).
    Remaining keyword arguments are chart options (``HelperOptions``)."""
    chart, tooltip = _rows_chart_of(data, options)
    return chart.line(
        x,
        y,
        orient=orient,
        series=series,
        dodge=dodge,
        color=color,
        stroke=stroke,
        stroke_width=stroke_width,
        dash=dash,
        opacity=opacity,
        stroke_opacity=stroke_opacity,
        encode=encode,
        style=style,
        markers=markers,
        continuity=continuity,
        where=where,
        curve=curve,
        label=label,
        legend_group=legend_group,
        axis=axis,
        panel=panel,
        clip=clip,
        tooltip=tooltip,
        id=id,
    )


@helper
def area(
    data: Any,
    x: str | Sequence[str] | None = None,
    y: str | Sequence[str] | None = None,
    *,
    y1: str | None = None,
    y2: str | None = None,
    x1: str | None = None,
    x2: str | None = None,
    orient: Orient | None = None,
    series: str | None = None,
    stack: AreaStack = False,
    dodge: bool = False,
    color: str | None = None,
    fill: str | None = None,
    fill_opacity: float | None = None,
    line: bool | None = None,
    stroke: str | None = None,
    stroke_width: float | None = None,
    opacity: float | None = None,
    stroke_opacity: float | None = None,
    encode: Encodings | Mapping[str, Any] | None = None,
    style: MarkStyle | Mapping[str, Any] | None = None,
    continuity: Continuity | Mapping[str, Any] | None = None,
    where: Expr | None = None,
    curve: Curve | None = None,
    label: str | None = None,
    legend_group: str | None = None,
    axis: Literal["left", "right"] | None = None,
    panel: str | None = None,
    clip: Clip | None = None,
    id: str | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """An area chart, stacked with ``True``, ``"fill"``, ``"center"``,
    ``"wiggle"``, or an ``hg.Stack``, or the band between ``y1`` and ``y2``
    (along y, ``x1`` and ``x2``; see ``Chart.area``).

    Stacked by a ``series`` column, every series is drawn on every position
    any of them has: ``hg.Stack(gaps=...)`` says what a series counts as
    where it has no row, ``"zero"`` (the default) or ``"interpolate"``.
    """
    chart, tooltip = _rows_chart_of(data, options)
    return chart.area(
        x,
        y,
        y1=y1,
        y2=y2,
        x1=x1,
        x2=x2,
        orient=orient,
        series=series,
        stack=stack,
        dodge=dodge,
        color=color,
        fill=fill,
        fill_opacity=fill_opacity,
        line=line,
        stroke=stroke,
        stroke_width=stroke_width,
        opacity=opacity,
        stroke_opacity=stroke_opacity,
        encode=encode,
        style=style,
        continuity=continuity,
        where=where,
        curve=curve,
        label=label,
        legend_group=legend_group,
        axis=axis,
        panel=panel,
        clip=clip,
        tooltip=tooltip,
        id=id,
    )


@helper
def bar(
    data: Any,
    x: str | Sequence[str],
    y: str | Sequence[str],
    *,
    series: str | None = None,
    stack: BarStack = False,
    dodge: bool | None = None,
    color: str | None = None,
    fill: str | None = None,
    fill_opacity: float | None = None,
    stroke: str | None = None,
    stroke_width: float | None = None,
    stroke_opacity: float | None = None,
    dash: Dash | None = None,
    opacity: float | None = None,
    encode: Encodings | Mapping[str, Any] | None = None,
    style: MarkStyle | Mapping[str, Any] | None = None,
    label: str | None = None,
    legend_group: str | None = None,
    labels: bool | BarLabels | Mapping[str, Any] = False,
    axis: Literal["left", "right"] | None = None,
    panel: str | None = None,
    clip: Clip | None = None,
    halo: HaloOption | None = None,
    id: str | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """A bar chart: series side by side (overlapping with ``dodge=False``) or
    stacked; horizontal when ``y`` is a category (see ``Chart.bar``)."""
    chart, tooltip = _rows_chart_of(data, options)
    return chart.bar(
        x,
        y,
        series=series,
        stack=stack,
        dodge=dodge,
        color=color,
        fill=fill,
        fill_opacity=fill_opacity,
        stroke=stroke,
        stroke_width=stroke_width,
        stroke_opacity=stroke_opacity,
        dash=dash,
        opacity=opacity,
        encode=encode,
        style=style,
        label=label,
        legend_group=legend_group,
        labels=labels,
        axis=axis,
        panel=panel,
        clip=clip,
        tooltip=tooltip,
        halo=halo,
        id=id,
    )


@helper
def scatter(
    data: Any,
    x: str,
    y: str,
    *,
    series: str | None = None,
    animation_key: str | None = None,
    radius: float | None = None,
    size: str | None = None,
    radius_range: tuple[float, float] | None = None,
    fill: str | None = None,
    fill_opacity: float | str | None = None,
    stroke: str | None = None,
    stroke_width: float | None = None,
    color: str | None = None,
    colors: str | Sequence[str] | None = None,
    color_domain: tuple[float, float] | None = None,
    color_midpoint: float | None = None,
    symbol: str | Mapping[str, str] | None = None,
    sampling: Literal["none", "pixel"] | None = None,
    dodge: bool = False,
    jitter: float | Jitter | None = None,
    swarm: bool = False,
    label: str | None = None,
    legend_group: str | None = None,
    axis: Literal["left", "right"] | None = None,
    panel: str | None = None,
    clip: Clip | None = None,
    id: str | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """A scatter plot; ``size``, ``color``, and ``symbol`` can encode columns
    (see ``Chart.point``)."""
    chart, tooltip = _rows_chart_of(data, options)
    return chart.point(
        x,
        y,
        series=series,
        animation_key=animation_key,
        radius=radius,
        size=size,
        radius_range=radius_range,
        fill=fill,
        fill_opacity=fill_opacity,
        stroke=stroke,
        stroke_width=stroke_width,
        color=color,
        colors=colors,
        color_domain=color_domain,
        color_midpoint=color_midpoint,
        symbol=symbol,
        sampling=sampling,
        dodge=dodge,
        jitter=jitter,
        swarm=swarm,
        label=label,
        legend_group=legend_group,
        axis=axis,
        panel=panel,
        clip=clip,
        tooltip=tooltip,
        id=id,
    )


@helper
def scatter_3d(
    data: Any,
    x: str,
    y: str,
    z: str,
    *,
    series: str | None = None,
    label_field: str | None = None,
    radius: float | None = None,
    color: str | None = None,
    colors: str | Sequence[str] | None = None,
    color_domain: tuple[float, float] | None = None,
    color_midpoint: float | None = None,
    fill: str | None = None,
    fill_opacity: float | None = None,
    label: str | None = None,
    panel: str | None = None,
    id: str | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """A 3D scatter plot (see ``Chart.point_3d``). Remaining keyword arguments
    are chart options (``HelperOptions``), such as ``camera``; ``z_axis`` is
    the chart's ``z``."""
    chart, tooltip = _rows_chart_of(data, options)
    return chart.point_3d(
        x,
        y,
        z,
        series=series,
        label_field=label_field,
        radius=radius,
        color=color,
        colors=colors,
        color_domain=color_domain,
        color_midpoint=color_midpoint,
        fill=fill,
        fill_opacity=fill_opacity,
        label=label,
        tooltip=tooltip,
        panel=panel,
        id=id,
    )


@helper
def line_3d(
    data: Any,
    x: str,
    y: str,
    z: str,
    *,
    series: str | None = None,
    stroke: str | None = None,
    stroke_width: float | None = None,
    label: str | None = None,
    panel: str | None = None,
    id: str | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """Lines in 3D (see ``Chart.line_3d``): each ``series`` category's rows, in
    order, are one path. Remaining keyword arguments are chart options
    (``HelperOptions``), such as ``camera``; ``z_axis`` is the chart's ``z``::

        hg.line_3d(df, x="east", y="north", z="altitude", series="flight")
    """
    chart, tooltip = _rows_chart_of(data, options)
    return chart.line_3d(
        x,
        y,
        z,
        series=series,
        stroke=stroke,
        stroke_width=stroke_width,
        label=label,
        tooltip=tooltip,
        panel=panel,
        id=id,
    )


@helper
def surface(
    data: Any = None,
    x: Any = None,
    y: Any = None,
    z: Any = None,
    *,
    color: str | None = None,
    colors: str | Sequence[str] | None = None,
    color_domain: tuple[float, float] | None = None,
    color_midpoint: float | None = None,
    fill_opacity: float | None = None,
    shading: bool | None = None,
    wireframe: bool | None = None,
    label: str | None = None,
    panel: str | None = None,
    id: str | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """A 3D surface from a grid of rows or a matrix (see ``Chart.surface``).
    Remaining keyword arguments are chart options (``HelperOptions``);
    ``z_axis`` is the chart's ``z``::

        hg.surface(df, x="east", y="north", z="height")
        hg.surface(z=heights, x=eastings, y=northings)
    """
    return _chart_of(data, options).surface(
        x,
        y,
        z,
        color=color,
        colors=colors,
        color_domain=color_domain,
        color_midpoint=color_midpoint,
        fill_opacity=fill_opacity,
        shading=shading,
        wireframe=wireframe,
        label=label,
        panel=panel,
        id=id,
    )


@helper
def heatmap(
    data: Any = None,
    x: Any = None,
    y: Any = None,
    color: Any = None,
    *,
    x1: str | None = None,
    x2: str | None = None,
    y1: str | None = None,
    y2: str | None = None,
    date: str | None = None,
    calendar: Literal["weeks", "months"] | None = None,
    week_start: Literal["mon", "tue", "wed", "thu", "fri", "sat", "sun"] | None = None,
    colors: str | Sequence[str] | None = None,
    color_domain: tuple[float, float] | None = None,
    color_midpoint: float | None = None,
    reduce: CellReduce | None = None,
    sampling: HeatmapSampling | None = None,
    x_step: float | None = None,
    y_step: float | None = None,
    x_banded: bool = False,
    y_banded: bool = False,
    label: str | None = None,
    panel: str | None = None,
    clip: Clip | None = None,
    id: str | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """A heatmap of columns of ``data``, or with a 2D array ``color``, of the matrix (see
    ``Chart.heatmap``); ``colors`` is a scheme name or a list of hex colors."""
    chart, tooltip = _rows_chart_of(data, options)
    return chart.heatmap(
        x,
        y,
        color,
        date=date,
        calendar=calendar,
        week_start=week_start,
        colors=colors,
        color_domain=color_domain,
        color_midpoint=color_midpoint,
        reduce=reduce,
        sampling=sampling,
        x1=x1,
        x2=x2,
        y1=y1,
        y2=y2,
        x_step=x_step,
        y_step=y_step,
        x_banded=x_banded,
        y_banded=y_banded,
        label=label,
        panel=panel,
        clip=clip,
        tooltip=tooltip,
        id=id,
    )


@helper
def contour(
    data: Any = None,
    x: Any = None,
    y: Any = None,
    color: Any = None,
    *,
    thresholds: int | Sequence[float] | np.ndarray[Any, Any] | None = None,
    variant: Literal["lines", "bands"] | None = None,
    colors: str | Sequence[str] | None = None,
    color_domain: tuple[float, float] | None = None,
    color_midpoint: float | None = None,
    stroke: str | None = None,
    stroke_width: float | None = None,
    fill_opacity: float | None = None,
    label: str | None = None,
    panel: str | None = None,
    clip: Clip | None = None,
    id: str | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """Contours of a field on a grid (see ``Chart.contour``): of columns of
    ``data``, or with a 2D array ``color``, of the matrix, at ``x`` and ``y``."""
    return _chart_of(data, options).contour(
        x,
        y,
        color,
        thresholds=thresholds,
        variant=variant,
        colors=colors,
        color_domain=color_domain,
        color_midpoint=color_midpoint,
        stroke=stroke,
        stroke_width=stroke_width,
        fill_opacity=fill_opacity,
        label=label,
        panel=panel,
        clip=clip,
        id=id,
    )


def _thresholds(thresholds: Any, bands: bool) -> int | list[float] | None:
    """A contour's thresholds as the spec takes them: a count, or increasing values."""
    if thresholds is None:
        return None
    if isinstance(thresholds, numbers.Real) and not isinstance(thresholds, (bool, np.bool_)):
        count = float(thresholds) if _finite(thresholds) else math.nan
        if not (count.is_integer() and 1 <= count <= 1000):
            raise ValueError(
                "contour thresholds: expected a whole number from 1 to 1000, or values; "
                f"received {shown(thresholds)}"
            )
        return int(count)
    if not isinstance(thresholds, (Sequence, np.ndarray)) or isinstance(thresholds, (str, bytes)):
        raise ValueError(
            "contour thresholds: expected a count or a list of values; "
            f"received {shown(thresholds)}"
        )
    least = 2 if bands else 1
    if not least <= len(thresholds) <= 1000:
        raise ValueError(
            f"contour thresholds: expected {least} to 1000 values"
            + (", a band between each two" if bands else "")
            + f"; received {len(thresholds)}"
        )
    values: list[float] = []
    for i, value in enumerate(thresholds):
        if not _finite(value):
            raise ValueError(
                f"contour thresholds[{i}]: expected a finite number; received {shown(value)}"
            )
        if values and not float(value) > values[-1]:
            raise ValueError(
                f"contour thresholds[{i}]: expected a value above {values[-1]:g}, the one "
                f"before; received {float(value):g}"
            )
        values.append(float(value))
    return values


def _sampling(sampling: Any) -> dict[str, str] | None:
    """A heatmap's sampling as the spec takes it: ``{"reduce": "mean" | "max" | "min"}``."""
    if sampling is None:
        return None
    if not isinstance(sampling, Mapping) or set(sampling) - {"reduce"}:
        raise ValueError(
            'heatmap sampling: expected {"reduce": "mean", "max", or "min"}; '
            f"received {shown(sampling)}"
        )
    reduce = sampling.get("reduce")
    if reduce not in (None, "mean", "max", "min"):
        raise ValueError(
            f'heatmap sampling reduce: expected "mean", "max", or "min"; received {shown(reduce)}'
        )
    return {"reduce": reduce} if reduce is not None else {}


def _bins_2d(bins: Any) -> Any:
    """A 2D histogram's bins: one definition for both axes, or ``{"x": ..., "y": ...}``."""
    if bins is None:
        return None
    if isinstance(bins, Mapping) and "step" not in bins:
        unknown = set(bins) - {"x", "y"}
        if unknown:
            raise ValueError(
                "histogram bins: a 2D histogram's bins are one definition or "
                f'{{"x": ..., "y": ...}}; received {", ".join(map(repr, sorted(unknown)))}'
            )
        # Axes left out take their default bins; with neither, so do both.
        each = {
            axis: bin_spec(bins[axis], f"histogram bins[{axis!r}]")
            for axis in ("x", "y")
            if bins.get(axis) is not None
        }
        return each or None
    return bin_spec(bins, "histogram bins")


@helper
def histogram(
    data: Any,
    x: str | None = None,
    *,
    y: str | None = None,
    bins: BinSpec | Mapping[str, BinSpec] | None = None,
    series: str | None = None,
    weight: str | None = None,
    normalize: HistogramNormalize | None = None,
    common_norm: bool = False,
    cumulative: bool = False,
    dodge: bool = False,
    stack: bool | Literal["fill"] = False,
    element: HistogramElement | None = None,
    fill: str | None = None,
    fill_opacity: float | None = None,
    colors: str | Sequence[str] | None = None,
    color_domain: tuple[float, float] | None = None,
    color_midpoint: float | None = None,
    label: str | None = None,
    legend_group: str | None = None,
    axis: Literal["left", "right"] | None = None,
    panel: str | None = None,
    clip: Clip | None = None,
    id: str | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """A histogram of ``x`` or ``y``, or with both a 2D histogram's cells (see
    ``Chart.histogram``)."""
    return _chart_of(data, options).histogram(
        x,
        y=y,
        bins=bins,
        series=series,
        weight=weight,
        normalize=normalize,
        common_norm=common_norm,
        cumulative=cumulative,
        dodge=dodge,
        stack=stack,
        element=element,
        fill=fill,
        fill_opacity=fill_opacity,
        colors=colors,
        color_domain=color_domain,
        color_midpoint=color_midpoint,
        label=label,
        legend_group=legend_group,
        axis=axis,
        panel=panel,
        clip=clip,
        id=id,
    )


@helper
def pie(
    data: Any,
    category: str,
    value: str | None = None,
    *,
    inner_radius: float | None = None,
    sort: Literal["value", "input"] | None = None,
    labels: bool | None = None,
    panel: str | None = None,
    id: str | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """A pie, or with ``inner_radius`` a donut, of ``value`` per ``category``."""
    return _chart_of(data, options).pie(
        category,
        value,
        inner_radius=inner_radius,
        sort=sort,
        labels=labels,
        panel=panel,
        id=id,
    )


@helper
def gauge(
    data: Any,
    value: str,
    *,
    min: float | None = None,
    max: float | None = None,
    bands: Sequence[float | tuple[float, str]] | None = None,
    label: str | None = None,
    format: dict[str, Any] | None = None,
    panel: str | None = None,
    id: str | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """A gauge of the last finite value of ``value``, on a dial from ``min`` to ``max``."""
    return _chart_of(data, options).gauge(
        value,
        min=min,
        max=max,
        bands=bands,
        label=label,
        format=format,
        panel=panel,
        id=id,
    )


@helper
def funnel(
    data: Any,
    category: str,
    value: str | None = None,
    *,
    sort: Literal["input", "value"] | None = None,
    labels: bool | None = None,
    panel: str | None = None,
    halo: HaloOption | None = None,
    id: str | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """A funnel of ``value`` (or row counts) per stage of ``category``, top to bottom."""
    return _chart_of(data, options).funnel(
        category,
        value,
        sort=sort,
        labels=labels,
        panel=panel,
        halo=halo,
        id=id,
    )


@helper
def boxplot(
    data: Any,
    x: str | None = None,
    y: str | None = None,
    *,
    low: str | None = None,
    q1: str | None = None,
    median: str | None = None,
    q3: str | None = None,
    high: str | None = None,
    count: str | None = None,
    whiskers: Literal["tukey", "range"] | float | None = None,
    notch: bool | None = None,
    outliers: bool | None = None,
    series: str | None = None,
    fill: str | None = None,
    fill_opacity: float | None = None,
    label: str | None = None,
    legend_group: str | None = None,
    axis: Literal["left", "right"] | None = None,
    panel: str | None = None,
    clip: Clip | None = None,
    id: str | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """Box plots of ``y`` per category of ``x``, or of ``x`` per category of ``y``."""
    return _chart_of(data, options).boxplot(
        x,
        y,
        low=low,
        q1=q1,
        median=median,
        q3=q3,
        high=high,
        count=count,
        whiskers=whiskers,
        notch=notch,
        outliers=outliers,
        series=series,
        fill=fill,
        fill_opacity=fill_opacity,
        label=label,
        legend_group=legend_group,
        axis=axis,
        panel=panel,
        clip=clip,
        id=id,
    )


@helper
def boxen(
    data: Any,
    x: str,
    y: str,
    *,
    series: str | None = None,
    depth: Literal["tukey", "proportion", "trustworthy", "full"] | int | None = None,
    outlier_proportion: float | None = None,
    trust_alpha: float | None = None,
    width_method: Literal["exponential", "linear", "area"] | None = None,
    outliers: bool | None = None,
    fill: str | None = None,
    fill_opacity: float | None = None,
    label: str | None = None,
    legend_group: str | None = None,
    axis: Literal["left", "right"] | None = None,
    panel: str | None = None,
    clip: Clip | None = None,
    id: str | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """Letter-value plots of ``y`` per category of ``x``, or of ``x`` per category of ``y``."""
    return _chart_of(data, options).boxen(
        x,
        y,
        series=series,
        depth=depth,
        outlier_proportion=outlier_proportion,
        trust_alpha=trust_alpha,
        width_method=width_method,
        outliers=outliers,
        fill=fill,
        fill_opacity=fill_opacity,
        label=label,
        legend_group=legend_group,
        axis=axis,
        panel=panel,
        clip=clip,
        id=id,
    )


@helper
def violin(
    data: Any,
    x: str,
    y: str,
    *,
    series: str | None = None,
    bandwidth: float | None = None,
    split: bool | None = None,
    inner: Literal["box", "quartiles", "none"] | None = None,
    fill: str | None = None,
    fill_opacity: float | None = None,
    label: str | None = None,
    legend_group: str | None = None,
    axis: Literal["left", "right"] | None = None,
    panel: str | None = None,
    clip: Clip | None = None,
    id: str | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """Violins of ``y`` per category of ``x``, or of ``x`` per category of ``y``."""
    return _chart_of(data, options).violin(
        x,
        y,
        series=series,
        bandwidth=bandwidth,
        split=split,
        inner=inner,
        fill=fill,
        fill_opacity=fill_opacity,
        label=label,
        legend_group=legend_group,
        axis=axis,
        panel=panel,
        clip=clip,
        id=id,
    )


@helper
def treemap(
    data: Any,
    path: Sequence[str] | None = None,
    value: str | None = None,
    *,
    node: str | None = None,
    parent: str | None = None,
    labels: bool | None = None,
    panel: str | None = None,
    id: str | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """A treemap of a tree given by ``path`` columns, or ``node`` and ``parent``."""
    return _chart_of(data, options).treemap(
        path,
        value,
        node=node,
        parent=parent,
        labels=labels,
        panel=panel,
        id=id,
    )


@helper
def sunburst(
    data: Any,
    path: Sequence[str] | None = None,
    value: str | None = None,
    *,
    node: str | None = None,
    parent: str | None = None,
    labels: bool | None = None,
    panel: str | None = None,
    id: str | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """A sunburst of a tree given by ``path`` columns, or ``node`` and ``parent``."""
    return _chart_of(data, options).sunburst(
        path,
        value,
        node=node,
        parent=parent,
        labels=labels,
        panel=panel,
        id=id,
    )


@helper
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
    panel: str | None = None,
    halo: HaloOption | None = None,
    id: str | None = None,
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
        panel=panel,
        halo=halo,
        id=id,
    )


@helper
def sankey(
    data: Any,
    source: str,
    target: str,
    value: str | None = None,
    *,
    labels: bool | None = None,
    node_width: float | None = None,
    sort: Literal["input", "value"] | None = None,
    panel: str | None = None,
    halo: HaloOption | None = None,
    id: str | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """A Sankey diagram of flows from ``source`` to ``target``, sized by ``value``."""
    return _chart_of(data, options).sankey(
        source,
        target,
        value,
        labels=labels,
        node_width=node_width,
        sort=sort,
        panel=panel,
        halo=halo,
        id=id,
    )


@helper
def graph(
    data: Any,
    source: str,
    target: str,
    value: str | None = None,
    *,
    nodes: Any = None,
    node: str | None = None,
    color: str | None = None,
    size: str | None = None,
    labels: bool | None = None,
    directed: bool | None = None,
    link_label_field: str | None = None,
    layout: Literal["force", "circular", "layered"] | Mapping[str, Any] | None = None,
    panel: str | None = None,
    halo: HaloOption | None = None,
    id: str | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """A network of links from ``source`` to ``target``, with ``nodes`` for colors and sizes,
    placed by ``layout`` (``"force"``, ``"circular"``, or ``"layered"``)."""
    return _chart_of(data, options).graph(
        source,
        target,
        value,
        nodes=nodes,
        node=node,
        color=color,
        size=size,
        labels=labels,
        directed=directed,
        link_label_field=link_label_field,
        layout=layout,
        panel=panel,
        halo=halo,
        id=id,
    )


@helper
def choropleth(
    data: Any,
    color: str | None = None,
    *,
    geometry: str | None = None,
    label_field: str | None = None,
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
    panel: str | None = None,
    id: str | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """A map of regions colored by ``color`` (see ``Chart.geoshape``): shapes from
    ``data`` (a GeoDataFrame or GeoJSON FeatureCollection), or values from ``data``
    joined to the features of ``geojson`` by ``locations`` and ``feature_id_key``.
    Remaining keyword arguments are chart options (title, projection, ...)."""
    joined = geojson is not None
    chart, tooltip = _rows_chart_of(None if joined else data, options)
    return chart.geoshape(
        data=data if joined else None,
        color=color,
        geometry=geometry,
        label_field=label_field,
        colors=colors,
        color_domain=color_domain,
        color_midpoint=color_midpoint,
        fill=fill,
        fill_opacity=fill_opacity,
        stroke=stroke,
        stroke_width=stroke_width,
        label=label,
        geojson=geojson,
        locations=locations,
        feature_id_key=feature_id_key,
        panel=panel,
        tooltip=tooltip,
        id=id,
    )


@helper
def scatter_geo(
    data: Any,
    longitude: str,
    latitude: str,
    *,
    label_field: str | None = None,
    series: str | None = None,
    radius: float | None = None,
    size: str | None = None,
    radius_range: tuple[float, float] | None = None,
    color: str | None = None,
    colors: str | Sequence[str] | None = None,
    color_domain: tuple[float, float] | None = None,
    color_midpoint: float | None = None,
    fill: str | None = None,
    fill_opacity: float | None = None,
    stroke: str | None = None,
    stroke_width: float | None = None,
    label: str | None = None,
    panel: str | None = None,
    id: str | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """Points or bubbles on a map at ``longitude`` and ``latitude`` (see ``Chart.geopoint``)."""
    chart, tooltip = _rows_chart_of(data, options)
    return chart.geopoint(
        longitude,
        latitude,
        label_field=label_field,
        series=series,
        radius=radius,
        size=size,
        radius_range=radius_range,
        color=color,
        colors=colors,
        color_domain=color_domain,
        color_midpoint=color_midpoint,
        fill=fill,
        fill_opacity=fill_opacity,
        stroke=stroke,
        stroke_width=stroke_width,
        label=label,
        panel=panel,
        tooltip=tooltip,
        id=id,
    )


@helper
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
    legend_group: str | None = None,
    axis: Literal["left", "right"] | None = None,
    panel: str | None = None,
    clip: Clip | None = None,
    id: str | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """A candlestick chart of open, high, low, and close prices; OHLC bars with
    ``variant="ohlc"``."""
    chart, tooltip = _rows_chart_of(data, options)
    return chart.candlestick(
        x,
        open,
        high,
        low,
        close,
        variant=variant,
        rise=rise,
        fall=fall,
        label=label,
        legend_group=legend_group,
        axis=axis,
        panel=panel,
        clip=clip,
        tooltip=tooltip,
        id=id,
    )


def _halo(value: HaloOption | None, location: str) -> Any:
    return halo_spec(value, location)
