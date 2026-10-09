"""Geographic data: shapes packed into geometry columns, GeoJSON feature
collections as columns, and Plotly-style joins of values to shapes.

Shapes travel the way the chart spec's geometry columns hold them: one
float64 array of longitude, latitude pairs and three int32 offset arrays
(rings, polygons, geometries), with an int32 code per row. Shapes come from
GeoJSON dicts or any object with ``__geo_interface__`` (Shapely geometries,
GeoPandas GeoSeries and GeoDataFrames) without importing either library.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import numpy as np

#: Geometry types a geometry column holds.
SHAPES = ("Polygon", "MultiPolygon")


@dataclass(frozen=True)
class Shapes:
    """Packed polygons: coordinates and offsets, as the spec's geometry columns hold them."""

    coordinates: np.ndarray  # <f8, longitude and latitude pairs, flattened
    ring_offsets: np.ndarray  # <i4, into coordinate pairs
    polygon_offsets: np.ndarray  # <i4, into rings
    geometry_offsets: np.ndarray  # <i4, into polygons


def geometry_of(value: Any) -> Mapping[str, Any] | None:
    """A GeoJSON geometry mapping from a mapping or an object with ``__geo_interface__``."""
    if value is None:
        return None
    if isinstance(value, Mapping):
        return value
    interface = getattr(value, "__geo_interface__", None)
    if interface is None:
        return None
    return interface if isinstance(interface, Mapping) else None


def is_geometry(value: Any) -> bool:
    """Whether a value is a GeoJSON geometry (a mapping with coordinates) or a
    shape with ``__geo_interface__``."""
    if hasattr(value, "__geo_interface__"):
        return True
    return isinstance(value, Mapping) and "type" in value and "coordinates" in value


def check_crs(source: Any) -> None:
    """Refuses data whose coordinate reference system is known not to be in degrees."""
    crs = getattr(source, "crs", None)
    if crs is None:
        return
    if getattr(crs, "is_geographic", True) is False:
        name = getattr(crs, "name", None) or str(crs)
        raise ValueError(
            f"the shapes are in a projected coordinate reference system ({name}); "
            "maps read longitude and latitude in degrees: reproject first, as with "
            "gdf.to_crs(4326)"
        )


def pack(values: Sequence[Any]) -> tuple[np.ndarray, Shapes]:
    """Each value's shape packed: codes (-1 for missing shapes) and the shapes."""
    coordinates: list[float] = []
    rings = [0]
    polygons = [0]
    geometries = [0]
    codes = np.full(len(values), -1, dtype="<i4")
    for row, value in enumerate(values):
        if _missing(value):
            continue
        shape = geometry_of(value)
        kind = shape.get("type") if shape is not None else None
        if kind not in SHAPES:
            what = kind or type(value).__name__
            hint = (
                " (points go in longitude and latitude columns, for geopoint)"
                if kind == "Point"
                else ""
            )
            raise TypeError(
                f"row {row} holds a {what}; geometry columns hold polygons and multipolygons{hint}"
            )
        parts = [shape.get("coordinates")] if kind == "Polygon" else shape.get("coordinates")
        if not isinstance(parts, Sequence) or isinstance(parts, str):
            raise TypeError(f"row {row} holds a {kind} without coordinates")
        for polygon in parts:
            for ring in polygon:
                for position in ring:
                    coordinates.extend(_position(position, row))
                rings.append(len(coordinates) // 2)
            polygons.append(len(rings) - 1)
        geometries.append(len(polygons) - 1)
        codes[row] = len(geometries) - 2
    shapes = Shapes(
        np.asarray(coordinates, dtype="<f8"),
        np.asarray(rings, dtype="<i4"),
        np.asarray(polygons, dtype="<i4"),
        np.asarray(geometries, dtype="<i4"),
    )
    _check(shapes)
    return codes, shapes


def _missing(value: Any) -> bool:
    return value is None or (isinstance(value, float) and math.isnan(value))


def _position(position: Any, row: int) -> tuple[float, float]:
    try:
        lon, lat = float(position[0]), float(position[1])
    except (TypeError, ValueError, IndexError):
        raise TypeError(
            f"row {row} has a position that is not [longitude, latitude]: {position!r}"
        ) from None
    return lon, lat


def _check(shapes: Shapes) -> None:
    """Coordinates must be degrees and rings span at most a turn of longitude, as
    the browser checks too: projected coordinates are refused here, not there."""
    xy = shapes.coordinates.reshape(-1, 2)
    if len(xy) == 0:
        return
    bad = ~(np.isfinite(xy).all(axis=1) & (np.abs(xy[:, 0]) <= 540) & (np.abs(xy[:, 1]) <= 90))
    if bad.any():
        lon, lat = xy[int(np.argmax(bad))]
        raise ValueError(
            f"coordinate ({lon}, {lat}) is not a longitude and latitude in degrees; "
            "reproject the data to WGS 84 (EPSG:4326)"
        )
    starts = shapes.ring_offsets[:-1]
    filled = starts[shapes.ring_offsets[1:] > starts]
    spans = np.maximum.reduceat(xy[:, 0], filled) - np.minimum.reduceat(xy[:, 0], filled)
    if (spans > 360).any():
        ring = int(np.flatnonzero(shapes.ring_offsets[1:] > starts)[np.argmax(spans > 360)])
        raise ValueError(
            f"ring {ring} spans {spans.max():g} degrees of longitude; a ring spans at most 360"
        )


class GeometryList(list):
    """A column known to hold shapes, even when it is empty or every value is missing."""


def is_feature_collection(data: Any) -> bool:
    return isinstance(data, Mapping) and data.get("type") == "FeatureCollection"


def feature_columns(collection: Mapping[str, Any]) -> dict[str, list[Any]]:
    """A feature collection as columns: its shapes as ``geometry`` (or its
    points as ``longitude`` and ``latitude``), ids as ``id``, and each property
    as a column of its own, as herceg's ``fromGeoJSON`` reads them."""
    features = collection.get("features")
    if not isinstance(features, Sequence):
        raise TypeError("a FeatureCollection needs a list of features")
    kinds = {
        (feature.get("geometry") or {}).get("type")
        for feature in features
        if isinstance(feature, Mapping)
    } - {None}
    columns: dict[str, list[Any]] = {}
    if kinds == {"Point"}:
        points = [(f.get("geometry") or {}).get("coordinates") for f in features]
        columns["longitude"] = [float(p[0]) if p else None for p in points]
        columns["latitude"] = [float(p[1]) if p else None for p in points]
    elif kinds <= set(SHAPES):
        columns["geometry"] = GeometryList(f.get("geometry") for f in features)
    else:
        raise TypeError(
            f"the features are {', '.join(sorted(map(str, kinds)))}; maps read collections "
            "of polygons and multipolygons, or of points"
        )
    if any(f.get("id") is not None for f in features):
        columns["id"] = [None if f.get("id") is None else str(f.get("id")) for f in features]
    names: dict[str, None] = {}
    for feature in features:
        names.update(dict.fromkeys(feature.get("properties") or {}))
    for name in names:
        values = [(f.get("properties") or {}).get(name) for f in features]
        if any(isinstance(v, (Mapping, list, tuple)) for v in values):
            continue  # Nested properties have no column kind.
        if name in columns:
            raise ValueError(
                f"a property is named {name!r}, like the column made of the features' "
                "shapes, points, or ids; rename it"
            )
        if any(isinstance(v, str) for v in values) and any(
            isinstance(v, (int, float)) and not isinstance(v, bool) for v in values
        ):
            values = [None if v is None else str(v) for v in values]
        columns[name] = values
    return columns


def feature_key(feature: Mapping[str, Any], key: str) -> Any:
    """A feature's id (``"id"``) or a property (``"properties.name"``), as Plotly's featureidkey."""
    if key == "id":
        return feature.get("id")
    if key.startswith("properties."):
        return (feature.get("properties") or {}).get(key[len("properties.") :])
    raise ValueError(f'featureidkey must be "id" or "properties.<name>", not {key!r}')


def key_text(value: Any) -> str | None:
    """Join keys compare as text; whole numbers lose a trailing ".0", and leading zeros stay."""
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return None
    if isinstance(value, (float, np.floating)) and float(value).is_integer():
        return str(int(value))
    return str(value)
