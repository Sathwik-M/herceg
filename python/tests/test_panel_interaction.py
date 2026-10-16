"""Maps, networks, and trees in facets and subplots: what charts take, and the
interaction state live charts keep per subplot."""

from datetime import datetime

import pytest

import herceg as hg
from herceg._events import decode_selection, encode_selection
from herceg._live import _scale_groups

SALES = {
    "year": ["2023", "2023", "2024", "2024"],
    "region": ["Europe", "Asia", "Europe", "Asia"],
    "country": ["France", "Japan", "Spain", "India"],
    "revenue": [40.0, 30.0, 20.0, 60.0],
}
LINKS = {
    "year": ["2023", "2023", "2024"],
    "source": ["a", "b", "a"],
    "target": ["b", "c", "c"],
}
SQUARE = {
    "type": "FeatureCollection",
    "features": [
        {
            "type": "Feature",
            "properties": {"name": name, "year": year},
            "geometry": {
                "type": "Polygon",
                "coordinates": [[[x, 0], [x + 10, 0], [x + 10, 10], [x, 10], [x, 0]]],
            },
        }
        for name, year, x in (("A", "2023", 0), ("B", "2024", 20))
    ],
}
CITIES = {"lon": [5.0, 25.0], "lat": [5.0, 5.0], "year": ["2023", "2024"]}


def test_maps_split_their_layers_in_facets_or_repeat_them():
    chart = (
        hg.Chart(CITIES, facet="year", zoom=True, brush="lasso")
        .geoshape(data=SQUARE, label_field="name", facet="repeat")
        .geopoint("lon", "lat")
    )
    spec, _ = chart.to_spec()
    assert [mark.get("facet") for mark in spec["marks"]] == ["repeat", None]
    assert spec["interaction"] == {"zoom": True, "brush": "lasso"}
    assert chart.to_svg().count("<path") > 0
    with pytest.raises(ValueError, match="geoshape facet: every layer of the map repeats"):
        hg.Chart(CITIES, facet="year").geoshape(data=SQUARE, facet="repeat").to_spec()


def test_maps_and_networks_fill_subplots_of_their_own():
    chart = (
        hg.Chart(CITIES, panels=["map", "net"], layout=hg.Grid(columns=2), zoom=True, drag=True)
        .geoshape(data=SQUARE, panel="map")
        .geopoint("lon", "lat", panel="map")
        .graph("source", "target", data=LINKS, panel="net")
    )
    spec, _ = chart.to_spec()
    assert [mark["panel"] for mark in spec["marks"]] == ["map", "map", "net"]
    # Panels drawing only maps and networks pan and zoom them both ways, and lasso them.
    lassoed = (
        hg.Chart(CITIES, panels=["a", "b"], zoom="xy", brush="lasso")
        .geopoint("lon", "lat", panel="a")
        .geopoint("lon", "lat", panel="b")
    )
    assert lassoed.to_spec()[0]["interaction"] == {"zoom": "xy", "brush": "lasso"}
    beside = (
        hg.Chart(CITIES, panels=["line", "map"], brush="lasso")
        .line("lon", "lat", panel="line")
        .geopoint("lon", "lat", panel="map")
    )
    with pytest.raises(ValueError, match="Chart brush: panels with axes brush along x only"):
        beside.to_spec()
    with pytest.raises(ValueError, match='geopoint panel: a pie has panel "a" to itself'):
        hg.Chart(SALES, panels=["a"]).pie("region", panel="a").geopoint(
            "lon", "lat", data=CITIES, panel="a"
        )


def test_panels_without_axes_refuse_scoping_scales():
    message = "Chart x scope: every panel draws a geopoint or another mark without axes"
    with pytest.raises(ValueError, match=message):
        hg.Chart(CITIES, panels=["a"], x=hg.AxisOptions(scope="panel")).geopoint(
            "lon", "lat", panel="a"
        ).to_spec()
    with pytest.raises(ValueError, match="Chart y scope: every panel draws a geoshape"):
        hg.Chart(CITIES, facet="year", y=hg.AxisOptions(scope="panel")).geoshape(
            data=SQUARE, facet="repeat"
        ).geopoint("lon", "lat").to_spec()
    # Shared, as the panels' scales would be, they take.
    shared = hg.Chart(CITIES, panels=["a"], x=hg.AxisOptions(scope="chart")).geopoint(
        "lon", "lat", panel="a"
    )
    assert shared.to_spec()[0]["x"] == {"scope": "chart"}
    # Beside panels with axes, those scales are scoped.
    beside = (
        hg.Chart(CITIES, panels=["line", "map"], y=hg.AxisOptions(scope="panel"))
        .line("lon", "lat", panel="line")
        .geopoint("lon", "lat", panel="map")
    )
    assert beside.to_spec()[0]["y"] == {"scope": "panel"}


def test_trees_in_facets_drill_and_select_rows():
    chart = hg.Chart(
        SALES, facet="year", zoom=True, row_selection=hg.SelectionBinding("picked")
    ).treemap(["region", "country"], "revenue")
    spec, _ = chart.to_spec()
    assert spec["interaction"] == {"zoom": True}
    with pytest.raises(ValueError, match="Chart zoom: a treemap drills with zoom=True"):
        hg.Chart(SALES, facet="year", zoom="x").treemap(["region"])


def test_a_lasso_names_the_subplot_it_is_drawn_in():
    selection = hg.Selection(lasso=((0.0, 0.0), (1.0, 0.0), (1.0, 1.0)), panels=("map",))
    encoded = encode_selection(selection)
    assert encoded is not None and encoded["panels"] == ["map"]
    assert decode_selection(encoded) == selection
    with pytest.raises(ValueError, match="Selection panels: expected a tuple of panel ids"):
        encode_selection(hg.Selection(lasso=selection.lasso, panels=("map", 1)))  # type: ignore[arg-type]


pytest.importorskip("anywidget")


class Browser:
    """Records what a widget sends, and replies as a browser would."""

    def __init__(self, widget):
        self.widget = widget
        self.sent = []
        widget.comm.send = lambda data=None, buffers=None, **_: self.sent.append((data, buffers))

    def reply(self, content):
        self.widget._handle_custom_msg(content, [])

    @property
    def messages(self):
        return [data["content"] for data, _ in self.sent if data["method"] == "custom"]


def two_trees():
    return (
        hg.Chart(SALES, panels=["a", "b"], zoom=True)
        .treemap(["region", "country"], "revenue", panel="a")
        .sunburst(["region"], "revenue", panel="b")
        .widget()
    )


def test_widgets_keep_each_subplot_trees_root():
    widget = two_trees()
    browser = Browser(widget)
    assert widget.panel_drill_roots == {"a": None, "b": None}
    with pytest.raises(ValueError, match="widget.drill_root: the chart's treemap or sunburst"):
        _ = widget.drill_root
    heard = {"a": [], "b": []}
    widget.on_drill(heard["a"].append, panel="a")
    widget.on_drill(heard["b"].append, panel="b")
    widget.panel_drill_roots = {"b": ('[1,"Asia"]',)}
    assert widget.panel_drill_roots == {"a": None, "b": ('[1,"Asia"]',)}
    assert browser.messages[-1] == {
        "type": "drill",
        "drill_root": {"path": ['[1,"Asia"]']},
        "panel": "b",
        "revision": 1,
    }
    # The browser drills the other one.
    browser.reply(
        {"type": "drill", "drill_root": {"path": ['[0,"Europe"]']}, "panel": "a", "revision": 1}
    )
    assert heard == {"a": [('[0,"Europe"]',)], "b": [('[1,"Asia"]',)]}
    # A panel without a tree of its own, and its callbacks, are refused.
    with pytest.raises(ValueError, match="widget.panel_drill_roots: no panel 'c' of its kind"):
        widget.panel_drill_roots = {"c": None}
    with pytest.raises(ValueError, match="widget.on_drill panel: no panel 'c'"):
        widget.on_drill(print, panel="c")
    with pytest.raises(ValueError, match="widget.drill_root: the chart's treemap or sunburst"):
        widget.on_drill(print)
    state = widget.get_state()["_chart"]
    assert state["panel_states"]["drill"] == {
        "a": {"path": ['[0,"Europe"]']},
        "b": {"path": ['[1,"Asia"]']},
    }


def test_widgets_keep_each_subplot_networks_moves_and_views():
    widget = (
        hg.Chart(LINKS, panels=["a", "b"], drag=True, zoom=True)
        .graph("source", "target", panel="a")
        .graph("source", "target", panel="b")
        .widget()
    )
    browser = Browser(widget)
    widget.panel_item_positions = {"a": {'[0,"a"]': (1, 2)}}
    assert widget.panel_item_positions == {"a": {'[0,"a"]': (1.0, 2.0)}, "b": {}}
    views = []
    widget.on_viewport(views.append, panel="b")
    browser.reply(
        {
            "type": "viewport",
            "viewport": {"x": [0, 10], "y": [0, 5], "yRight": None, "time": []},
            "panel": "b",
            "revision": 1,
        }
    )
    assert widget.panel_viewports["b"] == hg.Viewport(x=(0.0, 10.0), y=(0.0, 5.0))
    assert widget.viewport == hg.Viewport()
    assert views == [hg.Viewport(x=(0.0, 10.0), y=(0.0, 5.0))]
    # New data keeps the moves of nodes it still has, and lets the others go.
    widget.replace(LINKS, data=None)
    assert widget.panel_item_positions == {"a": {'[0,"a"]': (1.0, 2.0)}, "b": {}}
    widget.replace({"source": ["b"], "target": ["c"]}, data=None)
    assert widget.panel_item_positions == {"a": {}, "b": {}}


def test_widgets_keep_moves_of_networks_whose_data_did_not_change():
    nodes = {"name": ["a", "b", "c"], "team": ["x", "x", "y"]}
    widget = (
        hg.Chart(CITIES, panels=["map", "net"], drag=True)
        .geopoint("lon", "lat", panel="map")
        .graph("source", "target", data=LINKS, nodes=nodes, node="name", panel="net")
        .widget()
    )
    Browser(widget)
    heard = []
    widget.on_item_move(heard.append, panel="net")
    moved = {'[1,"a"]': (1.0, 2.0)}
    widget.panel_item_positions = {"net": moved}
    # New places for the map leave the network be.
    widget.append({"lon": [1.0], "lat": [2.0]})
    assert widget.panel_item_positions == {"net": moved}
    # New links, or new nodes, keep the moves of the nodes they still have.
    widget.replace(LINKS, data=LINKS)
    assert widget.panel_item_positions == {"net": moved}
    widget.replace({"name": ["b", "c"], "team": ["x", "y"]}, data=nodes)
    assert widget.panel_item_positions == {"net": moved}
    widget.replace({"source": ["b"], "target": ["c"]}, data=LINKS)
    assert widget.panel_item_positions == {"net": {}}
    assert heard == [moved, {}]


def test_widgets_check_layout_marks_options_when_made_and_updated():
    with pytest.raises(ValueError, match="Chart y scope: every panel draws a geopoint"):
        hg.Chart(CITIES, panels=["a"], y=hg.AxisOptions(scope="panel")).geopoint(
            "lon", "lat", panel="a"
        ).widget()
    widget = hg.Chart(CITIES, facet="year").geopoint("lon", "lat").widget()
    with pytest.raises(ValueError, match="Chart y scope: every panel draws a geopoint"):
        widget.update(y=hg.AxisOptions(scope="panel"))
    with pytest.raises(ValueError, match='Chart zoom: expected True or "xy"'):
        widget.update(zoom="x")
    with pytest.raises(ValueError, match="Chart sync: a geopoint has no x axis"):
        widget.update(sync="dashboard")
    subplots = (
        hg.Chart(CITIES, panels=["a", "b"])
        .geopoint("lon", "lat", panel="a")
        .graph("source", "target", data=LINKS, panel="b")
        .widget()
    )
    with pytest.raises(ValueError, match="Chart brush: every panel draws a geopoint"):
        subplots.update(brush="x")
    subplots.update(zoom=True, brush="lasso")
    maps = hg.Chart(CITIES, panels=["a"]).geopoint("lon", "lat", panel="a").widget()
    with pytest.raises(ValueError, match="Chart drag: moves a network's nodes, and the chart"):
        maps.update(drag=True)
    beside = (
        hg.Chart(CITIES, panels=["line", "map"])
        .line("lon", "lat", panel="line")
        .geopoint("lon", "lat", panel="map")
        .widget()
    )
    for option, value in (("zoom", "y"), ("zoom", "xy"), ("brush", "xy"), ("brush", "lasso")):
        with pytest.raises(ValueError, match=f"Chart {option}: .* along x only"):
            beside.update(**{option: value})
    beside.update(zoom="x", brush="x")


def test_widgets_of_map_subplots_alone_set_each_view():
    widget = (
        hg.Chart(CITIES, panels=["a", "b"], zoom=True)
        .geopoint("lon", "lat", panel="a")
        .geopoint("lon", "lat", panel="b")
        .widget()
    )
    Browser(widget)
    with pytest.raises(ValueError, match="widget.viewport: no panel of the chart has axes"):
        widget.viewport = (0.0, 1.0)
    with pytest.raises(ValueError, match="widget.on_viewport: no panel of the chart has axes"):
        widget.on_viewport(print)
    with pytest.raises(ValueError, match="a map or network has no right y axis; drop y_right"):
        widget.panel_viewports = {"a": hg.Viewport(x=(0.0, 1.0), y_right=(0.0, 1.0))}
    for ends in (("A", "B"), (datetime(2024, 1, 1), 1.0), (False, True)):
        with pytest.raises(ValueError, match="panel_viewports x: expected finite numbers"):
            widget.panel_viewports = {"a": ends}
    widget.panel_viewports = {"a": (0.0, 1.0), "b": None}
    assert widget.panel_viewports == {"a": hg.Viewport(x=(0.0, 1.0)), "b": hg.Viewport()}


def test_widgets_set_a_facet_map_view_in_its_plane_units():
    widget = hg.Chart(CITIES, facet="year", zoom=True).geopoint("lon", "lat").widget()
    Browser(widget)
    with pytest.raises(ValueError, match="widget.viewport: a map or network has no right y"):
        widget.viewport = hg.Viewport(x=(0.0, 1.0), y_right=(0.0, 1.0))
    with pytest.raises(ValueError, match="widget.viewport x: expected finite numbers"):
        widget.viewport = (datetime(2024, 1, 1), 1.0)
    widget.viewport = hg.Viewport(x=(0.0, 1.0), y=(2.0, 3.0))
    assert widget.viewport == hg.Viewport(x=(0.0, 1.0), y=(2.0, 3.0))


def test_widgets_share_one_state_across_facet_panels():
    widget = hg.Chart(SALES, facet="year", zoom=True).treemap(["region"], "revenue").widget()
    browser = Browser(widget)
    widget.drill_root = ('[0,"Asia"]',)
    assert browser.messages[-1]["type"] == "drill" and "panel" not in browser.messages[-1]
    assert widget.panel_drill_roots == {}


def test_streamlit_state_holds_each_subplot_state():
    hst = pytest.importorskip("herceg.streamlit")
    state = hst._state(
        {
            "drill_root": {"root": None, "panels": {"b": {"path": ['[1,"Asia"]']}}},
            "item_positions": {
                "epoch": "layout",
                "positions": {},
                "panels": {"n": {'[2,"a"]': [1, 2]}},
            },
            "viewport": {
                "x": None,
                "y": None,
                "yRight": None,
                "panels": {"m": {"x": [0, 1], "y": [2, 3], "yRight": None}},
            },
        },
        item_epoch="layout",
    )
    assert state.drill_root is None
    assert state.panel_drill_roots == {"b": ('[1,"Asia"]',)}
    assert state.panel_item_positions == {"n": {'[2,"a"]': (1.0, 2.0)}}
    assert state.panel_viewports == {"m": hg.Viewport(x=(0.0, 1.0), y=(2.0, 3.0))}


LATENCY = {
    "t": [0.0, 1.0, 2.0, 3.0],
    "p99": [120.0, 180.0, 150.0, 130.0],
    "errors": [3.0, 5.0, 2.0, 4.0],
}


def two_panels(**options):
    """Two subplots side by side, each with an x scale of its own."""
    chart = hg.Chart(LATENCY, zoom="x", brush="x", **options)
    left, right = chart.columns([2, 1])
    left.panel("latency").line(x="t", y="p99")
    right.panel("errors").line(x="t", y="errors")
    return chart


def view(x):
    return {"x": x, "y": None, "yRight": None, "time": []}


def test_live_subplots_keep_each_panels_view_and_selection():
    widget = two_panels().widget()
    browser = Browser(widget)
    assert widget.panel_viewports == {"latency": hg.Viewport(), "errors": hg.Viewport()}
    heard = []
    widget.on_viewport(heard.append, panel="errors")
    # Zooming each panel in a browser changes that panel's view only.
    browser.reply({"type": "viewport", "viewport": view([0, 1]), "panel": "latency"})
    browser.reply({"type": "viewport", "viewport": view([2, 3]), "panel": "errors"})
    assert widget.panel_viewports == {
        "latency": hg.Viewport(x=(0.0, 1.0)),
        "errors": hg.Viewport(x=(2.0, 3.0)),
    }
    assert heard == [hg.Viewport(x=(2.0, 3.0))]
    # Python sets one panel's view, which the browsers show there.
    widget.panel_viewports = {"latency": (0.5, 1.5)}
    sent = browser.messages[-1]
    assert (sent["type"], sent["panel"], sent["viewport"]["x"]) == (
        "viewport",
        "latency",
        [0.5, 1.5],
    )
    assert widget.panel_viewports["errors"] == hg.Viewport(x=(2.0, 3.0))
    # No view or selection is the whole chart's.
    with pytest.raises(ValueError, match="widget.viewport: the chart.s panels with axes have x"):
        widget.viewport = (0.0, 1.0)
    with pytest.raises(ValueError, match="widget.on_viewport: the chart's panels with axes have x"):
        widget.on_viewport(print)
    with pytest.raises(
        ValueError, match=r"panel_viewports\['errors'\]: subplots zoom along x only"
    ):
        widget.panel_viewports = {"errors": hg.Viewport(x=(0.0, 1.0), y=(0.0, 1.0))}
    with pytest.raises(ValueError, match="widget.selection: the chart's panels have x scales"):
        widget.selection = (0.0, 1.0)
    with pytest.raises(ValueError, match="widget.selection panels: no panel 'p50'"):
        widget.selection = hg.Selection(x=(0.0, 1.0), panels=("p50",))
    # A brush in a panel is the selection, of that panel; Python brushes another.
    selections = []
    widget.on_select(selections.append)
    brushed = {"x": [1, 2], "y": None, "lasso": None, "panels": ["errors"], "time": []}
    browser.reply({"type": "select", "selection": brushed})
    assert widget.selection == hg.Selection(x=(1.0, 2.0), panels=("errors",))
    widget.selection = hg.Selection(x=(0.0, 1.0), panels=("latency",))
    assert browser.messages[-1]["selection"]["panels"] == ["latency"]
    assert selections == [
        hg.Selection(x=(1.0, 2.0), panels=("errors",)),
        hg.Selection(x=(0.0, 1.0), panels=("latency",)),
    ]


def test_live_charts_whose_panels_share_x_keep_one_view_and_insets_their_own():
    chart = hg.Chart(LATENCY, zoom="x", x=hg.AxisOptions(scope="chart"))
    [cell] = chart.columns([1])
    main = cell.panel("main")
    main.line(x="t", y="p99")
    main.inset("detail", x=hg.AxisOptions(domain=(1.0, 2.0))).line(x="t", y="p99")
    widget = chart.widget()
    browser = Browser(widget)
    assert widget.panel_viewports == {"detail": hg.Viewport()}
    widget.viewport = (0.0, 2.0)
    assert "panel" not in browser.messages[-1]
    browser.reply({"type": "viewport", "viewport": view([1.2, 1.8]), "panel": "detail"})
    assert widget.panel_viewports == {"detail": hg.Viewport(x=(1.2, 1.8))}
    assert widget.viewport == hg.Viewport(x=(0.0, 2.0))
    # Giving the main panel an x scale of its own leaves the inset's as it was.
    widget.update(x=hg.AxisOptions(scope="panel"))
    assert widget.panel_viewports == {
        "main": hg.Viewport(),
        "detail": hg.Viewport(x=(1.2, 1.8)),
    }


def test_live_views_refuse_reports_from_before_their_scales_changed():
    widget = two_panels().widget()
    browser = Browser(widget)
    assert widget.panel_viewports == {"latency": hg.Viewport(), "errors": hg.Viewport()}
    # The panels of a row share a scale now; a browser's zoom from before arrives.
    widget.update(x=hg.AxisOptions(scope="row"))
    browser.reply(
        {
            "type": "viewport",
            "viewport": view([1.0, 2.0]),
            "panel": "latency",
            "origin": "old",
            "revision": 0,
        }
    )
    assert widget.panel_viewports["latency"] == hg.Viewport()


def test_live_charts_whose_only_axes_are_insets_have_no_view_of_their_own():
    data = LATENCY | {"g": ["a", "b", "a", "b"]}
    chart = hg.Chart(data, zoom="x", brush="x", x=hg.AxisOptions(scope="chart"))
    [cell] = chart.columns([1])
    share = cell.panel("share")
    share.pie("g", "p99")
    share.inset("detail").line(x="t", y="p99")
    widget = chart.widget()
    assert widget.panel_viewports == {"detail": hg.Viewport()}
    with pytest.raises(ValueError, match="widget.panel_viewports"):
        widget.viewport = (5.0, 10.0)
    with pytest.raises(ValueError, match="name the panel brushed"):
        widget.selection = (5.0, 10.0)
    widget.selection = hg.Selection(x=(1.0, 2.0), panels=("detail",))


def test_live_facet_panels_share_x():
    split = hg.Chart(
        LATENCY | {"g": ["a", "a", "b", "b"]}, facet="g", x=hg.AxisOptions(scope="panel")
    )
    with pytest.raises(ValueError, match='Chart x scope: expected "chart" in a live faceted chart'):
        split.line(x="t", y="p99").widget()
    rows = hg.Chart(
        LATENCY | {"g": ["a", "a", "b", "b"]}, facet_row="g", x=hg.AxisOptions(scope="panel")
    )
    with pytest.raises(ValueError, match='Chart x scope: expected "chart" in a live faceted chart'):
        rows.line(x="t", y="p99").widget()
    widget = (
        hg.Chart(LATENCY | {"g": ["a", "a", "b", "b"]}, facet="g").line(x="t", y="p99").widget()
    )
    with pytest.raises(ValueError, match='Chart x scope: expected "chart" in a live faceted chart'):
        widget.update(x=hg.AxisOptions(scope="row"))
    # Subplots take one: their panels' views are each their own.
    two_panels().widget().update(x=hg.AxisOptions(scope="panel"))


def test_streamlit_state_holds_each_panels_own_view():
    hst = pytest.importorskip("herceg.streamlit")
    assert hst.chart(two_panels(), on_select="rerun", on_viewport="rerun") == hst.ChartState()
    state = hst._state(
        {"viewport": {"panels": {"latency": view([0, 1]), "errors": view([2, 3])}}},
        item_epoch=None,
    )
    assert state.viewport is None
    assert state.panel_viewports == {
        "latency": hg.Viewport(x=(0.0, 1.0)),
        "errors": hg.Viewport(x=(2.0, 3.0)),
    }


def test_live_subplots_follow_a_change_of_their_x_scope():
    widget = two_panels(x=hg.AxisOptions(scope="chart")).widget()
    browser = Browser(widget)
    assert widget.panel_viewports == {}
    widget.viewport = (0.0, 1.0)
    widget.update(x=hg.AxisOptions(scope="panel"))
    # Each panel's view starts over, and the chart's goes, as in the browser.
    assert widget.panel_viewports == {"latency": hg.Viewport(), "errors": hg.Viewport()}
    assert widget.viewport == hg.Viewport()
    assert browser.messages[-1]["type"] in ("viewport", "options")
    browser.reply({"type": "viewport", "viewport": view([0, 1]), "panel": "errors"})
    assert widget.panel_viewports["errors"] == hg.Viewport(x=(0.0, 1.0))
    widget.update(x=hg.AxisOptions(scope="chart"))
    assert widget.panel_viewports == {}
    widget.viewport = (0.5, 1.0)


def test_live_subplots_sharing_an_x_scale_by_scope_share_its_view():
    chart = hg.Chart(LATENCY, zoom="x", x=hg.AxisOptions(scope="row"))
    grid = chart.grid(rows=2, columns=2)
    grid.cell(row=0, column=0).panel("a").line(x="t", y="p99")
    grid.cell(row=0, column=1).panel("b").line(x="t", y="errors")
    grid.cell(row=1, column=0, column_span=2).panel("c").line(x="t", y="p99")
    widget = chart.widget()
    browser = Browser(widget)
    heard = []
    widget.on_viewport(heard.append, panel="b")
    # Setting a's view sets b's, which share the row's x scale; c keeps its own.
    widget.panel_viewports = {"a": (0.0, 1.0)}
    assert widget.panel_viewports == {
        "a": hg.Viewport(x=(0.0, 1.0)),
        "b": hg.Viewport(x=(0.0, 1.0)),
        "c": hg.Viewport(),
    }
    assert heard == [hg.Viewport(x=(0.0, 1.0))]
    assert {message.get("panel") for message in browser.messages[-2:]} == {"a", "b"}
    with pytest.raises(ValueError, match="'a' and 'b' share an x scale"):
        widget.panel_viewports = {"a": (0.0, 1.0), "b": (1.0, 2.0)}
    # Once the panels' scales are their own, their views start over.
    widget.update(x=hg.AxisOptions(scope="panel"))
    assert widget.panel_viewports == {"a": hg.Viewport(), "b": hg.Viewport(), "c": hg.Viewport()}
    widget.panel_viewports = {"a": (0.0, 1.0)}
    assert widget.panel_viewports["b"] == hg.Viewport()


def test_live_subplots_group_views_as_the_engine_groups_scales():
    def groups(scope):
        chart = hg.Chart(LATENCY, zoom="x", x=hg.AxisOptions(scope=scope))
        left, right = chart.columns(2)
        top, bottom = right.rows(2)
        main = left.panel("a")
        main.line(x="t", y="p99")
        top.panel("b").line(x="t", y="errors")
        bottom.panel("c").line(x="t", y="p99")
        main.inset("d").line(x="t", y="p99")
        return chart.widget()._live.view_groups

    # A column of the inner grid holds b and c; the outer grid's columns part a from them.
    assert groups("column")["b"] == ["b", "c"]
    assert groups("row")["a"] == ["a"]
    assert groups({"panels": ["a", "c"]})["a"] == ["a", "c"]
    # Insets keep their own unless a list names them.
    assert groups("column")["d"] == ["d"]
    assert groups({"panels": ["a", "d"]})["d"] == ["a", "d"]


def test_live_subplots_group_views_in_the_engine_reading_order():
    # The first grid in reading order takes the panels: the two-column one
    # above, listed after the one-column grid below it.
    layout = {
        "type": "grid",
        "rows": [1, 1],
        "columns": [1],
        "cells": [
            {"row": 1, "column": 0, "content": {"type": "grid", "columns": [1]}},
            {"row": 0, "column": 0, "content": {"type": "grid", "columns": [1, 1]}},
        ],
    }
    keys = _scale_groups(layout, ["a", "b", "c", "d"], "row")
    assert keys["a"] == keys["b"] and keys["c"] == keys["d"] and keys["a"] != keys["c"]
