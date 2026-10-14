"""Maps, networks, and trees in facets and subplots: what charts take, and the
interaction state live charts keep per subplot."""

from datetime import datetime

import pytest

import herceg as hg
from herceg._events import decode_selection, encode_selection

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
        hg.Chart(CITIES, panels=["map", "net"], panel_columns=2, zoom=True, drag=True)
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


def test_panels_without_axes_refuse_resolving_scales():
    message = "Chart resolve_x: every panel draws a geopoint or another mark without axes"
    with pytest.raises(ValueError, match=message):
        hg.Chart(CITIES, panels=["a"], resolve_x="independent").geopoint(
            "lon", "lat", panel="a"
        ).to_spec()
    with pytest.raises(ValueError, match="Chart resolve_y: every panel draws a geoshape"):
        hg.Chart(CITIES, facet="year", resolve_y="independent").geoshape(
            data=SQUARE, facet="repeat"
        ).geopoint("lon", "lat").to_spec()
    # Shared, as the panels' scales would be, they take.
    shared = hg.Chart(CITIES, panels=["a"], resolve_x="shared").geopoint("lon", "lat", panel="a")
    assert shared.to_spec()[0]["resolve"] == {"x": "shared"}
    # Beside panels with axes, they resolve those.
    beside = (
        hg.Chart(CITIES, panels=["line", "map"], resolve_y="independent")
        .line("lon", "lat", panel="line")
        .geopoint("lon", "lat", panel="map")
    )
    assert beside.to_spec()[0]["resolve"] == {"y": "independent"}


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
    # New data lays the networks out again: their moves go.
    widget.replace(LINKS, data=None)
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
    # New links, or new nodes, lay it out again.
    widget.replace(LINKS, data=LINKS)
    assert widget.panel_item_positions == {"net": {}}
    widget.panel_item_positions = {"net": moved}
    widget.replace(nodes, data=nodes)
    assert widget.panel_item_positions == {"net": {}}
    assert heard == [moved, {}, moved, {}]


def test_widgets_check_layout_marks_options_when_made_and_updated():
    with pytest.raises(ValueError, match="Chart resolve_y: every panel draws a geopoint"):
        hg.Chart(CITIES, panels=["a"], resolve_y="independent").geopoint(
            "lon", "lat", panel="a"
        ).widget()
    widget = hg.Chart(CITIES, facet="year").geopoint("lon", "lat").widget()
    with pytest.raises(ValueError, match="Chart resolve_y: every panel draws a geopoint"):
        widget.update(resolve_y="independent")
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
