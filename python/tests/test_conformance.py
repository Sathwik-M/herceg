"""The cases the Python package and the engine both meet, read from the
engine's fixtures (packages/herceg/test/fixtures): which column splits
series, the errors a chart refuses its options with, and the spec of
marks whose series the legend lists as one entry per value."""

import json
from pathlib import Path
from typing import Any

import pytest

import herceg as hg
from herceg._errors import python_path
from herceg._series import series_of

FIXTURES = Path(__file__).parents[2] / "packages" / "herceg" / "test" / "fixtures"


def fixture(name: str) -> dict[str, Any]:
    return json.loads((FIXTURES / name).read_text())


INFERENCE = fixture("series-inference.json")
ERRORS = fixture("chart-errors.json")
IDENTITY = fixture("color-identity.json")


def python_args(mark: dict[str, Any]) -> dict[str, Any]:
    """A spec mark's options as the Python method takes them: channels as
    ``hg.Channel``."""
    args = {name: value for name, value in mark.items() if name not in ("type", "encode")}
    if "encode" in mark:
        args["encode"] = {
            python_path(name): hg.Channel(**channel) for name, channel in mark["encode"].items()
        }
    return args


@pytest.mark.parametrize("case", INFERENCE["cases"], ids=lambda case: case["name"])
def test_series_inference(case):
    options = case["options"]
    if options.get("series") is not None:
        pytest.skip("an explicit series is the method's own")
    paint = "stroke" if case["mark"] == "line" else "fill"
    kinds = INFERENCE["fields"]
    found = series_of(
        options.get("color"), options.get("encode"), options.get(paint), paint, kinds.get
    )
    assert found == case["series"]


@pytest.mark.parametrize("case", ERRORS["cases"], ids=lambda case: case["name"])
def test_chart_errors(case):
    mark = case["mark"]
    chart = hg.Chart(ERRORS["data"])
    with pytest.raises(hg.ChartError) as raised:
        getattr(chart, mark["type"])(**python_args(mark))
        chart.to_spec()
    error = raised.value
    assert (error.code, error.path) == (case["code"], case.get("python_path", case["path"]))
    assert case["python"] in str(error)


@pytest.mark.parametrize(
    "case", [case for case in IDENTITY["cases"] if "python" in case], ids=lambda case: case["name"]
)
def test_identity_specs(case):
    spec = case["spec"]
    options: dict[str, Any] = {}
    if "panels" in spec:
        options["panels"] = [panel["id"] for panel in spec["panels"]]
    if "x" in spec:
        options["x"] = spec["x"]
    chart = hg.Chart(spec["data"]["data"]["columns"], **options)
    for call in case["python"]:
        getattr(chart, call["method"])(**call["args"])
    made, _ = chart.to_spec()
    assert made["marks"] == spec["marks"]
    assert made.get("panels") == spec.get("panels")
