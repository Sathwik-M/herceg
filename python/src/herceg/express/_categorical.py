"""Distributions per category: stripplot, swarmplot, boxplot, and violinplot."""

from __future__ import annotations

import math
import numbers
import sys
import warnings
from collections.abc import Mapping, Sequence
from typing import Any, Literal

import numpy as np

from .._chart import Chart, HelperOptions, Jitter
from .._data import Column
from . import _numerics as numerics
from . import _swarm
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
    express,
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
    sharing_fields,
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


@express
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
    seed: int | None = 0,
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
    hash of its row and the seed (``seed``, 0 as the point mark's; None
    draws one and records it), not by a random draw. ``radius`` is the
    points' radius in pixels.
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


@express
def swarmplot(
    data: Any,
    *,
    x: str,
    y: str,
    series: str | None = None,
    order: Sequence[Any] | None = None,
    series_order: Sequence[Any] | None = None,
    orient: Orient | None = None,
    dodge: bool = False,
    radius: float = 2.5,
    warn_thresh: float = 0.05,
    palette: Sequence[str] | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """A point per value in each category, packed across the category
    without overlap in order of value, as ``Chart.point(swarm=True)`` packs
    them (a beeswarm); with ``dodge``, each series in its share of the
    category. Points that do not fit stand at the category's edges. The
    browser lays the swarms out at the size it draws them; Python lays them
    out at the chart's ``width`` and ``height`` (or 640 by 320 pixels) and,
    as Seaborn does, warns when more than ``warn_thresh`` of a category's
    points (0.05) cannot be placed. ``radius`` is the points' radius in
    pixels.
    """
    if not (isinstance(radius, numbers.Real) and math.isfinite(radius) and radius > 0):
        raise ValueError(
            f"swarmplot radius: expected a positive number of pixels; received {shown(radius)}"
        )
    if isinstance(warn_thresh, bool) or not (
        isinstance(warn_thresh, numbers.Real) and 0 <= warn_thresh <= 1
    ):
        raise ValueError(
            f"swarmplot warn_thresh: expected a share from 0 to 1; received {shown(warn_thresh)}"
        )
    layout = _Categories(data, x, y, series, order, series_order, orient, options, "swarmplot")
    spread = dodge and series is not None
    sentence = (
        f"Points show each {layout.value} for each {layout.category}{by(series)}, "
        + ("each series side by side, " if spread else "")
        + "packed without overlap in order of value"
        + "."
        + dropped_sentence(layout.dropped, layout.roles, layout.ordered)
    )
    chart = make_chart(
        layout.table, options, sentence=sentence, palette=palette, x_label=x, y_label=y
    )
    chart.point(
        *layout.xy,
        series=series,
        dodge=spread,
        swarm=True,
        radius=float(radius),
        label=None if series else layout.value,
        legend_group=SERIES_GROUP,
    )
    _warn_unplaced(layout, options, series, spread, float(radius), float(warn_thresh))
    return record(
        chart,
        Statistics("swarmplot", sentence, {"values": readable(layout.table)}, None, layout.dropped),
    )


def _warn_unplaced(
    layout: _Categories,
    options: Mapping[str, Any],
    series: str | None,
    dodge: bool,
    radius: float,
    threshold: float,
) -> None:
    """Warns, as Seaborn does, of each swarm more than ``threshold`` of whose
    points cannot be placed, laid out as the core would at the chart's size,
    on the value axis its options make (``type``, ``domain``, ``nice``,
    ``ticks``, ``zero``), in bands as many as its panel's band axis holds,
    and with panels sharing axes as ``resolve_x`` and ``resolve_y`` say."""
    facet_row, facet_column = options.get("facet_row"), options.get("facet_column")
    panels = [name for name in (facet_row, facet_column) if name is not None]
    sizes = {name: len(np.unique(layout.variables[name].codes[layout.rows])) for name in panels}
    rows = sizes.get(facet_row, 1) if facet_row else 1
    columns = sizes.get(facet_column, 1) if facet_column else 1
    axis = options.get("x_axis" if layout.horizontal else "y_axis")

    def setting(name: str) -> Any:
        return axis.get(name) if isinstance(axis, Mapping) else getattr(axis, name, None)

    log = setting("type") == "log"
    # Log axes draw only positive values.
    drawn = layout.rows[layout.values[layout.rows] > 0] if log else layout.rows
    values = layout.values[drawn]
    if len(values) == 0:
        return
    low, high = float(values.min()), float(values.max())
    label = max((len(f"{v:.3g}") for v in (low, high)), default=1)
    width, height = _swarm.plot_size(
        float(options.get("width") or 640),
        float(options.get("height") or 320),
        legend=series is not None,
        title=bool(options.get("title")),
        rows=rows,
        columns=columns,
        label_width=7 * label,
    )
    along, across = (height, width) if layout.horizontal else (width, height)
    names = [*panels, *([series] if dodge and series else [])]
    variables = [layout.variables[name] for name in names] + [layout.categories]
    keys: list[tuple[int, ...]] = []
    groups: list[np.ndarray] = []
    for key, members in group(variables, drawn):
        keys.append(key)
        groups.append(np.log10(layout.values[members]) if log else layout.values[members])

    def sharing(resolve: str | None) -> list[int]:
        """Where in a swarm's key the panel fields an axis is shared by are."""
        return [panels.index(name) for name in sharing_fields(resolve, facet_row, facet_column)]

    # Panels sharing a value axis share its domain.
    value_shared = sharing(options.get("resolve_x" if layout.horizontal else "resolve_y"))
    extents: dict[tuple[int, ...], tuple[float, float]] = {}
    for key, part in zip(keys, groups, strict=True):
        scope = tuple(key[i] for i in value_shared)
        lo, hi = extents.get(scope, (math.inf, -math.inf))
        extents[scope] = (min(lo, float(part.min())), max(hi, float(part.max())))
    # A band axis holds the categories of the rows of the panels sharing it,
    # drawn or not (log axes leave out values, not their categories).
    band_fields = sharing_fields(
        options.get("resolve_y" if layout.horizontal else "resolve_x"), facet_row, facet_column
    )
    band_shared = [panels.index(name) for name in band_fields]
    held: dict[tuple[int, ...], set[int]] = {}
    roster = [*(layout.variables[name] for name in band_fields), layout.categories]
    for key, _ in group(roster, layout.rows):
        held.setdefault(tuple(key[:-1]), set()).add(key[-1])
    bands = [len(held[tuple(key[i] for i in band_shared)]) for key in keys]
    domains = {
        scope: _swarm.value_domain(
            10**lo if log else lo,
            10**hi if log else hi,
            across=across,
            radius=radius,
            log=log,
            fixed=setting("domain"),
            rounded=setting("nice") is not False,
            ticks=setting("ticks"),
            zero=setting("zero") is True,
        )
        for scope, (lo, hi) in extents.items()
    }
    shares = _swarm.unplaced(
        groups,
        [domains[tuple(key[i] for i in value_shared)] for key in keys],
        bands,
        # Dodged series share each band: those of the chart's rows, drawn or not.
        slots=len(np.unique(layout.variables[series].codes[layout.rows]))
        if dodge and series
        else 1,
        radius=radius,
        along=along,
        across=across,
    )
    size = f"{float(options.get('width') or 640):g} by {float(options.get('height') or 320):g}"
    for key, share in zip(keys, shares, strict=True):
        if share <= threshold:
            continue
        where = ", ".join(f"{name} {variables[i].labels[key[i]]!r}" for i, name in enumerate(names))
        place = f"{layout.category} {layout.categories.labels[key[-1]]!r}" + (
            f" ({where})" if where else ""
        )
        warnings.warn(
            f"swarmplot: {share:.1%} of the points of {place} cannot be placed at "
            f"{size} pixels; you may want to decrease the size of the markers (radius) "
            "or use stripplot",
            UserWarning,
            stacklevel=3,
        )


def _jitter(jitter: bool | float | Jitter, seed: int | None) -> Jitter | None:
    """``stripplot``'s ``jitter`` as the point mark's, None for no spread: a
    width takes ``seed`` (or one drawn now), a ``Jitter`` its own."""
    if isinstance(jitter, Jitter):
        if seed != 0:
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


@express
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
    boxes, _ = _box_statistics(layout, reach)
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
    chart = make_chart(
        layout.table, options, sentence=sentence, palette=palette, x_label=x, y_label=y
    )
    chart.boxplot(
        *layout.xy,
        series=series,
        whiskers=None if whiskers == "tukey" else whiskers,
        notch=notch or None,
        outliers=None if outliers else False,
        label=None if series else layout.value,
        legend_group=SERIES_GROUP,
    )
    return record(
        chart, Statistics("boxplot", sentence, {"boxes": readable(boxes)}, None, layout.dropped)
    )


@express
def boxenplot(
    data: Any,
    *,
    x: str,
    y: str,
    series: str | None = None,
    order: Sequence[Any] | None = None,
    series_order: Sequence[Any] | None = None,
    orient: Orient | None = None,
    depth: numerics.Depth = "tukey",
    outlier_proportion: float = 0.007,
    trust_alpha: float = 0.05,
    width_method: Literal["exponential", "linear", "area"] = "exponential",
    outliers: bool = True,
    palette: Sequence[str] | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """Letter-value ("boxen") plots of a number column per category (and
    ``series``, side by side), as herceg's boxen mark draws them: nested
    boxes between each group's letter values (quartiles, eighths,
    sixteenths, ... out from the median), each level narrower and lighter
    than the one inside it, with the values beyond the outermost boxes as
    points unless ``outliers=False``. ``depth`` is Seaborn's ``k_depth``:
    "tukey" leaves 5 to 8 values in each tail, "proportion" about
    ``outlier_proportion`` of them, "trustworthy" stops where a letter
    value's confidence interval at ``trust_alpha`` would overlap the next,
    "full" reaches every value, or a number of levels. ``width_method``
    narrows levels by half ("exponential"), by equal steps ("linear"), or
    to their share of values over their height ("area")."""
    check_choice(width_method, "boxenplot width_method", ("exponential", "linear", "area"))
    if depth not in ("tukey", "proportion", "trustworthy", "full") and not (
        isinstance(depth, numbers.Integral) and not isinstance(depth, bool) and depth >= 1
    ):
        raise ValueError(
            'boxenplot depth: expected "tukey", "proportion", "trustworthy", "full", or a '
            f"whole number of levels from 1; received {shown(depth)}"
        )
    if isinstance(depth, numbers.Integral):
        depth = int(depth)
    for name, value in (("outlier_proportion", outlier_proportion), ("trust_alpha", trust_alpha)):
        if isinstance(value, bool) or not (isinstance(value, numbers.Real) and 0 < value < 1):
            raise ValueError(
                f"boxenplot {name}: expected a number between 0 and 1; received {shown(value)}"
            )
    if not isinstance(outliers, bool):
        raise TypeError(f"boxenplot outliers: expected True or False; received {shown(outliers)}")
    layout = _Categories(data, x, y, series, order, series_order, orient, options, "boxenplot")
    letters = _letter_statistics(layout, depth, float(outlier_proportion), float(trust_alpha))
    rule = (
        f"{depth} levels"
        if not isinstance(depth, str)
        else {
            "tukey": "Tukey's depth rule",
            "proportion": f"levels leaving about {outlier_proportion:g} of the values beyond them",
            "trustworthy": f"trustworthy levels at alpha {trust_alpha:g}",
            "full": "levels reaching every value",
        }[depth]
    )
    sentence = (
        f"Boxes show the letter values of {layout.value} for each {layout.category}{by(series)}, "
        f"out from the median ({rule}, widths {width_method})"
        + (", and points beyond them" if outliers and depth != "full" else "")
        + "."
        + dropped_sentence(layout.dropped, layout.roles, layout.ordered)
    )
    chart = make_chart(
        layout.table, options, sentence=sentence, palette=palette, x_label=x, y_label=y
    )
    chart.boxen(
        *layout.xy,
        series=series,
        depth=None if depth == "tukey" else depth,
        outlier_proportion=None if outlier_proportion == 0.007 else outlier_proportion,
        trust_alpha=None if trust_alpha == 0.05 else trust_alpha,
        width_method=None if width_method == "exponential" else width_method,
        outliers=None if outliers else False,
        label=None if series else layout.value,
        legend_group=SERIES_GROUP,
    )
    return record(chart, Statistics("boxenplot", sentence, letters, None, layout.dropped))


def _letter_statistics(
    layout: _Categories, depth: numerics.Depth, proportion: float, alpha: float
) -> dict[str, Mapping[str, np.ndarray]]:
    """Each group's letter values, as the boxen mark computes them: a table
    of boxes (``level`` 1 the quartiles' box, up to the group's levels out)
    and one of groups (median, values, levels, and outliers)."""
    variables = [*layout.variables.values(), layout.categories]
    columns = [*layout.variables, layout.category]
    taken = {*columns, layout.value}
    level_name, low, high, median, n, levels_name, beyond = fresh(
        ["level", "low", "high", "median", "n", "levels", "outliers"], taken
    )
    box_keys: list[tuple[int, ...]] = []
    group_keys: list[tuple[int, ...]] = []
    box: dict[str, list[float]] = {level_name: [], low: [], high: []}
    groups: dict[str, list[float]] = {median: [], n: [], levels_name: [], beyond: []}
    for key, members in group(variables, layout.rows):
        sample = np.sort(layout.values[members])
        k = numerics.letter_depth(len(sample), depth, proportion, alpha)
        values = numerics.letter_values(sample, k, depth == "full")
        for i in range(2 * k - 1):
            box_keys.append(key)
            box[level_name].append(float(k - min(i, 2 * k - 2 - i)))
            box[low].append(float(values[i]))
            box[high].append(float(values[i + 1]))
        group_keys.append(key)
        groups[median].append(float(np.percentile(sample, 50)))
        groups[n].append(float(len(sample)))
        groups[levels_name].append(float(k))
        groups[beyond].append(
            float(np.count_nonzero((sample < values.min()) | (sample > values.max())))
        )

    def table_of(keys: list[tuple[int, ...]], stats: dict[str, list[float]]) -> dict[str, Column]:
        out: dict[str, Column] = {
            name: category_column([k[i] for k in keys], variable.labels)
            for i, (name, variable) in enumerate(zip(columns, variables, strict=True))
        }
        for name, column in stats.items():
            out[name] = number_column(column)
        return out

    return {
        "boxes": readable(table_of(box_keys, box)),
        "groups": readable(table_of(group_keys, groups)),
    }


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


@express
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
    layout: _Categories, multiple: float
) -> tuple[dict[str, Column], dict[str, str]]:
    """Each box's statistics, as the box plot mark computes them from raw
    values (data/quantile.ts `boxStats`): linear quartiles, and whiskers at
    the most extreme values within ``multiple`` IQR of the box (with other than
    the default 1.5, never inside the quartiles). Also the statistics' column
    names, kept apart from the data's."""
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
        if multiple == 1.5 or math.isinf(multiple):
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
