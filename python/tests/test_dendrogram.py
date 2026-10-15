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
        ("first", [-1, 2, 5], "dendrogram first, row 0: expected a whole number.*received -1"),
        ("second", [1.5, 3, 4], "dendrogram second, row 0: expected a whole number.*received 1.5"),
        ("first", [4, 2, 5], "dendrogram first, row 0: .*or an earlier merge; received 4"),
        ("second", [0, 3, 4], "dendrogram second, row 0: cluster 0 is merged more than once"),
        ("first", [0, 0, 5], "dendrogram first, row 1: cluster 0 is merged more than once"),
        ("height", [1, -1, 4], "dendrogram height, row 1: expected a finite height.*received -1"),
        (
            "height",
            [1, np.nan, 4],
            "dendrogram height, row 1: expected a finite height.*received nan",
        ),
        (
            "height",
            [1, np.inf, 4],
            "dendrogram height, row 1: expected a finite height.*received inf",
        ),
    ],
)
def test_invalid_rows(field, values, error):
    with pytest.raises(ValueError, match=error):
        tree({**DATA, field: values})


def test_fields_and_leaf_labels():
    with pytest.raises(KeyError, match="dendrogram first: no column 'missing'"):
        hg.Chart(DATA).dendrogram("missing", "second", "height", leaves=LEAVES)
    for first in (["a", "b", "c"], np.array([0, 2, 5], dtype="datetime64[ms]")):
        with pytest.raises(
            TypeError, match="dendrogram first: column 'first' holds .* values; expected number"
        ):
            tree({**DATA, "first": first})
    for leaves in (["a"], ["a", "b", "a", "d"], ["a", "b", 3, "d"], "abcd"):
        with pytest.raises((ValueError, TypeError), match="dendrogram leaves"):
            hg.Chart(DATA).dendrogram("first", "second", "height", leaves=leaves)
    with pytest.raises(
        ValueError, match='dendrogram side: expected "bottom", .*; received "diagonal"'
    ):
        tree(side="diagonal")
    for stroke_width in (-1, np.inf, np.nan):
        with pytest.raises(
            ValueError, match="dendrogram stroke_width: expected a finite number of at least 0"
        ):
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


def test_facets_require_repeat_and_scope_categories():
    with pytest.raises(
        ValueError,
        match='dendrogram facet: a tree cannot be split across facet panels; give facet="repeat"',
    ):
        hg.Chart(DATA, facet="group").dendrogram("first", "second", "height", leaves=LEAVES)
    cells = {"x": ["a", "b"], "y": ["a", "b"], "v": [1, 2], "group": ["N", "S"]}
    chart = hg.Chart(
        cells, facet="group", x=hg.AxisOptions(scope="panel"), y=hg.AxisOptions(scope="panel")
    )
    chart.heatmap("x", "y", "v").dendrogram(
        "first", "second", "height", leaves=LEAVES, data=DATA, facet="repeat"
    )
    spec, _ = chart.to_spec()
    assert spec["marks"][1]["facet"] == "repeat"
    assert chart.to_svg().startswith("<svg")
    with pytest.raises(
        ValueError, match=r"Chart sync: panels with categories of their own \(x scope"
    ):
        hg.Chart(DATA, panels=["tree"], x=hg.AxisOptions(scope="panel"), sync="tree").dendrogram(
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
            hg.Panel("corner", x=hg.AxisOptions(show=False), y=hg.AxisOptions(show=False)),
            hg.Panel("top", y=hg.AxisOptions(show=False)),
            hg.Panel("left", x=hg.AxisOptions(show=False)),
            hg.Panel("matrix"),
        ],
        panel_columns=2,
        panel_row_heights=[1, 4],
        panel_column_widths=[1, 4],
        x=hg.AxisOptions(scope="column"),
        y=hg.AxisOptions(scope="row"),
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
    assert (spec["x"], spec["y"]) == ({"scope": "column"}, {"scope": "row"})
    assert [m["panel"] for m in spec["marks"]] == ["matrix", "top", "left"]
    assert chart.to_svg().count('fill="none" stroke=') >= 2
    assert chart.to_pdf().startswith(b"%PDF")
