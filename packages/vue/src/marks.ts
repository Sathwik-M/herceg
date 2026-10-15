// Mark components. They render nothing; <Chart> reads them from its slot and
// builds marks from their props, so a chart is written as a list of layers.

import {
  type AreaOptions,
  area,
  type BarOptions,
  type BoxenOptions,
  type BoxPlotOptions,
  bar,
  boxen,
  boxplot,
  type CandlestickOptions,
  type ChartMark,
  type ContourOptions,
  type CustomDataOptions,
  type CustomOptions,
  candlestick,
  contour,
  custom,
  type DendrogramOptions,
  dendrogram,
  type ErrorBarOptions,
  errorBar,
  type FunnelOptions,
  funnel,
  type GaugeOptions,
  type GeoPointOptions,
  type GeoShapeOptions,
  type GraphOptions,
  gauge,
  geopoint,
  geoshape,
  graph,
  type HeatmapOptions,
  type HistogramOptions,
  heatmap,
  histogram,
  type Line3DOptions,
  type LineOptions,
  line,
  line3d,
  type PieOptions,
  type Point3DOptions,
  type PointOptions,
  pie,
  point,
  point3d,
  type RadarOptions,
  type RegionDataOptions,
  type RegionOptions,
  type RowView,
  type RugOptions,
  type RuleDataOptions,
  type RuleOptions,
  radar,
  region,
  rug,
  rule,
  type SankeyOptions,
  type Schema,
  type SunburstOptions,
  type SurfaceOptions,
  sankey,
  sunburst,
  surface,
  type Table,
  type TextDataOptions,
  type TextOptions,
  type TreemapOptions,
  text,
  treemap,
  type ViolinOptions,
  violin,
} from "herceg";
import { camelize, toRaw } from "vue";

/** Props of a mark component: the mark's options plus the table it reads. */
export type WithData<O, S extends Schema> = O & { data: Table<S> };
/** Props of marks that show a table's rows or a row view's. */
export type WithRows<O, S extends Schema> = O & { data: Table<S> | RowView<S> };

// Annotations and custom marks draw from constants, or from `data` and its
// fields. Their components are generic in the table rather than its schema:
// Vue's template checker then infers the table from `data` before it types
// callbacks such as `draw`, and reports a wrong field on its attribute.
// Overloads would not do, since the checker drops the error of a call that
// no overload matches.

type NoData = { data?: undefined };
type RuleProps<T> = { data?: T } & (T extends Table<infer S extends Schema>
  ? RuleDataOptions<S>
  : RuleOptions & NoData);
type RegionProps<T> = { data?: T } & (T extends Table<infer S extends Schema>
  ? RegionDataOptions<S>
  : RegionOptions & NoData);
type TextProps<T> = { data?: T } & (T extends Table<infer S extends Schema>
  ? TextDataOptions<S>
  : TextOptions & NoData);
type CustomProps<T> = { data?: T } & (T extends Table<infer S extends Schema>
  ? CustomDataOptions<S>
  : CustomOptions & NoData);

/** A component that renders nothing and tells <Chart> how to build its mark. */
interface MarkComponent<P> {
  (props: P): null;
  displayName: string;
  buildMark: (props: P) => ChartMark;
  /** Boolean options, which a template may write as bare attributes. */
  flags: readonly string[];
}

/**
 * Each component carries its own builder, so an application that only uses
 * <Line> does not bundle bar, point, or heatmap code. Calls are marked pure
 * for the same reason.
 */
function markComponent<P>(
  name: string,
  buildMark: (props: P) => ChartMark,
  flags: readonly string[] = [],
): MarkComponent<P> {
  const component = (() => null) as unknown as MarkComponent<P>;
  component.displayName = name;
  component.buildMark = buildMark;
  component.flags = flags;
  return component;
}

/** Vue's own vnode props, which are not mark options. */
const RESERVED = new Set(["key", "ref", "ref_for", "ref_key"]);

/**
 * A copy of plain arrays and objects without Vue's reactive proxies, so a
 * mark never sees later in-place changes of the state it was built from
 * and reading the copy tracks every nested value. Class instances such as
 * tables are unwrapped but not copied: tables keep private fields, which
 * cannot be reached through a proxy.
 */
export function plain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plain);
  const raw = toRaw(value);
  if (raw && typeof raw === "object" && Object.getPrototypeOf(raw) === Object.prototype) {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).map((key) => [key, plain(object[key])]));
  }
  return raw;
}

/**
 * How <Chart> turns a vnode in its slot into a mark; undefined for other
 * vnodes. Mark components are never mounted, so props arrive as the
 * template wrote them: kebab-case names are camelized and bare boolean
 * attributes (`<Area stack />`) read as true.
 */
export function markBuilder(type: unknown): ((props: object | null) => ChartMark) | undefined {
  const component = type as Partial<MarkComponent<unknown>> | null;
  const build = component?.buildMark;
  if (typeof build !== "function") return undefined;
  const flags = component!.flags ?? [];
  return (props) => {
    const options: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props ?? {})) {
      if (RESERVED.has(key) || key.startsWith("onVnode")) continue;
      const name = camelize(key);
      options[name] = value === "" && flags.includes(name) ? true : plain(value);
    }
    return build(options);
  };
}

// Builders receive props already checked by the component's generic type;
// the casts only erase the schema parameter.

/** Lines through x and y fields of `data`. */
export const Line = /* @__PURE__ */ markComponent(
  "Line",
  ({ data, ...options }: WithData<LineOptions<Schema>, Schema>) => line(data, options),
  ["dodge", "markers"],
) as unknown as <S extends Schema>(props: WithData<LineOptions<S>, S>) => null;

/** Filled areas: to zero, stacked, or a band between two fields. */
export const Area = /* @__PURE__ */ markComponent(
  "Area",
  ({ data, ...options }: WithData<AreaOptions<Schema>, Schema>) =>
    area(data, options as AreaOptions<Schema>),
  ["stack", "line", "dodge"],
) as unknown as <S extends Schema>(props: WithData<AreaOptions<S>, S>) => null;

/** Bars: vertical, or horizontal when `y` is a category. */
export const Bar = /* @__PURE__ */ markComponent(
  "Bar",
  ({ data, ...options }: WithData<BarOptions<Schema>, Schema>) => bar(data, options),
  ["stack", "labels", "dodge"],
) as unknown as <S extends Schema>(props: WithData<BarOptions<S>, S>) => null;

/** Scatter points. */
export const Point = /* @__PURE__ */ markComponent(
  "Point",
  ({ data, ...options }: WithRows<PointOptions<Schema>, Schema>) => point(data, options),
  ["dodge", "swarm"],
) as unknown as <S extends Schema>(props: WithRows<PointOptions<S>, S>) => null;

/** Individual observations as short ticks at a plot edge. */
export const Rug = /* @__PURE__ */ markComponent(
  "Rug",
  ({ data, ...options }: WithData<RugOptions<Schema>, Schema>) => rug(data, options),
) as unknown as <S extends Schema>(props: WithData<RugOptions<S>, S>) => null;

/** Error bars: `x`, `y1`, `y2` (vertical) or `y`, `x1`, `x2` (horizontal). */
export const ErrorBar = /* @__PURE__ */ markComponent(
  "ErrorBar",
  ({ data, ...options }: WithData<ErrorBarOptions<Schema>, Schema>) => errorBar(data, options),
  ["dodge"],
) as unknown as <S extends Schema>(props: WithData<ErrorBarOptions<S>, S>) => null;

/** A pie, or with `innerRadius` a donut; it has its chart, each facet panel, or its `panel` to itself. */
export const Pie = /* @__PURE__ */ markComponent(
  "Pie",
  ({ data, ...options }: WithData<PieOptions<Schema>, Schema>) => pie(data, options),
  ["labels"],
) as unknown as <S extends Schema>(props: WithData<PieOptions<S>, S>) => null;

/** Box plots: a category field on `x` or `y` and the values on the other. */
export const BoxPlot = /* @__PURE__ */ markComponent(
  "BoxPlot",
  ({ data, ...options }: WithData<BoxPlotOptions<Schema>, Schema>) => boxplot(data, options),
  ["notch", "outliers"],
) as unknown as <S extends Schema>(props: WithData<BoxPlotOptions<S>, S>) => null;

/** Letter-value plots: a category field on `x` or `y` and the values on the other. */
export const Boxen = /* @__PURE__ */ markComponent(
  "Boxen",
  ({ data, ...options }: WithData<BoxenOptions<Schema>, Schema>) => boxen(data, options),
  ["outliers"],
) as unknown as <S extends Schema>(props: WithData<BoxenOptions<S>, S>) => null;

/** Violins: a category field on `x` or `y` and the values on the other. */
export const Violin = /* @__PURE__ */ markComponent(
  "Violin",
  ({ data, ...options }: WithData<ViolinOptions<Schema>, Schema>) => violin(data, options),
  ["split"],
) as unknown as <S extends Schema>(props: WithData<ViolinOptions<S>, S>) => null;

/** A treemap of a tree given by `path` fields, or `node` and `parent`; it has its chart, each facet panel, or its `panel` to itself. */
export const Treemap = /* @__PURE__ */ markComponent(
  "Treemap",
  ({ data, ...options }: WithData<TreemapOptions<Schema>, Schema>) => treemap(data, options),
  ["labels"],
) as unknown as <S extends Schema>(props: WithData<TreemapOptions<S>, S>) => null;

/** A sunburst of a tree given by `path` fields, or `node` and `parent`; it has its chart, each facet panel, or its `panel` to itself. */
export const Sunburst = /* @__PURE__ */ markComponent(
  "Sunburst",
  ({ data, ...options }: WithData<SunburstOptions<Schema>, Schema>) => sunburst(data, options),
  ["labels"],
) as unknown as <S extends Schema>(props: WithData<SunburstOptions<S>, S>) => null;

/** A gauge: the last finite value of `value` on a dial; it has its chart, each facet panel, or its `panel` to itself. */
export const Gauge = /* @__PURE__ */ markComponent(
  "Gauge",
  ({ data, ...options }: WithData<GaugeOptions<Schema>, Schema>) => gauge(data, options),
) as unknown as <S extends Schema>(props: WithData<GaugeOptions<S>, S>) => null;

/** A funnel: a centered bar per stage of `category`; it has its chart, each facet panel, or its `panel` to itself. */
export const Funnel = /* @__PURE__ */ markComponent(
  "Funnel",
  ({ data, ...options }: WithData<FunnelOptions<Schema>, Schema>) => funnel(data, options),
  ["labels"],
) as unknown as <S extends Schema>(props: WithData<FunnelOptions<S>, S>) => null;

/** A radar: `category` and `value`, or a list of `fields`, a spoke each; it has its chart, each facet panel, or its `panel` to itself. */
export const Radar = /* @__PURE__ */ markComponent(
  "Radar",
  ({ data, ...options }: WithData<RadarOptions<Schema>, Schema>) => radar(data, options),
  ["points"],
) as unknown as <S extends Schema>(props: WithData<RadarOptions<S>, S>) => null;

/** A Sankey diagram of flows from `source` to `target` nodes; it has its chart, each facet panel, or its `panel` to itself. */
export const Sankey = /* @__PURE__ */ markComponent(
  "Sankey",
  ({ data, ...options }: WithData<SankeyOptions<Schema>, Schema>) => sankey(data, options),
  ["labels"],
) as unknown as <S extends Schema>(props: WithData<SankeyOptions<S>, S>) => null;

/**
 * A network of `source` and `target` nodes, placed by a force simulation,
 * with `nodes` for groups and sizes; it has its chart to itself.
 */
export const Graph = /* @__PURE__ */ markComponent(
  "Graph",
  ({ data, ...options }: WithData<GraphOptions<Schema, Schema>, Schema>) => graph(data, options),
  ["labels", "directed"],
) as unknown as <S extends Schema, N extends Schema = Schema>(
  props: WithData<GraphOptions<S, N>, S>,
) => null;

/**
 * Regions of a map from a table's geometry field, filled by `color`; maps'
 * marks share a chart and its `projection`.
 */
export const GeoShape = /* @__PURE__ */ markComponent(
  "GeoShape",
  ({ data, ...options }: WithData<GeoShapeOptions<Schema>, Schema>) => geoshape(data, options),
) as unknown as <S extends Schema>(props: WithData<GeoShapeOptions<S>, S>) => null;

/** Points of a map at `longitude` and `latitude`, sized and colored as points are. */
export const GeoPoint = /* @__PURE__ */ markComponent(
  "GeoPoint",
  ({ data, ...options }: WithData<GeoPointOptions<Schema>, Schema>) => geopoint(data, options),
) as unknown as <S extends Schema>(props: WithData<GeoPointOptions<S>, S>) => null;

/**
 * Points in a 3D chart at the number or time fields `x`, `y`, and `z`; 3D
 * marks share a chart or subplot, its box, and its `camera`.
 */
export const Point3D = /* @__PURE__ */ markComponent(
  "Point3D",
  ({ data, ...options }: WithData<Point3DOptions<Schema>, Schema>) => point3d(data, options),
) as unknown as <S extends Schema>(props: WithData<Point3DOptions<S>, S>) => null;

/**
 * Lines in a 3D chart through the number or time fields `x`, `y`, and `z`:
 * each series' rows, in table order, are one path.
 */
export const Line3D = /* @__PURE__ */ markComponent(
  "Line3D",
  ({ data, ...options }: WithData<Line3DOptions<Schema>, Schema>) => line3d(data, options),
) as unknown as <S extends Schema>(props: WithData<Line3DOptions<S>, S>) => null;

/** A surface in a 3D chart over a grid of rows: `x` and `y` pick a grid point, `z` is its height. */
export const Surface = /* @__PURE__ */ markComponent(
  "Surface",
  ({ data, ...options }: WithData<SurfaceOptions<Schema>, Schema>) => surface(data, options),
  ["shading", "wireframe"],
) as unknown as <S extends Schema>(props: WithData<SurfaceOptions<S>, S>) => null;

/** Open-high-low-close candles: `x`, `open`, `high`, `low`, `close`. */
export const Candlestick = /* @__PURE__ */ markComponent(
  "Candlestick",
  ({ data, ...options }: WithData<CandlestickOptions<Schema>, Schema>) =>
    candlestick(data, options),
) as unknown as <S extends Schema>(props: WithData<CandlestickOptions<S>, S>) => null;

/** Counts of a number or time field, `x` or `y`, in shared bins; of both, a 2D histogram's cells. */
export const Histogram = /* @__PURE__ */ markComponent(
  "Histogram",
  ({ data, ...options }: WithData<HistogramOptions<Schema>, Schema>) => histogram(data, options),
  ["stack", "commonNorm", "cumulative", "dodge"],
) as unknown as <S extends Schema>(props: WithData<HistogramOptions<S>, S>) => null;

/** Linkage trees whose leaves stand on category bands. */
export const Dendrogram = /* @__PURE__ */ markComponent(
  "Dendrogram",
  ({ data, ...options }: WithData<DendrogramOptions<Schema>, Schema>) => dendrogram(data, options),
) as unknown as <S extends Schema>(props: WithData<DendrogramOptions<S>, S>) => null;

/** Contours of a field sampled on a grid: lines at thresholds, or bands between them. */
export const Contour = /* @__PURE__ */ markComponent(
  "Contour",
  ({ data, ...options }: WithData<ContourOptions<Schema>, Schema>) => contour(data, options),
) as unknown as <S extends Schema>(props: WithData<ContourOptions<S>, S>) => null;

/** A grid of colored cells. */
export const Heatmap = /* @__PURE__ */ markComponent(
  "Heatmap",
  ({ data, ...options }: WithData<HeatmapOptions<Schema>, Schema>) => heatmap(data, options),
) as unknown as <S extends Schema>(props: WithData<HeatmapOptions<S>, S>) => null;

/** Horizontal (`y`) or vertical (`x`) reference lines, constant or one per row of `data`. */
export const Rule = /* @__PURE__ */ markComponent(
  "Rule",
  ({ data, ...options }: RuleOptions & { data?: Table<Schema> }) =>
    data ? rule(data, options as RuleDataOptions<Schema>) : rule(options),
  ["contributeDomain"],
) as unknown as <T = undefined>(props: RuleProps<T>) => null;

/** Shaded x or y ranges, constant or one per row of `data`. */
export const Region = /* @__PURE__ */ markComponent(
  "Region",
  ({ data, ...options }: RegionOptions & { data?: Table<Schema> }) =>
    data ? region(data, options as RegionDataOptions<Schema>) : region(options),
  ["contributeDomain"],
) as unknown as <T = undefined>(props: RegionProps<T>) => null;

/** Text labels, constant or one per row of `data`. */
export const Text = /* @__PURE__ */ markComponent(
  "Text",
  ({ data, ...options }: TextOptions & { data?: Table<Schema> }) =>
    data ? text(data, options as TextDataOptions<Schema>) : text(options),
  ["contributeDomain"],
) as unknown as <T = undefined>(props: TextProps<T>) => null;

/**
 * A custom mark: `draw` places shapes with the chart's scales, without
 * `data` or over the fields of `data`. Rebuilt on every render of the
 * chart, since `draw` may close over props or state.
 */
export const Custom = /* @__PURE__ */ markComponent(
  "Custom",
  ({ data, ...options }: CustomOptions & { data?: Table<Schema> }) =>
    data ? custom(data, options as CustomDataOptions<Schema>) : custom(options),
) as unknown as <T = undefined>(props: CustomProps<T>) => null;
