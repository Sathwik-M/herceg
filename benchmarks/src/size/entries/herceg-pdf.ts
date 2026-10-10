import { line, table } from "herceg";
import { renderToPDF } from "herceg/pdf";

export function render(x: Float64Array, y: Float64Array) {
  return renderToPDF({
    width: 640,
    height: 320,
    marks: [line(table({ x, y }), { x: "x", y: "y" })],
  });
}
