// Mark elements. They render nothing; <Chart> reads their props and builds
// marks from them, so a chart is written as a list of layers.

import {
  type AreaOptions,
  area,
  type BarOptions,
  bar,
  type HeatmapOptions,
  heatmap,
  type LineOptions,
  line,
  type Mark,
  type PointOptions,
  point,
  type RuleOptions,
  rule,
  type Schema,
  type Table,
} from "herceg";

/** Props of a mark element: the mark's options plus the table it reads. */
export type WithData<O, S extends Schema> = O & { data: Table<S> };

/** A component that renders nothing and tells <Chart> how to build its mark. */
interface MarkElement<P> {
  (props: P): null;
  displayName: string;
  buildMark: (props: P) => Mark;
}

/**
 * Each element carries its own builder, so an application that only uses
 * <Line> does not bundle bar, point, or heatmap code. Calls are marked pure
 * for the same reason.
 */
function markElement<P>(name: string, buildMark: (props: P) => Mark): MarkElement<P> {
  const element = (() => null) as unknown as MarkElement<P>;
  element.displayName = name;
  element.buildMark = buildMark;
  return element;
}

/** How <Chart> turns a child element into a mark; undefined for other elements. */
export function markBuilder(type: unknown): ((props: unknown) => Mark) | undefined {
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

/** A grid of colored cells. */
export const Heatmap = /* @__PURE__ */ markElement(
  "Heatmap",
  ({ data, ...options }: WithData<HeatmapOptions<Schema>, Schema>) => heatmap(data, options),
) as unknown as <S extends Schema>(props: WithData<HeatmapOptions<S>, S>) => null;

/** A horizontal (`y`) or vertical (`x`) reference line. */
export const Rule = /* @__PURE__ */ markElement("Rule", (options: RuleOptions) => rule(options));
