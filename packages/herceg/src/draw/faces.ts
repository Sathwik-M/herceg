// Faces of a 3D chart: polygons (surface cells) and discs (points), drawn in
// the order given, which is back to front. Faces of one opaque style that
// follow each other are filled as one path; translucent faces, and faces
// outlined in another color, are drawn one by one, so each covers or
// composites over what is behind it.

import { isOpaqueColor } from "../scale/color.ts";
import type { Drawing, FaceGeometry, FaceStyle, SvgElement } from "../scene/scene.ts";
import { markupOf, n, type PathSink } from "./markup.ts";

/** Faces per path at most: Chrome fills a path of thousands of arcs slower than many short ones. */
const RUN = 64;

/** What polygons are traced into, and how discs are. */
export interface FaceSink extends Pick<PathSink, "moveTo" | "lineTo" | "closePath"> {
  disc(x: number, y: number, r: number): void;
}

/** Runs of faces drawn as one path: [first, end) and their style. */
export function faceRuns(mark: FaceGeometry): { start: number; end: number; style: FaceStyle }[] {
  const runs: { start: number; end: number; style: FaceStyle }[] = [];
  const { count, style, styles } = mark;
  // Outlines in another color (a wireframe) must be hidden by the faces in
  // front, so those faces are drawn one by one, as are translucent ones.
  const batched = styles.map(
    ({ opacity, stroke, fill }) =>
      opacity >= 1 && isOpaqueColor(fill) && (stroke === undefined || stroke === fill),
  );
  let start = 0;
  while (start < count) {
    const s = style[start]!;
    let end = start + 1;
    if (batched[s]) while (end < count && end - start < RUN && style[end] === s) end++;
    runs.push({ start, end, style: styles[s]! });
    start = end;
  }
  return runs;
}

/** Twice the signed area of the triangle a, b, c of `mark`'s vertices. */
function turn(v: Float32Array, a: number, b: number, c: number): number {
  return (
    (v[b * 2]! - v[a * 2]!) * (v[c * 2 + 1]! - v[a * 2 + 1]!) -
    (v[b * 2 + 1]! - v[a * 2 + 1]!) * (v[c * 2]! - v[a * 2]!)
  );
}

/**
 * Traces face `f`'s fill: a disc, or a polygon whose fan of triangles all
 * turn the same way, or else each triangle of the fan turned one way, so
 * the nonzero rule fills their union.
 */
export function traceFace(sink: FaceSink, mark: FaceGeometry, f: number): void {
  const { vertices: v, corners, starts } = mark;
  const start = starts[f]!;
  const end = starts[f + 1]!;
  const first = corners[start]!;
  if (end - start === 1) {
    sink.disc(v[first * 2]!, v[first * 2 + 1]!, mark.styles[mark.style[f]!]!.radius);
    return;
  }
  if (end - start < 3) return;
  let positive = false;
  let negative = false;
  for (let k = start + 1; k + 1 < end; k++) {
    const t = turn(v, first, corners[k]!, corners[k + 1]!);
    if (t > 0) positive = true;
    else if (t < 0) negative = true;
  }
  const point = (k: number, move: boolean) => {
    const i = corners[k]!;
    if (move) sink.moveTo(v[i * 2]!, v[i * 2 + 1]!);
    else sink.lineTo(v[i * 2]!, v[i * 2 + 1]!);
  };
  if (!(positive && negative)) {
    // A simple polygon: its outline covers its triangles. Turned the one way
    // every face is, so faces filled together never cancel where they overlap.
    if (negative) for (let k = end - 1; k >= start; k--) point(k, k === end - 1);
    else for (let k = start; k < end; k++) point(k, k === start);
    sink.closePath();
    return;
  }
  for (let k = start + 1; k + 1 < end; k++) {
    const reverse = turn(v, first, corners[k]!, corners[k + 1]!) < 0;
    point(start, true);
    point(reverse ? k + 1 : k, false);
    point(reverse ? k : k + 1, false);
    sink.closePath();
  }
}

/** Traces polygon `f`'s outline; discs have none. */
export function traceOutline(sink: FaceSink, mark: FaceGeometry, f: number): void {
  const { vertices: v, corners, starts } = mark;
  const start = starts[f]!;
  const end = starts[f + 1]!;
  if (end - start < 3) return;
  for (let k = start; k < end; k++) {
    const i = corners[k]!;
    if (k === start) sink.moveTo(v[i * 2]!, v[i * 2 + 1]!);
    else sink.lineTo(v[i * 2]!, v[i * 2 + 1]!);
  }
  sink.closePath();
}

/** Builds SVG path data of faces. */
class SvgFaces implements FaceSink {
  d = "";
  moveTo(x: number, y: number): void {
    this.d += `M${n(x)} ${n(y)}`;
  }
  lineTo(x: number, y: number): void {
    this.d += `L${n(x)} ${n(y)}`;
  }
  closePath(): void {
    this.d += "Z";
  }
  disc(x: number, y: number, r: number): void {
    const [rr, d] = [n(r), n(r * 2)];
    this.d += `M${n(x - r)} ${n(y)}a${rr} ${rr} 0 1 0 ${d} 0a${rr} ${rr} 0 1 0 -${d} 0`;
  }
}

/** A canvas as a face sink: discs are arcs. */
function canvasSink(context: CanvasRenderingContext2D): FaceSink {
  return {
    moveTo: (x, y) => context.moveTo(x, y),
    lineTo: (x, y) => context.lineTo(x, y),
    closePath: () => context.closePath(),
    disc(x, y, r) {
      context.moveTo(x + r, y);
      context.arc(x, y, r, 0, Math.PI * 2);
    },
  };
}

/** One path per run: its fill and, for polygons with an outline, the outline. */
function elements(mark: FaceGeometry): SvgElement[] {
  const out: SvgElement[] = [];
  for (const { start, end, style } of faceRuns(mark)) {
    const fill = new SvgFaces();
    for (let f = start; f < end; f++) traceFace(fill, mark, f);
    if (!fill.d) continue;
    const attributes: Record<string, string> = { d: fill.d, fill: style.fill };
    if (style.opacity < 1) attributes["fill-opacity"] = String(style.opacity);
    out.push({ tag: "path", attributes });
    if (style.stroke === undefined || !(style.strokeWidth > 0)) continue;
    const outline = new SvgFaces();
    for (let f = start; f < end; f++) traceOutline(outline, mark, f);
    if (!outline.d) continue;
    out.push({
      tag: "path",
      attributes: {
        d: outline.d,
        fill: "none",
        stroke: style.stroke,
        "stroke-width": String(style.strokeWidth),
        "stroke-linejoin": "round",
      },
    });
  }
  return out;
}

/** A geometry's faces: its own, or those of the points a GPU painter would draw. */
function facesOf(mark: FaceGeometry): FaceGeometry {
  return mark.cloud ? mark.cloud.faces() : mark;
}

export const facesDrawing: Drawing<FaceGeometry> = {
  // Corners, as polygons count their points: a surface's cell weighs four.
  size(mark) {
    if (!mark.cloud) return mark.starts[mark.count] ?? 0;
    let points = 0;
    for (const layer of mark.cloud.layers) points += layer.x.length;
    return points;
  },
  elements: (mark) => elements(facesOf(mark)),
  svg: (mark) => markupOf(elements(facesOf(mark))),
  canvas(context, given, { plot, pixelRatio, clouds }) {
    if (given.cloud) {
      // Until the painter has loaded, clouds are left out, as 2D ones are.
      if (clouds.defer) return;
      const owner = clouds.owner ?? context.canvas;
      if (clouds.painter?.paint3d?.(context, given, plot, pixelRatio, owner)) return;
    }
    const mark = facesOf(given);
    const sink = canvasSink(context);
    context.save();
    context.lineJoin = "round";
    for (const { start, end, style } of faceRuns(mark)) {
      context.beginPath();
      for (let f = start; f < end; f++) traceFace(sink, mark, f);
      context.globalAlpha = style.opacity;
      context.fillStyle = style.fill;
      context.fill();
      if (style.stroke === undefined || !(style.strokeWidth > 0)) continue;
      context.beginPath();
      for (let f = start; f < end; f++) traceOutline(sink, mark, f);
      context.globalAlpha = 1;
      context.strokeStyle = style.stroke;
      context.lineWidth = style.strokeWidth;
      context.stroke();
    }
    context.restore();
  },
};
