// Charts from portable specifications, imported as `herceg/spec`: for specs
// written by other languages (the Python package) or stored as JSON.

import { type Chart, createChart } from "./dom/chart.ts";
import type { MeasureText } from "./layout/text.ts";
import { type PdfExportOptions, renderToPDF } from "./pdf.ts";
import { renderToSVG } from "./render/static.ts";
import { type LoadedSpec, type LoadOptions, loadSpec, type SpecBuffer } from "./spec/load.ts";
import type { ChartSpec } from "./spec/spec.ts";

export type { PdfExportOptions, PdfFontOptions, PdfFontSource, PdfFonts } from "./pdf.ts";
export type * from "./spec/spec.ts";
export { SPEC_VERSION } from "./spec/spec.ts";
export { validateSpec } from "./spec/validate.ts";
export { type LoadedSpec, type LoadOptions, loadSpec, type SpecBuffer };

/**
 * Creates a chart in `element` from a spec and the binary buffers it
 * references; `options` as `loadSpec` takes them, such as the tables and
 * selection stores it shares with other charts.
 */
export function chartFromSpec(
  element: HTMLElement,
  spec: ChartSpec,
  buffers: readonly SpecBuffer[] = [],
  options: LoadOptions = {},
): Chart {
  return createChart(element, loadSpec(spec, buffers, options).config);
}

/**
 * Standalone SVG for a spec, without a DOM. Sizes default to 640 x 320 CSS
 * pixels when the spec has none.
 */
export function specToSVG(
  spec: ChartSpec,
  buffers: readonly SpecBuffer[] = [],
  options: { measureText?: MeasureText } = {},
): string {
  const { config } = loadSpec(spec, buffers);
  return renderToSVG({
    ...config,
    ...options,
    width: config.width ?? 640,
    height: config.height ?? 320,
  });
}

/** A one-page vector PDF for a spec (see `renderToPDF` in `herceg/pdf`), sized like `specToSVG`. */
export function specToPDF(
  spec: ChartSpec,
  buffers: readonly SpecBuffer[] = [],
  options: PdfExportOptions = {},
): Uint8Array {
  const { config } = loadSpec(spec, buffers);
  return renderToPDF({
    ...config,
    ...options,
    width: config.width ?? 640,
    height: config.height ?? 320,
  });
}
