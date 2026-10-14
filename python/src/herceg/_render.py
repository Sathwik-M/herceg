"""Output: HTML with herceg embedded, notebook display, and static SVG, PNG, and PDF."""

from __future__ import annotations

import atexit
import base64
import html as _html
import json
import math
import tempfile
import uuid
import webbrowser
from collections.abc import Mapping, Sequence
from functools import cache
from importlib.resources import files
from os import PathLike
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal, cast

from ._data import shown

if TYPE_CHECKING:
    from ._chart import Chart

FontData = bytes | str | PathLike[str]
FontWeight = Literal["normal", "bold"]
Fonts = Mapping[str, FontData | Mapping[FontWeight, FontData]]
PdfPageSize = Literal["A4", "Letter"]
PdfOrientation = Literal["portrait", "landscape"]
_FONT_LIMIT = 32 * 1024 * 1024


def asset_path(name: str) -> Path:
    """A JavaScript bundle shipped in the package (built by `npm run build:python`)."""
    path = Path(str(files("herceg") / "static" / name))
    if not path.is_file():
        raise RuntimeError(
            f"herceg's JavaScript bundle ({name}) is missing. In a source checkout, "
            "run `npm run build:python` from the repository root."
        )
    return path


def asset(name: str) -> str:
    return asset_path(name).read_text(encoding="utf-8")


def _encoded(buffers: list[bytes]) -> list[str]:
    return [base64.b64encode(buffer).decode("ascii") for buffer in buffers]


_SCRIPT_ESCAPES = {
    ord("<"): "\\u003c",
    ord(">"): "\\u003e",
    ord("&"): "\\u0026",
    0x2028: "\\u2028",
    0x2029: "\\u2029",
}


def _script_json(value: Any) -> str:
    """JSON safe inside a <script> element: no character can end or alter it."""
    return json.dumps(value, separators=(",", ":")).translate(_SCRIPT_ESCAPES)


def html(spec: dict[str, Any], buffers: list[bytes], *, full_page: bool = True) -> str:
    """HTML that renders the chart: the herceg bundle, the spec, and base64 buffers."""
    element = f"herceg-{uuid.uuid4().hex[:12]}"
    width = f"{spec['width']}px" if "width" in spec else "100%"
    height = f"{spec.get('height', 320)}px"
    # Fragments on one page share the first runtime, so charts with the same
    # `sync` name share cursor and zoom.
    body = (
        f'<div id="{element}" style="width:{width};height:{height}"></div>\n'
        f"<script>if (!window.hercegPython) {{\n{asset('herceg.js')}\n}}</script>\n"
        f"<script>hercegPython.render(document.getElementById({_script_json(element)}), "
        f"{_script_json(spec)}, {_script_json(_encoded(buffers))});</script>"
    )
    if not full_page:
        return body
    title = _html.escape(spec.get("title", "Chart"))
    return (
        '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
        f"<title>{title}</title>\n"
        "<style>body{margin:0;padding:8px;font-family:system-ui,sans-serif}</style>\n"
        f"</head>\n<body>\n{body}\n</body>\n</html>\n"
    )


def notebook_html(spec: dict[str, Any], buffers: list[bytes], *, height: int | None) -> str:
    """The chart in an isolated iframe, as notebooks display it."""
    page = html(spec, buffers)
    frame_height = (height or 320) + 20
    return (
        f'<iframe srcdoc="{_html.escape(page, quote=True)}" '
        f'style="width:100%;height:{frame_height}px;border:0" '
        'sandbox="allow-scripts"></iframe>'
    )


@cache
def _engine() -> Any:
    try:
        from py_mini_racer import MiniRacer
    except ImportError as error:
        raise ImportError(
            "Static SVG, PNG, and PDF export need the `export` extra: pip install 'herceg[export]'"
        ) from error
    engine = MiniRacer()
    # V8's thread must be stopped before interpreter shutdown, which
    # otherwise waits for it forever.
    atexit.register(engine.close)
    engine.eval(asset("herceg-static.js"))
    return engine


def _call(function: str, *args: Any) -> str:
    """Calls an export of the embedded renderer, which returns its output, or
    ``{"error": message}`` for what it refuses (a spec it does not accept, a
    font it cannot embed): raised here as a ValueError with herceg's message.
    The engine's own failures (out of memory, a timeout) propagate as they are."""
    result = _engine().call(function, *args)
    if isinstance(result, str):
        return result
    raise ValueError(result["error"])


def svg(spec: dict[str, Any], buffers: list[bytes], *, fonts: Fonts | None = None) -> str:
    """Standalone SVG, rendered by herceg's DOM-free renderer in an embedded V8."""
    return _svg(spec, buffers, _font_faces(fonts, "to_svg"), location="to_svg")


def _svg(
    spec: dict[str, Any],
    buffers: list[bytes],
    faces: list[dict[str, str]],
    *,
    location: str,
    raster: bool = False,
) -> str:
    try:
        return _call(
            "hercegStatic.svg", json.dumps(spec), _encoded(buffers), json.dumps(faces), raster
        )
    except ValueError as error:
        message = str(error)
        if message.startswith("fonts:"):
            message = f"{location} {message}"
        raise ValueError(message) from None


def _font_faces(fonts: Fonts | None, location: str) -> list[dict[str, str]]:
    """Validate and read the same font mapping for every static export."""
    sources = []
    for family, source in (fonts or {}).items():
        weights = source if isinstance(source, Mapping) else {"normal": source}
        for weight, data in weights.items():
            if weight not in ("normal", "bold"):
                raise ValueError(
                    f'{location} fonts: expected weights "normal" or "bold"; '
                    f"received {shown(weight)}"
                )
            sources.append((family, weight, data))
            if len(sources) > 64:
                raise ValueError(
                    f"{location} fonts: export supports at most 64 font faces; give fewer"
                )
    for family, weight, data in sources:
        if isinstance(data, bytes) and len(data) > _FONT_LIMIT:
            raise ValueError(
                f"{location} fonts: the {shown(family)} {weight} face exceeds the 32 MiB limit"
            )
    faces = []
    for family, weight, data in sources:
        if isinstance(data, bytes):
            raw = data
        else:
            with Path(data).open("rb") as font_file:
                raw = font_file.read(_FONT_LIMIT + 1)
            if len(raw) > _FONT_LIMIT:
                raise ValueError(
                    f"{location} fonts: the {shown(family)} {weight} face exceeds the 32 MiB limit"
                )
        faces.append(
            {"family": family, "weight": weight, "data": base64.b64encode(raw).decode("ascii")}
        )
    return faces


def pdf(
    spec: dict[str, Any] | list[dict[str, Any]],
    buffers: list[bytes] | list[list[bytes]],
    *,
    fonts: Fonts | None = None,
    fallback: Sequence[str] = (),
    missing_glyph: str | None = None,
    page_size: PdfPageSize | None = None,
    orientation: PdfOrientation | None = None,
    margin: float | None = None,
    title: str | None = None,
    subject: str | None = None,
    language: str | None = None,
) -> bytes:
    """Vector PDF, with one chart per page, rendered in embedded V8."""
    if page_size is not None and page_size not in ("A4", "Letter"):
        raise ValueError(
            'to_pdf page_size: expected "A4" or "Letter"; omit it for chart-sized pages'
        )
    if orientation is not None and (
        page_size is None or orientation not in ("portrait", "landscape")
    ):
        raise ValueError(
            'to_pdf orientation: expected "portrait" or "landscape" with page_size; '
            "supply a named paper size"
        )
    if margin is not None and (
        isinstance(margin, bool)
        or not isinstance(margin, (int, float))
        or not math.isfinite(margin)
        or margin < 0
    ):
        raise ValueError(
            "to_pdf margin: expected finite nonnegative points; supply zero or a positive margin"
        )
    faces = _font_faces(fonts, "to_pdf")
    if not faces and (fallback or missing_glyph is not None):
        raise ValueError(
            "to_pdf fallback and missing_glyph: choose among embedded fonts; "
            "supply fonts, or leave them out"
        )
    options: dict[str, Any] = {"fonts": faces, "fallback": list(fallback)}
    if missing_glyph is not None:
        options["missingGlyph"] = missing_glyph
    options.update(
        {
            key: value
            for key, value in {
                "pageSize": page_size,
                "orientation": orientation,
                "margin": margin,
                "title": title,
                "subject": subject,
                "language": language,
            }.items()
            if value is not None
        }
    )
    encoded_buffers = (
        [_encoded(page) for page in cast(list[list[bytes]], buffers)]
        if isinstance(spec, list)
        else _encoded(cast(list[bytes], buffers))
    )
    try:
        encoded = _call("hercegStatic.pdf", json.dumps(spec), encoded_buffers, json.dumps(options))
    except ValueError as error:
        raise ValueError(
            str(error)
            .replace("renderToPDF", "to_pdf")
            .replace("specToPDF", "to_pdf")
            .replace("pageSize", "page_size")
        ) from None
    return base64.b64decode(encoded)


def png(
    spec: dict[str, Any], buffers: list[bytes], *, scale: float, fonts: Fonts | None = None
) -> bytes:
    try:
        import resvg_py
    except ImportError as error:
        raise ImportError(
            "PNG export needs the `export` extra: pip install 'herceg[export]'"
        ) from error
    faces = _font_faces(fonts, "to_png")
    if not faces:
        return bytes(
            resvg_py.svg_to_bytes(svg_string=_svg(spec, buffers, [], location="to_png"), zoom=scale)
        )
    rendered = json.loads(_svg(spec, buffers, faces, location="to_png", raster=True))
    families = {}
    for face in faces:
        family = face["family"].strip().strip("\"'").strip()
        families[family.lower()] = family
    # resvg takes filenames, including for byte inputs. These renamed copies
    # are local to this export and removed on success or failure.
    with tempfile.TemporaryDirectory(prefix="herceg-fonts-") as directory:
        paths = []
        for index, encoded in enumerate(rendered["fonts"]):
            path = Path(directory) / f"{index}.ttf"
            path.write_bytes(base64.b64decode(encoded))
            paths.append(str(path))
        return bytes(
            resvg_py.svg_to_bytes(
                svg_string=rendered["svg"],
                zoom=scale,
                font_files=paths,
                skip_system_fonts=True,
                sans_serif_family=families.get("sans-serif"),
                serif_family=families.get("serif"),
                monospace_family=families.get("monospace"),
                cursive_family=families.get("cursive"),
                fantasy_family=families.get("fantasy"),
            )
        )


def show(chart: Chart) -> None:
    """Notebook display when running under IPython, otherwise a browser tab."""
    try:
        from IPython import get_ipython
        from IPython.display import display

        if get_ipython() is not None:
            display(chart)
            return
    except ImportError:
        pass
    with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False, encoding="utf-8") as file:
        file.write(chart.to_html())
    webbrowser.open(f"file://{file.name}")
