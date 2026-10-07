// Brushing: dragging across the plot selects an x range, drawn as a band in
// the pointer overlay. The selection is kept in data values, so it stays on
// its data as the chart zooms, pans, or resizes. On a category axis the
// values are whole category indices, and the band covers their slots.

import type { PositionScale } from "../scale/scale.ts";
import type { Rect } from "../scene/scene.ts";
import type { Theme } from "../theme.ts";

/** Below this many pixels, a press is a click rather than a drag. */
export const DRAG_THRESHOLD = 3;

/** A plotting area the brush draws in: its plot and x scale. */
export interface BrushPanel {
  plot: Rect;
  x: PositionScale;
}

export class Brush {
  /** Holds a band per panel. */
  readonly element: SVGGElement;
  /** The selected x range in data values, ascending, or null. */
  selection: readonly [number, number] | null = null;
  /** A drag in progress: its pixel ends in the panel it started in. */
  #drag: { start: number; end: number; plot: Rect; scale: PositionScale } | null = null;
  #bands: SVGRectElement[] = [];
  #shown = false;

  constructor(element: SVGGElement) {
    this.element = element;
  }

  get dragging(): boolean {
    return this.#drag !== null;
  }

  /** Starts a drag at a pixel of a panel, kept inside its plot. */
  start(px: number, panel: BrushPanel): void {
    const at = clamp(px, panel.plot);
    this.#drag = { start: at, end: at, plot: panel.plot, scale: panel.x };
  }

  move(px: number): void {
    if (this.#drag) this.#drag.end = clamp(px, this.#drag.plot);
  }

  /** Ends a drag: the range it covers in data values, ascending, or null for none. */
  end(): readonly [number, number] | null {
    const drag = this.#drag;
    this.#drag = null;
    if (!drag || Math.abs(drag.end - drag.start) < DRAG_THRESHOLD) return null;
    const { scale } = drag;
    return normalize(scale, scale.invert(drag.start), scale.invert(drag.end));
  }

  cancel(): void {
    this.#drag = null;
  }

  /**
   * Draws the drag in progress, or else the selection, in every panel (they
   * share x), clamped to each plot.
   */
  draw(panels: readonly BrushPanel[], theme: Theme): void {
    const drag = this.#drag;
    const range = drag
      ? [drag.scale.invert(drag.start), drag.scale.invert(drag.end)]
      : this.selection;
    if (!range) {
      // Most frames have no brush: leave the hidden bands alone.
      if (this.#shown) for (const band of this.#bands) band.setAttribute("visibility", "hidden");
      this.#shown = false;
      return;
    }
    this.#shown = true;
    const document = this.element.ownerDocument;
    while (this.#bands.length < panels.length) {
      const band = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      this.#bands.push(band);
      this.element.append(band);
    }
    this.#bands.forEach((band, i) => {
      const panel = panels[i];
      const set = (name: string, value: string | number) => band.setAttribute(name, String(value));
      if (!panel) {
        set("visibility", "hidden");
        return;
      }
      const { plot, x: scale } = panel;
      // Category selections cover their slots, so one category shows a band.
      const half = !drag && scale.type === "band" ? Math.abs(scale.map(1) - scale.map(0)) / 2 : 0;
      const ends = [scale.map(range[0]!), scale.map(range[1]!)];
      const a = Math.max(plot.x, Math.min(...ends) - half);
      const b = Math.min(plot.x + plot.width, Math.max(...ends) + half);
      if (!(b > a)) {
        set("visibility", "hidden");
        return;
      }
      set("x", a);
      set("y", plot.y);
      set("width", b - a);
      set("height", plot.height);
      set("fill", theme.muted);
      set("fill-opacity", 0.18);
      set("visibility", "visible");
    });
  }
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

function clamp(px: number, plot: Rect): number {
  return Math.min(plot.x + plot.width, Math.max(plot.x, px));
}
