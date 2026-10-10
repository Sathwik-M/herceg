"""herceg.express: statistical charts in one call, made of herceg's marks."""

import json
import math
import re
import warnings
from pathlib import Path
from typing import Any

import numpy as np
import pytest

import herceg as hg
import herceg.express as hx

RNG = np.random.default_rng(7)
N = 240
TIPS = {
    "day": RNG.choice(["thu", "fri", "sat", "sun"], N),
    "sex": RNG.choice(["female", "male"], N),
    "size": RNG.integers(1, 5, N).astype(float),
    "tip": np.round(RNG.gamma(2.0, 1.5, N), 2),
    "bill": np.round(RNG.uniform(5, 50, N), 2),
}


def marks(chart):
    return chart.to_spec()[0]["marks"]


def table(chart, index=0):
    spec, _ = chart.to_spec()
    return spec["data"][marks(chart)[index]["data"]]["columns"]


# Estimates -------------------------------------------------------------------------


def test_barplot_draws_bars_and_dodged_error_bars_of_one_legend_group():
    chart = hx.barplot(TIPS, x="day", y="tip", series="sex", seed=3)
    bars, errors = marks(chart)
    assert bars == {
        "type": "bar",
        "x": "day",
        "y": "tip",
        "series": "sex",
        "legendGroup": "series",
        "data": "data",
    }
    assert errors["dodge"] is True and errors["legendGroup"] == "series"
    spec, _ = chart.to_spec()
    assert spec["x"]["title"] == "day" and spec["y"]["title"] == "tip"
    assert "95% bootstrap confidence intervals (1,000 resamples, seed 3" in spec["description"]
    stats = hx.statistics(chart)
    assert stats.function == "barplot" and stats.seed == 3 and stats.dropped == 0
    estimates = stats.tables["estimates"]
    assert set(estimates) == {"sex", "day", "tip", "low", "high", "n"}
    assert estimates["n"].sum() == N
    assert "<svg" in chart.to_svg()


def test_barplot_estimates_match_seaborn_group_by_group():
    pd = pytest.importorskip("pandas")
    statistics = pytest.importorskip("seaborn._statistics")
    frame = pd.DataFrame(TIPS)
    for estimator, errorbar in (("mean", ("ci", 95)), ("median", ("pi", 50)), ("mean", ("se", 2))):
        chart = hx.barplot(
            frame, x="day", y="tip", series="sex", estimator=estimator, errorbar=errorbar, seed=11
        )
        estimates = hx.statistics(chart).tables["estimates"]
        aggregate = statistics.EstimateAggregator(estimator, errorbar, n_boot=1000, seed=11)
        for i in range(len(estimates["n"])):
            rows = frame[
                (frame["day"] == estimates["day"][i]) & (frame["sex"] == estimates["sex"][i])
            ]
            expected = aggregate(rows, "tip")
            assert estimates["tip"][i] == pytest.approx(expected["tip"], rel=1e-12)
            assert estimates["low"][i] == pytest.approx(expected["tipmin"], rel=1e-12)
            assert estimates["high"][i] == pytest.approx(expected["tipmax"], rel=1e-12)


def test_category_order_and_horizontal_bars():
    chart = hx.barplot(TIPS, x="tip", y="day", order=["sun", "sat", "fri"], errorbar=None)
    (bars,) = marks(chart)
    assert bars["x"] == "tip" and bars["y"] == "day"
    days = table(chart)["day"]
    assert days["dictionary"] == ["sun", "sat", "fri"]
    stats = hx.statistics(chart)
    assert list(stats.tables["estimates"]["day"]) == ["sun", "sat", "fri"]
    # Thursday is not in the order: its rows are left out, and said so.
    assert stats.dropped == int(np.sum(TIPS["day"] == "thu"))
    assert "were left out" in stats.description
    assert stats.seed is None


def test_number_series_are_categories_in_ascending_order():
    chart = hx.pointplot(TIPS, x="day", y="tip", series="size", dodge=True, errorbar=("sd", 1))
    points, errors, lines = marks(chart)
    assert points["dodge"] is True and errors["dodge"] is True and lines["dodge"] is True
    assert table(chart)["size"]["dictionary"] == ["1", "2", "3", "4"]
    assert "±1 standard deviation" in chart.to_spec()[0]["description"]


def test_orders_of_numbers_and_times_name_levels_by_value():
    data = {"size": [1.0, 2.0, 2.0, 3.0], "tip": [1.0, 2.0, 3.0, 4.0]}
    chart = hx.barplot(data, x="size", y="tip", order=[3, 1.0], errorbar=None)
    assert list(hx.statistics(chart).tables["estimates"]["size"]) == ["3", "1"]
    days = np.array(["2026-01-02", "2026-01-01"], dtype="datetime64[ms]")
    chart = hx.barplot({"day": days, "v": [1.0, 2.0]}, x="day", y="v", errorbar=None)
    assert list(hx.statistics(chart).tables["estimates"]["day"]) == ["2026-01-01", "2026-01-02"]
    ordered = hx.barplot(
        {"day": days, "v": [1.0, 2.0]}, x="day", y="v", order=[days[0]], errorbar=None
    )
    assert list(hx.statistics(ordered).tables["estimates"]["day"]) == ["2026-01-02"]


def test_seeds_are_drawn_and_recorded_when_not_given():
    first = hx.barplot(TIPS, x="day", y="tip")
    seed = hx.statistics(first).seed
    assert isinstance(seed, int) and f"seed {seed}" in first.to_spec()[0]["description"]
    again = hx.barplot(TIPS, x="day", y="tip", seed=seed)
    assert np.array_equal(
        hx.statistics(first).tables["estimates"]["low"],
        hx.statistics(again).tables["estimates"]["low"],
    )


def test_lineplot_aggregates_x_values_with_a_band_per_series():
    t = np.repeat(np.arange(10.0), 6)
    data = {"t": t, "g": np.tile(["a", "b"], 30), "v": np.sin(t) + RNG.normal(0, 0.1, 60)}
    chart = hx.lineplot(data, x="t", y="v", series="g", seed=1)
    band_a, band_b, line = marks(chart)
    assert [band_a["label"], band_b["label"]] == ["a", "b"]
    assert band_a["type"] == "area" and band_a["legendGroup"] == line["legendGroup"] == "series"
    assert line["series"] == "g"
    estimates = hx.statistics(chart).tables["estimates"]
    assert len(estimates["t"]) == 20 and estimates["n"].tolist() == [3.0] * 20
    raw = hx.lineplot(data, x="t", y="v", series="g", estimator=None, errorbar=None)
    assert [mark["type"] for mark in marks(raw)] == ["line"]
    with pytest.raises(ValueError, match="lineplot errorbar: intervals require an estimator; "):
        hx.lineplot(data, x="t", y="v", estimator=None)
    bars = hx.lineplot(data, x="t", y="v", error_style="bars", errorbar=("se", 1))
    assert [mark["type"] for mark in marks(bars)] == ["errorbar", "line"]
    with pytest.raises(ValueError, match='lineplot error_style: expected "band" or "bars"'):
        hx.lineplot(data, x="t", y="v", error_style="ci")  # type: ignore[arg-type]


def test_lineplot_keeps_time_x():
    stamps = np.array(["2026-01-01", "2026-01-01", "2026-01-02"], dtype="datetime64[ms]")
    chart = hx.lineplot({"t": stamps, "v": [1.0, 3.0, 5.0]}, x="t", y="v", errorbar=None)
    assert table(chart)["t"]["type"] == "time"
    assert hx.statistics(chart).tables["estimates"]["v"].tolist() == [2.0, 5.0]


# Fits ------------------------------------------------------------------------------


def test_regplot_fits_a_line_with_a_bootstrap_band_per_series():
    x = RNG.uniform(0, 10, 80)
    data = {"x": x, "y": 2 * x + RNG.normal(0, 1, 80), "g": np.repeat(["a", "b"], 40)}
    chart = hx.regplot(data, x="x", y="y", series="g", seed=5)
    kinds = [mark["type"] for mark in marks(chart)]
    assert kinds == ["point", "area", "area", "line"]
    stats = hx.statistics(chart)
    coefficients = stats.tables["coefficients"]
    for group, rows in enumerate((slice(0, 40), slice(40, 80))):
        slope, intercept = np.polyfit(x[rows], data["y"][rows], 1)
        assert coefficients["x^1"][group] == pytest.approx(slope, rel=1e-9)
        assert coefficients["x^0"][group] == pytest.approx(intercept, rel=1e-9)
    fit = stats.tables["fit"]
    assert np.all(fit["low"] <= fit["y"]) and np.all(fit["y"] <= fit["high"])
    assert "seed 5" in stats.description


def test_regplot_lowess_and_polynomials():
    x = np.linspace(0, 6, 50)
    data = {"x": x, "y": np.sin(x)}
    lowess = hx.regplot(data, x="x", y="y", lowess=True)
    assert [mark["type"] for mark in marks(lowess)] == ["point", "line"]
    assert hx.statistics(lowess).seed is None
    assert "lowess" in hx.statistics(lowess).description
    curved = hx.regplot(data, x="x", y="y", order=3, ci=None, scatter=False, grid_size=20)
    assert [mark["type"] for mark in marks(curved)] == ["line"]
    assert len(hx.statistics(curved).tables["fit"]["x"]) == 20
    with pytest.raises(ValueError, match="no polynomial order"):
        hx.regplot(data, x="x", y="y", lowess=True, order=2)
    one = hx.regplot({"x": [1.0, 1.0], "y": [2.0, 3.0]}, x="x", y="y")
    assert "had no fit" in hx.statistics(one).description


def test_residplot_draws_residuals_around_zero():
    x = np.linspace(0, 10, 40)
    data = {"x": x, "y": 3 + 2 * x + np.sin(x)}
    chart = hx.residplot(data, x="x", y="y", lowess=True)
    rule, points, line = marks(chart)
    assert rule["type"] == "rule" and rule["y"] == 0
    assert points["type"] == "point" and line["type"] == "line"
    residuals = hx.statistics(chart).tables["residuals"]["residual"]
    slope, intercept = np.polyfit(x, data["y"], 1)
    assert np.allclose(residuals, data["y"] - (slope * x + intercept), atol=1e-9)


# Inputs and edge cases ---------------------------------------------------------------


def test_missing_values_are_left_out_and_counted():
    data = {
        "day": ["thu", None, "fri", "fri", "thu"],
        "tip": [1.0, 2.0, float("nan"), 4.0, 5.0],
    }
    chart = hx.barplot(data, x="day", y="tip", errorbar=None)
    stats = hx.statistics(chart)
    assert stats.dropped == 2
    assert stats.tables["estimates"]["tip"].tolist() == [3.0, 4.0]
    assert "2 rows missing day or tip were left out." in stats.description


def test_one_value_groups_have_no_interval_and_empty_data_draws_nothing():
    chart = hx.barplot({"day": ["thu"], "tip": [2.0]}, x="day", y="tip", seed=1)
    estimates = hx.statistics(chart).tables["estimates"]
    assert estimates["tip"].tolist() == [2.0] and math.isnan(estimates["low"][0])
    assert "<svg" in chart.to_svg()
    empty = hx.barplot({"day": [], "tip": []}, x="day", y="tip", seed=1)
    assert len(hx.statistics(empty).tables["estimates"]["tip"]) == 0
    assert "<svg" in empty.to_svg()


@pytest.mark.parametrize("library", ["pandas", "polars", "pyarrow"])
def test_dataframes_of_every_kind(library):
    module = pytest.importorskip(library)
    if library == "pyarrow":
        frame = module.table(TIPS)
    else:
        frame = module.DataFrame(TIPS)
    chart = hx.barplot(frame, x="day", y="tip", series="sex", seed=2)
    reference = hx.barplot(TIPS, x="day", y="tip", series="sex", seed=2)
    ours, theirs = (
        hx.statistics(chart).tables["estimates"],
        hx.statistics(reference).tables["estimates"],
    )
    for name in ("tip", "low", "high"):
        assert np.allclose(ours[name], theirs[name])


def test_pandas_categoricals_keep_their_order():
    pd = pytest.importorskip("pandas")
    frame = pd.DataFrame(TIPS)
    frame["day"] = pd.Categorical(frame["day"], categories=["thu", "fri", "sat", "sun"])
    chart = hx.barplot(frame, x="day", y="tip", errorbar=None)
    assert table(chart)["day"]["dictionary"] == ["thu", "fri", "sat", "sun"]


def test_facets_palette_and_options_pass_through():
    chart = hx.barplot(
        TIPS,
        x="day",
        y="tip",
        facet_column="sex",
        palette=["#111111", "#222222"],
        title="Tips",
        width=500,
        theme="dark",
        errorbar=None,
    )
    spec, _ = chart.to_spec()
    assert spec["facet"] == {"column": "sex"}
    assert spec["theme"] == {"palette": ["#111111", "#222222"], "extends": "dark"}
    assert spec["title"] == "Tips" and spec["width"] == 500
    with pytest.raises(ValueError, match="barplot facet: express computes statistics per panel"):
        hx.barplot(TIPS, x="day", y="tip", facet_column="sex", facet="day")
    described = hx.barplot(TIPS, x="day", y="tip", description="Tips by day.", errorbar=None)
    assert described.to_spec()[0]["description"].startswith("Tips by day. Bars show")


def test_mistakes_are_refused_with_the_column_or_option_named():
    with pytest.raises(KeyError, match="no column 'tips'"):
        hx.barplot(TIPS, x="day", y="tips")
    with pytest.raises(TypeError, match="holds category values; expected number"):
        hx.barplot(TIPS, x="day", y="sex")
    with pytest.raises(ValueError, match="barplot errorbar: expected the method"):
        hx.barplot(TIPS, x="day", y="tip", errorbar=("iqr", 50))
    with pytest.raises(
        ValueError, match="barplot errorbar: expected a ci level from above 0 to 100"
    ):
        hx.barplot(TIPS, x="day", y="tip", errorbar=("ci", 120))
    with pytest.raises(ValueError, match="seed: expected a whole number"):
        hx.barplot(TIPS, x="day", y="tip", seed=-1)
    with pytest.raises(ValueError, match="barplot series: column 'day' is the category axis"):
        hx.barplot(TIPS, x="day", y="tip", series="day")
    with pytest.raises(ValueError, match='barplot estimator: expected "mean" or "median"'):
        hx.barplot(TIPS, x="day", y="tip", estimator="sum")  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="not made by a herceg.express function"):
        hx.statistics(hg.Chart(TIPS).bar(x="day", y="tip"))


# Distributions ----------------------------------------------------------------------

PENGUINS_N = 300
_species = RNG.choice(["Adelie", "Gentoo", "Chinstrap"], PENGUINS_N)
PENGUINS = {
    "species": _species,
    "flipper": np.round(
        np.where(
            _species == "Adelie",
            RNG.normal(190, 6, PENGUINS_N),
            np.where(
                _species == "Gentoo", RNG.normal(217, 6, PENGUINS_N), RNG.normal(196, 7, PENGUINS_N)
            ),
        ),
        1,
    ),
    "sex": RNG.choice(["f", "m"], PENGUINS_N),
}
PENGUINS["mass"] = PENGUINS["flipper"] * 20 + RNG.normal(0, 300, PENGUINS_N)


def _seaborn_axes():
    matplotlib = pytest.importorskip("matplotlib")
    matplotlib.use("Agg")
    pytest.importorskip("seaborn")
    import matplotlib.pyplot as plt

    plt.close("all")
    return plt


def _lines_by_x(ax):
    return [line.get_xydata() for line in ax.lines]


def _matches(grid, values, curves):
    """Whether one of seaborn's lines runs through these points."""
    return any(
        len(curve) == len(grid)
        and np.allclose(curve[:, 0], grid, rtol=1e-9)
        and np.allclose(curve[:, 1], values, rtol=1e-6, atol=1e-9)
        for curve in curves
    )


def test_histplot_bins_and_measures_follow_seaborn():
    statistics = pytest.importorskip("seaborn._statistics")
    flipper = PENGUINS["flipper"]
    for normalize, common_norm in (
        ("count", True),
        ("density", True),
        ("probability", False),
        ("percent", False),
    ):
        chart = hx.histplot(
            PENGUINS, x="flipper", series="species", normalize=normalize, common_norm=common_norm
        )
        (mark,) = marks(chart)
        expected_edges = np.histogram_bin_edges(flipper, "auto")
        assert np.allclose(mark["bins"], expected_edges, rtol=1e-12)
        assert mark["normalize"] == normalize
        assert mark.get("commonNorm") is (True if common_norm else None)
        spec, _ = chart.to_spec()
        assert spec["y"]["title"] == normalize.capitalize()
        bins = hx.statistics(chart).tables["bins"]
        for level in ("Adelie", "Gentoo", "Chinstrap"):
            members = flipper[PENGUINS["species"] == level]
            hist = statistics.Histogram(stat=normalize, bins=expected_edges)
            heights, _ = hist(members)
            if common_norm and normalize != "count":
                heights = heights * len(members) / len(flipper)
            assert np.allclose(bins["height"][bins["species"] == level], heights, rtol=1e-12)
    assert "<svg" in chart.to_svg()


def test_histplot_kde_overlays_match_seaborns_lines():
    plt = _seaborn_axes()
    import pandas as pd
    import seaborn as sns

    frame = pd.DataFrame(PENGUINS)
    for normalize, cumulative, common_norm in (
        ("count", False, False),
        ("density", False, True),
        ("density", False, False),
        ("percent", True, True),
    ):
        chart = hx.histplot(
            frame,
            x="flipper",
            series="species",
            normalize=normalize,
            cumulative=cumulative,
            common_norm=common_norm,
            kde=True,
        )
        kde = hx.statistics(chart).tables["kde"]
        ax = sns.histplot(
            frame,
            x="flipper",
            hue="species",
            stat=normalize,
            cumulative=cumulative,
            common_norm=common_norm,
            kde=True,
        )
        curves = _lines_by_x(ax)
        for level in ("Adelie", "Gentoo", "Chinstrap"):
            rows = kde["species"] == level
            assert _matches(kde["flipper"][rows], kde["density"][rows], curves), (normalize, level)
        plt.close("all")


def test_histplot_layouts_orientation_and_refusals():
    stacked = hx.histplot(PENGUINS, x="flipper", series="species", multiple="stack")
    assert marks(stacked)[0]["stack"] is True
    dodged = hx.histplot(PENGUINS, y="flipper", series="species", multiple="dodge", binwidth=5)
    (mark,) = marks(dodged)
    assert mark["y"] == "flipper" and mark["dodge"] is True
    assert np.allclose(np.diff(mark["bins"]), 5)
    spec, _ = dodged.to_spec()
    assert spec["x"]["title"] == "Count" and spec["y"]["title"] == "flipper"
    discrete = hx.histplot({"n": [1, 2, 2, 5]}, x="n", discrete=True)
    assert marks(discrete)[0]["bins"] == [0.5, 1.5, 2.5, 3.5, 4.5, 5.5]
    with pytest.raises(ValueError, match="exactly one of x and y"):
        hx.histplot(PENGUINS, x="flipper", y="mass")
    with pytest.raises(ValueError, match="layered bars only"):
        hx.histplot(PENGUINS, x="flipper", series="species", multiple="stack", kde=True)
    # Densities over horizontal bars run along y.
    horizontal = marks(hx.histplot(PENGUINS, y="flipper", kde=True))
    assert horizontal[1]["type"] == "line" and horizontal[1]["orient"] == "y"
    assert horizontal[1]["y"] == "flipper" and horizontal[1]["x"] == "density"
    for refused in ("proportion", "stat"):
        with pytest.raises(
            ValueError,
            match=f'histplot normalize: expected "count", "frequency", "probability", "percent", '
            f'or "density"; received "{refused}"',
        ):
            hx.histplot(PENGUINS, x="flipper", normalize=refused)  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="histplot kde_options: unknown bandwidth"):
        hx.histplot(PENGUINS, x="flipper", kde=True, kde_options={"bandwidth": 1})  # type: ignore[typeddict-unknown-key]
    sparse = hx.histplot(PENGUINS, x="flipper", kde=True, kde_options={"grid_size": 30})
    assert len(hx.statistics(sparse).tables["kde"]["flipper"]) == 30


def test_kdeplot_matches_seaborns_curves():
    plt = _seaborn_axes()
    import pandas as pd
    import seaborn as sns

    frame = pd.DataFrame(PENGUINS)
    for kwargs in (
        {"common_norm": True},
        {"bw_method": "silverman", "bw_adjust": 0.5, "cut": 1, "common_norm": False},
        {"common_norm": False, "cumulative": True},
    ):
        chart = hx.kdeplot(frame, x="flipper", series="species", grid_size=50, **kwargs)
        density = hx.statistics(chart).tables["density"]
        ax = sns.kdeplot(frame, x="flipper", hue="species", gridsize=50, **kwargs)
        curves = _lines_by_x(ax)
        for level in ("Adelie", "Gentoo", "Chinstrap"):
            rows = density["species"] == level
            assert _matches(density["flipper"][rows], density["density"][rows], curves), level
        plt.close("all")
    filled = hx.kdeplot(frame, x="flipper", filled=True)
    assert [mark["type"] for mark in marks(filled)] == ["area"]
    assert [mark["type"] for mark in marks(hx.kdeplot(frame, x="flipper"))] == ["line"]
    # Densities of y run along y, as Seaborn's do.
    along = hx.kdeplot(frame, y="flipper", series="species", grid_size=50, common_norm=True)
    assert [(m["type"], m["orient"]) for m in marks(along)] == [("line", "y")]
    density = hx.statistics(along).tables["density"]
    ax = sns.kdeplot(frame, y="flipper", hue="species", gridsize=50, common_norm=True)
    # Seaborn's lines run (density, value): its x is our density.
    curves = [curve[:, ::-1] for curve in _lines_by_x(ax)]
    for level in ("Adelie", "Gentoo", "Chinstrap"):
        rows = density["species"] == level
        assert _matches(density["flipper"][rows], density["density"][rows], curves), level
    plt.close("all")
    spec, _ = along.to_spec()
    assert spec["x"]["title"] == "Density" and spec["y"]["title"] == "flipper"
    assert marks(hx.kdeplot(frame, y="flipper", filled=True))[0]["type"] == "area"


def test_bivariate_kde_is_a_density_heatmap_per_panel():
    stats = pytest.importorskip("scipy.stats")
    chart = hx.kdeplot(PENGUINS, x="flipper", y="mass", grid_size=30)
    (heatmap,) = marks(chart)
    assert heatmap["type"] == "heatmap" and heatmap["color"] == "density"
    density = hx.statistics(chart).tables["density"]
    kde = stats.gaussian_kde(np.vstack([PENGUINS["flipper"], PENGUINS["mass"]]))
    expected = kde(np.vstack([density["flipper"], density["mass"]]))
    expected[expected < expected.max() * 1e-9] = 0
    assert np.allclose(density["density"], expected, rtol=1e-9, atol=1e-15)
    faceted = hx.kdeplot(PENGUINS, x="flipper", y="mass", facet_column="sex", grid_size=20)
    assert faceted.to_spec()[0]["facet"] == {"column": "sex"}
    with pytest.raises(ValueError, match="facet by facet_row or facet_column instead"):
        hx.kdeplot(PENGUINS, x="flipper", y="mass", series="species")


def test_ecdfplot_steps_match_seaborn():
    plt = _seaborn_axes()
    import pandas as pd
    import seaborn as sns

    frame = pd.DataFrame(PENGUINS)
    for normalize, complementary in (("probability", False), ("count", True), ("percent", False)):
        chart = hx.ecdfplot(
            frame, x="flipper", series="species", normalize=normalize, complementary=complementary
        )
        steps = hx.statistics(chart).tables["ecdf"]
        share = normalize.capitalize()
        stat = {"probability": "proportion"}.get(normalize, normalize)
        ax = sns.ecdfplot(frame, x="flipper", hue="species", stat=stat, complementary=complementary)
        for curve in _lines_by_x(ax):
            finite = curve[np.isfinite(curve[:, 0])]
            # Seaborn's last point at each value is the step's height there.
            heights = {x: y for x, y in finite}
            level = next(
                lv
                for lv in ("Adelie", "Gentoo", "Chinstrap")
                if np.isclose(steps["flipper"][steps["species"] == lv][-1], finite[-1, 0])
                and len(np.unique(steps["flipper"][steps["species"] == lv])) == len(heights)
            )
            rows = steps["species"] == level
            ours = dict(zip(steps["flipper"][rows], steps[share][rows], strict=True))
            assert set(ours) == set(heights)
            assert np.allclose([ours[x] for x in heights], list(heights.values()), rtol=1e-12)
        plt.close("all")
    # Steps of y run along y: each value's share holds up to the next value.
    along = hx.ecdfplot(PENGUINS, y="flipper", series="species")
    (steps_y,) = marks(along)
    assert steps_y["orient"] == "y" and steps_y["curve"] == "step-after"
    assert steps_y["x"] == "Probability" and steps_y["y"] == "flipper"
    assert "<path" in along.to_svg()
    ax = sns.ecdfplot(frame, y="flipper", hue="species")
    steps = hx.statistics(along).tables["ecdf"]
    for curve in _lines_by_x(ax):
        finite = curve[np.isfinite(curve[:, 1])]
        # Seaborn's lines run (share, value); the last share at each value is its step.
        heights = {value: share for share, value in finite}
        level = next(
            lv
            for lv in ("Adelie", "Gentoo", "Chinstrap")
            if len(np.unique(steps["flipper"][steps["species"] == lv])) == len(heights)
            and np.isclose(steps["flipper"][steps["species"] == lv][-1], finite[-1, 1])
        )
        rows = steps["species"] == level
        ours = dict(zip(steps["flipper"][rows], steps["Probability"][rows], strict=True))
        assert np.allclose([ours[v] for v in heights], list(heights.values()), rtol=1e-12)
    plt.close("all")
    # Every point read is an observation's step: [1, 2, 3] reads 1/3 first, a lone value 1.
    for sample, complementary, first in (
        ([1.0, 2.0, 3.0], False, 1 / 3),
        ([1.0, 2.0, 3.0], True, 2 / 3),
        ([5.0], False, 1.0),
    ):
        ecdf = hx.statistics(hx.ecdfplot({"v": sample}, x="v", complementary=complementary))
        assert list(ecdf.tables["ecdf"]["v"]) == sample
        assert ecdf.tables["ecdf"]["Probability"][0] == pytest.approx(first)
    # A level of one distinct value has no step: it shows as a point, the others as steps.
    mixed = hx.ecdfplot(
        {"v": [5.0, 5.0, 1.0, 2.0], "g": ["a", "a", "b", "b"]},
        x="v",
        series="g",
        series_order=["a", "b"],
        palette=["#ff0000", "#0000ff"],
    )
    dot, line = marks(mixed)
    assert (dot["type"], dot["label"]) == ("point", "a")
    assert (line["type"], line["label"]) == ("line", "b")
    # Levels keep their order and colors whichever draw as points.
    svg = mixed.to_svg()
    assert svg.index(">a</text>") < svg.index(">b</text>")
    assert '#ff0000"/><text' in svg.split(">a</text>")[0][-120:]
    assert "<circle" in mixed.to_svg() or "<path" in mixed.to_svg()
    assert "shows as a point" in hx.statistics(mixed).description
    with pytest.raises(ValueError, match='ecdfplot normalize: expected "probability"'):
        hx.ecdfplot(PENGUINS, x="flipper", normalize="proportion")  # type: ignore[arg-type]


def test_strip_box_and_violin_plots():
    strip = hx.stripplot(PENGUINS, x="species", y="flipper", series="sex", dodge=True, seed=4)
    (points,) = marks(strip)
    assert points["dodge"] is True and points["jitter"] == {"width": 0.5, "seed": 4}
    assert points["legendGroup"] == "series"
    assert hx.statistics(strip).seed == 4
    assert "50% of each series' slot in the category" in hx.statistics(strip).description
    plain = hx.stripplot(PENGUINS, x="flipper", y="species", jitter=False)
    assert "jitter" not in marks(plain)[0] and hx.statistics(plain).seed is None
    box = hx.boxplot(PENGUINS, x="species", y="flipper", series="sex", whiskers=2, notch=True)
    (mark,) = marks(box)
    assert mark["whiskers"] == 2.0 and mark["notch"] is True and mark["series"] == "sex"
    boxes = hx.statistics(box).tables["boxes"]
    adelie = np.sort(
        PENGUINS["flipper"][(PENGUINS["species"] == "Adelie") & (PENGUINS["sex"] == "f")]
    )
    row = (boxes["species"] == "Adelie") & (boxes["sex"] == "f")
    q1, median, q3 = np.percentile(adelie, [25, 50, 75])
    assert boxes["q1"][row][0] == pytest.approx(q1) and boxes["median"][row][0] == pytest.approx(
        median
    )
    inside = adelie[(adelie >= q1 - 2 * (q3 - q1)) & (adelie <= q3 + 2 * (q3 - q1))]
    assert boxes["low"][row][0] == inside[0] and boxes["high"][row][0] == inside[-1]
    summary = hx.boxplot(PENGUINS, x="species", y="flipper", outliers=False)
    (mark,) = marks(summary)
    assert mark["median"] == "median" and mark["count"] == "n" and "y" not in mark
    violin = hx.violinplot(PENGUINS, x="flipper", y="species", bandwidth=2)
    (mark,) = marks(violin)
    assert mark["type"] == "violin" and mark["x"] == "flipper" and mark["bandwidth"] == 2
    assert "split" not in mark and "inner" not in mark
    halves = hx.violinplot(
        PENGUINS, x="species", y="flipper", series="sex", split=True, inner="quartiles"
    )
    (mark,) = marks(halves)
    assert mark["split"] is True and mark["inner"] == "quartiles"
    assert "each level of sex on one side" in hx.statistics(halves).description
    assert (
        marks(hx.violinplot(PENGUINS, x="species", y="flipper", inner="none"))[0]["inner"] == "none"
    )
    with pytest.raises(ValueError, match="needs a series of at most two levels; 'species' has 3"):
        hx.violinplot(PENGUINS, x="sex", y="flipper", series="species", split=True)
    two = hx.violinplot(
        PENGUINS,
        x="sex",
        y="flipper",
        series="species",
        series_order=["Adelie", "Gentoo"],
        split=True,
    )
    assert table(two)["species"]["dictionary"] == ["Adelie", "Gentoo"]
    with pytest.raises(ValueError, match="violinplot split: needs a series"):
        hx.violinplot(PENGUINS, x="species", y="flipper", split=True)
    for chart in (strip, box, summary, violin, halves, two):
        assert "<svg" in chart.to_svg()


def test_express_charts_render_and_update_wherever_charts_do():
    chart = hx.stripplot(PENGUINS, x="species", y="flipper", series="sex", seed=1, title="Strips")
    assert "<svg" in chart.to_svg() and "Strips" in chart.to_html()
    assert chart.to_png().startswith(b"\x89PNG") and chart.to_pdf().startswith(b"%PDF")
    pytest.importorskip("anywidget")
    widget = chart.widget()
    # Rows the chart draws stream in as in any chart; jitter keeps earlier points in place.
    widget.append({"species": ["Adelie"], "flipper": [200.0], "sex": ["f"]})
    widget.update(title="More strips")
    with pytest.raises(ValueError, match='Chart resolve_x: expected "shared" in a live chart'):
        hx.pairplot(PENGUINS, vars=["flipper", "mass"]).widget()
    streamlit = pytest.importorskip("herceg.streamlit")
    spec, buffers = hx.histplot(PENGUINS, x="flipper", kde=True).to_spec()
    assert len(streamlit._payload(spec, buffers, [])) % 8 == 0


# Arrangements -------------------------------------------------------------------------


def test_pairplot_pairs_every_number_column_in_subplots():
    data = {key: PENGUINS[key] for key in ("species", "flipper", "mass")}
    data["bill"] = PENGUINS["mass"] / 100 + RNG.normal(0, 3, PENGUINS_N)
    chart = hx.pairplot(data, series="species")
    spec, _ = chart.to_spec()
    assert [panel["id"] for panel in spec["panels"]] == [
        f"{i},{j}" for i in range(3) for j in range(3)
    ]
    assert spec["grid"]["columns"] == 3
    assert spec["resolve"] == {"x": "columns", "y": "independent"}
    kinds = {mark["panel"]: mark["type"] for mark in spec["marks"]}
    assert kinds == {
        f"{i},{j}": "line" if i == j else "point" for i in range(3) for j in range(3)
    }  # densities on the diagonal with series
    # The scatter plots of a row show one y range.
    first, second = spec["panels"][1]["y"]["domain"], spec["panels"][2]["y"]["domain"]
    assert first == second == [float(data["flipper"].min()), float(data["flipper"].max())]
    assert all(mark.get("legendGroup") == "series" for mark in spec["marks"])
    corner = hx.pairplot(data, vars=["flipper", "mass"], corner=True, diag_kind="hist")
    spec, _ = corner.to_spec()
    assert sorted((mark["panel"], mark["type"]) for mark in spec["marks"]) == [
        ("0,0", "histogram"),
        ("1,0", "point"),
        ("1,1", "histogram"),
    ]
    assert "flipper edges" in hx.statistics(corner).tables
    assert "<svg" in corner.to_svg()
    with pytest.raises(ValueError, match="distinct number columns"):
        hx.pairplot(data, vars=["flipper", "flipper"])


def test_one_column_on_both_axes():
    data = {"v": [0.0, 1.0, 2.0, 3.0, 1.0, 2.0]}
    fit = hx.regplot(data, x="v", y="v", seed=0)
    table = hx.statistics(fit).tables["fit"]
    assert np.allclose(table["v_"], table["v"])
    line = hx.lineplot(data, x="v", y="v", seed=0)
    assert list(hx.statistics(line).tables["estimates"]["v_"]) == [0.0, 1.0, 2.0, 3.0]
    for chart in (fit, line):
        assert "<svg" in chart.to_svg()
    # A plotted column cannot also group the rows.
    for role in ("facet_column", "series", "facet_row"):
        with pytest.raises(ValueError, match=f"histplot {role}: column 'v' is also plotted"):
            hx.histplot(data, x="v", **{role: "v"})  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="is also plotted on an axis"):
        hx.regplot({"v": [1.0, 2.0], "w": [1.0, 2.0]}, x="v", y="w", series="w")
    # Categories and values cannot share a column either.
    for function in (hx.barplot, hx.pointplot, hx.stripplot, hx.boxplot, hx.violinplot):
        with pytest.raises(ValueError, match="x and y name the same column 'v'"):
            function(data, x="v", y="v")


def test_pairplot_diagonal_densities_follow_their_rows_series():
    # The first row has no series: densities must still pair each value with its own level.
    data = {"v": [100.0, 0, 1, 2, 10, 11, 12], "h": [None, "a", "a", "a", "b", "b", "b"]}
    pair = hx.statistics(hx.pairplot(data, vars=["v"], series="h", diag_kind="kde"))
    alone = hx.statistics(hx.kdeplot({"v": data["v"][1:], "h": data["h"][1:]}, x="v", series="h"))
    ours, theirs = pair.tables["v density"], alone.tables["density"]
    assert list(ours["h"]) == list(theirs["h"])
    assert np.allclose(ours["v"], theirs["v"]) and np.allclose(ours["density"], theirs["density"])


def test_pairplot_keeps_series_colors_when_a_diagonal_density_lacks_a_level():
    data = {"u": [5.0, 5.0, 5.0, 1, 2, 3], "v": [1.0, 2, 3, 4, 5, 6], "h": ["a"] * 3 + ["b"] * 3}
    svg = hx.pairplot(
        data, series="h", series_order=["a", "b"], palette=["#ff0000", "#0000ff"], diag_kind="kde"
    ).to_svg()
    assert svg.index(">a</text>") < svg.index(">b</text>")
    assert "#ff0000" in svg.split(">a</text>")[0][-160:]


def test_jointplot_shares_the_scatter_plots_scales_with_its_margins():
    data = {"x": PENGUINS["flipper"].copy(), "y": PENGUINS["mass"].copy(), "g": PENGUINS["sex"]}
    data["y"][:5] = np.nan
    chart = hx.jointplot(data, x="x", y="y", series="g")
    spec, _ = chart.to_spec()
    assert [panel["id"] for panel in spec["panels"]] == ["x", "corner", "joint", "y"]
    assert spec["grid"] == {"columns": 2, "rowHeights": [1, 5], "columnWidths": [5, 1]}
    assert spec["resolve"] == {"x": "columns", "y": "rows"}
    point, top, right = spec["marks"]
    assert point["panel"] == "joint" and top["x"] == "x" and right["y"] == "y"
    # The margins count the same rows as the scatter plot.
    assert hx.statistics(chart).dropped == 5
    reg = hx.jointplot(data, x="x", y="y", kind="reg", seed=2)
    assert [mark["type"] for mark in reg.to_spec()[0]["marks"]] == [
        "point",
        "area",
        "line",
        "histogram",
        "histogram",
    ]
    assert hx.statistics(reg).seed == 2
    assert "<svg" in reg.to_svg()
    # A band needs two resamples that could be fit, as regplot's does.
    for n_boot in (1, 2):
        few = hx.jointplot(
            {"x": [0.0, 1.0], "y": [0.0, 1.0]}, x="x", y="y", kind="reg", n_boot=n_boot, seed=0
        )
        assert "area" not in [mark["type"] for mark in marks(few)]
        assert "has no band" in hx.statistics(few).description
    # Nor a line without distinct x values to fit.
    flat = hx.jointplot({"x": [1.0, 1.0], "y": [0.0, 1.0]}, x="x", y="y", kind="reg", seed=0)
    assert [mark["type"] for mark in marks(flat)] == ["point", "histogram", "histogram"]
    description = hx.statistics(flat).description
    assert "least-squares" not in description and "Too few distinct x values" in description
    assert hx.statistics(flat).seed is None


def test_rugplot_marks_each_value_at_the_plot_edge():
    chart = hx.rugplot(PENGUINS, x="flipper", series="species", length=10)
    (rug,) = marks(chart)
    assert rug["type"] == "rug" and rug["x"] == "flipper" and rug["length"] == 10
    assert rug["series"] == "species" and rug["legendGroup"] == "series"
    sideways = hx.rugplot(PENGUINS, y="mass")
    assert marks(sideways)[0]["y"] == "mass"
    assert "<svg" in chart.to_svg()


def test_clustermap_takes_only_options_both_clusterings_support():
    values = {"a": [1.0, 2.0, 4.0], "b": [2.0, 1.0, 3.0]}
    with pytest.raises(ValueError, match="clustermap method: expected one of"):
        hx.clustermap(values, method="centroid")  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="clustermap metric: expected one of"):
        hx.clustermap(values, metric="chebyshev")  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="ward linkage needs the euclidean metric"):
        hx.clustermap(values, method="ward", metric="cityblock")
    with pytest.raises(ValueError, match="clustermap columns: names columns of a table, but"):
        hx.clustermap(np.ones((3, 2)), columns=["a"])


def test_clustermap_orders_rows_and_columns_by_their_clustering():
    hierarchy = pytest.importorskip("scipy.cluster.hierarchy")
    pd = pytest.importorskip("pandas")
    values = RNG.normal(0, 1, (12, 5)) + np.repeat(RNG.normal(0, 3, (3, 5)), 4, axis=0)
    frame = pd.DataFrame(values, index=[f"r{i}" for i in range(12)], columns=list("abcde"))
    chart = hx.clustermap(frame, z_score=1)
    spec, _ = chart.to_spec()
    assert [panel["id"] for panel in spec["panels"]] == ["corner", "top", "left", "matrix"]
    heatmap, top, left = spec["marks"]
    assert heatmap["type"] == "heatmap" and heatmap["panel"] == "matrix"
    assert (top["type"], top["side"], top["panel"]) == ("dendrogram", "bottom", "top")
    assert (left["type"], left["side"], left["panel"]) == ("dendrogram", "right", "left")
    standardized = (values - values.mean(axis=0)) / values.std(axis=0, ddof=1)
    rows = hierarchy.leaves_list(hierarchy.linkage(standardized, "average"))
    columns = hierarchy.leaves_list(hierarchy.linkage(standardized.T, "average"))
    stats = hx.statistics(chart)
    assert list(stats.tables["row order"]["row"]) == [f"r{i}" for i in rows]
    assert list(stats.tables["column order"]["column"]) == [list("abcde")[j] for j in columns]
    # The heatmap's categories are in the dendrograms' order.
    data = spec["data"][heatmap["data"]]["columns"]
    assert data["row"]["dictionary"] == [f"r{i}" for i in rows]
    assert data["column"]["dictionary"] == [list("abcde")[j] for j in columns]
    assert top["leaves"] == list("abcde") and left["leaves"] == [f"r{i}" for i in range(12)]
    assert "<svg" in chart.to_svg()
    plain = hx.clustermap(values, row_cluster=False, standard_scale=0)
    assert [mark["type"] for mark in plain.to_spec()[0]["marks"]] == ["heatmap", "dendrogram"]
    with pytest.raises(ValueError, match="exclude each other"):
        hx.clustermap(values, z_score=0, standard_scale=1)
    gaps = values.copy()
    gaps[0, 0] = np.nan
    with pytest.raises(ValueError, match="finite value in every cell"):
        hx.clustermap(gaps)


def test_clustermap_reads_labels_from_an_index_column():
    table = {"name": ["x", "y", "z"], "a": [1.0, 2.0, 9.0], "b": [1.0, 2.5, 8.0]}
    chart = hx.clustermap(table, index="name", method="single")
    stats = hx.statistics(chart)
    assert set(stats.tables["row order"]["name"]) == {"x", "y", "z"}
    assert stats.tables["row linkage"]["height"].shape == (2,)
    with pytest.raises(ValueError, match="row labels must differ"):
        hx.clustermap({"name": ["x", "x"], "a": [1.0, 2.0]}, index="name")


# Edge cases the review found --------------------------------------------------------


def test_regressions_of_timestamps_and_tiny_samples():
    stamps = np.array(
        ["2026-01-01T00:00", "2026-01-01T00:01", "2026-01-01T00:03"], dtype="datetime64[ms]"
    )
    # A number column of epoch milliseconds, far from zero.
    data = {"t": stamps.astype("int64").astype(float), "v": [3.0, 5.0, 9.0]}
    chart = hx.regplot(data, x="t", y="v", seed=1, n_boot=50)
    fit = hx.statistics(chart).tables["fit"]
    assert np.allclose(fit["v"][[0, -1]], [3.0, 9.0], rtol=1e-9)
    tiny = hx.regplot(
        {"x": [0.0, 1.0, 2.0], "y": [0.0, 1.0, 4.0]}, x="x", y="y", order=2, seed=42, n_boot=100
    )
    stats = hx.statistics(tiny)
    assert "were left out of the bands" in stats.description
    assert np.allclose(stats.tables["fit"]["y"], stats.tables["fit"]["x"] ** 2, atol=1e-9)


def test_statistic_names_stay_apart_from_the_datas():
    data = {"low": ["a", "a", "a", "b", "b", "b"], "n": [1.0, 2.0, 4.0, 3.0, 5.0, 6.0]}
    chart = hx.boxplot(data, x="low", y="n", outliers=False)
    (mark,) = marks(chart)
    assert mark["x"] == "low" and mark["low"] == "low_" and mark["count"] == "n_"
    assert "<svg" in chart.to_svg()
    kde = hx.kdeplot(
        {"v": [1.0, 2.0, 2.5, 4.0], "density": ["a", "a", "b", "b"]}, x="v", series="density"
    )
    (line,) = marks(kde)
    assert line["series"] == "density" and line["y"] == "density_"
    # Histogram statistics beside a series named as one of their columns.
    hist = hx.histplot(
        {"v": [1.0, 2.0, 3.0], "left": ["a", "b", "b"]}, x="v", series="left", bins=2
    )
    bins = hx.statistics(hist).tables["bins"]
    assert list(bins["left"]) == ["a", "a", "b", "b"] and list(bins["height"]) == [1, 0, 0, 2]
    assert list(bins["left_"]) == [1.0, 2.0, 1.0, 2.0]
    # A joint fit's band beside an axis named as one of its bounds.
    joint = {"low": [0.0, 1.0, 2.0, 3.0, 4.0], "y": [1.0, 3.0, 5.0, 7.0, 9.0]}
    fit = hx.statistics(hx.jointplot(joint, x="low", y="y", kind="reg", seed=0)).tables["fit"]
    assert np.allclose(fit["y"], 1 + 2 * fit["low"]) and fit["low"][-1] == 4.0
    assert np.allclose(fit["low_"], fit["y"]) and np.allclose(fit["high"], fit["y"])
    # A clustermap's row labels beside a matrix column named as they are.
    matrix = hx.statistics(hx.clustermap({"row": [1.0, 2.0, 3.0], "v": [2.0, 4.0, 8.0]}))
    assert list(matrix.tables["matrix"]["row"]) == [1.0, 2.0, 3.0]
    assert list(matrix.tables["matrix"]["row_"]) == ["0", "1", "2"]
    # Close numbers name rows apart, at full precision.
    ids = {"id": [1.000001, 1.000002, 1.000003], "a": [1.0, 2.0, 4.0], "b": [2.0, 1.0, 3.0]}
    close = hx.statistics(hx.clustermap(ids, index="id"))
    assert sorted(close.tables["row order"]["id"]) == ["1.000001", "1.000002", "1.000003"]


@pytest.mark.parametrize("whiskers", [0, 0.25, 1.5, "tukey", "range"])
def test_box_statistics_keep_their_order_for_any_whiskers(whiskers):
    for sample in ([0.0, 1.0], [0.0, 1.0, 2.0], [0.0, 0.0, 0.0, 9.0]):
        data = {"g": ["a"] * len(sample), "v": sample}
        boxes = hx.statistics(hx.boxplot(data, x="g", y="v", whiskers=whiskers)).tables["boxes"]
        low, q1, median, q3, high = (boxes[k][0] for k in ("low", "q1", "median", "q3", "high"))
        if whiskers not in (1.5, "tukey"):
            assert low <= q1 <= median <= q3 <= high
        assert boxes["n"][0] == len(sample)
        chart = hx.boxplot(data, x="g", y="v", whiskers=whiskers, outliers=False)
        assert "<svg" in chart.to_svg()


def test_empty_and_missing_distributions_draw_empty_charts():
    for values in ([], [float("nan"), float("nan")]):
        data = {"v": values, "g": ["a"] * len(values)}
        for chart in (
            hx.ecdfplot(data, x="v"),
            hx.ecdfplot(data, x="v", series="g"),
            hx.kdeplot(data, x="v"),
            hx.histplot(data, x="v"),
            hx.rugplot(data, x="v"),
        ):
            assert "<svg" in chart.to_svg()


def test_kde_overlays_need_bins_of_one_width_to_follow_counts():
    with pytest.raises(ValueError, match="bins of one width"):
        hx.histplot(PENGUINS, x="flipper", bins=[170, 190, 195, 240], kde=True)
    # Widths compare relative to one another, at any scale.
    tiny = {"v": np.linspace(0, 1e-8, 20)}
    with pytest.raises(ValueError, match="bins of one width"):
        hx.histplot(tiny, x="v", bins=[0, 1e-10, 1e-8], kde=True)
    hx.histplot(tiny, x="v", bins=[0, 5e-9, 1e-8], kde=True)
    hx.histplot(PENGUINS, x="flipper", bins=[170, 190, 195, 240], kde=True, normalize="density")


# Options in herceg's terms -----------------------------------------------------------


def test_series_and_series_order_split_and_choose_levels():
    chart = hx.barplot(TIPS, x="day", y="tip", series="sex", series_order=["male"], seed=0)
    bars, _ = marks(chart)
    assert bars["series"] == "sex" and table(chart)["sex"]["dictionary"] == ["male"]
    stats = hx.statistics(chart)
    assert set(stats.tables["estimates"]["sex"]) == {"male"}
    assert stats.dropped == int(np.sum(TIPS["sex"] == "female"))
    assert ", by sex" in stats.description
    with pytest.raises(ValueError, match="barplot series: column 'sex' already facets"):
        hx.barplot(TIPS, x="day", y="tip", series="sex", facet_row="sex")


def test_facet_row_and_facet_column_compute_statistics_per_panel():
    chart = hx.barplot(TIPS, x="size", y="tip", facet_row="sex", facet_column="day", errorbar=None)
    spec, _ = chart.to_spec()
    assert spec["facet"] == {"row": "sex", "column": "day"}
    estimates = hx.statistics(chart).tables["estimates"]
    for sex, day, size, mean in zip(
        estimates["sex"], estimates["day"], estimates["size"], estimates["tip"], strict=True
    ):
        rows = (TIPS["sex"] == sex) & (TIPS["day"] == day) & (TIPS["size"] == float(size))
        assert mean == pytest.approx(TIPS["tip"][rows].mean())
    histogram = hx.histplot(PENGUINS, x="flipper", facet_row="sex", normalize="probability")
    bins = hx.statistics(histogram).tables["bins"]
    for sex in ("f", "m"):
        assert bins["height"][bins["sex"] == sex].sum() == pytest.approx(1)
    # Wrapped facets and subplots would split tables the statistics did not group.
    with pytest.raises(ValueError, match="barplot facet: express computes statistics per panel"):
        hx.barplot(TIPS, x="day", y="tip", facet="sex")
    with pytest.raises(ValueError, match="stripplot panels: express computes statistics"):
        hx.stripplot(PENGUINS, x="species", y="flipper", panels=["a"])
    with pytest.raises(ValueError, match="pairplot facet_row: pairplot lays out panels of its own"):
        hx.pairplot(PENGUINS, facet_row="sex")
    with pytest.raises(ValueError, match="jointplot facet_column: jointplot lays out panels"):
        hx.jointplot(PENGUINS, x="flipper", y="mass", facet_column="sex")
    with pytest.raises(ValueError, match="residplot facet_row: residplot fits all the rows"):
        hx.residplot(PENGUINS, x="flipper", y="mass", facet_row="sex")


def test_whiskers_take_the_box_plot_marks_values():
    default = hx.boxplot(PENGUINS, x="species", y="flipper")
    assert "whiskers" not in marks(default)[0]
    assert "within 1.5 IQR of the box, and points beyond them" in hx.statistics(default).description
    ranged = hx.boxplot(PENGUINS, x="species", y="flipper", whiskers="range")
    assert marks(ranged)[0]["whiskers"] == "range"
    assert "within the whole range." in hx.statistics(ranged).description
    boxes = hx.statistics(ranged).tables["boxes"]
    adelie = PENGUINS["flipper"][PENGUINS["species"] == "Adelie"]
    first = list(boxes["species"]).index("Adelie")
    assert (boxes["low"][first], boxes["high"][first]) == (adelie.min(), adelie.max())
    assert boxes["outliers"][first] == 0
    double = hx.boxplot(PENGUINS, x="species", y="flipper", whiskers=2)
    assert marks(double)[0]["whiskers"] == 2.0
    assert "within 2 IQR of the box" in hx.statistics(double).description
    hidden = hx.boxplot(PENGUINS, x="species", y="flipper", outliers=False)
    assert marks(hidden)[0]["type"] == "boxplot" and "y" not in marks(hidden)[0]
    assert "points beyond them" not in hx.statistics(hidden).description
    for refused, shown in ((math.inf, "inf"), (-1, "-1"), (True, "True"), ("iqr", '"iqr"')):
        with pytest.raises(
            ValueError,
            match=r'boxplot whiskers: expected "tukey", "range", or a finite nonnegative IQR '
            rf"multiple; received {shown}",
        ):
            hx.boxplot(PENGUINS, x="species", y="flipper", whiskers=refused)  # type: ignore[arg-type]


@pytest.mark.parametrize("inner", ["quart", "quartile", None, "stick"])
def test_violin_inner_takes_exactly_box_quartiles_or_none(inner):
    shown = "None" if inner is None else f'"{inner}"'
    with pytest.raises(
        ValueError,
        match=f'violinplot inner: expected "box", "quartiles", or "none"; received {shown}',
    ):
        hx.violinplot(PENGUINS, x="species", y="flipper", inner=inner)  # type: ignore[arg-type]


def test_jitter_is_the_point_marks_fraction_of_the_band():
    def jitter_of(chart):
        return marks(chart)[0].get("jitter")

    assert jitter_of(hx.stripplot(PENGUINS, x="species", y="flipper", seed=2)) == {
        "width": 0.5,
        "seed": 2,
    }
    narrow = hx.stripplot(PENGUINS, x="species", y="flipper", jitter=0.3, seed=1)
    assert jitter_of(narrow) == {"width": 0.3, "seed": 1}
    assert "jittered across 30% of each category" in hx.statistics(narrow).description
    drawn = hx.stripplot(PENGUINS, x="species", y="flipper", jitter=0.3)
    assert jitter_of(drawn)["seed"] == hx.statistics(drawn).seed
    given = hx.stripplot(PENGUINS, x="species", y="flipper", jitter=hg.Jitter(width=0.2, seed=9))
    assert jitter_of(given) == {"width": 0.2, "seed": 9} and hx.statistics(given).seed == 9
    still = hx.stripplot(PENGUINS, x="species", y="flipper", jitter=0, seed=3)
    assert jitter_of(still) is None and hx.statistics(still).seed is None
    with pytest.raises(ValueError, match="stripplot seed: the Jitter given as jitter has its own"):
        hx.stripplot(PENGUINS, x="species", y="flipper", jitter=hg.Jitter(0.2, 9), seed=1)
    for refused in (1.5, -0.1, math.nan, "wide", None, hg.Jitter(width=2)):
        with pytest.raises(ValueError, match="stripplot jitter: expected True, False, a width"):
            hx.stripplot(PENGUINS, x="species", y="flipper", jitter=refused)  # type: ignore[arg-type]


def test_common_norm_is_off_unless_asked_as_in_the_histogram_mark():
    each = hx.histplot(PENGUINS, x="flipper", series="species", normalize="probability")
    assert "commonNorm" not in marks(each)[0]
    bins = hx.statistics(each).tables["bins"]
    for level in ("Adelie", "Gentoo", "Chinstrap"):
        assert bins["height"][bins["species"] == level].sum() == pytest.approx(1)
    common = hx.histplot(
        PENGUINS, x="flipper", series="species", normalize="probability", common_norm=True
    )
    assert marks(common)[0]["commonNorm"] is True
    bins = hx.statistics(common).tables["bins"]
    assert bins["height"].sum() == pytest.approx(1)
    assert "normalized over all series" in hx.statistics(common).description

    def areas(chart, name):
        """Each species' density integrated by trapezoids (NumPy 1.24 has no trapezoid)."""
        density = hx.statistics(chart).tables[name]
        out = []
        for level in ("Adelie", "Gentoo", "Chinstrap"):
            rows = density["species"] == level
            x, y = density["flipper"][rows], density["density"][rows]
            out.append(float(np.sum(np.diff(x) * (y[1:] + y[:-1]) / 2)))
        return out

    alone = hx.kdeplot(PENGUINS, x="flipper", series="species")
    assert np.allclose(areas(alone, "density"), 1, atol=1e-3)
    weighted = hx.kdeplot(PENGUINS, x="flipper", series="species", common_norm=True)
    assert sum(areas(weighted, "density")) == pytest.approx(1, abs=1e-3)
    assert "weighted by each series' share" in hx.statistics(weighted).description
    pair = hx.pairplot(PENGUINS, vars=["flipper", "mass"], series="species", diag_kind="kde")
    assert np.allclose(areas(pair, "flipper density"), 1, atol=1e-3)


# Lines between estimates, swarms, and histogram options --------------------------


def test_pointplot_joins_its_estimates_with_lines_that_break_at_missing_categories():
    data = {
        "day": ["thu", "thu", "fri", "fri", "sat", "sat", "thu", "fri"],
        "tip": [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0],
        "sex": ["f", "f", "f", "f", "f", "f", "m", "m"],
    }
    chart = hx.pointplot(data, x="day", y="tip", series="sex", errorbar=None, dodge=True)
    points, lines = marks(chart)
    assert lines["type"] == "line" and lines["dodge"] is True
    assert lines["legendGroup"] == points["legendGroup"] == "series"
    spec, buffers = chart.to_spec()
    joined = spec["data"][lines["data"]]["columns"]["tip"]
    # Every series has a row in every category: m has none on sat, so its line breaks.
    estimates = np.frombuffer(buffers[joined["buffer"]], dtype="<f8")
    assert len(estimates) == 6 and int(np.isnan(estimates).sum()) == 1
    assert "joined by lines" in chart.to_spec()[0]["description"]
    styled = hx.pointplot(data, x="day", y="tip", series="sex", linestyles=["-", "--"])
    dashed = [m.get("dash") for m in marks(styled) if m["type"] == "line"]
    assert dashed == [None, [6, 4]]
    none = hx.pointplot(data, x="day", y="tip", linestyle="none", errorbar=None)
    assert [m["type"] for m in marks(none)] == ["point"]
    horizontal = hx.pointplot(data, x="tip", y="day", errorbar=None)
    assert marks(horizontal)[1]["type"] == "line" and marks(horizontal)[1]["y"] == "day"
    # Styles per level keep the levels' order, colors, and slots: the points set them.
    levels = {
        "day": ["thu"] * 3 + ["fri"] * 3,
        "tip": [1.0, 2.0, 3.0] * 2,
        "s": ["A", "B", "C"] * 2,
    }
    mixed = hx.pointplot(
        levels, x="day", y="tip", series="s", linestyles=["-", "--", "-"], dodge=True, errorbar=None
    )
    kinds = [(m["type"], m.get("dash")) for m in marks(mixed)]
    assert kinds == [("point", None), ("line", None), ("line", [6, 4])]
    import herceg as hg

    legend = mixed.to_svg()
    assert legend.index(">A<") < legend.index(">B<") < legend.index(">C<")
    assert isinstance(mixed, hg.Chart)
    assert "joined by lines" in hx.statistics(mixed).description
    with pytest.raises(ValueError, match="pointplot linestyle: expected"):
        hx.pointplot(levels, x="day", y="tip", linestyle="~")  # type: ignore[arg-type]
    with pytest.raises(
        ValueError, match='pointplot join: Seaborn 0.13 deprecates it; pass linestyle="none"'
    ):
        hx.pointplot(data, x="day", y="tip", join=False)
    with pytest.raises(
        ValueError, match="pointplot linestyles: expected 2 styles, one per series level"
    ):
        hx.pointplot(data, x="day", y="tip", series="sex", linestyles=["-"])
    with pytest.raises(ValueError, match="pointplot linestyle: give one style"):
        hx.pointplot(data, x="day", y="tip", linestyle="-", linestyles="--")
    assert "<path" in chart.to_svg()


def test_pointplot_pads_its_lines_with_the_categories_of_their_panels_axis():
    # P1 holds days A and B, P2 days C and D; m has no estimate on B or D.
    data = {
        "day": ["A", "B", "A", "C", "D", "C"],
        "tip": [1.0, 2.0, 3.0, 4.0, 5.0, 6.0],
        "sex": ["f", "f", "m", "f", "f", "m"],
        "p": ["P1", "P1", "P1", "P2", "P2", "P2"],
    }

    def joined(**options: Any) -> np.ndarray:
        chart = hx.pointplot(
            data, x="day", y="tip", series="sex", errorbar=None, facet_column="p", **options
        )
        spec, buffers = chart.to_spec()
        (line,) = [m for m in spec["marks"] if m["type"] == "line"]
        column = spec["data"][line["data"]]["columns"]["tip"]
        return np.frombuffer(buffers[column["buffer"]], dtype="<f8")

    # A shared x holds every day: each series has a row on each.
    shared = joined()
    assert len(shared) == 16 and int(np.isnan(shared).sum()) == 10
    # Panels' own x axes hold their own days, where m's lines still break.
    independent = joined(resolve_x="independent")
    assert len(independent) == 8 and int(np.isnan(independent).sum()) == 2


def test_swarmplot_packs_points_and_warns_as_seaborn_does_when_they_do_not_fit():
    rng = np.random.default_rng(3)
    sparse = {"g": np.repeat(["a", "b"], 30), "v": rng.normal(0, 1, 60)}
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        chart = hx.swarmplot(sparse, x="g", y="v")
    (mark,) = marks(chart)
    assert mark["swarm"] is True and mark["type"] == "point"
    crowded = {"g": np.repeat(["a", "b"], 2000), "v": rng.normal(0, 1, 4000)}
    with pytest.warns(UserWarning) as warned:
        hx.swarmplot(crowded, x="g", y="v")
    assert [str(w.message).split(" of the points of ")[1][:5] for w in warned] == ["g 'a'", "g 'b'"]
    assert all(
        re.match(
            r"swarmplot: \d+\.\d% of the points of g '[ab]' cannot be placed at 640 by 320",
            str(w.message),
        )
        for w in warned
    )
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        hx.swarmplot(crowded, x="g", y="v", warn_thresh=1)
    dodged = hx.swarmplot(TIPS, x="day", y="tip", series="sex", dodge=True, radius=2)
    assert marks(dodged)[0]["dodge"] is True and "<svg" in dodged.to_svg()
    with pytest.raises(ValueError, match="swarmplot warn_thresh: expected a share from 0 to 1"):
        hx.swarmplot(sparse, x="g", y="v", warn_thresh=2)


def test_swarm_warning_reads_the_value_axis_as_the_chart_draws_it():
    def quiet(**arguments: Any) -> None:
        with warnings.catch_warnings():
            warnings.simplefilter("error")
            hx.swarmplot(**arguments)

    # Values a trillion apart crowd near zero on a linear axis, but not on a log one.
    spread = {"g": np.repeat(["a"], 150), "v": np.geomspace(1, 1e12, 150)}
    with pytest.warns(UserWarning, match="g 'a'"):
        hx.swarmplot(spread, x="g", y="v")
    quiet(data=spread, x="g", y="v", y_axis=hg.Axis(type="log"))
    # A fixed domain far wider than the values crowds them.
    rng = np.random.default_rng(5)
    normal = {"g": np.repeat(["a"], 200), "v": rng.normal(0, 1, 200)}
    quiet(data=normal, x="g", y="v")
    with pytest.warns(UserWarning, match="g 'a'"):
        hx.swarmplot(normal, x="g", y="v", y_axis=hg.Axis(domain=(-1000, 1000)))
    # Panels of a value axis of their own lay their swarms out on it.
    panels = {
        "g": np.repeat(["a"], 200),
        "p": np.repeat(["low", "high"], 100),
        "v": np.concatenate([rng.normal(0, 1, 100), rng.normal(1e6, 1, 100)]),
    }
    with pytest.warns(UserWarning, match="g 'a'"):
        hx.swarmplot(panels, x="g", y="v", facet_column="p")
    quiet(data=panels, x="g", y="v", facet_column="p", resolve_y="independent")
    # Panels of a band axis of their own hold only their own categories, in wider bands.
    level = hg.Axis(domain=(-1, 1))
    bands = {"g": np.repeat(["a", "b"], 25), "p": np.repeat(["P1", "P2"], 25), "v": np.zeros(50)}
    with pytest.warns(UserWarning) as warned:
        hx.swarmplot(bands, x="g", y="v", facet_column="p", y_axis=level)
    assert ["g 'a' (p 'P1')" in str(w.message) for w in warned] == [True, False]
    quiet(data=bands, x="g", y="v", facet_column="p", y_axis=level, resolve_x="independent")
    # Band axes hold every category of their rows, drawn or not, and no other.
    logged = {
        "g": ["a"] * 25 + ["b", "c"],
        "p": ["P1"] * 26 + ["P2"],
        "v": [1.0] * 25 + [-1.0, 1.0],
    }
    with pytest.warns(UserWarning, match="g 'a' \\(p 'P1'\\)"):
        hx.swarmplot(
            logged,
            x="g",
            y="v",
            facet_column="p",
            resolve_x="independent",
            y_axis=hg.Axis(type="log", domain=(0.1, 10)),
        )
    alone = {"g": ["a"] * 50, "s": ["A"] * 50, "v": np.zeros(50)}
    quiet(data=alone, x="g", y="v", order=["a", "b"], y_axis=level)
    # Dodged series share bands as the chart's rows hold them, not unused levels.
    quiet(data=alone, x="g", y="v", series="s", series_order=["A", "B"], dodge=True, y_axis=level)
    # Points outside a fixed domain are not drawn, so not laid out.
    quiet(
        data={"g": ["a"] * 200, "v": np.full(200, 1000.0)},
        x="g",
        y="v",
        y_axis=hg.Axis(domain=(0, 1)),
    )


def test_swarm_warning_lays_points_out_as_the_core_does():
    from herceg.express import _swarm

    fixture = (
        Path(__file__).resolve().parents[2] / "packages/herceg/test/fixtures/swarm-layout.json"
    )
    for case in json.loads(fixture.read_text())["cases"]:
        edged, offsets = _swarm.pack(np.array(case["pixels"]), case["radius"], case["width"])
        assert edged == case["edged"]
        assert np.allclose(offsets, case["offsets"], atol=1e-6)


def test_histplot_fills_steps_frequencies_and_weights_follow_seaborn():
    statistics = pytest.importorskip("seaborn._statistics")
    flipper = PENGUINS["flipper"]
    weights = np.abs(PENGUINS["mass"]) / 1000
    data = {**PENGUINS, "w": weights}
    chart = hx.histplot(data, x="flipper", weight="w", normalize="frequency", bins=12)
    (mark,) = marks(chart)
    assert mark["weight"] == "w" and mark["normalize"] == "frequency"
    bins = hx.statistics(chart).tables["bins"]
    hist = statistics.Histogram(stat="frequency", bins=np.asarray(mark["bins"]))
    heights, _ = hist(flipper, weights=weights)
    assert np.allclose(bins["height"], heights, rtol=1e-12)
    with pytest.warns(
        UserWarning, match='histplot bins: "auto" bins cannot follow weights; using bins=10'
    ):
        auto = hx.histplot(data, x="flipper", weight="w")
    assert len(marks(auto)[0]["bins"]) == 11
    filled = hx.histplot(PENGUINS, x="flipper", series="species", multiple="fill", element="step")
    (fill_mark,) = marks(filled)
    assert fill_mark["stack"] == "fill" and fill_mark["element"] == "step"
    shares = hx.statistics(filled).tables["bins"]
    totals: dict[float, float] = {}
    for left, height in zip(shares["left"], shares["height"], strict=True):
        if np.isfinite(height):
            totals[left] = totals.get(left, 0.0) + height
    assert np.allclose(list(totals.values()), 1)
    spec, _ = filled.to_spec()
    assert spec["y"]["title"] == "Share of count"
    # Seaborn's filled bars hold the same shares, bin by bin.
    plt = _seaborn_axes()
    import pandas as pd
    import seaborn as sns

    ax = sns.histplot(
        pd.DataFrame(PENGUINS), x="flipper", hue="species", multiple="fill", bins=fill_mark["bins"]
    )
    theirs: dict[float, list[float]] = {}
    for patch in ax.patches:
        if patch.get_height() > 0:
            theirs.setdefault(round(patch.get_x(), 6), []).append(patch.get_height())
    ours: dict[float, list[float]] = {}
    for left, height in zip(shares["left"], shares["height"], strict=True):
        if height > 0:
            ours.setdefault(round(float(left), 6), []).append(float(height))
    assert set(ours) == set(theirs)
    for left, heights in ours.items():
        assert np.allclose(sorted(heights), sorted(theirs[left]), rtol=1e-9)
    plt.close("all")
    poly = hx.histplot(PENGUINS, x="flipper", element="poly")
    assert marks(poly)[0]["element"] == "poly" and "<path" in poly.to_svg()
    # Densities weigh only rows of positive weight: one such row has none.
    lone = hx.histplot(
        {"v": [0.0, 0.0, 1000.0], "w": [1.0, 1.0, 0.0]}, x="v", weight="w", bins=2, kde=True
    )
    assert len(hx.statistics(lone).tables["kde"]["density"]) == 0
    with pytest.raises(ValueError, match="histplot weight: column 'w' holds negative values"):
        hx.histplot({"v": [1.0, 2.0], "w": [1.0, -1.0]}, x="v", weight="w", bins=2)
    with pytest.raises(ValueError, match='histplot multiple: "dodge" places bars side by side'):
        hx.histplot(PENGUINS, x="flipper", series="species", multiple="dodge", element="step")
