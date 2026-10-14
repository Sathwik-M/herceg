import base64
import json
import re
import shutil
import struct
import subprocess
import sys
from io import BytesIO
from pathlib import Path

import numpy as np
import pytest

import herceg as hg
from herceg import _render

ROOT = Path(__file__).resolve().parents[2]
FONT_FIXTURES = ROOT / "packages/herceg/test/fixtures/pdf-fonts"
UNICODE_TEXT = "é Δ Ω Мир 𝌀"
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


def test_what_the_renderer_refuses_raises_its_message():
    # Python leaves theme names to the spec's checks; the error is the renderer's
    # message alone, without V8's report of where in the bundle it was thrown.
    themed = hg.Chart(DATA, theme="drak").line(x="t", y="v")  # type: ignore[arg-type]
    with pytest.raises(ValueError) as refused:
        themed.to_svg()
    assert str(refused.value) == (
        'spec.theme: expected "light", "dark", "high-contrast", "high-contrast-dark", '
        'or "auto"; received "drak"'
    )
    # Messages carrying the caller's text keep it whole, line breaks included.
    family = "No\n\n    at family"
    with pytest.raises(ValueError) as refused:
        unicode_chart().to_pdf(fonts=unicode_fonts(), fallback=[family])
    assert str(refused.value) == f"PDF fallback family {family.lower()} is not registered"


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


def test_pdf_matches_the_typescript_renderer(tmp_path):
    pdf = chart().to_pdf()
    assert pdf.startswith(b"%PDF-1.4\n") and pdf.endswith(b"%%EOF\n")
    # The cross-reference table is where the trailer says it is.
    start = int(pdf.rsplit(b"startxref\n", 1)[1].split(b"\n", 1)[0])
    assert pdf[start : start + 5] == b"xref\n"
    title = "".join(f"{ord(c):04X}" for c in "Latency")
    assert f"/Title <FEFF{title}>".encode() in pdf
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is needed to compare with the TypeScript renderer")
    spec, buffers = chart().to_spec()
    loader = (ROOT / "packages" / "herceg" / "src" / "from-spec.ts").as_uri()
    entry = tmp_path / "render.mts"
    entry.write_text(
        f"const {{ specToPDF }} = await import({json.dumps(loader)});\n"
        "const { readFileSync } = await import('node:fs');\n"
        "const input = JSON.parse(readFileSync(0, 'utf8'));\n"
        "const buffers = input.buffers.map((b) => Buffer.from(b, 'base64'));\n"
        "process.stdout.write(specToPDF({spec: input.spec, buffers}));\n",
        encoding="utf-8",
    )
    payload = json.dumps({"spec": spec, "buffers": [base64.b64encode(b).decode() for b in buffers]})
    result = subprocess.run(
        [node, "--experimental-strip-types", str(entry)],
        input=payload.encode(),
        capture_output=True,
        check=True,
    )
    assert pdf == result.stdout


def test_pdf_export(tmp_path):
    path = tmp_path / "chart.PDF"
    chart().save(str(path))
    assert path.read_bytes() == chart().to_pdf()


def unicode_chart(title=UNICODE_TEXT):
    return hg.Chart(DATA, title=title, width=400, height=200, theme={"font": "Fixture"}).line(
        x="t", y="v"
    )


def unicode_fonts():
    return {
        "Fixture": {
            "normal": FONT_FIXTURES / "sans.ttf",
            "bold": (FONT_FIXTURES / "sans-bold.ttf").read_bytes(),
        },
        "Symbols": str(FONT_FIXTURES / "symbols.ttf"),
    }


@pytest.mark.parametrize("embedded", [False, True])
def test_pdf_is_tagged_with_the_chart_alternative(embedded):
    rendered = unicode_chart() if embedded else chart()
    pdf = (
        rendered.to_pdf(fonts=unicode_fonts(), fallback=["Symbols"])
        if embedded
        else rendered.to_pdf()
    )
    assert b"/MarkInfo << /Marked true >>" in pdf
    assert b"/Type /StructTreeRoot" in pdf
    assert b"/S /Document" in pdf
    assert b"/S /Figure" in pdf
    assert b"/StructParents 0" in pdf
    assert re.search(rb"/Nums \[0 \[\d+ 0 R\]\]", pdf)
    alt = re.search(rb"/Alt <FEFF([0-9A-F]*)>", pdf)
    assert alt is not None
    text = bytes.fromhex(alt[1].decode()).decode("utf-16-be")
    assert text.startswith((UNICODE_TEXT if embedded else "Latency") + " Line chart with 1 series.")
    assert "v: 3 points, from 1 to 3, last 2." in text
    if not embedded:
        assert b"/Lang (en-US)" in pdf


def test_unicode_pdf_accepts_paths_and_bytes_and_matches_typescript(tmp_path):
    fonts = unicode_fonts()
    pdf = unicode_chart().to_pdf(fonts=fonts, fallback=["Symbols"])
    assert b"/Subtype /Type0" in pdf and b"/FontFile2" in pdf and b"/ToUnicode" in pdf
    path = tmp_path / "unicode.PDF"
    unicode_chart().save(str(path), fonts=fonts, fallback=["Symbols"])
    assert path.read_bytes() == pdf
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is needed to compare with the TypeScript renderer")
    spec, buffers = unicode_chart().to_spec()
    loader = (ROOT / "packages/herceg/src/from-spec.ts").as_uri()
    pdf_loader = (ROOT / "packages/herceg/src/pdf.ts").as_uri()
    entry = tmp_path / "unicode.mts"
    entry.write_text(
        f"const {{ specToPDF }} = await import({json.dumps(loader)});\n"
        f"const {{ pdfFonts }} = await import({json.dumps(pdf_loader)});\n"
        "import { readFileSync } from 'node:fs';\n"
        "const input = JSON.parse(readFileSync(0, 'utf8'));\n"
        "const decode = b => Buffer.from(b, 'base64');\n"
        "const { fonts, ...options } = input.options;\n"
        "const prepared = pdfFonts(fonts.map(f => ({...f, data: decode(f.data)})), options);\n"
        "const output = specToPDF({spec: input.spec, buffers: input.buffers.map(decode)},\n"
        "  {fonts: prepared});\n"
        "process.stdout.write(output);\n",
        encoding="utf-8",
    )
    faces = []
    for family, source in fonts.items():
        weights = source if isinstance(source, dict) else {"normal": source}
        for weight, data in weights.items():
            raw = data if isinstance(data, bytes) else Path(data).read_bytes()
            faces.append(
                {"family": family, "weight": weight, "data": base64.b64encode(raw).decode()}
            )
    payload = {
        "spec": spec,
        "buffers": [base64.b64encode(b).decode() for b in buffers],
        "options": {"fonts": faces, "fallback": ["Symbols"]},
    }
    result = subprocess.run(
        [node, "--experimental-strip-types", str(entry)],
        input=json.dumps(payload).encode(),
        capture_output=True,
        check=True,
    )
    assert pdf == result.stdout
    assert unicode_chart().to_pdf(fonts=fonts, fallback=["Symbols"]) == pdf


def test_unicode_pdf_requires_coverage_and_allows_explicit_replacement():
    with pytest.raises(Exception, match="U\\+96EA.*supply a covering font"):
        unicode_chart("雪").to_pdf(fonts=unicode_fonts())
    assert unicode_chart("雪").to_pdf(fonts=unicode_fonts(), missing_glyph="?").startswith(b"%PDF")
    with pytest.raises(
        ValueError, match="to_pdf fallback and missing_glyph: choose among embedded"
    ):
        chart().to_pdf(missing_glyph="?")
    with pytest.raises(ValueError, match="supply fonts, or leave them out"):
        chart().to_pdf(fallback=["Symbols"])


@pytest.mark.parametrize("title", ["مرحبا", "שלום", "नमस्ते", "\U00010940", "\U00013430", "\u0378"])
def test_unicode_pdf_refuses_text_outside_the_allowlist_before_replacement(title):
    with pytest.raises(Exception, match=rf"U\+{ord(title[0]):04X}"):
        unicode_chart(title).to_pdf(fonts=unicode_fonts(), missing_glyph="?")


def test_unicode_pdf_segmentation_with_and_without_intl():
    engine = _render._engine()
    has_segmenter = engine.eval(
        'typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"'
    )
    # Exercise whichever runtime is installed, then force the conservative path.
    titles = ["e\u0301", "ｶﾞ", "ﾊﾟ"]
    if has_segmenter:
        for text in titles:
            assert (
                engine.eval(
                    f'Array.from(new Intl.Segmenter("und", {{granularity: "grapheme"}})'
                    f".segment({json.dumps(text)})).length"
                )
                == 1
            )
    native = [
        unicode_chart(text).to_pdf(fonts=unicode_fonts(), missing_glyph="?") for text in titles
    ]
    engine.eval("globalThis.__hercegTestIntl = globalThis.Intl; globalThis.Intl = undefined")
    try:
        for text, expected in zip(titles, native, strict=True):
            assert unicode_chart(text).to_pdf(fonts=unicode_fonts(), missing_glyph="?") == expected
        for text in ["a\u200dB", "★\ufe0f", "👍🏽"]:
            with pytest.raises(Exception, match="SVG/PNG"):
                unicode_chart(text).to_pdf(fonts=unicode_fonts(), missing_glyph="?")
    finally:
        engine.eval(
            "globalThis.Intl = globalThis.__hercegTestIntl; delete globalThis.__hercegTestIntl"
        )


def test_unicode_pdf_rejects_malformed_fonts_and_non_pdf_font_options(tmp_path):
    with pytest.raises(Exception, match="Malformed PDF font"):
        chart().to_pdf(fonts={"Fixture": b"bad"}, fallback=["Fixture"])
    with pytest.raises(ValueError, match="save fonts: an option of PDF export"):
        chart().save(str(tmp_path / "chart.svg"), fonts=unicode_fonts())


def test_pdf_counts_weighted_faces_before_reading_or_encoding(monkeypatch):
    def unexpected(*args, **kwargs):
        pytest.fail("font transport started before the face count was checked")

    monkeypatch.setattr(Path, "open", unexpected)
    monkeypatch.setattr(_render.base64, "b64encode", unexpected)
    monkeypatch.setattr(_render, "_engine", unexpected)
    fonts = {f"Font {i}": {"normal": "missing.ttf", "bold": "missing.ttf"} for i in range(33)}
    with pytest.raises(ValueError, match="to_pdf fonts: a PDF embeds at most 64 font faces"):
        chart().to_pdf(fonts=fonts)


def test_pdf_checks_all_byte_lengths_before_reading_or_encoding(monkeypatch):
    def unexpected(*args, **kwargs):
        pytest.fail("font transport started before byte lengths were checked")

    monkeypatch.setattr(Path, "open", unexpected)
    monkeypatch.setattr(_render.base64, "b64encode", unexpected)
    monkeypatch.setattr(_render, "_engine", unexpected)
    with pytest.raises(
        ValueError, match='to_pdf fonts: the "Large" normal face exceeds the 32 MiB limit'
    ):
        chart().to_pdf(fonts={"Path": "missing.ttf", "Large": bytes(32 * 1024 * 1024 + 1)})


def test_pdf_bounds_path_reads_before_encoding(monkeypatch):
    limit = 32 * 1024 * 1024
    reads = []

    class FontFile(BytesIO):
        def read(self, size=-1):
            reads.append(size)
            assert size == limit + 1
            return bytes(size)

    def unexpected(*args, **kwargs):
        pytest.fail("oversized path was encoded or sent to V8")

    monkeypatch.setattr(Path, "open", lambda self, mode: FontFile())
    monkeypatch.setattr(_render.base64, "b64encode", unexpected)
    monkeypatch.setattr(_render, "_engine", unexpected)
    with pytest.raises(
        ValueError, match='to_pdf fonts: the "Large" normal face exceeds the 32 MiB limit'
    ):
        chart().to_pdf(fonts={"Large": "large.ttf"})
    assert reads == [limit + 1]


def test_unicode_pdf_preserves_composed_and_decomposed_input():
    pdf = unicode_chart("íí A·B OʼBrien ä").to_pdf(fonts=unicode_fonts())
    assert pdf.startswith(b"%PDF")
    with pytest.raises(Exception, match="cannot position combining sequence"):
        unicode_chart("x́").to_pdf(fonts=unicode_fonts())


@pytest.mark.parametrize("flags", [2, 0x200])
def test_unicode_pdf_rejects_restricted_embedding(flags):
    font = bytearray((FONT_FIXTURES / "sans.ttf").read_bytes())
    for index in range(struct.unpack_from(">H", font, 4)[0]):
        at = 12 + index * 16
        if font[at : at + 4] == b"OS/2":
            offset = struct.unpack_from(">I", font, at + 8)[0]
            struct.pack_into(">H", font, offset + 8, flags)
    with pytest.raises(Exception, match="fsType"):
        unicode_chart().to_pdf(fonts={"Fixture": bytes(font)})


@pytest.mark.skipif(shutil.which("pdftotext") is None, reason="Poppler is not installed")
def test_unicode_pdf_text_extraction(tmp_path):
    path = tmp_path / "unicode.pdf"
    unicode_chart().save(str(path), fonts=unicode_fonts(), fallback=["Symbols"])
    result = subprocess.run(
        ["pdftotext", str(path), "-"], capture_output=True, text=True, check=True
    )
    assert UNICODE_TEXT in result.stdout


def test_png_export(tmp_path):
    path = tmp_path / "chart.png"
    chart().save(str(path))
    assert path.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"
    with pytest.raises(
        ValueError, match='save path: expected a ".html", ".svg", ".png", or ".pdf" file'
    ):
        chart().save(str(tmp_path / "chart.gif"))


@pytest.mark.parametrize("extension", ["html", "svg", "png", "PDF"])
def test_module_save_dispatches_single_charts_like_chart_save(tmp_path, extension):
    item = chart()
    path = tmp_path / f"module.{extension}"
    options = {"page_size": "A4", "title": "Report"} if extension == "PDF" else {}
    hg.save(item, path, scale=3, **options)
    item.save(tmp_path / f"method.{extension}", scale=3, **options)
    actual = path.read_bytes()
    expected = (tmp_path / f"method.{extension}").read_bytes()
    if extension in ("html", "svg"):
        # HTML mount IDs and SVG resource IDs are unique for each export.
        pattern = rb"herceg-[0-9a-f]{12}\b|herceg-svg-\d+"
        actual = re.sub(pattern, b"id", actual)
        expected = re.sub(pattern, b"id", expected)
    assert actual == expected
    if extension == "png":
        assert path.read_bytes() == item.to_png(scale=3)
    assert not hasattr(hg, "save_pdf")


@pytest.mark.parametrize("extension", ["html", "svg", "png", "gif", ""])
@pytest.mark.parametrize("sequence", [list, tuple])
def test_module_save_requires_pdf_for_chart_sequences(tmp_path, extension, sequence):
    path = tmp_path / (f"report.{extension}" if extension else "report")
    with pytest.raises(
        ValueError,
        match=r"save path:.*; use a .pdf extension or save each chart separately",
    ):
        hg.save(sequence([chart()]), path)
    assert not path.exists()


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


def test_pdf_document_matches_typescript_with_independent_buffers(tmp_path):
    charts = [chart(), hg.Chart({"x": [50, 60], "y": [90, 100]}, title="Second").line(x="x", y="y")]
    options = {"page_size": "Letter", "orientation": "landscape", "margin": 40, "title": "Report"}
    pdf = hg.to_pdf(charts, **options)
    assert b"/Count 2" in pdf
    assert pdf.count(b"/MediaBox [0 0 792 612]") == 2
    assert pdf.count(b"/S /Document") == 1 and pdf.count(b"/S /Figure") == 2
    assert b"/StructParents 0" in pdf and b"/StructParents 1" in pdf
    assert b"/ParentTreeNextKey 2" in pdf and b"/Lang (en)" in pdf
    assert "Report".encode("utf-16-be").hex().upper().encode() in pdf
    alternatives = re.findall(rb"/Alt <FEFF([0-9A-F]*)>", pdf)
    assert "Latency" in bytes.fromhex(alternatives[0].decode()).decode("utf-16-be")
    assert "Second" in bytes.fromhex(alternatives[1].decode()).decode("utf-16-be")
    path = tmp_path / "report.PDF"
    hg.save(charts, path, **options)
    assert path.read_bytes() == pdf
    pages = [c.to_spec() for c in charts]
    payload = {
        "pages": [
            {"spec": spec, "buffers": [base64.b64encode(b).decode() for b in buffers]}
            for spec, buffers in pages
        ]
    }
    loader = (ROOT / "packages/herceg/src/from-spec.ts").as_uri()
    entry = tmp_path / "document.mts"
    entry.write_text(
        f"const {{ specToPDF }} = await import({json.dumps(loader)});\n"
        "const { readFileSync } = await import('node:fs');\n"
        "const { pages } = JSON.parse(readFileSync(0, 'utf8'));\n"
        "const decoded = pages.map(p => ({spec: p.spec,\n"
        "buffers: p.buffers.map(b => Buffer.from(b, 'base64'))}));\n"
        "process.stdout.write(specToPDF(decoded, {pageSize: 'Letter', orientation: 'landscape',\n"
        "margin: 40, title: 'Report'}));\n",
        encoding="utf-8",
    )
    result = subprocess.run(
        ["node", "--experimental-strip-types", str(entry)],
        input=json.dumps(payload).encode(),
        capture_output=True,
        check=True,
    )
    assert result.stdout == pdf
    assert hg.to_pdf([chart()], title="Latency", language="en-US").startswith(b"%PDF")


def test_pdf_document_embeds_each_face_once_and_preserves_later_glyphs(tmp_path):
    charts = [unicode_chart("é"), unicode_chart("Ω Мир 𝌀")]
    fonts = unicode_fonts()
    pdf = hg.to_pdf(charts, fonts=fonts, fallback=["Symbols"], title="Unicode report")
    assert pdf.count(b"/FontFile2") == 3  # normal, bold, and symbol fallback
    first = hg.to_pdf(charts, fonts=fonts, fallback=["Symbols"], title="Unicode report")
    unicode_chart("Other").to_pdf(fonts=fonts)
    assert hg.to_pdf(charts, fonts=fonts, fallback=["Symbols"], title="Unicode report") == first
    path = tmp_path / "unicode-report.pdf"
    hg.save(charts, path, fonts=fonts, fallback=["Symbols"], title="Unicode report")
    assert path.read_bytes() == pdf
    if shutil.which("pdftotext"):
        text = subprocess.run(
            ["pdftotext", str(path), "-"], capture_output=True, text=True, check=True
        ).stdout
        assert "é" in text and "Ω Мир 𝌀" in text and "\f" in text


@pytest.mark.parametrize(
    "options, location",
    [
        ({"page_size": "Legal"}, "page_size"),
        ({"orientation": "landscape"}, "orientation"),
        ({"margin": -1}, "margin"),
        ({"margin": float("nan")}, "margin"),
        ({"margin": float("inf")}, "margin"),
        ({"page_size": "A4", "margin": 300}, "margin"),
    ],
)
def test_pdf_page_options_validate_in_python(options, location):
    with pytest.raises(ValueError, match=f"to_pdf {location}:"):
        hg.to_pdf([chart()], **options)
    with pytest.raises(ValueError, match=f"to_pdf {location}:"):
        chart().to_pdf(**options)


def test_pdf_document_rejects_empty_and_non_chart_pages(tmp_path):
    with pytest.raises(ValueError, match="to_pdf charts:.*; supply"):
        hg.to_pdf([])
    with pytest.raises(TypeError, match=r"to_pdf charts\[1\]:.*; supply"):
        hg.to_pdf([chart(), "invalid"])
    with pytest.raises(ValueError, match="save charts:"):
        hg.save([], tmp_path / "report.pdf")
    assert not (tmp_path / "report.pdf").exists()
    with pytest.raises(ValueError, match="save path:"):
        hg.save([chart()], tmp_path / "report.svg")
    with pytest.raises(ValueError, match="save page_size:"):
        chart().save(tmp_path / "chart.svg", page_size="A4")
    chart().save(tmp_path / "single.pdf", page_size="A4", title="Report")
    assert (tmp_path / "single.pdf").read_bytes() == chart().to_pdf(page_size="A4", title="Report")


@pytest.mark.parametrize(
    "options",
    [
        {},
        {"margin": 0},
        {"page_size": "A4"},
        {"title": "Report"},
        {"language": "en-GB"},
        {"subject": "Report description"},
    ],
)
def test_single_pdf_metadata_matches_module_sequence_and_paper_options(tmp_path, options):
    item = hg.Chart(
        {"x": [0, 1], "y": [2, 3]},
        title="Chart title",
        description="Chart description",
        locale="de-DE",
    ).line(x="x", y="y")
    pdf = item.to_pdf(**options)
    assert hg.to_pdf(item, **options) == pdf
    assert hg.to_pdf([item], **options) == pdf
    assert hg.to_pdf((item,), **options) == pdf
    title = options.get("title", "Chart title")
    subject = options.get("subject", "Chart description")
    assert b"/Title <FEFF" + title.encode("utf-16-be").hex().upper().encode() + b">" in pdf
    assert b"/Subject <FEFF" + subject.encode("utf-16-be").hex().upper().encode() + b">" in pdf
    language = options.get("language", "de-DE")
    assert f"/Lang ({language})".encode() in pdf
    hg.save(item, tmp_path / "module.pdf", **options)
    item.save(tmp_path / "method.pdf", **options)
    assert (tmp_path / "module.pdf").read_bytes() == pdf
    assert (tmp_path / "method.pdf").read_bytes() == pdf


def test_mixed_pdf_languages_scope_visible_content_and_english_alternatives():
    import zlib

    charts = [
        hg.Chart({"x": [0, 1], "y": [2, 3]}, locale=locale).line(x="x", y="y")
        for locale in ["de-DE", "fr-FR"]
    ]
    pdf = hg.to_pdf(charts, language="en-GB")
    assert b"/Lang (en-GB)" in pdf
    figures = re.findall(rb"/Type /StructElem /S /Figure .*? >>", pdf)
    assert len(figures) == 2 and all(b"/Lang" not in figure for figure in figures)
    streams = [
        zlib.decompress(data) for data in re.findall(rb"stream\n(.*?)\nendstream", pdf, re.DOTALL)
    ]
    for locale in ["de-DE", "fr-FR"]:
        matching = [
            content
            for content in streams
            if f"/Span << /Lang ({locale}) >> BDC".encode() in content
        ]
        assert len(matching) == 1
        content = matching[0]
        assert content.index(b"/Figure << /MCID 0 >> BDC") < content.index(b"/Span")
        assert content.endswith(b"EMC\nEMC\n")


@pytest.mark.parametrize("locale, language", [("en-US", "fr-FR"), ("fr-FR", "en-US")])
@pytest.mark.parametrize("shape", ["single", "list", "tuple", "multiple"])
@pytest.mark.parametrize("embedded", [False, True])
def test_pdf_summary_language_uses_catalog_not_chart_locale(
    tmp_path, locale, language, shape, embedded
):
    import zlib

    item = hg.Chart({"x": [0, 1], "y": [2, 3]}, locale=locale, theme={"font": "Fixture"}).line(
        x="x", y="y"
    )
    charts = {
        "single": item,
        "list": [item],
        "tuple": (item,),
        "multiple": [item, item],
    }[shape]
    options = {"language": language}
    if embedded:
        options["fonts"] = unicode_fonts()
    pdf = hg.to_pdf(charts, **options)
    catalog = re.search(rb"/Type /Catalog [^\n]*", pdf)[0]
    assert f"/Lang ({language})".encode() in catalog
    figures = re.findall(rb"/Type /StructElem /S /Figure .*? >>", pdf)
    assert len(figures) == (2 if shape == "multiple" else 1)
    for figure in figures:
        summary = re.search(rb"/Alt <FEFF([0-9A-F]*)>", figure)[1]
        assert (
            bytes.fromhex(summary.decode())
            .decode("utf-16-be")
            .startswith("Line chart with 1 series.")
        )
        if language == "fr-FR":
            assert b"/Lang (en)" in figure
        else:
            assert b"/Lang" not in figure
    streams = [
        zlib.decompress(data) for data in re.findall(rb"stream\n(.*?)\nendstream", pdf, re.DOTALL)
    ]
    assert sum(f"/Span << /Lang ({locale}) >> BDC".encode() in data for data in streams) == len(
        figures
    )
    hg.save(charts, tmp_path / "module.pdf", **options)
    assert (tmp_path / "module.pdf").read_bytes() == pdf
    if shape == "single":
        assert item.to_pdf(**options) == pdf
        item.save(tmp_path / "method.pdf", **options)
        assert (tmp_path / "method.pdf").read_bytes() == pdf


def test_pdf_module_validates_chart_sequences_and_reports_fitting_correction(tmp_path):
    with pytest.raises(TypeError, match="to_pdf charts:.*; supply"):
        hg.to_pdf(42)
    with pytest.raises(TypeError, match=r"save charts\[1\]:.*; supply"):
        hg.save([chart(), "invalid"], tmp_path / "invalid.pdf")
    assert not (tmp_path / "invalid.pdf").exists()
    with pytest.raises(TypeError, match="save charts:.*; supply"):
        hg.save(42, tmp_path / "invalid.pdf")
    large = hg.Chart(width=1e16, height=320)
    with pytest.raises(ValueError, match="to_pdf scale:.*; reduce chart dimensions or margins"):
        hg.to_pdf(large, page_size="A4")
    with pytest.raises(ValueError, match="save scale:.*; reduce chart dimensions or margins"):
        large.save(tmp_path / "too-large.pdf", page_size="A4")
    assert not (tmp_path / "too-large.pdf").exists()
    with pytest.raises(ValueError, match="save scale:.*; reduce chart dimensions or margins"):
        hg.save([large], tmp_path / "too-large.pdf", page_size="A4")
    assert not (tmp_path / "too-large.pdf").exists()
    with pytest.raises(ValueError, match="save subject:.*; save to a .pdf path or drop subject"):
        chart().save(tmp_path / "chart.svg", subject="Description")
