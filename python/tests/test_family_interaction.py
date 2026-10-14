"""Maps, trees, and networks take the shared interaction options: maps pan,
zoom, and lasso, trees drill, networks pan, zoom, lasso and drag nodes, and each selects
rows; networks draw directed links and link labels."""

import pytest

import herceg as hg


def collection():
    """Two square regions."""
    square = lambda x: [[[x, 0], [x + 1, 0], [x + 1, 1], [x, 1], [x, 0]]]  # noqa: E731
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {"name": n},
                "geometry": {"type": "Polygon", "coordinates": square(x)},
            }
            for n, x in (("Ada", 0), ("Bel", 2))
        ],
    }


SALES = {
    "region": ["Europe", "Europe", "Asia"],
    "country": ["France", "Spain", "Japan"],
    "revenue": [40.0, 20.0, 50.0],
}
TALKS = {"from": ["a", "b", "a"], "to": ["b", "a", "c"], "kind": ["likes", "likes", "knows"]}


def interaction(chart):
    spec, _ = chart.to_spec()
    return spec.get("interaction")


def test_maps_zoom_both_ways_and_lasso_rows():
    assert interaction(hg.Chart(collection(), zoom=True).geoshape()) == {"zoom": True}
    assert interaction(hg.Chart(collection(), zoom="xy", brush="lasso").geoshape()) == {
        "zoom": "xy",
        "brush": "lasso",
    }
    regions = collection()
    binding = hg.SelectionBinding(channel="picked")
    spec, _ = hg.Chart(regions, brush="lasso", row_selection=binding).geoshape().to_spec()
    assert spec["rowSelection"]["channel"] == "picked"
    with pytest.raises(
        ValueError, match='Chart zoom: expected True or "xy", as maps zoom both ways; received "y"'
    ):
        hg.Chart(collection(), zoom="y").geopoint("lon", "lat", data={"lon": [1.0], "lat": [2.0]})


def test_treemaps_and_sunbursts_drill_with_zoom_and_select_rows():
    for kind in ("treemap", "sunburst"):
        chart = getattr(hg.Chart(SALES, zoom=True), kind)(path=["region", "country"])
        assert interaction(chart) == {"zoom": True}
        selected = getattr(hg.Chart(SALES, row_selection=hg.SelectionBinding("c")), kind)(
            path=["region", "country"], value="revenue"
        )
        assert selected.to_spec()[0]["rowSelection"]["channel"] == "c"
        with pytest.raises(ValueError, match=f"Chart zoom: a {kind} drills with zoom=True"):
            getattr(hg.Chart(SALES, zoom="x"), kind)(path=["region"])
        with pytest.raises(ValueError, match=f"Chart brush: a {kind} has no x axis"):
            getattr(hg.Chart(SALES, brush="x"), kind)(path=["region"])
    # In facet panels too, sharing one root.
    faceted = hg.Chart(
        SALES, facet="region", zoom=True, row_selection=hg.SelectionBinding("c")
    ).treemap(path=["country"])
    spec, _ = faceted.to_spec()
    assert spec["interaction"] == {"zoom": True} and spec["rowSelection"]["channel"] == "c"


def test_networks_drag_nodes_draw_directed_links_and_link_labels():
    chart = hg.Chart(TALKS, drag=True).graph("from", "to", directed=True, link_label_field="kind")
    spec, _ = chart.to_spec()
    assert spec["interaction"] == {"drag": True}
    [mark] = spec["marks"]
    assert (mark["directed"], mark["linkLabelField"]) == (True, "kind")
    # The labels' column travels with the links.
    assert "kind" in spec["data"]["data"]["columns"]
    assert "likes" in chart.to_svg()
    assert hg.graph(TALKS, "from", "to", directed=True).to_spec()[0]["marks"][0]["directed"]
    with pytest.raises(
        ValueError, match="Chart drag: moves a network's nodes, and a treemap has none"
    ):
        hg.Chart(SALES, drag=True).treemap(path=["region"])
    with pytest.raises(
        ValueError, match="Chart drag: moves a network's nodes, and the chart has no graph"
    ):
        hg.Chart({"x": [1.0], "y": [2.0]}, drag=True).line("x", "y").to_spec()
    with pytest.raises(TypeError, match="graph link_label_field: column 'n' holds number"):
        hg.Chart({**TALKS, "n": [1.0, 2.0, 3.0]}).graph("from", "to", link_label_field="n")
    binding = hg.SelectionBinding("c")
    assert hg.Chart(TALKS, row_selection=binding).graph("from", "to").to_spec()[0]["rowSelection"]


def test_directed_networks_count_links_each_way():
    # Every ordered pair of 500 nodes: twice the links of an undirected network.
    names = [f"n{i}" for i in range(500)]
    pairs = [(a, b) for a in names for b in names if a != b]
    dense = {"from": [a for a, _ in pairs], "to": [b for _, b in pairs]}
    hg.Chart(dense).graph("from", "to")
    with pytest.raises(
        ValueError, match="graph: draws at most .* this network has 500 nodes and 249,500 links"
    ):
        hg.Chart(dense).graph("from", "to", directed=True)


def test_networks_share_plane_zoom_and_lasso_options():
    people = {"name": ["a", "b", "c", "a"]}
    binding = hg.SelectionBinding("picked", data=people)
    for zoom in (True, "xy"):
        for chart in (
            hg.Chart(TALKS, zoom=zoom, brush="lasso", drag=True, row_selection=binding).graph(
                "from", "to", nodes=people, node="name"
            ),
            hg.graph(
                TALKS,
                "from",
                "to",
                nodes=people,
                node="name",
                zoom=zoom,
                brush="lasso",
                drag=True,
                row_selection=binding,
            ),
        ):
            spec, _ = chart.to_spec()
            assert spec["interaction"] == {"zoom": zoom, "brush": "lasso", "drag": True}
            assert spec["rowSelection"]["data"] == spec["marks"][0]["nodes"]


def test_networks_take_a_layout_by_name_or_with_its_options():
    def layout(value):
        spec, _ = hg.Chart(TALKS).graph("from", "to", layout=value).to_spec()
        return spec["marks"][0].get("layout")

    assert layout(None) is None
    assert layout("circular") == "circular"
    assert layout({"type": "force", "settle": False}) == {"type": "force", "settle": False}
    assert layout({"settle": False}) == {"type": "force", "settle": False}
    assert layout({"type": "layered", "direction": "right"}) == {
        "type": "layered",
        "direction": "right",
    }
    assert (
        hg.graph(TALKS, "from", "to", layout="layered").to_spec()[0]["marks"][0]["layout"]
        == "layered"
    )
    with pytest.raises(
        ValueError, match='graph layout: expected "force", "circular", or "layered"'
    ):
        layout("tree")
    with pytest.raises(
        ValueError,
        match=r'graph layout\["settle"\]: only a force layout takes it; drop it, or use "type"',
    ):
        layout({"type": "circular", "settle": True})
    with pytest.raises(ValueError, match=r'graph layout\["direction"\]: expected "down", "right"'):
        layout({"type": "layered", "direction": "sideways"})
    with pytest.raises(ValueError, match=r'graph layout\["speed"\]: not an option'):
        layout({"type": "force", "speed": 2})
    with pytest.raises(ValueError, match=r'graph layout\["settle"\]: expected True or False'):
        layout({"type": "force", "settle": "no"})


def test_networks_of_every_layout_export_without_a_browser():
    for layout in ("force", "circular", {"type": "layered", "direction": "up"}):
        svg = hg.Chart(TALKS).graph("from", "to", directed=True, layout=layout).to_svg()
        assert svg.startswith("<svg") and "Network of 3 nodes" in svg
