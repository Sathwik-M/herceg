// Markers: a symbol at each observation a line draws, as point geometry
// (which every renderer draws: PDF reads its fields), drawn here in SVG
// and on a canvas from the symbols' shapes, with the chart's markup
// helpers handed in (see `GuideKit`).

import { type SymbolName, vertices } from "../../draw/symbol-shapes.ts";
import type { GuideKit } from "../../model/guides.ts";
import type { Drawing, PointGeometry, SvgElement } from "../../scene/scene.ts";
import type { MarkerStyle } from "../../spec/encoding.ts";

/** A marker's radius by default, in pixels. */
export const MARKER_RADIUS = 3;

const drawings = new WeakMap<GuideKit, Drawing<PointGeometry>>();

/** SVG path data of a symbol of radius `r` at (x, y), as `symbolPath` writes it. */
export function markerPath(
  { n }: GuideKit,
  symbol: SymbolName,
  x: number,
  y: number,
  r: number,
): string {
  if (symbol === "circle") {
    const d = n(r * 2);
    return `M${n(x - r)} ${n(y)}a${n(r)} ${n(r)} 0 1 1 ${d} 0a${n(r)} ${n(r)} 0 1 1 -${d} 0`;
  }
  const v = vertices(symbol);
  let d = `M${n(x + v[0]! * r)} ${n(y + v[1]! * r)}`;
  for (let i = 2; i < v.length; i += 2) d += `L${n(x + v[i]! * r)} ${n(y + v[i + 1]! * r)}`;
  return `${d}Z`;
}

/** The drawing of markers, made once per kit. */
export function markerDrawing(kit: GuideKit): Drawing<PointGeometry> {
  let drawing = drawings.get(kit);
  if (drawing) return drawing;
  const elements = (mark: PointGeometry): SvgElement[] => {
    const c = mark.coords;
    let d = "";
    for (let i = 0; i < mark.count; i++)
      d += markerPath(kit, mark.symbol, c[i * 2]!, c[i * 2 + 1]!, mark.radius);
    const attributes: Record<string, string> = { d, fill: mark.fill };
    if (mark.fillOpacity !== 1) attributes["fill-opacity"] = String(mark.fillOpacity);
    const ring = mark.ring;
    if (ring) {
      attributes.stroke = ring.color;
      attributes["stroke-width"] = String(ring.width);
      attributes["stroke-linejoin"] = "round";
      if (ring.opacity !== undefined) attributes["stroke-opacity"] = String(ring.opacity);
    }
    return [{ tag: "path", attributes }];
  };
  drawing = {
    size: (mark) => mark.count,
    elements,
    svg: (mark) => kit.markupOf(elements(mark)),
    canvas(context, mark) {
      const c = mark.coords;
      const r = mark.radius;
      context.beginPath();
      for (let i = 0; i < mark.count; i++) {
        const x = c[i * 2]!;
        const y = c[i * 2 + 1]!;
        if (mark.symbol === "circle") {
          context.moveTo(x + r, y);
          context.arc(x, y, r, 0, Math.PI * 2);
          continue;
        }
        const v = vertices(mark.symbol);
        context.moveTo(x + v[0]! * r, y + v[1]! * r);
        for (let j = 2; j < v.length; j += 2) context.lineTo(x + v[j]! * r, y + v[j + 1]! * r);
        context.closePath();
      }
      const alpha = context.globalAlpha;
      context.globalAlpha = alpha * mark.fillOpacity;
      context.fillStyle = mark.fill;
      context.fill();
      const ring = mark.ring;
      if (ring) {
        context.globalAlpha = alpha * (ring.opacity ?? 1);
        context.strokeStyle = ring.color;
        context.lineWidth = ring.width;
        context.lineJoin = "round";
        context.stroke();
      }
      context.globalAlpha = alpha;
    },
  };
  drawings.set(kit, drawing);
  return drawing;
}

/**
 * The markers of a series at `coords` (x, y pairs, `count` of them): its
 * marker style over the mark's, in `color` unless they name their own.
 */
export function markers(
  kit: GuideKit,
  key: string,
  coords: Float32Array,
  count: number,
  style: MarkerStyle,
  symbol: SymbolName,
  color: string,
  opacity: number,
): PointGeometry {
  const fillOpacity = (style.opacity ?? 1) * opacity;
  const stroke = style.stroke;
  return {
    kind: "point",
    draw: markerDrawing(kit),
    key: `${key}|markers`,
    of: key,
    fill: style.fill ?? color,
    fillOpacity,
    opaque: false,
    radius: style.radius ?? MARKER_RADIUS,
    symbol: style.symbol ?? symbol,
    coords,
    count,
    ring:
      stroke !== undefined || style.strokeWidth !== undefined
        ? { color: stroke ?? color, width: style.strokeWidth ?? 1, opacity: fillOpacity }
        : undefined,
  };
}
