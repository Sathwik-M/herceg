import type { Drawing, RectGeometry, SvgElement } from "../scene/scene.ts";
import { markupOf, n } from "./markup.ts";

/** All rectangles of a series as one path. */
function rectPath(mark: RectGeometry): string {
  const r = mark.rects;
  let d = "";
  for (let i = 0; i < mark.count; i++) {
    const x = r[i * 4]!;
    const y = r[i * 4 + 1]!;
    const w = r[i * 4 + 2]!;
    const h = r[i * 4 + 3]!;
    d += `M${n(x)} ${n(y)}h${n(w)}v${n(h)}h${n(-w)}Z`;
  }
  return d;
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
    const r = mark.rects;
    context.beginPath();
    for (let i = 0; i < mark.count; i++)
      context.rect(r[i * 4]!, r[i * 4 + 1]!, r[i * 4 + 2]!, r[i * 4 + 3]!);
    context.globalAlpha = mark.fillOpacity;
    context.fillStyle = mark.fill;
    context.fill();
    context.globalAlpha = 1;
  },
};
