"""Charts: a Pythonic builder for the portable chart spec."""

from __future__ import annotations

import datetime as _dt
import difflib
import functools
import inspect
import math
import numbers
import sys
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal, ParamSpec, Protocol, TypedDict, TypeVar

import numpy as np

from . import _geo, _render
from ._data import Column, Table, listed, shown
from ._derive import Derived
from ._rows import SelectionBinding, bindings

# Annotations read at runtime (typing.get_type_hints) need Unpack too.
if sys.version_info >= (3, 11):
    from typing import Unpack
else:
    from typing_extensions import Unpack

if TYPE_CHECKING:
    from .widget import ChartWidget

TooltipMode = Literal["nearest-x", "nearest-y", "nearest"]
Curve = Literal["linear", "step", "step-before", "step-after", "monotone"]
StackGaps = Literal["zero", "interpolate"]
BarStack = bool | Literal["fill"]
AreaStack = bool | Literal["fill", "center", "wiggle"]
StackOrder = Literal["input", "inside-out"]
Orient = Literal["x", "y"]
HistogramNormalize = Literal["count", "frequency", "probability", "percent", "density"]
HistogramElement = Literal["bars", "step", "poly"]
ThemeName = Literal["light", "dark", "high-contrast", "high-contrast-dark", "auto"]

_NUMERIC = ("number", "time")

# The spec format version charts are written in: the only one so far.
_SPEC_VERSION = 1

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
                "Axis breaks: expected keys weekdays, hours, dates, or from and to; "
                f"received {sorted(rule)}"
            ) from None
    raise TypeError(f"Axis breaks: expected hg.Break objects or dicts; received {shown(rule)}")


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


@dataclass
class Axis:
    """Scale and axis options for x or y. Unset options use herceg's defaults.

    ``breaks``, on a time x axis only, leave out spans of time (see ``Break``)::

        hg.Axis(breaks=[hg.Break(weekdays=("sat", "sun")), hg.Break(hours=("16:00", "09:30"))])

    ``seams=True`` marks their collapsed boundaries with dashed vertical lines;
    ``seams={"min_spacing": 40}`` sets their minimum spacing in CSS pixels.

    ``format`` writes tick labels and tooltips' values, as Intl format options;
    ``tooltip_format`` writes one value of the axis in tooltips, the keyboard's
    announcements, and crosshair labels only, such as ``{"weekday": "short",
    "month": "short", "day": "numeric"}`` or ``{"style": "unit", "unit":
    "millisecond"}``.
    """

    type: Literal["linear", "log", "time"] | None = None
    domain: tuple[float, float] | None = None
    title: str | None = None
    nice: bool | None = None
    zero: bool | None = None
    grid: bool | None = None
    ticks: int | None = None
    format: dict[str, Any] | None = None
    tooltip_format: dict[str, Any] | None = None
    show: bool | None = None
    breaks: Sequence[Break | dict[str, Any]] | None = None
    seams: bool | dict[str, float] | None = None

    def __post_init__(self) -> None:
        _check_format(self.format, "Axis format", _NUMBER_FORMAT | _TIME_FORMAT)
        _check_format(self.tooltip_format, "Axis tooltip_format", _NUMBER_FORMAT | _TIME_FORMAT)

    def _spec(self) -> dict[str, Any]:
        seams = self.seams
        if seams is not None and not isinstance(seams, bool):
            if not isinstance(seams, dict) or any(key != "min_spacing" for key in seams):
                raise ValueError(
                    "Axis seams: expected True, False, or a dict with min_spacing; "
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
                    "Axis seams min_spacing: expected a finite, positive number of pixels; "
                    f"received {shown(spacing)}"
                )
            seams = {"minSpacing": seams["min_spacing"]} if seams else {}
        if seams is not None and seams is not False and self.breaks is None:
            raise ValueError(
                "Axis seams: mark the breaks of a time x axis, and the axis has none; "
                "give breaks or drop seams"
            )
        spec = {
            "type": self.type,
            "domain": list(self.domain) if self.domain is not None else None,
            "title": self.title,
            "nice": self.nice,
            "zero": self.zero,
            "grid": self.grid,
            "ticks": self.ticks,
            "format": self.format,
            "tooltipFormat": self.tooltip_format,
            "show": self.show,
            "breaks": [_break(rule) for rule in self.breaks] if self.breaks is not None else None,
            "seams": seams,
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
    ``Axis.format`` takes them. Without a format, numbers are written as the
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
    moves the x range they share, so ``resolve_x`` must be ``"shared"``.
    """

    height: float | None = None
    marks: Sequence[str] | None = None

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
    title: str | None = None
    y: Axis | dict[str, Any] | None = None
    x: Axis | dict[str, Any] | None = None
    y_right: Axis | dict[str, Any] | None = None

    def _spec(self) -> dict[str, Any]:
        spec = {
            "id": self.id,
            "title": self.title,
            "x": _axis(self.x, "Panel x"),
            "y": _axis(self.y, "Panel y"),
            "yRight": _axis(self.y_right, "Panel y_right"),
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
    animation: bool | float | Animation | None
    resolve_x: Literal["shared", "independent", "rows", "columns"] | None
    resolve_y: Literal["shared", "independent", "rows", "columns"] | None
    resolve_y_right: Literal["shared", "independent", "rows", "columns"] | None
    renderer: Literal["auto", "svg", "canvas"] | None
    theme: ThemeName | dict[str, Any] | None
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

    x: Axis | dict[str, Any] | None
    y: Axis | dict[str, Any] | None
    z: Axis | dict[str, Any] | None


class ChartOptions(ChartUpdate, _LayoutOptions, _BindingOptions, total=False):
    """``Chart``'s keyword arguments. ``None`` takes an option's default."""


class HelperOptions(_SharedOptions, _LayoutOptions, _BindingOptions, total=False):
    """Chart options as the one-call helpers (``hg.line``, ``hg.scatter``, ...)
    take them, after their own: ``x_axis``, ``y_axis``, and ``z_axis`` are the
    chart's ``x``, ``y``, and ``z``, since the helpers' ``x``, ``y``, and ``z``
    name columns."""

    x_axis: Axis | dict[str, Any] | None
    y_axis: Axis | dict[str, Any] | None
    z_axis: Axis | dict[str, Any] | None


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
            hg.Chart(df, title="Latency", y=hg.Axis(title="ms"))
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
        facet_column: str | None = None,
        resolve_x: Literal["shared", "independent", "rows", "columns"] | None = None,
        resolve_y: Literal["shared", "independent", "rows", "columns"] | None = None,
        resolve_y_right: Literal["shared", "independent", "rows", "columns"] | None = None,
        panels: Sequence[Panel | str] | None = None,
        panel_columns: int | None = None,
        panel_row_heights: Sequence[float] | None = None,
        panel_column_widths: Sequence[float] | None = None,
        legend: bool | None = None,
        tooltip: bool | TooltipMode | Tooltip | None = True,
        zoom: bool | Literal["x", "y", "xy"] | None = False,
        brush: Literal["x", "y", "xy", "lasso"] | None = None,
        sync: str | None = None,
        animation: bool | float | Animation | None = False,
        renderer: Literal["auto", "svg", "canvas"] | None = None,
        theme: ThemeName | dict[str, Any] | None = None,
        locale: str | None = None,
        time_zone: str | None = None,
        projection: ProjectionName | Projection | dict[str, Any] | None = None,
        z: Axis | dict[str, Any] | None = None,
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
        if panel_list and zoom in ("y", "xy"):
            raise ValueError(
                f"Chart zoom: charts with panels zoom along x only; received {shown(zoom)}"
            )
        if panel_list and brush in ("y", "xy", "lasso"):
            raise ValueError(
                f"Chart brush: charts with panels brush along x only; received {shown(brush)}"
            )
        for name, resolution in (
            ("resolve_x", resolve_x),
            ("resolve_y", resolve_y),
            ("resolve_y_right", resolve_y_right),
        ):
            choices = ("shared", "independent", "rows", "columns")
            if resolution is not None and resolution not in choices:
                raise ValueError(
                    f"Chart {name}: expected {listed(choices)}; received {shown(resolution)}"
                )
            if resolution not in (None, "shared") and not (
                facet is not None or facet_row is not None or facet_column is not None or panel_list
            ):
                raise ValueError(
                    f"Chart {name}: resolves the scales of facets or panels, and the chart has "
                    "none; give facet, facet_row, facet_column, or panels"
                )
        # One window shows one x range, so every panel must share it.
        if _navigator(navigator) is not None and resolve_x not in (None, "shared"):
            raise ValueError(
                "Chart navigator: needs one x scale shared by every panel, and resolve_x is "
                f'{shown(resolve_x)}; set resolve_x="shared" or drop navigator'
            )
        check_y_zoom({"zoom": zoom, "resolve_y": resolve_y, "resolve_y_right": None}, right=False)
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
            "tooltip": tooltip,
            "resolve_x": resolve_x,
            "resolve_y": resolve_y,
            "resolve_y_right": resolve_y_right,
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

    def line(
        self,
        x: str | Sequence[str],
        y: str | Sequence[str],
        *,
        orient: Orient | None = None,
        series: str | None = None,
        dodge: bool = False,
        data: Any = None,
        stroke: str | None = None,
        stroke_width: float | None = None,
        dash: Sequence[float] | None = None,
        curve: Curve | None = None,
        label: str | None = None,
        legend_group: str | None = None,
        axis: Literal["left", "right"] | None = None,
        facet: Literal["repeat"] | None = None,
        panel: str | None = None,
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
                "stroke": stroke,
                "strokeWidth": stroke_width,
                "dash": list(dash) if dash is not None else None,
                "curve": curve,
                "label": label,
                "legendGroup": _legend_group(legend_group, "line"),
                "axis": axis,
                "facet": _mark_facet(facet, "line"),
                "panel": panel,
                "tooltip": self._mark_tooltip(table, tooltip, "line"),
                "id": id,
            },
            table,
        )

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
        stack_order: StackOrder | None = None,
        stack_gaps: StackGaps | None = None,
        dodge: bool = False,
        data: Any = None,
        fill: str | None = None,
        fill_opacity: float | None = None,
        line: bool | None = None,
        stroke: str | None = None,
        stroke_width: float | None = None,
        curve: Curve | None = None,
        label: str | None = None,
        legend_group: str | None = None,
        axis: Literal["left", "right"] | None = None,
        facet: Literal["repeat"] | None = None,
        panel: str | None = None,
        tooltip: Tooltip | None = None,
        id: str | None = None,
    ) -> Chart:
        """Filled areas: down to zero, stacked, or the band between ``y1`` and ``y2``.

        Areas run along x, as lines do, or with ``orient="y"`` (or a category
        ``y``) along y, filled across x to zero; along y, ``x1`` and ``x2``
        give a band. ``stack=True`` stacks several value columns row by row,
        or the series of a ``series`` column on every position any of them
        has. There, a series counts as zero at a position where it has no
        row, or with ``stack_gaps="interpolate"`` as the straight line
        between its rows on either side. On a category axis,
        ``dodge=True`` places unstacked series side by side in each band.

        ``stack="fill"`` shows shares of each position's visible total.
        ``"center"`` centers raw thickness around zero; ``"wiggle"`` uses
        the Byron–Wattenberg stream baseline. These modes require nonnegative
        values. ``stack_order="inside-out"`` reorders their layers geometrically.

        A single area has an outline along its top in its own color; stacked
        and band areas have none unless ``line=True``. ``stroke`` and
        ``stroke_width`` set the outline's color and width, and turn it on.
        """
        _check_stack(stack, "area")
        if stack_order is not None:
            if stack_order not in ("input", "inside-out"):
                raise ValueError(
                    'area stack_order: expected "input" or "inside-out"; choose a supported order'
                )
            if not stack or (stack_order == "inside-out" and not isinstance(stack, str)):
                raise ValueError(
                    "area stack_order: needs a nonnegative stack for inside-out order; "
                    'give stack="fill", "center", or "wiggle", or drop stack_order'
                )
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
            if series is not None or stack or stack_order is not None:
                option = (
                    "series"
                    if series is not None
                    else "stack_order"
                    if stack_order is not None
                    else "stack"
                )
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
            if isinstance(stack, str):
                _check_stack_values(
                    self._tables[table][1], y_values if runs == "x" else x_values, "area"
                )
            if dodge and stack:
                raise ValueError(
                    "area dodge: a stack's layers stand on each other; drop dodge or stack"
                )
            self._check_dodge(table, "area", dodge, runs, x_spec if runs == "x" else y_spec, series)
        if stack_gaps is not None and not (stack and series is not None):
            raise ValueError(
                "area stack_gaps: applies to areas stacked by a series column; "
                "give stack=True and series, or drop stack_gaps"
            )
        if stack_gaps not in (None, "zero", "interpolate"):
            raise ValueError(
                f'area stack_gaps: expected "zero" or "interpolate"; received {shown(stack_gaps)}'
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
                "stack": stack or None,
                "stackGaps": stack_gaps,
                "stackOrder": stack_order,
                "dodge": dodge or None,
                "fill": fill,
                "fillOpacity": fill_opacity,
                "line": line,
                "stroke": stroke,
                "strokeWidth": stroke_width,
                "curve": curve,
                "label": label,
                "legendGroup": _legend_group(legend_group, "area"),
                "axis": axis,
                "facet": _mark_facet(facet, "area"),
                "panel": panel,
                "tooltip": self._mark_tooltip(table, tooltip, "area"),
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
        stack: BarStack = False,
        data: Any = None,
        fill: str | None = None,
        fill_opacity: float | None = None,
        label: str | None = None,
        legend_group: str | None = None,
        labels: bool | dict[str, Any] = False,
        axis: Literal["left", "right"] | None = None,
        facet: Literal["repeat"] | None = None,
        panel: str | None = None,
        tooltip: Tooltip | None = None,
        id: str | None = None,
    ) -> Chart:
        """Bars: one band per category of x, or bars centered on number or time x.

        A category ``y`` makes the bars horizontal, with lengths in ``x``.
        ``labels=True`` writes each value at its bar's end (inside each segment
        when stacked); a dict of Intl.NumberFormat options formats them.
        ``stack="fill"`` normalizes nonnegative values per position, and labels
        show shares. Tooltip and keyboard text also report the raw values.
        """
        _check_stack(stack, "bar")
        if isinstance(labels, dict):
            _check_format(labels, "bar labels", _NUMBER_FORMAT)
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
                "x": xs,
                "y": ys,
                "series": series,
                "stack": stack or None,
                "fill": fill,
                "fillOpacity": fill_opacity,
                "label": label,
                "legendGroup": _legend_group(legend_group, "bar"),
                "labels": None if labels is False else labels,
                "axis": axis,
                "facet": _mark_facet(facet, "bar"),
                "panel": panel,
                "tooltip": self._mark_tooltip(table, tooltip, "bar"),
                "id": id,
            },
            table,
        )

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
        axis: Literal["left", "right"] | None = None,
        facet: Literal["repeat"] | None = None,
        panel: str | None = None,
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
                "axis": axis,
                "facet": _mark_facet(facet, "rug"),
                "panel": panel,
                "tooltip": self._mark_tooltip(table, tooltip, "rug"),
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
        dodge: bool = False,
        data: Any = None,
        stroke: str | None = None,
        stroke_width: float | None = None,
        cap: float | None = None,
        label: str | None = None,
        legend_group: str | None = None,
        axis: Literal["left", "right"] | None = None,
        facet: Literal["repeat"] | None = None,
        panel: str | None = None,
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
                "axis": axis,
                "facet": _mark_facet(facet, "error_bar"),
                "panel": panel,
                "tooltip": self._mark_tooltip(table, tooltip, "error_bar"),
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
        axis: Literal["left", "right"] | None = None,
        facet: Literal["repeat"] | None = None,
        panel: str | None = None,
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
        by a category column, whose values take the theme's palette in order
        of appearance, with a key in the legend (naming the ``series`` column
        keeps the series' colors). ``symbol`` is a shape
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
                "axis": axis,
                "facet": _mark_facet(facet, "point"),
                "panel": panel,
                "tooltip": self._mark_tooltip(table, tooltip, "point"),
                "id": id,
            },
            table,
        )

    def histogram(
        self,
        x: str | None = None,
        *,
        y: str | None = None,
        bins: int | dict[str, float] | Sequence[float] | np.ndarray[Any, Any] | None = None,
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
        label: str | None = None,
        legend_group: str | None = None,
        axis: Literal["left", "right"] | None = None,
        facet: Literal["repeat"] | None = None,
        panel: str | None = None,
        id: str | None = None,
    ) -> Chart:
        """Counts of exactly one number or time field: x (vertical) or y (horizontal).

        Bins are an approximate count, a step/start dict, or exact increasing
        edges. Each row counts as 1, or as its ``weight`` (a number column;
        rows missing a weight, or with a negative one, are not counted).
        ``normalize`` measures each series' bins: counts, ``"frequency"``
        (counts per unit of the binned axis), or ``"probability"``,
        ``"percent"``, and ``"density"`` of its counts; common_norm weights
        its share of finite values in the panel (including hidden series and
        values outside bins). Cumulative density integrates widths. Stack
        stacks series, and ``stack="fill"`` as shares of each bin; dodge
        places visible series side by side and excludes stack.
        ``element="step"`` draws each series as an area stepping across its
        bins, and ``"poly"`` as one through their centers.
        """
        if (x is None) == (y is None):
            raise ValueError("histogram: needs exactly one of x and y")
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
        if normalize not in (None, "count", "frequency", "probability", "percent", "density"):
            raise ValueError(
                'histogram normalize: expected "count", "frequency", "probability", "percent", '
                f'or "density"; received {shown(normalize)}'
            )
        if element not in (None, "bars", "step", "poly"):
            raise ValueError(
                f'histogram element: expected "bars", "step", or "poly"; received {shown(element)}'
            )
        if dodge and element not in (None, "bars"):
            raise ValueError(
                "histogram dodge: places bars side by side in each bin; drop dodge, or draw "
                'element="bars"'
            )
        bins = _histogram_bins(bins)
        table = self._mark_table(data)
        self._require(
            table,
            y if y is not None else x,
            _NUMERIC,
            "histogram y" if y is not None else "histogram x",
        )
        self._require(table, series, ("category",), "histogram series")
        self._require(table, weight, ("number",), "histogram weight")
        return self._add(
            {
                "type": "histogram",
                "x": x,
                "y": y,
                "bins": bins,
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
                "axis": axis,
                "facet": _mark_facet(facet, "histogram"),
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
        legend_group: str | None = None,
        axis: Literal["left", "right"] | None = None,
        facet: Literal["repeat"] | None = None,
        panel: str | None = None,
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
                "axis": axis,
                "facet": _mark_facet(facet, "candlestick"),
                "panel": panel,
                "tooltip": self._mark_tooltip(table, tooltip, "candlestick"),
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

    def funnel(
        self,
        category: str,
        value: str | None = None,
        *,
        data: Any = None,
        sort: Literal["input", "value"] | None = None,
        labels: bool | None = None,
        panel: str | None = None,
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
                "category": category,
                "value": value,
                "sort": sort,
                "labels": labels,
                "panel": panel,
                "id": id,
            },
            table,
        )

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
        series: str | None = None,
        fill: str | None = None,
        fill_opacity: float | None = None,
        label: str | None = None,
        legend_group: str | None = None,
        axis: Literal["left", "right"] | None = None,
        facet: Literal["repeat"] | None = None,
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
        Instead of raw values, name ``low``, ``q1``, ``median``, ``q3``, and
        ``high`` columns with just a category ``x`` or ``y``: one box per row,
        no outliers. ``count`` is optional unless ``notch=True``. Notches
        extend 1.57 IQR / sqrt(count) from the median, without clamping.
        Raw ``whiskers`` are "tukey" (default), "range", or a nonnegative
        IQR multiple; precomputed boxes already give their whisker ends.
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
        return self._distribution(
            {
                "type": "boxplot",
                "fill": fill,
                **statistics,
                "count": count,
                "whiskers": whiskers,
                "notch": notch,
                "legendGroup": _legend_group(legend_group, "boxplot"),
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
        axis: Literal["left", "right"] | None = None,
        facet: Literal["repeat"] | None = None,
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
        """Adds a box plot or violin mark: a category column on one axis, values on the other."""
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
            noun = "box plots" if kind == "boxplot" else "violins"
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
        id: str | None = None,
    ) -> Chart:
        """A network: a row per link between the nodes named in ``source`` and
        ``target``, placed by a force simulation, links as wide as the sum of
        ``value`` over their rows when given.

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
        most 5,000 nodes and 20,000 links and has its chart to itself;
        ``Chart(drag=True)`` lets its nodes be dragged.
        """
        self._layout_place("graph")
        table = self._mark_table(data)
        self._require(table, source, ("category",), "graph source")
        self._require(table, target, ("category",), "graph target")
        self._require(table, value, ("number",), "graph value")
        self._require(table, link_label_field, ("category",), "graph link_label_field")
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
                "source": source,
                "target": target,
                "value": value,
                "node": node,
                "color": color,
                "size": size,
                "labels": labels,
                "directed": directed,
                "linkLabelField": link_label_field,
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
        *,
        directed: bool = False,
    ) -> tuple[int, int]:
        """How many nodes and links a network draws, counted as the browser
        counts them: the names in the nodes table and in rows the links keep,
        and one link per pair of different names (either way round, unless
        ``directed``) whose values sum to a finite total."""
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
        starts, ends_ = ids[: len(a)], ids[len(a) :]
        low = starts if directed else np.minimum(starts, ends_)
        high = ends_ if directed else np.maximum(starts, ends_)
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

    def _layout_place(self, kind: str) -> None:
        """Layout marks (pies, treemaps, sunbursts, gauges, funnels, radars, Sankey
        diagrams, graphs) have no axes to zoom: they have their chart to
        themselves, or a facet panel each, or a panel of their own (see ``_add``).
        Networks have no facets or panels yet. A treemap or sunburst of a chart
        of its own drills with ``zoom=True``; a network pans and zooms its
        layout plane, lassos nodes, moves them with ``drag=True``, and selects rows."""
        panelled = bool(self._facets or self._panels)
        if panelled and kind not in _PANEL_LAYOUT_MARKS:
            raise ValueError(f"{kind}: has no facets or panels yet; draw it in a chart of its own")
        if self._row_selection and (panelled or kind not in _SELECTING_LAYOUT_MARKS):
            raise ValueError(
                f"Chart row_selection: a {kind} cannot select rows here yet; marks along x "
                "and y can, as can a map, treemap, sunburst, or network in a chart of its own"
            )
        if self._settings.get("drag") and kind != "graph":
            raise ValueError(
                f"Chart drag: moves a network's nodes, and a {kind} has none; drop drag"
            )
        settings = self._settings
        drills = kind in ("treemap", "sunburst") and not panelled
        if drills and settings.get("zoom") not in (True, False, None):
            raise ValueError(
                f"Chart zoom: a {kind} drills with zoom=True, not along an axis; "
                f"received {shown(settings.get('zoom'))}"
            )
        if kind == "graph":
            if settings.get("zoom") not in (True, False, None, "xy"):
                raise ValueError(
                    "Chart zoom: a graph pans and zooms both ways, "
                    f"received {shown(settings.get('zoom'))}; "
                    "use zoom=True or zoom='xy'"
                )
            if settings.get("brush") not in (None, "lasso"):
                raise ValueError(
                    "Chart brush: a graph takes only a lasso, "
                    f"received {shown(settings.get('brush'))}; "
                    "use brush='lasso'"
                )
        # A chart with panels may zoom those with axes; `to_spec` checks it has some.
        used = self._x_option(
            ("sync",)
            if kind == "graph"
            else ("brush", "sync")
            if drills
            else ("zoom", "brush", "sync")
        )
        if not self._panels and used is not None:
            raise ValueError(
                f"Chart {used}: a {kind} has no x axis to act on; drop {_dropped(used)}"
            )

    def _x_option(self, options: Sequence[str] = ("zoom", "brush", "sync")) -> str | None:
        """The first of the chart's `options` that is set, or else "x seams" when the
        x axis marks seams: what acts on an x axis, as messages name it."""
        settings = self._settings
        used = next((name for name in options if settings.get(name)), None)
        seams = (self._options.get("x") or {}).get("seams")
        return used or ("x seams" if seams not in (None, False) else None)

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
        ``projection``.
        """
        self._map_alone("geoshape")
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
                "tooltip": self._mark_tooltip(table, tooltip, "geoshape"),
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
        ``gdf.assign(lon=gdf.geometry.x, lat=gdf.geometry.y)``.
        """
        self._map_alone("geopoint")
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
                "tooltip": self._mark_tooltip(table, tooltip, "geopoint"),
                "id": id,
            },
            table,
        )

    def _map_alone(self, kind: str) -> None:
        """Maps have no facets or panels; they zoom and pan both ways
        (``zoom=True`` or ``"xy"``), take a ``"lasso"`` brush, select rows, and
        sync nothing."""
        if self._facets or self._panels:
            raise ValueError(f"{kind}: has no facets or panels yet; draw it in a chart of its own")
        settings = self._settings
        if settings.get("zoom") in ("x", "y"):
            raise ValueError(
                'Chart zoom: expected True or "xy", as maps zoom both ways; '
                f"received {shown(settings['zoom'])}"
            )
        if settings.get("brush") not in (None, "lasso"):
            raise ValueError(
                f'Chart brush: expected "lasso" for maps; received {shown(settings["brush"])}'
            )
        if settings.get("sync"):
            raise ValueError(f"Chart sync: a {kind} has no x axis to act on; drop sync")
        if settings.get("drag"):
            raise ValueError(
                f"Chart drag: moves a network's nodes, and a {kind} has none; drop drag"
            )

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
        id: str | None = None,
    ) -> Chart:
        """Points in a 3D chart at the numeric or datetime columns ``x``, ``y``,
        and ``z`` (z is vertical).

        ``series`` gives a color and legend entry per category, ``color``
        colors points by a numeric column (or a category column, a palette
        color per value, as ``Chart.point``'s), and ``label_field`` names a
        category column labeling each point in tooltips. ``radius`` is the
        radius in pixels (3.5 by default). 3D marks share their chart, its
        box, and its ``camera``.
        """
        self._alone_3d("point_3d")
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
                "id": id,
            },
            table,
        )

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
        id: str | None = None,
    ) -> Chart:
        """Lines in a 3D chart through the numeric or datetime columns ``x``,
        ``y``, and ``z`` (z is vertical).

        Each ``series`` category's rows, in table order, are one path with its
        color and legend entry (all rows are one path without it); a row
        missing a value breaks its path. ``stroke_width`` is in pixels (2 by
        default) and stays the same however near or far the line is. 3D marks
        share their chart, its box, and its ``camera``.
        """
        self._alone_3d("line_3d")
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
                "id": id,
            },
            table,
        )

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
        id: str | None = None,
    ) -> Chart:
        """A surface in a 3D chart, from a grid of rows or from a matrix.

        With column names, each row is a grid point: ``x`` and ``y`` (numbers,
        datetimes, or categories) pick its place, and ``z`` is its height;
        points without a value leave holes. With a 2D array ``z`` (as in
        ``go.Surface(z=...)``), row ``i`` and column ``j`` is the height at
        ``y[i]`` and ``x[j]``, where ``x`` and ``y`` are optional sequences
        (positions 0, 1, 2, ... by default). The matrix is sent as three
        columns with a row per grid point, so its x and y positions take as
        much room as its heights.

        The surface is colored by height, or by a numeric ``color`` column,
        and shaded by how it faces a light (``shading=False`` keeps colors as
        the legend shows them); ``wireframe=True`` draws its grid lines.
        """
        self._alone_3d("surface")
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
            data = _grid_columns(z, x, y)
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
                "id": id,
            },
            table,
        )

    def _alone_3d(self, kind: str) -> None:
        """3D charts have no x axis to facet, brush, or sync, and zoom only their camera."""
        if self._facets or self._panels:
            raise ValueError(f"{kind}: has no facets or panels yet; draw it in a chart of its own")
        if self._row_selection:
            raise ValueError(
                f"Chart row_selection: a {kind} cannot select rows yet; marks along x and y can"
            )
        used = next((name for name in ("brush", "sync") if self._settings.get(name)), None)
        if used is not None:
            raise ValueError(f"Chart {used}: a {kind} has no x axis to act on; drop {used}")
        if self._settings.get("zoom") not in (True, False, None):
            raise ValueError(
                "Chart zoom: 3D charts zoom their camera with zoom=True; "
                f"received {shown(self._settings['zoom'])}"
            )

    def heatmap(
        self,
        x: str | None = None,
        y: str | None = None,
        color: str | None = None,
        *,
        date: str | None = None,
        calendar: Literal["weeks", "months"] | None = None,
        week_start: Literal["mon", "tue", "wed", "thu", "fri", "sat", "sun"] | None = None,
        data: Any = None,
        colors: str | Sequence[str] | None = None,
        color_domain: tuple[float, float] | None = None,
        color_midpoint: float | None = None,
        reduce: Literal["mean", "max", "min"] | None = None,
        x_step: float | None = None,
        y_step: float | None = None,
        x_banded: bool = False,
        y_banded: bool = False,
        label: str | None = None,
        facet: Literal["repeat"] | None = None,
        panel: str | None = None,
        tooltip: Tooltip | None = None,
        id: str | None = None,
    ) -> Chart:
        """A grid of cells colored by the numeric column ``color``: cells at ``x`` and ``y``, or the
        days of a time column ``date`` laid out as a calendar.

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

        ``colors`` is a scheme name such as ``"viridis"`` or a list of hex
        colors, low to high; with ``color_midpoint``, the theme's diverging
        ramp is the default and the midpoint takes its middle color. Grids
        with more columns or rows than the plot has pixels draw each pixel
        from a block of cells, colored by the ``reduce`` of their values:
        ``"mean"`` (the default), ``"max"``, or ``"min"``.
        """
        if reduce not in (None, "mean", "max", "min"):
            raise ValueError(
                f'heatmap reduce: expected "mean", "max", or "min"; received {shown(reduce)}'
            )
        if color is None:
            raise ValueError("heatmap color: needs the numeric column that colors the cells")
        table = self._mark_table(data)
        self._require(table, color, _NUMERIC, "heatmap color")
        shared = {
            "type": "heatmap",
            "color": color,
            "colors": _colors(colors, "heatmap colors"),
            "colorDomain": _range(color_domain, "heatmap color_domain"),
            "colorMidpoint": _midpoint(color_midpoint, color_domain, "heatmap"),
            "reduce": reduce,
            "label": label,
            "facet": _mark_facet(facet, "heatmap"),
            "panel": panel,
            "tooltip": self._mark_tooltip(table, tooltip, "heatmap"),
            "id": id,
        }
        if date is not None:
            grid = {"x": x, "y": y, "x_step": x_step, "y_step": y_step}
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
        if x is None or y is None:
            raise ValueError("heatmap: needs x and y, or a date to lay out as a calendar")
        if calendar is not None or week_start is not None:
            option = "calendar" if calendar is not None else "week_start"
            raise ValueError(
                f"heatmap {option}: applies to calendars of a date; give date or drop {option}"
            )
        self._require(table, x, ("number", "time", "category"), "heatmap x")
        self._require(table, y, ("number", "time", "category"), "heatmap y")

        def placement(
            axis: str, field: str, step: float | None, bands: bool
        ) -> tuple[float | None, bool | None]:
            """The spec's step and banded option along one axis."""
            if not isinstance(bands, bool):
                raise ValueError(
                    f"heatmap {axis}_banded: expected True or False; received {shown(bands)}"
                )
            category = self._kind(table, field) == "category"
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
            },
            table,
        )

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
        text_field: str | None = None,
        data: Any = None,
        stroke: str | None = None,
        stroke_width: float | None = None,
        dash: Sequence[float] | None = None,
        axis: Literal["left", "right"] | None = None,
        facet: Literal["repeat"] | None = None,
        panel: str | None = None,
        id: str | None = None,
    ) -> Chart:
        """Reference lines: horizontal at ``y`` or vertical at ``x``.

        A number or datetime draws one rule; a column name draws one rule per
        row, with ``text_field`` naming a column of labels; ``label`` is one
        label for every rule.
        """
        if (x is None) == (y is None):
            raise ValueError("rule: needs exactly one of x and y")
        table = self._annotation_table(data, {"x": x, "y": y}, text_field, "rule")
        return self._add(
            {
                "type": "rule",
                "x": _position(x, "rule x"),
                "y": _position(y, "rule y"),
                "stroke": stroke,
                "strokeWidth": stroke_width,
                "dash": list(dash) if dash is not None else None,
                "label": label,
                "textField": text_field,
                "axis": axis,
                "facet": _mark_facet(facet, "rule"),
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
        text_field: str | None = None,
        data: Any = None,
        fill: str | None = None,
        fill_opacity: float | None = None,
        axis: Literal["left", "right"] | None = None,
        facet: Literal["repeat"] | None = None,
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
                missing = f"{name}1" if start is None else f"{name}2"
                raise ValueError(f"region {missing}: needs both {name}1 and {name}2, or neither")
        if x1 is None and y1 is None:
            raise ValueError("region: needs x1 and x2, y1 and y2, or both")
        table = self._annotation_table(
            data, {"x1": x1, "x2": x2, "y1": y1, "y2": y2}, text_field, "region"
        )
        return self._add(
            {
                "type": "region",
                "x1": _position(x1, "region x1"),
                "x2": _position(x2, "region x2"),
                "y1": _position(y1, "region y1"),
                "y2": _position(y2, "region y2"),
                "fill": fill,
                "fillOpacity": fill_opacity,
                "label": label,
                "textField": text_field,
                "axis": axis,
                "facet": _mark_facet(facet, "region"),
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
        text_field: str | None = None,
        data: Any = None,
        fill: str | None = None,
        anchor: Literal["start", "middle", "end"] | None = None,
        dx: float | None = None,
        dy: float | None = None,
        overlap: Literal["show", "hide", "move"] | None = None,
        axis: Literal["left", "right"] | None = None,
        facet: Literal["repeat"] | None = None,
        panel: str | None = None,
        id: str | None = None,
    ) -> Chart:
        """Text at ``(x, y)``: ``label`` for constant text, or ``text_field`` naming a column.

        Column names for ``x`` or ``y`` draw one label per row. ``dx`` and
        ``dy`` offset labels in pixels; positive ``dy`` moves down. Labels that
        would cover an earlier one of this mark, in row order, are drawn anyway
        (``overlap="show"``), left out (``"hide"``), or, where their place is
        taken or outside the plot, tried around their point and left out when
        nothing fits (``"move"``).
        """
        if overlap not in (None, "show", "hide", "move"):
            raise ValueError(
                f'text overlap: expected "show", "hide", or "move"; received {shown(overlap)}'
            )
        if (label is None) == (text_field is None):
            raise ValueError("text: needs exactly one of label and text_field")
        table = self._annotation_table(data, {"x": x, "y": y}, text_field, "text")
        return self._add(
            {
                "type": "text",
                "x": _position(x, "text x"),
                "y": _position(y, "text y"),
                "label": label,
                "textField": text_field,
                "fill": fill,
                "anchor": anchor,
                "dx": dx,
                "dy": dy,
                "overlap": overlap,
                "axis": axis,
                "facet": _mark_facet(facet, "text"),
                "panel": panel,
                "id": id,
            },
            table,
        )

    # Output ----------------------------------------------------------------

    def to_spec(self) -> tuple[dict[str, Any], list[bytes]]:
        """The portable chart spec and the binary buffers its columns reference."""
        layouts = [mark["type"] for mark, _ in self._marks if mark["type"] in _LAYOUT_MARKS]
        # Layout marks have a panel each, so when they have every one, no panel has axes.
        used = self._x_option()
        if self._panels and len(layouts) == len(self._panels) and used is not None:
            raise ValueError(
                f"Chart {used}: every panel draws a {_method(layouts[0])} or another mark "
                f"without axes, so no panel has an x axis; drop {_dropped(used)}"
            )
        if self._settings.get("drag") and not any(
            mark["type"] == "graph" for mark, _ in self._marks
        ):
            raise ValueError(
                "Chart drag: moves a network's nodes, and the chart has no graph; drop drag"
            )
        if self._settings.get("projection") is not None and not any(
            mark["type"] in _MAP_MARKS for mark, _ in self._marks
        ):
            raise ValueError(
                "Chart projection: projects geoshape and geopoint marks, and the chart has "
                "none; drop projection"
            )
        three_d = any(mark["type"] in _MARKS_3D for mark, _ in self._marks)
        for name in ("z", "camera", "box_aspect"):
            if self._settings.get(name) is not None and not three_d:
                raise ValueError(
                    f"Chart {name}: an option of 3D charts, and the chart has no point_3d, "
                    f"line_3d, or surface marks; drop {name}"
                )
        return assemble_spec(
            self._spec_options(),
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

    def to_pdf(
        self,
        *,
        fonts: _render.PdfFonts | None = None,
        fallback: Sequence[str] = (),
        missing_glyph: str | None = None,
    ) -> bytes:
        """One-page vector PDF sized to the chart (requires the ``export`` extra)."""
        return _render.pdf(
            *self.to_spec(), fonts=fonts, fallback=fallback, missing_glyph=missing_glyph
        )

    def save(
        self,
        path: str,
        *,
        scale: float = 2,
        fonts: _render.PdfFonts | None = None,
        fallback: Sequence[str] = (),
        missing_glyph: str | None = None,
    ) -> None:
        """Writes ``.html``, ``.svg``, ``.png``, or ``.pdf``, chosen by the file extension."""
        lower = str(path).lower()
        if not lower.endswith(".pdf") and (
            fonts is not None or fallback or missing_glyph is not None
        ):
            option = "fonts" if fonts is not None else "fallback" if fallback else "missing_glyph"
            raise ValueError(
                f"save {option}: an option of PDF export; save to a .pdf path or drop {option}"
            )
        if lower.endswith(".html"):
            content: str | bytes = self.to_html()
        elif lower.endswith(".svg"):
            content = self.to_svg()
        elif lower.endswith(".png"):
            content = self.to_png(scale=scale)
        elif lower.endswith(".pdf"):
            content = self.to_pdf(fonts=fonts, fallback=fallback, missing_glyph=missing_glyph)
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
            binding._spec(name) for binding, name in zip(self._row_selection, names, strict=True)
        ]
        return {**self._options, "rowSelection": specs[0] if len(specs) == 1 else specs}

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
            if brush == "lasso" and kind in ("histogram", "boxplot", "violin"):
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
            if kind not in ("histogram", "boxplot", "violin"):
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
        # Columns row selections' conditions set from Python test.
        for binding in self._row_selection:
            if not binding.fields:
                continue
            index = self._bound_index(binding)
            names = self._tables[index][1].names if index not in self._derived else ()
            for name in binding.fields:
                if name not in names:
                    raise ValueError(
                        f"SelectionBinding fields: no column {name!r} in the data it selects"
                    )
            used.setdefault(index, set()).update(binding.fields)
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
        self, data: Any, positions: dict[str, Any], text: str | None, role: str
    ) -> int | None:
        """The table an annotation reads, when a position or its text is a column."""
        fields = {name: value for name, value in positions.items() if isinstance(value, str)}
        if not fields and text is None:
            return None
        table = self._mark_table(data)
        for name, field in fields.items():
            self._require(table, field, _NUMERIC, f"{role} {name}")
        self._require(table, text, ("category", "number"), f"{role} text_field")
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
        if panel in held:
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
            if mark.get("panel") == panel:
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
        (``resolve_x`` or ``resolve_y`` other than ``"shared"`` on a category axis)
        cannot do yet: sync, and brush along a y axis of such categories."""
        if table is None or not (self._facets or self._panels):
            return
        kind = spec["type"]
        for axis in ("x", "y"):
            default = "independent" if axis == "y" and self._panels else "shared"
            resolution = self._settings[f"resolve_{axis}"] or default
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
            if resolution == "shared" or not banded:
                continue
            if self._settings["sync"] is not None:
                raise ValueError(
                    f"Chart sync: panels with categories of their own (resolve_{axis}) "
                    f"cannot sync yet; drop sync or resolve_{axis}"
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

#: Layout marks that draw in each facet panel or in a panel of their own.
_PANEL_LAYOUT_MARKS = ("pie", "treemap", "sunburst", "gauge", "funnel", "radar", "sankey")
#: Layout marks whose charts select rows, of a chart of their own (maps too).
_SELECTING_LAYOUT_MARKS = ("treemap", "sunburst", "graph")

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
    """The keyword to drop for an option as `Chart._x_option` names it."""
    return "seams" if option == "x seams" else option


#: The most nodes and links a graph lays out, as the browser enforces.
MAX_NODES = 5000
MAX_LINKS = 20_000

#: A graph's fields that are columns of its nodes.
_NODE_FIELDS = ("node", "color", "size")


#: Chart options a live chart can change after display: all but data and facets,
#: which decide the columns sent.
OPTIONS = (
    *("title", "description", "width", "height", "x", "y", "y_right", "legend", "tooltip"),
    *("zoom", "brush", "sync", "animation", "resolve_x", "resolve_y", "resolve_y_right"),
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


def check_y_zoom(settings: Mapping[str, Any], *, right: bool) -> None:
    """Refuses, as the browser does, zooming along y in charts whose facet panels
    have y scales of their own (``resolve_y``), or with marks on the right axis
    (``right``), right y scales of their own (``resolve_y_right``): a y zoom moves
    both axes through the same pixels, in every panel."""
    if settings["zoom"] not in ("y", "xy"):
        return
    if settings["resolve_y"] not in (None, "shared"):
        raise ValueError(
            "Chart zoom: charts whose panels have y scales of their own (resolve_y) zoom "
            f"along x only; received {shown(settings['zoom'])}"
        )
    if right and settings["resolve_y_right"] not in (None, "shared"):
        raise ValueError(
            "Chart zoom: charts whose panels have right y scales of their own "
            f"(resolve_y_right) zoom along x only; received {shown(settings['zoom'])}"
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
        "title": settings["title"],
        "description": settings["description"],
        "width": settings["width"],
        "height": settings["height"],
        "x": _axis(settings["x"]),
        "y": _axis(settings["y"], "Chart y"),
        "yRight": _axis(settings["y_right"], "Chart y_right"),
        "legend": settings["legend"],
        "tooltip": tooltip
        if tooltip is None or isinstance(tooltip, bool)
        else tooltip._spec()
        if isinstance(tooltip, Tooltip)
        else {"mode": tooltip},
        "interaction": interaction or None,
        "animation": _animation(animation),
        "resolve": {
            axis: settings[name]
            for axis, name in (
                ("x", "resolve_x"),
                ("y", "resolve_y"),
                ("yRight", "resolve_y_right"),
            )
            if settings[name]
        }
        or None,
        "renderer": settings["renderer"],
        "theme": _theme(settings["theme"]),
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
) -> tuple[dict[str, Any], list[bytes]]:
    """A spec and its buffers from chart options, columns by table name, mark
    specs, and derived tables by name."""
    buffers: list[bytes] = []
    spec: dict[str, Any] = {"version": _SPEC_VERSION, **options}
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


def _left_along_y(mark: str, along: Orient, axis: str | None) -> None:
    """Lines and areas along y use the left axis, as horizontal bars do."""
    if along == "y" and axis == "right":
        raise ValueError(
            f"{mark} axis: {mark}s along y use the left axis, as horizontal bars do; "
            'drop axis="right"'
        )


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
        *("x", "y", "x1", "x2", "y1", "y2", "xError", "yError", "series", "value", "textField"),
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


def _axis(axis: Axis | dict[str, Any] | None, role: str = "Chart x") -> dict[str, Any] | None:
    """An axis's spec; `role` is where it was given, as "Chart y" or "Panel x"."""
    if axis is None:
        return None
    if isinstance(axis, dict):
        axis = Axis(**axis)
    if role != "Chart x" and axis.breaks is not None:
        raise ValueError(f"{role} breaks: only the chart's x axis takes breaks; drop them")
    if role != "Chart x" and axis.seams is not None:
        raise ValueError(f"{role} seams: only the chart's x axis takes seams; drop them")
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


def _camera(camera: Any) -> dict[str, Any] | None:
    """A camera's spec from a Camera or a dict of its fields."""
    if camera is None:
        return None
    if isinstance(camera, dict):
        camera = Camera(**camera)
    if not isinstance(camera, Camera):
        raise TypeError(
            f"Chart camera: expected an hg.Camera or a dict of its fields; received {shown(camera)}"
        )
    return camera._spec()


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


def _grid_columns(z: Any, x: Any, y: Any) -> dict[str, np.ndarray]:
    """A matrix of heights as columns of one row per grid point: row i, column j
    at ``y[i]``, ``x[j]``. Without ``x`` or ``y``, positions are 0, 1, 2, ..."""
    heights = np.asarray(z, dtype=np.float64)
    if heights.ndim != 2:
        raise ValueError(
            f"surface z: expected a 2D matrix of heights; received shape {heights.shape}"
        )
    rows, columns = heights.shape

    def positions(values: Any, count: int, name: str) -> np.ndarray:
        if values is None:
            return np.arange(count, dtype=np.float64)
        if isinstance(values, str):
            raise TypeError(
                f"surface {name}: expected positions along the z matrix; "
                f"received the column name {shown(values)}"
            )
        array = np.asarray(values)
        if array.ndim != 1 or len(array) != count:
            side = "column" if name == "x" else "row"
            given = len(array) if array.ndim == 1 else f"an array of shape {array.shape}"
            raise ValueError(
                f"surface {name}: expected {count} values, one per matrix {side}; received {given}"
            )
        return array

    xs = positions(x, columns, "x")
    ys = positions(y, rows, "y")
    return {"x": np.tile(xs, rows), "y": np.repeat(ys, columns), "z": heights.reshape(-1)}


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


def _theme(theme: str | dict[str, Any] | None) -> Any:
    if theme is None or isinstance(theme, str):
        return theme
    known = _THEME_WORDS | _THEME_KEYS.keys() | set(_THEME_KEYS.values())
    unknown = [key for key in theme if key not in known]
    if unknown:
        names = listed(sorted(_THEME_WORDS | _THEME_KEYS.keys()))
        raise ValueError(f"Chart theme: unknown key {shown(unknown[0])}; name one of {names}")
    return {_THEME_KEYS.get(key, key): value for key, value in theme.items()}


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


def _position(value: Any, role: str) -> str | float | None:
    """Column names pass through; datetimes become epoch milliseconds."""
    if value is None or isinstance(value, str):
        return value
    if isinstance(value, numbers.Real):
        return float(value)
    from ._data import _time_ms

    try:
        return _time_ms(value)
    except TypeError:
        raise TypeError(
            f"{role}: expected a column name, a number, or a datetime; received {shown(value)}"
        ) from None


# Express-style helpers: one call, one chart -----------------------------------

_P = ParamSpec("_P")
_R = TypeVar("_R")

#: Names other libraries give options herceg names otherwise (Plotly
#: Express, Seaborn), and the options a helper may take instead.
_ELSEWHERE: dict[str, tuple[str, ...]] = {
    "color": ("series", "stroke", "fill"),
    "colour": ("series", "stroke", "fill"),
    "hue": ("series",),
    "hue_order": ("series_order",),
    "row": ("facet_row",),
    "col": ("facet_column",),
    "facet_col": ("facet_column",),
    "col_wrap": ("facet_columns",),
    "facet_col_wrap": ("facet_columns",),
    "template": ("theme",),
    "labels": ("x_axis", "y_axis"),
}


def helper(function: Callable[_P, _R]) -> Callable[_P, _R]:
    """Makes a one-call helper (``hg.line``, ``hx.barplot``, ...) refuse
    keyword arguments it does not take by its own name, suggesting those it
    does: otherwise Python's error would name ``Chart.__init__``, which the
    helper passes its chart options to."""
    own = [
        name
        for name, parameter in inspect.signature(function).parameters.items()
        if parameter.kind is not parameter.VAR_KEYWORD
    ]
    known = {*own, *HelperOptions.__optional_keys__}
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
    suggested = [option for option in _ELSEWHERE.get(name, ()) if option in known]
    suggested += difflib.get_close_matches(name, sorted(known - set(suggested)), n=1, cutoff=0.7)
    where = "herceg.express" if function.__module__.startswith("herceg.express") else "herceg"
    hint = (
        f"did you mean {' or '.join(repr(option) for option in suggested)}?"
        if suggested
        else f"see help({where}.{function.__name__}) for the options it takes"
    )
    return f"{function.__name__}: no option {name!r}; {hint}"


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
    stroke: str | None = None,
    stroke_width: float | None = None,
    dash: Sequence[float] | None = None,
    curve: Curve | None = None,
    label: str | None = None,
    legend_group: str | None = None,
    axis: Literal["left", "right"] | None = None,
    panel: str | None = None,
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
        stroke=stroke,
        stroke_width=stroke_width,
        dash=dash,
        curve=curve,
        label=label,
        legend_group=legend_group,
        axis=axis,
        panel=panel,
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
    stack_order: StackOrder | None = None,
    stack_gaps: StackGaps | None = None,
    dodge: bool = False,
    fill: str | None = None,
    fill_opacity: float | None = None,
    line: bool | None = None,
    stroke: str | None = None,
    stroke_width: float | None = None,
    curve: Curve | None = None,
    label: str | None = None,
    legend_group: str | None = None,
    axis: Literal["left", "right"] | None = None,
    panel: str | None = None,
    id: str | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """An area chart, stacked with ``True``, ``"fill"``, ``"center"``, or
    ``"wiggle"``, or the band between ``y1`` and ``y2`` (along y, ``x1``
    and ``x2``; see ``Chart.area``).

    Stacked by a ``series`` column, every series is drawn on every position
    any of them has: ``stack_gaps`` says what a series counts as where it
    has no row, ``"zero"`` (the default) or ``"interpolate"``.
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
        stack_order=stack_order,
        stack_gaps=stack_gaps,
        dodge=dodge,
        fill=fill,
        fill_opacity=fill_opacity,
        line=line,
        stroke=stroke,
        stroke_width=stroke_width,
        curve=curve,
        label=label,
        legend_group=legend_group,
        axis=axis,
        panel=panel,
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
    fill: str | None = None,
    fill_opacity: float | None = None,
    label: str | None = None,
    legend_group: str | None = None,
    labels: bool | dict[str, Any] = False,
    axis: Literal["left", "right"] | None = None,
    panel: str | None = None,
    id: str | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """A bar chart, grouped or stacked; horizontal when ``y`` is a category."""
    chart, tooltip = _rows_chart_of(data, options)
    return chart.bar(
        x,
        y,
        series=series,
        stack=stack,
        fill=fill,
        fill_opacity=fill_opacity,
        label=label,
        legend_group=legend_group,
        labels=labels,
        axis=axis,
        panel=panel,
        tooltip=tooltip,
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
        id=id,
    )


@helper
def heatmap(
    data: Any,
    x: str | None = None,
    y: str | None = None,
    color: str | None = None,
    *,
    date: str | None = None,
    calendar: Literal["weeks", "months"] | None = None,
    week_start: Literal["mon", "tue", "wed", "thu", "fri", "sat", "sun"] | None = None,
    colors: str | Sequence[str] | None = None,
    color_domain: tuple[float, float] | None = None,
    color_midpoint: float | None = None,
    reduce: Literal["mean", "max", "min"] | None = None,
    x_step: float | None = None,
    y_step: float | None = None,
    x_banded: bool = False,
    y_banded: bool = False,
    label: str | None = None,
    panel: str | None = None,
    id: str | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """A heatmap; ``colors`` is a scheme name or a list of hex colors (see ``Chart.heatmap``)."""
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
        x_step=x_step,
        y_step=y_step,
        x_banded=x_banded,
        y_banded=y_banded,
        label=label,
        panel=panel,
        tooltip=tooltip,
        id=id,
    )


def _histogram_finite(value: Any) -> bool:
    if not isinstance(value, numbers.Real) or isinstance(value, (bool, np.bool_)):
        return False
    try:
        return math.isfinite(float(value))
    except (OverflowError, ValueError):
        return False


def _histogram_bins(
    bins: int | dict[str, float] | Sequence[float] | np.ndarray[Any, Any] | None,
) -> int | dict[str, float] | list[float] | None:
    if bins is None:
        return None
    if isinstance(bins, dict):
        step = bins.get("step")
        if step is None or not _histogram_finite(step) or step <= 0:
            raise ValueError(
                f"histogram bins step: expected a positive number; received {shown(step)}"
            )
        start = bins.get("start")
        if start is not None and not _histogram_finite(start):
            raise ValueError(
                f"histogram bins start: expected a finite number; received {shown(start)}"
            )
        return {"step": float(step), **({"start": float(start)} if start is not None else {})}
    if isinstance(bins, numbers.Real) and not isinstance(bins, (bool, np.bool_)):
        if not _histogram_finite(bins):
            raise ValueError(
                f"histogram bins: expected a whole number of at least 1; received {shown(bins)}"
            )
        value = float(bins)
        if value < 1 or not value.is_integer():
            raise ValueError(
                f"histogram bins: expected a whole number of at least 1; received {shown(bins)}"
            )
        return int(value)
    if isinstance(bins, np.ndarray) and bins.ndim != 1:
        raise ValueError(
            f"histogram bins: expected a 1-D array of edges; received shape {bins.shape}"
        )
    if not isinstance(bins, (Sequence, np.ndarray)) or isinstance(bins, (str, bytes)):
        raise ValueError(
            "histogram bins: expected a whole number, a step/start dict, or a sequence of "
            f"edges; received {shown(bins)}"
        )
    if len(bins) < 2 or len(bins) > 1001:
        raise ValueError(f"histogram bins: expected 2 to 1001 edges; received {len(bins)}")
    edges: list[float] = []
    for i, edge in enumerate(bins):
        if not _histogram_finite(edge):
            raise ValueError(
                f"histogram bins[{i}]: expected a finite number; received {shown(edge)}"
            )
        value = float(edge)
        if edges and not value > edges[-1]:
            raise ValueError(
                f"histogram bins[{i}]: expected an edge above the one before; "
                f"received {value:g} after {edges[-1]:g}"
            )
        edges.append(value)
    return edges


@helper
def histogram(
    data: Any,
    x: str | None = None,
    *,
    y: str | None = None,
    bins: int | dict[str, float] | Sequence[float] | np.ndarray[Any, Any] | None = None,
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
    label: str | None = None,
    legend_group: str | None = None,
    axis: Literal["left", "right"] | None = None,
    panel: str | None = None,
    id: str | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """A histogram of exactly one of ``x`` or ``y``, with optional exact bin
    edges (see ``Chart.histogram``)."""
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
        label=label,
        legend_group=legend_group,
        axis=axis,
        panel=panel,
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
    series: str | None = None,
    fill: str | None = None,
    fill_opacity: float | None = None,
    label: str | None = None,
    legend_group: str | None = None,
    axis: Literal["left", "right"] | None = None,
    panel: str | None = None,
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
        series=series,
        fill=fill,
        fill_opacity=fill_opacity,
        label=label,
        legend_group=legend_group,
        axis=axis,
        panel=panel,
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
    id: str | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """A network of links from ``source`` to ``target``, with ``nodes`` for colors and sizes."""
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
        tooltip=tooltip,
        id=id,
    )
