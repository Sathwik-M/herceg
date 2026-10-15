// Where the keyboard cursor stops in a panel, and how it steps through
// cells, read from what the panel's inspector drew. The interaction
// controller (dom/interaction.ts) uses these, handing in the code it shares
// with the chart (see `InteractionKit`), so that they load with it.

import type { placeAt, rowOf, Series, samePositions } from "../marks/series.ts";
import type { AxisInspection, Inspector } from "./inspect.ts";
import type { ChartModel } from "./model.ts";

/**
 * The series of a panel the keyboard stops at, in order. An inspection
 * along x (or y) reports every series with a point at exactly that place,
 * so series inspected along an axis share a stop when they share their
 * positions along it (several fields of one table); every other shown
 * series, and each inspected point by point or cell by cell, is a stop of
 * its own.
 */
export function keyboardStops(
  inspector: Inspector | undefined,
  same: typeof samePositions,
): Series[] {
  const shared: { axis: "x" | "y"; series: Series }[] = [];
  return (inspector?.marks ?? []).flatMap(({ mark, visible: series }) =>
    series.filter((s) => {
      const axis = mark.tooltip;
      if (axis !== "x" && axis !== "y") return true;
      if (shared.some((p) => p.axis === axis && same(p.series, s, axis))) return false;
      shared.push({ axis, series: s });
      return true;
    }),
  );
}

/**
 * For series the keyboard reads cell by cell (heatmaps): the position of
 * the cell `columns` to the right and `rows` up from the one at `position`
 * in the series keyed `key`, as the panel draws them, or undefined when
 * there is none.
 */
export function stepCell(
  inspector: Inspector | undefined,
  key: string,
  position: number,
  columns: number,
  rows: number,
): number | undefined {
  const found = inspector?.marks.find(({ series }) => series.some((s) => s.key === key));
  const s = found?.series.find((part) => part.key === key);
  return s && found!.mark.stepCell?.(s, position, columns, rows, inspector!.frame);
}

/**
 * The axis a panel's data is placed along, which a cursor follows: y when
 * its marks are placed along y (horizontal bars), otherwise x.
 */
export function cursorAxis(inspectors: readonly (Inspector | undefined)[]): "x" | "y" {
  return inspectors.some((inspector) =>
    inspector?.marks.some(({ mark, series }) => mark.tooltip === "y" && series.length > 0),
  )
    ? "y"
    : "x";
}

/** What `inspectPosition` reads series with, handed in (see `InteractionKit`). */
export interface SeriesReaders {
  placeAt: typeof placeAt;
  rowOf: typeof rowOf;
}

/**
 * Inspects one point of a series, identified by its position, plus the
 * other visible series at its x (or its y, for marks inspected along y),
 * in panel `panel` (the first by default). The keyboard reads so, as it
 * must reach every point even where values repeat.
 */
export function inspectPosition(
  model: ChartModel,
  key: string,
  position: number,
  panel: string | undefined,
  { placeAt, rowOf }: SeriesReaders,
): AxisInspection | undefined {
  const at = panel ?? model.panels()[0]?.key;
  const inspector = at === undefined ? undefined : model.inspectorOf(at);
  if (!inspector) return undefined;
  const series = inspector.marks.flatMap(({ visible }) => visible);
  const ownerOf = (s: Series) => inspector.marks.find(({ series }) => series.includes(s))!.mark;
  const anchor = series.find((s) => s.key === key);
  if (!anchor || position < 0 || position >= anchor.length) return undefined;
  const axis = ownerOf(anchor).tooltip === "y" ? "y" : "x";
  const value = placeAt(anchor, axis, rowOf(anchor, position));
  // The cursor needs a place along its axis; a point that is not drawn
  // there (a zero on a log axis, say) leaves the other series' points.
  const scale = inspector.frame[axis];
  if (!Number.isFinite(scale.map(value)) || (scale.type === "band" && value < 0)) return undefined;
  const along = series.filter((s) => ownerOf(s).tooltip === axis);
  const inspection = inspector.inspectAt(
    axis,
    value,
    along.includes(anchor) ? along : [anchor],
    undefined,
    anchor,
    position,
  );
  // Nothing drawn at this position: no tooltip rather than an empty one.
  if (inspection.points.length === 0) return undefined;
  return model.namesPanels ? { ...inspection, panel: at! } : inspection;
}
