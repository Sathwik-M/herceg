"""Scales and guides: builders of the spec's tick, format, scale, axis,
legend, and colorbar types, in Python's names.

``hg.axis``, ``hg.legend``, and ``hg.colorbar`` make the guides a chart's
``guides`` lists; ``hg.Ticks``, ``hg.Format``, ``hg.Tick``, ``hg.TickLabels``,
and ``hg.TickLayer`` say how axes and colorbars draw their ticks. Anywhere a
builder is taken, a dict of the same keyword names works too."""

from __future__ import annotations

import datetime as _dt
import math
import numbers
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, fields
from typing import Any, Literal

from ._data import _time_ms, listed, shown
from ._errors import ChartError
from ._style import (
    AXIS_ROLES,
    LEGEND_ROLES,
    Place,
    Style,
    TextStyle,
    _built,
    _camel,
    _choice,
    _number,
    _spec,
    style_spec,
)

Scope = Literal["chart", "panel", "row", "column"]
Collision = Literal["show", "hide", "stagger", "wrap"]
Channel = Literal["series", "color", "size", "symbol"]

_UNITS = ("millisecond", "second", "minute", "hour", "day", "week", "month", "year")
_INTERVAL = re.compile(r"^(?:(\d+) )?([a-z]+?)s?$")
_NUMBER = re.compile(r"^([-+( ])?(,)?(?:\.(\d{1,2}))?(~)?([defgs%]?)$")
_DIRECTIVE = re.compile(r"%(-?)(.?)")
_NUMBER_DIRECTIVES = "YymdeHIMSL"
_NAME_DIRECTIVES = "aAbBpz%"


def _fields(builder: Any) -> dict[str, Any]:
    """A builder's set options in camelCase, each as the spec takes it."""
    return {
        _camel(f.name): _spec(getattr(builder, f.name))
        for f in fields(builder)
        if getattr(builder, f.name) is not None
    }


def _instant(value: Any, role: str) -> float:
    """A number, or a time as epoch milliseconds (naive datetimes are UTC)."""
    if isinstance(value, (_dt.datetime, _dt.date)) or type(value).__name__ in (
        "datetime64",
        "Timestamp",
    ):
        return _time_ms(value)
    if isinstance(value, bool) or not isinstance(value, numbers.Real) or not math.isfinite(value):
        raise ValueError(f"{role}: expected a finite number or a datetime; received {shown(value)}")
    return float(value)


def _interval(value: Any, role: str) -> Any:
    """A time interval as the spec takes it: calendar steps, or elapsed milliseconds."""
    if isinstance(value, _dt.timedelta):
        milliseconds = value / _dt.timedelta(milliseconds=1)
        if not milliseconds > 0:
            raise ValueError(f"{role}: expected a positive timedelta; received {value!r}")
        return {"milliseconds": milliseconds}
    if isinstance(value, str):
        match = _INTERVAL.match(value.strip())
        if not match or match.group(2) not in _UNITS:
            raise ValueError(
                f'{role}: {shown(value)} is not a time interval; write a unit ("hour", "day", '
                '"week", "month", "year"), a count and a unit ("6 hours", "15 minutes"), '
                "or a timedelta for elapsed time"
            )
        step = int(match.group(1) or 1)
        unit = match.group(2)
        if step < 1:
            raise ValueError(
                f"{role}: {shown(value)} steps by {step}; give a count of 1 or more, "
                'such as "6 hours"'
            )
        return {"unit": unit, "step": step} if step != 1 else {"unit": unit}
    _number(value, role, positive=True)
    return value


@dataclass
class Ticks:
    """Which ticks an axis draws: about ``count`` round values; one ``every``
    so often (a number on number axes, from ``anchor``; on time axes a
    calendar interval in the chart's time zone, ``"day"`` or ``"6 hours"``,
    or a ``timedelta`` of elapsed time); or exactly ``values`` (numbers or
    datetimes). Category axes take a count only. Give one of them::

        hg.Ticks(every="6 hours")
        hg.Ticks(values=[15, 95])
    """

    count: int | None = None
    every: float | str | _dt.timedelta | None = None
    anchor: float | _dt.datetime | None = None
    values: Sequence[Any] | None = None

    def __post_init__(self) -> None:
        given = [name for name in ("count", "every", "values") if getattr(self, name) is not None]
        if len(given) != 1:
            raise ValueError(
                f"Ticks: give one of count, every, or values; received {listed(given) or 'none'}"
            )
        if self.count is not None:
            _number(self.count, "Ticks count", positive=True)
        if self.anchor is not None and self.every is None:
            raise ValueError("Ticks anchor: starts the steps of every; give every or drop anchor")
        if isinstance(self.every, str) and self.anchor is not None:
            raise ValueError(
                "Ticks anchor: calendar steps start at calendar boundaries; drop anchor, "
                "or step by a timedelta"
            )

    def _spec(self) -> Any:
        if self.count is not None:
            return self.count
        if self.values is not None:
            if isinstance(self.values, (str, bytes)) or not isinstance(self.values, Sequence):
                raise TypeError(f"Ticks values: expected a list; received {shown(self.values)}")
            return {
                "values": [
                    value if isinstance(value, str) else _instant(value, f"Ticks values[{i}]")
                    for i, value in enumerate(self.values)
                ]
            }
        spec: dict[str, Any] = {"every": _interval(self.every, "Ticks every")}
        if self.anchor is not None:
            spec["anchor"] = _instant(self.anchor, "Ticks anchor")
        return spec


def ticks_spec(value: Any, role: str) -> Any:
    """Ticks as the spec takes them: a count, or an ``hg.Ticks`` (or a dict of its options)."""
    if value is None:
        return None
    if callable(value):
        raise TypeError(
            f"{role}: Python functions cannot travel in a chart; give a count or hg.Ticks"
        )
    if isinstance(value, numbers.Real) and not isinstance(value, bool):
        _number(value, role, positive=True)
        return value
    return _built(value, Ticks, role)._spec()


def _check_number_pattern(pattern: str, role: str) -> None:
    match = _NUMBER.match(pattern)
    if not match:
        raise ValueError(
            f"{role}: {shown(pattern)} is not a number pattern herceg reads; write "
            '[sign][,][.precision][~][type] with type d, f, e, g, s, or %, such as ",.2f"'
        )
    if match.group(5) in ("g", "s") and match.group(3) == "0":
        raise ValueError(f"{role}: {shown(pattern)} asks for 0 significant digits; give 1 or more")


def _check_time_pattern(pattern: str, role: str) -> None:
    for found in _DIRECTIVE.finditer(pattern):
        flag, directive = found.group(1), found.group(2)
        number = directive != "" and directive in _NUMBER_DIRECTIVES
        if not (number or (directive != "" and directive in _NAME_DIRECTIVES)) or (
            flag and not number
        ):
            raise ValueError(
                f"{role}: {shown(found.group(0))} at character {found.start() + 1} of "
                f"{shown(pattern)} is not a time directive herceg reads; use %Y %y %m %d %e "
                '%H %I %M %S %L %p %a %A %b %B %z, "-" for no padding (%-d), and %% for "%"'
            )


@dataclass
class Format:
    """How values are written by pattern: ``number``, a d3-format pattern
    (``",.2f"``, ``".1%"``, ``"~s"``), or ``time``, a strftime pattern
    (``"%b %d %H:%M"``, ``"%-d %b"``) in the chart's time zone. Intl options
    are a dict of their own names, ``{"maximumFractionDigits": 1}``."""

    number: str | None = None
    time: str | None = None

    def __post_init__(self) -> None:
        if (self.number is None) == (self.time is None):
            raise ValueError("Format: give number or time, one of them")
        for name in ("number", "time"):
            value = getattr(self, name)
            if value is not None and not isinstance(value, str):
                raise TypeError(
                    f"Format {name}: expected a pattern string; received {shown(value)}"
                )
        if self.number is not None:
            _check_number_pattern(self.number, "Format number")
        if self.time is not None:
            _check_time_pattern(self.time, "Format time")

    def _spec(self) -> dict[str, str]:
        return {"number": self.number} if self.number is not None else {"time": self.time or ""}


def format_spec(value: Any, role: str) -> Any:
    """A format as the spec takes it: Intl options (a dict of Intl names), or an ``hg.Format``."""
    if value is None:
        return None
    if callable(value):
        raise TypeError(
            f"{role}: Python functions cannot travel in a chart; give hg.Format or Intl options"
        )
    if isinstance(value, Format):
        return value._spec()
    if isinstance(value, Mapping) and set(value) & {"number", "time"}:
        return Format(**value)._spec()
    if isinstance(value, Mapping):
        return dict(value)
    raise TypeError(
        f"{role}: expected hg.Format or a dict of Intl options; received {shown(value)}"
    )


@dataclass
class Tick:
    """Tick marks: ``direction`` out from the plot (``"out"``, the default),
    in over it (``"in"``), or across the axis line (``"cross"``), and their
    ``length`` in pixels."""

    direction: Literal["out", "in", "cross"] | None = None
    length: float | None = None

    def __post_init__(self) -> None:
        if self.direction is not None:
            _choice(self.direction, ("out", "in", "cross"), "Tick direction")
        if self.length is not None:
            _number(self.length, "Tick length")


@dataclass
class TickLabels:
    """How tick labels are placed: ``rotation`` in degrees clockwise, from
    -90 to 90 (a list tries each angle in turn, keeping the first at which
    labels fit), what
    labels that would overlap do (``collision``: ``"show"``, ``"hide"``,
    ``"stagger"``, ``"wrap"``), their ``row`` (0 by the axis line, 1
    beyond), ``priority`` where they collide, and whether labels repeating
    the one before them show (``duplicates``)."""

    rotation: float | Sequence[float] | None = None
    collision: Collision | None = None
    row: int | None = None
    priority: float | None = None
    duplicates: Literal["hide", "show"] | None = None

    def __post_init__(self) -> None:
        if self.collision is not None:
            _choice(self.collision, ("show", "hide", "stagger", "wrap"), "TickLabels collision")
        if self.duplicates is not None:
            _choice(self.duplicates, ("hide", "show"), "TickLabels duplicates")
        if self.row is not None and (
            isinstance(self.row, bool) or not isinstance(self.row, int) or self.row < 0
        ):
            raise ValueError(f"TickLabels row: expected 0, 1, 2, ...; received {shown(self.row)}")
        turns = (
            self.rotation
            if isinstance(self.rotation, Sequence) and not isinstance(self.rotation, str)
            else [self.rotation]
        )
        for turn in turns:
            if turn is not None and not (
                isinstance(turn, numbers.Real) and not isinstance(turn, bool) and -90 <= turn <= 90
            ):
                raise ValueError(
                    "TickLabels rotation: expected degrees from -90 (reading up) to 90 "
                    f"(reading down); received {shown(turn)}"
                )

    def _spec(self) -> dict[str, Any]:
        spec = _fields(self)
        rotation = self.rotation
        # A list of angles is tried in turn.
        if isinstance(rotation, Sequence):
            spec["rotation"] = {"candidates": list(rotation)}
        return spec


def _marks(value: Any, kind: type[Any], role: str) -> Any:
    """Tick marks or labels as the spec takes them: ``False`` for none, or the builder's spec."""
    if value is None or value is False:
        return value
    built = _built(value, kind, role)
    return built._spec() if hasattr(built, "_spec") else _spec(built)


@dataclass
class TickLayer:
    """A layer of an axis' ticks, beside its own: minor ticks, or a row of
    day boundaries. ``id`` names it ("major" is the axis' own); ``ticks``,
    ``format``, ``tick``, and ``labels`` as an axis takes them (``False``
    for no tick marks or labels), and ``style`` its ``tick`` and
    ``tick_label`` roles::

        hg.TickLayer(id="day", ticks=hg.Ticks(every="day"),
                     format=hg.Format(time="%b %-d"), labels=hg.TickLabels(row=1))
    """

    id: str
    ticks: int | Ticks | Mapping[str, Any] | None = None
    format: Format | Mapping[str, Any] | None = None
    tick: Tick | Literal[False] | Mapping[str, Any] | None = None
    labels: TickLabels | Literal[False] | Mapping[str, Any] | None = None
    style: Style | Mapping[str, Any] | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.id, str) or self.id in ("", "major"):
            raise ValueError(
                f'TickLayer id: expected a name other than "" and "major", the axis\' own ticks; '
                f"received {shown(self.id)}"
            )

    def _spec(self) -> dict[str, Any]:
        spec = {
            "id": self.id,
            "ticks": ticks_spec(self.ticks, "TickLayer ticks"),
            "format": format_spec(self.format, "TickLayer format"),
            "tick": _marks(self.tick, Tick, "TickLayer tick"),
            "labels": _marks(self.labels, TickLabels, "TickLayer labels"),
            "style": style_spec(self.style, "TickLayer style", ("tick", "tick_label")),
        }
        return {key: value for key, value in spec.items() if value is not None}


@dataclass
class Scale:
    """A position scale's settings in the chart's ``scales``: ``"x"``,
    ``"y"``, and ``"y_right"``, over the short forms ``x=``, ``y=``,
    ``y_right=``. Scales of categories are ``hg.OrdinalScale``."""

    type: Literal["linear", "log", "time"] | None = None
    domain: Sequence[Any] | None = None
    nice: bool | None = None
    zero: bool | None = None
    scope: Scope | None = None
    tooltip_format: Format | Mapping[str, Any] | None = None

    def __post_init__(self) -> None:
        if self.type is not None:
            _choice(self.type, ("linear", "log", "time"), "Scale type")
        if self.scope is not None:
            _choice(self.scope, ("chart", "panel", "row", "column"), "Scale scope")
        if self.domain is not None and len(self.domain) != 2:
            raise ValueError(
                f"Scale domain: a position scale's domain is (low, high); received "
                f"{shown(self.domain)}"
            )

    def _spec(self) -> dict[str, Any]:
        domain = self.domain
        spec = {
            "type": self.type,
            "domain": [_instant(v, "Scale domain") for v in domain] if domain is not None else None,
            "nice": self.nice,
            "zero": self.zero,
            "scope": self.scope,
            "tooltipFormat": format_spec(self.tooltip_format, "Scale tooltip_format"),
        }
        return {key: value for key, value in spec.items() if value is not None}


@dataclass
class OrdinalScale:
    """A scale of categories in the chart's ``scales``, which gives every
    value one output (a color, shape, dash, or number) in every mark and
    panel reading it, from any data, and keeps it while the data streams.

    Under the name ``"color"`` it colors every mark's series and color
    columns. Under another, marks read it by name:
    ``color=hg.Channel(field="region", scale="region")`` for a column's
    values, ``hg.Channel(series=True, scale="fit")`` for the series' names
    (which joins marks of different data, a line and the band around it,
    in one legend entry). Without ``scales``, a value's color follows its
    column of its data, in every mark and panel reading it.

    ``map`` fixes outputs by value; others take the theme's palette by
    their place in the ``domain``: the given values in that order (others
    take ``unknown``), or else the columns' values, a categorical's own
    order first."""

    domain: Sequence[str] | None = None
    map: Mapping[str, Any] | None = None
    unknown: Any = None

    def __post_init__(self) -> None:
        if self.domain is not None and (
            isinstance(self.domain, str) or any(not isinstance(v, str) for v in self.domain)
        ):
            raise TypeError(
                "OrdinalScale domain: a scale of categories' domain is their values, "
                f'such as ["A", "B"]; received {shown(self.domain)}'
            )
        if self.map is not None and not isinstance(self.map, Mapping):
            raise TypeError(
                'OrdinalScale map: expected a dict of outputs by value, such as {"A": "#00ab41"}; '
                f"received {shown(self.map)}"
            )

    def _spec(self) -> dict[str, Any]:
        out: dict[str, Any] = {"type": "ordinal"}
        if self.domain is not None:
            out["domain"] = list(self.domain)
        if self.map is not None:
            out["map"] = {str(key): _output(value) for key, value in self.map.items()}
        if self.unknown is not None:
            out["unknown"] = _output(self.unknown)
        return out


def _output(value: Any) -> Any:
    """A scale's output: a color, a shape, a dash, or a number."""
    if isinstance(value, (list, tuple)):
        return [float(step) for step in value]
    return value


def scales_spec(value: Any) -> Any:
    """A chart's ``scales`` as the spec takes them: ``hg.Scale`` for the
    positions ``"x"``, ``"y"``, and ``"y_right"``, ``hg.OrdinalScale`` (or
    dicts of their options) for scales of categories, by name."""
    if value is None:
        return None
    if not isinstance(value, Mapping):
        raise TypeError(
            f'Chart scales: expected a dict such as {{"y": hg.Scale(...)}}; received {shown(value)}'
        )
    names = {"x": "x", "y": "y", "y_right": "yRight"}
    out = {}
    for name, scale in value.items():
        role = f"Chart scales {name}"
        if name in names:
            if isinstance(scale, OrdinalScale):
                raise ChartError(
                    f"{role}: places values on an axis; give an hg.Scale, or name the "
                    "OrdinalScale otherwise"
                )
            out[names[name]] = _built(scale, Scale, role)._spec()
        else:
            if isinstance(scale, Scale):
                raise ChartError(
                    f"{role}: expected an hg.OrdinalScale, a scale of categories; "
                    f"marks place values on {listed(tuple(names))}"
                )
            out[name] = _built(scale, OrdinalScale, role)._spec()
    return out


@dataclass
class ScaleRef:
    """A scale a mark owns: the mark's ``id`` (``mark``) and the ``channel``
    (``"series"`` colors, a ``"color"`` field's ramp or colors, ``"size"``,
    or ``"symbol"``)."""

    mark: str
    channel: Channel

    def __post_init__(self) -> None:
        if not isinstance(self.mark, str) or not self.mark:
            raise TypeError(f"ScaleRef mark: expected a mark's id; received {shown(self.mark)}")
        _choice(self.channel, ("series", "color", "size", "symbol"), "ScaleRef channel")


@dataclass
class Swatch:
    """A legend entry's swatch: a ``"line"`` (``stroke``, ``stroke_width``,
    ``dash``), a ``"rect"`` (``fill``, and ``stroke`` for an outline), a
    ``"circle"`` (``fill``, ``stroke``, and ``size``, pixels across), or a
    ``"composite"`` of ``parts``; ``opacity`` from 0 to 1. An entry shows
    another symbol by its ``sample``, a mark that draws it."""

    type: Literal["line", "rect", "circle", "composite"]
    stroke: str | None = None
    fill: str | None = None
    stroke_width: float | None = None
    dash: str | Sequence[float] | None = None
    size: float | None = None
    opacity: float | None = None
    parts: Sequence[Swatch | Mapping[str, Any]] | None = None

    def __post_init__(self) -> None:
        _choice(self.type, tuple(_SWATCH_FIELDS), "Swatch type")
        needs = {"line": "stroke", "rect": "fill", "circle": "fill", "composite": "parts"}[
            self.type
        ]
        if getattr(self, needs) is None:
            raise ValueError(f"Swatch {needs}: a {self.type} swatch needs {needs}; give it")
        takes = _SWATCH_FIELDS[self.type]
        for name in ("stroke", "fill", "stroke_width", "dash", "size", "opacity", "parts"):
            if getattr(self, name) is not None and name not in takes:
                raise ValueError(
                    f"Swatch {name}: a {self.type} swatch takes {listed(takes)}; drop {name}"
                )
        if self.parts is not None:
            self.parts = [_built(part, Swatch, "Swatch parts") for part in self.parts]

    def _spec(self) -> dict[str, Any]:
        spec = _fields(self)
        if self.dash is not None and not isinstance(self.dash, str):
            spec["dash"] = list(self.dash)
        return spec


#: What each type of swatch takes.
_SWATCH_FIELDS: dict[str, tuple[str, ...]] = {
    "line": ("stroke", "stroke_width", "dash", "opacity"),
    "rect": ("fill", "stroke", "opacity"),
    "circle": ("fill", "stroke", "size", "opacity"),
    "composite": ("parts",),
}


@dataclass
class LegendEntry:
    """A legend entry of your own: its ``key`` and ``label``, a ``swatch``
    (an ``hg.Swatch``) or ``sample``, the id of a mark whose look it shows,
    and ``targets``, the ids of marks clicking it hides and shows."""

    key: str
    label: str
    swatch: Swatch | Mapping[str, Any] | None = None
    sample: str | None = None
    targets: Sequence[str] | None = None

    def __post_init__(self) -> None:
        for name in ("key", "label"):
            if not isinstance(getattr(self, name), str):
                raise TypeError(
                    f"LegendEntry {name}: expected a string; received {shown(getattr(self, name))}"
                )
        if self.swatch is not None and self.sample is not None:
            raise ValueError("LegendEntry: a swatch or a sample, not both")
        self.swatch = _built(self.swatch, Swatch, "LegendEntry swatch")

    def _spec(self) -> dict[str, Any]:
        spec: dict[str, Any] = {"key": self.key, "label": self.label}
        if isinstance(self.swatch, Swatch):
            spec["swatch"] = self.swatch._spec()
        if self.sample is not None:
            spec["sample"] = {"mark": self.sample}
        if self.targets is not None:
            spec["targets"] = [{"mark": mark} for mark in self.targets]
        return spec


def _title(value: Any, role: str) -> Any:
    if value is None or isinstance(value, str):
        return value
    if isinstance(value, Mapping):
        value = dict(value)
        text = value.pop("text", None)
        style = value.pop("style", None)
        if value or not isinstance(text, str):
            raise ValueError(f"{role}: expected a string, or a dict with text and style")
        return {"text": text, **({"style": _spec(_built(style, TextStyle, role))} if style else {})}
    raise TypeError(f"{role}: expected a string; received {shown(value)}")


def legend_layout(builder: Any, role: str) -> dict[str, Any]:
    """The layout options of a legend (the chart's ``legend=``, or an
    ``hg.legend``), as the spec takes them."""
    if builder.columns is not None and builder.rows is not None:
        raise ValueError(f"{role} rows: columns or rows, not both; drop one")
    for name in ("columns", "rows"):
        value = getattr(builder, name)
        if value is not None and (
            isinstance(value, bool) or not isinstance(value, int) or value < 1
        ):
            raise ValueError(
                f"{role} {name}: expected a whole number of at least 1; received {shown(value)}"
            )
    if builder.order is not None:
        _choice(builder.order, ("row", "column"), f"{role} order")
    if builder.swatches is not None:
        _choice(builder.swatches, ("mark",), f"{role} swatches")
    entries = builder.entries
    spec = {
        "place": _spec(_built(builder.place, Place, f"{role} place")),
        "columns": builder.columns,
        "rows": builder.rows,
        "order": builder.order,
        "title": _title(builder.title, f"{role} title"),
        "entries": [_built(entry, LegendEntry, f"{role} entries")._spec() for entry in entries]
        if entries is not None
        else None,
        "swatches": builder.swatches,
        "style": style_spec(builder.style, f"{role} style", LEGEND_ROLES),
    }
    return {key: value for key, value in spec.items() if value is not None}


@dataclass
class AxisGuide:
    """An axis the chart's ``guides`` lists (see ``hg.axis``)."""

    scale: Literal["x", "y", "y_right"]
    id: str | None = None
    place: Place | Mapping[str, Any] | None = None
    title: str | None = None
    ticks: int | Ticks | Mapping[str, Any] | None = None
    format: Format | Mapping[str, Any] | None = None
    tick: Tick | Literal[False] | Mapping[str, Any] | None = None
    labels: TickLabels | Literal[False] | Mapping[str, Any] | None = None
    line: bool | None = None
    grid: bool | None = None
    layers: Sequence[TickLayer | Mapping[str, Any]] | None = None
    show: bool | None = None
    style: Style | Mapping[str, Any] | None = None

    def __post_init__(self) -> None:
        _choice(self.scale, ("x", "y", "y_right"), "axis scale")
        self.place = _built(self.place, Place, "axis place")
        if isinstance(self.place, Place):
            sides = {"x": ("bottom", "top"), "y": ("left", "right"), "y_right": ("right",)}
            side = self.place.side
            if side is None:
                raise ValueError("axis place: an axis goes on a side; give side")
            if side not in sides[self.scale]:
                raise ValueError(
                    f"axis place: {self.scale} axes go on the {listed(sides[self.scale])} "
                    f"side; received {shown(side)}"
                )
        self.layers = (
            [_built(layer, TickLayer, "axis layers") for layer in self.layers]
            if self.layers is not None
            else None
        )

    def _spec(self) -> dict[str, Any]:
        spec = {
            "type": "axis",
            "id": self.id,
            "scale": "yRight" if self.scale == "y_right" else self.scale,
            "place": {"side": self.place.side} if isinstance(self.place, Place) else None,
            "title": self.title,
            "ticks": ticks_spec(self.ticks, "axis ticks"),
            "format": format_spec(self.format, "axis format"),
            "tick": _marks(self.tick, Tick, "axis tick"),
            "labels": _marks(self.labels, TickLabels, "axis labels"),
            "line": self.line,
            "grid": self.grid,
            "layers": [_built(layer, TickLayer, "axis layers")._spec() for layer in self.layers]
            if self.layers is not None
            else None,
            "show": self.show,
            "style": style_spec(self.style, "axis style", AXIS_ROLES),
        }
        return {key: value for key, value in spec.items() if value is not None}


def axis(scale: Literal["x", "y", "y_right"], **options: Any) -> AxisGuide:
    """An axis of ``scale`` (``"x"``, ``"y"``, ``"y_right"``), for the chart's
    ``guides``: on its scale's default side it takes the place of the
    automatic axis, its unset settings taken from ``x=``, ``y=``, or
    ``y_right=``; elsewhere (``place=hg.Place(side="top")``) it is drawn too.
    ``ticks``, ``format``, ``tick``, and ``labels`` are its own ticks';
    ``layers`` adds layers of ticks; ``line`` draws its line::

        hg.axis("x", layers=[hg.TickLayer(id="day", ticks=hg.Ticks(every="day"),
                                          labels=hg.TickLabels(row=1))])
    """
    return AxisGuide(scale=scale, **options)


@dataclass
class LegendOptions:
    """The chart's legend (``legend=``): where it goes (``place``, an
    ``hg.Place``; above the plots by default), its entries in ``columns`` or
    ``rows`` (filled by ``order``, ``"row"`` or ``"column"``) under a
    ``title``, ``entries`` of your own in place of the series', swatches
    that look like the marks (``swatches="mark"``: of every mark showing an
    entry's value), and how it looks (``style``, an
    ``hg.Style`` of its ``legend_label``, ``legend_title``, and
    ``tick_label`` roles). Giving one shows the legend, also for a single
    series."""

    place: Place | Mapping[str, Any] | None = None
    columns: int | None = None
    rows: int | None = None
    order: Literal["row", "column"] | None = None
    title: str | Mapping[str, Any] | None = None
    entries: Sequence[LegendEntry | Mapping[str, Any]] | None = None
    swatches: Literal["mark"] | None = None
    style: Style | Mapping[str, Any] | None = None

    def _spec(self) -> dict[str, Any]:
        return legend_layout(self, "LegendOptions")


def legend_spec(legend: Any) -> Any:
    """A chart's legend as the spec takes it: a boolean, or an object."""
    if legend is None or isinstance(legend, bool):
        return legend
    return _built(legend, LegendOptions, "Chart legend")._spec()


@dataclass
class LegendGuide:
    """A legend the chart's ``guides`` lists (see ``hg.legend``)."""

    scales: Sequence[ScaleRef | Mapping[str, Any]] | None = None
    id: str | None = None
    place: Place | Mapping[str, Any] | None = None
    columns: int | None = None
    rows: int | None = None
    order: Literal["row", "column"] | None = None
    title: str | Mapping[str, Any] | None = None
    entries: Sequence[LegendEntry | Mapping[str, Any]] | None = None
    swatches: Literal["mark"] | None = None
    show: bool | None = None
    style: Style | Mapping[str, Any] | None = None

    def _spec(self) -> dict[str, Any]:
        spec: dict[str, Any] = {"type": "legend", **legend_layout(self, "legend")}
        if self.id is not None:
            spec["id"] = self.id
        if self.scales is not None:
            spec["scales"] = [_spec(_built(ref, ScaleRef, "legend scales")) for ref in self.scales]
        if self.show is not None:
            spec["show"] = self.show
        return spec


def legend(**options: Any) -> LegendGuide:
    """A legend for the chart's ``guides``: of the scales ``scales`` names
    (``hg.ScaleRef(mark=..., channel=...)``), or of all the chart's, in place
    of the automatic legend; laid out in ``columns`` or ``rows`` under a
    ``title``, with ``entries`` of your own, and ``swatches="mark"`` for
    swatches that look like the marks. Legends list one entry per value a
    chart's series stand for, whichever marks and panels show it."""
    return LegendGuide(**options)


@dataclass
class Colorbar:
    """A colorbar the chart's ``guides`` lists (see ``hg.colorbar``)."""

    scale: ScaleRef | Mapping[str, Any] | None = None
    id: str | None = None
    place: Place | Mapping[str, Any] | None = None
    title: str | Mapping[str, Any] | None = None
    ticks: int | Ticks | Mapping[str, Any] | None = None
    format: Format | Mapping[str, Any] | None = None
    tick: Tick | Literal[False] | Mapping[str, Any] | None = None
    labels: TickLabels | Literal[False] | Mapping[str, Any] | None = None
    layers: Sequence[TickLayer | Mapping[str, Any]] | None = None
    length: float | None = None
    thickness: float | None = None
    show: bool | None = None
    style: Style | Mapping[str, Any] | None = None

    def __post_init__(self) -> None:
        for name in ("length", "thickness"):
            if getattr(self, name) is not None:
                _number(getattr(self, name), f"colorbar {name}", positive=True)
        if self.layers is not None:
            self.layers = [_built(layer, TickLayer, "colorbar layers") for layer in self.layers]

    def _spec(self) -> dict[str, Any]:
        spec = {
            "type": "colorbar",
            "id": self.id,
            "scale": _spec(_built(self.scale, ScaleRef, "colorbar scale")),
            "place": _spec(_built(self.place, Place, "colorbar place")),
            "title": _title(self.title, "colorbar title"),
            "ticks": ticks_spec(self.ticks, "colorbar ticks"),
            "format": format_spec(self.format, "colorbar format"),
            "tick": _marks(self.tick, Tick, "colorbar tick"),
            "labels": _marks(self.labels, TickLabels, "colorbar labels"),
            "layers": [layer._spec() for layer in self.layers]  # type: ignore[union-attr]
            if self.layers is not None
            else None,
            "length": self.length,
            "thickness": self.thickness,
            "show": self.show,
            "style": style_spec(
                self.style, "colorbar style", ("tick", "tick_label", "legend_title")
            ),
        }
        return {key: value for key, value in spec.items() if value is not None}


def colorbar(**options: Any) -> Colorbar:
    """A colorbar for the chart's ``guides``: a color scale's colors along
    its values, of the scale ``scale`` names (``hg.ScaleRef(mark=...,
    channel="color")``) or the chart's only one; beside the plots by default
    (``place=hg.Place(side="right")``), with ``ticks``, a ``format``, a
    ``title``, and tick ``layers`` as axes take them."""
    return Colorbar(**options)


#: A guide the chart's ``guides`` lists.
Guide = AxisGuide | LegendGuide | Colorbar


def guides_spec(value: Any) -> Any:
    """A chart's ``guides`` as the spec takes them."""
    if value is None:
        return None
    if isinstance(value, (str, bytes, Mapping)) or not isinstance(value, Sequence):
        raise TypeError(
            "Chart guides: expected a list of hg.axis, hg.legend, and hg.colorbar guides; "
            f"received {shown(value)}"
        )
    out = []
    for i, guide in enumerate(value):
        if not isinstance(guide, (AxisGuide, LegendGuide, Colorbar)):
            raise TypeError(
                f"Chart guides[{i}]: expected hg.axis(...), hg.legend(...), or hg.colorbar(...); "
                f"received {type(guide).__name__}"
            )
        out.append(guide._spec())
    return out
