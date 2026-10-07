import datetime as dt

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
            DATA, title="Latency", y=hg.Axis(label="ms", type="log"), time_zone="UTC", zoom=True
        )
        .line(x="t", y=["p50", "p99"], stroke_width=2)
        .rule(y=250, label="SLO")
    )
    spec, buffers = chart.to_spec()
    assert spec["version"] == 1
    assert spec["title"] == "Latency"
    assert spec["timeZone"] == "UTC"
    assert spec["y"] == {"type": "log", "label": "ms"}
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
    with pytest.raises(KeyError, match="no column 'p90'; the data has 't', 'p50'"):
        hg.Chart(DATA).line(x="t", y="p90")
    with pytest.raises(TypeError, match="line y: column 'host' holds category values"):
        hg.Chart(DATA).line(x="t", y="host")
    with pytest.raises(ValueError, match="exactly one of x or y"):
        hg.Chart(DATA).rule()
    with pytest.raises(ValueError, match="Pass data"):
        hg.Chart().line(x="t", y="p50")


def test_express_helpers_and_rules_at_datetimes():
    spec, _ = hg.scatter(DATA, x="p50", y="p99", series="host", r=3, title="S").to_spec()
    assert spec["title"] == "S"
    assert spec["marks"][0] == {
        "type": "point",
        "x": "p50",
        "y": "p99",
        "series": "host",
        "r": 3,
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
    with pytest.raises(ValueError, match="y, or y1 and y2, not both"):
        hg.Chart(DATA).area(x="t", y="p50", y1="p50", y2="p99")
    with pytest.raises(ValueError, match="needs both y1 and y2"):
        hg.Chart(DATA).area(x="t", y1="p50")
    with pytest.raises(ValueError, match="not a series column"):
        hg.Chart(DATA).area(x="t", y="p50", series="host", stack=True)
    with pytest.raises(ValueError, match="several value columns or a series column"):
        hg.Chart(DATA).line(x="t", y=["p50", "p99"], series="host")


def test_a_category_y_makes_bars_horizontal():
    spec, _ = hg.bar(DATA, x=["p50", "p99"], y="host", stack=True).to_spec()
    assert spec["marks"][0] == {
        "type": "bar",
        "x": ["p50", "p99"],
        "y": "host",
        "stack": True,
        "data": "data",
    }
    with pytest.raises(ValueError, match="need a category y"):
        hg.bar(DATA, x=["p50", "p99"], y="p50")
    with pytest.raises(TypeError, match="horizontal bar x"):
        hg.bar(DATA, x="host", y="host")
    svg = hg.bar(DATA, x="p50", y="host", width=300, height=150).to_svg()
    assert svg.count('Z" fill') == 1


def test_annotations_take_constants_or_columns():
    events = {"at": np.array(["2026-01-01T00:00:30"], dtype="datetime64[ms]"), "name": ["deploy"]}
    chart = (
        hg.Chart(DATA, time_zone="UTC")
        .region(x1=dt.datetime(2026, 1, 1), x2=dt.datetime(2026, 1, 1, 0, 0, 20), label="warmup")
        .line(x="t", y="p50")
        .rule(x="at", text="name", data=events)
        .rule(y=np.float32(2.5), label="limit")
        .text(x="t", y="p99", text="host", dy=-8)
    )
    spec, _ = chart.to_spec()
    marks = spec["marks"]
    assert marks[0] == {
        "type": "region",
        "x1": 1767225600000.0,
        "x2": 1767225620000.0,
        "label": "warmup",
    }
    assert marks[2] == {"type": "rule", "x": "at", "text": "name", "data": "data2"}
    assert marks[3] == {"type": "rule", "y": 2.5, "label": "limit"}
    assert (marks[4]["data"], marks[4]["text"]) == ("data", "host")
    assert sorted(spec["data"]["data"]["columns"]) == ["host", "p50", "p99", "t"]
    svg = chart.to_svg()
    for label in ("warmup", "deploy", "limit", "a", "b"):
        assert f">{label}</text>" in svg


def test_annotation_options_are_checked():
    with pytest.raises(ValueError, match="exactly one of label or text"):
        hg.Chart(DATA).text(x=1, y=2)
    with pytest.raises(ValueError, match="both x1 and x2"):
        hg.Chart(DATA).region(x1=1)
    with pytest.raises(TypeError, match="rule x: column 'host'"):
        hg.Chart(DATA).rule(x="host")
    with pytest.raises(TypeError, match="text text: column 't'"):
        hg.Chart(DATA).text(x="t", y="p50", text="t")
    with pytest.raises(ValueError, match="Pass data"):
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
    with pytest.raises(ValueError, match="x with y1 and y2"):
        hg.Chart(DATA).error_bar(x="t", y1="p50")
    symmetric, buffers = hg.Chart(DATA).error_bar(x="t", y="p50", y_error="p99").to_spec()
    assert symmetric["marks"][0]["yError"] == "p99"
    assert sorted(symmetric["data"]["data"]["columns"]) == ["p50", "p99", "t"]


def test_marks_go_on_the_right_axis():
    chart = (
        hg.Chart(DATA, y_right=hg.Axis(label="p99"), width=300, height=150)
        .line(x="t", y="p50")
        .line(x="t", y="p99", axis="right")
        .rule(y=5, axis="right")
    )
    spec, _ = chart.to_spec()
    assert spec["yRight"] == {"label": "p99"}
    assert [mark.get("axis") for mark in spec["marks"]] == [None, "right", "right"]
    assert 'transform="rotate(90 ' in chart.to_svg()
    with pytest.raises(ValueError, match="horizontal bars cannot use the right axis"):
        hg.Chart(DATA).bar(x="p50", y="host", axis="right")
    with pytest.raises(ValueError, match="horizontal error bars"):
        hg.Chart(DATA).error_bar(y="host", x1="p50", x2="p99", axis="right")
    with pytest.raises(ValueError, match="axis must be 'left' or 'right'"):
        hg.Chart(DATA).line(x="t", y="p50", axis="middle")  # type: ignore[arg-type]
