import type { Drawing, PolygonGeometry, PolygonShape, SvgElement } from "../scene/scene.ts";
import { markupOf, n } from "./markup.ts";

/** SVG path data of a shape's rings, made once per shape. */
export function polygonPath(shape: PolygonShape): string {
  if (shape.path !== undefined) return shape.path;
  const { coords, rings } = shape;
  let d = "";
  for (let r = 0; r + 1 < rings.length; r++) {
    for (let i = rings[r]!; i < rings[r + 1]!; i++)
      d += `${i === rings[r] ? "M" : "L"}${n(coords[i * 2]!)} ${n(coords[i * 2 + 1]!)}`;
    d += "Z";
  }
  shape.path = d;
  return d;
}

/** Traces a shape's rings onto a canvas, or any path sink. */
export function tracePolygon(
  context: Pick<CanvasPath, "moveTo" | "lineTo" | "closePath">,
  shape: PolygonShape,
): void {
  const { coords, rings } = shape;
  for (let r = 0; r + 1 < rings.length; r++) {
    const start = rings[r]!;
    context.moveTo(coords[start * 2]!, coords[start * 2 + 1]!);
    for (let i = start + 1; i < rings[r + 1]!; i++)
      context.lineTo(coords[i * 2]!, coords[i * 2 + 1]!);
    context.closePath();
  }
}

/** One path per shape, so a change of colors only changes fills. */
function elements(mark: PolygonGeometry): SvgElement[] {
  const border: Record<string, string> =
    mark.strokeWidth > 0
      ? {
          stroke: mark.stroke,
          "stroke-width": String(mark.strokeWidth),
          "stroke-linejoin": "round",
        }
      : {};
  if (mark.fillOpacity < 1) border["fill-opacity"] = String(mark.fillOpacity);
  return mark.shapes.map((shape, i) => ({
    tag: "path",
    attributes: {
      d: polygonPath(shape),
      fill: mark.colors[mark.colorIndex[i]!]!,
      "fill-rule": "evenodd",
      ...border,
    },
  }));
}

/**
 * Polygons, filled and bordered shape by shape in order, as SVG paints each
 * path's fill and then its stroke; borders are drawn with round joins.
 */
export const polygonsDrawing: Drawing<PolygonGeometry> = {
  size(mark) {
    let points = 0;
    for (const shape of mark.shapes) points += shape.coords.length / 2;
    return points;
  },
  elements,
  svg: (mark) => markupOf(elements(mark)),
  canvas(context, mark) {
    context.save();
    context.lineJoin = "round";
    context.strokeStyle = mark.stroke;
    context.lineWidth = mark.strokeWidth;
    mark.shapes.forEach((shape, i) => {
      context.beginPath();
      tracePolygon(context, shape);
      context.globalAlpha = mark.fillOpacity;
      context.fillStyle = mark.colors[mark.colorIndex[i]!]!;
      context.fill("evenodd");
      context.globalAlpha = 1;
      if (mark.strokeWidth > 0) context.stroke();
    });
    context.restore();
  },
};
