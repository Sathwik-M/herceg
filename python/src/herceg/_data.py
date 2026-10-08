"""Columnar data conversion: dataframes and arrays to binary spec columns.

Every column becomes one of three kinds, matching the chart spec:

- ``number``: float64 (float32 stays float32), NaN for missing values;
- ``time``: epoch milliseconds as float64 (fractions keep sub-millisecond
  precision), NaN for missing values;
- ``category``: int32 dictionary codes (-1 for missing) plus the dictionary.

Values are not turned into Python objects or JSON number lists: each column's
bytes come from NumPy (pandas, Polars, and PyArrow all convert to it cheaply)
and travel next to the spec as a binary buffer. Columns are converted when a
mark first uses them, so unused columns cost nothing and may hold any type.

Conversions that would change data are refused with an error naming the
column: integers beyond 2**53 (float64 cannot hold them exactly), columns
mixing strings, numbers, and times, and category labels or column names that
collide once converted to text.
"""

from __future__ import annotations

import datetime as _dt
import math
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import numpy as np

#: Largest integer magnitude float64 holds exactly.
_EXACT_INTEGERS = 2**53
_INEXACT = (
    "integers beyond ±2**53 cannot be represented exactly as float64; "
    "convert the column to float explicitly to accept rounding"
)

#: Milliseconds per unit of NumPy, Polars, and Arrow time units.
_MS_PER_UNIT = {
    "W": 604_800_000.0,
    "D": 86_400_000.0,
    "h": 3_600_000.0,
    "m": 60_000.0,
    "s": 1_000.0,
    "ms": 1.0,
    "us": 1e-3,
    "ns": 1e-6,
    "ps": 1e-9,
    "fs": 1e-12,
    "as": 1e-15,
}


@dataclass(frozen=True)
class Column:
    """One converted column: its kind and the arrays that hold it."""

    kind: str  # "number" | "time" | "category"
    # <f8/<f4 numbers or times; <i4 codes for categories; <u1 for ROWS
    values: np.ndarray
    dictionary: tuple[str, ...] = ()

    def __len__(self) -> int:
        return len(self.values)


#: A column a table sends for its row count alone, when nothing reads its
#: columns but derived tables count its rows: zeros, one byte a row. It is
#: sent only when no column is, so its name cannot hide a column anything reads.
ROWS = "\0rows"


def rows_column(length: int) -> Column:
    """The ``ROWS`` column of a table of ``length`` rows."""
    return Column("number", np.zeros(length, dtype="<u1"))


class Table:
    """A data source's column names, converting each column on first use."""

    def __init__(self, data: Any) -> None:
        self._data = data
        self._get, keys, names = _accessor(data)
        self.names: tuple[str, ...] = tuple(_distinct_labels(names, "column names"))
        self._keys = dict(zip(self.names, keys, strict=True))
        self._columns: dict[str, Column] = {}

    def column(self, name: str) -> Column:
        """The converted column; KeyError for unknown names."""
        if name not in self._keys:
            raise KeyError(name)
        column = self._columns.get(name)
        if column is None:
            try:
                column = convert(self._get(self._keys[name]))
            except (TypeError, ValueError) as error:
                raise type(error)(f"Column {name!r}: {error}") from None
            self._columns[name] = column
        return column

    def rows(self) -> int:
        """The number of rows, without converting a column when the source can tell."""
        if not isinstance(self._data, Mapping):
            return len(self._data)  # a dataframe, an Arrow table, or a list of records
        if not self.names:
            return 0
        try:
            return len(self._get(self._keys[self.names[0]]))
        except TypeError:  # an iterable without a length
            return len(self.column(self.names[0]))


def to_columns(data: Any) -> dict[str, Column]:
    """Converts every column of a supported data source."""
    table = Table(data)
    return {name: table.column(name) for name in table.names}


def _accessor(data: Any) -> tuple[Callable[[Any], Any], list[Any], list[Any]]:
    """How to read the columns of `data`: a getter, its keys, and the column names.

    Dataframe columns are read by position, so duplicate names are reported
    as such rather than failing on lookup.
    """
    module = type(data).__module__.split(".")[0]
    if module == "pandas" and hasattr(data, "columns"):
        return (lambda key: data.iloc[:, key]), list(range(data.shape[1])), list(data.columns)
    if module == "polars" and hasattr(data, "get_columns"):
        columns = data.get_columns()
        return (lambda key: columns[key]), list(range(len(columns))), list(data.columns)
    if module == "pyarrow" and hasattr(data, "column_names"):
        positions = list(range(data.num_columns))
        return (lambda key: data.column(key)), positions, list(data.column_names)
    if isinstance(data, Mapping):
        keys = list(data.keys())
        return (lambda key: data[key]), keys, keys
    if (
        isinstance(data, Sequence)
        and not isinstance(data, str)
        and data
        and all(isinstance(record, Mapping) for record in data)
    ):
        keys = list(dict.fromkeys(key for record in data for key in record))
        return (lambda key: [record.get(key) for record in data]), keys, keys
    raise TypeError(
        "Chart data must be a pandas, Polars, or PyArrow table, a mapping of column "
        f"names to arrays, or a list of records; got {type(data).__name__}"
    )


def _distinct_labels(values: Sequence[Any], what: str) -> list[str]:
    labels = [str(value) for value in values]
    seen: dict[str, Any] = {}
    for value, label in zip(values, labels, strict=True):
        if label in seen:
            raise ValueError(
                f"{what} {seen[label]!r} and {value!r} both read as {label!r}; rename one"
            )
        seen[label] = value
    return labels


def convert(values: Any) -> Column:
    """Converts one column of any supported type."""
    module = type(values).__module__.split(".")[0]
    if module == "pandas":
        return _from_pandas(values)
    if module == "polars":
        return _from_polars(values)
    if module == "pyarrow":
        return _from_arrow(values)
    if isinstance(values, np.ndarray):
        return _from_numpy(values)
    return _from_sequence(list(values))


# NumPy -----------------------------------------------------------------------


def _from_numpy(array: np.ndarray) -> Column:
    if array.ndim != 1:
        raise ValueError(f"columns must be one-dimensional; got shape {array.shape}")
    kind = array.dtype.kind
    if kind == "f":
        return _floats(array)
    if kind in "iu":
        return Column("number", _exact_integers(array))
    if kind == "b":
        return Column("number", array.astype("<f8"))
    if kind == "M":
        return Column("time", _datetime64_ms(array))
    if kind == "m":
        raise TypeError("durations (timedelta) are not supported; convert them to numbers")
    if kind in "UO":
        return _from_sequence(array.tolist())
    raise TypeError(f"unsupported dtype {array.dtype}")


def _floats(array: np.ndarray) -> Column:
    """float32 stays float32 (in little-endian order); other floats become float64."""
    dtype = "<f4" if array.dtype.itemsize <= 4 else "<f8"
    return Column("number", np.ascontiguousarray(array, dtype=dtype))


def _exact_integers(array: np.ndarray) -> np.ndarray:
    if array.dtype.itemsize >= 8 and array.size:
        low, high = int(array.min()), int(array.max())
        if max(abs(low), abs(high)) > _EXACT_INTEGERS:
            raise ValueError(_INEXACT)
    return array.astype("<f8")


def _datetime64_ms(array: np.ndarray) -> np.ndarray:
    """datetime64 of any unit (naive values are UTC) as epoch milliseconds, NaN for NaT."""
    unit, count = np.datetime_data(array.dtype)
    if unit in ("Y", "M", "generic"):
        array = array.astype("datetime64[D]")
        unit, count = "D", 1
    return _scaled(array.view("<i8"), _MS_PER_UNIT[unit] * count, np.isnat(array))


def _scaled(integers: np.ndarray, factor: float, missing: np.ndarray | None) -> np.ndarray:
    milliseconds = integers.astype("<f8") * factor
    if missing is not None:
        milliseconds[missing] = np.nan
    return milliseconds


# Python sequences -------------------------------------------------------------


def _is_missing(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, (float, np.floating)):
        return math.isnan(value)
    name = type(value).__name__
    if name in ("NAType", "NaTType"):
        return True
    if isinstance(value, np.datetime64):
        return bool(np.isnat(value))
    return False


def _kind_of(value: Any) -> str:
    if isinstance(value, str):
        return "text"
    if isinstance(value, (_dt.datetime, _dt.date, np.datetime64)):
        return "time"
    if isinstance(value, (bool, int, float, np.number, np.bool_)):
        return "number"
    raise TypeError(f"unsupported value {value!r} of type {type(value).__name__}")


def _from_sequence(values: list[Any]) -> Column:
    present = [value for value in values if not _is_missing(value)]
    kinds = {_kind_of(value) for value in present}
    if len(kinds) > 1:
        raise TypeError(f"the column mixes {' and '.join(sorted(kinds))} values")
    kind = kinds.pop() if kinds else "number"
    if kind == "text":
        return _categories(values)
    if kind == "time":
        return Column(
            "time", np.array([np.nan if _is_missing(v) else _time_ms(v) for v in values], "<f8")
        )
    integers = [v for v in present if isinstance(v, (int, np.integer)) and not isinstance(v, bool)]
    if integers and max(abs(int(v)) for v in integers) > _EXACT_INTEGERS:
        raise ValueError(_INEXACT)
    return Column(
        "number", np.array([np.nan if _is_missing(v) else float(v) for v in values], "<f8")
    )


def _categories(values: Sequence[Any]) -> Column:
    """Dictionary-encodes strings in order of first appearance."""
    lookup: dict[str, int] = {}
    codes = np.empty(len(values), dtype="<i4")
    for i, value in enumerate(values):
        if _is_missing(value):
            codes[i] = -1
            continue
        code = lookup.get(value)
        if code is None:
            code = lookup[value] = len(lookup)
        codes[i] = code
    return Column("category", codes, tuple(lookup))


def _time_ms(value: Any) -> float:
    if isinstance(value, np.datetime64):
        return float(_datetime64_ms(np.array([value]))[0])
    if isinstance(value, _dt.datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=_dt.timezone.utc)
        # Exact arithmetic from the epoch; pandas Timestamps keep nanoseconds.
        delta = value - _dt.datetime(1970, 1, 1, tzinfo=_dt.timezone.utc)
        nanoseconds = getattr(value, "nanosecond", 0)
        return (
            delta.days * 86_400_000
            + delta.seconds * 1_000
            + delta.microseconds / 1_000
            + nanoseconds / 1e6
        )
    if isinstance(value, _dt.date):
        return (value - _dt.date(1970, 1, 1)).days * 86_400_000.0
    raise TypeError(f"expected a datetime or date; got {value!r}")


def _dictionary(codes: np.ndarray, labels: Sequence[Any]) -> Column:
    """Codes into `labels`; missing labels become missing codes."""
    missing = [i for i, label in enumerate(labels) if _is_missing(label)]
    if missing:
        remap = np.arange(len(labels), dtype="<i4")
        kept = [i for i in range(len(labels)) if i not in set(missing)]
        remap[:] = -1
        remap[kept] = np.arange(len(kept), dtype="<i4")
        codes = np.where(codes >= 0, remap[np.maximum(codes, 0)], -1).astype("<i4")
        labels = [labels[i] for i in kept]
    return Column(
        "category",
        np.ascontiguousarray(codes, dtype="<i4"),
        tuple(_distinct_labels(labels, "category labels")),
    )


# pandas -----------------------------------------------------------------------


def _from_pandas(series: Any) -> Column:
    import pandas as pd

    dtype = series.dtype
    if isinstance(dtype, pd.CategoricalDtype):
        return _dictionary(series.cat.codes.to_numpy(dtype="<i4"), list(dtype.categories))
    if isinstance(dtype, pd.DatetimeTZDtype):
        return Column(
            "time", _datetime64_ms(series.dt.tz_convert("UTC").dt.tz_localize(None).to_numpy())
        )
    if pd.api.types.is_datetime64_dtype(dtype):
        return Column("time", _datetime64_ms(series.to_numpy()))
    if pd.api.types.is_bool_dtype(dtype) and not isinstance(dtype, np.dtype):
        return Column("number", series.to_numpy(dtype="<f8", na_value=np.nan))
    if pd.api.types.is_float_dtype(dtype):
        target = "<f4" if dtype.itemsize <= 4 else "<f8"
        return Column("number", series.to_numpy(dtype=target, na_value=np.nan))
    if pd.api.types.is_integer_dtype(dtype) and not isinstance(dtype, np.dtype):
        # Nullable integers: check exactness on the present values.
        present = series.dropna().to_numpy(dtype="int64" if dtype.kind == "i" else "uint64")
        _exact_integers(present)
        return Column("number", series.to_numpy(dtype="<f8", na_value=np.nan))
    if pd.api.types.is_string_dtype(dtype) or pd.api.types.is_object_dtype(dtype):
        return _from_sequence(series.tolist())
    return convert(series.to_numpy())


# Polars -----------------------------------------------------------------------


def _from_polars(series: Any) -> Column:
    import polars as pl

    dtype = series.dtype
    if dtype == pl.Null:
        return Column("number", np.full(len(series), np.nan, dtype="<f8"))
    if isinstance(dtype, pl.Enum):
        codes = series.to_physical().cast(pl.Int32).fill_null(-1).to_numpy().astype("<i4")
        return _dictionary(codes, dtype.categories.to_list())
    if dtype == pl.Categorical or dtype in (pl.Utf8, pl.String):
        # Categorical codes are global to the process, so re-encode densely
        # through an Enum of the values present, in order of appearance.
        values = series.cast(pl.String)
        present = values.drop_nulls().unique(maintain_order=True)
        return _from_polars(values.cast(pl.Enum(present)))
    if isinstance(dtype, pl.Datetime):
        # Physical values are UTC instants in the column's time unit.
        integers = series.to_physical()
        missing = integers.is_null().to_numpy()
        values = integers.fill_null(0).to_numpy().astype("<i8")
        return Column("time", _scaled(values, _MS_PER_UNIT[dtype.time_unit], missing))
    if dtype == pl.Date:
        days = series.to_physical()
        missing = days.is_null().to_numpy()
        return Column("time", _scaled(days.fill_null(0).to_numpy(), _MS_PER_UNIT["D"], missing))
    if dtype.is_float():
        target = pl.Float32 if dtype == pl.Float32 else pl.Float64
        values = series.cast(target).fill_null(float("nan")).to_numpy()
        return _floats(values)
    if dtype.is_integer():
        present = series.drop_nulls()
        if len(present) and max(abs(int(present.min())), abs(int(present.max()))) > _EXACT_INTEGERS:
            raise ValueError(_INEXACT)
        values = series.cast(pl.Float64).fill_null(float("nan")).to_numpy()
        return Column("number", values.astype("<f8"))
    if dtype == pl.Boolean:
        return Column(
            "number", series.cast(pl.Float64).fill_null(float("nan")).to_numpy().astype("<f8")
        )
    raise TypeError(f"unsupported Polars column type {dtype}")


# PyArrow ----------------------------------------------------------------------


def _from_arrow(array: Any) -> Column:
    import pyarrow as pa
    import pyarrow.compute as pc

    if isinstance(array, pa.ChunkedArray):
        array = array.combine_chunks() if array.num_chunks != 1 else array.chunk(0)
    kind = array.type
    if pa.types.is_null(kind):
        return Column("number", np.full(len(array), np.nan, dtype="<f8"))
    if pa.types.is_dictionary(kind):
        codes = pc.fill_null(array.indices.cast(pa.int32()), -1).to_numpy(zero_copy_only=False)
        return _dictionary(codes, array.dictionary.to_pylist())
    if pa.types.is_string(kind) or pa.types.is_large_string(kind):
        return _from_arrow(pc.dictionary_encode(array))
    if pa.types.is_timestamp(kind):
        # The integers are UTC instants in the column's unit.
        integers = array.cast(pa.int64())
        missing = integers.is_null().to_numpy(zero_copy_only=False)
        values = pc.fill_null(integers, 0).to_numpy(zero_copy_only=False)
        return Column("time", _scaled(values, _MS_PER_UNIT[kind.unit], missing))
    if pa.types.is_date32(kind) or pa.types.is_date64(kind):
        unit = "D" if pa.types.is_date32(kind) else "ms"
        integers = array.cast(pa.int32() if unit == "D" else pa.int64())
        missing = integers.is_null().to_numpy(zero_copy_only=False)
        values = pc.fill_null(integers, 0).to_numpy(zero_copy_only=False)
        return Column("time", _scaled(values, _MS_PER_UNIT[unit], missing))
    if pa.types.is_floating(kind):
        target = pa.float32() if kind.bit_width <= 32 else pa.float64()
        values = pc.fill_null(array.cast(target), float("nan")).to_numpy(zero_copy_only=False)
        return _floats(values)
    if pa.types.is_integer(kind):
        present = pc.drop_null(array)
        if len(present):
            low, high = pc.min_max(present).values()
            if max(abs(low.as_py()), abs(high.as_py())) > _EXACT_INTEGERS:
                raise ValueError(_INEXACT)
        values = pc.fill_null(array.cast(pa.float64(), safe=False), float("nan"))
        return Column("number", values.to_numpy(zero_copy_only=False).astype("<f8"))
    if pa.types.is_boolean(kind):
        values = pc.fill_null(array.cast(pa.float64()), float("nan"))
        return Column("number", values.to_numpy(zero_copy_only=False).astype("<f8"))
    raise TypeError(f"unsupported Arrow column type {kind}")
