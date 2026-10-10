// Mounts the controls a layout mark's chart asks for (see controls.ts). The
// chart loads this module first, only when it draws such a mark, and it
// loads the one family's controls, so a map never downloads a 3D chart's.

import type { LayoutControls } from "../marks/layout-mark.ts";
import type { Controls, ControlsHost, ControlsModule } from "./controls.ts";
import type { Emitter } from "./events.ts";

/** What a chart lends its controls, as it has them. */
export interface ChartParts
  extends Pick<ControlsHost, "chart" | "model" | "overlay" | "invalidate"> {
  /** The live region, which reads sentences aloud. */
  live: HTMLElement;
  events: Emitter;
  /** The chart's legend, whose presses are its own. */
  legend: HTMLElement;
  /** The key of the item the keyboard cursor is on; "" for a panel with none. */
  cursor(): string | undefined;
}

function load(kind: LayoutControls["kind"]): Promise<ControlsModule> {
  switch (kind) {
    case "orbit":
      return import("./orbit.ts");
    case "map":
      return import("./map-controls.ts");
    case "drill":
      return import("./drill.ts");
    case "drag":
      return import("./node-drag.ts");
  }
}

/** Loads the controls of `kind` and mounts them on the chart `parts` come from. */
export async function mountControls(
  kind: LayoutControls["kind"],
  parts: ChartParts,
): Promise<Controls> {
  const { Controls } = await load(kind);
  const { live, legend, cursor, events, ...shared } = parts;
  const items = parts.model.items;
  if (items)
    items.changed ??= (type, change) => {
      parts.invalidate();
      events.emit(type, change);
    };
  return new Controls({
    ...shared,
    announce(text) {
      live.textContent = text;
    },
    onPlot: (target) => !legend.contains(target as Node),
    cursor: () => cursor() || undefined,
  });
}
