// Brushing: dragging across the plot selects an x range, drawn as a band in
// the pointer overlay. The selection is kept in data values, so it stays on
// its data as the chart zooms, pans, or resizes. On a category axis the
// values are whole category indices, and the band covers their slots.

import type { PositionScale } from "../scale/scale.ts";
import type { Rect } from "../scene/scene.ts";
import type { Theme } from "../theme.ts";

/** Below this many pixels, a press is a click rather than a drag. */
export const DRAG_THRESHOLD = 3;

export class Brush {
  readonly element: SVGRectElement;
  /** The selected x range in data values, ascending, or null. */
  selection: readonly [number, number] | null = null;
  /** Pixel ends of a drag in progress. */
  #drag: { start: number; end: number } | null = null;
  #shown = false;

  constructor(element: SVGRectElement) {
    this.element = element;
  }

  get dragging(): boolean {
    return this.#drag !== null;
  }

  /** Starts a drag at a pixel, kept inside the plot. */
  start(px: number, plot: Rect): void {
    const at = clamp(px, plot);
    this.#drag = { start: at, end: at };
  }

  move(px: number, plot: Rect): void {
    if (this.#drag) this.#drag.end = clamp(px, plot);
  }

  /** Ends a drag: the range it covers in data values, ascending, or null for none. */
  end(scale: PositionScale): readonly [number, number] | null {
    const drag = this.#drag;
    this.#drag = null;
    if (!drag || Math.abs(drag.end - drag.start) < DRAG_THRESHOLD) return null;
    return normalize(scale, scale.invert(drag.start), scale.invert(drag.end));
  }

  cancel(): void {
    this.#drag = null;
  }

  /** Draws the drag in progress, or else the selection, clamped to the plot. */
  draw(scale: PositionScale, plot: Rect, theme: Theme): void {
    // Category selections cover their slots, so one category shows a band.
    const half = scale.type === "band" ? Math.abs(scale.map(1) - scale.map(0)) / 2 : 0;
    const ends = this.#drag
      ? [this.#drag.start, this.#drag.end]
      : this.selection
        ? [scale.map(this.selection[0]) - half, scale.map(this.selection[1]) + half]
        : undefined;
    const a = Math.max(plot.x, Math.min(...(ends ?? [0])));
    const b = Math.min(plot.x + plot.width, Math.max(...(ends ?? [0])));
    if (!ends || !(b > a)) {
      // Most frames have no brush: leave the hidden element alone.
      if (this.#shown) this.element.setAttribute("visibility", "hidden");
      this.#shown = false;
      return;
    }
    this.#shown = true;
    const set = (name: string, value: string | number) =>
      this.element.setAttribute(name, String(value));
    set("x", a);
    set("y", plot.y);
    set("width", b - a);
    set("height", plot.height);
    set("fill", theme.muted);
    set("fill-opacity", 0.18);
    set("visibility", "visible");
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
