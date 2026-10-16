"""Fits: regplot and residplot."""

from __future__ import annotations

import functools
import math
import numbers
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Literal

import numpy as np

from .._chart import Chart
from .._data import Column
from . import _numerics as numerics
from . import _regression as regression
from ._common import (
    ExpressOptions,
    Levels,
    Source,
    Statistics,
    by,
    check_estimator,
    check_grid_size,
    check_n_boot,
    checking,
    complete,
    dropped_sentence,
    express,
    facets,
    fresh,
    function_name,
    group,
    keyed_table,
    level_label,
    make_chart,
    neutral,
    number_column,
    readable,
    record,
    refuse_facets,
    reused,
    rows_table,
    seed_of,
    shown,
    unit_ranks,
    values,
    variables_of,
    weight_column,
    weights_of,
)
from ._numerics import Estimator

if sys.version_info >= (3, 11):
    from typing import Unpack
else:
    from typing_extensions import Unpack

#: Seaborn's ``x_ci``: the ``ci`` level, a standard deviation, a level, or none.
XInterval = Literal["ci", "sd"] | float | None


@express
def regplot(
    data: Any,
    *,
    x: str,
    y: str,
    series: str | None = None,
    color: str | None = None,
    series_order: Sequence[Any] | None = None,
    order: int = 1,
    logistic: bool = False,
    robust: bool = False,
    lowess: bool = False,
    logx: bool = False,
    frac: float = 2 / 3,
    it: int = 3,
    delta: float = 0.0,
    ci: float | None = 95,
    n_boot: int = 1000,
    seed: int | None = 0,
    weight: str | None = None,
    units: str | None = None,
    x_estimator: Estimator | None = None,
    x_bins: int | Sequence[float] | None = None,
    x_ci: XInterval = "ci",
    x_partial: str | None = None,
    y_partial: str | None = None,
    x_jitter: float | None = None,
    y_jitter: float | None = None,
    scatter: bool = True,
    fit_reg: bool = True,
    truncate: bool = True,
    grid_size: int = 100,
    palette: Sequence[str] | None = None,
    **options: Unpack[ExpressOptions],
) -> Chart:
    """Points of ``y`` against ``x`` with a regression line and its
    confidence band, per ``series`` (and facet panel).

    The fit is a least-squares polynomial of ``order`` (1, a straight line,
    by default; rows weighted by ``weight``), or one of: ``logistic=True``,
    a logistic regression of a ``y`` from 0 to 1 (statsmodels' GLM; a
    resample whose classes x separates perfectly has no fit, as in
    Seaborn); ``robust=True``, a line downweighting outliers (statsmodels'
    RLM with Huber's T); ``logx=True``, a line in log x; or
    ``lowess=True``, a locally weighted line, as statsmodels'
    ``lowess(y, x, frac, it, delta)``, without a band. Logistic and robust
    fits are computed in NumPy; statsmodels is not needed. Fits are drawn
    at ``grid_size`` points over each group's ``x`` range (all the data's
    with ``truncate=False``), with a ``ci`` percent bootstrap band: the fit
    repeated on ``n_boot`` resamples of the rows, or with ``units`` of the
    units and the rows within them, drawn with ``seed``.

    ``x_estimator`` (an estimator, as in ``barplot``) draws, instead of
    the points, its estimate of ``y`` at each distinct ``x``, or with
    ``x_bins`` (a count, or bin centers) at each bin's center, with
    intervals per ``x_ci`` ("ci" for ``ci``'s level, "sd", a level, or
    None); the fit still uses every row. ``x_partial`` and ``y_partial``
    name columns whose linear effect is removed from ``x`` and ``y``
    first. ``scatter=False`` leaves out the points, ``fit_reg=False`` the
    fit.
    """
    model = _model(order, logistic, robust, lowess, logx, "regplot")
    if x_jitter is not None or y_jitter is not None:
        name = "x_jitter" if x_jitter is not None else "y_jitter"
        raise ValueError(
            f"regplot {name}: jitter would move points off their values, which tooltips and "
            "the keyboard read; draw the points with hg.Chart.point over binned values, or "
            "use x_estimator"
        )
    for name, flag in (("scatter", scatter), ("fit_reg", fit_reg), ("truncate", truncate)):
        if not isinstance(flag, bool):
            raise TypeError(f"regplot {name}: expected True or False; received {shown(flag)}")
    check_ci(ci, "regplot")
    grid_size = check_grid_size(grid_size, "regplot grid_size")
    _check_lowess(frac, it, delta, "regplot")
    n_boot = check_n_boot(n_boot, "regplot")
    if weight is not None and model.kind != "polynomial":
        raise ValueError(
            f"regplot weight: weights weigh least-squares fits; drop weight, or {model.option}"
        )
    if weight is not None and units is not None:
        raise ValueError(
            "regplot units: weighted fits resample rows with their weights; drop units or weight"
        )
    estimating = x_estimator is not None or x_bins is not None
    if x_estimator is not None:
        check_estimator(x_estimator, "regplot x_estimator")
    _check_x_ci(x_ci, "regplot")
    _check_bins(x_bins, "regplot")
    facet_row, facet_column = facets(options, "regplot")
    source = Source(data)
    xc = source.column(x, "regplot x", ("number",))
    yc = source.column(y, "regplot y", ("number",))
    variables = variables_of(
        source, "regplot", facet_row, facet_column, series, series_order, axes=[x, y]
    )
    taken = [x, y, *variables]
    weight_values = weight_column(source, weight, "regplot", taken)
    ranked = unit_ranks(source, units, "regplot", [*taken, weight])
    partials = [
        None if name is None else source.column(name, f"regplot {role}", ("number",))
        for name, role in ((x_partial, "x_partial"), (y_partial, "y_partial"))
    ]
    rows = complete(
        len(xc),
        xc,
        yc,
        weight_values,
        None if ranked is None else ranked[1],
        *partials,
        levels_of=list(variables.values()),
    )
    weights = weights_of(weight_values, rows, weight, "regplot")
    dropped = len(xc) - len(rows)
    xv, yv = values(xc), values(yc)
    if model.kind == "logistic" and len(rows) and not ((yv[rows] >= 0) & (yv[rows] <= 1)).all():
        raise ValueError(
            f"regplot logistic: column {y!r} holds values outside 0 to 1; a logistic fit "
            "takes outcomes (0 or 1) or proportions"
        )
    # Rows of no weight take no part in the fit, nor in its domain.
    weighing = rows if weights is None else rows[weights[rows] > 0]
    if logx and len(weighing) and not (xv[weighing] > 0).all():
        raise ValueError(
            f"regplot logx: column {x!r} holds values at or below 0; logx fits y against log x"
        )
    # Removing a column's effect moves values off the domain a model takes.
    if logx and x_partial is not None:
        raise ValueError(
            "regplot x_partial: x with another column's effect removed may fall at or "
            "below 0, which logx cannot take; drop x_partial or logx"
        )
    if model.kind == "logistic" and y_partial is not None:
        raise ValueError(
            "regplot y_partial: outcomes with another column's effect removed are not 0 "
            "or 1, which a logistic fit takes; drop y_partial or logistic"
        )
    banded = fit_reg and ci is not None and model.kind != "lowess"
    used_seed = seed_of(seed, "regplot") if banded or (estimating and x_ci is not None) else None
    names = [*variables]
    # The fitted values' column: y's name, unless x has it too.
    (fitted,) = fresh([y], {x, *names})
    low, high = fresh(["low", "high"], {x, fitted, *names})
    fits: dict[str, list[np.ndarray]] = {x: [], fitted: [], low: [], high: []}
    keys: list[np.ndarray] = []
    coefficients: list[np.ndarray] = []
    estimates: list[dict[str, Any]] = []
    unfit = 0
    failures = BandFailures()
    # Each group's x and y with the partials' effects removed (as estimated
    # from the rows that weigh), which the points, estimates, and fits use.
    prepared = []
    place = np.empty(len(xv), dtype=np.intp)
    place[rows] = np.arange(len(rows))
    point_x, point_y = xv[rows].copy(), yv[rows].copy()
    for key, members in group(list(variables.values()), rows):
        weighed = None if weights is None else weights[members] > 0
        gx, gy = xv[members], yv[members]
        if partials[0] is not None:
            gx = regression.regress_out(gx, values(partials[0])[members], weighed)
        if partials[1] is not None:
            gy = regression.regress_out(gy, values(partials[1])[members], weighed)
        point_x[place[members]], point_y[place[members]] = gx, gy
        prepared.append((key, members, gx, gy, weighed))
    # Without truncation, fits reach every group's x that weighs.
    spread = [gx if weighed is None else gx[weighed] for _, _, gx, _, weighed in prepared]
    whole: np.ndarray = np.concatenate(spread) if spread else np.empty(0)
    span = (float(np.min(whole)), float(np.max(whole))) if len(whole) else (0.0, 0.0)
    for key, members, gx, gy, weighed in prepared:
        gw = None if weights is None else weights[members]
        ranks = None if ranked is None else ranked[0][members]
        if estimating:
            estimates.append(
                _x_estimates(
                    x,
                    gx,
                    gy,
                    ranks,
                    key,
                    x_estimator or "mean",
                    x_bins,
                    x_ci,
                    ci,
                    n_boot,
                    used_seed,
                )
            )
        if not fit_reg:
            continue
        if gw is not None:
            # Rows of no weight take no part in the fit.
            gx, gy, gw = gx[weighed], gy[weighed], gw[weighed]
        if len(np.unique(gx)) <= model.order:
            unfit += 1
            continue
        if model.kind == "lowess":
            grid, fit = regression.lowess(gx, gy, frac, it, delta)
            lo = hi = np.full(len(grid), np.nan)
            coefficients.append(np.full(2, np.nan))
        else:
            start, stop = (float(gx.min()), float(gx.max())) if truncate else span
            grid = np.linspace(start, stop, grid_size)
            fx, fgrid = (np.log(gx), np.log(grid)) if logx else (gx, grid)
            result = regression.fit(fx, gy, model.kind, model.order, gw)
            coefficients.append(result.in_x())
            fit = result(fgrid)
            lo = hi = np.full(len(grid), np.nan)
            if banded:
                lo, hi = fit_band(
                    fx,
                    gy,
                    fgrid,
                    model.order,
                    n_boot,
                    used_seed or 0,
                    ci or 95,
                    failures,
                    model=model.kind,
                    weights=gw,
                    ranks=ranks,
                )
        keys.append(np.tile(np.asarray(key, dtype=np.int64), (len(grid), 1)))
        for name, part in ((x, grid), (fitted, fit), (low, lo), (high, hi)):
            fits[name].append(np.asarray(part, dtype=float))
    width = len(names)
    key_rows = np.concatenate(keys) if keys else np.zeros((0, width), dtype=np.int64)
    fit_table = keyed_table(variables, key_rows)
    for name in (x, fitted, low, high):
        fit_table[name] = number_column(np.concatenate(fits[name]) if fits[name] else [])
    sentence = _sentence(
        x,
        y,
        series,
        model,
        frac,
        it,
        fit_reg,
        banded,
        ci,
        n_boot,
        used_seed,
        weight,
        units,
        (x_partial, y_partial),
        x_estimator if estimating else None,
        x_bins,
        x_ci,
    )
    if unfit:
        sentence += (
            f" {unfit} group{'s' if unfit > 1 else ''} with too few distinct {x} values had no fit."
        )
    sentence += failures.sentence(x)
    sentence += dropped_sentence(
        dropped, [x, y, weight, units, x_partial, y_partial, *names], series_order is not None
    )
    # The points under y's name, unless x has it too, so that each keeps its values.
    point_table = rows_table(variables, rows)
    point_table[x] = number_column(point_x)
    point_table[fitted] = number_column(point_y)
    chart = make_chart(
        point_table, options, sentence=sentence, palette=palette, x_label=x, y_label=y
    )
    label = None if series else y
    # Estimates beside x under the fitted values' name, apart from x's when y is x.
    estimate_table = _estimate_table(estimates, variables, x, fitted, (low, high))
    if scatter and estimating:
        chart.point(x, fitted, data=estimate_table, series=series, label=label)
        if x_ci is not None and not (x_ci == "ci" and ci is None):
            chart.error_bar(
                x=x,
                y1=low,
                y2=high,
                data=estimate_table,
                series=series,
                label=label,
            )
    elif scatter:
        chart.point(x, fitted, series=series, label=label)
    if banded:
        # A band per series, of the fit line's table: each stands for what its
        # line does, sharing its color, legend entry, and visibility.
        chart.area(x, y1=low, y2=high, data=fit_table, series=series, label=label, fill_opacity=0.2)
    if fit_reg:
        chart.line(x, fitted, data=fit_table, series=series, label=label)
    terms = model.order + 1
    coefficient_table = {
        "group": np.arange(len(coefficients)),
        **{f"x^{power}": np.array([c[power] for c in coefficients]) for power in range(terms)},
    }
    tables: dict[str, Any] = {"fit": readable(fit_table), "coefficients": coefficient_table}
    if estimating:
        tables["estimates"] = readable(estimate_table)
    stats = Statistics("regplot", sentence, tables, used_seed, dropped)
    return record(chart, stats)


@dataclass(frozen=True)
class _Model:
    """The regression a call fits, and the option that chose it."""

    kind: Literal["polynomial", "logistic", "robust", "lowess"]
    order: int
    option: str


def _model(
    order: int, logistic: bool, robust: bool, lowess: bool, logx: bool, function: str
) -> _Model:
    if not (isinstance(order, int) and not isinstance(order, bool) and order >= 1):
        raise ValueError(
            f"{function} order: expected a whole number of at least 1; received {shown(order)}"
        )
    for name, flag in (("logistic", logistic), ("robust", robust), ("lowess", lowess)):
        if not isinstance(flag, bool):
            raise TypeError(f"{function} {name}: expected True or False; received {shown(flag)}")
    if not isinstance(logx, bool):
        raise TypeError(f"{function} logx: expected True or False; received {shown(logx)}")
    chosen = [
        name
        for name, flag in (
            ("order", order > 1),
            ("logistic", logistic),
            ("robust", robust),
            ("lowess", lowess),
            ("logx", logx),
        )
        if flag
    ]
    if len(chosen) > 1:
        raise ValueError(
            f"{function} {chosen[1]}: {' and '.join(chosen)} each choose the fit; give one"
        )
    if logistic:
        return _Model("logistic", 1, "logistic")
    if robust:
        return _Model("robust", 1, "robust")
    if lowess:
        return _Model("lowess", 1, "lowess")
    return _Model("polynomial", order, "logx" if logx else "order")


def _sentence(
    x: str,
    y: str,
    series: str | None,
    model: _Model,
    frac: float,
    it: int,
    fit_reg: bool,
    banded: bool,
    ci: float | None,
    n_boot: int,
    seed: int | None,
    weight: str | None,
    units: str | None,
    partials: tuple[str | None, str | None],
    x_estimator: Any,
    x_bins: Any,
    x_ci: XInterval,
) -> str:
    """What regplot's chart shows, in words."""
    if x_estimator is not None or x_bins is not None:
        estimator = x_estimator or "mean"
        name = estimator if isinstance(estimator, str) else function_name(estimator, "estimate")
        at = f"each of {_bin_count(x_bins)} bins of {x}" if x_bins is not None else f"each {x}"
        sentence = f"Points show the {name} of {y} at {at}{by(series)}"
        if x_ci == "sd":
            sentence += ", with error bars of ±1 standard deviation"
        elif x_ci is not None and not (x_ci == "ci" and ci is None):
            level = ci if x_ci == "ci" else x_ci
            sentence += f", with {level:g}% bootstrap confidence intervals"
    else:
        sentence = f"Points show {y} against {x}{by(series)}"
    removed = [name for name in partials if name is not None]
    if removed:
        sentence += f", with the linear effect of {' and '.join(removed)} removed"
    if fit_reg:
        if model.kind == "lowess":
            method = f"lowess (frac {frac:.3g}, {it} robustifying iterations)"
        elif model.kind == "logistic":
            method = "logistic regression fits"
        elif model.kind == "robust":
            method = "robust linear fits (Huber's T)"
        elif model.order > 1:
            method = f"order-{model.order} polynomial least-squares fits"
        elif model.option == "logx":
            method = f"linear least-squares fits in log {x}"
        else:
            method = "linear least-squares fits"
        sentence += f"; lines show {method}"
        if weight is not None:
            sentence += f", each row weighted by {weight}"
        if banded:
            resampled = (
                f"{n_boot:,} resamples of the units of {units} and the rows within them"
                if units
                else f"{n_boot:,} resamples of the rows"
            )
            sentence += (
                f", with {ci:g}% bootstrap confidence bands ({resampled}, "
                f"seed {seed}, percentile method)"
            )
    return sentence + "."


def _bin_count(x_bins: Any) -> int:
    return int(x_bins) if isinstance(x_bins, numbers.Integral) else len(x_bins)


def _x_estimates(
    name: str,
    x: np.ndarray,
    y: np.ndarray,
    ranks: np.ndarray | None,
    key: tuple[int, ...],
    estimator: Estimator,
    bins: int | Sequence[float] | None,
    x_ci: XInterval,
    ci: float | None,
    n_boot: int,
    seed: int | None,
) -> dict[str, Any]:
    """A group's estimates of y at each distinct x (or bin center), with
    their intervals, as Seaborn's ``x_estimator`` draws them."""
    if bins is not None:
        x, _ = regression.bin_predictor(x, bins)  # type: ignore[arg-type]
    given = estimator
    at = np.unique(x)
    centers, lows, highs = [], [], []
    level = ci if x_ci == "ci" else x_ci
    for value in at:
        members = np.flatnonzero(x == value)
        sample = y[members]
        where = functools.partial(str, f"{name} {level_label(float(value), 'number')}")
        estimator = checking(given, "regplot x_estimator", sample, where)
        if level is None:
            center, lo, hi = numerics.estimate(sample, estimator), math.nan, math.nan
        elif level == "sd":
            # Seaborn's x_ci="sd" is NumPy's standard deviation (ddof 0).
            center = numerics.estimate(sample, estimator)
            spread = float(np.std(sample))
            lo, hi = center - spread, center + spread
        else:
            units = None if ranks is None else numerics.units_of(ranks[members])

            def compute(
                sample: np.ndarray = sample,
                units: numerics.Units | None = units,
                estimator: Estimator = estimator,
            ) -> tuple[float, float, float]:
                return _x_interval(sample, estimator, float(level), n_boot, seed or 0, units)

            if callable(estimator):
                center, lo, hi = compute()
            else:
                member_ranks = None if ranks is None else ranks[members]
                parts = ["x interval", sample, member_ranks, estimator, level, n_boot, seed]
                center, lo, hi = reused(parts, compute)
        centers.append(center)
        lows.append(lo)
        highs.append(hi)
    return {"key": key, "x": at, "y": np.array(centers), "low": lows, "high": highs}


def _x_interval(
    sample: np.ndarray,
    estimator: Estimator,
    level: float,
    n_boot: int,
    seed: int,
    units: numerics.Units | None,
) -> tuple[float, float, float]:
    """An estimate and its bootstrap interval, as Seaborn's ``x_estimator``
    computes them: a group of one value is resampled too."""
    center = numerics.estimate(sample, estimator)
    boots = numerics.bootstrap_estimates(sample, estimator, n_boot, seed, units=units)
    return (center, *numerics.percentile_interval(boots, level))


def _estimate_table(
    estimates: list[dict[str, Any]],
    variables: dict[str, Levels],
    x: str,
    y: str,
    ends: tuple[str, str],
) -> dict[str, Column]:
    """The groups' estimates as one table."""
    keys = [np.tile(np.asarray(e["key"], dtype=np.int64), (len(e["x"]), 1)) for e in estimates]
    table = keyed_table(
        variables, np.concatenate(keys) if keys else np.zeros((0, len(variables)), dtype=np.int64)
    )
    for name, field in ((x, "x"), (y, "y"), (ends[0], "low"), (ends[1], "high")):
        parts = [np.asarray(e[field], dtype=float) for e in estimates]
        table[name] = number_column(np.concatenate(parts) if parts else [])
    return table


def _check_x_ci(x_ci: Any, function: str) -> None:
    if x_ci in (None, "ci", "sd"):
        return
    if isinstance(x_ci, bool) or not (isinstance(x_ci, numbers.Real) and 0 < float(x_ci) <= 100):
        raise ValueError(
            f'{function} x_ci: expected "ci", "sd", a percentage above 0 and at most 100, or '
            f"None; received {shown(x_ci)}"
        )


def _check_bins(x_bins: Any, function: str) -> None:
    if x_bins is None:
        return
    if isinstance(x_bins, numbers.Integral) and not isinstance(x_bins, bool):
        if int(x_bins) < 1:
            raise ValueError(
                f"{function} x_bins: expected a count of at least 1 or bin centers; "
                f"received {shown(x_bins)}"
            )
        return
    try:
        centers = np.asarray(x_bins, dtype=float)
    except (TypeError, ValueError):
        centers = np.array([np.nan])
    if centers.ndim != 1 or len(centers) == 0 or not np.isfinite(centers).all():
        raise ValueError(
            f"{function} x_bins: expected a count of at least 1 or finite bin centers; "
            f"received {shown(x_bins)}"
        )


def check_ci(ci: float | None, function: str) -> None:
    """Refuses a confidence level that is not a percentage."""
    if ci is not None and not (0 < ci <= 100):
        raise ValueError(
            f"{function} ci: expected a percentage above 0 and at most 100; received {shown(ci)}"
        )


@dataclass
class BandFailures:
    """Resamples left out of bootstrap bands, and bands left out for want of them."""

    too_few: int = 0
    unstable: int = 0
    separated: int = 0
    #: Fits with fewer than two usable resamples, drawn without a band.
    bandless: int = 0

    def sentence(self, x: str) -> str:
        """What the chart's description says of them; empty for none."""
        out = ""
        if self.too_few:
            out += (
                f" {self.too_few:,} resample{'s' if self.too_few > 1 else ''} with too few "
                f"distinct {x} values to fit were left out of the bands."
            )
        if self.unstable:
            out += (
                f" {self.unstable:,} resample{'s' if self.unstable > 1 else ''} too "
                "ill-conditioned to fit were left out of the bands."
            )
        if self.separated:
            out += (
                f" {self.separated:,} resample{'s' if self.separated > 1 else ''} whose "
                f"outcomes {x} separates perfectly had no logistic fit and were left out "
                "of the bands."
            )
        if self.bandless == 1:
            out += " A fit with fewer than two resamples that could be fit has no band."
        elif self.bandless:
            out += (
                f" {self.bandless} fits with fewer than two resamples that could be fit "
                "have no band."
            )
        return out


def fit_band(
    x: np.ndarray,
    y: np.ndarray,
    grid: np.ndarray,
    order: int,
    n_boot: int,
    seed: int,
    ci: float,
    failures: BandFailures,
    *,
    model: regression.Model = "polynomial",
    weights: np.ndarray | None = None,
    ranks: np.ndarray | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """The bootstrap confidence band of a fit at `grid`, NaN when fewer than
    two resamples could be fit; counts what was left out. A group of the
    same rows (and grid) as the chart being recomputed reuses its band."""

    def compute() -> tuple[tuple[int, int, int, int], np.ndarray, np.ndarray]:
        units = None if ranks is None else numerics.units_of(ranks)
        fits = regression.bootstrap(
            x, y, grid, n_boot, seed, model=model, order=order, weights=weights, units=units
        )
        # What the band needs kept, not every resample's predictions.
        counts = (fits.too_few, fits.unstable, fits.separated, fits.usable)
        if fits.usable < 2:
            nan = np.full(len(grid), np.nan)
            return counts, nan, nan
        return (counts, *regression.band(fits.predictions, ci))

    parts = ["band", x, y, weights, ranks, grid, model, order, n_boot, seed, ci]
    (too_few, unstable, separated, usable), low, high = reused(parts, compute)
    failures.too_few += too_few
    failures.unstable += unstable
    failures.separated += separated
    if usable < 2:
        failures.bandless += 1
    return low, high


@express
def residplot(
    data: Any,
    *,
    x: str,
    y: str,
    order: int = 1,
    robust: bool = False,
    lowess: bool = False,
    frac: float = 2 / 3,
    it: int = 3,
    delta: float = 0.0,
    x_partial: str | None = None,
    y_partial: str | None = None,
    **options: Unpack[ExpressOptions],
) -> Chart:
    """The residuals of ``y`` from a least-squares polynomial fit of
    ``order`` in ``x`` (or with ``robust=True`` a robust line), against
    ``x``, around a rule at zero. ``lowess=True`` adds a lowess line
    through the residuals, showing structure the fit missed.
    ``x_partial`` and ``y_partial`` remove the linear effect of other
    columns first, as in ``regplot``.
    """
    model = _model(order, False, robust, False, False, "residplot")
    if not isinstance(lowess, bool):
        raise TypeError(f"residplot lowess: expected True or False; received {shown(lowess)}")
    _check_lowess(frac, it, delta, "residplot")
    refuse_facets(options, "residplot", "residplot fits all the rows at once")
    source = Source(data)
    xc = source.column(x, "residplot x", ("number",))
    yc = source.column(y, "residplot y", ("number",))
    partials = [
        None if name is None else source.column(name, f"residplot {role}", ("number",))
        for name, role in ((x_partial, "x_partial"), (y_partial, "y_partial"))
    ]
    rows = complete(len(xc), xc, yc, *partials)
    dropped = len(xc) - len(rows)
    xv, yv = values(xc)[rows], values(yc)[rows]
    if partials[0] is not None:
        xv = regression.regress_out(xv, values(partials[0])[rows])
    if partials[1] is not None:
        yv = regression.regress_out(yv, values(partials[1])[rows])
    if len(np.unique(xv)) <= model.order:
        raise ValueError(
            f"an order-{model.order} fit needs more than {model.order} distinct {x} values"
        )
    residual = yv - regression.fit(xv, yv, model.kind, model.order)(xv)  # type: ignore[arg-type]
    (name,) = fresh(["residual"], {x})
    table = {x: number_column(xv), name: number_column(residual)}
    fit = (
        "robust linear (Huber's T)"
        if robust
        else "linear least-squares"
        if order == 1
        else f"order-{order} polynomial least-squares"
    )
    sentence = f"Points show the residuals of {y} from a {fit} fit in {x}"
    removed = [column for column in (x_partial, y_partial) if column is not None]
    if removed:
        sentence += f", with the linear effect of {' and '.join(removed)} removed"
    if lowess:
        sentence += (
            f", with a lowess line through them (frac {frac:.3g}, {it} robustifying iterations)"
        )
    sentence += "." + dropped_sentence(dropped, [x, y, x_partial, y_partial])
    chart = make_chart(table, options, sentence=sentence, x_label=x, y_label=f"{y} residual")
    chart.rule(y=0, stroke=neutral(options.get("theme")), dash=[3, 3])
    chart.point(x, name, label=f"{y} residual")
    tables: dict[str, Any] = {"residuals": readable(table)}
    if lowess:
        grid, smooth = regression.lowess(xv, residual, frac, it, delta)
        line_table = {x: number_column(grid), name: number_column(smooth)}
        chart.line(x, name, data=line_table, label="lowess", stroke=neutral(options.get("theme")))
        tables["lowess"] = readable(line_table)
    return record(chart, Statistics("residplot", sentence, tables, None, dropped))


def _check_lowess(frac: float, it: int, delta: float, function: str) -> None:
    if not (0 < frac <= 1):
        raise ValueError(
            f"{function} frac: expected a number above 0 and at most 1; received {shown(frac)}"
        )
    if not (isinstance(it, int) and not isinstance(it, bool) and it >= 0):
        raise ValueError(
            f"{function} it: expected a whole number of at least 0; received {shown(it)}"
        )
    if not (delta >= 0):
        raise ValueError(f"{function} delta: expected at least 0; received {shown(delta)}")
