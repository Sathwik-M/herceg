"""The statistics express charts draw, in NumPy (regression fits are in
``_regression``).

Each function follows the definition Seaborn uses (and SciPy or statsmodels
behind it), so that results can be checked against those libraries:

- intervals: Seaborn's ``EstimateAggregator`` (bootstrap percentile
  intervals, standard errors and deviations with ``ddof=1``, percentile
  intervals of the data) and, for weights, its ``WeightedAggregator``
  (weighted means, resampling rows with their weights);
- resampling: ``numpy.random.default_rng(seed)``, drawing each resample's
  indices as Seaborn's ``bootstrap`` does, so a seed gives Seaborn's
  resamples; with units, as its structured bootstrap draws them (units,
  then the rows of each unit drawn);
- letter values: Seaborn's ``LetterValues`` (its depth rules, and
  ``numpy.percentile``);
- kernel densities: ``scipy.stats.gaussian_kde`` (Scott's and Silverman's
  factors on the weighted sample covariance) on Seaborn's support grid;
- hierarchical clustering: ``scipy.cluster.hierarchy.linkage`` row layout and
  ``dendrogram`` leaf order.

Work over resamples, kernels, windows, and distances is done in chunks whose
arrays together take about ``_WORKSPACE`` bytes, or one resample (kernel,
window, row) when that alone takes more: small inputs use little memory,
and large ones run a unit at a time, which costs no speed once a unit's
arrays are that large.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from statistics import NormalDist
from typing import Literal, get_args

import numpy as np

#: Bytes the arrays of one chunk of resamples, kernels, or windows take
#: together: enough elements per NumPy call that its overhead is lost in the
#: work (measured: chunks of 64 MiB are no faster, of 4 MiB up to 15% slower).
_WORKSPACE = 8 << 20

#: Estimators computed for many resamples at once.
NamedEstimator = Literal["mean", "median", "sum", "min", "max"]
#: A named estimator, or a function of a group's values returning one number.
Estimator = NamedEstimator | Callable[[np.ndarray], float]
ErrorMethod = Literal["ci", "pi", "se", "sd"]
#: A function of a group's values returning the ends of its interval.
ErrorFunction = Callable[[np.ndarray], tuple[float, float]]


def _per_chunk(item_bytes: int, items: int) -> int:
    """How many units of `items` elements fit in the workspace, each element
    taking `item_bytes` across the arrays a chunk holds at once; at least 1."""
    return max(1, _WORKSPACE // max(item_bytes * items, 1))


# Resampling --------------------------------------------------------------------


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


@dataclass(frozen=True)
class Units:
    """A group's rows by sampling unit, as Seaborn's structured bootstrap
    holds them: units in ascending order of their values, each unit's rows
    in order."""

    #: The rows, unit after unit.
    order: np.ndarray
    #: Where each unit's rows start in `order`, and how many it has.
    starts: np.ndarray
    lengths: np.ndarray


def units_of(ranks: np.ndarray) -> Units:
    """The units of a group's rows, from each row's unit's rank among the
    units' values in ascending order."""
    order = np.argsort(ranks, kind="stable")
    _, starts, lengths = np.unique(ranks[order], return_index=True, return_counts=True)
    return Units(order, starts.astype(np.intp), lengths.astype(np.intp))


def flat_resamples(
    n: int,
    n_boot: int,
    rng: np.random.Generator,
    item_bytes: int,
    units: Units | None = None,
) -> Iterator[tuple[np.ndarray, np.ndarray]]:
    """``n_boot`` resamples of ``n`` rows, a chunk at a time: the chunk's
    row indices, resample after resample, and where each resample starts.

    Without `units`, each resample draws ``rng.integers(0, n, n)``. With
    them, as Seaborn's structured bootstrap: each draws as many units as
    there are, then for each unit drawn as many of its rows as it has, so
    a resample's size varies.
    """
    if units is None:
        for rows in resamples(n, n_boot, rng, item_bytes):
            yield rows.ravel(), np.arange(len(rows), dtype=np.intp) * n
        return
    count = len(units.lengths)
    budget = max(1, _WORKSPACE // item_bytes)
    parts: list[np.ndarray] = []
    sizes: list[int] = []
    held = 0
    for _ in range(n_boot):
        chosen = rng.integers(0, count, count, dtype=np.intp)
        lengths = units.lengths[chosen]
        # One draw per row with each its unit's size as the bound: the same
        # stream as Seaborn's draw per unit.
        inner = rng.integers(0, np.repeat(lengths, lengths), dtype=np.intp)
        parts.append(units.order[np.repeat(units.starts[chosen], lengths) + inner])
        sizes.append(len(inner))
        held += len(inner)
        if held >= budget:
            yield _flat(parts, sizes)
            parts, sizes, held = [], [], 0
    if parts:
        yield _flat(parts, sizes)


def _flat(parts: list[np.ndarray], sizes: list[int]) -> tuple[np.ndarray, np.ndarray]:
    return np.concatenate(parts), np.r_[0, np.cumsum(sizes[:-1])].astype(np.intp)


def segment_medians(values: np.ndarray, starts: np.ndarray) -> np.ndarray:
    """The median of each segment of `values` (segments start at `starts`;
    none is empty), as ``numpy.median`` takes it."""
    lengths = np.diff(np.r_[starts, len(values)])
    if len(lengths) and (lengths == lengths[0]).all():
        return np.median(values.reshape(len(lengths), lengths[0]), axis=1)
    segment = np.repeat(np.arange(len(starts)), lengths)
    ordered = values[np.lexsort((values, segment))]
    return (ordered[starts + (lengths - 1) // 2] + ordered[starts + lengths // 2]) / 2


# Estimates and intervals -------------------------------------------------------


def estimate(values: np.ndarray, estimator: Estimator, weights: np.ndarray | None = None) -> float:
    """The estimator over finite values (NaN when there are none); with
    `weights`, the weighted mean."""
    if len(values) == 0:
        return math.nan
    if weights is not None:
        total = float(weights.sum())
        return float((values * weights).sum() / total) if total > 0 else math.nan
    if callable(estimator):
        return float(estimator(values))
    return float(_REDUCERS[estimator](values))


_REDUCERS: dict[str, Callable[..., np.ndarray]] = {
    "mean": np.mean,
    "median": np.median,
    "sum": np.sum,
    "min": np.min,
    "max": np.max,
}

_SEGMENT_REDUCERS: dict[str, Callable[[np.ndarray, np.ndarray], np.ndarray]] = {
    "sum": np.add.reduceat,
    "min": np.minimum.reduceat,
    "max": np.maximum.reduceat,
    "median": segment_medians,
}


def bootstrap_estimates(
    values: np.ndarray,
    estimator: Estimator,
    n_boot: int,
    seed: int,
    *,
    weights: np.ndarray | None = None,
    units: Units | None = None,
) -> np.ndarray:
    """The estimator over ``n_boot`` resamples of ``values`` (and of their
    `weights`, for weighted means), or of their `units`.

    Named estimators reduce a chunk of resamples at a time; a function is
    called once per resample, with its values, as Seaborn calls it.
    """
    rng = np.random.default_rng(seed)
    out = np.empty(n_boot)
    done = 0
    if units is None and not callable(estimator):
        # An index, its value (and weight), and a partitioned copy per resampled row.
        for rows in resamples(len(values), n_boot, rng, item_bytes=32):
            if weights is not None:
                w = weights[rows]
                with np.errstate(invalid="ignore", divide="ignore"):
                    part = (values[rows] * w).sum(axis=1) / w.sum(axis=1)
            else:
                part = _REDUCERS[estimator](values[rows], axis=1)
            out[done : done + len(rows)] = part
            done += len(rows)
        return out
    for rows, starts in flat_resamples(len(values), n_boot, rng, 24, units):
        sample = values[rows]
        if callable(estimator):
            ends = np.r_[starts[1:], len(rows)]
            part = np.array([estimator(sample[a:b]) for a, b in zip(starts, ends, strict=True)])
        elif estimator == "mean":
            part = np.add.reduceat(sample, starts) / np.diff(np.r_[starts, len(rows)])
        else:
            part = _SEGMENT_REDUCERS[estimator](sample, starts)
        out[done : done + len(starts)] = part
        done += len(starts)
    return out


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
    method: ErrorMethod | ErrorFunction,
    level: float,
    n_boot: int,
    seed: int,
    *,
    weights: np.ndarray | None = None,
    units: Units | None = None,
) -> tuple[float, float, float]:
    """A group's estimate and the ends of its error interval: the bootstrap
    ("ci"), the values' ("pi") percentile interval, `level` standard errors
    ("se") or deviations ("sd") about the estimate, or what a function of
    the values returns.

    The interval is NaN for groups of fewer than two values, as in Seaborn.
    """
    center = estimate(values, estimator, weights)
    if len(values) <= 1:
        return center, math.nan, math.nan
    if callable(method):
        low, high = method(values)
        return center, float(low), float(high)
    if method == "sd":
        half = float(np.std(values, ddof=1)) * level
        return center, center - half, center + half
    if method == "se":
        half = float(np.std(values, ddof=1) / math.sqrt(len(values))) * level
        return center, center - half, center + half
    if method == "pi":
        return (center, *percentile_interval(values, level))
    boots = bootstrap_estimates(values, estimator, n_boot, seed, weights=weights, units=units)
    return (center, *percentile_interval(boots, level))


# Letter values -----------------------------------------------------------------

#: The smallest positive double.
_TINY = float(np.nextafter(0.0, 1.0))

#: How a letter-value plot chooses its depth: a rule, or a number of levels.
Depth = Literal["tukey", "proportion", "trustworthy", "full"] | int


def letter_depth(n: int, depth: Depth, outlier_proportion: float, trust_alpha: float) -> int:
    """How many letter values each side (levels of boxes) Seaborn draws for
    `n` values: Tukey's rule leaves 5 to 8 values in each tail, "proportion"
    about `outlier_proportion` of them, "trustworthy" stops where a letter
    value's confidence interval at `trust_alpha` would overlap the next,
    and "full" reaches every value; at least 1."""
    if depth == "full":
        k = int(np.log2(n)) + 1
    elif depth == "tukey":
        k = int(np.log2(n)) - 3
    elif depth == "proportion":
        k = int(np.log2(n)) - int(np.log2(n * outlier_proportion)) + 1
    elif depth == "trustworthy":
        # The upper quantile from the lower tail, which tiny alphas do not round
        # away (nor, halved, underflow to 0).
        point = 2 * NormalDist().inv_cdf(max(trust_alpha / 2, _TINY)) ** 2
        k = int(np.log2(n / point)) + 1
    else:
        k = int(depth)
    return max(k, 1)


def letter_values(sorted_values: np.ndarray, k: int, full: bool) -> np.ndarray:
    """The 2k letter values of ascending values, lowest first: the
    percentiles 100 / 2^(k+1) up to 1/4 and 3/4 up to 1 - 1 / 2^(k+1)
    (with ``full``, the extremes at 0 and 100), as Seaborn takes them."""
    lower = 0.5 ** np.arange(k + 1, 1, -1)
    percentiles = 100 * np.concatenate([lower, 1 - lower[::-1]])
    if full:
        percentiles[0], percentiles[-1] = 0, 100
    return np.percentile(sorted_values, percentiles)


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
        z = _leading(buffer, len(part))
        np.subtract(grid[:, None], part[None, :], out=z)
        yield start, z


def _leading(buffer: np.ndarray, columns: int) -> np.ndarray:
    """The start of a 2-D buffer as a contiguous array of `columns` columns
    (a last chunk narrower than the buffer), not a strided slice of it."""
    return buffer.reshape(-1)[: len(buffer) * columns].reshape(len(buffer), columns)


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
        u = _leading(second, z.shape[1])
        np.subtract(grid[1][:, None], points[1][None, start : start + z.shape[1]], out=u)
        np.square(z, out=z)
        np.square(u, out=u)
        z += u
        z *= -0.5
        np.exp(z, out=z)
        out += z @ w[start : start + z.shape[1]]
    norm = 2 * math.pi * float(np.prod(np.diag(lower)))
    return (out / norm).reshape(len(ys), len(xs))


def mass_levels(density: np.ndarray, proportions: np.ndarray) -> np.ndarray:
    """Seaborn's contour levels of a density sampled on a grid: for each
    iso-proportion p, the density bounding the region of highest density
    that holds 1 - p of the samples' mass, so that p = 0.05 encloses 95% of
    it and p = 1 marks the peak."""
    values = np.ravel(density)
    ordered = np.sort(values)[::-1]
    held = np.cumsum(ordered) / values.sum()
    return np.take(ordered, np.searchsorted(held, 1 - np.asarray(proportions)), mode="clip")


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


#: Most bins along an axis, as the histogram mark takes them.
MAX_BINS = 1000


def bin_edges(
    values: np.ndarray,
    weights: np.ndarray | None,
    bins: int | str | np.ndarray,
    binwidth: float | None,
    binrange: tuple[float, float] | None,
    discrete: bool,
    role: str = "histplot",
) -> np.ndarray:
    """Bin edges as Seaborn chooses them: a bin per integer when ``discrete``,
    steps of ``binwidth``, or ``numpy.histogram_bin_edges``; refused, before
    they are made where that can be known, past ``MAX_BINS`` bins. ``role``
    names the function in errors."""
    start, stop = (float(values.min()), float(values.max())) if binrange is None else binrange
    if discrete:
        if stop - start + 1 > MAX_BINS:
            raise ValueError(
                f"{role} discrete: a bin per whole number from {start:g} to {stop:g} makes "
                f"{stop - start + 1:.0f} bins, past the {MAX_BINS} a histogram takes; "
                "drop discrete or give bins"
            )
        return np.arange(start - 0.5, stop + 1.5)
    if binwidth is not None:
        if (stop - start) / binwidth > MAX_BINS:
            raise ValueError(
                f"{role} binwidth: steps of {binwidth:g} from {start:g} to {stop:g} make "
                f"about {(stop - start) / binwidth:.0f} bins, past the {MAX_BINS} a histogram "
                "takes; give a wider binwidth"
            )
        edges = np.arange(start, stop + binwidth, binwidth)
        if float(np.max(edges)) < stop or len(edges) < 2:
            edges = np.append(edges, float(np.max(edges)) + binwidth)
        return edges
    if isinstance(bins, np.ndarray):
        return bins
    if isinstance(bins, (int, np.integer)) and bins > MAX_BINS:
        raise ValueError(
            f"{role} bins: expected at most {MAX_BINS} bins, as a histogram takes; received {bins}"
        )
    edges = np.histogram_bin_edges(values, bins, binrange, weights)
    if len(edges) - 1 > MAX_BINS:
        raise ValueError(
            f"{role} bins: the {bins!r} rule makes {len(edges) - 1} bins, past the {MAX_BINS} "
            "a histogram takes; give a count or a binwidth"
        )
    return edges


Normalize = Literal["count", "frequency", "probability", "percent", "density"]


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
    elif normalize == "frequency":
        heights = heights / widths
    if cumulative:
        per_width = normalize in ("density", "frequency")
        heights = np.cumsum(heights * widths if per_width else heights)
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
