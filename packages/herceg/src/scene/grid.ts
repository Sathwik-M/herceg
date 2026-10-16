// Grid lines as every renderer strokes them: the lines of all panels that
// look alike in one stroke, on pixel centers (device pixels on a canvas).

import type { StrokePaint } from "../style/style.ts";
import type { Theme } from "../theme.ts";
import type { Panel, SegmentsItem } from "./scene.ts";

/**
 * Where a scene's grid lines are drawn: segments of one stroke each, by how
 * they look, on the centers of pixels `ratio` to a CSS pixel.
 */
export function gridStrokes(panels: readonly Panel[], theme: Theme, ratio = 1): SegmentsItem[] {
  const strokes = new Map<string, SegmentsItem & { coords: number[] }>();
  const add = (coords: number[], paint: StrokePaint) => {
    const key = strokeKey(paint);
    const same = strokes.get(key);
    if (same) same.coords.push(...coords);
    else if (coords.length > 0) strokes.set(key, { type: "segments", coords, paint });
  };
  // Lines fall on pixel centers, so 1-pixel lines are crisp.
  const snap = (at: number) => (Math.round(at * ratio) + 0.5) / ratio;
  for (const { plot, grid } of panels) {
    // Where insets over a plot leave its lines (`ySpans`, `xSpans`), else across it.
    const ys: number[] = [];
    grid.y.forEach((y, i) => {
      for (const [from, to] of grid.ySpans?.[i] ?? [[plot.x, plot.x + plot.width]])
        ys.push(from, snap(y), to, snap(y));
    });
    const xs: number[] = [];
    grid.x.forEach((x, i) => {
      for (const [from, to] of grid.xSpans?.[i] ?? [[plot.y, plot.y + plot.height]])
        xs.push(snap(x), from, snap(x), to);
    });
    add(ys, grid.yPaint ?? theme.style.grid);
    add(xs, grid.xPaint ?? theme.style.grid);
  }
  return [...strokes.values()];
}

/** What tells strokes apart: two strokes with one key look alike. */
export function strokeKey({ stroke, strokeWidth, dash, opacity }: StrokePaint): string {
  return `${stroke} ${strokeWidth} ${dash} ${opacity}`;
}
