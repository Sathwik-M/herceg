import shutil
import subprocess
from io import BytesIO
from xml.etree import ElementTree

import numpy as np
import pandas as pd
import pytest

import herceg as hg


@pytest.mark.parametrize("format", ["png", "pdf"])
def test_subplot_export_pixels_follow_each_configured_camera(tmp_path, format):
    from PIL import Image

    if format == "pdf" and shutil.which("pdftoppm") is None:
        pytest.skip("Poppler is not installed")

    def chart(azimuth):
        return (
            hg.Chart(
                {"x": [0.7], "y": [0.4], "z": [0.8]},
                width=800,
                height=350,
                legend=False,
                x=hg.Axis(domain=(-1, 1)),
                y=hg.Axis(domain=(-1, 1)),
                z=hg.Axis(domain=(-1, 1)),
                panels=[
                    hg.Panel("a", camera={"azimuth": azimuth}),
                    hg.Panel("b", camera={"azimuth": 90}),
                ],
                panel_columns=2,
            )
            .point_3d("x", "y", "z", fill="#ff0000", radius=8, panel="a")
            .point_3d("x", "y", "z", fill="#ff0000", radius=8, panel="b")
        )

    def pixels(azimuth):
        item = chart(azimuth)
        if format == "png":
            image = Image.open(BytesIO(item.to_png(scale=1)))
        else:
            pdf = tmp_path / f"camera-{azimuth}.pdf"
            pdf.write_bytes(item.to_pdf())
            subprocess.run(
                ["pdftoppm", "-r", "96", "-singlefile", "-png", str(pdf), str(pdf.with_suffix(""))],
                check=True,
                capture_output=True,
            )
            image = Image.open(pdf.with_suffix(".png"))
        assert image.size == (800, 350)
        return np.array(image.convert("RGB"))

    # Normalize by each panel's actual plot center, including the outer insets and grid gap.
    clips = ElementTree.fromstring(chart(90).to_svg()).findall(
        ".//{http://www.w3.org/2000/svg}clipPath/{http://www.w3.org/2000/svg}rect"
    )
    plot_centers = [float(rect.attrib["x"]) + float(rect.attrib["width"]) / 2 for rect in clips]
    assert len(plot_centers) == 2

    def red_centers(image):
        centers = []
        for index, half in enumerate([image[:, :400], image[:, 400:]]):
            mask = (half[:, :, 0] > 250) & (half[:, :, 1] < 5) & (half[:, :, 2] < 5)
            y, x = np.nonzero(mask)
            assert len(x) > 100
            centers.append(np.array([x.mean() + index * 400 - plot_centers[index], y.mean()]))
        return centers

    before = pixels(20)
    after = pixels(90)
    assert np.array_equal(before[:, 400:], after[:, 400:])
    original, neighbor = red_centers(before)
    turned, same_neighbor = red_centers(after)
    assert np.linalg.norm(original - neighbor) > 20
    assert np.linalg.norm(turned - same_neighbor) < 0.5


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
        z=hg.Axis(title="Height"),
        camera=hg.Camera(azimuth=30, elevation=40, perspective=True),
        box_aspect=(2, 1, 1),
        zoom=True,
        rotate=False,
    ).point_3d("x", "y", "z", series="kind", radius=4, label="Readings")
    spec, buffers = chart.to_spec()
    assert spec["marks"] == [
        {
            "type": "point3d",
            "data": "data",
            "x": "x",
            "y": "y",
            "z": "z",
            "series": "kind",
            "radius": 4,
            "label": "Readings",
        }
    ]
    assert spec["z"] == {"title": "Height"}
    assert spec["camera"] == {"azimuth": 30.0, "elevation": 40.0, "zoom": 1.0, "perspective": True}
    assert spec["boxAspect"] == [2.0, 1.0, 1.0]
    assert spec["interaction"] == {"zoom": True, "rotate": False}
    # z is a column the chart sends, and the date column, unused, is not.
    assert list(column(spec, buffers, "z")) == [0, 1, 4, 9]
    assert "when" not in spec["data"]["data"]["columns"]


def test_scatter_3d_takes_dates_and_chart_options():
    chart = hg.scatter_3d(
        points(), x="when", y="x", z="z", color="y", camera={"azimuth": 10}, z_axis={"title": "H"}
    )
    spec, _ = chart.to_spec()
    assert spec["marks"][0]["color"] == "y"
    assert spec["camera"]["azimuth"] == 10.0
    assert spec["z"] == {"title": "H"}
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
    # A matrix: row i, column j is the height at y[i], x[j], its coordinates sent once each.
    assert spec["data"]["data"]["matrix"] == {"x": "x", "y": "y"}
    assert list(column(spec, buffers, "x")) == [10, 20, 30]
    assert list(column(spec, buffers, "y")) == [0.5, 1.5]
    assert list(column(spec, buffers, "z")) == [1, 2, 3, 4, 5, 6]
    spec, buffers = hg.surface(z=heights).to_spec()
    # Positions 0, 1, 2, ... by default.
    assert list(column(spec, buffers, "y")) == [0, 1]


def test_line_3d_emits_its_fields_and_takes_chart_options():
    chart = hg.Chart(points()).line_3d("x", "y", "z", series="kind", stroke_width=3, label="Paths")
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
    spec, _ = hg.Chart(points()).point_3d("x", "y", "z").line_3d("x", "y", "z").to_spec()
    assert [mark["type"] for mark in spec["marks"]] == ["point3d", "line3d"]
    with pytest.raises(
        ValueError, match="line_3d stroke_width: expected a positive number of pixels; received 0"
    ):
        hg.Chart(points()).line_3d("x", "y", "z", stroke_width=0)
    with pytest.raises(TypeError, match="line_3d series: column 'x' holds number values"):
        hg.Chart(points()).line_3d("x", "y", "z", series="x")
    svg = hg.Chart(points(), width=400, height=300).line_3d("x", "y", "z").to_svg()
    assert 'stroke-linecap="round"' in svg


def test_3d_marks_share_their_chart_only_with_each_other():
    chart = hg.Chart(points()).point_3d("x", "y", "z")
    chart.surface(z=np.ones((2, 2)))
    with pytest.raises(
        ValueError,
        match="point_3d: shares its chart only with point_3d, line_3d, and surface marks",
    ):
        chart.line("x", "y")
    with pytest.raises(
        ValueError,
        match="point_3d: shares its chart only with point_3d, line_3d, and surface marks",
    ):
        hg.Chart(points()).line("x", "y").point_3d("x", "y", "z")
    with pytest.raises(ValueError, match="Chart brush: a point_3d has no x axis"):
        hg.Chart(points(), brush="x").point_3d("x", "y", "z")
    with pytest.raises(
        ValueError, match='Chart zoom: 3D charts zoom their camera with zoom=True; received "x"'
    ):
        hg.Chart(points(), zoom="x").point_3d("x", "y", "z")
    with pytest.raises(ValueError, match="Chart camera: an option of 3D charts"):
        hg.Chart(points(), camera=hg.Camera()).line("x", "y").to_spec()


def test_3d_options_and_fields_are_checked():
    with pytest.raises(
        ValueError, match="Camera elevation: expected degrees from -90 to 90; received 95"
    ):
        hg.Chart(points(), camera={"elevation": 95}).point_3d("x", "y", "z").to_spec()
    with pytest.raises(
        ValueError, match=r"Chart box_aspect: expected three positive lengths; received \(1, 0, 1\)"
    ):
        hg.Chart(points(), box_aspect=(1, 0, 1)).point_3d("x", "y", "z").to_spec()
    with pytest.raises(TypeError, match="point_3d z: column 'kind' holds category values"):
        hg.Chart(points()).point_3d("x", "y", "kind")
    with pytest.raises(ValueError, match=r"surface z: expected a 2D matrix; received shape \(3,\)"):
        hg.surface(z=[1, 2, 3])
    with pytest.raises(
        ValueError, match="surface x: expected 3 values, one per matrix column; received 2"
    ):
        hg.surface(z=np.ones((2, 3)), x=[1, 2])


def test_3d_charts_export_to_svg_and_pdf():
    chart = hg.Chart(points(), title="Clusters", width=400, height=300).point_3d(
        "x", "y", "z", series="kind"
    )
    svg = chart.to_svg()
    assert svg.startswith("<svg") and "Clusters" in svg and ">z</text>" in svg
    surface = hg.surface(z=np.outer(np.arange(5.0), np.arange(5.0)), width=400, height=300)
    assert "<path" in surface.to_svg()
    assert surface.to_pdf().startswith(b"%PDF-1.4\n")


def test_3d_subplots_compose_layers_and_export_each_camera():
    chart = (
        hg.Chart(
            points(),
            panels=[
                "trend",
                hg.Panel("a", title="Cloud", camera={"azimuth": 20}),
                hg.Panel("b", title="Fit", camera=hg.Camera(azimuth=90)),
            ],
            panel_columns=3,
            camera=hg.Camera(elevation=35),
            zoom=True,
        )
        .line("x", "z", panel="trend")
        .point_3d("x", "y", "z", panel="a")
        .line_3d("x", "y", "z", panel="a")
        .surface(z=[[0.0, 1.0], [2.0, 3.0]], panel="b")
    )
    spec, _ = chart.to_spec()
    assert [m["panel"] for m in spec["marks"]] == ["trend", "a", "a", "b"]
    assert spec["panels"][1]["camera"] == {"azimuth": 20.0}
    svg = chart.to_svg()
    assert "azimuth 20°, elevation 35°" in svg
    assert "azimuth 90°, elevation 25°" in svg
    assert "Cloud" in svg and "Fit" in svg
    assert chart.to_pdf().startswith(b"%PDF")
    with pytest.raises(ValueError, match="Panel camera:.*has no 3D marks"):
        hg.Chart(points(), panels=[hg.Panel("a", camera=hg.Camera())]).line(
            "x", "y", panel="a"
        ).to_spec()
    with pytest.raises(ValueError, match="point_3d panel: a line draws in panel"):
        hg.Chart(points(), panels=["a"]).line("x", "y", panel="a").point_3d(
            "x", "y", "z", panel="a"
        )
