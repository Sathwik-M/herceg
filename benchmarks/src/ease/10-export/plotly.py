import plotly.express as px
from data import daily

fig = px.line(daily, x="time", y="p50", title="Request latency", labels={"p50": "ms"})
# Static images need Kaleido (pip install kaleido), which also writes PDF.
fig.write_image("latency.svg", width=640, height=320)
fig.write_image("latency.png", width=640, height=320, scale=2)
fig.write_image("latency.pdf", width=640, height=320)
