import re
import zlib

import numpy as np
import pytest

import herceg as hg

DATA = {"first": [0, 2, 5], "second": [1, 3, 4], "height": [1, 2, 4], "unused": [4, 5, 6]}
LEAVES = ["a", "b", "c", "d"]


def tree(data=None, **options):
    return hg.Chart(DATA if data is None else data).dendrogram(
        "first", "second", "height", leaves=LEAVES, **options
    )


def test_spec_and_sent_columns():
    chart = tree(side="right", stroke="#ff0000", stroke_width=2, label="Rows", id="rows")
    spec, buffers = chart.to_spec()
    assert spec["version"] == 4  # New mark types already fail in readers lacking them.
    assert spec["marks"] == [
        {
            "type": "dendrogram",
            "first": "first",
            "second": "second",
            "height": "height",
            "leaves": LEAVES,
            "side": "right",
            "stroke": "#ff0000",
            "strokeWidth": 2,
            "label": "Rows",
            "id": "rows",
            "data": "data",
        }
    ]
    columns = spec["data"]["data"]["columns"]
    assert set(columns) == {"first", "second", "height"}
    for field in columns:
        assert np.frombuffer(buffers[columns[field]["buffer"]], dtype="<f8").tolist() == DATA[field]
    default, _ = tree().to_spec()
    assert "side" not in default["marks"][0]
    assert (
        hg.Chart().dendrogram("first", "second", "height", leaves=LEAVES, data=DATA).to_spec()[0]
        == default
    )


@pytest.mark.parametrize("side", ["bottom", "top", "left", "right"])
def test_static_svg_and_vector_pdf(side):
    chart = tree(side=side, stroke="#ff0000", label="Clustering")
    svg = chart.to_svg()
    path = re.search(r'<path[^>]*d="([^"]+)"[^>]*stroke="#ff0000"', svg)[1]
    assert path.count("M") == path.count("L") == 9
    pdf = chart.to_pdf()
    streams = re.findall(rb"stream\n(.*?)\nendstream", pdf, re.S)
    content = b"\n".join(zlib.decompress(stream) for stream in streams)
    assert b"1 0 0 RG" in content
    red = re.search(rb"q 1 0 0 RG (.*?)S\n", content, re.S)[1]
    assert len(re.findall(rb"\bm\n", red)) == 9
    assert len(re.findall(rb"\bl\n", red)) == 9


@pytest.mark.parametrize(
    "field, values, error",
    [
        ("first", [-1, 2, 5], 'row 0, field "first".*whole number'),
        ("second", [1.5, 3, 4], 'row 0, field "second".*whole number'),
        ("first", [4, 2, 5], 'row 0, field "first".*earlier merge'),
        ("second", [0, 3, 4], 'row 0, field "second".*more than once'),
        ("first", [0, 0, 5], 'row 1, field "first".*more than once'),
        ("height", [1, -1, 4], 'row 1, field "height".*nonnegative'),
        ("height", [1, np.nan, 4], 'row 1, field "height".*finite'),
        ("height", [1, np.inf, 4], 'row 1, field "height".*finite'),
    ],
)
def test_invalid_rows(field, values, error):
    with pytest.raises(ValueError, match=error):
        tree({**DATA, field: values})


def test_fields_and_leaf_labels():
    with pytest.raises(KeyError, match="dendrogram.*missing"):
        hg.Chart(DATA).dendrogram("missing", "second", "height", leaves=LEAVES)
    for first in (["a", "b", "c"], np.array([0, 2, 5], dtype="datetime64[ms]")):
        with pytest.raises(TypeError, match="first.*expected number"):
            tree({**DATA, "first": first})
    for leaves in (["a"], ["a", "b", "a", "d"], ["a", "b", 3, "d"], "abcd"):
        with pytest.raises((ValueError, TypeError), match="leaves"):
            hg.Chart(DATA).dendrogram("first", "second", "height", leaves=leaves)
    with pytest.raises(ValueError, match="side"):
        tree(side="diagonal")
    for stroke_width in (-1, np.inf, np.nan):
        with pytest.raises(ValueError, match="stroke_width"):
            tree(stroke_width=stroke_width)


def test_empty_single_merge_ties_and_inversions():
    single = hg.Chart({"first": [], "second": [], "height": []}).dendrogram(
        "first", "second", "height", leaves=["only"]
    )
    assert "only" in single.to_svg()
    for height in [0, 2]:
        hg.Chart({"first": [0], "second": [1], "height": [height]}).dendrogram(
            "first", "second", "height", leaves=["a", "b"]
        ).to_svg()
    for height in ([0, 0, 0], [2, 2, 2], [4, 2, 1]):
        assert tree({**DATA, "height": height}).to_svg().startswith("<svg")


def test_facets_require_repeat_and_resolve_categories():
    with pytest.raises(ValueError, match="repeat=True"):
        hg.Chart(DATA, facet="group").dendrogram("first", "second", "height", leaves=LEAVES)
    cells = {"x": ["a", "b"], "y": ["a", "b"], "v": [1, 2], "group": ["N", "S"]}
    chart = hg.Chart(cells, facet="group", resolve_x="independent", resolve_y="independent")
    chart.heatmap("x", "y", "v").dendrogram(
        "first", "second", "height", leaves=LEAVES, data=DATA, repeat=True
    )
    spec, _ = chart.to_spec()
    assert spec["marks"][1]["facet"] == "repeat"
    assert chart.to_svg().startswith("<svg")
    with pytest.raises(ValueError, match="categories of their own"):
        hg.Chart(DATA, panels=["tree"], resolve_x="independent", sync="tree").dendrogram(
            "first", "second", "height", leaves=LEAVES, panel="tree"
        )


def test_clustermap_panels():
    rows, columns = ["r3", "r1", "r2"], ["c", "d", "a", "b"]
    matrix = {
        "row": [r for r in rows for _ in columns],
        "column": columns * 3,
        "value": list(range(12)),
    }
    chart = hg.Chart(
        matrix,
        panels=[
            hg.Panel("corner", x=hg.Axis(show=False), y=hg.Axis(show=False)),
            hg.Panel("top", y=hg.Axis(show=False)),
            hg.Panel("left", x=hg.Axis(show=False)),
            hg.Panel("matrix"),
        ],
        panel_columns=2,
        panel_row_heights=[1, 4],
        panel_column_widths=[1, 4],
        resolve_x="columns",
        resolve_y="rows",
        width=800,
        height=600,
    )
    chart.heatmap("column", "row", "value", panel="matrix")
    chart.dendrogram(
        "first", "second", "height", leaves=LEAVES, data=DATA, side="bottom", panel="top"
    )
    chart.dendrogram(
        "first",
        "second",
        "height",
        leaves=["r1", "r2", "r3"],
        data={"first": [0, 2], "second": [1, 3], "height": [1, 3]},
        side="right",
        panel="left",
    )
    spec, _ = chart.to_spec()
    assert spec["grid"] == {"columns": 2, "rowHeights": [1, 4], "columnWidths": [1, 4]}
    assert spec["resolve"] == {"x": "columns", "y": "rows"}
    assert [m["panel"] for m in spec["marks"]] == ["matrix", "top", "left"]
    assert chart.to_svg().count('fill="none" stroke=') >= 2
    assert chart.to_pdf().startswith(b"%PDF")
