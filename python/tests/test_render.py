import base64
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

import herceg as hg

ROOT = Path(__file__).resolve().parents[2]
DATA = {
    "t": np.array(
        ["2026-01-01T00:00", "2026-01-01T00:01", "2026-01-01T00:02"], dtype="datetime64[ms]"
    ),
    "v": np.array([3.0, 1.0, 2.0]),
    "host": ["a", "b", "a"],
}


def chart():
    return (
        hg.Chart(DATA, title="Latency", width=400, height=200, locale="en-US", time_zone="UTC")
        .line(x="t", y="v")
        .rule(y=2, label="limit")
    )


def test_html_embeds_herceg_and_the_data():
    page = chart().to_html()
    assert page.startswith("<!doctype html>")
    assert "hercegPython.render(" in page
    assert "<title>Latency</title>" in page
    fragment = chart().to_html(full_page=False)
    assert not fragment.startswith("<!doctype") and "<script>" in fragment


def test_notebook_display_is_an_isolated_iframe():
    output = chart()._repr_html_()
    assert output.startswith("<iframe srcdoc=") and 'sandbox="allow-scripts"' in output


def test_svg_matches_the_typescript_renderer(tmp_path):
    svg = chart().to_svg()
    assert svg.startswith("<svg") and "Latency" in svg and "limit" in svg
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is needed to compare with the TypeScript renderer")
    spec, buffers = chart().to_spec()
    loader = (ROOT / "packages" / "herceg" / "src" / "from-spec.ts").as_uri()
    entry = tmp_path / "render.mts"
    entry.write_text(
        f"const {{ specToSVG }} = await import({json.dumps(loader)});\n"
        "const { readFileSync } = await import('node:fs');\n"
        "const input = JSON.parse(readFileSync(0, 'utf8'));\n"
        "const buffers = input.buffers.map((b) => Buffer.from(b, 'base64'));\n"
        "process.stdout.write(specToSVG(input.spec, buffers));\n",
        encoding="utf-8",
    )
    payload = json.dumps({"spec": spec, "buffers": [base64.b64encode(b).decode() for b in buffers]})
    result = subprocess.run(
        [node, "--experimental-strip-types", str(entry)],
        input=payload,
        capture_output=True,
        text=True,
        check=True,
    )

    def same_ids(text: str) -> str:
        return re.sub(r"herceg-svg-\d+", "id", text)

    assert same_ids(svg) == same_ids(result.stdout)


def test_png_export(tmp_path):
    path = tmp_path / "chart.png"
    chart().save(str(path))
    assert path.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"
    with pytest.raises(ValueError, match="Unknown file type"):
        chart().save(str(tmp_path / "chart.gif"))


def test_titles_and_labels_cannot_break_out_of_the_script():
    nasty = "<!--<script></script><img src=x onerror=alert(1)>"
    page = (
        hg.Chart({"x": [1, 2], "y": [3, 4], nasty: ["a", nasty]}, title=nasty)
        .line(x="x", y="y", series=nasty)
        .to_html()
    )
    script = page.split("hercegPython.render(", 1)[1]
    assert "<" not in script.split("</script>", 1)[0]


def test_fragments_on_one_page_share_one_runtime():
    fragment = chart().to_html(full_page=False)
    assert "if (!window.hercegPython)" in fragment


def test_export_does_not_keep_the_interpreter_alive():
    code = (
        "import herceg as hg; "
        "print(len(hg.line({'x': [1, 2], 'y': [3, 4]}, x='x', y='y').to_svg()) > 0)"
    )
    result = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, timeout=60, check=True
    )
    assert result.stdout.strip() == "True"
