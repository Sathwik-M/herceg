"""Range navigators: the spec they write, their checks, and their static output."""

import numpy as np
import pytest

import herceg as hg

DATA = {"t": np.arange(500, dtype=np.float64), "v": np.sin(np.arange(500) / 20)}


def test_a_navigator_travels_in_the_spec():
    spec, _ = hg.Chart(DATA, navigator=True).line("t", "v").to_spec()
    assert spec["navigator"] is True
    spec, _ = (
        hg.Chart(DATA, navigator=hg.Navigator(height=48, marks=["price"]))
        .line("t", "v", id="price")
        .to_spec()
    )
    assert spec["navigator"] == {"height": 48.0, "marks": ["price"]}
    # A dict of its fields, and the helpers' keyword.
    spec, _ = hg.line(DATA, x="t", y="v", navigator={"height": 30}).to_spec()
    assert spec["navigator"] == {"height": 30.0}
    for off in (False, None):
        spec, _ = hg.Chart(DATA, navigator=off).line("t", "v").to_spec()
        assert "navigator" not in spec
    assert hg.Navigator() == hg.Navigator(height=None, marks=None)
    spec, _ = hg.Chart(DATA, navigator=hg.Navigator()).line("t", "v").to_spec()
    assert spec["navigator"] is True


def test_navigator_options_are_checked():
    for height in (8, float("nan"), True, "40"):
        with pytest.raises(
            (ValueError, TypeError), match="Navigator height: expected at least 16 pixels"
        ):
            hg.Chart(DATA, navigator=hg.Navigator(height=height))  # type: ignore[arg-type]
    with pytest.raises(ValueError, match='Navigator marks: "a" is listed twice'):
        hg.Chart(DATA, navigator=hg.Navigator(marks=["a", "a"]))
    with pytest.raises(ValueError, match="Navigator marks: expected a list of mark ids"):
        hg.Chart(DATA, navigator=hg.Navigator(marks="a"))
    with pytest.raises(TypeError, match="Chart navigator: expected True, False, an hg.Navigator"):
        hg.Chart(DATA, navigator=40)  # type: ignore[arg-type]
    # One window shows one x range, which every panel must share.
    for resolution in ("independent", "rows", "columns"):
        for layout in ({"facet": "k"}, {"panels": ["a", "b"]}):
            with pytest.raises(
                ValueError,
                match=(
                    "Chart navigator: needs one x scale shared by every panel, and resolve_x is "
                    f'"{resolution}"; set resolve_x="shared" or drop navigator'
                ),
            ):
                hg.Chart(KEYED, navigator=True, resolve_x=resolution, **layout)  # type: ignore[arg-type]


KEYED = {**DATA, "k": ["a", "b"] * 250, "r": ["x"] * 250 + ["y"] * 250}


def test_facets_and_panels_take_a_navigator():
    spec, _ = (
        hg.Chart(KEYED, panels=["price", "volume"], navigator=hg.Navigator(marks=["close"]))
        .line("t", "v", id="close", panel="price")
        .bar("t", "v", panel="volume")
        .to_spec()
    )
    assert spec["navigator"] == {"marks": ["close"]}
    assert [panel["id"] for panel in spec["panels"]] == ["price", "volume"]
    for layout in ({"facet": "k", "facet_columns": 2}, {"facet_row": "r", "facet_column": "k"}):
        chart = hg.line(KEYED, x="t", y="v", navigator=True, resolve_x="shared", **layout)
        spec, _ = chart.to_spec()
        assert spec["navigator"] is True
        assert "facet" in spec


def test_static_output_draws_one_strip_under_every_panel():
    pytest.importorskip("py_mini_racer")
    chart = (
        hg.Chart(KEYED, width=500, height=360, panels=["price", "volume"], navigator=True)
        .line("t", "v", panel="price")
        .area("t", "v", panel="volume")
    )
    # Each panel's clipped data, and the strip's.
    assert chart.to_svg().count("<clipPath ") == 3
    facets = hg.line(KEYED, x="t", y="v", facet="k", width=500, height=360, navigator=True)
    assert facets.to_svg().count("<clipPath ") == 3


def test_static_output_draws_the_strip():
    pytest.importorskip("py_mini_racer")
    chart = hg.Chart(DATA, width=500, height=260, navigator=True).line("t", "v")
    svg = chart.to_svg()
    # The plot's and the strip's clipped data, and the strip's labels.
    assert svg.count("<clipPath ") == 2
    assert 'paint-order="stroke"' in svg
    assert chart.to_pdf()[:8] == b"%PDF-1.4"
    pytest.importorskip("resvg_py")
    assert chart.to_png()[:8] == b"\x89PNG\r\n\x1a\n"


def test_live_charts_add_and_remove_a_navigator():
    pytest.importorskip("anywidget")
    from herceg._live import LiveChart

    live = LiveChart(hg.Chart(DATA).line("t", "v"))
    message = live.update({"navigator": hg.Navigator(height=30)})
    assert message is not None
    assert message[0] == {"type": "options", "options": {"navigator": {"height": 30.0}}}
    assert live.to_spec()[0]["navigator"] == {"height": 30.0}
    message = live.update({"navigator": None})
    assert message is not None
    assert message[0]["options"] == {"navigator": None}
    # Charts with facets or panels take one too, under all their panels.
    for chart in (
        hg.Chart(KEYED, facet="k").line("t", "v"),
        hg.Chart(DATA, panels=["a"]).line("t", "v", panel="a"),
    ):
        faceted = LiveChart(chart)
        message = faceted.update({"navigator": True})
        assert message is not None
        assert message[0]["options"] == {"navigator": True}
        assert faceted.to_spec()[0]["navigator"] is True
