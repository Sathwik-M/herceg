// Mounts the controls a layout mark's chart asks for (see controls.ts). The
// chart loads this module first, only when it draws such a mark, and it
// loads the one family's controls, so a map never downloads a 3D chart's.

import type { LayoutControls } from "../marks/layout-mark.ts";
import type { Controls, ControlsHost, ControlsModule } from "./controls.ts";

/** What a chart lends its controls, as it has them. */
export interface ChartParts
  extends Pick<ControlsHost, "chart" | "model" | "overlay" | "invalidate"> {
  /** The live region, which reads sentences aloud. */
  live: HTMLElement;
  /** The chart's legend, whose presses are its own. */
  legend: HTMLElement;
  /** Where the keyboard cursor is: its panel's key and its item's, "" for a panel with none. */
  cursor(): { panel: string; key: string } | undefined;
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
    case "layout":
      return import("./layout-frames.ts");
  }
}

/** Loads the controls of `kind` and mounts them on the chart `parts` come from. */
export async function mountControls(
  kind: LayoutControls["kind"],
  parts: ChartParts,
): Promise<Controls> {
  const { Controls } = await load(kind);
  const { live, legend, cursor, ...shared } = parts;
  return new Controls({
    ...shared,
    announce(text) {
      live.textContent = text;
    },
    onPlot: (target) => !legend.contains(target as Node),
    cursor: () => {
      const at = cursor();
      return at && { panel: at.panel, key: at.key || undefined };
    },
  });
}
