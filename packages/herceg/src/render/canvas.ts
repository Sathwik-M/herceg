// Draws grid lines and mark geometry into a 2D canvas. Axes, labels, and
// overlays stay in SVG above the canvas, so text is crisp and accessible and
// pointer feedback never repaints the data.

import { mapValue } from "../lod/m4.ts";
import type { Polyline } from "../lod/polyline.ts";
import type {
  AreaGeometry,
  MarkGeometry,
  PointGeometry,
  RasterGeometry,
  Rect,
  RectGeometry,
  RuleGeometry,
  Scene,
} from "../scene/scene.ts";
import type { CloudPainter } from "./webgl.ts";

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

function drawRule(context: CanvasRenderingContext2D, rule: RuleGeometry): void {
  context.beginPath();
  context.setLineDash(rule.dash ? [...rule.dash] : []);
  context.strokeStyle = rule.stroke;
  context.lineWidth = rule.strokeWidth;
  context.moveTo(rule.x1, rule.y1);
  context.lineTo(rule.x2, rule.y2);
  context.stroke();
  context.setLineDash([]);
}

function drawRects(context: CanvasRenderingContext2D, mark: RectGeometry): void {
  const r = mark.rects;
  context.beginPath();
  for (let i = 0; i < mark.count; i++)
    context.rect(r[i * 4]!, r[i * 4 + 1]!, r[i * 4 + 2]!, r[i * 4 + 3]!);
  context.globalAlpha = mark.fillOpacity;
  context.fillStyle = mark.fill;
  context.fill();
  context.globalAlpha = 1;
}

function drawPoints(context: CanvasRenderingContext2D, mark: PointGeometry): void {
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

/** Offscreen canvases holding raster pixels, reused per raster key. */
const rasterCanvases = new WeakMap<
  CanvasRenderingContext2D,
  Map<string, HTMLCanvasElement | OffscreenCanvas>
>();

function drawRaster(context: CanvasRenderingContext2D, mark: RasterGeometry): void {
  let byKey = rasterCanvases.get(context);
  if (!byKey) {
    byKey = new Map();
    rasterCanvases.set(context, byKey);
  }
  let source = byKey.get(mark.key);
  if (!source || source.width !== mark.columns || source.height !== mark.rows) {
    source =
      typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(mark.columns, mark.rows)
        : Object.assign(context.canvas.ownerDocument.createElement("canvas"), {
            width: mark.columns,
            height: mark.rows,
          });
    byKey.set(mark.key, source);
  }
  const target = source.getContext("2d") as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!target) return;
  target.putImageData(new ImageData(mark.pixels, mark.columns, mark.rows), 0, 0);
  // Cells are flat colors; smoothing would blur their edges.
  const smoothing = context.imageSmoothingEnabled;
  context.imageSmoothingEnabled = false;
  context.drawImage(source, mark.x, mark.y, mark.width, mark.height);
  context.imageSmoothingEnabled = smoothing;
}

export function drawMark(context: CanvasRenderingContext2D, mark: MarkGeometry): void {
  if (mark.kind === "line") {
    context.beginPath();
    traceLine(context, mark.path);
    context.setLineDash(mark.dash ? [...mark.dash] : []);
    context.strokeStyle = mark.stroke;
    context.lineWidth = mark.strokeWidth;
    context.stroke();
    context.setLineDash([]);
  } else if (mark.kind === "area") {
    context.beginPath();
    traceArea(context, mark);
    context.globalAlpha = mark.fillOpacity;
    context.fillStyle = mark.fill;
    context.fill();
    context.globalAlpha = 1;
    if (mark.stroke) {
      context.beginPath();
      traceLine(context, mark.upper);
      context.strokeStyle = mark.stroke;
      context.lineWidth = mark.strokeWidth;
      context.stroke();
    }
  } else if (mark.kind === "rect") {
    drawRects(context, mark);
  } else if (mark.kind === "point") {
    drawPoints(context, mark);
  } else if (mark.kind === "raster") {
    drawRaster(context, mark);
  } else {
    drawRule(context, mark);
  }
}

/** How `paintCanvas` draws point clouds. */
export interface CloudOptions {
  /** GPU painter; without one, or where it declines, points are placed on the CPU. */
  painter?: CloudPainter | undefined;
  /** The chart painting, which owns the painter's uploads. */
  owner?: object;
  /** Leave clouds out, as while the painter is still loading. */
  defer?: boolean;
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
 * Paints the scene's grid and marks. The canvas backing store is sized to the
 * scene times its pixel ratio; drawing happens in CSS pixels.
 */
export function paintCanvas(
  canvas: HTMLCanvasElement,
  scene: Scene,
  clouds: CloudOptions = {},
): void {
  const ratio = scene.pixelRatio;
  const width = Math.round(scene.width * ratio);
  const height = Math.round(scene.height * ratio);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext("2d");
  if (!context) return;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, width, height);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.lineJoin = "round";
  context.lineCap = "round";

  const { plot, grid, theme } = scene;
  if (theme.background !== "transparent") {
    context.fillStyle = theme.background;
    context.fillRect(0, 0, scene.width, scene.height);
  }
  if (grid.x.length + grid.y.length > 0) {
    context.beginPath();
    for (const y of grid.y) {
      const snapped = (Math.round(y * ratio) + 0.5) / ratio;
      context.moveTo(plot.x, snapped);
      context.lineTo(plot.x + plot.width, snapped);
    }
    for (const x of grid.x) {
      const snapped = (Math.round(x * ratio) + 0.5) / ratio;
      context.moveTo(snapped, plot.y);
      context.lineTo(snapped, plot.y + plot.height);
    }
    context.strokeStyle = theme.grid;
    context.lineWidth = 1 / ratio;
    context.stroke();
  }

  context.save();
  context.beginPath();
  context.rect(plot.x, plot.y, plot.width, plot.height);
  context.clip();
  for (const mark of scene.marks) {
    if (mark.kind === "rule") continue;
    if (mark.kind === "point" && mark.cloud) {
      if (clouds.defer) continue;
      const { painter, owner = canvas } = clouds;
      if (!painter?.paint(context, mark, plot, ratio, owner))
        drawMark(context, placeCloud(mark, plot));
    } else {
      drawMark(context, mark);
    }
  }
  context.restore();
  pruneRasters(context, scene);
}

/** Drops the offscreen canvases of rasters the scene no longer has. */
function pruneRasters(context: CanvasRenderingContext2D, scene: Scene): void {
  const byKey = rasterCanvases.get(context);
  if (!byKey || byKey.size === 0) return;
  const live = new Set(scene.marks.flatMap((m) => (m.kind === "raster" ? [m.key] : [])));
  for (const key of byKey.keys()) if (!live.has(key)) byKey.delete(key);
}

/** Raster pixels as a PNG data URL, encoded by the browser through a canvas. */
export function canvasRasterUrl(mark: RasterGeometry, document: Document): string {
  const canvas = document.createElement("canvas");
  canvas.width = mark.columns;
  canvas.height = mark.rows;
  canvas.getContext("2d")?.putImageData(new ImageData(mark.pixels, mark.columns, mark.rows), 0, 0);
  return canvas.toDataURL();
}
