import numpy as np
import pandas as pd
import pytest

import herceg as hg
from herceg._live import LiveChart


def square(x, y, size=1.0):
    return [[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]


def collection():
    """Two regions, the first with a lake, the second of two parts, and one without a shape."""
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "id": "01",
                "properties": {"name": "Ada", "gdp": 10, "zone": "N"},
                "geometry": {"type": "Polygon", "coordinates": [square(0, 0, 4), square(1, 1)]},
            },
            {
                "type": "Feature",
                "id": "02",
                "properties": {"name": "Bel", "gdp": 20.5, "zone": "S"},
                "geometry": {
                    "type": "MultiPolygon",
                    "coordinates": [[square(10, 0)], [square(12, 0)]],
                },
            },
            {
                "type": "Feature",
                "id": "03",
                "properties": {"name": "Cor", "gdp": None, "zone": "N"},
                "geometry": None,
            },
        ],
    }


def geometry_column(spec, buffers, table="data", field="geometry"):
    column = spec["data"][table]["columns"][field]
    arrays = {
        key: np.frombuffer(buffers[column[key]], dtype="<f8" if key == "coordinates" else "<i4")
        for key in ("coordinates", "ringOffsets", "polygonOffsets", "geometryOffsets", "codes")
        if key in column
    }
    return column, arrays


class Shape:
    """A shape as Shapely presents itself, through ``__geo_interface__`` only."""

    def __init__(self, mapping):
        self.__geo_interface__ = mapping


def test_feature_collections_send_shapes_as_packed_buffers():
    chart = hg.Chart(collection(), projection="equal-earth").geoshape(name="name", color="gdp")
    spec, buffers = chart.to_spec()
    assert spec["projection"] == {"type": "equal-earth"}
    assert spec["marks"] == [
        {"type": "geoshape", "geometry": "geometry", "name": "name", "color": "gdp", "data": "data"}
    ]
    column, arrays = geometry_column(spec, buffers)
    assert column["type"] == "geometry"
    # Rows without a shape name none, so codes travel.
    assert arrays["codes"].tolist() == [0, 1, -1]
    assert arrays["geometryOffsets"].tolist() == [0, 1, 3]
    assert arrays["polygonOffsets"].tolist() == [0, 2, 3, 4]
    assert arrays["ringOffsets"].tolist() == [0, 5, 10, 15, 20]
    assert arrays["coordinates"][:4].tolist() == [0.0, 0.0, 4.0, 0.0]
    assert sorted(spec["data"]["data"]["columns"]) == ["gdp", "geometry", "name"]


def test_shapes_with_a_geo_interface_and_geojson_dicts_make_geometry_columns():
    shapes = [
        Shape({"type": "Polygon", "coordinates": square(0, 0)}),
        {"type": "Polygon", "coordinates": [square(5, 5)]},
        None,
    ]
    # A Shapely Polygon's interface holds tuples; GeoJSON dicts hold lists.
    shapes[0] = Shape({"type": "Polygon", "coordinates": (tuple(map(tuple, square(0, 0))),)})
    spec, buffers = hg.Chart({"shape": shapes, "v": [1.0, 2.0, 3.0]}).geoshape("shape").to_spec()
    _, arrays = geometry_column(spec, buffers, field="shape")
    assert arrays["codes"].tolist() == [0, 1, -1]
    assert arrays["ringOffsets"].tolist() == [0, 5, 10]
    # Every row holds its own shape: no codes travel.
    spec, buffers = hg.Chart({"shape": shapes[:2]}).geoshape("shape").to_spec()
    column, _ = geometry_column(spec, buffers, field="shape")
    assert "codes" not in column


def test_geodataframes_are_read_without_geopandas_and_their_reference_system_is_checked():
    class GeoDataFrame(pd.DataFrame):
        _metadata = ["crs", "_geometry_column_name"]

    GeoDataFrame.__module__ = "geopandas.geodataframe"
    frame = GeoDataFrame(
        {
            "name": ["Ada", "Bel"],
            "pop": [1.0, 2.0],
            "shape": [Shape({"type": "Polygon", "coordinates": [square(0, 0)]})] * 2,
        }
    )
    frame._geometry_column_name = "shape"
    frame.crs = type("CRS", (), {"is_geographic": True})()
    spec, _ = hg.Chart(frame).geoshape(color="pop").to_spec()
    assert spec["marks"][0]["geometry"] == "shape"
    frame.crs = type("CRS", (), {"is_geographic": False, "name": "Web Mercator"})()
    with pytest.raises(ValueError, match=r"projected coordinate reference system \(Web Mercator\)"):
        hg.Chart(frame).geoshape(color="pop")


def test_shapes_that_are_not_polygons_or_degrees_are_refused():
    point = {"type": "Point", "coordinates": [0, 0]}
    with pytest.raises(TypeError, match="row 1 holds a Point; .* for geopoint"):
        hg.Chart({"shape": [{"type": "Polygon", "coordinates": [square(0, 0)]}, point]}).geoshape(
            "shape"
        )
    meters = {"type": "Polygon", "coordinates": [square(500_000, 4_000_000, 1000)]}
    with pytest.raises(ValueError, match="reproject the data to WGS 84"):
        hg.Chart({"shape": [meters]}).geoshape("shape")
    with pytest.raises(TypeError, match="not \\[longitude, latitude\\]"):
        hg.Chart({"shape": [{"type": "Polygon", "coordinates": [[[0, "a"]]]}]}).geoshape("shape")
    with pytest.raises(TypeError, match="holds number values; expected geometry"):
        hg.Chart({"v": [1.0]}).geoshape("v")
    with pytest.raises(ValueError, match="needs geometry="):
        hg.Chart({"v": [1.0]}).geoshape()


def test_point_collections_become_longitude_and_latitude_columns():
    cities = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {"city": "A", "people": 5},
                "geometry": {"type": "Point", "coordinates": [2.35, 48.86]},
            },
            {"type": "Feature", "properties": {"city": "B", "people": 7}, "geometry": None},
        ],
    }
    spec, buffers = (
        hg.Chart(cities).geopoint("longitude", "latitude", r="people", name="city").to_spec()
    )
    columns = spec["data"]["data"]["columns"]
    lon = np.frombuffer(buffers[columns["longitude"]["buffer"]], dtype="<f8")
    assert lon[0] == 2.35 and np.isnan(lon[1])
    assert spec["marks"][0] == {
        "type": "geopoint",
        "longitude": "longitude",
        "latitude": "latitude",
        "name": "city",
        "r": "people",
        "data": "data",
    }


def test_values_join_shapes_by_location_as_in_plotly():
    values = pd.DataFrame({"fips": ["02", "01", "99"], "rate": [2.0, 1.0, 9.0]})
    chart = hg.choropleth(values, "rate", geojson=collection(), locations="fips")
    spec, buffers = chart.to_spec()
    # The joined rows are a table of their own; the values alone are not sent.
    name = spec["marks"][0]["data"]
    assert sorted(spec["data"]) == [name]
    columns = spec["data"][name]["columns"]
    # A row per feature, in the features' order; the third has no value.
    rate = np.frombuffer(buffers[columns["rate"]["buffer"]], dtype="<f8")
    assert rate[:2].tolist() == [1.0, 2.0] and np.isnan(rate[2])
    _, arrays = geometry_column(spec, buffers, table=name)
    assert arrays["codes"].tolist() == [0, 1, -1]
    # Keys compare as text: leading zeros count, and properties can name features.
    by_name = hg.Chart().geoshape(
        data={"who": ["Bel"], "v": [3.0]},
        geojson=collection(),
        locations="who",
        feature_id_key="properties.name",
        color="v",
    )
    by_name_spec, by_name_buffers = by_name.to_spec()
    joined = by_name_spec["data"][by_name_spec["marks"][0]["data"]]
    v = np.frombuffer(by_name_buffers[joined["columns"]["v"]["buffer"]])
    assert np.isnan(v[0]) and v[1] == 3.0
    with pytest.raises(ValueError, match="no feature's id matches a value of 'fips'"):
        hg.choropleth(
            {"fips": [1.0, 2.0], "rate": [1.0, 2.0]}, "rate", geojson=collection(), locations="fips"
        )
    with pytest.raises(ValueError, match="locations name '01' twice"):
        hg.choropleth(
            {"fips": ["01", "01"], "rate": [1.0, 2.0]},
            "rate",
            geojson=collection(),
            locations="fips",
        )
    with pytest.raises(ValueError, match="needs locations"):
        hg.Chart({"a": [1.0]}).geoshape(geojson=collection())


def test_maps_share_a_chart_only_with_maps_and_need_them_for_a_projection():
    places = {"lon": [1.0], "lat": [2.0]}
    chart = hg.Chart(collection()).geoshape(color="zone").geopoint("lon", "lat", data=places)
    spec, _ = chart.to_spec()
    assert [mark["type"] for mark in spec["marks"]] == ["geoshape", "geopoint"]
    with pytest.raises(
        ValueError, match="geoshape shares its chart only with geoshape and geopoint"
    ):
        hg.Chart(collection()).geoshape().point("gdp", "gdp")
    with pytest.raises(ValueError, match="a pie has its chart to itself"):
        hg.Chart(collection()).pie("zone").geoshape()
    with pytest.raises(ValueError, match="a projection needs geoshape or geopoint marks"):
        hg.Chart(places, projection="mercator").point("lon", "lat").to_spec()
    with pytest.raises(ValueError, match="no x axis to zoom"):
        hg.Chart(collection(), zoom=True).geoshape()
    with pytest.raises(ValueError, match="need a numeric color column"):
        hg.Chart(collection()).geoshape(color="zone", colors="viridis")
    with pytest.raises(ValueError, match="stroke_width must be 0 or more"):
        hg.Chart(places).geopoint("lon", "lat", stroke_width=-1)


def test_projections_take_names_parameters_and_boxes():
    def projection(value):
        spec, _ = hg.Chart(collection(), projection=value).geoshape().to_spec()
        return spec["projection"]

    assert projection("mercator") == {"type": "mercator"}
    assert projection(
        hg.Projection("conic-equal-area", central_meridian=-96, parallels=(29.5, 45.5))
    ) == {"type": "conic-equal-area", "centralMeridian": -96.0, "parallels": [29.5, 45.5]}
    assert projection({"type": "equirectangular", "fit": ((170, -20), (-170, 20))}) == {
        "type": "equirectangular",
        "fit": [[170.0, -20.0], [-170.0, 20.0]],
    }
    assert projection(hg.Projection(fit="world"))["fit"] == "world"
    with pytest.raises(ValueError, match="projection must be one of"):
        hg.Chart(collection(), projection="robinson")
    with pytest.raises(ValueError, match="south below north"):
        hg.Chart(collection(), projection=hg.Projection(fit=((0, 10), (5, 5))))
    with pytest.raises(ValueError, match="parallels must be latitudes"):
        hg.Chart(collection(), projection=hg.Projection("conic-equal-area", parallels=(10, 100)))


def test_derived_tables_carry_shapes_but_cannot_read_them():
    rows = hg.derive(collection()).filter(hg.col("gdp") > 15)
    spec, _ = hg.Chart(rows).geoshape(color="gdp").to_spec()
    assert spec["data"]["data2"] == {
        "source": "data",
        "transform": [{"filter": [">", ["field", "gdp"], 15]}],
    }
    with pytest.raises(TypeError, match="holds shapes, which expressions cannot read"):
        hg.derive(collection()).filter(hg.col("geometry") > 1)
    with pytest.raises(TypeError, match="holds geometry values"):
        hg.derive(collection()).sort("geometry")


def test_live_maps_replace_tables_of_shapes_and_refuse_appends():
    live = LiveChart(hg.Chart(collection()).geoshape(color="gdp"))
    with pytest.raises(ValueError, match="takes replace"):
        live.append(collection())
    message, buffers = live.replace(collection())
    assert message["columns"]["geometry"]["type"] == "geometry"
    assert len(buffers) == 5 + 1


def test_maps_render_to_svg_and_pdf():
    pytest.importorskip("py_mini_racer")
    chart = (
        hg.Chart(collection(), width=400, height=240, projection="equirectangular")
        .geoshape(name="name", color="gdp")
        .geopoint("lon", "lat", data={"lon": [2.0], "lat": [2.0]}, r=4)
    )
    svg = chart.to_svg()
    assert svg.count('fill-rule="evenodd"') == 2
    assert chart.to_pdf().startswith(b"%PDF-1.4")
    scatter = hg.scatter_geo({"lon": [0.0, 10.0], "lat": [0.0, 5.0]}, "lon", "lat")
    assert scatter.to_svg().count("<circle") == 2


def test_joins_read_only_the_columns_marks_use_and_refuse_derived_rows():
    values = {"fips": ["01"], "rate": [1.0], "notes": [{"free": "form"}]}
    spec, _ = hg.choropleth(values, "rate", geojson=collection(), locations="fips").to_spec()
    columns = spec["data"][spec["marks"][0]["data"]]["columns"]
    assert sorted(columns) == ["geometry", "rate"]
    rows = hg.derive({"fips": ["01"], "rate": [1.0]}).filter(hg.col("rate") > 0)
    with pytest.raises(ValueError, match="not those of a derived table"):
        hg.choropleth(rows, "rate", geojson=collection(), locations="fips")


def test_live_maps_clear_shapes_without_breaking_their_state():
    live = LiveChart(hg.Chart(collection()).geoshape(color="gdp"))
    message, buffers = live.replace({"geometry": [None, None], "gdp": [1.0, 2.0]})
    assert message["columns"]["geometry"]["type"] == "geometry"
    spec, _ = live.to_spec()
    assert spec["data"]["data"]["columns"]["geometry"]["type"] == "geometry"
    message, _ = live.replace({"geometry": [], "gdp": []})
    assert message["columns"]["gdp"]["type"] == "number"
    live.to_spec()


def test_projection_boxes_are_degrees_of_some_width():
    for fit in (((1e20, 0), (1e20 + 1, 10)), ((180, 0), (180, 10))):
        with pytest.raises(ValueError, match="west apart from east"):
            hg.Chart(collection(), projection=hg.Projection(fit=fit))


def test_empty_collections_and_wide_rings():
    empty = {"type": "FeatureCollection", "features": []}
    spec, _ = hg.choropleth(empty).to_spec()
    assert spec["data"]["data"]["columns"]["geometry"]["type"] == "geometry"
    blank = {
        "type": "FeatureCollection",
        "features": [{"type": "Feature", "properties": {"v": 1}, "geometry": None}],
    }
    spec, _ = hg.choropleth(blank, "v").to_spec()
    assert spec["data"]["data"]["columns"]["geometry"]["type"] == "geometry"
    wide = {"type": "Polygon", "coordinates": [[[-200, 0], [200, 0], [200, 1], [-200, 0]]]}
    with pytest.raises(ValueError, match="ring 0 spans 400 degrees"):
        hg.Chart({"shape": [wide]}).geoshape("shape")


def test_live_joined_maps_join_new_rows_again():
    values = {"fips": ["01", "02"], "rate": [1.0, 2.0]}
    live = LiveChart(hg.choropleth(values, "rate", geojson=collection(), locations="fips"))
    message, buffers = live.replace({"fips": ["02"], "rate": [5.0]}, data=values)
    rate = message["columns"]["rate"]
    joined = np.frombuffer(buffers[rate["buffer"]], dtype="<f8")
    assert np.isnan(joined[0]) and joined[1] == 5.0
    live.to_spec()


def test_live_joined_maps_share_tables_and_take_single_rows():
    values = {"fips": ["01", "02"], "rate": [1.0, 2.0]}
    features = collection()
    chart = (
        hg.Chart()
        .geoshape(data=values, geojson=features, locations="fips", color="rate", id="a")
        .geoshape(data=values, geojson=features, locations="fips", id="b")
    )
    spec, _ = chart.to_spec()
    assert spec["marks"][0]["data"] == spec["marks"][1]["data"]
    live = LiveChart(chart)
    message, buffers = live.replace({"fips": "02", "rate": 7.0}, data=values)
    joined = np.frombuffer(buffers[message["columns"]["rate"]["buffer"]], dtype="<f8")
    assert np.isnan(joined[0]) and joined[1] == 7.0
    other = {"type": "FeatureCollection", "features": collection()["features"][:1]}
    two = (
        hg.Chart()
        .geoshape(data=values, geojson=collection(), locations="fips", id="a")
        .geoshape(data=values, geojson=other, locations="fips", id="b")
    )
    with pytest.raises(ValueError, match="joined to the features of several geoshape marks"):
        LiveChart(two).replace(values, data=values)
