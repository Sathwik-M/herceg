// How exports outside the core (herceg/pdf) draw a mounted chart's current
// state: through a method keyed by a symbol, so that the chart handle has
// no method of theirs and the core carries none of their code.

import type { Fonts } from "../fonts/registry.ts";
import type { ChartModel } from "../model/model.ts";
import type { Scene } from "../scene/scene.ts";

export const EXPORT_SCENE: unique symbol = Symbol("herceg.exportScene");
export const EXPORT_FONTS: unique symbol = Symbol("herceg.exportFonts");

/** A mounted chart, as exports read it. */
export interface ExportsScene {
  /**
   * Draws what is pending, as `toSVG` does, and calls `use` with a scene of
   * the chart's current state (size, zoom, hidden series) and its model.
   */
  [EXPORT_SCENE]<T>(use: (scene: Scene, model: ChartModel) => T): T;
  /** The fonts the chart measures its text with, which an export draws it in. */
  readonly [EXPORT_FONTS]: Fonts | undefined;
}
