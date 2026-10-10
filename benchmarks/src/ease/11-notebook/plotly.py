# A notebook cell: the figure is the cell's value, which the notebook displays.
import plotly.express as px
from data import services

fig = px.line(
    services,
    x="time",
    y="latency",
    color="service",
    title="Latency by service",
    labels={"latency": "ms"},
)
fig  # noqa: B018 (a notebook displays the value of a cell's last line)
