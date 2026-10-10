"""What the express functions share: reading columns from any table herceg
reads, leaving out incomplete rows, ordering categories, grouping rows,
building the tables their charts draw, and making those charts with a
description of what was computed."""

from __future__ import annotations

import math
import numbers
import weakref
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

import numpy as np

from .._chart import Axis, Chart, _chart_of
from .._data import Column, Table, listed, shown

ErrorMethod = Literal["ci", "pi", "se", "sd"]
ErrorBar = tuple[ErrorMethod, float] | ErrorMethod | None

#: The level each error method takes when only its name is given, as in Seaborn.
_LEVELS: dict[str, float] = {"ci": 95, "pi": 95, "se": 1, "sd": 1}

#: Legend groups of the marks one express chart draws per series.
SERIES_GROUP = "series"


@dataclass(frozen=True)
class Statistics:
    """What an express chart computed, from ``hx.statistics(chart)``.

    ``tables`` holds the computed tables by name (the chart's marks draw
    them), each a mapping of column names to NumPy arrays; category columns
    hold their labels. ``seed`` is the seed resampling used (chosen at random
    and recorded when none was given), ``dropped`` the rows left out for a
    missing value, and ``description`` the sentence the chart's description
    ends with.
    """

    function: str
    description: str
    tables: Mapping[str, Mapping[str, np.ndarray]]
    seed: int | None = None
    dropped: int = 0


_RECORDS: weakref.WeakKeyDictionary[Chart, Statistics] = weakref.WeakKeyDictionary()


def statistics(chart: Chart) -> Statistics:
    """The statistics an express function computed for ``chart``."""
    try:
        return _RECORDS[chart]
    except KeyError:
        raise ValueError("the chart was not made by a herceg.express function") from None


def record(chart: Chart, stats: Statistics) -> Chart:
    _RECORDS[chart] = stats
    return chart


# Reading columns ----------------------------------------------------------------


class Source:
    """A table's columns, converted on first use as charts convert them."""

    def __init__(self, data: Any) -> None:
        if data is None:
            raise ValueError("express functions need data: a dataframe or a mapping of columns")
        self._table = Table(data)

    @property
    def names(self) -> tuple[str, ...]:
        return self._table.names

    def column(self, name: str, role: str, kinds: Sequence[str] | None = None) -> Column:
        if not isinstance(name, str) or name not in self._table.names:
            available = ", ".join(repr(n) for n in self._table.names)
            raise KeyError(f"{role}: no column {name!r}; the data has {available}")
        column = self._table.column(name)
        if kinds is not None and column.kind not in kinds:
            raise TypeError(
                f"{role}: column {name!r} holds {column.kind} values; expected {' or '.join(kinds)}"
            )
        return column


def values(column: Column) -> np.ndarray:
    """A number or time column's values as float64, NaN where missing."""
    return column.values.astype("<f8", copy=False)


@dataclass(frozen=True)
class Levels:
    """A column read as categories: each row's level (-1 where it has none,
    or its value is not in the order given) and the levels' labels, in order."""

    codes: np.ndarray
    labels: tuple[str, ...]

    def __len__(self) -> int:
        return len(self.labels)


def levels(column: Column, order: Sequence[Any] | None = None) -> Levels:
    """Categories from a column: category labels in the column's order
    (pandas' categories, or first appearance), or distinct numbers and
    times ascending; with ``order``, those levels in that order."""
    if column.kind == "category":
        codes = column.values.astype(np.int64)
        labels = list(column.dictionary)
    elif column.kind in ("number", "time"):
        v = values(column)
        distinct, inverse = np.unique(v[np.isfinite(v)], return_inverse=True)
        codes = np.full(len(v), -1, dtype=np.int64)
        codes[np.isfinite(v)] = inverse
        labels = [level_label(value, column.kind) for value in distinct]
    else:
        raise TypeError(f"{column.kind} columns cannot be read as categories")
    if order is not None:
        wanted = [_order_label(level, column.kind) for level in order]
        if len(set(wanted)) != len(wanted):
            raise ValueError(f"an order lists a level twice: {list(order)!r}")
        position = {label: i for i, label in enumerate(wanted)}
        remap = np.array([position.get(label, -1) for label in labels] + [-1], dtype=np.int64)
        codes = remap[codes]
        labels = wanted
    else:
        # Only the levels rows have, in their order.
        present = np.zeros(len(labels) + 1, dtype=bool)
        present[codes] = True
        kept = np.flatnonzero(present[:-1])
        remap = np.full(len(labels) + 1, -1, dtype=np.int64)
        remap[kept] = np.arange(len(kept))
        codes = remap[codes]
        labels = [labels[i] for i in kept]
    return Levels(codes, tuple(labels))


def _order_label(level: Any, kind: str) -> str:
    """A level of an order as the column's levels are labeled: numbers and
    times of a number or time column as their labels, anything else as text."""
    if isinstance(level, str) or kind not in ("number", "time"):
        return str(level)
    if kind == "number" and isinstance(level, numbers.Real) and not isinstance(level, bool):
        return level_label(float(level), kind)
    from .._data import _time_ms

    return level_label(_time_ms(level), kind)


def level_label(value: float, kind: str) -> str:
    """A number or time as a category label."""
    if kind == "time":
        stamp = np.datetime64(int(round(value)), "ms")
        text = str(stamp)
        return text[:10] if text.endswith("T00:00:00.000") else text
    if float(value).is_integer() and abs(value) < 2**53:
        return str(int(value))
    return np.format_float_positional(value, trim="-")


# Grouping ------------------------------------------------------------------------


@dataclass
class Grouping:
    """Rows grouped by the levels of category variables (facets, series, a
    category axis), in order of those levels: each group's key (one level
    index per variable) and rows."""

    variables: list[Levels]
    keys: np.ndarray  # (groups, variables) level indices
    rows: list[np.ndarray] = field(repr=False)

    def __iter__(self) -> Iterator[tuple[tuple[int, ...], np.ndarray]]:
        for key, rows in zip(self.keys, self.rows, strict=True):
            yield tuple(int(k) for k in key), rows


def group(variables: Sequence[Levels], rows: np.ndarray) -> Grouping:
    """Groups `rows` (indexes of complete rows) by the variables' levels."""
    variables = list(variables)
    if not variables:
        # One group of every row, or none without rows.
        count = 1 if len(rows) else 0
        return Grouping([], np.zeros((count, 0), dtype=np.int64), [rows] if count else [])
    codes = np.stack([v.codes[rows] for v in variables], axis=1)
    if len(rows) == 0:
        return Grouping(variables, np.zeros((0, len(variables)), dtype=np.int64), [])
    keys, inverse = np.unique(codes, axis=0, return_inverse=True)
    inverse = inverse.reshape(-1)
    order = np.argsort(inverse, kind="stable")
    bounds = np.searchsorted(inverse[order], np.arange(len(keys) + 1))
    parts = [rows[order[a:b]] for a, b in zip(bounds[:-1], bounds[1:], strict=True)]
    return Grouping(variables, keys, parts)


def facets(options: Mapping[str, Any], function: str) -> tuple[str | None, str | None]:
    """The ``facet_row`` and ``facet_column`` among an express function's
    chart options, whose panels it computes its statistics in. ``facet``
    (wrapped panels) and ``panels`` (subplots) are refused: the computed
    tables hold no other columns to split, and the marks name no panel."""
    for name in ("facet", "panels"):
        if options.get(name):
            raise ValueError(
                f"{function} {name}: express computes statistics per panel of facet_row "
                "and facet_column; facet by those instead"
            )
    return options.get("facet_row"), options.get("facet_column")


def sharing_fields(
    resolve: str | None, facet_row: str | None, facet_column: str | None
) -> list[str]:
    """The facet fields whose values the panels sharing an axis have in
    common, as its ``resolve_x`` or ``resolve_y`` says: none for a shared
    axis (every panel shares it), both for panels' own, or a row's or a
    column's field."""
    if resolve == "independent":
        return [name for name in (facet_row, facet_column) if name is not None]
    if resolve == "rows" and facet_row is not None:
        return [facet_row]
    if resolve == "columns" and facet_column is not None:
        return [facet_column]
    return []


def refuse_facets(options: Mapping[str, Any], function: str, reason: str) -> None:
    """Refuses facets and panels in a function whose chart cannot take
    them, for `reason`."""
    for name in ("facet", "facet_row", "facet_column", "panels"):
        if options.get(name):
            raise ValueError(f"{function} {name}: {reason}; draw a chart per subset of the rows")


def variables_of(
    source: Source,
    function: str,
    facet_row: str | None,
    facet_column: str | None,
    series: str | None,
    series_order: Sequence[Any] | None = None,
    *,
    axes: Sequence[str | None] = (),
) -> dict[str, Levels]:
    """The category variables rows group by, in order: facet row, facet
    column, then series, by column name. None of them may be one of the
    `axes` a chart plots, whose column the chart's table holds as it is."""
    out: dict[str, Levels] = {}
    for name, role, given in (
        (facet_row, "facet_row", None),
        (facet_column, "facet_column", None),
        (series, "series", series_order),
    ):
        if name is None:
            continue
        if name in out:
            raise ValueError(
                f"{function} {role}: column {name!r} already facets or splits the chart; "
                "give facet_row, facet_column, and series different columns"
            )
        if name in axes:
            raise ValueError(
                f"{function} {role}: column {name!r} is also plotted on an axis; to group by "
                "it, pass a copy of the column under another name"
            )
        out[name] = levels(source.column(name, f"{function} {role}"), given)
    return out


def check_axes_differ(x: str, y: str, function: str) -> None:
    """Refuses one column on both axes where one is categories and the
    other values: the chart's table holds a column once."""
    if x == y:
        raise ValueError(
            f"{function} x and y name the same column {x!r}; pass a copy of it under another name"
        )


def complete(n: int, *columns: Column | None, levels_of: Sequence[Levels] = ()) -> np.ndarray:
    """Indexes of the rows with a value in every given column and a level
    in every given category variable."""
    mask = np.ones(n, dtype=bool)
    for column in columns:
        if column is None:
            continue
        if column.kind == "category":
            mask &= column.values >= 0
        else:
            mask &= np.isfinite(values(column))
    for variable in levels_of:
        mask &= variable.codes >= 0
    return np.flatnonzero(mask)


# Tables charts draw --------------------------------------------------------------


def category_column(codes: Sequence[int] | np.ndarray, labels: Sequence[str]) -> Column:
    return Column("category", np.asarray(codes, dtype="<i4"), tuple(labels))


def number_column(data: Sequence[float] | np.ndarray, kind: str = "number") -> Column:
    return Column("time" if kind == "time" else "number", np.asarray(data, dtype="<f8"))


def rows_table(variables: Mapping[str, Levels], rows: np.ndarray) -> dict[str, Column]:
    """Category columns of the grouping variables at source rows."""
    return {
        name: category_column(variable.codes[rows], variable.labels)
        for name, variable in variables.items()
    }


def keyed_table(
    variables: Mapping[str, Levels], keys: Sequence[Sequence[int]] | np.ndarray
) -> dict[str, Column]:
    """Category columns of the grouping variables from each computed row's key
    (a level index per variable, as ``group`` gives them)."""
    if not variables:
        return {}
    stacked = np.asarray(keys, dtype=np.int64).reshape(-1, len(variables))
    return {
        name: category_column(stacked[:, i], variable.labels)
        for i, (name, variable) in enumerate(variables.items())
    }


def subset(table: Mapping[str, Column], rows: np.ndarray | slice) -> dict[str, Column]:
    """Some rows of a table."""
    return {
        name: Column(column.kind, column.values[rows], column.dictionary)
        for name, column in table.items()
    }


def fresh(wanted: Sequence[str], taken: set[str]) -> list[str]:
    """Names for computed columns that no column of the table already has."""
    out = []
    for name in wanted:
        while name in taken:
            name += "_"
        taken.add(name)
        out.append(name)
    return out


def by(series: str | None) -> str:
    """How a description names the series variable."""
    return f", by {series}" if series else ""


def readable(table: Mapping[str, Column]) -> dict[str, np.ndarray]:
    """A table as ``Statistics`` shows it: arrays of values, labels for categories."""
    out: dict[str, np.ndarray] = {}
    for name, column in table.items():
        if column.kind == "category":
            labels = np.array(list(column.dictionary) + [None], dtype=object)
            out[name] = labels[column.values]
        else:
            out[name] = column.values.astype("<f8").copy()
        out[name].setflags(write=False)
    return out


# Options --------------------------------------------------------------------------


def seed_of(seed: int | None, function: str) -> int:
    """The seed resampling uses: the one given, or one drawn now and recorded."""
    if seed is None:
        return int(np.random.SeedSequence().entropy % 2**32)  # type: ignore[operator]
    if isinstance(seed, bool) or not isinstance(seed, numbers.Integral) or seed < 0:
        raise ValueError(
            f"{function} seed: expected a whole number of at least 0; received {shown(seed)}"
        )
    return int(seed)


def error_method(errorbar: ErrorBar, function: str) -> tuple[ErrorMethod, float] | None:
    """An ``errorbar`` argument as a method and its level."""
    if errorbar is None:
        return None
    if isinstance(errorbar, str):
        method, level = errorbar, _LEVELS.get(errorbar)
    else:
        try:
            method, level = errorbar
        except (TypeError, ValueError):
            raise ValueError(
                f'{function} errorbar: expected ("ci", 95), ("pi", 50), ("se", 1), ("sd", 1), '
                f"a method name, or None; received {shown(errorbar)}"
            ) from None
    if method not in _LEVELS:
        raise ValueError(
            f"{function} errorbar: expected the method {listed(list(_LEVELS))}; "
            f"received {shown(method)}"
        )
    if isinstance(level, bool) or not isinstance(level, numbers.Real) or not math.isfinite(level):
        raise ValueError(f"{function} errorbar: expected a finite level; received {shown(level)}")
    if level <= 0 or (method in ("ci", "pi") and level > 100):
        bound = "from above 0 to 100" if method in ("ci", "pi") else "above 0"
        raise ValueError(
            f"{function} errorbar: expected a {method} level {bound}; received {shown(level)}"
        )
    return method, float(level)


def describe_interval(method: ErrorMethod, level: float, n_boot: int, seed: int | None) -> str:
    """How an interval was computed, in words."""
    amount = f"{level:g}"
    if method == "ci":
        return (
            f"{amount}% bootstrap confidence intervals ({n_boot:,} resamples, seed {seed}, "
            "percentile method)"
        )
    if method == "pi":
        return f"{amount}% percentile intervals of the data"
    noun = "standard error" if method == "se" else "standard deviation"
    return f"±{amount} {noun}{'' if level == 1 else 's'}"


def dropped_sentence(dropped: int, roles: Sequence[str], ordered: bool = False) -> str:
    """Says how many rows were left out, missing a value of the columns
    `roles` names or, `ordered`, with a level not in the order given."""
    if dropped == 0:
        return ""
    names = list(dict.fromkeys(role for role in roles if role))
    if len(names) <= 2:
        listed = " or ".join(names)
    else:
        listed = f"{', '.join(names[:-1])}, or {names[-1]}"
    rows = "row" if dropped == 1 else "rows"
    outside = ", or with a level not in the order given," if ordered else ""
    return f" {dropped:,} {rows} missing {listed}{outside} were left out."


def check_n_boot(n_boot: int, function: str) -> int:
    if isinstance(n_boot, bool) or not isinstance(n_boot, numbers.Integral) or n_boot < 1:
        raise ValueError(
            f"{function} n_boot: expected a whole number of at least 1; received {shown(n_boot)}"
        )
    return int(n_boot)


def check_grid_size(grid_size: int, role: str) -> int:
    """Refuses a density or fit grid of fewer than two points, at ``role``."""
    if isinstance(grid_size, bool) or not isinstance(grid_size, numbers.Integral) or grid_size < 2:
        raise ValueError(
            f"{role}: expected a whole number of at least 2; received {shown(grid_size)}"
        )
    return int(grid_size)


def check_choice(value: Any, name: str, choices: Sequence[Any]) -> Any:
    """Refuses a value not among `choices`, at `name` (the function and option)."""
    if value not in choices:
        raise ValueError(f"{name}: expected {listed(choices)}; received {shown(value)}")
    return value


def neutral(theme: Any) -> str:
    """A color for marks that stand apart from the data (Seaborn's dark gray
    error bars), readable on the chart's theme."""
    name = theme.get("extends") if isinstance(theme, dict) else theme
    if name in ("dark", "high-contrast-dark"):
        return "#c8c8c8"
    if name == "auto":
        return "#8a8a8a"
    return "#424242"


def make_chart(
    data: Mapping[str, Column] | None,
    options: Mapping[str, Any],
    *,
    sentence: str,
    palette: Sequence[str] | None = None,
    x_label: str | None = None,
    y_label: str | None = None,
) -> Chart:
    """An express chart: the chart options given (facets among them), the
    ``palette`` as the theme's, axes labeled by default, and the description
    ending with ``sentence``."""
    settings: dict[str, Any] = dict(options)
    if palette is not None:
        if isinstance(palette, str) or not all(isinstance(c, str) for c in palette):
            raise ValueError(f"palette: expected a list of colors; received {shown(palette)}")
        theme = settings.get("theme")
        if isinstance(theme, dict):
            settings["theme"] = {**theme, "palette": list(palette)}
        else:
            settings["theme"] = {"palette": list(palette), **({"extends": theme} if theme else {})}
    for axis, label in (("x_axis", x_label), ("y_axis", y_label)):
        if label is not None and settings.get(axis) is None:
            settings[axis] = Axis(title=label)
    given = settings.get("description")
    settings["description"] = f"{given} {sentence}".strip() if given else sentence.strip()
    return _chart_of(data, settings)  # type: ignore[arg-type]
