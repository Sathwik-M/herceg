import type { Polyline } from "../lod/polyline.ts";
import type { Drawing, LineGeometry, SvgElement } from "../scene/scene.ts";
import { markupOf, n } from "./markup.ts";

/** Path data for a polyline, one subpath per run. */
export function linePath(path: Polyline): string {
  const c = path.coords;
  let d = "";
  for (let run = 0; run < path.starts.length; run++) {
    const start = path.starts[run]!;
    const end = path.runEnd(run);
    if (end - start < 1) continue;
    d += `M${n(c[start * 2]!)} ${n(c[start * 2 + 1]!)}`;
    for (let i = start + 1; i < end; i++) d += `L${n(c[i * 2]!)} ${n(c[i * 2 + 1]!)}`;
  }
  return d;
}

/** Adds a polyline's runs to the current canvas path. */
export function traceLine(context: CanvasRenderingContext2D, path: Polyline): void {
  const c = path.coords;
  for (let run = 0; run < path.starts.length; run++) {
    const start = path.starts[run]!;
    const end = path.runEnd(run);
    if (end - start < 1) continue;
    context.moveTo(c[start * 2]!, c[start * 2 + 1]!);
    for (let i = start + 1; i < end; i++) context.lineTo(c[i * 2]!, c[i * 2 + 1]!);
  }
}

function lineElements(line: LineGeometry): SvgElement[] {
  const attributes: Record<string, string> = {
    d: linePath(line.path),
    fill: "none",
    stroke: line.stroke,
    "stroke-width": String(line.strokeWidth),
    "stroke-linejoin": "round",
    "stroke-linecap": "round",
  };
  if (line.dash && line.dash.length > 0) attributes["stroke-dasharray"] = line.dash.join(" ");
  return [{ tag: "path", attributes }];
}

export const lineDrawing: Drawing<LineGeometry> = {
  size: (line) => line.path.count,
  elements: lineElements,
  svg: (line) => markupOf(lineElements(line)),
  canvas(context, line) {
    context.beginPath();
    traceLine(context, line.path);
    context.setLineDash(line.dash ? [...line.dash] : []);
    context.strokeStyle = line.stroke;
    context.lineWidth = line.strokeWidth;
    context.stroke();
    context.setLineDash([]);
  },
};
