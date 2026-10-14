"""Herceg charts in Streamlit apps: ``herceg.streamlit.chart(chart)``.

The chart is a Streamlit custom component (components v2, Streamlit 1.51 or
newer; the ``streamlit`` extra). It travels to the browser as one binary
payload, the spec followed by the column buffers, and interaction state
comes back to the script.
"""

from __future__ import annotations

import hashlib
import json
import struct
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from functools import cache
from typing import TYPE_CHECKING, Any, Literal

import numpy as np

try:
    import streamlit as st
except ImportError as error:  # pragma: no cover - depends on the environment
    raise ImportError(
        "Streamlit charts need the `streamlit` extra: pip install 'herceg[streamlit]'"
    ) from error

from . import _render
from ._data import shown
from ._derive import Expr
from ._events import (
    DrillRoot,
    Inspection,
    ItemPositions,
    Selection,
    Viewport,
    checked,
    decode_drill_root,
    decode_inspection,
    decode_item_positions,
    decode_selection,
    decode_viewport,
)
from ._live import check_live_rows
from ._rows import RowSelection

if TYPE_CHECKING:
    from ._chart import Chart

__all__ = ["ChartState", "chart"]

#: What a user action does: nothing in Python ("ignore"), rerun the script
#: ("rerun"), or call a function and then rerun, like Streamlit widget callbacks.
Reaction = Literal["ignore", "rerun"] | Callable[[], Any]


@dataclass(frozen=True)
class ChartState:
    """What the user did with a chart, as of this script run."""

    #: What is brushed (x and y ranges, a lasso's outline), or None; it stays
    #: until the user changes it.
    selection: Selection | None = None
    #: Visible ranges, in layout units for networks or projected plane units for maps.
    viewport: Viewport | None = None
    #: The data under a click, in the run the click started; None otherwise.
    click: Inspection | None = None
    #: What the channel of the chart's row selection holds (see
    #: ``hg.SelectionBinding``): rows by position in the data, or a brush's
    #: condition; None until the user selects, and once the data changes.
    row_selection: RowSelection | None = None
    #: Item keys from the top level through the root, or None for the whole tree:
    #: of the chart's treemap or sunburst (every facet panel's, which share one).
    drill_root: DrillRoot | None = None
    #: Manual network-node positions in layout units; cleared when its data changes.
    #: Of the chart's network (every facet panel's, which share one layout).
    item_positions: ItemPositions = field(default_factory=dict)
    #: Each treemap or sunburst subplot's drill root, by panel id.
    panel_drill_roots: dict[str, DrillRoot | None] = field(default_factory=dict)
    #: Each network subplot's manual node positions, by panel id.
    panel_item_positions: dict[str, ItemPositions] = field(default_factory=dict)
    #: Each map or network subplot's view, by panel id, in its plane's units
    #: (``viewport`` is the chart's).
    panel_viewports: dict[str, Viewport] = field(default_factory=dict)


def chart(
    chart: Chart,
    *,
    key: str | None = None,
    on_select: Reaction = "ignore",
    on_click: Reaction = "ignore",
    on_row_selection: Reaction = "ignore",
    on_drill: Reaction = "ignore",
    on_item_move: Reaction = "ignore",
    on_viewport: Reaction = "ignore",
) -> ChartState:
    """Shows ``chart`` in the app and returns what the user did with it.

    ``on_select`` is what brushing does (charts with ``brush=``),
    ``on_click`` what clicking data does: ``"ignore"`` keeps them in the
    browser; ``"rerun"`` reruns the script, whose call then returns them; a
    function is called first, then the script reruns. ``on_row_selection``
    is what selecting rows does, in a chart with ``row_selection=`` (one
    binding). ``on_drill`` and ``on_item_move`` react to tree navigation and
    moved network nodes; ``on_viewport`` reacts to pan and zoom, with a
    ``viewport`` in layout coordinates for networks or projected units for maps.
    ``drill_root`` and ``item_positions`` in the result
    hold their state. Inside ``st.form``, a selection reaches the script when the
    form is submitted, and clicks cannot react. Charts whose panels have x scales of their own
    (``resolve_x``) cannot report selections. Give the chart a ``key`` to
    keep its selection when its data changes, and to show several charts
    with the same content. Charts without a ``theme`` follow the app's light
    or dark theme.
    """
    reactions = {
        "select": on_select,
        "click": on_click,
        "rowSelection": on_row_selection,
        "drill": on_drill,
        "itemMove": on_item_move,
        "viewport": on_viewport,
    }
    options = {
        "select": "on_select",
        "click": "on_click",
        "rowSelection": "on_row_selection",
        "drill": "on_drill",
        "itemMove": "on_item_move",
        "viewport": "on_viewport",
    }
    for name, reaction in reactions.items():
        if not (callable(reaction) or reaction in ("ignore", "rerun")):
            raise ValueError(
                f'streamlit.chart {options[name]}: expected "ignore", "rerun", or a function; '
                f"received {shown(reaction)}"
            )
    if on_viewport != "ignore" and chart._settings["resolve_x"] not in (None, "shared"):
        raise ValueError(
            "streamlit.chart on_viewport: reports one viewport, so the chart's panels must "
            'share x; give the chart resolve_x="shared"'
        )
    if on_select != "ignore" and chart._settings["resolve_x"] not in (None, "shared"):
        raise ValueError(
            "streamlit.chart on_select: reports one selection, so the chart's panels must "
            'share x; give the chart resolve_x="shared"'
        )
    if on_row_selection != "ignore":
        if len(chart._row_selection) != 1:
            raise ValueError(
                "streamlit.chart on_row_selection: reports one row selection, and the chart "
                f"binds {len(chart._row_selection)}; give the chart one binding"
            )
        check_live_rows(chart)
    if on_click != "ignore" and _in_form():
        raise ValueError(
            "streamlit.chart on_click: cannot react inside st.form, as Streamlit sends no "
            "clicks from forms; use on_select, which reaches the script when the form is submitted"
        )
    spec, buffers = chart.to_spec()
    events = [name for name, reaction in reactions.items() if reaction != "ignore"]
    # Rows are positions in this run's data; the browser says which data they
    # are of. Runs that change only how the chart looks keep them.
    epoch = hashlib.sha256(json.dumps(spec.get("data"), sort_keys=True).encode())
    for buffer in buffers:
        epoch.update(buffer)
    # Streamlit returns an event's value only when the event has a callback;
    # the browser sends only the events listed in the payload.
    callbacks = {
        f"on_{_VALUES[name]}_change": reaction if callable(reaction) else _rerun
        for name, reaction in reactions.items()
        if reaction != "ignore"
    }
    digest = epoch.hexdigest()[:16]
    item_epoch = _item_epoch(spec, digest)
    payload = _payload(spec, buffers, events, digest)
    result = _component()(key=key, data=payload, **callbacks)
    return _state(result, chart, digest, item_epoch)


#: The component's value for each event: the selection and the row selection
#: are state, kept across runs; a click is a trigger, reported to one run.
_VALUES = {
    "select": "selection",
    "click": "click",
    "rowSelection": "rows",
    "drill": "drill_root",
    "itemMove": "item_positions",
    "viewport": "viewport",
}


def _item_epoch(spec: dict[str, Any], epoch: str) -> str | None:
    """Moves belong to the networks' data and layout fields (and the facet or
    panels laying them out), independent of styles; None without networks."""
    graphs = [mark for mark in spec.get("marks", []) if mark["type"] == "graph"]
    if not graphs:
        return None
    names = ("id", "data", "nodes", "source", "target", "value", "node", "panel")
    fields = [[mark.get(name) for name in names] + [mark.get("directed", False)] for mark in graphs]
    layout = [spec.get("facet"), [panel["id"] for panel in spec.get("panels", [])]]
    digest = hashlib.sha256(json.dumps([epoch, fields, layout], sort_keys=True).encode())
    return digest.hexdigest()[:16]


def _payload(
    spec: dict[str, Any],
    buffers: list[bytes],
    events: list[str],
    epoch: str = "",
) -> bytes:
    """The chart as one binary message: a little-endian uint32 header length,
    the JSON header (spec, buffer offsets, events), then the buffers. Buffers
    start at 8-byte aligned offsets, so the browser views them as typed
    arrays without copying."""
    offsets = []
    end = 0
    for buffer in buffers:
        offsets.append([end, len(buffer)])
        end = _aligned(end + len(buffer))
    item_epoch = _item_epoch(spec, epoch)
    header = json.dumps(
        {
            "spec": spec,
            "buffers": offsets,
            "events": events,
            "epoch": epoch,
            **({"itemEpoch": item_epoch} if item_epoch is not None else {}),
        },
        separators=(",", ":"),
        allow_nan=False,
    ).encode()
    start = _aligned(4 + len(header))
    out = bytearray(start + end)
    struct.pack_into("<I", out, 0, len(header))
    out[4 : 4 + len(header)] = header
    for (offset, length), buffer in zip(offsets, buffers, strict=True):
        out[start + offset : start + offset + length] = buffer
    return bytes(out)


def _state(
    result: Mapping[str, Any],
    chart: Chart | None = None,
    epoch: str = "",
    item_epoch: str | None = None,
) -> ChartState:
    """The component's result as Python values; a selection of another shape is none."""
    try:
        selection = decode_selection(checked("select", result.get("selection")))
    except ValueError:
        selection = None
    drills = result.get("drill_root")
    drills = drills if isinstance(drills, dict) else {}
    root = _decoded(decode_drill_root, "drill", drills.get("root"), None)
    panel_roots = {
        panel: _decoded(decode_drill_root, "drill", payload, None)
        for panel, payload in _panels(drills.get("panels")).items()
    }
    positions = result.get("item_positions")
    moved: ItemPositions = {}
    panel_moved: dict[str, ItemPositions] = {}
    if (
        isinstance(positions, dict)
        and item_epoch is not None
        and positions.get("epoch") == item_epoch
    ):
        moved = _decoded(decode_item_positions, "itemMove", positions.get("positions"), {})
        panel_moved = {
            panel: _decoded(decode_item_positions, "itemMove", payload, {})
            for panel, payload in _panels(positions.get("panels")).items()
        }
    view = result.get("viewport")
    viewport = None
    panel_views: dict[str, Viewport] = {}
    if not isinstance(view, dict) or "epoch" not in view or view.get("epoch") == item_epoch:
        own = view if isinstance(view, dict) and "x" in view else None
        viewport = _decoded(decode_viewport, "viewport", own, None) if own is not None else None
        panel_views = {
            panel: _decoded(decode_viewport, "viewport", payload, Viewport())
            for panel, payload in _panels(
                view.get("panels") if isinstance(view, dict) else None
            ).items()
        }
    return ChartState(
        selection=selection,
        viewport=viewport,
        click=decode_inspection(result.get("click")),
        row_selection=_rows(result.get("rows"), chart, epoch),
        drill_root=root,
        item_positions=moved,
        panel_drill_roots=panel_roots,
        panel_item_positions=panel_moved,
        panel_viewports=panel_views,
    )


def _decoded(decode: Callable[[Any], Any], event: str, payload: Any, default: Any) -> Any:
    """A state from the browser as Python reads it, or `default` for one of another shape."""
    try:
        return decode(checked(event, payload))
    except ValueError:
        return default


def _panels(payload: Any) -> dict[str, Any]:
    """Subplots' states from the browser, by panel id; none for another shape."""
    if not isinstance(payload, dict):
        return {}
    return {panel: state for panel, state in payload.items() if isinstance(panel, str)}


def _rows(payload: Any, chart: Chart | None, epoch: str) -> RowSelection | None:
    """A row selection from the browser, if it is of this run's data: rows are
    positions in the data the browser drew, which a rerun may have replaced."""
    if chart is None or not isinstance(payload, dict) or payload.get("epoch") != epoch:
        return None
    # The state may be of a binding the chart no longer has: another table, or none.
    if len(chart._row_selection) != 1:
        return None
    (binding,) = chart._row_selection
    table = chart._bound_table(binding)
    if payload.get("table") != table or payload.get("channel") != binding.channel:
        return None
    data = next(source for source, name in chart._table_names() if name == table)
    selection = payload.get("selection")
    if selection is None:
        return RowSelection(binding.channel, data)
    if not isinstance(selection, dict):
        return None
    if selection.get("kind") == "predicate":
        return RowSelection(binding.channel, data, condition=Expr(selection.get("expression")))
    rows = selection.get("rows")
    if selection.get("kind") != "rows" or not isinstance(rows, list):
        return None
    if not all(isinstance(row, int) and not isinstance(row, bool) for row in rows):
        return None
    return RowSelection(binding.channel, data, rows=np.asarray(rows, dtype=np.int64))


def _aligned(size: int) -> int:
    return -(-size // 8) * 8


def _rerun() -> None:
    """A callback with nothing to do: registering one is what makes Streamlit
    return the event's value to the script run it causes."""


def _in_form() -> bool:
    """Whether the chart is being added inside ``st.form``."""
    # Streamlit has no public way to ask; this is what its components use.
    from streamlit.elements.lib.form_utils import is_in_form

    return is_in_form(st._main)


def _component() -> Callable[..., Any]:
    # Registered on every call: Streamlit keeps components per runtime (a
    # new one per server or AppTest), and registering the same definition
    # again changes nothing.
    import streamlit.components.v2 as components

    return components.component("herceg.chart", js=_script())


@cache
def _script() -> str:
    # Streamlit reads a one-line string containing "/" as a file path; a
    # comment line keeps the bundle inline code whatever the minifier emits.
    return "// herceg chart component\n" + _render.asset("herceg-streamlit.js")
