import type { Polyline } from "../lod/polyline.ts";
import type { Drawing, LineGeometry, SvgElement } from "../scene/scene.ts";
import { markupOf, type PathSink, SvgPath } from "./markup.ts";

/**
 * Traces points [start, end) of a polyline into `sink`, from the first to
 * the last or (`forward` false) back, without moving to the first: curved
 * segments as cubic curves, the others as lines.
 */
export function traceRun(
  sink: PathSink,
  path: Polyline,
  start: number,
  end: number,
  forward: boolean,
): void {
  const c = path.coords;
  const k = path.curved ? path.controls : undefined;
  if (forward) {
    for (let i = start + 1; i < end; i++) {
      if (k && !Number.isNaN(k[i * 4]!))
        sink.bezierCurveTo(
          k[i * 4]!,
          k[i * 4 + 1]!,
          k[i * 4 + 2]!,
          k[i * 4 + 3]!,
          c[i * 2]!,
          c[i * 2 + 1]!,
        );
      else sink.lineTo(c[i * 2]!, c[i * 2 + 1]!);
    }
    return;
  }
  // Backward, each segment into point i is traced from i, its control points swapped.
  for (let i = end - 1; i > start; i--) {
    if (k && !Number.isNaN(k[i * 4]!))
      sink.bezierCurveTo(
        k[i * 4 + 2]!,
        k[i * 4 + 3]!,
        k[i * 4]!,
        k[i * 4 + 1]!,
        c[i * 2 - 2]!,
        c[i * 2 - 1]!,
      );
    else sink.lineTo(c[i * 2 - 2]!, c[i * 2 - 1]!);
  }
}

/** WebKit omits zero-length Canvas strokes; this stays below output precision. */
export const DOT_LENGTH = 0.001;

/** Adds a polyline's runs to `sink`, one subpath each. */
export function traceLine(sink: PathSink, path: Polyline): void {
  const c = path.coords;
  for (let run = 0; run < path.starts.length; run++) {
    const start = path.starts[run]!;
    const end = path.runEnd(run);
    if (end - start < 1) continue;
    sink.moveTo(c[start * 2]!, c[start * 2 + 1]!);
    // Round caps paint a stroke-sized dot; a lone move paints nothing.
    if (end === start + 1) sink.lineTo(c[start * 2]! + DOT_LENGTH, c[start * 2 + 1]!);
    traceRun(sink, path, start, end, true);
  }
}

/** Whether any run has just one point, needing a round cap to be visible. */
export function hasIsolated(path: Polyline): boolean {
  return path.starts.some((start, run) => path.runEnd(run) === start + 1);
}

/** Path data for a polyline, one subpath per run. */
export function linePath(path: Polyline): string {
  const svg = new SvgPath();
  traceLine(svg, path);
  return svg.d;
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
