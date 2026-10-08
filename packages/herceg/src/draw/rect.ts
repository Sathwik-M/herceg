import type { Drawing, RectGeometry, SvgElement } from "../scene/scene.ts";
import { KAPPA, markupOf, type PathSink, SvgPath } from "./markup.ts";

/**
 * Adds a geometry's rectangles to `sink`. Rectangles with a rounded end
 * (bars, at their value's end) get corners of up to `rounded.radius` there,
 * no more than half their width or their whole length.
 */
export function traceRects(sink: PathSink, mark: RectGeometry): void {
  const r = mark.rects;
  const ends = mark.rounded?.ends;
  const radius = mark.rounded?.radius ?? 0;
  for (let i = 0; i < mark.count; i++) {
    const x = r[i * 4]!;
    const y = r[i * 4 + 1]!;
    const w = r[i * 4 + 2]!;
    const h = r[i * 4 + 3]!;
    const end = ends ? ends[i]! : NONE;
    const vertical = end === TOP || end === BOTTOM;
    const c = end === NONE ? 0 : Math.min(radius, (vertical ? w : h) / 2, vertical ? h : w);
    if (!(c > 0.5)) {
      sink.rect(x, y, w, h);
      continue;
    }
    const k = c * (1 - KAPPA);
    // Clockwise from the top left, rounding the two corners at the end.
    const [tl, tr, br, bl] = [
      end === TOP || end === LEFT,
      end === TOP || end === RIGHT,
      end === BOTTOM || end === RIGHT,
      end === BOTTOM || end === LEFT,
    ];
    sink.moveTo(x, tl ? y + c : y);
    if (tl) sink.bezierCurveTo(x, y + k, x + k, y, x + c, y);
    sink.lineTo(tr ? x + w - c : x + w, y);
    if (tr) sink.bezierCurveTo(x + w - k, y, x + w, y + k, x + w, y + c);
    sink.lineTo(x + w, br ? y + h - c : y + h);
    if (br) sink.bezierCurveTo(x + w, y + h - k, x + w - k, y + h, x + w - c, y + h);
    sink.lineTo(bl ? x + c : x, y + h);
    if (bl) sink.bezierCurveTo(x + k, y + h, x, y + h - k, x, y + h - c);
    sink.closePath();
  }
}

/** Which end of a rectangle is rounded, per rectangle of `RectGeometry.rounded.ends`. */
export const NONE = 0;
export const TOP = 1;
export const BOTTOM = 2;
export const LEFT = 3;
export const RIGHT = 4;

/** All rectangles of a series as one path. */
function rectPath(mark: RectGeometry): string {
  const svg = new SvgPath();
  traceRects(svg, mark);
  return svg.d;
}

function rectElements(mark: RectGeometry): SvgElement[] {
  return [
    {
      tag: "path",
      attributes: { d: rectPath(mark), fill: mark.fill, "fill-opacity": String(mark.fillOpacity) },
    },
  ];
}

export const rectDrawing: Drawing<RectGeometry> = {
  size: (mark) => mark.count,
  elements: rectElements,
  svg: (mark) => markupOf(rectElements(mark)),
  canvas(context, mark) {
    context.beginPath();
    traceRects(context, mark);
    context.globalAlpha = mark.fillOpacity;
    context.fillStyle = mark.fill;
    context.fill();
    context.globalAlpha = 1;
  },
};
