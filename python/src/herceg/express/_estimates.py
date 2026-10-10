"""Estimates with intervals: barplot, pointplot, and lineplot."""

from __future__ import annotations

import math
import sys
from collections.abc import Sequence
from typing import Any, Literal

import numpy as np

from .._chart import Chart, HelperOptions
from . import _numerics as numerics
from ._common import (
    HUE_GROUP,
    ErrorBar,
    Source,
    Statistics,
    by,
    category_column,
    check_axes_differ,
    check_choice,
    check_n_boot,
    complete,
    describe_interval,
    dropped_sentence,
    error_method,
    fresh,
    group,
    keyed_table,
    levels,
    make_chart,
    neutral,
    number_column,
    readable,
    record,
    rows_table,
    seed_of,
    subset,
    values,
    variables_of,
)

if sys.version_info >= (3, 11):
    from typing import Unpack
else:
    from typing_extensions import Unpack

Estimator = Literal["mean", "median"]
Orient = Literal["v", "h", "x", "y"]


def barplot(
    data: Any,
    *,
    x: str,
    y: str,
    hue: str | None = None,
    order: Sequence[Any] | None = None,
    hue_order: Sequence[Any] | None = None,
    orient: Orient | None = None,
    estimator: Estimator = "mean",
    errorbar: ErrorBar = ("ci", 95),
    n_boot: int = 1000,
    seed: int | None = None,
    col: str | None = None,
    row: str | None = None,
    palette: Sequence[str] | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """Bars of an estimate (the ``estimator``, mean or median) of a number
    column per category, with error bars over each.

    One of ``x`` and ``y`` names categories, the other the values; a
    category ``y`` (or ``orient="h"``) lays the bars along y. ``hue`` splits
    each category's bars by another column, side by side. ``errorbar`` is
    ``("ci", level)``, a bootstrap confidence interval of ``n_boot``
    resamples with ``seed`` (drawn and recorded when not given),
    ``("pi", width)``, the central percentile interval of the values,
    ``("se", k)`` or ``("sd", k)``, k standard errors or deviations about
    the estimate, or ``None``. Groups of one value have no interval. Rows
    missing a value or a category are left out. ``order`` and
    ``hue_order`` choose and order levels; ``col`` and ``row`` facet;
    other keyword arguments are chart options.
    """
    check_axes_differ(x, y, "barplot")
    est = _CategoryEstimates(
        data, x, y, hue, order, hue_order, orient, estimator, errorbar, n_boot, seed, col, row
    )
    chart = make_chart(
        est.table,
        options,
        sentence=est.sentence("Bars"),
        col=col,
        row=row,
        palette=palette,
        x_label=x,
        y_label=y,
    )
    label = None if hue else est.value
    xy = (est.value, est.category) if est.horizontal else (est.category, est.value)
    chart.bar(*xy, series=hue, label=label, legend_group=HUE_GROUP)
    est.error_bars(chart, dodge=hue is not None, stroke=neutral(options.get("theme")))
    return record(chart, est.statistics("barplot"))


def pointplot(
    data: Any,
    *,
    x: str,
    y: str,
    hue: str | None = None,
    order: Sequence[Any] | None = None,
    hue_order: Sequence[Any] | None = None,
    orient: Orient | None = None,
    estimator: Estimator = "mean",
    errorbar: ErrorBar = ("ci", 95),
    n_boot: int = 1000,
    seed: int | None = None,
    dodge: bool = False,
    col: str | None = None,
    row: str | None = None,
    palette: Sequence[str] | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """Points at an estimate of a number column per category, with error
    bars, as ``barplot`` computes them; ``dodge=True`` places the ``hue``
    levels side by side within each category. Unlike Seaborn's, the points
    are not joined by lines (lines cannot be drawn along category axes yet).
    """
    check_axes_differ(x, y, "pointplot")
    est = _CategoryEstimates(
        data, x, y, hue, order, hue_order, orient, estimator, errorbar, n_boot, seed, col, row
    )
    chart = make_chart(
        est.table,
        options,
        sentence=est.sentence("Points"),
        col=col,
        row=row,
        palette=palette,
        x_label=x,
        y_label=y,
    )
    spread = dodge and hue is not None
    label = None if hue else est.value
    est.error_bars(chart, dodge=spread)
    xy = (est.value, est.category) if est.horizontal else (est.category, est.value)
    chart.point(*xy, series=hue, dodge=spread, r=4, label=label, legend_group=HUE_GROUP)
    return record(chart, est.statistics("pointplot"))


def lineplot(
    data: Any,
    *,
    x: str,
    y: str,
    hue: str | None = None,
    hue_order: Sequence[Any] | None = None,
    estimator: Estimator | None = "mean",
    errorbar: ErrorBar = ("ci", 95),
    n_boot: int = 1000,
    seed: int | None = None,
    err_style: Literal["band", "bars"] = "band",
    sort: bool = True,
    col: str | None = None,
    row: str | None = None,
    palette: Sequence[str] | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """Lines through an estimate of ``y`` at each distinct ``x`` (a number or
    time column), with an interval as a band (``err_style="band"``) or error
    bars, per ``hue`` level. ``estimator=None`` draws the rows themselves
    (with ``errorbar=None``), in ``x`` order unless ``sort=False``.
    Intervals are computed as in ``barplot``.
    """
    check_choice(err_style, "err_style", ("band", "bars"))
    check_choice(estimator, "estimator", ("mean", "median", None))
    source = Source(data)
    xc = source.column(x, "lineplot x", ("number", "time"))
    yc = source.column(y, "lineplot y", ("number",))
    variables = variables_of(source, row, col, hue, hue_order, axes=[x, y])
    rows = complete(len(xc), xc, yc, levels_of=list(variables.values()))
    dropped = len(xc) - len(rows)
    xv, yv = values(xc), values(yc)
    names = [*variables]
    if estimator is None:
        if errorbar is not None:
            raise ValueError("lineplot without an estimator draws rows: pass errorbar=None")
        rows = rows[np.argsort(xv[rows], kind="stable")] if sort else rows
        table = rows_table(variables, rows)
        table[x] = number_column(xv[rows], xc.kind)
        table[y] = number_column(yv[rows])
        sentence = f"Lines join the rows' {y} in {x} order{by(hue)}." + dropped_sentence(
            dropped, [x, y, *names], hue_order is not None
        )
        chart = make_chart(
            table,
            options,
            sentence=sentence,
            col=col,
            row=row,
            palette=palette,
            x_label=x,
            y_label=y,
        )
        chart.line(x, y, series=hue, label=None if hue else y, legend_group=HUE_GROUP)
        stats = Statistics("lineplot", sentence, {"rows": readable(table)}, None, dropped)
        return record(chart, stats)
    interval = error_method(errorbar)
    n_boot = check_n_boot(n_boot)
    used_seed = seed_of(seed) if interval and interval[0] == "ci" else None
    # One group per facet panel, hue level, and distinct x, in that order.
    x_levels = levels(xc)
    grouping = group([*variables.values(), x_levels], rows)
    # The estimates' column: y's name, unless x has it too.
    (estimated,) = fresh([y], {x, *names})
    low, high, count = fresh(["low", "high", "n"], {x, estimated, *names})
    out: dict[str, list[float]] = {x: [], estimated: [], low: [], high: [], count: []}
    keys: list[tuple[int, ...]] = []
    for key, members in grouping:
        sample = yv[members]
        center, lo, hi = _estimate(sample, estimator, interval, n_boot, used_seed)
        keys.append(key[:-1])
        out[x].append(float(xv[members[0]]))
        out[estimated].append(center)
        out[low].append(lo)
        out[high].append(hi)
        out[count].append(len(sample))
    table = keyed_table(variables, keys)
    table[x] = number_column(out[x], xc.kind)
    table[estimated] = number_column(out[estimated])
    if interval:
        table[low] = number_column(out[low])
        table[high] = number_column(out[high])
    table[count] = number_column(out[count])
    sentence = (
        f"Lines show the {estimator} of {y} at each {x}{by(hue)}"
        + (
            f"; {'bands' if err_style == 'band' else 'error bars'} show "
            + describe_interval(interval[0], interval[1], n_boot, used_seed)
            if interval
            else ""
        )
        + "."
        + dropped_sentence(dropped, [x, y, *names], hue_order is not None)
    )
    chart = make_chart(
        table, options, sentence=sentence, col=col, row=row, palette=palette, x_label=x, y_label=y
    )
    label = None if hue else y
    if interval and err_style == "band":
        # Bands between two fields take no series: one per hue level, named
        # like its line so that the legend group shares color and visibility.
        hue_levels = variables[hue].labels if hue else (y,)
        for i, name in enumerate(hue_levels):
            position = names.index(hue) if hue else 0
            part = table if hue is None else subset(table, _at_level(keys, position, i))
            chart.area(
                x, y1=low, y2=high, data=part, label=name, fill_opacity=0.2, legend_group=HUE_GROUP
            )
    if interval and err_style == "bars":
        chart.error_bar(x=x, y1=low, y2=high, series=hue, label=label, legend_group=HUE_GROUP)
    chart.line(x, estimated, series=hue, label=label, legend_group=HUE_GROUP)
    stats = Statistics("lineplot", sentence, {"estimates": readable(table)}, used_seed, dropped)
    return record(chart, stats)


# Shared --------------------------------------------------------------------------


class _CategoryEstimates:
    """barplot's and pointplot's table: per facet panel, hue level, and
    category, the estimate of the values, its interval, and the count."""

    def __init__(
        self,
        data: Any,
        x: str,
        y: str,
        hue: str | None,
        order: Sequence[Any] | None,
        hue_order: Sequence[Any] | None,
        orient: Orient | None,
        estimator: Estimator,
        errorbar: ErrorBar,
        n_boot: int,
        seed: int | None,
        col: str | None,
        row: str | None,
    ) -> None:
        check_choice(estimator, "estimator", ("mean", "median"))
        check_choice(orient, "orient", ("v", "h", "x", "y", None))
        source = Source(data)
        xc = source.column(x, "x")
        yc = source.column(y, "y")
        horizontal = orient in ("h", "y") or (
            orient is None and yc.kind == "category" and xc.kind != "category"
        )
        category, value = (y, x) if horizontal else (x, y)
        vc = yc if not horizontal else xc
        if vc.kind != "number":
            axis = "x" if horizontal else "y"
            raise TypeError(f"{axis}: column {value!r} holds {vc.kind} values; expected number")
        if hue is not None and hue == category:
            raise ValueError(f"hue must differ from the category column {category!r}")
        self.horizontal = horizontal
        self.category, self.value = category, value
        self.hue = hue
        self.estimator = estimator
        variables = variables_of(source, row, col, hue, hue_order, axes=[category, value])
        cats = levels(source.column(category, "x" if not horizontal else "y"), order)
        rows = complete(len(vc), vc, levels_of=[*variables.values(), cats])
        self.dropped = len(vc) - len(rows)
        self.interval = error_method(errorbar)
        self.n_boot = check_n_boot(n_boot)
        self.seed = seed_of(seed) if self.interval and self.interval[0] == "ci" else None
        names = [*variables]
        self.low, self.high, count = fresh(["low", "high", "n"], {category, value, *names})
        grouping = group([*variables.values(), cats], rows)
        v = values(vc)
        keys, codes, centers, lows, highs, counts = [], [], [], [], [], []
        for key, members in grouping:
            center, lo, hi = _estimate(v[members], estimator, self.interval, self.n_boot, self.seed)
            keys.append(key[:-1])
            codes.append(key[-1])
            centers.append(center)
            lows.append(lo)
            highs.append(hi)
            counts.append(len(members))
        table = keyed_table(variables, keys)
        table[category] = category_column(codes, cats.labels)
        table[value] = number_column(centers)
        if self.interval:
            table[self.low] = number_column(lows)
            table[self.high] = number_column(highs)
        table[count] = number_column(counts)
        self.table = table
        self._roles = [x, y, *names]
        self._ordered = order is not None or hue_order is not None

    def error_bars(self, chart: Chart, *, dodge: bool, stroke: str | None = None) -> None:
        """Adds the intervals, if any, on the categories."""
        if not self.interval:
            return
        style: dict[str, Any] = {
            "series": self.hue,
            "dodge": dodge,
            "stroke": stroke,
            "label": None if self.hue else self.value,
            "legend_group": HUE_GROUP,
        }
        if self.horizontal:
            chart.error_bar(y=self.category, x1=self.low, x2=self.high, **style)
        else:
            chart.error_bar(x=self.category, y1=self.low, y2=self.high, **style)

    def sentence(self, shapes: str) -> str:
        interval = self.interval
        text = f"{shapes} show the {self.estimator} of {self.value} for each {self.category}"
        text += by(self.hue)
        if interval:
            text += "; error bars show " + describe_interval(
                interval[0], interval[1], self.n_boot, self.seed
            )
        return text + "." + dropped_sentence(self.dropped, self._roles, self._ordered)

    def statistics(self, function: str) -> Statistics:
        return Statistics(
            function,
            self.sentence("Bars" if function == "barplot" else "Points"),
            {"estimates": readable(self.table)},
            self.seed,
            self.dropped,
        )


def _estimate(
    sample: np.ndarray,
    estimator: Estimator,
    interval: tuple[str, float] | None,
    n_boot: int,
    seed: int | None,
) -> tuple[float, float, float]:
    if interval is None:
        return numerics.estimate(sample, estimator), math.nan, math.nan
    method, level = interval
    return numerics.interval(sample, estimator, method, level, n_boot, seed or 0)  # type: ignore[arg-type]


def _at_level(keys: list[tuple[int, ...]], position: int, level: int) -> np.ndarray:
    """The output rows whose key has ``level`` at ``position``."""
    return np.array([i for i, key in enumerate(keys) if key[position] == level], dtype=np.intp)
