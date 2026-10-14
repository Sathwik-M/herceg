"""herceg.express charts made again from new data: ``hx.recompute`` and live widgets."""

import dataclasses

import numpy as np
import pytest

import herceg as hg
import herceg.express as hx
from herceg.express import _numerics as numerics

RNG = np.random.default_rng(11)
N = 200
DATA = {
    "day": RNG.choice(["thu", "fri", "sat"], N),
    "sex": RNG.choice(["f", "m"], N),
    "t": np.repeat(np.arange(20.0), 10),
    "x": RNG.uniform(0, 10, N),
    "tip": np.round(RNG.gamma(2.0, 1.5, N), 2),
}
DATA["y"] = 2 * DATA["x"] + RNG.normal(0, 2, N)


def head(data, n):
    return {name: values[:n] for name, values in data.items()}


def spec(chart):
    return chart.to_spec()[0]


def same_tables(a, b):
    first, second = hx.statistics(a).tables, hx.statistics(b).tables
    assert first.keys() == second.keys()
    for name in first:
        for column in first[name]:
            left, right = np.asarray(first[name][column]), np.asarray(second[name][column])
            if left.dtype == object:
                assert list(left) == list(right)
            else:
                assert np.array_equal(left, right, equal_nan=True), (name, column)


# hx.recompute ------------------------------------------------------------------------


@pytest.mark.parametrize(
    "make",
    [
        lambda d: hx.barplot(d, x="day", y="tip", series="sex"),
        lambda d: hx.lineplot(d, x="t", y="tip", n_boot=200),
        lambda d: hx.regplot(d, x="x", y="y", series="sex", n_boot=200),
        lambda d: hx.histplot(d, x="tip", series="sex", kde=True),
        lambda d: hx.stripplot(d, x="day", y="tip"),
        lambda d: hx.boxenplot(d, x="day", y="tip"),
        lambda d: hx.ecdfplot(d, x="tip"),
    ],
)
def test_a_recomputed_chart_is_the_function_called_again_on_the_new_data(make):
    first = make(head(DATA, 120))
    again = hx.recompute(first, DATA)
    fresh = make(DATA)
    assert spec(again) == spec(fresh)
    same_tables(again, fresh)
    # Recomputing again from the first data gives the first chart back.
    assert spec(hx.recompute(again, head(DATA, 120))) == spec(first)


def test_a_drawn_seed_is_kept_and_options_are_copied_when_the_call_is_made():
    palette = ["#111111", "#222222"]
    first = hx.barplot(DATA, x="day", y="tip", series="sex", seed=None, palette=palette)
    seed = hx.statistics(first).seed
    palette.append("#333333")
    again = hx.recompute(first, DATA)
    assert hx.statistics(again).seed == seed
    assert spec(again)["theme"]["palette"] == ["#111111", "#222222"]
    same_tables(again, first)
    # Option objects too: a jitter's seed, an axis' title.
    jitter, axis = hg.Jitter(width=0.2, seed=7), hg.Axis(title="Tip")
    strip = hx.stripplot(DATA, x="day", y="tip", jitter=jitter, y_axis=axis)
    jitter.width, jitter.seed, axis.title = 0.8, 99, "Changed"
    again = spec(hx.recompute(strip, DATA))
    assert again["marks"][0]["jitter"] == {"width": 0.2, "seed": 7}
    assert again["y"]["title"] == "Tip"


def test_arguments_keep_the_objects_they_name():
    import threading

    lock = threading.Lock()
    events = {"day": ["thu"], "tip": [3.0]}
    binding = hg.SelectionBinding("focus", data=events)

    def median(values):
        with lock:  # an object that cannot be copied
            return float(np.median(values))

    first = hx.barplot(
        DATA, x="day", y="tip", estimator=median, errorbar=None, row_selection=binding
    ).point("day", "tip", data=events)
    again = hx.recompute(first, head(DATA, 100))
    assert again.to_spec()[0]["rowSelection"]["data"] == "data2"

    # A function that is a dataclass is the same function.
    @dataclasses.dataclass
    class Shifted:
        offset: float = 0.0

        def __call__(self, values):
            return float(np.mean(values)) + self.offset

    shifted = Shifted()
    chart = hx.barplot(DATA, x="day", y="tip", estimator=shifted, errorbar=None)
    shifted.offset = 10.0
    later = hx.statistics(hx.recompute(chart, DATA)).tables["estimates"]["tip"]
    assert np.allclose(later, hx.statistics(chart).tables["estimates"]["tip"] + 10)


def test_marks_added_to_the_chart_are_added_again():
    events = {"x": [2.0, 8.0], "label": ["start", "stop"]}
    first = (
        hx.regplot(head(DATA, 100), x="x", y="y")
        .rule(y=0, label="zero")
        .rule(x="x", data=events)
        .line("x", "y", label="fit again")
    )
    again = hx.recompute(first, DATA)
    kinds = [mark["type"] for mark in spec(again)["marks"]]
    assert kinds == ["point", "area", "line", "rule", "rule", "line"]
    # The added line reads the new chart's table; the rules their own data.
    assert spec(again)["marks"][5]["data"] == spec(again)["marks"][0]["data"]
    assert len(hx.statistics(again).tables["fit"]["x"]) == 100
    assert np.frombuffer(again.to_spec()[1][0], dtype="<f8").size == N


def test_pairplot_keeps_the_columns_it_paired():
    first = hx.pairplot({"a": DATA["x"], "b": DATA["y"]})
    again = hx.recompute(first, {"a": DATA["x"], "b": DATA["y"], "c": DATA["tip"]})
    assert spec(again)["panels"] == spec(first)["panels"]


def test_recompute_refuses_charts_express_did_not_make():
    with pytest.raises(ValueError, match="hx.recompute: the chart was not made by"):
        hx.recompute(hg.Chart(DATA).bar(x="day", y="tip"), DATA)


def test_groups_whose_values_are_unchanged_reuse_their_bootstrap_results(monkeypatch):
    calls = []
    interval = numerics.interval

    def counted(values, *args, **kwargs):
        calls.append(len(values))
        return interval(values, *args, **kwargs)

    monkeypatch.setattr(numerics, "interval", counted)
    first = hx.lineplot(DATA, x="t", y="tip", n_boot=100)
    assert len(calls) == 20
    calls.clear()
    # A new timepoint: only its group is resampled.
    later = {name: np.concatenate([values, values[:10]]) for name, values in DATA.items()}
    later["t"][-10:] = 20.0
    later["tip"][-10:] += 0.5
    again = hx.recompute(first, later)
    assert calls == [10]
    estimates = hx.statistics(again).tables["estimates"]
    fresh = hx.statistics(hx.lineplot(later, x="t", y="tip", n_boot=100)).tables["estimates"]
    assert np.array_equal(estimates["low"], fresh["low"])
    # Groups that left are forgotten: only the one kept is not resampled again.
    calls.clear()
    hx.recompute(hx.recompute(first, head(DATA, 10)), DATA)
    assert len(calls) == 19


def test_regression_bands_are_reused_only_over_the_same_grid(monkeypatch):
    calls = []
    from herceg.express import _regression as regression

    bootstrap = regression.bootstrap

    def counted(x, *args, **kwargs):
        calls.append(len(x))
        return bootstrap(x, *args, **kwargs)

    monkeypatch.setattr(regression, "bootstrap", counted)
    data = {**DATA, "y": DATA["y"]}
    first = hx.regplot(data, x="x", y="y", series="sex", n_boot=50)
    calls.clear()
    hx.recompute(first, data)
    assert calls == []
    # Without truncation, a series' grid spans all the data's x: a row of the
    # other series moves it, and both bands are computed again.
    wide = hx.regplot(data, x="x", y="y", series="sex", n_boot=50, truncate=False)
    calls.clear()
    more = {name: np.append(values, values[0]) for name, values in data.items()}
    more["x"][-1] = 11.0
    hx.recompute(wide, more)
    assert len(calls) == 2


# Live widgets ------------------------------------------------------------------------

pytest.importorskip("anywidget")


class Browser:
    """Records what the widget sends over its comm."""

    def __init__(self, widget):
        self.sent = []
        widget.comm.send = lambda data=None, buffers=None, **_: self.sent.append((data, buffers))

    @property
    def messages(self):
        return [
            (data["content"], buffers) for data, buffers in self.sent if data["method"] == "custom"
        ]

    @property
    def resent(self):
        return [
            data["state"]["_chart"]["revision"]
            for data, _ in self.sent
            if data["method"] == "update" and "_chart" in data["state"]
        ]


def test_appending_to_an_express_widget_computes_its_statistics_again():
    pd = pytest.importorskip("pandas")
    frame = pd.DataFrame(head(DATA, 120))
    live = hx.barplot(frame, x="day", y="tip", series="sex", seed=3).widget()
    browser = Browser(live)
    # Later changes to the caller's dataframe are not the widget's.
    frame.loc[0, "tip"] = 1000.0
    live.update(title="Tips, live")
    rest = pd.DataFrame(DATA).iloc[120:]
    live.append(rest)
    content, buffers = browser.messages[-1]
    assert content["type"] == "tables" and list(content["tables"]) == ["data"]
    expected = hx.barplot(DATA, x="day", y="tip", series="sex", seed=3, title="Tips, live")
    expected_spec, expected_buffers = expected.to_spec()
    columns = content["tables"]["data"]
    low = np.frombuffer(buffers[columns["low"]["buffer"]], dtype="<f8")
    expected_low = np.frombuffer(
        expected_buffers[expected_spec["data"]["data"]["columns"]["low"]["buffer"]], dtype="<f8"
    )
    assert np.array_equal(low, expected_low)
    # The option update stays; the description says what was computed now.
    snapshot = live._snapshot()["spec"]
    assert snapshot["title"] == "Tips, live"
    assert snapshot["description"] == expected_spec["description"]
    live.append(rest.iloc[:5], max_rows=50)
    assert hx.statistics(live._express.chart).tables["estimates"]["n"].sum() == 50


def test_appends_from_several_threads_all_take_part():
    import threading

    live = hx.barplot(head(DATA, 40), x="day", y="tip", errorbar=None).widget()
    Browser(live)
    threads = [
        threading.Thread(target=live.append, args=({"day": "thu", "tip": 1.0},)) for _ in range(8)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert hx.statistics(live._express.chart).tables["estimates"]["n"].sum() == 48


def test_a_recomputed_chart_with_other_marks_is_sent_whole():
    live = hx.lineplot(head(DATA, 30), x="t", y="tip", series="sex", n_boot=50).widget()
    browser = Browser(live)
    # A series level more: its band is a mark more.
    more = {name: values.copy() for name, values in head(DATA, 60).items()}
    more["sex"] = np.where(np.arange(60) < 50, more["sex"], "x")
    live.replace(more)
    content, buffers = browser.messages[-1]
    assert content["type"] == "chart" and content["revision"] == 1
    assert len(content["spec"]["marks"]) == 4 and buffers
    assert browser.resent == [] and live._snapshot()["spec"] == content["spec"]


def test_a_recompute_keeps_moves_of_the_nodes_its_new_tables_still_have():
    # Express functions draw no networks; a stand-in function making one
    # shows how both ways of sending a recomputed chart treat moved nodes.
    links = {"source": ["a", "b"], "target": ["b", "c"]}
    live = hg.graph(links, "source", "target", drag=True).widget()

    class Remade:
        call = None

        def __init__(self, chart):
            self.chart = chart

        def make(self, columns):
            directed = columns.pop("directed", None)
            return hg.graph(columns, "source", "target", drag=True, directed=directed)

        def keep(self, columns, chart):
            self.chart = chart

        def replaced(self, rows):
            return rows

    live._express = Remade(live)
    browser = Browser(live)
    # New links (their table replaced in place: b's move goes, a's stays),
    # then a chart whose mark differs (sent whole: every move goes).
    for rows, sent, kept in (
        ({"source": ["a"], "target": ["c"]}, "tables", {'[0,"a"]': (1.0, 2.0)}),
        ({**links, "directed": True}, "chart", {}),
    ):
        live.item_positions = {'[0,"a"]': (1.0, 2.0), '[0,"b"]': (3.0, 4.0)}
        reported = []
        live.on_item_move(reported.append)
        live.replace(rows)
        live.on_item_move(reported.append, remove=True)
        assert sent in [content["type"] for content, _ in browser.messages]
        assert dict(live.item_positions) == kept and len(reported) == 1


def test_express_widgets_refuse_tables_by_data_and_change_nothing_on_failure():
    live = hx.regplot(head(DATA, 50), x="x", y="y", n_boot=50).widget()
    browser = Browser(live)
    with pytest.raises(ValueError, match="widget.append data: the regplot chart is computed from"):
        live.append(head(DATA, 5), data=DATA)
    with pytest.raises(KeyError, match="widget.append rows: no column 'y'"):
        live.append({"x": [1.0]})
    before = live._snapshot()
    with pytest.raises(TypeError, match="widget.replace rows: column 'x' holds category values"):
        live.replace({"x": ["a"], "y": [1.0]})
    assert live._snapshot() == before and browser.messages == []
    # One row appended as a mapping of values.
    live.append({"x": 5.0, "y": 10.0})
    assert len(hx.statistics(live._express.chart).tables["fit"]["x"]) == 100


# Streamlit reruns ---------------------------------------------------------------------


def test_a_rerun_of_the_same_call_sends_the_same_chart():
    """Streamlit leaves a chart as it is, zoom and brush included, when a run
    sends the same bytes: an express call on the same data, with its default
    seed, makes the same chart every run."""
    hst = pytest.importorskip("herceg.streamlit")

    def payload():
        spec, buffers = hx.barplot(DATA, x="day", y="tip", series="sex").to_spec()
        return hst._payload(spec, buffers, [])

    assert payload() == payload()
