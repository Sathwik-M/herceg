import { line, table } from "herceg";
import { type PdfFontSource, pdfFonts, renderToPDF } from "herceg/pdf";

// Font programs are supplied at runtime; these sizes measure the export code.
export function render(x: Float64Array, y: Float64Array, fonts: readonly PdfFontSource[]) {
  return renderToPDF({
    width: 640,
    height: 320,
    marks: [line(table({ x, y }), { x: "x", y: "y" })],
    fonts: pdfFonts(fonts),
  });
}
