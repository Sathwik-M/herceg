import type { Drawing, PathShape, ShapesGeometry, TextShape } from "../scene/scene.ts";
import { dashAttribute, escapeXml, n } from "./markup.ts";

const ALIGN = { start: "start", middle: "center", end: "end" } as const;

/**
 * Distance from a text's middle to its alphabetic baseline, in font sizes.
 * Both renderers place text on the alphabetic baseline at this offset, since
 * Canvas and SVG disagree about where the "middle" baseline is.
 */
export const MIDDLE_TO_BASELINE = 0.35;

function isText(shape: PathShape | TextShape): shape is TextShape {
  return "text" in shape;
}

/**
 * Shapes of custom marks. Paths are SVG path data, so SVG draws them as
 * written and a canvas reads them through `Path2D`. Both renderers use
 * butt caps and miter joins (SVG's defaults), apply opacity to fill and
 * stroke separately, and place text on the same baseline.
 */
export const shapesDrawing: Drawing<ShapesGeometry> = {
  size: (mark) => mark.shapes.length,
  svg(mark, { theme }) {
    const baseline = mark.fontSize * MIDDLE_TO_BASELINE;
    // Text inherits the chart's font, unless it is larger or bolder.
    let font = mark.fontSize === theme.fontSize ? "" : ` font-size="${n(mark.fontSize)}"`;
    if (mark.bold) font += ' font-weight="600"';
    let out = "";
    for (const shape of mark.shapes) {
      if (isText(shape)) {
        out += `<text x="${n(shape.x)}" y="${n(shape.y + baseline)}" fill="${escapeXml(shape.fill)}" text-anchor="${shape.anchor}"${font}>${escapeXml(shape.text)}</text>`;
        continue;
      }
      out += `<path d="${escapeXml(shape.d)}" fill="${escapeXml(shape.fill)}"`;
      if (shape.stroke !== undefined)
        out += ` stroke="${escapeXml(shape.stroke)}" stroke-width="${shape.strokeWidth}"${dashAttribute(shape.dash)}`;
      if (shape.opacity < 1)
        out += ` fill-opacity="${shape.opacity}" stroke-opacity="${shape.opacity}"`;
      out += "/>";
    }
    return out;
  },
  canvas(context, mark) {
    context.save();
    context.lineCap = "butt";
    context.lineJoin = "miter";
    context.font = mark.font;
    context.textBaseline = "alphabetic";
    const baseline = mark.fontSize * MIDDLE_TO_BASELINE;
    for (const shape of mark.shapes) {
      if (isText(shape)) {
        context.globalAlpha = 1;
        context.textAlign = ALIGN[shape.anchor];
        context.fillStyle = shape.fill;
        context.fillText(shape.text, shape.x, shape.y + baseline);
        continue;
      }
      context.globalAlpha = shape.opacity;
      const path = new Path2D(shape.d);
      if (shape.fill !== "none") {
        context.fillStyle = shape.fill;
        context.fill(path);
      }
      if (shape.stroke !== undefined) {
        context.setLineDash(shape.dash ? [...shape.dash] : []);
        context.strokeStyle = shape.stroke;
        context.lineWidth = shape.strokeWidth;
        context.stroke(path);
      }
    }
    context.restore();
  },
};
