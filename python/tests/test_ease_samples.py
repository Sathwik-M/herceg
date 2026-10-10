"""Runs the Python samples of the common-task comparison (benchmarks/src/ease).

docs/comparison.md ("Common tasks") counts their lines; running them here
keeps them working. Plotly's samples run where Plotly (and, for static
images, Kaleido) is installed; the test environment has neither.
"""

import runpy
import sys
from pathlib import Path

import pytest

SAMPLES = Path(__file__).resolve().parents[2] / "benchmarks" / "src" / "ease"


@pytest.fixture
def run(monkeypatch, tmp_path):
    """Runs a sample as a script in a temporary directory; returns its globals."""
    monkeypatch.syspath_prepend(str(SAMPLES))
    monkeypatch.chdir(tmp_path)
    monkeypatch.delitem(sys.modules, "data", raising=False)

    def run(path: str) -> dict:
        return runpy.run_path(str(SAMPLES / path))

    return run


def test_herceg_notebook_chart(run):
    chart = run("11-notebook/herceg.py")["chart"]
    spec, _ = chart.to_spec()
    [mark] = spec["marks"]
    assert mark["type"] == "line" and mark["series"] == "service"
    assert spec["y"] == {"title": "ms"}
    assert chart._repr_html_().startswith("<iframe srcdoc=")


def test_plotly_notebook_chart(run):
    pytest.importorskip("plotly", reason="Plotly is not installed in the test environment")
    fig = run("11-notebook/plotly.py")["fig"]
    assert [trace.name for trace in fig.data] == ["api", "web", "db"]


def test_herceg_export(run, tmp_path):
    pytest.importorskip("py_mini_racer", reason="static export needs herceg[export]")
    run("10-export/herceg.py")
    assert (tmp_path / "latency.svg").read_text().startswith("<svg")
    assert (tmp_path / "latency.png").read_bytes().startswith(b"\x89PNG")
    assert (tmp_path / "latency.pdf").read_bytes().startswith(b"%PDF-")


def test_plotly_export(run, tmp_path):
    pytest.importorskip("plotly", reason="Plotly is not installed in the test environment")
    pytest.importorskip("kaleido", reason="Plotly's static export needs Kaleido")
    run("10-export/plotly.py")
    assert (tmp_path / "latency.png").read_bytes().startswith(b"\x89PNG")
    assert (tmp_path / "latency.pdf").read_bytes().startswith(b"%PDF-")
