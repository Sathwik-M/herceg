import type {
  Drawing,
  PolygonGeometry,
  PolygonShape,
  Rect,
  ShapeTransform,
  SvgElement,
} from "../scene/scene.ts";
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

/** SVG path data of a shape's rings moved and scaled by `t`, made each time (outlines of items). */
function movedPolygonPath(shape: PolygonShape, t: ShapeTransform | undefined): string {
  if (!t) return polygonPath(shape);
  let d = "";
  tracePolygon(
    {
      moveTo: (x, y) => {
        d += `M${n(x)} ${n(y)}`;
      },
      lineTo: (x, y) => {
        d += `L${n(x)} ${n(y)}`;
      },
      closePath: () => {
        d += "Z";
      },
    },
    shape,
    t,
  );
  return d;
}

/**
 * SVG path data of the parts of a shape's edges inside `room`, moved and
 * scaled by `t`: the outline of an item that reaches past the room (a
 * zoomed map's region) stops at the room's edges, as its drawing is
 * clipped, rather than run past or along them.
 */
export function roomPolygonPath(
  shape: PolygonShape,
  t: ShapeTransform | undefined,
  room: Rect,
): string {
  const { coords, rings } = shape;
  const [k, dx, dy] = t ? [t.k, t.x, t.y] : [1, 0, 0];
  const [left, top] = [room.x, room.y];
  const [right, bottom] = [room.x + room.width, room.y + room.height];
  let inside = true;
  for (let i = 0; i < coords.length && inside; i += 2) {
    const x = dx + k * coords[i]!;
    const y = dy + k * coords[i + 1]!;
    inside = x >= left && x <= right && y >= top && y <= bottom;
  }
  if (inside) return movedPolygonPath(shape, t);
  let d = "";
  for (let r = 0; r + 1 < rings.length; r++) {
    const [start, end] = [rings[r]!, rings[r + 1]!];
    // Where the path's pen is, so edges in a row are one stroke.
    let pen = "";
    for (let i = start; i < end; i++) {
      const j = i + 1 < end ? i + 1 : start;
      const ax = dx + k * coords[i * 2]!;
      const ay = dy + k * coords[i * 2 + 1]!;
      const ex = dx + k * coords[j * 2]! - ax;
      const ey = dy + k * coords[j * 2 + 1]! - ay;
      // The part of the edge inside the room, from t0 to t1 along it (Liang–Barsky).
      let t0 = 0;
      let t1 = 1;
      const within = (p: number, q: number) => {
        if (p === 0) return q >= 0;
        const at = q / p;
        if (p < 0) {
          if (at > t1) return false;
          t0 = Math.max(t0, at);
        } else {
          if (at < t0) return false;
          t1 = Math.min(t1, at);
        }
        return true;
      };
      if (!(within(-ex, ax - left) && within(ex, right - ax))) continue;
      if (!(within(-ey, ay - top) && within(ey, bottom - ay))) continue;
      const from = `${n(ax + t0 * ex)} ${n(ay + t0 * ey)}`;
      if (from !== pen) d += `M${from}`;
      pen = `${n(ax + t1 * ex)} ${n(ay + t1 * ey)}`;
      d += `L${pen}`;
    }
  }
  return d;
}

/** Traces a shape's rings onto a canvas, or any path sink, moved and scaled by `t` if given. */
export function tracePolygon(
  context: Pick<CanvasPath, "moveTo" | "lineTo" | "closePath">,
  shape: PolygonShape,
  t?: ShapeTransform,
): void {
  const { coords, rings } = shape;
  const [k, dx, dy] = t ? [t.k, t.x, t.y] : [1, 0, 0];
  for (let r = 0; r + 1 < rings.length; r++) {
    const start = rings[r]!;
    context.moveTo(dx + k * coords[start * 2]!, dy + k * coords[start * 2 + 1]!);
    for (let i = start + 1; i < rings[r + 1]!; i++)
      context.lineTo(dx + k * coords[i * 2]!, dy + k * coords[i * 2 + 1]!);
    context.closePath();
  }
}

/**
 * One path per shape, so a change of colors only changes fills, and a pan
 * only each path's transform: its data, kept per shape, stays.
 */
function elements(mark: PolygonGeometry): SvgElement[] {
  const t = mark.transform;
  // Borders keep their width however the shapes are scaled.
  const border: Record<string, string> =
    mark.strokeWidth > 0
      ? {
          stroke: mark.stroke,
          "stroke-width": String(fine(mark.strokeWidth / (t?.k ?? 1))),
          "stroke-linejoin": "round",
        }
      : {};
  if (mark.fillOpacity < 1) border["fill-opacity"] = String(mark.fillOpacity);
  // The scale in full: shapes zoomed far are thousands of pixels from the
  // origin, where a rounded scale would move them pixels away.
  if (t) border.transform = `matrix(${t.k} 0 0 ${t.k} ${n(t.x)} ${n(t.y)})`;
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

/** A border's width under a scale, to four decimals: a tenth of a pixel would round 0.84 to 0.8. */
function fine(value: number): number {
  return Math.round(value * 1e4) / 1e4;
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
      tracePolygon(context, shape, mark.transform);
      context.globalAlpha = mark.fillOpacity;
      context.fillStyle = mark.colors[mark.colorIndex[i]!]!;
      context.fill("evenodd");
      context.globalAlpha = 1;
      if (mark.strokeWidth > 0) context.stroke();
    });
    context.restore();
  },
};
