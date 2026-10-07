import type { AreaGeometry, Drawing, SvgElement } from "../scene/scene.ts";
import { linePath, traceLine } from "./line.ts";
import { markupOf, n } from "./markup.ts";

/** Closed outline of an area: the top edge, then the bottom edge back. */
export function areaPath(area: AreaGeometry): string {
  const upper = area.upper;
  const lower = area.lower;
  const u = upper.coords;
  let d = "";
  for (let run = 0; run < upper.starts.length; run++) {
    const start = upper.starts[run]!;
    const end = upper.runEnd(run);
    if (end - start < 1) continue;
    d += `M${n(u[start * 2]!)} ${n(u[start * 2 + 1]!)}`;
    for (let i = start + 1; i < end; i++) d += `L${n(u[i * 2]!)} ${n(u[i * 2 + 1]!)}`;
    if (lower && run < lower.starts.length) {
      const l = lower.coords;
      const lowerStart = lower.starts[run]!;
      for (let i = lower.runEnd(run) - 1; i >= lowerStart; i--)
        d += `L${n(l[i * 2]!)} ${n(l[i * 2 + 1]!)}`;
    } else {
      d += `L${n(u[(end - 1) * 2]!)} ${n(area.baseline)}L${n(u[start * 2]!)} ${n(area.baseline)}`;
    }
    d += "Z";
  }
  return d;
}

function traceArea(context: CanvasRenderingContext2D, area: AreaGeometry): void {
  const { upper, lower } = area;
  const u = upper.coords;
  for (let run = 0; run < upper.starts.length; run++) {
    const start = upper.starts[run]!;
    const end = upper.runEnd(run);
    if (end - start < 1) continue;
    context.moveTo(u[start * 2]!, u[start * 2 + 1]!);
    for (let i = start + 1; i < end; i++) context.lineTo(u[i * 2]!, u[i * 2 + 1]!);
    if (lower && run < lower.starts.length) {
      const l = lower.coords;
      const lowerStart = lower.starts[run]!;
      for (let i = lower.runEnd(run) - 1; i >= lowerStart; i--)
        context.lineTo(l[i * 2]!, l[i * 2 + 1]!);
    } else {
      context.lineTo(u[(end - 1) * 2]!, area.baseline);
      context.lineTo(u[start * 2]!, area.baseline);
    }
    context.closePath();
  }
}

/** The fill, then the outline of the top edge when the area has one. */
function areaElements(area: AreaGeometry): SvgElement[] {
  const out: SvgElement[] = [
    {
      tag: "path",
      attributes: {
        d: areaPath(area),
        fill: area.fill,
        "fill-opacity": String(area.fillOpacity),
        stroke: "none",
      },
    },
  ];
  if (area.stroke) {
    out.push({
      tag: "path",
      attributes: {
        d: linePath(area.upper),
        fill: "none",
        stroke: area.stroke,
        "stroke-width": String(area.strokeWidth),
        "stroke-linejoin": "round",
      },
    });
  }
  return out;
}

export const areaDrawing: Drawing<AreaGeometry> = {
  size: (area) => area.upper.count + (area.lower?.count ?? 0),
  elements: areaElements,
  svg: (area) => markupOf(areaElements(area)),
  canvas(context, area) {
    context.beginPath();
    traceArea(context, area);
    context.globalAlpha = area.fillOpacity;
    context.fillStyle = area.fill;
    context.fill();
    context.globalAlpha = 1;
    if (area.stroke) {
      context.beginPath();
      traceLine(context, area.upper);
      context.strokeStyle = area.stroke;
      context.lineWidth = area.strokeWidth;
      context.stroke();
    }
  },
};
