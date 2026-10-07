import { mapValue } from "../lod/m4.ts";
import type { Drawing, PointGeometry, Rect, SvgElement } from "../scene/scene.ts";
import { escapeXml, markupOf, n } from "./markup.ts";

/**
 * Circles of a translucent series, one element each so overlaps composite;
 * the inherited `fill-opacity` of their group applies to each circle.
 */
function pointCircles(mark: PointGeometry): string {
  const c = mark.coords;
  const r = n(mark.radius);
  let out = "";
  for (let i = 0; i < mark.count; i++)
    out += `<circle cx="${n(c[i * 2]!)}" cy="${n(c[i * 2 + 1]!)}" r="${r}"/>`;
  return out;
}

/** All circles of an opaque series as one path of arcs. */
function pointPath(mark: PointGeometry): string {
  const c = mark.coords;
  const r = n(mark.radius);
  const d2 = n(mark.radius * 2);
  let d = "";
  for (let i = 0; i < mark.count; i++) {
    d += `M${n(c[i * 2]! - mark.radius)} ${n(c[i * 2 + 1]!)}a${r} ${r} 0 1 0 ${d2} 0a${r} ${r} 0 1 0 -${d2} 0`;
  }
  return d;
}

function paintPoints(context: CanvasRenderingContext2D, mark: PointGeometry): void {
  const c = mark.coords;
  const r = mark.radius;
  context.globalAlpha = mark.fillOpacity;
  context.fillStyle = mark.fill;
  if (!mark.opaque) {
    // One fill per point so overlapping translucent points darken, as in SVG.
    for (let i = 0; i < mark.count; i++) {
      context.beginPath();
      context.arc(c[i * 2]!, c[i * 2 + 1]!, r, 0, Math.PI * 2);
      context.fill();
    }
    context.globalAlpha = 1;
    return;
  }
  context.beginPath();
  for (let i = 0; i < mark.count; i++) {
    const x = c[i * 2]!;
    const y = c[i * 2 + 1]!;
    context.moveTo(x + r, y);
    context.arc(x, y, r, 0, Math.PI * 2);
  }
  context.fill();
  context.globalAlpha = 1;
}

/**
 * Places a cloud's points on the CPU: the fallback when no GPU painter can
 * draw it. Points whose disc misses the plot are left out, as by the mark.
 */
export function placeCloud(mark: PointGeometry, plot: Rect): PointGeometry {
  const cloud = mark.cloud!;
  const { x, y, rows, start, end, xMap, yMap } = cloud;
  const coords = new Float32Array((end - start) * 2);
  const r = mark.radius;
  let count = 0;
  for (let k = start; k < end; k++) {
    const row = rows ? rows[k]! : k;
    const vx = x[row]!;
    const vy = y[row]!;
    if (!(Number.isFinite(vx) && Number.isFinite(vy))) continue;
    if ((xMap.log && vx <= 0) || (yMap.log && vy <= 0)) continue;
    const px = mapValue(xMap, vx);
    const py = mapValue(yMap, vy);
    if (px < plot.x - r || px > plot.x + plot.width + r) continue;
    if (py < plot.y - r || py > plot.y + plot.height + r) continue;
    coords[count * 2] = px;
    coords[count * 2 + 1] = py;
    count++;
  }
  const { cloud: _, ...placed } = mark;
  return { ...placed, coords, count };
}

/**
 * Points. Clouds (large series left to a GPU painter) are only drawn on a
 * canvas; scenes for SVG never contain them.
 */
/** Opaque points as one path; translucent points need a circle each (markup). */
function pointElements(mark: PointGeometry): SvgElement[] | undefined {
  if (mark.cloud) return [];
  if (!mark.opaque) return undefined;
  return [{ tag: "path", attributes: { d: pointPath(mark), fill: mark.fill } }];
}

export const pointDrawing: Drawing<PointGeometry> = {
  size: (mark) => mark.count,
  elements: pointElements,
  svg(mark) {
    const elements = pointElements(mark);
    return elements
      ? markupOf(elements)
      : `<g fill="${escapeXml(mark.fill)}" fill-opacity="${mark.fillOpacity}">${pointCircles(mark)}</g>`;
  },
  canvas(context, mark, { plot, pixelRatio, clouds }) {
    if (!mark.cloud) return paintPoints(context, mark);
    if (clouds.defer) return;
    const owner = clouds.owner ?? context.canvas;
    if (!clouds.painter?.paint(context, mark, plot, pixelRatio, owner))
      paintPoints(context, placeCloud(mark, plot));
  },
};
