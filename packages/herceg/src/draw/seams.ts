import type { Drawing, SegmentGeometry, SvgElement } from "../scene/scene.ts";
import { markupOf, n } from "./markup.ts";

function seamElements(mark: SegmentGeometry): SvgElement[] {
  const c = mark.coords;
  let d = "";
  for (let i = 0; i < mark.count; i++) {
    const at = i * 4;
    d += `M${n(c[at]!)} ${n(c[at + 1]!)}V${n(c[at + 3]!)}`;
  }
  return [
    {
      tag: "path",
      attributes: {
        d,
        stroke: mark.stroke,
        "stroke-width": String(mark.strokeWidth),
        "stroke-dasharray": (mark.dash ?? []).join(" "),
        fill: "none",
        "aria-hidden": "true",
        focusable: "false",
        "pointer-events": "none",
      },
    },
  ];
}

/** Decorative segments clipped behind data, loaded only with time breaks. */
export const seamDrawing: Drawing<SegmentGeometry> = {
  size: () => 0,
  elements: seamElements,
  svg: (mark) => markupOf(seamElements(mark)),
  canvas(context, mark) {
    const c = mark.coords;
    context.save();
    context.lineCap = "butt";
    context.beginPath();
    for (let i = 0; i < mark.count; i++) {
      const at = i * 4;
      context.moveTo(c[at]!, c[at + 1]!);
      context.lineTo(c[at]!, c[at + 3]!);
    }
    context.strokeStyle = mark.stroke;
    context.lineWidth = mark.strokeWidth;
    context.setLineDash([...(mark.dash ?? [])]);
    context.stroke();
    context.restore();
  },
};
