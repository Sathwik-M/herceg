// What heatmaps and 2D histograms draw of a highlighted selection over
// their image, dimmed: in each cell holding selected rows, a square in its
// middle covering the share of the cell its selected rows are (of its rows,
// or of a 2D histogram's weight), in the cell's color. Grids whose cells are
// too small for squares to read, or too many to draw one by one, draw an
// image of the cells holding selected rows instead. Lent to the marks by
// highlighting (`SelectionDrawing.squares`), so it loads with `rowSelection()`.

import { rectDrawing } from "../draw/rect.ts";
import type { RectGeometry } from "../scene/scene.ts";
import type { CellShares } from "./mark.ts";

/** Cells smaller than this many pixels across or down are too small for a square to read. */
const SQUARE_MIN = 4;
/** More cells holding selected rows than this are drawn as an image. */
const SQUARES_MAX = 20_000;

/**
 * The squares of `cells`, each around its cell's center and covering its
 * share of the cell's area (cells of no share draw none), in its color: one
 * geometry per color, keyed from `key`. Undefined when a cell is too small
 * for a square to read, or too many hold selected rows to draw one by one.
 */
export function shareSquares(cells: CellShares, key: string): RectGeometry[] | undefined {
  const [width, height] = cells.size;
  if (!(width >= SQUARE_MIN && height >= SQUARE_MIN) || cells.held > SQUARES_MAX) return undefined;
  const byColor = new Map<string, number[]>();
  for (let k = 0; k < cells.count; k++) {
    const share = Math.min(1, cells.share(k));
    if (!(share > 0)) continue;
    const [x0, y0, x1, y1] = cells.box(k);
    // Sides scaled by the square root of the share cover that share of the cell.
    const scale = Math.sqrt(share);
    const [w, h] = [Math.abs(x1 - x0) * scale, Math.abs(y1 - y0) * scale];
    const [cx, cy] = [(x0 + x1) / 2, (y0 + y1) / 2];
    const fill = cells.color(k);
    let rects = byColor.get(fill);
    if (!rects) {
      rects = [];
      byColor.set(fill, rects);
    }
    rects.push(cx - w / 2, cy - h / 2, w, h);
  }
  return [...byColor].map(([fill, rects], i) => ({
    kind: "rect",
    draw: rectDrawing,
    key: `${key}-${i}`,
    fill,
    fillOpacity: 1,
    rects: Float32Array.from(rects),
    count: rects.length / 4,
  }));
}
