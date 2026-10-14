// Charts from portable specifications, imported as `herceg/spec`: for specs
// written by other languages (the Python package) or stored as JSON.

import { type Chart, createChart, MountedChart } from "./dom/chart.ts";
import type { Fonts } from "./fonts/registry.ts";
import type { MeasureText } from "./layout/text.ts";
import { type PdfExportOptions, type PdfOptions, renderToPDF } from "./pdf.ts";
import { renderToSVG } from "./render/static.ts";
import type { SvgSizing } from "./render/svg.ts";
import { type LoadedSpec, type LoadOptions, loadSpec, type SpecBuffer } from "./spec/load.ts";
import type { ChartSpec } from "./spec/spec.ts";

export type { Fonts } from "./fonts/registry.ts";
export type { PdfExportOptions, PdfPageOptions } from "./pdf.ts";
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
 * Gives `to`, a chart made again from a changed spec in place of `from`
 * (as a Streamlit app remounts its chart on each run), where `from`'s
 * networks have their nodes: nodes that remain stay where they were and new
 * ones enter beside their neighbors, as when a live chart's data changes.
 * Networks are matched by their mark's id (or index) and panel. Moved nodes
 * travel apart, by `getItemPositions` and `setItemPosition`. Call it before
 * `from` is destroyed; `to` draws again at once.
 */
export function carryNodePositions(from: Chart, to: Chart): void {
  const before = MountedChart.modelOf(from).items;
  const after = MountedChart.modelOf(to).items;
  if (!before || !after) return;
  after.adoptPositions(before);
  to.render();
}

/**
 * Standalone SVG for a spec, without a DOM. Sizes default to 640 x 320 CSS
 * pixels when the spec has none; `options` say how the SVG sizes and
 * scales, and what text is measured with: supplied `fonts`, whose families
 * the SVG names, or a `measureText` of its own.
 */
export function specToSVG(
  spec: ChartSpec,
  buffers: readonly SpecBuffer[] = [],
  options: SvgSizing & { fonts?: Fonts; measureText?: MeasureText } = {},
): string {
  const { config } = loadSpec(spec, buffers);
  return renderToSVG({
    ...config,
    ...options,
    width: config.width ?? 640,
    height: config.height ?? 320,
  });
}

/** One spec with its own binary sidecars, for a document's page. */
export interface PdfSpec {
  spec: ChartSpec;
  buffers?: readonly SpecBuffer[];
}

/** Vector PDF of one spec or a nonempty list, one chart per page. */
export function specToPDF(
  input: ChartSpec | PdfSpec | readonly (ChartSpec | PdfSpec)[],
  settings: PdfExportOptions = {},
): Uint8Array {
  if (Array.isArray(settings))
    throw new TypeError(
      "specToPDF settings: expected an options object; use { spec, buffers } for sidecars",
    );
  const chart = (item: ChartSpec | PdfSpec): PdfOptions => {
    const { config } = "spec" in item ? loadSpec(item.spec, item.buffers) : loadSpec(item);
    return { ...config, width: config.width ?? 640, height: config.height ?? 320 };
  };
  try {
    return renderToPDF(
      Array.isArray(input) ? input.map(chart) : chart(input as ChartSpec | PdfSpec),
      settings,
    );
  } catch (error) {
    if (error instanceof RangeError || error instanceof TypeError)
      throw new (error instanceof RangeError ? RangeError : TypeError)(
        error.message.replace("renderToPDF", "specToPDF"),
      );
    throw error;
  }
}
