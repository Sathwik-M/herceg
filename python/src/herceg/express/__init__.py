"""herceg.express: statistical charts in one call, as Seaborn makes them.

::

    import herceg.express as hx

    hx.barplot(tips, x="day", y="total_bill", hue="sex", seed=1)
    hx.histplot(penguins, x="flipper_length_mm", hue="species", kde=True)
    hx.pairplot(penguins, hue="species")

Each function computes its statistics with NumPy (bootstrap intervals,
regression fits, kernel densities, clustering) and returns an ordinary
``herceg.Chart`` of herceg's marks, which displays, saves, and updates
like any other. ``hx.statistics(chart)`` returns what was computed.
"""

from ._arrangements import clustermap, jointplot, pairplot
from ._categorical import boxplot, stripplot, violinplot
from ._common import Statistics, statistics
from ._distributions import KdeOptions, ecdfplot, histplot, kdeplot, rugplot
from ._estimates import barplot, lineplot, pointplot
from ._fits import regplot, residplot

__all__ = [
    "KdeOptions",
    "Statistics",
    "barplot",
    "boxplot",
    "clustermap",
    "ecdfplot",
    "histplot",
    "jointplot",
    "kdeplot",
    "lineplot",
    "pairplot",
    "pointplot",
    "regplot",
    "residplot",
    "rugplot",
    "statistics",
    "stripplot",
    "violinplot",
]
