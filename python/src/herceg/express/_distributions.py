"""Distributions: histplot, kdeplot, ecdfplot, rugplot, stripplot, boxplot, and violinplot."""

from __future__ import annotations

import math
import sys
from collections.abc import Mapping, Sequence
from typing import Any, Literal, NoReturn, TypedDict

import numpy as np

from .._chart import Axis, Chart, HelperOptions
from .._data import Column
from . import _numerics as numerics
from ._common import (
    HUE_GROUP,
    Levels,
    Source,
    Statistics,
    by,
    check_choice,
    complete,
    dropped_sentence,
    fresh,
    group,
    keyed_table,
    make_chart,
    number_column,
    readable,
    record,
    rows_table,
    values,
    variables_of,
)

if sys.version_info >= (3, 11):
    from typing import Unpack
else:
    from typing_extensions import Unpack

Stat = Literal["count", "density", "probability", "proportion", "percent"]
Multiple = Literal["layer", "stack", "dodge"]
Orient = Literal["v", "h", "x", "y"]
BandwidthMethod = Literal["scott", "silverman"] | float

#: How the core histogram mark measures each of Seaborn's statistics.
_NORMALIZE = {
    "count": "count",
    "density": "density",
    "probability": "probability",
    "proportion": "probability",
    "percent": "percent",
}
_STAT_LABELS = {
    "count": "Count",
    "density": "Density",
    "probability": "Probability",
    "proportion": "Proportion",
    "percent": "Percent",
}


class KdeOptions(TypedDict, total=False):
    """The kernel density options ``histplot(kde=True)`` takes as ``kde_kws``."""

    bw_method: BandwidthMethod
    bw_adjust: float
    cut: float
    gridsize: int
    clip: tuple[float | None, float | None]


def histplot(
    data: Any,
    *,
    x: str | None = None,
    y: str | None = None,
    hue: str | None = None,
    hue_order: Sequence[Any] | None = None,
    stat: Stat = "count",
    bins: int | str | Sequence[float] = "auto",
    binwidth: float | None = None,
    binrange: tuple[float, float] | None = None,
    discrete: bool = False,
    cumulative: bool = False,
    common_norm: bool = True,
    multiple: Multiple = "layer",
    kde: bool = False,
    kde_kws: KdeOptions | None = None,
    col: str | None = None,
    row: str | None = None,
    palette: Sequence[str] | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """A histogram of ``x`` (or, horizontal, of ``y``), per ``hue`` level.

    Bins are Seaborn's, chosen from all the rows: ``numpy.histogram_bin_edges``
    with ``bins`` (a count, a NumPy rule such as ``"auto"``, or edges),
    steps of ``binwidth``, a bin per integer with ``discrete=True``, within
    ``binrange``. ``stat`` measures each bin: ``"count"``, ``"density"``,
    ``"probability"`` (or ``"proportion"``), or ``"percent"``, of each hue
    level's values, or with ``common_norm`` of all of them. ``cumulative``
    accumulates the bins; ``multiple`` layers the levels' bars, stacks them,
    or dodges them side by side. ``kde=True`` adds each level's kernel
    density (see ``kdeplot``; ``kde_kws`` takes its options, with ``cut``
    0), scaled to its bars, for layered vertical bars.
    """
    axis, name = _one_axis(x, y, "histplot")
    check_choice(stat, "stat", tuple(_NORMALIZE))
    check_choice(multiple, "multiple", ("layer", "stack", "dodge"))
    if kde and multiple != "layer":
        raise ValueError("histplot draws kernel densities over layered bars only: multiple='layer'")
    if kde and axis == "y":
        _refuse_along_y("histplot", "kernel densities over horizontal bars", "density")
    source = Source(data)
    column = source.column(name, f"histplot {axis}", ("number", "time"))
    variables = variables_of(source, row, col, hue, hue_order, axes=[name])
    rows = complete(len(column), column, levels_of=list(variables.values()))
    dropped = len(column) - len(rows)
    v = values(column)
    if isinstance(bins, (list, tuple, np.ndarray)):
        edges = np.asarray(bins, dtype=float)
    elif len(rows):
        edges = numerics.bin_edges(v[rows], None, bins, binwidth, binrange, discrete)  # type: ignore[arg-type]
    else:
        edges = np.array([0.0, 1.0])
    widths = np.diff(edges)
    # Widths compared relative to one another, whatever the data's units.
    unequal = not np.allclose(widths, widths[0], rtol=1e-6, atol=0)
    if kde and stat != "density" and not cumulative and unequal:
        # One curve cannot follow counts over bins of different widths.
        raise ValueError(
            "histplot draws kernel densities over bins of one width, or with stat='density'"
        )
    table = rows_table(variables, rows)
    table[name] = number_column(v[rows], column.kind)
    measured = _STAT_LABELS[stat] + (" (cumulative)" if cumulative else "")
    is_x = axis == "x"
    settings: dict[str, Any] = dict(options)
    grouped = hue is not None
    sentence = (
        f"Bars measure the {stat} of {name} in {len(edges) - 1} bins from "
        f"{_number(edges[0])} to {_number(edges[-1])}{by(hue)}"
        + (", cumulative" if cumulative else "")
        + (
            f", {'stacked' if multiple == 'stack' else 'side by side'}"
            if grouped and multiple != "layer"
            else ""
        )
        + (", normalized over all levels" if grouped and common_norm and stat != "count" else "")
        + "."
    )
    heights = _heights(v, variables, rows, edges, stat, cumulative, common_norm and grouped, hue)
    tables: dict[str, Mapping[str, np.ndarray]] = {
        "edges": {"edges": edges},
        "bins": readable(heights),
    }
    kde_table: dict[str, Column] | None = None
    if kde:
        kws: KdeOptions = kde_kws or {}
        unknown = set(kws) - {"bw_method", "bw_adjust", "cut", "gridsize", "clip"}
        if unknown:
            raise ValueError(
                "kde_kws takes bw_method, bw_adjust, cut, gridsize, and clip, "
                f"not {sorted(unknown)}"
            )
        kde_table, note, kde_name = densities(
            v,
            variables,
            rows,
            name,
            hue,
            bw_method=kws.get("bw_method", "scott"),
            bw_adjust=kws.get("bw_adjust", 1.0),
            cut=kws.get("cut", 0.0),
            gridsize=kws.get("gridsize", 200),
            clip=kws.get("clip", (None, None)),
            common_norm=common_norm and grouped and stat != "count",
            cumulative=cumulative,
            scale=lambda members: _hist_norm(v[members], edges, stat, cumulative),
            value_kind=column.kind,
            common_grid=True,
        )
        sentence += " Lines show " + note + ", scaled to the bars."
        tables["kde"] = readable(kde_table)
    sentence += dropped_sentence(dropped, [name, *variables], hue_order is not None)
    x_label, y_label = (name, measured) if is_x else (measured, name)
    chart = make_chart(
        table,
        settings,
        sentence=sentence,
        col=col,
        row=row,
        palette=palette,
        x_label=x_label,
        y_label=y_label,
    )
    chart.histogram(
        name if is_x else None,
        y=None if is_x else name,
        bins=[float(edge) for edge in edges],
        series=hue,
        normalize=_NORMALIZE[stat],  # type: ignore[arg-type]
        common_norm=common_norm and grouped,
        cumulative=cumulative,
        stack=multiple == "stack",
        dodge=multiple == "dodge" and grouped,
        # Densities over one series' bars show through them, as in Seaborn.
        fill_opacity=0.5 if kde and not grouped else None,
        label=None if hue else name,
        legend_group=HUE_GROUP,
    )
    if kde_table is not None:
        chart.line(
            name,
            kde_name,
            data=kde_table,
            series=hue,
            label=None if hue else name,
            legend_group=HUE_GROUP,
        )
    return record(chart, Statistics("histplot", sentence, tables, None, dropped))


def kdeplot(
    data: Any,
    *,
    x: str | None = None,
    y: str | None = None,
    hue: str | None = None,
    hue_order: Sequence[Any] | None = None,
    bw_method: BandwidthMethod = "scott",
    bw_adjust: float = 1.0,
    cut: float = 3.0,
    gridsize: int = 200,
    clip: tuple[float | None, float | None] | None = None,
    fill: bool = False,
    common_norm: bool = True,
    cumulative: bool = False,
    colors: str | Sequence[str] | None = None,
    col: str | None = None,
    row: str | None = None,
    palette: Sequence[str] | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """Gaussian kernel density estimates of ``x`` per ``hue`` level; with
    both ``x`` and ``y``, a bivariate density drawn as a heatmap over a
    ``gridsize`` by ``gridsize`` grid. (Densities of ``y`` alone, along y,
    are refused: tooltips would read their lines' y, not their density.)

    Densities are SciPy's ``gaussian_kde``'s: the kernel's covariance is the
    sample's times the square of ``bw_method``'s factor (Scott's rule
    n^(-1/5) by default, ``"silverman"``, or a number) times ``bw_adjust``.
    They are evaluated at ``gridsize`` points from ``cut`` kernel deviations
    below the lowest value to as far above the highest, within ``clip``;
    with ``common_norm``, each level's density is weighted by its share of
    the rows, so all of them together integrate to 1. ``cumulative``
    integrates them; ``fill`` fills under them. A level with fewer than two
    distinct values has no density.
    """
    if x is not None and y is not None:
        return _bivariate(
            data,
            x,
            y,
            hue,
            bw_method,
            bw_adjust,
            cut,
            gridsize,
            clip,
            cumulative,
            colors,
            col,
            row,
            options,
        )
    axis, name = _one_axis(x, y, "kdeplot")
    if axis == "y":
        _refuse_along_y("kdeplot", "densities along y", "density")
    source = Source(data)
    column = source.column(name, f"kdeplot {axis}", ("number", "time"))
    variables = variables_of(source, row, col, hue, hue_order, axes=[name])
    rows = complete(len(column), column, levels_of=list(variables.values()))
    dropped = len(column) - len(rows)
    v = values(column)
    grouped = hue is not None
    table, note, density = densities(
        v,
        variables,
        rows,
        name,
        hue,
        bw_method=bw_method,
        bw_adjust=bw_adjust,
        cut=cut,
        gridsize=gridsize,
        clip=clip or (None, None),
        common_norm=common_norm and grouped,
        cumulative=cumulative,
        scale=None,
        value_kind=column.kind,
    )
    measured = "Cumulative probability" if cumulative else "Density"
    sentence = (
        "Lines show "
        + note
        + by(hue)
        + "."
        + dropped_sentence(dropped, [name, *variables], hue_order is not None)
    )
    chart = make_chart(
        table,
        options,
        sentence=sentence,
        col=col,
        row=row,
        palette=palette,
        x_label=name,
        y_label=measured,
    )
    label = None if hue else name
    if fill:
        chart.area(
            name, density, series=hue, fill_opacity=0.25, label=label, legend_group=HUE_GROUP
        )
    else:
        chart.line(name, density, series=hue, label=label, legend_group=HUE_GROUP)
    return record(
        chart, Statistics("kdeplot", sentence, {"density": readable(table)}, None, dropped)
    )


def ecdfplot(
    data: Any,
    *,
    x: str | None = None,
    y: str | None = None,
    hue: str | None = None,
    hue_order: Sequence[Any] | None = None,
    stat: Literal["proportion", "percent", "count"] = "proportion",
    complementary: bool = False,
    col: str | None = None,
    row: str | None = None,
    palette: Sequence[str] | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """The empirical distribution of ``x`` per ``hue`` level: steps up to
    the share (``stat``: ``"proportion"``, ``"percent"``, or ``"count"``) of
    values at or below each value, or above it with ``complementary=True``.
    (Steps of ``y``, along y, are refused, as for ``kdeplot``.)"""
    axis, name = _one_axis(x, y, "ecdfplot")
    if axis == "y":
        _refuse_along_y("ecdfplot", "steps along y", stat)
    check_choice(stat, "stat", ("proportion", "percent", "count"))
    source = Source(data)
    column = source.column(name, f"ecdfplot {axis}", ("number", "time"))
    variables = variables_of(source, row, col, hue, hue_order, axes=[name])
    rows = complete(len(column), column, levels_of=list(variables.values()))
    dropped = len(column) - len(rows)
    v = values(column)
    (share,) = fresh([stat.capitalize()], {name, *variables})
    keys: list[np.ndarray] = []
    positions: list[np.ndarray] = []
    heights: list[np.ndarray] = []
    for key, members in group(list(variables.values()), rows):
        # A point per distinct value, which tooltips and the keyboard read:
        # no riser from 0 (or the whole) before the first, which would read
        # as an observation.
        distinct, steps = numerics.ecdf(v[members], None, stat, complementary)
        positions.append(distinct)
        heights.append(steps)
        keys.append(np.tile(np.asarray(key, dtype=np.int64), (len(distinct), 1)))

    def steps_of(chosen: Sequence[bool]) -> dict[str, Column]:
        """The chosen groups' steps, as one table."""
        out = keyed_table(
            variables, _stack([k for k, c in zip(keys, chosen, strict=True) if c], len(variables))
        )
        kept = [p for p, c in zip(positions, chosen, strict=True) if c]
        out[name] = number_column(np.concatenate(kept) if kept else [], column.kind)
        shares = [h for h, c in zip(heights, chosen, strict=True) if c]
        out[share] = number_column(np.concatenate(shares) if shares else [])
        return out

    table = steps_of([True] * len(keys))
    # A group of one distinct value has no step to draw: it shows as a point.
    single = [len(p) == 1 for p in positions]
    side = "above" if complementary else "at or below"
    sentence = (
        f"Steps show the {stat} of {name} values {side} each value{by(hue)}."
        + (" A group of one distinct value shows as a point." if any(single) else "")
        + dropped_sentence(dropped, [name, *variables], hue_order is not None)
    )
    chart = make_chart(
        table,
        options,
        sentence=sentence,
        col=col,
        row=row,
        palette=palette,
        x_label=name,
        y_label=share,
    )
    if not any(single):
        label = None if hue else name
        chart.line(name, share, series=hue, curve="step-after", label=label, legend_group=HUE_GROUP)
    else:
        # Steps and points level by level, so that levels keep their order
        # (and colors) in the legend group whichever draw as points.
        position = list(variables).index(hue) if hue else None
        for level, label in enumerate(variables[hue].labels if hue else (name,)):
            ours = [position is None or int(k[0, position]) == level for k in keys]
            stepped = [mine and not one for mine, one in zip(ours, single, strict=True)]
            points = [mine and one for mine, one in zip(ours, single, strict=True)]
            if any(stepped):
                chart.line(
                    name,
                    share,
                    data=steps_of(stepped),
                    curve="step-after",
                    label=label,
                    legend_group=HUE_GROUP,
                )
            if any(points):
                chart.point(name, share, data=steps_of(points), label=label, legend_group=HUE_GROUP)
    return record(chart, Statistics("ecdfplot", sentence, {"ecdf": readable(table)}, None, dropped))


def rugplot(
    data: Any,
    *,
    x: str | None = None,
    y: str | None = None,
    hue: str | None = None,
    hue_order: Sequence[Any] | None = None,
    length: float = 8,
    col: str | None = None,
    row: str | None = None,
    palette: Sequence[str] | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """A tick per value of ``x`` along the bottom of the plot (or of ``y``
    along its left), ``length`` pixels long, per ``hue`` level."""
    axis, name = _one_axis(x, y, "rugplot")
    source = Source(data)
    column = source.column(name, f"rugplot {axis}", ("number", "time"))
    variables = variables_of(source, row, col, hue, hue_order, axes=[name])
    rows = complete(len(column), column, levels_of=list(variables.values()))
    dropped = len(column) - len(rows)
    table = rows_table(variables, rows)
    table[name] = number_column(values(column)[rows], column.kind)
    sentence = f"Ticks mark each value of {name}{by(hue)}." + dropped_sentence(
        dropped, [name, *variables], hue_order is not None
    )
    is_x = axis == "x"
    # A rug alone has nothing on its other axis.
    settings: dict[str, Any] = dict(options)
    settings.setdefault("y_axis" if is_x else "x_axis", Axis(show=False, grid=False))
    chart = make_chart(
        table,
        settings,
        sentence=sentence,
        col=col,
        row=row,
        palette=palette,
        x_label=name if is_x else None,
        y_label=None if is_x else name,
    )
    chart.rug(
        name if is_x else None,
        y=None if is_x else name,
        series=hue,
        length=length,
        label=None if hue else name,
        legend_group=HUE_GROUP,
    )
    return record(
        chart, Statistics("rugplot", sentence, {"values": readable(table)}, None, dropped)
    )


# Shared --------------------------------------------------------------------------


def _one_axis(x: str | None, y: str | None, function: str) -> tuple[str, str]:
    if (x is None) == (y is None):
        raise ValueError(f"{function} needs exactly one of x and y")
    return ("x", x) if x is not None else ("y", y)  # type: ignore[return-value]


def _number(value: float) -> str:
    return f"{value:.6g}"


def _refuse_along_y(function: str, what: str, measure: str) -> NoReturn:
    """Lines along y would be read by x, reporting their y and not their
    `measure`, in tooltips and keyboard reading: refused until lines can be
    read along y."""
    raise ValueError(
        f"{function} cannot draw {what} yet: tooltips and the keyboard would read the "
        f"lines' y, not their {measure}; pass x instead of y"
    )


def _heights(
    v: np.ndarray,
    variables: Mapping[str, Levels],
    rows: np.ndarray,
    edges: np.ndarray,
    stat: str,
    cumulative: bool,
    common_norm: bool,
    hue: str | None,
) -> dict[str, Column]:
    """Each group's bars, as Seaborn measures them (and the chart draws them):
    per facet panel and hue level, each bin's edges and height."""
    keys: list[np.ndarray] = []
    lefts: list[np.ndarray] = []
    heights: list[np.ndarray] = []
    panels = [name for name in variables if name != hue]
    grouping = group(list(variables.values()), rows)
    # A level's share of its panel's rows, for common normalization.
    totals: dict[tuple[int, ...], int] = {}
    for key, members in grouping:
        panel = key[: len(panels)]
        totals[panel] = totals.get(panel, 0) + len(members)
    for key, members in grouping:
        height = numerics.histogram(v[members], None, edges, stat, cumulative)  # type: ignore[arg-type]
        if common_norm and stat != "count":
            height = height * len(members) / totals[key[: len(panels)]]
        heights.append(height)
        lefts.append(edges[:-1])
        keys.append(np.tile(np.asarray(key, dtype=np.int64), (len(edges) - 1, 1)))
    table = keyed_table(variables, _stack(keys, len(variables)))
    left, right, measure = fresh(["left", "right", "height"], set(variables))
    table[left] = number_column(np.concatenate(lefts) if lefts else [])
    table[right] = number_column(np.concatenate([edges[1:] for _ in lefts]) if lefts else [])
    table[measure] = number_column(np.concatenate(heights) if heights else [])
    return table


def _hist_norm(sample: np.ndarray, edges: np.ndarray, stat: str, cumulative: bool) -> float:
    """What Seaborn scales a level's density by to match its bars: the bars'
    area, or for cumulative bars the last bar."""
    heights = numerics.histogram(sample, None, edges, stat, cumulative)  # type: ignore[arg-type]
    if cumulative:
        return float(heights.max()) if len(heights) else 0.0
    return float((heights * np.diff(edges)).sum())


def densities(
    v: np.ndarray,
    variables: Mapping[str, Levels],
    rows: np.ndarray,
    name: str,
    hue: str | None,
    *,
    bw_method: BandwidthMethod,
    bw_adjust: float,
    cut: float,
    gridsize: int,
    clip: tuple[float | None, float | None],
    common_norm: bool,
    cumulative: bool,
    scale: Any,
    value_kind: str,
    common_grid: bool = False,
) -> tuple[dict[str, Column], str, str]:
    """Each group's density on its own grid (or with ``common_grid`` on its
    panel's, as Seaborn's histograms put theirs), as one table, and how it
    was computed."""
    if not (bw_adjust > 0 and math.isfinite(bw_adjust)):
        raise ValueError(f"bw_adjust must be a positive number, not {bw_adjust!r}")
    if not (cut >= 0 and math.isfinite(cut)):
        raise ValueError(f"cut must be a number of at least 0, not {cut!r}")
    if not (isinstance(gridsize, int) and gridsize >= 2):
        raise ValueError(f"gridsize must be a whole number of at least 2, not {gridsize!r}")
    if isinstance(bw_method, str):
        check_choice(bw_method, "bw_method", ("scott", "silverman"))
    elif not (bw_method > 0 and math.isfinite(bw_method)):
        raise ValueError(
            f"bw_method must be 'scott', 'silverman', or a positive number, not {bw_method!r}"
        )
    panels = [n for n in variables if n != hue]
    grouping = group(list(variables.values()), rows)
    totals: dict[tuple[int, ...], int] = {}
    members_of: dict[tuple[int, ...], list[np.ndarray]] = {}
    for key, members in grouping:
        totals[key[: len(panels)]] = totals.get(key[: len(panels)], 0) + len(members)
        members_of.setdefault(key[: len(panels)], []).append(members)

    def grid_of(sample: np.ndarray) -> np.ndarray:
        deviation = math.sqrt(
            float(numerics.kernel_covariance(sample, None, bw_method, bw_adjust)[0, 0])
        )
        return numerics.support(sample, deviation, cut, clip, gridsize)

    shared = {
        panel: grid_of(v[np.concatenate(parts)])
        for panel, parts in members_of.items()
        if common_grid and sum(map(len, parts)) >= 2 and np.ptp(v[np.concatenate(parts)]) > 0
    }
    keys: list[np.ndarray] = []
    grids: list[np.ndarray] = []
    densities: list[np.ndarray] = []
    singular = 0
    for key, members in grouping:
        sample = v[members]
        if len(sample) < 2 or not np.ptp(sample) > 0:
            singular += 1
            continue
        deviation = math.sqrt(
            float(numerics.kernel_covariance(sample, None, bw_method, bw_adjust)[0, 0])
        )
        grid = shared[key[: len(panels)]] if common_grid else grid_of(sample)
        if cumulative:
            density = numerics.cumulative_density(sample, None, deviation, grid)
        else:
            density = numerics.density(sample, None, deviation, grid)
        if common_norm:
            density = density * len(sample) / totals[key[: len(panels)]]
        if scale is not None:
            density = density * scale(members)
        keys.append(np.tile(np.asarray(key, dtype=np.int64), (gridsize, 1)))
        grids.append(grid)
        densities.append(density)
    table = keyed_table(variables, _stack(keys, len(variables)))
    table[name] = number_column(np.concatenate(grids) if grids else [], value_kind)
    (column,) = fresh(["density"], {name, *variables})
    table[column] = number_column(np.concatenate(densities) if densities else [])
    rule = (
        "Scott's rule"
        if bw_method == "scott"
        else "Silverman's rule"
        if bw_method == "silverman"
        else f"factor {bw_method:g}"
    )
    note = (
        f"{'cumulative ' if cumulative else ''}Gaussian kernel density estimates "
        f"(SciPy's gaussian_kde, {rule}"
        + (f" × {bw_adjust:g}" if bw_adjust != 1 else "")
        + f", {gridsize} points, cut {cut:g})"
    )
    if common_norm:
        note += ", weighted by each level's share of the rows"
    if singular:
        levels_had = "levels" if singular > 1 else "level"
        note += f"; {singular} {levels_had} with fewer than two distinct values had none"
    return table, note, column


def _bivariate(
    data: Any,
    x: str,
    y: str,
    hue: str | None,
    bw_method: BandwidthMethod,
    bw_adjust: float,
    cut: float,
    gridsize: int,
    clip: tuple[float | None, float | None] | None,
    cumulative: bool,
    colors: str | Sequence[str] | None,
    col: str | None,
    row: str | None,
    options: HelperOptions,
) -> Chart:
    """kdeplot of two columns: a density heatmap per facet panel, on one grid."""
    if hue is not None:
        raise ValueError(
            "a bivariate kdeplot draws one density per panel: facet by col or row instead of hue"
        )
    if cumulative:
        raise ValueError("a bivariate kdeplot cannot be cumulative")
    if not (bw_adjust > 0):
        raise ValueError(f"bw_adjust must be a positive number, not {bw_adjust!r}")
    if not (isinstance(gridsize, int) and gridsize >= 2):
        raise ValueError(f"gridsize must be a whole number of at least 2, not {gridsize!r}")
    source = Source(data)
    xc = source.column(x, "kdeplot x", ("number",))
    yc = source.column(y, "kdeplot y", ("number",))
    variables = variables_of(source, row, col, None, axes=[x, y])
    rows = complete(len(xc), xc, yc, levels_of=list(variables.values()))
    dropped = len(xc) - len(rows)
    xv, yv = values(xc), values(yc)
    if len(rows) < 3:
        raise ValueError("a bivariate kdeplot needs at least three complete rows")
    whole = np.vstack([xv[rows], yv[rows]])
    spread = numerics.kernel_covariance(whole, None, bw_method, bw_adjust)
    limits = clip or (None, None)
    xs = numerics.support(whole[0], math.sqrt(spread[0, 0]), cut, limits, gridsize)
    ys = numerics.support(whole[1], math.sqrt(spread[1, 1]), cut, limits, gridsize)
    keys: list[np.ndarray] = []
    cells_x: list[np.ndarray] = []
    cells_y: list[np.ndarray] = []
    cells: list[np.ndarray] = []
    for key, members in group(list(variables.values()), rows):
        pair = np.vstack([xv[members], yv[members]])
        covariance = numerics.kernel_covariance(pair, None, bw_method, bw_adjust)
        if len(members) < 3 or np.linalg.det(covariance) <= 0:
            continue
        grid = numerics.density_2d(pair[0], pair[1], None, covariance, xs, ys)
        # Kernels' tails below a billionth of the peak are rounding, not density.
        grid[grid < grid.max() * 1e-9] = 0
        gx, gy = np.meshgrid(xs, ys)
        keys.append(np.tile(np.asarray(key, dtype=np.int64), (grid.size, 1)))
        cells_x.append(gx.ravel())
        cells_y.append(gy.ravel())
        cells.append(grid.ravel())
    table = keyed_table(variables, _stack(keys, len(variables)))
    table[x] = number_column(np.concatenate(cells_x) if cells_x else [])
    table[y] = number_column(np.concatenate(cells_y) if cells_y else [])
    (density,) = fresh(["density"], {x, y, *variables})
    table[density] = number_column(np.concatenate(cells) if cells else [])
    rule = (
        "Scott's rule"
        if bw_method == "scott"
        else "Silverman's rule"
        if bw_method == "silverman"
        else f"factor {bw_method:g}"
    )
    sentence = (
        f"Cells show the bivariate Gaussian kernel density of {x} and {y} (SciPy's gaussian_kde, "
        f"{rule}{f' × {bw_adjust:g}' if bw_adjust != 1 else ''}) "
        f"on a {gridsize} by {gridsize} grid." + dropped_sentence(dropped, [x, y, *variables])
    )
    chart = make_chart(table, options, sentence=sentence, col=col, row=row, x_label=x, y_label=y)
    chart.heatmap(x, y, density, colors=colors, label="density")
    return record(
        chart, Statistics("kdeplot", sentence, {"density": readable(table)}, None, dropped)
    )


def _stack(keys: list[np.ndarray], width: int) -> np.ndarray:
    """Per-row keys of groups, one block of rows each, as one array."""
    return np.concatenate(keys) if keys else np.zeros((0, width), dtype=np.int64)
