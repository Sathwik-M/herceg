import type { Drawing, SegmentGeometry, SvgElement } from "../scene/scene.ts";
import { markupOf, n } from "./markup.ts";

function segmentPath(mark: SegmentGeometry): string {
  const c = mark.coords;
  let d = "";
  for (let i = 0; i < mark.count; i++) {
    const at = i * 4;
    d += `M${n(c[at]!)} ${n(c[at + 1]!)}L${n(c[at + 2]!)} ${n(c[at + 3]!)}`;
  }
  return d;
}

function segmentElements(mark: SegmentGeometry): SvgElement[] {
  return [
    {
      tag: "path",
      attributes: {
        d: segmentPath(mark),
        fill: "none",
        stroke: mark.stroke,
        "stroke-width": String(mark.strokeWidth),
      },
    },
  ];
}

/** All segments of a series as one path, with butt ends so caps meet stems exactly. */
export const segmentDrawing: Drawing<SegmentGeometry> = {
  size: (mark) => mark.count,
  elements: segmentElements,
  svg: (mark) => markupOf(segmentElements(mark)),
  canvas(context, mark) {
    if (mark.strokeWidth === 0) return;
    const c = mark.coords;
    context.save();
    context.lineCap = "butt";
    context.beginPath();
    for (let i = 0; i < mark.count; i++) {
      const at = i * 4;
      context.moveTo(c[at]!, c[at + 1]!);
      context.lineTo(c[at + 2]!, c[at + 3]!);
    }
    context.strokeStyle = mark.stroke;
    context.lineWidth = mark.strokeWidth;
    context.stroke();
    context.restore();
  },
};

/** Segments drawn above the data as guides, such as lines from moved labels to their points. */
export const guideSegmentDrawing: Drawing<SegmentGeometry> = {
  guide: true,
  size: () => 0,
  elements: segmentElements,
  svg: (mark) => markupOf(segmentElements(mark)),
};
