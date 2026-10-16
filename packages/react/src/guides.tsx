// Guide elements, imported as `@herceg/react/guides`. They render nothing:
// <Chart> reads them among its children and adds them to its `guides`.

import { type LegendGuideOptions, legend } from "herceg";
import type { PartElement } from "./chart.tsx";

export type LegendProps = Omit<LegendGuideOptions, "type">;

/**
 * A legend. Inside a <Panel> or an <Inset>, the panel's own: its entries
 * are what the panel draws, and they hide and show its series there only.
 * Among the chart's children, the chart's, or with `panel`, that panel's.
 *
 * ```tsx
 * <Panel id="latency">
 *   <Line data={data} x="time" y="p99" color="region" />
 *   <Legend place={{ inside: "top-left" }} />
 * </Panel>
 * ```
 */
export const Legend: PartElement<LegendProps> = /* @__PURE__ */ (() => {
  const element = (() => null) as unknown as PartElement<LegendProps>;
  element.displayName = "Legend";
  element.addTo = (props, parts, placing) => {
    parts.guides.push(legend((placing?.props(element, props) ?? props) as LegendProps));
  };
  return element;
})();
