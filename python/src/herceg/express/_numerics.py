"""The statistics express charts draw, in NumPy.

Each function follows the definition Seaborn uses (and SciPy or statsmodels
behind it), so that results can be checked against those libraries:

- intervals: Seaborn's ``EstimateAggregator`` (bootstrap percentile
  intervals, standard errors and deviations with ``ddof=1``, percentile
  intervals of the data);
- resampling: ``numpy.random.default_rng(seed)``, drawing each resample's
  indices as Seaborn's ``bootstrap`` does, so a seed gives Seaborn's
  resamples;
- polynomial fits: least squares (``numpy.linalg.lstsq``) in the predictor
  scaled to mean 0 and standard deviation 1, so predictors far from zero
  (epoch milliseconds) fit exactly; Seaborn's ``pinv`` and ``polyfit``
  give the same fits on well-conditioned data;
- lowess: statsmodels' ``lowess`` (tricube weights, ``it`` robustifying
  passes with bisquare weights, ``delta`` interpolation);
- kernel densities: ``scipy.stats.gaussian_kde`` (Scott's and Silverman's
  factors on the weighted sample covariance) on Seaborn's support grid;
- hierarchical clustering: ``scipy.cluster.hierarchy.linkage`` row layout and
  ``dendrogram`` leaf order.

Work over resamples, kernels, windows, and distances is done in chunks whose
arrays together take at most about ``_BUDGET`` bytes, so memory stays
bounded for large inputs.
"""

from __future__ import annotations

import math
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Literal, get_args

import numpy as np

#: Bytes the arrays of one chunk of resamples, kernels, or windows take together.
_BUDGET = 64 << 20

Estimator = Literal["mean", "median"]
ErrorMethod = Literal["ci", "pi", "se", "sd"]


def _per_chunk(item_bytes: int, items: int) -> int:
    """How many units of `items` elements fit in the budget, each element
    taking `item_bytes` across the arrays a chunk holds at once; at least 1."""
    return max(1, _BUDGET // max(item_bytes * items, 1))


# Estimates and intervals -------------------------------------------------------


def estimate(values: np.ndarray, estimator: Estimator) -> float:
    """The mean or median of finite values; NaN when there are none."""
    if len(values) == 0:
        return math.nan
    return float(np.mean(values) if estimator == "mean" else np.median(values))


def _reduce(samples: np.ndarray, estimator: Estimator) -> np.ndarray:
    """The estimator over each row of a (resamples, n) array."""
    return np.mean(samples, axis=1) if estimator == "mean" else np.median(samples, axis=1)


def resamples(
    n: int, n_boot: int, rng: np.random.Generator, item_bytes: int
) -> Iterator[np.ndarray]:
    """Index arrays of ``n_boot`` resamples of ``n`` rows, a chunk of
    resamples at a time, sized for `item_bytes` per resampled row.

    The indices are those of ``n_boot`` successive ``rng.integers(0, n, n)``
    draws (Seaborn's), whatever the chunking.
    """
    per_chunk = _per_chunk(item_bytes, n)
    done = 0
    while done < n_boot:
        count = min(per_chunk, n_boot - done)
        yield rng.integers(0, n, (count, n), dtype=np.intp)
        done += count


def bootstrap_estimates(
    values: np.ndarray, estimator: Estimator, n_boot: int, seed: int
) -> np.ndarray:
    """The estimator over ``n_boot`` resamples of ``values``."""
    rng = np.random.default_rng(seed)
    # An index, its value, and the median's partitioned copy per resampled row.
    chunks = resamples(len(values), n_boot, rng, item_bytes=24)
    parts = [_reduce(values[rows], estimator) for rows in chunks]
    return np.concatenate(parts) if parts else np.empty(0)


def percentile_interval(values: np.ndarray, level: float) -> tuple[float, float]:
    """The central ``level`` percent of values, interpolated linearly."""
    if len(values) == 0:
        return math.nan, math.nan
    edge = (100 - level) / 2
    low, high = np.nanpercentile(values, [edge, 100 - edge])
    return float(low), float(high)


def interval(
    values: np.ndarray,
    estimator: Estimator,
    method: ErrorMethod,
    level: float,
    n_boot: int,
    seed: int,
) -> tuple[float, float, float]:
    """A group's estimate and the ends of its error interval.

    The interval is NaN for groups of fewer than two values, as in Seaborn.
    """
    center = estimate(values, estimator)
    if len(values) <= 1:
        return center, math.nan, math.nan
    if method == "sd":
        half = float(np.std(values, ddof=1)) * level
        return center, center - half, center + half
    if method == "se":
        half = float(np.std(values, ddof=1) / math.sqrt(len(values))) * level
        return center, center - half, center + half
    if method == "pi":
        return (center, *percentile_interval(values, level))
    boots = bootstrap_estimates(values, estimator, n_boot, seed)
    return (center, *percentile_interval(boots, level))


# Fits ----------------------------------------------------------------------------


def _design(z: np.ndarray, order: int) -> np.ndarray:
    """Columns 1, z, z**2, ... z**order along the last axis."""
    return np.stack([z**power for power in range(order + 1)], axis=-1)


@dataclass(frozen=True)
class Polynomial:
    """A least-squares polynomial in the predictor scaled to ``(x - center) /
    scale``. ``coefficients`` run from the constant term up; stacked (one row
    per resample) they are several polynomials."""

    center: float
    scale: float
    coefficients: np.ndarray

    def __call__(self, x: np.ndarray) -> np.ndarray:
        """The polynomial's values at `x` (each one's, stacked)."""
        z = (np.asarray(x, dtype=float) - self.center) / self.scale
        return self.coefficients @ _design(z, self.coefficients.shape[-1] - 1).T

    def in_x(self) -> np.ndarray:
        """The coefficients of powers of x itself, constant first, for reports."""
        out = np.zeros(len(self.coefficients))
        # c (x - m)^j / s^j = c / s^j * sum_i C(j, i) x^i (-m)^(j - i)
        for j, c in enumerate(self.coefficients):
            for i in range(j + 1):
                out[i] += c * math.comb(j, i) * (-self.center) ** (j - i) / self.scale**j
        return out


def _scaling(x: np.ndarray) -> tuple[float, float]:
    center = float(np.mean(x))
    scale = float(np.std(x))
    return center, scale if scale > 0 else 1.0


def polynomial_fit(x: np.ndarray, y: np.ndarray, order: int) -> Polynomial:
    """The least-squares polynomial of `order` through (x, y)."""
    center, scale = _scaling(x)
    coefficients, *_ = np.linalg.lstsq(_design((x - center) / scale, order), y, rcond=None)
    return Polynomial(center, scale, coefficients)


@dataclass(frozen=True)
class BootstrapFits:
    """A fit's predictions at a grid for each resample of the rows (NaN for
    a resample that could not be fit), and why resamples could not."""

    predictions: np.ndarray
    #: Resamples of too few distinct x values to determine the polynomial.
    too_few: int
    #: Resamples whose normal equations were too ill-conditioned to solve.
    unstable: int

    @property
    def usable(self) -> int:
        return len(self.predictions) - self.too_few - self.unstable


def bootstrap_fits(
    x: np.ndarray, y: np.ndarray, grid: np.ndarray, order: int, n_boot: int, seed: int
) -> BootstrapFits:
    """The fit's predictions at `grid` for each of `n_boot` resamples of the rows.

    Each resample solves its normal equations, from power sums, in its own
    centered and scaled predictor (as `polynomial_fit` fits the sample), so
    no design matrix per resample is held and a resample is judged by its
    own spread, not the sample's.
    """
    rng = np.random.default_rng(seed)
    x = np.asarray(x, dtype=float)
    terms = order + 1
    pairs = np.add.outer(np.arange(terms), np.arange(terms))
    grid = np.asarray(grid, dtype=float)
    out: list[np.ndarray] = []
    too_few = unstable = 0
    # An index, its x and y, a power of x, and a product per resampled row.
    for rows in resamples(len(x), n_boot, rng, item_bytes=40):
        zs, ys = x[rows], y[rows]
        center = zs.mean(axis=1)
        scale = zs.std(axis=1)
        scale[scale == 0] = 1
        zs -= center[:, None]
        zs /= scale[:, None]
        sums = np.empty((len(rows), 2 * order + 1))
        moments = np.empty((len(rows), terms))
        power = np.ones_like(zs)
        for p in range(2 * order + 1):
            sums[:, p] = power.sum(axis=1)
            if p < terms:
                moments[:, p] = (power * ys).sum(axis=1)
            power *= zs
        del power, zs, ys
        gram = sums[:, pairs]
        usable = 1 / np.linalg.cond(gram) > 1e-12
        coefficients = np.full((len(rows), terms), np.nan)
        if usable.any():
            coefficients[usable] = _solve(gram[usable], moments[usable])
        failed = np.flatnonzero(~usable)
        if len(failed):
            ordered = np.sort(x[rows[failed]], axis=1)
            distinct = 1 + np.count_nonzero(np.diff(ordered, axis=1), axis=1)
            few = int(np.count_nonzero(distinct <= order))
            too_few += few
            unstable += len(failed) - few
        # Horner's rule at the grid, in each resample's own scaled predictor.
        at = (grid[None, :] - center[:, None]) / scale[:, None]
        predictions = np.repeat(coefficients[:, -1:], len(grid), axis=1)
        for j in range(order - 1, -1, -1):
            predictions *= at
            predictions += coefficients[:, j : j + 1]
        out.append(predictions)
    predictions = np.concatenate(out) if out else np.empty((0, len(grid)))
    return BootstrapFits(predictions, too_few, unstable)


def _solve(gram: np.ndarray, moments: np.ndarray) -> np.ndarray:
    """Stacked small linear systems, one by one by least squares when a stack fails."""
    try:
        return np.linalg.solve(gram, moments[..., None])[..., 0]
    except np.linalg.LinAlgError:
        return np.stack(
            [np.linalg.lstsq(g, m, rcond=None)[0] for g, m in zip(gram, moments, strict=True)]
        )


def band(predictions: np.ndarray, level: float) -> tuple[np.ndarray, np.ndarray]:
    """The central ``level`` percent of resampled predictions at each grid point."""
    edge = (100 - level) / 2
    low, high = np.nanpercentile(predictions, [edge, 100 - edge], axis=0)
    return low, high


def lowess(
    x: np.ndarray, y: np.ndarray, frac: float = 2 / 3, it: int = 3, delta: float = 0.0
) -> tuple[np.ndarray, np.ndarray]:
    """Locally weighted linear regression, as statsmodels' ``lowess(y, x)``.

    Returns x sorted ascending and the fitted value at each. Each fit uses
    the ``frac`` share of rows nearest its x (at least 2) with tricube
    weights; ``it`` further passes downweight rows with large residuals.
    Within ``delta`` of a fitted x, values are interpolated instead.
    """
    order = np.argsort(x)
    x, y = np.ascontiguousarray(x[order], float), np.ascontiguousarray(y[order], float)
    n = len(x)
    if n == 0:
        return x, y
    # Distances from the smallest x, so that x far from zero keeps its
    # precision; ties are told apart in x itself.
    z = x - x[0]
    k = min(max(int(frac * n + 1e-10), 2), n)
    targets = _lowess_targets(x, z, delta)
    # Each target's window of k rows: the first whose middle is at or past it.
    middles = (z[: n - k] + z[k:]) / 2
    lefts = np.minimum(np.searchsorted(middles, z[targets], side="left"), n - k)
    robustness = np.ones(n)
    fitted = np.empty(n)
    for _ in range(it + 1):
        at = _lowess_fits(z, y, targets, lefts, k, robustness)
        fitted = _lowess_fill(x, z, targets, at, delta)
        robustness = _bisquare_weights(y, fitted)
    return x, fitted


def _lowess_targets(x: np.ndarray, z: np.ndarray, delta: float) -> np.ndarray:
    """The rows statsmodels fits at: the first of each run of equal x, and
    with ``delta``, after each fit, the last row within ``delta`` of it
    (those between are interpolated); `z` is x from its smallest."""
    if delta <= 0:
        return np.flatnonzero(np.r_[True, x[1:] != x[:-1]])
    targets = []
    i, n = 0, len(x)
    while True:
        targets.append(i)
        # Rows tied with the fit share it.
        last = k = i
        for k in range(i + 1, n):
            if z[k] > z[i] + delta:
                break
            if x[k] == x[last]:
                last = k
        if last >= n - 1:
            break
        i = max(k - 1, last + 1)
    return np.asarray(targets, dtype=np.intp)


def _lowess_fits(
    x: np.ndarray,
    y: np.ndarray,
    targets: np.ndarray,
    lefts: np.ndarray,
    k: int,
    robustness: np.ndarray,
) -> np.ndarray:
    """The weighted linear fit at each target row, in chunks of windows."""
    out = np.empty(len(targets))
    span = np.arange(k)
    # Indexes, x, y, weights, robustness, and temporaries per window element.
    per_chunk = _per_chunk(80, k)
    for start in range(0, len(targets), per_chunk):
        rows = targets[start : start + per_chunk]
        window = lefts[start : start + per_chunk, None] + span
        # Each window's x from its target's.
        d = x[window] - x[rows][:, None]
        ys = y[window]
        radius = np.maximum(-d[:, 0], d[:, -1])[:, None]
        with np.errstate(divide="ignore", invalid="ignore"):
            weights = (1 - (np.abs(d) / radius) ** 3) ** 3 * robustness[window]
            usable = np.count_nonzero(weights > 1e-12, axis=1) >= 2
            weights = weights / weights.sum(axis=1, keepdims=True)
            mean = (weights * d).sum(axis=1, keepdims=True)
            spread = np.maximum((weights * (d - mean) ** 2).sum(axis=1, keepdims=True), 1e-12)
            fit = (weights * (1 - mean * (d - mean) / spread) * ys).sum(axis=1)
        out[start : start + len(rows)] = np.where(usable, fit, y[rows])
    return out


def _lowess_fill(
    x: np.ndarray, z: np.ndarray, targets: np.ndarray, at: np.ndarray, delta: float
) -> np.ndarray:
    """Every row's fit: equal x share a fit, and rows between fits
    interpolate (in `z`, x from its smallest)."""
    if delta <= 0:
        # Each run of equal x takes its first row's fit.
        return at[np.cumsum(np.r_[True, x[1:] != x[:-1]]) - 1]
    fitted = np.interp(z, z[targets], at)
    fitted[targets] = at
    return fitted


def _bisquare_weights(y: np.ndarray, fitted: np.ndarray) -> np.ndarray:
    residuals = np.abs(y - fitted)
    median = float(np.median(residuals))
    scaled = (residuals > 0).astype(float) if median == 0 else residuals / (6 * median)
    return (1 - np.minimum(scaled, 1) ** 2) ** 2


# Kernel densities -----------------------------------------------------------------


BandwidthMethod = Literal["scott", "silverman"] | float


def _weights(n: int, weights: np.ndarray | None) -> np.ndarray:
    return np.full(n, 1 / n) if weights is None else weights / weights.sum()


def bandwidth_factor(weights: np.ndarray, method: BandwidthMethod, dimensions: int) -> float:
    """``gaussian_kde``'s covariance factor: Scott's or Silverman's rule on the
    effective sample size, or a given number."""
    if not isinstance(method, str):
        return float(method)
    effective = 1 / float(np.sum(weights**2))
    if method == "scott":
        return effective ** (-1 / (dimensions + 4))
    return (effective * (dimensions + 2) / 4) ** (-1 / (dimensions + 4))


def kernel_covariance(
    data: np.ndarray, weights: np.ndarray | None, method: BandwidthMethod, adjust: float
) -> np.ndarray:
    """The kernel's covariance for (d, n) data: the weighted sample covariance
    times the squared bandwidth factor, times ``adjust`` squared (Seaborn's
    ``bw_adjust``)."""
    data = np.atleast_2d(data)
    w = _weights(data.shape[1], weights)
    covariance = np.atleast_2d(np.cov(data, rowvar=True, bias=False, aweights=w))
    factor = bandwidth_factor(w, method, data.shape[0]) * adjust
    return covariance * factor**2


def support(
    values: np.ndarray,
    deviation: float,
    cut: float,
    clip: tuple[float | None, float | None],
    grid_size: int,
) -> np.ndarray:
    """Seaborn's grid: ``cut`` kernel deviations past the extreme values, within ``clip``."""
    low = -math.inf if clip[0] is None else clip[0]
    high = math.inf if clip[1] is None else clip[1]
    start = max(float(values.min()) - deviation * cut, low)
    stop = min(float(values.max()) + deviation * cut, high)
    return np.linspace(start, stop, grid_size)


def density(
    values: np.ndarray, weights: np.ndarray | None, deviation: float, grid: np.ndarray
) -> np.ndarray:
    """The Gaussian kernel density of 1D values at each grid point."""
    w = _weights(len(values), weights)
    out = np.zeros(len(grid))
    # One standardized distance, then its kernel, in place, per grid point and value.
    buffer = np.empty((len(grid), min(len(values), _per_chunk(8, len(grid)))))
    scale = 1 / (deviation * math.sqrt(2 * math.pi))
    for start, z in _chunks(grid, values, buffer):
        z /= deviation
        np.square(z, out=z)
        z *= -0.5
        np.exp(z, out=z)
        out += z @ w[start : start + z.shape[1]]
    return out * scale


def _chunks(
    grid: np.ndarray, values: np.ndarray, buffer: np.ndarray
) -> Iterator[tuple[int, np.ndarray]]:
    """Each chunk of `values` as the differences ``grid - value``, a grid
    point per row and a value per column, written into `buffer`."""
    step = max(1, buffer.shape[1])
    for start in range(0, len(values), step):
        part = values[start : start + step]
        z = buffer[:, : len(part)]
        np.subtract(grid[:, None], part[None, :], out=z)
        yield start, z


def cumulative_density(
    values: np.ndarray, weights: np.ndarray | None, deviation: float, grid: np.ndarray
) -> np.ndarray:
    """The density's integral from the grid's start to each grid point, as
    Seaborn computes it with ``gaussian_kde.integrate_box_1d``."""
    w = _weights(len(values), weights)
    # Each value's mass below the grid's start, subtracted once from every point.
    out = np.full(len(grid), -float(normal_cdf((grid[0] - values) / deviation) @ w))
    # A standardized distance and the distribution function's three arrays and sign per element.
    buffer = np.empty((len(grid), min(len(values), _per_chunk(40, len(grid)))))
    for start, z in _chunks(grid, values, buffer):
        z /= deviation
        out += normal_cdf(z) @ w[start : start + z.shape[1]]
    return out


def density_2d(
    x: np.ndarray,
    y: np.ndarray,
    weights: np.ndarray | None,
    covariance: np.ndarray,
    xs: np.ndarray,
    ys: np.ndarray,
) -> np.ndarray:
    """The bivariate Gaussian kernel density on the grid ``xs`` by ``ys``,
    as an array indexed [y, x]."""
    w = _weights(len(x), weights)
    # Whiten with the kernel's Cholesky factor: the kernel becomes a unit
    # normal. Differences from one origin first, so that coordinates far
    # from zero keep their precision.
    lower = np.linalg.cholesky(covariance)
    inverse = np.linalg.inv(lower)
    ox, oy = (float(np.mean(x)), float(np.mean(y))) if len(x) else (0.0, 0.0)
    points = inverse @ np.vstack([x - ox, y - oy])
    gx, gy = np.meshgrid(xs, ys)
    grid = inverse @ np.vstack([gx.ravel() - ox, gy.ravel() - oy])
    out = np.zeros(grid.shape[1])
    # Two squared differences per element, summed into the first, then its kernel, in place.
    per_chunk = min(points.shape[1], _per_chunk(16, grid.shape[1]))
    first = np.empty((grid.shape[1], per_chunk))
    second = np.empty_like(first)
    for start, z in _chunks(grid[0], points[0], first):
        u = second[:, : z.shape[1]]
        np.subtract(grid[1][:, None], points[1][None, start : start + z.shape[1]], out=u)
        np.square(z, out=z)
        np.square(u, out=u)
        z += u
        z *= -0.5
        np.exp(z, out=z)
        out += z @ w[start : start + z.shape[1]]
    norm = 2 * math.pi * float(np.prod(np.diag(lower)))
    return (out / norm).reshape(len(ys), len(xs))


def normal_cdf(z: np.ndarray) -> np.ndarray:
    """The standard normal distribution function, to about 1e-7.

    From the complementary error function's Chebyshev fit in Numerical
    Recipes (fractional error below 1.2e-7 everywhere), which needs no SciPy.
    """
    t = np.abs(z)
    t /= math.sqrt(2)
    s = 0.5 * t
    s += 1
    np.reciprocal(s, out=s)
    # Horner's rule in place: three arrays the size of z, and its sign.
    poly = 0.17087277 * s
    for c in (
        -0.82215223,
        1.48851587,
        -1.13520398,
        0.27886807,
        -0.18628806,
        0.09678418,
        0.37409196,
        1.00002368,
    ):
        poly += c
        poly *= s
    poly -= 1.26551223
    np.square(t, out=t)
    poly -= t
    np.exp(poly, out=poly)
    poly *= s
    poly *= 0.5
    # poly is now the upper tail of |z|: the lower tail of z below zero.
    np.subtract(1, poly, out=poly, where=z >= 0)
    return poly


# Distributions --------------------------------------------------------------------


def ecdf(
    values: np.ndarray,
    weights: np.ndarray | None,
    normalize: Literal["probability", "percent", "count"],
    complementary: bool,
) -> tuple[np.ndarray, np.ndarray]:
    """Distinct sorted values and the share (or percentage, or count) of
    values at or below each, or above it when ``complementary``."""
    if len(values) == 0:
        return np.empty(0), np.empty(0)
    order = np.argsort(values, kind="stable")
    sorted_values = values[order]
    w = np.ones(len(values)) if weights is None else weights[order]
    distinct, starts = np.unique(sorted_values, return_index=True)
    total = np.cumsum(w)
    ends = np.r_[starts[1:], len(sorted_values)] - 1
    heights = total[ends] if len(ends) else np.empty(0)
    if normalize != "count" and len(heights):
        heights = heights / heights[-1] * (100 if normalize == "percent" else 1)
    if complementary and len(heights):
        heights = heights[-1] - heights
    return distinct, heights


def bin_edges(
    values: np.ndarray,
    weights: np.ndarray | None,
    bins: int | str | np.ndarray,
    binwidth: float | None,
    binrange: tuple[float, float] | None,
    discrete: bool,
) -> np.ndarray:
    """Bin edges as Seaborn chooses them: a bin per integer when ``discrete``,
    steps of ``binwidth``, or ``numpy.histogram_bin_edges``."""
    start, stop = (float(values.min()), float(values.max())) if binrange is None else binrange
    if discrete:
        return np.arange(start - 0.5, stop + 1.5)
    if binwidth is not None:
        edges = np.arange(start, stop + binwidth, binwidth)
        if float(np.max(edges)) < stop or len(edges) < 2:
            edges = np.append(edges, float(np.max(edges)) + binwidth)
        return edges
    if isinstance(bins, np.ndarray):
        return bins
    return np.histogram_bin_edges(values, bins, binrange, weights)


Normalize = Literal["count", "probability", "percent", "density"]


def histogram(
    values: np.ndarray,
    weights: np.ndarray | None,
    edges: np.ndarray,
    normalize: Normalize,
    cumulative: bool,
) -> np.ndarray:
    """Bar heights over ``edges``, as Seaborn's ``Histogram`` measures them
    (its ``stat``, under the histogram mark's ``normalize`` names)."""
    counted, _ = np.histogram(values, bins=edges, weights=weights)
    heights = np.asarray(counted, dtype=float)
    widths = np.diff(edges)
    total = heights.sum()
    # Bins that count nothing measure nothing, as the histogram mark draws them.
    if normalize == "probability":
        heights = heights / total if total else heights
    elif normalize == "percent":
        heights = heights / total * 100 if total else heights
    elif normalize == "density":
        heights = heights / total / widths if total else heights
    if cumulative:
        heights = np.cumsum(heights * widths if normalize == "density" else heights)
    return heights


# Clustering ----------------------------------------------------------------------


LinkageMethod = Literal["single", "complete", "average", "weighted", "ward"]
Metric = Literal["euclidean", "sqeuclidean", "cityblock", "cosine", "correlation"]


def distances(rows: np.ndarray, metric: Metric) -> np.ndarray:
    """The square matrix of distances between rows."""
    if metric in ("cosine", "correlation"):
        centered = rows - rows.mean(axis=1, keepdims=True) if metric == "correlation" else rows
        norms = np.linalg.norm(centered, axis=1)
        with np.errstate(divide="ignore", invalid="ignore"):
            unit = centered / norms[:, None]
        out = 1 - unit @ unit.T
        np.fill_diagonal(out, 0)
        return np.maximum(out, 0)
    # Differences of coordinates, not of squared norms, which cancel for
    # rows far from the origin; a block of rows against all at a time.
    n, d = rows.shape
    out = np.empty((n, n))
    per_chunk = _per_chunk(16 * d, n)
    for start in range(0, n, per_chunk):
        block = rows[start : start + per_chunk, None, :] - rows[None, :, :]
        if metric == "cityblock":
            out[start : start + per_chunk] = np.abs(block).sum(axis=2)
        else:
            out[start : start + per_chunk] = (block * block).sum(axis=2)
    return out if metric in ("cityblock", "sqeuclidean") else np.sqrt(out)


def linkage(rows: np.ndarray, method: LinkageMethod, metric: Metric) -> np.ndarray:
    """Agglomerative clustering of rows in SciPy's ``linkage`` layout: per
    merge, the two clusters (originals 0..n-1, then n + merge index), their
    distance, and the merged size, with the smaller index first.

    SciPy is used when it is installed; otherwise the Lance-Williams updates
    of the given method run in NumPy, merging the closest pair each step.
    Only the methods and metrics both support are taken, so a chart is the
    same with SciPy or without it.
    """
    for name, value, choices in (
        ("method", method, get_args(LinkageMethod)),
        ("metric", metric, get_args(Metric)),
    ):
        if value not in choices:
            options = ", ".join(repr(choice) for choice in choices)
            raise ValueError(f"clustermap {name}: expected one of {options}; received {value!r}")
    if method == "ward" and metric != "euclidean":
        raise ValueError("ward linkage needs the euclidean metric")
    try:
        from scipy.cluster import hierarchy
    except ImportError:
        return _linkage_numpy(rows, method, metric)
    return np.asarray(hierarchy.linkage(rows, method=method, metric=metric), dtype=float)


def _linkage_numpy(rows: np.ndarray, method: LinkageMethod, metric: Metric) -> np.ndarray:
    n = len(rows)
    d = distances(rows, metric)
    if method == "ward":
        d = d**2
    np.fill_diagonal(d, np.inf)
    sizes = np.ones(n)
    ids = np.arange(n)
    active = np.ones(n, dtype=bool)
    merged = np.empty((max(n - 1, 0), 4))
    for step in range(n - 1):
        flat = int(np.argmin(d))
        i, j = divmod(flat, n)
        if i > j:
            i, j = j, i
        size_i, size_j = sizes[i], sizes[j]
        height = d[i, j]
        others = active.copy()
        others[[i, j]] = False
        di, dj = d[i, others], d[j, others]
        if method == "single":
            new = np.minimum(di, dj)
        elif method == "complete":
            new = np.maximum(di, dj)
        elif method == "average":
            new = (size_i * di + size_j * dj) / (size_i + size_j)
        elif method == "weighted":
            new = (di + dj) / 2
        else:
            sk = sizes[others]
            new = ((sk + size_i) * di + (sk + size_j) * dj - sk * height) / (sk + size_i + size_j)
        first, second = sorted((int(ids[i]), int(ids[j])))
        merged[step] = (
            first,
            second,
            math.sqrt(height) if method == "ward" else height,
            size_i + size_j,
        )
        # The merged cluster takes row i; row j leaves.
        d[i, others] = d[others, i] = new
        d[j, :] = d[:, j] = np.inf
        active[j] = False
        sizes[i] = size_i + size_j
        ids[i] = n + step
    return merged


def leaves(merges: np.ndarray, n: int) -> np.ndarray:
    """The original rows in dendrogram order: SciPy's ``leaves_list``, which
    visits each merge's first cluster before its second."""
    if n <= 1:
        return np.arange(n)
    out: list[int] = []
    stack = [2 * n - 2]
    while stack:
        node = stack.pop()
        if node < n:
            out.append(node)
            continue
        first, second = merges[node - n, :2].astype(int)
        stack.extend((second, first))
    return np.asarray(out, dtype=np.intp)
