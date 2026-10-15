"""Snapshots: charts rendered for a page to show and a browser to hydrate."""

import json

import pytest

import herceg as hg

pytest.importorskip("py_mini_racer")


def chart():
    return hg.Chart({"x": [1.0, 2.0, 3.0], "y": [3.0, 1.0, 2.0]}, title="Sales").line(x="x", y="y")


def test_snapshots_are_json_with_the_runtime_markup():
    snapshot = chart().to_snapshot(id_prefix="sales", width=480, height=240)
    assert json.loads(json.dumps(snapshot)) == snapshot
    assert snapshot["version"] == 1
    assert (snapshot["width"], snapshot["height"]) == (480, 240)
    assert (snapshot["locale"], snapshot["timeZone"], snapshot["measure"]) == (
        "en-US",
        "UTC",
        "estimate",
    )
    assert snapshot["html"].startswith('<div data-herceg="sales"')
    assert 'aria-label="Sales"' in snapshot["html"]
    assert 'id="sales-description"' in snapshot["html"]
    # The same chart writes the same markup.
    assert chart().to_snapshot(id_prefix="sales", width=480, height=240) == snapshot


def test_snapshots_keep_the_charts_locale_and_take_their_own_where_it_has_none():
    zoned = hg.Chart({"x": [1.0, 2.0]}, time_zone="Europe/Paris").line(x="x", y="x")
    assert zoned.to_snapshot(id_prefix="z", time_zone="UTC")["timeZone"] == "Europe/Paris"
    assert chart().to_snapshot(id_prefix="z", locale="de-DE")["locale"] == "de-DE"


def test_snapshots_refuse_what_browsers_cannot_share():
    with pytest.raises(ValueError, match="to_snapshot id_prefix: expected a name that starts ids"):
        chart().to_snapshot(id_prefix="1 bad")
    with pytest.raises(ValueError, match='to_snapshot time_zone: "local" is this machine'):
        chart().to_snapshot(id_prefix="a", time_zone="local")
    with pytest.raises(ValueError, match="to_snapshot width: expected a size in CSS pixels"):
        chart().to_snapshot(id_prefix="a", width=0)
