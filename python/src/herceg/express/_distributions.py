"""Distributions: histplot, kdeplot, ecdfplot, rugplot, stripplot, boxplot, and violinplot."""

from __future__ import annotations

import math
import numbers
import sys
import warnings
from collections.abc import Callable, Mapping, Sequence
from typing import Any, Literal, TypedDict

import numpy as np

from .. import _data as hg_data
from .._chart import AxisOptions, Chart, HelperOptions
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
    express,
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
    weight_column,
    weights_of,
)
from ._numerics import Normalize

if sys.version_info >= (3, 11):
    from typing import Unpack
else:
    from typing_extensions import Unpack

Multiple = Literal["layer", "stack", "dodge", "fill"]
Element = Literal["bars", "step", "poly"]
Orient = Literal["v", "h", "x", "y"]
BandwidthMethod = Literal["scott", "silverman"] | float

#: AxisOptions titles of what histogram bars measure.
_MEASURES = {
    "count": "Count",
    "frequency": "Frequency",
    "probability": "Probability",
    "percent": "Percent",
    "density": "Density",
}

#: What a histogram's bins are drawn as, as its description names them.
_SHAPES = {"bars": "Bars", "step": "Steps", "poly": "Polygons"}


class KdeOptions(TypedDict, total=False):
    """The kernel density options ``histplot(kde=True)`` takes as ``kde_options``."""

    bw_method: BandwidthMethod
    bw_adjust: float
    cut: float
    grid_size: int
    clip: tuple[float | None, float | None]


@express
def histplot(
    data: Any,
    *,
    x: str | None = None,
    y: str | None = None,
    series: str | None = None,
    series_order: Sequence[Any] | None = None,
    weight: str | None = None,
    normalize: Normalize = "count",
    bins: int | str | Sequence[float] = "auto",
    binwidth: float | None = None,
    binrange: tuple[float, float] | None = None,
    discrete: bool = False,
    cumulative: bool = False,
    common_norm: bool = False,
    multiple: Multiple = "layer",
    element: Element = "bars",
    kde: bool = False,
    kde_options: KdeOptions | None = None,
    colors: str | Sequence[str] | None = None,
    palette: Sequence[str] | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """A histogram of ``x`` (or, horizontal, of ``y``), per ``series``; with
    both, a 2D histogram's cells.

    Bins are Seaborn's, chosen from all the rows: ``numpy.histogram_bin_edges``
    with ``bins`` (a count, a NumPy rule such as ``"auto"``, or edges),
    steps of ``binwidth``, a bin per integer with ``discrete=True``, within
    ``binrange``. Each row counts as 1, or as its ``weight`` (a column of
    numbers from 0 up). ``normalize`` measures each bin as
    ``Chart.histogram`` does: ``"count"``, ``"frequency"`` (counts per unit
    of the binned axis), or ``"probability"``, ``"percent"``, or
    ``"density"`` of each series' values, or with ``common_norm=True`` of all
    of them in the panel. ``cumulative`` accumulates the bins; ``multiple``
    layers the series, stacks them, dodges their bars side by side, or
    (``"fill"``) stacks them as shares of each bin. ``element`` draws bars,
    ``"step"`` areas stepping across the bins, or ``"poly"`` areas through
    their centers. ``kde=True`` adds each series' kernel density (see
    ``kdeplot``; ``kde_options`` takes its options, with ``cut`` 0), scaled
    to its bins, for layered series, along y for horizontal histograms.

    With ``x`` and ``y`` both, cells count the rows in a bin of each, colored
    by ``colors`` from 0 to the fullest cell, as Seaborn's bivariate
    histograms: each axis' edges from its own values, with ``bins``,
    ``binwidth``, ``binrange``, and ``discrete`` for both axes or, as pairs,
    for each (two bins are a pair: give a pair of edges for edges of two).
    Cells holding nothing are empty. ``normalize`` measures counts per unit
    of bin area for ``"frequency"`` and ``"density"``. It takes no series
    (facet instead), cumulative counts, multiples, elements, or kde.
    """
    if x is not None and y is not None:
        unused = {
            "series": series is not None,
            "cumulative": cumulative,
            "kde": kde,
            "multiple": multiple != "layer",
            "element": element != "bars",
            "common_norm": common_norm,
        }
        given = next((name for name, on in unused.items() if on), None)
        if given == "series":
            raise ValueError(
                "histplot series: a bivariate histplot counts one distribution per panel; "
                "facet by facet_row or facet_column instead"
            )
        if given is not None:
            raise ValueError(
                f"histplot {given}: for histograms of x or y alone; a bivariate histplot takes "
                "none, so drop it"
            )
        check_choice(normalize, "histplot normalize", tuple(_MEASURES))
        return _histplot_2d(
            data, x, y, weight, normalize, bins, binwidth, binrange, discrete, colors, options
        )
    if colors is not None:
        raise ValueError(
            "histplot colors: colors the cells of a bivariate histplot, of x and y; "
            "bars take palette"
        )
    axis, name = _one_axis(x, y, "histplot")
    check_choice(normalize, "histplot normalize", tuple(_MEASURES))
    check_choice(multiple, "histplot multiple", ("layer", "stack", "dodge", "fill"))
    check_choice(element, "histplot element", tuple(_SHAPES))
    if kde and multiple != "layer":
        raise ValueError(
            'histplot kde: kernel densities are drawn over layered bars only; pass multiple="layer"'
        )
    if multiple == "dodge" and element != "bars":
        raise ValueError(
            'histplot multiple: "dodge" places bars side by side; pass element="bars", '
            "or another multiple"
        )
    facet_row, facet_column = facets(options, "histplot")
    source = Source(data)
    column = source.column(name, f"histplot {axis}", ("number", "time"))
    weights_column = (
        source.column(weight, "histplot weight", ("number",)) if weight is not None else None
    )
    variables = variables_of(
        source,
        "histplot",
        facet_row,
        facet_column,
        series,
        series_order,
        axes=[name, *([weight] if weight is not None else [])],
    )
    rows = complete(len(column), column, weights_column, levels_of=list(variables.values()))
    dropped = len(column) - len(rows)
    v = values(column)
    w = values(weights_column) if weights_column is not None else None
    if w is not None and np.any(w[rows] < 0):
        raise ValueError(
            f"histplot weight: column {weight!r} holds negative values; "
            "weights count rows, from 0 up"
        )
    if (
        w is not None
        and isinstance(bins, str)
        and bins == "auto"
        and binwidth is None
        and not discrete
    ):
        # NumPy estimates no bin count for weighted data, as Seaborn says.
        warnings.warn(
            'histplot bins: "auto" bins cannot follow weights; using bins=10, '
            "which you will likely want to adjust",
            UserWarning,
            stacklevel=2,
        )
        bins = 10
    if isinstance(bins, (list, tuple, np.ndarray)):
        edges = np.asarray(bins, dtype=float)
    elif len(rows):
        edges = numerics.bin_edges(
            v[rows],
            None if w is None else w[rows],
            bins,  # type: ignore[arg-type]
            binwidth,
            binrange,
            discrete,
        )
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
    if weight is not None and w is not None:
        table[weight] = number_column(w[rows])
    is_x = axis == "x"
    grouped = series is not None
    # Without series, Seaborn's multiples have nothing to arrange.
    arranged = multiple if grouped else "layer"
    measured = _MEASURES[normalize] + (" (cumulative)" if cumulative else "")
    if arranged == "fill":
        measured = f"Share of {measured[0].lower()}{measured[1:]}"
    sentence = (
        f"{_SHAPES[element]} measure the {normalize} of {name}"
        + (f", each row weighted by {weight}," if weight is not None else "")
        + f" in {len(edges) - 1} bins from "
        f"{_number(edges[0])} to {_number(edges[-1])}{by(series)}"
        + (", cumulative" if cumulative else "")
        + (
            {
                "stack": ", stacked",
                "dodge": ", side by side",
                "fill": ", stacked as shares of each bin",
                "layer": "",
            }[arranged]
        )
        + (
            ", normalized over all series"
            if grouped and common_norm and normalize != "count"
            else ""
        )
        + "."
    )
    heights = _heights(
        v,
        w,
        variables,
        rows,
        edges,
        normalize,
        cumulative,
        common_norm and grouped,
        series,
        fill=arranged == "fill",
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
            scale=lambda members: _hist_norm(
                v[members], None if w is None else w[members], edges, normalize, cumulative
            ),
            value_kind=column.kind,
            role="histplot kde_options",
            common_grid=True,
            weights=w,
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
        weight=weight,
        normalize=normalize,
        common_norm=common_norm and grouped,
        cumulative=cumulative,
        stack="fill" if arranged == "fill" else arranged == "stack",
        dodge=arranged == "dodge",
        element=None if element == "bars" else element,
        # Densities over one series' bars show through them, as in Seaborn.
        fill_opacity=0.5 if kde and not grouped and element == "bars" else None,
        label=None if series else name,
        legend_group=SERIES_GROUP,
    )
    if kde_table is not None:
        # Along the binned axis: along y over horizontal bins.
        chart.line(
            name if is_x else kde_name,
            kde_name if is_x else name,
            data=kde_table,
            orient="x" if is_x else "y",
            series=series,
            label=None if series else name,
            legend_group=SERIES_GROUP,
        )
    return record(chart, Statistics("histplot", sentence, tables, None, dropped))


@express
def kdeplot(
    data: Any,
    *,
    x: str | None = None,
    y: str | None = None,
    series: str | None = None,
    series_order: Sequence[Any] | None = None,
    weight: str | None = None,
    bw_method: BandwidthMethod = "scott",
    bw_adjust: float = 1.0,
    cut: float = 3.0,
    grid_size: int = 200,
    clip: tuple[float | None, float | None] | None = None,
    filled: bool = False,
    common_norm: bool = False,
    cumulative: bool = False,
    levels: int | Sequence[float] | None = None,
    thresh: float | None = None,
    colors: str | Sequence[str] | None = None,
    palette: Sequence[str] | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """Gaussian kernel density estimates of ``x`` per ``series`` (of ``y``
    alone, along y, read by y in tooltips and the keyboard); with both
    ``x`` and ``y``, a bivariate density on a ``grid_size`` by
    ``grid_size`` grid, drawn as contour lines (``filled=True``: bands) at
    Seaborn's levels.

    Bivariate levels are iso-proportions of the density's mass, as
    Seaborn's are: ``levels`` of them from ``thresh`` (0.05) to 1 (10 by
    default), or the proportions themselves, from 0 to 1. Each is drawn at
    the density bounding the region of highest density that holds 1 - p of
    the mass, so the lowest of the default levels encloses 95% of it. The
    densities are resolved in NumPy, and ``hx.statistics(chart)`` records
    both. With facets, each panel's density is on one grid, and the levels
    are resolved over every panel's together, so a contour is the same
    density in each.

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
            10 if levels is None else levels,
            0.05 if thresh is None else thresh,
            filled,
            facet_row,
            facet_column,
            options,
            weight,
        )
    for name, given in (("levels", levels), ("thresh", thresh)):
        if given is not None:
            raise ValueError(
                f"kdeplot {name}: sets the contours of a bivariate density, of x and y; drop it"
            )
    axis, name = _one_axis(x, y, "kdeplot")
    source = Source(data)
    column = source.column(name, f"kdeplot {axis}", ("number", "time"))
    variables = variables_of(
        source,
        "kdeplot",
        facet_row,
        facet_column,
        series,
        series_order,
        axes=[name, *([weight] if weight is not None else [])],
    )
    weight_values = weight_column(source, weight, "kdeplot", [name])
    rows = complete(len(column), column, weight_values, levels_of=list(variables.values()))
    w = weights_of(weight_values, rows, weight, "kdeplot")
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
        weights=w,
    )
    measured = "Cumulative probability" if cumulative else "Density"
    sentence = (
        "Lines show "
        + note
        + (f", each row weighted by {weight}" if weight is not None else "")
        + by(series)
        + "."
        + dropped_sentence(dropped, [name, weight, *variables], series_order is not None)
    )
    is_x = axis == "x"
    chart = make_chart(
        table,
        options,
        sentence=sentence,
        palette=palette,
        x_label=name if is_x else measured,
        y_label=measured if is_x else name,
    )
    label = None if series else name
    # Densities of y run along y, read by y in tooltips and the keyboard.
    xy = (name, density) if is_x else (density, name)
    orient: Literal["x", "y"] = "x" if is_x else "y"
    if filled:
        chart.area(
            *xy,
            orient=orient,
            series=series,
            fill_opacity=0.25,
            label=label,
            legend_group=SERIES_GROUP,
        )
    else:
        chart.line(*xy, orient=orient, series=series, label=label, legend_group=SERIES_GROUP)
    return record(
        chart, Statistics("kdeplot", sentence, {"density": readable(table)}, None, dropped)
    )


#: What ECDF steps measure, as descriptions name it.
_SHARES = {"probability": "share", "percent": "percentage", "count": "count"}


@express
def ecdfplot(
    data: Any,
    *,
    x: str | None = None,
    y: str | None = None,
    series: str | None = None,
    series_order: Sequence[Any] | None = None,
    weight: str | None = None,
    normalize: Literal["probability", "percent", "count"] = "probability",
    complementary: bool = False,
    palette: Sequence[str] | None = None,
    **options: Unpack[HelperOptions],
) -> Chart:
    """The empirical distribution of ``x`` per ``series``: steps up to the
    share of values at or below each value (``normalize``: ``"probability"``
    from 0 to 1, ``"percent"``, or ``"count"``), or above it with
    ``complementary=True``; of ``y`` alone, steps along y, read by y. A
    group of one distinct value has no step and shows as a point, read as
    points are, x first: along y, its share before its value."""
    axis, name = _one_axis(x, y, "ecdfplot")
    check_choice(normalize, "ecdfplot normalize", tuple(_SHARES))
    facet_row, facet_column = facets(options, "ecdfplot")
    source = Source(data)
    column = source.column(name, f"ecdfplot {axis}", ("number", "time"))
    variables = variables_of(
        source,
        "ecdfplot",
        facet_row,
        facet_column,
        series,
        series_order,
        axes=[name, *([weight] if weight is not None else [])],
    )
    weight_values = weight_column(source, weight, "ecdfplot", [name])
    rows = complete(len(column), column, weight_values, levels_of=list(variables.values()))
    w = weights_of(weight_values, rows, weight, "ecdfplot")
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
        distinct, steps = numerics.ecdf(
            v[members], None if w is None else w[members], normalize, complementary
        )
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
    weighted = f", each row weighted by {weight}," if weight is not None else ""
    sentence = (
        f"Steps show the {_SHARES[normalize]} of {name} values{weighted} {side} each "
        f"value{by(series)}."
        + (" A group of one distinct value shows as a point." if any(single) else "")
        + dropped_sentence(dropped, [name, weight, *variables], series_order is not None)
    )
    is_x = axis == "x"
    chart = make_chart(
        table,
        options,
        sentence=sentence,
        palette=palette,
        x_label=name if is_x else share,
        y_label=share if is_x else name,
    )
    # Steps of y run along y: each holds its share up to the next value.
    xy = (name, share) if is_x else (share, name)
    orient: Literal["x", "y"] = "x" if is_x else "y"
    if not any(single):
        label = None if series else name
        chart.line(
            *xy,
            orient=orient,
            series=series,
            curve="step-after",
            label=label,
            legend_group=SERIES_GROUP,
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
                    *xy,
                    orient=orient,
                    data=steps_of(stepped),
                    curve="step-after",
                    label=label,
                    legend_group=SERIES_GROUP,
                )
            if any(points):
                chart.point(*xy, data=steps_of(points), label=label, legend_group=SERIES_GROUP)
    return record(chart, Statistics("ecdfplot", sentence, {"ecdf": readable(table)}, None, dropped))


@express
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
    settings.setdefault("y_axis" if is_x else "x_axis", AxisOptions(show=False, grid=False))
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


def _histplot_2d(
    data: Any,
    x: str,
    y: str,
    weight: str | None,
    normalize: Normalize,
    bins: Any,
    binwidth: Any,
    binrange: Any,
    discrete: Any,
    colors: str | Sequence[str] | None,
    options: HelperOptions,
) -> Chart:
    """histplot of two columns: cells counting pairs in each axis' bins."""
    facet_row, facet_column = facets(options, "histplot")
    source = Source(data)
    xc = source.column(x, "histplot x", ("number", "time"))
    yc = source.column(y, "histplot y", ("number", "time"))
    weights_column = (
        source.column(weight, "histplot weight", ("number",)) if weight is not None else None
    )
    variables = variables_of(
        source,
        "histplot",
        facet_row,
        facet_column,
        None,
        axes=[x, y, *([weight] if weight is not None else [])],
    )
    rows = complete(len(xc), xc, yc, weights_column, levels_of=list(variables.values()))
    dropped = len(xc) - len(rows)
    xv, yv = values(xc), values(yc)
    w = values(weights_column) if weights_column is not None else None
    if w is not None and np.any(w[rows] < 0):
        raise ValueError(
            f"histplot weight: column {weight!r} holds negative values; "
            "weights count rows, from 0 up"
        )

    def per_axis(option: Any, i: int, scalar: Callable[[Any], bool]) -> Any:
        """Seaborn's bivariate bin parameters: one for both axes, or a pair, one each."""
        if scalar(option):
            return option
        return option[i]

    edges = []
    warned = False
    for i, v in enumerate((xv, yv)):
        axis_bins = (
            bins[i] if isinstance(bins, (list, tuple, np.ndarray)) and len(bins) == 2 else bins
        )
        axis_width = per_axis(binwidth, i, lambda o: o is None or isinstance(o, numbers.Real))
        axis_range = per_axis(binrange, i, lambda o: o is None or isinstance(o[0], numbers.Real))
        axis_discrete = per_axis(discrete, i, lambda o: isinstance(o, bool))
        if (
            w is not None
            and isinstance(axis_bins, str)
            and axis_bins == "auto"
            and axis_width is None
            and not axis_discrete
        ):
            # NumPy estimates no bin count for weighted data, as for one variable.
            if not warned:
                warnings.warn(
                    'histplot bins: "auto" bins cannot follow weights; using bins=10, '
                    "which you will likely want to adjust",
                    UserWarning,
                    stacklevel=3,
                )
                warned = True
            axis_bins = 10
        if isinstance(axis_bins, (list, tuple, np.ndarray)):
            edges.append(np.asarray(axis_bins, dtype=float))
        elif len(rows):
            edges.append(
                numerics.bin_edges(
                    v[rows],
                    None if w is None else w[rows],
                    axis_bins,
                    axis_width,
                    axis_range,
                    axis_discrete,
                )
            )
        else:
            edges.append(np.array([0.0, 1.0]))
        # Cells are counted for every pair of bins: refused past the mark's limit first.
        if len(edges[-1]) - 1 > numerics.MAX_BINS:
            raise ValueError(
                f"histplot bins: {len(edges[-1]) - 1} bins along {'xy'[i]}, past the "
                f"{numerics.MAX_BINS} a histogram takes along each axis; give fewer"
            )
    x_edges, y_edges = edges
    table = rows_table(variables, rows)
    table[x] = number_column(xv[rows], xc.kind)
    table[y] = number_column(yv[rows], yc.kind)
    if weight is not None and w is not None:
        table[weight] = number_column(w[rows])
    counts, _, _ = np.histogram2d(
        xv[rows], yv[rows], bins=[x_edges, y_edges], weights=None if w is None else w[rows]
    )
    measured = _MEASURES[normalize]
    sentence = (
        f"Cells measure the {normalize} of rows by {x} and {y}"
        + (f", each weighted by {weight}," if weight is not None else "")
        + f" in {len(x_edges) - 1} by {len(y_edges) - 1} bins from {_number(x_edges[0])} to "
        f"{_number(x_edges[-1])} and {_number(y_edges[0])} to {_number(y_edges[-1])}."
        + dropped_sentence(dropped, [x, y, *variables])
    )
    chart = make_chart(table, options, sentence=sentence, x_label=x, y_label=y)
    chart.histogram(
        x,
        y=y,
        bins={"x": [float(e) for e in x_edges], "y": [float(e) for e in y_edges]},
        weight=weight,
        normalize=normalize,
        colors=colors,
        label=measured,
    )
    filled = np.argwhere(counts > 0)
    cells = {
        f"{x} from": x_edges[filled[:, 0]],
        f"{x} to": x_edges[filled[:, 0] + 1],
        f"{y} from": y_edges[filled[:, 1]],
        f"{y} to": y_edges[filled[:, 1] + 1],
        "count": counts[filled[:, 0], filled[:, 1]],
    }
    tables: dict[str, Mapping[str, np.ndarray]] = {
        "x edges": {"edges": x_edges},
        "y edges": {"edges": y_edges},
        "cells": cells,
    }
    return record(chart, Statistics("histplot", sentence, tables, None, dropped))


def _one_axis(x: str | None, y: str | None, function: str) -> tuple[str, str]:
    if (x is None) == (y is None):
        raise ValueError(f"{function} needs exactly one of x and y")
    return ("x", x) if x is not None else ("y", y)  # type: ignore[return-value]


def _number(value: float) -> str:
    return f"{value:.6g}"


def _heights(
    v: np.ndarray,
    w: np.ndarray | None,
    variables: Mapping[str, Levels],
    rows: np.ndarray,
    edges: np.ndarray,
    normalize: Normalize,
    cumulative: bool,
    common_norm: bool,
    series: str | None,
    *,
    fill: bool = False,
) -> dict[str, Column]:
    """Each group's bars, as Seaborn measures them (and the chart draws them):
    per facet panel and series, each bin's edges and height, its rows
    counting as their weights `w`; with `fill`, as each series' share of its
    panel's bin (Seaborn's ``multiple="fill"``), none where the bin is empty."""
    keys: list[tuple[int, ...]] = []
    heights: list[np.ndarray] = []
    panels = [name for name in variables if name != series]
    grouping = group(list(variables.values()), rows)

    def weighed(members: np.ndarray) -> float:
        return float(len(members) if w is None else w[members].sum())

    # A series' share of its panel's rows (or weight), for common normalization.
    totals: dict[tuple[int, ...], float] = {}
    for key, members in grouping:
        panel = key[: len(panels)]
        totals[panel] = totals.get(panel, 0.0) + weighed(members)
    for key, members in grouping:
        height = numerics.histogram(
            v[members], None if w is None else w[members], edges, normalize, cumulative
        )
        if common_norm and normalize != "count":
            total = totals[key[: len(panels)]]
            height = height * (weighed(members) / total if total > 0 else 0.0)
        heights.append(height)
        keys.append(key)
    if fill:
        # Each panel's bins divided among its series.
        whole: dict[tuple[int, ...], np.ndarray] = {}
        for key, height in zip(keys, heights, strict=True):
            panel = key[: len(panels)]
            whole[panel] = whole.get(panel, 0) + height
        with np.errstate(invalid="ignore", divide="ignore"):
            heights = [
                np.where(whole[key[: len(panels)]] > 0, height / whole[key[: len(panels)]], np.nan)
                for key, height in zip(keys, heights, strict=True)
            ]
    bins = len(edges) - 1
    table = keyed_table(
        variables,
        _stack(
            [np.tile(np.asarray(key, dtype=np.int64), (bins, 1)) for key in keys], len(variables)
        ),
    )
    left, right, measure = fresh(["left", "right", "height"], set(variables))
    table[left] = number_column(np.concatenate([edges[:-1] for _ in keys]) if keys else [])
    table[right] = number_column(np.concatenate([edges[1:] for _ in keys]) if keys else [])
    table[measure] = number_column(np.concatenate(heights) if heights else [])
    return table


def _hist_norm(
    sample: np.ndarray,
    weights: np.ndarray | None,
    edges: np.ndarray,
    normalize: Normalize,
    cumulative: bool,
) -> float:
    """What Seaborn scales a series' density by to match its bars: the bars'
    area, or for cumulative bars the last bar."""
    heights = numerics.histogram(sample, weights, edges, normalize, cumulative)
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
    weights: np.ndarray | None = None,
) -> tuple[dict[str, Column], str, str]:
    """Each group's density on its own grid (or with ``common_grid`` on its
    panel's, as Seaborn's histograms put theirs), as one table, and how it
    was computed; rows weigh as `weights` say, when given."""
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
    totals: dict[tuple[int, ...], float] = {}
    members_of: dict[tuple[int, ...], list[np.ndarray]] = {}

    def weighed(members: np.ndarray) -> float:
        return float(len(members) if weights is None else weights[members].sum())

    for key, members in grouping:
        totals[key[: len(panels)]] = totals.get(key[: len(panels)], 0) + weighed(members)
        members_of.setdefault(key[: len(panels)], []).append(members)

    def deviation_of(members: np.ndarray, weighed: bool = True) -> float:
        """The kernel's deviation over the members, weighted by their weights
        (those of positive weight only), or NaN where they are too few or do
        not vary."""
        if weighed and weights is not None:
            members = members[weights[members] > 0]
        sample = v[members]
        if len(sample) < 2 or not np.ptp(sample) > 0:
            return math.nan
        mass = None if not weighed or weights is None else weights[members]
        variance = float(numerics.kernel_covariance(sample, mass, bw_method, bw_adjust)[0, 0])
        return math.sqrt(variance) if variance > 0 and math.isfinite(variance) else math.nan

    def grid_of(members: np.ndarray, deviation: float) -> np.ndarray | None:
        """The members' grid, as Seaborn's: over all their values, by the
        kernel's deviation without their weights (`deviation`, the members'
        own, when they have none); None without one."""
        if weights is not None:
            deviation = deviation_of(members, weighed=False)
        if not math.isfinite(deviation):
            return None
        return numerics.support(v[members], deviation, cut, clip, grid_size)

    shared: dict[tuple[int, ...], np.ndarray] = {}
    if common_grid:
        for panel, parts in members_of.items():
            whole = np.concatenate(parts)
            grid = grid_of(whole, deviation_of(whole))
            if grid is not None:
                shared[panel] = grid
    keys: list[np.ndarray] = []
    grids: list[np.ndarray] = []
    densities: list[np.ndarray] = []
    singular = 0
    for key, members in grouping:
        deviation = deviation_of(members)
        panel = key[: len(panels)]
        if not math.isfinite(deviation) or (common_grid and panel not in shared):
            singular += 1
            continue
        kept = members if weights is None else members[weights[members] > 0]
        sample = v[kept]
        mass = None if weights is None else weights[kept]
        grid = shared[panel] if common_grid else grid_of(members, deviation)
        if grid is None:
            singular += 1
            continue
        if cumulative:
            density = numerics.cumulative_density(sample, mass, deviation, grid)
        else:
            density = numerics.density(sample, mass, deviation, grid)
        if common_norm:
            # A panel weighing nothing has no share to give.
            density = density * (weighed(members) / totals[panel] if totals[panel] > 0 else 0.0)
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


class Bivariate(TypedDict):
    """A bivariate density on one grid, per panel, and the contours to draw."""

    xs: np.ndarray
    ys: np.ndarray
    #: Per panel with a density: its key among the variables, and its grid indexed [y, x].
    panels: list[tuple[tuple[int, ...], np.ndarray]]
    #: The iso-proportions asked for, and the densities they resolve to.
    proportions: np.ndarray
    thresholds: np.ndarray
    sentence: str


def bivariate(
    xv: np.ndarray,
    yv: np.ndarray,
    variables: Mapping[str, Levels],
    rows: np.ndarray,
    x: str,
    y: str,
    *,
    w: np.ndarray | None = None,
    bw_method: BandwidthMethod,
    bw_adjust: float,
    cut: float,
    grid_size: int,
    clip: tuple[float | None, float | None] | None,
    levels: int | Sequence[float],
    thresh: float,
    filled: bool,
    role: str,
) -> Bivariate:
    """The bivariate kernel density of each panel's rows on one grid (SciPy's
    gaussian_kde, as Seaborn's, rows weighted by ``w``), and Seaborn's contour
    levels of it: the iso-proportions, and the densities they bound over
    every panel's."""
    if not (bw_adjust > 0):
        raise ValueError(
            f"{role} bw_adjust: expected a positive number; received {shown(bw_adjust)}"
        )
    check_grid_size(grid_size, f"{role} grid_size")
    if isinstance(levels, bool) or not isinstance(levels, (int, Sequence, np.ndarray)):
        raise ValueError(
            f"{role} levels: expected a count or iso-proportions from 0 to 1; "
            f"received {shown(levels)}"
        )
    if isinstance(levels, int):
        if levels < 1:
            raise ValueError(
                f"{role} levels: expected a count of at least 1; received {shown(levels)}"
            )
        if not (isinstance(thresh, (int, float)) and 0 <= thresh <= 1):
            raise ValueError(
                f"{role} thresh: expected a proportion from 0 to 1; received {shown(thresh)}"
            )
        proportions = np.linspace(thresh, 1, levels)
    else:
        proportions = np.sort(np.asarray(levels, dtype=np.float64))
        if len(proportions) == 0 or not (
            np.all(np.isfinite(proportions)) and proportions[0] >= 0 and proportions[-1] <= 1
        ):
            raise ValueError(
                f"{role} levels: expected iso-proportions from 0 to 1; received {shown(levels)}"
            )
    if len(rows) < 3:
        raise ValueError(f"a bivariate {role} needs at least three complete rows")
    whole = np.vstack([xv[rows], yv[rows]])
    spread = numerics.kernel_covariance(whole, None, bw_method, bw_adjust)
    limits = clip or (None, None)
    xs = numerics.support(whole[0], math.sqrt(spread[0, 0]), cut, limits, grid_size)
    ys = numerics.support(whole[1], math.sqrt(spread[1, 1]), cut, limits, grid_size)
    panels: list[tuple[tuple[int, ...], np.ndarray]] = []
    for key, members in group(list(variables.values()), rows):
        # Rows of no weight carry no density.
        if w is not None:
            members = members[w[members] > 0]
        if len(members) < 3:
            continue
        pair = np.vstack([xv[members], yv[members]])
        mass = None if w is None else w[members]
        covariance = numerics.kernel_covariance(pair, mass, bw_method, bw_adjust)
        if not np.isfinite(covariance).all() or np.linalg.det(covariance) <= 0:
            continue
        try:
            grid = numerics.density_2d(pair[0], pair[1], mass, covariance, xs, ys)
        except np.linalg.LinAlgError:
            # A covariance rounding leaves short of positive definite: singular too.
            continue
        panels.append((key, grid))
    pooled = np.concatenate([grid.ravel() for _, grid in panels]) if panels else np.zeros(0)
    thresholds = (
        numerics.mass_levels(pooled, proportions) if len(pooled) else np.zeros(len(proportions))
    )
    effective = np.unique(thresholds)
    # Without a density (every panel's rows too few or too alike), there is nothing to band.
    if panels and filled and len(effective) < 2:
        raise ValueError(
            f"{role} levels: filled contours need two levels or more, a band between each two; "
            f"these resolve to {len(effective)}"
        )
    rule = (
        "Scott's rule"
        if bw_method == "scott"
        else "Silverman's rule"
        if bw_method == "silverman"
        else f"factor {bw_method:g}"
    )
    held = [f"{(1 - p) * 100:.0f}%" for p in proportions]
    span = held[0] if len(held) == 1 else f"{held[0]} down to {held[-1]}"
    sentence = (
        f"{'Bands' if filled else 'Lines'} show the bivariate Gaussian kernel density of {x} and "
        f"{y} (SciPy's gaussian_kde, {rule}{f' × {bw_adjust:g}' if bw_adjust != 1 else ''}) on a "
        f"{grid_size} by {grid_size} grid, at {len(proportions)} "
        f"{'level' if len(proportions) == 1 else 'levels'} bounding the regions of highest "
        f"density holding {span} of its mass"
        + (", resolved over every panel's density" if len(panels) > 1 else "")
        + (
            f"; {len(proportions) - len(effective)} of them coincide"
            if len(effective) < len(proportions)
            else ""
        )
        + "."
    )
    return {
        "xs": xs,
        "ys": ys,
        "panels": panels,
        "proportions": proportions,
        "thresholds": thresholds,
        "sentence": sentence,
    }


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
    levels: int | Sequence[float],
    thresh: float,
    filled: bool,
    facet_row: str | None,
    facet_column: str | None,
    options: HelperOptions,
    weight: str | None,
) -> Chart:
    """kdeplot of two columns: contours of the density of each facet panel, on one grid."""
    if series is not None:
        raise ValueError(
            "kdeplot series: a bivariate kdeplot draws one density per panel; "
            "facet by facet_row or facet_column instead"
        )
    if cumulative:
        raise ValueError("kdeplot cumulative: a bivariate density cannot be cumulative; drop it")
    source = Source(data)
    xc = source.column(x, "kdeplot x", ("number",))
    yc = source.column(y, "kdeplot y", ("number",))
    variables = variables_of(
        source,
        "kdeplot",
        facet_row,
        facet_column,
        None,
        axes=[x, y, *([weight] if weight is not None else [])],
    )
    weight_values = weight_column(source, weight, "kdeplot", [x, y])
    rows = complete(len(xc), xc, yc, weight_values, levels_of=list(variables.values()))
    w = weights_of(weight_values, rows, weight, "kdeplot")
    dropped = len(xc) - len(rows)
    found = bivariate(
        values(xc),
        values(yc),
        variables,
        rows,
        x,
        y,
        w=w,
        bw_method=bw_method,
        bw_adjust=bw_adjust,
        cut=cut,
        grid_size=grid_size,
        clip=clip,
        levels=levels,
        thresh=thresh,
        filled=filled,
        role="kdeplot",
    )
    xs, ys, panels = found["xs"], found["ys"], found["panels"]
    (density,) = fresh(["density"], {x, y, *variables})
    # The density's grid points, a row each, as statistics report them.
    gx, gy = np.meshgrid(xs, ys)
    keys = [np.tile(np.asarray(key, dtype=np.int64), (gx.size, 1)) for key, _ in panels]
    table = keyed_table(variables, _stack(keys, len(variables)))
    table[x] = number_column(np.tile(gx.ravel(), len(panels)))
    table[y] = number_column(np.tile(gy.ravel(), len(panels)))
    table[density] = number_column(
        np.concatenate([grid.ravel() for _, grid in panels]) if panels else []
    )
    sentence = (
        found["sentence"]
        + (f" Each row is weighted by {weight}." if weight is not None else "")
        + dropped_sentence(dropped, [x, y, weight, *variables])
    )
    # One panel's grid travels as a matrix: its coordinates once each.
    drawn: Any = (
        hg_data.Matrix({x: xs, y: ys, density: panels[0][1]}, x, y)
        if not variables and panels
        else table
    )
    chart = make_chart(drawn, options, sentence=sentence, x_label=x, y_label=y)
    thresholds = np.unique(found["thresholds"])
    if panels:
        chart.contour(
            x,
            y,
            density,
            thresholds=[float(t) for t in thresholds],
            variant="bands" if filled else None,
            colors=colors,
            label="density",
        )
    levels_table = {"proportion": found["proportions"], "density": found["thresholds"]}
    return record(
        chart,
        Statistics(
            "kdeplot",
            sentence,
            {"density": readable(table), "levels": levels_table},
            None,
            dropped,
        ),
    )


def _stack(keys: list[np.ndarray], width: int) -> np.ndarray:
    """Per-row keys of groups, one block of rows each, as one array."""
    return np.concatenate(keys) if keys else np.zeros((0, width), dtype=np.int64)
