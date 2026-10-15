"""A Herceg chart in a Streamlit app: brush a time range to summarize it,
click the chart to see the values there.

    pip install 'herceg[streamlit,pandas]'
    streamlit run python/examples/streamlit_app.py
"""

import numpy as np
import pandas as pd
import streamlit as st

import herceg as hg
import herceg.streamlit as hst


@st.cache_data
def latency() -> pd.DataFrame:
    """A day of per-minute request latency percentiles."""
    rng = np.random.default_rng(7)
    time = pd.date_range("2026-01-01", periods=24 * 60, freq="min")
    daily = 40 + 15 * np.sin(np.linspace(0, 2 * np.pi, len(time)))
    p50 = daily + rng.normal(0, 3, len(time))
    p99 = p50 * 2.5 + rng.gamma(2, 8, len(time))
    return pd.DataFrame({"time": time, "p50": p50, "p99": p99})


st.title("Request latency")
df = latency()
slo = st.slider("SLO (ms)", 50, 250, 150, step=10)

chart = (
    hg.Chart(
        df,
        title="Latency by minute",
        height=360,
        brush="x",
        y=hg.AxisOptions(title="ms"),
        time_zone="UTC",
    )
    .line(x="time", y=["p50", "p99"])
    .rule(y=slo, label="SLO")
)
state = hst.chart(chart, key="latency", on_select="rerun", on_click="rerun")

if state.selection is None or state.selection.x is None:
    st.caption("Drag across the chart to select a time range.")
else:
    start, end = state.selection.x
    selected = df[df["time"].between(start, end)]
    over = int((selected["p99"] > slo).sum())
    st.subheader(f"{start:%H:%M} to {end:%H:%M} UTC")
    left, middle, right = st.columns(3)
    left.metric("Minutes", f"{len(selected):,}")
    middle.metric("Median p50", f"{selected['p50'].median():.0f} ms")
    right.metric("Minutes over the SLO", f"{over:,}")

if state.click is not None:
    values = ", ".join(f"{point.label} {point.text} ms" for point in state.click.points)
    st.info(f"Clicked {state.click.label}: {values}")
