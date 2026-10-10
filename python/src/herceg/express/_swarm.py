"""Swarm plots' warning: the core's swarm layout (marks/swarm.ts), run in
Python at the chart's size, to count the points that cannot be placed
without overlap, as Seaborn warns when they do not fit.

The browser lays swarms out at the size it draws them; Python cannot know
that size for charts that fill their container, so it lays them out at the
chart's ``width`` and ``height``, or the 640 by 320 pixels static output
uses, with the plot's margins estimated."""

from __future__ import annotations

import math
from collections.abc import Sequence

import numpy as np

#: Pixels left between neighboring points of a swarm, as the core leaves.
CLEARANCE = 0.5
#: The most placed points a point is tested against, as in the core.
MAX_NEIGHBORS = 512
#: The share of each band's step a band axis leaves empty (point marks' padding).
BAND_PADDING = 0.2


def pack(pixels: np.ndarray, radius: float, width: float) -> tuple[int, np.ndarray]:
    """The points at ``pixels`` (along the value axis, ascending), each
    ``radius`` pixels from its center, packed across a band ``width``
    pixels wide as the core packs them: how many stand at its edges, and
    each point's offset from its center."""
    n = len(pixels)
    half = width / 2 - radius
    reach = 2 * radius + CLEARANCE
    placed_value = np.empty(n)
    placed_offset = np.empty(n)
    out = np.empty(n)
    first = placed = edged = 0
    for i in range(n):
        value = pixels[i]
        while first < placed and value - placed_value[first] >= reach:
            first += 1
        offset = 0.0
        free = placed - first <= MAX_NEIGHBORS
        if free and placed > first:
            rise = value - placed_value[first:placed]
            touching = rise < reach
            if touching.any():
                span = np.sqrt(reach * reach - rise[touching] ** 2)
                centers = placed_offset[first:placed][touching]
                offset = _nearest_free(
                    np.sort(centers - span), np.sort(centers + span), half, placed % 2 == 1
                )
        free = free and abs(offset) <= half
        if not free:
            edged += 1
            out[i] = 0.0 if half <= 0 else -half if offset < 0 else half
            continue
        out[i] = offset
        placed_value[placed] = value
        placed_offset[placed] = offset
        placed += 1
    return edged, out


def _nearest_free(starts: np.ndarray, ends: np.ndarray, half: float, left_first: bool) -> float:
    """The offset nearest 0 that no open span covers, given the spans' sorted
    starts and ends: 0, or an end of the run covering it (see the core's
    ``nearestFree``)."""
    count = len(starts)
    open_spans = i = j = 0
    run_from = math.nan
    run_to = math.nan
    while j < count:
        if i < count and starts[i] < ends[j]:
            if open_spans == 0:
                if starts[i] >= 0:
                    return 0.0
                run_from = float(starts[i])
            open_spans += 1
            i += 1
        else:
            open_spans -= 1
            if open_spans == 0 and ends[j] > 0:
                run_to = float(ends[j])
                break
            j += 1
    if not run_to > 0:
        return 0.0
    nearer = run_from if -run_from < run_to or (-run_from == run_to and left_first) else run_to
    left = -run_from <= half
    right = run_to <= half
    if left == right:
        return nearer
    return run_from if left else run_to


def nice(low: float, high: float, count: int) -> tuple[float, float]:
    """``low`` and ``high`` widened to multiples of a round tick step, as the
    core's axes round their domains (scale/ticks.ts ``niceDomain``)."""
    if not (math.isfinite(low) and math.isfinite(high)) or low == high:
        return low, high
    previous = 0.0
    for _ in range(10):
        raw = abs(high - low) / max(1, count)
        step = 10 ** math.floor(math.log10(raw))
        error = raw / step
        step *= (
            10
            if error >= math.sqrt(50)
            else 5
            if error >= math.sqrt(10)
            else 2
            if error >= math.sqrt(2)
            else 1
        )
        if step == previous:
            break
        low, high = math.floor(low / step) * step, math.ceil(high / step) * step
        previous = step
    return low, high


def plot_size(
    width: float,
    height: float,
    *,
    legend: bool,
    title: bool,
    rows: int,
    columns: int,
    label_width: float,
) -> tuple[float, float]:
    """A panel's plot, in pixels, of a chart this large with axis titles:
    its margins as the core lays them out, about (``label_width``, the
    widest value label in pixels, and panels' titles and gaps)."""
    left = 36 + label_width + (0 if columns == 1 and rows == 1 else -15)
    top = 8 + (23 if legend else 0) + (22 if title else 0) + (19 if columns > 1 else 0)
    right = 12 + (21 if rows > 1 else 0)
    plot_width = (width - left - right - 16 * (columns - 1)) / columns
    plot_height = (height - top - 49 - 25 * (rows - 1)) / rows
    return max(plot_width, 1.0), max(plot_height, 1.0)


def value_domain(
    low: float,
    high: float,
    *,
    across: float,
    radius: float,
    log: bool,
    fixed: Sequence[float] | None,
    rounded: bool,
    ticks: int | None,
    zero: bool,
) -> tuple[float, float]:
    """The value axis's domain as the core plans it, ``across`` pixels long,
    for values ``low`` to ``high`` drawn as points ``radius`` pixels wide:
    ``fixed`` as it is, or the values' (with ``zero``, and zero) rounded
    (``rounded``) to round ticks, or on log axes to powers of ten, then
    widened so the outermost points stay inside the plot. On log axes, in
    powers of ten (log10)."""
    if fixed is not None and not (log and min(fixed) <= 0):
        lo, hi = sorted(float(v) for v in fixed)
        return (math.log10(lo), math.log10(hi)) if log else (lo, hi)
    if zero and not log:
        low, high = min(low, 0.0), max(high, 0.0)
    if log:
        lo, hi = math.log10(low), math.log10(high)
        if rounded:
            lo, hi = math.floor(lo), math.ceil(hi)
    else:
        count = ticks if ticks is not None else max(2, round(across / 45))
        lo, hi = nice(low, high, count) if rounded else (low, high)
    span = hi - lo
    pad = span * radius / (across - 2 * radius) if across > 4 * radius and span > 0 else 0.0
    return lo - pad, hi + pad


def unplaced(
    groups: Sequence[np.ndarray],
    domains: Sequence[tuple[float, float]],
    bands: Sequence[int],
    *,
    slots: int,
    radius: float,
    along: float,
    across: float,
) -> list[float]:
    """Each swarm's share of its drawn points that cannot be placed:
    ``groups`` hold each swarm's values (log10 on log axes), ``domains`` its
    panel's value domain (see ``value_domain``), ``across`` pixels long, and
    ``bands`` how many bands share its panel's band axis, ``along`` pixels
    long, with ``slots`` sharing each band. As in the core, points more than
    their radius outside the plot are not drawn, so not laid out."""
    shares = []
    for values, (lo, hi), count in zip(groups, domains, bands, strict=True):
        step = along / (max(1, count) + BAND_PADDING)
        width = step * (1 - BAND_PADDING) / max(1, slots)
        pixels = (values - lo) / (hi - lo) * across if hi > lo else np.full(len(values), across / 2)
        drawn = np.sort(pixels[(pixels >= -radius) & (pixels <= across + radius)])
        shares.append(pack(drawn, radius, width)[0] / len(drawn) if len(drawn) else 0.0)
    return shares
