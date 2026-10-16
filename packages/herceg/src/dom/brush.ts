// Brushing: dragging across the plot selects a range along x or y, a
// rectangle, or a freehand region (a lasso), drawn in the pointer overlay.
// The selection is kept in data values, so it stays on its data as the chart
// zooms, pans, or resizes. On a category axis the values are whole category
// indices, and the selection covers their slots.

import type { PositionScale } from "../scale/scale.ts";
import type { Rect } from "../scene/scene.ts";
import type { BrushSpec } from "../spec/spec.ts";
import type { Theme } from "../theme.ts";
import { DRAG_THRESHOLD, normalize, type Selection } from "./brushed.ts";

/** A plotting area the brush draws in: its plot and scales. */
export interface BrushPanel {
  plot: Rect;
  /** With insets over the panel, the parts of its plot they leave visible. */
  visible?: readonly Rect[] | undefined;
  x: PositionScale;
  y: PositionScale;
}

/** Most points a lasso keeps; longer drags keep every other one, then every fourth... */
const LASSO_POINTS = 400;

const SVG = "http://www.w3.org/2000/svg";

export class Brush {
  /** Holds an outline per panel, each clipped to its plot. */
  readonly element: SVGGElement;
  mode: BrushSpec = "x";
  /** A drag in progress: its pixel points in the panel it started in. */
  #drag: { points: [number, number][]; panel: BrushPanel } | null = null;
  #outlines: { path: SVGPathElement; clip: SVGClipPathElement }[] = [];
  #shown = false;
  /** Prefix of the clip paths' ids, unique in the page. */
  readonly #id: string;

  constructor(element: SVGGElement, id: string) {
    this.element = element;
    this.#id = id;
  }

  get dragging(): boolean {
    return this.#drag !== null;
  }

  /** Starts a drag at a pixel of a panel, kept inside its plot. */
  start(px: number, py: number, panel: BrushPanel): void {
    this.#drag = { points: [clamp(px, py, panel.plot)], panel };
  }

  move(px: number, py: number): void {
    const drag = this.#drag;
    if (!drag) return;
    const point = clamp(px, py, drag.panel.plot);
    // Ranges and rectangles need only their two corners; lassos their path.
    if (this.mode !== "lasso") {
      drag.points[1] = point;
      return;
    }
    const [lx, ly] = drag.points[drag.points.length - 1]!;
    if (Math.hypot(point[0] - lx, point[1] - ly) < 2) return;
    if (drag.points.length >= LASSO_POINTS) drag.points = drag.points.filter((_, i) => i % 2 === 0);
    drag.points.push(point);
  }

  /** Ends a drag: what it selected, or null when it was too small to mean anything. */
  end(): Selection | null {
    const drag = this.#drag;
    this.#drag = null;
    if (!drag) return null;
    return selectionOf(drag.points, drag.panel, this.mode);
  }

  cancel(): void {
    this.#drag = null;
  }

  /** Draws the drag in progress, or else `selected`, in every panel (they share scales). */
  draw(panels: readonly BrushPanel[], theme: Theme, selected: Selection | null): void {
    const drag = this.#drag;
    const selection = drag ? selectionOf(drag.points, drag.panel, this.mode, true) : selected;
    if (!selection) {
      // Most frames have no brush: leave the hidden outlines alone.
      if (this.#shown)
        for (const { path } of this.#outlines) path.setAttribute("visibility", "hidden");
      this.#shown = false;
      return;
    }
    this.#shown = true;
    const document = this.element.ownerDocument;
    while (this.#outlines.length < panels.length) {
      const id = `${this.#id}-${this.#outlines.length}`;
      const clip = document.createElementNS(SVG, "clipPath");
      clip.setAttribute("id", id);
      const path = document.createElementNS(SVG, "path");
      path.setAttribute("clip-path", `url(#${id})`);
      this.element.append(clip, path);
      this.#outlines.push({ path, clip });
    }
    this.#outlines.forEach(({ path, clip }, i) => {
      const panel = panels[i];
      const d = panel ? outlineOf(selection, panel, !drag) : "";
      if (!panel || !d) {
        path.setAttribute("visibility", "hidden");
        return;
      }
      // Cut to the plot, or the parts of it insets over it leave visible.
      const rects = [...(panel.visible ?? [panel.plot])];
      while (clip.childElementCount > rects.length) clip.lastElementChild!.remove();
      while (clip.childElementCount < rects.length)
        clip.append(document.createElementNS(SVG, "rect"));
      rects.forEach((rect, k) => {
        const node = clip.children[k]!;
        node.setAttribute("x", String(rect.x));
        node.setAttribute("y", String(rect.y));
        node.setAttribute("width", String(rect.width));
        node.setAttribute("height", String(rect.height));
      });
      path.setAttribute("d", d);
      path.setAttribute("fill", theme.muted);
      path.setAttribute("fill-opacity", "0.18");
      path.setAttribute("stroke", selection.lasso ? theme.muted : "none");
      path.setAttribute("stroke-opacity", "0.6");
      path.setAttribute("visibility", "visible");
    });
  }
}

/**
 * What pixel points select in a panel. Ranges need a drag of a few pixels
 * along their axis, rectangles and lassos a few pixels each way (a flat one
 * would select nothing, or zoom to nothing); `partial` keeps smaller ones,
 * for drawing a drag as it starts.
 */
function selectionOf(
  points: readonly [number, number][],
  panel: BrushPanel,
  mode: BrushSpec,
  partial = false,
): Selection | null {
  const { x, y } = panel;
  const [first] = points;
  const last = points[points.length - 1]!;
  if (!first) return null;
  const big = (a: number, b: number) => partial || Math.abs(a - b) >= DRAG_THRESHOLD;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const along = {
    x: () => normalize(x, x.invert(Math.min(...xs)), x.invert(Math.max(...xs))),
    y: () => normalize(y, y.invert(Math.min(...ys)), y.invert(Math.max(...ys))),
  };
  if (mode === "x") return big(first[0], last[0]) ? { x: along.x(), y: null, lasso: null } : null;
  if (mode === "y") return big(first[1], last[1]) ? { x: null, y: along.y(), lasso: null } : null;
  if (!big(Math.min(...xs), Math.max(...xs)) || !big(Math.min(...ys), Math.max(...ys))) return null;
  if (mode === "xy") return { x: along.x(), y: along.y(), lasso: null };
  if (points.length < 3 && !partial) return null;
  return {
    x: along.x(),
    y: along.y(),
    lasso: points.map(([px, py]) => [x.invert(px), y.invert(py)] as const),
  };
}

/**
 * SVG path data of a selection in a panel. Ranges and rectangles end at the
 * plot ("" when outside it); a lasso keeps its shape, for the clip to cut.
 */
function outlineOf(selection: Selection, panel: BrushPanel, settled: boolean): string {
  const { plot, x, y } = panel;
  if (selection.lasso) {
    return `${selection.lasso
      .map(([vx, vy], i) => `${i === 0 ? "M" : "L"}${x.map(vx).toFixed(1)} ${y.map(vy).toFixed(1)}`)
      .join("")}Z`;
  }
  // A settled selection on a category axis covers its categories' slots.
  const span = (
    scale: PositionScale,
    range: readonly [number, number] | null,
    lo: number,
    hi: number,
  ) => {
    if (!range) return [lo, hi] as const;
    const half = settled && scale.type === "band" ? Math.abs(scale.map(1) - scale.map(0)) / 2 : 0;
    const ends = [scale.map(range[0]), scale.map(range[1])];
    return [
      Math.max(lo, Math.min(...ends) - half),
      Math.min(hi, Math.max(...ends) + half),
    ] as const;
  };
  const [x0, x1] = span(x, selection.x, plot.x, plot.x + plot.width);
  const [y0, y1] = span(y, selection.y, plot.y, plot.y + plot.height);
  if (!(x1 > x0 && y1 > y0)) return "";
  return `M${x0.toFixed(1)} ${y0.toFixed(1)}H${x1.toFixed(1)}V${y1.toFixed(1)}H${x0.toFixed(1)}Z`;
}

function clamp(px: number, py: number, plot: Rect): [number, number] {
  return [
    Math.min(plot.x + plot.width, Math.max(plot.x, px)),
    Math.min(plot.y + plot.height, Math.max(plot.y, py)),
  ];
}
