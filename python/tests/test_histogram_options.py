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


def test_histogram_defaults_and_false_flags_are_left_out():
    for options in ({}, {"common_norm": False, "cumulative": False, "dodge": False}):
        spec, _ = hg.Chart(DATA).histogram("v", **options).to_spec()
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
        ([], "histogram bins: expected 2 to 1001 edges; received 0"),
        ([0, 10**400], r"histogram bins\[1\]: expected a finite number"),
        ({"step": 10**400}, "histogram bins step: expected a positive number"),
        ({"step": 1, "start": 10**400}, "histogram bins start: expected a finite number"),
        (10**400, "histogram bins: expected a whole number of at least 1"),
        ([0], "histogram bins: expected 2 to 1001 edges; received 1"),
        ([1, 1], r"histogram bins\[1\]: expected an edge above the one before; received 1 after 1"),
        ([1, 0], r"histogram bins\[1\]: expected an edge above the one before; received 0 after 1"),
        ([0, np.nan], r"histogram bins\[1\]: expected a finite number"),
        ([0, np.inf], r"histogram bins\[1\]: expected a finite number"),
        ([0, "1"], r'histogram bins\[1\]: expected a finite number; received "1"'),
        ([False, True], r"histogram bins\[0\]: expected a finite number; received False"),
        (list(range(1002)), "histogram bins: expected 2 to 1001 edges; received 1002"),
        (np.array([[0, 1]]), "histogram bins: expected a 1-D array of edges"),
        (np.array(1), "histogram bins: expected a 1-D array of edges"),
        (0, "histogram bins: expected a whole number of at least 1; received 0"),
        ({"step": 0}, "histogram bins step: expected a positive number; received 0"),
        (
            {"step": 1, "start": np.inf},
            "histogram bins start: expected a finite number; received inf",
        ),
    ],
)
def test_histogram_refuses_invalid_edges(bins, message):
    with pytest.raises(ValueError, match=message):
        hg.histogram(DATA, "v", bins=bins)


@pytest.mark.parametrize(
    "options, message",
    [
        ({}, "histogram: needs exactly one of x and y"),
        ({"x": "v", "y": "v"}, "histogram: needs exactly one of x and y"),
        ({"y": "v", "axis": "right"}, r"histogram axis: a horizontal histogram \(y\) has no right"),
        ({"x": "v", "stack": True, "dodge": True}, "histogram dodge: dodge or stack, not both"),
        ({"x": "v", "normalize": "fraction"}, 'histogram normalize: .*; received "fraction"'),
        ({"x": "v", "common_norm": 1}, "histogram common_norm: expected True or False; received 1"),
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


def test_histogram_weights_steps_fills_and_frequency_serialize_and_draw():
    data = {"v": [0.1, 0.2, 0.3, 0.4], "w": [1.0, 2.0, 0.5, 4.0], "g": ["a", "b", "a", "b"]}
    chart = hg.histogram(
        data,
        "v",
        series="g",
        weight="w",
        normalize="frequency",
        stack="fill",
        element="step",
        bins=[0, 0.25, 0.5],
    )
    (mark,) = chart.to_spec()[0]["marks"]
    assert mark["weight"] == "w" and mark["normalize"] == "frequency"
    assert mark["stack"] == "fill" and mark["element"] == "step"
    assert "<path" in chart.to_svg()
    assert hg.Chart(data).histogram("v", stack=True).to_spec()[0]["marks"][0]["stack"] is True


@pytest.mark.parametrize(
    ("options", "message"),
    [
        ({"stack": "yes"}, 'histogram stack: expected True, False, or "fill"; received "yes"'),
        ({"stack": "fill", "dodge": True}, "histogram dodge: dodge or stack, not both"),
        ({"element": "line"}, 'histogram element: expected "bars", "step", or "poly"'),
        ({"dodge": True, "element": "step"}, "histogram dodge: places bars side by side"),
        ({"weight": "g"}, "histogram weight: column 'g' holds category values; expected number"),
        ({"normalize": "share"}, 'or "density"; received "share"'),
    ],
)
def test_histogram_new_option_errors(options, message):
    with pytest.raises((ValueError, TypeError), match=message):
        hg.Chart(DATA).histogram("v", series="g", **options)
