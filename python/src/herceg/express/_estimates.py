"""Estimates with intervals: barplot, pointplot, and lineplot."""

from __future__ import annotations

import math
import sys
from collections.abc import Callable, Mapping, Sequence
from typing import Any, Literal, cast

import numpy as np

from .._chart import Chart, Dash
from .._data import Column
from . import _numerics as numerics
from ._common import (
    ErrorBar,
    ErrorMethod,
    ExpressOptions,
    Levels,
    Source,
    Statistics,
    by,
    category_column,
    check_axes_differ,
    check_choice,
    check_estimator,
    check_n_boot,
    checked_ends,
    checking,
    complete,
    describe_interval,
    dropped_sentence,
    error_method,
    express,
    facets,
    fresh,
    function_name,
    group,
    keyed_table,
    levels,
    make_chart,
    neutral,
    number_column,
    readable,
    record,
    reused,
    rows_table,
    seed_of,
    sharing_fields,
    shown,
    subset,
    unit_ranks,
    values,
    variables_of,
    weight_column,
    weights_of,
)
from ._numerics import ErrorFunction, Estimator

if sys.version_info >= (3, 11):
    from typing import Unpack
else:
    from typing_extensions import Unpack

Orient = Literal["v", "h", "x", "y"]
#: Matplotlib's line styles: solid, dashed, dotted, dash-dot, or no line.
LineStyle = Literal["-", "--", ":", "-.", "none", ""]


@express
def barplot(
    data: Any,
    *,
    x: str,
    y: str,
    series: str | None = None,
    color: str | None = None,
    order: Sequence[Any] | None = None,
    series_order: Sequence[Any] | None = None,
    orient: Orient | None = None,
    estimator: Estimator = "mean",
    errorbar: ErrorBar = ("ci", 95),
    n_boot: int = 1000,
    seed: int | None = 0,
    weight: str | None = None,
    units: str | None = None,
    palette: Sequence[str] | None = None,
    **options: Unpack[ExpressOptions],
) -> Chart:
    """Bars of an estimate of a number column per category, with error bars
    over each.

    One of ``x`` and ``y`` names categories, the other the values; a
    category ``y`` (or ``orient="h"``) lays the bars along y. ``series``
    splits each category's bars by another column, side by side. The
    ``estimator`` is ``"mean"``, ``"median"``, ``"sum"``, ``"min"``,
    ``"max"``, or a function of a group's values returning one number
    (``numpy.median``, a lambda). ``errorbar`` is ``("ci", level)``, a
    bootstrap confidence interval of ``n_boot`` resamples with ``seed`` (0;
    None draws one and records it), ``("pi", width)``, the central
    percentile interval of the values, ``("se", k)`` (of means) or
    ``("sd", k)``, k standard errors or deviations about the estimate, a
    function of a group's values returning its interval's ends, or
    ``None``. ``weight`` names a column weighting each row of a weighted
    mean (with bootstrap intervals). ``units`` names the sampling units
    (repeated measures): bootstrap intervals resample units, then rows
    within each, as Seaborn's do. Groups of one value have no interval.
    Rows missing a value or a category are left out. ``order`` and
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
        _Aggregation("barplot", estimator, errorbar, n_boot, seed, weight, units),
        options,
    )
    chart = make_chart(
        est.table, options, sentence=est.sentence("Bars"), palette=palette, x_label=x, y_label=y
    )
    label = None if series else est.value
    xy = (est.value, est.category) if est.horizontal else (est.category, est.value)
    chart.bar(*xy, series=series, label=label)
    est.error_bars(chart, dodge=series is not None, stroke=neutral(options.get("theme")))
    return record(chart, est.statistics("barplot"))


@express
def pointplot(
    data: Any,
    *,
    x: str,
    y: str,
    series: str | None = None,
    color: str | None = None,
    order: Sequence[Any] | None = None,
    series_order: Sequence[Any] | None = None,
    orient: Orient | None = None,
    estimator: Estimator = "mean",
    errorbar: ErrorBar = ("ci", 95),
    n_boot: int = 1000,
    seed: int | None = 0,
    weight: str | None = None,
    units: str | None = None,
    dodge: bool = False,
    linestyles: LineStyle | Sequence[LineStyle] | None = None,
    linestyle: LineStyle | None = None,
    join: bool | None = None,
    palette: Sequence[str] | None = None,
    **options: Unpack[ExpressOptions],
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
        _Aggregation("pointplot", estimator, errorbar, n_boot, seed, weight, units),
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
    chart.point(*xy, series=series, dodge=spread, radius=4, label=label)
    est.error_bars(chart, dodge=spread)
    if drawn:
        axis = options.get("y_axis" if est.horizontal else "x_axis")
        scope = axis.get("scope") if isinstance(axis, Mapping) else getattr(axis, "scope", None)
        joined = est.joined(scope)
        for style in drawn:
            levels = [i for i, given in enumerate(styles) if given == style]
            chart.line(
                *xy,
                data=est.of_series(joined, levels),
                series=series,
                dodge=spread,
                dash=cast(Dash, style),
                label=label,
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


@express
def lineplot(
    data: Any,
    *,
    x: str,
    y: str,
    series: str | None = None,
    color: str | None = None,
    series_order: Sequence[Any] | None = None,
    estimator: Estimator | None = "mean",
    errorbar: ErrorBar = ("ci", 95),
    n_boot: int = 1000,
    seed: int | None = 0,
    weight: str | None = None,
    units: str | None = None,
    error_style: Literal["band", "bars"] = "band",
    sort: bool = True,
    palette: Sequence[str] | None = None,
    **options: Unpack[ExpressOptions],
) -> Chart:
    """Lines through an estimate of ``y`` at each distinct ``x`` (a number or
    time column), with an interval as a band (``error_style="band"``) or
    error bars, per ``series``. Estimates, intervals, and ``weight`` are as
    in ``barplot``. ``estimator=None`` draws the rows themselves (with
    ``errorbar=None``), in ``x`` order unless ``sort=False``; with
    ``units``, as Seaborn's, one line per sampling unit in each series'
    color (a spaghetti plot of repeated measures).
    """
    check_choice(error_style, "lineplot error_style", ("band", "bars"))
    estimator = check_estimator(estimator, "lineplot estimator", none=True)
    facet_row, facet_column = facets(options, "lineplot")
    source = Source(data)
    xc = source.column(x, "lineplot x", ("number", "time"))
    yc = source.column(y, "lineplot y", ("number",))
    variables = variables_of(
        source, "lineplot", facet_row, facet_column, series, series_order, axes=[x, y]
    )
    weight_values = weight_column(source, weight, "lineplot", [x, y, *variables])
    ranked = unit_ranks(source, units, "lineplot", [x, y, weight, *variables])
    rows = complete(
        len(xc),
        xc,
        yc,
        weight_values,
        None if ranked is None else ranked[1],
        levels_of=list(variables.values()),
    )
    weights = weights_of(weight_values, rows, weight, "lineplot")
    dropped = len(xc) - len(rows)
    xv, yv = values(xc), values(yc)
    names = [*variables]
    roles = [x, y, weight, units, *names]
    if estimator is None:
        if errorbar is not None:
            raise ValueError(
                "lineplot errorbar: intervals require an estimator; "
                "pass errorbar=None or choose an estimator"
            )
        if weight is not None:
            raise ValueError(
                "lineplot weight: weights weigh an estimate; choose an estimator or drop weight"
            )
        return _lines_of_rows(
            variables,
            rows,
            (x, xv, xc.kind),
            (y, yv),
            series,
            units,
            None if ranked is None else ranked[0],
            sort,
            dropped_sentence(dropped, roles, series_order is not None),
            dropped,
            options,
            palette,
        )
    if units is not None:
        raise ValueError(
            "lineplot units: a line per unit draws each unit's rows; pass estimator=None and "
            "errorbar=None, or drop units"
        )
    aggregation = _Aggregation("lineplot", estimator, errorbar, n_boot, seed, weight, None)
    # One group per facet panel, series, and distinct x, in that order.
    x_levels = levels(xc)
    grouping = group([*variables.values(), x_levels], rows)
    # The estimates' column: y's name, unless x has it too.
    (estimated,) = fresh([y], {x, *names})
    low, high, count = fresh(["low", "high", "n"], {x, estimated, *names})
    out: dict[str, list[float]] = {x: [], estimated: [], low: [], high: [], count: []}
    keys: list[tuple[int, ...]] = []
    for key, members in grouping:

        def where(key: tuple[int, ...] = key) -> str:
            return f"{x} {x_levels.labels[key[-1]]!r}"

        center, lo, hi = aggregation(yv[members], weights, None, members, where)
        keys.append(key[:-1])
        out[x].append(float(xv[members[0]]))
        out[estimated].append(center)
        out[low].append(lo)
        out[high].append(hi)
        out[count].append(len(members))
    table = keyed_table(variables, keys)
    table[x] = number_column(out[x], xc.kind)
    table[estimated] = number_column(out[estimated])
    interval = aggregation.interval
    if interval:
        table[low] = number_column(out[low])
        table[high] = number_column(out[high])
    table[count] = number_column(out[count])
    sentence = (
        f"Lines show {aggregation.of(y)} at each {x}{by(series)}"
        + (
            f"; {'bands' if error_style == 'band' else 'error bars'} show "
            + aggregation.describe_interval()
            if interval
            else ""
        )
        + "."
        + dropped_sentence(dropped, roles, series_order is not None)
    )
    chart = make_chart(table, options, sentence=sentence, palette=palette, x_label=x, y_label=y)
    label = None if series else y
    if interval and error_style == "band":
        # A band per series, of the line's table: each stands for what its
        # line does, sharing its color, legend entry, and visibility.
        chart.area(x, y1=low, y2=high, series=series, label=label, fill_opacity=0.2)
    if interval and error_style == "bars":
        chart.error_bar(x=x, y1=low, y2=high, series=series, label=label)
    chart.line(x, estimated, series=series, label=label)
    stats = Statistics(
        "lineplot", sentence, {"estimates": readable(table)}, aggregation.seed, dropped
    )
    return record(chart, stats)


def _lines_of_rows(
    variables: Mapping[str, Levels],
    rows: np.ndarray,
    x_values: tuple[str, np.ndarray, str],
    y_values: tuple[str, np.ndarray],
    series: str | None,
    units: str | None,
    ranks: np.ndarray | None,
    sort: bool,
    left_out: str,
    dropped: int,
    options: Mapping[str, Any],
    palette: Sequence[str] | None,
) -> Chart:
    """lineplot without an estimator: the complete `rows` joined in x order
    (or as given), with `units` one line per unit of each series."""
    (x, xv, x_kind), (y, yv) = x_values, y_values
    if sort:
        rows = rows[np.argsort(xv[rows], kind="stable")]
    lines = ""
    if ranks is not None:
        # Each unit's rows, unit after unit, in each panel and series.
        keys = [variable.codes[rows] for variable in variables.values()]
        rows = rows[np.lexsort((ranks[rows], *reversed(keys)))]
        lines = f", one line per {units}"
    table = rows_table(variables, rows)
    table[x] = number_column(xv[rows], x_kind)
    table[y] = number_column(yv[rows])
    drawn = table
    if ranks is not None and len(rows):
        # A copy of the row before each change of unit, its y missing, breaks
        # the line there.
        ends = np.flatnonzero(np.diff(ranks[rows]) != 0) + 1
        positions = np.insert(np.arange(len(rows)), ends, ends - 1)
        drawn = {
            name: Column(column.kind, column.values[positions], column.dictionary)
            for name, column in table.items()
        }
        broken = drawn[y].values.copy()
        broken[ends + np.arange(len(ends))] = np.nan
        drawn[y] = number_column(broken)
    order = f"in {x} order" if sort else "in the data's order"
    sentence = f"Lines join the rows' {y} {order}{by(series)}{lines}." + left_out
    chart = make_chart(drawn, options, sentence=sentence, palette=palette, x_label=x, y_label=y)
    chart.line(x, y, series=series, label=None if series else y)
    stats = Statistics("lineplot", sentence, {"rows": readable(table)}, None, dropped)
    return record(chart, stats)


# Shared --------------------------------------------------------------------------


class _Aggregation:
    """How barplot, pointplot, and lineplot estimate each group of values:
    the estimator, the interval, and the resampling, checked together."""

    def __init__(
        self,
        function: str,
        estimator: Any,
        errorbar: ErrorBar,
        n_boot: int,
        seed: int | None,
        weight: str | None,
        units: str | None,
    ) -> None:
        self.function = function
        self.estimator: Estimator = check_estimator(estimator, f"{function} estimator")  # type: ignore[assignment]
        self.interval = error_method(errorbar, function)
        self.n_boot = check_n_boot(n_boot, function)
        self.weight = weight
        self.units = units
        method = self.interval[0] if isinstance(self.interval, tuple) else None
        name = shown(self.estimator) if isinstance(self.estimator, str) else "a function"
        if weight is not None:
            if self.estimator != "mean":
                raise ValueError(
                    f'{function} weight: weighted estimates are means; pass estimator="mean"'
                )
            if self.interval is not None and method != "ci":
                raise ValueError(
                    f"{function} errorbar: weighted means take bootstrap intervals only; "
                    'pass ("ci", 95) or None'
                )
            if units is not None:
                raise ValueError(
                    f"{function} units: weighted means resample rows with their weights; "
                    "drop units or weight"
                )
        if method == "se" and self.estimator != "mean":
            raise ValueError(
                f'{function} errorbar: "se" is the standard error of the mean; with '
                f'estimator={name} pass ("ci", 95), ("sd", 1), or a function of the values'
            )
        if units is not None and method != "ci":
            raise ValueError(
                f"{function} units: units are what bootstrap intervals resample; pass "
                'errorbar=("ci", 95), or drop units'
            )
        self.seed = seed_of(seed, function) if method == "ci" else None

    def __call__(
        self,
        sample: np.ndarray,
        weights: np.ndarray | None,
        unit_of: np.ndarray | None,
        members: np.ndarray,
        where: Callable[[], str],
    ) -> tuple[float, float, float]:
        """A group's estimate and interval (NaN ends without one), from its
        values `sample`, which are the rows `members` of the data, with the
        data's weights and each row's unit (its rank)."""
        w = None if weights is None else weights[members]
        ranks = None if unit_of is None else unit_of[members]
        estimator = checking(self.estimator, f"{self.function} estimator", sample, where)
        interval = self.interval
        if interval is None:
            center, low, high = numerics.estimate(sample, estimator, w), math.nan, math.nan
        else:
            method: ErrorMethod | ErrorFunction
            if callable(interval):
                given = interval

                def ends(values: np.ndarray) -> tuple[float, float]:
                    return checked_ends(given(values), f"{self.function} errorbar", where())

                method, level = ends, 0.0
            else:
                method, level = interval

            def compute() -> tuple[float, float, float]:
                return numerics.interval(
                    sample,
                    estimator,
                    method,
                    level,
                    self.n_boot,
                    self.seed or 0,
                    weights=w,
                    units=None if ranks is None else numerics.units_of(ranks),
                )

            if method == "ci" and not callable(self.estimator):
                parts = ["interval", sample, w, ranks, self.estimator, level, self.n_boot]
                center, low, high = reused([*parts, self.seed], compute)
            else:
                center, low, high = compute()
        return center, low, high

    def of(self, value: str) -> str:
        """What the estimates are, in words: "the mean of tip"."""
        estimator = self.estimator
        name = estimator if isinstance(estimator, str) else function_name(estimator, "estimate")
        weighted = f" weighted by {self.weight}" if self.weight else ""
        return f"the {name} of {value}{weighted}"

    def describe_interval(self) -> str:
        interval = self.interval
        assert interval is not None
        if callable(interval):
            return describe_interval(interval, 0, self.n_boot, self.seed)
        return describe_interval(interval[0], interval[1], self.n_boot, self.seed, self.units)


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
        aggregation: _Aggregation,
        options: Mapping[str, Any],
    ) -> None:
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
        self.aggregation = aggregation
        variables = variables_of(
            source, function, facet_row, facet_column, series, series_order, axes=[category, value]
        )
        cats = levels(source.column(category, f"{function} {'y' if horizontal else 'x'}"), order)
        taken = [category, value, *variables]
        weight_values = weight_column(source, aggregation.weight, function, taken)
        ranked = unit_ranks(source, aggregation.units, function, [*taken, aggregation.weight])
        rows = complete(
            len(vc),
            vc,
            weight_values,
            None if ranked is None else ranked[1],
            levels_of=[*variables.values(), cats],
        )
        weights = weights_of(weight_values, rows, aggregation.weight, function)
        self.dropped = len(vc) - len(rows)
        names = [*variables]
        self.low, self.high, count = fresh(["low", "high", "n"], {category, value, *names})
        grouping = group([*variables.values(), cats], rows)
        v = values(vc)
        keys, codes, centers, lows, highs, counts = [], [], [], [], [], []
        for key, members in grouping:

            def where(key: tuple[int, ...] = key) -> str:
                return f"{category} {cats.labels[key[-1]]!r}"

            center, lo, hi = aggregation(
                v[members], weights, None if ranked is None else ranked[0], members, where
            )
            keys.append(key[:-1])
            codes.append(key[-1])
            centers.append(center)
            lows.append(lo)
            highs.append(hi)
            counts.append(len(members))
        table = keyed_table(variables, keys)
        table[category] = category_column(codes, cats.labels)
        table[value] = number_column(centers)
        if aggregation.interval:
            table[self.low] = number_column(lows)
            table[self.high] = number_column(highs)
        table[count] = number_column(counts)
        self.table = table
        self.variables = variables
        self.categories = cats
        # Whether lines join the estimates (pointplot's), which descriptions say.
        self.joined_lines = False
        self._estimates = (keys, codes, centers)
        self._roles = [x, y, aggregation.weight, aggregation.units, *names]
        self._ordered = order is not None or series_order is not None

    @property
    def interval(self) -> tuple[ErrorMethod, float] | ErrorFunction | None:
        return self.aggregation.interval

    def series_labels(self) -> Sequence[str]:
        """The series' levels in order, or one name without series."""
        return self.variables[self.series].labels if self.series else (self.value,)

    def joined(self, scope: str | None) -> dict[str, Column]:
        """The estimates with a row for every category of each group (facet
        panel and series) that its panel's category axis holds, missing where
        the group has no estimate, so a line through them breaks there, as
        Seaborn's do. A shared axis holds every category; with the axis'
        ``scope`` "panel", "row", or "column", one holds the categories with an
        estimate in the panels sharing it, so padding adds none to it."""
        keys, codes, centers = self._estimates
        groups = list(dict.fromkeys(tuple(key) for key in keys))
        names = list(self.variables)
        sharing = sharing_fields(scope, self.facet_row, self.facet_column)
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
        }
        if self.horizontal:
            chart.error_bar(y=self.category, x1=self.low, x2=self.high, **style)
        else:
            chart.error_bar(x=self.category, y1=self.low, y2=self.high, **style)

    def sentence(self, shapes: str) -> str:
        text = f"{shapes} show {self.aggregation.of(self.value)} for each {self.category}"
        text += by(self.series)
        if self.joined_lines:
            text += ", joined by lines"
        if self.interval:
            text += "; error bars show " + self.aggregation.describe_interval()
        return text + "." + dropped_sentence(self.dropped, self._roles, self._ordered)

    def statistics(self, function: str) -> Statistics:
        return Statistics(
            function,
            self.sentence("Bars" if function == "barplot" else "Points"),
            {"estimates": readable(self.table)},
            self.aggregation.seed,
            self.dropped,
        )
