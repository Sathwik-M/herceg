"""Export one chart, or a sequence of charts as a PDF document."""

from __future__ import annotations

from collections.abc import Sequence
from os import PathLike
from pathlib import Path

from . import _render
from ._chart import Chart


def to_pdf(
    chart_or_charts: Chart | Sequence[Chart],
    *,
    page_size: _render.PdfPageSize | None = None,
    orientation: _render.PdfOrientation | None = None,
    margin: float | None = None,
    title: str | None = None,
    subject: str | None = None,
    language: str | None = None,
    fonts: _render.PdfFonts | None = None,
    fallback: Sequence[str] = (),
    missing_glyph: str | None = None,
) -> bytes:
    """Return vector PDF bytes, with one chart per page (requires the export extra).

    Chart-sized pages default to zero margin; A4 and Letter default to 36
    points (72 per inch). Fonts are subset once across all pages. Use
    subplots for several views on one page. Metadata leaves chart titles intact.
    """
    items = [chart_or_charts] if isinstance(chart_or_charts, Chart) else chart_or_charts
    if not isinstance(items, Sequence):
        raise TypeError(
            "to_pdf charts: expected a Chart or sequence of Charts; supply herceg charts"
        )
    if not items:
        raise ValueError("to_pdf charts: expected at least one chart; supply a nonempty sequence")
    for i, chart in enumerate(items):
        if not isinstance(chart, Chart):
            raise TypeError(f"to_pdf charts[{i}]: expected a Chart; supply herceg charts")
    pages = [chart.to_spec() for chart in items]
    return _render.pdf(
        [spec for spec, _ in pages],
        [buffers for _, buffers in pages],
        page_size=page_size,
        orientation=orientation,
        margin=margin,
        title=title,
        subject=subject,
        language=language,
        fonts=fonts,
        fallback=fallback,
        missing_glyph=missing_glyph,
    )


def save(
    chart_or_charts: Chart | Sequence[Chart],
    path: str | PathLike[str],
    *,
    scale: float = 2,
    page_size: _render.PdfPageSize | None = None,
    orientation: _render.PdfOrientation | None = None,
    margin: float | None = None,
    title: str | None = None,
    subject: str | None = None,
    language: str | None = None,
    fonts: _render.PdfFonts | None = None,
    fallback: Sequence[str] = (),
    missing_glyph: str | None = None,
) -> None:
    """Save a chart by extension, or a nonempty sequence to a .pdf path.

    A single chart delegates to Chart.save; sequences use to_pdf's settings.
    """
    if isinstance(chart_or_charts, Chart):
        chart_or_charts.save(
            path,
            scale=scale,
            page_size=page_size,
            orientation=orientation,
            margin=margin,
            title=title,
            subject=subject,
            language=language,
            fonts=fonts,
            fallback=fallback,
            missing_glyph=missing_glyph,
        )
        return
    target = Path(path)
    if target.suffix.lower() != ".pdf":
        raise ValueError(
            "save path: a sequence of charts requires PDF export; "
            "use a .pdf extension or save each chart separately"
        )
    try:
        content = to_pdf(
            chart_or_charts,
            page_size=page_size,
            orientation=orientation,
            margin=margin,
            title=title,
            subject=subject,
            language=language,
            fonts=fonts,
            fallback=fallback,
            missing_glyph=missing_glyph,
        )
    except (ValueError, TypeError) as error:
        raise type(error)(str(error).replace("to_pdf", "save")) from None
    target.write_bytes(content)
