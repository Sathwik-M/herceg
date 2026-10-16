// Guide components, imported as `@herceg/vue/guides`. They render nothing:
// <Chart> reads them from its slot and adds them to its `guides`.

import { type LegendGuideOptions, legend } from "herceg";
import type { PartComponent } from "./chart.ts";
import { optionsOf } from "./marks.ts";

export type LegendProps = Omit<LegendGuideOptions, "type">;

/**
 * A legend. Inside a <Panel> or an <Inset>, the panel's own: its entries
 * are what the panel draws, and they hide and show its series there only.
 * In the chart's slot, the chart's, or with `panel`, that panel's.
 *
 * ```vue
 * <Panel id="latency">
 *   <Line :data="data" x="time" y="p99" color="region" />
 *   <Legend :place="{ inside: 'top-left' }" />
 * </Panel>
 * ```
 */
export const Legend = /* @__PURE__ */ (() => {
  const component = (() => null) as unknown as PartComponent;
  component.displayName = "Legend";
  component.addTo = (vnode, parts, placing) => {
    const options = optionsOf(vnode.props) as LegendProps;
    parts.guides.push(legend((placing?.props(component, options) ?? options) as LegendProps));
  };
  return component as unknown as (props: LegendProps) => null;
})();
