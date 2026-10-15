"""How a chart answers the pointer, the wheel, touch, and keys (``bindings=``),
how far its views may go (``limits=``), and what it shares with other charts
(``sync=``): Python's builders of the spec's ``interaction`` options."""

from __future__ import annotations

import math
import numbers
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, fields
from typing import Any, Literal

from ._data import listed, shown
from ._events import _milliseconds

Modifier = Literal["shift", "ctrl", "alt", "meta"]
Axes = Literal["x", "y", "xy"]

_MODIFIERS = ("shift", "ctrl", "alt", "meta")
#: Keys the keyboard cursor and selections answer to, which bindings cannot take
#: without Ctrl, Alt, or Meta held.
_CURSOR_KEYS = (
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "ArrowDown",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "Escape",
    "Enter",
)


def _modifiers(value: Sequence[Modifier] | None, role: str) -> list[str] | None:
    """The keys held, in one order, each once; None for none, as the spec leaves them out."""
    if value is None:
        return None
    if isinstance(value, str) or not isinstance(value, Sequence):
        raise TypeError(f"{role}: expected a list of keys held; received {shown(value)}")
    for key in value:
        if key not in _MODIFIERS:
            raise ValueError(f"{role}: expected {listed(_MODIFIERS)}; received {shown(key)}")
    return sorted(set(value), key=_MODIFIERS.index) or None


def _choice(value: Any, choices: Sequence[Any], role: str) -> Any:
    # True and False equal 1 and 0, which are not the choices they look like.
    if value is not None and (isinstance(value, bool) or value not in choices):
        raise ValueError(f"{role}: expected {listed(choices)}; received {shown(value)}")
    return value


def _flag(value: Any, role: str) -> bool:
    if not isinstance(value, bool):
        raise TypeError(f"{role}: expected True or False; received {shown(value)}")
    return value


def _clean(spec: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in spec.items() if value is not None}


# Gestures ------------------------------------------------------------------


@dataclass(frozen=True)
class WheelGesture:
    """The wheel (or a trackpad's two-finger scroll) along an ``axis``, either by
    default: the axis it moves most along. With ``focused``, only while the
    chart has the keyboard focus. ``modifiers`` are the keys held, exactly."""

    axis: Literal["x", "y"] | None = None
    modifiers: Sequence[Modifier] | None = None
    focused: bool = False

    def _spec(self, role: str) -> dict[str, Any]:
        return _clean(
            {
                "type": "wheel",
                "axis": _choice(self.axis, ("x", "y"), f"{role} axis"),
                "modifiers": _modifiers(self.modifiers, f"{role} modifiers"),
                "focused": True if _flag(self.focused, f"{role} focused") else None,
            }
        )


@dataclass(frozen=True)
class DragGesture:
    """A press that moves: by a mouse ``button`` (0, the primary, by default), or
    only presses of one kind of ``pointer``."""

    button: Literal[0, 1, 2] = 0
    pointer: Literal["mouse", "touch", "pen"] | None = None
    modifiers: Sequence[Modifier] | None = None

    def _spec(self, role: str) -> dict[str, Any]:
        return _clean(
            {
                "type": "drag",
                "button": _choice(self.button, (0, 1, 2), f"{role} button") or None,
                "pointer": _choice(self.pointer, ("mouse", "touch", "pen"), f"{role} pointer"),
                "modifiers": _modifiers(self.modifiers, f"{role} modifiers"),
            }
        )


@dataclass(frozen=True)
class PinchGesture:
    """Two fingers moving apart or together (trackpad pinches arrive as the
    wheel with Ctrl held)."""

    def _spec(self, role: str) -> dict[str, Any]:
        return {"type": "pinch"}


@dataclass(frozen=True)
class KeyGesture:
    """A ``key``, as browsers name it ("+", "a", "ArrowLeft"), while the chart has
    the keyboard focus. Shift is not counted for single characters other
    than letters, which may need it."""

    key: str
    modifiers: Sequence[Modifier] | None = None

    def _spec(self, role: str) -> dict[str, Any]:
        if not isinstance(self.key, str) or not self.key:
            raise ValueError(f"{role} key: expected a key's name; received {shown(self.key)}")
        modifiers = _modifiers(self.modifiers, f"{role} modifiers")
        if self.key in _CURSOR_KEYS and not set(modifiers or ()) - {"shift"}:
            raise ValueError(
                f"{role} key: {shown(self.key)} moves the keyboard cursor; "
                "bind another key, or hold ctrl, alt, or meta"
            )
        return _clean({"type": "key", "key": self.key, "modifiers": modifiers})


@dataclass(frozen=True)
class DoubleClickGesture:
    """A double click on the plot."""

    modifiers: Sequence[Modifier] | None = None

    def _spec(self, role: str) -> dict[str, Any]:
        return _clean(
            {"type": "doubleClick", "modifiers": _modifiers(self.modifiers, f"{role} modifiers")}
        )


Gesture = WheelGesture | DragGesture | PinchGesture | KeyGesture | DoubleClickGesture


# Actions -------------------------------------------------------------------


@dataclass(frozen=True)
class PanAction:
    """Pans these ``axes`` (x by default, a map's or network's plane both ways):
    by a drag's or the wheel's movement, or for a key, by ``step``, fractions
    of the view across and up (``(0.1, 0)`` moves a tenth of the x range right)."""

    axes: Axes | None = None
    step: tuple[float, float] | None = None

    def _spec(self, role: str) -> dict[str, Any]:
        step = self.step
        if step is not None and (
            len(step) != 2
            or not all(isinstance(v, numbers.Real) and math.isfinite(v) for v in step)
        ):
            raise ValueError(
                f"{role} step: expected two fractions of the view, across and up; "
                f"received {shown(step)}"
            )
        return _clean(
            {
                "type": "pan",
                "axes": _choice(self.axes, ("x", "y", "xy"), f"{role} axes"),
                "step": None if step is None else [float(v) for v in step],
            }
        )


@dataclass(frozen=True)
class ZoomAction:
    """Zooms these ``axes``: the wheel and pinches about the pointer, a double
    click there by ``factor`` (2 by default), and a key about the plot's middle
    by ``factor`` (1.25 by default); a factor above 1 zooms in."""

    axes: Axes | None = None
    factor: float | None = None

    def _spec(self, role: str) -> dict[str, Any]:
        factor = self.factor
        if factor is not None and not (
            isinstance(factor, numbers.Real) and math.isfinite(factor) and factor > 0
        ):
            raise ValueError(f"{role} factor: expected a positive number; received {shown(factor)}")
        return _clean(
            {
                "type": "zoom",
                "axes": _choice(self.axes, ("x", "y", "xy"), f"{role} axes"),
                "factor": None if factor is None else float(factor),
            }
        )


@dataclass(frozen=True)
class BrushAction:
    """Selects what a drag covers: a range along x or y, a rectangle ("xy"), or a
    freehand region ("lasso"); with ``zoom``, zooms to its ranges instead (a
    lasso still selects)."""

    shape: Literal["x", "y", "xy", "lasso"] | None = None
    zoom: bool = False

    def _spec(self, role: str) -> dict[str, Any]:
        return _clean(
            {
                "type": "brush",
                "shape": _choice(self.shape, ("x", "y", "xy", "lasso"), f"{role} shape"),
                "zoom": True if _flag(self.zoom, f"{role} zoom") else None,
            }
        )


@dataclass(frozen=True)
class ResetAction:
    """Back to the configured view."""

    def _spec(self, role: str) -> dict[str, Any]:
        return {"type": "reset"}


@dataclass(frozen=True)
class PageScrollAction:
    """Nothing: the page scrolls or zooms as it would, and later bindings are not tried."""

    def _spec(self, role: str) -> dict[str, Any]:
        return {"type": "pageScroll"}


@dataclass(frozen=True)
class CursorAction:
    """The cursor follows a drag, which pans nothing (as a touch scrubs along a line)."""

    def _spec(self, role: str) -> dict[str, Any]:
        return {"type": "cursor"}


@dataclass(frozen=True)
class OrbitAction:
    """A 3D chart's camera turns with a drag."""

    def _spec(self, role: str) -> dict[str, Any]:
        return {"type": "orbit"}


@dataclass(frozen=True)
class MoveItemAction:
    """A network's node moves with a drag that starts on it."""

    def _spec(self, role: str) -> dict[str, Any]:
        return {"type": "moveItem"}


Action = (
    PanAction
    | ZoomAction
    | BrushAction
    | ResetAction
    | PageScrollAction
    | CursorAction
    | OrbitAction
    | MoveItemAction
)

#: The actions each gesture can perform.
_ACTIONS: dict[type[Any], tuple[type[Any], ...]] = {
    WheelGesture: (PanAction, ZoomAction, PageScrollAction),
    DragGesture: (
        PanAction,
        BrushAction,
        PageScrollAction,
        CursorAction,
        OrbitAction,
        MoveItemAction,
    ),
    PinchGesture: (ZoomAction, PageScrollAction),
    KeyGesture: (PanAction, ZoomAction, ResetAction),
    DoubleClickGesture: (ZoomAction, ResetAction),
}


@dataclass(frozen=True)
class Binding:
    """A ``gesture`` and the ``action`` it performs, as ``bindings=`` lists them::

        hg.Binding(hg.WheelGesture(focused=True), hg.ZoomAction("x"))

    Bindings are matched in order before those ``pan``, ``zoom``, and ``brush``
    stand for: the first whose gesture matches, and whose action applies where
    the input happens, takes it.
    """

    gesture: Gesture
    action: Action

    def _spec(self, role: str) -> dict[str, Any]:
        takes = _ACTIONS.get(type(self.gesture))
        if takes is None:
            raise TypeError(
                f"{role} gesture: expected an hg.WheelGesture, hg.DragGesture, hg.PinchGesture, "
                f"hg.KeyGesture, or hg.DoubleClickGesture; received {type(self.gesture).__name__}"
            )
        if not isinstance(self.action, takes):
            names = ", ".join(f"hg.{kind.__name__}" for kind in takes)
            raise TypeError(
                f"{role} action: a {type(self.gesture).__name__} performs {names}; "
                f"received {type(self.action).__name__}"
            )
        return {
            "gesture": self.gesture._spec(f"{role} gesture"),
            "action": self.action._spec(f"{role} action"),
        }


def bindings_spec(
    value: Sequence[Binding] | None, role: str, *, brushes_rows: bool = False
) -> list[dict[str, Any]] | None:
    """The spec of ``bindings=``; refuses a gesture bound twice, and a brush that
    zooms in a chart whose brushes select rows."""
    if value is None:
        return None
    if isinstance(value, (str, Mapping)) or not isinstance(value, Sequence):
        raise TypeError(f"{role}: expected a list of hg.Binding; received {shown(value)}")
    specs: list[dict[str, Any]] = []
    for i, binding in enumerate(value):
        at = f"{role}[{i}]"
        if not isinstance(binding, Binding):
            raise TypeError(f"{at}: expected an hg.Binding; received {type(binding).__name__}")
        spec = binding._spec(at)
        gesture = {key: v for key, v in spec["gesture"].items() if key != "modifiers"}
        for k, other in enumerate(specs):
            same = {key: v for key, v in other["gesture"].items() if key != "modifiers"}
            if same == gesture and other["gesture"].get("modifiers") == spec["gesture"].get(
                "modifiers"
            ):
                raise ValueError(f"{at}: duplicates binding {k}; remove one or change its gesture")
        if spec["action"].get("zoom") is True and brushes_rows:
            raise ValueError(
                f"{at} action zoom: brushes select rows for row_selection, which never zoom; "
                'drop zoom, or "brush" from the binding\'s events'
            )
        specs.append(spec)
    return specs


# Limits --------------------------------------------------------------------


@dataclass(frozen=True)
class Edge:
    """When a view nearing an end of its limits is reported (``widget.on_edge``):
    within ``threshold`` (a fraction of its span) of the end (the extent's,
    or on an x scale every panel shares, the data's where the extent has
    none), and again only once it moved ``hysteresis`` farther away, or the
    end moved."""

    threshold: float = 0.1
    hysteresis: float = 0.05

    def _spec(self, role: str) -> dict[str, Any]:
        for name in ("threshold", "hysteresis"):
            value = getattr(self, name)
            if not (isinstance(value, numbers.Real) and math.isfinite(value) and float(value) >= 0):
                raise ValueError(
                    f"{role} {name}: expected a number of at least 0; received {shown(value)}"
                )
        return {"threshold": float(self.threshold), "hysteresis": float(self.hysteresis)}


@dataclass(frozen=True)
class ViewLimits:
    """How far the view of a scale may go, and when it nears its ends.

    Every view asked for keeps inside ``extent`` (pans keep their span; a view
    wider than the extent shows the extent): numbers, or datetimes on time
    axes, and None for no end on that side. A view fitted to the data (the
    first, or after a reset) shows the data, or the axis' domain. ``edge`` reports coming near an
    end (``True`` takes the defaults; see ``hg.Edge``)::

        limits={"x": hg.ViewLimits(extent=(first_loaded, None), edge=True)}
    """

    extent: tuple[Any, Any] | None = None
    edge: bool | Edge | Mapping[str, float] = False

    def _spec(self, role: str) -> dict[str, Any]:
        spec: dict[str, Any] = {}
        if self.extent is not None:
            if isinstance(self.extent, str) or len(self.extent) != 2:
                raise ValueError(
                    f"{role} extent: expected two ends, either of them None; "
                    f"received {shown(self.extent)}"
                )
            ends = [
                None if end is None else _milliseconds(end, f"{role} extent") for end in self.extent
            ]
            if ends[0] is not None and ends[1] is not None and not ends[0] < ends[1]:
                raise ValueError(
                    f"{role} extent: expected two ends, ascending; received {shown(self.extent)}"
                )
            spec["extent"] = ends
        edge = self.edge
        if isinstance(edge, Mapping):
            known = [f.name for f in fields(Edge)]
            unknown = [key for key in edge if key not in known]
            if unknown:
                raise ValueError(
                    f"{role} edge: unknown key {shown(unknown[0])}; name one of {listed(known)}"
                )
            edge = Edge(**edge)
        if edge is True:
            spec["edge"] = True
        elif isinstance(edge, Edge):
            spec["edge"] = edge._spec(f"{role} edge")
        elif edge is not False:
            raise TypeError(
                f"{role} edge: expected True, False, or an hg.Edge; received {shown(edge)}"
            )
        return spec


def limits_spec(value: Mapping[str, ViewLimits] | None, role: str) -> dict[str, Any] | None:
    """The spec of ``limits=``: by scale, "x", "y", or "y_right"."""
    if value is None:
        return None
    if not isinstance(value, Mapping):
        raise TypeError(
            f'{role}: expected a dict of hg.ViewLimits by scale ("x", "y", "y_right"); '
            f"received {shown(value)}"
        )
    spec: dict[str, Any] = {}
    for name, limits in value.items():
        if name not in ("x", "y", "y_right"):
            raise ValueError(
                f'{role}: expected the scales "x", "y", or "y_right"; received {shown(name)}'
            )
        if not isinstance(limits, ViewLimits):
            raise TypeError(
                f"{role} {name}: expected an hg.ViewLimits; received {type(limits).__name__}"
            )
        spec["yRight" if name == "y_right" else name] = limits._spec(f"{role} {name}")
    return spec


# Sync ----------------------------------------------------------------------


CursorSnap = Literal["nearest", "previous", "next"]
_SNAPS = ("nearest", "previous", "next")


@dataclass(frozen=True)
class SyncChannel:
    """A sync channel: the ``group`` of charts it is shared with, and the chart's
    ``scale`` that carries it ("x" by default; for selections, "xy", all of
    them, by default). The cursor's channel says how the chart shows the
    cursors it receives: ``snap`` reads the data's x "nearest" the shared value
    and each series' point there (the default, as the pointer reads), each
    series' last point at or before it ("previous", for readings at other
    frequencies: an hourly series' 10:00 for 10:37), or its first at or after
    it ("next"), along x; ``tooltip=True`` shows the chart's tooltip
    there too. Given as ``hg.Sync(panels=...)``, without a group, it says
    the same of the cursor across the chart's own panels."""

    group: str | None = None
    scale: Literal["x", "y", "xy"] | None = None
    tooltip: bool | None = None
    snap: CursorSnap | None = None

    def _show(self, role: str) -> dict[str, Any]:
        return _clean(
            {
                "snap": _choice(self.snap, _SNAPS, f"{role} snap"),
                "tooltip": None if self.tooltip is None else _flag(self.tooltip, f"{role} tooltip"),
            }
        )


@dataclass(frozen=True)
class Sync:
    """What a chart shares, each channel with the charts of its group: the
    cursor's position, the view's range, and the selection, as values (times,
    categories by name). Channels left out are not shared::

        sync=hg.Sync(cursor="operations")
        sync=hg.Sync(cursor=hg.SyncChannel("operations", snap="previous", tooltip=True))

    ``panels`` shares the cursor among the chart's own panels: on by default
    for panels sharing an x scale; ``True`` or an ``hg.SyncChannel`` without a
    group (``snap``, ``tooltip``) also for panels with x scales of their own;
    ``False`` turns it off.
    """

    cursor: str | SyncChannel | None = None
    viewport: str | SyncChannel | None = None
    selection: str | SyncChannel | None = None
    panels: bool | SyncChannel | None = None

    def _spec(self, role: str) -> dict[str, Any]:
        spec: dict[str, Any] = {}
        for name in ("cursor", "viewport", "selection"):
            channel = getattr(self, name)
            if channel is None:
                continue
            if isinstance(channel, str):
                spec[name] = _group(channel, f"{role} {name}")
                continue
            if not isinstance(channel, SyncChannel):
                raise TypeError(
                    f"{role} {name}: expected a group's name or an hg.SyncChannel; "
                    f"received {type(channel).__name__}"
                )
            scales = ("x", "y", "xy") if name == "selection" else ("x", "y")
            if name != "cursor" and (channel.snap is not None or channel.tooltip is not None):
                raise ValueError(
                    f"{role} {name}: snap and tooltip are how a cursor shows; "
                    "give them to the cursor's channel"
                )
            spec[name] = _clean(
                {
                    "group": _group(channel.group, f"{role} {name} group"),
                    "scale": _choice(channel.scale, scales, f"{role} {name} scale"),
                    **channel._show(f"{role} {name}"),
                }
            )
        panels = self.panels
        if isinstance(panels, bool):
            spec["panels"] = panels
        elif isinstance(panels, SyncChannel):
            if panels.group is not None or panels.scale is not None:
                raise ValueError(
                    f"{role} panels: the chart's own panels share the cursor; "
                    "drop group and scale, giving snap or tooltip"
                )
            spec["panels"] = panels._show(f"{role} panels")
        elif panels is not None:
            raise TypeError(
                f"{role} panels: expected True, False, or an hg.SyncChannel; "
                f"received {type(panels).__name__}"
            )
        return spec


def _group(value: Any, role: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{role}: expected a group's name; received {shown(value)}")
    return value


def sync_spec(value: str | Sync | None, role: str) -> str | dict[str, Any] | None:
    """The spec of ``sync=``: a group's name for every channel, or an hg.Sync."""
    if value is None or isinstance(value, str):
        return value
    if not isinstance(value, Sync):
        raise TypeError(f"{role}: expected a group's name or an hg.Sync; received {shown(value)}")
    return value._spec(role)
