// Public API of the herceg package.

export type {
  CategoryInput,
  ColumnInput,
  FieldKind,
  NumericArray,
  TimeInput,
} from "./data/column.ts";
export { category, encodedCategory, time } from "./data/column.ts";
export type {
  Batch,
  CategoryField,
  FieldName,
  NumericField,
  Row,
  Schema,
  SchemaOf,
  TableChange,
  TableOptions,
} from "./data/table.ts";
export { fromRows, Table, table } from "./data/table.ts";
export { type Chart, type ChartOptions, createChart } from "./dom/chart.ts";
export type { ChartEvents, ChartListener } from "./dom/events.ts";
export type { SymbolName } from "./draw/symbols.ts";
export type { MeasureText } from "./layout/text.ts";
export type { TextField } from "./marks/annotation.ts";
export { type AreaMark, type AreaOptions, area } from "./marks/area.ts";
export { type BarMark, type BarOptions, bar } from "./marks/bar.ts";
export {
  type CandlestickMark,
  type CandlestickOptions,
  candlestick,
} from "./marks/candlestick.ts";
export {
  type CustomDataOptions,
  type CustomMark,
  type CustomOptions,
  type CustomSpec,
  custom,
  type DataDrawContext,
  type DrawContext,
  type ShapeStyle,
  type TextShapeStyle,
} from "./marks/custom.ts";
export {
  type ErrorBarMark,
  type ErrorBarOptions,
  errorBar,
  type HorizontalErrorBarOptions,
  type VerticalErrorBarOptions,
} from "./marks/errorbar.ts";
export { type HeatmapMark, type HeatmapOptions, heatmap } from "./marks/heatmap.ts";
export { type HistogramMark, type HistogramOptions, histogram } from "./marks/histogram.ts";
export { type LineMark, type LineOptions, line } from "./marks/line.ts";
export type { Mark, MarkIdentity } from "./marks/mark.ts";
export { type PointMark, type PointOptions, point } from "./marks/point.ts";
export {
  type RegionDataOptions,
  type RegionMark,
  type RegionOptions,
  region,
} from "./marks/region.ts";
export { type RuleDataOptions, type RuleMark, type RuleOptions, rule } from "./marks/rule.ts";
export { type TextDataOptions, type TextMark, type TextOptions, text } from "./marks/text.ts";
export { type Facet, type FacetOptions, facet } from "./model/facet.ts";
export type { ChartConfig, InspectedPoint, Inspection } from "./model/model.ts";
export { renderToSVG, type StaticOptions } from "./render/static.ts";
export * from "./scale/schemes.ts";
export type * from "./spec/spec.ts";
export type { Theme } from "./theme.ts";
