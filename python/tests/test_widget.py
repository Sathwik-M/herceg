import datetime as dt
import threading

import numpy as np
import pandas as pd
import pytest

import herceg as hg
from herceg import Inspection
from herceg._events import (
    InspectedPoint,
    decode_inspection,
    decode_selection,
    decode_viewport,
    encode_selection,
    encode_viewport,
)

pytest.importorskip("anywidget")

T0 = dt.datetime(2026, 1, 1)
MS0 = (T0 - dt.datetime(1970, 1, 1)).total_seconds() * 1000


def data():
    return {
        "t": np.array(["2026-01-01T00:00", "2026-01-01T00:01"], dtype="datetime64[ms]"),
        "v": np.array([1.0, 2.0], dtype="float32"),
        "host": ["a", "b"],
        "unused": ["x", "y"],
    }


class Browser:
    """Stands in for the browser: records what the widget sends over its comm,
    in order, and replies."""

    def __init__(self, widget):
        self.widget = widget
        self.sent = []
        widget.comm.send = lambda data=None, buffers=None, **_: self.sent.append((data, buffers))

    def reply(self, content):
        self.widget._handle_custom_msg(content, [])

    @property
    def messages(self):
        """Updates: custom messages and their buffers."""
        return [
            (data["content"], buffers) for data, buffers in self.sent if data["method"] == "custom"
        ]

    @property
    def resent(self):
        """The revisions of whole charts sent."""
        return [
            data["state"]["_chart"]["revision"]
            for data, _ in self.sent
            if data["method"] == "update" and "_chart" in data["state"]
        ]

    @property
    def last(self):
        return self.messages[-1]


def live(**options):
    widget = hg.Chart(data(), **options).line(x="t", y="v", series="host").widget()
    return widget, Browser(widget)


def columns(content, buffers):
    """Decoded columns of a message, as lists."""
    out = {}
    for field, column in content["columns"].items():
        if column["type"] == "category":
            codes = np.frombuffer(buffers[column["codes"]], dtype="<i4")
            out[field] = [column["dictionary"][c] if c >= 0 else None for c in codes]
        else:
            dtype = "<f4" if column["dtype"] == "float32" else "<f8"
            out[field] = np.frombuffer(buffers[column["buffer"]], dtype=dtype).tolist()
    return out


def snapshot(widget):
    state = widget.get_state()["_chart"]
    return state, columns(state["spec"]["data"]["data"], state["buffers"])


def test_the_widget_state_is_the_chart_spec_with_binary_buffers():
    widget, _ = live(title="Live")
    state, values = snapshot(widget)
    assert state["revision"] == 0
    assert state["spec"]["title"] == "Live"
    assert state["spec"]["marks"] == [
        {"type": "line", "x": "t", "y": "v", "series": "host", "data": "data"}
    ]
    assert all(isinstance(buffer, bytes) for buffer in state["buffers"])
    # Only the columns marks read, as in static output.
    assert values == {"host": ["a", "b"], "t": [MS0, MS0 + 60_000], "v": [1.0, 2.0]}
    assert state["selection"] is None and state["viewport"] is None


def test_point_keys_travel_through_live_replacements_and_appends():
    widget = hg.scatter(
        data(), "t", "v", animation_key="host", animation=hg.Animation(values=True)
    ).widget()
    browser = Browser(widget)
    state, values = snapshot(widget)
    assert state["spec"]["marks"][0]["animationKey"] == "host"
    assert values["host"] == ["a", "b"]
    widget.replace({"t": [T0, T0 + dt.timedelta(minutes=1)], "v": [3.0, 4.0], "host": ["b", "a"]})
    content, buffers = browser.last
    assert content["type"] == "replace"
    assert columns(content, buffers)["host"] == ["b", "a"]
    widget.append({"t": [T0 + dt.timedelta(minutes=2)], "v": [5.0], "host": ["c"]})
    content, buffers = browser.last
    assert columns(content, buffers)["host"] == ["c"]
    assert snapshot(widget)[1]["host"] == ["b", "a", "c"]
    with pytest.raises(KeyError, match="widget.replace rows: no column 'host'"):
        widget.replace({"t": [T0], "v": [1.0]})


def test_append_sends_only_the_new_rows_and_keeps_the_state_current():
    widget, browser = live()
    widget.append(
        pd.DataFrame(
            {
                "t": pd.to_datetime(["2026-01-01T00:02", "2026-01-01T00:03"]),
                "v": [3.0, 4.0],
                "host": ["c", "a"],
                "extra": [0, 0],
            }
        )
    )
    content, buffers = browser.last
    assert content["type"] == "append" and content["table"] == "data"
    assert content["revision"] == 1 and "maxRows" not in content
    # Values keep the table's float32 precision; categories bring their own dictionary.
    assert content["columns"]["v"]["dtype"] == "float32"
    assert columns(content, buffers) == {
        "host": ["c", "a"],
        "t": [MS0 + 120_000, MS0 + 180_000],
        "v": [3.0, 4.0],
    }
    # A browser connecting now draws all four rows.
    state, values = snapshot(widget)
    assert state["revision"] == 1
    assert values["host"] == ["a", "b", "c", "a"]
    assert values["v"] == [1.0, 2.0, 3.0, 4.0]


def test_append_keeps_a_rolling_window():
    widget, browser = live()
    widget.append({"t": [T0 + dt.timedelta(minutes=2)], "v": [3.0], "host": ["a"]}, max_rows=2)
    assert browser.last[0]["maxRows"] == 2
    assert snapshot(widget)[1]["v"] == [2.0, 3.0]
    # Batch rows beyond the window are not sent at all.
    rows = {"t": [T0 + dt.timedelta(minutes=m) for m in (3, 4, 5)], "v": [4.0, 5.0, 6.0]}
    widget.append({**rows, "host": ["b", None, "c"]}, max_rows=2)
    assert columns(*browser.last) == {
        "host": [None, "c"],
        "t": [MS0 + 240_000, MS0 + 300_000],
        "v": [5.0, 6.0],
    }
    assert snapshot(widget)[1] == {
        "host": [None, "c"],
        "t": [MS0 + 240_000, MS0 + 300_000],
        "v": [5.0, 6.0],
    }


def test_append_takes_one_row_as_a_mapping_of_values():
    widget, browser = live()
    widget.append({"t": T0 + dt.timedelta(minutes=2), "v": 3.0, "host": "a"})
    assert columns(*browser.last)["v"] == [3.0]


def test_appended_rows_are_checked_against_the_table():
    widget, browser = live()
    with pytest.raises(
        KeyError, match="widget.append rows: no column 'host'; the chart reads 'host', 't', 'v'"
    ):
        widget.append({"t": [T0], "v": [1.0]})
    with pytest.raises(
        TypeError, match="widget.append rows: column 't' holds number values; expected time values"
    ):
        widget.append({"t": [1.0], "v": [1.0], "host": ["a"]})
    with pytest.raises(ValueError, match="widget.append rows: expected columns of one length"):
        widget.append({"t": [T0], "v": [1.0, 2.0], "host": ["a"]})
    with pytest.raises(
        ValueError,
        match="widget.append max_rows: expected a whole number of at least 1; received 0",
    ):
        widget.append({"t": [T0], "v": [1.0], "host": ["a"]}, max_rows=0)
    with pytest.raises(
        ValueError,
        match="widget.append data: expected the object passed to the chart or to one of its marks",
    ):
        widget.append({"t": [T0], "v": [1.0], "host": ["a"]}, data={"t": []})
    # Missing values fit any kind; empty batches send nothing.
    widget.append({"t": [None], "v": [None], "host": [None]})
    missing = columns(*browser.last)
    assert missing["host"] == [None] and np.isnan(missing["t"] + missing["v"]).all()
    assert browser.last[0]["columns"]["t"]["type"] == "time"
    count = len(browser.messages)
    widget.append({"t": [], "v": [], "host": []})
    assert len(browser.messages) == count


def test_a_browser_connecting_while_a_thread_streams_gets_whole_rows():
    widget, browser = live()

    def stream():
        for minute in range(2, 300):
            widget.append({"t": T0 + dt.timedelta(minutes=minute), "v": 1.0, "host": "a"})

    thread = threading.Thread(target=stream)
    thread.start()
    while thread.is_alive():
        state, values = snapshot(widget)
        assert len({len(column) for column in values.values()}) == 1
        assert len(values["t"]) == state["revision"] + 2
    thread.join()
    assert [content["revision"] for content, _ in browser.messages] == list(range(1, 299))


def test_append_and_replace_reach_tables_of_other_marks():
    events = {"at": [1.0], "name": ["deploy"]}
    widget = (
        hg.Chart({"x": [0.0, 1.0], "y": [1.0, 2.0]})
        .line(x="x", y="y")
        .rule(x="at", label=hg.Label(field="name"), data=events)
        .widget()
    )
    browser = Browser(widget)
    widget.append({"at": [2.0], "name": ["rollback"]}, data=events)
    assert browser.last[0]["table"] == "data2"
    widget.replace({"at": [5.0], "name": ["fix"]}, data=events)
    content, buffers = browser.last
    assert content["type"] == "replace" and content["table"] == "data2"
    assert columns(content, buffers) == {"at": [5.0], "name": ["fix"]}
    spec_columns = widget.get_state()["_chart"]["spec"]["data"]["data2"]["columns"]
    assert spec_columns["name"]["dictionary"] == ["fix"]


def test_update_sends_the_changed_options_only():
    widget, browser = live(title="A", zoom=True)
    widget.update(title="B", theme="dark", y=hg.AxisOptions(title="ms"), brush="x")
    content, _ = browser.last
    assert content == {
        "type": "options",
        "options": {
            "interaction": {"zoom": True, "brush": "x"},
            "theme": "dark",
            "title": "B",
            "y": {"title": "ms"},
        },
        "revision": 1,
    }
    # None restores the default: the option is removed.
    widget.update(title=None)
    assert browser.last[0]["options"] == {"title": None}
    count = len(browser.messages)
    widget.update(theme="dark")
    assert len(browser.messages) == count
    assert snapshot(widget)[0]["spec"]["theme"] == "dark"
    with pytest.raises(
        TypeError,
        match="widget.update: unknown chart option 'facet'; data and facets cannot change",
    ):
        widget.update(facet="host")
    # Replaced data moves bars and slices once a live chart animates values.
    widget.update(animation=hg.Animation(values=True))
    assert browser.last[0]["options"] == {"animation": {"duration": 250, "values": True}}
    with pytest.raises(
        ValueError, match="Animation duration: expected milliseconds of at least 0; received inf"
    ):
        widget.update(animation=hg.Animation(duration=float("inf")))


def test_none_resets_every_option_without_sending_nested_nones():
    from herceg._chart import OPTIONS

    def nested_none(value) -> bool:
        if isinstance(value, dict):
            return any(v is None or nested_none(v) for v in value.values())
        if isinstance(value, list):
            return any(v is None or nested_none(v) for v in value)
        return False

    for option in OPTIONS:
        widget, browser = live(title="A", zoom=True, animation=300, theme="dark", width=300)
        widget.update(**{option: None})
        sent = browser.last[0].get("options", {}) if browser.messages else {}
        # A None option is removed; None inside an option's value would be sent as null.
        assert not any(nested_none(value) for value in sent.values()), (option, sent)


def test_live_charts_share_x():
    chart = hg.Chart(data(), facet="host", x=hg.AxisOptions(scope="panel")).line(x="t", y="v")
    with pytest.raises(
        ValueError,
        match='Chart x scope: expected "chart" in a live chart',
    ):
        chart.widget()
    widget, browser = live(zoom=True)
    count = len(browser.messages)
    with pytest.raises(
        ValueError,
        match='Chart x scope: expected "chart" in a live chart',
    ):
        widget.update(x=hg.AxisOptions(scope="row"))
    # The refused change changed nothing.
    widget.update(x=hg.AxisOptions(scope="chart"))
    assert browser.last[0]["options"] == {"x": {"scope": "chart"}}
    assert len(browser.messages) == count + 1


def test_a_browser_behind_gets_the_whole_chart():
    widget, browser = live()
    browser.reply({"type": "ready", "revision": 0})
    assert browser.resent == []
    widget.update(title="B")
    browser.reply({"type": "ready", "revision": 0})
    assert browser.resent == [1]
    # A browser that missed an update always gets it.
    browser.reply({"type": "resync"})
    assert browser.resent == [1, 1]


class WatchedLock:
    """The widget's lock, telling when a background thread starts waiting for it."""

    def __init__(self, lock):
        self.lock = lock
        self.waiting = threading.Event()

    def __enter__(self):
        if threading.current_thread() is not threading.main_thread():
            self.waiting.set()
        return self.lock.__enter__()

    def __exit__(self, *error):
        return self.lock.__exit__(*error)


def test_an_update_never_overtakes_the_chart_being_sent():
    widget, browser = live()
    widget._lock = lock = WatchedLock(widget._lock)
    record = widget.comm.send
    stream = threading.Thread(target=widget.append, args=({"t": T0, "v": 3.0, "host": "a"},))
    blocked = []

    def send(data=None, buffers=None, **_):
        if data["method"] == "update" and "_chart" in data["state"]:
            # A background thread streams while the whole chart is on its way.
            stream.start()
            assert lock.waiting.wait(5)
            stream.join(0.1)
            blocked.append(stream.is_alive())
        record(data=data, buffers=buffers)

    widget.comm.send = send
    browser.reply({"type": "resync"})
    stream.join(5)
    assert not stream.is_alive()
    # The append reached the lock and waited there until the chart was sent.
    assert blocked == [True]
    assert browser.resent == [0]
    assert browser.last[0]["revision"] == 1


def test_appended_categories_join_in_row_order_as_in_the_browser():
    widget, browser = live()
    host = pd.Categorical(["d", "c", "d"], categories=["c", "d", "e"])
    minutes = [T0 + dt.timedelta(minutes=m) for m in (2, 3, 4)]
    widget.append(pd.DataFrame({"t": minutes, "v": [1.0, 2.0, 3.0], "host": host}))
    assert columns(*browser.last)["host"] == ["d", "c", "d"]
    state, values = snapshot(widget)
    assert state["spec"]["data"]["data"]["columns"]["host"]["dictionary"] == ["a", "b", "d", "c"]
    assert values["host"] == ["a", "b", "d", "c", "d"]


def test_selections_from_the_browser_become_properties_and_callbacks():
    widget, browser = live(brush="xy")
    selections = []
    widget.on_select(selections.append)
    payload = {"x": [MS0, MS0 + 60_000], "y": [1.0, 2.0], "lasso": None, "time": ["x"]}
    browser.reply({"type": "select", "selection": payload})
    browser.reply({"type": "select", "selection": payload})  # another view echoing it
    rectangle = hg.Selection(x=(T0, T0 + dt.timedelta(minutes=1)), y=(1.0, 2.0))
    assert selections == [rectangle]
    assert widget.selection == rectangle
    browser.reply({"type": "select", "selection": None})
    assert selections[-1] is None and widget.selection is None
    lasso = {"x": [0.0, 2.0], "y": [1.0, 3.0], "lasso": [[0, 1], [2, 1], [2, 3]], "time": []}
    browser.reply({"type": "select", "selection": lasso})
    assert widget.selection == hg.Selection(
        x=(0.0, 2.0), y=(1.0, 3.0), lasso=((0, 1), (2, 1), (2, 3))
    )
    widget.on_select(selections.append, remove=True)
    browser.reply({"type": "select", "selection": payload})
    assert len(selections) == 3
    # New browsers start from the current selection.
    assert widget.get_state()["_chart"]["selection"] == payload


def test_setting_a_viewport_sends_it_whole_and_reports_it_once():
    widget, browser = live(zoom="xy")
    viewports = []
    widget.on_viewport(viewports.append)
    end = T0 + dt.timedelta(minutes=1)
    assert widget.viewport == hg.Viewport()
    widget.viewport = (end, T0)
    whole = {"x": [MS0, MS0 + 60_000], "y": None, "yRight": None, "time": ["x"]}
    assert browser.last[0] == {"type": "viewport", "viewport": whole, "revision": 1}
    assert widget.viewport == hg.Viewport(x=(T0, end))
    # The browser confirms the same view, numbers flagged as times: no second callback.
    browser.reply({"type": "viewport", "viewport": whole, "origin": "A", "revision": 1})
    assert viewports == [hg.Viewport(x=(T0, end))]
    # A viewport replaces every axis' view.
    widget.viewport = hg.Viewport(y=(0, 5))
    assert browser.last[0]["viewport"] == {"x": None, "y": [0, 5], "yRight": None, "time": []}
    assert viewports[-1] == hg.Viewport(y=(0.0, 5.0))
    widget.viewport = None
    assert browser.last[0]["viewport"]["y"] is None and viewports[-1] == hg.Viewport()
    # Zooming both y axes in the browser reports both.
    both = {"x": None, "y": [1.0, 2.0], "yRight": [10.0, 20.0], "time": []}
    browser.reply({"type": "viewport", "viewport": both, "origin": "A", "revision": 4})
    assert widget.viewport == hg.Viewport(y=(1.0, 2.0), y_right=(10.0, 20.0))


def test_equal_values_keep_the_newer_form_and_call_back_once():
    widget, browser = live(zoom=True)
    viewports = []
    widget.on_viewport(viewports.append)
    widget.viewport = (0, 60_000)
    end = dt.datetime(1970, 1, 1, 0, 1)
    widget.viewport = (dt.datetime(1970, 1, 1), end)
    # The same range, now known to be times: nothing more is sent or called.
    assert len(browser.messages) == 1 and len(viewports) == 1
    assert widget.viewport.x == (dt.datetime(1970, 1, 1), end)


def test_a_lassos_categories_stay_known():
    widget, browser = live(brush="lasso")
    selections = []
    widget.on_select(selections.append)
    outline = [[0, 0], [1, 0], [1, 1]]
    widget.selection = hg.Selection(x=("a", "b"), lasso=[tuple(p) for p in outline])
    # A browser drawing it tells which categories it is over: kept, without a callback.
    learned = {
        "x": ["a", "b"],
        "y": None,
        "lasso": outline,
        "categories": [["a", "b"], None],
        "time": [],
    }
    browser.reply({"type": "select", "selection": learned, "origin": "A", "revision": 1})
    assert widget.get_state()["_chart"]["selection"]["categories"] == [["a", "b"], None]
    # Assigning the same selection again keeps them.
    widget.selection = widget.selection
    assert widget.get_state()["_chart"]["selection"]["categories"] == [["a", "b"], None]
    assert len(selections) == 1 and len(browser.messages) == 1


def test_malformed_reports_from_the_browser_change_nothing():
    widget, browser = live(brush="lasso")
    good = {"x": [0, 1], "y": [0, 1], "lasso": [[0, 0], [1, 0], [1, 1]], "time": []}
    browser.reply({"type": "select", "selection": good})
    for bad in (
        {"x": [0], "y": None, "lasso": None},
        {"x": None, "y": None, "lasso": [[0]]},
        {"x": None, "y": None, "lasso": [[0, 0], [1, 1]]},
        {"x": [0, float("nan")], "y": None, "lasso": None},
        {"x": [0, 1], "y": None, "lasso": None, "time": ["z"]},
        "x",
    ):
        browser.reply({"type": "select", "selection": bad})
    assert widget.selection == hg.Selection(x=(0, 1), y=(0, 1), lasso=((0, 0), (1, 0), (1, 1)))
    assert widget.get_state()["_chart"]["selection"] == good
    # A selection of nothing is none.
    browser.reply({"type": "select", "selection": {"x": None, "y": None, "lasso": None}})
    assert widget.selection is None


def test_giving_panels_y_scales_of_their_own_lets_go_of_the_y_viewport():
    widget = hg.Chart(data(), zoom="x", facet="host").line(x="t", y="v").widget()
    browser = Browser(widget)
    viewports = []
    widget.on_viewport(viewports.append)
    widget.viewport = hg.Viewport(y=(0, 10))
    widget.update(y=hg.AxisOptions(scope="panel"))
    assert widget.viewport == hg.Viewport() and viewports[-1] == hg.Viewport()
    assert browser.last[0]["viewport"]["y"] is None
    widget.update(y=hg.AxisOptions(scope="chart"))
    # The same zoom again is a change.
    widget.viewport = hg.Viewport(y=(0, 10))
    assert len(viewports) == 3 and browser.last[0]["viewport"]["y"] == [0, 10]


def test_charts_without_one_y_scale_refuse_a_y_viewport():
    widget = (
        hg.Chart(data(), zoom="x", facet="host", y=hg.AxisOptions(scope="panel"))
        .line(x="t", y="v")
        .widget()
    )
    widget.viewport = (T0, T0 + dt.timedelta(seconds=30))
    with pytest.raises(
        ValueError, match="widget.viewport: charts whose panels have y scales of their own"
    ):
        widget.viewport = hg.Viewport(y=(0, 1))


def test_right_y_scales_of_their_own_refuse_only_a_right_y_viewport():
    chart = hg.Chart(data(), zoom="x", facet="host").line(x="t", y="v")
    widget = chart.line(x="t", y="v", axis="right").widget()
    browser = Browser(widget)
    widget.viewport = hg.Viewport(y=(0, 10), y_right=(0, 100))
    widget.update(y_right=hg.AxisOptions(scope="panel"))
    # The left zoom stays; the right one goes, as in the browser.
    assert widget.viewport == hg.Viewport(y=(0, 10))
    assert browser.last[0]["viewport"]["yRight"] is None
    with pytest.raises(
        ValueError, match="widget.viewport: charts whose panels have y scales of their own"
    ):
        widget.viewport = hg.Viewport(y_right=(0, 1))


def test_live_updates_refuse_a_y_zoom_over_right_y_scales_of_their_own():
    chart = hg.Chart(data(), zoom="xy", facet="host").line(x="t", y="v")
    widget = chart.line(x="t", y="v", axis="right").widget()
    browser = Browser(widget)
    sent = len(browser.sent)
    with pytest.raises(
        ValueError,
        match=r"Chart zoom: .* right y scales of their own \(y_right scope\) zoom along x only",
    ):
        widget.update(y_right=hg.AxisOptions(scope="panel"))
    # Nothing changed or went to the browser; zooming along x only is fine.
    assert widget._live._settings["y_right"] is None
    assert len(browser.sent) == sent
    widget.update(zoom="x", y_right=hg.AxisOptions(scope="panel"))
    with pytest.raises(
        ValueError,
        match=r"Chart zoom: .* y scales of their own \(y scope\) zoom along x",
    ):
        widget.update(zoom="xy", y=hg.AxisOptions(scope="panel"))
    # Rules at an x on the right place no values there.
    ruled = hg.Chart(data(), zoom="xy", facet="host").line(x="t", y="v")
    ruled.rule(x=T0, axis="right").widget().update(y_right=hg.AxisOptions(scope="panel"))


def zoom(browser, seconds, origin, revision):
    """A browser reports zooming to the first `seconds` of the data."""
    payload = {"x": [MS0, MS0 + seconds * 1000], "y": None, "yRight": None, "time": ["x"]}
    browser.reply({"type": "viewport", "viewport": payload, "origin": origin, "revision": revision})


def test_browser_viewports_made_before_another_change_are_dropped():
    widget, browser = live(zoom=True)
    viewports = []
    widget.on_viewport(viewports.append)
    widget.viewport = (T0, T0 + dt.timedelta(minutes=1))  # revision 1
    # Browser A zoomed before it drew Python's viewport: out of date.
    zoom(browser, 30, "A", 0)
    assert widget.viewport.x == (T0, T0 + dt.timedelta(minutes=1)) and len(viewports) == 1
    # After: it counts, and goes to the other browsers marked as A's.
    zoom(browser, 30, "A", 1)
    assert widget.viewport.x == (T0, T0 + dt.timedelta(seconds=30))
    assert browser.last[0] == {
        "type": "viewport",
        "viewport": {"x": [MS0, MS0 + 30_000], "y": None, "yRight": None, "time": ["x"]},
        "origin": "A",
        "revision": 2,
    }
    # A's next zoom, made before its own view came back, counts too.
    zoom(browser, 20, "A", 1)
    assert widget.viewport.x == (T0, T0 + dt.timedelta(seconds=20))
    # Browser B's zoom, made before A's, does not.
    zoom(browser, 10, "B", 2)
    assert widget.viewport.x == (T0, T0 + dt.timedelta(seconds=20))
    assert len(viewports) == 3
    # New browsers start from the current view.
    assert widget.get_state()["_chart"]["revision"] == 3


def test_hover_and_click_callbacks_receive_inspections():
    widget, browser = live()
    assert widget.get_state()["_listening"] == []
    hovered, clicked = [], []
    widget.on_hover(hovered.append)
    widget.on_click(clicked.append)
    assert sorted(widget._listening) == ["click", "hover"]
    point = {"mark": 0, "markId": None, "key": '[0,"a"]', "label": "a", "row": 0}
    inspection = {
        "axis": "x",
        "value": MS0,
        "time": True,
        "label": "00:00",
        "points": [{**point, "value": 1.0, "text": "1"}],
    }
    browser.reply({"type": "hover", "inspection": inspection})
    browser.reply({"type": "hover", "inspection": None})
    browser.reply({"type": "click", "inspection": inspection})
    expected = Inspection(
        axis="x",
        value=T0,
        label="00:00",
        points=(InspectedPoint("a", 1.0, "1", row=0, mark=0, key='[0,"a"]'),),
    )
    assert hovered == [expected, None]
    assert clicked == [expected]
    # Points summarizing rows have none; marks with an id name it.
    summary = {**point, "markId": "bins", "row": None, "value": 2.0, "text": "2"}
    decoded = decode_inspection({**inspection, "points": [summary]})
    assert decoded is not None and decoded.points[0].row is None
    assert decoded.points[0].mark_id == "bins"


def test_camera_callbacks_and_3d_items_receive_their_values():
    widget = hg.Chart({"x": [1.0], "y": [2.0], "z": [9.0]}).point_3d("x", "y", "z").widget()
    browser = Browser(widget)
    cameras, clicked = [], []
    widget.on_camera(cameras.append)
    widget.on_click(clicked.append)
    assert sorted(widget._listening) == ["camera", "click"]
    browser.reply({"type": "camera", "camera": {"azimuth": 30, "elevation": 10, "zoom": 2}})
    assert cameras == [hg.Camera(azimuth=30, elevation=10, zoom=2)]
    item = {
        "axis": "item",
        "value": 9,
        "time": False,
        "label": "Points",
        "points": [
            {
                "mark": 1,
                "markId": None,
                "key": "[1,4]",
                "label": "a",
                "row": 4,
                "value": 9,
                "text": "x 1, y 2, z 9",
            }
        ],
        "values": {"x": 1, "y": 2, "z": 9, "kind": "a"},
    }
    browser.reply({"type": "click", "inspection": item})
    assert clicked[0].values == {"x": 1, "y": 2, "z": 9, "kind": "a"}
    assert (clicked[0].points[0].mark, clicked[0].points[0].row) == (1, 4)


def test_event_payloads_decode_to_python_values():
    assert decode_viewport({"x": [1.5, 3.0], "y": ["a", "c"], "yRight": None}) == hg.Viewport(
        x=(1.5, 3.0), y=("a", "c")
    )
    assert decode_viewport(None) == hg.Viewport()
    times = {"x": [MS0, MS0], "y": [MS0, MS0], "lasso": [[MS0, MS0]] * 3, "time": ["y"]}
    assert decode_selection(times) == hg.Selection(x=(MS0, MS0), y=(T0, T0), lasso=((MS0, T0),) * 3)
    assert decode_selection(None) is None
    category = decode_inspection(
        {"axis": "y", "value": "west", "time": False, "label": "west", "panel": "eu", "points": []}
    )
    assert category == Inspection(axis="y", value="west", label="west", points=(), panel="eu")


def test_viewports_and_selections_encode_for_the_browser():
    assert encode_viewport((3, 1)) == {"x": [1.0, 3.0], "y": None, "yRight": None, "time": []}
    stamps = (np.datetime64("2026-01-01"), pd.Timestamp("2026-01-01 00:01"))
    assert encode_viewport(hg.Viewport(y_right=stamps))["yRight"] == [MS0, MS0 + 60_000]
    assert encode_viewport(None) == {"x": None, "y": None, "yRight": None, "time": []}
    assert encode_selection(("b", "a")) == {
        "x": ["b", "a"],
        "y": None,
        "lasso": None,
        "time": [],
    }
    lasso = encode_selection(hg.Selection(lasso=[(T0, 1), (T0, 2), (stamps[1], 2)]))
    assert lasso == {
        "x": None,
        "y": None,
        "lasso": [[MS0, 1.0], [MS0, 2.0], [MS0 + 60_000, 2.0]],
        "time": ["x"],
    }
    # A selection of nothing is none.
    assert encode_selection(hg.Selection()) is None
    with pytest.raises(
        ValueError, match="Viewport x: expected a \\(start, end\\) pair or None; received 5"
    ):
        encode_viewport(5)
    with pytest.raises(
        ValueError,
        match=r"Selection x: a range of categories needs two category labels; received \('a', 1\)",
    ):
        encode_selection(("a", 1))
    with pytest.raises(ValueError, match="Viewport x: expected finite values; received nan"):
        encode_viewport((0, float("nan")))
    with pytest.raises(ValueError, match="Selection lasso: expected at least 3 points; received 2"):
        encode_selection(hg.Selection(lasso=[(0, 0), (1, 1)]))


@pytest.mark.parametrize("kind", ["treemap", "sunburst"])
def test_drill_state_callbacks_resets_and_redisplay(kind):
    widget = getattr(hg.Chart({"region": ["East", "West"]}, zoom=True), kind)(
        path=["region"]
    ).widget()
    browser = Browser(widget)
    roots = []
    widget.on_drill(roots.append)
    root = ('[0,"East"]',)
    widget.drill_root = root
    assert roots == [root] and widget.drill_root == root
    assert browser.last[0] == {"type": "drill", "drill_root": {"path": list(root)}, "revision": 1}
    browser.reply({"type": "drill", "drill_root": {"path": list(root)}, "revision": 1})
    assert roots == [root]
    assert widget.get_state()["_chart"]["drill_root"] == {"path": list(root)}
    widget.drill_root = ()
    assert roots[-1] is None and widget.drill_root is None
    # Reports made before a Python assignment lose to that assignment.
    browser.reply(
        {"type": "drill", "drill_root": {"path": list(root)}, "origin": "old", "revision": 1}
    )
    assert widget.drill_root is None
    widget.on_drill(roots.append, remove=True)
    browser.reply({"type": "drill", "drill_root": {"path": list(root)}, "revision": 2})
    assert len(roots) == 2 and widget.drill_root == root
    browser.reply({"type": "drill", "drill_root": {"path": [42]}, "revision": 3})
    assert widget.drill_root == root
    with pytest.raises(ValueError, match="widget.drill_root: expected"):
        widget.drill_root = "East"


def network():
    return hg.graph(
        {"source": ["a", "b"], "target": ["b", "c"]}, "source", "target", drag=True
    ).widget()


def test_item_positions_replace_reset_copy_and_report_without_listeners():
    widget = network()
    browser = Browser(widget)
    moves = []
    widget.on_item_move(moves.append)
    positions = {'[0,"a"]': (np.float64(1), np.int64(2)), '[0,"b"]': (3, 4)}
    widget.item_positions = positions
    assert widget.item_positions == positions and moves == [positions]
    assert browser.last[0]["item_positions"] == {key: list(at) for key, at in positions.items()}
    # Reordering keys and browser echoes do not call Python twice.
    widget.item_positions = dict(reversed(list(positions.items())))
    assert len(moves) == 1
    returned = widget.item_positions
    returned.clear()
    moves[0].clear()
    assert widget.item_positions == positions
    widget.item_positions = {'[0,"a"]': (5, 6)}
    assert widget.get_state()["_chart"]["item_positions"] == {'[0,"a"]': [5.0, 6.0]}
    widget.item_positions = {}
    assert moves[-1] == {} and widget.item_positions == {}
    widget.on_item_move(moves.append, remove=True)
    browser.reply({"type": "itemMove", "item_positions": {'[0,"b"]': [8, 9]}, "revision": 3})
    assert widget.item_positions == {'[0,"b"]': (8.0, 9.0)}
    assert len(moves) == 3
    browser.reply({"type": "itemMove", "item_positions": {'[0,"b"]': [True, 0]}, "revision": 4})
    assert widget.item_positions == {'[0,"b"]': (8.0, 9.0)}


@pytest.mark.parametrize(
    "value",
    [
        None,
        {1: (0, 1)},
        {"a": "12"},
        {"a": (1,)},
        {"a": (True, 2)},
        {"a": (float("nan"), 2)},
        {"a": (float("inf"), 2)},
    ],
)
def test_invalid_positions_do_not_change_state(value):
    widget = network()
    with pytest.raises(ValueError, match="widget.item_positions:"):
        widget.item_positions = value
    assert widget.item_positions == {}


def test_network_data_changes_keep_moves_of_nodes_that_remain_and_rebase_delayed_reports():
    widget = network()
    browser = Browser(widget)
    widget.append({"source": [], "target": []})
    assert not browser.messages
    widget.replace({"source": ["b"], "target": ["c"]})
    sent = len(browser.messages)
    browser.reply(
        {
            "type": "itemMove",
            "item_positions": {'[0,"a"]': [0, 0], '[0,"b"]': [1, 2]},
            "origin": "old",
            "revision": 0,
        }
    )
    # A report made on the data before its change is taken without the nodes
    # the change took, as the browser that made it lets go of them too.
    assert widget.item_positions == {'[0,"b"]': (1.0, 2.0)}
    (taken,) = (content for content, _ in browser.messages[sent:])
    assert taken["type"] == "itemMove" and taken["origin"] == "old"
    # A later report of that browser's, made before the change too, still counts.
    browser.reply(
        {"type": "itemMove", "item_positions": {'[0,"b"]': [3, 3]}, "origin": "old", "revision": 0}
    )
    assert widget.item_positions == {'[0,"b"]': (3.0, 3.0)}
    widget.item_positions = {'[0,"b"]': (3, 4), '[0,"c"]': (5, 6)}
    # One made before Python's own assignment is dropped.
    browser.reply(
        {"type": "itemMove", "item_positions": {'[0,"b"]': [9, 9]}, "origin": "old", "revision": 1}
    )
    assert widget.item_positions == {'[0,"b"]': (3.0, 4.0), '[0,"c"]': (5.0, 6.0)}
    moves = []
    widget.on_item_move(moves.append)
    widget.update(title="Still moved")
    widget.append({"source": ["c"], "target": ["d"]})
    # Nodes that remain stay moved; Python hears of nothing.
    assert widget.item_positions == {'[0,"b"]': (3, 4), '[0,"c"]': (5, 6)} and moves == []
    sent = len(browser.messages)
    widget.replace({"source": ["c"], "target": ["d"]})
    # b is gone: its move goes, and listeners hear so. Browsers let it go
    # as they draw the change: only the data is sent.
    assert widget.item_positions == {'[0,"c"]': (5, 6)}
    assert moves == [{'[0,"c"]': (5.0, 6.0)}]
    assert [content["type"] for content, _ in browser.messages[sent:]] == ["replace"]
    assert widget.get_state()["_chart"]["item_positions"] == {'[0,"c"]': [5.0, 6.0]}
    # A browser's report of a move it had not sent, made on the new data, is taken.
    revision = browser.messages[-1][0]["revision"]
    browser.reply(
        {
            "type": "itemMove",
            "item_positions": {'[0,"c"]': [5, 6], '[0,"d"]': [7, 8]},
            "origin": "view",
            "revision": revision,
        }
    )
    assert widget.item_positions == {'[0,"c"]': (5.0, 6.0), '[0,"d"]': (7.0, 8.0)}


def test_rows_a_rolling_window_drops_take_their_nodes_moves():
    widget = network()
    Browser(widget)
    widget.item_positions = {'[0,"a"]': (1, 2), '[0,"b"]': (3, 4)}
    # Rows added take no node away; a's only row leaving the window does.
    widget.append({"source": ["c"], "target": ["d"]})
    assert set(widget.item_positions) == {'[0,"a"]', '[0,"b"]'}
    widget.append({"source": ["d"], "target": ["e"]}, max_rows=3)
    assert widget.item_positions == {'[0,"b"]': (3.0, 4.0)}


def test_item_state_setters_refuse_charts_without_the_controls():
    widget, _ = live()
    assert widget.drill_root is None and widget.item_positions == {}
    with pytest.raises(ValueError, match="widget.drill_root: the chart has no treemap or sunburst"):
        widget.drill_root = None
    with pytest.raises(ValueError, match="widget.item_positions: the chart has no network"):
        widget.item_positions = {}


@pytest.mark.parametrize("value", [{"a": (10**1000, 0)}, {"a": (np.bool_(True), 0)}])
def test_non_finite_or_boolean_numeric_scalars_are_rejected(value):
    widget = network()
    with pytest.raises(ValueError, match="widget.item_positions: expected two finite"):
        widget.item_positions = value


def test_delayed_moves_from_another_browser_lose_to_a_python_assignment():
    widget = network()
    browser = Browser(widget)
    widget.item_positions = {'[0,"a"]': (1, 2)}
    browser.reply(
        {"type": "itemMove", "item_positions": {'[0,"b"]': [3, 4]}, "origin": "old", "revision": 0}
    )
    assert widget.item_positions == {'[0,"a"]': (1.0, 2.0)}
    browser.reply(
        {"type": "itemMove", "item_positions": {'[0,"b"]': [3, 4]}, "origin": "new", "revision": 1}
    )
    assert widget.item_positions == {'[0,"b"]': (3.0, 4.0)}


def test_networks_of_derived_tables_keep_moves_until_a_browser_says_which_went():
    links = {"source": ["a", "b"], "target": ["b", "c"], "w": [1.0, 2.0]}
    kept = hg.derive(links).filter(hg.col("w") > 0)
    widget = hg.Chart(kept, drag=True).graph("source", "target").widget()
    browser = Browser(widget)
    widget.item_positions = {'[0,"a"]': (1, 2), '[0,"b"]': (3, 4)}
    # Python cannot tell which nodes a derived table keeps: the moves stay.
    widget.replace({"source": ["b"], "target": ["c"], "w": [1.0]}, data=links)
    assert widget.item_positions == {'[0,"a"]': (1.0, 2.0), '[0,"b"]': (3.0, 4.0)}
    # The browser, having drawn the change, reports the one its network let go of.
    revision = browser.messages[-1][0]["revision"]
    browser.reply(
        {
            "type": "itemMove",
            "item_positions": {'[0,"b"]': [3, 4]},
            "origin": "view",
            "revision": revision,
        }
    )
    assert widget.item_positions == {'[0,"b"]': (3.0, 4.0)}


def test_a_derived_networks_report_is_fenced_by_the_data_change_not_another_panels():
    links = {"source": ["a", "b"], "target": ["b", "c"], "w": [1.0, 2.0]}
    kept = hg.derive(links).filter(hg.col("w") > 0)
    widget = (
        hg.Chart(links, panels=["raw", "derived"], drag=True)
        .graph("source", "target", panel="raw")
        .graph("source", "target", data=kept, panel="derived")
        .widget()
    )
    browser = Browser(widget)
    widget.panel_item_positions = {
        "raw": {'[0,"a"]': (1, 2)},
        "derived": {'[1,"a"]': (3, 4), '[1,"b"]': (5, 6)},
    }
    sent = len(browser.messages)
    widget.replace({"source": ["b"], "target": ["c"], "w": [1.0]}, data=links)
    # The raw network lost a; the browser lets go of it too as it draws the change.
    (replaced,) = (content for content, _ in browser.messages[sent:])
    assert replaced["type"] == "replace"
    assert widget.panel_item_positions["raw"] == {}
    # The browser drew the change and says which moves the derived network kept.
    browser.reply(
        {
            "type": "itemMove",
            "item_positions": {'[1,"b"]': [5, 6]},
            "panel": "derived",
            "origin": "view",
            "revision": replaced["revision"],
        }
    )
    assert widget.panel_item_positions["derived"] == {'[1,"b"]': (5.0, 6.0)}


def test_moves_under_keys_of_another_shape_go_with_a_data_change():
    widget = network()
    Browser(widget)
    widget.item_positions = {'[[0], "a"]': (1, 2), "not json": (3, 4), '[0,"a"]': (5, 6)}
    # Such keys name no node: a data change lets them go, as the browser does.
    widget.replace({"source": ["a", "c"], "target": ["b", "d"]})
    assert widget.item_positions == {'[0,"a"]': (5.0, 6.0)}


def test_camera_state_is_per_panel_and_rejects_invalid_or_stale_reports():
    data = {"x": [0.0, 1.0], "y": [0.0, 1.0], "z": [1.0, 2.0]}
    widget = (
        hg.Chart(data, panels=["a", "b"])
        .point_3d("x", "y", "z", panel="a")
        .line_3d("x", "y", "z", panel="b")
        .widget()
    )
    browser = Browser(widget)
    with pytest.raises(ValueError, match="widget.camera"):
        _ = widget.camera
    with pytest.raises(ValueError, match="widget.on_camera"):
        widget.on_camera(lambda camera: None)
    seen = []
    widget.on_camera(seen.append, panel="b")
    widget.panel_cameras = {"a": hg.Camera(azimuth=10), "b": hg.Camera(azimuth=90)}
    assert widget.panel_cameras["a"].azimuth == 10
    revision = widget._revision
    seen.clear()
    browser.reply(
        {
            "type": "camera",
            "panel": "b",
            "camera": {"azimuth": 80},
            "origin": "browser",
            "revision": revision,
        }
    )
    assert seen == [hg.Camera(azimuth=80)]
    assert widget.panel_cameras["a"].azimuth == 10
    browser.reply(
        {
            "type": "camera",
            "panel": "b",
            "camera": {"elevation": 200},
            "origin": "browser",
            "revision": widget._revision,
        }
    )
    assert len(seen) == 1
    widget.panel_cameras = {"b": hg.Camera(azimuth=60)}
    browser.reply(
        {
            "type": "camera",
            "panel": "b",
            "camera": {"azimuth": 20},
            "origin": "browser",
            "revision": revision,
        }
    )
    assert widget.panel_cameras["b"].azimuth == 60
    widget.panel_cameras = {"b": None}
    assert widget.panel_cameras == {"a": hg.Camera(azimuth=10), "b": None}
    snapshot = widget._snapshot()
    assert snapshot["panel_states"]["camera"]["a"]["azimuth"] == 10


def test_camera_defaults_reconcile_before_display_and_reject_old_browser_reports():
    widget = (
        hg.Chart(
            {"x": [0, 1], "y": [0, 1], "z": [0, 1]},
            panels=[
                hg.Panel("a", camera={"azimuth": 20}),
                hg.Panel("b", camera={"azimuth": 90, "elevation": 25}),
            ],
        )
        .point_3d("x", "y", "z", panel="a")
        .line_3d("x", "y", "z", panel="b")
        .widget()
    )
    browser = Browser(widget)
    widget.panel_cameras = {"a": hg.Camera(azimuth=40), "b": hg.Camera(azimuth=70, zoom=2)}
    revision = widget._revision
    widget.update(camera=hg.Camera(elevation=55))
    assert widget.panel_cameras == {
        "a": hg.Camera(azimuth=20, elevation=55),
        "b": hg.Camera(azimuth=70, zoom=2),
    }
    snapshot = widget._snapshot()
    assert snapshot["panel_states"]["camera"]["a"]["elevation"] == 55
    browser.reply(
        {
            "type": "camera",
            "panel": "a",
            "origin": "browser",
            "revision": revision,
            "camera": {"azimuth": 40, "elevation": 25},
        }
    )
    assert widget.panel_cameras["a"] == hg.Camera(azimuth=20, elevation=55)


def test_standalone_camera_defaults_reconcile_without_a_display():
    widget = hg.Chart({"x": [0, 1], "y": [0, 1], "z": [0, 1]}).point_3d("x", "y", "z").widget()
    widget.camera = hg.Camera(azimuth=40)
    widget.update(title="Unchanged defaults", camera={"azimuth": 300})
    assert widget.camera == hg.Camera(azimuth=40)
    widget.update(camera=hg.Camera(elevation=55))
    assert widget.camera == hg.Camera(elevation=55)
    assert widget._snapshot()["camera"]["elevation"] == 55


def test_camera_default_update_advances_barrier_even_when_state_already_matches():
    widget = hg.Chart({"x": [0, 1], "y": [0, 1], "z": [0, 1]}).point_3d("x", "y", "z").widget()
    browser = Browser(widget)
    widget.camera = hg.Camera(elevation=55)
    revision = widget._revision
    widget.update(camera=hg.Camera(elevation=55))
    browser.reply(
        {"type": "camera", "origin": "browser", "revision": revision, "camera": {"elevation": 25}}
    )
    assert widget.camera == hg.Camera(elevation=55)


def test_whole_chart_camera_recovery_keeps_only_unchanged_defaults():
    from herceg._live import LiveChart

    data = {"x": [0, 1], "y": [0, 1], "z": [0, 1]}

    def chart(azimuth):
        return (
            hg.Chart(data, panels=[hg.Panel("a", camera={"azimuth": azimuth}), "b"])
            .point_3d("x", "y", "z", panel="a")
            .line_3d("x", "y", "z", panel="b")
        )

    widget = chart(20).widget()
    widget.panel_cameras = {"a": hg.Camera(azimuth=40), "b": hg.Camera(azimuth=70, zoom=2)}
    with widget._lock:
        changed = widget._replace_live(LiveChart(chart(25)))
    assert changed == [("camera", "a")]
    assert widget.panel_cameras == {"a": hg.Camera(azimuth=25), "b": hg.Camera(azimuth=70, zoom=2)}
    assert widget._snapshot()["panel_states"]["camera"]["a"]["azimuth"] == 25
