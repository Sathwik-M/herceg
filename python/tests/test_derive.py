import datetime as dt
import json

import numpy as np
import pytest

import herceg as hg

READINGS = {
    "site": ["n", "s", "n", "s"],
    "temp": np.array([10.0, 20.0, 15.0, 30.0]),
    "hour": np.array([0.0, 0.0, 1.0, 1.0]),
    "unused": np.array([0.0, 0.0, 0.0, 0.0]),
}


def test_expressions_build_portable_json():
    condition = (hg.col("temp") > 12) & ~hg.col("site").is_in("e", "w")
    assert condition.to_json() == [
        "and",
        [">", ["field", "temp"], 12],
        ["not", ["in", ["field", "site"], "e", "w"]],
    ]
    assert (2 * hg.col("temp") + 1).to_json() == ["+", ["*", 2, ["field", "temp"]], 1]
    assert (hg.col("temp") == None).to_json() == ["==", ["field", "temp"], None]  # noqa: E711
    assert hg.when(hg.col("temp") >= 25, "hot", "warm").to_json() == [
        "if",
        [">=", ["field", "temp"], 25],
        "hot",
        "warm",
    ]
    moment = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)
    assert (hg.col("t") < moment).to_json() == ["<", ["field", "t"], 1767225600000]
    assert abs(-hg.col("temp")).sqrt().to_json() == ["sqrt", ["abs", ["-", ["field", "temp"]]]]
    with pytest.raises(TypeError, match="combine with & and |"):
        bool(hg.col("temp") > 1)
    with pytest.raises(ValueError, match="finite"):
        _ = hg.col("temp") > float("nan")


def test_derivations_check_columns_and_track_kinds():
    daily = (
        hg.derive(READINGS)
        .filter(hg.col("temp") > 0)
        .calculate("f", hg.col("temp") * 1.8 + 32)
        .calculate("label", hg.when(hg.col("temp") > 15, "warm", "cool"))
        .bin("temp", step=10, name="band")
    )
    assert daily.columns["f"] == "number"
    assert daily.columns["label"] == "category"
    summary = daily.aggregate(by="site", n="count", mean=("temp", "mean"))
    assert summary.columns == {"site": "category", "n": "number", "mean": "number"}
    with pytest.raises(KeyError, match="filter: no column 'wind'"):
        hg.derive(READINGS).filter(hg.col("wind") > 0)
    with pytest.raises(TypeError, match="bin: column 'site' holds category"):
        hg.derive(READINGS).bin("site", step=1)
    with pytest.raises(ValueError, match="unknown operation 'avg'"):
        hg.derive(READINGS).aggregate(m=("temp", "avg"))
    with pytest.raises(ValueError, match="'mean' needs a column"):
        hg.derive(READINGS).aggregate(m="mean")
    with pytest.raises(ValueError, match="rolling size"):
        hg.derive(READINGS).rolling(0, m=("temp", "mean"))
    with pytest.raises(KeyError, match="no column 'temp'"):
        summary.sort("temp")


def test_charts_send_the_source_and_the_steps():
    totals = hg.derive(READINGS).aggregate(by="site", total=("temp", "sum"))
    chart = hg.Chart(totals, width=300, height=200).bar(x="site", y="total")
    spec, _ = chart.to_spec()
    # Only the columns the steps read travel; the rows are computed in the browser.
    assert sorted(spec["data"]["data"]["columns"]) == ["site", "temp"]
    assert spec["data"]["data2"] == {
        "source": "data",
        "transform": [
            {"aggregate": [{"op": "sum", "field": "temp", "as": "total"}], "groupby": ["site"]}
        ],
    }
    assert spec["marks"][0]["data"] == "data2"
    with pytest.raises(KeyError, match="no column 'temp'"):
        hg.Chart(totals).bar(x="site", y="temp")
    svg = chart.to_svg()
    assert svg.count("<path") >= 1 and "n" in svg and "s" in svg


def test_derivations_chain_and_pass_columns_through():
    warm = hg.derive(READINGS).filter(hg.col("temp") > 12)
    rolled = hg.derive(warm).rolling(2, by="site", avg=("temp", "mean")).sort("hour")
    spec, _ = hg.Chart(rolled).line(x="hour", y="avg", series="site").to_spec()
    # Columns marks read through the steps come from the source.
    assert sorted(spec["data"]["data"]["columns"]) == ["hour", "site", "temp"]
    assert spec["data"]["data3"]["source"] == "data2"
    assert spec["data"]["data2"]["transform"] == [{"filter": [">", ["field", "temp"], 12]}]


def test_live_charts_keep_derived_tables_and_point_appends_at_the_source():
    from herceg._live import LiveChart

    totals = hg.derive(READINGS).aggregate(by="site", total=("temp", "sum"))
    live = LiveChart(hg.Chart(totals).bar(x="site", y="total"))
    spec, _ = live.to_spec()
    assert "transform" in spec["data"]["data2"]
    with pytest.raises(ValueError, match="append to the source"):
        live.append({"site": ["n"], "total": [1.0]}, data=totals)
    message, _ = live.append({"site": ["e"], "temp": [5.0]}, data=READINGS)
    assert message["table"] == "data"


def test_review_fixes_hold():
    # Columns no step reads are never converted, so unsupported ones do no harm.
    data = {"x": np.array([1.0, 2.0, 3.0]), "blob": [{"a": 1}, {"b": 2}, {"c": 3}]}
    counted = hg.derive(data).aggregate(n="count")
    spec, _ = hg.Chart(counted, width=200, height=100).bar(x="n", y="n").to_spec()
    # A source the steps read nothing from still sends a column, keeping its rows.
    assert list(spec["data"]["data"]["columns"]) == ["x"]
    assert "<path" in hg.Chart(counted, width=200, height=100).bar(x="n", y="n").to_svg()
    # Expressions are typed as the chart's compiler types them.
    with pytest.raises(TypeError, match="filter needs a true or false condition"):
        hg.derive(READINGS).filter(hg.col("temp"))
    with pytest.raises(TypeError, match="branches give string and number"):
        hg.derive(READINGS).calculate("x", hg.when(hg.col("temp") > 1, "a", 1))
    with pytest.raises(TypeError, match="compares string with number"):
        hg.derive(READINGS).filter(hg.col("site") > 1)
    labels = hg.derive(READINGS).calculate("hot", hg.when(hg.col("temp") > 15, "hot", None))
    assert labels.columns["hot"] == "category"
    with pytest.raises(ValueError, match="bin count"):
        hg.derive(READINGS).bin("temp", count=0)


def _labelled(derived: hg.Derived, column: str) -> str:
    """SVG labelling each row with ``column``, as the chart's JavaScript computes it."""
    return hg.Chart(derived, width=200, height=100).text(x=0, y=0, text=column).to_svg()


def test_counts_keep_the_source_rows_through_calculated_columns():
    # The steps read only a column they made, yet the count needs the source's rows.
    ones = hg.derive({"x": [1, 2, 3]}).calculate("one", 1).aggregate(n=("one", "sum"))
    spec, _ = hg.Chart(ones).text(x=0, y=0, text="n").to_spec()
    assert list(spec["data"]["data"]["columns"]) == ["x"]
    assert ">3</text>" in _labelled(ones, "n")
    # A source column a step replaces is never converted, nor sent.
    data = {"blob": [{}, {}], "x": [1, 2]}
    replaced = hg.derive(data).calculate("blob", 1).aggregate(n=("blob", "sum"))
    spec, _ = hg.Chart(replaced).text(x=0, y=0, text="n").to_spec()
    assert list(spec["data"]["data"]["columns"]) == ["x"]
    assert ">2</text>" in _labelled(replaced, "n")
    doubled = hg.derive(data).calculate("blob", hg.col("x") * 2)
    spec, _ = hg.Chart(doubled).line(x="x", y="blob").to_spec()
    assert list(spec["data"]["data"]["columns"]) == ["x"]


def test_missing_branches_take_the_other_branch_type():
    data = {"x": [1.0, 2.0, 3.0]}
    for then, otherwise in ((None, "low"), ("low", None)):
        labels = hg.derive(data).calculate("label", hg.when(hg.col("x") > 1, then, otherwise))
        assert labels.columns["label"] == "category"
        assert ">low</text>" in _labelled(labels, "label")


def test_calculated_time_copies_are_numbers_as_in_the_chart():
    days = np.array(["2026-01-01", "2026-01-02", "2026-01-03"], dtype="datetime64[ms]")
    copied = hg.derive({"t": days, "y": [1.0, 2.0, 3.0]}).calculate("copy", hg.col("t"))
    assert copied.columns == {"t": "time", "y": "number", "copy": "number"}

    def axis(x: str) -> str:
        return hg.Chart(copied, width=400, height=200).line(x=x, y="y").to_svg()

    # The chart formats the time column's ticks as dates, and the copy's as numbers.
    assert "Jan 2" in axis("t")
    assert "Jan 2" not in axis("copy")


def test_membership_needs_literal_candidates():
    with pytest.raises(TypeError, match="'in' needs a value and at least one candidate"):
        hg.derive(READINGS).filter(hg.col("temp").is_in())
    with pytest.raises(TypeError, match="'in' candidates must be number literals"):
        hg.derive(READINGS).calculate("same", hg.col("temp").is_in(hg.col("hour")))
    # None is a candidate: it matches missing values.
    hg.derive(READINGS).filter(hg.col("site").is_in("n", None))


def test_bin_options_are_numbers_not_booleans():
    with pytest.raises(ValueError, match="bin step must be a positive number, not True"):
        hg.derive(READINGS).bin("temp", step=True)
    with pytest.raises(ValueError, match="bin start must be a finite number, not True"):
        hg.derive(READINGS).bin("temp", step=5, start=True)
    # NumPy numbers become JSON numbers.
    binned = hg.derive(READINGS).bin("temp", step=np.int64(5), start=np.float32(2.5))
    assert binned.steps[-1] == {"bin": "temp", "step": 5, "start": 2.5}
    json.dumps(binned.steps[-1])
