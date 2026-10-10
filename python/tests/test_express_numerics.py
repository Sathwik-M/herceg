"""herceg.express's statistics against NumPy, SciPy, statsmodels, and Seaborn.

The references are in the dev extra; tests of one skip when it is missing.
"""

import math

import numpy as np
import pytest

from herceg.express import _numerics as numerics

RNG = np.random.default_rng(20261010)


def _seaborn_statistics():
    return pytest.importorskip("seaborn._statistics")


# Estimates and intervals ----------------------------------------------------------


@pytest.mark.parametrize("estimator", ["mean", "median"])
@pytest.mark.parametrize(
    "errorbar", [("ci", 95), ("ci", 68), ("pi", 50), ("se", 1), ("se", 2), ("sd", 1)]
)
def test_intervals_match_seaborns_aggregator(estimator, errorbar):
    pd = pytest.importorskip("pandas")
    stats = _seaborn_statistics()
    sample = RNG.gamma(2.0, 3.0, 157)
    aggregator = stats.EstimateAggregator(estimator, errorbar, n_boot=1000, seed=42)
    expected = aggregator(pd.DataFrame({"v": sample}), "v")
    center, low, high = numerics.interval(sample, estimator, *errorbar, n_boot=1000, seed=42)
    assert center == pytest.approx(expected["v"], rel=1e-12)
    assert low == pytest.approx(expected["vmin"], rel=1e-12)
    assert high == pytest.approx(expected["vmax"], rel=1e-12)


def test_bootstrap_resamples_as_seaborn_does_whatever_the_chunks(monkeypatch):
    algorithms = pytest.importorskip("seaborn.algorithms")
    sample = RNG.normal(10, 3, 1001)
    expected = algorithms.bootstrap(sample, func="mean", n_boot=500, seed=7)
    assert np.allclose(numerics.bootstrap_estimates(sample, "mean", 500, 7), expected, rtol=1e-13)
    # Chunks of 3 resamples draw the same indices as one chunk of 500.
    monkeypatch.setattr(numerics, "_BUDGET", 3 * 24 * len(sample))
    assert np.allclose(numerics.bootstrap_estimates(sample, "mean", 500, 7), expected, rtol=1e-13)


def test_groups_of_one_value_have_no_interval():
    for method, level in (("ci", 95), ("pi", 95), ("se", 1), ("sd", 1)):
        center, low, high = numerics.interval(np.array([3.0]), "mean", method, level, 100, 0)
        assert center == 3.0 and math.isnan(low) and math.isnan(high)
    center, low, high = numerics.interval(np.array([]), "mean", "ci", 95, 100, 0)
    assert math.isnan(center) and math.isnan(low)


# Fits ------------------------------------------------------------------------------


def test_polynomial_fits_match_numpy():
    x = RNG.uniform(-3, 5, 80)
    y = 2 - 1.5 * x + 0.3 * x**2 + RNG.normal(0, 0.5, 80)
    grid = np.linspace(-3, 5, 7)
    for order in (1, 2, 3):
        fit = numerics.polynomial_fit(x, y, order)
        assert np.allclose(fit.in_x(), np.polyfit(x, y, order)[::-1], rtol=1e-8)
        assert np.allclose(fit(grid), np.polyval(np.polyfit(x, y, order), grid), rtol=1e-9)


def test_fits_of_predictors_far_from_zero_are_exact():
    # Epoch milliseconds: an unscaled design loses the slope entirely.
    x = 1.7e12 + np.arange(10.0) * 60_000
    y = 3 + 2 * (x - 1.7e12) / 60_000
    for order in (1, 2):
        fit = numerics.polynomial_fit(x, y, order)
        assert np.allclose(fit(x), y, rtol=1e-9)
        fits = numerics.bootstrap_fits(x, y, x, order, 50, 1)
        assert fits.usable == 50 and np.allclose(fits.predictions, y, rtol=1e-9)


def test_resamples_that_cannot_determine_a_fit_are_counted_and_left_out():
    x, y = np.array([0.0, 1.0, 2.0]), np.array([0.0, 1.0, 4.0])
    fits = numerics.bootstrap_fits(x, y, np.linspace(0, 2, 5), 2, 100, 42)
    # Resamples need all three x values for a quadratic.
    assert 0 < fits.too_few < 100 and fits.unstable == 0
    assert np.isnan(fits.predictions).all(axis=1).sum() == fits.too_few
    usable = fits.predictions[~np.isnan(fits.predictions).any(axis=1)]
    assert len(usable) == fits.usable
    assert np.allclose(usable, np.linspace(0, 2, 5) ** 2)


def test_each_resample_is_fit_in_its_own_scaled_predictor():
    # An outlier the sample's scaling is dominated by; resamples without it
    # are well conditioned on their own and fit as NumPy fits them.
    x = np.append(np.linspace(0, 1, 49), 100.0)
    y = np.sin(x) + RNG.normal(0, 0.1, 50)
    grid = np.linspace(0, 1, 9)
    fits = numerics.bootstrap_fits(x, y, grid, 4, 100, 42)
    assert fits.usable + fits.too_few + fits.unstable == 100
    rng = np.random.default_rng(42)
    without = 0
    for prediction in fits.predictions:
        rows = rng.integers(0, 50, 50)
        if 49 in rows:
            continue
        without += 1
        expected = np.polyval(np.polyfit(x[rows], y[rows], 4), grid)
        assert np.allclose(prediction, expected, rtol=1e-7, atol=1e-9)
    assert without > 20


def test_linear_fits_and_bands_match_statsmodels_and_seaborn():
    sm = pytest.importorskip("statsmodels.api")
    regression = pytest.importorskip("seaborn.regression")
    x = RNG.uniform(0, 10, 60)
    y = 3 + 0.8 * x + RNG.normal(0, 1, 60)
    ols = sm.OLS(y, sm.add_constant(x)).fit()
    assert np.allclose(numerics.polynomial_fit(x, y, 1).in_x(), ols.params, rtol=1e-10)
    grid = np.linspace(x.min(), x.max(), 100)
    for order in (1, 2):
        plotter = regression._RegressionPlotter(x, y, order=order, n_boot=300, seed=11, ci=95)
        _, fit, (low, high) = plotter.fit_regression(grid=grid)
        assert np.allclose(numerics.polynomial_fit(x, y, order)(grid), fit, rtol=1e-9)
        fits = numerics.bootstrap_fits(x, y, grid, order, 300, 11)
        assert fits.usable == 300
        ours = numerics.band(fits.predictions, 95)
        assert np.allclose(ours[0], low, rtol=1e-8)
        assert np.allclose(ours[1], high, rtol=1e-8)


@pytest.mark.parametrize(
    "case",
    [
        {"frac": 2 / 3, "it": 3, "delta": 0.0},
        {"frac": 0.3, "it": 0, "delta": 0.0},
        {"frac": 0.2, "it": 2, "delta": 0.4},
        {"frac": 0.05, "it": 3, "delta": 0.0},
    ],
)
def test_lowess_matches_statsmodels(case):
    smoothers = pytest.importorskip("statsmodels.nonparametric.smoothers_lowess")
    x = np.round(RNG.uniform(0, 20, 300), 1)  # ties included
    y = np.sin(x / 3) * 4 + RNG.standard_t(3, 300)
    expected = smoothers.lowess(y, x, **case)
    grid, fit = numerics.lowess(x, y, **case)
    assert np.array_equal(grid, expected[:, 0])
    assert np.allclose(fit, expected[:, 1], rtol=1e-7, atol=1e-9)


# statsmodels divides by a zero spread for rows of one x.
@pytest.mark.filterwarnings("ignore::RuntimeWarning")
def test_lowess_of_tiny_and_degenerate_samples():
    smoothers = pytest.importorskip("statsmodels.nonparametric.smoothers_lowess")
    for x, y in (
        (np.array([1.0, 2.0]), np.array([3.0, 5.0])),
        (np.array([1.0, 1.0, 1.0]), np.array([3.0, 4.0, 5.0])),
        (np.arange(6.0), np.ones(6)),
    ):
        expected = smoothers.lowess(y, x)
        grid, fit = numerics.lowess(x, y)
        assert np.array_equal(grid, expected[:, 0])
        assert np.allclose(fit, expected[:, 1], rtol=1e-7, atol=1e-9)


# Kernel densities --------------------------------------------------------------------


@pytest.mark.parametrize("method", ["scott", "silverman", 0.4])
@pytest.mark.parametrize("adjust", [1.0, 0.5])
def test_kde_matches_scipy(method, adjust):
    stats = pytest.importorskip("scipy.stats")
    sample = np.concatenate([RNG.normal(0, 1, 300), RNG.normal(4, 0.5, 100)])
    kde = stats.gaussian_kde(sample, bw_method=method)
    kde.set_bandwidth(kde.factor * adjust)
    deviation = math.sqrt(numerics.kernel_covariance(sample, None, method, adjust)[0, 0])
    assert deviation == pytest.approx(math.sqrt(kde.covariance[0, 0]), rel=1e-12)
    grid = numerics.support(sample, deviation, 3, (None, None), 200)
    assert np.allclose(numerics.density(sample, None, deviation, grid), kde(grid), rtol=1e-10)
    cumulative = numerics.cumulative_density(sample, None, deviation, grid)
    expected = np.r_[0, [kde.integrate_box_1d(grid[0], g) for g in grid[1:]]]
    assert np.allclose(cumulative, expected, atol=2e-7)


def test_kde_support_and_density_match_seaborn():
    stats = _seaborn_statistics()
    sample = RNG.lognormal(0, 0.6, 250)
    estimator = stats.KDE(bw_method="scott", bw_adjust=1.5, gridsize=120, cut=2, clip=(0.2, None))
    expected, grid = estimator(sample)
    deviation = math.sqrt(numerics.kernel_covariance(sample, None, "scott", 1.5)[0, 0])
    ours = numerics.support(sample, deviation, 2, (0.2, None), 120)
    assert np.allclose(ours, grid, rtol=1e-12)
    assert np.allclose(numerics.density(sample, None, deviation, ours), expected, rtol=1e-10)


def test_kde_2d_matches_scipy():
    stats = pytest.importorskip("scipy.stats")
    x = RNG.normal(0, 1, 200)
    y = 0.6 * x + RNG.normal(0, 0.8, 200)
    kde = stats.gaussian_kde(np.vstack([x, y]))
    covariance = numerics.kernel_covariance(np.vstack([x, y]), None, "scott", 1.0)
    assert np.allclose(covariance, kde.covariance, rtol=1e-12)
    xs, ys = np.linspace(-3, 3, 15), np.linspace(-2, 2, 11)
    grid = numerics.density_2d(x, y, None, covariance, xs, ys)
    gx, gy = np.meshgrid(xs, ys)
    expected = kde(np.vstack([gx.ravel(), gy.ravel()])).reshape(len(ys), len(xs))
    assert np.allclose(grid, expected, rtol=1e-10)


def test_lowess_keeps_its_precision_far_from_zero():
    x = 1e12 + np.arange(100) * 2e-4
    z = x - x[0]
    for y in (3 + 2 * z, np.sin(10 * z / z[-1])):
        for delta, it in ((0.0, 0), (0.0, 3), (2e-3, 1)):
            grid, far = numerics.lowess(x, y, it=it, delta=delta)
            _, near = numerics.lowess(z, y, it=it, delta=delta)
            assert np.array_equal(grid, x) and np.allclose(far, near, rtol=0, atol=1e-12)


def test_kde_2d_keeps_its_precision_far_from_zero():
    u = RNG.normal(0, 1, 120)
    x, y = 0.01 * u, 0.01 * (0.8 * u + RNG.normal(0, 0.6, 120))
    covariance = numerics.kernel_covariance(np.vstack([x, y]), None, "scott", 1.0)
    xs, ys = np.linspace(-0.03, 0.03, 13), np.linspace(-0.03, 0.03, 9)
    x, y, xs, ys = x + 1e12, y - 1e12, xs + 1e12, ys - 1e12
    far = numerics.density_2d(x, y, None, covariance, xs, ys)
    # Directly from the differences, which floats this close subtract exactly.
    gx, gy = np.meshgrid(xs, ys)
    d = np.stack([gx.ravel()[:, None] - x[None, :], gy.ravel()[:, None] - y[None, :]], axis=-1)
    q = np.einsum("...i,ij,...j->...", d, np.linalg.inv(covariance), d)
    norm = 2 * np.pi * np.sqrt(np.linalg.det(covariance))
    expected = (np.exp(-0.5 * q).mean(axis=1) / norm).reshape(len(ys), len(xs))
    assert np.allclose(far, expected, rtol=1e-8, atol=expected.max() * 1e-12)


def test_normal_cdf_is_accurate_to_about_1e7():
    special = pytest.importorskip("scipy.special")
    z = np.linspace(-9, 9, 10001)
    assert np.max(np.abs(numerics.normal_cdf(z) - special.ndtr(z))) < 2e-7


# Distributions -----------------------------------------------------------------------


@pytest.mark.parametrize("stat", ["proportion", "percent", "count"])
@pytest.mark.parametrize("complementary", [False, True])
def test_ecdf_matches_seaborn(stat, complementary):
    stats = _seaborn_statistics()
    sample = np.round(RNG.normal(0, 1, 120), 1)
    heights, edges = stats.ECDF(stat=stat, complementary=complementary)(sample)
    distinct, ours = numerics.ecdf(sample, None, stat, complementary)
    # Seaborn's has a step per value from -inf; ours one per distinct value.
    last = {value: height for value, height in zip(edges[1:], heights[1:], strict=True)}
    assert np.array_equal(distinct, np.unique(sample))
    assert np.allclose(ours, [last[v] for v in distinct], rtol=1e-12)


@pytest.mark.parametrize("stat", ["count", "density", "probability", "percent", "frequency"])
@pytest.mark.parametrize("cumulative", [False, True])
def test_histograms_match_seaborn(stat, cumulative):
    stats = _seaborn_statistics()
    sample = RNG.gamma(3.0, 2.0, 500)
    for bins, binwidth, binrange, discrete in (
        ("auto", None, None, False),
        (12, None, (1.0, 15.0), False),
        ("auto", 0.7, None, False),
        ("auto", None, None, True),
    ):
        values = np.round(sample) if discrete else sample
        hist = stats.Histogram(
            stat=stat,
            bins=bins,
            binwidth=binwidth,
            binrange=binrange,
            discrete=discrete,
            cumulative=cumulative,
        )
        expected, expected_edges = hist(values)
        edges = numerics.bin_edges(values, None, bins, binwidth, binrange, discrete)
        assert np.allclose(edges, expected_edges, rtol=1e-12)
        heights = numerics.histogram(values, None, edges, stat, cumulative)
        assert np.allclose(heights, expected, rtol=1e-12)


def test_densities_of_bins_that_count_nothing_are_zero():
    # Every value outside the edges: the histogram mark draws no bars.
    heights = numerics.histogram(
        np.array([-2.0, -1.0, 4.0, 5.0]), None, np.array([0.0, 1, 3]), "density", False
    )
    assert heights.tolist() == [0.0, 0.0]
    assert numerics.ecdf(np.array([]), None, "proportion", False)[0].size == 0


def test_discrete_bins_center_on_integers():
    edges = numerics.bin_edges(np.array([1.0, 2.0, 2.0, 5.0]), None, "auto", None, None, True)
    assert list(edges) == [0.5, 1.5, 2.5, 3.5, 4.5, 5.5]


# Clustering --------------------------------------------------------------------------


@pytest.mark.parametrize("method", ["average", "single", "complete", "weighted", "ward"])
def test_numpy_linkage_matches_scipy(method):
    hierarchy = pytest.importorskip("scipy.cluster.hierarchy")
    rows = RNG.normal(0, 1, (40, 6))
    expected = hierarchy.linkage(rows, method=method, metric="euclidean")
    ours = numerics._linkage_numpy(rows, method, "euclidean")
    assert np.allclose(ours, expected, rtol=1e-10)
    assert np.array_equal(numerics.leaves(ours, 40), hierarchy.leaves_list(expected))


def test_numpy_linkage_keeps_distances_far_from_the_origin():
    hierarchy = pytest.importorskip("scipy.cluster.hierarchy")
    rows = np.array([[1e9, 1e9], [1e9 + 1, 1e9], [1e9 + 3, 1e9]])
    ours = numerics._linkage_numpy(rows, "average", "euclidean")
    assert np.allclose(ours[:, 2], hierarchy.linkage(rows, "average")[:, 2])
    assert ours[:, 2].tolist() == [1.0, 2.5]


@pytest.mark.parametrize("metric", ["cityblock", "cosine", "correlation", "sqeuclidean"])
def test_numpy_distances_match_scipy(metric):
    distance = pytest.importorskip("scipy.spatial.distance")
    rows = RNG.normal(0, 1, (12, 5))
    expected = distance.squareform(distance.pdist(rows, metric=metric))
    assert np.allclose(numerics.distances(rows, metric), expected, atol=1e-12)
