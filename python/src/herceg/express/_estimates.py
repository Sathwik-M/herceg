"""Estimates with intervals: barplot, pointplot, and lineplot."""

from __future__ import annotations

import math
import sys
from collections.abc import Mapping, Sequence
from typing import Any, Literal

import numpy as np

from .._chart import Chart, HelperOptions
from .._data import Column
from . import _numerics as numerics
from ._common import (
    SERIES_GROUP,
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
    facets,
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
    sharing_fields,
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
#: Matplotlib's line styles: solid, dashed, dotted, dash-dot, or no line.
LineStyle = Literal["-", "--", ":", "-.", "none", ""]

#: Matplotlib's line styles as dash patterns in pixels; None is solid.
_DASHES: dict[str, list[float] | None] = {
    "-": None,
    "--": [6, 4],
    ":": [1.5, 3],
    "-.": [6, 3, 1.5, 3],
}


def barplot(
    data: Any,
    *,
    x: str,
    y: str,
    series: str | None = None,
    order: Sequence[Any] | None = None,
    series_order: Sequence[Any] | None = None,
    orient: Orient | None = None,
    estimator: Estimator = "mean",
    errorbar: ErrorBar = ("ci", 95),
    n_boot: int = 1000,
    seed: int | None = None,
    palette: Sequence[str] | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """Bars of an estimate (the ``estimator``, mean or median) of a number
    column per category, with error bars over each.

    One of ``x`` and ``y`` names categories, the other the values; a
    category ``y`` (or ``orient="h"``) lays the bars along y. ``series``
    splits each category's bars by another column, side by side. ``errorbar`` is
    ``("ci", level)``, a bootstrap confidence interval of ``n_boot``
    resamples with ``seed`` (drawn and recorded when not given),
    ``("pi", width)``, the central percentile interval of the values,
    ``("se", k)`` or ``("sd", k)``, k standard errors or deviations about
    the estimate, or ``None``. Groups of one value have no interval. Rows
    missing a value or a category are left out. ``order`` and
    ``series_order`` choose and order levels; other keyword arguments are
    chart options, among them ``facet_row`` and ``facet_column``, whose
    panels each compute their own estimates.
    """
    check_axes_differ(x, y, "barplot")
    est = _CategoryEstimates(
        "barplot",
        data,
        x,
        y,
        series,
        order,
        series_order,
        orient,
        estimator,
        errorbar,
        n_boot,
        seed,
        options,
    )
    chart = make_chart(
        est.table, options, sentence=est.sentence("Bars"), palette=palette, x_label=x, y_label=y
    )
    label = None if series else est.value
    xy = (est.value, est.category) if est.horizontal else (est.category, est.value)
    chart.bar(*xy, series=series, label=label, legend_group=SERIES_GROUP)
    est.error_bars(chart, dodge=series is not None, stroke=neutral(options.get("theme")))
    return record(chart, est.statistics("barplot"))


def pointplot(
    data: Any,
    *,
    x: str,
    y: str,
    series: str | None = None,
    order: Sequence[Any] | None = None,
    series_order: Sequence[Any] | None = None,
    orient: Orient | None = None,
    estimator: Estimator = "mean",
    errorbar: ErrorBar = ("ci", 95),
    n_boot: int = 1000,
    seed: int | None = None,
    dodge: bool = False,
    linestyles: LineStyle | Sequence[LineStyle] | None = None,
    linestyle: LineStyle | None = None,
    join: bool | None = None,
    palette: Sequence[str] | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """Points at an estimate of a number column per category, with error
    bars, as ``barplot`` computes them, joined by a line per ``series``
    through the categories in order; ``dodge=True`` places each ``series``
    side by side within each category. A series without an estimate in a
    category breaks its line there. ``linestyles`` is Matplotlib's style of
    the lines (``"-"``, ``"--"``, ``":"``, or ``"-."``), or a list of them,
    one per series level; ``"none"`` (or ``""``) draws none, and
    ``linestyle`` gives one style for every line.
    """
    check_axes_differ(x, y, "pointplot")
    if join is not None:
        raise ValueError(
            'pointplot join: Seaborn 0.13 deprecates it; pass linestyle="none" to draw no lines'
        )
    est = _CategoryEstimates(
        "pointplot",
        data,
        x,
        y,
        series,
        order,
        series_order,
        orient,
        estimator,
        errorbar,
        n_boot,
        seed,
        options,
    )
    styles = _line_styles(linestyles, linestyle, est.series_labels())
    # Each style drawn has a line mark, of the levels it styles.
    drawn = [style for style in dict.fromkeys(styles) if style not in ("none", "")]
    est.joined_lines = bool(drawn)
    chart = make_chart(
        est.table,
        options,
        sentence=est.sentence("Points"),
        palette=palette,
        x_label=x,
        y_label=y,
    )
    spread = dodge and series is not None
    label = None if series else est.value
    xy = (est.value, est.category) if est.horizontal else (est.category, est.value)
    # The points come first: their series, in order, give the legend group its
    # colors and slots, which the lines' marks (one per style) then share.
    chart.point(*xy, series=series, dodge=spread, radius=4, label=label, legend_group=SERIES_GROUP)
    est.error_bars(chart, dodge=spread)
    if drawn:
        resolve = options.get("resolve_y") if est.horizontal else options.get("resolve_x")
        joined = est.joined(resolve)
        for style in drawn:
            levels = [i for i, given in enumerate(styles) if given == style]
            chart.line(
                *xy,
                data=est.of_series(joined, levels),
                series=series,
                dodge=spread,
                dash=_DASHES[style],
                label=label,
                legend_group=SERIES_GROUP,
            )
    return record(chart, est.statistics("pointplot"))


def _line_styles(
    linestyles: LineStyle | Sequence[LineStyle] | None,
    linestyle: LineStyle | None,
    levels: Sequence[str],
) -> list[str]:
    """Each series level's line style (one level without series), checked."""
    if linestyles is not None and linestyle is not None:
        raise ValueError(
            "pointplot linestyle: give one style for every line as linestyle, or one per "
            "series level as linestyles, not both"
        )
    given = linestyles if linestyles is not None else (linestyle if linestyle is not None else "-")
    option = "pointplot linestyles" if linestyles is not None else "pointplot linestyle"
    styles: list[str] = [given] * len(levels) if isinstance(given, str) else list(given)
    for style in styles:
        check_choice(style, option, ("-", "--", ":", "-.", "none", ""))
    if len(styles) != len(levels):
        raise ValueError(
            f"pointplot linestyles: expected {len(levels)} "
            f"{'style' if len(levels) == 1 else 'styles'}, one per series level; "
            f"received {len(styles)}"
        )
    return styles


def lineplot(
    data: Any,
    *,
    x: str,
    y: str,
    series: str | None = None,
    series_order: Sequence[Any] | None = None,
    estimator: Estimator | None = "mean",
    errorbar: ErrorBar = ("ci", 95),
    n_boot: int = 1000,
    seed: int | None = None,
    error_style: Literal["band", "bars"] = "band",
    sort: bool = True,
    palette: Sequence[str] | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """Lines through an estimate of ``y`` at each distinct ``x`` (a number or
    time column), with an interval as a band (``error_style="band"``) or
    error bars, per ``series``. ``estimator=None`` draws the rows themselves
    (with ``errorbar=None``), in ``x`` order unless ``sort=False``.
    Intervals are computed as in ``barplot``.
    """
    check_choice(error_style, "lineplot error_style", ("band", "bars"))
    check_choice(estimator, "lineplot estimator", ("mean", "median", None))
    facet_row, facet_column = facets(options, "lineplot")
    source = Source(data)
    xc = source.column(x, "lineplot x", ("number", "time"))
    yc = source.column(y, "lineplot y", ("number",))
    variables = variables_of(
        source, "lineplot", facet_row, facet_column, series, series_order, axes=[x, y]
    )
    rows = complete(len(xc), xc, yc, levels_of=list(variables.values()))
    dropped = len(xc) - len(rows)
    xv, yv = values(xc), values(yc)
    names = [*variables]
    if estimator is None:
        if errorbar is not None:
            raise ValueError(
                "lineplot errorbar: intervals require an estimator; "
                "pass errorbar=None or choose an estimator"
            )
        rows = rows[np.argsort(xv[rows], kind="stable")] if sort else rows
        table = rows_table(variables, rows)
        table[x] = number_column(xv[rows], xc.kind)
        table[y] = number_column(yv[rows])
        sentence = f"Lines join the rows' {y} in {x} order{by(series)}." + dropped_sentence(
            dropped, [x, y, *names], series_order is not None
        )
        chart = make_chart(table, options, sentence=sentence, palette=palette, x_label=x, y_label=y)
        chart.line(x, y, series=series, label=None if series else y, legend_group=SERIES_GROUP)
        stats = Statistics("lineplot", sentence, {"rows": readable(table)}, None, dropped)
        return record(chart, stats)
    interval = error_method(errorbar, "lineplot")
    n_boot = check_n_boot(n_boot, "lineplot")
    used_seed = seed_of(seed, "lineplot") if interval and interval[0] == "ci" else None
    # One group per facet panel, series, and distinct x, in that order.
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
        f"Lines show the {estimator} of {y} at each {x}{by(series)}"
        + (
            f"; {'bands' if error_style == 'band' else 'error bars'} show "
            + describe_interval(interval[0], interval[1], n_boot, used_seed)
            if interval
            else ""
        )
        + "."
        + dropped_sentence(dropped, [x, y, *names], series_order is not None)
    )
    chart = make_chart(table, options, sentence=sentence, palette=palette, x_label=x, y_label=y)
    label = None if series else y
    if interval and error_style == "band":
        # Bands between two fields take no series: one per series level, named
        # like its line so that the legend group shares color and visibility.
        series_levels = variables[series].labels if series else (y,)
        for i, name in enumerate(series_levels):
            position = names.index(series) if series else 0
            part = table if series is None else subset(table, _at_level(keys, position, i))
            chart.area(
                x,
                y1=low,
                y2=high,
                data=part,
                label=name,
                fill_opacity=0.2,
                legend_group=SERIES_GROUP,
            )
    if interval and error_style == "bars":
        chart.error_bar(x=x, y1=low, y2=high, series=series, label=label, legend_group=SERIES_GROUP)
    chart.line(x, estimated, series=series, label=label, legend_group=SERIES_GROUP)
    stats = Statistics("lineplot", sentence, {"estimates": readable(table)}, used_seed, dropped)
    return record(chart, stats)


# Shared --------------------------------------------------------------------------


class _CategoryEstimates:
    """barplot's and pointplot's table: per facet panel, series, and
    category, the estimate of the values, its interval, and the count."""

    def __init__(
        self,
        function: str,
        data: Any,
        x: str,
        y: str,
        series: str | None,
        order: Sequence[Any] | None,
        series_order: Sequence[Any] | None,
        orient: Orient | None,
        estimator: Estimator,
        errorbar: ErrorBar,
        n_boot: int,
        seed: int | None,
        options: Mapping[str, Any],
    ) -> None:
        check_choice(estimator, f"{function} estimator", ("mean", "median"))
        check_choice(orient, f"{function} orient", ("v", "h", "x", "y", None))
        facet_row, facet_column = facets(options, function)
        source = Source(data)
        xc = source.column(x, f"{function} x")
        yc = source.column(y, f"{function} y")
        horizontal = orient in ("h", "y") or (
            orient is None and yc.kind == "category" and xc.kind != "category"
        )
        category, value = (y, x) if horizontal else (x, y)
        vc = yc if not horizontal else xc
        if vc.kind != "number":
            axis = "x" if horizontal else "y"
            raise TypeError(
                f"{function} {axis}: column {value!r} holds {vc.kind} values; expected number"
            )
        if series is not None and series == category:
            raise ValueError(
                f"{function} series: column {series!r} is the category axis; "
                "split by another column"
            )
        self.horizontal = horizontal
        self.category, self.value = category, value
        self.series = series
        self.facet_row, self.facet_column = facet_row, facet_column
        self.estimator = estimator
        variables = variables_of(
            source, function, facet_row, facet_column, series, series_order, axes=[category, value]
        )
        cats = levels(source.column(category, f"{function} {'y' if horizontal else 'x'}"), order)
        rows = complete(len(vc), vc, levels_of=[*variables.values(), cats])
        self.dropped = len(vc) - len(rows)
        self.interval = error_method(errorbar, function)
        self.n_boot = check_n_boot(n_boot, function)
        self.seed = seed_of(seed, function) if self.interval and self.interval[0] == "ci" else None
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
        self.variables = variables
        self.categories = cats
        # Whether lines join the estimates (pointplot's), which descriptions say.
        self.joined_lines = False
        self._estimates = (keys, codes, centers)
        self._roles = [x, y, *names]
        self._ordered = order is not None or series_order is not None

    def series_labels(self) -> Sequence[str]:
        """The series' levels in order, or one name without series."""
        return self.variables[self.series].labels if self.series else (self.value,)

    def joined(self, resolve: str | None) -> dict[str, Column]:
        """The estimates with a row for every category of each group (facet
        panel and series) that its panel's category axis holds, missing where
        the group has no estimate, so a line through them breaks there, as
        Seaborn's do. A shared axis holds every category; with ``resolve``
        "independent", "rows", or "columns", one holds the categories with an
        estimate in the panels sharing it, so padding adds none to it."""
        keys, codes, centers = self._estimates
        groups = list(dict.fromkeys(tuple(key) for key in keys))
        names = list(self.variables)
        sharing = sharing_fields(resolve, self.facet_row, self.facet_column)
        at = [names.index(name) for name in sharing]

        def axis_of(key: tuple[int, ...]) -> tuple[int, ...]:
            return tuple(key[i] for i in at)

        held: dict[tuple[int, ...], set[int]] = {}
        for key, code in zip(keys, codes, strict=True):
            held.setdefault(axis_of(tuple(key)), set()).add(code)
        found = {
            (tuple(key), code): center
            for key, code, center in zip(keys, codes, centers, strict=True)
        }
        every = range(len(self.categories))
        padded = [
            (group, code)
            for group in groups
            for code in (sorted(held[axis_of(group)]) if at else every)
        ]
        table = keyed_table(self.variables, [group for group, _ in padded])
        table[self.category] = category_column([code for _, code in padded], self.categories.labels)
        table[self.value] = number_column([found.get(row, math.nan) for row in padded])
        return table

    def of_series(self, table: dict[str, Column], levels: Sequence[int]) -> dict[str, Column]:
        """The rows of `table` of the given series levels (every row without series)."""
        if self.series is None:
            return table
        return subset(table, np.isin(table[self.series].values, levels))

    def error_bars(self, chart: Chart, *, dodge: bool, stroke: str | None = None) -> None:
        """Adds the intervals, if any, on the categories."""
        if not self.interval:
            return
        style: dict[str, Any] = {
            "series": self.series,
            "dodge": dodge,
            "stroke": stroke,
            "label": None if self.series else self.value,
            "legend_group": SERIES_GROUP,
        }
        if self.horizontal:
            chart.error_bar(y=self.category, x1=self.low, x2=self.high, **style)
        else:
            chart.error_bar(x=self.category, y1=self.low, y2=self.high, **style)

    def sentence(self, shapes: str) -> str:
        interval = self.interval
        text = f"{shapes} show the {self.estimator} of {self.value} for each {self.category}"
        text += by(self.series)
        if self.joined_lines:
            text += ", joined by lines"
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
