"""herceg.express: Seaborn's statistical charts in one call.

::

    import herceg.express as hx

    hx.barplot(tips, x="day", y="total_bill", series="sex", seed=1)
    hx.histplot(penguins, x="flipper_length_mm", series="species", kde=True)
    hx.pairplot(penguins, series="species")

Each function computes its statistics with NumPy (bootstrap intervals,
regression fits, kernel densities, clustering) and returns an ordinary
``herceg.Chart`` of herceg's marks, which displays, saves, and updates
like any other. Functions take herceg's names for what they share with
its charts: ``series`` and ``series_order`` split the marks, the chart
options ``facet_row`` and ``facet_column`` facet them (with statistics
computed per panel), and options such as ``normalize``, ``whiskers``, and
``jitter`` mean what they mean in ``herceg.Chart``'s marks.
``hx.statistics(chart)`` returns what was computed, and
``hx.recompute(chart, data)`` makes the chart again from new data, with the
same arguments and seed.
"""

from ._arrangements import clustermap, jointplot, pairplot
from ._categorical import boxenplot, boxplot, stripplot, swarmplot, violinplot
from ._common import ExpressOptions, Statistics, recompute, statistics
from ._distributions import KdeOptions, ecdfplot, histplot, kdeplot, rugplot
from ._estimates import barplot, lineplot, pointplot
from ._fits import regplot, residplot

__all__ = [
    "ExpressOptions",
    "KdeOptions",
    "Statistics",
    "barplot",
    "boxenplot",
    "boxplot",
    "clustermap",
    "ecdfplot",
    "histplot",
    "jointplot",
    "kdeplot",
    "lineplot",
    "pairplot",
    "pointplot",
    "recompute",
    "regplot",
    "residplot",
    "rugplot",
    "statistics",
    "stripplot",
    "swarmplot",
    "violinplot",
]
