import { type ChartSpec, type SpecBuffer, specToPDF } from "herceg/spec";

// One buffered spec, including the portable loader and its supported marks.
export function render(spec: ChartSpec, buffers: readonly SpecBuffer[] = []) {
  return specToPDF({ spec, buffers });
}
