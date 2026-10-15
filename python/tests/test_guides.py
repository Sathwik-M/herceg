"""Scales and guides in Python: ticks, formats, axes, legends, and colorbars,
their specs, their errors in Python's names, and their output."""

import datetime as dt

import pytest

import herceg as hg

HOURS = [dt.datetime(2026, 9, 28) + dt.timedelta(hours=i) for i in range(49)]
WEEK = {"t": HOURS, "v": [i % 7 for i in range(49)]}


def spec_of(chart: hg.Chart) -> dict:
    return {key: value for key, value in chart.to_spec()[0].items() if key != "data"}


def test_ticks_and_formats_write_the_specs_canonical_forms():
    chart = hg.Chart(
        WEEK,
        x=hg.AxisOptions(ticks=hg.Ticks(every="6 hours"), format=hg.Format(time="%H:%M")),
        y=hg.AxisOptions(ticks=hg.Ticks(values=[1, 5]), tooltip_format=hg.Format(number=".1f")),
    ).line(x="t", y="v")
    spec = spec_of(chart)
    assert spec["x"] == {
        "ticks": {"every": {"unit": "hour", "step": 6}},
        "format": {"time": "%H:%M"},
    }
    assert spec["y"] == {"ticks": {"values": [1.0, 5.0]}, "tooltipFormat": {"number": ".1f"}}
    # A count alone is the short form; elapsed time is a timedelta; times are epoch milliseconds.
    assert hg.Ticks(count=4)._spec() == 4
    assert hg.Ticks(every="day")._spec() == {"every": {"unit": "day"}}
    assert hg.Ticks(every=dt.timedelta(hours=6))._spec() == {"every": {"milliseconds": 21_600_000}}
    assert hg.Ticks(values=[dt.datetime(1970, 1, 2)])._spec() == {"values": [86_400_000]}


def test_ticks_and_formats_refuse_what_they_cannot_say_in_python_names():
    with pytest.raises(ValueError, match="Ticks: give one of count, every, or values"):
        hg.Ticks(count=4, every=2)
    with pytest.raises(
        ValueError, match="Ticks anchor: calendar steps start at calendar boundaries"
    ):
        hg.Ticks(every="day", anchor=3)
    with pytest.raises(ValueError, match='Ticks every: "fortnight" is not a time interval'):
        hg.Ticks(every="fortnight")._spec()
    with pytest.raises(ValueError, match="Format: give number or time, one of them"):
        hg.Format()
    with pytest.raises(ValueError, match='Format number: ",.2q" is not a number pattern'):
        hg.Format(number=",.2q")
    with pytest.raises(ValueError, match='Format time: "%U" at character 4 of "%H %U"'):
        hg.Format(time="%H %U")
    with pytest.raises(TypeError, match="AxisOptions format: Python functions cannot travel"):
        hg.Chart(WEEK, y=hg.AxisOptions(format=lambda v: str(v))).line(x="t", y="v").to_spec()


def test_scales_and_guides_write_their_specs():
    chart = (
        hg.Chart(
            WEEK,
            scales={"y_right": hg.Scale(domain=(0, 10)), "y": {"zero": False}},
            guides=[
                hg.axis(
                    "x",
                    tick=hg.Tick(direction="in", length=6),
                    labels=hg.TickLabels(rotation=[0, -45], collision="hide"),
                    layers=[
                        hg.TickLayer(
                            id="day",
                            ticks=hg.Ticks(every="day"),
                            format=hg.Format(time="%b %-d"),
                            labels=hg.TickLabels(row=1),
                        )
                    ],
                ),
                hg.axis("y_right", line=True),
                hg.legend(scales=[hg.ScaleRef(mark="a", channel="series")], columns=3),
                hg.colorbar(place=hg.Place(side="bottom"), ticks=5),
            ],
        )
        .line(x="t", y="v", id="a")
        .line(x="t", y="v", axis="right", legend=False)
    )
    spec = spec_of(chart)
    assert spec["scales"] == {"yRight": {"domain": [0.0, 10.0]}, "y": {"zero": False}}
    axis, right, legend, colorbar = spec["guides"]
    assert axis == {
        "type": "axis",
        "scale": "x",
        "tick": {"direction": "in", "length": 6},
        "labels": {"rotation": {"candidates": [0, -45]}, "collision": "hide"},
        "layers": [
            {
                "id": "day",
                "ticks": {"every": {"unit": "day"}},
                "format": {"time": "%b %-d"},
                "labels": {"row": 1},
            }
        ],
    }
    assert right == {"type": "axis", "scale": "yRight", "line": True}
    assert legend == {
        "type": "legend",
        "columns": 3,
        "scales": [{"mark": "a", "channel": "series"}],
    }
    assert colorbar == {"type": "colorbar", "place": {"side": "bottom"}, "ticks": 5}
    assert spec["marks"][1]["legend"] is False


def test_guides_refuse_what_they_cannot_say_in_python_names():
    with pytest.raises(
        ValueError, match='axis scale: expected "x", "y", or "y_right"; received "z"'
    ):
        hg.axis("z")
    with pytest.raises(ValueError, match='TickLayer id: expected a name other than "" and "major"'):
        hg.TickLayer(id="major")
    with pytest.raises(ValueError, match="legend rows: columns or rows, not both"):
        hg.Chart(WEEK, guides=[hg.legend(columns=2, rows=2)]).line(x="t", y="v").to_spec()
    with pytest.raises(TypeError, match=r"Chart guides\[0\]: expected hg.axis\(...\)"):
        hg.Chart(WEEK, guides=[{"type": "axis"}]).line(x="t", y="v").to_spec()
    with pytest.raises(
        ValueError, match="Chart scales temperature: expected an hg.OrdinalScale, a scale of"
    ):
        hg.Chart(WEEK, scales={"temperature": hg.Scale()}).line(x="t", y="v").to_spec()
    with pytest.raises(ValueError, match="line legend: expected False"):
        hg.Chart(WEEK).line(x="t", y="v", legend=True)
    with pytest.raises(ValueError, match="LegendEntry: a swatch or a sample, not both"):
        hg.LegendEntry(key="a", label="A", swatch=hg.Swatch(type="rect", fill="#eee"), sample="a")
    with pytest.raises(
        ValueError, match='axis place: y_right axes go on the "right" side; received "left"'
    ):
        hg.axis("y_right", place=hg.Place(side="left"))
    with pytest.raises(ValueError, match='Ticks every: "0 hours" steps by 0; give a count of 1'):
        hg.Ticks(every="0 hours")._spec()
    with pytest.raises(ValueError, match="TickLabels rotation: expected degrees from -90"):
        hg.TickLabels(rotation=[0, 270])
    with pytest.raises(ValueError, match='Swatch size: a rect swatch takes "fill", "stroke", or'):
        hg.Swatch(type="rect", fill="#eee", size=4)


def test_scales_scope_the_chart_as_the_short_forms_do():
    from herceg._chart import axis_scope

    settings = {"x": hg.AxisOptions(scope="chart"), "scales": {"x": hg.Scale(scope="panel")}}
    assert axis_scope(settings, "x") == "panel"
    assert axis_scope({"scales": {"y": {"scope": "row"}}}, "y") == "row"
    assert axis_scope({"x": {"scope": "column"}}, "x") == "column"
    with pytest.raises(ValueError, match="Chart navigator: needs one x scale shared by every"):
        hg.Chart(
            WEEK,
            panels=[hg.Panel(id="a"), hg.Panel(id="b")],
            scales={"x": hg.Scale(scope="panel")},
            navigator=True,
        )


def test_axes_with_layers_and_other_sides_render():
    chart = hg.Chart(
        WEEK,
        width=640,
        height=320,
        time_zone="UTC",
        x=hg.AxisOptions(ticks=hg.Ticks(every="6 hours"), format=hg.Format(time="%H:%M")),
        guides=[
            hg.axis(
                "x",
                layers=[
                    hg.TickLayer(
                        id="day",
                        ticks=hg.Ticks(every="day"),
                        format=hg.Format(time="%b %-d"),
                        labels=hg.TickLabels(row=1),
                    )
                ],
            ),
            hg.axis("y", place=hg.Place(side="right")),
        ],
    ).line(x="t", y="v")
    svg = chart.to_svg()
    assert ">06:00<" in svg and ">Sep 29<" in svg
    assert chart.to_pdf()[:5] == b"%PDF-"


def test_legends_and_colorbars_render():
    sites = hg.Chart(
        {"t": [0, 1, 0, 1], "site": ["A", "A", "B", "B"], "v": [1, 2, 3, 4]},
        width=480,
        height=300,
        legend=hg.LegendOptions(columns=2, title="Sites", place=hg.Place(side="bottom")),
    ).line(x="t", y="v", series="site")
    assert ">Sites<" in sites.to_svg()
    cells = hg.Chart(
        {"x": [0, 1, 0, 1], "y": ["a", "a", "b", "b"], "v": [-8.55, 2, 5, 12.3]},
        width=480,
        height=300,
        guides=[hg.colorbar(title="Gain", format=hg.Format(number="+.0f"))],
    ).heatmap(x="x", y="y", color="v")
    svg = cells.to_svg()
    assert ">Gain<" in svg and ">+10<" in svg and 'y1="1"' in svg
