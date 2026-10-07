// Drawings fit only geometry of their own type, and the contract tells data
// from guides. Compiled by `npm run typecheck`.
import { lineDrawing } from "../../src/draw/line.ts";
import { rectDrawing } from "../../src/draw/rect.ts";
import type { Drawing, LineGeometry } from "../../src/scene/scene.ts";

declare const line: Omit<LineGeometry, "draw">;

export const paired: LineGeometry = { ...line, draw: lineDrawing };
// @ts-expect-error a rectangle drawing does not fit a line
export const mismatched: LineGeometry = { ...line, draw: rectDrawing };
// @ts-expect-error data drawings must paint on a canvas, or they vanish there
export const noCanvas: Drawing<LineGeometry> = { size: () => 0, svg: () => "" };
export const guide: Drawing<LineGeometry> = {
  guide: true,
  size: () => 0,
  svg: () => "",
  // @ts-expect-error guides are drawn in SVG only
  canvas: () => {},
};
