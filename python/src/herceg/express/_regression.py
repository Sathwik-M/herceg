"""Regression fits regplot and residplot draw, in NumPy.

Each follows the reference Seaborn calls, so results can be checked against it:

- polynomial fits: least squares (``numpy.linalg.lstsq``, weighted rows
  for ``weight``) in the predictor scaled to mean 0 and standard deviation
  1, so predictors far from zero (epoch milliseconds) fit exactly;
  Seaborn's ``pinv`` and ``polyfit`` give the same fits on well-conditioned
  data;
- logistic fits: statsmodels' ``GLM(y, X, family=Binomial()).fit()``
  (IRLS from its starting means, its convergence test on the deviance, and
  its perfect-separation test, after which Seaborn draws no fit);
- robust fits: statsmodels' ``RLM(y, X).fit()`` (Huber's T norm, the
  scale re-estimated by the MAD each pass, its convergence test);
- lowess: statsmodels' ``lowess`` (tricube weights, ``it`` robustifying
  passes with bisquare weights, ``delta`` interpolation).

Bootstrap bands refit every resample of the rows (or, with units, of the
units and then the rows within each, as Seaborn's structured bootstrap
draws them), all resamples of a chunk at once: logistic and robust fits
iterate together, each resample stopping when its own fit converges.
"""

from __future__ import annotations

import math
import numbers
from dataclasses import dataclass
from typing import Literal

import numpy as np

from ._numerics import Units, _per_chunk, flat_resamples, segment_medians

Model = Literal["polynomial", "logistic", "robust"]

#: Machine epsilon, which statsmodels clips probabilities and ratios to.
_EPS = float(np.finfo(float).eps)
#: The standard normal's upper quartile, which normalizes the MAD.
_GAUSSIAN_3_4 = 0.6744897501960817
#: Huber's T tuning constant, statsmodels' default.
_HUBER_T = 1.345


def _design(z: np.ndarray, order: int) -> np.ndarray:
    """Columns 1, z, z**2, ... z**order along the last axis."""
    return np.stack([z**power for power in range(order + 1)], axis=-1)


@dataclass(frozen=True)
class Fit:
    """A regression of y on x, fit in x scaled to ``(x - center) / scale``:
    ``coefficients`` of the powers of the scaled x, constant first (stacked,
    one row per resample, several fits), through the logit link for
    logistic fits. NaN coefficients are a fit that could not be made."""

    center: float
    scale: float
    coefficients: np.ndarray
    logistic: bool = False

    def __call__(self, x: np.ndarray) -> np.ndarray:
        """The fitted values at `x` (each fit's, stacked)."""
        z = (np.asarray(x, dtype=float) - self.center) / self.scale
        linear = self.coefficients @ _design(z, self.coefficients.shape[-1] - 1).T
        return _expit(linear) if self.logistic else linear

    def in_x(self) -> np.ndarray:
        """The coefficients of powers of x itself, constant first, for reports
        (of the linear predictor, for logistic fits)."""
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


def fit(
    x: np.ndarray,
    y: np.ndarray,
    model: Model = "polynomial",
    order: int = 1,
    weights: np.ndarray | None = None,
) -> Fit:
    """The `model` fit of y on x: a least-squares polynomial of `order`
    (rows weighted by `weights`), or a logistic or robust line."""
    # Scaled by the rows that weigh, which alone shape the fit.
    center, scale = _scaling(x if weights is None or not (weights > 0).any() else x[weights > 0])
    z = (x - center) / scale
    if model == "polynomial":
        design = _design(z, order)
        if weights is not None:
            root = np.sqrt(weights)
            coefficients, *_ = np.linalg.lstsq(design * root[:, None], y * root, rcond=None)
        else:
            coefficients, *_ = np.linalg.lstsq(design, y, rcond=None)
        return Fit(center, scale, coefficients)
    starts = np.zeros(1, dtype=np.intp)
    solve = _logistic if model == "logistic" else _robust
    return Fit(center, scale, solve(z, y, starts)[0], logistic=model == "logistic")


@dataclass(frozen=True)
class BootstrapFits:
    """A fit's predictions at a grid for each resample of the rows (NaN for
    a resample that could not be fit), and why resamples could not."""

    predictions: np.ndarray
    #: Resamples of too few distinct x values to determine the fit.
    too_few: int
    #: Resamples whose equations were too ill-conditioned to solve.
    unstable: int
    #: Logistic resamples whose classes x separates perfectly (Seaborn draws them as NaN).
    separated: int = 0

    @property
    def usable(self) -> int:
        return len(self.predictions) - self.too_few - self.unstable - self.separated


def bootstrap(
    x: np.ndarray,
    y: np.ndarray,
    grid: np.ndarray,
    n_boot: int,
    seed: int,
    *,
    model: Model = "polynomial",
    order: int = 1,
    weights: np.ndarray | None = None,
    units: Units | None = None,
) -> BootstrapFits:
    """The fit's predictions at `grid` for each of `n_boot` resamples of the
    rows (pairs of x, y, and weight), or of `units` and their rows.

    Each resample is fit in its own centered and scaled predictor, as `fit`
    fits the sample, so a resample is judged by its own spread; polynomial
    resamples solve their normal equations from power sums, so no design
    matrix per resample is held.
    """
    rng = np.random.default_rng(seed)
    x = np.asarray(x, dtype=float)
    grid = np.asarray(grid, dtype=float)
    predictions = np.empty((n_boot, len(grid)))
    too_few = unstable = separated = 0
    done = 0
    # An index, its x, y, weight, and a few temporaries per resampled row.
    for rows, starts in flat_resamples(len(x), n_boot, rng, item_bytes=64, units=units):
        count = len(starts)
        lengths = np.diff(np.r_[starts, len(rows)])
        segment = np.repeat(np.arange(count), lengths)
        zs, ys = x[rows], y[rows]
        center = np.add.reduceat(zs, starts) / lengths
        zs -= center[segment]
        scale = np.sqrt(np.add.reduceat(zs * zs, starts) / lengths)
        scale[scale == 0] = 1
        zs /= scale[segment]
        if model == "polynomial":
            ws = None if weights is None else weights[rows]
            coefficients = _power_fits(zs, ys, ws, starts, order)
        elif model == "logistic":
            coefficients = _logistic(zs, ys, starts)
        else:
            coefficients = _robust(zs, ys, starts)
        failed = np.flatnonzero(np.isnan(coefficients).any(axis=1))
        if len(failed):
            # Resamples of fewer distinct x values than terms cannot be fit;
            # of the rest, logistic ones were separated, others unstable.
            distinct = np.array(
                [len(np.unique(zs[starts[i] : starts[i] + lengths[i]])) for i in failed]
            )
            few = int(np.count_nonzero(distinct <= order))
            too_few += few
            if model == "logistic":
                separated += len(failed) - few
            else:
                unstable += len(failed) - few
        # Horner's rule at the grid, in each resample's own scaled predictor.
        at = (grid[None, :] - center[:, None]) / scale[:, None]
        chunk = predictions[done : done + count]
        chunk[:] = coefficients[:, -1:]
        for j in range(coefficients.shape[1] - 2, -1, -1):
            chunk *= at
            chunk += coefficients[:, j : j + 1]
        if model == "logistic":
            chunk[:] = _expit(chunk)
        done += count
    return BootstrapFits(predictions, too_few, unstable, separated)


def _power_fits(
    z: np.ndarray, y: np.ndarray, w: np.ndarray | None, starts: np.ndarray, order: int
) -> np.ndarray:
    """Each segment's least-squares polynomial of `order` in z (rows weighted
    by `w`), from its power sums; NaN where its equations are too
    ill-conditioned (or too few distinct z) to solve."""
    terms = order + 1
    pairs = np.add.outer(np.arange(terms), np.arange(terms))
    sums = np.empty((len(starts), 2 * order + 1))
    moments = np.empty((len(starts), terms))
    power = np.ones_like(z) if w is None else w.astype(float)
    for p in range(2 * order + 1):
        sums[:, p] = np.add.reduceat(power, starts)
        if p < terms:
            moments[:, p] = np.add.reduceat(power * y, starts)
        power *= z
    gram = sums[:, pairs]
    with np.errstate(invalid="ignore", divide="ignore"):
        usable = 1 / np.linalg.cond(gram) > 1e-12
    coefficients = np.full((len(starts), terms), np.nan)
    if usable.any():
        coefficients[usable] = _solve(gram[usable], moments[usable])
    return coefficients


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


# Iteratively reweighted lines -----------------------------------------------------


def _lines(
    z: np.ndarray, y: np.ndarray, w: np.ndarray, starts: np.ndarray, segment: np.ndarray
) -> np.ndarray:
    """Each segment's weighted least-squares line in z, as (intercept, slope)
    rows, about the segment's weighted mean of z; NaN where z does not vary."""
    total = np.add.reduceat(w, starts)
    with np.errstate(invalid="ignore", divide="ignore"):
        mean = np.add.reduceat(w * z, starts) / total
        d = z - mean[segment]
        spread = np.add.reduceat(w * d * d, starts)
        slope = np.add.reduceat(w * d * y, starts) / spread
        slope[~(spread > 0)] = np.nan
        intercept = np.add.reduceat(w * y, starts) / total - slope * mean
    return np.stack([intercept, slope], axis=1)


def _segments(z: np.ndarray, starts: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    lengths = np.diff(np.r_[starts, len(z)])
    return lengths, np.repeat(np.arange(len(starts)), lengths)


def _logistic(z: np.ndarray, y: np.ndarray, starts: np.ndarray) -> np.ndarray:
    """Each segment's logistic line in z (intercept, slope), by statsmodels'
    IRLS: from means (y + 1/2) / 2, until the deviance changes by at most
    1e-8, at most 100 passes. A segment whose fitted probabilities come
    within 1e-8 of every y is perfectly separated, and NaN, as Seaborn
    draws it."""
    _, segment = _segments(z, starts)
    count = len(starts)
    mu = (y + 0.5) / 2
    eta = _logit(mu)
    deviance = _binomial_deviance(y, mu, starts)
    out = np.full((count, 2), np.nan)
    active = np.ones(count, dtype=bool)
    for _ in range(100):
        p = np.clip(mu, _EPS, 1 - _EPS)
        weights = 1 / ((1 / (p * (1 - p))) ** 2 * (p * (1 - p)))
        target = eta + (y - mu) / (p * (1 - p))
        lines = _lines(z, target, weights, starts, segment)
        new_eta = lines[segment, 0] + lines[segment, 1] * z
        new_mu = _expit(new_eta)
        new_deviance = _binomial_deviance(y, new_mu, starts)
        perfect = np.logical_and.reduceat(np.abs(new_mu - y) <= 1e-8, starts)
        converged = np.abs(new_deviance - deviance) <= 1e-8
        failed = ~np.isfinite(lines).all(axis=1)
        out[active] = lines[active]
        out[active & (perfect | failed)] = np.nan
        moving = active[segment]
        eta = np.where(moving, new_eta, eta)
        mu = np.where(moving, new_mu, mu)
        deviance = np.where(active, new_deviance, deviance)
        active &= ~(perfect | converged | failed)
        if not active.any():
            break
    return out


def _logit(mu: np.ndarray) -> np.ndarray:
    p = np.clip(mu, _EPS, 1 - _EPS)
    return np.log(p / (1 - p))


def _expit(eta: np.ndarray) -> np.ndarray:
    with np.errstate(over="ignore"):
        return 1 / (1 + np.exp(-eta))


def _binomial_deviance(y: np.ndarray, mu: np.ndarray, starts: np.ndarray) -> np.ndarray:
    """statsmodels' Binomial deviance of each segment."""
    with np.errstate(divide="ignore", invalid="ignore"):
        hits = np.clip(y / (mu + 1e-20), _EPS, np.inf)
        misses = np.clip((1 - y) / (1 - mu + 1e-20), _EPS, np.inf)
        residual = 2 * (y * np.log(hits) + (1 - y) * np.log(misses))
    return np.add.reduceat(residual, starts)


def _robust(z: np.ndarray, y: np.ndarray, starts: np.ndarray) -> np.ndarray:
    """Each segment's robust line in z (intercept, slope), by statsmodels'
    RLM: least squares, then passes reweighting rows by Huber's T at the
    residuals over the MAD scale (re-estimated each pass), until the
    criterion changes by at most 1e-8, at most 50 passes; a segment whose
    scale reaches 0 keeps its last fit."""
    lengths, segment = _segments(z, starts)
    weights = np.ones_like(z)
    lines = _lines(z, y, weights, starts, segment)
    residual = y - (lines[segment, 0] + lines[segment, 1] * z)
    scale = _mad(residual, starts)
    criterion = _huber_criterion(residual, weights, starts, segment, lengths)
    active = np.isfinite(lines).all(axis=1)
    out = np.where(active[:, None], lines, np.nan)
    iteration = 1
    while active.any():
        active &= scale != 0
        if not active.any():
            break
        with np.errstate(divide="ignore", invalid="ignore"):
            weights = _huber_weights(residual / scale[segment])
        lines = _lines(z, y, weights, starts, segment)
        new_residual = y - (lines[segment, 0] + lines[segment, 1] * z)
        new_scale = _mad(new_residual, starts)
        new_criterion = _huber_criterion(new_residual, weights, starts, segment, lengths)
        iteration += 1
        out[active] = lines[active]
        moving = active[segment]
        residual = np.where(moving, new_residual, residual)
        scale = np.where(active, new_scale, scale)
        # As statsmodels tests it: a criterion that is not a number has converged.
        converged = ~(np.abs(new_criterion - criterion) > 1e-8) | (iteration >= 50)
        criterion = np.where(active, new_criterion, criterion)
        active &= ~converged
    return out


def _mad(residual: np.ndarray, starts: np.ndarray) -> np.ndarray:
    """statsmodels' ``mad(residual, center=0)`` per segment."""
    return segment_medians(np.abs(residual) / _GAUSSIAN_3_4, starts)


def _huber_weights(z: np.ndarray) -> np.ndarray:
    magnitude = np.abs(z)
    inside = magnitude <= _HUBER_T
    return np.where(inside, 1.0, _HUBER_T / np.where(inside, 1.0, magnitude))


def _huber_criterion(
    residual: np.ndarray,
    weights: np.ndarray,
    starts: np.ndarray,
    segment: np.ndarray,
    lengths: np.ndarray,
) -> np.ndarray:
    """RLM's convergence criterion: Huber's rho summed over the residuals
    divided by the weighted fit's scale, its weighted squared residuals over
    the residual degrees of freedom (as statsmodels computes it)."""
    with np.errstate(divide="ignore", invalid="ignore"):
        fit_scale = np.add.reduceat(weights * residual * residual, starts) / (lengths - 2)
        z = np.abs(residual / fit_scale[segment])
    rho = np.where(z <= _HUBER_T, 0.5 * z * z, z * _HUBER_T - 0.5 * _HUBER_T**2)
    return np.add.reduceat(rho, starts)


# Lowess ---------------------------------------------------------------------------


def lowess(
    x: np.ndarray, y: np.ndarray, frac: float = 2 / 3, it: int = 3, delta: float = 0.0
) -> tuple[np.ndarray, np.ndarray]:
    """Locally weighted linear regression, as statsmodels' ``lowess(y, x)``.

    Returns x sorted ascending and the fitted value at each. Each fit uses
    the ``frac`` share of rows nearest its x (at least 2) with tricube
    weights; ``it`` further passes downweight rows with large residuals.
    Within ``delta`` of a fitted x, values are interpolated instead.
    Neighborhoods and the rows skipped are chosen with statsmodels'
    arithmetic, so ties between equally distant rows go its way; the fits
    are computed from differences of x, which keep their precision far
    from zero.
    """
    order = np.argsort(x)
    x, y = np.ascontiguousarray(x[order], float), np.ascontiguousarray(y[order], float)
    n = len(x)
    if n == 0:
        return x, y
    k = min(max(int(frac * n + 1e-10), 2), n)
    targets = _lowess_targets(x, delta)
    # Each target's window of k rows: the first whose middle is at or past it.
    middles = (x[: n - k] + x[k:]) / 2
    lefts = np.searchsorted(middles, x[targets], side="left")
    robustness = None
    fitted = np.empty(n)
    for _ in range(it + 1):
        at = _lowess_fits(x, y, targets, lefts, k, robustness)
        fitted = _lowess_fill(x, targets, at, delta)
        robustness = _bisquare_weights(y, fitted)
    return x, fitted


def _lowess_targets(x: np.ndarray, delta: float) -> np.ndarray:
    """The rows statsmodels fits at: the first of each run of equal x, and
    with ``delta``, after each fit, the last row within ``delta`` of it
    (those between are interpolated)."""
    if delta <= 0:
        return np.flatnonzero(np.r_[True, x[1:] != x[:-1]])
    n = len(x)
    # The last row tied with each, and the first beyond delta of each.
    ties = np.searchsorted(x, x, side="right") - 1
    beyond = np.searchsorted(x, x + delta, side="right")
    targets = []
    i = 0
    while True:
        targets.append(i)
        # Rows tied with the fit share it.
        last = int(ties[i])
        if last >= n - 1:
            break
        i = max(min(int(beyond[i]), n - 1) - 1, last + 1)
    return np.asarray(targets, dtype=np.intp)


def _row_dots(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """The dot product of each row of `a` with the same row of `b`, by BLAS."""
    return np.matmul(a[:, None, :], b[:, :, None])[:, 0, 0]


def _lowess_fits(
    x: np.ndarray,
    y: np.ndarray,
    targets: np.ndarray,
    lefts: np.ndarray,
    k: int,
    robustness: np.ndarray | None,
) -> np.ndarray:
    """The weighted linear fit at each target row, in chunks of windows."""
    out = np.empty(len(targets))
    span = np.arange(k)
    # A window's x, its weights and their cube, and y, per element.
    per_chunk = _per_chunk(40, k)
    for start in range(0, len(targets), per_chunk):
        rows = targets[start : start + per_chunk]
        window = lefts[start : start + per_chunk, None] + span
        # Each window's x from its target's.
        d = x[window]
        d -= x[rows][:, None]
        radius = np.maximum(-d[:, 0], d[:, -1])[:, None]
        # Tricube weights, (1 - |d / radius|^3)^3, by products rather than powers.
        w = np.abs(d)
        with np.errstate(divide="ignore", invalid="ignore"):
            w /= radius
        cube = w * w
        cube *= w
        np.subtract(1, cube, out=cube)
        np.multiply(cube, cube, out=w)
        w *= cube
        del cube
        if robustness is not None:
            w *= robustness[window]
        usable = np.count_nonzero(w > 1e-12, axis=1) >= 2
        ys = y[window]
        with np.errstate(divide="ignore", invalid="ignore"):
            total = w.sum(axis=1)
            mean = _row_dots(w, d) / total
            d -= mean[:, None]
            wd = w * d
            spread = np.maximum(_row_dots(wd, d) / total, 1e-12)
            fit = _row_dots(w, ys) / total - mean * _row_dots(wd, ys) / total / spread
        out[start : start + len(rows)] = np.where(usable, fit, y[rows])
    return out


def _lowess_fill(x: np.ndarray, targets: np.ndarray, at: np.ndarray, delta: float) -> np.ndarray:
    """Every row's fit: equal x share a fit, and rows between fits
    interpolate, in distances from the earlier fit's x, as statsmodels does."""
    run = np.cumsum(np.r_[True, x[1:] != x[:-1]]) - 1
    if delta <= 0:
        # Each run of equal x takes its first row's fit.
        return at[run]
    # Each row's fit before it (or at it), and the next one.
    before = np.searchsorted(targets, np.arange(len(x)), side="right") - 1
    after = np.minimum(before + 1, len(targets) - 1)
    first, last = targets[before], targets[after]
    with np.errstate(invalid="ignore", divide="ignore"):
        share = (x - x[first]) / (x[last] - x[first])
    fitted = share * at[after] + (1 - share) * at[before]
    # Fits, and rows tied with them, take the fit itself.
    tied = x == x[first]
    fitted[tied] = at[before][tied]
    return fitted


def _bisquare_weights(y: np.ndarray, fitted: np.ndarray) -> np.ndarray:
    residuals = np.abs(y - fitted)
    median = float(np.median(residuals))
    scaled = (residuals > 0).astype(float) if median == 0 else residuals / (6 * median)
    return (1 - np.minimum(scaled, 1) ** 2) ** 2


# Predictors -----------------------------------------------------------------------


def bin_predictor(x: np.ndarray, bins: int | np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Seaborn's ``x_bins``: each x moved to the nearest of `bins` centers (a
    count, of centers at evenly spaced percentiles of x, or the centers),
    and the centers."""
    if isinstance(bins, numbers.Integral):
        centers = np.percentile(x, np.linspace(0, 100, int(bins) + 2)[1:-1])
    else:
        centers = np.ravel(np.asarray(bins, dtype=float))
    # The nearest center of the sorted ones on either side of each x (ties
    # going to the center given first, as Seaborn's argmin takes them),
    # without a matrix of every x's distance to every center.
    order = np.argsort(centers, kind="stable")
    ordered = centers[order]
    at = np.searchsorted(ordered, x)
    sides = []
    for side in (np.maximum(at - 1, 0), np.minimum(at, len(ordered) - 1)):
        # The first of equal centers, which is the one given first.
        side = np.searchsorted(ordered, ordered[side], side="left")
        sides.append((np.abs(x - ordered[side]), order[side]))
    (below, first), (above, second) = sides
    nearer = (above < below) | ((above == below) & (second < first))
    return centers[np.where(nearer, second, first)], centers


def regress_out(a: np.ndarray, b: np.ndarray, kept: np.ndarray | None = None) -> np.ndarray:
    """`a` with its linear dependence on `b` removed, keeping its mean, as
    Seaborn's ``x_partial`` and ``y_partial`` remove a confounder; the
    dependence and the means are estimated from the rows `kept` (all of
    them by default), and removed from every row."""
    ka, kb = (a, b) if kept is None else (a[kept], b[kept])
    if len(ka) == 0:
        return a.copy()
    other = (kb - kb.mean())[:, None]
    slope = np.linalg.pinv(other) @ (ka - ka.mean())
    return a - (b - kb.mean()) * float(slope[0])
