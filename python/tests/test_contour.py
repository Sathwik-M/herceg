"""Contours, matrices, and 2D histograms: the spec they emit and what they draw."""

import json
import re

import numpy as np
import pytest

import herceg as hg


def _cone(n=21):
    xs = np.linspace(-1, 1, n)
    gx, gy = np.meshgrid(xs, xs)
    return xs, 10 * (1 - np.minimum(1, np.hypot(gx, gy)))


def test_contours_of_rows_emit_their_thresholds_and_variant():
    xs, z = _cone()
    gx, gy = np.meshgrid(xs, xs)
    rows = {"x": gx.ravel(), "y": gy.ravel(), "z": z.ravel()}
    chart = hg.Chart(rows).contour("x", "y", "z", thresholds=[2, 5, 8], variant="bands")
    spec, _ = chart.to_spec()
    assert spec["marks"][0] == {
        "type": "contour",
        "x": "x",
        "y": "y",
        "color": "z",
        "thresholds": [2.0, 5.0, 8.0],
        "variant": "bands",
        "data": "data",
    }
    svg = chart.to_svg()
    assert svg.count('fill-rule="evenodd"') == 2


def test_matrices_send_their_coordinates_once_and_read_as_rows_of_pairs():
    xs, z = _cone()
    field = hg.matrix({"x": xs, "y": xs, "z": z}, x="x", y="y")
    assert field.shape == (21, 21)
    chart = hg.Chart(field).contour("x", "y", "z", thresholds=3, variant="bands")
    spec, buffers = chart.to_spec()
    table = spec["data"]["data"]
    assert table["matrix"] == {"x": "x", "y": "y"}
    # Two coordinate arrays of 21 values and 441 values, not three columns of 441.
    assert sorted(len(b) for b in buffers) == [21 * 8, 21 * 8, 441 * 8]
    json.dumps(spec)
    assert chart.to_svg().count('fill-rule="evenodd"') >= 1
    # A heatmap of the same matrix: cells read rows, which the browser makes.
    assert hg.Chart(field).heatmap("x", "y", "z").to_svg().count("<image ") == 1


def test_marks_take_a_matrix_of_values_with_optional_positions():
    xs, z = _cone(11)
    spec, buffers = hg.contour(color=z, x=xs, y=xs, label="height").to_spec()
    assert spec["data"]["data"]["matrix"] == {"x": "x", "y": "y"}
    assert spec["marks"][0]["color"] == "value"
    assert spec["marks"][0]["label"] == "height"
    heat, _ = hg.heatmap(color=z).to_spec()
    assert heat["data"]["data"]["matrix"] == {"x": "x", "y": "y"}
    surface, buffers = hg.Chart().surface(z=z).to_spec()
    assert sorted(len(b) for b in buffers) == [11 * 8, 11 * 8, 121 * 8]
    with pytest.raises(ValueError, match="contour x: expected 11 values, one per matrix column"):
        hg.contour(color=z, x=xs[:-1])
    with pytest.raises(ValueError, match="contour value: expected a 2D matrix"):
        hg.contour(color=z.ravel())


def test_matrices_check_their_shape():
    with pytest.raises(ValueError, match=r"matrix column 'z': expected shape \(2, 3\)"):
        hg.matrix({"x": [0, 1, 2], "y": [0, 1], "z": np.zeros((3, 2))}, x="x", y="y")
    with pytest.raises(ValueError, match="matrix column 'z': expected 6 values, 3 x by 2 y"):
        hg.matrix({"x": [0, 1, 2], "y": [0, 1], "z": [1, 2, 3]}, x="x", y="y")
    with pytest.raises(KeyError, match="matrix y: no column 'lat'"):
        hg.matrix({"x": [0, 1], "z": [1, 2]}, x="x", y="lat")
    with pytest.raises(ValueError, match="matrix y: 'x' also holds x"):
        hg.matrix({"x": [0, 1], "z": [1, 2]}, x="x", y="x")


def test_contours_refuse_options_of_the_other_variant_and_bad_thresholds():
    xs, z = _cone(5)
    field = hg.matrix({"x": xs, "y": xs, "z": z}, x="x", y="y")
    with pytest.raises(ValueError, match="contour stroke: draws lines; bands take colors"):
        hg.Chart(field).contour("x", "y", "z", variant="bands", stroke="#000000")
    with pytest.raises(ValueError, match="contour fill_opacity: fills bands"):
        hg.Chart(field).contour("x", "y", "z", fill_opacity=0.5)
    with pytest.raises(ValueError, match="contour thresholds: expected 2 to 1000 values"):
        hg.Chart(field).contour("x", "y", "z", variant="bands", thresholds=[1])
    with pytest.raises(ValueError, match=r"contour thresholds\[1\]: expected a value above 2"):
        hg.Chart(field).contour("x", "y", "z", thresholds=[2, 1])
    with pytest.raises(ValueError, match="contour thresholds: expected a whole number"):
        hg.Chart(field).contour("x", "y", "z", thresholds=0)
    with pytest.raises(ValueError, match='contour variant: expected "lines" or "bands"'):
        hg.Chart(field).contour("x", "y", "z", variant="filled")  # type: ignore[arg-type]


def test_2d_histograms_emit_bins_per_axis_and_count_as_numpy_does():
    rng = np.random.default_rng(3)
    x = rng.normal(size=500)
    y = x * 0.5 + rng.normal(size=500)
    x_edges = np.linspace(-3, 3, 7)
    y_edges = [-4.0, -1.0, 0.0, 0.5, 4.0]
    chart = hg.Chart({"x": x, "y": y}).histogram(
        "x", y="y", bins={"x": x_edges, "y": y_edges}, colors="viridis"
    )
    spec, _ = chart.to_spec()
    mark = spec["marks"][0]
    assert mark["bins"] == {"x": list(x_edges), "y": y_edges}
    assert mark["colors"] == "viridis"
    assert chart.to_svg().count("<image ") == 1
    with pytest.raises(ValueError, match="histogram stack: for bars of x or y"):
        hg.Chart({"x": x, "y": y}).histogram("x", y="y", stack=True)


def test_contours_and_2d_histograms_share_one_pdf(tmp_path):
    xs = np.linspace(-1, 1, 21)
    grid = 1 - np.hypot(*np.meshgrid(xs, xs))
    field = hg.contour(color=grid, x=xs, y=xs, variant="bands", thresholds=[0, 0.3, 0.6, 0.9])
    rng = np.random.default_rng(4)
    cells = hg.histogram({"a": rng.normal(size=200), "b": rng.normal(size=200)}, "a", y="b")
    pdf = hg.to_pdf([field, cells])
    assert pdf.startswith(b"%PDF")
    assert len(re.findall(rb"/Type /Page\b", pdf)) == 2
    path = tmp_path / "density.pdf"
    hg.save([field, cells], path)
    assert path.read_bytes() == pdf


def test_live_matrix_charts_count_a_row_per_pair_of_coordinates():
    field = hg.matrix({"x": [0, 1], "y": [0, 1, 2], "v": np.arange(6.0)}, x="x", y="y")
    widget = hg.Chart(field, row_selection=hg.SelectionBinding("c")).heatmap("x", "y", "v").widget()
    widget.row_selection = [4]
    assert widget.row_selection is not None
    assert list(widget.row_selection.rows) == [4]


def test_express_density_widgets_send_their_contours_whole_as_rows_arrive():
    pytest.importorskip("anywidget")
    import herceg.express as hx

    rng = np.random.default_rng(6)
    data = {"a": rng.normal(size=300), "b": rng.normal(size=300)}
    first = {name: values[:200] for name, values in data.items()}
    live = hx.kdeplot(first, x="a", y="b", levels=4).widget()
    before = live._snapshot()["spec"]["marks"][0]["thresholds"]
    live.append({name: values[200:] for name, values in data.items()})
    after = live._snapshot()["spec"]
    expected, _ = hx.kdeplot(data, x="a", y="b", levels=4).to_spec()
    assert after["marks"][0]["thresholds"] == expected["marks"][0]["thresholds"] != before
    assert after["data"]["data"]["matrix"] == {"x": "a", "y": "b"}


def test_bivariate_express_charts_recompute_as_made_again():
    import herceg.express as hx

    rng = np.random.default_rng(7)
    data = {"a": rng.normal(size=240), "b": rng.normal(size=240)}
    first = {name: values[:160] for name, values in data.items()}
    for make in (
        lambda d: hx.kdeplot(d, x="a", y="b", filled=True),
        lambda d: hx.histplot(d, x="a", y="b"),
        lambda d: hx.jointplot(d, x="a", y="b", kind="kde"),
        lambda d: hx.jointplot(d, x="a", y="b", kind="hist"),
    ):
        assert hx.recompute(make(first), data).to_spec()[0] == make(data).to_spec()[0]


def test_bivariate_kdeplots_of_no_density_draw_nothing_filled_or_not():
    import herceg.express as hx

    # One row of weight and the others none, or rows on a line: no density to contour.
    weighted = {"a": [0.0, 1.0, 2.0], "b": [0.0, 1.0, 0.0], "w": [1.0, 0.0, 0.0]}
    line = {"a": [0.0, 1.0, 2.0, 3.0], "b": [0.0, 2.0, 4.0, 6.0]}
    for filled in (False, True):
        for chart in (
            hx.kdeplot(weighted, x="a", y="b", weight="w", filled=filled),
            hx.kdeplot(line, x="a", y="b", filled=filled),
        ):
            assert chart.to_spec()[0]["marks"] == []
