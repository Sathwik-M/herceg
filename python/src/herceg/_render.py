"""Output: HTML with herceg embedded, notebook display, and static SVG and PNG."""

from __future__ import annotations

import atexit
import base64
import html as _html
import json
import tempfile
import uuid
import webbrowser
from functools import cache
from importlib.resources import files
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ._chart import Chart


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
            "Static SVG and PNG export need the `export` extra: pip install 'herceg[export]'"
        ) from error
    engine = MiniRacer()
    # V8's thread must be stopped before interpreter shutdown, which
    # otherwise waits for it forever.
    atexit.register(engine.close)
    engine.eval(asset("herceg-static.js"))
    return engine


def svg(spec: dict[str, Any], buffers: list[bytes]) -> str:
    """Standalone SVG, rendered by herceg's DOM-free renderer in an embedded V8."""
    return _engine().call("hercegStatic.svg", json.dumps(spec), _encoded(buffers))


def png(svg_text: str, *, scale: float) -> bytes:
    try:
        import resvg_py
    except ImportError as error:
        raise ImportError(
            "PNG export needs the `export` extra: pip install 'herceg[export]'"
        ) from error
    return bytes(resvg_py.svg_to_bytes(svg_string=svg_text, zoom=scale))


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
