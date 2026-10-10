"""The data of data.ts as pandas DataFrames, for the Python samples."""

import math

import pandas as pd

DAY = 86_400_000
START = 1_767_225_600_000  # 2026-01-01 in epoch milliseconds
SERVICES = ["api", "web", "db"]

days = [START + i * DAY for i in range(60)]
p50 = [round(120 + 25 * math.sin(i / 5) + 8 * math.sin(i * 1.7)) for i in range(60)]

daily = pd.DataFrame({"time": pd.to_datetime(days, unit="ms"), "p50": p50})

services = pd.DataFrame(
    [
        {
            "time": pd.to_datetime(time, unit="ms"),
            "service": service,
            "latency": round(80 + 40 * s + 20 * math.sin(i / 4 + s)),
        }
        for s, service in enumerate(SERVICES)
        for i, time in enumerate(days)
    ]
)
