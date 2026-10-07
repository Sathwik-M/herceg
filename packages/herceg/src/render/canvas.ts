// Draws grid lines and mark geometry into a 2D canvas. Axes, labels, and
// overlays stay in SVG above the canvas, so text is crisp and accessible and
// pointer feedback never repaints the data.

import type { Polyline } from "../lod/polyline.ts";
import type { AreaGeometry, MarkGeometry, RuleGeometry, Scene } from "../scene/scene.ts";

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
  } else {
    drawRule(context, mark);
  }
}

/**
 * Paints the scene's grid and marks. The canvas backing store is sized to the
 * scene times its pixel ratio; drawing happens in CSS pixels.
 */
export function paintCanvas(canvas: HTMLCanvasElement, scene: Scene): void {
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
  for (const mark of scene.marks) if (mark.kind !== "rule") drawMark(context, mark);
  context.restore();
}
