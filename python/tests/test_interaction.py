"""Gesture bindings, view limits, and sync channels: their spec, and what they refuse."""

import datetime as dt

import numpy as np
import pytest

import herceg as hg

DATA = {
    "t": np.array(["2026-01-01T00:00", "2026-01-01T01:00"], dtype="datetime64[ms]"),
    "v": np.array([1.0, 2.0]),
}


def interaction(**options):
    spec, _ = hg.Chart(DATA, **options).line(x="t", y="v").to_spec()
    return spec.get("interaction")


def test_pan_presets_and_bindings():
    assert interaction(pan="x") == {"pan": "x"}
    assert interaction(zoom="x", pan=False) == {"zoom": "x", "pan": False}
    bound = interaction(
        bindings=[
            hg.Binding(hg.WheelGesture(focused=True), hg.ZoomAction("x")),
            hg.Binding(hg.DragGesture(pointer="touch"), hg.CursorAction()),
            hg.Binding(hg.KeyGesture("ArrowLeft", modifiers=["alt"]), hg.PanAction(step=(-0.1, 0))),
            hg.Binding(hg.WheelGesture(axis="x"), hg.PageScrollAction()),
        ]
    )
    assert bound == {
        "bindings": [
            {
                "gesture": {"type": "wheel", "focused": True},
                "action": {"type": "zoom", "axes": "x"},
            },
            {"gesture": {"type": "drag", "pointer": "touch"}, "action": {"type": "cursor"}},
            {
                "gesture": {"type": "key", "key": "ArrowLeft", "modifiers": ["alt"]},
                "action": {"type": "pan", "step": [-0.1, 0.0]},
            },
            {"gesture": {"type": "wheel", "axis": "x"}, "action": {"type": "pageScroll"}},
        ]
    }


def test_bindings_refuse_what_charts_refuse():
    twice = hg.Binding(hg.WheelGesture(modifiers=["ctrl", "alt"]), hg.ZoomAction())
    again = hg.Binding(hg.WheelGesture(modifiers=["alt", "ctrl"]), hg.PanAction())
    with pytest.raises(ValueError, match=r"Chart bindings\[1\]: duplicates binding 0"):
        hg.Chart(DATA, bindings=[twice, again])
    with pytest.raises(ValueError, match="moves the keyboard cursor"):
        hg.Chart(DATA, bindings=[hg.Binding(hg.KeyGesture("Home"), hg.ResetAction())])
    with pytest.raises(TypeError, match=r"Chart bindings\[0\] action: a WheelGesture performs"):
        hg.Chart(DATA, bindings=[hg.Binding(hg.WheelGesture(), hg.BrushAction())])
    # No keys held, said either way, is one gesture, as the browser reads it.
    bare = hg.Binding(hg.WheelGesture(axis="y"), hg.ZoomAction())
    empty = hg.Binding(hg.WheelGesture(axis="y", modifiers=[]), hg.PanAction())
    with pytest.raises(ValueError, match=r"Chart bindings\[1\]: duplicates binding 0"):
        hg.Chart(DATA, bindings=[bare, empty])
    assert interaction(bindings=[empty]) == {
        "bindings": [{"gesture": {"type": "wheel", "axis": "y"}, "action": {"type": "pan"}}]
    }
    # True is not the button 1 it equals, nor a flag a number.
    with pytest.raises(ValueError, match=r"button: expected 0, 1, or 2; received True"):
        hg.Chart(DATA, bindings=[hg.Binding(hg.DragGesture(button=True), hg.PanAction())])
    with pytest.raises(TypeError, match="focused: expected True or False; received 1"):
        hg.Chart(DATA, bindings=[hg.Binding(hg.WheelGesture(focused=1), hg.ZoomAction())])
    rows = hg.SelectionBinding("focus")
    with pytest.raises(ValueError, match="brushes select rows for row_selection"):
        hg.Chart(
            DATA,
            bindings=[hg.Binding(hg.DragGesture(), hg.BrushAction("x", zoom=True))],
            row_selection=rows,
        )


def test_limits_take_numbers_datetimes_and_open_ends():
    start = dt.datetime(2026, 1, 1)
    assert interaction(pan="x", limits={"x": hg.ViewLimits(extent=(start, None), edge=True)}) == {
        "pan": "x",
        "limits": {"x": {"extent": [1767225600000.0, None], "edge": True}},
    }
    assert interaction(
        limits={"y_right": hg.ViewLimits(extent=(0, 10), edge=hg.Edge(threshold=0.2))}
    ) == {
        "limits": {
            "yRight": {"extent": [0.0, 10.0], "edge": {"threshold": 0.2, "hysteresis": 0.05}}
        }
    }
    with pytest.raises(ValueError, match="Chart limits x extent: expected two ends, ascending"):
        hg.Chart(DATA, limits={"x": hg.ViewLimits(extent=(10, 0))})
    with pytest.raises(
        ValueError, match='Chart limits: expected the scales "x", "y", or "y_right"'
    ):
        hg.Chart(DATA, limits={"z": hg.ViewLimits()})


def test_sync_channels():
    assert interaction(sync="ops") == {"sync": "ops"}
    assert interaction(sync=hg.Sync(cursor="ops", viewport=hg.SyncChannel("ops", scale="y"))) == {
        "sync": {"cursor": "ops", "viewport": {"group": "ops", "scale": "y"}}
    }
    with pytest.raises(ValueError, match='Chart sync viewport scale: expected "x" or "y"'):
        hg.Chart(DATA, sync=hg.Sync(viewport=hg.SyncChannel("ops", scale="xy")))


def test_charts_with_bindings_limits_and_sync_render():
    chart = hg.Chart(
        DATA,
        pan="x",
        bindings=[hg.Binding(hg.PinchGesture(), hg.ZoomAction())],
        limits={"x": hg.ViewLimits(extent=(dt.datetime(2026, 1, 1), None), edge=True)},
        sync=hg.Sync(cursor="ops"),
    ).line(x="t", y="v")
    assert chart.to_svg().startswith("<svg")


def test_layout_marks_refuse_what_they_cannot_take():
    shares = {"region": ["a", "b"], "value": [1.0, 2.0]}
    with pytest.raises(ValueError, match="Chart pan: a pie has no x axis to act on"):
        hg.Chart(shares, pan="x").pie("region", "value")
    with pytest.raises(ValueError, match="Chart limits: a pie has no x axis to act on"):
        hg.Chart(shares, limits={"x": hg.ViewLimits(extent=(0, 1))}).pie("region", "value")


def test_cursors_snap_and_show_tooltips_across_charts_and_panels():
    cursor = hg.SyncChannel("ops", snap="previous", tooltip=True)
    assert interaction(sync=hg.Sync(cursor=cursor, panels=False)) == {
        "sync": {"cursor": {"group": "ops", "snap": "previous", "tooltip": True}, "panels": False}
    }
    assert interaction(sync=hg.Sync(panels=hg.SyncChannel(snap="next"))) == {
        "sync": {"panels": {"snap": "next"}}
    }
    with pytest.raises(ValueError, match="snap and tooltip are how a cursor shows"):
        hg.Chart(DATA, sync=hg.Sync(viewport=hg.SyncChannel("ops", snap="previous")))
    with pytest.raises(ValueError, match="drop group and scale"):
        hg.Chart(DATA, sync=hg.Sync(panels=hg.SyncChannel("ops")))
    with pytest.raises(ValueError, match='snap: expected .*received "later"'):
        hg.Chart(DATA, sync=hg.Sync(cursor=hg.SyncChannel("ops", snap="later")))
    with pytest.raises(ValueError, match="expected a group's name"):
        hg.Chart(DATA, sync=hg.Sync(cursor=hg.SyncChannel(snap="previous")))


def test_panels_of_their_own_data_share_the_cursor_when_asked():
    import pandas as pd

    minutes = pd.date_range("2026-01-01", periods=120, freq="min")
    hours = pd.date_range("2025-12-31", periods=48, freq="h")
    df = pd.concat(
        [
            pd.DataFrame({"time": minutes, "v": np.arange(120.0), "p": "minute"}),
            pd.DataFrame({"time": hours, "v": np.arange(48.0), "p": "hour"}),
        ]
    )
    chart = (
        hg.Chart(
            df,
            panels=["minute", "hour"],
            x=hg.AxisOptions(scope="panel"),
            sync=hg.Sync(panels=hg.SyncChannel(snap="previous", tooltip=True)),
        )
        .line(x="time", y="v", panel="minute", data=hg.derive(df).filter(hg.col("p") == "minute"))
        .line(x="time", y="v", panel="hour", data=hg.derive(df).filter(hg.col("p") == "hour"))
    )
    spec, _ = chart.to_spec()
    assert spec["interaction"]["sync"] == {"panels": {"snap": "previous", "tooltip": True}}
    assert chart.to_svg().startswith("<svg")
