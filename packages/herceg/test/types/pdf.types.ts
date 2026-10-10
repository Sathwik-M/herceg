// Compile-time tests: checked by npm run typecheck, never executed.

import type { Chart } from "../../src/dom/handle.ts";
import { specToPDF } from "../../src/from-spec.ts";
import { type PdfFontSource, type PdfFonts, pdfFonts, renderToPDF } from "../../src/pdf.ts";
import type { ChartSpec } from "../../src/spec/spec.ts";

declare const sources: readonly PdfFontSource[];
declare const spec: ChartSpec;
const fonts: PdfFonts = pdfFonts(sources, { fallback: ["Symbols"], missingGlyph: "?" });
renderToPDF({ width: 320, height: 120, marks: [], fonts });
specToPDF(spec, [], { fonts });
// @ts-expect-error fallback belongs to pdfFonts, not export options
renderToPDF({ width: 320, height: 120, marks: [], fonts, fallback: ["Symbols"] });
// @ts-expect-error missingGlyph belongs to pdfFonts, not export options
renderToPDF({ width: 320, height: 120, marks: [], fonts, missingGlyph: "?" });
// @ts-expect-error spec export options only take prepared fonts
specToPDF(spec, [], { fonts, fallback: ["Symbols"] });
// @ts-expect-error spec export options only take prepared fonts
specToPDF(spec, [], { fonts, missingGlyph: "?" });

// A mounted chart's PDF shows it as it is, taking export settings only.
declare const chart: Chart;
renderToPDF(chart);
renderToPDF(chart, { fonts });
// @ts-expect-error a mounted chart has its own size
renderToPDF(chart, { width: 320 });
const png: Promise<Blob> = chart.toPNG({ scale: 2 });
void png;
