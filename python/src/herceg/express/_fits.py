"""Fits: regplot and residplot."""

from __future__ import annotations

import sys
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

import numpy as np

from .._chart import Chart, HelperOptions
from . import _numerics as numerics
from ._common import (
    SERIES_GROUP,
    Source,
    Statistics,
    by,
    check_grid_size,
    check_n_boot,
    complete,
    dropped_sentence,
    facets,
    fresh,
    group,
    keyed_table,
    make_chart,
    neutral,
    number_column,
    readable,
    record,
    refuse_facets,
    rows_table,
    seed_of,
    shown,
    subset,
    values,
    variables_of,
)

if sys.version_info >= (3, 11):
    from typing import Unpack
else:
    from typing_extensions import Unpack


def regplot(
    data: Any,
    *,
    x: str,
    y: str,
    series: str | None = None,
    series_order: Sequence[Any] | None = None,
    order: int = 1,
    lowess: bool = False,
    frac: float = 2 / 3,
    it: int = 3,
    delta: float = 0.0,
    ci: float | None = 95,
    n_boot: int = 1000,
    seed: int | None = None,
    scatter: bool = True,
    truncate: bool = True,
    grid_size: int = 100,
    palette: Sequence[str] | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """Points of ``y`` against ``x`` with a regression line and its
    confidence band, per ``series`` (and facet panel).

    The fit is a least-squares polynomial of ``order`` (1, a straight line,
    by default) at ``grid_size`` points over each group's ``x`` range (all
    the data's with ``truncate=False``), with a ``ci`` percent bootstrap
    band: the fit repeated on ``n_boot`` resamples of the rows, drawn with
    ``seed``. ``lowess=True`` fits a locally weighted line instead, as
    statsmodels' ``lowess(y, x, frac, it, delta)`` does, without a band.
    ``scatter=False`` leaves out the points.
    """
    if not (isinstance(order, int) and not isinstance(order, bool) and order >= 1):
        raise ValueError(
            f"regplot order: expected a whole number of at least 1; received {shown(order)}"
        )
    if lowess and order != 1:
        raise ValueError(
            "regplot order: a lowess fit has no polynomial order; drop order or lowess"
        )
    check_ci(ci, "regplot")
    grid_size = check_grid_size(grid_size, "regplot grid_size")
    _check_lowess(frac, it, delta, "regplot")
    n_boot = check_n_boot(n_boot, "regplot")
    facet_row, facet_column = facets(options, "regplot")
    source = Source(data)
    xc = source.column(x, "regplot x", ("number",))
    yc = source.column(y, "regplot y", ("number",))
    variables = variables_of(
        source, "regplot", facet_row, facet_column, series, series_order, axes=[x, y]
    )
    rows = complete(len(xc), xc, yc, levels_of=list(variables.values()))
    dropped = len(xc) - len(rows)
    xv, yv = values(xc), values(yc)
    banded = ci is not None and not lowess
    used_seed = seed_of(seed, "regplot") if banded else None
    names = [*variables]
    # The fitted values' column: y's name, unless x has it too.
    (fitted,) = fresh([y], {x, *names})
    low, high = fresh(["low", "high"], {x, fitted, *names})
    fits: dict[str, list[np.ndarray]] = {x: [], fitted: [], low: [], high: []}
    keys: list[np.ndarray] = []
    coefficients: list[np.ndarray] = []
    unfit = 0
    failures = BandFailures()
    span = (float(xv[rows].min()), float(xv[rows].max())) if len(rows) else (0.0, 0.0)
    for key, members in group(list(variables.values()), rows):
        gx, gy = xv[members], yv[members]
        if len(np.unique(gx)) <= order:
            unfit += 1
            continue
        if lowess:
            grid, fit = numerics.lowess(gx, gy, frac, it, delta)
            lo = hi = np.full(len(grid), np.nan)
            coefficients.append(np.full(order + 1, np.nan))
        else:
            start, stop = (float(gx.min()), float(gx.max())) if truncate else span
            grid = np.linspace(start, stop, grid_size)
            polynomial = numerics.polynomial_fit(gx, gy, order)
            coefficients.append(polynomial.in_x())
            fit = polynomial(grid)
            lo = hi = np.full(len(grid), np.nan)
            if banded:
                lo, hi = fit_band(gx, gy, grid, order, n_boot, used_seed or 0, ci or 95, failures)
        keys.append(np.tile(np.asarray(key, dtype=np.int64), (len(grid), 1)))
        for name, part in ((x, grid), (fitted, fit), (low, lo), (high, hi)):
            fits[name].append(np.asarray(part, dtype=float))
    width = len(names)
    key_rows = np.concatenate(keys) if keys else np.zeros((0, width), dtype=np.int64)
    fit_table = keyed_table(variables, key_rows)
    for name in (x, fitted, low, high):
        fit_table[name] = number_column(np.concatenate(fits[name]) if fits[name] else [])
    method = (
        f"lowess (frac {frac:.3g}, {it} robustifying iterations)"
        if lowess
        else ("linear" if order == 1 else f"order-{order} polynomial") + " least-squares fits"
    )
    sentence = f"Points show {y} against {x}{by(series)}; lines show {method}"
    if banded:
        sentence += (
            f", with {ci:g}% bootstrap confidence bands ({n_boot:,} resamples of the rows, "
            f"seed {used_seed}, percentile method)"
        )
    sentence += "."
    if unfit:
        sentence += (
            f" {unfit} group{'s' if unfit > 1 else ''} with too few distinct {x} values had no fit."
        )
    sentence += failures.sentence(x)
    sentence += dropped_sentence(dropped, [x, y, *names], series_order is not None)
    point_table = rows_table(variables, rows)
    point_table[x] = number_column(xv[rows])
    point_table[y] = number_column(yv[rows])
    chart = make_chart(
        point_table, options, sentence=sentence, palette=palette, x_label=x, y_label=y
    )
    label = None if series else y
    if scatter:
        chart.point(x, y, series=series, label=label, legend_group=SERIES_GROUP)
    if banded:
        series_levels = variables[series].labels if series else (y,)
        position = names.index(series) if series else None
        for i, name in enumerate(series_levels):
            at_level = key_rows[:, position] == i if position is not None else None
            rows_at = slice(None) if at_level is None else np.flatnonzero(at_level)
            chart.area(
                x,
                y1=low,
                y2=high,
                data=subset(fit_table, rows_at),
                label=name,
                fill_opacity=0.2,
                legend_group=SERIES_GROUP,
            )
    chart.line(x, fitted, data=fit_table, series=series, label=label, legend_group=SERIES_GROUP)
    coefficient_table = {
        "group": np.arange(len(coefficients)),
        **{f"x^{power}": np.array([c[power] for c in coefficients]) for power in range(order + 1)},
    }
    stats = Statistics(
        "regplot",
        sentence,
        {"fit": readable(fit_table), "coefficients": coefficient_table},
        used_seed,
        dropped,
    )
    return record(chart, stats)


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
) -> tuple[np.ndarray, np.ndarray]:
    """The bootstrap confidence band of a polynomial fit at `grid`, NaN when
    fewer than two resamples could be fit; counts what was left out."""
    fits = numerics.bootstrap_fits(x, y, grid, order, n_boot, seed)
    failures.too_few += fits.too_few
    failures.unstable += fits.unstable
    if fits.usable < 2:
        failures.bandless += 1
        return np.full(len(grid), np.nan), np.full(len(grid), np.nan)
    return numerics.band(fits.predictions, ci)


def residplot(
    data: Any,
    *,
    x: str,
    y: str,
    order: int = 1,
    lowess: bool = False,
    frac: float = 2 / 3,
    it: int = 3,
    delta: float = 0.0,
    **options: Unpack[HelperOptions],
) -> Chart:
    """The residuals of ``y`` from a least-squares polynomial fit of
    ``order`` in ``x``, against ``x``, around a rule at zero. ``lowess=True``
    adds a lowess line through the residuals, showing structure the fit
    missed.
    """
    if not (isinstance(order, int) and not isinstance(order, bool) and order >= 1):
        raise ValueError(
            f"residplot order: expected a whole number of at least 1; received {shown(order)}"
        )
    _check_lowess(frac, it, delta, "residplot")
    refuse_facets(options, "residplot", "residplot fits all the rows at once")
    source = Source(data)
    xc = source.column(x, "residplot x", ("number",))
    yc = source.column(y, "residplot y", ("number",))
    rows = complete(len(xc), xc, yc)
    dropped = len(xc) - len(rows)
    xv, yv = values(xc)[rows], values(yc)[rows]
    if len(np.unique(xv)) <= order:
        raise ValueError(f"an order-{order} fit needs more than {order} distinct {x} values")
    residual = yv - numerics.polynomial_fit(xv, yv, order)(xv)
    (name,) = fresh(["residual"], {x})
    table = {x: number_column(xv), name: number_column(residual)}
    fit = "linear" if order == 1 else f"order-{order} polynomial"
    sentence = f"Points show the residuals of {y} from a {fit} least-squares fit in {x}"
    if lowess:
        sentence += (
            f", with a lowess line through them (frac {frac:.3g}, {it} robustifying iterations)"
        )
    sentence += "." + dropped_sentence(dropped, [x, y])
    chart = make_chart(table, options, sentence=sentence, x_label=x, y_label=f"{y} residual")
    chart.rule(y=0, stroke=neutral(options.get("theme")), dash=[3, 3])
    chart.point(x, name, label=f"{y} residual")
    tables: dict[str, Any] = {"residuals": readable(table)}
    if lowess:
        grid, smooth = numerics.lowess(xv, residual, frac, it, delta)
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
