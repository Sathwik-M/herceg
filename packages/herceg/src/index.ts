// Public API of the herceg package.

export type {
  CategoryInput,
  ColumnInput,
  FieldKind,
  NumericArray,
  TimeInput,
} from "./data/column.ts";
export { category, encodedCategory, time } from "./data/column.ts";
export {
  count,
  Derivation,
  derive,
  distinct,
  first,
  last,
  max,
  mean,
  median,
  min,
  q1,
  q3,
  stdev,
  sum,
  variance,
} from "./data/derive.ts";
export { col, Expr, type Operand, when } from "./data/expression.ts";
export {
  type Feature,
  type FeatureCollection,
  fromGeoJSON,
  type GeoJsonGeometry,
  type GeoJsonOptions,
} from "./data/geojson.ts";
export {
  type GeometryInput,
  type GeometrySet,
  geometry,
  geometryBytes,
} from "./data/geometry.ts";
export {
  type GroupAggregate,
  type GroupKey,
  type GroupOp,
  type GroupOptions,
  type GroupSchema,
  groupRows,
  type NamedAggregate,
  RowGroups,
} from "./data/groups.ts";
export type { SortKey } from "./data/order.ts";
export { RowSet } from "./data/row-set.ts";
export { type RowQuery, type RowSnapshot, RowView, rowView } from "./data/row-view.ts";
export {
  type ConditionSelection,
  type DataSelection,
  type RowsSelection,
  SelectionStore,
  selectionStore,
  selectRows,
  selectWhere,
} from "./data/selection.ts";
export type {
  Batch,
  CategoryField,
  FieldName,
  GeometryField,
  NumberField,
  NumericField,
  PositionField,
  Row,
  Schema,
  SchemaOf,
  TableChange,
  TableOptions,
} from "./data/table.ts";
export { fromRows, Table, table } from "./data/table.ts";
export type { Selection } from "./dom/brushed.ts";
export { type ChartOptions, type ChartUpdate, createChart } from "./dom/chart.ts";
export type { ChartEvents, ChartListener, PanelTarget } from "./dom/events.ts";
export type {
  Axis,
  AxisInfo,
  AxisTarget,
  Chart,
  InspectOptions,
  ItemPositions,
  LegendEntry,
  PanelInfo,
} from "./dom/handle.ts";
export type { RenderTooltip } from "./dom/tooltip.ts";
export type { SymbolName } from "./draw/symbols.ts";
export type { MeasureText } from "./layout/text.ts";
export type { TextField } from "./marks/annotation.ts";
export { type AreaOptions, area } from "./marks/area.ts";
export {
  type BarOptions,
  bar,
  type HorizontalBarOptions,
  type VerticalBarOptions,
} from "./marks/bar.ts";
export { type BoxenOptions, boxen } from "./marks/boxen.ts";
export { type BoxPlotOptions, boxplot } from "./marks/boxplot.ts";
export {
  type CandlestickOptions,
  candlestick,
} from "./marks/candlestick.ts";
export {
  type CustomDataOptions,
  type CustomOptions,
  type CustomSeries,
  type CustomSpec,
  custom,
  type DataDrawContext,
  type DrawContext,
  type ShapeStyle,
  type TextShapeStyle,
} from "./marks/custom.ts";
export { type DendrogramOptions, dendrogram } from "./marks/dendrogram.ts";
export {
  type ErrorBarOptions,
  errorBar,
  type HorizontalErrorBarOptions,
  type HorizontalSymmetricErrorBarOptions,
  type VerticalErrorBarOptions,
  type VerticalSymmetricErrorBarOptions,
} from "./marks/errorbar.ts";
export { type FunnelOptions, funnel } from "./marks/funnel.ts";
export { type GaugeOptions, gauge } from "./marks/gauge.ts";
export { type GeoPointOptions, geopoint } from "./marks/geopoint.ts";
export { type GeoShapeOptions, geoshape } from "./marks/geoshape.ts";
export { type GraphOptions, graph } from "./marks/graph.ts";
export { type HeatmapOptions, heatmap } from "./marks/heatmap.ts";
export { type HistogramOptions, histogram } from "./marks/histogram.ts";
export { tablesOf, viewOf } from "./marks/layout-mark.ts";
export { type LineOptions, line } from "./marks/line.ts";
export { type Line3DOptions, line3d } from "./marks/line3d.ts";
export type { AxisFormat, ChartMark, MarkIdentity } from "./marks/mark.ts";
export { type PieOptions, pie } from "./marks/pie.ts";
export { type PointOptions, point } from "./marks/point.ts";
export { type Point3DOptions, point3d } from "./marks/point3d.ts";
export { type RadarOptions, radar } from "./marks/radar.ts";
export {
  type RegionDataOptions,
  type RegionOptions,
  region,
} from "./marks/region.ts";
export { type RugOptions, rug } from "./marks/rug.ts";
export { type RuleDataOptions, type RuleOptions, rule } from "./marks/rule.ts";
export { type SankeyOptions, sankey } from "./marks/sankey.ts";
export { type SunburstOptions, sunburst } from "./marks/sunburst.ts";
export { type SurfaceOptions, surface } from "./marks/surface.ts";
export { type TextDataOptions, type TextOptions, text } from "./marks/text.ts";
export type { InspectedField, MarkTooltip } from "./marks/tooltip-fields.ts";
export type { DrillRoot, DrillStep } from "./marks/tree-data.ts";
export { type TreemapOptions, treemap } from "./marks/treemap.ts";
export { type ViolinOptions, violin } from "./marks/violin.ts";
export { type Facet, type FacetOptions, facet } from "./model/facet.ts";
export type {
  AxisInspection,
  ChartConfig,
  InspectedPoint,
  Inspection,
  ItemInspection,
  TooltipMode,
  Viewport,
  XAxisConfig,
} from "./model/model.ts";
export { type Navigator, rangeNavigator } from "./model/navigator.ts";
export { type Panels, panels } from "./model/panels.ts";
export {
  type RowSelection,
  type RowSelectionChange,
  rowSelection,
  type SelectionBinding,
} from "./model/row-selection.ts";
export { renderToSVG, type StaticOptions } from "./render/static.ts";
export { type TimeBreaks, timeBreaks } from "./scale/breaks.ts";
export * from "./scale/schemes.ts";
export type { PlotRect } from "./scene/scene.ts";
export type * from "./spec/spec.ts";
export { SPEC_VERSION } from "./spec/spec.ts";
export type { Theme } from "./theme.ts";
export type { Camera } from "./three/camera.ts";
