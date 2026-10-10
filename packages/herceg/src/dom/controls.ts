// What a chart of a layout mark loads to be navigated by pointer and
// keyboard: turning a 3D chart (orbit.ts), panning and zooming a map
// (map-controls.ts), drilling into a treemap or sunburst (drill.ts), and
// moving a network's nodes (node-drag.ts). The mark names the module
// (`LayoutMark.controls`), so other charts never download it. Controls
// listen on the chart's root themselves and change the chart through its
// public methods (the viewport, the camera, the selection) or, for drills
// and node moves, the items' state, which reports them as the public
// methods do; each command starts from the state asked
// for so far, drawn or not, so commands faster than frames add up.

import type { Controls } from "../model/item-views.ts";
import type { ChartModel } from "../model/model.ts";
import type { Chart } from "./handle.ts";

/** What a chart lends its controls. */
export interface ControlsHost {
  readonly chart: Chart;
  /** What the chart drew last: its items, and for maps the plane's scales. */
  readonly model: ChartModel;
  /** The pointer overlay, above the marks, where controls draw outlines (a lasso). */
  readonly overlay: SVGGElement;
  /** Reads a sentence aloud through the chart's live region. */
  announce(text: string): void;
  /** Draws again on the next frame, for changes no public method reports (a node being dragged). */
  invalidate(): void;
  /** Whether an event's target is the chart's drawing, not its legend. */
  onPlot(target: EventTarget | null): boolean;
  /** The key of the item the keyboard cursor is on, if it is on one. */
  cursor(): string | undefined;
}

export type { Controls };

/** A controls module, as `LayoutMark.controls` loads it. */
export interface ControlsModule {
  Controls: new (host: ControlsHost) => Controls;
}
