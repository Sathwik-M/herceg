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

import numpy as np

from . import _render
from ._chart import Camera, ChartUpdate, Unpack
from ._derive import Expr, _fields_of
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
from ._rows import RowSelection, decode, encode

if TYPE_CHECKING:
    from ._chart import Chart

__all__ = ["ChartWidget", "Inspection", "RowSelection", "Selection", "Viewport"]

Event = Literal["select", "viewport", "hover", "click", "camera", "rowSelection"]
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
            for event in ("select", "viewport", "hover", "click", "camera", "rowSelection")
        }
        # What each bound channel holds, by table name and channel, in Python's
        # terms: rows by position in the data as it is now.
        self._rows: dict[tuple[str, str], RowSelection] = {
            (name, channel): RowSelection(channel, data) for name, channel, data in self._live.bound
        }
        # Who last changed each channel (a browser's origin, None for Python) and
        # at which revision: a browser's report made before another's change is
        # dropped, as for the selection and the viewport.
        self._row_changes: dict[tuple[str, str], tuple[str | None, int]] = {
            key: (None, 0) for key in self._rows
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
            before = dict(self._live.dropped)
            self._push(self._live.append(rows, data, max_rows))
            self._follow_rows(before)

    def replace(self, rows: Any, *, data: Any = None) -> None:
        """Replaces all rows of the chart's data (or of ``data``, as in :meth:`append`)."""
        with self._lock:
            before = dict(self._live.dropped)
            generations = dict(self._live.generation)
            self._push(self._live.replace(rows, data))
            self._follow_rows(before, generations)

    def _follow_rows(
        self, dropped: dict[str, int], generations: dict[str, int] | None = None
    ) -> None:
        """Keeps selected rows' positions on their rows as rows are dropped from
        the front of their table, and lets them go when it is replaced, as the
        browser's row sets do. Called with the lock held."""
        for (name, channel), current in self._rows.items():
            if current.rows is None:
                continue
            if generations is not None and generations[name] != self._live.generation[name]:
                self._rows[(name, channel)] = RowSelection(channel, current.data)
                continue
            shifted = current.rows - (self._live.dropped[name] - dropped[name])
            rows = shifted[shifted >= 0]
            self._rows[(name, channel)] = RowSelection(channel, current.data, rows=rows)

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
        None clears it. In a chart with ``row_selection``, setting it draws the
        brush only: set ``row_selection`` to select rows."""
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
                "widget.viewport: charts whose panels have y scales of their own "
                "(resolve_y, resolve_y_right, panels) have no one y viewport; set x only"
            )
        self._set("viewport", payload)

    @property
    def row_selection(self) -> RowSelection | None:
        """What the channel of the chart's row selection holds (see
        ``hg.SelectionBinding``): rows by position in the data as it is now, or
        a brush's condition. None for a chart without one. Setting rows (whole
        numbers, or a boolean mask), a condition (``hg.col("fare") > 20``), or
        None selects them in the browser."""
        if not self._rows:
            return None
        return self._only_binding()

    @row_selection.setter
    def row_selection(self, value: Any) -> None:
        current = self._only_binding()
        name = next(name for (name, channel) in self._rows if channel == current.channel)
        condition = value.condition if isinstance(value, RowSelection) else value
        if isinstance(condition, Expr):
            for field in sorted(_fields_of(condition._json) - self._live.columns(name)):
                raise ValueError(
                    f"widget.row_selection: the chart sends no column {field!r} to the browser "
                    f"for a condition to test; name it in hg.SelectionBinding(..., "
                    f"fields=[{field!r}])"
                )
        with self._lock:
            selection, buffers = encode(value, self._live.length(name))
            stored = _held(current, selection, buffers)
            self._rows[(name, current.channel)] = stored
            message = {"type": "rows", "table": name, "channel": current.channel}
            self._push(({**message, "selection": selection}, buffers))
            self._row_changes[(name, current.channel)] = (None, self._revision)
        self._callbacks["rowSelection"](stored)

    def _only_binding(self) -> RowSelection:
        if len(self._rows) != 1:
            raise ValueError(
                "widget.row_selection: the chart binds several row selections; "
                "read them with on_row_selection"
                if self._rows
                else "widget.row_selection: the chart has none; give hg.Chart a row_selection"
            )
        return next(iter(self._rows.values()))

    # Events ----------------------------------------------------------------

    def on_row_selection(
        self, callback: Callable[[RowSelection], Any], remove: bool = False
    ) -> None:
        """Calls ``callback(selection)`` when a channel of the chart's row
        selection changes in a browser: rows selected by a click or lasso (by
        position in the data as it is now), a brush's condition, or nothing."""
        self._listen("rowSelection", callback, remove)

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
            # What the bound channels hold, rows as buffers after the columns'.
            held = []
            for (name, channel), current in self._rows.items():
                selection, extra = encode(current, self._live.length(name))
                if selection is not None and extra:
                    selection = {**selection, "rows": len(buffers)}
                    buffers = [*buffers, *extra]
                held.append({"table": name, "channel": channel, "selection": selection})
            return {
                "revision": self._revision,
                "spec": spec,
                "buffers": buffers,
                "selection": self._states["select"],
                "viewport": self._states["viewport"],
                # Python numbers a table's rows from its first since it was last
                # replaced: how many have dropped since, and how many replaces.
                "rows": {
                    name: [self._live.dropped[name], self._live.generation[name]]
                    for name, _, _ in self._live.bound
                },
                "rowSelections": held,
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

    def _receive(self, _widget: Any, content: dict[str, Any], buffers: list[Any]) -> None:
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
        elif kind == "rowSelection":
            name = content.get("table")
            with self._lock:
                key = (name, content.get("channel"))
                if not isinstance(name, str) or key not in self._rows:
                    return
                origin = content.get("origin")
                changer, revision = self._row_changes[key]
                if changer != origin and revision > content.get("revision", 0):
                    return
                # Rows are numbered as Python numbers them, so rows appended or
                # dropped since the browser selected them are accounted for;
                # rows of data replaced since are not reported.
                try:
                    selection = decode(
                        content,
                        buffers,
                        self._rows[key].data,
                        self._live.dropped[name],
                        self._live.generation[name],
                        self._live.length(name),
                    )
                except ValueError:
                    return
                self._rows[key] = selection
                # Other browsers of the widget show it too; the one it came from has it.
                encoded, extra = encode(selection, self._live.length(name))
                message = {"type": "rows", "table": name, "channel": key[1], "selection": encoded}
                self._push(({**message, "origin": origin}, extra))
                self._row_changes[key] = (origin, self._revision)
            self._callbacks["rowSelection"](selection)
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


def _held(
    current: RowSelection, selection: dict[str, Any] | None, buffers: list[bytes]
) -> RowSelection:
    """What a channel holds once Python set `selection` (encoded) on it."""
    if selection is None:
        return RowSelection(current.channel, current.data)
    if selection["kind"] == "predicate":
        return RowSelection(current.channel, current.data, condition=Expr(selection["expression"]))
    rows = np.frombuffer(buffers[0], dtype="<u4").astype(np.int64)
    return RowSelection(current.channel, current.data, rows=rows)


def _decoded(event: str, payload: dict[str, Any] | None) -> Selection | Viewport | None:
    """A selection or viewport as Python reads it."""
    return decode_selection(payload) if event == "select" else decode_viewport(payload)
