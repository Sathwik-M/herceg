// The script embedded in HTML output and notebook widgets: renders a chart
// spec with its buffers into an element.

import { type ChartSpec, chartFromSpec } from "herceg/spec";
import { decodeBase64 } from "./buffers.ts";

export function render(
  element: HTMLElement,
  spec: ChartSpec,
  buffers: (string | DataView | ArrayBuffer)[],
) {
  return chartFromSpec(
    element,
    spec,
    buffers.map((buffer) => (typeof buffer === "string" ? decodeBase64(buffer) : buffer)),
  );
}
