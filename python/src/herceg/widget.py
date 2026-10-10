"""Live charts in notebooks: ``chart.widget()``.

A :class:`ChartWidget` draws a chart with herceg through anywidget (Jupyter
Notebook, JupyterLab, VS Code, and Colab), takes data and option updates from
Python without re-sending the chart, and reports zooming, brushing, hovering,
and clicks back to Python. Needs the ``notebook`` extra.
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from typing import TYPE_CHECKING, Any, Literal

try:
    import anywidget
    import ipywidgets
    import traitlets
except ImportError as error:  # pragma: no cover - depends on the environment
    raise ImportError(
        "Live notebook charts need the `notebook` extra: pip install 'herceg[notebook]'"
    ) from error

from . import _render
from ._chart import Camera, ChartUpdate, Unpack
from ._events import (
    Inspection,
    Range,
    Selection,
    Viewport,
    checked,
    decode_inspection,
    decode_selection,
    decode_viewport,
    encode_selection,
    encode_viewport,
    same_values,
)
from ._live import LiveChart, Message

if TYPE_CHECKING:
    from ._chart import Chart

__all__ = ["ChartWidget", "Inspection", "Selection", "Viewport"]

Event = Literal["select", "viewport", "hover", "click", "camera"]
#: The key of each event's state in messages and the snapshot.
_STATE_KEYS = {"select": "selection", "viewport": "viewport"}


class ChartWidget(anywidget.AnyWidget):
    """A chart displayed in a notebook that Python can update and observe.

    Make one with ``chart.widget()`` and display it as the last expression of
    a cell::

        live = hg.line(df, x="time", y="cpu", zoom=True).widget()
        live

    then update it from later cells or a background loop::

        live.append(new_rows, max_rows=10_000)
        live.update(title="CPU, live")
        live.on_select(lambda selection: print(selection and selection.x))

    Several outputs of one widget show the same chart and stay in step.
    """

    _esm = _render.asset_path("herceg-widget.js")
    # The whole chart, as a browser draws it when it connects. It is built
    # from the current data each time it is sent, so a browser that connects
    # or reloads after updates draws them; the updates themselves travel as
    # small messages and never re-send this.
    _chart = traitlets.Dict().tag(sync=True, to_json=lambda _value, widget: widget._snapshot())
    # Events with Python callbacks; the browser does not send the others.
    _listening = traitlets.List(traitlets.Unicode()).tag(sync=True)

    def __init__(self, chart: Chart) -> None:
        self._live = LiveChart(chart)
        # Counts the changes sent to browsers, so a browser that missed one
        # (it was not open yet, say) asks for the whole chart again.
        self._revision = 0
        # The selection and the viewport, as last set here or in a browser.
        self._states: dict[str, dict[str, Any] | None] = {"select": None, "viewport": None}
        # Who changed each (a browser's origin, None for Python) and at which
        # revision. A browser's report based on an earlier revision than
        # someone else's change was made without seeing it, and is dropped.
        self._state_changes: dict[str, tuple[str | None, int]] = {
            "select": (None, 0),
            "viewport": (None, 0),
        }
        self._callbacks = {
            event: ipywidgets.CallbackDispatcher()
            for event in ("select", "viewport", "hover", "click", "camera")
        }
        # Updates may come from a background thread while the kernel's thread
        # sends the whole chart: each change and its message happen together.
        self._lock = threading.RLock()
        super().__init__()
        self.on_msg(self._receive)

    # Updates ---------------------------------------------------------------

    def append(self, rows: Any, *, data: Any = None, max_rows: int | None = None) -> None:
        """Adds rows to the chart's data, for streaming.

        ``rows`` is a table like the chart's data (a dataframe, a mapping of
        column names to arrays, a list of records) or one row as a mapping of
        column names to values. It needs every column the chart reads, with
        the same kinds of values. ``max_rows`` keeps a rolling window: the
        oldest rows are dropped beyond it. ``data`` chooses the table: the
        object a mark read with ``data=``; by default, the chart's data.
        """
        with self._lock:
            self._push(self._live.append(rows, data, max_rows))

    def replace(self, rows: Any, *, data: Any = None) -> None:
        """Replaces all rows of the chart's data (or of ``data``, as in :meth:`append`)."""
        with self._lock:
            self._push(self._live.replace(rows, data))

    def update(self, **options: Unpack[ChartUpdate]) -> None:
        """Changes chart options, as given to ``hg.Chart``: ``title``, ``x``, ``y``,
        ``theme``, ``zoom``, ``tooltip``, and the rest except data and facets.
        ``None`` restores an option's default."""
        with self._lock:
            self._push(self._live.update(options))
            # Panels given y scales of their own on a side let go of its
            # viewport, as the browser's chart does.
            viewport = self._states["viewport"]
            cleared = False
            if viewport:
                kept = {
                    **viewport,
                    "y": viewport["y"] if self._live.shares_y else None,
                    "yRight": viewport["yRight"] if self._live.shares_y_right else None,
                }
                if kept != viewport:
                    cleared = self._change("viewport", kept, None)
        if cleared:
            self._callbacks["viewport"](_decoded("viewport", self._states["viewport"]))

    @property
    def selection(self) -> Selection | None:
        """What is brushed (x and y ranges, a lasso's outline), or None. Setting a
        ``Selection``, or an x range as a ``(start, end)`` pair, brushes the chart;
        None clears it."""
        return decode_selection(self._states["select"])

    @selection.setter
    def selection(self, value: Selection | Range | None) -> None:
        self._set("select", encode_selection(value))

    @property
    def viewport(self) -> Viewport:
        """The visible x and y ranges, each None when that axis is not zoomed.
        Setting a ``Viewport`` zooms the chart to it; an x range as a ``(start,
        end)`` pair zooms x and resets y; None resets every axis."""
        return decode_viewport(self._states["viewport"])

    @viewport.setter
    def viewport(self, value: Viewport | Range | None) -> None:
        payload = encode_viewport(value)
        if (payload["y"] and not self._live.shares_y) or (
            payload["yRight"] and not self._live.shares_y_right
        ):
            raise ValueError(
                "charts whose panels have y scales of their own "
                "(resolve_y, resolve_y_right, panels) have no one viewport of them"
            )
        self._set("viewport", payload)

    # Events ----------------------------------------------------------------

    def on_select(self, callback: Callable[[Selection | None], Any], remove: bool = False) -> None:
        """Calls ``callback(selection)`` when what is brushed changes."""
        self._listen("select", callback, remove)

    def on_viewport(self, callback: Callable[[Viewport], Any], remove: bool = False) -> None:
        """Calls ``callback(viewport)`` when the chart zooms, pans, or resets."""
        self._listen("viewport", callback, remove)

    def on_hover(self, callback: Callable[[Inspection | None], Any], remove: bool = False) -> None:
        """Calls ``callback(inspection)`` when the data under the pointer changes;
        None when the pointer leaves the data."""
        self._listen("hover", callback, remove)

    def on_click(self, callback: Callable[[Inspection], Any], remove: bool = False) -> None:
        """Calls ``callback(inspection)`` when the plot is clicked over data."""
        self._listen("click", callback, remove)

    def on_camera(self, callback: Callable[[Camera], Any], remove: bool = False) -> None:
        """Calls ``callback(camera)`` when a 3D chart is turned or zoomed in a browser,
        at most a few times a second while it is dragged."""
        self._listen("camera", callback, remove)

    # Internals -------------------------------------------------------------

    def _snapshot(self) -> dict[str, Any]:
        with self._lock:
            spec, buffers = self._live.to_spec()
            return {
                "revision": self._revision,
                "spec": spec,
                "buffers": buffers,
                "selection": self._states["select"],
                "viewport": self._states["viewport"],
            }

    def send_state(self, key: Any = None) -> None:
        # The state is built from the current data when it is sent; holding
        # the lock until then keeps a later update from overtaking it.
        with self._lock:
            super().send_state(key)

    def _push(self, message: Message | None) -> None:
        """Sends a change to every browser; called with the lock held."""
        if message is None:
            return
        content, buffers = message
        self._revision += 1
        self.send({**content, "revision": self._revision}, buffers)

    def _set(self, event: str, payload: dict[str, Any] | None) -> None:
        with self._lock:
            changed = self._change(event, payload, None)
        if changed:
            self._callbacks[event](_decoded(event, payload))

    def _change(self, event: str, payload: dict[str, Any] | None, origin: str | None) -> bool:
        """Records a selection or viewport and sends it to every browser, unless its
        values are unchanged. Called with the lock held; the browser it came from
        (`origin`) ignores it."""
        stored = self._states[event]
        if same_values(payload, stored):
            # The same values: only what is said of them may be news (which
            # axes hold times, the categories a lasso is over), and a lasso's
            # categories stay known when assigned again from Python.
            if payload is not None:
                kept = (
                    {} if stored is None else {k: v for k, v in stored.items() if k == "categories"}
                )
                self._states[event] = {**kept, **payload}
            return False
        self._states[event] = payload
        message = {"type": event, _STATE_KEYS[event]: payload}
        self._push(({**message, "origin": origin} if origin else message, []))
        self._state_changes[event] = (origin, self._revision)
        return True

    def _listen(self, event: Event, callback: Callable[..., Any], remove: bool) -> None:
        self._callbacks[event].register_callback(callback, remove=remove)
        self._listening = [name for name, calls in self._callbacks.items() if calls.callbacks]

    def _receive(self, _widget: Any, content: dict[str, Any], _buffers: list[Any]) -> None:
        kind = content.get("type")
        if kind == "ready":
            # A browser that connected after updates catches up.
            with self._lock:
                if content.get("revision") != self._revision:
                    self.send_state("_chart")
        elif kind == "resync":
            # A browser that missed an update.
            self.send_state("_chart")
        elif kind in ("select", "viewport"):
            try:
                payload = checked(kind, content.get(_STATE_KEYS[kind]))
            except ValueError:
                # Nothing this module reads; the state stays as it was.
                return
            origin = content.get("origin")
            with self._lock:
                changer, revision = self._state_changes[kind]
                stale = changer != origin and revision > content.get("revision", 0)
                changed = not stale and self._change(kind, payload, origin)
            if changed:
                self._callbacks[kind](_decoded(kind, payload))
        elif kind in ("hover", "click"):
            inspection = decode_inspection(content.get("inspection"))
            if kind == "hover" or inspection is not None:
                self._callbacks[kind](inspection)
        elif kind == "camera":
            camera = content.get("camera") or {}
            self._callbacks["camera"](
                Camera(
                    azimuth=camera.get("azimuth", -60),
                    elevation=camera.get("elevation", 25),
                    zoom=camera.get("zoom", 1),
                    perspective=bool(camera.get("perspective", False)),
                )
            )


def _decoded(event: str, payload: dict[str, Any] | None) -> Selection | Viewport | None:
    """A selection or viewport as Python reads it."""
    return decode_selection(payload) if event == "select" else decode_viewport(payload)
