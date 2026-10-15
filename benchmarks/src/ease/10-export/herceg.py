from data import daily

import herceg as hg

chart = hg.line(daily, x="time", y="p50", title="Request latency", y_axis=hg.AxisOptions(title="ms"))
# Static export needs the export extra: pip install 'herceg[export]'.
chart.save("latency.svg")
chart.save("latency.png")
chart.save("latency.pdf")
