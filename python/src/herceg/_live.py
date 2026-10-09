"""A chart's current state after updates from Python: what a live browser draws.

Updates change the data and options kept here and return the message that
brings a browser up to date, with the new columns as binary buffers. A
browser that connects later gets the whole current chart from ``to_spec``.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any

import numpy as np

from . import _geo
from ._chart import OPTIONS, assemble_spec, columns_spec, spec_options, table_name
from ._data import Column, Table

if TYPE_CHECKING:
    from ._chart import Chart

Message = tuple[dict[str, Any], list[bytes]]


class LiveChart:
    def __init__(self, chart: Chart) -> None:
        _check_live(chart._settings)
        self._settings = dict(chart._settings)
        self._options = spec_options(self._settings)
        self._layout = chart._layout_spec()
        self._marks = chart._mark_specs()
        # Current columns by table name: only those marks read, as in the spec.
        self._tables = chart._used_columns()
        self._derived = chart._derived_specs()
        self._sources = chart._table_names()
        self._default = self._sources[chart._default][1] if chart._default is not None else None
        # Joined maps: replacing their rows joins the new rows to the features again.
        self._joins = [
            (join.source, table_name(index), join) for index, join in chart._joins.items()
        ]

    @property
    def shares_y(self) -> bool:
        """Whether every panel shares one y scale, so the chart has one y viewport."""
        return self._settings["resolve_y"] in (None, "shared") and "panels" not in self._layout

    def to_spec(self) -> Message:
        return assemble_spec(self._options, self._layout, self._tables, self._marks, self._derived)

    def append(self, rows: Any, data: Any = None, max_rows: int | None = None) -> Message | None:
        """Adds rows to a table, keeping at most `max_rows` of them; None when there are none."""
        if max_rows is not None and not (
            isinstance(max_rows, int) and not isinstance(max_rows, bool) and max_rows >= 1
        ):
            raise ValueError(f"max_rows must be a whole number of at least 1, not {max_rows!r}")
        name = self._table_name(data)
        if any(column.kind == "geometry" for column in self._tables[name].values()):
            raise ValueError("a table of shapes takes replace(), not append()")
        batch = self._batch(name, rows)
        count = _length(batch)
        if count == 0:
            return None
        if max_rows is not None and count > max_rows:
            # Rows that would be dropped at once are not sent.
            batch = {field: _tail(column, max_rows) for field, column in batch.items()}
        current = self._tables[name]
        for field, column in batch.items():
            joined = _concatenate(current[field], column)
            current[field] = _tail(joined, max_rows) if max_rows is not None else joined
        buffers: list[bytes] = []
        message: dict[str, Any] = {
            "type": "append",
            "table": name,
            "columns": columns_spec(batch, buffers),
        }
        if max_rows is not None:
            message["maxRows"] = max_rows
        return message, buffers

    def replace(self, rows: Any, data: Any = None) -> Message:
        """Replaces every row of a table; rows joined to a map's features (``geojson=``)
        are joined again."""
        joins = [] if data is None or self._sources_read(data) else self._joins_of(data)
        if len(joins) > 1:
            raise ValueError(
                "these rows are joined to the features of several geoshape marks; "
                "make a chart per map, or join the rows with GeoPandas first (merge)"
            )
        if joins:
            _, name, join = joins[0]
            batch = self._batch(name, rows, join.rejoin(Table(_one_row(rows))))
        else:
            name = self._table_name(data)
            batch = self._batch(name, rows)
        buffers: list[bytes] = []
        # The message is made first, so rows it cannot carry change nothing.
        columns = columns_spec(batch, buffers)
        self._tables[name] = batch
        return {"type": "replace", "table": name, "columns": columns}, buffers

    def update(self, changes: Mapping[str, Any]) -> Message | None:
        """Changes chart options; the message holds the changed spec options, None
        for removed ones. None when nothing changed."""
        unknown = sorted(set(changes) - set(OPTIONS))
        if unknown:
            fixed = {"data", "facet", "facet_columns"} & set(unknown)
            hint = " (data and facets cannot change; make a new chart)" if fixed else ""
            raise TypeError(f"unknown chart option {', '.join(map(repr, unknown))}{hint}")
        settings = {**self._settings, **changes}
        _check_live(settings)
        options = spec_options(settings)
        # Checked before anything changes, as the chart checks it when made.
        if options.get("navigator") and self._layout:
            raise ValueError("charts with facets or panels cannot have a navigator yet")
        changed = {
            key: options.get(key)
            for key in sorted(set(options) | set(self._options))
            if options.get(key) != self._options.get(key)
        }
        self._settings, self._options = settings, options
        return ({"type": "options", "options": changed}, []) if changed else None

    def _table_name(self, data: Any) -> str:
        if data is None:
            if self._default is None:
                raise ValueError("the chart has no data of its own; pass data= to choose a table")
            name = self._default
        else:
            found = next((name for source, name in self._sources if source is data), None)
            if found is None:
                raise ValueError(
                    "data= must be the object passed to the chart or to one of its marks"
                )
            name = found
        if name in self._derived:
            raise ValueError("a derived table follows its source: append to the source's data")
        if name not in self._tables:
            raise ValueError("no mark of the chart reads columns of that data")
        return name

    def _joins_of(self, data: Any) -> list[tuple[Any, str, Any]]:
        """The joined maps made from `data`, one per table of features."""
        return [join for join in self._joins if join[0] is data]

    def _sources_read(self, data: Any) -> bool:
        """Whether a mark reads the columns of `data` itself."""
        return any(source is data and name in self._tables for source, name in self._sources)

    def _batch(self, name: str, rows: Any, table: Any = None) -> dict[str, Column]:
        """The table's columns from `rows` (or `table`, rows already read), converted
        to the kinds the table holds."""
        current = self._tables[name]
        if table is None:
            table = Table(_one_row(rows))
        missing = [field for field in current if field not in table.names]
        if missing:
            raise KeyError(
                f"the rows have no column {', '.join(map(repr, missing))}; "
                f"the chart reads {', '.join(map(repr, current))}"
            )
        batch = {
            field: _as_kind(table.column(field), column, field) for field, column in current.items()
        }
        lengths = {field: len(column) for field, column in batch.items()}
        if len(set(lengths.values())) > 1:
            raise ValueError(f"columns differ in length: {lengths}")
        return batch


def _check_live(settings: dict[str, Any]) -> None:
    """Live charts report one x range for zooming and brushing, so their
    panels share x."""
    if settings["resolve_x"] not in (None, "shared"):
        raise ValueError(
            "live charts carry one x range for zoom and selection, so their panels "
            "share x: resolve_x must be 'shared' (show charts whose panels have x "
            "scales of their own with chart.show() or to_html())"
        )


def _one_row(rows: Any) -> Any:
    """A mapping of single values as a row of columns; other rows as they are."""
    if isinstance(rows, Mapping) and all(np.ndim(value) == 0 for value in rows.values()):
        return {field: [value] for field, value in rows.items()}
    return rows


def _length(columns: dict[str, Column]) -> int:
    return len(next(iter(columns.values())))


def _as_kind(column: Column, current: Column, field: str) -> Column:
    """`column` as the kind of `current`; numbers keep the table's precision."""
    if column.kind != current.kind:
        # A column of missing values converts as numbers but fits any kind.
        if column.kind == "number" and np.isnan(column.values).all():
            if current.kind == "category":
                return Column("category", np.full(len(column), -1, dtype="<i4"))
            if current.kind == "geometry":
                codes, shapes = _geo.pack([None] * len(column))
                return Column("geometry", codes, shapes=shapes)
            return Column(current.kind, column.values.astype("<f8"))
        raise TypeError(
            f"column {field!r} holds {current.kind} values; the rows hold {column.kind} values"
        )
    if column.kind in ("category", "geometry"):
        return column
    return Column(column.kind, column.values.astype(current.values.dtype, copy=False))


def _concatenate(current: Column, new: Column) -> Column:
    if current.kind != "category":
        return Column(current.kind, np.concatenate([current.values, new.values]))
    # New labels join the dictionary in the order rows first use them, as the
    # browser's table adds them, so a browser that loads this state later
    # orders categories (and so bands and colors) the same way. Labels no
    # row uses are left out, as the browser never sees them.
    dictionary = list(current.dictionary)
    lookup = {label: code for code, label in enumerate(dictionary)}
    remap = np.full(len(new.dictionary) + 1, -1, dtype="<i4")  # code -1 indexes the last slot
    present = new.values[new.values >= 0]
    _, first = np.unique(present, return_index=True)
    for code in present[np.sort(first)]:
        label = new.dictionary[code]
        if label not in lookup:
            lookup[label] = len(dictionary)
            dictionary.append(label)
        remap[code] = lookup[label]
    return Column(
        "category", np.concatenate([current.values, remap[new.values]]), tuple(dictionary)
    )


def _tail(column: Column, count: int) -> Column:
    return Column(column.kind, column.values[-count:], column.dictionary)
