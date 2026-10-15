"""Styles, themes, titles, legends, and placement: builders of the spec's
style and layout types, in Python's names.

Each builder takes its options as keyword arguments; anywhere one is taken, a
dict of the same keyword names works too (``{"font_size": 14}`` for
``hg.TextStyle(font_size=14)``)."""

from __future__ import annotations

import math
import numbers
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, fields
from typing import Any, Literal

from ._data import listed, shown

ThemeName = Literal["light", "dark", "high-contrast", "high-contrast-dark", "auto"]
THEME_NAMES = ("light", "dark", "high-contrast", "high-contrast-dark", "auto")
Align = Literal["start", "center", "end"]
Side = Literal["top", "right", "bottom", "left"]
Inside = Literal[
    "top-left", "top", "top-right", "right", "bottom-right", "bottom", "bottom-left", "left"
]
_INSIDE = ("top-left", "top", "top-right", "right", "bottom-right", "bottom", "bottom-left", "left")


def _camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(word.title() for word in rest)


def _number(value: Any, role: str, *, least: float = 0, positive: bool = False) -> None:
    if (
        isinstance(value, bool)
        or not isinstance(value, numbers.Real)
        or not math.isfinite(value)
        or value < least
        or (positive and value <= 0)
    ):
        expected = "a positive number" if positive else f"a number of at least {least:g}"
        raise ValueError(f"{role}: expected {expected}; received {shown(value)}")


def _fraction(value: Any, role: str) -> None:
    """Refuses an opacity outside 0 to 1."""
    if isinstance(value, bool) or not isinstance(value, numbers.Real) or not 0 <= float(value) <= 1:
        raise ValueError(f"{role}: expected a number from 0 to 1; received {shown(value)}")


def _color(value: Any, role: str) -> None:
    """Refuses a color that is not a CSS color string."""
    if not isinstance(value, str) or not value:
        raise TypeError(f'{role}: expected a CSS color such as "#3266d6"; received {shown(value)}')


def _checked(
    builder: Any,
    role: str,
    colors: Sequence[str] = (),
    widths: Sequence[str] = (),
    fractions: Sequence[str] = (),
) -> None:
    """Checks a builder's colors, widths (0 or more pixels), and opacities."""
    for name in colors:
        if (value := getattr(builder, name)) is not None:
            _color(value, f"{role} {name}")
    for name in widths:
        if (value := getattr(builder, name)) is not None:
            _number(value, f"{role} {name}")
    for name in fractions:
        if (value := getattr(builder, name)) is not None:
            _fraction(value, f"{role} {name}")


def _choice(value: Any, choices: Sequence[str], role: str) -> None:
    if value not in choices:
        raise ValueError(f"{role}: expected {listed(choices)}; received {shown(value)}")


def _built(value: Any, kind: type[Any], role: str) -> Any:
    """`value` as a `kind`: itself, or made from a dict of its keyword arguments."""
    if value is None or isinstance(value, kind):
        return value
    if isinstance(value, Mapping):
        known = [f.name for f in fields(kind)]
        unknown = [key for key in value if key not in known]
        if unknown:
            raise ValueError(
                f"{role}: unknown key {shown(unknown[0])}; name one of {listed(known)}"
            )
        return kind(**value)
    raise TypeError(
        f"{role}: expected an hg.{kind.__name__} or a dict of its options; "
        f"received {type(value).__name__}"
    )


def _spec(value: Any) -> Any:
    """The spec of a builder, its options in camelCase with unset ones left out."""
    if hasattr(value, "_spec"):
        return value._spec()
    if hasattr(value, "__dataclass_fields__"):
        out = {}
        for f in fields(value):
            item = getattr(value, f.name)
            if item is not None:
                out[_camel(f.name)] = _spec(item)
        return out
    if isinstance(value, Mapping):
        return {key: _spec(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_spec(item) for item in value]
    return value


def insets(value: Any, role: str) -> Any:
    """Padding as the spec takes it: pixels on every side, or a dict of sides."""
    if value is None:
        return None
    if isinstance(value, Mapping):
        unknown = [key for key in value if key not in ("top", "right", "bottom", "left")]
        if unknown:
            raise ValueError(
                f"{role}: unknown side {shown(unknown[0])}; "
                f"name one of {listed(('top', 'right', 'bottom', 'left'))}"
            )
        for side, pixels in value.items():
            _number(pixels, f"{role} {side}")
        return dict(value)
    _number(value, role)
    return value


@dataclass
class TextBox:
    """A box drawn behind text: its fill, outline, and corner radius in pixels."""

    fill: str
    stroke: str | None = None
    stroke_width: float | None = None
    radius: float | None = None

    def __post_init__(self) -> None:
        _color(self.fill, "TextBox fill")
        _checked(self, "TextBox", colors=("stroke",), widths=("stroke_width", "radius"))


@dataclass
class Halo:
    """An outline drawn around text to keep it readable: its color, width in
    pixels (3 by default), and opacity."""

    color: str
    width: float | None = None
    opacity: float | None = None

    def __post_init__(self) -> None:
        _color(self.color, "Halo color")
        _checked(self, "Halo", widths=("width",), fractions=("opacity",))


#: A halo option: ``"auto"`` (the surface where text contrasts with it),
#: ``False`` for none, or an ``hg.Halo`` (or a dict of its options).
HaloOption = Literal["auto", False] | Halo | Mapping[str, Any]


def halo_spec(value: Any, role: str) -> Any:
    """The spec of a halo option, or None when unset."""
    if value is None or value is False or value == "auto":
        return value
    if value is True or isinstance(value, str):
        raise ValueError(
            f'{role} halo: expected "auto", False, or an hg.Halo; received {shown(value)}'
        )
    return _spec(_built(value, Halo, f"{role} halo"))


@dataclass
class TextStyle:
    """How text looks; unset options inherit from the theme.

    ``font_weight`` is 100 to 900 (400 normal, 600 semibold, 700 bold);
    ``line_height`` is a multiple of ``font_size``; ``align`` puts the text
    at the ``"start"``, ``"center"``, or ``"end"`` of the span it is placed
    in (the chart's width for its title, the plot's for a panel's title);
    ``halo`` is ``"auto"``, ``False``, or an ``hg.Halo``; ``background`` an
    ``hg.TextBox`` (or ``False``) with ``padding`` around the text in pixels.
    """

    font: str | None = None
    font_size: float | None = None
    font_weight: int | None = None
    font_style: Literal["normal", "italic"] | None = None
    color: str | None = None
    opacity: float | None = None
    line_height: float | None = None
    align: Align | None = None
    halo: HaloOption | None = None
    background: TextBox | Literal[False] | Mapping[str, Any] | None = None
    padding: float | Mapping[str, float] | None = None

    def __post_init__(self) -> None:
        if self.font_size is not None:
            _number(self.font_size, "TextStyle font_size", positive=True)
        if self.font_weight is not None and (
            isinstance(self.font_weight, bool)
            or not isinstance(self.font_weight, int)
            or not 1 <= self.font_weight <= 1000
        ):
            raise ValueError(
                "TextStyle font_weight: expected a whole number from 1 to 1000, such as 400 or "
                f"600; received {shown(self.font_weight)}"
            )
        if self.font_style is not None:
            _choice(self.font_style, ("normal", "italic"), "TextStyle font_style")
        if self.font is not None and (not isinstance(self.font, str) or not self.font):
            raise TypeError(
                f'TextStyle font: expected a CSS font family list such as "Inter, sans-serif"; '
                f"received {shown(self.font)}"
            )
        _checked(self, "TextStyle", colors=("color",), fractions=("opacity",))
        if self.line_height is not None:
            _number(self.line_height, "TextStyle line_height", positive=True)
        if self.align is not None:
            _choice(self.align, ("start", "center", "end"), "TextStyle align")
        if self.halo not in (None, "auto", False):
            self.halo = _built(self.halo, Halo, "TextStyle halo")
        if self.background is not None and self.background is not False:
            self.background = _built(self.background, TextBox, "TextStyle background")
        insets(self.padding, "TextStyle padding")


@dataclass
class StrokeStyle:
    """How a line looks: its color, width in pixels, dash (a pixel pattern
    or ``"-"``, ``"--"``, ``":"``, ``"-."``), and opacity."""

    stroke: str | None = None
    stroke_width: float | None = None
    dash: Sequence[float] | Literal["-", "--", ":", "-."] | None = None
    opacity: float | None = None

    def __post_init__(self) -> None:
        _checked(
            self,
            "StrokeStyle",
            colors=("stroke",),
            widths=("stroke_width",),
            fractions=("opacity",),
        )
        if isinstance(self.dash, str):
            _choice(self.dash, ("-", "--", ":", "-."), "StrokeStyle dash")
        elif self.dash is not None:
            for i, step in enumerate(self.dash):
                _number(step, f"StrokeStyle dash[{i}]")


@dataclass
class PlotStyle:
    """A plot's area: a background under its grid lines and a border around it."""

    fill: str | None = None
    stroke: str | None = None
    stroke_width: float | None = None

    def __post_init__(self) -> None:
        _checked(self, "PlotStyle", colors=("fill", "stroke"), widths=("stroke_width",))


@dataclass
class LineStyle:
    """Lines, area outlines, and contour lines that set no width of their own."""

    stroke_width: float | None = None

    def __post_init__(self) -> None:
        if self.stroke_width is not None:
            _number(self.stroke_width, "LineStyle stroke_width", positive=True)


@dataclass
class BarStyle:
    """Bars: the radius of the corners at the value end of unstacked bars."""

    radius: float | None = None

    def __post_init__(self) -> None:
        _checked(self, "BarStyle", widths=("radius",))


@dataclass
class TooltipStyle:
    """The tooltip's box; its text is the theme's text color."""

    fill: str | None = None
    stroke: str | None = None

    def __post_init__(self) -> None:
        _checked(self, "TooltipStyle", colors=("fill", "stroke"))


#: Each role's builder, and the roles of text.
_ROLES: dict[str, type[Any]] = {
    "text": TextStyle,
    "title": TextStyle,
    "panel_title": TextStyle,
    "axis_title": TextStyle,
    "tick_label": TextStyle,
    "legend_label": TextStyle,
    "legend_title": TextStyle,
    "plot": PlotStyle,
    "grid": StrokeStyle,
    "axis_line": StrokeStyle,
    "tick": StrokeStyle,
    "line": LineStyle,
    "bar": BarStyle,
    "tooltip": TooltipStyle,
}

#: The roles an axis, a legend, and a panel style.
AXIS_ROLES = ("axis_line", "tick", "tick_label", "axis_title", "grid")
LEGEND_ROLES = ("legend_label", "legend_title", "tick_label")
PANEL_ROLES = ("plot", "panel_title", *AXIS_ROLES)


@dataclass
class Style:
    """Styles by visual role. A theme's style gives every role its look; an
    axis', a legend's, or a panel's gives the roles it draws, over the theme's.

    Text roles (``text``, the base of every text, ``title``, ``panel_title``,
    ``axis_title``, ``tick_label``, ``legend_label``, ``legend_title``) take
    an ``hg.TextStyle``; ``plot`` an ``hg.PlotStyle``; ``grid``,
    ``axis_line``, and ``tick`` an ``hg.StrokeStyle``; ``line`` an
    ``hg.LineStyle``, ``bar`` an ``hg.BarStyle``, and ``tooltip`` an
    ``hg.TooltipStyle``::

        hg.Style(tick_label=hg.TextStyle(color="#555"), grid=hg.StrokeStyle(dash="--"))
    """

    text: TextStyle | Mapping[str, Any] | None = None
    title: TextStyle | Mapping[str, Any] | None = None
    panel_title: TextStyle | Mapping[str, Any] | None = None
    axis_title: TextStyle | Mapping[str, Any] | None = None
    tick_label: TextStyle | Mapping[str, Any] | None = None
    legend_label: TextStyle | Mapping[str, Any] | None = None
    legend_title: TextStyle | Mapping[str, Any] | None = None
    plot: PlotStyle | Mapping[str, Any] | None = None
    grid: StrokeStyle | Mapping[str, Any] | None = None
    axis_line: StrokeStyle | Mapping[str, Any] | None = None
    tick: StrokeStyle | Mapping[str, Any] | None = None
    line: LineStyle | Mapping[str, Any] | None = None
    bar: BarStyle | Mapping[str, Any] | None = None
    tooltip: TooltipStyle | Mapping[str, Any] | None = None

    def __post_init__(self) -> None:
        for role, kind in _ROLES.items():
            setattr(self, role, _built(getattr(self, role), kind, f"Style {role}"))

    def roles(self) -> list[str]:
        """The roles this style sets."""
        return [role for role in _ROLES if getattr(self, role) is not None]


def style_spec(value: Any, role: str, allowed: Sequence[str] | None = None) -> Any:
    """The spec of a style given as an ``hg.Style`` or a dict, of the
    `allowed` roles only (all of them without), for `role` in messages."""
    if value is None:
        return None
    style = _built(value, Style, role)
    if allowed is not None:
        extra = [name for name in style.roles() if name not in allowed]
        if extra:
            raise ValueError(
                f"{role}: styles {listed(allowed)}; drop {shown(extra[0])}, "
                "which belongs in the theme's style"
            )
    return _spec(style)


@dataclass
class Tokens:
    """A theme's tokens: the colors its styles are made from. Changing one
    changes every role using it (``muted`` the tick labels, ``axis`` the
    axis lines and ticks) unless the role sets its own color."""

    background: str | None = None
    text: str | None = None
    muted: str | None = None
    grid: str | None = None
    axis: str | None = None
    palette: Sequence[str] | None = None
    sequential: Sequence[str] | None = None
    diverging: Sequence[str] | None = None
    rise: str | None = None
    fall: str | None = None

    def _spec(self) -> dict[str, Any]:
        return {
            f.name: list(value) if isinstance(value, (list, tuple)) else value
            for f in fields(self)
            if (value := getattr(self, f.name)) is not None
        }


@dataclass
class Theme:
    """Changes to a built-in theme (``extends``, ``"light"`` by default): its
    ``tokens`` (an ``hg.Tokens`` or a dict) and role styles (``style``, an
    ``hg.Style`` or a dict)::

        hg.Theme(
            extends="dark",
            tokens=hg.Tokens(palette=["#5b8def", "#dc6f3a"]),
            style=hg.Style(title=hg.TextStyle(font_size=18, align="center")),
        )

    Colors and fonts may be CSS variables with a fallback for static output,
    ``"var(--ink, #1c2333)"``."""

    extends: ThemeName | None = None
    tokens: Tokens | Mapping[str, Any] | None = None
    style: Style | Mapping[str, Any] | None = None

    def __post_init__(self) -> None:
        if self.extends is not None:
            _choice(self.extends, THEME_NAMES, "Theme extends")
        self.tokens = _built(self.tokens, Tokens, "Theme tokens")
        self.style = _built(self.style, Style, "Theme style")

    def _spec(self) -> dict[str, Any]:
        spec = {
            "extends": self.extends,
            "tokens": _spec(self.tokens) or None,
            "style": _spec(self.style) or None,
        }
        return {key: value for key, value in spec.items() if value is not None}


def theme_spec(theme: Any) -> Any:
    """A chart's theme as the spec takes it: a name, or an ``hg.Theme`` (or a
    dict of its options) as an object."""
    if theme is None or isinstance(theme, str):
        return theme
    return _built(theme, Theme, "Chart theme")._spec()


@dataclass
class Place:
    """Where a legend goes: outside on a ``side`` (``"top"``, ``"right"``,
    ``"bottom"``, ``"left"``), at the ``align`` (``"start"``, ``"center"``,
    ``"end"``) of it, ``offset`` pixels farther out than usual; or
    ``inside`` a plot, at a corner or the middle of an edge (``"top-right"``,
    ``"bottom"``, ...), ``inset`` pixels in. ``scope="chart"`` places it
    beside or over the whole figure; ``scope="panel"`` beside or inside the
    plot of ``panel`` (the first one by default)."""

    side: Side | None = None
    align: Align | None = None
    offset: float | None = None
    inside: Inside | None = None
    inset: float | None = None
    scope: Literal["chart", "panel"] | None = None
    panel: str | None = None

    def __post_init__(self) -> None:
        if (self.side is None) == (self.inside is None):
            raise ValueError("Place: give a side or inside, one of them")
        if self.side is not None:
            _choice(self.side, ("top", "right", "bottom", "left"), "Place side")
            if self.inset is not None:
                raise ValueError("Place inset: places inside a plot only; give offset instead")
            if self.scope == "panel" or self.panel is not None:
                raise ValueError(
                    "Place scope: a place on a side is beside the whole chart; drop scope and "
                    'panel, or place it inside a panel with inside="..."'
                )
        if self.inside is not None:
            _choice(self.inside, _INSIDE, "Place inside")
            for name in ("align", "offset"):
                if getattr(self, name) is not None:
                    raise ValueError(f"Place {name}: places on a side only; drop it")
        if self.align is not None:
            _choice(self.align, ("start", "center", "end"), "Place align")
        if self.scope is not None:
            _choice(self.scope, ("chart", "panel"), "Place scope")
        for name in ("offset", "inset"):
            if getattr(self, name) is not None:
                _number(getattr(self, name), f"Place {name}")


@dataclass
class Title:
    """A chart's or a panel's title: its ``text``, how it looks (``style``, an
    ``hg.TextStyle``, whose ``align`` puts it at the start, center, or end),
    and for a chart's, where it goes: ``place=hg.Place(side="bottom")`` under
    the chart (above by default)."""

    text: str
    place: Place | Mapping[str, Any] | None = None
    style: TextStyle | Mapping[str, Any] | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.text, str):
            raise TypeError(f"Title text: expected a string; received {shown(self.text)}")
        place: Place | None = _built(self.place, Place, "Title place")
        self.place = place
        self.style = _built(self.style, TextStyle, "Title style")
        if place is not None and place.side not in ("top", "bottom"):
            raise ValueError(
                'Title place: expected side "top" or "bottom"; '
                f"received {shown(place.side or place.inside)}"
            )
        if place is not None:
            extra = [
                name
                for name in ("align", "offset", "scope", "panel")
                if getattr(place, name, None) is not None
            ]
            if extra:
                raise ValueError(
                    f"Title place: a title takes only side (style.align aligns it); drop {extra[0]}"
                )


def title_spec(title: Any, role: str, *, placed: bool) -> Any:
    """A title as the spec takes it: its text alone, or an object; `placed`
    when it may say where it goes (a chart's, not a panel's)."""
    if title is None or isinstance(title, str):
        return title
    built: Title = _built(title, Title, role)
    place = built.place
    if not placed and place is not None:
        raise ValueError(f"{role} place: a panel's title goes above it; drop place")
    spec: dict[str, Any] = {"text": built.text}
    if isinstance(place, Place):
        spec["place"] = {"side": place.side}
    if built.style is not None:
        spec["style"] = _spec(built.style)
    return spec


def title_text(title: Any) -> str | None:
    """A title's text, given alone or in an ``hg.Title`` (or a dict)."""
    if title is None or isinstance(title, str):
        return title
    if isinstance(title, Mapping):
        return title.get("text")
    return str(title.text)
