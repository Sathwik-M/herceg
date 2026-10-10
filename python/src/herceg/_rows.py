"""Row selections: charts bound to a channel of a selection of their data's rows.

``hg.Chart(df, row_selection=hg.SelectionBinding("focus"))`` makes the chart's
brushes, lassos, and clicks select rows of ``df`` into the channel "focus",
and the chart dims the rows the channel does not hold. Live charts (notebook
widgets, Streamlit) report what the channel holds to Python as a
:class:`RowSelection`: the rows, by position in the data, or for a brush the
condition they meet, which rows appended later meet too.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

import numpy as np

from ._derive import Expr

#: What selects rows: range and rectangle brushes, lassos, and clicks.
Gesture = Literal["brush", "lasso", "click"]

GESTURES: tuple[Gesture, ...] = ("brush", "lasso", "click")


@dataclass(frozen=True, eq=False)
class SelectionBinding:
    """Binds a chart to a channel of a selection of its data's rows.

    ``channel`` names the selection, which every output of a live widget
    shows (separate charts and widgets each hold their own: link them from
    Python, as with ``on_row_selection``). ``events`` are the gestures that
    select (all three by default; none for a chart that only shows what
    others select), where the chart's ``brush`` draws a brush or a lasso;
    a brush that selects rows never zooms. ``effect="none"`` leaves rows
    the channel does not hold undimmed. ``data`` is the table, an object
    given to the chart or one of its marks; by default, the chart's data.
    ``fields`` are more of its columns to send with the chart than its
    marks read, so that conditions set from Python (``widget.row_selection
    = hg.col("fare") > 20``, or another widget's brush) can test them.
    """

    channel: str
    events: Sequence[Gesture] = GESTURES
    effect: Literal["highlight", "none"] = "highlight"
    data: Any = field(default=None, repr=False)
    fields: Sequence[str] = ()

    def __post_init__(self) -> None:
        if not isinstance(self.channel, str) or not self.channel:
            raise ValueError(f"a row selection's channel must be a name, not {self.channel!r}")
        if isinstance(self.events, str):
            raise TypeError("events is a list of gestures, such as ['brush', 'click']")
        unknown = [event for event in self.events if event not in GESTURES]
        if unknown:
            raise ValueError(
                f"a row selection's events are 'brush', 'lasso', and 'click', not {unknown[0]!r}"
            )
        if self.effect not in ("highlight", "none"):
            raise ValueError(
                f"a row selection's effect is 'highlight' or 'none', not {self.effect!r}"
            )
        if isinstance(self.fields, str) or not all(isinstance(f, str) for f in self.fields):
            raise TypeError("fields is a list of column names, such as ['fare']")

    def _spec(self, table: str | None) -> dict[str, Any]:
        spec: dict[str, Any] = {"channel": self.channel}
        if table is not None:
            spec["data"] = table
        if tuple(self.events) != GESTURES:
            spec["events"] = list(self.events)
        if self.effect != "highlight":
            spec["effect"] = self.effect
        return spec


def bindings(value: Any) -> tuple[SelectionBinding, ...]:
    """A chart's ``row_selection`` as bindings: one, several, or none."""
    if value is None:
        return ()
    found = (value,) if isinstance(value, SelectionBinding) else tuple(value)
    for binding in found:
        if not isinstance(binding, SelectionBinding):
            raise TypeError(
                f"row_selection takes hg.SelectionBinding values, not {type(binding).__name__}"
            )
    if not found:
        raise ValueError("row_selection needs a binding: hg.SelectionBinding('name')")
    return found


@dataclass(frozen=True, eq=False)
class RowSelection:
    """What a channel of a chart's row selection holds.

    ``rows`` are positions of the selected rows in the data as the chart
    holds it now (``df.iloc[selection.rows]``, after rows a rolling window
    dropped); ``condition`` is what a brush's rows meet, rows appended later
    too. Both are None when nothing is selected. ``data`` is the table: the
    object given to the chart or the mark.
    """

    channel: str
    data: Any = field(repr=False)
    rows: np.ndarray | None = None
    condition: Expr | None = None

    @property
    def selected(self) -> bool:
        """Whether the channel holds a selection, of some rows or none."""
        return self.rows is not None or self.condition is not None


def bound_tables(spec: Any) -> list[dict[str, Any]]:
    """The bindings of a spec's ``rowSelection``: none, one, or several."""
    return [] if spec is None else spec if isinstance(spec, list) else [spec]


def decode(
    payload: dict[str, Any],
    buffers: Sequence[Any],
    data: Any,
    base: int,
    generation: int,
    length: int,
) -> RowSelection:
    """A browser's report of a channel: ``{"channel", "selection"}``, where a
    selection of rows carries the generation of the table it is of and, in
    ``buffers[0]``, the rows' identities (float64, Python's row numbers
    since the table's last reset). Rows dropped since are not in the data
    now. Raises ValueError for another shape, and for rows of data replaced
    since."""
    channel = payload.get("channel")
    selection = payload.get("selection")
    if not isinstance(channel, str):
        raise ValueError(f"a channel's name, not {channel!r}")
    if selection is None:
        return RowSelection(channel, data)
    if not isinstance(selection, dict):
        raise ValueError(f"a selection, not {selection!r}")
    if selection.get("kind") == "predicate":
        return RowSelection(channel, data, condition=Expr(selection.get("expression")))
    if selection.get("kind") != "rows" or not buffers:
        raise ValueError(f"a selection of rows or a condition, not {selection!r}")
    identities = np.frombuffer(memoryview(buffers[0]).cast("B"), dtype="<f8")
    if selection.get("generation") != generation:
        raise ValueError("rows of data replaced since")
    positions = identities.astype(np.int64) - base
    return RowSelection(channel, data, rows=positions[(positions >= 0) & (positions < length)])


def encode(value: Any, length: int) -> tuple[dict[str, Any] | None, list[bytes]]:
    """A selection set from Python, as the browser takes it: None, a
    condition (``hg.col("fare") > 20``), or rows by position in the data
    (any sequence of whole numbers, or a boolean mask of the data's length)."""
    if value is None:
        return None, []
    if isinstance(value, RowSelection):
        if value.condition is not None:
            value = value.condition
        elif value.rows is None:
            return None, []
        else:
            value = value.rows
    if isinstance(value, Expr):
        return {"kind": "predicate", "expression": value._json}, []
    rows = np.asarray(value)
    if rows.dtype == bool:
        if rows.shape != (length,):
            raise ValueError(f"a mask of rows has one value per row: {length}, not {rows.shape}")
        rows = np.flatnonzero(rows)
    if rows.ndim != 1 or (rows.size and not np.issubdtype(rows.dtype, np.integer)):
        raise TypeError("rows are positions in the data: whole numbers, or a boolean mask")
    if rows.size and (rows.min() < 0 or rows.max() >= length):
        raise ValueError(f"rows are positions in the data's {length} rows")
    return {"kind": "rows"}, [np.unique(rows).astype("<u4").tobytes()]
