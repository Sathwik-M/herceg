"""Herceg charts in Streamlit apps: ``herceg.streamlit.chart(chart)``.

The chart is a Streamlit custom component (components v2, Streamlit 1.51 or
newer; the ``streamlit`` extra). It travels to the browser as one binary
payload, the spec followed by the column buffers, and the selection and the
clicked data come back to the script.
"""

from __future__ import annotations

import json
import struct
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from functools import cache
from typing import TYPE_CHECKING, Any, Literal

try:
    import streamlit as st
except ImportError as error:  # pragma: no cover - depends on the environment
    raise ImportError(
        "Streamlit charts need the `streamlit` extra: pip install 'herceg[streamlit]'"
    ) from error

from . import _render
from ._events import Inspection, Selection, checked, decode_inspection, decode_selection

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
    #: The data under a click, in the run the click started; None otherwise.
    click: Inspection | None = None


def chart(
    chart: Chart,
    *,
    key: str | None = None,
    on_select: Reaction = "ignore",
    on_click: Reaction = "ignore",
) -> ChartState:
    """Shows ``chart`` in the app and returns what the user did with it.

    ``on_select`` is what brushing does (charts with ``brush=``),
    ``on_click`` what clicking data does: ``"ignore"`` keeps them in the
    browser; ``"rerun"`` reruns the script, whose call then returns them; a
    function is called first, then the script reruns. Inside
    ``st.form``, a selection reaches the script when the form is submitted,
    and clicks cannot react. Charts whose panels have x scales of their own
    (``resolve_x``) cannot report selections. Give the chart a ``key`` to
    keep its selection when its data changes, and to show several charts
    with the same content. Charts without a ``theme`` follow the app's light
    or dark theme.
    """
    reactions = {"select": on_select, "click": on_click}
    for name, reaction in reactions.items():
        if not (callable(reaction) or reaction in ("ignore", "rerun")):
            raise ValueError(
                f"on_{name} must be 'ignore', 'rerun', or a function, not {reaction!r}"
            )
    if on_select != "ignore" and chart._settings["resolve_x"] not in (None, "shared"):
        raise ValueError(
            "on_select reports one selection, so it needs a chart whose panels share x "
            "(resolve_x='shared')"
        )
    if on_click != "ignore" and _in_form():
        raise ValueError(
            "on_click cannot react inside st.form: Streamlit does not send clicks from "
            "forms. Use on_select, which reaches the script when the form is submitted."
        )
    spec, buffers = chart.to_spec()
    events = [name for name, reaction in reactions.items() if reaction != "ignore"]
    # Streamlit returns an event's value only when the event has a callback;
    # the browser sends only the events listed in the payload.
    callbacks = {
        f"on_{_VALUES[name]}_change": reaction if callable(reaction) else _rerun
        for name, reaction in reactions.items()
        if reaction != "ignore"
    }
    result = _component()(key=key, data=_payload(spec, buffers, events), **callbacks)
    return _state(result)


#: The component's value for each event: the selection is state, kept across
#: runs; a click is a trigger, reported to one run.
_VALUES = {"select": "selection", "click": "click"}


def _payload(spec: dict[str, Any], buffers: list[bytes], events: list[str]) -> bytes:
    """The chart as one binary message: a little-endian uint32 header length,
    the JSON header (spec, buffer offsets, events), then the buffers. Buffers
    start at 8-byte aligned offsets, so the browser views them as typed
    arrays without copying."""
    offsets = []
    end = 0
    for buffer in buffers:
        offsets.append([end, len(buffer)])
        end = _aligned(end + len(buffer))
    header = json.dumps(
        {"spec": spec, "buffers": offsets, "events": events},
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


def _state(result: Mapping[str, Any]) -> ChartState:
    """The component's result as Python values; a selection of another shape is none."""
    try:
        selection = decode_selection(checked("select", result.get("selection")))
    except ValueError:
        selection = None
    return ChartState(selection=selection, click=decode_inspection(result.get("click")))


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
