// Charts from portable specifications, imported as `herceg/spec`: for specs
// written by other languages (the Python package) or stored as JSON.

import { type Chart, createChart } from "./dom/chart.ts";
import type { MeasureText } from "./layout/text.ts";
import { renderToSVG } from "./render/static.ts";
import { type LoadedSpec, loadSpec, type SpecBuffer } from "./spec/load.ts";
import type { ChartSpec } from "./spec/spec.ts";

export type * from "./spec/spec.ts";
export { type LoadedSpec, loadSpec, type SpecBuffer };

/** Creates a chart in `element` from a spec and the binary buffers it references. */
export function chartFromSpec(
  element: HTMLElement,
  spec: ChartSpec,
  buffers: readonly SpecBuffer[] = [],
): Chart {
  return createChart(element, loadSpec(spec, buffers).config);
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
