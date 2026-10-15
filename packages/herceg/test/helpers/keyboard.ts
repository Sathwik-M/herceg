// The keyboard cursor's stops and steps as the chart's interaction
// controller finds them (model/keyboard.ts), for tests of what charts draw.

import { placeAt, rowOf, samePositions } from "../../src/marks/series.ts";
import { cursorAxis, inspectPosition, keyboardStops, stepCell } from "../../src/model/keyboard.ts";
import type { ChartModel } from "../../src/model/model.ts";

/** The series of panel `panel` the keyboard stops at. */
export function stopsOf(model: ChartModel, panel: string) {
  return keyboardStops(model.inspectorOf(panel), samePositions);
}

/** The cell the keyboard steps to from `position` in panel `panel`'s series keyed `key`. */
export function cellOf(
  model: ChartModel,
  panel: string,
  key: string,
  position: number,
  columns: number,
  rows: number,
) {
  return stepCell(model.inspectorOf(panel), key, position, columns, rows);
}

/** The axis the chart's cursor follows. */
export function axisOf(model: ChartModel) {
  return cursorAxis(model.panels().map(({ key }) => model.inspectorOf(key)));
}

/** The keyboard cursor's inspection at `position` of the series keyed `key`, in `panel` (the first by default). */
export function positionOf(model: ChartModel, key: string, position: number, panel?: string) {
  return inspectPosition(model, key, position, panel, { placeAt, rowOf });
}
