"""Financial charts: time axis breaks, OHLC bars, and crosshair labels."""

import datetime as dt
import re

import numpy as np
import pytest

import herceg as hg

PRICES = {
    # Thursday, Friday, Monday, Tuesday.
    "day": np.array(
        ["2025-10-09", "2025-10-10", "2025-10-13", "2025-10-14"], dtype="datetime64[ms]"
    ),
    "o": [10.0, 12.0, 9.0, 9.5],
    "h": [13.0, 12.5, 9.5, 11.0],
    "l": [9.0, 8.0, 8.5, 9.0],
    "c": [12.0, 9.0, 9.0, 10.5],
}


def test_breaks_travel_in_the_x_axis_spec():
    x = hg.Axis(
        breaks=[
            hg.Break(weekdays=("sat", "sun")),
            hg.Break(hours=("16:00", dt.time(9, 30))),
            hg.Break(dates=[dt.date(2025, 12, 25), "2026-01-01"]),
            hg.Break(start=dt.datetime(2025, 11, 28, 18), end=dt.datetime(2025, 12, 1, 14, 30)),
            {"from": 0, "to": 1000},
        ]
    )
    chart = hg.Chart(PRICES, x=x, time_zone="America/New_York").candlestick(
        "day", "o", "h", "l", "c"
    )
    spec, _ = chart.to_spec()
    assert spec["version"] == 3
    assert spec["x"] == {
        "breaks": [
            {"weekdays": ["sat", "sun"]},
            {"hours": ["16:00", "09:30"]},
            {"dates": ["2025-12-25", "2026-01-01"]},
            {"from": 1764352800000, "to": 1764599400000},
            {"from": 0, "to": 1000},
        ]
    }


def test_breaks_reach_panels_with_time_axes_of_their_own():
    chart = hg.Chart(
        PRICES,
        x=hg.Axis(type="linear", breaks=[hg.Break(weekdays=("sat", "sun"))]),
        panels=[hg.Panel("series", x=hg.Axis(type="time")), "spread"],
        resolve_x="independent",
    )
    chart.line(x="day", y="c", panel="series").line(x="o", y="c", panel="spread")
    spec, _ = chart.to_spec()
    assert spec["x"]["breaks"] == [{"weekdays": ["sat", "sun"]}]
    assert "<svg" in chart.to_svg()


def test_dates_of_the_first_century_keep_their_year():
    assert hg.Break(dates=[dt.date(99, 1, 1)])._spec() == {"dates": ["0099-01-01"]}


def test_breaks_are_checked():
    with pytest.raises(ValueError, match="weekdays must be names"):
        hg.Axis(breaks=[hg.Break(weekdays=["saturday"])])._spec()
    with pytest.raises(ValueError, match="one of weekdays, hours, dates, or start and end"):
        hg.Axis(breaks=[hg.Break(weekdays=["sat"], hours=("16:00", "09:30"))])._spec()
    with pytest.raises(ValueError, match="whole minutes"):
        hg.Axis(breaks=[hg.Break(hours=(dt.time(16, 0, 30), "09:30"))])._spec()
    with pytest.raises(ValueError, match="pass a date"):
        hg.Axis(breaks=[hg.Break(dates=[dt.datetime(2025, 12, 25)])])._spec()
    with pytest.raises(ValueError, match="end after it starts"):
        hg.Axis(breaks=[hg.Break(start=10, end=10)])._spec()
    with pytest.raises(ValueError, match="whole millisecond"):
        hg.Axis(breaks=[hg.Break(start=0.5, end=10)])._spec()
    with pytest.raises(ValueError, match="for the chart's x axis only, not y"):
        hg.Chart(PRICES, y=hg.Axis(breaks=[hg.Break(weekdays=["sat"])]))
    with pytest.raises(ValueError, match="a break has weekdays"):
        hg.Axis(breaks=[{"weekend": True}])._spec()
    # The engine reads hours itself: a time it cannot read is refused when drawn.
    unreadable = hg.Axis(breaks=[{"hours": ["25:00", "09:30"]}])
    chart = hg.Chart(PRICES, x=unreadable).candlestick("day", "o", "h", "l", "c")
    with pytest.raises(Exception, match=r"breaks\[0\]\.hours\[0\]"):
        chart.to_svg()


def test_weekends_take_no_room_in_svg():
    # Every candle falls, so each draws one wick, at its center.
    falling = {**PRICES, "o": [12.0, 12.0, 12.0, 12.0], "c": [10.0, 10.0, 10.0, 10.0]}

    def centers(chart):
        svg = chart.to_svg()
        wicks = re.findall(r"M([\d.]+) [\d.]+L([\d.]+) [\d.]+", svg)
        return sorted({float(a) for a, b in wicks if a == b})

    weekend = hg.Axis(breaks=[hg.Break(weekdays=("sat", "sun"))])
    size = {"time_zone": "UTC", "width": 400, "height": 200}
    plain = hg.Chart(falling, **size).candlestick("day", "o", "h", "l", "c")
    broken = hg.Chart(falling, x=weekend, **size).candlestick("day", "o", "h", "l", "c")
    gaps = np.diff(centers(broken))
    assert len(gaps) == 3
    # With the weekend left out, Friday to Monday is as far as Thursday to Friday.
    assert np.allclose(gaps, gaps[0], atol=0.2)
    plain_gaps = np.diff(centers(plain))
    assert plain_gaps[1] > 2 * plain_gaps[0]


def test_ohlc_bars_and_crosshair_labels():
    spec, _ = hg.candlestick(PRICES, "day", "o", "h", "l", "c", variant="ohlc").to_spec()
    assert spec["marks"][0]["variant"] == "ohlc"
    with pytest.raises(ValueError, match="variant must be"):
        hg.Chart(PRICES).candlestick("day", "o", "h", "l", "c", variant="bars")
    svg = hg.candlestick(PRICES, "day", "o", "h", "l", "c", variant="ohlc").to_svg()
    assert "<path" in svg
    labeled, _ = (
        hg.Chart(PRICES, tooltip=hg.Tooltip(axis_labels=True)).line(x="day", y="c").to_spec()
    )
    assert labeled["tooltip"] == {"axisLabels": True}
    both, _ = (
        hg.Chart(PRICES, tooltip=hg.Tooltip(mode="nearest", axis_labels=True))
        .line(x="day", y="c")
        .to_spec()
    )
    assert both["tooltip"] == {"mode": "nearest", "axisLabels": True}
    mode, _ = hg.Chart(PRICES, tooltip="nearest").line(x="day", y="c").to_spec()
    assert mode["tooltip"] == {"mode": "nearest"}
