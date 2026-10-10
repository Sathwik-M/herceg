"""Distributions per category: stripplot, boxplot, and violinplot."""

from __future__ import annotations

import math
import numbers
import sys
from collections.abc import Mapping, Sequence
from typing import Any, Literal

import numpy as np

from .._chart import Chart, HelperOptions, Jitter
from .._data import Column
from ._common import (
    SERIES_GROUP,
    Source,
    Statistics,
    by,
    category_column,
    check_axes_differ,
    check_choice,
    complete,
    dropped_sentence,
    facets,
    fresh,
    group,
    levels,
    make_chart,
    number_column,
    readable,
    record,
    rows_table,
    seed_of,
    shown,
    values,
    variables_of,
)

if sys.version_info >= (3, 11):
    from typing import Unpack
else:
    from typing_extensions import Unpack

Orient = Literal["v", "h", "x", "y"]
Whiskers = Literal["tukey", "range"] | float


def stripplot(
    data: Any,
    *,
    x: str,
    y: str,
    series: str | None = None,
    order: Sequence[Any] | None = None,
    series_order: Sequence[Any] | None = None,
    orient: Orient | None = None,
    jitter: bool | float | Jitter = True,
    dodge: bool = False,
    seed: int | None = None,
    radius: float | None = None,
    palette: Sequence[str] | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """A point per value in each category, spread across the category by
    ``jitter``, as ``Chart.point`` spreads them: the fraction (0 to 1) of
    the category's band the points spread across, or with ``dodge`` of
    their series' slot in it. ``True`` is 0.5, a number that width, and
    ``False`` or 0 no spread; an ``hg.Jitter`` is taken as it is, seed and
    all. Points keep their places as the chart redraws: each is moved by a
    hash of its row and the seed (``seed``, drawn and recorded when not
    given), not by a random draw. ``radius`` is the points' radius in pixels.
    """
    spread = _jitter(jitter, seed)
    layout = _Categories(data, x, y, series, order, series_order, orient, options, "stripplot")
    sentence = f"Points show each {layout.value} for each {layout.category}{by(series)}"
    if spread is not None:
        sentence += (
            f", jittered across {spread.width:.0%} of each "
            + ("series' slot in the category" if dodge and series else "category")
            + f" by a hash of their rows (seed {spread.seed})"
        )
    sentence += "." + dropped_sentence(layout.dropped, layout.roles, layout.ordered)
    chart = make_chart(
        layout.table, options, sentence=sentence, palette=palette, x_label=x, y_label=y
    )
    chart.point(
        *layout.xy,
        series=series,
        dodge=dodge and series is not None,
        jitter=spread,
        radius=radius,
        label=None if series else layout.value,
        legend_group=SERIES_GROUP,
    )
    used_seed = spread.seed if spread is not None else None
    return record(
        chart,
        Statistics(
            "stripplot", sentence, {"values": readable(layout.table)}, used_seed, layout.dropped
        ),
    )


def _jitter(jitter: bool | float | Jitter, seed: int | None) -> Jitter | None:
    """``stripplot``'s ``jitter`` as the point mark's, None for no spread: a
    width takes ``seed`` (or one drawn now), a ``Jitter`` its own."""
    if isinstance(jitter, Jitter):
        if seed is not None:
            raise ValueError(
                "stripplot seed: the Jitter given as jitter has its own seed; "
                "give the seed in one place"
            )
        width: Any = jitter.width
    else:
        width = 0.5 if jitter is True else 0 if jitter is False else jitter
    if isinstance(width, bool) or not (
        isinstance(width, numbers.Real) and math.isfinite(width) and 0 <= float(width) <= 1
    ):
        raise ValueError(
            "stripplot jitter: expected True, False, a width from 0 to 1, or an hg.Jitter; "
            f"received {shown(jitter)}"
        )
    if width == 0:
        return None
    if isinstance(jitter, Jitter):
        return jitter
    return Jitter(width=float(width), seed=seed_of(seed, "stripplot"))


def boxplot(
    data: Any,
    *,
    x: str,
    y: str,
    series: str | None = None,
    order: Sequence[Any] | None = None,
    series_order: Sequence[Any] | None = None,
    orient: Orient | None = None,
    whiskers: Whiskers = "tukey",
    notch: bool = False,
    outliers: bool = True,
    palette: Sequence[str] | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """Box plots of a number column per category (and ``series``, side by
    side): boxes from the lower to the upper quartile (NumPy's linear
    quantiles) with the median, and whiskers to the most extreme values
    within 1.5 interquartile ranges of the box (``whiskers="tukey"``), within
    another multiple of it (``whiskers=2``), or over the whole range
    (``"range"``), as the box plot mark draws them. Values beyond the
    whiskers are points unless ``outliers=False``. ``notch`` draws
    1.57 IQR / sqrt(n) notches."""
    reach = _whisker_reach(whiskers)
    if not isinstance(outliers, bool):
        raise TypeError(f"boxplot outliers: expected True or False; received {shown(outliers)}")
    layout = _Categories(data, x, y, series, order, series_order, orient, options, "boxplot")
    boxes, names = _box_statistics(layout, reach, precomputed=not outliers)
    within = "the whole range" if math.isinf(reach) else f"{reach:g} IQR of the box"
    sentence = (
        f"Boxes show the quartiles and median of {layout.value} for each "
        f"{layout.category}{by(series)}; "
        f"whiskers reach the most extreme values within {within}"
        + (", and points beyond them" if outliers and not math.isinf(reach) else "")
        + (", with notches of 1.57 IQR / sqrt(n)" if notch else "")
        + "."
        + dropped_sentence(layout.dropped, layout.roles, layout.ordered)
    )
    label = None if series else layout.value
    if outliers:
        chart = make_chart(
            layout.table, options, sentence=sentence, palette=palette, x_label=x, y_label=y
        )
        chart.boxplot(
            *layout.xy,
            series=series,
            whiskers=None if whiskers == "tukey" else whiskers,
            notch=notch or None,
            label=label,
            legend_group=SERIES_GROUP,
        )
    else:
        chart = make_chart(boxes, options, sentence=sentence, palette=palette, x_label=x, y_label=y)
        chart.boxplot(
            None if layout.horizontal else layout.category,
            layout.category if layout.horizontal else None,
            low=names["low"],
            q1=names["q1"],
            median=names["median"],
            q3=names["q3"],
            high=names["high"],
            count=names["n"],
            notch=notch or None,
            series=series,
            label=label,
            legend_group=SERIES_GROUP,
        )
    return record(
        chart, Statistics("boxplot", sentence, {"boxes": readable(boxes)}, None, layout.dropped)
    )


def _whisker_reach(whiskers: Whiskers) -> float:
    """The IQR multiple whiskers reach: 1.5 for "tukey", infinity for "range"."""
    if whiskers == "tukey":
        return 1.5
    if whiskers == "range":
        return math.inf
    if (
        isinstance(whiskers, bool)
        or not isinstance(whiskers, numbers.Real)
        or not (math.isfinite(whiskers) and whiskers >= 0)
    ):
        raise ValueError(
            'boxplot whiskers: expected "tukey", "range", or a finite nonnegative IQR multiple; '
            f"received {shown(whiskers)}"
        )
    return float(whiskers)


def violinplot(
    data: Any,
    *,
    x: str,
    y: str,
    series: str | None = None,
    order: Sequence[Any] | None = None,
    series_order: Sequence[Any] | None = None,
    orient: Orient | None = None,
    bandwidth: float | None = None,
    split: bool = False,
    inner: Literal["box", "quartiles", "none"] = "box",
    palette: Sequence[str] | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """Violins of a number column per category (and ``series``, side by
    side): each the Gaussian kernel density of its values, mirrored, as
    herceg's violin mark draws them (each violin as wide at its densest;
    ``bandwidth`` in data units for all of them, or by default each its own
    by Silverman's rule of thumb, R's). ``inner`` draws a box of the
    quartiles inside (``"box"``), dashed quartile lines and the median
    (``"quartiles"``), or nothing (``"none"``); ``split=True`` draws a
    ``series`` of two levels as the two halves of one violin."""
    if not isinstance(split, bool):
        raise TypeError(f"violinplot split: expected True or False; received {shown(split)}")
    check_choice(inner, "violinplot inner", ("box", "quartiles", "none"))
    layout = _Categories(data, x, y, series, order, series_order, orient, options, "violinplot")
    if split:
        if series is None:
            raise ValueError(
                "violinplot split: needs a series of at most two levels to draw as the halves; "
                "give series"
            )
        count = len(np.unique(layout.variables[series].codes[layout.rows]))
        if count > 2:
            raise ValueError(
                f"violinplot split: needs a series of at most two levels; {series!r} has "
                f"{count}, so pass split=False or a series_order of two"
            )
    rule = f"bandwidth {bandwidth:g}" if bandwidth is not None else "Silverman's rule of thumb"
    inside = {
        "box": ", with a box of the quartiles inside",
        "quartiles": ", with dashed quartile lines and the median inside",
        "none": "",
    }[inner]
    sentence = (
        f"Violins show the kernel density ({rule}) of {layout.value} for each "
        f"{layout.category}{by(series)}"
        + (f", each level of {series} on one side" if split else "")
        + inside
        + "."
        + dropped_sentence(layout.dropped, layout.roles, layout.ordered)
    )
    chart = make_chart(
        layout.table, options, sentence=sentence, palette=palette, x_label=x, y_label=y
    )
    chart.violin(
        *layout.xy,
        series=series,
        bandwidth=bandwidth,
        split=split or None,
        inner=None if inner == "box" else inner,
        label=None if series else layout.value,
        legend_group=SERIES_GROUP,
    )
    boxes, _ = _box_statistics(layout, 1.5)
    return record(
        chart,
        Statistics("violinplot", sentence, {"quartiles": readable(boxes)}, None, layout.dropped),
    )


# Shared --------------------------------------------------------------------------


class _Categories:
    """A category column and a number column, as strip, box, and violin plots
    read them: which is which, the levels in order, and a table of the
    complete rows with categories in that order."""

    def __init__(
        self,
        data: Any,
        x: str,
        y: str,
        series: str | None,
        order: Sequence[Any] | None,
        series_order: Sequence[Any] | None,
        orient: Orient | None,
        options: Mapping[str, Any],
        function: str,
    ) -> None:
        check_choice(orient, f"{function} orient", ("v", "h", "x", "y", None))
        check_axes_differ(x, y, function)
        facet_row, facet_column = facets(options, function)
        source = Source(data)
        xc, yc = source.column(x, f"{function} x"), source.column(y, f"{function} y")
        horizontal = orient in ("h", "y") or (
            orient is None and yc.kind == "category" and xc.kind != "category"
        )
        self.horizontal = horizontal
        self.category, self.value = (y, x) if horizontal else (x, y)
        value_column = xc if horizontal else yc
        if value_column.kind != "number":
            axis = "x" if horizontal else "y"
            raise TypeError(
                f"{function} {axis}: column {self.value!r} holds {value_column.kind} values; "
                "expected number"
            )
        if series is not None and series == self.category:
            raise ValueError(
                f"{function} series: column {series!r} is the category axis; "
                "split by another column"
            )
        variables = variables_of(
            source, function, facet_row, facet_column, series, series_order, axes=[x, y]
        )
        categories = levels(source.column(self.category, function), order)
        rows = complete(
            len(value_column), value_column, levels_of=[*variables.values(), categories]
        )
        self.dropped = len(value_column) - len(rows)
        self.values = values(value_column)
        self.rows = rows
        self.variables = variables
        self.categories = categories
        table = rows_table(variables, rows)
        table[self.category] = category_column(categories.codes[rows], categories.labels)
        table[self.value] = number_column(self.values[rows])
        self.table = table
        self.xy = (self.value, self.category) if horizontal else (self.category, self.value)
        self.roles = [x, y, *variables]
        self.ordered = order is not None or series_order is not None


#: What each box's statistics are called, before names the data takes.
_STATISTICS = ("low", "q1", "median", "q3", "high", "n", "outliers")


def _box_statistics(
    layout: _Categories, multiple: float, precomputed: bool = False
) -> tuple[dict[str, Column], dict[str, str]]:
    """Each box's statistics, as the box plot mark computes them from raw
    values (data/quantile.ts `boxStats`): linear quartiles, and whiskers at
    the most extreme values within ``multiple`` IQR of the box (with other than
    the default 1.5, or for boxes drawn from these statistics, never inside
    the quartiles). Also the statistics' column names, kept apart from the
    data's."""
    variables = [*layout.variables.values(), layout.categories]
    taken = {*layout.variables, layout.category, layout.value}
    names = dict(zip(_STATISTICS, fresh(_STATISTICS, taken), strict=True))
    keys: list[tuple[int, ...]] = []
    stats: dict[str, list[float]] = {name: [] for name in _STATISTICS}
    for key, members in group(variables, layout.rows):
        sample = np.sort(layout.values[members])
        q1, median, q3 = (float(q) for q in np.percentile(sample, [25, 50, 75]))
        if math.isinf(multiple):
            first, last = 0, len(sample) - 1
        else:
            reach = 0.0 if multiple == 0 else multiple * (q3 - q1)
            first = int(np.searchsorted(sample, q1 - reach, side="left"))
            last = int(np.searchsorted(sample, q3 + reach, side="right")) - 1
        if (multiple == 1.5 and not precomputed) or math.isinf(multiple):
            low, high = float(sample[first]), float(sample[last])
        else:
            low = min(q1, float(sample[first])) if first < len(sample) else q1
            high = max(q3, float(sample[last])) if last >= 0 else q3
        keys.append(key)
        for name, value in (
            ("low", low),
            ("q1", q1),
            ("median", median),
            ("q3", q3),
            ("high", high),
        ):
            stats[name].append(value)
        stats["n"].append(float(len(sample)))
        stats["outliers"].append(float(first + len(sample) - 1 - last))
    columns = [*layout.variables, layout.category]
    table: dict[str, Column] = {
        name: category_column([k[i] for k in keys], variable.labels)
        for i, (name, variable) in enumerate(zip(columns, variables, strict=True))
    }
    for name, column in stats.items():
        table[names[name]] = number_column(column)
    return table, names
