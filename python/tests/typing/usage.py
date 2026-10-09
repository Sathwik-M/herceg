"""Type-checked by mypy (`npm run lint:python`), never run: each ignore must be needed."""

import herceg as hg

data = {"t": [1.0, 2.0], "v": [3.0, 4.0]}

hg.line(data, "t", "v", title="Latency", zoom="x", theme="dark")
hg.scatter(data, "t", "v", tooltip=hg.Tooltip(mode="nearest"), animation=None)
helper: hg.HelperOptions = {"title": "Saved", "y_axis": hg.Axis(label="ms")}
hg.bar(data, "t", "v", **helper)
chart: hg.ChartOptions = {"title": "Saved", "y": hg.Axis(label="ms"), "facet_columns": 2}
hg.Chart(data, **chart)
hg.bar(data, "t", "v", **chart)  # type: ignore[misc, arg-type]
hg.line(data, "t", "v", titel="typo")  # type: ignore[call-arg]
hg.line(data, "t", "v", zoom="z")  # type: ignore[arg-type]
update: hg.ChartUpdate = {"title": None, "theme": "light"}
not_live: hg.ChartUpdate = {"facet": "host"}  # type: ignore[typeddict-unknown-key]
