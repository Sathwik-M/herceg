"""Layouts of panels: columns, rows, grids, mosaics, insets, and panels'
legends, as the chart's methods build them and the spec carries them."""

from datetime import datetime, timedelta

import pytest

import herceg as hg

HOURS = [datetime(2026, 1, 1) + timedelta(hours=i) for i in range(24)]
DATA = {
    "time": HOURS * 2,
    "region": ["eu"] * 24 + ["us"] * 24,
    "p99": [120.0 + (i % 7) * 9 for i in range(48)],
    "errors": [float(i % 4) for i in range(48)],
    "requests": [900.0 + (i * 37) % 200 for i in range(48)],
}


def readme_chart() -> hg.Chart:
    """The layout of the README, as written there."""
    df = DATA
    chart = hg.Chart(df, height=600)
    left, right = chart.columns([2, 1])

    latency = left.panel("latency", weight=2, title="p99")
    latency.line(x="time", y="p99", color="region")

    errors = left.panel("errors", title="Errors")
    errors.bar(x="time", y="errors", color="region")

    right.panel("share", title="By region").pie("region", "requests")
    return chart


def test_the_readme_layout_draws_and_exports():
    chart = readme_chart()
    spec, _ = chart.to_spec()
    assert [panel["id"] for panel in spec["panels"]] == ["latency", "errors", "share"]
    layout = spec["layout"]
    assert (layout["type"], layout["columns"], layout["rows"]) == ("grid", [2.0, 1.0], [1.0])
    stack = layout["cells"][0]["content"]
    assert stack["rows"] == [2.0, 1.0]
    assert [cell["content"]["panel"] for cell in stack["cells"]] == ["latency", "errors"]
    assert {mark["panel"] for mark in spec["marks"]} == {"latency", "errors", "share"}
    assert chart.to_svg().startswith("<svg")
    assert chart.to_png().startswith(b"\x89PNG")
    assert chart.to_pdf().startswith(b"%PDF")


def test_cells_take_fixed_and_least_sizes_spans_and_nesting():
    chart = hg.Chart(DATA)
    grid = chart.grid(rows=[2, 1], columns=[hg.Pixels(220), hg.Weight(1, min=200)], gap=8)
    grid.cell(row=0, column=0).panel("latency").line(x="time", y="p99")
    grid.cell(row=1, column=0).panel("errors").bar(x="time", y="errors")
    right = grid.cell(row=0, column=1, row_span=2)
    top, bottom = right.rows([1, 1])
    top.panel("traffic").area(x="time", y="requests")
    bottom.panel("share").pie("region", "requests")
    spec, _ = chart.to_spec()
    layout = spec["layout"]
    assert layout["columns"] == [{"px": 220.0}, {"weight": 1.0, "min": 200.0}]
    assert layout["gap"] == 8
    assert layout["cells"][2] == {
        "row": 0,
        "column": 1,
        "rowSpan": 2,
        "content": layout["cells"][2]["content"],
    }
    assert layout["cells"][2]["content"]["type"] == "grid"
    assert "<svg" in chart.to_svg()
    # A cell holding panels takes no other layout.
    with pytest.raises(ValueError, match="already"):
        grid.cell(row=0, column=0).columns([1, 1])


def test_panels_without_ids_are_named_by_their_place():
    chart = hg.Chart(DATA)
    left, right = chart.columns(2)
    left.panel(title="First").line(x="time", y="p99")
    right.panel(title="Second").line(x="time", y="errors")
    spec, _ = chart.to_spec()
    assert [panel["id"] for panel in spec["panels"]] == ["panel-1", "panel-2"]


def test_mosaics_span_repeated_names_and_refuse_other_shapes():
    chart = hg.Chart(DATA)
    panels = chart.mosaic([["latency", "share"], ["errors", "share"]], rows=[2, 1])
    panels["latency"].line(x="time", y="p99", color="region")
    panels["errors"].bar(x="time", y="errors", color="region")
    panels["share"].pie("region", "requests")
    spec, _ = chart.to_spec()
    share = next(c for c in spec["layout"]["cells"] if c["content"]["panel"] == "share")
    assert share["rowSpan"] == 2
    with pytest.raises(ValueError, match="rectangle"):
        hg.Chart(DATA).mosaic([["a", "b"], ["b", "a"]])


def test_insets_draw_over_a_panel_with_an_indicator():
    chart = hg.Chart(DATA, height=500)
    [cell] = chart.columns([1])
    latency = cell.panel("latency", title="p99")
    latency.line(x="time", y="p99", color="region")
    detail = latency.inset(
        "detail",
        place=hg.Place(inside="top-right"),
        width=hg.Fraction(0.38),
        height=hg.Fraction(0.42),
        x=hg.AxisOptions(domain=(HOURS[4], HOURS[10])),
        indicator=True,
    )
    detail.line(x="time", y="p99", color="region")
    latency.legend(place=hg.Place(inside="top-left"))
    spec, _ = chart.to_spec()
    [inset] = spec["layout"]["cells"][0]["content"]["insets"]
    assert inset["panel"] == "detail"
    assert inset["width"] == {"fraction": 0.38} and inset["indicator"] is True
    assert spec["guides"][-1]["panel"] == "latency"
    svg = chart.to_svg()
    assert svg.count("<clipPath") >= 2
    assert chart.to_pdf().startswith(b"%PDF")


def test_layout_takes_a_grid_of_registered_panels():
    chart = hg.Chart(DATA, panels=[hg.Panel("a"), hg.Panel("b")], layout=hg.Grid(columns=2))
    chart.line(x="time", y="p99", panel="a").line(x="time", y="errors", panel="b")
    spec, _ = chart.to_spec()
    assert spec["layout"] == {"type": "grid", "columns": [1.0, 1.0]}


def test_a_cells_one_panel_keeps_a_fixed_or_least_size():
    chart = hg.Chart(DATA)
    left, right = chart.columns(2)
    left.panel("a", weight=hg.Pixels(80)).line(x="time", y="p99")
    right.panel("b").line(x="time", y="errors")
    spec, _ = chart.to_spec()
    [first, second] = spec["layout"]["cells"]
    assert first["content"] == {
        "type": "grid",
        "rows": [{"px": 80.0}],
        "columns": [1.0],
        "cells": [{"row": 0, "column": 0, "content": {"type": "panel", "panel": "a"}}],
    }
    assert second["content"] == {"type": "panel", "panel": "b"}


def test_listed_axes_repeat_on_every_panel():
    chart = hg.Chart(
        DATA,
        x=hg.AxisOptions(scope="chart"),
        guides=[hg.axis("x", place=hg.Place(side="top"), repeat="all")],
    )
    top, bottom = chart.rows(2)
    top.panel("a").line(x="time", y="p99")
    bottom.panel("b").line(x="time", y="errors")
    spec, _ = chart.to_spec()
    assert spec["guides"][0]["repeat"] == "all"
    assert chart.to_svg().startswith("<svg")
    with pytest.raises(ValueError, match="axis repeat"):
        hg.axis("x", repeat="every")


def test_widgets_keep_panels_legends_through_updates():
    chart = hg.Chart(DATA)
    left, right = chart.columns(2)
    latency = left.panel("latency")
    latency.line(x="time", y="p99", color="region")
    latency.legend(place=hg.Place(inside="top-left"))
    right.panel("errors").bar(x="time", y="errors", color="region")
    widget = chart.widget()

    def panels_legends():
        guides = widget._live.to_spec()[0].get("guides", [])
        return [guide["panel"] for guide in guides if "panel" in guide]

    assert panels_legends() == ["latency"]
    widget.update(title="Latency")
    assert panels_legends() == ["latency"]


def test_insets_go_over_insets():
    chart = hg.Chart(DATA, height=500)
    [cell] = chart.columns([1])
    main = cell.panel("main")
    main.line(x="time", y="p99")
    detail = main.inset("detail", width=hg.Fraction(0.6), height=hg.Fraction(0.6))
    detail.line(x="time", y="p99")
    detail.inset("closer", width=hg.Fraction(0.4)).line(x="time", y="p99")
    spec, _ = chart.to_spec()
    [outer] = spec["layout"]["cells"][0]["content"]["insets"]
    assert [inset["panel"] for inset in outer["insets"]] == ["closer"]
    assert chart.to_svg().startswith("<svg")


def test_panels_axes_take_neither_scope_nor_repeat():
    for name, value in (("scope", "chart"), ("repeat", "all")):
        chart = hg.Chart(DATA, panels=[hg.Panel("a", x=hg.AxisOptions(**{name: value}))])
        chart.line(x="time", y="p99", panel="a")
        with pytest.raises(ValueError, match=f"Panel x {name}: only the chart's x, y, and y_right"):
            chart.to_spec()


def test_a_refused_layout_leaves_the_chart_to_lay_out_again():
    chart = hg.Chart(DATA)
    with pytest.raises(ValueError):
        chart.columns(0)
    with pytest.raises(ValueError, match="Panel id"):
        chart.mosaic([["a", "*"]])
    left, right = chart.columns(2)
    left.panel("a").line(x="time", y="p99")
    right.panel("b").line(x="time", y="errors")
    spec, _ = chart.to_spec()
    assert [panel["id"] for panel in spec["panels"]] == ["a", "b"]


def test_a_refused_panel_leaves_its_cell_and_chart_as_they_were():
    chart = hg.Chart(DATA, zoom="y")
    left, _ = chart.columns(2)
    for _attempt in range(2):
        with pytest.raises(ValueError, match="zoom"):
            left.panel("a")
    assert chart._panels == [] and left._content is None
