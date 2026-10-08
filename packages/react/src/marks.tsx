// Mark elements. They render nothing; <Chart> reads their props and builds
// marks from them, so a chart is written as a list of layers.

import {
  type AreaOptions,
  area,
  type BarOptions,
  type BoxPlotOptions,
  bar,
  boxplot,
  type CandlestickOptions,
  type ChartMark,
  type CustomDataOptions,
  type CustomOptions,
  candlestick,
  custom,
  type ErrorBarOptions,
  errorBar,
  type FunnelOptions,
  funnel,
  type GaugeOptions,
  gauge,
  type HeatmapOptions,
  type HistogramOptions,
  heatmap,
  histogram,
  type LineOptions,
  line,
  type PieOptions,
  type PointOptions,
  pie,
  point,
  type RegionDataOptions,
  type RegionOptions,
  type RuleDataOptions,
  type RuleOptions,
  region,
  rule,
  type Schema,
  type SunburstOptions,
  sunburst,
  type Table,
  type TextDataOptions,
  type TextOptions,
  type TreemapOptions,
  text,
  treemap,
} from "herceg";

/** Props of a mark element: the mark's options plus the table it reads. */
export type WithData<O, S extends Schema> = O & { data: Table<S> };

/** A component that renders nothing and tells <Chart> how to build its mark. */
interface MarkElement<P> {
  (props: P): null;
  displayName: string;
  buildMark: (props: P) => ChartMark;
}

/**
 * Each element carries its own builder, so an application that only uses
 * <Line> does not bundle bar, point, or heatmap code. Calls are marked pure
 * for the same reason.
 */
function markElement<P>(name: string, buildMark: (props: P) => ChartMark): MarkElement<P> {
  const element = (() => null) as unknown as MarkElement<P>;
  element.displayName = name;
  element.buildMark = buildMark;
  return element;
}

/** How <Chart> turns a child element into a mark; undefined for other elements. */
export function markBuilder(type: unknown): ((props: unknown) => ChartMark) | undefined {
  const build = (type as Partial<MarkElement<unknown>> | null)?.buildMark;
  return typeof build === "function" ? build : undefined;
}

// Builders receive props already checked by the element's generic type; the
// casts only erase the schema parameter.

/** Lines through x and y fields of `data`. */
export const Line = /* @__PURE__ */ markElement(
  "Line",
  ({ data, ...options }: WithData<LineOptions<Schema>, Schema>) => line(data, options),
) as unknown as <S extends Schema>(props: WithData<LineOptions<S>, S>) => null;

/** Filled areas: to zero, stacked, or a band between two fields. */
export const Area = /* @__PURE__ */ markElement(
  "Area",
  ({ data, ...options }: WithData<AreaOptions<Schema>, Schema>) =>
    area(data, options as AreaOptions<Schema>),
) as unknown as <S extends Schema>(props: WithData<AreaOptions<S>, S>) => null;

/** Bars: vertical, or horizontal when `y` is a category. */
export const Bar = /* @__PURE__ */ markElement(
  "Bar",
  ({ data, ...options }: WithData<BarOptions<Schema>, Schema>) => bar(data, options),
) as unknown as <S extends Schema>(props: WithData<BarOptions<S>, S>) => null;

/** Scatter points. */
export const Point = /* @__PURE__ */ markElement(
  "Point",
  ({ data, ...options }: WithData<PointOptions<Schema>, Schema>) => point(data, options),
) as unknown as <S extends Schema>(props: WithData<PointOptions<S>, S>) => null;

/** Error bars: `x`, `y1`, `y2` (vertical) or `y`, `x1`, `x2` (horizontal). */
export const ErrorBar = /* @__PURE__ */ markElement(
  "ErrorBar",
  ({ data, ...options }: WithData<ErrorBarOptions<Schema>, Schema>) => errorBar(data, options),
) as unknown as <S extends Schema>(props: WithData<ErrorBarOptions<S>, S>) => null;

/** A pie, or with `innerRadius` a donut; it has its chart to itself. */
export const Pie = /* @__PURE__ */ markElement(
  "Pie",
  ({ data, ...options }: WithData<PieOptions<Schema>, Schema>) => pie(data, options),
) as unknown as <S extends Schema>(props: WithData<PieOptions<S>, S>) => null;

/** Box plots: a category field on `x` or `y` and the values on the other. */
export const BoxPlot = /* @__PURE__ */ markElement(
  "BoxPlot",
  ({ data, ...options }: WithData<BoxPlotOptions<Schema>, Schema>) => boxplot(data, options),
) as unknown as <S extends Schema>(props: WithData<BoxPlotOptions<S>, S>) => null;

/** A treemap of a tree given by `path` fields, or `node` and `parent`; it has its chart to itself. */
export const Treemap = /* @__PURE__ */ markElement(
  "Treemap",
  ({ data, ...options }: WithData<TreemapOptions<Schema>, Schema>) => treemap(data, options),
) as unknown as <S extends Schema>(props: WithData<TreemapOptions<S>, S>) => null;

/** A sunburst of a tree given by `path` fields, or `node` and `parent`; it has its chart to itself. */
export const Sunburst = /* @__PURE__ */ markElement(
  "Sunburst",
  ({ data, ...options }: WithData<SunburstOptions<Schema>, Schema>) => sunburst(data, options),
) as unknown as <S extends Schema>(props: WithData<SunburstOptions<S>, S>) => null;

/** A gauge: the last finite value of `value` on a dial; it has its chart to itself. */
export const Gauge = /* @__PURE__ */ markElement(
  "Gauge",
  ({ data, ...options }: WithData<GaugeOptions<Schema>, Schema>) => gauge(data, options),
) as unknown as <S extends Schema>(props: WithData<GaugeOptions<S>, S>) => null;

/** A funnel: a centered bar per stage of `category`; it has its chart to itself. */
export const Funnel = /* @__PURE__ */ markElement(
  "Funnel",
  ({ data, ...options }: WithData<FunnelOptions<Schema>, Schema>) => funnel(data, options),
) as unknown as <S extends Schema>(props: WithData<FunnelOptions<S>, S>) => null;

/** Open-high-low-close candles: `x`, `open`, `high`, `low`, `close`. */
export const Candlestick = /* @__PURE__ */ markElement(
  "Candlestick",
  ({ data, ...options }: WithData<CandlestickOptions<Schema>, Schema>) =>
    candlestick(data, options),
) as unknown as <S extends Schema>(props: WithData<CandlestickOptions<S>, S>) => null;

/** Counts of a field's values in round bins: `x`, and optionally `bins` and `series`. */
export const Histogram = /* @__PURE__ */ markElement(
  "Histogram",
  ({ data, ...options }: WithData<HistogramOptions<Schema>, Schema>) => histogram(data, options),
) as unknown as <S extends Schema>(props: WithData<HistogramOptions<S>, S>) => null;

/** A grid of colored cells. */
export const Heatmap = /* @__PURE__ */ markElement(
  "Heatmap",
  ({ data, ...options }: WithData<HeatmapOptions<Schema>, Schema>) => heatmap(data, options),
) as unknown as <S extends Schema>(props: WithData<HeatmapOptions<S>, S>) => null;

/** Horizontal (`y`) or vertical (`x`) reference lines, constant or one per row of `data`. */
export const Rule = /* @__PURE__ */ markElement(
  "Rule",
  ({ data, ...options }: RuleOptions & { data?: Table<Schema> }) =>
    data ? rule(data, options as RuleDataOptions<Schema>) : rule(options),
) as unknown as {
  (props: RuleOptions): null;
  <S extends Schema>(props: WithData<RuleDataOptions<S>, S>): null;
};

/** Shaded x or y ranges, constant or one per row of `data`. */
export const Region = /* @__PURE__ */ markElement(
  "Region",
  ({ data, ...options }: RegionOptions & { data?: Table<Schema> }) =>
    data ? region(data, options as RegionDataOptions<Schema>) : region(options),
) as unknown as {
  (props: RegionOptions): null;
  <S extends Schema>(props: WithData<RegionDataOptions<S>, S>): null;
};

/** Text labels, constant or one per row of `data`. */
export const Text = /* @__PURE__ */ markElement(
  "Text",
  ({ data, ...options }: TextOptions & { data?: Table<Schema> }) =>
    data ? text(data, options as TextDataOptions<Schema>) : text(options),
) as unknown as {
  (props: TextOptions): null;
  <S extends Schema>(props: WithData<TextDataOptions<S>, S>): null;
};

/**
 * A custom mark: `draw` places shapes with the chart's scales, without
 * `data` or over the fields of `data`. Rebuilt on every render, since
 * `draw` may close over props or state.
 */
export const Custom = /* @__PURE__ */ markElement(
  "Custom",
  ({ data, ...options }: CustomOptions & { data?: Table<Schema> }) =>
    data ? custom(data, options as CustomDataOptions<Schema>) : custom(options),
) as unknown as {
  (props: CustomOptions): null;
  <S extends Schema>(props: WithData<CustomDataOptions<S>, S>): null;
};
