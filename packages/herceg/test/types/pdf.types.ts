// Compile-time tests: checked by npm run typecheck, never executed.

import type { Chart } from "../../src/dom/handle.ts";
import { type FontSource, type Fonts, prepareFonts } from "../../src/fonts.ts";
import { specToPDF } from "../../src/from-spec.ts";
import { renderToPDF } from "../../src/pdf.ts";
import { renderToSVG } from "../../src/render/static.ts";
import type { ChartSpec } from "../../src/spec/spec.ts";

declare const sources: readonly FontSource[];
declare const spec: ChartSpec;
const fonts: Fonts = prepareFonts(sources);
// @ts-expect-error fallback and missingGlyph set PDF text: they are export options
prepareFonts(sources, { fallback: ["Symbols"] });
// The same fonts measure SVG exports and live charts.
renderToSVG({ width: 320, height: 120, marks: [], fonts });
// @ts-expect-error fonts are prepared, not a list of sources
renderToSVG({ width: 320, height: 120, marks: [], fonts: sources });
renderToPDF({ width: 320, height: 120, marks: [], fonts });
specToPDF(spec, { fonts });
renderToPDF(
  { width: 320, height: 120, marks: [] },
  { fonts, fallback: ["Symbols"], missingGlyph: "?" },
);
specToPDF(spec, { fonts, fallback: ["Symbols"], missingGlyph: "?" });
// @ts-expect-error fallback is the document's, not a chart's
renderToPDF({ width: 320, height: 120, marks: [], fonts, fallback: ["Symbols"] });
// @ts-expect-error missingGlyph is the document's, not a chart's
renderToPDF({ width: 320, height: 120, marks: [], fonts, missingGlyph: "?" });

// A mounted chart's PDF shows it as it is, taking export settings only.
declare const chart: Chart;
renderToPDF(chart);
renderToPDF(chart, { fonts });
// @ts-expect-error a mounted chart has its own size
renderToPDF(chart, { width: 320 });
const png: Promise<Blob> = chart.toPNG({ scale: 2 });
void png;

renderToPDF([chart, { width: 640, height: 320, marks: [] }], {
  fonts,
  pageSize: "A4",
  orientation: "landscape",
  margin: 36,
  title: "Report",
  language: "en-GB",
});
renderToPDF([{ width: 320, height: 120, marks: [], title: "Chart" }], {
  title: "Report",
  pageSize: "Letter",
});
specToPDF([spec, { spec, buffers: [new Float64Array(2)] }], { pageSize: "A4", fonts });
const mixedCharts = [chart, { width: 640, height: 320, marks: [] }] as const;
renderToPDF(mixedCharts, { pageSize: "A4" });
const mixedSpecs = [spec, { spec, buffers: [new Float64Array(2)] }] as const;
specToPDF(mixedSpecs, { pageSize: "A4" });
// @ts-expect-error named paper only
renderToPDF([chart], { pageSize: "Legal" });
// @ts-expect-error orientation is an enum
specToPDF([spec], { orientation: "diagonal" });
// @ts-expect-error collection sidecars must travel with their own spec
specToPDF([spec], [new Float64Array(2)]);
renderToPDF(chart, { pageSize: "A4" });

// A single buffered entry has the same shape as each item in a list.
specToPDF({ spec, buffers: [new Float64Array(2)] }, { subject: "Chart description" });
specToPDF(spec, { pageSize: "A4", subject: "Report description" });
renderToPDF({ width: 320, height: 120, marks: [] }, { pageSize: "A4" });
declare const targets: Chart | readonly (Chart | import("../../src/pdf.ts").PdfOptions)[];
renderToPDF(targets, { subject: "Report description" });
// @ts-expect-error positional spec sidecars are removed
specToPDF(spec, [new Float64Array(2)]);
// @ts-expect-error positional spec sidecars and settings are removed
specToPDF(spec, [], { fonts });
// @ts-expect-error static options retain contextual mark checking
renderToPDF([{ width: 320, height: 120, marks: ["line"] }]);
