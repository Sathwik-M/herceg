// Where a cursor at a shared value reads each series when it snaps to one
// side of it (`CursorSnap`: "previous" or "next"): readings at other
// frequencies than the chart that shares the value. The interaction
// controller (dom/interaction.ts) uses this, handing in the code it shares
// with the chart (see `InteractionKit`), so that it loads with it.

import type { lowerPosition, Series, xAt } from "../marks/series.ts";
import type { InspectedPoint } from "./inspect.ts";
import type { ChartModel, Inspection } from "./model.ts";

/** What `inspectSnapped` reads series with, handed in. */
export interface SnapReaders {
  lowerPosition: typeof lowerPosition;
  xAt: typeof xAt;
}

/** Points a search steps over to leave a gap of points not drawn, as "nearest-x" does. */
const GAP_WALK = 1024;

/** In a sorted series, the first position whose x is past `value`, by binary search. */
function upper(s: Series, value: number, xAt: SnapReaders["xAt"]): number {
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (xAt(s, mid) <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Every series' point in panel `panel` on the side of `value` (along x)
 * that `snap` names: its last at or before it ("previous"), or its first at
 * or after it ("next"), among the points in view, found by binary search;
 * series with none show nothing. The inspection is at the latest of those
 * points ("previous") or the earliest ("next"); undefined when there are none.
 */
export function inspectSnapped(
  model: ChartModel,
  panel: string,
  value: number,
  snap: "previous" | "next",
  { lowerPosition, xAt }: SnapReaders,
): Inspection | undefined {
  const inspector = model.inspectorOf(panel);
  if (!inspector) return undefined;
  const { x } = inspector.frame;
  const lo = Math.min(...x.domain);
  const hi = Math.max(...x.domain);
  const { breaks } = x;
  const back = snap === "previous";
  const points: InspectedPoint[] = [];
  let at = back ? -Infinity : Infinity;
  for (const { mark, visible } of inspector.marks) {
    // The series a cursor along x reads, as "nearest-x" reads them.
    if (mark.tooltip === "cell" || (mark.place && mark.tooltip !== "x")) continue;
    for (const s of visible) {
      if (!s.sorted) continue;
      // Backward from the last position at or before the value; forward from the first at or after it.
      let k = back ? upper(s, value, xAt) - 1 : lowerPosition(s, value);
      for (let walked = 0; walked < GAP_WALK; walked++, k += back ? -1 : 1) {
        // Points an axis break leaves out are jumped, however many.
        if (breaks && k >= 0 && k < s.length)
          k = back
            ? breaks.shownBefore(s.x, k, s.rows)
            : breaks.shownFrom(s.x, k, s.length, s.rows);
        if (k < 0 || k >= s.length) break;
        const shown = xAt(s, k);
        if (shown < lo || shown > hi) break;
        // A point not drawn (a missing value) has none: the search goes on.
        const [point] = inspector.inspectAt("x", shown, [s], inspector.axisOf(mark), s, k).points;
        if (!point) continue;
        points.push(point);
        at = back ? Math.max(at, shown) : Math.min(at, shown);
        break;
      }
    }
  }
  if (points.length === 0) return undefined;
  const inspection = { ...inspector.inspectAt("x", at, []), points };
  return model.namesPanels ? { ...inspection, panel } : inspection;
}
