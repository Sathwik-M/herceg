// A network's separated base placement is expressed through its original
// layout fit. Navigation magnifies that fit uniformly, retaining the small
// x/y stretch used by the base layout and its downward-positive y units.

import type { PlaneView, Viewport } from "../marks/layout-mark.ts";
import { LinearScale } from "../scale/scale.ts";
import type { Rect } from "../scene/scene.ts";
import type { LayoutFit } from "./force.ts";

export function graphView(fit: LayoutFit, room: Rect, viewport: Viewport | undefined) {
  const sx = fit.sx || 1,
    sy = fit.sy || 1;
  const baseX = [
    (room.x - fit.cx) / sx + fit.mx,
    (room.x + room.width - fit.cx) / sx + fit.mx,
  ] as const;
  const baseY = [
    (room.y - fit.cy) / sy + fit.my,
    (room.y + room.height - fit.cy) / sy + fit.my,
  ] as const;
  const view = (viewport: Viewport | undefined): PlaneView => {
    const { x, y } = viewport ?? {};
    let zoom =
      x || y
        ? Math.min(
            x ? (baseX[1] - baseX[0]) / (x[1] - x[0]) : Infinity,
            y ? (baseY[1] - baseY[0]) / (y[1] - y[0]) : Infinity,
          )
        : 1;
    if (!(zoom > 0 && Number.isFinite(zoom))) zoom = 1;
    const cx = x ? (x[0] + x[1]) / 2 : fit.mx;
    const cy = y ? (y[0] + y[1]) / 2 : fit.my;
    const hx = (baseX[1] - baseX[0]) / (2 * zoom);
    const hy = (baseY[1] - baseY[0]) / (2 * zoom);
    return { x: [cx - hx, cx + hx], y: [cy - hy, cy + hy], zoom };
  };
  const shown = view(viewport);
  return {
    x: new LinearScale(shown.x, [room.x, room.x + room.width]),
    y: new LinearScale(shown.y, [room.y, room.y + room.height]),
    zoom: shown.zoom,
    view,
  };
}
