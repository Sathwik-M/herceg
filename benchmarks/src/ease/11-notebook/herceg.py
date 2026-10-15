# A notebook cell: the chart is the cell's value, which the notebook displays.
from data import services

import herceg as hg

chart = hg.line(
    services,
    x="time",
    y="latency",
    series="service",
    title="Latency by service",
    y_axis=hg.AxisOptions(title="ms"),
)
chart  # noqa: B018 (a notebook displays the value of a cell's last line)
