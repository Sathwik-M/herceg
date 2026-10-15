"""Which column splits a line's, area's, or bar's rows into series, as the
engine finds it (``seriesOf`` in packages/herceg/src/marks/mark.ts; both read
the conformance cases in packages/herceg/test/fixtures/series-inference.json)."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any


def series_of(
    color: str | None,
    encode: Mapping[str, Any] | None,
    paint: str | None,
    paint_name: str,
    kind: Callable[[str], str | None],
) -> str | None:
    """Without a ``series``, the category column ``color`` names (or
    ``encode``'s color channel's field), unless the mark's own paint
    (``paint``, named ``paint_name``: a line's stroke, an area's or bar's
    fill, flat or in ``encode``) overrides the color; ``kind`` gives a
    column's kind, or None for a name that is no column."""
    if paint is not None or (encode or {}).get(paint_name) is not None:
        return None
    channel = (encode or {}).get("color")
    field = channel.get("field") if isinstance(channel, Mapping) else color
    return field if field is not None and kind(field) == "category" else None
