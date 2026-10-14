"""Live charts in notebooks: ``chart.widget()``.

A :class:`ChartWidget` draws a chart with herceg through anywidget (Jupyter
Notebook, JupyterLab, VS Code, and Colab), takes data and option updates from
Python without re-sending the chart, and reports zooming, brushing, hovering,
clicks, drills, and node moves back to Python. Needs the ``notebook`` extra.
"""

from __future__ import annotations

import math
import threading
from collections.abc import Callable, Mapping
from typing import TYPE_CHECKING, Any

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
from ._data import shown
from ._derive import Expr, _fields_of
from ._events import (
    DrillRoot,
    Inspection,
    ItemPositions,
    Range,
    Selection,
    Viewport,
    checked,
    decode_drill_root,
    decode_inspection,
    decode_item_positions,
    decode_selection,
    decode_viewport,
    encode_drill_root,
    encode_item_positions,
    encode_selection,
    encode_viewport,
    same_values,
)
from ._live import ExpressData, LiveChart, Message
from ._rows import RowSelection, decode, encode
from .express._common import call_of

if TYPE_CHECKING:
    from ._chart import Chart

__all__ = [
    "ChartWidget",
    "DrillRoot",
    "Inspection",
    "ItemPositions",
    "RowSelection",
    "Selection",
    "Viewport",
]

#: The key of each event's state in messages and the snapshot.
_STATE_KEYS = {
    "select": "selection",
    "viewport": "viewport",
    "drill": "drill_root",
    "itemMove": "item_positions",
    "camera": "camera",
}
#: Events whose state each subplot's tree, network, or map has of its own.
_PANEL_EVENTS = ("viewport", "drill", "itemMove", "camera")
#: The panel mapping property naming each event's subplot states, for messages.
_PANEL_NAMES = {
    "viewport": "panel_viewports",
    "drill": "panel_drill_roots",
    "itemMove": "panel_item_positions",
    "camera": "panel_cameras",
}
#: A state's key: its event, and its subplot's id ("" for the chart's own).
StateKey = tuple[str, str]


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

    The data of a ``herceg.express`` chart is the data its function was
    given: ``append`` and ``replace`` change those rows, and the function
    computes the chart again from them, keeping its arguments, its seed, and
    what ``update`` changed.

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
        call = call_of(chart)
        # An express chart's rows, which updates change and compute again from.
        self._express = ExpressData(chart, call) if call is not None else None
        # Counts the changes sent to browsers, so a browser that missed one
        # (it was not open yet, say) asks for the whole chart again.
        self._revision = 0
        # Interaction state, as last set here or in a browser: the chart's own
        # (panel ""), and each subplot's tree, network, or map's, by panel.
        keys: list[StateKey] = [("select", ""), ("viewport", "")]
        for event in _PANEL_EVENTS:
            keys += [(event, panel) for panel in self._live.state_panels(event)]
        self._states: dict[StateKey, dict[str, Any] | None] = {
            key: {} if key[0] == "itemMove" else None for key in keys
        }
        # Who changed each (a browser's origin, None for Python) and at which
        # revision. A browser's report based on an earlier revision than
        # someone else's change was made without seeing it, and is dropped.
        self._state_changes: dict[StateKey, tuple[str | None, int]] = {
            key: (None, 0) for key in keys
        }
        # The revision of the last data change that may have taken nodes from
        # each network state: moves reported before it are taken without them.
        self._moves_data: dict[StateKey, int] = {}
        names: list[str | StateKey] = [*keys, "hover", "click", "rowSelection"]
        self._callbacks = {name: ipywidgets.CallbackDispatcher() for name in names}
        # What each bound channel holds, by table name and channel, in Python's
        # terms: rows by position in the data as it is now.
        # Python numbers rows as the data holds them: a binding's selection starts there.
        self._rows: dict[tuple[str, str], RowSelection] = {
            (name, channel): binding._initial(data, self._live.length(name))
            for (name, channel, data), binding in zip(
                self._live.bound, chart._row_selection, strict=True
            )
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
        object a mark read with ``data=``; by default, the chart's data. For
        an express chart, the rows join its function's data, and the chart's
        statistics are computed again.
        """
        if self._express is not None:
            self._refuse_data(data, "widget.append")
            # The rows join the current ones under the lock, so appends
            # from several threads all take part.
            with self._lock:
                changed = self._recompute(self._express.appended(rows, max_rows))
            for key in changed:
                self._callbacks[key](_decoded(key[0], self._states[key]))
            return
        with self._lock:
            before = dict(self._live.dropped)
            message = self._live.append(rows, data, max_rows)
            self._push(message)
            # Rows added take no node from a network; rows dropped may.
            shrank = message is not None and self._live.dropped[message[0]["table"]] > before.get(
                message[0]["table"], 0
            )
            moved = self._follow_positions(message) if shrank else []
            self._follow_rows(before)
        for key in moved:
            self._callbacks[key](decode_item_positions(self._states[key]))

    def replace(self, rows: Any, *, data: Any = None) -> None:
        """Replaces all rows of the chart's data (or of ``data``, as in
        :meth:`append`); an express chart's statistics are computed again."""
        if self._express is not None:
            self._refuse_data(data, "widget.replace")
            with self._lock:
                changed = self._recompute(self._express.replaced(rows))
            for key in changed:
                self._callbacks[key](_decoded(key[0], self._states[key]))
            return
        with self._lock:
            before = dict(self._live.dropped)
            generations = dict(self._live.generation)
            message = self._live.replace(rows, data)
            self._push(message)
            moved = self._follow_positions(message)
            self._follow_rows(before, generations)
        for key in moved:
            self._callbacks[key](decode_item_positions(self._states[key]))

    def _refuse_data(self, data: Any, method: str) -> None:
        if data is not None:
            assert self._express is not None
            raise ValueError(
                f"{method} data: the {self._express.call.function.__name__} chart is computed "
                "from its function's data, which rows change; drop data="
            )

    def _recompute(self, columns: dict[str, Any]) -> list[StateKey]:
        """Makes the express chart again from `columns` and shows it: its new
        tables replace the old ones at once where its marks are the same, and
        otherwise the whole chart is sent, every display keeping its zoom,
        selection, and legend. Nothing changes if the chart cannot be made.
        Moved network nodes reading tables that changed follow them, as
        after any data change; changed camera defaults reset their views. The states
        that changed are returned. Called with the
        lock held, since `columns` were made from the rows it holds."""
        assert self._express is not None
        chart = self._express.make(columns)
        live = LiveChart(chart, self._live.overrides)
        self._express.keep(columns, chart)
        if not self._live.drawn_alike(live):
            cameras = self._replace_live(live)
            return [*cameras, *self._release_moves(None)]
        before = dict(self._live.dropped)
        generations = dict(self._live.generation)
        message = self._live.adopt(live)
        self._push(message)
        self._follow_rows(before, generations)
        return self._release_moves(list(message[0]["tables"])) if message else []

    def _replace_live(self, live: LiveChart) -> list[StateKey]:
        """Shows another chart in place of this one, sent whole in one message
        that keeps zoom, brush, and cameras with unchanged defaults. Rows
        selected in its tables go, as its tables are new. Returns the camera
        states reset by changed defaults. Called with the lock held."""
        cameras = self._live.configured_cameras()
        self._live = live
        self._rows = {
            (name, channel): RowSelection(channel, data) for name, channel, data in live.bound
        }
        self._row_changes = {key: (None, self._revision + 1) for key in self._rows}
        spec, buffers = live.to_spec()
        # Python numbers the new tables' rows from their first.
        rows = {name: [0, 0] for name, _, _ in live.bound}
        self._push(({"type": "chart", "spec": spec, "rows": rows}, buffers))
        return self._reconcile_cameras(cameras)

    def _reconcile_cameras(self, previous: dict[str, dict[str, Any]]) -> list[StateKey]:
        """Resets changed defaults and removes departed owners, with the lock held."""
        configured = self._live.configured_cameras()
        changed = []
        for panel, camera in configured.items():
            key = ("camera", panel)
            if key not in self._states:
                self._states[key] = None
                self._state_changes[key] = (None, self._revision)
                self._callbacks[key] = ipywidgets.CallbackDispatcher()
            if panel in previous and previous[panel] != camera:
                if self._change(key, camera, None):
                    changed.append(key)
                # Reject reports based on defaults from before the option update,
                # even when the stored camera already equals the new defaults.
                self._state_changes[key] = (None, self._revision)
        for panel in previous.keys() - configured.keys():
            key = ("camera", panel)
            self._states.pop(key, None)
            self._state_changes.pop(key, None)
        return changed

    def _follow_positions(self, message: Message | None) -> list[StateKey]:
        """Follows a data change in the moves of the networks reading the
        table it changed (see `_release_moves`); the states that changed.
        Called with the lock held."""
        if message is None:
            return []
        return self._release_moves([message[0]["table"]])

    def _release_moves(self, tables: list[str] | None) -> list[StateKey]:
        """Lets go of the moved nodes that the networks reading `tables` no
        longer have, and keeps the rest; for None (a chart made again, with
        new marks), of every network's. The browsers let go of the same
        moves as they draw the change, so nothing is sent; they report moves
        Python has not heard of (not sent before the change, or of networks
        of derived tables, whose rows Python lacks) at the change's revision,
        and reports made before it are taken without the nodes it took. The
        states that changed. Called with the lock held."""
        if tables is None:
            keys = [key for key in self._states if key[0] == "itemMove"]
        else:
            panels = [panel for t in tables for panel in self._live.state_panels("itemMove", t)]
            keys = [("itemMove", panel) for panel in dict.fromkeys(panels)]
        moved = []
        for key in keys:
            positions = self._states[key] or {}
            remaining = {} if tables is None else self._live.remaining_moves(positions)
            if remaining != positions:
                self._states[key] = remaining
                moved.append(key)
            if tables is None:
                # Reports made before were made on other marks.
                self._state_changes[key] = (None, self._revision)
            else:
                self._moves_data[key] = self._revision
        return moved

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
            cameras = self._live.configured_cameras()
            self._push(self._live.update(options))
            changed_cameras = self._reconcile_cameras(cameras)
            # Panels given y scales of their own on a side let go of its
            # viewport, as the browser's chart does.
            viewport = self._states[("viewport", "")]
            cleared = False
            if viewport:
                kept = {
                    **viewport,
                    "y": viewport["y"] if self._live.shares_y else None,
                    "yRight": viewport["yRight"] if self._live.shares_y_right else None,
                }
                if kept != viewport:
                    cleared = self._change(("viewport", ""), kept, None)
        if cleared:
            self._callbacks[("viewport", "")](_decoded("viewport", kept))
        for key in changed_cameras:
            self._callbacks[key](_decoded("camera", self._states[key]))

    @property
    def selection(self) -> Selection | None:
        """What is brushed (x and y ranges, a lasso's outline, and the subplot of a
        map's or network's lasso), or None. Setting a ``Selection``, or an x range
        as a ``(start, end)`` pair, brushes the chart; None clears it. In a chart
        with ``row_selection``, setting it draws the brush only: set
        ``row_selection`` to select rows."""
        return decode_selection(self._states[("select", "")])

    @selection.setter
    def selection(self, value: Selection | Range | None) -> None:
        self._set(("select", ""), encode_selection(value))

    @property
    def viewport(self) -> Viewport:
        """The visible x and y ranges, each None when that axis is not zoomed:
        of the chart's axes, or of its map or network (also of every facet
        panel's, which share one view). Setting a ``Viewport`` zooms the chart
        to it; an x range as a ``(start, end)`` pair zooms x and resets y; None
        resets every axis. Map and network subplots' views are
        ``panel_viewports``."""
        return decode_viewport(self._states[("viewport", "")])

    @viewport.setter
    def viewport(self, value: Viewport | Range | None) -> None:
        self._own_view("widget.viewport")
        # The chart's one map's or network's view is in its plane's units.
        plane = self._live.plane_view
        payload = _plane_view(value, "widget.viewport") if plane else encode_viewport(value)
        if (payload["y"] and not self._live.shares_y) or (
            payload["yRight"] and not self._live.shares_y_right
        ):
            raise ValueError(
                "widget.viewport: charts whose panels have y scales of their own "
                "(y or y_right scope, panels) have no one y viewport; set x only"
            )
        self._set(("viewport", ""), payload)

    @property
    def panel_viewports(self) -> dict[str, Viewport]:
        """Each map or network subplot's view, by panel id, in its plane's units
        (``viewport`` is the chart's). Assigning a mapping sets the views it
        names; a panel left out keeps its view, and None shows its whole plane.
        The returned mapping is a copy."""
        return {
            panel: decode_viewport(self._states[("viewport", panel)])
            for panel in self._panels("viewport", "widget.panel_viewports")
        }

    @panel_viewports.setter
    def panel_viewports(self, value: Mapping[str, Viewport | Range | None]) -> None:
        self._set_panels(
            "viewport",
            "widget.panel_viewports",
            value,
            lambda view: _plane_view(view, "widget.panel_viewports"),
        )

    def _own_view(self, name: str) -> None:
        """Raises, naming `name`, for a chart with no view of its own: subplots
        none of which has axes, whose maps and networks have views of their own."""
        if not self._live.has_view:
            raise ValueError(
                f"{name}: no panel of the chart has axes; set the views of its map and "
                "network subplots with widget.panel_viewports"
            )

    @property
    def drill_root(self) -> DrillRoot | None:
        """Item keys from the top level through the current root, or None for
        the whole tree: of the chart's treemap or sunburst (every facet panel's,
        which share one root). Assign a reported path to drill; None resets it.
        Subplots' trees drill apart: see ``panel_drill_roots``."""
        return decode_drill_root(self._states.get(self._own("drill", "widget.drill_root", True)))

    @drill_root.setter
    def drill_root(self, value: DrillRoot | None) -> None:
        self._set(self._own("drill", "widget.drill_root"), encode_drill_root(value))

    @property
    def panel_drill_roots(self) -> dict[str, DrillRoot | None]:
        """Each treemap or sunburst subplot's drill root, by panel id. Assigning a
        mapping drills the panels it names; a panel left out keeps its root.
        The returned mapping is a copy."""
        return {
            panel: decode_drill_root(self._states[("drill", panel)])
            for panel in self._panels("drill", "widget.panel_drill_roots")
        }

    @panel_drill_roots.setter
    def panel_drill_roots(self, value: Mapping[str, DrillRoot | None]) -> None:
        self._set_panels(
            "drill",
            "widget.panel_drill_roots",
            value,
            lambda root: encode_drill_root(root, "widget.panel_drill_roots"),
        )

    @property
    def item_positions(self) -> ItemPositions:
        """Manual network-node positions by item key, as (x, y) in layout
        units: of the chart's network (every facet panel's, which share one
        layout). Assignment replaces all overrides; {} resets them. Data
        changes reset them too. The returned mapping is a copy. Subplots'
        networks move apart: see ``panel_item_positions``."""
        key = self._own("itemMove", "widget.item_positions", True)
        return decode_item_positions(self._states.get(key))

    @item_positions.setter
    def item_positions(self, value: Mapping[str, tuple[float, float]]) -> None:
        key = self._own("itemMove", "widget.item_positions")
        self._set(key, encode_item_positions(value))

    @property
    def panel_item_positions(self) -> dict[str, ItemPositions]:
        """Each network subplot's manual node positions, by panel id, as
        ``item_positions`` holds the chart's. Assigning a mapping replaces the
        positions of the panels it names; a panel left out keeps its own.
        The returned mapping is a copy."""
        return {
            panel: decode_item_positions(self._states[("itemMove", panel)])
            for panel in self._panels("itemMove", "widget.panel_item_positions")
        }

    @panel_item_positions.setter
    def panel_item_positions(self, value: Mapping[str, Mapping[str, tuple[float, float]]]) -> None:
        self._set_panels(
            "itemMove",
            "widget.panel_item_positions",
            value,
            lambda positions: encode_item_positions(positions, "widget.panel_item_positions"),
        )

    def _own(self, event: str, name: str, reading: bool = False) -> StateKey:
        """The key of the chart's own state of `event`; raises, naming the
        property `name`, for charts whose subplots have theirs, and (unless
        `reading`, which reads it as empty) for charts without any."""
        panels = self._live.state_panels(event)
        if panels == [""] or (reading and not panels):
            return (event, "")
        what = {"drill": "treemap or sunburst", "itemMove": "network", "camera": "3D camera"}[event]
        if not panels:
            does = (
                "only treemaps and sunbursts drill"
                if event == "drill"
                else "only 3D marks have cameras"
                if event == "camera"
                else "only networks' nodes move"
            )
            raise ValueError(f"{name}: the chart has no {what}; {does}")
        mapping = _PANEL_NAMES[event].replace("panel_", "widget.panel_")
        raise ValueError(f"{name}: the chart's {what} subplots each have their own; use {mapping}")

    def _panels(self, event: str, name: str) -> list[str]:
        """The subplots with states of `event` of their own; [] for charts without any."""
        return [panel for panel in self._live.state_panels(event) if panel != ""]

    def _set_panels(
        self,
        event: str,
        name: str,
        value: Mapping[str, Any],
        encode_one: Callable[[Any], dict[str, Any] | None],
    ) -> None:
        """Sets the subplot states `value` names, all or none: a panel without
        such a state, or a value of another shape, changes nothing."""
        if not isinstance(value, Mapping):
            raise ValueError(f"{name}: expected panel ids mapped to their states")
        panels = self._panels(event, name)
        encoded = {}
        for panel, one in value.items():
            if panel not in panels:
                listed = ", ".join(repr(p) for p in panels) or "none"
                raise ValueError(f"{name}: no panel {panel!r} of its kind; the panels are {listed}")
            encoded[panel] = encode_one(one)
        for panel, payload in encoded.items():
            self._set((event, panel), payload)

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
        self._listen(("select", ""), callback, remove)

    def on_viewport(
        self, callback: Callable[[Viewport], Any], remove: bool = False, *, panel: str | None = None
    ) -> None:
        """Calls ``callback(viewport)`` when the chart zooms, pans, or resets; with
        ``panel``, when that map or network subplot does (see ``panel_viewports``)."""
        self._listen(self._key("viewport", panel, "widget.on_viewport"), callback, remove)

    def on_drill(
        self,
        callback: Callable[[DrillRoot | None], Any],
        remove: bool = False,
        *,
        panel: str | None = None,
    ) -> None:
        """Calls callback(root) when drilling changes, including Python
        assignments; with ``panel``, of that subplot's tree (see
        ``panel_drill_roots``)."""
        self._listen(self._key("drill", panel, "widget.on_drill"), callback, remove)

    def on_item_move(
        self,
        callback: Callable[[ItemPositions], Any],
        remove: bool = False,
        *,
        panel: str | None = None,
    ) -> None:
        """Calls callback(positions) with all overrides after a move or reset;
        with ``panel``, of that subplot's network (see ``panel_item_positions``)."""
        self._listen(self._key("itemMove", panel, "widget.on_item_move"), callback, remove)

    def _key(self, event: str, panel: str | None, name: str) -> StateKey:
        """The key of the state a callback hears of: the chart's own, or the
        subplot `panel` names; raises, naming `name`, for one of neither."""
        if panel is None:
            if event == "viewport":
                self._own_view(name)
                return (event, "")
            self._own(event, name if event == "camera" else f"widget.{_STATE_KEYS[event]}")
            return (event, "")
        panels = self._panels(event, name)
        if panel not in panels:
            listed = ", ".join(repr(p) for p in panels) or "none"
            raise ValueError(
                f"{name} panel: no panel {panel!r} of its kind; the panels are {listed}"
            )
        return (event, panel)

    def on_hover(self, callback: Callable[[Inspection | None], Any], remove: bool = False) -> None:
        """Calls ``callback(inspection)`` when the data under the pointer changes;
        None when the pointer leaves the data."""
        self._listen("hover", callback, remove)

    def on_click(self, callback: Callable[[Inspection], Any], remove: bool = False) -> None:
        """Calls ``callback(inspection)`` when the plot is clicked over data."""
        self._listen("click", callback, remove)

    @property
    def camera(self) -> Camera | None:
        """The chart's current 3D camera; subplots use ``panel_cameras``."""
        return _decode_camera(self._states.get(self._own("camera", "widget.camera", True)))

    @camera.setter
    def camera(self, value: Camera | None) -> None:
        self._set(self._own("camera", "widget.camera"), _encode_camera(value, "widget.camera"))

    @property
    def panel_cameras(self) -> dict[str, Camera | None]:
        """Each 3D subplot's current camera. Assign a mapping to change those panels;
        None restores its configured camera. Panels left out keep their views."""
        return {
            panel: _decode_camera(self._states[("camera", panel)])
            for panel in self._panels("camera", "widget.panel_cameras")
        }

    @panel_cameras.setter
    def panel_cameras(self, value: Mapping[str, Camera | None]) -> None:
        self._set_panels(
            "camera",
            "widget.panel_cameras",
            value,
            lambda camera: _encode_camera(camera, "widget.panel_cameras"),
        )

    def on_camera(
        self,
        callback: Callable[[Camera | None], Any],
        remove: bool = False,
        *,
        panel: str | None = None,
    ) -> None:
        """Calls callback(camera) when camera state changes, for the subplot named
        by panel or the standalone chart, including the first browser's resolved
        camera. Reports are throttled while dragging."""
        self._listen(self._key("camera", panel, "widget.on_camera"), callback, remove)

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
            own = {
                event: self._states.get((event, ""), {} if event == "itemMove" else None)
                for event in _STATE_KEYS
            }
            panels: dict[str, dict[str, Any]] = {}
            for (event, panel), state in self._states.items():
                if panel:
                    panels.setdefault(event, {})[panel] = state
            return {
                "revision": self._revision,
                "spec": spec,
                "buffers": buffers,
                "selection": own["select"],
                "viewport": own["viewport"],
                "drill_root": own["drill"],
                "item_positions": own["itemMove"],
                "camera": own["camera"],
                "panel_states": panels,
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

    def _set(self, key: StateKey, payload: dict[str, Any] | None) -> None:
        with self._lock:
            changed = self._change(key, payload, None)
        if changed:
            self._callbacks[key](_decoded(key[0], payload))

    def _change(self, key: StateKey, payload: dict[str, Any] | None, origin: str | None) -> bool:
        """Records interaction state and sends it to every browser, unless its
        values are unchanged. Called with the lock held; the browser it came from
        (`origin`) ignores it."""
        event, panel = key
        stored = self._states[key]
        same = (
            payload == stored
            if event in ("drill", "itemMove", "camera")
            else same_values(payload, stored)
        )
        if same:
            if event in ("drill", "itemMove", "camera"):
                return False
            # The same values: only what is said of them may be news (which
            # axes hold times, the categories a lasso is over), and a lasso's
            # categories stay known when assigned again from Python.
            if payload is not None:
                kept = (
                    {} if stored is None else {k: v for k, v in stored.items() if k == "categories"}
                )
                self._states[key] = {**kept, **payload}
            return False
        self._states[key] = payload
        message = {
            "type": event,
            _STATE_KEYS[event]: payload,
            **({"panel": panel} if panel else {}),
        }
        self._push(({**message, "origin": origin} if origin else message, []))
        self._state_changes[key] = (origin, self._revision)
        return True

    def _listen(self, name: str | StateKey, callback: Callable[..., Any], remove: bool) -> None:
        self._callbacks[name].register_callback(callback, remove=remove)
        # The browser sends the events Python listens for (hover, clicks, the camera).
        self._listening = list(
            dict.fromkeys(
                key[0] if isinstance(key, tuple) else key
                for key, calls in self._callbacks.items()
                if calls.callbacks
            )
        )

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
        elif kind in _STATE_KEYS:
            panel = content.get("panel", "") if kind in _PANEL_EVENTS else ""
            key = (kind, panel)
            # A state the chart has (a subplot's tree, network, or map's, say).
            if key not in self._states:
                return
            try:
                payload = checked(kind, content.get(_STATE_KEYS[kind]))
            except ValueError:
                # Nothing this module reads; the state stays as it was.
                return
            origin = content.get("origin")
            with self._lock:
                changer, revision = self._state_changes[key]
                made = content.get("revision", 0)
                stale = changer != origin and revision > made
                if not stale and kind == "itemMove" and self._moves_data.get(key, 0) > made:
                    # Moves made before a data change, without the nodes it took,
                    # as the browser that made them lets go of them drawing it.
                    payload = self._live.remaining_moves(payload or {})
                changed = not stale and self._change(key, payload, origin)
            if changed:
                self._callbacks[key](_decoded(kind, payload))
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


def _decoded(
    event: str, payload: dict[str, Any] | None
) -> Selection | Viewport | DrillRoot | ItemPositions | Camera | None:
    """Interaction state as Python reads it."""
    if event == "camera":
        return _decode_camera(payload)
    if event == "drill":
        return decode_drill_root(payload)
    if event == "itemMove":
        return decode_item_positions(payload)
    return decode_selection(payload) if event == "select" else decode_viewport(payload)


def _plane_view(value: Viewport | Range | None, name: str) -> dict[str, Any]:
    """A map's or network's view set from Python (with `name`, as messages
    name it), as the browser takes it: finite x and y ranges in its plane's
    units, and no right y."""
    payload = encode_viewport(value)
    view = value if value is None or isinstance(value, Viewport) else Viewport(x=value)
    if view is None:
        return payload
    if view.y_right is not None:
        raise ValueError(f"{name}: a map or network has no right y axis; drop y_right")
    for axis, ends in (("x", view.x), ("y", view.y)):
        if ends is not None and not all(_plane_number(end) for end in ends):
            raise ValueError(
                f"{name} {axis}: expected finite numbers in the plane's units; "
                f"received {shown(ends)}"
            )
    return payload


def _plane_number(value: Any) -> bool:
    """Whether a view's end is a finite number (not a time, a label, or a bool)."""
    return (
        isinstance(value, (int, float, np.integer, np.floating))
        and not isinstance(value, (bool, np.bool_))
        and math.isfinite(value)
    )


def _decode_camera(payload: dict[str, Any] | None) -> Camera | None:
    return Camera(**payload) if payload is not None else None


def _encode_camera(value: Camera | None, name: str) -> dict[str, Any] | None:
    if value is None:
        return None
    if not isinstance(value, Camera):
        raise ValueError(f"{name}: expected hg.Camera or None; use hg.Camera")
    return value._spec()
