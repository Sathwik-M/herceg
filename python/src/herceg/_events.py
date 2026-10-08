"""Interaction reported by the browser: x ranges and the data under the pointer.

The browser sends plain JSON: numbers, with times as epoch milliseconds and
flagged ``time``, and category positions as their labels. These functions
turn it into Python values, with datetimes for times, and back.
"""

from __future__ import annotations

import datetime as _dt
import numbers
from dataclasses import dataclass
from typing import Any, Literal

#: A position on an axis as Python sees it: a number, a datetime on time
#: axes (naive, in UTC, like the datetimes herceg reads), or a category label.
Value = float | _dt.datetime | str

_EPOCH = _dt.datetime(1970, 1, 1)


@dataclass(frozen=True)
class InspectedPoint:
    """One series' value under the pointer."""

    #: The series' name, as in the legend.
    series: str
    #: None for a missing value.
    value: float | None
    #: The value as the tooltip shows it.
    text: str


@dataclass(frozen=True)
class Inspection:
    """The data under the pointer, as the tooltip shows it.

    ``value`` is the snapped position on the inspected axis: x, or y for
    horizontal bars (``axis == "y"``).
    """

    axis: Literal["x", "y"]
    value: Value | None
    #: ``value`` as the axis labels it.
    label: str
    points: tuple[InspectedPoint, ...]
    #: The facet value of the panel, in charts with facets.
    panel: str | None = None


def decode_range(payload: Any) -> tuple[Value, Value] | None:
    """An x range from the browser: ``{"x": [start, end], "time": bool}`` or null."""
    if not payload:
        return None
    start, end = payload["x"]
    time = bool(payload.get("time"))
    return _value(start, time), _value(end, time)


def encode_range(value: Any) -> dict[str, Any] | None:
    """A range set from Python, as the browser takes it: numbers in ascending order,
    datetimes as epoch milliseconds, category labels as given."""
    if value is None:
        return None
    try:
        start, end = value
    except (TypeError, ValueError):
        raise ValueError(f"expected a (start, end) pair or None, not {value!r}") from None
    if isinstance(start, str) or isinstance(end, str):
        if not (isinstance(start, str) and isinstance(end, str)):
            raise ValueError("a range of categories needs two category labels")
        return {"x": [start, end], "time": False}
    ends = [_milliseconds(start), _milliseconds(end)]
    time = not any(isinstance(end, numbers.Real) for end in (start, end))
    return {"x": sorted(ends), "time": time}


def decode_inspection(payload: Any) -> Inspection | None:
    if not payload:
        return None
    time = bool(payload.get("time"))
    return Inspection(
        axis=payload["axis"],
        value=_value(payload.get("value"), time),
        label=payload["label"],
        points=tuple(
            InspectedPoint(series=point["series"], value=point.get("value"), text=point["text"])
            for point in payload.get("points", ())
        ),
        panel=payload.get("panel"),
    )


def _value(value: Any, time: bool) -> Value | None:
    if value is None or not time or isinstance(value, str):
        return value
    try:
        return _EPOCH + _dt.timedelta(milliseconds=value)
    except OverflowError:
        # Beyond the years datetime holds; the milliseconds are still exact.
        return float(value)


def _milliseconds(value: Any) -> float:
    if isinstance(value, numbers.Real):
        return float(value)
    from ._data import _time_ms

    return _time_ms(value)
