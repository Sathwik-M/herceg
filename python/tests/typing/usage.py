"""Type-checked by mypy (`npm run lint:python`), never run: each ignore must be needed."""

from pathlib import Path

import herceg as hg
from herceg.streamlit import ChartState
from herceg.widget import ChartWidget

data = {"t": [1.0, 2.0], "v": [3.0, 4.0]}

hg.line(data, "t", "v", title="Latency", zoom="x", theme="dark")
hg.scatter(data, "t", "v", tooltip=hg.Tooltip(mode="nearest"), animation=None)
hg.bar(data, "t", "v", animation=hg.Animation(duration=400, values=True))
hg.bar(data, "t", "v", animation="slow")  # type: ignore[arg-type]
helper: hg.HelperOptions = {"title": "Saved", "y_axis": hg.AxisOptions(title="ms")}
hg.bar(data, "t", "v", **helper)
chart: hg.ChartOptions = {"title": "Saved", "y": hg.AxisOptions(title="ms"), "facet_columns": 2}
hg.Chart(data, **chart)
hg.bar(data, "t", "v", **chart)  # type: ignore[misc, arg-type]
hg.line(data, "t", "v", titel="typo")  # type: ignore[call-arg]
hg.line(data, "t", "v", zoom="z")  # type: ignore[arg-type]
hg.line(data, "t", "v", stroke="#d62728", stroke_width=2, title="Mark and chart options")
hg.area(data, "t", y1="v", y2="v", fill_opacity=0.3)
hg.line(data, "t", "v", stroke_width="2")  # type: ignore[arg-type]
update: hg.ChartUpdate = {"title": None, "theme": "light"}
not_live: hg.ChartUpdate = {"facet": "host"}  # type: ignore[typeddict-unknown-key]
hg.scatter_3d(data, "t", "v", "v", camera=hg.Camera(azimuth=30), z_axis=hg.AxisOptions(title="z"))
hg.surface(z=[[1.0, 2.0], [3.0, 4.0]], box_aspect=(2, 2, 1), rotate=False)
hg.scatter_3d(data, "t", "v", z=hg.AxisOptions())  # type: ignore[arg-type]

export_chart = hg.line(data, "t", "v")
pdf_bytes: bytes = hg.to_pdf(export_chart, page_size="A4", language="fr-FR")
pdf_pages: bytes = hg.to_pdf(
    (export_chart, export_chart), orientation="landscape", page_size="Letter"
)
hg.save(export_chart, Path("chart.png"), scale=3)
hg.save((export_chart, export_chart), "report.pdf", page_size="A4", margin=36)
export_chart.save(Path("chart.pdf"), subject="Description")
hg.save([export_chart], "report.pdf", page_size="Legal")  # type: ignore[arg-type]
hg.to_pdf(["not a chart"])  # type: ignore[list-item]


def live(widget: ChartWidget, state: ChartState) -> None:
    widget.viewport = (1.0, 2.0)
    widget.viewport = hg.Viewport(x=(1.0, 2.0), y=(0.0, 5.0))
    widget.viewport = None
    widget.selection = hg.Selection(y=("a", "b"), lasso=((0.0, 1.0), (1.0, 1.0), (1.0, 0.0)))
    widget.selection = ("a", "c")
    widget.viewport = "x"  # type: ignore[assignment]
    widget.viewport.x[0]  # type: ignore[index]
    widget.on_select(lambda selection: selection and selection.lasso)
    widget.on_viewport(lambda viewport: viewport.y_right)
    widget.drill_root = ('[0,"East"]',)
    widget.drill_root = None
    widget.item_positions = {'[0,"a"]': (1.0, 2.0)}
    widget.on_drill(lambda root: root and root[-1])
    widget.on_item_move(lambda positions: positions.get('[0,"a"]'))
    root: hg.DrillRoot | None = state.drill_root
    positions: hg.ItemPositions = state.item_positions
    print(root, positions)
    widget.on_click(lambda inspection: [point.row for point in inspection.points])
    if state.selection is not None:
        print(state.selection.y)


# Linkage trees share the portable mark API; there is no clustermap helper yet.
hg.Chart({"first": [0], "second": [1], "height": [2]}).dendrogram(
    "first", "second", "height", leaves=["a", "b"], side="right", stroke_width=2
)

links = {"a": ["x", "y"], "b": ["y", "z"]}
hg.graph(links, "a", "b", layout="layered")
hg.graph(links, "a", "b", layout={"type": "circular", "sort": "name"})
hg.graph(links, "a", "b", layout="tree")  # type: ignore[arg-type]

# Dash strings are typed on every Python surface that takes dash.
dash_style: hg.Dash = "-."
hg.line({"x": [0, 1], "y": [1, 2]}, "x", "y", dash=dash_style)
hg.Chart({"x": [0, 1], "y": [1, 2]}).line("x", "y", dash=":").rule(y=1, dash="--")
