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
    SERIES_GROUP,
    Levels,
    Source,
    Statistics,
    by,
    check_choice,
    check_grid_size,
    complete,
    dropped_sentence,
    facets,
    fresh,
    group,
    keyed_table,
    make_chart,
    number_column,
    readable,
    record,
    rows_table,
    shown,
    values,
    variables_of,
)
from ._numerics import Normalize

if sys.version_info >= (3, 11):
    from typing import Unpack
else:
    from typing_extensions import Unpack

Multiple = Literal["layer", "stack", "dodge"]
Orient = Literal["v", "h", "x", "y"]
BandwidthMethod = Literal["scott", "silverman"] | float

#: Axis titles of what histogram bars measure.
_MEASURES = {
    "count": "Count",
    "probability": "Probability",
    "percent": "Percent",
    "density": "Density",
}


class KdeOptions(TypedDict, total=False):
    """The kernel density options ``histplot(kde=True)`` takes as ``kde_options``."""

    bw_method: BandwidthMethod
    bw_adjust: float
    cut: float
    grid_size: int
    clip: tuple[float | None, float | None]


def histplot(
    data: Any,
    *,
    x: str | None = None,
    y: str | None = None,
    series: str | None = None,
    series_order: Sequence[Any] | None = None,
    normalize: Normalize = "count",
    bins: int | str | Sequence[float] = "auto",
    binwidth: float | None = None,
    binrange: tuple[float, float] | None = None,
    discrete: bool = False,
    cumulative: bool = False,
    common_norm: bool = False,
    multiple: Multiple = "layer",
    kde: bool = False,
    kde_options: KdeOptions | None = None,
    palette: Sequence[str] | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """A histogram of ``x`` (or, horizontal, of ``y``), per ``series``.

    Bins are Seaborn's, chosen from all the rows: ``numpy.histogram_bin_edges``
    with ``bins`` (a count, a NumPy rule such as ``"auto"``, or edges),
    steps of ``binwidth``, a bin per integer with ``discrete=True``, within
    ``binrange``. ``normalize`` measures each bin as ``Chart.histogram``
    does: ``"count"``, ``"probability"``, ``"percent"``, or ``"density"`` of
    each series' values, or with ``common_norm=True`` of all of them in the
    panel. ``cumulative`` accumulates the bins; ``multiple`` layers the
    series' bars, stacks them, or dodges them side by side. ``kde=True`` adds
    each series' kernel density (see ``kdeplot``; ``kde_options`` takes its
    options, with ``cut`` 0), scaled to its bars, for layered vertical bars.
    """
    axis, name = _one_axis(x, y, "histplot")
    check_choice(normalize, "histplot normalize", tuple(_MEASURES))
    check_choice(multiple, "histplot multiple", ("layer", "stack", "dodge"))
    if kde and multiple != "layer":
        raise ValueError(
            'histplot kde: kernel densities are drawn over layered bars only; pass multiple="layer"'
        )
    if kde and axis == "y":
        _refuse_along_y("histplot", "kernel densities over horizontal bars", "density")
    facet_row, facet_column = facets(options, "histplot")
    source = Source(data)
    column = source.column(name, f"histplot {axis}", ("number", "time"))
    variables = variables_of(
        source, "histplot", facet_row, facet_column, series, series_order, axes=[name]
    )
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
    if kde and normalize != "density" and not cumulative and unequal:
        # One curve cannot follow counts over bins of different widths.
        raise ValueError(
            "histplot kde: kernel densities cannot follow bars over bins of different "
            'widths; give bins of one width, or normalize="density"'
        )
    table = rows_table(variables, rows)
    table[name] = number_column(v[rows], column.kind)
    measured = _MEASURES[normalize] + (" (cumulative)" if cumulative else "")
    is_x = axis == "x"
    grouped = series is not None
    sentence = (
        f"Bars measure the {normalize} of {name} in {len(edges) - 1} bins from "
        f"{_number(edges[0])} to {_number(edges[-1])}{by(series)}"
        + (", cumulative" if cumulative else "")
        + (
            f", {'stacked' if multiple == 'stack' else 'side by side'}"
            if grouped and multiple != "layer"
            else ""
        )
        + (
            ", normalized over all series"
            if grouped and common_norm and normalize != "count"
            else ""
        )
        + "."
    )
    heights = _heights(
        v, variables, rows, edges, normalize, cumulative, common_norm and grouped, series
    )
    tables: dict[str, Mapping[str, np.ndarray]] = {
        "edges": {"edges": edges},
        "bins": readable(heights),
    }
    kde_table: dict[str, Column] | None = None
    if kde:
        density_options: KdeOptions = kde_options or {}
        unknown = set(density_options) - {"bw_method", "bw_adjust", "cut", "grid_size", "clip"}
        if unknown:
            raise ValueError(
                f"histplot kde_options: unknown {', '.join(sorted(unknown))}; "
                "kde_options takes bw_method, bw_adjust, cut, grid_size, and clip"
            )
        kde_table, note, kde_name = densities(
            v,
            variables,
            rows,
            name,
            series,
            bw_method=density_options.get("bw_method", "scott"),
            bw_adjust=density_options.get("bw_adjust", 1.0),
            cut=density_options.get("cut", 0.0),
            grid_size=density_options.get("grid_size", 200),
            clip=density_options.get("clip", (None, None)),
            common_norm=common_norm and grouped and normalize != "count",
            cumulative=cumulative,
            scale=lambda members: _hist_norm(v[members], edges, normalize, cumulative),
            value_kind=column.kind,
            role="histplot kde_options",
            common_grid=True,
        )
        sentence += " Lines show " + note + ", scaled to the bars."
        tables["kde"] = readable(kde_table)
    sentence += dropped_sentence(dropped, [name, *variables], series_order is not None)
    x_label, y_label = (name, measured) if is_x else (measured, name)
    chart = make_chart(
        table, options, sentence=sentence, palette=palette, x_label=x_label, y_label=y_label
    )
    chart.histogram(
        name if is_x else None,
        y=None if is_x else name,
        bins=[float(edge) for edge in edges],
        series=series,
        normalize=normalize,
        common_norm=common_norm and grouped,
        cumulative=cumulative,
        stack=multiple == "stack",
        dodge=multiple == "dodge" and grouped,
        # Densities over one series' bars show through them, as in Seaborn.
        fill_opacity=0.5 if kde and not grouped else None,
        label=None if series else name,
        legend_group=SERIES_GROUP,
    )
    if kde_table is not None:
        chart.line(
            name,
            kde_name,
            data=kde_table,
            series=series,
            label=None if series else name,
            legend_group=SERIES_GROUP,
        )
    return record(chart, Statistics("histplot", sentence, tables, None, dropped))


def kdeplot(
    data: Any,
    *,
    x: str | None = None,
    y: str | None = None,
    series: str | None = None,
    series_order: Sequence[Any] | None = None,
    bw_method: BandwidthMethod = "scott",
    bw_adjust: float = 1.0,
    cut: float = 3.0,
    grid_size: int = 200,
    clip: tuple[float | None, float | None] | None = None,
    filled: bool = False,
    common_norm: bool = False,
    cumulative: bool = False,
    colors: str | Sequence[str] | None = None,
    palette: Sequence[str] | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """Gaussian kernel density estimates of ``x`` per ``series``; with both
    ``x`` and ``y``, a bivariate density drawn as a heatmap over a
    ``grid_size`` by ``grid_size`` grid. (Densities of ``y`` alone, along y,
    are refused: tooltips would read their lines' y, not their density.)

    Densities are SciPy's ``gaussian_kde``'s: the kernel's covariance is the
    sample's times the square of ``bw_method``'s factor (Scott's rule
    n^(-1/5) by default, ``"silverman"``, or a number) times ``bw_adjust``.
    They are evaluated at ``grid_size`` points from ``cut`` kernel deviations
    below the lowest value to as far above the highest, within ``clip``;
    with ``common_norm=True``, each series' density is weighted by its share
    of the panel's rows, so all of them together integrate to 1.
    ``cumulative`` integrates them; ``filled`` fills under them. A series
    with fewer than two distinct values has no density.
    """
    facet_row, facet_column = facets(options, "kdeplot")
    if x is not None and y is not None:
        return _bivariate(
            data,
            x,
            y,
            series,
            bw_method,
            bw_adjust,
            cut,
            grid_size,
            clip,
            cumulative,
            colors,
            facet_row,
            facet_column,
            options,
        )
    axis, name = _one_axis(x, y, "kdeplot")
    if axis == "y":
        _refuse_along_y("kdeplot", "densities along y", "density")
    source = Source(data)
    column = source.column(name, f"kdeplot {axis}", ("number", "time"))
    variables = variables_of(
        source, "kdeplot", facet_row, facet_column, series, series_order, axes=[name]
    )
    rows = complete(len(column), column, levels_of=list(variables.values()))
    dropped = len(column) - len(rows)
    v = values(column)
    grouped = series is not None
    table, note, density = densities(
        v,
        variables,
        rows,
        name,
        series,
        bw_method=bw_method,
        bw_adjust=bw_adjust,
        cut=cut,
        grid_size=grid_size,
        clip=clip or (None, None),
        common_norm=common_norm and grouped,
        cumulative=cumulative,
        scale=None,
        value_kind=column.kind,
        role="kdeplot",
    )
    measured = "Cumulative probability" if cumulative else "Density"
    sentence = (
        "Lines show "
        + note
        + by(series)
        + "."
        + dropped_sentence(dropped, [name, *variables], series_order is not None)
    )
    chart = make_chart(
        table, options, sentence=sentence, palette=palette, x_label=name, y_label=measured
    )
    label = None if series else name
    if filled:
        chart.area(
            name, density, series=series, fill_opacity=0.25, label=label, legend_group=SERIES_GROUP
        )
    else:
        chart.line(name, density, series=series, label=label, legend_group=SERIES_GROUP)
    return record(
        chart, Statistics("kdeplot", sentence, {"density": readable(table)}, None, dropped)
    )


#: What ECDF steps measure, as descriptions name it.
_SHARES = {"probability": "share", "percent": "percentage", "count": "count"}


def ecdfplot(
    data: Any,
    *,
    x: str | None = None,
    y: str | None = None,
    series: str | None = None,
    series_order: Sequence[Any] | None = None,
    normalize: Literal["probability", "percent", "count"] = "probability",
    complementary: bool = False,
    palette: Sequence[str] | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """The empirical distribution of ``x`` per ``series``: steps up to the
    share of values at or below each value (``normalize``: ``"probability"``
    from 0 to 1, ``"percent"``, or ``"count"``), or above it with
    ``complementary=True``. (Steps of ``y``, along y, are refused, as for
    ``kdeplot``.)"""
    axis, name = _one_axis(x, y, "ecdfplot")
    check_choice(normalize, "ecdfplot normalize", tuple(_SHARES))
    if axis == "y":
        _refuse_along_y("ecdfplot", "steps along y", _SHARES[normalize])
    facet_row, facet_column = facets(options, "ecdfplot")
    source = Source(data)
    column = source.column(name, f"ecdfplot {axis}", ("number", "time"))
    variables = variables_of(
        source, "ecdfplot", facet_row, facet_column, series, series_order, axes=[name]
    )
    rows = complete(len(column), column, levels_of=list(variables.values()))
    dropped = len(column) - len(rows)
    v = values(column)
    (share,) = fresh([normalize.capitalize()], {name, *variables})
    keys: list[np.ndarray] = []
    positions: list[np.ndarray] = []
    heights: list[np.ndarray] = []
    for key, members in group(list(variables.values()), rows):
        # A point per distinct value, which tooltips and the keyboard read:
        # no riser from 0 (or the whole) before the first, which would read
        # as an observation.
        distinct, steps = numerics.ecdf(v[members], None, normalize, complementary)
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
        f"Steps show the {_SHARES[normalize]} of {name} values {side} each value{by(series)}."
        + (" A group of one distinct value shows as a point." if any(single) else "")
        + dropped_sentence(dropped, [name, *variables], series_order is not None)
    )
    chart = make_chart(
        table, options, sentence=sentence, palette=palette, x_label=name, y_label=share
    )
    if not any(single):
        label = None if series else name
        chart.line(
            name, share, series=series, curve="step-after", label=label, legend_group=SERIES_GROUP
        )
    else:
        # Steps and points series by series, so that series keep their order
        # (and colors) in the legend group whichever draw as points.
        position = list(variables).index(series) if series else None
        for level, label in enumerate(variables[series].labels if series else (name,)):
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
                    legend_group=SERIES_GROUP,
                )
            if any(points):
                chart.point(
                    name, share, data=steps_of(points), label=label, legend_group=SERIES_GROUP
                )
    return record(chart, Statistics("ecdfplot", sentence, {"ecdf": readable(table)}, None, dropped))


def rugplot(
    data: Any,
    *,
    x: str | None = None,
    y: str | None = None,
    series: str | None = None,
    series_order: Sequence[Any] | None = None,
    length: float = 8,
    palette: Sequence[str] | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """A tick per value of ``x`` along the bottom of the plot (or of ``y``
    along its left), ``length`` pixels long, per ``series``."""
    axis, name = _one_axis(x, y, "rugplot")
    facet_row, facet_column = facets(options, "rugplot")
    source = Source(data)
    column = source.column(name, f"rugplot {axis}", ("number", "time"))
    variables = variables_of(
        source, "rugplot", facet_row, facet_column, series, series_order, axes=[name]
    )
    rows = complete(len(column), column, levels_of=list(variables.values()))
    dropped = len(column) - len(rows)
    table = rows_table(variables, rows)
    table[name] = number_column(values(column)[rows], column.kind)
    sentence = f"Ticks mark each value of {name}{by(series)}." + dropped_sentence(
        dropped, [name, *variables], series_order is not None
    )
    is_x = axis == "x"
    # A rug alone has nothing on its other axis.
    settings: dict[str, Any] = dict(options)
    settings.setdefault("y_axis" if is_x else "x_axis", Axis(show=False, grid=False))
    chart = make_chart(
        table,
        settings,
        sentence=sentence,
        palette=palette,
        x_label=name if is_x else None,
        y_label=None if is_x else name,
    )
    chart.rug(
        name if is_x else None,
        y=None if is_x else name,
        series=series,
        length=length,
        label=None if series else name,
        legend_group=SERIES_GROUP,
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
    normalize: Normalize,
    cumulative: bool,
    common_norm: bool,
    series: str | None,
) -> dict[str, Column]:
    """Each group's bars, as Seaborn measures them (and the chart draws them):
    per facet panel and series, each bin's edges and height."""
    keys: list[np.ndarray] = []
    lefts: list[np.ndarray] = []
    heights: list[np.ndarray] = []
    panels = [name for name in variables if name != series]
    grouping = group(list(variables.values()), rows)
    # A series' share of its panel's rows, for common normalization.
    totals: dict[tuple[int, ...], int] = {}
    for key, members in grouping:
        panel = key[: len(panels)]
        totals[panel] = totals.get(panel, 0) + len(members)
    for key, members in grouping:
        height = numerics.histogram(v[members], None, edges, normalize, cumulative)
        if common_norm and normalize != "count":
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


def _hist_norm(
    sample: np.ndarray, edges: np.ndarray, normalize: Normalize, cumulative: bool
) -> float:
    """What Seaborn scales a series' density by to match its bars: the bars'
    area, or for cumulative bars the last bar."""
    heights = numerics.histogram(sample, None, edges, normalize, cumulative)
    if cumulative:
        return float(heights.max()) if len(heights) else 0.0
    return float((heights * np.diff(edges)).sum())


def densities(
    v: np.ndarray,
    variables: Mapping[str, Levels],
    rows: np.ndarray,
    name: str,
    series: str | None,
    *,
    bw_method: BandwidthMethod,
    bw_adjust: float,
    cut: float,
    grid_size: int,
    clip: tuple[float | None, float | None],
    common_norm: bool,
    cumulative: bool,
    scale: Any,
    value_kind: str,
    role: str,
    common_grid: bool = False,
) -> tuple[dict[str, Column], str, str]:
    """Each group's density on its own grid (or with ``common_grid`` on its
    panel's, as Seaborn's histograms put theirs), as one table, and how it
    was computed."""
    if not (bw_adjust > 0 and math.isfinite(bw_adjust)):
        raise ValueError(
            f"{role} bw_adjust: expected a positive number; received {shown(bw_adjust)}"
        )
    if not (cut >= 0 and math.isfinite(cut)):
        raise ValueError(f"{role} cut: expected a number of at least 0; received {shown(cut)}")
    check_grid_size(grid_size, f"{role} grid_size")
    if isinstance(bw_method, str):
        check_choice(bw_method, f"{role} bw_method", ("scott", "silverman"))
    elif not (bw_method > 0 and math.isfinite(bw_method)):
        raise ValueError(
            f'{role} bw_method: expected "scott", "silverman", or a positive number; '
            f"received {shown(bw_method)}"
        )
    panels = [n for n in variables if n != series]
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
        return numerics.support(sample, deviation, cut, clip, grid_size)

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
        keys.append(np.tile(np.asarray(key, dtype=np.int64), (grid_size, 1)))
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
        + f", {grid_size} points, cut {cut:g})"
    )
    if common_norm:
        note += ", weighted by each series' share of the rows"
    if singular:
        groups = "groups" if singular > 1 else "group"
        note += f"; {singular} {groups} with fewer than two distinct values had none"
    return table, note, column


def _bivariate(
    data: Any,
    x: str,
    y: str,
    series: str | None,
    bw_method: BandwidthMethod,
    bw_adjust: float,
    cut: float,
    grid_size: int,
    clip: tuple[float | None, float | None] | None,
    cumulative: bool,
    colors: str | Sequence[str] | None,
    facet_row: str | None,
    facet_column: str | None,
    options: HelperOptions,
) -> Chart:
    """kdeplot of two columns: a density heatmap per facet panel, on one grid."""
    if series is not None:
        raise ValueError(
            "kdeplot series: a bivariate kdeplot draws one density per panel; "
            "facet by facet_row or facet_column instead"
        )
    if cumulative:
        raise ValueError("kdeplot cumulative: a bivariate density cannot be cumulative; drop it")
    if not (bw_adjust > 0):
        raise ValueError(
            f"kdeplot bw_adjust: expected a positive number; received {shown(bw_adjust)}"
        )
    check_grid_size(grid_size, "kdeplot grid_size")
    source = Source(data)
    xc = source.column(x, "kdeplot x", ("number",))
    yc = source.column(y, "kdeplot y", ("number",))
    variables = variables_of(source, "kdeplot", facet_row, facet_column, None, axes=[x, y])
    rows = complete(len(xc), xc, yc, levels_of=list(variables.values()))
    dropped = len(xc) - len(rows)
    xv, yv = values(xc), values(yc)
    if len(rows) < 3:
        raise ValueError("a bivariate kdeplot needs at least three complete rows")
    whole = np.vstack([xv[rows], yv[rows]])
    spread = numerics.kernel_covariance(whole, None, bw_method, bw_adjust)
    limits = clip or (None, None)
    xs = numerics.support(whole[0], math.sqrt(spread[0, 0]), cut, limits, grid_size)
    ys = numerics.support(whole[1], math.sqrt(spread[1, 1]), cut, limits, grid_size)
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
        f"on a {grid_size} by {grid_size} grid." + dropped_sentence(dropped, [x, y, *variables])
    )
    chart = make_chart(table, options, sentence=sentence, x_label=x, y_label=y)
    chart.heatmap(x, y, density, colors=colors, label="density")
    return record(
        chart, Statistics("kdeplot", sentence, {"density": readable(table)}, None, dropped)
    )


def _stack(keys: list[np.ndarray], width: int) -> np.ndarray:
    """Per-row keys of groups, one block of rows each, as one array."""
    return np.concatenate(keys) if keys else np.zeros((0, width), dtype=np.int64)
