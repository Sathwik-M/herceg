import numpy as np
import pandas as pd
import pytest

import herceg as hg
from herceg import RowSelection, SelectionBinding


def trips():
    return pd.DataFrame(
        {
            "km": [1.0, 2.0, 3.0, 4.0],
            "fare": [5.0, 9.0, 12.0, 20.0],
            "kind": ["a", "b", "a", "b"],
        }
    )


def test_a_binding_is_written_to_the_spec_with_its_table_named():
    spec, _ = (
        hg.Chart(trips(), brush="xy", row_selection=SelectionBinding("focus"))
        .point(x="km", y="fare")
        .to_spec()
    )
    assert spec["version"] == 8
    assert spec["rowSelection"] == {"channel": "focus", "data": "data"}
    other = trips()
    spec, _ = (
        hg.Chart(
            trips(),
            row_selection=[
                SelectionBinding("focus", events=["click"], effect="none"),
                SelectionBinding("near", data=other),
            ],
        )
        .point(x="km", y="fare")
        .line(x="km", y="fare", data=other)
        .to_spec()
    )
    assert spec["rowSelection"] == [
        {"channel": "focus", "data": "data", "events": ["click"], "effect": "none"},
        {"channel": "near", "data": "data2"},
    ]
    # Charts without one keep their version.
    assert hg.Chart(trips()).point(x="km", y="fare").to_spec()[0]["version"] == 4


def test_bindings_refuse_what_cannot_select_rows():
    with pytest.raises(ValueError, match="channel must be a name"):
        SelectionBinding("")
    with pytest.raises(ValueError, match="events are 'brush', 'lasso', and 'click'"):
        SelectionBinding("c", events=["drag"])  # type: ignore[list-item]
    with pytest.raises(TypeError, match="list of gestures"):
        SelectionBinding("c", events="click")  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="effect is 'highlight' or 'none'"):
        SelectionBinding("c", effect="filter")  # type: ignore[arg-type]
    with pytest.raises(TypeError, match="hg.SelectionBinding"):
        hg.Chart(trips(), row_selection="focus")  # type: ignore[arg-type]
    binding = SelectionBinding("c")
    with pytest.raises(ValueError, match="cannot select rows yet"):
        hg.Chart(trips(), row_selection=binding).pie(category="kind")
    two = hg.Chart(row_selection=binding).point(x="km", y="fare", data=trips())
    two.line(x="km", y="fare", data=trips())
    with pytest.raises(ValueError, match="needs data="):
        two.to_spec()
    lost = hg.Chart(trips(), row_selection=SelectionBinding("c", data=trips()))
    with pytest.raises(ValueError, match="given to one of the chart's marks"):
        lost.point(x="km", y="fare").to_spec()
    counted = hg.Chart(trips(), brush="xy", row_selection=binding).histogram(x="km")
    with pytest.raises(ValueError, match="brushed along its x axis only"):
        counted.to_spec()
    # A rug's ticks have a place along their own axis only.
    for brush in ("y", "xy"):
        ticks = hg.Chart(trips(), brush=brush, row_selection=binding).point(x="km", y="fare")
        with pytest.raises(ValueError, match="rug mark's rows are brushed along its x axis only"):
            ticks.rug("km").to_spec()
    hg.Chart(trips(), brush="x", row_selection=binding).rug("km").to_spec()
    # A horizontal histogram bins y, which brushes select along; its x holds counts.
    hg.Chart(trips(), brush="y", row_selection=binding).histogram(y="km").to_spec()
    with pytest.raises(ValueError, match="brushed along its y axis only"):
        hg.Chart(trips(), brush="x", row_selection=binding).histogram(y="km").to_spec()
    boxes = hg.Chart(trips(), brush="lasso", row_selection=binding).boxplot(x="kind", y="fare")
    with pytest.raises(ValueError, match="lassos cannot select the rows of boxplot"):
        boxes.to_spec()
    stats = pd.DataFrame(
        {"g": ["a", "b"], "lo": [0, 1], "q1": [1, 2], "mid": [2, 3], "q3": [3, 4], "hi": [4, 5]}
    )
    precomputed = hg.Chart(stats, brush="y", row_selection=binding).boxplot(
        y="g", low="lo", q1="q1", median="mid", q3="q3", high="hi"
    )
    precomputed.to_spec()  # categories along y: brushes along y select boxes
    sideways = hg.Chart(stats, brush="x", row_selection=binding).boxplot(
        y="g", low="lo", q1="q1", median="mid", q3="q3", high="hi"
    )
    with pytest.raises(ValueError, match="brushed along its y axis only"):
        sideways.to_spec()
    # Without the gesture among its events, nothing is refused.
    quiet = SelectionBinding("c", events=["click"])
    hg.Chart(trips(), brush="xy", row_selection=quiet).histogram(x="km").to_spec()


pytest.importorskip("anywidget")


class Browser:
    """Stands in for the browser on a widget's comm."""

    def __init__(self, widget):
        self.widget = widget
        self.sent = []
        widget.comm.send = lambda data=None, buffers=None, **_: self.sent.append((data, buffers))

    def report(self, selection, rows=None, origin="b1"):
        content = {"type": "rowSelection", "table": "data", "channel": "focus", "origin": origin}
        buffers = [] if rows is None else [np.asarray(rows, dtype="<f8").tobytes()]
        self.widget._handle_custom_msg({**content, "selection": selection}, buffers)

    @property
    def messages(self):
        return [(d["content"], b) for d, b in self.sent if d["method"] == "custom"]


def live(**options):
    chart = hg.Chart(trips(), brush="x", row_selection=SelectionBinding("focus"), **options)
    widget = chart.point(x="km", y="fare").widget()
    return widget, Browser(widget)


def test_live_charts_report_rows_by_position_after_rows_stream():
    widget, browser = live()
    reports: list[RowSelection] = []
    widget.on_row_selection(reports.append)
    state = widget.get_state()["_chart"]
    assert state["rows"] == {"data": [0, 0]}
    assert state["rowSelections"] == [{"table": "data", "channel": "focus", "selection": None}]
    browser.report({"kind": "rows", "generation": 0}, [1, 3])
    assert reports[-1].rows.tolist() == [1, 3]
    assert widget.row_selection.rows.tolist() == [1, 3]
    # A rolling window drops two rows: the browser's numbers still say which rows.
    widget.append({"km": [5.0, 6.0], "fare": [1.0, 2.0], "kind": ["a", "a"]}, max_rows=4)
    assert widget.get_state()["_chart"]["rows"] == {"data": [2, 0]}
    browser.report({"kind": "rows", "generation": 0}, [1, 3, 4])
    assert reports[-1].rows.tolist() == [1, 2]
    # After a replace, rows of before it are gone, and reports of them dropped.
    widget.replace(trips())
    assert not widget.row_selection.selected
    count = len(reports)
    browser.report({"kind": "rows", "generation": 0}, [0])
    assert len(reports) == count
    browser.report({"kind": "rows", "generation": 1}, [0])
    assert reports[-1].rows.tolist() == [0]


def test_rows_python_selected_follow_their_rows_and_outlive_stale_reports():
    widget, browser = live()
    widget.row_selection = [1, 3]
    widget.append({"km": [5.0, 6.0], "fare": [1.0, 2.0], "kind": ["a", "a"]}, max_rows=4)
    assert widget.row_selection.rows.tolist() == [1]
    # A browser's report made before Python's change does not undo it.
    widget.row_selection = [0]
    stale = {"type": "rowSelection", "table": "data", "channel": "focus", "origin": "b1"}
    widget._handle_custom_msg(
        {**stale, "revision": 0, "selection": {"kind": "rows", "generation": 0}},
        [np.asarray([3.0], dtype="<f8").tobytes()],
    )
    assert widget.row_selection.rows.tolist() == [0]
    # Rows selected before a replace are gone; a browser connecting after it gets none.
    widget.replace(trips().iloc[:1])
    assert widget.get_state()["_chart"]["rowSelections"][0]["selection"] is None
    widget.row_selection = hg.col("km") > 0
    widget.replace(trips())
    assert widget.row_selection.condition is not None


def test_live_charts_report_conditions_and_clearing():
    widget, browser = live()
    reports: list[RowSelection] = []
    widget.on_row_selection(reports.append)
    condition = ["and", [">=", ["field", "km"], 1.5], ["<=", ["field", "km"], 3.5]]
    browser.report({"kind": "predicate", "expression": condition})
    assert reports[-1].condition is not None
    assert reports[-1].condition._json == condition
    assert reports[-1].rows is None and reports[-1].selected
    assert reports[-1].data is not None
    browser.report(None)
    assert not reports[-1].selected
    # What other browsers of the widget show: the same, from Python.
    content, buffers = browser.messages[-1]
    assert content["type"] == "rows" and content["origin"] == "b1"
    assert content["selection"] is None
    # Reports of another shape change nothing.
    browser.report({"kind": "rows"})
    assert len(reports) == 2


def test_python_selects_rows_conditions_and_nothing():
    widget, browser = live()
    reports: list[RowSelection] = []
    widget.on_row_selection(reports.append)
    widget.row_selection = [3, 1]
    content, buffers = browser.messages[-1]
    assert content == {
        "type": "rows",
        "table": "data",
        "channel": "focus",
        "selection": {"kind": "rows"},
        "revision": 1,
    }
    assert np.frombuffer(buffers[0], dtype="<u4").tolist() == [1, 3]
    assert reports[-1].rows.tolist() == [1, 3]
    widget.row_selection = np.array([True, False, False, True])
    assert widget.row_selection.rows.tolist() == [0, 3]
    widget.row_selection = hg.col("fare") > 10
    assert browser.messages[-1][0]["selection"]["kind"] == "predicate"
    # A browser that connects later restores what the channel holds.
    widget.row_selection = [2]
    state = widget.get_state()["_chart"]
    (held,) = state["rowSelections"]
    assert held["selection"] == {"kind": "rows", "rows": len(state["buffers"]) - 1}
    assert np.frombuffer(state["buffers"][-1], dtype="<u4").tolist() == [2]
    widget.row_selection = None
    assert not widget.row_selection.selected
    with pytest.raises(ValueError, match="positions in the data's 4 rows"):
        widget.row_selection = [9]
    with pytest.raises(ValueError, match="one value per row"):
        widget.row_selection = [True, False]


def test_conditions_set_from_python_test_columns_the_browser_has():
    # This chart draws km and fare; another widget's brush may test kind.
    widget, browser = live()
    with pytest.raises(ValueError, match=r"no column 'kind'.*fields=\['kind'\]"):
        widget.row_selection = hg.col("kind") == "a"
    assert not widget.row_selection.selected
    carried = hg.Chart(
        trips(), brush="x", row_selection=SelectionBinding("focus", fields=["kind"])
    ).point(x="km", y="fare")
    spec, _ = carried.to_spec()
    assert set(spec["data"]["data"]["columns"]) == {"km", "fare", "kind"}
    sending = carried.widget()
    sending.row_selection = hg.col("kind") == "a"
    assert sending.row_selection.condition is not None
    with pytest.raises(ValueError, match="'cost' is not one"):
        hg.Chart(trips(), row_selection=SelectionBinding("c", fields=["cost"])).point(
            x="km", y="fare"
        ).to_spec()
    with pytest.raises(TypeError, match="list of column names"):
        SelectionBinding("c", fields="kind")


def test_widgets_without_one_binding_have_no_one_row_selection():
    plain = hg.Chart(trips()).point(x="km", y="fare").widget()
    assert plain.row_selection is None
    with pytest.raises(ValueError, match="has no row_selection"):
        plain.row_selection = [0]
    with pytest.raises(ValueError, match="bind the data a derived table derives from"):
        derived = hg.derive(trips()).filter(hg.col("km") > 1)
        hg.Chart(derived, row_selection=SelectionBinding("c")).point(x="km", y="fare").widget()


def test_streamlit_reads_rows_of_its_own_run_only():
    pytest.importorskip("streamlit")
    from herceg import streamlit as hst

    chart = hg.Chart(trips(), row_selection=SelectionBinding("focus")).point(x="km", y="fare")
    payload = {
        "table": "data",
        "channel": "focus",
        "epoch": "e1",
        "selection": {"kind": "rows", "rows": [0, 2]},
    }
    state = hst._state({"rows": payload}, chart, "e1")
    assert state.row_selection is not None
    assert state.row_selection.rows.tolist() == [0, 2]
    assert hst._state({"rows": payload}, chart, "e2").row_selection is None
    condition = {**payload, "selection": {"kind": "predicate", "expression": True}}
    assert hst._state({"rows": condition}, chart, "e1").row_selection.condition is not None
    odd = {**payload, "selection": {"kind": "rows", "rows": ["a"]}}
    assert hst._state({"rows": odd}, chart, "e1").row_selection is None
    # State of a binding the chart no longer has: none, or of another table.
    unbound = hg.Chart(trips()).point(x="km", y="fare")
    assert hst._state({"rows": payload}, unbound, "e1").row_selection is None
    other = trips()
    moved = hg.Chart(trips(), row_selection=SelectionBinding("focus", data=other))
    moved.point(x="km", y="fare").line(x="km", y="fare", data=other)
    assert hst._state({"rows": payload}, moved, "e1").row_selection is None
    with pytest.raises(ValueError, match="give the chart one binding"):
        hst.chart(hg.Chart(trips()).point(x="km", y="fare"), on_row_selection="rerun")


def test_streamlit_names_the_data_not_how_it_is_drawn():
    pytest.importorskip("streamlit")
    from herceg import streamlit as hst

    seen: list[str] = []
    real = hst._payload

    def payload(spec, buffers, events, epoch=""):
        seen.append(epoch)
        return real(spec, buffers, events, epoch)

    binding = SelectionBinding("focus")
    hst._payload = payload  # type: ignore[assignment]
    try:
        for title in ("Before", "After"):
            chart = hg.Chart(trips(), title=title, row_selection=binding).point(x="km", y="fare")
            hst.chart(chart, on_row_selection="rerun")
        other = trips().assign(fare=[1.0, 2.0, 3.0, 4.0])
        hst.chart(hg.Chart(other, row_selection=binding).point(x="km", y="fare"))
    finally:
        hst._payload = real  # type: ignore[assignment]
    assert seen[0] == seen[1] != seen[2]
