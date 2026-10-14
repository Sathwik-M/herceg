import datetime as dt
import inspect
import json
import re
from pathlib import Path

import numpy as np
import pytest

import herceg as hg

DATA = {
    "t": np.array(["2026-01-01T00:00", "2026-01-01T00:01"], dtype="datetime64[ms]"),
    "p50": np.array([1.0, 2.0]),
    "p99": np.array([3.0, 4.0]),
    "host": ["a", "b"],
    "unused": np.array([9.0, 9.0]),
}


def test_spec_uses_the_portable_format():
    chart = (
        hg.Chart(
            DATA, title="Latency", y=hg.Axis(title="ms", type="log"), time_zone="UTC", zoom=True
        )
        .line(x="t", y=["p50", "p99"], stroke_width=2)
        .rule(y=250, label="SLO")
    )
    spec, buffers = chart.to_spec()
    assert spec["version"] == 1
    assert spec["title"] == "Latency"
    assert spec["timeZone"] == "UTC"
    assert spec["y"] == {"type": "log", "title": "ms"}
    assert spec["interaction"] == {"zoom": True}
    brushed, _ = hg.Chart(DATA, brush="x", zoom=True).line(x="t", y="p50").to_spec()
    assert brushed["interaction"] == {"zoom": True, "brush": "x"}
    assert spec["marks"] == [
        {"type": "line", "x": "t", "y": ["p50", "p99"], "strokeWidth": 2, "data": "data"},
        {"type": "rule", "y": 250, "label": "SLO"},
    ]
    # Only the columns marks use travel, as binary buffers.
    columns = spec["data"]["data"]["columns"]
    assert sorted(columns) == ["p50", "p99", "t"]
    assert columns["t"] == {"type": "time", "dtype": "float64", "buffer": columns["t"]["buffer"]}
    assert len(buffers) == 3
    assert np.frombuffer(buffers[columns["p99"]["buffer"]], dtype="<f8").tolist() == [3.0, 4.0]


def test_animation_is_off_true_a_duration_or_options():
    def animation(**options):
        spec, _ = hg.Chart(DATA, **options).line(x="t", y="p50").to_spec()
        return spec.get("animation")

    assert animation() is None
    assert animation(animation=True) is True
    assert animation(animation=400) == {"duration": 400}
    assert animation(animation=hg.Animation(values=True)) == {"duration": 250, "values": True}
    assert animation(animation=hg.Animation(duration=0)) == {"duration": 0}
    for wrong in (-1, float("nan"), "slow"):
        with pytest.raises(
            ValueError, match="Chart animation: expected True, False, milliseconds of at least 0"
        ):
            hg.Chart(DATA, animation=wrong)
    with pytest.raises(
        ValueError, match="Animation duration: expected milliseconds of at least 0; received -5"
    ):
        hg.Chart(DATA, animation=hg.Animation(duration=-5))


@pytest.mark.parametrize("key", ["host", "unused", "t"])
def test_point_animation_keys_serialize_and_send_the_key_column(key):
    spec, buffers = hg.scatter(DATA, "p50", "p99", animation_key=key).to_spec()
    assert spec["marks"][0]["animationKey"] == key
    columns = spec["data"]["data"]["columns"]
    assert sorted(columns) == sorted(["p50", "p99", key])
    assert len(buffers) == 3
    direct, _ = hg.Chart(DATA).point("p50", "p99", animation_key=key).to_spec()
    assert direct == spec
    with pytest.raises(KeyError, match="point animation_key.*missing"):
        hg.scatter(DATA, "p50", "p99", animation_key="missing")


def test_categories_travel_as_codes_and_dictionary():
    spec, buffers = hg.Chart(DATA).bar(x="host", y="p50").to_spec()
    host = spec["data"]["data"]["columns"]["host"]
    assert host["type"] == "category" and host["dictionary"] == ["a", "b"]
    assert np.frombuffer(buffers[host["codes"]], dtype="<i4").tolist() == [0, 1]


def test_marks_with_their_own_data_get_their_own_table():
    other = {"x": [1, 2], "y": [3, 4]}
    spec, _ = hg.Chart(DATA).line(x="t", y="p50").point(x="x", y="y", data=other).to_spec()
    assert [mark["data"] for mark in spec["marks"]] == ["data", "data2"]
    assert sorted(spec["data"]) == ["data", "data2"]


def test_fields_are_checked_with_readable_errors():
    with pytest.raises(KeyError, match="line y: no column 'p90'; the data has 't', 'p50'"):
        hg.Chart(DATA).line(x="t", y="p90")
    # The correction names the column type that gives the kind expected.
    with pytest.raises(
        TypeError,
        match="line y: column 'host' holds category values; expected number or time; "
        "give numbers, not strings",
    ):
        hg.Chart(DATA).line(x="host", y="host")
    # A category y lays a line along y, unless orient says x.
    with pytest.raises(ValueError, match='line orient: "x" makes y the values'):
        hg.Chart(DATA).line(x="t", y="host", orient="x")
    with pytest.raises(
        TypeError,
        match="line series: column 'p50' holds number values; expected category; "
        "give its values as strings",
    ):
        hg.Chart(DATA).line(x="t", y="p50", series="p50")
    with pytest.raises(ValueError, match="rule: needs exactly one of x and y"):
        hg.Chart(DATA).rule()
    with pytest.raises(ValueError, match="Chart data: the chart has none"):
        hg.Chart().line(x="t", y="p50")


def test_express_helpers_and_rules_at_datetimes():
    spec, _ = hg.scatter(DATA, x="p50", y="p99", series="host", radius=3, title="S").to_spec()
    assert spec["title"] == "S"
    assert spec["marks"][0] == {
        "type": "point",
        "x": "p50",
        "y": "p99",
        "series": "host",
        "radius": 3,
        "data": "data",
    }
    spec, _ = hg.Chart(DATA).rule(x=dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)).to_spec()
    assert spec["marks"][0]["x"] == 1_767_225_600_000
    for helper, args in [
        (hg.line, ("t", "p50")),
        (hg.area, ("t", "p50")),
        (hg.bar, ("host", "p50")),
        (hg.heatmap, ("t", "host", "p50")),
    ]:
        assert helper(DATA, *args).to_spec()[0]["marks"][0]["type"] == helper.__name__


def test_unused_columns_are_never_converted():
    import polars as pl

    frame = pl.DataFrame({"x": [1.0, 2.0], "y": [3.0, 4.0], "tags": [["a"], ["b"]]})
    spec, _ = hg.line(frame, x="x", y="y").to_spec()
    assert sorted(spec["data"]["data"]["columns"]) == ["x", "y"]


def test_area_and_series_options_are_checked_like_the_spec_loader():
    with pytest.raises(ValueError, match="area y: y, or y1 and y2, not both"):
        hg.Chart(DATA).area(x="t", y="p50", y1="p50", y2="p99")
    with pytest.raises(ValueError, match="area y2: a band needs both y1 and y2"):
        hg.Chart(DATA).area(x="t", y1="p50")
    with pytest.raises(
        ValueError, match="area stack_gaps: applies to areas stacked by a series column"
    ):
        hg.Chart(DATA).area(x="t", y="p50", series="host", stack_gaps="zero")
    with pytest.raises(
        ValueError, match='area stack_gaps: expected "zero" or "interpolate"; received "linear"'
    ):
        hg.Chart(DATA).area(x="t", y="p50", series="host", stack=True, stack_gaps="linear")  # type: ignore[arg-type]
    with pytest.raises(
        ValueError, match="line series: several value columns or a series column, not both"
    ):
        hg.Chart(DATA).line(x="t", y=["p50", "p99"], series="host")


def test_outlines_and_constant_fills_reach_the_spec():
    values = {"x": [1.0, 2.0, 3.0], "y": [2.0, 3.0, 1.0], "c": ["a", "b", "a"]}
    outlined = (
        hg.Chart(values, width=300, height=200)
        .point("x", "y", stroke="#ffffff", stroke_width=1.5)
        .area("x", "y", stroke="#000000", stroke_width=2)
    )
    spec, _ = outlined.to_spec()
    point, area = spec["marks"]
    assert (point["stroke"], point["strokeWidth"]) == ("#ffffff", 1.5)
    assert (area["stroke"], area["strokeWidth"]) == ("#000000", 2)
    assert 'stroke-width="1.5"' in outlined.to_svg()
    filled = (
        hg.Chart(values, width=300, height=200)
        .boxplot("c", "y", fill="#2a9d8f")
        .violin("c", "y", fill="#2a9d8f")
    )
    spec, _ = filled.to_spec()
    assert [mark["fill"] for mark in spec["marks"]] == ["#2a9d8f", "#2a9d8f"]
    assert "#2a9d8f" in filled.to_svg()
    for mark in ("point", "area"):
        with pytest.raises(
            ValueError, match=f"{mark} stroke_width: expected 0 or more pixels; received -1"
        ):
            getattr(hg.Chart(values), mark)("x", "y", stroke_width=-1)


def test_areas_stack_by_a_series_column():
    values = {"t": [0.0, 1.0, 2.0, 0.0, 2.0], "n": [1.0, 2.0, 3.0, 10.0, 30.0], "s": [*"aaabb"]}
    chart = hg.area(values, "t", "n", series="s", stack=True, stack_gaps="interpolate")
    spec, _ = chart.to_spec()
    assert spec["marks"][0] == {
        "type": "area",
        "x": "t",
        "y": "n",
        "series": "s",
        "stack": True,
        "stackGaps": "interpolate",
        "data": "data",
    }
    # Both series are drawn, b through the minute it has no row at.
    assert chart.to_svg().count('fill-opacity="0.85"') == 2


def test_a_category_y_makes_bars_horizontal():
    spec, _ = hg.bar(DATA, x=["p50", "p99"], y="host", stack=True).to_spec()
    assert spec["marks"][0] == {
        "type": "bar",
        "x": ["p50", "p99"],
        "y": "host",
        "stack": True,
        "data": "data",
    }
    with pytest.raises(ValueError, match="bar x: several columns need a category y"):
        hg.bar(DATA, x=["p50", "p99"], y="p50")
    with pytest.raises(TypeError, match="bar x: column 'host' holds category values"):
        hg.bar(DATA, x="host", y="host")
    svg = hg.bar(DATA, x="p50", y="host", width=300, height=150).to_svg()
    assert svg.count('Z" fill') == 1


def test_annotations_take_constants_or_columns():
    events = {"at": np.array(["2026-01-01T00:00:30"], dtype="datetime64[ms]"), "name": ["deploy"]}
    chart = (
        hg.Chart(DATA, time_zone="UTC")
        .region(x1=dt.datetime(2026, 1, 1), x2=dt.datetime(2026, 1, 1, 0, 0, 20), label="warmup")
        .line(x="t", y="p50")
        .rule(x="at", text_field="name", data=events)
        .rule(y=np.float32(2.5), label="limit")
        .text(x="t", y="p99", text_field="host", dy=-8)
    )
    spec, _ = chart.to_spec()
    marks = spec["marks"]
    assert marks[0] == {
        "type": "region",
        "x1": 1767225600000.0,
        "x2": 1767225620000.0,
        "label": "warmup",
    }
    assert marks[2] == {"type": "rule", "x": "at", "textField": "name", "data": "data2"}
    assert marks[3] == {"type": "rule", "y": 2.5, "label": "limit"}
    assert (marks[4]["data"], marks[4]["textField"]) == ("data", "host")
    crowded, _ = hg.Chart(DATA).text(x="t", y="p50", text_field="host", overlap="move").to_spec()
    assert crowded["marks"][0]["overlap"] == "move"
    assert sorted(spec["data"]["data"]["columns"]) == ["host", "p50", "p99", "t"]
    svg = chart.to_svg()
    for label in ("warmup", "deploy", "limit", "a", "b"):
        assert f">{label}</text>" in svg


def test_annotation_options_are_checked():
    with pytest.raises(ValueError, match="text: needs exactly one of label and text_field"):
        hg.Chart(DATA).text(x=1, y=2)
    with pytest.raises(ValueError, match="region x2: needs both x1 and x2"):
        hg.Chart(DATA).region(x1=1)
    with pytest.raises(TypeError, match="rule x: column 'host'"):
        hg.Chart(DATA).rule(x="host")
    with pytest.raises(TypeError, match="text text_field: column 't'"):
        hg.Chart(DATA).text(x="t", y="p50", text_field="t")
    with pytest.raises(
        ValueError, match='text overlap: expected "show", "hide", or "move"; received "dodge"'
    ):
        hg.Chart(DATA).text(x="t", y="p50", text_field="host", overlap="dodge")  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="Chart data: the chart has none"):
        hg.Chart().rule(x="at")


def test_bars_write_their_values():
    spec, _ = hg.bar(DATA, x="host", y="p50", labels={"maximumFractionDigits": 1}).to_spec()
    assert spec["marks"][0]["labels"] == {"maximumFractionDigits": 1}
    # Empty Intl options still turn labels on, as in the spec.
    spec, _ = hg.bar(DATA, x="host", y="p50", labels={}).to_spec()
    assert spec["marks"][0]["labels"] == {}
    svg = hg.bar(DATA, x="host", y="p50", labels=True, width=300, height=150).to_svg()
    assert ">1</text>" in svg and ">2</text>" in svg


def test_error_bars_go_either_way():
    spec, _ = hg.Chart(DATA).error_bar(x="t", y1="p50", y2="p99", cap=4).to_spec()
    assert spec["marks"][0] == {
        "type": "errorbar",
        "x": "t",
        "y1": "p50",
        "y2": "p99",
        "cap": 4,
        "data": "data",
    }
    svg = hg.Chart(DATA, width=300, height=150).error_bar(y="host", x1="p50", x2="p99").to_svg()
    assert "<path" in svg
    with pytest.raises(ValueError, match="error_bar: needs x with y1 and y2"):
        hg.Chart(DATA).error_bar(x="t", y1="p50")
    symmetric, buffers = hg.Chart(DATA).error_bar(x="t", y="p50", y_error="p99").to_spec()
    assert symmetric["marks"][0]["yError"] == "p99"
    assert sorted(symmetric["data"]["data"]["columns"]) == ["p50", "p99", "t"]


def test_marks_go_on_the_right_axis():
    chart = (
        hg.Chart(DATA, y_right=hg.Axis(title="p99"), width=300, height=150)
        .line(x="t", y="p50")
        .line(x="t", y="p99", axis="right")
        .rule(y=5, axis="right")
    )
    spec, _ = chart.to_spec()
    assert spec["yRight"] == {"title": "p99"}
    assert [mark.get("axis") for mark in spec["marks"]] == [None, "right", "right"]
    assert 'transform="rotate(90 ' in chart.to_svg()
    with pytest.raises(ValueError, match="bar axis: horizontal bars have no right axis"):
        hg.Chart(DATA).bar(x="p50", y="host", axis="right")
    with pytest.raises(
        ValueError, match="error_bar axis: horizontal error bars have no right axis"
    ):
        hg.Chart(DATA).error_bar(y="host", x1="p50", x2="p99", axis="right")
    with pytest.raises(ValueError, match="error_bar y: bars from x, y1, y2 take no y"):
        hg.Chart(DATA).error_bar(x="t", y1="p50", y2="p99", y="p50")
    with pytest.raises(ValueError, match="error_bar x1: bars from y, x, x_error take no x1"):
        hg.Chart(DATA).error_bar(y="host", x="p50", x_error="p99", x1="p50")
    with pytest.raises(
        ValueError, match='line axis: expected "left" or "right"; received "middle"'
    ):
        hg.Chart(DATA).line(x="t", y="p50", axis="middle")  # type: ignore[arg-type]


def test_facets_split_marks_into_panels():
    chart = (
        hg.Chart(DATA, facet="host", facet_columns=2, width=400, height=200)
        .line(x="t", y="p50")
        .rule(y=2, label="limit")
        .line(x="t", y="p99", data={"t": DATA["t"], "p99": DATA["p99"]}, facet="repeat")
    )
    spec, _ = chart.to_spec()
    assert spec["facet"] == {"field": "host", "columns": 2}
    # The facet column travels with the data of marks it splits, and only those.
    assert sorted(spec["data"]["data"]["columns"]) == ["host", "p50", "t"]
    assert sorted(spec["data"]["data2"]["columns"]) == ["p99", "t"]
    assert spec["marks"][2]["facet"] == "repeat"
    svg = chart.to_svg()
    assert ">a</text>" in svg and ">b</text>" in svg
    with pytest.raises(KeyError, match="Chart facet: no column 'region'"):
        hg.Chart(DATA, facet="region").line(x="t", y="p50")
    # A rule over the table draws each row in its own row's panel.
    rules = hg.Chart(DATA, facet="host", width=400, height=200).line(x="t", y="p50").rule(x="t")
    spec, _ = rules.to_spec()
    assert "facet" not in spec["marks"][1]
    assert sorted(spec["data"]["data"]["columns"]) == ["host", "p50", "t"]
    with pytest.raises(ValueError, match="Chart facet_columns: wraps the panels of facet"):
        hg.Chart(DATA, facet_columns=2)
    with pytest.raises(
        ValueError,
        match="Chart facet_columns: expected a whole number of at least 1; received True",
    ):
        hg.Chart(DATA, facet="host", facet_columns=True)


def test_right_axes_in_facets_and_panels():
    chart = (
        hg.Chart(DATA, facet="host", y_right=hg.Axis(scope="panel"), width=400, height=200)
        .line(x="t", y="p50")
        .line(x="t", y="p99", axis="right")
    )
    spec, _ = chart.to_spec()
    assert spec["yRight"] == {"scope": "panel"}
    assert spec["marks"][1]["axis"] == "right"
    assert chart.to_svg().count("<svg") == 1
    subplots = (
        hg.Chart(DATA, panels=[hg.Panel("a", y_right=hg.Axis(title="p99", type="log")), "b"])
        .line(x="t", y="p50", panel="a")
        .line(x="t", y="p99", panel="a", axis="right")
        .line(x="t", y="p50", panel="b")
    )
    spec, _ = subplots.to_spec()
    assert spec["panels"][0] == {"id": "a", "yRight": {"title": "p99", "type": "log"}}
    assert ">p99</text>" in subplots.to_svg()
    with pytest.raises(
        ValueError,
        match='Axis scope: expected "chart", "panel", "row", or "column"; received "free"',
    ):
        hg.Axis(scope="free")  # type: ignore[arg-type]
    # A scope in a chart of one panel has one instance to give.
    assert "<svg" in hg.Chart(DATA, y_right=hg.Axis(scope="panel")).line(x="t", y="p50").to_svg()
    with pytest.raises(
        ValueError, match="Panel y scope: only the chart's x, y, and y_right take a scope"
    ):
        hg.Chart(DATA, panels=[hg.Panel("a", y=hg.Axis(scope="panel"))]).to_spec()
    zoomed = hg.Chart(DATA, facet="host", zoom="xy", y_right=hg.Axis(scope="panel"))
    with pytest.raises(
        ValueError,
        match=r"Chart zoom: .* right y scales of their own \(y_right scope\) zoom along x only",
    ):
        zoomed.line(x="t", y="p99", axis="right")
    # A rule at an x places no value on the right axis, so it has no scale to zoom.
    zoomed.rule(x=1, axis="right")


def test_facets_lay_panels_out_by_row_and_column():
    data = {**DATA, "zone": ["x", "y"]}
    chart = hg.Chart(data, facet_row="host", facet_column="zone", width=400, height=300).line(
        x="t", y="p50"
    )
    spec, _ = chart.to_spec()
    assert spec["facet"] == {"row": "host", "column": "zone"}
    assert sorted(spec["data"]["data"]["columns"]) == ["host", "p50", "t", "zone"]
    svg = chart.to_svg()
    assert ">x</text>" in svg and "rotate(90" in svg
    only_columns, _ = hg.Chart(data, facet_column="zone").line(x="t", y="p50").to_spec()
    assert only_columns["facet"] == {"column": "zone"}
    with pytest.raises(
        ValueError, match="Chart facet: facet, or facet_row and facet_column, not both"
    ):
        hg.Chart(data, facet="host", facet_row="zone")
    with pytest.raises(ValueError, match="Chart facet_column: 'host' is facet_row too"):
        hg.Chart(data, facet_row="host", facet_column="host")
    with pytest.raises(KeyError, match="Chart facet_column: no column 'region'"):
        hg.Chart(data, facet_row="host", facet_column="region").line(x="t", y="p50")


def test_facet_panels_can_have_y_scales_of_their_own():
    data = {**DATA, "zone": ["x", "y"]}
    chart = hg.Chart(data, facet_column="zone", y=hg.Axis(scope="panel")).line(x="t", y="p50")
    spec, _ = chart.to_spec()
    assert spec["y"] == {"scope": "panel"}
    assert "<svg" in chart.to_svg()
    with pytest.raises(
        ValueError,
        match=r"Chart zoom: .* y scales of their own \(y scope\) zoom along x",
    ):
        hg.Chart(data, facet="host", y=hg.Axis(scope="panel"), zoom="xy")


def test_panels_can_have_x_scales_of_their_own():
    data = {**DATA, "zone": ["x", "y"]}
    chart = hg.Chart(data, facet_column="zone", x=hg.Axis(scope="panel"), y=hg.Axis(scope="row"))
    spec, _ = chart.line(x="t", y="p50").to_spec()
    assert (spec["x"], spec["y"]) == ({"scope": "panel"}, {"scope": "row"})
    assert "<svg" in chart.to_svg()
    subplots = (
        hg.Chart(
            DATA,
            panels=[hg.Panel("a", x=hg.Axis(title="Time")), hg.Panel("b", x={"type": "log"})],
            panel_row_heights=[2, 1],
            x=hg.Axis(scope="panel"),
        )
        .line(x="t", y="p50", panel="a")
        .line(x="p50", y="p99", panel="b")
    )
    spec, _ = subplots.to_spec()
    assert spec["panels"] == [
        {"id": "a", "x": {"title": "Time"}},
        {"id": "b", "x": {"type": "log"}},
    ]
    assert spec["x"] == {"scope": "panel"}
    assert ">Time</text>" in subplots.to_svg()


def test_panels_can_have_categories_of_their_own():
    sales = {
        "region": ["N", "S", "E", "N", "S"],
        "product": ["b", "a", "c", "d", "c"],
        "kind": ["p", "p", "q", "q", "q"],
        "units": [1, 2, 3, 4, 5],
    }
    chart = hg.Chart(sales, facet="region", x=hg.Axis(scope="panel"), width=500, height=250).bar(
        x="product", y="units", series="kind", stack=True
    )
    spec, _ = chart.to_spec()
    assert spec["x"]["scope"] == "panel"
    assert spec["marks"][0]["stack"] is True
    svg = chart.to_svg()
    # Each panel labels its own categories: N's b and d, S's a and c, E's c.
    assert all(f">{label}</text>" in svg for label in "abcd")
    subplots = (
        hg.Chart(panels=["fruit", "cars"], panel_columns=2, width=500, height=250)
        .bar(x="v", y="name", data={"name": ["apple", "pear"], "v": [3, 4]}, panel="fruit")
        .bar(x="v", y="name", data={"name": ["vw", "audi"], "v": [5, 6]}, panel="cars")
    )
    assert ">audi</text>" in subplots.to_svg()
    # Error bars and candlesticks draw on each panel's own categories too.
    intervals = (
        hg.Chart(sales, facet="region", x=hg.Axis(scope="panel"), width=500, height=250)
        .error_bar(x="product", y="units", y_error="units")
        .candlestick(x="product", open="units", high="units", low="units", close="units")
    )
    assert intervals.to_spec()[0]["x"]["scope"] == "panel"
    assert all(f">{label}</text>" in intervals.to_svg() for label in "abcd")
    with pytest.raises(
        ValueError,
        match=r'Chart sync: panels with categories of their own \(x scope "row"\) cannot sync yet',
    ):
        hg.Chart(sales, facet="region", x=hg.Axis(scope="row"), sync="board").bar(
            x="product", y="units"
        )
    with pytest.raises(
        ValueError,
        match="Chart brush: panels with y categories of their own brush along x only",
    ):
        hg.Chart(sales, facet="region", y=hg.Axis(scope="panel"), brush="xy").bar(
            x="units", y="product"
        )
    # Shared, as before, the same marks are fine.
    hg.Chart(sales, facet="region", sync="board").bar(x="product", y="units")


def test_heatmaps_and_points_have_categories_of_their_own():
    load = {
        "region": ["N", "S", "N", "S"],
        "hour": ["b", "a", "d", "a"],
        "host": ["p", "q", "q", "p"],
        "cpu": [1.0, 2.0, 3.0, 4.0],
    }
    cells = hg.Chart(
        load,
        facet="region",
        x=hg.Axis(scope="panel"),
        y=hg.Axis(scope="panel"),
        width=500,
        height=250,
    ).heatmap(x="hour", y="host", color="cpu")
    spec, _ = cells.to_spec()
    assert (spec["x"]["scope"], spec["y"]["scope"]) == ("panel", "panel")
    assert spec["marks"][0]["type"] == "heatmap"
    assert "facet" not in spec["marks"][0]
    svg = cells.to_svg()
    # One image of cells per panel, each panel labeling its own categories.
    assert svg.count("<image ") == 2
    assert all(f">{label}</text>" in svg for label in ("a", "b", "d", "p", "q"))
    strip = hg.Chart(load, facet="region", x=hg.Axis(scope="panel"), width=500, height=250).point(
        x="hour", y="cpu"
    )
    spec, _ = strip.to_spec()
    assert (spec["marks"][0]["x"], spec["marks"][0]["y"]) == ("hour", "cpu")
    assert ">d</text>" in strip.to_svg()
    assert ">q</text>" in hg.scatter(load, x="cpu", y="host").to_svg()
    with pytest.raises(TypeError, match="point size: column 'host' holds category values"):
        hg.scatter(load, x="hour", y="cpu", size="host")


def test_histograms_and_box_plots_split_by_facets():
    load = {
        "region": ["N", "N", "N", "S", "S", "S"],
        "host": ["p", "p", "q", "q", "r", "r"],
        "ms": [1.0, 2.0, 3.0, 110.0, 120.0, 190.0],
    }
    binned = hg.Chart(load, facet="region", x=hg.Axis(scope="panel"), width=500, height=250)
    binned = binned.histogram(x="ms", bins={"step": 10})
    spec, _ = binned.to_spec()
    assert spec["facet"] == {"field": "region"}
    assert spec["x"]["scope"] == "panel"
    assert spec["marks"][0] == {
        "type": "histogram",
        "data": "data",
        "x": "ms",
        "bins": {"step": 10},
    }
    assert sorted(spec["data"]["data"]["columns"]) == ["ms", "region"]
    svg = binned.to_svg()
    # Each panel's bins span its own rows: N's 0 to 10, with ticks 0, 5, 10;
    # S's 110 to 190, with ticks 120 to 180.
    assert ">5</text>" in svg and ">180</text>" in svg
    boxes = hg.Chart(load, facet="region", x=hg.Axis(scope="panel"), width=500, height=250)
    boxes = boxes.boxplot(x="host", y="ms")
    spec, _ = boxes.to_spec()
    assert spec["marks"][0] == {"type": "boxplot", "data": "data", "x": "host", "y": "ms"}
    svg = boxes.to_svg()
    # N's p and q, S's q and r, each panel labeling its own.
    assert all(f">{label}</text>" in svg for label in ("p", "q", "r"))
    sideways = hg.Chart(load, facet="region", y=hg.Axis(scope="panel")).violin(x="ms", y="host")
    assert sideways.to_spec()[0]["y"]["scope"] == "panel"
    labeled = hg.Chart(load, facet="region", width=500, height=250).text(
        x="ms", y="ms", text_field="host"
    )
    spec, _ = labeled.to_spec()
    assert sorted(spec["data"]["data"]["columns"]) == ["host", "ms", "region"]
    assert ">r</text>" in labeled.to_svg()


def test_candlesticks_send_their_four_prices():
    prices = {
        "day": np.array(["2026-01-05", "2026-01-06"], dtype="datetime64[ms]"),
        "o": [10.0, 12.0],
        "h": [13.0, 12.5],
        "l": [9.0, 8.0],
        "c": [12.0, 9.0],
        "note": ["a", "b"],
    }
    chart = hg.candlestick(prices, "day", "o", "h", "l", "c", width=300, height=150)
    spec, _ = chart.to_spec()
    assert spec["marks"][0] == {
        "type": "candlestick",
        "x": "day",
        "open": "o",
        "high": "h",
        "low": "l",
        "close": "c",
        "data": "data",
    }
    assert sorted(spec["data"]["data"]["columns"]) == ["c", "day", "h", "l", "o"]
    colored, _ = hg.candlestick(prices, "day", "o", "h", "l", "c", rise="#000000").to_spec()
    assert colored["marks"][0]["rise"] == "#000000"
    assert "<path" in chart.to_svg()
    with pytest.raises(TypeError, match="candlestick close"):
        hg.Chart(prices).candlestick("day", "o", "h", "l", "note")


def test_histograms_bin_a_column():
    values = {"ms": np.array([1.0, 2.0, 2.5, 9.0]), "region": ["a", "a", "b", "b"]}
    chart = hg.histogram(values, "ms", bins={"step": 5}, series="region", stack=True)
    spec, _ = chart.to_spec()
    assert spec["marks"][0] == {
        "type": "histogram",
        "x": "ms",
        "bins": {"step": 5},
        "series": "region",
        "stack": True,
        "data": "data",
    }
    assert sorted(spec["data"]["data"]["columns"]) == ["ms", "region"]
    assert "<path" in hg.Chart(values, width=300, height=150).histogram("ms").to_svg()
    with pytest.raises(TypeError, match="histogram x"):
        hg.Chart(values).histogram("region")


def test_points_encode_size_color_opacity_and_shape():
    values = {
        "x": np.array([1.0, 2.0, 3.0]),
        "y": np.array([3.0, 1.0, 2.0]),
        "pop": np.array([10.0, 40.0, 90.0]),
        "growth": np.array([-1.0, 0.0, 2.0]),
        "kind": ["a", "b", "a"],
        "unused": np.array([0.0, 0.0, 0.0]),
    }
    chart = hg.scatter(
        values, "x", "y", size="pop", color="growth", colors="rdbu", color_midpoint=0, symbol="kind"
    )
    spec, _ = chart.to_spec()
    assert spec["marks"][0] == {
        "type": "point",
        "x": "x",
        "y": "y",
        "size": "pop",
        "color": "growth",
        "colors": "rdbu",
        "colorMidpoint": 0,
        "symbol": {"field": "kind"},
        "data": "data",
    }
    assert sorted(spec["data"]["data"]["columns"]) == ["growth", "kind", "pop", "x", "y"]
    svg = hg.Chart(values, width=300, height=200).point("x", "y", symbol="diamond").to_svg()
    assert "<path" in svg
    # A shape's name is not a column, so it is not sent as one.
    one, _ = hg.Chart(values).point("x", "y", symbol="star", radius=3).to_spec()
    assert sorted(one["data"]["data"]["columns"]) == ["x", "y"]
    assert (
        hg.scatter(values, "x", "y", size="pop", width=300, height=200).to_svg().count("<path") > 1
    )


def test_encodings_are_checked():
    values = {"x": np.array([1.0]), "y": np.array([2.0]), "kind": ["a"]}
    with pytest.raises(
        ValueError, match='point symbol: expected a column or "circle", .*; received "hexagon"'
    ):
        hg.Chart(values).point("x", "y", symbol="hexagon")
    with pytest.raises(
        ValueError, match='point symbol: "star" names both a shape and a column; give {"field"'
    ):
        hg.Chart({**values, "star": ["a"]}).point("x", "y", symbol="star")
    # A column named like a shape is encoded when named as a field.
    star = hg.Chart({**values, "star": ["a"]}).point("x", "y", symbol={"field": "star"})
    spec, _ = star.to_spec()
    assert spec["marks"][0]["symbol"] == {"field": "star"}
    assert "star" in spec["data"]["data"]["columns"]
    assert "<path" in star.to_svg()
    with pytest.raises(ValueError, match='point symbol: expected a shape.s name or {"field"'):
        hg.Chart(values).point("x", "y", symbol={"column": "kind"})
    with pytest.raises(TypeError, match="point symbol"):
        hg.Chart(values).point("x", "y", symbol="x")
    with pytest.raises(ValueError, match="point colors: 'kind' is a category column"):
        hg.Chart(values).point("x", "y", color="kind", colors="viridis")
    with pytest.raises(ValueError, match='point colors: unknown scheme "virdis"'):
        hg.Chart(values).point("x", "y", color="x", colors="virdis")
    with pytest.raises(
        ValueError, match="heatmap color_domain: expected two finite numbers, ascending"
    ):
        hg.Chart(values).heatmap("x", "y", "x", color_domain=(1, 0))
    with pytest.raises(ValueError, match="point color_domain: expected two finite numbers"):
        hg.Chart(values).point("x", "y", color="x", color_domain=(0, float("inf")))
    with pytest.raises(
        ValueError, match="point radius_range: expected two finite numbers, ascending, from 0 up"
    ):
        hg.Chart(values).point("x", "y", size="x", radius_range=(-1, 4))
    with pytest.raises(ValueError, match="point color_midpoint: expected a finite number"):
        hg.Chart(values).point("x", "y", color="x", color_midpoint=float("nan"))
    with pytest.raises(
        ValueError, match="point color_midpoint: expected a value inside color_domain"
    ):
        hg.Chart(values).point("x", "y", color="x", color_domain=(0, 1), color_midpoint=2)
    with pytest.raises(
        ValueError, match="point radius: expected a positive number of pixels; received 0"
    ):
        hg.Chart(values).point("x", "y", radius=0)
    with pytest.raises(
        ValueError, match="point radius: a constant radius or a size column, not both"
    ):
        hg.Chart(values).point("x", "y", radius=3, size="x")
    with pytest.raises(
        ValueError,
        match="point fill_opacity: expected a number from 0 to 1 or a column; received 1.5",
    ):
        hg.Chart(values).point("x", "y", fill_opacity=1.5)


def test_heatmaps_take_schemes_and_midpoints():
    values = {"c": ["a", "b"], "r": ["u", "u"], "v": np.array([-1.0, 1.0])}
    spec, _ = hg.heatmap(
        values, "c", "r", "v", colors="viridis", color_domain=(-2, 2), color_midpoint=0
    ).to_spec()
    assert spec["marks"][0]["colors"] == "viridis"
    assert spec["marks"][0]["colorDomain"] == [-2, 2]
    assert spec["marks"][0]["colorMidpoint"] == 0
    assert "reduce" not in spec["marks"][0]


def test_heatmaps_combine_rows_sharing_cells_and_sample_large_grids():
    values = {"c": np.arange(4.0), "r": np.zeros(4), "v": np.array([1.0, 9.0, 2.0, 8.0])}
    spec, _ = hg.heatmap(values, "c", "r", "v", reduce="sum", sampling={"reduce": "max"}).to_spec()
    assert spec["marks"][0]["reduce"] == "sum"
    assert spec["marks"][0]["sampling"] == {"reduce": "max"}
    with pytest.raises(
        ValueError,
        match='heatmap reduce: expected "last", "mean", "sum", "min", or "max"; received "median"',
    ):
        hg.Chart(values).heatmap("c", "r", "v", reduce="median")  # type: ignore[arg-type]
    with pytest.raises(
        ValueError,
        match='heatmap sampling reduce: expected "mean", "max", or "min"; received "sum"',
    ):
        hg.Chart(values).heatmap("c", "r", "v", sampling={"reduce": "sum"})  # type: ignore[typeddict-item]
    with pytest.raises(ValueError, match="heatmap sampling: expected"):
        hg.Chart(values).heatmap("c", "r", "v", sampling="max")  # type: ignore[arg-type]


def test_heatmaps_place_cells_between_edges():
    binned = (
        hg.derive({"x": np.array([0.5, 1.5, 4.0, 9.0]), "y": np.array([0.0, 1.0, 8.0, 9.0])})
        .bin("x", bins=[0, 2, 10], name="x0", end="x1")
        .bin("y", bins={"step": 5}, name="y0", end="y1")
        .aggregate(by=["x0", "x1", "y0", "y1"], n="count")
    )
    chart = hg.Chart(binned).heatmap(x1="x0", x2="x1", y1="y0", y2="y1", color="n")
    spec, _ = chart.to_spec()
    assert {k: spec["marks"][0][k] for k in ("x1", "x2", "y1", "y2")} == {
        "x1": "x0",
        "x2": "x1",
        "y1": "y0",
        "y2": "y1",
    }
    assert chart.to_svg().count("<image ") == 1
    with pytest.raises(ValueError, match="heatmap x1: x places cells at values, x1 and x2"):
        hg.Chart(binned).heatmap("x0", x1="x0", x2="x1", y1="y0", y2="y1", color="n")
    with pytest.raises(ValueError, match="heatmap y2: missing; cells between edges need y1 and y2"):
        hg.Chart(binned).heatmap(x1="x0", x2="x1", y1="y0", color="n")
    with pytest.raises(
        ValueError, match="heatmap x_step: cells between x1 and x2 take their edges"
    ):
        hg.Chart(binned).heatmap(x1="x0", x2="x1", y1="y0", y2="y1", color="n", x_step=1)


def test_heatmaps_place_numbers_and_times_along_axes():
    values = {
        "hour": np.array([0.0, 1.0, 3.0]),
        "day": np.array(["2026-01-01", "2026-01-02", "2026-01-03"], dtype="datetime64[ms]"),
        "host": ["a", "b", "a"],
        "v": np.array([1.0, 2.0, 3.0]),
    }
    spec, _ = hg.heatmap(values, "hour", "day", "v").to_spec()
    assert "xBanded" not in spec["marks"][0] and "yBanded" not in spec["marks"][0]
    spec, _ = hg.heatmap(values, "hour", "host", "v", x_step=1).to_spec()
    assert spec["marks"][0]["xStep"] == 1
    assert "yBanded" not in spec["marks"][0]
    spec, _ = hg.heatmap(values, "hour", "host", "v", x_banded=True).to_spec()
    assert spec["marks"][0]["xBanded"] is True
    svg = hg.heatmap(values, "hour", "day", "v", width=300, height=200).to_svg()
    assert svg.count("<image ") == 1
    with pytest.raises(
        ValueError,
        match="heatmap x_step: sizes cells along a number or time x axis; 'host' holds categories",
    ):
        hg.heatmap(values, "host", "day", "v", x_step=1)
    with pytest.raises(
        ValueError,
        match="heatmap y_step: sizes cells along a number or time y axis; y_banded bands it",
    ):
        hg.heatmap(values, "hour", "day", "v", y_step=1, y_banded=True)
    with pytest.raises(ValueError, match="heatmap x_step: expected a positive number; received 0"):
        hg.heatmap(values, "hour", "day", "v", x_step=0)
    with pytest.raises(
        ValueError, match="heatmap x_step: expected a positive number; received True"
    ):
        hg.heatmap(values, "hour", "day", "v", x_step=True)
    with pytest.raises(ValueError, match="heatmap x_banded: expected True or False; received 1"):
        hg.heatmap(values, "hour", "day", "v", x_banded=1)  # type: ignore[arg-type]
    # NumPy scalars are numbers; specs hold plain floats.
    spec, _ = hg.heatmap(values, "hour", "day", "v", x_step=np.float32(2)).to_spec()
    assert spec["marks"][0]["xStep"] == 2.0 and type(spec["marks"][0]["xStep"]) is float


def test_heatmaps_along_number_axes_have_no_categories_to_resolve():
    load = {
        "region": ["N", "S", "N", "S"],
        "hour": np.array([0.0, 1.0, 2.0, 3.0]),
        "host": ["p", "q", "q", "p"],
        "cpu": np.array([1.0, 2.0, 3.0, 4.0]),
    }
    # x scales of their own sync as any number axis does; banded hours are categories.
    hg.Chart(load, facet="region", x=hg.Axis(scope="panel"), sync="board").heatmap(
        x="hour", y="host", color="cpu"
    ).to_spec()
    with pytest.raises(
        ValueError, match=r"Chart sync: panels with categories of their own \(x scope"
    ):
        hg.Chart(load, facet="region", x=hg.Axis(scope="panel"), sync="board").heatmap(
            x="hour", y="host", color="cpu", x_banded=True
        )


def test_calendar_heatmaps_lay_out_days():
    # Monday, February 26, 2024, past the leap day to Saturday, March 9.
    day = np.arange("2024-02-26", "2024-03-10", dtype="datetime64[D]")
    days = {"day": day.astype("datetime64[ms]"), "commits": np.arange(13.0)}
    spec, _ = hg.heatmap(days, date="day", color="commits", week_start="sun").to_spec()
    assert spec["marks"][0] == {
        "type": "heatmap",
        "color": "commits",
        "date": "day",
        "weekStart": "sun",
        "data": "data",
    }
    svg = hg.heatmap(days, date="day", color="commits", width=400, height=200).to_svg()
    assert svg.count("<image ") == 1
    assert all(f">{label}</text>" in svg for label in ("Mon", "Sun"))
    months = hg.heatmap(days, date="day", color="commits", calendar="months", width=500).to_svg()
    assert ">Feb 2024</text>" in months and ">Mar 2024</text>" in months
    with pytest.raises(ValueError, match=r"heatmap x: a calendar \(date\) places its days itself"):
        hg.heatmap(days, "day", date="day", color="commits")
    with pytest.raises(
        ValueError, match=r"heatmap: needs x and y \(or x1 and x2, y1 and y2\), or a date"
    ):
        hg.heatmap(days, "day", color="commits")
    with pytest.raises(ValueError, match="heatmap week_start: applies to calendars of weeks"):
        hg.heatmap(days, date="day", color="commits", calendar="months", week_start="sun")
    with pytest.raises(
        TypeError,
        match="heatmap date: column 'commits' holds number values; expected time; give datetimes$",
    ):
        hg.heatmap(days, date="commits", color="commits")
    with pytest.raises(
        TypeError,
        match="heatmap date: column 'day' holds category values; expected time; give datetimes",
    ):
        hg.heatmap({"day": ["2026-01-01"], "commits": [1]}, date="day", color="commits")
    # Weekdays are categories, so panels with weekdays of their own cannot sync.
    with pytest.raises(
        ValueError, match=r"Chart sync: panels with categories of their own \(y scope"
    ):
        hg.Chart(
            {**days, "team": ["a", "b"] * 6 + ["a"]},
            facet="team",
            y=hg.Axis(scope="panel"),
            sync="board",
        ).heatmap(date="day", color="commits")


def test_points_color_by_category_with_a_key():
    values = {
        "x": np.array([1.0, 2.0, 3.0]),
        "y": np.array([1.0, 2.0, 3.0]),
        "kind": ["a", "b", "a"],
    }
    chart = hg.scatter(values, "x", "y", color="kind", width=300, height=200)
    spec, _ = chart.to_spec()
    assert spec["marks"][0]["color"] == "kind"
    assert "kind" in spec["data"]["data"]["columns"]
    svg = chart.to_svg()
    assert ">kind</text>" in svg and ">a</text>" in svg and ">b</text>" in svg
    geo = hg.Chart(values).geopoint("x", "y", color="kind").to_spec()[0]
    assert geo["marks"][0]["color"] == "kind"
    three = {**values, "z": np.array([0.0, 1.0, 2.0])}
    assert hg.scatter_3d(three, "x", "y", "z", color="kind").to_spec()[0]["marks"][0]["color"]
    with pytest.raises(ValueError, match="geopoint colors: 'kind' is a category column"):
        hg.Chart(values).geopoint("x", "y", color="kind", color_midpoint=0)


def test_scatter_helper_takes_every_encoding():
    values = {"x": np.array([1.0, 2.0]), "y": np.array([3.0, 4.0]), "s": np.array([1.0, 5.0])}
    chart = hg.scatter(
        values, "x", "y", size="s", radius_range=(1, 9), color="s", color_domain=(0, 10), width=300
    )
    spec, _ = chart.to_spec()
    assert spec["marks"][0]["radiusRange"] == [1, 9]
    assert spec["marks"][0]["colorDomain"] == [0, 10]
    assert spec["width"] == 300
    assert "<path" in chart.to_svg()


def test_scheme_and_symbol_names_match_typescript():
    root = Path(__file__).resolve().parents[2] / "packages" / "herceg" / "src"
    if not root.exists():
        pytest.skip("needs a source checkout")
    schemes = (root / "scale" / "schemes.ts").read_text()
    table = schemes[schemes.index("export const schemes") :]
    assert tuple(re.findall(r"^  (\w+),$", table, re.MULTILINE)) == hg.SCHEMES
    symbols = (root / "draw" / "symbols.ts").read_text()
    order = symbols[symbols.index("export const SYMBOLS") :]
    assert tuple(re.findall(r'^  "([\w-]+)",$', order, re.MULTILINE)) == hg.SYMBOLS


def test_theme_builders_match_typescript():
    from dataclasses import fields
    from typing import get_args

    from herceg._style import _camel

    theme = hg.Theme(
        extends="high-contrast",
        tokens=hg.Tokens(palette=["#000"]),
        style=hg.Style(
            title=hg.TextStyle(font_size=18, align="center"),
            bar={"radius": 0},
            tooltip=hg.TooltipStyle(stroke="#000"),
        ),
    )
    spec, _ = hg.Chart(DATA, theme=theme).line(x="t", y="p50").to_spec()
    assert spec["theme"] == {
        "extends": "high-contrast",
        "tokens": {"palette": ["#000"]},
        "style": {
            "title": {"fontSize": 18, "align": "center"},
            "bar": {"radius": 0},
            "tooltip": {"stroke": "#000"},
        },
    }
    # Dicts of the same names work wherever builders do.
    as_dicts, _ = (
        hg.Chart(DATA, theme={"style": {"tick_label": {"color": "#555", "font_weight": 600}}})
        .line(x="t", y="p50")
        .to_spec()
    )
    assert as_dicts["theme"] == {"style": {"tickLabel": {"color": "#555", "fontWeight": 600}}}
    root = Path(__file__).resolve().parents[2] / "packages" / "herceg" / "src"
    if not root.exists():
        pytest.skip("needs a source checkout")
    source = (root / "spec" / "spec.ts").read_text()
    names = re.search(r"export type ThemeName =([^;]+);", source)[1]
    assert tuple(re.findall(r'"([\w-]+)"', names)) == get_args(hg._style.ThemeName)
    style = (root / "spec" / "style.ts").read_text()

    def keys(interface: str) -> set[str]:
        body = style[style.index(f"export interface {interface}") :]
        return set(re.findall(r"^  (\w+)\?:", body[: body.index("\n}")], re.MULTILINE))

    for builder, interface in [
        (hg.TextStyle, "TextStyle"),
        (hg.PlotStyle, "PlotStyle"),
        (hg.Style, "StyleRoles"),
        (hg.Tokens, "ThemeTokens"),
    ]:
        assert {_camel(f.name) for f in fields(builder)} == keys(interface), interface
    assert {_camel(f.name) for f in fields(hg.StrokeStyle)} == keys("StrokeStyle")
    with pytest.raises(ValueError, match='Theme style: unknown key "fontsize"'):
        hg.Chart(DATA, theme={"style": {"fontsize": 12}})
    with pytest.raises(ValueError, match="TextStyle font_weight: expected a whole number"):
        hg.TextStyle(font_weight=1200)
    with pytest.raises(ValueError, match='Axis style: styles "axis_line", "tick", "tick_label"'):
        hg.Chart(DATA, y=hg.Axis(style=hg.Style(plot=hg.PlotStyle(fill="#eee")))).to_spec()


def test_titles_legends_and_padding_reach_the_spec():
    chart = hg.Chart(
        DATA,
        title=hg.Title("Weekly", place=hg.Place(side="bottom"), style={"align": "center"}),
        legend=hg.Legend(place=hg.Place(side="right")),
        padding={"top": 4, "left": 0},
        panels=[hg.Panel("a", title=hg.Title("A", style=hg.TextStyle(color="#c00")))],
        y=hg.Axis(style=hg.Style(tick_label=hg.TextStyle(color="#c00"))),
    ).line(x="t", y="p50", panel="a")
    spec, _ = chart.to_spec()
    assert spec["title"] == {
        "text": "Weekly",
        "place": {"side": "bottom"},
        "style": {"align": "center"},
    }
    assert spec["legend"] == {"place": {"side": "right"}}
    assert spec["padding"] == {"top": 4, "left": 0}
    assert spec["panels"][0]["title"] == {"text": "A", "style": {"color": "#c00"}}
    assert spec["y"] == {"style": {"tickLabel": {"color": "#c00"}}}
    assert "<svg" in chart.to_svg()
    with pytest.raises(ValueError, match="Panel title place: a panel's title goes above it"):
        hg.Panel("a", title=hg.Title("A", place=hg.Place(side="bottom")))._spec()
    with pytest.raises(ValueError, match="Place: give a side or inside, one of them"):
        hg.Place()
    with pytest.raises(ValueError, match='Title place: expected side "top" or "bottom"'):
        hg.Title("T", place=hg.Place(side="left"))
    assert hg.Chart(DATA, legend={"place": {"inside": "top-right"}}).to_spec()[0]["legend"] == {
        "place": {"inside": "top-right"}
    }


def test_marks_say_what_they_are_cut_to():
    chart = (
        hg.Chart(DATA, padding=0)
        .line(x="t", y="p50", clip=False)
        .point(x="t", y="p50", clip="chart")
        .text(x="t", y="p50", text_field="host", clip="plot")
    )
    spec, _ = chart.to_spec()
    assert [mark.get("clip") for mark in spec["marks"]] == [False, "chart", "plot"]
    boxes = hg.Chart(DATA).boxplot(x="host", y="p50", clip=False)
    assert boxes.to_spec()[0]["marks"][0]["clip"] is False
    assert "clip" not in hg.Chart(DATA).line(x="t", y="p50").to_spec()[0]["marks"][0]
    assert "-clip-chart" in chart.to_svg()
    assert hg.line(DATA, x="t", y="p50", clip=False).to_spec()[0]["marks"][0]["clip"] is False
    with pytest.raises(
        ValueError, match='line clip: expected "plot", "chart", or False; received 0'
    ):
        hg.Chart(DATA).line(x="t", y="p50", clip=0)  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="received True"):
        hg.Chart(DATA).rule(y=1, clip=True)  # type: ignore[arg-type]


def test_svg_sizes_to_its_container_when_fluid(tmp_path):
    chart = hg.Chart(DATA, width=140, height=48, padding=0).line(x="t", y="p50")
    fixed = chart.to_svg()
    assert 'width="140" height="48" viewBox="0 0 140 48"' in fixed
    fluid = chart.to_svg(sizing="fluid", preserve_aspect_ratio="none", stroke_scaling="fixed")
    assert re.match(
        r'<svg xmlns="http://www.w3.org/2000/svg" id="[^"]+" viewBox="0 0 140 48" '
        r'preserveAspectRatio="none"',
        fluid,
    )
    assert "vector-effect:non-scaling-stroke" in fluid
    chart.save(tmp_path / "chart.svg", sizing="fluid")
    assert (
        (tmp_path / "chart.svg")
        .read_text()
        .startswith('<svg xmlns="http://www.w3.org/2000/svg" viewBox=')
    )
    with pytest.raises(ValueError, match="save sizing: an option of SVG export"):
        chart.save(tmp_path / "chart.png", sizing="fluid")
    with pytest.raises(ValueError, match='to_svg sizing: expected "fixed" or "fluid"'):
        chart.to_svg(sizing="auto")  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="to_svg preserve_aspect_ratio: expected"):
        chart.to_svg(preserve_aspect_ratio="stretch")
    with pytest.raises(ValueError, match='to_svg stroke_scaling: expected "scale" or "fixed"'):
        chart.to_svg(stroke_scaling="none")  # type: ignore[arg-type]


def test_format_options_match_typescript():
    from herceg._chart import _NUMBER_FORMAT, _TIME_FORMAT

    with pytest.raises(
        ValueError, match='Axis format: "maximumFractionDigts" is not an Intl format option'
    ):
        hg.Axis(format={"maximumFractionDigts": 2})
    with pytest.raises(ValueError, match='bar labels: "hour" is not an Intl format option'):
        hg.Chart(DATA).bar(x="host", y="p50", labels={"hour": "2-digit"})
    root = Path(__file__).resolve().parents[2] / "packages" / "herceg" / "src"
    if not root.exists():
        pytest.skip("needs a source checkout")
    source = (root / "spec" / "validate.ts").read_text()
    for name, options in (("NUMBER_OPTIONS", _NUMBER_FORMAT), ("TIME_OPTIONS", _TIME_FORMAT)):
        body = source[source.index(f"const {name} = [") :]
        listed = re.findall(r'^  "(\w+)",$', body[: body.index("];")], re.MULTILINE)
        assert set(listed) == options


def test_pies_send_their_fields_and_have_their_chart_to_themselves():
    sales = {
        "region": ["n", "s", "n", "e"],
        "revenue": [3.0, 2.0, 1.0, 4.0],
        "unused": [0, 0, 0, 0],
    }
    chart = hg.pie(sales, "region", "revenue", inner_radius=0.6, width=300, height=200)
    spec, _ = chart.to_spec()
    assert spec["marks"] == [
        {
            "type": "pie",
            "data": "data",
            "category": "region",
            "value": "revenue",
            "innerRadius": 0.6,
        }
    ]
    assert sorted(spec["data"]["data"]["columns"]) == ["region", "revenue"]
    svg = chart.to_svg()
    # Three slices, each a path of arcs in its own color.
    assert len(re.findall(r'<path d="M[^"]*A[^"]*Z" fill="#', svg)) == 3
    assert "n" in svg and "e" in svg
    with pytest.raises(
        ValueError, match="pie: has its chart to itself; draw the line in another chart"
    ):
        hg.Chart(sales).pie("region").line(x="revenue", y="revenue")
    with pytest.raises(
        ValueError, match="pie: has its chart to itself; draw the bar in another chart"
    ):
        hg.Chart(sales).bar(x="region", y="revenue").pie("region")
    with pytest.raises(
        ValueError,
        match="pie inner_radius: expected a fraction of at least 0 and below 1; received 1",
    ):
        hg.Chart(sales).pie("region", inner_radius=1)
    with pytest.raises(TypeError, match="pie value: column 'region' holds category"):
        hg.Chart(sales).pie("region", "region")
    with pytest.raises(ValueError, match="Chart zoom: a pie has no x axis"):
        hg.Chart(sales, zoom=True).pie("region")


def test_tooltip_fields_decode_with_their_points():
    from herceg._events import decode_inspection

    point = {"mark": 0, "markId": None, "key": "0:p99", "label": "p99", "row": 1}
    inspection = decode_inspection(
        {
            "axis": "x",
            "value": 1,
            "time": False,
            "label": "1",
            "points": [
                {
                    **point,
                    "value": 304,
                    "text": "304",
                    "fields": [
                        {"field": "n", "label": "N", "kind": "number", "value": 5, "text": "5"},
                        {
                            "field": "at",
                            "label": "at",
                            "kind": "time",
                            "value": 86_400_000,
                            "text": "Jan 2, 1970",
                        },
                    ],
                }
            ],
        }
    )
    assert inspection is not None
    n, at = inspection.points[0].fields
    assert (n.label, n.kind, n.value, n.text) == ("N", "number", 5, "5")
    assert at.value == dt.datetime(1970, 1, 2)


def test_pie_slices_decode_as_item_inspections():
    from herceg._events import decode_inspection

    inspection = decode_inspection(
        {
            "axis": "item",
            "value": 40,
            "time": False,
            "label": "revenue",
            "points": [
                {
                    "mark": 0,
                    "markId": None,
                    "key": '[0,"North"]',
                    "label": "North",
                    "row": None,
                    "value": 40,
                    "text": "40 (40%)",
                }
            ],
        }
    )
    assert inspection is not None
    assert inspection.axis == "item"
    assert inspection.value == 40
    # A slice sums rows: it is no one row.
    assert inspection.points[0].label == "North" and inspection.points[0].row is None


def test_gauges_send_their_dial_and_bands():
    readings = {"cpu": [12.0, 73.0], "unused": [0, 0]}
    chart = hg.gauge(
        readings,
        "cpu",
        max=120,
        bands=[60, (100, "#e0464f")],
        label="CPU",
        format={"maximumFractionDigits": 0},
        width=300,
        height=200,
    )
    spec, _ = chart.to_spec()
    assert spec["marks"] == [
        {
            "type": "gauge",
            "data": "data",
            "value": "cpu",
            "max": 120.0,
            "bands": [{"to": 60.0}, {"to": 100.0, "color": "#e0464f"}],
            "label": "CPU",
            "format": {"maximumFractionDigits": 0},
        }
    ]
    assert list(spec["data"]["data"]["columns"]) == ["cpu"]
    svg = chart.to_svg()
    assert ">73</text>" in svg and "CPU" in svg and "#e0464f" in svg
    assert chart.to_pdf().startswith(b"%PDF")
    with pytest.raises(
        ValueError, match="gauge min: expected a finite min below a finite max; received 5 and 5"
    ):
        hg.gauge(readings, "cpu", min=5, max=5)
    with pytest.raises(
        ValueError,
        match=r"gauge bands: expected ends above min \(0\) and at most max \(100\); received 150",
    ):
        hg.gauge(readings, "cpu", bands=[150])
    with pytest.raises(
        ValueError, match="gauge bands: expected ends in ascending order; received 40 after 50"
    ):
        hg.gauge(readings, "cpu", bands=[50, 40])
    with pytest.raises(ValueError, match=r"gauge bands: expected numbers or \(to, color\) pairs"):
        hg.gauge(readings, "cpu", bands=[(50, "red", "x")])
    with pytest.raises(KeyError, match="gauge value: no column 'load'"):
        hg.gauge(readings, "load")
    with pytest.raises(
        ValueError, match="gauge: has its chart to itself; draw the line in another chart"
    ):
        hg.Chart(readings).gauge("cpu").line(x="cpu", y="cpu")
    with pytest.raises(ValueError, match="Chart zoom: a gauge has no x axis"):
        hg.Chart(readings, zoom=True).gauge("cpu")


def test_funnels_send_their_stages():
    signups = {
        "stage": ["Visit", "Cart", "Purchase"],
        "users": [2000.0, 1200.0, 300.0],
        "unused": [0, 0, 0],
    }
    chart = hg.funnel(signups, "stage", "users", sort="value", width=300, height=200)
    spec, _ = chart.to_spec()
    assert spec["marks"] == [
        {"type": "funnel", "data": "data", "category": "stage", "value": "users", "sort": "value"}
    ]
    assert sorted(spec["data"]["data"]["columns"]) == ["stage", "users"]
    svg = chart.to_svg()
    assert "Purchase" in svg and "fill-opacity" in svg
    spec, _ = hg.Chart(signups).funnel("stage", labels=False).to_spec()
    assert spec["marks"][0] == {
        "type": "funnel",
        "data": "data",
        "category": "stage",
        "labels": False,
    }
    with pytest.raises(TypeError, match="funnel category: column 'users' holds number"):
        hg.funnel(signups, "users")
    with pytest.raises(ValueError, match="funnel: has its chart to itself"):
        hg.Chart(signups).funnel("stage").pie("stage")


def test_boxplots_take_a_category_and_values_either_way():
    data = {
        "region": ["n", "n", "s", "s"],
        "ms": [1.0, 2.0, 3.0, 40.0],
        "v": ["a", "b", "a", "b"],
    }
    spec, _ = hg.boxplot(data, x="region", y="ms", series="v").to_spec()
    assert spec["marks"] == [
        {"type": "boxplot", "data": "data", "x": "region", "y": "ms", "series": "v"}
    ]
    assert sorted(spec["data"]["data"]["columns"]) == ["ms", "region", "v"]
    horizontal = hg.Chart(data, width=300, height=200).boxplot(x="ms", y="region")
    # The boxes' translucent fill.
    assert 'fill-opacity="0.25"' in horizontal.to_svg()
    with pytest.raises(TypeError, match="boxplot y: column 'v' holds category"):
        hg.Chart(data).boxplot(x="region", y="v")
    with pytest.raises(ValueError, match="boxplot axis: horizontal box plots have no right axis"):
        hg.Chart(data).boxplot(x="ms", y="region", axis="right")
    with pytest.raises(
        ValueError, match="boxplot fill_opacity: expected a number from 0 to 1; received 2"
    ):
        hg.Chart(data).boxplot(x="region", y="ms", fill_opacity=2)


def test_violins_take_a_bandwidth_and_the_box_plot_options():
    data = {"region": ["n", "n", "n", "s", "s"], "ms": [1.0, 2.0, 4.0, 3.0, 9.0]}
    spec, _ = hg.violin(data, x="region", y="ms", bandwidth=0.5).to_spec()
    assert spec["marks"] == [
        {"type": "violin", "data": "data", "x": "region", "y": "ms", "bandwidth": 0.5}
    ]
    svg = hg.Chart(data, width=300, height=200).violin(x="ms", y="region").to_svg()
    assert 'fill-opacity="0.25"' in svg
    for bad in (0, -1, float("nan"), True):
        with pytest.raises(ValueError, match="violin bandwidth: expected a positive number"):
            hg.Chart(data).violin(x="region", y="ms", bandwidth=bad)
    with pytest.raises(ValueError, match="violin axis: horizontal violins have no right axis"):
        hg.Chart(data).violin(x="ms", y="region", axis="right")
    with pytest.raises(TypeError, match="violin y: column 'region' holds category"):
        hg.Chart(data).violin(x="region", y="region")


def test_treemaps_and_sunbursts_send_their_tree():
    sales = {
        "region": ["Europe", "Europe", "Asia"],
        "country": ["France", "Spain", "Japan"],
        "revenue": [3.0, 2.0, 4.0],
        "unused": [0, 0, 0],
    }
    chart = hg.treemap(sales, ["region", "country"], "revenue", width=300, height=200)
    spec, _ = chart.to_spec()
    assert spec["marks"] == [
        {"type": "treemap", "data": "data", "path": ["region", "country"], "value": "revenue"}
    ]
    assert sorted(spec["data"]["data"]["columns"]) == ["country", "region", "revenue"]
    assert "Japan" in chart.to_svg()
    org = {"node": ["root", "a"], "up": [None, "root"]}
    spec, _ = hg.sunburst(org, node="node", parent="up").to_spec()
    assert spec["marks"][0] == {"type": "sunburst", "data": "data", "node": "node", "parent": "up"}
    with pytest.raises(ValueError, match="treemap: needs a path of category columns"):
        hg.Chart(sales).treemap()
    with pytest.raises(ValueError, match="treemap path: a path, or node and parent, not both"):
        hg.Chart(sales).treemap(["region"], node="country", parent="region")
    with pytest.raises(ValueError, match="treemap: has its chart to itself"):
        hg.Chart(sales).treemap(["region"]).pie("region")
    with pytest.raises(TypeError, match="treemap path: column 'revenue' holds number"):
        hg.Chart(sales).treemap(["revenue"])


def test_radars_send_long_or_wide_data():
    scores = {
        "player": ["Ana", "Ana", "Ana", "Bo", "Bo", "Bo"],
        "skill": ["speed", "power", "range"] * 2,
        "score": [8.0, 6.0, 4.0, 5.0, 9.0, 7.0],
        "unused": [0, 0, 0, 0, 0, 0],
    }
    chart = hg.radar(scores, "skill", "score", series="player", domain=(0, 10), width=300)
    spec, _ = chart.to_spec()
    assert spec["marks"] == [
        {
            "type": "radar",
            "data": "data",
            "category": "skill",
            "value": "score",
            "series": "player",
            "domain": [0.0, 10.0],
        }
    ]
    assert sorted(spec["data"]["data"]["columns"]) == ["player", "score", "skill"]
    assert "power" in chart.to_svg()
    players = {
        "name": ["Ana", "Bo"],
        "speed": [8.0, 5.0],
        "power": [6.0, 9.0],
        "range": [4.0, float("nan")],
        "unused": [0, 0],
    }
    wide = hg.Chart(players).radar(
        fields=["speed", "power", "range"], series="name", fill_opacity=0.3, points=False
    )
    spec, _ = wide.to_spec()
    assert spec["marks"][0] == {
        "type": "radar",
        "data": "data",
        "fields": ["speed", "power", "range"],
        "series": "name",
        "fillOpacity": 0.3,
        "points": False,
    }
    assert sorted(spec["data"]["data"]["columns"]) == ["name", "power", "range", "speed"]
    assert "range" in wide.to_svg()
    # Rows without a series are one polygon: the last row's values.
    spec, _ = hg.Chart(players).radar(fields=["speed", "power", "range"]).to_spec()
    assert spec["marks"][0] == {
        "type": "radar",
        "data": "data",
        "fields": ["speed", "power", "range"],
    }
    helper = hg.radar(
        players,
        fields=["speed", "power", "range"],
        series="name",
        fill_opacity=0.3,
        points=False,
        label="Skill",
        title="Players",
    )
    spec, _ = helper.to_spec()
    assert spec["title"] == "Players"
    assert spec["marks"][0] == {
        "type": "radar",
        "data": "data",
        "fields": ["speed", "power", "range"],
        "series": "name",
        "fillOpacity": 0.3,
        "points": False,
        "label": "Skill",
    }
    with pytest.raises(ValueError, match="radar: needs category and value columns .* not both"):
        hg.Chart(players).radar("name", "speed", fields=["speed", "power", "range"])
    with pytest.raises(ValueError, match="radar: needs category and value columns .* not both"):
        hg.Chart(scores).radar("skill")
    with pytest.raises(
        ValueError, match="radar fields: needs at least 3 spokes; the fields make 2"
    ):
        hg.Chart(players).radar(fields=["speed", "power"], series="name")
    with pytest.raises(ValueError, match="radar fields: 'speed' is listed twice"):
        hg.Chart(players).radar(fields=["speed", "power", "speed"], series="name")
    many = {f"f{i}": [1.0] for i in range(101)}
    with pytest.raises(
        ValueError, match="radar fields: draws at most 100 spokes; the fields make 101"
    ):
        hg.Chart(many).radar(fields=list(many))
    spokes = {"k": [f"k{i}" for i in range(101)], "v": [1.0] * 101}
    with pytest.raises(ValueError, match="radar category: draws at most 100 spokes; 'k' has 101"):
        hg.Chart(spokes).radar("k", "v")
    with pytest.raises(ValueError, match="radar category: needs at least 3 spokes; 'skill' has 2"):
        hg.Chart({"skill": ["a", "b"], "v": [1.0, 2.0]}).radar("skill", "v")
    with pytest.raises(TypeError, match="radar fields: column 'name' holds category"):
        hg.Chart(players).radar(fields=["speed", "power", "name"], series="name")
    with pytest.raises(ValueError, match="radar domain: expected two finite numbers"):
        hg.Chart(scores).radar("skill", "score", domain=(10, 0))
    with pytest.raises(
        ValueError, match="radar fill_opacity: expected a number from 0 to 1; received 1.5"
    ):
        hg.Chart(scores).radar("skill", "score", fill_opacity=1.5)
    with pytest.raises(ValueError, match="Chart zoom: a radar has no x axis"):
        hg.Chart(scores, zoom=True).radar("skill", "score")
    with pytest.raises(ValueError, match="radar: has its chart to itself"):
        hg.Chart(scores).radar("skill", "score").line(x="score", y="score")


def test_sankey_diagrams_send_their_flows():
    energy = {
        "from": ["coal", "coal", "power"],
        "to": ["power", "steel", "homes"],
        "twh": [5.0, 2.0, 4.0],
        "unused": [0, 0, 0],
    }
    chart = hg.sankey(energy, "from", "to", "twh", node_width=10, width=400, height=240)
    spec, _ = chart.to_spec()
    assert spec["marks"] == [
        {
            "type": "sankey",
            "data": "data",
            "source": "from",
            "target": "to",
            "value": "twh",
            "nodeWidth": 10,
        }
    ]
    assert sorted(spec["data"]["data"]["columns"]) == ["from", "to", "twh"]
    svg = chart.to_svg()
    assert "coal 7" in svg
    spec, _ = hg.Chart(energy).sankey("from", "to", sort="value", labels=False).to_spec()
    assert spec["marks"][0] == {
        "type": "sankey",
        "data": "data",
        "source": "from",
        "target": "to",
        "labels": False,
        "sort": "value",
    }
    with pytest.raises(TypeError, match="sankey target: column 'twh' holds number"):
        hg.Chart(energy).sankey("from", "twh")
    with pytest.raises(
        ValueError, match="sankey node_width: expected a positive number of pixels; received 0"
    ):
        hg.Chart(energy).sankey("from", "to", node_width=0)
    with pytest.raises(
        ValueError, match='sankey sort: expected "input" or "value"; received "size"'
    ):
        hg.Chart(energy).sankey("from", "to", sort="size")
    with pytest.raises(ValueError, match="sankey: has its chart to itself"):
        hg.Chart(energy).sankey("from", "to").pie("from")
    with pytest.raises(ValueError, match="Chart zoom: a sankey has no x axis"):
        hg.Chart(energy, zoom=True).sankey("from", "to")


def test_panels_draw_the_marks_that_name_them():
    chart = (
        hg.Chart(
            DATA,
            panels=[hg.Panel("latency", title="Latency", y=hg.Axis(title="ms")), "spread"],
            width=400,
            height=300,
        )
        .line(x="t", y="p50", panel="latency")
        .line(x="t", y="p99", panel="spread")
        .rule(y=2, panel="*")
    )
    spec, _ = chart.to_spec()
    assert spec["panels"] == [
        {"id": "latency", "title": "Latency", "y": {"title": "ms"}},
        {"id": "spread"},
    ]
    assert [mark["panel"] for mark in spec["marks"]] == ["latency", "spread", "*"]
    assert "grid" not in spec
    svg = chart.to_svg()
    assert ">Latency</text>" in svg and ">ms</text>" in svg
    wide_chart = hg.Chart(DATA, panels=["a", "b"], panel_columns=2)
    wide, _ = wide_chart.line(x="t", y="p50", panel="a").to_spec()
    assert wide["grid"] == {"columns": 2}
    with pytest.raises(
        ValueError, match='line panel: expected the id of a panel, or "\\*" for every panel'
    ):
        hg.Chart(DATA, panels=["a"]).line(x="t", y="p50")
    with pytest.raises(ValueError, match='line panel: no panel "b"; the chart has "a"'):
        hg.Chart(DATA, panels=["a"]).line(x="t", y="p50", panel="b")
    with pytest.raises(ValueError, match="line panel: the chart has no panels"):
        hg.Chart(DATA).line(x="t", y="p50", panel="a")
    with pytest.raises(ValueError, match='Chart panels: "a" names two panels'):
        hg.Chart(DATA, panels=["a", "a"])
    with pytest.raises(ValueError, match="Chart panels: facets or panels, not both"):
        hg.Chart(DATA, panels=["a"], facet="host")
    with pytest.raises(
        ValueError, match='Chart zoom: panels with axes zoom along x only; received "xy"'
    ):
        hg.Chart(DATA, panels=["a"], zoom="xy").line(x="t", y="p50", panel="a").to_spec()
    with pytest.raises(
        ValueError, match="Chart panel_columns: lays out panels, and the chart has none"
    ):
        hg.Chart(DATA, panel_columns=2)
    tall, _ = (
        hg.Chart(DATA, panels=["a", "b"], panel_row_heights=[3, 1])
        .line(x="t", y="p50", panel="a")
        .to_spec()
    )
    assert tall["grid"] == {"rowHeights": [3, 1]}
    # NumPy weights arrive as plain numbers JSON can carry.
    weighted = hg.Chart(DATA, panels=["a", "b"], panel_row_heights=np.array([3, 1]))
    spec, _ = weighted.line(x="t", y="p50", panel="a").to_spec()
    assert json.loads(json.dumps(spec["grid"])) == {"rowHeights": [3.0, 1.0]}
    assert "rowHeights" in weighted.to_html()
    with pytest.raises(
        ValueError, match="Chart panel_row_heights: expected 2 heights, one per row; received 1"
    ):
        hg.Chart(DATA, panels=["a", "b"], panel_row_heights=[1])
    wide, _ = (
        hg.Chart(DATA, panels=["a", "b", "c"], panel_columns=2, panel_column_widths=[2, 1])
        .line(x="t", y="p50", panel="*")
        .to_spec()
    )
    assert wide["grid"] == {"columns": 2, "columnWidths": [2.0, 1.0]}
    with pytest.raises(
        ValueError, match="Chart panel_column_widths: expected 2 widths, one per column; received 3"
    ):
        hg.Chart(DATA, panels=["a", "b"], panel_columns=3, panel_column_widths=[1, 1, 1])
    with pytest.raises(ValueError, match="Chart panel_column_widths: expected positive numbers"):
        hg.Chart(DATA, panels=["a", "b"], panel_columns=2, panel_column_widths=[1, 0])
    with pytest.raises(ValueError, match="Chart panel_column_widths: lays out panels"):
        hg.Chart(DATA, panel_column_widths=[1])


SALES = {
    "region": ["N", "N", "N", "S", "S", "E"],
    "product": ["a", "b", "c", "a", "b", "a"],
    "revenue": np.array([1.0, 2.0, 3.0, 4.0, 5.0, 6.0]),
    "week": np.array([0.0, 1.0, 2.0, 3.0, 4.0, 5.0]),
}


def test_facets_draw_a_pie_of_each_panels_rows():
    chart = hg.Chart(SALES, facet="region", width=600, height=300).pie("product", "revenue")
    spec, _ = chart.to_spec()
    assert spec["facet"] == {"field": "region"}
    assert spec["marks"] == [
        {"type": "pie", "data": "data", "category": "product", "value": "revenue"}
    ]
    assert sorted(spec["data"]["data"]["columns"]) == ["product", "region", "revenue"]
    svg = chart.to_svg()
    # Three panels, headed by their region: 3, 2, and 1 slices.
    assert ">N</text>" in svg and ">S</text>" in svg and ">E</text>" in svg
    assert len(re.findall(r'<path d="M[^"]*A[^"]*Z" fill="#', svg)) == 6
    helper, _ = hg.pie(SALES, "product", "revenue", facet="region").to_spec()
    assert helper["facet"] == spec["facet"] and helper["marks"] == spec["marks"]
    for kind, add in [
        ("treemap", lambda c: c.treemap(["product"], "revenue")),
        ("sunburst", lambda c: c.sunburst(["product"], "revenue")),
        ("gauge", lambda c: c.gauge("revenue")),
        ("funnel", lambda c: c.funnel("product", "revenue")),
        ("radar", lambda c: c.radar("product", "revenue")),
        ("sankey", lambda c: c.sankey("region", "product", "revenue")),
    ]:
        faceted, _ = add(hg.Chart(SALES, facet="region")).to_spec()
        assert faceted["marks"][0]["type"] == kind


def test_facets_of_layout_marks_refuse_what_the_browser_refuses():
    with pytest.raises(ValueError, match="pie: has each facet panel to itself"):
        hg.Chart(SALES, facet="region").pie("product").line(x="week", y="revenue")
    with pytest.raises(ValueError, match="pie: has each facet panel to itself"):
        hg.Chart(SALES, facet="region").line(x="week", y="revenue").pie("product")
    with pytest.raises(ValueError, match="Chart zoom: a pie has no x axis"):
        hg.Chart(SALES, facet="region", zoom=True).pie("product")
    seams = hg.Axis(breaks=[hg.Break(start=4, end=8)], seams=True)
    with pytest.raises(ValueError, match="Chart x seams: a pie has no x axis"):
        hg.Chart(SALES, facet="region", x=seams).pie("product")
    with pytest.raises(
        ValueError, match="Chart x seams: every panel draws a pie or another mark without axes"
    ):
        hg.Chart(SALES, panels=["a"], x=seams).pie("product", panel="a").to_spec()
    with pytest.raises(KeyError, match="Chart facet: no column 'region'"):
        hg.Chart(SALES, facet="region").pie("product", data={"product": ["a"]})
    # Maps and networks draw in facet panels too; 3D charts have charts to themselves.
    network, _ = hg.Chart(SALES, facet="region").graph("region", "product").to_spec()
    assert network["marks"][0]["type"] == "graph"
    with pytest.raises(ValueError, match="point_3d facet: 3D marks cannot split into facets"):
        hg.Chart({"x": [1.0], "y": [1.0], "z": [1.0], "g": ["a"]}, facet="g").point_3d(
            "x", "y", "z"
        )


def test_a_layout_mark_fills_its_own_panel_beside_others():
    chart = (
        hg.Chart(SALES, panels=["trend", "share"], panel_columns=2, width=600, height=300)
        .line(x="week", y="revenue", panel="trend")
        .pie("product", "revenue", panel="share")
    )
    spec, _ = chart.to_spec()
    assert [mark.get("panel") for mark in spec["marks"]] == ["trend", "share"]
    svg = chart.to_svg()
    assert len(re.findall(r'<path d="M[^"]*A[^"]*Z" fill="#', svg)) == 3
    first, _ = (
        hg.Chart(SALES, panels=["share", "trend"])
        .pie("product", "revenue", panel="share")
        .line(x="week", y="revenue", panel="trend")
        .to_spec()
    )
    assert [mark["type"] for mark in first["marks"]] == ["pie", "line"]
    zoomed, _ = (
        hg.Chart(SALES, panels=["trend", "share"], zoom="x")
        .line(x="week", y="revenue", panel="trend")
        .gauge("revenue", panel="share")
        .to_spec()
    )
    assert zoomed["interaction"] == {"zoom": "x"}
    helper, _ = hg.pie(SALES, "product", panels=["share"], panel="share").to_spec()
    assert helper["marks"][0]["panel"] == "share"


def test_a_layout_marks_panel_is_its_own():
    two = hg.Chart(SALES, panels=["a", "b"])
    with pytest.raises(
        ValueError, match="pie panel: expected the id of the panel it draws in; received None"
    ):
        two.pie("product")
    with pytest.raises(
        ValueError, match='pie panel: expected the id of the panel it draws in; received "\\*"'
    ):
        hg.Chart(SALES, panels=["a", "b"]).pie("product", panel="*")
    with pytest.raises(ValueError, match='pie panel: no panel "c"; the chart has "a", "b"'):
        hg.Chart(SALES, panels=["a", "b"]).pie("product", panel="c")
    with pytest.raises(ValueError, match='funnel panel: a pie has panel "b" to itself'):
        hg.Chart(SALES, panels=["a", "b"]).pie("product", panel="b").funnel("product", panel="b")
    with pytest.raises(ValueError, match='line panel: a pie has panel "b" to itself'):
        hg.Chart(SALES, panels=["a", "b"]).pie("product", panel="b").line(
            x="week", y="revenue", panel="b"
        )
    with pytest.raises(ValueError, match='pie panel: a line draws in panel "b"'):
        hg.Chart(SALES, panels=["a", "b"]).line(x="week", y="revenue", panel="b").pie(
            "product", panel="b"
        )
    with pytest.raises(
        ValueError, match='rule panel: "\\*" would draw in panel "b", which a pie has to itself'
    ):
        hg.Chart(SALES, panels=["a", "b"]).pie("product", panel="b").rule(y=1, panel="*")
    with pytest.raises(
        ValueError, match='pie panel: the rule with panel="\\*" draws in panel "b" too'
    ):
        hg.Chart(SALES, panels=["a", "b"]).rule(y=1, panel="*").pie("product", panel="b")
    for own in ({"y": hg.Axis(title="n")}, {"y_right": hg.Axis(title="n")}):
        with pytest.raises(
            ValueError, match='Panel y(_right)?: panel "b" draws a pie, which has no axes'
        ):
            hg.Chart(SALES, panels=["a", hg.Panel("b", **own)]).pie("product", panel="b")
    with pytest.raises(ValueError, match="Chart zoom: every panel draws a pie"):
        hg.Chart(SALES, panels=["a"], zoom="x").pie("product", panel="a").to_spec()
    with pytest.raises(ValueError, match="point_3d panel: expected the id of the panel"):
        hg.Chart(SALES, panels=["a"]).point_3d(x="week", y="revenue", z="revenue")


def test_graphs_send_links_and_nodes_with_only_the_columns_they_read():
    talks = {
        "from": ["Ana", "Bo", "Ana", "Cy"],
        "to": ["Bo", "Ana", "Cy", "Dee"],
        "n": [3.0, 2.0, 1.0, 4.0],
        "note": ["a", "b", "c", "d"],
    }
    people = {
        "name": ["Ana", "Bo", "Cy", "Dee", "Eve"],
        "team": ["Data", "Data", "Sales", "Sales", "Ops"],
        "followers": [10.0, 20.0, 30.0, 40.0, 50.0],
        "age": [30, 40, 50, 60, 70],
    }
    chart = hg.graph(
        talks,
        "from",
        "to",
        "n",
        nodes=people,
        node="name",
        color="team",
        size="followers",
        width=400,
        height=300,
    )
    spec, _ = chart.to_spec()
    assert spec["marks"] == [
        {
            "type": "graph",
            "data": "data",
            "source": "from",
            "target": "to",
            "value": "n",
            "nodes": "data2",
            "node": "name",
            "color": "team",
            "size": "followers",
        }
    ]
    assert {name: sorted(table["columns"]) for name, table in spec["data"].items()} == {
        "data": ["from", "n", "to"],
        "data2": ["followers", "name", "team"],
    }
    svg = chart.to_svg()
    assert ">Eve</text>" in svg  # a node without links, from the nodes table
    # Without nodes, only the links are sent; options pass through.
    spec, _ = hg.Chart(talks).graph("from", "to", labels=False, id="talks").to_spec()
    assert spec["marks"][0] == {
        "type": "graph",
        "data": "data",
        "source": "from",
        "target": "to",
        "labels": False,
        "id": "talks",
    }
    assert sorted(spec["data"]["data"]["columns"]) == ["from", "to"]
    # Nodes from the chart's own data are its first table.
    both = {"from": ["a"], "to": ["b"], "name": ["a"], "kind": ["x"]}
    spec, _ = hg.Chart(both).graph("from", "to", nodes=both, node="name", color="kind").to_spec()
    assert spec["marks"][0]["nodes"] == "data"
    assert sorted(spec["data"]["data"]["columns"]) == ["from", "kind", "name", "to"]


def test_graphs_check_their_columns_and_size():
    talks = {"from": ["a", "b"], "to": ["b", "c"], "n": [1.0, 2.0]}
    people = {"name": ["a", "b"], "team": ["x", "y"], "age": [1.0, 2.0]}
    with pytest.raises(TypeError, match="graph target: column 'n' holds number"):
        hg.Chart(talks).graph("from", "n")
    with pytest.raises(TypeError, match="graph size: column 'team' holds category"):
        hg.Chart(talks).graph("from", "to", nodes=people, node="name", size="team")
    with pytest.raises(KeyError, match="graph color: no column 'kind'"):
        hg.Chart(talks).graph("from", "to", nodes=people, node="name", color="kind")
    with pytest.raises(ValueError, match="graph node: a nodes table needs node"):
        hg.Chart(talks).graph("from", "to", nodes=people)
    with pytest.raises(
        ValueError, match="graph color: node, color, and size are columns of a nodes table"
    ):
        hg.Chart(talks).graph("from", "to", color="team")
    with pytest.raises(ValueError, match="graph: has its chart to itself"):
        hg.Chart(talks).graph("from", "to").pie("from")
    for zoom in (True, "xy"):
        spec, _ = hg.Chart(talks, zoom=zoom, brush="lasso", drag=True).graph("from", "to").to_spec()
        assert spec["interaction"]["zoom"] == zoom
        assert spec["interaction"]["brush"] == "lasso"
        assert spec["interaction"]["drag"] is True
    with pytest.raises(ValueError, match="Chart zoom: a graph pans and zooms"):
        hg.Chart(talks, zoom="x").graph("from", "to")
    with pytest.raises(ValueError, match="Chart brush: a graph takes"):
        hg.Chart(talks, brush="xy").graph("from", "to")
    # Counted as the browser counts: rows left out add no nodes.
    many = {
        "from": [f"a{i}" for i in range(26_000)],
        "to": [f"b{i}" for i in range(26_000)],
        "n": [1.0] * 24_000 + [0.0] * 2_000,
    }
    hg.Chart(many).graph("from", "to", "n")
    with pytest.raises(
        ValueError,
        match="graph: draws at most 50,000 nodes .*; this network has 52,000 nodes and 26,000",
    ):
        hg.Chart(many).graph("from", "to")
    # Dense networks are refused by their links; rows either way are one link.
    names = [f"n{i}" for i in range(633)]
    pairs = [(a, b) for i, a in enumerate(names) for b in names[i + 1 :]]
    dense = {"from": [a for a, _ in pairs] + ["n1"], "to": [b for _, b in pairs] + ["n0"]}
    with pytest.raises(
        ValueError, match="graph: draws at most 50,000 nodes and 200,000 links; .* 200,028 links"
    ):
        hg.Chart(dense).graph("from", "to")
    hg.Chart({"from": dense["from"][:200_000], "to": dense["to"][:200_000]}).graph("from", "to")
    # Pairs whose values overflow are left out before counting, as in the browser.
    overflowing = {
        "from": dense["from"][:-1] * 2,
        "to": dense["to"][:-1] * 2,
        "v": [1e308] * (2 * len(pairs)),
    }
    hg.Chart(overflowing).graph("from", "to", "v")


def test_option_types_list_every_option():
    import inspect

    from herceg._chart import OPTIONS

    parameters = set(inspect.signature(hg.Chart.__init__).parameters) - {"self", "data"}
    assert set(hg.ChartOptions.__optional_keys__) == parameters
    assert set(hg.ChartUpdate.__optional_keys__) == set(OPTIONS)
    helper = set(hg.HelperOptions.__optional_keys__)
    assert helper == parameters - {"x", "y", "z"} | {"x_axis", "y_axis", "z_axis"}


def test_tooltip_fields_belong_to_marks():
    data = {"t": [0, 1], "p99": [210.0, 304.0], "requests": [9800, 12480], "host": ["a", "b"]}
    chart = hg.Chart(data, tooltip=hg.Tooltip(mode="nearest")).line(
        "t",
        "p99",
        tooltip=hg.Tooltip(
            fields=[
                hg.TooltipField("requests", label="Requests", format={"notation": "compact"}),
                "host",
            ]
        ),
    )
    spec, _ = chart.to_spec()
    assert spec["tooltip"] == {"mode": "nearest"}
    # Columns only the tooltip shows travel with the others.
    (table,) = spec["data"].values()
    assert set(table["columns"]) == {"t", "p99", "requests", "host"}
    assert spec["marks"][0]["tooltip"] == {
        "fields": [
            {"field": "requests", "label": "Requests", "format": {"notation": "compact"}},
            "host",
        ]
    }
    # A one-call helper's tooltip is its chart's, and its fields its mark's.
    spec, _ = hg.line(
        data, "t", "p99", tooltip=hg.Tooltip(mode="nearest", fields=["requests"])
    ).to_spec()
    assert spec["tooltip"] == {"mode": "nearest"}
    assert spec["marks"][0]["tooltip"] == {"fields": ["requests"]}
    spec, _ = hg.line(data, "t", "p99", tooltip=hg.Tooltip(fields=["requests"])).to_spec()
    assert "tooltip" not in spec
    # Axes write tooltips' values with formats of their own.
    spec, _ = hg.line(
        data, "t", "p99", y_axis=hg.Axis(tooltip_format={"style": "unit", "unit": "millisecond"})
    ).to_spec()
    assert spec["y"] == {"tooltipFormat": {"style": "unit", "unit": "millisecond"}}


def test_tooltip_fields_are_refused_where_they_do_not_belong():
    data = {"t": [0, 1], "p99": [210.0, 304.0], "host": ["a", "b"]}
    with pytest.raises(ValueError, match=r"^Chart tooltip fields: belong to the marks"):
        hg.Chart(data, tooltip=hg.Tooltip(fields=["host"])).line("t", "p99").to_spec()
    with pytest.raises(ValueError, match=r"^line tooltip mode: is the chart's"):
        hg.Chart(data).line("t", "p99", tooltip=hg.Tooltip(mode="nearest"))
    with pytest.raises(KeyError, match=r"^\"line tooltip fields\[0\]: no column 'hots'"):
        hg.Chart(data).line("t", "p99", tooltip=hg.Tooltip(fields=["hots"]))
    with pytest.raises(TypeError, match=r"^line tooltip fields\[0\]: expected a column name"):
        hg.Chart(data).line("t", "p99", tooltip=hg.Tooltip(fields=[3]))  # type: ignore[list-item]
    with pytest.raises(ValueError, match=r"^line tooltip fields: expected a list of columns"):
        hg.Chart(data).line("t", "p99", tooltip=hg.Tooltip(fields="host"))
    with pytest.raises(ValueError, match=r'^TooltipField format: "weekdy" is not an Intl'):
        hg.TooltipField("t", format={"weekdy": "short"})
    with pytest.raises(ValueError, match=r"^pie tooltip fields: its points summarize rows"):
        hg.pie(data, "host", "p99", tooltip=hg.Tooltip(fields=["t"]))


def test_helpers_name_themselves_for_options_they_do_not_take():
    # Python's own error would name Chart.__init__, which helpers pass options to.
    with pytest.raises(TypeError, match=r"^line: no option 'tittle'; did you mean 'title'\?$"):
        hg.line(DATA, "t", "p50", tittle="Latency")
    with pytest.raises(TypeError, match=r"^line: no option 'seris'; did you mean 'series'\?$"):
        hg.line(DATA, "t", "p50", seris="host")
    # Other libraries' names point to herceg's.
    with pytest.raises(
        TypeError, match=r"^line: no option 'color'; did you mean 'series' or 'stroke'\?$"
    ):
        hg.line(DATA, "t", "p50", color="red")
    with pytest.raises(
        TypeError, match=r"^bar: no option 'colour'; did you mean 'series' or 'fill'\?$"
    ):
        hg.bar(DATA, "t", "p50", colour="red")
    with pytest.raises(TypeError, match=r"see help\(herceg.scatter\) for the options it takes$"):
        hg.scatter(DATA, "t", "p50", bogus=1)
    # The helpers keep their signatures for help() and editors.
    assert hg.line.__name__ == "line"
    assert "series" in inspect.signature(hg.line).parameters


def test_helpers_take_axes_as_x_axis_and_y_axis():
    spec, _ = hg.line(
        DATA, "t", "p50", x_axis=hg.Axis(title="time"), y_axis={"title": "ms"}
    ).to_spec()
    assert spec["x"] == {"title": "time"}
    assert spec["y"] == {"title": "ms"}


HELPERS = {
    "line": "line",
    "area": "area",
    "bar": "bar",
    "scatter": "point",
    "heatmap": "heatmap",
    "contour": "contour",
    "histogram": "histogram",
    "pie": "pie",
    "gauge": "gauge",
    "funnel": "funnel",
    "boxplot": "boxplot",
    "violin": "violin",
    "treemap": "treemap",
    "sunburst": "sunburst",
    "radar": "radar",
    "sankey": "sankey",
    "graph": "graph",
    "choropleth": "geoshape",
    "scatter_geo": "geopoint",
    "candlestick": "candlestick",
    "scatter_3d": "point_3d",
    "surface": "surface",
}


def _parameters(function):
    """A function's parameters with their resolved annotations and defaults."""
    import inspect

    annotations = inspect.get_annotations(function, eval_str=True)
    return {
        name: (annotations.get(name), parameter.default, parameter.kind)
        for name, parameter in inspect.signature(function).parameters.items()
    }


@pytest.mark.parametrize("helper", HELPERS)
def test_helpers_take_every_keyword_argument_of_their_mark(helper):
    import inspect

    function = _parameters(getattr(hg, helper))
    method = _parameters(getattr(hg.Chart, HELPERS[helper]))
    # The helper's data is the chart's; it takes the rest of the mark's
    # arguments in the mark's order, after those it takes positionally.
    positional = [
        name for name, (_, _, kind) in function.items() if kind != inspect.Parameter.KEYWORD_ONLY
    ]
    keywords = [
        name for name, (_, _, kind) in function.items() if kind == inspect.Parameter.KEYWORD_ONLY
    ]
    # A helper's facet is its chart's (the field splitting panels): its one
    # mark has no other marks' panels to repeat in. Its tooltip is the
    # chart's too, whose fields go to the mark.
    skipped = {"self", "data", "facet", "tooltip", *positional}
    expected = [name for name in method if name not in skipped]
    assert keywords == expected
    for name in keywords:
        assert function[name][:2] == method[name][:2], name


@pytest.mark.parametrize("helper", HELPERS)
def test_helpers_pass_every_keyword_argument_to_their_mark(helper, monkeypatch):
    import inspect

    method = getattr(hg.Chart, HELPERS[helper])
    calls = []

    def record(self, *args, **kwargs):
        calls.append(inspect.signature(method).bind(self, *args, **kwargs).arguments)
        return self

    monkeypatch.setattr(hg.Chart, HELPERS[helper], record)
    parameters = list(inspect.signature(getattr(hg, helper)).parameters.values())
    values = {p.name: f"<{p.name}>" for p in parameters[1:] if p.kind != p.VAR_KEYWORD}
    positional = [values[p.name] for p in parameters[1:] if p.kind == p.POSITIONAL_OR_KEYWORD]
    keywords = {p.name: values[p.name] for p in parameters if p.kind == p.KEYWORD_ONLY}
    getattr(hg, helper)(DATA, *positional, **keywords)
    (arguments,) = calls
    del arguments["self"]
    # Without tooltip fields, the mark has no tooltip of its own.
    assert arguments.pop("tooltip", None) is None
    # A choropleth joining values to GeoJSON passes its data to the mark.
    if helper == "choropleth":
        values["data"] = DATA
    assert arguments == values


def test_helpers_pass_mark_keywords_to_the_mark_and_the_rest_to_the_chart():
    spec, _ = hg.line(DATA, "t", "p50", stroke="#ff0000", stroke_width=2, title="Latency").to_spec()
    assert spec["title"] == "Latency"
    assert spec["marks"][0]["stroke"] == "#ff0000"
    assert spec["marks"][0]["strokeWidth"] == 2
    band, _ = hg.area(DATA, "t", y1="p50", y2="p99").to_spec()
    assert band["marks"][0] == {"type": "area", "data": "data", "x": "t", "y1": "p50", "y2": "p99"}
    with pytest.raises(TypeError, match="strok"):
        hg.line(DATA, "t", "p50", strok="red")


def test_none_takes_the_default_of_every_option_at_construction():
    import typing

    hg.Chart(DATA, animation=None, tooltip=None, zoom=None).line(x="t", y="p50").to_spec()
    hg.scatter(DATA, "t", "p50", animation=None)
    # Annotations resolve at runtime, as documentation tools and validators read them.
    assert "options" in typing.get_type_hints(hg.line)
    from herceg.widget import ChartWidget

    assert "options" in typing.get_type_hints(ChartWidget.update)


def test_boxplot_precomputed_statistics_and_notches():
    data = {"group": ["a"], "lo": [0], "q1": [1], "median": [2], "q3": [3], "hi": [4], "n": [100]}
    fields = {"low": "lo", "q1": "q1", "median": "median", "q3": "q3", "high": "hi"}
    for orientation in ({"x": "group"}, {"y": "group"}):
        spec, _ = hg.boxplot(data, **orientation, **fields).to_spec()
        assert spec["marks"] == [{"type": "boxplot", "data": "data", **orientation, **fields}]
        chart = hg.Chart(data).boxplot(**orientation, **fields, count="n", notch=True)
        spec, _ = chart.to_spec()
        assert spec["marks"][0] == {
            "type": "boxplot",
            "data": "data",
            **orientation,
            **fields,
            "count": "n",
            "notch": True,
        }
        assert "<path" in chart.to_svg()
    with pytest.raises(ValueError, match="boxplot: raw x and y values or precomputed statistics"):
        hg.boxplot(data, x="group", y="median", **fields)
    with pytest.raises(ValueError, match="boxplot notch: precomputed boxes need count"):
        hg.boxplot(data, x="group", **fields, notch=True)
    with pytest.raises(
        ValueError, match="boxplot whiskers: low and high already give precomputed boxes"
    ):
        hg.boxplot(data, x="group", **fields, whiskers="range")
    with pytest.raises(
        ValueError, match="boxplot low: precomputed boxes need .*; give low, median, q3, high"
    ):
        hg.boxplot(data, x="group", q1="q1")
    with pytest.raises(ValueError, match="boxplot: precomputed boxes need a category x or y"):
        hg.boxplot(data, **fields)
    with pytest.raises(ValueError, match="boxplot axis: horizontal box plots have no right axis"):
        hg.boxplot(data, y="group", **fields, axis="right")
    with pytest.raises(TypeError, match="boxplot low.*category"):
        hg.boxplot(data, x="group", **{**fields, "low": "group"})
    with pytest.raises(TypeError, match="boxplot count.*category"):
        hg.boxplot(data, x="group", **fields, count="group")


def test_boxplot_outliers_and_boxen_marks_serialize():
    data = {"g": ["a"] * 20, "v": [float(i) for i in range(19)] + [100.0]}
    spec, _ = hg.boxplot(data, x="g", y="v", outliers=False).to_spec()
    assert spec["marks"][0]["outliers"] is False
    fields = {"low": "v", "q1": "v", "median": "v", "q3": "v", "high": "v"}
    with pytest.raises(ValueError, match="boxplot outliers: precomputed boxes have none to draw"):
        hg.boxplot(data, x="g", **fields, outliers=False)
    with pytest.raises(TypeError, match="boxplot outliers: expected True or False"):
        hg.boxplot(data, x="g", y="v", outliers="no")  # type: ignore[arg-type]
    chart = hg.boxen(
        data, "g", "v", depth="proportion", outlier_proportion=0.1, width_method="linear"
    )
    spec, _ = chart.to_spec()
    assert spec["marks"] == [
        {
            "type": "boxen",
            "data": "data",
            "x": "g",
            "y": "v",
            "depth": "proportion",
            "outlierProportion": 0.1,
            "widthMethod": "linear",
        }
    ]
    assert 'fill-opacity="0.7"' in chart.to_svg()
    horizontal = hg.Chart(data).boxen("v", "g", depth=2, trust_alpha=0.1, outliers=False)
    assert horizontal.to_spec()[0]["marks"][0]["outliers"] is False
    for option, value, message in (
        ("depth", 0, "boxen depth: expected"),
        ("depth", "quartiles", "boxen depth: expected"),
        ("outlier_proportion", 1, "boxen outlier_proportion: expected a number between 0 and 1"),
        ("width_method", "square", 'boxen width_method: expected "exponential"'),
    ):
        with pytest.raises(ValueError, match=message):
            hg.boxen(data, "g", "v", **{option: value})
    with pytest.raises(ValueError, match="boxen axis: horizontal boxen plots have no right axis"):
        hg.boxen(data, "v", "g", axis="right")


@pytest.mark.parametrize("whiskers", ["tukey", "range", 0, 1.5, 2])
def test_boxplot_whisker_rules_serialize(whiskers):
    data = {"g": ["a", "a", "a"], "v": [1, 2, 10]}
    spec, _ = hg.boxplot(data, x="g", y="v", whiskers=whiskers).to_spec()
    assert spec["marks"][0]["whiskers"] == whiskers


@pytest.mark.parametrize("whiskers", [-1, float("inf"), float("nan"), True, "other"])
def test_boxplot_rejects_invalid_whisker_rules(whiskers):
    with pytest.raises(
        ValueError, match="boxplot whiskers: expected .* a finite nonnegative IQR multiple"
    ):
        hg.boxplot({"g": ["a"], "v": [1]}, x="g", y="v", whiskers=whiskers)


@pytest.mark.parametrize("whiskers", [np.int64(2), np.float32(0.5), np.float64(1.5)])
def test_boxplot_numpy_whisker_multiples_serialize(whiskers):
    spec, _ = hg.boxplot({"g": ["a"], "v": [1]}, x="g", y="v", whiskers=whiskers).to_spec()
    assert json.loads(json.dumps(spec))["marks"][0]["whiskers"] == float(whiskers)


def test_legend_groups_share_series_by_name():
    summary = {
        "day": ["thu", "thu", "fri", "fri"],
        "sex": ["f", "m", "f", "m"],
        "mean": [2.0, 3.0, 4.0, 5.0],
        "low": [1.0, 2.0, 3.0, 4.0],
        "high": [3.0, 4.0, 5.0, 6.0],
    }
    chart = (
        hg.Chart(summary, width=400, height=240)
        .bar(x="day", y="mean", series="sex", legend_group="sex")
        .error_bar(x="day", y1="low", y2="high", series="sex", dodge=True, legend_group="sex")
    )
    spec, _ = chart.to_spec()
    assert [mark.get("legendGroup") for mark in spec["marks"]] == ["sex", "sex"]
    assert spec["marks"][1]["dodge"] is True
    svg = chart.to_svg()
    # One legend entry per sex.
    assert svg.count(">f</text>") == 1 and svg.count(">m</text>") == 1
    for method in ("line", "area", "point", "histogram", "candlestick", "boxplot", "violin"):
        assert "legend_group" in inspect.signature(getattr(hg.Chart, method)).parameters
    with pytest.raises(ValueError, match='bar legend_group: expected a name; received ""'):
        hg.Chart(summary).bar(x="day", y="mean", legend_group="")


def test_points_dodge_and_jitter_in_category_bands():
    rows = {"day": ["thu", "thu", "fri"], "sex": ["f", "m", "f"], "tip": [1.0, 2.0, 3.0]}
    spec, _ = hg.scatter(rows, x="day", y="tip", series="sex", dodge=True, jitter=0.4).to_spec()
    assert spec["marks"][0]["dodge"] is True
    assert spec["marks"][0]["jitter"] == {"width": 0.4}
    seeded = hg.Chart(rows).point(x="day", y="tip", jitter=hg.Jitter(width=0.2, seed=7))
    assert seeded.to_spec()[0]["marks"][0]["jitter"] == {"width": 0.2, "seed": 7}
    assert "<circle" in seeded.to_svg() or "<path" in seeded.to_svg()
    with pytest.raises(ValueError, match="point dodge: places series side by side; give series"):
        hg.scatter(rows, x="day", y="tip", dodge=True)
    with pytest.raises(ValueError, match="point jitter: needs exactly one category column"):
        hg.scatter(rows, x="tip", y="tip", jitter=0.2)
    with pytest.raises(
        ValueError, match="Jitter width: expected a number from 0 to 1; received 1.5"
    ):
        hg.scatter(rows, x="day", y="tip", jitter=1.5)
    with pytest.raises(ValueError, match="Jitter seed: expected a whole number; received 1.5"):
        hg.scatter(rows, x="day", y="tip", jitter=hg.Jitter(seed=1.5))  # type: ignore[arg-type]
    with pytest.raises(
        ValueError, match="error_bar dodge: needs a category x; column 'tip' holds number values"
    ):
        hg.Chart(rows).error_bar(x="tip", y1="tip", y2="tip", series="sex", dodge=True)


def test_rug_has_one_axis_and_styles_per_observation():
    spec, _ = (
        hg.Chart(DATA)
        .rug("t", series="host", length=12, side="top", stroke="red", stroke_width=2, id="events")
        .to_spec()
    )
    assert spec["marks"][0] == {
        "type": "rug",
        "x": "t",
        "series": "host",
        "length": 12,
        "side": "top",
        "stroke": "red",
        "strokeWidth": 2,
        "id": "events",
        "data": "data",
    }
    yspec, _ = hg.Chart(DATA).rug(y="p50", side="right", label="Latency").to_spec()
    assert yspec["marks"][0]["y"] == "p50"
    assert "x" not in yspec["marks"][0]
    assert yspec["marks"][0]["label"] == "Latency"
    assert not hasattr(hg, "rug")
    svg = hg.Chart(DATA, width=300, height=150).rug("t", stroke="#123456").to_svg()
    assert 'stroke="#123456"' in svg
    assert 'stroke-width="1"' in svg


@pytest.mark.parametrize(
    "options",
    [
        {},
        {"x": "t", "y": "p50"},
        {"x": "host"},
        {"x": "missing"},
        {"y": "p50", "axis": "right"},
        {"x": "t", "side": "left"},
        {"y": "p50", "side": "top"},
        {"x": "t", "length": 0},
        {"x": "t", "length": -1},
        {"x": "t", "length": float("inf")},
        {"x": "t", "length": float("nan")},
        {"x": "t", "stroke_width": -1},
        {"x": "t", "stroke_width": float("inf")},
        {"x": "t", "series": "p50"},
    ],
)
def test_rug_refuses_invalid_columns_and_options(options):
    with pytest.raises((ValueError, TypeError, KeyError)):
        hg.Chart(DATA).rug(**options)


def test_rug_uses_other_tables_facets_and_subplots():
    spec, _ = hg.Chart(DATA).rug(y="v", data={"v": [3, 1, 2]}).to_spec()
    assert spec["marks"][0]["data"] == "data2"
    facets, _ = hg.Chart(DATA, facet="host").rug("t", facet="repeat").to_spec()
    assert facets["marks"][0]["facet"] == "repeat"
    subplots, _ = hg.Chart(DATA, panels=[hg.Panel("main")]).rug("t", panel="main").to_spec()
    assert subplots["marks"][0]["panel"] == "main"


def test_rug_numeric_styles_are_serializable():
    chart = hg.Chart(DATA).rug("t", length=np.float32(8), stroke_width=np.int64(2))
    spec, _ = chart.to_spec()
    assert spec["marks"][0]["length"] == 8
    assert spec["marks"][0]["strokeWidth"] == 2
    assert json.dumps(spec)


@pytest.mark.parametrize("inner", [None, "box", "quartiles", "none"])
@pytest.mark.parametrize("split", [None, False, True])
def test_violin_options_serialize(inner, split):
    data = {
        "g": ["a", "a", "a", "a"],
        "s": ["first", "first", "second", "second"],
        "v": [1, 3, 2, 4],
    }
    spec, _ = hg.violin(data, x="g", y="v", series="s", split=split, inner=inner).to_spec()
    mark = spec["marks"][0]
    assert mark.get("split") is split
    assert mark.get("inner") == inner
    assert ("split" in mark) is (split is not None)
    assert ("inner" in mark) is (inner is not None)
    method_spec, _ = hg.Chart(data).violin("g", "v", series="s", split=split, inner=inner).to_spec()
    assert method_spec == spec


def test_violin_option_errors():
    data = {"g": ["a", "a"], "v": [1, 2]}
    with pytest.raises(
        ValueError, match="violin split: halves each category between two series; give series"
    ):
        hg.violin(data, "g", "v", split=True)
    for split in (1, "true"):
        with pytest.raises(TypeError, match="violin split: expected True or False"):
            hg.Chart(data).violin("g", "v", split=split)
    for inner in ("points", False, 1):
        with pytest.raises(
            ValueError, match='violin inner: expected "box", "quartiles", or "none"'
        ):
            hg.violin(data, "g", "v", inner=inner)
    many = {"g": ["a", "b", "c"], "s": ["first", "second", "third"], "v": [1, 2, 3]}
    with pytest.raises(ValueError, match='series field "s" has 3 values'):
        hg.violin(many, "g", "v", series="s", split=True).to_svg()


@pytest.mark.parametrize("horizontal", [False, True])
@pytest.mark.parametrize("inner", ["box", "quartiles", "none"])
def test_split_violin_exports_and_facets(horizontal, inner):
    data = {
        "g": ["a", "a", "a", "a", "b", "b"],
        "p": ["P", "P", "P", "P", "Q", "Q"],
        "s": ["first", "first", "second", "second", "second", "second"],
        "v": [1, 3, 2, 4, 5, 7],
    }
    chart = hg.Chart(
        data, facet="p", **{"y" if horizontal else "x": hg.Axis(scope="panel")}
    ).violin(
        "v" if horizontal else "g", "g" if horizontal else "v", series="s", split=True, inner=inner
    )
    svg = chart.to_svg()
    assert 'fill-opacity="0.25"' in svg
    assert ('stroke-dasharray="4 3"' in svg) is (inner == "quartiles")
    assert ">first</text>" in svg
    assert ">second</text>" in svg
    assert chart.to_pdf().startswith(b"%PDF-")


MONTHLY = {
    "month": ["Jan", "Feb", "Mar", "Jan", "Feb", "Mar"],
    "sales": [1.0, 2.0, 3.0, 10.0, 20.0, 30.0],
    "region": ["N", "N", "N", "S", "S", "S"],
}
PROFILE = {
    "depth": [0.0, 10.0, 20.0],
    "temperature": [20.0, 15.0, 8.0],
    "salinity": [35.0, 35.2, 35.4],
}


def test_lines_and_areas_over_categories_and_along_y_serialize_and_draw():
    over = (
        hg.Chart(MONTHLY)
        .bar("month", "sales", series="region")
        .line("month", "sales", series="region", dodge=True)
    )
    marks = over.to_spec()[0]["marks"]
    assert marks[1] == {
        "type": "line",
        "data": "data",
        "x": "month",
        "y": "sales",
        "series": "region",
        "dodge": True,
    }
    assert "<path" in over.to_svg()
    along = hg.line(PROFILE, ["temperature", "salinity"], "depth", orient="y")
    assert along.to_spec()[0]["marks"][0]["x"] == ["temperature", "salinity"]
    assert along.to_spec()[0]["marks"][0]["orient"] == "y"
    assert "<path" in along.to_svg()
    band = hg.Chart(PROFILE).area(y="depth", x1="temperature", x2="salinity")
    assert band.to_spec()[0]["marks"][0] == {
        "type": "area",
        "data": "data",
        "y": "depth",
        "x1": "temperature",
        "x2": "salinity",
    }
    filled = hg.area(PROFILE, "temperature", "depth", orient="y")
    assert "<path" in filled.to_svg() and "<path" in band.to_svg()
    # A category y lays a line along y without orient.
    assert hg.line(MONTHLY, "sales", "month").to_spec()[0]["marks"][0].get("orient") is None


@pytest.mark.parametrize(
    ("make", "message"),
    [
        (
            lambda c: c.line("month", "sales", dodge=True),
            "line dodge: places series side by side; give series",
        ),
        (
            lambda c: c.line("sales", "sales", series="region", dodge=True),
            "line dodge: places series side by side in the bands of a category x",
        ),
        (lambda c: c.line(["sales", "sales"], "sales"), 'give orient="y", or one x column'),
        (lambda c: c.line("sales", "month", orient="z"), 'line orient: expected "x" or "y"'),
        (lambda c: c.area(y="month", x1="sales"), "area x2: a band needs both x1 and x2"),
        (
            lambda c: c.area("sales", "month", x1="sales", x2="sales"),
            "area x: x, or x1 and x2, not both",
        ),
        (
            lambda c: c.area(y="month", x1="sales", x2="sales", orient="x"),
            "area orient: a band between x1 and x2 runs along y",
        ),
        (
            lambda c: c.area("month", "sales", series="region", stack=True, dodge=True),
            "area dodge: a stack's layers stand on each other",
        ),
        (
            lambda c: c.line("sales", "month", axis="right"),
            'line axis: lines along y use the left axis, as horizontal bars do; drop axis="right"',
        ),
        (
            lambda c: c.area(y="month", x1="sales", x2="sales", axis="right"),
            "area axis: areas along y use the left axis",
        ),
    ],
)
def test_line_and_area_orientation_errors(make, message):
    with pytest.raises((ValueError, TypeError), match=message):
        make(hg.Chart(MONTHLY))


def test_points_swarm_and_refuse_jitter_with_it():
    chart = hg.scatter(MONTHLY, "month", "sales", swarm=True)
    assert chart.to_spec()[0]["marks"][0]["swarm"] is True
    assert "<circle" in chart.to_svg() or "<path" in chart.to_svg()
    with pytest.raises(ValueError, match="point swarm: places points itself; drop jitter or swarm"):
        hg.Chart(MONTHLY).point("month", "sales", swarm=True, jitter=0.5)
    with pytest.raises(ValueError, match="point swarm: needs exactly one category column"):
        hg.Chart(MONTHLY).point("sales", "sales", swarm=True)


@pytest.mark.parametrize("stack", ["fill", "center", "wiggle"])
@pytest.mark.parametrize("horizontal", [False, True])
def test_area_stack_offsets(stack, horizontal):
    data = {"t": [0, 1, 2], "a": [2, 4, 0], "b": [6, 4, 0]}
    xy = {"y": "t", "x": ["a", "b"], "orient": "y"} if horizontal else {"x": "t", "y": ["a", "b"]}
    for chart in [hg.area(data, **xy, stack=stack), hg.Chart(data).area(**xy, stack=stack)]:
        assert chart.to_spec()[0]["marks"][0]["stack"] == stack
        svg = chart.to_svg()
        assert 'fill-opacity="0.85"' in svg
        assert "NaN" not in svg
    inside_out = hg.area(data, **xy, stack=stack, stack_order="inside-out")
    assert inside_out.to_spec()[0]["marks"][0]["stackOrder"] == "inside-out"
    assert "<path" in inside_out.to_svg()


@pytest.mark.parametrize("horizontal", [False, True])
def test_bar_fill_stack(horizontal):
    data = {"band": ["N", "S"], "a": [2, 4], "b": [6, 4]}
    xy = {"y": "band", "x": ["a", "b"]} if horizontal else {"x": "band", "y": ["a", "b"]}
    chart = hg.bar(data, **xy, stack="fill", labels={"style": "percent"})
    assert chart.to_spec()[0]["marks"][0]["stack"] == "fill"
    assert ">25%</text>" in chart.to_svg()
    with pytest.raises(ValueError, match="bar stack:.*;.*use an area"):
        hg.bar(data, **xy, stack="center")


@pytest.mark.parametrize("stack", ["fill", "center", "wiggle"])
def test_nonnegative_stack_validation_and_gaps(stack):
    signed = {"t": [0, 1], "v": [1, -2], "series": ["a", "b"]}
    with pytest.raises(ValueError, match="area stack v: negative.*; use stack=True"):
        hg.area(signed, x="t", y="v", stack=stack)
    assert hg.area(signed, x="t", y="v", stack=True).to_spec()[0]["marks"][0]["stack"] is True
    data = {"t": [0, 1, 2], "v": [2, np.nan, 4], "series": ["a", "a", "b"]}
    chart = hg.area(data, x="t", y="v", series="series", stack=stack, stack_gaps="interpolate")
    assert chart.to_spec()[0]["marks"][0]["stackGaps"] == "interpolate"
    assert "NaN" not in chart.to_svg()
    with pytest.raises(ValueError, match="area stack_order:.*;.*give stack="):
        hg.area(data, x="t", y="v", stack_order="inside-out")


@pytest.mark.parametrize(
    ("halo", "spec"),
    [
        (False, False),
        ("auto", "auto"),
        (hg.Halo("#fafafa", width=4), {"color": "#fafafa", "width": 4}),
        ({"color": "#000", "opacity": 0.5}, {"color": "#000", "opacity": 0.5}),
    ],
)
def test_halo_option_is_shared_by_all_text_drawing_marks(halo, spec):
    values = {"category": ["A", "B", "C"], "value": [10, 20, 30]}
    links = {"source": ["A", "B"], "target": ["B", "C"], "value": [10, 5]}
    charts = [
        hg.Chart().text(x=1, y=1, label="note", halo=halo),
        hg.Chart().region(x1=0, x2=2, label="note", halo=halo),
        hg.bar(values, x="category", y="value", labels=True, halo=halo),
        hg.funnel(values, category="category", value="value", halo=halo),
        hg.radar(values, category="category", value="value", halo=halo),
        hg.sankey(links, source="source", target="target", value="value", halo=halo),
        hg.graph(links, source="source", target="target", halo=halo),
    ]
    for chart in charts:
        mark = chart.to_spec()[0]["marks"][0]
        assert mark["halo"] == spec
        assert "<svg" in chart.to_svg()
    chart = hg.line(DATA, x="t", y="p50", navigator=hg.Navigator(halo=halo))
    assert chart.to_spec()[0]["navigator"] == {"halo": spec}


def test_halo_rejects_other_values_with_python_option_names():
    with pytest.raises(ValueError, match='text halo: expected "auto", False, or an hg.Halo'):
        hg.Chart().text(x=1, y=1, label="note", halo="no")  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="received True"):
        hg.Chart().text(x=1, y=1, label="note", halo=True)  # type: ignore[arg-type]
    with pytest.raises(TypeError, match="Navigator halo: expected an hg.Halo"):
        hg.line(DATA, x="t", y="p50", navigator=hg.Navigator(halo=0))  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="Halo width: expected a number of at least 0"):
        hg.Halo("#fff", width=-1)


def test_text_surface_halo_and_opt_out_in_static_exports():
    for halo in ("auto", False):
        chart = hg.Chart(width=300, height=150).text(
            x=1, y=1, label="note", fill="#e06600", halo=halo
        )
        svg = chart.to_svg()
        assert ('stroke="#ffffff" stroke-opacity="1"' in svg) is (halo == "auto")
        assert chart.to_pdf().startswith(b"%PDF")
    wide = hg.Chart(width=300, height=150).text(
        x=1, y=1, label="note", halo=hg.Halo("#123456", width=5, opacity=0.5)
    )
    assert 'stroke="#123456" stroke-opacity="0.5" stroke-width="5"' in wide.to_svg()


def test_static_isolated_rows_have_round_dots():
    chart = hg.line({"x": [0, 1, 2, 3, 4], "y": [1, np.nan, 3, np.nan, 5]}, x="x", y="y")
    svg = chart.to_svg()
    assert len(re.findall(r"M([\d.-]+ [\d.-]+)L\1(?=[ML\"])", svg)) == 3
    assert 'stroke-linecap="round"' in svg


def test_style_builders_check_their_values_in_python_names():
    cases = [
        (lambda: hg.TextStyle(opacity=2), "TextStyle opacity: expected a number from 0 to 1"),
        (lambda: hg.Halo("#fff", opacity=2), "Halo opacity: expected a number from 0 to 1"),
        (lambda: hg.PlotStyle(stroke_width=-1), "PlotStyle stroke_width: expected a number"),
        (lambda: hg.LineStyle(stroke_width=0), "LineStyle stroke_width: expected a positive"),
        (lambda: hg.TextStyle(color=3), "TextStyle color: expected a CSS color"),
        (lambda: hg.TextBox(fill="#fff", radius=-2), "TextBox radius: expected a number"),
        (lambda: hg.StrokeStyle(dash=[2, -1]), r"StrokeStyle dash\[1\]: expected a number"),
        (
            lambda: hg.Title("T", place=hg.Place(side="top", offset=20)),
            "Title place: a title takes only side",
        ),
        (lambda: hg.Place(side="right", scope="panel"), "Place scope: a place on a side"),
    ]
    for make, message in cases:
        with pytest.raises((ValueError, TypeError), match=message):
            make()
