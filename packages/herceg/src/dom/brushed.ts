// What a brush selected, in data values, and the rules for a selection's
// ranges. Charts keep their selection with these; the drag and its drawing
// (brush.ts) load the first time a chart brushes or shows a selection.

import type { PositionScale } from "../scale/scale.ts";

/** Below this many pixels, a press is a click rather than a drag. */
export const DRAG_THRESHOLD = 3;

/** What a brush selected, in data values. */
export interface Selection {
  /** The x range, ascending; null for brushes along y. */
  x: readonly [number, number] | null;
  /** The y range, ascending; null for brushes along x. */
  y: readonly [number, number] | null;
  /** A lasso's outline as x, y pairs; null for other brushes, whose ranges say it all. */
  lasso: readonly (readonly [number, number])[] | null;
}

export function ascending(a: number, b: number): readonly [number, number] {
  return a <= b ? [a, b] : [b, a];
}

/**
 * A selection on `scale`: ascending, and on a category axis whole category
 * indices within its categories.
 */
export function normalize(scale: PositionScale, a: number, b: number): readonly [number, number] {
  const [lo, hi] = ascending(a, b);
  if (scale.type !== "band") return [lo, hi];
  const last = (scale.categories?.length ?? 1) - 1;
  const index = (value: number) => Math.min(last, Math.max(0, Math.round(value)));
  return [index(lo), index(hi)];
}
