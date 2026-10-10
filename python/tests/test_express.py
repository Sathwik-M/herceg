"""herceg.express: statistical charts in one call, made of herceg's marks."""

import math

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
    chart = hx.barplot(TIPS, x="day", y="tip", hue="sex", seed=3)
    bars, errors = marks(chart)
    assert bars == {
        "type": "bar",
        "x": "day",
        "y": "tip",
        "series": "sex",
        "legendGroup": "hue",
        "data": "data",
    }
    assert errors["dodge"] is True and errors["legendGroup"] == "hue"
    spec, _ = chart.to_spec()
    assert spec["x"]["label"] == "day" and spec["y"]["label"] == "tip"
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
            frame, x="day", y="tip", hue="sex", estimator=estimator, errorbar=errorbar, seed=11
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


def test_numbers_as_hue_are_categories_in_ascending_order():
    chart = hx.pointplot(TIPS, x="day", y="tip", hue="size", dodge=True, errorbar=("sd", 1))
    errors, points = marks(chart)
    assert points["dodge"] is True and errors["dodge"] is True
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


def test_lineplot_aggregates_x_values_with_a_band_per_hue_level():
    t = np.repeat(np.arange(10.0), 6)
    data = {"t": t, "g": np.tile(["a", "b"], 30), "v": np.sin(t) + RNG.normal(0, 0.1, 60)}
    chart = hx.lineplot(data, x="t", y="v", hue="g", seed=1)
    band_a, band_b, line = marks(chart)
    assert [band_a["label"], band_b["label"]] == ["a", "b"]
    assert band_a["type"] == "area" and band_a["legendGroup"] == line["legendGroup"] == "hue"
    assert line["series"] == "g"
    estimates = hx.statistics(chart).tables["estimates"]
    assert len(estimates["t"]) == 20 and estimates["n"].tolist() == [3.0] * 20
    raw = hx.lineplot(data, x="t", y="v", hue="g", estimator=None, errorbar=None)
    assert [mark["type"] for mark in marks(raw)] == ["line"]
    with pytest.raises(ValueError, match="errorbar=None"):
        hx.lineplot(data, x="t", y="v", estimator=None)
    bars = hx.lineplot(data, x="t", y="v", err_style="bars", errorbar=("se", 1))
    assert [mark["type"] for mark in marks(bars)] == ["errorbar", "line"]


def test_lineplot_keeps_time_x():
    stamps = np.array(["2026-01-01", "2026-01-01", "2026-01-02"], dtype="datetime64[ms]")
    chart = hx.lineplot({"t": stamps, "v": [1.0, 3.0, 5.0]}, x="t", y="v", errorbar=None)
    assert table(chart)["t"]["type"] == "time"
    assert hx.statistics(chart).tables["estimates"]["v"].tolist() == [2.0, 5.0]


# Fits ------------------------------------------------------------------------------


def test_regplot_fits_a_line_with_a_bootstrap_band_per_hue():
    x = RNG.uniform(0, 10, 80)
    data = {"x": x, "y": 2 * x + RNG.normal(0, 1, 80), "g": np.repeat(["a", "b"], 40)}
    chart = hx.regplot(data, x="x", y="y", hue="g", seed=5)
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
    curved = hx.regplot(data, x="x", y="y", order=3, ci=None, scatter=False)
    assert [mark["type"] for mark in marks(curved)] == ["line"]
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
    chart = hx.barplot(frame, x="day", y="tip", hue="sex", seed=2)
    reference = hx.barplot(TIPS, x="day", y="tip", hue="sex", seed=2)
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
        col="sex",
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
    with pytest.raises(ValueError, match="cannot be given with facet"):
        hx.barplot(TIPS, x="day", y="tip", col="sex", facet="day")
    described = hx.barplot(TIPS, x="day", y="tip", description="Tips by day.", errorbar=None)
    assert described.to_spec()[0]["description"].startswith("Tips by day. Bars show")


def test_mistakes_are_refused_with_the_column_or_option_named():
    with pytest.raises(KeyError, match="no column 'tips'"):
        hx.barplot(TIPS, x="day", y="tips")
    with pytest.raises(TypeError, match="holds category values; expected number"):
        hx.barplot(TIPS, x="day", y="sex")
    with pytest.raises(ValueError, match="errorbar method"):
        hx.barplot(TIPS, x="day", y="tip", errorbar=("iqr", 50))
    with pytest.raises(ValueError, match="level must be from above 0 to 100"):
        hx.barplot(TIPS, x="day", y="tip", errorbar=("ci", 120))
    with pytest.raises(ValueError, match="seed must be a whole number"):
        hx.barplot(TIPS, x="day", y="tip", seed=-1)
    with pytest.raises(ValueError, match="hue must differ"):
        hx.barplot(TIPS, x="day", y="tip", hue="day")
    with pytest.raises(ValueError, match="estimator must be one of"):
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
    for stat, common_norm in (("count", True), ("density", True), ("probability", False)):
        chart = hx.histplot(
            PENGUINS, x="flipper", hue="species", stat=stat, common_norm=common_norm
        )
        (mark,) = marks(chart)
        expected_edges = np.histogram_bin_edges(flipper, "auto")
        assert np.allclose(mark["bins"], expected_edges, rtol=1e-12)
        assert mark["normalize"] == {"probability": "probability"}.get(stat, stat)
        assert mark.get("commonNorm") is (True if common_norm else None)
        bins = hx.statistics(chart).tables["bins"]
        for level in ("Adelie", "Gentoo", "Chinstrap"):
            members = flipper[PENGUINS["species"] == level]
            hist = statistics.Histogram(stat=stat, bins=expected_edges)
            heights, _ = hist(members)
            if common_norm and stat != "count":
                heights = heights * len(members) / len(flipper)
            assert np.allclose(bins["height"][bins["species"] == level], heights, rtol=1e-12)
    assert "<svg" in chart.to_svg()


def test_histplot_kde_overlays_match_seaborns_lines():
    plt = _seaborn_axes()
    import pandas as pd
    import seaborn as sns

    frame = pd.DataFrame(PENGUINS)
    for stat, cumulative in (("count", False), ("density", False), ("percent", True)):
        chart = hx.histplot(
            frame, x="flipper", hue="species", stat=stat, cumulative=cumulative, kde=True
        )
        kde = hx.statistics(chart).tables["kde"]
        ax = sns.histplot(
            frame, x="flipper", hue="species", stat=stat, cumulative=cumulative, kde=True
        )
        curves = _lines_by_x(ax)
        for level in ("Adelie", "Gentoo", "Chinstrap"):
            rows = kde["species"] == level
            assert _matches(kde["flipper"][rows], kde["density"][rows], curves), (stat, level)
        plt.close("all")


def test_histplot_layouts_orientation_and_refusals():
    stacked = hx.histplot(PENGUINS, x="flipper", hue="species", multiple="stack")
    assert marks(stacked)[0]["stack"] is True
    dodged = hx.histplot(PENGUINS, y="flipper", hue="species", multiple="dodge", binwidth=5)
    (mark,) = marks(dodged)
    assert mark["y"] == "flipper" and mark["dodge"] is True
    assert np.allclose(np.diff(mark["bins"]), 5)
    spec, _ = dodged.to_spec()
    assert spec["x"]["label"] == "Count" and spec["y"]["label"] == "flipper"
    assert spec["version"] == 10
    discrete = hx.histplot({"n": [1, 2, 2, 5]}, x="n", discrete=True)
    assert marks(discrete)[0]["bins"] == [0.5, 1.5, 2.5, 3.5, 4.5, 5.5]
    with pytest.raises(ValueError, match="exactly one of x and y"):
        hx.histplot(PENGUINS, x="flipper", y="mass")
    with pytest.raises(ValueError, match="layered bars only"):
        hx.histplot(PENGUINS, x="flipper", hue="species", multiple="stack", kde=True)
    with pytest.raises(ValueError, match="cannot draw kernel densities over horizontal bars"):
        hx.histplot(PENGUINS, y="flipper", kde=True)
    with pytest.raises(ValueError, match="stat must be one of"):
        hx.histplot(PENGUINS, x="flipper", stat="frequency")  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="kde_kws takes"):
        hx.histplot(PENGUINS, x="flipper", kde=True, kde_kws={"bandwidth": 1})  # type: ignore[typeddict-unknown-key]


def test_kdeplot_matches_seaborns_curves():
    plt = _seaborn_axes()
    import pandas as pd
    import seaborn as sns

    frame = pd.DataFrame(PENGUINS)
    for kwargs in (
        {},
        {"bw_method": "silverman", "bw_adjust": 0.5, "cut": 1},
        {"common_norm": False, "cumulative": True, "gridsize": 50},
    ):
        chart = hx.kdeplot(frame, x="flipper", hue="species", **kwargs)
        density = hx.statistics(chart).tables["density"]
        ax = sns.kdeplot(frame, x="flipper", hue="species", **kwargs)
        curves = _lines_by_x(ax)
        for level in ("Adelie", "Gentoo", "Chinstrap"):
            rows = density["species"] == level
            assert _matches(density["flipper"][rows], density["density"][rows], curves), level
        plt.close("all")
    filled = hx.kdeplot(frame, x="flipper", fill=True)
    assert [mark["type"] for mark in marks(filled)] == ["area"]
    # Lines along y would be read by x: refused rather than misread.
    with pytest.raises(ValueError, match="kdeplot cannot draw densities along y yet"):
        hx.kdeplot(frame, y="flipper")


def test_bivariate_kde_is_a_density_heatmap_per_panel():
    stats = pytest.importorskip("scipy.stats")
    chart = hx.kdeplot(PENGUINS, x="flipper", y="mass", gridsize=30)
    (heatmap,) = marks(chart)
    assert heatmap["type"] == "heatmap" and heatmap["value"] == "density"
    density = hx.statistics(chart).tables["density"]
    kde = stats.gaussian_kde(np.vstack([PENGUINS["flipper"], PENGUINS["mass"]]))
    expected = kde(np.vstack([density["flipper"], density["mass"]]))
    expected[expected < expected.max() * 1e-9] = 0
    assert np.allclose(density["density"], expected, rtol=1e-9, atol=1e-15)
    faceted = hx.kdeplot(PENGUINS, x="flipper", y="mass", col="sex", gridsize=20)
    assert faceted.to_spec()[0]["facet"] == {"column": "sex"}
    with pytest.raises(ValueError, match="facet by col or row instead of hue"):
        hx.kdeplot(PENGUINS, x="flipper", y="mass", hue="species")


def test_ecdfplot_steps_match_seaborn():
    plt = _seaborn_axes()
    import pandas as pd
    import seaborn as sns

    frame = pd.DataFrame(PENGUINS)
    for stat, complementary in (("proportion", False), ("count", True), ("percent", False)):
        chart = hx.ecdfplot(
            frame, x="flipper", hue="species", stat=stat, complementary=complementary
        )
        steps = hx.statistics(chart).tables["ecdf"]
        share = stat.capitalize()
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
    with pytest.raises(ValueError, match="ecdfplot cannot draw steps along y yet"):
        hx.ecdfplot(PENGUINS, y="flipper")
    # Every point read is an observation's step: [1, 2, 3] reads 1/3 first, a lone value 1.
    for sample, complementary, first in (
        ([1.0, 2.0, 3.0], False, 1 / 3),
        ([1.0, 2.0, 3.0], True, 2 / 3),
        ([5.0], False, 1.0),
    ):
        ecdf = hx.statistics(hx.ecdfplot({"v": sample}, x="v", complementary=complementary))
        assert list(ecdf.tables["ecdf"]["v"]) == sample
        assert ecdf.tables["ecdf"]["Proportion"][0] == pytest.approx(first)
    # A level of one distinct value has no step: it shows as a point, the others as steps.
    mixed = hx.ecdfplot(
        {"v": [5.0, 5.0, 1.0, 2.0], "g": ["a", "a", "b", "b"]},
        x="v",
        hue="g",
        hue_order=["a", "b"],
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


def test_strip_box_and_violin_plots():
    strip = hx.stripplot(PENGUINS, x="species", y="flipper", hue="sex", dodge=True, seed=4)
    (points,) = marks(strip)
    assert points["dodge"] is True and points["jitter"] == {"width": 0.25, "seed": 4}
    assert hx.statistics(strip).seed == 4
    plain = hx.stripplot(PENGUINS, x="flipper", y="species", jitter=False)
    assert "jitter" not in marks(plain)[0] and hx.statistics(plain).seed is None
    assert marks(hx.stripplot(PENGUINS, x="species", y="flipper", jitter=0.3, seed=1))[0]["jitter"][
        "width"
    ] == pytest.approx(0.75)
    box = hx.boxplot(PENGUINS, x="species", y="flipper", hue="sex", whis=2, notch=True)
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
    summary = hx.boxplot(PENGUINS, x="species", y="flipper", showfliers=False)
    (mark,) = marks(summary)
    assert mark["median"] == "median" and mark["count"] == "n" and "y" not in mark
    ranged = hx.boxplot(PENGUINS, x="species", y="flipper", whis=math.inf)
    assert marks(ranged)[0]["whiskers"] == "range"
    violin = hx.violinplot(PENGUINS, x="flipper", y="species", bandwidth=2)
    (mark,) = marks(violin)
    assert mark["type"] == "violin" and mark["x"] == "flipper" and mark["bandwidth"] == 2
    assert "split" not in mark and "inner" not in mark
    halves = hx.violinplot(PENGUINS, x="species", y="flipper", hue="sex", split=True, inner="quart")
    (mark,) = marks(halves)
    assert mark["split"] is True and mark["inner"] == "quartiles"
    assert halves.to_spec()[0]["version"] == 10
    assert "each level of the hue on one side" in hx.statistics(halves).description
    assert (
        marks(hx.violinplot(PENGUINS, x="species", y="flipper", inner=None))[0]["inner"] == "none"
    )
    with pytest.raises(ValueError, match="needs a hue of at most two levels"):
        hx.violinplot(PENGUINS, x="sex", y="flipper", hue="species", split=True)
    with pytest.raises(ValueError, match="needs a hue"):
        hx.violinplot(PENGUINS, x="species", y="flipper", split=True)
    with pytest.raises(ValueError, match="inner must be"):
        hx.violinplot(PENGUINS, x="species", y="flipper", inner="stick")  # type: ignore[arg-type]
    for chart in (strip, box, summary, violin, halves):
        assert "<svg" in chart.to_svg()


def test_express_charts_render_and_update_wherever_charts_do():
    chart = hx.stripplot(PENGUINS, x="species", y="flipper", hue="sex", seed=1, title="Strips")
    assert "<svg" in chart.to_svg() and "Strips" in chart.to_html()
    assert chart.to_png().startswith(b"\x89PNG") and chart.to_pdf().startswith(b"%PDF")
    pytest.importorskip("anywidget")
    widget = chart.widget()
    # Rows the chart draws stream in as in any chart; jitter keeps earlier points in place.
    widget.append({"species": ["Adelie"], "flipper": [200.0], "sex": ["f"]})
    widget.update(title="More strips")
    with pytest.raises(ValueError, match="resolve_x must be 'shared'"):
        hx.pairplot(PENGUINS, vars=["flipper", "mass"]).widget()
    streamlit = pytest.importorskip("herceg.streamlit")
    spec, buffers = hx.histplot(PENGUINS, x="flipper", kde=True).to_spec()
    assert len(streamlit._payload(spec, buffers, [])) % 8 == 0


# Arrangements -------------------------------------------------------------------------


def test_pairplot_pairs_every_number_column_in_subplots():
    data = {key: PENGUINS[key] for key in ("species", "flipper", "mass")}
    data["bill"] = PENGUINS["mass"] / 100 + RNG.normal(0, 3, PENGUINS_N)
    chart = hx.pairplot(data, hue="species")
    spec, _ = chart.to_spec()
    assert [panel["id"] for panel in spec["panels"]] == [
        f"{i},{j}" for i in range(3) for j in range(3)
    ]
    assert spec["grid"]["columns"] == 3
    assert spec["resolve"] == {"x": "columns", "y": "independent"}
    kinds = {mark["panel"]: mark["type"] for mark in spec["marks"]}
    assert kinds == {
        f"{i},{j}": "line" if i == j else "point" for i in range(3) for j in range(3)
    }  # densities on the diagonal with hue
    # The scatter plots of a row show one y range.
    first, second = spec["panels"][1]["y"]["domain"], spec["panels"][2]["y"]["domain"]
    assert first == second == [float(data["flipper"].min()), float(data["flipper"].max())]
    assert all(mark.get("legendGroup") == "hue" for mark in spec["marks"])
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
    for grouping in ({"col": "v"}, {"hue": "v"}, {"row": "v"}):
        with pytest.raises(ValueError, match="is also plotted on an axis"):
            hx.histplot(data, x="v", **grouping)
    with pytest.raises(ValueError, match="is also plotted on an axis"):
        hx.regplot({"v": [1.0, 2.0], "w": [1.0, 2.0]}, x="v", y="w", hue="w")
    # Categories and values cannot share a column either.
    for function in (hx.barplot, hx.pointplot, hx.stripplot, hx.boxplot, hx.violinplot):
        with pytest.raises(ValueError, match="x and y name the same column 'v'"):
            function(data, x="v", y="v")


def test_pairplot_diagonal_densities_follow_their_rows_hue():
    # The first row has no hue: densities must still pair each value with its own level.
    data = {"v": [100.0, 0, 1, 2, 10, 11, 12], "h": [None, "a", "a", "a", "b", "b", "b"]}
    pair = hx.statistics(hx.pairplot(data, vars=["v"], hue="h", diag_kind="kde"))
    alone = hx.statistics(hx.kdeplot({"v": data["v"][1:], "h": data["h"][1:]}, x="v", hue="h"))
    ours, theirs = pair.tables["v density"], alone.tables["density"]
    assert list(ours["h"]) == list(theirs["h"])
    assert np.allclose(ours["v"], theirs["v"]) and np.allclose(ours["density"], theirs["density"])


def test_pairplot_keeps_hue_colors_when_a_diagonal_density_lacks_a_level():
    data = {"u": [5.0, 5.0, 5.0, 1, 2, 3], "v": [1.0, 2, 3, 4, 5, 6], "h": ["a"] * 3 + ["b"] * 3}
    svg = hx.pairplot(
        data, hue="h", hue_order=["a", "b"], palette=["#ff0000", "#0000ff"], diag_kind="kde"
    ).to_svg()
    assert svg.index(">a</text>") < svg.index(">b</text>")
    assert "#ff0000" in svg.split(">a</text>")[0][-160:]


def test_jointplot_shares_the_scatter_plots_scales_with_its_margins():
    data = {"x": PENGUINS["flipper"].copy(), "y": PENGUINS["mass"].copy(), "g": PENGUINS["sex"]}
    data["y"][:5] = np.nan
    chart = hx.jointplot(data, x="x", y="y", hue="g")
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
    chart = hx.rugplot(PENGUINS, x="flipper", hue="species", length=10)
    (rug,) = marks(chart)
    assert rug["type"] == "rug" and rug["x"] == "flipper" and rug["length"] == 10
    assert rug["series"] == "species" and rug["legendGroup"] == "hue"
    sideways = hx.rugplot(PENGUINS, y="mass")
    assert marks(sideways)[0]["y"] == "mass"
    assert "<svg" in chart.to_svg()


def test_clustermap_takes_only_options_both_clusterings_support():
    values = {"a": [1.0, 2.0, 4.0], "b": [2.0, 1.0, 3.0]}
    with pytest.raises(ValueError, match="clustering method must be one of"):
        hx.clustermap(values, method="centroid")  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="clustering metric must be one of"):
        hx.clustermap(values, metric="chebyshev")  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="ward linkage needs the euclidean metric"):
        hx.clustermap(values, method="ward", metric="cityblock")


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
    chart = hx.boxplot(data, x="low", y="n", showfliers=False)
    (mark,) = marks(chart)
    assert mark["x"] == "low" and mark["low"] == "low_" and mark["count"] == "n_"
    assert "<svg" in chart.to_svg()
    kde = hx.kdeplot(
        {"v": [1.0, 2.0, 2.5, 4.0], "density": ["a", "a", "b", "b"]}, x="v", hue="density"
    )
    (line,) = marks(kde)
    assert line["series"] == "density" and line["y"] == "density_"
    # Histogram statistics beside a hue named as one of their columns.
    hist = hx.histplot({"v": [1.0, 2.0, 3.0], "left": ["a", "b", "b"]}, x="v", hue="left", bins=2)
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


@pytest.mark.parametrize("whis", [0, 0.25, 1.5, math.inf])
def test_box_statistics_keep_their_order_for_any_whiskers(whis):
    for sample in ([0.0, 1.0], [0.0, 1.0, 2.0], [0.0, 0.0, 0.0, 9.0]):
        data = {"g": ["a"] * len(sample), "v": sample}
        boxes = hx.statistics(hx.boxplot(data, x="g", y="v", whis=whis)).tables["boxes"]
        low, q1, median, q3, high = (boxes[k][0] for k in ("low", "q1", "median", "q3", "high"))
        if whis != 1.5:
            assert low <= q1 <= median <= q3 <= high
        assert boxes["n"][0] == len(sample)
        assert "<svg" in hx.boxplot(data, x="g", y="v", whis=whis, showfliers=False).to_svg()


def test_empty_and_missing_distributions_draw_empty_charts():
    for values in ([], [float("nan"), float("nan")]):
        data = {"v": values, "g": ["a"] * len(values)}
        for chart in (
            hx.ecdfplot(data, x="v"),
            hx.ecdfplot(data, x="v", hue="g"),
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
    hx.histplot(PENGUINS, x="flipper", bins=[170, 190, 195, 240], kde=True, stat="density")
