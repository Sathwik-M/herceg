// Public API of the herceg package.

export type {
  CategoryInput,
  ColumnInput,
  FieldKind,
  NumericArray,
  TimeInput,
} from "./data/column.ts";
export { category, time } from "./data/column.ts";
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
export type { MeasureText } from "./layout/text.ts";
export { type AreaMark, type AreaOptions, area } from "./marks/area.ts";
export { type BarMark, type BarOptions, bar } from "./marks/bar.ts";
export { type HeatmapMark, type HeatmapOptions, heatmap } from "./marks/heatmap.ts";
export { type LineMark, type LineOptions, line } from "./marks/line.ts";
export type { Mark } from "./marks/mark.ts";
export { type PointMark, type PointOptions, point } from "./marks/point.ts";
export { type RuleMark, type RuleOptions, rule } from "./marks/rule.ts";
export type { ChartConfig, InspectedPoint, Inspection } from "./model/model.ts";
export { renderToSVG, type StaticOptions } from "./render/static.ts";
export type * from "./spec/spec.ts";
export type { Theme } from "./theme.ts";
