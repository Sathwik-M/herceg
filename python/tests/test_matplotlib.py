"""Matplotlib spellings get useful errors, and line styles remain portable."""

import inspect

import pytest

import herceg as hg
import herceg.express as hx

DATA = {"x": [0.0, 1.0], "y": [1.0, 2.0], "group": ["a", "b"]}


@pytest.mark.parametrize("surface", ["helper", "method"])
@pytest.mark.parametrize(
    ("mark", "foreign", "hint"),
    [
        ("area", "alpha", "did you mean 'fill_opacity'?"),
        ("line", "linewidth", "did you mean 'stroke_width'?"),
        ("line", "lw", "did you mean 'stroke_width'?"),
        ("line", "linestyle", "did you mean 'dash'?"),
        ("line", "ls", "did you mean 'dash'?"),
        ("scatter", "marker", "did you mean 'symbol'?"),
        ("scatter", "markersize", "did you mean 'radius'?"),
        ("scatter", "ms", "did you mean 'radius'?"),
        ("line", "color", "did you mean 'series' or 'stroke'?"),
        ("bar", "color", "did you mean 'series' or 'fill'?"),
        ("line", "c", "did you mean 'stroke'?"),
        ("bar", "c", "did you mean 'fill'?"),
        ("scatter", "c", "did you mean 'color' or 'stroke' or 'fill'?"),
        ("scatter", "edgecolor", "did you mean 'stroke'?"),
        ("scatter", "facecolor", "did you mean 'fill'?"),
        ("heatmap", "cmap", "did you mean 'colors'?"),
        ("heatmap", "vmin", "did you mean 'color_domain'?"),
        ("heatmap", "vmax", "did you mean 'color_domain'?"),
        ("histogram", "density", 'did you mean normalize="density"?'),
        ("line", "zorder", "marks draw in the order given; add the mark later to draw it on top"),
    ],
)
def test_matplotlib_option_errors_name_only_options_the_mark_takes(surface, mark, foreign, hint):
    name = "point" if surface == "method" and mark == "scatter" else mark
    function = getattr(hg, mark) if surface == "helper" else getattr(hg.Chart(DATA), name)
    with pytest.raises(TypeError) as error:
        # Unknown options are checked before columns or missing arguments.
        function(**{foreign: 1})
    assert str(error.value) == f"{name}: no option {foreign!r}; {hint}"
    for option in (
        "opacity",
        "fill_opacity",
        "stroke_width",
        "dash",
        "symbol",
        "radius",
        "size",
        "color",
        "stroke",
        "fill",
        "colors",
        "color_domain",
        "normalize",
    ):
        if repr(option) in hint or hint.startswith(f"did you mean {option}="):
            assert option in inspect.signature(function).parameters


@pytest.mark.parametrize("surface", ["helper", "method"])
@pytest.mark.parametrize(
    ("mark", "foreign"),
    [
        ("line", "alpha"),
        ("line", "marker"),
        ("line", "ms"),
        ("bar", "edgecolor"),
        ("bar", "linestyle"),
        ("pie", "label"),
        ("line", "cmap"),
        ("line", "vmin"),
        ("line", "vmax"),
        ("line", "density"),
    ],
)
def test_unavailable_equivalents_point_to_help(surface, mark, foreign):
    function = getattr(hg, mark) if surface == "helper" else getattr(hg.Chart(DATA), mark)
    help_name = f"Chart.{mark}" if surface == "method" else mark
    with pytest.raises(TypeError) as error:
        function(**{foreign: 1})
    assert str(error.value) == (
        f"{mark}: no option {foreign!r}; see help(herceg.{help_name}) for the options it takes"
    )


@pytest.mark.parametrize("axis", ["x", "y"])
def test_matplotlib_axis_limits_use_the_callers_axis_names(axis):
    for function, name, hint in [
        (hg.line, "line", f"did you mean {axis}_axis=hg.AxisOptions(domain=...)?"),
        (hg.Chart, "Chart", f"did you mean {axis}=hg.AxisOptions(domain=...)?"),
        (
            hg.Chart(DATA).line,
            "line",
            f"set the chart's domain with hg.Chart({axis}=hg.AxisOptions(domain=...))",
        ),
        (hx.histplot, "histplot", f"did you mean {axis}_axis=hg.AxisOptions(domain=...)?"),
    ]:
        with pytest.raises(TypeError) as error:
            function(data=DATA, x="x", y="y", **{f"{axis}lim": (0, 1)})
        assert str(error.value) == f"{name}: no option '{axis}lim'; {hint}"


@pytest.mark.parametrize(
    ("function", "foreign", "hint"),
    [
        (hx.histplot, "density", 'did you mean normalize="density"?'),
        (hx.histplot, "cmap", "did you mean 'colors'?"),
        (hx.lineplot, "hue", "did you mean 'series'?"),
        (hx.lineplot, "alpha", "see help(herceg.express.lineplot) for the options it takes"),
        (hx.pointplot, "marker", "see help(herceg.express.pointplot) for the options it takes"),
        (hx.barplot, "lw", "see help(herceg.express.barplot) for the options it takes"),
    ],
)
def test_express_uses_the_same_errors_with_its_own_supported_options(function, foreign, hint):
    with pytest.raises(TypeError) as error:
        function(DATA, x="x", y="y", **{foreign: 1})
    assert str(error.value) == f"{function.__name__}: no option {foreign!r}; {hint}"


STYLES = [("-", None), ("--", "7.4 3.2"), (":", "2 3.3"), ("-.", "12.8 3.2 2 3.2")]


@pytest.mark.parametrize(("style", "pattern"), STYLES)
@pytest.mark.parametrize("surface", ["helper", "line", "rule", "express"])
def test_dash_strings_serialize_and_render_with_scaled_widths(style, pattern, surface):
    if surface == "helper":
        chart = hg.line(DATA, "x", "y", dash=style, stroke_width=2)
    elif surface == "line":
        chart = hg.Chart(DATA).line("x", "y", dash=style, stroke_width=2)
    elif surface == "rule":
        chart = hg.Chart(DATA).rule(y=1, dash=style, stroke_width=2)
    else:
        chart = hx.pointplot(
            DATA,
            x="group",
            y="y",
            linestyle=style,
            errorbar=None,
            theme={"style": {"line": {"stroke_width": 2}}},
        )
    mark = next(m for m in chart.to_spec()[0]["marks"] if m["type"] in ("line", "rule"))
    assert mark["dash"] == style
    svg = chart.to_svg()
    if pattern is None:
        assert "stroke-dasharray" not in svg
    else:
        assert f'stroke-dasharray="{pattern}"' in svg


@pytest.mark.parametrize("bad", ["solid", "dashed", "none", "", "_", "__proto__"])
@pytest.mark.parametrize("surface", ["helper", "line", "rule"])
def test_dash_errors_list_all_accepted_strings(bad, surface):
    mark = "rule" if surface == "rule" else "line"
    with pytest.raises(ValueError) as error:
        if surface == "helper":
            hg.line(DATA, "x", "y", dash=bad)
        elif surface == "line":
            hg.Chart(DATA).line("x", "y", dash=bad)
        else:
            hg.Chart().rule(y=1, dash=bad)
    assert str(error.value).startswith(
        f'{mark} dash: expected an array or "-", "--", ":", or "-.";'
    )


def test_existing_labels_bins_and_pixel_dashes_are_kept():
    chart = hg.histogram(DATA, x="y", bins=2, normalize="density", label="Values")
    mark = chart.to_spec()[0]["marks"][0]
    assert mark["bins"] == 2 and mark["label"] == "Values"
    for chart in [
        hg.line(DATA, "x", "y", dash=[3, 2], stroke_width=4, label="Trend"),
        hg.Chart().rule(y=1, dash=[3, 2], stroke_width=4, label="Target"),
    ]:
        assert chart.to_spec()[0]["marks"][0]["dash"] == [3, 2]
        assert 'stroke-dasharray="3 2"' in chart.to_svg()
    assert "stroke_width" in inspect.signature(hg.Chart.line).parameters
    assert "x" in inspect.signature(hg.Chart).parameters
