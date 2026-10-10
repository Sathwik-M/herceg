import datetime as dt

import numpy as np
import pandas as pd
import polars as pl
import pyarrow as pa
import pytest

from herceg._data import convert, to_columns

JAN_1 = 1_767_225_600_000  # 2026-01-01T00:00:00Z in epoch milliseconds


def test_numbers_become_float64_with_nan_for_missing():
    column = convert([1, None, 3.5])
    assert column.kind == "number"
    assert column.values.dtype == np.dtype("<f8")
    assert np.isnan(column.values[1]) and column.values[2] == 3.5


def test_float32_stays_float32():
    column = convert(np.array([1.5, 2.5], dtype=np.float32))
    assert column.values.dtype == np.dtype("<f4")


def test_strings_become_dictionary_codes_in_order_of_appearance():
    column = convert(["web", None, "db", "web"])
    assert column.kind == "category"
    assert column.dictionary == ("web", "db")
    assert column.values.tolist() == [0, -1, 1, 0]
    assert column.values.dtype == np.dtype("<i4")


def test_datetimes_become_epoch_milliseconds():
    naive = convert([dt.datetime(2026, 1, 1), None])
    assert naive.kind == "time"
    assert naive.values[0] == JAN_1 and np.isnan(naive.values[1])
    aware = convert([dt.datetime(2026, 1, 1, 1, tzinfo=dt.timezone(dt.timedelta(hours=1)))])
    assert aware.values[0] == JAN_1
    assert convert(np.array(["2026-01-01", "NaT"], dtype="datetime64[ms]")).values[0] == JAN_1


def test_pandas_columns():
    frame = pd.DataFrame(
        {
            "t": pd.to_datetime(["2026-01-01", None]).tz_localize("UTC"),
            "v": pd.array([1, None], dtype="Int64"),
            "host": pd.Categorical(["b", None], categories=["a", "b"]),
            "name": ["x", None],
            "ok": [True, False],
        }
    )
    columns = to_columns(frame)
    assert columns["t"].kind == "time" and columns["t"].values[0] == JAN_1
    assert np.isnan(columns["v"].values[1])
    assert columns["host"].dictionary == ("a", "b") and columns["host"].values.tolist() == [1, -1]
    assert columns["name"].kind == "category" and columns["name"].values.tolist() == [0, -1]
    assert columns["ok"].values.tolist() == [1.0, 0.0]


def test_polars_columns():
    frame = pl.DataFrame(
        {
            "t": pl.Series([dt.datetime(2026, 1, 1), None]).dt.replace_time_zone("UTC"),
            "v": [1, None],
            "host": pl.Series(["b", None], dtype=pl.Categorical),
            "name": ["x", "y"],
        }
    )
    columns = to_columns(frame)
    assert columns["t"].values[0] == JAN_1 and np.isnan(columns["t"].values[1])
    assert np.isnan(columns["v"].values[1])
    host = columns["host"]
    assert (
        host.kind == "category" and host.values[1] == -1 and host.dictionary[host.values[0]] == "b"
    )
    assert columns["name"].kind == "category"


def test_arrow_columns():
    table = pa.table(
        {
            "t": pa.array([JAN_1, None], type=pa.timestamp("ms", tz="UTC")),
            "d": pa.array([dt.date(2026, 1, 1)], type=pa.date32()).take([0, 0]),
            "v": pa.array([1, None], type=pa.int64()),
            "host": pa.array(["b", None]).dictionary_encode(),
            "name": pa.array(["x", "x"]),
        }
    )
    columns = to_columns(table)
    assert columns["t"].values[0] == JAN_1 and np.isnan(columns["t"].values[1])
    assert columns["d"].values.tolist() == [JAN_1, JAN_1]
    assert np.isnan(columns["v"].values[1])
    assert columns["host"].values.tolist() == [0, -1] and columns["host"].dictionary == ("b",)
    assert columns["name"].dictionary == ("x",)


def test_records_and_mappings():
    columns = to_columns([{"x": 1, "y": "a"}, {"x": 2}])
    assert columns["x"].values.tolist() == [1.0, 2.0]
    assert columns["y"].values.tolist() == [0, -1]
    assert to_columns({"x": np.arange(3)})["x"].values.tolist() == [0.0, 1.0, 2.0]


def test_unsupported_input_is_explained():
    with pytest.raises(TypeError, match="data: expected a pandas, Polars, or PyArrow table"):
        to_columns(42)
    with pytest.raises(ValueError, match="one-dimensional"):
        convert(np.zeros((2, 2)))


def test_timestamps_keep_their_precision_and_range():
    for unit, value, expected in [
        ("s", 1_767_225_600, JAN_1),
        ("ms", JAN_1, JAN_1),
        ("us", JAN_1 * 1000 + 123, JAN_1 + 0.123),
        ("ns", JAN_1 * 1_000_000 + 123_456, JAN_1 + 0.123456),
        ("us", -1_500, -1.5),
    ]:
        column = convert(pa.array([value, None], type=pa.timestamp(unit, tz="UTC")))
        # Epoch milliseconds as float64 resolve about 0.25 µs near 2026.
        assert column.values[0] == pytest.approx(expected, abs=1e-3)
        assert np.isnan(column.values[1])
    far = convert(np.array(["1500-01-01", "2500-01-01"], dtype="datetime64[D]"))
    assert far.values.tolist() == [
        (dt.date(1500, 1, 1) - dt.date(1970, 1, 1)).days * 86_400_000,
        (dt.date(2500, 1, 1) - dt.date(1970, 1, 1)).days * 86_400_000,
    ]
    fractional = pl.Series([dt.datetime(2026, 1, 1, 0, 0, 0, 500)], dtype=pl.Datetime("us"))
    assert convert(fractional).values[0] == JAN_1 + 0.5


def test_object_columns_are_inferred_not_stringified():
    frame = pd.DataFrame(
        {
            "day": pd.Series([dt.date(2026, 1, 1), None], dtype=object),
            "count": pd.Series([1, 2.5], dtype=object),
            "missing": pd.Series([pd.NA, "a", np.nan], dtype=object)[:2],
        }
    )
    columns = to_columns(frame)
    assert columns["day"].kind == "time" and columns["day"].values[0] == JAN_1
    assert columns["count"].kind == "number"
    assert columns["missing"].values.tolist() == [-1, 0]
    with pytest.raises(TypeError, match="Column 'mixed': the column mixes number and text"):
        to_columns({"mixed": ["a", 1]})
    times = convert([pd.NaT, dt.datetime(2026, 1, 1), np.nan])
    assert np.isnan(times.values[0]) and times.values[1] == JAN_1 and np.isnan(times.values[2])


def test_missing_and_colliding_category_labels():
    with_null = pa.DictionaryArray.from_arrays(pa.array([0, 1], pa.int32()), pa.array(["a", None]))
    assert convert(with_null).values.tolist() == [0, -1]
    assert convert(with_null).dictionary == ("a",)
    collide = pd.Series(pd.Categorical([1, "1"], categories=[1, "1"]))
    with pytest.raises(ValueError, match="both read as '1'"):
        convert(collide)
    assert np.isnan(convert(pa.nulls(2)).values).all()
    assert np.isnan(convert(pl.Series([None, None])).values).all()


def test_integers_beyond_float64_precision_are_refused():
    assert convert(np.array([2**53], dtype=np.int64)).values[0] == 2**53
    for source in [
        np.array([2**53 + 1], dtype=np.int64),
        np.array([2**63], dtype=np.uint64),
        pd.Series([2**53 + 1, None], dtype="Int64"),
        pl.Series([2**53 + 1]),
        pa.array([-(2**53) - 1]),
        [2**53 + 1],
    ]:
        with pytest.raises(ValueError, match="2\\*\\*53"):
            convert(source)


def test_column_names_must_stay_distinct():
    with pytest.raises(ValueError, match="column names 1 and '1' both read as '1'"):
        to_columns({1: [1], "1": [2]})
    duplicated = pd.DataFrame([[1, 2]], columns=["a", "a"])
    with pytest.raises(ValueError, match="column names 'a' and 'a'"):
        to_columns(duplicated)


def test_float32_survives_byte_order_and_pandas_extension_types():
    assert convert(np.array([1.5], dtype=">f4")).values.dtype == np.dtype("<f4")
    assert convert(pd.Series([1.5, None], dtype="Float32")).values.dtype == np.dtype("<f4")
