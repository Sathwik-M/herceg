import json

import numpy as np
import pytest

import herceg as hg

DATA = {"v": [0.1, 0.2, 0.3, 0.4], "g": ["a", "a", "b", "b"]}


@pytest.mark.parametrize("orientation", [{"x": "v"}, {"y": "v"}])
@pytest.mark.parametrize(
    "edges", [[0.1, 0.2, 0.1 + 2 * 0.1, 0.4], (0.1, 0.2, 0.4), np.array([0.1, 0.2, 0.4])]
)
def test_histogram_edges_and_options_serialize(orientation, edges):
    chart = hg.histogram(
        DATA,
        **orientation,
        bins=edges,
        series="g",
        normalize="probability",
        common_norm=True,
        cumulative=True,
        dodge=True,
    )
    spec, _ = chart.to_spec()
    assert spec["version"] == 10
    assert spec["marks"] == [
        {
            "type": "histogram",
            "data": "data",
            **orientation,
            "bins": list(edges),
            "series": "g",
            "normalize": "probability",
            "commonNorm": True,
            "cumulative": True,
            "dodge": True,
        }
    ]
    assert json.loads(json.dumps(spec))["marks"][0]["bins"] == list(edges)
    assert "<path" in chart.to_svg()


@pytest.mark.parametrize(
    "options",
    [
        {"y": "v"},
        {"x": "v", "bins": [0, 1]},
        {"x": "v", "normalize": "probability"},
        {"x": "v", "common_norm": True},
        {"x": "v", "cumulative": True},
        {"x": "v", "dodge": True},
    ],
)
def test_histogram_features_need_version_eight(options):
    assert hg.histogram(DATA, **options).to_spec()[0]["version"] == 10


def test_histogram_defaults_and_false_flags_keep_version():
    for options in ({}, {"common_norm": False, "cumulative": False, "dodge": False}):
        spec, _ = hg.Chart(DATA).histogram("v", **options).to_spec()
        assert spec["version"] == 4
        assert spec["marks"] == [{"type": "histogram", "data": "data", "x": "v"}]


def test_histogram_edges_are_copied_and_numpy_numbers_become_json_numbers():
    edges = np.array([0, 1, 3], dtype=np.int64)
    chart = hg.Chart(DATA).histogram(y="v", bins=edges)
    edges[1] = 2
    bins = chart.to_spec()[0]["marks"][0]["bins"]
    assert bins == [0, 1, 3]
    assert all(type(value) is float for value in bins)
    json.dumps(bins)
    assert hg.histogram(DATA, "v", bins=np.int64(2)).to_spec()[0]["marks"][0]["bins"] == 2


@pytest.mark.parametrize(
    "bins, message",
    [
        ([], "at least 2"),
        ([0, 10**400], "finite"),
        ({"step": 10**400}, "positive"),
        ({"step": 1, "start": 10**400}, "finite"),
        (10**400, "at least 1"),
        ([0], "at least 2"),
        ([1, 1], "strictly increasing"),
        ([1, 0], "strictly increasing"),
        ([0, np.nan], "finite"),
        ([0, np.inf], "finite"),
        ([0, "1"], "finite"),
        ([False, True], "finite"),
        (list(range(1002)), "at most 1001"),
        (np.array([[0, 1]]), "1-D"),
        (np.array(1), "1-D"),
        (0, "at least 1"),
        ({"step": 0}, "positive"),
        ({"step": 1, "start": np.inf}, "finite"),
    ],
)
def test_histogram_refuses_invalid_edges(bins, message):
    with pytest.raises(ValueError, match=message):
        hg.histogram(DATA, "v", bins=bins)


@pytest.mark.parametrize(
    "options, message",
    [
        ({}, "exactly one field"),
        ({"x": "v", "y": "v"}, "exactly one field"),
        ({"y": "v", "axis": "right"}, "horizontal histogram cannot use the right axis"),
        ({"x": "v", "stack": True, "dodge": True}, "cannot dodge and stack"),
        ({"x": "v", "normalize": "fraction"}, "normalize"),
        ({"x": "v", "common_norm": 1}, "boolean"),
    ],
)
def test_histogram_refuses_invalid_options(options, message):
    with pytest.raises(ValueError, match=message):
        hg.histogram(DATA, **options)


def test_histogram_checks_binned_column_kinds():
    with pytest.raises(TypeError, match="histogram y.*category"):
        hg.histogram(DATA, y="g")
    with pytest.raises(TypeError, match="histogram x.*category"):
        hg.histogram(DATA, x="g")


@pytest.mark.parametrize("histogram_first", [False, True])
def test_histogram_version_composes_with_boxplot_and_seams(histogram_first):
    data = {
        "v": [1, 2],
        "g": ["a", "b"],
        "t": np.array(["2026-01-01", "2026-01-02"], dtype="datetime64[ms]"),
    }
    chart = hg.Chart(data, x=hg.Axis(breaks=[hg.Break(weekdays=["sat", "sun"])], seams=True))
    if histogram_first:
        chart.histogram("v", cumulative=True).boxplot("g", "v", notch=True)
    else:
        chart.boxplot("g", "v", notch=True).histogram("v", cumulative=True)
    assert chart.to_spec()[0]["version"] == 10


def test_horizontal_time_histogram_and_static_exports():
    start = 1767225600000
    data = {"t": np.array(["2026-01-01", "2026-01-02"], dtype="datetime64[ms]")}
    chart = hg.histogram(
        data, y="t", bins=[start, start + 86400000, start + 172800000], time_zone="UTC"
    )
    assert "Jan 2" in chart.to_svg()
    assert chart.to_pdf().startswith(b"%PDF-")


def test_horizontal_histograms_with_facets_and_subplots():
    facets = hg.Chart(DATA, facet="g", resolve_y="independent").histogram(
        y="v", bins=[0, 0.2, 0.5], common_norm=True
    )
    assert facets.to_spec()[0]["resolve"] == {"y": "independent"}
    assert facets.to_svg().count("<clipPath") == 2
    subplots = hg.Chart(DATA, panels=["p", "q"]).histogram(y="v", bins=[0, 0.2, 0.5], panel="*")
    assert subplots.to_spec()[0]["marks"][0]["panel"] == "*"
    assert "<path" in subplots.to_svg()
