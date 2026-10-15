"""Encodings and annotation places: builders of the spec's channels, looks
by value, line continuity, coordinates, and labels, in Python's names.

As with the style builders, a dict of a builder's keyword names works
wherever the builder is taken (``{"field": "site"}`` for
``hg.Channel(field="site")``)."""

from __future__ import annotations

import datetime as _dt
import numbers
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, fields
from typing import Any, Literal

import numpy as np

from ._data import listed, shown
from ._derive import Expr
from ._errors import ChartError
from ._guides import Format, format_spec
from ._style import (
    StrokeStyle,
    TextStyle,
    _built,
    _camel,
    _checked,
    _choice,
    _fraction,
    _number,
    _spec,
)

# Point shapes: a symbol column's values take the first eight in turn; "x" is named only.
SYMBOLS = ("circle", "square", "triangle", "diamond", "cross", "star", "wye", "triangle-down", "x")

#: The calendar units a line breaks at the boundaries of, in the chart's time zone.
CALENDAR_UNITS = ("minute", "hour", "day", "week", "month", "year")

Dash = Sequence[float] | Literal["-", "--", ":", "-."]


def dash_spec(value: Any, role: str) -> Any:
    """A dash as the spec takes it: a named dash or a pixel pattern."""
    if value is None:
        return None
    if isinstance(value, str):
        _choice(value, ("-", "--", ":", "-."), role)
        return value
    if isinstance(value, Sequence):
        for i, step in enumerate(value):
            _number(step, f"{role}[{i}]")
        return [float(step) for step in value]
    raise TypeError(
        f'{role}: expected a pixel pattern such as [4, 2], or "-", "--", ":", or "-."; '
        f"received {shown(value)}"
    )


def _constant(value: Any, role: str) -> Any:
    """A channel's constant: text (colors, shapes, dashes), a number, or a pixel pattern."""
    if isinstance(value, str):
        return value
    if isinstance(value, numbers.Real) and not isinstance(value, bool):
        number = float(value)
        return int(number) if number.is_integer() else number
    if isinstance(value, Sequence):
        return dash_spec(value, role)
    raise TypeError(
        f"{role}: expected a color, a shape, a number, or a dash; received {shown(value)}"
    )


@dataclass
class Channel:
    """A value per row: a column's value read through a scale (``field``,
    with ``scale`` naming one of the chart's ``scales``; colors read
    ``"color"`` by default, symbols ``"symbol"``, dashes ``"dash"``), the
    series' names through a scale (``series=True`` with ``scale``: marks
    naming one scale share colors, legend entries, and dodged places by
    their series' names, as a line and the band around it do, whatever data
    each reads), or a constant ``value``. For a condition on each row, give
    ``hg.when(condition, then, otherwise)`` instead."""

    field: str | None = None
    scale: str | None = None
    value: Any = None
    series: bool | None = None

    def __post_init__(self) -> None:
        given = [name for name in ("field", "value", "series") if getattr(self, name) is not None]
        if len(given) != 1:
            raise ChartError("Channel: give field, value, or series=True, one of them")
        if self.field is not None and (not isinstance(self.field, str) or not self.field):
            raise TypeError(f"Channel field: expected a column name; received {shown(self.field)}")
        if self.series is not None and self.series is not True:
            raise TypeError(
                "Channel series: expected True, the series' names through a scale; "
                f"received {shown(self.series)}"
            )
        if self.series and self.scale is None:
            raise ChartError(
                "Channel series: names series through a scale; give scale, the name of one "
                "of the chart's scales"
            )
        if self.scale is not None:
            if self.value is not None:
                raise ChartError(
                    "Channel scale: maps a column's values or the series' names; give field "
                    "or series=True, or drop scale"
                )
            if not isinstance(self.scale, str) or not self.scale:
                raise TypeError(
                    f"Channel scale: expected the name of one of the chart's scales; "
                    f"received {shown(self.scale)}"
                )

    def _spec(self) -> dict[str, Any]:
        if self.series:
            return {"series": True, "scale": self.scale}
        if self.field is not None:
            return {"field": self.field, **({"scale": self.scale} if self.scale else {})}
        return {"value": _constant(self.value, "Channel value")}


#: A channel option: an ``hg.Channel`` (or a dict of its options), or ``hg.when(...)``.
ChannelOption = Channel | Expr | Mapping[str, Any]


def channel_spec(value: Any, role: str) -> Any:
    """A channel as the spec takes it; ``hg.when`` becomes a condition."""
    if value is None:
        return None
    if isinstance(value, Expr):
        json = value.to_json()
        if not (isinstance(json, list) and len(json) == 4 and json[0] == "if"):
            raise TypeError(
                f"{role}: an expression gives a channel only as a condition; give "
                "hg.when(condition, then, otherwise), or hg.Channel(field=...) for a column"
            )
        _, when, then, otherwise = json
        for name, branch in (("then", then), ("otherwise", otherwise)):
            if isinstance(branch, list) or branch is None:
                raise TypeError(
                    f"{role}: a condition's {name} is a constant, such as a color or a number; "
                    "for a column's values give hg.Channel(field=...)"
                )
        return {"condition": {"when": when, "then": then, "otherwise": otherwise}}
    return _built(value, Channel, role)._spec()


@dataclass
class Encodings:
    """A mark's channels, each an ``hg.Channel`` or ``hg.when(...)``.
    ``color`` is the primary paint: a line's stroke, and a bar's or area's
    fill; ``fill`` and ``stroke`` set those paints themselves and win over
    it. Lines take color, stroke, dash, stroke_width, and opacity; bars
    color, fill, stroke, stroke_width, and opacity; areas color, fill,
    stroke, and opacity."""

    color: ChannelOption | None = None
    fill: ChannelOption | None = None
    stroke: ChannelOption | None = None
    dash: ChannelOption | None = None
    symbol: ChannelOption | None = None
    stroke_width: ChannelOption | None = None
    size: ChannelOption | None = None
    opacity: ChannelOption | None = None

    def __post_init__(self) -> None:
        self._spec()

    def _spec(self) -> dict[str, Any]:
        out = {}
        for f in fields(self):
            value = getattr(self, f.name)
            if value is not None:
                out[_camel(f.name)] = channel_spec(value, f"Encodings {f.name}")
        return out

    def _names(self) -> list[str]:
        return [f.name for f in fields(self) if getattr(self, f.name) is not None]


def encodings_spec(value: Any, takes: Sequence[str], role: str) -> Any:
    """A mark's ``encode``, refusing channels the mark does not draw."""
    if value is None:
        return None
    built: Encodings = _built(value, Encodings, f"{role} encode")
    for name in built._names():
        if name not in takes:
            raise ValueError(f"{role} encode: has no {name} channel; give {listed(takes)}")
    return built._spec()


@dataclass
class MarkerStyle:
    """A point drawn at each observation of a line: its ``symbol``,
    ``radius`` in pixels (3 by default), and paint (the line's color by
    default)."""

    symbol: str | None = None
    radius: float | None = None
    fill: str | None = None
    stroke: str | None = None
    stroke_width: float | None = None
    opacity: float | None = None

    def __post_init__(self) -> None:
        if self.symbol is not None:
            _choice(self.symbol, SYMBOLS, "MarkerStyle symbol")
        if self.radius is not None:
            _number(self.radius, "MarkerStyle radius", positive=True)
        _checked(
            self,
            "MarkerStyle",
            colors=("fill", "stroke"),
            widths=("stroke_width",),
            fractions=("opacity",),
        )


@dataclass
class SeriesStyle:
    """How one series looks (for bars, one row): its paint, and its markers
    (lines)."""

    stroke: str | None = None
    stroke_width: float | None = None
    dash: Dash | None = None
    opacity: float | None = None
    fill: str | None = None
    fill_opacity: float | None = None
    stroke_opacity: float | None = None
    marker: MarkerStyle | Mapping[str, Any] | None = None

    def __post_init__(self) -> None:
        _checked(
            self,
            "SeriesStyle",
            colors=("stroke", "fill"),
            widths=("stroke_width",),
            fractions=("opacity", "fill_opacity", "stroke_opacity"),
        )
        self.dash = dash_spec(self.dash, "SeriesStyle dash")
        self.marker = _built(self.marker, MarkerStyle, "SeriesStyle marker")


@dataclass
class StyleMap:
    """Looks by value: each series whose ``field`` (a column constant within
    the series) has a value ``map`` names takes that look. Without
    ``field``, series are named by where they come from: the ``series``
    column's value, or the value column of wide data (``y=["mean",
    "p95"]``). Bars read each row's value."""

    map: Mapping[str, SeriesStyle | Mapping[str, Any]]
    field: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.map, Mapping):
            raise TypeError(
                f'StyleMap map: expected a dict of looks by value, such as {{"Average": '
                f'hg.SeriesStyle(dash="--")}}; received {shown(self.map)}'
            )
        self.map = {
            str(key): _built(style, SeriesStyle, f"StyleMap map[{key!r}]")
            for key, style in self.map.items()
        }
        if self.field is not None and not isinstance(self.field, str):
            raise TypeError(f"StyleMap field: expected a column name; received {shown(self.field)}")


@dataclass
class MarkStyle:
    """How a mark's parts look: looks by value (``by``), its markers
    (lines), and its leader lines (text that moves away from its point).
    The mark's body takes its own options (``stroke``, ``fill``,
    ``stroke_width``, ...)."""

    by: StyleMap | Mapping[str, Any] | None = None
    marker: MarkerStyle | Mapping[str, Any] | None = None
    leader: StrokeStyle | Mapping[str, Any] | None = None

    def __post_init__(self) -> None:
        self.by = _built(self.by, StyleMap, "MarkStyle by")
        self.marker = _built(self.marker, MarkerStyle, "MarkStyle marker")
        self.leader = _built(self.leader, StrokeStyle, "MarkStyle leader")


def mark_style_spec(value: Any, parts: Sequence[str], role: str) -> Any:
    """A mark's ``style``, refusing parts the mark does not have."""
    if value is None:
        return None
    built: MarkStyle = _built(value, MarkStyle, f"{role} style")
    for name in ("marker", "leader"):
        if getattr(built, name) is not None and name not in parts:
            has = listed(("by", *parts))
            raise ValueError(f"{role} style: has no {name}; give {has}")
    return _spec(built)


@dataclass(frozen=True)
class Duration:
    """An elapsed time, in milliseconds, seconds, minutes, and hours (which
    add up). A calendar unit, whose length changes with the calendar, is
    ``hg.Continuity(break_by=...)``'s instead."""

    milliseconds: float = 0
    seconds: float = 0
    minutes: float = 0
    hours: float = 0

    def __post_init__(self) -> None:
        for name in ("milliseconds", "seconds", "minutes", "hours"):
            _number(getattr(self, name), f"Duration {name}")
        if self._milliseconds() <= 0:
            raise ValueError("Duration: expected a positive time; give milliseconds, ..., hours")

    def _milliseconds(self) -> float:
        return (
            self.milliseconds + 1000 * self.seconds + 60_000 * self.minutes + 3_600_000 * self.hours
        )


def _gap_spec(value: Any) -> Any:
    """A maximum gap: a number in the axis' units, or an elapsed time."""
    if isinstance(value, _dt.timedelta):
        value = Duration(milliseconds=value / _dt.timedelta(milliseconds=1))
    elif isinstance(value, np.timedelta64):
        value = Duration(milliseconds=float(value / np.timedelta64(1, "ms")))
    if isinstance(value, Duration):
        return {"milliseconds": value._milliseconds()}
    _number(value, "Continuity max_gap", positive=True)
    return float(value)


@dataclass
class Continuity:
    """Which neighboring observations a line or area connects, decided before
    it is drawn or reduced: never across a missing value, a row ``defined``
    rejects (an expression such as ``hg.col("quality") >= 0.8``), more than
    ``max_gap`` along its positions (a number in their units, or for times
    an ``hg.Duration`` or ``timedelta``), or the boundaries ``break_by``
    names: a calendar unit (``"day"``, in the chart's time zone) or
    ``hg.col(name)``, a change of a column's value."""

    defined: Expr | None = None
    max_gap: Any = None
    break_by: str | Expr | None = None

    def __post_init__(self) -> None:
        if self.defined is not None and not isinstance(self.defined, Expr):
            raise TypeError(
                "Continuity defined: expected an expression such as hg.col('quality') >= 0.8; "
                f"received {shown(self.defined)}"
            )
        if self.max_gap is not None:
            _gap_spec(self.max_gap)
        self._break_spec()

    def _break_spec(self) -> Any:
        by = self.break_by
        if by is None or isinstance(by, str):
            if by is not None:
                _choice(by, CALENDAR_UNITS, "Continuity break_by")
            return by
        json = by.to_json() if isinstance(by, Expr) else None
        if not (isinstance(json, list) and len(json) == 2 and json[0] == "field"):
            raise TypeError(
                f"Continuity break_by: expected a calendar unit ({listed(CALENDAR_UNITS)}) or "
                f"hg.col(name); received {shown(by)}"
            )
        return {"field": json[1]}

    def _spec(self) -> dict[str, Any]:
        spec = {
            "defined": self.defined.to_json() if self.defined is not None else None,
            "maxGap": _gap_spec(self.max_gap) if self.max_gap is not None else None,
            "breakBy": self._break_spec(),
        }
        return {key: value for key, value in spec.items() if value is not None}


def condition_spec(value: Any, role: str) -> Any:
    """A row condition (``where``) as the spec takes it."""
    if value is None:
        return None
    if not isinstance(value, Expr):
        raise TypeError(
            f"{role}: expected an expression such as hg.col('e') < hg.col('limit'); "
            f"received {shown(value)}"
        )
    return value.to_json()


# Coordinates -------------------------------------------------------------------

Frame = Literal["plot", "chart"]


def _offset(value: Any, role: str) -> Any:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, numbers.Real):
        raise TypeError(f"{role} offset: expected pixels; received {shown(value)}")
    return float(value)


@dataclass(frozen=True)
class Fraction:
    """A place a share of the plot (or with ``frame="chart"``, the chart)
    along an axis: 0 at its left or bottom, 1 at its right or top, then
    moved ``offset`` pixels (right for x, down for y)."""

    value: float
    frame: Frame | None = None
    offset: float | None = None

    def __post_init__(self) -> None:
        if isinstance(self.value, bool) or not isinstance(self.value, numbers.Real):
            raise TypeError(
                f"Fraction: expected a number such as 0.03; received {shown(self.value)}"
            )
        if self.frame is not None:
            _choice(self.frame, ("plot", "chart"), "Fraction frame")

    def _spec(self) -> dict[str, Any]:
        spec = {"fraction": float(self.value), "frame": self.frame}
        spec["offset"] = _offset(self.offset, "Fraction")
        return {key: value for key, value in spec.items() if value is not None}


@dataclass(frozen=True)
class Pixels:
    """A place ``value`` pixels from the plot's (or the chart's) left or top
    edge, down for y as on screens, then moved ``offset`` pixels."""

    value: float
    frame: Frame | None = None
    offset: float | None = None

    def __post_init__(self) -> None:
        if isinstance(self.value, bool) or not isinstance(self.value, numbers.Real):
            raise TypeError(f"Pixels: expected a number of pixels; received {shown(self.value)}")
        if self.frame is not None:
            _choice(self.frame, ("plot", "chart"), "Pixels frame")

    def _spec(self) -> dict[str, Any]:
        spec = {"px": float(self.value), "frame": self.frame}
        spec["offset"] = _offset(self.offset, "Pixels")
        return {key: value for key, value in spec.items() if value is not None}


@dataclass(frozen=True)
class DataPosition:
    """A value on an axis' scale (a number, a datetime, or a category's
    value), or with ``field`` each row's value of a column, then moved
    ``offset`` pixels. ``scale`` names the scale (``"x"``, ``"y"``, or
    ``"y_right"``; the axis' own by default)."""

    value: Any = None
    field: str | None = None
    scale: str | None = None
    offset: float | None = None

    def __post_init__(self) -> None:
        if (self.value is None) == (self.field is None):
            raise ValueError("DataPosition: give a value or field, one of them")
        if self.scale is not None:
            _choice(self.scale, ("x", "y", "y_right"), "DataPosition scale")

    def _spec(self) -> dict[str, Any]:
        scale = {"y_right": "yRight"}.get(self.scale or "", self.scale)
        if self.field is not None:
            spec: dict[str, Any] = {"field": self.field}
        elif isinstance(self.value, str):
            spec = {"data": self.value}
        else:
            spec = {"data": instant(self.value, "DataPosition value")}
        spec["scale"] = scale
        spec["offset"] = _offset(self.offset, "DataPosition")
        return {key: value for key, value in spec.items() if value is not None}


def instant(value: Any, role: str) -> float:
    """A number as itself, a datetime as epoch milliseconds."""
    if isinstance(value, numbers.Real) and not isinstance(value, bool):
        return float(value)
    from ._data import _time_ms

    try:
        return _time_ms(value)
    except TypeError:
        raise TypeError(
            f"{role}: expected a number or a datetime; received {shown(value)}"
        ) from None


#: An annotation's place along an axis: a number or datetime, a column name,
#: or an ``hg.Fraction``, ``hg.Pixels``, or ``hg.DataPosition``.
Coordinate = str | float | _dt.date | Fraction | Pixels | DataPosition


def coordinate_spec(value: Any, role: str) -> Any:
    """A place as the spec takes it: column names pass through, datetimes
    become epoch milliseconds, and coordinates their tagged forms."""
    if value is None or isinstance(value, str):
        return value
    if isinstance(value, (Fraction, Pixels, DataPosition)):
        return value._spec()
    return instant(value, role)


def coordinate_field(value: Any) -> str | None:
    """The column a place reads, if any."""
    if isinstance(value, str):
        return value
    return value.field if isinstance(value, DataPosition) else None


@dataclass(frozen=True)
class Position:
    """A point: a place on each axis, which may mix kinds (``x`` a fraction
    of the plot's width, ``y`` a data value)."""

    x: Coordinate
    y: Coordinate

    def _spec(self) -> dict[str, Any]:
        return {"x": tagged_spec(self.x, "Position x"), "y": tagged_spec(self.y, "Position y")}


def tagged_spec(value: Any, role: str) -> dict[str, Any]:
    """A place in its tagged form: a column name as a field, a value as data."""
    if isinstance(value, str):
        return {"field": value}
    spec = coordinate_spec(value, role)
    return spec if isinstance(spec, dict) else {"data": spec}


# Labels --------------------------------------------------------------------------


@dataclass
class LabelPlace:
    """Where a label goes on what it labels: ``attachment`` along it (a rule's
    ``"start"``, ``"center"``, or ``"end"``, left to right or top to bottom;
    along a region's ``side``, top by default), ``outside`` the plot (a
    rule's label beside the axis, in room the chart keeps for it unless
    ``reserve=False``), and moved ``offset`` pixels away."""

    attachment: Literal["start", "center", "end"] | None = None
    side: Literal["top", "right", "bottom", "left"] | None = None
    outside: bool | None = None
    reserve: bool | None = None
    offset: float | None = None

    def __post_init__(self) -> None:
        if self.attachment is not None:
            _choice(self.attachment, ("start", "center", "end"), "LabelPlace attachment")
        if self.side is not None:
            _choice(self.side, ("top", "right", "bottom", "left"), "LabelPlace side")
        for name in ("outside", "reserve"):
            value = getattr(self, name)
            if value is not None and not isinstance(value, bool):
                raise TypeError(
                    f"LabelPlace {name}: expected True or False; received {shown(value)}"
                )
        if self.offset is not None:
            _offset(self.offset, "LabelPlace")


@dataclass
class Label:
    """A label: constant ``text``, or each row's ``field`` (numbers written
    with ``format``, an ``hg.Format`` or Intl options), styled by ``style``
    (an ``hg.TextStyle``) and placed by ``place`` (an ``hg.LabelPlace``)."""

    text: str | None = None
    field: str | None = None
    format: Format | Mapping[str, Any] | None = None
    style: TextStyle | Mapping[str, Any] | None = None
    place: LabelPlace | Mapping[str, Any] | None = None

    def __post_init__(self) -> None:
        if (self.text is None) == (self.field is None):
            raise ValueError("Label: give text or field, one of them")
        self.style = _built(self.style, TextStyle, "Label style")
        self.place = _built(self.place, LabelPlace, "Label place")

    def _spec(self) -> dict[str, Any]:
        spec = {
            "text": self.text,
            "field": self.field,
            "format": format_spec(self.format, "Label format"),
            "style": _spec(self.style) if self.style is not None else None,
            "place": _spec(self.place) if self.place is not None else None,
        }
        return {key: value for key, value in spec.items() if value is not None}


def label_spec(value: Any, role: str, *, places: bool = True) -> Any:
    """A ``label`` option as the spec takes it: text, or an ``hg.Label``."""
    if value is None or isinstance(value, str):
        return value
    built: Label = _built(value, Label, f"{role} label")
    if not places and built.place is not None:
        raise ValueError(f"{role} label: text goes where at says; drop place")
    return built._spec()


@dataclass
class BarLabels:
    """Bars' value labels: each bar's value (or with ``field``, a column's),
    written with ``format`` (an ``hg.Format`` or Intl options), styled by
    ``style`` (black or white by contrast with the bar unless its color is
    set), on bars at least ``min_length`` pixels long, placed by ``place``:
    an ``hg.LabelPlace`` with ``outside=False`` puts them inside the bars at
    their ``attachment`` (``"start"``, ``"center"``, or ``"end"``, the
    default); by default they go past each bar's end, and inside stacked
    bars' segments."""

    field: str | None = None
    format: Format | Mapping[str, Any] | None = None
    style: TextStyle | Mapping[str, Any] | None = None
    min_length: float | None = None
    place: LabelPlace | Mapping[str, Any] | None = None

    def __post_init__(self) -> None:
        self.style = _built(self.style, TextStyle, "BarLabels style")
        if self.min_length is not None:
            _number(self.min_length, "BarLabels min_length")
        self.place = _built(self.place, LabelPlace, "BarLabels place")
        if self.place is not None:
            for name in ("side", "reserve", "offset"):
                if getattr(self.place, name) is not None:
                    raise ValueError(
                        f"BarLabels place: bars' labels take attachment and outside; drop {name}"
                    )

    def _spec(self) -> dict[str, Any]:
        spec = {
            "field": self.field,
            "format": format_spec(self.format, "BarLabels format"),
            "style": _spec(self.style) if self.style is not None else None,
            "minLength": self.min_length,
            "place": _spec(self.place) if self.place is not None else None,
        }
        return {key: value for key, value in spec.items() if value is not None}


def fraction_option(value: Any, role: str) -> Any:
    """An opacity option, refused outside 0 to 1."""
    if value is not None:
        _fraction(value, role)
    return value


@dataclass
class Stack:
    """How an area stack piles its series: ``offset`` (``"zero"``,
    ``"fill"`` for shares of each position's total, ``"center"`` or
    ``"wiggle"`` for streams), the layers' ``order`` (``"input"``, or
    ``"inside-out"``, the largest in the middle, for the nonnegative
    offsets), and ``gaps``: what a series of a ``series`` column counts as
    where others have rows and it has none, ``"zero"`` or ``"interpolate"``
    (the straight line between its rows on either side)."""

    offset: Literal["zero", "fill", "center", "wiggle"] | None = None
    order: Literal["input", "inside-out"] | None = None
    gaps: Literal["zero", "interpolate"] | None = None

    def __post_init__(self) -> None:
        if self.offset is not None:
            _choice(self.offset, ("zero", "fill", "center", "wiggle"), "Stack offset")
        if self.order is not None:
            _choice(self.order, ("input", "inside-out"), "Stack order")
            if self.order == "inside-out" and self.offset in (None, "zero"):
                raise ValueError(
                    'Stack order: inside-out orders nonnegative stacks; give offset="fill", '
                    '"center", or "wiggle", or drop order'
                )
        if self.gaps is not None:
            _choice(self.gaps, ("zero", "interpolate"), "Stack gaps")
