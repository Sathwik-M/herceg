import type { AreaGeometry, Drawing, SvgElement } from "../scene/scene.ts";
import { linePath, traceLine, traceRun } from "./line.ts";
import { markupOf, type PathSink, SvgPath } from "./markup.ts";

/** Adds an area's outline to `sink`: per run, the top edge, then the bottom edge back. */
export function traceArea(sink: PathSink, area: AreaGeometry): void {
  const { upper, lower } = area;
  const u = upper.coords;
  for (let run = 0; run < upper.starts.length; run++) {
    const start = upper.starts[run]!;
    const end = upper.runEnd(run);
    if (end - start < 1) continue;
    sink.moveTo(u[start * 2]!, u[start * 2 + 1]!);
    traceRun(sink, upper, start, end, true);
    if (lower && run < lower.starts.length) {
      const l = lower.coords;
      const lowerStart = lower.starts[run]!;
      const lowerEnd = lower.runEnd(run);
      sink.lineTo(l[(lowerEnd - 1) * 2]!, l[(lowerEnd - 1) * 2 + 1]!);
      traceRun(sink, lower, lowerStart, lowerEnd, false);
    } else {
      sink.lineTo(u[(end - 1) * 2]!, area.baseline);
      sink.lineTo(u[start * 2]!, area.baseline);
    }
    sink.closePath();
  }
}

/** Closed outline of an area, as SVG path data. */
export function areaPath(area: AreaGeometry): string {
  const svg = new SvgPath();
  traceArea(svg, area);
  return svg.d;
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
