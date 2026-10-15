// The script embedded in HTML output and notebook widgets: renders a chart
// spec with its buffers into an element, or where the spec is refused, says
// so in the chart's place, as a chart that cannot draw does.

import { type Chart, showFailure } from "herceg";
import { type ChartSpec, chartFromSpec } from "herceg/spec";
import { decodeBase64 } from "./buffers.ts";

export function render(
  element: HTMLElement,
  spec: ChartSpec,
  buffers: (string | DataView | ArrayBuffer)[],
): Chart | undefined {
  try {
    return chartFromSpec(
      element,
      spec,
      buffers.map((buffer) => (typeof buffer === "string" ? decodeBase64(buffer) : buffer)),
    );
  } catch (error) {
    // The stack stays in the console; the page shows the message.
    console.error(error);
    const { width, height } = element.getBoundingClientRect();
    showFailure(element, error, false, { width: width || 640, height: height || 320 });
    return undefined;
  }
}
