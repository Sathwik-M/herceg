import { line, table } from "herceg";
import { renderToPDF } from "herceg/pdf";

export function render(x: Float64Array, y: Float64Array) {
  const chart = { width: 640, height: 320, marks: [line(table({ x, y }), { x: "x", y: "y" })] };
  return renderToPDF([chart, { ...chart, title: "Second chart" }], {
    pageSize: "A4",
    title: "Report",
  });
}
