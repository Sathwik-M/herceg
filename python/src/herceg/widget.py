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
from ._chart import ChartUpdate, Unpack
from ._events import Inspection, Value, decode_inspection, decode_range, encode_range
from ._live import LiveChart, Message

if TYPE_CHECKING:
    from ._chart import Chart

__all__ = ["ChartWidget", "Inspection"]

Range = tuple[Value, Value]
Event = Literal["select", "viewport", "hover", "click"]


class ChartWidget(anywidget.AnyWidget):
    """A chart displayed in a notebook that Python can update and observe.

    Make one with ``chart.widget()`` and display it as the last expression of
    a cell::

        live = hg.line(df, x="time", y="cpu", zoom=True).widget()
        live

    then update it from later cells or a background loop::

        live.append(new_rows, max_rows=10_000)
        live.update(title="CPU, live")
        live.on_select(lambda selection: print(selection))

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
        # The x ranges, as last set here or in a browser.
        self._ranges: dict[str, dict[str, Any] | None] = {"select": None, "viewport": None}
        # Who changed each range (a browser's origin, None for Python) and at
        # which revision. A browser's report based on an earlier revision than
        # someone else's change was made without seeing it, and is dropped.
        self._range_changes: dict[str, tuple[str | None, int]] = {
            "select": (None, 0),
            "viewport": (None, 0),
        }
        self._callbacks = {
            event: ipywidgets.CallbackDispatcher()
            for event in ("select", "viewport", "hover", "click")
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

    @property
    def selection(self) -> Range | None:
        """The brushed x range, or None. Setting it brushes the chart."""
        return decode_range(self._ranges["select"])

    @selection.setter
    def selection(self, value: Range | None) -> None:
        self._set_range("select", value)

    @property
    def viewport(self) -> Range | None:
        """The visible x range when zoomed, or None when the chart fits its data.
        Setting it zooms the chart."""
        return decode_range(self._ranges["viewport"])

    @viewport.setter
    def viewport(self, value: Range | None) -> None:
        self._set_range("viewport", value)

    # Events ----------------------------------------------------------------

    def on_select(self, callback: Callable[[Range | None], Any], remove: bool = False) -> None:
        """Calls ``callback(selection)`` when the brushed x range changes."""
        self._listen("select", callback, remove)

    def on_viewport(self, callback: Callable[[Range | None], Any], remove: bool = False) -> None:
        """Calls ``callback(viewport)`` when the chart zooms or pans."""
        self._listen("viewport", callback, remove)

    def on_hover(self, callback: Callable[[Inspection | None], Any], remove: bool = False) -> None:
        """Calls ``callback(inspection)`` when the data under the pointer changes;
        None when the pointer leaves the data."""
        self._listen("hover", callback, remove)

    def on_click(self, callback: Callable[[Inspection], Any], remove: bool = False) -> None:
        """Calls ``callback(inspection)`` when the plot is clicked over data."""
        self._listen("click", callback, remove)

    # Internals -------------------------------------------------------------

    def _snapshot(self) -> dict[str, Any]:
        with self._lock:
            spec, buffers = self._live.to_spec()
            return {
                "revision": self._revision,
                "spec": spec,
                "buffers": buffers,
                "selection": self._ranges["select"],
                "viewport": self._ranges["viewport"],
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

    def _set_range(self, event: str, value: Any) -> None:
        payload = encode_range(value)
        with self._lock:
            changed = self._change_range(event, payload, None)
        if changed:
            self._callbacks[event](decode_range(payload))

    def _change_range(self, event: str, payload: dict[str, Any] | None, origin: str | None) -> bool:
        """Records a range and sends it to every browser, unless it is unchanged.
        Called with the lock held; the browser it came from (`origin`) ignores it."""
        if payload == self._ranges[event]:
            return False
        self._ranges[event] = payload
        message = {"type": event, "x": payload and payload["x"]}
        self._push(({**message, "origin": origin} if origin else message, []))
        self._range_changes[event] = (origin, self._revision)
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
            payload, origin = content.get("range"), content.get("origin")
            with self._lock:
                changer, revision = self._range_changes[kind]
                stale = changer != origin and revision > content.get("revision", 0)
                changed = not stale and self._change_range(kind, payload, origin)
            if changed:
                self._callbacks[kind](decode_range(payload))
        elif kind in ("hover", "click"):
            inspection = decode_inspection(content.get("inspection"))
            if kind == "hover" or inspection is not None:
                self._callbacks[kind](inspection)
