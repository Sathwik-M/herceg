"""Distributions per category: stripplot, boxplot, and violinplot."""

from __future__ import annotations

import math
import sys
from collections.abc import Sequence
from typing import Any, Literal

import numpy as np

from .._chart import Chart, HelperOptions, Jitter
from .._data import Column
from ._common import (
    HUE_GROUP,
    Source,
    Statistics,
    by,
    category_column,
    check_axes_differ,
    check_choice,
    complete,
    dropped_sentence,
    fresh,
    group,
    levels,
    make_chart,
    number_column,
    readable,
    record,
    rows_table,
    seed_of,
    values,
    variables_of,
)

if sys.version_info >= (3, 11):
    from typing import Unpack
else:
    from typing_extensions import Unpack

Orient = Literal["v", "h", "x", "y"]


def stripplot(
    data: Any,
    *,
    x: str,
    y: str,
    hue: str | None = None,
    order: Sequence[Any] | None = None,
    hue_order: Sequence[Any] | None = None,
    orient: Orient | None = None,
    jitter: bool | float = True,
    dodge: bool = False,
    seed: int | None = None,
    size: float | None = None,
    col: str | None = None,
    row: str | None = None,
    palette: Sequence[str] | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """A point per value in each category, spread across the category by
    ``jitter``: as Seaborn's, half the spread in categories' spacing
    (``True`` is 0.1), and with ``dodge`` within each ``hue`` level's share.
    Points keep their places as the chart redraws: each is moved by a hash
    of its row and ``seed`` (drawn and recorded when not given), not by a
    random draw. ``size`` is the points' radius in pixels.
    """
    layout = _Categories(data, x, y, hue, order, hue_order, orient, col, row, "stripplot")
    spread = 0.1 if jitter is True else float(jitter or 0)
    if not (spread >= 0 and math.isfinite(spread)):
        raise ValueError(f"jitter must be True, False, or a number of at least 0, not {jitter!r}")
    # Seaborn's half-width is in categories' spacing; bands are 0.8 of it.
    width = min(1.0, 2 * spread / 0.8)
    used_seed = seed_of(seed) if width > 0 else None
    sentence = f"Points show each {layout.value} for each {layout.category}{by(hue)}"
    if width > 0:
        sentence += (
            f", jittered across {width:.0%} of each "
            + ("level's share of the category" if dodge and hue else "category")
            + f" by a hash of their rows (seed {used_seed})"
        )
    sentence += "." + dropped_sentence(layout.dropped, layout.roles, layout.ordered)
    chart = make_chart(
        layout.table,
        options,
        sentence=sentence,
        col=col,
        row=row,
        palette=palette,
        x_label=x,
        y_label=y,
    )
    chart.point(
        *layout.xy,
        series=hue,
        dodge=dodge and hue is not None,
        jitter=Jitter(width=width, seed=used_seed or 0) if width > 0 else None,
        r=size,
        label=None if hue else layout.value,
        legend_group=HUE_GROUP,
    )
    return record(
        chart,
        Statistics(
            "stripplot", sentence, {"values": readable(layout.table)}, used_seed, layout.dropped
        ),
    )


def boxplot(
    data: Any,
    *,
    x: str,
    y: str,
    hue: str | None = None,
    order: Sequence[Any] | None = None,
    hue_order: Sequence[Any] | None = None,
    orient: Orient | None = None,
    whis: float = 1.5,
    notch: bool = False,
    showfliers: bool = True,
    col: str | None = None,
    row: str | None = None,
    palette: Sequence[str] | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """Box plots of a number column per category (and ``hue`` level, side by
    side): boxes from the lower to the upper quartile (NumPy's linear
    quantiles) with the median, whiskers to the most extreme values within
    ``whis`` interquartile ranges of the box (``math.inf`` for the whole
    range), and the values beyond them as points unless
    ``showfliers=False``. ``notch`` draws 1.57 IQR / sqrt(n) notches."""
    layout = _Categories(data, x, y, hue, order, hue_order, orient, col, row, "boxplot")
    if isinstance(whis, bool) or not (whis >= 0):
        raise ValueError(f"whis must be a number of at least 0, not {whis!r}")
    whiskers: Any = "range" if math.isinf(whis) else float(whis)
    boxes, names = _box_statistics(layout, whis, precomputed=not showfliers)
    within = "the whole range" if math.isinf(whis) else f"{whis:g} IQR of the box"
    sentence = (
        f"Boxes show the quartiles and median of {layout.value} for each "
        f"{layout.category}{by(hue)}; "
        f"whiskers reach the most extreme values within {within}"
        + (", and points beyond them" if showfliers and not math.isinf(whis) else "")
        + (", with notches of 1.57 IQR / sqrt(n)" if notch else "")
        + "."
        + dropped_sentence(layout.dropped, layout.roles, layout.ordered)
    )
    label = None if hue else layout.value
    if showfliers:
        chart = make_chart(
            layout.table,
            options,
            sentence=sentence,
            col=col,
            row=row,
            palette=palette,
            x_label=x,
            y_label=y,
        )
        chart.boxplot(
            *layout.xy,
            series=hue,
            whiskers=whiskers,
            notch=notch or None,
            label=label,
            legend_group=HUE_GROUP,
        )
    else:
        chart = make_chart(
            boxes,
            options,
            sentence=sentence,
            col=col,
            row=row,
            palette=palette,
            x_label=x,
            y_label=y,
        )
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
            series=hue,
            label=label,
            legend_group=HUE_GROUP,
        )
    return record(
        chart, Statistics("boxplot", sentence, {"boxes": readable(boxes)}, None, layout.dropped)
    )


def violinplot(
    data: Any,
    *,
    x: str,
    y: str,
    hue: str | None = None,
    order: Sequence[Any] | None = None,
    hue_order: Sequence[Any] | None = None,
    orient: Orient | None = None,
    bandwidth: float | None = None,
    split: bool = False,
    inner: Literal["box", "quart", "quartile", "quartiles"] | None = "box",
    col: str | None = None,
    row: str | None = None,
    palette: Sequence[str] | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """Violins of a number column per category (and ``hue`` level, side by
    side): each the Gaussian kernel density of its values, mirrored, as
    herceg's violin mark draws them (each violin as wide at its densest;
    ``bandwidth`` in data units for all of them, or by default each its own
    by Silverman's rule of thumb, R's). ``inner`` draws a box of the
    quartiles inside, dashed quartile lines and the median ("quart"), or
    nothing (None); ``split=True`` draws a ``hue`` of two levels as the two
    halves of one violin."""
    if not isinstance(split, bool):
        raise TypeError(f"split must be True or False, not {split!r}")
    if inner is not None and not (inner == "box" or str(inner).startswith("quart")):
        raise ValueError(
            "inner must be 'box', 'quart', or None (herceg draws no sticks or points "
            f"inside violins), not {inner!r}"
        )
    layout = _Categories(data, x, y, hue, order, hue_order, orient, col, row, "violinplot")
    if split:
        hues = layout.variables[hue].codes[layout.rows] if hue is not None else None
        if hues is None or len(np.unique(hues)) > 2:
            raise ValueError("violinplot split=True needs a hue of at most two levels")
    drawn: Literal["box", "quartiles", "none"] = (
        "box" if inner == "box" else "none" if inner is None else "quartiles"
    )
    rule = f"bandwidth {bandwidth:g}" if bandwidth is not None else "Silverman's rule of thumb"
    inside = {
        "box": ", with a box of the quartiles inside",
        "quartiles": ", with dashed quartile lines and the median inside",
        "none": "",
    }[drawn]
    sentence = (
        f"Violins show the kernel density ({rule}) of {layout.value} for each "
        f"{layout.category}{by(hue)}"
        + (", each level of the hue on one side" if split else "")
        + inside
        + "."
        + dropped_sentence(layout.dropped, layout.roles, layout.ordered)
    )
    chart = make_chart(
        layout.table,
        options,
        sentence=sentence,
        col=col,
        row=row,
        palette=palette,
        x_label=x,
        y_label=y,
    )
    chart.violin(
        *layout.xy,
        series=hue,
        bandwidth=bandwidth,
        split=split or None,
        inner=None if drawn == "box" else drawn,
        label=None if hue else layout.value,
        legend_group=HUE_GROUP,
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
        hue: str | None,
        order: Sequence[Any] | None,
        hue_order: Sequence[Any] | None,
        orient: Orient | None,
        col: str | None,
        row: str | None,
        function: str,
    ) -> None:
        check_choice(orient, "orient", ("v", "h", "x", "y", None))
        check_axes_differ(x, y, function)
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
        if hue is not None and hue == self.category:
            raise ValueError(f"hue must differ from the category column {self.category!r}")
        variables = variables_of(source, row, col, hue, hue_order, axes=[x, y])
        categories = levels(source.column(self.category, function), order)
        rows = complete(
            len(value_column), value_column, levels_of=[*variables.values(), categories]
        )
        self.dropped = len(value_column) - len(rows)
        self.values = values(value_column)
        self.rows = rows
        self.variables = variables
        self.categories = categories
        self.hue = hue
        table = rows_table(variables, rows)
        table[self.category] = category_column(categories.codes[rows], categories.labels)
        table[self.value] = number_column(self.values[rows])
        self.table = table
        self.xy = (self.value, self.category) if horizontal else (self.category, self.value)
        self.roles = [x, y, *variables]
        self.ordered = order is not None or hue_order is not None


#: What each box's statistics are called, before names the data takes.
_STATISTICS = ("low", "q1", "median", "q3", "high", "n", "outliers")


def _box_statistics(
    layout: _Categories, whis: float, precomputed: bool = False
) -> tuple[dict[str, Column], dict[str, str]]:
    """Each box's statistics, as the box plot mark computes them from raw
    values (data/quantile.ts `boxStats`): linear quartiles, and whiskers at
    the most extreme values within ``whis`` IQR of the box (with other than
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
        if math.isinf(whis):
            first, last = 0, len(sample) - 1
        else:
            reach = 0.0 if whis == 0 else whis * (q3 - q1)
            first = int(np.searchsorted(sample, q1 - reach, side="left"))
            last = int(np.searchsorted(sample, q3 + reach, side="right")) - 1
        if (whis == 1.5 and not precomputed) or math.isinf(whis):
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
