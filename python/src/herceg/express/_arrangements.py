"""Arrangements of subplots: pairplot and jointplot."""

from __future__ import annotations

import sys
from collections.abc import Mapping, Sequence
from typing import Any, Literal

import numpy as np

from .._chart import AxisOptions, Chart, HelperOptions, Panel
from .._data import Column, Matrix
from .._layout import Grid
from . import _numerics as numerics
from . import _regression as regression
from ._common import (
    Source,
    Statistics,
    axis_defaults,
    by,
    category_column,
    check_n_boot,
    complete,
    dropped_sentence,
    express,
    fresh,
    level_label,
    make_chart,
    number_column,
    readable,
    record,
    refuse_facets,
    resolved,
    rows_table,
    seed_of,
    shown,
    values,
    variables_of,
)
from ._distributions import bivariate, densities
from ._fits import BandFailures, check_ci, fit_band

if sys.version_info >= (3, 11):
    from typing import Unpack
else:
    from typing_extensions import Unpack

#: Pixels per panel of a pairplot by default, and of a jointplot's whole.
_PAIR_PANEL = 150
_JOINT_SIZE = 480


@express
def pairplot(
    data: Any,
    *,
    vars: Sequence[str] | None = None,
    series: str | None = None,
    color: str | None = None,
    series_order: Sequence[Any] | None = None,
    palette: Sequence[str] | None = None,
    diag_kind: Literal["auto", "hist", "kde"] | None = "auto",
    corner: bool = False,
    **options: Unpack[HelperOptions],
) -> Chart:
    """A grid of subplots: each pair of ``vars`` (by default every number
    column) as a scatter plot, and each variable's distribution on the
    diagonal: a histogram (Seaborn's bins), or with ``diag_kind="kde"`` (the
    default with ``series``) kernel densities, each series' integrating to 1
    as in ``kdeplot``, or nothing with ``None``.

    The columns of the grid share their x scale; the scatter plots of a row
    share a y range, and the diagonal's histograms and densities have y
    scales of their own. ``corner=True`` leaves out the grid's upper
    triangle. Rows missing a value are left out of the plots that use it.
    The chart is 150 pixels per panel unless ``width`` and ``height`` say
    otherwise.
    """
    if diag_kind not in ("auto", "hist", "kde", None):
        raise ValueError(
            'pairplot diag_kind: expected "auto", "hist", "kde", or None; '
            f"received {shown(diag_kind)}"
        )
    refuse_facets(options, "pairplot", "pairplot lays out panels of its own")
    source = Source(data)
    names = (
        list(vars)
        if vars is not None
        else [
            name
            for name in source.names
            if name != series and source.column(name, "pairplot").kind == "number"
        ]
    )
    if len(names) < 1 or len(set(names)) != len(names):
        raise ValueError(
            f"pairplot vars: expected distinct number columns to pair; received {names!r}"
        )
    if vars is None:
        resolved("vars", names)
    columns = {name: source.column(name, "pairplot vars", ("number",)) for name in names}
    variables = variables_of(source, "pairplot", None, None, series, series_order, axes=names)
    kept = complete(len(next(iter(columns.values()))), levels_of=list(variables.values()))
    table: dict[str, Column] = rows_table(variables, kept)
    for name, column in columns.items():
        table[name] = number_column(values(column)[kept])
    k = len(names)
    diagonal = ("kde" if series else "hist") if diag_kind == "auto" else diag_kind
    panels: list[Panel] = []
    marks: list[tuple[str, int, int]] = []
    for i, ylab in enumerate(names):
        y_values = values(columns[ylab])[kept]
        finite = y_values[np.isfinite(y_values)]
        y_range = (float(finite.min()), float(finite.max())) if len(finite) else None
        for j, xlab in enumerate(names):
            id = f"{i},{j}"
            if corner and j > i:
                # Left empty; panels of a column share their x settings.
                panels.append(
                    Panel(
                        id,
                        x=AxisOptions(title=xlab, show=False),
                        y=AxisOptions(show=False, grid=False),
                    )
                )
                continue
            if i == j:
                # A distribution has a count or density scale of its own: no y axis.
                panels.append(
                    Panel(id, title=xlab, x=AxisOptions(title=xlab), y=AxisOptions(show=False))
                )
                if diagonal is not None:
                    marks.append(("diagonal", i, j))
                continue
            # The first scatter plot of each row names its variable.
            first = j == (1 if i == 0 else 0)
            y_axis = AxisOptions(title=ylab if first else None, domain=y_range, nice=True)
            panels.append(Panel(id, x=AxisOptions(title=xlab), y=y_axis))
            marks.append(("scatter", i, j))
    settings: dict[str, Any] = dict(options)
    settings.setdefault("width", _PAIR_PANEL * k + 80)
    settings.setdefault("height", _PAIR_PANEL * k + 60)
    axis_defaults(settings, "x_axis", scope="column")
    axis_defaults(settings, "y_axis", scope="panel")
    settings["panels"] = panels
    settings["layout"] = Grid(columns=k)
    drawn = {"hist": "histograms", "kde": "kernel densities", None: "nothing"}[diagonal]
    sentence = (
        f"Scatter plots pair {', '.join(names)}{by(series)}; the diagonal shows each variable's "
        f"{drawn}."
        + dropped_sentence(
            len(source.column(names[0], "pairplot")) - len(kept), [series] if series else []
        )
    )
    chart = make_chart(table, settings, sentence=sentence, palette=palette)
    tables: dict[str, Mapping[str, np.ndarray]] = {}
    # Without series, every plot's rows are one series: one color, no legend.
    label = None if series else "rows"
    # Scatter plots first: they hold every series, so the legend group orders
    # and colors series by them, whichever a diagonal's densities lack.
    for kind, i, j in sorted(marks, key=lambda mark: mark[0] != "scatter"):
        id = f"{i},{j}"
        if kind == "scatter":
            chart.point(
                names[j],
                names[i],
                series=series,
                radius=2,
                panel=id,
                label=label,
            )
            continue
        name = names[i]
        # The source's values and rows, which the series' codes index.
        v = values(columns[name])
        rows = kept[np.isfinite(v[kept])]
        if diagonal == "hist":
            edges = (
                numerics.bin_edges(v[rows], None, "auto", None, None, False)
                if len(rows)
                else np.array([0.0, 1.0])
            )
            tables[f"{name} edges"] = {"edges": edges}
            chart.histogram(
                name,
                bins=[float(edge) for edge in edges],
                series=series,
                panel=id,
                label=label,
            )
        else:
            density, _, density_column = densities(
                v,
                variables,
                rows,
                name,
                series,
                bw_method="scott",
                bw_adjust=1.0,
                cut=3.0,
                grid_size=200,
                clip=(None, None),
                common_norm=False,
                cumulative=False,
                scale=None,
                value_kind="number",
                role="pairplot",
            )
            tables[f"{name} density"] = readable(density)
            chart.line(
                name,
                density_column,
                data=density,
                series=series,
                panel=id,
                label=label,
            )
    return record(
        chart,
        Statistics(
            "pairplot", sentence, tables, None, len(source.column(names[0], "pairplot")) - len(kept)
        ),
    )


@express
def jointplot(
    data: Any,
    *,
    x: str,
    y: str,
    series: str | None = None,
    color: str | None = None,
    series_order: Sequence[Any] | None = None,
    palette: Sequence[str] | None = None,
    kind: Literal["scatter", "reg", "kde", "hist"] = "scatter",
    bins: int | str = "auto",
    ratio: float = 5,
    ci: float | None = 95,
    n_boot: int = 1000,
    seed: int | None = 0,
    filled: bool = False,
    **options: Unpack[HelperOptions],
) -> Chart:
    """A scatter plot of ``y`` against ``x`` with each variable's histogram
    in a strip along its axis: above the plot for ``x``, and to its right,
    horizontal, for ``y``, sharing the scatter plot's scales. ``ratio`` is
    how many times the strips the plot is wide and tall. ``kind="reg"`` adds
    a linear fit with its ``ci`` bootstrap band (see ``regplot``).
    ``kind="kde"`` draws the bivariate density's contours at Seaborn's
    levels (see ``kdeplot``; ``filled=True`` fills them) and each variable's
    density in the strips; ``kind="hist"`` a 2D histogram whose bins the
    strips' histograms share. Rows missing ``x`` or ``y`` are left out of
    every part, so all three show the same rows.
    """
    if kind not in ("scatter", "reg", "kde", "hist"):
        raise ValueError(
            f'jointplot kind: expected "scatter", "reg", "kde", or "hist"; received {shown(kind)}'
        )
    if filled and kind != "kde":
        raise ValueError('jointplot filled: fills kind="kde"\'s contours; drop it')
    if series is not None and kind in ("kde", "hist"):
        raise ValueError(
            f'jointplot series: kind="{kind}" draws one distribution; '
            'give kind="scatter" or "reg" for series'
        )
    if not (ratio > 0):
        raise ValueError(f"jointplot ratio: expected a positive number; received {shown(ratio)}")
    check_ci(ci, "jointplot")
    n_boot = check_n_boot(n_boot, "jointplot")
    refuse_facets(options, "jointplot", "jointplot lays out panels of its own")
    source = Source(data)
    xc = source.column(x, "jointplot x", ("number",))
    yc = source.column(y, "jointplot y", ("number",))
    variables = variables_of(source, "jointplot", None, None, series, series_order, axes=[x, y])
    rows = complete(len(xc), xc, yc, levels_of=list(variables.values()))
    dropped = len(xc) - len(rows)
    xv, yv = values(xc)[rows], values(yc)[rows]
    table = rows_table(variables, rows)
    table[x] = number_column(xv)
    table[y] = number_column(yv)
    empty = np.array([0.0, 1.0])
    x_edges = (
        numerics.bin_edges(xv, None, bins, None, None, False, "jointplot") if len(rows) else empty
    )
    y_edges = (
        numerics.bin_edges(yv, None, bins, None, None, False, "jointplot") if len(rows) else empty
    )
    hidden = AxisOptions(show=False, grid=False)
    settings: dict[str, Any] = dict(options)
    settings.setdefault("width", _JOINT_SIZE)
    settings.setdefault("height", _JOINT_SIZE)
    settings.update(
        panels=[
            Panel("x", x=AxisOptions(title=x), y=hidden),
            Panel("corner", x=hidden, y=hidden),
            Panel("joint", x=AxisOptions(title=x), y=AxisOptions(title=y)),
            Panel("y", x=hidden, y=hidden),
        ],
        layout=Grid(rows=[1, ratio], columns=[ratio, 1]),
    )
    axis_defaults(settings, "x_axis", scope="column")
    axis_defaults(settings, "y_axis", scope="row")
    fits = kind == "reg" and len(np.unique(xv)) > 1
    used_seed = seed_of(seed, "jointplot") if fits and ci is not None else None
    failures = BandFailures()
    fit_table: dict[str, Column] | None = None
    low_name, high_name = fresh(["low", "high"], {x, y})
    if fits:
        grid = np.linspace(float(xv.min()), float(xv.max()), 100)
        fit = regression.fit(xv, yv)(grid)
        fit_table = {x: number_column(grid), y: number_column(fit)}
        if used_seed is not None and ci is not None:
            low, high = fit_band(xv, yv, grid, 1, n_boot, used_seed, ci, failures)
            fit_table[low_name] = number_column(low)
            fit_table[high_name] = number_column(high)
    sentence = (
        f"A scatter plot of {y} against {x}{by(series)}, with histograms of {x} above it "
        f"and of {y} beside it"
    )
    if fit_table is not None:
        sentence += "; a line shows a linear least-squares fit" + (
            f" with a {ci:g}% bootstrap confidence band ({n_boot:,} resamples, seed {used_seed})"
            if ci is not None
            else ""
        )
    sentence += "."
    if kind == "reg" and fit_table is None:
        sentence += f" Too few distinct {x} values for a linear fit."
    sentence += failures.sentence(x)
    sentence += dropped_sentence(dropped, [x, y, *variables], series_order is not None)
    if kind in ("kde", "hist"):
        return _joint_density(
            kind, table, x, y, xv, yv, x_edges, y_edges, filled, settings, dropped
        )
    chart = make_chart(table, settings, sentence=sentence, palette=palette)
    label = None if series else y
    chart.point(x, y, series=series, panel="joint", label=label)
    tables: dict[str, Mapping[str, np.ndarray]] = {
        "x edges": {"edges": x_edges},
        "y edges": {"edges": y_edges},
    }
    if fit_table is not None:
        if used_seed is not None and not failures.bandless:
            chart.area(
                x,
                y1=low_name,
                y2=high_name,
                data=fit_table,
                panel="joint",
                label="fit",
                fill_opacity=0.2,
            )
        chart.line(x, y, data=fit_table, panel="joint", label="fit")
        tables["fit"] = readable(fit_table)
    chart.histogram(
        x,
        bins=[float(e) for e in x_edges],
        series=series,
        panel="x",
        label=label,
    )
    chart.histogram(
        y=y,
        bins=[float(e) for e in y_edges],
        series=series,
        panel="y",
        label=label,
    )
    return record(chart, Statistics("jointplot", sentence, tables, used_seed, dropped))


def _joint_density(
    kind: Literal["kde", "hist"],
    table: dict[str, Column],
    x: str,
    y: str,
    xv: np.ndarray,
    yv: np.ndarray,
    x_edges: np.ndarray,
    y_edges: np.ndarray,
    filled: bool,
    settings: dict[str, Any],
    dropped: int,
) -> Chart:
    """A jointplot of a distribution: contours of the density with each
    variable's in the strips, or a 2D histogram with histograms of the same
    bins in them."""
    tables: dict[str, Mapping[str, np.ndarray]] = {}
    if kind == "hist":
        sentence = (
            f"Cells count rows by {x} and {y} in {len(x_edges) - 1} by {len(y_edges) - 1} bins, "
            f"with histograms of {x} above and of {y} beside them in the same bins."
        )
        chart = make_chart(table, settings, sentence=sentence + dropped_sentence(dropped, [x, y]))
        chart.histogram(
            x,
            y=y,
            bins={"x": [float(e) for e in x_edges], "y": [float(e) for e in y_edges]},
            panel="joint",
            label="Count",
        )
        tables.update({"x edges": {"edges": x_edges}, "y edges": {"edges": y_edges}})
        chart.histogram(x, bins=[float(e) for e in x_edges], panel="x", label=x)
        chart.histogram(y=y, bins=[float(e) for e in y_edges], panel="y", label=y)
        return record(chart, Statistics("jointplot", sentence, tables, None, dropped))
    # The complete rows' values, by position.
    everyone = np.arange(len(xv))
    found = bivariate(
        xv,
        yv,
        {},
        everyone,
        x,
        y,
        bw_method="scott",
        bw_adjust=1.0,
        cut=3.0,
        grid_size=200,
        clip=None,
        levels=10,
        thresh=0.05,
        filled=filled,
        role="jointplot",
    )
    marginals = {
        name: densities(
            v,
            {},
            everyone,
            name,
            None,
            bw_method="scott",
            bw_adjust=1.0,
            cut=3.0,
            grid_size=200,
            clip=(None, None),
            common_norm=False,
            cumulative=False,
            scale=None,
            value_kind="number",
            role="jointplot",
        )
        for name, v in ((x, xv), (y, yv))
    }
    sentence = found["sentence"] + f" Lines above and beside show the density of {x} and of {y}."
    chart = make_chart(table, settings, sentence=sentence + dropped_sentence(dropped, [x, y]))
    density_name = fresh(["density"], {x, y})[0]
    if found["panels"]:
        grid = Matrix({x: found["xs"], y: found["ys"], density_name: found["panels"][0][1]}, x, y)
        chart.contour(
            x,
            y,
            density_name,
            data=grid,
            thresholds=[float(t) for t in np.unique(found["thresholds"])],
            variant="bands" if filled else None,
            label="density",
            panel="joint",
        )
    for name, (marginal, _, column) in marginals.items():
        along = name == x
        position, value = (name, column) if along else (column, name)
        orient: Literal["x", "y"] = "x" if along else "y"
        panel = "x" if along else "y"
        if filled:
            chart.area(
                position,
                value,
                data=marginal,
                orient=orient,
                panel=panel,
                label=name,
                fill_opacity=0.25,
            )
        else:
            chart.line(position, value, data=marginal, orient=orient, panel=panel, label=name)
        tables[f"{name} density"] = readable(marginal)
    tables["levels"] = {"proportion": found["proportions"], "density": found["thresholds"]}
    return record(chart, Statistics("jointplot", sentence, tables, None, dropped))


#: The clustermap's share of its width and height its dendrograms take, as Seaborn's.
_DENDROGRAM_RATIO = 0.2


@express
def clustermap(
    data: Any,
    *,
    index: str | None = None,
    columns: Sequence[str] | None = None,
    method: numerics.LinkageMethod = "average",
    metric: numerics.Metric = "euclidean",
    z_score: Literal[0, 1] | None = None,
    standard_scale: Literal[0, 1] | None = None,
    row_cluster: bool = True,
    col_cluster: bool = True,
    colors: str | Sequence[str] | None = None,
    center: float | None = None,
    dendrogram_ratio: float = _DENDROGRAM_RATIO,
    **options: Unpack[HelperOptions],
) -> Chart:
    """A heatmap of a matrix whose rows and columns are reordered by
    hierarchical clustering, with the clusterings' dendrograms above it (its
    columns) and to its left (its rows).

    ``data`` is a table with a row per matrix row: a pandas DataFrame
    (labeled by its index, or by the ``index`` column), another table with
    an ``index`` column of labels (rows are numbered otherwise), or a 2D
    NumPy array. Its number columns, or ``columns``, are the matrix's
    columns; every cell needs a value. ``z_score`` (0 rows, 1 columns)
    standardizes each row or column to mean 0 and standard deviation 1, and
    ``standard_scale`` scales each from its minimum to its maximum, before
    clustering. Clustering is SciPy's ``linkage`` with ``method`` and
    ``metric`` when SciPy is installed (``herceg[stats]``), and the same
    agglomeration in NumPy otherwise (for the methods "single", "complete",
    "average", "weighted", and "ward"). Leaves follow SciPy's dendrogram
    order. ``colors`` and ``center`` are the heatmap's color ramp and
    midpoint.
    """
    refuse_facets(options, "clustermap", "clustermap lays out panels of its own")
    if z_score is not None and standard_scale is not None:
        raise ValueError(
            "clustermap z_score: z_score and standard_scale exclude each other; give one"
        )
    for name, axis in (("z_score", z_score), ("standard_scale", standard_scale)):
        if axis not in (None, 0, 1):
            raise ValueError(
                f"clustermap {name}: expected 0 (rows), 1 (columns), or None; "
                f"received {shown(axis)}"
            )
    if not (0 < dendrogram_ratio < 1):
        raise ValueError(
            "clustermap dendrogram_ratio: expected a number between 0 and 1; "
            f"received {shown(dendrogram_ratio)}"
        )
    rows, names, matrix = _matrix(data, index, columns)
    if matrix.shape[0] < 1 or matrix.shape[1] < 1:
        raise ValueError("clustermap needs at least one row and one column")
    if not np.all(np.isfinite(matrix)):
        raise ValueError("clustermap needs a finite value in every cell; fill or drop missing ones")
    if z_score is not None:
        matrix = _standardized(matrix, z_score)
    if standard_scale is not None:
        matrix = _scaled(matrix, standard_scale)
    n, m = matrix.shape
    row_merges = numerics.linkage(matrix, method, metric) if row_cluster and n > 1 else None
    col_merges = numerics.linkage(matrix.T, method, metric) if col_cluster and m > 1 else None
    row_order = numerics.leaves(row_merges, n) if row_merges is not None else np.arange(n)
    col_order = numerics.leaves(col_merges, m) if col_merges is not None else np.arange(m)
    row_name, col_name, value_name = fresh([index or "row", "column", "value"], set())
    # The heatmap's categories, in the dendrograms' leaf order.
    rank_row = np.empty(n, dtype=np.intp)
    rank_row[row_order] = np.arange(n)
    rank_col = np.empty(m, dtype=np.intp)
    rank_col[col_order] = np.arange(m)
    cells_row, cells_col = np.meshgrid(np.arange(n), np.arange(m), indexing="ij")
    heat = {
        row_name: category_column(rank_row[cells_row.ravel()], [rows[i] for i in row_order]),
        col_name: category_column(rank_col[cells_col.ravel()], [names[j] for j in col_order]),
        value_name: number_column(matrix.ravel()),
    }
    hidden = AxisOptions(show=False, grid=False)
    settings: dict[str, Any] = dict(options)
    settings.setdefault("width", 640)
    settings.setdefault("height", 640)
    settings.setdefault("legend", True)
    ratio = [dendrogram_ratio, 1 - dendrogram_ratio]
    settings.update(
        panels=[
            Panel("corner", x=hidden, y=hidden),
            Panel("top", x=AxisOptions(show=False), y=hidden),
            Panel("left", x=hidden, y=AxisOptions(show=False)),
            Panel("matrix"),
        ],
        layout=Grid(rows=ratio, columns=ratio),
    )
    axis_defaults(settings, "x_axis", scope="column")
    axis_defaults(settings, "y_axis", scope="row")
    linkage_name = f"{method} linkage, {metric} distances"
    scaling = ""
    if z_score is not None:
        scaling = f", each {'row' if z_score == 0 else 'column'} standardized to z-scores"
    elif standard_scale is not None:
        part = "row" if standard_scale == 0 else "column"
        scaling = f", each {part} scaled from its minimum to its maximum"
    clustered = [
        part
        for part, done in (("rows", row_merges is not None), ("columns", col_merges is not None))
        if done
    ]
    sentence = (
        f"A heatmap of {n} rows by {m} columns{scaling}"
        + (
            f", its {' and '.join(clustered)} ordered by hierarchical clustering ({linkage_name}), "
            "with the dendrograms beside it"
            if clustered
            else ""
        )
        + "."
    )
    chart = make_chart(heat, settings, sentence=sentence)
    chart.heatmap(
        col_name,
        row_name,
        value_name,
        colors=colors,
        color_midpoint=center,
        label=value_name,
        panel="matrix",
    )
    # The matrix's row labels beside its columns, whatever those are named.
    (labels_name,) = fresh([row_name], set(names))
    tables: dict[str, Mapping[str, np.ndarray]] = {
        "matrix": {name: matrix[:, j] for j, name in enumerate(names)}
        | {labels_name: np.array(rows, dtype=object)},
        "row order": {row_name: np.array([rows[i] for i in row_order], dtype=object)},
        "column order": {col_name: np.array([names[j] for j in col_order], dtype=object)},
    }
    for merges, labels, side, panel, part in (
        (col_merges, names, "bottom", "top", "column"),
        (row_merges, rows, "right", "left", "row"),
    ):
        if merges is None:
            continue
        tree = {
            "first": number_column(merges[:, 0]),
            "second": number_column(merges[:, 1]),
            "height": number_column(merges[:, 2]),
        }
        chart.dendrogram(
            "first",
            "second",
            "height",
            leaves=list(labels),
            side=side,  # type: ignore[arg-type]
            data=tree,
            label=f"{part} clustering",
            panel=panel,
        )
        tables[f"{part} linkage"] = {
            "first": merges[:, 0].astype(int),
            "second": merges[:, 1].astype(int),
            "height": merges[:, 2].copy(),
            "size": merges[:, 3].astype(int),
        }
    return record(chart, Statistics("clustermap", sentence, tables, None, 0))


def _matrix(
    data: Any, index: str | None, columns: Sequence[str] | None
) -> tuple[list[str], list[str], np.ndarray]:
    """A clustermap's row labels, column labels, and values, rows by columns."""
    if isinstance(data, np.ndarray):
        if data.ndim != 2:
            raise ValueError(
                f"clustermap data: expected a two-dimensional array; received {data.ndim}-D"
            )
        if index is not None or columns is not None:
            option = "index" if index is not None else "columns"
            raise ValueError(
                f"clustermap {option}: names columns of a table, but data is an array; "
                f"drop {option}, or pass a table"
            )
        values_ = np.asarray(data, dtype=float)
        rows = [str(i) for i in range(values_.shape[0])]
        return rows, [str(j) for j in range(values_.shape[1])], values_
    source = Source(data)
    labels: list[str] | None = None
    if index is not None:
        column = source.column(index, "clustermap index")
        if column.kind == "category":
            if np.any(column.values < 0):
                raise ValueError(f"clustermap index {index!r} has rows without a label")
            labels = [column.dictionary[code] for code in column.values]
        else:
            labels = [level_label(value, column.kind) for value in values(column)]
    elif type(data).__module__.split(".")[0] == "pandas" and hasattr(data, "index"):
        labels = [str(label) for label in data.index]
    if columns is not None:
        names = list(columns)
    else:
        names = [
            name
            for name in source.names
            if name != index and source.column(name, "clustermap").kind == "number"
        ]
    if not names:
        raise ValueError("clustermap needs number columns to cluster")
    if columns is None:
        resolved("columns", names)
    matrix = np.column_stack(
        [values(source.column(name, "clustermap columns", ("number",))) for name in names]
    )
    if labels is None:
        labels = [str(i) for i in range(matrix.shape[0])]
    if len(set(labels)) != len(labels):
        raise ValueError(
            "clustermap row labels must differ: give an index column of distinct labels"
        )
    return labels, [str(name) for name in names], matrix


def _standardized(matrix: np.ndarray, axis: int) -> np.ndarray:
    """Each row (0) or column (1) less its mean, over its standard deviation
    (ddof 1), as Seaborn's z_score."""
    data = matrix if axis == 1 else matrix.T
    deviation = data.std(axis=0, ddof=1)
    if np.any(~(deviation > 0)):
        part = "row" if axis == 0 else "column"
        raise ValueError(f"z_score cannot standardize a {part} whose values do not vary")
    out = (data - data.mean(axis=0)) / deviation
    return out if axis == 1 else out.T


def _scaled(matrix: np.ndarray, axis: int) -> np.ndarray:
    """Each row (0) or column (1) from its minimum (0) to its maximum (1), as
    Seaborn's standard_scale."""
    data = matrix if axis == 1 else matrix.T
    low, high = data.min(axis=0), data.max(axis=0)
    if np.any(~(high > low)):
        part = "row" if axis == 0 else "column"
        raise ValueError(f"standard_scale cannot scale a {part} whose values do not vary")
    out = (data - low) / (high - low)
    return out if axis == 1 else out.T
