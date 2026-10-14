import datetime as dt
import json
import struct
from pathlib import Path

import numpy as np
import pytest

import herceg as hg

pytest.importorskip("streamlit")

from streamlit.testing.v1 import AppTest  # noqa: E402

import herceg.streamlit as hst  # noqa: E402

EXAMPLE = Path(__file__).resolve().parents[1] / "examples" / "streamlit_app.py"
T0 = dt.datetime(2026, 1, 1)
MS0 = (T0 - dt.datetime(1970, 1, 1)).total_seconds() * 1000


def read(data: bytes):
    """Splits a payload as the browser does: header length, header, aligned buffers."""
    (length,) = struct.unpack_from("<I", data)
    header = json.loads(data[4 : 4 + length])
    start = -(-(4 + length) // 8) * 8
    buffers = [data[start + offset : start + offset + size] for offset, size in header["buffers"]]
    return header, buffers, start


def chart():
    data = {
        "t": np.array(["2026-01-01T00:00", "2026-01-01T00:01"], dtype="datetime64[ms]"),
        "v": np.array([1.0, 2.0], dtype="float32"),
        "host": ["a", "b"],
    }
    return hg.Chart(data, brush="x").line(x="t", y="v", series="host")


def test_the_payload_is_the_spec_then_aligned_buffers():
    spec, buffers = chart().to_spec()
    data = hst._payload(spec, buffers, ["select"], "a1b2")
    header, decoded, start = read(data)
    assert header == {
        "spec": spec,
        "buffers": header["buffers"],
        "events": ["select"],
        "epoch": "a1b2",
    }
    assert decoded == buffers
    # Every buffer starts at a multiple of 8 bytes, so typed arrays view it in place.
    assert all((start + offset) % 8 == 0 for offset, _ in header["buffers"])
    assert len(data) % 8 == 0
    with pytest.raises(ValueError, match="JSON"):
        hst._payload({"marks": [], "title": float("nan")}, [], [])


def test_point_animation_keys_serialize_in_streamlit_payloads():
    chart = hg.scatter(
        {"x": [1.0, 2.0], "y": [3.0, 4.0], "id": ["a", "b"], "unused": [5, 6]},
        "x",
        "y",
        animation_key="id",
    )
    spec, buffers = chart.to_spec()
    header, decoded, _ = read(hst._payload(spec, buffers, []))
    assert header["spec"]["marks"][0]["animationKey"] == "id"
    assert sorted(header["spec"]["data"]["data"]["columns"]) == ["id", "x", "y"]
    assert decoded == buffers


def test_the_result_decodes_to_python_values():
    state = hst._state(
        {
            "selection": {"x": [MS0, MS0 + 60_000], "y": ["a", "b"], "lasso": None, "time": ["x"]},
            "click": {
                "axis": "x",
                "value": MS0,
                "time": True,
                "label": "00:00",
                "points": [
                    {"mark": 0, "markId": None, "key": '[0,"a"]', "label": "a", "row": 1}
                    | {"value": 1.0, "text": "1"}
                ],
            },
        }
    )
    assert state.selection == hg.Selection(x=(T0, T0 + dt.timedelta(minutes=1)), y=("a", "b"))
    point = hg.InspectedPoint("a", 1.0, "1", row=1, mark=0, key='[0,"a"]')
    assert state.click == hg.Inspection(axis="x", value=T0, label="00:00", points=(point,))
    assert hst._state({}) == hst.ChartState(selection=None, click=None)
    # A selection of another shape, or of nothing, is none.
    for odd in ({"x": [1.0], "y": None, "lasso": None}, {"x": None, "y": None, "lasso": None}):
        assert hst._state({"selection": odd}) == hst.ChartState()


def test_reactions_are_checked():
    with pytest.raises(
        ValueError,
        match='streamlit.chart on_select: expected "ignore", .*; received "always"',
    ):
        hst.chart(chart(), on_select="always")


def test_charts_with_x_scales_of_their_own_show_but_cannot_report_selections():
    data = {"x": [0.0, 1.0, 10.0, 11.0], "y": [1.0, 2.0, 3.0, 4.0], "g": ["a", "a", "b", "b"]}
    split = hg.Chart(data, facet="g", resolve_x="independent", brush="x").line(x="x", y="y")
    assert hst.chart(split) == hst.ChartState()
    assert hst.chart(split, on_click="rerun") == hst.ChartState()
    with pytest.raises(
        ValueError,
        match="streamlit.chart on_select: reports one selection, so the chart's panels",
    ):
        hst.chart(split, on_select="rerun")


def test_outside_a_running_app_the_chart_has_no_state():
    assert hst.chart(chart(), on_select="rerun") == hst.ChartState()


def app():
    import numpy as np
    import streamlit as st

    import herceg as hg
    import herceg.streamlit as hst

    data = {"x": np.arange(3.0), "y": np.array([1.0, 3.0, 2.0])}
    chart = hg.Chart(data, brush="x").line(x="x", y="y")
    state = hst.chart(chart, key="chart", on_select="rerun", on_click=lambda: None)
    selection = state.selection and state.selection.x
    st.json({"selection": selection, "click": state.click and state.click.label})
    hst.chart(hg.Chart(data, theme="dark").point(x="x", y="y"), key="other")


def test_an_app_sends_the_chart_and_reads_its_selection():
    at = AppTest.from_function(app, default_timeout=60).run()
    assert not at.exception
    first, second = (element.proto for element in at.main if element.type == "bidi_component")
    assert first.component_name == "herceg.chart" and first.js_content
    header, buffers, _ = read(first.bytes)
    assert header["events"] == ["select", "click"]
    assert header["spec"]["marks"] == [{"type": "line", "x": "x", "y": "y", "data": "data"}]
    assert np.frombuffer(buffers[1], dtype="<f8").tolist() == [1.0, 3.0, 2.0]
    assert read(second.bytes)[0]["events"] == []
    # A chart's own theme travels; without one, the browser follows the app's.
    assert "theme" not in header["spec"]
    assert read(second.bytes)[0]["spec"]["theme"] == "dark"
    # The browser reports a brushed range: the next run returns it.
    brushed = {"x": [0.5, 1.5], "y": None, "lasso": None, "time": []}
    at.session_state["chart"] = {"selection": brushed}
    at.run()
    assert json.loads(at.json[0].proto.body) == {"selection": [0.5, 1.5], "click": None}


def form_app():
    import numpy as np
    import streamlit as st

    import herceg as hg
    import herceg.streamlit as hst

    chart = hg.Chart({"x": np.arange(3.0), "y": np.arange(3.0)}, brush="x").line(x="x", y="y")
    with st.form("brushes"):
        hst.chart(chart, key="brushed", on_select="rerun")
        st.form_submit_button()
    with st.form("clicks"):
        hst.chart(chart, key="clicked", on_click="rerun")
        st.form_submit_button()


def test_clicks_cannot_react_inside_forms():
    # Streamlit drops clicks (trigger values) sent from inside a form.
    at = AppTest.from_function(form_app, default_timeout=60).run()
    [error] = at.exception
    assert "streamlit.chart on_click: cannot react inside st.form" in error.message
    # A selection in a form is fine: it arrives when the form is submitted.
    assert len(at.get("bidi_component")) == 1


def test_the_example_app_runs():
    at = AppTest.from_file(str(EXAMPLE), default_timeout=60).run()
    assert not at.exception
    assert any(element.type == "bidi_component" for element in at.main)


def test_drills_and_moves_have_typed_values_and_independent_defaults():
    result = {
        "drill_root": {"root": {"path": ['[0,"East"]', '[0,"East","City"]']}},
        "item_positions": {"epoch": "layout", "positions": {'[0,"a"]': [1, 2]}},
    }
    state = hst._state(result, item_epoch="layout")
    assert state.drill_root == ('[0,"East"]', '[0,"East","City"]')
    assert state.item_positions == {'[0,"a"]': (1.0, 2.0)}
    assert hst._state(result, item_epoch="other").item_positions == {}
    assert hst._state({"drill_root": {"root": {"path": [2]}}}).drill_root is None
    result["item_positions"]["positions"] = {"a": [True, 2]}
    assert hst._state(result, item_epoch="layout").item_positions == {}
    first = hst.ChartState()
    first.item_positions["a"] = (0, 0)
    assert hst.ChartState().item_positions == {}


def test_new_reactions_use_one_payload_and_state_callbacks(monkeypatch):
    calls = []

    def component(**kwargs):
        calls.append(kwargs)
        header, _, _ = read(kwargs["data"])
        return {
            "drill_root": {"root": {"path": ['[0,"a"]']}},
            "item_positions": {"epoch": header["itemEpoch"], "positions": {'[0,"a"]': [1, 2]}},
        }

    monkeypatch.setattr(hst, "_component", lambda: component)
    graph = hg.graph({"source": ["a"], "target": ["b"]}, "source", "target", drag=True)

    def callback():
        pass

    state = hst.chart(graph, key="g", on_drill="rerun", on_item_move=callback)
    assert state.item_positions == {'[0,"a"]': (1.0, 2.0)}
    assert len(calls) == 1
    assert read(calls[0]["data"])[0]["events"] == ["drill", "itemMove"]
    assert calls[0]["on_item_positions_change"] is callback
    assert callable(calls[0]["on_drill_root_change"])
    spec, _ = graph.to_spec()
    # Moves and node places belong to the network's mark and panels, whatever its data or styles.
    epoch = hst._item_epoch(spec)
    assert hst._item_epoch({**spec, "title": "Styled"}) == epoch
    changed = {**spec, "marks": [{**spec["marks"][0], "directed": True}]}
    assert hst._item_epoch(changed) == epoch
    assert hst._item_epoch({**spec, "marks": [{**spec["marks"][0], "id": "net"}]}) != epoch
    assert hst._item_epoch({**spec, "marks": []}) is None
    for name in ("on_drill", "on_item_move"):
        with pytest.raises(ValueError, match=f"streamlit.chart {name}: expected"):
            hst.chart(graph, **{name: "always"})


def item_form_app():
    import streamlit as st

    import herceg as hg
    import herceg.streamlit as hst

    with st.form("items"):
        tree = hg.treemap({"region": ["East", "West"]}, path=["region"], zoom=True)
        root = hst.chart(tree, key="tree", on_drill="rerun")
        graph = hg.graph({"source": ["a"], "target": ["b"]}, "source", "target", drag=True)
        moves = hst.chart(graph, key="graph", on_item_move="rerun")
        st.form_submit_button()
    st.json({"root": root.drill_root, "positions": moves.item_positions})


def test_drill_and_move_state_reach_the_script_in_forms():
    at = AppTest.from_function(item_form_app, default_timeout=60).run()
    assert not at.exception
    components = [element.proto for element in at.get("bidi_component")]
    assert len(components) == 2
    graph_header = read(components[1].bytes)[0]
    at.session_state["tree"] = {"drill_root": {"root": {"path": ['[0,"East"]']}}}
    at.session_state["graph"] = {
        "item_positions": {"epoch": graph_header["itemEpoch"], "positions": {'[0,"a"]': [3, 4]}}
    }
    at.run()
    assert not at.exception
    assert json.loads(at.json[0].proto.body) == {
        "root": ['[0,"East"]'],
        "positions": {'[0,"a"]': [3.0, 4.0]},
    }


def test_viewport_state_and_reaction(monkeypatch):
    calls = []

    def component(**kwargs):
        calls.append(kwargs)
        header, _, _ = read(kwargs["data"])
        return {"viewport": {"x": [-80, 80], "y": [20, 80], "epoch": header["itemEpoch"]}}

    monkeypatch.setattr(hst, "_component", lambda: component)
    graph = hg.graph({"source": ["a"], "target": ["b"]}, "source", "target", zoom=True)
    state = hst.chart(graph, on_viewport="rerun")
    assert state.viewport == hg.Viewport(x=(-80.0, 80.0), y=(20.0, 80.0))
    assert read(calls[0]["data"])[0]["events"] == ["viewport"]
    assert callable(calls[0]["on_viewport_change"])
    assert (
        hst._state({"viewport": {"x": [1, 2], "epoch": "old"}}, item_epoch="new").viewport is None
    )
    assert hst._state({"viewport": {"x": [1]}}).viewport is None
    with pytest.raises(ValueError, match="streamlit.chart on_viewport: expected"):
        hst.chart(graph, on_viewport="always")


def test_camera_state_decodes_each_subplot_and_standalone():
    result = {
        "camera": {
            "camera": {"azimuth": 10},
            "panels": {"a": {"azimuth": 30}, "b": {"azimuth": 90}, "bad": {"elevation": 200}},
        }
    }
    state = hst._state(result)
    assert state.camera == hg.Camera(azimuth=10)
    assert state.panel_cameras == {"a": hg.Camera(azimuth=30), "b": hg.Camera(azimuth=90)}
