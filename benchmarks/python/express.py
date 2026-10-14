"""Timings of herceg.express, with Seaborn's and statsmodels' computations beside them.

Run from the repository root (see benchmarks/README.md, "Statistical charts"):

    npm run bench:express -- --out results/express.json

Each workload is timed over repeated runs after one warmup run, with its peak
Python memory (tracemalloc) from one more run. Boundaries:

- "compute": the numerical routine alone (no chart);
- "chart": the express function and `to_spec()` (statistics, chart, columns as bytes);
- "recompute": `hx.recompute(chart, data)` and `to_spec()` of a chart made from
  the data before one more x value's rows were appended;
- "svg": `to_svg()` of a chart already built (herceg's static renderer in V8).
"""

from __future__ import annotations

import argparse
import json
import platform
import statistics
import subprocess
import sys
import time
import tracemalloc
import warnings
from datetime import datetime, timezone
from importlib.metadata import version
from pathlib import Path

import numpy as np

import herceg.express as hx
from herceg.express import _numerics as numerics
from herceg.express import _regression as regression

ROOT = Path(__file__).resolve().parents[2]


def measure(make, repeat: int) -> dict:
    make()
    samples = []
    for _ in range(repeat):
        start = time.perf_counter()
        make()
        samples.append((time.perf_counter() - start) * 1000)
    tracemalloc.start()
    make()
    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    return {
        "samples_ms": samples,
        "median_ms": statistics.median(samples),
        "stdev_ms": statistics.stdev(samples) if len(samples) > 1 else 0.0,
        "min_ms": min(samples),
        "max_ms": max(samples),
        "peak_python_mib": peak / 2**20,
    }


def workloads():
    rng = np.random.default_rng(20261010)
    pairs = {f"v{i}": rng.normal(0, 1, 10_000) + i for i in range(5)}
    pairs["group"] = rng.choice(["a", "b", "c"], 10_000)
    matrix = rng.normal(0, 1, (500, 50)) + np.repeat(rng.normal(0, 2, (5, 50)), 100, axis=0)
    big = rng.gamma(2.0, 2.0, 100_000)
    groups = {"g": rng.choice(["a", "b", "c", "d"], 100_000), "v": big}
    x = rng.uniform(0, 10, 10_000)
    y = np.sin(x) + rng.normal(0, 0.3, 10_000)
    delta = 0.01 * float(x.max() - x.min())
    pair_chart = hx.pairplot(pairs, series="group")

    def numpy_linkage(rows):
        return numerics._linkage_numpy(rows, "average", "euclidean")

    yield (
        "pairplot 10,000 x 5, series",
        "chart",
        10,
        lambda: hx.pairplot(pairs, series="group").to_spec(),
    )
    yield "pairplot 10,000 x 5, series", "svg", 5, lambda: pair_chart.to_svg()
    yield (
        "clustermap 500 x 50 (SciPy linkage)",
        "chart",
        10,
        lambda: hx.clustermap(matrix).to_spec(),
    )
    yield "average linkage 500 x 50, NumPy", "compute", 5, lambda: numpy_linkage(matrix)
    yield (
        "bootstrap 1,000 means of 100,000",
        "compute",
        5,
        lambda: numerics.bootstrap_estimates(big, "mean", 1000, 0),
    )
    yield (
        "bootstrap 1,000 medians of 100,000",
        "compute",
        3,
        lambda: numerics.bootstrap_estimates(big, "median", 1000, 0),
    )
    yield (
        "barplot 100,000 rows, 4 groups, CI",
        "chart",
        3,
        lambda: hx.barplot(groups, x="g", y="v", seed=0).to_spec(),
    )
    yield "lowess 10,000, delta 0", "compute", 3, lambda: regression.lowess(x, y)
    yield (
        "lowess 10,000, delta 1% of range",
        "compute",
        5,
        lambda: regression.lowess(x, y, delta=delta),
    )
    # A lineplot of 1,000 timepoints of 10 rows, and one more timepoint.
    series = {"t": np.repeat(np.arange(1000.0), 10), "v": rng.normal(0, 1, 10_000)}
    longer = {
        "t": np.r_[series["t"], np.full(10, 1000.0)],
        "v": np.r_[series["v"], rng.normal(0, 1, 10)],
    }
    lines = hx.lineplot(series, x="t", y="v")
    yield (
        "lineplot 1,000 x values x 10 rows, CI",
        "chart",
        3,
        lambda: hx.lineplot(longer, x="t", y="v").to_spec(),
    )
    yield (
        "lineplot 1,000 x values x 10 rows, CI",
        "recompute",
        5,
        lambda: hx.recompute(lines, longer).to_spec(),
    )
    units = rng.choice(np.arange(20), 1000)
    unit_values = rng.gamma(2.0, 2.0, 1000) + units * 0.1
    unit_ranks = np.unique(units, return_inverse=True)[1]
    yield (
        "bootstrap 1,000 means of 1,000 in 20 units",
        "compute",
        5,
        lambda: numerics.bootstrap_estimates(
            unit_values, "mean", 1000, 0, units=numerics.units_of(unit_ranks)
        ),
    )
    fx = rng.uniform(0, 10, 1000)
    outcome = (rng.uniform(size=1000) < 1 / (1 + np.exp(-(fx - 5)))).astype(float)
    noisy = 1 + 2 * fx + rng.standard_t(2, 1000)
    grid = np.linspace(0, 10, 100)

    def fit_and_band(y_values, model):
        """The fit at the grid and its 95% band, as Seaborn's fit_regression returns them."""
        fitted = regression.fit(fx, y_values, model)(grid)
        boots = regression.bootstrap(fx, y_values, grid, 1000, 0, model=model)
        return fitted, regression.band(boots.predictions, 95)

    yield (
        "logistic fit and band 1,000 rows, 1,000 resamples",
        "compute",
        5,
        lambda: fit_and_band(outcome, "logistic"),
    )
    yield (
        "robust fit and band 1,000 rows, 1,000 resamples",
        "compute",
        5,
        lambda: fit_and_band(noisy, "robust"),
    )
    try:
        from seaborn import algorithms
        from seaborn import regression as seaborn_regression
        from statsmodels.nonparametric.smoothers_lowess import lowess
    except ImportError:
        return
    yield (
        "Seaborn bootstrap 1,000 means of 100,000",
        "compute",
        5,
        lambda: algorithms.bootstrap(big, func="mean", n_boot=1000, seed=0),
    )
    yield (
        "Seaborn bootstrap 1,000 medians of 100,000",
        "compute",
        3,
        lambda: algorithms.bootstrap(big, func="median", n_boot=1000, seed=0),
    )
    yield "statsmodels lowess 10,000, delta 0", "compute", 3, lambda: lowess(y, x)
    yield (
        "statsmodels lowess 10,000, delta 1% of range",
        "compute",
        5,
        lambda: lowess(y, x, delta=delta),
    )
    yield (
        "Seaborn bootstrap 1,000 means of 1,000 in 20 units",
        "compute",
        5,
        lambda: algorithms.bootstrap(unit_values, func="mean", n_boot=1000, units=units, seed=0),
    )

    def seaborn_band(y_values, **model):
        plotter = seaborn_regression._RegressionPlotter(fx, y_values, n_boot=1000, seed=0, **model)
        return plotter.fit_regression(grid=grid)

    yield (
        "Seaborn logistic fit and band 1,000 rows, 1,000 resamples (statsmodels GLM)",
        "compute",
        3,
        lambda: seaborn_band(outcome, logistic=True),
    )
    yield (
        "Seaborn robust fit and band 1,000 rows, 1,000 resamples (statsmodels RLM)",
        "compute",
        3,
        lambda: seaborn_band(noisy, robust=True),
    )


def main() -> None:
    # statsmodels warns of resamples that do not converge, in the references.
    warnings.simplefilter("ignore")
    parser = argparse.ArgumentParser()
    parser.add_argument("--out")
    args = parser.parse_args()
    results = []
    for name, boundary, repeat, make in workloads():
        result = {"workload": name, "boundary": boundary, **measure(make, repeat)}
        results.append(result)
        print(
            f"{name:<48} {boundary:<8} median {result['median_ms']:9.1f} ms  "
            f"min {result['min_ms']:9.1f}  max {result['max_ms']:9.1f}  "
            f"peak {result['peak_python_mib']:7.1f} MiB  (n={repeat})"
        )
    libraries = {}
    for name in ("numpy", "scipy", "seaborn", "statsmodels", "mini-racer"):
        try:
            libraries[name] = version(name)
        except Exception:
            libraries[name] = None
    commit = subprocess.run(
        ["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True
    ).stdout.strip()
    output = {
        "schema": 1,
        "date": datetime.now(timezone.utc).isoformat(),
        "commit": commit,
        "method": __doc__.split("\n\n", 2)[2].strip(),
        "environment": {
            "machine": platform.platform(),
            "processor": platform.processor(),
            "python": sys.version.split()[0],
            "libraries": libraries,
            "input_seed": 20261010,
        },
        "results": results,
    }
    if args.out:
        out = ROOT / "benchmarks" / args.out
        out.write_text(json.dumps(output, indent=1) + "\n")
        print(f"\nWrote {out}")


if __name__ == "__main__":
    main()
