import datetime as dt
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


def test_facets_split_marks_into_panels():
    chart = (
        hg.Chart(DATA, facet="host", facet_columns=2, width=400, height=200)
        .line(x="t", y="p50")
        .rule(y=2, label="limit")
        .line(x="t", y="p99", data={"t": DATA["t"], "p99": DATA["p99"]}, repeat=True)
    )
    spec, _ = chart.to_spec()
    assert spec["facet"] == {"field": "host", "columns": 2}
    # The facet column travels with the data of marks it splits, and only those.
    assert sorted(spec["data"]["data"]["columns"]) == ["host", "p50", "t"]
    assert sorted(spec["data"]["data2"]["columns"]) == ["p99", "t"]
    assert spec["marks"][2]["facet"] == "repeat"
    svg = chart.to_svg()
    assert ">a</text>" in svg and ">b</text>" in svg
    with pytest.raises(KeyError, match="facet: no column 'region'"):
        hg.Chart(DATA, facet="region").line(x="t", y="p50")
    with pytest.raises(ValueError, match="pass repeat=True"):
        hg.Chart(DATA, facet="host").rule(x="t")
    with pytest.raises(ValueError, match="facet_columns needs facet"):
        hg.Chart(DATA, facet_columns=2)
    with pytest.raises(ValueError, match="whole number"):
        hg.Chart(DATA, facet="host", facet_columns=True)
    with pytest.raises(ValueError, match="cannot use the right axis"):
        hg.Chart(DATA, facet="host").rule(y=1, axis="right")


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
        values, "x", "y", r="pop", color="growth", colors="rdbu", color_midpoint=0, symbol="kind"
    )
    spec, _ = chart.to_spec()
    assert spec["marks"][0] == {
        "type": "point",
        "x": "x",
        "y": "y",
        "r": "pop",
        "color": "growth",
        "colors": "rdbu",
        "colorMidpoint": 0,
        "symbol": "kind",
        "data": "data",
    }
    assert sorted(spec["data"]["data"]["columns"]) == ["growth", "kind", "pop", "x", "y"]
    svg = hg.Chart(values, width=300, height=200).point("x", "y", symbol="diamond").to_svg()
    assert "<path" in svg
    # A shape's name is not a column, so it is not sent as one.
    one, _ = hg.Chart(values).point("x", "y", symbol="star", r_range=(1, 9)).to_spec()
    assert sorted(one["data"]["data"]["columns"]) == ["x", "y"]
    assert hg.scatter(values, "x", "y", r="pop", width=300, height=200).to_svg().count("<path") > 1


def test_encodings_are_checked():
    values = {"x": np.array([1.0]), "y": np.array([2.0]), "kind": ["a"]}
    with pytest.raises(ValueError, match="neither a column nor one of circle"):
        hg.Chart(values).point("x", "y", symbol="hexagon")
    with pytest.raises(TypeError, match="point symbol"):
        hg.Chart(values).point("x", "y", symbol="x")
    with pytest.raises(TypeError, match="point color"):
        hg.Chart(values).point("x", "y", color="kind")
    with pytest.raises(ValueError, match="unknown scheme 'virdis'"):
        hg.Chart(values).point("x", "y", color="x", colors="virdis")
    with pytest.raises(ValueError, match="color_domain must be two finite numbers, ascending"):
        hg.Chart(values).heatmap("x", "y", "x", color_domain=(1, 0))
    with pytest.raises(ValueError, match="color_domain must be two finite"):
        hg.Chart(values).point("x", "y", color="x", color_domain=(0, float("inf")))
    with pytest.raises(ValueError, match="r_range must be two finite numbers, ascending, from 0"):
        hg.Chart(values).point("x", "y", r="x", r_range=(-1, 4))
    with pytest.raises(ValueError, match="color_midpoint must be a finite"):
        hg.Chart(values).point("x", "y", color="x", color_midpoint=float("nan"))
    with pytest.raises(ValueError, match="outside color_domain"):
        hg.Chart(values).point("x", "y", color="x", color_domain=(0, 1), color_midpoint=2)
    with pytest.raises(ValueError, match="positive radius"):
        hg.Chart(values).point("x", "y", r=0)
    with pytest.raises(ValueError, match="from 0 to 1"):
        hg.Chart(values).point("x", "y", fill_opacity=1.5)


def test_heatmaps_take_schemes_and_midpoints():
    values = {"c": ["a", "b"], "r": ["u", "u"], "v": np.array([-1.0, 1.0])}
    spec, _ = hg.heatmap(
        values, "c", "r", "v", colors="viridis", color_domain=(-2, 2), color_midpoint=0
    ).to_spec()
    assert spec["marks"][0]["colors"] == "viridis"
    assert spec["marks"][0]["colorDomain"] == [-2, 2]
    assert spec["marks"][0]["colorMidpoint"] == 0


def test_scatter_helper_takes_every_encoding():
    values = {"x": np.array([1.0, 2.0]), "y": np.array([3.0, 4.0]), "s": np.array([1.0, 5.0])}
    chart = hg.scatter(
        values, "x", "y", r="s", r_range=(1, 9), color="s", color_domain=(0, 10), width=300
    )
    spec, _ = chart.to_spec()
    assert spec["marks"][0]["rRange"] == [1, 9]
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


def test_theme_keys_and_names_match_typescript():
    from typing import get_args

    from herceg._chart import _THEME_KEYS, ThemeName

    theme = {"extends": "high-contrast", "bar_radius": 0, "tooltip_border": "#000"}
    spec, _ = hg.Chart(DATA, theme=theme).line(x="t", y="p50").to_spec()
    assert spec["theme"] == {"extends": "high-contrast", "barRadius": 0, "tooltipBorder": "#000"}
    root = Path(__file__).resolve().parents[2] / "packages" / "herceg" / "src"
    if not root.exists():
        pytest.skip("needs a source checkout")
    source = (root / "spec" / "spec.ts").read_text()
    names = re.search(r"export type ThemeName =([^;]+);", source)[1]
    assert tuple(re.findall(r'"([\w-]+)"', names)) == get_args(ThemeName)
    body = source[source.index("export interface ThemeSpec") :]
    keys = re.findall(r"^  (\w+)\?:", body[: body.index("\n}")], re.MULTILINE)
    assert {key for key in keys if not key.islower()} == set(_THEME_KEYS.values())


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
    with pytest.raises(ValueError, match="has its chart to itself"):
        hg.Chart(sales).pie("region").line(x="revenue", y="revenue")
    with pytest.raises(ValueError, match="has its chart to itself"):
        hg.Chart(sales).bar(x="region", y="revenue").pie("region")
    with pytest.raises(ValueError, match="inner_radius"):
        hg.Chart(sales).pie("region", inner_radius=1)
    with pytest.raises(TypeError, match="pie value: column 'region' holds category"):
        hg.Chart(sales).pie("region", "region")
    with pytest.raises(ValueError, match="no x axis"):
        hg.Chart(sales, zoom=True).pie("region")


def test_pie_slices_decode_as_item_inspections():
    from herceg._events import decode_inspection

    inspection = decode_inspection(
        {
            "axis": "item",
            "value": 40,
            "time": False,
            "label": "revenue",
            "points": [{"series": "North", "value": 40, "text": "40 (40%)"}],
        }
    )
    assert inspection.axis == "item"
    assert inspection.value == 40
    assert inspection.points[0].series == "North"


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
    with pytest.raises(ValueError, match="min must be below max"):
        hg.gauge(readings, "cpu", min=5, max=5)
    with pytest.raises(ValueError, match="at most at max"):
        hg.gauge(readings, "cpu", bands=[150])
    with pytest.raises(ValueError, match="ascending order, not 40 after 50"):
        hg.gauge(readings, "cpu", bands=[50, 40])
    with pytest.raises(ValueError, match="numbers or"):
        hg.gauge(readings, "cpu", bands=[(50, "red", "x")])
    with pytest.raises(KeyError, match="gauge value: no column 'load'"):
        hg.gauge(readings, "load")
    with pytest.raises(ValueError, match="a gauge has its chart to itself"):
        hg.Chart(readings).gauge("cpu").line(x="cpu", y="cpu")
    with pytest.raises(ValueError, match="no x axis"):
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
    with pytest.raises(ValueError, match="a funnel has its chart to itself"):
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
    with pytest.raises(ValueError, match="horizontal box plots cannot use the right axis"):
        hg.Chart(data).boxplot(x="ms", y="region", axis="right")
    with pytest.raises(ValueError, match="fill_opacity"):
        hg.Chart(data).boxplot(x="region", y="ms", fill_opacity=2)
    with pytest.raises(ValueError, match="cannot be split into panels"):
        hg.Chart(data, facet="v").boxplot(x="region", y="ms")


def test_violins_take_a_bandwidth_and_the_box_plot_options():
    data = {"region": ["n", "n", "n", "s", "s"], "ms": [1.0, 2.0, 4.0, 3.0, 9.0]}
    spec, _ = hg.violin(data, x="region", y="ms", bandwidth=0.5).to_spec()
    assert spec["marks"] == [
        {"type": "violin", "data": "data", "x": "region", "y": "ms", "bandwidth": 0.5}
    ]
    svg = hg.Chart(data, width=300, height=200).violin(x="ms", y="region").to_svg()
    assert 'fill-opacity="0.25"' in svg
    for bad in (0, -1, float("nan"), True):
        with pytest.raises(ValueError, match="bandwidth must be a positive number"):
            hg.Chart(data).violin(x="region", y="ms", bandwidth=bad)
    with pytest.raises(ValueError, match="horizontal violins cannot use the right axis"):
        hg.Chart(data).violin(x="ms", y="region", axis="right")
    with pytest.raises(TypeError, match="violin y: column 'region' holds category"):
        hg.Chart(data).violin(x="region", y="region")
    with pytest.raises(ValueError, match="cannot be split into panels"):
        hg.Chart(data, facet="region").violin(x="region", y="ms")


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
    with pytest.raises(ValueError, match="needs a path of category columns"):
        hg.Chart(sales).treemap()
    with pytest.raises(ValueError, match="a treemap has its chart to itself"):
        hg.Chart(sales).treemap(["region"]).pie("region")
    with pytest.raises(TypeError, match="treemap path: column 'revenue' holds number"):
        hg.Chart(sales).treemap(["revenue"])
