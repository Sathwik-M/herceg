"""Interaction reported by the browser: viewports, selections, and the data under the pointer.

The browser sends plain JSON: numbers, with times as epoch milliseconds on the
axes it names in ``time``, and category positions as their labels. These
functions turn it into Python values, with datetimes for times, and back.
"""

from __future__ import annotations

import datetime as _dt
import math
import numbers
from dataclasses import dataclass
from typing import Any, Literal

#: A position on an axis as Python sees it: a number, a datetime on time
#: axes (naive, in UTC, like the datetimes herceg reads), or a category label.
Value = float | _dt.datetime | str

#: A range on an axis: its two ends, ascending (category labels in axis order).
Range = tuple[Value, Value]

_EPOCH = _dt.datetime(1970, 1, 1)


@dataclass(frozen=True)
class Viewport:
    """What a chart shows when zoomed: the visible ``x`` range and the ranges of
    the left (``y``) and right (``y_right``) y axes, each None when that axis
    is not zoomed and shows its configured domain or its data."""

    x: Range | None = None
    y: Range | None = None
    y_right: Range | None = None


@dataclass(frozen=True)
class Selection:
    """What is brushed: the ``x`` and ``y`` ranges (None along an axis the brush
    leaves alone; a lasso's extent) and a ``lasso``'s outline as ``(x, y)``
    points. The outline's points are numbers or datetimes; on a category axis
    they are band positions, the first category at 0."""

    x: Range | None = None
    y: Range | None = None
    lasso: tuple[tuple[float | _dt.datetime, float | _dt.datetime], ...] | None = None


@dataclass(frozen=True)
class InspectedPoint:
    """One point under the pointer: a series' value, or a pie slice, a tree's node,
    and other items of charts without axes."""

    #: What the tooltip names the point by: its series' name, a heatmap cell's
    #: row category, or an item's name.
    label: str
    #: None for a missing value.
    value: float | None
    #: The value as the tooltip shows it.
    text: str
    #: The point's row in its mark's data, as the chart holds it (``df.iloc[row]``
    #: of the dataframe given, or of a derived table's result; a choropleth's
    #: feature joined by ``geojson=``). None where no one row is the point:
    #: histogram bins, box plot and violin groups, pie slices, funnel stages,
    #: tree nodes, and network and Sankey nodes and links. Rows of live charts
    #: streaming with ``max_rows`` renumber as old rows are dropped.
    row: int | None = None
    #: The point's mark: its index among the chart's marks, in the order they were added.
    mark: int = 0
    #: The mark's ``id``, when it has one.
    mark_id: str | None = None
    #: Identifies the point's series (or item) in the chart.
    key: str = ""


@dataclass(frozen=True)
class Inspection:
    """The data under the pointer, as the tooltip shows it.

    ``value`` is the snapped position on the inspected axis: x, or y for
    horizontal bars (``axis == "y"``). For a pie slice (``axis == "item"``),
    it is the slice's value, and ``label`` names what the values measure.
    """

    axis: Literal["x", "y", "item"]
    value: Value | None
    #: ``value`` as the axis labels it.
    label: str
    points: tuple[InspectedPoint, ...]
    #: The facet value of the panel, in charts with facets; with ``facet_row``
    #: and ``facet_col``, both values as a JSON array, as in ``'["North","A"]'``.
    panel: str | None = None


def decode_viewport(payload: Any) -> Viewport:
    """A viewport from the browser: ``{"x", "y", "yRight", "time"}``, or null for no zoom."""
    if not payload:
        return Viewport()
    time = payload.get("time", ())
    return Viewport(
        x=_range(payload.get("x"), "x" in time),
        y=_range(payload.get("y"), "y" in time),
        y_right=_range(payload.get("yRight"), "yRight" in time),
    )


def encode_viewport(value: Any) -> dict[str, Any]:
    """A viewport set from Python, as the browser takes it: a ``Viewport``, an x
    range, or None for no zoom."""
    if value is None:
        value = Viewport()
    elif not isinstance(value, Viewport):
        value = Viewport(x=value)
    axes = {"x": value.x, "y": value.y, "yRight": value.y_right}
    encoded = {axis: _encode_range(ends, axis) for axis, ends in axes.items()}
    return {
        **{axis: ends for axis, (ends, _) in encoded.items()},
        "time": [axis for axis, (_, time) in encoded.items() if time],
    }


def decode_selection(payload: Any) -> Selection | None:
    """A selection from the browser: ``{"x", "y", "lasso", "time"}``, or null for none."""
    if not payload:
        return None
    time = payload.get("time", ())
    lasso = payload.get("lasso")
    return Selection(
        x=_range(payload.get("x"), "x" in time),
        y=_range(payload.get("y"), "y" in time),
        lasso=None
        if lasso is None
        else tuple((_time(x, "x" in time), _time(y, "y" in time)) for x, y in lasso),
    )


def encode_selection(value: Any) -> dict[str, Any] | None:
    """A selection set from Python, as the browser takes it: a ``Selection``, an x
    range, or None for none (as is a selection of nothing)."""
    if value is None:
        return None
    if not isinstance(value, Selection):
        value = Selection(x=value)
    x, x_time = _encode_range(value.x, "x")
    y, y_time = _encode_range(value.y, "y")
    lasso = None
    if value.lasso is not None:
        points = [_vertex(point) for point in value.lasso]
        if len(points) < 3:
            raise ValueError(f"a lasso needs at least 3 points, not {len(points)}")
        lasso = [[px, py] for (px, _), (py, _) in points]
        x_time = x_time or any(px_time for (_, px_time), _ in points)
        y_time = y_time or any(py_time for _, (_, py_time) in points)
    if x is None and y is None and lasso is None:
        return None
    time = [axis for axis, flag in (("x", x_time), ("y", y_time)) if flag]
    return {"x": x, "y": y, "lasso": lasso, "time": time}


#: The axes each kind of state has ranges on.
_AXES = {"select": ("x", "y"), "viewport": ("x", "y", "yRight")}


def checked(event: str, payload: Any) -> dict[str, Any] | None:
    """A selection (``event == "select"``) or viewport from the browser, checked
    and normalized before it is kept: None for none, or for a selection of
    nothing. Raises ValueError for a payload of another shape."""
    if payload is None:
        return None
    if not isinstance(payload, dict):
        raise ValueError(f"expected an object, not {payload!r}")
    axes = _AXES[event]
    out: dict[str, Any] = {axis: _checked_range(payload.get(axis)) for axis in axes}
    time = payload.get("time", [])
    if not (isinstance(time, list) and all(axis in axes for axis in time)):
        raise ValueError(f"time names axes among {axes}, not {time!r}")
    if event == "select":
        out["lasso"] = _checked_lasso(payload.get("lasso"))
        if all(out[key] is None for key in ("x", "y", "lasso")):
            return None
        # Which categories a lasso's band positions refer to, kept for browsers.
        if payload.get("categories") is not None:
            out["categories"] = payload["categories"]
    out["time"] = time
    return out


def _checked_range(ends: Any) -> list[Any] | None:
    if ends is None:
        return None
    if not (isinstance(ends, list) and len(ends) == 2):
        raise ValueError(f"a range is two ends, not {ends!r}")
    if all(isinstance(end, str) for end in ends) or all(_finite(end) for end in ends):
        return ends
    raise ValueError(f"a range's ends are finite numbers or category labels, not {ends!r}")


def _checked_lasso(points: Any) -> list[Any] | None:
    if points is None:
        return None
    if not (isinstance(points, list) and len(points) >= 3):
        raise ValueError(f"a lasso is at least 3 points, not {points!r}")
    for point in points:
        if not (isinstance(point, list) and len(point) == 2 and all(map(_finite, point))):
            raise ValueError(f"a lasso's points are pairs of finite numbers, not {point!r}")
    return points


def _finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def same_values(a: dict[str, Any] | None, b: dict[str, Any] | None) -> bool:
    """Whether two encoded selections or viewports hold the same values, whichever
    axes hold times: a no-zoom viewport is no viewport."""

    def values(payload: dict[str, Any] | None) -> list[Any]:
        return [(payload or {}).get(key) for key in ("x", "y", "yRight", "lasso")]

    return values(a) == values(b)


def decode_inspection(payload: Any) -> Inspection | None:
    if not payload:
        return None
    time = bool(payload.get("time"))
    return Inspection(
        axis=payload["axis"],
        value=_value(payload.get("value"), time),
        label=payload["label"],
        points=tuple(
            InspectedPoint(
                label=point["label"],
                value=point.get("value"),
                text=point["text"],
                row=point.get("row"),
                mark=point["mark"],
                mark_id=point.get("markId"),
                key=point["key"],
            )
            for point in payload.get("points", ())
        ),
        panel=payload.get("panel"),
    )


def _range(ends: Any, time: bool) -> Range | None:
    if ends is None:
        return None
    start, end = (_value(value, time) for value in ends)
    # A range has both ends; the browser never sends a half.
    if start is None or end is None:
        return None
    return start, end


def _encode_range(value: Any, axis: str) -> tuple[list[Any] | None, bool]:
    """A range as the browser takes it, and whether it holds times: numbers in
    ascending order, datetimes as epoch milliseconds, category labels as given."""
    if value is None:
        return None, False
    try:
        if isinstance(value, str):
            raise TypeError
        start, end = value
    except (TypeError, ValueError):
        raise ValueError(f"{axis} must be a (start, end) pair or None, not {value!r}") from None
    if isinstance(start, str) or isinstance(end, str):
        if not (isinstance(start, str) and isinstance(end, str)):
            raise ValueError(f"a range of categories on {axis} needs two category labels")
        return [start, end], False
    ends = [_milliseconds(start, axis), _milliseconds(end, axis)]
    time = not any(isinstance(end, numbers.Real) for end in (start, end))
    return sorted(ends), time


def _vertex(point: Any) -> tuple[tuple[float, bool], tuple[float, bool]]:
    """A lasso point as the browser takes it, with whether each coordinate is a time."""
    try:
        x, y = point
    except (TypeError, ValueError):
        raise ValueError(f"a lasso's points are (x, y) pairs, not {point!r}") from None
    return (
        (_milliseconds(x, "lasso x"), not isinstance(x, numbers.Real)),
        (_milliseconds(y, "lasso y"), not isinstance(y, numbers.Real)),
    )


def _value(value: Any, time: bool) -> Value | None:
    if value is None or not time or isinstance(value, str):
        return value
    return _time(value, time)


def _time(value: float, time: bool) -> float | _dt.datetime:
    if not time:
        return value
    try:
        return _EPOCH + _dt.timedelta(milliseconds=value)
    except OverflowError:
        # Beyond the years datetime holds; the milliseconds are still exact.
        return float(value)


def _milliseconds(value: Any, axis: str) -> float:
    if isinstance(value, numbers.Real):
        number = float(value)
    else:
        from ._data import _time_ms

        number = _time_ms(value)
    if not math.isfinite(number):
        raise ValueError(f"{axis} values must be finite, not {value!r}")
    return number
