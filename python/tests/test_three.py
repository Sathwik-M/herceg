import numpy as np
import pandas as pd
import pytest

import herceg as hg


def points():
    return pd.DataFrame(
        {
            "x": [0.0, 1.0, 2.0, 3.0],
            "y": [3.0, 2.0, 1.0, 0.0],
            "z": [0.0, 1.0, 4.0, 9.0],
            "kind": ["a", "a", "b", "b"],
            "when": pd.date_range("2024-01-01", periods=4, freq="D"),
        }
    )


def column(spec, buffers, name, table="data"):
    entry = spec["data"][table]["columns"][name]
    return np.frombuffer(buffers[entry["buffer"]], dtype=entry["dtype"])


def test_point3d_emits_its_fields_and_the_chart_its_3d_options():
    chart = hg.Chart(
        points(),
        z=hg.Axis(label="Height"),
        camera=hg.Camera(azimuth=30, elevation=40, perspective=True),
        box_aspect=(2, 1, 1),
        zoom=True,
        rotate=False,
    ).point3d("x", "y", "z", series="kind", r=4, label="Readings")
    spec, buffers = chart.to_spec()
    assert spec["marks"] == [
        {
            "type": "point3d",
            "data": "data",
            "x": "x",
            "y": "y",
            "z": "z",
            "series": "kind",
            "r": 4,
            "label": "Readings",
        }
    ]
    assert spec["z"] == {"label": "Height"}
    assert spec["camera"] == {"azimuth": 30.0, "elevation": 40.0, "zoom": 1.0, "perspective": True}
    assert spec["boxAspect"] == [2.0, 1.0, 1.0]
    assert spec["interaction"] == {"zoom": True, "rotate": False}
    # z is a column the chart sends, and the date column, unused, is not.
    assert list(column(spec, buffers, "z")) == [0, 1, 4, 9]
    assert "when" not in spec["data"]["data"]["columns"]


def test_scatter_3d_takes_dates_and_chart_options():
    chart = hg.scatter_3d(
        points(), x="when", y="x", z="z", color="y", camera={"azimuth": 10}, z_axis={"label": "H"}
    )
    spec, _ = chart.to_spec()
    assert spec["marks"][0]["color"] == "y"
    assert spec["camera"]["azimuth"] == 10.0
    assert spec["z"] == {"label": "H"}
    assert spec["data"]["data"]["columns"]["when"]["type"] == "time"


def test_surface_from_columns_and_from_a_matrix():
    grid = pd.DataFrame({"e": [0, 1, 0, 1], "n": [0, 0, 1, 1], "h": [1.0, 2.0, 3.0, 4.0]})
    spec, _ = hg.Chart(grid).surface("e", "n", "h", wireframe=True, shading=False).to_spec()
    assert spec["marks"][0] == {
        "type": "surface",
        "data": "data",
        "x": "e",
        "y": "n",
        "z": "h",
        "shading": False,
        "wireframe": True,
    }
    heights = np.array([[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]])
    spec, buffers = hg.surface(z=heights, x=[10, 20, 30], y=[0.5, 1.5], title="Matrix").to_spec()
    # Row i, column j is the height at y[i], x[j].
    assert list(column(spec, buffers, "x")) == [10, 20, 30, 10, 20, 30]
    assert list(column(spec, buffers, "y")) == [0.5, 0.5, 0.5, 1.5, 1.5, 1.5]
    assert list(column(spec, buffers, "z")) == [1, 2, 3, 4, 5, 6]
    spec, buffers = hg.surface(z=heights).to_spec()
    # Positions 0, 1, 2, ... by default.
    assert list(column(spec, buffers, "y")) == [0, 0, 0, 1, 1, 1]


def test_line3d_emits_its_fields_and_line_3d_takes_chart_options():
    chart = hg.Chart(points()).line3d("x", "y", "z", series="kind", stroke_width=3, label="Paths")
    spec, buffers = chart.to_spec()
    assert spec["marks"] == [
        {
            "type": "line3d",
            "data": "data",
            "x": "x",
            "y": "y",
            "z": "z",
            "series": "kind",
            "strokeWidth": 3,
            "label": "Paths",
        }
    ]
    assert list(column(spec, buffers, "z")) == [0, 1, 4, 9]
    chart = hg.line_3d(points(), x="when", y="x", z="z", stroke="#123456", camera={"azimuth": 10})
    spec, _ = chart.to_spec()
    assert spec["marks"][0]["stroke"] == "#123456"
    assert spec["camera"]["azimuth"] == 10.0
    assert spec["data"]["data"]["columns"]["when"]["type"] == "time"
    # Lines share a chart with the other 3D marks.
    spec, _ = hg.Chart(points()).point3d("x", "y", "z").line3d("x", "y", "z").to_spec()
    assert [mark["type"] for mark in spec["marks"]] == ["point3d", "line3d"]
    with pytest.raises(ValueError, match="stroke_width must be a positive width"):
        hg.Chart(points()).line3d("x", "y", "z", stroke_width=0)
    with pytest.raises(TypeError, match="line3d series: column 'x' holds number values"):
        hg.Chart(points()).line3d("x", "y", "z", series="x")
    svg = hg.Chart(points(), width=400, height=300).line3d("x", "y", "z").to_svg()
    assert 'stroke-linecap="round"' in svg


def test_3d_marks_share_their_chart_only_with_each_other():
    chart = hg.Chart(points()).point3d("x", "y", "z")
    chart.surface(z=np.ones((2, 2)))
    with pytest.raises(ValueError, match="shares its chart only with point3d, line3d, and surface"):
        chart.line("x", "y")
    with pytest.raises(ValueError, match="a point3d shares its chart only with"):
        hg.Chart(points()).line("x", "y").point3d("x", "y", "z")
    with pytest.raises(ValueError, match="no x axis to brush"):
        hg.Chart(points(), brush="x").point3d("x", "y", "z")
    with pytest.raises(ValueError, match="zoom their camera with zoom=True"):
        hg.Chart(points(), zoom="x").point3d("x", "y", "z")
    with pytest.raises(ValueError, match="camera is an option of 3D charts"):
        hg.Chart(points(), camera=hg.Camera()).line("x", "y").to_spec()


def test_3d_options_and_fields_are_checked():
    with pytest.raises(ValueError, match="elevation must be from -90 to 90"):
        hg.Chart(points(), camera={"elevation": 95}).point3d("x", "y", "z").to_spec()
    with pytest.raises(ValueError, match="box_aspect must be three positive lengths"):
        hg.Chart(points(), box_aspect=(1, 0, 1)).point3d("x", "y", "z").to_spec()
    with pytest.raises(TypeError, match="point3d z: column 'kind' holds category values"):
        hg.Chart(points()).point3d("x", "y", "kind")
    with pytest.raises(ValueError, match="2D"):
        hg.surface(z=[1, 2, 3])
    with pytest.raises(ValueError, match="needs 3 values, one per matrix column"):
        hg.surface(z=np.ones((2, 3)), x=[1, 2])


def test_3d_charts_export_to_svg_and_pdf():
    chart = hg.Chart(points(), title="Clusters", width=400, height=300).point3d(
        "x", "y", "z", series="kind"
    )
    svg = chart.to_svg()
    assert svg.startswith("<svg") and "Clusters" in svg and ">z</text>" in svg
    surface = hg.surface(z=np.outer(np.arange(5.0), np.arange(5.0)), width=400, height=300)
    assert "<path" in surface.to_svg()
    assert surface.to_pdf().startswith(b"%PDF-1.4\n")
